-- ============================================================
-- Couch Coach Fantasy — Phase 8: tester feedback batch (realtime coverage,
-- waiver multi-claim/same-drop support, waiver order persistence for
-- Reverse Standings, claim messaging/ordering, orphaned-claim cleanup,
-- and a critical trades RLS recursion fix).
-- Run in Supabase SQL Editor after phase7-supabase-playoffs.sql.
-- ============================================================

-- CRITICAL: phase6's "read my trades" policy on trades checks trade_votes
-- via an EXISTS subquery, and trade_votes' own "read trade votes" policy
-- checks trades via an EXISTS subquery right back — every read of either
-- table recursively re-triggers the other's RLS policy, which Postgres
-- detects as infinite recursion and errors out. PostgREST surfaces that as
-- a bare 500 Internal Server Error, which is exactly what every SELECT on
-- trades has been hitting since phase6 shipped — trades were always being
-- created successfully (propose_trade is security definer and bypasses
-- RLS for its own INSERT), they just could never be READ BACK by anyone,
-- proposer included, which is why every trade "disappeared" instantly.
-- Fixed by moving the trade_votes check into a security-definer function —
-- its internal query bypasses RLS entirely, so it can no longer re-trigger
-- trades' own policy and the cycle is broken.
create or replace function public.voted_on_trade(tid bigint)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.trade_votes where trade_id = tid and user_id = auth.uid());
$$;

drop policy if exists "read my trades" on public.trades;
create policy "read my trades" on public.trades for select to authenticated
  using (public.is_member(league_id) and (
    from_user = auth.uid() or to_user = auth.uid() or status = 'pending_review'
    or public.voted_on_trade(id)
  ));

-- One-time cleanup: the trades-invisible bug above meant every failed
-- "Send" attempt looked like nothing happened, so testers understandably
-- resubmitted the exact same offer repeatedly — leaving a pile of
-- identical pending trades once reads started working again. Cancels all
-- but the most recent of each exact-duplicate group (same proposer,
-- recipient, and exact offer/request player sets, order-independent).
-- Safe to run more than once — nothing left to dedupe the second time.
with dupes as (
  select id, row_number() over (
    partition by league_id, from_user, to_user,
      (select array_agg(x order by x) from jsonb_array_elements_text(offer) x),
      (select array_agg(x order by x) from jsonb_array_elements_text(request) x)
    order by created_at desc
  ) as rn
  from public.trades where status in ('pending','pending_review')
)
update public.trades set status='cancelled' where id in (select id from dupes where rn > 1);

