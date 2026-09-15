create extension if not exists pgcrypto;
create extension if not exists pg_cron;

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
  client_message_id text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.friend_messages
  add column if not exists kind text not null default 'text',
  add column if not exists audio_data text,
  add column if not exists mime_type text,
  add column if not exists duration integer not null default 0,
  add column if not exists client_message_id text;

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

create unique index if not exists friend_messages_sender_client_unique
on public.friend_messages (from_user_id, client_message_id)
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

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  variant text not null default 'long' check (variant in ('long', 'short')),
  access text not null default 'open' check (access in ('open', 'closed')),
  password_hash text,
  status text not null default 'waiting' check (status in ('waiting', 'joined', 'over', 'closed')),
  host_user_id uuid references public.profiles(id) on delete set null,
  guest_user_id uuid references public.profiles(id) on delete set null,
  host_guest_id text,
  guest_guest_id text,
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

create or replace function public.set_room_updated_at()
returns trigger
language plpgsql
as $$
begin
  -- Spectator heartbeats live in the same row but must not invalidate the
  -- optimistic lock used to merge the two player-presence slots.
  if (to_jsonb(new) - 'updated_at' - 'spectators')
     is not distinct from
     (to_jsonb(old) - 'updated_at' - 'spectators') then
    new.updated_at = old.updated_at;
  else
    new.updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_set_updated_at on public.rooms;
create trigger rooms_set_updated_at
before update on public.rooms
for each row execute function public.set_room_updated_at();

create or replace function public.validate_room_game_state()
returns trigger
language plpgsql
as $$
declare
  gs jsonb := new.game_state;
  points jsonb;
  point record;
  white_total integer := 0;
  dark_total integer := 0;
  winner text;
  winner_off integer;
  conceded boolean := false;
  history_item jsonb;
