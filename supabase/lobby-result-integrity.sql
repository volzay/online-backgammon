-- Keep lobby cleanup from inventing a bot-game result while the real final
-- snapshot is still being persisted.

begin;

create or replace function public.close_own_lobby_rooms()
returns text[]
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  player_id uuid := auth.uid();
  unfinished_codes text[] := array[]::text[];
  abandoned_codes text[] := array[]::text[];
  closed_codes text[] := array[]::text[];
begin
  if player_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  with unfinished as (
    update public.rooms room
    set
      status = 'closed',
      archived_at = now(),
      closed_reason = 'lobby_exit_unfinished'
    where room.host_user_id = player_id
      and room.status = 'joined'
      and coalesce(room.game_state->>'winner', '') not in ('white', 'dark')
      and (
        coalesce(room.game_state->>'mode', '') = 'bot'
        or coalesce(room.game_state->'analysis'->>'mode', '') = 'bot'
      )
    returning room.code
  )
  select coalesce(array_agg(code order by code), array[]::text[])
  into unfinished_codes
  from unfinished;

  with closed as (
    update public.rooms
    set
      status = 'closed',
      archived_at = now(),
      closed_reason = 'lobby_exit'
    where host_user_id = player_id
      and status in ('waiting', 'joined')
    returning code
  )
  select coalesce(array_agg(code order by code), array[]::text[])
  into abandoned_codes
  from closed;

  closed_codes := unfinished_codes || abandoned_codes;
  return closed_codes;
end;
$$;

revoke all on function public.close_own_lobby_rooms() from public;
grant execute on function public.close_own_lobby_rooms() to authenticated;

notify pgrst, 'reload schema';

commit;
