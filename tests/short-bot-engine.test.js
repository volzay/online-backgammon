const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function runtime() {
  require("../scripts/build-short-bot-engine")();
  const context = { console, Date, Math, setTimeout, clearTimeout };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["game.js", "short-bot-engine.js", "strong-bot.js", "bot.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  }
  return context;
}

function shortCoreRuntime() {
  const context = { console, Date, Math, setTimeout, clearTimeout };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context, {
    filename: "game.js",
  });
  context.NarduGame = context.window.NarduGame;
  const source = ["metrics.ts", "engine.ts", "nardu-game-adapter.ts"]
    .map(file => fs.readFileSync(path.join(ROOT, "bot-engine", "short", file), "utf8")
      .replace(/^export\s+/gm, ""))
    .join("\n");
  vm.runInContext(`${source}\nObject.assign(globalThis, {
    __createShortBotEngine: createShortBotEngine,
    __createShortNarduGameAdapter: createShortNarduGameAdapter,
    __shortMetrics: shortMetrics,
    __shortPhase: shortPhase,
    __shortPubevalScore: shortPubevalScore,
  });`, context, { filename: "short-bot-core.js" });
  return context;
}

function position(game, {
  points,
  bar = { white: 0, dark: 0 },
  off = { white: 0, dark: 0 },
  turn = "white",
  dice = [1],
}) {
  const state = game.initialState("short");
  state.points = JSON.parse(JSON.stringify(points));
  state.bar = { white: 0, dark: 0, ...bar };
  state.off = { white: 0, dark: 0, ...off };
  state.turn = turn;
  state.phase = "move";
  state.dice = [...dice];
  state.rolled = [...dice];
  state.turnMoves = [];
  state.winner = null;
  return state;
}

function shortSequenceKey(sequence) {
  return (sequence || []).map(move => [
    Number(move.from),
    Number(move.to) || 0,
    Number(move.die),
    Boolean(move.bearOff),
  ]).join("|");
}

function shortStateContract(state) {
  return JSON.parse(JSON.stringify({
    points: state.points,
    bar: state.bar,
    off: state.off,
    score: state.score,
    dice: state.dice,
    winner: state.winner,
    resultType: state.resultType,
    phase: state.phase,
  }));
}

function deterministicReachableShortPositions(game, seed, turns = 16) {
  let randomState = seed >>> 0;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x100000000;
  };
  const rolls = [
    [6, 1], [3, 2], [5, 4], [6, 2], [5, 1], [4, 3],
    [6, 5], [2, 2, 2, 2], [5, 2], [6, 3], [4, 2], [3, 1],
  ];
  const state = game.initialState("short");
  state.turn = "white";
  state.phase = "roll";
  const snapshots = [];

  for (let turn = 0; turn < turns && !state.winner; turn += 1) {
    game.applyRoll(state, rolls[turn % rolls.length]);
    snapshots.push(JSON.parse(JSON.stringify(state)));
    const legal = game.bestMoveSequences(state, state.turn).filter(sequence => sequence.length);
    if (legal.length) {
      const sequence = legal[Math.floor(random() * legal.length)];
      sequence.forEach(move => {
        assert.equal(
          game.applyMove(state, move.from, move.die, { autoEnd: false }),
          true,
          "the deterministic position generator must only play legal moves",
        );
      });
    }
    game.endTurn(state);
  }
  return snapshots;
}

test("short hard bot installs a dedicated analytical engine", () => {
  const context = runtime();
  assert.equal(context.NarduShortBotEngine.version, "short-analytic-v3");
  assert.equal(typeof context.NarduShortBotEngine.rank, "function");
  assert.equal(typeof context.NarduShortBotEngine.setExperience, "function");
});

test("short hard bot makes the 7 point with opening 6-1", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: context.NarduGame.initialState("short").points,
    dice: [6, 1],
  });
  const plan = context.NarduStrongBot.plan(state);
  const next = JSON.parse(JSON.stringify(state));
  plan.forEach(move => context.NarduGame.applyMove(next, move.from, move.die, { autoEnd: false }));

  assert.deepEqual(
    JSON.parse(JSON.stringify(next.points[7])),
    { color: "white", count: 2 },
    "6-1 should create the strategically valuable 7 point",
  );
  const decision = context.NarduShortBotEngine.consumeLastDecision();
  assert.equal(decision.selected.tactical.rolls, 21);
  assert.equal(decision.engineVersion, "short-analytic-v3");
});

