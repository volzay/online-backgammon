begin;

create or replace function public.close_own_lobby_rooms()
returns text[]
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  player_id uuid := auth.uid();
  forfeited_codes text[] := array[]::text[];
  abandoned_codes text[] := array[]::text[];
  closed_codes text[] := array[]::text[];
begin
  if player_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  with forfeited as (
    update public.rooms room
    set
      game_state = coalesce(room.game_state, '{}'::jsonb)
        || jsonb_build_object(
          'phase', 'over',
          'winner', case
            when coalesce(room.game_state->'analysis'->>'playerColor', 'white') = 'white'
              then 'dark'
            else 'white'
          end,
          'resultType', 'normal',
          'finishedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint,
          'history', jsonb_build_array(jsonb_build_object(
            'at', clock_timestamp(),
            'resign', true,
            'color', coalesce(room.game_state->'analysis'->>'playerColor', 'white'),
            'reason', 'lobby_exit'
          )) || case
            when jsonb_typeof(room.game_state->'history') = 'array'
              then room.game_state->'history'
            else '[]'::jsonb
          end,
          'analysis', coalesce(room.game_state->'analysis', '{}'::jsonb)
            || jsonb_build_object(
              'botMemory',
              coalesce(room.game_state->'analysis'->'botMemory', '{}'::jsonb)
                || jsonb_build_object(
                  'outcome',
                  jsonb_build_object(
                    'winner', case
                      when coalesce(room.game_state->'analysis'->>'playerColor', 'white') = 'white'
                        then 'dark'
                      else 'white'
                    end,
                    'botColor', case
                      when coalesce(room.game_state->'analysis'->>'playerColor', 'white') = 'white'
                        then 'dark'
                      else 'white'
                    end,
                    'resultType', 'normal',
                    'score', coalesce(room.game_state->'score', '{}'::jsonb),
                    'finishedAt', clock_timestamp()
                  )
                )
            )
        ),
      game_version = room.game_version + 1,
      status = 'over',
      archived_at = now(),
      closed_reason = 'lobby_exit_forfeit'
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
  into forfeited_codes
  from forfeited;

  with closed as (
    update public.rooms
    set
      status = 'closed',
      archived_at = now(),
      closed_reason = 'lobby_exit'
    where host_user_id = player_id
      and status in ('waiting', 'joined')
      and not (
        status = 'joined'
        and coalesce(game_state->>'winner', '') not in ('white', 'dark')
        and (
          coalesce(game_state->>'mode', '') = 'bot'
          or coalesce(game_state->'analysis'->>'mode', '') = 'bot'
        )
      )
    returning code
  )
  select coalesce(array_agg(code order by code), array[]::text[])
  into abandoned_codes
  from closed;

  closed_codes := forfeited_codes || abandoned_codes;
  return closed_codes;
end;
$$;

revoke all on function public.close_own_lobby_rooms() from public;
grant execute on function public.close_own_lobby_rooms() to authenticated;

commit;
