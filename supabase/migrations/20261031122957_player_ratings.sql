-- =============================================
-- PLAYER RATINGS AT REGISTRATION
-- =============================================
-- An organizer may ask players for their rating (tournaments.player_rating:
-- off by default, optional or required). Each player of an entry gives one or
-- more ratings of the kinds used in Lithuania for the sport:
--   tennis: TNL (TenisoNamai level 1.00–8.00), LTS (place in the national
--           ranking, 1 is best);
--   padel:  level letter D…A+ (stored as 1.0–6.0 in steps of 0.5), TNL
--           (TenisoNamai also rates padel), Padelution rating (Elo-like number).
-- Football entries are teams and give none. Ratings are private like the
-- contacts: the table is closed to API roles and organizers read it through
-- get_entry_ratings(). An organizer may put their own value on any kind
-- (set_member_rating); it wins over the player's, which is kept as given.
-- Seeding by rating is done in the browser from these values and saved with
-- set_entry_seed_order(). Pair forming now moves member rows between entries, so a
-- player's ratings follow them into the pair and back out on a split.
-- Safe to re-run.

alter table public.tournaments add column if not exists player_rating text not null default 'off';
alter table public.tournaments drop constraint if exists tournaments_player_rating_ck;
alter table public.tournaments add constraint tournaments_player_rating_ck check (player_rating in ('off', 'optional', 'required'));
grant select (player_rating) on public.tournaments to anon, authenticated;

