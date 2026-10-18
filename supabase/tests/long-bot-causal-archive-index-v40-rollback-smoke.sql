-- Synthetic source-index tests only; no learned evidence is manufactured.
begin;
do $archive_index_smoke$
declare
  d text := encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex');
  game_id uuid := gen_random_uuid();
  game public.bot_training_games;
  old_fingerprint text;
  decisions jsonb := '[{"id":"index-test-0","actor":"bot","color":"dark","source":"engine","engineVersion":"long-analytic-v35"}]';
  claimed jsonb;
begin
  if has_table_privilege('anon', 'private.long_bot_causal_archive_index', 'SELECT')
    or has_table_privilege('service_role', 'private.long_bot_causal_archive_index', 'UPDATE')
    or has_function_privilege('authenticated', 'private.cache_long_bot_causal_archive()', 'EXECUTE') then
    raise exception 'Source index privileges leaked.';
  end if;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.activate_long_bot_causal_release('long-server-causal-review-v1', d, repeat('8',64));
  insert into public.bot_training_games(id, room_code, player_name, bot_name,
    engine_version, difficulty, bot_color, winner, decision_count, decisions, final_state)
  values (game_id, 'INDEX-' || game_id::text, 'Synthetic', 'Synthetic',
    'long-analytic-v35', 'hard', 'dark', 'white', 1, decisions,
    jsonb_build_object('variant', 'long', 'analysis', jsonb_build_object('botMemory',
      jsonb_build_object('engineVersion', 'long-analytic-v35', 'decisions', decisions,
        'coverage', jsonb_build_object('complete', true, 'expectedBotDecisions', 1,
          'recordedBotDecisions', 1, 'recoveredBotDecisions', 0)))));
  select * into game from public.bot_training_games where id=game_id;
  old_fingerprint := private.long_bot_causal_archive_fingerprint(game);
  if not exists (select 1 from private.long_bot_causal_archive_index
    where training_game_id=game_id and eligible and archive_fingerprint=old_fingerprint) then
    raise exception 'Source index was not populated.';
  end if;
  update public.bot_training_games set final_state=final_state || '{"repairTest":true}'::jsonb where id=game_id;
  select * into game from public.bot_training_games where id=game_id;
  if not exists (select 1 from private.long_bot_causal_archive_index
    where training_game_id=game_id and eligible
      and archive_fingerprint=private.long_bot_causal_archive_fingerprint(game)
      and archive_fingerprint<>old_fingerprint) then
    raise exception 'Repair did not refresh source index.';
  end if;
  update private.long_bot_causal_review_jobs set available_at=now()+interval '1 day' where runtime_digest=d;
  -- Emulate the activation/repair MVCC race: the current revision lacks a job.
  delete from private.long_bot_causal_review_jobs where training_game_id=game_id and runtime_digest=d
    and archive_fingerprint=private.long_bot_causal_archive_fingerprint(game);
  claimed := public.claim_long_bot_causal_review_slices('index-rollback',d)->0;
  if claimed->'trainingGame'->>'id' is distinct from game_id::text
    or claimed->>'archiveFingerprint' is distinct from private.long_bot_causal_archive_fingerprint(game) then
    raise exception 'Missing-job recovery failed.';
  end if;
  update public.bot_training_games set final_state=jsonb_set(final_state,
    '{analysis,botMemory,coverage,complete}', 'false') where id=game_id;
  if (select eligible from private.long_bot_causal_archive_index where training_game_id=game_id) then
    raise exception 'Incomplete source remained eligible.';
  end if;
  -- Even owner-side corruption of the index must not skip the authoritative
  -- source validation under archive SHARE. Neither wrong identity nor false
  -- eligibility is sufficient to lease an invalid source.
  select * into game from public.bot_training_games where id=game_id;
  update private.long_bot_causal_archive_index set eligible=true where training_game_id=game_id;
  insert into private.long_bot_causal_review_jobs(training_game_id, runtime_digest, archive_fingerprint)
  values (game_id, d, private.long_bot_causal_archive_fingerprint(game));
  if jsonb_array_length(public.claim_long_bot_causal_review_slices('index-rollback',d))<>0 then
    raise exception 'Stale index bypassed locked validation.';
  end if;
  delete from public.bot_training_games where id=game_id;
  if exists (select 1 from private.long_bot_causal_archive_index where training_game_id=game_id) then
    raise exception 'Deleted source left an index row.';
  end if;
end;
$archive_index_smoke$;
rollback;
