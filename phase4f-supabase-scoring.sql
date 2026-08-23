-- ============================================================
-- Couch Coach Fantasy — Phase 2, Milestone 4c: real, power-up-adjusted
-- weekly scoring. Run in Supabase SQL Editor after phase4e.
-- ============================================================

-- Snapshot of each manager's starters for a week that has closed.
-- Populated automatically by set_week() when the commissioner advances
-- past that week — "whatever you had saved when the week closed" is
-- the official lineup of record.
create table if not exists public.weekly_lineups (
  league_id  uuid references public.leagues on delete cascade,
  week       int not null,
  user_id    uuid references auth.users,
  starters   jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  primary key (league_id, week, user_id)
);
alter table public.weekly_lineups enable row level security;
drop policy if exists "read weekly lineups" on public.weekly_lineups;
create policy "read weekly lineups" on public.weekly_lineups for select to authenticated
  using (public.is_member(league_id));
-- writes only via set_week() (security definer) below

-- Advance/set the current week, snapshotting the week being closed.
create or replace function public.set_week(lid uuid, wk int)
returns void language plpgsql security definer set search_path = public as $$
declare old_wk int;
begin
  if not exists (select 1 from public.leagues where id=lid and commissioner_id=auth.uid()) then
    raise exception 'Only the commissioner can change the week'; end if;
  select current_week into old_wk from public.leagues where id=lid;
  insert into public.weekly_lineups(league_id, week, user_id, starters)
    select lid, old_wk, user_id, starters from public.lineups where league_id=lid
    on conflict (league_id, week, user_id) do update set starters=excluded.starters;
  update public.leagues set current_week = greatest(1, wk) where id=lid;
end; $$;

-- Persisted power-up activations (real leagues only). One row per
-- (league, week, player) — enforced below — so both the "one of each
-- power-up per week" and "one power-up per player per week" rules hold.
create table if not exists public.powerup_picks (
  id            bigint generated always as identity primary key,
  league_id     uuid references public.leagues on delete cascade,
  week          int not null,
  user_id       uuid references auth.users not null,   -- who spent the power-up
  player_id     text not null,                          -- whose quarter is affected (sub: the player coming IN)
  player_name   text not null,
  target_player_id text,                                 -- sub only: the starter benched
  powerup_key   text not null check (powerup_key in ('double','freeze','sub','hotstart')),
  quarter       int not null check (quarter between 1 and 4),
  created_at    timestamptz default now(),
  unique (league_id, week, player_id)
);
alter table public.powerup_picks enable row level security;
drop policy if exists "read powerup picks" on public.powerup_picks;
create policy "read powerup picks" on public.powerup_picks for select to authenticated
  using (public.is_member(league_id));

create or replace function public.log_powerup(lid uuid, wk int, pid text, pname text, key text, q int, target text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  if exists (select 1 from public.powerup_picks where league_id=lid and week=wk and user_id=auth.uid() and powerup_key=key) then
    raise exception 'You already used % this week', key; end if;
  if exists (select 1 from public.powerup_picks where league_id=lid and week=wk and player_id=pid) then
    raise exception '% already has a power-up this week', pname; end if;
  insert into public.powerup_picks(league_id, week, user_id, player_id, player_name, target_player_id, powerup_key, quarter)
    values (lid, wk, auth.uid(), pid, pname, target, key, q);
end; $$;

-- Real, live-polled per-quarter fantasy points for every rostered NFL
-- player, keyed by ESPN athlete id (or "def_<teamId>" for defenses) —
-- shared across leagues since it reflects the actual real-world game.
-- Any signed-in manager's browser can contribute a poll; last writer's
-- observation wins (all clients are polling the same ESPN truth).
create table if not exists public.player_week_stats (
  athlete_id  text not null,
  week        int not null,
  season      int not null default 2026,
  q_pts       jsonb not null default '{}'::jsonb,   -- {"1": {"fp":8.2,"qtd":1}, ...} real FP + qualifying TDs per quarter
  prev_total  numeric not null default 0,           -- last-seen cumulative real FP (for delta calc)
  prev_qtd    numeric not null default 0,           -- last-seen cumulative qualifying-TD count (for delta calc)
  is_final    boolean not null default false,
  updated_at  timestamptz default now(),
  primary key (athlete_id, week, season)
);
alter table public.player_week_stats enable row level security;
drop policy if exists "read player stats" on public.player_week_stats;
create policy "read player stats" on public.player_week_stats for select to authenticated using (true);
drop policy if exists "upsert player stats" on public.player_week_stats;
create policy "upsert player stats" on public.player_week_stats for insert to authenticated with check (true);
drop policy if exists "update player stats" on public.player_week_stats;
create policy "update player stats" on public.player_week_stats for update to authenticated using (true);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='weekly_lineups') then
    alter publication supabase_realtime add table public.weekly_lineups; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='powerup_picks') then
    alter publication supabase_realtime add table public.powerup_picks; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='player_week_stats') then
    alter publication supabase_realtime add table public.player_week_stats; end if;
end $$;
