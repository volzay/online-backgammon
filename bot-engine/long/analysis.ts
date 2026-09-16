import { evaluateState, scoreSequence } from './evaluator.ts';
import {
  fenceClosureRisk,
  headCheckers,
  homeReady,
  offCount,
  opponentOf,
  opponentTrapRisk,
  outsideHomeCount,
  pipsFor,
  primeCrunchRisk,
} from './metrics.ts';

const MAX_REPLY_SEQUENCES = 8;
const MAX_DOUBLE_REPLY_SEQUENCES = 4;
export const MAX_TACTICAL_CANDIDATES = 4;
const MAX_DEEP_CANDIDATES = 2;
const MAX_RECOVERY_SEQUENCES = 2;
const MAX_CONTINUATION_CANDIDATES = 2;
const MAX_CONTINUATION_SEQUENCES = 2;
const MAX_EXPERIENCE_PENALTY = 140000000;
const MAX_EXPERIENCE_REWARD = 30000000;
const EXPERIENCE_RISK_THRESHOLD = 1.1;
export const CANONICAL_DICE_WEIGHT = 36;
export const DICE_TAIL_WEIGHT = 6;

export function createAnalysisBudget(limit) {
  const normalizedLimit = Math.max(1, Math.floor(Number(limit) || 1));
  let used = 0;
  return {
    limit: normalizedLimit,
    consume(units = 1) {
      const normalizedUnits = Math.max(1, Math.floor(Number(units) || 1));
      if (used + normalizedUnits > normalizedLimit) return false;
      used += normalizedUnits;
      return true;
    },
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, normalizedLimit - used);
    },
  };
}

function hasAnalysisBudget(budget, units = 1) {
  return !budget || Number(budget.remaining) >= Math.max(1, Number(units) || 1);
}

function consumeAnalysisNode(budget, units = 1) {
  return !budget || budget.consume(units);
}

// Unordered pairs preserve all 36 ordered throws: non-doubles have two orders.
export const CANONICAL_DICE_OUTCOMES = Object.freeze(
  Array.from({ length: 6 }, (_, highOffset) => 6 - highOffset)
    .flatMap(high => Array.from({ length: high }, (_, lowOffset) => high - lowOffset)
      .map(low => Object.freeze({
        dice: Object.freeze([high, low]),
        weight: high === low ? 1 : 2,
      }))),
);

function hasCompleteDiceDistribution(rolls, weight) {
  return rolls === CANONICAL_DICE_OUTCOMES.length
    && weight === CANONICAL_DICE_WEIGHT;
}

function weightedLowerTailMean(outcomes, targetWeight = DICE_TAIL_WEIGHT) {
  const ordered = (Array.isArray(outcomes) ? outcomes : [])
    .filter(item => Number.isFinite(Number(item?.value)) && Number(item?.weight) > 0)
    .sort((left, right) => Number(left.value) - Number(right.value));
  let remaining = Math.max(1, Number(targetWeight) || 1);
  let used = 0;
  let total = 0;
  for (const item of ordered) {
    if (remaining <= 0) break;
    const weight = Math.min(remaining, Number(item.weight));
    total += Number(item.value) * weight;
    used += weight;
    remaining -= weight;
  }
  return used ? total / used : 0;
}

