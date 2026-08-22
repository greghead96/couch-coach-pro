-- ============================================================
-- Couch Coach Fantasy — Phase 2, Milestone 4a: saved lineups
-- Run in Supabase SQL Editor after the earlier phase files.
-- ============================================================

create table if not exists public.lineups (
  league_id  uuid references public.leagues on delete cascade,
  user_id    uuid references auth.users on delete cascade,
  starters   jsonb not null default '[]'::jsonb,   -- player_ids aligned to the slot template
  updated_at timestamptz default now(),
  primary key (league_id, user_id)
);
alter table public.lineups enable row level security;

drop policy if exists "read lineups" on public.lineups;
create policy "read lineups" on public.lineups for select to authenticated
  using (public.is_member(league_id));

drop policy if exists "insert own lineup" on public.lineups;
create policy "insert own lineup" on public.lineups for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "update own lineup" on public.lineups;
create policy "update own lineup" on public.lineups for update to authenticated
  using (user_id = auth.uid());
