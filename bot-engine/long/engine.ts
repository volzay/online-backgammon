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
  escapeGatewayRisk,
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
  prospectiveFenceExtensionRisk,
  primeCrunchRisk,
  primeSustainability,
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
  let selectedExperiencePatterns = [];
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

    const candidates = prefilterSequences(adapter, state, color, sequences, maxCandidates);
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
    annotateAvoidableHomeShuffles(ranked, state, color);
    ranked.forEach((candidate) => {
      candidate.experience = experienceDescriptor(state, color, candidate.features);
      // Learned outcomes must not decide which moves receive tactical analysis.
      // Keep the descriptor for telemetry, then apply experience only after the
      // cold strategy and reply search establish a safety baseline.
      candidate.experienceAdjustment = 0;
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
    strategicallyRanked = reserveStructuralIntegrityForTacticalAnalysis(
      state,
      color,
      strategicallyRanked,
    );
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
    strategicallyRanked = reservePrimeSustainabilityForTacticalAnalysis(
      state,
      color,
      strategicallyRanked,
    );
    const outside = outsideHomeCount(state, color);
    const trapPressure = opponentTrapRisk(state, color);
    const maxEntry = Math.max(...strategicallyRanked.map(
      candidate => Number(candidate.features.outsideReduction) || 0,
    ));
    const fenceRun = Math.max(...strategicallyRanked.map(
      candidate => Number(candidate.features.opponentFenceRunBefore) || 0,
    ));
    const nonSevereTowerCandidates = fenceRun >= 5
      ? strategicallyRanked.filter(candidate => Number(candidate.features.maxRouteTowerAfter) < 7)
      : [];
    const hasSevereTowerCandidate = strategicallyRanked.some(
      candidate => Number(candidate.features.maxRouteTowerAfter) >= 7,
    );
    let strategicallyEligible = hasSevereTowerCandidate && nonSevereTowerCandidates.length
      ? nonSevereTowerCandidates
      : trapPressure > 850 && outside <= 8 && maxEntry > 0 && fenceRun < 4
        ? strategicallyRanked.filter(
          candidate => Number(candidate.features.outsideReduction) === maxEntry,
        )
        : strategicallyRanked;
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
        candidate => Number(candidate.features.headGain || 0) === maxHeadRelease
          || Number(candidate.features.structuralIntegrityTacticalReservation || 0) > 0,
      );
    }
    if (fenceRun >= 5) {
      const gateways = criticalFenceGatewayPoints(state, color);
      if (gateways.length) {
        const preserving = strategicallyEligible.filter(candidate => gateways.every(
          point => colorAt(candidate.after, point) === color,
        ));
        if (preserving.length) strategicallyEligible = preserving;
      }
      const maxSafeEntry = Math.max(...strategicallyEligible.map(
        candidate => Number(candidate.features.outsideReduction) || 0,
      ));
      if (maxSafeEntry > 0) {
        strategicallyEligible = strategicallyEligible.filter(
          candidate => Number(candidate.features.outsideReduction) === maxSafeEntry,
        );
      }
    }
    // Tactical work is intentionally delayed until every structural policy has
    // selected its shortlist. Otherwise the budget can be spent on candidates
    // which are later discarded, leaving the actual move without dice analysis.
    const tacticalPool = tacticalCoveragePool(strategicallyEligible, strategicallyRanked);
    const advancedTacticallyAdjusted = new Set();
    const applyAdvancedTacticalAdjustment = (candidate) => {
      if (!advancedStrategy || advancedTacticallyAdjusted.has(candidate)) return;
      const adjustment = advancedTacticalAdjustment(state, color, candidate);
      candidate.features.advancedTacticalAdjustment = adjustment;
      candidate.score += adjustment;
      advancedTacticallyAdjusted.add(candidate);
    };
    const tacticallyRanked = analyzeOpponentReplies(
      adapter,
      color,
      tacticalPool,
      weights,
      budget,
      {
        expandDoubles: advancedStrategy,
        beforeDeepCandidate: advancedStrategy
          ? applyAdvancedTacticalAdjustment
          : null,
        beforeDeepSelection: advancedStrategy
          ? (primaryCandidates) => {
            let reprioritized = [...primaryCandidates]
              .sort((left, right) => right.score - left.score);
            reprioritized = reserveStructuralIntegrityForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
            reprioritized = reserveHomeEntryForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
            reprioritized = reserveRouteContinuityForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
            reprioritized = reserveDevelopingFenceEscapeForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
            return reservePrimeSustainabilityForTacticalAnalysis(
              state,
              color,
              reprioritized,
            );
          }
          : null,
      },
    );
    if (advancedStrategy) {
      tacticallyRanked.forEach(applyAdvancedTacticalAdjustment);
      tacticallyRanked.sort((left, right) => right.score - left.score);
    }
    const deeplyAnalyzedCandidates = strategicallyEligible.filter(
      candidate => Number(candidate.tactical?.plies || 0) >= 4,
    );
    const analyzedCandidates = strategicallyEligible.filter(candidate => candidate.tactical);
    // Never promote an unchecked move merely because analyzed candidates
    // received realistic reply penalties. Prefer the adaptive four-ply beam;
    // fall back to complete primary analysis only when the deep budget ran out.
    let finalCandidates = deeplyAnalyzedCandidates.length
      ? deeplyAnalyzedCandidates
      : analyzedCandidates.length
        ? analyzedCandidates
      : strategicallyEligible;
    finalCandidates = prioritizeSevereReplySafety(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
    finalCandidates = prioritizeTacticallyDominantHomeProgress(
      state,
      color,
      finalCandidates.sort((left, right) => right.score - left.score),
    );
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
    let coldRanked = prioritizeCriticalClearedHeadLaggardEscape(
      state,
      color,
      prioritizeSevereReplySafety(
        state,
        color,
        prioritizeRouteContinuity(
          state,
          color,
          prioritizeTransitionBearOff(
            state,
            color,
            prioritizeAvailableHomeEntry(state, color, distributedCandidates),
          ),
        ),
      ),
    );
    coldRanked = prioritizeProspectiveFenceInterruption(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeProspectiveFenceAnchorSafety(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeProbabilisticFenceDenial(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeVerifiedDeepSafety(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeTacticallyEquivalentStructure(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeAvailableHomeEntry(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeAvoidableHomeShuffle(
      state,
      color,
      coldRanked,
    );
    coldRanked = prioritizeStructuralIntegrity(
      state,
      color,
      coldRanked,
    );
    annotateAvoidableProspectiveFenceInterruptions(state, color, coldRanked);
    annotateAvoidableProspectiveFenceAnchorMisses(state, color, coldRanked);
    const coldSelected = coldRanked[0];
    coldRanked.forEach((candidate) => {
      candidate.experience = experienceDescriptor(
        state,
        color,
        candidate.features,
        candidate.tactical,
      );
      candidate.experienceAdjustment = useExperience
        ? policyAwareExperienceAdjustment(
          candidate.experience,
          experience,
          candidate.score,
        )
        : 0;
      candidate.score += candidate.experienceAdjustment;
    });
    const finalRanked = prioritizeExperienceWithinSafetyEnvelope(
      coldRanked,
      coldSelected,
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
      selectedExperiencePatterns = selectExperiencePatterns(experienceSources);
      experience = normalizeExperiencePatterns(selectedExperiencePatterns);
      return experience.size;
    },
    experienceSize() {
      return experience.size;
    },
    experienceSnapshotEntries() {
      return Array.from(experience.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, pattern]) => [
          key,
          Number(pattern.samples) || 0,
          Number(pattern.losses) || 0,
          Number(pattern.wins) || 0,
          Number(pattern.lossWeight) || 0,
          Number(pattern.severeLosses) || 0,
          Number(pattern.signalWeight) || 0,
          Number(pattern.winWeight) || 0,
        ]);
    },
    experienceSnapshotPatterns() {
      return selectedExperiencePatterns.map(pattern => ({ ...pattern }));
    },
  };
}

function selectExperiencePatterns(sources) {
  const selected = new Map();
  sources.forEach((patterns, rawSource) => {
    const source = String(rawSource || 'runtime');
    const priority = experienceSourcePriority(source);
    (Array.isArray(patterns) ? patterns : []).forEach((pattern) => {
      const contextKey = String(pattern?.contextKey || pattern?.context_key || '');
      const actionKey = String(pattern?.actionKey || pattern?.action_key || '');
      if (!contextKey || !actionKey) return;
      const key = `${contextKey}::${actionKey}`;
      const current = selected.get(key);
      if (
        shouldReplaceExperiencePattern(current, { pattern, priority, source })
      ) {
        selected.set(key, { priority, source, patterns: [pattern] });
        return;
      }
      if (source === current.source) current.patterns.push(pattern);
    });
  });
  return Array.from(selected.values()).flatMap(entry => entry.patterns);
}

function shouldReplaceExperiencePattern(current, candidate) {
  if (!current) return true;
  const serverAndLocal = new Set([current.source, candidate.source]);
  if (
    serverAndLocal.size === 2
    && serverAndLocal.has('local')
    && (serverAndLocal.has('server') || serverAndLocal.has('server-cache'))
  ) {
    const currentTimestamp = Math.max(
      0,
      ...current.patterns.map(experiencePatternTimestamp),
    );
    const candidateTimestamp = experiencePatternTimestamp(candidate.pattern);
    if (currentTimestamp !== candidateTimestamp && (currentTimestamp || candidateTimestamp)) {
      return candidateTimestamp > currentTimestamp;
    }
  }
  return candidate.priority > current.priority
    || (candidate.priority === current.priority && candidate.source < current.source);
}

function experiencePatternTimestamp(pattern) {
  const timestamp = Date.parse(String(pattern?.updatedAt || pattern?.updated_at || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function experienceSourcePriority(source) {
  if (source === 'frozen-session') return 50;
  if (source === 'server') return 40;
  if (source === 'server-cache') return 30;
  if (source === 'local') return 20;
  return 10;
}

function tacticalCoveragePool(eligible, ranked) {
  const pool = [];
  const included = new Set();
  eligible.forEach((candidate) => {
    if (!candidate || included.has(candidate)) return;
    included.add(candidate);
    pool.push(candidate);
  });
  // A policy singleton may still receive a reference candidate, but references
  // must never displace eligible moves from the tactical/deep beam.
  ranked.forEach((candidate) => {
    if (pool.length >= 2 || !candidate || included.has(candidate)) return;
    included.add(candidate);
    pool.push(candidate);
  });
  return pool;
}

function normalizeAnalysisNodeBudget(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(number));
}

// A four-point lock is not a safe-race move merely because its checkers move
// forward. Conversely, keeping it must not suppress a verified static escape
// from our own rear exposure or a timing crunch. This grants score eligibility
// only; the ordinary bounded reply/deep safety checks still decide the move.
function isFourPrimeSelfEscape(features) {
  const required = [
    'primeRunBefore', 'primeRunAfter', 'outsidePipGain', 'homeShuffleMoves',
    'trapDelta', 'fenceClosureDelta', 'escapeGatewayDelta',
    'latentFenceExposureBefore', 'latentFenceExposureDelta',
    'prospectiveFenceExtensionBefore', 'prospectiveFenceExtensionDelta',
    'headLandingBreak', 'routeTowerDelta', 'startZoneReduction',
    'resultSafetyBefore', 'resultSafetyAfter', 'primeSustainabilityBefore',
    'primeSustainabilityDelta', 'primeCrunchRiskBefore', 'primeCrunchRiskDelta',
    'laggardDebtDelta',
  ];
  if (!features || !required.every(key => Number.isFinite(features[key]))) return false;
  if (
    features.primeRunBefore !== 4
    || !Number.isInteger(features.primeRunAfter)
    || features.primeRunAfter < 2
    || features.primeRunAfter > 4
    || features.outsidePipGain <= 0
    || features.homeShuffleMoves !== 0
    || features.trapDelta < 0
    || features.fenceClosureDelta < 0
    || features.escapeGatewayDelta < 0
    || features.latentFenceExposureDelta < 0
    || features.prospectiveFenceExtensionDelta < 0
    || features.headLandingBreak !== 0
    || features.routeTowerDelta < 0
    || features.resultSafetyAfter < features.resultSafetyBefore
  ) return false;

  const clearsExposedRear = features.primeRunAfter >= 3
    && features.latentFenceExposureBefore >= 24
    && features.latentFenceExposureDelta > 0
    && features.startZoneReduction > 0
    && features.resultSafetyAfter > features.resultSafetyBefore;
  // These timing thresholds are shared with prime-sustainability coverage,
  // rather than treating every lost blocker as an excuse to abandon a lock.
  const relievesSelfCrunch = features.primeSustainabilityBefore < 0.38
    && features.primeCrunchRiskBefore >= 0.45
    && features.primeSustainabilityDelta >= 0.06
    && features.primeCrunchRiskDelta >= 0.2
    && features.prospectiveFenceExtensionBefore >= 40
    && features.prospectiveFenceExtensionDelta >= 40
    && features.laggardDebtDelta > 0;
  return clearsExposedRear || relievesSelfCrunch;
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
  const activeLockBreak = effectivePrimeRunBefore >= 4
    && primeScoreBefore > 0
    && (
      effectivePrimeRunAfter < effectivePrimeRunBefore
      || primeScoreAfter < primeScoreBefore
      || blockGain < 0
    )
    && !(effectivePrimeRunBefore === 4 && isFourPrimeSelfEscape(features));
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
  const primeSustainabilityAfter = Math.max(
    0,
    Math.min(1, Number(features.primeSustainabilityAfter) || 0),
  );
  const primeCrunchRiskAfter = Math.max(0, Number(features.primeCrunchRiskAfter) || 0);
  const sustainabilityScale = primeRunAfter >= 4
    ? 0.16 + primeSustainabilityAfter * 0.84
    : 1;
  const constructivePressure = attackPressure
    * (establishedPrime ? 1 : 0.18)
    * (safetyCompatible ? 1 : 0.12)
    * sustainabilityScale;
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
  if (establishedPrime) {
    score += Number(features.primeSustainabilityDelta || 0) * 28000000;
    score += Number(features.primeCrunchRiskDelta || 0) * 18000000;
    score -= primeCrunchRiskAfter * 12000000;
  }
  return score;
}

function advancedStateMetrics(state, color) {
  return {
    primeScore: blockingPrimeScore(state, color),
    primeRun: blockingPrimeRun(state, color),
    opponentMoveBlock: opponentMoveBlockScore(state, color),
    latentFenceExposure: latentFenceExposure(state, color),
    prospectiveFenceExtension: prospectiveFenceExtensionRisk(state, color),
    primeSustainability: primeSustainability(state, color),
    primeCrunchRisk: primeCrunchRisk(state, color),
  };
}

function advancedSequenceStats(beforeMetrics, after, color) {
  const primeScoreAfter = blockingPrimeScore(after, color);
  const opponentMoveBlockAfter = opponentMoveBlockScore(after, color);
  const latentFenceExposureAfter = latentFenceExposure(after, color);
  const prospectiveFenceExtensionAfter = prospectiveFenceExtensionRisk(after, color);
  const primeSustainabilityAfter = primeSustainability(after, color);
  const primeCrunchRiskAfter = primeCrunchRisk(after, color);
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
    prospectiveFenceExtensionBefore: beforeMetrics.prospectiveFenceExtension,
    prospectiveFenceExtensionAfter,
    prospectiveFenceExtensionDelta: beforeMetrics.prospectiveFenceExtension
      - prospectiveFenceExtensionAfter,
    primeSustainabilityBefore: beforeMetrics.primeSustainability,
    primeSustainabilityAfter,
    primeSustainabilityDelta: primeSustainabilityAfter - beforeMetrics.primeSustainability,
    primeCrunchRiskBefore: beforeMetrics.primeCrunchRisk,
    primeCrunchRiskAfter,
    primeCrunchRiskDelta: beforeMetrics.primeCrunchRisk - primeCrunchRiskAfter,
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
  const primeRunAfter = Math.max(0, Number(candidate.features?.primeRunAfter) || 0);
  const primeSustainabilityAfter = Math.max(
    0,
    Math.min(1, Number(candidate.features?.primeSustainabilityAfter) || 0),
  );
  const primeCrunchRiskAfter = Math.max(
    0,
    Number(candidate.features?.primeCrunchRiskAfter) || 0,
  );
  const blockingValueScale = primeRunAfter >= 4
    ? 0.14 + primeSustainabilityAfter * 0.86
    : 1;
  let score = 0;
  score += (Number(tactical.blockedProbability) || 0)
    * 95000000
    * pressure
    * blockingValueScale;
  score -= (Number(tactical.expectedOpponentPipGain) || 0) * 520000 * pressure;
  score -= (Number(tactical.expectedOpponentHeadRelease) || 0)
    * (16000000 + opponentHead * 2400000)
    * pressure;
  score -= (Number(tactical.expectedOpponentOutsideReduction) || 0)
    * (7000000 + Math.max(0, 8 - opponentOutside) * 1800000);
  score -= Math.log1p(Number(tactical.expectedReplySequences) || 0) * 1800000 * pressure;
  if (primeRunAfter >= 4) score -= primeCrunchRiskAfter * 22000000 * pressure;
  return score;
}

function prioritizeSevereReplySafety(state, color, ranked) {
  const selected = ranked[0];
  if (!selected?.tactical || ranked.length < 2 || homeReady(state, color)) return ranked;
  const selectedDescriptor = experienceDescriptor(
    state,
    color,
    selected.features,
    selected.tactical,
  );

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && candidate.tactical
    && Number(candidate.features.headGain || 0) >= Number(selected.features.headGain || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(experienceDescriptor(
      state,
      color,
      candidate.features,
      candidate.tactical,
    ).riskSignal || 0) <= Number(selectedDescriptor.riskSignal || 0) - 2
    && Number(experienceDescriptor(
      state,
      color,
      candidate.features,
      candidate.tactical,
    ).mistakeSeverity || 0) <= Number(selectedDescriptor.mistakeSeverity || 0) - 1.5
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 5000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) + 30000000
    && (
      Number(candidate.tactical.continuationWorst || 0)
        >= Number(selected.tactical.continuationWorst || 0) - 15000000
      || (
        Math.min(
          Number(candidate.tactical.worstImpact || 0),
          Number(candidate.tactical.recoveryWorst || 0),
          Number(candidate.tactical.continuationWorst || 0),
        ) >= Math.min(
          Number(selected.tactical.worstImpact || 0),
          Number(selected.tactical.recoveryWorst || 0),
          Number(selected.tactical.continuationWorst || 0),
        ) + 30000000
        && Number(candidate.tactical.continuationTailRisk || 0)
          >= Number(selected.tactical.continuationTailRisk || 0) - 30000000
      )
    )
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.tactical.worstImpact || 0) - Number(left.tactical.worstImpact || 0)
    || Number(right.tactical.expectedImpact || 0) - Number(left.tactical.expectedImpact || 0)
    || Number(experienceDescriptor(
      state,
      color,
      left.features,
      left.tactical,
    ).riskSignal || 0) - Number(experienceDescriptor(
      state,
      color,
      right.features,
      right.tactical,
    ).riskSignal || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'severeReplySafetyAdjustment');
}

function prioritizeCriticalClearedHeadLaggardEscape(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected?.tactical
    || homeReady(state, color)
    || headCheckers(state, color) > 0
    || headCheckers(state, opponentOf(color)) > 0
    || Number(selected.features.trapBefore || 0) < 240
    || Number(selected.features.primeRunBefore || 0) < 5
  ) {
    return ranked;
  }

  const selectedDebt = Number(selected.features.laggardDebtDelta || 0);
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && candidate.tactical
    && Number(candidate.tactical.plies || 0) >= 4
    && Number(candidate.features.laggardDebtDelta || 0) >= Math.max(120, selectedDebt + 120)
    && Number(candidate.features.startZoneReduction || 0)
      > Number(selected.features.startZoneReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      > Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.homeEntryMoves || 0)
      <= Number(selected.features.homeEntryMoves || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.primeRunAfter || 0) >= 3
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 12000000
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 2000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) + 8000000
    && Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.continuationTailRisk || 0)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.features.laggardDebtDelta || 0)
      - Number(left.features.laggardDebtDelta || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || Number(right.tactical.worstImpact || 0)
      - Number(left.tactical.worstImpact || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(
    ranked,
    alternatives[0],
    'criticalLaggardEscapeAdjustment',
  );
}

function prioritizeTacticallyDominantHomeProgress(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected?.tactical
    || homeReady(state, color)
    || headCheckers(state, color) > 0
    || Number(selected.features.homeShuffleMoves || 0) <= 0
  ) {
    return ranked;
  }

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && candidate.tactical
    && Number(candidate.features.outsideReduction || 0)
      > Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    // Entering a checker can reduce the generic gateway metric even when all
    // analyzed reply branches improve, so tactical dominance is the gate here.
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0)
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0)
    && Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.continuationTailRisk || 0)
    && Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.continuationWorst || 0)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.features.outsideReduction || 0)
      - Number(left.features.outsideReduction || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.score) - Number(left.score)
  ));
  return promoteCandidate(ranked, alternatives[0], 'tacticalHomeProgressAdjustment');
}

