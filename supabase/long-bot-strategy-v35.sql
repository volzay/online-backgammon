begin;

-- v35 intentionally does not participate in the outcome-labelled experience
-- aggregate.  It still has to satisfy the same durable decision-coverage
-- contract as v29-v34 on every server-side archive path.
create or replace function private.long_bot_v35_training_memory_is_complete(
  p_memory jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(coalesce(p_memory, '{}'::jsonb)) is distinct from 'object'
      or coalesce(p_memory->>'engineVersion', '') <> 'long-analytic-v35'
      or jsonb_typeof(p_memory->'decisions') is distinct from 'array'
      or jsonb_typeof(p_memory->'coverage') is distinct from 'object'
      or coalesce(p_memory->'coverage'->'complete', 'false'::jsonb) <> 'true'::jsonb
      or jsonb_typeof(p_memory->'coverage'->'expectedBotDecisions') is distinct from 'number'
      or jsonb_typeof(p_memory->'coverage'->'recordedBotDecisions') is distinct from 'number'
      or jsonb_typeof(p_memory->'coverage'->'recoveredBotDecisions') is distinct from 'number'
      or coalesce(p_memory->'coverage'->>'expectedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(p_memory->'coverage'->>'recordedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(p_memory->'coverage'->>'recoveredBotDecisions', '') !~ '^[0-9]+$'
      then false
    else
      (p_memory->'coverage'->>'expectedBotDecisions')::numeric > 0
      and (p_memory->'coverage'->>'expectedBotDecisions')::numeric =
        (p_memory->'coverage'->>'recordedBotDecisions')::numeric
          + (p_memory->'coverage'->>'recoveredBotDecisions')::numeric
      and (
        select count(*)
        from jsonb_array_elements(p_memory->'decisions') decision
        where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
      ) = (p_memory->'coverage'->>'expectedBotDecisions')::numeric
      and not exists (
        select 1
        from jsonb_array_elements(p_memory->'decisions') decision
        where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
          and coalesce(decision->>'engineVersion', '') <> 'long-analytic-v35'
      )
  end
$$;

revoke all on function private.long_bot_v35_training_memory_is_complete(jsonb)
from public, anon, authenticated, service_role;

-- A game begun under v34 and resumed under v35 can otherwise report complete
-- numeric coverage while carrying a mixed policy ledger. Keep that archive
-- quarantined even though its counters add up.
do $v35_mixed_ledger_test$
declare
  mixed_memory jsonb := '{
    "engineVersion":"long-analytic-v35",
    "coverage":{
      "complete":true,
      "expectedBotDecisions":2,
      "recordedBotDecisions":2,
      "recoveredBotDecisions":0
    },
    "decisions":[
      {"actor":"bot","engineVersion":"long-analytic-v34"},
      {"actor":"bot","engineVersion":"long-analytic-v35"}
    ]
  }'::jsonb;
  homogeneous_memory jsonb := '{
    "engineVersion":"long-analytic-v35",
    "coverage":{
      "complete":true,
      "expectedBotDecisions":2,
      "recordedBotDecisions":2,
      "recoveredBotDecisions":0
    },
    "decisions":[
      {"actor":"bot","engineVersion":"long-analytic-v35"},
      {"actor":"bot","engineVersion":"long-analytic-v35"}
    ]
  }'::jsonb;
begin
  if private.long_bot_v35_training_memory_is_complete(mixed_memory) then
    raise exception 'Mixed v34/v35 decision ledger passed the v35 integrity gate.';
  end if;
  if not private.long_bot_v35_training_memory_is_complete(homogeneous_memory) then
    raise exception 'Homogeneous v35 decision ledger failed the v35 integrity gate.';
  end if;
end;
$v35_mixed_ledger_test$;

do $v35_archive_integrity$
declare
  target_function regprocedure;
  function_definition text;
  patched_definition text;
