-- Allow organizations.slug to be NULL so admins can clear their public URL.
alter table organizations alter column slug drop not null;

-- Replace update_organization so passing p_slug = '' (or whitespace) clears
-- the slug to NULL. p_slug = NULL still means "leave unchanged".
create or replace function update_organization(
  p_org_id uuid,
  p_slug text default null,
  p_name text default null,
  p_description text default null,
  p_city text default null,
  p_country text default null,
  p_logo_url text default null,
  p_auto_approve_members boolean default null
) returns organizations
language plpgsql security definer
set search_path = public
as $$
declare
  v_row organizations%rowtype;
  v_new_slug text;
  v_clear_slug boolean := false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_row from organizations where id = p_org_id for update;
  if not found then raise exception 'Organization not found'; end if;
  if not (is_org_admin(p_org_id) or is_platform_admin()) then
    raise exception 'Forbidden';
  end if;

  if p_slug is not null then
    v_new_slug := lower(btrim(p_slug));

    if v_new_slug = '' then
      v_clear_slug := true;
    else
      if char_length(v_new_slug) < 3 or char_length(v_new_slug) > 40 then
        raise exception 'Slug must be 3..40 characters';
      end if;
      if v_new_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
        raise exception 'Slug must be lowercase a-z, 0-9, single dashes (no leading/trailing/consecutive)';
      end if;
      if v_new_slug in ('admin','api','app','auth','login','logout','register',
                        'clubs','club','coach','player','players','tournaments',
                        'tournament','settings','invite','invites','new','edit') then
        raise exception 'This slug is reserved';
      end if;
      if exists (select 1 from organizations where slug = v_new_slug and id <> p_org_id) then
        raise exception 'Slug already in use';
      end if;
    end if;
  end if;

  update organizations set
    slug = case
      when v_clear_slug then null
      when v_new_slug is not null then v_new_slug
      else slug
    end,
    name                 = coalesce(p_name, name),
    description          = coalesce(p_description, description),
    city                 = coalesce(p_city, city),
    country              = coalesce(p_country, country),
    logo_url             = coalesce(p_logo_url, logo_url),
    auto_approve_members = coalesce(p_auto_approve_members, auto_approve_members)
  where id = p_org_id
  returning * into v_row;

  return v_row;
end $$;

grant execute on function update_organization(uuid, text, text, text, text, text, text, boolean) to authenticated;