export function analyzeOpponentReplies(
  adapter,
  color,
  candidates,
  weights,
  budget,
  options = {},
) {
  const expandDoubles = Boolean(options.expandDoubles);
  const beforeDeepCandidate = typeof options.beforeDeepCandidate === 'function'
    ? options.beforeDeepCandidate
    : null;
  const beforeDeepSelection = typeof options.beforeDeepSelection === 'function'
    ? options.beforeDeepSelection
    : null;
  const tacticalCandidates = uniquePositionCandidates(
    candidates,
    MAX_TACTICAL_CANDIDATES,
  );
  if (!tacticalCandidates.length || !hasAnalysisBudget(budget)) return candidates;

  const opponent = opponentOf(color);
  const accumulators = tacticalCandidates.map(candidate => ({
    candidate,
    expandedReplyCoverage: primeCrunchRisk(candidate.after, color) >= 0.45,
    expectedImpact: 0,
    weight: 0,
    worstImpact: 0,
    rolls: 0,
    blockedWeight: 0,
    replySequenceWeight: 0,
    opponentPipGain: 0,
    opponentHeadRelease: 0,
    opponentOutsideReduction: 0,
    frontiers: [],
  }));

  for (const roll of CANONICAL_DICE_OUTCOMES) {
    if (!hasAnalysisBudget(budget)) break;
    let completedRoll = true;
    const rollResults = [];

    for (const accumulator of accumulators) {
      if (!consumeAnalysisNode(budget)) {
        completedRoll = false;
        break;
      }
      const replyState = prepareReplyState(
        accumulator.candidate.after,
        opponent,
        roll.dice,
        expandDoubles,
      );
      const expandedDouble = expandDoubles
        && roll.dice.length === 2
        && roll.dice[0] === roll.dice[1];
      const legalReplies = adapter.legalSequences(replyState, opponent, {
        limit: accumulator.expandedReplyCoverage
          ? (expandedDouble ? 24 : 0)
          : (expandDoubles ? 18 : 0),
      });
      const replySequences = sampledSequenceResults(
        adapter,
        replyState,
        opponent,
        legalReplies,
        accumulator.expandedReplyCoverage
          ? (expandedDouble ? MAX_DOUBLE_REPLY_SEQUENCES : MAX_REPLY_SEQUENCES)
          : 2,
        { preferLeading: !accumulator.expandedReplyCoverage || expandedDouble },
      );
      const beforeValue = evaluateState(replyState, color, weights);
      let worstValue = beforeValue;
      let worstState = replyState;

      for (const { sequence: reply, after: replyAfter } of replySequences) {
        const opponentGain = scoreSequence(replyState, replyAfter, opponent, reply, weights);
        const ownValue = evaluateState(replyAfter, color, weights);
        const replyValue = ownValue - Math.max(0, opponentGain) * 0.08;
        if (replyValue < worstValue) {
          worstValue = replyValue;
          worstState = replyAfter;
        }
      }
      if (!completedRoll) break;
      rollResults.push({
        impact: worstValue - beforeValue,
        state: worstState,
        blocked: replySequences.length === 0,
        replySequences: legalReplies.length,
        opponentPipGain: Math.max(
          0,
          pipsFor(replyState, opponent) - pipsFor(worstState, opponent),
        ),
        opponentHeadRelease: Math.max(
          0,
          headCheckers(replyState, opponent) - headCheckers(worstState, opponent),
        ),
        opponentOutsideReduction: Math.max(
          0,
          outsideHomeCount(replyState, opponent) - outsideHomeCount(worstState, opponent),
        ),
      });
    }

    if (!completedRoll) break;
    rollResults.forEach((result, index) => {
      const accumulator = accumulators[index];
      const impact = result.impact;
      accumulator.expectedImpact += impact * roll.weight;
      accumulator.weight += roll.weight;
      accumulator.worstImpact = Math.min(accumulator.worstImpact, impact);
      accumulator.rolls += 1;
      if (result.blocked) accumulator.blockedWeight += roll.weight;
      accumulator.replySequenceWeight += result.replySequences * roll.weight;
      accumulator.opponentPipGain += result.opponentPipGain * roll.weight;
      accumulator.opponentHeadRelease += result.opponentHeadRelease * roll.weight;
      accumulator.opponentOutsideReduction += result.opponentOutsideReduction * roll.weight;
      accumulator.frontiers.push({
        impact,
        state: result.state,
        diceKey: roll.dice.join(':'),
        weight: roll.weight,
      });
      accumulator.frontiers.sort((left, right) => left.impact - right.impact);
      accumulator.frontiers = accumulator.frontiers.slice(0, 2);
    });
  }

  accumulators.forEach((accumulator) => {
    if (!hasCompleteDiceDistribution(accumulator.rolls, accumulator.weight)) return;
    const expectedImpact = accumulator.expectedImpact / accumulator.weight;
    const tacticalAdjustment = expectedImpact * 0.42
      + accumulator.worstImpact * 0.14 * threatPressure(accumulator.candidate.after, color);
    accumulator.candidate.score += tacticalAdjustment;
    accumulator.candidate.tactical = {
      expectedImpact,
      worstImpact: accumulator.worstImpact,
      rolls: accumulator.rolls,
      distributionWeight: accumulator.weight,
      distributionComplete: true,
      adjustment: tacticalAdjustment,
      plies: 2,
      blockedProbability: accumulator.blockedWeight / accumulator.weight,
      expectedReplySequences: accumulator.replySequenceWeight / accumulator.weight,
      expectedOpponentPipGain: accumulator.opponentPipGain / accumulator.weight,
      expectedOpponentHeadRelease: accumulator.opponentHeadRelease / accumulator.weight,
      expectedOpponentOutsideReduction: accumulator.opponentOutsideReduction / accumulator.weight,
      doublesExpanded: expandDoubles,
      replyCoverageExpanded: accumulator.expandedReplyCoverage,
    };
  });

  if (beforeDeepCandidate) {
    accumulators.forEach((accumulator) => {
      if (accumulator.candidate.tactical) beforeDeepCandidate(accumulator.candidate);
    });
  }

  let deepAccumulators = accumulators;
  if (beforeDeepSelection) {
    const byCandidate = new Map(accumulators.map(accumulator => [
      accumulator.candidate,
      accumulator,
    ]));
    const prioritizedCandidates = beforeDeepSelection(accumulators
      .filter(accumulator => accumulator.candidate.tactical)
      .map(accumulator => accumulator.candidate));
    if (Array.isArray(prioritizedCandidates)) {
      const prioritized = prioritizedCandidates
        .map(candidate => byCandidate.get(candidate))
        .filter(Boolean);
      const included = new Set(prioritized);
      deepAccumulators = [
        ...prioritized,
        ...accumulators.filter(accumulator => !included.has(accumulator)),
      ];
    }
  }

  analyzeRecoveryReplies(adapter, color, deepAccumulators, weights, budget, expandDoubles);
  completeProvisionalLeaderAnalysis(
    adapter,
    color,
    deepAccumulators,
    weights,
    budget,
    expandDoubles,
  );
  propagateEquivalentPositionAnalysis(candidates, accumulators);

  return candidates.sort((left, right) => right.score - left.score);
}

function propagateEquivalentPositionAnalysis(candidates, accumulators) {
  const analyzedByPosition = new Map();
  const reservationsByPosition = new Map();
  const reservationKeys = [
    'structuralIntegrityTacticalReservation',
    'homeEntryTacticalReservation',
    'routeContinuityTacticalReservation',
    'fenceEscapeTacticalReservation',
    'contestedHeadExitTacticalReservation',
    'primeSustainabilityTacticalReservation',
  ];
  candidates.forEach((candidate) => {
    const key = positionKey(candidate.after);
    const flags = reservationsByPosition.get(key) || {};
    reservationKeys.forEach((reservationKey) => {
      if (Number(candidate.features?.[reservationKey] || 0) > 0) flags[reservationKey] = 1;
    });
    reservationsByPosition.set(key, flags);
  });
  accumulators.forEach(({ candidate }) => {
    if (candidate.tactical) {
      analyzedByPosition.set(positionKey(candidate.after), candidate);
    }
  });

  candidates.forEach((candidate) => {
    Object.assign(candidate.features, reservationsByPosition.get(positionKey(candidate.after)) || {});
    if (candidate.tactical) return;
    const analyzed = analyzedByPosition.get(positionKey(candidate.after));
    if (!analyzed?.tactical) return;
    const adjustment = Number(analyzed.tactical.adjustment || 0)
      + Number(analyzed.tactical.deepAdjustment || 0)
      + Number(analyzed.tactical.continuationAdjustment || 0);
    candidate.score += adjustment;
    candidate.tactical = {
      ...analyzed.tactical,
      equivalentPosition: true,
    };
  });
}

function uniquePositionCandidates(candidates, limit) {
  const selected = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = positionKey(candidate.after);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

function positionKey(state) {
  const points = Object.entries(state.points || {})
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([point, stack]) => `${point}:${stack.color}:${stack.count}`)
    .join('|');
  return `${points}|${Number(state.off?.white) || 0}:${Number(state.off?.dark) || 0}`;
}

