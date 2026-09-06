-- Step 2, current multi-sport schema after 1b. Preserves all stored data.
begin;

drop policy if exists entries_public_or_admin_select on entries;
create policy entries_public_or_admin_select on entries
for select
to anon, authenticated
using (
  is_tournament_admin(tournament_id)
  or (
    status = 'approved'
    and exists (
      select 1 from tournaments t where t.id = entries.tournament_id
        and (t.is_public or can_live_score(t.id))
    )
  )
);

drop policy if exists entry_members_public_or_admin_select on entry_members;
create policy entry_members_public_or_admin_select on entry_members
for select
to anon, authenticated
using (
  -- Inherit the parent entry's visibility, including its approval status.
  exists (select 1 from entries e where e.id = entry_members.entry_id)
);

-- Participant privacy: the public entry projection has no contact column.
-- Existing UI queries already select named columns, including INSERT RETURNING id.
-- Server registration/pairing functions retain their owner-level access.
revoke select on public.entries from public, anon, authenticated;
do $$
declare
  v_columns text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_columns
  from pg_attribute where attrelid = 'public.entries'::regclass
    and attnum > 0 and not attisdropped;
  execute format('revoke select (%s) on public.entries from public, anon, authenticated', v_columns);
end;
$$;
grant select (id, tournament_id, entry_type, display_name, status, seed_order, created_at, updated_at)
  on public.entries to anon, authenticated;

-- A profile belongs to its Auth user. Unlinked, merged and deleted records
-- are maintained by trusted server code and are never claimable by a client.
alter table public.players enable row level security;
drop policy if exists players_select_own on public.players;
create policy players_select_own on public.players for select to authenticated
using ((select auth.uid()) = user_id and not is_deleted and merged_into is null);
drop policy if exists players_insert_own on public.players;
create policy players_insert_own on public.players for insert to authenticated
with check ((select auth.uid()) = user_id and not is_deleted and merged_into is null);
drop policy if exists players_update_own on public.players;
create policy players_update_own on public.players for update to authenticated
using ((select auth.uid()) = user_id and not is_deleted and merged_into is null)
with check ((select auth.uid()) = user_id and not is_deleted and merged_into is null);

revoke all privileges on public.players from public, anon, authenticated;
do $$
declare
  v_columns text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_columns
  from pg_attribute where attrelid = 'public.players'::regclass
    and attnum > 0 and not attisdropped;
  execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.players from public, anon, authenticated',
    v_columns, v_columns, v_columns, v_columns);
end;
$$;
grant select on public.players to authenticated;
grant insert (user_id, display_name, avatar_url, birth_year, gender, country) on public.players to authenticated;
grant update (display_name, avatar_url, birth_year, gender, country) on public.players to authenticated;

commit;
