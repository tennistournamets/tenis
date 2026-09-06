-- Supabase installs pgcrypto into the `extensions` schema, so digest() isn't
-- visible to functions whose search_path is just `public`. Qualify the call
-- via the `extensions` schema explicitly (works both on cloud and local).
create or replace function hash_contact(p_contact text)
returns text
language sql immutable
set search_path = public, extensions
as $$
  select case
    when p_contact is null or btrim(p_contact) = '' then null
    else encode(extensions.digest(normalize_contact(p_contact), 'sha256'), 'hex')
  end;
$$;

grant execute on function hash_contact(text) to authenticated;
