'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  afterPositionKey, loadRuntime, clearRuntimeCache,
} = require('../scripts/generate-long-bot-shadow-replay');
const {
  generatePairedPolicyOutcomes, validatePairedOutcomeEvidence,
} = require('../scripts/long-bot-paired-rollout');
const {
  PRODUCTION_POLICY, ENGINE_VERSION, analyzeTrainingGame, parseCli, runClaimedBatch,
  runtimeDigest, policyImplementationId, validateGameEnvelope,
} = require('../scripts/long-bot-causal-worker');
const { exactExecute, freezeEmptyExperience, freezeTrainingRuntime } = require('../scripts/train-long-bot-causal-army');
const { readRuntimeSnapshot } = require('../scripts/simulate-long-bot-regression');

function scratch() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'long-journal-integration-'));
  return { directory, journal: path.join(directory, 'private-slots'),
    close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function nativeFixture() {
  clearRuntimeCache();
  const runtime = loadRuntime();
  const state = runtime.game.initialState('long');
  Object.assign(state, {
    phase: 'move', turn: 'dark',
    points: { 16: { color: 'dark', count: 1 }, 13: { color: 'dark', count: 1 }, 5: { color: 'white', count: 1 } },
    off: { white: 14, dark: 13 }, bar: { white: 0, dark: 0 }, dice: [1, 2], rolled: [1, 2],
    firstMoveDone: { white: true, dark: true }, headPlayedThisTurn: { white: false, dark: false },
    turnMoves: [], history: [],
  });
  const unique = new Map();
  for (const moves of runtime.game.bestMoveSequences(state, 'dark')) {
    const after = structuredClone(state);
    for (const move of moves) assert.equal(runtime.game.applyMove(after, move.from, move.die, { autoEnd: false }), true);
    const candidate = { moves: moves.map(move => ({ from: move.from, to: move.bearOff ? 0 : move.to, die: move.die })),
      after, features: {}, experience: { contextKey: 'synthetic-journal-parity', actionKey: 'synthetic-only' } };
    if (!unique.has(afterPositionKey(candidate))) unique.set(afterPositionKey(candidate), candidate);
  }
  const candidates = [...unique.values()];
  assert.ok(candidates.length >= 2);
  const decision = { color: 'dark', selected: candidates[0], stateSnapshotV2: {
    schema: 'long-state-v2', variant: 'long', phase: state.phase, turn: state.turn,
    points: state.points, off: state.off, bar: state.bar, dice: state.dice, rolled: state.rolled,
    firstMoveDone: state.firstMoveDone, headPlayedThisTurn: state.headPlayedThisTurn, turnMoves: [],
  } };
  return { runtime, state, candidates, decision };
}

function semantics(report) {
  const copy = structuredClone(report);
  delete copy.cacheObservation;
  delete copy.terminalJournalObservation;
  return copy;
}

function offlineOptions(directory) {
  const runtime = loadRuntime();
  return {
    trustedOfflineTerminalJournal: { directory },
    terminalJournalBindings: { schema: 'synthetic-native-parity-only', certification: false,
      policyImplementationId: policyImplementationId(), runtimeDigest: runtimeDigest(),
      gameBytesSha256: runtime.gameBytesDigest, bundleBytesSha256: runtime.runtimeBytesDigest,
      node: process.versions.node, v8: process.versions.v8 },
    nativeCacheAttestation: { policyImplementationId: policyImplementationId(), runtimeDigest: runtimeDigest(),
      gameBytesDigest: runtime.gameBytesDigest, runtimeBytesDigest: runtime.runtimeBytesDigest },
    rolloutLimits: { maxElapsedMs: 60000, maxPlies: 40 },
  };
}

test('native fixed cohort resumes every committed slot with identical seeds, terminal bits and confidence', async () => {
  const temporary = scratch();
  try {
    const { decision, candidates } = nativeFixture();
    const options = offlineOptions(temporary.journal);
    const original = await generatePairedPolicyOutcomes(decision, candidates, { rolloutLimits: options.rolloutLimits });
    const first = await generatePairedPolicyOutcomes(decision, candidates, options);
    const resumed = await generatePairedPolicyOutcomes(decision, candidates, options);
    assert.equal(first.ok, true, first.reason);
    assert.equal(resumed.ok, true, resumed.reason);
    assert.equal(first.terminalJournalObservation.completedTerminalOutcomes, candidates.length * 32);
    assert.equal(first.terminalJournalObservation.resumedTerminalOutcomes, 0);
    assert.equal(resumed.terminalJournalObservation.resumedTerminalOutcomes, candidates.length * 32);
    assert.equal(resumed.cacheObservation.planMisses, 0);
    assert.equal(resumed.cacheObservation.suffixMisses, 0);
    assert.deepEqual(semantics(resumed), semantics(first));
    assert.deepEqual(semantics(first), semantics(original));
    assert.equal(validatePairedOutcomeEvidence(resumed, decision, candidates), '');
  } finally { temporary.close(); }
});

test('normal budget timeout commits only completed native endpoints and a later run finishes without partial evidence', async () => {
  const temporary = scratch();
  const realNow = Date.now;
  try {
    const { decision, candidates } = nativeFixture();
    const options = offlineOptions(temporary.journal);
    let clockCalls = 0;
    // Synthetic controller clock only: game/dice/policies are genuine native.
    // It is not a measured performance or strength result.
    Date.now = () => ++clockCalls > 120 ? 100000000 : 1000;
    const interrupted = await generatePairedPolicyOutcomes(decision, candidates, options);
    Date.now = realNow;
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.reason, 'rollout-time-limit');
    const completed = interrupted.coverage.completedTerminalOutcomes;
    assert.ok(completed > 0 && completed < candidates.length * 32, `completed=${completed}`);
    assert.equal(interrupted.coverage.complete, false);
    assert.equal(interrupted.terminalJournalObservation.learningEvidence, false);
    assert.equal(interrupted.terminalJournalObservation.completedTerminalOutcomes, completed);
    assert.equal(interrupted.recommendation, undefined);
    const resumed = await generatePairedPolicyOutcomes(decision, candidates, options);
    assert.equal(resumed.ok, true, resumed.reason);
    assert.equal(resumed.terminalJournalObservation.resumedTerminalOutcomes, completed);
    assert.equal(resumed.coverage.terminalOutcomes, candidates.length * 32);
    assert.equal(validatePairedOutcomeEvidence(resumed, decision, candidates), '');
    const original = await generatePairedPolicyOutcomes(decision, candidates, { rolloutLimits: options.rolloutLimits });
    assert.deepEqual(semantics(resumed), semantics(original));
  } finally { Date.now = realNow; temporary.close(); }
});

