import { createLongBotEngine } from './engine.ts';
import { createNarduGameAdapter } from './nardu-game-adapter.ts';

const ENGINE_VERSION = 'long-analytic-v35';
// The build injects a noncircular SHA of every policy TS source, game rules
// and production dispatch/weights. Raw unbuilt modules fail closed.
const POLICY_IMPLEMENTATION_ID = typeof NARDU_LONG_BOT_POLICY_IMPLEMENTATION_ID === 'string'
  ? NARDU_LONG_BOT_POLICY_IMPLEMENTATION_ID : '';
// Compatibility is emitted only for a complete exact reviewed source tuple.
// The source-derived implementation ID and existing pattern provenance never
// change; the alias merely permits audited lessons from the equivalent rules.
const LEARNING_COMPATIBILITY = typeof NARDU_LONG_BOT_LEARNING_COMPATIBILITY === 'object'
  && NARDU_LONG_BOT_LEARNING_COMPATIBILITY !== null
  && Object.isFrozen(NARDU_LONG_BOT_LEARNING_COMPATIBILITY)
  && NARDU_LONG_BOT_LEARNING_COMPATIBILITY.schema === 'long-v35-history-free-learning-compat-v1'
  && NARDU_LONG_BOT_LEARNING_COMPATIBILITY.policyImplementationId === POLICY_IMPLEMENTATION_ID
  && NARDU_LONG_BOT_LEARNING_COMPATIBILITY.learningPolicyImplementationId === 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1'
  ? NARDU_LONG_BOT_LEARNING_COMPATIBILITY : null;

function acceptsLearningPolicyImplementationId(value) {
  return /^[0-9a-f]{64}$/.test(POLICY_IMPLEMENTATION_ID)
    && (value === POLICY_IMPLEMENTATION_ID
      || !!LEARNING_COMPATIBILITY && value === LEARNING_COMPATIBILITY.learningPolicyImplementationId);
}
const FROZEN_EXPERIENCE_PREFIX = 'narduh-long-bot-frozen-experience-v35:';
const LEGACY_FROZEN_EXPERIENCE_PREFIXES = [
  'narduh-long-bot-frozen-experience-v34:',
  'narduh-long-bot-frozen-experience-v33:',
  'narduh-long-bot-frozen-experience-v32:',
];
const PRODUCTION_RUNTIME_OPTIONS = Object.freeze({
  strategyProfile: 'v25',
  maxCandidates: 64,
  analysisNodeBudget: 480,
});

