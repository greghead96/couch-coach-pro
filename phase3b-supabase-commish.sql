-- ============================================================
-- Couch Coach Fantasy — Phase 2, Milestone 3b: commissioner draft controls
-- Run in Supabase SQL Editor AFTER phase3-supabase-schema.sql.
-- ============================================================

-- Reset the draft back to "not started" (clears all picks). Commissioner only.
-- Also clears powerup_picks: those rows reference player_ids from the picks
-- just deleted, and inventory (refreshRealInv in index.html) is derived
-- entirely from powerup_picks for the current week — leaving them behind
-- after a reset permanently "uses up" that week's Double/Freeze/etc. for
-- players that no longer exist on anyone's roster.
create or replace function public.reset_draft(lid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.leagues where id = lid and commissioner_id = auth.uid()) then
    raise exception 'Only the commissioner can reset the draft';
  end if;
  delete from public.draft_picks where league_id = lid;
  delete from public.powerup_picks where league_id = lid;
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
