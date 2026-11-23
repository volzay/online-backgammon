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
