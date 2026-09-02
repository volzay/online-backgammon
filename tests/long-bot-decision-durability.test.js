const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function baseContext() {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const document = {
    hidden: false,
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    addEventListener() {},
    setTimeout,
    NarduApp: {
      getUser() { return { id: 'user-1', name: 'Tester', guest: false }; },
      paintUser() {},
    },
  };
  const context = {
    window,
    document,
    console,
    Date,
    Math,
    JSON,
    URL,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    localStorage,
    sessionStorage,
    location: {
      href: 'https://example.test/room.html?mode=bot&variant=long&difficulty=hard',
      pathname: '/room.html',
      search: '?mode=bot&variant=long&difficulty=hard',
      hostname: 'example.test',
    },
    history: { replaceState() {} },
  };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, {
    filename: 'game.js',
  });
  context.NarduGame = window.NarduGame;
  return context;
}

function legalLongState(game) {
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

function loadBrowserEngine() {
  require('../scripts/build-long-bot-engine')();
  const context = baseContext();
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'long-bot-engine.js'), 'utf8'), context, {
    filename: 'long-bot-engine.js',
  });
  return { context, engine: context.window.NarduLongBotEngine };
}

test('long browser engine never leaks a previous turn decision and gives repeated positions fresh ids', () => {
  const { context, engine } = loadBrowserEngine();
  const state = legalLongState(context.window.NarduGame);

  assert.ok(engine.plan(state).length > 0);
  const first = engine.consumeLastDecision();
  assert.ok(first);
  assert.equal(first.source, 'engine');
  assert.match(first.positionId, /^lb4-/);

  assert.ok(engine.plan(state).length > 0);
  const second = engine.consumeLastDecision();
  assert.equal(second.positionId, first.positionId);
  assert.notEqual(second.id, first.id);

  assert.ok(engine.plan(state).length > 0);
  engine.rank(state);
  assert.equal(engine.consumeLastDecision(), null, 'diagnostic rank must invalidate pending telemetry');

  assert.ok(engine.plan(state).length > 0);
  assert.equal(engine.plan({ ...state, variant: 'short' }).length, 0);
  assert.equal(engine.consumeLastDecision(), null, 'invalid plan must not expose a stale decision');
});

test('long strong-bot fallback emits a one-shot decision with reason and position id', () => {
  const context = baseContext();
  context.window.NarduLongBotEngine = {
    version: 'long-analytic-test',
    setExperience() {},
    experienceSize() { return 7; },
    plan() { throw new Error('forced engine failure'); },
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'strong-bot.js'), 'utf8'), context, {
    filename: 'strong-bot.js',
  });
  const state = legalLongState(context.window.NarduGame);

  const planned = context.window.NarduStrongBot.plan(state);
  assert.ok(planned.length > 0);
  const decision = context.window.NarduStrongBot.consumeLastFallbackDecision();
  assert.ok(decision);
  assert.equal(decision.source, 'fallback');
  assert.match(decision.fallback.reason, /^engine-error:/);
  assert.match(decision.positionId, /^lb4-/);
  assert.ok(decision.selected.moves.length > 0);
  assert.equal(context.window.NarduStrongBot.consumeLastFallbackDecision(), null);

  const shortState = { ...state, variant: 'short' };
  context.window.NarduStrongBot.plan(shortState);
  assert.equal(
    context.window.NarduStrongBot.consumeLastFallbackDecision(),
    null,
    'short-bot fallback telemetry remains owned by the short engine',
  );
});

function loadControllerForDecisionTests(setup = null) {
  const context = baseContext();
  setup?.(context);
  const source = fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8')
    .replace(
      '    preferredMoveAction,\n  };',
      '    preferredMoveAction,\n    __decisionTest: { safeBotPlan, rememberBotDecision, recordBotMoveSubstitution, finalizeBotMemory },\n  };',
    );
  vm.runInContext(source, context, { filename: 'game-controller.js' });
  const controller = context.window.NarduController;
  controller.init({
    mode: 'bot',
    variant: 'long',
    difficulty: 'hard',
    opponent: 'Hard bot',
    opponentRating: 1500,
    skipAutoStart: true,
  });
  return { context, controller };
}

