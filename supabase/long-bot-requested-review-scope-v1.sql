begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Operator scheduling only. This neither creates jobs nor modifies their
-- source, progress, native policy, terminal endpoints or confidence criteria.
create table if not exists private.long_bot_requested_review_scopes (
 worker_id text primary key check(length(worker_id) between 1 and 128),
 runtime_digest text not null references private.long_bot_causal_releases(runtime_digest),
 job_id bigint not null references private.long_bot_causal_review_jobs(id),
 created_at timestamptz not null default now()
);
alter table private.long_bot_requested_review_scopes enable row level security;
revoke all on private.long_bot_requested_review_scopes from public,anon,authenticated,service_role;
do $scope$
declare definition text; needle text:='where queued.runtime_digest = active.runtime_digest and queued.invalidated_at is null'; replacement text;
begin
 definition:=pg_get_functiondef('public.claim_long_bot_causal_review_jobs(text,integer,text)'::regprocedure);
 if position('private.long_bot_requested_review_scopes' in definition)>0 then return;end if;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>2 then raise exception 'Unexpected claim source';end if;
 replacement:=needle||'
      and (not exists(select 1 from private.long_bot_requested_review_scopes scope where scope.worker_id=p_worker_id)
        or exists(select 1 from private.long_bot_requested_review_scopes scope where scope.worker_id=p_worker_id
          and scope.runtime_digest=active.runtime_digest and scope.job_id=queued.id))';
 execute replace(definition,needle,replacement);
end $scope$;
create or replace function public.get_requested_long_bot_review_status(p_worker_id text,p_runtime_digest text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Trusted worker role required' using errcode='42501';end if;
 return (select jsonb_build_object('jobId',j.id,'status',j.status,'invalidated',j.invalidated_at is not null,
   'slices',j.progress->'slices','finishedReviews',jsonb_array_length(coalesce(j.progress->'finishedReviews','[]'::jsonb)),
   'completedTerminalOutcomes',j.progress->'currentTerminalOutcomes','currentDecisionIndex',j.progress->'currentDecisionIndex',
   'summary',j.result->'summary','lastError',j.last_error)
  from private.long_bot_requested_review_scopes scope join private.long_bot_causal_review_jobs j on j.id=scope.job_id
  where scope.worker_id=p_worker_id and scope.runtime_digest=p_runtime_digest and j.runtime_digest=scope.runtime_digest);
end $$;
revoke all on function public.get_requested_long_bot_review_status(text,text)from public,anon,authenticated;
grant execute on function public.get_requested_long_bot_review_status(text,text)to service_role;
notify pgrst,'reload schema';
commit;
