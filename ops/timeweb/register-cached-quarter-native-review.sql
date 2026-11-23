\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select set_config('nardu.requested_cached_runtime',:'new_runtime_digest',true);
do $release$
declare old_route private.long_bot_causal_policy_routes; cached text:=current_setting('nardu.requested_cached_runtime');
begin
 if cached is distinct from '18f05bafa638c1d0dea35c5bfa933c071a1bfa409bd55333e30871c5bc961ec5' then raise exception 'Unexpected independently computed cached reviewer';end if;
 select * into old_route from private.long_bot_causal_policy_routes where runtime_digest='d7fd1192b3c1cea8e1793b9261703f85c4a9effd18169dc2eeb1b4a567b99183';
 if old_route.enabled is distinct from true or old_route.policy_implementation_id is distinct from 'd33a1c6219a986aee5e64312d233fa38db5aeb86e84aa13e6cd3578918d38306'
  or old_route.require_explicit_policy_identity is distinct from true then raise exception 'Unexpected original source route';end if;
 if exists(select 1 from private.long_bot_causal_releases where runtime_digest=cached) then raise exception 'Already registered; inspect original binding';end if;
 insert into private.long_bot_causal_releases(runtime_digest,reviewer_version,policy_implementation_id)
 values(cached,old_route.reviewer_version,old_route.policy_implementation_id);
 insert into private.long_bot_causal_warm_review_releases(runtime_digest)values(cached);
 insert into private.long_bot_causal_policy_routes(runtime_digest,policy_implementation_id,reviewer_version,enabled,serves_patterns,
  accept_completed_since,accept_completed_before,require_explicit_policy_identity)
 values(cached,old_route.policy_implementation_id,old_route.reviewer_version,true,false,
  old_route.accept_completed_since,old_route.accept_completed_before,true);
end $release$;
insert into private.long_bot_causal_review_jobs(training_game_id,runtime_digest,archive_fingerprint)
select g.id,current_setting('nardu.requested_cached_runtime'),private.long_bot_causal_archive_fingerprint(g)
from public.bot_training_games g join private.long_bot_causal_review_jobs original on original.training_game_id=g.id
where original.id in(2401,2402) and original.runtime_digest='d7fd1192b3c1cea8e1793b9261703f85c4a9effd18169dc2eeb1b4a567b99183'
 and original.invalidated_at is null and original.archive_fingerprint=private.long_bot_causal_archive_fingerprint(g)
 and private.long_bot_causal_archive_routes_to(g,current_setting('nardu.requested_cached_runtime'))
on conflict(training_game_id,runtime_digest,archive_fingerprint)do nothing;
do $$ begin if(select count(*)from private.long_bot_causal_review_jobs j join public.bot_training_games g on g.id=j.training_game_id
 where j.runtime_digest=current_setting('nardu.requested_cached_runtime')and g.room_code in('8JPN-KUD8','CTNM-E43Z'))<>2 then raise exception 'Expected both exact original source revisions';end if;end $$;
select jsonb_build_object('newJobId',j.id,'room',g.room_code,'runtime',j.runtime_digest,'sourceFingerprint',j.archive_fingerprint)
from private.long_bot_causal_review_jobs j join public.bot_training_games g on g.id=j.training_game_id
where j.runtime_digest=current_setting('nardu.requested_cached_runtime')and g.room_code in('8JPN-KUD8','CTNM-E43Z');
-- Original jobs, endpoints, signatures and game archives are retained as-is.
commit;
