begin;

-- Record the source of each loss even when the browser could not save its
-- decision ledger. The authoritative room archive keeps the replay itself.
create table if not exists private.long_bot_loss_lessons (
  archive_id uuid primary key references public.room_game_archives(id) on delete cascade,
  room_id uuid not null,
  room_code text not null,
  started_at_key text,
  finished_at_key text,
  completed_at timestamptz not null,
  result_type text not null,
  bot_color text not null check (bot_color in ('white', 'dark')),
  winner text not null check (winner in ('white', 'dark') and winner <> bot_color)
);
alter table private.long_bot_loss_lessons enable row level security;
revoke all on private.long_bot_loss_lessons from public, anon, authenticated, service_role;

create or replace function private.long_bot_archived_loss_color(p_game public.room_game_archives)
returns text
language sql
immutable
set search_path = ''
as $$
  with colors as (
    select coalesce(
      case coalesce(nullif(p_game.final_state->'analysis'->>'playerColor', ''),
                    nullif(p_game.final_state->>'playerColor', ''))
        when 'white' then 'dark'
        when 'dark' then 'white'
      end,
      case p_game.final_state->'analysis'->'botMemory'->'outcome'->>'botColor'
        when 'white' then 'white'
        when 'dark' then 'dark'
      end
    ) as bot_color
  )
  select colors.bot_color
  from colors
  where p_game.variant = 'long'
    and coalesce(p_game.final_state->>'variant', p_game.variant) = 'long'
    and (
      coalesce(p_game.final_state->>'mode', p_game.final_state->'analysis'->>'mode') = 'bot'
      or coalesce(p_game.final_state->>'opponent', p_game.final_state->'analysis'->>'opponent') = 'bot'
    )
    and coalesce(p_game.final_state->>'botDifficulty', p_game.final_state->'analysis'->>'difficulty') = 'hard'
    and p_game.winner <> colors.bot_color
$$;

create or replace function private.record_long_bot_loss_lesson()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lost_color text := private.long_bot_archived_loss_color(new);
begin
  if lost_color is null then
    if tg_op = 'UPDATE' then
      delete from private.long_bot_loss_lessons where archive_id = new.id;
    end if;
    return new;
  end if;

  insert into private.long_bot_loss_lessons (
    archive_id, room_id, room_code, started_at_key, finished_at_key,
    completed_at, result_type, bot_color, winner
  )
  values (
    new.id, new.room_id, new.room_code,
    nullif(new.final_state->>'startedAt', ''), nullif(new.final_state->>'finishedAt', ''),
    new.completed_at, new.result_type, lost_color, new.winner
  )
  on conflict (archive_id) do update set
    room_id = excluded.room_id,
    room_code = excluded.room_code,
    started_at_key = excluded.started_at_key,
    finished_at_key = excluded.finished_at_key,
    completed_at = excluded.completed_at,
    result_type = excluded.result_type,
    bot_color = excluded.bot_color,
    winner = excluded.winner;
  return new;
end;
$$;
revoke all on function private.long_bot_archived_loss_color(public.room_game_archives),
  private.record_long_bot_loss_lesson() from public, anon, authenticated, service_role;

drop trigger if exists record_long_bot_loss_lesson on public.room_game_archives;
create trigger record_long_bot_loss_lesson
after insert or update of variant, winner, result_type, final_state, completed_at, room_id, room_code
on public.room_game_archives for each row execute function private.record_long_bot_loss_lesson();

