-- Run after long-bot-training-library-v1.sql. Every test write rolls back.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $test$
declare g public.bot_training_games;c jsonb;c2 jsonb;result jsonb;
 owner uuid:=gen_random_uuid();other_owner uuid:=gen_random_uuid();before_patterns jsonb;
begin
 before_patterns:=public.get_long_bot_experience_patterns(null);
 if (select count(*)from private.long_bot_training_source_heads)<>(select count(*)from public.bot_training_games where difficulty='hard'and final_state->>'variant'='long')then raise exception 'Incomplete source catalogue';end if;
 select * into g from public.bot_training_games where difficulty='hard'and final_state->>'variant'='long' order by id limit 1;
 update private.long_bot_training_library_releases set enabled=false where enabled;
 insert into private.long_bot_board_model_releases(runtime_digest,policy_implementation_id,max_root_positions)values(repeat('f',64),repeat('e',64),256);
 insert into private.long_bot_training_library_releases values(repeat('f',64),true);
 perform private.sync_long_bot_training_library(g);
 c:=public.claim_long_bot_training_library(repeat('f',64),repeat('e',64),owner,'classify');
 c2:=public.claim_long_bot_training_library(repeat('f',64),repeat('e',64),other_owner,'classify');
 if c->>'gameId' is null or c2 is not null then raise exception 'Claim/lease exclusion failed';end if;
 result:='{"classificationStatus":"ready","classification":{"totalTurns":1,"historyVerified":true},"turns":[{"positionHash":"test-hash","positionKey":"test-only"}]}';
 begin
  perform public.classify_long_bot_training_library(g.id,c->>'fingerprint',repeat('f',64),other_owner,result);
  raise exception 'Stale owner accepted';
 exception when raise_exception then if SQLERRM='Stale owner accepted'then raise;end if;end;
 perform public.classify_long_bot_training_library(g.id,c->>'fingerprint',repeat('f',64),owner,result);
 c:=public.claim_long_bot_training_library(repeat('f',64),repeat('e',64),owner,'review');
 begin
  perform public.checkpoint_long_bot_training_library(g.id,c->>'fingerprint',repeat('f',64),owner,0,
   '{"status":"model-reviewed","turnIndex":0,"positionHash":"test-hash","lesson":{"terminalOutcomeConfirmed":true}}');
  raise exception 'Forged lesson accepted';
 exception when raise_exception then if SQLERRM='Forged lesson accepted'then raise;end if;end;
 result:=public.checkpoint_long_bot_training_library(g.id,c->>'fingerprint',repeat('f',64),owner,0,'{"status":"capacity","turnIndex":0,"positionHash":"test-hash"}');
 if result->>'cursor'<>'0' or result->>'deferred'<>'true'then raise exception 'Capacity falsely advanced';end if;
 update private.long_bot_training_library set retry_after='-infinity'where runtime_digest=repeat('f',64);
 c:=public.claim_long_bot_training_library(repeat('f',64),repeat('e',64),owner,'review');
 result:=public.checkpoint_long_bot_training_library(g.id,c->>'fingerprint',repeat('f',64),owner,0,'{"status":"no-applicable-improvement","turnIndex":0,"positionHash":"test-hash"}');
 if result->>'cursor'<>'1'then raise exception 'Review receipt not checkpointed';end if;
 if public.get_long_bot_experience_patterns(null) is distinct from before_patterns then raise exception 'Existing advice changed';end if;
 update public.bot_training_games set final_state=final_state||'{"trainingLibraryRollbackProbe":true}'where id=g.id;
 if exists(select 1 from private.long_bot_training_source_heads where game_id=g.id and fingerprint=c->>'fingerprint')then raise exception 'Source change did not invalidate advice';end if;
 if not exists(select 1 from private.long_bot_training_library where game_id=g.id and runtime_digest=repeat('f',64)and classification_status='pending')then raise exception 'Changed source not enqueued';end if;
 if has_function_privilege('anon','public.claim_long_bot_training_library(text,text,uuid,text)','execute')
  or has_function_privilege('authenticated','public.checkpoint_long_bot_training_library(uuid,text,text,uuid,integer,jsonb)','execute')
  or has_table_privilege('authenticated','private.long_bot_training_library','select')then raise exception 'Private sources exposed';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('email',(public.admin_email_whitelist())[1])::text,true);
 result:=public.admin_long_bot_training_library(0,0);
 if jsonb_typeof(result->'modelAdvice') is distinct from 'object'
  or result#>'{modelAdvice,lessons}' is null or result#>'{modelAdvice,sources}' is null
 then raise exception 'Malformed administrator lesson statistics';end if;
 raise notice 'PASS: backfill, leases, stale writes, forged advice, capacity retry, receipts, source invalidation and permissions';
end $test$;
rollback;
