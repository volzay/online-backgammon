const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

async function modules() {
  const analysis = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/analysis.ts'),
  ).href);
  const evaluator = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/evaluator.ts'),
  ).href);
  return { analysis, evaluator };
}

function state(points) {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'dark',
    dice: [3, 2],
    rolled: [3, 2],
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

function candidates(count = 2) {
  return [
    {
      sequence: [{ from: 12, to: 10, die: 2 }],
      after: state({
        10: { color: 'dark', count: 1 },
        12: { color: 'dark', count: 14 },
        24: { color: 'white', count: 15 },
      }),
      score: 100,
      features: {},
    },
    {
      sequence: [{ from: 12, to: 9, die: 3 }],
      after: state({
        9: { color: 'dark', count: 1 },
        12: { color: 'dark', count: 14 },
        24: { color: 'white', count: 15 },
      }),
      score: 90,
      features: {},
    },
    {
      sequence: [{ from: 12, to: 8, die: 4 }],
      after: state({
        8: { color: 'dark', count: 1 },
        12: { color: 'dark', count: 14 },
        24: { color: 'white', count: 15 },
      }),
      score: 80,
      features: {},
    },
    {
      sequence: [{ from: 12, to: 7, die: 5 }],
      after: state({
        7: { color: 'dark', count: 1 },
        12: { color: 'dark', count: 14 },
        24: { color: 'white', count: 15 },
      }),
      score: 70,
      features: {},
    },
  ].slice(0, count);
}

const blockedAdapter = {
  legalSequences() {
    return [];
  },
  applySequence(source) {
    return JSON.parse(JSON.stringify(source));
  },
};

test('canonical dice distribution contains exactly the fair 36 equiprobable outcomes', async () => {
  const { analysis } = await modules();
  const outcomes = analysis.CANONICAL_DICE_OUTCOMES;

  assert.equal(outcomes.length, 21);
  assert.equal(new Set(outcomes.map(({ dice }) => dice.join(':'))).size, 21);
  assert.equal(outcomes.reduce((sum, outcome) => sum + outcome.weight, 0), 36);
  assert.equal(analysis.CANONICAL_DICE_WEIGHT, 36);
  assert.equal(analysis.DICE_TAIL_WEIGHT, 6);
  assert.equal(outcomes.filter(({ dice }) => dice[0] === dice[1]).length, 6);
  assert.equal(outcomes.filter(({ dice }) => dice[0] !== dice[1]).length, 15);
  assert.ok(Object.isFrozen(outcomes));
  assert.ok(outcomes.every(outcome => Object.isFrozen(outcome) && Object.isFrozen(outcome.dice)));

  for (let face = 1; face <= 6; face += 1) {
    const atLeastOnce = outcomes
      .filter(({ dice }) => dice.includes(face))
      .reduce((sum, outcome) => sum + outcome.weight, 0);
    const dieSlots = outcomes.reduce((sum, { dice, weight }) => (
      sum + weight * dice.filter(value => value === face).length
    ), 0);
    assert.equal(atLeastOnce, 11, `face ${face} must appear in 11 of 36 throws`);
    assert.equal(dieSlots, 12, `face ${face} must occupy 12 of 72 die slots`);
  }
});

test('a distinct 6:5 reply is exactly twice as likely as the 6:6 double', async () => {
  const { analysis } = await modules();
  const byRoll = new Map(analysis.CANONICAL_DICE_OUTCOMES.map(
    outcome => [outcome.dice.join(':'), outcome.weight],
  ));

  assert.equal(byRoll.get('6:5'), 2);
  assert.equal(byRoll.get('6:6'), 1);
  assert.equal(byRoll.get('6:5') / analysis.CANONICAL_DICE_WEIGHT, 2 / 36);
  assert.equal(byRoll.get('6:6') / analysis.CANONICAL_DICE_WEIGHT, 1 / 36);
});

test('complete tactical and deep analysis use all 21 rolls with total weight 36', async () => {
  const { analysis, evaluator } = await modules();
  const ranked = analysis.analyzeOpponentReplies(
    blockedAdapter,
    'dark',
    candidates(),
    evaluator.mergeWeights(),
    analysis.createAnalysisBudget(500),
    { expandDoubles: true },
  );

  ranked.forEach((candidate) => {
    assert.equal(candidate.tactical.rolls, 21);
    assert.equal(candidate.tactical.distributionWeight, 36);
    assert.equal(candidate.tactical.distributionComplete, true);
    assert.equal(candidate.tactical.recoveryRolls, 21);
    assert.equal(candidate.tactical.recoveryWeight, 36);
    assert.equal(candidate.tactical.recoveryDistributionComplete, true);
    assert.equal(candidate.tactical.recoveryTailWeight, 6);
    assert.ok(Number.isFinite(candidate.tactical.recoveryTailRisk));
    assert.ok(candidate.tactical.recoveryWorst <= candidate.tactical.recoveryTailRisk);
    assert.ok(candidate.tactical.recoveryTailRisk <= candidate.tactical.recoveryExpected);
    assert.equal(candidate.tactical.continuationRolls, 21);
    assert.equal(candidate.tactical.continuationWeight, 36);
    assert.equal(candidate.tactical.continuationDistributionComplete, true);
    assert.equal(candidate.tactical.continuationTailWeight, 6);
    assert.ok(Number.isFinite(candidate.tactical.continuationTailRisk));
    assert.ok(candidate.tactical.continuationWorst <= candidate.tactical.continuationTailRisk);
    assert.ok(candidate.tactical.continuationTailRisk <= candidate.tactical.continuationExpected);
    assert.equal(candidate.tactical.plies, 4);
  });
});

test('primary evaluates four candidates while deep analysis stays on the same top two', async () => {
  const { analysis, evaluator } = await modules();
  const ranked = analysis.analyzeOpponentReplies(
    blockedAdapter,
    'dark',
    candidates(4),
    evaluator.mergeWeights(),
    analysis.createAnalysisBudget(500),
    { expandDoubles: true },
  );
  const byBaseScore = new Map(ranked.map(candidate => [candidate.sequence[0].to, candidate]));

  assert.equal(byBaseScore.get(10).tactical.distributionComplete, true);
  assert.equal(byBaseScore.get(9).tactical.distributionComplete, true);
  assert.equal(byBaseScore.get(8).tactical.distributionComplete, true);
  assert.equal(byBaseScore.get(7).tactical.distributionComplete, true);
  assert.equal(byBaseScore.get(10).tactical.plies, 4);
  assert.equal(byBaseScore.get(9).tactical.plies, 4);
  assert.equal(byBaseScore.get(8).tactical.plies, 2);
  assert.equal(byBaseScore.get(7).tactical.plies, 2);
  assert.equal(Object.hasOwn(byBaseScore.get(8).tactical, 'recoveryExpected'), false);
  assert.equal(Object.hasOwn(byBaseScore.get(8).tactical, 'continuationExpected'), false);
  assert.equal(Object.hasOwn(byBaseScore.get(7).tactical, 'recoveryExpected'), false);
  assert.equal(Object.hasOwn(byBaseScore.get(7).tactical, 'continuationExpected'), false);
});

test('an incomplete primary distribution is never exposed as an expectation', async () => {
  const { analysis, evaluator } = await modules();
  const source = candidates();
  const initialScores = source.map(candidate => candidate.score);
  const ranked = analysis.analyzeOpponentReplies(
    blockedAdapter,
    'dark',
    source,
    evaluator.mergeWeights(),
    analysis.createAnalysisBudget(41),
    { expandDoubles: true },
  );

  assert.ok(ranked.every(candidate => candidate.tactical === undefined));
  assert.deepEqual(ranked.map(candidate => candidate.score), initialScores);
});

test('partial recovery and continuation distributions fail closed', async () => {
  const { analysis, evaluator } = await modules();
  const recoveryPartial = analysis.analyzeOpponentReplies(
    blockedAdapter,
    'dark',
    candidates(),
    evaluator.mergeWeights(),
    analysis.createAnalysisBudget(62),
    { expandDoubles: true },
  );

  recoveryPartial.forEach((candidate) => {
    assert.equal(candidate.tactical.plies, 2);
    assert.equal(Object.hasOwn(candidate.tactical, 'recoveryExpected'), false);
    assert.equal(Object.hasOwn(candidate.tactical, 'recoveryTailRisk'), false);
    assert.equal(Object.hasOwn(candidate.tactical, 'recoveryDistributionComplete'), false);
  });

  const continuationPartial = analysis.analyzeOpponentReplies(
    blockedAdapter,
    'dark',
    candidates(),
    evaluator.mergeWeights(),
    analysis.createAnalysisBudget(104),
    { expandDoubles: true },
  );

  continuationPartial.forEach((candidate) => {
    assert.equal(candidate.tactical.plies, 3);
    assert.equal(candidate.tactical.recoveryDistributionComplete, true);
    assert.equal(Object.hasOwn(candidate.tactical, 'continuationExpected'), false);
    assert.equal(Object.hasOwn(candidate.tactical, 'continuationTailRisk'), false);
    assert.equal(Object.hasOwn(candidate.tactical, 'continuationDistributionComplete'), false);
  });
});
