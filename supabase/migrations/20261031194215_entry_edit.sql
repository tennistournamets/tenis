-- =============================================
-- ENTRY EDIT
-- =============================================
-- Organizers (owners and editors) correct an entry in any tournament state:
-- player names, the bracket name and the contact. The number of players stays
-- (pairs are formed and split by the pair editor). A player marked as replaced
-- is a different person: the previous player's ratings and profile link go,
-- matches and results stay with the entry. Safe to re-run.

create or replace function public.update_entry(
  p_entry_id uuid,
  p_members text[],
  p_replace boolean[] default null,
  p_display_name text default null,
  p_phone text default null,
  p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_e entries%rowtype;
  v_names text[] := '{}';
  v_name text;
  v_count integer;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_contact text;
  v_display text;
  v_member record;
  i integer := 0;
begin
  select * into v_e from entries where id = p_entry_id for update;
  if v_e.id is null then
    raise exception 'entryEdit.notFound';
  end if;
  if not is_tournament_admin(v_e.tournament_id) then
    raise exception 'Not allowed';
  end if;

  select count(*) into v_count from entry_members where entry_id = p_entry_id;
  if coalesce(array_length(p_members, 1), 0) <> v_count then
    raise exception 'entryEdit.memberCount';
  end if;
  foreach v_name in array p_members loop
    v_name := regexp_replace(btrim(coalesce(v_name, '')), '\s+', ' ', 'g');
    if v_name = '' then
      raise exception 'entryEdit.nameRequired';
    end if;
    v_names := v_names || v_name;
  end loop;
  perform validate_entry_names(v_e.entry_type, v_names[1], v_names[2], p_display_name);

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'entryEdit.invalidEmail';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9\s\-\(\)]{7,20}$' then
    raise exception 'entryEdit.invalidPhone';
  end if;

  -- The contact columns change only when the contact itself changed.
  if v_phone is distinct from v_e.contact_phone or v_email is distinct from v_e.contact_email then
    if exists (
      select 1 from entries e
      where e.tournament_id = v_e.tournament_id
        and e.id <> v_e.id
        and e.status in ('pending', 'approved', 'waitlisted')
        and ((v_email is not null and e.contact_email = v_email)
          or (v_phone is not null and e.contact_phone is not null
              and regexp_replace(e.contact_phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g')))
    ) then
      raise exception 'Registration already exists for this contact';
    end if;
    v_contact := coalesce(v_email, v_phone,
      case when v_e.phone_or_email like 'admin-entry-%@local.tenis' then v_e.phone_or_email
           else 'admin-entry-' || gen_random_uuid()::text || '@local.tenis' end);
    update entries
       set phone_or_email = v_contact, contact_phone = v_phone, contact_email = v_email
     where id = p_entry_id;
  end if;

  for v_member in
    select id, member_name from entry_members where entry_id = p_entry_id order by member_order
  loop
    i := i + 1;
    if coalesce(p_replace[i], false) then
      delete from entry_member_ratings where member_id = v_member.id;
      update entry_members set member_name = v_names[i], player_id = null where id = v_member.id;
    elsif v_member.member_name is distinct from v_names[i] then
      update entry_members set member_name = v_names[i] where id = v_member.id;
    end if;
  end loop;

  v_display := coalesce(nullif(btrim(coalesce(p_display_name, '')), ''), array_to_string(v_names, ' / '));
  -- Always touched: entry_members is not in Realtime, the entries row is.
  update entries set display_name = v_display, updated_at = now() where id = p_entry_id;

  return jsonb_build_object('id', p_entry_id, 'display_name', v_display);
end;
$$;
revoke execute on function public.update_entry(uuid, text[], boolean[], text, text, text) from public, anon, authenticated;
grant execute on function public.update_entry(uuid, text[], boolean[], text, text, text) to authenticated;
