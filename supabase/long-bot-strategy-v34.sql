begin;

create extension if not exists pg_cron;

create or replace function public.finish_room_game(
  p_room_code text,
  p_final_state jsonb,
  p_training_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  player_id uuid := auth.uid();
  target public.rooms%rowtype;
  next_version bigint;
  clean_code text := upper(trim(coalesce(p_room_code, '')));
  training_memory jsonb;
  training_decisions jsonb;
  training_outcome jsonb;
  training_coverage jsonb;
  resolved_bot_color text;
  training_id uuid;
  training_count integer := 0;
  training_archived boolean := false;
  already_finished boolean := false;
  completed_at timestamptz;
begin
  if player_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if coalesce(p_final_state->>'phase', '') <> 'over'
     or coalesce(p_final_state->>'winner', '') not in ('white', 'dark') then
    raise exception 'A finished game state is required.' using errcode = '22023';
  end if;

  select *
  into target
  from public.rooms
  where code = clean_code
  for update;

  if not found then
    raise exception 'Room not found.' using errcode = 'P0002';
  end if;
  if target.host_user_id is distinct from player_id
     and target.guest_user_id is distinct from player_id then
    raise exception 'Only room players can finish the game.' using errcode = '42501';
  end if;

  if coalesce(target.game_state->>'winner', '') in ('white', 'dark') then
    if target.game_state->>'winner' = p_final_state->>'winner'
       and coalesce(target.game_state->>'finishedAt', '') = coalesce(p_final_state->>'finishedAt', '') then
      already_finished := true;
      next_version := target.game_version;
    else
      raise exception 'Room already contains a different finished game.' using errcode = '23505';
    end if;
  end if;

  if not already_finished then
    if target.status = 'closed'
       and coalesce(target.closed_reason, '') not in ('lobby_exit', 'lobby_exit_repair', 'left', 'removed') then
      raise exception 'Room was closed by an administrator.' using errcode = '55000';
    end if;
    if target.status not in ('joined', 'over', 'closed') then
      raise exception 'Room has no active game.' using errcode = '55000';
    end if;

    next_version := target.game_version + 1;
    completed_at := now();
    update public.rooms
    set
      game_state = p_final_state,
      game_version = next_version,
      -- A late final payload may race with lobby cleanup. Preserve the final
      -- snapshot without reviving a terminally closed room.
      status = case when target.status = 'closed' then 'closed' else 'over' end,
      archived_at = completed_at,
      closed_reason = 'finished'
    where id = target.id;
  else
    completed_at := coalesce(target.archived_at, now());
  end if;

  if p_training_state is not null then
    if target.host_user_id is distinct from player_id
       or (
         coalesce(target.game_state->>'mode', target.game_state->'analysis'->>'mode', '') <> 'bot'
         and coalesce(target.game_state->>'opponent', target.game_state->'analysis'->>'opponent', '') <> 'bot'
       )
       or (
         coalesce(p_final_state->>'mode', p_final_state->'analysis'->>'mode', '') <> 'bot'
         and coalesce(p_final_state->>'opponent', p_final_state->'analysis'->>'opponent', '') <> 'bot'
       )
       or coalesce(target.game_state->>'botDifficulty', target.game_state->'analysis'->>'difficulty', '') <> 'hard'
       or coalesce(p_final_state->>'botDifficulty', '') <> 'hard'
       or coalesce(target.game_state->>'startedAt', '') <> coalesce(p_final_state->>'startedAt', '')
       or coalesce(p_training_state->>'phase', '') <> 'over'
       or coalesce(p_training_state->>'winner', '') not in ('white', 'dark')
       or coalesce(p_training_state->>'winner', '') <> coalesce(p_final_state->>'winner', '')
       or coalesce(p_training_state->>'roomCode', clean_code) <> clean_code
       or coalesce(p_training_state->>'mode', '') <> 'bot'
       or coalesce(p_training_state->>'variant', target.variant) not in ('long', 'short')
       or coalesce(p_training_state->>'variant', target.variant) <> coalesce(p_final_state->>'variant', target.variant)
       or coalesce(p_training_state->>'botDifficulty', '') <> 'hard'
       or coalesce(p_training_state->>'startedAt', '') <> coalesce(p_final_state->>'startedAt', '')
       or coalesce(p_training_state->>'finishedAt', '') <> coalesce(p_final_state->>'finishedAt', '')
       or coalesce(p_training_state->>'resultType', 'normal') <> coalesce(p_final_state->>'resultType', 'normal')
       or coalesce(p_training_state->'points', '{}'::jsonb) <> coalesce(p_final_state->'points', '{}'::jsonb)
       or coalesce(p_training_state->'off', '{}'::jsonb) <> coalesce(p_final_state->'off', '{}'::jsonb)
       or coalesce(p_training_state->'bar', '{}'::jsonb) <> coalesce(p_final_state->'bar', '{}'::jsonb)
       or coalesce(p_training_state->'score', '{}'::jsonb) <> coalesce(p_final_state->'score', '{}'::jsonb) then
      raise exception 'Training state does not match the finished game.' using errcode = '22023';
    end if;

    training_memory := coalesce(p_training_state->'analysis'->'botMemory', '{}'::jsonb);
    training_decisions := coalesce(training_memory->'decisions', '[]'::jsonb);
    if jsonb_typeof(training_decisions) <> 'array'
       or jsonb_array_length(training_decisions) = 0 then
      raise exception 'Bot training payload contains no decisions.' using errcode = '22023';
    end if;
    training_coverage := coalesce(training_memory->'coverage', '{}'::jsonb);
    if coalesce(p_training_state->>'variant', target.variant) = 'long'
       and coalesce(training_memory->>'engineVersion', '') in (
         'long-analytic-v29',
         'long-analytic-v30',
         'long-analytic-v31',
         'long-analytic-v32',
         'long-analytic-v33',
         'long-analytic-v34'
       ) then
      if jsonb_typeof(training_coverage) <> 'object'
         or coalesce(training_coverage->'complete', 'false'::jsonb) <> 'true'::jsonb
         or jsonb_typeof(training_coverage->'expectedBotDecisions') <> 'number'
         or jsonb_typeof(training_coverage->'recordedBotDecisions') <> 'number'
         or jsonb_typeof(training_coverage->'recoveredBotDecisions') <> 'number'
         or coalesce(training_coverage->>'expectedBotDecisions', '') !~ '^[0-9]+$'
         or coalesce(training_coverage->>'recordedBotDecisions', '') !~ '^[0-9]+$'
         or coalesce(training_coverage->>'recoveredBotDecisions', '') !~ '^[0-9]+$'
         or (training_coverage->>'expectedBotDecisions')::numeric <= 0
         or (training_coverage->>'expectedBotDecisions')::numeric <>
           (training_coverage->>'recordedBotDecisions')::numeric
             + (training_coverage->>'recoveredBotDecisions')::numeric then
        raise exception 'Long bot v29+ training payload has incomplete decision coverage.' using errcode = '22023';
      end if;
    end if;

    training_outcome := coalesce(training_memory->'outcome', '{}'::jsonb);
    resolved_bot_color := coalesce(
      nullif(training_outcome->>'botColor', ''),
      case
        when coalesce(p_training_state->'analysis'->>'playerColor', 'white') = 'white'
          then 'dark'
        else 'white'
      end
    );

    insert into public.bot_training_games (
      room_id, room_code, player_user_id, player_name, bot_name,
      engine_version, difficulty, bot_color, winner, result_type,
      decision_count, decisions, final_state, completed_at
    ) values (
      target.id,
      target.code,
      target.host_user_id,
      target.host_name,
      coalesce(target.guest_name, p_training_state->'analysis'->>'botName', 'Hard bot'),
      coalesce(training_memory->>'engineVersion', ''),
      'hard',
      resolved_bot_color,
      p_training_state->>'winner',
      coalesce(nullif(p_training_state->>'resultType', ''), 'normal'),
      jsonb_array_length(training_decisions),
      training_decisions,
      p_training_state,
      completed_at
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
      completed_at = excluded.completed_at
    returning id, decision_count into training_id, training_count;
    training_archived := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'version', next_version,
    'alreadyFinished', already_finished,
    'trainingArchived', training_archived,
    'trainingId', training_id,
    'decisionCount', training_count
  );
end;
$$;

revoke all on function public.finish_room_game(text, jsonb, jsonb) from public;
grant execute on function public.finish_room_game(text, jsonb, jsonb) to authenticated;

create or replace function public.finish_room_game(
  p_room_code text,
  p_final_state jsonb
)
returns jsonb
language sql
security definer
set search_path = public, auth
as $$
  select public.finish_room_game($1, $2, null::jsonb)
$$;

revoke all on function public.finish_room_game(text, jsonb) from public;
grant execute on function public.finish_room_game(text, jsonb) to authenticated;

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
  coverage jsonb := coalesce(memory->'coverage', '{}'::jsonb);
  resolved_bot_color text;
begin
  if coalesce(target_state->>'mode', '') <> 'bot'
    or coalesce(target_state->>'variant', new.variant) not in ('long', 'short')
    or coalesce(target_state->>'botDifficulty', '') <> 'hard'
    or coalesce(target_state->>'winner', '') not in ('white', 'dark')
    or jsonb_typeof(decisions) <> 'array'
    or jsonb_array_length(decisions) = 0 then
    return new;
  end if;

  -- v29+ experience is valid only when every expected bot turn was captured.
  -- Older long archives and short games remain readable and keep their
  -- existing archival behavior, but cannot accidentally satisfy this gate.
  if coalesce(target_state->>'variant', new.variant) = 'long'
    and coalesce(memory->>'engineVersion', '') in (
      'long-analytic-v29',
      'long-analytic-v30',
      'long-analytic-v31',
      'long-analytic-v32',
      'long-analytic-v33',
      'long-analytic-v34'
    ) then
    if jsonb_typeof(coverage) <> 'object'
      or coalesce(coverage->'complete', 'false'::jsonb) <> 'true'::jsonb
      or jsonb_typeof(coverage->'expectedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recordedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recoveredBotDecisions') <> 'number' then
      return new;
    end if;
    if coalesce(coverage->>'expectedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recordedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recoveredBotDecisions', '') !~ '^[0-9]+$' then
      return new;
    end if;
    if (coverage->>'expectedBotDecisions')::numeric <= 0
      or (coverage->>'expectedBotDecisions')::numeric <>
        (coverage->>'recordedBotDecisions')::numeric
          + (coverage->>'recoveredBotDecisions')::numeric then
      return new;
    end if;
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
    new.id,
    new.code,
    new.host_user_id,
    new.host_name,
    coalesce(new.guest_name, target_state->'analysis'->>'botName', 'Hard bot'),
    coalesce(memory->>'engineVersion', ''),
    'hard',
    resolved_bot_color,
    target_state->>'winner',
    coalesce(nullif(target_state->>'resultType', ''), 'normal'),
    jsonb_array_length(decisions),
    decisions,
    target_state,
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

drop function if exists public.archive_bot_training_game(text);

create or replace function public.archive_bot_training_game(
  p_room_code text,
  p_final_state jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_code text := upper(trim(coalesce(p_room_code, '')));
  target_room public.rooms%rowtype;
  target_state jsonb;
  memory jsonb;
  decisions jsonb;
  outcome jsonb;
  coverage jsonb;
  saved_id uuid;
  saved_count integer;
  resolved_bot_color text;
begin
  if clean_code = '' then
    raise exception 'Room code is required.';
  end if;

  select r.* into target_room
  from public.rooms r
  where r.code = clean_code
  limit 1;

  if target_room.id is null then
    raise exception 'Room not found.';
  end if;
  target_state := coalesce(target_room.game_state, '{}'::jsonb);

  if not coalesce(public.is_admin_user(), false) then
    if target_room.host_user_id is not null then
      if auth.uid() is null or target_room.host_user_id is distinct from auth.uid() then
        raise exception 'Only the room player can archive this game.';
      end if;
    elsif coalesce(target_state->>'winner', '') not in ('white', 'dark')
      or (
        case
        when jsonb_typeof(coalesce(target_state->'analysis'->'botMemory'->'decisions', '[]'::jsonb)) = 'array'
          then jsonb_array_length(coalesce(target_state->'analysis'->'botMemory'->'decisions', '[]'::jsonb))
        else 0
        end
      ) = 0
      or (
        p_final_state is not null
        and (
          coalesce(p_final_state->>'winner', '') <> coalesce(target_state->>'winner', '')
          or coalesce(p_final_state->>'startedAt', '') <> coalesce(target_state->>'startedAt', '')
          or coalesce(p_final_state->'points', '{}'::jsonb) <> coalesce(target_state->'points', '{}'::jsonb)
          or coalesce(p_final_state->'off', '{}'::jsonb) <> coalesce(target_state->'off', '{}'::jsonb)
          or coalesce(p_final_state->'history', '[]'::jsonb) <> coalesce(target_state->'history', '[]'::jsonb)
          or coalesce(p_final_state->'analysis'->'botMemory'->'decisions', '[]'::jsonb)
            <> coalesce(target_state->'analysis'->'botMemory'->'decisions', '[]'::jsonb)
        )
      ) then
      raise exception 'Guest bot game must match the finished room snapshot.';
    end if;
  end if;

  if p_final_state is not null then
    if coalesce(target_state->>'mode', target_state->'analysis'->>'mode', '') not in ('', 'bot')
      and coalesce(target_state->>'opponent', target_state->'analysis'->>'opponent', '') <> 'bot' then
      raise exception 'This room is not a bot analysis room.';
    end if;
    if coalesce(p_final_state->>'roomCode', clean_code) <> clean_code then
      raise exception 'Final state room code mismatch.';
    end if;
    if coalesce(p_final_state->>'winner', '') not in ('white', 'dark') then
      raise exception 'The final state is not finished.';
    end if;

    -- Archive the immutable final payload without writing it back to the live
    -- room. A player may already have started the next game in this room.
    target_state := p_final_state;
  end if;

  if coalesce(target_state->>'mode', '') <> 'bot'
    or coalesce(target_state->>'variant', target_room.variant) not in ('long', 'short')
    or coalesce(target_state->>'botDifficulty', '') <> 'hard' then
    raise exception 'This room is not a hard bot game.';
  end if;
  if coalesce(target_state->>'winner', '') not in ('white', 'dark') then
    raise exception 'The game is not finished.';
  end if;

  memory := coalesce(target_state->'analysis'->'botMemory', '{}'::jsonb);
  decisions := coalesce(memory->'decisions', '[]'::jsonb);
  if jsonb_typeof(decisions) <> 'array' then
    decisions := '[]'::jsonb;
  end if;
  coverage := coalesce(memory->'coverage', '{}'::jsonb);
  if coalesce(target_state->>'variant', target_room.variant) = 'long'
    and coalesce(memory->>'engineVersion', '') in (
      'long-analytic-v29',
      'long-analytic-v30',
      'long-analytic-v31',
      'long-analytic-v32',
      'long-analytic-v33',
      'long-analytic-v34'
    ) then
    if jsonb_typeof(coverage) <> 'object'
      or coalesce(coverage->'complete', 'false'::jsonb) <> 'true'::jsonb
      or jsonb_typeof(coverage->'expectedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recordedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recoveredBotDecisions') <> 'number'
      or coalesce(coverage->>'expectedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recordedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recoveredBotDecisions', '') !~ '^[0-9]+$' then
      raise exception 'Long bot v29+ training payload has incomplete decision coverage.';
    end if;
    if (coverage->>'expectedBotDecisions')::numeric <= 0
      or (coverage->>'expectedBotDecisions')::numeric <>
        (coverage->>'recordedBotDecisions')::numeric
          + (coverage->>'recoveredBotDecisions')::numeric then
      raise exception 'Long bot v29+ training payload has inconsistent decision coverage.';
    end if;
  end if;
  outcome := coalesce(memory->'outcome', '{}'::jsonb);
  resolved_bot_color := coalesce(
    nullif(outcome->>'botColor', ''),
    case
      when coalesce(target_state->'analysis'->>'playerColor', 'white') = 'white'
        then 'dark'
      else 'white'
    end
  );

  insert into public.bot_training_games (
    room_id,
    room_code,
    player_user_id,
    player_name,
    bot_name,
    engine_version,
    difficulty,
    bot_color,
    winner,
    result_type,
    decision_count,
    decisions,
    final_state,
    completed_at
  )
  values (
    target_room.id,
    target_room.code,
    target_room.host_user_id,
    target_room.host_name,
    coalesce(target_room.guest_name, target_state->'analysis'->>'botName', 'Hard bot'),
    coalesce(memory->>'engineVersion', ''),
    coalesce(target_state->>'botDifficulty', 'hard'),
    resolved_bot_color,
    target_state->>'winner',
    coalesce(nullif(target_state->>'resultType', ''), 'normal'),
    jsonb_array_length(decisions),
    decisions,
    target_state,
    coalesce(target_room.archived_at, now())
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
    completed_at = excluded.completed_at
  returning id, decision_count into saved_id, saved_count;

  return jsonb_build_object(
    'ok', true,
    'id', saved_id,
    'roomCode', target_room.code,
    'decisionCount', saved_count
  );
end;
$$;

revoke all on function public.archive_bot_training_game(text, jsonb) from public;
grant execute on function public.archive_bot_training_game(text, jsonb) to anon, authenticated;

create or replace function public.long_bot_safe_numeric(p_value jsonb)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  with parsed as (
    select case
      when jsonb_typeof(p_value) = 'number' then (p_value #>> '{}')::numeric
      else null
    end as value
  )
  select case
    when abs(value) <= 1000000000000 then value
    else null
  end
  from parsed
$$;

revoke all on function public.long_bot_safe_numeric(jsonb)
  from public, anon, authenticated, service_role;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table if not exists private.long_bot_experience_cache_keys (
  player_key text primary key,
  dirty boolean not null default true,
  discovered_at timestamptz not null default now()
);

create table if not exists private.long_bot_experience_cache (
  player_key text primary key references private.long_bot_experience_cache_keys(player_key)
    on delete cascade,
  patterns jsonb not null,
  refreshed_at timestamptz not null default now(),
  constraint long_bot_experience_cache_patterns_array
    check (jsonb_typeof(patterns) = 'array')
);

create table if not exists private.long_bot_experience_changes (
  change_id bigint generated always as identity primary key,
  old_player_key text,
  new_player_key text,
  changed_at timestamptz not null default now()
);

alter table private.long_bot_experience_cache_keys enable row level security;
alter table private.long_bot_experience_cache enable row level security;
alter table private.long_bot_experience_changes enable row level security;
revoke all on private.long_bot_experience_cache_keys from public, anon, authenticated, service_role;
revoke all on private.long_bot_experience_cache from public, anon, authenticated, service_role;
revoke all on private.long_bot_experience_changes from public, anon, authenticated, service_role;

drop function if exists private.compute_long_bot_experience_patterns(text);

create or replace function private.compute_long_bot_experience_patterns(
  p_player_name text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '2min'
as $$
  with valid_games as (
    select g.*
    from public.bot_training_games g
    cross join lateral (
      select
        (count(*) filter (
          where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
        ))::numeric as covered_bot_decisions,
        count(*) filter (
          where not (
            (
              coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
              and (
                (
                  decision->>'source' = 'engine'
                  and decision->>'engineVersion' = g.engine_version
                  and coalesce(decision->'experienceFrozen', 'false'::jsonb) = 'true'::jsonb
                  and coalesce(decision->>'experienceFingerprint', '') <> ''
                )
                or (
                  decision->>'source' = 'history-recovery'
                  and coalesce(public.long_bot_safe_numeric(decision->'captureVersion'), 0) >= 2
                  and decision->>'engineVersion' = g.engine_version
                )
              )
            )
            or (
              decision->>'actor' = 'opponent'
              and coalesce(public.long_bot_safe_numeric(decision->'captureVersion'), 0) >= 2
              and decision->>'engineVersion' = g.engine_version
            )
          )
        ) as incompatible_decisions,
        count(distinct decision->>'experienceFingerprint') filter (
          where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
            and decision->>'source' = 'engine'
        ) as engine_fingerprints
      from jsonb_array_elements(case
        when jsonb_typeof(g.decisions) = 'array' then g.decisions
        else '[]'::jsonb
      end) scanned(decision)
    ) integrity
    where g.difficulty = 'hard'
      and g.engine_version in ('long-analytic-v29', 'long-analytic-v30', 'long-analytic-v31', 'long-analytic-v32', 'long-analytic-v33', 'long-analytic-v34')
      and g.completed_at >= now() - interval '180 days'
      and jsonb_typeof(g.decisions) = 'array'
      and coalesce(g.final_state->>'variant', '') = 'long'
      and g.final_state->'analysis'->'botMemory'->>'engineVersion' = g.engine_version
      and coalesce(
        g.final_state->'analysis'->'botMemory'->'coverage'->'complete',
        'false'::jsonb
      ) = 'true'::jsonb
      and public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'expectedBotDecisions'
      ) > 0
      and public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'expectedBotDecisions'
      ) = coalesce(public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'recordedBotDecisions'
      ), -1) + coalesce(public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'recoveredBotDecisions'
      ), -1)
      and public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'expectedBotDecisions'
      ) = integrity.covered_bot_decisions
      and integrity.incompatible_decisions = 0
      and integrity.engine_fingerprints <= 1
  ), raw_decisions as (
    select
      g.winner,
      g.bot_color,
      g.result_type,
      g.player_name,
      g.completed_at,
      coalesce(
        nullif(substring(g.engine_version from 'v([0-9]{1,4})$'), '')::integer,
        0
      ) as engine_generation,
      coalesce(public.long_bot_safe_numeric(decision->'captureVersion'), 0) as capture_version,
      coalesce(nullif(decision->>'actor', ''), 'bot') as actor,
      public.long_bot_safe_numeric(decision->'choiceCount') as choice_count,
      greatest(0.75, least(4, coalesce(public.long_bot_safe_numeric(decision->'winQuality'), 1))) as win_quality,
      coalesce(decision->'experience', decision->'selected'->'experience') as descriptor,
      coalesce(decision->'selected'->'features', '{}'::jsonb) as features,
      coalesce(decision->'selected'->'tactical', '{}'::jsonb) as tactical,
      coalesce(trim(p_player_name), '') <> ''
        and lower(g.player_name) = lower(trim(p_player_name)) as personalized
    from valid_games g
    cross join lateral jsonb_array_elements(coalesce(g.decisions, '[]'::jsonb)) decision
  ), signals as (
    select
      *,
      coalesce(descriptor->>'phase', split_part(descriptor->>'contextKey', '|', 1), 'route') as phase,
      greatest(
        coalesce(public.long_bot_safe_numeric(descriptor->'riskSignal'), 0),
        coalesce(public.long_bot_safe_numeric(descriptor->'mistakeSeverity'), 0),
        least(6, abs(least(0, coalesce(public.long_bot_safe_numeric(tactical->'worstImpact'), 0))) / 12000000),
        case
          when coalesce(public.long_bot_safe_numeric(features->'trapBefore'), 0) >= 600
            and coalesce(public.long_bot_safe_numeric(features->'trapDelta'), 0) <= 0
            then least(4, coalesce(public.long_bot_safe_numeric(features->'trapBefore'), 0) / 900)
          else 0
        end,
        greatest(0, -coalesce(public.long_bot_safe_numeric(features->'routeTowerDelta'), 0) / 90),
        least(6, greatest(0, -coalesce(
          public.long_bot_safe_numeric(features->'latentFenceExposureDelta'),
          coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureBefore'), 0)
            - coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureAfter'), 0),
          0
        ))),
        least(6, greatest(
          0,
          coalesce(public.long_bot_safe_numeric(features->'avoidableProspectiveFenceInterruptionBreak'), 0) / 18
        )),
        least(6, greatest(
          0,
          coalesce(public.long_bot_safe_numeric(features->'avoidableProspectiveFenceAnchorMiss'), 0) / 18
        )),
        case
          when coalesce(public.long_bot_safe_numeric(features->'maxRouteTowerAfter'), 0) >= 6
            then (coalesce(public.long_bot_safe_numeric(features->'maxRouteTowerAfter'), 0) - 5) * 0.85
          else 0
        end,
        case
          when features ? 'avoidableHomeShuffleMoves'
            and coalesce(public.long_bot_safe_numeric(features->'avoidableHomeShuffleMoves'), 0) > 0
            and coalesce(descriptor->>'phase', '') <> 'bearoff'
            then 1.5
          else 0
        end
      ) as harm_signal,
      case
        when coalesce(trim(p_player_name), '') <> ''
          and lower(player_name) = lower(trim(p_player_name))
          then 3
        else 1
      end as player_weight,
      case
        when actor = 'opponent' and capture_version >= 2 then 4.0
        when actor = 'opponent' then 0.0
        when engine_generation = 34 then 8.0
        when engine_generation = 33 then 7.0
        when engine_generation = 32 then 6.0
        when engine_generation = 31 then 5.0
        when engine_generation = 30 then 4.0
        when engine_generation = 29 then 3.0
        else 0.0
      end as engine_weight
    from raw_decisions
    where coalesce(descriptor->>'contextKey', '') <> ''
      and coalesce(descriptor->>'actionKey', '') <> ''
  -- v8 changes how compatible aggregate aliases are arbitrated by the client.
  -- These labels remain outcome-weighted evidence, not causal per-move attribution.
  ), labeled as (
    select
      *,
      actor = 'bot' and engine_generation in (29, 30, 31, 32, 33, 34) and choice_count > 1
        and winner <> bot_color and harm_signal >= 1.1 as harmful,
      (actor = 'bot' and engine_generation in (29, 30, 31, 32, 33, 34) and choice_count > 1
        and winner = bot_color and harm_signal < 1.1)
        or (
          actor = 'opponent'
          and capture_version >= 2
          and choice_count > 1
          and winner <> bot_color
          and harm_signal < 1.1
        ) as successful
    from signals
  ), expanded as (
    select
      descriptor->>'contextKey' as context_key,
      action.action_key,
      result_type,
      harm_signal,
      harmful,
      successful,
      win_quality,
      player_weight,
      engine_weight,
      personalized,
      completed_at
    from labeled
    cross join lateral (
      select distinct candidate as action_key
      from (values
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then descriptor->>'actionKey' end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then nullif(descriptor->>'strategicActionKey', '') end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then coalesce(
          nullif(descriptor->>'familyActionKey', ''),
          regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
        ) end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then coalesce(
          nullif(descriptor->>'legacyActionKey', ''),
          regexp_replace(
            coalesce(
              nullif(descriptor->>'familyActionKey', ''),
              regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
            ),
            '\|tower:[^|]*$',
            ''
          )
        ) end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then nullif(descriptor->'behaviorActionKeys'->>0, '') end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then nullif(descriptor->'behaviorActionKeys'->>1, '') end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then nullif(descriptor->'behaviorActionKeys'->>2, '') end),
        (case when engine_generation = 34 then nullif(descriptor->'behaviorActionKeys'->>3, '') end),
        (concat(
          'entry:', case
            when coalesce(public.long_bot_safe_numeric(features->'outsideReduction'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'outsideReduction'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|progress:', case
            when coalesce(public.long_bot_safe_numeric(features->'outsidePipGain'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'outsidePipGain'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|home:', case
            when features ? 'avoidableHomeShuffleMoves'
              and coalesce(public.long_bot_safe_numeric(features->'avoidableHomeShuffleMoves'), 0) > 0
              then 'shuffle'
            when features ? 'avoidableHomeShuffleMoves'
              and coalesce(public.long_bot_safe_numeric(features->'homeShuffleMoves'), 0) > 0
              then 'forced'
            when not (features ? 'avoidableHomeShuffleMoves')
              and coalesce(public.long_bot_safe_numeric(features->'homeShuffleMoves'), 0) > 0
              then 'unknown'
            else 'steady'
          end,
          '|tower:', case
            when coalesce(public.long_bot_safe_numeric(features->'routeTowerDelta'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'routeTowerDelta'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|off:', case
            when coalesce(public.long_bot_safe_numeric(features->'bearOffMoves'), 0) > 0 then 'yes'
            else 'no'
          end
        )),
        (concat(
          'trap:', case
            when coalesce(public.long_bot_safe_numeric(features->'trapDelta'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'trapDelta'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|fence:', case
            when coalesce(public.long_bot_safe_numeric(features->'fenceClosureDelta'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'fenceClosureDelta'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|gateway:', case
            when coalesce(public.long_bot_safe_numeric(features->'escapeGatewayDelta'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'escapeGatewayDelta'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|block:', case
            when coalesce(public.long_bot_safe_numeric(features->'opponentMoveBlockGain'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'opponentMoveBlockGain'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|latent:', case
            when coalesce(
              public.long_bot_safe_numeric(features->'latentFenceExposureDelta'),
              coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureBefore'), 0)
                - coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureAfter'), 0),
              0
            ) > 0 then 'gain'
            when coalesce(
              public.long_bot_safe_numeric(features->'latentFenceExposureDelta'),
              coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureBefore'), 0)
                - coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureAfter'), 0),
              0
            ) < 0 then 'loss'
            else 'flat'
          end
        ))
      ) choices(candidate)
      where coalesce(candidate, '') <> ''
    ) action
    where (harmful or successful) and engine_weight > 0
  ), grouped as (
    select
      context_key,
      action_key,
      count(*)::integer as samples,
      count(*) filter (where harmful)::integer as losses,
      count(*) filter (where successful)::integer as wins,
      sum(case
        when harmful then
          player_weight * engine_weight * (
            least(3.75, 0.85 + harm_signal * 0.38)
            + case
              when result_type = 'koks' then 1.5
              when result_type = 'mars' then 0.75
              else 0
            end
          )
        else 0
      end)::double precision as loss_weight,
      count(*) filter (
        where harmful and (result_type in ('mars', 'koks') or harm_signal >= 3.2)
      )::integer as severe_losses,
      sum(case when harmful then harm_signal else 0 end)::double precision as signal_weight,
      sum(case when successful then win_quality * player_weight * engine_weight else 0 end)::double precision as win_weight,
      bool_or(personalized) as personalized,
      max(completed_at) as updated_at
    from expanded
    group by context_key, action_key
  ), eligible as (
    select
      *,
      split_part(context_key, '|', 1) as phase,
      case
        when losses > 0 and (wins = 0 or loss_weight >= win_weight) then 'harmful'
        else 'successful'
      end as cohort
    from grouped
    where losses > 0 or wins > 0
  ), cohort_ranked as (
    select
      *,
      row_number() over (
        partition by phase, cohort
        order by
          personalized desc,
          case when cohort = 'harmful' then severe_losses else 0 end desc,
          case when cohort = 'harmful' then loss_weight else win_weight end desc,
          case when cohort = 'harmful' then losses else wins end desc,
          samples desc
      ) as cohort_rank
    from eligible
  ), ranked as (
    select *
    from cohort_ranked
    where cohort_rank <= 64
    order by
      personalized desc,
      greatest(loss_weight, win_weight) desc,
      severe_losses desc,
      samples desc
    limit 640
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'creditVersion', 8,
      'contextKey', context_key,
      'actionKey', action_key,
      'samples', samples,
      'losses', losses,
      'wins', wins,
      'lossWeight', loss_weight,
      'severeLosses', severe_losses,
      'signalWeight', signal_weight,
      'winWeight', win_weight,
      'updatedAt', updated_at
    ) order by
      personalized desc,
      greatest(loss_weight, win_weight) desc,
      severe_losses desc,
      samples desc
    ),
    '[]'::jsonb
  )
  from ranked
$$;

revoke all on function private.compute_long_bot_experience_patterns(text)
  from public, anon, authenticated, service_role;

create or replace function private.note_long_bot_experience_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_relevant boolean := false;
  new_relevant boolean := false;
  old_key text;
  new_key text;
begin
  if tg_op <> 'INSERT' then
    old_relevant := old.difficulty = 'hard'
      and old.engine_version in (
        'long-analytic-v29',
        'long-analytic-v30',
        'long-analytic-v31',
        'long-analytic-v32',
        'long-analytic-v33',
        'long-analytic-v34'
      );
    if old_relevant then
      old_key := pg_catalog.lower(pg_catalog.btrim(old.player_name));
    end if;
  end if;

  if tg_op <> 'DELETE' then
    new_relevant := new.difficulty = 'hard'
      and new.engine_version in (
        'long-analytic-v29',
        'long-analytic-v30',
        'long-analytic-v31',
        'long-analytic-v32',
        'long-analytic-v33',
        'long-analytic-v34'
      );
    if new_relevant then
      new_key := pg_catalog.lower(pg_catalog.btrim(new.player_name));
    end if;
  end if;

  if old_relevant or new_relevant then
    -- The committed ledger row is the immediate invalidation signal. Keeping
    -- the trigger append-only avoids blocking game finalization behind a
    -- background worker that may currently hold cache-key row locks.
    insert into private.long_bot_experience_changes(old_player_key, new_player_key)
    values (old_key, new_key);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.note_long_bot_experience_change()
  from public, anon, authenticated, service_role;

create or replace function private.refresh_long_bot_experience_cache(
  p_batch_size integer default 2
)
returns integer
language plpgsql
security definer
set search_path = ''
set statement_timeout = '2min'
as $$
declare
  effective_batch_size integer := greatest(
    1,
    least(coalesce(p_batch_size, 2), 8)
  );
  target_player_key text;
  computed_patterns jsonb;
  refreshed_count integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(20151, 3308) then
    return 0;
  end if;

  -- Consume exactly the ledger rows visible to this statement. A concurrent
  -- commit stays in the ledger for the next run, so no invalidation is lost.
  with consumed_changes as (
    delete from private.long_bot_experience_changes
    returning old_player_key, new_player_key
  ), keys_to_dirty(player_key) as (
    -- Personalized aggregates include shared evidence, therefore every real
    -- game change invalidates every existing personalized key.
    select ''::text
    where exists (select 1 from consumed_changes)
    union
    select cache_key.player_key
    from private.long_bot_experience_cache_keys cache_key
    where exists (select 1 from consumed_changes)
    union
    select old_player_key
    from consumed_changes
    where old_player_key is not null
    union
    select new_player_key
    from consumed_changes
    where new_player_key is not null
  )
  insert into private.long_bot_experience_cache_keys(player_key, dirty)
  select player_key, true
  from keys_to_dirty
  on conflict (player_key) do update
    set dirty = true;

  for target_player_key in
    select cache_key.player_key
    from private.long_bot_experience_cache_keys cache_key
    left join private.long_bot_experience_cache cached
      on cached.player_key = cache_key.player_key
    where cache_key.dirty
       or cached.player_key is null
       or cached.refreshed_at < pg_catalog.clock_timestamp() - interval '1 hour'
    -- Keep the global fallback responsive to every invalidation, but reserve
    -- the second slot for maintenance once a cache is more than two hours old.
    -- Without that hard-age lane, a steady stream of global/player dirty pairs
    -- can starve an inactive personalized cache forever.
    order by
      (
        cache_key.player_key = ''
        and (cache_key.dirty or cached.player_key is null)
      ) desc,
      coalesce((
        cached.refreshed_at < pg_catalog.clock_timestamp() - interval '2 hours'
      ), false) desc,
      (cached.player_key is null) desc,
      cache_key.dirty desc,
      (cache_key.player_key = '') desc,
      cached.refreshed_at asc nulls first,
      cache_key.player_key
    limit effective_batch_size
  loop
    computed_patterns := private.compute_long_bot_experience_patterns(
      nullif(target_player_key, '')
    );
    if pg_catalog.jsonb_typeof(computed_patterns) is distinct from 'array' then
      raise exception 'Long-bot experience builder returned a non-array payload.';
    end if;

    insert into private.long_bot_experience_cache(player_key, patterns, refreshed_at)
    values (target_player_key, computed_patterns, pg_catalog.clock_timestamp())
    on conflict (player_key) do update
      set patterns = excluded.patterns,
          refreshed_at = excluded.refreshed_at;

    update private.long_bot_experience_cache_keys
    set dirty = false
    where player_key = target_player_key;

    refreshed_count := refreshed_count + 1;
  end loop;

  return refreshed_count;
end;
$$;

revoke all on function private.refresh_long_bot_experience_cache(integer)
  from public, anon, authenticated, service_role;

insert into private.long_bot_experience_cache_keys(player_key)
values ('')
on conflict (player_key) do nothing;

insert into private.long_bot_experience_cache_keys(player_key)
select distinct pg_catalog.lower(g.player_name)
from public.bot_training_games g
where g.difficulty = 'hard'
  and g.engine_version in (
    'long-analytic-v29',
    'long-analytic-v30',
    'long-analytic-v31',
    'long-analytic-v32',
    'long-analytic-v33',
    'long-analytic-v34'
  )
  and g.completed_at >= pg_catalog.now() - interval '180 days'
  and pg_catalog.btrim(g.player_name) <> ''
  and g.player_name = pg_catalog.btrim(g.player_name)
on conflict (player_key) do nothing;

do $bootstrap$
declare
  refreshed_count integer;
begin
  update private.long_bot_experience_cache_keys
  set dirty = true;

  perform pg_catalog.pg_advisory_xact_lock(20151, 3308);
  loop
    refreshed_count := private.refresh_long_bot_experience_cache(8);
    -- Bootstrap is complete once every key invalidated above has a cache row.
    -- Do not wait for the worker's hourly maintenance queue to become empty:
    -- on a large dataset the earliest rows can age back into that queue before
    -- the initial pass finishes, which would keep this migration open forever.
    exit when not exists (
      select 1
      from private.long_bot_experience_cache_keys cache_key
      left join private.long_bot_experience_cache cached
        on cached.player_key = cache_key.player_key
      where cache_key.dirty
         or cached.player_key is null
    );
    if refreshed_count = 0 then
      raise exception 'Long-bot experience cache bootstrap made no progress.';
    end if;
  end loop;

  if not exists (
    select 1
    from private.long_bot_experience_cache
    where player_key = ''
      and pg_catalog.jsonb_typeof(patterns) = 'array'
  ) then
    raise exception 'Long-bot experience cache bootstrap failed.';
  end if;
end;
$bootstrap$;

drop trigger if exists note_long_bot_experience_change
  on public.bot_training_games;
create trigger note_long_bot_experience_change
after insert or update or delete on public.bot_training_games
for each row execute function private.note_long_bot_experience_change();

-- Close the bootstrap race after the trigger has taken its short table lock.
insert into private.long_bot_experience_cache_keys(player_key)
select distinct pg_catalog.lower(g.player_name)
from public.bot_training_games g
where g.difficulty = 'hard'
  and g.engine_version in (
    'long-analytic-v29',
    'long-analytic-v30',
    'long-analytic-v31',
    'long-analytic-v32',
    'long-analytic-v33',
    'long-analytic-v34'
  )
  and g.completed_at >= pg_catalog.now() - interval '180 days'
  and pg_catalog.btrim(g.player_name) <> ''
  and g.player_name = pg_catalog.btrim(g.player_name)
on conflict (player_key) do nothing;

insert into private.long_bot_experience_changes(old_player_key, new_player_key)
values (null, null);

drop function if exists public.get_long_bot_experience_patterns();
drop function if exists public.get_long_bot_experience_patterns(text);

create or replace function public.get_long_bot_experience_patterns(
  p_player_name text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select cached.patterns
      from private.long_bot_experience_cache cached
      join private.long_bot_experience_cache_keys cache_key
        on cache_key.player_key = cached.player_key
      where cached.player_key = pg_catalog.lower(
        pg_catalog.btrim(coalesce(p_player_name, ''))
      )
        and not cache_key.dirty
        and not exists (
          select 1 from private.long_bot_experience_changes pending_change
        )
    ),
    (
      select cached.patterns
      from private.long_bot_experience_cache cached
      join private.long_bot_experience_cache_keys cache_key
        on cache_key.player_key = cached.player_key
      where cached.player_key = ''
        and not cache_key.dirty
        and not exists (
          select 1 from private.long_bot_experience_changes pending_change
        )
    ),
    -- During the short worker window, retain the last coherent snapshot rather
    -- than returning an indistinguishable empty history that a new game would
    -- freeze for its entire session.  Once the worker commits, the clean global
    -- row above supersedes any still-dirty personalized row.
    (
      select cached.patterns
      from private.long_bot_experience_cache cached
      where cached.player_key = pg_catalog.lower(
        pg_catalog.btrim(coalesce(p_player_name, ''))
      )
    ),
    (
      select cached.patterns
      from private.long_bot_experience_cache cached
      where cached.player_key = ''
    ),
    '[]'::jsonb
  )
$$;

revoke all on function public.get_long_bot_experience_patterns(text) from public;
grant execute on function public.get_long_bot_experience_patterns(text) to anon, authenticated;

do $cron_jobs$
declare
  old_job record;
begin
  for old_job in
    select jobid
    from cron.job
    where jobname in (
      'refresh-long-bot-experience-v33',
      'cleanup-long-bot-experience-v33-job-history',
      'refresh-long-bot-experience-v34',
      'cleanup-long-bot-experience-v34-job-history'
    )
  loop
    perform cron.unschedule(old_job.jobid);
    delete from cron.job_run_details
    where jobid = old_job.jobid;
  end loop;

  perform cron.schedule(
    'refresh-long-bot-experience-v34',
    '* * * * *',
    $command$
      set statement_timeout = '2min';
      select private.refresh_long_bot_experience_cache(8);
    $command$
  );
  perform cron.schedule(
    'cleanup-long-bot-experience-v34-job-history',
    '17 3 * * *',
    $command$
      set statement_timeout = '2min';
      select pg_catalog.pg_advisory_xact_lock(20151, 3308);
      delete from private.long_bot_experience_cache_keys cache_key
      where cache_key.player_key <> ''
        and not exists (
          select 1
          from public.bot_training_games game
          where game.difficulty = 'hard'
            and game.engine_version in (
              'long-analytic-v29',
              'long-analytic-v30',
              'long-analytic-v31',
              'long-analytic-v32',
              'long-analytic-v33',
              'long-analytic-v34'
            )
            and game.completed_at >= pg_catalog.now() - interval '180 days'
            and game.player_name = pg_catalog.btrim(game.player_name)
            and pg_catalog.lower(game.player_name) = cache_key.player_key
        );
      delete from cron.job_run_details details
      where details.jobid in (
        select job.jobid
        from cron.job job
        where job.jobname in (
          'refresh-long-bot-experience-v34',
          'cleanup-long-bot-experience-v34-job-history'
        )
      )
        and details.end_time < pg_catalog.now() - interval '7 days';
    $command$
  );
end;
$cron_jobs$;

notify pgrst, 'reload schema';

commit;
