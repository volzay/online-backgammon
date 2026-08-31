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
  blockingPrimeRun,
  blockingPrimeScore,
  colorAt,
  developmentPressure,
  headCheckers,
  headPoint,
  homeEntryMoveCount,
  homeReady,
  homeShuffleMoveCount,
  immediateHeadFenceRun,
  lateEntryPressure,
  offCount,
  opponentOf,
  opponentMoveBlockScore,
  opponentHeadFreedomMoveDelta,
  opponentTrapRisk,
  outsideHomeCount,
  pathFor,
  pathPos,
  pipsFor,
  koksRescuePressure,
  latentFenceExposure,
  startZoneCount,
  startZoneExitMoveCount,
} from './metrics.ts';

const DEFAULT_MAX_CANDIDATES = 64;
const DEFAULT_ANALYSIS_NODE_BUDGET = 1150;
const LATENT_REAR_ESCAPE_SCORE_TOLERANCE = 420000000;
const IMMINENT_HEAD_FENCE_SCORE_TOLERANCE = 8000000;
const CONTESTED_HEAD_EXIT_SCORE_TOLERANCE = 60000000;

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
    const strategyProfile = String(runtimeOptions.strategyProfile || 'v19').toLowerCase();
    const advancedStrategy = strategyProfile !== 'v19';
    const useExperience = advancedStrategy
      || !Object.prototype.hasOwnProperty.call(runtimeOptions, 'strategyProfile');
    const sequences = adapter.legalSequences(state, color).filter(sequence => sequence?.length);
    if (!sequences.length) return [];

    const candidates = prefilterSequences(state, color, sequences, maxCandidates);
    const ranked = [];
    const advancedBeforeMetrics = advancedStrategy
      ? advancedStateMetrics(state, color)
      : null;
    for (const sequence of candidates) {
      if (!budget.consume()) break;
      const after = adapter.applySequence(state, sequence, color);
      const features = sequenceStats(state, after, color, sequence);
      if (advancedStrategy) {
        Object.assign(features, advancedSequenceStats(
          advancedBeforeMetrics,
          after,
          color,
        ));
      }
      ranked.push({
        sequence,
        after,
        score: scoreSequence(state, after, color, sequence, weights),
        features,
      });
    }

    const choiceCount = uniqueCandidatePositions(ranked).length;
    ranked.forEach((candidate) => {
      candidate.features.choiceCount = choiceCount;
    });

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
      if (advancedStrategy) {
        candidate.features.advancedStrategyAdjustment = advancedStrategyAdjustment(
          state,
          color,
          candidate.features,
        );
        candidate.score += candidate.features.advancedStrategyAdjustment;
      }
      candidate.features.strategyProfile = strategyProfile;
    });
    annotateAvoidableHomeShuffles(ranked);
    ranked.forEach((candidate) => {
      candidate.experience = experienceDescriptor(state, color, candidate.features);
      candidate.experienceAdjustment = useExperience
        ? boundedExperienceAdjustment(
          experienceAdjustment(candidate.experience, experience),
          candidate.score,
        )
        : 0;
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
    strategicallyRanked = reserveRouteContinuityForTacticalAnalysis(
      state,
      color,
      strategicallyRanked,
    );
    strategicallyRanked = reserveDevelopingFenceEscapeForTacticalAnalysis(
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
      { expandDoubles: advancedStrategy },
    );
    if (advancedStrategy) {
      tacticallyRanked.forEach((candidate) => {
        const adjustment = advancedTacticalAdjustment(state, color, candidate);
        candidate.features.advancedTacticalAdjustment = adjustment;
        candidate.score += adjustment;
      });
      tacticallyRanked.sort((left, right) => right.score - left.score);
    }
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
    let finalCandidates = analyzedCandidates.length
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
      candidate.experienceAdjustment = useExperience
        ? boundedExperienceAdjustment(
          experienceAdjustment(candidate.experience, experience),
          candidate.score - previousExperienceAdjustment,
        )
        : 0;
      candidate.score += candidate.experienceAdjustment - previousExperienceAdjustment;
    });
    finalCandidates = prioritizeContestedOpponentHeadExit(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    finalCandidates = prioritizeImminentHeadFenceAnchor(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    finalCandidates = prioritizeDevelopingFenceEscape(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    const sortedCandidates = prioritizeLatentTrapDistribution(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
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

  function describeSequence(state, sequence, color = state.turn, runtimeOptions = {}) {
    if (!state || !color || !Array.isArray(sequence) || !sequence.length) return null;
    const after = adapter.applySequence(state, sequence, color);
    const features = sequenceStats(state, after, color, sequence);
    const strategyProfile = String(runtimeOptions.strategyProfile || 'v20').toLowerCase();
    if (strategyProfile !== 'v19') {
      Object.assign(features, advancedSequenceStats(
        advancedStateMetrics(state, color),
        after,
        color,
      ));
    }
    return {
      features,
      experience: experienceDescriptor(state, color, features),
    };
  }

  return {
    plan,
    rank,
    describeSequence,
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

function advancedStrategyAdjustment(state, color, features) {
  const opponent = opponentOf(color);
  const raceDebt = pipsFor(state, color) - pipsFor(state, opponent);
  const opponentHead = headCheckers(state, opponent);
  const ownHead = headCheckers(state, color);
  const attackPressure = Math.min(3.4, 1
    + Math.max(-0.2, Math.min(1.2, raceDebt / 70))
    + Math.max(0, opponentHead - 3) / 8
    + Math.max(0, ownHead - 5) / 14);
  const primeGain = Number(features.primeScoreGain) || 0;
  const blockGain = Number(features.opponentMoveBlockGain) || 0;
  const primeRunBefore = Number(features.primeRunBefore) || 0;
  const primeRunAfter = Number(features.primeRunAfter) || 0;
  const effectivePrimeRunBefore = Math.min(6, primeRunBefore);
  const effectivePrimeRunAfter = Math.min(6, primeRunAfter);
  const runPowerGain = Math.pow(effectivePrimeRunAfter, 4)
    - Math.pow(effectivePrimeRunBefore, 4);
  const trapBefore = Math.max(0, Number(features.trapBefore) || 0);
  const opponentFenceRun = Math.max(0, Number(features.opponentFenceRunBefore) || 0);
  const maxRouteTowerAfter = Math.max(0, Number(features.maxRouteTowerAfter) || 0);
  const routeTowerDelta = Number(features.routeTowerDelta) || 0;
  const laggardDebtDelta = Math.max(0, Number(features.laggardDebtDelta) || 0);
  const outside = outsideHomeCount(state, color);
  const outsidePipGain = Math.max(0, Number(features.outsidePipGain) || 0);
  const homeShuffleMoves = Math.max(0, Number(features.homeShuffleMoves) || 0);
  const primeScoreBefore = Math.max(0, Number(features.primeScoreBefore) || 0);
  const primeScoreAfter = Math.max(0, Number(features.primeScoreAfter) || 0);
  const lateRouteRace = ownHead === 0
    && opponentHead === 0
    && outside > 0
    && outside <= 6
    && (
      effectivePrimeRunBefore >= 4
      || (
        effectivePrimeRunBefore === 3
        && trapBefore === 0
        && opponentFenceRun >= 2
      )
    );
  const activeLockBreak = effectivePrimeRunBefore >= 5
    && primeScoreBefore > 0
    && (
      effectivePrimeRunAfter < effectivePrimeRunBefore
      || primeScoreAfter < primeScoreBefore
      || blockGain < 0
    );
  const safeLateRouteAdvance = lateRouteRace
    && outsidePipGain > 0
    && !activeLockBreak;
  const clearedHeadLaggardEscape = (ownHead === 0
    && opponentHead === 0
    && effectivePrimeRunBefore >= 5
    && trapBefore >= 240
    && laggardDebtDelta >= 120)
    || safeLateRouteAdvance;
  const primePreservationScale = clearedHeadLaggardEscape ? 0.04 : 1;
  const safetyCompatible = trapBefore < 240 || (
    Number(features.trapDelta || 0) >= 0
    && Number(features.fenceClosureDelta || 0) >= 0
    && Number(features.escapeGatewayDelta || 0) >= 0
  );
  const establishedPrime = primeRunAfter >= 4 || primeRunBefore >= 4;
  const constructivePressure = attackPressure
    * (establishedPrime ? 1 : 0.18)
    * (safetyCompatible ? 1 : 0.12);
  const preservationPressure = attackPressure
    * Math.max(0.55, 1 / (1 + trapBefore / 1800));
  let score = 0;

  score += primeGain * (primeGain >= 0
    ? 42000 * constructivePressure
    : 90000 * preservationPressure * primePreservationScale);
  score += blockGain * (blockGain >= 0
    ? 360000 * constructivePressure
    : 620000 * preservationPressure * primePreservationScale);
  score += runPowerGain * 260000
    * (runPowerGain >= 0
      ? constructivePressure
      : preservationPressure * primePreservationScale);
  if (
    effectivePrimeRunBefore >= 4
    && effectivePrimeRunAfter < effectivePrimeRunBefore
  ) {
    score -= (effectivePrimeRunBefore - effectivePrimeRunAfter)
      * (24000000 + opponentHead * 2600000)
      * preservationPressure
      * primePreservationScale;
  }
  if (
    safetyCompatible
    && effectivePrimeRunBefore < 6
    && effectivePrimeRunAfter >= 6
    && Number(features.primeScoreAfter || 0) > 0
  ) {
    score += 180000000 * constructivePressure;
  } else if (
    effectivePrimeRunAfter === 5
    && effectivePrimeRunAfter > effectivePrimeRunBefore
  ) {
    score += 52000000 * constructivePressure;
  }
  if (
    opponentHead >= 5
    && Number(features.homeEntryMoves || 0) > 0
    && (
      effectivePrimeRunAfter < 4
      || (primeGain <= 0 && blockGain <= 0)
    )
  ) {
    score -= Number(features.homeEntryMoves)
      * (9000000 + opponentHead * 1800000);
  }
  if (
    maxRouteTowerAfter >= 6
    && routeTowerDelta < 0
    && primeGain <= 0
  ) {
    score -= Math.pow(maxRouteTowerAfter - 5, 2) * 18000000;
  }
  if (
    maxRouteTowerAfter >= 5
    && routeTowerDelta < 0
    && ownHead > 0
    && opponentFenceRun >= 2
    && primeGain <= 0
  ) {
    const latentTrapPressure = 18000000
      + ownHead * 2000000
      + opponentFenceRun * 10000000
      + Math.min(20000000, trapBefore * 12000);
    score -= Math.pow(maxRouteTowerAfter - 4, 2) * latentTrapPressure;
  }
  if (lateRouteRace && !activeLockBreak) {
    score += outsidePipGain * 4000000;
    score -= homeShuffleMoves * 8000000;
  }
  return score;
}

function advancedStateMetrics(state, color) {
  return {
    primeScore: blockingPrimeScore(state, color),
    primeRun: blockingPrimeRun(state, color),
    opponentMoveBlock: opponentMoveBlockScore(state, color),
    latentFenceExposure: latentFenceExposure(state, color),
  };
}

function advancedSequenceStats(beforeMetrics, after, color) {
  const primeScoreAfter = blockingPrimeScore(after, color);
  const opponentMoveBlockAfter = opponentMoveBlockScore(after, color);
  const latentFenceExposureAfter = latentFenceExposure(after, color);
  return {
    primeScoreBefore: beforeMetrics.primeScore,
    primeScoreAfter,
    primeScoreGain: primeScoreAfter - beforeMetrics.primeScore,
    primeRunBefore: beforeMetrics.primeRun,
    primeRunAfter: blockingPrimeRun(after, color),
    opponentMoveBlockBefore: beforeMetrics.opponentMoveBlock,
    opponentMoveBlockAfter,
    opponentMoveBlockGain: opponentMoveBlockAfter - beforeMetrics.opponentMoveBlock,
    latentFenceExposureBefore: beforeMetrics.latentFenceExposure,
    latentFenceExposureAfter,
    latentFenceExposureDelta: beforeMetrics.latentFenceExposure - latentFenceExposureAfter,
  };
}

function advancedTacticalAdjustment(state, color, candidate) {
  const tactical = candidate.tactical;
  if (!tactical) return 0;
  const opponent = opponentOf(color);
  const opponentHead = headCheckers(state, opponent);
  const opponentOutside = outsideHomeCount(state, opponent);
  const raceDebt = pipsFor(state, color) - pipsFor(state, opponent);
  const pressure = Math.min(3, 1
    + Math.max(0, raceDebt) / 90
    + Math.max(0, opponentHead - 3) / 10);
  let score = 0;
  score += (Number(tactical.blockedProbability) || 0) * 95000000 * pressure;
  score -= (Number(tactical.expectedOpponentPipGain) || 0) * 520000 * pressure;
  score -= (Number(tactical.expectedOpponentHeadRelease) || 0)
    * (16000000 + opponentHead * 2400000)
    * pressure;
  score -= (Number(tactical.expectedOpponentOutsideReduction) || 0)
    * (7000000 + Math.max(0, 8 - opponentOutside) * 1800000);
  score -= Math.log1p(Number(tactical.expectedReplySequences) || 0) * 1800000 * pressure;
  return score;
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
  if (!hasRouteContinuityPriorityContext(state, color, selected)) return ranked;

  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const selectedProgress = Number(selected.features.outsidePipGain) || 0;
  const selectedDebt = Number(selected.features.laggardDebtDelta) || 0;
  const continuing = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.outsideReduction || 0) >= selectedEntry
    && Number(candidate.features.outsidePipGain || 0) > selectedProgress
    && (
      Number(candidate.features.laggardDebtDelta || 0) >= selectedDebt
      || Number(candidate.features.startZoneReduction || 0)
        > Number(selected.features.startZoneReduction || 0)
    )
    && isSafeRouteContinuityAlternative(candidate, selected)
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

export function prioritizeLatentTrapDistribution(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected
    || homeReady(state, color)
    || headCheckers(state, color) < 4
    || Number(selected.features.opponentFenceRunBefore || 0) < 3
    || Number(selected.features.trapBefore || 0) < 120
    || Number(selected.features.maxRouteTowerAfter || 0) < 5
    || Number(selected.features.primeScoreGain || 0) > 0
    || Number(selected.features.opponentMoveBlockGain || 0) > 0
  ) {
    return ranked;
  }

  const selectedTower = Number(selected.features.maxRouteTowerAfter) || 0;
  const selectedDistribution = Number(selected.features.distributionDelta) || 0;
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && candidate.tactical
    && selected.tactical
    && Number(candidate.score) >= Number(selected.score) - 240000000
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 30000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) - 65000000
    && Number(candidate.features.maxRouteTowerAfter || 0) < selectedTower
    && Number(candidate.features.distributionDelta || 0) > selectedDistribution
    && Number(candidate.features.headGain || 0) >= Number(selected.features.headGain || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      >= Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.outsideDevelopmentMoves || 0)
      >= Number(selected.features.outsideDevelopmentMoves || 0)
    && Number(candidate.features.headLandingBreak || 0)
      <= Number(selected.features.headLandingBreak || 0) + 24
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0) - 10
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0) - 40
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(left.features.maxRouteTowerAfter || 0)
      - Number(right.features.maxRouteTowerAfter || 0)
    || Number(right.features.distributionDelta || 0)
      - Number(left.features.distributionDelta || 0)
    || Number(right.tactical?.worstImpact || 0)
      - Number(left.tactical?.worstImpact || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'latentTrapDistributionAdjustment');
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
  reserved.features.homeEntryTacticalReservation = 1;
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

export function reserveRouteContinuityForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  const selected = ranked[0];
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  if (
    ranked.length <= slotCount
    || !hasRouteContinuityPriorityContext(state, color, selected)
  ) {
    return ranked;
  }

  const selectedEntry = Number(selected.features.outsideReduction) || 0;
  const selectedProgress = Number(selected.features.outsidePipGain) || 0;
  const selectedDebt = Number(selected.features.laggardDebtDelta) || 0;
  const continuing = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.outsideReduction || 0) >= selectedEntry
    && Number(candidate.features.outsidePipGain || 0) > selectedProgress
    && (
      Number(candidate.features.laggardDebtDelta || 0) >= selectedDebt
      || Number(candidate.features.startZoneReduction || 0)
        > Number(selected.features.startZoneReduction || 0)
    )
    && isPlausibleRouteContinuityAlternative(candidate, selected)
  ));
  if (!continuing.length) return ranked;

  continuing.sort((left, right) => (
    Number(right.score) - Number(left.score)
    || Number(right.features.startZoneReduction || 0)
      - Number(left.features.startZoneReduction || 0)
    || Number(right.features.outsideReduction || 0)
      - Number(left.features.outsideReduction || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
  ));
  continuing[0].features.routeContinuityTacticalReservation = 1;
  return reorderTacticalReservations(ranked, slotCount);
}

export function reserveDevelopingFenceEscapeForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  const selected = ranked[0];
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  const fenceRun = Number(selected?.features.opponentFenceRunBefore) || 0;
  const hasLatentRearEscape = Boolean(selected) && ranked.some(candidate => (
    candidate !== selected
    && Number(candidate.features.startZoneReduction || 0)
      > Number(selected.features.startZoneReduction || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      > Number(selected.features.latentFenceExposureDelta || 0)
  ));
  const hasContestedHeadExit = Boolean(selected) && ranked.some(candidate => (
    candidate !== selected
    && isPlausibleContestedOpponentHeadExit(state, color, candidate, selected)
  ));
  if (
    !selected
    || homeReady(state, color)
    || (fenceRun < 2 && !hasLatentRearEscape && !hasContestedHeadExit)
  ) {
    return ranked;
  }

  const selectedUtility = fenceEscapeUtility(selected);
  const frontier = Array.from(new Set([
    ...safetyFenceCandidatePool(ranked, selected),
    ...ranked.filter(candidate => isPlausibleContestedOpponentHeadExit(
      state,
      color,
      candidate,
      selected,
    )),
    ...ranked.filter(candidate => isPlausibleImminentHeadFenceAnchor(
      state,
      color,
      candidate,
      selected,
    )),
  ])).filter((candidate) => {
    const contestedHeadExit = isPlausibleContestedOpponentHeadExit(
      state,
      color,
      candidate,
      selected,
    );
    return candidate !== selected
      && (contestedHeadExit || fenceEscapeUtility(candidate) > selectedUtility + 1)
      && Number(candidate.features.maxRouteTowerAfter || 0)
        <= Number(selected.features.maxRouteTowerAfter || 0) + 1
      && Number(candidate.features.homeShuffleMoves || 0)
        <= Number(selected.features.homeShuffleMoves || 0)
      && (
        contestedHeadExit
        || (
          Number(candidate.score) >= Number(selected.score) - 260000000
          && Number(candidate.features.primeRunAfter || 0)
            >= Number(selected.features.primeRunAfter || 0)
        )
        || isPlausibleCriticalHeadFenceEscape(state, color, candidate, selected)
        || isPlausibleLatentRearFenceEscape(candidate, selected)
      );
  });
  if (!frontier.length) return ranked;

  frontier.sort((left, right) => (
    Number(isPlausibleContestedOpponentHeadExit(state, color, right, selected))
      - Number(isPlausibleContestedOpponentHeadExit(state, color, left, selected))
    || Number(isPlausibleImminentHeadFenceAnchor(state, color, right, selected))
      - Number(isPlausibleImminentHeadFenceAnchor(state, color, left, selected))
    || Number(isPlausibleLatentRearFenceEscape(right, selected))
      - Number(isPlausibleLatentRearFenceEscape(left, selected))
    || fenceEscapeUtility(right) - fenceEscapeUtility(left)
    || Number(right.features.fenceClosureDelta || 0)
      - Number(left.features.fenceClosureDelta || 0)
    || Number(right.score) - Number(left.score)
  ));
  frontier[0].features.fenceEscapeTacticalReservation = 1;
  if (isPlausibleContestedOpponentHeadExit(state, color, frontier[0], selected)) {
    frontier[0].features.contestedHeadExitTacticalReservation = 1;
  }
  if (ranked.length <= slotCount) return ranked;
  return reorderTacticalReservations(ranked, slotCount);
}

