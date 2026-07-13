import { evaluateState, scoreSequence } from './evaluator.ts';
import {
  headCheckers,
  homeReady,
  offCount,
  opponentOf,
  opponentTrapRisk,
  outsideHomeCount,
  pipsFor,
} from './metrics.ts';

const MAX_REPLY_SEQUENCES = 10;
const MAX_TACTICAL_CANDIDATES = 6;
const MAX_EXPERIENCE_PENALTY = 2600000;

const TACTICAL_ROLLS = [
  { dice: [6, 6], weight: 1 },
  { dice: [6, 5], weight: 2 },
  { dice: [5, 5], weight: 1 },
  { dice: [6, 4], weight: 2 },
  { dice: [5, 4], weight: 2 },
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

export function analyzeOpponentReplies(
  adapter,
  color,
  candidates,
  weights,
  deadline,
) {
  const tacticalCandidates = candidates.slice(0, MAX_TACTICAL_CANDIDATES);
  if (tacticalCandidates.length < 2 || Date.now() >= deadline) return candidates;

  const opponent = opponentOf(color);
  const accumulators = tacticalCandidates.map(candidate => ({
    candidate,
    expectedImpact: 0,
    weight: 0,
    worstImpact: 0,
    rolls: 0,
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

      for (const reply of replySequences) {
        const replyAfter = adapter.applySequence(replyState, reply, opponent);
        const opponentGain = scoreSequence(replyState, replyAfter, opponent, reply, weights);
        const ownValue = evaluateState(replyAfter, color, weights);
        const replyValue = ownValue - Math.max(0, opponentGain) * 0.08;
        worstValue = Math.min(worstValue, replyValue);
      }
      rollResults.push(worstValue - beforeValue);
    }

    if (!completedRoll) break;
    rollResults.forEach((impact, index) => {
      const accumulator = accumulators[index];
      accumulator.expectedImpact += impact * roll.weight;
      accumulator.weight += roll.weight;
      accumulator.worstImpact = Math.min(accumulator.worstImpact, impact);
      accumulator.rolls += 1;
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
    };
  });

  return candidates.sort((left, right) => right.score - left.score);
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
    bucket('tr', trap, [0, 40, 180, 600]),
    bucket('pd', pipDelta, [-36, -8, 9, 37]),
  ].join('|');

  const actionKey = [
    signedFlag('head', features.headGain),
    signedFlag('entry', features.outsideReduction),
    signedFlag('trap', features.trapDelta),
    signedFlag('freedom', features.opponentHeadFreedomDelta),
    signedFlag('distribution', features.distributionDelta),
    Number(features.headLandingBreak || 0) > 0 ? 'support:break' : 'support:keep',
    Number(features.homeShuffleMoves || 0) > 0 ? 'home:shuffle' : 'home:steady',
    Number(features.bearOffMoves || 0) > 0 ? 'off:yes' : 'off:no',
  ].join('|');

  const urgency = 1
    + opponentOff * 0.12
    + (homeReady(state, opponent) ? 0.65 : 0)
    + (phase === 'koks-rescue' ? 0.8 : 0);
  let mistakeSeverity = 0;
  mistakeSeverity += Math.min(3, Math.max(0, Number(features.headLandingBreak) || 0)) * 0.9;
  mistakeSeverity += Math.max(0, -(Number(features.opponentHeadFreedomDelta) || 0)) * 0.14;
  mistakeSeverity += Math.max(0, -(Number(features.fenceClosureDelta) || 0)) * 0.18;
  if (Number(features.trapBefore || 0) > 0 && Number(features.trapDelta || 0) <= 0) {
    mistakeSeverity += Math.min(2.4, Number(features.trapBefore) / 180);
  }
  if (outside > 0 && Number(features.homeShuffleMoves || 0) > 0 && Number(features.outsideReduction || 0) <= 0) {
    mistakeSeverity += 1.15 + Math.min(1.2, outside / 8);
  }
  if (ownHead > 0 && Number(features.headGain || 0) <= 0 && (ownHead <= 2 || opponentOff > 0)) {
    mistakeSeverity += 1.4;
  }
  if (tactical && Number(tactical.worstImpact) < -4000000) {
    mistakeSeverity += Math.min(2.2, Math.abs(Number(tactical.worstImpact)) / 16000000);
  }

  return {
    contextKey,
    actionKey,
    mistakeSeverity: Math.min(8, mistakeSeverity * urgency),
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
    mergePattern(normalized, `phase:${phase}::${actionKey}`, contribution, phase, actionKey);
    mergePattern(normalized, `*::${actionKey}`, contribution, '*', actionKey);
  });
  return normalized;
}

export function experienceAdjustment(descriptor, experience) {
  if (!descriptor || !(experience instanceof Map)) return 0;
  const phase = descriptor.phase || String(descriptor.contextKey || '').split('|')[0] || 'route';
  const pattern = [
    experience.get(`${descriptor.contextKey}::${descriptor.actionKey}`),
    experience.get(`phase:${phase}::${descriptor.actionKey}`),
    experience.get(`*::${descriptor.actionKey}`),
  ].find(candidate => candidate?.samples >= 2);
  if (!pattern || pattern.samples < 2 || descriptor.mistakeSeverity <= 0) return 0;

  const lossRate = (pattern.losses + 1) / (pattern.samples + 2);
  if (lossRate <= 0.55) return 0;
  const severeRate = pattern.severeLosses / Math.max(1, pattern.samples);
  const confidence = Math.min(0.88, pattern.samples / (pattern.samples + 6));
  const learnedSeverity = Math.min(
    4,
    pattern.signalWeight / Math.max(1, pattern.samples),
  );
  const penalty = (
    280000
    * confidence
    * (lossRate - 0.5)
    * (1 + severeRate * 1.8)
    * (1 + learnedSeverity * 0.28)
    * Math.min(4, descriptor.mistakeSeverity)
  );
  return -Math.min(MAX_EXPERIENCE_PENALTY, penalty);
}

function mergePattern(target, key, pattern, contextKey, actionKey) {
  const current = target.get(key) || {
    contextKey,
    actionKey,
    samples: 0,
    losses: 0,
    severeLosses: 0,
    signalWeight: 0,
  };
  current.samples += pattern.samples;
  current.losses += pattern.losses;
  current.severeLosses += pattern.severeLosses;
  current.signalWeight += pattern.signalWeight;
  target.set(key, current);
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
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(index * (legal.length - 1) / Math.max(1, limit - 1));
    const sequence = legal[sourceIndex];
    const key = sequence.map(move => `${move.from}:${move.die}`).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    sampled.push(sequence);
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
