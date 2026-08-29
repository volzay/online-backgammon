-- Production patch for anonymous hard-bot finalization.
-- Guest bot rooms keep host_user_id null and may use the versioned room update.
-- Anonymous clients must not be able to mutate a registered player's bot room.

begin;

drop policy if exists "anonymous guests can update guest rooms" on public.rooms;
create policy "anonymous guests can update guest rooms"
on public.rooms for update
to anon
using (
  status in ('waiting', 'joined')
  and (host_user_id is null or guest_user_id is null)
  and not (
    host_user_id is not null
    and coalesce(game_state->>'mode', game_state->'analysis'->>'mode', '') = 'bot'
  )
)
with check (
  status in ('waiting', 'joined', 'over', 'closed')
  and (host_user_id is null or guest_user_id is null)
  and not (
    host_user_id is not null
    and coalesce(game_state->>'mode', game_state->'analysis'->>'mode', '') = 'bot'
  )
);

notify pgrst, 'reload schema';

commit;
