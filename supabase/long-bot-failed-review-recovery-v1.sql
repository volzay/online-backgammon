begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Operator-approved operational recovery. Original archives, full reviews,
-- outcome counters, checkpoint identities and confidence rules are untouched.
create table if not exists private.long_bot_causal_recovery_grants (
 job_id bigint primary key references private.long_bot_causal_review_jobs(id),
 worker_id text not null unique,
 runtime_digest text not null references private.long_bot_causal_releases(runtime_digest),
 archive_fingerprint text not null check(archive_fingerprint~'^[0-9a-f]{64}$'),
 before_snapshot jsonb not null,
 max_attempts integer not null default 10 check(max_attempts between 4 and 10),
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
alter table private.long_bot_causal_recovery_grants enable row level security;
revoke all on private.long_bot_causal_recovery_grants from public,anon,authenticated,service_role;
create or replace function private.long_bot_causal_attempt_limit(p_job bigint)
returns integer language sql stable security definer set search_path='' as $$
 select coalesce((select g.max_attempts from private.long_bot_causal_recovery_grants g
  join private.long_bot_causal_review_jobs j on j.id=g.job_id
   and j.runtime_digest=g.runtime_digest and j.archive_fingerprint=g.archive_fingerprint
  where g.job_id=p_job and g.expires_at>now() and j.invalidated_at is null),3)
$$;
revoke all on function private.long_bot_causal_attempt_limit(bigint)from public,anon,authenticated,service_role;
-- These grants refer to existing jobs. Avoid the general queue's archive
-- discovery scan; retain approval -> archive -> job locking and every source,
-- eligibility, ownership and progress check before issuing one exact lease.
create or replace function private.claim_long_bot_recovery_grant(p_worker text,p_runtime text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g private.long_bot_causal_recovery_grants;j private.long_bot_causal_review_jobs;
 a private.long_bot_causal_runtime;game public.bot_training_games;archive_id uuid;payload jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role'then raise exception 'Worker role required'using errcode='42501';end if;
 select * into g from private.long_bot_causal_recovery_grants where worker_id=p_worker;
 if g.job_id is null or g.runtime_digest<>p_runtime or g.expires_at<=now()then raise exception 'Exact live recovery grant required';end if;
 select * into a from private.long_bot_causal_approved_runtime(p_runtime);
 if a.singleton is null then raise exception 'Original approved runtime required';end if;
 select training_game_id into archive_id from private.long_bot_causal_review_jobs where id=g.job_id;
 select * into game from public.bot_training_games where id=archive_id for share;
 select * into j from private.long_bot_causal_review_jobs where id=g.job_id for update;
 if j.runtime_digest<>p_runtime or j.archive_fingerprint<>g.archive_fingerprint or j.invalidated_at is not null
  or j.archive_fingerprint is distinct from private.long_bot_causal_archive_fingerprint(game)
  or not private.long_bot_causal_archive_is_eligible(game)
  or not private.long_bot_causal_archive_routes_to(game,p_runtime)
  or not exists(select 1 from private.long_bot_requested_review_scopes s where s.worker_id=p_worker and s.runtime_digest=p_runtime and s.job_id=j.id)
 then raise exception 'Recovery source or scope differs';end if;
 perform private.long_bot_causal_validate_progress(game,j.progress);
 if j.status in('complete','rejected','failed')or j.available_at>now()or(j.status='leased'and j.lease_until>now())then return '[]'::jsonb;end if;
 if j.status not in('pending','leased')or j.attempts>=g.max_attempts then raise exception 'Recovery operational attempts exhausted';end if;
 update private.long_bot_causal_review_jobs set status='leased',attempts=attempts+1,lease_owner=p_worker,
  lease_until=now()+interval '15 minutes',updated_at=now()where id=j.id;
 payload:=private.long_bot_causal_archive_payload(game);
 return jsonb_build_array(jsonb_build_object('jobId',j.id,'runtimeDigest',j.runtime_digest,
  'policyImplementationId',a.policy_implementation_id,'archiveFingerprint',j.archive_fingerprint,
  'archiveFingerprintSource',payload::text,'trainingGame',payload));
end $$;
revoke all on function private.claim_long_bot_recovery_grant(text,text)from public,anon,authenticated,service_role;
do $routing$
declare d text;needle text:='select case when exists (';
begin
 d:=pg_get_functiondef('private.long_bot_causal_archive_routes_to(public.bot_training_games,text)'::regprocedure);
 if position('private.long_bot_causal_recovery_grants' in d)=0 then
  if position(needle in d)=0 then raise exception 'Unexpected archive route contract';end if;
  d:=overlay(d placing $guard$select case when exists(select 1 from private.long_bot_causal_recovery_grants g where g.runtime_digest=p_digest)
   then exists(select 1 from private.long_bot_causal_recovery_grants g
    join private.long_bot_causal_review_jobs j on j.id=g.job_id
    join private.long_bot_causal_policy_routes r on r.runtime_digest=g.runtime_digest
    where g.runtime_digest=p_digest and g.expires_at>now() and j.training_game_id=p_game.id
     and j.runtime_digest=g.runtime_digest and j.archive_fingerprint=g.archive_fingerprint
     and j.invalidated_at is null and g.archive_fingerprint=private.long_bot_causal_archive_fingerprint(p_game)
     and r.enabled and not r.serves_patterns)
   else ($guard$ from position(needle in d) for 0);
  -- Close only the newly introduced CASE, before the SQL function delimiter.
  d:=replace(d,'$function$',') end $function$');
  -- pg_get_functiondef uses the delimiter twice; restore its opening.
  d:=replace(d,'AS ) end $function$','AS $function$');
  execute d;
 end if;
 d:=pg_get_functiondef('public.claim_long_bot_causal_review_jobs(text,integer,text)'::regprocedure);
 if position('private.claim_long_bot_recovery_grant' in d)=0 then
  if position('  select * into active from private.long_bot_causal_approved_runtime(p_runtime_digest);' in d)=0 then raise exception 'Unexpected claim approval contract';end if;
  d:=replace(d,'  select * into active from private.long_bot_causal_approved_runtime(p_runtime_digest);',
   $fast$  if exists(select 1 from private.long_bot_causal_recovery_grants where worker_id=p_worker_id)then
    return private.claim_long_bot_recovery_grant(p_worker_id,p_runtime_digest);
   end if;
   select * into active from private.long_bot_causal_approved_runtime(p_runtime_digest);$fast$);
  execute d;
 end if;
end $routing$;
do $attempts$
declare d text;begin
 d:=pg_get_functiondef('public.claim_long_bot_causal_review_jobs(text,integer,text)'::regprocedure);
 if position('private.long_bot_causal_attempt_limit' in d)=0 then
  if (length(d)-length(replace(d,'queued.attempts < 3','')))/length('queued.attempts < 3')<>2
   or (length(d)-length(replace(d,'queued.attempts >= 3','')))/length('queued.attempts >= 3')<>2
  then raise exception 'Unexpected retry contract';end if;
  d:=replace(d,'queued.attempts < 3','queued.attempts < private.long_bot_causal_attempt_limit(queued.id)');
  d:=replace(d,'queued.attempts >= 3','queued.attempts >= private.long_bot_causal_attempt_limit(queued.id)');
  execute d;
 end if;
 d:=pg_get_functiondef('public.fail_long_bot_causal_review_job(bigint,text,text)'::regprocedure);
 if position('private.long_bot_causal_attempt_limit' in d)=0 then
  if position('attempts >= 3' in d)=0 then raise exception 'Unexpected failure contract';end if;
  execute replace(d,'attempts >= 3','attempts >= private.long_bot_causal_attempt_limit(p_job_id)');
 end if;
end $attempts$;
create or replace function public.get_long_bot_recovery_job(p_worker text,p_runtime text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if coalesce(auth.role(),'')<>'service_role'then raise exception 'Worker role required'using errcode='42501';end if;
 return(select jsonb_build_object('jobId',j.id,'status',j.status,'runtimeDigest',j.runtime_digest,
  'archiveFingerprint',j.archive_fingerprint,'sourceUnchanged',j.archive_fingerprint=private.long_bot_causal_archive_fingerprint(a),
  'invalidated',j.invalidated_at is not null,'leaseOwner',j.lease_owner,'availableAt',j.available_at,
  'attempts',j.attempts,'slices',j.progress->'slices','finishedReviews',jsonb_array_length(j.progress->'finishedReviews'),
  'lastError',j.last_error)from private.long_bot_causal_recovery_grants g
  join private.long_bot_causal_review_jobs j on j.id=g.job_id join public.bot_training_games a on a.id=j.training_game_id
  where g.worker_id=p_worker and g.runtime_digest=p_runtime and g.expires_at>now());
end $$;
create or replace function public.heartbeat_long_bot_recovery_job(p_worker text,p_runtime text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.role(),'')<>'service_role'then raise exception 'Worker role required'using errcode='42501';end if;
 update private.long_bot_causal_review_jobs j set lease_until=greatest(j.lease_until,clock_timestamp()+interval '3 minutes')
 from private.long_bot_causal_recovery_grants g
 where g.job_id=j.id and g.worker_id=p_worker and g.runtime_digest=p_runtime and g.expires_at>now()
  and j.status='leased' and j.lease_owner=p_worker and j.runtime_digest=g.runtime_digest
  and j.archive_fingerprint=g.archive_fingerprint and j.invalidated_at is null;
 return found;
end $$;
revoke all on function public.get_long_bot_recovery_job(text,text),public.heartbeat_long_bot_recovery_job(text,text)from public,anon,authenticated;
grant execute on function public.get_long_bot_recovery_job(text,text),public.heartbeat_long_bot_recovery_job(text,text)to service_role;
notify pgrst,'reload schema';
commit;
