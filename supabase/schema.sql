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

create or replace function public.close_own_lobby_rooms()
returns text[]
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  player_id uuid := auth.uid();
  closed_codes text[] := array[]::text[];
begin
  if player_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

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
  into closed_codes
  from closed;

  return closed_codes;
end;
$$;

revoke all on function public.close_own_lobby_rooms() from public;
grant execute on function public.close_own_lobby_rooms() to authenticated;

create or replace function public.finish_room_game(
  p_room_code text,
  p_final_state jsonb
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
  where code = upper(trim(coalesce(p_room_code, '')))
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
      return jsonb_build_object('ok', true, 'version', target.game_version, 'alreadyFinished', true);
    end if;
    raise exception 'Room already contains a different finished game.' using errcode = '23505';
  end if;

  if target.status = 'closed'
     and coalesce(target.closed_reason, '') not in ('lobby_exit', 'lobby_exit_repair', 'left', 'removed') then
    raise exception 'Room was closed by an administrator.' using errcode = '55000';
  end if;
  if target.status not in ('joined', 'over', 'closed') then
    raise exception 'Room has no active game.' using errcode = '55000';
  end if;

  next_version := target.game_version + 1;
  update public.rooms
  set
    game_state = p_final_state,
    game_version = next_version,
    status = 'over',
    archived_at = now(),
    closed_reason = 'finished'
  where id = target.id;

  return jsonb_build_object('ok', true, 'version', next_version, 'alreadyFinished', false);
end;
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
set search_path = public
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
    or coalesce(target_state->>'variant', target_room.variant) <> 'long'
    or coalesce(target_state->>'botDifficulty', '') <> 'hard' then
    raise exception 'This room is not a hard long-bot game.';
  end if;
  if coalesce(target_state->>'winner', '') not in ('white', 'dark') then
    raise exception 'The game is not finished.';
  end if;

  if p_final_state is not null
    and coalesce(target_room.game_state->>'winner', '') = ''
    and nullif(target_room.game_state->>'startedAt', '') is not null
    and target_room.game_state->>'startedAt' = target_state->>'startedAt' then
    update public.rooms
    set
      game_state = target_state,
      game_version = game_version + 1,
      status = 'over',
      archived_at = now(),
      closed_reason = 'finished'
    where id = target_room.id
    returning * into target_room;
  end if;

  memory := coalesce(target_state->'analysis'->'botMemory', '{}'::jsonb);
  decisions := coalesce(memory->'decisions', '[]'::jsonb);
  if jsonb_typeof(decisions) <> 'array' then
    decisions := '[]'::jsonb;
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

create or replace function public.get_long_bot_experience_patterns()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with raw_decisions as (
    select
      g.winner,
      g.bot_color,
      g.result_type,
      coalesce(decision->'experience', decision->'selected'->'experience') as descriptor,
      coalesce(decision->'selected'->'features', '{}'::jsonb) as features,
      coalesce(decision->'selected'->'tactical', '{}'::jsonb) as tactical
    from public.bot_training_games g
    cross join lateral jsonb_array_elements(coalesce(g.decisions, '[]'::jsonb)) decision
    where g.difficulty = 'hard'
      and g.engine_version like 'long-analytic-%'
      and g.completed_at >= now() - interval '180 days'
  ), signals as (
    select
      *,
      coalesce(descriptor->>'phase', split_part(descriptor->>'contextKey', '|', 1), 'route') as phase,
      greatest(
        coalesce(nullif(descriptor->>'riskSignal', '')::numeric, 0),
        coalesce(nullif(descriptor->>'mistakeSeverity', '')::numeric, 0),
        least(6, abs(least(0, coalesce(nullif(tactical->>'worstImpact', '')::numeric, 0))) / 12000000),
        case
          when coalesce(nullif(features->>'trapBefore', '')::numeric, 0) >= 600
            and coalesce(nullif(features->>'trapDelta', '')::numeric, 0) <= 0
            then least(4, coalesce(nullif(features->>'trapBefore', '')::numeric, 0) / 900)
          else 0
        end,
        greatest(0, -coalesce(nullif(features->>'routeTowerDelta', '')::numeric, 0) / 90),
        case
          when coalesce(nullif(features->>'maxRouteTowerAfter', '')::numeric, 0) >= 6
            then (coalesce(nullif(features->>'maxRouteTowerAfter', '')::numeric, 0) - 5) * 0.85
          else 0
        end,
        case
          when coalesce(nullif(features->>'homeShuffleMoves', '')::numeric, 0) > 0
            and coalesce(nullif(features->>'outsideReduction', '')::numeric, 0) <= 0
            and coalesce(descriptor->>'phase', '') <> 'bearoff'
            then 1.5
          else 0
        end
      ) as harm_signal
    from raw_decisions
    where coalesce(descriptor->>'contextKey', '') <> ''
      and coalesce(descriptor->>'actionKey', '') <> ''
  ), labeled as (
    select
      *,
      winner <> bot_color and harm_signal >= 1.1 as harmful
    from signals
  ), expanded as (
    select
      descriptor->>'contextKey' as context_key,
      action.action_key,
      result_type,
      harm_signal,
      harmful
    from labeled
    cross join lateral (
      select distinct candidate as action_key
      from (values
        (descriptor->>'actionKey'),
        (coalesce(
          nullif(descriptor->>'familyActionKey', ''),
          regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
        )),
        (coalesce(
          nullif(descriptor->>'legacyActionKey', ''),
          regexp_replace(
            coalesce(
              nullif(descriptor->>'familyActionKey', ''),
              regexp_replace(descriptor->>'actionKey', '\|route:[^|]*$', '')
            ),
            '\|tower:[^|]*$',
            ''
          )
        ))
      ) choices(candidate)
      where coalesce(candidate, '') <> ''
    ) action
  ), grouped as (
    select
      context_key,
      action_key,
      count(*)::integer as samples,
      count(*) filter (where harmful)::integer as losses,
      sum(case
        when harmful then least(
          4.5,
          0.85 + harm_signal * 0.38 + case when result_type in ('mars', 'koks') then 0.75 else 0 end
        )
        else 0
      end)::double precision as loss_weight,
      count(*) filter (
        where harmful and (result_type in ('mars', 'koks') or harm_signal >= 3.2)
      )::integer as severe_losses,
      sum(case when harmful then harm_signal else 0 end)::double precision as signal_weight
    from expanded
    group by context_key, action_key
  ), ranked as (
    select *
    from grouped
    order by samples desc, loss_weight desc, signal_weight desc
    limit 480
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'creditVersion', 2,
      'contextKey', context_key,
      'actionKey', action_key,
      'samples', samples,
      'losses', losses,
      'lossWeight', loss_weight,
      'severeLosses', severe_losses,
      'signalWeight', signal_weight
    ) order by samples desc, loss_weight desc, signal_weight desc),
    '[]'::jsonb
  )
  from ranked
$$;

revoke all on function public.get_long_bot_experience_patterns() from public;
grant execute on function public.get_long_bot_experience_patterns() to anon, authenticated;

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
        status = 'over',
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
end $$;

notify pgrst, 'reload schema';