function reorderTacticalReservations(ranked, limit) {
  if (!ranked.length) return ranked;
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  const selected = ranked[0];
  const reservations = ranked.filter(candidate => (
    candidate !== selected
    && (
      Number(candidate.features.homeEntryTacticalReservation || 0) > 0
      || Number(candidate.features.routeContinuityTacticalReservation || 0) > 0
      || Number(candidate.features.fenceEscapeTacticalReservation || 0) > 0
    )
  ));
  if (!reservations.length) return ranked;

  reservations.sort((left, right) => (
    tacticalReservationPriority(left) - tacticalReservationPriority(right)
    || Number(right.score) - Number(left.score)
  ));
  const reserved = uniqueCandidatePositions(reservations).slice(0, slotCount - 1);
  const reservedSet = new Set(reserved);
  const leading = [selected];
  const leadingPositions = new Set([
    candidatePositionKey(selected),
    ...reserved.map(candidatePositionKey),
  ]);
  for (const candidate of ranked) {
    if (candidate === selected || reservedSet.has(candidate)) continue;
    const position = candidatePositionKey(candidate);
    if (leadingPositions.has(position)) continue;
    if (leading.length >= slotCount - reserved.length) break;
    leading.push(candidate);
    leadingPositions.add(position);
  }
  const prioritized = [...leading, ...reserved];
  const prioritizedSet = new Set(prioritized);
  return [...prioritized, ...ranked.filter(candidate => !prioritizedSet.has(candidate))];
}

