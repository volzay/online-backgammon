begin;

-- A COMPLETE, independently confirmed decision must not wait for unrelated
-- later decision cohorts. Partial endpoints, static scores and diagnostics
-- still publish nothing. Keep the current worker D and its durable journals.
do $retain_v36_checkpoint$
begin
  if to_regprocedure('private.checkpoint_long_bot_causal_review_slice_v36(bigint,text,jsonb,jsonb)') is null then
    if to_regprocedure('private.long_bot_causal_valid_rollout_checkpoint(jsonb)') is null then
      raise exception 'Install the authenticated v36 checkpoint contract first.';
    end if;
    alter function public.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb) set schema private;
    alter function private.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb)
      rename to checkpoint_long_bot_causal_review_slice_v36;
  end if;
end;
$retain_v36_checkpoint$;
revoke all on function private.checkpoint_long_bot_causal_review_slice_v36(bigint,text,jsonb,jsonb)
from public, anon, authenticated, service_role;

-- Same strict evidence checks and insert/deduplication as the original
-- completion path. Called ONLY after the v36 checkpoint has validated and
-- persisted the exact complete original-index review in this transaction.
create or replace function private.insert_long_bot_causal_finished_evidence(
  job private.long_bot_causal_review_jobs,
  game public.bot_training_games,
  active private.long_bot_causal_runtime,
  p_result jsonb
)
returns integer language plpgsql security definer set search_path = '' as $$
declare evidence jsonb; matched_decision jsonb; decision_matches integer;
  expected_evidence_id text; affected_count integer; inserted_count integer := 0;
begin
  for evidence in select item from jsonb_array_elements(p_result->'evidence') item
  loop
    if jsonb_typeof(evidence) is distinct from 'object'
       or evidence->>'schema' is distinct from 'long-server-causal-evidence-v1'
       or evidence->>'trustDomain' is distinct from 'nardu/server-long-bot-causal/v1'
       or evidence->>'reviewerVersion' is distinct from active.reviewer_version
       or evidence->>'runtimeDigest' is distinct from active.runtime_digest
       or evidence->>'engineVersion' is distinct from 'long-analytic-v35'
       or evidence->>'policyImplementationId' is distinct from active.policy_implementation_id
       or evidence->>'trainingGameId' is distinct from game.id::text
       or evidence->>'roomCode' is distinct from game.room_code
       or coalesce(evidence->>'evidenceId', '') !~ '^[0-9a-f]{64}$'
       or coalesce(evidence->>'stateId', '') !~ '^[0-9a-f]{64}$'
       or coalesce(evidence->>'selectedActionId', '') !~ '^[0-9a-f]{64}$'
       or coalesce(evidence->>'recommendedActionId', '') !~ '^[0-9a-f]{64}$'
       or evidence->>'selectedActionId' = evidence->>'recommendedActionId'
       or coalesce(evidence->'exactExecution', 'false'::jsonb) <> 'true'::jsonb
       or coalesce(evidence->'completeLegalCoverage', 'false'::jsonb) <> 'true'::jsonb
       or coalesce(evidence->'pairedRolloutComplete', 'false'::jsonb) <> 'true'::jsonb
       or coalesce(evidence->'confidenceBoundsComplete', 'false'::jsonb) <> 'true'::jsonb
       or coalesce(evidence->'recursiveExperience', 'true'::jsonb) <> 'false'::jsonb
       or coalesce(evidence->'outcomeUsed', 'true'::jsonb) <> 'false'::jsonb
       or evidence->>'scoreSemantics' is distinct from 'long-paired-terminal-win-probability-v1'
       or evidence->>'confidenceMethod' is distinct from 'hoeffding-union-bound-v1'
       or jsonb_typeof(evidence->'rolloutCandidates') is distinct from 'array'
       or jsonb_array_length(evidence->'rolloutCandidates') not between 2 and 24
       or coalesce(public.long_bot_safe_numeric(evidence->'rolloutSampleCount'), 0) < 32
       or coalesce(public.long_bot_safe_numeric(evidence->'rolloutSampleCount'), 0) > 128
       or coalesce(public.long_bot_safe_numeric(evidence->'rolloutCandidateCount'), 0) <> jsonb_array_length(evidence->'rolloutCandidates')
       or coalesce(public.long_bot_safe_numeric(evidence->'rolloutTerminalOutcomes'), 0) <>
         public.long_bot_safe_numeric(evidence->'rolloutSampleCount') * public.long_bot_safe_numeric(evidence->'rolloutCandidateCount')
       or coalesce(public.long_bot_safe_numeric(evidence->'regretLcb'), 0) <= 0.08
       or coalesce(public.long_bot_safe_numeric(evidence->'regret'), 0) < public.long_bot_safe_numeric(evidence->'regretLcb')
       or abs(coalesce(
         public.long_bot_safe_numeric(evidence->'recommendedWinProbabilityLcb')
          - public.long_bot_safe_numeric(evidence->'selectedWinProbabilityUcb')
          - public.long_bot_safe_numeric(evidence->'regretLcb'), 1
       )) > 0.000000001
       or jsonb_typeof(evidence->'categories') is distinct from 'array'
       or jsonb_array_length(evidence->'categories') not between 1 and 6
       or exists (
         select 1 from jsonb_array_elements_text(evidence->'categories') category
         where category not in ('missed-home-entry', 'head-fence-exposure', 'released-opponent', 'unsustainable-prime', 'avoidable-home-shuffle', 'tower')
       ) then
      raise exception 'Invalid causal evidence contract.' using errcode = '22023';
    end if;
    select count(*), min(candidate::text)::jsonb
      into decision_matches, matched_decision
    from jsonb_array_elements(game.decisions) candidate
    where candidate->>'id' = evidence->>'decisionId'
      and candidate->>'source' = 'engine'
      and candidate->>'engineVersion' = 'long-analytic-v35';
    if decision_matches <> 1
       or coalesce(matched_decision->'execution'->'complete', 'false'::jsonb) <> 'true'::jsonb
       or coalesce(matched_decision->'execution'->'substituted', 'false'::jsonb) <> 'false'::jsonb
       or coalesce(matched_decision->'execution'->'fallback', 'false'::jsonb) <> 'false'::jsonb
       or evidence->>'contextKey' is distinct from matched_decision->'selected'->'experience'->>'contextKey'
       or evidence->>'selectedActionKey' is distinct from matched_decision->'selected'->'experience'->>'actionKey' then
      raise exception 'Evidence is not linked to exactly one executed archived action.' using errcode = '22023';
    end if;
    expected_evidence_id := pg_catalog.encode(extensions.digest(
      pg_catalog.convert_to(pg_catalog.concat_ws(pg_catalog.chr(31),
        'nardu/server-long-bot-causal/v1', 'evidence', active.runtime_digest,
        game.id::text, evidence->>'decisionId', evidence->>'stateId',
        evidence->>'selectedActionId', evidence->>'recommendedActionId'
      ), 'UTF8'), 'sha256'
    ), 'hex');
    if expected_evidence_id is distinct from evidence->>'evidenceId' then
      raise exception 'Causal evidence SHA-256 identity mismatch.' using errcode = '22023';
    end if;

    insert into private.long_bot_causal_evidence (
      evidence_id, archive_fingerprint, training_game_id, decision_id, state_id,
      selected_action_id, recommended_action_id, context_key, action_key,
      reviewer_version, runtime_digest, categories, payload
    ) values (
      evidence->>'evidenceId', job.archive_fingerprint, game.id, evidence->>'decisionId', evidence->>'stateId',
      evidence->>'selectedActionId', evidence->>'recommendedActionId',
      evidence->>'contextKey', evidence->>'selectedActionKey',
      active.reviewer_version, active.runtime_digest, evidence->'categories', evidence
    ) on conflict do nothing;
    get diagnostics affected_count = row_count;
    inserted_count := inserted_count + affected_count;
  end loop;
  return inserted_count;
