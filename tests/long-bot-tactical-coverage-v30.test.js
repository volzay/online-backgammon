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

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, '')
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(const|function|class))/gm, '')
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, '');
}

function loadEngine() {
  const source = ENGINE_SOURCES.map(file => stripModuleSyntax(
    fs.readFileSync(path.join(ROOT, file), 'utf8'),
  )).join('\n');
  const context = { window: {}, console, Date, Math, setTimeout, clearTimeout };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
  vm.runInContext(`(function () { 'use strict'; ${source} }());`, context);
  return context.window.NarduLongBotEngine;
}

function state(fixture) {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'dark',
    dice: [...fixture.dice],
    rolled: [...fixture.dice],
    points: fixture.points,
    off: fixture.off,
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
  };
}

function moveKey(sequence) {
  return sequence
    .map(move => `${move.from}->${move.to}(${move.die})`)
    .sort()
    .join(',');
}

const FIXTURES = [
  {
    room: 'D6G5-RHJ8',
    decision: 20,
    dice: [5, 4],
    off: { dark: 0, white: 0 },
    points: {
      1: { color: 'dark', count: 2 }, 2: { color: 'white', count: 1 },
      3: { color: 'white', count: 2 }, 4: { color: 'dark', count: 2 },
      5: { color: 'dark', count: 2 }, 6: { color: 'dark', count: 2 },
      7: { color: 'white', count: 1 }, 8: { color: 'dark', count: 2 },
      9: { color: 'white', count: 1 }, 10: { color: 'white', count: 1 },
      11: { color: 'dark', count: 1 }, 13: { color: 'white', count: 2 },
      14: { color: 'white', count: 1 }, 15: { color: 'white', count: 1 },
      16: { color: 'white', count: 1 }, 17: { color: 'white', count: 1 },
      18: { color: 'dark', count: 3 }, 19: { color: 'white', count: 1 },
      23: { color: 'dark', count: 1 }, 24: { color: 'white', count: 2 },
    },
  },
  {
    room: 'D6G5-RHJ8',
    decision: 23,
    dice: [1, 5],
    off: { dark: 0, white: 0 },
    points: {
      1: { color: 'dark', count: 3 }, 2: { color: 'white', count: 2 },
      3: { color: 'white', count: 1 }, 4: { color: 'dark', count: 1 },
      5: { color: 'dark', count: 2 }, 6: { color: 'dark', count: 1 },
      7: { color: 'white', count: 2 }, 8: { color: 'dark', count: 1 },
      9: { color: 'white', count: 2 }, 11: { color: 'dark', count: 1 },
      13: { color: 'white', count: 1 }, 14: { color: 'white', count: 1 },
      15: { color: 'white', count: 1 }, 16: { color: 'white', count: 2 },
      17: { color: 'white', count: 1 }, 18: { color: 'dark', count: 4 },
      19: { color: 'white', count: 1 }, 23: { color: 'dark', count: 2 },
      24: { color: 'white', count: 1 },
    },
  },
  {
    room: '6BMJ-TMK3',
    decision: 29,
    dice: [4, 2],
    off: { dark: 0, white: 0 },
    points: {
      1: { color: 'white', count: 1 }, 2: { color: 'white', count: 5 },
      5: { color: 'white', count: 1 }, 6: { color: 'white', count: 1 },
      12: { color: 'white', count: 2 }, 13: { color: 'white', count: 1 },
      14: { color: 'white', count: 1 }, 15: { color: 'white', count: 1 },
      16: { color: 'white', count: 1 }, 17: { color: 'white', count: 1 },
      18: { color: 'dark', count: 8 }, 21: { color: 'dark', count: 1 },
      22: { color: 'dark', count: 3 }, 23: { color: 'dark', count: 2 },
      24: { color: 'dark', count: 1 },
    },
    expectedMoves: '22->18(4),24->22(2)',
    rejectedArchivedMoves: '22->18(4),23->21(2)',
  },
  {
    room: 'LRMX-EC4V',
    decision: 14,
    dice: [5, 1],
    off: { dark: 0, white: 0 },
    points: {
      3: { color: 'dark', count: 1 }, 5: { color: 'dark', count: 2 },
      6: { color: 'dark', count: 2 }, 7: { color: 'dark', count: 3 },
      8: { color: 'dark', count: 1 }, 9: { color: 'dark', count: 1 },
      10: { color: 'white', count: 1 }, 11: { color: 'white', count: 1 },
      12: { color: 'dark', count: 2 }, 13: { color: 'white', count: 2 },
      14: { color: 'white', count: 1 }, 15: { color: 'dark', count: 1 },
      16: { color: 'white', count: 1 }, 17: { color: 'white', count: 1 },
      18: { color: 'white', count: 2 }, 19: { color: 'white', count: 1 },
      20: { color: 'dark', count: 1 }, 21: { color: 'dark', count: 1 },
      22: { color: 'white', count: 1 }, 23: { color: 'white', count: 1 },
      24: { color: 'white', count: 3 },
    },
  },
  {
    room: 'FRMN-8D5L',
    decision: 17,
    dice: [2, 4],
    off: { dark: 0, white: 0 },
    points: {
      2: { color: 'dark', count: 1 }, 3: { color: 'dark', count: 1 },
      4: { color: 'white', count: 2 }, 5: { color: 'dark', count: 1 },
      6: { color: 'dark', count: 2 }, 7: { color: 'dark', count: 2 },
      8: { color: 'dark', count: 3 }, 9: { color: 'white', count: 5 },
      12: { color: 'dark', count: 1 }, 13: { color: 'white', count: 1 },
      14: { color: 'white', count: 1 }, 16: { color: 'dark', count: 1 },
      17: { color: 'dark', count: 1 }, 18: { color: 'white', count: 4 },
      19: { color: 'white', count: 1 }, 22: { color: 'dark', count: 1 },
      23: { color: 'dark', count: 1 }, 24: { color: 'white', count: 1 },
    },
    expectedMoves: '12->8(4),7->5(2)',
    rejectedArchivedMoves: '12->10(2),6->2(4)',
  },
];

