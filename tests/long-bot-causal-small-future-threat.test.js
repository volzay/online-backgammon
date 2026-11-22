'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const worker = require('../scripts/long-bot-causal-worker');
const { loadRuntime, stateFromSnapshot } = require('../scripts/generate-long-bot-shadow-replay');
const { selectReviewDecisionIndexes } = require('../scripts/train-long-bot-causal-army');
const clone = value => structuredClone(value);

function snapshot(kind = 'four') {
  const white = kind === 'two' ? { 24: 14, 2: 1 }
    : kind === 'blocked-two' ? { 24: 13, 11: 1, 9: 1 }
      : kind === 'blocked-three' ? { 24: 12, 11: 1, 9: 1, 8: 1 }
        : { 24: 15 };
  const board = kind === 'two' || kind === 'three' ? 8
    : kind.startsWith('blocked') ? 7 : 9;
  return { schema: 'long-state-v2', variant: 'long', phase: 'move', turn: 'dark',
    points: Object.fromEntries([[12, { color: 'dark', count: 14 }], [board, { color: 'dark', count: 1 }],
      ...Object.entries(white).map(([point, count]) => [point, { color: 'white', count }])]),
    off: { white: 0, dark: 0 }, bar: { white: 0, dark: 0 },
    dice: [2, 4], rolled: [2, 4], turnMoves: [],
    firstMoveDone: { white: true, dark: true }, headPlayedThisTurn: { white: false, dark: false } };
}

function decision(index, kind = 'four', futureRisk = 0, choiceCount = 2) {
  const original = snapshot(kind), state = stateFromSnapshot(original), runtime = loadRuntime();
  const sequence = runtime.game.bestMoveSequences(state, 'dark')[0];
  assert.ok(sequence?.length);
  const after = clone(state);
  const moves = sequence.map(move => ({ from: move.from, to: move.to, die: move.die }));
  for (const move of moves) assert.equal(runtime.game.applyMove(after, move.from, move.die, { autoEnd: false }), true);
  const selected = { moves, after, features: { prospectiveFenceExtensionBefore: futureRisk },
    score: 0, experienceAdjustment: 0, tactical: { distributionComplete: true,
      recoveryDistributionComplete: true, continuationCoverageComplete: true },
    experience: { contextKey: 'synthetic-small-future', actionKey: `action-${index}` } };
  return { id: `synthetic-decision-${index}`, positionId: `synthetic-position-${index}`,
    actor: 'bot', color: 'dark', source: 'engine', engineVersion: worker.ENGINE_VERSION,
    choiceCount, experienceFrozen: true, experienceFingerprint: 'lbe8-empty',
    stateFingerprintV2: `synthetic-state-${index}`, stateSnapshotV2: original,
    replayInput: { runtime: clone(worker.PRODUCTION_POLICY) }, selected,
    experience: clone(selected.experience), execution: { complete: true, fallback: false,
      substituted: false, selectedMatchesExecuted: true, executedActionKey: selected.experience.actionKey,
      executed: clone(selected) } };
}

function game() {
  const decisions = Array.from({ length: 20 }, (_, index) => decision(index));
  decisions[5] = decision(5, 'blocked-two');
  decisions[7] = decision(7, 'blocked-three');
  for (const index of [18, 19]) {
    decisions[index].selected.features.primeRunBefore = 5;
    decisions[index].selected.features.primeRunAfter = 4;
  }
  return { id: 'synthetic-curriculum-ledger', engine_version: worker.ENGINE_VERSION,
    difficulty: 'hard', variant: 'long', bot_color: 'dark', winner: 'white', decisions,
    final_state: { variant: 'long', analysis: { botMemory: { engineVersion: worker.ENGINE_VERSION,
      coverage: { complete: true, expectedBotDecisions: decisions.length,
        recordedBotDecisions: decisions.length, recoveredBotDecisions: 0 },
      replayExperience: { schema: 'long-experience-replay-v1', engineVersion: worker.ENGINE_VERSION,
        fingerprint: 'lbe8-empty', size: 0, frozen: true, complete: true, patterns: [], patternCount: 0 } } } } };
}

