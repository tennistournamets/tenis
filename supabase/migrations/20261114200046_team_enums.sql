-- ---------------------------------------------------------------------------
-- Team ties, part 1 (20261114200046_team_enums)
-- New enum values only: a value added by ALTER TYPE cannot be used in the same
-- transaction, so the logic lives in 20261114200047_team_ties. Safe to re-run.
--   tournament_category 'team'  an entry is a team with a roster of players
--   match_stage 'rubber'        one match (line) inside a team tie
-- ---------------------------------------------------------------------------

alter type public.tournament_category add value if not exists 'team';
alter type public.match_stage add value if not exists 'rubber';
