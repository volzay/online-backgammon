const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'supabase/long-bot-causal-learning-v35.sql'), 'utf8');
function body(name) {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, `Missing function ${name}`);
  const end = sql.indexOf('\n$$;', start);
  assert.ok(end > start, `Missing body delimiter ${name}`);
  return sql.slice(start, end);
}

test('fresh schema and idempotent causal migration share the exact release contract', () => {
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const marker = '-- v35 trusted causal learning: independent worker, never browser-labelled regret.\n';
  const actual = schema.slice(schema.indexOf(marker) + marker.length,
    schema.indexOf('-- v35 resumable causal queue: durable terminal cohorts, never partial evidence.')).trim();
  assert.equal(actual, sql.replace(/^begin;\s*/, '').replace(/\s*commit;\s*$/, '').trim());
});

test('release approval is immutable and original historical identities cannot be relabelled', () => {
  assert.match(sql, /create table if not exists private\.long_bot_causal_releases/);
  assert.match(body('private.reject_long_bot_causal_release_rebinding'), /old\.policy_implementation_id is distinct from new\.policy_implementation_id/);
  const activate = body('public.activate_long_bot_causal_release');
  assert.match(activate, /evidence\.payload->>'policyImplementationId' is distinct from p_policy_implementation_id/);
  assert.match(activate, /historical\.result->>'policyImplementationId' is distinct from p_policy_implementation_id/);
  assert.match(activate, /on conflict \(runtime_digest\) do nothing/);
  assert.match(activate, /release\.policy_implementation_id is distinct from p_policy_implementation_id/);
  assert.match(activate, /explicitly_approved = true/);
  assert.match(activate, /perform private\.enqueue_long_bot_causal_release\(p_runtime_digest\)/);
});

test('claim requires native own runtime before any sweep, lease or attempt mutation', () => {
  assert.match(sql, /drop function if exists public\.claim_long_bot_causal_review_jobs\(text, integer\)/);
  const claim = body('public.claim_long_bot_causal_review_jobs');
  assert.match(claim, /p_limit integer,\s+p_runtime_digest text\s*\)/);
  assert.doesNotMatch(claim.slice(0, claim.indexOf('returns jsonb')), /default/i);
  const gate = claim.indexOf("raise exception 'Claim requires the explicitly approved active worker runtime.'");
  assert.ok(gate > 0 && gate < claim.indexOf('update private.long_bot_causal_review_jobs'));
  assert.match(claim, /p_runtime_digest is distinct from active\.runtime_digest/);
  assert.match(claim, /queued\.runtime_digest = active\.runtime_digest/);
  assert.match(claim, /queued\.archive_fingerprint = private\.long_bot_causal_archive_fingerprint\(archived\)/);
  assert.match(claim, /for update of queued skip locked/);
  assert.match(claim, /limit 1/);
  for (const key of ['runtimeDigest', 'policyImplementationId', 'archiveFingerprint', 'archiveFingerprintSource']) assert.match(claim, new RegExp(`'${key}',`));
  assert.match(claim, /'trainingGame', private\.long_bot_causal_archive_payload\(game\)/);
  assert.match(sql, /grant execute on function public\.claim_long_bot_causal_review_jobs\(text, integer, text\) to service_role/);
  assert.doesNotMatch(sql, /grant execute on function public\.claim_long_bot_causal_review_jobs\(text, integer\)/);
});

test('completion fails closed without explicit active approval, including rejected no-op results', () => {
  const complete = body('public.complete_long_bot_causal_review_job');
  assert.doesNotMatch(complete, /insert into private\.long_bot_causal_runtime/);
  assert.match(complete, /configured\.singleton and configured\.explicitly_approved/);
  assert.match(complete, /job\.runtime_digest is distinct from active\.runtime_digest/);
  assert.match(complete, /p_result->>'archiveFingerprint' is distinct from job\.archive_fingerprint/);
  assert.match(complete, /job\.archive_fingerprint is distinct from private\.long_bot_causal_archive_fingerprint\(game\)/);
  assert.ok(complete.indexOf("raise exception 'Explicitly approve") < complete.indexOf("if p_result->'accepted' <>"));
  assert.match(complete, /evidence->>'schema' is distinct from 'long-server-causal-evidence-v1'/);
  assert.match(complete, /evidence->>'policyImplementationId' is distinct from active\.policy_implementation_id/);
  assert.match(complete, /evidence->>'evidenceId', job\.archive_fingerprint/);
});

