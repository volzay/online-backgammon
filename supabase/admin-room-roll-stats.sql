begin;

-- A bounded admin projection: the collection view gets counters, never the
-- complete history, signed dice proofs, positions or training decisions.
create or replace function public.admin_room_roll_stats(p_room_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  room public.rooms%rowtype;
  selected_state jsonb;
  selected_source text;
  selected_completed_at timestamptz;
  selected_bot_color text;
  selected_player_color text;
  history jsonb;
  history_available boolean;
  white_rolls integer;
  dark_rolls integer;
  white_doubles integer;
  dark_doubles integer;
  total_rolls integer;
  total_doubles integer;
  last_roll jsonb;
  result jsonb := '[]'::jsonb;
begin
  if auth.role() is distinct from 'authenticated'
     or not coalesce(public.is_admin_user(), false) then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;
  if p_room_ids is null or cardinality(p_room_ids) > 500
     or coalesce(array_ndims(p_room_ids), 1) <> 1 then
    raise exception 'At most 500 room IDs are required.' using errcode = '22023';
  end if;
  if array_position(p_room_ids, null) is not null then
    raise exception 'At most 500 room IDs are required.' using errcode = '22023';
  end if;

  for room in
    select r.* from public.rooms r
    where r.id = any(p_room_ids)
    order by r.id
  loop
    selected_state := coalesce(room.game_state, '{}'::jsonb);
    selected_source := 'live';
    selected_completed_at := null;
    selected_bot_color := null;
    if coalesce(selected_state->>'winner', '') not in ('white', 'dark') then
      select candidate.final_state, candidate.source, candidate.completed_at,
             candidate.bot_color
      into selected_state, selected_source, selected_completed_at, selected_bot_color
      from (
        select a.final_state, 'room_archive'::text as source, a.completed_at,
               null::text as bot_color, a.id::text as candidate_id
        from public.room_game_archives a
        where a.room_id = room.id
        union all
        select g.final_state, 'training_archive'::text, g.completed_at,
               g.bot_color, g.id::text
        from public.bot_training_games g
        where g.room_code = room.code and g.winner in ('white', 'dark')
          and not exists (
            select 1 from public.room_game_archives canonical
            where canonical.room_id = room.id
              and nullif(g.final_state->>'finishedAt', '') is not null
              and canonical.final_state->>'finishedAt' = g.final_state->>'finishedAt'
              and canonical.winner = g.winner
          )
      ) candidate
      order by candidate.completed_at desc nulls last,
               candidate.source, candidate.candidate_id
      limit 1;
      if not found then
        selected_state := coalesce(room.game_state, '{}'::jsonb);
        selected_source := 'live';
        selected_completed_at := null;
        selected_bot_color := null;
      end if;
    end if;

    history := selected_state->'history';
    history_available := jsonb_typeof(history) = 'array';
    if not coalesce(history_available, false) then
      history := '[]'::jsonb;
      history_available := false;
    elsif jsonb_array_length(history) = 0
       and (selected_source <> 'live'
         or coalesce(selected_state->>'winner', '') in ('white', 'dark')) then
      -- Compact training snapshots omit the history. Absence is not zero.
      history_available := false;
    end if;

    with valid_events as (
      select entry.event, entry.ordinal,
        case when jsonb_typeof(entry.event#>'{fairDiceProof,request,id}') = 'string'
               and entry.event#>>'{fairDiceProof,request,id}' <> ''
             then 'proof:' || (entry.event#>>'{fairDiceProof,request,id}')
             else 'event:' || entry.ordinal::text end as event_key
      from jsonb_array_elements(history) with ordinality entry(event, ordinal)
      where jsonb_typeof(entry.event->'roll') = 'string'
        and entry.event->>'roll' ~ '^[1-6]:[1-6]$'
        and entry.event->>'color' in ('white', 'dark')
        and coalesce(entry.event->'opening', 'null'::jsonb)
            in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
        and coalesce(entry.event->'openingRoll', 'null'::jsonb)
            in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
        and coalesce(entry.event#>>'{fairDiceProof,request,label}', '') <> 'opening'
    ), numbered as (
      select event, ordinal,
        row_number() over (partition by event_key order by ordinal) as occurrence
      from valid_events
    ), rolls as (
      select event, ordinal from numbered where occurrence = 1
    )
    select
      count(*) filter (where event->>'color' = 'white'),
      count(*) filter (where event->>'color' = 'dark'),
      count(*) filter (where event->>'color' = 'white'
        and left(event->>'roll', 1) = right(event->>'roll', 1)),
      count(*) filter (where event->>'color' = 'dark'
        and left(event->>'roll', 1) = right(event->>'roll', 1)),
      (select jsonb_build_object('color', event->'color', 'roll', event->'roll',
         'at', case when jsonb_typeof(event->'at') = 'string'
                     and length(event->>'at') <= 64 then event->'at' else 'null'::jsonb end,
         'sha256', case when jsonb_typeof(event->'sha256') = 'string'
                         and event->>'sha256' ~ '^[0-9a-f]{64}$'
                        then event->'sha256' else 'null'::jsonb end)
       from rolls order by ordinal limit 1)
    into white_rolls, dark_rolls, white_doubles, dark_doubles, last_roll
    from rolls;

    total_rolls := white_rolls + dark_rolls;
    total_doubles := white_doubles + dark_doubles;
    selected_player_color := null;
    if selected_state->>'mode' = 'bot' or selected_source = 'training_archive' then
      selected_player_color := case
        when selected_state#>>'{analysis,playerColor}' in ('white', 'dark')
          then selected_state#>>'{analysis,playerColor}'
        when selected_state#>>'{analysis,botMemory,outcome,botColor}' = 'white' then 'dark'
        when selected_state#>>'{analysis,botMemory,outcome,botColor}' = 'dark' then 'white'
        when selected_bot_color = 'white' then 'dark'
        when selected_bot_color = 'dark' then 'white'
        else null end;
    end if;

    result := result || jsonb_build_array(jsonb_build_object(
      'roomId', room.id,
      'rolls', total_rolls,
      'doubles', total_doubles,
      'doubleRate', case when total_rolls > 0 then total_doubles::numeric / total_rolls else 0 end,
      'lastRoll', last_roll,
      'byColor', jsonb_build_object(
        'white', jsonb_build_object('rolls', white_rolls, 'doubles', white_doubles,
          'doubleRate', case when white_rolls > 0 then white_doubles::numeric / white_rolls else 0 end),
        'dark', jsonb_build_object('rolls', dark_rolls, 'doubles', dark_doubles,
          'doubleRate', case when dark_rolls > 0 then dark_doubles::numeric / dark_rolls else 0 end)),
      'historyAvailable', history_available,
      'playerColor', selected_player_color,
      'gameSource', selected_source,
      'gameCompletedAt', selected_completed_at
    ));
  end loop;
  return result;
end;
$$;

revoke all on function public.admin_room_roll_stats(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.admin_room_roll_stats(uuid[]) to authenticated;

commit;