end;
$$;
revoke all on function private.insert_long_bot_causal_finished_evidence(
  private.long_bot_causal_review_jobs, public.bot_training_games, private.long_bot_causal_runtime, jsonb)
from public, anon, authenticated, service_role;

create or replace function public.checkpoint_long_bot_causal_review_slice(
  p_job_id bigint, p_worker_id text, p_result jsonb, p_progress jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt jsonb; job private.long_bot_causal_review_jobs;
  game public.bot_training_games; active private.long_bot_causal_runtime;
  finished jsonb; n integer; inserted_count integer := 0;
begin
  -- This call performs the original role/approval/archive/lease checks,
  -- active -> archive -> queue locking, exact immutable-prefix validation,
  -- complete-cohort verification and durable checkpoint. Those locks remain
  -- held until this wrapper commits; any later failure rolls it ALL back.
  receipt := private.checkpoint_long_bot_causal_review_slice_v36(
    p_job_id, p_worker_id, p_result, p_progress);
  if receipt->>'status' <> 'pending' then return receipt; end if;
  if jsonb_array_length(p_result->'reviews') <> 1
    or p_result->'reviews'->0->>'status' is distinct from 'confirmed-regret' then
    return receipt;
  end if;

  select * into job from private.long_bot_causal_review_jobs where id=p_job_id;
  select * into game from public.bot_training_games where id=job.training_game_id;
  select * into active from private.long_bot_causal_runtime where singleton;
  n := jsonb_array_length(job.progress->'finishedReviews');
  finished := job.progress->'finishedReviews'->(n-1);
  if n=0 or finished->'review' is distinct from p_result->'reviews'->0
    or p_result->'evidence' is distinct from jsonb_build_array(finished->'review'->'evidence') then
    raise exception 'Incremental evidence must be the exact persisted complete review.' using errcode = '22023';
  end if;
  perform private.long_bot_causal_validate_finished_review(
    game, (finished->>'decisionIndex')::integer, finished->'review');
  -- Keep uniqueCausalEvidence's original first-observation choice: an alias
  -- later in this ledger is not a second independently sampled lesson.
  if not exists (select 1 from jsonb_array_elements(
    private.long_bot_causal_progress_evidence(job.progress)) candidate
    where candidate = finished->'review'->'evidence') then
    return receipt;
  end if;
  inserted_count := private.insert_long_bot_causal_finished_evidence(job, game, active, p_result);
  return receipt || jsonb_build_object('inserted', inserted_count);
end;
$$;
revoke all on function public.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb)
from public, anon, authenticated;
grant execute on function public.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
