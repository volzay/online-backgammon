begin;
do $$ declare raw jsonb;ordered jsonb;begin
 raw:='[{"contextKey":"a","actionKey":"x","id":1},{"contextKey":"b","actionKey":"y","id":2},{"contextKey":"a","actionKey":"x","id":3}]';
 ordered:=private.long_bot_engine_pattern_order(raw);
 if ordered is distinct from '[{"contextKey":"a","actionKey":"x","id":1},{"contextKey":"a","actionKey":"x","id":3},{"contextKey":"b","actionKey":"y","id":2}]'::jsonb
  or private.long_bot_engine_pattern_order(ordered)is distinct from ordered then raise exception 'Native grouping differs';end if;
 if private.long_bot_engine_pattern_order(raw||raw) is not distinct from ordered
  or private.long_bot_engine_pattern_order(jsonb_set(raw,'{0,id}','999'))is not distinct from ordered
  or private.long_bot_engine_pattern_order('[{"contextKey":"a","actionKey":"x","id":3},{"contextKey":"a","actionKey":"x","id":1},{"contextKey":"b","actionKey":"y","id":2}]')is not distinct from ordered
  or private.long_bot_engine_pattern_order('[{}]')is not null then raise exception 'Changed pattern, multiplicity or within-group order admitted';end if;
 if has_function_privilege('anon','private.long_bot_engine_pattern_order(jsonb)','execute')then raise exception 'Private normalizer exposed';end if;
end $$;
rollback;
