-- =============================================
-- PARTICIPANT IMPORT: many manual entries at once
-- =============================================
-- The AI import (and the "tournament from text" wizard) add a whole list of
-- participants the organizer has checked in a preview. Each row goes through
-- add_manual_entry(), so names, contacts, capacity and locks are checked
-- exactly as for one manual entry; a failing row is reported and the others
-- are still added. Participants with an email get the usual "registration
-- approved" email only when the organizer asks for it (p_notify): without it
-- the rows are saved quietly. Safe to re-run.

create or replace function public.entries_queue_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
  -- add_manual_entries(p_notify => false) saves an imported list without emails.
  if coalesce(current_setting('bracketa.quiet_entries', true), '') = 'on' then return null; end if;
  if entry_email(new.contact_email, new.phone_or_email) is null then return null; end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return null; end if;
  v_kind := case new.status
    when 'pending' then case when tg_op = 'INSERT' then 'registration_received' end
    when 'waitlisted' then 'registration_waitlisted'
    when 'approved' then 'registration_approved'
    when 'rejected' then 'registration_rejected'
  end;
  if v_kind is null then return null; end if;
  insert into notification_outbox (kind, tournament_id, entry_id)
  values (v_kind, new.tournament_id, new.id)
  on conflict do nothing;
  return null;
end;
$$;
revoke execute on function public.entries_queue_notification() from public, anon, authenticated;

-- p_entries: [{ "member_one", "member_two"?, "display_name"?, "contact"? }, ...], at most 128.
-- Returns one result per row, in order: { index, ok, id?, status?, error? }.
create or replace function public.add_manual_entries(
  p_tournament_id uuid,
  p_entries jsonb,
  p_status registration_status default 'approved',
  p_notify boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_index integer := 0;
  v_added jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'serverErrors.importEmpty';
  end if;
  if jsonb_array_length(p_entries) > 128 then
    raise exception 'serverErrors.importTooMany';
  end if;

  if not coalesce(p_notify, false) then
    perform set_config('bracketa.quiet_entries', 'on', true);
  end if;

  for v_row in select value from jsonb_array_elements(p_entries) loop
    begin
      if jsonb_typeof(v_row) <> 'object' then
        raise exception 'serverErrors.importBadRow';
      end if;
      v_added := add_manual_entry(
        p_tournament_id,
        v_row->>'member_one',
        v_row->>'member_two',
        v_row->>'display_name',
        v_row->>'contact',
        p_status
      );
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'ok', true, 'id', v_added->'id', 'status', v_added->'status'));
    exception when others then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'ok', false, 'error', sqlerrm));
    end;
    v_index := v_index + 1;
  end loop;

  perform set_config('bracketa.quiet_entries', '', true);
  return v_results;
end;
$$;
revoke execute on function public.add_manual_entries(uuid, jsonb, registration_status, boolean) from public, anon;
grant execute on function public.add_manual_entries(uuid, jsonb, registration_status, boolean) to authenticated;

notify pgrst, 'reload schema';
