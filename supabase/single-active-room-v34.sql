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

-- Registered clients must identify the authenticated profile explicitly.
-- Falling back to auth.uid() when host_user_id is null would bypass every
-- registered-player uniqueness guard because null participants are unclaimed.
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

-- An active player identity may belong to exactly one waiting/joined room.
-- Keep the trigger disabled while repairing and rebuilding the derived claims.
drop trigger if exists rooms_validate_participant_transition_trg on public.rooms;
drop trigger if exists rooms_enforce_single_active_room_per_player_trg on public.rooms;

lock table public.rooms in share row exclusive mode;

-- A raw guest:* value was previously both public data and an ownership bearer.
-- It cannot be rotated without a trusted account, so close every active room
-- that still contains one. Only proof-derived public identifiers survive.
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

-- Scrub the former bearer values from public rows after they have been made
-- inactive. Names and archived game data remain available to administrators.
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

-- A malformed room in which one identity occupies both seats cannot be made
-- active without violating the one-room invariant. Archive it before adding
-- the validated constraints.
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

-- Repair pre-v34 data deterministically.  A started game wins over a waiting
-- room; rooms of the same kind are ordered newest first.  Closing every room
-- that is not a player's first choice guarantees that no active duplicate is
-- left, including duplicates where the player changed from host to guest.
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

-- These indexes reject the common same-role races directly.  The claim table
-- and trigger below additionally cover host-vs-guest races.
-- Recreate them deliberately: a previous interrupted rollout may have left an
-- index with the same name but an older predicate, which IF NOT EXISTS would
-- silently preserve.
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

-- The table is derived from rooms.  Rebuilding it in the same locked
-- transaction also makes this migration safe to re-run after an interrupted
-- or partially deployed earlier version.
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
  -- SQL maintenance and service-role calls are trusted. Authenticated admins
  -- also need to remain able to run account-removal and repair RPCs.
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

  -- A registered join may fill only the previously empty guest seat with the
  -- caller's own authenticated UUID. The host identity is immutable.
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

  -- Anonymous joining follows the same one-way transition and must introduce
  -- one stable guest:* identity. It can never replace either occupied seat.
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

  -- UUID and guest:* identities share one sorted lock namespace so mixed
  -- registered/anonymous room updates cannot acquire locks in opposite order.
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

    -- This detects an existing room even if its derived claim is missing.  The
    -- primary key insert below remains the atomic race barrier.
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

-- Presence identifiers used to expose the same raw bearer. Remove those
-- legacy rows and require the proof-derived identity for all real guests.
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

commit;
