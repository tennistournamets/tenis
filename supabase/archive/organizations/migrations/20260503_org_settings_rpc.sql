-- =============================================
-- M3 — Club settings: admin can update organization
-- =============================================
-- Slug validation: lowercase, [a-z0-9-], 3..40 chars, no leading/trailing/
-- consecutive dashes, not reserved.
--
-- All fields are optional (pass NULL to leave unchanged).

create or replace function update_organization(
  p_org_id uuid,
  p_slug text default null,
  p_name text default null,
  p_description text default null,
  p_city text default null,
  p_country text default null,
  p_logo_url text default null,
  p_auto_approve_members boolean default null
) returns organizations
language plpgsql security definer
set search_path = public
as $$
declare
  v_row organizations%rowtype;
  v_new_slug text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_row from organizations where id = p_org_id for update;
  if not found then raise exception 'Organization not found'; end if;
  if not (is_org_admin(p_org_id) or is_platform_admin()) then
    raise exception 'Forbidden';
  end if;

  -- Slug validation + uniqueness
  if p_slug is not null then
    v_new_slug := lower(btrim(p_slug));

    if char_length(v_new_slug) < 3 or char_length(v_new_slug) > 40 then
      raise exception 'Slug must be 3..40 characters';
    end if;
    if v_new_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
      raise exception 'Slug must be lowercase a-z, 0-9, single dashes (no leading/trailing/consecutive)';
    end if;
    if v_new_slug in ('admin','api','app','auth','login','logout','register',
                      'clubs','club','coach','player','players','tournaments',
                      'tournament','settings','invite','invites','new','edit') then
      raise exception 'This slug is reserved';
    end if;
    if exists (select 1 from organizations where slug = v_new_slug and id <> p_org_id) then
      raise exception 'Slug already in use';
    end if;

    update organizations set slug = v_new_slug where id = p_org_id;
  end if;

  update organizations set
    name                 = coalesce(p_name, name),
    description          = coalesce(p_description, description),
    city                 = coalesce(p_city, city),
    country              = coalesce(p_country, country),
    logo_url             = coalesce(p_logo_url, logo_url),
    auto_approve_members = coalesce(p_auto_approve_members, auto_approve_members)
  where id = p_org_id
  returning * into v_row;

  return v_row;
end $$;

grant execute on function update_organization(uuid, text, text, text, text, text, text, boolean) to authenticated;

-- =============================================
-- Helper: get organizations the current user owns or administers
-- (used by frontend nav to show "Club settings" link).
-- =============================================
create or replace function my_organizations()
returns table (
  id uuid,
  slug text,
  type org_type,
  name text,
  logo_url text,
  city text,
  auto_approve_members boolean,
  is_active boolean,
  my_role text  -- 'owner' | 'admin'
)
language sql stable security definer
set search_path = public
as $$
  select
    o.id, o.slug, o.type, o.name, o.logo_url, o.city,
    o.auto_approve_members, o.is_active,
    'owner'::text as my_role
  from organizations o
  where o.owner_user_id = auth.uid()
  union
  select
    o.id, o.slug, o.type, o.name, o.logo_url, o.city,
    o.auto_approve_members, o.is_active,
    'admin'::text as my_role
  from organizations o
  join org_memberships m on m.org_id = o.id
  join players p on p.id = m.player_id
  where p.user_id = auth.uid()
    and m.role = 'admin'
    and m.status = 'active'
    and o.owner_user_id <> auth.uid();
$$;

grant execute on function my_organizations() to authenticated;

-- =============================================
-- Helper: public club page loader (all-in-one to reduce round-trips)
-- =============================================
create or replace function club_page_data(p_slug text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_org organizations%rowtype;
  v_tournaments jsonb;
  v_members jsonb;
  v_member_count int;
  v_my_membership jsonb;
begin
  select * into v_org from organizations where slug = p_slug and is_active = true;
  if not found then return null; end if;

  -- tournaments of the club (public only)
  select coalesce(jsonb_agg(t order by t.created_at desc), '[]'::jsonb)
  into v_tournaments
  from (
    select id, slug, name, category, status, created_at
    from tournaments
    where org_id = v_org.id and is_public = true
    order by created_at desc
    limit 50
  ) t;

  -- top-12 active members (for preview)
  select coalesce(jsonb_agg(m), '[]'::jsonb)
  into v_members
  from (
    select p.id, p.display_name, p.avatar_url, m.role, m.joined_at
    from org_memberships m
    join players p on p.id = m.player_id
    where m.org_id = v_org.id
      and m.status = 'active'
      and p.is_deleted = false
    order by m.joined_at desc nulls last
    limit 12
  ) m;

  -- total active members
  select count(*) into v_member_count
  from org_memberships m
  join players p on p.id = m.player_id
  where m.org_id = v_org.id and m.status = 'active' and p.is_deleted = false;

  -- current user's membership (if logged in and player exists)
  if auth.uid() is not null then
    select to_jsonb(m) into v_my_membership
    from org_memberships m
    join players p on p.id = m.player_id
    where m.org_id = v_org.id and p.user_id = auth.uid() and p.is_deleted = false
    limit 1;
  end if;

  return jsonb_build_object(
    'org', to_jsonb(v_org),
    'tournaments', v_tournaments,
    'members_preview', v_members,
    'members_count', v_member_count,
    'my_membership', coalesce(v_my_membership, 'null'::jsonb),
    'is_owner', v_org.owner_user_id = auth.uid()
  );
end $$;

grant execute on function club_page_data(text) to anon, authenticated;
