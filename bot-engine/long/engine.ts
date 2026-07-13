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
  opponentOf,
  opponentHeadFreedomMoveDelta,
  opponentTrapRisk,
  outsideHomeCount,
  pathPos,
  pipsFor,
} from './metrics.ts';

const DEFAULT_MAX_CANDIDATES = 64;
const DEFAULT_TIME_LIMIT_MS = 3600;

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
    const staticDeadline = startedAt + Math.max(120, timeLimitMs * 0.34);
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
      if (Date.now() >= staticDeadline && ranked.length >= 8) break;
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
    const tacticallyRanked = analyzeOpponentReplies(
      adapter,
      color,
      strategicallyRanked,
      weights,
      deadline,
    );
    const outside = outsideHomeCount(state, color);
    const trapPressure = opponentTrapRisk(state, color);
    const maxEntry = Math.max(...tacticallyRanked.map(
      candidate => Number(candidate.features.outsideReduction) || 0,
    ));
    const fenceRun = Math.max(...tacticallyRanked.map(
      candidate => Number(candidate.features.opponentFenceRunBefore) || 0,
    ));
    const nonSevereTowerCandidates = fenceRun >= 5
      ? tacticallyRanked.filter(candidate => Number(candidate.features.maxRouteTowerAfter) < 7)
      : [];
    const hasSevereTowerCandidate = tacticallyRanked.some(
      candidate => Number(candidate.features.maxRouteTowerAfter) >= 7,
    );
    let strategicallyEligible = hasSevereTowerCandidate && nonSevereTowerCandidates.length
      ? nonSevereTowerCandidates
      : trapPressure > 850 && outside <= 8 && maxEntry > 0 && fenceRun < 4
        ? tacticallyRanked.filter(
          candidate => Number(candidate.features.outsideReduction) === maxEntry,
        )
        : tacticallyRanked;
    if (fenceRun >= 5) {
      const maxSafeEntry = Math.max(...strategicallyEligible.map(
        candidate => Number(candidate.features.outsideReduction) || 0,
      ));
      if (maxSafeEntry > 0) {
        strategicallyEligible = strategicallyEligible.filter(
          candidate => Number(candidate.features.outsideReduction) === maxSafeEntry,
        );
      }
    }
    const analyzedCandidates = strategicallyEligible.filter(candidate => candidate.tactical);
    const requireComparableTactics = trapPressure > 850 && outside > 8;
    const finalCandidates = requireComparableTactics && analyzedCandidates.length >= 2
      ? analyzedCandidates
      : strategicallyEligible;
    finalCandidates.forEach((candidate) => {
      const previousExperienceAdjustment = Number(candidate.experienceAdjustment) || 0;
      candidate.experience = experienceDescriptor(
        state,
        color,
        candidate.features,
        candidate.tactical,
      );
      candidate.experienceAdjustment = experienceAdjustment(candidate.experience, experience);
      candidate.score += candidate.experienceAdjustment - previousExperienceAdjustment;
    });
    return finalCandidates.sort((left, right) => right.score - left.score);
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
          + headMoves * (
            headCheckers(state, color) >= 7
              ? 250000 + headCheckers(state, color) * 30000
              : headCheckers(state, color) <= 2
                ? 180000
                : 95000
          )
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
  const headRemaining = headCheckers(state, color);
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
    if (headRemaining >= 7 && maxHeadRelease > 0) {
      const release = Number(features.headGain || 0);
      const developmentScale = 52000000 + headRemaining * 5200000;
      candidate.score += release * developmentScale;
      if (release < maxHeadRelease) candidate.score -= developmentScale * 0.72;
      if (release <= 0 && Number(features.outsideReduction || 0) > 0) {
        candidate.score -= 26000000 + headRemaining * 2800000;
      }
    } else if (headRemaining >= 4 && maxHeadRelease > 0) {
      candidate.score += Number(features.headGain || 0) * 18000000;
    }
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
    const fenceRun = Number(features.opponentFenceRunBefore || 0);
    if (trapPressure > 850 && fenceRun >= 4) {
      candidate.score += Number(features.trapDelta || 0) * 2200000;
      candidate.score += Number(features.escapeGatewayDelta || 0) * 2800000;
      candidate.score += Math.max(0, Number(features.laggardDebtDelta) || 0) * 340000;
      candidate.score += Number(features.outsideDevelopmentMoves || 0) * 12000000;
      candidate.score -= Number(features.homeEntryMoves || 0) * 18000000;
    } else if (trapPressure > 850 && outside <= 8 && maxEntry > 0) {
      const entry = Number(features.outsideReduction || 0);
      const trapScale = Math.min(72000000, trapPressure * 52000);
      candidate.score += entry * (18000000 + trapScale);
      if (entry < maxEntry) {
        candidate.score -= (maxEntry - entry) * (16000000 + trapScale * 0.82);
      }
      candidate.score -= Number(features.homeShuffleMoves || 0)
        * (12000000 + trapScale * 0.72);
    } else if (trapPressure > 850 && outside > 8) {
      candidate.score += Number(features.trapDelta || 0) * 1800000;
      candidate.score += Number(features.escapeGatewayDelta || 0) * 2400000;
      candidate.score += Number(features.outsideDevelopmentMoves || 0) * 9000000;
      candidate.score += Number(features.distributionDelta || 0) * 180000;
      candidate.score -= Number(features.homeEntryMoves || 0) * 42000000;
    }
    if (trapPressure < 120 && headRemaining >= 7 && maxHeadRelease > 0) {
      candidate.score += Number(features.headGain || 0) * 24000000;
      candidate.score -= Number(features.homeEntryMoves || 0) * 18000000;
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
  const fenceClosureDelta = Number(features.fenceClosureDelta || 0);
  const fenceClosureBefore = Number(features.fenceClosureBefore || 0);
  score += fenceClosureDelta * (fenceClosureBefore > 0 ? 950000 : 620000);
  if (fenceClosureDelta < 0) {
    score += fenceClosureDelta
      * (2400000 + Math.min(1800000, Number(features.trapBefore || 0) * 1100));
  }
  const escapeGatewayDelta = Number(features.escapeGatewayDelta || 0);
  if (escapeGatewayDelta < 0) {
    score += escapeGatewayDelta
      * (1300000 + Math.min(1700000, Number(features.trapBefore || 0) * 900));
  }
  const distributionDelta = Number(features.distributionDelta || 0);
  if (outside > 0 && distributionDelta < 0) {
    score += distributionDelta
      * (150000 + Math.min(180000, Number(features.trapBefore || 0) * 120));
  }
  const routeTowerDelta = Number(features.routeTowerDelta || 0);
  const fenceRun = Number(features.opponentFenceRunBefore || 0);
  if (outside > 0 && routeTowerDelta !== 0) {
    const towerScale = 18000
      + Math.max(0, fenceRun - 2) * 9000
      + Math.min(45000, Number(features.trapBefore || 0) * 20);
    score += routeTowerDelta * towerScale;
    if (routeTowerDelta < 0 && fenceRun >= 4) {
      score += routeTowerDelta * 75000;
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