test('native two/three-position future review keeps the current first pre-threat onset and two tiered slots', () => {
  for (const kind of ['two', 'three']) {
    const source = game();
    assert.deepEqual(worker.productionStrategicReviewPlan(source).expensiveDecisionIndexes, [4, 7, 19, 18]);
    source.decisions[2] = decision(2, kind, 60);
    const frozen = JSON.stringify(source), plan = worker.productionStrategicReviewPlan(source);
    assert.deepEqual(plan.expensiveDecisionIndexes, [4, 2, 19, 18]);
    assert.equal(plan.maximumExpensiveReviews, 4);
    assert.match(plan.ordering, /^pre-threat-reserve-/);
    assert.ok(plan.risks[0].signals.includes('before-developing-head-fence'));
    const target = plan.risks.find(risk => risk.index === 2);
    assert.equal(target.capacity.eligible, true);
    assert.equal(target.capacity.uniquePositions, kind === 'two' ? 2 : 3);
    assert.ok(target.signals.includes('early-small-choice-future-head-threat'));
    assert.equal(plan.outcomeUsed, false);
    assert.equal(plan.riskRole, 'curriculum-only');
    const offline = selectReviewDecisionIndexes(source,
      { reviewSelection: 'strategic-risk', reviewWorkDecisions: 4 });
    assert.deepEqual(offline.indexes, plan.expensiveDecisionIndexes);
    assert.deepEqual(offline.risks, plan.risks.slice(0, 4));
    assert.equal(offline.ordering, plan.ordering);
    assert.equal(JSON.stringify(source), frozen);
  }
});

test('reported two choices cannot reserve a native four-position review or an invalid envelope', () => {
  const source = game(); source.decisions[2] = decision(2, 'four', 60, 2);
  const plan = worker.productionStrategicReviewPlan(source);
  assert.equal(plan.risks.find(risk => risk.index === 2).capacity.uniquePositions, 4);
  assert.deepEqual(plan.expensiveDecisionIndexes, [4, 7, 19, 18]);
  assert.deepEqual(selectReviewDecisionIndexes(source,
    { reviewSelection: 'strategic-risk', reviewWorkDecisions: 4 }).indexes, plan.expensiveDecisionIndexes);
  source.decisions[2] = decision(2, 'two', 60);
  source.decisions[2].execution.complete = false;
  const invalid = worker.productionStrategicReviewPlan(source);
  assert.deepEqual(invalid.expensiveDecisionIndexes, [4, 7, 19, 18]);
  assert.deepEqual(invalid.risks.find(risk => risk.index === 2).capacity,
    { eligible: false, reason: 'invalid-envelope' });
});

test('earliest eligible future review wins, while late hints and actual outcomes cannot choose work', () => {
  const source = game();
  source.decisions[2] = decision(2, 'two', 60);
  source.decisions[3] = decision(3, 'three', 6000, 3);
  source.decisions[15] = decision(15, 'two', 60000);
  const plan = worker.productionStrategicReviewPlan(source);
  assert.deepEqual(plan.expensiveDecisionIndexes, [4, 2, 19, 18]);
  const changed = clone(source); changed.winner = 'dark'; changed.result_type = 'mars';
  changed.decisions.forEach(row => { row.selected.score = 1e99; row.regret = -1e99; });
  assert.deepEqual(worker.productionStrategicReviewPlan(changed), plan);
});

test('a future-only priority-zero hint keeps offline and production ordering telemetry identical', () => {
  const source = game();
  source.decisions[5] = decision(5); source.decisions[7] = decision(7);
  source.decisions[2] = decision(2, 'two', 60);
  const plan = worker.productionStrategicReviewPlan(source);
  const offline = selectReviewDecisionIndexes(source,
    { reviewSelection: 'strategic-risk', reviewWorkDecisions: 4 });
  assert.equal(worker.archivedEarlyStrategicThreat(source, source.decisions[2]).priority, 0);
  assert.equal(plan.expensiveDecisionIndexes[0], 2);
  assert.match(plan.ordering, /^early-threat-reserve-/);
  assert.deepEqual(offline.indexes, plan.expensiveDecisionIndexes);
  assert.deepEqual(offline.risks, plan.risks.slice(0, 4));
  assert.equal(offline.ordering, plan.ordering);
});

