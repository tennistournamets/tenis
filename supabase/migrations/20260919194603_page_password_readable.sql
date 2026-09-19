-- The page password is a code the organizer hands to participants, not a login
-- credential, and they have to be able to read it back to share it again. A
-- bcrypt hash cannot be shown, so the code is kept beside it. The column is
-- deliberately outside the tournaments select grant, so no API role can read
-- it; only the organizer-only function below hands it out.
alter table public.tournaments add column if not exists access_password_plain text;

create or replace function public.set_tournament_password(p_tournament_id uuid, p_password text, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_t tournaments%rowtype;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_t from tournaments where id=p_tournament_id for update;
 if v_t.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_t.settings_revision then raise exception 'drafts.conflict'; end if;
 if p_password is null or btrim(p_password)='' then
  if v_t.visibility='password' then raise exception 'access.passwordRequired'; end if;
  update tournaments set access_password_hash=null,access_password_plain=null,
   access_password_version=access_password_version+1 where id=p_tournament_id returning * into v_t;
 else
  if length(p_password)<4 or length(p_password)>72 then raise exception 'access.passwordTooShort'; end if;
  update tournaments set access_password_hash=extensions.crypt(p_password,extensions.gen_salt('bf',10)),
   access_password_plain=p_password,
   access_password_version=access_password_version+1 where id=p_tournament_id returning * into v_t;
 end if;
 -- Every change invalidates issued tokens.
 delete from tournament_access_grants where tournament_id=p_tournament_id;
 delete from tournament_unlock_attempts where tournament_id=p_tournament_id;
 return jsonb_build_object('password_set',v_t.access_password_hash is not null,'settings_revision',v_t.settings_revision);
end;
$$;

-- Owners and editors read the code they set. A counter runs results only and
-- gets nothing, like everyone else. Passwords set before this column existed
-- return null: the hash they were stored as cannot be turned back into text.
create or replace function public.tournament_password(p_tournament_id uuid)
returns text language sql stable security definer set search_path=public as $$
 select case when is_tournament_admin(t.id) then t.access_password_plain end from tournaments t where t.id=p_tournament_id;
$$;
-- Supabase grants execute on new functions to anon by default, and revoking
-- from PUBLIC does not take a direct grant away. This one hands out a secret,
-- so the privilege itself is kept off the anonymous role, not just the answer.
revoke execute on function public.tournament_password(uuid) from public, anon, authenticated;
grant execute on function public.tournament_password(uuid) to authenticated;
notify pgrst, 'reload schema';
