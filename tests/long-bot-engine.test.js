const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

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

function tacticalThreatState() {
  return longState({
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
}

test("hard long engine is installed in browser bundle", () => {
  const { engine } = loadBrowserEngine();
  assert.equal(typeof engine.plan, "function");
  assert.equal(typeof engine.rank, "function");
  assert.equal(typeof engine.evaluateState, "function");
  assert.equal(typeof engine.consumeLastDecision, "function");
  assert.equal(typeof engine.setExperience, "function");
  assert.equal(typeof engine.experienceSize, "function");
});

test("learned profile cannot destabilize the long engine weights", () => {
  let capturedOptions = null;
  let requestedKey = null;
  const context = {
    window: {
      localStorage: {
        getItem(key) {
          requestedKey = key;
          return JSON.stringify({
            headBlock: 1.85,
            headEscape: 2.2,
            routeControl: 1.8,
            preserveHeadLandings: 1.95,
            avoidRush: 1.75,
            avoidTowers: 1.7,
          });
        },
        setItem() {},
      },
      NarduLongBotEngine: {
        plan(_state, options) {
          capturedOptions = options;
          return [{ from: 12, die: 1 }];
        },
      },
    },
    console,
    Date,
    Math,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "strong-bot.js"), "utf8"), context, {
    filename: "strong-bot.js",
  });

  context.window.NarduStrongBot.plan(longState({
    12: { color: "dark", count: 15 },
    24: { color: "white", count: 15 },
  }, {
    dice: [1, 2],
    rolled: [1, 2],
  }));

  assert.equal(requestedKey, "narduh-strong-bot-profile-v5");
  assert.ok(capturedOptions);
  const bases = {
    opponentHeadFreedom: 48000,
    headLandingExposure: 62000,
    headRelease: 9800,
    foothold: 4300,
    homeEntry: 145000,
    rushPenalty: 12500,
    trapRisk: 62000,
    escapeGatewayRisk: 800000,
    distribution: 780,
  };
  Object.entries(bases).forEach(([key, base]) => {
    assert.ok(capturedOptions.weights[key] <= base * 1.08 + 0.001, key);
    assert.ok(capturedOptions.weights[key] >= base * 0.96 - 0.001, key);
  });
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
  const state = tacticalThreatState();

  const plan = engine.plan(state, { maxCandidates: 300 });
  assert.ok(!plan.some(move => move.from === 11));
  assert.ok(plan.some(move => move.from === 7 && move.die === 5));
});

test("v13 learned local mistakes materially change tactical ranking", () => {
  const { engine } = loadBrowserEngine();
  const state = tacticalThreatState();
  engine.setExperience([], "tactical-regression");
  const baseline = engine.rank(state, { maxCandidates: 300, timeLimitMs: 3000 });
  const tacticalCandidate = baseline.find(candidate => candidate.tactical?.worstImpact < -4000000);
  const descriptor = tacticalCandidate?.experience;

  assert.ok(tacticalCandidate);
  assert.ok(descriptor?.mistakeSeverity > 0);
  engine.setExperience([{
    contextKey: descriptor.contextKey,
    actionKey: descriptor.actionKey,
    samples: 64,
    losses: 64,
    lossWeight: 64,
    severeLosses: 48,
    signalWeight: 256,
  }], "tactical-regression");

  const learned = engine.rank(state, { maxCandidates: 300, timeLimitMs: 3000 });
  const matching = learned.find(candidate => (
    candidate.experience?.contextKey === descriptor.contextKey
    && candidate.experience?.actionKey === descriptor.actionKey
    && candidate.tactical
  ));
  assert.ok(matching);
  assert.ok(matching.experienceAdjustment < -5000000);
  engine.setExperience([], "tactical-regression");
});

test("v13 does not blame a safe opening action for a later game loss", () => {
  const { engine } = loadBrowserEngine();
  const state = tacticalThreatState();
  const baseline = engine.rank(state, { maxCandidates: 300, timeLimitMs: 3000 });
  const descriptor = baseline[0].experience;

  engine.setExperience([{
    contextKey: descriptor.contextKey,
    actionKey: descriptor.actionKey,
    samples: 48,
    losses: 0,
    lossWeight: 0,
    severeLosses: 0,
    signalWeight: 0,
  }], "safe-opening");

  const learned = engine.rank(state, { maxCandidates: 300, timeLimitMs: 3000 });
  const matching = learned.find(candidate => candidate.experience?.actionKey === descriptor.actionKey);
  assert.ok(matching);
  assert.ok(matching.experienceAdjustment >= 0);
  engine.setExperience([], "safe-opening");
});

