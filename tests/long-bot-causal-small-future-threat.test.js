'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../scripts/long-bot-causal-worker');
const { loadRuntime, stateFromSnapshot } = require('../scripts/generate-long-bot-shadow-replay');
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
    assert.equal(JSON.stringify(source), frozen);
  }
});

test('reported two choices cannot reserve a native four-position review or an invalid envelope', () => {
  const source = game(); source.decisions[2] = decision(2, 'four', 60, 2);
  const plan = worker.productionStrategicReviewPlan(source);
  assert.equal(plan.risks.find(risk => risk.index === 2).capacity.uniquePositions, 4);
  assert.deepEqual(plan.expensiveDecisionIndexes, [4, 7, 19, 18]);
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