test("short Pubeval matches a hand-calculated race vector and its mirror", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const white = position(game, {
    points: { 24: { color: "white", count: 1 } },
    off: { white: 14, dark: 15 },
  });
  const dark = position(game, {
    points: { 1: { color: "dark", count: 1 } },
    off: { white: 15, dark: 14 },
    turn: "dark",
  });
  const expected = -0.17160 + (14 / 15) * 3.42040;
  assert.ok(Math.abs(context.__shortPubevalScore(white, "white", "race") - expected) < 1e-12);
  assert.ok(Math.abs(context.__shortPubevalScore(dark, "dark", "race") - expected) < 1e-12);
});

test("short rank keeps the root Pubeval network across candidates and replies", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const state = game.initialState("short");
  state.turn = "white";
  state.phase = "move";
  state.dice = [6, 1];
  state.rolled = [6, 1];
  const phase = context.__shortPhase(state, "white");
  const engine = context.__createShortBotEngine(context.__createShortNarduGameAdapter(game));
  const ranked = engine.rank(state, "white", { analyzeCandidates: 2, replyLimit: 8 });
  assert.equal(phase, "contact");
  assert.ok(ranked.length > 1);
  assert.ok(ranked.every(candidate => candidate.pubevalPhase === phase));
});

test("short hard policy ranks mirrored opening positions identically", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const engine = context.__createShortBotEngine(context.__createShortNarduGameAdapter(game));
  const canonicalPlan = color => {
    const state = game.initialState("short");
    state.turn = color;
    state.phase = "move";
    state.dice = [6, 1];
    state.rolled = [6, 1];
    const sequence = engine.rank(state, color, { analyzeCandidates: 2, replyLimit: 8 })[0].sequence;
    return sequence.map(move => [
      game.pathPos(color, move.from, state),
      move.bearOff ? 24 : game.pathPos(color, move.to, state),
      move.die,
    ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(canonicalPlan("white"))),
    JSON.parse(JSON.stringify(canonicalPlan("dark"))),
  );
});

test("short reply analysis reserves tactical threats beyond the generic limit", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const candidate = [{ from: 24, to: 23, die: 1, kind: "candidate" }];
  const safeReplies = Array.from({ length: 8 }, (_, index) => ([{
    from: 1 + index,
    to: 2 + index,
    die: 1,
    kind: `safe-${index}`,
  }]));
  const tacticalReplies = [
    [{ from: 2, to: 24, die: 6, hit: true, kind: "hit" }],
    [{ from: -1, to: 6, die: 6, kind: "bar-entry" }],
    [{ from: 1, to: 0, die: 1, bearOff: true, kind: "terminal" }],
    [{ from: 3, to: 9, die: 6, kind: "worst-static" }],
  ];
  const replies = [...safeReplies, ...tacticalReplies];

  function createAdapter(reverse = false) {
    return {
      legalSequences(state, color, options = {}) {
        if (color === "white") return [candidate];
        return safeReplies.slice(0, Number(options.limit) || safeReplies.length);
      },
      tacticalSequences(state, color, options = {}) {
        if (color === "white") return [candidate];
        const ordered = reverse ? [...replies].reverse() : replies;
        return ordered.slice(0, Number(options.limit) || ordered.length);
      },
      applySequence(state, sequence, color) {
        const next = JSON.parse(JSON.stringify(state));
        if (color === "white") return next;
        const kind = sequence[0]?.kind;
        if (kind === "hit") next.bar.white = 1;
        if (kind === "terminal") {
          next.winner = "dark";
          next.resultType = "mars";
        }
        if (kind === "worst-static") {
          next.winner = "dark";
          next.resultType = "koks";
        }
        return next;
      },
      baselineSequence() {
        return [];
      },
    };
  }

  const state = position(game, {
    points: {
      24: { color: "white", count: 15 },
      1: { color: "dark", count: 1 },
    },
    bar: { dark: 1 },
    off: { dark: 14 },
    dice: [1],
  });
  const options = { maxCandidates: 6, analyzeCandidates: 4, replyLimit: 8 };
  const normal = context.__createShortBotEngine(createAdapter()).rank(state, "white", options)[0];
  const reversed = context.__createShortBotEngine(createAdapter(true)).rank(state, "white", options)[0];

  assert.equal(normal.tactical.replyPoolLimit, 16);
  assert.equal(normal.tactical.reservations.hitRolls, 21);
  assert.equal(normal.tactical.reservations.barEntryRolls, 21);
  assert.equal(normal.tactical.reservations.terminalRolls, 21);
  assert.equal(normal.tactical.reservations.staticRolls, 21);
  assert.equal(normal.tactical.reservations.outsideGeneric, 84);
  assert.equal(normal.score, reversed.score, "reply ordering must not change minimax score");
  assert.deepEqual(
    JSON.parse(JSON.stringify(normal.tactical.scoreWeights)),
    { base: 0.75, expectedReply: 0.2, worstReply: 0.05 },
  );
  assert.ok(Math.abs(normal.tactical.probabilityMass - 1) < 1e-12);
  assert.equal("continuationExpected" in normal.tactical, false);
  assert.equal(
    normal.score,
    normal.baseScore * 0.75
      + (normal.baseScore + normal.tactical.expectedImpact) * 0.2
      + (normal.baseScore + normal.tactical.worstImpact) * 0.05,
  );
});

