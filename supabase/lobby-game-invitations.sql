begin;

create table if not exists private.lobby_game_invitations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null unique references public.rooms(id) on delete cascade,
  sender_identity text not null,
  recipient_identity text not null,
  recipient_name text not null,
  variant text not null check (variant in ('long', 'short')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (sender_identity <> recipient_identity)
);

alter table private.lobby_game_invitations enable row level security;
revoke all on private.lobby_game_invitations from public, anon, authenticated, service_role;

create index if not exists lobby_game_invitations_sender_idx
  on private.lobby_game_invitations (sender_identity, created_at desc);
create index if not exists lobby_game_invitations_recipient_idx
  on private.lobby_game_invitations (recipient_identity, created_at desc)
  where status = 'pending';

create or replace function private.lobby_invitation_actor()
returns text
language sql
stable
set search_path = pg_catalog
as $$
  select case auth.role()
    when 'authenticated' then 'user:' || auth.uid()::text
    when 'anon' then public.request_guest_identity()
  end
$$;

create or replace function private.lobby_invitation_target(p_identity text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select encode(extensions.digest('nardu/lobby-invite/v1:' || p_identity, 'sha256'), 'hex')
$$;

create or replace function private.lobby_invitation_active(p_identity text)
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  select case when left(p_identity, 5) = 'user:' then exists (
    select 1 from private.active_room_players where player_id = substring(p_identity from 6)::uuid
  ) else exists (
    select 1 from private.active_room_guests where guest_id = p_identity
  ) end
$$;

create or replace function private.lobby_invitation_players()
returns table (identity text, nickname text, rating integer, guest boolean)
language sql
stable
set search_path = pg_catalog
as $$
  select 'user:' || p.id::text, p.nickname,
    case when p.rating_eligible and p.show_rating_in_lobby is true then p.rating end, false
  from public.profiles p
  where p.banned_at is null
    and p.last_seen_at between now() - interval '90 seconds' and now() + interval '15 seconds'
  union all
  select g.id, g.name, null::integer, true
  from public.guest_presence g
  where g.id ~ '^guest:sha256:[0-9a-f]{64}$'
    and g.last_seen_at between now() - interval '90 seconds' and now() + interval '15 seconds'
$$;

revoke all on function private.lobby_invitation_actor(),
  private.lobby_invitation_target(text), private.lobby_invitation_active(text),
  private.lobby_invitation_players() from public, anon, authenticated, service_role;

create or replace function public.list_lobby_invite_targets()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  actor text := private.lobby_invitation_actor();
begin
  if actor is null then
    raise exception 'Player session required.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'nickname', p.nickname,
      'rating', p.rating,
      'guest', p.guest,
      'invite_target', case when p.identity <> actor then private.lobby_invitation_target(p.identity) end,
      'can_invite', p.identity <> actor and not private.lobby_invitation_active(p.identity)
    ) order by p.guest, p.rating desc nulls last, lower(p.nickname), p.nickname)
    from private.lobby_invitation_players() p
  ), '[]'::jsonb);
end;
$$;

