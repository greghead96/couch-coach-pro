-- ============================================================
-- Couch Coach Fantasy — Phase 2, Milestone 4c: trades
-- Run in Supabase SQL Editor after the earlier phase files.
-- ============================================================

create table if not exists public.trades (
  id         bigint generated always as identity primary key,
  league_id  uuid references public.leagues on delete cascade,
  from_user  uuid references auth.users not null,
  to_user    uuid references auth.users not null,
  offer      jsonb not null default '[]'::jsonb,   -- player_ids the proposer gives
  request    jsonb not null default '[]'::jsonb,   -- player_ids the proposer wants
  status     text  not null default 'pending',     -- pending | accepted | rejected | cancelled
  created_at timestamptz default now()
);
alter table public.trades enable row level security;

drop policy if exists "read my trades" on public.trades;
create policy "read my trades" on public.trades for select to authenticated
  using (public.is_member(league_id) and (from_user = auth.uid() or to_user = auth.uid()));

drop policy if exists "propose trade" on public.trades;
create policy "propose trade" on public.trades for insert to authenticated
  with check (from_user = auth.uid());
-- status changes go through the RPCs below (security definer)

create or replace function public.propose_trade(lid uuid, target uuid, offer jsonb, request jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare tid bigint;
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  if target = auth.uid() then raise exception 'You cannot trade with yourself'; end if;
  if jsonb_array_length(offer)=0 or jsonb_array_length(request)=0 then raise exception 'Pick players on both sides'; end if;
  if exists (select 1 from jsonb_array_elements_text(offer) x
             where not exists (select 1 from public.draft_picks where league_id=lid and player_id=x and user_id=auth.uid()))
    then raise exception 'You do not own all offered players'; end if;
  if exists (select 1 from jsonb_array_elements_text(request) x
             where not exists (select 1 from public.draft_picks where league_id=lid and player_id=x and user_id=target))
    then raise exception 'They do not own all requested players'; end if;
  insert into public.trades (league_id, from_user, to_user, offer, request)
    values (lid, auth.uid(), target, offer, request) returning id into tid;
  return tid;
end; $$;

create or replace function public.respond_trade(tid bigint, accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades;
begin
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if t.to_user <> auth.uid() then raise exception 'Only the recipient can respond'; end if;
  if t.status <> 'pending' then raise exception 'Trade is no longer pending'; end if;
  if not accept then update public.trades set status='rejected' where id=tid; return; end if;
  -- re-validate ownership right before swapping
  if exists (select 1 from jsonb_array_elements_text(t.offer) x
             where not exists (select 1 from public.draft_picks where league_id=t.league_id and player_id=x and user_id=t.from_user))
    then raise exception 'Offer is no longer valid'; end if;
  if exists (select 1 from jsonb_array_elements_text(t.request) x
             where not exists (select 1 from public.draft_picks where league_id=t.league_id and player_id=x and user_id=t.to_user))
    then raise exception 'Request is no longer valid'; end if;
  update public.draft_picks set user_id=t.to_user
    where league_id=t.league_id and user_id=t.from_user and player_id in (select jsonb_array_elements_text(t.offer));
  update public.draft_picks set user_id=t.from_user
    where league_id=t.league_id and user_id=t.to_user and player_id in (select jsonb_array_elements_text(t.request));
  update public.trades set status='accepted' where id=tid;
end; $$;

create or replace function public.cancel_trade(tid bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.trades set status='cancelled'
   where id=tid and from_user=auth.uid() and status='pending';
end; $$;

alter publication supabase_realtime add table public.trades;
