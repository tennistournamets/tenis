-- Only an owner may delete a tournament. Editors keep every other management
-- right (settings, entries, bracket, schedule, assistants); the role matrix shown
-- to organizers (src/lib/access.js) promises the same split on the server and in
-- Realtime, so the DELETE policy moves from is_tournament_admin to an owner check.
-- Safe to re-run: the helper is replaced, the policy is dropped and recreated.
create or replace function public.is_tournament_owner(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from tournament_admins ta
    where ta.tournament_id = p_tournament_id
      and ta.user_id = auth.uid()
      and ta.role = 'owner'
  );
$$;

drop policy if exists tournaments_delete_admin on tournaments;
create policy tournaments_delete_admin on tournaments
for delete
to authenticated
using (is_tournament_owner(id));

notify pgrst, 'reload schema';