test("v13 transfers repeated mistakes across similar strategic contexts", () => {
  const { engine } = loadBrowserEngine();
  const state = tacticalThreatState();
  const baseline = engine.rank(state, { maxCandidates: 300, timeLimitMs: 3000 });
  const candidate = baseline.find(item => item.experience?.familyActionKey);
  const descriptor = candidate.experience;
  const neighboringContext = descriptor.contextKey.replace(
    /\|pd\d+$/,
    descriptor.contextKey.endsWith("|pd0") ? "|pd4" : "|pd0",
  );

  engine.setExperience([{
    contextKey: neighboringContext,
    actionKey: descriptor.familyActionKey,
    samples: 32,
    losses: 22,
    lossWeight: 30,
    severeLosses: 10,
    signalWeight: 74,
  }], "strategic-transfer");

  const learned = engine.rank(state, { maxCandidates: 300, timeLimitMs: 3000 });
  const matching = learned.find(item => (
    item.experience?.familyActionKey === descriptor.familyActionKey
    && item.experience?.contextKey === descriptor.contextKey
  ));
  assert.ok(matching);
  assert.ok(matching.experienceAdjustment < -5000000);
  engine.setExperience([], "strategic-transfer");
});

test("v13 searches four plies through two opponent turns", async () => {
  const { createLongBotEngine } = await import(pathToFileURL(
    path.join(ROOT, "bot-engine/long/engine.ts"),
  ).href);
  let maxSearchDepth = 0;
  const adapter = {
    legalSequences(state, color) {
      const depth = Number(state.searchDepth) || 0;
      if (depth === 0 && color === "dark") {
        return [
          [{ from: 12, to: 11, die: 1 }],
          [{ from: 12, to: 10, die: 2 }],
        ];
      }
      const entry = Object.entries(state.points).find(([, stack]) => stack.color === color);
      if (!entry || depth >= 4) return [];
      const from = Number(entry[0]);
      const to = color === "dark"
        ? (from === 1 ? 24 : from - 1)
        : (from === 24 ? 23 : from - 1);
      return [
        [{ from, to, die: 1 }],
        [{ from, to, die: 2 }],
      ];
    },
    applySequence(state, sequence, color) {
      const next = JSON.parse(JSON.stringify(state));
      sequence.forEach(move => {
        const source = next.points[move.from];
        source.count -= 1;
        if (!source.count) delete next.points[move.from];
        const target = next.points[move.to];
        if (target?.color === color) target.count += 1;
        else next.points[move.to] = { color, count: 1 };
      });
      next.searchDepth = (Number(state.searchDepth) || 0) + 1;
      maxSearchDepth = Math.max(maxSearchDepth, next.searchDepth);
      return next;
    },
  };
  const engine = createLongBotEngine(adapter, { timeLimitMs: 1000 });
  const state = longState({
    12: { color: "dark", count: 15 },
    24: { color: "white", count: 15 },
  }, { dice: [1, 2], rolled: [1, 2], searchDepth: 0 });

  const ranked = engine.rank(state, "dark", { maxCandidates: 8, timeLimitMs: 1000 });
  const deepCandidate = ranked.find(candidate => candidate.tactical?.plies === 4);

  assert.equal(maxSearchDepth, 4);
  assert.ok(deepCandidate);
  assert.ok(deepCandidate.tactical.recoveryRolls > 0);
  assert.ok(deepCandidate.tactical.continuationRolls > 0);
});

