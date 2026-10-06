-- Phase 11: power-ups may STACK on one player in a week, but never in the same quarter.
--
-- League decision (Oct 2026), reversing phase 10: a player can carry several power-ups at once
-- (e.g. your Double in Q2 while the opponent froze his Q4) — what's not allowed is two power-ups
-- on the same player in the same quarter. This restores the phase 9 rules:
--   * one unique (league, week, player, quarter) per non-Hot-Start power-up
--   * Hot Start has no quarter (stored as 1), so it is excluded and can sit beside a Double/Freeze
-- Safe to run whether or not phase 10 was applied. Run in the Supabase SQL editor.

drop index if exists public.powerup_picks_player_week_uq;     -- phase 10's one-per-player-per-week index
drop index if exists public.powerup_picks_quarter_uq;
create unique index if not exists powerup_picks_quarter_uq
  on public.powerup_picks(league_id, week, player_id, quarter) where powerup_key <> 'hotstart';

create or replace function public.log_powerup(lid uuid, wk int, pid text, pname text, key text, q int, target text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  if exists (select 1 from public.powerup_picks where league_id=lid and week=wk and user_id=auth.uid() and powerup_key=key) then
    raise exception 'You already used % this week', key; end if;
  if key <> 'hotstart' and exists (
    select 1 from public.powerup_picks where league_id=lid and week=wk and player_id=pid and quarter=q and powerup_key <> 'hotstart'
  ) then
    raise exception '% already has a power-up scheduled for Q%', pname, q;
  end if;
  if key = 'hotstart' and exists (
    select 1 from public.powerup_picks where league_id=lid and week=wk and player_id=pid and powerup_key='hotstart'
  ) then
    raise exception '% already has a Hot Start this week', pname;
  end if;
  insert into public.powerup_picks(league_id, week, user_id, player_id, player_name, target_player_id, powerup_key, quarter)
    values (lid, wk, auth.uid(), pid, pname, target, key, q);
end; $$;
