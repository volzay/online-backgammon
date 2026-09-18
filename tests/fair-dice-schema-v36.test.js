const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'fair-dice-v36.sql'), 'utf8');

function definition(name) {
  const expression = new RegExp(`create or replace function (?:public|private)\\.${name}\\([\\s\\S]*?\\n\\$\\$;`);
  const found = SOURCE.match(expression)?.[0];
  assert.ok(found, `${name} must be defined`);
  return found;
}

test('new fair policy installs disabled and does not silently activate existing games', () => {
  assert.match(SOURCE, /values \(true, false\) on conflict \(singleton\) do nothing/);
  assert.match(SOURCE, /add column if not exists fair_dice_required boolean not null default false/);
  assert.doesNotMatch(SOURCE, /update public\.rooms set fair_dice_required/i);
  const configure = definition('configure_fair_dice_policy');
  assert.match(configure, /auth\.role\(\), ''\) <> 'service_role'/);
});

test('room policy and epoch are stamped before INSERT and protected on every UPDATE', () => {
  assert.match(SOURCE, /a_fair_dice_authoritative_room_guard before insert or update on public\.rooms/);
  const guard = definition('guard_authoritative_fair_dice_room');
  assert.match(guard, /select enabled into new\.fair_dice_required/);
  assert.match(guard, /new\.fair_dice_game_id := gen_random_uuid\(\)/);
  assert.match(guard, /new\.created_at := clock_timestamp\(\)/);
  assert.match(guard, /new\.fair_dice_required is distinct from old\.fair_dice_required/);
  for (const field of ['id', 'code', 'variant', 'created_at']) assert.match(guard, new RegExp(`new\\.${field} is distinct from old\\.${field}`));
  assert.match(guard, /new\.game_state is distinct from old\.game_state/);
  assert.match(guard, /new\.game_version is distinct from old\.game_version/);
  assert.match(guard, /Fair-dice game state must be committed by the authoritative service/);
});

test('enabled new rooms require a whitespace-delimited current-client compatibility token, not a new auth header', () => {
  const guard = definition('guard_authoritative_fair_dice_room');
  assert.match(guard, /if tg_op = 'INSERT' then[\s\S]*if new\.fair_dice_required then[\s\S]*request\.headers/);
  assert.ok(guard.includes("::jsonb->>'x-client-info'"));
  assert.ok(guard.includes("client_info !~ '(^|[[:space:]])nardu-fair-dice-v36([[:space:]]|$)'"));
  assert.match(guard, /Обновите страницу: для новой игры требуется новая версия подтверждённых бросков\.' using errcode = '22023'/);
  for (const filename of ['fair-dice-v36-rollback-smoke.sql', 'fair-dice-v36-extra-rollback-smoke.sql']) {
    const smoke = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'tests', filename), 'utf8');
    assert.match(smoke, /'x-client-info',\s*'supabase-js-web\/smoke nardu-fair-dice-v36'/);
  }
  const extra = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'tests', 'fair-dice-v36-extra-rollback-smoke.sql'), 'utf8');
  assert.match(extra, /A stale browser header created a required fair-dice room/);
  assert.match(extra, /get stacked diagnostics error_message = message_text/);
});

test('only exact clean starting positions are accepted from initial clients', () => {
  const clean = definition('fair_dice_clean_initial_state');
  for (const field of ['points', 'off', 'bar', 'score', 'history', 'dice', 'rolled', 'turnMoves', 'firstMoveDone', 'headPlayedThisTurn']) {
    assert.match(clean, new RegExp(`p_state->'${field}'`));
  }
  assert.match(clean, /p_state->'history' = '\[\]'::jsonb/);
  assert.match(clean, /p_state->'points' = case when p_variant = 'short'/);
  assert.match(clean, /p_state->>'phase' in \('opening', 'waiting'\)/);
});

test('ledger is private, unique by nonce and has exactly one outstanding request', () => {
  assert.match(SOURCE, /unique\(room_id, game_id, nonce\)/);
  assert.match(SOURCE, /on private\.fair_dice_requests\(room_id, game_id\) where consumed_at is null and cancelled_at is null/);
  assert.match(SOURCE, /revoke all on private\.fair_dice_requests from public, anon, authenticated, service_role/);
  assert.doesNotMatch(SOURCE, /grant (?:all|insert|update|delete).*private\.fair_dice_requests/i);
});

