begin;
alter table private.long_bot_board_model_releases add column if not exists max_root_positions integer not null default 64 check(max_root_positions between 2 and 256);
create table if not exists private.long_bot_board_turn_reviews (
 archive_id uuid not null references public.room_game_archives(id),
 source_fingerprint text not null, runtime_digest text not null references private.long_bot_board_model_releases(runtime_digest),
 turn_index integer not null, status text not null check(status in('forced-pass','forced-board','no-applicable-improvement','model-reviewed')),
 payload jsonb not null, created_at timestamptz not null default now(),
 primary key(archive_id,source_fingerprint,runtime_digest,turn_index)
);
alter table private.long_bot_board_turn_reviews enable row level security;
revoke all on private.long_bot_board_turn_reviews from public,anon,authenticated,service_role;
do $receipts$
declare definition text; old_limit text:='not between 2 and 64'; new_limit text:='not between 2 and (select max_root_positions from private.long_bot_board_model_releases where runtime_digest=p_runtime and policy_implementation_id=p_policy)';
begin
 definition:=pg_get_functiondef('public.checkpoint_long_bot_board_review(uuid,text,text,text,integer,integer,jsonb)'::regprocedure);
 if position('private.long_bot_board_turn_reviews' in definition)>0 then return;end if;
 if position(old_limit in definition)=0 or position($match$ return jsonb_build_object('reviewedTurns'$match$ in definition)=0 then raise exception 'Unexpected checkpoint function';end if;
 definition:=replace(definition,old_limit,new_limit);
 definition:=replace(definition,$match$'forced-board','capacity','no-applicable-improvement'$match$,$match$'forced-board','no-applicable-improvement'$match$);
 definition:=replace(definition,$match$ return jsonb_build_object('reviewedTurns'$match$,
  $body$ insert into private.long_bot_board_turn_reviews(archive_id,source_fingerprint,runtime_digest,turn_index,status,payload)
    values(p_archive_id,p_fingerprint,p_runtime,p_previous,p_review->>'status',p_review);
 return jsonb_build_object('reviewedTurns'$body$);
 execute definition;
end $receipts$;
notify pgrst,'reload schema';
commit;
