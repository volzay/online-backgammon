-- Run only in a disposable database with schema.sql and the migration loaded.
-- This tests the aggregate projection, not game-rule transitions. Synthetic
-- snapshots deliberately bypass unrelated room triggers in this transaction.
begin;
set local session_replication_role = replica;

do $admin_room_roll_stats_smoke$
declare
  live_id uuid := gen_random_uuid();
  rematch_id uuid := gen_random_uuid();
  empty_id uuid := gen_random_uuid();
  prefix text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  synthetic_history jsonb;
  terminal jsonb;
  projected jsonb;
  row_stats jsonb;
  admin_email text := (public.admin_email_whitelist())[1];
begin
  if has_function_privilege('anon', 'public.admin_room_roll_stats(uuid[])', 'EXECUTE')
     or has_function_privilege('service_role', 'public.admin_room_roll_stats(uuid[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.admin_room_roll_stats(uuid[])', 'EXECUTE') then
    raise exception 'Room roll statistics RPC has an invalid ACL.';
  end if;

  select jsonb_agg(jsonb_build_object(
    'color', case when n <= 20 then 'white' else 'dark' end,
    'roll', case when n <= 3 then '6:6' when n <= 20 then '1:2'
                 when n <= 28 then '3:3' else '2:4' end,
    'fairDiceProof', jsonb_build_object('request', jsonb_build_object('id', 'fixture:' || n, 'label', 'roll'))
  ) order by n) into synthetic_history from generate_series(1, 40) n;
  synthetic_history := jsonb_set(synthetic_history, '{0,at}', jsonb_build_object('privateHistory', 'not metadata'));
  synthetic_history := jsonb_set(synthetic_history, '{0,sha256}', jsonb_build_object('privateProof', 'not a hash'));
  synthetic_history := synthetic_history || jsonb_build_array(
    synthetic_history->0,
    jsonb_build_object('color', 'white', 'roll', '2:2'),
    jsonb_build_object('color', 'white', 'roll', '2:2'),
    jsonb_build_object('color', 'white', 'roll', '6:6', 'opening', true),
    jsonb_build_object('color', 'white', 'roll', '6:6', 'openingRoll', jsonb_build_array(6, 6)),
    jsonb_build_object('color', 'white', 'roll', '6:6', 'fairDiceProof',
      jsonb_build_object('request', jsonb_build_object('id', 'opening-fixture', 'label', 'opening'))),
    jsonb_build_object('color', 'white', 'roll', '7:7'),
    jsonb_build_object('color', 'white', 'roll', '6:6:6'),
    jsonb_build_object('color', 'white', 'roll', jsonb_build_array(6, 6, 6, 6)),
    jsonb_build_object('color', 'none', 'roll', '6:6'),
    jsonb_build_object('color', 'white', 'die', 6, 'from', 24, 'to', 18)
  );
  terminal := jsonb_build_object('winner', 'white', 'phase', 'over',
    'mode', 'bot', 'finishedAt', '2026-11-18T12:00:00.000Z',
    'analysis', jsonb_build_object('playerColor', 'dark'), 'history', synthetic_history);

  insert into public.rooms(id, code, host_name, guest_name, status, variant, game_state)
  values
    (live_id, 'STAT-LIVE-' || prefix, 'Human', 'Hard bot', 'over', 'short', terminal),
    (rematch_id, 'STAT-REMATCH-' || prefix, 'Human', 'Hard bot', 'joined', 'long',
      jsonb_build_object('phase', 'move', 'history', jsonb_build_array(jsonb_build_object('color', 'white', 'roll', '1:1')))),
    (empty_id, 'STAT-EMPTY-' || prefix, 'Human', 'Opponent', 'over', 'long',
      jsonb_build_object('winner', 'dark', 'history', '[]'::jsonb));
  insert into public.room_game_archives(room_id, room_code, result_key, host_name, guest_name,
    winner, final_state, completed_at)
  values
    (live_id, 'STAT-LIVE-' || prefix, 'newer-archive', 'Human', 'Hard bot', 'dark',
      jsonb_build_object('winner', 'dark', 'history', '[]'::jsonb), '2026-11-19T12:00:00Z'),
    (rematch_id, 'STAT-REMATCH-' || prefix, 'canonical-game', 'Human', 'Hard bot', 'white',
      terminal, '2026-11-18T12:00:00Z');
  insert into public.bot_training_games(room_id, room_code, player_name, bot_name, bot_color,
    winner, final_state, completed_at)
  values (rematch_id, 'STAT-REMATCH-' || prefix, 'Human', 'Hard bot', 'white', 'white',
    terminal || jsonb_build_object('history', '[]'::jsonb), '2026-11-19T12:00:00Z');

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'email', 'not-an-admin@example.invalid')::text, true);
  begin
    perform public.admin_room_roll_stats(array[live_id]);
    raise exception 'A non-admin read room roll statistics.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon', 'email', admin_email)::text, true);
  begin
    perform public.admin_room_roll_stats(array[live_id]);
    raise exception 'An anonymous caller bypassed the authenticated admin gate.';
  exception when insufficient_privilege then null; end;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'email', admin_email)::text, true);
  projected := public.admin_room_roll_stats(array[live_id, rematch_id, empty_id, live_id, gen_random_uuid()]);
  if jsonb_array_length(projected) <> 3 then
    raise exception 'Room batch duplicated an ID or returned a missing room.';
  end if;
  for row_stats in select value from jsonb_array_elements(projected) loop
    if row_stats ?| array['history', 'proof', 'positions', 'decisions', 'game_state', 'final_state'] then
      raise exception 'The aggregate RPC exported a full private game payload.';
    end if;
    if row_stats->>'roomId' in (live_id::text, rematch_id::text) then
      if row_stats->>'rolls' <> '42' or row_stats->>'doubles' <> '13'
         or row_stats#>>'{byColor,white,rolls}' <> '22'
         or row_stats#>>'{byColor,white,doubles}' <> '5'
         or row_stats#>>'{byColor,dark,rolls}' <> '20'
         or row_stats#>>'{byColor,dark,doubles}' <> '8'
         or row_stats->>'historyAvailable' <> 'true'
         or row_stats->>'playerColor' <> 'dark'
         or row_stats#>'{lastRoll,at}' <> 'null'::jsonb
         or row_stats#>'{lastRoll,sha256}' <> 'null'::jsonb then
        raise exception 'The aggregate lost color, counted a move/opening/duplicate, or discarded an ordinary repeated roll.';
      end if;
    elsif row_stats->>'historyAvailable' <> 'false' then
      raise exception 'A missing finished-game history was presented as a known zero.';
    end if;
    if row_stats->>'roomId' = live_id::text and row_stats->>'gameSource' <> 'live' then
      raise exception 'A newer archive replaced a completed live snapshot.';
    end if;
    if row_stats->>'roomId' = rematch_id::text and row_stats->>'gameSource' <> 'room_archive' then
      raise exception 'A compact training copy replaced the canonical completed game.';
    end if;
  end loop;

  update public.bot_training_games set winner = 'dark',
    final_state = jsonb_build_object('winner', 'dark', 'finishedAt', '2026-11-20T12:00:00.000Z', 'history', '[]'::jsonb),
    completed_at = '2026-11-20T12:00:00Z' where room_id = rematch_id;
  row_stats := public.admin_room_roll_stats(array[rematch_id])->0;
  if row_stats->>'gameSource' <> 'training_archive' or row_stats->>'historyAvailable' <> 'false' then
    raise exception 'An older canonical game replaced a genuinely newer compact training game.';
  end if;
  if public.admin_room_roll_stats(array[]::uuid[]) <> '[]'::jsonb then
    raise exception 'An empty batch did not return an empty projection.';
  end if;
  begin
    perform public.admin_room_roll_stats(array_fill(live_id, array[501]));
    raise exception 'An oversized room batch was accepted.';
  exception when invalid_parameter_value then null; end;
end;
$admin_room_roll_stats_smoke$;

rollback;