-- Attach the review for the same round and source revision. The loss is the
-- reason to investigate; only existing causal evidence can credit a move.
create or replace view private.long_bot_loss_lesson_status as
with round_links as (
  select lesson.archive_id, lesson.room_id, lesson.room_code, lesson.completed_at,
    lesson.result_type, lesson.bot_color, lesson.winner, training.id as training_game_id
  from private.long_bot_loss_lessons lesson
  left join public.bot_training_games training
    on training.room_code = lesson.room_code
    and (training.room_id = lesson.room_id or training.room_id is null)
    and training.difficulty = 'hard'
    and coalesce(training.final_state->>'variant', 'long') = 'long'
    and training.bot_color = lesson.bot_color
    and training.winner = lesson.winner
    and (
      (lesson.started_at_key is not null
        and nullif(training.final_state->>'startedAt', '') = lesson.started_at_key
        and (lesson.finished_at_key is null
          or nullif(training.final_state->>'finishedAt', '') = lesson.finished_at_key))
      or (lesson.started_at_key is null and lesson.finished_at_key is not null
        and nullif(training.final_state->>'finishedAt', '') = lesson.finished_at_key)
      or (lesson.started_at_key is null and lesson.finished_at_key is null
        and training.completed_at = lesson.completed_at)
    )
), all_losses as (
  select * from round_links
  union all
  -- Historical or removed rooms can retain a training record after their
  -- general room archive is gone. It remains the only source for that loss.
  select null::uuid, training.room_id, training.room_code, training.completed_at,
    training.result_type, training.bot_color, training.winner, training.id
  from public.bot_training_games training
  where training.difficulty = 'hard'
    and training.winner <> training.bot_color
    and training.final_state->>'variant' = 'long'
    and not exists (select 1 from round_links where training_game_id = training.id)
)
select lesson.archive_id, lesson.room_id, lesson.room_code,
  lesson.completed_at, lesson.result_type, lesson.bot_color, lesson.winner,
  lesson.training_game_id,
  case
    when evidence.confirmed_count > 0 then 'confirmed'
    when review.pending then 'under_review'
    when review.completed then 'reviewed_without_confirmed_lesson'
    when review.needs_attention then 'review_needs_attention'
    when source.eligible then 'awaiting_review'
    when lesson.training_game_id is not null then 'ineligible_replay'
    else 'missing_decision_ledger'
  end as review_status,
  evidence.confirmed_count as confirmed_move_lessons
from all_losses lesson
left join private.long_bot_causal_archive_index source
  on source.training_game_id = lesson.training_game_id
left join lateral (
  select bool_or(job.status in ('pending', 'leased')) as pending,
    bool_or(job.status = 'complete') as completed,
    bool_or(job.status in ('failed', 'rejected')) as needs_attention
  from private.long_bot_causal_review_jobs job
  where job.training_game_id = source.training_game_id
    and job.archive_fingerprint = source.archive_fingerprint
    and job.invalidated_at is null
) review on true
left join lateral (
  select count(distinct (lesson_evidence.runtime_digest, lesson_evidence.state_id)) as confirmed_count
  from private.long_bot_causal_evidence lesson_evidence
  where lesson_evidence.training_game_id = source.training_game_id
    and lesson_evidence.archive_fingerprint = source.archive_fingerprint
    and lesson_evidence.invalidated_at is null
    and lesson_evidence.exact_execution and lesson_evidence.complete_legal_coverage
    and lesson_evidence.paired_rollout_complete and lesson_evidence.confidence_bounds_complete
    and not lesson_evidence.outcome_used
) evidence on true;
revoke all on private.long_bot_loss_lesson_status from public, anon, authenticated, service_role;

commit;

-- Release the trigger's table-level lock before reading the historical archive.
-- Row locks prevent a concurrent archive correction from reviving a stale loss.
begin;
insert into private.long_bot_loss_lessons (
  archive_id, room_id, room_code, started_at_key, finished_at_key,
  completed_at, result_type, bot_color, winner
)
select archive.id, archive.room_id, archive.room_code,
  nullif(archive.final_state->>'startedAt', ''), nullif(archive.final_state->>'finishedAt', ''),
  archive.completed_at, archive.result_type, loss.bot_color, archive.winner
from public.room_game_archives archive
cross join lateral (select private.long_bot_archived_loss_color(archive) as bot_color) loss
where archive.variant = 'long' and loss.bot_color is not null
for share of archive
on conflict (archive_id) do nothing;
commit;
