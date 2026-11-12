const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderLongBotBundle } = require('../scripts/build-long-bot-engine');

const context = vm.createContext({ window: {}, console, Date, Math });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../game.js'), 'utf8'), context);
vm.runInContext(renderLongBotBundle().replace(/\n\}\(\)\);\n$/, `
  window.openingDevelopmentTest = {
    evaluateState, mergeWeights, improvesOpeningDevelopment,
    hasProvenOpeningDevelopment, preservesSoundOpeningAttack,
    prioritizeDevelopingFenceEscape, prioritizeOpeningDevelopment,
  };
}());
`), context);
const { NarduGame: game, openingDevelopmentTest: helpers } = context.window;
const weights = helpers.mergeWeights();

function position(white, dark, dice) {
  const points = {};
  for (const [color, stacks] of Object.entries({ white, dark })) {
    for (const [point, count] of Object.entries(stacks)) points[point] = { color, count };
  }
  return {
    ...game.initialState('long'),
    turn: 'white',
    phase: 'move',
    points,
    dice,
    rolled: dice,
    firstMoveDone: { white: true, dark: true },
  };
}

function boundedTactics(overrides) {
  return {
    plies: 4,
    rolls: 21,
    distributionWeight: 36,
    distributionComplete: true,
    doublesExpanded: true,
    recoveryRolls: 21,
    recoveryWeight: 36,
    recoveryDistributionComplete: true,
    continuationRolls: 21,
    continuationWeight: 36,
    continuationDistributionComplete: true,
    continuationModelComplete: true,
    continuationModelKind: 'representative-worst-proxy-v1',
    continuationApproximate: true,
    continuationCoverageComplete: false,
    continuationFrontierCount: 2,
    continuationTotalFrontierCount: 10,
    continuationFrontierWeight: 3,
    continuationTotalFrontierWeight: 36,
    continuationProxyWeight: 36,
    continuationWorstRecoveryFrontierWeight: 1,
    continuationRepresentativeFrontierIncluded: true,
    continuationWorstFrontierIncluded: true,
    expectedImpact: -50000000,
    worstImpact: -80000000,
    recoveryExpected: -25000000,
    recoveryWorst: -50000000,
    recoveryTailRisk: -40000000,
    continuationExpected: -25000000,
    continuationWorst: -50000000,
    continuationTailRisk: -40000000,
    ...overrides,
  };
}

function candidate(state, moves, features, score) {
  const sequence = game.bestMoveSequences(state, state.turn).find(legal => (
    legal.length === moves.length
    && legal.every((move, index) => move.from === moves[index][0] && move.die === moves[index][1])
  ));
  assert.ok(sequence, 'fixture must be a legal full turn');
  const after = structuredClone(state);
  for (const move of sequence) {
    assert.equal(game.applyMove(after, move.from, move.die, { autoEnd: false }), true);
  }
  // Isolate the policy from the search. The boards and move sequences are
  // native, while the supplied features and search proof set up each branch.
  return {
    after,
    sequence,
    score,
    features: {
      outsidePipGain: 3,
      startZoneReduction: 0,
      homeEntryMoves: 0,
      homeShuffleMoves: 0,
      maxRouteTowerAfter: 2,
      resultSafetyAfter: 0,
      trapBefore: 100,
      trapDelta: 0,
      fenceClosureBefore: 15,
      fenceClosureDelta: 0,
      escapeGatewayDelta: 0,
      headLandingBreak: 0,
      routeTowerDelta: 0,
      routeTowerAfter: 0,
      headGain: 1,
      opponentFenceRunBefore: 2,
      opponentMoveBlockAfter: 18,
      primeRunBefore: 2,
      primeRunAfter: 2,
      ...features,
    },
    tactical: boundedTactics(),
  };
}

function improveAbsoluteReplies(next, current, meanGain = 4000000, worstGain = 2000000) {
  const valueGain = helpers.evaluateState(next.after, 'white', weights)
    - helpers.evaluateState(current.after, 'white', weights);
  next.tactical.expectedImpact = current.tactical.expectedImpact - valueGain + meanGain;
  next.tactical.worstImpact = current.tactical.worstImpact - valueGain + worstGain;
}

