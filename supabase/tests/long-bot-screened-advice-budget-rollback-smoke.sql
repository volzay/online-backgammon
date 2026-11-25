begin;
do $$ declare eligible_count integer;eligible_bytes bigint;actual jsonb;begin
 -- A bounded production-shaped source pool: if all compatible, screened
 -- library advice fits, rejected legacy advice cannot displace any of it.
 select count(distinct t.payload->'lesson'->>'aggregateId'),coalesce(sum(octet_length((t.payload->'lesson')::text)+2),0)
 into eligible_count,eligible_bytes
 from private.long_bot_training_turn_reviews t
 join private.long_bot_training_source_heads h on h.game_id=t.game_id and h.fingerprint=t.fingerprint
 join private.long_bot_board_model_releases r on r.runtime_digest=t.runtime_digest
 join private.long_bot_causal_serving_runtime()a on true
 where t.status='model-reviewed'and t.created_at>=now()-interval '180 days'
  and private.long_bot_valid_model_terminal_screen(t.payload->'lesson')
  and(r.policy_implementation_id=a.policy_implementation_id or exists(
   select 1 from private.long_bot_board_model_source_bindings b where b.playing_policy_implementation_id=a.policy_implementation_id
    and b.source_policy_implementation_id=r.policy_implementation_id and b.source_runtime_digest=r.runtime_digest));
 actual:=public.get_long_bot_experience_patterns(null);
 if eligible_count>0 and eligible_count<=256 and eligible_bytes<470000
  and(select count(*)from jsonb_array_elements(actual)p where p->>'creditVersion'='10'and private.long_bot_valid_model_terminal_screen(p))<eligible_count
  then raise exception 'Unadmitted proposals consumed the verified-advice budget';end if;
 if octet_length(actual::text)>524288 or jsonb_array_length(actual)>256 then raise exception 'Signed pool bounds changed';end if;
end $$;
rollback;
