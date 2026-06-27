create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null unique,
  email text not null,
  rating integer not null default 1000,
  tier text not null default 'Bronze',
  rating_eligible boolean not null default true,
  banned_at timestamptz,
  banned_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_nickname text;
begin
  profile_nickname := coalesce(
    nullif(trim(new.raw_user_meta_data->>'nickname'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    split_part(new.email, '@', 1),
    'Player'
  );

  insert into public.profiles (id, nickname, email, rating, tier, rating_eligible, last_seen_at)
  values (
    new.id,
    profile_nickname,
    coalesce(new.email, ''),
    1000,
    'Bronze',
    true,
    now()
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create table if not exists public.guest_presence (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

drop trigger if exists guest_presence_set_updated_at on public.guest_presence;
create trigger guest_presence_set_updated_at
before update on public.guest_presence
for each row execute function public.set_updated_at();

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references public.profiles(id) on delete cascade,
  to_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (from_user_id <> to_user_id)
);

create unique index if not exists friend_requests_pending_unique
on public.friend_requests (from_user_id, to_user_id)
where status = 'pending';

create table if not exists public.friendships (
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_user_id),
  check (user_id <> friend_user_id)
);

create table if not exists public.friend_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id text not null,
  from_user_id uuid not null references public.profiles(id) on delete cascade,
  to_user_id uuid not null references public.profiles(id) on delete cascade,
  text text not null check (char_length(text) <= 1200),
  kind text not null default 'text' check (kind in ('text', 'emoji', 'voice')),
  audio_data text,
  mime_type text,
  duration integer not null default 0,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.friend_messages
  add column if not exists kind text not null default 'text',
  add column if not exists audio_data text,
  add column if not exists mime_type text,
  add column if not exists duration integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'friend_messages_kind_check'
      and conrelid = 'public.friend_messages'::regclass
  ) then
    alter table public.friend_messages
      add constraint friend_messages_kind_check check (kind in ('text', 'emoji', 'voice'));
  end if;
end;
$$;

create index if not exists friend_messages_thread_created_idx
on public.friend_messages (thread_id, created_at);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  variant text not null default 'long' check (variant in ('long', 'short')),
  access text not null default 'open' check (access in ('open', 'closed')),
  password_hash text,
  status text not null default 'waiting' check (status in ('waiting', 'joined', 'over', 'closed')),
  host_user_id uuid references public.profiles(id) on delete set null,
  guest_user_id uuid references public.profiles(id) on delete set null,
  host_name text not null,
  guest_name text,
  host_rating integer,
  guest_rating integer,
  host_registered boolean not null default false,
  guest_registered boolean not null default false,
  game_state jsonb,
  game_version integer not null default 0,
  presence jsonb not null default '{}'::jsonb,
  left_players jsonb not null default '{}'::jsonb,
  allow_spectators boolean not null default false,
  spectators jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  joined_at timestamptz,
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  closed_reason text
);

alter table public.rooms
add column if not exists allow_spectators boolean not null default false;

alter table public.rooms
add column if not exists spectators jsonb not null default '{}'::jsonb;

drop trigger if exists rooms_set_updated_at on public.rooms;
create trigger rooms_set_updated_at
before update on public.rooms
for each row execute function public.set_updated_at();

create index if not exists rooms_status_created_idx
on public.rooms (status, created_at desc);

create table if not exists public.room_messages (
  id bigserial primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_user_id uuid references public.profiles(id) on delete set null,
  sender_name text not null,
  color text not null check (color in ('white', 'dark')),
  kind text not null default 'text' check (kind in ('text', 'emoji', 'voice')),
  text text not null,
  audio_data text,
  mime_type text,
  duration integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists room_messages_room_created_idx
on public.room_messages (room_id, created_at);

create table if not exists public.rating_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  result_key text not null,
  opponent text,
  opponent_rating integer,
  did_win boolean not null default false,
  mode text,
  result_type text,
  winner text,
  score jsonb,
  history jsonb not null default '[]'::jsonb,
  delta integer not null default 0,
  rating_after integer not null,
  created_at timestamptz not null default now(),
  unique (user_id, result_key)
);

