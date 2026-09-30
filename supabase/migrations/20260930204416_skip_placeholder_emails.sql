-- Entries added by the admin form carry a placeholder contact
-- ("admin-entry-<uuid>@local.tenis"). It looks like an email, so participant
-- notifications were queued for it and bounced. It is not an address.
create or replace function public.entry_email(p_contact_email text, p_phone_or_email text)
returns text
language sql
immutable
set search_path = public
as $$
  select address
  from (select coalesce(
          nullif(btrim(p_contact_email), ''),
          case when p_phone_or_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then lower(btrim(p_phone_or_email)) end
        ) as address) contact
  where address not ilike 'admin-entry-%@local.tenis';
$$;

revoke execute on function public.entry_email(text, text) from public, anon, authenticated;