function prioritizeTransitionBearOff(state, color, ranked) {
  if (homeReady(state, color) || outsideHomeCount(state, color) !== 1) return ranked;
  const maxEntry = Math.max(...ranked.map(
    candidate => Number(candidate.features.outsideReduction) || 0,
  ));
  if (maxEntry <= 0) return ranked;
  const entering = ranked.filter(
    candidate => Number(candidate.features.outsideReduction || 0) === maxEntry,
  );
  const maxOff = Math.max(...entering.map(candidate => Number(candidate.features.offGain) || 0));
  if (maxOff <= 0) return ranked;
  const finishing = entering.filter(candidate => (
    Number(candidate.features.offGain || 0) === maxOff
    && Number(candidate.features.homeShuffleMoves || 0) === 0
    && isSafeTransitionBearOffAlternative(state, color, candidate, ranked[0])
  ));
  if (!finishing.length) return ranked;
  finishing.sort((left, right) => Number(right.score) - Number(left.score));
  return promoteCandidate(ranked, finishing[0], 'transitionBearOffAdjustment');
}

function isSafeTransitionBearOffAlternative(state, color, candidate, selected) {
  if (candidate === selected) return true;
  if (!candidate?.tactical || !selected?.tactical) return false;
  const uncontested = isUncontestedLateRaceState(state, color, selected.features);
  const structuralTolerance = uncontested ? 0 : 2;
  const gatewayTolerance = uncontested ? 0 : 3;
  const preservesStructure = Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0) - structuralTolerance
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0) - structuralTolerance
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0) - gatewayTolerance
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0) - structuralTolerance
    && Number(candidate.features.prospectiveFenceExtensionDelta || 0)
      >= Number(selected.features.prospectiveFenceExtensionDelta || 0)
    && (
      !uncontested
      || Number(candidate.features.prospectiveFenceInterruptionBreak || 0)
        <= Number(selected.features.prospectiveFenceInterruptionBreak || 0)
    )
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.primeScoreAfter || 0)
      >= Number(selected.features.primeScoreAfter || 0)
    && Number(candidate.features.opponentMoveBlockAfter || 0)
      >= Number(selected.features.opponentMoveBlockAfter || 0)
    && Number(candidate.features.routeTowerAfter || 0)
      <= Number(selected.features.routeTowerAfter || 0)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0);
  if (!preservesStructure) return false;

  const continuationIsComparable = uncontested
    || Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.continuationWorst || 0) - 8000000;
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 8000000
    && Number(candidate.experienceAdjustment || 0)
      >= Number(selected.experienceAdjustment || 0) - 500000
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 8000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) - 15000000
    && continuationIsComparable;
}

