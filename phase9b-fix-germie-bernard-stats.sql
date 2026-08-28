-- ============================================================
-- Couch Coach Fantasy — one-off data correction, not a schema migration.
-- Run in Supabase SQL Editor any time after phase9-supabase-powerups.sql.
--
-- The stat-duplication bug fixed in phase9 (rushing credited a second time
-- from a receiving line with 0 real carries) already wrote bad numbers into
-- player_week_stats before the fix went live — that fix only stops it from
-- happening to NEW polls, it doesn't retroactively correct what's already
-- stored. This walks every week of Germie Bernard's real stats, and for any
-- quarter where rushYds/rushTD exactly match recYds/recTD (the exact
-- signature of this bug — a genuine 0-carry line is 0 rushYds, not a
-- reception's yardage copied in), removes the duplicated rushing line and
-- backs its fantasy points out of that week's running total.
--
-- Safe to run more than once — after the first run finds and fixes the
-- duplicate, the pattern is gone, so later runs just report nothing found.
-- ============================================================
do $$
declare
  aid text; ryp numeric := 10; rtd numeric := 6;
  r record; q int; qkey text; qdata jsonb;
  rush_yds numeric; rush_td numeric; rec_yds numeric; rec_td numeric;
  removed_fp numeric; new_qpts jsonb; total_removed numeric; found_any boolean := false;
begin
  select player_id into aid from public.draft_picks where player_name ilike '%Germie Bernard%' limit 1;
  if aid is null then
    raise notice 'Germie Bernard not found in draft_picks — nothing to fix (has he been dropped/renamed?)';
    return;
  end if;

  for r in select * from public.player_week_stats where athlete_id = aid loop
    new_qpts := r.q_pts;
    total_removed := 0;
    for q in 1..4 loop
      qkey := q::text;
      qdata := r.q_pts->qkey;
      if qdata is null then continue; end if;
      rush_yds := (qdata->'stats'->>'rushYds')::numeric;
      rush_td  := (qdata->'stats'->>'rushTD')::numeric;
      rec_yds  := (qdata->'stats'->>'recYds')::numeric;
      rec_td   := (qdata->'stats'->>'recTD')::numeric;
      if rush_yds is not null and rush_yds > 0
         and rush_yds = coalesce(rec_yds, -1)
         and coalesce(rush_td, 0) = coalesce(rec_td, 0)
      then
        removed_fp := round((rush_yds / ryp + coalesce(rush_td, 0) * rtd) * 10) / 10;
        total_removed := total_removed + removed_fp;
        new_qpts := jsonb_set(new_qpts, array[qkey, 'fp'], to_jsonb(round((((qdata->>'fp')::numeric) - removed_fp) * 10) / 10));
        new_qpts := jsonb_set(new_qpts, array[qkey, 'stats'], (qdata->'stats') - 'rushYds' - 'rushTD');
        found_any := true;
        raise notice 'week %, Q%: removing duplicated rushing (% yds, % TD, % fp)', r.week, q, rush_yds, rush_td, removed_fp;
      end if;
    end loop;
    if total_removed > 0 then
      update public.player_week_stats
        set q_pts = new_qpts, prev_total = greatest(0, prev_total - total_removed)
        where athlete_id = aid and week = r.week;
    end if;
  end loop;

  if not found_any then
    raise notice 'No duplicated rush/rec lines found for Germie Bernard — either already fixed, or nothing to fix.';
  end if;
end $$;
