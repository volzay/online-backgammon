begin;

-- Install while disabled, then activate only after the authoritative service
-- and the matching frontend are live. Existing rooms remain on their policy.
create schema if not exists private;

create table if not exists private.fair_dice_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false
);
insert into private.fair_dice_settings(singleton, enabled)
values (true, false) on conflict (singleton) do nothing;
revoke all on private.fair_dice_settings from public, anon, authenticated, service_role;

alter table public.rooms add column if not exists fair_dice_required boolean not null default false;
alter table public.rooms add column if not exists fair_dice_game_id uuid not null default gen_random_uuid();

create table if not exists private.fair_dice_requests (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms(id) on delete set null,
  room_code text not null,
  game_id uuid not null,
  nonce bigint not null check (nonce > 0),
  label text not null check (label in ('opening', 'roll')),
  color text not null check (color in ('none', 'white', 'dark')),
  variant text not null check (variant in ('long', 'short')),
  round bigint not null check (round > 0),
  created_at timestamptz not null,
  position_hash text not null check (position_hash ~ '^[0-9a-f]{64}$'),
  proof jsonb,
  completed_at timestamptz,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  unique(room_id, game_id, nonce),
  check ((proof is null) = (completed_at is null)),
  check (consumed_at is null or proof is not null)
);
alter table private.fair_dice_requests add column if not exists cancelled_at timestamptz;
alter table private.fair_dice_requests alter column room_id drop not null;
alter table private.fair_dice_requests drop constraint if exists fair_dice_requests_room_id_fkey;
alter table private.fair_dice_requests add constraint fair_dice_requests_room_id_fkey
foreign key(room_id) references public.rooms(id) on delete set null;
drop index if exists private.fair_dice_one_outstanding_request;
create unique index fair_dice_one_outstanding_request
on private.fair_dice_requests(room_id, game_id) where consumed_at is null and cancelled_at is null;
revoke all on private.fair_dice_requests from public, anon, authenticated, service_role;

-- This server-side canonical JSONB hash is an opaque position commitment.
-- Neither a client-supplied digest nor a browser's JSON serialization chooses it.
create or replace function private.fair_dice_position_hash(p_state jsonb)
returns text language sql immutable strict
set search_path = pg_catalog, extensions
as $$
  select encode(extensions.digest(convert_to(p_state::text, 'UTF8'), 'sha256'), 'hex')
$$;
revoke all on function private.fair_dice_position_hash(jsonb)
from public, anon, authenticated, service_role;

create or replace function private.fair_dice_request_json(p_request private.fair_dice_requests)
returns jsonb language sql stable
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'id', (p_request).id, 'roomCode', (p_request).room_code,
    'gameId', (p_request).game_id, 'nonce', (p_request).nonce,
    'label', (p_request).label, 'color', (p_request).color,
    'variant', (p_request).variant, 'round', (p_request).round,
    'createdAt', to_char((p_request).created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'positionHash', (p_request).position_hash
  )
$$;
revoke all on function private.fair_dice_request_json(private.fair_dice_requests)
from public, anon, authenticated, service_role;

