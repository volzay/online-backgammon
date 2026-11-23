\set ON_ERROR_STOP on
-- Stop the two recovery services first. This is an explicit replacement of
-- incomplete executions, never a relabelling of a completed terminal proof.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtext('long-causal-recovery-20261123-transition'));
create table if not exists private.long_bot_causal_recovery_targets(
 original_job_id bigint primary key references private.long_bot_causal_review_jobs(id),
 effective_job_id bigint not null unique references private.long_bot_causal_review_jobs(id),
 reason text not null default 'original immutable worker',transitioned_at timestamptz not null default now()
);
alter table private.long_bot_causal_recovery_targets enable row level security;
revoke all on private.long_bot_causal_recovery_targets from public,anon,authenticated,service_role;
create table if not exists private.long_bot_causal_recovery_events(
 event_at timestamptz not null default now(),job_id bigint not null,event text not null,before_state jsonb not null
);
alter table private.long_bot_causal_recovery_events enable row level security;
revoke all on private.long_bot_causal_recovery_events from public,anon,authenticated,service_role;
alter table private.long_bot_causal_review_jobs drop constraint long_bot_causal_review_jobs_status_check;
alter table private.long_bot_causal_review_jobs add constraint long_bot_causal_review_jobs_status_check
 check(status in('pending','leased','complete','rejected','failed','superseded'));
do $$
declare old_runtime constant text:='430a0f4ea942c2282b8529fcf39fe9347194d1124432b3dc8b4d0fad25594a2a';
 new_runtime constant text:='009d62ab33510b5d644afd667fc935827dfacedd89a9cc524898224d6a83a3d9';
 policy constant text:='fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';
 id_to_replace bigint;old_job private.long_bot_causal_review_jobs;new_job private.long_bot_causal_review_jobs;
 grant_row private.long_bot_causal_recovery_grants;worker text;serving_before text;
