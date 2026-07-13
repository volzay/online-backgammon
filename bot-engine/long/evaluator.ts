import type { LongBotWeights } from './types.ts';
import {
  blockadeScore,
  developmentPressure,
  distributionPenalty,
  entryContinuationMoveCount,
  entryZoneOutsideCount,
  escapeGatewayRisk,
  fenceClosureRisk,
  footholdScore,
  headCheckers,
  headLandingBreakRisk,
  headLandingExposureRisk,
  headLandingSupportScore,
  headPoint,
  homeEntryMoveCount,
  homeBoardCount,
  homeReady,
  homeShuffleMoveCount,
  homeTotalCount,
  laggardRouteDebt,
  lateEntryPressure,
  offCount,
  opponentOf,
  opponentHeadFenceBarrierScore,
  opponentHeadBlockScore,
  opponentHeadFreedomRisk,
  opponentFenceRun,
  opponentTrapRisk,
  outsideDevelopmentMoveCount,
  outsideHomeCount,
  outsideHomePips,
  pathPos,
  phasePressure,
  pipsFor,
  prematureHomeRushPenalty,
  routeCompletionPressure,
  routeTowerRisk,
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
  homeEntry: 145000,
  trapRisk: 62000,
  headLandingExposure: 62000,
  opponentHeadFreedom: 48000,
  escapeGatewayRisk: 800000,
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
  const entryPressure = lateEntryPressure(state, color);
  const ownTrapRisk = opponentTrapRisk(state, color);
  const ownFenceClosureRisk = fenceClosureRisk(state, color);
  const opponentTrapReward = cappedTrapReward(opponentTrapRisk(state, opponent));

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
    - routeTowerRisk(state, color) * weights.distribution * 12
    + distributionPenalty(state, opponent) * weights.distribution * 0.2
    + headLandingSupportScore(state, color) * weights.headRelease
    - headLandingSupportScore(state, opponent) * weights.headRelease * 0.34
    + opponentHeadBlockScore(state, color) * weights.headRelease * 0.82
    - opponentHeadFreedomRisk(state, color) * weights.opponentHeadFreedom
    + footholdScore(state, color) * weights.foothold
    - footholdScore(state, opponent) * weights.foothold * 0.38
    - headLandingExposureRisk(state, color) * weights.headLandingExposure
    + headLandingExposureRisk(state, opponent) * weights.headLandingExposure * 0.18
    - prematureHomeRushPenalty(state, color) * weights.rushPenalty
    - entryZoneOutsideCount(state, color) * weights.homeEntry * entryPressure
    + entryZoneOutsideCount(state, opponent) * weights.homeEntry * lateEntryPressure(state, opponent) * 0.34
    - ownTrapRisk * weights.trapRisk
    - ownFenceClosureRisk * weights.trapRisk * 1.45
    + opponentTrapReward * weights.trapRisk * 0.055
    - escapeGatewayRisk(state, color) * weights.escapeGatewayRisk
    + escapeGatewayRisk(state, opponent) * weights.escapeGatewayRisk * 0.12;
}

export function sequenceStats(before, after, color, sequence = []) {
  const offGain = offCount(after, color) - offCount(before, color);
  const homeGain = homeBoardCount(after, color) - homeBoardCount(before, color);
  const pipGain = pipsFor(before, color) - pipsFor(after, color);
  const riskDelta = stuckRisk(before, color) - stuckRisk(after, color);
  const distributionDelta = distributionPenalty(before, color) - distributionPenalty(after, color);
  const routeTowerDelta = routeTowerRisk(before, color) - routeTowerRisk(after, color);
  const blockadeGain = blockadeScore(after, color) - blockadeScore(before, color);
  const headGain = headCheckers(before, color) - headCheckers(after, color);
  const footholdGain = footholdScore(after, color) - footholdScore(before, color);
  const outsideReduction = Math.max(0, outsideHomeCount(before, color) - outsideHomeCount(after, color));
  const outsidePipGain = Math.max(0, outsideHomePips(before, color) - outsideHomePips(after, color));
  const laggardDebtDelta = laggardRouteDebt(before, color) - laggardRouteDebt(after, color);
  const homeEntryMoves = homeEntryMoveCount(sequence, color);
  const trapDelta = opponentTrapRisk(before, color) - opponentTrapRisk(after, color);
  const trapBefore = opponentTrapRisk(before, color);
  const fenceClosureDelta = fenceClosureRisk(before, color) - fenceClosureRisk(after, color);
  const fenceClosureBefore = fenceClosureRisk(before, color);
  const opponent = opponentOf(color);
  const opponentTrapGain = Math.max(0, opponentTrapRisk(after, opponent) - opponentTrapRisk(before, opponent));
  const headLandingBreak = headLandingBreakRisk(before, after, color);
  const outsideDevelopmentMoves = outsideDevelopmentMoveCount(sequence, color);
  const entryContinuationMoves = entryContinuationMoveCount(sequence, color);
  const opponentHeadFreedomDelta = opponentHeadFreedomRisk(before, color)
    - opponentHeadFreedomRisk(after, color);
  const opponentHeadBarrierDelta = opponentHeadFenceBarrierScore(after, color)
    - opponentHeadFenceBarrierScore(before, color);
  const escapeGatewayDelta = escapeGatewayRisk(before, color) - escapeGatewayRisk(after, color);
  const bearOffMoves = sequence.filter(move => move.bearOff || move.to === 0).length;
  const homeShuffleMoves = homeShuffleMoveCount(sequence, color);
  const maxRouteTowerAfter = Object.entries(after.points || {}).reduce((maximum, [point, stack]) => (
    stack.color === color && Number(point) !== Number(headPoint(color))
      ? Math.max(maximum, Number(stack.count) || 0)
      : maximum
  ), 0);
  const routeSignature = sequence
    .map(move => {
      const from = Math.max(0, pathPos(color, Number(move.from)));
      const to = move.bearOff || move.to === 0
        ? 24
        : Math.max(0, pathPos(color, Number(move.to)));
      return `${Math.floor(from / 3)}>${Math.floor(to / 3)}`;
    })
    .sort()
    .join('+');

  return {
    offGain,
    homeGain,
    pipGain,
    riskDelta,
    distributionDelta,
    routeTowerDelta,
    routeTowerAfter: routeTowerRisk(after, color),
    opponentFenceRunBefore: opponentFenceRun(before, color),
    blockadeGain,
    headGain,
    footholdGain,
    outsideReduction,
    outsidePipGain,
    laggardDebtDelta,
    homeEntryMoves,
    trapDelta,
    trapBefore,
    fenceClosureDelta,
    fenceClosureBefore,
    opponentTrapGain,
    headLandingBreak,
    outsideDevelopmentMoves,
    entryContinuationMoves,
    opponentHeadFreedomDelta,
    opponentHeadBarrierDelta,
    escapeGatewayDelta,
    bearOffMoves,
    homeShuffleMoves,
    routeSignature,
    maxRouteTowerAfter,
  };
}

