-- =============================================
-- M2 — Backend RPC + views
-- =============================================
-- All membership/player operations via SECURITY DEFINER RPC.
-- Frontend uses supabase.rpc() only; direct writes are blocked by RLS.
--
-- Adaptations from IMPLEMENTATION_PLAN.md M2:
--   - views use actual columns: matches.winner_entry_id / side_a_entry_id /
--     side_b_entry_id, entry_members.member_order (plan referenced
--     winner_side / entry_a_id / em.slot which don't exist).
--   - register_entry: new params p_member_one_contact / p_member_two_contact
--     added with defaults so frontend keeps working until updated.
--   - create_tournament: p_org_id added as optional; when NULL,
--     a personal coach org is auto-created for the caller.

-- =============================================
-- M2.1 — Player RPCs
-- =============================================

-- upsert_player:
--   1) if p_user_id provided & player with that user_id exists → return it
--   2) else try by contact_hash; link user_id if came in
--   3) else create new player
-- p_contact may be NULL/empty → no contact_hash lookup, new player created
create or replace function upsert_player(
  p_display_name text,
  p_contact text default null,
  p_user_id uuid default null
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_hash text := hash_contact(p_contact);
begin
  if p_user_id is not null then
    select id into v_player_id
    from players
    where user_id = p_user_id and is_deleted = false
    limit 1;
    if v_player_id is not null then
      -- refresh name if previous was placeholder-ish
      update players set display_name = coalesce(nullif(btrim(p_display_name), ''), display_name)
      where id = v_player_id;
      return v_player_id;
    end if;
  end if;

  if v_hash is not null then
    select id into v_player_id
    from players
    where contact_hash = v_hash and is_deleted = false
    limit 1;

    if v_player_id is not null then
      if p_user_id is not null then
        update players
          set user_id = p_user_id
          where id = v_player_id and user_id is null;
      end if;
      return v_player_id;
    end if;
  end if;

  insert into players (user_id, display_name, contact_hash)
  values (p_user_id, coalesce(nullif(btrim(p_display_name), ''), 'Игрок'), v_hash)
  returning id into v_player_id;

  return v_player_id;
end $$;

-- merge_players: admin-only. Preserves all entry/membership history under p_keep.
create or replace function merge_players(p_keep uuid, p_drop uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'Only platform admin can merge players';
  end if;
  if p_keep = p_drop then
    raise exception 'Cannot merge a player into itself';
  end if;

  update entry_members set player_id = p_keep where player_id = p_drop;

  -- Drop duplicate memberships before moving
  delete from org_memberships
  where player_id = p_drop
    and org_id in (select org_id from org_memberships where player_id = p_keep);

  update org_memberships set player_id = p_keep where player_id = p_drop;

  update players
    set merged_into = p_keep,
        is_deleted  = true,
        contact_hash = null
  where id = p_drop;
end $$;

-- delete_player: soft-delete (GDPR). Self or super-admin.
create or replace function delete_player(p_player_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from players where id = p_player_id and user_id = auth.uid()
  ) and not is_platform_admin() then
    raise exception 'Forbidden';
  end if;

  update players set
    display_name = 'Удалённый игрок',
    contact_hash = null,
    avatar_url = null,
    birth_year = null,
    user_id = null,
    is_deleted = true
  where id = p_player_id;

  update org_memberships set status = 'inactive' where player_id = p_player_id;
end $$;

-- =============================================
-- M2.2 — Membership RPCs
-- =============================================

-- join_organization: self-join by slug.
-- Returns jsonb { membership_id, status, needs_approval, already? }
create or replace function join_organization(p_org_slug text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_org organizations%rowtype;
  v_player_id uuid;
  v_existing org_memberships%rowtype;
  v_new_status membership_status;
  v_membership_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_org from organizations
  where slug = p_org_slug and is_active = true;
  if not found then
    raise exception 'Organization not found';
  end if;

  select id into v_player_id
  from players where user_id = auth.uid() and is_deleted = false;
  if v_player_id is null then
    raise exception 'Player profile required';
  end if;

  select * into v_existing
  from org_memberships where org_id = v_org.id and player_id = v_player_id;

  if found then
    if v_existing.status in ('active','pending') then
      return jsonb_build_object(
        'membership_id', v_existing.id,
        'status', v_existing.status,
        'already', true,
        'needs_approval', v_existing.status = 'pending'
      );
    end if;
    if v_existing.status = 'banned' then
      raise exception 'You are banned from this organization';
    end if;
  end if;

  v_new_status := case when v_org.auto_approve_members then 'active'::membership_status
                       else 'pending'::membership_status end;

  insert into org_memberships (org_id, player_id, status, joined_at, role)
  values (
    v_org.id,
    v_player_id,
    v_new_status,
    case when v_new_status = 'active' then now() else null end,
    'member'
  )
  on conflict (org_id, player_id) do update set
    status = excluded.status,
    joined_at = excluded.joined_at,
    review_note = null
  returning id into v_membership_id;

  return jsonb_build_object(
    'membership_id', v_membership_id,
    'status', v_new_status,
    'already', false,
    'needs_approval', v_new_status = 'pending'
  );
end $$;

create or replace function leave_organization(p_org_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update org_memberships
    set status = 'inactive',
        expires_at = now(),
        is_primary = false
  where org_id = p_org_id
    and player_id = (
      select id from players where user_id = auth.uid() and is_deleted = false
    );
end $$;

create or replace function approve_membership(
  p_membership_id uuid,
  p_note text default null
) returns void
language plpgsql security definer
set search_path = public
as $$
declare v_org_id uuid;
begin
  select org_id into v_org_id from org_memberships where id = p_membership_id;
  if v_org_id is null then raise exception 'Membership not found'; end if;
  if not is_org_admin(v_org_id) then raise exception 'Forbidden'; end if;

  update org_memberships set
    status = 'active',
    joined_at = now(),
    review_note = p_note
  where id = p_membership_id and status = 'pending';
end $$;

create or replace function reject_membership(
  p_membership_id uuid,
  p_note text default null
) returns void
language plpgsql security definer
set search_path = public
as $$
declare v_org_id uuid;
begin
  select org_id into v_org_id from org_memberships where id = p_membership_id;
  if v_org_id is null then raise exception 'Membership not found'; end if;
  if not is_org_admin(v_org_id) then raise exception 'Forbidden'; end if;

  update org_memberships set
    status = 'rejected',
    review_note = p_note
  where id = p_membership_id;
end $$;

-- remove_membership: soft remove. If p_ban → status='banned', else 'inactive'.
create or replace function remove_membership(
  p_membership_id uuid,
  p_ban boolean default false,
  p_note text default null
) returns void
language plpgsql security definer
set search_path = public
as $$
declare v_org_id uuid;
begin
  select org_id into v_org_id from org_memberships where id = p_membership_id;
  if v_org_id is null then raise exception 'Membership not found'; end if;
  if not is_org_admin(v_org_id) then raise exception 'Forbidden'; end if;

  update org_memberships set
    status = case when p_ban then 'banned'::membership_status
                  else 'inactive'::membership_status end,
    review_note = p_note,
    expires_at = now(),
    is_primary = false
  where id = p_membership_id;
end $$;

-- admin_add_member: admin manually adds a member (creates/uses ghost player).
create or replace function admin_add_member(
  p_org_id uuid,
  p_display_name text,
  p_contact text default null,
  p_role membership_role default 'member'
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_membership_id uuid;
begin
  if not is_org_admin(p_org_id) then raise exception 'Forbidden'; end if;

  v_player_id := upsert_player(p_display_name, p_contact, null);

  insert into org_memberships (org_id, player_id, role, status, joined_at, invited_by)
  values (p_org_id, v_player_id, p_role, 'active', now(), auth.uid())
  on conflict (org_id, player_id) do update set
    status = 'active',
    joined_at = now(),
    role = excluded.role
  returning id into v_membership_id;

  return v_membership_id;
end $$;

-- set_primary_club: only one is_primary=true allowed per player (enforced by unique partial index).
create or replace function set_primary_club(p_org_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare v_player_id uuid;
begin
  select id into v_player_id
  from players where user_id = auth.uid() and is_deleted = false;
  if v_player_id is null then raise exception 'Player not found'; end if;

  update org_memberships set is_primary = false where player_id = v_player_id;
  update org_memberships set is_primary = true
    where player_id = v_player_id
      and org_id = p_org_id
      and status = 'active';
end $$;

-- =============================================
-- M2.3 — Invite RPCs
-- =============================================

create or replace function create_invite(
  p_org_id uuid,
  p_contact text,
  p_display_name text default null,
  p_role membership_role default 'member',
  p_message text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_hash text;
  v_player_id uuid;
  v_email text;
  v_phone text;
  v_invite_id uuid;
  v_token text;
  v_already boolean := false;
begin
  if not is_org_admin(p_org_id) then raise exception 'Forbidden'; end if;
  if p_contact is null or btrim(p_contact) = '' then
    raise exception 'Contact is required';
  end if;

  v_hash := hash_contact(p_contact);
  if position('@' in p_contact) > 0 then
    v_email := btrim(p_contact);
  else
    v_phone := btrim(p_contact);
  end if;

  select id into v_player_id
  from players where contact_hash = v_hash and is_deleted = false limit 1;

  if v_player_id is not null then
    select true into v_already
    from org_memberships
    where org_id = p_org_id and player_id = v_player_id and status = 'active';
    if coalesce(v_already, false) then
      return jsonb_build_object('already_member', true);
    end if;
  end if;

  if v_player_id is null and p_display_name is not null
     and btrim(p_display_name) <> '' then
    v_player_id := upsert_player(p_display_name, p_contact, null);
  end if;

  insert into org_invites (
    org_id, contact_email, contact_phone, contact_hash,
    player_id, role, message, invited_by
  ) values (
    p_org_id, v_email, v_phone, v_hash,
    v_player_id, p_role, p_message, auth.uid()
  )
  returning id, token into v_invite_id, v_token;

  -- pending membership placeholder (only if player known)
  if v_player_id is not null then
    insert into org_memberships (org_id, player_id, role, status, invited_by)
    values (p_org_id, v_player_id, p_role, 'pending', auth.uid())
    on conflict (org_id, player_id) do nothing;
  end if;

  return jsonb_build_object(
    'invite_id', v_invite_id,
    'token', v_token,
    'already_member', false
  );
end $$;

create or replace function accept_invite(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_invite org_invites%rowtype;
  v_player_id uuid;
  v_profile_name text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_invite from org_invites
  where token = p_token and status = 'pending';
  if not found then raise exception 'Invite not found or already processed'; end if;
  if v_invite.expires_at < now() then
    update org_invites set status = 'expired' where id = v_invite.id;
    raise exception 'Invite expired';
  end if;

  select id into v_player_id
  from players where user_id = auth.uid() and is_deleted = false;

  if v_player_id is null then
    select nullif(btrim(concat_ws(' ', first_name, last_name)), '')
      into v_profile_name
    from user_profiles where id = auth.uid();

    v_player_id := upsert_player(
      coalesce(v_profile_name, 'Игрок'),
      coalesce(v_invite.contact_email, v_invite.contact_phone),
      auth.uid()
    );
  end if;

  -- If invite was addressed to a ghost and current user has a separate
  -- player record → merge ghost into real (requires super-admin per
  -- merge_players guard, so we only do it when platform_admin() is true;
  -- otherwise we just consume the membership under the current player).
  if v_invite.player_id is not null
     and v_invite.player_id <> v_player_id
     and is_platform_admin() then
    perform merge_players(v_player_id, v_invite.player_id);
  end if;

  update org_invites set status = 'accepted', accepted_at = now() where id = v_invite.id;

  insert into org_memberships (org_id, player_id, role, status, joined_at, invited_by)
  values (v_invite.org_id, v_player_id, v_invite.role, 'active', now(), v_invite.invited_by)
  on conflict (org_id, player_id) do update set
    status = 'active',
    joined_at = now(),
    role = excluded.role;

  return jsonb_build_object('org_id', v_invite.org_id);
end $$;

create or replace function reject_invite(p_token text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update org_invites set status = 'rejected'
  where token = p_token and status = 'pending';
end $$;

create or replace function revoke_invite(p_invite_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare v_org_id uuid;
begin
  select org_id into v_org_id from org_invites where id = p_invite_id;
  if v_org_id is null then raise exception 'Invite not found'; end if;
  if not is_org_admin(v_org_id) then raise exception 'Forbidden'; end if;
  update org_invites set status = 'revoked' where id = p_invite_id;
end $$;

-- Batch expiry (call from cron or Edge Function).
create or replace function expire_old_invites()
returns integer
language sql security definer
set search_path = public
as $$
  with u as (
    update org_invites
      set status = 'expired'
      where status = 'pending' and expires_at < now()
    returning 1
  )
  select count(*)::int from u;
$$;

-- =============================================
-- M2.4 — Stats views
-- =============================================
-- Corrected to use actual columns:
--   matches.winner_entry_id, matches.side_a_entry_id, matches.side_b_entry_id
--   entry_members.member_order (not em.slot)

drop view if exists v_player_stats_global;
create view v_player_stats_global as
select
  p.id as player_id,
  p.display_name,
  count(*) filter (
    where m.winner_entry_id is not null and m.winner_entry_id = e.id
  ) as wins,
  count(*) filter (
    where m.winner_entry_id is not null and m.winner_entry_id <> e.id
  ) as losses
from players p
left join entry_members em on em.player_id = p.id
left join entries e on e.id = em.entry_id
left join matches m on
  (m.side_a_entry_id = e.id or m.side_b_entry_id = e.id)
where p.is_deleted = false
group by p.id, p.display_name;

create or replace function player_stats_by_org(
  p_org_id uuid,
  p_player_id uuid
) returns table (
  wins bigint,
  losses bigint,
  tournaments_played bigint
)
language sql stable
set search_path = public
as $$
  select
    count(*) filter (
      where m.winner_entry_id is not null and m.winner_entry_id = e.id
    ) as wins,
    count(*) filter (
      where m.winner_entry_id is not null and m.winner_entry_id <> e.id
    ) as losses,
    count(distinct t.id) as tournaments_played
  from matches m
  join tournaments t on t.id = m.tournament_id
  join entries e on (e.id = m.side_a_entry_id or e.id = m.side_b_entry_id)
  join entry_members em on em.entry_id = e.id
  where t.org_id = p_org_id and em.player_id = p_player_id;
$$;

-- =============================================
-- M2.5 — Extend existing RPCs
-- =============================================

-- register_entry: backward-compatible. Two new optional params for
-- per-member contacts (doubles). If provided, primary member is linked
-- by that contact; otherwise the entry's phone_or_email is used for
-- member 1 and member 2 stays contact-less (new ghost player).
create or replace function register_entry(
  p_slug text,
  p_entry_type tournament_category,
  p_phone_or_email text,
  p_member_one text,
  p_member_two text default null,
  p_display_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament tournaments;
  v_entry_id uuid;
  v_display_name text;
  v_player_one uuid;
  v_player_two uuid;
begin
  select * into v_tournament from tournaments where slug = p_slug limit 1;

  if v_tournament.id is null then raise exception 'Tournament not found'; end if;
  if v_tournament.is_public is false then raise exception 'Tournament is private'; end if;
  if v_tournament.status <> 'registration_open' then raise exception 'Registration is closed'; end if;
  if v_tournament.category <> p_entry_type then raise exception 'Invalid category for tournament'; end if;

  if p_entry_type = 'singles' and (p_member_one is null or btrim(p_member_one) = '') then
    raise exception 'Single entry requires one participant';
  end if;
  if p_entry_type = 'doubles' then
    if p_member_one is null or btrim(p_member_one) = '' then
      raise exception 'Double entry requires at least one participant';
    end if;
    if v_tournament.doubles_pairing_mode <> 'pick_random'
       and (p_member_two is null or btrim(p_member_two) = '') then
      raise exception 'Double entry requires two participants';
    end if;
  end if;

  if p_phone_or_email is null or btrim(p_phone_or_email) = '' then
    raise exception 'Contact info is required';
  end if;
  if btrim(p_phone_or_email) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     and btrim(p_phone_or_email) !~ '^\+?[0-9\s\-\(\)]{7,20}$' then
    raise exception 'Invalid phone number or email';
  end if;

  if exists (
    select 1 from entries e
    where e.tournament_id = v_tournament.id
      and e.phone_or_email = p_phone_or_email
      and e.status in ('pending','approved')
  ) then
    raise exception 'Registration already exists for this contact';
  end if;

  if p_display_name is not null and btrim(p_display_name) <> '' then
    v_display_name := p_display_name;
  elsif p_entry_type = 'singles' then
    v_display_name := p_member_one;
  elsif p_member_two is not null and btrim(p_member_two) <> '' then
    v_display_name := p_member_one || ' / ' || p_member_two;
  else
    v_display_name := p_member_one;
  end if;

  insert into entries (tournament_id, entry_type, display_name, phone_or_email, status)
  values (v_tournament.id, p_entry_type, v_display_name, p_phone_or_email, 'pending')
  returning id into v_entry_id;

  -- Upsert/link player #1 using the entry contact + current user (if logged in)
  v_player_one := upsert_player(p_member_one, p_phone_or_email, auth.uid());

  insert into entry_members (entry_id, member_name, member_order, player_id)
  values (v_entry_id, p_member_one, 1, v_player_one);

  if p_entry_type = 'doubles' and p_member_two is not null and btrim(p_member_two) <> '' then
    -- Secondary member has no dedicated contact → ghost player with null hash
    v_player_two := upsert_player(p_member_two, null, null);
    insert into entry_members (entry_id, member_name, member_order, player_id)
    values (v_entry_id, p_member_two, 2, v_player_two);
  end if;

  return v_entry_id;
end $$;

-- create_tournament: add optional p_org_id.
-- If NULL → auto-create (or reuse) a personal coach org for the caller.
create or replace function create_tournament(
  p_name text,
  p_slug text,
  p_description text default null,
  p_category tournament_category default 'singles',
  p_set_format set_format default 'best_of_3',
  p_is_public boolean default true,
  p_doubles_pairing_mode doubles_pairing_mode default null,
  p_org_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_uid uuid := auth.uid();
  v_org_id uuid := p_org_id;
  v_profile_name text;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  if v_org_id is null then
    -- Reuse existing org owned by caller
    select id into v_org_id from organizations where owner_user_id = v_uid order by created_at asc limit 1;
  else
    -- Verify caller is allowed to create tournaments under the requested org
    if not is_org_admin(v_org_id) then
      raise exception 'Forbidden for this organization';
    end if;
  end if;

  if v_org_id is null then
    -- Still no org → create a personal coach org
    select nullif(btrim(concat_ws(' ', first_name, last_name)), '') into v_profile_name
      from user_profiles where id = v_uid;

    insert into organizations (slug, type, name, owner_user_id)
    values (
      'coach-' || substring(v_uid::text, 1, 8),
      'coach',
      coalesce(v_profile_name, 'Coach') || ' (coach)',
      v_uid
    )
    on conflict (slug) do update set name = excluded.name
    returning id into v_org_id;
  end if;

  insert into tournaments (
    name, slug, description, category, set_format, status, is_public,
    doubles_pairing_mode, created_by, org_id
  )
  values (
    p_name, p_slug, p_description, p_category, p_set_format,
    'registration_open', p_is_public,
    case when p_category = 'doubles' then coalesce(p_doubles_pairing_mode, 'pre_agreed') else null end,
    v_uid,
    v_org_id
  )
  returning id into v_id;

  insert into tournament_admins (tournament_id, user_id, role)
  values (v_id, v_uid, 'owner');

  return v_id;
end $$;

-- =============================================
-- Grants
-- =============================================

grant execute on function upsert_player(text, text, uuid)      to authenticated;
grant execute on function merge_players(uuid, uuid)            to authenticated;
grant execute on function delete_player(uuid)                  to authenticated;

grant execute on function join_organization(text)              to authenticated;
grant execute on function leave_organization(uuid)             to authenticated;
grant execute on function approve_membership(uuid, text)       to authenticated;
grant execute on function reject_membership(uuid, text)        to authenticated;
grant execute on function remove_membership(uuid, boolean, text) to authenticated;
grant execute on function admin_add_member(uuid, text, text, membership_role) to authenticated;
grant execute on function set_primary_club(uuid)               to authenticated;

grant execute on function create_invite(uuid, text, text, membership_role, text) to authenticated;
grant execute on function accept_invite(text)                  to authenticated;
grant execute on function reject_invite(text)                  to authenticated;
grant execute on function revoke_invite(uuid)                  to authenticated;
grant execute on function expire_old_invites()                 to authenticated;

grant execute on function player_stats_by_org(uuid, uuid)      to authenticated;
grant select on v_player_stats_global to authenticated;
