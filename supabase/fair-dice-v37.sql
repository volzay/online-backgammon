begin;

-- Additive dual-protocol installation. Existing rooms, requests, issued proofs,
-- rematch policy, and drand reservations are NOT converted or overwritten.
-- Installation retains drand as the new-room default. Activate system-csprng-v1
-- only after the matching coordinator and v37 browser are deployed.
alter table private.fair_dice_settings add column if not exists protocol text not null default 'drand-quicknet-v1';
alter table private.fair_dice_settings drop constraint if exists fair_dice_settings_protocol_check;
alter table private.fair_dice_settings add constraint fair_dice_settings_protocol_check
  check (protocol in ('drand-quicknet-v1', 'system-csprng-v1'));
alter table public.rooms add column if not exists fair_dice_protocol text not null default 'drand-quicknet-v1';
alter table public.rooms drop constraint if exists rooms_fair_dice_protocol_check;
alter table public.rooms add constraint rooms_fair_dice_protocol_check
  check (fair_dice_protocol in ('drand-quicknet-v1', 'system-csprng-v1'));

alter table private.fair_dice_requests alter column round drop not null;
alter table private.fair_dice_requests add column if not exists protocol text not null default 'drand-quicknet-v1';
alter table private.fair_dice_requests add column if not exists private_seed text;
alter table private.fair_dice_requests add column if not exists commitment text;
alter table private.fair_dice_requests add column if not exists client_seed text;
alter table private.fair_dice_requests add column if not exists client_seed_at timestamptz;
alter table private.fair_dice_requests drop constraint if exists fair_dice_requests_protocol_shape_check;
alter table private.fair_dice_requests add constraint fair_dice_requests_protocol_shape_check check (
  (protocol = 'drand-quicknet-v1' and round is not null and private_seed is null
    and commitment is null and client_seed is null and client_seed_at is null)
  or (protocol = 'system-csprng-v1' and round is null
    and private_seed is not null and private_seed ~ '^[0-9a-f]{64}$'
    and commitment is not null and commitment ~ '^[0-9a-f]{64}$'
    and ((client_seed is null and client_seed_at is null)
      or (client_seed is not null and client_seed ~ '^[0-9a-f]{64}$'
        and client_seed_at is not null and client_seed_at >= created_at)))
);
-- Preserve v36 uniqueness, outstanding-request index, FKs and private ACLs.
revoke all on private.fair_dice_settings from public, anon, authenticated, service_role;
revoke all on private.fair_dice_requests from public, anon, authenticated, service_role;

-- Do not serialize JSONB::text here: its spaces differ from JSON.stringify.
-- Every string is separately JSON-escaped; all context values are restricted
-- ASCII identifiers. This is byte-for-byte the isolated prototype domain.
create or replace function private.system_fair_dice_context(p_request private.fair_dice_requests)
returns text language sql immutable strict set search_path = pg_catalog
as $$
  select '[' || to_json('nardu/system-dice/v1'::text)::text
    || ',' || to_json((p_request).game_id::text)::text
    || ',' || (p_request).nonce::text
    || ',' || to_json((p_request).room_code)::text
    || ',' || to_json((p_request).variant)::text
    || ',' || to_json((p_request).label)::text
    || ',' || to_json((p_request).color)::text
    || ',' || to_json((p_request).position_hash)::text || ']'
$$;
revoke all on function private.system_fair_dice_context(private.fair_dice_requests)
from public, anon, authenticated, service_role;

create or replace function private.system_fair_dice_commitment(p_request private.fair_dice_requests)
returns text language sql immutable strict set search_path = pg_catalog, extensions
as $$
  select encode(extensions.digest(convert_to(
    '[' || to_json('nardu/system-dice-commitment/v1'::text)::text
    || ',' || to_json(private.system_fair_dice_context(p_request))::text
    || ',' || to_json((p_request).private_seed)::text || ']', 'UTF8'), 'sha256'), 'hex')