function criticalFenceGatewayPoints(state, color) {
  const path = pathFor(color);
  const opponent = opponentOf(color);
  const gateways = new Set();
  for (let start = 1; start <= path.length - 6; start += 1) {
    if (!path.slice(0, start).some(point => colorAt(state, point) === color)) continue;
    const window = path.slice(start, start + 6);
    const ownPoints = window.filter(point => colorAt(state, point) === color);
    const opponentPoints = window.filter(point => colorAt(state, point) === opponent);
    if (ownPoints.length === 1 && opponentPoints.length === 5) gateways.add(ownPoints[0]);
  }
  return [...gateways];
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
    candidate.features.policyPromotionAdjustment = (
      Number(candidate.features.policyPromotionAdjustment || 0) + adjustment
    );
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
  const completeTacticalDominance = Number(candidate.tactical.plies || 0) >= 4
    && Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0)
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0)
    && Number(candidate.tactical.recoveryTailRisk || 0)
      + Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.recoveryTailRisk || 0)
        + Number(selected.tactical.continuationTailRisk || 0)
    && Number(candidate.tactical.recoveryWorst || 0)
      + Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.recoveryWorst || 0)
        + Number(selected.tactical.continuationWorst || 0);
  return (
    scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 25000000
    || completeTacticalDominance
  )
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
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 12000000
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
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 240000000
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
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - scoreTolerance
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
  promoted.features.policyPromotionAdjustment = (
    Number(promoted.features.policyPromotionAdjustment || 0) + adjustment
  );
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
  const replyTolerance = (
    isForcedLateHomeEntryContext(state, color, selected)
    || isDirectLateHomeEntryReplacement(state, color, candidate, selected)
  )
    ? 8000000
    : 250000;
  const replyEnvelope = Number(candidate.tactical.expectedImpact) >= (
    Number(selected.tactical.expectedImpact) - replyTolerance
  )
    && Number(candidate.tactical.worstImpact) >= (
      Number(selected.tactical.worstImpact) - replyTolerance
    );
  if (!replyEnvelope) return false;

  const needsLateRaceProof = isUncontestedPreHomeStaging(state, color, selected)
    || isUncontestedLateRaceState(state, color, selected.features);
  if (!needsLateRaceProof) return true;
  if (!hasBoundedFourPlyTactical(candidate) || !hasBoundedFourPlyTactical(selected)) {
    return false;
  }

  // Entering a checker may make the immediate recovery estimate slightly
  // worse, but a clear-race override must remain corroborated by every deep
  // distribution.
  return Number(candidate.tactical.recoveryExpected || 0)
      >= Number(selected.tactical.recoveryExpected || 0) - 10000000
    && Number(candidate.tactical.recoveryWorst || 0)
      >= Number(selected.tactical.recoveryWorst || 0) - 8000000
    && Number(candidate.tactical.recoveryTailRisk || 0)
      >= Number(selected.tactical.recoveryTailRisk || 0) - 10000000
    && Number(candidate.tactical.continuationExpected || 0)
      >= Number(selected.tactical.continuationExpected || 0) - 2000000
    && Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.continuationWorst || 0) - 2000000
    && Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.continuationTailRisk || 0) - 2000000;
}

function structuralIntegrityDeltas(candidate, selected) {
  const features = candidate?.features || {};
  const baseline = selected?.features || {};
  return {
    latentRelief: Number(features.latentFenceExposureDelta || 0)
      - Number(baseline.latentFenceExposureDelta || 0),
    prospectiveRelief: Number(features.prospectiveFenceExtensionDelta || 0)
      - Number(baseline.prospectiveFenceExtensionDelta || 0),
    interruptionRelief: Number(baseline.prospectiveFenceInterruptionBreak || 0)
      - Number(features.prospectiveFenceInterruptionBreak || 0),
    trapRelief: Number(features.trapDelta || 0) - Number(baseline.trapDelta || 0),
    fenceRelief: Number(features.fenceClosureDelta || 0)
      - Number(baseline.fenceClosureDelta || 0),
    gatewayRelief: Number(features.escapeGatewayDelta || 0)
      - Number(baseline.escapeGatewayDelta || 0),
    primeRunRelief: Number(features.primeRunAfter || 0)
      - Number(baseline.primeRunAfter || 0),
    primeScoreRelief: Number(features.primeScoreAfter || 0)
      - Number(baseline.primeScoreAfter || 0),
    blockRelief: Number(features.opponentMoveBlockAfter || 0)
      - Number(baseline.opponentMoveBlockAfter || 0),
  };
}

function structuralIntegrityProofType(candidate, selected) {
  if (!candidate || !selected || candidate === selected) return null;
  const features = candidate.features || {};
  const baseline = selected.features || {};
  const delta = structuralIntegrityDeltas(candidate, selected);
  const latentBefore = Number(baseline.latentFenceExposureBefore || 0);
  const selectedLatentAfter = Number(baseline.latentFenceExposureAfter || 0);
  const candidateLatentAfter = Number(features.latentFenceExposureAfter || 0);
  const selectedBreak = Number(baseline.prospectiveFenceInterruptionBreak || 0);
  const candidateBreak = Number(features.prospectiveFenceInterruptionBreak || 0);
  const selectedProspectiveAfter = Number(baseline.prospectiveFenceExtensionAfter || 0);
  const prospectiveBefore = Number(baseline.prospectiveFenceExtensionBefore || 0);
  const candidateProspectiveAfter = Number(features.prospectiveFenceExtensionAfter || 0);
  const opponentFenceRun = Number(baseline.opponentFenceRunBefore || 0);
  const primeRunBefore = Number(baseline.primeRunBefore || 0);
  const selectedRunAfter = Number(baseline.primeRunAfter || 0);
  const candidateRunAfter = Number(features.primeRunAfter || 0);

  const preventsNewLatentFence = opponentFenceRun >= 4
    && latentBefore >= 24
    && selectedLatentAfter >= latentBefore + 80
    && candidateLatentAfter <= latentBefore + 5
    && delta.latentRelief >= 80
    && delta.trapRelief >= 0
    && delta.gatewayRelief >= 0
    && delta.blockRelief >= 40
    && Number(features.resultSafetyAfter || 0)
      >= Number(baseline.resultSafetyAfter || 0);
  if (preventsNewLatentFence) return 'prevents-new-latent-fence';

  const escapesLatentFence = opponentFenceRun >= 4
    && latentBefore >= 24
    && selectedLatentAfter >= 24
    && candidateLatentAfter <= Math.max(5, selectedLatentAfter * 0.35)
    && delta.latentRelief >= 20
    && delta.trapRelief >= 0
    && delta.gatewayRelief >= -2;
  if (escapesLatentFence) return 'latent-fence-escape';

  const preservesFenceInterruption = opponentFenceRun >= 4
    && selectedBreak >= 60
    && candidateBreak <= Math.max(5, selectedBreak - 60)
    && candidateProspectiveAfter <= selectedProspectiveAfter - 40
    && delta.gatewayRelief >= 0;
  if (preservesFenceInterruption) return 'fence-interruption';

  const preservesActivePrime = primeRunBefore >= 5
    && selectedRunAfter <= primeRunBefore - 2
    && candidateRunAfter >= Math.max(4, primeRunBefore - 1)
    && prospectiveBefore >= 40
    && delta.blockRelief >= 40;
  if (preservesActivePrime) return 'active-prime';
  return null;
}

function structuralIntegrityUtility(candidate, selected) {
  const delta = structuralIntegrityDeltas(candidate, selected);
  return delta.latentRelief * 10
    + delta.prospectiveRelief * 5
    + delta.interruptionRelief * 8
    + delta.trapRelief * 6
    + delta.fenceRelief * 2
    + delta.gatewayRelief * 8
    + delta.primeRunRelief * 180
    + delta.primeScoreRelief * 0.7
    + delta.blockRelief * 2;
}

function structuralIntegrityReservationBaseline(state, color, ranked) {
  const outside = outsideHomeCount(state, color);
  const trapPressure = opponentTrapRisk(state, color);
  const maxEntry = Math.max(...ranked.map(
    candidate => Number(candidate.features.outsideReduction) || 0,
  ));
  const fenceRun = Math.max(...ranked.map(
    candidate => Number(candidate.features.opponentFenceRunBefore) || 0,
  ));
  const nonSevereTowerCandidates = fenceRun >= 5
    ? ranked.filter(candidate => Number(candidate.features.maxRouteTowerAfter) < 7)
    : [];
  const hasSevereTowerCandidate = ranked.some(
    candidate => Number(candidate.features.maxRouteTowerAfter) >= 7,
  );
  let eligible = hasSevereTowerCandidate && nonSevereTowerCandidates.length
    ? nonSevereTowerCandidates
    : trapPressure > 850 && outside <= 8 && maxEntry > 0 && fenceRun < 4
      ? ranked.filter(candidate => Number(candidate.features.outsideReduction) === maxEntry)
      : ranked;

  const maxHeadRelease = Math.max(...eligible.map(
    candidate => Number(candidate.features.headGain) || 0,
  ));
  const headReleaseIsCritical = maxHeadRelease > 0 && (
    headCheckers(state, color) <= 2
    || headCheckers(state, color) >= 7
    || trapPressure >= 600
    || fenceRun >= 4
    || offCount(state, opponentOf(color)) > 0
  );
  if (headReleaseIsCritical) {
    eligible = eligible.filter(
      candidate => Number(candidate.features.headGain || 0) === maxHeadRelease,
    );
  }
  if (fenceRun >= 5) {
    const gateways = criticalFenceGatewayPoints(state, color);
    if (gateways.length) {
      const preserving = eligible.filter(candidate => gateways.every(
        point => colorAt(candidate.after, point) === color,
      ));
      if (preserving.length) eligible = preserving;
    }
    const maxSafeEntry = Math.max(...eligible.map(
      candidate => Number(candidate.features.outsideReduction) || 0,
    ));
    if (maxSafeEntry > 0) {
      eligible = eligible.filter(
        candidate => Number(candidate.features.outsideReduction) === maxSafeEntry,
      );
    }
  }
  return eligible[0] || ranked[0];
}

function isPlausibleOrdinaryLastHeadPrimeDefense(state, color, candidate, selected) {
  const headRemaining = headCheckers(state, color);
  const features = candidate?.features;
  const baseline = selected?.features;
  if (
    !features
    || !baseline
    || headRemaining < 1
    || headRemaining > 2
    || offCount(state, opponentOf(color)) > 0
    || opponentTrapRisk(state, color) >= 600
  ) {
    return false;
  }
  const nativeMetrics = [
    'trapBefore', 'opponentFenceRunBefore', 'headGain', 'primeRunBefore',
    'primeRunAfter', 'opponentMoveBlockAfter', 'resultSafetyAfter',
    'maxRouteTowerAfter', 'headLandingBreak', 'prospectiveFenceInterruptionBreak',
    'trapDelta', 'fenceClosureDelta', 'escapeGatewayDelta', 'outsideReduction',
    'homeEntryMoves', 'outsidePipGain', 'startZoneReduction', 'homeShuffleMoves',
  ];
  if (!nativeMetrics.every(key => (
    Number.isFinite(features[key]) && Number.isFinite(baseline[key])
  ))) {
    return false;
  }
  // A normal final head checker is a development priority, not proof that a
  // real five-point blockade should be discarded without analyzing a defender.
  // These limits only buy one search slot. Emergency head/trap gates and every
  // final promotion / dynamic safety envelope are deliberately unchanged.
  return Math.max(features.trapBefore, baseline.trapBefore) < 600
    && Math.max(features.opponentFenceRunBefore, baseline.opponentFenceRunBefore) < 4
    && baseline.headGain > 0
    && features.headGain === baseline.headGain - 1
    && baseline.primeRunBefore >= 5
    && baseline.primeRunAfter <= baseline.primeRunBefore - 2
    && features.primeRunAfter >= baseline.primeRunBefore
    && features.opponentMoveBlockAfter >= baseline.opponentMoveBlockAfter + 40
    && features.resultSafetyAfter >= baseline.resultSafetyAfter
    && features.maxRouteTowerAfter <= baseline.maxRouteTowerAfter
    && features.headLandingBreak <= baseline.headLandingBreak
    && features.prospectiveFenceInterruptionBreak <= baseline.prospectiveFenceInterruptionBreak
    && features.trapDelta >= baseline.trapDelta
    && features.fenceClosureDelta >= baseline.fenceClosureDelta
    && features.escapeGatewayDelta >= baseline.escapeGatewayDelta - 1
    && features.outsideReduction >= baseline.outsideReduction
    && features.homeEntryMoves >= baseline.homeEntryMoves
    && features.outsidePipGain >= baseline.outsidePipGain
    && features.startZoneReduction >= baseline.startZoneReduction
    && features.homeShuffleMoves <= baseline.homeShuffleMoves;
}

export function reserveStructuralIntegrityForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  // This function is called both before and during tactical selection. A
  // reservation from the first pass must not survive when the second pass has
  // a different leader or a reduced candidate set.
  ranked.forEach((candidate) => {
    if (candidate?.features) {
      delete candidate.features.structuralIntegrityTacticalReservation;
    }
  });
  const selected = structuralIntegrityReservationBaseline(state, color, ranked);
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;
  const alternatives = ranked.filter((candidate) => {
    const proofType = structuralIntegrityProofType(candidate, selected);
    return proofType
      && (
        structuralProgressIsBounded(candidate, selected, proofType)
        || (
          proofType === 'active-prime'
          && isPlausibleOrdinaryLastHeadPrimeDefense(state, color, candidate, selected)
        )
      );
  });
  if (!alternatives.length) return ranked;
  alternatives.sort((left, right) => (
    structuralIntegrityUtility(right, selected)
      - structuralIntegrityUtility(left, selected)
    || scoreWithoutExperience(right) - scoreWithoutExperience(left)
    || (
      candidatePositionKey(left) < candidatePositionKey(right) ? -1
        : candidatePositionKey(left) > candidatePositionKey(right) ? 1 : 0
    )
  ));
  alternatives[0].features.structuralIntegrityTacticalReservation = 1;
  return reorderTacticalReservations(
    ranked,
    Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES),
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
    !hasHomeEntryPriorityContext(state, color, selected)
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
    !hasRouteContinuityPriorityContext(state, color, selected)
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
  // A score-best partial improvement can still contain a home shuffle. Keep
  // it as the policy reference, but also cover one distinct plausible board
  // with minimum shuffling / maximum outside progress before ordinary beam
  // slots. This reserves analysis only; neither score nor safety is changed.
  const scoreBest = continuing[0];
  const progressReference = [...continuing].sort((left, right) => (
    Number(left.features.homeShuffleMoves || 0)
      - Number(right.features.homeShuffleMoves || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || scoreWithoutExperience(right) - scoreWithoutExperience(left)
  ))[0];
  if (
    progressReference
    && candidatePositionKey(progressReference) !== candidatePositionKey(scoreBest)
    && (
      Number(progressReference.features.homeShuffleMoves || 0)
        < Number(scoreBest.features.homeShuffleMoves || 0)
      || Number(progressReference.features.outsidePipGain || 0)
        > Number(scoreBest.features.outsidePipGain || 0)
    )
  ) {
    progressReference.features.routeContinuityTacticalReservation = 1;
  }
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
          scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 260000000
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

export function reservePrimeSustainabilityForTacticalAnalysis(
  state,
  color,
  ranked,
  limit = MAX_TACTICAL_CANDIDATES,
) {
  const selected = ranked[0];
  const slotCount = Math.max(2, Number(limit) || MAX_TACTICAL_CANDIDATES);
  const selectedRun = Number(selected?.features?.primeRunAfter) || 0;
  const selectedRisk = Number(selected?.features?.primeCrunchRiskAfter) || 0;
  const selectedSustainability = Number(selected?.features?.primeSustainabilityAfter) || 0;
  if (
    !selected
    || homeReady(state, color)
    || selectedRun < 4
    || (selectedRisk < 0.45 && selectedSustainability >= 0.38)
  ) {
    return ranked;
  }

  const safer = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.primeCrunchRiskAfter || 0) <= selectedRisk - 0.2
    && Number(candidate.features.primeSustainabilityAfter || 0)
      >= selectedSustainability + 0.06
    // It is valid to shorten an unsustainable blockade by one point in order
    // to retain the timing needed to escape.  Larger collapses still require
    // stronger tactical proof later in the search.
    && Number(candidate.features.primeRunAfter || 0) >= Math.max(3, selectedRun - 1)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0) - 12
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0) - 4
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 180000000
  ));
  if (!safer.length) return ranked;

  safer.sort((left, right) => (
    Number(left.features.primeCrunchRiskAfter || 0)
      - Number(right.features.primeCrunchRiskAfter || 0)
    || Number(right.features.primeSustainabilityAfter || 0)
      - Number(left.features.primeSustainabilityAfter || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || Number(right.score) - Number(left.score)
  ));
  safer[0].features.primeSustainabilityTacticalReservation = 1;
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
      || Number(candidate.features.structuralIntegrityTacticalReservation || 0) > 0
      || Number(candidate.features.routeContinuityTacticalReservation || 0) > 0
      || Number(candidate.features.fenceEscapeTacticalReservation || 0) > 0
      || Number(candidate.features.primeSustainabilityTacticalReservation || 0) > 0
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
  if (Number(candidate.features.structuralIntegrityTacticalReservation || 0) > 0) return 0;
  if (Number(candidate.features.homeEntryTacticalReservation || 0) > 0) return 1;
  if (Number(candidate.features.primeSustainabilityTacticalReservation || 0) > 0) return 1.5;
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
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - scoreTolerance
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0) - 2
    && (
      Number(candidate.features.outsideReduction || 0)
        > Number(selected.features.outsideReduction || 0)
      || Number(candidate.features.escapeGatewayDelta || 0)
        >= Number(selected.features.escapeGatewayDelta || 0) - gatewayTolerance
    )
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1;
}

function isSafeRouteContinuityAlternative(candidate, selected) {
  if (
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
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
    )
    // Outside progress is not proof that a real blocker may be released.
    // Require corroboration from the same bounded recovery/continuation model
    // instead of promoting on immediate replies while ignoring a deep tail.
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 2000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 15000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 5000000)
    && tacticalMetricWithin(candidate, selected, 'continuationExpected', 2000000)
    && tacticalMetricWithin(candidate, selected, 'continuationWorst', 15000000)
    && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 5000000);
}

function hasHomeEntryPriorityContext(state, color, selected) {
  return Boolean(selected)
    && !homeReady(state, color)
    && headCheckers(state, color) === 0
    && outsideHomeCount(state, color) <= 10
    && opponentTrapRisk(state, color) < 120
    && (
      Number(selected.features.homeShuffleMoves || 0) > 0
      || isUncontestedPreHomeStaging(state, color, selected)
      || (
        Number(selected.features.outsideReduction || 0) === 0
        && isUncontestedLateRaceState(state, color, selected.features)
      )
    );
}

function isUncontestedLateRaceState(state, color, features = {}) {
  const outside = outsideHomeCount(state, color);
  // The deep continuation score is allowed to yield to race progress only when
  // the advanced profile has proved that no present or one-roll fence exists.
  // Missing v19 metrics must fail closed instead of looking like numeric zero.
  const advancedMetricsAvailable = [
    'latentFenceExposureBefore',
    'prospectiveFenceExtensionBefore',
    'primeScoreBefore',
    'opponentMoveBlockBefore',
  ].every(key => Object.prototype.hasOwnProperty.call(features, key));
  return outside > 0
    && outside <= 10
    && advancedMetricsAvailable
    && headCheckers(state, color) === 0
    && headCheckers(state, opponentOf(color)) === 0
    && opponentTrapRisk(state, color) === 0
    && escapeGatewayRisk(state, color) <= 24
    && Number(features.trapBefore || 0) === 0
    && Number(features.fenceClosureBefore || 0) === 0
    && Number(features.opponentFenceRunBefore || 0) < 3
    && Number(features.latentFenceExposureBefore || 0) === 0
    && Number(features.prospectiveFenceExtensionBefore || 0) === 0;
}

function isUncontestedPreHomeStaging(state, color, selected) {
  return Boolean(selected)
    && outsideHomeCount(state, color) <= 6
    && Number(selected.features.homeShuffleMoves || 0) === 0
    && Number(selected.features.outsideDevelopmentMoves || 0) > 0
    && isUncontestedLateRaceState(state, color, selected.features);
}

function isPlausibleHomeEntryAlternative(state, color, candidate, selected) {
  const stagedReplacement = isUncontestedPreHomeStaging(state, color, selected);
  const uncontestedRace = isUncontestedLateRaceState(state, color, selected.features);
  const forcedLateEntry = isForcedLateHomeEntryContext(state, color, selected);
  const directReplacement = isDirectLateHomeEntryReplacement(
    state,
    color,
    candidate,
    selected,
  );
  const totalScoreTolerance = directReplacement
    ? 8000000
    : uncontestedRace
      ? 24000000
      : 2000000;
  const trapFloor = directReplacement
    ? Number(selected.features.trapDelta || 0) - 8
    : forcedLateEntry
      ? Number(selected.features.trapDelta || 0)
      : 0;
  const fenceFloor = directReplacement
    ? Number(selected.features.fenceClosureDelta || 0) - 2
    : forcedLateEntry
      ? Number(selected.features.fenceClosureDelta || 0)
      : 0;
  const gatewayFloor = directReplacement
    ? Number(selected.features.escapeGatewayDelta || 0) - 3
    : forcedLateEntry
      ? Number(selected.features.escapeGatewayDelta || 0)
      : 0;
  // A clear race used to bypass this block whenever it was not classified as
  // "staging". Apply the same structural proof to both late-race paths.
  const stagingStructureIsPreserved = !(stagedReplacement || uncontestedRace) || (
    Number(candidate.features.homeShuffleMoves || 0) === 0
    && Number(candidate.features.trapDelta || 0)
      >= Number(selected.features.trapDelta || 0)
    && Number(candidate.features.fenceClosureDelta || 0)
      >= Number(selected.features.fenceClosureDelta || 0)
    && Number(candidate.features.escapeGatewayDelta || 0)
      >= Number(selected.features.escapeGatewayDelta || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0)
    && Number(candidate.features.prospectiveFenceExtensionDelta || 0)
      >= Number(selected.features.prospectiveFenceExtensionDelta || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.primeScoreAfter || 0)
      >= Number(selected.features.primeScoreAfter || 0)
    && Number(candidate.features.opponentMoveBlockAfter || 0)
      >= Number(selected.features.opponentMoveBlockAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + (uncontestedRace ? 1 : 0)
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
  );
  return stagingStructureIsPreserved
    && Number(candidate.features.trapDelta || 0) >= trapFloor
    && Number(candidate.features.fenceClosureDelta || 0) >= fenceFloor
    && Number(candidate.features.escapeGatewayDelta || 0) >= gatewayFloor
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Math.min(6, Number(selected.features.maxRouteTowerAfter || 0) + 1)
    && scoreWithoutExperience(candidate)
      >= scoreWithoutExperience(selected) - totalScoreTolerance;
}

function isDirectLateHomeEntryReplacement(state, color, candidate, selected) {
  const outside = outsideHomeCount(state, color);
  return Boolean(candidate && selected)
    && headCheckers(state, color) === 0
    && outside > 0
    && outside <= 10
    && opponentTrapRisk(state, color) < 120
    && Number(selected.features.homeShuffleMoves || 0) > 0
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.outsideReduction || 0)
      > Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      > Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0)
    && Number(candidate.features.latentFenceExposureDelta || 0)
      >= Number(selected.features.latentFenceExposureDelta || 0) - 2;
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
    // Experience is applied only after the cold tactical policy and remains
    // inside its safety envelope.  Let repeated or severe evidence correct a
    // close heuristic margin instead of capping it at an ineffectual six per
    // cent of the already noisy composite score.
    Math.max(6000000, Math.abs(Number(immediateScore) || 0) * 0.28),
  );
  return Math.max(-budget, Math.min(Math.min(6000000, budget), raw));
}

function policyAwareExperienceAdjustment(descriptor, experience, immediateScore) {
  const adjustment = boundedExperienceAdjustment(
    experienceAdjustment(descriptor, experience),
    immediateScore,
  );
  const harmSignal = Math.max(
    Number(descriptor?.mistakeSeverity) || 0,
    Number(descriptor?.riskSignal) || 0,
  );
  return adjustment > 0 && harmSignal >= 1.1 ? 0 : adjustment;
}

