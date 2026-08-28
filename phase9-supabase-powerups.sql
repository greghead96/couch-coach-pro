-- ============================================================
-- Couch Coach Fantasy — Phase 9: power-up mechanics fixes.
-- Run in Supabase SQL Editor after phase8-supabase-feedback-batch.sql.
-- ============================================================

-- powerup_picks previously had unique(league_id, week, player_id) — AT MOST
-- ONE power-up per player per week, full stop. That's too strict: Freeze
-- targets the OPPONENT's player for one quarter, and Double targets YOUR
-- OWN player for a (necessarily different) quarter — a player frozen by
-- their opponent for Q2 should still be eligible for their own manager's
-- Double Points on Q1/Q3/Q4. The old constraint made that impossible even
-- though it's not a real conflict, which is exactly the "can't select a
-- frozen player for other power-ups at all" bug reported live.
--
-- Replaced with a partial unique index scoped to (league_id, week,
-- player_id, quarter) — at most one power-up on a given player in a given
-- QUARTER, not the whole week — and excluding hotstart entirely, since it
-- always stores a placeholder quarter (1; hot start isn't quarter-scoped
-- at all, it applies to whichever quarter the player's first qualifying TD
-- happens to land in) that would otherwise falsely collide with a real
-- per-quarter pick on Q1.
alter table public.powerup_picks drop constraint if exists powerup_picks_league_id_week_player_id_key;
create unique index if not exists powerup_picks_quarter_uq
  on public.powerup_picks(league_id, week, player_id, quarter) where powerup_key <> 'hotstart';

-- log_powerup: duplicate check narrowed to match — same quarter, not just
-- same player (and still skipped entirely for hotstart, whose "already
-- has a power-up" case is fully covered by the "already used hotstart
-- this week" check above it, since only a player's own manager could ever
-- hotstart them).
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
  insert into public.powerup_picks(league_id, week, user_id, player_id, player_name, target_player_id, powerup_key, quarter)
    values (lid, wk, auth.uid(), pid, pname, target, key, q);
end; $$;
