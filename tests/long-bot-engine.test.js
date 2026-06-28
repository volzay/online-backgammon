const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
let cachedBrowserEngine = null;

function loadBrowserEngine() {
  if (cachedBrowserEngine) return cachedBrowserEngine;
  require("../scripts/build-long-bot-engine")();
  const context = {
    window: {},
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context, { filename: "game.js" });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "long-bot-engine.js"), "utf8"), context, { filename: "long-bot-engine.js" });
  cachedBrowserEngine = {
    game: context.window.NarduGame,
    engine: context.window.NarduLongBotEngine,
  };
  return cachedBrowserEngine;
}

function longState(points, overrides = {}) {
  return {
    variant: "long",
    phase: "move",
    turn: "dark",
    dice: [2, 3],
    rolled: [2, 3],
    points,
    off: { white: 0, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
    ...overrides,
  };
}

test("hard long engine is installed in browser bundle", () => {
  const { engine } = loadBrowserEngine();
  assert.equal(typeof engine.plan, "function");
  assert.equal(typeof engine.rank, "function");
  assert.equal(typeof engine.evaluateState, "function");
  assert.equal(typeof engine.consumeLastDecision, "function");
});

test("endgame plan prioritizes bearing off instead of shuffling home points", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    13: { color: "dark", count: 4 },
    14: { color: "dark", count: 3 },
    15: { color: "dark", count: 2 },
    16: { color: "dark", count: 2 },
    17: { color: "dark", count: 2 },
    18: { color: "dark", count: 2 },
  });

  const legal = game.bestMoveSequences(state, "dark").filter(sequence => sequence.length);
  const maxOff = Math.max(...legal.map(sequence => {
    const next = JSON.parse(JSON.stringify(state));
    sequence.forEach(move => game.applyMove(next, move.from, move.die, { autoEnd: false }));
    return next.off.dark;
  }));
  const plan = engine.plan(state);
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.equal(after.off.dark, maxOff);
});

test("evaluation rewards head support and penalizes trapped checkers", () => {
  const { engine } = loadBrowserEngine();
  const supported = longState({
    12: { color: "dark", count: 8 },
    11: { color: "dark", count: 2 },
    9: { color: "dark", count: 2 },
    7: { color: "dark", count: 2 },
    6: { color: "dark", count: 1 },
    24: { color: "white", count: 15 },
  });
  const trapped = longState({
    12: { color: "dark", count: 8 },
    11: { color: "white", count: 2 },
    10: { color: "white", count: 2 },
    9: { color: "white", count: 2 },
    8: { color: "white", count: 2 },
    7: { color: "white", count: 2 },
    6: { color: "white", count: 2 },
    5: { color: "dark", count: 7 },
  });

  assert.ok(engine.evaluateState(supported, "dark") > engine.evaluateState(trapped, "dark"));
});

test("evaluation prefers distributed checkers over home towers before the race", () => {
  const { engine } = loadBrowserEngine();
  const balanced = longState({
    12: { color: "dark", count: 3 },
    11: { color: "dark", count: 3 },
    10: { color: "dark", count: 3 },
    9: { color: "dark", count: 3 },
    8: { color: "dark", count: 3 },
    24: { color: "white", count: 15 },
  });
  const rushed = longState({
    12: { color: "dark", count: 11 },
    11: { color: "dark", count: 1 },
    10: { color: "dark", count: 1 },
    9: { color: "dark", count: 1 },
    8: { color: "dark", count: 1 },
    24: { color: "white", count: 15 },
  });

  assert.ok(engine.evaluateState(balanced, "dark") > engine.evaluateState(rushed, "dark"));
});

