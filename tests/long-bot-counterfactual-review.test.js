const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

async function loadReviewer() {
  return import(pathToFileURL(path.join(ROOT, 'bot-engine/long/reviewer.ts')).href);
}

function snapshot(point = 12) {
  return {
    schema: 'long-state-v2',
    color: 'dark',
    dice: [2, 4],
    points: {
      [point]: { color: 'dark', count: 2 },
      24: { color: 'white', count: 15 },
    },
    off: { white: 0, dark: 0 },
  };
}

function board(points, off = { white: 0, dark: 0 }) {
  return { points, off };
}

function candidate({
  after,
  score,
  features = {},
  actionKey = '',
  contextKey = 'route|review-fixture',
  moves = [{ from: 12, to: 8, die: 4 }],
  ...extra
}) {
  return {
    after,
    moves,
    policyScore: score,
    features,
    experience: { contextKey, actionKey },
    ...extra,
  };
}

function fixture() {
  const stateSnapshotV2 = snapshot();
  const selected = candidate({
    after: board({
      8: { color: 'dark', count: 2 },
      24: { color: 'white', count: 15 },
    }),
    score: 100,
    features: {
      outsideReduction: 0,
      homeEntryMoves: 0,
      avoidableHomeShuffleMoves: 1,
      maxRouteTowerAfter: 7,
      routeTowerDelta: -2,
    },
    actionKey: 'selected-action',
    policyScoreUcb: 103,
  });
  const recommended = candidate({
    after: board({
      6: { color: 'dark', count: 1 },
      10: { color: 'dark', count: 1 },
      24: { color: 'white', count: 15 },
    }),
    score: 130,
    features: {
      outsideReduction: 1,
      homeEntryMoves: 1,
      avoidableHomeShuffleMoves: 0,
      maxRouteTowerAfter: 2,
      routeTowerDelta: 1,
    },
    actionKey: 'recommended-action',
    policyScoreLcb: 125,
  });
  const decision = {
    id: 'decision-1',
    positionId: 'lb4-test',
    source: 'engine',
    engineVersion: 'long-analytic-v35',
    experienceFingerprint: 'lbe8-review-fixture',
    stateFingerprintV2: 'lbs2-review-fixture',
    stateSnapshotV2,
    selected: JSON.parse(JSON.stringify(selected)),
    experience: JSON.parse(JSON.stringify(selected.experience)),
    execution: {
      complete: true,
      fallback: false,
      substituted: false,
      selectedMatchesExecuted: true,
      executed: JSON.parse(JSON.stringify(selected)),
    },
    alternatives: [{ policyScore: 999999, after: recommended.after }],
  };
  const replay = {
    reviewerVersion: 'long-counterfactual-review-v1',
    engineVersion: decision.engineVersion,
    experienceFingerprint: decision.experienceFingerprint,
    stateFingerprintV2: decision.stateFingerprintV2,
    stateSnapshotV2: JSON.parse(JSON.stringify(stateSnapshotV2)),
    scoreSemantics: 'long-policy-evaluator-v1',
    learningEvidence: {
      schema: 'long-policy-counterfactual-evidence-v1',
      trusted: true,
      conservativeBoundsComplete: true,
    },
    outcomeUsed: false,
    coverage: { complete: true, expectedCandidates: 2, evaluatedCandidates: 2 },
    minRegret: 5,
    minRegretLcb: 5,
  };
  return { decision, replay, selected, recommended };
}

test('a loss without counterfactual regret produces neither credit nor penalty', async () => {
  const { reviewLongBotDecision } = await loadReviewer();
  const { decision, replay, selected } = fixture();
  decision.outcome = { winner: 'white', resultType: 'mars' };
  const replayedWorseAlternative = candidate({
    after: board({
      7: { color: 'dark', count: 1 },
      9: { color: 'dark', count: 1 },
      24: { color: 'white', count: 15 },
    }),
    score: 90,
    features: { outsideReduction: 1 },
  });

  const result = reviewLongBotDecision(decision, [selected, replayedWorseAlternative], replay);
  assert.equal(result.status, 'no-regret');
  assert.equal(result.credit, 0);
  assert.deepEqual(result.records, []);
  assert.equal(result.outcomeUsed, false);
});

test('a win can still expose a structural mistake from replayed candidates', async () => {
  const { reviewLongBotDecision } = await loadReviewer();
  const { decision, replay, selected, recommended } = fixture();
  decision.outcome = { winner: 'dark', resultType: 'normal' };

  const result = reviewLongBotDecision(decision, [selected, recommended], replay);
  assert.equal(result.status, 'confirmed-regret');
  assert.equal(result.regret, 30);
  assert.equal(result.regretLcb, 22);
  assert.equal(result.outcomeUsed, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].evidenceType, 'negative-selected-penalty');
  assert.equal(result.records[0].direction, 'negative');
  assert.deepEqual(result.categories, [
    'missed-home-entry',
    'avoidable-home-shuffle',
    'tower',
  ]);
});

