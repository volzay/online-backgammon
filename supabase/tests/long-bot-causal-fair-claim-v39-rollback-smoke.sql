-- Synthetic queue-order test, not genuine causal evidence. Run after the v36
-- per-ply and v39 fair-claim migrations. The outer transaction rolls back all
-- fixture archives, activation, queue leases, and scheduling changes.
begin;

do $fair_claim_smoke$
declare
  d text := encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex');
  c text := repeat('9', 64);
  worker text := 'fair-claim-rollback-smoke';
  game_ids uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  job_ids bigint[] := array[]::bigint[];
  decisions jsonb;
  game public.bot_training_games;
  second_game public.bot_training_games;
  base_progress jsonb := '{"schema":"long-server-causal-progress-v2","finishedReviews":[],"currentDecisionIndex":null,"currentTerminalOutcomes":0,"currentRolloutCheckpoint":null,"slices":0,"stalledSlices":0}'::jsonb;
  cheap_progress jsonb;
  diagnostic_progress jsonb;
  partial_progress jsonb;
  cheap_review jsonb;
  diagnostic_review jsonb;
  timeout_result jsonb;
  short_timeout_result jsonb;
  claim jsonb;
  saved_progress jsonb;
  i integer;
begin
  if has_function_privilege('anon', 'public.claim_long_bot_causal_review_jobs(text,integer,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.claim_long_bot_causal_review_slices(text,text)', 'EXECUTE') then
    raise exception 'Fair claim changed the service-only RPC boundary.';
  end if;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.activate_long_bot_causal_release('long-server-causal-review-v1', d, c);

  -- The lower-ID game has three bot decisions; the higher-ID one has two.
  -- Their complete synthetic memory covers exactly their original ledgers.
  for i in 1..2 loop
    select jsonb_agg(jsonb_build_object('id', 'fair-' || i || '-' || original_index,
      'actor', 'bot', 'color', 'dark', 'source', 'engine',
      'engineVersion', 'long-analytic-v35') order by original_index)
      into decisions from generate_series(0, case when i = 1 then 2 else 1 end) as sequence(original_index);
    insert into public.bot_training_games(id, room_code, player_name, bot_name,
      engine_version, difficulty, bot_color, winner, decision_count, decisions, final_state)
    values (game_ids[i], 'FAIR-' || game_ids[i]::text, 'Synthetic', 'Synthetic',
      'long-analytic-v35', 'hard', 'dark', 'white', jsonb_array_length(decisions), decisions,
      jsonb_build_object('variant', 'long', 'analysis', jsonb_build_object('botMemory',
        jsonb_build_object('engineVersion', 'long-analytic-v35', 'decisions', decisions,
          'coverage', jsonb_build_object('complete', true,
            'expectedBotDecisions', jsonb_array_length(decisions),
            'recordedBotDecisions', jsonb_array_length(decisions), 'recoveredBotDecisions', 0)))));
    select archived.* into game from public.bot_training_games archived where archived.id = game_ids[i];
    if not private.long_bot_causal_archive_is_eligible(game) then
      raise exception 'Synthetic fair-claim archive is not eligible.';
    end if;
    job_ids := array_append(job_ids, (select queued.id from private.long_bot_causal_review_jobs queued
      where queued.training_game_id = game_ids[i] and queued.runtime_digest = d
        and queued.archive_fingerprint = private.long_bot_causal_archive_fingerprint(game)));
  end loop;
  if job_ids[1] is null or job_ids[2] is null or job_ids[1] >= job_ids[2] then
    raise exception 'Synthetic jobs lack stable ascending identity.';
  end if;
  -- Activation also queues real eligible archives under this temporary digest.
  -- Keep those rows untouched but unavailable inside the rollback transaction.
  update private.long_bot_causal_review_jobs
    set available_at = pg_catalog.now() + interval '1 day'
    where runtime_digest = d and training_game_id <> all(game_ids);

  select archived.* into game from public.bot_training_games archived where archived.id = game_ids[1];
  cheap_review := jsonb_build_object('decisionId', 'fair-1-0', 'status', 'rejected',
    'reason', 'production-strategic-risk-budget-skip', 'outcomeUsed', false, 'evidence', null);
  cheap_progress := base_progress || jsonb_build_object('finishedReviews',
    jsonb_build_array(jsonb_build_object('decisionIndex', 0, 'review', cheap_review)),
    'currentDecisionIndex', 1, 'slices', 1);
  perform private.long_bot_causal_validate_progress(game, cheap_progress);
  select archived.* into second_game from public.bot_training_games archived where archived.id = game_ids[2];
  diagnostic_review := jsonb_build_object('decisionId', 'fair-2-0', 'status', 'rejected',
    'reason', 'rollout-position-limit', 'outcomeUsed', false, 'evidence', null);
  diagnostic_progress := base_progress || jsonb_build_object('finishedReviews',
    jsonb_build_array(jsonb_build_object('decisionIndex', 0, 'review', diagnostic_review)),
    'currentDecisionIndex', 1, 'slices', 1);
  perform private.long_bot_causal_validate_progress(second_game, diagnostic_progress);
  partial_progress := base_progress || jsonb_build_object('currentDecisionIndex', 0,
    'currentTerminalOutcomes', 100, 'slices', 1);
  perform private.long_bot_causal_validate_progress(game, partial_progress);
  timeout_result := jsonb_build_object('reviews', jsonb_build_array(jsonb_build_object(
    'decisionId', 'fair-1-0', 'status', 'rejected', 'reason', 'rollout-time-limit',
    'outcomeUsed', false, 'evidence', null,
    'rollout', jsonb_build_object('coverage',
      jsonb_build_object('complete', false, 'requiredTerminalOutcomes', 544)))));
  short_timeout_result := jsonb_build_object('reviews', jsonb_build_array(jsonb_build_object(
    'decisionId', 'fair-2-0', 'status', 'rejected', 'reason', 'rollout-time-limit',
    'outcomeUsed', false, 'evidence', null,
    'rollout', jsonb_build_object('coverage',
      jsonb_build_object('complete', false, 'requiredTerminalOutcomes', 64)))));

  -- Denied and stale-release claims cannot lease or increment attempts.
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    perform public.claim_long_bot_causal_review_slices(worker, d);
    raise exception 'Anonymous claim was accepted.';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    perform public.claim_long_bot_causal_review_slices(worker, repeat('0', 64));
    raise exception 'Stale runtime claim was accepted.';
  exception when invalid_parameter_value then null;
  end;
  if exists (select 1 from private.long_bot_causal_review_jobs
    where id = any(job_ids) and (status <> 'pending' or attempts <> 0)) then
    raise exception 'Denied/stale claim mutated a fixture job.';
  end if;

  -- A finished cheap row stays on its game for the next original index.
  update private.long_bot_causal_review_jobs set result = jsonb_build_object('reviews', jsonb_build_array(cheap_review)),
    progress = cheap_progress, updated_at = pg_catalog.now(), available_at = pg_catalog.now()
    where id = job_ids[1];
  claim := public.claim_long_bot_causal_review_slices(worker, d)->0;
  if (claim->>'jobId')::bigint is distinct from job_ids[1]
    or claim->>'runtimeDigest' is distinct from d or claim->>'policyImplementationId' is distinct from c
    or claim->'progress' is distinct from cheap_progress
    or claim->>'archiveFingerprint' is distinct from private.long_bot_causal_archive_fingerprint(game)
    or claim->>'archiveFingerprintSource' is distinct from private.long_bot_causal_archive_payload(game)::text
    or (select attempts from private.long_bot_causal_review_jobs where id = job_ids[1]) <> 1
    or (select lease_until from private.long_bot_causal_review_jobs where id = job_ids[1]) > pg_catalog.now() + interval '15 minutes 1 second' then
    raise exception 'Cheap claim lost locality, source identity, progress, or bounded lease.';
  end if;

  -- A prior finished diagnostic such as rollout-position-limit also continues
  -- before an untouched game. A partial expensive cohort yields to it.
  update private.long_bot_causal_review_jobs set status = 'pending', attempts = 0,
    lease_owner = null, lease_until = null, result = timeout_result,
    progress = partial_progress, updated_at = pg_catalog.now(), available_at = pg_catalog.now()
    where id = job_ids[1];
  update private.long_bot_causal_review_jobs set result = jsonb_build_object('reviews',
      jsonb_build_array(diagnostic_review)), progress = diagnostic_progress,
      updated_at = pg_catalog.now(), available_at = pg_catalog.now()
    where id = job_ids[2];
  saved_progress := (select progress from private.long_bot_causal_review_jobs where id = job_ids[1]);
  claim := public.claim_long_bot_causal_review_slices(worker, d)->0;
  if (claim->>'jobId')::bigint is distinct from job_ids[2]
    or (select progress from private.long_bot_causal_review_jobs where id = job_ids[1]) is distinct from saved_progress then
    raise exception 'Partial head-of-line job prevented a finished diagnostic continuation.';
  end if;

  -- Among recent partials, the higher-ID 64-slot late cohort (44 remaining)
  -- beats the lower-ID 544-slot cohort (344 remaining).
  update private.long_bot_causal_review_jobs set status = 'pending', attempts = 0,
    lease_owner = null, lease_until = null, available_at = pg_catalog.now(),
    updated_at = pg_catalog.now() where id = any(job_ids);
  update private.long_bot_causal_review_jobs set result = timeout_result,
    progress = base_progress || jsonb_build_object('currentDecisionIndex', 0,
      'currentTerminalOutcomes', 200, 'slices', 1) where id = job_ids[1];
  update private.long_bot_causal_review_jobs set result = short_timeout_result,
    progress = base_progress || jsonb_build_object('currentDecisionIndex', 0,
      'currentTerminalOutcomes', 20, 'slices', 1) where id = job_ids[2];
  perform private.long_bot_causal_validate_progress(second_game,
    (select progress from private.long_bot_causal_review_jobs where id = job_ids[2]));
  claim := public.claim_long_bot_causal_review_slices(worker, d)->0;
  if (claim->>'jobId')::bigint is distinct from job_ids[2] then
    raise exception 'Short recent terminal cohort was not prioritized.';
  end if;

  -- A 30-minute-old partial is promoted ahead of a finished cheap cursor;
  -- after one claim, updated_at moves forward and ends that promotion.
  update private.long_bot_causal_review_jobs set status = 'pending', attempts = 0,
    lease_owner = null, lease_until = null, available_at = pg_catalog.now(),
    updated_at = pg_catalog.now() where id = any(job_ids);
  update private.long_bot_causal_review_jobs set progress = partial_progress,
    result = timeout_result, updated_at = pg_catalog.now() - interval '31 minutes' where id = job_ids[1];
  update private.long_bot_causal_review_jobs set result = jsonb_build_object('reviews', jsonb_build_array(diagnostic_review)),
    progress = diagnostic_progress, updated_at = pg_catalog.now() where id = job_ids[2];
  claim := public.claim_long_bot_causal_review_slices(worker, d)->0;
  if (claim->>'jobId')::bigint is distinct from job_ids[1] then
    raise exception 'Aged partial cohort starved behind a fresh/cheap job.';
  end if;

  -- For untouched games, immutable ledger size wins over insertion order.
  update private.long_bot_causal_review_jobs set status = 'pending', attempts = 0,
    lease_owner = null, lease_until = null, available_at = pg_catalog.now(),
    updated_at = pg_catalog.now(), result = null, progress = base_progress
    where id = any(job_ids);
  claim := public.claim_long_bot_causal_review_slices(worker, d)->0;
  if (claim->>'jobId')::bigint is distinct from job_ids[2] then
    raise exception 'Short fresh game did not outrank the older longer ledger.';
  end if;

  -- Source identity and leases remain eligibility gates under the new order.
  update private.long_bot_causal_review_jobs set status = 'pending', attempts = 0,
    lease_owner = null, lease_until = null, available_at = pg_catalog.now(),
    updated_at = pg_catalog.now(), result = null, progress = base_progress
    where id = any(job_ids);
  update private.long_bot_causal_review_jobs set archive_fingerprint = repeat('f', 64)
    where id = job_ids[2];
  -- Keep a correct but future-ineligible revision present, so the claim's
  -- missing-enqueue recovery does not create a new selectable job for game 2.
  insert into private.long_bot_causal_review_jobs(
    training_game_id, runtime_digest, archive_fingerprint, available_at)
  values (game_ids[2], d, private.long_bot_causal_archive_fingerprint(second_game),
    pg_catalog.now() + interval '1 day')
  on conflict (training_game_id, runtime_digest, archive_fingerprint) do nothing;
  claim := public.claim_long_bot_causal_review_slices(worker, d)->0;
  if (claim->>'jobId')::bigint is distinct from job_ids[1] then
    raise exception 'Claim ignored the archived-source fingerprint gate.';
  end if;
  if exists (select 1 from private.long_bot_causal_evidence where runtime_digest = d) then
    raise exception 'Scheduling created evidence.';
  end if;
end;
$fair_claim_smoke$;

rollback;
