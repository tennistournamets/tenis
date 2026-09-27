-- =============================================
-- SPONSORSHIP CONTENT: sponsors, places and images
-- =============================================
-- What an approved tournament shows: its sponsors and what sits in each ad
-- place, one JSON document per tournament (shape: src/lib/sponsorship.js),
-- written only through save_sponsorship() with a revision check. Images live in
-- the public Storage bucket `sponsor-assets` under `<tournament id>/`; only the
-- tournament's organizers may upload or delete them, and only while
-- sponsorship is approved and switched on for the platform.

-- Organizer of an approved tournament, with the platform feature on.
create or replace function can_manage_sponsorship(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_tournament_id is not null
     and is_tournament_admin(p_tournament_id)
     and is_sponsorship_approved(p_tournament_id)
     and is_feature_enabled('feature.sponsorship');
$$;

create table if not exists tournament_sponsorship (
  tournament_id uuid primary key references tournaments (id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  revision integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table tournament_sponsorship enable row level security;

revoke all on table tournament_sponsorship from public, anon, authenticated;
grant select on table tournament_sponsorship to anon, authenticated;

-- Spectators read it while the tournament itself is readable to them (tournament
-- RLS) and sponsorship is approved and on; organizers always read their own.
drop policy if exists tournament_sponsorship_select on tournament_sponsorship;
create policy tournament_sponsorship_select on tournament_sponsorship
  for select to anon, authenticated
  using (
    exists (select 1 from tournaments t where t.id = tournament_sponsorship.tournament_id)
    and (
      is_tournament_admin(tournament_sponsorship.tournament_id)
      or (is_sponsorship_approved(tournament_sponsorship.tournament_id) and is_feature_enabled('feature.sponsorship'))
    )
  );

-- An image reference in the config: a file of this tournament in the bucket,
-- or one of the bundled demo pictures.
create or replace function sponsor_asset_ref_ok(p_ref jsonb, p_tournament_id uuid)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_ref is null
      or jsonb_typeof(p_ref) = 'null'
      or (jsonb_typeof(p_ref) = 'object' and (
        coalesce((p_ref ->> 'path') ~ ('^' || p_tournament_id::text || '/[A-Za-z0-9_-]+\.(webp|png|jpg|jpeg|gif)$'), false)
        or coalesce((p_ref ->> 'url') ~ '^/sponsor-demo/[a-z0-9-]+\.svg$', false)
      ));
$$;

create or replace function save_sponsorship(p_tournament_id uuid, p_config jsonb, p_expected_revision integer)
returns tournament_sponsorship
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row tournament_sponsorship;
  v_banners jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not can_manage_sponsorship(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object'
     or jsonb_typeof(coalesce(p_config -> 'sponsors', '[]')) <> 'array'
     or jsonb_typeof(coalesce(p_config -> 'slots', '{}')) <> 'object' then
    raise exception 'Invalid sponsorship';
  end if;
  if octet_length(p_config::text) > 200000 or jsonb_array_length(coalesce(p_config -> 'sponsors', '[]')) > 50 then
    raise exception 'Sponsorship is too large';
  end if;

  -- Every banner of every place, flattened.
  select coalesce(jsonb_agg(b), '[]') into v_banners
    from jsonb_each(coalesce(p_config -> 'slots', '{}')) s(key, value),
         jsonb_array_elements(case when jsonb_typeof(s.value -> 'banners') = 'array' then s.value -> 'banners' else '[]' end) b;
  if jsonb_array_length(v_banners) > 60 then
    raise exception 'Sponsorship is too large';
  end if;

  -- Links leave the page only as http(s).
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_config -> 'sponsors', '[]') || v_banners) item
     where coalesce(item ->> 'url', '') <> '' and (item ->> 'url') !~* '^https?://[^\s]+$'
  ) then
    raise exception 'Invalid sponsor link';
  end if;

  -- Images: only this tournament's files (or the demo set).
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_config -> 'sponsors', '[]')) s
     where not sponsor_asset_ref_ok(s -> 'logo', p_tournament_id) or not sponsor_asset_ref_ok(s -> 'logoDark', p_tournament_id)
  ) or exists (
    select 1 from jsonb_array_elements(v_banners) b
     where not sponsor_asset_ref_ok(b -> 'image', p_tournament_id) or not sponsor_asset_ref_ok(b -> 'imageMobile', p_tournament_id)
  ) then
    raise exception 'Invalid sponsor image';
  end if;

  if coalesce(p_expected_revision, 0) = 0 then
    insert into tournament_sponsorship (tournament_id, config, revision, updated_at, updated_by)
    values (p_tournament_id, p_config, 1, now(), auth.uid())
    on conflict (tournament_id) do nothing
    returning * into v_row;
  else
    update tournament_sponsorship
       set config = p_config, revision = revision + 1, updated_at = now(), updated_by = auth.uid()
     where tournament_id = p_tournament_id and revision = p_expected_revision
    returning * into v_row;
  end if;
  if v_row.tournament_id is null then
    raise exception 'Sponsorship changed';
  end if;
  return v_row;
end;
$$;

revoke execute on function can_manage_sponsorship(uuid) from public;
revoke execute on function sponsor_asset_ref_ok(jsonb, uuid) from public, anon, authenticated;
revoke execute on function save_sponsorship(uuid, jsonb, integer) from public, anon;
grant execute on function can_manage_sponsorship(uuid) to anon, authenticated;
grant execute on function save_sponsorship(uuid, jsonb, integer) to authenticated;

-- Storage: public bucket (served by the CDN), images only, 2 MB per file.
-- SVG is refused: the browser rasterizes it before upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sponsor-assets', 'sponsor-assets', true, 2097152, array['image/webp', 'image/png', 'image/jpeg', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The tournament a file belongs to: its first folder, when that is a UUID.
create or replace function sponsor_asset_tournament(p_name text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end;
$$;
grant execute on function sponsor_asset_tournament(text) to anon, authenticated;

drop policy if exists sponsor_assets_select on storage.objects;
drop policy if exists sponsor_assets_insert on storage.objects;
drop policy if exists sponsor_assets_delete on storage.objects;

-- Listing/removal need a row the organizer may see; public reading goes via the CDN URL.
create policy sponsor_assets_select on storage.objects
  for select to authenticated
  using (bucket_id = 'sponsor-assets' and public.can_manage_sponsorship(public.sponsor_asset_tournament(name)));

create policy sponsor_assets_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sponsor-assets' and public.can_manage_sponsorship(public.sponsor_asset_tournament(name)));

create policy sponsor_assets_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'sponsor-assets' and public.can_manage_sponsorship(public.sponsor_asset_tournament(name)));
