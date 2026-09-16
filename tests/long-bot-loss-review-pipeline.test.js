const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeTrainingDocuments,
  executionIdentity,
  missingReplayEvidence,
  parseTrainingText,
} = require('../scripts/review-long-bot-losses');

function snapshot() {
  return {
    schema: 'long-state-v2',
    color: 'dark',
    dice: [2, 4],
    points: {
      12: { color: 'dark', count: 2 },
      24: { color: 'white', count: 15 },
    },
    off: { white: 0, dark: 0 },
  };
}

function candidate(point, score, features = {}, action = `move-to-${point}`) {
  return {
    after: {
      points: {
        [point]: { color: 'dark', count: 2 },
        24: { color: 'white', count: 15 },
      },
      off: { white: 0, dark: 0 },
    },
    moves: [{ from: 12, to: point, die: 4 }],
    policyScore: score,
    features,
    experience: { contextKey: 'route|pipeline-fixture', actionKey: action },
  };
}

function completeLossFixture() {
  const selected = candidate(8, 100, {
    outsideReduction: 0,
    homeEntryMoves: 0,
    avoidableHomeShuffleMoves: 1,
    maxRouteTowerAfter: 7,
  }, 'selected-action');
  selected.policyScoreUcb = 103;
  const recommended = candidate(6, 140, {
    outsideReduction: 1,
    homeEntryMoves: 1,
    avoidableHomeShuffleMoves: 0,
    maxRouteTowerAfter: 2,
  }, 'recommended-action');
  recommended.policyScoreLcb = 135;
  const duplicateRecommended = {
    ...structuredClone(recommended),
    moves: [{ from: 10, to: 6, die: 4 }, { from: 12, to: 10, die: 2 }],
    policyScore: 135,
  };
  const stateSnapshotV2 = snapshot();
  const decision = {
    id: 'decision-complete-1',
    positionId: 'lb4-pipeline-test',
    source: 'engine',
    engineVersion: 'long-analytic-v35',
    experienceFingerprint: 'sha256:test-experience',
    stateFingerprintV2: 'lbs2-pipeline-test',
    stateSnapshotV2,
    selected: structuredClone(selected),
    experience: structuredClone(selected.experience),
    execution: {
      complete: true,
      fallback: false,
      substituted: false,
      selectedMatchesExecuted: true,
      executed: structuredClone(selected),
    },
  };
  const replay = {
    reviewerVersion: 'long-counterfactual-review-v1',
    engineVersion: decision.engineVersion,
    experienceFingerprint: decision.experienceFingerprint,
    stateFingerprintV2: decision.stateFingerprintV2,
    stateSnapshotV2: structuredClone(stateSnapshotV2),
    scoreSemantics: 'long-policy-evaluator-v1',
    learningEvidence: {
      schema: 'long-policy-counterfactual-evidence-v1',
      trusted: true,
      conservativeBoundsComplete: true,
    },
    outcomeUsed: false,
    coverage: { complete: true, expectedCandidates: 3, evaluatedCandidates: 3 },
    candidates: [selected, duplicateRecommended, recommended],
    minRegret: 5,
    minRegretLcb: 5,
  };
  return {
    id: 'game-loss-1',
    room_code: 'LOSS-ROOM',
    winner: 'white',
    result_type: 'mars',
    bot_color: 'dark',
    decisions: [{ ...decision, counterfactualReplay: replay }],
  };
}

function analyzeAttached(documents, options = {}) {
  return analyzeTrainingDocuments(documents, {
    ...options,
    allowAttachedReplayForTests: true,
  });
}

test('complete replay emits one decision-local counterfactual penalty and deduplicates boards', async () => {
  const report = await analyzeAttached([completeLossFixture()]);

  assert.equal(report.schema, 'long-bot-loss-review-report-v1');
  assert.equal(report.outcomeUsed, false);
  assert.equal(report.summary.decisionsReviewed, 1);
  assert.equal(report.summary.confirmedRegret, 1);
  assert.equal(report.summary.causalRecords, 1);
  assert.equal(report.reviews[0].execution.status, 'matched');
  assert.equal(report.reviews[0].counterfactual.candidateCount, 3);
  assert.equal(report.reviews[0].counterfactual.uniquePositionCount, 2);
  assert.equal(report.records[0].evidenceType, 'negative-selected-penalty');
  assert.equal(report.records[0].contextKey, 'route|pipeline-fixture');
  assert.equal(report.records[0].selectedActionKey, 'selected-action');
  assert.equal(
    report.records[0].actionIdentity,
    'route|pipeline-fixture::selected-action',
  );
  assert.equal(report.records[0].reviewComplete, true);
  assert.equal(report.records[0].candidateCoverageComplete, true);
  assert.equal(report.records[0].executionStatus, 'matched');
  assert.equal(report.records[0].evidenceNature, 'decision-local-counterfactual-regret');
  assert.equal(report.records[0].outcomeUsed, false);
  assert.equal(report.reviews[0].outcome.usedAsDecisionLabel, false);
});

