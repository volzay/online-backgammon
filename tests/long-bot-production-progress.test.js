'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LEGACY_PROGRESS_SCHEMA, PROGRESS_SCHEMA, productionDecisionIndexes, normalizeProductionProgress,
  validateProductionProgress, advanceProductionProgress,
  aggregateProductionResult, parseCli, runClaimedBatch, runtimeDigest,
  validateGameEnvelope, ENGINE_VERSION,
} = require('../scripts/long-bot-causal-worker');

const game = {
  id: 'synthetic-progression-only', bot_color: 'dark',
  decisions: [{ id: 'human', color: 'white' }, { id: 'bot-a', color: 'dark' },
    { id: 'human2', color: 'white' }, { id: 'bot-b', actor: 'bot' }],
};
const initial = () => ({ schema: PROGRESS_SCHEMA, finishedReviews: [], currentDecisionIndex: null,
  currentTerminalOutcomes: 0, currentRolloutCheckpoint: null, slices: 0, stalledSlices: 0 });
const checkpoint = (plies, overrides = {}) => ({ manifestId: 'a'.repeat(64), sampleIndex: 0,
  candidateIndex: 0, candidateId: 'b'.repeat(64), plies, checkpointHash: String(plies).padStart(64, 'c').slice(-64),
  stateHash: String(plies).padStart(64, 'd').slice(-64), ...overrides });
const review = (decisionId, count = null, activeCheckpoint = null) => ({ decisionId, positionId: 'synthetic-only',
  status: count === null ? 'no-regret' : 'rejected', reason: count === null ? '' : 'rollout-time-limit',
  outcomeUsed: false, evidence: null, rollout: { coverage: { complete: count === null },
    ...(count === null ? {} : { terminalJournalObservation: {
      completedTerminalOutcomes: count, activeCheckpoint,
    } }) } });

test('production progress cursor refers to original indexes, never a truncated ledger', () => {
  assert.deepEqual(productionDecisionIndexes(game), [1, 3]);
  assert.deepEqual(validateProductionProgress(game, initial()), { indexes: [1, 3], next: 1 });
  assert.throws(() => advanceProductionProgress(game, initial(), 0, review('human')), /next original/);
  assert.throws(() => advanceProductionProgress(game, initial(), 3, review('bot-b')), /next original/);
});

test('normal incomplete slices accumulate fixed terminal progress without finishing the decision', () => {
  const first = advanceProductionProgress(game, initial(), 1, review('bot-a', 12));
  assert.equal(first.currentDecisionIndex, 1);
  assert.equal(first.currentTerminalOutcomes, 12);
  assert.deepEqual(first.finishedReviews, []);
  const resumed = advanceProductionProgress(game, first, 1, review('bot-a', 29));
  assert.equal(resumed.currentTerminalOutcomes, 29);
  assert.equal(resumed.slices, 2);
  assert.equal(resumed.stalledSlices, 0);
  assert.throws(() => advanceProductionProgress(game, resumed, 1, review('bot-a', 28)), /monotonic/);
});

test('authenticated in-game checkpoint progress resets stalls without double-counting a terminal outcome', () => {
  const first = advanceProductionProgress(game, initial(), 1, review('bot-a', 0, checkpoint(7)));
  assert.equal(first.currentTerminalOutcomes, 0);
  assert.equal(first.currentRolloutCheckpoint.plies, 7);
  assert.equal(first.stalledSlices, 0);
  const stalled = advanceProductionProgress(game, first, 1, review('bot-a', 0, checkpoint(7)));
  assert.equal(stalled.stalledSlices, 1);
  const resumed = advanceProductionProgress(game, stalled, 1, review('bot-a', 0, checkpoint(19)));
  assert.equal(resumed.currentTerminalOutcomes, 0);
  assert.equal(resumed.currentRolloutCheckpoint.plies, 19);
  assert.equal(resumed.stalledSlices, 0);
  assert.throws(() => advanceProductionProgress(game, resumed, 1,
    review('bot-a', 0, checkpoint(20, { candidateId: 'e'.repeat(64) }))), /identity changed/);
  assert.throws(() => advanceProductionProgress(game, resumed, 1,
    review('bot-a', 0, checkpoint(18))), /regressed/);
  const endpoint = advanceProductionProgress(game, resumed, 1, review('bot-a', 1));
  assert.equal(endpoint.currentTerminalOutcomes, 1);
  assert.equal(endpoint.currentRolloutCheckpoint, null);
  assert.equal(endpoint.stalledSlices, 0);
});

test('legacy v1 progress is accepted only as a complete-endpoint boundary and normalized to v2', () => {
  const legacy = { schema: LEGACY_PROGRESS_SCHEMA, finishedReviews: [], currentDecisionIndex: 1,
    currentTerminalOutcomes: 12, slices: 3, stalledSlices: 2 };
  const normalized = normalizeProductionProgress(game, legacy);
  assert.equal(normalized.schema, PROGRESS_SCHEMA);
  assert.equal(normalized.currentRolloutCheckpoint, null);
  assert.equal(normalized.currentTerminalOutcomes, 12);
  assert.deepEqual(validateProductionProgress(game, legacy), { indexes: [1, 3], next: 1 });
  assert.throws(() => normalizeProductionProgress(game, { ...legacy, currentRolloutCheckpoint: checkpoint(1) }));
  assert.throws(() => normalizeProductionProgress(game, { ...legacy, schema: 'long-server-causal-progress-v0' }));
});

