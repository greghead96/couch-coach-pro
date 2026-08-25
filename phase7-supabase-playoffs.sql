-- ============================================================
-- Couch Coach Fantasy — Phase 7: real, auto-advancing playoff bracket
-- (main + consolation). Run in Supabase SQL Editor after phase6.
--
-- Same "client computes with full fidelity, best-effort persists" model
-- already used for waiver-priority standings (see standings_cache /
-- sync_standings_cache in phase5): the power-up-adjusted scoring engine
-- only exists client-side, so there's no server-side job that could
-- reliably determine playoff winners on its own. Any manager's browser
-- that opens the Playoffs tab recomputes the bracket from real per-team
-- scores and syncs the result here — deterministic, so it converges
-- regardless of which browser happens to write it.
-- ============================================================

create table if not exists public.playoff_matchups (
  id          bigint generated always as identity primary key,
  league_id   uuid references public.leagues on delete cascade,
  bracket     text not null check (bracket in ('main','consolation')),
  round       int not null,          -- 0-indexed within that bracket
  slot        int not null,          -- position within the round, 0-indexed
  home_user   uuid references auth.users,
  away_user   uuid references auth.users,
  home_seed   int,                   -- overall-standings rank, informational
  away_seed   int,
  start_week  int not null,
  end_week    int not null,          -- start_week + weeksPerRound - 1
  winner_user uuid references auth.users,
  is_bye      boolean not null default false,
  updated_at  timestamptz default now(),
  unique (league_id, bracket, round, slot)
);
alter table public.playoff_matchups enable row level security;
drop policy if exists "read playoff matchups" on public.playoff_matchups;
create policy "read playoff matchups" on public.playoff_matchups for select to authenticated
  using (public.is_member(league_id));
-- writes only via sync_playoff_bracket() below

create or replace function public.sync_playoff_bracket(lid uuid, matchups jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  insert into public.playoff_matchups(
    league_id, bracket, round, slot, home_user, away_user, home_seed, away_seed,
    start_week, end_week, winner_user, is_bye, updated_at
  )
  select
    lid,
    m->>'bracket',
    (m->>'round')::int,
    (m->>'slot')::int,
    nullif(m->>'home_user','')::uuid,
    nullif(m->>'away_user','')::uuid,
    nullif(m->>'home_seed','')::int,
    nullif(m->>'away_seed','')::int,
    (m->>'start_week')::int,
    (m->>'end_week')::int,
    nullif(m->>'winner_user','')::uuid,
    coalesce((m->>'is_bye')::boolean, false),
    now()
  from jsonb_array_elements(matchups) m
  on conflict (league_id, bracket, round, slot) do update set
    home_user=excluded.home_user, away_user=excluded.away_user,
    home_seed=excluded.home_seed, away_seed=excluded.away_seed,
    start_week=excluded.start_week, end_week=excluded.end_week,
    winner_user=excluded.winner_user, is_bye=excluded.is_bye, updated_at=now();
end; $$;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='playoff_matchups') then
    alter publication supabase_realtime add table public.playoff_matchups; end if;
end $$;
