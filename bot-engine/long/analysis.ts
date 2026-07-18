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
} from './metrics.ts';

const MAX_REPLY_SEQUENCES = 8;
export const MAX_TACTICAL_CANDIDATES = 4;
const MAX_DEEP_CANDIDATES = 3;
const MAX_RECOVERY_SEQUENCES = 6;
const MAX_CONTINUATION_CANDIDATES = 2;
const MAX_CONTINUATION_SEQUENCES = 6;
const MAX_EXPERIENCE_PENALTY = 140000000;
const MAX_EXPERIENCE_REWARD = 18000000;

const TACTICAL_ROLLS = [
  { dice: [6, 5], weight: 2 },
  { dice: [6, 4], weight: 2 },
  { dice: [6, 6], weight: 1 },
  { dice: [5, 4], weight: 2 },
  { dice: [5, 5], weight: 1 },
  { dice: [4, 4], weight: 1 },
  { dice: [6, 3], weight: 2 },
  { dice: [5, 3], weight: 2 },
  { dice: [4, 3], weight: 2 },
  { dice: [3, 3], weight: 1 },
  { dice: [6, 2], weight: 2 },
  { dice: [5, 2], weight: 2 },
  { dice: [4, 2], weight: 2 },
  { dice: [3, 2], weight: 2 },
  { dice: [2, 2], weight: 1 },
  { dice: [6, 1], weight: 2 },
  { dice: [5, 1], weight: 2 },
  { dice: [4, 1], weight: 2 },
  { dice: [3, 1], weight: 2 },
  { dice: [2, 1], weight: 2 },
  { dice: [1, 1], weight: 1 },
];

const RECOVERY_ROLLS = [
  { dice: [6, 5], weight: 2 },
  { dice: [5, 3], weight: 2 },
  { dice: [4, 2], weight: 2 },
  { dice: [3, 1], weight: 2 },
  { dice: [4, 4], weight: 1 },
];

const CONTINUATION_ROLLS = [
  { dice: [6, 5], weight: 2 },
  { dice: [4, 3], weight: 2 },
  { dice: [2, 1], weight: 2 },
  { dice: [6, 6], weight: 1 },
];