create or replace function public.list_lobby_game_invitations()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  actor text := private.lobby_invitation_actor();
begin
  if actor is null then
    raise exception 'Player session required.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'incoming', coalesce((
      select jsonb_agg(entry.value order by entry.created_at desc)
      from (
        select i.created_at, jsonb_build_object('id', i.id, 'nickname', room.host_name, 'variant', i.variant) as value
        from private.lobby_game_invitations i
        join public.rooms room on room.id = i.room_id
        where i.recipient_identity = actor and i.status = 'pending' and i.expires_at > now()
          and room.status = 'waiting'
        order by i.created_at desc
        limit 20
      ) entry
    ), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(entry.value order by entry.created_at desc)
      from (
        select i.created_at, jsonb_build_object('id', i.id, 'nickname', i.recipient_name,
          'variant', i.variant, 'room_code', room.code, 'status', case
            when i.status = 'declined' then 'declined'
            when room.status = 'joined' and i.status = 'accepted' then 'accepted'
            when room.status <> 'waiting' or i.expires_at <= now() then 'expired'
            else i.status
          end) as value
        from private.lobby_game_invitations i
        join public.rooms room on room.id = i.room_id
        where i.sender_identity = actor
          and (room.status = 'waiting' or i.created_at >= now() - interval '10 minutes')
        order by i.created_at desc
        limit 20
      ) entry
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.send_lobby_game_invitation(p_target text, p_variant text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  actor text := private.lobby_invitation_actor();
  sender record;
  recipient record;
  invitation_id uuid;
  room_id uuid;
  room_code text;
  attempt integer;
  position integer;
  player_identity text;
  random_code bytea;
  code_chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  constraint_name text;
begin
  if actor is null then
    raise exception 'Player session required.' using errcode = '42501';
  end if;
  if p_variant is null or p_variant not in ('long', 'short') or p_target is null or p_target !~ '^[a-f0-9]{64}$' then
    raise exception 'lobby_invite_invalid' using errcode = '22023';
  end if;
  if p_target = private.lobby_invitation_target(actor) then
    raise exception 'lobby_invite_self' using errcode = '22023';
  end if;
  select * into sender from private.lobby_invitation_players() p where p.identity = actor;
  select * into recipient from private.lobby_invitation_players() p where private.lobby_invitation_target(p.identity) = p_target;
  if sender.identity is null or recipient.identity is null then
    raise exception 'lobby_invite_unavailable' using errcode = '22023';
  end if;

  -- Serialize reciprocal sends and native room creation on both identities.
  -- Use the same lock namespace and order as the active room trigger.
  for player_identity in select unnest(array[actor, recipient.identity]) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('rooms:active-player:' || player_identity, 0));
  end loop;
  select i.id, room.code into invitation_id, room_code
  from private.lobby_game_invitations i
  join public.rooms room on room.id = i.room_id
  where i.sender_identity = actor and i.recipient_identity = recipient.identity and i.variant = p_variant
    and i.status = 'pending' and i.expires_at > clock_timestamp() and room.status = 'waiting';
  if found then
    return jsonb_build_object('id', invitation_id, 'room_code', room_code);
  end if;
  if private.lobby_invitation_active(actor) or private.lobby_invitation_active(recipient.identity) then
    raise exception 'lobby_invite_player_busy' using errcode = '23505';
  end if;

  for attempt in 1..6 loop
    random_code := extensions.gen_random_bytes(8);
    room_code := '';
    for position in 0..7 loop
      if position = 4 then room_code := room_code || '-'; end if;
      room_code := room_code || substr(code_chars, 1 + (get_byte(random_code, position) % length(code_chars)), 1);
    end loop;
    begin
      insert into public.rooms (code, variant, access, password_hash, status,
        host_user_id, host_guest_id, host_name, host_rating, host_registered, presence)
      values (room_code, p_variant, 'closed', encode(extensions.gen_random_bytes(32), 'hex'), 'waiting',
        case when not sender.guest then substring(actor from 6)::uuid end,
        case when sender.guest then actor end,
        sender.nickname, sender.rating, not sender.guest, '{"white":null,"dark":null}'::jsonb)
      returning id into room_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics constraint_name = CONSTRAINT_NAME;
      if constraint_name <> 'rooms_code_key' then
        raise exception 'lobby_invite_player_busy' using errcode = '23505';
      end if;
    end;
  end loop;
  if room_id is null then
    raise exception 'lobby_invite_unavailable' using errcode = '22023';
  end if;

  insert into private.lobby_game_invitations (room_id, sender_identity, recipient_identity, recipient_name, variant, expires_at)
  values (room_id, actor, recipient.identity, recipient.nickname, p_variant, clock_timestamp() + interval '2 minutes')
  returning id into invitation_id;
  return jsonb_build_object('id', invitation_id, 'room_code', room_code);
end;
$$;