function analyzeRecoveryReplies(adapter, color, accumulators, weights, budget, expandDoubles) {
  const rankedCandidates = accumulators
    .filter(accumulator => (
      accumulator.candidate.tactical
      && Number(accumulator.candidate.tactical.plies || 0) < 3
      && accumulator.frontiers.length
    ))
    .sort((left, right) => right.candidate.score - left.candidate.score);
  const deepCandidates = selectDeepCandidates(rankedCandidates);

  for (const accumulator of deepCandidates) {
    if (!hasAnalysisBudget(budget)) break;
    const frontier = accumulator.frontiers[0];
    let expectedRecovery = 0;
    let recoveryWeight = 0;
    let worstRecovery = Infinity;
    let recoveryRolls = 0;
    const recoveryFrontiers = [];

    for (const roll of CANONICAL_DICE_OUTCOMES) {
      if (!consumeAnalysisNode(budget)) break;
      const recoveryState = prepareReplyState(
        frontier.state,
        color,
        roll.dice,
        expandDoubles,
      );
      const legalRecoverySequences = adapter.legalSequences(recoveryState, color, {
        limit: expandDoubles ? 4 : 0,
      });
      const recoverySequences = sampledSequenceResults(
        adapter,
        recoveryState,
        color,
        legalRecoverySequences,
        MAX_RECOVERY_SEQUENCES,
      );
      let bestRecovery = recoverySequences.length ? -Infinity : 0;
      let bestRecoveryState = recoveryState;
      for (const { sequence, after: recoveryAfter } of recoverySequences) {
        const sequenceValue = scoreSequence(
          recoveryState,
          recoveryAfter,
          color,
          sequence,
          weights,
        );
        const residualFenceRisk = fenceClosureRisk(recoveryAfter, color)
          + opponentTrapRisk(recoveryAfter, color);
        const recoveryValue = sequenceValue - residualFenceRisk * weights.trapRisk * 0.16;
        if (recoveryValue > bestRecovery) {
          bestRecovery = recoveryValue;
          bestRecoveryState = recoveryAfter;
        }
      }
      if (!Number.isFinite(bestRecovery)) bestRecovery = 0;
      expectedRecovery += bestRecovery * roll.weight;
      recoveryWeight += roll.weight;
      worstRecovery = Math.min(worstRecovery, bestRecovery);
      recoveryRolls += 1;
      recoveryFrontiers.push({
        value: bestRecovery,
        state: bestRecoveryState,
        weight: roll.weight,
        diceKey: roll.dice.join(':'),
      });
    }

    if (!hasCompleteDiceDistribution(recoveryRolls, recoveryWeight)) continue;
    const recoveryExpected = expectedRecovery / recoveryWeight;
    const recoveryTailRisk = weightedLowerTailMean(recoveryFrontiers);
    const deepAdjustment = recoveryExpected * 0.18
      + Math.min(0, recoveryTailRisk) * 0.08;
    accumulator.candidate.score += deepAdjustment;
    Object.assign(accumulator.candidate.tactical, {
      recoveryExpected,
      recoveryWorst: Number.isFinite(worstRecovery) ? worstRecovery : 0,
      recoveryTailRisk,
      recoveryTailWeight: DICE_TAIL_WEIGHT,
      recoveryRolls,
      recoveryWeight,
      recoveryDistributionComplete: true,
      // Dice-complete recovery is conditional on ONE worst-immediate primary
      // scenario, not a complete nested primary x recovery dice tree. Different
      // candidates can select different scenarios; impacts are estimates, not
      // an independent cross-candidate safety proof.
      recoveryModelKind: 'conditional-single-primary-v1',
      recoveryConditional: true,
      recoveryPrimaryDiceKey: frontier.diceKey,
      recoveryPrimaryDiceWeight: frontier.weight,
      recoveryPrimaryFrontierCount: 1,
      recoveryTotalPrimaryFrontierCount: CANONICAL_DICE_OUTCOMES.length,
      recoveryPrimaryFrontierWeight: frontier.weight,
      recoveryTotalPrimaryFrontierWeight: CANONICAL_DICE_WEIGHT,
      deepAdjustment,
      plies: 3,
    });
    // Keep the real dice mass of every distinct recovery board. The bounded
    // continuation model samples only representative/worst boards; proxy
    // quadrature weights used for ranking must not be reported as coverage.
    accumulator.recoveryFrontierCoverage = new Map();
    recoveryFrontiers.forEach((frontier) => {
      const key = positionKey(frontier.state);
      const current = accumulator.recoveryFrontierCoverage.get(key);
      accumulator.recoveryFrontierCoverage.set(key, {
        weight: Number(current?.weight || 0) + Number(frontier.weight || 0),
      });
    });
    accumulator.recoveryFrontiers = recoveryFrontiers
      .sort((left, right) => left.value - right.value)
      .slice(0, 2);
    accumulator.continuationFrontier = recoveryFrontiers.reduce((closest, item) => (
      !closest
      || Math.abs(item.value - recoveryExpected) < Math.abs(closest.value - recoveryExpected)
        ? item
        : closest
    ), null);
  }

  analyzeContinuationReplies(
    adapter,
    color,
    deepCandidates,
    weights,
    budget,
    expandDoubles,
  );
}

export function selectDeepCandidates(rankedCandidates) {
  const selected = [];
  const included = new Set();
  const append = (accumulator) => {
    if (!accumulator || included.has(accumulator)) return;
    included.add(accumulator);
    selected.push(accumulator);
  };
  [...rankedCandidates]
    .filter(accumulator => hasTacticalReservation(accumulator.candidate))
    .sort((left, right) => (
      tacticalReservationPriority(left.candidate)
        - tacticalReservationPriority(right.candidate)
      || Number(right.candidate.score) - Number(left.candidate.score)
    ))
    .forEach(append);
  const scoreLeaders = rankedCandidates.slice(0, MAX_DEEP_CANDIDATES);
  const safest = [...rankedCandidates].sort((left, right) => (
    Number(right.candidate.tactical?.worstImpact || 0)
      - Number(left.candidate.tactical?.worstImpact || 0)
  ))[0];
  const leaderWorst = Math.max(...scoreLeaders.map(accumulator => (
    Number(accumulator.candidate.tactical?.worstImpact || 0)
  )));
  if (
    safest
    && Number(safest.candidate.tactical?.worstImpact || 0) >= leaderWorst + 30000000
  ) {
    append(safest);
  }
  scoreLeaders.forEach(append);
  return selected.slice(0, MAX_TACTICAL_CANDIDATES);
}

function tacticalReservationPriority(candidate) {
  const features = candidate?.features || {};
  if (Number(features.structuralIntegrityTacticalReservation || 0) > 0) return 0;
  if (Number(features.homeEntryTacticalReservation || 0) > 0) return 1;
  if (Number(features.primeSustainabilityTacticalReservation || 0) > 0) return 1.5;
  if (Number(features.routeContinuityTacticalReservation || 0) > 0) return 2;
  if (Number(features.fenceEscapeTacticalReservation || 0) > 0) return 3;
  if (Number(features.contestedHeadExitTacticalReservation || 0) > 0) return 4;
  return 100;
}

function hasTacticalReservation(candidate) {
  const features = candidate?.features || {};
  return Number(features.structuralIntegrityTacticalReservation || 0) > 0
    || Number(features.homeEntryTacticalReservation || 0) > 0
    || Number(features.routeContinuityTacticalReservation || 0) > 0
    || Number(features.fenceEscapeTacticalReservation || 0) > 0
    || Number(features.contestedHeadExitTacticalReservation || 0) > 0
    || Number(features.primeSustainabilityTacticalReservation || 0) > 0;
}

