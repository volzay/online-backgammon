-- Enable durable learning for the analytical short-backgammon bot.

do $migration$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('public.archive_bot_training_game(text,jsonb)'::regprocedure)
  into function_sql;

  if position('not in (''long'', ''short'')' in lower(function_sql)) > 0 then
    return;
  end if;
  updated_sql := replace(
    function_sql,
    'coalesce(target_state ->> ''variant''::text, target_room.variant) <> ''long''::text',
    'coalesce(target_state ->> ''variant''::text, target_room.variant) not in (''long'', ''short'')'
  );
  updated_sql := replace(
    updated_sql,
    'coalesce(target_state->>''variant'', target_room.variant) <> ''long''',
    'coalesce(target_state->>''variant'', target_room.variant) not in (''long'', ''short'')'
  );
  updated_sql := replace(
    updated_sql,
    'This room is not a hard long-bot game.',
    'This room is not a hard bot game.'
  );
  if updated_sql = function_sql then
    raise exception 'archive_bot_training_game definition was not recognized';
  end if;
  execute updated_sql;
end
$migration$;

do $migration$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef('public.archive_finished_bot_training_game()'::regprocedure)
  into function_sql;
  if position('not in (''long'', ''short'')' in lower(function_sql)) > 0 then
    return;
  end if;
  updated_sql := replace(
    function_sql,
    'coalesce(target_state->>''variant'', new.variant) <> ''long''',
    'coalesce(target_state->>''variant'', new.variant) not in (''long'', ''short'')'
  );
  updated_sql := replace(
    updated_sql,
    'coalesce(target_state ->> ''variant''::text, new.variant) <> ''long''::text',
    'coalesce(target_state ->> ''variant''::text, new.variant) not in (''long'', ''short'')'
  );
  if updated_sql = function_sql then
    raise exception 'archive_finished_bot_training_game definition was not recognized';
  end if;
  execute updated_sql;
end
$migration$;

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
      and g.engine_version like 'short-analytic-%'
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
    'creditVersion', 1, 'contextKey', context_key, 'actionKey', action_key,
    'samples', samples, 'losses', losses, 'wins', wins,
    'lossWeight', loss_weight, 'severeLosses', severe_losses,
    'signalWeight', signal_weight, 'winWeight', win_weight
  ) order by samples desc, loss_weight desc), '[]'::jsonb)
  from grouped
$$;

revoke all on function public.get_short_bot_experience_patterns(text) from public;
grant execute on function public.get_short_bot_experience_patterns(text) to anon, authenticated;
