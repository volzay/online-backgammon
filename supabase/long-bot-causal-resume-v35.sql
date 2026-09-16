begin;

-- Apply AFTER strategy-v35 and causal-learning-v35. Progress belongs to one
-- immutable (archive UUID, worker D, archive fingerprint) queue revision.
-- Service RPCs attest worker results; partial journal slots are NOT evidence.
alter table private.long_bot_causal_review_jobs add column if not exists progress jsonb
  not null default '{"schema":"long-server-causal-progress-v1","finishedReviews":[],"currentDecisionIndex":null,"currentTerminalOutcomes":0,"slices":0,"stalledSlices":0}'::jsonb;

create or replace function private.long_bot_causal_native_integer(p_value jsonb, p_min numeric, p_max numeric)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p_value) = 'number'
    and public.long_bot_safe_numeric(p_value) between p_min and p_max
    and public.long_bot_safe_numeric(p_value) = trunc(public.long_bot_safe_numeric(p_value)), false)
$$;

-- EXACT worker botDecision selector, including its empty-color actor fallback.
-- Indices always refer to the ORIGINAL ledger, never a filtered/truncated copy.
create or replace function private.long_bot_causal_js_string(p_value jsonb)
returns text language plpgsql immutable set search_path = '' as $$
begin
  case jsonb_typeof(p_value)
    when 'string' then return p_value #>> '{}';
    when 'null' then return '';
    when 'array' then return coalesce((select string_agg(private.long_bot_causal_js_string(value), ',' order by ordinal)
      from jsonb_array_elements(p_value) with ordinality as entries(value, ordinal)), '');
    when 'object' then return '[object Object]';
    else return coalesce(p_value::text, '');
  end case;
end;
$$;
create or replace function private.long_bot_causal_selector_string(p_value jsonb, p_fallback text)
returns text language sql immutable set search_path = '' as $$
  select case when p_value is null or p_value = 'null'::jsonb or p_value = 'false'::jsonb
    or p_value = '0'::jsonb or p_value = '""'::jsonb then p_fallback
    else private.long_bot_causal_js_string(p_value) end
$$;
create or replace function private.long_bot_causal_bot_indexes(p_game public.bot_training_games)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(ordinality - 1) order by ordinality), '[]'::jsonb)
  from jsonb_array_elements(p_game.decisions) with ordinality as ledger(decision, ordinality)
  where case when coalesce(lower(p_game.bot_color), '') <> ''
    and lower(private.long_bot_causal_selector_string(decision->'color', '')) <> ''
    then lower(private.long_bot_causal_selector_string(decision->'color', '')) = lower(p_game.bot_color)
    else lower(private.long_bot_causal_selector_string(decision->'actor', 'bot')) = 'bot' end
$$;

