-- =============================================
-- M1 — Multi-tenancy foundation
-- organizations + players + org_memberships + org_invites
-- =============================================
--
-- Idempotent: safe to re-run.
-- Contains: schema, data migration from legacy `clubs`, helpers, RLS, realtime.
-- Rollback: see 20260501_multitenancy_rollback.sql
--
-- Adaptations from IMPLEMENTATION_PLAN.md M1 to match actual schema.sql:
--   - clubs has no `slug` column → generated as 'club-' + short id
--   - clubs has no `description`/`logo_url` → left NULL
--   - clubs.status active values are ('approved','active') not just 'active'
--   - entries.contact is actually `phone_or_email`
--   - user_profiles has no `display_name` → composed from first_name + last_name
--   - `base64url` encoding is not supported by Postgres encode() →
--     translate(encode(..., 'base64'), '+/', '-_') with '=' stripped

create extension if not exists pgcrypto;

-- =============================================
-- 0. HELPER FUNCTIONS (required by RLS policies below)
-- =============================================

create or replace function normalize_contact(p_contact text)
returns text language sql immutable as $$
  select regexp_replace(lower(coalesce(trim(p_contact), '')), '\s|-|\+|\(|\)', '', 'g');
$$;

create or replace function hash_contact(p_contact text)
returns text language sql immutable as $$
  select case
    when p_contact is null or btrim(p_contact) = '' then null
    else encode(digest(normalize_contact(p_contact), 'sha256'), 'hex')
  end;
$$;

-- is_org_admin: true if current user is owner of org OR has active admin membership.
-- Depends on tables created below; declared here first, re-created after tables exist.
create or replace function is_org_admin(p_org_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select false;  -- stub, replaced after tables exist
$$;

-- =============================================
-- 1. ENUMS
-- =============================================

do $$ begin
  create type org_type as enum ('club', 'coach');
exception when duplicate_object then null; end $$;

do $$ begin
  create type membership_role as enum ('member', 'student', 'admin', 'external');
exception when duplicate_object then null; end $$;

do $$ begin
  create type membership_status as enum (
    'pending', 'active', 'inactive', 'banned', 'rejected', 'expired', 'pending_payment'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type membership_visibility as enum ('full', 'stats_only', 'hidden');
exception when duplicate_object then null; end $$;

-- =============================================
-- 2. organizations (unifies clubs + coaches)
-- =============================================

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  type org_type not null,
  name text not null,
  description text,
  logo_url text,
  city text,
  country text,
  owner_user_id uuid references auth.users(id) on delete restrict,
  plan text default 'free',
  auto_approve_members boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_org_owner on organizations(owner_user_id);
create index if not exists idx_org_type  on organizations(type);

drop trigger if exists trg_organizations_updated_at on organizations;
create trigger trg_organizations_updated_at
before update on organizations for each row execute function set_updated_at();

-- =============================================
-- 3. players (global person entity)
-- =============================================

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  display_name text not null,
  avatar_url text,
  contact_hash text,
  birth_year int,
  gender text check (gender in ('male','female','other')),
  country text,
  merged_into uuid references players(id) on delete set null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_players_contact
  on players(contact_hash)
  where contact_hash is not null and is_deleted = false;
create index if not exists idx_players_user on players(user_id);

drop trigger if exists trg_players_updated_at on players;
create trigger trg_players_updated_at
before update on players for each row execute function set_updated_at();

-- =============================================
-- 4. org_memberships
-- =============================================

create table if not exists org_memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  role membership_role not null default 'member',
  status membership_status not null default 'pending',
  visibility membership_visibility not null default 'full',
  is_primary boolean not null default false,
  invited_by uuid references auth.users(id),
  review_note text,
  joined_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, player_id)
);

create index if not exists idx_memberships_org    on org_memberships(org_id);
create index if not exists idx_memberships_player on org_memberships(player_id);
create index if not exists idx_memberships_status on org_memberships(status);
create unique index if not exists idx_memberships_primary
  on org_memberships(player_id) where is_primary = true;

drop trigger if exists trg_memberships_updated_at on org_memberships;
create trigger trg_memberships_updated_at
before update on org_memberships for each row execute function set_updated_at();

-- =============================================
-- 5. org_invites
-- =============================================