test('a stalled slice is bounded separately from successful progress', () => {
  let progress = initial();
  for (let index = 0; index < 10; index++) progress = advanceProductionProgress(game, progress, 1, review('bot-a', 0));
  assert.equal(progress.stalledSlices, 10);
  assert.throws(() => advanceProductionProgress(game, progress, 1, review('bot-a', 0)), /Malformed/);
  assert.equal(advanceProductionProgress(game, progress, 1, review('bot-a', 1)).stalledSlices, 0);
});

test('a completed review advances one original index and cannot mutate prior finished reviews', () => {
  const before = advanceProductionProgress(game, initial(), 1, review('bot-a', 29));
  const first = advanceProductionProgress(game, before, 1, review('bot-a'));
  assert.equal(first.currentDecisionIndex, 3);
  assert.equal(first.currentTerminalOutcomes, 0);
  assert.equal(first.finishedReviews.length, 1);
  const done = advanceProductionProgress(game, first, 3, review('bot-b'));
  assert.equal(done.currentDecisionIndex, null);
  assert.equal(done.finishedReviews.length, 2);
  assert.equal(done.stalledSlices, 0);
  done.finishedReviews[0].review.positionId = 'mutated-local-copy';
  assert.equal(first.finishedReviews[0].review.positionId, 'synthetic-only');
});

test('only the finished entire-ledger aggregate reaches full result coverage', () => {
  const partial = advanceProductionProgress(game, initial(), 1, review('bot-a'));
  const slice = { reviews: [review('bot-b')], evidence: [], reviewCoverage: { totalLedgerDecisions: 4,
    totalBotDecisions: 2, fullGameEnvelopeValidated: true, scope: 'server-resumable-index' } };
  assert.equal(aggregateProductionResult(game, slice, partial), slice);
  const done = advanceProductionProgress(game, partial, 3, review('bot-b'));
  const result = aggregateProductionResult(game, slice, done);
  assert.deepEqual(result.reviews.map(row => row.decisionId), ['bot-a', 'bot-b']);
  assert.deepEqual(result.reviewCoverage.finishedDecisionIndexes, [1, 3]);
  assert.equal(result.reviewCoverage.scope, 'all-bot-decisions');
  assert.equal(result.reviewCoverage.completedOutcomeCohorts, 2);
  assert.deepEqual(result.summary, { decisionsSeen: 4, botDecisionsSeen: 2,
    confirmedRegret: 0, noRegret: 2, diagnosticDisagreement: 0, rejected: 0, evidenceCount: 0 });
});

test('malformed, non-prefix or unfinished saved progress fails closed', () => {
  const valid = advanceProductionProgress(game, initial(), 1, review('bot-a'));
  for (const mutant of [
    { ...initial(), schema: 'legacy' }, { ...initial(), extra: true },
    { ...initial(), currentDecisionIndex: 3 }, { ...initial(), currentTerminalOutcomes: -1 },
    { ...initial(), currentTerminalOutcomes: 3073 }, { ...initial(), slices: 10241 },
    { ...initial(), currentRolloutCheckpoint: checkpoint(0) },
    { ...initial(), currentRolloutCheckpoint: checkpoint(600) },
    { ...valid, currentDecisionIndex: 1 },
    { ...valid, finishedReviews: [{ decisionIndex: 3, review: review('bot-b') }] },
    { ...valid, finishedReviews: [{ decisionIndex: 1, review: review('bot-a', 12) }] },
    { ...valid, finishedReviews: [{ decisionIndex: 1, review: { ...review('bot-a'), outcomeUsed: true } }] },
  ]) assert.throws(() => validateProductionProgress(game, mutant));
});

test('partial evidence, unknown journal counts and runtime failure cannot advance progress', () => {
  assert.throws(() => advanceProductionProgress(game, initial(), 1, { ...review('bot-a', 12), evidence: {} }));
  assert.throws(() => advanceProductionProgress(game, initial(), 1, { ...review('bot-a', 12), rollout: {} }));
  assert.throws(() => advanceProductionProgress(game, initial(), 1, { ...review('bot-a'), reason: 'rollout-runtime-failed',
    detail: 'terminal-journal-lock-fence-lost' }), /Native rollout failed/);
});

test('native selector types reject falsy malformed telemetry before costly replay', () => {
  const envelope = { ...game, engine_version: ENGINE_VERSION, difficulty: 'hard', winner: 'white',
    final_state: { variant: 'long' } };
  for (const key of ['color', 'actor']) for (const value of [false, 0, null, [], {}]) {
    assert.equal(validateGameEnvelope({ ...envelope, decisions: [{ id: 'bad', [key]: value }] }), 'decision-selector-invalid');
  }
});

