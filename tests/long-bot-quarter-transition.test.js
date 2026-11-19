'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const builder = require('../scripts/build-long-bot-engine');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/long-bot-quarter-experience-transition.sql'), 'utf8');
const activation = fs.readFileSync(path.join(root, 'ops/timeweb/activate-quarter-experience.sql'), 'utf8');
const statements = text => text.replace(/^\s*--.*$/gm, '');
const lookup = '  select * into active from private.long_bot_causal_serving_runtime()\n'
  + '  where singleton and explicitly_approved and policy_implementation_id = p_policy_implementation_id;\n'
  + '  if active.runtime_digest is null then return null; end if;\n\n';
const nestedLookup = lookup.split(/(?<=\n)/).map(line => line.trim() ? `  ${line}` : line).join('');
const originalSignedLoaderSha256 = 'c6c784dcb8a24552a3cf08f94761a1725dc49b0ef93a16c28358d76e8f475ef4';

function loaderWithPermissions() {
  const start = migration.indexOf('create or replace function public.load_signed_long_bot_experience(');
  const end = migration.indexOf('\ncommit;', start);
  assert.ok(start >= 0 && end > start);
  return `${migration.slice(start, end).trim()}\n`;
}

test('signed transition changes only the location of the existing serving-policy guard', () => {
  const modified = loaderWithPermissions();
  const anchor = '  if sealed.room_id is null then\n';
  assert.equal(modified.split(nestedLookup).length - 1, 1);
  assert.ok(modified.includes(`${anchor}${nestedLookup}`));
  const restored = modified.replace(nestedLookup, '').replace(
    '  -- Serialize first issuance against a move, a room change or finalization.\n',
    `${lookup}  -- Serialize first issuance against a move, a room change or finalization.\n`,
  );
  assert.equal(createHash('sha256').update(restored).digest('hex'), originalSignedLoaderSha256,
    'ownership, authorization, signing, limits and signature validation must retain the installed v68 definition');
});

test('same-round issued snapshots remain authenticated without requiring the former policy to serve', () => {
  const loader = loaderWithPermissions();
  const roomLookup = loader.indexOf('select r.* into room from public.rooms r');
  const sealedLookup = loader.indexOf('select x.* into sealed from private.long_bot_signed_experience_snapshots x');
  const issueBranch = loader.indexOf('if sealed.room_id is null then');
  const servingLookup = loader.indexOf('select * into active from private.long_bot_causal_serving_runtime()');
  assert.ok(loader.indexOf("coalesce(auth.role(), '') <> 'authenticated'") < roomLookup);
  assert.ok(roomLookup < sealedLookup && sealedLookup < issueBranch && issueBranch < servingLookup);
  assert.match(loader, /x\.room_id = room\.id and x\.owner_id = request_owner/);
  assert.match(loader, /x\.round_started_at = p_round_started_at and x\.policy_implementation_id = p_policy_implementation_id/);
  assert.match(loader, /if sealed\.room_id is null or not private\.long_bot_signed_experience_is_valid\(sealed\) then/);
  assert.match(loader, /grant execute on function public\.load_signed_long_bot_experience\(text,text,bigint\) to authenticated/);
});

test('new snapshots still require the current policy and an untouched opening', () => {
  const loader = loaderWithPermissions();
  const issueBranch = loader.slice(loader.indexOf('if sealed.room_id is null then'));
  assert.ok(issueBranch.indexOf('if active.runtime_digest is null then return null; end if;')
    < issueBranch.indexOf("room.game_state->>'phase' is distinct from 'opening'"));
  assert.match(issueBranch, /policy_implementation_id = p_policy_implementation_id/);
  assert.match(issueBranch, /coalesce\(room\.game_state->'history', '\[\]'::jsonb\) <> '\[\]'::jsonb/);
  assert.match(issueBranch, /coalesce\(room\.game_state->'turnMoves', '\[\]'::jsonb\) <> '\[\]'::jsonb/);
  assert.match(issueBranch, /room\.game_state->>'winner' is not null/);
  assert.match(issueBranch, /jsonb_array_length\(lessons\) > 256/);
  assert.match(issueBranch, /octet_length\(lessons::text\) > 524288/);
  assert.match(issueBranch, /extensions\.hmac\(payload, key\.secret, 'sha256'\)/);
});

