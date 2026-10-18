'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FRACTIONS, countsForPairedOutcomes, logPairedEValue, pairedDifferenceLowerBound } =
  require('../lib/long-bot-paired-confidence');

test('paired confidence counts complete common-stream contrasts, not marginal win counts', () => {
  assert.deepEqual(countsForPairedOutcomes([0, 0, 1, 1], [1, 0, 0, 1]),
    { betterOnly: 1, worseOnly: 1, equal: 2 });
  for (const [selected, candidate] of [[[], []], [[0], []], [[true], [1]], [[0], ['1']], [[,], [0]]]) {
    assert.throws(() => countsForPairedOutcomes(selected, candidate));
  }
});

test('paired confidence never learns from ties or an observed deterioration', () => {
  for (const counts of [{ betterOnly: 0, worseOnly: 0, equal: 32 },
    { betterOnly: 4, worseOnly: 12, equal: 16 }]) {
    const bound = pairedDifferenceLowerBound(counts, { comparisons: 23 });
    assert.equal(bound.lower, -1);
    assert.equal(bound.productionEvidence, false);
  }
});

test('fixed mixture uses pair information while retaining 5% familywise risk and eight-point margin', () => {
  const counts = { betterOnly: 26, worseOnly: 0, equal: 102 };
  const bound = pairedDifferenceLowerBound(counts, { comparisons: 23 });
  assert.ok(bound.lower > 0.08 && bound.lower < bound.meanDifference);
  assert.equal(bound.familywiseAlpha, 0.05);
  assert.equal(bound.minimumEvidenceLogThreshold, Math.log(23 / 0.05));
  assert.ok(Object.isFrozen(FRACTIONS));
  // Independent worst-case marginal bounds cannot certify this 20.3-point
  // effect at N=128,K=24, even when every discordant pair favors the move.
  const epsilon = Math.sqrt(Math.log(2 * 24 / 0.05) / (2 * 128));
  assert.ok(26 / 128 - 2 * epsilon < 0.08);
});

test('the confidence root is monotone, conservatively rounded and penalizes more comparisons', () => {
  const counts = { betterOnly: 16, worseOnly: 0, equal: 16 };
  let previous = Infinity;
  for (let margin = 0; margin <= 1; margin += 0.01) {
    const value = logPairedEValue(counts, margin);
    assert.ok(value <= previous + 1e-12);
    previous = value;
  }
  const single = pairedDifferenceLowerBound(counts, { comparisons: 1 });
  const many = pairedDifferenceLowerBound(counts, { comparisons: 23 });
  assert.ok(single.lower > many.lower);
  assert.ok(logPairedEValue(counts, many.lower) > many.minimumEvidenceLogThreshold);
  assert.ok(logPairedEValue(counts, many.lower + 1e-8) < many.minimumEvidenceLogThreshold);
  for (const invalid of [{ betterOnly: '2', worseOnly: 0, equal: 1 },
    { betterOnly: 0, worseOnly: 0, equal: 0 },
    { betterOnly: 2, worseOnly: 0, equal: 1, extra: true }]) {
    assert.throws(() => pairedDifferenceLowerBound(invalid, { comparisons: 1 }));
  }
});

test('exact multinomial null enumeration respects nominal risk across paired distributions', () => {
  // This is exact finite-sample probability summation, NOT a Monte Carlo pass
  // rate or a claim of exhaustive mathematical proof for all distributions.
  const n = 32;
  const logFactorial = [0];
  for (let i = 1; i <= n; i++) logFactorial[i] = logFactorial[i - 1] + Math.log(i);
  for (const comparisons of [1, 3, 23]) for (let plus = 0; plus <= 10; plus++) {
    for (let minus = 0; minus <= 10 - plus; minus++) {
      const probabilities = [plus / 10, minus / 10, (10 - plus - minus) / 10];
      const margin = Math.max(0, probabilities[0] - probabilities[1]);
      let rejectionProbability = 0;
      for (let wins = 0; wins <= n; wins++) for (let losses = 0; losses <= n - wins; losses++) {
        const counts = [wins, losses, n - wins - losses];
        if (counts.some((count, i) => count && !probabilities[i])) continue;
        const logProbability = logFactorial[n] - counts.reduce((sum, count) => sum + logFactorial[count], 0)
          + counts.reduce((sum, count, i) => sum + (count ? count * Math.log(probabilities[i]) : 0), 0);
        const logE = logPairedEValue({ betterOnly: wins, worseOnly: losses, equal: counts[2] }, margin);
        if (logE > Math.log(comparisons / 0.05)) rejectionProbability += Math.exp(logProbability);
      }
      assert.ok(rejectionProbability <= 0.05 / comparisons + 1e-12,
        JSON.stringify({ comparisons, probabilities, margin, rejectionProbability }));
    }
  }
});
