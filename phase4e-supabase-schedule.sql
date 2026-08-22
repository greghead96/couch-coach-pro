-- ============================================================
-- Couch Coach Fantasy — Phase 2, Milestone 4b: schedule + current week
-- Run in Supabase SQL Editor after the earlier phase files.
-- ============================================================

alter table public.leagues add column if not exists current_week int default 1;

create table if not exists public.schedule (
  id         bigint generated always as identity primary key,
  league_id  uuid references public.leagues on delete cascade,
  week       int not null,
  home_user  uuid references auth.users,
  away_user  uuid references auth.users
);
alter table public.schedule enable row level security;
drop policy if exists "read schedule" on public.schedule;
create policy "read schedule" on public.schedule for select to authenticated
  using (public.is_member(league_id));

-- Commissioner sets the whole schedule (computed on the client, round-robin)
create or replace function public.set_schedule(lid uuid, games jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.leagues where id=lid and commissioner_id=auth.uid()) then
    raise exception 'Only the commissioner can set the schedule'; end if;
  delete from public.schedule where league_id=lid;
  insert into public.schedule(league_id, week, home_user, away_user)
    select lid, (g->>'week')::int, nullif(g->>'home','')::uuid, nullif(g->>'away','')::uuid
      from jsonb_array_elements(games) g;
end; $$;

-- Commissioner advances / sets the current week
create or replace function public.set_week(lid uuid, wk int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.leagues where id=lid and commissioner_id=auth.uid()) then
    raise exception 'Only the commissioner can change the week'; end if;
  update public.leagues set current_week = greatest(1, wk) where id=lid;
end; $$;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='schedule') then
    alter publication supabase_realtime add table public.schedule;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='leagues') then
    alter publication supabase_realtime add table public.leagues;
  end if;
end $$;
