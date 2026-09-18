-- Run after fair-dice-v36.sql in a disposable BEGIN/ROLLBACK transaction.
-- The installer has BEGIN/COMMIT; remove its transaction wrapper when including
-- it in this smoke transaction. Never run this fixture as an installation.
-- Synthetic proof bytes test privileged persistence, NOT beacon cryptography.
do $fair_dice_v36_smoke$
declare
  fixture_code text := 'V36A-' || translate(upper(substr(encode(gen_random_bytes(3), 'hex'), 1, 4)), '01', '23');
  guest_proof text := 'gproof:' || encode(extensions.digest(convert_to(gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex');
  guest_id text;
  supplied_epoch uuid := gen_random_uuid();
  initial jsonb;
  opening_state jsonb;
  roll_state jsonb;
  terminal_state jsonb;
  receipt jsonb;
  retry_receipt jsonb;
  proof jsonb;
  result jsonb;
  room_result jsonb;
  first_epoch uuid;
  old_request_id uuid;
  pending_id uuid;
  ledger private.fair_dice_requests%rowtype;
begin
  if has_table_privilege('anon', 'private.fair_dice_requests', 'INSERT')
     or has_table_privilege('service_role', 'private.fair_dice_requests', 'UPDATE')
     or has_function_privilege('authenticated', 'public.commit_fair_dice_state(text,jsonb,integer,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.commit_fair_dice_proof(uuid,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.commit_fair_dice_state(text,jsonb,integer,uuid)', 'EXECUTE') then
    raise exception 'Fair-dice ACL boundary is invalid.';
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform public.configure_fair_dice_policy(true);
  guest_id := private.guest_identity_from_proof(guest_proof);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.headers', jsonb_build_object('x-guest-id', guest_id, 'x-guest-proof', guest_proof,
    'x-client-info', 'supabase-js-web/smoke nardu-fair-dice-v36')::text, true);
  initial := jsonb_build_object(
    'variant', 'long', 'roomCode', fixture_code, 'mode', 'bot', 'startedAt', 1789680000000::bigint,
    'points', '{"24":{"color":"white","count":15},"12":{"color":"dark","count":15}}'::jsonb,
    'off', '{"white":0,"dark":0}'::jsonb, 'bar', '{"white":0,"dark":0}'::jsonb,
    'score', '{"white":0,"dark":0}'::jsonb, 'firstMoveDone', '{"white":false,"dark":false}'::jsonb,
    'headPlayedThisTurn', '{"white":false,"dark":false}'::jsonb,
    'turnMoves', '[]'::jsonb, 'dice', '[]'::jsonb, 'rolled', '[]'::jsonb, 'history', '[]'::jsonb,
    'turn', null, 'winner', null, 'openingRoll', null, 'finishedAt', null, 'resultType', null,
    'phase', 'opening', 'matchScore', '{"white":0,"dark":0,"target":5,"recordedWinner":null}'::jsonb
  );
  insert into public.rooms(code, variant, status, host_name, host_guest_id, host_registered,
    game_state, fair_dice_required, fair_dice_game_id, created_at)
  values(fixture_code, 'long', 'joined', 'Fair v36 smoke', guest_id, false,
    initial, false, supplied_epoch, '2000-01-01'::timestamptz);
  room_result := public.get_fair_dice_room(fixture_code);
  first_epoch := (room_result->>'gameId')::uuid;
  if room_result->'fairDiceRequired' <> 'true'::jsonb or first_epoch = supplied_epoch
     or room_result->'pending' <> 'null'::jsonb then raise exception 'Policy stamping failed.'; end if;
  room_result := public.touch_fair_dice_presence(fixture_code);
  if room_result#>'{presence,white,lastSeen}' is distinct from room_result->'serverNowMs'
     and abs((room_result#>>'{presence,white,lastSeen}')::bigint - (room_result->>'serverNowMs')::bigint) > 1000 then
    raise exception 'Presence time did not originate from the database clock.';
  end if;
  begin
    update public.rooms r set presence = '{"dark":{"lastSeen":1}}'::jsonb where r.code = fixture_code;
    raise exception 'Client forged opponent expiry.';
  exception when insufficient_privilege then null; end;
  begin
    update public.rooms r set fair_dice_required = false where r.code = fixture_code;
    raise exception 'Client downgraded dice policy.';
  exception when insufficient_privilege then null; end;
  begin
    update public.rooms r set game_state = jsonb_set(initial, '{dice}', '[6,6,6,6]'::jsonb),
      game_version = game_version + 1 where r.code = fixture_code;
    raise exception 'Client injected dice state.';
  exception when insufficient_privilege then null; end;
  begin
    update public.rooms r set status = 'over' where r.code = fixture_code;
    raise exception 'Client declared a result without authoritative state.';
  exception when insufficient_privilege then null; end;
  receipt := public.reserve_fair_dice(fixture_code, 'opening', 'none', repeat('0',64));
  retry_receipt := public.reserve_fair_dice(fixture_code, 'opening', 'none', repeat('f',64));
  if receipt <> retry_receipt or (receipt->>'nonce')::integer <> 1 then raise exception 'Reservation is not idempotent.'; end if;
  old_request_id := (receipt->>'id')::uuid;
  select * into ledger from private.fair_dice_requests where id = old_request_id;
  if 1692803367 + (ledger.round - 1)*3 < extract(epoch from ledger.created_at) + 6 then
    raise exception 'Dice reservation did not choose a future round.';
  end if;
  room_result := public.get_fair_dice_room(fixture_code);
  if room_result#>'{pending,request}' <> receipt then raise exception 'Pending context is hidden.'; end if;
  begin
    update public.rooms r set status = 'closed' where r.code = fixture_code;
    raise exception 'Client hid an active room to discard pending dice.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.reserve_fair_dice(fixture_code, 'roll', 'white', null);
    raise exception 'Client changed the pending roll intent.';
  exception when invalid_parameter_value then null; end;
  proof := jsonb_build_object(
    'protocol', 'drand-quicknet-v1', 'request', receipt, 'requestHash', repeat('a',64),
    'receiptSignature', repeat('b',128), 'chainHash', repeat('c',64),
    'beacon', jsonb_build_object('round', (receipt->>'round')::bigint, 'signature', repeat('d',96), 'randomness', repeat('e',64)),
    'sha256Input', 'synthetic-persistence-preimage',
    'sha256', encode(extensions.digest(convert_to('synthetic-persistence-preimage', 'UTF8'), 'sha256'), 'hex'),
    'dice', '[6,1]'::jsonb, 'rerolls', 0
  );
  begin
    perform public.commit_fair_dice_proof(old_request_id, proof);
    raise exception 'Anonymous player completed a dice proof.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  if public.commit_fair_dice_proof(old_request_id, proof) <> proof
     or public.commit_fair_dice_proof(old_request_id, proof) <> proof then raise exception 'Proof completion was not idempotent.'; end if;
  begin
    perform public.commit_fair_dice_proof(old_request_id, proof || jsonb_build_object('receiptSignature', repeat('f',128)));
    raise exception 'A completed proof was rewritten.';
  exception when unique_violation then null; end;
  opening_state := initial || jsonb_build_object('phase', 'opening-result', 'turn', 'white', 'rolled', '[6,1]'::jsonb,
    'openingRoll', jsonb_build_object('host', jsonb_build_object('die',6), 'guest', jsonb_build_object('die',1),
      'winnerColor','white','fairDiceProof',proof),
    'history', jsonb_build_array(jsonb_build_object('opening',true,'host',6,'guest',1,'winnerColor','white','rerolls',0,
      'sha256',proof->>'sha256','sha256Input',proof->>'sha256Input','fairDiceProof',proof)));
  result := public.commit_fair_dice_state(fixture_code, opening_state, 0, old_request_id);
  if (result->>'version')::integer <> 1 then raise exception 'Opening commit version is wrong.'; end if;
  roll_state := opening_state || jsonb_build_object('phase','roll','rolled','[]'::jsonb);
  perform public.commit_fair_dice_state(fixture_code, roll_state, 1, null);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  receipt := public.reserve_fair_dice(fixture_code, 'roll', 'white', null);
  pending_id := (receipt->>'id')::uuid;
  if (receipt->>'nonce')::integer <> 2 then raise exception 'Next request nonce did not advance.'; end if;
  terminal_state := roll_state || jsonb_build_object('phase','over','winner','dark','rolled','[]'::jsonb,'dice','[]'::jsonb,
    'history', jsonb_build_array(jsonb_build_object('resign',true,'color','white','winnerColor','dark')) || (roll_state->'history'));
  if jsonb_typeof(terminal_state->'history') is distinct from 'array'
     or terminal_state->>'roomCode' is distinct from fixture_code
     or terminal_state->>'mode' is distinct from roll_state->>'mode'
     or terminal_state->'startedAt' is distinct from roll_state->'startedAt' then
    raise exception 'Smoke terminal payload must preserve identity and prepend array history.';
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform public.commit_fair_dice_state(fixture_code, terminal_state, 2, null);
  result := public.get_fair_dice_request(pending_id);
  if result->'cancelled' <> 'true'::jsonb or result->'proof' <> 'null'::jsonb then raise exception 'Terminal cancellation lost its evidence.'; end if;
  result := public.reset_fair_dice_game(fixture_code, initial, 3);
  if (result->>'gameId')::uuid = first_epoch
     or (select count(*) from private.fair_dice_requests r where r.room_code = fixture_code) <> 2 then
    raise exception 'Rematch reused its epoch or erased the previous ledger.';
  end if;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  receipt := public.reserve_fair_dice(fixture_code, 'opening', 'none', null);
  if (receipt->>'nonce')::integer <> 1 or (receipt->>'gameId')::uuid = first_epoch then raise exception 'New epoch nonce is invalid.'; end if;
  begin
    delete from public.rooms r where r.code = fixture_code;
    raise exception 'Player deleted an active game to discard its dice.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  delete from public.rooms r where r.code = fixture_code;
  result := public.get_fair_dice_request(old_request_id);
  if result->'proof' <> proof
     or exists(select 1 from private.fair_dice_requests r where r.room_code = fixture_code and r.room_id is not null)
     or (select count(*) from private.fair_dice_requests r where r.room_code = fixture_code) <> 3 then
    raise exception 'Admin deletion erased or detached cryptographic evidence incorrectly.';
  end if;
  raise notice 'Fair v36 rollback smoke passed: stamping, auth, idempotence, proof immutability, CAS, cancellation, rematch.';
end;
$fair_dice_v36_smoke$;
