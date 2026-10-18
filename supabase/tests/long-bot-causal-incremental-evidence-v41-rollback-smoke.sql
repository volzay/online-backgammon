-- Synthetic RPC contract fixtures ONLY, never genuine learned evidence.
-- All temporary archives, releases, evidence and public patterns ROLLBACK.
begin;

create or replace function pg_temp.causal_incremental_result(
  p_game public.bot_training_games, p_d text, p_c text, p_indexes jsonb,
  p_scope text, p_reviews jsonb, p_evidence jsonb
) returns jsonb language sql as $$
select jsonb_build_object(
  'schema','long-server-causal-review-result-v1','trustDomain','nardu/server-long-bot-causal/v1',
  'reviewerVersion','long-server-causal-review-v1','engineVersion','long-analytic-v35',
  'runtimeDigest',p_d,'policyImplementationId',p_c,'archiveFingerprint',private.long_bot_causal_archive_fingerprint(p_game),
  'gameId',p_game.id::text,'roomCode',p_game.room_code,'accepted',true,'reason','','outcomeUsed',false,
  'selection',jsonb_build_object('lossesOnly',true,'outcomeRole','cohort-filter-only',
    'outcomeUsedAsDecisionLabel',false,'policyRole','current-frozen-cold-re-review','historicalImplementationAttested',false),
  'reviewCoverage',jsonb_build_object('schema','long-server-game-review-coverage-v1','fullGameEnvelopeValidated',true,
    'decisionSnapshotsVerified','reviewed-only','scope',p_scope,'totalLedgerDecisions',jsonb_array_length(p_game.decisions),
    'totalBotDecisions',jsonb_array_length(private.long_bot_causal_bot_indexes(p_game)),
    'requestedDecisionIndexes',p_indexes,'attemptedDecisionIndexes',p_indexes,'finishedDecisionIndexes',p_indexes,
    'completedOutcomeCohorts',(select count(*) from jsonb_array_elements(p_reviews) r where r->'rollout'->'coverage'->'complete'='true'::jsonb),
    'selectionCoversWholeLedger',jsonb_array_length(p_indexes)=jsonb_array_length(private.long_bot_causal_bot_indexes(p_game)),
    'everyRequestedReviewFinished',true),
  'summary',jsonb_build_object('decisionsSeen',jsonb_array_length(p_game.decisions),'botDecisionsSeen',jsonb_array_length(p_indexes),
    'confirmedRegret',(select count(*) from jsonb_array_elements(p_reviews) r where r->>'status'='confirmed-regret'),
    'noRegret',(select count(*) from jsonb_array_elements(p_reviews) r where r->>'status'='no-regret'),
    'diagnosticDisagreement',(select count(*) from jsonb_array_elements(p_reviews) r where r->>'status'='diagnostic-disagreement'),
    'rejected',(select count(*) from jsonb_array_elements(p_reviews) r where r->>'status'='rejected'),
    'evidenceCount',jsonb_array_length(p_evidence)), 'reviews',p_reviews,'evidence',p_evidence)
$$;

do $incremental_contracts$
declare
  game public.bot_training_games; game_id uuid := gen_random_uuid();
  d text := encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex');
  c text := repeat('8',64); worker text := 'rollback-v41-worker';
  claim jsonb; job_id bigint; decision_a jsonb; decision_b jsonb; evidence_a jsonb;
  candidate jsonb; first_review jsonb; last_review jsonb; bad_review jsonb;
  coverage jsonb; original_progress jsonb; next_progress jsonb; response jsonb;
  result jsonb; before_count bigint; epsilon numeric;