function prefilterSequences(adapter, state, color, sequences, maxCandidates) {
  const ready = homeReady(state, color);
  const entryPressure = lateEntryPressure(state, color);
  const trapPressure = opponentTrapRisk(state, color);
  const development = developmentPressure(state, color);
  const rescuePressure = koksRescuePressure(state, color);
  const latentFenceBefore = latentFenceExposure(state, color);
  const prospectiveFenceBefore = prospectiveFenceExtensionRisk(state, color);
  const needsStructuralEscapeCandidate = !ready && (
    latentFenceBefore >= 24
    || prospectiveFenceBefore >= 60
    || (
      blockingPrimeRun(state, color) >= 5
      && blockingPrimeScore(state, color) >= 500
    )
  );

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
      let structuralSafety = null;
      if (needsStructuralEscapeCandidate) {
        const after = adapter.applySequence(state, sequence, color);
        const latentFenceAfter = latentFenceExposure(after, color);
        const prospectiveFenceAfter = prospectiveFenceExtensionRisk(after, color);
        const trapAfter = opponentTrapRisk(after, color);
        const primeRunAfter = blockingPrimeRun(after, color);
        const primeScoreAfter = blockingPrimeScore(after, color);
        const opponentMoveBlockAfter = opponentMoveBlockScore(after, color);
        structuralSafety = {
          after,
          latentFenceAfter,
          prospectiveFenceAfter,
          trapAfter,
          primeRunAfter,
          primeScoreAfter,
          opponentMoveBlockAfter,
          utility: (latentFenceBefore - latentFenceAfter) * 9
            + (prospectiveFenceBefore - prospectiveFenceAfter) * 7
            + (trapPressure - trapAfter) * 5
            + primeRunAfter * 90
            + primeScoreAfter * 0.12
            + opponentMoveBlockAfter * 0.8,
        };
      }
      return {
        sequence,
        offMoves,
        homeEntries,
        outsideMoves,
        headMoves,
        homeShuffle: insideHomeMoves,
        startZoneExits,
        structuralSafety,
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
  const seenPositions = new Set();
  const add = (item) => {
    if (!item || selected.length >= maxCandidates) return;
    // A legal turn can be emitted in many commuting move orders, especially
    // for doubles. They are one choice once the turn is complete and must not
    // consume separate shortlist slots ahead of genuinely different boards.
    const after = item.structuralSafety?.after
      || adapter.applySequence(state, item.sequence, color);
    const key = candidatePositionKey({ after });
    if (seenPositions.has(key)) return;
    seenPositions.add(key);
    selected.push(item.sequence);
  };
  const bestBy = (predicate, compare) => scored.filter(predicate).sort(compare)[0];

  add(bestBy(item => item.structuralSafety, (a, b) => (
    b.structuralSafety.utility - a.structuralSafety.utility
    || a.structuralSafety.latentFenceAfter - b.structuralSafety.latentFenceAfter
    || a.structuralSafety.prospectiveFenceAfter - b.structuralSafety.prospectiveFenceAfter
    || a.structuralSafety.trapAfter - b.structuralSafety.trapAfter
    || b.priority - a.priority
  )));
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
      // Laggard progress is already priced by scoreSequence.  The emergency
      // race bonus must not pay for the same progress again when the move
      // dismantles the prime or the only escape gateway protecting it.
      if (routeProgressPreservesDefense(state, color, features)) {
        candidate.score += Math.max(0, Number(features.laggardDebtDelta) || 0) * 340000;
      }
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

function routeProgressPreservesDefense(state, color, features = {}) {
  const primeRunBefore = Number(features.primeRunBefore) || 0;
  const primeRunAfter = Number(features.primeRunAfter) || 0;
  const trapBefore = Number(features.trapBefore) || 0;
  // Ordinary route play still needs to trade temporary structure for tempo.
  // The duplicate progress bonus becomes dangerous only under a developed
  // trap, which is exactly where LZE8-Z538 dismantled its own four-prime.
  if (trapBefore < 600) return true;
  const criticalClearedHeadEscape = headCheckers(state, color) === 0
    && headCheckers(state, opponentOf(color)) === 0
    && primeRunBefore >= 5
    && Number(features.laggardDebtDelta || 0) >= 120
    && Number(features.startZoneReduction || 0) > 0;
  if (criticalClearedHeadEscape) return true;
  return !(primeRunBefore >= 3 && primeRunAfter < primeRunBefore)
    && Number(features.primeScoreGain || 0) >= 0
    && Number(features.opponentMoveBlockGain || 0) >= 0
    && Number(features.fenceClosureDelta || 0) >= 0
    && Number(features.escapeGatewayDelta || 0) >= 0;
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
    && !isDeepFenceSafetyRegression(candidate, selected)
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

function prioritizeProspectiveFenceInterruption(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedProspectiveFenceInterruption(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.tactical.continuationTailRisk || 0)
      - Number(left.tactical.continuationTailRisk || 0)
    || Number(right.features.prospectiveFenceExtensionDelta || 0)
      - Number(left.features.prospectiveFenceExtensionDelta || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'prospectiveFenceInterruptionAdjustment',
  );
  promoted[0].features.prospectiveFenceInterruptionPreserved = 1;
  return promoted;
}

function prioritizeProspectiveFenceAnchorSafety(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedProspectiveFenceAnchorSafety(candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    Number(right.tactical.continuationWorst || 0)
      - Number(left.tactical.continuationWorst || 0)
    || Number(right.tactical.continuationTailRisk || 0)
      - Number(left.tactical.continuationTailRisk || 0)
    || Number(right.tactical.continuationExpected || 0)
      - Number(left.tactical.continuationExpected || 0)
    || Number(left.features.prospectiveFenceExtensionAfter || 0)
      - Number(right.features.prospectiveFenceExtensionAfter || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'prospectiveFenceAnchorSafetyAdjustment',
  );
  promoted[0].features.prospectiveFenceAnchorPreserved = 1;
  return promoted;
}

function prioritizeProbabilisticFenceDenial(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;

  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isAnalyzedProbabilisticFenceDenial(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    probabilisticFenceDenialGain(right, selected)
      - probabilisticFenceDenialGain(left, selected)
    || Number(right.tactical.continuationExpected || 0)
      - Number(left.tactical.continuationExpected || 0)
    || Number(right.tactical.recoveryWorst || 0)
      - Number(left.tactical.recoveryWorst || 0)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'probabilisticFenceDenialAdjustment',
  );
  promoted[0].features.probabilisticFenceDenial = 1;
  return promoted;
}

function probabilisticFenceDenialGain(candidate, selected) {
  return Number(selected.features.prospectiveFenceExtensionAfter || 0)
    - Number(candidate.features.prospectiveFenceExtensionAfter || 0);
}

function preservesVacatedRouteAnchor(state, color, candidate, selected) {
  return Object.entries(state.points || {}).some(([point, stack]) => (
    stack?.color === color
    && Number(stack.count || 0) > 0
    && colorAt(candidate.after, Number(point)) === color
    && colorAt(selected.after, Number(point)) !== color
  ));
}

function isAnalyzedProbabilisticFenceDenial(state, color, candidate, selected) {
  const candidateFeatures = candidate?.features || {};
  const selectedFeatures = selected?.features || {};
  const candidateTactical = candidate?.tactical || {};
  const selectedTactical = selected?.tactical || {};
  const scoreTolerance = Math.min(
    120000000,
    45000000 + Math.max(0, Number(selectedFeatures.trapBefore || 0)) * 80000,
  );
  if (
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || Number(selectedFeatures.opponentFenceRunBefore || 0) < 3
    || Number(selectedFeatures.trapBefore || 0) < 600
    || probabilisticFenceDenialGain(candidate, selected) < 60
    || !preservesVacatedRouteAnchor(state, color, candidate, selected)
    || scoreWithoutExperience(candidate) < scoreWithoutExperience(selected) - scoreTolerance
  ) {
    return false;
  }

  const progressIsPreserved = Number(candidateFeatures.headGain || 0)
      >= Number(selectedFeatures.headGain || 0)
    && Number(candidateFeatures.outsideReduction || 0)
      >= Number(selectedFeatures.outsideReduction || 0)
    && Number(candidateFeatures.outsidePipGain || 0)
      >= Number(selectedFeatures.outsidePipGain || 0)
    && Number(candidateFeatures.startZoneReduction || 0)
      >= Number(selectedFeatures.startZoneReduction || 0)
    && Number(candidateFeatures.resultSafetyAfter || 0)
      >= Number(selectedFeatures.resultSafetyAfter || 0)
    && Number(candidateFeatures.missedKoksRescue || 0)
      <= Number(selectedFeatures.missedKoksRescue || 0)
    && Number(candidateFeatures.homeShuffleMoves || 0)
      <= Number(selectedFeatures.homeShuffleMoves || 0)
    && Number(candidateFeatures.maxRouteTowerAfter || 0)
      <= Number(selectedFeatures.maxRouteTowerAfter || 0)
    && Number(candidateFeatures.primeRunAfter || 0)
      >= Number(selectedFeatures.primeRunAfter || 0);
  if (!progressIsPreserved) return false;

  return Number(candidateTactical.expectedImpact || 0)
      >= Number(selectedTactical.expectedImpact || 0)
    && Number(candidateTactical.worstImpact || 0)
      >= Number(selectedTactical.worstImpact || 0) - 2000000
    && Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) - 5000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) - 10000000
    && Number(candidateTactical.recoveryTailRisk || 0)
      >= Number(selectedTactical.recoveryTailRisk || 0) - 5000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) + 40000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) - 2000000
    && Number(candidateTactical.continuationTailRisk || 0)
      >= Number(selectedTactical.continuationTailRisk || 0) - 2000000;
}

function prioritizeVerifiedDeepSafety(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || ranked.length < 2) return ranked;
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && isVerifiedDeepSafetyAlternative(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;

  alternatives.sort((left, right) => (
    verifiedDeepSafetyGain(right, selected) - verifiedDeepSafetyGain(left, selected)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'verifiedDeepSafetyAdjustment',
  );
  promoted[0].features.verifiedDeepSafety = 1;
  return promoted;
}

function tacticalMetricWithin(candidate, selected, key, tolerance, requiredGain = 0) {
  return Number(candidate.tactical?.[key] || 0) >= (
    Number(selected.tactical?.[key] || 0) + requiredGain - tolerance
  );
}

function structuralProgressIsBounded(candidate, selected, proofType) {
  const features = candidate.features || {};
  const baseline = selected.features || {};
  const common = Number(features.resultSafetyAfter || 0)
      >= Number(baseline.resultSafetyAfter || 0)
    && Number(features.maxRouteTowerAfter || 0)
      <= Number(baseline.maxRouteTowerAfter || 0) + 1;
  if (!common) return false;

  if (proofType === 'latent-fence-escape') {
    return Number(features.headGain || 0) >= Number(baseline.headGain || 0)
      && Number(features.outsideReduction || 0)
        >= Number(baseline.outsideReduction || 0) - 1
      && Number(features.outsidePipGain || 0)
        >= Number(baseline.outsidePipGain || 0)
      && Number(features.startZoneReduction || 0)
        >= Number(baseline.startZoneReduction || 0)
      && Number(features.homeShuffleMoves || 0)
        <= Number(baseline.homeShuffleMoves || 0);
  }
  if (proofType === 'active-prime') {
    return Number(features.headGain || 0) >= Number(baseline.headGain || 0)
      && Number(features.outsideReduction || 0)
        > Number(baseline.outsideReduction || 0)
      && Number(features.homeEntryMoves || 0)
        > Number(baseline.homeEntryMoves || 0)
      && Number(features.homeShuffleMoves || 0)
        <= Number(baseline.homeShuffleMoves || 0);
  }
  if (proofType === 'prevents-new-latent-fence') {
    return Number(features.outsideReduction || 0)
        >= Number(baseline.outsideReduction || 0)
      && Number(features.homeEntryMoves || 0)
        >= Number(baseline.homeEntryMoves || 0)
      && Number(features.outsidePipGain || 0)
        >= Number(baseline.outsidePipGain || 0)
      && Number(features.homeShuffleMoves || 0)
        <= Number(baseline.homeShuffleMoves || 0);
  }
  return Number(features.headGain || 0) >= Number(baseline.headGain || 0)
    && Number(features.outsideReduction || 0)
      >= Number(baseline.outsideReduction || 0)
    && Number(features.outsidePipGain || 0)
      >= Number(baseline.outsidePipGain || 0)
    && Number(features.startZoneReduction || 0)
      >= Number(baseline.startZoneReduction || 0)
    && Number(features.homeShuffleMoves || 0)
      <= Number(baseline.homeShuffleMoves || 0);
}

function hasStructuralIntegrityEnvelope(candidate, selected, proofType) {
  if (
    !proofType
    || !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || !structuralProgressIsBounded(candidate, selected, proofType)
  ) {
    return false;
  }

  const scoreGap = scoreWithoutExperience(selected) - scoreWithoutExperience(candidate);
  if (proofType === 'prevents-new-latent-fence') {
    return scoreGap <= 180000000
      && tacticalMetricWithin(candidate, selected, 'expectedImpact', 0)
      && tacticalMetricWithin(candidate, selected, 'worstImpact', 0)
      && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 10000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 10000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 10000000)
      && tacticalMetricWithin(candidate, selected, 'continuationExpected', 5000000)
      && tacticalMetricWithin(candidate, selected, 'continuationWorst', 5000000)
      && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 5000000);
  }
  if (proofType === 'latent-fence-escape') {
    return scoreGap <= 12000000
      && tacticalMetricWithin(candidate, selected, 'expectedImpact', 2000000)
      && tacticalMetricWithin(candidate, selected, 'worstImpact', 2000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 0, 5000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 12000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 2000000)
      && tacticalMetricWithin(candidate, selected, 'continuationExpected', 9000000)
      && tacticalMetricWithin(candidate, selected, 'continuationWorst', 2000000)
      && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 2000000);
  }
  if (proofType === 'active-prime') {
    const delta = structuralIntegrityDeltas(candidate, selected);
    // Only the single worst continuation sample may consume the larger
    // structural allowance. Expected and lower-tail continuation stay within
    // their tight envelopes below, so a large prime cannot hide broad damage.
    const continuationWorstTolerance = Math.min(
      120000000,
      Math.max(12000000, delta.blockRelief * 700000),
    );
    return scoreGap <= 180000000
      && tacticalMetricWithin(candidate, selected, 'expectedImpact', 5000000)
      && tacticalMetricWithin(candidate, selected, 'worstImpact', 10000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 0, 10000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 15000000)
      && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 5000000)
      && tacticalMetricWithin(candidate, selected, 'continuationExpected', 5000000)
      && tacticalMetricWithin(
        candidate,
        selected,
        'continuationWorst',
        continuationWorstTolerance,
      )
      && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 12000000);
  }
  return scoreGap <= 40000000
    && tacticalMetricWithin(candidate, selected, 'expectedImpact', 5000000)
    && tacticalMetricWithin(candidate, selected, 'worstImpact', 8000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 10000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 15000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 15000000)
    && tacticalMetricWithin(candidate, selected, 'continuationExpected', 8000000)
    && tacticalMetricWithin(candidate, selected, 'continuationWorst', 12000000)
    && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 12000000);
}

