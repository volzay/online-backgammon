begin;

-- Closing a room changes its status to `closed`, which intentionally makes the
-- row invisible to ordinary clients.  A direct RLS-protected UPDATE therefore
-- cannot complete: the SELECT visibility policy rejects the new row.  Keep
-- closed rooms private and expose one narrowly-scoped, ownership-checked
-- operation instead of broadening read access to the archive.
create or replace function public.close_own_waiting_room(p_room_code text)
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
  owned_status text;
begin
  if clean_code !~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$' then
    raise exception 'Invalid room code.' using errcode = '22023';
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
    closed_reason = 'waiting_host_exit'
  where room.code = clean_code
    and room.status = 'waiting'
    and room.guest_user_id is null
    and room.guest_guest_id is null
    and (
      (player_id is not null and room.host_user_id = player_id)
      or (
        player_id is null
        and guest_id is not null
        and room.host_guest_id = guest_id
      )
    )
  returning room.code into closed_code;

  if closed_code is not null then
    return jsonb_build_object(
      'ok', true,
      'removed', true,
      'closed', true,
      'code', closed_code
    );
  end if;

  -- Idempotent cleanup must also succeed after another tab has already closed
  -- the room.  Look only for a room owned by the caller so guessed room codes
  -- never reveal another player's archived state.
  select room.status
  into owned_status
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

  if owned_status in ('waiting', 'joined') then
    return jsonb_build_object(
      'ok', true,
      'removed', false,
      'closed', false,
      'code', clean_code,
      'room', jsonb_build_object('code', clean_code, 'status', owned_status)
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'removed', false,
    'closed', true,
    'code', clean_code
  );
end;
$$;

revoke all on function public.close_own_waiting_room(text)
from public, anon, authenticated;
grant execute on function public.close_own_waiting_room(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
