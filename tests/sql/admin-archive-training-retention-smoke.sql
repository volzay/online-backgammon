\set ON_ERROR_STOP on
-- Synthetic fixture only: never run against the application database.
do $$begin if current_database() !~ '^codex_admin_retention_' then raise exception 'An isolated codex_admin_retention_ fixture database is required';end if;end$$;
begin;
select set_config('codex.test_admin','yes',true);
create function pg_temp.fixture_id(n integer)returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
-- None of the optional training tables exists yet.
insert into public.rooms values(pg_temp.fixture_id(99),'closed','{}',now()-interval '10 days',now()-interval '10 days',now()-interval '10 days');
insert into public.room_game_archives values(pg_temp.fixture_id(99),pg_temp.fixture_id(99),now()-interval '10 days');
do $$begin if public.admin_prune_room_archive(96)<>2 then raise exception 'Fresh schema cleanup failed';end if;end$$;

create table public.bot_training_games(room_id uuid references public.rooms(id) on delete set null);
create table private.long_bot_signed_experience_snapshots(room_id uuid references public.rooms(id) on delete cascade);
create table private.long_bot_board_reviews(archive_id uuid references public.room_game_archives(id));
create table private.long_bot_board_lessons(archive_id uuid references public.room_game_archives(id));
create table private.long_bot_board_turn_reviews(archive_id uuid references public.room_game_archives(id));
create table private.long_bot_loss_lessons(archive_id uuid references public.room_game_archives(id) on delete cascade);
insert into public.rooms select pg_temp.fixture_id(n),case when n=10 then 'waiting' else 'closed' end,'{}',now()-interval '10 days',now()-interval '10 days',now()-interval '10 days' from generate_series(1,12)n;
insert into public.room_game_archives select pg_temp.fixture_id(n),pg_temp.fixture_id(n),now()-interval '10 days' from generate_series(1,6)n;
insert into public.room_game_archives values(pg_temp.fixture_id(9),pg_temp.fixture_id(9),now()),(pg_temp.fixture_id(11),pg_temp.fixture_id(11),now()-interval '10 days'),(pg_temp.fixture_id(13),null,now()-interval '10 days'),(pg_temp.fixture_id(14),null,now()-interval '10 days');
insert into public.bot_training_games values(pg_temp.fixture_id(1)),(pg_temp.fixture_id(7));
insert into private.long_bot_signed_experience_snapshots values(pg_temp.fixture_id(2)),(pg_temp.fixture_id(8));
insert into private.long_bot_board_reviews values(pg_temp.fixture_id(3)),(pg_temp.fixture_id(14));
insert into private.long_bot_board_lessons values(pg_temp.fixture_id(4));
insert into private.long_bot_board_turn_reviews values(pg_temp.fixture_id(5));
insert into private.long_bot_loss_lessons values(pg_temp.fixture_id(6));

select set_config('codex.test_admin','no',true);
do $$begin
 begin perform public.admin_prune_room_archive(96);raise exception 'Non-admin cleanup unexpectedly allowed';exception when insufficient_privilege then null;end;
 if (select count(*)from public.rooms)<>12 or(select count(*)from public.room_game_archives)<>10 then raise exception 'Unauthorized call changed data';end if;
end$$;
select set_config('codex.test_admin','yes',true);
set local role authenticated;
-- The public administrator RPC can call its private helper as its owner.
do $$begin if public.admin_prune_room_archive(96)<>4 then raise exception 'Expected only four expired unreferenced rows removed';end if;end$$;
reset role;
do $$begin
 if(select count(*)from public.rooms)<>10 or(select count(*)from public.room_game_archives)<>8 then raise exception 'Protected source/parent/recent/active retention failed';end if;
 if(select count(*)from public.bot_training_games)<>2 or(select count(*)from private.long_bot_signed_experience_snapshots)<>2 or(select count(*)from private.long_bot_board_reviews)<>2 or(select count(*)from private.long_bot_board_lessons)<>1 or(select count(*)from private.long_bot_board_turn_reviews)<>1 or(select count(*)from private.long_bot_loss_lessons)<>1 then raise exception 'Training data changed';end if;
 if has_function_privilege('authenticated','private.admin_archive_has_training_source(uuid,uuid)','execute') or has_function_privilege('anon','private.admin_archive_has_training_source(uuid,uuid)','execute') or has_function_privilege('service_role','private.admin_archive_has_training_source(uuid,uuid)','execute') then raise exception 'Private helper exposed';end if;
 if has_function_privilege('anon','public.admin_prune_room_archive(integer)','execute') or not has_function_privilege('authenticated','public.admin_prune_room_archive(integer)','execute') then raise exception 'RPC access changed';end if;
 if public.admin_prune_room_archive(96)<>0 then raise exception 'Repeated cleanup not idempotent';end if;
end$$;
select jsonb_build_object('fixtureOnly',true,'optionalTablesAbsentPassed',true,'allSixSourceTypesRetained',true,'parentAndDetachedArchivesRetained',true,'recentAndActiveRetained',true,'nonAdminDenied',true,'helperPrivate',true,'expiredUnreferencedRowsDeleted',4,'repeatDeleted',0,'rollback',true);
rollback;
