import { evaluateState, mergeWeights, scoreSequence, sequenceStats } from './evaluator.ts';
import {
  analyzeOpponentReplies,
  experienceAdjustment,
  experienceDescriptor,
  normalizeExperiencePatterns,
} from './analysis.ts';
import {
  developmentPressure,
  headCheckers,
  headPoint,
  homeEntryMoveCount,
  homeReady,
  homeShuffleMoveCount,
  lateEntryPressure,
  offCount,
  opponentHeadFreedomMoveDelta,
  opponentTrapRisk,
  pathPos,
  pipsFor,
} from './metrics.ts';

const DEFAULT_MAX_CANDIDATES = 64;
const DEFAULT_TIME_LIMIT_MS = 900;

export function createLongBotEngine(adapter, options = {}) {
  const defaultWeights = mergeWeights(options.weights);
  const defaultMaxCandidates = Number(options.maxCandidates) || DEFAULT_MAX_CANDIDATES;
  const defaultTimeLimitMs = Number(options.timeLimitMs) || DEFAULT_TIME_LIMIT_MS;
  const experienceSources = new Map();
  let experience = new Map();

  function rank(state, color = state.turn, runtimeOptions = {}) {
    if (!color) return [];
    const weights = mergeWeights({ ...defaultWeights, ...(runtimeOptions.weights || {}) });
    const startedAt = Date.now();
    const maxCandidates = Number(runtimeOptions.maxCandidates) || defaultMaxCandidates;
    const timeLimitMs = Number(runtimeOptions.timeLimitMs) || defaultTimeLimitMs;
    const deadline = startedAt + timeLimitMs;
    const staticDeadline = startedAt + Math.max(120, timeLimitMs * 0.48);
    const sequences = adapter.legalSequences(state, color).filter(sequence => sequence?.length);
    if (!sequences.length) return [];

    const candidates = prefilterSequences(state, color, sequences, maxCandidates);
    const ranked = [];
    for (const sequence of candidates) {
      const after = adapter.applySequence(state, sequence, color);
      ranked.push({
        sequence,
        after,
        score: scoreSequence(state, after, color, sequence, weights),
        features: sequenceStats(state, after, color, sequence),
      });
      if (Date.now() >= staticDeadline && ranked.length >= 12) break;
    }

    ranked.forEach((candidate) => {
      candidate.baseScore = candidate.score;
      candidate.score += strategicSafetyAdjustment(state, color, candidate.features);
      candidate.experience = experienceDescriptor(state, color, candidate.features);
      candidate.experienceAdjustment = experienceAdjustment(candidate.experience, experience);
      candidate.score += candidate.experienceAdjustment;
    });

    const strategicallyRanked = prioritizeForcedRacePlay(state, color, ranked)
      .sort((left, right) => right.score - left.score);
    analyzeOpponentReplies(adapter, color, strategicallyRanked, weights, deadline);
    strategicallyRanked.forEach((candidate) => {
      candidate.experience = experienceDescriptor(
        state,
        color,
        candidate.features,
        candidate.tactical,
      );
    });
    return strategicallyRanked.sort((left, right) => right.score - left.score);
  }

  function plan(state, color = state.turn, runtimeOptions = {}) {
    const ranked = rank(state, color, runtimeOptions);
    return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
  }

  return {
    plan,
    rank,
    evaluateState(state, color, weights = defaultWeights) {
      return evaluateState(state, color, mergeWeights(weights));
    },
    scoreSequence(state, sequence, color = state.turn, weights = defaultWeights) {
      const after = adapter.applySequence(state, sequence, color);
      return scoreSequence(state, after, color, sequence, mergeWeights(weights));
    },
    setExperience(patterns = [], source = 'runtime') {
      experienceSources.set(String(source || 'runtime'), Array.isArray(patterns) ? patterns : []);
      experience = normalizeExperiencePatterns(
        Array.from(experienceSources.values()).flat(),
      );
      return experience.size;
    },
    experienceSize() {
      return experience.size;
    },
  };
}

function prefilterSequences(state, color, sequences, maxCandidates) {
  if (sequences.length <= maxCandidates) return sequences;
  const ready = homeReady(state, color);
  const entryPressure = lateEntryPressure(state, color);
  const trapPressure = opponentTrapRisk(state, color);
  const development = developmentPressure(state, color);

  const head = headPoint(color);
  const scored = sequences
    .map(sequence => {
      const offMoves = sequence.reduce((total, move) => total + (move.bearOff || move.to === 0 ? 1 : 0), 0);
      const roughPips = sequence.reduce((total, move) => total + Number(move.die || 0), 0);
      const homeShuffle = ready ? sequence.length - offMoves : 0;
      const homeEntries = homeEntryMoveCount(sequence, color);
      const insideHomeMoves = homeShuffleMoveCount(sequence, color);
      const outsideMoves = sequence.reduce((total, move) => total + (pathPos(color, move.from) < 18 ? 1 : 0), 0);
      const headMoves = sequence.reduce(
        (total, move) => total + (Number(move.from) === Number(head) ? 1 : 0),
        0,
      );
      const opponentHeadControlGain = opponentHeadFreedomMoveDelta(state, color, sequence);
      return {
        sequence,
        offMoves,
        homeEntries,
        outsideMoves,
        headMoves,
        homeShuffle: insideHomeMoves,
        priority: (ready ? offMoves * 100000 - homeShuffle * 20000 : 0)
          + homeEntries * 65000 * entryPressure
          - insideHomeMoves * 26000 * Math.max(1, entryPressure) * Math.max(1, development)
          + outsideMoves * Math.min(90000, trapPressure * 320)
          + headMoves * (headCheckers(state, color) <= 2 ? 150000 : 28000)
          + opponentHeadControlGain * 18000
          + roughPips * 120
          + offCount(state, color) * 10
          - pipsFor(state, color) * 0.01,
      };
    })
    .sort((a, b) => b.priority - a.priority);

  const selected = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || selected.length >= maxCandidates) return;
    const key = item.sequence.map(move => `${move.from}:${move.die}`).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(item.sequence);
  };
  const bestBy = (predicate, compare) => scored.filter(predicate).sort(compare)[0];

  add(bestBy(item => item.headMoves > 0, (a, b) => b.priority - a.priority));
  add(bestBy(item => item.homeEntries > 0, (a, b) => (
    b.homeEntries - a.homeEntries || b.priority - a.priority
  )));
  add(bestBy(item => item.outsideMoves > 0, (a, b) => (
    b.outsideMoves - a.outsideMoves || b.priority - a.priority
  )));
  add(bestBy(item => item.homeShuffle === 0, (a, b) => b.priority - a.priority));
  add(bestBy(item => item.offMoves > 0, (a, b) => (
    b.offMoves - a.offMoves || b.priority - a.priority
  )));
  scored.forEach(add);
  return selected;
}

