begin;
-- An explicit model-advice bridge, never a terminal-evidence alias. Payloads,
-- source IDs, archive fingerprints and original reviewer runtime remain intact.
create table if not exists private.long_bot_board_model_source_bindings (
 playing_policy_implementation_id text not null check(playing_policy_implementation_id~'^[0-9a-f]{64}$'),
 source_policy_implementation_id text not null,
 source_runtime_digest text not null references private.long_bot_board_model_releases(runtime_digest),
 scope text not null check(scope='model-advice-only-with-fresh-dice-comparison'),
 approved_at timestamptz not null default now(),
 primary key(playing_policy_implementation_id,source_runtime_digest)
);
alter table private.long_bot_board_model_source_bindings enable row level security;
revoke all on private.long_bot_board_model_source_bindings from public,anon,authenticated,service_role;
insert into private.long_bot_board_model_source_bindings
 (playing_policy_implementation_id,source_policy_implementation_id,source_runtime_digest,scope)
select '7a263bcd3a44b7248b1b369e18dd552f1a5053e4f0772561f13c9a95e56abfa7',
 policy_implementation_id,runtime_digest,'model-advice-only-with-fresh-dice-comparison'
from private.long_bot_board_model_releases
where runtime_digest='5a0d17b50bcc9b4900ccd1e7c133f5f85fe23676b010e46f985cc799f5369146'
 and policy_implementation_id='2eac358adb59616fd96c7fe84fad43ef252d010906d6f6d7c69ac46c92c207b2'
on conflict do nothing;
create or replace function public.get_long_bot_experience_patterns(p_player_name text default null)
returns jsonb language sql stable security definer set search_path='' as $$
 with board as (
  select l.payload from private.long_bot_board_lessons l
  join private.long_bot_board_model_releases r using(runtime_digest,policy_implementation_id)
  join private.long_bot_causal_serving_runtime() active on active.explicitly_approved
  join public.room_game_archives a on a.id=l.archive_id
   and l.source_fingerprint=private.long_bot_board_source_fingerprint(a.final_state)
  where (active.policy_implementation_id=l.policy_implementation_id
    or exists(select 1 from private.long_bot_board_model_source_bindings b
      where b.playing_policy_implementation_id=active.policy_implementation_id
        and b.source_policy_implementation_id=l.policy_implementation_id
        and b.source_runtime_digest=l.runtime_digest))
   and l.created_at>=now()-interval '180 days'
  order by l.created_at desc,l.aggregate_id limit 128
 ), combined as (
  select value p,0 priority from jsonb_array_elements(private.get_long_bot_terminal_experience_patterns_v1(p_player_name))
  union all select payload,1 from board
 ), capped as(select p from combined order by priority,p->>'aggregateId' limit 256)
 select coalesce(jsonb_agg(p),'[]'::jsonb)from capped
$$;
revoke all on function public.get_long_bot_experience_patterns(text)from public;
grant execute on function public.get_long_bot_experience_patterns(text)to anon,authenticated,service_role;
-- Invalidate parsed SQL/PLpgSQL references to the preserved aggregation OID.
do $$ declare signature text; begin
 foreach signature in array array['public.load_current_long_bot_experience(text,text)',
  'public.load_signed_long_bot_experience(text,text,bigint)'] loop
  if to_regprocedure(signature) is not null then
   execute pg_get_functiondef(to_regprocedure(signature));
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
