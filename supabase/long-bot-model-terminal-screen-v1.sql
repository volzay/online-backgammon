-- Included inside the policy activation transaction. Historical advice and
-- terminal confidence certificates keep their original identities and bytes.
alter table private.long_bot_board_model_releases
 add column if not exists require_terminal_screen boolean not null default false;

create or replace function private.long_bot_valid_model_terminal_screen(l jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare s jsonb:=l->'screening';a jsonb;b jsonb;v numeric[];w numeric[];c text;expected numeric[];
begin
 if s->>'schema' is distinct from 'long-native-terminal-regression-screen-v1'
  or s->'complete' is distinct from 'true'::jsonb or s->'accepted' is distinct from 'true'::jsonb
  or s->>'comparison' is distinct from '1' or s->>'sampleCount' is distinct from '1'
  or s->'terminalOutcomeConfirmed' is distinct from 'false'::jsonb
  or s->>'policyImplementationId' is distinct from l->>'policyImplementationId'
  or s->>'runtimeDigest' is distinct from l->>'runtimeDigest'
  or s->>'sourceFingerprint' is distinct from l->>'sourceFingerprint'
  or s->>'pairing' is distinct from 'archived-tape-and-fixed-extension-v1'
  or s->'sameFutureDice' is distinct from 'true'::jsonb
  or coalesce(s->>'manifestHash','')!~'^[0-9a-f]{64}$'
  or coalesce(s->>'tapeHash','')!~'^[0-9a-f]{64}$'
  or coalesce(s->>'color','') not in('white','dark') then return false;end if;
 c:=s->>'color';a:=s->'control';b:=s->'recommended';
 foreach s in array array[a,b] loop
  if coalesce(s->>'winner','') not in('white','dark')
   or coalesce(s->>'resultType','') not in('normal','mars','koks')
   or coalesce((s->>'ownOff')::integer,-1) not between 0 and 15
   or coalesce((s->>'opponentOff')::integer,-1) not between 0 and 15
   or (case when s->>'winner'=c then s->>'ownOff' else s->>'opponentOff' end) is distinct from '15'
   or coalesce((s->>'plies')::integer,0) not between 1 and 512
   or coalesce(s->>'traceHash','')!~'^[0-9a-f]{64}$'
   or jsonb_array_length(s->'value') is distinct from 4 then return false;end if;
  expected:=array[case when s->>'winner'=c then 1 else 0 end,
   (case s->>'resultType' when 'koks' then 3 when 'mars' then 2 else 1 end)*(case when s->>'winner'=c then 1 else -1 end),
   (s->>'ownOff')::integer,-(s->>'opponentOff')::integer];
  select array_agg(x::numeric order by n) into v from jsonb_array_elements_text(s->'value')with ordinality e(x,n);
  if v is distinct from expected then return false;end if;
 end loop;
 select array_agg(x::numeric order by n) into v from jsonb_array_elements_text(a->'value')with ordinality e(x,n);
 select array_agg(x::numeric order by n) into w from jsonb_array_elements_text(b->'value')with ordinality e(x,n);
 return coalesce(w>v,false);
exception when others then return false;
end $$;
revoke all on function private.long_bot_valid_model_terminal_screen(jsonb) from public,anon,authenticated,service_role;

-- Preserve the public function OID, argument contract and existing grants.
do $$ declare d text;needle text;begin
 if to_regprocedure('private.long_bot_unscreened_model_pool_v1(text)')is null then
  d:=pg_get_functiondef('public.get_long_bot_experience_patterns(text)'::regprocedure);
  needle:='CREATE OR REPLACE FUNCTION public.get_long_bot_experience_patterns(';
  if position(needle in d)<>1 or position('long_bot_training_turn_reviews'in d)=0 then raise exception 'Unexpected model pool definition';end if;
  execute replace(d,needle,'CREATE OR REPLACE FUNCTION private.long_bot_unscreened_model_pool_v1(');
 end if;
end $$;
revoke all on function private.long_bot_unscreened_model_pool_v1(text) from public,anon,authenticated,service_role;
create or replace function public.get_long_bot_experience_patterns(p_player_name text default null)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(p order by n),'[]'::jsonb)
 from jsonb_array_elements(private.long_bot_unscreened_model_pool_v1(p_player_name))with ordinality e(p,n)
 where not exists(select 1 from private.long_bot_board_model_releases r
  where r.runtime_digest=p->>'runtimeDigest' and r.policy_implementation_id=p->>'policyImplementationId'
   and r.require_terminal_screen) or private.long_bot_valid_model_terminal_screen(p)
$$;

create or replace function private.long_bot_training_replay_tape(turns jsonb)
returns jsonb language sql immutable set search_path='' as $$
 with t as(select x,(x->>'sourceTurnIndex')::integer i from jsonb_array_elements(turns)x),
 checked as(select x,i,row_number()over(order by i)-1 expected from t)
 select case when count(*) between 1 and 600 and bool_and(i=expected)
  then jsonb_agg(jsonb_build_object('color',x#>>'{state,turn}','dice',x#>'{state,dice}','moves',x->'executedMoves')order by i)
  else null end from checked
$$;
revoke all on function private.long_bot_training_replay_tape(jsonb) from public,anon,authenticated,service_role;

do $$ declare d text;needle text;begin
 d:=pg_get_functiondef('public.claim_long_bot_training_library(text,text,uuid,text)'::regprocedure);
 needle:='''classification'',q.classification,''cursor'',q.cursor,''turn'',q.turns->q.cursor,';
 if position('''replayTape'''in d)=0 then
  if position(needle in d)=0 then raise exception 'Unexpected library claim definition';end if;
  execute replace(d,needle,needle||E'\n  ''replayTape'',case when q.classification->>''historyVerified''=''true'' then private.long_bot_training_replay_tape(q.turns) else null end,');
 end if;
 d:=pg_get_functiondef('public.checkpoint_long_bot_training_library(uuid,text,text,uuid,integer,jsonb)'::regprocedure);
 d:=replace(d,'retry_after=now()+interval ''6 hours''',
  'retry_after=now()+case when p_review->>''phase''=''terminal-screen'' then interval ''1 minute'' else interval ''6 hours'' end');
 needle:='insert into private.long_bot_training_turn_reviews';
 if position('Unscreened production lesson'in d)=0 then
  if position(needle in d)=0 then raise exception 'Unexpected library checkpoint definition';end if;
  execute replace(d,needle,E'if l is not null and exists(select 1 from private.long_bot_board_model_releases where runtime_digest=p_runtime and require_terminal_screen)\n and not private.long_bot_valid_model_terminal_screen(l) then raise exception ''Unscreened production lesson'';end if;\n '||needle);
 end if;
end $$;
notify pgrst,'reload schema';
