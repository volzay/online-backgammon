-- Confirm the already-persisted bot result using two small selectors. The
-- browser must not upload the complete training ledger a second time merely
-- to request Elo. Existing rating math and participant checks are retained.
begin;
set local lock_timeout = '5s';

create or replace function public.record_saved_bot_rating(
  p_room_code text,
  p_result_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  player_id uuid := auth.uid();
  clean_room_code text := upper(trim(coalesce(p_room_code, '')));
  clean_result_key text := trim(coalesce(p_result_key, ''));
  saved_room public.rooms%rowtype;
  saved_state jsonb;
  player_color text;
  saved_player_color text;
  winner_color text;
  result_type text;
  finished_text text;
  finished_at timestamptz;
  difficulty text;
  opponent_rating integer;
  opponent_name text;
  profile_rating integer;
  profile_tier text;
  reply jsonb;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or player_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if clean_room_code !~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'
     or clean_result_key = '' or length(clean_result_key) > 120 then
    raise exception 'A room code and exact result key are required.' using errcode = '22023';
  end if;

  -- Match the lock order of legacy rating finalization: room, then profile.
  -- A concurrent legacy client therefore cannot race this smaller RPC into
  -- a duplicate award or produce two ratings from the same starting value.
  select r.* into saved_room
  from public.rooms r
  where r.code = clean_room_code
    and r.host_user_id = player_id and r.host_guest_id is null
    and r.guest_user_id is null and r.guest_guest_id is null
    and r.host_registered
  for share;
  if not found then
    raise exception 'Only the registered bot-room player may receive this result.' using errcode = '42501';
  end if;
  if coalesce(saved_room.game_state->>'mode', '') <> 'bot'
     and coalesce(saved_room.game_state #>> '{analysis,mode}', '') <> 'bot' then
    raise exception 'This is not a bot room.' using errcode = '22023';
  end if;

  saved_state := saved_room.game_state;
  if coalesce(saved_state->>'phase', '') <> 'over'
     or saved_state->>'winner' not in ('white', 'dark')
     or coalesce(saved_state->>'finishedAt', '') = ''
     or clean_result_key <> concat(saved_state->>'finishedAt', ':', saved_state->>'winner', ':',
         coalesce(nullif(saved_state->>'resultType', ''), 'normal')) then
    select a.final_state into saved_state
    from public.room_game_archives a
    where a.room_id = saved_room.id and a.result_key = clean_result_key
    order by a.created_at
    limit 1;
  end if;
  if saved_state is null or coalesce(saved_state->>'phase', '') <> 'over'
     or coalesce(saved_state->>'winner', '') not in ('white', 'dark')
     or coalesce(saved_state->>'finishedAt', '') = ''
     or (coalesce(saved_state->>'mode', '') <> 'bot'
       and coalesce(saved_state #>> '{analysis,mode}', '') <> 'bot') then
    raise exception 'The completed bot game has not been saved.' using errcode = '55000';
  end if;

  winner_color := saved_state->>'winner';
  result_type := coalesce(nullif(saved_state->>'resultType', ''), 'normal');
  finished_text := saved_state->>'finishedAt';
  if result_type not in ('normal', 'mars', 'koks')
     or clean_result_key <> concat(finished_text, ':', winner_color, ':', result_type) then
    raise exception 'Rating result key does not match the saved game.' using errcode = '22023';
  end if;
  player_color := case when saved_room.game_state #>> '{analysis,playerColor}' = 'dark'
    then 'dark' else 'white' end;
  saved_player_color := case when saved_state #>> '{analysis,playerColor}' = 'dark'
    then 'dark' else 'white' end;
  if saved_player_color <> player_color then
    -- The existing participant trigger also checks the current room seat.
    -- Never reinterpret a historical result as a win for a different colour.
    raise exception 'The saved player seat does not match the bot room.' using errcode = '22023';
  end if;
  difficulty := coalesce(nullif(saved_state->>'botDifficulty', ''),
    saved_state #>> '{analysis,difficulty}', '');
  opponent_rating := case difficulty when 'easy' then 900 when 'medium' then 1200 when 'hard' then 1500 end;
  if opponent_rating is null then
    raise exception 'This bot game is not eligible for rating.' using errcode = '22023';
  end if;
  opponent_name := coalesce(nullif(saved_state #>> '{analysis,botName}', ''),
    case difficulty when 'easy' then 'Бот простой' when 'medium' then 'Бот средний' else 'Бот сложный' end);
  begin
    if finished_text ~ '^[0-9]+([.][0-9]+)?$' then
      finished_at := to_timestamp(finished_text::double precision / 1000.0);
    else
      finished_at := finished_text::timestamptz;
    end if;
    if not isfinite(finished_at) then
      raise exception 'Saved finish time is invalid.' using errcode = '22023';
    end if;
  exception when invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    raise exception 'Saved finish time is invalid.' using errcode = '22023';
  end;

  select p.rating, p.tier into profile_rating, profile_tier
  from public.profiles p
  where p.id = player_id and p.rating_eligible and p.banned_at is null
  for update;
  if not found then
    raise exception 'The player profile is not eligible for rating.' using errcode = '42501';
  end if;

  reply := public.record_rating_result(
    clean_result_key, opponent_name, opponent_rating, winner_color = player_color,
    'bot', case when result_type = 'normal' then '' else result_type end, winner_color,
    jsonb_build_object(
      'white', coalesce(saved_state #> '{score,white}', '0'::jsonb),
      'dark', coalesce(saved_state #> '{score,dark}', '0'::jsonb),
      'roomCode', clean_room_code,
      'off', saved_state->'off',
      -- No winner here: the legacy RPC must not run its client-state rescue
      -- UPDATE. The room and both archives remain byte-for-byte untouched.
      'finalState', jsonb_build_object('finishedAt', saved_state->'finishedAt')
    ),
    case when jsonb_typeof(saved_state->'history') = 'array' then saved_state->'history' else '[]'::jsonb end,
    finished_at
  );
  select p.rating, p.tier into profile_rating, profile_tier
  from public.profiles p where p.id = player_id;
  return reply || jsonb_build_object(
    'resultRating', reply->'rating',
    'rating', profile_rating,
    'tier', profile_tier,
    'roomCode', clean_room_code,
    'resultKey', clean_result_key,
    'historyCount', case when jsonb_typeof(saved_state->'history') = 'array'
      then jsonb_array_length(saved_state->'history') else 0 end
  );
end;
$$;

revoke all on function public.record_saved_bot_rating(text,text)
from public, anon, authenticated, service_role;
grant execute on function public.record_saved_bot_rating(text,text) to authenticated;

commit;
