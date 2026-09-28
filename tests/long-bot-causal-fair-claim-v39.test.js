'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const oldSql = read('supabase/long-bot-causal-learning-v35.sql');
const migration = read('supabase/long-bot-causal-fair-claim-v39.sql');
const schema = read('supabase/schema.sql');

function claimBody(sql, last = false) {
  const name = 'create or replace function public.claim_long_bot_causal_review_jobs(';
  const start = last ? sql.lastIndexOf(name) : sql.indexOf(name);
  assert.ok(start >= 0, 'claim RPC must exist');
  const end = sql.indexOf('\n$$;', start);
  assert.ok(end > start, 'claim RPC must have a complete body');
  return sql.slice(start, end + '\n$$;'.length);
}

test('v39 changes only claim order, retaining release gates, archive locks, lease and envelope', () => {
  const oldClaim = claimBody(oldSql);
  const newClaim = claimBody(migration);
  const start = newClaim.indexOf('    -- A timed-out terminal cohort yields');
  const end = newClaim.indexOf('    -- One bounded game per claim.', start);
  assert.ok(start > 0 && end > start);
  assert.equal(newClaim.slice(0, start) + '    order by queued.id\n' + newClaim.slice(end), oldClaim);

  const scheduling = newClaim.slice(start, end);
  assert.match(scheduling, /rollout-time-limit'[\s\S]*interval '30 minutes' then 0/);
  assert.match(scheduling, /is distinct from 'rollout-time-limit' then 1/);
  assert.match(scheduling, /queued\.result is null then 2/);
  assert.match(scheduling, /archived\.decision_count/);
  assert.match(scheduling, /requiredTerminalOutcomes/);
  assert.match(scheduling, /currentTerminalOutcomes/);
  assert.match(scheduling, /public\.long_bot_safe_numeric/);
  assert.doesNotMatch(scheduling.replace(/^\s*--.*$/gm, ''),
    /winner|regret|evidence|selectedAction|recommendedAction/i);
  assert.equal((newClaim.match(/for share of archived skip locked/g) || []).length, 3);
  assert.equal((newClaim.match(/for update of queued skip locked/g) || []).length, 2);
  assert.match(migration, /revoke all on function public\.claim_long_bot_causal_review_jobs\(text, integer, text\)[\s\S]*grant execute on function public\.claim_long_bot_causal_review_jobs\(text, integer, text\) to service_role/);
  assert.doesNotMatch(migration, /create or replace function public\.checkpoint_long_bot_causal_review_slice|alter table|update private\.long_bot_causal_runtime/);
});

test('fresh schema applies the exact v39 migration after v36 without rewriting its historical contracts', () => {
  const marker = '-- v39 fair causal claim scheduling: preserve proof and per-ply progress.\n';
  assert.ok(schema.includes(marker));
  assert.equal(schema.slice(schema.indexOf(marker) + marker.length).trim(), migration.trim());
  assert.equal(claimBody(schema, true), claimBody(migration));
});

test('v39 rollback smoke exercises locality, fairness, source identity and privilege gates', () => {
  const smoke = read('supabase/tests/long-bot-causal-fair-claim-v39-rollback-smoke.sql');
  assert.match(smoke, /^-- Synthetic queue-order test[\s\S]*\nbegin;\n/);
  assert.match(smoke, /private\.long_bot_causal_validate_progress/);
  assert.match(smoke, /Cheap claim lost locality/);
  assert.match(smoke, /Partial head-of-line job prevented a finished diagnostic continuation/);
  assert.match(smoke, /Short recent terminal cohort was not prioritized/);
  assert.match(smoke, /Aged partial cohort starved/);
  assert.match(smoke, /Short fresh game did not outrank/);
  assert.match(smoke, /Claim ignored the archived-source fingerprint gate/);
  assert.match(smoke, /Anonymous claim was accepted/);
  assert.match(smoke, /Stale runtime claim was accepted/);
  assert.match(smoke, /Scheduling created evidence/);
  assert.match(smoke, /\nrollback;\s*$/);
});
