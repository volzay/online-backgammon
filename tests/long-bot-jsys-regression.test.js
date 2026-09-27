const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

function loadGame() {
  const context = { window: {}, console, Date, Math, JSON, setTimeout, clearTimeout };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, {
    filename: 'game.js',
  });
  return context.window.NarduGame;
}

function jsysLateRaceState() {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'dark',
    dice: [4, 5],
    rolled: [4, 5],
    points: {
      1: { color: 'white', count: 5 },
      2: { color: 'white', count: 1 },
      3: { color: 'dark', count: 1 },
      4: { color: 'white', count: 5 },
      5: { color: 'white', count: 4 },
      6: { color: 'dark', count: 1 },
      15: { color: 'dark', count: 2 },
      16: { color: 'dark', count: 2 },
      17: { color: 'dark', count: 4 },
      18: { color: 'dark', count: 5 },
    },
    off: { white: 0, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false },
    winner: null,
  };
}

const PRODUCTION_RUNTIME = {
  strategyProfile: 'v25',
  maxCandidates: 64,
  analysisNodeBudget: 480,
  weights: {
    foothold: 4300,
    trapRisk: 62000,
    homeEntry: 145000,
    headRelease: 9800,
    rushPenalty: 12500,
    distribution: 780,
    escapeGatewayRisk: 800000,
    headLandingExposure: 62000,
    opponentHeadFreedom: 48000,
  },
};

const LIVE_DOUBLES_RUNTIME = {
  ...PRODUCTION_RUNTIME,
  maxCandidates: 16,
  initialSequenceLimit: 16,
  maxTacticalCandidates: 2,
  analysisNodeBudget: 58,
};

function jsysState(points, dice) {
  return {
    ...jsysLateRaceState(),
    points,
    dice: [...dice],
    rolled: [...dice],
  };
}

test('JSYS-DECV turn 36 enters a checker instead of shuffling inside home', async () => {
  const [{ createLongBotEngine }, { createNarduGameAdapter }] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'bot-engine/long/engine.ts')).href),
    import(pathToFileURL(path.join(ROOT, 'bot-engine/long/nardu-game-adapter.ts')).href),
  ]);
  const game = loadGame();
  const engine = createLongBotEngine(createNarduGameAdapter(game, {
    generatedSequenceFastPath: true,
  }));
  const ranked = engine.rank(jsysLateRaceState(), 'dark', PRODUCTION_RUNTIME);

  assert.ok(ranked.length >= 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      ranked[0].sequence.map(({ from, to, die }) => ({ from, to, die })),
    )),
    [
      { from: 3, to: 23, die: 4 },
      { from: 23, to: 18, die: 5 },
    ],
  );
  assert.equal(ranked[0].features.outsideReduction, 1);
  assert.equal(ranked[0].features.homeShuffleMoves, 0);
  assert.equal(ranked[0].features.homeEntryPriorityAdjustment > 0, true);
  assert.equal(ranked[0].features.avoidableHomeShuffleOverride, undefined);

  const oldHomeShuffle = ranked.find(candidate => (
    candidate.sequence.length === 2
      && candidate.sequence.every(move => Number(move.from) === 18)
  ));
  assert.ok(oldHomeShuffle, 'the archived home-shuffle choice remains a compared candidate');
  assert.equal(oldHomeShuffle.features.homeShuffleMoves, 2);
  assert.equal(oldHomeShuffle.features.avoidableHomeShuffleMoves, 2);
});

test('JSYS pure-race override stays disabled while an opponent checker remains outside home', async () => {
  const [{ createLongBotEngine }, { createNarduGameAdapter }] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'bot-engine/long/engine.ts')).href),
    import(pathToFileURL(path.join(ROOT, 'bot-engine/long/nardu-game-adapter.ts')).href),
  ]);
  const game = loadGame();
  const state = jsysLateRaceState();
  state.points[1].count -= 1;
  state.points[12] = { color: 'white', count: 1 };
  const ranked = createLongBotEngine(createNarduGameAdapter(game, {
    generatedSequenceFastPath: true,
  }))
    .rank(state, 'dark', PRODUCTION_RUNTIME);

  assert.equal(ranked[0].features.outsideReduction, 0);
  assert.equal(ranked[0].features.homeEntryPriorityAdjustment, undefined);
});

test('JSYS-DECV late doubles keep and select the maximum home-entry route', async () => {
  const [{ createLongBotEngine }, { createNarduGameAdapter }] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'bot-engine/long/engine.ts')).href),
    import(pathToFileURL(path.join(ROOT, 'bot-engine/long/nardu-game-adapter.ts')).href),
  ]);
  const game = loadGame();
  const engine = createLongBotEngine(createNarduGameAdapter(game, {
    generatedSequenceFastPath: true,
  }));
  const fixtures = [
    jsysState({
      1: { color: 'white', count: 3 }, 2: { color: 'dark', count: 2 },
      3: { color: 'dark', count: 2 }, 4: { color: 'white', count: 5 },
      5: { color: 'white', count: 2 }, 6: { color: 'dark', count: 1 },
      8: { color: 'white', count: 1 }, 12: { color: 'white', count: 1 },
      13: { color: 'white', count: 1 }, 14: { color: 'white', count: 1 },
      15: { color: 'white', count: 1 }, 17: { color: 'dark', count: 4 },
      18: { color: 'dark', count: 2 }, 21: { color: 'dark', count: 1 },
      22: { color: 'dark', count: 1 }, 23: { color: 'dark', count: 1 },
      24: { color: 'dark', count: 1 },
    }, [3, 3, 3, 3]),
    jsysState({
      1: { color: 'white', count: 3 }, 2: { color: 'dark', count: 1 },
      3: { color: 'dark', count: 2 }, 4: { color: 'white', count: 6 },
      5: { color: 'white', count: 3 }, 6: { color: 'dark', count: 1 },
      12: { color: 'white', count: 1 }, 13: { color: 'white', count: 1 },
      14: { color: 'white', count: 1 }, 16: { color: 'dark', count: 1 },
      17: { color: 'dark', count: 4 }, 18: { color: 'dark', count: 3 },
      20: { color: 'dark', count: 2 }, 21: { color: 'dark', count: 1 },
    }, [3, 3, 3, 3]),
    jsysState({
      1: { color: 'white', count: 3 }, 2: { color: 'dark', count: 1 },
      3: { color: 'dark', count: 1 }, 4: { color: 'white', count: 6 },
      5: { color: 'white', count: 4 }, 6: { color: 'dark', count: 1 },
      12: { color: 'white', count: 1 }, 13: { color: 'white', count: 1 },
      15: { color: 'dark', count: 1 }, 16: { color: 'dark', count: 1 },
      17: { color: 'dark', count: 4 }, 18: { color: 'dark', count: 3 },
      20: { color: 'dark', count: 2 }, 21: { color: 'dark', count: 1 },
    }, [1, 1, 1, 1]),
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const startedAt = performance.now();
    const ranking = engine.rank(fixture, 'dark', LIVE_DOUBLES_RUNTIME);
    const selected = ranking[0];
    const elapsedMs = performance.now() - startedAt;
    assert.equal(selected.features.outsideReduction, 2, `fixture ${index + 1}`);
    assert.equal(selected.features.homeShuffleMoves, 0, `fixture ${index + 1}`);
    assert.equal(selected.tactical?.distributionComplete, true, `fixture ${index + 1}`);
    assert.ok(elapsedMs < 1500, `fixture ${index + 1} took ${Math.round(elapsedMs)}ms`);
  }
});
