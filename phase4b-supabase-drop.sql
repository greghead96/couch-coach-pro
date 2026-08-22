-- ============================================================
-- Couch Coach Fantasy — Phase 2, Milestone 4b: drop player
-- Run in Supabase SQL Editor after the earlier phase files.
-- ============================================================

-- Drop one of YOUR drafted players (they become a free agent again).
create or replace function public.drop_player(lid uuid, pid text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.draft_picks
   where league_id = lid and player_id = pid and user_id = auth.uid();
end; $$;