test('old v34 training telemetry fails closed instead of blaming a move for a loss', async () => {
  const oldExport = {
    id: 'old-game',
    room_code: 'OLD-V34',
    engine_version: 'long-analytic-v34',
    winner: 'white',
    bot_color: 'dark',
    decisions: [{
      id: 'old-decision',
      source: 'engine',
      engineVersion: 'long-analytic-v34',
      position: { points: {}, off: { white: 0, dark: 0 } },
      selected: { moves: [{ from: 12, to: 8, die: 4 }], score: 100 },
      alternatives: [{ moves: [{ from: 12, to: 10, die: 2 }], score: 90 }],
    }],
  };

  const report = await analyzeTrainingDocuments([oldExport]);
  assert.equal(report.summary.insufficientEvidence, 1);
  assert.equal(report.summary.decisionsReviewed, 0);
  assert.equal(report.summary.causalRecords, 0);
  assert.equal(report.reviews[0].status, 'insufficient-evidence');
  assert.equal(report.reviews[0].reason, 'execution-completion-missing');
  assert.deepEqual(report.reviews[0].missingEvidence, [
    'execution-completion-missing',
    'state-snapshot-v2-missing',
    'state-fingerprint-v2-missing',
    'complete-counterfactual-replay-missing',
  ]);
  assert.deepEqual(report.records, []);
});

test('human turn rows in a mixed training export are not treated as bot decisions', async () => {
  const game = completeLossFixture();
  game.decisions.unshift({
    id: 'human-turn',
    color: 'white',
    selected: { moves: [{ from: 24, to: 20, die: 4 }] },
  });
  game.decisions[1].color = 'dark';

  const report = await analyzeAttached([game]);
  assert.equal(report.summary.decisionsSeen, 2);
  assert.equal(report.summary.botDecisionsSeen, 1);
  assert.equal(report.summary.nonBotDecisionsSkipped, 1);
  assert.equal(report.reviews.length, 1);
  assert.equal(report.reviews[0].decisionId, 'decision-complete-1');
});

test('selected and executed actions are reported separately and divergence is never learned', async () => {
  const game = completeLossFixture();
  const decision = game.decisions[0];
  const executed = candidate(7, 70, {}, 'executed-substitute');
  decision.execution = {
    complete: true,
    fallback: true,
    substituted: true,
    substitutions: [{ planned: decision.selected.moves[0], actual: executed.moves[0] }],
    executed,
  };

  const report = await analyzeAttached([game]);
  const review = report.reviews[0];
  assert.equal(review.status, 'insufficient-evidence');
  assert.equal(review.reason, 'execution-substitution');
  assert.equal(review.execution.status, 'diverged');
  assert.equal(review.execution.selectedActionKey, 'selected-action');
  assert.equal(review.execution.executedActionKey, 'executed-substitute');
  assert.notEqual(review.execution.selectedPositionKey, review.execution.executedPositionKey);
  assert.equal(report.summary.causalRecords, 0);
});

test('a lost game with no superior counterfactual creates no penalty', async () => {
  const game = completeLossFixture();
  const decision = game.decisions[0];
  const replay = decision.counterfactualReplay;
  replay.candidates = [
    { ...structuredClone(decision.selected), policyScore: 150 },
    candidate(6, 100, { outsideReduction: 1, homeEntryMoves: 1 }),
  ];
  replay.coverage = { complete: true, expectedCandidates: 2, evaluatedCandidates: 2 };

  const report = await analyzeAttached([game]);
  assert.equal(report.summary.noRegret, 1);
  assert.equal(report.summary.confirmedRegret, 0);
  assert.equal(report.summary.causalRecords, 0);
  assert.equal(report.reviews[0].outcome.classification, 'loss');
  assert.equal(report.reviews[0].outcomeUsed, false);
});

test('outcome only selects the cohort: wins are skipped by default and reviewable explicitly', async () => {
  const game = completeLossFixture();
  game.winner = 'dark';

  const losses = await analyzeAttached([game]);
  assert.equal(losses.summary.winGamesSkipped, 1);
  assert.equal(losses.summary.decisionsSeen, 0);

  const allGames = await analyzeAttached([game], { lossesOnly: false });
  assert.equal(allGames.summary.confirmedRegret, 1);
  assert.equal(allGames.records[0].outcomeUsed, false);
  assert.equal(allGames.reviews[0].outcome.classification, 'win');
});

test('incomplete candidate coverage is insufficient evidence', async () => {
  const game = completeLossFixture();
  game.decisions[0].counterfactualReplay.coverage.evaluatedCandidates = 2;

  const report = await analyzeAttached([game]);
  assert.equal(report.reviews[0].status, 'insufficient-evidence');
  assert.equal(report.reviews[0].reason, 'candidate-coverage-incomplete');
  assert.equal(report.summary.causalRecords, 0);
});

