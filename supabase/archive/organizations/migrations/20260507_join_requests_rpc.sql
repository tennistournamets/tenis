-- =============================================
-- M5 — Pending join-request listing for club admins
-- =============================================
-- approve_membership / reject_membership already live in
-- 20260502_multitenancy_rpc.sql. This migration only adds the listing RPC
-- the club-admin invites view needs to display incoming join requests.

create or replace function list_join_requests(p_org_id uuid)
returns table (
  membership_id uuid,
  player_id uuid,
  display_name text,
  avatar_url text,
  user_email text,
  role membership_role,
  created_at timestamptz
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_org_admin(p_org_id) then raise exception 'Forbidden'; end if;

  return query
    select
      m.id,
      p.id,
      p.display_name,
      p.avatar_url,
      u.email::text,
      m.role,
      m.created_at
    from org_memberships m
    join players p on p.id = m.player_id
    left join auth.users u on u.id = p.user_id
    where m.org_id = p_org_id
      and m.status = 'pending'
      and p.is_deleted = false
    order by m.created_at desc;
end $$;

grant execute on function list_join_requests(uuid) to authenticated;