create or replace function private.guard_lobby_game_invitation_room()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  invitation private.lobby_game_invitations%rowtype;
begin
  if old.status <> 'waiting' or new.status not in ('waiting', 'joined') then return new; end if;
  select * into invitation from private.lobby_game_invitations i where i.room_id = old.id;
  if not found then return new; end if;
  if new.code is distinct from old.code or new.variant is distinct from old.variant
    or new.access is distinct from old.access or new.password_hash is distinct from old.password_hash
    or new.allow_spectators is distinct from old.allow_spectators then
    raise exception 'lobby_invite_invalid' using errcode = '42501';
  end if;
  if new.status = 'joined' and (
    invitation.status <> 'accepted' or invitation.expires_at <= clock_timestamp()
    or private.lobby_invitation_actor() is distinct from invitation.recipient_identity
    or coalesce('user:' || new.guest_user_id::text, new.guest_guest_id) is distinct from invitation.recipient_identity
  ) then
    raise exception 'lobby_invite_unavailable' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_lobby_game_invitation_room() from public, anon, authenticated, service_role;
drop trigger if exists rooms_guard_lobby_game_invitation on public.rooms;
create trigger rooms_guard_lobby_game_invitation
  before update of status, code, variant, access, password_hash, allow_spectators on public.rooms
  for each row execute function private.guard_lobby_game_invitation_room();

create or replace function public.answer_lobby_game_invitation(p_invitation_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  actor text := private.lobby_invitation_actor();
  invitation private.lobby_game_invitations%rowtype;
  room public.rooms%rowtype;
  recipient record;
begin
  if actor is null then
    raise exception 'Player session required.' using errcode = '42501';
  end if;
  if p_invitation_id is null or p_accept is null then
    raise exception 'lobby_invite_invalid' using errcode = '22023';
  end if;
  select * into invitation from private.lobby_game_invitations i
  where i.id = p_invitation_id and i.recipient_identity = actor for update;
  if not found then
    raise exception 'lobby_invite_unavailable' using errcode = '22023';
  end if;
  select * into room from public.rooms r where r.id = invitation.room_id for update;
  if invitation.status = 'accepted' and p_accept and room.status = 'joined' then
    return jsonb_build_object('room_code', room.code);
  end if;
  if invitation.status = 'declined' and not p_accept then
    return '{}'::jsonb;
  end if;
  if invitation.status <> 'pending' or invitation.expires_at <= clock_timestamp()
    or room.status is distinct from 'waiting'
    or coalesce('user:' || room.host_user_id::text, room.host_guest_id) is distinct from invitation.sender_identity then
    raise exception 'lobby_invite_unavailable' using errcode = '22023';
  end if;
  if not p_accept then
    update private.lobby_game_invitations set status = 'declined' where id = invitation.id;
    return '{}'::jsonb;
  end if;

  select * into recipient from private.lobby_invitation_players() p where p.identity = actor;
  if recipient.identity is null or not exists (
    select 1 from private.lobby_invitation_players() p where p.identity = invitation.sender_identity
  ) then
    raise exception 'lobby_invite_unavailable' using errcode = '22023';
  end if;
  if private.lobby_invitation_active(actor) then
    raise exception 'lobby_invite_player_busy' using errcode = '23505';
  end if;
  update private.lobby_game_invitations set status = 'accepted' where id = invitation.id;
  begin
    update public.rooms set status = 'joined',
      guest_user_id = case when not recipient.guest then substring(actor from 6)::uuid end,
      guest_guest_id = case when recipient.guest then actor end,
      guest_name = recipient.nickname, guest_rating = recipient.rating,
      guest_registered = not recipient.guest, joined_at = clock_timestamp(),
      presence = '{"white":null,"dark":null}'::jsonb
    where id = room.id;
  exception when unique_violation then
    raise exception 'lobby_invite_player_busy' using errcode = '23505';
  end;
  return jsonb_build_object('room_code', room.code);
end;
$$;

revoke all on function public.list_lobby_invite_targets(), public.list_lobby_game_invitations(),
  public.send_lobby_game_invitation(text, text), public.answer_lobby_game_invitation(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.list_lobby_invite_targets(), public.list_lobby_game_invitations(),
  public.send_lobby_game_invitation(text, text), public.answer_lobby_game_invitation(uuid, boolean)
  to anon, authenticated;

notify pgrst, 'reload schema';
commit;