export function createBrowserLongBotEngine(game, options = {}) {
  const adapter = createNarduGameAdapter(game);
  const engine = createLongBotEngine(adapter, options);
  const experienceStorage = Object.prototype.hasOwnProperty.call(options, 'experienceStorage')
    ? options.experienceStorage
    : safeSessionStorage();
  let lastDecision = null;
  let decisionSerial = 0;
  let experienceFrozen = false;
  let experienceSessionKey = '';
  const pendingExperienceSources = new Map();
  const appliedExperienceSources = new Map();

  const runtimeDefaults = {
    ...PRODUCTION_RUNTIME_OPTIONS,
    ...(options.runtimeDefaults || {}),
  };
  const effectiveRuntimeOptions = runtimeOptions => ({
    ...runtimeDefaults,
    ...(runtimeOptions || {}),
  });

  // Native rules/evaluation never read durable analysis/botMemory. Carrying it
  // through every JSON-cloned hypothetical board makes search cost grow with
  // the complete game ledger. A production plan also needs no archived history:
  // decisionRecord reads the ORIGINAL state, and returns compact board-only
  // candidate telemetry. Public rank/review results still retain full history;
  // generic engines/custom adapters keep their original full-state contract.
  const searchState = (state, includeHistory = true) => {
    const projected = { ...state };
    delete projected.analysis;
    // Only the installed native planner opts in; arbitrary game factories may
    // implement history-dependent rules. Validate the archive once so cycles,
    // BigInt and malformed toJSON results never become silently valid plans.
    if (!includeHistory && options.historyFreePlanning === true && Array.isArray(state.history)) {
      const archive = JSON.parse(JSON.stringify(state.history));
      if (Array.isArray(archive)) projected.history = [];
    }
    return projected;
  };
  const restoreRankMetadata = (state, ranked) => {
    if (!ranked.length || !Object.prototype.propertyIsEnumerable.call(state, 'analysis')) {
      return ranked;
    }
    // Preserve the historical JSON-clone semantics (including null, undefined,
    // toJSON), while never sharing durable metadata with the input or another
    // returned candidate. Serialize once, then create one independent copy per
    // public result; no hypothetical board contains this payload.
    const serialized = JSON.stringify({ analysis: state.analysis });
    ranked.forEach(candidate => {
      const metadata = JSON.parse(serialized);
      if (Object.prototype.hasOwnProperty.call(metadata, 'analysis')) {
        candidate.after.analysis = metadata.analysis;
      }
    });
    return ranked;
  };

  return {
    plan(state, runtimeOptions = {}) {
      // Never let a failed/empty ranking leak telemetry from the previous turn.
      lastDecision = null;
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      const effectiveOptions = effectiveRuntimeOptions(runtimeOptions);
      const ranked = engine.rank(searchState(state, false), color, effectiveOptions);
      const recorded = decisionRecord(
        state,
        color,
        ranked,
        effectiveOptions.weights,
        engine.experienceSize(),
        experienceSnapshot(),
        decisionSerial + 1,
        effectiveOptions,
      );
      if (recorded) {
        decisionSerial += 1;
        lastDecision = recorded;
      }
      return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
    },

    rank(state, runtimeOptions = {}) {
      lastDecision = null;
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      return restoreRankMetadata(
        state,
        engine.rank(searchState(state), color, effectiveRuntimeOptions(runtimeOptions)),
      );
    },

    describeSequence(state, sequence, runtimeOptions = {}) {
      const color = runtimeOptions.color || state?.turn;
      if (!state || !color || !Array.isArray(sequence) || !sequence.length) return null;
      return engine.describeSequence(
        searchState(state),
        sequence,
        color,
        effectiveRuntimeOptions(runtimeOptions),
      );
    },

    reviewSequenceStatic(state, sequence, runtimeOptions = {}) {
      const color = runtimeOptions.color || state?.turn;
      if (!state || !color || !Array.isArray(sequence) || !sequence.length) return null;
      const effectiveOptions = effectiveRuntimeOptions(runtimeOptions);
      const projected = searchState(state);
      const normalizedSequence = sequence.map(move => ({
        from: Number(move.from),
        die: Number(move.die),
        to: move.bearOff ? 0 : Number(move.to),
        bearOff: Boolean(move.bearOff || Number(move.to) === 0),
      }));
      const described = engine.describeSequence(
        projected,
        normalizedSequence,
        color,
        effectiveOptions,
      );
      if (!described) return null;
      const after = adapter.applySequence(projected, normalizedSequence, color);
      restoreRankMetadata(state, [{ after }]);
      return {
        sequence: normalizedSequence,
        after,
        score: engine.scoreSequence(
          projected,
          normalizedSequence,
          color,
          effectiveOptions.weights,
        ),
        scoreSemantics: 'long-static-evaluator-v1',
        scoreIncludesTacticalSearch: false,
        scoreIncludesExperience: false,
        features: described.features || {},
        experience: described.experience || null,
      };
    },

    evaluateState(state, color = state?.turn, weights = undefined) {
      if (!state || !color) return 0;
      return engine.evaluateState(state, color, weights);
    },

    setExperience(patterns, source = 'runtime') {
      const sourceKey = String(source || 'runtime');
      const snapshot = Array.isArray(patterns)
        ? patterns.filter(pattern => pattern?.creditVersion !== 9 || serverCausalPatterns([pattern]))
          .map(pattern => ({ ...pattern }))
        : [];
      if (experienceFrozen) {
        pendingExperienceSources.set(sourceKey, snapshot);
        return engine.experienceSize();
      }
      appliedExperienceSources.set(sourceKey, snapshot);
      return engine.setExperience(snapshot, sourceKey);
    },

    experienceSize() {
      return engine.experienceSize();
    },

    experienceSnapshotEntries() {
      return engine.experienceSnapshotEntries();
    },

    experienceReplaySnapshot() {
      const identity = experienceSnapshot();
      return {
        schema: 'long-experience-replay-v1',
        engineVersion: ENGINE_VERSION,
        fingerprint: identity.fingerprint,
        size: identity.size,
        frozen: identity.frozen,
        patterns: engine.experienceSnapshotPatterns(),
      };
    },

    beginExperienceSession(sessionKey = '') {
      const nextSessionKey = String(sessionKey || '');
      // Startup recovery can announce the same room more than once. Once its
      // evidence is frozen, reopening that identical session must be a no-op:
      // draining pending sources here would mix lessons fetched mid-game into
      // a decision stream that promises one immutable fingerprint.
      if (
        experienceFrozen
        && nextSessionKey
        && nextSessionKey === experienceSessionKey
      ) {
        return experienceSnapshot();
      }
      experienceFrozen = false;
      engine.setExperience([], 'frozen-session');
      // A restored policy belongs only to its original room. Clear its actual
      // source before applying the latest queued RPC snapshot for a new game.
      engine.setExperience([], 'frozen-session-quarantine');
      pendingExperienceSources.forEach((patterns, source) => {
        appliedExperienceSources.set(source, patterns);
        engine.setExperience(patterns, source);
      });
      pendingExperienceSources.clear();
      experienceSessionKey = nextSessionKey;
      if (restoreFrozenExperience()) experienceFrozen = true;
      return experienceSnapshot();
    },

    freezeExperience(sessionKey = experienceSessionKey) {
      experienceSessionKey = String(sessionKey || experienceSessionKey || '');
      experienceFrozen = true;
      persistFrozenExperience();
      return experienceSnapshot();
    },

    experienceSnapshot,

    consumeLastDecision() {
      const decision = lastDecision;
      lastDecision = null;
      return decision;
    },

    productionOptions: Object.freeze({ ...PRODUCTION_RUNTIME_OPTIONS }),
    version: ENGINE_VERSION,
    policyImplementationId: POLICY_IMPLEMENTATION_ID,
    learningPolicyImplementationId: LEARNING_COMPATIBILITY?.learningPolicyImplementationId || POLICY_IMPLEMENTATION_ID,
    learningCompatibility: LEARNING_COMPATIBILITY,
    acceptsLearningPolicyImplementationId,
  };

  function experienceSnapshot() {
    const serialized = engine.experienceSnapshotEntries();
    const input = JSON.stringify(serialized);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return {
      fingerprint: `lbe8-${(hash >>> 0).toString(16).padStart(8, '0')}`,
      size: engine.experienceSize(),
      frozen: experienceFrozen,
      pendingSources: Array.from(pendingExperienceSources.keys()).sort(),
      pendingPatternCount: Array.from(pendingExperienceSources.values()).reduce(
        (total, patterns) => total + patterns.length,
        0,
      ),
    };
  }

  function frozenStorageKey() {
    return experienceSessionKey ? `${FROZEN_EXPERIENCE_PREFIX}${experienceSessionKey}` : '';
  }

  function restoreFrozenExperience() {
    const key = frozenStorageKey();
    if (!key || !experienceStorage?.getItem) return false;
    try {
      const saved = JSON.parse(experienceStorage.getItem(key) || 'null');
      if (saved?.engineVersion !== ENGINE_VERSION || !Array.isArray(saved.patterns)) return false;
      const emptyQuarantine = saved.trust === 'long-v35-quarantined-empty'
        && saved.patterns.length === 0;
      const serverSnapshot = saved.trust === 'long-v35-server-causal-session-v1'
        && serverCausalPatterns(saved.patterns);
      if (!emptyQuarantine && !serverSnapshot) return false;
      // A prefetch can settle before startup discovers the resumed session.
      // Its live sources must not merge into that game's immutable snapshot;
      // retain their latest payloads for the next session instead.
      appliedExperienceSources.forEach((patterns, source) => {
        if (!pendingExperienceSources.has(source)) {
          pendingExperienceSources.set(source, patterns);
        }
        engine.setExperience([], source);
      });
      appliedExperienceSources.clear();
      engine.setExperience(saved.patterns, 'frozen-session-quarantine');
      return true;
    } catch {
      return false;
    }
  }

  function persistFrozenExperience() {
    const key = frozenStorageKey();
    if (!key || !experienceStorage?.setItem) return false;
    try {
      for (let index = (Number(experienceStorage.length) || 0) - 1; index >= 0; index -= 1) {
        const storedKey = experienceStorage.key?.(index);
        if (
          storedKey !== key
          && (
            storedKey?.startsWith(FROZEN_EXPERIENCE_PREFIX)
            || LEGACY_FROZEN_EXPERIENCE_PREFIXES.some(prefix => storedKey?.startsWith(prefix))
          )
        ) {
          experienceStorage.removeItem?.(storedKey);
        }
      }
      const patterns = engine.experienceSnapshotPatterns();
      const trustedPatterns = serverCausalPatterns(patterns) ? patterns : [];
      experienceStorage.setItem(key, JSON.stringify({
        engineVersion: ENGINE_VERSION,
        policyImplementationId: POLICY_IMPLEMENTATION_ID,
        learningPolicyImplementationId: LEARNING_COMPATIBILITY?.learningPolicyImplementationId || POLICY_IMPLEMENTATION_ID,
        runtimeSourceFingerprints: LEARNING_COMPATIBILITY?.sourceFingerprints || null,
        // Resume the same immutable server-fed policy, not a newer network
        // snapshot. This session cache is not evidence of server provenance:
        // the causal worker still rejects nonempty unsigned recursive memory.
        trust: trustedPatterns.length
          ? 'long-v35-server-causal-session-v1'
          : 'long-v35-quarantined-empty',
        patterns: trustedPatterns,
      }));
      return true;
    } catch {
      return false;
    }
  }
}

