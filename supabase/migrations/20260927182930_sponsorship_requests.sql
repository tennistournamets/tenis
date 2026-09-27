-- =============================================
-- SPONSORSHIP REQUESTS (paid feature, approved by the platform admin)
-- =============================================
-- A sponsor pays the organizer, so sponsorship is a paid feature of the
-- platform. Until payments exist, the tournament owner asks for it and a
-- platform admin approves or rejects. One row per tournament: asking again
-- after a rejection puts the same row back to pending. Written only through
-- the RPCs below; organizers read their tournament's row, platform admins all.

create table if not exists sponsorship_requests (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null unique references tournaments (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  message text check (message is null or char_length(message) <= 500),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table sponsorship_requests enable row level security;

revoke all on table sponsorship_requests from public, anon, authenticated;
grant select on table sponsorship_requests to authenticated;

drop policy if exists sponsorship_requests_select on sponsorship_requests;
create policy sponsorship_requests_select on sponsorship_requests
  for select to authenticated
  using (is_tournament_admin(tournament_id) or is_platform_admin());

-- The owner asks (again). An approved tournament stays approved.
create or replace function request_sponsorship(p_tournament_id uuid, p_message text default null)
returns sponsorship_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row sponsorship_requests;
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from tournament_admins
    where tournament_id = p_tournament_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Not allowed';
  end if;
  if char_length(v_message) > 500 then
    raise exception 'Message is too long';
  end if;

  select * into v_row from sponsorship_requests where tournament_id = p_tournament_id for update;
  if found and v_row.status = 'approved' then
    return v_row;
  end if;

  insert into sponsorship_requests (tournament_id, requested_by, status, message)
  values (p_tournament_id, auth.uid(), 'pending', v_message)
  on conflict (tournament_id) do update
    set requested_by = excluded.requested_by,
        status = 'pending',
        message = excluded.message,
        decided_by = null,
        decided_at = null,
        created_at = case when sponsorship_requests.status = 'rejected' then now() else sponsorship_requests.created_at end,
        updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

-- Platform admin: approve, reject, or put back to pending.
create or replace function decide_sponsorship_request(p_request_id uuid, p_status text)
returns sponsorship_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row sponsorship_requests;
begin
  if not is_platform_admin() then
    raise exception 'Platform admin required';
  end if;
  if p_status is null or p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'Invalid sponsorship status';
  end if;

  update sponsorship_requests
     set status = p_status,
         decided_by = case when p_status = 'pending' then null else auth.uid() end,
         decided_at = case when p_status = 'pending' then null else now() end,
         updated_at = now()
   where id = p_request_id
  returning * into v_row;
  if not found then
    raise exception 'Sponsorship request not found';
  end if;
  return v_row;
end;
$$;

-- Platform admin table: who asked, for which tournament, and where it stands.
-- The owner is the tournament's current (earliest) owner, else the requester.
create or replace function list_sponsorship_requests()
returns table (
  id uuid,
  tournament_id uuid,
  tournament_name text,
  tournament_slug text,
  tournament_status text,
  owner_name text,
  owner_email text,
  status text,
  message text,
  created_at timestamptz,
  updated_at timestamptz,
  decided_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'Platform admin required';
  end if;

  return query
  select r.id, r.tournament_id, t.name, t.slug, t.status::text,
         p.display_name, u.email::text,
         r.status, r.message, r.created_at, r.updated_at, r.decided_at
    from sponsorship_requests r
    join tournaments t on t.id = r.tournament_id
    left join lateral (
      select ta.user_id from tournament_admins ta
       where ta.tournament_id = r.tournament_id and ta.role = 'owner'
       order by ta.created_at, ta.id
       limit 1
    ) o on true
    left join auth.users u on u.id = coalesce(o.user_id, r.requested_by)
    left join players p on p.user_id = u.id and not p.is_deleted
   order by (r.status = 'pending') desc, r.updated_at desc;
end;
$$;

-- Public pages show sponsors only for an approved tournament; nothing else leaks.
create or replace function is_sponsorship_approved(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from sponsorship_requests
    where tournament_id = p_tournament_id and status = 'approved'
  );
$$;

revoke execute on function request_sponsorship(uuid, text) from public, anon;
revoke execute on function decide_sponsorship_request(uuid, text) from public, anon;
revoke execute on function list_sponsorship_requests() from public, anon;
revoke execute on function is_sponsorship_approved(uuid) from public;
grant execute on function request_sponsorship(uuid, text) to authenticated;
grant execute on function decide_sponsorship_request(uuid, text) to authenticated;
grant execute on function list_sponsorship_requests() to authenticated;
grant execute on function is_sponsorship_approved(uuid) to anon, authenticated;