function prioritizeStructuralIntegrity(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;
  const alternatives = ranked.filter(candidate => {
    if (candidate === selected) return false;
    const proofType = structuralIntegrityProofType(candidate, selected);
    return hasStructuralIntegrityEnvelope(candidate, selected, proofType);
  });
  if (!alternatives.length) return ranked;
  alternatives.sort((left, right) => (
    structuralIntegrityUtility(right, selected)
      - structuralIntegrityUtility(left, selected)
    || Number(right.tactical.worstImpact || 0)
      - Number(left.tactical.worstImpact || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'structuralIntegrityAdjustment',
  );
  promoted[0].features.structuralIntegrityOverride = 1;
  promoted[0].features.structuralIntegrityProofType = structuralIntegrityProofType(
    promoted[0],
    selected,
  );
  return promoted;
}

function tacticallyEquivalentStructureGain(candidate, selected) {
  const delta = structuralIntegrityDeltas(candidate, selected);
  return delta.primeRunRelief * 45
    + delta.primeScoreRelief * 0.7
    + delta.blockRelief * 1.5
    + delta.gatewayRelief * 5
    + delta.fenceRelief * 2
    + delta.latentRelief * 3
    + delta.trapRelief * 3
    + delta.interruptionRelief * 0.5
    + delta.prospectiveRelief * 0.35;
}

function isTacticallyEquivalentBlockRescue(candidate, selected) {
  const delta = structuralIntegrityDeltas(candidate, selected);
  return delta.blockRelief >= 100
    && delta.gatewayRelief >= 0
    && Number(candidate.features.prospectiveFenceInterruptionBreak || 0)
      <= Number(selected.features.prospectiveFenceInterruptionBreak || 0) + 5;
}

export function hasTacticallyEquivalentBlockRescueEnvelope(candidate, selected) {
  if (
    !isTacticallyEquivalentBlockRescue(candidate, selected)
    || !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
  ) {
    return false;
  }
  const delta = structuralIntegrityDeltas(candidate, selected);
  const recoveryWorstTolerance = Math.min(
    45000000,
    Math.max(0, delta.blockRelief) * 400000,
  );
  // A verified block gain can offset one rare worst-frontier branch, but the
  // cap is proportional to the gain and never relaxes expected/tail evidence.
  const continuationWorstTolerance = Math.min(
    90000000,
    Math.max(10000000, delta.blockRelief * 800000),
  );
  return tacticalMetricWithin(candidate, selected, 'expectedImpact', 3000000)
    && tacticalMetricWithin(candidate, selected, 'worstImpact', 3000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 5000000)
    && tacticalMetricWithin(
      candidate,
      selected,
      'recoveryWorst',
      recoveryWorstTolerance,
    )
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 10000000)
    && tacticalMetricWithin(candidate, selected, 'continuationExpected', 5000000)
    && tacticalMetricWithin(
      candidate,
      selected,
      'continuationWorst',
      continuationWorstTolerance,
    )
    && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 10000000);
}

function hasTacticallyEquivalentStructuralProof(candidate, selected) {
  const blockRescue = hasTacticallyEquivalentBlockRescueEnvelope(candidate, selected);
  const primeRetention = hasTacticallyEquivalentPrimeRetentionEnvelope(candidate, selected);
  return blockRescue || primeRetention;
}

export function hasTacticallyEquivalentPrimeRetentionEnvelope(candidate, selected) {
  const delta = structuralIntegrityDeltas(candidate, selected);
  return delta.primeScoreRelief >= 100
    && hasBoundedFourPlyTactical(candidate)
    && hasBoundedFourPlyTactical(selected)
    && tacticalMetricWithin(candidate, selected, 'expectedImpact', 3000000)
    && tacticalMetricWithin(candidate, selected, 'worstImpact', 3000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 0, 8000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 0, 20000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 10000000)
    && tacticalMetricWithin(candidate, selected, 'continuationExpected', 5000000)
    && tacticalMetricWithin(candidate, selected, 'continuationWorst', 10000000)
    && tacticalMetricWithin(candidate, selected, 'continuationTailRisk', 10000000);
}

export function prioritizeTacticallyEquivalentStructure(state, color, ranked) {
  const selected = ranked[0];
  if (!selected || homeReady(state, color) || ranked.length < 2) return ranked;
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && hasBoundedFourPlyTactical(candidate)
    && hasBoundedFourPlyTactical(selected)
    && hasTacticallyEquivalentStructuralProof(candidate, selected)
    && scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - (
      isTacticallyEquivalentBlockRescue(candidate, selected) ? 24000000 : 22000000
    )
    && Number(candidate.features.resultSafetyAfter || 0)
      >= Number(selected.features.resultSafetyAfter || 0)
    && Number(candidate.features.headGain || 0)
      >= Number(selected.features.headGain || 0)
    && Number(candidate.features.outsideReduction || 0)
      >= Number(selected.features.outsideReduction || 0)
    && Number(candidate.features.outsidePipGain || 0)
      >= Number(selected.features.outsidePipGain || 0)
    && Number(candidate.features.startZoneReduction || 0)
      >= Number(selected.features.startZoneReduction || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.maxRouteTowerAfter || 0)
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.primeRunAfter || 0)
      >= Number(selected.features.primeRunAfter || 0)
    && Number(candidate.tactical.expectedImpact || 0)
      >= Number(selected.tactical.expectedImpact || 0) - 3000000
    && Number(candidate.tactical.worstImpact || 0)
      >= Number(selected.tactical.worstImpact || 0) - 3000000
  ));
  if (!alternatives.length) return ranked;
  alternatives.sort((left, right) => (
    tacticallyEquivalentStructureGain(right, selected)
      - tacticallyEquivalentStructureGain(left, selected)
    || Number(right.tactical.recoveryExpected || 0)
      - Number(left.tactical.recoveryExpected || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'tacticalStructureAdjustment',
  );
  promoted[0].features.tacticalStructureOverride = 1;
  return promoted;
}

function isBoundedLateHomeEntryAlternative(state, color, candidate, selected) {
  const features = candidate?.features || {};
  const baseline = selected?.features || {};
  const advancedMetricsAvailable = [
    'trapBefore',
    'fenceClosureBefore',
    'latentFenceExposureBefore',
    'prospectiveFenceExtensionBefore',
    'opponentFenceRunBefore',
  ].every(key => Object.prototype.hasOwnProperty.call(baseline, key));
  if (
    !advancedMetricsAvailable
    || outsideHomeCount(state, color) < 1
    || outsideHomeCount(state, color) > 4
    || headCheckers(state, color) !== 0
    || headCheckers(state, opponentOf(color)) !== 0
    || opponentTrapRisk(state, color) > 24
    || escapeGatewayRisk(state, color) > 12
    || Number(baseline.trapBefore || 0) > 24
    || Number(baseline.fenceClosureBefore || 0) > 0
    || Number(baseline.opponentFenceRunBefore || 0) > 3
    // This is a bounded late-route policy, not a declaration that contact has
    // ended. Mild latent pressure is allowed only when every structural metric
    // below is unchanged and the all-dice three-ply envelope corroborates
    // the entry.
    || Number(baseline.latentFenceExposureBefore || 0) > 120
    || Number(baseline.prospectiveFenceExtensionBefore || 0) !== 0
    || !hasCompleteThreePlyTactical(candidate)
    || !hasCompleteThreePlyTactical(selected)
  ) {
    return false;
  }

  const structureIsUnchanged = Number(features.trapDelta || 0)
      >= Number(baseline.trapDelta || 0)
    && Number(features.fenceClosureDelta || 0)
      >= Number(baseline.fenceClosureDelta || 0)
    && Number(features.escapeGatewayDelta || 0)
      >= Number(baseline.escapeGatewayDelta || 0)
    && Number(features.latentFenceExposureDelta || 0)
      >= Number(baseline.latentFenceExposureDelta || 0)
    && Number(features.prospectiveFenceExtensionDelta || 0)
      >= Number(baseline.prospectiveFenceExtensionDelta || 0)
    && Number(features.primeRunAfter || 0)
      >= Number(baseline.primeRunAfter || 0)
    && Number(features.primeScoreAfter || 0)
      >= Number(baseline.primeScoreAfter || 0)
    && Number(features.opponentMoveBlockAfter || 0)
      >= Number(baseline.opponentMoveBlockAfter || 0)
    && Number(features.maxRouteTowerAfter || 0)
      <= Number(baseline.maxRouteTowerAfter || 0)
    && Number(features.resultSafetyAfter || 0)
      >= Number(baseline.resultSafetyAfter || 0);
  if (!structureIsUnchanged) return false;

  const progressIsComparable = Number(features.outsideReduction || 0)
      >= Number(baseline.outsideReduction || 0)
    && Number(features.homeEntryMoves || 0)
      >= Number(baseline.homeEntryMoves || 0)
    && Number(features.headGain || 0) >= Number(baseline.headGain || 0)
    && Number(features.startZoneReduction || 0)
      >= Number(baseline.startZoneReduction || 0);
  if (!progressIsComparable) return false;

  // Do not use the representative continuation frontier as a hard override.
  // Primary/recovery cover every dice outcome within their bounded reply
  // beams; their three-ply envelope must reject a materially worse tail.
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 22000000
    && tacticalMetricWithin(candidate, selected, 'expectedImpact', 2000000)
    && tacticalMetricWithin(candidate, selected, 'worstImpact', 2000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryExpected', 0)
    && tacticalMetricWithin(candidate, selected, 'recoveryWorst', 12000000)
    && tacticalMetricWithin(candidate, selected, 'recoveryTailRisk', 8000000);
}

function prioritizeAvoidableHomeShuffle(state, color, ranked) {
  const selected = ranked[0];
  if (
    !selected
    || homeReady(state, color)
    || Number(selected.features.avoidableHomeShuffleMoves || 0) <= 0
  ) {
    return ranked;
  }
  const alternatives = ranked.filter(candidate => (
    candidate !== selected
    && Number(candidate.features.avoidableHomeShuffleMoves || 0)
      < Number(selected.features.avoidableHomeShuffleMoves || 0)
    && Number(candidate.features.homeShuffleMoves || 0)
      < Number(selected.features.homeShuffleMoves || 0)
    && isBoundedLateHomeEntryAlternative(state, color, candidate, selected)
  ));
  if (!alternatives.length) return ranked;
  alternatives.sort((left, right) => (
    Number(left.features.avoidableHomeShuffleMoves || 0)
      - Number(right.features.avoidableHomeShuffleMoves || 0)
    || Number(right.features.outsidePipGain || 0)
      - Number(left.features.outsidePipGain || 0)
    || Number(right.tactical.worstImpact || 0)
      - Number(left.tactical.worstImpact || 0)
    || Number(right.score) - Number(left.score)
  ));
  const promoted = promoteCandidate(
    ranked,
    alternatives[0],
    'avoidableHomeShuffleAdjustment',
  );
  promoted[0].features.avoidableHomeShuffleOverride = 1;
  return promoted;
}

function verifiedDeepSafetyGain(candidate, selected) {
  const candidateTactical = candidate.tactical || {};
  const selectedTactical = selected.tactical || {};
  return Number(candidateTactical.recoveryExpected || 0)
      - Number(selectedTactical.recoveryExpected || 0)
    + Number(candidateTactical.recoveryWorst || 0)
      - Number(selectedTactical.recoveryWorst || 0)
    + Number(candidateTactical.continuationExpected || 0)
      - Number(selectedTactical.continuationExpected || 0)
    + Number(candidateTactical.continuationWorst || 0)
      - Number(selectedTactical.continuationWorst || 0);
}

function isVerifiedDeepSafetyAlternative(state, color, candidate, selected) {
  if (!hasBoundedFourPlyTactical(candidate) || !hasBoundedFourPlyTactical(selected)) {
    return false;
  }
  const candidateFeatures = candidate.features || {};
  const selectedFeatures = selected.features || {};
  const candidateTactical = candidate.tactical || {};
  const selectedTactical = selected.tactical || {};
  const earlyResultSafetyTolerance = offCount(state, opponentOf(color)) === 0 ? 1 : 0;
  const progressIsPreserved = Number(candidateFeatures.headGain || 0)
      >= Number(selectedFeatures.headGain || 0)
    && Number(candidateFeatures.outsideReduction || 0)
      >= Number(selectedFeatures.outsideReduction || 0)
    && Number(candidateFeatures.outsidePipGain || 0)
      >= Number(selectedFeatures.outsidePipGain || 0)
    && Number(candidateFeatures.startZoneReduction || 0)
      >= Number(selectedFeatures.startZoneReduction || 0) - earlyResultSafetyTolerance
    && Number(candidateFeatures.resultSafetyAfter || 0)
      >= Number(selectedFeatures.resultSafetyAfter || 0)
    && Number(candidateFeatures.homeShuffleMoves || 0)
      <= Number(selectedFeatures.homeShuffleMoves || 0)
    && Number(candidateFeatures.maxRouteTowerAfter || 0)
      <= Number(selectedFeatures.maxRouteTowerAfter || 0)
    && Number(candidateFeatures.primeRunAfter || 0)
      >= Number(selectedFeatures.primeRunAfter || 0) - 1;
  if (!progressIsPreserved) return false;

  const directRecoveryProof = Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) + 8000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) + 75000000;
  const corroboratedContinuationProof = Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) + 6000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) + 20000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) + 30000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) + 60000000
    && Number(candidateFeatures.trapDelta || 0)
      >= Number(selectedFeatures.trapDelta || 0)
    && Number(candidateFeatures.fenceClosureDelta || 0)
      >= Number(selectedFeatures.fenceClosureDelta || 0)
    && Number(candidateFeatures.escapeGatewayDelta || 0)
      >= Number(selectedFeatures.escapeGatewayDelta || 0) - 1
    && Number(candidateFeatures.latentFenceExposureDelta || 0)
      >= Number(selectedFeatures.latentFenceExposureDelta || 0);

  return Number(candidateTactical.expectedImpact || 0)
      >= Number(selectedTactical.expectedImpact || 0) - 12000000
    && Number(candidateTactical.worstImpact || 0)
      >= Number(selectedTactical.worstImpact || 0) - 12000000
    && (directRecoveryProof || corroboratedContinuationProof)
    && Number(candidateTactical.recoveryTailRisk || 0)
      >= Number(selectedTactical.recoveryTailRisk || 0) - 25000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) - 2000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) - 5000000
    && Number(candidateTactical.continuationTailRisk || 0)
      >= Number(selectedTactical.continuationTailRisk || 0) - 5000000;
}

