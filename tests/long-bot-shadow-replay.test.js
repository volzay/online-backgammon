const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_LIMITS,
  SCORE_SEMANTICS,
  afterPositionKey,
  applyLegalSequence,
  clearRuntimeCache,
  generateLongBotShadowReplay,
  loadRuntime,
  snapshotFingerprintV2,
  stateFromSnapshot,
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

function productionFixture(stateFactory = lateBearoffState, runtimeOptions = {}) {
  clearRuntimeCache();
  const runtime = loadRuntime();
  runtime.engine.setExperience([], 'fixture');
  runtime.engine.freezeExperience('shadow-replay-fixture');
  const state = stateFactory(runtime.game);
  assert.ok(runtime.engine.plan(state, runtimeOptions).length > 0);
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

function jsysLargeDoublesStates() {
  const base = {
    variant: 'long', phase: 'move', turn: 'dark',
    off: { white: 0, dark: 0 }, bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 }, turnMoves: [], history: [],
    firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false }, winner: null,
  };
  return [
    {
      ...base, dice: [3, 3, 3, 3], rolled: [3, 3, 3, 3],
      points: {
        1: { color: 'white', count: 3 }, 2: { color: 'dark', count: 2 },
        3: { color: 'dark', count: 2 }, 4: { color: 'white', count: 5 },
        5: { color: 'white', count: 2 }, 6: { color: 'dark', count: 1 },
        8: { color: 'white', count: 1 }, 12: { color: 'white', count: 1 },
        13: { color: 'white', count: 1 }, 14: { color: 'white', count: 1 },
        15: { color: 'white', count: 1 }, 17: { color: 'dark', count: 4 },
        18: { color: 'dark', count: 2 }, 21: { color: 'dark', count: 1 },
        22: { color: 'dark', count: 1 }, 23: { color: 'dark', count: 1 },
        24: { color: 'dark', count: 1 },
      },
    },
    {
      ...base, dice: [3, 3, 3, 3], rolled: [3, 3, 3, 3],
      points: {
        1: { color: 'white', count: 3 }, 2: { color: 'dark', count: 1 },
        3: { color: 'dark', count: 2 }, 4: { color: 'white', count: 6 },
        5: { color: 'white', count: 3 }, 6: { color: 'dark', count: 1 },
        12: { color: 'white', count: 1 }, 13: { color: 'white', count: 1 },
        14: { color: 'white', count: 1 }, 16: { color: 'dark', count: 1 },
        17: { color: 'dark', count: 4 }, 18: { color: 'dark', count: 3 },
        20: { color: 'dark', count: 2 }, 21: { color: 'dark', count: 1 },
      },
    },
    {
      ...base, dice: [1, 1, 1, 1], rolled: [1, 1, 1, 1],
      points: {
        1: { color: 'white', count: 3 }, 2: { color: 'dark', count: 1 },
        3: { color: 'dark', count: 1 }, 4: { color: 'white', count: 6 },
        5: { color: 'white', count: 4 }, 6: { color: 'dark', count: 1 },
        12: { color: 'white', count: 1 }, 13: { color: 'white', count: 1 },
        15: { color: 'dark', count: 1 }, 16: { color: 'dark', count: 1 },
        17: { color: 'dark', count: 4 }, 18: { color: 'dark', count: 3 },
        20: { color: 'dark', count: 2 }, 21: { color: 'dark', count: 1 },
      },
    },
  ];
}

function stateWithoutHistoryTimestamps(state) {
  const normalized = JSON.parse(JSON.stringify(state));
  normalized.history = normalized.history.map(({ at, ...entry }) => {
    assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    return entry;
  });
  return normalized;
}