create or replace function private.long_bot_causal_validate_finished_review(
  p_game public.bot_training_games, p_index integer, p_review jsonb
)
returns void language plpgsql immutable set search_path = '' as $$
declare c jsonb := p_review->'rollout'->'coverage';
begin
  if jsonb_typeof(p_review) is distinct from 'object'
    or p_review->>'decisionId' is distinct from p_game.decisions->p_index->>'id'
    or coalesce(p_review->>'decisionId', '') = ''
    or p_review->>'status' not in ('confirmed-regret', 'no-regret', 'diagnostic-disagreement', 'rejected')
    or p_review->>'status' is null
    or p_review->'outcomeUsed' is distinct from 'false'::jsonb
    or jsonb_typeof(p_review->'reason') is distinct from 'string'
    or p_review->>'reason' in ('rollout-time-limit', 'rollout-runtime-failed')
    or (p_review->>'status' = 'rejected' and p_review->>'reason' = '') then
    raise exception 'Invalid finished original-decision review.' using errcode = '22023';
  end if;
  if p_review->>'status' <> 'rejected' then
    if c->'complete' is distinct from 'true'::jsonb
      or c->'commonDiceStreams' is distinct from 'true'::jsonb
      or c->'frozenPolicy' is distinct from 'true'::jsonb
      or c->'confidenceBoundsComplete' is distinct from 'true'::jsonb
      or c->>'confidenceMethod' is distinct from 'hoeffding-union-bound-v1'
      or not private.long_bot_causal_native_integer(c->'candidateCount', 2, 24)
      or not private.long_bot_causal_native_integer(c->'samplesPerCandidate', 32, 128)
      or not private.long_bot_causal_native_integer(c->'terminalOutcomes', 64, 3072)
      or c->'terminalOutcomes' is distinct from c->'requiredTerminalOutcomes'
      or c->'terminalOutcomes' is distinct from c->'completedTerminalOutcomes'
      or public.long_bot_safe_numeric(c->'terminalOutcomes') <>
        public.long_bot_safe_numeric(c->'candidateCount') * public.long_bot_safe_numeric(c->'samplesPerCandidate') then
      raise exception 'Finished statistical review requires the complete terminal cohort.' using errcode = '22023';
    end if;
  end if;
  if p_review->>'status' = 'confirmed-regret' then
    if jsonb_typeof(p_review->'evidence') is distinct from 'object'
      or p_review->'evidence'->>'decisionId' is distinct from p_review->>'decisionId' then
      raise exception 'Confirmed review evidence identity mismatch.' using errcode = '22023';
    end if;
  elsif p_review->'evidence' is distinct from 'null'::jsonb then
    raise exception 'A diagnostic/non-regret review cannot supply evidence.' using errcode = '22023';
  end if;
end;
$$;

create or replace function private.long_bot_causal_validate_progress(
  p_game public.bot_training_games, p_progress jsonb
)
returns void language plpgsql immutable set search_path = '' as $$
declare indexes jsonb := private.long_bot_causal_bot_indexes(p_game);
  item jsonb; position integer := 0; n integer;
begin
  if jsonb_typeof(p_progress) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_progress)) <> 6
    or not p_progress ?& array['schema','finishedReviews','currentDecisionIndex','currentTerminalOutcomes','slices','stalledSlices']
    or p_progress->>'schema' is distinct from 'long-server-causal-progress-v1'
    or jsonb_typeof(p_progress->'finishedReviews') is distinct from 'array'
    or not private.long_bot_causal_native_integer(p_progress->'currentTerminalOutcomes', 0, 3072)
    or not private.long_bot_causal_native_integer(p_progress->'slices', 0, 10240)
    or not private.long_bot_causal_native_integer(p_progress->'stalledSlices', 0, 10) then
    raise exception 'Invalid native resumable progress contract.' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_progress->'finishedReviews');
  if n > jsonb_array_length(indexes) then
    raise exception 'Finished progress exceeds original bot ledger.' using errcode = '22023';
  end if;
  for item in select value from jsonb_array_elements(p_progress->'finishedReviews') loop
    if jsonb_typeof(item) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(item)) <> 2
      or not item ?& array['decisionIndex','review']
      or item->'decisionIndex' is distinct from indexes->position then
      raise exception 'Finished reviews must be the unchanged ordered original-index prefix.' using errcode = '22023';
    end if;
    perform private.long_bot_causal_validate_finished_review(p_game, (indexes->>position)::integer, item->'review');
    position := position + 1;
  end loop;
  if p_progress->'currentDecisionIndex' is distinct from coalesce(indexes->n, 'null'::jsonb) then
    -- The untouched default derives its first cursor on first claim/checkpoint.
    if not (n = 0 and p_progress->'currentDecisionIndex' = 'null'::jsonb
      and p_progress->'slices' = '0'::jsonb and p_progress->'currentTerminalOutcomes' = '0'::jsonb
      and p_progress->'stalledSlices' = '0'::jsonb) then
      raise exception 'Progress cursor is not the next original bot index.' using errcode = '22023';
    end if;
  end if;
  if n = jsonb_array_length(indexes) and p_progress->'currentTerminalOutcomes' <> '0'::jsonb then
    raise exception 'Completed ledger cannot retain a current terminal count.' using errcode = '22023';
  end if;