function isAnalyzedProspectiveFenceAnchorSafety(candidate, selected) {
  const candidateFeatures = candidate?.features || {};
  const selectedFeatures = selected?.features || {};
  const candidateTactical = candidate?.tactical;
  const selectedTactical = selected?.tactical;
  if (
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || Number(candidateFeatures.prospectiveFenceExtensionAfter || 0)
      > Number(selectedFeatures.prospectiveFenceExtensionAfter || 0) - 40
    || scoreWithoutExperience(candidate) < scoreWithoutExperience(selected) - 18000000
  ) {
    return false;
  }

  const progressIsPreserved = Number(candidateFeatures.headGain || 0)
      >= Number(selectedFeatures.headGain || 0)
    && Number(candidateFeatures.outsideReduction || 0)
      >= Number(selectedFeatures.outsideReduction || 0)
    && Number(candidateFeatures.outsidePipGain || 0)
      >= Number(selectedFeatures.outsidePipGain || 0)
    && Number(candidateFeatures.startZoneReduction || 0)
      >= Number(selectedFeatures.startZoneReduction || 0)
    && Number(candidateFeatures.resultSafetyAfter || 0)
      >= Number(selectedFeatures.resultSafetyAfter || 0)
    && Number(candidateFeatures.missedKoksRescue || 0)
      <= Number(selectedFeatures.missedKoksRescue || 0)
    && Number(candidateFeatures.homeShuffleMoves || 0)
      <= Number(selectedFeatures.homeShuffleMoves || 0)
    && Number(candidateFeatures.maxRouteTowerAfter || 0)
      <= Number(selectedFeatures.maxRouteTowerAfter || 0) + 1
    && Number(candidateFeatures.primeRunAfter || 0)
      >= Number(selectedFeatures.primeRunAfter || 0)
    && Number(candidateFeatures.trapDelta || 0)
      >= Number(selectedFeatures.trapDelta || 0) - 1
    && Number(candidateFeatures.fenceClosureDelta || 0)
      >= Number(selectedFeatures.fenceClosureDelta || 0) - 1
    && Number(candidateFeatures.prospectiveFenceInterruptionBreak || 0)
      <= Number(selectedFeatures.prospectiveFenceInterruptionBreak || 0) + 5
    && Number(candidateFeatures.escapeGatewayDelta || 0)
      >= Number(selectedFeatures.escapeGatewayDelta || 0) - 2
    && Number(candidateFeatures.opponentMoveBlockGain || 0)
      >= Number(selectedFeatures.opponentMoveBlockGain || 0) - 8
    && Number(candidateFeatures.headLandingBreak || 0)
      <= Number(selectedFeatures.headLandingBreak || 0) + 12;
  if (!progressIsPreserved) return false;

  return Number(candidateTactical.expectedImpact || 0)
      >= Number(selectedTactical.expectedImpact || 0) - 3000000
    && Number(candidateTactical.worstImpact || 0)
      >= Number(selectedTactical.worstImpact || 0) - 5000000
    && Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) + 10000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) + 5000000
    && Number(candidateTactical.recoveryTailRisk || 0)
      >= Number(selectedTactical.recoveryTailRisk || 0) + 5000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) + 50000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) + 75000000
    && Number(candidateTactical.continuationTailRisk || 0)
      >= Number(selectedTactical.continuationTailRisk || 0) + 50000000;
}