test('reservation locks the room before reusing pending context and chooses future round from DB clock', () => {
  const reserve = definition('reserve_fair_dice');
  assert.match(reserve, /public\.rooms where code = upper\(trim\(p_room_code\)\) for update/);
  assert.match(reserve, /actor := private\.fair_dice_actor\(target\)/);
  assert.match(reserve, /locked_hash := private\.fair_dice_position_hash\(target\.game_state\)/);
  assert.match(reserve, /if found then[\s\S]*return private\.fair_dice_request_json\(pending\)/);
  assert.match(reserve, /now_at := clock_timestamp\(\)/);
  assert.match(reserve, /extract\(epoch from now_at\) \+ 6 - 1692803367\) \/ 3/);
  assert.doesNotMatch(reserve, /target_round\s*:=\s*p_|next_nonce\s*:=\s*p_|locked_hash\s*:=\s*p_/);
  assert.match(reserve, /p_label is distinct from expected_label or p_color is distinct from expected_color/);
});

test('actor authority requires account seat or cryptographic guest proof, not display nickname', () => {
  const actor = definition('fair_dice_actor');
  assert.match(actor, /auth\.uid\(\)/);
  assert.match(actor, /public\.request_guest_identity\(\)/);
  assert.match(actor, /p_room\.host_user_id = player_id/);
  assert.match(actor, /p_room\.host_guest_id = guest_id/);
  assert.doesNotMatch(actor, /host_name|guest_name|nickname/);
  const reserve = definition('reserve_fair_dice');
  assert.match(reserve, /actor->>'bot'[\s\S]*actor->>'ownsHost'/);
  assert.match(reserve, /actor->>'actorColor' is distinct from expected_color/);
});

test('registered actors need an unbanned profile and participants cannot switch seats to choose another turn', () => {
  const actor = definition('fair_dice_actor');
  assert.match(actor, /public\.profiles profile where profile\.id = player_id and profile\.banned_at is null/);
  assert.match(actor, /An active registered player profile is required/);
  const guard = definition('guard_authoritative_fair_dice_room');
  for (const field of ['host_user_id', 'host_guest_id', 'guest_user_id', 'guest_guest_id']) {
    assert.match(guard, new RegExp(`new\\.${field} is distinct from old\\.${field}`));
  }
  assert.match(guard, /not legitimate_join and/);
  assert.match(guard, /Authoritative room participant seats are immutable/);
});

test('immutable proof is tied to exact reservation and required protocol fields', () => {
  const proof = definition('commit_fair_dice_proof');
  assert.match(proof, /p_proof->'request' is distinct from private\.fair_dice_request_json\(target\)/);
  for (const field of ['requestHash', 'receiptSignature', 'chainHash', 'beacon', 'sha256Input', 'sha256', 'dice', 'rerolls']) assert.ok(proof.includes(`'${field}'`), field);
  assert.match(proof, /target\.proof is distinct from p_proof/);
  assert.match(proof, /Dice proof is immutable/);
  assert.match(proof, /extensions\.digest\(convert_to\(p_proof->>'sha256Input', 'UTF8'\), 'sha256'\)/);
});

test('state capability is service-role-only, version CAS and consumed proof cannot be overwritten', () => {
  const commit = definition('commit_fair_dice_state');
  assert.match(commit, /auth\.role\(\), ''\) <> 'service_role'/);
  assert.match(commit, /target\.game_version is distinct from p_expected_version/);
  assert.match(commit, /p_request_id is distinct from outstanding\.id/);
  assert.match(commit, /outstanding\.proof is null/);
  assert.match(commit, /issued_roll := p_next_state#>'\{history,0\}'/);
  assert.ok(commit.indexOf("issued_roll := p_next_state#>'{history,0}'") < commit.indexOf('issued_roll->'), 'Assign the newest history record before checking any issued-roll field');
  assert.match(commit, /issued_roll->>'sha256' is distinct from outstanding\.proof->>'sha256'/);
  assert.match(commit, /issued_roll->>'sha256Input' is distinct from outstanding\.proof->>'sha256Input'/);
  assert.match(commit, /issued_roll->'fairDiceProof' is distinct from outstanding\.proof/);
  assert.match(commit, /old_rolls is distinct from new_old_rolls/);
  assert.match(commit, /set_config\('nardu\.fair_dice_commit_room', target\.id::text, true\)/);
  assert.match(commit, /consumed_at = clock_timestamp\(\)/);
});

