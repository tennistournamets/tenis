-- Registration collects a phone AND an email as two separate required fields.
-- `entries.phone_or_email` stays as the legacy single contact and keeps its
-- unique index, so older rows and the admin "add entry" form are unaffected.
-- The two new columns hold the parsed values; a trigger keeps every insert
-- path consistent. Safe to re-run.

alter table entries add column if not exists contact_phone text;
alter table entries add column if not exists contact_email text;

-- Existing rows keep their single contact; it is classified by its shape.
-- Placeholders written by the admin form ("admin-entry-<uuid>@local.tenis")
-- are not real contacts and stay out of the new columns.
update entries
   set contact_email = lower(btrim(phone_or_email))
 where contact_email is null
   and phone_or_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
   and phone_or_email not like 'admin-entry-%@local.tenis';

update entries
   set contact_phone = btrim(phone_or_email)
 where contact_phone is null
   and phone_or_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
   and phone_or_email ~ '^\+?[0-9\s\-\(\)]{7,20}$';

-- Whatever writes an entry (RPC, admin form, manual SQL) ends up with the same
-- normalised columns: email lowercased, blanks turned into nulls.
create or replace function public.entries_fill_contacts()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.contact_phone := nullif(btrim(coalesce(new.contact_phone, '')), '');
  new.contact_email := lower(nullif(btrim(coalesce(new.contact_email, '')), ''));

  if new.contact_email is null
     and new.phone_or_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     and new.phone_or_email not like 'admin-entry-%@local.tenis' then
    new.contact_email := lower(btrim(new.phone_or_email));
  end if;

  if new.contact_phone is null
     and new.phone_or_email ~ '^\+?[0-9\s\-\(\)]{7,20}$' then
    new.contact_phone := btrim(new.phone_or_email);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_entries_fill_contacts on entries;
create trigger trg_entries_fill_contacts
before insert or update of phone_or_email, contact_phone, contact_email on entries
for each row execute function public.entries_fill_contacts();

-- Lookup indexes only. Uniqueness stays on `phone_or_email`: normalising an
-- existing contact (case, punctuation) could collide with another old row, and
-- a unique index would then refuse to be created on a live database.
-- register_entry() rejects duplicates explicitly, across both fields.
create index if not exists idx_entries_active_email
  on entries (tournament_id, contact_email)
  where contact_email is not null and status in ('pending', 'approved', 'waitlisted');

create index if not exists idx_entries_active_phone
  on entries (tournament_id, regexp_replace(contact_phone, '\D', '', 'g'))
  where contact_phone is not null and status in ('pending', 'approved', 'waitlisted');

-- Registration with separate phone and email. The previous signature is
-- replaced rather than overloaded: the first seven parameters keep their names
-- and order, so a caller that still sends one combined contact keeps working
-- and no call becomes ambiguous.
drop function if exists register_entry(text, tournament_category, text, text, text, text, text);
drop function if exists register_entry(text, tournament_category, text, text, text, text, text, text, text);
create function register_entry(
  p_slug text,
  p_entry_type tournament_category,
  p_phone_or_email text default null,
  p_member_one text default null,
  p_member_two text default null,
  p_display_name text default null,
  p_access_token text default null,
  p_phone text default null,
  p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament tournaments;
  v_entry_id uuid;
  v_display_name text;
  v_status registration_status := 'pending';
  v_phone text;
  v_email text;
  v_legacy text;
  v_contact text;
begin
  select *
    into v_tournament
  from tournaments
  where slug = p_slug
  limit 1;

  if v_tournament.id is null then
    raise exception 'Tournament not found';
  end if;

  if v_tournament.is_public is false
     and not (v_tournament.visibility = 'password' and valid_access_token(v_tournament.id, p_access_token)) then
    raise exception 'Tournament is private';
  end if;

  if v_tournament.status <> 'registration_open' then
    raise exception 'Registration is closed';
  end if;

  if v_tournament.registration_deadline is not null and now() >= v_tournament.registration_deadline then
    raise exception 'registration.deadlinePassed';
  end if;

  if v_tournament.registration_capacity is not null
     and registration_occupancy(v_tournament.id, null) >= v_tournament.registration_capacity then
    if v_tournament.waitlist_enabled then
      v_status := 'waitlisted';
    else
      raise exception 'registration.full';
    end if;
  end if;

  if v_tournament.category <> p_entry_type then
    raise exception 'Invalid category for tournament';
  end if;

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

  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_legacy := nullif(btrim(coalesce(p_phone_or_email, '')), '');

  if v_phone is null and v_email is null then
    -- A caller that still sends one combined contact: classify it by shape.
    if v_legacy is null then
      raise exception 'Contact info is required';
    end if;
    if v_legacy ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_email := lower(v_legacy);
    elsif v_legacy ~ '^\+?[0-9\s\-\(\)]{7,20}$' then
      v_phone := v_legacy;
    else
      raise exception 'Invalid phone number or email';
    end if;
  else
    -- Both fields are mandatory once either of them is sent.
    if v_phone is null then
      raise exception 'registration.phoneRequired';
    end if;
    if v_email is null then
      raise exception 'registration.emailRequired';
    end if;
    if v_phone !~ '^\+?[0-9\s\-\(\)]{7,20}$' then
      raise exception 'registration.invalidPhone';
    end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'registration.invalidEmail';
    end if;
  end if;

  -- The legacy column keeps one value: the email when there is one.
  v_contact := coalesce(v_email, v_phone);

  if exists (
    select 1
    from entries e
    where e.tournament_id = v_tournament.id
      and e.status in ('pending', 'approved', 'waitlisted')
      and (
        e.phone_or_email = v_contact
        or (v_email is not null and e.contact_email = v_email)
        or (
          v_phone is not null and e.contact_phone is not null
          and regexp_replace(e.contact_phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g')
        )
      )
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

  insert into entries (
    tournament_id,
    entry_type,
    display_name,
    phone_or_email,
    contact_phone,
    contact_email,
    status
  ) values (
    v_tournament.id,
    p_entry_type,
    v_display_name,
    v_contact,
    v_phone,
    v_email,
    v_status
  )
  returning id into v_entry_id;

  insert into entry_members (entry_id, member_name, member_order)
  values (v_entry_id, p_member_one, 1);

  if p_entry_type = 'doubles' and p_member_two is not null and btrim(p_member_two) <> '' then
    insert into entry_members (entry_id, member_name, member_order)
    values (v_entry_id, p_member_two, 2);
  end if;

  return jsonb_build_object('id', v_entry_id, 'status', v_status);
end;
$$;
revoke execute on function register_entry(text, tournament_category, text, text, text, text, text, text, text) from public;
grant execute on function register_entry(text, tournament_category, text, text, text, text, text, text, text) to anon, authenticated;
