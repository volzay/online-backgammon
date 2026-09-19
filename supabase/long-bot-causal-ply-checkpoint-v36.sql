begin;

-- Per-ply authenticated rollout resume. Apply only while the causal worker is
-- stopped: a v1 row has no mid-game state and can be upgraded only at its last
-- durable complete-terminal boundary.
lock table private.long_bot_causal_review_jobs in share row exclusive mode;

do $migrate_safe_v1_progress$
declare queued record; archived public.bot_training_games;
begin
  if exists (select 1 from private.long_bot_causal_review_jobs where status = 'leased') then
    raise exception 'Stop the causal worker before upgrading rollout progress.' using errcode = '55006';
  end if;
  for queued in select id, training_game_id, progress from private.long_bot_causal_review_jobs
    where progress->>'schema' = 'long-server-causal-progress-v1' for update
  loop
    select game.* into archived from public.bot_training_games game where game.id = queued.training_game_id;
    perform private.long_bot_causal_validate_progress(archived, queued.progress);
    update private.long_bot_causal_review_jobs
      set progress = (queued.progress - 'schema') || jsonb_build_object(
        'schema', 'long-server-causal-progress-v2', 'currentRolloutCheckpoint', null)
      where id = queued.id;
  end loop;
end;
$migrate_safe_v1_progress$;

alter table private.long_bot_causal_review_jobs alter column progress set default
  '{"schema":"long-server-causal-progress-v2","finishedReviews":[],"currentDecisionIndex":null,"currentTerminalOutcomes":0,"currentRolloutCheckpoint":null,"slices":0,"stalledSlices":0}'::jsonb;