test("near-home checkers are both entered before home shuffles", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    20: { color: "dark", count: 1 },
    19: { color: "dark", count: 1 },
    18: { color: "dark", count: 2 },
    16: { color: "dark", count: 3 },
    14: { color: "dark", count: 4 },
    13: { color: "dark", count: 4 },
    1: { color: "white", count: 8 },
    2: { color: "white", count: 7 },
  }, {
    dice: [1, 2],
    rolled: [1, 2],
  });

  const legal = game.bestMoveSequences(state, "dark").filter(sequence => sequence.length);
  const maxHomeGain = Math.max(...legal.map(sequence => {
    const next = JSON.parse(JSON.stringify(state));
    sequence.forEach(move => game.applyMove(next, move.from, move.die, { autoEnd: false }));
    return countHome(next, "dark") - countHome(state, "dark");
  }));
  const plan = engine.plan(state);
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.equal(countHome(after, "dark") - countHome(state, "dark"), maxHomeGain);
  assert.equal(maxHomeGain, 2);
});

test("trap risk makes the bot escape before improving home points", () => {
  const { engine } = loadBrowserEngine();
  const state = longState({
    10: { color: "dark", count: 1 },
    18: { color: "dark", count: 3 },
    17: { color: "dark", count: 3 },
    16: { color: "dark", count: 3 },
    15: { color: "dark", count: 3 },
    14: { color: "dark", count: 2 },
    8: { color: "white", count: 2 },
    7: { color: "white", count: 2 },
    6: { color: "white", count: 2 },
    2: { color: "white", count: 9 },
  }, {
    dice: [4, 1],
    rolled: [4, 1],
  });

  const plan = engine.plan(state);
  assert.equal(JSON.stringify(plan), JSON.stringify([{ from: 10, die: 1 }, { from: 9, die: 4 }]));
});

test("head landing anchors are preserved when the opponent can immediately occupy them", () => {
  const { engine } = loadBrowserEngine();
  const state = longState({
    4: { color: "dark", count: 1 },
    7: { color: "dark", count: 3 },
    8: { color: "white", count: 1 },
    9: { color: "white", count: 1 },
    10: { color: "white", count: 1 },
    11: { color: "dark", count: 1 },
    12: { color: "dark", count: 8 },
    14: { color: "white", count: 1 },
    15: { color: "dark", count: 1 },
    18: { color: "dark", count: 1 },
    22: { color: "white", count: 1 },
    23: { color: "white", count: 1 },
    24: { color: "white", count: 9 },
  }, {
    dice: [6, 5],
    rolled: [6, 5],
  });

  const plan = engine.plan(state, { maxCandidates: 300 });
  assert.ok(!plan.some(move => move.from === 11));
  assert.ok(plan.some(move => move.from === 7 && move.die === 5));
});

test("XP7E-F64Y move 62 blocks another opponent head exit instead of opening one", () => {
  const { engine } = loadBrowserEngine();
  const state = longState({
    4: { color: "dark", count: 1 },
    6: { color: "dark", count: 1 },
    7: { color: "dark", count: 2 },
    8: { color: "white", count: 1 },
    9: { color: "white", count: 1 },
    10: { color: "white", count: 1 },
    11: { color: "white", count: 1 },
    12: { color: "dark", count: 7 },
    16: { color: "white", count: 1 },
    17: { color: "dark", count: 2 },
    18: { color: "dark", count: 1 },
    19: { color: "dark", count: 1 },
    24: { color: "white", count: 10 },
  }, {
    dice: [2, 2, 2, 2],
    rolled: [2, 2, 2, 2],
  });

  const plan = engine.plan(state, { maxCandidates: 48, timeLimitMs: 900 });
  assert.equal(JSON.stringify(plan), JSON.stringify([
    { from: 7, die: 2 },
    { from: 5, die: 2 },
    { from: 3, die: 2 },
    { from: 1, die: 2 },
  ]));
  assert.ok(!plan.some(move => move.from === 19));

  const decision = engine.consumeLastDecision();
  assert.match(decision.id, /^lb3-/);
  assert.equal(decision.engineVersion, "long-linear-v5");
  assert.equal(decision.selected.moves.length, 4);
  assert.ok(decision.alternatives.length > 0);
  assert.equal(engine.consumeLastDecision(), null);
});

