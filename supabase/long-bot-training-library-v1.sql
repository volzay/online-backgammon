begin;
-- A catalogue of original training games, including wins and old policies.
-- New model evidence has its own provenance. Terminal evidence is untouched.
create table if not exists private.long_bot_training_library_releases (
 runtime_digest text primary key references private.long_bot_board_model_releases(runtime_digest),
 enabled boolean not null default false
);
create unique index if not exists long_bot_training_library_one_active_release
 on private.long_bot_training_library_releases((true)) where enabled;
create table if not exists private.long_bot_training_source_heads (
 game_id uuid primary key references public.bot_training_games(id),
 fingerprint text not null check(fingerprint~'^[0-9a-f]{64}$'),
 room_code text not null,engine_version text,bot_color text,winner text,result_type text,completed_at timestamptz,
 updated_at timestamptz not null default now()
);
create table if not exists private.long_bot_training_library (
 game_id uuid not null references public.bot_training_games(id),
 fingerprint text not null,runtime_digest text not null references private.long_bot_training_library_releases(runtime_digest),
 classification_status text not null default 'pending' check(classification_status in('pending','ready','partial','unusable')),
 classification jsonb not null default '{}',turns jsonb not null default '[]',
 cursor integer not null default 0 check(cursor between 0 and 600),
 lease_owner uuid,lease_until timestamptz,last_claimed_at timestamptz,
 retry_after timestamptz not null default '-infinity',deferrals integer not null default 0,last_error text,
 updated_at timestamptz not null default now(),primary key(game_id,fingerprint,runtime_digest),
 check(jsonb_typeof(turns)='array' and jsonb_array_length(turns)<=600 and cursor<=jsonb_array_length(turns))
);
create table if not exists private.long_bot_training_turn_reviews (
 game_id uuid not null,fingerprint text not null,runtime_digest text not null,turn_index integer not null,
 status text not null check(status in('forced-pass','forced-board','no-applicable-improvement','model-reviewed')),
 payload jsonb not null,created_at timestamptz not null default now(),
 primary key(game_id,fingerprint,runtime_digest,turn_index),
 foreign key(game_id,fingerprint,runtime_digest) references private.long_bot_training_library(game_id,fingerprint,runtime_digest)
);
create index if not exists long_bot_training_library_fair_queue on private.long_bot_training_library(runtime_digest,last_claimed_at);
create or replace function private.long_bot_training_source_fingerprint(g public.bot_training_games)
returns text language sql immutable set search_path='' as $$
 select encode(extensions.digest(convert_to(jsonb_build_object('id',g.id,'roomCode',g.room_code,
  'engineVersion',g.engine_version,'difficulty',g.difficulty,'botColor',g.bot_color,'winner',g.winner,
  'resultType',g.result_type,'decisions',g.decisions,'finalState',g.final_state)::text,'UTF8'),'sha256'),'hex')
$$;
create or replace function private.sync_long_bot_training_library(g public.bot_training_games)
returns void language plpgsql security definer set search_path='' as $$
declare fp text;
begin
 if g.difficulty is distinct from 'hard' or g.final_state->>'variant' is distinct from 'long' then
  delete from private.long_bot_training_source_heads where game_id=g.id;return;
 end if;
 fp:=private.long_bot_training_source_fingerprint(g);
 insert into private.long_bot_training_source_heads(game_id,fingerprint,room_code,engine_version,bot_color,winner,result_type,completed_at)
 values(g.id,fp,g.room_code,g.engine_version,g.bot_color,g.winner,g.result_type,g.completed_at)
 on conflict(game_id) do update set fingerprint=excluded.fingerprint,room_code=excluded.room_code,
  engine_version=excluded.engine_version,bot_color=excluded.bot_color,winner=excluded.winner,
  result_type=excluded.result_type,completed_at=excluded.completed_at,updated_at=now();
 insert into private.long_bot_training_library(game_id,fingerprint,runtime_digest)
 select g.id,fp,runtime_digest from private.long_bot_training_library_releases where enabled on conflict do nothing;
