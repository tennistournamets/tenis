-- Close sport-change bypass of the ITF scoring rule lock.
begin;
create or replace function guard_tennis_scoring_settings()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; new_rules jsonb; old_rules jsonb;
begin
  -- A sport change must not bypass the rule lock by temporarily switching
  -- to football, whose scoring settings are outside this tennis validator.
  if TG_OP='UPDATE' and new.sport is distinct from old.sport then
    if old.status in ('in_progress','completed') or new.status in ('in_progress','completed')
      or exists(select 1 from match_sets s join matches m on m.id=s.match_id where m.tournament_id=old.id)
      or exists(select 1 from live_scores where tournament_id=old.id) then
      raise exception using errcode='22023', message='Scoring rules are locked after the tournament starts or scores exist';
    end if;
  end if;
  if new.sport not in ('tennis','padel') then return new; end if;
  if new.sport='padel' and new.scoring_config ? 'tennis' then
    raise exception using errcode='22023', message='ITF tennis settings apply only to tennis';
  end if;
  new_rules:=tennis_scoring_rules(new.scoring_config);
  if TG_OP='UPDATE' then
    old_rules:=tennis_scoring_rules(old.scoring_config);
    changed := new_rules is distinct from old_rules or new.set_format is distinct from old.set_format;
    if changed and (old.status in ('in_progress','completed') or new.status in ('in_progress','completed')
      or exists(select 1 from match_sets s join matches m on m.id=s.match_id where m.tournament_id=old.id)
      or exists(select 1 from live_scores where tournament_id=old.id)) then
      raise exception using errcode='22023', message='Scoring rules are locked after the tournament starts or scores exist';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function guard_tennis_scoring_settings() from public,anon,authenticated;
commit;