test("SNUQ-8DQC saves the route instead of entering home and enabling a six-point fence", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "dark", count: 1 },
    3: { color: "dark", count: 3 },
    4: { color: "dark", count: 1 },
    5: { color: "dark", count: 1 },
    6: { color: "dark", count: 6 },
    8: { color: "white", count: 2 },
    9: { color: "white", count: 1 },
    10: { color: "white", count: 1 },
    11: { color: "white", count: 1 },
    12: { color: "dark", count: 1 },
    13: { color: "white", count: 1 },
    14: { color: "white", count: 1 },
    15: { color: "white", count: 1 },
    16: { color: "white", count: 1 },
    18: { color: "dark", count: 1 },
    19: { color: "white", count: 1 },
    20: { color: "white", count: 1 },
    21: { color: "dark", count: 1 },
    22: { color: "white", count: 2 },
    23: { color: "white", count: 1 },
    24: { color: "white", count: 1 },
  }, { dice: [1, 3], rolled: [1, 3] });

  const plan = engine.plan(state, { maxCandidates: 64, timeLimitMs: 2400 });
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.ok(!plan.some(move => move.from === 21));
  assert.ok(Math.max(...Object.values(after.points)
    .filter(stack => stack.color === "dark")
    .map(stack => stack.count)) < 6);
});

test("SU9F-5VFB turn 25 minimizes the tower under the opponent fence", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "white", count: 1 },
    4: { color: "dark", count: 1 },
    5: { color: "white", count: 2 },
    6: { color: "white", count: 1 },
    7: { color: "white", count: 1 },
    8: { color: "white", count: 3 },
    9: { color: "white", count: 2 },
    10: { color: "white", count: 1 },
    11: { color: "dark", count: 2 },
    12: { color: "dark", count: 2 },
    13: { color: "white", count: 1 },
    14: { color: "dark", count: 5 },
    15: { color: "white", count: 1 },
    16: { color: "white", count: 1 },
    17: { color: "dark", count: 4 },
    18: { color: "white", count: 1 },
    19: { color: "dark", count: 1 },
  }, { dice: [5, 3], rolled: [5, 3] });
  const towerSize = position => Math.max(...Object.entries(position.points)
    .filter(([point, stack]) => stack.color === "dark" && Number(point) !== 12)
    .map(([, stack]) => Number(stack.count) || 0));
  const legal = game.bestMoveSequences(state, "dark").filter(sequence => sequence.length);
  const minimumTower = Math.min(...legal.map(sequence => {
    const after = JSON.parse(JSON.stringify(state));
    sequence.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));
    return towerSize(after);
  }));
  const plan = engine.plan(state, { maxCandidates: 300, timeLimitMs: 3600 });
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.equal(towerSize(after), minimumTower);
  assert.ok(towerSize(after) < 7);
});

test("Y9X6-QCC3 move 25 does not add two more checkers to the six-checker tower", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "dark", count: 3 },
    2: { color: "white", count: 1 },
    3: { color: "dark", count: 1 },
    4: { color: "dark", count: 1 },
    5: { color: "dark", count: 1 },
    6: { color: "dark", count: 1 },
    7: { color: "white", count: 1 },
    9: { color: "white", count: 2 },
    10: { color: "white", count: 2 },
    11: { color: "dark", count: 1 },
    13: { color: "white", count: 1 },
    14: { color: "white", count: 1 },
    15: { color: "white", count: 1 },
    16: { color: "white", count: 1 },
    17: { color: "white", count: 2 },
    18: { color: "dark", count: 6 },
    19: { color: "white", count: 1 },
    20: { color: "white", count: 1 },
    21: { color: "white", count: 1 },
    24: { color: "dark", count: 1 },
  }, {
    dice: [6, 6, 6, 6],
    rolled: [6, 6],
  });

  const plan = engine.plan(state, { maxCandidates: 300, timeLimitMs: 3000 });
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.ok(
    Number(after.points[18]?.count || 0) <= 6,
    "tower on point 18 grew to " + Number(after.points[18]?.count || 0) + ": " + JSON.stringify(plan),
  );
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
  assert.match(decision.id, /^lb4-/);
  assert.equal(decision.engineVersion, "long-analytic-v13");
  assert.equal(decision.selected.moves.length, 4);
  assert.ok(decision.selected.experience);
  assert.ok(decision.alternatives.length > 0);
  assert.equal(engine.consumeLastDecision(), null);
});

test("XP7E-F64Y move 299 enters one checker and advances another outside checker", () => {
  const { game, engine } = loadBrowserEngine();
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

  const outsideBefore = countOutsideHome(state, "dark");
  const plan = engine.plan(state, { maxCandidates: 48, timeLimitMs: 900 });
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));
  assert.ok(plan.some(move => move.from === 20));
  assert.equal(countOutsideHome(after, "dark"), outsideBefore - 1);
  assert.ok(!plan.some(move => move.from === 17));
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