alter table public.rating_events
add column if not exists history jsonb not null default '[]'::jsonb;

create table if not exists public.bot_training_games (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms(id) on delete set null,
  room_code text not null unique,
  player_user_id uuid references public.profiles(id) on delete set null,
  player_name text not null,
  bot_name text not null,
  engine_version text not null default '',
  difficulty text not null default 'hard',
  bot_color text not null check (bot_color in ('white', 'dark')),
  winner text not null check (winner in ('white', 'dark')),
  result_type text not null default 'normal',
  decision_count integer not null default 0,
  decisions jsonb not null default '[]'::jsonb,
  final_state jsonb not null default '{}'::jsonb,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists bot_training_games_completed_idx
on public.bot_training_games (completed_at desc);

create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.guest_presence enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.friend_messages enable row level security;
alter table public.rooms enable row level security;
alter table public.room_messages enable row level security;
alter table public.rating_events enable row level security;
alter table public.bot_training_games enable row level security;
alter table public.admin_audit enable row level security;

create or replace function public.admin_email_whitelist()
returns text[]
language sql
immutable
as $$
  select array['volzay@yandex.ru', 'openthedoorcap@gmail.com']::text[]
$$;

revoke all on function public.admin_email_whitelist() from public;
grant execute on function public.admin_email_whitelist() to authenticated;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = any(public.admin_email_whitelist())
$$;

revoke all on function public.is_admin_user() from public;
grant execute on function public.is_admin_user() to authenticated;

drop policy if exists "admins can read bot training games" on public.bot_training_games;
create policy "admins can read bot training games"
on public.bot_training_games for select
to authenticated
using (public.is_admin_user());

grant select on public.bot_training_games to authenticated;

drop policy if exists "profiles are visible to authenticated users" on public.profiles;
create policy "profiles are visible to authenticated users"
on public.profiles for select
to authenticated
using (true);

drop policy if exists "users can update own profile" on public.profiles;
create policy "users can update own profile"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "users can insert own profile" on public.profiles;
create policy "users can insert own profile"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "authenticated users can see guest presence" on public.guest_presence;
create policy "authenticated users can see guest presence"
on public.guest_presence for select
to authenticated
using (true);

drop policy if exists "clients can create guest presence" on public.guest_presence;
create policy "clients can create guest presence"
on public.guest_presence for insert
to anon, authenticated
with check (
  id like 'guest:%'
  and length(name) between 3 and 32
);

drop policy if exists "clients can update guest presence" on public.guest_presence;
create policy "clients can update guest presence"
on public.guest_presence for update
to anon, authenticated
using (id like 'guest:%')
with check (
  id like 'guest:%'
  and length(name) between 3 and 32
);

grant select on public.guest_presence to authenticated;
grant insert, update on public.guest_presence to anon, authenticated;

drop policy if exists "users can see own friend requests" on public.friend_requests;
create policy "users can see own friend requests"
on public.friend_requests for select
to authenticated
using (from_user_id = auth.uid() or to_user_id = auth.uid());

drop policy if exists "users can create outgoing friend requests" on public.friend_requests;
create policy "users can create outgoing friend requests"
on public.friend_requests for insert
to authenticated
with check (from_user_id = auth.uid());

drop policy if exists "users can update incoming or outgoing friend requests" on public.friend_requests;
create policy "users can update incoming or outgoing friend requests"
on public.friend_requests for update
to authenticated
using (from_user_id = auth.uid() or to_user_id = auth.uid())
with check (from_user_id = auth.uid() or to_user_id = auth.uid());

drop policy if exists "users can see own friendships" on public.friendships;
create policy "users can see own friendships"
on public.friendships for select
to authenticated
using (user_id = auth.uid() or friend_user_id = auth.uid());

drop policy if exists "users can see own friend messages" on public.friend_messages;
create policy "users can see own friend messages"
on public.friend_messages for select
to authenticated
using (from_user_id = auth.uid() or to_user_id = auth.uid());

drop policy if exists "users can send friend messages" on public.friend_messages;
create policy "users can send friend messages"
on public.friend_messages for insert
to authenticated
with check (from_user_id = auth.uid());

drop policy if exists "authenticated users can see non-closed rooms" on public.rooms;
create policy "authenticated users can see non-closed rooms"
on public.rooms for select
to authenticated
using (status <> 'closed');

drop policy if exists "anonymous users can see non-closed rooms" on public.rooms;
create policy "anonymous users can see non-closed rooms"
on public.rooms for select
to anon
using (status <> 'closed');

drop policy if exists "authenticated users can create rooms" on public.rooms;
create policy "authenticated users can create rooms"
on public.rooms for insert
to authenticated
with check (coalesce(host_user_id, auth.uid()) = auth.uid());

drop policy if exists "anonymous guests can create rooms" on public.rooms;
create policy "anonymous guests can create rooms"
on public.rooms for insert
to anon
with check (
  host_user_id is null
  and guest_user_id is null
  and host_registered = false
  and status in ('waiting', 'joined')
  and length(coalesce(host_name, '')) between 3 and 32
);

drop policy if exists "room players can update rooms" on public.rooms;
create policy "room players can update rooms"
on public.rooms for update
to authenticated
using (host_user_id = auth.uid() or guest_user_id = auth.uid())
with check (host_user_id = auth.uid() or guest_user_id = auth.uid());

drop policy if exists "anonymous guests can update guest rooms" on public.rooms;
create policy "anonymous guests can update guest rooms"
on public.rooms for update
to anon
using (
  status in ('waiting', 'joined')
  and (host_user_id is null or guest_user_id is null)
)
with check (
  status in ('waiting', 'joined', 'over', 'closed')
  and (host_user_id is null or guest_user_id is null)
);

drop policy if exists "authenticated users can join waiting rooms" on public.rooms;
create policy "authenticated users can join waiting rooms"
on public.rooms for update
to authenticated
using (
  status = 'waiting'
  and guest_user_id is null
  and (host_user_id is null or host_user_id <> auth.uid())
)
with check (
  status = 'joined'
  and guest_user_id = auth.uid()
  and (host_user_id is null or host_user_id <> auth.uid())
);

grant select on public.rooms to anon, authenticated;
grant insert, update on public.rooms to anon, authenticated;

drop policy if exists "room players can read room chat" on public.room_messages;
create policy "room players can read room chat"
on public.room_messages for select
to authenticated
using (
  exists (
    select 1 from public.rooms r
    where r.id = room_messages.room_id
      and (r.host_user_id = auth.uid() or r.guest_user_id = auth.uid())
  )
);

drop policy if exists "admins can read room chat" on public.room_messages;
create policy "admins can read room chat"
on public.room_messages for select
to authenticated
using (public.is_admin_user());

drop policy if exists "room players can write room chat" on public.room_messages;
create policy "room players can write room chat"
on public.room_messages for insert
to authenticated
with check (
  sender_user_id = auth.uid()
  and exists (
    select 1 from public.rooms r
    where r.id = room_messages.room_id
      and (r.host_user_id = auth.uid() or r.guest_user_id = auth.uid())
  )
);

drop policy if exists "users can see own rating events" on public.rating_events;
create policy "users can see own rating events"
on public.rating_events for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "users can insert own rating events" on public.rating_events;
create policy "users can insert own rating events"
on public.rating_events for insert
to authenticated
with check (user_id = auth.uid());

create or replace function public.delete_current_user()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  delete from auth.users
  where id = current_user_id;
end;
$$;

revoke all on function public.delete_current_user() from public;
grant execute on function public.delete_current_user() to authenticated;

create or replace function public.admin_email_whitelist()
returns text[]
language sql
immutable
as $$
  select array['volzay@yandex.ru', 'openthedoorcap@gmail.com']::text[]
$$;

revoke all on function public.admin_email_whitelist() from public;
grant execute on function public.admin_email_whitelist() to authenticated;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = any(public.admin_email_whitelist())
$$;

revoke all on function public.is_admin_user() from public;
grant execute on function public.is_admin_user() to authenticated;

create or replace function public.admin_set_profile_ban(
  target_profile_id uuid,
  should_ban boolean,
  ban_reason text default null
)
returns table (
  id uuid,
  banned_at timestamptz,
  banned_reason text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  affected_rows integer := 0;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if target_profile_id is null then
    raise exception 'Игрок не найден.';
  end if;

  if should_ban and target_profile_id = auth.uid() then
    raise exception 'Администратор не может заблокировать свой аккаунт.';
  end if;

  return query
  update public.profiles p
  set
    banned_at = case when should_ban then now() else null end,
    banned_reason = case when should_ban then nullif(trim(coalesce(ban_reason, '')), '') else null end,
    updated_at = now()
  where p.id = target_profile_id
  returning p.id, p.banned_at, p.banned_reason;

  get diagnostics affected_rows = row_count;
  if affected_rows = 0 then
    raise exception 'Игрок не найден.';
  end if;

  insert into public.admin_audit (actor_user_id, action, details)
  values (
    auth.uid(),
    case when should_ban then 'ban-user' else 'unban-user' end,
    jsonb_build_object('targetUserId', target_profile_id, 'reason', nullif(trim(coalesce(ban_reason, '')), ''))
  );
end;
$$;

revoke all on function public.admin_set_profile_ban(uuid, boolean, text) from public;
grant execute on function public.admin_set_profile_ban(uuid, boolean, text) to authenticated;

create or replace function public.admin_set_user_password(target_profile_id uuid, new_password text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_password text := coalesce(new_password, '');
  affected_rows integer := 0;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if char_length(clean_password) < 6 then
    raise exception 'Пароль должен быть не короче 6 символов.';
  end if;

  update auth.users u
  set
    encrypted_password = extensions.crypt(clean_password, extensions.gen_salt('bf')),
    updated_at = now(),
    recovery_token = '',
    confirmation_token = '',
    email_change = '',
    email_change_token_new = ''
  where u.id = target_profile_id;

  get diagnostics affected_rows = row_count;
  if affected_rows = 0 then
    raise exception 'Игрок не найден.';
  end if;

  insert into public.admin_audit (actor_user_id, action, details)
  values (auth.uid(), 'set-user-password', jsonb_build_object('targetUserId', target_profile_id));
end;
$$;

revoke all on function public.admin_set_user_password(uuid, text) from public;
grant execute on function public.admin_set_user_password(uuid, text) to authenticated;

create or replace function public.admin_player_stats()
returns table (
  user_id uuid,
  games_played integer,
  games_won integer
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select
    r.user_id,
    count(*)::integer as games_played,
    count(*) filter (where r.did_win)::integer as games_won
  from public.rating_events r
  group by r.user_id;
end;
$$;

revoke all on function public.admin_player_stats() from public;
grant execute on function public.admin_player_stats() to authenticated;

create or replace function public.admin_delete_room(target_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  target_code text := '';
  affected_rows integer := 0;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if target_room_id is null then
    raise exception 'Комната не найдена.';
  end if;

  select r.code into target_code
  from public.rooms r
  where r.id = target_room_id;

  delete from public.rooms r
  where r.id = target_room_id;

  get diagnostics affected_rows = row_count;
  if affected_rows = 0 then
    raise exception 'Комната не найдена.';
  end if;

  insert into public.admin_audit (actor_user_id, action, details)
  values (
    auth.uid(),
    'delete-room',
    jsonb_build_object('roomId', target_room_id, 'code', coalesce(target_code, ''))
  );
end;
$$;

revoke all on function public.admin_delete_room(uuid) from public;
grant execute on function public.admin_delete_room(uuid) to authenticated;

create or replace function public.admin_prune_room_archive(max_age_hours integer default 96)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  cutoff_at timestamptz := now() - make_interval(hours => greatest(coalesce(max_age_hours, 96), 1));
  deleted_count integer := 0;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  delete from public.rooms r
  where coalesce(r.archived_at, r.updated_at, r.created_at) < cutoff_at
    and (
      r.status in ('closed', 'over')
      or coalesce(r.game_state->>'phase', '') = 'over'
      or coalesce(r.game_state->>'winner', '') <> ''
      or coalesce(r.game_state->>'finishedAt', '') <> ''
    );

  get diagnostics deleted_count = row_count;

  if deleted_count > 0 then
    insert into public.admin_audit (actor_user_id, action, details)
    values (
      auth.uid(),
      'prune-room-archive',
      jsonb_build_object('maxAgeHours', greatest(coalesce(max_age_hours, 96), 1), 'deletedCount', deleted_count)
    );
  end if;

  return deleted_count;
end;
$$;

revoke all on function public.admin_prune_room_archive(integer) from public;
grant execute on function public.admin_prune_room_archive(integer) to authenticated;

create or replace function public.admin_delete_profile(target_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  target_name text := '';
  affected_rows integer := 0;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if target_profile_id is null then
    raise exception 'Игрок не найден.';
  end if;

  if target_profile_id = auth.uid() then
    raise exception 'Администратор не может удалить свой аккаунт.';
  end if;

  select p.nickname into target_name
  from public.profiles p
  where p.id = target_profile_id;

  update public.rooms r
  set
    status = 'closed',
    closed_reason = coalesce(r.closed_reason, 'Игрок удалён администратором.'),
    archived_at = coalesce(r.archived_at, now()),
    updated_at = now()
  where (r.host_user_id = target_profile_id or r.guest_user_id = target_profile_id)
    and r.status <> 'closed';

  insert into public.admin_audit (actor_user_id, action, details)
  values (
    auth.uid(),
    'delete-user',
    jsonb_build_object('targetUserId', target_profile_id, 'targetName', coalesce(target_name, ''))
  );

  delete from auth.users u
  where u.id = target_profile_id;

  get diagnostics affected_rows = row_count;
  if affected_rows = 0 then
    delete from public.profiles p
    where p.id = target_profile_id;
    get diagnostics affected_rows = row_count;
  end if;

  if affected_rows = 0 then
    raise exception 'Игрок не найден.';
  end if;
end;
$$;

revoke all on function public.admin_delete_profile(uuid) from public;
grant execute on function public.admin_delete_profile(uuid) to authenticated;

create or replace function public.admin_delete_guest(target_guest_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_name text := '';
  affected_rows integer := 0;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if target_guest_id is null or target_guest_id not like 'guest:%' then
    raise exception 'Гость не найден.';
  end if;

  select gp.name into target_name
  from public.guest_presence gp
  where gp.id = target_guest_id;

  delete from public.guest_presence gp
  where gp.id = target_guest_id;

  get diagnostics affected_rows = row_count;
  if affected_rows = 0 then
    raise exception 'Гость не найден.';
  end if;

  insert into public.admin_audit (actor_user_id, action, details)
  values (
    auth.uid(),
    'delete-guest',
    jsonb_build_object('targetGuestId', target_guest_id, 'targetName', coalesce(target_name, ''))
  );
end;
$$;

revoke all on function public.admin_delete_guest(text) from public;
grant execute on function public.admin_delete_guest(text) to authenticated;

create or replace function public.touch_room_spectator(
  p_code text,
  p_spectator_id text,
  p_spectator_name text,
  p_leave boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Z0-9-]', '', 'g'));
  safe_key text := regexp_replace(coalesce(nullif(p_spectator_id, ''), auth.uid()::text, gen_random_uuid()::text), '[^A-Za-z0-9_-]', '_', 'g');
  clean_name text := left(coalesce(nullif(trim(p_spectator_name), ''), 'Spectator'), 32);
  current_spectators jsonb := '{}'::jsonb;
  active_spectators jsonb := '{}'::jsonb;
  next_spectators jsonb := '{}'::jsonb;
  cutoff_at timestamptz := now() - interval '45 seconds';
  room_allow boolean := false;
  room_status text := '';
  next_count integer := 0;
begin
  select coalesce(r.spectators, '{}'::jsonb), r.allow_spectators, r.status
    into current_spectators, room_allow, room_status
  from public.rooms r
  where r.code = clean_code
  for update;

  if not found then
    raise exception 'Комната не найдена.';
  end if;

  if not room_allow or room_status <> 'joined' then
    raise exception 'Просмотр этой комнаты недоступен.';
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    into active_spectators
  from jsonb_each(current_spectators)
  where coalesce((value->>'lastSeen')::timestamptz, 'epoch'::timestamptz) >= cutoff_at;

  if p_leave then
    next_spectators := active_spectators - safe_key;
  else
    next_spectators := jsonb_set(
      active_spectators,
      array[safe_key],
      jsonb_build_object('name', clean_name, 'lastSeen', now()),
      true
    );
  end if;

  select count(*)::integer into next_count from jsonb_each(next_spectators);

  update public.rooms r
  set spectators = next_spectators
  where r.code = clean_code;

  return next_count;
end;
$$;

revoke all on function public.touch_room_spectator(text, text, text, boolean) from public;
grant execute on function public.touch_room_spectator(text, text, text, boolean) to authenticated;

create or replace function public.register_nickname_user(p_nickname text, p_password text)
returns table (
  id uuid,
  nickname text,
  email text,
  auth_email text,
  rating integer,
  tier text,
  rating_eligible boolean
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_nickname text := trim(coalesce(p_nickname, ''));
  clean_password text := coalesce(p_password, '');
  new_user_id uuid := gen_random_uuid();
  synthetic_email text := 'user-' || new_user_id::text || '@nickname.local';
  now_ts timestamptz := now();
begin
  if char_length(clean_nickname) < 3 or char_length(clean_nickname) > 20 then
    raise exception 'Никнейм должен быть от 3 до 20 символов.';
  end if;
  if clean_nickname ~ '[[:cntrl:]@]' then
    raise exception 'Никнейм содержит недопустимые символы.';
  end if;
  if char_length(clean_password) < 6 then
    raise exception 'Пароль должен быть не короче 6 символов.';
  end if;
  if exists (
    select 1 from public.profiles p
    where lower(p.nickname) = lower(clean_nickname)
  ) then
    raise exception 'Такой никнейм уже занят.';
  end if;

  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
  )
  values (
    '00000000-0000-0000-0000-000000000000',
    new_user_id,
    'authenticated',
    'authenticated',
    synthetic_email,
    extensions.crypt(clean_password, extensions.gen_salt('bf')),
    now_ts,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('nickname', clean_nickname, 'name', clean_nickname),
    now_ts,
    now_ts,
    '',
    '',
    '',
    ''
  );

  insert into auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at
  )
  values (
    new_user_id,
    new_user_id,
    jsonb_build_object('sub', new_user_id::text, 'email', synthetic_email, 'email_verified', true, 'phone_verified', false),
    'email',
    new_user_id::text,
    now_ts,
    now_ts,
    now_ts
  );

  update public.profiles p
  set
    nickname = clean_nickname,
    email = '',
    rating = 1000,
    tier = 'Bronze',
    rating_eligible = true,
    last_seen_at = now_ts
  where p.id = new_user_id;

  return query
  select
    p.id,
    p.nickname,
    p.email,
    synthetic_email,
    p.rating,
    p.tier,
    p.rating_eligible
  from public.profiles p
  where p.id = new_user_id;
end;
$$;

revoke all on function public.register_nickname_user(text, text) from public;
grant execute on function public.register_nickname_user(text, text) to anon, authenticated;

create or replace function public.nickname_auth_email(p_identifier text)
returns text
language sql
security definer
set search_path = public, auth
as $$
  select u.email
  from public.profiles p
  join auth.users u on u.id = p.id
  where lower(p.nickname) = lower(trim(coalesce(p_identifier, '')))
  limit 1
$$;

revoke all on function public.nickname_auth_email(text) from public;
grant execute on function public.nickname_auth_email(text) to anon, authenticated;

create or replace function public.archive_bot_training_game(p_room_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_code text := upper(trim(coalesce(p_room_code, '')));
  target_room public.rooms%rowtype;
  memory jsonb;
  decisions jsonb;
  outcome jsonb;
  saved_id uuid;
  saved_count integer;
  resolved_bot_color text;
begin
  if clean_code = '' then
    raise exception 'Room code is required.';
  end if;

  select r.* into target_room
  from public.rooms r
  where r.code = clean_code
  limit 1;

  if target_room.id is null then
    raise exception 'Room not found.';
  end if;
  if target_room.host_user_id is not null
    and target_room.host_user_id is distinct from auth.uid()
    and not coalesce(public.is_admin_user(), false) then
    raise exception 'Only the room player can archive this game.';
  end if;
  if coalesce(target_room.game_state->>'mode', '') <> 'bot'
    or coalesce(target_room.game_state->>'variant', target_room.variant) <> 'long'
    or coalesce(target_room.game_state->>'botDifficulty', '') <> 'hard' then
    raise exception 'This room is not a hard long-bot game.';
  end if;
  if coalesce(target_room.game_state->>'winner', '') not in ('white', 'dark') then
    raise exception 'The game is not finished.';
  end if;

  memory := coalesce(target_room.game_state->'analysis'->'botMemory', '{}'::jsonb);
  decisions := coalesce(memory->'decisions', '[]'::jsonb);
  if jsonb_typeof(decisions) <> 'array' then
    decisions := '[]'::jsonb;
  end if;
  outcome := coalesce(memory->'outcome', '{}'::jsonb);
  resolved_bot_color := coalesce(
    nullif(outcome->>'botColor', ''),
    case
      when coalesce(target_room.game_state->'analysis'->>'playerColor', 'white') = 'white'
        then 'dark'
      else 'white'
    end
  );

  insert into public.bot_training_games (
    room_id,
    room_code,
    player_user_id,
    player_name,
    bot_name,
    engine_version,
    difficulty,
    bot_color,
    winner,
    result_type,
    decision_count,
    decisions,
    final_state,
    completed_at
  )
  values (
    target_room.id,
    target_room.code,
    target_room.host_user_id,
    target_room.host_name,
    coalesce(target_room.guest_name, target_room.game_state->'analysis'->>'botName', 'Hard bot'),
    coalesce(memory->>'engineVersion', ''),
    coalesce(target_room.game_state->>'botDifficulty', 'hard'),
    resolved_bot_color,
    target_room.game_state->>'winner',
    coalesce(nullif(target_room.game_state->>'resultType', ''), 'normal'),
    jsonb_array_length(decisions),
    decisions,
    target_room.game_state,
    coalesce(target_room.archived_at, now())
  )
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
    completed_at = excluded.completed_at
  returning id, decision_count into saved_id, saved_count;

  return jsonb_build_object(
    'ok', true,
    'id', saved_id,
    'roomCode', target_room.code,
    'decisionCount', saved_count
  );
end;
$$;

revoke all on function public.archive_bot_training_game(text) from public;
grant execute on function public.archive_bot_training_game(text) to anon, authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.rooms;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.room_messages;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.friend_messages;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.friend_requests;
  exception when duplicate_object then null;
  end;
end $$;

notify pgrst, 'reload schema';