test('future-head hint retains strict native field, ordinary-roll and head-presence guards', () => {
  const source = game();
  const base = decision(2, 'two', 60);
  assert.equal(worker.archivedEarlyStrategicThreat(source, base).smallChoiceFutureThreat, true);
  const changes = [
    row => { row.choiceCount = '2'; }, row => { row.choiceCount = 4; },
    row => { row.selected.features.prospectiveFenceExtensionBefore = 59.9999; },
    row => { row.selected.features.prospectiveFenceExtensionBefore = '60'; },
    row => { row.selected.features.prospectiveFenceExtensionBefore = Infinity; },
    row => { row.stateSnapshotV2.rolled = [2, 2]; row.stateSnapshotV2.dice = [2, 2, 2, 2]; },
    row => { row.stateSnapshotV2.dice = [2]; }, row => { row.stateSnapshotV2.dice = [2, 2]; },
    row => { row.stateSnapshotV2.points[8].count += 14; delete row.stateSnapshotV2.points[12]; },
    row => { row.source = 'history-recovery'; },
  ];
  for (const change of changes) {
    const row = clone(base); change(row);
    assert.equal(worker.archivedEarlyStrategicThreat(source, row).smallChoiceFutureThreat, undefined);
  }
  const white = clone(base); white.color = 'white'; white.stateSnapshotV2.turn = 'white';
  white.stateSnapshotV2.points = Object.fromEntries(Object.entries(base.stateSnapshotV2.points)
    .map(([point, stack]) => [((Number(point) + 11) % 24) + 1,
      { color: stack.color === 'dark' ? 'white' : 'dark', count: stack.count }]));
  assert.deepEqual(worker.archivedEarlyStrategicThreat({ ...source, bot_color: 'white' }, white),
    worker.archivedEarlyStrategicThreat(source, base));
});

test('a lone early slot retains its old pre-threat onset and rejects absent or malformed native capacity', () => {
  const risk = (index, overrides = {}) => ({ index, tier: 0, earlyWindow: true,
    earlyThreat: { priority: 0, fenceBlocked: 0, signals: [] },
    capacity: { eligible: true, uniquePositions: 2 }, ...overrides });
  const onset = risk(4, { preThreat: { index: 4 } });
  const future = risk(2, { earlyThreat: { priority: 0, fenceBlocked: 0, signals: [], smallChoiceFutureThreat: true } });
  const severe = risk(7, { earlyThreat: { priority: 300, fenceBlocked: 3, signals: [] } });
  const late = risk(19, { earlyWindow: false, tier: 4 });
  assert.equal(worker.prioritizeStrategicReviewRisks([future, onset, severe, late], 2)[0], onset);
  for (const capacity of [undefined, { eligible: false, uniquePositions: 2 },
    { eligible: true, uniquePositions: '2' }, { eligible: true, uniquePositions: 4 }]) {
    const rejected = { ...future, capacity };
    assert.deepEqual(worker.prioritizeStrategicReviewRisks([rejected, onset, severe, late], 4)
      .slice(0, 2).map(row => row.index), [4, 7]);
  }
});

test('the new reservation spends exactly four expensive calls and creates no evidence itself', async () => {
  const source = game(); source.decisions[2] = decision(2, 'two', 60);
  const calls = [], results = [];
  for (let index = 0; index < source.decisions.length; index++) {
    results.push(await worker.reviewStrategicallyBoundedProductionDecision(source, index, {}, async (_game, row) => {
      calls.push(row.id); return { status: 'diagnostic-disagreement', evidence: null, outcomeUsed: false };
    }));
  }
  assert.deepEqual(calls, [2, 4, 18, 19].map(index => `synthetic-decision-${index}`));
  assert.ok(results.every(result => result.evidence === null));
  assert.equal(results[7].reason, 'production-strategic-risk-budget-skip');
});