-- propose_trade: blocks submitting an exact carbon-copy of a trade you
-- already have pending to the same recipient (same offer AND request
-- player sets, order-independent) — this is what let the duplicate pile
-- above happen in the first place, now that reads work and resubmitting
-- no longer looks like a no-op. Different combinations against the same
-- recipient (different players, a different drop, an added extra piece)
-- are still allowed — e.g. Bijan-for-Gibbs and Bijan-for-Burrow to the
-- same manager can both sit pending; whichever gets accepted first
-- executes, and execute_trade's existing stale-ownership check (unchanged)
-- already rejects the other automatically once Bijan is no longer yours
-- to trade.
create or replace function public.propose_trade(lid uuid, target uuid, offer jsonb, request jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare tid bigint; deadline text; cw int; dw int; dupe_id bigint; v_offer jsonb; v_request jsonb;
begin
  -- Aliased to distinct names up front: the dupe-check query below joins
  -- against public.trades, which itself has "offer"/"request" columns —
  -- Postgres can't tell those apart from these same-named parameters once
  -- both are in scope in the same query ("column reference is ambiguous"),
  -- so every reference from here on uses v_offer/v_request instead. Can't
  -- rename the parameters themselves — PostgREST matches this RPC's JSON
  -- body by parameter name, and the client sends {lid, target, offer, request}.
  v_offer := offer; v_request := request;
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  if target = auth.uid() then raise exception 'You cannot trade with yourself'; end if;
  select l.settings->'league'->>'tradeDeadline', l.current_week into deadline, cw from public.leagues l where l.id=lid;
  if deadline is not null and deadline <> 'No deadline' then
    dw := nullif(regexp_replace(deadline, '\D', '', 'g'), '')::int;
    if dw is not null and cw is not null and cw > dw then
      raise exception 'The trade deadline (%) has passed', deadline;
    end if;
  end if;
  if jsonb_array_length(v_offer)=0 or jsonb_array_length(v_request)=0 then raise exception 'Pick players on both sides'; end if;
  if exists (select 1 from jsonb_array_elements_text(v_offer) x
             where not exists (select 1 from public.draft_picks where league_id=lid and player_id=x and user_id=auth.uid()))
    then raise exception 'You do not own all offered players'; end if;
  if exists (select 1 from jsonb_array_elements_text(v_request) x
             where not exists (select 1 from public.draft_picks where league_id=lid and player_id=x and user_id=target))
    then raise exception 'They do not own all requested players'; end if;
  select ex.id into dupe_id from public.trades ex
    where ex.league_id=lid and ex.from_user=auth.uid() and ex.to_user=target
      and ex.status in ('pending','pending_review')
      and (select array_agg(x order by x) from jsonb_array_elements_text(ex.offer) x)
        = (select array_agg(x order by x) from jsonb_array_elements_text(v_offer) x)
      and (select array_agg(x order by x) from jsonb_array_elements_text(ex.request) x)
        = (select array_agg(x order by x) from jsonb_array_elements_text(v_request) x)
    limit 1;
  if dupe_id is not null then raise exception 'This trade is already pending. Offer a different trade.'; end if;
  insert into public.trades (league_id, from_user, to_user, offer, request)
    values (lid, auth.uid(), target, v_offer, v_request) returning id into tid;
  return tid;
end; $$;

-- Timestamp of whatever actually SETTLED the trade (accepted/rejected/
-- cancelled) — created_at only ever recorded when it was PROPOSED, so
-- History had no way to show when a trade was actually resolved.
alter table public.trades add column if not exists resolved_at timestamptz;
-- Set (to the week it was accepted during) when a trade is accepted while
-- ANY offer/request player is locked (their real game already started this
-- week) — see execute_trade below for why it waits instead of moving
-- rosters immediately.
alter table public.trades add column if not exists execute_after_week int;

-- Internal only — actually moves the players. Now also: (1) names both
-- teams/managers and every player involved in the transactions log message
-- instead of a bare "Trade completed", (2) stamps resolved_at, (3) accepts
-- 'accepted_pending_week' as an awaiting-execution status too, since that's
-- exactly what set_week()/poll-scores.js's autoAdvanceWeeks() call this
-- with once a deferred trade's wait is over.
create or replace function public.execute_trade(tid bigint)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades; from_team text; to_team text; from_uname text; to_uname text;
  offer_names text; request_names text; detail text;
begin
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if t.status not in ('pending','pending_review','accepted_pending_week') then raise exception 'Trade is not awaiting execution'; end if;
  if exists (select 1 from jsonb_array_elements_text(t.offer) x
             where not exists (select 1 from public.draft_picks where league_id=t.league_id and player_id=x and user_id=t.from_user))
     or exists (select 1 from jsonb_array_elements_text(t.request) x
             where not exists (select 1 from public.draft_picks where league_id=t.league_id and player_id=x and user_id=t.to_user))
  then
    update public.trades set status='rejected', resolved_at=now() where id=tid;
    return;
  end if;
  select team_name into from_team from public.league_members where league_id=t.league_id and user_id=t.from_user;
  select team_name into to_team from public.league_members where league_id=t.league_id and user_id=t.to_user;
  select display_name into from_uname from public.profiles where id=t.from_user;
  select display_name into to_uname from public.profiles where id=t.to_user;
  select string_agg(player_name, ', ') into offer_names from public.draft_picks
    where league_id=t.league_id and player_id in (select jsonb_array_elements_text(t.offer));
  select string_agg(player_name, ', ') into request_names from public.draft_picks
    where league_id=t.league_id and player_id in (select jsonb_array_elements_text(t.request));
  detail := coalesce(from_team,'A team') || coalesce(' ('||from_uname||')','') || ' traded ' || coalesce(offer_names,'players')
    || ' to ' || coalesce(to_team,'a team') || coalesce(' ('||to_uname||')','') || ' for ' || coalesce(request_names,'players');
  update public.draft_picks set user_id=t.to_user
    where league_id=t.league_id and user_id=t.from_user and player_id in (select jsonb_array_elements_text(t.offer));
  update public.draft_picks set user_id=t.from_user
    where league_id=t.league_id and user_id=t.to_user and player_id in (select jsonb_array_elements_text(t.request));
  update public.trades set status='accepted', resolved_at=now() where id=tid;
  insert into public.transactions(league_id, kind, detail, actor) values (t.league_id, 'trade', detail, t.to_user);
end; $$;
revoke execute on function public.execute_trade(bigint) from public, anon, authenticated;

-- respond_trade: League-vote trades post to League Activity the moment
-- they enter review, since eligible voters (everyone except the two
-- parties) need to actually find out a vote is open — Commissioner-review
-- trades deliberately do NOT post here, only once execute_trade actually
-- runs them — the rest of the league doesn't need advance notice of
-- something only the commissioner acts on.
--
-- New p_locked param: the client checks (using the same real-kickoff-time
-- data it already uses to lock lineup slots) whether any offer/request
-- player's game has already started this week, and passes that along. When
-- true and this would otherwise execute instantly (no review), the trade
-- is marked accepted_pending_week instead — the actual roster move waits
-- until the league's current_week turns over (set_week / autoAdvanceWeeks
-- both sweep for these). Review-mode trades don't need this here since
-- they don't execute immediately anyway; the same check applies later, at
-- review_trade/vote_trade time, right when THEY would trigger execution.
--
-- IMPORTANT: create or replace does NOT drop a function whose parameter
-- list changed — it leaves the old 2-arg version in place and adds this
-- 3-arg one as a SEPARATE overload. With both coexisting, a call using
-- only {tid, accept} becomes genuinely ambiguous (Postgres can't tell if
-- you meant the old exact-2-arg function or this one using p_locked's
-- default), which is exactly the "could not choose the best candidate
-- function" error hit live — so the old signature is dropped first.
drop function if exists public.respond_trade(bigint, boolean);
create or replace function public.respond_trade(tid bigint, accept boolean, p_locked boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades; mode text;
begin
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if t.to_user <> auth.uid() then raise exception 'Only the recipient can respond'; end if;
  if t.status <> 'pending' then raise exception 'Trade is no longer pending'; end if;
  if not accept then update public.trades set status='rejected', resolved_at=now() where id=tid; return; end if;
  select coalesce(l.settings->'league'->>'tradeReview','No review') into mode from public.leagues l where l.id=t.league_id;
  if mode is null or mode = 'No review' then
    if p_locked then
      update public.trades set status='accepted_pending_week',
        execute_after_week=(select current_week from public.leagues where id=t.league_id) where id=tid;
    else
      perform public.execute_trade(tid);
    end if;
  else
    update public.trades set status='pending_review', review_mode=mode, review_started_at=now() where id=tid;
    if mode = 'League vote' then
      insert into public.transactions(league_id, kind, detail, actor)
        values (t.league_id, 'trade',
          coalesce((select team_name from public.league_members where league_id=t.league_id and user_id=t.from_user), 'A team')
          || ' ↔ ' || coalesce((select team_name from public.league_members where league_id=t.league_id and user_id=t.to_user), 'a team')
          || ' trade is up for a league vote — tap to review and vote.',
          t.from_user);
    end if;
  end if;
end; $$;

-- review_trade: same p_locked deferral as respond_trade, for the
-- commissioner-approval path (including a League-vote override approval).
-- Old 2-arg signature dropped first — same overload-ambiguity reason as
-- respond_trade above.
drop function if exists public.review_trade(bigint, boolean);
create or replace function public.review_trade(tid bigint, approve boolean, p_locked boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades;
begin
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if not exists (select 1 from public.leagues where id=t.league_id and commissioner_id=auth.uid()) then
    raise exception 'Only the commissioner can review this trade';
  end if;
  if t.status <> 'pending_review' then raise exception 'Trade is not awaiting review'; end if;
  if approve then
    if p_locked then
      update public.trades set status='accepted_pending_week',
        execute_after_week=(select current_week from public.leagues where id=t.league_id) where id=tid;
    else
      perform public.execute_trade(tid);
    end if;
  else
    update public.trades set status='rejected', resolved_at=now() where id=tid;
  end if;
end; $$;

-- vote_trade: fixes "column reference approve is ambiguous" — the approve
-- parameter shares its exact name with trade_votes.approve, and the tally
-- query below selects from trade_votes in the same scope, so Postgres
-- can't tell which "approve" is meant (same root cause as the earlier
-- offer/request ambiguity in propose_trade). Aliased to v_approve
-- internally and trade_votes qualified via "tv" throughout. Also adds the
-- same p_locked deferral as respond_trade/review_trade for the
-- majority-reached path. Old 2-arg signature dropped first — this is
-- exactly the overload that produced "Could not choose the best candidate
-- function... vote_trade(tid, approve), vote_trade(tid, approve, p_locked)"
-- live, once both signatures existed side by side.
drop function if exists public.vote_trade(bigint, boolean);
create or replace function public.vote_trade(tid bigint, approve boolean, p_locked boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades; eligible int; votes_for int; votes_against int; v_approve boolean;
begin
  v_approve := approve;
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if not public.is_member(t.league_id) then raise exception 'You are not in this league'; end if;
  if auth.uid() = t.from_user or auth.uid() = t.to_user then raise exception 'You cannot vote on your own trade'; end if;
  if t.status <> 'pending_review' or t.review_mode <> 'League vote' then raise exception 'This trade is not open for a league vote'; end if;
  insert into public.trade_votes(trade_id, user_id, approve) values (tid, auth.uid(), v_approve)
    on conflict (trade_id, user_id) do update set approve = excluded.approve, voted_at = now();
  select count(*) into eligible from public.league_members
    where league_id = t.league_id and user_id <> t.from_user and user_id <> t.to_user;
  select count(*) filter (where tv.approve), count(*) filter (where not tv.approve)
    into votes_for, votes_against from public.trade_votes tv where tv.trade_id = tid;
  if eligible > 0 and votes_for > eligible / 2.0 then
    if p_locked then
      update public.trades set status='accepted_pending_week',
        execute_after_week=(select current_week from public.leagues where id=t.league_id) where id = tid;
    else
      perform public.execute_trade(tid);
    end if;
  elsif eligible > 0 and votes_against > eligible / 2.0 then
    update public.trades set status='rejected', resolved_at=now() where id = tid;
  end if;
end; $$;

-- cancel_trade: also stamps resolved_at for History's timestamp.
create or replace function public.cancel_trade(tid bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.trades set status='cancelled', resolved_at=now()
   where id=tid and from_user=auth.uid() and status in ('pending','pending_review');
end; $$;

-- set_week: sweeps for trades that were accepted while a locked player was
-- involved and are now clear to actually execute, since the week they were
-- locked for has passed. This is the manual (commissioner-triggered)
-- path — poll-scores.js's autoAdvanceWeeks() carries an equivalent sweep
-- for the automatic in-season path, since it updates current_week directly
-- via REST rather than through this RPC.
create or replace function public.set_week(lid uuid, wk int)
returns void language plpgsql security definer set search_path = public as $$
declare old_wk int; new_wk int; r record;
begin
  if not exists (select 1 from public.leagues where id=lid and commissioner_id=auth.uid()) then
    raise exception 'Only the commissioner can change the week'; end if;
  select current_week into old_wk from public.leagues where id=lid;
  insert into public.weekly_lineups(league_id, week, user_id, starters)
    select lid, old_wk, user_id, starters from public.lineups where league_id=lid
    on conflict (league_id, week, user_id) do update set starters=excluded.starters;
  new_wk := greatest(1, wk);
  update public.leagues set current_week = new_wk where id=lid;
  for r in select id from public.trades where league_id=lid and status='accepted_pending_week' and execute_after_week < new_wk loop
    perform public.execute_trade(r.id);
  end loop;
end; $$;

-- Marks which week the persisted waiver_priority reflects. Reverse
-- Standings now persists its post-processing order too (previously only
-- Rolling priority did) so a manager who skips claims while managers ahead
-- of them claim shows correctly bumped up for the REST of that week,
-- instead of reverting to raw standings the instant the next run
-- recomputes. A mismatch against leagues.current_week means "new week,
-- recompute fresh from standings" — see poll-scores.js's buildPriorityOrder
-- and index.html's computeWaiverOrder, which both implement this same rule.
alter table public.leagues add column if not exists waiver_priority_week int;

-- reset_draft: also clear waiver_priority_week so a fresh season doesn't
-- carry forward a stale "same week" match against the new season's week 1.
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
  delete from public.player_week_stats where season_type = 'preseason';
  update public.leagues set current_week = 1, last_waiver_process = now(),
    waiver_priority = '[]'::jsonb, waiver_priority_week = null, standings_cache = '[]'::jsonb where id = lid;
  update public.drafts set status='pre', updated_at=now() where league_id = lid;
end; $$;

-- submit_waiver_claim: the "you already have a pending claim that drops
-- that player" guard is removed — you can now submit multiple claims that
-- all name the same drop target. process_one_waiver_claim's own
-- ownership re-check (below, unchanged) already handles this safely one
-- claim at a time: whichever processes first (by priority) actually drops
-- the player and adds its target; any of your OTHER pending claims naming
-- that same drop target either get auto-cancelled right then (see
-- cancel_claims_for_lost_drop below) or, if a claim ahead of this one in
-- the run already consumed the drop, this one's re-check catches it and
-- fails gracefully with "Drop target is no longer on your roster" instead
-- of double-spending the roster spot.
create or replace function public.submit_waiver_claim(
  lid uuid, add_pid text, add_pname text, add_ppos text, add_pteam text, add_phead text,
  drop_pid text default null, drop_pname text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare nextp int; newid bigint;
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  perform public.assert_draft_done(lid);
  if exists (select 1 from public.draft_picks where league_id = lid and player_id = add_pid) then
    raise exception 'That player is already on a roster';
  end if;
  if exists (select 1 from public.waiver_claims where league_id = lid and user_id = auth.uid()
             and add_player_id = add_pid and status = 'pending') then
    raise exception 'You already have a pending claim on that player';
  end if;
  select coalesce(max(priority), 0) + 1 into nextp
    from public.waiver_claims where league_id = lid and user_id = auth.uid() and status = 'pending';
  insert into public.waiver_claims(league_id, user_id, add_player_id, add_player_name, add_pos, add_team,
      add_headshot, drop_player_id, drop_player_name, priority)
    values (lid, auth.uid(), add_pid, add_pname, add_ppos, add_pteam, add_phead, drop_pid, drop_pname, nextp)
    returning id into newid;
  return newid;
end; $$;

-- Cancels a user's other PENDING claims that named pid as their drop
-- target, once pid has actually left their roster through some other
-- route (a different successful claim, an instant free-agent add-with-
-- drop, or a plain drop) — those claims can no longer free that roster
-- spot, so leaving them "pending" until they eventually fail on their own
-- is confusing (a tester hit exactly this: submitted a claim dropping X,
-- then separately free-agent-added another player and dropped X to make
-- room — the original claim should disappear, not linger and fail later).
-- exclude_id skips a specific claim (the one currently being processed,
-- which sets its OWN status separately in the same transaction).
create or replace function public.cancel_claims_for_lost_drop(lid uuid, uid uuid, pid text, exclude_id bigint default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.waiver_claims set status='cancelled', fail_reason='Drop target left your roster before this claim processed'
    where league_id=lid and user_id=uid and drop_player_id=pid and status='pending'
      and (exclude_id is null or id <> exclude_id);
end; $$;
revoke execute on function public.cancel_claims_for_lost_drop(uuid, uuid, text, bigint) from public, anon, authenticated;

-- add_free_agent: cancel any other pending claims counting on dropping the
-- same player, now that they're no longer on the roster to drop.
create or replace function public.add_free_agent(
  lid uuid, pid text, pname text, ppos text, pteam text, phead text,
  drop_pid text default null, drop_pname text default null
) returns void language plpgsql security definer set search_path = public as $$
declare cap int; cnt int; nextpick int;
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  perform public.assert_draft_done(lid);
  if exists (select 1 from public.draft_picks where league_id = lid and player_id = pid) then
    raise exception 'That player is already on a roster';
  end if;
  if exists (
    select 1 from public.waiver_wire w join public.leagues l on l.id = w.league_id
    where w.league_id = lid and w.player_id = pid and w.dropped_at > l.last_waiver_process
  ) then
    raise exception 'That player is on waivers — submit a claim instead';
  end if;

  select coalesce((select settings->'league'->>'rosterSize' from public.leagues where id = lid)::int, 16) into cap;
  select count(*) into cnt from public.draft_picks where league_id = lid and user_id = auth.uid();
  if cnt >= cap then
    if drop_pid is null then raise exception 'Your roster is full — pick a player to drop'; end if;
    if not exists (select 1 from public.draft_picks where league_id = lid and player_id = drop_pid and user_id = auth.uid()) then
      raise exception 'That player is not on your roster';
    end if;
    delete from public.draft_picks where league_id = lid and player_id = drop_pid and user_id = auth.uid();
    insert into public.waiver_wire(league_id, player_id, player_name, dropped_at)
      values (lid, drop_pid, drop_pname, now())
      on conflict (league_id, player_id) do update set dropped_at = now(), player_name = excluded.player_name;
    perform public.cancel_claims_for_lost_drop(lid, auth.uid(), drop_pid);
  end if;

  select coalesce(max(pick_no), 0) + 1 into nextpick from public.draft_picks where league_id = lid;
  insert into public.draft_picks(league_id, pick_no, round, user_id, player_id, player_name, pos, team, headshot)
    values (lid, nextpick, 0, auth.uid(), pid, pname, ppos, pteam, phead);

  insert into public.transactions(league_id, kind, detail, actor)
    select lid, 'add',
      coalesce((select team_name from public.league_members where league_id = lid and user_id = auth.uid()), 'A team')
      || ' added ' || pname || coalesce(' (dropped ' || drop_pname || ')', ''),
      auth.uid();
end; $$;

-- drop_player: same orphaned-claim cleanup as add_free_agent above.
create or replace function public.drop_player(lid uuid, pid text)
returns void language plpgsql security definer set search_path = public as $$
declare pname text; tname text;
begin
  select player_name into pname from public.draft_picks where league_id=lid and player_id=pid and user_id=auth.uid();
  if pname is null then raise exception 'That player is not on your roster'; end if;
  select team_name  into tname from public.league_members where league_id=lid and user_id=auth.uid();
  delete from public.draft_picks where league_id=lid and player_id=pid and user_id=auth.uid();
  insert into public.waiver_wire(league_id, player_id, player_name, dropped_at)
    values (lid, pid, pname, now())
    on conflict (league_id, player_id) do update set dropped_at = now(), player_name = excluded.player_name;
  perform public.cancel_claims_for_lost_drop(lid, auth.uid(), pid);
  insert into public.transactions(league_id, kind, detail, actor)
    values (lid, 'drop', coalesce(tname,'A team')||' dropped '||pname, auth.uid());
end; $$;

-- process_one_waiver_claim: (1) cancels the winning manager's OTHER pending
-- claims that named the same drop target, now that it's gone (2) the
-- transaction message now names the team AND username, matching
-- add_free_agent/drop_player's messages — previously it was the only
-- add/drop-family message with no attribution at all ("Won a waiver claim
-- on X"), so the League Activity feed couldn't say who made the claim.
create or replace function public.process_one_waiver_claim(cid bigint)
returns table(result_status text, result_reason text)
language plpgsql security definer set search_path = public as $$
declare c public.waiver_claims; cap int; cnt int; already_owned boolean; tname text; uname text; who text;
begin
  select * into c from public.waiver_claims where id = cid and status = 'pending' for update;
  if not found then
    return query select 'skipped'::text, 'Already resolved or cancelled'::text; return;
  end if;

  if exists (select 1 from public.draft_picks where league_id = c.league_id and player_id = c.add_player_id) then
    update public.waiver_claims set status='failed', fail_reason='Player was claimed by another manager first', processed_at=now() where id = cid;
    return query select 'failed'::text, 'Player was claimed by another manager first'::text; return;
  end if;

  select coalesce((settings->'league'->>'rosterSize')::int, 16) into cap from public.leagues where id = c.league_id;
  select count(*) into cnt from public.draft_picks where league_id = c.league_id and user_id = c.user_id;
  if cnt >= cap and c.drop_player_id is null then
    update public.waiver_claims set status='failed', fail_reason='Roster full and no drop selected', processed_at=now() where id = cid;
    return query select 'failed'::text, 'Roster full and no drop selected'::text; return;
  end if;

  if c.drop_player_id is not null then
    select exists(select 1 from public.draft_picks where league_id=c.league_id and user_id=c.user_id and player_id=c.drop_player_id) into already_owned;
    if not already_owned then
      update public.waiver_claims set status='failed', fail_reason='Drop target is no longer on your roster', processed_at=now() where id = cid;
      return query select 'failed'::text, 'Drop target is no longer on your roster'::text; return;
    end if;
  end if;

  begin
    if c.drop_player_id is not null then
      delete from public.draft_picks where league_id=c.league_id and user_id=c.user_id and player_id=c.drop_player_id;
      insert into public.waiver_wire(league_id, player_id, player_name, dropped_at)
        values (c.league_id, c.drop_player_id, c.drop_player_name, now())
        on conflict (league_id, player_id) do update set dropped_at = now(), player_name = excluded.player_name;
      perform public.cancel_claims_for_lost_drop(c.league_id, c.user_id, c.drop_player_id, cid);
    end if;
    insert into public.draft_picks(league_id, pick_no, round, user_id, player_id, player_name, pos, team, headshot)
      select c.league_id, coalesce(max(pick_no), 0) + 1, 0, c.user_id, c.add_player_id, c.add_player_name, c.add_pos, c.add_team, c.add_headshot
      from public.draft_picks where league_id = c.league_id;
  exception when others then
    update public.waiver_claims set status='failed', fail_reason='Could not complete: '||sqlerrm, processed_at=now() where id = cid;
    return query select 'failed'::text, ('Could not complete: '||sqlerrm)::text; return;
  end;

  update public.waiver_claims set status='successful', processed_at=now() where id = cid;
  select team_name into tname from public.league_members where league_id=c.league_id and user_id=c.user_id;
  select display_name into uname from public.profiles where id = c.user_id;
  who := coalesce(tname, 'A team') || case when uname is not null then ' (' || uname || ')' else '' end;
  insert into public.transactions(league_id, kind, detail, actor)
    values (c.league_id, 'add', who || ' won a waiver claim on ' || c.add_player_name || coalesce(' (dropped ' || c.drop_player_name || ')', ''), c.user_id);
  return query select 'successful'::text, null::text; return;
end; $$;
revoke execute on function public.process_one_waiver_claim(bigint) from public, anon, authenticated;

-- Realtime coverage gaps found while root-causing "I have to refresh to see
-- changes" — these three tables were never added to the publication at
-- all, so subscribing to them (lineups already was, in index.html's
-- subscribeDraft) was a dead no-op, and league_members/profiles changes
-- (rename team, change username, join/leave) never pushed to anyone.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='lineups') then
    alter publication supabase_realtime add table public.lineups; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='league_members') then
    alter publication supabase_realtime add table public.league_members; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='profiles') then
    alter publication supabase_realtime add table public.profiles; end if;
end $$;