test('controller turns an unreported legal long plan into an explicit fallback decision', () => {
  const { context, controller } = loadControllerForDecisionTests();
  const state = controller.getState();
  Object.assign(state, legalLongState(context.window.NarduGame));
  state.analysis = { botMemory: { decisions: [] } };
  const legal = context.window.NarduGame.legalNextMoves(state)
    .find(move => context.window.NarduGame.isValidMove(state, move.from, move.die));
  assert.ok(legal);
  context.NarduBot = { plan() { return [{ from: legal.from, die: legal.die }]; } };
  context.window.NarduLongBotEngine = {
    version: 'long-analytic-test',
    consumeLastDecision() { return null; },
    experienceSize() { return 0; },
  };
  context.window.NarduStrongBot = { consumeLastFallbackDecision() { return null; } };

  const planned = controller.__decisionTest.safeBotPlan();
  assert.equal(planned.length, 1);
  const decision = state.analysis.botMemory.decisions[0];
  assert.equal(decision.source, 'fallback');
  assert.equal(decision.fallback.reason, 'planner-returned-without-decision');
  assert.match(decision.positionId, /^lb4-/);
});

test('controller keeps the full BBXR-sized decision log and audits invalid move substitution', () => {
  assert.match(
    fs.readFileSync(path.join(ROOT, 'game-controller.js'), 'utf8'),
    /recordBotMoveSubstitution\(plannedMove, m, i - 1\)/,
  );
  const { context, controller } = loadControllerForDecisionTests();
  const state = controller.getState();
  Object.assign(state, legalLongState(context.window.NarduGame));
  state.analysis = { botMemory: { decisions: [] } };

  for (let index = 0; index < 46; index += 1) {
    controller.__decisionTest.rememberBotDecision({
      id: `bbxr-hard-turn-${index + 1}`,
      positionId: `lb4-position-${index + 1}`,
      source: 'engine',
      at: new Date(index + 1).toISOString(),
      engineVersion: 'long-analytic-test',
      selected: { moves: [] },
    });
  }
  assert.equal(state.analysis.botMemory.decisions.length, 46);

  const actual = context.window.NarduGame.legalNextMoves(state)
    .find(move => context.window.NarduGame.isValidMove(state, move.from, move.die));
  assert.ok(actual);
  controller.__decisionTest.recordBotMoveSubstitution(
    { from: 99, die: actual.die },
    actual,
    0,
  );

  const recorded = state.analysis.botMemory.decisions.at(-1);
  assert.equal(recorded.execution.reason, 'invalid-planned-move');
  assert.equal(recorded.execution.positionId, recorded.positionId);
  assert.deepEqual(
    JSON.parse(JSON.stringify(recorded.execution.substitutions[0].planned)),
    { from: 99, die: actual.die },
  );
  assert.equal(recorded.execution.substitutions[0].actual.from, actual.from);
});

test('coverage matches repeated position ids by occurrence instead of Set membership', () => {
  const positionId = 'lb4-acde1234';
  const recoveredDecision = {
    id: `${positionId}-history-0002`,
    positionId,
    historyTurnIndex: 2,
    actor: 'bot',
    source: 'history-recovery',
    choiceCount: 2,
    experience: { contextKey: 'route|repeat', actionKey: 'actual:repeat' },
    selected: {
      moves: [{ from: 12, to: 10, die: 2 }],
      experience: { contextKey: 'route|repeat', actionKey: 'actual:repeat' },
    },
  };
  const recovery = {
    available: true,
    expectedBotDecisions: 2,
    positions: [positionId, positionId],
    turns: [
      { index: 1, positionId, decision: { ...recoveredDecision, id: `${positionId}-history-0001` } },
      { index: 2, positionId, decision: recoveredDecision },
    ],
    decisions: [],
  };
  const { controller } = loadControllerForDecisionTests((runtime) => {
    runtime.window.NarduStrongBot = {
      recoverBotDecisions() { return recovery; },
      captureOpponentDecisions() { return []; },
    };
  });
  const state = controller.getState();
  state.variant = 'long';
  state.phase = 'over';
  state.winner = 'dark';
  state.finishedAt = Date.now();
  state.history = [];
  state.analysis = {
    botMemory: {
      decisions: [{
        id: `${positionId}-engine-0001`,
        positionId,
        source: 'engine',
        choiceCount: 2,
        selected: { moves: [{ from: 12, to: 11, die: 1 }] },
      }],
    },
  };

  controller.__decisionTest.finalizeBotMemory();
  assert.equal(state.analysis.botMemory.decisions.length, 2);
  assert.equal(state.analysis.botMemory.coverage.expectedBotDecisions, 2);
  assert.equal(state.analysis.botMemory.coverage.recordedBotDecisions, 1);
  assert.equal(state.analysis.botMemory.coverage.recoveredBotDecisions, 1);
  assert.equal(state.analysis.botMemory.coverage.complete, true);

  controller.__decisionTest.finalizeBotMemory();
  assert.equal(state.analysis.botMemory.decisions.length, 2);
  assert.equal(state.analysis.botMemory.coverage.recoveredBotDecisions, 1);
  assert.equal(state.analysis.botMemory.coverage.complete, true);
});