function serverCausalPatterns(patterns) {
  return /^[0-9a-f]{64}$/.test(POLICY_IMPLEMENTATION_ID)
    && Array.isArray(patterns) && patterns.length <= 256 && patterns.every(pattern => (
    pattern?.creditVersion === 9
    && pattern?.evidenceSchema === 'long-server-causal-pattern-v1'
    && pattern?.reviewerVersion === 'long-server-causal-review-v1'
    && pattern?.trustDomain === 'nardu/server-long-bot-causal/v1'
    && acceptsLearningPolicyImplementationId(pattern?.policyImplementationId)
    && pattern?.outcomeUsed === false
    && /^[0-9a-f]{64}$/.test(String(pattern.runtimeDigest || ''))
    && /^[0-9a-f]{64}$/.test(String(pattern.aggregateId || ''))
    && Number.isInteger(pattern.samples) && pattern.samples >= 1 && pattern.samples <= 32
    && pattern.losses === pattern.samples && pattern.wins === 0
    && pattern.lossWeight === pattern.samples * 1.5
    && pattern.signalWeight === pattern.samples * 1.5
    && pattern.severeLosses === 0 && pattern.winWeight === 0
  ));
}

function safeSessionStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function decisionRecord(
  state,
  color,
  ranked,
  weights = undefined,
  experienceSize = 0,
  experienceSnapshot = null,
  serial = 1,
  runtimeOptions = {},
) {
  const choiceCount = Math.max(
    1,
    ...ranked.map(candidate => Number(candidate.features?.choiceCount) || 0),
  );
  const uniqueRanked = [];
  const seenPositions = new Set();
  ranked.forEach((candidate) => {
    const key = decisionCandidatePositionKey(candidate);
    if (seenPositions.has(key)) return;
    seenPositions.add(key);
    uniqueRanked.push(candidate);
  });
  const candidates = uniqueRanked.slice(0, 4).map(candidate => ({
    score: Math.round(candidate.score),
    moves: candidate.sequence.map(move => ({
      from: move.from,
      to: move.bearOff ? 0 : move.to,
      die: move.die,
    })),
    after: compactCandidateState(candidate.after),
    features: { ...(candidate.features || {}) },
    tactical: candidate.tactical ? {
      expectedImpact: Math.round(candidate.tactical.expectedImpact),
      worstImpact: Math.round(candidate.tactical.worstImpact),
      rolls: candidate.tactical.rolls,
      distributionWeight: Number(candidate.tactical.distributionWeight) || 0,
      distributionComplete: Boolean(candidate.tactical.distributionComplete),
      adjustment: Math.round(candidate.tactical.adjustment),
      recoveryExpected: Math.round(Number(candidate.tactical.recoveryExpected) || 0),
      recoveryWorst: Math.round(Number(candidate.tactical.recoveryWorst) || 0),
      recoveryRolls: Number(candidate.tactical.recoveryRolls) || 0,
      recoveryTailRisk: Math.round(Number(candidate.tactical.recoveryTailRisk) || 0),
      recoveryTailWeight: Number(candidate.tactical.recoveryTailWeight) || 0,
      recoveryWeight: Number(candidate.tactical.recoveryWeight) || 0,
      recoveryDistributionComplete: Boolean(candidate.tactical.recoveryDistributionComplete),
      recoveryModelKind: String(candidate.tactical.recoveryModelKind || ''),
      recoveryConditional: Boolean(candidate.tactical.recoveryConditional),
      recoveryPrimaryDiceKey: String(candidate.tactical.recoveryPrimaryDiceKey || ''),
      recoveryPrimaryDiceWeight: Number(candidate.tactical.recoveryPrimaryDiceWeight) || 0,
      recoveryPrimaryFrontierCount: Number(candidate.tactical.recoveryPrimaryFrontierCount) || 0,
      recoveryTotalPrimaryFrontierCount: Number(candidate.tactical.recoveryTotalPrimaryFrontierCount) || 0,
      recoveryPrimaryFrontierWeight: Number(candidate.tactical.recoveryPrimaryFrontierWeight) || 0,
      recoveryTotalPrimaryFrontierWeight: Number(candidate.tactical.recoveryTotalPrimaryFrontierWeight) || 0,
      deepAdjustment: Math.round(Number(candidate.tactical.deepAdjustment) || 0),
      continuationExpected: Math.round(Number(candidate.tactical.continuationExpected) || 0),
      continuationWorst: Math.round(Number(candidate.tactical.continuationWorst) || 0),
      continuationRolls: Number(candidate.tactical.continuationRolls) || 0,
      continuationTailRisk: Math.round(Number(candidate.tactical.continuationTailRisk) || 0),
      continuationTailWeight: Number(candidate.tactical.continuationTailWeight) || 0,
      continuationWeight: Number(candidate.tactical.continuationWeight) || 0,
      continuationDistributionComplete: Boolean(candidate.tactical.continuationDistributionComplete),
      continuationModelComplete: Boolean(candidate.tactical.continuationModelComplete),
      continuationModelKind: String(candidate.tactical.continuationModelKind || ''),
      continuationApproximate: candidate.tactical.continuationApproximate !== false,
      continuationCoverageComplete: Boolean(candidate.tactical.continuationCoverageComplete),
      continuationFrontierCount: Number(candidate.tactical.continuationFrontierCount) || 0,
      continuationFrontierWeight: Number(candidate.tactical.continuationFrontierWeight) || 0,
      continuationTotalFrontierCount: Number(candidate.tactical.continuationTotalFrontierCount) || 0,
      continuationTotalFrontierWeight: Number(candidate.tactical.continuationTotalFrontierWeight) || 0,
      continuationProxyWeight: Number(candidate.tactical.continuationProxyWeight) || 0,
      continuationWorstRecoveryFrontierWeight: Number(
        candidate.tactical.continuationWorstRecoveryFrontierWeight
      ) || 0,
      continuationRepresentativeDiceKey: String(candidate.tactical.continuationRepresentativeDiceKey || ''),
      continuationRepresentativeDiceWeight: Number(candidate.tactical.continuationRepresentativeDiceWeight) || 0,
      continuationRepresentativeProxyWeight: Number(candidate.tactical.continuationRepresentativeProxyWeight) || 0,
      continuationWorstRecoveryDiceKey: String(candidate.tactical.continuationWorstRecoveryDiceKey || ''),
      continuationWorstRecoveryDiceWeight: Number(candidate.tactical.continuationWorstRecoveryDiceWeight) || 0,
      continuationWorstRecoveryProxyWeight: Number(candidate.tactical.continuationWorstRecoveryProxyWeight) || 0,
      continuationRepresentativeFrontierIncluded: Boolean(
        candidate.tactical.continuationRepresentativeFrontierIncluded
      ),
      continuationWorstFrontierIncluded: Boolean(
        candidate.tactical.continuationWorstFrontierIncluded
      ),
      continuationAdjustment: Math.round(Number(candidate.tactical.continuationAdjustment) || 0),
      blockedProbability: Number(candidate.tactical.blockedProbability) || 0,
      expectedReplySequences: Number(candidate.tactical.expectedReplySequences) || 0,
      expectedOpponentPipGain: Number(candidate.tactical.expectedOpponentPipGain) || 0,
      expectedOpponentHeadRelease: Number(candidate.tactical.expectedOpponentHeadRelease) || 0,
      expectedOpponentOutsideReduction: Number(candidate.tactical.expectedOpponentOutsideReduction) || 0,
      doublesExpanded: Boolean(candidate.tactical.doublesExpanded),
      replyCoverageExpanded: Boolean(candidate.tactical.replyCoverageExpanded),
      plies: Number(candidate.tactical.plies) || 2,
    } : null,
    experience: candidate.experience ? { ...candidate.experience } : null,
    experienceAdjustment: Math.round(Number(candidate.experienceAdjustment) || 0),
  }));
  if (!candidates.length) return null;

  const positionId = positionFingerprint(state, color);
  const stateSnapshotV2 = longStateSnapshotV2(state, color);
  const stateFingerprintV2 = snapshotFingerprintV2(stateSnapshotV2);
  const rankingCandidateCount = uniqueRanked.length;
  return {
    id: `${positionId}-${Date.now().toString(36)}-${String(Math.max(1, Number(serial) || 1)).padStart(4, '0')}`,
    positionId,
    source: 'engine',
    at: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    choiceCount,
    experienceSize: Math.max(0, Number(experienceSize) || 0),
    experienceFingerprint: String(experienceSnapshot?.fingerprint || ''),
    experienceFrozen: Boolean(experienceSnapshot?.frozen),
    stateSnapshotV2,
    stateFingerprintV2,
    replayInput: {
      schema: 'long-shadow-replay-input-v1',
      stateFingerprintV2,
      engineVersion: ENGINE_VERSION,
      experienceFingerprint: String(experienceSnapshot?.fingerprint || ''),
      experienceSize: Math.max(0, Number(experienceSize) || 0),
      experienceFrozen: Boolean(experienceSnapshot?.frozen),
      runtime: compactRuntimeOptions(runtimeOptions),
      // Only the displayed top candidates are archived here. A reviewer must
      // rebuild the complete candidate cohort from stateSnapshotV2 and must
      // not mistake this bounded preview for complete counterfactual proof.
      archivedCandidateCount: candidates.length,
      rankingCandidateCount,
      archivedCandidatesComplete: candidates.length === rankingCandidateCount,
    },
    weights: weights && typeof weights === 'object'
      ? Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Math.round(Number(value) || 0)]))
      : {},
    color,
    dice: [...(state.dice || [])],
    position: {
      points: JSON.parse(JSON.stringify(state.points || {})),
      off: { white: Number(state.off?.white) || 0, dark: Number(state.off?.dark) || 0 },
    },
    selected: candidates[0],
    alternatives: candidates.slice(1),
    experience: candidates[0].experience ? { ...candidates[0].experience } : null,
  };
}

