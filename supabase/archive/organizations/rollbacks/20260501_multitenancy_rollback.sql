-- =============================================
-- M1 — Rollback for 20260501_multitenancy.sql
-- =============================================
-- Drops all new tables, columns, types, and helper functions introduced in M1.
-- Idempotent.

-- Drop realtime entries (ignore errors if not published)
do $$ begin
  alter publication supabase_realtime drop table org_invites;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime drop table org_memberships;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime drop table organizations;
exception when others then null; end $$;

-- Drop columns added to existing tables
alter table if exists entry_members drop column if exists player_id;
alter table if exists tournaments   drop column if exists org_id;

-- Drop new tables
drop table if exists org_invites     cascade;
drop table if exists org_memberships cascade;
drop table if exists players         cascade;
drop table if exists organizations   cascade;

-- Drop enums
drop type if exists membership_visibility cascade;
drop type if exists membership_status     cascade;
drop type if exists membership_role       cascade;
drop type if exists org_type              cascade;

-- Drop helper functions
drop function if exists is_org_admin(uuid) cascade;
drop function if exists hash_contact(text) cascade;
drop function if exists normalize_contact(text) cascade;