function tacticalReservationPriority(candidate) {
  if (Number(candidate.features.homeEntryTacticalReservation || 0) > 0) return 1;
  if (Number(candidate.features.routeContinuityTacticalReservation || 0) > 0) return 2;
  return 3;
}

function uniqueCandidatePositions(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = candidatePositionKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidatePositionKey(candidate) {
  if (!candidate?.after) return `candidate:${String(candidate?.id || '')}`;
  const points = Object.entries(candidate.after.points || {})
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([point, stack]) => `${point}:${stack.color}:${stack.count}`)
    .join('|');
  return `${points}|${Number(candidate.after.off?.white) || 0}:${Number(candidate.after.off?.dark) || 0}`;
}

function hasRouteContinuityPriorityContext(state, color, selected) {
  return Boolean(selected)
    && !homeReady(state, color)
    && headCheckers(state, color) === 0
    && outsideHomeCount(state, color) > 0
    && Number(selected.features.homeShuffleMoves || 0) > 0;
}

function isPlausibleRouteContinuityAlternative(candidate, selected) {
  const progressGain = Math.max(
    0,
    Number(candidate.features.outsidePipGain || 0)
      - Number(selected.features.outsidePipGain || 0),
  );
  const scoreTolerance = Math.min(96000000, 12000000 + progressGain * 12000000);
  const gatewayTolerance = Math.min(4, Math.max(1.25, progressGain * 0.4));
  return Number(candidate.score) >= Number(selected.score) - scoreTolerance
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0) - 2
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0) - gatewayTolerance
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1;
}

