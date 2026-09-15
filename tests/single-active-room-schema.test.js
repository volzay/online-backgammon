const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'single-active-room-v34.sql'),
  'utf8',
);
const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
const longBotStrategy = fs.readFileSync(
  path.join(ROOT, 'supabase', 'long-bot-strategy-v34.sql'),
  'utf8',
);
const waitingRoomClose = fs.readFileSync(
  path.join(ROOT, 'supabase', 'waiting-room-owner-close-v35.sql'),
  'utf8',
);

function waitingRoomCloseFunction(source) {
  const start = source.indexOf('create or replace function public.close_own_waiting_room(p_room_code text)');
  const end = source.indexOf(
    'grant execute on function public.close_own_waiting_room(text) to anon, authenticated;',
    start,
  );
  assert.ok(start >= 0 && end > start, 'the owner-only waiting-room close RPC must exist');
  return source.slice(start, end);
}

function assertSingleRoomGuard(source) {
  assert.match(source, /add column if not exists host_guest_id text/);
  assert.match(source, /add column if not exists guest_guest_id text/);
  assert.match(source, /create or replace function private\.guest_identity_from_proof\(proof text\)[\s\S]*proof ~ '\^gproof:\[0-9a-f\]\{64\}\$'[\s\S]*extensions\.digest[\s\S]*nardu\/guest\/v1:/);
  assert.match(source, /revoke all on function private\.guest_identity_from_proof\(text\)[\s\S]*from public, anon, authenticated/);
  assert.match(source, /create or replace function public\.request_guest_identity\(\)[\s\S]*security definer[\s\S]*x-guest-id[\s\S]*x-guest-proof[\s\S]*declared_guest_id = proven_guest_id/);
  assert.match(source, /create policy "authenticated users can create rooms"[\s\S]*host_user_id = auth\.uid\(\)[\s\S]*host_guest_id is null[\s\S]*guest_user_id is null[\s\S]*guest_guest_id is null[\s\S]*status in \('waiting', 'joined'\)/);
  assert.match(source, /create policy "anonymous guests can create rooms"[\s\S]*host_user_id is null[\s\S]*host_guest_id = public\.request_guest_identity\(\)[\s\S]*host_guest_id ~ '\^guest:sha256:\[0-9a-f\]\{64\}\$'[\s\S]*guest_guest_id is null/);
  assert.match(source, /create policy "anonymous guests can update guest rooms"[\s\S]*public\.request_guest_identity\(\) in \(host_guest_id, guest_guest_id\)/);
  assert.match(source, /create policy "anonymous guests can join waiting rooms"[\s\S]*guest_guest_id is null[\s\S]*public\.request_guest_identity\(\) is not null[\s\S]*with check \([\s\S]*guest_guest_id = public\.request_guest_identity\(\)/);
  assert.match(source, /drop index if exists public\.rooms_one_active_room_per_host_idx;[\s\S]*create unique index rooms_one_active_room_per_host_idx[\s\S]*status in \('waiting', 'joined'\)/);
  assert.match(source, /drop index if exists public\.rooms_one_active_room_per_guest_idx;[\s\S]*create unique index rooms_one_active_room_per_guest_idx[\s\S]*status in \('waiting', 'joined'\)/);
  assert.match(source, /drop index if exists public\.rooms_one_active_room_per_host_guest_idx;[\s\S]*create unique index rooms_one_active_room_per_host_guest_idx[\s\S]*host_guest_id is not null[\s\S]*status in \('waiting', 'joined'\)/);
  assert.match(source, /drop index if exists public\.rooms_one_active_room_per_guest_guest_idx;[\s\S]*create unique index rooms_one_active_room_per_guest_guest_idx[\s\S]*guest_guest_id is not null[\s\S]*status in \('waiting', 'joined'\)/);
  assert.match(source, /create table if not exists private\.active_room_players \([\s\S]*player_id uuid primary key[\s\S]*room_id uuid not null/);
  assert.match(source, /create table if not exists private\.active_room_guests \([\s\S]*guest_id text primary key[\s\S]*room_id uuid not null/);
  assert.match(source, /alter table private\.active_room_players enable row level security/);
  assert.match(source, /alter table private\.active_room_guests enable row level security/);
  assert.match(source, /create or replace function public\.validate_room_participant_transition\(\)[\s\S]*security definer/);
  assert.match(source, /request_role not in \('authenticated', 'anon'\)[\s\S]*public\.is_admin_user\(\)/);
  assert.match(source, /request_guest_id text := public\.request_guest_identity\(\)/);
  assert.match(source, /old\.guest_user_id is null[\s\S]*new\.guest_user_id = player_id[\s\S]*new\.host_user_id is not distinct from old\.host_user_id/);
  assert.match(source, /request_role = 'anon'[\s\S]*new\.guest_guest_id is not null[\s\S]*new\.guest_guest_id = request_guest_id[\s\S]*new\.guest_guest_id ~ '\^guest:[^']+'[\s\S]*new\.host_guest_id is not distinct from old\.host_guest_id/);
  assert.match(source, /request_guest_id = old\.host_guest_id[\s\S]*or request_guest_id = old\.guest_guest_id/);
  assert.match(source, /message = 'Room participant identities are immutable\.'/);
  assert.match(source, /create trigger rooms_validate_participant_transition_trg[\s\S]*before insert or update of status, host_user_id, guest_user_id, host_guest_id, guest_guest_id/);
  assert.match(source, /create or replace function public\.enforce_single_active_room_per_player\(\)[\s\S]*security definer/);
  assert.match(source, /order by participant\.identity_key[\s\S]*pg_advisory_xact_lock/);
  assert.match(source, /delete from private\.active_room_players claim[\s\S]*where claim\.room_id = old\.id/);
  assert.match(source, /delete from private\.active_room_guests claim[\s\S]*where claim\.room_id = old\.id/);
  assert.match(source, /insert into private\.active_room_players \(player_id, room_id\)/);
  assert.match(source, /insert into private\.active_room_guests \(guest_id, room_id\)/);
  assert.match(source, /errcode = '23505'[\s\S]*constraint = 'rooms_one_active_room_per_player'/);
  assert.match(source, /create trigger rooms_enforce_single_active_room_per_player_trg[\s\S]*after insert or update of status, host_user_id, guest_user_id, host_guest_id, guest_guest_id[\s\S]*on public\.rooms/);
  assert.match(source, /rooms_participant_identity_shape_chk/);
  assert.match(source, /rooms_active_distinct_participants_chk[\s\S]*host_user_id <> guest_user_id[\s\S]*host_guest_id <> guest_guest_id/);
  assert.match(source, /rooms_waiting_guest_seats_empty_chk[\s\S]*status <> 'waiting'[\s\S]*guest_user_id is null[\s\S]*guest_guest_id is null/);
  assert.match(source, /rooms_joined_has_opponent_chk[\s\S]*status <> 'joined'[\s\S]*guest_user_id is not null[\s\S]*guest_guest_id is not null[\s\S]*'bot' in \([\s\S]*game_state->>'mode'[\s\S]*game_state->>'opponent'[\s\S]*game_state->'analysis'->>'mode'[\s\S]*game_state->'analysis'->>'opponent'/);
  assert.match(source, /new\.status is distinct from old\.status[\s\S]*old\.status = 'waiting' and new\.status in \('joined', 'closed'\)[\s\S]*old\.status = 'joined' and new\.status in \('over', 'closed'\)[\s\S]*old\.status = 'over' and new\.status = 'closed'[\s\S]*constraint = 'rooms_status_transition'/);
  assert.match(source, /closed_reason = 'legacy_guest_identity_missing'[\s\S]*room\.status in \('waiting', 'joined'\)[\s\S]*room\.host_user_id is null[\s\S]*room\.host_guest_id is null[\s\S]*room\.status = 'joined'[\s\S]*room\.guest_user_id is null[\s\S]*room\.guest_guest_id is null[\s\S]*'bot' not in/);
  assert.match(source, /closed_reason = 'legacy_guest_credential_rotated'[\s\S]*room\.status in \('waiting', 'joined'\)[\s\S]*host_guest_id !~ '\^guest:sha256:[^']+'[\s\S]*guest_guest_id !~ '\^guest:sha256:/);
  assert.match(source, /create policy "clients can create guest presence"[\s\S]*id = public\.request_guest_identity\(\)/);
  assert.match(source, /create policy "clients can update guest presence"[\s\S]*using \([\s\S]*id = public\.request_guest_identity\(\)[\s\S]*with check/);
  assert.doesNotMatch(source, /guest:legacy:/);
}

test('the v34 migration repairs duplicate rooms before installing the atomic guard', () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /lock table public\.rooms in share row exclusive mode/);
  const legacyRepair = migration.indexOf("closed_reason = 'legacy_guest_identity_missing'");
  const credentialRotation = migration.indexOf("closed_reason = 'legacy_guest_credential_rotated'");
  const repair = migration.indexOf("closed_reason = 'duplicate_active_room'");
  const shapeRepair = migration.indexOf("closed_reason = 'invalid_active_room_shape'");
  const hostIndex = migration.indexOf('rooms_one_active_room_per_host_idx');
  const waitingShape = migration.indexOf('rooms_waiting_guest_seats_empty_chk');
  const trigger = migration.indexOf('create trigger rooms_enforce_single_active_room_per_player_trg');
  assert.ok(credentialRotation >= 0 && legacyRepair > credentialRotation, 'raw guest bearers must close before missing identities are repaired');
  assert.ok(shapeRepair > legacyRepair, 'unrecoverable legacy guests must close before shape validation');
  assert.ok(repair > shapeRepair, 'malformed active rows must close before duplicate ranking');
  assert.ok(hostIndex > repair && waitingShape > hostIndex && trigger > waitingShape);
  assert.match(migration, /closed_reason = 'invalid_active_room_shape'[\s\S]*room\.status = 'waiting'[\s\S]*room\.guest_user_id is not null[\s\S]*room\.guest_guest_id is not null[\s\S]*room\.status = 'joined'[\s\S]*'bot' not in/);
  assert.match(migration, /case membership\.status when 'joined' then 0 else 1 end[\s\S]*coalesce\(membership\.joined_at, membership\.created_at\) desc/);
  const memberships = migration.slice(
    migration.indexOf('with active_memberships as ('),
    migration.indexOf('), ranked_memberships as ('),
  );
  assert.doesNotMatch(memberships, /union all/i);
  assert.doesNotMatch(memberships, /host_name|guest_name/);
  assert.match(migration, /^commit;/m);
  assertSingleRoomGuard(migration);
});

test('the canonical Supabase schema retains the cross-role single-room guard', () => {
  assertSingleRoomGuard(schema);
  assert.match(schema, /closed_reason = 'duplicate_active_room'/);
  const guardStart = schema.lastIndexOf('begin;', schema.indexOf('rooms_enforce_single_active_room_per_player_trg'));
  const lock = schema.indexOf('lock table public.rooms in share row exclusive mode', guardStart);
  const guardCommit = schema.indexOf('commit;', lock);
  assert.ok(guardStart >= 0 && lock > guardStart && guardCommit > lock);
  const hardenedPolicy = schema.indexOf('create policy "authenticated users can create rooms"', guardStart);
  assert.ok(hardenedPolicy > guardStart && hardenedPolicy < guardCommit, 'the hardened insert policy must commit atomically with the guard');
  const guestCreatePolicy = schema.indexOf('create policy "anonymous guests can create rooms"', guardStart);
  const guestJoinPolicy = schema.indexOf('create policy "anonymous guests can join waiting rooms"', guardStart);
  const transitionGuard = schema.indexOf('create trigger rooms_validate_participant_transition_trg', guardStart);
  assert.ok(guestCreatePolicy > guardStart && guestCreatePolicy < guardCommit);
  assert.ok(guestJoinPolicy > guestCreatePolicy && guestJoinPolicy < guardCommit);
  assert.ok(transitionGuard > guestJoinPolicy && transitionGuard < guardCommit);
});

test('waiting-room closure bypasses the terminal-row RLS conflict without exposing closed rooms', () => {
  assert.match(waitingRoomClose, /^begin;/m);
  assert.match(waitingRoomClose, /^commit;/m);

  for (const source of [waitingRoomClose, schema]) {
    const closeRoom = waitingRoomCloseFunction(source);
    assert.match(closeRoom, /security definer/);
    assert.match(closeRoom, /set search_path = pg_catalog, auth/);
    assert.match(closeRoom, /clean_code !~ '\^\[A-HJ-NP-Z2-9\]\{4\}-\[A-HJ-NP-Z2-9\]\{4\}\$'/);
    assert.match(closeRoom, /request_role not in \('authenticated', 'anon'\)/);
    assert.match(closeRoom, /player_id uuid := auth\.uid\(\)/);
    assert.match(closeRoom, /guest_id text := case[\s\S]*public\.request_guest_identity\(\)/);
    assert.match(closeRoom, /room\.status = 'waiting'/);
    assert.match(closeRoom, /room\.guest_user_id is null[\s\S]*room\.guest_guest_id is null/);
    assert.match(closeRoom, /room\.host_user_id = player_id/);
    assert.match(closeRoom, /room\.host_guest_id = guest_id/);
    assert.match(closeRoom, /status = 'closed'[\s\S]*closed_reason = 'waiting_host_exit'/);
    assert.match(closeRoom, /owned_status in \('waiting', 'joined'\)/);
    assert.match(source, /revoke all on function public\.close_own_waiting_room\(text\)[\s\S]*from public, anon, authenticated/);
    assert.match(source, /grant execute on function public\.close_own_waiting_room\(text\) to anon, authenticated/);
  }

  assert.match(waitingRoomClose, /notify pgrst, 'reload schema';/);

  const authenticatedSelect = schema.match(
    /create policy "authenticated users can see non-closed rooms"[\s\S]*?using \(([^;]+)\);/,
  );
  assert.ok(authenticatedSelect);
  assert.match(authenticatedSelect[1], /status <> 'closed'/);
  assert.doesNotMatch(authenticatedSelect[1], /host_user_id|guest_user_id/);
});

test('the room lifecycle is forward-only for untrusted callers while trusted maintenance bypasses it', () => {
  for (const source of [migration, schema]) {
    const functionStart = source.indexOf('create or replace function public.validate_room_participant_transition()');
    const functionEnd = source.indexOf('\n$$;', functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const validator = source.slice(functionStart, functionEnd);
    const serviceBypass = validator.indexOf("request_role not in ('authenticated', 'anon')");
    const adminBypass = validator.indexOf("request_role = 'authenticated' and coalesce(public.is_admin_user(), false)");
    const transitionCheck = validator.indexOf('new.status is distinct from old.status');
    assert.ok(serviceBypass >= 0 && adminBypass > serviceBypass && transitionCheck > adminBypass);
    assert.match(validator, /old\.status = 'waiting' and new\.status in \('joined', 'closed'\)/);
    assert.match(validator, /old\.status = 'joined' and new\.status in \('over', 'closed'\)/);
    assert.match(validator, /old\.status = 'over' and new\.status = 'closed'/);
    assert.doesNotMatch(validator, /old\.status = 'closed' and/);
  }
});

test('late game finalization preserves a terminally closed room', () => {
  for (const source of [schema, longBotStrategy]) {
    const functionStart = source.indexOf(
      'create or replace function public.finish_room_game(\n  p_room_code text,\n  p_final_state jsonb,\n  p_training_state jsonb',
    );
    const functionEnd = source.indexOf(
      'revoke all on function public.finish_room_game(text, jsonb, jsonb)',
      functionStart,
    );
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const finishRoomGame = source.slice(functionStart, functionEnd);
    assert.match(
      finishRoomGame,
      /status = case when target\.status = 'closed' then 'closed' else 'over' end/,
    );
    assert.doesNotMatch(finishRoomGame, /\n\s*status = 'over',/);
    assert.match(finishRoomGame, /game_state = p_final_state[\s\S]*game_version = next_version[\s\S]*archived_at = completed_at[\s\S]*closed_reason = 'finished'/);
  }

  const ratingFinalizerStart = schema.indexOf(
    '-- Rating and room finalization share the same authenticated transaction.',
  );
  const ratingFinalizerEnd = schema.indexOf(
    "raise warning 'Could not finalize room % from rating result: %'",
    ratingFinalizerStart,
  );
  assert.ok(ratingFinalizerStart >= 0 && ratingFinalizerEnd > ratingFinalizerStart);
  const ratingFinalizer = schema.slice(ratingFinalizerStart, ratingFinalizerEnd);
  assert.match(
    ratingFinalizer,
    /status = case when status = 'closed' then 'closed' else 'over' end/,
  );
  assert.doesNotMatch(ratingFinalizer, /\n\s*status = 'over',/);
});
