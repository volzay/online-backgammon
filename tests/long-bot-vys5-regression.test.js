const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const ROOT = path.join(__dirname, '..');
const LIVE_TURN_LIMIT_MS = 1500;
const EXPECTED_PLAN = [
  { from: 3, die: 1 },
  { from: 2, die: 1 },
  { from: 6, die: 1 },
  { from: 6, die: 1 },
];

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function vys5State() {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'dark',
    dice: [1, 1, 1, 1],
    rolled: [1, 1, 1, 1],
    points: {
      3: { color: 'dark', count: 1 },
      4: { color: 'white', count: 1 },
      5: { color: 'dark', count: 1 },
      6: { color: 'dark', count: 3 },
      7: { color: 'dark', count: 1 },
      8: { color: 'dark', count: 1 },
      9: { color: 'dark', count: 1 },
      10: { color: 'white', count: 3 },
      13: { color: 'white', count: 1 },
      14: { color: 'white', count: 2 },
      15: { color: 'white', count: 2 },
      16: { color: 'white', count: 1 },
      17: { color: 'dark', count: 3 },
      18: { color: 'white', count: 1 },
      19: { color: 'white', count: 1 },
      21: { color: 'dark', count: 1 },
      22: { color: 'dark', count: 1 },
      23: { color: 'dark', count: 2 },
      24: { color: 'white', count: 3 },
    },
    off: { white: 0, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
    winner: null,
  };
}

function runtime() {
  const context = {
    window: {},
    console,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, {
    filename: 'game.js',
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'long-bot-engine.js'), 'utf8'), context, {
    filename: 'long-bot-engine.js',
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'strong-bot.js'), 'utf8'), context, {
    filename: 'strong-bot.js',
  });
  return {
    game: context.window.NarduGame,
    engine: context.window.NarduLongBotEngine,
    bot: context.window.NarduStrongBot,
  };
}

function applyAndAssertLegal(game, source, plan) {
  const state = plain(source);
  plan.forEach((move) => {
    assert.equal(
      game.isValidMove(state, move.from, move.die),
      true,
      `${move.from} with die ${move.die} must remain legal after preceding moves`,
    );
    assert.ok(game.applyMove(state, move.from, move.die, { autoEnd: false }));
  });
  assert.deepEqual(Array.from(state.dice), []);
}

test('VYS5-WGNB double-one turn stays legal and finishes inside the live latency ceiling', {
  timeout: LIVE_TURN_LIMIT_MS + 3000,
}, () => {
  const { game, engine, bot } = runtime();
  const state = vys5State();

  assert.equal(game.legalNextMoves(plain(state), 'dark').length, 8);
  assert.equal(game.bestMoveSequences(plain(state), 'dark').length, 2679);

  const startedAt = performance.now();
  const plan = plain(bot.plan(plain(state), { liveTurnLatencyBudget: true }));
  const elapsedMs = performance.now() - startedAt;

  assert.deepEqual(plan, EXPECTED_PLAN);
  applyAndAssertLegal(game, state, plan);
  assert.ok(
    elapsedMs < LIVE_TURN_LIMIT_MS,
    `VYS5 hard-bot plan took ${Math.round(elapsedMs)}ms; expected <${LIVE_TURN_LIMIT_MS}ms`,
  );

  const decision = plain(engine.consumeLastDecision());
  assert.ok(decision, 'the production hard bot must preserve its decision record');
  assert.deepEqual(decision.replayInput.runtime, {
    strategyProfile: 'v25',
    maxCandidates: 16,
    initialSequenceLimit: 16,
    maxTacticalCandidates: 2,
    analysisNodeBudget: 58,
    weights: decision.replayInput.runtime.weights,
  });
  assert.ok(Object.keys(decision.replayInput.runtime.weights).length > 0);
  assert.ok(decision.selected.features.analysisNodesUsed <= 58);
  assert.equal(decision.selected.tactical?.distributionComplete, true);
  assert.equal(decision.selected.tactical?.rolls, 21);
  assert.equal(decision.selected.tactical?.distributionWeight, 36);
  assert.ok(decision.selected.tactical?.plies >= 2);
});

test('live doubles tactical budget admits only complete comparable reply distributions', () => {
  const { engine } = runtime();
  const state = vys5State();
  const common = {
    strategyProfile: 'v25',
    maxCandidates: 16,
    initialSequenceLimit: 16,
    maxTacticalCandidates: 2,
  };

  const insufficient = plain(engine.rank(plain(state), {
    ...common,
    analysisNodeBudget: 57,
  }));
  assert.ok(insufficient.length > 1);
  assert.equal(insufficient.some(candidate => candidate.tactical), false);

  const complete = plain(engine.rank(plain(state), {
    ...common,
    analysisNodeBudget: 58,
  }));
  assert.equal(complete.length, 2);
  assert.ok(complete.every(candidate => candidate.tactical?.distributionComplete === true));
  assert.ok(complete.every(candidate => candidate.tactical?.rolls === 21));
  assert.ok(complete.every(candidate => candidate.tactical?.distributionWeight === 36));
});

test('ordinary long turns retain the full production search envelope', () => {
  const context = {
    window: {},
    console,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, {
    filename: 'game.js',
  });

  let received = null;
  context.window.NarduLongBotEngine = {
    productionOptions: {
      strategyProfile: 'v25',
      maxCandidates: 64,
      initialSequenceLimit: 64,
      analysisNodeBudget: 480,
    },
    setExperience() {},
    freezeExperience() {},
    plan(_state, options) {
      received = plain(options);
      return [{ from: 12, die: 6 }, { from: 12, die: 5 }];
    },
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'strong-bot.js'), 'utf8'), context, {
    filename: 'strong-bot.js',
  });

  const state = vys5State();
  state.dice = [6, 5];
  state.rolled = [6, 5];
  context.window.NarduStrongBot.plan(state, { liveTurnLatencyBudget: true });

  assert.equal(received.maxCandidates, 64);
  assert.equal(received.initialSequenceLimit, 64);
  assert.equal(received.analysisNodeBudget, 480);
});