function isSafeRouteContinuityAlternative(candidate, selected) {
  if (
    !candidate.tactical
    || !selected.tactical
    || !isPlausibleRouteContinuityAlternative(candidate, selected)
  ) {
    return false;
  }
  const progressGain = Math.max(
    0,
    Number(candidate.features.outsidePipGain || 0)
      - Number(selected.features.outsidePipGain || 0),
  );
  return Number(candidate.tactical.expectedImpact) >= (
    Number(selected.tactical.expectedImpact) - (1000000 + progressGain * 1000000)
  )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - (2000000 + progressGain * 4000000)
    );
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
  const totalScoreTolerance = 2000000;
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

function prioritizeDevelopingFenceEscape(state, color, ranked) {
  if (!ranked.length || homeReady(state, color)) return ranked;
  const selected = ranked[0];
  const fenceRun = Math.max(...ranked.map(
    candidate => Number(candidate.features.opponentFenceRunBefore) || 0,
  ));
  const closureBefore = Math.max(...ranked.map(
    candidate => Number(candidate.features.fenceClosureBefore) || 0,
  ));
  const selectedUtility = fenceEscapeUtility(selected);
  const frontier = safetyFenceCandidatePool(ranked, selected);
  const maxEscapeUtility = Math.max(...frontier.map(fenceEscapeUtility));
  const latentRearEscape = frontier.some(candidate => isLatentRearFenceEscape(
    candidate,
    selected,
  ));
  const developingFenceIsCritical = (fenceRun >= 2 || latentRearEscape)
    && (
      closureBefore >= 12
      || Number(selected.features.fenceClosureDelta || 0) < 0
      || latentRearEscape
    )
    && maxEscapeUtility > selectedUtility + 1;
  if (!developingFenceIsCritical) return ranked;

  const escapeFloor = selectedUtility + Math.max(1, (maxEscapeUtility - selectedUtility) * 0.72);
  const escaping = frontier.filter(candidate => (
    candidate !== selected
    && (
      (
        fenceEscapeUtility(candidate) >= escapeFloor
        && (
          isComparableFenceEscape(candidate, selected)
          || isCriticalHeadFenceEscape(state, color, candidate, selected)
        )
      )
      || isLatentRearFenceEscape(candidate, selected)
    )
  ));
  if (!escaping.length) return ranked;

  escaping.sort((left, right) => (
    Number(isLatentRearFenceEscape(right, selected))
      - Number(isLatentRearFenceEscape(left, selected))
    || fenceEscapeUtility(right) - fenceEscapeUtility(left)
    || Number(right.features.fenceClosureDelta || 0)
      - Number(left.features.fenceClosureDelta || 0)
    || Number(right.score) - Number(left.score)
  ));
  if (isExperienceOverruledFenceEscape(escaping[0], selected)) {
    escaping[0].features.experienceSafetyOverride = 1;
  }
  return promoteCandidate(
    ranked,
    escaping[0],
    'developingFenceEscapeAdjustment',
  );
}