export function scoreSequence(before, after, color, sequence = [], weights = DEFAULT_LONG_BOT_WEIGHTS) {
  const stats = sequenceStats(before, after, color, sequence);
  const pressure = phasePressure(before, color);
  const entryPressure = lateEntryPressure(before, color);
  const completionPressure = routeCompletionPressure(before, color);
  const development = developmentPressure(before, color);
  let score = evaluateState(after, color, weights) - evaluateState(before, color, weights);

  score += tempoValue(before, after, color) * weights.tempo * pressure;
  score += stats.blockadeGain * weights.blockade * 0.9;
  score += stats.riskDelta * weights.stuckRisk * 1.35;
  score += stats.distributionDelta * weights.distribution * 0.7;
  score += stats.offGain * weights.borneOff * 2.3;
  score += Math.max(0, stats.headGain) * weights.headRelease * (homeReady(before, color) ? 0.12 : 1.15);
  score += stats.footholdGain * weights.foothold * 1.2;
  score += stats.homeEntryMoves * weights.homeEntry * 4.2 * entryPressure;
  score += stats.outsideReduction * weights.homeEntry * 3.6 * entryPressure;
  score += stats.outsideReduction * weights.homeEntry * 18 * completionPressure;
  score += stats.outsidePipGain * weights.tempo * 0.52 * completionPressure;
  score += stats.laggardDebtDelta * weights.homeEntry;
  score += stats.trapDelta * weights.trapRisk * 1.8;
  score += stats.fenceClosureDelta * weights.trapRisk * 2.35;
  score += cappedTrapReward(stats.opponentTrapGain) * weights.trapRisk * 0.08;
  score -= stats.headLandingBreak * weights.headLandingExposure * 1.35;
  score += stats.opponentHeadFreedomDelta * weights.opponentHeadFreedom * 1.55;
  score += stats.opponentHeadBarrierDelta * weights.opponentHeadFreedom * 0.55;
  score += stats.escapeGatewayDelta * weights.escapeGatewayRisk * 1.6;
  score += stats.outsideDevelopmentMoves * weights.homeEntry * 0.88 * development;
  score += stats.entryContinuationMoves * weights.tempo * 0.42;
  if (stats.trapBefore > 0 && stats.trapDelta <= 0) {
    score -= Math.min(stats.trapBefore, 260) * weights.trapRisk * 0.38;
  }
  if (!homeReady(before, color)) {
    const tacticalJustification = cappedTrapReward(stats.opponentTrapGain) * weights.trapRisk * 0.11
      + Math.max(0, stats.blockadeGain) * weights.blockade * 0.85;
    const shufflePenalty = stats.homeShuffleMoves
      * weights.homeEntry
      * 1.18
      * Math.max(1, entryPressure)
      * Math.max(1, development)
      * Math.max(1, completionPressure);
    score -= Math.max(0, shufflePenalty - tacticalJustification);
  }

  if (homeReady(before, color)) {
    score += stats.offGain * weights.bearOffPriority * pressure;
    score += stats.pipGain * weights.tempo * 5;
    score -= stats.homeShuffleMoves * weights.bearOffPriority * 0.22;
  } else if (homeReady(after, color)) {
    score += weights.borneOff * 1.8;
  }

  return score;
}

function cappedTrapReward(value) {
  const risk = Math.max(0, Number(value) || 0);
  return Math.min(850, risk);
}
