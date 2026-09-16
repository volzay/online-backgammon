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

function state(points, dice = [6, 6, 6, 6]) {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'dark',
    dice: [...dice],
    rolled: [...dice],
    points,
    off: { white: 0, dark: 0 },
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

function descriptorKeys(descriptor) {
  return Array.from(new Set([
    descriptor.actionKey,
    descriptor.strategicActionKey,
    descriptor.familyActionKey,
    descriptor.legacyActionKey,
    ...(descriptor.behaviorActionKeys || []),
  ].filter(Boolean)));
}

function hostilePatterns(gameState, safeSequence, unsafeSequence) {
  const safe = engine().describeSequence(gameState, safeSequence, {
    strategyProfile: 'v25',
    color: 'dark',
  }).experience;
  const unsafe = engine().describeSequence(gameState, unsafeSequence, {
    strategyProfile: 'v25',
    color: 'dark',
  }).experience;
  const safeKeys = new Set(descriptorKeys(safe));
  const unsafeKeys = new Set(descriptorKeys(unsafe));
  const rewardKeys = [...unsafeKeys].filter(key => !safeKeys.has(key));
  const penaltyKeys = [...safeKeys].filter(key => !unsafeKeys.has(key));

  assert.ok(rewardKeys.length > 0, 'the unsafe move must expose a distinct reward key');
  assert.ok(penaltyKeys.length > 0, 'the safe move must expose a distinct penalty key');

  return [
    ...rewardKeys.map(actionKey => ({
      creditVersion: 7,
      contextKey: unsafe.contextKey,
      actionKey,
      samples: 120,
      wins: 120,
      losses: 0,
      winWeight: 360,
      lossWeight: 0,
      severeLosses: 0,
      signalWeight: 0,
    })),
    ...penaltyKeys.map(actionKey => ({
      creditVersion: 7,
      contextKey: safe.contextKey,
      actionKey,
      samples: 120,
      wins: 0,
      losses: 120,
      winWeight: 0,
      lossWeight: 360,
      severeLosses: 120,
      signalWeight: 360,
    })),
  ];
}

const TURN_7_POINTS = {
  4: { color: 'dark', count: 1 },
  5: { color: 'dark', count: 1 },
  6: { color: 'dark', count: 2 },
  7: { color: 'white', count: 1 },
  8: { color: 'dark', count: 1 },
  9: { color: 'dark', count: 1 },
  12: { color: 'dark', count: 8 },
  13: { color: 'white', count: 1 },
  15: { color: 'white', count: 1 },
  19: { color: 'white', count: 1 },
  20: { color: 'white', count: 1 },
  21: { color: 'white', count: 1 },
  22: { color: 'dark', count: 1 },
  23: { color: 'white', count: 1 },
  24: { color: 'white', count: 8 },
};

const SAFE_SEQUENCE = [
  { from: 4, die: 6 },
  { from: 9, die: 6 },
  { from: 12, die: 6 },
  { from: 22, die: 6 },
];

const ARCHIVED_UNSAFE_SEQUENCE = [
  { from: 4, die: 6 },
  { from: 8, die: 6 },
  { from: 12, die: 6 },
  { from: 22, die: 6 },
];

test('3XBR-A8W8 decision 7 preserves point 8 instead of opening the trapped checker route', () => {
  engine().setExperience([], '3xbr-cold');
  const ranked = rank(state(TURN_7_POINTS));
  const selected = ranked[0];

  assert.ok(selected, 'the hard bot must return a move');
  assert.ok(hasMove(selected, 9, 3, 6), JSON.stringify(ranked.slice(0, 4).map(candidate => ({
    moves: candidate.sequence,
    score: candidate.score,
    baseScore: candidate.baseScore,
    prospectiveBreak: candidate.features.prospectiveFenceInterruptionBreak,
    avoidableBreak: candidate.features.avoidableProspectiveFenceInterruptionBreak,
    prospectiveDelta: candidate.features.prospectiveFenceExtensionDelta,
    adjustment: candidate.features.prospectiveFenceAvoidanceAdjustment,
    tactical: candidate.tactical,
  }))));
  assert.ok(!selected.sequence.some(move => move.from === 8));
  assert.equal(selected.after.points[8]?.color, 'dark');
  assert.equal(selected.after.points[8]?.count, 1);
});

test('3XBR-A8W8 keeps the archived point-8 break available for measured comparison', () => {
  engine().setExperience([], '3xbr-archive');
  const ranked = rank(state(TURN_7_POINTS));
  const archived = ranked.find(candidate => hasMove(candidate, 8, 2, 6));

  assert.ok(archived, 'the archived 8-to-2 move must remain in the ranked analysis');
  assert.equal(archived.after.points[8], undefined);
  assert.ok(
    archived.features.avoidableProspectiveFenceInterruptionBreak > 0,
    'the point-8 break must be classified as avoidable before it can affect learning',
  );
  assert.ok(
    archived.experience.behaviorActionKeys.includes('prospective-fence:avoidable-break'),
    'transferable experience must blame only the proven avoidable break',
  );
  assert.ok(archived.tactical, 'the rejected move must retain tactical measurements');
});

test('3XBR-A8W8 selected correction has bounded four-ply fair-dice telemetry', () => {
  const target = engine();
  target.setExperience([], '3xbr-telemetry');
  target.plan(state(TURN_7_POINTS), {
    strategyProfile: 'v25',
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
  const selected = target.consumeLastDecision()?.selected;

  assert.ok(selected, 'the decision must emit telemetry');
  assert.ok(selected.features.choiceCount > 1, 'the position must remain a real choice');
  assert.ok(selected.tactical, 'the selected move must receive tactical analysis');
  assert.equal(selected.tactical.rolls, 21);
  assert.equal(selected.tactical.distributionWeight, 36);
  assert.equal(selected.tactical.distributionComplete, true);
  assert.equal(selected.tactical.recoveryRolls, 21);
  assert.equal(selected.tactical.recoveryWeight, 36);
  assert.equal(selected.tactical.recoveryDistributionComplete, true);
  assert.equal(selected.tactical.continuationRolls, 21);
  assert.equal(selected.tactical.continuationWeight, 36);
  assert.equal(selected.tactical.continuationDistributionComplete, true);
  assert.equal(selected.tactical.plies, 4);
});

test('3XBR-A8W8 compares the selected and archived alternatives at the same depth', () => {
  engine().setExperience([], '3xbr-equal-depth');
  const ranked = rank(state(TURN_7_POINTS));
  const compared = [
    ranked.find(candidate => hasMove(candidate, 9, 3, 6)),
    ranked.find(candidate => hasMove(candidate, 8, 2, 6)),
  ];

  compared.forEach((candidate) => {
    assert.ok(candidate, 'both point-8 choices must remain in the comparison');
    assert.equal(candidate.tactical?.plies, 4);
    assert.equal(candidate.tactical?.continuationDistributionComplete, true);
    assert.ok(candidate.features.analysisNodesUsed <= 480);
  });
});

test('3XBR-A8W8 experience descriptors distinguish preserving and breaking point 8', () => {
  const gameState = state(TURN_7_POINTS);
  const safe = engine().describeSequence(gameState, SAFE_SEQUENCE, {
    strategyProfile: 'v25',
    color: 'dark',
  }).experience;
  const unsafe = engine().describeSequence(gameState, ARCHIVED_UNSAFE_SEQUENCE, {
    strategyProfile: 'v25',
    color: 'dark',
  }).experience;
  const safeKeys = new Set(descriptorKeys(safe));
  const unsafeKeys = new Set(descriptorKeys(unsafe));

  assert.ok([...safeKeys].some(key => !unsafeKeys.has(key)));
  assert.ok([...unsafeKeys].some(key => !safeKeys.has(key)));
});

test('3XBR-A8W8 point-8 safety survives hostile learned memory', () => {
  const gameState = state(TURN_7_POINTS);
  engine().setExperience(
    hostilePatterns(gameState, SAFE_SEQUENCE, ARCHIVED_UNSAFE_SEQUENCE),
    '3xbr-hostile',
  );
  try {
    const ranked = rank(gameState);
    const selected = ranked[0];
    const unsafe = ranked.find(candidate => hasMove(candidate, 8, 2, 6));

    assert.equal(selected.after.points[8]?.color, 'dark');
    assert.equal(selected.after.points[8]?.count, 1);
    assert.ok(!selected.sequence.some(move => move.from === 8));
    assert.ok(unsafe, 'hostile memory must not remove the unsafe comparison candidate');
    assert.notEqual(selected, unsafe);
  } finally {
    engine().setExperience([], '3xbr-hostile');
  }
});

test('3XBR point-8 preservation does not spread to a neighbor without the trapped checker', () => {
  engine().setExperience([], '3xbr-neighbor');
  const exact = rank(state(TURN_7_POINTS));
  const exactUnsafe = exact.find(candidate => hasMove(candidate, 8, 2, 6));
  const neighbor = {
    ...TURN_7_POINTS,
    13: { color: 'white', count: 2 },
  };
  delete neighbor[7];
  const neighborUnsafe = rank(state(neighbor))
    .find(candidate => hasMove(candidate, 8, 2, 6));

  assert.ok(exactUnsafe, 'the real position must measure the point-8 break');
  assert.ok(neighborUnsafe, 'the neighboring position must keep the move measurable');
  assert.ok(
    neighborUnsafe.features.prospectiveFenceExtensionAfter
      < exactUnsafe.features.prospectiveFenceExtensionAfter * 0.2,
    'removing the adjacent white checker must remove the specific point-8 threat',
  );
});

test('3XBR preservation policy leaves a forced double-six head exit untouched', () => {
  const forced = state({
    12: { color: 'dark', count: 15 },
    24: { color: 'white', count: 15 },
  });
  engine().setExperience([], '3xbr-forced');
  const ranked = rank(forced);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].features.choiceCount, 1);
  assert.equal(ranked[0].sequence.length, 1);
  assert.ok(hasMove(ranked[0], 12, 6, 6));
  assert.equal(ranked[0].features.avoidableProspectiveFenceInterruptionBreak, 0);
});
