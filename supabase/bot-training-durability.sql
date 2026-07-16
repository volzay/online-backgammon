-- Isolated production migration: archive hard-bot learning at the database boundary.
-- Run after the bot_training_games table from schema.sql exists.

begin;

create or replace function public.archive_finished_bot_training_game()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_state jsonb := coalesce(new.game_state, '{}'::jsonb);
  memory jsonb := coalesce(target_state->'analysis'->'botMemory', '{}'::jsonb);
  decisions jsonb := coalesce(memory->'decisions', '[]'::jsonb);
  outcome jsonb := coalesce(memory->'outcome', '{}'::jsonb);
  resolved_bot_color text;
begin
  if coalesce(target_state->>'mode', '') <> 'bot'
    or coalesce(target_state->>'variant', new.variant) <> 'long'
    or coalesce(target_state->>'botDifficulty', '') <> 'hard'
    or coalesce(target_state->>'winner', '') not in ('white', 'dark')
    or jsonb_typeof(decisions) <> 'array'
    or jsonb_array_length(decisions) = 0 then
    return new;
  end if;

  resolved_bot_color := coalesce(
    nullif(outcome->>'botColor', ''),
    case
      when coalesce(target_state->'analysis'->>'playerColor', 'white') = 'white'
        then 'dark'
      else 'white'
    end
  );

  insert into public.bot_training_games (
    room_id, room_code, player_user_id, player_name, bot_name,
    engine_version, difficulty, bot_color, winner, result_type,
    decision_count, decisions, final_state, completed_at
  ) values (
    new.id, new.code, new.host_user_id, new.host_name,
    coalesce(new.guest_name, target_state->'analysis'->>'botName', 'Hard bot'),
    coalesce(memory->>'engineVersion', ''), 'hard', resolved_bot_color,
    target_state->>'winner',
    coalesce(nullif(target_state->>'resultType', ''), 'normal'),
    jsonb_array_length(decisions), decisions, target_state,
    coalesce(new.archived_at, now())
  )
  on conflict (room_code) do update
  set
    room_id = excluded.room_id,
    player_user_id = excluded.player_user_id,
    player_name = excluded.player_name,
    bot_name = excluded.bot_name,
    engine_version = excluded.engine_version,
    difficulty = excluded.difficulty,
    bot_color = excluded.bot_color,
    winner = excluded.winner,
    result_type = excluded.result_type,
    decision_count = excluded.decision_count,
    decisions = excluded.decisions,
    final_state = excluded.final_state,
    completed_at = excluded.completed_at;
  return new;
end;
$$;

drop trigger if exists rooms_archive_finished_bot_training on public.rooms;
create trigger rooms_archive_finished_bot_training
after insert or update of game_state, status on public.rooms
for each row execute function public.archive_finished_bot_training_game();

insert into public.bot_training_games (
  room_id, room_code, player_user_id, player_name, bot_name,
  engine_version, difficulty, bot_color, winner, result_type,
  decision_count, decisions, final_state, completed_at
)
select
  room.id, room.code, room.host_user_id, room.host_name,
  coalesce(room.guest_name, room.game_state->'analysis'->>'botName', 'Hard bot'),
  coalesce(room.game_state->'analysis'->'botMemory'->>'engineVersion', ''),
  'hard',
  coalesce(
    nullif(room.game_state->'analysis'->'botMemory'->'outcome'->>'botColor', ''),
    case when coalesce(room.game_state->'analysis'->>'playerColor', 'white') = 'white'
      then 'dark' else 'white' end
  ),
  room.game_state->>'winner',
  coalesce(nullif(room.game_state->>'resultType', ''), 'normal'),
  jsonb_array_length(room.game_state->'analysis'->'botMemory'->'decisions'),
  room.game_state->'analysis'->'botMemory'->'decisions',
  room.game_state,
  coalesce(room.archived_at, now())
from public.rooms room
where coalesce(room.game_state->>'mode', '') = 'bot'
  and coalesce(room.game_state->>'variant', room.variant) = 'long'
  and coalesce(room.game_state->>'botDifficulty', '') = 'hard'
  and coalesce(room.game_state->>'winner', '') in ('white', 'dark')
  and jsonb_typeof(room.game_state->'analysis'->'botMemory'->'decisions') = 'array'
  and jsonb_array_length(room.game_state->'analysis'->'botMemory'->'decisions') > 0
on conflict (room_code) do update
set
  room_id = excluded.room_id,
  player_user_id = excluded.player_user_id,
  player_name = excluded.player_name,
  bot_name = excluded.bot_name,
  engine_version = excluded.engine_version,
  difficulty = excluded.difficulty,
  bot_color = excluded.bot_color,
  winner = excluded.winner,
  result_type = excluded.result_type,
  decision_count = excluded.decision_count,
  decisions = excluded.decisions,
  final_state = excluded.final_state,
  completed_at = excluded.completed_at;

notify pgrst, 'reload schema';

commit;