begin
  if gs is null or gs = old.game_state then
    return new;
  end if;

  if new.game_version <= old.game_version then
    raise exception 'game_version must increase when game_state changes (old=%, new=%)',
      old.game_version, new.game_version;
  end if;

  points := gs->'points';
  if points is null or jsonb_typeof(points) <> 'object' then
    raise exception 'game_state.points must be an object';
  end if;
  if coalesce(gs#>>'{off,white}', '') !~ '^[0-9]+$'
     or coalesce(gs#>>'{off,dark}', '') !~ '^[0-9]+$'
     or coalesce(gs#>>'{bar,white}', '') !~ '^[0-9]+$'
     or coalesce(gs#>>'{bar,dark}', '') !~ '^[0-9]+$' then
    raise exception 'off and bar checker counts must be non-negative integers';
  end if;

  for point in select key, value from jsonb_each(points) loop
    if point.key !~ '^[0-9]+$'
       or point.key::integer not between 1 and 24
       or jsonb_typeof(point.value) <> 'object'
       or point.value->>'color' not in ('white', 'dark')
       or coalesce(point.value->>'count', '') !~ '^[1-9][0-9]*$' then
      raise exception 'invalid point entry at %', point.key;
    end if;
    if point.value->>'color' = 'white' then
      white_total := white_total + (point.value->>'count')::integer;
    else
      dark_total := dark_total + (point.value->>'count')::integer;
    end if;
  end loop;

  white_total := white_total
    + (gs#>>'{off,white}')::integer
    + (gs#>>'{bar,white}')::integer;
  dark_total := dark_total
    + (gs#>>'{off,dark}')::integer
    + (gs#>>'{bar,dark}')::integer;
  if white_total <> 15 or dark_total <> 15 then
    raise exception 'board integrity violation (white=%, dark=%)', white_total, dark_total;
  end if;

  winner := gs->>'winner';
  if winner is not null and winner not in ('white', 'dark') then
    raise exception 'invalid winner color';
  end if;
  if winner in ('white', 'dark') then
    winner_off := (gs #>> array['off', winner])::integer;
    conceded := gs->'networkLoss' is not null
      and gs->'networkLoss' not in ('false'::jsonb, 'null'::jsonb);
    if not conceded and jsonb_typeof(gs->'history') = 'array' then
      for history_item in select value from jsonb_array_elements(gs->'history') loop
        if (history_item->'resign' is not null and history_item->'resign' not in ('false'::jsonb, 'null'::jsonb))
           or (history_item->'networkLoss' is not null and history_item->'networkLoss' not in ('false'::jsonb, 'null'::jsonb))
           or (history_item->'leave' is not null and history_item->'leave' not in ('false'::jsonb, 'null'::jsonb))
           or (history_item->'timeout' is not null and history_item->'timeout' not in ('false'::jsonb, 'null'::jsonb)) then
          conceded := true;
          exit;
        end if;
      end loop;
    end if;
    if winner_off <> 15 and not conceded then
      raise exception 'declared win is not supported by the board position';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists validate_room_game_state_trg on public.rooms;
create trigger validate_room_game_state_trg
before update on public.rooms
for each row
when (new.game_state is distinct from old.game_state)
execute function public.validate_room_game_state();

create index if not exists rooms_status_created_idx
on public.rooms (status, created_at desc);

with duplicate_waiting_rooms as (
  select
    id,
    row_number() over (
      partition by host_user_id
      order by created_at desc, id desc
    ) as room_number
  from public.rooms
  where host_user_id is not null
    and guest_user_id is null
    and status = 'waiting'
)
update public.rooms
set
  status = 'closed',
  archived_at = now(),
  closed_reason = 'duplicate_waiting_room'
where id in (
  select id
  from duplicate_waiting_rooms
  where room_number > 1
);

create unique index if not exists rooms_one_waiting_room_per_host_idx
on public.rooms (host_user_id)
where host_user_id is not null
  and guest_user_id is null
  and status = 'waiting';

-- A stable registered or guest identity may belong to only one active room,
-- regardless of seat. Repair legacy duplicates before installing the indexes
-- and cross-role claim triggers. Started games outrank waiting rooms; rooms of
-- the same kind retain the newest one.
begin;

alter table public.rooms
add column if not exists host_guest_id text;

alter table public.rooms
add column if not exists guest_guest_id text;

create schema if not exists private;

create or replace function private.guest_identity_from_proof(proof text)
returns text
language sql
immutable
strict
set search_path = pg_catalog, extensions
as $$
  select case
    when proof ~ '^gproof:[0-9a-f]{64}$' then
      'guest:sha256:' || encode(
        extensions.digest(convert_to('nardu/guest/v1:' || proof, 'UTF8'), 'sha256'),
        'hex'
      )
    else null
  end
$$;

revoke all on function private.guest_identity_from_proof(text)
from public, anon, authenticated;

create or replace function public.request_guest_identity()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, private
as $$
declare
  request_headers jsonb := coalesce(
    nullif(current_setting('request.headers', true), ''),
    '{}'
  )::jsonb;
  declared_guest_id text := request_headers ->> 'x-guest-id';
  proven_guest_id text := private.guest_identity_from_proof(
    request_headers ->> 'x-guest-proof'
  );
begin
  if declared_guest_id ~ '^guest:sha256:[0-9a-f]{64}$'
     and declared_guest_id = proven_guest_id then
    return declared_guest_id;
  end if;
  return null;
end;
$$;

revoke all on function public.request_guest_identity()
from public, anon, authenticated;
grant execute on function public.request_guest_identity()
to anon, authenticated;

drop policy if exists "authenticated users can create rooms" on public.rooms;
create policy "authenticated users can create rooms"
on public.rooms for insert
to authenticated
with check (
  host_user_id = auth.uid()
  and host_guest_id is null
  and guest_user_id is null
  and guest_guest_id is null
  and status in ('waiting', 'joined')
);

drop policy if exists "anonymous guests can create rooms" on public.rooms;
create policy "anonymous guests can create rooms"
on public.rooms for insert
to anon
with check (
  host_user_id is null
  and host_guest_id is not null
  and host_guest_id = public.request_guest_identity()
  and host_guest_id ~ '^guest:sha256:[0-9a-f]{64}$'
  and guest_user_id is null
  and guest_guest_id is null
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
  and public.request_guest_identity() in (host_guest_id, guest_guest_id)
  and not (
    host_user_id is not null
    and coalesce(game_state->>'mode', game_state->'analysis'->>'mode', '') = 'bot'
  )
)
with check (
  status in ('waiting', 'joined', 'over', 'closed')
  and (host_user_id is null or guest_user_id is null)
  and public.request_guest_identity() in (host_guest_id, guest_guest_id)
  and (host_guest_id is null or host_guest_id ~ '^guest:sha256:[0-9a-f]{64}$')
  and (guest_guest_id is null or guest_guest_id ~ '^guest:sha256:[0-9a-f]{64}$')
  and not (host_user_id is not null and host_guest_id is not null)
  and not (guest_user_id is not null and guest_guest_id is not null)
  and not (
    host_user_id is not null
    and coalesce(game_state->>'mode', game_state->'analysis'->>'mode', '') = 'bot'
  )
);

drop policy if exists "anonymous guests can join waiting rooms" on public.rooms;
create policy "anonymous guests can join waiting rooms"
on public.rooms for update
to anon
using (
  status = 'waiting'
  and guest_user_id is null
  and guest_guest_id is null
  and public.request_guest_identity() is not null
  and public.request_guest_identity() is distinct from host_guest_id
  and not (
    host_user_id is not null
    and coalesce(game_state->>'mode', game_state->'analysis'->>'mode', '') = 'bot'
  )
)
with check (
  status = 'joined'
  and guest_user_id is null
  and guest_guest_id = public.request_guest_identity()
  and not (host_user_id is not null and host_guest_id is not null)
);

drop policy if exists "authenticated users can join waiting rooms" on public.rooms;
create policy "authenticated users can join waiting rooms"
on public.rooms for update
to authenticated
using (
  status = 'waiting'
  and guest_user_id is null
  and guest_guest_id is null
  and (host_user_id is null or host_user_id <> auth.uid())
)
with check (
  status = 'joined'
  and guest_user_id = auth.uid()
  and guest_guest_id is null
  and (host_user_id is null or host_user_id <> auth.uid())
);

drop trigger if exists rooms_validate_participant_transition_trg on public.rooms;
drop trigger if exists rooms_enforce_single_active_room_per_player_trg on public.rooms;

lock table public.rooms in share row exclusive mode;

-- Raw guest:* values used to be both public data and ownership bearers. They
-- cannot be rotated safely, so archive active legacy rooms and scrub the raw
-- values before installing proof-only constraints.
update public.rooms room
set
  status = 'closed',
  archived_at = now(),
  closed_reason = 'legacy_guest_credential_rotated'
where room.status in ('waiting', 'joined')
  and (
    (room.host_guest_id is not null and room.host_guest_id !~ '^guest:sha256:[0-9a-f]{64}$')
    or (room.guest_guest_id is not null and room.guest_guest_id !~ '^guest:sha256:[0-9a-f]{64}$')
  );

update public.rooms room
set host_guest_id = null
where room.host_guest_id is not null
  and room.host_guest_id !~ '^guest:sha256:[0-9a-f]{64}$';

update public.rooms room
set guest_guest_id = null
where room.guest_guest_id is not null
  and room.guest_guest_id !~ '^guest:sha256:[0-9a-f]{64}$';

-- Pre-v34 anonymous seats cannot be recovered safely: the browser has no
-- durable credential that could prove ownership. Archive those rows instead of
-- minting a predictable room-derived guest id that nobody legitimately owns.
update public.rooms room
set
  status = 'closed',
  archived_at = now(),
  closed_reason = 'legacy_guest_identity_missing'
where room.status in ('waiting', 'joined')
  and (
    (
      room.host_user_id is null
      and room.host_guest_id is null
    )
    or (
      room.status = 'joined'
      and room.guest_user_id is null
      and room.guest_guest_id is null
      and 'bot' not in (
        coalesce(room.game_state->>'mode', ''),
        coalesce(room.game_state->>'opponent', ''),
        coalesce(room.game_state->'analysis'->>'mode', ''),
        coalesce(room.game_state->'analysis'->>'opponent', '')
      )
    )
  );

update public.rooms room
set
  status = 'closed',
  archived_at = now(),
  closed_reason = 'duplicate_player_seats'
where room.status in ('waiting', 'joined')
  and (
    (
      room.host_user_id is not null
      and room.host_user_id = room.guest_user_id
    )
    or (
      room.host_guest_id is not null
      and room.host_guest_id = room.guest_guest_id
    )
  );

-- Normalize pre-v34 rows that cannot participate in the lifecycle state
-- machine. A waiting room never has an occupied guest seat. A joined room must
-- either have a durable guest identity or be recognizably owned by the bot
-- engine. Closing malformed rows is safer than inventing a player identity or
-- leaving an unjoinable room active.
update public.rooms room
set
  status = 'closed',
  archived_at = now(),
  closed_reason = 'invalid_active_room_shape'
where (
    room.status = 'waiting'
    and (
      room.guest_user_id is not null
      or room.guest_guest_id is not null
    )
  )
  or (
    room.status = 'joined'
    and room.guest_user_id is null
    and room.guest_guest_id is null
    and 'bot' not in (
      coalesce(room.game_state->>'mode', ''),
      coalesce(room.game_state->>'opponent', ''),
      coalesce(room.game_state->'analysis'->>'mode', ''),
      coalesce(room.game_state->'analysis'->>'opponent', '')
    )
  );

with active_memberships as (
  select
    room.id as room_id,
    'user:' || room.host_user_id::text as identity_key,
    room.status,
    room.joined_at,
    room.created_at
  from public.rooms room
  where room.status in ('waiting', 'joined')
    and room.host_user_id is not null

  union

  select
    room.id as room_id,
    'user:' || room.guest_user_id::text as identity_key,
    room.status,
    room.joined_at,
    room.created_at
  from public.rooms room
  where room.status in ('waiting', 'joined')
    and room.guest_user_id is not null

  union

  select
    room.id as room_id,
    room.host_guest_id as identity_key,
    room.status,
    room.joined_at,
    room.created_at
  from public.rooms room
  where room.status in ('waiting', 'joined')
    and room.host_guest_id is not null

  union

  select
    room.id as room_id,
    room.guest_guest_id as identity_key,
    room.status,
    room.joined_at,
    room.created_at
  from public.rooms room
  where room.status in ('waiting', 'joined')
    and room.guest_guest_id is not null
), ranked_memberships as (
  select
    membership.room_id,
    row_number() over (
      partition by membership.identity_key
      order by
        case membership.status when 'joined' then 0 else 1 end,
        coalesce(membership.joined_at, membership.created_at) desc,
        membership.created_at desc,
        membership.room_id desc
    ) as room_number
  from active_memberships membership
), duplicate_rooms as (
  select distinct membership.room_id
  from ranked_memberships membership
  where membership.room_number > 1
)
update public.rooms room
set
  status = 'closed',
  archived_at = now(),
  closed_reason = 'duplicate_active_room'
where room.id in (select duplicate.room_id from duplicate_rooms duplicate)
  and room.status in ('waiting', 'joined');

-- Recreate these indexes so rerunning the canonical schema replaces any
-- earlier definition that used the same name with a stale predicate.
drop index if exists public.rooms_one_active_room_per_host_idx;
drop index if exists public.rooms_one_active_room_per_guest_idx;
drop index if exists public.rooms_one_active_room_per_host_guest_idx;
drop index if exists public.rooms_one_active_room_per_guest_guest_idx;

create unique index rooms_one_active_room_per_host_idx
on public.rooms (host_user_id)
where host_user_id is not null
  and status in ('waiting', 'joined');

create unique index rooms_one_active_room_per_guest_idx
on public.rooms (guest_user_id)
where guest_user_id is not null
  and status in ('waiting', 'joined');

create unique index rooms_one_active_room_per_host_guest_idx
on public.rooms (host_guest_id)
where host_guest_id is not null
  and status in ('waiting', 'joined');

create unique index rooms_one_active_room_per_guest_guest_idx
on public.rooms (guest_guest_id)
where guest_guest_id is not null
  and status in ('waiting', 'joined');

alter table public.rooms
drop constraint if exists rooms_participant_identity_shape_chk;

alter table public.rooms
add constraint rooms_participant_identity_shape_chk check (
  (host_guest_id is null or (
    host_user_id is null
    and host_guest_id ~ '^guest:sha256:[0-9a-f]{64}$'
  ))
  and (guest_guest_id is null or (
    guest_user_id is null
    and guest_guest_id ~ '^guest:sha256:[0-9a-f]{64}$'
  ))
);

alter table public.rooms
drop constraint if exists rooms_active_distinct_participants_chk;

alter table public.rooms
add constraint rooms_active_distinct_participants_chk check (
  status not in ('waiting', 'joined')
  or (
    (host_user_id is null or guest_user_id is null or host_user_id <> guest_user_id)
    and (host_guest_id is null or guest_guest_id is null or host_guest_id <> guest_guest_id)
  )
);

alter table public.rooms
drop constraint if exists rooms_waiting_guest_seats_empty_chk;

alter table public.rooms
add constraint rooms_waiting_guest_seats_empty_chk check (
  status <> 'waiting'
  or (
    guest_user_id is null
    and guest_guest_id is null
  )
);

alter table public.rooms
drop constraint if exists rooms_joined_has_opponent_chk;

alter table public.rooms
add constraint rooms_joined_has_opponent_chk check (
  status <> 'joined'
  or guest_user_id is not null
  or guest_guest_id is not null
  or 'bot' in (
    coalesce(game_state->>'mode', ''),
    coalesce(game_state->>'opponent', ''),
    coalesce(game_state->'analysis'->>'mode', ''),
    coalesce(game_state->'analysis'->>'opponent', '')
  )
);

create schema if not exists private;

create table if not exists private.active_room_players (
  player_id uuid primary key references public.profiles(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

create index if not exists active_room_players_room_idx
on private.active_room_players (room_id);

create table if not exists private.active_room_guests (
  guest_id text primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  check (guest_id ~ '^guest:sha256:[0-9a-f]{64}$')
);

create index if not exists active_room_guests_room_idx
on private.active_room_guests (room_id);

alter table private.active_room_players enable row level security;
alter table private.active_room_guests enable row level security;
revoke all on private.active_room_players from public, anon, authenticated, service_role;
revoke all on private.active_room_guests from public, anon, authenticated, service_role;

delete from private.active_room_players;
delete from private.active_room_guests;

insert into private.active_room_players (player_id, room_id)
select membership.player_id, membership.room_id
from (
  select room.host_user_id as player_id, room.id as room_id
  from public.rooms room
  where room.status in ('waiting', 'joined')
    and room.host_user_id is not null

  union

  select room.guest_user_id as player_id, room.id as room_id
  from public.rooms room
  where room.status in ('waiting', 'joined')
    and room.guest_user_id is not null
) membership
order by membership.player_id::text;

insert into private.active_room_guests (guest_id, room_id)
select membership.guest_id, membership.room_id
from (
  select room.host_guest_id as guest_id, room.id as room_id
  from public.rooms room
  where room.status in ('waiting', 'joined')
    and room.host_guest_id is not null

  union

  select room.guest_guest_id as guest_id, room.id as room_id
  from public.rooms room
  where room.status in ('waiting', 'joined')
    and room.guest_guest_id is not null
) membership
order by membership.guest_id;

create or replace function public.validate_room_participant_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  request_role text := coalesce(auth.role(), '');
  player_id uuid := auth.uid();
  request_guest_id text := public.request_guest_identity();
  identities_unchanged boolean := false;
begin
  if request_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if request_role = 'authenticated' and coalesce(public.is_admin_user(), false) then
    return new;
  end if;

  -- Same-state writes carry game/presence updates. Every actual state change is
  -- forward-only. Service-role, SQL maintenance and authenticated admins have
  -- already returned above so repair jobs can still normalize legacy rows.
  if tg_op = 'UPDATE' then
    if new.status is distinct from old.status
       and not (
         (old.status = 'waiting' and new.status in ('joined', 'closed'))
         or (old.status = 'joined' and new.status in ('over', 'closed'))
         or (old.status = 'over' and new.status = 'closed')
       ) then
      raise exception using
        errcode = '23514',
        message = format(
          'Invalid room status transition from %s to %s.',
          old.status,
          new.status
        ),
        constraint = 'rooms_status_transition';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if request_role = 'authenticated'
       and player_id is not null
       and new.host_user_id = player_id
       and new.host_guest_id is null
       and new.guest_user_id is null
       and new.guest_guest_id is null
       and new.status in ('waiting', 'joined') then
      return new;
    end if;

    if request_role = 'anon'
       and new.host_user_id is null
       and new.host_guest_id is not null
       and new.host_guest_id = request_guest_id
       and new.host_guest_id ~ '^guest:sha256:[0-9a-f]{64}$'
       and new.guest_user_id is null
       and new.guest_guest_id is null
       and new.status in ('waiting', 'joined') then
      return new;
    end if;

    raise exception using
      errcode = '42501',
      message = 'Invalid room participant identities for creation.';
  end if;

  identities_unchanged :=
    new.host_user_id is not distinct from old.host_user_id
    and new.guest_user_id is not distinct from old.guest_user_id
    and new.host_guest_id is not distinct from old.host_guest_id
    and new.guest_guest_id is not distinct from old.guest_guest_id;
  if request_role = 'authenticated'
     and identities_unchanged
     and not (
       old.status = 'waiting'
       and new.status = 'joined'
       and old.guest_user_id is null
       and old.guest_guest_id is null
     ) then
    return new;
  end if;

  if request_role = 'authenticated'
     and player_id is not null
     and old.status = 'waiting'
     and new.status = 'joined'
     and old.guest_user_id is null
     and old.guest_guest_id is null
     and new.guest_user_id = player_id
     and new.guest_guest_id is null
     and new.host_user_id is not distinct from old.host_user_id
     and new.host_guest_id is not distinct from old.host_guest_id
     and old.host_user_id is distinct from player_id then
    return new;
  end if;

  if request_role = 'anon'
     and old.status = 'waiting'
     and new.status = 'joined'
     and old.guest_user_id is null
     and old.guest_guest_id is null
     and new.guest_user_id is null
     and new.guest_guest_id is not null
     and new.guest_guest_id = request_guest_id
     and new.guest_guest_id ~ '^guest:sha256:[0-9a-f]{64}$'
     and new.host_user_id is not distinct from old.host_user_id
     and new.host_guest_id is not distinct from old.host_guest_id
     and request_guest_id is distinct from old.host_guest_id then
    return new;
  end if;

  if request_role = 'anon'
     and identities_unchanged
     and request_guest_id is not null
     and (
       request_guest_id = old.host_guest_id
       or request_guest_id = old.guest_guest_id
     )
     and not (
       old.status = 'waiting'
       and new.status = 'joined'
       and old.guest_user_id is null
       and old.guest_guest_id is null
     ) then
    return new;
  end if;

  raise exception using
    errcode = '42501',
    message = 'Room participant identities are immutable.';
end;
$$;

revoke all on function public.validate_room_participant_transition()
from public, anon, authenticated;

create trigger rooms_validate_participant_transition_trg
before insert or update of status, host_user_id, guest_user_id, host_guest_id, guest_guest_id
on public.rooms
for each row execute function public.validate_room_participant_transition();

create or replace function public.enforce_single_active_room_per_player()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  old_identity_keys text[] := array[]::text[];
  new_identity_keys text[] := array[]::text[];
  lock_identity_key text;
  claimed_player_id uuid;
  conflicting_room_code text;
begin
  if tg_op = 'UPDATE' then
    if old.status in ('waiting', 'joined') then
      old_identity_keys := array[
        case when old.host_user_id is not null then 'user:' || old.host_user_id::text end,
        case when old.guest_user_id is not null then 'user:' || old.guest_user_id::text end,
        old.host_guest_id,
        old.guest_guest_id
      ]::text[];
    end if;
  end if;

  if new.status in ('waiting', 'joined') then
    new_identity_keys := array[
      case when new.host_user_id is not null then 'user:' || new.host_user_id::text end,
      case when new.guest_user_id is not null then 'user:' || new.guest_user_id::text end,
      new.host_guest_id,
      new.guest_guest_id
    ]::text[];
  end if;

  for lock_identity_key in
    select participant.identity_key
    from unnest(old_identity_keys || new_identity_keys) as participant(identity_key)
    where participant.identity_key is not null
    group by participant.identity_key
    order by participant.identity_key
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('rooms:active-player:' || lock_identity_key, 0)
    );
  end loop;

  if tg_op = 'UPDATE' then
    delete from private.active_room_players claim
    where claim.room_id = old.id;
    delete from private.active_room_guests claim
    where claim.room_id = old.id;
  end if;

  if new.status not in ('waiting', 'joined') then
    return new;
  end if;

  for lock_identity_key in
    select participant.identity_key
    from unnest(new_identity_keys) as participant(identity_key)
    where participant.identity_key is not null
    group by participant.identity_key
    order by participant.identity_key
  loop
    conflicting_room_code := null;

    select room.code
    into conflicting_room_code
    from public.rooms room
    where room.id is distinct from new.id
      and room.status in ('waiting', 'joined')
      and (
        ('user:' || room.host_user_id::text) = lock_identity_key
        or ('user:' || room.guest_user_id::text) = lock_identity_key
        or room.host_guest_id = lock_identity_key
        or room.guest_guest_id = lock_identity_key
      )
    order by
      case room.status when 'joined' then 0 else 1 end,
      coalesce(room.joined_at, room.created_at) desc,
      room.created_at desc,
      room.id desc
    limit 1;

    if conflicting_room_code is not null then
      raise exception using
        errcode = '23505',
        message = format(
          'Player %s already has active room %s.',
          lock_identity_key,
          conflicting_room_code
        ),
        detail = format(
          'identity_key=%s, attempted_room=%s, conflicting_room=%s',
          lock_identity_key,
          new.code,
          conflicting_room_code
        ),
        constraint = 'rooms_one_active_room_per_player';
    end if;

    begin
      if left(lock_identity_key, 5) = 'user:' then
        claimed_player_id := substring(lock_identity_key from 6)::uuid;
        insert into private.active_room_players (player_id, room_id)
        values (claimed_player_id, new.id);
      else
        insert into private.active_room_guests (guest_id, room_id)
        values (lock_identity_key, new.id);
      end if;
    exception
      when unique_violation then
        conflicting_room_code := null;

        if left(lock_identity_key, 5) = 'user:' then
          select room.code
          into conflicting_room_code
          from private.active_room_players claim
          join public.rooms room on room.id = claim.room_id
          where claim.player_id = claimed_player_id
          limit 1;
        else
          select room.code
          into conflicting_room_code
          from private.active_room_guests claim
          join public.rooms room on room.id = claim.room_id
          where claim.guest_id = lock_identity_key
          limit 1;
        end if;

        raise exception using
          errcode = '23505',
          message = format(
            'Player %s already has an active room%s.',
            lock_identity_key,
            case
              when conflicting_room_code is null then ''
              else ' ' || conflicting_room_code
            end
          ),
          detail = format(
            'identity_key=%s, attempted_room=%s, conflicting_room=%s',
            lock_identity_key,
            new.code,
            coalesce(conflicting_room_code, 'unknown')
          ),
          constraint = 'rooms_one_active_room_per_player';
    end;
  end loop;

  return new;
end;
$$;

revoke all on function public.enforce_single_active_room_per_player()
from public, anon, authenticated;

create trigger rooms_enforce_single_active_room_per_player_trg
after insert or update of status, host_user_id, guest_user_id, host_guest_id, guest_guest_id
on public.rooms
for each row execute function public.enforce_single_active_room_per_player();

commit;

-- Closing a room makes it intentionally invisible through the public SELECT
-- policy.  Use a narrow ownership-checked RPC so the terminal transition can
-- complete without exposing archived rooms to clients.
create or replace function public.close_own_waiting_room(p_room_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, auth
as $$
declare
  clean_code text := upper(trim(coalesce(p_room_code, '')));
  request_role text := coalesce(auth.role(), '');
  player_id uuid := auth.uid();
  guest_id text := case
    when coalesce(auth.role(), '') = 'anon' then public.request_guest_identity()
    else null
  end;
  closed_code text;
  owned_status text;
begin
  if clean_code !~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$' then
    raise exception 'Invalid room code.' using errcode = '22023';
  end if;

  if request_role not in ('authenticated', 'anon')
     or (request_role = 'authenticated' and player_id is null)
     or (request_role = 'anon' and guest_id is null) then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  update public.rooms room
  set
    status = 'closed',
    archived_at = now(),
    closed_reason = 'waiting_host_exit'
  where room.code = clean_code
    and room.status = 'waiting'
    and room.guest_user_id is null
    and room.guest_guest_id is null
    and (
      (player_id is not null and room.host_user_id = player_id)
      or (
        player_id is null
        and guest_id is not null
        and room.host_guest_id = guest_id
      )
    )
  returning room.code into closed_code;

  if closed_code is not null then
    return jsonb_build_object(
      'ok', true,
      'removed', true,
      'closed', true,
      'code', closed_code
    );
  end if;

  select room.status
  into owned_status
  from public.rooms room
  where room.code = clean_code
    and (
      (player_id is not null and room.host_user_id = player_id)
      or (
        player_id is null
        and guest_id is not null
        and room.host_guest_id = guest_id
      )
    )
  limit 1;

  if owned_status in ('waiting', 'joined') then
    return jsonb_build_object(
      'ok', true,
      'removed', false,
      'closed', false,
      'code', clean_code,
      'room', jsonb_build_object('code', clean_code, 'status', owned_status)
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'removed', false,
    'closed', true,
    'code', clean_code
  );
end;
$$;

revoke all on function public.close_own_waiting_room(text)
from public, anon, authenticated;
grant execute on function public.close_own_waiting_room(text) to anon, authenticated;

create or replace function public.close_own_lobby_rooms()
returns text[]
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  player_id uuid := auth.uid();
  unfinished_codes text[] := array[]::text[];
  abandoned_codes text[] := array[]::text[];
  closed_codes text[] := array[]::text[];
begin
  if player_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  -- The browser is authoritative for a completed bot game. Lobby cleanup must
  -- never manufacture a winner while its final request may still be in flight.
  with unfinished as (
    update public.rooms room
    set
      status = 'closed',
      archived_at = now(),
      closed_reason = 'lobby_exit_unfinished'
    where room.host_user_id = player_id
      and room.status = 'joined'
      and coalesce(room.game_state->>'winner', '') not in ('white', 'dark')
      and (
        coalesce(room.game_state->>'mode', '') = 'bot'
        or coalesce(room.game_state->'analysis'->>'mode', '') = 'bot'
    )
    returning room.code
  )
  select coalesce(array_agg(code order by code), array[]::text[])
  into unfinished_codes
  from unfinished;

  with closed as (
    update public.rooms
    set
      status = 'closed',
      archived_at = now(),
      closed_reason = 'lobby_exit'
    where host_user_id = player_id
      and status in ('waiting', 'joined')
    returning code
  )
  select coalesce(array_agg(code order by code), array[]::text[])
  into abandoned_codes
  from closed;

  closed_codes := unfinished_codes || abandoned_codes;
  return closed_codes;
end;
$$;

revoke all on function public.close_own_lobby_rooms() from public;
grant execute on function public.close_own_lobby_rooms() to authenticated;

create or replace function public.finish_room_game(
  p_room_code text,
  p_final_state jsonb,
  p_training_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  player_id uuid := auth.uid();
  target public.rooms%rowtype;
  next_version bigint;
  clean_code text := upper(trim(coalesce(p_room_code, '')));
  training_memory jsonb;
  training_decisions jsonb;
  training_outcome jsonb;
  training_coverage jsonb;
  resolved_bot_color text;
  training_id uuid;
  training_count integer := 0;
  training_archived boolean := false;
  already_finished boolean := false;
  completed_at timestamptz;
begin
  if player_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if coalesce(p_final_state->>'phase', '') <> 'over'
     or coalesce(p_final_state->>'winner', '') not in ('white', 'dark') then
    raise exception 'A finished game state is required.' using errcode = '22023';
  end if;

  select *
  into target
  from public.rooms
  where code = clean_code
  for update;

  if not found then
    raise exception 'Room not found.' using errcode = 'P0002';
  end if;
  if target.host_user_id is distinct from player_id
     and target.guest_user_id is distinct from player_id then
    raise exception 'Only room players can finish the game.' using errcode = '42501';
  end if;

  if coalesce(target.game_state->>'winner', '') in ('white', 'dark') then
    if target.game_state->>'winner' = p_final_state->>'winner'
       and coalesce(target.game_state->>'finishedAt', '') = coalesce(p_final_state->>'finishedAt', '') then
      already_finished := true;
      next_version := target.game_version;
    else
      raise exception 'Room already contains a different finished game.' using errcode = '23505';
    end if;
  end if;

  if not already_finished then
    if target.status = 'closed'
       and coalesce(target.closed_reason, '') not in ('lobby_exit', 'lobby_exit_repair', 'left', 'removed') then
      raise exception 'Room was closed by an administrator.' using errcode = '55000';
    end if;
    if target.status not in ('joined', 'over', 'closed') then
      raise exception 'Room has no active game.' using errcode = '55000';
    end if;

    next_version := target.game_version + 1;
    completed_at := now();
    update public.rooms
    set
      game_state = p_final_state,
      game_version = next_version,
      -- A late final payload may race with lobby cleanup. Preserve the final
      -- snapshot without reviving a terminally closed room.
      status = case when target.status = 'closed' then 'closed' else 'over' end,
      archived_at = completed_at,
      closed_reason = 'finished'
    where id = target.id;
  else
    completed_at := coalesce(target.archived_at, now());
  end if;

  if p_training_state is not null then
    if target.host_user_id is distinct from player_id
       or (
         coalesce(target.game_state->>'mode', target.game_state->'analysis'->>'mode', '') <> 'bot'
         and coalesce(target.game_state->>'opponent', target.game_state->'analysis'->>'opponent', '') <> 'bot'
       )
       or (
         coalesce(p_final_state->>'mode', p_final_state->'analysis'->>'mode', '') <> 'bot'
         and coalesce(p_final_state->>'opponent', p_final_state->'analysis'->>'opponent', '') <> 'bot'
       )
       or coalesce(target.game_state->>'botDifficulty', target.game_state->'analysis'->>'difficulty', '') <> 'hard'
       or coalesce(p_final_state->>'botDifficulty', '') <> 'hard'
       or coalesce(target.game_state->>'startedAt', '') <> coalesce(p_final_state->>'startedAt', '')
       or coalesce(p_training_state->>'phase', '') <> 'over'
       or coalesce(p_training_state->>'winner', '') not in ('white', 'dark')
       or coalesce(p_training_state->>'winner', '') <> coalesce(p_final_state->>'winner', '')
       or coalesce(p_training_state->>'roomCode', clean_code) <> clean_code
       or coalesce(p_training_state->>'mode', '') <> 'bot'
       or coalesce(p_training_state->>'variant', target.variant) not in ('long', 'short')
       or coalesce(p_training_state->>'variant', target.variant) <> coalesce(p_final_state->>'variant', target.variant)
       or coalesce(p_training_state->>'botDifficulty', '') <> 'hard'
       or coalesce(p_training_state->>'startedAt', '') <> coalesce(p_final_state->>'startedAt', '')
       or coalesce(p_training_state->>'finishedAt', '') <> coalesce(p_final_state->>'finishedAt', '')
       or coalesce(p_training_state->>'resultType', 'normal') <> coalesce(p_final_state->>'resultType', 'normal')
       or coalesce(p_training_state->'points', '{}'::jsonb) <> coalesce(p_final_state->'points', '{}'::jsonb)
       or coalesce(p_training_state->'off', '{}'::jsonb) <> coalesce(p_final_state->'off', '{}'::jsonb)
       or coalesce(p_training_state->'bar', '{}'::jsonb) <> coalesce(p_final_state->'bar', '{}'::jsonb)
       or coalesce(p_training_state->'score', '{}'::jsonb) <> coalesce(p_final_state->'score', '{}'::jsonb) then
      raise exception 'Training state does not match the finished game.' using errcode = '22023';
    end if;

    training_memory := coalesce(p_training_state->'analysis'->'botMemory', '{}'::jsonb);
    training_decisions := coalesce(training_memory->'decisions', '[]'::jsonb);
    if jsonb_typeof(training_decisions) <> 'array'
       or jsonb_array_length(training_decisions) = 0 then
      raise exception 'Bot training payload contains no decisions.' using errcode = '22023';
    end if;
    training_coverage := coalesce(training_memory->'coverage', '{}'::jsonb);
    if coalesce(p_training_state->>'variant', target.variant) = 'long'
       and coalesce(training_memory->>'engineVersion', '') in (
         'long-analytic-v29',
         'long-analytic-v30',
         'long-analytic-v31',
         'long-analytic-v32',
         'long-analytic-v33',
         'long-analytic-v34'
       ) then
      if jsonb_typeof(training_coverage) <> 'object'
         or coalesce(training_coverage->'complete', 'false'::jsonb) <> 'true'::jsonb
         or jsonb_typeof(training_coverage->'expectedBotDecisions') <> 'number'
         or jsonb_typeof(training_coverage->'recordedBotDecisions') <> 'number'
         or jsonb_typeof(training_coverage->'recoveredBotDecisions') <> 'number'
         or coalesce(training_coverage->>'expectedBotDecisions', '') !~ '^[0-9]+$'
         or coalesce(training_coverage->>'recordedBotDecisions', '') !~ '^[0-9]+$'
         or coalesce(training_coverage->>'recoveredBotDecisions', '') !~ '^[0-9]+$'
         or (training_coverage->>'expectedBotDecisions')::numeric <= 0
         or (training_coverage->>'expectedBotDecisions')::numeric <>
           (training_coverage->>'recordedBotDecisions')::numeric
             + (training_coverage->>'recoveredBotDecisions')::numeric then
        raise exception 'Long bot v29+ training payload has incomplete decision coverage.' using errcode = '22023';
      end if;
    end if;

    training_outcome := coalesce(training_memory->'outcome', '{}'::jsonb);
    resolved_bot_color := coalesce(
      nullif(training_outcome->>'botColor', ''),
      case
        when coalesce(p_training_state->'analysis'->>'playerColor', 'white') = 'white'
          then 'dark'
        else 'white'
      end
    );

    insert into public.bot_training_games (
      room_id, room_code, player_user_id, player_name, bot_name,
      engine_version, difficulty, bot_color, winner, result_type,
      decision_count, decisions, final_state, completed_at
    ) values (
      target.id,
      target.code,
      target.host_user_id,
      target.host_name,
      coalesce(target.guest_name, p_training_state->'analysis'->>'botName', 'Hard bot'),
      coalesce(training_memory->>'engineVersion', ''),
      'hard',
      resolved_bot_color,
      p_training_state->>'winner',
      coalesce(nullif(p_training_state->>'resultType', ''), 'normal'),
      jsonb_array_length(training_decisions),
      training_decisions,
      p_training_state,
      completed_at
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
    returning id, decision_count into training_id, training_count;
    training_archived := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'version', next_version,
    'alreadyFinished', already_finished,
    'trainingArchived', training_archived,
    'trainingId', training_id,
    'decisionCount', training_count
  );
end;
$$;

revoke all on function public.finish_room_game(text, jsonb, jsonb) from public;
grant execute on function public.finish_room_game(text, jsonb, jsonb) to authenticated;

create or replace function public.finish_room_game(
  p_room_code text,
  p_final_state jsonb
)
returns jsonb
language sql
security definer
set search_path = public, auth
as $$
  select public.finish_room_game($1, $2, null::jsonb)
$$;

revoke all on function public.finish_room_game(text, jsonb) from public;
grant execute on function public.finish_room_game(text, jsonb) to authenticated;

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
  client_message_id text,
  created_at timestamptz not null default now()
);

alter table public.room_messages
add column if not exists client_message_id text;

create index if not exists room_messages_room_created_idx
on public.room_messages (room_id, created_at);

create unique index if not exists room_messages_sender_client_unique
on public.room_messages (sender_user_id, client_message_id)
where client_message_id is not null;

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

create or replace function public.archive_finished_bot_training_game()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_state jsonb := coalesce(new.game_state, '{}'::jsonb);
  memory jsonb := coalesce(target_state->'analysis'->'botMemory', '{}'::jsonb);
  decisions jsonb := coalesce(memory->'decisions', '[]'::jsonb);
  outcome jsonb := coalesce(memory->'outcome', '{}'::jsonb);
  coverage jsonb := coalesce(memory->'coverage', '{}'::jsonb);
  resolved_bot_color text;
begin
  if coalesce(target_state->>'mode', '') <> 'bot'
    or coalesce(target_state->>'variant', new.variant) not in ('long', 'short')
    or coalesce(target_state->>'botDifficulty', '') <> 'hard'
    or coalesce(target_state->>'winner', '') not in ('white', 'dark')
    or jsonb_typeof(decisions) <> 'array'
    or jsonb_array_length(decisions) = 0 then
    return new;
  end if;

  -- v29+ experience is valid only when every expected bot turn was captured.
  -- Older long archives and short games remain readable and keep their
  -- existing archival behavior, but cannot accidentally satisfy this gate.
  if coalesce(target_state->>'variant', new.variant) = 'long'
    and coalesce(memory->>'engineVersion', '') in (
      'long-analytic-v29',
      'long-analytic-v30',
      'long-analytic-v31',
      'long-analytic-v32',
      'long-analytic-v33',
      'long-analytic-v34'
    ) then
    if jsonb_typeof(coverage) <> 'object'
      or coalesce(coverage->'complete', 'false'::jsonb) <> 'true'::jsonb
      or jsonb_typeof(coverage->'expectedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recordedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recoveredBotDecisions') <> 'number' then
      return new;
    end if;
    if coalesce(coverage->>'expectedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recordedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recoveredBotDecisions', '') !~ '^[0-9]+$' then
      return new;
    end if;
    if (coverage->>'expectedBotDecisions')::numeric <= 0
      or (coverage->>'expectedBotDecisions')::numeric <>
        (coverage->>'recordedBotDecisions')::numeric
          + (coverage->>'recoveredBotDecisions')::numeric then
      return new;
    end if;
  end if;

  resolved_bot_color := coalesce(
    nullif(outcome->>'botColor', ''),
    case
      when coalesce(target_state->'analysis'->>'playerColor', 'white') = 'white'
        then 'dark'
      else 'white'
    end
  );

  insert into public.bot_training_games (
    room_id, room_code, player_user_id, player_name, bot_name,
    engine_version, difficulty, bot_color, winner, result_type,
    decision_count, decisions, final_state, completed_at
  ) values (
    new.id,
    new.code,
    new.host_user_id,
    new.host_name,
    coalesce(new.guest_name, target_state->'analysis'->>'botName', 'Hard bot'),
    coalesce(memory->>'engineVersion', ''),
    'hard',
    resolved_bot_color,
    target_state->>'winner',
    coalesce(nullif(target_state->>'resultType', ''), 'normal'),
    jsonb_array_length(decisions),
    decisions,
    target_state,
    coalesce(new.archived_at, now())
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
    completed_at = excluded.completed_at;

  return new;
end;
$$;

drop trigger if exists rooms_archive_finished_bot_training on public.rooms;
create trigger rooms_archive_finished_bot_training
after insert or update of game_state, status on public.rooms
for each row execute function public.archive_finished_bot_training_game();

insert into public.bot_training_games (
  room_id, room_code, player_user_id, player_name, bot_name,
  engine_version, difficulty, bot_color, winner, result_type,
  decision_count, decisions, final_state, completed_at
)
select
  room.id,
  room.code,
  room.host_user_id,
  room.host_name,
  coalesce(room.guest_name, room.game_state->'analysis'->>'botName', 'Hard bot'),
  coalesce(room.game_state->'analysis'->'botMemory'->>'engineVersion', ''),
  'hard',
  coalesce(
    nullif(room.game_state->'analysis'->'botMemory'->'outcome'->>'botColor', ''),
    case
      when coalesce(room.game_state->'analysis'->>'playerColor', 'white') = 'white'
        then 'dark'
      else 'white'
    end
  ),
  room.game_state->>'winner',
  coalesce(nullif(room.game_state->>'resultType', ''), 'normal'),
  jsonb_array_length(room.game_state->'analysis'->'botMemory'->'decisions'),
  room.game_state->'analysis'->'botMemory'->'decisions',
  room.game_state,
  coalesce(room.archived_at, now())
from public.rooms room
where coalesce(room.game_state->>'mode', '') = 'bot'
  and coalesce(room.game_state->>'variant', room.variant) in ('long', 'short')
  and coalesce(room.game_state->>'botDifficulty', '') = 'hard'
  and coalesce(room.game_state->>'winner', '') in ('white', 'dark')
  and jsonb_typeof(room.game_state->'analysis'->'botMemory'->'decisions') = 'array'
  and jsonb_array_length(room.game_state->'analysis'->'botMemory'->'decisions') > 0
  and case
    when coalesce(room.game_state->>'variant', room.variant) = 'long'
      and coalesce(
        room.game_state->'analysis'->'botMemory'->>'engineVersion',
        ''
      ) in ('long-analytic-v29', 'long-analytic-v30', 'long-analytic-v31', 'long-analytic-v32', 'long-analytic-v33', 'long-analytic-v34') then
      coalesce(
        room.game_state->'analysis'->'botMemory'->'coverage'->'complete',
        'false'::jsonb
      ) = 'true'::jsonb
      and case
        when coalesce(
          room.game_state->'analysis'->'botMemory'->'coverage'->>'expectedBotDecisions',
          ''
        ) ~ '^[0-9]+$'
          and coalesce(
            room.game_state->'analysis'->'botMemory'->'coverage'->>'recordedBotDecisions',
            ''
          ) ~ '^[0-9]+$'
          and coalesce(
            room.game_state->'analysis'->'botMemory'->'coverage'->>'recoveredBotDecisions',
            ''
          ) ~ '^[0-9]+$' then
          (room.game_state->'analysis'->'botMemory'->'coverage'->>'expectedBotDecisions')::numeric > 0
          and (room.game_state->'analysis'->'botMemory'->'coverage'->>'expectedBotDecisions')::numeric =
            (room.game_state->'analysis'->'botMemory'->'coverage'->>'recordedBotDecisions')::numeric
              + (room.game_state->'analysis'->'botMemory'->'coverage'->>'recoveredBotDecisions')::numeric
        else false
      end
    else true
  end
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
  completed_at = excluded.completed_at;

create table if not exists public.room_game_archives (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  room_code text not null,
  result_key text not null,
  variant text not null default 'long' check (variant in ('long', 'short')),
  host_name text not null,
  guest_name text,
  winner text not null check (winner in ('white', 'dark')),
  result_type text not null default 'normal',
  borne_off jsonb not null default '{"white":0,"dark":0}'::jsonb,
  history_count integer not null default 0,
  final_state jsonb not null default '{}'::jsonb,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (room_id, result_key)
);

create index if not exists room_game_archives_completed_idx
on public.room_game_archives (completed_at desc);

create or replace function public.archive_finished_room_game()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  gs jsonb := coalesce(new.game_state, '{}'::jsonb);
  history jsonb := coalesce(gs->'history', '[]'::jsonb);
  resolved_history_count integer := 0;
  resolved_result_key text;
begin
  if coalesce(gs->>'winner', '') not in ('white', 'dark') then
    return new;
  end if;

  if jsonb_typeof(history) = 'array' then
    resolved_history_count := jsonb_array_length(history);
  else
    history := '[]'::jsonb;
  end if;

  resolved_result_key := concat(
    coalesce(
      nullif(gs->>'finishedAt', ''),
      nullif(gs->'history'->0->>'at', ''),
      concat('version:', new.game_version)
    ),
    ':',
    gs->>'winner',
    ':',
    coalesce(nullif(gs->>'resultType', ''), 'normal')
  );

  insert into public.room_game_archives (
    room_id,
    room_code,
    result_key,
    variant,
    host_name,
    guest_name,
    winner,
    result_type,
    borne_off,
    history_count,
    final_state,
    completed_at
  )
  values (
    new.id,
    new.code,
    resolved_result_key,
    new.variant,
    new.host_name,
    new.guest_name,
    gs->>'winner',
    coalesce(nullif(gs->>'resultType', ''), 'normal'),
    coalesce(gs->'borneOff', gs->'off', '{"white":0,"dark":0}'::jsonb),
    resolved_history_count,
    gs,
    coalesce(new.archived_at, new.updated_at, now())
  )
  on conflict (room_id, result_key) do update
  set
    winner = excluded.winner,
    result_type = excluded.result_type,
    borne_off = excluded.borne_off,
    history_count = excluded.history_count,
    final_state = excluded.final_state,
    completed_at = excluded.completed_at;

  return new;
end;
$$;

revoke all on function public.archive_finished_room_game() from public;

drop trigger if exists on_room_game_finished on public.rooms;
create trigger on_room_game_finished
after insert or update of game_state on public.rooms
for each row execute function public.archive_finished_room_game();

insert into public.room_game_archives (
  room_id,
  room_code,
  result_key,
  variant,
  host_name,
  guest_name,
  winner,
  result_type,
  borne_off,
  history_count,
  final_state,
  completed_at
)
select
  r.id,
  r.code,
  'room:' || coalesce(nullif(r.game_state->>'finishedAt', ''), r.game_version::text),
  r.variant,
  r.host_name,
  r.guest_name,
  r.game_state->>'winner',
  coalesce(nullif(r.game_state->>'resultType', ''), 'normal'),
  coalesce(r.game_state->'borneOff', r.game_state->'off', '{"white":0,"dark":0}'::jsonb),
  case
    when jsonb_typeof(r.game_state->'history') = 'array' then jsonb_array_length(r.game_state->'history')
    else 0
  end,
  r.game_state,
  coalesce(r.archived_at, r.updated_at, now())
from public.rooms r
where coalesce(r.game_state->>'winner', '') in ('white', 'dark')
on conflict (room_id, result_key) do nothing;

insert into public.room_game_archives (
  room_id,
  room_code,
  result_key,
  variant,
  host_name,
  guest_name,
  winner,
  result_type,
  borne_off,
  history_count,
  final_state,
  completed_at
)
select
  room.id,
  room.code,
  'rating:' || event.id::text,
  room.variant,
  room.host_name,
  room.guest_name,
  event.winner,
  coalesce(nullif(event.result_type, ''), 'normal'),
  off_counts.value,
  case when jsonb_typeof(event.history) = 'array' then jsonb_array_length(event.history) else 0 end,
  jsonb_build_object(
    'mode', event.mode,
    'variant', room.variant,
    'roomCode', room.code,
    'phase', 'over',
    'winner', event.winner,
    'resultType', coalesce(nullif(event.result_type, ''), 'normal'),
    'off', off_counts.value,
    'score', coalesce(event.score, '{}'::jsonb),
    'history', event.history,
    'finishedAt', event.created_at
  ),
  event.created_at
from public.rating_events event
join lateral (
  select candidate.*
  from public.rooms candidate
  where candidate.host_user_id = event.user_id
    and lower(coalesce(candidate.guest_name, '')) = lower(coalesce(event.opponent, ''))
    and candidate.created_at <= event.created_at + interval '5 minutes'
  order by abs(extract(epoch from (event.created_at - candidate.created_at)))
  limit 1
) room on true
cross join lateral (
  select jsonb_build_object(
    'white', count(*) filter (
      where item->>'color' = 'white' and item->>'to' in ('снято', 'borne-off')
    ),
    'dark', count(*) filter (
      where item->>'color' = 'dark' and item->>'to' in ('снято', 'borne-off')
    )
  ) as value
  from jsonb_array_elements(
    case when jsonb_typeof(event.history) = 'array' then event.history else '[]'::jsonb end
  ) item
) off_counts
where event.created_at >= now() - interval '96 hours'
  and event.winner in ('white', 'dark')
  and jsonb_typeof(event.history) = 'array'
  and jsonb_array_length(event.history) > 0
  and not exists (
    select 1
    from public.room_game_archives existing
    where existing.room_id = room.id
      and existing.winner = event.winner
      and existing.history_count = jsonb_array_length(event.history)
      and abs(extract(epoch from (existing.completed_at - event.created_at))) < 120
  )
on conflict (room_id, result_key) do nothing;

delete from public.room_game_archives rating_copy
where rating_copy.result_key like 'rating:%'
  and exists (
    select 1
    from public.room_game_archives captured
    where captured.room_id = rating_copy.room_id
      and captured.result_key not like 'rating:%'
      and captured.winner = rating_copy.winner
      and captured.history_count = rating_copy.history_count
      and abs(extract(epoch from (captured.completed_at - rating_copy.completed_at))) < 120
  );

create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_message_campaigns (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.profiles(id) on delete cascade,
  subject text not null default '',
  message text not null check (char_length(message) between 1 and 2000),
  min_rating integer,
  max_rating integer,
  recipient_count integer not null default 0,
  client_message_id text,
  created_at timestamptz not null default now(),
  check (min_rating is null or max_rating is null or min_rating <= max_rating)
);

create unique index if not exists admin_message_campaigns_sender_client_unique
on public.admin_message_campaigns (admin_user_id, client_message_id)
where client_message_id is not null;

create table if not exists public.admin_player_messages (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.profiles(id) on delete cascade,
  player_user_id uuid not null references public.profiles(id) on delete cascade,
  campaign_id uuid references public.admin_message_campaigns(id) on delete set null,
  direction text not null check (direction in ('admin', 'player')),
  subject text not null default '',
  text text not null check (char_length(text) between 1 and 2000),
  client_message_id text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists admin_player_messages_player_created_idx
on public.admin_player_messages (player_user_id, created_at desc);

create index if not exists admin_player_messages_admin_created_idx
on public.admin_player_messages (admin_user_id, created_at desc);

create unique index if not exists admin_player_messages_admin_client_unique
on public.admin_player_messages (admin_user_id, client_message_id)
where direction = 'admin' and client_message_id is not null;

create unique index if not exists admin_player_messages_player_client_unique
on public.admin_player_messages (player_user_id, client_message_id)
where direction = 'player' and client_message_id is not null;

alter table public.profiles enable row level security;
alter table public.guest_presence enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.friend_messages enable row level security;
alter table public.rooms enable row level security;
alter table public.room_messages enable row level security;
alter table public.rating_events enable row level security;
alter table public.bot_training_games enable row level security;
alter table public.room_game_archives enable row level security;
alter table public.admin_audit enable row level security;
alter table public.admin_message_campaigns enable row level security;
alter table public.admin_player_messages enable row level security;

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

drop policy if exists "admins can read message campaigns" on public.admin_message_campaigns;
create policy "admins can read message campaigns"
on public.admin_message_campaigns for select
to authenticated
using (public.is_admin_user());

drop policy if exists "admins and recipients can read admin messages" on public.admin_player_messages;
create policy "admins and recipients can read admin messages"
on public.admin_player_messages for select
to authenticated
using (public.is_admin_user() or player_user_id = auth.uid());

drop policy if exists "admins and recipients can mark admin messages read" on public.admin_player_messages;
create policy "admins and recipients can mark admin messages read"
on public.admin_player_messages for update
to authenticated
using (
  (public.is_admin_user() and direction = 'player')
  or (player_user_id = auth.uid() and direction = 'admin')
)
with check (
  (public.is_admin_user() and direction = 'player')
  or (player_user_id = auth.uid() and direction = 'admin')
);

grant select on public.admin_message_campaigns to authenticated;
grant select on public.admin_player_messages to authenticated;
grant update (read_at) on public.admin_player_messages to authenticated;

create or replace function public.admin_send_player_message(
  target_profile_id uuid,
  message_text text,
  message_subject text default '',
  p_client_message_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_text text := trim(coalesce(message_text, ''));
  clean_subject text := left(trim(coalesce(message_subject, '')), 160);
  clean_client_id text := nullif(left(trim(coalesce(p_client_message_id, '')), 120), '');
  created_id uuid;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if char_length(clean_text) not between 1 and 2000 then
    raise exception 'Сообщение должно содержать от 1 до 2000 символов.';
  end if;
  if not exists (select 1 from public.profiles where id = target_profile_id) then
    raise exception 'Игрок не найден.';
  end if;

  if clean_client_id is not null then
    select id into created_id
    from public.admin_player_messages
    where admin_user_id = auth.uid()
      and client_message_id = clean_client_id
      and direction = 'admin';
    if created_id is not null then return created_id; end if;
  end if;

  insert into public.admin_player_messages (
    admin_user_id, player_user_id, direction, subject, text, client_message_id
  ) values (
    auth.uid(), target_profile_id, 'admin', clean_subject, clean_text, clean_client_id
  ) returning id into created_id;

  insert into public.admin_audit (actor_user_id, action, details)
  values (auth.uid(), 'send-player-message', jsonb_build_object('targetUserId', target_profile_id, 'messageId', created_id));
  return created_id;
exception when unique_violation then
  select id into created_id
  from public.admin_player_messages
  where admin_user_id = auth.uid() and client_message_id = clean_client_id and direction = 'admin';
  return created_id;
end;
$$;

revoke all on function public.admin_send_player_message(uuid, text, text, text) from public;
grant execute on function public.admin_send_player_message(uuid, text, text, text) to authenticated;

create or replace function public.admin_send_broadcast(
  message_text text,
  message_subject text default '',
  p_min_rating integer default null,
  p_max_rating integer default null,
  p_client_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_text text := trim(coalesce(message_text, ''));
  clean_subject text := left(trim(coalesce(message_subject, '')), 160);
  clean_client_id text := nullif(left(trim(coalesce(p_client_message_id, '')), 120), '');
  campaign_id uuid;
  delivered integer := 0;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if char_length(clean_text) not between 1 and 2000 then
    raise exception 'Сообщение должно содержать от 1 до 2000 символов.';
  end if;
  if p_min_rating is not null and p_max_rating is not null and p_min_rating > p_max_rating then
    raise exception 'Минимальный рейтинг не может превышать максимальный.';
  end if;

  if clean_client_id is not null then
    select id, recipient_count into campaign_id, delivered
    from public.admin_message_campaigns
    where admin_user_id = auth.uid() and client_message_id = clean_client_id;
    if campaign_id is not null then
      return jsonb_build_object('campaignId', campaign_id, 'recipientCount', delivered, 'duplicate', true);
    end if;
  end if;

  insert into public.admin_message_campaigns (
    admin_user_id, subject, message, min_rating, max_rating, client_message_id
  ) values (
    auth.uid(), clean_subject, clean_text, p_min_rating, p_max_rating, clean_client_id
  ) returning id into campaign_id;

  insert into public.admin_player_messages (
    admin_user_id, player_user_id, campaign_id, direction, subject, text
  )
  select auth.uid(), p.id, campaign_id, 'admin', clean_subject, clean_text
  from public.profiles p
  where p.id <> auth.uid()
    and p.banned_at is null
    and p.rating_eligible is true
    and (p_min_rating is null or p.rating >= p_min_rating)
    and (p_max_rating is null or p.rating <= p_max_rating)
    and lower(p.email) <> all(public.admin_email_whitelist());

  get diagnostics delivered = row_count;
  update public.admin_message_campaigns set recipient_count = delivered where id = campaign_id;
  insert into public.admin_audit (actor_user_id, action, details)
  values (auth.uid(), 'send-player-broadcast', jsonb_build_object(
    'campaignId', campaign_id, 'recipientCount', delivered,
    'minRating', p_min_rating, 'maxRating', p_max_rating
  ));
  return jsonb_build_object('campaignId', campaign_id, 'recipientCount', delivered, 'duplicate', false);
exception when unique_violation then
  select id, recipient_count into campaign_id, delivered
  from public.admin_message_campaigns
  where admin_user_id = auth.uid() and client_message_id = clean_client_id;
  return jsonb_build_object('campaignId', campaign_id, 'recipientCount', delivered, 'duplicate', true);
end;
$$;

revoke all on function public.admin_send_broadcast(text, text, integer, integer, text) from public;
grant execute on function public.admin_send_broadcast(text, text, integer, integer, text) to authenticated;

create or replace function public.player_reply_to_admin(
  target_admin_id uuid,
  message_text text,
  p_client_message_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_text text := trim(coalesce(message_text, ''));
  clean_client_id text := nullif(left(trim(coalesce(p_client_message_id, '')), 120), '');
  created_id uuid;
begin
  if auth.uid() is null then raise exception 'Auth session missing'; end if;
  if char_length(clean_text) not between 1 and 2000 then
    raise exception 'Сообщение должно содержать от 1 до 2000 символов.';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = target_admin_id and lower(p.email) = any(public.admin_email_whitelist())
  ) or not exists (
    select 1 from public.admin_player_messages m
    where m.admin_user_id = target_admin_id and m.player_user_id = auth.uid()
  ) then
    raise exception 'Диалог с администратором не найден.';
  end if;

  if clean_client_id is not null then
    select id into created_id from public.admin_player_messages
    where player_user_id = auth.uid() and client_message_id = clean_client_id and direction = 'player';
    if created_id is not null then return created_id; end if;
  end if;

  insert into public.admin_player_messages (
    admin_user_id, player_user_id, direction, text, client_message_id
  ) values (
    target_admin_id, auth.uid(), 'player', clean_text, clean_client_id
  ) returning id into created_id;
  return created_id;
exception when unique_violation then
  select id into created_id from public.admin_player_messages
  where player_user_id = auth.uid() and client_message_id = clean_client_id and direction = 'player';
  return created_id;
end;
$$;

revoke all on function public.player_reply_to_admin(uuid, text, text) from public;
grant execute on function public.player_reply_to_admin(uuid, text, text) to authenticated;

drop policy if exists "admins can read bot training games" on public.bot_training_games;
create policy "admins can read bot training games"
on public.bot_training_games for select
to authenticated
using (public.is_admin_user());

grant select on public.bot_training_games to authenticated;

drop policy if exists "admins can read room game archives" on public.room_game_archives;
create policy "admins can read room game archives"
on public.room_game_archives for select
to authenticated
using (public.is_admin_user());

grant select on public.room_game_archives to authenticated;

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

delete from public.guest_presence
where id like 'guest:%'
  and id !~ '^guest:sha256:[0-9a-f]{64}$'
  and id not like 'guest:local:%';

drop policy if exists "clients can create guest presence" on public.guest_presence;
create policy "clients can create guest presence"
on public.guest_presence for insert
to anon, authenticated
with check (
  length(name) between 3 and 32
  and (
    id = public.request_guest_identity()
    or (auth.uid() is not null and id like 'guest:local:%')
  )
);

drop policy if exists "clients can update guest presence" on public.guest_presence;
create policy "clients can update guest presence"
on public.guest_presence for update
to anon, authenticated
using (
  id = public.request_guest_identity()
  or (auth.uid() is not null and id like 'guest:local:%')
)
with check (
  length(name) between 3 and 32
  and (
    id = public.request_guest_identity()
    or (auth.uid() is not null and id like 'guest:local:%')
  )
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

drop policy if exists "recipients can mark friend messages read" on public.friend_messages;
create policy "recipients can mark friend messages read"
on public.friend_messages for update
to authenticated
using (to_user_id = auth.uid())
with check (to_user_id = auth.uid());

grant update (read_at) on public.friend_messages to authenticated;

drop policy if exists "authenticated users can see non-closed rooms" on public.rooms;
create policy "authenticated users can see non-closed rooms"
on public.rooms for select
to authenticated
using (status <> 'closed');

drop policy if exists "admins can see all rooms" on public.rooms;
create policy "admins can see all rooms"
on public.rooms for select
to authenticated
using (public.is_admin_user());

drop policy if exists "anonymous users can see non-closed rooms" on public.rooms;
create policy "anonymous users can see non-closed rooms"
on public.rooms for select
to anon
using (status <> 'closed');

drop policy if exists "authenticated users can create rooms" on public.rooms;
create policy "authenticated users can create rooms"
on public.rooms for insert
to authenticated
with check (
  host_user_id = auth.uid()
  and host_guest_id is null
  and guest_user_id is null
  and guest_guest_id is null
  and status in ('waiting', 'joined')
);

drop policy if exists "anonymous guests can create rooms" on public.rooms;
create policy "anonymous guests can create rooms"
on public.rooms for insert
to anon
with check (
  host_user_id is null
  and host_guest_id is not null
  and host_guest_id = public.request_guest_identity()
  and host_guest_id ~ '^guest:sha256:[0-9a-f]{64}$'
  and guest_user_id is null
  and guest_guest_id is null
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
  and public.request_guest_identity() in (host_guest_id, guest_guest_id)
  and not (
    host_user_id is not null
    and coalesce(game_state->>'mode', game_state->'analysis'->>'mode', '') = 'bot'
  )
)
with check (
  status in ('waiting', 'joined', 'over', 'closed')
  and (host_user_id is null or guest_user_id is null)
  and public.request_guest_identity() in (host_guest_id, guest_guest_id)
  and (host_guest_id is null or host_guest_id ~ '^guest:sha256:[0-9a-f]{64}$')
  and (guest_guest_id is null or guest_guest_id ~ '^guest:sha256:[0-9a-f]{64}$')
  and not (host_user_id is not null and host_guest_id is not null)
  and not (guest_user_id is not null and guest_guest_id is not null)
  and not (
    host_user_id is not null
    and coalesce(game_state->>'mode', game_state->'analysis'->>'mode', '') = 'bot'
  )
);

drop policy if exists "anonymous guests can join waiting rooms" on public.rooms;
create policy "anonymous guests can join waiting rooms"
on public.rooms for update
to anon
using (
  status = 'waiting'
  and guest_user_id is null
  and guest_guest_id is null
  and public.request_guest_identity() is not null
  and public.request_guest_identity() is distinct from host_guest_id
  and not (
    host_user_id is not null
    and coalesce(game_state->>'mode', game_state->'analysis'->>'mode', '') = 'bot'
  )
)
with check (
  status = 'joined'
  and guest_user_id is null
  and guest_guest_id = public.request_guest_identity()
  and not (host_user_id is not null and host_guest_id is not null)
);

drop policy if exists "authenticated users can join waiting rooms" on public.rooms;
create policy "authenticated users can join waiting rooms"
on public.rooms for update
to authenticated
using (
  status = 'waiting'
  and guest_user_id is null
  and guest_guest_id is null
  and (host_user_id is null or host_user_id <> auth.uid())
)
with check (
  status = 'joined'
  and guest_user_id = auth.uid()
  and guest_guest_id is null
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
  deleted_games integer := 0;
begin
  if not public.is_admin_user() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  delete from public.room_game_archives a
  where a.completed_at < cutoff_at;

  get diagnostics deleted_games = row_count;

  delete from public.rooms r
  where coalesce(r.archived_at, r.updated_at, r.created_at) < cutoff_at
    and (
      r.status in ('closed', 'over')
      or coalesce(r.game_state->>'phase', '') = 'over'
      or coalesce(r.game_state->>'winner', '') <> ''
      or coalesce(r.game_state->>'finishedAt', '') <> ''
    );

  get diagnostics deleted_count = row_count;
  deleted_count := deleted_count + deleted_games;

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

drop function if exists public.archive_bot_training_game(text);

create or replace function public.archive_bot_training_game(
  p_room_code text,
  p_final_state jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  clean_code text := upper(trim(coalesce(p_room_code, '')));
  target_room public.rooms%rowtype;
  target_state jsonb;
  memory jsonb;
  decisions jsonb;
  outcome jsonb;
  coverage jsonb;
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
  target_state := coalesce(target_room.game_state, '{}'::jsonb);

  if not coalesce(public.is_admin_user(), false) then
    if target_room.host_user_id is not null then
      if auth.uid() is null or target_room.host_user_id is distinct from auth.uid() then
        raise exception 'Only the room player can archive this game.';
      end if;
    elsif coalesce(target_state->>'winner', '') not in ('white', 'dark')
      or (
        case
        when jsonb_typeof(coalesce(target_state->'analysis'->'botMemory'->'decisions', '[]'::jsonb)) = 'array'
          then jsonb_array_length(coalesce(target_state->'analysis'->'botMemory'->'decisions', '[]'::jsonb))
        else 0
        end
      ) = 0
      or (
        p_final_state is not null
        and (
          coalesce(p_final_state->>'winner', '') <> coalesce(target_state->>'winner', '')
          or coalesce(p_final_state->>'startedAt', '') <> coalesce(target_state->>'startedAt', '')
          or coalesce(p_final_state->'points', '{}'::jsonb) <> coalesce(target_state->'points', '{}'::jsonb)
          or coalesce(p_final_state->'off', '{}'::jsonb) <> coalesce(target_state->'off', '{}'::jsonb)
          or coalesce(p_final_state->'history', '[]'::jsonb) <> coalesce(target_state->'history', '[]'::jsonb)
          or coalesce(p_final_state->'analysis'->'botMemory'->'decisions', '[]'::jsonb)
            <> coalesce(target_state->'analysis'->'botMemory'->'decisions', '[]'::jsonb)
        )
      ) then
      raise exception 'Guest bot game must match the finished room snapshot.';
    end if;
  end if;

  if p_final_state is not null then
    if coalesce(target_state->>'mode', target_state->'analysis'->>'mode', '') not in ('', 'bot')
      and coalesce(target_state->>'opponent', target_state->'analysis'->>'opponent', '') <> 'bot' then
      raise exception 'This room is not a bot analysis room.';
    end if;
    if coalesce(p_final_state->>'roomCode', clean_code) <> clean_code then
      raise exception 'Final state room code mismatch.';
    end if;
    if coalesce(p_final_state->>'winner', '') not in ('white', 'dark') then
      raise exception 'The final state is not finished.';
    end if;

    -- Archive the immutable final payload without writing it back to the live
    -- room. A player may already have started the next game in this room.
    target_state := p_final_state;
  end if;

  if coalesce(target_state->>'mode', '') <> 'bot'
    or coalesce(target_state->>'variant', target_room.variant) not in ('long', 'short')
    or coalesce(target_state->>'botDifficulty', '') <> 'hard' then
    raise exception 'This room is not a hard bot game.';
  end if;
  if coalesce(target_state->>'winner', '') not in ('white', 'dark') then
    raise exception 'The game is not finished.';
  end if;

  memory := coalesce(target_state->'analysis'->'botMemory', '{}'::jsonb);
  decisions := coalesce(memory->'decisions', '[]'::jsonb);
  if jsonb_typeof(decisions) <> 'array' then
    decisions := '[]'::jsonb;
  end if;
  coverage := coalesce(memory->'coverage', '{}'::jsonb);
  if coalesce(target_state->>'variant', target_room.variant) = 'long'
    and coalesce(memory->>'engineVersion', '') in (
      'long-analytic-v29',
      'long-analytic-v30',
      'long-analytic-v31',
      'long-analytic-v32',
      'long-analytic-v33',
      'long-analytic-v34'
    ) then
    if jsonb_typeof(coverage) <> 'object'
      or coalesce(coverage->'complete', 'false'::jsonb) <> 'true'::jsonb
      or jsonb_typeof(coverage->'expectedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recordedBotDecisions') <> 'number'
      or jsonb_typeof(coverage->'recoveredBotDecisions') <> 'number'
      or coalesce(coverage->>'expectedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recordedBotDecisions', '') !~ '^[0-9]+$'
      or coalesce(coverage->>'recoveredBotDecisions', '') !~ '^[0-9]+$' then
      raise exception 'Long bot v29+ training payload has incomplete decision coverage.';
    end if;
    if (coverage->>'expectedBotDecisions')::numeric <= 0
      or (coverage->>'expectedBotDecisions')::numeric <>
        (coverage->>'recordedBotDecisions')::numeric
          + (coverage->>'recoveredBotDecisions')::numeric then
      raise exception 'Long bot v29+ training payload has inconsistent decision coverage.';
    end if;
  end if;
  outcome := coalesce(memory->'outcome', '{}'::jsonb);
  resolved_bot_color := coalesce(
    nullif(outcome->>'botColor', ''),
    case
      when coalesce(target_state->'analysis'->>'playerColor', 'white') = 'white'
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
    coalesce(target_room.guest_name, target_state->'analysis'->>'botName', 'Hard bot'),
    coalesce(memory->>'engineVersion', ''),
    coalesce(target_state->>'botDifficulty', 'hard'),
    resolved_bot_color,
    target_state->>'winner',
    coalesce(nullif(target_state->>'resultType', ''), 'normal'),
    jsonb_array_length(decisions),
    decisions,
    target_state,
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

revoke all on function public.archive_bot_training_game(text, jsonb) from public;
grant execute on function public.archive_bot_training_game(text, jsonb) to anon, authenticated;

create or replace function public.long_bot_safe_numeric(p_value jsonb)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  with parsed as (
    select case
      when jsonb_typeof(p_value) = 'number' then (p_value #>> '{}')::numeric
      else null
    end as value
  )
  select case
    when abs(value) <= 1000000000000 then value
    else null
  end
  from parsed
$$;

revoke all on function public.long_bot_safe_numeric(jsonb)
  from public, anon, authenticated, service_role;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table if not exists private.long_bot_experience_cache_keys (
  player_key text primary key,
  dirty boolean not null default true,
  discovered_at timestamptz not null default now()
);

create table if not exists private.long_bot_experience_cache (
  player_key text primary key references private.long_bot_experience_cache_keys(player_key)
    on delete cascade,
  patterns jsonb not null,
  refreshed_at timestamptz not null default now(),
  constraint long_bot_experience_cache_patterns_array
    check (jsonb_typeof(patterns) = 'array')
);

create table if not exists private.long_bot_experience_changes (
  change_id bigint generated always as identity primary key,
  old_player_key text,
  new_player_key text,
  changed_at timestamptz not null default now()
);

alter table private.long_bot_experience_cache_keys enable row level security;
alter table private.long_bot_experience_cache enable row level security;
alter table private.long_bot_experience_changes enable row level security;
revoke all on private.long_bot_experience_cache_keys from public, anon, authenticated, service_role;
revoke all on private.long_bot_experience_cache from public, anon, authenticated, service_role;
revoke all on private.long_bot_experience_changes from public, anon, authenticated, service_role;

drop function if exists private.compute_long_bot_experience_patterns(text);

create or replace function private.compute_long_bot_experience_patterns(
  p_player_name text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '2min'
as $$
  with valid_games as (
    select g.*
    from public.bot_training_games g
    cross join lateral (
      select
        (count(*) filter (
          where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
        ))::numeric as covered_bot_decisions,
        count(*) filter (
          where not (
            (
              coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
              and (
                (
                  decision->>'source' = 'engine'
                  and decision->>'engineVersion' = g.engine_version
                  and coalesce(decision->'experienceFrozen', 'false'::jsonb) = 'true'::jsonb
                  and coalesce(decision->>'experienceFingerprint', '') <> ''
                )
                or (
                  decision->>'source' = 'history-recovery'
                  and coalesce(public.long_bot_safe_numeric(decision->'captureVersion'), 0) >= 2
                  and decision->>'engineVersion' = g.engine_version
                )
              )
            )
            or (
              decision->>'actor' = 'opponent'
              and coalesce(public.long_bot_safe_numeric(decision->'captureVersion'), 0) >= 2
              and decision->>'engineVersion' = g.engine_version
            )
          )
        ) as incompatible_decisions,
        count(distinct decision->>'experienceFingerprint') filter (
          where coalesce(nullif(decision->>'actor', ''), 'bot') = 'bot'
            and decision->>'source' = 'engine'
        ) as engine_fingerprints
      from jsonb_array_elements(case
        when jsonb_typeof(g.decisions) = 'array' then g.decisions
        else '[]'::jsonb
      end) scanned(decision)
    ) integrity
    where g.difficulty = 'hard'
      and g.engine_version in ('long-analytic-v29', 'long-analytic-v30', 'long-analytic-v31', 'long-analytic-v32', 'long-analytic-v33', 'long-analytic-v34')
      and g.completed_at >= now() - interval '180 days'
      and jsonb_typeof(g.decisions) = 'array'
      and coalesce(g.final_state->>'variant', '') = 'long'
      and g.final_state->'analysis'->'botMemory'->>'engineVersion' = g.engine_version
      and coalesce(
        g.final_state->'analysis'->'botMemory'->'coverage'->'complete',
        'false'::jsonb
      ) = 'true'::jsonb
      and public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'expectedBotDecisions'
      ) > 0
      and public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'expectedBotDecisions'
      ) = coalesce(public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'recordedBotDecisions'
      ), -1) + coalesce(public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'recoveredBotDecisions'
      ), -1)
      and public.long_bot_safe_numeric(
        g.final_state->'analysis'->'botMemory'->'coverage'->'expectedBotDecisions'
      ) = integrity.covered_bot_decisions
      and integrity.incompatible_decisions = 0
      and integrity.engine_fingerprints <= 1
  ), raw_decisions as (
    select
      g.winner,
      g.bot_color,
      g.result_type,
      g.player_name,
      g.completed_at,
      coalesce(
        nullif(substring(g.engine_version from 'v([0-9]{1,4})$'), '')::integer,
        0
      ) as engine_generation,
      coalesce(public.long_bot_safe_numeric(decision->'captureVersion'), 0) as capture_version,
      coalesce(nullif(decision->>'actor', ''), 'bot') as actor,
      public.long_bot_safe_numeric(decision->'choiceCount') as choice_count,
      greatest(0.75, least(4, coalesce(public.long_bot_safe_numeric(decision->'winQuality'), 1))) as win_quality,
      coalesce(decision->'experience', decision->'selected'->'experience') as descriptor,
      coalesce(decision->'selected'->'features', '{}'::jsonb) as features,
      coalesce(decision->'selected'->'tactical', '{}'::jsonb) as tactical,
      coalesce(trim(p_player_name), '') <> ''
        and lower(g.player_name) = lower(trim(p_player_name)) as personalized
    from valid_games g
    cross join lateral jsonb_array_elements(coalesce(g.decisions, '[]'::jsonb)) decision
  ), signals as (
    select
      *,
      coalesce(descriptor->>'phase', split_part(descriptor->>'contextKey', '|', 1), 'route') as phase,
      greatest(
        coalesce(public.long_bot_safe_numeric(descriptor->'riskSignal'), 0),
        coalesce(public.long_bot_safe_numeric(descriptor->'mistakeSeverity'), 0),
        least(6, abs(least(0, coalesce(public.long_bot_safe_numeric(tactical->'worstImpact'), 0))) / 12000000),
        case
          when coalesce(public.long_bot_safe_numeric(features->'trapBefore'), 0) >= 600
            and coalesce(public.long_bot_safe_numeric(features->'trapDelta'), 0) <= 0
            then least(4, coalesce(public.long_bot_safe_numeric(features->'trapBefore'), 0) / 900)
          else 0
        end,
        greatest(0, -coalesce(public.long_bot_safe_numeric(features->'routeTowerDelta'), 0) / 90),
        least(6, greatest(0, -coalesce(
          public.long_bot_safe_numeric(features->'latentFenceExposureDelta'),
          coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureBefore'), 0)
            - coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureAfter'), 0),
          0
        ))),
        least(6, greatest(
          0,
          coalesce(public.long_bot_safe_numeric(features->'avoidableProspectiveFenceInterruptionBreak'), 0) / 18
        )),
        least(6, greatest(
          0,
          coalesce(public.long_bot_safe_numeric(features->'avoidableProspectiveFenceAnchorMiss'), 0) / 18
        )),
        case
          when coalesce(public.long_bot_safe_numeric(features->'maxRouteTowerAfter'), 0) >= 6
            then (coalesce(public.long_bot_safe_numeric(features->'maxRouteTowerAfter'), 0) - 5) * 0.85
          else 0
        end,
        case
          when features ? 'avoidableHomeShuffleMoves'
            and coalesce(public.long_bot_safe_numeric(features->'avoidableHomeShuffleMoves'), 0) > 0
            and coalesce(descriptor->>'phase', '') <> 'bearoff'
            then 1.5
          else 0
        end
      ) as harm_signal,
      case
        when coalesce(trim(p_player_name), '') <> ''
          and lower(player_name) = lower(trim(p_player_name))
          then 3
        else 1
      end as player_weight,
      case
        when actor = 'opponent' and capture_version >= 2 then 4.0
        when actor = 'opponent' then 0.0
        when engine_generation = 34 then 8.0
        when engine_generation = 33 then 7.0
        when engine_generation = 32 then 6.0
        when engine_generation = 31 then 5.0
        when engine_generation = 30 then 4.0
        when engine_generation = 29 then 3.0
        else 0.0
      end as engine_weight
    from raw_decisions
    where coalesce(descriptor->>'contextKey', '') <> ''
      and coalesce(descriptor->>'actionKey', '') <> ''
  -- v8 changes how compatible aggregate aliases are arbitrated by the client.
  -- These labels remain outcome-weighted evidence, not causal per-move attribution.
  ), labeled as (
    select
      *,
      actor = 'bot' and engine_generation in (29, 30, 31, 32, 33, 34) and choice_count > 1
        and winner <> bot_color and harm_signal >= 1.1 as harmful,
      (actor = 'bot' and engine_generation in (29, 30, 31, 32, 33, 34) and choice_count > 1
        and winner = bot_color and harm_signal < 1.1)
        or (
          actor = 'opponent'
          and capture_version >= 2
          and choice_count > 1
          and winner <> bot_color
          and harm_signal < 1.1
        ) as successful
    from signals
  ), expanded as (
    select
      descriptor->>'contextKey' as context_key,
      action.action_key,
      result_type,
      harm_signal,
      harmful,
      successful,
      win_quality,
      player_weight,
      engine_weight,
      personalized,
      completed_at
    from labeled
    cross join lateral (
      select distinct candidate as action_key
      from (values
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then descriptor->>'actionKey' end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then nullif(descriptor->>'strategicActionKey', '') end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then coalesce(
          nullif(descriptor->>'familyActionKey', ''),
          regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
        ) end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then coalesce(
          nullif(descriptor->>'legacyActionKey', ''),
          regexp_replace(
            coalesce(
              nullif(descriptor->>'familyActionKey', ''),
              regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
            ),
            '\|tower:[^|]*$',
            ''
          )
        ) end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then nullif(descriptor->'behaviorActionKeys'->>0, '') end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then nullif(descriptor->'behaviorActionKeys'->>1, '') end),
        (case when engine_generation in (29, 30, 31, 32, 33, 34) then nullif(descriptor->'behaviorActionKeys'->>2, '') end),
        (case when engine_generation = 34 then nullif(descriptor->'behaviorActionKeys'->>3, '') end),
        (concat(
          'entry:', case
            when coalesce(public.long_bot_safe_numeric(features->'outsideReduction'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'outsideReduction'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|progress:', case
            when coalesce(public.long_bot_safe_numeric(features->'outsidePipGain'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'outsidePipGain'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|home:', case
            when features ? 'avoidableHomeShuffleMoves'
              and coalesce(public.long_bot_safe_numeric(features->'avoidableHomeShuffleMoves'), 0) > 0
              then 'shuffle'
            when features ? 'avoidableHomeShuffleMoves'
              and coalesce(public.long_bot_safe_numeric(features->'homeShuffleMoves'), 0) > 0
              then 'forced'
            when not (features ? 'avoidableHomeShuffleMoves')
              and coalesce(public.long_bot_safe_numeric(features->'homeShuffleMoves'), 0) > 0
              then 'unknown'
            else 'steady'
          end,
          '|tower:', case
            when coalesce(public.long_bot_safe_numeric(features->'routeTowerDelta'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'routeTowerDelta'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|off:', case
            when coalesce(public.long_bot_safe_numeric(features->'bearOffMoves'), 0) > 0 then 'yes'
            else 'no'
          end
        )),
        (concat(
          'trap:', case
            when coalesce(public.long_bot_safe_numeric(features->'trapDelta'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'trapDelta'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|fence:', case
            when coalesce(public.long_bot_safe_numeric(features->'fenceClosureDelta'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'fenceClosureDelta'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|gateway:', case
            when coalesce(public.long_bot_safe_numeric(features->'escapeGatewayDelta'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'escapeGatewayDelta'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|block:', case
            when coalesce(public.long_bot_safe_numeric(features->'opponentMoveBlockGain'), 0) > 0 then 'gain'
            when coalesce(public.long_bot_safe_numeric(features->'opponentMoveBlockGain'), 0) < 0 then 'loss'
            else 'flat'
          end,
          '|latent:', case
            when coalesce(
              public.long_bot_safe_numeric(features->'latentFenceExposureDelta'),
              coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureBefore'), 0)
                - coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureAfter'), 0),
              0
            ) > 0 then 'gain'
            when coalesce(
              public.long_bot_safe_numeric(features->'latentFenceExposureDelta'),
              coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureBefore'), 0)
                - coalesce(public.long_bot_safe_numeric(features->'latentFenceExposureAfter'), 0),
              0
            ) < 0 then 'loss'
            else 'flat'
          end
        ))
      ) choices(candidate)
      where coalesce(candidate, '') <> ''
    ) action
    where (harmful or successful) and engine_weight > 0
  ), grouped as (
    select
      context_key,
      action_key,
      count(*)::integer as samples,
      count(*) filter (where harmful)::integer as losses,
      count(*) filter (where successful)::integer as wins,
      sum(case
        when harmful then
          player_weight * engine_weight * (
            least(3.75, 0.85 + harm_signal * 0.38)
            + case
              when result_type = 'koks' then 1.5
              when result_type = 'mars' then 0.75
              else 0
            end
          )
        else 0
      end)::double precision as loss_weight,
      count(*) filter (
        where harmful and (result_type in ('mars', 'koks') or harm_signal >= 3.2)
      )::integer as severe_losses,
      sum(case when harmful then harm_signal else 0 end)::double precision as signal_weight,
      sum(case when successful then win_quality * player_weight * engine_weight else 0 end)::double precision as win_weight,
      bool_or(personalized) as personalized,
      max(completed_at) as updated_at
    from expanded
    group by context_key, action_key
  ), eligible as (
    select
      *,
      split_part(context_key, '|', 1) as phase,
      case
        when losses > 0 and (wins = 0 or loss_weight >= win_weight) then 'harmful'
        else 'successful'
      end as cohort
    from grouped
    where losses > 0 or wins > 0
  ), cohort_ranked as (
    select
      *,
      row_number() over (
        partition by phase, cohort
        order by
          personalized desc,
          case when cohort = 'harmful' then severe_losses else 0 end desc,
          case when cohort = 'harmful' then loss_weight else win_weight end desc,
          case when cohort = 'harmful' then losses else wins end desc,
          samples desc
      ) as cohort_rank
    from eligible
  ), ranked as (
    select *
    from cohort_ranked
    where cohort_rank <= 64
    order by
      personalized desc,
      greatest(loss_weight, win_weight) desc,
      severe_losses desc,
      samples desc
    limit 640
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'creditVersion', 8,
      'contextKey', context_key,
      'actionKey', action_key,
      'samples', samples,
      'losses', losses,
      'wins', wins,
      'lossWeight', loss_weight,
      'severeLosses', severe_losses,
      'signalWeight', signal_weight,
      'winWeight', win_weight,
      'updatedAt', updated_at
    ) order by
      personalized desc,
      greatest(loss_weight, win_weight) desc,
      severe_losses desc,
      samples desc
    ),
    '[]'::jsonb
  )
  from ranked
$$;

revoke all on function private.compute_long_bot_experience_patterns(text)
  from public, anon, authenticated, service_role;

create or replace function private.note_long_bot_experience_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_relevant boolean := false;
  new_relevant boolean := false;
  old_key text;
  new_key text;
begin
  if tg_op <> 'INSERT' then
    old_relevant := old.difficulty = 'hard'
      and old.engine_version in (
        'long-analytic-v29',
        'long-analytic-v30',
        'long-analytic-v31',
        'long-analytic-v32',
        'long-analytic-v33',
        'long-analytic-v34'
      );
    if old_relevant then
      old_key := pg_catalog.lower(pg_catalog.btrim(old.player_name));
    end if;
  end if;

  if tg_op <> 'DELETE' then
    new_relevant := new.difficulty = 'hard'
      and new.engine_version in (
        'long-analytic-v29',
        'long-analytic-v30',
        'long-analytic-v31',
        'long-analytic-v32',
        'long-analytic-v33',
        'long-analytic-v34'
      );
    if new_relevant then
      new_key := pg_catalog.lower(pg_catalog.btrim(new.player_name));
    end if;
  end if;

  if old_relevant or new_relevant then
    -- The committed ledger row is the immediate invalidation signal. Keeping
    -- the trigger append-only avoids blocking game finalization behind a
    -- background worker that may currently hold cache-key row locks.
    insert into private.long_bot_experience_changes(old_player_key, new_player_key)
    values (old_key, new_key);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.note_long_bot_experience_change()
  from public, anon, authenticated, service_role;

create or replace function private.refresh_long_bot_experience_cache(
  p_batch_size integer default 2
)
returns integer
language plpgsql
security definer
set search_path = ''
set statement_timeout = '2min'
as $$
declare
  effective_batch_size integer := greatest(
    1,
    least(coalesce(p_batch_size, 2), 8)
  );
  target_player_key text;
  computed_patterns jsonb;
  refreshed_count integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(20151, 3308) then
    return 0;
  end if;

  -- Consume exactly the ledger rows visible to this statement. A concurrent
  -- commit stays in the ledger for the next run, so no invalidation is lost.
  with consumed_changes as (
    delete from private.long_bot_experience_changes
    returning old_player_key, new_player_key
  ), keys_to_dirty(player_key) as (
    -- Personalized aggregates include shared evidence, therefore every real
    -- game change invalidates every existing personalized key.
    select ''::text
    where exists (select 1 from consumed_changes)
    union
    select cache_key.player_key
    from private.long_bot_experience_cache_keys cache_key
    where exists (select 1 from consumed_changes)
    union
    select old_player_key
    from consumed_changes
    where old_player_key is not null
    union
    select new_player_key
    from consumed_changes
    where new_player_key is not null
  )
  insert into private.long_bot_experience_cache_keys(player_key, dirty)
  select player_key, true
  from keys_to_dirty
  on conflict (player_key) do update
    set dirty = true;

  for target_player_key in
    select cache_key.player_key
    from private.long_bot_experience_cache_keys cache_key
    left join private.long_bot_experience_cache cached
      on cached.player_key = cache_key.player_key
    where cache_key.dirty
       or cached.player_key is null
       or cached.refreshed_at < pg_catalog.clock_timestamp() - interval '1 hour'
    -- Keep the global fallback responsive to every invalidation, but reserve
    -- the second slot for maintenance once a cache is more than two hours old.
    -- Without that hard-age lane, a steady stream of global/player dirty pairs
    -- can starve an inactive personalized cache forever.
    order by
      (
        cache_key.player_key = ''
        and (cache_key.dirty or cached.player_key is null)
      ) desc,
      coalesce((
        cached.refreshed_at < pg_catalog.clock_timestamp() - interval '2 hours'
      ), false) desc,
      (cached.player_key is null) desc,
      cache_key.dirty desc,
      (cache_key.player_key = '') desc,
      cached.refreshed_at asc nulls first,
      cache_key.player_key
    limit effective_batch_size
  loop
    computed_patterns := private.compute_long_bot_experience_patterns(
      nullif(target_player_key, '')
    );
    if pg_catalog.jsonb_typeof(computed_patterns) is distinct from 'array' then
      raise exception 'Long-bot experience builder returned a non-array payload.';
    end if;

    insert into private.long_bot_experience_cache(player_key, patterns, refreshed_at)
    values (target_player_key, computed_patterns, pg_catalog.clock_timestamp())
    on conflict (player_key) do update
      set patterns = excluded.patterns,
          refreshed_at = excluded.refreshed_at;

    update private.long_bot_experience_cache_keys
    set dirty = false
    where player_key = target_player_key;

    refreshed_count := refreshed_count + 1;
  end loop;

  return refreshed_count;
end;
$$;

revoke all on function private.refresh_long_bot_experience_cache(integer)
  from public, anon, authenticated, service_role;

insert into private.long_bot_experience_cache_keys(player_key)
values ('')
on conflict (player_key) do nothing;

insert into private.long_bot_experience_cache_keys(player_key)
select distinct pg_catalog.lower(g.player_name)
from public.bot_training_games g
where g.difficulty = 'hard'
  and g.engine_version in (
    'long-analytic-v29',
    'long-analytic-v30',
    'long-analytic-v31',
    'long-analytic-v32',
    'long-analytic-v33',
    'long-analytic-v34'
  )
  and g.completed_at >= pg_catalog.now() - interval '180 days'
  and pg_catalog.btrim(g.player_name) <> ''
  and g.player_name = pg_catalog.btrim(g.player_name)
on conflict (player_key) do nothing;

do $bootstrap$
declare
  refreshed_count integer;
begin
  update private.long_bot_experience_cache_keys
  set dirty = true;

  perform pg_catalog.pg_advisory_xact_lock(20151, 3308);
  loop
    refreshed_count := private.refresh_long_bot_experience_cache(8);
    -- Bootstrap is complete once every key invalidated above has a cache row.
    -- Do not wait for the worker's hourly maintenance queue to become empty:
    -- on a large dataset the earliest rows can age back into that queue before
    -- the initial pass finishes, which would keep this migration open forever.
    exit when not exists (
      select 1
      from private.long_bot_experience_cache_keys cache_key
      left join private.long_bot_experience_cache cached
        on cached.player_key = cache_key.player_key
      where cache_key.dirty
         or cached.player_key is null
    );
    if refreshed_count = 0 then
      raise exception 'Long-bot experience cache bootstrap made no progress.';
    end if;
  end loop;

  if not exists (
    select 1
    from private.long_bot_experience_cache
    where player_key = ''
      and pg_catalog.jsonb_typeof(patterns) = 'array'
  ) then
    raise exception 'Long-bot experience cache bootstrap failed.';
  end if;
end;
$bootstrap$;

drop trigger if exists note_long_bot_experience_change
  on public.bot_training_games;
create trigger note_long_bot_experience_change
after insert or update or delete on public.bot_training_games
for each row execute function private.note_long_bot_experience_change();

-- Close the bootstrap race after the trigger has taken its short table lock.
insert into private.long_bot_experience_cache_keys(player_key)
select distinct pg_catalog.lower(g.player_name)
from public.bot_training_games g
where g.difficulty = 'hard'
  and g.engine_version in (
    'long-analytic-v29',
    'long-analytic-v30',
    'long-analytic-v31',
    'long-analytic-v32',
    'long-analytic-v33',
    'long-analytic-v34'
  )
  and g.completed_at >= pg_catalog.now() - interval '180 days'
  and pg_catalog.btrim(g.player_name) <> ''
  and g.player_name = pg_catalog.btrim(g.player_name)
on conflict (player_key) do nothing;

insert into private.long_bot_experience_changes(old_player_key, new_player_key)
values (null, null);

drop function if exists public.get_long_bot_experience_patterns();
drop function if exists public.get_long_bot_experience_patterns(text);

create or replace function public.get_long_bot_experience_patterns(
  p_player_name text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select cached.patterns
      from private.long_bot_experience_cache cached
      join private.long_bot_experience_cache_keys cache_key
        on cache_key.player_key = cached.player_key
      where cached.player_key = pg_catalog.lower(
        pg_catalog.btrim(coalesce(p_player_name, ''))
      )
        and not cache_key.dirty
        and not exists (
          select 1 from private.long_bot_experience_changes pending_change
        )
    ),
    (
      select cached.patterns
      from private.long_bot_experience_cache cached
      join private.long_bot_experience_cache_keys cache_key
        on cache_key.player_key = cached.player_key
      where cached.player_key = ''
        and not cache_key.dirty
        and not exists (
          select 1 from private.long_bot_experience_changes pending_change
        )
    ),
    -- During the short worker window, retain the last coherent snapshot rather
    -- than returning an indistinguishable empty history that a new game would
    -- freeze for its entire session.  Once the worker commits, the clean global
    -- row above supersedes any still-dirty personalized row.
    (
      select cached.patterns
      from private.long_bot_experience_cache cached
      where cached.player_key = pg_catalog.lower(
        pg_catalog.btrim(coalesce(p_player_name, ''))
      )
    ),
    (
      select cached.patterns
      from private.long_bot_experience_cache cached
      where cached.player_key = ''
    ),
    '[]'::jsonb
  )
$$;

revoke all on function public.get_long_bot_experience_patterns(text) from public;
grant execute on function public.get_long_bot_experience_patterns(text) to anon, authenticated;

do $cron_jobs$
declare
  old_job record;
begin
  for old_job in
    select jobid
    from cron.job
    where jobname in (
      'refresh-long-bot-experience-v33',
      'cleanup-long-bot-experience-v33-job-history',
      'refresh-long-bot-experience-v34',
      'cleanup-long-bot-experience-v34-job-history'
    )
  loop
    perform cron.unschedule(old_job.jobid);
    delete from cron.job_run_details
    where jobid = old_job.jobid;
  end loop;

  perform cron.schedule(
    'refresh-long-bot-experience-v34',
    '* * * * *',
    $command$
      set statement_timeout = '2min';
      select private.refresh_long_bot_experience_cache(8);
    $command$
  );
  perform cron.schedule(
    'cleanup-long-bot-experience-v34-job-history',
    '17 3 * * *',
    $command$
      set statement_timeout = '2min';
      select pg_catalog.pg_advisory_xact_lock(20151, 3308);
      delete from private.long_bot_experience_cache_keys cache_key
      where cache_key.player_key <> ''
        and not exists (
          select 1
          from public.bot_training_games game
          where game.difficulty = 'hard'
            and game.engine_version in (
              'long-analytic-v29',
              'long-analytic-v30',
              'long-analytic-v31',
              'long-analytic-v32',
              'long-analytic-v33',
              'long-analytic-v34'
            )
            and game.completed_at >= pg_catalog.now() - interval '180 days'
            and game.player_name = pg_catalog.btrim(game.player_name)
            and pg_catalog.lower(game.player_name) = cache_key.player_key
        );
      delete from cron.job_run_details details
      where details.jobid in (
        select job.jobid
        from cron.job job
        where job.jobname in (
          'refresh-long-bot-experience-v34',
          'cleanup-long-bot-experience-v34-job-history'
        )
      )
        and details.end_time < pg_catalog.now() - interval '7 days';
    $command$
  );
end;
$cron_jobs$;

drop function if exists public.get_short_bot_experience_patterns(text);

create or replace function public.get_short_bot_experience_patterns(
  p_player_name text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with decisions as (
    select
      g.winner,
      g.bot_color,
      g.result_type,
      g.player_name,
      coalesce(nullif(decision->>'actor', ''), 'bot') as actor,
      greatest(0.75, least(4, coalesce(nullif(decision->>'winQuality', '')::numeric, 1))) as win_quality,
      coalesce(decision->'experience', decision->'selected'->'experience') as descriptor,
      case
        when coalesce(trim(p_player_name), '') <> ''
          and lower(g.player_name) = lower(trim(p_player_name)) then 3
        else 1
      end as player_weight
    from public.bot_training_games g
    cross join lateral jsonb_array_elements(coalesce(g.decisions, '[]'::jsonb)) decision
    where g.difficulty = 'hard'
      and (
        g.engine_version like 'short-analytic-v6%'
        or g.engine_version like 'short-analytic-v5%'
      )
      and g.completed_at >= now() - interval '180 days'
  ), labeled as (
    select
      descriptor->>'contextKey' as context_key,
      descriptor->>'actionKey' as action_key,
      player_weight,
      greatest(0, coalesce(nullif(descriptor->>'mistakeSeverity', '')::numeric, 0)) as severity,
      actor = 'bot' and winner <> bot_color as harmful,
      (actor = 'bot' and winner = bot_color)
        or (actor = 'opponent' and winner <> bot_color) as successful,
      result_type,
      win_quality
    from decisions
    where coalesce(descriptor->>'contextKey', '') <> ''
      and coalesce(descriptor->>'actionKey', '') <> ''
  ), eligible as (
    select *
    from labeled
    where (harmful and severity >= 0.45)
      or (successful and severity < 1.1)
  ), grouped as (
    select
      context_key,
      action_key,
      count(*)::integer as samples,
      count(*) filter (where harmful)::integer as losses,
      count(*) filter (where successful)::integer as wins,
      sum(case when harmful then player_weight * (
        0.85 + least(3.75, severity * 0.38)
        + case when result_type = 'koks' then 1.5 when result_type = 'mars' then 0.75 else 0 end
      ) else 0 end)::double precision as loss_weight,
      count(*) filter (where harmful and result_type in ('mars', 'koks'))::integer as severe_losses,
      sum(case when harmful then severity * player_weight else 0 end)::double precision as signal_weight,
      sum(case when successful then win_quality * player_weight else 0 end)::double precision as win_weight
    from eligible
    group by context_key, action_key
    order by samples desc, loss_weight desc
    limit 480
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'creditVersion', 6,
    'contextKey', context_key,
    'actionKey', action_key,
    'samples', samples,
    'losses', losses,
    'wins', wins,
    'lossWeight', loss_weight,
    'severeLosses', severe_losses,
    'signalWeight', signal_weight,
    'winWeight', win_weight
  ) order by samples desc, loss_weight desc), '[]'::jsonb)
  from grouped
$$;

revoke all on function public.get_short_bot_experience_patterns(text) from public;
grant execute on function public.get_short_bot_experience_patterns(text) to anon, authenticated;

drop function if exists public.record_rating_result(text, text, integer, boolean, text, text, text, jsonb, jsonb, timestamptz);

create or replace function public.record_rating_result(
  p_result_key text,
  p_opponent text,
  p_opponent_rating integer,
  p_did_win boolean,
  p_mode text,
  p_result_type text,
  p_winner text,
  p_score jsonb,
  p_history jsonb,
  p_finished_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  player_id uuid := auth.uid();
  clean_key text := left(trim(coalesce(p_result_key, '')), 120);
  current_rating integer;
  next_rating integer;
  rating_delta integer;
  next_tier text;
  expected_score double precision;
  existing_event public.rating_events%rowtype;
  resolved_room_code text := upper(trim(coalesce(p_score->>'roomCode', '')));
  resolved_final_state jsonb := coalesce(p_score->'finalState', '{}'::jsonb);
  normalized_history jsonb := case
    when jsonb_typeof(p_history) = 'array' then p_history
    else '[]'::jsonb
  end;
begin
  if player_id is null then
    raise exception 'Authentication is required.';
  end if;
  if clean_key = '' then
    raise exception 'Result key is required.';
  end if;

  -- Rating and room finalization share the same authenticated transaction. This
  -- repairs a room even when the browser aborted its large final PATCH request.
  if p_mode = 'bot'
     and resolved_room_code <> ''
     and coalesce(resolved_final_state->>'winner', '') in ('white', 'dark') then
    begin
      resolved_final_state := resolved_final_state || jsonb_build_object(
        'history', normalized_history,
        'analysis', coalesce(
          resolved_final_state->'analysis',
          (select r.game_state->'analysis' from public.rooms r
           where r.code = resolved_room_code and r.host_user_id = player_id
           limit 1),
          '{}'::jsonb
        ),
        'phase', 'over',
        'winner', case when p_winner in ('white', 'dark') then p_winner else resolved_final_state->>'winner' end,
        'resultType', case
          when p_result_type in ('mars', 'koks') then p_result_type
          else coalesce(nullif(resolved_final_state->>'resultType', ''), 'normal')
        end,
        'off', coalesce(p_score->'off', resolved_final_state->'off'),
        'finishedAt', coalesce(resolved_final_state->'finishedAt', to_jsonb(coalesce(p_finished_at, now())))
      );
      update public.rooms
      set
        game_state = resolved_final_state,
        game_version = game_version + 1,
        -- Keep closed terminal if lobby cleanup won the race; this fallback may
        -- still persist the authoritative result and archive metadata.
        status = case when status = 'closed' then 'closed' else 'over' end,
        archived_at = coalesce(p_finished_at, now()),
        closed_reason = 'finished'
      where code = resolved_room_code
        and host_user_id = player_id;
    exception when others then
      raise warning 'Could not finalize room % from rating result: %', resolved_room_code, sqlerrm;
    end;
  end if;

  select * into existing_event
  from public.rating_events
  where user_id = player_id and result_key = clean_key;
  if existing_event.id is not null then
    select tier into next_tier from public.profiles where id = player_id;
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'delta', existing_event.delta,
      'rating', existing_event.rating_after,
      'tier', coalesce(next_tier, 'Bronze')
    );
  end if;

  select greatest(1, coalesce(rating, 1000)) into current_rating
  from public.profiles
  where id = player_id
  for update;
  if current_rating is null then
    raise exception 'Player profile was not found.';
  end if;

  expected_score := 1.0 / (1.0 + power(
    10.0,
    (greatest(1, coalesce(p_opponent_rating, 1000)) - current_rating) / 400.0
  ));
  next_rating := round(current_rating + 24 * ((case when p_did_win then 1 else 0 end) - expected_score));
  rating_delta := next_rating - current_rating;
  next_tier := case
    when next_rating >= 2100 then 'Diamond'
    when next_rating >= 1800 then 'Platinum'
    when next_rating >= 1500 then 'Gold'
    when next_rating >= 1200 then 'Silver'
    else 'Bronze'
  end;

  insert into public.rating_events (
    user_id,
    result_key,
    opponent,
    opponent_rating,
    did_win,
    mode,
    result_type,
    winner,
    score,
    history,
    delta,
    rating_after,
    created_at
  ) values (
    player_id,
    clean_key,
    left(coalesce(p_opponent, ''), 32),
    greatest(1, coalesce(p_opponent_rating, 1000)),
    coalesce(p_did_win, false),
    left(coalesce(p_mode, ''), 20),
    case when p_result_type in ('mars', 'koks') then p_result_type else '' end,
    case when p_winner in ('white', 'dark') then p_winner else '' end,
    coalesce(p_score, '{}'::jsonb),
    normalized_history,
    rating_delta,
    next_rating,
    coalesce(p_finished_at, now())
  );

  update public.profiles
  set
    rating = next_rating,
    tier = next_tier,
    rating_eligible = true,
    last_seen_at = now()
  where id = player_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'delta', rating_delta,
    'rating', next_rating,
    'tier', next_tier
  );
end;
$$;

revoke all on function public.record_rating_result(text, text, integer, boolean, text, text, text, jsonb, jsonb, timestamptz) from public;
grant execute on function public.record_rating_result(text, text, integer, boolean, text, text, text, jsonb, jsonb, timestamptz) to authenticated;

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

  begin
    alter publication supabase_realtime add table public.admin_player_messages;
  exception when duplicate_object then null;
  end;
end $$;

notify pgrst, 'reload schema';