test('claim, expired-lease sweep and completion lock active approval then archive then job', () => {
  const claim = body('public.claim_long_bot_causal_review_jobs');
  const activeLock = claim.indexOf('for share of configured, release;');
  const archiveLocks = [...claim.matchAll(/for share of archived skip locked/g)].map(match => match.index);
  const jobLocks = [...claim.matchAll(/for update of queued skip locked/g)].map(match => match.index);
  assert.equal(archiveLocks.length, 3, 'recovery, sweep and claim each acquire archive first');
  assert.equal(jobLocks.length, 2, 'sweep and claim each recheck and lock their job');
  assert.ok(activeLock < archiveLocks[0]);
  for (let index = 0; index < 2; index += 1) assert.ok(archiveLocks[index + 1] < jobLocks[index]);
  assert.ok(jobLocks[0] < archiveLocks[2]);
  assert.doesNotMatch(claim, /where archived\.id = job\.training_game_id for share/);
  assert.match(claim, /if not found then\s+continue;/);
  const complete = body('public.complete_long_bot_causal_review_job');
  const identityRead = complete.indexOf('select queued.training_game_id into archive_id');
  const archiveLock = complete.indexOf('where archived.id = archive_id for share;');
  const jobLock = complete.indexOf('where queued.id = p_job_id for update;');
  assert.ok(complete.indexOf('for share of configured, release;') < identityRead);
  assert.ok(identityRead < archiveLock && archiveLock < jobLock);
  assert.match(complete, /job\.training_game_id is distinct from game\.id/);
  assert.ok(jobLock < complete.indexOf("raise exception 'Training archive changed"));
  const enqueue = body('private.enqueue_long_bot_causal_review');
  assert.doesNotMatch(enqueue, /for share|for update/, 'archive repair must not wait on active approval while holding archive');
  const activate = body('public.activate_long_bot_causal_release');
  assert.ok(activate.indexOf('insert into private.long_bot_causal_runtime') < activate.indexOf('perform private.enqueue_long_bot_causal_release'));
});

test('approved native claim heals activation/archive races in bounded archive-first housekeeping', () => {
  const claim = body('public.claim_long_bot_causal_review_jobs');
  const gate = claim.indexOf("raise exception 'Claim requires");
  const archiveLock = claim.indexOf('for share of archived skip locked');
  const insert = claim.indexOf('insert into private.long_bot_causal_review_jobs');
  const firstJobLock = claim.indexOf('for update of queued skip locked');
  assert.ok(gate < archiveLock && archiveLock < insert && insert < firstJobLock);
  const recovery = claim.slice(gate, insert);
  assert.match(recovery, /private\.long_bot_causal_archive_is_eligible\(archived\)/);
  assert.match(recovery, /not exists[\s\S]*queued\.runtime_digest = active\.runtime_digest[\s\S]*queued\.archive_fingerprint = private\.long_bot_causal_archive_fingerprint\(archived\)/);
  assert.match(recovery, /order by archived\.id\s+limit 16/);
  assert.doesNotMatch(recovery, /queued\.(?:status|attempts)/, 'completed/rejected native identities must not be treated as missing');
  assert.match(claim.slice(insert, firstJobLock), /on conflict \(training_game_id, runtime_digest, archive_fingerprint\) do nothing/);
  assert.doesNotMatch(claim.slice(insert, claim.indexOf('-- The third crashed worker')), /do update|result =|attempts =/);
});