function isAnalyzedProspectiveFenceInterruption(state, color, candidate, selected) {
  const candidateFeatures = candidate?.features || {};
  const selectedFeatures = selected?.features || {};
  const candidateTactical = candidate?.tactical;
  const selectedTactical = selected?.tactical;
  if (
    !candidateTactical
    || !selectedTactical
    || Number(selectedFeatures.prospectiveFenceInterruptionBreak || 0) < 80
    || Number(candidateFeatures.prospectiveFenceInterruptionBreak || 0) > 5
    || Number(candidateFeatures.prospectiveFenceExtensionDelta || 0) < 0
    || Number(candidateFeatures.prospectiveFenceExtensionDelta || 0)
      < Number(selectedFeatures.prospectiveFenceExtensionDelta || 0) + 80
    || Number(candidateFeatures.prospectiveFenceExtensionAfter || 0)
      > Number(selectedFeatures.prospectiveFenceExtensionAfter || 0) - 80
    || Number(candidate.baseScore || 0) < Number(selected.baseScore || 0)
  ) {
    return false;
  }

  if (!hasBoundedFourPlyTactical(candidate) || !hasBoundedFourPlyTactical(selected)) {
    return false;
  }

  const progressIsPreserved = Number(candidateFeatures.headGain || 0)
      >= Number(selectedFeatures.headGain || 0)
    && Number(candidateFeatures.outsideReduction || 0)
      >= Number(selectedFeatures.outsideReduction || 0)
    && Number(candidateFeatures.outsidePipGain || 0)
      >= Number(selectedFeatures.outsidePipGain || 0)
    && Number(candidateFeatures.startZoneReduction || 0)
      >= Number(selectedFeatures.startZoneReduction || 0)
    && Number(candidateFeatures.resultSafetyAfter || 0)
      >= Number(selectedFeatures.resultSafetyAfter || 0)
    && Number(candidateFeatures.missedKoksRescue || 0)
      <= Number(selectedFeatures.missedKoksRescue || 0)
    && Number(candidateFeatures.homeShuffleMoves || 0)
      <= Number(selectedFeatures.homeShuffleMoves || 0)
    && Number(candidateFeatures.maxRouteTowerAfter || 0)
      <= Number(selectedFeatures.maxRouteTowerAfter || 0)
    && Number(candidateFeatures.primeRunAfter || 0)
      >= Number(selectedFeatures.primeRunAfter || 0)
    && Number(candidateFeatures.trapDelta || 0)
      >= Number(selectedFeatures.trapDelta || 0) - 1
    && Number(candidateFeatures.fenceClosureDelta || 0)
      >= Number(selectedFeatures.fenceClosureDelta || 0) - 1
    && Number(candidateFeatures.escapeGatewayDelta || 0)
      >= Number(selectedFeatures.escapeGatewayDelta || 0) - 2
    && Number(candidateFeatures.opponentMoveBlockGain || 0)
      >= Number(selectedFeatures.opponentMoveBlockGain || 0) - 2
    && Number(candidateFeatures.headLandingBreak || 0)
      <= Number(selectedFeatures.headLandingBreak || 0) + 18;
  if (!progressIsPreserved) return false;

  return Number(candidateTactical.expectedImpact || 0)
      >= Number(selectedTactical.expectedImpact || 0) - 3000000
    && Number(candidateTactical.worstImpact || 0)
      >= Number(selectedTactical.worstImpact || 0) - 5000000
    && Number(candidateTactical.recoveryExpected || 0)
      >= Number(selectedTactical.recoveryExpected || 0) - 5000000
    && Number(candidateTactical.recoveryWorst || 0)
      >= Number(selectedTactical.recoveryWorst || 0) - 25000000
    && Number(candidateTactical.recoveryTailRisk || 0)
      >= Number(selectedTactical.recoveryTailRisk || 0) - 5000000
    && Number(candidateTactical.continuationExpected || 0)
      >= Number(selectedTactical.continuationExpected || 0) + 5000000
    && Number(candidateTactical.continuationWorst || 0)
      >= Number(selectedTactical.continuationWorst || 0) - 5000000
    && Number(candidateTactical.continuationTailRisk || 0)
      >= Number(selectedTactical.continuationTailRisk || 0) + 5000000;
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
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || !isPlausibleContestedOpponentHeadExit(state, color, candidate, selected)
    || !hasFiniteTacticalMetrics(candidate, [
      'plies',
      'expectedImpact',
      'worstImpact',
      'recoveryTailRisk',
      'recoveryWorst',
      'continuationTailRisk',
      'continuationWorst',
    ])
    || !hasFiniteTacticalMetrics(selected, [
      'plies',
      'expectedImpact',
      'worstImpact',
      'recoveryTailRisk',
      'recoveryWorst',
      'continuationTailRisk',
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
    && Number(candidate.tactical.recoveryTailRisk || 0)
      + Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.recoveryTailRisk || 0)
        + Number(selected.tactical.continuationTailRisk || 0) + 30000000
    && Number(candidate.tactical.recoveryWorst || 0)
      + Number(candidate.tactical.continuationWorst || 0)
      >= Number(selected.tactical.recoveryWorst || 0)
        + Number(selected.tactical.continuationWorst || 0) + 30000000
    && Number(candidate.tactical.continuationTailRisk || 0)
      >= Number(selected.tactical.continuationTailRisk || 0) + 10000000
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
    && (
      Number(candidate.features.fenceEscapeTacticalReservation || 0) > 0
      || scoreWithoutExperience(candidate) >= (
        scoreWithoutExperience(selected) - IMMINENT_HEAD_FENCE_SCORE_TOLERANCE
      )
    );
}

export function isAnalyzedImminentHeadFenceAnchor(state, color, candidate, selected) {
  if (
    !hasBoundedFourPlyTactical(candidate)
    || !hasBoundedFourPlyTactical(selected)
    || !isPlausibleImminentHeadFenceAnchor(state, color, candidate, selected)
    || !hasFiniteTacticalMetrics(candidate, [
      'plies',
      'continuationTailRisk',
      'continuationWorst',
    ])
    || !hasFiniteTacticalMetrics(selected, [
      'plies',
      'continuationTailRisk',
      'continuationWorst',
    ])
  ) {
    return false;
  }
  const completeReservation = Number(candidate.features.fenceEscapeTacticalReservation || 0) > 0;
  return Number(candidate.tactical.plies || 0) === Number(selected.tactical.plies || 0)
    && Number(candidate.tactical.plies || 0) >= 4
    && (
      completeReservation
      || (
        Number(candidate.tactical.continuationTailRisk || 0)
          >= Number(selected.tactical.continuationTailRisk || 0)
        && Number(candidate.tactical.continuationWorst || 0)
          >= Number(selected.tactical.continuationWorst || 0)
      )
    );
}

function isPlausibleCriticalHeadFenceEscape(state, color, candidate, selected) {
  return headCheckers(state, color) >= 4
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
  // Shortening an active four by one is eligible for rear-escape analysis only
  // when it clears the exposed start zone without worsening our static safety.
  // This is coverage, not a final override: reply and deep vetoes still apply.
  const clearsExposedFourPrimeRear = primeRunBefore === 4
    && candidateRun >= 3
    && isFourPrimeSelfEscape(candidate.features)
    && candidate.features.latentFenceExposureBefore >= 24
    && candidate.features.latentFenceExposureDelta > 0
    && candidate.features.startZoneReduction > 0
    && candidate.features.resultSafetyAfter > candidate.features.resultSafetyBefore;
  if (activeBlockingPrime && clearsExposedFourPrimeRear) return true;
  return !activeBlockingPrime && candidateRun >= Math.max(1, selectedRun - 1);
}

function scoreWithoutExperience(candidate) {
  return Number(candidate.score)
    - Number(candidate.experienceAdjustment || 0)
    - Number(candidate.features?.policyPromotionAdjustment || 0);
}

function prioritizeExperienceWithinSafetyEnvelope(ranked, coldSelected) {
  if (!coldSelected || ranked.length < 2) return ranked;
  const byLearnedScore = [...ranked].sort((left, right) => right.score - left.score);
  const learnedSelected = byLearnedScore[0];
  const safeCandidates = byLearnedScore.filter(candidate => (
    isExperienceSafeAlternative(candidate, coldSelected)
  ));
  if (!safeCandidates.includes(coldSelected)) safeCandidates.push(coldSelected);
  const safeSet = new Set(safeCandidates);
  safeCandidates.sort((left, right) => right.score - left.score);
  if (learnedSelected !== safeCandidates[0] && !safeSet.has(learnedSelected)) {
    learnedSelected.features.experienceSafetyRejected = 1;
    coldSelected.features.experienceSafetyBaseline = 1;
    coldSelected.features.experienceSafetyOverride = 1;
  }
  return [
    ...safeCandidates,
    ...byLearnedScore.filter(candidate => !safeSet.has(candidate)),
  ];
}

function isExperienceSafeAlternative(candidate, baseline) {
  if (candidate === baseline) return true;
  const features = candidate.features || {};
  const base = baseline.features || {};
  const candidateTactical = candidate.tactical || {};
  const baselineTactical = baseline.tactical || {};
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(baseline) - 18000000
    && Number(features.resultSafetyAfter || 0) >= Number(base.resultSafetyAfter || 0)
    && Number(features.missedKoksRescue || 0) <= Number(base.missedKoksRescue || 0)
    && Number(features.headGain || 0) >= Number(base.headGain || 0)
    && Number(features.startZoneReduction || 0) >= Number(base.startZoneReduction || 0)
    && Number(features.outsideReduction || 0) >= Number(base.outsideReduction || 0)
    && Number(features.outsidePipGain || 0) >= Number(base.outsidePipGain || 0)
    && Number(features.homeShuffleMoves || 0) <= Number(base.homeShuffleMoves || 0)
    && Number(features.avoidableHomeShuffleMoves || 0)
      <= Number(base.avoidableHomeShuffleMoves || 0)
    && Number(features.primeRunAfter || 0) >= Number(base.primeRunAfter || 0)
    && Number(features.primeScoreAfter || 0) >= Number(base.primeScoreAfter || 0) - 1
    && Number(features.maxRouteTowerAfter || 0) <= Number(base.maxRouteTowerAfter || 0) + 1
    && Number(features.trapDelta || 0) >= Number(base.trapDelta || 0) - 2
    && Number(features.fenceClosureDelta || 0) >= Number(base.fenceClosureDelta || 0) - 2
    && Number(features.escapeGatewayDelta || 0) >= Number(base.escapeGatewayDelta || 0) - 4
    && Number(features.latentFenceExposureDelta || 0)
      >= Number(base.latentFenceExposureDelta || 0) - 2
    && Number(features.prospectiveFenceInterruptionBreak || 0)
      <= Number(base.prospectiveFenceInterruptionBreak || 0) + 5
    && Number(features.prospectiveFenceExtensionDelta || 0)
      >= Number(base.prospectiveFenceExtensionDelta || 0) - 5
    && Number(features.opponentHeadFreedomDelta || 0)
      >= Number(base.opponentHeadFreedomDelta || 0) - 2
    && Number(features.opponentMoveBlockAfter || 0)
      >= Number(base.opponentMoveBlockAfter || 0) - 10
    && Number(features.headLandingBreak || 0) <= Number(base.headLandingBreak || 0) + 12
    && Number(candidate.experience?.riskSignal || 0)
      <= Number(baseline.experience?.riskSignal || 0) + 0.75
    && Number(candidate.experience?.mistakeSeverity || 0)
      <= Number(baseline.experience?.mistakeSeverity || 0) + 0.75
    && Number(candidateTactical.expectedImpact || 0)
      >= Number(baselineTactical.expectedImpact || 0) - 8000000
    && Number(candidateTactical.worstImpact || 0)
      >= Number(baselineTactical.worstImpact || 0) - 15000000;
}

export function annotateAvoidableHomeShuffles(ranked, state = null, color = null) {
  ranked.forEach((candidate) => {
    const homeShuffleMoves = Math.max(
      0,
      Number(candidate.features.homeShuffleMoves) || 0,
    );
    if (!homeShuffleMoves) {
      candidate.features.avoidableHomeShuffleMoves = 0;
      return;
    }

    const alternatives = ranked.filter((other) => {
      const directReplacement = state && color
        ? isDirectLateHomeEntryReplacement(state, color, other, candidate)
        : false;
      return other !== candidate
      && Number(other.features.homeShuffleMoves || 0) < homeShuffleMoves
      && (directReplacement || (
        Number(other.features.outsideReduction || 0)
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
    });
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

export function annotateAvoidableProspectiveFenceInterruptions(state, color, ranked) {
  ranked.forEach((candidate) => {
    const breakRisk = Math.max(
      0,
      Number(candidate.features.prospectiveFenceInterruptionBreak) || 0,
    );
    if (!breakRisk) {
      candidate.features.avoidableProspectiveFenceInterruptionBreak = 0;
      return;
    }

    const alternatives = ranked.filter(other => (
      other !== candidate
      && isAnalyzedProspectiveFenceInterruption(state, color, other, candidate)
    ));
    const minimumNecessary = alternatives.length
      ? Math.min(...alternatives.map(other => (
        Math.max(0, Number(other.features.prospectiveFenceInterruptionBreak) || 0)
      )))
      : breakRisk;
    candidate.features.avoidableProspectiveFenceInterruptionBreak = Math.max(
      0,
      breakRisk - minimumNecessary,
    );
  });
  return ranked;
}

export function annotateAvoidableProspectiveFenceAnchorMisses(state, color, ranked) {
  ranked.forEach((candidate) => {
    if (homeReady(state, color)) {
      candidate.features.avoidableProspectiveFenceAnchorMiss = 0;
      return;
    }
    const alternatives = ranked.filter(other => (
      other !== candidate
      && isAnalyzedProspectiveFenceAnchorSafety(other, candidate)
    ));
    candidate.features.avoidableProspectiveFenceAnchorMiss = alternatives.length
      ? Math.max(...alternatives.map(other => Math.max(
        0,
        Number(candidate.features.prospectiveFenceExtensionAfter || 0)
          - Number(other.features.prospectiveFenceExtensionAfter || 0),
      )))
      : 0;
  });
  return ranked;
}

export function isComparableFenceEscape(candidate, selected) {
  if (!candidate?.tactical || !selected?.tactical) return false;
  const experienceSafetyOverride = isExperienceOverruledFenceEscape(candidate, selected);
  return scoreWithoutExperience(candidate) >= scoreWithoutExperience(selected) - 260000000
    && !isDeepFenceSafetyRegression(candidate, selected)
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
      <= Number(selected.features.maxRouteTowerAfter || 0) + 1
    && Number(candidate.features.homeShuffleMoves || 0)
      <= Number(selected.features.homeShuffleMoves || 0)
    && Number(candidate.features.headLandingBreak || 0)
      <= Number(selected.features.headLandingBreak || 0) + 24;
}

export function isDeepFenceSafetyRegression(candidate, selected) {
  const closureRegression = Number(selected.features.fenceClosureDelta || 0)
    - Number(candidate.features.fenceClosureDelta || 0);
  // A marginal utility gain cannot buy substantial closure damage when the
  // all-dice recovery or bounded continuation estimates also regress.
  return hasBoundedFourPlyTactical(candidate)
    && hasBoundedFourPlyTactical(selected)
    && closureRegression > 12
    && (
      Number(candidate.tactical.recoveryExpected || 0)
        < Number(selected.tactical.recoveryExpected || 0) - 12000000
      || Number(candidate.tactical.recoveryTailRisk || 0)
        < Number(selected.tactical.recoveryTailRisk || 0) - 12000000
      || Number(candidate.tactical.continuationWorst || 0)
        < Number(selected.tactical.continuationWorst || 0) - 5000000
      || Number(candidate.tactical.continuationTailRisk || 0)
        < Number(selected.tactical.continuationTailRisk || 0) - 5000000
    );
}

export function hasCompleteThreePlyTactical(candidate) {
  const tactical = candidate?.tactical;
  return Boolean(tactical)
    && Number(tactical.plies || 0) >= 3
    && Number(tactical.rolls || 0) === 21
    && Number(tactical.distributionWeight || 0) === 36
    && tactical.distributionComplete === true
    && tactical.doublesExpanded === true
    && Number(tactical.recoveryRolls || 0) === 21
    && Number(tactical.recoveryWeight || 0) === 36
    && tactical.recoveryDistributionComplete === true
    && hasFiniteTacticalMetrics(candidate, [
      'expectedImpact',
      'worstImpact',
      'recoveryExpected',
      'recoveryWorst',
      'recoveryTailRisk',
    ]);
}

export function hasBoundedFourPlyTactical(candidate) {
  const tactical = candidate?.tactical;
  // This is a valid representative/worst proxy model, not a claim that every
  // recovery board was expanded. Production envelopes use it conservatively.
  return hasCompleteThreePlyTactical(candidate)
    && Number(tactical.plies || 0) >= 4
    && Number(tactical.continuationRolls || 0) === 21
    && Number(tactical.continuationWeight || 0) === 36
    && tactical.continuationDistributionComplete === true
    && tactical.continuationModelComplete === true
    && tactical.continuationModelKind === 'representative-worst-proxy-v1'
    && typeof tactical.continuationApproximate === 'boolean'
    && tactical.continuationCoverageComplete === !tactical.continuationApproximate
    && Number(tactical.continuationFrontierCount || 0) >= 1
    && Number(tactical.continuationFrontierCount || 0) <= 2
    && Number(tactical.continuationTotalFrontierCount || 0)
      >= Number(tactical.continuationFrontierCount || 0)
    && Number(tactical.continuationTotalFrontierCount || 0) <= 21
    && Number(tactical.continuationFrontierWeight || 0) >= 1
    && Number(tactical.continuationFrontierWeight || 0) <= 36
    && Number(tactical.continuationTotalFrontierWeight || 0) === 36
    && Number(tactical.continuationProxyWeight || 0) === 36
    && tactical.continuationApproximate === (
      Number(tactical.continuationFrontierWeight || 0) !== 36
      || Number(tactical.continuationFrontierCount || 0)
        !== Number(tactical.continuationTotalFrontierCount || 0)
    )
    && Number(tactical.continuationWorstRecoveryFrontierWeight || 0) >= 1
    && tactical.continuationRepresentativeFrontierIncluded === true
    && tactical.continuationWorstFrontierIncluded === true
    && hasFiniteTacticalMetrics(candidate, [
      'continuationExpected',
      'continuationWorst',
      'continuationTailRisk',
    ]);
}

export function hasCompleteFourPlyTactical(candidate) {
  const tactical = candidate?.tactical;
  return hasBoundedFourPlyTactical(candidate)
    && tactical.continuationApproximate === false
    && tactical.continuationCoverageComplete === true
    && Number(tactical.continuationFrontierWeight || 0) === 36
    && Number(tactical.continuationFrontierCount || 0)
      === Number(tactical.continuationTotalFrontierCount || 0);
}

export function isExperienceOverruledFenceEscape(candidate, selected) {
  const requiredTacticalMetrics = [
    'plies',
    'expectedImpact',
    'worstImpact',
    'recoveryTailRisk',
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
    && Number(candidate.tactical.recoveryTailRisk || 0)
      >= Number(selected.tactical.recoveryTailRisk || 0)
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
  if (routeProgressPreservesDefense(state, color, features)) {
    score += Math.max(0, Number(features.laggardDebtDelta) || 0)
      * (155000 + developmentPressure(state, color) * 42000);
  }
  return score;
}
