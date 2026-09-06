-- =============================================
-- M4 — Invite RPCs (public preview + admin list + past-players helper)
-- =============================================
-- create_invite / accept_invite / reject_invite / revoke_invite live in
-- 20260502_multitenancy_rpc.sql. This migration adds the pieces the UI needs:
--   * get_invite_preview — anonymous-friendly snapshot for /invites/:token
--   * list_invites       — admin list for club-admin invites view
--   * past_org_players   — "prior tournament players" picker for invite composer

-- get_invite_preview: callable by anyone (token is a bearer secret).
-- Returns org card + invite meta + state flags. Never reveals hashes/ids.
create or replace function get_invite_preview(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_invite org_invites%rowtype;
  v_org organizations%rowtype;
  v_inviter_name text;
  v_effective_status text;
begin
  select * into v_invite from org_invites where token = p_token;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  select * into v_org from organizations where id = v_invite.org_id;

  select nullif(btrim(concat_ws(' ', first_name, last_name)), '')
    into v_inviter_name
  from user_profiles where id = v_invite.invited_by;

  v_effective_status := v_invite.status;
  if v_effective_status = 'pending' and v_invite.expires_at < now() then
    v_effective_status := 'expired';
  end if;

  return jsonb_build_object(
    'found', true,
    'status', v_effective_status,
    'expires_at', v_invite.expires_at,
    'message', v_invite.message,
    'role', v_invite.role,
    'contact_email', v_invite.contact_email,
    'contact_phone', v_invite.contact_phone,
    'inviter_name', v_inviter_name,
    'org', jsonb_build_object(
      'id', v_org.id,
      'slug', v_org.slug,
      'name', v_org.name,
      'type', v_org.type,
      'city', v_org.city,
      'country', v_org.country,
      'description', v_org.description,
      'logo_url', v_org.logo_url,
      'auto_approve_members', v_org.auto_approve_members
    )
  );
end $$;

-- list_invites: admins only. Returns pending/sent invites for a club.
create or replace function list_invites(p_org_id uuid)
returns table (
  id uuid,
  token text,
  contact_email text,
  contact_phone text,
  role membership_role,
  status text,
  message text,
  player_id uuid,
  player_display_name text,
  expires_at timestamptz,
  created_at timestamptz,
  accepted_at timestamptz
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_org_admin(p_org_id) then raise exception 'Forbidden'; end if;

  return query
    select
      i.id, i.token, i.contact_email, i.contact_phone, i.role, i.status,
      i.message, i.player_id, p.display_name,
      i.expires_at, i.created_at, i.accepted_at
    from org_invites i
    left join players p on p.id = i.player_id
    where i.org_id = p_org_id
    order by
      case i.status when 'pending' then 0 else 1 end,
      i.created_at desc;
end $$;

-- past_org_players: players who participated in club tournaments but are not
-- active members. Feeds the "invite prior participants" tab in composer.
create or replace function past_org_players(p_org_id uuid)
returns table (
  player_id uuid,
  display_name text,
  avatar_url text,
  tournaments_count bigint,
  has_pending_invite boolean,
  has_pending_membership boolean
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_org_admin(p_org_id) then raise exception 'Forbidden'; end if;

  return query
    select
      p.id,
      p.display_name,
      p.avatar_url,
      count(distinct t.id) as tournaments_count,
      exists (
        select 1 from org_invites i
        where i.org_id = p_org_id and i.player_id = p.id and i.status = 'pending'
      ) as has_pending_invite,
      exists (
        select 1 from org_memberships m
        where m.org_id = p_org_id and m.player_id = p.id and m.status = 'pending'
      ) as has_pending_membership
    from entry_members em
    join entries e on e.id = em.entry_id
    join tournaments t on t.id = e.tournament_id
    join players p on p.id = em.player_id
    where t.org_id = p_org_id
      and p.is_deleted = false
      and not exists (
        select 1 from org_memberships m
        where m.org_id = p_org_id and m.player_id = p.id and m.status = 'active'
      )
    group by p.id, p.display_name, p.avatar_url
    order by tournaments_count desc, p.display_name asc;
end $$;

grant execute on function get_invite_preview(text) to anon, authenticated;
grant execute on function list_invites(uuid) to authenticated;
grant execute on function past_org_players(uuid) to authenticated;
