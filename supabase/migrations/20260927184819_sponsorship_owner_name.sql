-- Owner name for the platform admin's sponsorship table. Organizers sign in with
-- Google and usually have no players row, so the name falls back to the auth
-- profile (full_name / name), then the email. Same signature, safe to re-run.
create or replace function list_sponsorship_requests()
returns table (
  id uuid,
  tournament_id uuid,
  tournament_name text,
  tournament_slug text,
  tournament_status text,
  owner_name text,
  owner_email text,
  status text,
  message text,
  created_at timestamptz,
  updated_at timestamptz,
  decided_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'Platform admin required';
  end if;

  return query
  select r.id, r.tournament_id, t.name, t.slug, t.status::text,
         coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), nullif(btrim(u.raw_user_meta_data ->> 'name'), '')), u.email::text,
         r.status, r.message, r.created_at, r.updated_at, r.decided_at
    from sponsorship_requests r
    join tournaments t on t.id = r.tournament_id
    left join lateral (
      select ta.user_id from tournament_admins ta
       where ta.tournament_id = r.tournament_id and ta.role = 'owner'
       order by ta.created_at, ta.id
       limit 1
    ) o on true
    left join auth.users u on u.id = coalesce(o.user_id, r.requested_by)
    left join players p on p.user_id = u.id and not p.is_deleted
   order by (r.status = 'pending') desc, r.updated_at desc;
end;
$$;

revoke execute on function list_sponsorship_requests() from public, anon;
grant execute on function list_sponsorship_requests() to authenticated;
