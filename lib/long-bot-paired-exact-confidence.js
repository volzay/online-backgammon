'use strict';

// RESEARCH ONLY: this does not authenticate games, authorize publication, or
// replace a protocol frozen before the candidate's evaluation outcomes exist.
// Clopper-Pearson inversion (one-sided tail alpha):
// https://itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbici.htm
// https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2119.pdf
// Union/Bonferroni inequality, which does not require independent intervals:
// https://itl.nist.gov/div898/handbook/prc/section4/prc473.htm
// The paired-mean composition below is derived here, not a NIST procedure.
const METHOD = 'paired-trinomial-clopper-pearson-union-v1';
const MAX_PAIRS = 1024;
const GRID_BITS = 48;
const GRID = 1n << BigInt(GRID_BITS);
const HALF_GRID = GRID >> 1n;
const ALPHA_MARGIN_BITS = 32;
const NUMERICS = Object.freeze({
  binomialTailArithmetic: 'exact-bigint-rational',
  inversionGridBits: GRID_BITS,
  returnedBinomialEndpoint: 'lower-bracket',
  returnedMeanEndpoint: 'floor-to-the-same-dyadic-grid',
  alphaMultiplierNumerator: 2 ** ALPHA_MARGIN_BITS - 1,
  alphaMultiplierDenominator: 2 ** ALPHA_MARGIN_BITS,
});
const REQUIRED_SCOPE = Object.freeze({
  fixedSampleSize: true,
  completePairsOnly: true,
  independentIdenticallyGeneratedPairs: true,
  selectionUsingTheseOutcomesAllowed: false,
  optionalStoppingAllowed: false,
  appliesToDeclaredMatchupAndDiceGeneratorOnly: true,
});

function checkCounts(successes, trials) {
  if (!Number.isSafeInteger(trials) || trials < 0 || trials > MAX_PAIRS
    || !Number.isSafeInteger(successes) || successes < 0 || successes > trials) {
    throw new Error('Binomial counts must be nonnegative integers with successes <= trials <= 1024');
  }
}

function checkAlpha(alpha) {
  // The finite supported range is explicit; callers must not silently clamp a
  // protocol alpha. Its EXACT binary64 value is used as a rational below.
  if (!Number.isFinite(alpha) || alpha < 1e-12 || alpha >= 0.5) {
    throw new Error('A predeclared one-sided alpha in [1e-12, 0.5) is required');
  }
}

function conservativeAlphaRational(alpha) {
  // Recover the exact positive, normal binary64 input without decimal parsing.
  const data = new DataView(new ArrayBuffer(8));
  data.setFloat64(0, alpha, false);
  const bits = data.getBigUint64(0, false);
  const exponent = Number((bits >> 52n) & 0x7ffn) - 1023 - 52;
  let numerator = (1n << 52n) | (bits & ((1n << 52n) - 1n));
  let denominator = 1n;
  if (exponent < 0) denominator <<= BigInt(-exponent);
  else numerator <<= BigInt(exponent);
  // A tiny *downward* probability margin is exact, too. It is not an error
  // estimate for floating tails: the tails and their comparisons use BigInt.
  numerator *= (1n << BigInt(ALPHA_MARGIN_BITS)) - 1n;
  denominator <<= BigInt(ALPHA_MARGIN_BITS);
  return { numerator, denominator };
}

function tailAtDyadic(successes, trials, numerator, denominatorBits) {
  const denominator = 1n << BigInt(denominatorBits);
  const complement = denominator - numerator;
  const total = denominator ** BigInt(trials);
  if (!successes) return { numerator: total, denominator: total };
  if (!numerator) return { numerator: 0n, denominator: total };
  if (!complement) return { numerator: total, denominator: total };

  // Sum the shorter positive-term side. Every recurrence division is exact:
  // its dividend is C(n,j)u^j v^(n-j) times the adjacent-term ratio.
  // Complement subtraction is exact integer arithmetic, with no cancellation.
  let sum = 0n;
  if (successes <= trials - successes + 1) {
    let term = complement ** BigInt(trials);
    for (let index = 0; index < successes; index++) {
      sum += term;
      if (index + 1 < successes) term = term * BigInt(trials - index) * numerator
        / (BigInt(index + 1) * complement);
    }
    sum = total - sum;
  } else {
    let term = numerator ** BigInt(trials);
    for (let index = trials; index >= successes; index--) {
      sum += term;
      if (index > successes) term = term * BigInt(index) * complement
        / (BigInt(trials - index + 1) * numerator);
    }
  }
  return { numerator: sum, denominator: total };
}