test('a bounded early four-point attack survives the developing-fence override', () => {
  const state = position(
    { 24: 9, 20: 1, 19: 1, 17: 1, 16: 1, 14: 1, 13: 1 },
    { 12: 10, 21: 1, 18: 1, 11: 1, 10: 1, 9: 1 },
    [2, 1],
  );
  const attack = candidate(state, [[17, 2], [24, 1]], {
    primeRunAfter: 4, fenceClosureDelta: -5, opponentMoveBlockAfter: 32,
  }, 80000000);
  const defense = candidate(state, [[17, 1], [24, 2]], {
    fenceClosureDelta: 13, escapeGatewayDelta: -0.25,
  }, 0);
  improveAbsoluteReplies(attack, defense);
  attack.tactical.continuationWorst -= 19000000;
  assert.equal(Boolean(helpers.preservesSoundOpeningAttack(state, 'white', attack, defense, weights)), true);
  assert.equal(helpers.prioritizeDevelopingFenceEscape(state, 'white', [attack, defense], weights)[0], attack);

  attack.tactical.continuationWorst -= 3000000;
  assert.equal(Boolean(helpers.preservesSoundOpeningAttack(state, 'white', attack, defense, weights)), false);
  assert.equal(helpers.prioritizeDevelopingFenceEscape(state, 'white', [attack, defense], weights)[0], defense);
});

test('a proven development can leave a checker on the head instead of stacking it', () => {
  const state = position(
    { 24: 10, 23: 2, 21: 1, 19: 1, 17: 1 },
    { 12: 12, 22: 1, 18: 1, 9: 1 },
    [2, 1],
  );
  const stacking = candidate(state, [[24, 1], [21, 2]], { maxRouteTowerAfter: 3 }, 100);
  const development = candidate(state, [[23, 2], [17, 1]], { headGain: 0 }, 0);
  assert.equal(stacking.after.points[23].count, 3);
  assert.equal(development.after.points[24].count, state.points[24].count);
  improveAbsoluteReplies(development, stacking);

  assert.equal(helpers.improvesOpeningDevelopment(state, 'white', development, stacking), true);
  assert.equal(helpers.hasProvenOpeningDevelopment(state, 'white', development, stacking, weights), true);
  assert.equal(helpers.prioritizeOpeningDevelopment(state, 'white', [stacking, development], weights)[0], development);

  development.tactical.recoveryDistributionComplete = false;
  assert.equal(helpers.hasProvenOpeningDevelopment(state, 'white', development, stacking, weights), false);
  assert.equal(helpers.prioritizeOpeningDevelopment(state, 'white', [stacking, development], weights)[0], stacking);
});

test('an equally safe new opponent-head block can take precedence over an early home entry', () => {
  const state = position(
    { 24: 7, 23: 1, 20: 1, 19: 1, 18: 1, 14: 1, 10: 1, 8: 1, 7: 1 },
    { 12: 10, 22: 1, 21: 1, 4: 1, 2: 1, 1: 1 },
    [3, 1],
  );
  const home = candidate(state, [[8, 3], [24, 1]], { homeEntryMoves: 1 }, 100);
  const block = candidate(state, [[14, 3], [24, 1]], { opponentMoveBlockAfter: 30 }, 0);
  assert.equal(home.after.points[11], undefined);
  assert.equal(block.after.points[11].color, 'white');
  improveAbsoluteReplies(block, home);

  assert.equal(helpers.improvesOpeningDevelopment(state, 'white', block, home), true);
  assert.equal(helpers.hasProvenOpeningDevelopment(state, 'white', block, home, weights), true);
  assert.equal(helpers.prioritizeOpeningDevelopment(state, 'white', [home, block], weights)[0], block);

  const keepsBlock = candidate(state, [[23, 3], [24, 1]], {}, 0);
  assert.equal(keepsBlock.after.points[8].color, 'white');
  assert.equal(home.after.points[8], undefined);
  assert.equal(helpers.improvesOpeningDevelopment(state, 'white', keepsBlock, home), true);
  const doublesExistingBlock = candidate(state, [[10, 3], [24, 1]], {}, 0);
  assert.equal(doublesExistingBlock.after.points[7].count, 2);
  assert.equal(helpers.improvesOpeningDevelopment(state, 'white', doublesExistingBlock, home), false);

  improveAbsoluteReplies(block, home, 4000000, -1);
  assert.equal(helpers.hasProvenOpeningDevelopment(state, 'white', block, home, weights), false);
  assert.equal(helpers.prioritizeOpeningDevelopment(state, 'white', [home, block], weights)[0], home);
});