create or replace function private.long_bot_causal_valid_rollout_checkpoint(p_checkpoint jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_checkpoint = 'null'::jsonb then return true; end if;
  return coalesce(jsonb_typeof(p_checkpoint) = 'object'
    and (select count(*) from jsonb_object_keys(p_checkpoint)) = 7
    and p_checkpoint ?& array['manifestId','sampleIndex','candidateIndex','candidateId','plies','checkpointHash','stateHash']
    and coalesce(p_checkpoint->>'manifestId', '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_checkpoint->>'candidateId', '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_checkpoint->>'checkpointHash', '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_checkpoint->>'stateHash', '') ~ '^[0-9a-f]{64}$'
    and private.long_bot_causal_native_integer(p_checkpoint->'sampleIndex', 0, 127)
    and private.long_bot_causal_native_integer(p_checkpoint->'candidateIndex', 0, 23)
    and private.long_bot_causal_native_integer(p_checkpoint->'plies', 1, 599), false);
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
    or (select count(*) from jsonb_object_keys(p_progress)) <> 7
    or not p_progress ?& array['schema','finishedReviews','currentDecisionIndex','currentTerminalOutcomes',
      'currentRolloutCheckpoint','slices','stalledSlices']
    or p_progress->>'schema' is distinct from 'long-server-causal-progress-v2'
    or jsonb_typeof(p_progress->'finishedReviews') is distinct from 'array'
    or not private.long_bot_causal_native_integer(p_progress->'currentTerminalOutcomes', 0, 3072)
    or not private.long_bot_causal_valid_rollout_checkpoint(p_progress->'currentRolloutCheckpoint')
    or not private.long_bot_causal_native_integer(p_progress->'slices', 0, 10240)
    or not private.long_bot_causal_native_integer(p_progress->'stalledSlices', 0, 10) then
    raise exception 'Invalid per-ply resumable progress contract.' using errcode = '22023';
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
    if not (n = 0 and p_progress->'currentDecisionIndex' = 'null'::jsonb
      and p_progress->'slices' = '0'::jsonb and p_progress->'currentTerminalOutcomes' = '0'::jsonb
      and p_progress->'currentRolloutCheckpoint' = 'null'::jsonb
      and p_progress->'stalledSlices' = '0'::jsonb) then
      raise exception 'Progress cursor is not the next original bot index.' using errcode = '22023';
    end if;
  end if;
  if n = jsonb_array_length(indexes) and (p_progress->'currentTerminalOutcomes' <> '0'::jsonb
    or p_progress->'currentRolloutCheckpoint' <> 'null'::jsonb) then
    raise exception 'Completed ledger cannot retain terminal or in-game progress.' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.checkpoint_long_bot_causal_review_slice(
  p_job_id bigint, p_worker_id text, p_result jsonb, p_progress jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job private.long_bot_causal_review_jobs; game public.bot_training_games;
  active private.long_bot_causal_runtime; archive_id uuid; indexes jsonb;
  old_n integer; new_n integer; index_value jsonb; review jsonb; observation jsonb;
  expected_stalled integer; terminal_count integer; old_terminal_count integer; is_final boolean;
  old_item jsonb; position integer := 0; old_checkpoint jsonb; new_checkpoint jsonb;
  checkpoint_advanced boolean := false;
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
      or p_progress->'currentTerminalOutcomes' <> '0'::jsonb
      or p_progress->'currentRolloutCheckpoint' <> 'null'::jsonb then
      raise exception 'Finished checkpoint must persist the exact review and reset rollout progress.' using errcode = '22023';
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
    new_checkpoint := observation->'activeCheckpoint';
    if jsonb_typeof(observation) is distinct from 'object'
      or observation->>'schema' is distinct from 'long-bot-terminal-journal-v1'
      or coalesce(observation->>'manifestId', '') !~ '^[0-9a-f]{64}$'
      or not (observation ? 'activeCheckpoint')
      or not private.long_bot_causal_valid_rollout_checkpoint(new_checkpoint)
      or (new_checkpoint <> 'null'::jsonb and new_checkpoint->>'manifestId' is distinct from observation->>'manifestId')
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
      or p_progress->'currentTerminalOutcomes' is distinct from observation->'completedTerminalOutcomes'
      or p_progress->'currentRolloutCheckpoint' is distinct from new_checkpoint then
      raise exception 'Partial checkpoint requires the actual authenticated in-game journal observation.' using errcode = '22023';
    end if;
    if new_checkpoint <> 'null'::jsonb and (
      new_checkpoint->'sampleIndex' is distinct from review->'rollout'->'coverage'->'sample'
      or new_checkpoint->'candidateIndex' is distinct from review->'rollout'->'coverage'->'currentCandidateIndex') then
      raise exception 'Active checkpoint does not match the interrupted cohort cursor.' using errcode = '22023';
    end if;
    terminal_count := (p_progress->>'currentTerminalOutcomes')::integer;
    old_terminal_count := (job.progress->>'currentTerminalOutcomes')::integer;
    old_checkpoint := job.progress->'currentRolloutCheckpoint';
    if job.result->'reviews'->0->>'reason' = 'rollout-time-limit'
      and job.result->'reviewCoverage'->'requestedDecisionIndexes' = jsonb_build_array(index_value)
      and job.result->'reviews'->0->'rollout'->'terminalJournalObservation'->>'manifestId' is distinct from observation->>'manifestId' then
      raise exception 'Current-index journal manifest cannot change between slices.' using errcode = '22023';
    end if;
    if terminal_count < old_terminal_count then
      raise exception 'Current-index terminal progress cannot decrease.' using errcode = '22023';
    elsif terminal_count = old_terminal_count then
      if old_checkpoint = 'null'::jsonb and new_checkpoint <> 'null'::jsonb then
        checkpoint_advanced := true;
      elsif old_checkpoint <> 'null'::jsonb and new_checkpoint = 'null'::jsonb then
        raise exception 'Active rollout checkpoint disappeared without a completed endpoint.' using errcode = '22023';
      elsif old_checkpoint <> 'null'::jsonb then
        if old_checkpoint->>'manifestId' is distinct from new_checkpoint->>'manifestId'
          or old_checkpoint->'sampleIndex' is distinct from new_checkpoint->'sampleIndex'
          or old_checkpoint->'candidateIndex' is distinct from new_checkpoint->'candidateIndex'
          or old_checkpoint->>'candidateId' is distinct from new_checkpoint->>'candidateId' then
          raise exception 'Active rollout checkpoint identity changed without a completed endpoint.' using errcode = '22023';
        elsif (new_checkpoint->>'plies')::integer < (old_checkpoint->>'plies')::integer then
          raise exception 'Active rollout checkpoint cannot regress.' using errcode = '22023';
        elsif (new_checkpoint->>'plies')::integer = (old_checkpoint->>'plies')::integer
          and (new_checkpoint->>'checkpointHash' is distinct from old_checkpoint->>'checkpointHash'
            or new_checkpoint->>'stateHash' is distinct from old_checkpoint->>'stateHash') then
          raise exception 'Same-ply rollout checkpoint cannot change bytes.' using errcode = '22023';
        else
          checkpoint_advanced := (new_checkpoint->>'plies')::integer > (old_checkpoint->>'plies')::integer;
        end if;
      end if;
    end if;
    expected_stalled := case when terminal_count > old_terminal_count or checkpoint_advanced then 0
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

revoke all on function private.long_bot_causal_valid_rollout_checkpoint(jsonb),
  private.long_bot_causal_validate_progress(public.bot_training_games,jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb)
from public, anon, authenticated;
grant execute on function public.checkpoint_long_bot_causal_review_slice(bigint,text,jsonb,jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
