-- =============================================
-- M9 — Organization-native club registration/review flow
-- =============================================
--
-- New club registrations and super-admin review now use organizations
-- directly. The legacy `clubs` table remains only for old data/migration
-- compatibility.

do $$ begin
  create type organization_status as enum ('pending', 'active', 'rejected');
exception when duplicate_object then null; end $$;

alter table organizations
  add column if not exists status organization_status not null default 'active',
  add column if not exists address text,
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists rejection_reason text,
  add column if not exists reviewed_by uuid references auth.users(id),
  add column if not exists reviewed_at timestamptz;

create index if not exists idx_organizations_status on organizations(status);

-- Backfill organizations migrated from legacy clubs with available operational
-- fields. Pending/rejected legacy rows are copied in as organizations too so
-- the review dashboard has one source of truth.
insert into organizations (
  id, slug, type, name, city, address, contact_email, contact_phone,
  owner_user_id, status, is_active, rejection_reason, reviewed_by, reviewed_at,
  created_at
)
select
  c.id,
  'club-' || substring(c.id::text, 1, 8),
  'club'::org_type,
  c.name,
  c.city,
  c.address,
  c.contact_email,
  c.contact_phone,
  c.owner_id,
  case when c.status = 'rejected' then 'rejected'::organization_status
       when c.status = 'pending' then 'pending'::organization_status
       else 'active'::organization_status
  end,
  c.status in ('active','approved'),
  c.rejection_reason,
  c.reviewed_by,
  c.reviewed_at,
  c.created_at
from clubs c
where not exists (select 1 from organizations o where o.id = c.id)
on conflict (id) do nothing;

update organizations o
set
  address = coalesce(o.address, c.address),
  contact_email = coalesce(o.contact_email, c.contact_email),
  contact_phone = coalesce(o.contact_phone, c.contact_phone),
  status = case when c.status = 'rejected' then 'rejected'::organization_status
                when c.status = 'pending' then 'pending'::organization_status
                else 'active'::organization_status
           end,
  is_active = c.status in ('active','approved'),
  rejection_reason = c.rejection_reason,
  reviewed_by = c.reviewed_by,
  reviewed_at = c.reviewed_at
from clubs c
where o.id = c.id
  and o.type = 'club';

-- Public org reads must hide pending/rejected rows from anonymous users, while
-- still allowing owners and platform admins to see their review state.
drop policy if exists organizations_public_read on organizations;
drop policy if exists organizations_owner_write on organizations;
drop policy if exists organizations_platform_write on organizations;

create policy organizations_public_read on organizations
  for select using (
    (is_active = true and status = 'active')
    or auth.uid() = owner_user_id
    or is_platform_admin()
  );

-- Direct owner writes would allow self-approval by updating status/is_active.
-- Owner edits must go through update_organization(); review transitions must go
-- through approve_organization()/reject_organization().
create policy organizations_platform_write on organizations
  for all using (is_platform_admin())
  with check (is_platform_admin());

-- Legacy clubs are historical/backfill-only after this migration.
drop policy if exists clubs_insert_authenticated on clubs;
drop policy if exists clubs_update_superadmin on clubs;