function completeProvisionalLeaderAnalysis(
  adapter,
  color,
  accumulators,
  weights,
  budget,
  expandDoubles,
) {
  // Deep adjustments can demote the initial top-two and expose a candidate
  // with only primary analysis. Follow that provisional leader until the move
  // which can actually win the ranking has the same bounded four-ply model.
  for (let pass = 0; pass < accumulators.length; pass += 1) {
    const leader = accumulators
      .filter(accumulator => accumulator.candidate.tactical)
      .sort((left, right) => right.candidate.score - left.candidate.score)[0];
    if (!leader || Number(leader.candidate.tactical.plies || 0) >= 4) return;

    const usedBefore = Number(budget?.used) || 0;
    if (Number(leader.candidate.tactical.plies || 0) >= 3) {
      analyzeContinuationReplies(
        adapter,
        color,
        [leader],
        weights,
        budget,
        expandDoubles,
      );
    } else {
      analyzeRecoveryReplies(
        adapter,
        color,
        [leader],
        weights,
        budget,
        expandDoubles,
      );
    }
    if ((Number(budget?.used) || 0) === usedBefore) return;
  }
}

function analyzeContinuationReplies(
  adapter,
  color,
  deepCandidates,
  weights,
  budget,
  expandDoubles,
) {
  const opponent = opponentOf(color);
  const continuationCandidates = selectContinuationCandidates(deepCandidates);

  for (const accumulator of continuationCandidates) {
    if (!hasAnalysisBudget(budget)) break;
    const representativeFrontier = accumulator.continuationFrontier;
    const worstFrontier = accumulator.recoveryFrontiers?.[0];
    if (!representativeFrontier || !worstFrontier) continue;
    const worstRecoveryWeight = Math.max(
      1,
      Math.min(CANONICAL_DICE_WEIGHT, Number(worstFrontier.weight) || 1),
    );
    const continuationFrontiers = uniqueContinuationFrontiers([
      {
        ...representativeFrontier,
        kind: 'representative',
        proxyWeight: CANONICAL_DICE_WEIGHT - worstRecoveryWeight,
      },
      { ...worstFrontier, kind: 'worst', proxyWeight: worstRecoveryWeight },
    ]);
    const frontierWeight = continuationFrontiers.reduce((sum, frontier) => (
      sum + Number(accumulator.recoveryFrontierCoverage?.get(positionKey(frontier.state))?.weight || 0)
    ), 0);
    const totalFrontierCount = Number(accumulator.recoveryFrontierCoverage?.size) || 0;
    const approximate = frontierWeight !== CANONICAL_DICE_WEIGHT
      || continuationFrontiers.length !== totalFrontierCount;
    let expectedImpact = 0;
    let impactWeight = 0;
    let worstImpact = 0;
    let rolls = 0;
    const impactOutcomes = [];
    let coverageComplete = true;

    for (const roll of CANONICAL_DICE_OUTCOMES) {
      const frontierImpacts = [];
      for (const frontier of continuationFrontiers) {
        if (!consumeAnalysisNode(budget)) {
          coverageComplete = false;
          break;
        }
        const replyState = prepareReplyState(
          frontier.state,
          opponent,
          roll.dice,
          expandDoubles,
        );
        const beforeValue = evaluateState(replyState, color, weights);
        const legalReplies = adapter.legalSequences(replyState, opponent, {
          limit: expandDoubles ? 4 : 0,
        });
        const replies = sampledSequenceResults(
          adapter,
          replyState,
          opponent,
          legalReplies,
          MAX_CONTINUATION_SEQUENCES,
        );
        let worstValue = beforeValue;
        for (const { sequence: reply, after: replyAfter } of replies) {
          const opponentGain = scoreSequence(replyState, replyAfter, opponent, reply, weights);
          const ownValue = evaluateState(replyAfter, color, weights);
          worstValue = Math.min(worstValue, ownValue - Math.max(0, opponentGain) * 0.1);
        }
        const impact = worstValue - beforeValue;
        frontierImpacts.push(impact);
        worstImpact = Math.min(worstImpact, impact);
      }
      if (!coverageComplete || frontierImpacts.length !== continuationFrontiers.length) break;
      const frontierProxyWeight = continuationFrontiers.reduce((sum, frontier) => (
        sum + Number(frontier.proxyWeight || 0)
      ), 0);
      const impact = frontierImpacts.reduce((sum, value, index) => (
        sum + value * Number(continuationFrontiers[index].proxyWeight || 0)
      ), 0) / frontierProxyWeight;
      expectedImpact += impact * roll.weight;
      impactWeight += roll.weight;
      rolls += 1;
      impactOutcomes.push({ value: impact, weight: roll.weight });
    }

    if (!coverageComplete || !hasCompleteDiceDistribution(rolls, impactWeight)) continue;
    const continuationExpected = expectedImpact / impactWeight;
    const continuationTailRisk = weightedLowerTailMean(impactOutcomes);
    const continuationAdjustment = continuationExpected * 0.24
      + continuationTailRisk * 0.1 * threatPressure(representativeFrontier.state, color);
    accumulator.candidate.score += continuationAdjustment;
    Object.assign(accumulator.candidate.tactical, {
      continuationExpected,
      continuationWorst: worstImpact,
      continuationTailRisk,
      continuationTailWeight: DICE_TAIL_WEIGHT,
      continuationRolls: rolls,
      continuationWeight: impactWeight,
      continuationDistributionComplete: true,
      continuationModelComplete: true,
      continuationModelKind: 'representative-worst-proxy-v1',
      continuationApproximate: approximate,
      continuationCoverageComplete: !approximate,
      continuationFrontierCount: continuationFrontiers.length,
      continuationFrontierWeight: frontierWeight,
      continuationTotalFrontierCount: totalFrontierCount,
      continuationTotalFrontierWeight: CANONICAL_DICE_WEIGHT,
      continuationProxyWeight: continuationFrontiers.reduce((sum, frontier) => (
        sum + Number(frontier.proxyWeight || 0)
      ), 0),
      continuationWorstRecoveryFrontierWeight: worstRecoveryWeight,
      // Record the original role provenance before board deduplication. If
      // representative and worst collapse to one board, their proxy weights
      // still sum to 36; neither proxy weight is actual sampled dice mass.
      continuationRepresentativeDiceKey: representativeFrontier.diceKey,
      continuationRepresentativeDiceWeight: representativeFrontier.weight,
      continuationRepresentativeProxyWeight: CANONICAL_DICE_WEIGHT - worstRecoveryWeight,
      continuationWorstRecoveryDiceKey: worstFrontier.diceKey,
      continuationWorstRecoveryDiceWeight: worstFrontier.weight,
      continuationWorstRecoveryProxyWeight: worstRecoveryWeight,
      continuationRepresentativeFrontierIncluded: continuationFrontiers.some(
        frontier => frontier.kind === 'representative' || frontier.kind === 'representative+worst',
      ),
      continuationWorstFrontierIncluded: continuationFrontiers.some(
        frontier => frontier.kind === 'worst' || frontier.kind === 'representative+worst',
      ),
      continuationAdjustment,
      plies: 4,
    });
  }
}