test('production CLI cannot be combined with offline authority or output paths', () => {
  assert.equal(parseCli(['--once', '--production-journal-dir', '/var/lib/nardy/terminal-journal']).productionJournalDirectory,
    '/var/lib/nardy/terminal-journal');
  for (const argv of [
    ['--production-journal-dir', '/var/lib/nardy/terminal-journal'],
    ['--once', '--production-journal-dir', 'relative'],
    ['--once', '--production-journal-dir', '/var/lib/nardy/../terminal-journal'],
    ['--once', '--production-journal-dir', '/var/lib/nardy/terminal-journal', '--input', 'client.json'],
    ['--once', '--production-journal-dir', '/var/lib/nardy/terminal-journal', '--output', 'client.json'],
  ]) assert.throws(() => parseCli(argv));
});

test('injected offline adapters are rejected before any production fence or RPC', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = () => { calls++; throw new Error('must not call'); };
  try {
    for (const key of ['runtime', 'outcomeRunner', 'pairedOutcomeGenerator', 'shadowReplayGenerator',
      'archivedSelectionReplay', 'gamePath', 'runtimePath', 'rolloutLimits', 'shadowLimits', 'limits',
      'trustedTrainingPolicy', 'trustedOfflineTerminalJournal', 'terminalJournalBindings', 'reviewDecisionIndexes']) {
      await assert.rejects(runClaimedBatch({ productionJournalDirectory: '/var/lib/nardy/terminal-journal',
        [key]: {} }), /unmodified native server policy/);
    }
    assert.equal(calls, 0);
  } finally { global.fetch = originalFetch; }
});

test('production orchestration binds PostgreSQL archive bytes and fences every RPC', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/long-bot-causal-worker.js'), 'utf8');
  const body = source.slice(source.indexOf('async function runResumableClaimedBatch'), source.indexOf('async function runClaimedBatch'));
  assert.equal((body.match(/supabaseRpc\(/g) || []).length, 1, 'all mutations use the one kernel-fenced helper');
  assert.match(body, /const fencedRpc = \(name, args\) => \{\s*fence\.assertHeld\(\);\s*return supabaseRpc/);
  assert.match(source, /authoritativeArchivePayloadText: scope\.archiveFingerprintSource/);
  assert.match(source, /VERIFIED_SCOPES\.add\(scope\)/);
  assert.match(body, /checkpoint_long_bot_causal_review_slice/);
  assert.match(body, /recoverStaleWriterLocks/);
  assert.equal(runtimeDigest().length, 64);
});

test('fresh schema includes the exact separately versioned resumable migration', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/long-bot-causal-resume-v35.sql'), 'utf8');
  const marker = '-- v35 resumable causal queue: durable terminal cohorts, never partial evidence.\n';
  const next = '-- v36 per-ply authenticated causal rollout checkpoint.\n';
  assert.equal(schema.slice(schema.indexOf(marker) + marker.length, schema.indexOf(next)).trim(),
    migration.replace(/^begin;\s*/, '').replace(/\s*commit;\s*$/, '').trim());
});

test('v36 SQL upgrades only stopped v1 endpoint boundaries and authenticates per-ply progress', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname,
    '../supabase/long-bot-causal-ply-checkpoint-v36.sql'), 'utf8');
  const marker = '-- v36 per-ply authenticated causal rollout checkpoint.\n';
  assert.equal(schema.slice(schema.indexOf(marker) + marker.length,
    schema.lastIndexOf("notify pgrst, 'reload schema';")).trim(),
  migration.trim());
  assert.match(migration, /lock table private\.long_bot_causal_review_jobs in share row exclusive mode/);
  assert.match(migration, /status = 'leased'[\s\S]*Stop the causal worker/);
  assert.ok(migration.indexOf('perform private.long_bot_causal_validate_progress(archived, queued.progress)')
    < migration.indexOf("'schema', 'long-server-causal-progress-v2'"));
  assert.match(migration, /currentRolloutCheckpoint[^\n]+null/);
  assert.match(migration, /create or replace function private\.long_bot_causal_valid_rollout_checkpoint/);
  for (const field of ['manifestId', 'sampleIndex', 'candidateIndex', 'candidateId', 'plies',
    'checkpointHash', 'stateHash']) assert.match(migration, new RegExp(field));
  assert.match(migration, /p_progress->'currentRolloutCheckpoint' is distinct from new_checkpoint/);
  assert.match(migration, /checkpoint_advanced := \(new_checkpoint->>'plies'\)::integer >/);
  assert.match(migration, /terminal_count > old_terminal_count or checkpoint_advanced/);
  assert.match(migration, /Active rollout checkpoint disappeared without a completed endpoint/);
  assert.match(migration, /new_checkpoint->'sampleIndex' is distinct from review->'rollout'->'coverage'->'sample'/);
  assert.match(migration, /new_checkpoint->'candidateIndex' is distinct from review->'rollout'->'coverage'->'currentCandidateIndex'/);
});
