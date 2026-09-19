-- Run after the v38 migration. This fixture changes only synthetic rows and
-- always ends with ROLLBACK.
begin;

do $$
declare
  suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  ordinary_code text := 'NGO-' || suffix;
  v1_code text := 'NG1-' || suffix;
  v2_code text := 'NGV-' || suffix;
  blocked_code text := 'NGB-' || suffix;
  ordinary_id uuid;
  v1_id uuid;
  v2_id uuid;
  failure_constraint text;
  base_state jsonb := jsonb_build_object(
    'variant', 'long', 'mode', 'bot', 'opponent', 'bot',
    'phase', 'opening', 'turn', null, 'winner', null,
    'points', jsonb_build_object(
      '24', jsonb_build_object('color', 'white', 'count', 15),
      '12', jsonb_build_object('color', 'dark', 'count', 15)
    ),
    'bar', jsonb_build_object('white', 0, 'dark', 0),
    'off', jsonb_build_object('white', 0, 'dark', 0),
    'score', jsonb_build_object('white', 0, 'dark', 0),
    'dice', '[]'::jsonb, 'rolled', '[]'::jsonb,
    'history', '[]'::jsonb, 'turnMoves', '[]'::jsonb,
    'firstMoveDone', jsonb_build_object('white', false, 'dark', false),
    'headPlayedThisTurn', jsonb_build_object('white', false, 'dark', false)
  );
  neural_analysis jsonb := jsonb_build_object(
    'mode', 'bot', 'opponent', 'bot', 'difficulty', 'hard-neuro',
    'neuralModel', jsonb_build_object('id', 'hard-neuro-search-v2-32games-v1')
  );
  legacy_analysis jsonb := jsonb_build_object(
    'mode', 'bot', 'opponent', 'bot', 'difficulty', 'hard-neuro',
    'neuralModel', jsonb_build_object('id', 'hard-neuro-448-v1')
  );
  guarded_analysis jsonb := neural_analysis || jsonb_build_object(
    'neuralExecutionPolicy', 'long-neural-hard-teacher-guard-v1',
    'neuralTeacherPolicyImplementationId',
      '4aede916c0f3a219e84582d3a8277f50b1041d6b7ae541bff7b807c42c82f526'
  );
begin
  update private.fair_dice_settings set enabled = false where singleton;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);

  begin
    insert into public.rooms (code, variant, status, host_name, game_state)
    values (
      blocked_code, 'long', 'closed', 'NeuralGateBlocked',
      base_state || jsonb_build_object(
        'roomCode', blocked_code, 'botDifficulty', 'hard-neuro',
        'analysis', guarded_analysis
      )
    );
    raise exception 'Authenticated INSERT unexpectedly created a neural room.';
  exception when check_violation then
    get stacked diagnostics failure_constraint = constraint_name;
    if failure_constraint is distinct from 'rooms_neural_strength_gate' then raise; end if;
  end;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.rooms (code, variant, status, host_name, game_state)
  values (
    ordinary_code, 'long', 'closed', 'NeuralGateOrdinary',
    base_state || jsonb_build_object(
      'roomCode', ordinary_code, 'botDifficulty', 'hard',
      'analysis', jsonb_build_object('mode', 'bot', 'difficulty', 'hard')
    )
  ) returning id into ordinary_id;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  begin
    update public.rooms
    set game_state = base_state || jsonb_build_object(
      'roomCode', ordinary_code, 'botDifficulty', 'hard-neuro',
      'analysis', guarded_analysis
    )
    where id = ordinary_id;
    raise exception 'Ordinary room unexpectedly changed into a neural room.';
  exception when check_violation then
    get stacked diagnostics failure_constraint = constraint_name;
    if failure_constraint is distinct from 'rooms_neural_identity_immutable' then raise; end if;
  end;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    update public.rooms
    set game_state = base_state || jsonb_build_object(
      'roomCode', ordinary_code, 'botDifficulty', 'hard-neuro',
      'analysis', guarded_analysis
    )
    where id = ordinary_id;
    raise exception 'Service-role ordinary room unexpectedly changed into a neural room.';
  exception when check_violation then
    get stacked diagnostics failure_constraint = constraint_name;
    if failure_constraint is distinct from 'rooms_neural_identity_immutable' then raise; end if;
  end;

  insert into public.rooms (code, variant, status, host_name, game_state)
  values (
    v1_code, 'long', 'closed', 'NeuralGateExistingV1',
    base_state || jsonb_build_object(
      'roomCode', v1_code, 'botDifficulty', 'hard-neuro',
      'analysis', legacy_analysis
    )
  ) returning id into v1_id;

  begin
    update public.rooms
    set game_state = jsonb_set(
      game_state,
      '{analysis,neuralModel,id}',
      '"hard-neuro-search-v2-32games-v1"'::jsonb,
      true
    )
    where id = v1_id;
    raise exception 'Service-role V1 room unexpectedly changed into V2.';
  exception when check_violation then
    get stacked diagnostics failure_constraint = constraint_name;
    if failure_constraint is distinct from 'rooms_neural_model_immutable' then raise; end if;
  end;

  insert into public.rooms (code, variant, status, host_name, game_state)
  values (
    v2_code, 'long', 'closed', 'NeuralGateExistingV2',
    base_state || jsonb_build_object(
      'roomCode', v2_code, 'botDifficulty', 'hard-neuro',
      'analysis', guarded_analysis
    )
  ) returning id into v2_id;

  begin
    update public.rooms
    set game_state = jsonb_set(
      game_state,
      '{analysis,neuralModel,id}',
      '"hard-neuro-448-v1"'::jsonb,
      true
    )
    where id = v2_id;
    raise exception 'Service-role V2 room unexpectedly changed into V1.';
  exception when check_violation then
    get stacked diagnostics failure_constraint = constraint_name;
    if failure_constraint is distinct from 'rooms_neural_model_immutable' then raise; end if;
  end;

  begin
    update public.rooms
    set game_state = game_state #- '{analysis,neuralModel}'
    where id = v2_id;
    raise exception 'Service-role V2 room unexpectedly removed its model metadata.';
  exception when check_violation then
    get stacked diagnostics failure_constraint = constraint_name;
    if failure_constraint is distinct from 'rooms_neural_model_immutable' then raise; end if;
  end;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  update public.rooms
  set game_state = jsonb_set(game_state, '{analysis,guardSmoke}', 'true'::jsonb, true),
      game_version = game_version + 1
  where id = v2_id;
  if not found then raise exception 'Guarded V2 update did not reach its fixture.'; end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    update public.rooms
    set game_state = base_state || jsonb_build_object(
      'roomCode', v2_code, 'botDifficulty', 'hard',
      'analysis', jsonb_build_object('mode', 'bot', 'difficulty', 'hard')
    ),
        game_version = game_version + 1
    where id = v2_id;
    raise exception 'Service-role neural room unexpectedly changed into an ordinary room.';
  exception when check_violation then
    get stacked diagnostics failure_constraint = constraint_name;
    if failure_constraint is distinct from 'rooms_neural_identity_immutable' then raise; end if;
  end;

  begin
    update public.rooms
    set game_state = game_state #- '{analysis,neuralExecutionPolicy}',
        game_version = game_version + 1
    where id = v2_id;
    raise exception 'Stale V2 update unexpectedly bypassed the teacher guard.';
  exception when check_violation then
    get stacked diagnostics failure_constraint = constraint_name;
    if failure_constraint is distinct from 'rooms_neural_teacher_guard_required' then raise; end if;
  end;
end;
$$;

rollback;