function historyWithAppliedBotTurns(game, count = 46) {
  const replay = game.initialState('long');
  const chronological = [];
  const colors = ['dark', 'white'];
  let botTurns = 0;
  let turnIndex = 0;

  while (botTurns < count) {
    const color = colors[turnIndex % colors.length];
    let selectedRoll = null;
    let selectedMove = null;
    for (let offset = 0; offset < 36 && !selectedMove; offset += 1) {
      const dieOne = (turnIndex + offset) % 6 + 1;
      const dieTwo = (turnIndex + offset + 2) % 6 + 1;
      replay.turn = color;
      replay.phase = 'move';
      replay.dice = dieOne === dieTwo
        ? [dieOne, dieOne, dieOne, dieOne]
        : [dieOne, dieTwo];
      replay.rolled = [...replay.dice];
      replay.turnMoves = [];
      replay.headPlayedThisTurn = { white: false, dark: false };
      selectedMove = game.legalNextMoves(replay)
        .find(move => game.isValidMove(replay, move.from, move.die));
      if (selectedMove) selectedRoll = [dieOne, dieTwo];
    }
    assert.ok(selectedMove, `turn ${turnIndex + 1} must have an applied move`);
    chronological.push({ color, roll: selectedRoll.join(':'), at: new Date().toISOString() });
    const to = Number(game.moveTo(color, selectedMove.from, selectedMove.die, replay)) || 0;
    assert.equal(
      game.applyMove(replay, selectedMove.from, selectedMove.die, { autoEnd: false }),
      true,
    );
    chronological.push({
      color,
      from: selectedMove.from,
      to,
      die: selectedMove.die,
      at: new Date().toISOString(),
    });
    if (color === 'dark') botTurns += 1;
    turnIndex += 1;
  }
  // A roll without an applied move is deliberately present and must not count.
  chronological.push({ color: 'dark', roll: '6:6', at: new Date().toISOString() });
  return chronological.reverse();
}

test('finalization reconstructs every missing bot turn from the full applied history', () => {
  const { context, controller } = loadControllerForDecisionTests((runtime) => {
    runtime.window.NarduLongBotEngine = {
      version: 'long-analytic-history-test',
      productionOptions: { strategyProfile: 'v25' },
      experienceSize() { return 12; },
      describeSequence(_state, moves) {
        const signature = moves.map(move => `${move.from}-${move.to}-${move.die}`).join(',');
        return {
          features: { riskSignal: 1.25, mistakeSeverity: 1.25 },
          experience: {
            contextKey: `route|history:${signature}`,
            actionKey: `actual:${signature}`,
          },
        };
      },
    };
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'strong-bot.js'), 'utf8'), runtime, {
      filename: 'strong-bot.js',
    });
  });
  const state = controller.getState();
  state.variant = 'long';
  state.phase = 'over';
  state.turn = 'dark';
  state.winner = 'dark';
  state.resultType = 'normal';
  state.finishedAt = Date.now();
  state.history = historyWithAppliedBotTurns(context.window.NarduGame, 46);

  const replay = context.window.NarduStrongBot.recoverBotDecisions(state, 'dark');
  assert.equal(replay.expectedBotDecisions, 46);
  assert.equal(replay.decisions.length, 46);
  state.analysis = {
    botMemory: {
      decisions: replay.decisions.slice(0, 15).map((decision, index) => ({
        ...decision,
        id: `${decision.positionId}-engine-${index + 1}`,
        actor: undefined,
        source: 'engine',
      })),
    },
  };

  controller.__decisionTest.finalizeBotMemory();
  const memory = state.analysis.botMemory;
  assert.deepEqual(JSON.parse(JSON.stringify(memory.coverage)), {
    expectedBotDecisions: 46,
    recordedBotDecisions: 15,
    recoveredBotDecisions: 31,
    complete: true,
    checkedAt: memory.coverage.checkedAt,
  });
  const botDecisions = memory.decisions.filter(decision => decision.actor !== 'opponent');
  assert.equal(botDecisions.length, 46);
  assert.equal(new Set(botDecisions.map(decision => decision.positionId)).size, 46);
  assert.equal(
    botDecisions.filter(decision => decision.source === 'history-recovery').length,
    31,
  );
  assert.ok(
    botDecisions
      .filter(decision => decision.source === 'history-recovery')
      .every(decision => decision.experience?.contextKey && decision.choiceCount >= 1),
  );

  controller.__decisionTest.finalizeBotMemory();
  const finalizedAgain = state.analysis.botMemory;
  assert.equal(finalizedAgain.decisions.length, 46, 'repeated game-over finalization must not duplicate recovery');
  assert.equal(finalizedAgain.coverage.recordedBotDecisions, 15);
  assert.equal(finalizedAgain.coverage.recoveredBotDecisions, 31);
  assert.equal(finalizedAgain.coverage.complete, true);
});
