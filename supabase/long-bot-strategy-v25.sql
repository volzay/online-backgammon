begin;

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
  with raw_decisions as (
    select
      g.winner,
      g.bot_color,
      g.result_type,
      g.player_name,
      coalesce(
        nullif(substring(g.engine_version from 'v([0-9]{1,4})$'), '')::integer,
        0
      ) as engine_generation,
      coalesce(nullif(decision->>'actor', ''), 'bot') as actor,
      greatest(0.75, least(4, coalesce(public.long_bot_safe_numeric(decision->'winQuality'), 1))) as win_quality,
      coalesce(decision->'experience', decision->'selected'->'experience') as descriptor,
      coalesce(decision->'selected'->'features', '{}'::jsonb) as features,
      coalesce(decision->'selected'->'tactical', '{}'::jsonb) as tactical,
      coalesce(trim(p_player_name), '') <> ''
        and lower(g.player_name) = lower(trim(p_player_name)) as personalized
    from public.bot_training_games g
    cross join lateral jsonb_array_elements(coalesce(g.decisions, '[]'::jsonb)) decision
    where g.difficulty = 'hard'
      and g.engine_version like 'long-analytic-%'
      and g.completed_at >= now() - interval '180 days'
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
        when actor = 'opponent' then 4.0
        when engine_generation >= 25 then 4.0
        when engine_generation >= 24 then 3.0
        when engine_generation >= 23 then 1.0
        when engine_generation >= 22 then 0.75
        when engine_generation >= 20 then 0.5
        else 0.0
      end as engine_weight
    from raw_decisions
    where coalesce(descriptor->>'contextKey', '') <> ''
      and coalesce(descriptor->>'actionKey', '') <> ''
  ), labeled as (
    select
      *,
      actor = 'bot' and winner <> bot_color and harm_signal >= 1.1 as harmful,
      (actor = 'bot' and winner = bot_color and harm_signal < 1.1)
        or (actor = 'opponent' and winner <> bot_color and harm_signal < 1.1) as successful
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
      personalized
    from labeled
    cross join lateral (
      select distinct candidate as action_key
      from (values
        (case when engine_generation >= 25 then descriptor->>'actionKey' end),
        (case when engine_generation >= 25 then nullif(descriptor->>'strategicActionKey', '') end),
        (case when engine_generation >= 25 then coalesce(
          nullif(descriptor->>'familyActionKey', ''),
          regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
        ) end),
        (case when engine_generation >= 25 then coalesce(
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
        (case when engine_generation >= 25 then nullif(descriptor->'behaviorActionKeys'->>0, '') end),
        (case when engine_generation >= 25 then nullif(descriptor->'behaviorActionKeys'->>1, '') end),
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
      bool_or(personalized) as personalized
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
      'creditVersion', 4,
      'contextKey', context_key,
      'actionKey', action_key,
      'samples', samples,
      'losses', losses,
      'wins', wins,
      'lossWeight', loss_weight,
      'severeLosses', severe_losses,
      'signalWeight', signal_weight,
      'winWeight', win_weight
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
