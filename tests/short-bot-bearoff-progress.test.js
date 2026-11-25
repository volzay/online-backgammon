const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Synthetic positions exercise both board orientations without publishing
// private room archives or depending on a neural model's numeric estimates.
function runtime() {
  const context = { console, Date, Math };
  context.window = context;
  vm.createContext(context);
  for (const file of ['game.js', 'short-bot-engine.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  return { game: context.NarduGame, engine: context.NarduShortBotEngine };
}

function fixture(game, color, dice) {
  const state = game.initialState('short');
  const opponent = game.opponentOf(color);
  state.points = {};
  const point = distance => color === 'white' ? distance : 25 - distance;
  for (const [distance, count] of [[1, 2], [2, 1], [3, 4], [4, 1]]) {
    state.points[point(distance)] = { color, count };
  }
  state.points[point(24)] = { color: opponent, count: 7 };
  state.off = { [color]: 7, [opponent]: 8 };
  state.turn = color;
  state.phase = 'move';
  state.dice = [...dice];
  state.rolled = [...dice];
  return { state, point };
}

function analysisFor(shuffle, bearoff, gap = 0.009) {
  return {
    phase: 'race',
    moves: [
      { play: shuffle, equity: 0.4, score: 0.4 },
      { play: bearoff, equity: 0.4 - gap, score: 0.4 - gap },
    ],
  };
}

function play(game, state, plan) {
  const after = JSON.parse(JSON.stringify(state));
  for (const move of plan) {
    assert.equal(game.applyMove(after, move.from, move.die, { autoEnd: false }), true);
  }
  return after;
}

function decide(game, engine, state, analysis) {
  const sequences = game.bestMoveSequences(state, state.turn);
  const color = state.turn;
  // The production analyzer supplies final boards too. The adapter may retain
  // the opposite, equivalent move order after deduplicating legal sequences.
  const moves = analysis.moves.map(move => {
    const sequence = sequences.find(sequence => JSON.stringify(sequence.map(step => ({
      from: 24 - game.pathPos(color, step.from, state),
      to: step.bearOff ? 0 : 24 - game.pathPos(color, step.to, state),
    }))) === JSON.stringify(move.play));
    if (!sequence) return move;
    const after = play(game, state, sequence);
    const position = Array(26).fill(0);
    for (const [point, stack] of Object.entries(after.points)) {
      position[24 - game.pathPos(color, Number(point), after)] = stack.count
        * (stack.color === color ? 1 : -1);
    }
    return { ...move, position };
  });
  return engine.planFromWildbgAnalysis(state, { ...analysis, moves });
}

for (const color of ['white', 'dark']) {
  for (const large of [3, 5]) {
    for (const dice of [[1, large], [large, 1]]) {
      test(`near-equity ${color} bearoff takes two checkers on ${dice.join(':')}`, () => {
        const { game, engine } = runtime();
        const { state, point } = fixture(game, color, dice);
        const source = JSON.stringify(state);
        const from = large === 5 ? 4 : 3;
        const analysis = analysisFor(
          [{ from: 3, to: 2 }, { from, to: 0 }],
          [{ from, to: 0 }, { from: 1, to: 0 }],
        );
        const plan = decide(game, engine, state, analysis);
        const after = play(game, state, plan);
        const decision = engine.consumeLastDecision();
        assert.equal(after.off[color] - state.off[color], 2);
        assert.ok(plan.some(move => move.from === point(1) && move.die === 1));
        assert.equal(decision.selected.features.homeShuffleMoves, 0);
        assert.equal(decision.engine.choiceReason, 'near-equity-bearoff');
        assert.equal(decision.engine.selectedRank, 1);
        assert.equal(decision.engine.policyPhase, 'bearoff');
        assert.equal(decision.engineVersion, 'short-analytic-v6-bearoff-v1');
        assert.equal(JSON.stringify(state), source, 'planning must preserve the input state');
      });
    }
  }
}

test('bearoff progress does not override a materially stronger neural choice', () => {
  const { game, engine } = runtime();
  const { state } = fixture(game, 'white', [3, 1]);
  const plan = decide(game, engine, state, analysisFor(
    [{ from: 3, to: 2 }, { from: 3, to: 0 }],
    [{ from: 3, to: 0 }, { from: 1, to: 0 }],
    0.04,
  ));
  assert.equal(play(game, state, plan).off.white - state.off.white, 1);
  assert.equal(engine.consumeLastDecision().engine.choiceReason, 'wildbg-top');
});

test('contact bearoff retains tactical analysis instead of forcing extra checkers off', () => {
  const { game, engine } = runtime();
  const { state } = fixture(game, 'white', [3, 1]);
  delete state.points[2];
  state.off.white += 1;
  state.points[2] = { color: 'dark', count: 2 };
  state.points[24].count -= 2;
  const plan = decide(game, engine, state, analysisFor(
    [{ from: 4, to: 3 }, { from: 3, to: 0 }],
    [{ from: 3, to: 0 }, { from: 1, to: 0 }],
  ));
  assert.equal(play(game, state, plan).off.white - state.off.white, 1);
  const decision = engine.consumeLastDecision();
  assert.equal(decision.engine.policyPhase, 'contact');
  assert.equal(decision.engine.choiceReason, 'wildbg-top');
});

test('a mandatory home move is preserved when die one cannot bear off', () => {
  const { game, engine } = runtime();
  const { state } = fixture(game, 'white', [1, 5]);
  state.off.white += state.points[1].count;
  delete state.points[1];
  const analysis = analysisFor(
    [{ from: 3, to: 2 }, { from: 4, to: 0 }],
    [{ from: 4, to: 0 }, { from: 1, to: 0 }],
  );
  const plan = decide(game, engine, state, analysis);
  assert.equal(play(game, state, plan).off.white - state.off.white, 1);
  const decision = engine.consumeLastDecision();
  assert.equal(decision.engine.candidateCount, 1, 'an illegal extra bearoff must be rejected');
  assert.equal(decision.selected.features.homeShuffleMoves, 1);
});

test('experience cannot reverse a contact-free two-checker bearoff into a near-equity shuffle', () => {
  const { game, engine } = runtime();
  const { state } = fixture(game, 'white', [3, 1]);
  const analysis = analysisFor(
    [{ from: 3, to: 0 }, { from: 1, to: 0 }],
    [{ from: 3, to: 2 }, { from: 3, to: 0 }],
    0.005,
  );
  decide(game, engine, state, analysis);
  const baseline = engine.consumeLastDecision();
  engine.setExperience([
    { ...baseline.selected.experience, samples: 64, wins: 0, losses: 64, lossWeight: 64 },
    { ...baseline.alternatives[0].experience, samples: 64, wins: 64, losses: 0, winWeight: 64 },
  ], 'bearoff-regression');
  const plan = decide(game, engine, state, analysis);
  const decision = engine.consumeLastDecision();
  assert.equal(decision.experienceSize, 2);
  assert.ok(decision.selected.experienceAdjustment < 0);
  assert.ok(decision.alternatives[0].experienceAdjustment > 0);
  assert.equal(play(game, state, plan).off.white - state.off.white, 2);
});

for (const color of ['white', 'dark']) {
  test(`contact-free ${color} bearoff has no fictional risk or defensive point bonuses`, () => {
    const { game, engine } = runtime();
    const { state } = fixture(game, color, [3, 1]);
    const sequence = game.bestMoveSequences(state).find(sequence => (
      sequence.filter(move => move.bearOff).length === 2
    ));
    const after = play(game, state, sequence);
    const described = engine.describeSequence(state, sequence);
    assert.ok(described.features.madeGain < 0, 'taking a checker off breaks a made home point');
    assert.equal(described.features.exposureDelta, 0);
    assert.equal(described.features.opponentExposureGain, 0);
    const expected = engine.evaluateState(after, color)
      + described.features.offGain * 28000
      - Math.max(0, described.features.stackDelta) * 3500;
    assert.equal(described.baseScore, expected, 'a broken defensive point must not reduce the race score');
  });
}