function uniqueContinuationFrontiers(frontiers) {
  const byPosition = new Map();
  for (const frontier of frontiers) {
    if (!frontier?.state) continue;
    const key = positionKey(frontier.state);
    const current = byPosition.get(key);
    if (!current) {
      byPosition.set(key, frontier);
      continue;
    }
    current.proxyWeight = Number(current.proxyWeight || 0)
      + Number(frontier.proxyWeight || 0);
    if (current.kind !== frontier.kind) current.kind = 'representative+worst';
  }
  return [...byPosition.values()];
}

export function selectContinuationCandidates(deepCandidates) {
  const selected = selectDeepCandidates(deepCandidates
    .filter(accumulator => (
      accumulator.recoveryFrontiers?.length
      && Number(accumulator.candidate.tactical?.plies || 0) < 4
    ))
    .sort((left, right) => right.candidate.score - left.candidate.score));
  const reserved = selected.filter(accumulator => (
    hasTacticalReservation(accumulator.candidate)
  ));
  const ordinary = selected.filter(accumulator => (
    !hasTacticalReservation(accumulator.candidate)
  ));
  // Tactical reservations are explicit promises that a structurally important
  // move will receive the same four-ply evidence as the score leaders. Apply
  // the ordinary continuation cap only after every reserved board is kept.
  return [
    ...reserved,
    ...ordinary.slice(0, MAX_CONTINUATION_CANDIDATES),
  ];
}

function threatPressure(state, color) {
  const opponent = opponentOf(color);
  const raceLead = Math.max(0, pipsFor(state, opponent) - pipsFor(state, color));
  return Math.min(3.4, 1
    + Math.min(1.2, raceLead / 42)
    + offCount(state, opponent) * 0.12
    + (homeReady(state, opponent) ? 0.75 : 0));
}

