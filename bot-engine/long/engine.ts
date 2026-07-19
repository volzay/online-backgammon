import { evaluateState, mergeWeights, scoreSequence, sequenceStats } from './evaluator.ts';
import {
  MAX_TACTICAL_CANDIDATES,
  analyzeOpponentReplies,
  createAnalysisBudget,
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
  koksRescuePressure,
  startZoneCount,
  startZoneExitMoveCount,
} from './metrics.ts';

const DEFAULT_MAX_CANDIDATES = 64;
const DEFAULT_ANALYSIS_NODE_BUDGET = 1150;

export function createLongBotEngine(adapter, options = {}) {
  const defaultWeights = mergeWeights(options.weights);
  const defaultMaxCandidates = Number(options.maxCandidates) || DEFAULT_MAX_CANDIDATES;
  const defaultAnalysisNodeBudget = normalizeAnalysisNodeBudget(
    options.analysisNodeBudget,
    DEFAULT_ANALYSIS_NODE_BUDGET,
  );
  const experienceSources = new Map();
  let experience = new Map();

  function rank(state, color = state.turn, runtimeOptions = {}) {
    if (!color) return [];
    const weights = mergeWeights({ ...defaultWeights, ...(runtimeOptions.weights || {}) });
    const maxCandidates = Number(runtimeOptions.maxCandidates) || defaultMaxCandidates;
    const analysisNodeBudget = normalizeAnalysisNodeBudget(
      runtimeOptions.analysisNodeBudget,
      defaultAnalysisNodeBudget,
    );
    const budget = createAnalysisBudget(analysisNodeBudget);
    const sequences = adapter.legalSequences(state, color).filter(sequence => sequence?.length);
    if (!sequences.length) return [];

    const candidates = prefilterSequences(state, color, sequences, maxCandidates);
    const ranked = [];
    for (const sequence of candidates) {
      if (!budget.consume()) break;
      const after = adapter.applySequence(state, sequence, color);
      ranked.push({
        sequence,
        after,
        score: scoreSequence(state, after, color, sequence, weights),
        features: sequenceStats(state, after, color, sequence),
      });
    }

    const maxKoksRescue = Math.max(...ranked.map(
      candidate => Number(candidate.features.startZoneReduction) || 0,
    ));
    ranked.forEach((candidate) => {
      candidate.features.koksRescueOpportunity = maxKoksRescue;
      candidate.features.missedKoksRescue = Math.max(
        0,
        maxKoksRescue - (Number(candidate.features.startZoneReduction) || 0),
      );
      candidate.baseScore = candidate.score;
      candidate.score += strategicSafetyAdjustment(state, color, candidate.features);
      candidate.experience = experienceDescriptor(state, color, candidate.features);
      candidate.experienceAdjustment = boundedExperienceAdjustment(
        experienceAdjustment(candidate.experience, experience),
        candidate.score,
      );
      candidate.score += candidate.experienceAdjustment;
    });

    let strategicallyRanked = prioritizeForcedRacePlay(state, color, ranked)
      .sort((left, right) => right.score - left.score);
    const opponentOffBeforeMove = offCount(state, opponentOf(color));
    if (
      opponentOffBeforeMove >= 3
      && offCount(state, color) === 0
      && startZoneCount(state, color) > 0
    ) {
      const bestResultSafety = Math.max(...strategicallyRanked.map(
        candidate => Number(candidate.features.resultSafetyAfter) || 0,
      ));
      const safest = strategicallyRanked.filter(
        candidate => Number(candidate.features.resultSafetyAfter) === bestResultSafety,
      );
      const maxStartExit = Math.max(...safest.map(
        candidate => Number(candidate.features.startZoneReduction) || 0,
      ));
      if (maxStartExit > 0) {
        strategicallyRanked = safest.filter(
          candidate => Number(candidate.features.startZoneReduction) === maxStartExit,
        );
      }
    }
    strategicallyRanked = reserveHomeEntryForTacticalAnalysis(
      state,
      color,
      strategicallyRanked,
    );
    const tacticallyRanked = analyzeOpponentReplies(
      adapter,
      color,
      strategicallyRanked,
      weights,
      budget,
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
    const headRemaining = headCheckers(state, color);
    const maxHeadRelease = Math.max(...strategicallyEligible.map(
      candidate => Number(candidate.features.headGain) || 0,
    ));
    const opponentOff = offCount(state, opponentOf(color));
    const headReleaseIsCritical = maxHeadRelease > 0 && (
      headRemaining <= 2
      || headRemaining >= 7
      || trapPressure >= 600
      || fenceRun >= 4
      || opponentOff > 0
    );
    if (headReleaseIsCritical) {
      strategicallyEligible = strategicallyEligible.filter(
        candidate => Number(candidate.features.headGain || 0) === maxHeadRelease,
      );
    }
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
    // Never promote an unchecked move merely because analyzed candidates
    // received realistic reply penalties.
    const finalCandidates = analyzedCandidates.length >= 2
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
      candidate.experienceAdjustment = boundedExperienceAdjustment(
        experienceAdjustment(candidate.experience, experience),
        candidate.score - previousExperienceAdjustment,
      );
      candidate.score += candidate.experienceAdjustment - previousExperienceAdjustment;
    });
    const sortedCandidates = finalCandidates.sort((left, right) => right.score - left.score);
    const developedCandidates = prioritizePreHomeDevelopment(
      state,
      color,
      prioritizeSafeEarlyDevelopment(state, color, sortedCandidates),
    );
    const distributedCandidates = prioritizeRouteDistribution(
      state,
      color,
      developedCandidates,
    );
    const finalRanked = prioritizeRouteContinuity(
      state,
      color,
      prioritizeAvailableHomeEntry(state, color, distributedCandidates),
    );
    finalRanked.forEach((candidate) => {
      candidate.features.analysisNodesUsed = budget.used;
      candidate.features.analysisNodeBudget = budget.limit;
    });
    return finalRanked;
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

function normalizeAnalysisNodeBudget(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(number));
}

