-- Padel points formats: Americano, Mexicano, Team Americano, King of the Court.
-- Kept in its own file because a value added with ALTER TYPE cannot be used
-- inside the same transaction.
alter type public.tournament_format add value if not exists 'americano';
alter type public.tournament_format add value if not exists 'mexicano';
alter type public.tournament_format add value if not exists 'team_americano';
alter type public.tournament_format add value if not exists 'king_of_court';
