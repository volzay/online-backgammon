\set ON_ERROR_STOP on
-- Run ONLY after both replacement native jobs are actually complete.
-- Retain every original archive, partial cursor, journal and result. This
-- marks the obsolete duplicate queue entries invalid; it never marks them
-- complete or manufactures review/evidence counters.
begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
do $$
declare pair record; old_job private.long_bot_causal_review_jobs; new_job private.long_bot_causal_review_jobs;
begin
 for pair in select * from(values(2401,2411),(2402,2412))as pairs(old_id,new_id) loop
  select * into old_job from private.long_bot_causal_review_jobs where id=pair.old_id for update;
  select * into new_job from private.long_bot_causal_review_jobs where id=pair.new_id for update;
  if old_job.id is null or new_job.id is null
   or old_job.runtime_digest is distinct from 'd7fd1192b3c1cea8e1793b9261703f85c4a9effd18169dc2eeb1b4a567b99183'
   or new_job.runtime_digest is distinct from '18f05bafa638c1d0dea35c5bfa933c071a1bfa409bd55333e30871c5bc961ec5'
   or old_job.training_game_id is distinct from new_job.training_game_id
   or old_job.archive_fingerprint is distinct from new_job.archive_fingerprint
   or new_job.status is distinct from 'complete' or new_job.invalidated_at is not null
   or coalesce((select count(*)from jsonb_array_elements(coalesce(new_job.progress->'finishedReviews','[]'::jsonb))f
     where f#>>'{review,rollout,coverage,complete}'='true'),0)<>4
   or exists(select 1 from private.long_bot_causal_evidence where training_game_id=old_job.training_game_id
     and runtime_digest=old_job.runtime_digest and archive_fingerprint=old_job.archive_fingerprint and invalidated_at is null)
  then raise exception 'Replacement native review is not complete or source binding differs: %',pair.new_id;end if;
  if old_job.invalidated_at is null then
   update private.long_bot_causal_review_jobs set invalidated_at=now(),status='rejected',
    lease_owner=null,lease_until=null,updated_at=now(),
    last_error='Superseded by complete equivalent native cache review '||new_job.id||'; original partial history retained'
   where id=old_job.id;
  end if;
 end loop;
end $$;
commit;