test('injected adapters or outcomes cannot use a native terminal progress store', async () => {
  const temporary = scratch();
  try {
    const { runtime, decision, candidates } = nativeFixture();
    const options = offlineOptions(temporary.journal);
    for (const extra of [{ runtime }, { outcomeRunner: () => { throw new Error('must never run'); } }]) {
      const result = await generatePairedPolicyOutcomes(decision, candidates, { ...options, ...extra });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'terminal-journal-requires-verified-native-offline-bindings');
      assert.equal(fs.existsSync(temporary.journal), false);
    }
  } finally { temporary.close(); }
});

test('audited native history projection preserves every terminal outcome against cache-off unprojected policy', async () => {
  const { decision, candidates } = nativeFixture();
  const limits = { maxElapsedMs: 60000, maxPlies: 40 };
  const projected = await generatePairedPolicyOutcomes(decision, candidates, { rolloutLimits: limits });
  const fullHistory = await generatePairedPolicyOutcomes(decision, candidates, { rolloutLimits: { ...limits, cacheMode: 'off' } });
  assert.equal(projected.ok, true, projected.reason);
  assert.equal(fullHistory.ok, true, fullHistory.reason);
  const left = semantics(projected), right = semantics(fullHistory);
  delete left.limits.cacheMode;
  delete right.limits.cacheMode;
  assert.deepEqual(left, right);
  assert.equal(validatePairedOutcomeEvidence(projected, decision, candidates), '');
  assert.equal(validatePairedOutcomeEvidence(fullHistory, decision, candidates), '');
});

test('offline CLI requires original input, exact ledger index and private journal together', () => {
  const options = parseCli(['--input', 'original.json', '--decision-index', '22', '--terminal-journal-dir', '/private/tmp/own-slots']);
  assert.deepEqual(options.reviewDecisionIndexes, [22]);
  assert.deepEqual(options.trustedTrainingPolicy, PRODUCTION_POLICY);
  assert.deepEqual(options.trustedOfflineTerminalJournal, { directory: '/private/tmp/own-slots' });
  for (const argv of [
    ['--terminal-journal-dir', '/private/tmp/own-slots'],
    ['--input', 'original.json', '--decision-index', '22'],
    ['--input', 'original.json', '--terminal-journal-dir', '/private/tmp/own-slots'],
    ['--once', '--input', 'original.json', '--decision-index', '22', '--terminal-journal-dir', '/private/tmp/own-slots'],
    ['--input', 'original.json', '--decision-index', '320', '--terminal-journal-dir', '/private/tmp/own-slots'],
    ['--input', 'original.json', '--decision-index', '1.5', '--terminal-journal-dir', '/private/tmp/own-slots'],
  ]) assert.throws(() => parseCli(argv));
});

