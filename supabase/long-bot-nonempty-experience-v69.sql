begin;
set local lock_timeout = '4s';
set local statement_timeout = '20s';

create or replace function private.long_bot_experience_pristine_opening(p_state jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_state->>'phase' = 'opening'
    and coalesce(p_state->'history', '[]'::jsonb) = '[]'::jsonb
    and coalesce(p_state->'turnMoves', '[]'::jsonb) = '[]'::jsonb
    and coalesce(p_state->'openingRoll','null'::jsonb) = 'null'::jsonb
    and coalesce(p_state->'dice','[]'::jsonb) = '[]'::jsonb
    and coalesce(p_state->'rolled','[]'::jsonb) = '[]'::jsonb
    and p_state->>'winner' is null, false)
$$;

create or replace function private.long_bot_experience_is_hard_room(p_room public.rooms)
returns boolean language sql stable set search_path='' as $$
  select coalesce(p_room.variant = 'long' and p_room.status = 'joined'
    and p_room.guest_user_id is null and p_room.guest_guest_id is null
    and coalesce(p_room.game_state->>'mode',p_room.game_state#>>'{analysis,mode}') = 'bot'
    and coalesce(p_room.game_state->>'botDifficulty',p_room.game_state#>>'{analysis,difficulty}') = 'hard', false)
$$;

create or replace function private.require_nonempty_long_bot_experience(p_room public.rooms, p_acknowledgement_required boolean)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if not exists (
    select 1 from private.long_bot_signed_experience_snapshots s
    join private.long_bot_causal_serving_runtime() active on active.singleton and active.explicitly_approved
      and active.policy_implementation_id = s.policy_implementation_id
      and (active.runtime_digest = s.runtime_digest or exists (
        select 1 from private.long_bot_causal_experience_sources compatible
        where compatible.serving_runtime_digest = active.runtime_digest
          and compatible.source_runtime_digest = s.runtime_digest))
    where s.room_id = p_room.id and s.owner_id = p_room.host_user_id
      and p_room.game_state->'startedAt' = pg_catalog.to_jsonb(s.round_started_at)
      and jsonb_array_length(s.patterns) > 0
      and (not p_acknowledgement_required
        or s.snapshot_hash = p_room.game_state#>>'{analysis,botMemory,signedExperienceHash}')
      and private.long_bot_signed_experience_is_valid(s)
  ) then
    raise exception 'Подтверждённые уроки «Сложного» пока недоступны.' using errcode = 'LB001';
  end if;
end
$$;

revoke all on function private.long_bot_experience_pristine_opening(jsonb),
  private.long_bot_experience_is_hard_room(public.rooms),
  private.require_nonempty_long_bot_experience(public.rooms,boolean)
from public, anon, authenticated, service_role;
create or replace function public.load_signed_long_bot_experience(
  p_policy_implementation_id text, p_room_code text, p_round_started_at bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request_owner uuid := auth.uid();
  active private.long_bot_causal_runtime;
  room public.rooms;
  sealed private.long_bot_signed_experience_snapshots;
  lessons jsonb;
  issued_at timestamptz;
  payload bytea;
  pristine boolean;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or request_owner is null then
    raise exception 'Only the authenticated room player may request a signed experience snapshot.' using errcode = '42501';
  end if;
  if coalesce(p_policy_implementation_id, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_room_code, '') !~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'
    or p_round_started_at is null or p_round_started_at not between 1 and 9007199254740991 then
    return null;
  end if;

  select * into active from private.long_bot_causal_serving_runtime()
  where singleton and explicitly_approved and policy_implementation_id = p_policy_implementation_id;
  if active.runtime_digest is null then return null; end if;

  -- Serialize issuance and pristine empty-snapshot replacement against play.
  -- Issued snapshots remain readable on an authoritative same-round restore.
  select r.* into room from public.rooms r
  where r.code = p_room_code and r.host_user_id = request_owner and r.variant = 'long'
    and r.status = 'joined' and r.guest_user_id is null and r.guest_guest_id is null
    and r.game_state->>'mode' = 'bot' and r.game_state->>'botDifficulty' = 'hard'
    and r.game_state->'startedAt' = pg_catalog.to_jsonb(p_round_started_at)
  for update;
  if room.id is null then return null; end if;

  select x.* into sealed from private.long_bot_signed_experience_snapshots x
  where x.room_id = room.id and x.owner_id = request_owner
    and x.round_started_at = p_round_started_at and x.policy_implementation_id = p_policy_implementation_id;
  pristine := private.long_bot_experience_pristine_opening(room.game_state);
  if sealed.room_id is null or (pristine and sealed.patterns = '[]'::jsonb) then
    if not pristine then return null; end if;
    if sealed.room_id is not null and not private.long_bot_signed_experience_is_valid(sealed) then
      raise exception 'Server experience snapshot could not be authenticated.' using errcode = '22023';
    end if;
    -- Read the published patterns and their serving identity from the same
    -- statement snapshot, including during a same-policy reviewer cutover.
    select serving.runtime_digest, public.get_long_bot_experience_patterns(null)
      into active.runtime_digest,lessons
    from private.long_bot_causal_serving_runtime() serving
    where serving.singleton and serving.explicitly_approved
      and serving.policy_implementation_id=p_policy_implementation_id;
    if active.runtime_digest is null then return null; end if;
    if jsonb_typeof(lessons) is distinct from 'array' or jsonb_array_length(lessons) > 256
      or octet_length(lessons::text) > 524288 then
      raise exception 'Published experience exceeds the signed snapshot bounds.' using errcode = '22023';
    end if;
    if jsonb_array_length(lessons) = 0 then
      raise exception 'Подтверждённые уроки «Сложного» пока недоступны.' using errcode = 'LB001';
    end if;
    issued_at := pg_catalog.clock_timestamp();
    payload := private.long_bot_signed_experience_bytes(
      room.id, request_owner, p_round_started_at, p_policy_implementation_id,
      active.runtime_digest, issued_at, lessons
    );
    insert into private.long_bot_signed_experience_snapshots (
      room_id, owner_id, round_started_at, policy_implementation_id, runtime_digest,
      issued_at, patterns, snapshot_hash, signature
    )
    select room.id, request_owner, p_round_started_at, p_policy_implementation_id, active.runtime_digest,
      issued_at, lessons, pg_catalog.encode(extensions.digest(payload, 'sha256'), 'hex'),
      extensions.hmac(payload, key.secret, 'sha256')
    from private.long_bot_experience_signing_key key where key.singleton
    on conflict (room_id, owner_id, round_started_at, policy_implementation_id) do update
    set runtime_digest=excluded.runtime_digest, issued_at=excluded.issued_at, patterns=excluded.patterns,
        snapshot_hash=excluded.snapshot_hash, signature=excluded.signature
    where long_bot_signed_experience_snapshots.patterns = '[]'::jsonb;
    select x.* into sealed from private.long_bot_signed_experience_snapshots x
    where x.room_id = room.id and x.owner_id = request_owner
      and x.round_started_at = p_round_started_at and x.policy_implementation_id = p_policy_implementation_id;
  end if;
  if sealed.room_id is null or not private.long_bot_signed_experience_is_valid(sealed) then
    raise exception 'Server experience snapshot could not be authenticated.' using errcode = '22023';
  end if;
  return jsonb_build_object('policyImplementationId', p_policy_implementation_id, 'patterns', sealed.patterns,
    'snapshotHash', sealed.snapshot_hash);
end;
$$;
revoke all on function public.load_signed_long_bot_experience(text,text,bigint)
from public, anon, authenticated, service_role;
grant execute on function public.load_signed_long_bot_experience(text,text,bigint) to authenticated;

-- The room guard also covers stale clients and legacy generic state writes.
-- Existing rounds whose opening already played keep their immutable snapshot.
create or replace function private.guard_long_bot_opening_experience()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  same_round_hard boolean := false;
begin
  if tg_op = 'UPDATE' then
    same_round_hard := coalesce(private.long_bot_experience_is_hard_room(old)
      and old.game_state->'startedAt' = new.game_state->'startedAt'
      and old.fair_dice_game_id = new.fair_dice_game_id, false);
  end if;
  if not private.long_bot_experience_is_hard_room(new) then
    if same_round_hard and new.status = 'joined'
      and private.long_bot_experience_pristine_opening(old.game_state)
      and not private.long_bot_experience_pristine_opening(new.game_state) then
      raise exception 'Тип начатой партии «Сложного» изменился.' using errcode = 'LB001';
    end if;
    return new;
  end if;
  if jsonb_typeof(new.game_state->'startedAt') is distinct from 'number'
    or coalesce(new.game_state->>'startedAt','') !~ '^[1-9][0-9]{0,15}$' then
    raise exception 'Партия «Сложного» не получила идентификатор.' using errcode = 'LB001';
  end if;
  if (new.game_state->>'startedAt')::bigint > 9007199254740991 then
    raise exception 'Партия «Сложного» не получила идентификатор.' using errcode = 'LB001';
  end if;
  if same_round_hard then
    if new.game_state is not distinct from old.game_state
      or not private.long_bot_experience_pristine_opening(old.game_state) then return new; end if;
  end if;
  if not private.long_bot_experience_pristine_opening(new.game_state) then
    perform private.require_nonempty_long_bot_experience(new, true);
  end if;
  return new;
end
$$;
revoke all on function private.guard_long_bot_opening_experience() from public, anon, authenticated, service_role;
drop trigger if exists z_long_bot_opening_experience on public.rooms;
create trigger z_long_bot_opening_experience before insert or update of game_state, status, variant on public.rooms
for each row execute function private.guard_long_bot_opening_experience();

-- Reject at reservation, before an opening commitment is created. The room
-- trigger is the independent backstop at the first authoritative transition.
do $reserve_guard$
declare
  definition text := pg_catalog.pg_get_functiondef('public.reserve_fair_dice(text,text,text,text)'::regprocedure);
  anchor text := '  locked_hash := private.fair_dice_position_hash(target.game_state);';
  gate text := E'  if expected_label = ''opening'' and private.long_bot_experience_is_hard_room(target)\n    and private.long_bot_experience_pristine_opening(target.game_state) then\n    perform private.require_nonempty_long_bot_experience(target, false);\n  end if;\n';
begin
  if strpos(definition, gate) > 0 then return; end if;
  if strpos(definition, 'target.fair_dice_protocol') = 0
    or length(definition)-length(replace(definition,anchor,'')) <> length(anchor) then
    raise exception 'Unexpected protected dice reservation contract.';
  end if;
  execute replace(definition,anchor,gate||anchor);
end
$reserve_guard$;
commit;