function prioritizeAvailableHomeEntry(state, color, ranked) {
  const selected = ranked[0];
  if (!hasHomeEntryPriorityContext(state, color, selected)) return ranked;

  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const entering = ranked.filter(candidate => (
    Number(candidate.features.outsideReduction) > selectedEntry
    && isSafeHomeEntryAlternative(state, color, candidate, selected)
  ));
  if (!entering.length) return ranked;

  // With a clear head and no severe trap, shuffling inside the home board only
  // delays home readiness when the same roll can bring another checker home.
  const maxEntry = Math.max(...entering.map(
    candidate => Number(candidate.features.outsideReduction) || 0,
  ));
  const promoted = entering.filter(
    candidate => Number(candidate.features.outsideReduction) === maxEntry,
  );
  const promotedSet = new Set(promoted);
  promoted.forEach((candidate) => {
    const adjustment = Math.max(0, Number(selected.score) - Number(candidate.score) + 1);
    candidate.features.homeEntryPriorityAdjustment = adjustment;
    candidate.score += adjustment;
  });
  return [...promoted, ...ranked.filter(candidate => !promotedSet.has(candidate))];
}

function prioritizeRouteContinuity(state, color, ranked) {
  const selected = ranked[0];
  if (!hasHomeEntryPriorityContext(state, color, selected)) return ranked;

  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const selectedProgress = Number(selected.features.outsidePipGain) || 0;
  const selectedDebt = Number(selected.features.laggardDebtDelta) || 0;
  const continuing = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.outsideReduction || 0) >= selectedEntry
    && Number(candidate.features.outsidePipGain || 0) > selectedProgress
    && Number(candidate.features.laggardDebtDelta || 0) >= selectedDebt
    && isSafeRouteAlternative(candidate, selected, 8000000, 250000, 250000)
  ));
  if (!continuing.length) return ranked;

  continuing.sort((left, right) => (
    Number(right.features.outsideReduction || 0) - Number(left.features.outsideReduction || 0)
    || Number(right.features.outsidePipGain || 0) - Number(left.features.outsidePipGain || 0)
    || Number(right.features.laggardDebtDelta || 0) - Number(left.features.laggardDebtDelta || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, continuing[0], 'routeContinuityAdjustment');
}

function prioritizeSafeEarlyDevelopment(state, color, ranked) {
  const selected = ranked[0];
  const headRemaining = headCheckers(state, color);
  if (
    !selected
    || homeReady(state, color)
    || headRemaining < 4
    || opponentTrapRisk(state, color) >= 120
    || Number(selected.features.homeEntryMoves || 0) <= 0
  ) {
    return ranked;
  }

  const selectedHeadGain = Number(selected.features.headGain) || 0;
  const selectedProgress = Number(selected.features.outsidePipGain) || 0;
  const selectedEntry = Number(selected.features.homeEntryMoves) || 0;
  const selectedTower = Number(selected.features.maxRouteTowerAfter) || 0;
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.headGain || 0) >= selectedHeadGain
    && Number(candidate.features.homeEntryMoves || 0) < selectedEntry
    && Number(candidate.features.outsidePipGain || 0) >= selectedProgress
    && Number(candidate.features.maxRouteTowerAfter || 0) < selectedTower
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && isSaferEarlyAlternative(candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(left.features.homeEntryMoves || 0) - Number(right.features.homeEntryMoves || 0)
    || Number(left.features.maxRouteTowerAfter || 0) - Number(right.features.maxRouteTowerAfter || 0)
    || Number(right.tactical.worstImpact) - Number(left.tactical.worstImpact)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'earlyDevelopmentAdjustment');
}

