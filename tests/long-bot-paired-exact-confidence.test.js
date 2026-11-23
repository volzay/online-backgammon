'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { METHOD, MAX_PAIRS, GRID_BITS, clopperPearsonLower, pairedMeanLowerBound } =
  require('../lib/long-bot-paired-exact-confidence');

const ALPHA = 0.0125;
const GRID_STEP = 2 ** -GRID_BITS;
const choose = (n, k) => {
  let value = 1;
  for (let j = 1; j <= k; j++) value = value * (n - j + 1) / j;
  return value;
};
const directTail = (k, n, p) => {
  let sum = 0;
  for (let j = k; j <= n; j++) sum += choose(n, j) * p ** j * (1 - p) ** (n - j);
  return sum;
};

test('one-sided CP matches closed-form boundary roots from below', () => {
  for (const alpha of [1e-10, 0.00625, 0.05, 0.49]) for (const n of [1, 2, 8, 128]) {
    const guarded = alpha * (1 - 2 ** -32);
    for (const [k, exact] of [[n, guarded ** (1 / n)], [1, -Math.expm1(Math.log1p(-guarded) / n)]]) {
      const lower = clopperPearsonLower(k, n, alpha);
      assert.ok(lower <= exact + Number.EPSILON, JSON.stringify({ alpha, n, k, lower, exact }));
      assert.ok(exact - lower < GRID_STEP + 3 * Number.EPSILON);
    }
    assert.equal(clopperPearsonLower(0, n, alpha), 0);
  }
  assert.equal(clopperPearsonLower(0, 0, 0.05), 0);
});

test('exact inversion agrees with independent direct binomial tails on small counts', () => {
  for (const alpha of [0.00625, 0.05, 0.2]) for (let n = 1; n <= 18; n++) {
    for (let k = 1; k <= n; k++) {
      const lower = clopperPearsonLower(k, n, alpha);
      const guarded = alpha * (1 - 2 ** -32);
      assert.ok(directTail(k, n, lower) <= guarded + 3e-15);
      assert.ok(directTail(k, n, lower + GRID_STEP) >= guarded - 3e-15);
      assert.ok(lower > 0 && lower < k / n);
    }
  }
});

test('NIST worked exact lower limit uses a one-sided 0.05 tail', () => {
  // NIST's 90% two-sided example n=20,k=4 has lower endpoint 0.071354.
  // The SAME lower endpoint uses one-sided alpha 0.05, not alpha 0.10.
  const lower = clopperPearsonLower(4, 20, 0.05);
  assert.ok(Math.abs(lower - 0.071353884) < 1e-8);
  assert.ok(clopperPearsonLower(4, 20, 0.10) > lower);
});

test('all pairs, including splits, contribute to the fixed score and non-tie rate', () => {
  const counts = { sweepWins: 32, sweepLosses: 0, splitPairs: 96 };
  const result = pairedMeanLowerBound(counts, { declaredPairs: 128, alpha: ALPHA });
  assert.equal(result.method, METHOD);
  assert.equal(result.samples, 128);
  assert.equal(result.discordant, 32);
  assert.equal(result.meanScore, 0.625);
  assert.equal(result.alpha, ALPHA);
  assert.equal(result.componentAlpha, 0.00625);
  assert.equal(result.minimumCoverage, 0.9875);
  assert.ok(result.lower > 0.5 && result.lower < result.meanScore);
  assert.equal(result.meanLower, result.lower);
  assert.equal(result.pLower, clopperPearsonLower(32, 32, ALPHA / 2));
  assert.equal(result.qLower, clopperPearsonLower(32, 128, ALPHA / 2));
  assert.ok(result.qLower < result.pLower);
  assert.equal(result.productionEvidence, false);
  assert.equal(result.scopeIndependentlyVerifiedByThisModule, false);
  assert.equal(result.requiredScope.independentIdenticallyGeneratedPairs, true);
  assert.equal(result.requiredScope.optionalStoppingAllowed, false);
  assert.equal(result.requiredScope.selectionUsingTheseOutcomesAllowed, false);
  assert.ok(Object.isFrozen(result.requiredScope));
  assert.equal(result.numerics.binomialTailArithmetic, 'exact-bigint-rational');
});