test("short adapter preserves a delayed hit before its tactical beam is capped", () => {
  const context = shortCoreRuntime();
  const rootMoves = Array.from({ length: 10 }, (_, index) => ({
    from: index + 1,
    to: index + 11,
    die: 1,
    dieIndex: 0,
    bearOff: false,
  }));
  const fakeGame = {
    opponentOf(color) {
      return color === "white" ? "dark" : "white";
    },
    barPoint(color) {
      return color === "white" ? 25 : -1;
    },
    legalNextMoves(state) {
      if (!state.turnMoves.length) return rootMoves;
      const first = state.turnMoves[0];
      if (first.from === 9) {
        return [{ from: 19, to: 24, die: 2, dieIndex: 0, bearOff: false }];
      }
      if (first.from === 10) {
        return [{ from: 20, to: 21, die: 2, dieIndex: 0, bearOff: false }];
      }
      return [{
        from: first.to,
        to: first.to + 1,
        die: 2,
        dieIndex: 0,
        bearOff: false,
      }];
    },
    sampledMoveSequences() {
      return rootMoves.slice(0, 8).map(move => ([
        move,
        { from: move.to, to: move.to + 1, die: 2, dieIndex: 0, bearOff: false },
      ]));
    },
    bestMoveSequences() {
      return [];
    },
    chooseBotSequence() {
      return [];
    },
    moveTo(color, from, die) {
      return from + die;
    },
    pathPos(color, point) {
      return point - 1;
    },
    pipsFor(state) {
      if (state.turnMoves[0]?.from === 9) return 1000;
      if (state.turnMoves[0]?.from === 10) return state.turnMoves.length > 1 ? -1000 : 1000;
      return 0;
    },
    resultTypeFor() {
      return "mars";
    },
  };
  const adapter = context.__createShortNarduGameAdapter(fakeGame);
  const state = {
    variant: "short",
    points: Object.fromEntries([
      ...Array.from({ length: 10 }, (_, index) => [index + 1, { color: "dark", count: 1 }]),
      [24, { color: "white", count: 1 }],
    ]),
    bar: { white: 0, dark: 0 },
    off: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    dice: [1, 2],
    rolled: [1, 2],
    turn: "dark",
    phase: "move",
    turnMoves: [],
  };

  const generic = adapter.legalSequences(state, "dark", { limit: 8 });
  const tactical = adapter.tacticalSequences(state, "dark", { limit: 16 });
  assert.equal(generic.some(sequence => sequence.some(move => move.hit)), false);
  assert.equal(
    tactical.some(sequence => sequence.some(move => move.from === 19 && move.to === 24 && move.hit)),
    true,
    "the delayed hitting branch must be reserved during expansion, before the final cap",
  );
  assert.equal(
    tactical.some(sequence => sequence[0]?.from === 10 && sequence[1]?.to === 21),
    true,
    "the strongest static branch must survive even when generic sampling omitted its root",
  );
});

