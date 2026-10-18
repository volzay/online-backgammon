'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const sql = read('supabase/long-bot-causal-incremental-evidence-v41.sql');

test('v41 inserts only after the unmodified authenticated v36 checkpoint succeeds', () => {
  const wrapper = sql.slice(sql.indexOf('create or replace function public.checkpoint_long_bot_causal_review_slice('));
  const checkpoint = wrapper.indexOf('receipt := private.checkpoint_long_bot_causal_review_slice_v36(');
  const publish = wrapper.indexOf('inserted_count := private.insert_long_bot_causal_finished_evidence(');
  assert.ok(checkpoint >= 0 && checkpoint < publish);
  assert.match(wrapper.slice(checkpoint, publish), /receipt->>'status' <> 'pending'/);
  assert.match(wrapper.slice(checkpoint, publish), /'status' is distinct from 'confirmed-regret'/);
  assert.match(wrapper.slice(checkpoint, publish), /exact persisted complete review/);
  assert.match(wrapper.slice(checkpoint, publish), /private\.long_bot_causal_validate_finished_review\(/);
  assert.match(wrapper.slice(checkpoint, publish), /private\.long_bot_causal_progress_evidence\(job\.progress\)/);
  assert.doesNotMatch(wrapper, /update private\.|insert into private\.long_bot_causal_review_jobs|activate_long_bot/);
});

test('v41 retains every original evidence validator and insertion check byte for byte', () => {
  const original = read('supabase/long-bot-causal-learning-v35.sql');
  const start = "  for evidence in select item from jsonb_array_elements(p_result->'evidence') item\n  loop";
  const originalLoop = original.slice(original.indexOf(start), original.indexOf('\n  update private.long_bot_causal_review_jobs\n  set status = \'complete\'', original.indexOf(start)));
  const newLoop = sql.slice(sql.indexOf(start), sql.indexOf('\n  return inserted_count;', sql.indexOf(start)));
  assert.ok(originalLoop.length > 5000);
  assert.equal(newLoop, originalLoop);
});

test('v41 keeps private helpers unreachable to all client and worker roles', () => {
  assert.match(sql, /revoke all on function private\.checkpoint_long_bot_causal_review_slice_v36\(bigint,text,jsonb,jsonb\)\nfrom public, anon, authenticated, service_role/);
  assert.match(sql, /private\.long_bot_causal_runtime, jsonb\)\nfrom public, anon, authenticated, service_role/);
  assert.match(sql, /grant execute on function public\.checkpoint_long_bot_causal_review_slice\(bigint,text,jsonb,jsonb\) to service_role/);
  assert.doesNotMatch(sql, /update private\.long_bot_causal_runtime|update private\.long_bot_causal_review_jobs|delete from|truncate /i);
});

test('fresh schema appends exact v41 without rewriting original checkpoint or source-index migrations', () => {
  const schema = read('supabase/schema.sql');
  const marker = '-- v41 publish independently complete decision lessons at their durable checkpoint.\n';
  assert.ok(schema.indexOf(marker) > schema.indexOf('-- v40 indexed causal archive identity:'));
  assert.equal(schema.slice(schema.indexOf(marker) + marker.length).trim(), sql.trim());
});

test('v41 rollback smoke proves publication, atomic failure, deduplication and source quarantine', () => {
  const smoke = read('supabase/tests/long-bot-causal-incremental-evidence-v41-rollback-smoke.sql');
  for (const message of ['Incremental private helpers leaked', 'Untrusted incremental checkpoint accepted',
    'Failed publication changed the checkpoint or evidence',
    'Complete decision lesson was withheld until the whole game',
    'Incremental lesson is absent from the public aggregate',
    'Incremental publication bypassed whole-ledger completion',
    'Whole-game completion duplicated incremental evidence',
    'Source repair did not quarantine incremental evidence']) assert.ok(smoke.includes(message));
  assert.match(smoke, /Synthetic RPC contract fixtures ONLY/);
  assert.match(smoke, /\nrollback;\s*$/);
});
