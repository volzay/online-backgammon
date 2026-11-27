const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = import('../bot-engine/long/engine.ts');
function candidate(overrides = {}) {
  return { tactical: {
    plies:4, rolls:21, distributionWeight:36, distributionComplete:true, doublesExpanded:true,
    expectedImpact:0, worstImpact:0, expectedEquity:0, lowerTailEquity:0,
    recoveryExpected:0, recoveryWorst:0, recoveryTailRisk:0,
    recoveryRolls:21, recoveryWeight:36, recoveryDistributionComplete:true,
    continuationExpected:0, continuationWorst:0, continuationTailRisk:0,
    continuationRolls:21, continuationWeight:36, continuationDistributionComplete:true,
    continuationModelComplete:true, continuationModelKind:'representative-worst-proxy-v1',
    continuationApproximate:true, continuationCoverageComplete:false,
    continuationFrontierCount:2, continuationTotalFrontierCount:10,
    continuationFrontierWeight:3, continuationTotalFrontierWeight:36,
    continuationProxyWeight:36, continuationWorstRecoveryFrontierWeight:1,
    continuationRepresentativeFrontierIncluded:true, continuationWorstFrontierIncluded:true,
    ...overrides,
  } };
}

test('model advice cannot replace bounded four-ply analysis with a two-ply gain', async () => {
  const { preservesBoardModelDeepSafety } = await helpers;
  assert.equal(preservesBoardModelDeepSafety(candidate({ plies:2, expectedEquity:0.2 }), candidate()), false);
  assert.equal(preservesBoardModelDeepSafety(candidate(), candidate({ plies:2 })), false);
});

test('complete model advice retains a comparable four-ply analysis and can improve the choice', async () => {
  const { preservesBoardModelDeepSafety } = await helpers;
  assert.equal(preservesBoardModelDeepSafety(candidate({
    expectedEquity:0.1, recoveryExpected:3000000, recoveryWorst:1000000,
    continuationExpected:2000000, continuationTailRisk:1000000,
  }), candidate()), true);
});

test('an attractive immediate reply cannot hide a substantially worse recovery', async () => {
  const { preservesBoardModelDeepSafety } = await helpers;
  assert.equal(preservesBoardModelDeepSafety(candidate({
    expectedEquity:0.1, lowerTailEquity:0.05,
    recoveryExpected:-3000000, recoveryWorst:-19000000,
    continuationExpected:14000000,
  }), candidate()), false);
});

test('model advice needs complete finite recovery and continuation evidence', async () => {
  const { preservesBoardModelDeepSafety } = await helpers;
  for (const partial of [
    { recoveryDistributionComplete:false }, { recoveryWeight:35 },
    { continuationModelComplete:false }, { continuationDistributionComplete:false },
    { continuationRolls:20 }, { continuationTailRisk:NaN },
    { recoveryWorst:undefined },
  ]) assert.equal(preservesBoardModelDeepSafety(candidate(partial), candidate()), false);
});

test('a deep adverse tail cannot be hidden by a better expected continuation', async () => {
  const { preservesBoardModelDeepSafety } = await helpers;
  assert.equal(preservesBoardModelDeepSafety(candidate({
    continuationExpected:10000000, continuationWorst:-16000000,
  }), candidate()), false);
  assert.equal(preservesBoardModelDeepSafety(candidate({
    continuationExpected:10000000, continuationTailRisk:-6000000,
  }), candidate()), false);
});
