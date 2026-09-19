begin;

-- Stop stale/public clients from creating new neural-bot rooms. Existing V2
-- rooms can resume after refresh; legacy V1 rows stay preserved and frozen.
-- Service-role creation is reserved for maintenance fixtures.
create or replace function public.enforce_neural_strength_gate()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  request_role text := coalesce(auth.role(), '');
  requested_difficulty text := coalesce(
    new.game_state->>'botDifficulty',
    new.game_state#>>'{analysis,difficulty}',
    ''
  );
  new_is_neural boolean := false;
  old_is_neural boolean := false;
  old_model_id text := '';
  new_model_id text := '';
  old_is_v2 boolean := false;
  new_is_v2 boolean := false;
  v2_guard_valid boolean := false;
begin
  new_model_id := coalesce(new.game_state#>>'{analysis,neuralModel,id}', '');
  new_is_neural := requested_difficulty = 'hard-neuro'
    or new.game_state#>'{analysis,neuralModel}' is not null;
  if tg_op = 'UPDATE' then
    old_model_id := coalesce(old.game_state#>>'{analysis,neuralModel,id}', '');
    old_is_neural := coalesce(
      old.game_state->>'botDifficulty',
      old.game_state#>>'{analysis,difficulty}',
      ''
    ) = 'hard-neuro'
      or old.game_state#>'{analysis,neuralModel}' is not null;
    old_is_v2 := old_model_id = 'hard-neuro-search-v2-32games-v1';
  end if;
  new_is_v2 := new_model_id = 'hard-neuro-search-v2-32games-v1';
  v2_guard_valid := coalesce(new.game_state#>>'{analysis,neuralExecutionPolicy}', '')
      = 'long-neural-hard-teacher-guard-v1'
    and coalesce(new.game_state#>>'{analysis,neuralTeacherPolicyImplementationId}', '')
      = '4aede916c0f3a219e84582d3a8277f50b1041d6b7ae541bff7b807c42c82f526';

  if request_role in ('anon', 'authenticated') and tg_op = 'INSERT' and new_is_neural then
    raise exception using
      errcode = '23514',
      message = 'New neural-bot games are disabled until the strength gate passes.',
      constraint = 'rooms_neural_strength_gate';
  end if;
  -- The fair-dice coordinator commits through service_role, so room identity
  -- must be immutable for every writer, not only direct browser roles.
  if tg_op = 'UPDATE' and old_is_neural is distinct from new_is_neural then
    raise exception using
      errcode = '23514',
      message = 'The neural-bot identity of an existing room is immutable.',
      constraint = 'rooms_neural_identity_immutable';
  end if;
  if tg_op = 'UPDATE'
     and old_is_neural and new_is_neural
     and old_model_id is distinct from new_model_id then
    raise exception using
      errcode = '23514',
      message = 'The neural model of an existing room is immutable.',
      constraint = 'rooms_neural_model_immutable';
  end if;
  -- Fair-dice state commits execute as service_role, therefore this runtime
  -- epoch check intentionally applies to every role.  A stale already-open V2
  -- tab must refresh before it can submit another neural-only move.
  if tg_op = 'UPDATE' and old_is_v2 and new_is_v2 and not v2_guard_valid then
    raise exception using
      errcode = '23514',
      message = 'Refresh this neural room to activate the verified hard-v35 safety policy.',
      constraint = 'rooms_neural_teacher_guard_required';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_neural_strength_gate()
from public, anon, authenticated;

drop trigger if exists rooms_enforce_neural_strength_gate_trg on public.rooms;
create trigger rooms_enforce_neural_strength_gate_trg
before insert or update of game_state on public.rooms
for each row execute function public.enforce_neural_strength_gate();

do $$
begin
  perform pg_notify('pgrst', 'reload schema');
exception
  when others then null;
end;
$$;

commit;
