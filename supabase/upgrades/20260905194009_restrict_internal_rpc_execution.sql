-- Target: the current multi-sport schema, NOT the historical org-era schema.
-- Apply this file alone; see README.md before using migration tooling.
-- The authorized public RPCs and these helpers must share a privileged owner
-- (verified as postgres on TENIS before preparing this migration).
begin;

revoke execute on function public.propagate_winner(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.clear_downstream(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.generate_single_elim(uuid, uuid[], public.match_stage)
  from public, anon, authenticated;
revoke execute on function public.generate_double_elim(uuid, uuid[])
  from public, anon, authenticated;
revoke execute on function public.generate_round_robin_matches(uuid, uuid[], public.match_stage, uuid, integer)
  from public, anon, authenticated;

commit;
