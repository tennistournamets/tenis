-- ---------------------------------------------------------------------------
-- Users page: last activity (20261109191046_platform_users_last_seen)
-- last_sign_in_at moves only on a new Google sign-in, while a session lives for
-- weeks. last_seen_at also takes the latest session refresh (auth.sessions), and
-- "active in 7 days" counts by it. Same signature, safe to re-run.

create or replace function platform_users_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception using errcode = '42501', message = 'Platform admin required';
  end if;

  return (
    with tour as (
      select t.id, t.name, t.slug, t.sport, t.format, t.category, t.status, t.visibility, t.created_at,
             en.approved, en.pending, ma.total as matches, ma.played
        from tournaments t
        cross join lateral (
          select count(*) filter (where e.status = 'approved') as approved,
                 count(*) filter (where e.status = 'pending') as pending
            from entries e where e.tournament_id = t.id
        ) en
        cross join lateral (
          -- A finished match with an empty side is a BYE, not a played match.
          select count(*) as total,
                 count(*) filter (where m.status = 'finished' and m.side_a_entry_id is not null and m.side_b_entry_id is not null) as played
            from matches m where m.tournament_id = t.id
        ) ma
    ),
    usr as (
      select u.id, u.email::text as email, u.created_at, u.last_sign_in_at,
             greatest(u.last_sign_in_at, (
               select max(coalesce(s.refreshed_at at time zone 'UTC', s.updated_at))
                 from auth.sessions s where s.user_id = u.id
             )) as last_seen_at,
             coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), nullif(btrim(u.raw_user_meta_data ->> 'name'), '')) as name,
             coalesce(nullif(p.avatar_url, ''), nullif(u.raw_user_meta_data ->> 'avatar_url', ''), nullif(u.raw_user_meta_data ->> 'picture', '')) as avatar_url,
             exists (select 1 from platform_admins pa where pa.user_id = u.id) as is_platform_admin,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                 'id', tr.id, 'name', tr.name, 'slug', tr.slug, 'sport', tr.sport, 'format', tr.format,
                 'category', tr.category, 'status', tr.status, 'visibility', tr.visibility,
                 'created_at', tr.created_at, 'role', ta.role,
                 'approved', tr.approved, 'pending', tr.pending, 'matches', tr.matches, 'played', tr.played
               ) order by tr.created_at desc)
                 from tournament_admins ta
                 join tour tr on tr.id = ta.tournament_id
                where ta.user_id = u.id
             ), '[]'::jsonb) as tournaments
        from auth.users u
        left join players p on p.user_id = u.id and not p.is_deleted
    )
    select jsonb_build_object(
      'totals', jsonb_build_object(
        'users', (select count(*) from usr),
        'users_7d', (select count(*) from usr where created_at > now() - interval '7 days'),
        'users_30d', (select count(*) from usr where created_at > now() - interval '30 days'),
        'active_7d', (select count(*) from usr where last_seen_at > now() - interval '7 days'),
        'organizers', (select count(*) from usr where jsonb_array_length(tournaments) > 0),
        'tournaments', (select count(*) from tour),
        'tournaments_7d', (select count(*) from tour where created_at > now() - interval '7 days'),
        'tournaments_30d', (select count(*) from tour where created_at > now() - interval '30 days'),
        'in_progress', (select count(*) from tour where status = 'in_progress'),
        'completed', (select count(*) from tour where status = 'completed'),
        'participants', (select coalesce(sum(approved), 0) from tour),
        'matches_played', (select coalesce(sum(played), 0) from tour)
      ),
      'users', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'email', email, 'name', name, 'avatar_url', avatar_url,
          'created_at', created_at, 'last_sign_in_at', last_sign_in_at, 'last_seen_at', last_seen_at,
          'is_platform_admin', is_platform_admin, 'tournaments', tournaments
        ) order by created_at desc nulls last)
          from usr
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke execute on function platform_users_overview() from public, anon;
grant execute on function platform_users_overview() to authenticated;