test("short adapter preview matches the rules engine for known legal sequences", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const adapter = context.__createShortNarduGameAdapter(game);
  const state = position(game, {
    points: game.initialState("short").points,
    dice: [6, 1],
  });
  const sequences = game.sampledMoveSequences(state, "white", 12).slice(0, 8);

  sequences.forEach(sequence => {
    const expected = JSON.parse(JSON.stringify(state));
    sequence.forEach(move => game.applyMove(expected, move.from, move.die, { autoEnd: false }));
    const actual = adapter.applySequence(state, sequence, "white");
    assert.deepEqual(
      JSON.parse(JSON.stringify({
        points: actual.points,
        bar: actual.bar,
        off: actual.off,
        score: actual.score,
        dice: actual.dice,
        winner: actual.winner,
        resultType: actual.resultType,
        turnMoves: actual.turnMoves,
      })),
      JSON.parse(JSON.stringify({
        points: expected.points,
        bar: expected.bar,
        off: expected.off,
        score: expected.score,
        dice: expected.dice,
        winner: expected.winner,
        resultType: expected.resultType,
        turnMoves: expected.turnMoves,
      })),
    );
  });
});

test("short tactical adapter is rules-exact on deterministic reachable positions", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const adapter = context.__createShortNarduGameAdapter(game);
  const states = [0x6a09e667, 0xbb67ae85]
    .flatMap(seed => deterministicReachableShortPositions(game, seed));
  let hitPositions = 0;

  assert.equal(states.length, 32);
  states.forEach((state, stateIndex) => {
    const color = state.turn;
    const canonical = game.bestMoveSequences(state, color).filter(sequence => sequence.length);
    const tactical = adapter.tacticalSequences(state, color, { limit: 24 });
    const repeated = adapter.tacticalSequences(state, color, { limit: 24 });
    const canonicalKeys = new Set(canonical.map(shortSequenceKey));

    assert.deepEqual(
      JSON.parse(JSON.stringify(tactical)),
      JSON.parse(JSON.stringify(repeated)),
      `position ${stateIndex}: tactical generation must be deterministic`,
    );
    assert.ok(tactical.length <= 24, `position ${stateIndex}: tactical limit must be honored`);
    assert.equal(
      tactical.length > 0,
      canonical.length > 0,
      `position ${stateIndex}: blocked turns must not expose a synthetic empty sequence`,
    );
    tactical.forEach((sequence, sequenceIndex) => {
      assert.ok(
        canonicalKeys.has(shortSequenceKey(sequence)),
        `position ${stateIndex}, sequence ${sequenceIndex}: tactical sequence ${shortSequenceKey(sequence)} `
          + `must use the maximum legal dice; canonical=${canonical.map(shortSequenceKey).join(";")}; `
          + `state=${JSON.stringify(shortStateContract(state))}`,
      );
      const expected = JSON.parse(JSON.stringify(state));
      sequence.forEach((move, moveIndex) => {
        assert.equal(
          game.applyMove(expected, move.from, move.die, { autoEnd: false }),
          true,
          `position ${stateIndex}, sequence ${sequenceIndex}, move ${moveIndex}: previewed move must be legal`,
        );
      });
      assert.deepEqual(
        shortStateContract(adapter.applySequence(state, sequence, color)),
        shortStateContract(expected),
        `position ${stateIndex}, sequence ${sequenceIndex}: manual preview must match applyMove`,
      );
    });

    const canonicalHit = canonical.find(sequence => sequence.some(move => {
      if (move.bearOff) return false;
      const target = state.points[move.to];
      return target?.color && target.color !== color && target.count === 1;
    }));
    if (canonicalHit) {
      hitPositions += 1;
      assert.ok(
        tactical.some(sequence => sequence.some(move => move.hit)),
        `position ${stateIndex}: a legal hitting option must survive tactical selection`,
      );
    }
  });
  assert.ok(hitPositions > 0, "the reachable-position corpus must exercise a legal hit");
});

test("short tactical adapter preserves a forced bar-entry hit", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const adapter = context.__createShortNarduGameAdapter(game);
  const state = position(game, {
    points: {
      24: { color: "dark", count: 1 },
      13: { color: "white", count: 14 },
      12: { color: "dark", count: 14 },
    },
    bar: { white: 1 },
    dice: [1],
  });

  const sequences = adapter.tacticalSequences(state, "white", { limit: 4 });
  assert.deepEqual(JSON.parse(JSON.stringify(sequences)), [[{
    from: 25,
    die: 1,
    to: 24,
    bearOff: false,
    hit: true,
  }]]);
  const expected = JSON.parse(JSON.stringify(state));
  assert.equal(game.applyMove(expected, 25, 1, { autoEnd: false }), true);
  assert.deepEqual(
    shortStateContract(adapter.applySequence(state, sequences[0], "white")),
    shortStateContract(expected),
  );
});

