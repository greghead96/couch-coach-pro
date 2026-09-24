-- Phase 10: ONE power-up per player per week — from ANY manager, ANY quarter.
--
-- Phase 9 relaxed this to one-per-quarter so an opponent's Freeze and your
-- own Double could sit on different quarters of the same player. League
-- decision (Sep 2026): that's not wanted — once a player has any power-up
-- on him for the week (as the target of a Double/Freeze/Hot Start, or as
-- either side of an Emergency Sub), nobody else can put another one on him.
-- Run in the Supabase SQL editor.

drop index if exists public.powerup_picks_quarter_uq;

-- Re-establish the hard guarantee at the storage level (player_id only —
-- the sub-out target is enforced in the function below). Partial from week 3
-- on: weeks 1–2 were played under the per-quarter rule and legitimately hold
-- several picks on one player (e.g. J.Taylor wk2: freeze Q1 + double Q2 +
-- hot start) — those stay as scored.
drop index if exists public.powerup_picks_player_week_uq;
create unique index if not exists powerup_picks_player_week_uq
  on public.powerup_picks(league_id, week, player_id) where week >= 3;

create or replace function public.log_powerup(lid uuid, wk int, pid text, pname text, key text, q int, target text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  if exists (select 1 from public.powerup_picks where league_id=lid and week=wk and user_id=auth.uid() and powerup_key=key) then
    raise exception 'You already used % this week', key; end if;
  -- Any power-up already involving this player this week blocks a new one,
  -- whoever placed it and whichever quarter it was for.
  if exists (
    select 1 from public.powerup_picks
    where league_id=lid and week=wk and (player_id=pid or target_player_id=pid)
  ) then
    raise exception '% already has a power-up this week', pname;
  end if;
  -- Emergency Sub also involves the player coming OUT.
  if target is not null and exists (
    select 1 from public.powerup_picks
    where league_id=lid and week=wk and (player_id=target or target_player_id=target)
  ) then
    raise exception 'The player being subbed out already has a power-up this week';
  end if;
  insert into public.powerup_picks(league_id, week, user_id, player_id, player_name, target_player_id, powerup_key, quarter)
    values (lid, wk, auth.uid(), pid, pname, target, key, q);
end; $$;
