-- ============================================================
-- Couch Coach Fantasy — Phase 2, Milestone 4d: transactions log
-- Run in Supabase SQL Editor after the earlier phase files.
-- (Re-creates respond_trade + drop_player to log activity.)
-- ============================================================

create table if not exists public.transactions (
  id         bigint generated always as identity primary key,
  league_id  uuid references public.leagues on delete cascade,
  kind       text not null,          -- 'trade' | 'drop' | 'add'
  detail     text not null,
  actor      uuid references auth.users,
  created_at timestamptz default now()
);
alter table public.transactions enable row level security;
drop policy if exists "read transactions" on public.transactions;
create policy "read transactions" on public.transactions for select to authenticated
  using (public.is_member(league_id));
-- writes happen only via the security-definer functions below

-- Drop + log
create or replace function public.drop_player(lid uuid, pid text)
returns void language plpgsql security definer set search_path = public as $$
declare pname text; tname text;
begin
  select player_name into pname from public.draft_picks where league_id=lid and player_id=pid and user_id=auth.uid();
  select team_name  into tname from public.league_members where league_id=lid and user_id=auth.uid();
  delete from public.draft_picks where league_id=lid and player_id=pid and user_id=auth.uid();
  if pname is not null then
    insert into public.transactions(league_id, kind, detail, actor)
      values (lid, 'drop', coalesce(tname,'A team')||' dropped '||pname, auth.uid());
  end if;
end; $$;

-- Respond to a trade + log on accept
create or replace function public.respond_trade(tid bigint, accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades; offer_names text; request_names text; from_team text; to_team text;
begin
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if t.to_user <> auth.uid() then raise exception 'Only the recipient can respond'; end if;
  if t.status <> 'pending' then raise exception 'Trade is no longer pending'; end if;
  if not accept then update public.trades set status='rejected' where id=tid; return; end if;

  if exists (select 1 from jsonb_array_elements_text(t.offer) x
             where not exists (select 1 from public.draft_picks where league_id=t.league_id and player_id=x and user_id=t.from_user))
    then raise exception 'Offer is no longer valid'; end if;
  if exists (select 1 from jsonb_array_elements_text(t.request) x
             where not exists (select 1 from public.draft_picks where league_id=t.league_id and player_id=x and user_id=t.to_user))
    then raise exception 'Request is no longer valid'; end if;

  -- capture names BEFORE swapping ownership
  select string_agg(player_name, ', ') into offer_names   from public.draft_picks where league_id=t.league_id and user_id=t.from_user and player_id in (select jsonb_array_elements_text(t.offer));
  select string_agg(player_name, ', ') into request_names from public.draft_picks where league_id=t.league_id and user_id=t.to_user   and player_id in (select jsonb_array_elements_text(t.request));
  select team_name into from_team from public.league_members where league_id=t.league_id and user_id=t.from_user;
  select team_name into to_team   from public.league_members where league_id=t.league_id and user_id=t.to_user;

  update public.draft_picks set user_id=t.to_user
    where league_id=t.league_id and user_id=t.from_user and player_id in (select jsonb_array_elements_text(t.offer));
  update public.draft_picks set user_id=t.from_user
    where league_id=t.league_id and user_id=t.to_user and player_id in (select jsonb_array_elements_text(t.request));
  update public.trades set status='accepted' where id=tid;

  insert into public.transactions(league_id, kind, detail, actor)
    values (t.league_id, 'trade',
      coalesce(from_team,'A')||' traded '||coalesce(offer_names,'?')||' → '||coalesce(to_team,'B')||' for '||coalesce(request_names,'?'),
      auth.uid());
end; $$;

alter publication supabase_realtime add table public.transactions;