function prioritizeContestedOpponentHeadExit(state, color, ranked) {
  const selected = ranked[0];
  if (!selected) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedContestedOpponentHeadExit(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.tactical.worstImpact || 0)
      - Number(left.tactical.worstImpact || 0)
    || Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'contestedOpponentHeadExitAdjustment',
  );
  promoted[0].features.contestedOpponentHeadExit = 1;
  return promoted;
}

function prioritizeImminentHeadFenceAnchor(state, color, ranked) {
  const selected = ranked[0];
  if (!selected) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedImminentHeadFenceAnchor(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.features.latentFenceExposureDelta || 0)
      - Number(left.features.latentFenceExposureDelta || 0)
    || Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'imminentHeadFenceEscapeAdjustment',
  );
  promoted[0].features.imminentHeadFenceEscape = 1;
  return promoted;
}

function safetyParetoFrontier(ranked) {
  return ranked.filter(candidate => !ranked.some(other => (
    other !== candidate
    && safetyDominates(other, candidate)
  )));
}

function safetyFenceCandidatePool(ranked, selected) {
  return Array.from(new Set([
    ...safetyParetoFrontier(ranked),
    ...ranked.filter(candidate => (
      candidate !== selected
      && isPlausibleLatentRearFenceEscape(candidate, selected)
    )),
  ]));
}

function safetyDominates(left, right) {
  const leftTrap = Number(left.features.trapDelta) || 0;
  const rightTrap = Number(right.features.trapDelta) || 0;
  const leftFence = Number(left.features.fenceClosureDelta) || 0;
  const rightFence = Number(right.features.fenceClosureDelta) || 0;
  const leftGateway = Number(left.features.escapeGatewayDelta) || 0;
  const rightGateway = Number(right.features.escapeGatewayDelta) || 0;
  const leftLatent = Number(left.features.latentFenceExposureDelta) || 0;
  const rightLatent = Number(right.features.latentFenceExposureDelta) || 0;
  return leftTrap >= rightTrap
    && leftFence >= rightFence
    && leftGateway >= rightGateway
    && leftLatent >= rightLatent
    && (
      leftTrap > rightTrap
      || leftFence > rightFence
      || leftGateway > rightGateway
      || leftLatent > rightLatent
    );
}

function fenceEscapeUtility(candidate) {
  return (Number(candidate.features.trapDelta) || 0) * 2
    + (Number(candidate.features.fenceClosureDelta) || 0)
    + (Number(candidate.features.escapeGatewayDelta) || 0) * 4
    + (Number(candidate.features.latentFenceExposureDelta) || 0) * 6;
}

function newlyBlockedOpponentHeadLanding(state, color, candidate, selected) {
  if (!candidate?.after || !selected?.after) return false;
  const opponent = opponentOf(color);
  const landingPoints = new Set(pathFor(opponent).slice(1, 7).map(Number));
  return candidate.sequence?.some(move => {
    const target = Number(move.to);
    return !move.bearOff
      && landingPoints.has(target)
      && colorAt(candidate.after, target) === color
      && colorAt(selected.after, target) !== color;
  });
}

