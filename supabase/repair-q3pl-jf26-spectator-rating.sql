-- One-off audited correction for the confirmed spectator award in Q3PL-JF26.
-- Apply only AFTER spectator-rating-guard-v40.sql, with a fresh database backup.
-- Every predicate is intentionally strict: any newer game or changed rating
-- aborts the transaction instead of guessing a new Elo trajectory.
begin;
set local lock_timeout = '5s';

do $repair_q3pl_spectator$
declare
  spectator public.profiles%rowtype;
  erroneous public.rating_events%rowtype;
  game_room public.rooms%rowtype;
  corrected_rows integer;
begin
  select * into spectator
  from public.profiles
  where nickname = 'tester1'
  for update;
  if not found or spectator.rating <> 1549 or spectator.tier <> 'Gold' then
    raise exception 'tester1 profile no longer matches the audited 1549/Gold state';
  end if;

  select * into erroneous
  from public.rating_events
  where user_id = spectator.id
    and result_key = '1791008478186:white:normal'
  for update;
  if not found
     or erroneous.delta <> 1
     or erroneous.rating_after <> 1549
     or erroneous.did_win is distinct from true
     or erroneous.mode <> 'remote'
     or erroneous.winner <> 'white'
     or coalesce(nullif(erroneous.result_type, ''), 'normal') <> 'normal'
     or erroneous.score->>'roomCode' <> 'Q3PL-JF26'
     or erroneous.score #>> '{finalState,finishedAt}' <> '1791008478186' then
    raise exception 'Spectator rating event no longer matches the audited result';
  end if;
  if exists (
    select 1 from public.rating_events later
    where later.user_id = spectator.id
      and later.id <> erroneous.id
      and later.created_at >= erroneous.created_at
  ) then
    raise exception 'A subsequent or timestamp-tied rating event requires manual Elo replay';
  end if;

  select * into game_room
  from public.rooms
  where code = 'Q3PL-JF26'
  for share;
  if not found
     or game_room.host_user_id = spectator.id
     or game_room.guest_user_id = spectator.id
     or game_room.game_state->>'winner' <> 'white'
     or game_room.game_state->>'finishedAt' <> '1791008478186'
     or not exists (
       select 1 from public.room_game_archives archive
       where archive.room_id = game_room.id
         and archive.result_key = '1791008478186:white:normal'
         and archive.winner = 'white'
     ) then
    raise exception 'Room participation or archived result no longer matches the audit';
  end if;
  if exists (
    select 1 from public.admin_audit audit
    where audit.action = 'correct-spectator-rating'
      and audit.details->>'ratingEventId' = erroneous.id::text
  ) then
    raise exception 'This rating event already has a correction audit';
  end if;

  insert into public.admin_audit (actor_user_id, action, details)
  values (null, 'correct-spectator-rating', jsonb_build_object(
    'roomCode', game_room.code,
    'spectatorUserId', spectator.id,
    'ratingEventId', erroneous.id,
    'reason', 'non-participant received a win and one rating point',
    'ratingBefore', spectator.rating,
    'ratingAfter', 1548,
    'originalEvent', to_jsonb(erroneous)
  ));

  delete from public.rating_events
  where id = erroneous.id and user_id = spectator.id;
  get diagnostics corrected_rows = row_count;
  if corrected_rows <> 1 then
    raise exception 'Expected to remove exactly one erroneous rating event';
  end if;

  update public.profiles
  set rating = 1548, tier = 'Gold'
  where id = spectator.id and rating = 1549;
  get diagnostics corrected_rows = row_count;
  if corrected_rows <> 1 then
    raise exception 'Expected to correct exactly one spectator profile';
  end if;
end;
$repair_q3pl_spectator$;

commit;
