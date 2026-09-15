const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const moduleUrl = file => pathToFileURL(path.join(ROOT, file)).href;

function position(points) {
  return {
    variant: 'long',
    phase: 'move',
    turn: 'white',
    dice: [4, 3],
    rolled: [4, 3],
    points,
    off: { white: 0, dark: 0 },
    headPlayedThisTurn: { white: false, dark: false },
  };
}

function whitePrimeState({ sustainable }) {
  const points = {};
  [9, 8, 7, 6, 5, 4].forEach(point => {
    points[point] = { color: 'white', count: 1 };
  });
  points[sustainable ? 24 : 1] = { color: 'white', count: 9 };
  if (sustainable) {
    points[12] = { color: 'dark', count: 15 };
  } else {
    points[12] = { color: 'dark', count: 1 };
    points[3] = { color: 'dark', count: 14 };
  }
  return position(points);
}

function darkPrimeState({ sustainable }) {
  const points = {};
  [21, 20, 19, 18, 17, 16].forEach(point => {
    points[point] = { color: 'dark', count: 1 };
  });
  points[sustainable ? 12 : 13] = { color: 'dark', count: 9 };
  if (sustainable) {
    points[24] = { color: 'white', count: 15 };
  } else {
    points[24] = { color: 'white', count: 1 };
    points[15] = { color: 'white', count: 14 };
  }
  return position(points);
}

test('EGXA timing metric distinguishes a durable prime from a self-crunching prime', async () => {
  const metrics = await import(moduleUrl('bot-engine/long/metrics.ts'));
  const durable = whitePrimeState({ sustainable: true });
  const crunching = whitePrimeState({ sustainable: false });

  assert.equal(metrics.blockingPrimeRun(durable, 'white'), 6);
  assert.equal(metrics.blockingPrimeRun(crunching, 'white'), 6);
  assert.ok(metrics.primeSustainability(durable, 'white') > 0.75);
  assert.ok(metrics.primeSustainability(crunching, 'white') < 0.2);
  assert.equal(metrics.primeCrunchRisk(durable, 'white'), 0);
  assert.ok(metrics.primeCrunchRisk(crunching, 'white') > 3);
});

test('EGXA prime timing remains color symmetric', async () => {
  const metrics = await import(moduleUrl('bot-engine/long/metrics.ts'));
  const whiteDurable = metrics.primeSustainability(
    whitePrimeState({ sustainable: true }),
    'white',
  );
  const darkDurable = metrics.primeSustainability(
    darkPrimeState({ sustainable: true }),
    'dark',
  );
  const whiteCrunch = metrics.primeCrunchRisk(
    whitePrimeState({ sustainable: false }),
    'white',
  );
  const darkCrunch = metrics.primeCrunchRisk(
    darkPrimeState({ sustainable: false }),
    'dark',
  );

  assert.equal(darkDurable, whiteDurable);
  assert.equal(darkCrunch, whiteCrunch);
});

test('a newly created self-crunch is eligible for outcome learning', async () => {
  const analysis = await import(moduleUrl('bot-engine/long/analysis.ts'));
  const descriptor = analysis.experienceDescriptor(
    whitePrimeState({ sustainable: false }),
    'white',
    {
      outsideReduction: 0,
      outsidePipGain: 0,
      homeShuffleMoves: 0,
      routeTowerDelta: 0,
      bearOffMoves: 0,
      trapDelta: 0,
      fenceClosureDelta: 0,
      escapeGatewayDelta: 0,
      opponentMoveBlockGain: 12,
      latentFenceExposureDelta: 0,
      primeRunAfter: 6,
      primeSustainabilityAfter: 0.08,
      primeSustainabilityDelta: -0.55,
      primeCrunchRiskDelta: -3.2,
    },
  );

  assert.ok(descriptor.riskSignal >= 1.1);
  assert.match(descriptor.behaviorActionKeys[2], /^prospective-fence:/);
  assert.equal(
    descriptor.behaviorActionKeys[2],
    'prospective-fence:flat',
    'v33 prospective-fence alias must retain index 2 for old experience',
  );
  assert.equal(
    descriptor.behaviorActionKeys[3],
    'prime-timing:loss|self-crunch:loss|prime-run:6',
    'v34 prime-timing alias must only be appended at index 3',
  );
});

test('an off-beam sustainable alternative is reserved for tactical analysis', async () => {
  const { reservePrimeSustainabilityForTacticalAnalysis } = await import(
    moduleUrl('bot-engine/long/engine.ts')
  );
  const candidate = (id, score, overrides = {}) => ({
    id,
    score,
    features: {
      primeRunAfter: 6,
      primeCrunchRiskAfter: 2.4,
      primeSustainabilityAfter: 0.12,
      resultSafetyAfter: 0,
      trapDelta: 0,
      fenceClosureDelta: 0,
      outsidePipGain: 0,
      ...overrides,
    },
  });
  const selected = candidate('selected', 200000000);
  const safe = candidate('safe', 50000000, {
    primeRunAfter: 5,
    primeCrunchRiskAfter: 0.1,
    primeSustainabilityAfter: 0.78,
    outsidePipGain: 8,
  });
  const ranked = [
    selected,
    candidate('filler-1', 190000000),
    candidate('filler-2', 180000000),
    candidate('filler-3', 170000000),
    candidate('filler-4', 160000000),
    safe,
  ];
  const state = position({
    24: { color: 'white', count: 15 },
    12: { color: 'dark', count: 15 },
  });

  const reserved = reservePrimeSustainabilityForTacticalAnalysis(
    state,
    'white',
    ranked,
    4,
  );
  assert.ok(reserved.indexOf(safe) < 4);
  assert.equal(safe.features.primeSustainabilityTacticalReservation, 1);
});

test('reply analysis sees an eighth non-double reply under the advanced profile', async () => {
  const analysis = await import(moduleUrl('bot-engine/long/analysis.ts'));
  const { mergeWeights } = await import(moduleUrl('bot-engine/long/evaluator.ts'));
  const base = whitePrimeState({ sustainable: false });
  const nonDoubleLimits = [];
  const adapter = {
    legalSequences(state, color, options = {}) {
      const isDouble = state.dice?.[0] === state.dice?.[1];
      if (color === 'dark') {
        if (!isDouble) nonDoubleLimits.push(options.limit);
        return Array.from({ length: 8 }, (_, index) => [{
          from: 12,
          to: 11,
          die: 1,
          catastrophic: !isDouble && index === 7,
          index,
        }]);
      }
      return [[{ from: 24, to: 23, die: 1 }]];
    },
    applySequence(state, sequence, color) {
      if (color === 'dark' && sequence[0]?.catastrophic) {
        return {
          ...state,
          winner: 'dark',
          resultType: 'mars',
          off: { ...(state.off || {}), dark: 15 },
        };
      }
      return { ...state };
    },
  };
  const candidate = {
    sequence: [{ from: 24, to: 23, die: 1 }],
    after: base,
    score: 0,
    features: {},
  };

  analysis.analyzeOpponentReplies(
    adapter,
    'white',
    [candidate],
    mergeWeights(),
    analysis.createAnalysisBudget(2000),
    { expandDoubles: true },
  );

  assert.ok(nonDoubleLimits.length > 0);
  assert.ok(nonDoubleLimits.includes(0));
  assert.equal(candidate.tactical.replyCoverageExpanded, true);
  assert.ok(
    candidate.tactical.worstImpact < -1000000000000,
    `worst impact was ${candidate.tactical.worstImpact}`,
  );
});