export function experienceDescriptor(
  state,
  color,
  features,
  tactical = null,
) {
  const opponent = opponentOf(color);
  const ownHead = headCheckers(state, color);
  const outside = outsideHomeCount(state, color);
  const opponentOff = offCount(state, opponent);
  const ownOff = offCount(state, color);
  const startZone = Number(features.startZoneBefore) || 0;
  const trap = opponentTrapRisk(state, color);
  const pipDelta = pipsFor(state, color) - pipsFor(state, opponent);
  const homeShuffleMoves = Math.max(0, Number(features.homeShuffleMoves) || 0);
  const hasAvoidableHomeShuffle = Object.prototype.hasOwnProperty.call(
    features || {},
    'avoidableHomeShuffleMoves',
  );
  const avoidableHomeShuffleMoves = hasAvoidableHomeShuffle
    ? Math.max(0, Number(features.avoidableHomeShuffleMoves) || 0)
    : 0;
  const homeShuffleAction = avoidableHomeShuffleMoves > 0
    ? 'home:shuffle'
    : homeShuffleMoves > 0
      ? hasAvoidableHomeShuffle ? 'home:forced' : 'home:unknown'
      : 'home:steady';
  const prospectiveFenceAction = Number(features.prospectiveFenceInterruptionBreak || 0) > 0
    ? 'prospective-fence:break'
    : signedFlag('prospective-fence', features.prospectiveFenceExtensionDelta);
  const prospectiveFenceBehavior = Number(
    features.avoidableProspectiveFenceAnchorMiss || 0,
  ) > 0
    ? 'prospective-fence:avoidable-anchor-miss'
    : Number(features.avoidableProspectiveFenceInterruptionBreak || 0) > 0
      ? 'prospective-fence:avoidable-break'
      : Number(features.prospectiveFenceInterruptionBreak || 0) > 0
        ? 'prospective-fence:necessary-break'
        : signedFlag('prospective-fence', features.prospectiveFenceExtensionDelta);
  const phase = homeReady(state, color)
    ? 'bearoff'
    : opponentOff > 0 && ownOff === 0
      ? 'koks-rescue'
      : outside <= 4
        ? 'late-entry'
        : ownHead > 0
          ? 'head-development'
          : 'route';
  const contextKey = [
    phase,
    bucket('h', ownHead, [0, 1, 3, 7]),
    bucket('o', outside, [0, 2, 5, 9]),
    bucket('po', opponentOff, [0, 1, 5, 10]),
    bucket('sz', startZone, [0, 1, 3, 6]),
    bucket('tr', trap, [0, 40, 180, 600]),
    bucket('pd', pipDelta, [-36, -8, 9, 37]),
  ].join('|');

  const legacyActionKey = [
    signedFlag('head', features.headGain),
    signedFlag('entry', features.outsideReduction),
    signedFlag('trap', features.trapDelta),
    prospectiveFenceAction,
    signedFlag('freedom', features.opponentHeadFreedomDelta),
    signedFlag('distribution', features.distributionDelta),
    Number(features.headLandingBreak || 0) > 0 ? 'support:break' : 'support:keep',
    homeShuffleAction,
    Number(features.bearOffMoves || 0) > 0 ? 'off:yes' : 'off:no',
  ].join('|');
  const familyActionKey = `${legacyActionKey}|${signedFlag('tower', features.routeTowerDelta)}`;
  const hasAdvancedStrategy = Number.isFinite(Number(features.primeScoreGain));
  const strategicActionKey = hasAdvancedStrategy
    ? [
      familyActionKey,
      signedFlag('prime', features.primeScoreGain),
      signedFlag('block', features.opponentMoveBlockGain),
      `prime-run:${Math.max(0, Number(features.primeRunAfter) || 0)}`,
    ].join('|')
    : familyActionKey;
  const rescueAction = Number(features.missedKoksRescue || 0) > 0
    ? 'koks:miss'
    : Number(features.startZoneReduction || 0) > 0
      ? 'koks:gain'
      : 'koks:flat';
  const actionKey = `${strategicActionKey}|${rescueAction}|route:${features.routeSignature || 'none'}`;
  // These compact keys preserve the strategic intent that must transfer across
  // different dice and route signatures. The exact/family keys still provide
  // precision, while these keys let repeated home-shuffle and fence mistakes
  // teach the next materially similar position.
  const behaviorActionKeys = [
    [
      signedFlag('entry', features.outsideReduction),
      signedFlag('progress', features.outsidePipGain),
      homeShuffleAction,
      signedFlag('tower', features.routeTowerDelta),
      signedFlag('prime', features.primeScoreGain),
      `prime-run:${Math.max(0, Number(features.primeRunAfter) || 0)}`,
      Number(features.bearOffMoves || 0) > 0 ? 'off:yes' : 'off:no',
    ].join('|'),
    [
      signedFlag('trap', features.trapDelta),
      signedFlag('fence', features.fenceClosureDelta),
      signedFlag('gateway', features.escapeGatewayDelta),
      signedFlag('block', features.opponentMoveBlockGain),
      signedFlag('latent', features.latentFenceExposureDelta),
    ].join('|'),
    // Keep the established v33 aliases at indexes 0..2.  The server-side
    // aggregate and frozen sessions already treat index 2 as prospective-fence
    // evidence, so new compatible aliases must only be appended.
    prospectiveFenceBehavior,
    [
      signedFlag('prime-timing', features.primeSustainabilityDelta),
      signedFlag('self-crunch', features.primeCrunchRiskDelta),
      `prime-run:${Math.max(0, Number(features.primeRunAfter) || 0)}`,
    ].join('|'),
  ];

  const urgency = 1
    + opponentOff * 0.12
    + (homeReady(state, opponent) ? 0.65 : 0)
    + (phase === 'koks-rescue' ? 0.8 : 0);
  let mistakeSeverity = 0;
  mistakeSeverity += Math.min(3, Math.max(0, Number(features.headLandingBreak) || 0)) * 0.9;
  mistakeSeverity += Math.max(0, -(Number(features.opponentHeadFreedomDelta) || 0)) * 0.14;
  mistakeSeverity += Math.max(0, -(Number(features.fenceClosureDelta) || 0)) * 0.18;
  mistakeSeverity += Math.min(
    4,
    Math.max(0, Number(features.avoidableProspectiveFenceInterruptionBreak) || 0) / 24,
  );
  mistakeSeverity += Math.min(
    4,
    Math.max(0, Number(features.avoidableProspectiveFenceAnchorMiss) || 0) / 12,
  );
  mistakeSeverity += Math.min(3.2, Math.max(0, -(Number(features.routeTowerDelta) || 0)) / 180);
  mistakeSeverity += Math.min(3.4, Math.max(0, -(Number(features.primeScoreGain) || 0)) / 900);
  mistakeSeverity += Math.min(2.8, Math.max(0, -(Number(features.opponentMoveBlockGain) || 0)) / 80);
  mistakeSeverity += Math.min(
    4,
    Math.max(0, -(Number(features.latentFenceExposureDelta) || 0)),
  );
  mistakeSeverity += Math.min(
    4.5,
    Math.max(0, -(Number(features.primeCrunchRiskDelta) || 0)) * 1.7,
  );
  if (
    Number(features.primeRunAfter || 0) >= 4
    && Number(features.primeSustainabilityAfter || 0) < 0.32
  ) {
    mistakeSeverity += (0.32 - Number(features.primeSustainabilityAfter || 0)) * 5;
  }
  if (
    Number(features.primeRunBefore || 0) >= 4
    && Number(features.primeRunAfter || 0) < Number(features.primeRunBefore || 0)
  ) {
    mistakeSeverity += 1.4
      + (Number(features.primeRunBefore) - Number(features.primeRunAfter)) * 0.55;
  }
  if (Number(features.trapBefore || 0) > 0 && Number(features.trapDelta || 0) <= 0) {
    mistakeSeverity += Math.min(2.4, Number(features.trapBefore) / 180);
  }
  const outsideAfterMove = Math.max(0, outside - Number(features.outsideReduction || 0));
  const completedEntryWithAvoidableShuffle = phase === 'late-entry'
    && outsideAfterMove === 0
    && avoidableHomeShuffleMoves > 0;
  if (
    avoidableHomeShuffleMoves > 0
    && (outsideAfterMove > 0 || completedEntryWithAvoidableShuffle)
  ) {
    const baseShuffleSeverity = Number(features.outsideReduction || 0) > 0 ? 0.75 : 1.15;
    // Entering the final checker does not excuse spending the other die on a
    // safely avoidable home shuffle. In 8RMS that hid a legal bear-off from
    // outcome credit and let a win reinforce the objectively weaker move.
    mistakeSeverity += baseShuffleSeverity
      + (completedEntryWithAvoidableShuffle ? 0.55 : Math.min(1.2, outsideAfterMove / 8));
  }
  if (ownHead > 0 && Number(features.headGain || 0) <= 0 && (ownHead <= 2 || opponentOff > 0)) {
    mistakeSeverity += 1.4;
  }
  if (phase === 'koks-rescue' && Number(features.missedKoksRescue || 0) > 0) {
    mistakeSeverity += Math.min(
      4,
      Number(features.missedKoksRescue) * (1.2 + opponentOff * 0.12),
    );
  }
  if (tactical && Number(tactical.worstImpact) < -4000000) {
    mistakeSeverity += Math.min(2.2, Math.abs(Number(tactical.worstImpact)) / 16000000);
  }

  const structuralRisk = Math.max(
    Math.max(0, -(Number(features.routeTowerDelta) || 0)) / 90,
    Number(features.maxRouteTowerAfter || 0) >= 6
      ? (Number(features.maxRouteTowerAfter) - 5) * 0.85
      : 0,
    Number(features.trapBefore || 0) >= 600 && Number(features.trapDelta || 0) <= 0
      ? Math.min(4, Number(features.trapBefore) / 900)
      : 0,
    Number(features.escapeGatewayDelta || 0) < 0 && Number(features.trapBefore || 0) >= 180
      ? Math.min(3, Math.abs(Number(features.escapeGatewayDelta)) / 3)
      : 0,
    Math.min(6, Math.max(0, -(Number(features.latentFenceExposureDelta) || 0))),
    Math.min(
      6,
      Math.max(0, Number(features.avoidableProspectiveFenceInterruptionBreak) || 0) / 18,
    ),
    Math.min(
      6,
      Math.max(0, Number(features.avoidableProspectiveFenceAnchorMiss) || 0) / 12,
    ),
    Math.min(6, Math.max(0, -(Number(features.primeCrunchRiskDelta) || 0)) * 1.8),
    Number(features.primeRunAfter || 0) >= 4
      ? Math.max(0, 0.35 - Number(features.primeSustainabilityAfter || 0)) * 8
      : 0,
    avoidableHomeShuffleMoves > 0
      && (outsideAfterMove > 0 || completedEntryWithAvoidableShuffle)
      ? 1.1 + Math.min(2.2, Math.max(1, outsideAfterMove) / 5)
      : 0,
    Number(features.primeRunBefore || 0) >= 4
      && Number(features.primeRunAfter || 0) < Number(features.primeRunBefore || 0)
      ? 2 + Number(features.primeRunBefore) - Number(features.primeRunAfter)
      : 0,
  );
  const tacticalRisk = tactical
    ? Math.min(6, Math.abs(Math.min(0, Number(tactical.worstImpact) || 0)) / 12000000)
    : 0;
  const riskSignal = Math.min(10, Math.max(mistakeSeverity * urgency, structuralRisk, tacticalRisk));

  return {
    contextKey,
    actionKey,
    strategicActionKey,
    familyActionKey,
    legacyActionKey,
    behaviorActionKeys,
    mistakeSeverity: Math.min(8, mistakeSeverity * urgency),
    riskSignal,
    phase,
  };
}