test("short tactical adapter reports no sequence when every bar entry is blocked", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const adapter = context.__createShortNarduGameAdapter(game);
  const state = position(game, {
    points: {
      1: { color: "dark", count: 14 },
      3: { color: "white", count: 2 },
      6: { color: "white", count: 2 },
      24: { color: "white", count: 11 },
    },
    bar: { dark: 1 },
    turn: "dark",
    dice: [6, 3],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(game.bestMoveSequences(state, "dark"))), [[]]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(adapter.tacticalSequences(state, "dark", { limit: 24 }))),
    [],
    "a blocked roll is represented by no replies, not one synthetic empty reply",
  );
});

test("short tactical adapter preserves terminal mars and koks choices", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const adapter = context.__createShortNarduGameAdapter(game);
  const fixtures = [
    {
      resultType: "mars",
      state: position(game, {
        points: {
          1: { color: "white", count: 1 },
          24: { color: "dark", count: 15 },
        },
        off: { white: 14 },
        dice: [1],
      }),
    },
    {
      resultType: "koks",
      state: position(game, {
        points: {
          1: { color: "white", count: 1 },
          2: { color: "dark", count: 1 },
          24: { color: "dark", count: 14 },
        },
        off: { white: 14 },
        dice: [1],
      }),
    },
  ];

  fixtures.forEach(({ state, resultType }) => {
    const sequences = adapter.tacticalSequences(state, "white", { limit: 4 });
    const terminal = sequences.find(sequence => (
      adapter.applySequence(state, sequence, "white").winner === "white"
    ));
    assert.ok(terminal, `${resultType}: the winning bear-off must survive tactical selection`);

    const expected = JSON.parse(JSON.stringify(state));
    terminal.forEach(move => {
      assert.equal(game.applyMove(expected, move.from, move.die, { autoEnd: false }), true);
    });
    const actual = adapter.applySequence(state, terminal, "white");
    assert.equal(actual.phase, "over");
    assert.equal(actual.resultType, resultType);
    assert.deepEqual(shortStateContract(actual), shortStateContract(expected));
  });
});

test("short contact anchors favor the advanced 20 point over deep anchors", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;

  function anchorValue(positionIndex) {
    const state = game.initialState("short");
    state.points = {
      [game.trackToPoint("white", positionIndex, state)]: { color: "white", count: 2 },
    };
    return context.__shortMetrics(state, "white").anchorValue;
  }

  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(anchorValue),
    [1, 2, 4, 7, 10, 8],
  );
  assert.ok(anchorValue(4) > anchorValue(0), "the advanced 20 point must beat the deep 24 point");
  assert.ok(anchorValue(4) > anchorValue(5), "the 20 point remains the strongest home-board anchor");
});

test("seed 2654435762 game 1 ply 42 does not preserve fake contact with an exposed rear blot", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const adapter = context.__createShortNarduGameAdapter(game);
  const engine = context.__createShortBotEngine(adapter);
  const state = position(game, {
    points: {
      1: { color: "white", count: 3 }, 2: { color: "white", count: 2 },
      4: { color: "white", count: 2 }, 5: { color: "white", count: 2 },
      6: { color: "white", count: 4 }, 14: { color: "white", count: 1 },
      20: { color: "dark", count: 2 }, 21: { color: "dark", count: 3 },
      22: { color: "dark", count: 2 }, 24: { color: "dark", count: 1 },
    },
    bar: { white: 1 },
    off: { dark: 7 },
    dice: [5, 2],
  });
  const exposedContact = [{ from: 25, die: 2 }, { from: 6, die: 5 }];
  const runHome = [{ from: 25, die: 2 }, { from: 23, die: 5 }];
  const exposedAfter = adapter.applySequence(state, exposedContact, "white");
  const raceAfter = adapter.applySequence(state, runHome, "white");
  const exposedMetrics = context.__shortMetrics(exposedAfter, "white");

  assert.equal(exposedMetrics.contactCheckers, 1);
  assert.equal(exposedMetrics.contactMade, 0);
  assert.equal(exposedMetrics.contactBlots, 1);
  assert.equal(exposedMetrics.contactQuality, 0);
  assert.ok(
    engine.evaluateState(raceAfter, "white") > engine.evaluateState(exposedAfter, "white"),
    "a directly exposed lone checker must not gain a contact-phase jackpot",
  );
  const ranked = engine.rank(state, "white", {
    maxCandidates: 48,
    analyzeCandidates: 6,
    replyLimit: 12,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(ranked[0].sequence.map(move => [move.from, move.die]))),
    [[25, 2], [23, 5]],
  );
});

