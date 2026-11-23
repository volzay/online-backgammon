-- Prepared activation only. Run after installing and independently attesting
-- the new immutable VPS closure, applying the signed-loader transition, and
-- allowing the existing worker to checkpoint/exit. This starts no worker.
-- Usage: psql -v new_runtime_digest=SERVER_COMPUTED_SHA256 -f this-file
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_catalog.set_config('nardu.adaptive_new_runtime_digest', :'new_runtime_digest', true);
lock table private.long_bot_causal_policy_routes in share row exclusive mode;
-- Prevent an old-policy room from entering between the quiescence check and
-- the cutover. A busy table makes this bounded transaction fail and roll back.
lock table public.rooms in share mode;

do $adaptive_release$
declare
  old_policy constant text := '7a263bcd3a44b7248b1b369e18dd552f1a5053e4f0772561f13c9a95e56abfa7';
  new_policy constant text := 'db212e88d758f309b3ac3027c857acc55e8a415d1cdf4da3b5d753eea82be10b';
  new_digest text := current_setting('nardu.adaptive_new_runtime_digest');
  old_serving private.long_bot_causal_runtime;
  old_route private.long_bot_causal_policy_routes;
  cutover_at timestamptz;
  loader_definition text;
  published_before jsonb;
  published_count_before integer;
  archives_before bigint;
  jobs_before bigint;
  evidence_before bigint;
  snapshots_before bigint;
  source_links_before bigint;
  signing_key_hash_before text;
  signing_key_hash_after text;
