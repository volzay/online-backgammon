-- Run after lobby-presence-heartbeat.sql. All fixture changes roll back.
begin;

do $lobby_presence_smoke$
declare
  suffix text := left(replace(gen_random_uuid()::text, '-', ''), 10);
  player_id uuid := gen_random_uuid();
  banned_id uuid := gen_random_uuid();
  player_name text := 'HeartbeatA' || suffix;
  banned_name text := 'HeartbeatB' || suffix;
  guest_name text := 'HeartbeatG' || suffix;
  guest_proof text := 'gproof:' || encode(extensions.gen_random_bytes(32), 'hex');
  guest_id text := private.guest_identity_from_proof(guest_proof);
  missing_proof text := 'gproof:' || encode(extensions.gen_random_bytes(32), 'hex');
  missing_id text := private.guest_identity_from_proof(missing_proof);
  old_seen timestamptz := clock_timestamp() - interval '10 minutes';
  future_seen timestamptz := clock_timestamp() + interval '10 minutes';
  touched_after timestamptz;
  actual_seen timestamptz;
  touched_rows integer;
  roster jsonb;
begin
  if has_function_privilege('service_role', 'public.touch_lobby_presence()', 'EXECUTE')
     or not has_function_privilege('anon', 'public.touch_lobby_presence()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.touch_lobby_presence()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.stamp_lobby_presence()', 'EXECUTE')
     or has_function_privilege('anon', 'private.stamp_lobby_presence()', 'EXECUTE') then
    raise exception 'Unexpected presence heartbeat grants.';
  end if;

  insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values
    (player_id, 'authenticated', 'authenticated', player_name || '@example.invalid', jsonb_build_object('nickname', player_name), now(), now()),
    (banned_id, 'authenticated', 'authenticated', banned_name || '@example.invalid', jsonb_build_object('nickname', banned_name), now(), now());
  update public.profiles set last_seen_at = future_seen, show_rating_in_lobby = false where id = player_id;
  update public.profiles set last_seen_at = old_seen, banned_at = now() where id = banned_id;
  insert into public.guest_presence (id, name, last_seen_at) values (guest_id, guest_name, old_seen);

  touched_after := clock_timestamp();
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', player_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', player_id)::text, true);
  perform set_config('request.headers', jsonb_build_object('x-guest-id', guest_id, 'x-guest-proof', guest_proof)::text, true);
  if public.touch_lobby_presence() is distinct from true then
    raise exception 'The authenticated player could not update its presence.';
  end if;
  if not exists (select 1 from public.profiles where id = player_id and last_seen_at between touched_after and clock_timestamp())
     or not exists (select 1 from public.guest_presence where id = guest_id and last_seen_at = old_seen) then
    raise exception 'Presence did not use server time or preferred guest headers over the registered player.';
  end if;

  touched_after := clock_timestamp();
  update public.profiles set last_seen_at = future_seen where id = player_id returning last_seen_at into actual_seen;
  if actual_seen is null or actual_seen not between touched_after and clock_timestamp() then
    raise exception 'A legacy registered heartbeat overwrote server time.';
  end if;
  update public.profiles set show_rating_in_lobby = false where id = player_id;
  if not exists (select 1 from public.profiles where id = player_id and last_seen_at = actual_seen) then
    raise exception 'Changing another field refreshed profile presence.';
  end if;

  perform set_config('request.jwt.claim.sub', banned_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', banned_id)::text, true);
  if public.touch_lobby_presence() is distinct from false
     or not exists (select 1 from public.profiles where id = banned_id and last_seen_at = old_seen) then
    raise exception 'A banned profile refreshed its presence.';
  end if;

  execute 'set local role anon';
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.headers', '{}', true);
  if public.touch_lobby_presence() is distinct from false then
    raise exception 'An anonymous request refreshed presence without guest proof.';
  end if;

  perform set_config('request.headers', jsonb_build_object('x-guest-id', guest_id, 'x-guest-proof', missing_proof)::text, true);
  if public.touch_lobby_presence() is distinct from false then
    raise exception 'Mismatched guest proof refreshed another guest.';
  end if;
  update public.guest_presence set last_seen_at = future_seen where id = guest_id;
  get diagnostics touched_rows = row_count;
  if touched_rows <> 0 then
    raise exception 'Direct guest heartbeat bypassed proof checks.';
  end if;

  perform set_config('request.headers', jsonb_build_object('x-guest-id', missing_id, 'x-guest-proof', missing_proof)::text, true);
  if public.touch_lobby_presence() is distinct from false
     or exists (select 1 from public.guest_presence where id = missing_id) then
    raise exception 'An uninitialized guest became visible without a name.';
  end if;

  touched_after := clock_timestamp();
  insert into public.guest_presence (id, name, last_seen_at)
  values (missing_id, 'HeartbeatNew' || suffix, future_seen);
  execute 'reset role';
  if not exists (select 1 from public.guest_presence where id = missing_id
      and last_seen_at between touched_after and clock_timestamp()) then
    raise exception 'Legacy guest registration did not use server time.';
  end if;
  execute 'set local role anon';

  touched_after := clock_timestamp();
  perform set_config('request.headers', jsonb_build_object('x-guest-id', guest_id, 'x-guest-proof', guest_proof)::text, true);
  if public.touch_lobby_presence() is distinct from true then
    raise exception 'The verified guest could not update its presence.';
  end if;
  update public.guest_presence set last_seen_at = future_seen where id = guest_id;
  get diagnostics touched_rows = row_count;
  if touched_rows <> 1 then
    raise exception 'The legacy guest could not update its own presence.';
  end if;
  roster := public.list_lobby_invite_targets();
  if not roster @> jsonb_build_array(
      jsonb_build_object('nickname', player_name, 'rating', null, 'guest', false),
      jsonb_build_object('nickname', guest_name, 'rating', null, 'guest', true))
     or exists (select 1 from jsonb_array_elements(roster) entry where entry->>'nickname' = banned_name) then
    raise exception 'The roster lost an active player or changed rating and ban filtering.';
  end if;

  execute 'reset role';
  if not exists (select 1 from public.guest_presence where id = guest_id and name = guest_name
      and last_seen_at between touched_after and clock_timestamp()) then
    raise exception 'The guest heartbeat changed more than existing presence.';
  end if;
end;
$lobby_presence_smoke$;

rollback;
