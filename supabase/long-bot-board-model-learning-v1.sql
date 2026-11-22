begin;
-- A separate model-scoped channel. No terminal evidence, old decision ledger,
-- confidence threshold, signed snapshot or causal progress is rewritten.
create table if not exists private.long_bot_board_model_releases (
 runtime_digest text primary key check(runtime_digest ~ '^[0-9a-f]{64}$'),
 policy_implementation_id text not null check(policy_implementation_id ~ '^[0-9a-f]{64}$'),
 approved_at timestamptz not null default now()
);
create table if not exists private.long_bot_board_reviews (
 archive_id uuid not null references public.room_game_archives(id),
 source_fingerprint text not null check(source_fingerprint ~ '^[0-9a-f]{64}$'),
 runtime_digest text not null references private.long_bot_board_model_releases(runtime_digest),
 policy_implementation_id text not null,
 reviewed_turns integer not null default 0 check(reviewed_turns between 0 and 240),
 total_turns integer check(total_turns between 1 and 240),
 quarantined_reason text,
 updated_at timestamptz not null default now(),
 primary key(archive_id, source_fingerprint, runtime_digest)
);
create table if not exists private.long_bot_board_lessons (
 aggregate_id text primary key check(aggregate_id ~ '^[0-9a-f]{64}$'),
 archive_id uuid not null references public.room_game_archives(id),
 source_fingerprint text not null,
 runtime_digest text not null references private.long_bot_board_model_releases(runtime_digest),
 policy_implementation_id text not null,
 turn_index integer not null,
 payload jsonb not null,
 created_at timestamptz not null default now(),
 unique(archive_id, source_fingerprint, runtime_digest, turn_index)
);
alter table private.long_bot_board_model_releases enable row level security;
alter table private.long_bot_board_reviews enable row level security;
alter table private.long_bot_board_lessons enable row level security;
revoke all on private.long_bot_board_model_releases, private.long_bot_board_reviews,
 private.long_bot_board_lessons from public, anon, authenticated, service_role;

create or replace function private.long_bot_board_source_fingerprint(s jsonb)
returns text language sql immutable set search_path='' as $$
 select encode(extensions.digest(convert_to(s::text,'UTF8'),'sha256'),'hex')
$$;
revoke all on function private.long_bot_board_source_fingerprint(jsonb) from public, anon, authenticated, service_role;

create or replace function public.next_long_bot_board_review(p_policy text,p_runtime text,p_rooms text[] default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.room_game_archives; cursor_count integer; bot_color text; source_fp text;
begin
 if not exists(select 1 from private.long_bot_board_model_releases
  where runtime_digest=p_runtime and policy_implementation_id=p_policy) then
  raise exception 'Unapproved board reviewer' using errcode='42501'; end if;
 select s.* into a from public.room_game_archives s
 left join private.long_bot_board_reviews r on r.archive_id=s.id and r.runtime_digest=p_runtime
  and r.source_fingerprint=private.long_bot_board_source_fingerprint(s.final_state)
 where s.variant='long' and s.final_state->>'mode'='bot'
  and s.final_state->>'botDifficulty'='hard' and s.winner in('white','dark')
  and s.final_state->>'winner'=s.winner
  and (s.final_state->'off'->>s.winner)::integer=15
  and s.winner<>case when s.final_state#>>'{analysis,playerColor}'='dark' then 'white' else 'dark' end
  and (p_rooms is null or s.room_code=any(p_rooms))
  and jsonb_typeof(s.final_state->'history')='array'
  and (r.total_turns is null or r.reviewed_turns<r.total_turns)
  and r.quarantined_reason is null
 order by coalesce(r.reviewed_turns,0), s.completed_at desc, s.id limit 1;
 if a.id is null then return null; end if;
 source_fp:=private.long_bot_board_source_fingerprint(a.final_state);
 select reviewed_turns into cursor_count from private.long_bot_board_reviews
  where archive_id=a.id and runtime_digest=p_runtime and source_fingerprint=source_fp;
 bot_color:=case when a.final_state#>>'{analysis,playerColor}'='dark' then 'white' else 'dark' end;
 return jsonb_build_object('archiveId',a.id,'roomCode',a.room_code,'fingerprint',source_fp,
  'botColor',bot_color,'reviewedTurns',coalesce(cursor_count,0),
  'sourcePolicyImplementationId',a.final_state#>>'{analysis,botMemory,experienceLoad,policyImplementationId}',
  'finalState',jsonb_build_object('variant','long','winner',a.winner,'points',a.final_state->'points',
   'bar',a.final_state->'bar','off',a.final_state->'off',
   'history',(select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'opening',e->'opening','winnerColor',e->'winnerColor','roll',e->'roll',
    'color',e->'color','from',e->'from','to',e->'to','die',e->'die'))order by ord)
    from jsonb_array_elements(a.final_state->'history')with ordinality h(e,ord))));
