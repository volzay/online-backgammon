#!/usr/bin/env node
'use strict';

/**
 * Rebuild a bounded counterfactual cohort from durable long-bot telemetry.
 *
 * This module never uses the game result. It verifies the exact state,
 * runtime release and frozen experience snapshot, enumerates every legal
 * resulting board through game.js, then scores every unique board with the
 * explicitly named static evaluator. The static score is deliberately stored
 * as `score`, never as `policyScore`: arbitrary moves discarded by the live
 * tactical beam do not have a faithful full-policy score.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DEFAULT_RUNTIME_PATH = path.join(ROOT, 'long-bot-engine.js');
const DEFAULT_GAME_PATH = path.join(ROOT, 'game.js');
const REVIEWER_VERSION = 'long-counterfactual-review-v1';
const SCORE_SEMANTICS = 'long-static-evaluator-v1';
const DEFAULT_LIMITS = Object.freeze({
  maxLegalSequences: 512,
  maxUniquePositions: 256,
  maxNodes: 512,
  maxElapsedMs: 5000,
});

const runtimeCache = new Map();

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    key(index) { return [...values.keys()][index] ?? null; },
  };
}

function loadRuntime(options = {}) {
  const runtimePath = path.resolve(options.runtimePath || DEFAULT_RUNTIME_PATH);
  const gamePath = path.resolve(options.gamePath || DEFAULT_GAME_PATH);
  const cacheKey = `${gamePath}\n${runtimePath}`;
  if (runtimeCache.has(cacheKey)) return runtimeCache.get(cacheKey);

  const sessionStorage = memoryStorage();
  const quietConsole = options.console || {
    log() {},
    warn() {},
    error() {},
  };
  const window = {};
  const context = {
    window,
    console: quietConsole,
    Date,
    Math,
    JSON,
    URL,
    setTimeout,
    clearTimeout,
    sessionStorage,
  };
  window.window = window;
  window.sessionStorage = sessionStorage;
  vm.createContext(context);
  const gameBytes = fs.readFileSync(gamePath);
  const runtimeBytes = fs.readFileSync(runtimePath);
  vm.runInContext(gameBytes.toString('utf8'), context, { filename: gamePath });
  vm.runInContext(runtimeBytes.toString('utf8'), context, { filename: runtimePath });
  const loaded = {
    game: context.window.NarduGame,
    engine: context.window.NarduLongBotEngine,
    runtimePath,
    gamePath,
    gameBytesDigest: createHash('sha256').update(gameBytes).digest('hex'),
    runtimeBytesDigest: createHash('sha256').update(runtimeBytes).digest('hex'),
  };
  if (!loaded.game || !loaded.engine) {
    throw new Error('shadow runtime did not install NarduGame and NarduLongBotEngine');
  }
  runtimeCache.set(cacheKey, loaded);
  return loaded;
}

function normalizedLimits(options = {}) {
  const source = options.limits || options;
  const integer = (value, fallback) => {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  };
  return {
    maxLegalSequences: integer(source.maxLegalSequences, DEFAULT_LIMITS.maxLegalSequences),
    maxUniquePositions: integer(source.maxUniquePositions, DEFAULT_LIMITS.maxUniquePositions),
    maxNodes: integer(source.maxNodes, DEFAULT_LIMITS.maxNodes),
    maxElapsedMs: integer(source.maxElapsedMs, DEFAULT_LIMITS.maxElapsedMs),
  };
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

function compactAfter(state = {}) {
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

function afterPositionKey(candidate) {
  const after = candidate?.after || candidate;
  if (!after?.points || typeof after.points !== 'object') return '';
  const points = Object.entries(after.points)
    .filter(([, stack]) => stack && Number(stack.count) > 0)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([point, stack]) => `${point}:${String(stack.color || '')}:${Number(stack.count) || 0}`)
    .join('|');
  return `${points}|bar:${Number(after.bar?.white) || 0}:${Number(after.bar?.dark) || 0}|off:${Number(after.off?.white) || 0}:${Number(after.off?.dark) || 0}`;
}

function canonicalMoves(sequence = []) {
  return (Array.isArray(sequence) ? sequence : []).map(move => ({
    from: Number(move?.from) || 0,
    to: move?.bearOff || Number(move?.to) === 0 ? 0 : Number(move?.to) || 0,
    die: Number(move?.die) || 0,
    bearOff: Boolean(move?.bearOff || Number(move?.to) === 0),
  }));
}

function canonicalMoveKey(sequence = []) {
  return canonicalMoves(sequence)
    .map(move => `${move.from}>${move.to}@${move.die}`)
    .join(',');
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

function stateFromSnapshot(snapshot) {
  return {
    variant: 'long',
    phase: String(snapshot.phase || 'move'),
    turn: String(snapshot.turn || ''),
    points: compactPoints(snapshot.points),
    bar: {
      white: Number(snapshot.bar?.white) || 0,
      dark: Number(snapshot.bar?.dark) || 0,
    },
    off: {
      white: Number(snapshot.off?.white) || 0,
      dark: Number(snapshot.off?.dark) || 0,
    },
    score: { white: 0, dark: 0 },
    dice: (snapshot.dice || []).map(value => Number(value) || 0),
    rolled: (snapshot.rolled || []).map(value => Number(value) || 0),
    firstMoveDone: {
      white: Boolean(snapshot.firstMoveDone?.white),
      dark: Boolean(snapshot.firstMoveDone?.dark),
    },
    headPlayedThisTurn: {
      white: Boolean(snapshot.headPlayedThisTurn?.white),
      dark: Boolean(snapshot.headPlayedThisTurn?.dark),
    },
    turnMoves: (snapshot.turnMoves || []).map(move => ({
      color: String(move.color || ''),
      from: Number(move.from) || 0,
      to: move.bearOff || Number(move.to) === 0 ? 0 : Number(move.to) || 0,
      die: Number(move.die) || 0,
      bearOff: Boolean(move.bearOff || Number(move.to) === 0),
    })),
    history: [],
    winner: null,
    resultType: null,
    openingRoll: null,
    startedAt: 0,
    finishedAt: null,
    turnClock: { white: 0, dark: 0, active: null, startedAt: null },
    matchScore: { white: 0, dark: 0, target: 5, recordedWinner: null },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyLegalSequence(game, state, sequence) {
  const after = clone(state);
  for (const move of sequence) {
    if (!game.applyMove(after, Number(move.from), Number(move.die), { autoEnd: false })) {
      return null;
    }
  }
  return after;
}

function replayExperienceForGame(game, decision) {
  return decision?.replayExperience
    || game?.replayExperience
    || game?.analysis?.botMemory?.replayExperience
    || game?.finalState?.analysis?.botMemory?.replayExperience
    || game?.final_state?.analysis?.botMemory?.replayExperience
    || null;
}

function failure(reason, details = {}) {
  return {
    ok: false,
    status: 'insufficient-evidence',
    reason,
    missingEvidence: [reason],
    outcomeUsed: false,
    ...details,
  };
}

function validateIdentity(game, decision) {
  if (!decision?.stateSnapshotV2 || decision.stateSnapshotV2.schema !== 'long-state-v2') {
    return failure('state-snapshot-v2-missing');
  }
  const computedFingerprint = snapshotFingerprintV2(decision.stateSnapshotV2);
  if (
    !decision.stateFingerprintV2
    || decision.stateFingerprintV2 !== computedFingerprint
    || decision.replayInput?.stateFingerprintV2 !== computedFingerprint
  ) {
    return failure('state-fingerprint-v2-mismatch');
  }
  if (!decision.replayInput || decision.replayInput.schema !== 'long-shadow-replay-input-v1') {
    return failure('shadow-replay-input-missing');
  }
  if (
    !decision.engineVersion
    || decision.replayInput.engineVersion !== decision.engineVersion
  ) {
    return failure('engine-version-mismatch');
  }
  if (
    !decision.experienceFingerprint
    || decision.replayInput.experienceFingerprint !== decision.experienceFingerprint
  ) {
    return failure('experience-fingerprint-mismatch');
  }
  if (decision.experienceFrozen !== true || decision.replayInput.experienceFrozen !== true) {
    return failure('experience-not-frozen');
  }
  const runtime = decision.replayInput.runtime;
  if (
    !runtime
    || !String(runtime.strategyProfile || '')
    || !Number.isInteger(Number(runtime.maxCandidates))
    || Number(runtime.maxCandidates) < 1
    || !Number.isInteger(Number(runtime.analysisNodeBudget))
    || Number(runtime.analysisNodeBudget) < 1
  ) {
    return failure('runtime-identity-incomplete');
  }
  const experience = replayExperienceForGame(game, decision);
  if (
    !experience
    || experience.complete !== true
    || experience.frozen !== true
    || !Array.isArray(experience.patterns)
  ) {
    return failure('frozen-experience-snapshot-missing');
  }
  if (
    experience.engineVersion !== decision.engineVersion
    || experience.fingerprint !== decision.experienceFingerprint
    || Number(experience.patternCount) !== experience.patterns.length
  ) {
    return failure('frozen-experience-identity-mismatch');
  }
  return { ok: true, runtime, experience, computedFingerprint };
}

async function generateLongBotShadowReplay(game, decision, options = {}) {
  const startedAt = Date.now();
  const limits = normalizedLimits(options);
  const identity = validateIdentity(game, decision);
  if (!identity.ok) return identity;

  let runtime;
  try {
    runtime = loadRuntime(options);
  } catch (error) {
    return failure('shadow-runtime-load-failed', { detail: String(error?.message || error) });
  }
  if (runtime.engine.version !== decision.engineVersion) {
    return failure('engine-version-mismatch', {
      expectedEngineVersion: decision.engineVersion,
      actualEngineVersion: runtime.engine.version,
    });
  }

  runtime.engine.setExperience(identity.experience.patterns, 'shadow-replay');
  const appliedExperience = runtime.engine.experienceSnapshot();
  if (
    appliedExperience.fingerprint !== decision.experienceFingerprint
    || Number(appliedExperience.size) !== Number(identity.experience.size)
  ) {
    return failure('experience-replay-mismatch', {
      expectedExperienceFingerprint: decision.experienceFingerprint,
      actualExperienceFingerprint: appliedExperience.fingerprint,
    });
  }

  const state = stateFromSnapshot(decision.stateSnapshotV2);
  if (
    state.variant !== 'long'
    || state.phase !== 'move'
    || !['white', 'dark'].includes(state.turn)
    || state.dice.length === 0
  ) {
    return failure('state-snapshot-v2-not-reviewable');
  }

  let legalSequences;
  try {
    legalSequences = runtime.game.bestMoveSequences(state, state.turn)
      .filter(sequence => Array.isArray(sequence) && sequence.length > 0);
  } catch (error) {
    return failure('legal-sequence-enumeration-failed', { detail: String(error?.message || error) });
  }
  if (!legalSequences.length) return failure('legal-candidates-missing');
  if (legalSequences.length > limits.maxLegalSequences) {
    return failure('shadow-replay-legal-sequence-limit', {
      coverage: {
        complete: false,
        legalSequenceCount: legalSequences.length,
        maxLegalSequences: limits.maxLegalSequences,
      },
    });
  }

  const unique = new Map();
  const legalEvaluations = [];
  for (const sequence of legalSequences) {
    if (Date.now() - startedAt > limits.maxElapsedMs) {
      return failure('shadow-replay-time-limit', {
        coverage: { complete: false, elapsedMs: Date.now() - startedAt },
      });
    }
    const after = applyLegalSequence(runtime.game, state, sequence);
    if (!after) return failure('legal-sequence-application-failed');
    const key = afterPositionKey(after);
    if (!key) return failure('legal-candidate-position-missing');
    const current = unique.get(key);
    if (!current || canonicalMoveKey(sequence) < canonicalMoveKey(current.sequence)) {
      unique.set(key, { sequence: canonicalMoves(sequence), after: compactAfter(after) });
    }
    legalEvaluations.push({
      positionKey: key,
      sequence: canonicalMoves(sequence),
      after: compactAfter(after),
    });
    if (unique.size > limits.maxUniquePositions) {
      return failure('shadow-replay-unique-position-limit', {
        coverage: {
          complete: false,
          legalSequenceCount: legalSequences.length,
          discoveredUniquePositions: unique.size,
          maxUniquePositions: limits.maxUniquePositions,
        },
      });
    }
  }
  if (legalEvaluations.length > limits.maxNodes) {
    return failure('shadow-replay-node-limit', {
      coverage: {
        complete: false,
        legalSequenceCount: legalSequences.length,
        expectedCandidates: unique.size,
        requiredNodes: legalEvaluations.length,
        maxNodes: limits.maxNodes,
      },
    });
  }

  const runtimeOptions = {
    ...clone(identity.runtime),
    color: state.turn,
  };
  const evaluatedByPosition = new Map();
  const selectedPositionKey = afterPositionKey(decision.selected);
  const selectedMoveKey = canonicalMoveKey(decision.selected?.moves);
  let nodesUsed = 0;
  const orderedEvaluations = legalEvaluations.sort((left, right) => (
    left.positionKey.localeCompare(right.positionKey)
    || canonicalMoveKey(left.sequence).localeCompare(canonicalMoveKey(right.sequence))
  ));
  for (const legal of orderedEvaluations) {
    if (Date.now() - startedAt > limits.maxElapsedMs) {
      return failure('shadow-replay-time-limit', {
        coverage: {
          complete: false,
          legalSequenceCount: legalSequences.length,
          expectedCandidates: unique.size,
          evaluatedCandidates: evaluatedByPosition.size,
          evaluatedSequences: nodesUsed,
          elapsedMs: Date.now() - startedAt,
        },
      });
    }
    let reviewed;
    try {
      reviewed = runtime.engine.reviewSequenceStatic(state, legal.sequence, runtimeOptions);
    } catch (error) {
      return failure('static-candidate-evaluation-failed', { detail: String(error?.message || error) });
    }
    nodesUsed += 1;
    if (
      !reviewed
      || reviewed.scoreSemantics !== SCORE_SEMANTICS
      || reviewed.scoreIncludesTacticalSearch !== false
      || reviewed.scoreIncludesExperience !== false
      || !Number.isFinite(Number(reviewed.score))
    ) {
      return failure('static-candidate-score-invalid');
    }
    const candidateAfter = compactAfter(reviewed.after);
    if (afterPositionKey(candidateAfter) !== legal.positionKey) {
      return failure('static-candidate-position-mismatch');
    }
    const candidate = {
      after: candidateAfter,
      moves: canonicalMoves(reviewed.sequence),
      score: Number(reviewed.score),
      scoreSemantics: SCORE_SEMANTICS,
      scoreIncludesTacticalSearch: false,
      scoreIncludesExperience: false,
      features: clone(reviewed.features || {}),
      experience: reviewed.experience ? clone(reviewed.experience) : null,
      engineVersion: decision.engineVersion,
      experienceFingerprint: decision.experienceFingerprint,
      stateFingerprintV2: identity.computedFingerprint,
      stateSnapshotV2: clone(decision.stateSnapshotV2),
    };
    const current = evaluatedByPosition.get(legal.positionKey);
    const candidateIsExactSelected = legal.positionKey === selectedPositionKey
      && canonicalMoveKey(candidate.moves) === selectedMoveKey;
    const currentIsExactSelected = legal.positionKey === selectedPositionKey
      && canonicalMoveKey(current?.moves) === selectedMoveKey;
    if (
      !current
      || (candidateIsExactSelected && !currentIsExactSelected)
      || (!currentIsExactSelected && candidate.score > current.score)
      || (
        !currentIsExactSelected
        && candidate.score === current.score
        && canonicalMoveKey(candidate.moves) < canonicalMoveKey(current.moves)
      )
    ) {
      evaluatedByPosition.set(legal.positionKey, candidate);
    }
  }

  const candidates = [...evaluatedByPosition.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, candidate]) => candidate);
  const evaluatedKeys = new Set(candidates.map(afterPositionKey));
  const coverageComplete = candidates.length === unique.size
    && evaluatedKeys.size === unique.size
    && [...unique.keys()].every(key => evaluatedKeys.has(key));
  if (!coverageComplete) {
    return failure('candidate-coverage-incomplete', {
      coverage: {
        complete: false,
        legalSequenceCount: legalSequences.length,
        expectedCandidates: unique.size,
        evaluatedCandidates: candidates.length,
      },
    });
  }
  if (!selectedPositionKey || !evaluatedKeys.has(selectedPositionKey)) {
    return failure('selected-candidate-missing');
  }

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > limits.maxElapsedMs) {
    return failure('shadow-replay-time-limit', {
      coverage: {
        complete: false,
        legalSequenceCount: legalSequences.length,
        expectedCandidates: unique.size,
        evaluatedCandidates: candidates.length,
        evaluatedSequences: nodesUsed,
        elapsedMs,
      },
    });
  }
  return {
    ok: true,
    replay: {
      generatedBy: 'bounded-shadow-replay-v1',
      reviewerVersion: REVIEWER_VERSION,
      engineVersion: decision.engineVersion,
      experienceFingerprint: decision.experienceFingerprint,
      stateFingerprintV2: identity.computedFingerprint,
      stateSnapshotV2: clone(decision.stateSnapshotV2),
      scoreSemantics: SCORE_SEMANTICS,
      scoreIncludesTacticalSearch: false,
      scoreIncludesExperience: false,
      runtime: clone(identity.runtime),
      resourceLimits: limits,
      coverage: {
        complete: true,
        legalSequenceCount: legalSequences.length,
        expectedCandidates: unique.size,
        evaluatedCandidates: candidates.length,
        evaluatedSequences: nodesUsed,
        nodesUsed,
        elapsedMs,
      },
      candidates,
      minRegret: Math.max(0, Number(options.minRegret) || 0),
      minRegretLcb: Math.max(0, Number(options.minRegretLcb) || 0),
      outcomeUsed: false,
      diagnosticOnly: true,
      learningEligible: false,
    },
  };
}

function clearRuntimeCache() {
  runtimeCache.clear();
}

module.exports = {
  DEFAULT_LIMITS,
  REVIEWER_VERSION,
  SCORE_SEMANTICS,
  afterPositionKey,
  canonicalMoveKey,
  canonicalMoves,
  clearRuntimeCache,
  compactAfter,
  generateLongBotShadowReplay,
  loadRuntime,
  replayExperienceForGame,
  snapshotFingerprintV2,
  stableStringify,
  stateFromSnapshot,
  validateIdentity,
};
