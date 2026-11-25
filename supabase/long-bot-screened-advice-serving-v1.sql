-- The playing release may require full native regression screening even for
-- grandfathered model proposals. Original payloads and source rows stay intact.
create table if not exists private.long_bot_model_serving_requirements(
 policy_implementation_id text primary key check(policy_implementation_id~'^[0-9a-f]{64}$'),
 require_terminal_screen boolean not null default true
);
alter table private.long_bot_model_serving_requirements enable row level security;
revoke all on private.long_bot_model_serving_requirements from public,anon,authenticated,service_role;
-- Admission must precede the backing pool's byte/count limits. Otherwise
-- rejected legacy proposals can consume almost the entire signed payload and
-- displace qualifying advice before the public wrapper ever sees it.
do $$ declare d text;needle text;begin
 d:=pg_get_functiondef('private.long_bot_unscreened_model_pool_v1(text)'::regprocedure);
 needle:='select payload from dedup order by priority,source_round,created_at desc,payload->>''aggregateId''';
 if position('long_bot_model_serving_requirements'in d)=0 then
  if position(needle in d)=0 then raise exception 'Unexpected bounded advice pool';end if;
  execute replace(d,needle,E'select payload from dedup where private.long_bot_valid_model_terminal_screen(payload)or(\n  not exists(select 1 from private.long_bot_board_model_releases r where r.runtime_digest=payload->>''runtimeDigest''and r.policy_implementation_id=payload->>''policyImplementationId''and r.require_terminal_screen)\n  and not exists(select 1 from private.long_bot_model_serving_requirements r join private.long_bot_causal_serving_runtime()a on a.policy_implementation_id=r.policy_implementation_id where r.require_terminal_screen and payload->>''creditVersion''=''10''))\n order by priority,source_round,created_at desc,payload->>''aggregateId''');
 end if;
end $$;
create or replace function public.get_long_bot_experience_patterns(p_player_name text default null)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(p order by n),'[]'::jsonb)
 from jsonb_array_elements(private.long_bot_unscreened_model_pool_v1(p_player_name))with ordinality e(p,n)
 where private.long_bot_valid_model_terminal_screen(p) or(
  not exists(select 1 from private.long_bot_board_model_releases r
   where r.runtime_digest=p->>'runtimeDigest'and r.policy_implementation_id=p->>'policyImplementationId'and r.require_terminal_screen)
  and not exists(select 1 from private.long_bot_model_serving_requirements r
   join private.long_bot_causal_serving_runtime()a on a.policy_implementation_id=r.policy_implementation_id
   where r.require_terminal_screen and p->>'creditVersion'='10'))
$$;