test("X383-UNU9 move 118 enters a lagging checker instead of improving the home board", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "dark", count: 1 },
    7: { color: "white", count: 1 },
    8: { color: "white", count: 1 },
    9: { color: "white", count: 1 },
    10: { color: "white", count: 1 },
    11: { color: "white", count: 1 },
    12: { color: "dark", count: 5 },
    13: { color: "dark", count: 1 },
    14: { color: "white", count: 2 },
    15: { color: "white", count: 1 },
    16: { color: "white", count: 1 },
    17: { color: "dark", count: 2 },
    18: { color: "dark", count: 5 },
    19: { color: "white", count: 5 },
    23: { color: "dark", count: 1 },
    24: { color: "white", count: 1 },
  }, {
    dice: [4, 1],
    rolled: [4, 1],
  });

  const outsideBefore = countOutsideHome(state, "dark");
  const plan = engine.plan(state, { maxCandidates: 300, timeLimitMs: 2000 });
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.equal(countOutsideHome(after, "dark"), outsideBefore - 1);
  assert.ok(plan.some(move => move.from === 22 && move.die === 4));
});

test("X383-UNU9 move 134 carries the laggard home instead of making a cosmetic home move", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "dark", count: 1 },
    7: { color: "white", count: 1 },
    8: { color: "white", count: 1 },
    9: { color: "white", count: 2 },
    10: { color: "white", count: 1 },
    11: { color: "white", count: 1 },
    12: { color: "dark", count: 5 },
    13: { color: "dark", count: 2 },
    14: { color: "white", count: 2 },
    15: { color: "white", count: 1 },
    16: { color: "white", count: 1 },
    17: { color: "dark", count: 1 },
    18: { color: "dark", count: 5 },
    19: { color: "white", count: 4 },
    22: { color: "dark", count: 1 },
    24: { color: "white", count: 1 },
  }, {
    dice: [3, 5],
    rolled: [3, 5],
  });

  const outsideBefore = countOutsideHome(state, "dark");
  const plan = engine.plan(state, { maxCandidates: 300, timeLimitMs: 2000 });
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.equal(countOutsideHome(after, "dark"), outsideBefore - 1);
  assert.ok(!plan.some(move => move.from === 18 && move.die === 5));
});

test("SGHP-V6KP move 22 advances the deepest laggard before entering a nearer checker", () => {
  const { engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "white", count: 1 },
    2: { color: "dark", count: 3 },
    3: { color: "white", count: 1 },
    4: { color: "dark", count: 1 },
    5: { color: "dark", count: 2 },
    6: { color: "dark", count: 1 },
    7: { color: "dark", count: 1 },
    8: { color: "dark", count: 1 },
    9: { color: "white", count: 4 },
    10: { color: "white", count: 1 },
    11: { color: "white", count: 2 },
    13: { color: "white", count: 1 },
    14: { color: "white", count: 1 },
    15: { color: "white", count: 1 },
    16: { color: "dark", count: 3 },
    17: { color: "white", count: 1 },
    18: { color: "white", count: 1 },
    19: { color: "white", count: 1 },
    22: { color: "dark", count: 1 },
    23: { color: "dark", count: 1 },
    24: { color: "dark", count: 1 },
  }, {
    dice: [3, 5],
    rolled: [3, 5],
  });

  const plan = engine.plan(state, { maxCandidates: 300, timeLimitMs: 2000 });
  assert.ok(plan.some(move => move.from === 7));
  assert.ok(!plan.some(move => move.from === 24 && move.die === 3));
});

test("TB9N-MS4S move 5 releases the crowded head without opening either barrier", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    6: { color: "dark", count: 1 },
    9: { color: "white", count: 1 },
    12: { color: "dark", count: 12 },
    15: { color: "white", count: 1 },
    19: { color: "white", count: 1 },
    20: { color: "white", count: 1 },
    21: { color: "dark", count: 1 },
    22: { color: "white", count: 1 },
    23: { color: "dark", count: 1 },
    24: { color: "white", count: 10 },
  }, {
    dice: [5, 4],
    rolled: [5, 4],
  });

  const plan = engine.plan(state, { maxCandidates: 300, timeLimitMs: 2000 });
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.deepEqual(JSON.parse(JSON.stringify(after.points[21])), { color: "dark", count: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(after.points[23])), { color: "dark", count: 1 });
  assert.equal(after.points[12]?.count, 11);
});

