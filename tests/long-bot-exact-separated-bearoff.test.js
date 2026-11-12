const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const gameSource = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
const engineBundle = fs.readFileSync(path.join(root, 'long-bot-engine.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function runtime(workBudget) {
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY);
  Object.assign(context, { window: {}, Date, Math });
  vm.runInContext(gameSource, context);
  let bundle = engineBundle.replace(
    /\n\}\(\)\);\s*$/,
    '\nwindow.bearoffTest = { projectSeparatedBearoff, separatedBearoffOutcomes, solveSeparatedBearoff, createNarduGameAdapter };\n}());\n',
  );
  assert.notEqual(bundle, engineBundle, 'locate the generated engine scope');
  if (workBudget !== undefined) {
    const limited = bundle.replace('const BEAROFF_MAX_WORK = 2000000;',
      `const BEAROFF_MAX_WORK = ${workBudget};`);
    assert.notEqual(limited, bundle, 'locate the deterministic work limit');
    bundle = limited;
  }
  vm.runInContext(bundle, context);
  return context.window;
}

function position(game, color, own, opponent, dice) {
  const other = color === 'white' ? 'dark' : 'white';
  const state = game.initialState('long');
  Object.assign(state, { points: {}, turn: color, phase: 'roll', firstMoveDone: { white: true, dark: true } });
  for (const [actor, distances] of [[color, own], [other, opponent]]) {
    state.off[actor] = 15 - distances.length;
    for (const distance of distances) {
      const point = actor === 'white' ? distance : distance + 12;
      state.points[point] ||= { color: actor, count: 0 };
      state.points[point].count++;
    }
  }
  game.applyRoll(state, dice);
  return state;
}

const original = [6, 4, 4, 3];
const opponent = [6, 6, 1, 1];
const dice = [2, 5];

for (const color of ['white', 'dark']) {
  test(`separated race maximizes exact game wins for ${color}`, () => {
    const { NarduGame: game, NarduLongBotEngine: engine } = runtime();
    const state = position(game, color, original, opponent, dice);
    const offset = color === 'white' ? 0 : 12;
    const before = clone(state);
    const plan = engine.plan(state, { strategyProfile: 'v25' });
    const selected = engine.consumeLastDecision().selected;
    assert.deepEqual(clone(state), before, 'planning does not mutate the live board');
    assert.deepEqual(clone(plan), [{ from: 4 + offset, die: 2 }, { from: 6 + offset, die: 5 }]);
    assert.ok(game.bestMoveSequences(state, color).some(sequence => (
      JSON.stringify(sequence.map(({ from, die }) => ({ from, die }))) === JSON.stringify(plan)
    )), 'selected sequence is a native complete legal turn');
    assert.equal(selected.features.offGain, 0);
    assert.ok(Math.abs(selected.features.exactBearoffWinProbability - 0.6877666196244294) < 1e-12);
    assert.ok(Math.abs(selected.features.previousBearoffWinProbability - 0.6350217359434589) < 1e-12);
  });
}

test('home projection matches native moves for all throws, including overshoots and doubles', () => {
  const { NarduGame: game, bearoffTest } = runtime();
  const { projectSeparatedBearoff, separatedBearoffOutcomes, createNarduGameAdapter } = bearoffTest;
  const adapter = createNarduGameAdapter(game, { generatedSequenceFastPath: true });

  for (const color of ['white', 'dark']) {
    for (const shape of [[1], [6, 1], [5, 3, 1], [6, 6, 6, 6], original]) {
      for (let first = 1; first <= 6; first++) {
        for (let second = first; second <= 6; second++) {
          const rolled = first === second ? Array(4).fill(first) : [first, second];
          const state = position(game, color, shape, opponent, rolled);
          const board = projectSeparatedBearoff(state, color);
          const projected = separatedBearoffOutcomes(board, [first, second], () => {});
          const native = game.bestMoveSequences(state, color).map(moves => (
            projectSeparatedBearoff(adapter.applySequence(state, moves, color), color)
          ));
          assert.deepEqual([...new Set(projected)].sort(), [...new Set(native)].sort(),
            `${color} ${shape} on ${rolled}`);
        }
      }
    }
  }
});

test('exact race respects the v25 scope and falls back if the proof exceeds its work bound', () => {
  const { NarduGame: game, NarduLongBotEngine: engine } = runtime();
  const small = position(game, 'white', original, opponent, dice);
  assert.equal(engine.rank(small, { strategyProfile: 'v19' })[0].features.exactBearoffWinProbability, undefined);

  const contact = position(game, 'white', [7, 4, 4, 3], opponent, dice);
  assert.equal(engine.rank(contact)[0].features.exactBearoffWinProbability, undefined);
  const five = position(game, 'white', [...original, 1], opponent, dice);
  assert.equal(engine.rank(five)[0].features.exactBearoffWinProbability, undefined);

  const limited = runtime(1);
  const state = position(limited.NarduGame, 'white', original, opponent, dice);
  const selected = limited.NarduLongBotEngine.rank(state)[0];
  assert.equal(selected.features.exactBearoffWinProbability, undefined);
  assert.equal(selected.features.offGain, 1);
  assert.deepEqual(clone(selected.sequence.map(({ from, to, die }) => [from, to, die])), [[6, 4, 2], [4, 0, 5]]);
});
