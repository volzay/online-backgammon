-- Run after saved-bot-rating-v41.sql. Synthetic users and rooms only.
-- The fixture uses the same operator-only committed-state capability as the
-- existing fair-dice rollback tests; no policy setting or real room changes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $saved_bot_rating_smoke$
declare
  player_id uuid := gen_random_uuid();
  spectator_id uuid := gen_random_uuid();
  suffix text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  player_name text;
  room_ids uuid[] := array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  room_codes text[] := array[]::text[];
  key_one text := '1795364000001:white:normal';
  key_two text := '1795364000002:white:normal';
  key_loss text := '1795364000003:dark:normal';
  key_dark text := '1795364000004:dark:normal';
  final_state jsonb;
  first_state jsonb;
  before_room jsonb;
  before_archive jsonb;
  archive_count integer;
  response jsonb;
  denied boolean;
  i integer;
  raw_code text;
  player_color text;
  winner_color text;
  finished_ms bigint;
  historical_key text := '1795363999999:white:normal';
begin
  if has_function_privilege('anon', 'public.record_saved_bot_rating(text,text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.record_saved_bot_rating(text,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.record_saved_bot_rating(text,text)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.rating_events', 'INSERT') then
    raise exception 'Saved rating RPC or rating-event ACL is invalid.';
  end if;
  player_name := 'Rate' || suffix;
  insert into auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  values
    (player_id,'authenticated','authenticated',player_name || '@example.invalid',jsonb_build_object('nickname',player_name),now(),now()),
    (spectator_id,'authenticated','authenticated','Watch' || suffix || '@example.invalid',jsonb_build_object('nickname','Watch' || suffix),now(),now());

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.headers', '{"x-client-info":"rollback-smoke nardu-fair-dice-v36 nardu-fair-dice-v37"}', true);
  for i in 1..4 loop
    raw_code := upper(left(replace(gen_random_uuid()::text, '-', ''),8));
    room_codes := array_append(room_codes, left(raw_code,4) || '-' || right(raw_code,4));
    insert into public.rooms(id,code,variant,status,host_user_id,host_name,host_registered,game_state)
    values(room_ids[i],room_codes[i],'long','over',player_id,player_name,true,null);
    player_color := case when i=4 then 'dark' else 'white' end;
    winner_color := case when i in (3,4) then 'dark' else 'white' end;
    finished_ms := 1795364000000::bigint + i;
    final_state := jsonb_build_object(
      'mode','bot','variant','long','roomCode',room_codes[i],'botDifficulty','hard',
      'phase','over','startedAt',1795360000000::bigint,'finishedAt',finished_ms,
      'turn',winner_color,'winner',winner_color,'resultType',null,
      'points',case when winner_color='white' then '{"12":{"color":"dark","count":14}}'::jsonb else '{"24":{"color":"white","count":14}}'::jsonb end,
      'off',case when winner_color='white' then '{"white":15,"dark":1}'::jsonb else '{"white":1,"dark":15}'::jsonb end,
      'bar','{"white":0,"dark":0}'::jsonb,'score','{"white":0,"dark":0}'::jsonb,
      'dice','[]'::jsonb,'rolled','[]'::jsonb,'turnMoves','[]'::jsonb,
      'history',jsonb_build_array(jsonb_build_object('fixture',true,'at','2026-11-22T16:00:00Z','note',repeat('h',32768))),
      'analysis',jsonb_build_object('mode','bot','difficulty','hard','playerColor',player_color,
        'botName','Бот сложный','largeTrainingFixture',repeat('x',3*1024*1024))
    );
    perform set_config('nardu.fair_dice_commit_room', room_ids[i]::text, true);
    update public.rooms set game_state=final_state,game_version=game_version+1 where id=room_ids[i];
    perform set_config('nardu.fair_dice_commit_room', '', true);
    if i=1 then first_state := final_state; end if;
  end loop;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', player_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',player_id)::text, true);
  select to_jsonb(r) into before_room from public.rooms r where id=room_ids[1];
  select to_jsonb(a) into before_archive from public.room_game_archives a where room_id=room_ids[1] and result_key=key_one;
  if before_archive is null then raise exception 'Synthetic finished result was not archived.'; end if;
  select count(*) into archive_count from public.room_game_archives where room_id=room_ids[1];

  response := public.record_saved_bot_rating(lower(room_codes[1]), key_one);
  if response->>'ok' <> 'true' or response->>'duplicate' <> 'false'
     or (response->>'delta')::integer <> 23 or (response->>'rating')::integer <> 1023
     or (response->>'historyCount')::integer <> 1 or octet_length(response::text)>1024 then
    raise exception 'A saved normal win did not produce the expected small authoritative receipt.';
  end if;
  if not exists(select 1 from public.rating_events e where e.user_id=player_id and e.result_key=key_one
      and e.opponent_rating=1500 and e.did_win and e.mode='bot'
      and e.history=first_state->'history'
      and e.score#>'{finalState,finishedAt}'=first_state->'finishedAt') then
    raise exception 'Server-owned rating data or the full saved history was not retained.';
  end if;
  if before_room is distinct from (select to_jsonb(r) from public.rooms r where id=room_ids[1])
     or before_archive is distinct from (select to_jsonb(a) from public.room_game_archives a where room_id=room_ids[1] and result_key=key_one)
     or archive_count <> (select count(*) from public.room_game_archives where room_id=room_ids[1]) then
    raise exception 'A rating selector request rewrote the room or archive.';
  end if;

  response := public.record_saved_bot_rating(room_codes[2],key_two);
  if (response->>'delta')::integer<>23 or (response->>'rating')::integer<>1046 then
    raise exception 'The next independent saved win was not awarded.';
  end if;
  response := public.record_saved_bot_rating(room_codes[1],key_one);
  if response->>'duplicate'<>'true' or (response->>'delta')::integer<>23
     or (response->>'resultRating')::integer<>1023 or (response->>'rating')::integer<>1046
     or (select count(*) from public.rating_events where user_id=player_id and result_key=key_one)<>1 then
    raise exception 'A duplicate award changed rating or returned an obsolete lobby rating.';
  end if;
  response := public.record_saved_bot_rating(room_codes[3],key_loss);
  if (response->>'delta')::integer <> -2 or (response->>'rating')::integer<>1044 then
    raise exception 'The saved loss was not derived from the server winner and seat.';
  end if;
  response := public.record_saved_bot_rating(room_codes[4],key_dark);
  if (response->>'delta')::integer<>22 or (response->>'rating')::integer<>1066 then
    raise exception 'The registered host playing dark did not receive the correct saved win.';
  end if;

  -- A rematch may already have replaced the current room state. Use the exact
  -- historical archive, preserve its room seat and leave the new game alone.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('nardu.fair_dice_commit_room',room_ids[1]::text,true);
  update public.rooms set game_state=game_state || jsonb_build_object('finishedAt',1795364999999::bigint),
    game_version=game_version+1 where id=room_ids[1];
  perform set_config('nardu.fair_dice_commit_room','',true);
  select to_jsonb(r) into before_room from public.rooms r where id=room_ids[1];
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',player_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',player_id)::text,true);
  response := public.record_saved_bot_rating(room_codes[1],key_one);
  if response->>'duplicate'<>'true' or (response->>'rating')::integer<>1066
     or before_room is distinct from (select to_jsonb(r) from public.rooms r where id=room_ids[1]) then
    raise exception 'Exact archive recovery rewrote a newer result or rolled back the current rating.';
  end if;

  denied:=false;
  begin
    perform public.record_saved_bot_rating(room_codes[1],'1795364000001:white:mars');
  exception when object_not_in_prerequisite_state or invalid_parameter_value then denied:=true; end;
  if not denied then raise exception 'An invented result key obtained an award.'; end if;
  perform set_config('request.jwt.claim.sub',spectator_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',spectator_id)::text,true);
  denied:=false;
  begin perform public.record_saved_bot_rating(room_codes[1],key_one);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'A spectator obtained the host award.'; end if;
  perform set_config('request.jwt.claim.role','anon',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  denied:=false;
  begin perform public.record_saved_bot_rating(room_codes[1],key_one);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'An anonymous caller obtained an award.'; end if;

  -- Historic records from the unrated neural player test cannot acquire Elo.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.room_game_archives(room_id,room_code,result_key,variant,host_name,winner,result_type,final_state)
  values(room_ids[1],room_codes[1],historical_key,'long',player_name,'white','normal',
    first_state || jsonb_build_object('finishedAt',1795363999999::bigint,'botDifficulty','hard-neuro'));
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',player_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',player_id)::text,true);
  denied:=false;
  begin perform public.record_saved_bot_rating(room_codes[1],historical_key);
  exception when invalid_parameter_value then denied:=true; end;
  if not denied then raise exception 'An unrated neural game obtained an award.'; end if;
  update public.profiles set rating_eligible=false where id=player_id;
  denied:=false;
  begin perform public.record_saved_bot_rating(room_codes[2],key_two);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'A rating-ineligible profile obtained an award.'; end if;
  if (select rating from public.profiles where id=player_id)<>1066
     or (select rating from public.profiles where id=spectator_id)<>1000
     or (select count(*) from public.rating_events where user_id=player_id)<>4 then
    raise exception 'Negative cases changed a profile or created a rating event.';
  end if;
  raise notice 'Saved bot rating: normal win, next win, loss, dark seat, exact archive, duplicate, privacy, eligibility and neural exclusion passed.';
end;
$saved_bot_rating_smoke$;

rollback;