test('production rejects offline journaling before any queue or network mutation', async () => {
  for (const options of [{ trustedOfflineTerminalJournal: { directory: '/private/tmp/own-slots' } }, { terminalJournalBindings: {} }]) {
    await assert.rejects(runClaimedBatch(options), /offline-only.*resumable/);
  }
});

function originalNativeLoss() {
  const { runtime, state } = nativeFixture();
  const id = 'journal-native-original-loss';
  const experience = freezeEmptyExperience(runtime.engine, id);
  const plan = runtime.engine.plan(state, structuredClone(PRODUCTION_POLICY));
  const decision = structuredClone(runtime.engine.consumeLastDecision());
  decision.actor = 'bot';
  decision.replayExperience = experience;
  const executed = exactExecute(runtime.game, state, plan, decision);
  decision.execution = { complete: true, fallback: false, substituted: false, selectedMatchesExecuted: true,
    executedMoves: executed.moves, after: executed.after,
    executedActionKey: decision.selected.experience.actionKey,
    executed: { moves: executed.moves, after: executed.after, experience: structuredClone(decision.selected.experience) } };
  assert.equal(state.winner, null);
  runtime.game.endTurn(state);
  runtime.game.applyRoll(state, [5, 6]);
  for (const move of runtime.game.bestMoveSequences(state, 'white')[0]) {
    assert.equal(runtime.game.applyMove(state, move.from, move.die, { autoEnd: false }), true);
    if (state.winner) break;
  }
  assert.equal(state.winner, 'white');
  state.analysis = { botMemory: { engineVersion: ENGINE_VERSION, replayExperience: experience,
    coverage: { complete: true, expectedBotDecisions: 1, recordedBotDecisions: 1, recoveredBotDecisions: 0 } } };
  const game = { id, room_code: 'SYNTHETIC-JOURNAL', engine_version: ENGINE_VERSION, difficulty: 'hard',
    bot_color: 'dark', winner: 'white', status: 'completed', decisions: [decision], final_state: structuredClone(state) };
  assert.equal(validateGameEnvelope(game), '');
  return game;
}

test('trusted worker verifies original full ledger and current exact selection again before reusing native slots', async () => {
  const temporary = scratch();
  try {
    const game = originalNativeLoss();
    const options = { trustedTrainingPolicy: structuredClone(PRODUCTION_POLICY), reviewDecisionIndexes: [0],
      trustedOfflineTerminalJournal: { directory: temporary.journal },
      rolloutLimits: { maxElapsedMs: 60000, maxPlies: 40 } };
    const originalBytes = JSON.stringify(game);
    const first = await analyzeTrainingGame(game, options);
    const resumed = await analyzeTrainingGame(game, options);
    assert.equal(first.accepted, true, first.reason);
    assert.equal(first.reviewCoverage.completedOutcomeCohorts, 1, JSON.stringify(first.reviews));
    assert.equal(resumed.reviewCoverage.completedOutcomeCohorts, 1, JSON.stringify(resumed.reviews));
    assert.ok(resumed.reviews[0].rollout.terminalJournalObservation.resumedTerminalOutcomes >= 64);
    assert.equal(resumed.selection.historicalImplementationAttested, false);
    assert.equal(resumed.selection.outcomeUsedAsDecisionLabel, false);
    assert.equal(resumed.runtimeDigest, first.runtimeDigest);
    assert.deepEqual(resumed.evidence, first.evidence);
    assert.equal(JSON.stringify(game), originalBytes);
    const changed = structuredClone(game);
    changed.decisions[0].execution.executed.moves.reverse();
    const rejected = await analyzeTrainingGame(changed, options);
    assert.equal(rejected.reviewCoverage.completedOutcomeCohorts, 0);
    assert.equal(rejected.evidence.length, 0);
  } finally { temporary.close(); }
});

test('immutable army snapshot includes the exact guarded terminal-journal executable', () => {
  const temporary = scratch();
  try {
    const frozen = freezeTrainingRuntime(readRuntimeSnapshot(), temporary.directory);
    const name = 'scripts/long-bot-terminal-journal.js';
    assert.ok(frozen.files.some(file => file.name === name));
    assert.ok(fs.readFileSync(path.join(frozen.directory, name)).equals(fs.readFileSync(path.join(__dirname, '..', name))));
  } finally { temporary.close(); }
});