test("seed 2654435765 game 2 ply 16 rejects a structurally dominated home-board break", () => {
  const context = shortCoreRuntime();
  const game = context.NarduGame;
  const adapter = context.__createShortNarduGameAdapter(game);
  const engine = context.__createShortBotEngine(adapter);
  const state = position(game, {
    points: {
      1: { color: "dark", count: 2 }, 2: { color: "white", count: 4 },
      3: { color: "white", count: 3 }, 4: { color: "white", count: 2 },
      5: { color: "white", count: 2 }, 12: { color: "dark", count: 2 },
      13: { color: "white", count: 2 }, 19: { color: "dark", count: 2 },
      21: { color: "dark", count: 2 }, 22: { color: "dark", count: 4 },
      23: { color: "dark", count: 3 }, 24: { color: "white", count: 2 },
    },
    turn: "dark",
    dice: [4, 1],
  });
  const dominatedKey = JSON.stringify([[19, 1], [19, 4]]);
  const ranked = engine.rank(state, "dark", {
    maxCandidates: 48,
    analyzeCandidates: 6,
    replyLimit: 12,
  });

  assert.equal(
    ranked.some(item => JSON.stringify(item.sequence.map(move => [move.from, move.die])) === dominatedKey),
    false,
    "reply variance must not revive a move that loses a home point, adds exposure, and is worse statically",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ranked[0].sequence.map(move => [move.from, move.die]))),
    [[12, 4], [16, 1]],
  );
  assert.equal(context.__shortMetrics(ranked[0].after, "dark").homeMade, 4);
});

test("short hard bot enters from the bar and hits an exposed checker", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: {
      24: { color: "dark", count: 1 },
      13: { color: "white", count: 14 },
      12: { color: "dark", count: 14 },
    },
    bar: { white: 1 },
    dice: [1],
  });
  const plan = context.NarduShortBotEngine.plan(state);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), [{ from: 25, die: 1 }]);
  const decision = context.NarduShortBotEngine.consumeLastDecision();
  assert.equal(decision.selected.features.entries, 1);
  assert.equal(decision.selected.features.hits, 1);
  const next = JSON.parse(JSON.stringify(state));
  context.NarduGame.applyMove(next, plan[0].from, plan[0].die, { autoEnd: false });
  assert.equal(next.bar.white, 0);
  assert.equal(next.bar.dark, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(next.points[24])), { color: "white", count: 1 });
});

test("short hard bot bears off both available checkers instead of shuffling at home", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: {
      6: { color: "white", count: 1 },
      1: { color: "white", count: 1 },
      24: { color: "dark", count: 15 },
    },
    off: { white: 13 },
    dice: [6, 1],
  });
  const plan = context.NarduShortBotEngine.plan(state);
  const next = JSON.parse(JSON.stringify(state));
  plan.forEach(move => context.NarduGame.applyMove(next, move.from, move.die, { autoEnd: false }));
  assert.equal(next.off.white, 15);
  assert.equal(next.winner, "white");
});

test("4W69-MCG9 turn 19 bears off two checkers in a contact-free race", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: {
      1: { color: "white", count: 2 }, 3: { color: "white", count: 5 },
      4: { color: "white", count: 3 }, 6: { color: "white", count: 1 },
      7: { color: "white", count: 1 }, 20: { color: "dark", count: 2 },
      21: { color: "dark", count: 2 }, 22: { color: "dark", count: 2 },
      23: { color: "dark", count: 3 }, 24: { color: "dark", count: 2 },
    },
    off: { dark: 4, white: 3 },
    turn: "dark",
    dice: [3, 6],
  });
  const plan = context.NarduShortBotEngine.plan(state);
  const next = JSON.parse(JSON.stringify(state));
  plan.forEach(move => context.NarduGame.applyMove(next, move.from, move.die, { autoEnd: false }));
  assert.equal(next.off.dark - state.off.dark, 2);
});

