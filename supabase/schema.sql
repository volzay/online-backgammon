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
  read_at timestamptz,
  created_at timestamptz not null default now()
);

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
  created_at timestamptz not null default now(),
  joined_at timestamptz,
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  closed_reason text
);

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
  delta integer not null default 0,
  rating_after integer not null,
  created_at timestamptz not null default now(),
  unique (user_id, result_key)
);

create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.friend_messages enable row level security;
alter table public.rooms enable row level security;
alter table public.room_messages enable row level security;
alter table public.rating_events enable row level security;
alter table public.admin_audit enable row level security;

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

drop policy if exists "authenticated users can create rooms" on public.rooms;
create policy "authenticated users can create rooms"
on public.rooms for insert
to authenticated
with check (coalesce(host_user_id, auth.uid()) = auth.uid());

drop policy if exists "room players can update rooms" on public.rooms;
create policy "room players can update rooms"
on public.rooms for update
to authenticated
using (host_user_id = auth.uid() or guest_user_id = auth.uid())
with check (host_user_id = auth.uid() or guest_user_id = auth.uid());

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
