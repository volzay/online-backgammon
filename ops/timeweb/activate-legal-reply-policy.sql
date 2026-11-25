-- Correct mandatory primary and continuation replies in every V26 situation mode.
-- All predecessor code roots, jobs, signatures and model identities remain intact.
-- Run only after installing the immutable closure and allowing the previous
-- library worker to checkpoint/exit. The default is a rollback preflight.
-- Exact Node/V8/source tuple: legal-reply-runtime-lock.json.
-- psql -v new_runtime_digest=... -v new_library_runtime_digest=... [-v apply=true]
\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif
begin;
set local lock_timeout='5s';
set local statement_timeout='40s';
select set_config('nardu.legal_reply_runtime', :'new_runtime_digest', true);
select set_config('nardu.legal_reply_library', :'new_library_runtime_digest', true);
lock table private.long_bot_causal_policy_routes in share row exclusive mode;
lock table private.long_bot_training_library_releases in share row exclusive mode;
lock table public.rooms in share mode;
\ir ../../supabase/long-bot-model-terminal-screen-v1.sql
\ir ../../supabase/long-bot-screened-advice-serving-v1.sql
\ir ../../supabase/long-bot-signed-pattern-order-v1.sql
insert into private.long_bot_pattern_order_compatibility(policy_implementation_id,runtime_digest,normalization)
values('d8cfc3442dd5c9e81a8f13bfe34052a86aa6df4bbf3fe9b7e3aca780161dece9',
 'b2c73713703afd831088a9990bd305fee7ac40fb4c24fe4a4c9fea35007512e2','context-action-first-ordinal-v1')on conflict do nothing;
-- Formalize the temporary protection for the predecessor inside this same
-- transaction before comparing the published pool across the cutover.
insert into private.long_bot_model_serving_requirements(policy_implementation_id,require_terminal_screen)
values('d8cfc3442dd5c9e81a8f13bfe34052a86aa6df4bbf3fe9b7e3aca780161dece9',true)
on conflict(policy_implementation_id)do update set require_terminal_screen=true;
do $release$
declare
 old_policy constant text:='d8cfc3442dd5c9e81a8f13bfe34052a86aa6df4bbf3fe9b7e3aca780161dece9';
 new_policy constant text:='9417fd02f1f6957e878c0376aa00dbf91d2c6e3065269d27a3b2846b52e3ff13';
 old_library constant text:='c75bc649b782b9b98fef2adf621b35cbf3c218666307c0ba992205c8b5e6eb16';
 native_digest text:=current_setting('nardu.legal_reply_runtime');
 library_digest text:=current_setting('nardu.legal_reply_library');
 serving private.long_bot_causal_runtime;
 published_before jsonb;cutover timestamptz;
 archives_before bigint;games_before bigint;jobs_before bigint;evidence_before bigint;
 snapshots_before bigint;links_before bigint;reviews_before bigint;
 key_before text;key_after text;loader_definition text;inserted integer;g public.bot_training_games;