end $$;
revoke all on function public.next_long_bot_board_review(text,text,text[]) from public,anon,authenticated;
grant execute on function public.next_long_bot_board_review(text,text,text[]) to service_role;

create or replace function public.quarantine_long_bot_board_review(
 p_archive_id uuid,p_fingerprint text,p_policy text,p_runtime text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from private.long_bot_board_model_releases
  where runtime_digest=p_runtime and policy_implementation_id=p_policy)
  or not exists(select 1 from public.room_game_archives a where a.id=p_archive_id
   and private.long_bot_board_source_fingerprint(a.final_state)=p_fingerprint)
  or coalesce(length(p_reason),0) not between 1 and 200 then
  raise exception 'Invalid board quarantine'; end if;
 insert into private.long_bot_board_reviews(archive_id,source_fingerprint,runtime_digest,policy_implementation_id,quarantined_reason)
 values(p_archive_id,p_fingerprint,p_runtime,p_policy,p_reason)
 on conflict(archive_id,source_fingerprint,runtime_digest) do update set quarantined_reason=excluded.quarantined_reason,updated_at=now();
end $$;
revoke all on function public.quarantine_long_bot_board_review(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.quarantine_long_bot_board_review(uuid,text,text,text,text) to service_role;

create or replace function public.checkpoint_long_bot_board_review(
 p_archive_id uuid,p_fingerprint text,p_policy text,p_runtime text,
 p_previous integer,p_total integer,p_review jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.room_game_archives; r private.long_bot_board_reviews; l jsonb;
 begin
 if not exists(select 1 from private.long_bot_board_model_releases
  where runtime_digest=p_runtime and policy_implementation_id=p_policy) then
  raise exception 'Unapproved board reviewer' using errcode='42501'; end if;
 select * into a from public.room_game_archives where id=p_archive_id for share;
 if a.id is null or private.long_bot_board_source_fingerprint(a.final_state) is distinct from p_fingerprint
  or p_previous is null or p_total is null or p_previous<0 or p_previous>=p_total or p_total not between 1 and 240
  or (p_review->>'turnIndex')::integer is distinct from p_previous
  or coalesce(p_review->>'status','') not in('forced-pass','forced-board','capacity','no-applicable-improvement','model-reviewed')
  then raise exception 'Invalid board review source/progress'; end if;
 insert into private.long_bot_board_reviews(archive_id,source_fingerprint,runtime_digest,policy_implementation_id)
 values(p_archive_id,p_fingerprint,p_runtime,p_policy) on conflict do nothing;
 select * into r from private.long_bot_board_reviews where archive_id=p_archive_id
  and source_fingerprint=p_fingerprint and runtime_digest=p_runtime for update;
 if r.reviewed_turns<>p_previous or r.policy_implementation_id<>p_policy
  or(r.total_turns is not null and r.total_turns<>p_total) then raise exception 'Board cursor conflict'; end if;
 l:=p_review->'lesson';
 if p_review->>'status'='model-reviewed' then
  if jsonb_typeof(l) is distinct from 'object' or (l->>'creditVersion')::integer is distinct from 10
   or l->>'evidenceSchema' is distinct from 'long-server-board-model-pattern-v1'
   or l->>'trustDomain' is distinct from 'nardu/server-long-bot-board-model/v1'
   or l->>'reviewerVersion' is distinct from 'long-board-model-review-v1'
   or l->>'scoreSemantics' is distinct from 'heuristic-turn-equity-v1'
   or l->>'opponentReplyModel' is distinct from 'best-of-bounded-legal-replies-v1'
   or l->'outcomeUsed' is distinct from 'false'::jsonb
   or l->'terminalOutcomeConfirmed' is distinct from 'false'::jsonb
   or l->>'policyImplementationId' is distinct from p_policy
   or l->>'runtimeDigest' is distinct from p_runtime
   or l->>'sourceArchiveId' is distinct from p_archive_id::text
   or l->>'sourceRoom' is distinct from a.room_code
   or l->>'sourceFingerprint' is distinct from p_fingerprint
   or (l->>'turnIndex')::integer is distinct from p_previous
   or coalesce(l->>'aggregateId','') !~ '^[0-9a-f]{64}$'
   or coalesce(length(l->>'positionKey'),0) not between 1 and 4096
   or coalesce(length(l->>'contextKey'),0)=0 or coalesce(length(l->>'actionKey'),0)=0
   or coalesce(length(l->>'preferredActionKey'),0)=0 or l->>'actionKey'=l->>'preferredActionKey'
   or l->'samples' is distinct from '1'::jsonb or l->'losses' is distinct from '0'::jsonb or l->'wins' is distinct from '0'::jsonb
   or l->'diceOutcomes' is distinct from '21'::jsonb or l->'diceWeight' is distinct from '36'::jsonb
   or coalesce(public.long_bot_safe_numeric(l->'rootPositions'),0) not between 2 and 64
   or coalesce(public.long_bot_safe_numeric(l->'utilityGain'),0) not between 0.025 and 2
   or coalesce(public.long_bot_safe_numeric(l->'equityGain'),0) not between 0.025 and 2
   or abs(coalesce(public.long_bot_safe_numeric(l#>'{recommended,utility}')-public.long_bot_safe_numeric(l#>'{baseline,utility}')-public.long_bot_safe_numeric(l->'utilityGain'),1))>1e-9
   or abs(coalesce(public.long_bot_safe_numeric(l#>'{recommended,expectedEquity}')-public.long_bot_safe_numeric(l#>'{baseline,expectedEquity}')-public.long_bot_safe_numeric(l->'equityGain'),1))>1e-9
   or coalesce(public.long_bot_safe_numeric(l#>'{recommended,lowerTailEquity}')-public.long_bot_safe_numeric(l#>'{baseline,lowerTailEquity}'),-3)<-0.060000001
   or jsonb_typeof(l->'preferredMoves') is distinct from 'array'
   or jsonb_array_length(l->'preferredMoves') not between 1 and 4 then raise exception 'Invalid model-scoped lesson'; end if;
  insert into private.long_bot_board_lessons(aggregate_id,archive_id,source_fingerprint,runtime_digest,policy_implementation_id,turn_index,payload)
   values(l->>'aggregateId',p_archive_id,p_fingerprint,p_runtime,p_policy,p_previous,l);
 elsif l is not null then raise exception 'Unreviewed lesson rejected'; end if;
 update private.long_bot_board_reviews set reviewed_turns=p_previous+1,total_turns=p_total,updated_at=now()
 where archive_id=p_archive_id and source_fingerprint=p_fingerprint and runtime_digest=p_runtime;
 return jsonb_build_object('reviewedTurns',p_previous+1);
end $$;
revoke all on function public.checkpoint_long_bot_board_review(uuid,text,text,text,integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.checkpoint_long_bot_board_review(uuid,text,text,text,integer,integer,jsonb) to service_role;

-- Preserve the exact terminal aggregation and add clearly typed board advice.
do $$ begin
 if to_regprocedure('private.get_long_bot_terminal_experience_patterns_v1(text)') is null then
  alter function public.get_long_bot_experience_patterns(text) set schema private;
  alter function private.get_long_bot_experience_patterns(text) rename to get_long_bot_terminal_experience_patterns_v1;
 end if;
end $$;
revoke all on function private.get_long_bot_terminal_experience_patterns_v1(text) from public,anon,authenticated,service_role;
create or replace function public.get_long_bot_experience_patterns(p_player_name text default null)
returns jsonb language sql stable security definer set search_path='' as $$
 with board as (
  select l.payload from private.long_bot_board_lessons l
  join private.long_bot_board_model_releases r using(runtime_digest,policy_implementation_id)
  join private.long_bot_causal_serving_runtime() active on active.policy_implementation_id=l.policy_implementation_id
   and active.explicitly_approved
  join public.room_game_archives a on a.id=l.archive_id
   and l.source_fingerprint=private.long_bot_board_source_fingerprint(a.final_state)
  where l.created_at>=now()-interval '180 days'
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
notify pgrst, 'reload schema';
commit;
