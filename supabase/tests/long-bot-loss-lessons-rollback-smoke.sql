begin;

do $$
declare
  room uuid := gen_random_uuid();
  first_loss uuid := gen_random_uuid();
  next_loss uuid := gen_random_uuid();
  bot_win uuid := gen_random_uuid();
  short_game uuid := gen_random_uuid();
  easy_game uuid := gen_random_uuid();
  legacy_loss uuid := gen_random_uuid();
  training uuid := gen_random_uuid();
  old_training uuid := gen_random_uuid();
  fixture_code text := upper(substr(room::text, 1, 4) || '-' || substr(room::text, 5, 4));
  fingerprint text := repeat('a',64);
  digest text := repeat('b',64);
  loss_state jsonb := '{"mode":"bot","botDifficulty":"hard","variant":"long",
    "analysis":{"playerColor":"white"},"startedAt":101,"finishedAt":102}';
  loss_time timestamptz := '2026-11-10T16:00:00Z';
begin
  perform set_config('request.headers',
    '{"x-client-info":"nardu-fair-dice-v36 nardu-fair-dice-v37"}', true);
  insert into public.rooms (id,code,variant,status,host_name,game_state)
  values (room,fixture_code,'long','closed','Smoke',null);
  insert into public.room_game_archives (
    id,room_id,room_code,result_key,variant,host_name,winner,result_type,final_state,completed_at
  ) values
    (first_loss,room,fixture_code,'first-loss','long','Smoke','white','normal',loss_state,loss_time),
    (next_loss,room,fixture_code,'next-loss','long','Smoke','white','gammon',
      loss_state || '{"startedAt":103,"finishedAt":104}',loss_time + interval '1 hour'),
    (bot_win,room,fixture_code,'win','long','Smoke','dark','normal',loss_state,loss_time),
    (short_game,room,fixture_code,'short','short','Smoke','white','normal',
      loss_state || '{"variant":"short"}',loss_time),
    (easy_game,room,fixture_code,'easy','long','Smoke','white','normal',
      loss_state || '{"botDifficulty":"easy"}',loss_time),
    (legacy_loss,room,fixture_code,'legacy','long','Smoke','dark','normal',
      '{"variant":"long","analysis":{"mode":"bot","difficulty":"hard","botMemory":{"outcome":{"botColor":"white"}}}}',
      loss_time + interval '2 hours');

  if (select count(*) from private.long_bot_loss_lessons where room_id=room) <> 3 then
    raise exception 'Each Hard long loss must be recorded exactly once without a decision ledger';
  end if;
  if (select review_status from private.long_bot_loss_lesson_status where archive_id=first_loss)
    is distinct from 'missing_decision_ledger' then
    raise exception 'A loss without telemetry was not retained for follow-up';
  end if;
  if (select bot_color from private.long_bot_loss_lessons where archive_id=legacy_loss)
    is distinct from 'white' then
    raise exception 'Historical bot color fallback is incorrect';
  end if;

  insert into public.bot_training_games (
    id,room_id,room_code,player_name,bot_name,engine_version,difficulty,bot_color,winner,final_state,completed_at
  ) values (training,room,fixture_code,'Smoke','Hard bot','long-analytic-v35','hard','dark','white',
    loss_state,loss_time),
    (old_training,null,'LOSS-LEGACY-SMOKE','Smoke','Hard bot','long-analytic-v28','hard','white','dark',
      '{"variant":"long"}',loss_time);
  if (select count(*) from private.long_bot_loss_lesson_status where training_game_id=training) <> 1
    or not exists (select 1 from private.long_bot_loss_lesson_status
      where training_game_id=old_training and archive_id is null) then
    raise exception 'Existing training-only losses must be visible without duplicating linked losses';
  end if;
  insert into private.long_bot_causal_archive_index(training_game_id,archive_fingerprint,eligible)
    values (training,fingerprint,true)
    on conflict (training_game_id) do update set archive_fingerprint=excluded.archive_fingerprint,
      eligible=excluded.eligible;
  insert into private.long_bot_causal_review_jobs (training_game_id,runtime_digest,archive_fingerprint)
    values (training,digest,fingerprint);
  if (select review_status from private.long_bot_loss_lesson_status where archive_id=first_loss)
    is distinct from 'under_review'
    or (select training_game_id from private.long_bot_loss_lesson_status where archive_id=next_loss)
      is not null then
    raise exception 'A review must link to its own terminal round only';
  end if;
  update private.long_bot_causal_review_jobs set status='complete' where training_game_id=training;
  if (select review_status from private.long_bot_loss_lesson_status where archive_id=first_loss)
    is distinct from 'reviewed_without_confirmed_lesson' then
    raise exception 'Review completion was confused with a confirmed move lesson';
  end if;

  insert into private.long_bot_causal_evidence (
    evidence_id,archive_fingerprint,training_game_id,decision_id,state_id,selected_action_id,
    recommended_action_id,context_key,action_key,reviewer_version,runtime_digest,categories,payload
  ) values (repeat('c',64),fingerprint,training,'smoke',repeat('d',64),repeat('e',64),repeat('f',64),
    'fixture-context','fixture-action','long-server-causal-review-v1',digest,'["fixture"]','{}');
  if (select confirmed_move_lessons from private.long_bot_loss_lesson_status where archive_id=first_loss)
    is distinct from 1::bigint then
    raise exception 'Confirmed evidence was not attached to the correct round';
  end if;
  update private.long_bot_causal_evidence set invalidated_at=now() where training_game_id=training;
  if (select confirmed_move_lessons from private.long_bot_loss_lesson_status where archive_id=first_loss)
    is distinct from 0::bigint then
    raise exception 'Invalidated evidence must stop counting';
  end if;

  update public.room_game_archives set final_state=final_state where id=first_loss;
  if (select count(*) from private.long_bot_loss_lessons where room_id=room) <> 3 then
    raise exception 'Re-saving a terminal game duplicated its loss';
  end if;
  update public.room_game_archives set winner='dark' where id=first_loss;
  if exists (select from private.long_bot_loss_lessons where archive_id=first_loss) then
    raise exception 'Correcting an archived loss to a win left a stale lesson';
  end if;
  if has_table_privilege('anon','private.long_bot_loss_lessons','SELECT')
    or has_table_privilege('authenticated','private.long_bot_loss_lesson_status','SELECT')
    or has_table_privilege('service_role','private.long_bot_loss_lesson_status','SELECT') then
    raise exception 'The loss ledger is available through an application role';
  end if;
end;
$$;

rollback;
