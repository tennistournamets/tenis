-- The organizer's tournament list with the counts behind each card, in one
-- request instead of a list query followed by entries/matches/live_scores
-- queries. Runs with the caller's rights: rows and counts are exactly what the
-- tables' own policies show (a counter sees approved entries only).
-- A finished match with an empty side is a BYE, not a match to play.
-- Safe to re-run.

create or replace function public.list_my_tournaments()
returns jsonb language sql stable security invoker set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'name', t.name,
    'slug', t.slug,
    'sport', t.sport,
    'format', t.format,
    'category', t.category,
    'status', t.status,
    'set_format', t.set_format,
    'doubles_pairing_mode', t.doubles_pairing_mode,
    'visibility', t.visibility,
    'registration_deadline', t.registration_deadline,
    'registration_capacity', t.registration_capacity,
    'created_at', t.created_at,
    'role', ta.role,
    'progress', jsonb_build_object(
      'approved', en.approved, 'pending', en.pending,
      'matches', ma.total, 'played', ma.played, 'byes', ma.byes,
      'live', li.live
    )
  ) order by t.created_at desc), '[]'::jsonb)
  from tournament_admins ta
  join tournaments t on t.id = ta.tournament_id
  cross join lateral (
    select count(*) filter (where e.status = 'approved') approved,
           count(*) filter (where e.status = 'pending') pending
    from entries e where e.tournament_id = t.id
  ) en
  cross join lateral (
    select count(*) total,
           count(*) filter (where m.status = 'finished' and m.side_a_entry_id is not null and m.side_b_entry_id is not null) played,
           count(*) filter (where m.status = 'finished' and (m.side_a_entry_id is null or m.side_b_entry_id is null)) byes
    from matches m where m.tournament_id = t.id
  ) ma
  cross join lateral (
    select count(*) live from live_scores l where l.tournament_id = t.id and l.status = 'active'
  ) li
  where ta.user_id = auth.uid();
$$;
revoke execute on function public.list_my_tournaments() from public, anon;
grant execute on function public.list_my_tournaments() to authenticated;