end;
$$;

-- Same deterministic de-duplication as uniqueCausalEvidence: exact D/state/
-- selected action is ONE observation even when exported at multiple indices.
create or replace function private.long_bot_causal_progress_evidence(p_progress jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(evidence order by ordinal), '[]'::jsonb) from (
    select distinct on (item->'review'->'evidence'->>'runtimeDigest',
      item->'review'->'evidence'->>'stateId', item->'review'->'evidence'->>'selectedActionId')
      item->'review'->'evidence' as evidence, ordinal
    from jsonb_array_elements(p_progress->'finishedReviews') with ordinality as entries(item, ordinal)
    where item->'review'->>'status' = 'confirmed-regret'
    order by item->'review'->'evidence'->>'runtimeDigest',
      item->'review'->'evidence'->>'stateId', item->'review'->'evidence'->>'selectedActionId', ordinal
  ) deduplicated
$$;

create or replace function private.long_bot_causal_validate_slice_result(
  p_game public.bot_training_games, p_result jsonb, p_indexes jsonb, p_scope text
)
returns void language plpgsql immutable set search_path = '' as $$
declare c jsonb := p_result->'reviewCoverage'; i integer := 0; review jsonb;
  cohorts integer := 0; confirmed integer := 0; no_regret integer := 0;
  disagreement integer := 0; rejected integer := 0;
begin
  if p_result->'accepted' is distinct from 'true'::jsonb
    or p_result->'outcomeUsed' is distinct from 'false'::jsonb
    or p_result->'selection'->'lossesOnly' is distinct from 'true'::jsonb
    or p_result->'selection'->>'outcomeRole' is distinct from 'cohort-filter-only'
    or p_result->'selection'->'outcomeUsedAsDecisionLabel' is distinct from 'false'::jsonb
    or p_result->'selection'->>'policyRole' is distinct from 'current-frozen-cold-re-review'
    or p_result->'selection'->'historicalImplementationAttested' is distinct from 'false'::jsonb
    or jsonb_typeof(p_result->'reviews') is distinct from 'array'
    or jsonb_typeof(p_result->'evidence') is distinct from 'array'
    or c->>'schema' is distinct from 'long-server-game-review-coverage-v1'
    or c->'fullGameEnvelopeValidated' is distinct from 'true'::jsonb
    or c->>'decisionSnapshotsVerified' is distinct from 'reviewed-only'
    or c->>'scope' is distinct from p_scope
    or c->'totalLedgerDecisions' is distinct from to_jsonb(jsonb_array_length(p_game.decisions))
    or c->'totalBotDecisions' is distinct from to_jsonb(jsonb_array_length(private.long_bot_causal_bot_indexes(p_game)))
    or c->'requestedDecisionIndexes' is distinct from p_indexes
    or c->'attemptedDecisionIndexes' is distinct from p_indexes
    or c->'finishedDecisionIndexes' is distinct from p_indexes
    or c->'everyRequestedReviewFinished' is distinct from 'true'::jsonb
    or c->'selectionCoversWholeLedger' is distinct from
      to_jsonb(jsonb_array_length(p_indexes) = jsonb_array_length(private.long_bot_causal_bot_indexes(p_game)))
    or jsonb_array_length(p_result->'reviews') <> jsonb_array_length(p_indexes) then
    raise exception 'Slice result does not cover its exact original-ledger scope.' using errcode = '22023';
  end if;
  for review in select value from jsonb_array_elements(p_result->'reviews') loop
    if review->>'decisionId' is distinct from p_game.decisions->((p_indexes->>i)::integer)->>'id'
      or review->'outcomeUsed' is distinct from 'false'::jsonb then
      raise exception 'Slice original review identity mismatch.' using errcode = '22023';
    end if;
    if review->'rollout'->'coverage'->'complete' = 'true'::jsonb then cohorts := cohorts + 1; end if;
    case review->>'status'
      when 'confirmed-regret' then confirmed := confirmed + 1;
      when 'no-regret' then no_regret := no_regret + 1;
      when 'diagnostic-disagreement' then disagreement := disagreement + 1;
      when 'rejected' then rejected := rejected + 1;
      else raise exception 'Unknown review status.' using errcode = '22023';
    end case;
    i := i + 1;
  end loop;
  if c->'completedOutcomeCohorts' is distinct from to_jsonb(cohorts)
    or p_result->'summary'->'decisionsSeen' is distinct from c->'totalLedgerDecisions'
    or p_result->'summary'->'botDecisionsSeen' is distinct from to_jsonb(i)
    or p_result->'summary'->'confirmedRegret' is distinct from to_jsonb(confirmed)
    or p_result->'summary'->'noRegret' is distinct from to_jsonb(no_regret)
    or p_result->'summary'->'diagnosticDisagreement' is distinct from to_jsonb(disagreement)
    or p_result->'summary'->'rejected' is distinct from to_jsonb(rejected)
    or p_result->'summary'->'evidenceCount' is distinct from to_jsonb(jsonb_array_length(p_result->'evidence')) then
    raise exception 'Slice completed outcome cohort count mismatch.' using errcode = '22023';
  end if;
