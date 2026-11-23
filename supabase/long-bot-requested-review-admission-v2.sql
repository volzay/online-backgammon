begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $admission$
declare definition text; needle text:=$old$where snapshot.eligible$old$; replacement text;
begin
 definition:=pg_get_functiondef('public.claim_long_bot_causal_review_jobs(text,integer,text)'::regprocedure);
 if position('requested_job.training_game_id=archived.id' in definition)>0 then return;end if;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected scoped admission source';end if;
 replacement:=$new$where snapshot.eligible
      and (not exists(select 1 from private.long_bot_requested_review_scopes requested_scope where requested_scope.worker_id=p_worker_id)
        or exists(select 1 from private.long_bot_requested_review_scopes requested_scope
          join private.long_bot_causal_review_jobs requested_job on requested_job.id=requested_scope.job_id
          where requested_scope.worker_id=p_worker_id and requested_scope.runtime_digest=active.runtime_digest
            and requested_job.training_game_id=archived.id))$new$;
 execute replace(definition,needle,replacement);
end $admission$;
commit;
