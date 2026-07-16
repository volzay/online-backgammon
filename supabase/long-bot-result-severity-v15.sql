-- Isolated production migration: distinguish Koks from Mars in hard-bot learning.
-- Run as the owner of public.get_long_bot_experience_patterns().

begin;

create or replace function public.get_long_bot_experience_patterns()
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
      coalesce(decision->'experience', decision->'selected'->'experience') as descriptor,
      coalesce(decision->'selected'->'features', '{}'::jsonb) as features,
      coalesce(decision->'selected'->'tactical', '{}'::jsonb) as tactical
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
        coalesce(nullif(descriptor->>'riskSignal', '')::numeric, 0),
        coalesce(nullif(descriptor->>'mistakeSeverity', '')::numeric, 0),
        least(6, abs(least(0, coalesce(nullif(tactical->>'worstImpact', '')::numeric, 0))) / 12000000),
        case
          when coalesce(nullif(features->>'trapBefore', '')::numeric, 0) >= 600
            and coalesce(nullif(features->>'trapDelta', '')::numeric, 0) <= 0
            then least(4, coalesce(nullif(features->>'trapBefore', '')::numeric, 0) / 900)
          else 0
        end,
        greatest(0, -coalesce(nullif(features->>'routeTowerDelta', '')::numeric, 0) / 90),
        case
          when coalesce(nullif(features->>'maxRouteTowerAfter', '')::numeric, 0) >= 6
            then (coalesce(nullif(features->>'maxRouteTowerAfter', '')::numeric, 0) - 5) * 0.85
          else 0
        end,
        case
          when coalesce(nullif(features->>'homeShuffleMoves', '')::numeric, 0) > 0
            and coalesce(nullif(features->>'outsideReduction', '')::numeric, 0) <= 0
            and coalesce(descriptor->>'phase', '') <> 'bearoff'
            then 1.5
          else 0
        end
      ) as harm_signal
    from raw_decisions
    where coalesce(descriptor->>'contextKey', '') <> ''
      and coalesce(descriptor->>'actionKey', '') <> ''
  ), labeled as (
    select
      *,
      winner <> bot_color and harm_signal >= 1.1 as harmful
    from signals
  ), expanded as (
    select
      descriptor->>'contextKey' as context_key,
      action.action_key,
      result_type,
      harm_signal,
      harmful
    from labeled
    cross join lateral (
      select distinct candidate as action_key
      from (values
        (descriptor->>'actionKey'),
        (coalesce(
          nullif(descriptor->>'familyActionKey', ''),
          regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
        )),
        (coalesce(
          nullif(descriptor->>'legacyActionKey', ''),
          regexp_replace(
            coalesce(
              nullif(descriptor->>'familyActionKey', ''),
              regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
            ),
            '\|tower:[^|]*$',
            ''
          )
        ))
      ) choices(candidate)
      where coalesce(candidate, '') <> ''
    ) action
  ), grouped as (
    select
      context_key,
      action_key,
      count(*)::integer as samples,
      count(*) filter (where harmful)::integer as losses,
      sum(case
        when harmful then
          least(3.75, 0.85 + harm_signal * 0.38)
          + case
            when result_type = 'koks' then 1.5
            when result_type = 'mars' then 0.75
            else 0
          end
        else 0
      end)::double precision as loss_weight,
      count(*) filter (
        where harmful and (result_type in ('mars', 'koks') or harm_signal >= 3.2)
      )::integer as severe_losses,
      sum(case when harmful then harm_signal else 0 end)::double precision as signal_weight
    from expanded
    group by context_key, action_key
  ), ranked as (
    select *
    from grouped
    order by samples desc, loss_weight desc, signal_weight desc
    limit 480
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'creditVersion', 2,
      'contextKey', context_key,
      'actionKey', action_key,
      'samples', samples,
      'losses', losses,
      'lossWeight', loss_weight,
      'severeLosses', severe_losses,
      'signalWeight', signal_weight
    ) order by samples desc, loss_weight desc, signal_weight desc),
    '[]'::jsonb
  )
  from ranked
$$;

revoke all on function public.get_long_bot_experience_patterns() from public;
grant execute on function public.get_long_bot_experience_patterns() to anon, authenticated;

commit;
