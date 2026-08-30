const assert = require("node:assert/strict");
const test = require("node:test");

const simulator = require("../scripts/simulate-short-bot-regression");

function archivedState(runtime, { points, bar, off, dice }) {
  const state = runtime.game.initialState("short");
  state.points = JSON.parse(JSON.stringify(points));
  state.bar = { white: 0, dark: 0, ...bar };
  state.off = { white: 0, dark: 0, ...off };
  state.turn = "dark";
  state.phase = "move";
  state.dice = [...dice];
  state.rolled = [...dice];
  return state;
}

test("ZUZW-JWV4 opening 6-3 uses money-game equity and avoids the exposed 24/15 split", () => {
  const runtime = simulator.loadRuntime();
  const state = runtime.game.initialState("short");
  state.turn = "dark";
  state.phase = "move";
  state.dice = [3, 6];
  state.rolled = [3, 6];

  const request = runtime.engine.prepareWildbgRequest(state);
  assert.equal(
    request.isOnePointer,
    false,
    "a normal rated game must include gammon and backgammon equity",
  );

  const moneyAnalysis = runtime.wildbgAnalyzer.analyze(
    request.board,
    request.die1,
    request.die2,
    request.isOnePointer,
  );
  assert.deepEqual(
    moneyAnalysis.moves[0].play,
    [{ from: 24, to: 18 }, { from: 13, to: 10 }],
  );

  const onePointAnalysis = runtime.wildbgAnalyzer.analyze(
    request.board,
    request.die1,
    request.die2,
    true,
  );
  assert.deepEqual(
    onePointAnalysis.moves[0].play,
    [{ from: 24, to: 21 }, { from: 21, to: 15 }],
    "the old one-point setting must keep reproducing the production failure",
  );
  assert.ok(
    moneyAnalysis.moves[0].equity > moneyAnalysis.moves[1].equity,
    "the money-game choice must have greater gammon-aware equity",
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.engine.plan(state))),
    [{ from: 1, die: 6 }, { from: 12, die: 3 }],
  );
  const decision = runtime.engine.consumeLastDecision();
  assert.equal(decision.engine.provenance, "wildbg-wasm");
  assert.equal(decision.engine.match, "play");
});

test("ZUZW-JWV4 late race uses result-aware equity instead of chasing a negligible win", () => {
  const runtime = simulator.loadRuntime();
  const fixtures = [
    {
      dice: [2, 3],
      off: { white: 9 },
      points: {
        1: { color: "white", count: 4 },
        2: { color: "white", count: 2 },
        5: { color: "dark", count: 1 },
        14: { color: "dark", count: 3 },
        15: { color: "dark", count: 1 },
        17: { color: "dark", count: 2 },
        19: { color: "dark", count: 3 },
        21: { color: "dark", count: 3 },
        24: { color: "dark", count: 2 },
      },
      expected: [{ from: 5, die: 2 }, { from: 17, die: 3 }],
      old: [{ from: 14, die: 2 }, { from: 21, die: 3 }],
    },
    {
      dice: [4, 1],
      off: { white: 11 },
      points: {
        1: { color: "white", count: 4 },
        5: { color: "dark", count: 1 },
        14: { color: "dark", count: 2 },
        15: { color: "dark", count: 1 },
        16: { color: "dark", count: 1 },
        17: { color: "dark", count: 2 },
        19: { color: "dark", count: 3 },
        21: { color: "dark", count: 2 },
        24: { color: "dark", count: 3 },
      },
      expected: [{ from: 5, die: 4 }, { from: 14, die: 1 }],
      old: [{ from: 15, die: 1 }, { from: 17, die: 4 }],
    },
  ];

  fixtures.forEach(fixture => {
    const state = archivedState(runtime, fixture);
    const request = runtime.engine.prepareWildbgRequest(state);
    const oldAnalysis = runtime.wildbgAnalyzer.analyze(
      request.board,
      request.die1,
      request.die2,
      true,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(runtime.engine.planFromWildbgAnalysis(state, oldAnalysis))),
      fixture.old,
      "the fixture must reproduce the archived one-pointer move",
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(runtime.engine.plan(state))),
      fixture.expected,
      "money-game equity must choose the lower-Koks-risk move",
    );
  });
});