test('signed-root contracts remain byte-identical apart from the reviewed cache registrations', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/long-bot-causal-worker.js'), 'utf8');
  // Public function-region hashes from the effective 9e9118af worker in
  // runtime86. The curriculum patch must preserve every signed-root boundary.
  const expected = {
    verifiedWarmRoot: 'e5e105447c134a7c12896d198b2e024fccdffdc1d0bc85efac1fdb8503632372',
    validatedWarmExperienceAttestation: '1a6e0a1df3513deed37bcb082aaa73cbb5e5c4fd4017fc055c819fb200be5caa',
    regenerateArchivedSelection: '9b26b50f93beecb33a53e8bfd29eb4204c1471a2b12e3266ce7e68b4c019ed9b',
    trustedDecisionEnvelopeFailure: 'b2e6661304ed8d6bed730ba97e9df4e7e5002a34dd1460282d8564664449dfbc',
    offlineTerminalJournalBindings: 'c7b02d7576e59b8eed407a903e3d38ca56ff1a9e8fe3ead69c1144dd29761ec8',
    reviewTrustedDecision: '6970b9bdadf01b1dab5d2a2f3dc5c82fce1e4dafec3a33a14295d98b9054ff08',
    runClaimedBatch: '8439b4720817e77760df91b28e9bf5dff57c7f650047e45011724469a0df4871',
  };
  for (const [name, digest] of Object.entries(expected)) {
    const at = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
    assert.ok(at >= 0, name);
    const tail = source.slice(at);
    const next = tail.slice(1).search(/\n(?:async )?function [A-Za-z_$][A-Za-z0-9_$]*\(/);
    const body = next < 0 ? tail : tail.slice(0, next + 1);
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'), digest, name);
  }
  assert.match(worker.productionStrategicReviewPlan.toString(), /productionStrategicReviewPlan\(game, options = \{\}\)/);
  assert.match(worker.productionStrategicReviewPlan.toString(), /trustedDecisionEnvelopeFailure\(game, decision, options\)/);
  assert.match(worker.reviewStrategicallyBoundedProductionDecision.toString(), /productionStrategicReviewPlan\(game, options\)/);
  const paired = fs.readFileSync(path.join(__dirname, '../scripts/long-bot-paired-rollout.js'), 'utf8');
  // Admit precisely this immutable native tuple plus its list/export entries.
  // Hash the remaining bytes against the original proof, so changing rollout
  // logic, scientific limits, older tuples or even unrelated bytes still fails.
  const quarterRegistration = `// Quarter geometry is derived only from canonical board/off counts. Its exact
// source tuple receives a separate namespace; old audited tuples stay intact.
const QUARTER_GEOMETRY_NATIVE_CACHE_POLICY = Object.freeze({
  policyImplementationId: 'd33a1c6219a986aee5e64312d233fa38db5aeb86e84aa13e6cd3578918d38306',
  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',
  runtimeBytesDigest: 'ce5d1150655fd642e77f04488819eb5003b63413b712ed962144d6adf1a65bf3',
});
`;
  const quarterReference = '  QUARTER_GEOMETRY_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(quarterRegistration).length - 1, 1,
    'only the exact reviewed quarter tuple may be removed');
  assert.equal(paired.split(quarterReference).length - 1, 2,
    'the reviewed tuple occurs once in the admitted list and once in exports');
  const adaptiveRegistration = `// Adaptive assessment reads canonical board, turn, dice and result only.
// Preserve all historical cache namespaces and bind this policy separately.
const ADAPTIVE_COUNTERPLAY_NATIVE_CACHE_POLICY = Object.freeze({
  policyImplementationId: '1aebb4b1b4ef8cf9fe02f86748d8dc3a9f41376710ac74b475f3b30011821946',
  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',
  runtimeBytesDigest: 'cb0902f60ece78841a400b1448662183de2312f42ddfb7c7dc4eaa294d558a69',
});
`;
  const adaptiveReference = '  ADAPTIVE_COUNTERPLAY_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(adaptiveRegistration).length - 1, 1);
  assert.equal(paired.split(adaptiveReference).length - 1, 2);
  const originalPaired = paired.replace(quarterRegistration, '').replaceAll(quarterReference, '')
    .replace(adaptiveRegistration, '').replaceAll(adaptiveReference, '');
  assert.equal(crypto.createHash('sha256').update(originalPaired).digest('hex'),
    '9c8e4c5c5b4c54e445faa265c328dc7a426e05b9d5f4ba8316a8b34f9830e39b');
});

test('reserving a future review cannot authorize an unsigned nonempty experience root', async () => {
  const source = game(); source.decisions[2] = decision(2, 'two', 60);
  const experience = source.final_state.analysis.botMemory.replayExperience;
  experience.size = experience.patternCount = 1;
  experience.patterns = [{ contextKey: 'unattested', actionKey: 'unattested', samples: 1 }];
  let called = false;
  const result = await worker.reviewStrategicallyBoundedProductionDecision(source, 2, {}, async () => {
    called = true; return { evidence: {} };
  });
  assert.equal(called, false);
  assert.equal(result.reason, 'production-decision-envelope-invalid');
  assert.equal(result.targetInvalidReason, 'recursive-experience-provenance-unsigned');
  assert.equal(result.evidence, null);
});
