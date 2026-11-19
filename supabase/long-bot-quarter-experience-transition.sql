begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Additive transition over the already installed signed-experience runtime.
-- An authenticated owner may restore the same issued, authenticated snapshot
-- after a playing-policy cutover. Only NEW issuance requires the serving policy.
-- Authentication, round/room ownership, opening/history checks, bounds, signing
-- and final signature verification are otherwise byte-identical to v68.
-- No evidence, archive, job, signing key or existing snapshot is rewritten.

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
begin
  if coalesce(auth.role(), '') <> 'authenticated' or request_owner is null then
    raise exception 'Only the authenticated room player may request a signed experience snapshot.' using errcode = '42501';
  end if;
  if coalesce(p_policy_implementation_id, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_room_code, '') !~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'
    or p_round_started_at is null or p_round_started_at not between 1 and 9007199254740991 then
    return null;
  end if;

  -- Serialize first issuance against a move, a room change or finalization.
  -- Issued snapshots remain readable on an authoritative same-round restore.
  select r.* into room from public.rooms r
  where r.code = p_room_code and r.host_user_id = request_owner and r.variant = 'long'
    and r.status = 'joined' and r.guest_user_id is null and r.guest_guest_id is null
    and r.game_state->>'mode' = 'bot' and r.game_state->>'botDifficulty' = 'hard'
    and r.game_state->'startedAt' = pg_catalog.to_jsonb(p_round_started_at)
  for share;
  if room.id is null then return null; end if;

  select x.* into sealed from private.long_bot_signed_experience_snapshots x
  where x.room_id = room.id and x.owner_id = request_owner
    and x.round_started_at = p_round_started_at and x.policy_implementation_id = p_policy_implementation_id;
  if sealed.room_id is null then
    select * into active from private.long_bot_causal_serving_runtime()
    where singleton and explicitly_approved and policy_implementation_id = p_policy_implementation_id;
    if active.runtime_digest is null then return null; end if;

    if room.game_state->>'phase' is distinct from 'opening'
      or coalesce(room.game_state->'history', '[]'::jsonb) <> '[]'::jsonb
      or coalesce(room.game_state->'turnMoves', '[]'::jsonb) <> '[]'::jsonb
      or room.game_state->>'winner' is not null then
      return null;
    end if;
    lessons := public.get_long_bot_experience_patterns(null);
    if jsonb_typeof(lessons) is distinct from 'array' or jsonb_array_length(lessons) > 256
      or octet_length(lessons::text) > 524288 then
      raise exception 'Published experience exceeds the signed snapshot bounds.' using errcode = '22023';
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
    on conflict (room_id, owner_id, round_started_at, policy_implementation_id) do nothing;
    select x.* into sealed from private.long_bot_signed_experience_snapshots x
    where x.room_id = room.id and x.owner_id = request_owner
      and x.round_started_at = p_round_started_at and x.policy_implementation_id = p_policy_implementation_id;
  end if;
  if sealed.room_id is null or not private.long_bot_signed_experience_is_valid(sealed) then
    raise exception 'Server experience snapshot could not be authenticated.' using errcode = '22023';
  end if;
  return jsonb_build_object('policyImplementationId', p_policy_implementation_id, 'patterns', sealed.patterns);
end;
$$;
revoke all on function public.load_signed_long_bot_experience(text,text,bigint)
from public, anon, authenticated, service_role;
grant execute on function public.load_signed_long_bot_experience(text,text,bigint) to authenticated;

commit;