test("XP7E-F64Y move 299 carries the last outside checker through the home entry", () => {
  const { engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "white", count: 1 },
    2: { color: "dark", count: 2 },
    3: { color: "dark", count: 1 },
    13: { color: "dark", count: 3 },
    14: { color: "dark", count: 4 },
    15: { color: "dark", count: 2 },
    16: { color: "dark", count: 2 },
    20: { color: "dark", count: 1 },
  }, {
    dice: [3, 4],
    rolled: [3, 4],
    off: { white: 14, dark: 0 },
  });

  const plan = engine.plan(state, { maxCandidates: 48, timeLimitMs: 900 });
  assert.equal(JSON.stringify(plan), JSON.stringify([
    { from: 20, die: 3 },
    { from: 17, die: 4 },
  ]));
});

test("SX6K-4V5S move 229 preserves the only gateway for trapped checkers", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "white", count: 2 },
    2: { color: "white", count: 2 },
    3: { color: "white", count: 4 },
    4: { color: "white", count: 1 },
    5: { color: "dark", count: 2 },
    6: { color: "white", count: 3 },
    7: { color: "white", count: 1 },
    8: { color: "white", count: 1 },
    9: { color: "white", count: 1 },
    11: { color: "dark", count: 2 },
    13: { color: "dark", count: 2 },
    14: { color: "dark", count: 2 },
    15: { color: "dark", count: 1 },
    16: { color: "dark", count: 2 },
    17: { color: "dark", count: 2 },
    18: { color: "dark", count: 2 },
  }, {
    dice: [5, 5, 5, 5],
    rolled: [5, 5, 5, 5],
  });

  const plan = engine.plan(state, { maxCandidates: 48, timeLimitMs: 900 });
  assert.equal(plan.filter(move => move.from === 5).length, 1);
  assert.ok(plan.some(move => move.from === 18 && move.die === 5));

  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));
  assert.deepEqual(JSON.parse(JSON.stringify(after.points[5])), { color: "dark", count: 1 });
  assert.equal(after.points[14]?.color, "dark");
  assert.equal(after.points[14]?.count, 3);
});

test("348Z-ELLM move 126 keeps a two-step gateway open for the head", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "white", count: 1 },
    2: { color: "white", count: 1 },
    3: { color: "dark", count: 4 },
    4: { color: "dark", count: 2 },
    5: { color: "dark", count: 2 },
    6: { color: "white", count: 1 },
    7: { color: "white", count: 1 },
    9: { color: "white", count: 1 },
    11: { color: "white", count: 2 },
    12: { color: "dark", count: 4 },
    13: { color: "dark", count: 1 },
    14: { color: "dark", count: 2 },
    15: { color: "white", count: 1 },
    17: { color: "white", count: 2 },
    18: { color: "white", count: 1 },
    21: { color: "white", count: 1 },
    22: { color: "white", count: 1 },
    23: { color: "white", count: 1 },
    24: { color: "white", count: 1 },
  }, {
    dice: [1, 1, 1, 1],
    rolled: [1, 1, 1, 1],
  });

  const plan = engine.plan(state, { maxCandidates: 48, timeLimitMs: 900 });
  assert.equal(plan.filter(move => move.from === 5).length, 1);

  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));
  assert.deepEqual(JSON.parse(JSON.stringify(after.points[5])), { color: "dark", count: 1 });
  assert.equal(after.points[12]?.count, 4);
});

function countHome(state, color) {
  const path = color === "white"
    ? [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
    : [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13];
  return Object.entries(state.points || {}).reduce((total, [point, data]) => {
    if (data.color !== color) return total;
    const pos = path.indexOf(Number(point));
    return total + (pos >= 18 && pos <= 23 ? data.count : 0);
  }, state.off?.[color] || 0);
}
