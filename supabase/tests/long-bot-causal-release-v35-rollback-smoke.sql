-- Synthetic SQL boundary contracts only, NOT rollout/training evidence.
-- Run after the strategy+causal migrations in a disposable transaction.
-- The wrapper guarantees standalone invocation also rolls back. A migration
-- compile harness may strip this wrapper and provide its own BEGIN/ROLLBACK.
-- No real room, profile, rating, game move or production release is modified.
begin;

do $causal_release_contracts$
declare
  game public.bot_training_games;
  game_id uuid := pg_catalog.gen_random_uuid();
  missing_game_id uuid := pg_catalog.gen_random_uuid();
  missing_game public.bot_training_games;
  missing_fp text;
  digest_a text := repeat('a', 64);
  digest_b text := repeat('b', 64);
  digest_legacy text := repeat('c', 64);
  policy_a text := repeat('1', 64);
  policy_b text := repeat('2', 64);
  policy_legacy text := repeat('d', 64);
  worker_id text := 'rollback-causal-release-contracts';
  decision jsonb := '{"id":"rollback-decision","actor":"bot","source":"engine","engineVersion":"long-analytic-v35","selected":{"experience":{"contextKey":"rollback|causal-release","actionKey":"selected:fixture"}},"execution":{"complete":true,"substituted":false,"fallback":false}}'::jsonb;
  fp_a text;
  fp_b text;
  job_a bigint := -900000001;
  job_b bigint;
  job_revision bigint;
  legacy_job bigint := -900000002;
  legacy_result jsonb;
  claim jsonb;
  evidence jsonb;
  review_result jsonb;
  saved_result jsonb;
  patterns jsonb;
  count_before bigint;
  claim_definition text;
  complete_definition text;
