begin;

-- Queue scheduling only. The active release, worker digest, archive payload,
-- v36 per-ply progress validator, and evidence completion path are unchanged.
-- Reapplying this migration replaces the same RPC body and touches no rows.
create or replace function public.claim_long_bot_causal_review_jobs(
  p_worker_id text,
  p_limit integer,
  p_runtime_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job private.long_bot_causal_review_jobs;
  game public.bot_training_games;
  active private.long_bot_causal_runtime;
  claimed jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted causal worker role required.' using errcode = '42501';
  end if;
  if length(coalesce(p_worker_id, '')) not between 1 and 128 then
    raise exception 'Invalid worker identity.' using errcode = '22023';
  end if;
  if coalesce(p_limit, 0) not between 1 and 128 then
    raise exception 'Invalid causal claim limit.' using errcode = '22023';
  end if;

  select configured.* into active from private.long_bot_causal_runtime configured
  join private.long_bot_causal_releases release
    on release.runtime_digest = configured.runtime_digest
    and release.reviewer_version = configured.reviewer_version
    and release.policy_implementation_id = configured.policy_implementation_id
  where configured.singleton and configured.explicitly_approved
  for share of configured, release;
  if active.singleton is null or p_runtime_digest is distinct from active.runtime_digest then
    raise exception 'Claim requires the explicitly approved active worker runtime.' using errcode = '22023';
  end if;

  -- Activation and an uncommitted archive repair can each see the other's old
  -- MVCC state. Recover any missed native current-release/source job here;
  -- never reset completed/rejected history or infer a legacy NULL identity.
  -- Hold archive SHARE before INSERT (not merely the FK's weaker KEY SHARE),
  -- otherwise housekeeping would recreate the archive/queue lock inversion.
  for game in
    select archived.* from public.bot_training_games archived
    where private.long_bot_causal_archive_is_eligible(archived)
      and not exists (
        select 1 from private.long_bot_causal_review_jobs queued
        where queued.training_game_id = archived.id
          and queued.runtime_digest = active.runtime_digest
          and queued.archive_fingerprint = private.long_bot_causal_archive_fingerprint(archived)
      )
    order by archived.id
    limit 16
    for share of archived skip locked
  loop
    if not private.long_bot_causal_archive_is_eligible(game) then
      continue;
    end if;
    insert into private.long_bot_causal_review_jobs(training_game_id, runtime_digest, archive_fingerprint)
    values (game.id, active.runtime_digest, private.long_bot_causal_archive_fingerprint(game))
    on conflict (training_game_id, runtime_digest, archive_fingerprint) do nothing;
  end loop;

  -- The third crashed worker cannot leave a job falsely leased forever.
  -- Lock order is active approval -> archive -> queue. Archive repairs already
  -- hold the archive write lock before their trigger invalidates queue rows.
  -- Never hold a queue lock while subsequently waiting on an archive lock.
  for game in
    select archived.*
    from public.bot_training_games archived
    join private.long_bot_causal_review_jobs queued on queued.training_game_id = archived.id
    where queued.runtime_digest = active.runtime_digest and queued.invalidated_at is null
      and queued.archive_fingerprint = private.long_bot_causal_archive_fingerprint(archived)
      and queued.attempts >= 3 and (
        queued.status = 'pending'
        or (queued.status = 'leased' and queued.lease_until <= pg_catalog.now())
      )
    order by queued.id
    for share of archived skip locked
  loop
    select queued.* into job from private.long_bot_causal_review_jobs queued
    where queued.training_game_id = game.id and queued.runtime_digest = active.runtime_digest
      and queued.invalidated_at is null
      and queued.archive_fingerprint = private.long_bot_causal_archive_fingerprint(game)
      and queued.attempts >= 3 and (
        queued.status = 'pending'
        or (queued.status = 'leased' and queued.lease_until <= pg_catalog.now())
      )
    for update of queued skip locked;
    if found then
      update private.long_bot_causal_review_jobs
      set status = 'failed', lease_owner = null, lease_until = null,
          last_error = 'Causal review lease expired after the final allowed attempt.',
          updated_at = pg_catalog.now()
      where id = job.id;
    end if;
  end loop;

  for game in
    select archived.*
    from public.bot_training_games archived
    join private.long_bot_causal_review_jobs queued on queued.training_game_id = archived.id
    where queued.runtime_digest = active.runtime_digest and queued.invalidated_at is null
      and queued.archive_fingerprint = private.long_bot_causal_archive_fingerprint(archived)
      and private.long_bot_causal_archive_is_eligible(archived)
      and queued.attempts < 3
      and queued.available_at <= pg_catalog.now()
      and (
        queued.status = 'pending'
        or (queued.status = 'leased' and queued.lease_until < pg_catalog.now())
      )
    -- A timed-out terminal cohort yields to already-finished decision cursors
    -- and fresh games. Once it has waited 30 minutes it gets the oldest-work
    -- lane, so a large cohort cannot be postponed forever by new arrivals.
    -- Finished cursors retain id locality for the worker's cheap burst.
    -- Fresh games favor shorter immutable ledgers; recent partial cohorts
    -- favor fewer remaining authenticated slots. These are scheduling hints
    -- only: neither outcomes nor regret enter the order or evidence contract.
    order by
      case
        when queued.result #>> '{reviews,0,reason}' = 'rollout-time-limit'
          and queued.updated_at <= pg_catalog.now() - interval '30 minutes' then 0
        when queued.result is not null
          and queued.result #>> '{reviews,0,reason}' is distinct from 'rollout-time-limit' then 1
        when queued.result is null then 2
        else 3
      end,
      case when queued.result #>> '{reviews,0,reason}' = 'rollout-time-limit'
        and queued.updated_at <= pg_catalog.now() - interval '30 minutes'
        then queued.updated_at end,
      case when queued.result is null then archived.decision_count end,
      case when queued.result #>> '{reviews,0,reason}' = 'rollout-time-limit' then
        greatest(0, coalesce(
          public.long_bot_safe_numeric(queued.result #> '{reviews,0,rollout,coverage,requiredTerminalOutcomes}')
            - public.long_bot_safe_numeric(queued.progress->'currentTerminalOutcomes'), 3072))
      end,
      queued.id
    -- One bounded game per claim. Parallelism comes from isolated workers,
    -- not leases that could expire before a sequential batch reaches them.
    limit 1
    for share of archived skip locked
  loop
    -- Recheck status, attempts and source under the already-held archive lock;
    -- another worker can have claimed this candidate between the two reads.
    select queued.* into job from private.long_bot_causal_review_jobs queued
    where queued.training_game_id = game.id and queued.runtime_digest = active.runtime_digest
      and queued.invalidated_at is null
      and queued.archive_fingerprint = private.long_bot_causal_archive_fingerprint(game)
      and private.long_bot_causal_archive_is_eligible(game)
      and queued.attempts < 3 and queued.available_at <= pg_catalog.now()
      and (queued.status = 'pending'
        or (queued.status = 'leased' and queued.lease_until < pg_catalog.now()))
    for update of queued skip locked;
    if not found then
      continue;
    end if;
    update private.long_bot_causal_review_jobs
    set status = 'leased', attempts = attempts + 1,
        lease_owner = p_worker_id,
        lease_until = pg_catalog.now() + interval '24 hours',
        updated_at = pg_catalog.now()
    where id = job.id;
    claimed := claimed || jsonb_build_array(jsonb_build_object(
      'jobId', job.id,
      'runtimeDigest', job.runtime_digest,
      'policyImplementationId', active.policy_implementation_id,
      'archiveFingerprint', job.archive_fingerprint,
      'archiveFingerprintSource', private.long_bot_causal_archive_payload(game)::text,
      'trainingGame', private.long_bot_causal_archive_payload(game)
    ));
  end loop;
  return claimed;
end;
$$;

revoke all on function public.claim_long_bot_causal_review_jobs(text, integer, text)
from public, anon, authenticated;
grant execute on function public.claim_long_bot_causal_review_jobs(text, integer, text) to service_role;

commit;
