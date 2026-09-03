import { createLongBotEngine } from './engine.ts';
import { createNarduGameAdapter } from './nardu-game-adapter.ts';

const ENGINE_VERSION = 'long-analytic-v29';
const FROZEN_EXPERIENCE_PREFIX = 'narduh-long-bot-frozen-experience-v29:';
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

  const runtimeDefaults = {
    ...PRODUCTION_RUNTIME_OPTIONS,
    ...(options.runtimeDefaults || {}),
  };
  const effectiveRuntimeOptions = runtimeOptions => ({
    ...runtimeDefaults,
    ...(runtimeOptions || {}),
  });

  return {
    plan(state, runtimeOptions = {}) {
      // Never let a failed/empty ranking leak telemetry from the previous turn.
      lastDecision = null;
      const color = state?.turn;
      if (!state || (state.variant && state.variant !== 'long') || !color) return [];
      const effectiveOptions = effectiveRuntimeOptions(runtimeOptions);
      const ranked = engine.rank(state, color, effectiveOptions);
      const recorded = decisionRecord(
        state,
        color,
        ranked,
        effectiveOptions.weights,
        engine.experienceSize(),
        experienceSnapshot(),
        decisionSerial + 1,
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
      return engine.rank(state, color, effectiveRuntimeOptions(runtimeOptions));
    },

    describeSequence(state, sequence, runtimeOptions = {}) {
      const color = runtimeOptions.color || state?.turn;
      if (!state || !color || !Array.isArray(sequence) || !sequence.length) return null;
      return engine.describeSequence(
        state,
        sequence,
        color,
        effectiveRuntimeOptions(runtimeOptions),
      );
    },

    evaluateState(state, color = state?.turn, weights = undefined) {
      if (!state || !color) return 0;
      return engine.evaluateState(state, color, weights);
    },

    setExperience(patterns, source = 'runtime') {
      const sourceKey = String(source || 'runtime');
      const snapshot = Array.isArray(patterns)
        ? patterns.map(pattern => ({ ...pattern }))
        : [];
      if (experienceFrozen) {
        pendingExperienceSources.set(sourceKey, snapshot);
        return engine.experienceSize();
      }
      return engine.setExperience(snapshot, sourceKey);
    },

    experienceSize() {
      return engine.experienceSize();
    },

    experienceSnapshotEntries() {
      return engine.experienceSnapshotEntries();
    },

    beginExperienceSession(sessionKey = '') {
      experienceFrozen = false;
      engine.setExperience([], 'frozen-session');
      pendingExperienceSources.forEach((patterns, source) => {
        engine.setExperience(patterns, source);
      });
      pendingExperienceSources.clear();
      experienceSessionKey = String(sessionKey || '');
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
      fingerprint: `lbe6-${(hash >>> 0).toString(16).padStart(8, '0')}`,
      size: engine.experienceSize(),
      frozen: experienceFrozen,
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
      engine.setExperience(saved.patterns, 'frozen-session');
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
        if (storedKey?.startsWith(FROZEN_EXPERIENCE_PREFIX) && storedKey !== key) {
          experienceStorage.removeItem?.(storedKey);
        }
      }
      experienceStorage.setItem(key, JSON.stringify({
        engineVersion: ENGINE_VERSION,
        patterns: engine.experienceSnapshotPatterns(),
      }));
      return true;
    } catch {
      return false;
    }
  }
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
) {
  const choiceCount = Math.max(
    1,
    ...ranked.map(candidate => Number(candidate.features?.choiceCount) || 0),
  );
  const candidates = ranked.slice(0, 4).map(candidate => ({
    score: Math.round(candidate.score),
    moves: candidate.sequence.map(move => ({
      from: move.from,
      to: move.bearOff ? 0 : move.to,
      die: move.die,
    })),
    features: { ...(candidate.features || {}) },
    tactical: candidate.tactical ? {
      expectedImpact: Math.round(candidate.tactical.expectedImpact),
      worstImpact: Math.round(candidate.tactical.worstImpact),
      rolls: candidate.tactical.rolls,
      adjustment: Math.round(candidate.tactical.adjustment),
      recoveryExpected: Math.round(Number(candidate.tactical.recoveryExpected) || 0),
      recoveryWorst: Math.round(Number(candidate.tactical.recoveryWorst) || 0),
      recoveryRolls: Number(candidate.tactical.recoveryRolls) || 0,
      deepAdjustment: Math.round(Number(candidate.tactical.deepAdjustment) || 0),
      continuationExpected: Math.round(Number(candidate.tactical.continuationExpected) || 0),
      continuationWorst: Math.round(Number(candidate.tactical.continuationWorst) || 0),
      continuationRolls: Number(candidate.tactical.continuationRolls) || 0,
      continuationAdjustment: Math.round(Number(candidate.tactical.continuationAdjustment) || 0),
      blockedProbability: Number(candidate.tactical.blockedProbability) || 0,
      expectedReplySequences: Number(candidate.tactical.expectedReplySequences) || 0,
      expectedOpponentPipGain: Number(candidate.tactical.expectedOpponentPipGain) || 0,
      expectedOpponentHeadRelease: Number(candidate.tactical.expectedOpponentHeadRelease) || 0,
      expectedOpponentOutsideReduction: Number(candidate.tactical.expectedOpponentOutsideReduction) || 0,
      doublesExpanded: Boolean(candidate.tactical.doublesExpanded),
      plies: Number(candidate.tactical.plies) || 2,
    } : null,
    experience: candidate.experience ? { ...candidate.experience } : null,
    experienceAdjustment: Math.round(Number(candidate.experienceAdjustment) || 0),
  }));
  if (!candidates.length) return null;

  const positionId = positionFingerprint(state, color);
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
  const api = createBrowserLongBotEngine(game);
  root.NarduLongBotEngine = api;
  return api;
}

if (typeof window !== 'undefined') {
  installBrowserLongBotEngine(window);
}
