-- ============================================================
-- Couch Coach Fantasy — Phase 5: add/drop + waivers.
-- Run in Supabase SQL Editor after phase4f-supabase-scoring.sql.
--
-- Model: once a player is dropped, they're locked on waivers (must be
-- claimed, can't be instantly added) until the next processing run —
-- NOT a fixed per-player timer. Processing runs weekly (piggybacked on
-- the same background job that auto-advances the week, see
-- scripts/poll-scores.js). A player who has never been dropped, or who
-- cleared a past processing run unclaimed, is a true free agent and can
-- be added instantly by anyone, first-come-first-served — exactly like
-- ESPN outside its weekly waiver window.
-- ============================================================

alter table public.leagues add column if not exists last_waiver_process timestamptz not null default now();
-- Rolling-priority order (array of user_id text), persisted across weeks —
-- only used when settings.league.waiver = 'Rolling priority'. Reverse
-- Standings recomputes fresh from standings_cache every run instead.
alter table public.leagues add column if not exists waiver_priority jsonb not null default '[]'::jsonb;
-- Best-effort standings snapshot pushed by any member's browser whenever it
-- computes real standings (see sync_standings_cache below). The background
-- job has no access to the full power-up-adjusted scoring engine (that
-- logic lives client-side in index.html), so it reads this cache instead
-- of recomputing standings itself. Fine for a casual league — it's kept
-- fresh by ordinary app usage, not stale by design.
alter table public.leagues add column if not exists standings_cache jsonb not null default '[]'::jsonb;

