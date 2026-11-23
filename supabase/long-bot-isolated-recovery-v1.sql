begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- These historical runtimes were re-enabled solely for the exact campaign.
-- Other workers must not lease its jobs in the original shared journal root.
do $$declare d text;needle text:='   select * into active from private.long_bot_causal_approved_runtime(p_runtime_digest);';begin
 d:=pg_get_functiondef('public.claim_long_bot_causal_review_jobs(text,integer,text)'::regprocedure);
 if position('Recovery runtimes reserve their exact private journal owner' in d)=0 then
  if position(needle in d)=0 then raise exception 'Unexpected scoped claim contract';end if;
  execute replace(d,needle,$guard$   -- Recovery runtimes reserve their exact private journal owner.
   if exists(select 1 from private.long_bot_causal_recovery_grants where runtime_digest=p_runtime_digest)then return '[]'::jsonb;end if;
   select * into active from private.long_bot_causal_approved_runtime(p_runtime_digest);$guard$);
 end if;
end$$;
create or replace function public.renew_long_bot_recovery_campaign()
returns jsonb language plpgsql security definer set search_path='' as $$
declare affected integer;begin
 if coalesce(auth.role(),'')<>'service_role'then raise exception 'Worker role required'using errcode='42501';end if;
 if(select count(*)from private.long_bot_causal_recovery_targets)<>43 then raise exception 'Exact original campaign required';end if;
 if exists(select 1 from private.long_bot_causal_recovery_targets t
  join private.long_bot_causal_review_jobs j on j.id=t.effective_job_id
  join private.long_bot_causal_recovery_grants g on g.job_id=j.id
  join public.bot_training_games a on a.id=j.training_game_id
  where j.invalidated_at is not null or j.runtime_digest<>g.runtime_digest or j.archive_fingerprint<>g.archive_fingerprint
   or j.archive_fingerprint is distinct from private.long_bot_causal_archive_fingerprint(a)
   or now()>=g.created_at+interval '45 days'
   or not exists(select 1 from private.long_bot_causal_policy_routes r where r.runtime_digest=j.runtime_digest and r.enabled and not r.serves_patterns))
 then raise exception 'Recovery source, review-only approval or bounded campaign deadline changed';end if;
 -- Only operational lease authority is extended. No attempt, source, review,
 -- sample, checkpoint, outcome or confidence value is changed by renewal.
 update private.long_bot_causal_recovery_grants g set expires_at=greatest(g.expires_at,
  least(g.created_at+interval '45 days',now()+interval '14 days'))
 from private.long_bot_causal_recovery_targets t where g.job_id=t.effective_job_id;
 get diagnostics affected=row_count;
 if affected<>43 then raise exception 'Incomplete recovery target/grant mapping';end if;
 return jsonb_build_object('renewed',affected,'maximumOperationalDays',45);
end$$;
revoke all on function public.renew_long_bot_recovery_campaign()from public,anon,authenticated;
grant execute on function public.renew_long_bot_recovery_campaign()to service_role;
notify pgrst,'reload schema';
commit;
