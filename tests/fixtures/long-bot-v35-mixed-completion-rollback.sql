-- Run only after the v35 migrations in the SAME rollback-only transaction.
-- This creates one synthetic terminal-eligible room, never updates a real room,
-- and does not reserve an active-room slot or alter an existing profile.
-- The caller must own the surrounding BEGIN/ROLLBACK and must NOT COMMIT.
do $mixed_completion_smoke$
declare
  synthetic_id uuid := gen_random_uuid();
  synthetic_code text := 'SMOKE-' || upper(replace(gen_random_uuid()::text, '-', ''));
  existing_player uuid;
  saved_claims text := current_setting('request.jwt.claims', true);
  saved_sub text := current_setting('request.jwt.claim.sub', true);
  saved_role text := current_setting('request.jwt.claim.role', true);
  initial_state jsonb;
  final_state jsonb;
  invalid_training jsonb;
  result jsonb;
  bad_rejected boolean;
begin
  select id into existing_player from public.profiles order by id limit 1;
  if existing_player is null then
    raise exception 'Mixed completion rollback smoke requires one existing profile.';
  end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', existing_player, 'role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.sub', existing_player::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  initial_state := jsonb_build_object(
    'phase', 'move', 'mode', 'bot', 'variant', 'long', 'botDifficulty', 'hard',
    'roomCode', synthetic_code, 'startedAt', '2026-01-01T00:00:00Z',
    'points', '{"1":{"color":"white","count":1},"13":{"color":"dark","count":15}}'::jsonb,
    'off', '{"white":14,"dark":0}'::jsonb, 'bar', '{"white":0,"dark":0}'::jsonb,
    'score', '{"white":0,"dark":0}'::jsonb
  );
  -- status=over avoids all active-player claim/reservation effects. The RPC
  -- permits this retry boundary and will write a genuinely final board below.
  insert into public.rooms(id, code, variant, status, host_user_id, host_name, guest_name, game_state, game_version)
  values(synthetic_id, synthetic_code, 'long', 'over', existing_player, 'Rollback smoke only', 'Hard bot', initial_state, 0);
  final_state := initial_state || jsonb_build_object(
    'phase', 'over', 'winner', 'white', 'finishedAt', '2026-01-01T00:01:00Z', 'resultType', 'normal',
    'points', '{"13":{"color":"dark","count":15}}'::jsonb,
    'off', '{"white":15,"dark":0}'::jsonb,
    'score', '{"white":1,"dark":0}'::jsonb,
    'analysis', '{"playerColor":"white","botMemory":{"engineVersion":"long-analytic-v35","coverage":{"complete":true,"expectedBotDecisions":2,"recordedBotDecisions":2,"recoveredBotDecisions":0},"decisions":[{"actor":"bot","engineVersion":"long-analytic-v34"},{"actor":"bot","engineVersion":"long-analytic-v35"}]}}'::jsonb
  );
  result := public.finish_room_game(synthetic_code, final_state, final_state);
  if result->'ok' is distinct from 'true'::jsonb
     or result->'trainingArchived' is distinct from 'false'::jsonb
     or result->'trainingQuarantined' is distinct from 'true'::jsonb then
    raise exception 'Mixed completion did not return the required success/quarantine contract: %', result;
  end if;
  if not exists(select 1 from public.rooms where id = synthetic_id and status = 'over' and game_version = 1 and game_state = final_state and closed_reason = 'finished' and archived_at is not null) then
    raise exception 'Mixed completion did not persist its exact finished room.';
  end if;
  if exists(select 1 from public.bot_training_games where room_code = synthetic_code)
     or exists(select 1 from private.long_bot_causal_review_jobs job join public.bot_training_games game on game.id = job.training_game_id where game.room_code = synthetic_code) then
    raise exception 'Mixed completion incorrectly created training archive/queue evidence.';
  end if;

  -- Quarantine never excuses malformed numeric coverage, unknown/missing
  -- policy generations or a training board different from the final board.
  foreach invalid_training in array array[
    jsonb_set(final_state, '{analysis,botMemory,coverage,recordedBotDecisions}', '1'::jsonb),
    jsonb_set(final_state, '{analysis,botMemory,decisions,0,engineVersion}', '"unknown-engine"'::jsonb),
    jsonb_set(final_state, '{analysis,botMemory,decisions,0}', '{"actor":"bot"}'::jsonb),
    jsonb_set(final_state, '{off,white}', '14'::jsonb)
  ] loop
    bad_rejected := false;
    begin
      perform public.finish_room_game(synthetic_code, final_state, invalid_training);
    exception when sqlstate '22023' then
      bad_rejected := true;
    end;
    if not bad_rejected then
      raise exception 'Malformed payload passed the completion quarantine boundary: %', invalid_training;
    end if;
  end loop;
  if exists(select 1 from public.bot_training_games where room_code = synthetic_code) then
    raise exception 'Negative retries leaked a training archive.';
  end if;
  perform set_config('request.jwt.claims', coalesce(saved_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(saved_sub, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(saved_role, ''), true);
  raise notice 'Mixed completion rollback smoke PASS: final room persisted; no training archive/queue; four malformed retries rejected.';
end;
$mixed_completion_smoke$;