begin
  if coalesce(new_digest, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A server-computed immutable runtime digest is required.';
  end if;
  select * into old_serving from private.long_bot_causal_serving_runtime();
  if old_serving.singleton is distinct from true
    or old_serving.explicitly_approved is distinct from true
    or old_serving.policy_implementation_id is distinct from old_policy
    or old_serving.runtime_digest is null or old_serving.runtime_digest = new_digest then
    raise exception 'The actually serving predecessor differs from the reviewed policy.';
  end if;
  select * into old_route from private.long_bot_causal_policy_routes
  where runtime_digest = old_serving.runtime_digest;
  if old_route.enabled is distinct from true or old_route.serves_patterns is distinct from true
    or old_route.require_explicit_policy_identity is distinct from true
    or old_route.policy_implementation_id is distinct from old_policy
    or old_route.reviewer_version is distinct from old_serving.reviewer_version then
    raise exception 'The serving route is not the expected strict approved predecessor.';
  end if;
  if exists (select 1 from private.long_bot_causal_releases where runtime_digest = new_digest) then
    raise exception 'New runtime already registered; inspect its original binding instead of reinitializing.';
  end if;
  if exists (select 1 from public.rooms r
    where r.variant = 'long' and r.status = 'joined'
      and r.game_state->>'mode' = 'bot' and r.game_state->>'botDifficulty' = 'hard'
      and r.game_state->>'winner' is null) then
    raise exception 'Finish existing hard long rooms before the playing-policy cutover.';
  end if;

  loader_definition := pg_catalog.pg_get_functiondef(
    'public.load_signed_long_bot_experience(text,text,bigint)'::regprocedure);
  if position('if sealed.room_id is null then' in loader_definition) = 0
    or position('select * into active from private.long_bot_causal_serving_runtime()' in loader_definition)
      <= position('if sealed.room_id is null then' in loader_definition) then
    raise exception 'Install the issued-snapshot restoration transition before activation.';
  end if;
  published_before := public.get_long_bot_experience_patterns(null);
  if jsonb_typeof(published_before) is distinct from 'array' then
    raise exception 'The existing published lesson set is invalid.';
  end if;
  published_count_before := jsonb_array_length(published_before);
  if published_count_before=0 or exists(select 1 from jsonb_array_elements(published_before) p
    where p->>'creditVersion' is distinct from '10'
      or p->>'policyImplementationId' not in(old_policy,'2eac358adb59616fd96c7fe84fad43ef252d010906d6f6d7c69ac46c92c207b2')
      or p->>'evidenceSchema' is distinct from 'long-server-board-model-pattern-v1'
      or p->'terminalOutcomeConfirmed' is distinct from 'false'::jsonb) then
    raise exception 'Expected existing typed source-model advice only; terminal evidence requires separate review.';
  end if;
  if exists(select 1 from jsonb_array_elements(published_before) p where not exists(
    select 1 from private.long_bot_board_model_source_bindings b where b.playing_policy_implementation_id=new_policy
      and b.source_policy_implementation_id=p->>'policyImplementationId' and b.source_runtime_digest=p->>'runtimeDigest')) then
    raise exception 'An exact model-only source binding is missing.';
  end if;
  select count(*) into archives_before from public.bot_training_games;
  select count(*) into jobs_before from private.long_bot_causal_review_jobs;
  select count(*) into evidence_before from private.long_bot_causal_evidence;
  select count(*) into snapshots_before from private.long_bot_signed_experience_snapshots;
  select count(*) into source_links_before from private.long_bot_causal_experience_sources;
  select pg_catalog.encode(extensions.digest(secret, 'sha256'), 'hex')
    into signing_key_hash_before from private.long_bot_experience_signing_key where singleton;
  if signing_key_hash_before is null then raise exception 'The existing signing key is missing.'; end if;

  cutover_at := pg_catalog.clock_timestamp();
  if exists (select 1 from private.long_bot_causal_policy_routes
    where enabled and policy_implementation_id = old_policy
      and accept_completed_before is null and accept_completed_since >= cutover_at) then
    raise exception 'An existing admission window starts after the proposed cutover.';
  end if;
  insert into private.long_bot_causal_releases(runtime_digest, reviewer_version, policy_implementation_id)
  values (new_digest, old_serving.reviewer_version, new_policy);
  insert into private.long_bot_causal_warm_review_releases(runtime_digest) values (new_digest);
  insert into private.long_bot_causal_policy_routes (
    runtime_digest, policy_implementation_id, reviewer_version, enabled, serves_patterns,
    accept_completed_since, accept_completed_before, require_explicit_policy_identity
  ) values (
    new_digest, new_policy, old_serving.reviewer_version, true, false, cutover_at, null, true
  );
  -- Keep all predecessors enabled for their existing jobs and immutable
  -- signed snapshots. Only close their still-open old-policy admission.
  update private.long_bot_causal_policy_routes
  set accept_completed_before = cutover_at
  where enabled and policy_implementation_id = old_policy and accept_completed_before is null;
  update private.long_bot_causal_policy_routes
  set serves_patterns = false where runtime_digest = old_serving.runtime_digest;
  update private.long_bot_causal_policy_routes
  set serves_patterns = true where runtime_digest = new_digest;

  if not exists (select 1 from private.long_bot_causal_serving_runtime()
      where runtime_digest = new_digest and policy_implementation_id = new_policy)
    or exists(select 1 from jsonb_array_elements(public.get_long_bot_experience_patterns(null)) p
      where p->>'policyImplementationId' not in(old_policy,new_policy,'2eac358adb59616fd96c7fe84fad43ef252d010906d6f6d7c69ac46c92c207b2')
        or p->>'evidenceSchema' is distinct from 'long-server-board-model-pattern-v1'
        or p->'terminalOutcomeConfirmed' is distinct from 'false'::jsonb) then
    raise exception 'The new serving identity or typed model lessons differ from the reviewed transition.';
  end if;
  if not public.get_long_bot_experience_patterns(null) @> published_before then
    raise exception 'Original typed model advice was removed or changed during activation.';
  end if;
  select pg_catalog.encode(extensions.digest(secret, 'sha256'), 'hex')
    into signing_key_hash_after from private.long_bot_experience_signing_key where singleton;
  if signing_key_hash_after is distinct from signing_key_hash_before
    or (select count(*) from public.bot_training_games) <> archives_before
    or (select count(*) from private.long_bot_causal_review_jobs) <> jobs_before
    or (select count(*) from private.long_bot_causal_evidence) <> evidence_before
    or (select count(*) from private.long_bot_signed_experience_snapshots) <> snapshots_before
    or (select count(*) from private.long_bot_causal_experience_sources) <> source_links_before then
    raise exception 'Existing archive, work, evidence, signatures or source links changed during cutover.';
  end if;
  -- No enqueue, old-job updates, evidence projection, source links, archive
  -- rewrites, worker starts, planning-budget or confirmation-criteria changes.
  -- The existing trigger/claim path admits only eligible future completions.
end;
$adaptive_release$;
commit;