test('proof application preserves the board and checks ordinary/double/opening dice order', () => {
  const commit = definition('commit_fair_dice_state');
  for (const field of ['points', 'off', 'bar']) assert.match(commit, new RegExp(`p_next_state->'${field}' is distinct from target\\.game_state->'${field}'`));
  assert.match(commit, /issued_roll->'host' is distinct from to_jsonb\(a\)/);
  assert.match(commit, /issued_roll->'guest' is distinct from to_jsonb\(b\)/);
  assert.match(commit, /jsonb_build_array\(a,a,a,a\)/);
  assert.match(commit, /p_next_state->'rolled' is distinct from expected_rolled/);
  assert.match(commit, /p_next_state->'dice' is distinct from expected_rolled/);
});

test('procedural opening predicates parenthesize CASE so its THEN cannot terminate the IF expression', () => {
  const commit = definition('commit_fair_dice_state');
  assert.match(commit, /p_next_state->>'turn' is distinct from \(case when a > b then 'white' else 'dark' end\)/);
  assert.doesNotMatch(commit, /is distinct from\s+case\b/i);
});

test('rollback smoke groups JSON history extraction before concatenating the terminal event', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'tests', 'fair-dice-v36-rollback-smoke.sql'), 'utf8');
  assert.match(smoke, /\|\| \(roll_state->'history'\)/);
  assert.doesNotMatch(smoke, /\|\|\s+roll_state->'history'/);
  assert.match(smoke, /jsonb_typeof\(terminal_state->'history'\) is distinct from 'array'/);
});

test('privileged RPCs have no anonymous/authenticated execute grants', () => {
  for (const [name, args] of [
    ['commit_fair_dice_proof', 'uuid, jsonb'],
    ['commit_fair_dice_state', 'text, jsonb, integer, uuid'],
    ['reset_fair_dice_game', 'text, jsonb, integer'],
    ['configure_fair_dice_policy', 'boolean'],
  ]) {
    assert.ok(SOURCE.includes(`revoke all on function public.${name}(${args}) from public, anon, authenticated, service_role;`));
    assert.ok(SOURCE.includes(`grant execute on function public.${name}(${args}) to service_role;`));
  }
});

test('rematch cannot reset a live game or destroy previous epoch evidence', () => {
  const reset = definition('reset_fair_dice_game');
  assert.match(reset, /target\.status <> 'over'/);
  assert.match(reset, /target\.game_state->>'phase' is distinct from 'over'/);
  assert.match(reset, /private\.fair_dice_clean_initial_state\(p_initial_state, target\.variant\)/);
  assert.match(reset, /fair_dice_game_id = next_game_id/);
  assert.doesNotMatch(reset, /delete from|truncate /i);
});

test('pending receipts are exposed and terminal-only cancellation preserves evidence', () => {
  const get = definition('get_fair_dice_room');
  assert.match(get, /'pending', case when pending\.id is null then null else jsonb_build_object/);
  assert.match(get, /'request', private\.fair_dice_request_json\(pending\), 'proof', pending\.proof/);
  const commit = definition('commit_fair_dice_state');
  assert.match(commit, /cancel_pending := p_request_id is null and p_next_state->>'phase' = 'over'/);
  assert.match(commit, /terminal_event->>'winnerColor' = p_next_state->>'winner'/);
  assert.match(commit, /cancelled_at = clock_timestamp\(\)/);
  assert.doesNotMatch(commit, /set proof = null|delete from private\.fair_dice_requests/i);
});

