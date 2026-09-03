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

  -- v29 experience is valid only when every expected bot turn was captured.
  -- Older long archives and short games remain readable and keep their
  -- existing archival behavior, but cannot accidentally satisfy this gate.
  if coalesce(target_state->>'variant', new.variant) = 'long'
    and coalesce(memory->>'engineVersion', '') = 'long-analytic-v29' then
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

  if p_final_state is not null
    and coalesce(target_room.game_state->>'winner', '') = ''
    and nullif(target_room.game_state->>'startedAt', '') is not null
    and target_room.game_state->>'startedAt' = target_state->>'startedAt' then
    update public.rooms
    set
      game_state = target_state,
      game_version = game_version + 1,
      status = 'over',
      archived_at = now(),
      closed_reason = 'finished'
    where id = target_room.id
    returning * into target_room;
  end if;

  memory := coalesce(target_state->'analysis'->'botMemory', '{}'::jsonb);
  decisions := coalesce(memory->'decisions', '[]'::jsonb);
  if jsonb_typeof(decisions) <> 'array' then
    decisions := '[]'::jsonb;
  end if;
  coverage := coalesce(memory->'coverage', '{}'::jsonb);
  if coalesce(target_state->>'variant', target_room.variant) = 'long'
    and coalesce(memory->>'engineVersion', '') = 'long-analytic-v29' then
    if jsonb_typeof(coverage) <> 'object'
      or coalesce(coverage->'complete', 'false'::jsonb) <> 'true'::jsonb
      or jsonb_typeof(coverage->'expectedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recordedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recoveredBotDecisions') <> 'number'
      or coalesce(coverage->>'expectedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recordedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recoveredBotDecisions', '') !~ '^[0-9]+$' then
      raise exception 'Long bot v29 training payload has incomplete decision coverage.';
    end if;
    if (coverage->>'expectedBotDecisions')::numeric <= 0
      or (coverage->>'expectedBotDecisions')::numeric <>
        (coverage->>'recordedBotDecisions')::numeric
          + (coverage->>'recoveredBotDecisions')::numeric then
      raise exception 'Long bot v29 training payload has inconsistent decision coverage.';
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

drop function if exists public.get_long_bot_experience_patterns();
drop function if exists public.get_long_bot_experience_patterns(text);

create or replace function public.get_long_bot_experience_patterns(
  p_player_name text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with valid_games as (
    select g.*
    from public.bot_training_games g
    where g.difficulty = 'hard'
      and g.engine_version = 'long-analytic-v29'
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
      ) = (
        select count(*)::numeric
        from jsonb_array_elements(case
          when jsonb_typeof(g.decisions) = 'array' then g.decisions
          else '[]'::jsonb
        end) covered(decision)
        where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
      )
      and not exists (
        select 1
        from jsonb_array_elements(case
          when jsonb_typeof(g.decisions) = 'array' then g.decisions
          else '[]'::jsonb
        end) incompatible(decision)
        where not (
          (
            coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
            and (
              (
                decision->>'source' = 'engine'
                and decision->>'engineVersion' = 'long-analytic-v29'
                and coalesce(decision->'experienceFrozen', 'false'::jsonb) = 'true'::jsonb
                and coalesce(decision->>'experienceFingerprint', '') <> ''
              )
              or (
                decision->>'source' = 'history-recovery'
                and coalesce(public.long_bot_safe_numeric(decision->'captureVersion'), 0) >= 2
                and decision->>'engineVersion' = 'long-analytic-v29'
              )
            )
          )
          or (
            decision->>'actor' = 'opponent'
            and coalesce(public.long_bot_safe_numeric(decision->'captureVersion'), 0) >= 2
            and decision->>'engineVersion' = 'long-analytic-v29'
          )
        )
      )
      and (
        select count(distinct decision->>'experienceFingerprint')
        from jsonb_array_elements(case
          when jsonb_typeof(g.decisions) = 'array' then g.decisions
          else '[]'::jsonb
        end) fingerprinted(decision)
        where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
          and decision->>'source' = 'engine'
      ) <= 1
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
        case
          when coalesce(public.long_bot_safe_numeric(features->'maxRouteTowerAfter'), 0) >= 6
            then (coalesce(public.long_bot_safe_numeric(features->'maxRouteTowerAfter'), 0) - 5) * 0.85
          else 0
        end,
        case
          when features ? 'avoidableHomeShuffleMoves'
            and coalesce(public.long_bot_safe_numeric(features->'avoidableHomeShuffleMoves'), 0) > 0
            and coalesce(descriptor->>'phase', '') <> 'bearoff'
            and (
              coalesce(public.long_bot_safe_numeric(features->'outsideReduction'), 0) <= 0
              or coalesce(descriptor->>'phase', split_part(descriptor->>'contextKey', '|', 1), '')
                in ('route', 'head-development')
              or split_part(descriptor->>'contextKey', '|', 3) in ('o3', 'o4')
            )
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
        when engine_generation = 29 then 4.0
        else 0.0
      end as engine_weight
    from raw_decisions
    where coalesce(descriptor->>'contextKey', '') <> ''
      and coalesce(descriptor->>'actionKey', '') <> ''
  ), labeled as (
    select
      *,
      actor = 'bot' and engine_generation = 29 and choice_count > 1
        and winner <> bot_color and harm_signal >= 1.1 as harmful,
      (actor = 'bot' and engine_generation = 29 and choice_count > 1
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
        (case when engine_generation = 29 then descriptor->>'actionKey' end),
        (case when engine_generation = 29 then nullif(descriptor->>'strategicActionKey', '') end),
        (case when engine_generation = 29 then coalesce(
          nullif(descriptor->>'familyActionKey', ''),
          regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
        ) end),
        (case when engine_generation = 29 then coalesce(
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
        (case when engine_generation = 29 then nullif(descriptor->'behaviorActionKeys'->>0, '') end),
        (case when engine_generation = 29 then nullif(descriptor->'behaviorActionKeys'->>1, '') end),
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
      'creditVersion', 6,
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

revoke all on function public.get_long_bot_experience_patterns(text) from public;
grant execute on function public.get_long_bot_experience_patterns(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