export function analyzeOpponentReplies(
  adapter,
  color,
  candidates,
  weights,
  deadline,
) {
  const tacticalCandidates = uniquePositionCandidates(candidates, MAX_TACTICAL_CANDIDATES);
  if (tacticalCandidates.length < 2 || Date.now() >= deadline) return candidates;

  const opponent = opponentOf(color);
  const accumulators = tacticalCandidates.map(candidate => ({
    candidate,
    expectedImpact: 0,
    weight: 0,
    worstImpact: 0,
    rolls: 0,
    frontiers: [],
  }));

  for (const roll of TACTICAL_ROLLS) {
    if (Date.now() >= deadline) break;
    let completedRoll = true;
    const rollResults = [];

    for (const accumulator of accumulators) {
      if (Date.now() >= deadline) {
        completedRoll = false;
        break;
      }
      const replyState = prepareReplyState(accumulator.candidate.after, opponent, roll.dice);
      const replySequences = sampledSequences(
        adapter.legalSequences(replyState, opponent),
        MAX_REPLY_SEQUENCES,
      );
      const beforeValue = evaluateState(replyState, color, weights);
      let worstValue = beforeValue;
      let worstState = replyState;

      for (const reply of replySequences) {
        const replyAfter = adapter.applySequence(replyState, reply, opponent);
        const opponentGain = scoreSequence(replyState, replyAfter, opponent, reply, weights);
        const ownValue = evaluateState(replyAfter, color, weights);
        const replyValue = ownValue - Math.max(0, opponentGain) * 0.08;
        if (replyValue < worstValue) {
          worstValue = replyValue;
          worstState = replyAfter;
        }
      }
      rollResults.push({ impact: worstValue - beforeValue, state: worstState });
    }

    if (!completedRoll) break;
    rollResults.forEach((result, index) => {
      const accumulator = accumulators[index];
      const impact = result.impact;
      accumulator.expectedImpact += impact * roll.weight;
      accumulator.weight += roll.weight;
      accumulator.worstImpact = Math.min(accumulator.worstImpact, impact);
      accumulator.rolls += 1;
      accumulator.frontiers.push({ impact, state: result.state });
      accumulator.frontiers.sort((left, right) => left.impact - right.impact);
      accumulator.frontiers = accumulator.frontiers.slice(0, 2);
    });
  }

  accumulators.forEach((accumulator) => {
    if (!accumulator.weight) return;
    const expectedImpact = accumulator.expectedImpact / accumulator.weight;
    const tacticalAdjustment = expectedImpact * 0.42
      + accumulator.worstImpact * 0.14 * threatPressure(accumulator.candidate.after, color);
    accumulator.candidate.score += tacticalAdjustment;
    accumulator.candidate.tactical = {
      expectedImpact,
      worstImpact: accumulator.worstImpact,
      rolls: accumulator.rolls,
      adjustment: tacticalAdjustment,
      plies: 2,
    };
  });

  analyzeRecoveryReplies(adapter, color, accumulators, weights, deadline);

  return candidates.sort((left, right) => right.score - left.score);
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

function analyzeRecoveryReplies(adapter, color, accumulators, weights, deadline) {
  const deepCandidates = accumulators
    .filter(accumulator => accumulator.weight && accumulator.frontiers.length)
    .sort((left, right) => right.candidate.score - left.candidate.score)
    .slice(0, MAX_DEEP_CANDIDATES);

  for (const accumulator of deepCandidates) {
    if (Date.now() >= deadline) break;
    const frontier = accumulator.frontiers[0];
    let expectedRecovery = 0;
    let recoveryWeight = 0;
    let worstRecovery = Infinity;
    let recoveryRolls = 0;
    const recoveryFrontiers = [];

    for (const roll of RECOVERY_ROLLS) {
      if (Date.now() >= deadline) break;
      const recoveryState = prepareReplyState(frontier.state, color, roll.dice);
      const recoverySequences = sampledSequences(
        adapter.legalSequences(recoveryState, color),
        MAX_RECOVERY_SEQUENCES,
      );
      let bestRecovery = recoverySequences.length ? -Infinity : 0;
      let bestRecoveryState = recoveryState;
      for (const sequence of recoverySequences) {
        if (Date.now() >= deadline) break;
        const recoveryAfter = adapter.applySequence(recoveryState, sequence, color);
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
      recoveryFrontiers.push({ value: bestRecovery, state: bestRecoveryState, weight: roll.weight });
    }

    if (!recoveryWeight) continue;
    const recoveryExpected = expectedRecovery / recoveryWeight;
    const deepAdjustment = recoveryExpected * 0.18
      + Math.min(0, worstRecovery) * 0.08;
    accumulator.candidate.score += deepAdjustment;
    Object.assign(accumulator.candidate.tactical, {
      recoveryExpected,
      recoveryWorst: Number.isFinite(worstRecovery) ? worstRecovery : 0,
      recoveryRolls,
      deepAdjustment,
      plies: 3,
    });
    accumulator.recoveryFrontiers = recoveryFrontiers
      .sort((left, right) => left.value - right.value)
      .slice(0, 2);
  }

  analyzeContinuationReplies(adapter, color, deepCandidates, weights, deadline);
}

function analyzeContinuationReplies(adapter, color, deepCandidates, weights, deadline) {
  const opponent = opponentOf(color);
  const continuationCandidates = deepCandidates
    .filter(accumulator => accumulator.recoveryFrontiers?.length)
    .sort((left, right) => right.candidate.score - left.candidate.score)
    .slice(0, MAX_CONTINUATION_CANDIDATES);

  for (const accumulator of continuationCandidates) {
    if (Date.now() >= deadline) break;
    const frontier = accumulator.recoveryFrontiers[0];
    let expectedImpact = 0;
    let impactWeight = 0;
    let worstImpact = 0;
    let rolls = 0;

    for (const roll of CONTINUATION_ROLLS) {
      if (Date.now() >= deadline) break;
      const replyState = prepareReplyState(frontier.state, opponent, roll.dice);
      const beforeValue = evaluateState(replyState, color, weights);
      const replies = sampledSequences(
        adapter.legalSequences(replyState, opponent),
        MAX_CONTINUATION_SEQUENCES,
      );
      let worstValue = beforeValue;
      for (const reply of replies) {
        if (Date.now() >= deadline) break;
        const replyAfter = adapter.applySequence(replyState, reply, opponent);
        const opponentGain = scoreSequence(replyState, replyAfter, opponent, reply, weights);
        const ownValue = evaluateState(replyAfter, color, weights);
        worstValue = Math.min(worstValue, ownValue - Math.max(0, opponentGain) * 0.1);
      }
      const impact = worstValue - beforeValue;
      expectedImpact += impact * roll.weight;
      impactWeight += roll.weight;
      worstImpact = Math.min(worstImpact, impact);
      rolls += 1;
    }

    if (!impactWeight) continue;
    const continuationExpected = expectedImpact / impactWeight;
    const continuationAdjustment = continuationExpected * 0.24
      + worstImpact * 0.1 * threatPressure(frontier.state, color);
    accumulator.candidate.score += continuationAdjustment;
    Object.assign(accumulator.candidate.tactical, {
      continuationExpected,
      continuationWorst: worstImpact,
      continuationRolls: rolls,
      continuationAdjustment,
      plies: 4,
    });
  }
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
    signedFlag('freedom', features.opponentHeadFreedomDelta),
    signedFlag('distribution', features.distributionDelta),
    Number(features.headLandingBreak || 0) > 0 ? 'support:break' : 'support:keep',
    Number(features.homeShuffleMoves || 0) > 0 ? 'home:shuffle' : 'home:steady',
    Number(features.bearOffMoves || 0) > 0 ? 'off:yes' : 'off:no',
  ].join('|');
  const familyActionKey = `${legacyActionKey}|${signedFlag('tower', features.routeTowerDelta)}`;
  const rescueAction = Number(features.missedKoksRescue || 0) > 0
    ? 'koks:miss'
    : Number(features.startZoneReduction || 0) > 0
      ? 'koks:gain'
      : 'koks:flat';
  const actionKey = `${familyActionKey}|${rescueAction}|route:${features.routeSignature || 'none'}`;

  const urgency = 1
    + opponentOff * 0.12
    + (homeReady(state, opponent) ? 0.65 : 0)
    + (phase === 'koks-rescue' ? 0.8 : 0);
  let mistakeSeverity = 0;
  mistakeSeverity += Math.min(3, Math.max(0, Number(features.headLandingBreak) || 0)) * 0.9;
  mistakeSeverity += Math.max(0, -(Number(features.opponentHeadFreedomDelta) || 0)) * 0.14;
  mistakeSeverity += Math.max(0, -(Number(features.fenceClosureDelta) || 0)) * 0.18;
  mistakeSeverity += Math.min(3.2, Math.max(0, -(Number(features.routeTowerDelta) || 0)) / 180);
  if (Number(features.trapBefore || 0) > 0 && Number(features.trapDelta || 0) <= 0) {
    mistakeSeverity += Math.min(2.4, Number(features.trapBefore) / 180);
  }
  if (outside > 0 && Number(features.homeShuffleMoves || 0) > 0 && Number(features.outsideReduction || 0) <= 0) {
    mistakeSeverity += 1.15 + Math.min(1.2, outside / 8);
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
    Number(features.homeShuffleMoves || 0) > 0 && outside > 0 && Number(features.outsideReduction || 0) <= 0
      ? 1.4 + Math.min(2.2, outside / 5)
      : 0,
  );
  const tacticalRisk = tactical
    ? Math.min(6, Math.abs(Math.min(0, Number(tactical.worstImpact) || 0)) / 12000000)
    : 0;
  const riskSignal = Math.min(10, Math.max(mistakeSeverity * urgency, structuralRisk, tacticalRisk));

  return {
    contextKey,
    actionKey,
    familyActionKey,
    legacyActionKey,
    mistakeSeverity: Math.min(8, mistakeSeverity * urgency),
    riskSignal,
    phase,
  };
}

export function normalizeExperiencePatterns(patterns = []) {
  const normalized = new Map();
  (Array.isArray(patterns) ? patterns : []).forEach((pattern) => {
    const contextKey = String(pattern?.contextKey || pattern?.context_key || '');
    const actionKey = String(pattern?.actionKey || pattern?.action_key || '');
    if (!contextKey || !actionKey) return;
    const key = `${contextKey}::${actionKey}`;
    const contribution = {
      contextKey,
      actionKey,
      samples: Math.max(0, Number(pattern.samples) || 0),
      losses: Math.max(0, Number(pattern.losses) || 0),
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
    };
    mergePattern(normalized, key, contribution, contextKey, actionKey);

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
  const actionKeys = [
    descriptor.actionKey,
    descriptor.familyActionKey,
    descriptor.legacyActionKey,
  ].filter(Boolean);

  const contextLevels = [
    { key: descriptor.contextKey, minimum: 3, weight: 1 },
    { key: `strategy:${strategic}`, minimum: 5, weight: 0.78 },
    { key: `phase:${phase}`, minimum: 8, weight: 0.52 },
    { key: '*', minimum: 16, weight: 0.28 },
  ];
  const actionWeights = [1, 0.76, 0.56];
  const matches = [];
  const seen = new Set();
  actionKeys.forEach((actionKey, index) => {
    const level = contextLevels.find((candidate) => {
      const pattern = experience.get(`${candidate.key}::${actionKey}`);
      if (!pattern) return false;
      const severeEvidence = pattern.severeLosses >= 2 && pattern.lossWeight >= 4;
      return pattern.samples >= candidate.minimum || severeEvidence;
    });
    if (!level) return;
    const mapKey = `${level.key}::${actionKey}`;
    if (seen.has(mapKey)) return;
    seen.add(mapKey);
    matches.push({
      pattern: experience.get(mapKey),
      weight: level.weight * (actionWeights[index] || 0.4),
    });
  });
  if (!matches.length) return 0;

  let evidenceWeight = 0;
  let weightedLossRate = 0;
  let weightedSevereRate = 0;
  let weightedSeverity = 0;
  let weightedSamples = 0;
  matches.forEach(({ pattern, weight }) => {
    const confidence = Math.min(0.92, pattern.samples / (pattern.samples + 7));
    const evidence = weight * confidence;
    evidenceWeight += evidence;
    weightedLossRate += Math.min(0.98, (pattern.lossWeight + 0.5) / (pattern.samples + 1.5)) * evidence;
    weightedSevereRate += pattern.severeLosses / Math.max(1, pattern.samples) * evidence;
    weightedSeverity += Math.min(5, pattern.signalWeight / Math.max(1, pattern.losses)) * evidence;
    weightedSamples += pattern.samples * weight;
  });
  if (!evidenceWeight) return 0;
  const lossRate = weightedLossRate / evidenceWeight;
  const severeRate = weightedSevereRate / evidenceWeight;
  const learnedSeverity = weightedSeverity / evidenceWeight;
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
      * (1 + learnedSeverity * 0.2)
      * relevance
    );
    return -Math.min(MAX_EXPERIENCE_PENALTY, penalty);
  }
  if (weightedSamples >= 8 && lossRate <= 0.16 && severeRate <= 0.08) {
    const reward = 3000000
      * confidence
      * (0.24 - lossRate)
      * Math.min(1.8, relevance);
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
    lossWeight: 0,
    severeLosses: 0,
    signalWeight: 0,
  };
  current.samples += pattern.samples;
  current.losses += pattern.losses;
  current.lossWeight += pattern.lossWeight;
  current.severeLosses += pattern.severeLosses;
  current.signalWeight += pattern.signalWeight;
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

function prepareReplyState(state, color, dice) {
  return {
    ...state,
    turn: color,
    phase: 'move',
    dice: [...dice],
    rolled: [...dice],
    turnMoves: [],
    headPlayedThisTurn: {
      ...(state.headPlayedThisTurn || {}),
      [color]: false,
    },
  };
}

function sampledSequences(sequences, limit) {
  const legal = (Array.isArray(sequences) ? sequences : []).filter(sequence => sequence?.length);
  if (legal.length <= limit) return legal;
  const sampled = [];
  const seen = new Set();
  const add = (sequence) => {
    if (!sequence || sampled.length >= limit) return;
    const key = sequence.map(move => `${move.from}:${move.die}`).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    sampled.push(sequence);
  };
  const bestBearOff = legal.reduce((best, sequence) => {
    const offMoves = sequence.filter(move => move.bearOff || move.to === 0).length;
    const bestOffMoves = best.filter(move => move.bearOff || move.to === 0).length;
    return offMoves > bestOffMoves ? sequence : best;
  }, legal[0]);
  if (bestBearOff.some(move => move.bearOff || move.to === 0)) add(bestBearOff);
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(index * (legal.length - 1) / Math.max(1, limit - 1));
    add(legal[sourceIndex]);
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