begin
 if native_digest!~'^[0-9a-f]{64}$'or library_digest!~'^[0-9a-f]{64}$'
  or native_digest=library_digest then raise exception 'Distinct server-attested identities required';end if;
 if native_digest<>'0eb6b195cda160071ce48517bf8ddfefdef6236c173ddd446bea5b7badb16a0c'
  or library_digest<>'215e82cbac30847edb0d646532a144fdb6baf2935e96789599ca9e9c23cec078'
  then raise exception 'Runtime differs from the reviewed immutable source tuple';end if;
 select * into serving from private.long_bot_causal_serving_runtime();
 if serving.explicitly_approved is distinct from true or serving.policy_implementation_id is distinct from old_policy
  or serving.runtime_digest is distinct from 'b2c73713703afd831088a9990bd305fee7ac40fb4c24fe4a4c9fea35007512e2'
  or not exists(select 1 from private.long_bot_causal_policy_routes where runtime_digest=serving.runtime_digest
    and enabled and serves_patterns and require_explicit_policy_identity) then
  raise exception 'Serving predecessor differs from the reviewed release';end if;
 if exists(select 1 from private.long_bot_causal_releases where runtime_digest=native_digest)
  or exists(select 1 from private.long_bot_board_model_releases where runtime_digest=library_digest)
  or exists(select 1 from private.long_bot_board_model_source_bindings where playing_policy_implementation_id=new_policy)
  then raise exception 'New identity already registered; inspect rather than reinitialise';end if;
 if exists(select 1 from public.rooms where variant='long'and status='joined'
  and game_state->>'mode'='bot'and game_state->>'botDifficulty'='hard'and game_state->>'winner'is null)
  then raise exception 'Allow existing hard long games to finish before cutover';end if;
 if not exists(select 1 from private.long_bot_training_library_releases where runtime_digest=old_library and enabled)
  or exists(select 1 from private.long_bot_training_library where lease_until>now())
  then raise exception 'Previous library worker must checkpoint and exit';end if;
 loader_definition:=pg_get_functiondef('public.load_signed_long_bot_experience(text,text,bigint)'::regprocedure);
 if position('if sealed.room_id is null then'in loader_definition)=0
  or position('select * into active from private.long_bot_causal_serving_runtime()'in loader_definition)
    <=position('if sealed.room_id is null then'in loader_definition)
  then raise exception 'Issued snapshot restoration transition is required';end if;
 published_before:=public.get_long_bot_experience_patterns(null);
 if jsonb_typeof(published_before)is distinct from 'array'or jsonb_array_length(published_before)=0
  or exists(select 1 from jsonb_array_elements(published_before)p where p->>'creditVersion'is distinct from '10'
    or p->>'evidenceSchema'is distinct from 'long-server-board-model-pattern-v1'
    or p->'terminalOutcomeConfirmed'is distinct from 'false'::jsonb)
  then raise exception 'Expected typed model advice; terminal evidence needs separate policy review';end if;
 select count(*)into archives_before from public.room_game_archives;
 select count(*)into games_before from public.bot_training_games;
 select count(*)into jobs_before from private.long_bot_causal_review_jobs;
 select count(*)into evidence_before from private.long_bot_causal_evidence;
 select count(*)into snapshots_before from private.long_bot_signed_experience_snapshots;
 select count(*)into links_before from private.long_bot_causal_experience_sources;
 select count(*)into reviews_before from private.long_bot_training_turn_reviews;
 select encode(extensions.digest(secret,'sha256'),'hex')into key_before
  from private.long_bot_experience_signing_key where singleton;
 if key_before is null then raise exception 'Existing signing key required';end if;

 cutover:=clock_timestamp();
 insert into private.long_bot_causal_releases(runtime_digest,reviewer_version,policy_implementation_id)
 values(native_digest,serving.reviewer_version,new_policy);
 insert into private.long_bot_causal_warm_review_releases(runtime_digest)values(native_digest);
 insert into private.long_bot_pattern_order_compatibility(policy_implementation_id,runtime_digest,normalization)
 values(new_policy,native_digest,'context-action-first-ordinal-v1');
 insert into private.long_bot_causal_policy_routes(runtime_digest,policy_implementation_id,reviewer_version,
  enabled,serves_patterns,accept_completed_since,accept_completed_before,require_explicit_policy_identity)
 values(native_digest,new_policy,serving.reviewer_version,true,false,cutover,null,true);
 insert into private.long_bot_model_serving_requirements(policy_implementation_id,require_terminal_screen)
 values(new_policy,true);
 insert into private.long_bot_board_model_releases(runtime_digest,policy_implementation_id,max_root_positions,require_terminal_screen)
 values(library_digest,new_policy,256,true);
 insert into private.long_bot_training_library_releases(runtime_digest,enabled)values(library_digest,false);

 -- Model proposals retain original payloads and original source identities.
 -- These exact bridges grant no compatibility to old terminal certificates.
 insert into private.long_bot_board_model_source_bindings
 (playing_policy_implementation_id,source_policy_implementation_id,source_runtime_digest,scope)
 select new_policy,r.policy_implementation_id,r.runtime_digest,'model-advice-only-with-fresh-dice-comparison'
 from private.long_bot_board_model_releases r where (r.policy_implementation_id,r.runtime_digest)in(
 ('2eac358adb59616fd96c7fe84fad43ef252d010906d6f6d7c69ac46c92c207b2','5a0d17b50bcc9b4900ccd1e7c133f5f85fe23676b010e46f985cc799f5369146'),
 ('7a263bcd3a44b7248b1b369e18dd552f1a5053e4f0772561f13c9a95e56abfa7','da5b3fc55b3eb36337bd6d5239a720f30016791e4aa69e157387843db4be7e69'),
 ('db212e88d758f309b3ac3027c857acc55e8a415d1cdf4da3b5d753eea82be10b','3834ce78002a7c31edb9f45bcd371116ef4273153f16aacad17c4917dbd2781c'),
 ('db212e88d758f309b3ac3027c857acc55e8a415d1cdf4da3b5d753eea82be10b','f10fda9564e1a428f24963c71277a0ab4a0b7f72065cfbd4b5ebb09ff028a8a1'),('06611894f7abdfe158a431d564f05bf47772ff05b1a684f26bacb775b711578a','912543d042c3d0adc49dac821baf63a2ad4b9f53afca4e8ae7d19efa54eb7abd'),('1df51161ea08533712a1f392adc76a7116b4f20bf0e566c1ca244a9d46295f0a','7ca306af58dea32ba52a9611b24929411f986c4ce6aab68760e8ecfc2473e497'),(old_policy,old_library));
 get diagnostics inserted=row_count;
 if inserted<>7 then raise exception 'Exact model source releases are missing';end if;

 -- Reuse only verified INPUT classifications. Reviews, outcomes and cursors
 -- remain in their original runtime; the new teacher produces its own work.
 insert into private.long_bot_training_library(game_id,fingerprint,runtime_digest,classification_status,classification,turns)
 select q.game_id,q.fingerprint,library_digest,q.classification_status,
  q.classification||jsonb_build_object('reusedClassificationRuntime',q.runtime_digest),q.turns
 from private.long_bot_training_library q join private.long_bot_training_source_heads h
  on h.game_id=q.game_id and h.fingerprint=q.fingerprint
 where q.runtime_digest=old_library and q.classification_status<>'pending'
  and coalesce(q.classification->>'reason','')<>'source-result-mismatch';
 update private.long_bot_training_library_releases set enabled=false where enabled;
 update private.long_bot_training_library_releases set enabled=true where runtime_digest=library_digest;
 for g in select * from public.bot_training_games where difficulty='hard'and final_state->>'variant'='long'
 loop perform private.sync_long_bot_training_library(g);end loop;
 update private.long_bot_causal_policy_routes set accept_completed_before=cutover
 where enabled and policy_implementation_id=old_policy and accept_completed_before is null;
 update private.long_bot_causal_policy_routes set serves_patterns=false where runtime_digest=serving.runtime_digest;
 update private.long_bot_causal_policy_routes set serves_patterns=true where runtime_digest=native_digest;

 if not exists(select 1 from private.long_bot_causal_serving_runtime()
  where runtime_digest=native_digest and policy_implementation_id=new_policy)
  or public.get_long_bot_experience_patterns(null)is distinct from published_before
  then raise exception 'Serving identity or original model advice changed unexpectedly';end if;
 select encode(extensions.digest(secret,'sha256'),'hex')into key_after
  from private.long_bot_experience_signing_key where singleton;
 if key_after is distinct from key_before
  or(select count(*)from public.room_game_archives)<>archives_before
  or(select count(*)from public.bot_training_games)<>games_before
  or(select count(*)from private.long_bot_causal_review_jobs)<>jobs_before
  or(select count(*)from private.long_bot_causal_evidence)<>evidence_before
  or(select count(*)from private.long_bot_signed_experience_snapshots)<>snapshots_before
  or(select count(*)from private.long_bot_causal_experience_sources)<>links_before
  or(select count(*)from private.long_bot_training_turn_reviews)<>reviews_before
  then raise exception 'Original archives, work, evidence, signatures or reviews changed';end if;
end;
$release$;
\if :apply
commit;
\else
rollback;
\endif
