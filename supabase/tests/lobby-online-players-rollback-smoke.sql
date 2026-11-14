-- Run after lobby-online-players.sql, or strip the migration's transaction
-- wrapper and run both inside one transaction. The smoke data rolls back.
begin;

do $lobby_online_smoke$
declare
  suffix text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  shown_id uuid := gen_random_uuid();
  hidden_id uuid := gen_random_uuid();
  guest_proof text := 'gproof:' || encode(extensions.gen_random_bytes(32), 'hex');
  guest_id text := private.guest_identity_from_proof(guest_proof);
  shown_name text := 'LobbyShown' || suffix;
  hidden_name text := 'LobbyHidden' || suffix;
  guest_name text := 'LobbyGuest' || suffix;
  players jsonb;
  touched_rows integer;
begin
  if has_table_privilege('anon', 'public.guest_presence', 'SELECT')
     or not has_column_privilege('anon', 'public.guest_presence', 'id', 'SELECT')
     or has_function_privilege('anon', 'public.set_lobby_rating_visibility(boolean,boolean)', 'EXECUTE') then
    raise exception 'Guest lobby access is broader than its own heartbeat.';
  end if;
  insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values
    (shown_id, 'authenticated', 'authenticated', shown_name || '@example.invalid', jsonb_build_object('nickname', shown_name), now(), now()),
    (hidden_id, 'authenticated', 'authenticated', hidden_name || '@example.invalid', jsonb_build_object('nickname', hidden_name), now(), now());
  update public.profiles set rating = 1352, show_rating_in_lobby = true where id = shown_id;
  update public.profiles set rating = 1714, show_rating_in_lobby = null where id = hidden_id;

  insert into public.guest_presence (id, name, last_seen_at) values
    (guest_id, guest_name, now() - interval '100 seconds'),
    ('guest:local:' || suffix, 'LobbyAlias' || suffix, now()),
    ('guest:sha256:' || encode(extensions.gen_random_bytes(32), 'hex'), 'LobbyExpired' || suffix, now() - interval '100 seconds'),
    ('guest:sha256:' || encode(extensions.gen_random_bytes(32), 'hex'), 'LobbyFuture' || suffix, now() + interval '10 minutes');

  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', hidden_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', hidden_id)::text, true);
  perform set_config('request.headers', '{}', true);

  players := public.list_lobby_online_players();
  if not players @> jsonb_build_array(jsonb_build_object('nickname', hidden_name, 'rating', null, 'guest', false))
     or exists (select 1 from jsonb_array_elements(players) player where player ?| array['email', 'id', 'last_seen_at']) then
    raise exception 'Lobby rating is visible before synchronization or leaks private fields.';
  end if;
  if public.set_lobby_rating_visibility(false, true) is distinct from false
     or public.set_lobby_rating_visibility(true, true) is distinct from false then
    raise exception 'An initializer overwrote an existing visibility preference.';
  end if;
  if public.set_lobby_rating_visibility(true) is distinct from true
     or public.set_lobby_rating_visibility(false) is distinct from false then
    raise exception 'An explicit visibility change did not persist.';
  end if;

  execute 'set local role anon';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    perform public.list_lobby_online_players();
    raise exception 'An anonymous request without guest proof read the lobby.';
  exception when insufficient_privilege then null; end;

  perform set_config('request.headers', jsonb_build_object('x-guest-id', guest_id, 'x-guest-proof', guest_proof)::text, true);
  update public.guest_presence set last_seen_at = now() where id = guest_id;
  get diagnostics touched_rows = row_count;
  if touched_rows <> 1 or (select count(id) from public.guest_presence) <> 1 then
    raise exception 'Guest heartbeat did not update exactly its own presence.';
  end if;

  players := public.list_lobby_online_players();
  if not players @> jsonb_build_array(
      jsonb_build_object('nickname', shown_name, 'rating', 1352, 'guest', false),
      jsonb_build_object('nickname', hidden_name, 'rating', null, 'guest', false),
      jsonb_build_object('nickname', guest_name, 'rating', null, 'guest', true)
    ) or exists (
      select 1 from jsonb_array_elements(players) player
      where player->>'nickname' in ('LobbyAlias' || suffix, 'LobbyExpired' || suffix, 'LobbyFuture' || suffix)
    ) then
    raise exception 'The lobby did not preserve visibility or presence filtering.';
  end if;

  execute 'reset role';
  update public.profiles set banned_at = now() where id = shown_id;
  if exists (select 1 from jsonb_array_elements(public.list_lobby_online_players()) player
      where player->>'nickname' = shown_name) then
    raise exception 'The lobby included a banned profile.';
  end if;
end;
$lobby_online_smoke$;

rollback;