create or replace function private.fair_dice_actor(p_room public.rooms)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, auth
as $$
declare
  player_id uuid := case when auth.role() = 'authenticated' then auth.uid() else null end;
  guest_id text := case when auth.role() = 'anon' then public.request_guest_identity() else null end;
  owns_host boolean;
  owns_guest boolean;
  is_bot boolean;
  seat_color text;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    raise exception 'Player authentication is required.' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' and (player_id is null
     or not exists(select 1 from public.profiles profile where profile.id = player_id and profile.banned_at is null)) then
    raise exception 'An active registered player profile is required.' using errcode = '42501';
  end if;
  owns_host := (player_id is not null and p_room.host_user_id = player_id)
    or (guest_id is not null and p_room.host_guest_id = guest_id);
  owns_guest := (player_id is not null and p_room.guest_user_id = player_id)
    or (guest_id is not null and p_room.guest_guest_id = guest_id);
  if not coalesce(owns_host, false) and not coalesce(owns_guest, false) then
    raise exception 'Only room players may access authoritative play.' using errcode = '42501';
  end if;
  seat_color := case when owns_host then 'white' else 'dark' end;
  is_bot := p_room.guest_user_id is null and p_room.guest_guest_id is null
    and coalesce(p_room.game_state->>'mode', p_room.game_state#>>'{analysis,mode}', '') = 'bot';
  return jsonb_build_object(
    'ownsHost', coalesce(owns_host, false),
    'seatColor', seat_color,
    'actorColor', case when is_bot and owns_host and p_room.game_state#>>'{analysis,playerColor}' = 'dark'
      then 'dark' else seat_color end,
    'guest', player_id is null,
    'bot', is_bot
  );
end;
$$;
revoke all on function private.fair_dice_actor(public.rooms)
from public, anon, authenticated, service_role;

create or replace function private.fair_dice_clean_initial_state(p_state jsonb, p_variant text)
returns boolean language sql immutable
set search_path = pg_catalog
as $$
  select p_state is null or (
    jsonb_typeof(p_state) = 'object'
    and p_state->>'variant' = p_variant
    and p_state->>'phase' in ('opening', 'waiting')
    and coalesce(p_state->'winner', 'null'::jsonb) = 'null'::jsonb
    and coalesce(p_state->'turn', 'null'::jsonb) = 'null'::jsonb
    and p_state->'dice' = '[]'::jsonb and p_state->'rolled' = '[]'::jsonb
    and p_state->'off' = '{"white":0,"dark":0}'::jsonb
    and p_state->'bar' = '{"white":0,"dark":0}'::jsonb
    and p_state->'score' = '{"white":0,"dark":0}'::jsonb
    and coalesce(p_state->'openingRoll', 'null'::jsonb) = 'null'::jsonb
    and p_state->'history' = '[]'::jsonb
    and p_state->'turnMoves' = '[]'::jsonb
    and p_state->'firstMoveDone' = '{"white":false,"dark":false}'::jsonb
    and p_state->'headPlayedThisTurn' = '{"white":false,"dark":false}'::jsonb
    and coalesce(p_state->'finishedAt', 'null'::jsonb) = 'null'::jsonb
    and coalesce(p_state->'resultType', 'null'::jsonb) = 'null'::jsonb
    and p_state->'points' = case when p_variant = 'short' then
      '{"24":{"color":"white","count":2},"13":{"color":"white","count":5},"8":{"color":"white","count":3},"6":{"color":"white","count":5},"1":{"color":"dark","count":2},"12":{"color":"dark","count":5},"17":{"color":"dark","count":3},"19":{"color":"dark","count":5}}'::jsonb
      else '{"24":{"color":"white","count":15},"12":{"color":"dark","count":15}}'::jsonb end
  )
$$;
revoke all on function private.fair_dice_clean_initial_state(jsonb, text)
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
    select enabled into new.fair_dice_required from private.fair_dice_settings where singleton;
    new.fair_dice_game_id := gen_random_uuid();
    if new.fair_dice_required then
      -- Compatibility, not authentication: stale browser builds cannot create
      -- protected rooms that their legacy dice controller cannot play.
      client_info := coalesce(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb->>'x-client-info', '');
      if client_info !~ '(^|[[:space:]])nardu-fair-dice-v36([[:space:]]|$)' then
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
  if new.fair_dice_required is distinct from old.fair_dice_required
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
revoke all on function public.guard_authoritative_fair_dice_room()
from public, anon, authenticated, service_role;
drop trigger if exists a_fair_dice_authoritative_room_guard on public.rooms;
create trigger a_fair_dice_authoritative_room_guard before insert or update on public.rooms
for each row execute function public.guard_authoritative_fair_dice_room();

create or replace function public.guard_fair_dice_room_deletion()
returns trigger language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
declare
  is_operator boolean := auth.role() = 'service_role'
    or (auth.role() = 'authenticated' and public.is_admin_user());
begin
  if not old.fair_dice_required then return old; end if;
  if not coalesce(is_operator, false) and old.status not in ('over', 'closed')
     and exists(select 1 from private.fair_dice_requests where room_id = old.id) then
    raise exception 'An active fair-dice room must finish before it can be deleted.' using errcode = '42501';
  end if;
  -- Account/room deletion does not erase public cryptographic evidence.
  -- The FK only clears the operational room reference after this trigger.
  update private.fair_dice_requests set cancelled_at = clock_timestamp()
  where room_id = old.id and consumed_at is null and cancelled_at is null;
  return old;
end;
$$;
revoke all on function public.guard_fair_dice_room_deletion() from public, anon, authenticated, service_role;
drop trigger if exists a_fair_dice_room_deletion_guard on public.rooms;
create trigger a_fair_dice_room_deletion_guard before delete on public.rooms
for each row execute function public.guard_fair_dice_room_deletion();

create or replace function public.configure_fair_dice_policy(p_enabled boolean)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service-role authentication is required.' using errcode = '42501';
  end if;
  if p_enabled is null then raise exception 'A boolean policy is required.' using errcode = '22023'; end if;
  update private.fair_dice_settings set enabled = p_enabled where singleton;
  return jsonb_build_object('enabled', p_enabled);
end;
$$;
revoke all on function public.configure_fair_dice_policy(boolean) from public, anon, authenticated, service_role;
grant execute on function public.configure_fair_dice_policy(boolean) to service_role;

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
    'fairDiceRequired', target.fair_dice_required, 'gameId', target.fair_dice_game_id,
    'positionHash', private.fair_dice_position_hash(target.game_state),
    'serverPositionHash', private.fair_dice_position_hash(target.game_state),
    'presence', target.presence, 'leftPlayers', target.left_players,
    'serverNowMs', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    'joinedAt', target.joined_at, 'createdAt', target.created_at,
    'pending', case when pending.id is null then null else jsonb_build_object(
      'request', private.fair_dice_request_json(pending), 'proof', pending.proof, 'consumed', false
    ) end,
    'actor', actor
  );
