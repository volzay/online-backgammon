begin;

drop policy if exists "recipients can mark friend messages read" on public.friend_messages;
create policy "recipients can mark friend messages read"
on public.friend_messages for update
to authenticated
using (to_user_id = auth.uid())
with check (to_user_id = auth.uid());

grant update (read_at) on public.friend_messages to authenticated;

commit;
