'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ENGINE_VERSION,
  PRODUCTION_POLICY,
  PRODUCTION_LIVE_DOUBLES_POLICY,
  PRODUCTION_EXPENSIVE_REVIEW_LIMIT,
  archivedEarlyStrategicThreat,
  productionStrategicReviewPlan,
  reviewStrategicallyBoundedProductionDecision,
} = require('../scripts/long-bot-causal-worker');
const { selectReviewDecisionIndexes } = require('../scripts/train-long-bot-causal-army');

const clone = value => structuredClone(value);

function safeSnapshot() {
  return {
    schema: 'long-state-v2', variant: 'long', phase: 'move', turn: 'dark',
    points: { 12: { color: 'dark', count: 2 }, 24: { color: 'white', count: 15 } },
    bar: { white: 0, dark: 0 }, off: { white: 0, dark: 13 },
    dice: [2, 4], rolled: [2, 4], turnMoves: [],
    firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false },
  };
}

// The base board and doubles are D3FM-HS3D bot turn 8. Extra white point 10
// makes a stronger, still valid head fence for the ranking test; this fixture
// asserts curriculum scheduling, not that any archived action was a mistake.
function threatenedSnapshot(extraBlock = false, extraHead = false) {
  const snapshot = {
    schema: 'long-state-v2', variant: 'long', phase: 'move', turn: 'dark',
    points: {
      6: { color: 'dark', count: 3 }, 7: { color: 'dark', count: 1 },
      8: { color: 'white', count: 1 }, 9: { color: 'white', count: 1 },
      11: { color: 'white', count: 1 }, 12: { color: 'dark', count: 9 },
      16: { color: 'white', count: 1 }, 17: { color: 'dark', count: 2 },
      20: { color: 'white', count: 1 }, 21: { color: 'white', count: 1 },
      22: { color: 'white', count: 1 }, 24: { color: 'white', count: 8 },
    },
    bar: { white: 0, dark: 0 }, off: { white: 0, dark: 0 },
    dice: [3, 3, 3, 3], rolled: [3, 3, 3, 3], turnMoves: [],
    firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false },
  };
  if (extraBlock) {
    snapshot.points[10] = { color: 'white', count: 1 };
    snapshot.points[24].count -= 1;
  }
  if (extraHead) {
    snapshot.points[12].count += 1;
    snapshot.points[17].count -= 1;
  }
  return snapshot;
}

function decision(index, snapshot, features = {}) {
  const doubles = snapshot.rolled.length === 4;
  const moves = doubles
    ? [{ from: 7, to: 4, die: 3 }, { from: 4, to: 1, die: 3 },
      { from: 6, to: 3, die: 3 }, { from: 6, to: 3, die: 3 }]
    : [{ from: 12, to: 10, die: 2 }, { from: 12, to: 8, die: 4 }];
  const after = {
    points: clone(snapshot.points), bar: clone(snapshot.bar), off: clone(snapshot.off),
  };
  for (const move of moves) {
    after.points[move.from].count -= 1;
    if (!after.points[move.from].count) delete after.points[move.from];
    after.points[move.to] ||= { color: 'dark', count: 0 };
    after.points[move.to].count += 1;
  }
  const selected = {
    moves, after, features,
    tactical: { distributionComplete: true, recoveryDistributionComplete: true,
      continuationCoverageComplete: true },
    experience: { contextKey: 'early-risk-fixture', actionKey: `action-${index}` },
    score: 0, experienceAdjustment: 0,
  };
  return {
    id: `early-risk-${index}`, positionId: `early-position-${index}`,
    actor: 'bot', color: 'dark', source: 'engine', engineVersion: ENGINE_VERSION,
    choiceCount: 2, experienceFrozen: true, experienceFingerprint: 'lbe8-empty',
    stateFingerprintV2: `state-${index}`, stateSnapshotV2: snapshot,
    replayInput: { runtime: clone(doubles ? PRODUCTION_LIVE_DOUBLES_POLICY : PRODUCTION_POLICY) },
    selected, experience: clone(selected.experience),
    execution: { complete: true, fallback: false, substituted: false,
      selectedMatchesExecuted: true, executedActionKey: selected.experience.actionKey,
      executed: clone(selected) },
  };
}

function d3ShapedLedger() {
  const decisions = Array.from({ length: 50 }, (_, index) => decision(index, safeSnapshot()));
  for (const index of [7, 8, 18]) decisions[index] = decision(index, threatenedSnapshot());
  decisions[11] = decision(11, threatenedSnapshot(true));
  decisions[15] = decision(15, threatenedSnapshot(true, true));
  for (const index of [41, 42, 43, 46]) {
    decisions[index].selected.features = { primeRunBefore: 5, primeRunAfter: 4 };
    decisions[index].execution.executed.features = clone(decisions[index].selected.features);
  }
  return {
    id: 'd3-shaped-curriculum-fixture', engine_version: ENGINE_VERSION,
    difficulty: 'hard', variant: 'long', bot_color: 'dark', winner: 'white', result_type: 'koks',
    decisions,
    final_state: { variant: 'long', winner: 'white', analysis: { botMemory: {
      engineVersion: ENGINE_VERSION,
      coverage: { complete: true, expectedBotDecisions: decisions.length,
        recordedBotDecisions: decisions.length, recoveredBotDecisions: 0 },
      replayExperience: { schema: 'long-experience-replay-v1', engineVersion: ENGINE_VERSION,
        fingerprint: 'lbe8-empty', size: 0, frozen: true, complete: true,
        patterns: [], patternCount: 0 },
    } } },
  };
}

