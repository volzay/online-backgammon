-- Supplemental PostgreSQL 17 smoke: include AFTER fair-dice-v36.sql in an
-- owner-run BEGIN/ROLLBACK transaction. This file has no transaction wrapper;
-- never execute it alone or commit its synthetic auth/user/room fixtures.
-- The installer wrapper must be removed when it shares the smoke transaction.
-- No real accounts, passwords, or cryptographic beacon values are used.
-- SET LOCAL ROLE exercises caller grants/RLS as well as JWT/header semantics.
do $fair_dice_v36_extra_smoke$
declare
  host_id uuid := gen_random_uuid();
  guest_id uuid := gen_random_uuid();
  outsider_id uuid := gen_random_uuid();
  suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  code_suffix text := translate(upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)), '01', '23');
  waiting_code text;
  remote_code text;
  guest_proof text := 'gproof:' || encode(extensions.digest(convert_to(gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex');
  unseated_guest_id text;
  owner_presence jsonb;
  joined_after timestamptz;
  initial jsonb;
  terminal_state jsonb;
  rematch_initial jsonb;
  room_result jsonb;
  result jsonb;
  receipt jsonb;
  new_receipt jsonb;
  room_id uuid;
  first_epoch uuid;
  first_request_id uuid;
  next_request_id uuid;
  version integer;
  deleted_rows integer;
  error_message text;
  now_ms bigint;
begin
  waiting_code := 'W36A-' || code_suffix;
  remote_code := 'R36A-' || code_suffix;
  unseated_guest_id := private.guest_identity_from_proof(guest_proof);
  -- GoTrue's existing AFTER INSERT trigger creates the linked profiles. These
  -- random identities are transaction-local fixtures and have no passwords.
  insert into auth.users(id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values
    (host_id, 'authenticated', 'authenticated', 'fair36-host-' || suffix || '@example.invalid',
      jsonb_build_object('nickname', 'Fair36 host ' || suffix), clock_timestamp(), clock_timestamp()),
    (guest_id, 'authenticated', 'authenticated', 'fair36-guest-' || suffix || '@example.invalid',
      jsonb_build_object('nickname', 'Fair36 guest ' || suffix), clock_timestamp(), clock_timestamp()),
    (outsider_id, 'authenticated', 'authenticated', 'fair36-other-' || suffix || '@example.invalid',
      jsonb_build_object('nickname', 'Fair36 other ' || suffix), clock_timestamp(), clock_timestamp());
  if (select count(*) from public.profiles p where p.id in (host_id, guest_id, outsider_id)) <> 3 then
    raise exception 'Synthetic auth-user profile creation failed.';
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.headers', '{}', true);
  execute 'set local role service_role';
  perform public.configure_fair_dice_policy(true);

  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',host_id)::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', host_id::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.rooms(code, variant, status, host_user_id, host_name, host_registered, game_state)
    values(waiting_code, 'long', 'waiting', host_id, 'Fair36 host ' || suffix, true, null);
    raise exception 'A stale browser header created a required fair-dice room.';
  exception when invalid_parameter_value then
    get stacked diagnostics error_message = message_text;
    if error_message is distinct from 'Обновите страницу: для новой игры требуется новая версия подтверждённых бросков.' then
      raise exception 'Unexpected stale-browser compatibility error: %', error_message;
    end if;
  end;
  if exists(select 1 from public.rooms r where r.code = waiting_code) then
    raise exception 'The compatibility rejection left a room or active-room claim.';
  end if;
  perform set_config('request.headers', jsonb_build_object('x-client-info','supabase-js-web/smoke nardu-fair-dice-v36')::text, true);
  insert into public.rooms(code, variant, status, host_user_id, host_name, host_registered, game_state, presence)
  values(waiting_code, 'long', 'waiting', host_id, 'Fair36 host ' || suffix, true, null,
    '{"dark":{"lastSeen":1},"white":{"lastSeen":1}}'::jsonb);
  room_result := public.get_fair_dice_room(waiting_code);
  if room_result->'fairDiceRequired' is distinct from 'true'::jsonb
     or room_result#>'{actor,ownsHost}' is distinct from 'true'::jsonb
     or room_result#>'{actor,guest}' is distinct from 'false'::jsonb
     or room_result->'state' is distinct from 'null'::jsonb
     or room_result->'presence' ? 'dark'
     or (room_result#>>'{presence,white,lastSeen}')::bigint < 1000000000000 then
    raise exception 'Registered waiting-room policy or actor stamping failed.';
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',outsider_id)::text, true);
  perform set_config('request.jwt.claim.sub', outsider_id::text, true);
  begin
    perform public.close_fair_dice_waiting_room(waiting_code);
    raise exception 'An unrelated registered account closed a waiting room.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',host_id)::text, true);
  perform set_config('request.jwt.claim.sub', host_id::text, true);
  result := public.close_fair_dice_waiting_room(waiting_code);
  if result->'closed' is distinct from 'true'::jsonb or result->'removed' is distinct from 'true'::jsonb then
    raise exception 'The registered owner could not close an unstarted waiting room.';
  end if;
  result := public.close_fair_dice_waiting_room(waiting_code);
  if result->'closed' is distinct from 'true'::jsonb then raise exception 'Waiting close was not idempotent.'; end if;
  -- Creating a second room proves that closing released the active-room claim.
  insert into public.rooms(code, variant, status, host_user_id, host_name, host_registered, game_state)
  values(remote_code, 'long', 'waiting', host_id, 'Fair36 host ' || suffix, true, null);
  room_result := public.get_fair_dice_room(remote_code);
  room_id := (room_result->>'id')::uuid;
  first_epoch := (room_result->>'gameId')::uuid;
  owner_presence := room_result#>'{presence,white}';

  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',guest_id)::text, true);
  perform set_config('request.jwt.claim.sub', guest_id::text, true);
  joined_after := clock_timestamp();
  update public.rooms r set status = 'joined', guest_user_id = guest_id,
    guest_name = 'Fair36 guest ' || suffix, guest_registered = true,
    presence = '{"white":{"lastSeen":1},"dark":{"lastSeen":1}}'::jsonb,
    left_players = '{"white":true,"dark":true}'::jsonb, joined_at = '2000-01-01'::timestamptz
  where r.code = remote_code;
  room_result := public.get_fair_dice_room(remote_code);
  if room_result->>'status' is distinct from 'joined'
     or room_result#>>'{actor,actorColor}' is distinct from 'dark'
     or room_result#>'{actor,ownsHost}' is distinct from 'false'::jsonb
     or room_result#>'{actor,bot}' is distinct from 'false'::jsonb
     or room_result#>'{presence,white}' is distinct from owner_presence
     or (room_result#>>'{presence,dark,lastSeen}')::bigint < floor(extract(epoch from joined_after) * 1000)::bigint
     or (room_result->>'joinedAt')::timestamptz < joined_after
     or room_result->'leftPlayers' is distinct from '{}'::jsonb then
    raise exception 'Remote join trusted client timestamps/presence or derived the wrong actor.';
  end if;
  begin
    update public.rooms r set host_user_id = outsider_id where r.code = remote_code;
    raise exception 'A joined player changed the host seat.';
  exception when insufficient_privilege then null; end;
  begin
    update public.rooms r set guest_user_id = outsider_id where r.code = remote_code;
    raise exception 'A joined player changed the guest seat.';
  exception when insufficient_privilege then null; end;
  begin
    update public.rooms r set presence = '{"white":{"lastSeen":1}}'::jsonb where r.code = remote_code;
    raise exception 'A remote player forged an opponent heartbeat.';
  exception when insufficient_privilege then null; end;

  execute 'reset role';
  update public.profiles p set banned_at = clock_timestamp() where p.id = host_id;
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',host_id)::text, true);
  perform set_config('request.jwt.claim.sub', host_id::text, true);
  execute 'set local role authenticated';
  begin
    perform public.get_fair_dice_room(remote_code);
    raise exception 'A banned registered actor accessed authoritative play.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.touch_fair_dice_presence(remote_code);
    raise exception 'A banned registered actor refreshed authoritative presence.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.reserve_fair_dice(remote_code, 'opening', 'none', null);
    raise exception 'A banned registered actor reserved authoritative dice.';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  update public.profiles p set banned_at = null where p.id = host_id;

  -- Valid anonymous proof does not impersonate a registered account seat.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.headers', jsonb_build_object('x-guest-id',unseated_guest_id,'x-guest-proof',guest_proof)::text, true);
  execute 'set local role anon';
  if public.request_guest_identity() is distinct from unseated_guest_id then raise exception 'Guest proof headers were not read correctly.'; end if;
  begin
    perform public.get_fair_dice_room(remote_code);
    raise exception 'An unseated anonymous guest impersonated a registered room player.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.headers', jsonb_build_object('x-guest-id',unseated_guest_id,'x-guest-proof','gproof:' || repeat('0',64))::text, true);
  if public.request_guest_identity() is not null then raise exception 'Mismatched guest proof was accepted.'; end if;
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.headers', jsonb_build_object('x-guest-id',unseated_guest_id,'x-guest-proof',guest_proof)::text, true);
  execute 'set local role authenticated';
  begin
    perform public.get_fair_dice_room(remote_code);
    raise exception 'Authenticated claims without an account subject reused guest proof.';
  exception when insufficient_privilege then null; end;

  initial := jsonb_build_object(
    'variant','long','roomCode',remote_code,'mode','remote','startedAt',floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    'points','{"24":{"color":"white","count":15},"12":{"color":"dark","count":15}}'::jsonb,
    'off','{"white":0,"dark":0}'::jsonb,'bar','{"white":0,"dark":0}'::jsonb,'score','{"white":0,"dark":0}'::jsonb,
    'firstMoveDone','{"white":false,"dark":false}'::jsonb,'headPlayedThisTurn','{"white":false,"dark":false}'::jsonb,
    'turnMoves','[]'::jsonb,'dice','[]'::jsonb,'rolled','[]'::jsonb,'history','[]'::jsonb,
    'turn',null,'winner',null,'openingRoll',null,'finishedAt',null,'resultType',null,'phase','opening',
    'matchScore','{"white":0,"dark":0,"target":5,"recordedWinner":null}'::jsonb);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.headers', '{}', true);
  execute 'set local role service_role';
  result := public.commit_fair_dice_state(remote_code, initial, 0, null);
  version := (result->>'version')::integer;
  if version <> 1 then raise exception 'Remote initialization did not advance CAS version.'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',guest_id)::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', guest_id::text, true);
  execute 'set local role authenticated';
  begin
    perform public.reserve_fair_dice(remote_code, 'opening', 'none', null);
    raise exception 'The remote guest reserved the host-only opening roll.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',host_id)::text, true);
  perform set_config('request.jwt.claim.sub', host_id::text, true);
  receipt := public.reserve_fair_dice(remote_code, 'opening', 'none', null);
  first_request_id := (receipt->>'id')::uuid;

  -- Aging is an owner-only rollback fixture, not an API path. The production
  -- coordinator cannot make a heartbeat stale from client-supplied timestamps.
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  perform set_config('nardu.fair_dice_commit_room', room_id::text, true);
  update public.rooms r set joined_at = clock_timestamp() - interval '180 seconds',
    presence = jsonb_build_object('white',jsonb_build_object('lastSeen',now_ms - 180000),'dark',jsonb_build_object('lastSeen',now_ms - 180000))
  where r.id = room_id;
  perform set_config('nardu.fair_dice_commit_room', '', true);
  terminal_state := initial || jsonb_build_object('phase','over','winner','white','finishedAt',now_ms,
    'networkLoss',jsonb_build_object('loserColor','dark','winnerColor','white'),
    'matchScore','{"white":1,"dark":0,"target":5,"recordedWinner":"white"}'::jsonb,
    'history',jsonb_build_array(jsonb_build_object('networkLoss',true,'color','dark','winnerColor','white','at',now_ms)));
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',guest_id)::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', guest_id::text, true);
  execute 'set local role authenticated';
  room_result := public.touch_fair_dice_presence(remote_code);
  if (room_result#>>'{presence,dark,lastSeen}')::bigint < now_ms
     or (room_result#>>'{presence,white,lastSeen}')::bigint <> now_ms - 180000
     or (room_result->>'version')::integer <> version
     or room_result#>'{pending,request}' is distinct from receipt then
    raise exception 'A reconnect changed the wrong seat, board version, or pending request.';
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';
  begin
    perform public.commit_fair_dice_state(remote_code, terminal_state, version - 1, null);
    raise exception 'Stale terminal CAS was accepted.';
  exception when serialization_failure then null; end;
  begin
    perform public.commit_fair_dice_state(remote_code, terminal_state, version, null);
    raise exception 'A fresh reconnect was incorrectly finalized as a network loss.';
  exception when serialization_failure then null; end;
  execute 'reset role';
  if (select r.game_version from public.rooms r where r.id = room_id) <> version
     or (select r.status from public.rooms r where r.id = room_id) <> 'joined'
     or (select q.cancelled_at from private.fair_dice_requests q where q.id = first_request_id) is not null then
    raise exception 'A rejected reconnect race changed the room or cancelled its pending receipt.';
  end if;
  now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  perform set_config('nardu.fair_dice_commit_room', room_id::text, true);
  update public.rooms r set presence = jsonb_set(r.presence,'{dark,lastSeen}',to_jsonb(now_ms - 180000)) where r.id = room_id;
  perform set_config('nardu.fair_dice_commit_room', '', true);
  execute 'set local role service_role';
  result := public.commit_fair_dice_state(remote_code, terminal_state, version, null);
  version := (result->>'version')::integer;
  result := public.get_fair_dice_request(first_request_id);
  if result->'cancelled' is distinct from 'true'::jsonb or result->'proof' is distinct from 'null'::jsonb then
    raise exception 'A legitimate expired-player result did not retain and cancel its pending receipt.';
  end if;

  rematch_initial := initial || jsonb_build_object('startedAt',(initial->>'startedAt')::bigint + 1,
    'matchScore','{"white":1,"dark":0,"target":5,"recordedWinner":null}'::jsonb);
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',host_id)::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', host_id::text, true);
  execute 'set local role authenticated';
  begin
    perform public.reset_fair_dice_game(remote_code, rematch_initial, version);
    raise exception 'A browser caller directly invoked the privileged rematch RPC.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';
  result := public.reset_fair_dice_game(remote_code, rematch_initial, version);
  version := (result->>'version')::integer;
  if (result->>'gameId')::uuid = first_epoch then raise exception 'Remote rematch reused its old epoch.'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',host_id)::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', host_id::text, true);
  execute 'set local role authenticated';
  new_receipt := public.reserve_fair_dice(remote_code, 'opening', 'none', null);
  next_request_id := (new_receipt->>'id')::uuid;
  if (new_receipt->>'nonce')::integer <> 1 or (new_receipt->>'gameId')::uuid = first_epoch
     or next_request_id = first_request_id then raise exception 'Remote rematch did not issue a fresh first request.'; end if;
  begin
    delete from public.rooms r where r.id = room_id;
    get diagnostics deleted_rows = row_count;
    -- Depending on default table grants, ordinary RLS denial is either zero
    -- visible DELETE rows or 42501. Neither outcome may remove the room.
    if deleted_rows <> 0 then raise exception 'A normal registered caller deleted an active fair game.'; end if;
  exception when insufficient_privilege then null; end;
  -- Check the trigger too, separately from the ordinary caller DELETE grant.
  execute 'reset role';
  begin
    delete from public.rooms r where r.id = room_id;
    raise exception 'An owner-role client-claimed session bypassed the active deletion guard.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.rooms r where r.id = room_id;
  if (select count(*) from private.fair_dice_requests q where q.id in (first_request_id,next_request_id)
       and q.room_id is null and q.room_code = remote_code and q.cancelled_at is not null) <> 2 then
    raise exception 'Administrative deletion failed to retain both remote epoch receipts.';
  end if;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.headers', '{}', true);
  execute 'set local role anon';
  result := public.get_fair_dice_request(first_request_id);
  if result->'request' is distinct from receipt or result->'cancelled' is distinct from 'true'::jsonb
     or result ? 'state' or result ? 'actor' then
    raise exception 'The retained public request disappeared or leaked account/board metadata.';
  end if;
  execute 'reset role';
  raise notice 'Fair v36 extra rollback smoke passed: registered actors/bans, waiting close, remote join, JWT/guest isolation, trusted reconnect CAS, remote rematch, retained deletion receipts.';
end;
$fair_dice_v36_extra_smoke$;