create table if not exists org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  token text unique not null
    default replace(translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_'), '=', ''),
  contact_email text,
  contact_phone text,
  contact_hash text not null,
  player_id uuid references players(id),
  role membership_role not null default 'member',
  message text,
  invited_by uuid not null references auth.users(id),
  status text not null default 'pending'
    check (status in ('pending','accepted','rejected','expired','revoked')),
  expires_at timestamptz not null default (now() + interval '30 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_invites_token   on org_invites(token);
create index if not exists idx_invites_org     on org_invites(org_id);
create index if not exists idx_invites_contact on org_invites(contact_hash);

-- =============================================
-- 6. tournaments.org_id (nullable during migration; set NOT NULL after data migration)
-- =============================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'tournaments' and column_name = 'org_id'
  ) then
    alter table tournaments add column org_id uuid references organizations(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_tournaments_org on tournaments(org_id);

-- =============================================
-- 7. entry_members.player_id
-- =============================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'entry_members' and column_name = 'player_id'
  ) then
    alter table entry_members add column player_id uuid references players(id) on delete set null;
  end if;
end $$;

create index if not exists idx_entry_members_player on entry_members(player_id);

-- =============================================
-- 8. Re-create is_org_admin now that tables exist
-- =============================================

create or replace function is_org_admin(p_org_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from organizations o
    where o.id = p_org_id and o.owner_user_id = auth.uid()
  ) or exists (
    select 1 from org_memberships m
    join players p on p.id = m.player_id
    where m.org_id = p_org_id
      and m.role = 'admin'
      and m.status = 'active'
      and p.user_id = auth.uid()
  );
$$;

grant execute on function is_org_admin(uuid) to authenticated;
grant execute on function normalize_contact(text) to authenticated;
grant execute on function hash_contact(text) to authenticated;

-- =============================================
-- 9. DATA MIGRATION
-- =============================================

do $$
declare
  user_rec record;
  new_org_id uuid;
begin
  -- 9.1 clubs → organizations
  -- Only migrate clubs that are currently usable ('approved' or 'active').
  -- Slug is generated since clubs table has no slug column.
  insert into organizations (id, slug, type, name, city, owner_user_id, is_active, created_at)
  select
    c.id,
    'club-' || substring(c.id::text, 1, 8),
    'club'::org_type,
    c.name,
    c.city,
    c.owner_id,
    c.status in ('active','approved'),
    c.created_at
  from clubs c
  where c.status in ('active','approved')
  on conflict (id) do nothing;

  -- 9.2 Personal coach org for every tournament owner without a club org
  for user_rec in
    select
      ta.user_id,
      coalesce(
        nullif(trim(concat_ws(' ', up.first_name, up.last_name)), ''),
        au.email
      ) as display_name
    from tournament_admins ta
    join auth.users au on au.id = ta.user_id
    left join user_profiles up on up.id = ta.user_id
    where ta.role = 'owner'
      and not exists (
        select 1 from organizations o where o.owner_user_id = ta.user_id
      )
    group by ta.user_id, up.first_name, up.last_name, au.email
  loop
    insert into organizations (slug, type, name, owner_user_id)
    values (
      'coach-' || substring(user_rec.user_id::text, 1, 8),
      'coach'::org_type,
      coalesce(user_rec.display_name, 'Coach') || ' (coach)',
      user_rec.user_id
    )
    on conflict (slug) do nothing
    returning id into new_org_id;
  end loop;

  -- 9.3 tournaments.org_id
  -- Prefer existing club_id; fall back to owner's personal coach org.
  update tournaments t
  set org_id = t.club_id
  where t.club_id is not null
    and t.org_id is null
    and exists (select 1 from organizations o where o.id = t.club_id);

  update tournaments t
  set org_id = (
    select o.id from organizations o
    join tournament_admins ta
      on ta.user_id = o.owner_user_id
     and ta.tournament_id = t.id
     and ta.role = 'owner'
    order by o.created_at asc
    limit 1
  )
  where t.org_id is null;

  -- 9.4 Create players from entry_members (distinct by contact_hash)
  insert into players (display_name, contact_hash)
  select distinct on (hash_contact(e.phone_or_email))
    em.member_name,
    hash_contact(e.phone_or_email)
  from entry_members em
  join entries e on e.id = em.entry_id
  where e.phone_or_email is not null
    and btrim(e.phone_or_email) <> ''
    and hash_contact(e.phone_or_email) is not null
    and not exists (
      select 1 from players p
      where p.contact_hash = hash_contact(e.phone_or_email)
        and p.is_deleted = false
    )
  order by hash_contact(e.phone_or_email), em.created_at asc;

  -- 9.5 Link entry_members → players by contact_hash
  update entry_members em
  set player_id = p.id
  from entries e, players p
  where em.entry_id = e.id
    and em.player_id is null
    and e.phone_or_email is not null
    and p.contact_hash = hash_contact(e.phone_or_email)
    and p.is_deleted = false;

  -- 9.6 Sanity checks
  if (select count(*) from tournaments where org_id is null) > 0 then
    raise warning 'Some tournaments have no org_id after migration (orphaned — owner has no organization).';
  end if;
end $$;

-- 9.7 Enforce NOT NULL on tournaments.org_id only if all rows migrated.
-- Kept conditional so partial migrations don't block the whole script.
do $$
begin
  if (select count(*) from tournaments where org_id is null) = 0 then
    begin
      alter table tournaments alter column org_id set not null;
    exception when others then
      raise notice 'Could not set org_id NOT NULL: %', sqlerrm;
    end;
  else
    raise notice 'Skipping NOT NULL on tournaments.org_id: % rows still null',
      (select count(*) from tournaments where org_id is null);
  end if;
end $$;

-- =============================================
-- 10. RLS
-- =============================================

alter table organizations    enable row level security;
alter table players          enable row level security;
alter table org_memberships  enable row level security;
alter table org_invites      enable row level security;

do $$ begin
  drop policy if exists organizations_public_read on organizations;
  drop policy if exists organizations_owner_write on organizations;
  drop policy if exists organizations_superadmin_all on organizations;

  drop policy if exists players_public_read on players;
  drop policy if exists players_self_update on players;
  drop policy if exists players_superadmin_all on players;

  drop policy if exists memberships_visible on org_memberships;
  drop policy if exists memberships_admin_write on org_memberships;
  drop policy if exists memberships_self_insert on org_memberships;

  drop policy if exists invites_admin_read on org_invites;
  drop policy if exists invites_admin_write on org_invites;
end $$;

-- organizations: public can read active orgs; owner & superadmin manage
create policy organizations_public_read on organizations
  for select using (
    is_active = true
    or auth.uid() = owner_user_id
    or is_platform_admin()
  );

create policy organizations_owner_write on organizations
  for all using (auth.uid() = owner_user_id or is_platform_admin())
  with check (auth.uid() = owner_user_id or is_platform_admin());

-- players: public read of non-deleted; user updates own player row
create policy players_public_read on players
  for select using (is_deleted = false);

create policy players_self_update on players
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy players_superadmin_all on players
  for all using (is_platform_admin())
  with check (is_platform_admin());

-- org_memberships: visible to the player themselves, org admins, and superadmins
create policy memberships_visible on org_memberships
  for select using (
    exists (select 1 from players p where p.id = player_id and p.user_id = auth.uid())
    or is_org_admin(org_id)
    or is_platform_admin()
  );

-- org admins & superadmins write; self-join handled by SECURITY DEFINER RPC (M2)
create policy memberships_admin_write on org_memberships
  for all using (is_org_admin(org_id) or is_platform_admin())
  with check (is_org_admin(org_id) or is_platform_admin());

-- org_invites: only org admins & superadmins can read/write directly.
-- Public acceptance happens through SECURITY DEFINER RPC (M2).
create policy invites_admin_read on org_invites
  for select using (is_org_admin(org_id) or is_platform_admin());

create policy invites_admin_write on org_invites
  for all using (is_org_admin(org_id) or is_platform_admin())
  with check (is_org_admin(org_id) or is_platform_admin());

-- =============================================
-- 11. Realtime
-- =============================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'organizations'
  ) then
    alter publication supabase_realtime add table organizations;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'org_memberships'
  ) then
    alter publication supabase_realtime add table org_memberships;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'org_invites'
  ) then
    alter publication supabase_realtime add table org_invites;
  end if;
end $$;
