-- The native engine groups a single experience source by context/action,
-- preserving the first group occurrence and the order within each group.
-- Permit that exact audited transformation, not arbitrary array/set equality.
create table if not exists private.long_bot_pattern_order_compatibility(
 policy_implementation_id text not null check(policy_implementation_id~'^[0-9a-f]{64}$'),
 runtime_digest text not null references private.long_bot_causal_releases(runtime_digest),
 normalization text not null check(normalization='context-action-first-ordinal-v1'),
 primary key(policy_implementation_id,runtime_digest)
);
alter table private.long_bot_pattern_order_compatibility enable row level security;
revoke all on private.long_bot_pattern_order_compatibility from public,anon,authenticated,service_role;
create or replace function private.long_bot_engine_pattern_order(patterns jsonb)
returns jsonb language sql immutable set search_path='' as $$
 with items as(select p,n,
  coalesce(nullif(p->>'contextKey',''),p->>'context_key','')c,
  coalesce(nullif(p->>'actionKey',''),p->>'action_key','')a
  from jsonb_array_elements(case when jsonb_typeof(patterns)='array'then patterns else '[]'::jsonb end)with ordinality e(p,n)),
 grouped as(select *,min(n)over(partition by c,a)first_n from items)
 select case when jsonb_typeof(patterns)='array'and count(*)<=256
  and coalesce(bool_and(jsonb_typeof(p)='object'and c<>''and a<>''),true)
  then coalesce(jsonb_agg(p order by first_n,n),'[]'::jsonb)else null end from grouped
$$;
revoke all on function private.long_bot_engine_pattern_order(jsonb)from public,anon,authenticated,service_role;
do $$ declare d text;needle text;begin
 d:=pg_get_functiondef('private.long_bot_causal_signed_experience_for_game(public.bot_training_games,text,text)'::regprocedure);
 needle:='and x.patterns = archived->''patterns''';
 if position('long_bot_engine_pattern_order'in d)=0 then
  if position(needle in d)=0 then raise exception 'Unexpected signed source validator';end if;
  execute replace(d,needle,E'and (x.patterns = archived->''patterns'' or(\n      exists(select 1 from private.long_bot_pattern_order_compatibility c\n       where c.policy_implementation_id=p_policy_implementation_id and c.runtime_digest=p_runtime_digest\n        and c.normalization=''context-action-first-ordinal-v1'')\n      and private.long_bot_engine_pattern_order(x.patterns)=archived->''patterns''))');
 end if;
 d:=pg_get_functiondef('public.verify_long_bot_review_experience(bigint,text,text)'::regprocedure);
 needle:='''snapshotHash'', sealed.snapshot_hash, ''patterns'', sealed.patterns';
 if position('sourcePatternOrder'in d)=0 then
  if position(needle in d)=0 then raise exception 'Unexpected warm experience verifier';end if;
  -- The helper verified the ORIGINAL signed row above. Attest the archived
  -- engine order without changing that row, its signature or its snapshot hash.
  execute replace(d,needle,'''snapshotHash'', sealed.snapshot_hash, ''patterns'', game.final_state#>''{analysis,botMemory,replayExperience,patterns}'', ''sourcePatternOrder'', ''signed-or-audited-context-action-grouping-v1''');
 end if;
end $$;