export function normalizeExperiencePatterns(patterns = []) {
  const contributions = new Map();
  const normalized = new Map();
  (Array.isArray(patterns) ? patterns : []).forEach((pattern) => {
    const contextKey = String(pattern?.contextKey || pattern?.context_key || '');
    const actionKey = String(pattern?.actionKey || pattern?.action_key || '');
    if (!contextKey || !actionKey) return;
    const key = `${contextKey}::${actionKey}`;
    const contribution = {
      contextKey,
      actionKey,
      // Server causal evidence was generated for one exact descriptor. Unlike
      // legacy observations it has no validated cross-context/action credit.
      exactOnly: pattern?.creditVersion === 9
        && pattern?.evidenceSchema === 'long-server-causal-pattern-v1',
      samples: Math.max(0, Number(pattern.samples) || 0),
      losses: Math.max(0, Number(pattern.losses) || 0),
      wins: Math.max(0, Number(pattern.wins) || 0),
      lossWeight: Math.max(
        0,
        Number(pattern.lossWeight ?? pattern.loss_weight ?? pattern.losses) || 0,
      ),
      severeLosses: Math.max(
        0,
        Number(pattern.severeLosses ?? pattern.severe_losses) || 0,
      ),
      signalWeight: Math.max(
        0,
        Number(pattern.signalWeight ?? pattern.signal_weight) || 0,
      ),
      winWeight: Math.max(
        0,
        Number(pattern.winWeight ?? pattern.win_weight) || 0,
      ),
    };
    // Exact duplicates are correlated snapshots, not independent games. Keep
    // the strongest one instead of multiplying its evidence by array order.
    // Source precedence is resolved by the engine before normalization.
    const current = contributions.get(key);
    const evidenceRank = item => [
      item.samples,
      item.losses + item.wins,
      item.lossWeight + item.winWeight,
      item.signalWeight,
      item.severeLosses,
    ];
    const candidateRank = evidenceRank(contribution);
    const currentRank = evidenceRank(current || {});
    const firstDifference = candidateRank.findIndex(
      (value, index) => value !== currentRank[index],
    );
    const isStronger = !current
      || (firstDifference >= 0 && candidateRank[firstDifference] > currentRank[firstDifference]);
    if (isStronger) contributions.set(key, contribution);
  });

  contributions.forEach((contribution, key) => {
    const { contextKey, actionKey } = contribution;
    mergePattern(normalized, key, contribution, contextKey, actionKey);
    if (contribution.exactOnly) return;

    const phase = contextKey.split('|')[0] || 'route';
    const strategic = strategicContextKey(contextKey);
    mergePattern(normalized, `strategy:${strategic}::${actionKey}`, contribution, strategic, actionKey);
    mergePattern(normalized, `phase:${phase}::${actionKey}`, contribution, phase, actionKey);
    mergePattern(normalized, `*::${actionKey}`, contribution, '*', actionKey);
  });
  return normalized;
}

export function experienceAdjustment(descriptor, experience) {
  if (!descriptor || !(experience instanceof Map)) return 0;
  const phase = descriptor.phase || String(descriptor.contextKey || '').split('|')[0] || 'route';
  const strategic = strategicContextKey(descriptor.contextKey);
  const behaviorActionKeys = Array.isArray(descriptor.behaviorActionKeys)
    ? descriptor.behaviorActionKeys.filter(Boolean)
    : [];
  const hasStrategicAction = descriptor.strategicActionKey
    && descriptor.strategicActionKey !== descriptor.familyActionKey;
  const actionKeys = (hasStrategicAction
    ? [
      descriptor.actionKey,
      descriptor.strategicActionKey,
      descriptor.familyActionKey,
      ...behaviorActionKeys,
      descriptor.legacyActionKey,
    ]
    : [
      descriptor.actionKey,
      descriptor.familyActionKey,
      ...behaviorActionKeys,
      descriptor.legacyActionKey,
    ]
  ).filter(Boolean);

  const contextLevels = [
    { key: descriptor.contextKey, minimum: 3, weight: 1 },
    { key: `strategy:${strategic}`, minimum: 5, weight: 0.78 },
    { key: `phase:${phase}`, minimum: 8, weight: 0.52 },
    { key: '*', minimum: 16, weight: 0.28 },
  ];
  const actionWeights = hasStrategicAction
    ? [1, 0.86, 0.68, ...(behaviorActionKeys.map(() => 0.58)), 0.5]
    : [1, 0.76, ...(behaviorActionKeys.map(() => 0.62)), 0.56];
  const matches = [];
  for (const level of contextLevels) {
    for (let index = 0; index < actionKeys.length; index += 1) {
      const actionKey = actionKeys[index];
      const pattern = experience.get(`${level.key}::${actionKey}`);
      if (!pattern) continue;
      // Merely omitting generalized map entries is insufficient: a different
      // action can still carry this key as a family/behavior/legacy alias.
      if (pattern.exactOnly === true && (
        level.key !== descriptor.contextKey || actionKey !== descriptor.actionKey
      )) continue;
      const severeEvidence = pattern.severeLosses >= 2 && pattern.lossWeight >= 4;
      const winningEvidence = pattern.wins >= 3 && pattern.winWeight >= 3;
      if (pattern.samples < level.minimum && !severeEvidence && !winningEvidence) continue;
      matches.push({
        pattern,
        weight: level.weight * (actionWeights[index] || 0.4),
      });
    }
  }
  if (!matches.length) return 0;

  // Exact, strategic, family, behavior and legacy keys describe the same
  // decision, so never add their adjustments as if they were independent
  // games. Evaluate each representation on its own, then arbitrate between
  // the resulting signals. A risky move must not be rewarded merely because
  // a neutral exact alias happened to be checked before a repeatedly harmful
  // transferable behavior alias.
  const adjustments = matches.map(match => adjustmentForExperienceMatch(descriptor, match));
  const descriptorRisk = Math.max(
    Number(descriptor.riskSignal) || 0,
    Number(descriptor.mistakeSeverity) || 0,
  );
  if (descriptorRisk >= EXPERIENCE_RISK_THRESHOLD) {
    const penalties = adjustments.filter(adjustment => adjustment < 0);
    if (penalties.length) return Math.min(...penalties);
  }

  // The iteration order is intentionally exact-to-general. When the signals
  // are compatible (or no safety penalty exists), retain the most-specific
  // qualifying evidence instead of letting a broad alias overpower it.
  return adjustments[0];
}