function hasFiniteTacticalMetrics(candidate, keys) {
  return keys.every((key) => (
    candidate?.tactical?.[key] !== null
    && candidate?.tactical?.[key] !== undefined
    && Number.isFinite(Number(candidate.tactical[key]))
  ));
}

export function isPlausibleContestedOpponentHeadExit(state, color, candidate, selected) {
  const opponent = opponentOf(color);
  return headCheckers(state, opponent) >= 4
    && newlyBlockedOpponentHeadLanding(state, color, candidate, selected)
    && Number(candidate.features.outsideReduction || 0)
      > Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.headLandingBreak || 0)
      <= Number(selected.features.headLandingBreak || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0) - 1
    && scoreWithoutExperience(candidate) >= (
      scoreWithoutExperience(selected) - CONTESTED_HEAD_EXIT_SCORE_TOLERANCE
    );
}

export function isAnalyzedContestedOpponentHeadExit(state, color, candidate, selected) {
  if (
    !candidate?.tactical
    || !selected?.tactical
    || !isPlausibleContestedOpponentHeadExit(state, color, candidate, selected)
    || !hasFiniteTacticalMetrics(candidate, [
      'plies',
      'expectedImpact',
      'worstImpact',
      'recoveryWorst',
      'continuationExpected',
      'continuationWorst',
    ])
    || !hasFiniteTacticalMetrics(selected, [
      'plies',
      'expectedImpact',
      'worstImpact',
      'recoveryWorst',
      'continuationExpected',
      'continuationWorst',
    ])
  ) {
    return false;
  }
  return Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.plies || 0) >= 4
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) + 10000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) + 30000000
    && Number(candidate.tactical.recoveryWorst || 0)
      >= Number(selected.tactical.recoveryWorst || 0) + 30000000
    && Number(candidate.tactical.continuationExpected || 0)
      >= Number(selected.tactical.continuationExpected || 0) + 10000000
    && Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.continuationWorst || 0) + 15000000;
}

export function isPlausibleImminentHeadFenceAnchor(state, color, candidate, selected) {
  const headRemaining = headCheckers(state, color);
  const fenceRun = immediateHeadFenceRun(state, color);
  const head = headPoint(color);
  const anchorsBeyondFence = candidate.sequence?.some(move => (
    Number(move.from) === Number(head)
    && pathPos(color, Number(move.to)) === fenceRun + 1
  ));
  return headRemaining >= 3
    && headRemaining <= 6
    && fenceRun >= 3
    && fenceRun <= 5
    && Number(selected.features.headGain || 0) === 0
    && Number(candidate.features.headGain || 0) > 0
    && anchorsBeyondFence
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0) + 24
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.fenceClosureDelta || 0) >= -4
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0) - 4
    && Number(candidate.features.headLandingBreak || 0)
      <= Number(selected.features.headLandingBreak || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && scoreWithoutExperience(candidate) >= (
      scoreWithoutExperience(selected) - IMMINENT_HEAD_FENCE_SCORE_TOLERANCE
    );
}

export function isAnalyzedImminentHeadFenceAnchor(state, color, candidate, selected) {
  if (
    !candidate.tactical
    || !selected.tactical
    || !isPlausibleImminentHeadFenceAnchor(state, color, candidate, selected)
  ) {
    return false;
  }
  return Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.plies || 0) >= 4
    && Number(candidate.tactical.continuationExpected || 0)
      >= Number(selected.tactical.continuationExpected || 0)
    && Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.continuationWorst || 0);
}

function isPlausibleCriticalHeadFenceEscape(state, color, candidate, selected) {
  return headCheckers(state, color) >= 7
    && Number(selected.features.opponentFenceRunBefore || 0) >= 2
    && Number(selected.features.fenceClosureDelta || 0) < 0
    && Number(candidate.features.fenceClosureDelta || 0) >= 0
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0) - 4
    && Number(candidate.features.headGain || 0)
      >= Number(selected.features.headGain || 0)
    && Number(candidate.features.headLandingBreak || 0) <= 70
    && Number(candidate.features.primeRunAfter || 0) >= 1;
}

function isCriticalHeadFenceEscape(state, color, candidate, selected) {
  if (
    !candidate.tactical
    || !selected.tactical
    || !isPlausibleCriticalHeadFenceEscape(state, color, candidate, selected)
  ) {
    return false;
  }
  return Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - 15000000
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - 15000000
    );
}

function isLatentRearFenceEscape(candidate, selected) {
  if (
    !candidate?.tactical
    || !selected?.tactical
    || !isPlausibleLatentRearFenceEscape(candidate, selected)
  ) {
    return false;
  }
  return Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - 10000000
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - 15000000
    );
}