begin
  if to_regprocedure('public.claim_long_bot_causal_review_jobs(text,integer)') is not null then
    raise exception 'Unsafe two-argument claim overload is still callable.';
  end if;
  if has_function_privilege('anon', 'public.claim_long_bot_causal_review_jobs(text,integer,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.activate_long_bot_causal_release(text,text,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.claim_long_bot_causal_review_jobs(text,integer,text)', 'EXECUTE')
    or has_table_privilege('service_role', 'private.long_bot_causal_releases', 'UPDATE') then
    raise exception 'Release/claim permissions are not fail-closed.';
  end if;
  claim_definition := pg_catalog.pg_get_functiondef('public.claim_long_bot_causal_review_jobs(text,integer,text)'::regprocedure);
  complete_definition := pg_catalog.pg_get_functiondef('public.complete_long_bot_causal_review_job(bigint,text,jsonb)'::regprocedure);
  if pg_catalog.strpos(claim_definition, 'for share of archived skip locked') = 0
    or pg_catalog.strpos(claim_definition, 'for update of queued skip locked') = 0
    or pg_catalog.strpos(claim_definition, 'for share of archived skip locked') > pg_catalog.strpos(claim_definition, 'for update of queued skip locked')
    or pg_catalog.strpos(complete_definition, 'where archived.id = archive_id for share;') = 0
    or pg_catalog.strpos(complete_definition, 'where archived.id = archive_id for share;') > pg_catalog.strpos(complete_definition, 'where queued.id = p_job_id for update;') then
    raise exception 'Archive-before-job lock ordering is absent from installed RPCs.';
  end if;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.bot_training_games (
    id, room_code, player_name, bot_name, engine_version, difficulty,
    bot_color, winner, decision_count, decisions, final_state
  ) values (
    game_id, 'ROLLBACK-' || game_id::text, 'Synthetic boundary fixture', 'Synthetic boundary fixture',
    'long-analytic-v35', 'hard', 'dark', 'white', 1, jsonb_build_array(decision),
    jsonb_build_object('variant', 'long', 'analysis', jsonb_build_object('botMemory', jsonb_build_object(
      'engineVersion', 'long-analytic-v35', 'decisions', jsonb_build_array(decision),
      'coverage', jsonb_build_object('complete', true, 'expectedBotDecisions', 1,
        'recordedBotDecisions', 1, 'recoveredBotDecisions', 0)
    )))
  );
  select archived.* into game from public.bot_training_games archived where archived.id = game_id;
  fp_a := private.long_bot_causal_archive_fingerprint(game);
  legacy_result := jsonb_build_object('historical', true, 'runtimeDigest', digest_legacy, 'policyImplementationId', policy_legacy);
  insert into private.long_bot_causal_review_jobs(id, training_game_id, status, result)
  overriding system value values (legacy_job, game_id, 'complete', legacy_result);
  insert into private.long_bot_causal_evidence (
    evidence_id, training_game_id, decision_id, state_id, selected_action_id,
    recommended_action_id, context_key, action_key, reviewer_version, runtime_digest, categories, payload
  ) values (
    repeat('f', 64), game_id, 'legacy-decision', repeat('0', 64), repeat('3', 64), repeat('4', 64),
    'rollback|legacy', 'selected:legacy', 'long-server-causal-review-v1', digest_legacy,
    '["tower"]', jsonb_build_object('runtimeDigest', digest_legacy,
      'policyImplementationId', policy_legacy, 'reviewerVersion', 'long-server-causal-review-v1')
  );
  insert into private.long_bot_causal_review_jobs (
    id, training_game_id, runtime_digest, archive_fingerprint, status, attempts, lease_owner, lease_until
  ) overriding system value values (
    job_a, game_id, digest_a, fp_a, 'leased', 1, worker_id, now() + interval '24 hours'
  );
  review_result := jsonb_build_object('schema', 'long-server-causal-review-result-v1',
    'trustDomain', 'nardu/server-long-bot-causal/v1', 'reviewerVersion', 'long-server-causal-review-v1',
    'engineVersion', 'long-analytic-v35', 'runtimeDigest', digest_a, 'policyImplementationId', policy_a,
    'archiveFingerprint', fp_a, 'gameId', game_id::text, 'roomCode', game.room_code,
    'outcomeUsed', false, 'accepted', false, 'evidence', '[]'::jsonb);
  count_before := (select count(*) from private.long_bot_causal_releases);
  begin
    perform public.complete_long_bot_causal_review_job(job_a, worker_id, review_result);
    raise exception 'Completion implicitly approved/consumed an unapproved worker.';
  exception when invalid_parameter_value then null;
  end;
  if (select count(*) from private.long_bot_causal_releases) <> count_before
    or (select status from private.long_bot_causal_review_jobs where id = job_a) <> 'leased' then
    raise exception 'Unapproved completion mutated approval or lease state.';
  end if;
  begin
    perform public.activate_long_bot_causal_release('long-server-causal-review-v1', digest_legacy, repeat('e', 64));
    raise exception 'Original known legacy policy identity was relabelled.';
  exception when invalid_parameter_value then null;
  end;
  perform public.activate_long_bot_causal_release('long-server-causal-review-v1', digest_a, policy_a);
  update private.long_bot_causal_review_jobs set status = 'pending', attempts = 0, lease_owner = null, lease_until = null where id = job_a;
  begin
    perform public.claim_long_bot_causal_review_jobs(worker_id, 1, null);
    raise exception 'NULL runtime claimed work.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.claim_long_bot_causal_review_jobs(worker_id, 1, digest_b);
    raise exception 'Stale runtime claimed another release.';
  exception when invalid_parameter_value then null;
  end;
  if (select attempts from private.long_bot_causal_review_jobs where id = job_a) <> 0 then
    raise exception 'Invalid claim consumed an attempt.';
  end if;
  claim := public.claim_long_bot_causal_review_jobs(worker_id, 1, digest_a)->0;
  if (claim->>'jobId')::bigint <> job_a or claim->>'runtimeDigest' <> digest_a
    or claim->>'policyImplementationId' <> policy_a or claim->>'archiveFingerprint' <> fp_a
    or (claim->>'archiveFingerprintSource')::jsonb <> claim->'trainingGame'
    or pg_catalog.encode(extensions.digest(pg_catalog.convert_to(claim->>'archiveFingerprintSource', 'UTF8'), 'sha256'), 'hex') <> fp_a then
    raise exception 'Claim source/native release metadata is not bound.';
  end if;
  evidence := jsonb_build_object(
    'schema', 'long-server-causal-evidence-v1', 'trustDomain', 'nardu/server-long-bot-causal/v1',
    'reviewerVersion', 'long-server-causal-review-v1', 'engineVersion', 'long-analytic-v35',
    'runtimeDigest', digest_a, 'policyImplementationId', policy_a,
    'trainingGameId', game_id::text, 'roomCode', game.room_code, 'decisionId', 'rollback-decision',
    'stateId', repeat('5', 64), 'selectedActionId', repeat('6', 64), 'recommendedActionId', repeat('7', 64),
    'contextKey', 'rollback|causal-release', 'selectedActionKey', 'selected:fixture',
    'exactExecution', true, 'completeLegalCoverage', true, 'pairedRolloutComplete', true,
    'confidenceBoundsComplete', true, 'recursiveExperience', false, 'outcomeUsed', false,
    'scoreSemantics', 'long-paired-terminal-win-probability-v1', 'confidenceMethod', 'hoeffding-union-bound-v1',
    'rolloutCandidates', '[{},{}]'::jsonb, 'rolloutSampleCount', 32, 'rolloutCandidateCount', 2,
    'rolloutTerminalOutcomes', 64, 'regretLcb', 1, 'regret', 1,
    'recommendedWinProbabilityLcb', 1, 'selectedWinProbabilityUcb', 0,
    'categories', '["missed-home-entry"]'::jsonb
  );
  evidence := evidence || jsonb_build_object('evidenceId', pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.concat_ws(pg_catalog.chr(31), 'nardu/server-long-bot-causal/v1', 'evidence', digest_a,
      game_id::text, 'rollback-decision', repeat('5', 64), repeat('6', 64), repeat('7', 64)), 'UTF8'), 'sha256'), 'hex'));
  review_result := review_result || jsonb_build_object('accepted', true, 'evidence', jsonb_build_array(evidence));
  begin
    perform public.complete_long_bot_causal_review_job(job_a, worker_id, review_result - 'archiveFingerprint');
    raise exception 'Unbound completion source was accepted.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.complete_long_bot_causal_review_job(job_a, worker_id, review_result || jsonb_build_object('policyImplementationId', policy_b));
    raise exception 'Mismatched policy completed another release job.';
  exception when invalid_parameter_value then null;
  end;
  perform public.complete_long_bot_causal_review_job(job_a, worker_id, review_result);
  saved_result := review_result;
  patterns := public.get_long_bot_experience_patterns(null);
  if not exists (select 1 from jsonb_array_elements(patterns) p where p->>'policyImplementationId' = policy_a and p->>'contextKey' = 'rollback|causal-release') then
    raise exception 'Original stored policy SHA was not served.';
  end if;
  begin
    perform public.activate_long_bot_causal_release('long-server-causal-review-v1', digest_a, policy_b);
    raise exception 'Approved digest policy rebinding was accepted.';
  exception when invalid_parameter_value then null;
  end;
  perform public.activate_long_bot_causal_release('long-server-causal-review-v1', digest_b, policy_b);
  select id into job_b from private.long_bot_causal_review_jobs
  where training_game_id = game_id and runtime_digest = digest_b and archive_fingerprint = fp_a;
  -- GENERATED ALWAYS identity cannot be UPDATEd. Move only this newly-created,
  -- unclaimed synthetic job, preserving every field and its logical D/FP
  -- identity. Never reset/remap a completed historical row or a sequence.
  with moved as (
    delete from private.long_bot_causal_review_jobs
    where id = job_b and training_game_id = game_id and status = 'pending'
      and attempts = 0 and result is null
    returning *
  )
  insert into private.long_bot_causal_review_jobs (
    id, training_game_id, runtime_digest, archive_fingerprint, invalidated_at,
    status, attempts, available_at, lease_owner, lease_until, result, last_error,
    created_at, updated_at
  ) overriding system value
  select -900000000, training_game_id, runtime_digest, archive_fingerprint, invalidated_at,
    status, attempts, available_at, lease_owner, lease_until, result, last_error,
    created_at, updated_at from moved;
  if not found then raise exception 'Cannot prioritize a non-fresh synthetic release job.'; end if;
  job_b := -900000000;
  if (select result from private.long_bot_causal_review_jobs where id = job_a) <> saved_result
    or not exists (select 1 from private.long_bot_causal_evidence where training_game_id = game_id and runtime_digest = digest_a and payload->>'policyImplementationId' = policy_a) then
    raise exception 'New release rewrote/deleted original job or evidence.';
  end if;
  if exists (select 1 from jsonb_array_elements(public.get_long_bot_experience_patterns(null)) p where p->>'runtimeDigest' = digest_a) then
    raise exception 'Old digest evidence was relabelled into active policy.';
  end if;
  begin
    perform public.claim_long_bot_causal_review_jobs(worker_id, 1, digest_a);
    raise exception 'Old worker consumed a cold-review job for new digest.';
  exception when invalid_parameter_value then null;
  end;
  if (select attempts from private.long_bot_causal_review_jobs where id = job_b) <> 0 then
    raise exception 'Stale old worker changed a new job attempt.';
  end if;
  claim := public.claim_long_bot_causal_review_jobs(worker_id, 1, digest_b)->0;
  if (claim->>'jobId')::bigint <> job_b then raise exception 'Independent current cold-review job unavailable.'; end if;
  evidence := evidence || jsonb_build_object('runtimeDigest', digest_b, 'policyImplementationId', policy_b,
    'evidenceId', pg_catalog.encode(extensions.digest(pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31),
      'nardu/server-long-bot-causal/v1', 'evidence', digest_b, game_id::text, 'rollback-decision',
      repeat('5', 64), repeat('6', 64), repeat('7', 64)), 'UTF8'), 'sha256'), 'hex'));
  review_result := review_result || jsonb_build_object('runtimeDigest', digest_b, 'policyImplementationId', policy_b, 'evidence', jsonb_build_array(evidence));
  perform public.complete_long_bot_causal_review_job(job_b, worker_id, review_result);
  saved_result := review_result;
  update public.bot_training_games set
    decisions = jsonb_build_array(decision, decision || '{"id":"rollback-decision-duplicate"}'::jsonb),
    decision_count = 2,
    final_state = final_state || jsonb_build_object('revisionRepair', 1, 'analysis', jsonb_build_object('botMemory', jsonb_build_object(
      'engineVersion', 'long-analytic-v35',
      'decisions', jsonb_build_array(decision, decision || '{"id":"rollback-decision-duplicate"}'::jsonb),
      'coverage', jsonb_build_object('complete', true, 'expectedBotDecisions', 2, 'recordedBotDecisions', 2, 'recoveredBotDecisions', 0)
    )))
  where id = game_id;
  select archived.* into game from public.bot_training_games archived where archived.id = game_id;
  fp_b := private.long_bot_causal_archive_fingerprint(game);
  select id into job_revision from private.long_bot_causal_review_jobs
  where training_game_id = game_id and runtime_digest = digest_b and archive_fingerprint = fp_b;
  if fp_a = fp_b or job_revision is null
    or (select result from private.long_bot_causal_review_jobs where id = job_b) <> saved_result
    or not exists (select 1 from private.long_bot_causal_evidence where training_game_id = game_id and runtime_digest = digest_b and archive_fingerprint = fp_a and invalidated_at is not null) then
    raise exception 'Archive repair did not preserve old result/evidence and append a new source revision.';
  end if;
  with moved as (
    delete from private.long_bot_causal_review_jobs
    where id = job_revision and training_game_id = game_id and status = 'pending'
      and attempts = 0 and result is null
    returning *
  )
  insert into private.long_bot_causal_review_jobs (
    id, training_game_id, runtime_digest, archive_fingerprint, invalidated_at,
    status, attempts, available_at, lease_owner, lease_until, result, last_error,
    created_at, updated_at
  ) overriding system value
  select -899999999, training_game_id, runtime_digest, archive_fingerprint, invalidated_at,
    status, attempts, available_at, lease_owner, lease_until, result, last_error,
    created_at, updated_at from moved;
  if not found then raise exception 'Cannot prioritize a non-fresh synthetic revision job.'; end if;
  job_revision := -899999999;
  claim := public.claim_long_bot_causal_review_jobs(worker_id, 1, digest_b)->0;
  if (claim->>'jobId')::bigint <> job_revision then raise exception 'New authoritative archive revision cannot be claimed.'; end if;
  review_result := review_result || jsonb_build_object('archiveFingerprint', fp_b, 'evidence', jsonb_build_array(evidence,
    evidence || jsonb_build_object('decisionId', 'rollback-decision-duplicate', 'evidenceId', pg_catalog.encode(extensions.digest(
      pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31), 'nardu/server-long-bot-causal/v1', 'evidence', digest_b,
        game_id::text, 'rollback-decision-duplicate', repeat('5', 64), repeat('6', 64), repeat('7', 64)), 'UTF8'), 'sha256'), 'hex'))));
  perform public.complete_long_bot_causal_review_job(job_revision, worker_id, review_result);
  if (select count(*) from private.long_bot_causal_evidence where training_game_id = game_id and runtime_digest = digest_b) <> 3 then
    raise exception 'New revision collided with logical evidence identity or deleted history.';
  end if;
  patterns := public.get_long_bot_experience_patterns(null);
  if not exists (select 1 from jsonb_array_elements(patterns) p where p->>'policyImplementationId' = policy_b
    and p->>'contextKey' = 'rollback|causal-release' and p->>'samples' = '1') then
    raise exception 'Repeated exact position/revision became extra independence or lost current policy binding.';
  end if;
  if not exists (select 1 from private.long_bot_causal_review_jobs where id = legacy_job and runtime_digest is null
    and archive_fingerprint is null and result = legacy_result)
    or not exists (select 1 from private.long_bot_causal_evidence where evidence_id = repeat('f', 64) and archive_fingerprint is null and payload->>'policyImplementationId' = policy_legacy) then
    raise exception 'Unknown historical identity was backfilled/rewritten/deleted.';
  end if;
  -- Simulate the exact post-race state without timing hooks/concurrency:
  -- the eligible archive exists, but no job was queued for the still-approved
  -- native D/C pair. No original job/evidence is deleted or reset to arrange it.
  update private.long_bot_causal_runtime set explicitly_approved = false where singleton;
  insert into public.bot_training_games (
    id, room_code, player_name, bot_name, engine_version, difficulty,
    bot_color, winner, decision_count, decisions, final_state
  ) values (
    missing_game_id, 'ROLLBACK-MISSING-' || missing_game_id::text,
    'Synthetic recovery fixture', 'Synthetic recovery fixture',
    game.engine_version, game.difficulty, game.bot_color, game.winner,
    game.decision_count, game.decisions, game.final_state
  );
  update private.long_bot_causal_runtime set explicitly_approved = true where singleton;
  select archived.* into missing_game from public.bot_training_games archived where archived.id = missing_game_id;
  missing_fp := private.long_bot_causal_archive_fingerprint(missing_game);
  if exists (select 1 from private.long_bot_causal_review_jobs where training_game_id = missing_game_id) then
    raise exception 'Missing-enqueue fixture unexpectedly already had a job.';
  end if;
  begin
    perform public.claim_long_bot_causal_review_jobs(worker_id, 1, digest_a);
    raise exception 'Stale worker entered recovery housekeeping.';
  exception when invalid_parameter_value then null;
  end;
  if exists (select 1 from private.long_bot_causal_review_jobs where training_game_id = missing_game_id) then
    raise exception 'Stale worker mutated recovery queue before own-runtime approval gate.';
  end if;
  claim := public.claim_long_bot_causal_review_jobs(worker_id, 1, digest_b);
  if (select count(*) from private.long_bot_causal_review_jobs
      where training_game_id = missing_game_id and runtime_digest = digest_b and archive_fingerprint = missing_fp
        and invalidated_at is null and status in ('pending', 'leased') and attempts between 0 and 1) <> 1 then
    raise exception 'Native claim did not recover missing current-release/source job.';
  end if;
  if (select result from private.long_bot_causal_review_jobs where id = job_b) <> saved_result
    or (select status from private.long_bot_causal_review_jobs where id = job_revision) <> 'complete'
    or (select count(*) from private.long_bot_causal_review_jobs where training_game_id = game_id
      and runtime_digest = digest_b and archive_fingerprint = fp_b) <> 1
    or not exists (select 1 from private.long_bot_causal_releases where runtime_digest = digest_b and policy_implementation_id = policy_b) then
    raise exception 'Recovery housekeeping rewrote historical result or approved policy identity.';
  end if;
  raise notice 'PASS: explicit approval, immutable original SHA, stale claim, per-release cold review, append-only repair, deduplicated positions, legacy quarantine.';
end;
$causal_release_contracts$;

rollback;
