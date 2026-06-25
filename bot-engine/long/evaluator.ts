import type { LongBotWeights } from './types.ts';
import {
  blockadeScore,
  distributionPenalty,
  footholdScore,
  headCheckers,
  headLandingSupportScore,
  homeBoardCount,
  homeReady,
  homeTotalCount,
  offCount,
  opponentOf,
  opponentHeadBlockScore,
  phasePressure,
  pipsFor,
  prematureHomeRushPenalty,
  stuckRisk,
  tempoValue,
} from './metrics.ts';

export const DEFAULT_LONG_BOT_WEIGHTS = {
  progress: 92,
  homeCheckers: 420,
  borneOff: 18000,
  blockade: 950,
  stuckRisk: 2100,
  distribution: 780,
  tempo: 1650,
  bearOffPriority: 90000000,
  headRelease: 9800,
  foothold: 4300,
  rushPenalty: 12500,
};

export function mergeWeights(weights = {}) {
  return { ...DEFAULT_LONG_BOT_WEIGHTS, ...(weights || {}) };
}

export function evaluateState(state, color, weights = DEFAULT_LONG_BOT_WEIGHTS) {
  const opponent = opponentOf(color);
  const ownPips = pipsFor(state, color);
  const opponentPips = pipsFor(state, opponent);
  const ownOff = offCount(state, color);
  const opponentOff = offCount(state, opponent);
  const pressure = phasePressure(state, color);

  return (opponentPips - ownPips) * weights.progress
    + homeTotalCount(state, color) * weights.homeCheckers
    - homeTotalCount(state, opponent) * weights.homeCheckers * 0.62
    + ownOff * weights.borneOff
    - opponentOff * weights.borneOff * 1.12
    + blockadeScore(state, color) * weights.blockade
    - blockadeScore(state, opponent) * weights.blockade * 0.58
    - stuckRisk(state, color) * weights.stuckRisk * pressure
    + stuckRisk(state, opponent) * weights.stuckRisk * 0.42
    - distributionPenalty(state, color) * weights.distribution
    + distributionPenalty(state, opponent) * weights.distribution * 0.2
    + headLandingSupportScore(state, color) * weights.headRelease
    - headLandingSupportScore(state, opponent) * weights.headRelease * 0.34
    + opponentHeadBlockScore(state, color) * weights.headRelease * 0.82
    + footholdScore(state, color) * weights.foothold
    - footholdScore(state, opponent) * weights.foothold * 0.38
    - prematureHomeRushPenalty(state, color) * weights.rushPenalty;
}

export function sequenceStats(before, after, color, sequence = []) {
  const offGain = offCount(after, color) - offCount(before, color);
  const homeGain = homeBoardCount(after, color) - homeBoardCount(before, color);
  const pipGain = pipsFor(before, color) - pipsFor(after, color);
  const riskDelta = stuckRisk(before, color) - stuckRisk(after, color);
  const distributionDelta = distributionPenalty(before, color) - distributionPenalty(after, color);
  const blockadeGain = blockadeScore(after, color) - blockadeScore(before, color);
  const headGain = headCheckers(before, color) - headCheckers(after, color);
  const footholdGain = footholdScore(after, color) - footholdScore(before, color);
  const bearOffMoves = sequence.filter(move => move.bearOff || move.to === 0).length;
  const homeShuffleMoves = sequence.filter(move => !move.bearOff && move.to !== 0).length - Math.max(0, homeGain);

  return {
    offGain,
    homeGain,
    pipGain,
    riskDelta,
    distributionDelta,
    blockadeGain,
    headGain,
    footholdGain,
    bearOffMoves,
    homeShuffleMoves: Math.max(0, homeShuffleMoves),
  };
}

export function scoreSequence(before, after, color, sequence = [], weights = DEFAULT_LONG_BOT_WEIGHTS) {
  const stats = sequenceStats(before, after, color, sequence);
  const pressure = phasePressure(before, color);
  let score = evaluateState(after, color, weights) - evaluateState(before, color, weights);

  score += tempoValue(before, after, color) * weights.tempo * pressure;
  score += stats.blockadeGain * weights.blockade * 0.9;
  score += stats.riskDelta * weights.stuckRisk * 1.35;
  score += stats.distributionDelta * weights.distribution * 0.7;
  score += stats.offGain * weights.borneOff * 2.3;
  score += Math.max(0, stats.headGain) * weights.headRelease * (homeReady(before, color) ? 0.12 : 1.15);
  score += stats.footholdGain * weights.foothold * 1.2;

  if (homeReady(before, color)) {
    score += stats.offGain * weights.bearOffPriority * pressure;
    score += stats.pipGain * weights.tempo * 5;
    score -= stats.homeShuffleMoves * weights.bearOffPriority * 0.22;
  } else if (homeReady(after, color)) {
    score += weights.borneOff * 1.8;
  }

  return score;
}
