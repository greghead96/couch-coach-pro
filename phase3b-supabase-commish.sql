-- ============================================================
-- Couch Coach Fantasy — Phase 2, Milestone 3b: commissioner draft controls
-- Run in Supabase SQL Editor AFTER phase3-supabase-schema.sql.
-- ============================================================

-- Resets the WHOLE league for a fresh season, not just the draft — this
-- grew from "clear picks so we can redraft" into "wipe everything from
-- testing" on purpose, since a fresh draft with old power-up/waiver/trade/
-- score history lying around left several ways for stale test data to
-- collide with real results (see phase4f's season_type column comment for
-- the sharpest example: preseason and regular season reuse the same week
-- numbers, so a leftover preseason stat row can silently suppress real
-- scoring later at that same week number).
--
-- Depends on tables from phase5 (waivers), phase6 (trade review), phase7
-- (playoffs), and phase4f's season_type column — run this file AFTER
-- those, or re-run it again afterward, if you haven't already.
--
-- The client shows a strong confirmation before calling this — it is NOT
-- recoverable.
create or replace function public.reset_draft(lid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.leagues where id = lid and commissioner_id = auth.uid()) then
    raise exception 'Only the commissioner can reset the draft';
  end if;
  delete from public.draft_picks where league_id = lid;
  delete from public.powerup_picks where league_id = lid;
  delete from public.weekly_lineups where league_id = lid;
  delete from public.waiver_claims where league_id = lid;
  delete from public.waiver_wire where league_id = lid;
  delete from public.trades where league_id = lid; -- cascades to trade_votes
  delete from public.playoff_matchups where league_id = lid;
  delete from public.transactions where league_id = lid;
  -- Global, not league-scoped (player_week_stats has no league_id — see
  -- phase4f) — safe because 'preseason' rows are test data everywhere,
  -- by definition, regardless of which league drafted that player.
  -- Real ('regular') rows for any league already in its actual season
  -- are never touched.
  delete from public.player_week_stats where season_type = 'preseason';
  update public.leagues set current_week = 1, last_waiver_process = now(),
    waiver_priority = '[]'::jsonb, standings_cache = '[]'::jsonb where id = lid;
  update public.drafts set status='pre', updated_at=now() where league_id = lid;
end; $$;

-- Commissioner makes the CURRENT on-the-clock pick on behalf of that manager
-- (for a buddy who's away). Assigns the pick to whoever is on the clock.
create or replace function public.commish_pick(lid uuid, pid text, pname text, ppos text, pteam text, phead text)
returns int language plpgsql security definer set search_path = public as $$
declare d public.drafts; n int; cnt int; pno int; rnd int; slot int; onclock uuid;
begin
  if not exists (select 1 from public.leagues where id = lid and commissioner_id = auth.uid()) then
    raise exception 'Only the commissioner can pick for others';
  end if;
  select * into d from public.drafts where league_id = lid;
  if not found or d.status <> 'live' then raise exception 'Draft is not live'; end if;
  n := jsonb_array_length(d.member_order);
  if n = 0 then raise exception 'No members'; end if;
  select count(*) into cnt from public.draft_picks where league_id = lid;
  pno := cnt + 1;
  if pno > n * d.rounds then raise exception 'Draft complete'; end if;
  rnd := (pno - 1) / n;
  if (rnd % 2) = 0 then slot := (pno - 1) % n; else slot := n - 1 - ((pno - 1) % n); end if;
  onclock := (d.member_order ->> slot)::uuid;
  if exists (select 1 from public.draft_picks where league_id = lid and player_id = pid) then
    raise exception 'Player already drafted';
  end if;
  insert into public.draft_picks (league_id, pick_no, round, user_id, player_id, player_name, pos, team, headshot)
    values (lid, pno, rnd + 1, onclock, pid, pname, ppos, pteam, phead);
  if pno = n * d.rounds then update public.drafts set status='done', updated_at=now() where league_id = lid; end if;
  return pno;
end; $$;

-- Remove a manager from the league. Commissioner only, can't remove self.
-- If a draft is currently live, this resets it (order changed) so the board stays valid.
create or replace function public.remove_member(lid uuid, uid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare st text;
begin
  if not exists (select 1 from public.leagues where id = lid and commissioner_id = auth.uid()) then
    raise exception 'Only the commissioner can remove members';
  end if;
  if uid = auth.uid() then raise exception 'You cannot remove yourself'; end if;
  delete from public.league_members where league_id = lid and user_id = uid;
  delete from public.draft_picks   where league_id = lid and user_id = uid;
  select status into st from public.drafts where league_id = lid;
  if st = 'live' then
    delete from public.draft_picks where league_id = lid;
    update public.drafts set status='pre', updated_at=now(),
      member_order = (select coalesce(jsonb_agg(user_id order by joined_at), '[]'::jsonb)
                        from public.league_members where league_id = lid)
      where league_id = lid;
  end if;
end; $$;

-- Enforces the "Number of teams" commish setting (previously informational
-- only). Rejoining/renaming (already a member) is never blocked by the cap
-- — only a genuinely NEW member counts against it. No cap is enforced if
-- the commissioner never set "Number of teams" (settings->league->teams
-- is null), matching how the setting behaved before.
create or replace function public.join_league(code text, team text)
returns uuid language plpgsql security definer set search_path = public as $$
declare lid uuid; cap int; cnt int; already_member boolean;
begin
  select id into lid from public.leagues where join_code = upper(code);
  if lid is null then raise exception 'League not found for code %', code; end if;

  select exists(select 1 from public.league_members where league_id=lid and user_id=auth.uid()) into already_member;
  if not already_member then
    select (settings->'league'->>'teams')::int into cap from public.leagues where id=lid;
    if cap is not null then
      select count(*) into cnt from public.league_members where league_id=lid;
      if cnt >= cap then
        raise exception 'This league is full (% teams) — create a new league or try a different join code', cap;
      end if;
    end if;
  end if;

  insert into public.league_members (league_id, user_id, team_name)
    values (lid, auth.uid(), team)
    on conflict (league_id, user_id) do update set team_name = excluded.team_name;
  return lid;
end; $$;