end;
$$;
revoke all on function public.get_fair_dice_room(text) from public, anon, authenticated, service_role;
grant execute on function public.get_fair_dice_room(text) to anon, authenticated;

create or replace function public.touch_fair_dice_presence(p_room_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
declare target public.rooms%rowtype; actor jsonb; seat text; now_ms bigint;
begin
  select * into target from public.rooms where code = upper(trim(p_room_code)) for update;
  if not found then raise exception 'Room not found.' using errcode = 'P0002'; end if;
  actor := private.fair_dice_actor(target);
  if not target.fair_dice_required then raise exception 'Room uses legacy presence.' using errcode = '55000'; end if;
  if target.status in ('waiting', 'joined') then
    seat := actor->>'seatColor';
    now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
    perform set_config('nardu.fair_dice_presence_room', target.id::text, true);
    update public.rooms set presence = jsonb_set(coalesce(target.presence, '{}'::jsonb), array[seat],
      jsonb_build_object('name', case when seat = 'white' then target.host_name else target.guest_name end,
        'lastSeen', now_ms, 'disconnectedAt', null, 'deadlineAt', null), true)
    where id = target.id;
    perform set_config('nardu.fair_dice_presence_room', '', true);
  end if;
  return public.get_fair_dice_room(target.code);
end;
$$;
revoke all on function public.touch_fair_dice_presence(text) from public, anon, authenticated, service_role;
grant execute on function public.touch_fair_dice_presence(text) to anon, authenticated;

create or replace function public.close_fair_dice_waiting_room(p_room_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
declare target public.rooms%rowtype; actor jsonb;
begin
  select * into target from public.rooms where code = upper(trim(p_room_code)) for update;
  if not found then raise exception 'Room not found.' using errcode = 'P0002'; end if;
  actor := private.fair_dice_actor(target);
  if not (actor->>'ownsHost')::boolean then raise exception 'Only the room owner may close a waiting room.' using errcode = '42501'; end if;
  if not target.fair_dice_required then raise exception 'Room uses the legacy closing protocol.' using errcode = '55000'; end if;
  if target.status = 'closed' then
    return jsonb_build_object('ok',true,'removed',true,'closed',true,'version',target.game_version,'state',target.game_state,'gameId',target.fair_dice_game_id);
  end if;
  if target.status <> 'waiting'
     or not coalesce(private.fair_dice_clean_initial_state(target.game_state, target.variant), false)
     or exists(select 1 from private.fair_dice_requests where room_id = target.id) then
    raise exception 'Only an unstarted waiting room can be closed without a result.' using errcode = '55000';
  end if;
  update public.rooms set status = 'closed', archived_at = clock_timestamp(), closed_reason = 'host_left_waiting' where id = target.id;
  return jsonb_build_object('ok',true,'removed',true,'closed',true,'version',target.game_version,'state',target.game_state,'gameId',target.fair_dice_game_id);
end;
$$;
revoke all on function public.close_fair_dice_waiting_room(text) from public, anon, authenticated, service_role;
grant execute on function public.close_fair_dice_waiting_room(text) to anon, authenticated;

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
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, private
as $$
declare target private.fair_dice_requests%rowtype;
begin
  select * into target from private.fair_dice_requests where id = p_request_id;
  if not found then raise exception 'Dice request not found.' using errcode = 'P0002'; end if;
  -- A receipt contains no account ID, credentials or full game position.
  return jsonb_build_object('request', private.fair_dice_request_json(target), 'proof', target.proof,
    'consumed', target.consumed_at is not null, 'cancelled', target.cancelled_at is not null);
end;
$$;
revoke all on function public.get_fair_dice_request(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_fair_dice_request(uuid) to anon, authenticated, service_role;

create or replace function public.list_pending_fair_dice_requests()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, private, auth
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service-role authentication is required.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('request', pending.receipt,
    'proof', null, 'consumed', false, 'cancelled', false) order by pending.created_at)
    from (select private.fair_dice_request_json(requests) as receipt, requests.created_at
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
declare target private.fair_dice_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service-role authentication is required.' using errcode = '42501';
  end if;
  select * into target from private.fair_dice_requests where id = p_request_id for update;
  if not found then raise exception 'Dice request not found.' using errcode = 'P0002'; end if;
  if target.cancelled_at is not null then raise exception 'Dice request was cancelled by a terminal result.' using errcode = '55000'; end if;
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
  -- The trusted coordinator verifies BLS before this privileged operation.
  update private.fair_dice_requests set proof = p_proof, completed_at = clock_timestamp() where id = target.id;
  return p_proof;
end;
$$;
revoke all on function public.commit_fair_dice_proof(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.commit_fair_dice_proof(uuid, jsonb) to service_role;

create or replace function public.commit_fair_dice_state(
  p_room_code text, p_next_state jsonb, p_expected_version integer, p_request_id uuid default null
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
declare
  target public.rooms%rowtype; outstanding private.fair_dice_requests%rowtype;
  old_rolls jsonb; new_old_rolls jsonb; new_events jsonb;
  issued_roll jsonb; physical_dice jsonb; expected_rolled jsonb; a integer; b integer;
  cancel_pending boolean := false; terminal_event jsonb;
  expired_color text; expired_last_seen bigint; expiry_base bigint; now_ms bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service-role authentication is required.' using errcode = '42501'; end if;
  select * into target from public.rooms where code = upper(trim(p_room_code)) for update;
  if not found then raise exception 'Room not found.' using errcode = 'P0002'; end if;
  if not target.fair_dice_required or target.status not in ('joined', 'over') then raise exception 'Room is not an active fair-dice game.' using errcode = '55000'; end if;
  if target.game_version is distinct from p_expected_version then raise exception 'Game version changed.' using errcode = '40001'; end if;
  if jsonb_typeof(p_next_state) is distinct from 'object'
     or p_next_state->>'roomCode' is distinct from target.code
     or p_next_state->>'variant' is distinct from target.variant
     or jsonb_typeof(p_next_state->'history') is distinct from 'array'
     or (target.game_state is not null and (
       p_next_state->>'mode' is distinct from target.game_state->>'mode'
       or p_next_state->'startedAt' is distinct from target.game_state->'startedAt'
       or p_next_state#>'{analysis,playerColor}' is distinct from target.game_state#>'{analysis,playerColor}'
     )) then raise exception 'Authoritative game identity cannot be changed.' using errcode = '23514'; end if;
  if target.game_state is null and (target.guest_user_id is not null or target.guest_guest_id is not null)
     and p_next_state->>'mode' is distinct from 'remote' then
    raise exception 'A human room must initialize in remote mode.' using errcode = '23514';
  end if;
  if target.status = 'over' and (p_request_id is not null or p_next_state->>'phase' is distinct from 'over'
       or p_next_state->>'winner' is distinct from target.game_state->>'winner'
       or p_next_state->'points' is distinct from target.game_state->'points'
       or p_next_state->'off' is distinct from target.game_state->'off'
       or p_next_state->'bar' is distinct from target.game_state->'bar'
       or p_next_state->'history' is distinct from target.game_state->'history') then
    raise exception 'Completed games permit result metadata only.' using errcode = '23514';
  end if;
  terminal_event := p_next_state#>'{history,0}';
  if target.status = 'joined' and p_next_state->>'phase' = 'over'
     and (terminal_event->'networkLoss' = 'true'::jsonb or terminal_event->'timeout' = 'true'::jsonb) then
    expired_color := terminal_event->>'color';
    if target.game_state->>'mode' = 'bot' or expired_color not in ('white', 'dark')
       or jsonb_typeof(target.presence#>array[expired_color, 'lastSeen']) is distinct from 'number'
       or coalesce(target.presence#>>array[expired_color, 'lastSeen'], '') !~ '^[0-9]+$' then
      raise exception 'Network loss requires trusted human-player presence.' using errcode = '42501';
    end if;
    expired_last_seen := (target.presence#>>array[expired_color, 'lastSeen'])::bigint;
    expiry_base := greatest(expired_last_seen,
      coalesce(floor(extract(epoch from target.joined_at) * 1000)::bigint, 0));
    now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
    if now_ms < expiry_base + 150000 then
      -- Recheck under the row lock: a heartbeat may have raced with the HTTP
      -- coordinator's earlier snapshot without changing game_version.
      raise exception 'Player reconnected before the network-loss commit.' using errcode = '40001';
    end if;
  end if;
  select * into outstanding from private.fair_dice_requests
  where room_id = target.id and game_id = target.fair_dice_game_id
    and consumed_at is null and cancelled_at is null for update;
  if found then
    cancel_pending := p_request_id is null and p_next_state->>'phase' = 'over'
      and p_next_state->>'winner' in ('white', 'dark')
      and (terminal_event->'resign' = 'true'::jsonb or terminal_event->'leave' = 'true'::jsonb
           or terminal_event->'networkLoss' = 'true'::jsonb or terminal_event->'timeout' = 'true'::jsonb)
      and terminal_event->>'color' in ('white', 'dark')
      and terminal_event->>'winnerColor' = p_next_state->>'winner'
      and terminal_event->>'color' <> p_next_state->>'winner'
      and p_next_state->'points' = target.game_state->'points'
      and p_next_state->'off' = target.game_state->'off'
      and p_next_state->'bar' = target.game_state->'bar';
    if not coalesce(cancel_pending, false) then
      if p_request_id is distinct from outstanding.id or outstanding.proof is null
       or private.fair_dice_position_hash(target.game_state) is distinct from outstanding.position_hash then
        raise exception 'An outstanding dice request locks this state.' using errcode = '55000';
      end if;
      select coalesce(jsonb_agg(value), '[]'::jsonb) into new_events
      from jsonb_array_elements(p_next_state->'history')
      where value->'fairDiceProof' = outstanding.proof;
      if jsonb_array_length(new_events) <> 1 then raise exception 'Issued dice proof must appear exactly once in history.' using errcode = '23514'; end if;
      issued_roll := p_next_state#>'{history,0}';
      if issued_roll->>'sha256' is distinct from outstanding.proof->>'sha256'
         or issued_roll->>'sha256Input' is distinct from outstanding.proof->>'sha256Input' then
        raise exception 'Displayed roll hash must match its issued proof.' using errcode = '23514';
      end if;
      if issued_roll->'fairDiceProof' is distinct from outstanding.proof
         or p_next_state->'points' is distinct from target.game_state->'points'
         or p_next_state->'off' is distinct from target.game_state->'off'
         or p_next_state->'bar' is distinct from target.game_state->'bar' then
        raise exception 'Dice issue must prepend its proof without changing the board.' using errcode = '23514';
      end if;
      physical_dice := outstanding.proof->'dice';
      a := (physical_dice->>0)::integer; b := (physical_dice->>1)::integer;
      if outstanding.label = 'opening' then
        if issued_roll->'opening' is distinct from 'true'::jsonb
           or issued_roll->'host' is distinct from to_jsonb(a)
           or issued_roll->'guest' is distinct from to_jsonb(b)
           or p_next_state->>'phase' is distinct from 'opening-result'
           or p_next_state->>'turn' is distinct from (case when a > b then 'white' else 'dark' end)
           or p_next_state->'rolled' is distinct from physical_dice
           or p_next_state->'dice' is distinct from '[]'::jsonb
           or p_next_state#>'{openingRoll,fairDiceProof}' is distinct from outstanding.proof then
          raise exception 'Opening state does not match issued dice.' using errcode = '23514';
        end if;
      else
        expected_rolled := case when a = b then jsonb_build_array(a,a,a,a) else physical_dice end;
        if issued_roll->>'roll' is distinct from a::text || ':' || b::text
           or issued_roll->>'color' is distinct from outstanding.color
           or p_next_state->>'phase' is distinct from 'move'
           or p_next_state->>'turn' is distinct from outstanding.color
           or p_next_state->'rolled' is distinct from expected_rolled
           or p_next_state->'dice' is distinct from expected_rolled then
          raise exception 'Turn state does not match issued dice.' using errcode = '23514';
        end if;
      end if;
    end if;
  elsif p_request_id is not null then
    raise exception 'Dice request is not outstanding.' using errcode = '23514';
  end if;
  -- Preserve all previously issued roll records exactly. The coordinator also
  -- replays moves and validates dice usage before calling this capability.
  select coalesce(jsonb_agg(value order by ord), '[]'::jsonb) into old_rolls
  from jsonb_array_elements(coalesce(target.game_state->'history', '[]'::jsonb)) with ordinality event(value, ord)
  where value ? 'fairDiceProof';
  select coalesce(jsonb_agg(value order by ord), '[]'::jsonb) into new_old_rolls
  from jsonb_array_elements(p_next_state->'history') with ordinality event(value, ord)
  where value ? 'fairDiceProof' and (p_request_id is null or value#>>'{fairDiceProof,request,id}' is distinct from p_request_id::text);
  if old_rolls is distinct from new_old_rolls then raise exception 'Issued roll history cannot be rewritten.' using errcode = '23514'; end if;
  perform set_config('nardu.fair_dice_commit_room', target.id::text, true);
  update public.rooms set game_state = p_next_state, game_version = game_version + 1,
    status = case when p_next_state->>'phase' = 'over' then 'over' else status end,
    archived_at = case when p_next_state->>'phase' = 'over' then clock_timestamp() else archived_at end,
    closed_reason = case when p_next_state->>'phase' = 'over' then 'finished' else closed_reason end
  where id = target.id;
  perform set_config('nardu.fair_dice_commit_room', '', true);
  if outstanding.id is not null then
    if coalesce(cancel_pending, false) then
      -- Cancellation is terminal only; retain the receipt and any issued proof.
      -- It cannot unlock a retry because this room is now over, not joined.
      update private.fair_dice_requests set cancelled_at = clock_timestamp() where id = outstanding.id;
    else
      update private.fair_dice_requests set consumed_at = clock_timestamp() where id = outstanding.id;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'version', target.game_version + 1, 'state', p_next_state);
end;
$$;
revoke all on function public.commit_fair_dice_state(text, jsonb, integer, uuid) from public, anon, authenticated, service_role;
grant execute on function public.commit_fair_dice_state(text, jsonb, integer, uuid) to service_role;

create or replace function public.reset_fair_dice_game(
  p_room_code text, p_initial_state jsonb, p_expected_version integer
)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, private, auth
as $$
declare target public.rooms%rowtype; next_game_id uuid := gen_random_uuid();
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Service-role authentication is required.' using errcode = '42501'; end if;
  select * into target from public.rooms where code = upper(trim(p_room_code)) for update;
  if not found then raise exception 'Room not found.' using errcode = 'P0002'; end if;
  if not target.fair_dice_required or target.status <> 'over'
     or target.game_state->>'phase' is distinct from 'over'
     or coalesce(target.game_state->>'winner', '') not in ('white', 'dark') then
    raise exception 'Only a completed authoritative game can be reset.' using errcode = '55000';
  end if;
  if target.game_version is distinct from p_expected_version then raise exception 'Game version changed.' using errcode = '40001'; end if;
  if p_initial_state is null or not coalesce(private.fair_dice_clean_initial_state(p_initial_state, target.variant), false)
     or p_initial_state->>'phase' is distinct from 'opening'
     or p_initial_state->>'roomCode' is distinct from target.code
     or p_initial_state->>'mode' is distinct from target.game_state->>'mode' then
    raise exception 'Rematch requires a clean initial state of the same game type.' using errcode = '23514';
  end if;
  perform set_config('nardu.fair_dice_reset_room', target.id::text, true);
  update public.rooms set fair_dice_game_id = next_game_id, game_state = p_initial_state,
    game_version = game_version + 1, status = 'joined', joined_at = clock_timestamp(), archived_at = null, closed_reason = null
  where id = target.id;
  perform set_config('nardu.fair_dice_reset_room', '', true);
  return jsonb_build_object('ok', true, 'version', target.game_version + 1, 'gameId', next_game_id, 'state', p_initial_state);
end;
$$;
revoke all on function public.reset_fair_dice_game(text, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.reset_fair_dice_game(text, jsonb, integer) to service_role;

notify pgrst, 'reload schema';
commit;