function isSaferEarlyAlternative(candidate, selected) {
  if (!candidate.tactical || !selected.tactical) return false;
  return Number(candidate.score) >= Number(selected.score) - 25000000
    && Number(candidate.experienceAdjustment || 0) >= (
      Number(selected.experienceAdjustment || 0) - 500000
    )
    && Number(candidate.features.trapDelta || 0) >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0) >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0) >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.tactical.expectedImpact) >= Number(selected.tactical.expectedImpact)
    && Number(candidate.tactical.worstImpact) >= Number(selected.tactical.worstImpact);
}

function prioritizePreHomeDevelopment(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected
    || homeReady(state, color)
    || headCheckers(state, color) <= 0
    || opponentTrapRisk(state, color) >= 120
    || Number(selected.features.homeShuffleMoves || 0) <= 0
  ) {
    return ranked;
  }

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.headGain || 0) >= Number(selected.features.headGain || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      > Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && isComparablePreHomeAlternative(candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(left.features.homeShuffleMoves || 0) - Number(right.features.homeShuffleMoves || 0)
    || Number(right.features.outsidePipGain || 0) - Number(left.features.outsidePipGain || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'preHomeDevelopmentAdjustment');
}

function isComparablePreHomeAlternative(candidate, selected) {
  if (!candidate.tactical || !selected.tactical) return false;
  return Number(candidate.score) >= Number(selected.score) - 12000000
    && Number(candidate.experienceAdjustment || 0) >= (
      Number(selected.experienceAdjustment || 0) - 500000
    )
    && Number(candidate.features.trapDelta || 0) >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0) >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0) >= (
      Number(selected.features.escapeGatewayDelta || 0) - 3
    )
    && Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - 3000000
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - 7000000
    );
}

function prioritizeRouteDistribution(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected
    || homeReady(state, color)
    || headCheckers(state, color) > 0
    || outsideHomeCount(state, color) > 9
    || opponentTrapRisk(state, color) >= 120
  ) {
    return ranked;
  }

  const selectedTower = Number(selected.features.maxRouteTowerAfter) || 0;
  if (selectedTower < 6) return ranked;
  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const selectedProgress = Number(selected.features.outsidePipGain) || 0;
  const alternatives = ranked.filter(candidate => {
    if (candidate === selected) return false;
    const candidateEntry = Number(candidate.features.outsideReduction) || 0;
    const candidateProgress = Number(candidate.features.outsidePipGain) || 0;
    const keepsRouteTempo = selectedTower >= 7
      ? candidateEntry >= selectedEntry - 1 && candidateProgress >= selectedProgress
      : candidateEntry >= selectedEntry && candidateProgress >= selectedProgress;
    return keepsRouteTempo
      && Number(candidate.features.maxRouteTowerAfter || 0) < selectedTower
      && isSafeRouteAlternative(candidate, selected, 4000000, 750000, 250000);
  });
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(left.features.maxRouteTowerAfter || 0) - Number(right.features.maxRouteTowerAfter || 0)
    || Number(right.features.outsideReduction || 0) - Number(left.features.outsideReduction || 0)
    || Number(right.features.outsidePipGain || 0) - Number(left.features.outsidePipGain || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'routeDistributionAdjustment');
}

function isSafeRouteAlternative(
  candidate,
  selected,
  scoreTolerance,
  expectedReplyTolerance,
  worstReplyTolerance,
) {
  if (!candidate.tactical || !selected.tactical) return false;
  return Number(candidate.score) >= Number(selected.score) - scoreTolerance
    && Number(candidate.experienceAdjustment || 0) >= (
      Number(selected.experienceAdjustment || 0) - 500000
    )
    && Number(candidate.features.trapDelta || 0) >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0) >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0) >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - expectedReplyTolerance
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - worstReplyTolerance
    );
}

function promoteCandidate(ranked, promoted, adjustmentKey) {
  const selected = ranked[0];
  const adjustment = Math.max(0, Number(selected.score) - Number(promoted.score) + 1);
  promoted.features[adjustmentKey] = adjustment;
  promoted.score += adjustment;
  return [promoted, ...ranked.filter(candidate => candidate !== promoted)];
}

