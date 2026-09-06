-- Let counters see their own tournament assignments in the admin list.

drop policy if exists tournament_admins_select_admin on tournament_admins;
create policy tournament_admins_select_admin on tournament_admins
for select
to authenticated
using (
  user_id = auth.uid()
  or is_tournament_admin(tournament_id)
);
