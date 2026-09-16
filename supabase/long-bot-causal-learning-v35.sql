begin;

-- The playing browser only archives telemetry.  The causal worker is the only
-- writer of this ledger. Outcome labels are used solely to enqueue a loss
-- cohort, never to assign credit/blame or to choose an evidence weight.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table if not exists private.long_bot_causal_review_jobs (
  id bigint generated always as identity primary key,
  training_game_id uuid not null references public.bot_training_games(id) on delete cascade,
  runtime_digest text check (runtime_digest ~ '^[0-9a-f]{64}$'),
  archive_fingerprint text check (archive_fingerprint ~ '^[0-9a-f]{64}$'),
  invalidated_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'leased', 'complete', 'rejected', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_until timestamptz,
  result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Historical jobs have no trusted release/source identity. Do not guess it
-- from today's active release or today's repaired archive.
alter table private.long_bot_causal_review_jobs
  add column if not exists runtime_digest text,
  add column if not exists archive_fingerprint text,
  add column if not exists invalidated_at timestamptz;
alter table private.long_bot_causal_review_jobs
  drop constraint if exists long_bot_causal_review_jobs_training_game_id_key;
create unique index if not exists long_bot_causal_review_jobs_release_archive_idx
on private.long_bot_causal_review_jobs(training_game_id, runtime_digest, archive_fingerprint);

create index if not exists long_bot_causal_review_jobs_queue_idx
on private.long_bot_causal_review_jobs(status, available_at, id);

create table if not exists private.long_bot_causal_runtime (
  singleton boolean primary key default true check (singleton),
  reviewer_version text not null check (reviewer_version = 'long-server-causal-review-v1'),
  runtime_digest text not null check (runtime_digest ~ '^[0-9a-f]{64}$'),
  policy_implementation_id text not null default '0000000000000000000000000000000000000000000000000000000000000000' check (policy_implementation_id ~ '^[0-9a-f]{64}$'),
  explicitly_approved boolean not null default false,
  activated_at timestamptz not null default now()
);

alter table private.long_bot_causal_runtime
add column if not exists policy_implementation_id text not null default '0000000000000000000000000000000000000000000000000000000000000000',
add column if not exists explicitly_approved boolean not null default false;

create table if not exists private.long_bot_causal_releases (
  runtime_digest text primary key check (runtime_digest ~ '^[0-9a-f]{64}$'),
  reviewer_version text not null check (reviewer_version = 'long-server-causal-review-v1'),
  policy_implementation_id text not null check (policy_implementation_id ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz not null default now()
);

create table if not exists private.long_bot_causal_evidence (
  id bigint generated always as identity primary key,
  evidence_id text not null check (evidence_id ~ '^[0-9a-f]{64}$'),
  archive_fingerprint text check (archive_fingerprint ~ '^[0-9a-f]{64}$'),
  invalidated_at timestamptz,
  training_game_id uuid not null references public.bot_training_games(id) on delete cascade,
  decision_id text not null check (length(decision_id) between 1 and 256),
  state_id text not null check (state_id ~ '^[0-9a-f]{64}$'),
  selected_action_id text not null check (selected_action_id ~ '^[0-9a-f]{64}$'),
  recommended_action_id text not null check (recommended_action_id ~ '^[0-9a-f]{64}$'),
  context_key text not null check (length(context_key) between 1 and 2048),
  action_key text not null check (length(action_key) between 1 and 4096),
  reviewer_version text not null check (reviewer_version = 'long-server-causal-review-v1'),
  runtime_digest text not null check (runtime_digest ~ '^[0-9a-f]{64}$'),
  categories jsonb not null check (jsonb_typeof(categories) = 'array' and jsonb_array_length(categories) between 1 and 6),
  exact_execution boolean not null default true check (exact_execution),
  complete_legal_coverage boolean not null default true check (complete_legal_coverage),
  paired_rollout_complete boolean not null default true check (paired_rollout_complete),
  confidence_bounds_complete boolean not null default true check (confidence_bounds_complete),
  outcome_used boolean not null default false check (not outcome_used),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table private.long_bot_causal_evidence
  add column if not exists id bigint generated always as identity,
  add column if not exists archive_fingerprint text,
  add column if not exists invalidated_at timestamptz;
alter table private.long_bot_causal_evidence
  drop constraint if exists long_bot_causal_evidence_pkey,
  drop constraint if exists long_bot_causal_evidence_training_game_id_decision_id_key;
alter table private.long_bot_causal_evidence add primary key (id);
create unique index if not exists long_bot_causal_evidence_identity_archive_idx
on private.long_bot_causal_evidence(evidence_id, archive_fingerprint);
create unique index if not exists long_bot_causal_evidence_release_decision_idx
on private.long_bot_causal_evidence(training_game_id, decision_id, runtime_digest, archive_fingerprint);

-- ADD COLUMN upgrades must retain the same nullable SHA checks as a fresh
-- schema, while leaving every NULL historical identity unchanged.
do $causal_identity_checks$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'private.long_bot_causal_review_jobs'::regclass and conname = 'long_bot_causal_review_jobs_runtime_digest_check') then
    alter table private.long_bot_causal_review_jobs add constraint long_bot_causal_review_jobs_runtime_digest_check check (runtime_digest ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'private.long_bot_causal_review_jobs'::regclass and conname = 'long_bot_causal_review_jobs_archive_fingerprint_check') then
    alter table private.long_bot_causal_review_jobs add constraint long_bot_causal_review_jobs_archive_fingerprint_check check (archive_fingerprint ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'private.long_bot_causal_evidence'::regclass and conname = 'long_bot_causal_evidence_archive_fingerprint_check') then
    alter table private.long_bot_causal_evidence add constraint long_bot_causal_evidence_archive_fingerprint_check check (archive_fingerprint ~ '^[0-9a-f]{64}$');
  end if;
end;
$causal_identity_checks$;

create index if not exists long_bot_causal_evidence_pattern_idx
on private.long_bot_causal_evidence(runtime_digest, context_key, action_key);

-- Re-exporting/replaying the same exact position uses the same deterministic
-- future dice. It is one observation, not independent evidence from each room.
-- Keep independent archive/release history; aggregation, not deletion or a
-- global uniqueness conflict, prevents duplicate scientific observations.
drop index if exists private.long_bot_causal_evidence_exact_position_idx;
create index if not exists long_bot_causal_evidence_exact_position_idx
on private.long_bot_causal_evidence(runtime_digest, state_id, selected_action_id);

alter table private.long_bot_causal_review_jobs enable row level security;
alter table private.long_bot_causal_runtime enable row level security;
alter table private.long_bot_causal_releases enable row level security;
alter table private.long_bot_causal_evidence enable row level security;
revoke all on private.long_bot_causal_review_jobs from public, anon, authenticated, service_role;
revoke all on private.long_bot_causal_runtime from public, anon, authenticated, service_role;
revoke all on private.long_bot_causal_releases from public, anon, authenticated, service_role;
revoke all on private.long_bot_causal_evidence from public, anon, authenticated, service_role;

create or replace function private.long_bot_causal_archive_payload(p_game public.bot_training_games)
returns jsonb language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_game.id, 'room_code', p_game.room_code,
    'engine_version', p_game.engine_version, 'difficulty', p_game.difficulty,
    'bot_color', p_game.bot_color, 'winner', p_game.winner,
    'decisions', p_game.decisions, 'final_state', p_game.final_state
  )
$$;

create or replace function private.long_bot_causal_archive_fingerprint(p_game public.bot_training_games)
returns text language sql immutable set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    private.long_bot_causal_archive_payload(p_game)::text, 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function private.long_bot_causal_archive_is_eligible(p_game public.bot_training_games)
returns boolean language sql immutable set search_path = ''
as $$
  select coalesce(p_game.engine_version = 'long-analytic-v35'
    and p_game.difficulty = 'hard' and p_game.winner <> p_game.bot_color
    and p_game.final_state->>'variant' = 'long'
    and private.long_bot_v35_training_memory_is_complete(
      p_game.final_state->'analysis'->'botMemory'), false)
$$;

create or replace function private.enqueue_long_bot_causal_release(p_runtime_digest text)
returns void language sql security definer set search_path = ''
as $$
  insert into private.long_bot_causal_review_jobs(training_game_id, runtime_digest, archive_fingerprint)
  select game.id, release.runtime_digest, private.long_bot_causal_archive_fingerprint(game)
  from public.bot_training_games game
  join private.long_bot_causal_runtime active on active.singleton and active.explicitly_approved
  join private.long_bot_causal_releases release
    on release.runtime_digest = active.runtime_digest
    and release.reviewer_version = active.reviewer_version
    and release.policy_implementation_id = active.policy_implementation_id
  where release.runtime_digest = p_runtime_digest
    and private.long_bot_causal_archive_is_eligible(game)
  on conflict (training_game_id, runtime_digest, archive_fingerprint) do nothing
$$;

create or replace function private.reject_long_bot_causal_release_rebinding()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.runtime_digest is distinct from new.runtime_digest
    or old.reviewer_version is distinct from new.reviewer_version
    or old.policy_implementation_id is distinct from new.policy_implementation_id then
    raise exception 'Causal release approval binding is immutable.' using errcode = '22023';
  end if;
  return new;
end;
$$;
drop trigger if exists reject_long_bot_causal_release_rebinding on private.long_bot_causal_releases;
create trigger reject_long_bot_causal_release_rebinding
before update on private.long_bot_causal_releases
for each row execute function private.reject_long_bot_causal_release_rebinding();

revoke all on function private.long_bot_causal_archive_payload(public.bot_training_games),
  private.long_bot_causal_archive_fingerprint(public.bot_training_games),
  private.long_bot_causal_archive_is_eligible(public.bot_training_games),
  private.enqueue_long_bot_causal_release(text), private.reject_long_bot_causal_release_rebinding()
from public, anon, authenticated, service_role;

create or replace function private.enqueue_long_bot_causal_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  active private.long_bot_causal_runtime;
  fingerprint text := private.long_bot_causal_archive_fingerprint(new);
begin
  if tg_op = 'UPDATE' and private.long_bot_causal_archive_fingerprint(old) is distinct from fingerprint then
    -- Evidence is bound to an immutable execution ledger. Archive repairs
    -- invalidate it instead of silently retaining credit for another action.
    update private.long_bot_causal_evidence set invalidated_at = pg_catalog.now()
    where training_game_id = new.id and archive_fingerprint is distinct from fingerprint
      and invalidated_at is null;
    -- Returning to identical authoritative bytes restores that same revision,
    -- not another independent observation or a reset of its completed result.
    update private.long_bot_causal_evidence set invalidated_at = null
    where training_game_id = new.id and archive_fingerprint = fingerprint;
    update private.long_bot_causal_review_jobs set invalidated_at = null
    where training_game_id = new.id and archive_fingerprint = fingerprint;
    update private.long_bot_causal_review_jobs
    set invalidated_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where training_game_id = new.id and archive_fingerprint is distinct from fingerprint
      and invalidated_at is null;
  end if;
  select configured.* into active from private.long_bot_causal_runtime configured
  join private.long_bot_causal_releases release
    on release.runtime_digest = configured.runtime_digest
    and release.reviewer_version = configured.reviewer_version
    and release.policy_implementation_id = configured.policy_implementation_id
  where configured.singleton and configured.explicitly_approved;
  if active.singleton and private.long_bot_causal_archive_is_eligible(new) then
    insert into private.long_bot_causal_review_jobs(training_game_id, runtime_digest, archive_fingerprint)
    values (new.id, active.runtime_digest, fingerprint)
    on conflict (training_game_id, runtime_digest, archive_fingerprint) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.enqueue_long_bot_causal_review()
from public, anon, authenticated, service_role;

drop trigger if exists enqueue_long_bot_causal_review on public.bot_training_games;
create trigger enqueue_long_bot_causal_review
after insert or update on public.bot_training_games
for each row execute function private.enqueue_long_bot_causal_review();

-- Idempotent installs only enqueue an already explicitly approved release.
select private.enqueue_long_bot_causal_release(active.runtime_digest)
from private.long_bot_causal_runtime active where active.singleton and active.explicitly_approved;

-- Only a service-role process can claim or commit work. A public archive RPC
-- cannot submit a regret, a teacher assertion, or a learned pattern.
drop function if exists public.claim_long_bot_causal_review_jobs(text, integer);
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
    order by queued.id
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

drop function if exists public.activate_long_bot_causal_release(text, text);
create or replace function public.activate_long_bot_causal_release(
  p_reviewer_version text,
  p_runtime_digest text,
  p_policy_implementation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  release private.long_bot_causal_releases;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted causal worker role required.' using errcode = '42501';
  end if;
  if p_reviewer_version is distinct from 'long-server-causal-review-v1'
     or coalesce(p_runtime_digest, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_policy_implementation_id, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid causal worker release.' using errcode = '22023';
  end if;
  -- Original stored identities are authoritative. Unknown legacy identities
  -- remain quarantined, never backfilled with this requested browser SHA.
  if exists (
    select 1 from private.long_bot_causal_evidence evidence
    where evidence.runtime_digest = p_runtime_digest
      and coalesce(evidence.payload->>'policyImplementationId', '') ~ '^[0-9a-f]{64}$'
      and evidence.payload->>'policyImplementationId' is distinct from p_policy_implementation_id
  ) or exists (
    select 1 from private.long_bot_causal_review_jobs historical
    where historical.result->>'runtimeDigest' = p_runtime_digest
      and coalesce(historical.result->>'policyImplementationId', '') ~ '^[0-9a-f]{64}$'
      and historical.result->>'policyImplementationId' is distinct from p_policy_implementation_id
  ) then
    raise exception 'Requested release contradicts original stored policy identity.' using errcode = '22023';
  end if;
  insert into private.long_bot_causal_releases(runtime_digest, reviewer_version, policy_implementation_id)
  values (p_runtime_digest, p_reviewer_version, p_policy_implementation_id)
  on conflict (runtime_digest) do nothing;
  select approved.* into release from private.long_bot_causal_releases approved
  where approved.runtime_digest = p_runtime_digest for share;
  if release.reviewer_version is distinct from p_reviewer_version
    or release.policy_implementation_id is distinct from p_policy_implementation_id then
    raise exception 'Causal release approval binding is immutable.' using errcode = '22023';
  end if;
  insert into private.long_bot_causal_runtime(singleton, reviewer_version, runtime_digest, policy_implementation_id, explicitly_approved)
  values (true, p_reviewer_version, p_runtime_digest, p_policy_implementation_id, true)
  on conflict (singleton) do update
    set reviewer_version = excluded.reviewer_version,
        runtime_digest = excluded.runtime_digest,
        policy_implementation_id = excluded.policy_implementation_id,
        explicitly_approved = true,
        activated_at = pg_catalog.now();
  perform private.enqueue_long_bot_causal_release(p_runtime_digest);
  return jsonb_build_object('ok', true, 'runtimeDigest', p_runtime_digest,
    'policyImplementationId', p_policy_implementation_id);
end;
$$;

revoke all on function public.activate_long_bot_causal_release(text, text, text)
from public, anon, authenticated;
grant execute on function public.activate_long_bot_causal_release(text, text, text) to service_role;

create or replace function public.complete_long_bot_causal_review_job(
  p_job_id bigint,
  p_worker_id text,
  p_result jsonb
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
  evidence jsonb;
  archive_id uuid;
  matched_decision jsonb;
  decision_matches integer;
  expected_evidence_id text;
  inserted_count integer := 0;
  affected_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted causal worker role required.' using errcode = '42501';
  end if;
  -- This gate applies to rejected/no-op results too. A stale worker must not
  -- consume a new release's job or silently activate itself on a fresh install.
  select configured.* into active from private.long_bot_causal_runtime configured
  join private.long_bot_causal_releases release
    on release.runtime_digest = configured.runtime_digest
    and release.reviewer_version = configured.reviewer_version
    and release.policy_implementation_id = configured.policy_implementation_id
  where configured.singleton and configured.explicitly_approved
  for share of configured, release;
  if active.singleton is null
    or active.reviewer_version is distinct from p_result->>'reviewerVersion'
    or active.runtime_digest is distinct from p_result->>'runtimeDigest'
    or active.policy_implementation_id is distinct from p_result->>'policyImplementationId' then
    raise exception 'Explicitly approve the matching immutable worker/policy release before completion.' using errcode = '22023';
  end if;

  -- Discover only the immutable archive identity without locking the job.
  -- Then use the same active -> archive -> queue order as claim and repair.
  select queued.training_game_id into archive_id
  from private.long_bot_causal_review_jobs queued where queued.id = p_job_id;
  select archived.* into game from public.bot_training_games archived
  where archived.id = archive_id for share;
  select queued.* into job from private.long_bot_causal_review_jobs queued
  where queued.id = p_job_id for update;
  if job.id is null or job.training_game_id is distinct from game.id
     or job.status <> 'leased' or job.lease_owner is distinct from p_worker_id
     or job.lease_until is null or job.lease_until < pg_catalog.now() then
    raise exception 'Causal review lease is not owned by this worker.' using errcode = '42501';
  end if;
  if job.runtime_digest is distinct from active.runtime_digest then
    raise exception 'Explicitly approve the matching immutable worker/policy release before completion.' using errcode = '22023';
  end if;
  if job.invalidated_at is not null or job.archive_fingerprint is null
     or job.archive_fingerprint is distinct from private.long_bot_causal_archive_fingerprint(game)
     or p_result->>'archiveFingerprint' is distinct from job.archive_fingerprint
     or not private.long_bot_causal_archive_is_eligible(game) then
    raise exception 'Training archive changed after the worker claim.' using errcode = '22023';
  end if;

  if jsonb_typeof(p_result) is distinct from 'object'
     or p_result->>'schema' is distinct from 'long-server-causal-review-result-v1'
     or p_result->>'trustDomain' is distinct from 'nardu/server-long-bot-causal/v1'
     or p_result->>'reviewerVersion' is distinct from 'long-server-causal-review-v1'
     or p_result->>'engineVersion' is distinct from 'long-analytic-v35'
     or coalesce(p_result->>'policyImplementationId', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_result->>'runtimeDigest', '') !~ '^[0-9a-f]{64}$'
     or p_result->>'gameId' is distinct from game.id::text
     or p_result->>'roomCode' is distinct from game.room_code
     or coalesce(p_result->'outcomeUsed', 'true'::jsonb) <> 'false'::jsonb
     or jsonb_typeof(p_result->'accepted') is distinct from 'boolean'
     or jsonb_typeof(p_result->'evidence') is distinct from 'array' then
    raise exception 'Invalid server causal result contract.' using errcode = '22023';
  end if;
  if p_result->'accepted' <> 'true'::jsonb then
    update private.long_bot_causal_review_jobs
    set status = 'rejected', result = p_result, lease_owner = null,
        lease_until = null, updated_at = pg_catalog.now()
    where id = job.id;
    return jsonb_build_object('ok', true, 'inserted', 0, 'status', 'rejected');
  end if;

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
  update private.long_bot_causal_review_jobs
  set status = 'complete', result = p_result, lease_owner = null,
      lease_until = null, updated_at = pg_catalog.now()
  where id = job.id;
  return jsonb_build_object('ok', true, 'inserted', inserted_count, 'status', 'complete');
end;
$$;

revoke all on function public.complete_long_bot_causal_review_job(bigint, text, jsonb)
from public, anon, authenticated;
grant execute on function public.complete_long_bot_causal_review_job(bigint, text, jsonb) to service_role;

create or replace function public.fail_long_bot_causal_review_job(
  p_job_id bigint,
  p_worker_id text,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Trusted causal worker role required.' using errcode = '42501';
  end if;
  update private.long_bot_causal_review_jobs
  set status = case when attempts >= 3 then 'failed' else 'pending' end,
      available_at = pg_catalog.now() + interval '5 minutes',
      lease_owner = null, lease_until = null,
      last_error = pg_catalog.left(coalesce(p_error, ''), 1000),
      updated_at = pg_catalog.now()
  where id = p_job_id and status = 'leased' and lease_owner = p_worker_id;
  if not found then
    raise exception 'Causal review lease is not owned by this worker.' using errcode = '42501';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.fail_long_bot_causal_review_job(bigint, text, text)
from public, anon, authenticated;
grant execute on function public.fail_long_bot_causal_review_job(bigint, text, text) to service_role;

-- Fixed, bounded negative evidence only.  No win/Mars/Koks label, severity
-- guessed from a final result, or client supplied regret enters this aggregate.
-- The engine applies this after its cold tactical safety envelope, and its
-- minimum sample thresholds still apply. Player-name personalization is
-- intentionally disabled so one game cannot be counted several times.
create or replace function public.get_long_bot_experience_patterns(
  p_player_name text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with grouped as (
    select evidence.context_key, evidence.action_key,
      evidence.reviewer_version, evidence.runtime_digest,
      evidence.payload->>'policyImplementationId' as policy_implementation_id,
      -- Move-order variants can share the same future dice cohort. Count a
      -- position once within its descriptor action, not once per evidence ID.
      least(32, count(distinct evidence.state_id))::integer as samples,
      max(evidence.created_at) as updated_at
    from private.long_bot_causal_evidence evidence
    join private.long_bot_causal_runtime active
      on active.singleton and active.explicitly_approved and active.runtime_digest = evidence.runtime_digest
      and active.reviewer_version = evidence.reviewer_version
      and active.policy_implementation_id = evidence.payload->>'policyImplementationId'
    join private.long_bot_causal_releases release
      on release.runtime_digest = evidence.runtime_digest
      and release.reviewer_version = evidence.reviewer_version
      and release.policy_implementation_id = evidence.payload->>'policyImplementationId'
    join public.bot_training_games archived on archived.id = evidence.training_game_id
      and evidence.archive_fingerprint = private.long_bot_causal_archive_fingerprint(archived)
    where evidence.exact_execution and evidence.complete_legal_coverage
      and evidence.paired_rollout_complete and evidence.confidence_bounds_complete
      and not evidence.outcome_used
      and evidence.invalidated_at is null
      and evidence.payload->>'runtimeDigest' = evidence.runtime_digest
      and evidence.payload->>'reviewerVersion' = evidence.reviewer_version
      and private.long_bot_causal_archive_is_eligible(archived)
      and evidence.created_at >= pg_catalog.now() - interval '180 days'
    group by evidence.context_key, evidence.action_key,
      evidence.reviewer_version, evidence.runtime_digest, evidence.payload->>'policyImplementationId'
    order by count(distinct evidence.state_id) desc, max(evidence.created_at) desc,
      evidence.context_key, evidence.action_key
    limit 256
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'creditVersion', 9,
    'evidenceSchema', 'long-server-causal-pattern-v1',
    'trustDomain', 'nardu/server-long-bot-causal/v1',
    'reviewerVersion', reviewer_version,
    'runtimeDigest', runtime_digest,
    'policyImplementationId', policy_implementation_id,
    'aggregateId', pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
      pg_catalog.concat_ws(pg_catalog.chr(31), runtime_digest, context_key,
        action_key, samples::text), 'UTF8'), 'sha256'), 'hex'),
    'contextKey', context_key, 'actionKey', action_key,
    'samples', samples, 'losses', samples, 'wins', 0,
    'lossWeight', samples * 1.5, 'severeLosses', 0,
    'signalWeight', samples * 1.5, 'winWeight', 0,
    'outcomeUsed', false, 'updatedAt', updated_at
  ) order by samples desc, updated_at desc, context_key, action_key), '[]'::jsonb)
  from grouped
$$;

revoke all on function public.get_long_bot_experience_patterns(text) from public;
grant execute on function public.get_long_bot_experience_patterns(text) to anon, authenticated;

commit;
