begin;
do $$ declare l jsonb;s jsonb;h text:=repeat('a',64);begin
 l:=jsonb_build_object('policyImplementationId',h,'runtimeDigest',h,'sourceFingerprint',h,
  'screening',jsonb_build_object('schema','long-native-terminal-regression-screen-v1',
   'complete',true,'accepted',true,'comparison',1,'sampleCount',1,'terminalOutcomeConfirmed',false,
   'policyImplementationId',h,'runtimeDigest',h,'sourceFingerprint',h,'color','white',
   'pairing','archived-tape-and-fixed-extension-v1','sameFutureDice',true,'manifestHash',h,'tapeHash',h,
   'control',jsonb_build_object('winner','dark','resultType','normal','ownOff',14,'opponentOff',15,'plies',2,'traceHash',h,'value',jsonb_build_array(0,-1,14,-15)),
   'recommended',jsonb_build_object('winner','white','resultType','normal','ownOff',15,'opponentOff',14,'plies',1,'traceHash',h,'value',jsonb_build_array(1,1,15,-14))));
 if private.long_bot_valid_model_terminal_screen(l)is distinct from true then raise exception 'Complete improving pair rejected';end if;
 if private.long_bot_valid_model_terminal_screen(l-'screening')is distinct from false
  or private.long_bot_valid_model_terminal_screen(jsonb_set(l,'{screening,complete}','false'))is distinct from false
  or private.long_bot_valid_model_terminal_screen(jsonb_set(l,'{screening,terminalOutcomeConfirmed}','true'))is distinct from false
  or private.long_bot_valid_model_terminal_screen(jsonb_set(l,'{screening,sourceFingerprint}',to_jsonb(repeat('b',64))))is distinct from false
  or private.long_bot_valid_model_terminal_screen(jsonb_set(l,'{screening,recommended,ownOff}','14'))is distinct from false
  then raise exception 'Incomplete, relabelled or nonterminal pair admitted';end if;
 s:=l->'screening';l:=jsonb_set(l,'{screening,control}',s->'recommended');
 if private.long_bot_valid_model_terminal_screen(l)is distinct from false then raise exception 'Equal endpoints admitted';end if;
 if private.long_bot_training_replay_tape('[{"sourceTurnIndex":1,"state":{"turn":"dark","dice":[1,2]},"executedMoves":[]}]')is not null
  then raise exception 'Incomplete tape admitted';end if;
 if has_function_privilege('anon','public.claim_long_bot_training_library(text,text,uuid,text)','execute')
  or has_function_privilege('authenticated','private.long_bot_unscreened_model_pool_v1(text)','execute')
  then raise exception 'Private teacher access exposed';end if;
end $$;
rollback;