test('D3-shaped early fence risks reserve two deterministic reviews while late prime risks retain two', () => {
  const game = d3ShapedLedger();
  const original = clone(game);
  assert.deepEqual(archivedEarlyStrategicThreat(game, game.decisions[8]),
    { priority: 345, fenceBlocked: 3, signals: ['early-head-fence-pressure'] });
  assert.ok(archivedEarlyStrategicThreat(game, game.decisions[15]).priority
    > archivedEarlyStrategicThreat(game, game.decisions[11]).priority);
  const plan = productionStrategicReviewPlan(game);
  const offline = selectReviewDecisionIndexes(game,
    { reviewSelection: 'strategic-risk', reviewWorkDecisions: 4 });
  assert.equal(plan.maximumExpensiveReviews, PRODUCTION_EXPENSIVE_REVIEW_LIMIT);
  assert.deepEqual(plan.expensiveDecisionIndexes, [7, 15, 46, 43],
    'review the first developing fence and a more severe later fence');
  assert.deepEqual(offline.indexes, plan.expensiveDecisionIndexes);
  assert.deepEqual(offline.risks, plan.risks.slice(0, 4));
  assert.equal(plan.outcomeUsed, false);
  assert.equal(plan.riskRole, 'curriculum-only');
  assert.match(plan.ordering, /^early-threat-reserve-/);
  assert.ok(plan.risks[0].signals.includes('early-head-fence-pressure'));
  assert.deepEqual(game, original);

  const changedOutcome = clone(game);
  changedOutcome.winner = 'dark';
  changedOutcome.result_type = 'mars';
  changedOutcome.final_state.winner = 'dark';
  for (const row of changedOutcome.decisions) {
    row.selected.score = -1e99;
    row.selected.experienceAdjustment = 1e99;
    row.counterfactualReplay = { trusted: true, regret: 1e99 };
  }
  assert.deepEqual(productionStrategicReviewPlan(changedOutcome), plan);
  assert.deepEqual(selectReviewDecisionIndexes(changedOutcome,
    { reviewSelection: 'strategic-risk', reviewWorkDecisions: 4 }), offline);
});

test('native rescue hint can outrank a head fence, but malformed hints and invalid rows cannot take a slot', () => {
  const game = d3ShapedLedger();
  game.decisions[0].selected.features = { koksRescueOpportunity: 1, missedKoksRescue: 1 };
  assert.deepEqual(productionStrategicReviewPlan(game).expensiveDecisionIndexes, [7, 15, 46, 43],
    'an ordinary missed-exit hint must not crowd out an actual developing fence');
  game.decisions[18].selected.features = { koksRescueOpportunity: 2, missedKoksRescue: 1 };
  assert.deepEqual(productionStrategicReviewPlan(game).expensiveDecisionIndexes, [18, 15, 46, 43]);
  for (const value of ['1', true, 1.5, Infinity, -1, 5]) {
    const changed = clone(game.decisions[18]);
    changed.selected.features.missedKoksRescue = value;
    assert.deepEqual(archivedEarlyStrategicThreat(game, changed).signals,
      ['early-head-fence-pressure'], `missedKoksRescue=${String(value)}`);
  }
  game.decisions[18].stateSnapshotV2.off.dark = 1;
  assert.deepEqual(productionStrategicReviewPlan(game).expensiveDecisionIndexes, [7, 15, 46, 43],
    'invalid early row must not spend either reserved slot');
});

test('early fence pressure is symmetric across bot colors and ignores non-native choice counts', () => {
  const darkGame = d3ShapedLedger();
  const dark = darkGame.decisions[8];
  const white = clone(dark);
  white.color = 'white';
  white.stateSnapshotV2.turn = 'white';
  white.stateSnapshotV2.points = Object.fromEntries(Object.entries(dark.stateSnapshotV2.points)
    .map(([point, stack]) => [((Number(point) + 11) % 24) + 1,
      { color: stack.color === 'dark' ? 'white' : 'dark', count: stack.count }]));
  const whiteGame = { ...darkGame, bot_color: 'white' };
  assert.deepEqual(archivedEarlyStrategicThreat(whiteGame, white),
    archivedEarlyStrategicThreat(darkGame, dark));
  white.choiceCount = '2';
  assert.deepEqual(archivedEarlyStrategicThreat(whiteGame, white),
    { priority: 0, fenceBlocked: 0, signals: [] });
});

test('bounded review spends exactly four slots and skips other early decisions without evidence', async () => {
  const game = d3ShapedLedger();
  const original = clone(game);
  const called = [];
  const results = [];
  for (let index = 0; index < game.decisions.length; index += 1) {
    results.push(await reviewStrategicallyBoundedProductionDecision(game, index, {}, async (_game, row) => {
      called.push(row.id);
      return { decisionId: row.id, positionId: row.positionId, status: 'no-regret',
        reason: '', evidence: null, outcomeUsed: false,
        rollout: { coverage: { complete: true } } };
    }));
  }
  assert.deepEqual(called, ['early-risk-7', 'early-risk-15', 'early-risk-43', 'early-risk-46']);
  assert.equal(called.length, PRODUCTION_EXPENSIVE_REVIEW_LIMIT);
  for (const index of [8, 11, 18]) {
    assert.equal(results[index].reason, 'production-strategic-risk-budget-skip');
    assert.equal(results[index].evidence, null);
    assert.equal(results[index].outcomeUsed, false);
    assert.equal(results[index].reviewSelection.selectedForExpensiveReview, false);
  }
  assert.deepEqual(game, original, 'bounded review must leave the archived ledger untouched');
});