$$;
revoke all on function private.system_fair_dice_commitment(private.fair_dice_requests)
from public, anon, authenticated, service_role;

create or replace function private.fair_dice_request_json(p_request private.fair_dice_requests)
returns jsonb language sql stable set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'id', (p_request).id, 'roomCode', (p_request).room_code,
    'gameId', (p_request).game_id, 'nonce', (p_request).nonce,
    'label', (p_request).label, 'color', (p_request).color,
    'variant', (p_request).variant,
    'createdAt', to_char((p_request).created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'positionHash', (p_request).position_hash
  ) || case when (p_request).protocol = 'system-csprng-v1'
    then jsonb_build_object('commitment', (p_request).commitment)
    else jsonb_build_object('round', (p_request).round) end
$$;
revoke all on function private.fair_dice_request_json(private.fair_dice_requests)
from public, anon, authenticated, service_role;

-- Independently bind the service-signed request hash to the actual DB receipt.
create or replace function private.system_fair_dice_request_hash(p_request private.fair_dice_requests)
returns text language sql stable strict set search_path = pg_catalog, extensions
as $$
  select encode(extensions.digest(convert_to(
    '[' || to_json('nardu/system-csprng/v1'::text)::text
    || ',' || to_json((p_request).id::text)::text
    || ',' || to_json((p_request).room_code)::text
    || ',' || to_json((p_request).game_id::text)::text
    || ',' || (p_request).nonce::text
    || ',' || to_json((p_request).label)::text
    || ',' || to_json((p_request).color)::text
    || ',' || to_json((p_request).variant)::text
    || ',' || to_json((p_request).commitment)::text
    || ',' || to_json(to_char((p_request).created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    || ',' || to_json((p_request).position_hash)::text || ']', 'UTF8'), 'sha256'), 'hex')
$$;
revoke all on function private.system_fair_dice_request_hash(private.fair_dice_requests)
from public, anon, authenticated, service_role;

-- SQL reproduces HMAC/rejection sampling from counter zero. No supplied dice,
-- counter, blocks, strategy, timestamps, or bot inputs can choose the result.
create or replace function private.system_fair_dice_derived(p_request private.fair_dice_requests)
returns jsonb language plpgsql stable strict set search_path = pg_catalog, extensions
as $$
declare
  context_text text := private.system_fair_dice_context(p_request);
  hash text := private.system_fair_dice_request_hash(p_request);
  counter_value integer; block_value integer; byte_index integer; byte_value integer;
  blocks text[]; physical_dice integer[]; block_bytes bytea; message text; result_input text;
begin
  if p_request.protocol <> 'system-csprng-v1' or p_request.client_seed is null
     or private.system_fair_dice_commitment(p_request) is distinct from p_request.commitment then
    raise exception 'A matching immutable commit/reveal reservation is required.' using errcode = '23514';
  end if;
  for counter_value in 0..1024 loop
    blocks := array[]::text[];
    physical_dice := array[]::integer[];
    for block_value in 0..15 loop
      message := '[' || to_json('nardu/system-dice-hmac/v1'::text)::text
        || ',' || to_json(context_text)::text || ',' || to_json(p_request.client_seed)::text
        || ',' || counter_value::text || ',' || block_value::text || ']';
      block_bytes := extensions.hmac(convert_to(message, 'UTF8'), decode(p_request.private_seed, 'hex'), 'sha256');
      blocks := array_append(blocks, encode(block_bytes, 'hex'));
      for byte_index in 0..31 loop
        byte_value := get_byte(block_bytes, byte_index);
        if byte_value < 252 then physical_dice := array_append(physical_dice, (byte_value % 6) + 1); end if;
        exit when cardinality(physical_dice) = 2;
      end loop;
      exit when cardinality(physical_dice) = 2;
    end loop;
    if cardinality(physical_dice) <> 2 then
      raise exception 'Deterministic dice stream exhausted.' using errcode = '23514';
    end if;
    if p_request.label = 'opening' and physical_dice[1] = physical_dice[2] then continue; end if;
    result_input := '[' || to_json('nardu/system-csprng-result/v1'::text)::text
      || ',' || to_json(hash)::text || ',' || to_json(p_request.private_seed)::text
      || ',' || to_json(p_request.client_seed)::text || ',' || counter_value::text
      || ',' || array_to_json(blocks)::text || ',' || array_to_json(physical_dice)::text || ']';
    return jsonb_build_object('counter', counter_value, 'blocks', to_jsonb(blocks),
      'dice', to_jsonb(physical_dice), 'sha256Input', result_input,
      'sha256', encode(extensions.digest(convert_to(result_input, 'UTF8'), 'sha256'), 'hex'));
  end loop;
  raise exception 'Deterministic opening counter exhausted.' using errcode = '23514';
end;
$$;
revoke all on function private.system_fair_dice_derived(private.fair_dice_requests)
from public, anon, authenticated, service_role;

create or replace function public.guard_authoritative_fair_dice_room()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
declare
  has_capability boolean := coalesce(auth.role(), '') = 'service_role'
    and current_setting('nardu.fair_dice_commit_room', true) = new.id::text;
  has_reset_capability boolean := coalesce(auth.role(), '') = 'service_role'
    and current_setting('nardu.fair_dice_reset_room', true) = new.id::text;
  has_presence_capability boolean := coalesce(auth.role(), '') in ('anon', 'authenticated')
    and current_setting('nardu.fair_dice_presence_room', true) = new.id::text;
  legitimate_join boolean := false;
  is_operator boolean := auth.role() = 'service_role'
    or (auth.role() = 'authenticated' and public.is_admin_user());
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  client_info text;
begin
  if tg_op = 'INSERT' then
    -- Supplied timestamps/flags cannot avoid activation or pick an epoch.
    select enabled, protocol into new.fair_dice_required, new.fair_dice_protocol from private.fair_dice_settings where singleton;
    new.fair_dice_game_id := gen_random_uuid();
    if new.fair_dice_required then
      -- Compatibility, not authentication: stale browser builds cannot create
      -- protected rooms that their legacy dice controller cannot play.
      client_info := coalesce(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb->>'x-client-info', '');
      if (new.fair_dice_protocol = 'drand-quicknet-v1' and client_info !~ '(^|[[:space:]])nardu-fair-dice-v36([[:space:]]|$)')
         or (new.fair_dice_protocol = 'system-csprng-v1' and client_info !~ '(^|[[:space:]])nardu-fair-dice-v37([[:space:]]|$)') then
        raise exception 'Обновите страницу: для новой игры требуется новая версия подтверждённых бросков.' using errcode = '22023';
      end if;
      new.created_at := clock_timestamp();
      new.joined_at := case when new.status = 'joined' then clock_timestamp() else null end;
      new.presence := jsonb_build_object('white', jsonb_build_object('name', new.host_name, 'lastSeen', now_ms));
      new.left_players := '{}'::jsonb;
      if not coalesce(private.fair_dice_clean_initial_state(new.game_state, new.variant), false)
         or (new.game_state is not null and new.game_state->>'roomCode' is distinct from new.code)
         or new.game_version <> 0 then
        raise exception 'Fair-dice rooms require a clean initial state.' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if new.fair_dice_protocol is distinct from old.fair_dice_protocol
     or new.fair_dice_required is distinct from old.fair_dice_required
     or (new.fair_dice_game_id is distinct from old.fair_dice_game_id
         and not coalesce(has_reset_capability, false)) then
    raise exception 'Fair-dice policy and game epoch are immutable.' using errcode = '42501';
  end if;
  if not old.fair_dice_required then return new; end if;
  legitimate_join := old.status = 'waiting' and new.status = 'joined'
    and old.guest_user_id is null and old.guest_guest_id is null
    and (new.guest_user_id is not null or new.guest_guest_id is not null)
    and new.game_state is not distinct from old.game_state;
  if not coalesce(is_operator, false) and (
       new.host_user_id is distinct from old.host_user_id
       or new.host_guest_id is distinct from old.host_guest_id
       or (not legitimate_join and (new.guest_user_id is distinct from old.guest_user_id
           or new.guest_guest_id is distinct from old.guest_guest_id))) then
    raise exception 'Authoritative room participant seats are immutable.' using errcode = '42501';
  end if;
  if legitimate_join then
    -- Existing joinRoom writes a client-made empty presence object. Ignore it
    -- rather than rejecting a legitimate join, and start only the new seat.
    new.presence := coalesce(old.presence, '{}'::jsonb) || jsonb_build_object('dark',
      jsonb_build_object('name', new.guest_name, 'lastSeen', now_ms));
    new.left_players := old.left_players;
    new.joined_at := clock_timestamp();
  end if;
  if not legitimate_join and new.joined_at is distinct from old.joined_at
     and not coalesce(has_capability or has_reset_capability, false) then
    raise exception 'Fair-dice join time is server-derived.' using errcode = '42501';
  end if;
  if not legitimate_join and not coalesce(has_capability or has_reset_capability, false)
     and ((new.presence is distinct from old.presence and not coalesce(has_presence_capability, false))
          or new.left_players is distinct from old.left_players) then
    raise exception 'Fair-dice presence must be refreshed by its authenticated server RPC.' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.code is distinct from old.code
     or new.variant is distinct from old.variant or new.created_at is distinct from old.created_at then
    raise exception 'Fair-dice room identity is immutable.' using errcode = '42501';
  end if;
  if new.game_state is distinct from old.game_state
     and not coalesce(has_capability or has_reset_capability, false) then
    raise exception 'Fair-dice game state must be committed by the authoritative service.' using errcode = '42501';
  end if;
  if not coalesce(has_capability or has_reset_capability, false)
     and new.game_version is distinct from old.game_version
     and not (new.status = 'closed' and old.status in ('waiting', 'joined', 'over')
              and new.game_version = old.game_version + 1) then
    raise exception 'Fair-dice game version requires an authoritative commit.' using errcode = '42501';
  end if;
  -- Normal joins, presence and owner-only closing RPCs do not modify the board.
  -- A client must not hide a completed game, revive a room or declare a result.
  if not coalesce(has_capability or has_reset_capability, false) and new.status is distinct from old.status then
    if not ((old.status = 'waiting' and new.status = 'joined'
             and (new.guest_user_id is not null or new.guest_guest_id is not null))
            or (new.status = 'closed' and old.status in ('waiting', 'over'))
            or (new.status = 'closed' and old.status = 'joined'
                and ((auth.role() = 'authenticated' and public.is_admin_user())
                     or not exists(select 1 from private.fair_dice_requests
                       where room_id = old.id and game_id = old.fair_dice_game_id)))) then
      raise exception 'Fair-dice status transition requires authoritative play.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_authoritative_fair_dice_room() from public, anon, authenticated, service_role;

create or replace function public.configure_fair_dice_protocol(p_protocol text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, private, auth
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service-role authentication is required.' using errcode = '42501';
  end if;
  if p_protocol is null or p_protocol not in ('drand-quicknet-v1', 'system-csprng-v1') then
    raise exception 'A supported fair-dice protocol is required.' using errcode = '22023';
  end if;
  -- New INSERTs only: never mutate existing policy or in-flight commitments.
  update private.fair_dice_settings set protocol = p_protocol where singleton;
  return jsonb_build_object('enabled', (select enabled from private.fair_dice_settings where singleton), 'protocol', p_protocol);
end;
$$;
revoke all on function public.configure_fair_dice_protocol(text) from public, anon, authenticated, service_role;
grant execute on function public.configure_fair_dice_protocol(text) to service_role;

create or replace function public.get_fair_dice_policy()
returns jsonb language sql stable security definer set search_path = pg_catalog, private
as $$
  select jsonb_build_object('enabled', enabled, 'protocol', protocol) from private.fair_dice_settings where singleton
$$;
revoke all on function public.get_fair_dice_policy() from public, anon, authenticated, service_role;
grant execute on function public.get_fair_dice_policy() to anon, authenticated, service_role;

create or replace function public.get_fair_dice_room(p_room_code text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, private, auth
as $$
declare target public.rooms%rowtype; actor jsonb; pending private.fair_dice_requests%rowtype;
begin
  select * into target from public.rooms where code = upper(trim(p_room_code));
  if not found then raise exception 'Room not found.' using errcode = 'P0002'; end if;
  actor := private.fair_dice_actor(target);
  select * into pending from private.fair_dice_requests
  where room_id = target.id and game_id = target.fair_dice_game_id
    and consumed_at is null and cancelled_at is null;
  return jsonb_build_object(
    'id', target.id, 'code', target.code, 'roomCode', target.code,
    'variant', target.variant, 'status', target.status,
    'state', target.game_state, 'version', target.game_version,
    'fairDiceRequired', target.fair_dice_required, 'fairDiceProtocol', target.fair_dice_protocol, 'gameId', target.fair_dice_game_id,
    'positionHash', private.fair_dice_position_hash(target.game_state),
    'serverPositionHash', private.fair_dice_position_hash(target.game_state),
    'presence', target.presence, 'leftPlayers', target.left_players,
    'serverNowMs', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    'joinedAt', target.joined_at, 'createdAt', target.created_at,
    'pending', case when pending.id is null then null else jsonb_build_object(
      'request', private.fair_dice_request_json(pending), 'proof', pending.proof, 'consumed', false,
      'protocol', pending.protocol, 'clientSeed', pending.client_seed
    ) end,
    'actor', actor
  );
end;
$$;
revoke all on function public.get_fair_dice_room(text) from public, anon, authenticated, service_role;
grant execute on function public.get_fair_dice_room(text) to anon, authenticated;

create or replace function public.reserve_fair_dice(
  p_room_code text, p_label text, p_color text, p_position_hash text default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
declare
  target public.rooms%rowtype; actor jsonb; pending private.fair_dice_requests%rowtype;
  expected_label text; expected_color text; locked_hash text; now_at timestamptz;
  next_nonce bigint; target_round bigint;
begin
  select * into target from public.rooms where code = upper(trim(p_room_code)) for update;
  if not found then raise exception 'Room not found.' using errcode = 'P0002'; end if;
  actor := private.fair_dice_actor(target);
  if not target.fair_dice_required then raise exception 'Room uses the legacy dice policy.' using errcode = '55000'; end if;
  if target.status <> 'joined' or target.game_state is null
     or coalesce(target.game_state->>'winner', '') <> '' then
    raise exception 'Room has no active authoritative game.' using errcode = '55000';
  end if;
  expected_label := case target.game_state->>'phase' when 'opening' then 'opening' when 'roll' then 'roll' else null end;
  expected_color := case when expected_label = 'opening' then 'none' else target.game_state->>'turn' end;
  if expected_label is null or expected_color is null or expected_color not in ('none', 'white', 'dark')
     or p_label is distinct from expected_label or p_color is distinct from expected_color then
    raise exception 'Roll intent does not match the authoritative phase and turn.' using errcode = '22023';
  end if;
  if (expected_label = 'opening' and not (actor->>'ownsHost')::boolean)
     or (expected_label = 'roll' and not ((actor->>'bot')::boolean and (actor->>'ownsHost')::boolean)
         and actor->>'actorColor' is distinct from expected_color) then
    raise exception 'Only the active actor may reserve this roll.' using errcode = '42501';
  end if;
  locked_hash := private.fair_dice_position_hash(target.game_state);
  -- p_position_hash is a compatibility-only expectation. It never selects the
  -- commitment: the returned receipt always uses the locked database state.
  select * into pending from private.fair_dice_requests
  where room_id = target.id and game_id = target.fair_dice_game_id
    and consumed_at is null and cancelled_at is null for update;
  if found then
    if pending.label <> expected_label or pending.color <> expected_color or pending.position_hash <> locked_hash then
      raise exception 'An outstanding roll locks this position.' using errcode = '55000';
    end if;
    return private.fair_dice_request_json(pending);
  end if;
  select coalesce(max(nonce), 0) + 1 into next_nonce from private.fair_dice_requests
  where room_id = target.id and game_id = target.fair_dice_game_id;
  now_at := clock_timestamp();
  -- Quicknet genesis/period. Reserve at least six seconds ahead of DB time;
  -- add one because drand round 1 is at genesis, not one period after it.
  if target.fair_dice_protocol = 'system-csprng-v1' then
    -- Generate exactly once under the room lock, before returning any commitment.
    -- A browser seed is accepted only by a later privileged, context-bound RPC.
    pending.room_id := target.id;
    pending.room_code := target.code;
    pending.game_id := target.fair_dice_game_id;
    pending.nonce := next_nonce;
    pending.label := expected_label;
    pending.color := expected_color;
    pending.variant := target.variant;
    pending.created_at := now_at;
    pending.position_hash := locked_hash;
    pending.private_seed := encode(extensions.gen_random_bytes(32), 'hex');
    pending.commitment := private.system_fair_dice_commitment(pending);
    insert into private.fair_dice_requests(room_id, room_code, game_id, nonce, label, color,
      variant, round, created_at, position_hash, protocol, private_seed, commitment)
    values(target.id, target.code, target.fair_dice_game_id, next_nonce, expected_label,
      expected_color, target.variant, null, now_at, locked_hash, 'system-csprng-v1',
      pending.private_seed, pending.commitment) returning * into pending;
    return private.fair_dice_request_json(pending);
  end if;
  target_round := ceil((extract(epoch from now_at) + 6 - 1692803367) / 3)::bigint + 1;
  insert into private.fair_dice_requests(room_id, room_code, game_id, nonce, label, color, variant, round, created_at, position_hash)
  values(target.id, target.code, target.fair_dice_game_id, next_nonce, expected_label, expected_color, target.variant, target_round, now_at, locked_hash)
  returning * into pending;
  return private.fair_dice_request_json(pending);
end;
$$;
revoke all on function public.reserve_fair_dice(text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.reserve_fair_dice(text, text, text, text) to anon, authenticated;

create or replace function public.get_fair_dice_request(p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, auth
as $$
declare target private.fair_dice_requests%rowtype; result jsonb;
begin
  select * into target from private.fair_dice_requests where id = p_request_id;
  if not found then raise exception 'Dice request not found.' using errcode = 'P0002'; end if;
  result := jsonb_build_object('request', private.fair_dice_request_json(target), 'proof', target.proof,
    'consumed', target.consumed_at is not null, 'cancelled', target.cancelled_at is not null,
    'protocol', target.protocol, 'clientSeed', target.client_seed);
  -- Unrevealed server entropy is private; browser/public receipts NEVER carry it.
  if coalesce(auth.role(), '') = 'service_role' and target.protocol = 'system-csprng-v1' then
    result := result || jsonb_build_object('privateSeed', target.private_seed);
  end if;
  return result;
end;
$$;
revoke all on function public.get_fair_dice_request(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_fair_dice_request(uuid) to anon, authenticated, service_role;

create or replace function public.accept_system_fair_dice_client_seed(
  p_request_id uuid, p_client_seed text, p_room_code text, p_game_id uuid, p_position_hash text
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, private, auth
as $$
declare room public.rooms%rowtype; target private.fair_dice_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service-role authentication is required.' using errcode = '42501';
  end if;
  if p_client_seed is null or p_client_seed !~ '^[0-9a-f]{64}$'
     or p_room_code is null or p_game_id is null or p_position_hash is null
     or p_position_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A complete context and 32-byte client seed are required.' using errcode = '22023';
  end if;
  -- Match reserve/commitState lock order: room first, then the request.
  select r.* into room from public.rooms r
    join private.fair_dice_requests q on q.room_id = r.id
    where q.id = p_request_id for update of r;
  if not found then raise exception 'Active dice room not found.' using errcode = 'P0002'; end if;
  select * into target from private.fair_dice_requests where id = p_request_id for update;
  if target.protocol <> 'system-csprng-v1' or room.fair_dice_protocol <> target.protocol
     or not room.fair_dice_required or room.status <> 'joined'
     or target.cancelled_at is not null or target.consumed_at is not null
     or room.fair_dice_game_id is distinct from target.game_id
     or room.code is distinct from p_room_code or target.game_id is distinct from p_game_id
     or target.position_hash is distinct from p_position_hash
     or private.fair_dice_position_hash(room.game_state) is distinct from target.position_hash
     or (target.label = 'opening' and (room.game_state->>'phase' is distinct from 'opening' or target.color <> 'none'))
     or (target.label = 'roll' and (room.game_state->>'phase' is distinct from 'roll'
         or room.game_state->>'turn' is distinct from target.color)) then
    raise exception 'The client seed does not match the active immutable reservation.' using errcode = '23514';
  end if;
  if target.client_seed is not null then
    if target.client_seed is distinct from p_client_seed then
      raise exception 'The first accepted client seed is immutable.' using errcode = '23505';
    end if;
    return public.get_fair_dice_request(target.id);
  end if;
  -- Persist before disclosure/proof construction. A timeout retries this exact
  -- request and seed; it never chooses another server seed or client challenge.
  update private.fair_dice_requests set client_seed = p_client_seed, client_seed_at = clock_timestamp()
    where id = target.id;
  return public.get_fair_dice_request(target.id);
end;
$$;
revoke all on function public.accept_system_fair_dice_client_seed(uuid, text, text, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.accept_system_fair_dice_client_seed(uuid, text, text, uuid, text) to service_role;

create or replace function public.list_pending_fair_dice_requests()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, private, auth
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service-role authentication is required.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('request', pending.receipt,
    'proof', null, 'consumed', false, 'cancelled', false,
    'protocol', pending.protocol, 'clientSeed', pending.client_seed) order by pending.created_at)
    from (select private.fair_dice_request_json(requests) as receipt, requests.created_at, requests.protocol, requests.client_seed
      from private.fair_dice_requests requests join public.rooms room on room.id = requests.room_id
      where requests.proof is null and requests.consumed_at is null and requests.cancelled_at is null
        and room.fair_dice_required and room.status = 'joined' and room.fair_dice_game_id = requests.game_id
      order by requests.created_at limit 100) pending), '[]'::jsonb);
end;
$$;
revoke all on function public.list_pending_fair_dice_requests() from public, anon, authenticated, service_role;
grant execute on function public.list_pending_fair_dice_requests() to service_role;

create or replace function public.commit_fair_dice_proof(p_request_id uuid, p_proof jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
declare target private.fair_dice_requests%rowtype; derived jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service-role authentication is required.' using errcode = '42501';
  end if;
  select * into target from private.fair_dice_requests where id = p_request_id for update;
  if not found then raise exception 'Dice request not found.' using errcode = 'P0002'; end if;
  if target.cancelled_at is not null then raise exception 'Dice request was cancelled by a terminal result.' using errcode = '55000'; end if;
  if target.protocol = 'drand-quicknet-v1' then
    if jsonb_typeof(p_proof) is distinct from 'object'
       or p_proof->>'protocol' is distinct from 'drand-quicknet-v1'
       or p_proof->'request' is distinct from private.fair_dice_request_json(target)
       or coalesce(p_proof->>'requestHash', '') !~ '^[0-9a-f]{64}$'
       or coalesce(p_proof->>'receiptSignature', '') !~ '^[0-9a-f]{128}$'
       or coalesce(p_proof->>'chainHash', '') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(p_proof->'beacon') is distinct from 'object'
       or p_proof#>'{beacon,round}' is distinct from to_jsonb(target.round)
       or coalesce(p_proof#>>'{beacon,signature}', '') !~ '^[0-9a-f]{96}$'
       or coalesce(p_proof#>>'{beacon,randomness}', '') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(p_proof->'sha256Input') is distinct from 'string'
       or coalesce(p_proof->>'sha256', '') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(p_proof->'dice') is distinct from 'array'
       or jsonb_typeof(p_proof->'rerolls') is distinct from 'number'
       or coalesce(p_proof->>'rerolls', '') !~ '^[0-9]+$' then
      raise exception 'Proof does not match the immutable dice reservation.' using errcode = '23514';
    end if;
  else
    if target.protocol <> 'system-csprng-v1' or target.client_seed is null then
      raise exception 'A persisted client challenge is required before revealing the server seed.' using errcode = '23514';
    end if;
    derived := private.system_fair_dice_derived(target);
    if jsonb_typeof(p_proof) is distinct from 'object'
       or p_proof - array['protocol','request','requestHash','receiptSignature','commitReveal','dice','sha256','sha256Input','rerolls'] is distinct from '{}'::jsonb
       or p_proof->>'protocol' is distinct from target.protocol
       or p_proof->'request' is distinct from private.fair_dice_request_json(target)
       or p_proof->>'requestHash' is distinct from private.system_fair_dice_request_hash(target)
       or coalesce(p_proof->>'receiptSignature', '') !~ '^[0-9a-f]{128}$'
       or p_proof->'commitReveal' is distinct from jsonb_build_object(
         'serverSeed', target.private_seed, 'clientSeed', target.client_seed,
         'counter', derived->'counter', 'blocks', derived->'blocks')
       or p_proof->'dice' is distinct from derived->'dice'
       or p_proof->'rerolls' is distinct from derived->'counter'
       or p_proof->>'sha256Input' is distinct from derived->>'sha256Input'
       or p_proof->>'sha256' is distinct from derived->>'sha256' then
      raise exception 'Proof does not match the immutable system commit/reveal reservation.' using errcode = '23514';
    end if;
  end if;
  if jsonb_array_length(p_proof->'dice') <> 2
     or jsonb_typeof(p_proof#>'{dice,0}') is distinct from 'number'
     or jsonb_typeof(p_proof#>'{dice,1}') is distinct from 'number'
     or coalesce(p_proof#>>'{dice,0}', '') !~ '^[1-6]$'
     or coalesce(p_proof#>>'{dice,1}', '') !~ '^[1-6]$'
     or (target.label = 'opening' and p_proof#>'{dice,0}' = p_proof#>'{dice,1}') then
    raise exception 'Proof contains invalid physical dice.' using errcode = '23514';
  end if;
  if encode(extensions.digest(convert_to(p_proof->>'sha256Input', 'UTF8'), 'sha256'), 'hex')
        is distinct from p_proof->>'sha256' then
    raise exception 'Proof preimage does not match SHA-256.' using errcode = '23514';
  end if;
  if target.proof is not null then
    if target.proof is distinct from p_proof then raise exception 'Dice proof is immutable.' using errcode = '23505'; end if;
    return target.proof;
  end if;
  -- The trusted coordinator verifies Ed25519 for both protocols and BLS for
  -- drand before this privileged operation. System HMAC/context is also replayed
  -- above independently; SQL never claims independent-source entropy.
  update private.fair_dice_requests set proof = p_proof, completed_at = clock_timestamp() where id = target.id;
  return p_proof;
end;
$$;
revoke all on function public.commit_fair_dice_proof(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.commit_fair_dice_proof(uuid, jsonb) to service_role;

-- v36 commit_fair_dice_state, reset_fair_dice_game, closing, deletion and presence
-- capabilities remain unchanged. Their physical dice/history/CAS contracts apply
-- to both protocols and never discard a failed or pending commitment.
notify pgrst, 'reload schema';
commit;