test("MR5A-N5KY turn 15 takes three legal checkers off on double two", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: {
      1: { color: "white", count: 1 }, 2: { color: "white", count: 5 },
      19: { color: "dark", count: 3 }, 21: { color: "dark", count: 2 },
      22: { color: "dark", count: 3 }, 23: { color: "dark", count: 3 },
      24: { color: "dark", count: 3 },
    },
    off: { dark: 1, white: 9 },
    turn: "dark",
    dice: [2, 2, 2, 2],
  });
  const plan = context.NarduShortBotEngine.plan(state);
  const next = JSON.parse(JSON.stringify(state));
  plan.forEach(move => context.NarduGame.applyMove(next, move.from, move.die, { autoEnd: false }));
  assert.equal(next.off.dark - state.off.dark, 3);
  const decision = context.NarduShortBotEngine.consumeLastDecision();
  assert.equal(decision.experience.phase, "bearoff");
  assert.equal(decision.experience.mistakeSeverity, 0, "maximum bearoff must not poison learning memory");
});

test("844F-NPC5 turn 13 advances the last runner after contact is broken", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: {
      2: { color: "white", count: 3 }, 3: { color: "white", count: 3 },
      4: { color: "white", count: 4 }, 5: { color: "white", count: 1 },
      6: { color: "white", count: 3 }, 7: { color: "white", count: 1 },
      11: { color: "dark", count: 2 }, 21: { color: "dark", count: 3 },
      22: { color: "dark", count: 2 }, 23: { color: "dark", count: 6 },
      24: { color: "dark", count: 2 },
    },
    turn: "dark",
    dice: [1, 2],
  });
  const plan = context.NarduShortBotEngine.plan(state);
  assert.ok(plan.every(move => move.from === 11), "both dice must advance the lagging checker stack");
});

test("short hard bot records bar-aware decisions for durable learning", () => {
  const context = runtime();
  const state = position(context.NarduGame, {
    points: {
      24: { color: "dark", count: 2 },
      23: { color: "dark", count: 2 },
      13: { color: "white", count: 14 },
      12: { color: "dark", count: 11 },
    },
    bar: { white: 1 },
    dice: [3],
  });
  context.NarduStrongBot.plan(state);
  const decision = context.NarduShortBotEngine.consumeLastDecision();
  assert.equal(decision.position.bar.white, 1);
  assert.match(decision.experience.contextKey, /^bar\|/);
  assert.match(decision.experience.actionKey, /enter:1/);
});

test("short experience keeps local and server knowledge in separate mergeable sources", () => {
  const context = runtime();
  const engine = context.NarduShortBotEngine;
  engine.setExperience([{
    contextKey: "contact|merge",
    actionKey: "hit:1",
    samples: 2,
    wins: 2,
    winWeight: 2,
  }], "local");
  engine.setExperience([{
    contextKey: "contact|merge",
    actionKey: "hit:1",
    samples: 3,
    losses: 1,
    lossWeight: 1,
  }], "server");
  assert.equal(engine.experienceSize(), 1);
  engine.setExperience([], "server");
  assert.equal(engine.experienceSize(), 1, "clearing a stale server cache must preserve local experience");
});

test("short engine is loaded before the shared hard-bot dispatcher", () => {
  const room = fs.readFileSync(path.join(ROOT, "room.html"), "utf8");
  assert.ok(room.indexOf("short-bot-engine.js") < room.indexOf("strong-bot.js"));
  assert.match(room, /short-bot-engine\.js\?v=20260829-short-analytic-v3/);
});

test("short learning has a separate server RPC and archive accepts both variants", () => {
  const schema = fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8");
  const migration = fs.readFileSync(
    path.join(ROOT, "supabase", "short-bot-analytic-v3.sql"),
    "utf8",
  );
  const client = fs.readFileSync(path.join(ROOT, "rooms-client.js"), "utf8");
  assert.match(schema, /get_short_bot_experience_patterns\(\s*p_player_name text default null/);
  assert.match(schema, /engine_version like 'short-analytic-v3%'/);
  assert.match(schema, /not in \('long', 'short'\)/);
  assert.ok((schema.match(/not in \('long', 'short'\)/g) || []).length >= 2);
  assert.match(client, /loadShortBotExperience/);
  assert.match(client, /get_short_bot_experience_patterns/);
  assert.match(client, /narduh-short-bot-server-experience-v3/);
  assert.match(fs.readFileSync(path.join(ROOT, "strong-bot.js"), "utf8"), /narduh-short-bot-experience-v3/);
  assert.match(migration, /engine_version like 'short-analytic-v3%'/);
  assert.match(migration, /'creditVersion', 3/);
});