-- register_organization: profile + pending club organization in one transaction.
create or replace function register_organization(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_org_name text,
  p_org_city text,
  p_org_address text default null,
  p_contact_email text default null,
  p_contact_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_slug text;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  insert into user_profiles (id, first_name, last_name, phone)
  values (v_uid, p_first_name, p_last_name, p_phone)
  on conflict (id) do update
  set first_name = excluded.first_name,
      last_name = excluded.last_name,
      phone = excluded.phone;

  if exists (
    select 1 from organizations
    where type = 'club'
      and lower(name) = lower(p_org_name)
      and lower(coalesce(city, '')) = lower(coalesce(p_org_city, ''))
      and status in ('pending', 'active')
  ) then
    raise exception 'CLUB_DUPLICATE';
  end if;

  if exists (
    select 1 from organizations
    where owner_user_id = v_uid
      and type = 'club'
      and status in ('pending', 'active')
  ) then
    raise exception 'CLUB_ALREADY_EXISTS';
  end if;

  v_slug := 'club-' || substring(replace(gen_random_uuid()::text, '-', ''), 1, 10);

  insert into organizations (
    slug, type, name, city, address, contact_email, contact_phone,
    owner_user_id, status, is_active
  )
  values (
    v_slug,
    'club',
    p_org_name,
    p_org_city,
    p_org_address,
    coalesce(p_contact_email, (select email from auth.users where id = v_uid)),
    p_contact_phone,
    v_uid,
    'pending',
    false
  )
  returning id into v_org_id;

  return v_org_id;
end $$;

create or replace function approve_organization(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'Not allowed';
  end if;

  update organizations
  set status = 'active',
      is_active = true,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      rejection_reason = null
  where id = p_org_id
    and type = 'club'
    and status = 'pending';
end $$;

create or replace function reject_organization(
  p_org_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'Not allowed';
  end if;

  update organizations
  set status = 'rejected',
      is_active = false,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      rejection_reason = p_reason
  where id = p_org_id
    and type = 'club'
    and status = 'pending';
end $$;

create or replace function list_organizations_for_review()
returns table (
  id uuid,
  name text,
  city text,
  address text,
  contact_email text,
  contact_phone text,
  status organization_status,
  rejection_reason text,
  created_at timestamptz,
  reviewed_at timestamptz,
  owner_first_name text,
  owner_last_name text,
  owner_email text,
  owner_phone text,
  duplicate_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'Not allowed';
  end if;

  return query
  select
    o.id,
    o.name,
    o.city,
    o.address,
    o.contact_email,
    o.contact_phone,
    o.status,
    o.rejection_reason,
    o.created_at,
    o.reviewed_at,
    up.first_name::text as owner_first_name,
    up.last_name::text as owner_last_name,
    u.email::text as owner_email,
    up.phone::text as owner_phone,
    (
      select count(*) from organizations o2
      where o2.type = 'club'
        and lower(o2.name) = lower(o.name)
        and lower(coalesce(o2.city, '')) = lower(coalesce(o.city, ''))
        and o2.id <> o.id
        and o2.status in ('active', 'pending')
    ) as duplicate_count
  from organizations o
  join auth.users u on u.id = o.owner_user_id
  left join user_profiles up on up.id = o.owner_user_id
  where o.type = 'club'
  order by
    case o.status when 'pending' then 0 when 'active' then 1 when 'rejected' then 2 else 3 end,
    o.created_at desc;
end $$;

create or replace function my_club_registration()
returns table (
  id uuid,
  name text,
  city text,
  address text,
  contact_email text,
  contact_phone text,
  status organization_status,
  rejection_reason text,
  created_at timestamptz,
  reviewed_at timestamptz,
  slug text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    o.name,
    o.city,
    o.address,
    o.contact_email,
    o.contact_phone,
    o.status,
    o.rejection_reason,
    o.created_at,
    o.reviewed_at,
    o.slug
  from organizations o
  where o.owner_user_id = auth.uid()
    and o.type = 'club'
  order by o.created_at desc
  limit 1;
$$;

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
  select * into v_org
  from organizations
  where slug = p_slug
    and is_active = true
    and status = 'active';
  if not found then return null; end if;

  select coalesce(jsonb_agg(t order by t.created_at desc), '[]'::jsonb)
  into v_tournaments
  from (
    select id, slug, name, category, status, created_at
    from tournaments
    where org_id = v_org.id and is_public = true
    order by created_at desc
    limit 50
  ) t;

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

  select count(*) into v_member_count
  from org_memberships m
  join players p on p.id = m.player_id
  where m.org_id = v_org.id and m.status = 'active' and p.is_deleted = false;

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

-- Backwards-compatible RPC wrappers. New writes stay in organizations.
create or replace function register_club(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_club_name text,
  p_club_city text,
  p_club_address text default null,
  p_contact_email text default null,
  p_contact_phone text default null
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select register_organization(
    p_first_name,
    p_last_name,
    p_phone,
    p_club_name,
    p_club_city,
    p_club_address,
    p_contact_email,
    p_contact_phone
  );
$$;

create or replace function approve_club(p_club_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  select approve_organization(p_club_id);
$$;

create or replace function reject_club(p_club_id uuid, p_reason text default null)
returns void
language sql
security definer
set search_path = public
as $$
  select reject_organization(p_club_id, p_reason);
$$;

drop function if exists get_pending_clubs();
create or replace function get_pending_clubs()
returns table (
  id uuid,
  name text,
  city text,
  address text,
  contact_email text,
  contact_phone text,
  status organization_status,
  rejection_reason text,
  created_at timestamptz,
  reviewed_at timestamptz,
  owner_first_name text,
  owner_last_name text,
  owner_email text,
  owner_phone text,
  duplicate_count bigint
)
language sql
security definer
set search_path = public
as $$
  select
    id,
    name,
    city,
    address,
    contact_email,
    contact_phone,
    status,
    rejection_reason,
    created_at,
    reviewed_at,
    owner_first_name,
    owner_last_name,
    owner_email,
    owner_phone,
    duplicate_count
  from list_organizations_for_review();
$$;

grant execute on function register_organization(text, text, text, text, text, text, text, text) to authenticated;
grant execute on function approve_organization(uuid) to authenticated;
grant execute on function reject_organization(uuid, text) to authenticated;
grant execute on function list_organizations_for_review() to authenticated;
grant execute on function my_club_registration() to authenticated;
grant execute on function club_page_data(text) to anon, authenticated;
grant execute on function register_club(text, text, text, text, text, text, text, text) to authenticated;
grant execute on function approve_club(uuid) to authenticated;
grant execute on function reject_club(uuid, text) to authenticated;
grant execute on function get_pending_clubs() to authenticated;
