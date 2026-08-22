-- ============================================================
-- Couch Coach Fantasy — Phase 2 backend schema (Supabase / Postgres)
-- Milestone 1: accounts + leagues + membership
-- Paste this whole file into the Supabase SQL Editor and click "Run".
-- ============================================================

-- ---------- PROFILES (one row per user) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles readable by authenticated" on public.profiles;
create policy "profiles readable by authenticated"
  on public.profiles for select to authenticated using (true);

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile"
  on public.profiles for insert to authenticated with check (auth.uid() = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update to authenticated using (auth.uid() = id);

-- Auto-create a profile row whenever someone signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- LEAGUES ----------
create table if not exists public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text unique not null,
  commissioner_id uuid references auth.users not null,
  settings jsonb default '{}'::jsonb,   -- scoring rules, playoff format, etc.
  created_at timestamptz default now()
);
alter table public.leagues enable row level security;

-- ---------- LEAGUE MEMBERS (one row per user per league = their team) ----------
create table if not exists public.league_members (
  league_id uuid references public.leagues on delete cascade,
  user_id   uuid references auth.users on delete cascade,
  team_name text,
  role      text default 'member',       -- 'commissioner' | 'member'
  joined_at timestamptz default now(),
  primary key (league_id, user_id)
);
alter table public.league_members enable row level security;

-- Security-definer helper: "am I in this league?" (bypasses RLS to avoid recursion)
create or replace function public.is_member(l uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.league_members
    where league_id = l and user_id = auth.uid()
  );
$$;

-- leagues policies
drop policy if exists "read leagues you belong to" on public.leagues;
create policy "read leagues you belong to"
  on public.leagues for select to authenticated
  using (public.is_member(id) or commissioner_id = auth.uid());

drop policy if exists "commissioner updates league" on public.leagues;
create policy "commissioner updates league"
  on public.leagues for update to authenticated
  using (commissioner_id = auth.uid());

-- league_members policies
drop policy if exists "read members of your leagues" on public.league_members;
create policy "read members of your leagues"
  on public.league_members for select to authenticated
  using (public.is_member(league_id));

drop policy if exists "update own membership" on public.league_members;
create policy "update own membership"
  on public.league_members for update to authenticated
  using (user_id = auth.uid());

-- ---------- RPCs: create + join a league (atomic, generate join code) ----------
create or replace function public.create_league(league_name text, team text)
returns uuid language plpgsql security definer set search_path = public as $$
declare lid uuid; code text;
begin
  code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  insert into public.leagues (name, join_code, commissioner_id)
    values (league_name, code, auth.uid()) returning id into lid;
  insert into public.league_members (league_id, user_id, team_name, role)
    values (lid, auth.uid(), team, 'commissioner');
  return lid;
end; $$;

create or replace function public.join_league(code text, team text)
returns uuid language plpgsql security definer set search_path = public as $$
declare lid uuid;
begin
  select id into lid from public.leagues where join_code = upper(code);
  if lid is null then raise exception 'League not found for code %', code; end if;
  insert into public.league_members (league_id, user_id, team_name)
    values (lid, auth.uid(), team)
    on conflict (league_id, user_id) do update set team_name = excluded.team_name;
  return lid;
end; $$;

-- (Milestone 2+ will add: teams/roster_players, draft_picks, matchups,
--  powerup_assignments, weekly_scores. Added once auth + leagues work.)
