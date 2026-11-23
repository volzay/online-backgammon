begin;
-- Focus work retains its reservation, but cannot permanently exclude other
-- archives. A partial cohort is not an exclusive claim on every future slice.
create table if not exists private.long_bot_causal_focus_schedule (
 runtime_digest text not null, worker_lane integer not null, prefer_focus boolean not null default true,
 primary key(runtime_digest,worker_lane)
);
alter table private.long_bot_causal_focus_schedule enable row level security;
revoke all on private.long_bot_causal_focus_schedule from public,anon,authenticated,service_role;
do $fair_focus$
declare definition text; old_order text; new_order text;
begin
 if to_regclass('private.long_bot_causal_completion_targets')is null then
  raise exception 'The existing completion-target schedule is required'; end if;
 definition:=pg_get_functiondef('public.claim_long_bot_causal_review_jobs(text,integer,text)'::regprocedure);
 old_order:=$old$case when exists(select 1 from private.long_bot_causal_completion_targets focus
        where focus.runtime_digest=queued.runtime_digest and focus.job_id=queued.id) then 0 else 1 end,$old$;
 new_order:=$new$case when exists(select 1 from private.long_bot_causal_completion_targets focus
        where focus.runtime_digest=queued.runtime_digest and focus.job_id=queued.id) = prefer_focus then 0 else 1 end,
      case when exists(select 1 from private.long_bot_causal_completion_targets focus
        where focus.runtime_digest=queued.runtime_digest and focus.job_id=queued.id) then queued.updated_at end asc nulls last,$new$;
 if position(new_order in definition)=0 then
  if position(old_order in definition)=0 or position(old_order in substring(definition from position(old_order in definition)+length(old_order)))>0 then
   raise exception 'Unexpected live claim ordering; no partial patch applied';end if;
  definition:=replace(definition,old_order,new_order);
  if position('  prefer_fresh boolean;' in definition)=0 or position('    claimed := claimed ||' in definition)=0 then
   raise exception 'Unexpected claim ticket structure';end if;
  definition:=replace(definition,'  prefer_fresh boolean;','  prefer_fresh boolean; prefer_focus boolean;');
  definition:=replace(definition,'  -- Activation and an uncommitted archive repair',
   '  insert into private.long_bot_causal_focus_schedule(runtime_digest,worker_lane)
     values(active.runtime_digest,assigned_lane) on conflict do nothing;
  select schedule.prefer_focus into prefer_focus from private.long_bot_causal_focus_schedule schedule
   where schedule.runtime_digest=active.runtime_digest and schedule.worker_lane=assigned_lane for update;
  -- Activation and an uncommitted archive repair');
  definition:=replace(definition,'    claimed := claimed ||',
   '    update private.long_bot_causal_focus_schedule schedule
     set prefer_focus=not exists(select 1 from private.long_bot_causal_completion_targets focus
      where focus.runtime_digest=job.runtime_digest and focus.job_id=job.id)
     where schedule.runtime_digest=active.runtime_digest and schedule.worker_lane=assigned_lane;
    claimed := claimed ||');
  execute definition;
 end if;
end $fair_focus$;
-- These are original archives/jobs, not imported or relabelled lessons.
insert into private.long_bot_causal_completion_targets(runtime_digest,job_id)
select j.runtime_digest,j.id from private.long_bot_causal_review_jobs j
 join public.bot_training_games g on g.id=j.training_game_id
where g.room_code in('8JPN-KUD8','CTNM-E43Z')
 and j.runtime_digest='d7fd1192b3c1cea8e1793b9261703f85c4a9effd18169dc2eeb1b4a567b99183'
 and j.invalidated_at is null and j.archive_fingerprint=private.long_bot_causal_archive_fingerprint(g)
on conflict do nothing;
commit;