function prioritizeForcedRacePlay(state, color, ranked) {
  if (!ranked.length) return ranked;
  if (homeReady(state, color)) {
    const maxOff = Math.max(...ranked.map(candidate => Number(candidate.features.offGain) || 0));
    return ranked.filter(candidate => Number(candidate.features.offGain) === maxOff);
  }

  const opponent = opponentOf(color);
  const outside = outsideHomeCount(state, color);
  const opponentOff = offCount(state, opponent);
  const trapPressure = opponentTrapRisk(state, color);
  const maxEntry = Math.max(...ranked.map(candidate => Number(candidate.features.outsideReduction) || 0));
  const maxHeadRelease = Math.max(...ranked.map(candidate => Number(candidate.features.headGain) || 0));
  const urgentHeadRelease = headCheckers(state, color) > 0
    && maxHeadRelease > 0
    && (
      headCheckers(state, color) <= 2
      || opponentOff > 0
      || homeReady(state, opponent)
      || trapPressure > 80
    );

  ranked.forEach((candidate) => {
    const features = candidate.features;
    if (urgentHeadRelease) {
      candidate.score += Number(features.headGain || 0) * 36000000;
      if (Number(features.headGain || 0) < maxHeadRelease) candidate.score -= 28000000;
    }
    if (outside <= 4 && maxEntry > 0) {
      candidate.score += Number(features.outsideReduction || 0)
        * (14000000 + opponentOff * 3500000);
      if (Number(features.outsideReduction || 0) < maxEntry) {
        candidate.score -= (maxEntry - Number(features.outsideReduction || 0))
          * (9000000 + opponentOff * 2200000);
      }
    }
    if (trapPressure > 850 && maxEntry > 0) {
      const entry = Number(features.outsideReduction || 0);
      const trapScale = Math.min(72000000, trapPressure * 52000);
      candidate.score += entry * (18000000 + trapScale);
      if (entry < maxEntry) {
        candidate.score -= (maxEntry - entry) * (16000000 + trapScale * 0.82);
      }
      candidate.score -= Number(features.homeShuffleMoves || 0)
        * (12000000 + trapScale * 0.72);
    }
    if (trapPressure < 120 && maxEntry > 0 && headCheckers(state, color) >= 7) {
      const entry = Number(features.outsideReduction || 0);
      candidate.score += entry * 72000000;
      if (entry <= 0 && Number(features.headGain || 0) > 0) candidate.score -= 12000000;
    }
    if (opponentOff >= 3 && offCount(state, color) === 0) {
      candidate.score += Number(features.bearOffMoves || 0) * 42000000;
      candidate.score += Number(features.outsideReduction || 0) * 15000000;
      candidate.score += Number(features.headGain || 0) * 12000000;
      candidate.score -= Number(features.homeShuffleMoves || 0) * 14000000;
    }
  });
  return ranked;
}

function strategicSafetyAdjustment(state, color, features) {
  const opponent = opponentOf(color);
  const opponentOff = offCount(state, opponent);
  const outside = outsideHomeCount(state, color);
  let score = 0;

  score -= Math.max(0, Number(features.headLandingBreak) || 0)
    * (4200000 + headCheckers(state, color) * 620000);
  score += Number(features.opponentHeadFreedomDelta || 0)
    * (2200000 + Math.max(0, headCheckers(state, opponent) - 2) * 240000);
  if (Number(features.trapBefore || 0) > 0) {
    score += Number(features.trapDelta || 0) * (380000 + opponentOff * 70000);
    if (Number(features.trapDelta || 0) <= 0) {
      score -= Math.min(24000000, Number(features.trapBefore) * 68000);
    }
  }
  if (outside > 0 && Number(features.homeShuffleMoves || 0) > 0) {
    score -= Number(features.homeShuffleMoves)
      * (3800000 + Math.max(0, 6 - outside) * 1600000 + opponentOff * 1100000);
  }
  if (outside > 0 && Number(features.homeShuffleMoves || 0) > 0 && Number(features.trapBefore || 0) > 850) {
    score -= Number(features.homeShuffleMoves)
      * Math.min(160000000, Number(features.trapBefore) * 9500);
  }
  score += Math.max(0, Number(features.laggardDebtDelta) || 0)
    * (155000 + developmentPressure(state, color) * 42000);
  return score;
}