function isPlausibleLatentRearFenceEscape(candidate, selected) {
  return Number(candidate.features.startZoneReduction || 0)
    > Number(selected.features.startZoneReduction || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      > Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && preservesLatentEscapePrime(candidate, selected)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && scoreWithoutExperience(candidate) >= (
      scoreWithoutExperience(selected) - LATENT_REAR_ESCAPE_SCORE_TOLERANCE
    );
}

function preservesLatentEscapePrime(candidate, selected) {
  const candidateRun = Number(candidate.features.primeRunAfter || 0);
  const selectedRun = Number(selected.features.primeRunAfter || 0);
  if (candidateRun >= selectedRun) return true;

  const primeRunBefore = Math.max(
    Number(candidate.features.primeRunBefore || 0),
    Number(selected.features.primeRunBefore || 0),
  );
  const activeBlockingPrime = primeRunBefore >= 4
    && Number(candidate.features.primeScoreBefore || 0) > 0
    && Number(candidate.features.opponentMoveBlockBefore || 0) > 0;
  return !activeBlockingPrime && candidateRun >= Math.max(1, selectedRun - 1);
}

function scoreWithoutExperience(candidate) {
  return Number(candidate.score) - Number(candidate.experienceAdjustment || 0);
}

export function annotateAvoidableHomeShuffles(ranked) {
  ranked.forEach((candidate) => {
    const homeShuffleMoves = Math.max(
      0,
      Number(candidate.features.homeShuffleMoves) || 0,
    );
    if (!homeShuffleMoves) {
      candidate.features.avoidableHomeShuffleMoves = 0;
      return;
    }

    const alternatives = ranked.filter(other => (
      other !== candidate
      && Number(other.features.homeShuffleMoves || 0) < homeShuffleMoves
      && Number(other.features.outsideReduction || 0)
        >= Number(candidate.features.outsideReduction || 0)
      && Number(other.features.outsidePipGain || 0)
        >= Number(candidate.features.outsidePipGain || 0)
      && Number(other.features.trapDelta || 0)
        >= Number(candidate.features.trapDelta || 0)
      && Number(other.features.fenceClosureDelta || 0)
        >= Number(candidate.features.fenceClosureDelta || 0)
      && Number(other.features.escapeGatewayDelta || 0)
        >= Number(candidate.features.escapeGatewayDelta || 0)
      && Number(other.features.latentFenceExposureDelta || 0)
        >= Number(candidate.features.latentFenceExposureDelta || 0)
      && Number(other.features.routeTowerDelta || 0)
        >= Number(candidate.features.routeTowerDelta || 0)
      && Number(other.features.maxRouteTowerAfter || 0)
        <= Number(candidate.features.maxRouteTowerAfter || 0)
      && Number(other.features.headGain || 0)
        >= Number(candidate.features.headGain || 0)
      && Number(other.features.startZoneReduction || 0)
        >= Number(candidate.features.startZoneReduction || 0)
      && Number(other.features.primeRunAfter || 0)
        >= Number(candidate.features.primeRunAfter || 0)
      && Number(other.features.primeScoreAfter || 0)
        >= Number(candidate.features.primeScoreAfter || 0)
      && Number(other.features.opponentMoveBlockAfter || 0)
        >= Number(candidate.features.opponentMoveBlockAfter || 0)
    ));
    const minimumNecessary = alternatives.length
      ? Math.min(...alternatives.map(other => Number(other.features.homeShuffleMoves) || 0))
      : homeShuffleMoves;
    candidate.features.avoidableHomeShuffleMoves = Math.max(
      0,
      homeShuffleMoves - minimumNecessary,
    );
  });
  return ranked;
}

export function isComparableFenceEscape(candidate, selected) {
  if (!candidate?.tactical || !selected?.tactical) return false;
  const experienceSafetyOverride = isExperienceOverruledFenceEscape(candidate, selected);
  return Number(candidate.score) >= Number(selected.score) - 260000000
    && (
      Number(candidate.experienceAdjustment || 0) >= (
        Number(selected.experienceAdjustment || 0) - 500000
      )
      || experienceSafetyOverride
    )
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.expectedImpact) >= (
      Number(selected.tactical.expectedImpact) - 3000000
    )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - 30000000
    )
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.headLandingBreak || 0)
      <= Number(selected.features.headLandingBreak || 0) + 12;
}

export function isExperienceOverruledFenceEscape(candidate, selected) {
  const requiredTacticalMetrics = [
    'plies',
    'expectedImpact',
    'worstImpact',
    'recoveryExpected',
    'recoveryWorst',
  ];
  if (
    !candidate?.tactical
    || !selected?.tactical
    || !hasFiniteTacticalMetrics(candidate, requiredTacticalMetrics)
    || !hasFiniteTacticalMetrics(selected, requiredTacticalMetrics)
  ) return false;
  return Number(candidate.features.fenceEscapeTacticalReservation || 0) > 0
    && Number(candidate.experienceAdjustment || 0)
      < Number(selected.experienceAdjustment || 0) - 500000
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      > Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.plies || 0) >= 4
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) + 10000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) + 30000000
    && Number(candidate.tactical.recoveryExpected || 0)
      >= Number(selected.tactical.recoveryExpected || 0)
    && Number(candidate.tactical.recoveryWorst || 0)
      >= Number(selected.tactical.recoveryWorst || 0);
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
