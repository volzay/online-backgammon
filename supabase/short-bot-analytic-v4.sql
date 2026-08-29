-- Isolate v4 WildBG decisions from the materially different Pubeval policies.

drop function if exists public.get_short_bot_experience_patterns(text);

create or replace function public.get_short_bot_experience_patterns(
  p_player_name text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with decisions as (
    select
      g.winner, g.bot_color, g.result_type, g.player_name,
      coalesce(nullif(decision->>'actor', ''), 'bot') as actor,
      greatest(0.75, least(4, coalesce(nullif(decision->>'winQuality', '')::numeric, 1))) as win_quality,
      coalesce(decision->'experience', decision->'selected'->'experience') as descriptor,
      case when coalesce(trim(p_player_name), '') <> ''
        and lower(g.player_name) = lower(trim(p_player_name)) then 3 else 1 end as player_weight
    from public.bot_training_games g
    cross join lateral jsonb_array_elements(coalesce(g.decisions, '[]'::jsonb)) decision
    where g.difficulty = 'hard'
      and g.engine_version like 'short-analytic-v4%'
      and g.completed_at >= now() - interval '180 days'
  ), labeled as (
    select descriptor->>'contextKey' as context_key,
      descriptor->>'actionKey' as action_key, player_weight,
      greatest(0, coalesce(nullif(descriptor->>'mistakeSeverity', '')::numeric, 0)) as severity,
      actor = 'bot' and winner <> bot_color as harmful,
      (actor = 'bot' and winner = bot_color) or (actor = 'opponent' and winner <> bot_color) as successful,
      result_type, win_quality
    from decisions
    where coalesce(descriptor->>'contextKey', '') <> ''
      and coalesce(descriptor->>'actionKey', '') <> ''
  ), grouped as (
    select context_key, action_key,
      sum(player_weight)::integer as samples,
      sum(case when harmful then player_weight else 0 end)::integer as losses,
      sum(case when successful then player_weight else 0 end)::integer as wins,
      sum(case when harmful then player_weight * (
        0.85 + least(3.75, severity * 0.38)
        + case when result_type = 'koks' then 1.5 when result_type = 'mars' then 0.75 else 0 end
      ) else 0 end)::double precision as loss_weight,
      sum(case when harmful and result_type in ('mars', 'koks') then player_weight else 0 end)::integer as severe_losses,
      sum(case when harmful then severity * player_weight else 0 end)::double precision as signal_weight,
      sum(case when successful then win_quality * player_weight else 0 end)::double precision as win_weight
    from labeled
    group by context_key, action_key
    order by samples desc, loss_weight desc
    limit 480
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'creditVersion', 4, 'contextKey', context_key, 'actionKey', action_key,
    'samples', samples, 'losses', losses, 'wins', wins,
    'lossWeight', loss_weight, 'severeLosses', severe_losses,
    'signalWeight', signal_weight, 'winWeight', win_weight
  ) order by samples desc, loss_weight desc), '[]'::jsonb)
  from grouped
$$;

revoke all on function public.get_short_bot_experience_patterns(text) from public;
grant execute on function public.get_short_bot_experience_patterns(text) to anon, authenticated;