test("v13 releases the head instead of rushing a lone checker home in 3DAG-EQ52", () => {
  const { engine } = loadBrowserEngine();
  const state = longState({
    1: { color: "dark", count: 1 },
    11: { color: "dark", count: 1 },
    12: { color: "dark", count: 13 },
    13: { color: "white", count: 1 },
    20: { color: "white", count: 1 },
    24: { color: "white", count: 13 },
  }, { dice: [5, 3], rolled: [5, 3] });

  const plan = engine.plan(state, { maxCandidates: 300, timeLimitMs: 2000 });
  assert.ok(plan.some(move => move.from === 12 && move.die === 5));
  assert.ok(!plan.some(move => move.from === 22 && move.die === 5));
});

test("v13 keeps developing the head in the NCEQ-MBAK Mars position", () => {
  const { engine } = loadBrowserEngine();
  const state = longState({
    3: { color: "dark", count: 1 },
    8: { color: "white", count: 1 },
    10: { color: "white", count: 1 },
    12: { color: "dark", count: 12 },
    14: { color: "white", count: 1 },
    18: { color: "dark", count: 1 },
    20: { color: "white", count: 1 },
    23: { color: "dark", count: 1 },
    24: { color: "white", count: 11 },
  }, { dice: [5, 4], rolled: [5, 4] });

  const plan = engine.plan(state, { maxCandidates: 300, timeLimitMs: 2000 });
  assert.ok(plan.some(move => move.from === 12 && move.die === 5));
});

test("shared long-bot experience is exposed by a read-only aggregate RPC", () => {
  const schema = fs.readFileSync(path.join(ROOT, "supabase/schema.sql"), "utf8");
  const client = fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8");
  const controller = fs.readFileSync(path.join(ROOT, "game-controller.js"), "utf8");

  assert.match(schema, /get_long_bot_experience_patterns\(\)/);
  assert.match(schema, /winner <> bot_color/);
  assert.match(schema, /harm_signal >= 1\.1/);
  assert.match(schema, /'creditVersion', 2/);
  assert.match(schema, /'lossWeight', loss_weight/);
  assert.match(schema, /familyActionKey/);
  assert.match(schema, /engine_version like 'long-analytic-%'/);
  assert.match(schema, /Guest bot game must match the finished room snapshot/);
  assert.match(controller, /botGameFinalizePromise/);
  assert.match(client, /setExperience\(patterns, "server"\)/);
  assert.match(controller, /ensureAutoProgressAfterExperience/);
});

test("U3DQ-PGZX move 11 keeps the point that prevents a head-built fence", () => {
  const { game, engine } = loadBrowserEngine();
  const state = longState({
    2: { color: "dark", count: 1 },
    4: { color: "dark", count: 1 },
    5: { color: "dark", count: 1 },
    6: { color: "dark", count: 3 },
    7: { color: "white", count: 1 },
    8: { color: "white", count: 1 },
    9: { color: "dark", count: 2 },
    11: { color: "dark", count: 1 },
    12: { color: "dark", count: 5 },
    17: { color: "white", count: 1 },
    18: { color: "dark", count: 1 },
    19: { color: "white", count: 2 },
    20: { color: "white", count: 1 },
    21: { color: "white", count: 1 },
    22: { color: "white", count: 1 },
    23: { color: "white", count: 2 },
    24: { color: "white", count: 5 },
  }, {
    dice: [4, 5],
    rolled: [4, 5],
  });

  const plan = engine.plan(state, { maxCandidates: 300, timeLimitMs: 2000 });
  const after = JSON.parse(JSON.stringify(state));
  plan.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));

  assert.deepEqual(JSON.parse(JSON.stringify(after.points[18])), { color: "dark", count: 1 });
  assert.ok(!plan.some(move => move.from === 18));
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

function countOutsideHome(state, color) {
  return 15 - countHome(state, color);
}
