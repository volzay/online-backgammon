'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const sql = read('supabase/long-bot-causal-archive-index-v40.sql');
const claim = sql.slice(sql.indexOf('create or replace function public.claim_long_bot_causal_review_jobs('));

test('v40 keeps an atomic private source index, never an advice or evidence cache', () => {
  assert.match(sql, /lock table public\.bot_training_games in share row exclusive mode/);
  assert.match(sql, /training_game_id uuid primary key references public\.bot_training_games\(id\) on delete cascade/);
  assert.match(sql, /alter table private\.long_bot_causal_archive_index enable row level security/);
  assert.match(sql, /revoke all on private\.long_bot_causal_archive_index from public, anon, authenticated, service_role/);
  assert.match(sql, /after insert or update on public\.bot_training_games/);
  assert.match(sql, /private\.long_bot_causal_archive_fingerprint\(new\)/);
  assert.match(sql, /private\.long_bot_causal_archive_is_eligible\(new\)/);
  assert.doesNotMatch(sql, /insert into private\.long_bot_causal_evidence|update private\.long_bot_causal_runtime/);
});

test('v40 bounds expensive validation to selected locked sources and keeps v39 fairness', () => {
  assert.equal((claim.match(/join private\.long_bot_causal_archive_index snapshot/g) || []).length, 3);
  assert.doesNotMatch(claim, /long_bot_causal_archive_(?:fingerprint|is_eligible)\(archived\)/);
  assert.match(claim, /queued\.archive_fingerprint = private\.long_bot_causal_archive_fingerprint\(game\)/);
  assert.match(claim, /and private\.long_bot_causal_archive_is_eligible\(game\)/);
  assert.equal((claim.match(/for share of archived skip locked/g) || []).length, 3);
  assert.equal((claim.match(/for update of queued skip locked/g) || []).length, 2);
  const old = read('supabase/long-bot-causal-fair-claim-v39.sql');
  const start = '    -- A timed-out terminal cohort yields';
  const end = '    -- One bounded game per claim.';
  assert.equal(claim.slice(claim.indexOf(start), claim.indexOf(end)),
    old.slice(old.indexOf(start), old.indexOf(end)));
  assert.match(claim, /explicitly approved active worker runtime/);
  assert.match(claim, /'archiveFingerprintSource', private\.long_bot_causal_archive_payload\(game\)::text/);
});

test('fresh schema retains the exact v40 migration after historical v39', () => {
  const schema = read('supabase/schema.sql');
  const marker = '-- v40 indexed causal archive identity: bounded claims without relaxing proof.\n';
  assert.ok(schema.indexOf(marker) > schema.indexOf('-- v39 fair causal claim scheduling:'));
  const next = '-- v41 publish independently complete decision lessons at their durable checkpoint.\n';
  assert.equal(schema.slice(schema.indexOf(marker) + marker.length, schema.indexOf(next)).trim(), sql.trim());
});

test('v40 rollback smoke checks source repairs, recovery, invalidation and deletion', () => {
  const smoke = read('supabase/tests/long-bot-causal-archive-index-v40-rollback-smoke.sql');
  for (const message of ['Source index was not populated', 'Repair did not refresh source index',
    'Missing-job recovery failed', 'Incomplete source remained eligible',
    'Stale index bypassed locked validation', 'Deleted source left an index row']) {
    assert.ok(smoke.includes(message));
  }
  assert.match(smoke, /\nrollback;\s*$/);
});
