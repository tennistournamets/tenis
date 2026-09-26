-- Email notifications to participants: registration received / waitlisted / approved /
-- rejected, and a reminder 30 minutes before a match with a fixed published time.
-- Rows are queued by triggers; api/notifications.js (service role) claims and sends them.
-- The outbox stores no address: the email is read from the entry at claim time, and
-- deleting an entry or tournament removes its queued notifications.

-- Language of the participant's emails, taken from the registration request.
alter table public.entries add column if not exists notify_locale text;
alter table public.entries drop constraint if exists entries_notify_locale_check;
alter table public.entries add constraint entries_notify_locale_check check (notify_locale is null or notify_locale in ('ru', 'en', 'lt'));

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('registration_received', 'registration_waitlisted', 'registration_approved', 'registration_rejected', 'match_reminder')),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  entry_id uuid not null references entries (id) on delete cascade,
  match_id uuid references matches (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  send_after timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  -- One email of each kind per entry (and per match for reminders).
  unique nulls not distinct (kind, entry_id, match_id)
);
create index if not exists idx_notification_outbox_due on public.notification_outbox (send_after) where status = 'pending';
create index if not exists idx_notification_outbox_entry on public.notification_outbox (entry_id);
alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from public, anon, authenticated;

-- Address of an entry: the dedicated field, or a legacy combined contact that is an email.
create or replace function public.entry_email(p_contact_email text, p_phone_or_email text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(
    nullif(btrim(p_contact_email), ''),
    case when p_phone_or_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then lower(btrim(p_phone_or_email)) end
  );
$$;

-- Language of the current API request: the app's x-bracketa-locale header, else Accept-Language.
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
  if v_value in ('ru', 'en', 'lt') then return v_value; end if;
  v_value := lower(left(btrim(coalesce(v_headers->>'accept-language', '')), 2));
  if v_value in ('ru', 'en', 'lt') then return v_value; end if;
  return null;
end;
$$;

create or replace function public.entries_set_notify_locale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.notify_locale := coalesce(new.notify_locale, request_locale());
  return new;
end;
$$;

drop trigger if exists trg_entries_notify_locale on public.entries;
create trigger trg_entries_notify_locale before insert on public.entries
for each row execute function public.entries_set_notify_locale();

create or replace function public.entries_queue_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
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

drop trigger if exists trg_entries_queue_notification on public.entries;
create trigger trg_entries_queue_notification after insert or update of status on public.entries
for each row execute function public.entries_queue_notification();

-- Reminders for matches starting within 35 minutes (the sender runs every minute).
-- Only fixed published times; both sides must be known and approved with an email.
create or replace function public.enqueue_match_reminders(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into notification_outbox (kind, tournament_id, entry_id, match_id)
  select 'match_reminder', m.tournament_id, e.id, m.id
  from match_schedule s
  join matches m on m.id = s.match_id
  join tournaments t on t.id = m.tournament_id and t.status = 'in_progress'
  cross join lateral (values (m.side_a_entry_id), (m.side_b_entry_id)) side(entry_id)
  join entries e on e.id = side.entry_id and e.status = 'approved'
  where s.state = 'published'
    and s.time_kind = 'fixed'
    and s.scheduled_at > p_now
    and s.scheduled_at <= p_now + interval '35 minutes'
    and m.status <> 'finished'
    and m.side_a_entry_id is not null
    and m.side_b_entry_id is not null
    and entry_email(e.contact_email, e.phone_or_email) is not null
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Cheap check for the scheduler: call the sender only when there is work.
create or replace function public.notifications_due(p_now timestamptz default now())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from notification_outbox where status = 'pending' and send_after <= p_now)
    or exists (select 1 from notification_outbox where status = 'sending' and claimed_at < p_now - interval '10 minutes')
    or exists (
      select 1 from match_schedule s
      join matches m on m.id = s.match_id and m.status <> 'finished'
      join tournaments t on t.id = m.tournament_id and t.status = 'in_progress'
      where s.state = 'published' and s.time_kind = 'fixed'
        and s.scheduled_at > p_now and s.scheduled_at <= p_now + interval '35 minutes'
        and not exists (select 1 from notification_outbox o where o.kind = 'match_reminder' and o.match_id = m.id)
    );
$$;

-- Hands out due notifications with everything the email needs, marked as "sending".
drop function if exists public.claim_notifications(integer);
create function public.claim_notifications(p_limit integer default 20)
returns table (
  id uuid,
  kind text,
  locale text,
  recipient text,
  entry_name text,
  tournament_name text,
  tournament_slug text,
  time_zone text,
  scheduled_at timestamptz,
  court_name text,
  opponent_name text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform enqueue_match_reminders(now());
  -- A sender that died mid-batch leaves rows in "sending"; hand them out again.
  update notification_outbox o set status = 'pending'
  where o.status = 'sending' and o.claimed_at < now() - interval '10 minutes';
  -- A reminder whose match is over, or no longer has an address, is not sent.
  update notification_outbox o set status = 'skipped'
  where o.status = 'pending' and o.kind = 'match_reminder'
    and exists (select 1 from matches m where m.id = o.match_id and m.status = 'finished');
  update notification_outbox o set status = 'skipped'
  where o.status = 'pending'
    and exists (select 1 from entries e where e.id = o.entry_id and entry_email(e.contact_email, e.phone_or_email) is null);

  return query
  with picked as (
    select o.id from notification_outbox o
    where o.status = 'pending' and o.send_after <= now()
    order by o.send_after, o.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ), marked as (
    update notification_outbox o
    set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
    from picked where o.id = picked.id
    returning o.*
  )
  select
    mk.id,
    mk.kind,
    coalesce(e.notify_locale, 'lt'),
    entry_email(e.contact_email, e.phone_or_email),
    e.display_name,
    t.name,
    t.slug,
    nullif(t.schedule_config->>'timezone', ''),
    s.scheduled_at,
    c.name,
    opponent.display_name
  from marked mk
  join entries e on e.id = mk.entry_id
  join tournaments t on t.id = mk.tournament_id
  left join matches m on m.id = mk.match_id
  left join match_schedule s on s.match_id = m.id and s.state = 'published'
  left join courts c on c.id = s.court_id
  left join entries opponent on opponent.id = case when m.side_a_entry_id = e.id then m.side_b_entry_id else m.side_a_entry_id end;
end;
$$;

-- Result of one delivery attempt: sent, or back to the queue with a growing delay (5 tries).
create or replace function public.complete_notification(p_id uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update notification_outbox o set
    status = case when p_ok then 'sent' when o.attempts >= 5 then 'failed' else 'pending' end,
    sent_at = case when p_ok then now() end,
    last_error = case when p_ok then null else left(p_error, 500) end,
    send_after = case when p_ok then o.send_after else now() + make_interval(mins => 5 * o.attempts) end,
    claimed_at = null
  where o.id = p_id and o.status = 'sending';
end;
$$;

revoke execute on function public.entry_email(text, text) from public, anon, authenticated;
revoke execute on function public.request_locale() from public, anon, authenticated;
revoke execute on function public.entries_set_notify_locale() from public, anon, authenticated;
revoke execute on function public.entries_queue_notification() from public, anon, authenticated;
revoke execute on function public.enqueue_match_reminders(timestamptz) from public, anon, authenticated;
revoke execute on function public.notifications_due(timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_notifications(integer) from public, anon, authenticated;
revoke execute on function public.complete_notification(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.notifications_due(timestamptz) to service_role;
grant execute on function public.claim_notifications(integer) to service_role;
grant execute on function public.complete_notification(uuid, boolean, text) to service_role;

notify pgrst, 'reload schema';