test('today\'s five multi-choice regressions receive bounded four-ply models covering every next roll', () => {
  const engine = loadEngine();
  engine.setExperience([], 'today-v30-regression');

  FIXTURES.forEach(fixture => {
    engine.plan(state(fixture), {
      strategyProfile: 'v25',
      maxCandidates: 64,
      analysisNodeBudget: 480,
    });
    const selected = engine.consumeLastDecision()?.selected;
    const label = `${fixture.room} decision ${fixture.decision}`;

    assert.ok(selected, `${label} must emit decision telemetry`);
    assert.ok(selected.features.choiceCount > 1, `${label} must remain a real choice`);
    assert.ok(selected.tactical, `${label} must not bypass tactical analysis`);
    assert.equal(selected.tactical.rolls, 21, `${label} primary roll count`);
    assert.equal(selected.tactical.distributionWeight, 36, `${label} primary weight`);
    assert.equal(selected.tactical.distributionComplete, true, `${label} primary coverage`);
    assert.equal(selected.tactical.recoveryRolls, 21, `${label} recovery roll count`);
    assert.equal(selected.tactical.recoveryWeight, 36, `${label} recovery weight`);
    assert.equal(selected.tactical.recoveryDistributionComplete, true, `${label} recovery coverage`);
    assert.equal(selected.tactical.continuationRolls, 21, `${label} continuation roll count`);
    assert.equal(selected.tactical.continuationWeight, 36, `${label} continuation weight`);
    assert.equal(selected.tactical.continuationDistributionComplete, true, `${label} continuation coverage`);
    assert.equal(selected.tactical.plies, 4, `${label} search depth`);

    if (fixture.expectedMoves) {
      assert.equal(moveKey(selected.moves), fixture.expectedMoves, `${label} corrected move`);
      assert.notEqual(moveKey(selected.moves), fixture.rejectedArchivedMoves, `${label} archived move`);
    }
  });
});
