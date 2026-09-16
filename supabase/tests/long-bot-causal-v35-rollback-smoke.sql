-- Run after both v35 migrations inside a disposable BEGIN/ROLLBACK
-- transaction. This is a pre-deployment smoke, not an installation script.
do $causal_privilege_smoke$
begin
  if public.get_long_bot_experience_patterns(null) <> '[]'::jsonb then
    raise exception 'Fresh causal release must expose an empty pattern set.';
  end if;
  if has_function_privilege('anon',
      'public.complete_long_bot_causal_review_job(bigint,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.claim_long_bot_causal_review_jobs(text,integer,text)', 'EXECUTE')
    or not has_function_privilege('service_role',
      'public.claim_long_bot_causal_review_jobs(text,integer,text)', 'EXECUTE') then
    raise exception 'Causal job RPC privileges are invalid.';
  end if;
  if has_table_privilege('anon', 'private.long_bot_causal_evidence', 'SELECT')
    or has_table_privilege('service_role', 'private.long_bot_causal_evidence', 'INSERT') then
    raise exception 'Causal evidence must not permit direct client or service writes.';
  end if;
end;
$causal_privilege_smoke$;

select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $causal_role_smoke$
begin
  begin
    perform public.claim_long_bot_causal_review_jobs('negative-smoke', 1, null);
    raise exception 'Anonymous runtime claim passed the role gate.';
  exception when insufficient_privilege then
    raise notice 'Anonymous runtime claim correctly denied.';
  end;
end;
$causal_role_smoke$;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $causal_service_smoke$
begin
  begin
    perform public.claim_long_bot_causal_review_jobs('service-smoke', 1, null);
    raise exception 'An unapproved or unidentified worker claimed the queue.';
  exception when invalid_parameter_value then
    raise notice 'Unapproved runtime claim correctly denied without activation.';
  end;
end;
$causal_service_smoke$;