function isSafeHomeEntryAlternative(state, color, candidate, selected) {
  if (
    !isPlausibleHomeEntryAlternative(state, color, candidate, selected)
    || !candidate.tactical
    || !selected.tactical
  ) {
    return false;
  }
  const replyTolerance = isForcedLateHomeEntryContext(state, color, selected)
    ? 8000000
    : 250000;
  return Number(candidate.tactical.expectedImpact) >= (
    Number(selected.tactical.expectedImpact) - replyTolerance
  )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - replyTolerance
    );
}

export function reserveHomeEntryForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  const selected = ranked[0];
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  if (
    ranked.length <= slotCount
    || !hasHomeEntryPriorityContext(state, color, selected)
  ) {
    return ranked;
  }

  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const entering = ranked.filter(candidate => (
    Number(candidate.features.outsideReduction) > selectedEntry
    && isPlausibleHomeEntryAlternative(state, color, candidate, selected)
  ));
  if (!entering.length) return ranked;

  const maxEntry = Math.max(...entering.map(
    candidate => Number(candidate.features.outsideReduction) || 0,
  ));
  const reserved = entering.find(
    candidate => Number(candidate.features.outsideReduction) === maxEntry,
  );
  const reservedIndex = ranked.indexOf(reserved);
  if (reservedIndex < slotCount) return ranked;

  const leading = ranked.slice(0, slotCount - 1);
  const leadingSet = new Set(leading);
  return [
    ...leading,
    reserved,
    ...ranked.filter(candidate => candidate !== reserved && !leadingSet.has(candidate)),
  ];
}

function hasHomeEntryPriorityContext(state, color, selected) {
  return Boolean(selected)
    && !homeReady(state, color)
    && headCheckers(state, color) === 0
    && outsideHomeCount(state, color) <= 9
    && opponentTrapRisk(state, color) < 120
    && Number(selected.features.homeShuffleMoves || 0) > 0;
}

function isPlausibleHomeEntryAlternative(state, color, candidate, selected) {
  const forcedLateEntry = isForcedLateHomeEntryContext(state, color, selected);
  const totalScoreTolerance = forcedLateEntry ? 18000000 : 2000000;
  const experienceTolerance = 500000;
  const trapFloor = forcedLateEntry ? Number(selected.features.trapDelta || 0) : 0;
  const fenceFloor = forcedLateEntry ? Number(selected.features.fenceClosureDelta || 0) : 0;
  const gatewayFloor = forcedLateEntry ? Number(selected.features.escapeGatewayDelta || 0) : 0;
  return Number(candidate.features.trapDelta || 0) >= trapFloor
    && Number(candidate.features.fenceClosureDelta || 0) >= fenceFloor
    && Number(candidate.features.escapeGatewayDelta || 0) >= gatewayFloor
    && Number(candidate.features.maxRouteTowerAfter || 0) < 7
    && Number(candidate.score) >= Number(selected.score) - totalScoreTolerance
    && Number(candidate.experienceAdjustment || 0) >= (
      Number(selected.experienceAdjustment || 0) - experienceTolerance
    );
}

function isForcedLateHomeEntryContext(state, color, selected) {
  return Boolean(selected)
    && headCheckers(state, color) === 0
    && outsideHomeCount(state, color) <= 6
    && opponentTrapRisk(state, color) < 120
    && Number(selected.features.homeShuffleMoves || 0) > 0;
}

function boundedExperienceAdjustment(rawAdjustment, immediateScore) {
  const raw = Number(rawAdjustment) || 0;
  const budget = Math.min(
    18000000,
    Math.max(6000000, Math.abs(Number(immediateScore) || 0) * 0.06),
  );
  return Math.max(-budget, Math.min(Math.min(6000000, budget), raw));
}

function prefilterSequences(state, color, sequences, maxCandidates) {
  const ready = homeReady(state, color);
  const entryPressure = lateEntryPressure(state, color);
  const trapPressure = opponentTrapRisk(state, color);
  const development = developmentPressure(state, color);
  const rescuePressure = koksRescuePressure(state, color);

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
      const startZoneExits = startZoneExitMoveCount(sequence, color);
      return {
        sequence,
        offMoves,
        homeEntries,
        outsideMoves,
        headMoves,
        homeShuffle: insideHomeMoves,
        startZoneExits,
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
          + startZoneExits * 3000000 * rescuePressure
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
  add(bestBy(item => item.startZoneExits > 0, (a, b) => (
    b.startZoneExits - a.startZoneExits || b.priority - a.priority
  )));
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