test('releases and repaired archive revisions append separate jobs and evidence without resetting history', () => {
  assert.match(sql, /long_bot_causal_review_jobs\(training_game_id, runtime_digest, archive_fingerprint\)/);
  assert.match(sql, /long_bot_causal_evidence\(training_game_id, decision_id, runtime_digest, archive_fingerprint\)/);
  assert.match(sql, /long_bot_causal_evidence\(evidence_id, archive_fingerprint\)/);
  assert.match(sql, /drop constraint if exists long_bot_causal_review_jobs_training_game_id_key/);
  assert.match(sql, /drop constraint if exists long_bot_causal_evidence_training_game_id_decision_id_key/);
  assert.doesNotMatch(body('private.enqueue_long_bot_causal_review'), /delete from|result = null|attempts = 0/);
  assert.match(body('private.enqueue_long_bot_causal_review'), /set invalidated_at = pg_catalog\.now\(\)/);
  assert.match(body('private.enqueue_long_bot_causal_review'), /archive_fingerprint is distinct from fingerprint/);
  assert.match(body('private.enqueue_long_bot_causal_review'), /set invalidated_at = null/);
  assert.doesNotMatch(sql, /update private\.long_bot_causal_(?:review_jobs|evidence)\s+set (?:runtime_digest|archive_fingerprint)/);
});

test('patterns bind original stored policy SHA to registry and active release and count positions once', () => {
  const patterns = body('public.get_long_bot_experience_patterns');
  assert.match(patterns, /evidence\.payload->>'policyImplementationId' as policy_implementation_id/);
  assert.match(patterns, /active\.policy_implementation_id = evidence\.payload->>'policyImplementationId'/);
  assert.match(patterns, /release\.policy_implementation_id = evidence\.payload->>'policyImplementationId'/);
  assert.match(patterns, /active\.explicitly_approved/);
  assert.match(patterns, /evidence\.archive_fingerprint = private\.long_bot_causal_archive_fingerprint\(archived\)/);
  assert.match(patterns, /least\(32, count\(distinct evidence\.state_id\)\)/);
  assert.doesNotMatch(patterns, /count\(distinct evidence\.evidence_id\)|active\.policy_implementation_id as policy_implementation_id/);
  assert.doesNotMatch(sql, /compute_long_bot_experience_patterns/);
});

test('archive fingerprint uses the exact returned authoritative payload, not worker-owned fields', () => {
  const payload = body('private.long_bot_causal_archive_payload');
  for (const key of ['id', 'room_code', 'engine_version', 'difficulty', 'bot_color', 'winner', 'decisions', 'final_state']) assert.match(payload, new RegExp(`'${key}', p_game\\.${key}`));
  assert.match(body('private.long_bot_causal_archive_fingerprint'), /private\.long_bot_causal_archive_payload\(p_game\)::text, 'UTF8'/);
  assert.match(body('public.claim_long_bot_causal_review_jobs'), /'archiveFingerprintSource', private\.long_bot_causal_archive_payload\(game\)::text/);
});

test('release registry and archive helpers remain private service-role RPC only', () => {
  assert.match(sql, /alter table private\.long_bot_causal_releases enable row level security/);
  assert.match(sql, /revoke all on private\.long_bot_causal_releases from public, anon, authenticated, service_role/);
  assert.doesNotMatch(sql, /grant (?:all|select|insert|update|delete) on private\.long_bot_causal/);
  assert.match(sql, /revoke all on function private\.long_bot_causal_archive_payload\(public\.bot_training_games\)/);
});

test('rollback smoke is synthetic and covers cold-review, stale claims, revision preservation and deduplication', () => {
  const fixture = fs.readFileSync(path.join(root, 'supabase/tests/long-bot-causal-release-v35-rollback-smoke.sql'), 'utf8');
  assert.match(fixture, /\nbegin;\s*\n/);
  assert.match(fixture, /\nrollback;\s*$/);
  assert.doesNotMatch(fixture, /\bcommit;|(?:insert into|update|delete from) public\.(?:rooms|profiles|rating_events)/i);
  assert.match(fixture, /NULL runtime claimed work/);
  assert.match(fixture, /Old worker consumed a cold-review job for new digest/);
  assert.match(fixture, /New release rewrote\/deleted original job or evidence/);
  assert.match(fixture, /rollback-decision-duplicate/);
  assert.match(fixture, /p->>'samples' = '1'/);
  assert.match(fixture, /runtime_digest is null\s+and archive_fingerprint is null and result = legacy_result/);
  assert.match(fixture, /Archive-before-job lock ordering is absent/);
  assert.match(fixture, /Native claim did not recover missing current-release\/source job/);
});