test('identity, provenance, coverage, execution, and state mismatches fail closed', async t => {
  const { reviewLongBotDecision } = await loadReviewer();
  const base = fixture();
  const cases = [
    ['execution substitution', value => {
      value.decision.execution = {
        complete: true,
        substitutions: [{ planned: {}, actual: {} }],
      };
    }, 'execution-substitution'],
    ['fallback', value => {
      value.decision.source = 'fallback';
    }, 'fallback-decision'],
    ['engine version', value => {
      value.replay.engineVersion = 'long-analytic-other';
    }, 'engine-version-mismatch'],
    ['reviewer version', value => {
      value.replay.reviewerVersion = 'long-counterfactual-review-v2';
    }, 'reviewer-version-mismatch'],
    ['fingerprint', value => {
      value.replay.experienceFingerprint = 'lbe8-other';
    }, 'experience-fingerprint-mismatch'],
    ['state', value => {
      value.replay.stateSnapshotV2 = snapshot(11);
    }, 'state-snapshot-v2-mismatch'],
    ['missing state', value => {
      delete value.decision.stateSnapshotV2;
    }, 'state-snapshot-v2-missing'],
    ['coverage', value => {
      value.replay.coverage.complete = false;
    }, 'candidate-coverage-incomplete'],
  ];

  for (const [label, mutate, expectedReason] of cases) {
    await t.test(label, () => {
      const value = structuredClone(base);
      mutate(value);
      const result = reviewLongBotDecision(
        value.decision,
        [value.selected, value.recommended],
        value.replay,
      );
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason, expectedReason);
      assert.deepEqual(result.records, []);
    });
  }
});

test('equivalent resulting boards are deduplicated before regret is computed', async () => {
  const {
    afterPositionKey,
    dedupeCandidatesByAfterPosition,
    reviewLongBotDecision,
  } = await loadReviewer();
  const { decision, replay, selected } = fixture();
  const sameBoardDifferentOrder = candidate({
    after: JSON.parse(JSON.stringify(selected.after)),
    score: 140,
    features: { outsideReduction: 2 },
    moves: [{ from: 10, die: 2 }, { from: 8, die: 4 }],
  });
  replay.coverage = { complete: true, expectedCandidates: 2, evaluatedCandidates: 2 };

  assert.equal(afterPositionKey(selected), afterPositionKey(sameBoardDifferentOrder));
  assert.equal(dedupeCandidatesByAfterPosition([selected, sameBoardDifferentOrder]).length, 1);
  const result = reviewLongBotDecision(decision, [selected, sameBoardDifferentOrder], replay);
  assert.equal(result.status, 'no-regret');
  assert.equal(result.uniquePositionCount, 1);
  assert.deepEqual(result.records, []);
});

test('one confirmed dominant alternative emits exactly one negative record', async () => {
  const { reviewLongBotDecision } = await loadReviewer();
  const { decision, replay, selected, recommended } = fixture();
  const inferior = candidate({
    after: board({
      5: { color: 'dark', count: 2 },
      24: { color: 'white', count: 15 },
    }),
    score: 80,
    features: { outsideReduction: 0 },
  });
  replay.coverage = { complete: true, expectedCandidates: 3, evaluatedCandidates: 3 };

  const result = reviewLongBotDecision(decision, [inferior, recommended, selected], replay);
  assert.equal(result.status, 'confirmed-regret');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].selectedActionKey, 'selected-action');
  assert.ok(result.records[0].regret > 0);
  assert.ok(result.records[0].regretLcb > 0);
  assert.equal(result.credit, 0);
});

test('a regenerated selected candidate must match the archived context and action exactly', async () => {
  const { reviewLongBotDecision } = await loadReviewer();
  const { decision, replay, selected, recommended } = fixture();
  selected.experience.actionKey = 'forged-selected-action';

  const result = reviewLongBotDecision(decision, [selected, recommended], replay);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'selected-replay-experience-mismatch');
  assert.deepEqual(result.records, []);
});

test('a regenerated selected candidate must match the archived canonical moves', async () => {
  const { reviewLongBotDecision } = await loadReviewer();
  const { decision, replay, selected, recommended } = fixture();
  selected.moves = [
    { from: 12, to: 10, die: 2 },
    { from: 10, to: 8, die: 2 },
  ];

  const result = reviewLongBotDecision(decision, [selected, recommended], replay);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'selected-replay-experience-mismatch');
  assert.deepEqual(result.records, []);
});

