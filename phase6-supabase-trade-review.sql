-- ============================================================
-- Couch Coach Fantasy — Phase 6: trade review (Commissioner / League vote)
-- and trade deadline enforcement. Run in Supabase SQL Editor after phase5.
--
-- Previously "Commissioner"/"League vote" were just labels in a dropdown —
-- respond_trade always executed a trade the instant the recipient accepted,
-- regardless of the setting. Same for "Trade deadline" — propose_trade never
-- checked it. Both are wired up for real now.
-- ============================================================

alter table public.trades add column if not exists review_mode text;
-- When review started — lets the background job (poll-scores.js) force a
-- resolution 48h later if the league vote never reaches a decisive
-- majority in time (see resolveExpiredTradeReviews there).
alter table public.trades add column if not exists review_started_at timestamptz;

-- Anyone in the league needs to be able to SEE a trade once it's up for a
-- league vote (not just the two parties), so they can actually vote on it.
drop policy if exists "read my trades" on public.trades;
create policy "read my trades" on public.trades for select to authenticated
  using (public.is_member(league_id) and (from_user = auth.uid() or to_user = auth.uid() or status = 'pending_review'));

create table if not exists public.trade_votes (
  trade_id bigint references public.trades on delete cascade,
  user_id  uuid references auth.users not null,
  approve  boolean not null,
  voted_at timestamptz default now(),
  primary key (trade_id, user_id)
);
alter table public.trade_votes enable row level security;
drop policy if exists "read trade votes" on public.trade_votes;
create policy "read trade votes" on public.trade_votes for select to authenticated
  using (exists (select 1 from public.trades t where t.id = trade_id and public.is_member(t.league_id)));
-- writes only via vote_trade() below

-- Internal only — actually moves the players. Called by respond_trade
-- (no-review path), review_trade (commissioner approval), and vote_trade
-- (majority reached). Not meant to be called directly by a client: no
-- authorization check of its own beyond "is this trade actually awaiting
-- execution", so EXECUTE is revoked from client roles below.
create or replace function public.execute_trade(tid bigint)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades;
begin
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if t.status not in ('pending','pending_review') then raise exception 'Trade is not awaiting execution'; end if;
  if exists (select 1 from jsonb_array_elements_text(t.offer) x
             where not exists (select 1 from public.draft_picks where league_id=t.league_id and player_id=x and user_id=t.from_user))
    then update public.trades set status='rejected' where id=tid; raise exception 'Offer is no longer valid'; end if;
  if exists (select 1 from jsonb_array_elements_text(t.request) x
             where not exists (select 1 from public.draft_picks where league_id=t.league_id and player_id=x and user_id=t.to_user))
    then update public.trades set status='rejected' where id=tid; raise exception 'Request is no longer valid'; end if;
  update public.draft_picks set user_id=t.to_user
    where league_id=t.league_id and user_id=t.from_user and player_id in (select jsonb_array_elements_text(t.offer));
  update public.draft_picks set user_id=t.from_user
    where league_id=t.league_id and user_id=t.to_user and player_id in (select jsonb_array_elements_text(t.request));
  update public.trades set status='accepted' where id=tid;
  insert into public.transactions(league_id, kind, detail, actor) values (t.league_id, 'trade', 'Trade completed', t.to_user);
end; $$;
revoke execute on function public.execute_trade(bigint) from public;

-- Trade deadline check added; everything else unchanged from phase4c.
create or replace function public.propose_trade(lid uuid, target uuid, offer jsonb, request jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare tid bigint; deadline text; cw int; dw int;
begin
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;
  if target = auth.uid() then raise exception 'You cannot trade with yourself'; end if;
  select l.settings->'league'->>'tradeDeadline', l.current_week into deadline, cw from public.leagues l where l.id=lid;
  if deadline is not null and deadline <> 'No deadline' then
    dw := nullif(regexp_replace(deadline, '\D', '', 'g'), '')::int;
    if dw is not null and cw is not null and cw > dw then
      raise exception 'The trade deadline (%) has passed', deadline;
    end if;
  end if;
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

-- Accepting no longer always executes immediately — routes through review
-- if the league's tradeReview setting calls for it.
create or replace function public.respond_trade(tid bigint, accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades; mode text;
begin
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if t.to_user <> auth.uid() then raise exception 'Only the recipient can respond'; end if;
  if t.status <> 'pending' then raise exception 'Trade is no longer pending'; end if;
  if not accept then update public.trades set status='rejected' where id=tid; return; end if;
  select coalesce(l.settings->'league'->>'tradeReview','No review') into mode from public.leagues l where l.id=t.league_id;
  if mode is null or mode = 'No review' then
    perform public.execute_trade(tid);
  else
    update public.trades set status='pending_review', review_mode=mode, review_started_at=now() where id=tid;
  end if;
end; $$;

-- Commissioner mode: sole approver. League-vote mode: also serves as the
-- commissioner's veto/fast-track backstop regardless of the current tally.
create or replace function public.review_trade(tid bigint, approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades;
begin
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if not exists (select 1 from public.leagues where id=t.league_id and commissioner_id=auth.uid()) then
    raise exception 'Only the commissioner can review this trade';
  end if;
  if t.status <> 'pending_review' then raise exception 'Trade is not awaiting review'; end if;
  if approve then perform public.execute_trade(tid);
  else update public.trades set status='rejected' where id=tid; end if;
end; $$;

-- League vote: majority of everyone EXCEPT the two trading managers. No
-- deadline — stays pending_review until a side reaches strict majority of
-- all eligible voters (not just votes cast so far) or the commissioner
-- vetoes via review_trade.
create or replace function public.vote_trade(tid bigint, approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare t public.trades; eligible int; votes_for int; votes_against int;
begin
  select * into t from public.trades where id = tid;
  if not found then raise exception 'Trade not found'; end if;
  if not public.is_member(t.league_id) then raise exception 'You are not in this league'; end if;
  if auth.uid() = t.from_user or auth.uid() = t.to_user then raise exception 'You cannot vote on your own trade'; end if;
  if t.status <> 'pending_review' or t.review_mode <> 'League vote' then raise exception 'This trade is not open for a league vote'; end if;
  insert into public.trade_votes(trade_id, user_id, approve) values (tid, auth.uid(), approve)
    on conflict (trade_id, user_id) do update set approve = excluded.approve, voted_at = now();
  select count(*) into eligible from public.league_members
    where league_id = t.league_id and user_id <> t.from_user and user_id <> t.to_user;
  select count(*) filter (where approve), count(*) filter (where not approve)
    into votes_for, votes_against from public.trade_votes where trade_id = tid;
  if eligible > 0 and votes_for > eligible / 2.0 then perform public.execute_trade(tid);
  elsif eligible > 0 and votes_against > eligible / 2.0 then update public.trades set status='rejected' where id = tid;
  end if;
end; $$;

-- Let the proposer back out of a trade stuck in review too, not just while
-- still plain "pending".
create or replace function public.cancel_trade(tid bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.trades set status='cancelled'
   where id=tid and from_user=auth.uid() and status in ('pending','pending_review');
end; $$;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='trade_votes') then
    alter publication supabase_realtime add table public.trade_votes; end if;
end $$;
