const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ENGINE_SOURCES = [
  'bot-engine/long/metrics.ts',
  'bot-engine/long/evaluator.ts',
  'bot-engine/long/analysis.ts',
  'bot-engine/long/engine.ts',
  'bot-engine/long/nardu-game-adapter.ts',
  'bot-engine/long/browser.ts',
];
let cachedEngine;

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, '')
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(const|function|class))/gm, '')
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, '');
}

function engine() {
  if (cachedEngine) return cachedEngine;
  const body = ENGINE_SOURCES.map(file => stripModuleSyntax(
    fs.readFileSync(path.join(ROOT, file), 'utf8'),
  )).join('\n');
  const context = { window: {}, console, Date, Math, setTimeout, clearTimeout };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
  vm.runInContext(`(function () { 'use strict'; ${body} }());`, context);
  cachedEngine = context.window.NarduLongBotEngine;
  return cachedEngine;
}

function state(points, dice, off = { white: 0, dark: 0 }) {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'dark',
    dice,
    rolled: dice,
    points,
    off,
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
  };
}

function rank(gameState) {
  return engine().rank(gameState, {
    strategyProfile: 'v25',
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
}

function hasMove(candidate, from, to, die) {
  return candidate.sequence.some(move => (
    move.from === from && move.to === to && move.die === die
  ));
}

function hostileMemory(gameState, safeSequence, unsafeSequence) {
  const safe = engine().describeSequence(gameState, safeSequence, {
    strategyProfile: 'v25',
    color: 'dark',
  }).experience;
  const unsafe = engine().describeSequence(gameState, unsafeSequence, {
    strategyProfile: 'v25',
    color: 'dark',
  }).experience;
  return [
    {
      creditVersion: 6,
      contextKey: safe.contextKey,
      actionKey: safe.actionKey,
      samples: 120,
      wins: 0,
      losses: 120,
      lossWeight: 360,
      severeLosses: 120,
      signalWeight: 360,
      winWeight: 0,
    },
    {
      creditVersion: 6,
      contextKey: unsafe.contextKey,
      actionKey: unsafe.actionKey,
      samples: 120,
      wins: 120,
      losses: 0,
      lossWeight: 0,
      severeLosses: 0,
      signalWeight: 0,
      winWeight: 360,
    },
  ];
}

const GUKS_TURN_4 = {
  5: { color: 'dark', count: 1 },
  7: { color: 'white', count: 1 },
  9: { color: 'dark', count: 1 },
  12: { color: 'dark', count: 12 },
  15: { color: 'white', count: 1 },
  21: { color: 'white', count: 1 },
  23: { color: 'dark', count: 1 },
  24: { color: 'white', count: 12 },
};

const GUKS_TURN_13 = {
  3: { color: 'dark', count: 1 },
  4: { color: 'dark', count: 2 },
  5: { color: 'dark', count: 4 },
  6: { color: 'dark', count: 1 },
  7: { color: 'white', count: 1 },
  8: { color: 'dark', count: 1 },
  9: { color: 'dark', count: 1 },
  10: { color: 'white', count: 2 },
  11: { color: 'white', count: 1 },
  12: { color: 'dark', count: 4 },
  13: { color: 'white', count: 1 },
  18: { color: 'white', count: 1 },
  19: { color: 'white', count: 2 },
  20: { color: 'white', count: 1 },
  21: { color: 'white', count: 1 },
  22: { color: 'white', count: 1 },
  23: { color: 'dark', count: 1 },
  24: { color: 'white', count: 4 },
};

const AP76_TURN_30 = {
  1: { color: 'white', count: 1 },
  2: { color: 'white', count: 1 },
  3: { color: 'white', count: 2 },
  4: { color: 'white', count: 4 },
  5: { color: 'dark', count: 2 },
  6: { color: 'white', count: 1 },
  7: { color: 'white', count: 1 },
  8: { color: 'dark', count: 1 },
  10: { color: 'white', count: 4 },
  13: { color: 'white', count: 1 },
  15: { color: 'dark', count: 5 },
  16: { color: 'dark', count: 1 },
  17: { color: 'dark', count: 3 },
  18: { color: 'dark', count: 2 },
  23: { color: 'dark', count: 1 },
};

const AP76_TURN_36 = {
  2: { color: 'white', count: 2 },
  3: { color: 'white', count: 3 },
  4: { color: 'white', count: 5 },
  5: { color: 'white', count: 1 },
  6: { color: 'white', count: 2 },
  14: { color: 'dark', count: 1 },
  15: { color: 'dark', count: 5 },
  16: { color: 'dark', count: 2 },
  17: { color: 'dark', count: 4 },
  18: { color: 'dark', count: 2 },
  22: { color: 'dark', count: 1 },
};

test('GUKS-UURG turn 4 follows the much safer reply branch', () => {
  engine().setExperience([], 'guks-t4');
  const ranked = rank(state(GUKS_TURN_4, [6, 2]));
  const selected = ranked[0];

  assert.ok(hasMove(selected, 5, 23, 6), JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 12, 10, 2));
  assert.ok(selected.tactical.worstImpact > -5000000);
  assert.ok(selected.experience.riskSignal < 1);
});

test('GUKS-UURG turn 13 keeps the only gateway that stops a seven-point fence', () => {
  engine().setExperience([], 'guks-t13');
  const selected = rank(state(GUKS_TURN_13, [3, 6]))[0];

  assert.ok(!selected.sequence.some(move => move.from === 23), JSON.stringify(selected.sequence));
  assert.equal(selected.after.points[23].color, 'dark');
  assert.ok(selected.after.points[23].count >= 1);
  assert.ok(selected.features.fenceClosureDelta >= -4);
});

test('AP76-V8UN turn 30 advances the outside checker when every reply metric improves', () => {
  engine().setExperience([], 'ap76-t30');
  const selected = rank(state(AP76_TURN_30, [2, 4]))[0];

  assert.ok(hasMove(selected, 23, 21, 2) || hasMove(selected, 23, 19, 4));
  assert.equal(selected.features.outsideReduction, 1);
  assert.equal(selected.features.homeShuffleMoves, 0);
  assert.ok(selected.features.outsidePipGain >= 5);
});

test('AP76-V8UN turn 36 enters the last checker and bears one off in the same turn', () => {
  engine().setExperience([], 'ap76-t36');
  const selected = rank(state(AP76_TURN_36, [4, 5], { white: 2, dark: 0 }))[0];

  assert.equal(selected.features.outsideReduction, 1);
  assert.equal(selected.features.offGain, 1);
  assert.equal(selected.features.homeShuffleMoves, 0);
  assert.ok(selected.sequence.some(move => move.bearOff));
});

test('GUKS tactical protections cannot be undone by hostile learned outcomes', () => {
  const turn4 = state(GUKS_TURN_4, [6, 2]);
  const safeTurn4 = [{ from: 5, die: 6 }, { from: 12, die: 2 }];
  const unsafeTurn4 = [{ from: 12, die: 6 }, { from: 6, die: 2 }];
  engine().setExperience(hostileMemory(turn4, safeTurn4, unsafeTurn4), 'guks-hostile');
  try {
    const selected4 = rank(turn4)[0];
    assert.ok(hasMove(selected4, 5, 23, 6));

    const selected13 = rank(state(GUKS_TURN_13, [3, 6]))[0];
    assert.ok(!selected13.sequence.some(move => move.from === 23));
    assert.equal(selected13.after.points[23].color, 'dark');
  } finally {
    engine().setExperience([], 'guks-hostile');
  }
});

test('long-bot experience is immutable during a game and carries a fingerprint', () => {
  const target = engine();
  target.beginExperienceSession();
  const first = [{
    creditVersion: 6,
    contextKey: 'route|snapshot-a',
    actionKey: 'route:a',
    samples: 4,
    wins: 4,
    losses: 0,
    winWeight: 4,
  }];
  const second = [{
    creditVersion: 6,
    contextKey: 'route|snapshot-b',
    actionKey: 'route:b',
    samples: 5,
    wins: 0,
    losses: 5,
    lossWeight: 8,
  }];
  target.setExperience(first, 'snapshot-test');
  const frozen = target.freezeExperience();
  target.setExperience(second, 'snapshot-test');
  assert.deepEqual(target.experienceSnapshot(), frozen);

  const nextGame = target.beginExperienceSession();
  assert.notEqual(nextGame.fingerprint, frozen.fingerprint);
  assert.equal(nextGame.frozen, false);
  target.setExperience([], 'snapshot-test');
});