function compactRuntimeOptions(runtimeOptions = {}) {
  const compact = {
    strategyProfile: String(runtimeOptions.strategyProfile || ''),
    maxCandidates: Math.max(0, Number(runtimeOptions.maxCandidates) || 0),
    analysisNodeBudget: Math.max(0, Number(runtimeOptions.analysisNodeBudget) || 0),
  };
  if (runtimeOptions.weights && typeof runtimeOptions.weights === 'object') {
    compact.weights = Object.fromEntries(
      Object.entries(runtimeOptions.weights)
        .map(([key, value]) => [key, Number(value)])
        .filter(([, value]) => Number.isFinite(value)),
    );
  }
  return compact;
}

function compactPoints(points = {}) {
  return Object.fromEntries(
    Object.entries(points)
      .filter(([, stack]) => stack && Number(stack.count) > 0)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([point, stack]) => [point, {
        color: String(stack.color || ''),
        count: Number(stack.count) || 0,
      }]),
  );
}

function compactCandidateState(state = {}) {
  return {
    points: compactPoints(state.points),
    bar: {
      white: Number(state.bar?.white) || 0,
      dark: Number(state.bar?.dark) || 0,
    },
    off: {
      white: Number(state.off?.white) || 0,
      dark: Number(state.off?.dark) || 0,
    },
  };
}