test('presence is server-timed, own-seat-only and direct opponent expiry forgery is blocked', () => {
  const touch = definition('touch_fair_dice_presence');
  assert.match(touch, /actor := private\.fair_dice_actor\(target\)/);
  assert.match(touch, /seat := actor->>'seatColor'/);
  assert.match(touch, /now_ms := floor\(extract\(epoch from clock_timestamp\(\)\) \* 1000\)/);
  assert.match(touch, /jsonb_set\(coalesce\(target\.presence, '\{\}'::jsonb\), array\[seat\]/);
  assert.match(touch, /set_config\('nardu\.fair_dice_presence_room', target\.id::text, true\)/);
  const guard = definition('guard_authoritative_fair_dice_room');
  assert.match(guard, /new\.presence is distinct from old\.presence/);
  assert.match(guard, /new\.left_players is distinct from old\.left_players/);
  assert.match(guard, /new\.presence := coalesce\(old\.presence/);
  assert.match(guard, /new\.joined_at := clock_timestamp\(\)/);
  assert.match(guard, /Fair-dice presence must be refreshed by its authenticated server RPC/);
});

test('recovery lists only active uncompleted requests and has service-only bounded access', () => {
  const list = definition('list_pending_fair_dice_requests');
  assert.match(list, /auth\.role\(\), ''\) <> 'service_role'/);
  assert.match(list, /requests\.proof is null and requests\.consumed_at is null and requests\.cancelled_at is null/);
  assert.match(list, /room\.status = 'joined'/);
  assert.match(list, /room\.fair_dice_game_id = requests\.game_id/);
  assert.match(list, /limit 100/);
  assert.ok(SOURCE.includes('grant execute on function public.list_pending_fair_dice_requests() to service_role;'));
});

test('completed games allow only result metadata, never new moves, dice or epoch changes', () => {
  const commit = definition('commit_fair_dice_state');
  assert.match(commit, /target\.status not in \('joined', 'over'\)/);
  assert.match(commit, /target\.status = 'over' and \(p_request_id is not null/);
  assert.match(commit, /p_next_state->'history' is distinct from target\.game_state->'history'/);
  assert.match(commit, /Completed games permit result metadata only/);
  assert.match(commit, /p_next_state#>'\{analysis,playerColor\}' is distinct from target\.game_state#>'\{analysis,playerColor\}'/);
});

test('network loss atomically rechecks trusted presence and join grace against the DB clock', () => {
  const commit = definition('commit_fair_dice_state');
  assert.match(commit, /terminal_event->'networkLoss' = 'true'::jsonb or terminal_event->'timeout' = 'true'::jsonb/);
  assert.match(commit, /target\.game_state->>'mode' = 'bot'/);
  assert.match(commit, /expired_last_seen := \(target\.presence#>>array\[expired_color, 'lastSeen'\]\)::bigint/);
  assert.match(commit, /expiry_base := greatest\(expired_last_seen/);
  assert.match(commit, /extract\(epoch from target\.joined_at\)/);
  assert.match(commit, /now_ms < expiry_base \+ 150000/);
  assert.match(commit, /Player reconnected before the network-loss commit/);
});

test('active rooms cannot be hidden before a terminal result and waiting close is narrowly owner-only', () => {
  const guard = definition('guard_authoritative_fair_dice_room');
  assert.match(guard, /new\.status = 'closed' and old\.status = 'joined'[\s\S]*not exists\(select 1 from private\.fair_dice_requests/);
  const close = definition('close_fair_dice_waiting_room');
  assert.match(close, /actor := private\.fair_dice_actor\(target\)/);
  assert.match(close, /actor->>'ownsHost'/);
  assert.match(close, /target\.status <> 'waiting'/);
  assert.match(close, /private\.fair_dice_clean_initial_state\(target\.game_state, target\.variant\)/);
  assert.match(close, /exists\(select 1 from private\.fair_dice_requests where room_id = target\.id\)/);
  assert.doesNotMatch(close, /delete from/);
});

test('administrative deletion retains proof receipts while direct active-room deletion is blocked', () => {
  assert.match(SOURCE, /foreign key\(room_id\) references public\.rooms\(id\) on delete set null/);
  assert.match(SOURCE, /alter column room_id drop not null/);
  const deletion = definition('guard_fair_dice_room_deletion');
  assert.match(deletion, /public\.is_admin_user\(\)/);
  assert.match(deletion, /old\.status not in \('over', 'closed'\)/);
  assert.match(deletion, /exists\(select 1 from private\.fair_dice_requests where room_id = old\.id\)/);
  assert.match(deletion, /set cancelled_at = clock_timestamp\(\)/);
  assert.doesNotMatch(deletion, /delete from private\.fair_dice_requests|set proof = null/i);
});

test('migration is transactional and reloads PostgREST without touching bot strategy or account credentials', () => {
  assert.match(SOURCE, /^begin;/);
  assert.match(SOURCE, /notify pgrst, 'reload schema';\ncommit;/);
  assert.doesNotMatch(SOURCE, /password\s*=|auth\.users|long_bot|bot_experience|strategy_weights|nardy-worker/i);
});