function cpLowerGrid(successes, trials, alpha) {
  if (!successes) return 0n; // Includes the uninformative conditional M=0 case.
  const target = conservativeAlphaRational(alpha);
  // P_p(Bin(n,p)>=successes) increases with p. Maintain an exact rejected-side
  // endpoint below the tail=alpha root, and return only that lower endpoint.
  let lower = 0n;
  let upper = GRID;
  while (upper - lower > 1n) {
    const middle = (lower + upper) >> 1n;
    const tail = tailAtDyadic(successes, trials, middle, GRID_BITS);
    if (tail.numerator * target.denominator <= target.numerator * tail.denominator) lower = middle;
    else upper = middle;
  }
  return lower;
}

function clopperPearsonLower(successes, trials, alpha) {
  checkCounts(successes, trials);
  checkAlpha(alpha);
  return Number(cpLowerGrid(successes, trials, alpha)) / Number(GRID);
}

function validatePairedCounts(counts, declaredPairs) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)
    || Object.keys(counts).sort().join(',') !== 'splitPairs,sweepLosses,sweepWins'
    || Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0)
    || !Number.isSafeInteger(declaredPairs) || declaredPairs < 1 || declaredPairs > MAX_PAIRS) {
    throw new Error('Fixed complete paired sweepWins/sweepLosses/splitPairs counts are required');
  }
  const samples = counts.sweepWins + counts.sweepLosses + counts.splitPairs;
  if (!Number.isSafeInteger(samples) || samples !== declaredPairs) {
    throw new Error('Every predeclared pair must be complete; partial or outcome-selected samples cannot be accepted');
  }
  return samples;
}

function pairedMeanLowerBound(counts, { declaredPairs, alpha } = {}) {
  const samples = validatePairedCounts(counts, declaredPairs);
  checkAlpha(alpha);
  if (alpha / 2 < 1e-12) throw new Error('The allocated component alpha is outside the supported range');
  const discordant = counts.sweepWins + counts.sweepLosses;
  const componentAlpha = alpha / 2;
  const pNumerator = cpLowerGrid(counts.sweepWins, discordant, componentAlpha);
  const qNumerator = cpLowerGrid(discordant, samples, componentAlpha);
  // For IID pair scores S in {0,1/2,1}: M~Bin(n,q), A|M~Bin(M,p),
  // E[S]=1/2+q(p-1/2). Each CP lower bound misses with probability at most
  // alpha/2, conditionally on M for p and unconditionally for q. Their union
  // misses with probability at most alpha. If pLo>1/2, the expression is
  // increasing in both covered parameters. Otherwise 0 is always a valid
  // lower bound. This proof does not assume the two fitted bounds independent.
  // Floor the composed mean exactly, so floating addition/multiplication cannot
  // round a reported lower bound above the mathematical dyadic expression.
  const meanNumerator = pNumerator > HALF_GRID
    ? HALF_GRID + (qNumerator * (pNumerator - HALF_GRID) >> BigInt(GRID_BITS)) : 0n;
  const lower = Number(meanNumerator) / Number(GRID);
  return {
    method: METHOD,
    lower,
    meanLower: lower,
    meanScore: (counts.sweepWins + counts.splitPairs / 2) / samples,
    pLower: Number(pNumerator) / Number(GRID),
    qLower: Number(qNumerator) / Number(GRID),
    samples,
    discordant,
    counts: { ...counts },
    declaredPairs,
    alpha,
    componentAlpha,
    effectiveComponentAlpha: componentAlpha * (1 - 2 ** -ALPHA_MARGIN_BITS),
    minimumCoverage: 1 - alpha,
    complete: true,
    requiredScope: REQUIRED_SCOPE,
    scopeIndependentlyVerifiedByThisModule: false,
    numerics: NUMERICS,
    productionEvidence: false,
  };
}

module.exports = { METHOD, MAX_PAIRS, GRID_BITS, NUMERICS, REQUIRED_SCOPE,
  clopperPearsonLower, validatePairedCounts, pairedMeanLowerBound };
