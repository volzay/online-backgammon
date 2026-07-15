-- Narrow production migration for durable chat delivery and friendship reads.
-- Kept separate from schema.sql so unrelated function ownership cannot roll it back.

begin;

alter table public.friend_messages
  add column if not exists client_message_id text;

create unique index if not exists friend_messages_sender_client_unique
on public.friend_messages (from_user_id, client_message_id)
where client_message_id is not null;

alter table public.room_messages
  add column if not exists client_message_id text;

create unique index if not exists room_messages_sender_client_unique
on public.room_messages (sender_user_id, client_message_id)
where client_message_id is not null;

create or replace function public.sync_friendship_pair()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  left_id uuid := coalesce(new.from_user_id, old.from_user_id);
  right_id uuid := coalesce(new.to_user_id, old.to_user_id);
begin
  if exists (
    select 1
    from public.friend_requests request
    where request.status = 'accepted'
      and (
        (request.from_user_id = left_id and request.to_user_id = right_id)
        or (request.from_user_id = right_id and request.to_user_id = left_id)
      )
  ) then
    insert into public.friendships (user_id, friend_user_id)
    values (left_id, right_id), (right_id, left_id)
    on conflict (user_id, friend_user_id) do nothing;
  else
    delete from public.friendships
    where (user_id = left_id and friend_user_id = right_id)
       or (user_id = right_id and friend_user_id = left_id);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists friend_requests_sync_friendships on public.friend_requests;
create trigger friend_requests_sync_friendships
after insert or update of status or delete on public.friend_requests
for each row execute function public.sync_friendship_pair();

insert into public.friendships (user_id, friend_user_id)
select request.from_user_id, request.to_user_id
from public.friend_requests request
where request.status = 'accepted'
union
select request.to_user_id, request.from_user_id
from public.friend_requests request
where request.status = 'accepted'
on conflict (user_id, friend_user_id) do nothing;

notify pgrst, 'reload schema';

commit;