begin
  if has_function_privilege('service_role',
      'private.checkpoint_long_bot_causal_review_slice_v36(bigint,text,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('service_role',
      'private.insert_long_bot_causal_finished_evidence(private.long_bot_causal_review_jobs,public.bot_training_games,private.long_bot_causal_runtime,jsonb)','EXECUTE')
    or has_function_privilege('authenticated',
      'public.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb)','EXECUTE') then
    raise exception 'Incremental private helpers leaked.';
  end if;
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin
    perform public.checkpoint_long_bot_causal_review_slice(-1,worker,'{}','{}');
    raise exception 'Untrusted incremental checkpoint accepted.';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform set_config('request.jwt.claim.role','service_role',true);
  decision_a := '{"id":"incremental-first","actor":"bot","color":"dark","source":"engine","engineVersion":"long-analytic-v35","selected":{"experience":{"contextKey":"rollback|incremental","actionKey":"selected:fixture"}},"execution":{"complete":true,"substituted":false,"fallback":false}}';
  decision_b := decision_a || '{"id":"incremental-last"}'::jsonb;
  insert into public.bot_training_games(id,room_code,player_name,bot_name,engine_version,difficulty,bot_color,winner,
    decision_count,decisions,final_state)
  values(game_id,'INCREMENTAL-'||game_id::text,'Synthetic','Synthetic','long-analytic-v35','hard','dark','white',2,
    jsonb_build_array(decision_a,decision_b),jsonb_build_object('variant','long','analysis',jsonb_build_object(
      'botMemory',jsonb_build_object('engineVersion','long-analytic-v35','decisions',jsonb_build_array(decision_a,decision_b),
        'coverage',jsonb_build_object('complete',true,'expectedBotDecisions',2,'recordedBotDecisions',2,'recoveredBotDecisions',0)))));
  select * into game from public.bot_training_games where id=game_id;
  perform public.activate_long_bot_causal_release('long-server-causal-review-v1',d,c);
  claim := public.claim_long_bot_causal_review_slices(worker,d)->0;
  job_id := (claim->>'jobId')::bigint;
  if claim->'trainingGame'->>'id' is distinct from game_id::text then
    raise exception 'Own incremental fixture was not claimed.';
  end if;
  original_progress := claim->'progress';
  select count(*) into before_count from private.long_bot_causal_evidence;
  epsilon := sqrt(ln(4/0.05)/(2*32));
  evidence_a := jsonb_build_object('schema','long-server-causal-evidence-v1',
    'trustDomain','nardu/server-long-bot-causal/v1','reviewerVersion','long-server-causal-review-v1',
    'engineVersion','long-analytic-v35','runtimeDigest',d,'policyImplementationId',c,
    'trainingGameId',game_id::text,'roomCode',game.room_code,'decisionId','incremental-first',
    'stateId',repeat('1',64),'selectedActionId',repeat('2',64),'recommendedActionId',repeat('3',64),
    'contextKey','rollback|incremental','selectedActionKey','selected:fixture',
    'exactExecution',true,'completeLegalCoverage',true,'pairedRolloutComplete',true,
    'confidenceBoundsComplete',true,'recursiveExperience',false,'outcomeUsed',false,
    'scoreSemantics','long-paired-terminal-win-probability-v1','confidenceMethod','hoeffding-union-bound-v1',
    'rolloutSampleCount',32,'rolloutCandidateCount',2,'rolloutTerminalOutcomes',64,
    'regret',1,'regretLcb',1-2*epsilon,'selectedWinProbabilityUcb',epsilon,
    'recommendedWinProbabilityLcb',1-epsilon,'categories',jsonb_build_array('missed-home-entry'),
    'rolloutCandidates',jsonb_build_array(
      jsonb_build_object('positionKey','fixture-selected','wins',0,'samples',32,'probability',0,'lower',0,'upper',epsilon),
      jsonb_build_object('positionKey','fixture-recommended','wins',32,'samples',32,'probability',1,'lower',1-epsilon,'upper',1)));
  evidence_a := evidence_a || jsonb_build_object('evidenceId',encode(extensions.digest(convert_to(concat_ws(chr(31),
    'nardu/server-long-bot-causal/v1','evidence',d,game_id::text,'incremental-first',repeat('1',64),repeat('2',64),repeat('3',64)),
    'UTF8'),'sha256'),'hex'));
  coverage := jsonb_build_object('complete',true,'commonDiceStreams',true,'frozenPolicy',true,
    'confidenceBoundsComplete',true,'confidenceMethod','hoeffding-union-bound-v1',
    'candidateCount',2,'samplesPerCandidate',32,'terminalOutcomes',64,
    'requiredTerminalOutcomes',64,'completedTerminalOutcomes',64);
  first_review := jsonb_build_object('decisionId','incremental-first','positionId','fixture',
    'status','confirmed-regret','reason','','outcomeUsed',false,'evidence',evidence_a,
    'rollout',jsonb_build_object('coverage',coverage));

  -- A private insertion failure must roll back the preceding durable progress
  -- update, including lease release. No partial result may leak a pattern.
  for candidate in select value from jsonb_array_elements(jsonb_build_array(
    evidence_a||'{"pairedRolloutComplete":false}',evidence_a||'{"contextKey":"wrong"}',
    evidence_a||jsonb_build_object('evidenceId',repeat('9',64)),
    evidence_a||'{"rolloutSampleCount":31}',evidence_a||'{"regretLcb":0.08}',
    evidence_a||jsonb_build_object('runtimeDigest',repeat('4',64)))) loop
    bad_review := first_review || jsonb_build_object('evidence',candidate);
    result := pg_temp.causal_incremental_result(game,d,c,'[0]','server-resumable-index',
      jsonb_build_array(bad_review),jsonb_build_array(candidate));
    next_progress := original_progress || jsonb_build_object('finishedReviews',jsonb_build_array(
      jsonb_build_object('decisionIndex',0,'review',bad_review)),
      'currentDecisionIndex',1,'slices',1);
    begin
      perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,result,next_progress);
      raise exception 'Invalid incremental evidence was accepted.';
    exception when invalid_parameter_value then null;
    end;
    if (select progress from private.long_bot_causal_review_jobs where id=job_id) is distinct from original_progress
      or (select status from private.long_bot_causal_review_jobs where id=job_id)<>'leased'
      or (select count(*) from private.long_bot_causal_evidence)<>before_count then
      raise exception 'Failed publication changed the checkpoint or evidence.';
    end if;
  end loop;

  result := pg_temp.causal_incremental_result(game,d,c,'[0]','server-resumable-index',
    jsonb_build_array(first_review),jsonb_build_array(evidence_a));
  next_progress := original_progress || jsonb_build_object('finishedReviews',jsonb_build_array(
    jsonb_build_object('decisionIndex',0,'review',first_review)),'currentDecisionIndex',1,'slices',1);
  response := public.checkpoint_long_bot_causal_review_slice(job_id,worker,result,next_progress);
  if response->>'status'<>'pending' or response->>'inserted'<>'1'
    or (select status from private.long_bot_causal_review_jobs where id=job_id)<>'pending'
    or (select count(*) from private.long_bot_causal_evidence)<>before_count+1 then
    raise exception 'Complete decision lesson was withheld until the whole game.';
  end if;
  if not exists(select 1 from jsonb_array_elements(public.get_long_bot_experience_patterns()) pattern
    where pattern->>'contextKey'='rollback|incremental' and pattern->>'samples'='1') then
    raise exception 'Incremental lesson is absent from the public aggregate.';
  end if;
  claim := public.claim_long_bot_causal_review_slices(worker,d)->0;
  if (claim->>'jobId')::bigint<>job_id then raise exception 'Incomplete job was lost after publishing.'; end if;
  begin
    perform public.complete_long_bot_causal_review_job(job_id,worker,result);
    raise exception 'Incremental publication bypassed whole-ledger completion.';
  exception when invalid_parameter_value then null;
  end;
  last_review := first_review || jsonb_build_object('decisionId','incremental-last','status','no-regret','evidence',null);
  result := pg_temp.causal_incremental_result(game,d,c,'[0,1]','all-bot-decisions',
    jsonb_build_array(first_review,last_review),jsonb_build_array(evidence_a));
  next_progress := next_progress || jsonb_build_object('finishedReviews',jsonb_build_array(
    jsonb_build_object('decisionIndex',0,'review',first_review),jsonb_build_object('decisionIndex',1,'review',last_review)),
    'currentDecisionIndex',null,'slices',2);
  response := public.checkpoint_long_bot_causal_review_slice(job_id,worker,result,next_progress);
  if response->>'status'<>'complete' or response->>'inserted'<>'0'
    or (select count(*) from private.long_bot_causal_evidence)<>before_count+1 then
    raise exception 'Whole-game completion duplicated incremental evidence.';
  end if;
  update public.bot_training_games set final_state=final_state||'{"fixtureRepair":true}' where id=game_id;
  if exists(select 1 from jsonb_array_elements(public.get_long_bot_experience_patterns()) pattern
    where pattern->>'contextKey'='rollback|incremental') then
    raise exception 'Source repair did not quarantine incremental evidence.';
  end if;
end;
$incremental_contracts$;
rollback;
