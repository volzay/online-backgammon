-- One-off repair after close_own_lobby_rooms replaced the real local result
-- with a synthetic bot win. The player's win is confirmed; the bot's exact
-- borne-off count and special result type cannot be recovered from the stale
-- server snapshot and are intentionally marked unknown.

begin;

delete from public.room_game_archives
where room_code = 'EMVJ-7VY3';

delete from public.bot_training_games
where room_code = 'EMVJ-7VY3';

update public.rooms room
set
  game_state = coalesce(room.game_state, '{}'::jsonb)
    || jsonb_build_object(
      'phase', 'over',
      'winner', 'white',
      'resultType', 'unknown',
      'points', (
        select coalesce(jsonb_object_agg(point.key, point.value), '{}'::jsonb)
        from jsonb_each(
          coalesce(room.game_state->'points', '{}'::jsonb)
        ) as point(key, value)
        where point.value->>'color' <> 'white'
      ),
      'off', jsonb_build_object('white', 15, 'dark', 0),
      'borneOff', jsonb_build_object('white', 15, 'dark', 0),
      'history', (
        select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
        from jsonb_array_elements(
          coalesce(room.game_state->'history', '[]'::jsonb)
        ) with ordinality as item(value, ordinality)
        where coalesce(item.value->>'reason', '') <> 'lobby_exit'
      ),
      'analysis', coalesce(room.game_state->'analysis', '{}'::jsonb)
        || jsonb_build_object(
          'botMemory',
          coalesce(room.game_state->'analysis'->'botMemory', '{}'::jsonb)
            || jsonb_build_object(
              'outcome',
              coalesce(
                room.game_state->'analysis'->'botMemory'->'outcome',
                '{}'::jsonb
              ) || jsonb_build_object(
                'winner', 'white',
                'botColor', 'dark',
                'resultType', 'unknown'
              )
            ),
          'resultRepair', jsonb_build_object(
            'source', 'confirmed_player_report',
            'repairedAt', clock_timestamp(),
            'borneOffUnknown', true,
            'resultTypeUnknown', true
          )
        )
    ),
  game_version = room.game_version + 1,
  status = 'over',
  archived_at = now(),
  closed_reason = 'result_repaired'
where room.code = 'EMVJ-7VY3';

-- The saved decisions ended before the true finish, so they must not be used
-- as a complete losing example by the shared hard-bot experience.
delete from public.bot_training_games
where room_code = 'EMVJ-7VY3';

commit;