begin
 select runtime_digest into serving_before from private.long_bot_causal_serving_runtime();
 if exists(select 1 from private.long_bot_causal_recovery_targets where original_job_id in(11,12,13)and effective_job_id<>original_job_id)
 then raise exception 'Legacy executions already replaced; inspect the existing mapping';end if;
 if(select count(*)from private.long_bot_causal_recovery_grants where expires_at>now())<>43
 then raise exception 'Exact original recovery campaign required';end if;
 insert into private.long_bot_causal_recovery_targets(original_job_id,effective_job_id)
 select job_id,job_id from private.long_bot_causal_recovery_grants where expires_at>now()on conflict do nothing;
 if(select count(*)from private.long_bot_causal_recovery_targets)<>43 then raise exception 'Exactly 43 logical targets required';end if;
 -- Archive -> queue lock order. Only leases owned by the now-stopped recovery
 -- workers may be released; their complete prefixes and journals stay intact.
 perform a.id from public.bot_training_games a join private.long_bot_causal_review_jobs j on j.training_game_id=a.id
 join private.long_bot_causal_recovery_grants g on g.job_id=j.id where g.expires_at>now()order by a.id for share of a;
 insert into private.long_bot_causal_recovery_events(job_id,event,before_state)
 select j.id,'stopped-recovery-before-resumable-replacement',to_jsonb(j)from private.long_bot_causal_review_jobs j
 join private.long_bot_causal_recovery_grants g on g.job_id=j.id where j.status='leased'and j.lease_owner=g.worker_id and g.expires_at>now();
 update private.long_bot_causal_review_jobs j set status='pending',lease_owner=null,lease_until=null,available_at=now()
 from private.long_bot_causal_recovery_grants g where j.id=g.job_id and g.expires_at>now()and j.status='leased'and j.lease_owner=g.worker_id;
 if exists(select 1 from private.long_bot_causal_review_jobs j join private.long_bot_causal_recovery_grants g on g.job_id=j.id where g.expires_at>now()and j.status='leased')
 then raise exception 'Unexpected active recovery lease';end if;
 if not exists(select 1 from private.long_bot_causal_releases where runtime_digest=old_runtime and policy_implementation_id=policy)
 then raise exception 'Original policy identity differs';end if;
 insert into private.long_bot_causal_releases(runtime_digest,reviewer_version,policy_implementation_id)
 values(new_runtime,'long-server-causal-review-v1',policy);
 insert into private.long_bot_causal_policy_routes(runtime_digest,policy_implementation_id,reviewer_version,enabled,serves_patterns,
  accept_completed_since,accept_completed_before,require_explicit_policy_identity)
 select new_runtime,policy,'long-server-causal-review-v1',true,false,accept_completed_since,accept_completed_before,require_explicit_policy_identity
 from private.long_bot_causal_policy_routes where runtime_digest=old_runtime and enabled and not serves_patterns;
 if not found then raise exception 'Original review-only source route required';end if;
 foreach id_to_replace in array array[11,12,13]::bigint[]loop
  select * into grant_row from private.long_bot_causal_recovery_grants where job_id=id_to_replace for update;
  select * into old_job from private.long_bot_causal_review_jobs where id=id_to_replace for update;
  if old_job.status not in('pending','failed')or old_job.runtime_digest<>old_runtime or old_job.invalidated_at is not null
   or old_job.archive_fingerprint<>grant_row.archive_fingerprint
   or old_job.archive_fingerprint is distinct from(select private.long_bot_causal_archive_fingerprint(a)from public.bot_training_games a where a.id=old_job.training_game_id)
  then raise exception 'Legacy source/execution changed for %',id_to_replace;end if;
  insert into private.long_bot_causal_recovery_events(job_id,event,before_state)
   values(old_job.id,'superseded-incomplete-v1-execution-no-midgame-resume',to_jsonb(old_job));
  -- Recompute under the new producer. No old endpoint or review is renamed,
  -- copied into a new manifest, or counted as an independent new sample.
  insert into private.long_bot_causal_review_jobs(training_game_id,runtime_digest,archive_fingerprint)
   values(old_job.training_game_id,new_runtime,old_job.archive_fingerprint)returning * into new_job;
  worker:='long-recovery-'||new_job.id::text||'-'||pg_catalog.gen_random_uuid()::text;
  insert into private.long_bot_causal_recovery_grants(job_id,worker_id,runtime_digest,archive_fingerprint,before_snapshot,max_attempts,expires_at)
   values(new_job.id,worker,new_runtime,new_job.archive_fingerprint,
    to_jsonb(new_job)||jsonb_build_object('replacesJobId',old_job.id,'sourcePolicyUnchanged',true,'originalRuntimeDigest',old_runtime),10,grant_row.expires_at);
  insert into private.long_bot_requested_review_scopes(worker_id,runtime_digest,job_id)values(worker,new_runtime,new_job.id);
  update private.long_bot_causal_review_jobs set status='superseded',lease_owner=null,lease_until=null,
   last_error='Incomplete execution replaced by resumable same-policy job '||new_job.id::text,updated_at=now()where id=old_job.id;
  update private.long_bot_causal_recovery_grants set expires_at=now()where job_id=old_job.id;
  update private.long_bot_causal_recovery_targets set effective_job_id=new_job.id,
   reason='Same policy and statistical limits; new runtime supports authenticated in-game resume',transitioned_at=now()where original_job_id=old_job.id;
 end loop;
 if(select count(*)from private.long_bot_causal_recovery_grants where expires_at>now())<>43
  or(select count(*)from private.long_bot_causal_recovery_targets where original_job_id<>effective_job_id)<>3
  or(select runtime_digest from private.long_bot_causal_serving_runtime())is distinct from serving_before
 then raise exception 'Campaign size or playing policy changed';end if;
end$$;
notify pgrst,'reload schema';
commit;