test('transition never rewrites old snapshots, evidence, archives, jobs or signing keys', () => {
  const sql = statements(migration);
  assert.equal((sql.match(/create or replace function/gi) || []).length, 1);
  assert.doesNotMatch(sql, /\b(?:delete|truncate|alter table|update|drop|create table)\b/i);
  assert.equal((sql.match(/insert into/gi) || []).length, 1,
    'the only insertion is the unchanged first-issuance path inside the signed loader');
  assert.match(sql, /insert into private\.long_bot_signed_experience_snapshots/);
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
});

test('activation pins both policies and admits only a new immutable future runtime', () => {
  const sql = statements(activation);
  assert.match(sql, /old_policy constant text := '91355600fc8e60029a6093941996c462a73785ba6ffc90318ec4b596de4e7dac'/);
  assert.match(sql, new RegExp(`new_policy constant text := '${builder.policyImplementationId()}'`));
  assert.match(sql, /:'new_runtime_digest'/);
  assert.match(sql, /exists \(select 1 from private\.long_bot_causal_releases where runtime_digest = new_digest\)/);
  assert.match(sql, /insert into private\.long_bot_causal_warm_review_releases/);
  assert.match(sql, /new_digest, new_policy, old_serving\.reviewer_version, true, false, cutover_at, null, true/);
  assert.match(sql, /cutover_at := pg_catalog\.clock_timestamp\(\)/);
  assert.doesNotMatch(sql, /\bperform\b|enqueue_long_bot_causal_release|\b(?:delete|truncate|create or replace|drop)\b/i);
});

test('activation blocks active old rooms and preserves closed admission and enabled predecessors', () => {
  const sql = statements(activation);
  assert.match(sql, /lock table public\.rooms in share mode/);
  assert.match(sql, /r\.variant = 'long' and r\.status = 'joined'/);
  assert.match(sql, /r\.game_state->>'mode' = 'bot' and r\.game_state->>'botDifficulty' = 'hard'/);
  assert.match(sql, /r\.game_state->>'winner' is null/);
  assert.match(sql, /set accept_completed_before = cutover_at\s+where enabled and policy_implementation_id = old_policy and accept_completed_before is null/);
  assert.match(sql, /set serves_patterns = false where runtime_digest = old_serving\.runtime_digest/);
  assert.doesNotMatch(sql, /set\s+enabled\s*=/i);
});

test('zero existing lessons is checked again instead of replacing nonempty experience by empty', () => {
  const sql = statements(activation);
  const emptyGate = sql.indexOf('if published_count_before <> 0 then');
  const register = sql.indexOf('insert into private.long_bot_causal_releases');
  assert.ok(emptyGate >= 0 && emptyGate < register);
  assert.match(sql, /jsonb_typeof\(published_before\) is distinct from 'array'/);
  assert.match(sql, /jsonb_array_length\(public\.get_long_bot_experience_patterns\(null\)\) <> published_count_before/);
  for (const table of ['public.bot_training_games', 'private.long_bot_causal_review_jobs',
    'private.long_bot_causal_evidence', 'private.long_bot_signed_experience_snapshots',
    'private.long_bot_causal_experience_sources']) {
    assert.doesNotMatch(sql, new RegExp(`(?:insert into|update|delete from)\\s+${table.replaceAll('.', '\\.')}`, 'i'));
  }
  assert.match(sql, /signing_key_hash_after is distinct from signing_key_hash_before/);
  assert.doesNotMatch(sql, /update\s+private\.long_bot_experience_signing_key/i);
});
