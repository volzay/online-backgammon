const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCORE_SEMANTICS,
  afterPositionKey,
  clearRuntimeCache,
  generateLongBotShadowReplay,
  loadRuntime,
  snapshotFingerprintV2,
} = require('../scripts/generate-long-bot-shadow-replay');
const { analyzeTrainingDocuments } = require('../scripts/review-long-bot-losses');

function lateBearoffState(game) {
  const state = game.initialState('long');
  state.variant = 'long';
  state.phase = 'move';
  state.turn = 'dark';
  state.points = {
    13: { color: 'dark', count: 15 },
    24: { color: 'white', count: 15 },
  };
  state.bar = { white: 0, dark: 0 };
  state.off = { white: 0, dark: 0 };
  state.score = { white: 0, dark: 0 };
  state.dice = [2, 1];
  state.rolled = [2, 1];
  state.firstMoveDone = { white: true, dark: true };
  state.headPlayedThisTurn = { white: false, dark: false };
  state.turnMoves = [];
  state.history = [];
  return state;
}

function startingState(game) {
  const state = game.initialState('long');
  state.variant = 'long';
  state.phase = 'move';
  state.turn = 'dark';
  state.dice = [6, 5];
  state.rolled = [6, 5];
  state.firstMoveDone = { white: true, dark: true };
  state.headPlayedThisTurn = { white: false, dark: false };
  return state;
}

function productionFixture(stateFactory = lateBearoffState) {
  clearRuntimeCache();
  const runtime = loadRuntime();
  runtime.engine.setExperience([], 'fixture');
  runtime.engine.freezeExperience('shadow-replay-fixture');
  const state = stateFactory(runtime.game);
  assert.ok(runtime.engine.plan(state).length > 0);
  const decision = runtime.engine.consumeLastDecision();
  assert.ok(decision?.selected?.after);
  decision.execution = {
    complete: true,
    fallback: false,
    substituted: false,
    executedActionKey: decision.selected.experience.actionKey,
    executed: {
      moves: structuredClone(decision.selected.moves),
      after: structuredClone(decision.selected.after),
      experience: structuredClone(decision.selected.experience),
    },
  };
  const snapshot = runtime.engine.experienceReplaySnapshot();
  const replayExperience = {
    ...structuredClone(snapshot),
    complete: true,
    patternCount: snapshot.patterns.length,
    serializedChars: JSON.stringify(snapshot.patterns).length,
  };
  const game = {
    id: 'shadow-game-1',
    room_code: 'SHADOW-1',
    winner: 'white',
    bot_color: 'dark',
    result_type: 'normal',
    decisions: [decision],
    final_state: {
      analysis: { botMemory: { replayExperience } },
    },
  };
  // The production fixture used a frozen browser engine. The reviewer must
  // start from a clean runtime so applying the archived snapshot is explicit.
  clearRuntimeCache();
  return { game, decision };
}

test('bounded shadow replay evaluates every unique legal resulting board', async () => {
  const { game, decision } = productionFixture();
  const generated = await generateLongBotShadowReplay(game, decision);

  assert.equal(generated.ok, true);
  const { replay } = generated;
  assert.equal(replay.generatedBy, 'bounded-shadow-replay-v1');
  assert.equal(replay.scoreSemantics, SCORE_SEMANTICS);
  assert.equal(replay.scoreIncludesTacticalSearch, false);
  assert.equal(replay.scoreIncludesExperience, false);
  assert.equal(replay.outcomeUsed, false);
  assert.equal(replay.coverage.complete, true);
  assert.equal(replay.coverage.expectedCandidates, replay.candidates.length);
  assert.equal(replay.coverage.evaluatedCandidates, replay.candidates.length);
  assert.equal(replay.coverage.evaluatedSequences, replay.coverage.legalSequenceCount);
  assert.equal(replay.coverage.nodesUsed, replay.coverage.legalSequenceCount);
  assert.equal(
    new Set(replay.candidates.map(afterPositionKey)).size,
    replay.coverage.expectedCandidates,
  );
  assert.ok(replay.candidates.every(candidate => (
    Number.isFinite(candidate.score)
      && candidate.policyScore === undefined
      && candidate.scoreSemantics === SCORE_SEMANTICS
  )));
});

test('loss review CLI pipeline generates a missing replay without using outcome as a label', async () => {
  const { game } = productionFixture();
  const report = await analyzeTrainingDocuments([game]);

  assert.equal(report.outcomeUsed, false);
  assert.equal(report.summary.decisionsReviewed, 1);
  assert.equal(report.summary.insufficientEvidence, 0);
  assert.equal(report.reviews[0].counterfactual.replaySource, 'bounded-shadow-replay');
  assert.equal(report.reviews[0].counterfactual.scoreField, 'score');
  assert.equal(report.reviews[0].counterfactual.scoreSemantics, SCORE_SEMANTICS);
  assert.equal(report.reviews[0].counterfactual.learningEligible, false);
  assert.equal(report.reviews[0].counterfactual.diagnosticOnly, true);
  assert.equal(report.reviews[0].counterfactual.regretLcb, null);
  assert.equal(report.summary.causalRecords, 0);
  assert.deepEqual(report.records, []);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      report.reviews[0].counterfactual,
      'selectedPolicyScore',
    ),
    false,
  );
});

test('shadow replay fails closed on state tampering and frozen-memory mismatch', async () => {
  let fixture = productionFixture();
  fixture.decision.stateSnapshotV2.dice = [6, 6, 6, 6];
  let generated = await generateLongBotShadowReplay(fixture.game, fixture.decision);
  assert.equal(generated.ok, false);
  assert.equal(generated.reason, 'state-fingerprint-v2-mismatch');

  fixture = productionFixture();
  fixture.game.final_state.analysis.botMemory.replayExperience.fingerprint = 'lbe8-tampered';
  generated = await generateLongBotShadowReplay(fixture.game, fixture.decision);
  assert.equal(generated.ok, false);
  assert.equal(generated.reason, 'frozen-experience-identity-mismatch');
});

test('candidate and time resources are bounded and incomplete work is never reviewed', async () => {
  const { game, decision } = productionFixture(startingState);
  const generated = await generateLongBotShadowReplay(game, decision, {
    limits: {
      maxLegalSequences: 1,
      maxUniquePositions: 1,
      maxNodes: 1,
      maxElapsedMs: 5000,
    },
  });
  assert.equal(generated.ok, false);
  assert.equal(generated.status, 'insufficient-evidence');
  assert.equal(generated.reason, 'shadow-replay-legal-sequence-limit');
  assert.equal(generated.coverage.complete, false);
});

test('state fingerprint is canonical across JSON object key order', () => {
  const first = {
    schema: 'long-state-v2',
    turn: 'dark',
    points: {
      12: { color: 'dark', count: 2 },
      24: { color: 'white', count: 15 },
    },
    bar: { white: 0, dark: 0 },
    off: { white: 0, dark: 0 },
    dice: [2, 4],
  };
  const reordered = {
    dice: [2, 4],
    off: { dark: 0, white: 0 },
    bar: { dark: 0, white: 0 },
    points: {
      24: { count: 15, color: 'white' },
      12: { count: 2, color: 'dark' },
    },
    turn: 'dark',
    schema: 'long-state-v2',
  };

  assert.equal(snapshotFingerprintV2(first), snapshotFingerprintV2(reordered));
});
