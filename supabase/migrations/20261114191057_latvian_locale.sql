-- ---------------------------------------------------------------------------
-- Latvian interface (20261114191057_latvian_locale)
-- Participant emails can be sent in Latvian: entries accept notify_locale 'lv', and
-- request_locale() reads 'lv' from the app's x-bracketa-locale header or Accept-Language.
-- Same signature and grants, safe to re-run. Note: 20260926200333 re-adds the ru/en/lt check,
-- so replaying the whole chain over entries that already have 'lv' stops at that file.

alter table public.entries drop constraint if exists entries_notify_locale_check;
alter table public.entries add constraint entries_notify_locale_check check (notify_locale is null or notify_locale in ('ru', 'en', 'lt', 'lv'));

create or replace function public.request_locale()
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_headers jsonb;
  v_value text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    return null;
  end;
  v_value := lower(left(btrim(coalesce(v_headers->>'x-bracketa-locale', '')), 2));
  if v_value in ('ru', 'en', 'lt', 'lv') then return v_value; end if;
  v_value := lower(left(btrim(coalesce(v_headers->>'accept-language', '')), 2));
  if v_value in ('ru', 'en', 'lt', 'lv') then return v_value; end if;
  return null;
end;
$$;

revoke execute on function public.request_locale() from public, anon, authenticated;