test('static evaluator regret is diagnostic only and never fabricates an LCB', async () => {
  const { reviewLongBotDecision } = await loadReviewer();
  const { decision, replay, selected, recommended } = fixture();
  delete selected.policyScore;
  delete selected.policyScoreUcb;
  delete recommended.policyScore;
  delete recommended.policyScoreLcb;
  selected.score = 100;
  recommended.score = 130;
  selected.scoreSemantics = 'long-static-evaluator-v1';
  recommended.scoreSemantics = 'long-static-evaluator-v1';
  replay.scoreSemantics = 'long-static-evaluator-v1';
  replay.learningEvidence = undefined;

  const result = reviewLongBotDecision(decision, [selected, recommended], replay);
  assert.equal(result.status, 'diagnostic-regret');
  assert.equal(result.learningEligible, false);
  assert.equal(result.learningIneligibleReason, 'static-evaluator-diagnostic-only');
  assert.equal(result.regretLcb, null);
  assert.deepEqual(result.records, []);
});

test('reviewer rejects replay evidence that used the final outcome', async () => {
  const { reviewLongBotDecision } = await loadReviewer();
  const { decision, replay, selected, recommended } = fixture();
  replay.outcomeUsed = true;

  const result = reviewLongBotDecision(decision, [selected, recommended], replay);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'replay-outcome-provenance-invalid');
});

test('trusted policy evidence rejects coercible missing scores and bounds', async t => {
  const { reviewLongBotDecision } = await loadReviewer();
  for (const value of [null, '', false, '100']) {
    await t.test(`score ${JSON.stringify(value)}`, () => {
      const { decision, replay, selected, recommended } = fixture();
      selected.policyScore = value;
      const result = reviewLongBotDecision(decision, [selected, recommended], replay);
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason, 'candidate-score-missing');
      assert.deepEqual(result.records, []);
    });
  }

  for (const value of [null, '', false, '103']) {
    await t.test(`bound ${JSON.stringify(value)}`, () => {
      const { decision, replay, selected, recommended } = fixture();
      selected.policyScoreUcb = value;
      const result = reviewLongBotDecision(decision, [selected, recommended], replay);
      assert.equal(result.status, 'diagnostic-regret');
      assert.equal(result.learningEligible, false);
      assert.equal(result.learningIneligibleReason, 'conservative-bounds-incomplete');
      assert.equal(result.regretLcb, null);
      assert.deepEqual(result.records, []);
    });
  }
});

test('execution must match the exact board, canonical moves, and action identity', async t => {
  const { reviewLongBotDecision } = await loadReviewer();

  await t.test('same board through a different move alias is rejected', () => {
    const { decision, replay, selected, recommended } = fixture();
    decision.execution.executed.moves = [
      { from: 12, to: 10, die: 2 },
      { from: 10, to: 8, die: 2 },
    ];
    const result = reviewLongBotDecision(decision, [selected, recommended], replay);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'execution-selected-mismatch');
    assert.deepEqual(result.records, []);
  });

  await t.test('missing executed moves fail closed', () => {
    const { decision, replay, selected, recommended } = fixture();
    delete decision.execution.executed.moves;
    const result = reviewLongBotDecision(decision, [selected, recommended], replay);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'execution-moves-missing');
    assert.deepEqual(result.records, []);
  });

  await t.test('null move coordinates are not coerced into bear-off', () => {
    const { decision, replay, selected, recommended } = fixture();
    decision.execution.executed.moves = [{ from: 12, to: null, die: 4 }];
    const result = reviewLongBotDecision(decision, [selected, recommended], replay);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'execution-moves-missing');
    assert.deepEqual(result.records, []);
  });

  await t.test('different executed action identity is rejected', () => {
    const { decision, replay, selected, recommended } = fixture();
    decision.execution.executed.experience.actionKey = 'different-executed-action';
    const result = reviewLongBotDecision(decision, [selected, recommended], replay);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'execution-selected-mismatch');
    assert.deepEqual(result.records, []);
  });
});

test('resulting-position identity includes the bar and cannot collapse distinct boards', async () => {
  const { afterPositionKey, dedupeCandidatesByAfterPosition } = await loadReviewer();
  const base = candidate({
    after: {
      points: { 8: { color: 'dark', count: 1 } },
      bar: { white: 0, dark: 0 },
      off: { white: 0, dark: 0 },
    },
    score: 10,
    actionKey: 'bar-zero',
  });
  const onBar = structuredClone(base);
  onBar.after.bar.dark = 1;
  onBar.experience.actionKey = 'bar-one';

  assert.notEqual(afterPositionKey(base), afterPositionKey(onBar));
  assert.equal(dedupeCandidatesByAfterPosition([base, onBar]).length, 2);
});
