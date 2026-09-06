-- =============================================
-- P0.2 — Force create_tournament() to require org_id resolution
-- =============================================
--
-- Background: schema.sql defines a 7-arg create_tournament(...) without
-- p_org_id. Migration 20260502_multitenancy_rpc.sql added an 8-arg version
-- with a trailing p_org_id default null. Both signatures co-exist in the DB
-- (CREATE OR REPLACE only replaces matching signatures), and PostgREST may
-- pick either when the frontend calls supabase.rpc('create_tournament', ...).
-- That ambiguity means new tournaments can land with org_id = NULL.
--
-- Fix: drop the legacy 7-arg signature so only the 8-arg version remains.
-- Idempotent.

drop function if exists create_tournament(
  text, text, text, tournament_category, set_format, boolean, doubles_pairing_mode
);

-- Re-state the canonical 8-arg version (identical to 20260502_multitenancy_rpc.sql)
-- so this migration is self-contained and replays cleanly on a fresh DB.
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
    select id into v_org_id from organizations
      where owner_user_id = v_uid order by created_at asc limit 1;
  else
    if not is_org_admin(v_org_id) then
      raise exception 'Forbidden for this organization';
    end if;
  end if;

  if v_org_id is null then
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

grant execute on function create_tournament(
  text, text, text, tournament_category, set_format, boolean, doubles_pairing_mode, uuid
) to authenticated;