end;
$$;

-- Keep the original strict evidence insertion/dedup implementation private.
-- Idempotent reapply never renames the new guarded public wrapper.
do $resume_internal_completion$
begin
  if to_regprocedure('private.complete_long_bot_causal_review_job_internal_v35(bigint,text,jsonb)') is null then
    alter function public.complete_long_bot_causal_review_job(bigint,text,jsonb) set schema private;
    alter function private.complete_long_bot_causal_review_job(bigint,text,jsonb) rename to complete_long_bot_causal_review_job_internal_v35;
  end if;
end;
$resume_internal_completion$;
revoke all on function private.complete_long_bot_causal_review_job_internal_v35(bigint,text,jsonb)
from public, anon, authenticated, service_role;

create or replace function public.complete_long_bot_causal_review_job(p_job_id bigint, p_worker_id text, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job private.long_bot_causal_review_jobs; game public.bot_training_games;
  active private.long_bot_causal_runtime; archive_id uuid; indexes jsonb; reviews jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted causal worker role required.' using errcode = '42501';
  end if;
  select configured.* into active from private.long_bot_causal_runtime configured
    join private.long_bot_causal_releases release on release.runtime_digest = configured.runtime_digest
      and release.reviewer_version = configured.reviewer_version and release.policy_implementation_id = configured.policy_implementation_id
    where configured.singleton and configured.explicitly_approved for share of configured, release;
  if active.singleton is null or p_result->>'runtimeDigest' is distinct from active.runtime_digest
    or p_result->>'policyImplementationId' is distinct from active.policy_implementation_id then
    raise exception 'Completion requires the approved immutable release.' using errcode = '22023';
  end if;
  select queued.training_game_id into archive_id from private.long_bot_causal_review_jobs queued where queued.id = p_job_id;
  select archived.* into game from public.bot_training_games archived where archived.id = archive_id for share;
  select queued.* into job from private.long_bot_causal_review_jobs queued where queued.id = p_job_id for update;
  if p_result->'accepted' = 'false'::jsonb then
    if p_result->'evidence' is distinct from '[]'::jsonb
      or p_result->'reviews' is distinct from '[]'::jsonb or coalesce(p_result->>'reason', '') = '' then
      raise exception 'Whole-envelope rejection must contain no decision/evidence claims.' using errcode = '22023';
    end if;
    return private.complete_long_bot_causal_review_job_internal_v35(p_job_id, p_worker_id, p_result);
  end if;
  perform private.long_bot_causal_validate_progress(game, job.progress);
  indexes := private.long_bot_causal_bot_indexes(game);
  if jsonb_array_length(job.progress->'finishedReviews') <> jsonb_array_length(indexes)
    or jsonb_array_length(indexes) = 0 then
    raise exception 'Incomplete ledger cannot be completed.' using errcode = '22023';
  end if;
  select jsonb_agg(item->'review' order by ordinal) into reviews
    from jsonb_array_elements(job.progress->'finishedReviews') with ordinality as entries(item, ordinal);
  perform private.long_bot_causal_validate_slice_result(game, p_result, indexes, 'all-bot-decisions');
  if p_result->'reviews' is distinct from reviews
    or p_result->'evidence' is distinct from private.long_bot_causal_progress_evidence(job.progress) then
    raise exception 'Completion must use the exact persisted finished reviews/evidence.' using errcode = '22023';
  end if;
  return private.complete_long_bot_causal_review_job_internal_v35(p_job_id, p_worker_id, p_result);
end;
$$;

create or replace function public.claim_long_bot_causal_review_slices(p_worker_id text, p_runtime_digest text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare envelopes jsonb; envelope jsonb; progress jsonb; claimed jsonb := '[]'::jsonb;
begin
  envelopes := public.claim_long_bot_causal_review_jobs(p_worker_id, 1, p_runtime_digest);
  for envelope in select value from jsonb_array_elements(envelopes) loop
    -- Isolated service slices are bounded to eight minutes. A killed/OOM
    -- worker must not strand durable progress behind the legacy 24-hour lease.
    -- The original claim retains all approval/archive/job locks in this tx.
    update private.long_bot_causal_review_jobs set lease_until = pg_catalog.now() + interval '15 minutes'
      where id = (envelope->>'jobId')::bigint and status = 'leased' and lease_owner = p_worker_id
        and runtime_digest = p_runtime_digest and invalidated_at is null
        and archive_fingerprint = envelope->>'archiveFingerprint';
    if not found then raise exception 'Slice claim lost its immutable lease.' using errcode = '42501'; end if;
    select queued.progress into progress from private.long_bot_causal_review_jobs queued
      where queued.id = (envelope->>'jobId')::bigint;
    claimed := claimed || jsonb_build_array(envelope || jsonb_build_object('progress', progress));
  end loop;
  return claimed;
end;
$$;

create or replace function public.checkpoint_long_bot_causal_review_slice(
  p_job_id bigint, p_worker_id text, p_result jsonb, p_progress jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job private.long_bot_causal_review_jobs; game public.bot_training_games;
  active private.long_bot_causal_runtime; archive_id uuid; indexes jsonb;
  old_n integer; new_n integer; index_value jsonb; review jsonb; observation jsonb;
  expected_stalled integer; terminal_count integer; is_final boolean; old_item jsonb; position integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted causal worker role required.' using errcode = '42501';
  end if;
  if length(coalesce(p_worker_id, '')) not between 1 and 128 then
    raise exception 'Invalid worker identity.' using errcode = '22023';
  end if;
  select configured.* into active from private.long_bot_causal_runtime configured
    join private.long_bot_causal_releases release on release.runtime_digest = configured.runtime_digest
      and release.reviewer_version = configured.reviewer_version and release.policy_implementation_id = configured.policy_implementation_id
    where configured.singleton and configured.explicitly_approved for share of configured, release;
  if active.singleton is null or p_result->>'runtimeDigest' is distinct from active.runtime_digest
    or p_result->>'reviewerVersion' is distinct from active.reviewer_version
    or p_result->>'policyImplementationId' is distinct from active.policy_implementation_id then
    raise exception 'Checkpoint requires the approved immutable worker/policy release.' using errcode = '22023';
  end if;
  select queued.training_game_id into archive_id from private.long_bot_causal_review_jobs queued where queued.id = p_job_id;
  select archived.* into game from public.bot_training_games archived where archived.id = archive_id for share;
  select queued.* into job from private.long_bot_causal_review_jobs queued where queued.id = p_job_id for update;
  if job.id is null or job.training_game_id is distinct from game.id
    or job.status <> 'leased' or job.lease_owner is distinct from p_worker_id
    or job.lease_until is null or job.lease_until < pg_catalog.now() then
    raise exception 'Causal review lease is not owned by this worker.' using errcode = '42501';
  end if;
  if job.invalidated_at is not null or job.runtime_digest is distinct from active.runtime_digest
    or job.archive_fingerprint is null or job.archive_fingerprint is distinct from private.long_bot_causal_archive_fingerprint(game)
    or p_result->>'archiveFingerprint' is distinct from job.archive_fingerprint
    or not private.long_bot_causal_archive_is_eligible(game) then
    raise exception 'Training archive/release changed after the worker claim.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_result) is distinct from 'object'
    or p_result->>'schema' is distinct from 'long-server-causal-review-result-v1'
    or p_result->>'trustDomain' is distinct from 'nardu/server-long-bot-causal/v1'
    or p_result->>'engineVersion' is distinct from 'long-analytic-v35'
    or p_result->>'gameId' is distinct from game.id::text or p_result->>'roomCode' is distinct from game.room_code then
    raise exception 'Invalid checkpoint result identity.' using errcode = '22023';
  end if;
  perform private.long_bot_causal_validate_progress(game, job.progress);
  perform private.long_bot_causal_validate_progress(game, p_progress);
  indexes := private.long_bot_causal_bot_indexes(game);
  old_n := jsonb_array_length(job.progress->'finishedReviews');
  new_n := jsonb_array_length(p_progress->'finishedReviews');
  if old_n >= jsonb_array_length(indexes) or new_n not between old_n and old_n + 1
    or job.progress->'slices' = '10240'::jsonb or job.progress->'stalledSlices' = '10'::jsonb
    or (p_progress->>'slices')::integer <> (job.progress->>'slices')::integer + 1 then
    raise exception 'Invalid/exhausted resumable slice transition.' using errcode = '22023';
  end if;
  for old_item in select value from jsonb_array_elements(job.progress->'finishedReviews') loop
    if old_item is distinct from p_progress->'finishedReviews'->position then
      raise exception 'A checkpoint cannot rewrite any previous review.' using errcode = '22023';
    end if;
    position := position + 1;
  end loop;
  index_value := indexes->old_n;
  is_final := new_n = jsonb_array_length(indexes);
  if is_final then
    perform private.long_bot_causal_validate_slice_result(game, p_result, indexes, 'all-bot-decisions');
    review := p_result->'reviews'->old_n;
  else
    perform private.long_bot_causal_validate_slice_result(game, p_result, jsonb_build_array(index_value), 'server-resumable-index');
    review := p_result->'reviews'->0;
  end if;
  if new_n = old_n + 1 then
    if p_progress->'finishedReviews'->old_n->'review' is distinct from review
      or p_progress->'currentTerminalOutcomes' <> '0'::jsonb then
      raise exception 'Finished checkpoint must persist the exact review and reset next-index terminal count.' using errcode = '22023';
    end if;
    expected_stalled := 0;
    if not is_final and p_result->'evidence' is distinct from
      (case when review->>'status' = 'confirmed-regret' then jsonb_build_array(review->'evidence') else '[]'::jsonb end) then
      raise exception 'Finished slice evidence must match its complete original-index review.' using errcode = '22023';
    end if;
  else
    if review->>'status' is distinct from 'rejected' or review->>'reason' is distinct from 'rollout-time-limit'
      or review->'evidence' is distinct from 'null'::jsonb or p_result->'evidence' is distinct from '[]'::jsonb
      or review->'rollout'->'coverage'->'complete' is distinct from 'false'::jsonb then
      raise exception 'Only an evidence-free terminal rollout timeout may remain unfinished.' using errcode = '22023';
    end if;
    observation := review->'rollout'->'terminalJournalObservation';
    if jsonb_typeof(observation) is distinct from 'object'
      or observation->>'schema' is distinct from 'long-bot-terminal-journal-v1'
      or coalesce(observation->>'manifestId', '') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(observation->'complete') is distinct from 'boolean'
      or observation->'learningEvidence' is distinct from 'false'::jsonb
      or not private.long_bot_causal_native_integer(observation->'sampleCount', 32, 128)
      or not private.long_bot_causal_native_integer(observation->'candidateCount', 2, 24)
      or not private.long_bot_causal_native_integer(observation->'requiredTerminalOutcomes', 64, 3072)
      or not private.long_bot_causal_native_integer(observation->'completedTerminalOutcomes', 0, 3072)
      or public.long_bot_safe_numeric(observation->'requiredTerminalOutcomes') <>
        public.long_bot_safe_numeric(observation->'sampleCount') * public.long_bot_safe_numeric(observation->'candidateCount')
      or public.long_bot_safe_numeric(observation->'completedTerminalOutcomes') > public.long_bot_safe_numeric(observation->'requiredTerminalOutcomes')
      or observation->'complete' is distinct from to_jsonb(public.long_bot_safe_numeric(observation->'completedTerminalOutcomes') =
        public.long_bot_safe_numeric(observation->'requiredTerminalOutcomes'))
      or p_progress->'currentTerminalOutcomes' is distinct from observation->'completedTerminalOutcomes' then
      raise exception 'Partial checkpoint requires the actual incomplete authenticated journal observation.' using errcode = '22023';
    end if;
    terminal_count := (p_progress->>'currentTerminalOutcomes')::integer;
    if job.result->'reviews'->0->>'reason' = 'rollout-time-limit'
      and job.result->'reviewCoverage'->'requestedDecisionIndexes' = jsonb_build_array(index_value)
      and job.result->'reviews'->0->'rollout'->'terminalJournalObservation'->>'manifestId' is distinct from observation->>'manifestId' then
      raise exception 'Current-index journal manifest cannot change between slices.' using errcode = '22023';
    end if;
    if terminal_count < (job.progress->>'currentTerminalOutcomes')::integer then
      raise exception 'Current-index terminal progress cannot decrease.' using errcode = '22023';
    end if;
    expected_stalled := case when terminal_count > (job.progress->>'currentTerminalOutcomes')::integer then 0
      else (job.progress->>'stalledSlices')::integer + 1 end;
  end if;
  if (p_progress->>'stalledSlices')::integer <> expected_stalled then
    raise exception 'Invalid stalled slice counter.' using errcode = '22023';
  end if;
  update private.long_bot_causal_review_jobs set progress = p_progress where id = job.id;
  if is_final then
    return public.complete_long_bot_causal_review_job(p_job_id, p_worker_id, p_result);
  end if;
  update private.long_bot_causal_review_jobs
    set status = case when (p_progress->>'slices')::integer >= 10240 or expected_stalled >= 10 then 'failed' else 'pending' end,
      attempts = greatest(attempts - 1, 0), available_at = pg_catalog.now(), lease_owner = null, lease_until = null,
      result = p_result, last_error = case when (p_progress->>'slices')::integer >= 10240 or expected_stalled >= 10
        then 'Resumable causal review exhausted its bounded slice/stall budget.' else null end, updated_at = pg_catalog.now()
    where id = job.id;
  return jsonb_build_object('ok', true, 'inserted', 0, 'status', case when (p_progress->>'slices')::integer >= 10240 or expected_stalled >= 10
    then 'failed' else 'pending' end, 'progress', p_progress);
end;
$$;

revoke all on function private.long_bot_causal_native_integer(jsonb,numeric,numeric),
  private.long_bot_causal_js_string(jsonb), private.long_bot_causal_selector_string(jsonb,text),
  private.long_bot_causal_bot_indexes(public.bot_training_games),
  private.long_bot_causal_validate_finished_review(public.bot_training_games,integer,jsonb),
  private.long_bot_causal_validate_progress(public.bot_training_games,jsonb),
  private.long_bot_causal_progress_evidence(jsonb),
  private.long_bot_causal_validate_slice_result(public.bot_training_games,jsonb,jsonb,text)
from public, anon, authenticated, service_role;
revoke all on function public.claim_long_bot_causal_review_slices(text,text),
  public.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb),
  public.complete_long_bot_causal_review_job(bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.claim_long_bot_causal_review_slices(text,text),
  public.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb),
  public.complete_long_bot_causal_review_job(bigint,text,jsonb) to service_role;

commit;
