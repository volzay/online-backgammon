begin;

-- Bot-room abandonment has the same terminal-row RLS boundary as waiting-room
-- closure.  Keep the operation owner-only, bot-only and compare-and-swap the
-- game version so an older tab cannot invalidate a newer game state.
create or replace function public.close_own_bot_room(
  p_room_code text,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, auth
as $$
declare
  clean_code text := upper(trim(coalesce(p_room_code, '')));
  request_role text := coalesce(auth.role(), '');
  player_id uuid := auth.uid();
  guest_id text := case
    when coalesce(auth.role(), '') = 'anon' then public.request_guest_identity()
    else null
  end;
  closed_code text;
  closed_version integer;
  owned_status text;
  owned_version integer;
  owned_closable boolean := false;
begin
  if clean_code !~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$' then
    raise exception 'Invalid room code.' using errcode = '22023';
  end if;

  if p_expected_version is null or p_expected_version < 0
     or p_expected_version > 2147483646 then
    raise exception 'Invalid game version.' using errcode = '22023';
  end if;

  if request_role not in ('authenticated', 'anon')
     or (request_role = 'authenticated' and player_id is null)
     or (request_role = 'anon' and guest_id is null) then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  update public.rooms room
  set
    status = 'closed',
    archived_at = now(),
    closed_reason = 'bot_abandoned',
    game_version = room.game_version + 1
  where room.code = clean_code
    and room.status = 'joined'
    and room.game_version = p_expected_version
    and room.guest_user_id is null
    and room.guest_guest_id is null
    and room.game_state->>'roomCode' = clean_code
    and 'bot' in (
      coalesce(room.game_state->>'mode', ''),
      coalesce(room.game_state->>'opponent', ''),
      coalesce(room.game_state->'analysis'->>'mode', ''),
      coalesce(room.game_state->'analysis'->>'opponent', '')
    )
    and (
      (player_id is not null and room.host_user_id = player_id)
      or (
        player_id is null
        and guest_id is not null
        and room.host_guest_id = guest_id
      )
    )
  returning room.code, room.game_version
  into closed_code, closed_version;

  if closed_code is not null then
    return jsonb_build_object(
      'ok', true,
      'removed', true,
      'closed', true,
      'code', closed_code,
      'version', closed_version
    );
  end if;

  select
    room.status,
    room.game_version,
    room.status = 'joined'
      and room.guest_user_id is null
      and room.guest_guest_id is null
      and room.game_state->>'roomCode' = clean_code
      and 'bot' in (
        coalesce(room.game_state->>'mode', ''),
        coalesce(room.game_state->>'opponent', ''),
        coalesce(room.game_state->'analysis'->>'mode', ''),
        coalesce(room.game_state->'analysis'->>'opponent', '')
      )
  into owned_status, owned_version, owned_closable
  from public.rooms room
  where room.code = clean_code
    and (
      (player_id is not null and room.host_user_id = player_id)
      or (
        player_id is null
        and guest_id is not null
        and room.host_guest_id = guest_id
      )
    )
  limit 1;

  if owned_status = 'joined' and owned_closable then
    return jsonb_build_object(
      'ok', true,
      'removed', false,
      'closed', false,
      'conflict', owned_version <> p_expected_version,
      'code', clean_code,
      'room', jsonb_build_object(
        'code', clean_code,
        'status', owned_status,
        'version', owned_version
      )
    );
  end if;

  if owned_status in ('waiting', 'joined') then
    return jsonb_build_object(
      'ok', true,
      'removed', false,
      'closed', false,
      'conflict', false,
      'code', clean_code,
      'room', jsonb_build_object(
        'code', clean_code,
        'status', owned_status,
        'version', owned_version
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'removed', false,
    'closed', true,
    'code', clean_code,
    'version', owned_version
  );
end;
$$;

revoke all on function public.close_own_bot_room(text, bigint)
from public, anon, authenticated;
grant execute on function public.close_own_bot_room(text, bigint)
to anon, authenticated;

notify pgrst, 'reload schema';

commit;