begin
  foreach target_function in array array[
    'public.finish_room_game(text,jsonb,jsonb)'::regprocedure,
    'public.archive_finished_bot_training_game()'::regprocedure,
    'public.archive_bot_training_game(text,jsonb)'::regprocedure
  ]
  loop
    function_definition := pg_catalog.pg_get_functiondef(target_function);
    patched_definition := function_definition;
    if pg_catalog.strpos(patched_definition, '''long-analytic-v35''') = 0 then
      if pg_catalog.strpos(patched_definition, '''long-analytic-v34''') = 0 then
        raise exception 'Could not locate the v34 integrity gate in %.', target_function;
      end if;
      patched_definition := pg_catalog.replace(
        patched_definition,
        '''long-analytic-v34''',
        '''long-analytic-v34'', ''long-analytic-v35'''
      );
    end if;

    if pg_catalog.strpos(
      patched_definition, 'private.long_bot_v35_training_memory_is_complete'
    ) = 0 then
      if target_function = 'public.finish_room_game(text,jsonb,jsonb)'::regprocedure then
        patched_definition := pg_catalog.replace(
          patched_definition,
          '    training_outcome :=',
          $finish_gate$    if coalesce(training_memory->>'engineVersion', '') = 'long-analytic-v35'
       and not private.long_bot_v35_training_memory_is_complete(training_memory) then
      raise exception 'Long bot v35 training payload mixes decision generations.' using errcode = '22023';
    end if;

    training_outcome :=$finish_gate$
        );
      elsif target_function = 'public.archive_finished_bot_training_game()'::regprocedure then
        patched_definition := pg_catalog.replace(
          patched_definition,
          '  resolved_bot_color :=',
          $trigger_gate$  if coalesce(memory->>'engineVersion', '') = 'long-analytic-v35'
    and not private.long_bot_v35_training_memory_is_complete(memory) then
    return new;
  end if;

  resolved_bot_color :=$trigger_gate$
        );
      elsif target_function = 'public.archive_bot_training_game(text,jsonb)'::regprocedure then
        patched_definition := pg_catalog.replace(
          patched_definition,
          '  outcome :=',
          $explicit_gate$  if coalesce(memory->>'engineVersion', '') = 'long-analytic-v35'
    and not private.long_bot_v35_training_memory_is_complete(memory) then
    raise exception 'Long bot v35 training payload mixes decision generations.';
  end if;
  outcome :=$explicit_gate$
        );
      end if;
    end if;

    -- Earlier v35 installations raised on a legitimate resumed mixed ledger,
    -- rolling back the already-written finished room. Keep every identity and
    -- numeric gate above intact; quarantine only exact known-generation mixes
    -- and conditionally skip the archive side effect, never finalization.
    if target_function = 'public.finish_room_game(text,jsonb,jsonb)'::regprocedure then
      if pg_catalog.strpos(patched_definition, 'training_quarantined boolean := false;') = 0 then
        patched_definition := pg_catalog.replace(
          patched_definition,
          '  training_archived boolean := false;',
          E'  training_archived boolean := false;\n  training_quarantined boolean := false;'
        );
      end if;
      if pg_catalog.strpos(patched_definition, 'training_quarantined := true;') = 0 then
        patched_definition := pg_catalog.replace(
          patched_definition,
          $old_finish_gate$    if coalesce(training_memory->>'engineVersion', '') = 'long-analytic-v35'
       and not private.long_bot_v35_training_memory_is_complete(training_memory) then
      raise exception 'Long bot v35 training payload mixes decision generations.' using errcode = '22023';
    end if;$old_finish_gate$,
          $quarantine_finish_gate$    if coalesce(training_memory->>'engineVersion', '') = 'long-analytic-v35'
       and not private.long_bot_v35_training_memory_is_complete(training_memory) then
      -- A real v34->v35 resume can have exact complete execution coverage but
      -- mixed bot generations. Quarantine only that known migration case;
      -- malformed counters, missing generations or unknown engines still fail.
      if coalesce(p_training_state->>'variant', target.variant) = 'long'
      and (
        select count(*) from jsonb_array_elements(training_decisions) decision
        where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
      ) = (training_coverage->>'expectedBotDecisions')::numeric
      and exists (
        select 1 from jsonb_array_elements(training_decisions) decision
        where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
          and decision->>'engineVersion' = 'long-analytic-v35'
      )
      and exists (
        select 1 from jsonb_array_elements(training_decisions) decision
        where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
          and coalesce(decision->>'engineVersion', '') ~ '^long-analytic-v(29|30|31|32|33|34)$'
      )
      and not exists (
        select 1 from jsonb_array_elements(training_decisions) decision
        where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
          and coalesce(decision->>'engineVersion', '') !~ '^long-analytic-v(29|30|31|32|33|34|35)$'
      ) then
        training_quarantined := true;
      else
        raise exception 'Long bot v35 training payload mixes decision generations.' using errcode = '22023';
      end if;
    end if;$quarantine_finish_gate$
        );
      end if;
      if pg_catalog.strpos(patched_definition, '    if not training_quarantined then') = 0 then
        patched_definition := pg_catalog.replace(
          patched_definition, '    training_outcome :=',
          E'    if not training_quarantined then\n    training_outcome :='
        );
        patched_definition := pg_catalog.replace(
          patched_definition, '    training_archived := true;',
          E'    training_archived := true;\n    end if;'
        );
      end if;
      if pg_catalog.strpos(patched_definition, '''trainingQuarantined'', training_quarantined') = 0 then
        patched_definition := pg_catalog.replace(
          patched_definition, '''trainingArchived'', training_archived,',
          E'''trainingArchived'', training_archived,\n    ''trainingQuarantined'', training_quarantined,'
        );
      end if;
      if pg_catalog.strpos(patched_definition, 'training_quarantined boolean := false;') = 0
         or pg_catalog.strpos(patched_definition, 'training_quarantined := true;') = 0
         or pg_catalog.strpos(patched_definition, '    if not training_quarantined then') = 0
         or pg_catalog.strpos(patched_definition, E'    training_archived := true;\n    end if;') = 0
         or pg_catalog.strpos(patched_definition, '''trainingQuarantined'', training_quarantined') = 0 then
        raise exception 'Could not install the v35 mixed-ledger completion quarantine.';
      end if;
    end if;

    if pg_catalog.strpos(patched_definition, '''long-analytic-v35''') = 0
       or pg_catalog.strpos(
         patched_definition, 'private.long_bot_v35_training_memory_is_complete'
       ) = 0 then
      raise exception 'Could not install the v35 integrity gate in %.', target_function;
    end if;
    if patched_definition is distinct from function_definition then
      execute patched_definition;
    end if;
  end loop;
end;
$v35_archive_integrity$;

-- Re-run the finished-room backfill under the v35 coverage gate. Existing
-- archive rows are updated only from complete room snapshots.
insert into public.bot_training_games (
  room_id, room_code, player_user_id, player_name, bot_name,
  engine_version, difficulty, bot_color, winner, result_type,
  decision_count, decisions, final_state, completed_at
)
select
  room.id,
  room.code,
  room.host_user_id,
  room.host_name,
  coalesce(room.guest_name, room.game_state->'analysis'->>'botName', 'Hard bot'),
  coalesce(room.game_state->'analysis'->'botMemory'->>'engineVersion', ''),
  'hard',
  coalesce(
    nullif(room.game_state->'analysis'->'botMemory'->'outcome'->>'botColor', ''),
    case
      when coalesce(room.game_state->'analysis'->>'playerColor', 'white') = 'white'
        then 'dark'
      else 'white'
    end
  ),
  room.game_state->>'winner',
  coalesce(nullif(room.game_state->>'resultType', ''), 'normal'),
  jsonb_array_length(room.game_state->'analysis'->'botMemory'->'decisions'),
  room.game_state->'analysis'->'botMemory'->'decisions',
  room.game_state,
  coalesce(room.archived_at, now())
from public.rooms room
where coalesce(room.game_state->>'mode', '') = 'bot'
  and coalesce(room.game_state->>'variant', room.variant) in ('long', 'short')
  and coalesce(room.game_state->>'botDifficulty', '') = 'hard'
  and coalesce(room.game_state->>'winner', '') in ('white', 'dark')
  and jsonb_typeof(room.game_state->'analysis'->'botMemory'->'decisions') = 'array'
  and jsonb_array_length(room.game_state->'analysis'->'botMemory'->'decisions') > 0
  and case
    when coalesce(room.game_state->>'variant', room.variant) = 'long'
      and coalesce(
        room.game_state->'analysis'->'botMemory'->>'engineVersion',
        ''
      ) in (
        'long-analytic-v29',
        'long-analytic-v30',
        'long-analytic-v31',
        'long-analytic-v32',
        'long-analytic-v33',
        'long-analytic-v34',
        'long-analytic-v35'
      ) then
      coalesce(
        room.game_state->'analysis'->'botMemory'->'coverage'->'complete',
        'false'::jsonb
      ) = 'true'::jsonb
      and case
        when coalesce(
          room.game_state->'analysis'->'botMemory'->'coverage'->>'expectedBotDecisions',
          ''
        ) ~ '^[0-9]+$'
          and coalesce(
            room.game_state->'analysis'->'botMemory'->'coverage'->>'recordedBotDecisions',
            ''
          ) ~ '^[0-9]+$'
          and coalesce(
            room.game_state->'analysis'->'botMemory'->'coverage'->>'recoveredBotDecisions',
            ''
          ) ~ '^[0-9]+$' then
          (room.game_state->'analysis'->'botMemory'->'coverage'->>'expectedBotDecisions')::numeric > 0
          and (room.game_state->'analysis'->'botMemory'->'coverage'->>'expectedBotDecisions')::numeric =
            (room.game_state->'analysis'->'botMemory'->'coverage'->>'recordedBotDecisions')::numeric
              + (room.game_state->'analysis'->'botMemory'->'coverage'->>'recoveredBotDecisions')::numeric
        else false
      end
      and (
        coalesce(
          room.game_state->'analysis'->'botMemory'->>'engineVersion',
          ''
        ) <> 'long-analytic-v35'
        or private.long_bot_v35_training_memory_is_complete(
          room.game_state->'analysis'->'botMemory'
        )
      )
    else true
  end
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

commit;