test('JSON and JSONL parsing preserve documents and report malformed line numbers', () => {
  const first = { id: 1, decisions: [] };
  const second = { id: 2, decisions: [] };
  const json = parseTrainingText(JSON.stringify([first, second]), 'games.json');
  assert.equal(json.format, 'json');
  assert.equal(json.documents.length, 1);

  const jsonl = parseTrainingText(`${JSON.stringify(first)}\n\n${JSON.stringify(second)}\n`, 'games.jsonl');
  assert.equal(jsonl.format, 'jsonl');
  assert.deepEqual(jsonl.documents, [first, second]);
  assert.throws(
    () => parseTrainingText(`${JSON.stringify(first)}\nnot-json\n`, 'broken.jsonl'),
    /broken\.jsonl:2: invalid JSONL/,
  );
});

test('execution identity fails closed when exact resulting board or action identity is unavailable', async () => {
  const reviewer = await import('../bot-engine/long/reviewer.ts');
  const selected = candidate(8, 100);
  const decision = {
    selected,
    execution: { complete: true, moves: structuredClone(selected.moves) },
  };
  const identity = executionIdentity(decision, reviewer.afterPositionKey);
  assert.equal(identity.status, 'insufficient-evidence');
  assert.equal(identity.reason, 'executed-position-missing');
  assert.equal(identity.selectedActionKey, 'move-to-8');
  assert.equal(identity.executedActionKey, '');
});

test('execution identity rejects a same-board alias and mismatched action key', async () => {
  const reviewer = await import('../bot-engine/long/reviewer.ts');
  const selected = candidate(8, 100, {}, 'selected-action');
  const decision = {
    selected,
    execution: {
      complete: true,
      executed: {
        after: structuredClone(selected.after),
        moves: [{ from: 12, to: 10, die: 2 }, { from: 10, to: 8, die: 2 }],
        experience: { contextKey: 'route|pipeline-fixture', actionKey: 'executed-alias' },
      },
    },
  };
  const identity = executionIdentity(decision, reviewer.afterPositionKey);
  assert.equal(identity.status, 'diverged');
  assert.equal(identity.reason, 'executed-action-differs-from-selected');
});

test('an attached raw score is rejected unless its semantics are explicit and consistent', () => {
  const replay = {
    coverage: { complete: true, expectedCandidates: 1, evaluatedCandidates: 1 },
    candidates: [{ ...candidate(8, 0), policyScore: undefined, score: 42 }],
  };
  let missing = missingReplayEvidence({ stateSnapshotV2: snapshot() }, replay);
  assert.ok(missing.includes('candidate-score-semantics-missing'));

  replay.scoreSemantics = 'long-static-evaluator-v1';
  replay.candidates[0].scoreSemantics = replay.scoreSemantics;
  missing = missingReplayEvidence({ stateSnapshotV2: snapshot() }, replay);
  assert.equal(missing.includes('candidate-score-semantics-missing'), false);
});

test('default review ignores a forged attached replay and regenerates its own cohort', async () => {
  const game = completeLossFixture();
  game.decisions[0].counterfactualReplay.outcomeUsed = true;
  game.decisions[0].counterfactualReplay.candidates[1].policyScore = 999999;
  let generated = 0;
  const decision = game.decisions[0];
  const selected = { ...structuredClone(decision.selected), policyScore: 150 };
  const inferior = candidate(6, 100, { outsideReduction: 1, homeEntryMoves: 1 });
  const report = await analyzeTrainingDocuments([game], {
    shadowReplayGenerator: async () => {
      generated += 1;
      return {
        ok: true,
        replay: {
          generatedBy: 'bounded-shadow-replay-test',
          reviewerVersion: 'long-counterfactual-review-v1',
          engineVersion: decision.engineVersion,
          experienceFingerprint: decision.experienceFingerprint,
          stateFingerprintV2: decision.stateFingerprintV2,
          stateSnapshotV2: structuredClone(decision.stateSnapshotV2),
          scoreSemantics: 'long-policy-evaluator-v1',
          learningEvidence: {
            schema: 'long-policy-counterfactual-evidence-v1',
            trusted: true,
            conservativeBoundsComplete: true,
          },
          outcomeUsed: false,
          coverage: { complete: true, expectedCandidates: 2, evaluatedCandidates: 2 },
          candidates: [selected, inferior],
        },
      };
    },
  });

  assert.equal(generated, 1);
  assert.equal(report.reviews[0].counterfactual.replaySource, 'bounded-shadow-replay');
  assert.equal(report.reviews[0].status, 'no-regret');
  assert.deepEqual(report.records, []);
});

test('even test-only attached evidence cannot launder outcome-derived scores', async () => {
  const game = completeLossFixture();
  game.decisions[0].counterfactualReplay.outcomeUsed = true;
  const report = await analyzeAttached([game]);

  assert.equal(report.reviews[0].status, 'insufficient-evidence');
  assert.equal(report.reviews[0].reason, 'replay-outcome-provenance-invalid');
  assert.deepEqual(report.records, []);
});
