'use strict';

// Offline statistical research only. This module is NOT a production evidence
// format, a worker release, or permission to ingest diagnostic simulations.
// Derived from nonnegative test martingales for bounded means:
// Waudby-Smith & Ramdas, JRSS B 86(1), doi:10.1093/jrsssb/qkad009, Section 4.
const METHOD = 'paired-betting-union-bound-v1';
const FRACTIONS = Object.freeze([0.1, 0.3, 0.5, 0.7, 0.9]);

function validateCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)
    || Object.keys(counts).sort().join(',') !== 'betterOnly,equal,worseOnly'
    || Object.values(counts).some(n => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error('Paired counts must be native nonnegative integers');
  }
  const samples = counts.betterOnly + counts.worseOnly + counts.equal;
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1000000) {
    throw new Error('Paired sample count is outside the bounded research range');
  }
  return samples;
}

function countsForPairedOutcomes(selected, candidate) {
  if (!Array.isArray(selected) || !Array.isArray(candidate)
    || selected.length !== candidate.length || !selected.length
    || selected.length > 1000000) throw new Error('Complete paired outcome vectors are required');
  const counts = { betterOnly: 0, worseOnly: 0, equal: 0 };
  for (let index = 0; index < selected.length; index++) {
    if (![0, 1].includes(selected[index]) || ![0, 1].includes(candidate[index])) {
      throw new Error('Every paired outcome must be a native binary terminal result');
    }
    const difference = candidate[index] - selected[index];
    counts[difference > 0 ? 'betterOnly' : difference < 0 ? 'worseOnly' : 'equal']++;
  }
  return counts;
}

function logEValueUnchecked(counts, margin) {
  // D = candidateWin - selectedWin lies in [-1,1]. Under E[D] <= m,
  // each fixed-fraction capital has conditional expectation <= 1:
  // product(1 + f * (D-m)/(1+m)), 0 < f < 1. A fixed equal-weight
  // mixture remains an e-value. Fractions are never optimized from outcomes.
  const capitals = FRACTIONS.map(fraction => (
    counts.betterOnly * Math.log1p(fraction * (1 - margin) / (1 + margin))
    + counts.worseOnly * Math.log1p(-fraction)
    + counts.equal * Math.log1p(-fraction * margin / (1 + margin))
  ));
  const maximum = Math.max(...capitals);
  return maximum + Math.log(capitals.reduce((sum, value) => sum + Math.exp(value - maximum), 0))
    - Math.log(FRACTIONS.length);
}

function logPairedEValue(counts, margin = 0) {
  validateCounts(counts);
  if (!Number.isFinite(margin) || margin < 0 || margin > 1) {
    throw new Error('Paired margin must be a native number in [0,1]');
  }
  return logEValueUnchecked(counts, margin);
}

function pairedDifferenceLowerBound(counts, { comparisons, alpha = 0.05 } = {}) {
  const samples = validateCounts(counts);
  if (!Number.isSafeInteger(comparisons) || comparisons < 1 || comparisons > 255
    || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error('Predetermined comparison count and familywise alpha are required');
  }
  // There are K-1 one-sided contrasts with the PRESELECTED archived action.
  // This is not an unadjusted CI for whichever alternative won the sample.
  const threshold = Math.log(comparisons / alpha);
  let lower = 0;
  let upper = 1;
  if (logEValueUnchecked(counts, 0) <= threshold) lower = -1;
  else {
    // Every mixture component is nonincreasing in m: its derivative is
    // -f*(1+D)/(1+m)^2. Return the conservative rejected-side endpoint,
    // rounded DOWN, rather than the accepted upper side of the bracket.
    for (let iteration = 0; iteration < 52; iteration++) {
      const middle = (lower + upper) / 2;
      if (logEValueUnchecked(counts, middle) > threshold) lower = middle;
      else upper = middle;
    }
    lower = Math.max(-1, lower - 1e-10);
  }
  return { method: METHOD, lower, samples, comparisons, familywiseAlpha: alpha,
    meanDifference: (counts.betterOnly - counts.worseOnly) / samples,
    logEValueAtEightPoints: logEValueUnchecked(counts, 0.08),
    minimumEvidenceLogThreshold: threshold, counts: { ...counts },
    productionEvidence: false };
}

module.exports = { METHOD, FRACTIONS, validateCounts, countsForPairedOutcomes,
  logPairedEValue, pairedDifferenceLowerBound };