end $$;
create or replace function private.capture_long_bot_training_source()
returns trigger language plpgsql security definer set search_path='' as $$
begin perform private.sync_long_bot_training_library(new);return new;end $$;
drop trigger if exists long_bot_training_library_source on public.bot_training_games;
create trigger long_bot_training_library_source after insert or update of room_code,engine_version,difficulty,bot_color,winner,result_type,decisions,final_state
 on public.bot_training_games for each row execute function private.capture_long_bot_training_source();
-- Source heads also invalidate old advice if an original archive is corrected.
do $$ declare g public.bot_training_games;begin
 for g in select * from public.bot_training_games where difficulty='hard' and final_state->>'variant'='long'
 loop perform private.sync_long_bot_training_library(g);end loop;
end $$;

create or replace function public.claim_long_bot_training_library(p_runtime text,p_policy text,p_owner uuid,p_mode text default 'review')
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.long_bot_training_library;g public.bot_training_games;a public.room_game_archives;
begin
 if p_owner is null or p_mode not in('classify','review') or not exists(
  select 1 from private.long_bot_training_library_releases l join private.long_bot_board_model_releases r using(runtime_digest)
  where l.runtime_digest=p_runtime and r.policy_implementation_id=p_policy and l.enabled)
 then raise exception 'Unapproved library worker' using errcode='42501';end if;
 select l.* into q from private.long_bot_training_library l
 join private.long_bot_training_source_heads h on h.game_id=l.game_id and h.fingerprint=l.fingerprint
 where l.runtime_digest=p_runtime and coalesce(l.lease_until,'-infinity')<now() and l.retry_after<=now()
  and (l.classification_status='pending' or (p_mode='review' and l.classification_status in('ready','partial') and l.cursor<jsonb_array_length(l.turns)))
 order by (l.classification_status='pending') desc,l.last_claimed_at nulls first,l.game_id
 for update of l skip locked limit 1;
 if q.game_id is null then return null;end if;
 update private.long_bot_training_library set lease_owner=p_owner,lease_until=now()+interval '10 minutes',last_claimed_at=now()
 where game_id=q.game_id and fingerprint=q.fingerprint and runtime_digest=p_runtime;
 select * into g from public.bot_training_games where id=q.game_id;
 if q.classification_status='pending' then
  select * into a from public.room_game_archives where room_id=g.room_id and room_code=g.room_code
   and final_state->>'startedAt'=g.final_state->>'startedAt' order by completed_at desc limit 1;
  return jsonb_build_object('gameId',g.id,'fingerprint',q.fingerprint,'classificationStatus','pending',
   'game',jsonb_build_object('room_code',g.room_code,'difficulty',g.difficulty,'bot_color',g.bot_color,'winner',g.winner,
    'decisions',g.decisions,'final_state',g.final_state),'archive',case when a.id is not null then
    jsonb_build_object('id',a.id,'room_code',a.room_code,'winner',a.winner,'final_state',a.final_state) else null end);
 end if;
 return jsonb_build_object('gameId',g.id,'roomCode',g.room_code,'fingerprint',q.fingerprint,'classificationStatus',q.classification_status,
  'classification',q.classification,'cursor',q.cursor,'turn',q.turns->q.cursor,
  'sourcePolicyImplementationId',g.final_state#>>'{analysis,botMemory,experienceLoad,policyImplementationId}');
end $$;

create or replace function public.classify_long_bot_training_library(p_game uuid,p_fingerprint text,p_runtime text,p_owner uuid,p_result jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare n integer;s text;begin
 n:=jsonb_array_length(p_result->'turns');s:=p_result->>'classificationStatus';
 if coalesce(s,'') not in('ready','partial','unusable') or n is null or n>600
  or (s='unusable' and n<>0) or (s in('ready','partial') and n=0)
  or (s='ready' and p_result#>>'{classification,historyVerified}' is distinct from 'true')
  or (p_result#>>'{classification,totalTurns}')::integer is distinct from n
  or octet_length(p_result::text)>20000000 then raise exception 'Invalid source classification';end if;
 update private.long_bot_training_library q set classification_status=s,classification=p_result->'classification',turns=p_result->'turns',
  lease_owner=null,lease_until=null,updated_at=now()
 where game_id=p_game and fingerprint=p_fingerprint and runtime_digest=p_runtime and lease_owner=p_owner
  and lease_until>now() and classification_status='pending'
  and exists(select 1 from private.long_bot_training_source_heads h where h.game_id=q.game_id and h.fingerprint=q.fingerprint)
  and exists(select 1 from private.long_bot_training_library_releases r where r.runtime_digest=p_runtime and r.enabled);
 if not found then raise exception 'Stale source classification lease';end if;
end $$;

create or replace function public.checkpoint_long_bot_training_library(p_game uuid,p_fingerprint text,p_runtime text,p_owner uuid,p_previous integer,p_review jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.long_bot_training_library;l jsonb;policy text;begin
 select t.* into q from private.long_bot_training_library t join private.long_bot_training_source_heads h
  on h.game_id=t.game_id and h.fingerprint=t.fingerprint
 where t.game_id=p_game and t.fingerprint=p_fingerprint and t.runtime_digest=p_runtime
  and t.lease_owner=p_owner and t.lease_until>now() and t.cursor=p_previous
  and t.classification_status in('ready','partial') and t.cursor<jsonb_array_length(t.turns) for update of t;
 select r.policy_implementation_id into policy from private.long_bot_training_library_releases a
 join private.long_bot_board_model_releases r using(runtime_digest) where a.runtime_digest=p_runtime and a.enabled;
 if q.game_id is null or policy is null or (p_review->>'turnIndex')::integer is distinct from p_previous
  or p_review->>'positionHash' is distinct from q.turns->p_previous->>'positionHash'
 then raise exception 'Stale or mismatched library review';end if;
 if p_review->>'status'='capacity' then
  update private.long_bot_training_library set deferrals=deferrals+1,last_error='teacher-capacity',
   retry_after=now()+interval '6 hours',lease_owner=null,lease_until=null,updated_at=now()
   where game_id=p_game and fingerprint=p_fingerprint and runtime_digest=p_runtime;
  return jsonb_build_object('cursor',p_previous,'deferred',true);
 end if;
 if coalesce(p_review->>'status','') not in('forced-pass','forced-board','no-applicable-improvement','model-reviewed')
  or octet_length(p_review::text)>20000 then raise exception 'Invalid review receipt';end if;
 l:=p_review->'lesson';
 if p_review->>'status'='model-reviewed' then
  if l is null or jsonb_typeof(l)<>'object'
   or l->>'creditVersion' is distinct from '10' or l->>'evidenceSchema' is distinct from 'long-server-board-model-pattern-v1'
   or l->>'trustDomain' is distinct from 'nardu/server-long-bot-board-model/v1'
   or l->>'reviewerVersion' is distinct from 'long-board-model-review-v1'
   or l->>'sourceKind' is distinct from 'bot-training-game' or l->>'sourceTrainingGameId' is distinct from p_game::text
   or l->>'sourceFingerprint' is distinct from p_fingerprint or l->>'runtimeDigest' is distinct from p_runtime
   or l->>'policyImplementationId' is distinct from policy
   or l->>'positionKey' is distinct from q.turns->p_previous->>'positionKey'
   or l->>'aggregateId' !~ '^[0-9a-f]{64}$' or l->>'aggregateId' is null
   or l->>'terminalOutcomeConfirmed' is distinct from 'false' or l->>'outcomeUsed' is distinct from 'false'
   or coalesce((l->>'samples')::integer,-1)<>1 or coalesce((l->>'wins')::integer,-1)<>0 or coalesce((l->>'losses')::integer,-1)<>0
   or coalesce((l->>'diceOutcomes')::integer,0)<>21 or coalesce((l->>'diceWeight')::integer,0)<>36
   or coalesce((l->>'rootPositions')::integer,0) not between 2 and 256
   or coalesce((l->>'equityGain')::numeric,-1)<0.025 or coalesce((l->>'utilityGain')::numeric,-1)<0.025
   or p_review->>'coldAction' is null or p_review->>'learnedAction' is null or p_review->>'coldAction'=p_review->>'learnedAction'
  then raise exception 'Invalid model-only library lesson';end if;
 elsif l is not null then raise exception 'Unexpected lesson';end if;
 insert into private.long_bot_training_turn_reviews(game_id,fingerprint,runtime_digest,turn_index,status,payload)
 values(p_game,p_fingerprint,p_runtime,p_previous,p_review->>'status',p_review);
 update private.long_bot_training_library set cursor=cursor+1,lease_owner=null,lease_until=null,last_error=null,retry_after='-infinity',updated_at=now()
 where game_id=p_game and fingerprint=p_fingerprint and runtime_digest=p_runtime;
 return jsonb_build_object('cursor',p_previous+1);
end $$;

create or replace function public.admin_long_bot_training_library(p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare answer jsonb;begin
 if not public.is_admin_user() then raise exception 'Admin only' using errcode='42501';end if;
 with current_sources as(select h.*,q.classification_status,q.classification,q.cursor,jsonb_array_length(q.turns) total_turns,q.deferrals,q.last_error
  from private.long_bot_training_source_heads h left join private.long_bot_training_library q on q.game_id=h.game_id and q.fingerprint=h.fingerprint
   and q.runtime_digest=(select runtime_digest from private.long_bot_training_library_releases where enabled limit 1)),
 counts as(select count(*) total,count(*) filter(where classification_status='ready') complete_history,
  count(*) filter(where classification_status='partial') verified_positions,count(*) filter(where classification_status='unusable') unusable,
  count(*) filter(where coalesce(classification_status,'pending')='pending') pending,
  count(*) filter(where winner=bot_color) wins,count(*) filter(where winner<>bot_color) losses,
  coalesce(sum(total_turns),0) positions,coalesce(sum(cursor),0) reviewed_positions,
  count(*) filter(where total_turns>0 and cursor=total_turns) fully_reviewed,count(*) filter(where deferrals>0) deferred_sources from current_sources),
 rows as(select room_code,engine_version,case when winner=bot_color then 'win' else 'loss' end outcome,result_type,completed_at,
  classification_status,classification,cursor reviewed_positions,total_turns,deferrals,last_error from current_sources
  order by completed_at desc,game_id limit greatest(0,least(coalesce(p_limit,50),500)) offset greatest(0,coalesce(p_offset,0))),
 engines as(select engine_version,count(*) games from current_sources group by engine_version),
 lessons as(select count(*) lessons,count(distinct r.game_id) sources from private.long_bot_training_turn_reviews r
  join private.long_bot_training_source_heads h on h.game_id=r.game_id and h.fingerprint=r.fingerprint
  join private.long_bot_training_library_releases a on a.runtime_digest=r.runtime_digest
  join private.long_bot_board_model_releases model_release on model_release.runtime_digest=r.runtime_digest
  where status='model-reviewed' and model_release.policy_implementation_id=(select br.policy_implementation_id
   from private.long_bot_training_library_releases ar join private.long_bot_board_model_releases br using(runtime_digest) where ar.enabled limit 1))
 select jsonb_build_object('summary',(select to_jsonb(counts) from counts),'modelAdvice',(select to_jsonb(l)from lessons l),
  'engines',(select coalesce(jsonb_agg(to_jsonb(engines)),'[]')from engines),'games',(select coalesce(jsonb_agg(to_jsonb(rows)),'[]')from rows),
  'terminalStatisticsSeparate',true)into answer;
 return answer;
end $$;

-- All originals stay private. Public callers receive only admitted model advice.
alter table private.long_bot_training_library_releases enable row level security;
alter table private.long_bot_training_source_heads enable row level security;
alter table private.long_bot_training_library enable row level security;
alter table private.long_bot_training_turn_reviews enable row level security;
revoke all on private.long_bot_training_library_releases,private.long_bot_training_source_heads,
 private.long_bot_training_library,private.long_bot_training_turn_reviews from public,anon,authenticated,service_role;
revoke all on function private.long_bot_training_source_fingerprint(public.bot_training_games),
 private.sync_long_bot_training_library(public.bot_training_games),private.capture_long_bot_training_source() from public,anon,authenticated,service_role;
revoke all on function public.claim_long_bot_training_library(text,text,uuid,text),
 public.classify_long_bot_training_library(uuid,text,text,uuid,jsonb),
 public.checkpoint_long_bot_training_library(uuid,text,text,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.claim_long_bot_training_library(text,text,uuid,text),
 public.classify_long_bot_training_library(uuid,text,text,uuid,jsonb),
 public.checkpoint_long_bot_training_library(uuid,text,text,uuid,integer,jsonb) to service_role;
revoke all on function public.admin_long_bot_training_library(integer,integer) from public,anon;
grant execute on function public.admin_long_bot_training_library(integer,integer) to authenticated;

create or replace function public.get_long_bot_experience_patterns(p_player_name text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb:='[]';used_bytes integer:=2;item record;item_bytes integer;
begin
 for item in
 with active as(select * from private.long_bot_causal_serving_runtime() where explicitly_approved),
 legacy as(select l.payload,l.created_at,1 priority,0::bigint source_round
  from private.long_bot_board_lessons l join private.long_bot_board_model_releases r using(runtime_digest,policy_implementation_id)
  join public.room_game_archives a on a.id=l.archive_id and l.source_fingerprint=private.long_bot_board_source_fingerprint(a.final_state)
  cross join active where (active.policy_implementation_id=l.policy_implementation_id or exists(
   select 1 from private.long_bot_board_model_source_bindings b where b.playing_policy_implementation_id=active.policy_implementation_id
    and b.source_policy_implementation_id=l.policy_implementation_id and b.source_runtime_digest=l.runtime_digest))
   and l.created_at>=now()-interval '180 days' order by l.created_at desc,l.aggregate_id limit 128),
 library as(select t.payload->'lesson' payload,t.created_at,2 priority,
   row_number()over(partition by t.game_id order by t.created_at desc,t.turn_index)source_round
  from private.long_bot_training_turn_reviews t
  join private.long_bot_training_source_heads h on h.game_id=t.game_id and h.fingerprint=t.fingerprint
  join private.long_bot_training_library_releases a on a.runtime_digest=t.runtime_digest
  join private.long_bot_board_model_releases r on r.runtime_digest=t.runtime_digest cross join active
  where t.status='model-reviewed' and (r.policy_implementation_id=active.policy_implementation_id or exists(
   select 1 from private.long_bot_board_model_source_bindings b where b.playing_policy_implementation_id=active.policy_implementation_id
    and b.source_policy_implementation_id=r.policy_implementation_id and b.source_runtime_digest=r.runtime_digest))
   and t.created_at>=now()-interval '180 days'),
 pool as(select value payload,now() created_at,0 priority,0::bigint source_round
    from jsonb_array_elements(private.get_long_bot_terminal_experience_patterns_v1(p_player_name))
   union all select * from legacy union all select * from library),
 dedup as(select distinct on(payload->>'aggregateId')* from pool order by payload->>'aggregateId',priority)
 select payload from dedup order by priority,source_round,created_at desc,payload->>'aggregateId'
 loop
  item_bytes:=octet_length(item.payload::text)+2;
  if used_bytes+item_bytes<=480000 and jsonb_array_length(result)<256 then
   result:=result||jsonb_build_array(item.payload);used_bytes:=used_bytes+item_bytes;
  end if;
 end loop;
 return result;
end $$;
revoke all on function public.get_long_bot_experience_patterns(text)from public;
grant execute on function public.get_long_bot_experience_patterns(text)to anon,authenticated,service_role;
do $$ declare signature text;begin
 foreach signature in array array['public.load_current_long_bot_experience(text,text)','public.load_signed_long_bot_experience(text,text,bigint)']loop
  if to_regprocedure(signature)is not null then execute pg_get_functiondef(to_regprocedure(signature));end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
