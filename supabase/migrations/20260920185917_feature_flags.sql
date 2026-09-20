-- Platform feature flags managed by the super-admin (platform_admins).
-- Sports are gated by `sport.<enum>` keys: a missing or disabled key hides the sport
-- from the create wizard and create_tournament() rejects it. Existing tournaments of a
-- disabled sport stay readable and manageable. Seed: tennis & padel on, football off.
-- Safe to re-run: table/policies/functions are replaced, the seed never overrides admin choices.

-- =============================================
-- FEATURE FLAGS (platform-wide toggles, super-admin managed)
-- =============================================
-- Keys are dotted namespaces. Sports use `sport.<enum value>`; a sport with no
-- row (or enabled=false) is hidden from the create wizard and rejected by
-- create_tournament(). Existing tournaments of a disabled sport stay readable.

create table if not exists feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table feature_flags enable row level security;

do $$ begin
  drop policy if exists feature_flags_select_all on feature_flags;
  drop policy if exists feature_flags_write_platform_admin on feature_flags;
end $$;

-- Everyone (incl. anon) may read flags: the UI needs them before/without login.
create policy feature_flags_select_all on feature_flags
  for select to anon, authenticated using (true);

create policy feature_flags_write_platform_admin on feature_flags
  for all to authenticated using (is_platform_admin()) with check (is_platform_admin());

-- Seed: tennis & padel on, football hidden. Idempotent — never overrides admin choices.
insert into feature_flags (key, enabled, description) values
  ('sport.tennis',   true,  'Tennis available in the create wizard'),
  ('sport.padel',    true,  'Padel available in the create wizard'),
  ('sport.football', false, 'Football available in the create wizard')
on conflict (key) do nothing;

create or replace function is_feature_enabled(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select enabled from feature_flags where key = p_key), false);
$$;

create or replace function set_feature_flag(p_key text, p_enabled boolean, p_description text default null)
returns feature_flags
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row feature_flags;
begin
  if not is_platform_admin() then
    raise exception 'Platform admin required';
  end if;
  if p_key is null or btrim(p_key) = '' then
    raise exception 'Flag key required';
  end if;

  insert into feature_flags (key, enabled, description, updated_at, updated_by)
  values (btrim(p_key), coalesce(p_enabled, false), p_description, now(), auth.uid())
  on conflict (key) do update
    set enabled = excluded.enabled,
        description = coalesce(excluded.description, feature_flags.description),
        updated_at = now(),
        updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function set_feature_flag(text, boolean, text) from public, anon;
grant execute on function is_feature_enabled(text) to anon, authenticated;
grant execute on function set_feature_flag(text, boolean, text) to authenticated;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feature_flags'
  ) then
    alter publication supabase_realtime add table feature_flags;
  end if;
end $$;

-- create_tournament() now refuses a sport whose flag is off.
create or replace function create_tournament(
  p_name text,
  p_slug text,
  p_description text default null,
  p_sport sport default 'tennis',
  p_format tournament_format default 'single_elimination',
  p_category tournament_category default 'singles',
  p_set_format set_format default 'best_of_3',
  p_is_public boolean default true,
  p_doubles_pairing_mode doubles_pairing_mode default null,
  p_format_config jsonb default '{}'::jsonb,
  p_scoring_config jsonb default '{}'::jsonb,
  p_contact_phone text default null,
  p_contact_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_uid uuid := auth.uid();
  v_category tournament_category := p_category;
  v_set_format set_format;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  -- Sport must be enabled via feature flag (see FEATURE FLAGS section)
  if not is_feature_enabled('sport.' || p_sport::text) then
    raise exception 'Sport is disabled: %', p_sport using errcode = 'P0403';
  end if;

  -- Sport-forced categories: padel is always doubles;
  -- football sides are single team entities (one entry per side)
  if p_sport = 'padel' then
    v_category := 'doubles';
  elsif p_sport = 'football' then
    v_category := 'singles';
  end if;

  -- set_format only meaningful for sets-family sports (tennis/padel)
  if p_sport in ('tennis', 'padel') then
    v_set_format := coalesce(p_set_format, 'best_of_3');
  else
    v_set_format := null;
  end if;

  insert into tournaments (
    name, slug, description, sport, format, category, set_format, status,
    is_public, doubles_pairing_mode, format_config, scoring_config,
    contact_phone, contact_email, created_by
  )
  values (
    p_name,
    p_slug,
    p_description,
    p_sport,
    p_format,
    v_category,
    v_set_format,
    'registration_open',
    p_is_public,
    case when v_category = 'doubles' then coalesce(p_doubles_pairing_mode, 'pre_agreed') else null end,
    coalesce(p_format_config, '{}'::jsonb),
    coalesce(p_scoring_config, '{}'::jsonb),
    nullif(btrim(coalesce(p_contact_phone, '')), ''),
    nullif(btrim(coalesce(p_contact_email, '')), ''),
    v_uid
  )
  returning id into v_id;

  insert into tournament_admins (tournament_id, user_id, role)
  values (v_id, v_uid, 'owner');

  return v_id;
end;
$$;

notify pgrst, 'reload schema';
