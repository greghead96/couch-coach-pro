-- ============================================================
-- Couch Coach Fantasy — Phase 2, Milestone 3: real multi-user draft
-- Run this in the Supabase SQL Editor AFTER phase2-supabase-schema.sql.
-- ============================================================

-- One draft per league
create table if not exists public.drafts (
  league_id    uuid primary key references public.leagues on delete cascade,
  status       text not null default 'pre',           -- 'pre' | 'live' | 'done'
  rounds       int  not null default 15,
  member_order jsonb not null default '[]'::jsonb,     -- array of user_ids in draft-slot order
  started_at   timestamptz,
  updated_at   timestamptz default now()
);
alter table public.drafts enable row level security;

-- Every pick that's been made
create table if not exists public.draft_picks (
  id          bigint generated always as identity primary key,
  league_id   uuid references public.leagues on delete cascade,
  pick_no     int  not null,
  round       int  not null,
  user_id     uuid references auth.users not null,
  player_id   text not null,
  player_name text,
  pos         text,
  team        text,
  headshot    text,
  created_at  timestamptz default now(),
  unique (league_id, pick_no),
  unique (league_id, player_id)
);
alter table public.draft_picks enable row level security;

-- Read policies: any league member can see the draft + picks
drop policy if exists "read draft" on public.drafts;
create policy "read draft" on public.drafts for select to authenticated using (public.is_member(league_id));

drop policy if exists "read picks" on public.draft_picks;
create policy "read picks" on public.draft_picks for select to authenticated using (public.is_member(league_id));

-- Commissioner starts (or restarts) the draft; sets snake order by join time
create or replace function public.start_draft(lid uuid, n_rounds int default 15)
returns void language plpgsql security definer set search_path = public as $$
declare ord jsonb;
begin
  if not exists (select 1 from public.leagues where id = lid and commissioner_id = auth.uid()) then
    raise exception 'Only the commissioner can start the draft';
  end if;
  select coalesce(jsonb_agg(user_id order by joined_at), '[]'::jsonb) into ord
    from public.league_members where league_id = lid;
  delete from public.draft_picks where league_id = lid;
  insert into public.drafts (league_id, status, rounds, member_order, started_at)
    values (lid, 'live', n_rounds, ord, now())
  on conflict (league_id) do update
    set status='live', rounds=n_rounds, member_order=ord, started_at=now(), updated_at=now();
end; $$;

-- Make a pick: validates it's your turn (snake order) and the player is available
create or replace function public.make_pick(lid uuid, pid text, pname text, ppos text, pteam text, phead text)
returns int language plpgsql security definer set search_path = public as $$
declare d public.drafts; n int; cnt int; pno int; rnd int; slot int; onclock uuid;
begin
  select * into d from public.drafts where league_id = lid;
  if not found then raise exception 'No draft found'; end if;
  if d.status <> 'live' then raise exception 'Draft is not live'; end if;
  n := jsonb_array_length(d.member_order);
  if n = 0 then raise exception 'No members in draft'; end if;

  select count(*) into cnt from public.draft_picks where league_id = lid;
  pno := cnt + 1;
  if pno > n * d.rounds then raise exception 'Draft is complete'; end if;

  rnd := (pno - 1) / n;                                  -- 0-based round
  if (rnd % 2) = 0 then slot := (pno - 1) % n;           -- snake
  else slot := n - 1 - ((pno - 1) % n); end if;
  onclock := (d.member_order ->> slot)::uuid;
  if onclock <> auth.uid() then raise exception 'Not your pick'; end if;

  if exists (select 1 from public.draft_picks where league_id = lid and player_id = pid) then
    raise exception 'Player already drafted';
  end if;

  insert into public.draft_picks (league_id, pick_no, round, user_id, player_id, player_name, pos, team, headshot)
    values (lid, pno, rnd + 1, auth.uid(), pid, pname, ppos, pteam, phead);

  if pno = n * d.rounds then
    update public.drafts set status='done', updated_at=now() where league_id = lid;
  end if;
  return pno;
end; $$;

-- Enable realtime so the board updates live for everyone
alter publication supabase_realtime add table public.drafts;
alter publication supabase_realtime add table public.draft_picks;