create table if not exists public.entry_member_ratings (
  member_id uuid not null references public.entry_members (id) on delete cascade,
  rating_type text not null,
  rating_value numeric(7, 2),
  organizer_value numeric(7, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (member_id, rating_type),
  constraint entry_member_ratings_value_ck check (rating_value is not null or organizer_value is not null)
);
alter table public.entry_member_ratings enable row level security;
revoke all on public.entry_member_ratings from public, anon, authenticated;

-- The rating kinds of a sport and their scales (mirrored by src/lib/playerRatings.js).
create or replace function public.player_rating_valid(p_sport sport, p_type text, p_value numeric)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_value is not null and case
    when p_sport in ('tennis', 'padel') and p_type = 'tnl' then p_value between 1 and 8 and p_value = round(p_value, 2)
    when p_sport = 'tennis' and p_type = 'lts' then p_value between 1 and 9999 and p_value = trunc(p_value)
    when p_sport = 'padel' and p_type = 'padel_level' then p_value between 1 and 6 and p_value * 2 = trunc(p_value * 2)
    when p_sport = 'padel' and p_type = 'padelution' then p_value between 0 and 9999 and p_value = trunc(p_value)
    else false
  end;
$$;
revoke execute on function public.player_rating_valid(sport, text, numeric) from public, anon, authenticated;

-- p_ratings: [{ "type": "tnl", "value": 4.25 }, ...], one row per kind.
create or replace function public.save_member_ratings(p_member_id uuid, p_sport sport, p_ratings jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_type text;
  v_value numeric;
  v_count integer := 0;
begin
  if p_ratings is null or p_ratings = 'null'::jsonb then return 0; end if;
  if jsonb_typeof(p_ratings) <> 'array' or jsonb_array_length(p_ratings) > 3 then raise exception 'rating.invalid'; end if;
  for v_row in select * from jsonb_array_elements(p_ratings) loop
    if jsonb_typeof(v_row) <> 'object' or jsonb_typeof(v_row->'value') not in ('number', 'string') then raise exception 'rating.invalid'; end if;
    v_type := v_row->>'type';
    begin
      v_value := replace(btrim(v_row->>'value'), ',', '.')::numeric;
    exception when others then
      raise exception 'rating.invalid';
    end;
    if not player_rating_valid(p_sport, v_type, v_value) then raise exception 'rating.invalid'; end if;
    insert into entry_member_ratings (member_id, rating_type, rating_value) values (p_member_id, v_type, v_value)
    on conflict (member_id, rating_type) do nothing;
    if not found then raise exception 'rating.duplicate'; end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke execute on function public.save_member_ratings(uuid, sport, jsonb) from public, anon, authenticated;

create or replace function public.get_entry_ratings(p_tournament_id uuid)
returns table (entry_id uuid, member_id uuid, member_order integer, rating_type text, rating_value numeric, organizer_value numeric)
language sql
stable
security definer
set search_path = public
as $$
  select em.entry_id, em.id, em.member_order, r.rating_type, r.rating_value, r.organizer_value
  from entry_member_ratings r
  join entry_members em on em.id = r.member_id
  join entries e on e.id = em.entry_id
  where is_tournament_admin(p_tournament_id)
    and e.tournament_id = p_tournament_id
  order by e.created_at, e.id, em.member_order, r.created_at, r.rating_type;
$$;
revoke execute on function public.get_entry_ratings(uuid) from public, anon, authenticated;
grant execute on function public.get_entry_ratings(uuid) to authenticated;

-- The organizer's own value for one kind of one player; null removes it (a
-- kind only the organizer gave disappears, the player's value stays).
create or replace function public.set_member_rating(p_member_id uuid, p_type text, p_value numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_sport sport;
begin
  select t.id, t.sport into v_tournament_id, v_sport
  from entry_members em
  join entries e on e.id = em.entry_id
  join tournaments t on t.id = e.tournament_id
  where em.id = p_member_id;
  if v_tournament_id is null or not is_tournament_admin(v_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if p_value is null then
    delete from entry_member_ratings where member_id = p_member_id and rating_type = p_type and rating_value is null;
    update entry_member_ratings set organizer_value = null, updated_at = now()
    where member_id = p_member_id and rating_type = p_type and organizer_value is not null;
    return;
  end if;
  if not player_rating_valid(v_sport, p_type, p_value) then
    raise exception 'rating.invalid';
  end if;
  insert into entry_member_ratings (member_id, rating_type, organizer_value)
  values (p_member_id, p_type, p_value)
  on conflict (member_id, rating_type) do update set organizer_value = excluded.organizer_value, updated_at = now();
end;
$$;
revoke execute on function public.set_member_rating(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.set_member_rating(uuid, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- Public registration: p_ratings is [[member one ratings], [member two ratings]].
-- Ignored while the tournament does not ask for ratings; "required" needs at
-- least one rating for every named player.
-- ---------------------------------------------------------------------------
drop function if exists public.register_entry(text, tournament_category, text, text, text, text, text, text, text);
create or replace function public.register_entry(
  p_slug text,
  p_entry_type tournament_category,
  p_phone_or_email text default null,
  p_member_one text default null,
  p_member_two text default null,
  p_display_name text default null,
  p_access_token text default null,
  p_phone text default null,
  p_email text default null,
  p_ratings jsonb default null
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
  v_member_one text := btrim(coalesce(p_member_one, ''));
  v_member_two text := nullif(btrim(coalesce(p_member_two, '')), '');
  v_member_ids uuid[] := '{}';
  v_asks_rating boolean;
  v_i integer;
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

  if p_entry_type = 'singles' and v_member_one = '' then
    raise exception 'Single entry requires one participant';
  end if;

  if p_entry_type = 'doubles' then
    if v_member_one = '' then
      raise exception 'Double entry requires at least one participant';
    end if;
    if v_tournament.doubles_pairing_mode <> 'pick_random' and v_member_two is null then
      raise exception 'Double entry requires two participants';
    end if;
  end if;

  perform validate_entry_names(p_entry_type, v_member_one, v_member_two, p_display_name);

  v_asks_rating := v_tournament.player_rating <> 'off' and v_tournament.sport in ('tennis', 'padel');
  if v_asks_rating and p_ratings is not null and p_ratings <> 'null'::jsonb
     and (jsonb_typeof(p_ratings) <> 'array' or jsonb_array_length(p_ratings) > 2) then
    raise exception 'rating.invalid';
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

  if entry_contact_taken(v_tournament.id, v_contact, v_phone, v_email) then
    raise exception 'Registration already exists for this contact';
  end if;

  if p_display_name is not null and btrim(p_display_name) <> '' then
    v_display_name := btrim(p_display_name);
  elsif p_entry_type = 'singles' then
    v_display_name := v_member_one;
  elsif v_member_two is not null then
    v_display_name := v_member_one || ' / ' || v_member_two;
  else
    v_display_name := v_member_one;
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
  values (v_entry_id, v_member_one, 1)
  returning array[id] into v_member_ids;

  if p_entry_type = 'doubles' and v_member_two is not null then
    insert into entry_members (entry_id, member_name, member_order)
    values (v_entry_id, v_member_two, 2)
    returning v_member_ids || id into v_member_ids;
  end if;

  if v_asks_rating then
    for v_i in 1 .. array_length(v_member_ids, 1) loop
      if save_member_ratings(v_member_ids[v_i], v_tournament.sport, p_ratings->(v_i - 1)) = 0
         and v_tournament.player_rating = 'required' then
        raise exception 'rating.required';
      end if;
    end loop;
  end if;

  return jsonb_build_object('id', v_entry_id, 'status', v_status);
end;
$$;
revoke execute on function public.register_entry(text, tournament_category, text, text, text, text, text, text, text, jsonb) from public;
grant execute on function public.register_entry(text, tournament_category, text, text, text, text, text, text, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Pair forming moves the partner's member row (with its ratings and player
-- link) into the first entry instead of copying the name; a split moves it back
-- out into a new entry.
-- ---------------------------------------------------------------------------
create or replace function public.form_random_pairs(p_tournament_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unpaired_ids uuid[];
  v_count integer;
  v_i integer;
  v_entry_a uuid;
  v_entry_b uuid;
  v_name_a text;
  v_name_b text;
  v_pairs_formed integer := 0;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if not exists (
    select 1 from tournaments
    where id = p_tournament_id
      and category = 'doubles'
      and doubles_pairing_mode = 'pick_random'
  ) then
    raise exception 'Tournament is not configured for random pairing';
  end if;

  select array_agg(e.id order by random())
    into v_unpaired_ids
  from entries e
  where e.tournament_id = p_tournament_id
    and e.status = 'approved'
    and e.entry_type = 'doubles'
    and not exists (
      select 1 from entry_members em
      where em.entry_id = e.id and em.member_order = 2
    );

  v_count := coalesce(array_length(v_unpaired_ids, 1), 0);

  if v_count = 0 then
    return 0;
  end if;

  if v_count % 2 <> 0 then
    raise exception 'Odd number of unpaired players (%). Remove or add one before forming pairs.', v_count;
  end if;

  v_i := 1;
  while v_i <= v_count - 1 loop
    v_entry_a := v_unpaired_ids[v_i];
    v_entry_b := v_unpaired_ids[v_i + 1];

    select em.member_name into v_name_a
    from entry_members em
    where em.entry_id = v_entry_a and em.member_order = 1;

    select em.member_name into v_name_b
    from entry_members em
    where em.entry_id = v_entry_b and em.member_order = 1;

    update entry_members
    set entry_id = v_entry_a, member_order = 2
    where entry_id = v_entry_b and member_order = 1;

    update entries
    set display_name = v_name_a || ' / ' || v_name_b
    where id = v_entry_a;

    delete from entry_members where entry_id = v_entry_b;
    delete from entries where id = v_entry_b;

    v_pairs_formed := v_pairs_formed + 1;
    v_i := v_i + 2;
  end loop;

  return v_pairs_formed;
end;
$$;

create or replace function public.form_manual_pairs(
  p_tournament_id uuid,
  p_pairs jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pair jsonb;
  v_entry_a uuid;
  v_entry_b uuid;
  v_name_a text;
  v_name_b text;
  v_pairs_formed integer := 0;
  v_seen uuid[] := '{}';
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if not exists (
    select 1 from tournaments
    where id = p_tournament_id
      and category = 'doubles'
      and doubles_pairing_mode = 'pick_random'
  ) then
    raise exception 'Tournament is not configured for random pairing';
  end if;

  if jsonb_typeof(p_pairs) is distinct from 'array' then
    raise exception 'Pairs must be an array';
  end if;

  -- Validate the entire batch before merging/deleting any entry.
  for v_pair in select * from jsonb_array_elements(p_pairs)
  loop
    if jsonb_typeof(v_pair) is distinct from 'array' then
      raise exception 'Each pair must contain two entry IDs';
    end if;
    if jsonb_array_length(v_pair) <> 2 then
      raise exception 'Each pair must contain two entry IDs';
    end if;
    v_entry_a := (v_pair->>0)::uuid;
    v_entry_b := (v_pair->>1)::uuid;
    if v_entry_a is null or v_entry_b is null or v_entry_a = v_entry_b
       or v_entry_a = any(v_seen) or v_entry_b = any(v_seen) then
      raise exception 'Pairs must contain distinct non-null entries without reuse';
    end if;
    if (select count(*) from entries e
        where e.id in (v_entry_a, v_entry_b) and e.tournament_id = p_tournament_id
          and e.status = 'approved' and e.entry_type = 'doubles'
          and exists (select 1 from entry_members em where em.entry_id = e.id and em.member_order = 1)
          and not exists (select 1 from entry_members em where em.entry_id = e.id and em.member_order = 2)
       ) <> 2 then
      raise exception 'Pairs require approved unpaired entries from this tournament';
    end if;
    v_seen := v_seen || array[v_entry_a, v_entry_b];
  end loop;

  for v_pair in select * from jsonb_array_elements(p_pairs)
  loop
    v_entry_a := (v_pair->>0)::uuid;
    v_entry_b := (v_pair->>1)::uuid;

    if not exists (
      select 1 from entries
      where id = v_entry_a
        and tournament_id = p_tournament_id
        and status = 'approved'
        and not exists (
          select 1 from entry_members em where em.entry_id = v_entry_a and em.member_order = 2
        )
    ) then
      raise exception 'Entry % is not a valid unpaired entry', v_entry_a;
    end if;

    if not exists (
      select 1 from entries
      where id = v_entry_b
        and tournament_id = p_tournament_id
        and status = 'approved'
        and not exists (
          select 1 from entry_members em where em.entry_id = v_entry_b and em.member_order = 2
        )
    ) then
      raise exception 'Entry % is not a valid unpaired entry', v_entry_b;
    end if;

    select em.member_name into v_name_a
    from entry_members em
    where em.entry_id = v_entry_a and em.member_order = 1;

    select em.member_name into v_name_b
    from entry_members em
    where em.entry_id = v_entry_b and em.member_order = 1;

    update entry_members
    set entry_id = v_entry_a, member_order = 2
    where entry_id = v_entry_b and member_order = 1;

    update entries
    set display_name = v_name_a || ' / ' || v_name_b
    where id = v_entry_a;

    delete from entry_members where entry_id = v_entry_b;
    delete from entries where id = v_entry_b;

    v_pairs_formed := v_pairs_formed + 1;
  end loop;

  return v_pairs_formed;
end;
$$;

create or replace function public.split_pairs(
  p_tournament_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry record;
  v_member2_name text;
  v_new_entry_id uuid;
  v_split_count integer := 0;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if not exists (
    select 1 from tournaments
    where id = p_tournament_id
      and category = 'doubles'
      and doubles_pairing_mode = 'pick_random'
  ) then
    raise exception 'Tournament is not configured for random pairing';
  end if;

  if exists (
    select 1 from tournaments
    where id = p_tournament_id
      and status in ('in_progress', 'completed')
  ) then
    raise exception 'Cannot edit pairs while tournament is in progress or completed';
  end if;

  delete from match_sets where match_id in (
    select id from matches where tournament_id = p_tournament_id
  );
  delete from matches where tournament_id = p_tournament_id;

  for v_entry in
    select e.id, e.phone_or_email
    from entries e
    where e.tournament_id = p_tournament_id
      and e.status = 'approved'
      and exists (
        select 1 from entry_members em
        where em.entry_id = e.id and em.member_order = 2
      )
  loop
    select em.member_name into v_member2_name
    from entry_members em
    where em.entry_id = v_entry.id and em.member_order = 2;

    update entries
    set display_name = (
      select em.member_name from entry_members em
      where em.entry_id = v_entry.id and em.member_order = 1
    )
    where id = v_entry.id;

    insert into entries (tournament_id, entry_type, display_name, phone_or_email, status)
    values (p_tournament_id, 'doubles', v_member2_name, 'split-' || gen_random_uuid(), 'approved')
    returning id into v_new_entry_id;

    update entry_members
    set entry_id = v_new_entry_id, member_order = 1
    where entry_id = v_entry.id and member_order = 2;

    v_split_count := v_split_count + 1;
  end loop;

  return v_split_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings and snapshot carry the rating setting.
-- ---------------------------------------------------------------------------
create or replace function update_tournament_settings(p_tournament_id uuid,p_patch jsonb,p_expected_revision integer,p_expected_matches jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_old tournaments%rowtype; v_new tournaments%rowtype; k text; v_category_changed boolean; v_units text[];
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_old from tournaments where id=p_tournament_id for update;
 if v_old.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_old.settings_revision then raise exception 'drafts.conflict'; end if;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Invalid settings'; end if;
 for k in select jsonb_object_keys(p_patch) loop
  if k<>all(array['name','description','category','set_format','scoring_config','doubles_pairing_mode','status','is_public','contact_phone','contact_email','publish_contact',
   'registration_capacity','capacity_public','registration_deadline','entry_fee_mode','entry_fee_minor','entry_fee_currency','entry_fee_unit','waitlist_enabled',
   'schedule_config','visibility','venue_address','venue_lat','venue_lng','player_rating']) then raise exception 'Unsupported settings field'; end if;
 end loop;
 v_new:=jsonb_populate_record(v_old,p_patch);
 -- A finished tournament stays finished: its results and champion are final.
 if v_old.status='completed' and v_new.status is distinct from 'completed' then raise exception 'lifecycle.completedLocked'; end if;
 -- Starting plays the generated structure: it must hold exactly the approved
 -- field (an approval or rejection after the draw leaves it stale).
 if v_new.status='in_progress' and v_old.status is distinct from 'in_progress' and tournament_roster_stale(p_tournament_id) then
  raise exception 'lifecycle.rosterStale';
 end if;
 if v_new.name is null or btrim(v_new.name)='' or v_new.is_public is null or v_new.scoring_config is null or v_new.publish_contact is null or v_new.capacity_public is null or v_new.waitlist_enabled is null then raise exception 'Invalid settings'; end if;
 -- Organizer contacts are checked when they change (older rows keep saving).
 if nullif(btrim(coalesce(v_new.contact_phone,'')),'') is distinct from nullif(btrim(coalesce(v_old.contact_phone,'')),'')
    and nullif(btrim(coalesce(v_new.contact_phone,'')),'') !~ '^\+?[0-9\s\-\(\)]{7,20}$' then raise exception 'registration.invalidPhone'; end if;
 if nullif(btrim(coalesce(v_new.contact_email,'')),'') is distinct from nullif(btrim(coalesce(v_old.contact_email,'')),'')
    and nullif(btrim(coalesce(v_new.contact_email,'')),'') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'registration.invalidEmail'; end if;
 if v_new.publish_contact and nullif(btrim(coalesce(v_new.contact_phone,'')),'') is null and nullif(btrim(coalesce(v_new.contact_email,'')),'') is null then raise exception 'Contact required'; end if;
 if v_new.registration_capacity is not null and v_new.registration_capacity<=0 then raise exception 'registration.invalidCapacity'; end if;
 -- Lowering the limit never removes approved participants silently.
 if v_new.registration_capacity is not null and v_new.registration_capacity is distinct from v_old.registration_capacity
    and v_new.registration_capacity<registration_occupancy(p_tournament_id,null) then raise exception 'registration.capacityBelowOccupied'; end if;
 -- A waitlist queues entries beyond the limit, so it needs one.
 if v_new.waitlist_enabled and v_new.registration_capacity is null
    and (v_new.waitlist_enabled,v_new.registration_capacity) is distinct from (v_old.waitlist_enabled,v_old.registration_capacity) then raise exception 'registration.waitlistNeedsCapacity'; end if;
 if v_new.entry_fee_mode is distinct from 'paid' then
  v_new.entry_fee_minor:=null; v_new.entry_fee_currency:=null; v_new.entry_fee_unit:=null;
  if v_new.entry_fee_mode is not null and v_new.entry_fee_mode<>'free' then raise exception 'registration.invalidFee'; end if;
 else
  v_new.entry_fee_currency:=upper(btrim(coalesce(v_new.entry_fee_currency,'')));
  if v_new.entry_fee_minor is null or v_new.entry_fee_minor<0 or v_new.entry_fee_currency!~'^[A-Z]{3}$'
     or v_new.entry_fee_unit is null or v_new.entry_fee_unit<>all(array['player','pair','team']) then raise exception 'registration.invalidFee'; end if;
  -- A newly set fee is a real amount per a unit that exists in this tournament.
  if (v_new.entry_fee_mode,v_new.entry_fee_minor,v_new.entry_fee_unit) is distinct from (v_old.entry_fee_mode,v_old.entry_fee_minor,v_old.entry_fee_unit) then
   if v_new.entry_fee_minor=0 then raise exception 'registration.zeroFee'; end if;
   v_units:=case when v_new.sport='football' then array['team','player'] when v_new.category='doubles' then array['pair','player'] else array['player'] end;
   if v_new.entry_fee_unit<>all(v_units) then raise exception 'registration.feeUnitMismatch'; end if;
  end if;
 end if;
 -- Venue: an address of sane length, and a point that is either complete or absent.
 v_new.venue_address:=nullif(btrim(coalesce(v_new.venue_address,'')),'');
 if v_new.venue_address is not null and length(v_new.venue_address)>300 then raise exception 'venue.invalidAddress'; end if;
 if (v_new.venue_lat is null)<>(v_new.venue_lng is null) then raise exception 'venue.invalidPoint'; end if;
 if v_new.venue_lat is not null and (v_new.venue_lat< -90 or v_new.venue_lat>90 or v_new.venue_lng< -180 or v_new.venue_lng>180) then raise exception 'venue.invalidPoint'; end if;
 -- Schedule settings: see assert_schedule_config.
 perform assert_schedule_config(v_new.schedule_config);
 if v_new.player_rating is null or v_new.player_rating<>all(array['off','optional','required']) then raise exception 'rating.invalidSetting'; end if;
 if v_new.visibility is null or v_new.visibility<>all(array['public','link','private','password']) then raise exception 'access.invalidVisibility'; end if;
 if v_new.visibility='password' and v_old.access_password_hash is null then raise exception 'access.passwordRequired'; end if;
 v_category_changed:=v_old.category is distinct from v_new.category;
 if v_category_changed then
  if v_old.status in ('in_progress','completed') then raise exception 'drafts.rulesLocked'; end if;
  perform 1 from matches where tournament_id=p_tournament_id order by id for update nowait;
  if exists(select 1 from matches where tournament_id=p_tournament_id) and p_expected_matches is distinct from tournament_match_versions(p_tournament_id) then raise exception 'drafts.structureConflict'; end if;
  if exists(select 1 from matches where tournament_id=p_tournament_id and (status='finished' or winner_entry_id is not null))
    or exists(select 1 from match_sets s join matches m on m.id=s.match_id where m.tournament_id=p_tournament_id)
    or exists(select 1 from live_scores where tournament_id=p_tournament_id) then raise exception 'drafts.rulesLocked'; end if;
 end if;
 update tournaments set name=v_new.name,description=v_new.description,category=v_new.category,set_format=v_new.set_format,
  scoring_config=v_new.scoring_config,doubles_pairing_mode=v_new.doubles_pairing_mode,status=v_new.status,is_public=v_new.is_public,
  contact_phone=nullif(btrim(coalesce(v_new.contact_phone,'')),''),contact_email=nullif(btrim(coalesce(v_new.contact_email,'')),''),publish_contact=v_new.publish_contact,
  registration_capacity=v_new.registration_capacity,capacity_public=v_new.capacity_public,registration_deadline=v_new.registration_deadline,
  entry_fee_mode=v_new.entry_fee_mode,entry_fee_minor=v_new.entry_fee_minor,entry_fee_currency=v_new.entry_fee_currency,entry_fee_unit=v_new.entry_fee_unit,
  waitlist_enabled=v_new.waitlist_enabled,schedule_config=v_new.schedule_config,visibility=v_new.visibility,
  venue_address=v_new.venue_address,venue_lat=v_new.venue_lat,venue_lng=v_new.venue_lng,player_rating=v_new.player_rating
 where id=p_tournament_id returning * into v_new;
 if v_category_changed then delete from matches where tournament_id=p_tournament_id; end if;
 return to_jsonb(v_new);
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;

create or replace function get_tournament_sync_state(p_tournament_id uuid)
returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object(
  'tournament', jsonb_build_object('id',t.id,'name',t.name,'slug',t.slug,'description',t.description,
   'sport',t.sport,'format',t.format,'category',t.category,'status',t.status,'set_format',t.set_format,
   'is_public',t.is_public,'doubles_pairing_mode',t.doubles_pairing_mode,'format_config',t.format_config,
   'scoring_config',t.scoring_config,'settings_revision',t.settings_revision,
   'publish_contact',coalesce((tournament_public_contact(t.id)->>'published')::boolean,false),
   'contact_phone',tournament_public_contact(t.id)->>'phone','contact_email',tournament_public_contact(t.id)->>'email',
   'registration_capacity',t.registration_capacity,'capacity_public',t.capacity_public,'registration_deadline',t.registration_deadline,
   'entry_fee_mode',t.entry_fee_mode,'entry_fee_minor',t.entry_fee_minor,'entry_fee_currency',t.entry_fee_currency,'entry_fee_unit',t.entry_fee_unit,
   'waitlist_enabled',t.waitlist_enabled,'schedule_config',t.schedule_config,'schedule_published_at',t.schedule_published_at,'visibility',t.visibility,
   'venue_address',t.venue_address,'venue_lat',t.venue_lat,'venue_lng',t.venue_lng,
   'access_password_set',tournament_password_set(t.id),'player_rating',t.player_rating),
  'registration', tournament_registration_state(t.id),
  'entries', coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,
   'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,'seed_order',e.seed_order,
   'entry_members',coalesce((select jsonb_agg(jsonb_build_object('id',em.id,'entry_id',em.entry_id,
    'member_name',em.member_name,'member_order',em.member_order) order by em.member_order,em.id)
    from entry_members em where em.entry_id=e.id),'[]'::jsonb)) order by e.created_at,e.id)
   from entries e where e.tournament_id=t.id),'[]'::jsonb),
  'matches',coalesce((select jsonb_agg(to_jsonb(m) order by m.round_number,m.match_number,m.id)
   from matches m where m.tournament_id=t.id),'[]'::jsonb),
  'sets',coalesce((select jsonb_agg(to_jsonb(s) order by s.match_id,s.set_index)
   from match_sets s join matches m on m.id=s.match_id where m.tournament_id=t.id),'[]'::jsonb),
  'live',coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from live_scores l where l.tournament_id=t.id),'[]'::jsonb),
  'groups',coalesce((select jsonb_agg(to_jsonb(g) order by g.group_index,g.id)
   from groups g where g.tournament_id=t.id),'[]'::jsonb),
  'courts',coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order,c.name,c.id) from courts c where c.tournament_id=t.id),'[]'::jsonb),
  'schedule',coalesce((select jsonb_agg(to_jsonb(s) order by s.state,s.match_id) from match_schedule s where s.tournament_id=t.id),'[]'::jsonb),
  'standings',case when t.format='round_robin' then
   coalesce((select jsonb_agg(to_jsonb(s) order by s.rank,s.entry_id) from get_standings(t.id,null) s),'[]'::jsonb)
   else '[]'::jsonb end,
  'group_standings',case when t.format='groups_playoff' then
   coalesce((select jsonb_object_agg(g.id,coalesce((select jsonb_agg(to_jsonb(s) order by s.rank,s.entry_id)
    from get_standings(t.id,g.id) s),'[]'::jsonb)) from groups g where g.tournament_id=t.id),'{}'::jsonb)
   else '{}'::jsonb end,
  'points_standings',case when format_is_points(t.format) then
   coalesce((select jsonb_agg(to_jsonb(s) order by s.rank,s.entry_id) from get_points_standings(t.id) s),'[]'::jsonb)
   else '[]'::jsonb end
 ) from tournaments t where t.id=p_tournament_id;
$$;