test('composition and reported mean are floored in exact dyadic arithmetic', () => {
  for (const counts of [{ sweepWins: 12, sweepLosses: 1, splitPairs: 19 },
    { sweepWins: 90, sweepLosses: 10, splitPairs: 28 },
    { sweepWins: 128, sweepLosses: 0, splitPairs: 0 }]) {
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    const result = pairedMeanLowerBound(counts, { declaredPairs: n, alpha: ALPHA });
    const grid = 1n << BigInt(GRID_BITS);
    const p = BigInt(result.pLower * Number(grid));
    const q = BigInt(result.qLower * Number(grid));
    const expected = p > grid / 2n ? grid / 2n + (q * (p - grid / 2n) >> BigInt(GRID_BITS)) : 0n;
    assert.equal(result.lower, Number(expected) / Number(grid));
    assert.ok(result.lower <= 0.5 + result.qLower * (result.pLower - 0.5) + Number.EPSILON);
    assert.ok(result.lower < result.meanScore);
  }
});

test('zero discordances, no sweeps won, and nonpositive conditional evidence return zero', () => {
  for (const counts of [{ sweepWins: 0, sweepLosses: 0, splitPairs: 128 },
    { sweepWins: 0, sweepLosses: 16, splitPairs: 112 },
    { sweepWins: 64, sweepLosses: 64, splitPairs: 0 }]) {
    const result = pairedMeanLowerBound(counts, { declaredPairs: 128, alpha: ALPHA });
    assert.equal(result.lower, 0);
  }
});

test('fixed protocol and full coverage validation rejects incomplete or invented scores', () => {
  const valid = { sweepWins: 20, sweepLosses: 10, splitPairs: 98 };
  for (const counts of [null, {}, { ...valid, extra: true }, { ...valid, sweepWins: '20' },
    { ...valid, splitPairs: 97.5 }, { ...valid, sweepLosses: -1 }]) {
    assert.throws(() => pairedMeanLowerBound(counts, { declaredPairs: 128, alpha: ALPHA }));
  }
  for (const declaredPairs of [undefined, 0, 127, 129, MAX_PAIRS + 1, Infinity]) {
    assert.throws(() => pairedMeanLowerBound(valid, { declaredPairs, alpha: ALPHA }));
  }
  for (const alpha of [undefined, 0, -0.1, 1e-14, 0.5, 1, NaN, Infinity]) {
    assert.throws(() => pairedMeanLowerBound(valid, { declaredPairs: 128, alpha }));
  }
  for (const args of [[-1, 1, .05], [2, 1, .05], [1.5, 2, .05], [1, MAX_PAIRS + 1, .05]]) {
    assert.throws(() => clopperPearsonLower(...args));
  }
});

test('exact finite multinomial coverage over every small-n count outcome and parameter grid', () => {
  // Exhaustive OUTCOMES for each n and parameter grid point, not Monte Carlo.
  // The mathematical conditional-CP+union proof covers parameters between grid
  // points; this numerical regression is not a substitute for that proof.
  for (const n of [1, 2, 4, 8, 12, 16]) {
    const outcomes = [];
    for (let m = 0; m <= n; m++) for (let a = 0; a <= m; a++) {
      const counts = { sweepWins: a, sweepLosses: m - a, splitPairs: n - m };
      outcomes.push({ a, m, lower: pairedMeanLowerBound(counts, { declaredPairs: n, alpha: ALPHA }).lower });
    }
    for (let qi = 0; qi <= 10; qi++) for (let pi = 0; pi <= 10; pi++) {
      const q = qi / 10;
      const p = pi / 10;
      const trueMean = 0.5 + q * (p - 0.5);
      let missed = 0;
      let probability = 0;
      for (const { a, m, lower } of outcomes) {
        const mass = choose(n, m) * q ** m * (1 - q) ** (n - m)
          * choose(m, a) * p ** a * (1 - p) ** (m - a);
        probability += mass;
        if (lower > trueMean + 1e-14) missed += mass;
      }
      assert.ok(Math.abs(probability - 1) < 2e-13);
      assert.ok(missed <= ALPHA + 1e-13, JSON.stringify({ n, q, p, trueMean, missed }));
    }
  }
});

test('paired composition can beat coarse Hoeffding but is not claimed uniformly better', () => {
  const result = pairedMeanLowerBound({ sweepWins: 20, sweepLosses: 0, splitPairs: 108 },
    { declaredPairs: 128, alpha: ALPHA });
  const hoeffding = result.meanScore - Math.sqrt(Math.log(1 / ALPHA) / (2 * 128));
  assert.ok(result.lower > 0.5);
  assert.ok(hoeffding < 0.5);
  // Fewer ties/less conditional evidence can favor the older Hoeffding lower.
  const other = pairedMeanLowerBound({ sweepWins: 64, sweepLosses: 64, splitPairs: 0 },
    { declaredPairs: 128, alpha: ALPHA });
  assert.ok(other.lower < other.meanScore - Math.sqrt(Math.log(1 / ALPHA) / (2 * 128)));
});