function longStateSnapshotV2(state = {}, color = state.turn) {
  return {
    schema: 'long-state-v2',
    variant: 'long',
    phase: String(state.phase || 'move'),
    turn: String(color || state.turn || ''),
    points: compactPoints(state.points),
    bar: {
      white: Number(state.bar?.white) || 0,
      dark: Number(state.bar?.dark) || 0,
    },
    off: {
      white: Number(state.off?.white) || 0,
      dark: Number(state.off?.dark) || 0,
    },
    dice: (state.dice || []).map(value => Number(value) || 0),
    rolled: (state.rolled || []).map(value => Number(value) || 0),
    firstMoveDone: {
      white: Boolean(state.firstMoveDone?.white),
      dark: Boolean(state.firstMoveDone?.dark),
    },
    headPlayedThisTurn: {
      white: Boolean(state.headPlayedThisTurn?.white),
      dark: Boolean(state.headPlayedThisTurn?.dark),
    },
    turnMoves: (state.turnMoves || []).map(move => ({
      color: String(move.color || ''),
      from: Number(move.from) || 0,
      to: move.bearOff || Number(move.to) === 0 ? 0 : Number(move.to) || 0,
      die: Number(move.die) || 0,
      bearOff: Boolean(move.bearOff || Number(move.to) === 0),
    })),
  };
}

function snapshotFingerprintV2(snapshot) {
  const input = stableStringify(snapshot || {});
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `lbs2-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

function decisionCandidatePositionKey(candidate) {
  const points = Object.entries(candidate?.after?.points || {})
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([point, stack]) => `${point}:${stack.color}:${stack.count}`)
    .join('|');
  return `${points}|bar:${Number(candidate?.after?.bar?.white) || 0}:${Number(candidate?.after?.bar?.dark) || 0}|off:${Number(candidate?.after?.off?.white) || 0}:${Number(candidate?.after?.off?.dark) || 0}`;
}

function positionFingerprint(state, color) {
  const points = Object.entries(state.points || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([point, stack]) => `${point}:${stack.color[0]}${stack.count}`)
    .join(',');
  const source = `${color}|${(state.dice || []).join(',')}|${points}|${state.off?.white || 0}:${state.off?.dark || 0}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `lb4-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function installBrowserLongBotEngine(root = globalThis) {
  const game = root?.NarduGame;
  if (!game) return null;
  const api = createBrowserLongBotEngine(game, { historyFreePlanning: true });
  root.NarduLongBotEngine = api;
  return api;
}

if (typeof window !== 'undefined') {
  installBrowserLongBotEngine(window);
}
