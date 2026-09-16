-- Synthetic RPC boundary tests, NOT genuine learning/rollout evidence.
-- Standalone after strategy+causal+resume, or strip this wrapper inside ONE
-- outer migration compile BEGIN/ROLLBACK. No committed application changes.
begin;

create or replace function pg_temp.causal_resume_result(
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

do $resume_contracts$
declare
  game public.bot_training_games; game_id uuid := gen_random_uuid();
  d text := encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex');
  c text := repeat('8',64); worker text := 'rollback-resumable-worker';
  job_id bigint := -910000001; claim jsonb; slice_progress jsonb; next_progress jsonb;
  partial_result jsonb; finished_result jsonb; final_result jsonb; timeout_review jsonb;
  first_review jsonb; last_review jsonb; evidence_a jsonb; evidence_b jsonb; item jsonb;
  decision_a jsonb; decision_b jsonb; fp text; original_progress jsonb; response jsonb;
  original_evidence_count bigint; old_d text; old_c text; attempts_before integer;
  native_index jsonb; malformed jsonb; n integer;
begin
  if has_function_privilege('anon','public.claim_long_bot_causal_review_slices(text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('service_role','private.complete_long_bot_causal_review_job_internal_v35(bigint,text,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_long_bot_causal_review_slices(text,text)','EXECUTE') then
    raise exception 'Resume RPC/private completion permissions are unsafe.';
  end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  select runtime_digest, policy_implementation_id into old_d, old_c from private.long_bot_causal_runtime where singleton;
  decision_a := '{"id":"resume-first","actor":"bot","color":"DARK","source":"engine","engineVersion":"long-analytic-v35","selected":{"experience":{"contextKey":"resume|fixture","actionKey":"selected:fixture"}},"execution":{"complete":true,"substituted":false,"fallback":false}}';
  decision_b := (decision_a - 'color') || '{"id":"resume-last","actor":"bot"}'::jsonb;
  insert into public.bot_training_games(id,room_code,player_name,bot_name,engine_version,difficulty,bot_color,winner,
    decision_count,decisions,final_state) values(game_id,'RESUME-'||game_id::text,'Synthetic','Synthetic','long-analytic-v35','hard','dark','white',3,
    jsonb_build_array(decision_a,'{"id":"human","color":"white","actor":"bot"}'::jsonb,decision_b),
    jsonb_build_object('variant','long','analysis',jsonb_build_object('botMemory',jsonb_build_object(
      'engineVersion','long-analytic-v35','decisions',jsonb_build_array(decision_a,decision_b),
      'coverage',jsonb_build_object('complete',true,'expectedBotDecisions',2,'recordedBotDecisions',2,'recoveredBotDecisions',0)))));
  select archived.* into game from public.bot_training_games archived where id=game_id;
  native_index := private.long_bot_causal_bot_indexes(game);
  if native_index <> '[0,2]'::jsonb then raise exception 'SQL selector differs from native worker color/actor fallback.'; end if;
  for item in select value from jsonb_array_elements('[false,0,null,""]'::jsonb) loop
    game.decisions := jsonb_build_array(jsonb_build_object('color',item,'actor',item));
    if private.long_bot_causal_bot_indexes(game) <> '[0]'::jsonb then
      raise exception 'SQL selector fails native JS falsy fallback.';
    end if;
  end loop;
  game.decisions := '[{"color":["DARK"],"actor":"human"},{"actor":["bot"]},{"color":true,"actor":"bot"}]';
  if private.long_bot_causal_bot_indexes(game) <> '[0,1]'::jsonb then
    raise exception 'SQL selector fails native JS String(array/boolean) semantics.';
  end if;
  select archived.* into game from public.bot_training_games archived where id=game_id;
  if not private.long_bot_causal_archive_is_eligible(game) then
    raise exception 'Own synthetic smoke archive is not eligible for the real claim path.';
  end if;
  fp := private.long_bot_causal_archive_fingerprint(game);
  insert into private.long_bot_causal_review_jobs(id,training_game_id,runtime_digest,archive_fingerprint)
    overriding system value values(job_id,game_id,d,fp);
  perform public.activate_long_bot_causal_release('long-server-causal-review-v1',d,c);
  claim := public.claim_long_bot_causal_review_slices(worker,d)->0;
  if (claim->>'jobId')::bigint is distinct from job_id or claim->>'archiveFingerprint' is distinct from fp
    or claim->>'runtimeDigest' is distinct from d or claim->>'policyImplementationId' is distinct from c
    or claim->'progress'->>'schema' is distinct from 'long-server-causal-progress-v1' then
    raise exception 'New slice claim loses existing immutable envelope.';
  end if;
  slice_progress := claim->'progress'; original_progress := slice_progress;
  if (select lease_until from private.long_bot_causal_review_jobs where id=job_id) > now()+interval '15 minutes 1 second' then
    raise exception 'Resumable crash retained the legacy whole-game 24-hour lease.';
  end if;
  timeout_review := jsonb_build_object('decisionId','resume-first','positionId','','status','rejected',
    'reason','rollout-time-limit','evidence',null,'outcomeUsed',false,'rollout',jsonb_build_object(
      'coverage',jsonb_build_object('complete',false),
      'terminalJournalObservation',jsonb_build_object('schema','long-bot-terminal-journal-v1','manifestId',repeat('9',64),
        'completedTerminalOutcomes',4,'requiredTerminalOutcomes',64,'sampleCount',32,'candidateCount',2,
        'complete',false,'learningEvidence',false)));
  partial_result := pg_temp.causal_resume_result(game,d,c,'[0]','server-resumable-index',jsonb_build_array(timeout_review),'[]');
  next_progress := slice_progress || jsonb_build_object('currentDecisionIndex',0,'currentTerminalOutcomes',4,'slices',1,'stalledSlices',0);

  -- Native integers, exact prefix, full original coverage and legal cursor.
  for malformed in select value from jsonb_array_elements(jsonb_build_array(
    next_progress||'{"currentDecisionIndex":1}',next_progress||'{"currentDecisionIndex":"0"}',
    next_progress||'{"currentTerminalOutcomes":"4"}',next_progress||'{"slices":1.5}',
    next_progress||'{"extra":true}',next_progress||'{"finishedReviews":[{"decisionIndex":2,"review":{}}]}',
    next_progress||'{"stalledSlices":1}')) loop
    begin
      perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,partial_result,malformed);
      raise exception 'Malformed resumable cursor/coverage was accepted.';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,
      jsonb_set(partial_result,'{reviewCoverage,totalLedgerDecisions}','1'),next_progress);
    raise exception 'Truncated ledger coverage was accepted.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.complete_long_bot_causal_review_job(job_id,worker,partial_result);
    raise exception 'Old complete silently accepted a timeout.';
  exception when invalid_parameter_value then null;
  end;
  if (select progress from private.long_bot_causal_review_jobs where id=job_id) <> original_progress then
    raise exception 'Rejected malformed/checkpoint completion changed progress.';
  end if;
  original_evidence_count := (select count(*) from private.long_bot_causal_evidence);
  response := public.checkpoint_long_bot_causal_review_slice(job_id,worker,partial_result,next_progress);
  if response->>'status'<>'pending' or (select attempts from private.long_bot_causal_review_jobs where id=job_id)<>0
    or (select lease_owner from private.long_bot_causal_review_jobs where id=job_id) is not null
    or (select count(*) from private.long_bot_causal_evidence)<>original_evidence_count then
    raise exception 'Successful partial slice consumed crash attempt or created evidence.';
  end if;
  claim := public.claim_long_bot_causal_review_slices(worker,d)->0;
  if claim->'progress'<>next_progress then raise exception 'Next lease discarded progress.'; end if;
  slice_progress := next_progress;
  -- All raw slots can exist before the official paired statistics/CI were
  -- reconstructed. Save the raw count but publish NOTHING. This test block
  -- deliberately rolls itself back to retain the primary sequence below.
  begin
    malformed := jsonb_set(jsonb_set(partial_result,
      '{reviews,0,rollout,terminalJournalObservation,completedTerminalOutcomes}','64'),
      '{reviews,0,rollout,terminalJournalObservation,complete}','true');
    response := public.checkpoint_long_bot_causal_review_slice(job_id,worker,malformed,
      slice_progress||'{"slices":2,"currentTerminalOutcomes":64,"stalledSlices":0}');
    if response->>'status'<>'pending' or (select count(*) from private.long_bot_causal_evidence)<>original_evidence_count then
      raise exception 'Complete raw slots were mistaken for complete statistical evidence.';
    end if;
    raise exception 'Rollback positive raw-journal edge test.' using errcode='P7001';
  exception when sqlstate 'P7001' then null;
  end;
  begin
    perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,
      jsonb_set(partial_result,'{reviews,0,rollout,terminalJournalObservation,manifestId}',to_jsonb(repeat('0',64))),
      slice_progress||'{"slices":2,"stalledSlices":1}');
    raise exception 'Same original-index slice switched authenticated manifests.';
  exception when invalid_parameter_value then null;
  end;
  -- Budget exhaustion is honest failed/no evidence, not an invented result.
  for n in 1..2 loop
    begin
      update private.long_bot_causal_review_jobs set progress=case when n=1 then slice_progress||'{"slices":9,"stalledSlices":9}'
        else slice_progress||'{"slices":10239,"stalledSlices":0}' end where id=job_id;
      response := public.checkpoint_long_bot_causal_review_slice(job_id,worker,partial_result,
        case when n=1 then slice_progress||'{"slices":10,"stalledSlices":10}'
          else slice_progress||'{"slices":10240,"stalledSlices":1}' end);
      if response->>'status'<>'failed' or (select attempts from private.long_bot_causal_review_jobs where id=job_id)<>0
        or (select count(*) from private.long_bot_causal_evidence)<>original_evidence_count then
        raise exception 'Slice/stall exhaustion consumed crash budget or fabricated evidence.';
      end if;
      raise exception 'Rollback positive budget edge test.' using errcode='P7001';
    exception when sqlstate 'P7001' then null;
    end;
  end loop;
  begin
    perform public.activate_long_bot_causal_release('long-server-causal-review-v1',repeat('4',64),repeat('3',64));
    perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,partial_result,slice_progress||'{"slices":2,"stalledSlices":1}');
    raise exception 'Changed active release accepted a stale slice.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,partial_result||jsonb_build_object('runtimeDigest',repeat('0',64)),
      slice_progress||'{"slices":2,"stalledSlices":1}');
    raise exception 'Foreign worker release saved a slice.';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,partial_result,
      slice_progress||'{"slices":2,"stalledSlices":1,"currentTerminalOutcomes":3}');
    raise exception 'Current terminal count decreased.';
  exception when invalid_parameter_value then null;
  end;
  begin
    malformed := slice_progress||jsonb_build_object('finishedReviews',jsonb_build_array(jsonb_build_object('decisionIndex',0,
      'review',timeout_review||'{"reason":"rollout-runtime-failed"}')),'currentDecisionIndex',2,'currentTerminalOutcomes',0,'slices',2,'stalledSlices',0);
    perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,partial_result,malformed);
    raise exception 'Runtime exception counted as a finished diagnostic decision.';
  exception when invalid_parameter_value then null;
  end;

  -- Both decision IDs describe the SAME state/action observation. Only one
  -- evidence payload is inserted by the retained original dedup path.
  evidence_a := jsonb_build_object('schema','long-server-causal-evidence-v1','trustDomain','nardu/server-long-bot-causal/v1',
    'reviewerVersion','long-server-causal-review-v1','engineVersion','long-analytic-v35','runtimeDigest',d,'policyImplementationId',c,
    'trainingGameId',game_id::text,'roomCode',game.room_code,'decisionId','resume-first','stateId',repeat('5',64),
    'selectedActionId',repeat('6',64),'recommendedActionId',repeat('7',64),'contextKey','resume|fixture','selectedActionKey','selected:fixture',
    'exactExecution',true,'completeLegalCoverage',true,'pairedRolloutComplete',true,'confidenceBoundsComplete',true,
    'recursiveExperience',false,'outcomeUsed',false,'scoreSemantics','long-paired-terminal-win-probability-v1',
    'confidenceMethod','hoeffding-union-bound-v1','rolloutCandidates','[{},{}]'::jsonb,'rolloutSampleCount',32,
    'rolloutCandidateCount',2,'rolloutTerminalOutcomes',64,'regretLcb',1,'regret',1,
    'recommendedWinProbabilityLcb',1,'selectedWinProbabilityUcb',0,'categories','["tower"]'::jsonb);
  evidence_b := evidence_a||'{"decisionId":"resume-last"}';
  evidence_a := evidence_a||jsonb_build_object('evidenceId',encode(extensions.digest(convert_to(concat_ws(chr(31),
    'nardu/server-long-bot-causal/v1','evidence',d,game_id::text,'resume-first',repeat('5',64),repeat('6',64),repeat('7',64)),'UTF8'),'sha256'),'hex'));
  evidence_b := evidence_b||jsonb_build_object('evidenceId',encode(extensions.digest(convert_to(concat_ws(chr(31),
    'nardu/server-long-bot-causal/v1','evidence',d,game_id::text,'resume-last',repeat('5',64),repeat('6',64),repeat('7',64)),'UTF8'),'sha256'),'hex'));
  first_review := jsonb_build_object('decisionId','resume-first','positionId','','status','confirmed-regret','reason','',
    'outcomeUsed',false,'evidence',evidence_a,'rollout',jsonb_build_object('coverage',jsonb_build_object(
      'complete',true,'candidateCount',2,'samplesPerCandidate',32,'terminalOutcomes',64,'completedTerminalOutcomes',64,
      'requiredTerminalOutcomes',64,'commonDiceStreams',true,'frozenPolicy',true,'confidenceBoundsComplete',true,
      'confidenceMethod','hoeffding-union-bound-v1')));
  last_review := first_review||jsonb_build_object('decisionId','resume-last','evidence',evidence_b);
  finished_result := pg_temp.causal_resume_result(game,d,c,'[0]','server-resumable-index',jsonb_build_array(first_review),jsonb_build_array(evidence_a));
  next_progress := slice_progress||jsonb_build_object('finishedReviews',jsonb_build_array(jsonb_build_object('decisionIndex',0,'review',first_review)),
    'currentDecisionIndex',2,'currentTerminalOutcomes',0,'slices',2,'stalledSlices',0);
  perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,finished_result,next_progress);
  if (select count(*) from private.long_bot_causal_evidence)<>original_evidence_count then
    raise exception 'Finished decision was published before full game review.';
  end if;
  claim := public.claim_long_bot_causal_review_slices(worker,d)->0;
  slice_progress := next_progress;
  next_progress := slice_progress||jsonb_build_object('finishedReviews',(slice_progress->'finishedReviews')||
    jsonb_build_array(jsonb_build_object('decisionIndex',2,'review',last_review)),
    'currentDecisionIndex',null,'currentTerminalOutcomes',0,'slices',3,'stalledSlices',0);
  final_result := pg_temp.causal_resume_result(game,d,c,'[0,2]','all-bot-decisions',jsonb_build_array(first_review,last_review),jsonb_build_array(evidence_a));
  begin
    perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,
      final_result||jsonb_build_object('reviews',jsonb_build_array(first_review,timeout_review)),next_progress);
    raise exception 'Final aggregate rewrote finished review.';
  exception when invalid_parameter_value then null;
  end;
  response := public.checkpoint_long_bot_causal_review_slice(job_id,worker,final_result,next_progress);
  if response->>'status'<>'complete' or response->>'inserted'<>'1'
    or (select count(*) from private.long_bot_causal_evidence where training_game_id=game_id)<>1 then
    raise exception 'Full original-ledger completion/dedup failed.';
  end if;
  begin
    perform public.complete_long_bot_causal_review_job(job_id,worker,final_result);
    raise exception 'Already-completed job accepted a repeated lease completion.';
  exception when insufficient_privilege then null;
  end;

  -- Fresh archive revision receives FRESH progress; old completed progress and
  -- evidence history remain source bound. Never mutate/reset old queue rows.
  update public.bot_training_games set room_code=room_code||'-revision' where id=game_id;
  select archived.* into game from public.bot_training_games archived where id=game_id;
  select id into job_id from private.long_bot_causal_review_jobs
    where training_game_id=game_id and runtime_digest=d and archive_fingerprint=private.long_bot_causal_archive_fingerprint(game);
  -- Claim own synthetic revision directly to avoid unrelated deployed jobs.
  update private.long_bot_causal_review_jobs set status='leased',attempts=1,lease_owner=worker,lease_until=now()+interval '24 hours' where id=job_id;
  begin
    perform public.checkpoint_long_bot_causal_review_slice(job_id,worker,partial_result,
      original_progress||'{"currentDecisionIndex":0,"currentTerminalOutcomes":4,"slices":1}');
    raise exception 'Old archive fingerprint saved progress in repaired revision.';
  exception when invalid_parameter_value then null;
  end;
  for n in 1..3 loop
    if n>1 then update private.long_bot_causal_review_jobs set status='leased',attempts=n,lease_owner=worker,lease_until=now()+interval '24 hours' where id=job_id; end if;
    perform public.fail_long_bot_causal_review_job(job_id,worker,'Synthetic process crash, not a saved slice.');
  end loop;
  if (select status from private.long_bot_causal_review_jobs where id=job_id)<>'failed'
    or (select attempts from private.long_bot_causal_review_jobs where id=job_id)<>3 then
    raise exception 'Three crash failures did not exhaust original retry budget.';
  end if;
  raise notice 'Resumable SQL RPC contracts PASS (synthetic, rolled back).';
end;
$resume_contracts$;

rollback;