function adjustmentForExperienceMatch(descriptor, match) {
  const { pattern, weight } = match;
  const matchConfidence = Math.min(0.92, pattern.samples / (pattern.samples + 7));
  const evidenceWeight = weight * matchConfidence;
  if (!evidenceWeight) return 0;
  // Frequency and severity are different signals. Treating severity-weighted
  // lossWeight as a loss count used to penalize actions that won most games.
  const lossRate = Math.min(0.98, (pattern.losses + 0.5) / (pattern.samples + 1.5));
  const lossSeverity = pattern.losses > 0
    ? Math.max(1, pattern.lossWeight / pattern.losses)
    : 1;
  const severeRate = pattern.severeLosses / Math.max(1, pattern.samples);
  const learnedSeverity = Math.min(5, pattern.signalWeight / Math.max(1, pattern.losses));
  const weightedSamples = pattern.samples * weight;
  const winRate = pattern.wins / Math.max(1, pattern.samples);
  const winQuality = pattern.winWeight / Math.max(1, pattern.wins);
  const confidence = Math.min(0.9, weightedSamples / (weightedSamples + 9));
  const relevance = 1.35 + Math.min(3.2, Math.max(
    Number(descriptor.riskSignal) || 0,
    Number(descriptor.mistakeSeverity) || 0,
  ));
  if (lossRate >= 0.42) {
    const penalty = (
      18000000
      * confidence
      * (lossRate - 0.28)
      * (1 + severeRate * 1.5)
      * (1 + Math.max(0, lossSeverity - 1) * 0.24)
      * (1 + learnedSeverity * 0.2)
      * relevance
    );
    return -Math.min(MAX_EXPERIENCE_PENALTY, penalty);
  }
  if (weightedSamples >= 5 && lossRate <= 0.24 && severeRate <= 0.08 && winRate >= 0.55) {
    const reward = 9000000
      * confidence
      * (0.35 + winRate)
      * Math.min(1.8, relevance)
      * Math.min(1.5, 0.7 + winQuality * 0.3);
    return Math.min(MAX_EXPERIENCE_REWARD, reward);
  }
  return 0;
}

function mergePattern(target, key, pattern, contextKey, actionKey) {
  const current = target.get(key) || {
    contextKey,
    actionKey,
    samples: 0,
    losses: 0,
    wins: 0,
    lossWeight: 0,
    severeLosses: 0,
    signalWeight: 0,
    winWeight: 0,
  };
  current.samples += pattern.samples;
  current.losses += pattern.losses;
  current.wins += pattern.wins;
  current.lossWeight += pattern.lossWeight;
  current.severeLosses += pattern.severeLosses;
  current.signalWeight += pattern.signalWeight;
  current.winWeight += pattern.winWeight;
  if (pattern.exactOnly === true) current.exactOnly = true;
  target.set(key, current);
}

function strategicContextKey(contextKey) {
  const parts = String(contextKey || '').split('|').filter(Boolean);
  const phase = parts[0] || 'route';
  const dimensions = ['o', 'po', 'tr']
    .map(prefix => parts.find(part => part.startsWith(prefix)))
    .filter(Boolean);
  return [phase, ...dimensions].join('|');
}

function prepareReplyState(state, color, dice, expandDoubles = false) {
  const resolvedDice = expandDoubles && dice.length === 2 && dice[0] === dice[1]
    ? [dice[0], dice[0], dice[0], dice[0]]
    : [...dice];
  return {
    ...state,
    turn: color,
    phase: 'move',
    dice: resolvedDice,
    rolled: [...resolvedDice],
    turnMoves: [],
    headPlayedThisTurn: {
      ...(state.headPlayedThisTurn || {}),
      [color]: false,
    },
  };
}

function sampledSequenceResults(adapter, state, color, sequences, limit, options = {}) {
  const legal = (Array.isArray(sequences) ? sequences : []).filter(sequence => sequence?.length);
  if (!legal.length) return [];
  const normalizedLimit = Math.max(1, Number(limit) || 1);
  const preferredIndexes = [];
  const queuedIndexes = new Set();
  const queue = (index) => {
    if (index < 0 || index >= legal.length || queuedIndexes.has(index)) return;
    queuedIndexes.add(index);
    preferredIndexes.push(index);
  };
  if (options.preferLeading) {
    for (let index = 0; index < normalizedLimit; index += 1) queue(index);
  } else {
    const bestBearOffIndex = legal.reduce((bestIndex, sequence, index) => {
      const offMoves = sequence.filter(move => move.bearOff || move.to === 0).length;
      const bestOffMoves = legal[bestIndex]
        .filter(move => move.bearOff || move.to === 0).length;
      return offMoves > bestOffMoves ? index : bestIndex;
    }, 0);
    if (legal[bestBearOffIndex].some(move => move.bearOff || move.to === 0)) {
      queue(bestBearOffIndex);
    }
    for (let index = 0; index < normalizedLimit; index += 1) {
      queue(Math.round(index * (legal.length - 1) / Math.max(1, normalizedLimit - 1)));
    }
  }
  // Uniform probes retain the old sampling bias. The ordered fallback only
  // fills holes when those probes are equivalent move orders.
  for (let index = 0; index < legal.length; index += 1) queue(index);

  const sampled = [];
  const seenPositions = new Set();
  for (const index of preferredIndexes) {
    if (sampled.length >= normalizedLimit) break;
    const sequence = legal[index];
    const after = adapter.applySequence(state, sequence, color);
    const key = positionKey(after);
    if (seenPositions.has(key)) continue;
    seenPositions.add(key);
    sampled.push({ sequence, after });
  }
  return sampled;
}

function bucket(prefix, value, thresholds) {
  const number = Number(value) || 0;
  const index = thresholds.findIndex(threshold => number <= threshold);
  return `${prefix}${index < 0 ? thresholds.length : index}`;
}

function signedFlag(name, value) {
  const number = Number(value) || 0;
  return `${name}:${number > 0.001 ? 'gain' : number < -0.001 ? 'loss' : 'flat'}`;
}