create or replace function public.sync_standings_cache(lid uuid, standings jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  update public.leagues set standings_cache = standings where id = lid;
end; $$;

-- Log of drops — the "is this player currently on waivers" check is
-- dropped_at > leagues.last_waiver_process, so clearing waivers each week
-- is automatic (just advancing last_waiver_process) rather than needing to
-- delete/expire rows.
create table if not exists public.waiver_wire (
  league_id   uuid references public.leagues on delete cascade,
  player_id   text not null,
  player_name text,
  pos         text,
  team        text,
  headshot    text,
  dropped_at  timestamptz not null default now(),
  primary key (league_id, player_id)
);
alter table public.waiver_wire enable row level security;
drop policy if exists "read waiver wire" on public.waiver_wire;
create policy "read waiver wire" on public.waiver_wire for select to authenticated
  using (public.is_member(league_id));
-- writes only via drop_player / service-role processing below

create table if not exists public.waiver_claims (
  id              bigint generated always as identity primary key,
  league_id       uuid references public.leagues on delete cascade,
  user_id         uuid references auth.users not null,
  add_player_id   text not null,
  add_player_name text,
  add_pos         text,
  add_team        text,
  add_headshot    text,
  drop_player_id  text,               -- null = only submit if there's an open roster spot
  drop_player_name text,
  priority        int not null default 1,   -- this manager's own ranking among their pending claims
  status          text not null default 'pending' check (status in ('pending','successful','failed','cancelled')),
  fail_reason     text,
  created_at      timestamptz default now(),
  processed_at    timestamptz
);
alter table public.waiver_claims enable row level security;
drop policy if exists "read own waiver claims" on public.waiver_claims;
create policy "read own waiver claims" on public.waiver_claims for select to authenticated
  using (user_id = auth.uid());
-- writes only via the RPCs below (all security definer)

-- Add/drop/waivers only make sense once rosters exist. Enforced here (not
-- just client-side) since anyone with the anon key could otherwise call
-- these RPCs directly mid-draft and corrupt the snake-order turn sequence
-- (make_pick derives whose turn it is from a raw draft_picks row COUNT).
create or replace function public.assert_draft_done(lid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.drafts where league_id = lid and status = 'done') then
    raise exception 'Add/drop opens once the draft is complete';
  end if;
end; $$;

create or replace function public.submit_waiver_claim(
  lid uuid, add_pid text, add_pname text, add_ppos text, add_pteam text, add_phead text,
  drop_pid text default null, drop_pname text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare nextp int; newid bigint;
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  perform public.assert_draft_done(lid);
  if exists (select 1 from public.draft_picks where league_id = lid and player_id = add_pid) then
    raise exception 'That player is already on a roster';
  end if;
  if exists (select 1 from public.waiver_claims where league_id = lid and user_id = auth.uid()
             and add_player_id = add_pid and status = 'pending') then
    raise exception 'You already have a pending claim on that player';
  end if;
  -- Two of your own pending claims dropping the SAME player would both
  -- "successfully" free that roster slot in your own eyes, but only the
  -- first one processed actually removes them — the second would add a
  -- player without freeing anything, silently blowing past your roster cap.
  if drop_pid is not null and exists (
    select 1 from public.waiver_claims where league_id = lid and user_id = auth.uid()
    and status = 'pending' and drop_player_id = drop_pid
  ) then
    raise exception 'You already have a pending claim that drops that player';
  end if;
  select coalesce(max(priority), 0) + 1 into nextp
    from public.waiver_claims where league_id = lid and user_id = auth.uid() and status = 'pending';
  insert into public.waiver_claims(league_id, user_id, add_player_id, add_player_name, add_pos, add_team,
      add_headshot, drop_player_id, drop_player_name, priority)
    values (lid, auth.uid(), add_pid, add_pname, add_ppos, add_pteam, add_phead, drop_pid, drop_pname, nextp)
    returning id into newid;
  return newid;
end; $$;

create or replace function public.cancel_waiver_claim(cid bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.waiver_claims where id = cid and user_id = auth.uid() and status = 'pending';
end; $$;

-- Client sends its own pending claims, reordered — priority becomes each
-- claim's position in that list (1-based). No-ops on an empty array
-- (array_length of '{}' is NULL, which would otherwise blow up the FOR loop).
create or replace function public.reorder_waiver_claims(lid uuid, ordered_ids bigint[])
returns void language plpgsql security definer set search_path = public as $$
declare i int; cid bigint;
begin
  if ordered_ids is null or array_length(ordered_ids, 1) is null then return; end if;
  for i in 1..array_length(ordered_ids, 1) loop
    cid := ordered_ids[i];
    update public.waiver_claims set priority = i
      where id = cid and league_id = lid and user_id = auth.uid() and status = 'pending';
  end loop;
end; $$;

-- Instant add — only for players NOT currently on waivers. Mirrors
-- make_pick's roster insert but with round=0 (a sentinel meaning "added
-- outside the draft", since draft_picks.round is not-null).
create or replace function public.add_free_agent(
  lid uuid, pid text, pname text, ppos text, pteam text, phead text,
  drop_pid text default null, drop_pname text default null
) returns void language plpgsql security definer set search_path = public as $$
declare cap int; cnt int; nextpick int;
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  perform public.assert_draft_done(lid);
  if exists (select 1 from public.draft_picks where league_id = lid and player_id = pid) then
    raise exception 'That player is already on a roster';
  end if;
  if exists (
    select 1 from public.waiver_wire w join public.leagues l on l.id = w.league_id
    where w.league_id = lid and w.player_id = pid and w.dropped_at > l.last_waiver_process
  ) then
    raise exception 'That player is on waivers — submit a claim instead';
  end if;

  select coalesce((select settings->'league'->>'rosterSize' from public.leagues where id = lid)::int, 16) into cap;
  select count(*) into cnt from public.draft_picks where league_id = lid and user_id = auth.uid();
  if cnt >= cap then
    if drop_pid is null then raise exception 'Your roster is full — pick a player to drop'; end if;
    if not exists (select 1 from public.draft_picks where league_id = lid and player_id = drop_pid and user_id = auth.uid()) then
      raise exception 'That player is not on your roster';
    end if;
    delete from public.draft_picks where league_id = lid and player_id = drop_pid and user_id = auth.uid();
    insert into public.waiver_wire(league_id, player_id, player_name, dropped_at)
      values (lid, drop_pid, drop_pname, now())
      on conflict (league_id, player_id) do update set dropped_at = now(), player_name = excluded.player_name;
  end if;

  select coalesce(max(pick_no), 0) + 1 into nextpick from public.draft_picks where league_id = lid;
  insert into public.draft_picks(league_id, pick_no, round, user_id, player_id, player_name, pos, team, headshot)
    values (lid, nextpick, 0, auth.uid(), pid, pname, ppos, pteam, phead);

  insert into public.transactions(league_id, kind, detail, actor)
    select lid, 'add',
      coalesce((select team_name from public.league_members where league_id = lid and user_id = auth.uid()), 'A team')
      || ' added ' || pname || coalesce(' (dropped ' || drop_pname || ')', ''),
      auth.uid();
end; $$;

-- Replaces phase4d's drop_player: same behavior, plus logging the drop to
-- waiver_wire so the player is locked until the next processing run. Now
-- raises instead of silently no-op'ing when the player isn't actually
-- owned by the caller (stale UI, double-click, already dropped elsewhere)
-- — the client was showing a "Dropped" success toast even when nothing happened.
create or replace function public.drop_player(lid uuid, pid text)
returns void language plpgsql security definer set search_path = public as $$
declare pname text; tname text;
begin
  select player_name into pname from public.draft_picks where league_id=lid and player_id=pid and user_id=auth.uid();
  if pname is null then raise exception 'That player is not on your roster'; end if;
  select team_name  into tname from public.league_members where league_id=lid and user_id=auth.uid();
  delete from public.draft_picks where league_id=lid and player_id=pid and user_id=auth.uid();
  insert into public.waiver_wire(league_id, player_id, player_name, dropped_at)
    values (lid, pid, pname, now())
    on conflict (league_id, player_id) do update set dropped_at = now(), player_name = excluded.player_name;
  insert into public.transactions(league_id, kind, detail, actor)
    values (lid, 'drop', coalesce(tname,'A team')||' dropped '||pname, auth.uid());
end; $$;

-- Atomically attempts ONE waiver claim — the background job (poll-scores.js)
-- calls this once per claim instead of doing the check-then-execute dance
-- itself over multiple REST round-trips. Locking the claim row (FOR UPDATE)
-- makes a concurrent cancel_waiver_claim call block until this transaction
-- finishes rather than racing it, and any failure (including a pick_no
-- collision against a live user's concurrent make_pick/add_free_agent)
-- is caught and turned into a normal 'failed' result instead of leaving
-- the claim stuck 'pending' forever. Internal only — not meant to be
-- called by a client directly, so EXECUTE is revoked from client roles.
create or replace function public.process_one_waiver_claim(cid bigint)
returns table(result_status text, result_reason text)
language plpgsql security definer set search_path = public as $$
declare c public.waiver_claims; cap int; cnt int; already_owned boolean;
begin
  select * into c from public.waiver_claims where id = cid and status = 'pending' for update;
  if not found then
    return query select 'skipped'::text, 'Already resolved or cancelled'::text; return;
  end if;

  if exists (select 1 from public.draft_picks where league_id = c.league_id and player_id = c.add_player_id) then
    update public.waiver_claims set status='failed', fail_reason='Player was claimed by another manager first', processed_at=now() where id = cid;
    return query select 'failed'::text, 'Player was claimed by another manager first'::text; return;
  end if;

  select coalesce((settings->'league'->>'rosterSize')::int, 16) into cap from public.leagues where id = c.league_id;
  select count(*) into cnt from public.draft_picks where league_id = c.league_id and user_id = c.user_id;
  if cnt >= cap and c.drop_player_id is null then
    update public.waiver_claims set status='failed', fail_reason='Roster full and no drop selected', processed_at=now() where id = cid;
    return query select 'failed'::text, 'Roster full and no drop selected'::text; return;
  end if;

  if c.drop_player_id is not null then
    select exists(select 1 from public.draft_picks where league_id=c.league_id and user_id=c.user_id and player_id=c.drop_player_id) into already_owned;
    if not already_owned then
      update public.waiver_claims set status='failed', fail_reason='Drop target is no longer on your roster', processed_at=now() where id = cid;
      return query select 'failed'::text, 'Drop target is no longer on your roster'::text; return;
    end if;
  end if;

  begin
    if c.drop_player_id is not null then
      delete from public.draft_picks where league_id=c.league_id and user_id=c.user_id and player_id=c.drop_player_id;
      insert into public.waiver_wire(league_id, player_id, player_name, dropped_at)
        values (c.league_id, c.drop_player_id, c.drop_player_name, now())
        on conflict (league_id, player_id) do update set dropped_at = now(), player_name = excluded.player_name;
    end if;
    insert into public.draft_picks(league_id, pick_no, round, user_id, player_id, player_name, pos, team, headshot)
      select c.league_id, coalesce(max(pick_no), 0) + 1, 0, c.user_id, c.add_player_id, c.add_player_name, c.add_pos, c.add_team, c.add_headshot
      from public.draft_picks where league_id = c.league_id;
  exception when others then
    update public.waiver_claims set status='failed', fail_reason='Could not complete: '||sqlerrm, processed_at=now() where id = cid;
    return query select 'failed'::text, ('Could not complete: '||sqlerrm)::text; return;
  end;

  update public.waiver_claims set status='successful', processed_at=now() where id = cid;
  insert into public.transactions(league_id, kind, detail, actor)
    values (c.league_id, 'add', 'Won a waiver claim on '||c.add_player_name||coalesce(' (dropped '||c.drop_player_name||')',''), c.user_id);
  return query select 'successful'::text, null::text; return;
end; $$;
revoke execute on function public.process_one_waiver_claim(bigint) from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='waiver_claims') then
    alter publication supabase_realtime add table public.waiver_claims; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='waiver_wire') then
    alter publication supabase_realtime add table public.waiver_wire; end if;
end $$;