test('fast shadow transitions match public applyMove across complete and large long cohorts', () => {
  const publicGame = loadRuntime().game;
  const positions = [
    lateBearoffState(publicGame),
    ...[jsysLargeDoublesStates()[0], jsysLargeDoublesStates()[2]]
      .map(state => ({ ...stateFromSnapshot({ ...state, schema: 'long-state-v2' }), startedAt: 1 })),
  ];
  for (const [positionIndex, position] of positions.entries()) {
    const legal = publicGame.bestMoveSequences(structuredClone(position), position.turn)
      .filter(sequence => sequence.length > 0);
    const sampleIndexes = legal.length <= 20
      ? legal.map((_, index) => index)
      : [...new Set([0, 1, 2, Math.floor(legal.length / 4), Math.floor(legal.length / 2),
        Math.floor(legal.length * 3 / 4), legal.length - 3, legal.length - 2, legal.length - 1])];
    assert.equal(positionIndex === 0 ? sampleIndexes.length === legal.length : legal.length > 512, true);
    for (const index of sampleIndexes) {
      const sequence = legal[index];
      const publicAfter = structuredClone(position);
      for (const move of sequence) {
        assert.equal(publicGame.applyMove(publicAfter, move.from, move.die, { autoEnd: false }), true,
          `public move failed at position ${positionIndex}, sequence ${index}`);
      }
      const fastAfter = applyLegalSequence(publicGame, position, sequence);
      assert.ok(fastAfter, `fast move failed at position ${positionIndex}, sequence ${index}`);
      assert.deepEqual(stateWithoutHistoryTimestamps(fastAfter),
        stateWithoutHistoryTimestamps(publicAfter),
        `position ${positionIndex}, sequence ${index}`);
    }
  }
});

test('JSYS late doubles enumerate complete legal positions under an explicit bounded review budget', async () => {
  const runtimeOptions = {
    strategyProfile: 'v25', maxCandidates: 16, initialSequenceLimit: 16,
    maxTacticalCandidates: 2, analysisNodeBudget: 58,
  };
  const expected = [
    { sequences: 1734, positions: 120 },
    { sequences: 1082, positions: 87 },
    { sequences: 1777, positions: 132 },
  ];
  assert.equal(DEFAULT_LIMITS.maxLegalSequences, 2048);
  assert.equal(DEFAULT_LIMITS.maxNodes, 2048);
  assert.equal(DEFAULT_LIMITS.maxUniquePositions, 256);
  for (const [index, state] of jsysLargeDoublesStates().entries()) {
    const { game, decision } = productionFixture(() => state, runtimeOptions);
    const generated = await generateLongBotShadowReplay(game, decision, {
      limits: { maxElapsedMs: 30000 },
    });
    assert.equal(generated.ok, true, `fixture ${index + 1}: ${generated.reason || ''}`);
    assert.equal(generated.replay.coverage.complete, true);
    assert.equal(generated.replay.coverage.legalSequenceCount, expected[index].sequences);
    assert.equal(generated.replay.coverage.expectedCandidates, expected[index].positions);
    assert.equal(generated.replay.coverage.evaluatedSequences,
      generated.replay.coverage.legalSequenceCount);
    assert.equal(generated.replay.resourceLimits.maxLegalSequences, 2048);
    assert.equal(generated.replay.resourceLimits.maxNodes, 2048);
    assert.equal(generated.replay.resourceLimits.maxUniquePositions, 256);
    assert.ok(generated.replay.coverage.elapsedMs < 30000);
    if (index === 0 || index === 2) {
      // Independently compare the generated chosen board with the public
      // move path, which enforces maximum-use legality at each intermediate
      // state. The replay's fast native validator must reach the same board.
      const publicGame = loadRuntime().game;
      const publicAfter = structuredClone(state);
      for (const move of decision.selected.moves) {
        assert.equal(publicGame.applyMove(publicAfter, move.from, move.die, { autoEnd: false }), true);
      }
      assert.equal(afterPositionKey(publicAfter), afterPositionKey(decision.selected));
      assert.ok(generated.replay.candidates.some(candidate => (
        afterPositionKey(candidate) === afterPositionKey(publicAfter)
      )));
    }
    if (index === 0) {
      const nodeLimited = await generateLongBotShadowReplay(game, decision, {
        limits: { maxNodes: 1024, maxElapsedMs: 120000 },
      });
      assert.equal(nodeLimited.ok, false);
      assert.equal(nodeLimited.reason, 'shadow-replay-node-limit');
      assert.equal(nodeLimited.coverage.complete, false);
      assert.equal(nodeLimited.coverage.requiredNodes, 1734);
      const timeLimited = await generateLongBotShadowReplay(game, decision, {
        limits: { maxElapsedMs: 1 },
      });
      assert.equal(timeLimited.ok, false);
      assert.equal(timeLimited.reason, 'shadow-replay-time-limit');
    }
  }
});

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
