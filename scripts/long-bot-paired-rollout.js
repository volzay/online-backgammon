'use strict';

/** Server-owned counterfactual outcomes, not heuristic scores. */
const crypto = require('node:crypto');
const { types } = require('node:util');
const {
  afterPositionKey,
  canonicalMoveKey,
  loadRuntime,
  stableStringify,
  stateFromSnapshot,
} = require('./generate-long-bot-shadow-replay');
const { createDiceStream } = require('./simulate-long-bot-regression');
const { createTerminalJournal } = require('./long-bot-terminal-journal');

const SCORE_SEMANTICS = 'long-paired-terminal-win-probability-v1';
const NATIVE_CACHE_VERSION = 'native-cold-v1';
// Metadata irrelevance is audited for this exact implementation, not inferred
// merely because a future bundle calls itself v35.
// Earlier C31/C761 audits and their frozen reports remain historical provenance.
// The current self-escape gates consume only points/off-derived native features;
// no ignored history, score, clock, match or analysis metadata enters their keys.
// This explicit re-audit does not relabel any old cohort or artifact.
const AUDITED_NATIVE_CACHE_POLICY = Object.freeze({
  policyImplementationId: 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1',
  gameBytesDigest: '769c571ad10cefa75a8c128aba5123df47684780fad1136a0ae98f3342f33e4b',
  runtimeBytesDigest: '6b503dce9c72d2bdec9180dfe63aa2252b71e8c69095eea13bd1345732940255',
});
// Performance-only re-audit: legal search omits archived history in scratch
// clones. Exact ordered rules/plans are checked in the history-search suite.
// Keep the original tuple and its namespaces unchanged; never mix its hashes
// with this regenerated bundle or relabel historical rollout evidence.
const OPTIMIZED_NATIVE_CACHE_POLICY = Object.freeze({
  policyImplementationId: 'ca0e5738f16583c29dfb84867b159091df30cd1fb5cef2a75e0827a6810c6c8e',
  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',
  runtimeBytesDigest: 'a6ac6f5c9eb3a1858d945cdcc91dd1682a4af8ee1135c8ae9253e6befed318cb',
});
const AUDITED_NATIVE_CACHE_POLICIES = Object.freeze([AUDITED_NATIVE_CACHE_POLICY, OPTIMIZED_NATIVE_CACHE_POLICY]);
const DEFAULT_ROLLOUT_LIMITS = Object.freeze({
  samples: 32,
  minSamples: 32,
  maxUniquePositions: 24,
  maxPlies: 320,
  maxElapsedMs: 300000,
  familywiseAlpha: 0.05,
  minRegretLcb: 0.08,
  cacheMode: NATIVE_CACHE_VERSION,
  cacheMaxEntries: 4096,
  cacheMaxBytes: 8388608,
  policy: Object.freeze({ strategyProfile: 'v25', maxCandidates: 24, analysisNodeBudget: 64 }),
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nativeData(value, seen = new Set(), budget = { nodes: 20000 }, depth = 0) {
  if (--budget.nodes < 0 || depth > 24) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || types.isProxy(value) || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (types.isProxy(prototype)) return false;
  if (prototype !== null) {
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    const expected = Array.isArray(value) ? 'function Array() { [native code] }' : 'function Object() { [native code] }';
    if (typeof constructor !== 'function' || Function.prototype.toString.call(constructor) !== expected) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(prototype) !== null) return false;
  }
  if ('toJSON' in value) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || key === 'toJSON') return false;
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || !nativeData(descriptor.value, seen, budget, depth + 1)) return false;
  }
  seen.delete(value);
  return true;
}

function canonicalNativeState(state) {
  if (!nativeData(state) || !state || state.variant !== 'long' || !['move', 'roll'].includes(state.phase)
    || !['white', 'dark'].includes(state.turn) || state.winner !== null || state.resultType !== null) return null;
  const allowed = new Set(['variant', 'phase', 'turn', 'winner', 'resultType', 'points', 'off', 'bar', 'dice', 'rolled',
    'firstMoveDone', 'headPlayedThisTurn', 'turnMoves', 'score', 'history', 'startedAt', 'finishedAt',
    'turnClock', 'matchScore', 'openingRoll', 'analysis']);
  if (Object.keys(state).some(key => !allowed.has(key)) || !state.points || Array.isArray(state.points)
    || Object.keys(state.points).some(key => !/^(?:[1-9]|1[0-9]|2[0-4])$/.test(key))) return null;
  const totals = { white: 0, dark: 0 };
  const points = Array.from({ length: 24 }, (_, index) => {
    const stack = state.points[index + 1];
    if (stack === undefined) return null;
    if (stack === null) return undefined;
    if (typeof stack !== 'object' || Array.isArray(stack)) return undefined;
    if (!['white', 'dark'].includes(stack.color) || !Number.isSafeInteger(stack.count) || stack.count < 1 || stack.count > 15
      || Object.keys(stack).some(key => !['color', 'count'].includes(key))) return undefined;
    totals[stack.color] += stack.count;
    return [stack.color, stack.count];
  });
  if (points.includes(undefined)) return null;
  for (const color of ['white', 'dark']) {
    if (state.bar?.[color] !== 0 || !Number.isSafeInteger(state.off?.[color]) || state.off[color] < 0
      || state.off[color] > 15 || totals[color] + state.off[color] !== 15
      || typeof state.firstMoveDone?.[color] !== 'boolean' || typeof state.headPlayedThisTurn?.[color] !== 'boolean') return null;
  }
  const validDice = dice => Array.isArray(dice) && dice.length <= 4 && dice.every(die => Number.isSafeInteger(die) && die >= 1 && die <= 6);
  if (!validDice(state.dice) || !validDice(state.rolled) || !Array.isArray(state.turnMoves) || state.turnMoves.length > 4) return null;
  if (state.rolled.length === 4 && !state.rolled.every(die => die === state.rolled[0])) return null;
  if (Object.prototype.hasOwnProperty.call(state, 'history') && !Array.isArray(state.history)) return null;
  for (const key of ['score', 'turnClock', 'matchScore']) {
    if (Object.prototype.hasOwnProperty.call(state, key) && (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key]))) return null;
  }
  const moves = state.turnMoves.map(move => {
    if (!move || typeof move !== 'object' || Array.isArray(move) || !['white', 'dark'].includes(move.color) || !Number.isSafeInteger(move.from) || move.from < 1 || move.from > 24
      || !Number.isSafeInteger(move.to) || move.to < 0 || move.to > 24 || !Number.isSafeInteger(move.die)
      || move.die < 1 || move.die > 6 || typeof move.bearOff !== 'boolean'
      || Object.keys(move).some(key => !['color', 'from', 'to', 'die', 'bearOff'].includes(key))) return undefined;
    return [move.color, move.from, move.to, move.die, move.bearOff];
  });
  if (moves.includes(undefined)) return null;
  return stableStringify({ variant: state.variant, phase: state.phase, turn: state.turn, winner: state.winner,
    resultType: state.resultType, points, off: [state.off.white, state.off.dark], bar: [state.bar.white, state.bar.dark],
    dice: state.dice, rolled: state.rolled, firstMoveDone: [state.firstMoveDone.white, state.firstMoveDone.dark],
    headPlayedThisTurn: [state.headPlayedThisTurn.white, state.headPlayedThisTurn.dark], turnMoves: moves });
}

// Checkpoints are keys only, never passed back to the planner/rules. Excluding
// growing history here keeps suffix scratch memory bounded linearly in plies.
function nativeCacheCheckpoint(state) {
  if (canonicalNativeState(state) === null) return null;
  const checkpoint = {};
  for (const key of ['variant', 'phase', 'turn', 'winner', 'resultType', 'points', 'off', 'bar', 'dice', 'rolled',
    'firstMoveDone', 'headPlayedThisTurn', 'turnMoves']) checkpoint[key] = state[key];
  return clone(checkpoint);
}

function createNativeColdCohortCache(runtime, limits, attestation = {}, hashKey = digest) {
  const stats = { mode: limits.cacheMode, version: NATIVE_CACHE_VERSION, enabled: false, bypassReason: '',
    namespaceFingerprint: null, planHits: 0, planMisses: 0, suffixHits: 0, suffixMisses: 0, evictions: 0, entries: 0, bytes: 0 };
  const entries = new Map();
  const experience = () => runtime.engine.experienceReplaySnapshot?.();
  let initialExperience;
  try { initialExperience = experience(); } catch { /* Bypass uninspectable experience. */ }
  const canonicalCold = value => nativeData(value) && value?.size === 0 && Array.isArray(value.patterns) && value.patterns.length === 0;
  const auditedPolicy = AUDITED_NATIVE_CACHE_POLICIES.find(policy => Object.entries(policy)
    .every(([key, value]) => (key === 'policyImplementationId' ? runtime.engine[key] : runtime[key]) === value));
  if (limits.cacheMode !== NATIVE_CACHE_VERSION) stats.bypassReason = 'cache-off';
  else if (!nativeData(limits.policy) || !nativeData(attestation) || !attestation || Array.isArray(attestation)) stats.bypassReason = 'native-namespace-invalid';
  else if (!Number.isSafeInteger(limits.cacheMaxEntries) || limits.cacheMaxEntries < 1 || limits.cacheMaxEntries > 4096
    || !Number.isSafeInteger(limits.cacheMaxBytes) || limits.cacheMaxBytes < 1 || limits.cacheMaxBytes > 33554432) stats.bypassReason = 'cache-caps-invalid';
  else if (!auditedPolicy) stats.bypassReason = 'native-implementation-not-audited';
  else if (Object.keys(attestation).length && (attestation.policyImplementationId !== runtime.engine.policyImplementationId
    || attestation.gameBytesDigest !== runtime.gameBytesDigest || attestation.runtimeBytesDigest !== runtime.runtimeBytesDigest
    || typeof attestation.runtimeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(attestation.runtimeDigest))) stats.bypassReason = 'native-attestation-mismatch';
  else if (!canonicalCold(initialExperience)) stats.bypassReason = 'experience-not-cold';
  else {
    stats.enabled = true;
    stats.namespaceFingerprint = digest(stableStringify({ version: NATIVE_CACHE_VERSION, ...auditedPolicy,
      workerRuntimeDigest: attestation.runtimeDigest || null, policy: limits.policy, experience: initialExperience,
      node: process.versions.node, v8: process.versions.v8 }));
  }
  const initialCanonical = canonicalCold(initialExperience) ? stableStringify(initialExperience) : null;
  const identity = () => stableStringify({ policyImplementationId: runtime.engine.policyImplementationId,
    gameBytesDigest: runtime.gameBytesDigest, runtimeBytesDigest: runtime.runtimeBytesDigest,
    policy: limits.policy, cacheMode: limits.cacheMode, cacheMaxEntries: limits.cacheMaxEntries,
    cacheMaxBytes: limits.cacheMaxBytes, attestation });
  const initialIdentity = stats.enabled ? identity() : null;
  const planImplementation = runtime.engine.plan;
  const ruleImplementations = ['applyRoll', 'applyMove', 'hasAnyMoves', 'endTurn'].map(key => runtime.game[key]);
  function disable(reason) {
    stats.enabled = false; stats.bypassReason = reason; entries.clear(); stats.entries = 0; stats.bytes = 0;
    return false;
  }
  function guard() {
    if (!stats.enabled) return false;
    if (!nativeData(limits.policy) || !nativeData(attestation) || identity() !== initialIdentity
      || runtime.engine.plan !== planImplementation
      || ['applyRoll', 'applyMove', 'hasAnyMoves', 'endTurn'].some((key, index) => runtime.game[key] !== ruleImplementations[index])) {
      return disable('native-identity-drift');
    }
    let current;
    try { current = experience(); } catch { current = null; }
    if (!canonicalCold(current) || stableStringify(current) !== initialCanonical) {
      return disable('experience-drift');
    }
    return true;
  }
  function canonical(kind, state, cursor) {
    if (!guard()) return null;
    const stateKey = canonicalNativeState(state);
    if (stateKey === null) return null;
    if (kind === 'suffix' && (!nativeData(cursor) || !cursor || !['white', 'dark'].every(color => Number.isSafeInteger(cursor.seeds?.[color])
      && cursor.seeds[color] > 0 && cursor.seeds[color] <= 0xffffffff && Number.isSafeInteger(cursor.rolls?.[color]) && cursor.rolls[color] >= 0))) return null;
    return `${stats.namespaceFingerprint}\0${kind}\0${stateKey}\0${kind === 'suffix' ? stableStringify(cursor) : ''}`;
  }
  function get(kind, state, cursor) {
    const preimage = canonical(kind, state, cursor);
    if (preimage === null) return null;
    const key = hashKey(preimage), entry = entries.get(key);
    if (!entry || entry.preimage !== preimage) { stats[`${kind}Misses`] += 1; return null; }
    entries.delete(key); entries.set(key, entry); stats[`${kind}Hits`] += 1;
    return clone(entry.value);
  }
  function put(kind, state, cursor, value) {
    const preimage = canonical(kind, state, cursor);
    if (preimage === null || !nativeData(value)) return;
    const key = hashKey(preimage), bytes = Buffer.byteLength(preimage) + Buffer.byteLength(stableStringify(value));
    if (bytes > limits.cacheMaxBytes) return;
    if (entries.has(key)) { stats.bytes -= entries.get(key).bytes; entries.delete(key); }
    while (entries.size >= limits.cacheMaxEntries || stats.bytes + bytes > limits.cacheMaxBytes) {
      const oldest = entries.keys().next().value; stats.bytes -= entries.get(oldest).bytes; entries.delete(oldest); stats.evictions += 1;
    }
    entries.set(key, { preimage, value: clone(value), bytes }); stats.bytes += bytes; stats.entries = entries.size;
  }
  return { observation: () => ({ ...stats }), enabled: guard,
    getPlan: state => get('plan', state), putValidatedPlan: (state, plan) => {
      if (nativeData(plan) && Array.isArray(plan) && plan.length <= 4 && plan.every(move => move
        && Number.isSafeInteger(move.from) && move.from >= 1 && move.from <= 24
        && Number.isSafeInteger(move.die) && move.die >= 1 && move.die <= 6
        && Object.keys(move).every(key => ['from', 'die'].includes(key)))) put('plan', state, null, plan);
    },
    getSuffix: (state, cursor) => get('suffix', state, cursor),
    putTerminalSuffix: (state, cursor, terminal) => {
      if (terminal?.complete === true && ['white', 'dark'].includes(terminal.winner)
        && Number.isSafeInteger(terminal.plies) && terminal.plies > 0) put('suffix', state, cursor, { winner: terminal.winner, plies: terminal.plies });
    } };
}

function derivePairedSeeds(stateId, sampleIndex) {
  const seed = color => {
    for (let counter = 0; counter < 100; counter += 1) {
      const bytes = crypto.createHash('sha256')
        .update('nardu/long-causal-rollout/dice/v1\0')
        .update(stateId).update('\0').update(String(sampleIndex))
        .update('\0').update(color).update('\0').update(String(counter)).digest();
      const value = bytes.readUInt32BE(0);
      if (value !== 0) return value;
    }
    throw new Error('Unable to derive a nonzero rollout seed');
  };
  return { white: seed('white'), dark: seed('dark') };
}

function simultaneousHoeffding(wins, samples, candidates, alpha = 0.05) {
  if (!Number.isInteger(wins) || !Number.isInteger(samples) || samples < 1 || wins < 0 || wins > samples) {
    throw new Error('Invalid terminal rollout counts');
  }
  // Each marginal one-sided event receives alpha/(2*K). The union bound
  // remains valid when candidate outcomes share the same future dice.
  const epsilon = Math.sqrt(Math.log(2 * Math.max(1, candidates) / alpha) / (2 * samples));
  const rate = wins / samples;
  return {
    lower: Math.max(0, rate - epsilon),
    upper: Math.min(1, rate + epsilon),
    epsilon,
    method: 'hoeffding-union-bound-v1',
  };
}

function applyCompleteAction(runtime, decision, candidate) {
  const state = stateFromSnapshot(decision.stateSnapshotV2);
  for (const move of candidate.moves || []) {
    if (!runtime.game.applyMove(state, Number(move.from), Number(move.die), { autoEnd: false })) {
      throw new Error('Counterfactual action is illegal');
    }
    if (state.winner) break;
  }
  if (afterPositionKey(state) !== afterPositionKey(candidate)) {
    throw new Error('Counterfactual action after-state mismatch');
  }
  if (!state.winner && runtime.game.hasAnyMoves(state)) {
    throw new Error('Counterfactual action did not consume every required move');
  }
  if (!state.winner) runtime.game.endTurn(state);
  return state;
}

function playTerminalRollout(runtime, afterState, botColor, seeds, limits, startedAt, metadata = {}) {
  const state = clone(afterState);
  const streams = {
    white: createDiceStream(seeds.white),
    dark: createDiceStream(seeds.dark),
  };
  let plies = 0;
  const rolls = { white: 0, dark: 0 };
  const visited = [];
  const cache = metadata.nativeCache;
  // Winner/total-plies is the ONLY rollout result contract. Under the exact
  // audited native cold policy, durable history is write-only telemetry and
  // does not feed rules/features. Do not project it on custom/unknown paths.
  const projectHistory = metadata.nativeHistoryProjection === true && cache?.enabled();
  const expired = () => Date.now() - startedAt > limits.maxElapsedMs;
  function sealVisited(winner, totalPlies) {
    for (const entry of visited) cache.putTerminalSuffix(entry.state, entry.cursor,
      { complete: true, winner, plies: totalPlies - entry.plies });
  }
  while (!state.winner && plies < limits.maxPlies) {
    if (projectHistory && cache.enabled()) state.history = [];
    if (expired()) {
      return { complete: false, reason: 'rollout-time-limit' };
    }
    if (cache?.enabled() && state.phase === 'roll') {
      const cursor = { seeds: { ...seeds }, rolls: { ...rolls } };
      if (expired()) return { complete: false, reason: 'rollout-time-limit' };
      const terminal = cache.getSuffix(state, cursor);
      if (expired()) return { complete: false, reason: 'rollout-time-limit' };
      if (terminal && terminal.plies <= limits.maxPlies - plies) {
        sealVisited(terminal.winner, plies + terminal.plies);
        return { complete: true, winner: terminal.winner, botWon: terminal.winner === botColor, plies: plies + terminal.plies };
      }
      const checkpoint = nativeCacheCheckpoint(state);
      if (checkpoint) visited.push({ state: checkpoint, cursor, plies });
    }
    plies += 1;
    if (state.phase === 'roll') { rolls[state.turn] += 1; runtime.game.applyRoll(state, streams[state.turn].roll()); }
    if (state.phase !== 'move') return { complete: false, reason: 'rollout-phase-invalid' };
    const beforePlan = cache?.enabled() ? nativeCacheCheckpoint(state) : null;
    if (expired()) return { complete: false, reason: 'rollout-time-limit' };
    const cachedPlan = beforePlan ? cache.getPlan(state) : null;
    if (expired()) return { complete: false, reason: 'rollout-time-limit' };
    const plan = cachedPlan || runtime.engine.plan(state, limits.policy);
    let appliedPlanMoves = 0;
    for (const move of Array.isArray(plan) ? plan : []) {
      if (!runtime.game.applyMove(state, move.from, move.die, { autoEnd: false })) {
        return { complete: false, reason: 'rollout-policy-illegal' };
      }
      appliedPlanMoves += 1;
      if (state.winner) break;
    }
    if (!state.winner && runtime.game.hasAnyMoves(state)) {
      return { complete: false, reason: 'rollout-policy-incomplete' };
    }
    if (beforePlan && !cachedPlan && Array.isArray(plan) && appliedPlanMoves === plan.length) cache.putValidatedPlan(beforePlan, plan);
    if (!state.winner) runtime.game.endTurn(state);
  }
  if (!state.winner) return { complete: false, reason: 'rollout-ply-limit' };
  sealVisited(state.winner, plies);
  return {
    complete: true,
    winner: state.winner,
    botWon: state.winner === botColor,
    plies,
  };
}

function normalizedLimits(options = {}) {
  const source = options.rolloutLimits || {};
  const positive = (value, fallback, maximum) => (
    Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback
  );
  return {
    samples: positive(source.samples, DEFAULT_ROLLOUT_LIMITS.samples, 128),
    minSamples: positive(source.minSamples, DEFAULT_ROLLOUT_LIMITS.minSamples, 128),
    maxUniquePositions: positive(source.maxUniquePositions, DEFAULT_ROLLOUT_LIMITS.maxUniquePositions, 256),
    maxPlies: positive(source.maxPlies, DEFAULT_ROLLOUT_LIMITS.maxPlies, 600),
    maxElapsedMs: positive(source.maxElapsedMs, DEFAULT_ROLLOUT_LIMITS.maxElapsedMs, 3600000),
    familywiseAlpha: typeof source.familywiseAlpha === 'number' && source.familywiseAlpha > 0 && source.familywiseAlpha <= 0.05
      ? source.familywiseAlpha : DEFAULT_ROLLOUT_LIMITS.familywiseAlpha,
    minRegretLcb: typeof source.minRegretLcb === 'number' && source.minRegretLcb >= 0.08
      ? source.minRegretLcb : DEFAULT_ROLLOUT_LIMITS.minRegretLcb,
    cacheMode: source.cacheMode === undefined ? DEFAULT_ROLLOUT_LIMITS.cacheMode
      : source.cacheMode === NATIVE_CACHE_VERSION ? NATIVE_CACHE_VERSION : 'off',
    cacheMaxEntries: source.cacheMaxEntries === undefined ? DEFAULT_ROLLOUT_LIMITS.cacheMaxEntries
      : Number.isSafeInteger(source.cacheMaxEntries) && source.cacheMaxEntries >= 1 && source.cacheMaxEntries <= 4096
        ? source.cacheMaxEntries : 0,
    cacheMaxBytes: source.cacheMaxBytes === undefined ? DEFAULT_ROLLOUT_LIMITS.cacheMaxBytes
      : Number.isSafeInteger(source.cacheMaxBytes) && source.cacheMaxBytes >= 1 && source.cacheMaxBytes <= 33554432
        ? source.cacheMaxBytes : 0,
    policy: {
      strategyProfile: 'v25',
      maxCandidates: positive(source.policy?.maxCandidates, DEFAULT_ROLLOUT_LIMITS.policy.maxCandidates, 128),
      analysisNodeBudget: positive(source.policy?.analysisNodeBudget, DEFAULT_ROLLOUT_LIMITS.policy.analysisNodeBudget, 480),
    },
  };
}

function validatePairedOutcomeEvidence(rollout, decision, legalCandidates) {
  const coverage = rollout?.coverage;
  const samples = coverage?.samplesPerCandidate;
  const candidates = Array.isArray(rollout?.candidates) ? rollout.candidates : [];
  const legalKeys = new Set((legalCandidates || []).map(afterPositionKey));
  if (
    rollout?.ok !== true || rollout?.outcomeUsed !== false
    || rollout.scoreSemantics !== SCORE_SEMANTICS
    || coverage?.complete !== true || coverage?.commonDiceStreams !== true
    || coverage?.frozenPolicy !== true || coverage?.confidenceBoundsComplete !== true
    || coverage?.confidenceMethod !== 'hoeffding-union-bound-v1'
    || !Number.isInteger(samples) || samples < 32 || samples > 128
    || candidates.length !== legalKeys.size || candidates.length < 2
    || coverage.candidateCount !== candidates.length
    || coverage.terminalOutcomes !== candidates.length * samples
    || !/^[0-9a-f]{64}$/.test(String(rollout.seedFingerprint || ''))
    || !/^[0-9a-f]{64}$/.test(String(rollout.policyFingerprint || ''))
    || !(rollout.limits?.familywiseAlpha > 0 && rollout.limits.familywiseAlpha <= 0.05)
  ) return 'rollout-evidence-contract-invalid';
  const seen = new Set();
  for (const candidate of candidates) {
    const key = afterPositionKey(candidate);
    if (!legalKeys.has(key) || seen.has(key)) return 'rollout-candidate-coverage-incomplete';
    seen.add(key);
    if (
      candidate.rolloutSamples !== samples
      || !Number.isInteger(candidate.rolloutWins)
      || candidate.rolloutWins < 0 || candidate.rolloutWins > samples
      || !/^[0-9a-f]{64}$/.test(String(candidate.outcomeFingerprint || ''))
    ) return 'rollout-counts-invalid';
    const bounds = simultaneousHoeffding(
      candidate.rolloutWins, samples, candidates.length, rollout.limits.familywiseAlpha,
    );
    if (
      Math.abs(candidate.policyScore - candidate.rolloutWins / samples) > 1e-12
      || Math.abs(candidate.policyScoreLcb - bounds.lower) > 1e-12
      || Math.abs(candidate.policyScoreUcb - bounds.upper) > 1e-12
      || ![candidate.policyScore, candidate.policyScoreLcb, candidate.policyScoreUcb].every(Number.isFinite)
    ) return 'rollout-bounds-invalid';
  }
  const selected = candidates.find(candidate => (
    afterPositionKey(candidate) === afterPositionKey(decision.selected)
    && canonicalMoveKey(candidate.moves) === canonicalMoveKey(decision.selected.moves)
  ));
  if (!selected) return 'rollout-exact-selected-action-missing';
  const recommended = [...candidates].sort((left, right) => (
    right.policyScore - left.policyScore || afterPositionKey(left).localeCompare(afterPositionKey(right))
    || canonicalMoveKey(left.moves).localeCompare(canonicalMoveKey(right.moves))
  ))[0];
  if (
    afterPositionKey(recommended) !== rollout.recommendationPositionKey
    || Math.abs(rollout.regret - (recommended.policyScore - selected.policyScore)) > 1e-12
    || Math.abs(rollout.regretLcb - (recommended.policyScoreLcb - selected.policyScoreUcb)) > 1e-12
    || !Number.isFinite(rollout.regret) || !Number.isFinite(rollout.regretLcb)
  ) return 'rollout-recommendation-contract-invalid';
  return '';
}

function failure(reason, details = {}) {
  return { ok: false, reason, outcomeUsed: false, ...details };
}

async function generatePairedPolicyOutcomes(decision, legalCandidates, options = {}) {
  const limits = normalizedLimits(options);
  if (limits.samples < limits.minSamples || limits.minSamples < 32) {
    return failure('rollout-sample-gate');
  }
  const candidates = [...(Array.isArray(legalCandidates) ? legalCandidates : [])]
    .sort((left, right) => afterPositionKey(left).localeCompare(afterPositionKey(right)));
  if (candidates.length < 2) return failure('rollout-alternatives-missing');
  if (candidates.length > limits.maxUniquePositions) return failure('rollout-position-limit');
  const uniqueKeys = new Set(candidates.map(afterPositionKey));
  if (uniqueKeys.size !== candidates.length || uniqueKeys.has('')) {
    return failure('rollout-candidate-identity-invalid');
  }
  const stateId = digest(`nardu/long-causal-rollout/state/v1\0${stableStringify(decision.stateSnapshotV2)}`);
  const selectedKey = afterPositionKey(decision.selected);
  const selected = candidates.find(candidate => afterPositionKey(candidate) === selectedKey);
  if (!selected) return failure('rollout-selected-candidate-missing');
  const runtime = options.runtime || loadRuntime(options);
  if (options.trustedOfflineTerminalJournal !== undefined && (options.runtime || options.outcomeRunner
    || !options.terminalJournalBindings || !nativeData(options.terminalJournalBindings))) {
    return failure('terminal-journal-requires-verified-native-offline-bindings');
  }
  runtime.engine.setExperience([], 'server-causal-rollout');
  // Advertised native fingerprints are not authority on an injected adapter.
  const bypass = options.runtime || options.outcomeRunner ? 'custom-runtime-or-runner' : '';
  const nativeCache = bypass ? null : createNativeColdCohortCache(runtime, limits, options.nativeCacheAttestation || {});
  const cacheObservation = () => nativeCache ? nativeCache.observation() : {
    mode: limits.cacheMode, version: NATIVE_CACHE_VERSION, enabled: false, bypassReason: bypass,
    namespaceFingerprint: null, planHits: 0, planMisses: 0, suffixHits: 0, suffixMisses: 0,
    evictions: 0, entries: 0, bytes: 0,
  };
  const startedAt = Date.now();
  const accumulators = candidates.map(candidate => ({
    candidate,
    afterState: applyCompleteAction(runtime, decision, candidate),
    outcomes: [],
    wins: 0,
  }));
  const seedsBySample = [];
  const seenSeeds = new Set();
  // Commit all fixed dice streams before the first outcome. Resume cannot
  // choose a subset after observing wins, or turn an old slot into a new seed.
  for (let sample = 0; sample < limits.samples; sample += 1) {
    const seeds = derivePairedSeeds(stateId, sample);
    for (const color of ['white', 'dark']) {
      if (seenSeeds.has(seeds[color])) return failure('rollout-dice-seed-collision');
      seenSeeds.add(seeds[color]);
    }
    seedsBySample.push(seeds);
  }
  const candidateIds = candidates.map(candidate => digest(afterPositionKey(candidate)));
  if (new Set(candidateIds).size !== candidates.length) return failure('rollout-candidate-digest-collision');
  const botColor = decision.color || decision.stateSnapshotV2.turn;
  const journal = options.trustedOfflineTerminalJournal === undefined ? null : createTerminalJournal({
    directory: options.trustedOfflineTerminalJournal.directory,
    manifest: {
      schema: 'long-bot-terminal-cohort-manifest-v1', sampleCount: limits.samples,
      candidateIds, seedsBySample, botColor, maxPlies: limits.maxPlies,
      bindings: {
        ...options.terminalJournalBindings,
        orderedStateCanonical: stableStringify(decision.stateSnapshotV2),
        selectedOrderedMoveKey: canonicalMoveKey(decision.selected.moves),
        selectedAfterPositionKey: selectedKey,
        completeOrderedLegalSet: candidates.map((candidate, index) => ({
          candidateId: candidateIds[index], afterPositionKey: afterPositionKey(candidate),
          orderedMoveKey: canonicalMoveKey(candidate.moves),
        })),
        rolloutLimits: limits,
      },
    },
  });
  let resumedTerminalOutcomes = 0;
  const journalObservation = () => journal ? { ...journal.observation(), resumedTerminalOutcomes } : null;
  let completedTerminalOutcomes = 0;
  const requiredTerminalOutcomes = candidates.length * limits.samples;
  try {
    for (let sample = 0; sample < limits.samples; sample += 1) {
      const seeds = seedsBySample[sample];
      for (const [currentCandidateIndex, accumulator] of accumulators.entries()) {
        if (Date.now() - startedAt > limits.maxElapsedMs) return failure('rollout-time-limit', {
          coverage: { complete: false, sample, evaluatedCandidates: accumulator.outcomes.length,
            completedTerminalOutcomes, requiredTerminalOutcomes, samplesPerCandidate: limits.samples,
            candidateCount: candidates.length, currentCandidateIndex },
          cacheObservation: cacheObservation(),
          ...(journal ? { terminalJournalObservation: journalObservation() } : {}),
        });
        const saved = journal?.lookup(sample, candidateIds[currentCandidateIndex], seeds);
        if (Date.now() - startedAt > limits.maxElapsedMs) return failure('rollout-time-limit', {
          coverage: { complete: false, sample, evaluatedCandidates: accumulator.outcomes.length,
            completedTerminalOutcomes, requiredTerminalOutcomes, samplesPerCandidate: limits.samples,
            candidateCount: candidates.length, currentCandidateIndex },
          cacheObservation: cacheObservation(),
          ...(journal ? { terminalJournalObservation: journalObservation() } : {}),
        });
        const runner = options.outcomeRunner || playTerminalRollout;
        const outcome = saved ? { ...saved, botWon: saved.winner === botColor } : await runner(
          runtime, accumulator.afterState, botColor,
          seeds, limits, startedAt, { sample, candidate: accumulator.candidate, nativeCache,
            nativeHistoryProjection: !bypass && nativeCache?.enabled() === true },
        );
        if (
          !outcome?.complete
          || !['white', 'dark'].includes(outcome.winner)
          || typeof outcome.botWon !== 'boolean'
          || outcome.botWon !== (outcome.winner === botColor)
        ) return failure(outcome?.reason || 'rollout-terminal-outcome-incomplete', {
          // Completed endpoints are diagnostics, NOT partial eligible evidence.
          coverage: { complete: false, sample, evaluatedCandidates: accumulator.outcomes.length,
            completedTerminalOutcomes, requiredTerminalOutcomes, samplesPerCandidate: limits.samples,
            candidateCount: candidates.length, currentCandidateIndex },
          cacheObservation: cacheObservation(),
          ...(journal ? { terminalJournalObservation: journalObservation() } : {}),
        });
        if (saved) resumedTerminalOutcomes += 1;
        else if (journal) journal.commit({ sampleIndex: sample, candidateId: candidateIds[currentCandidateIndex],
          seeds, winner: outcome.winner, plies: outcome.plies, complete: true });
        accumulator.outcomes.push(outcome.botWon ? 1 : 0);
        completedTerminalOutcomes += 1;
        if (outcome.botWon) accumulator.wins += 1;
      }
    }
    const scores = accumulators.map(accumulator => {
      const interval = simultaneousHoeffding(
        accumulator.wins, limits.samples, candidates.length, limits.familywiseAlpha,
      );
      return {
        ...accumulator.candidate,
        policyScore: accumulator.wins / limits.samples,
        policyScoreLcb: interval.lower,
        policyScoreUcb: interval.upper,
        rolloutWins: accumulator.wins,
        rolloutSamples: limits.samples,
        outcomeFingerprint: digest(accumulator.outcomes.join('')),
      };
    });
    const ranked = [...scores].sort((left, right) => (
      right.policyScore - left.policyScore
      || afterPositionKey(left).localeCompare(afterPositionKey(right))
      || canonicalMoveKey(left.moves).localeCompare(canonicalMoveKey(right.moves))
    ));
    const recommendation = ranked[0];
    const selectedScore = scores.find(candidate => afterPositionKey(candidate) === selectedKey);
    const regret = recommendation.policyScore - selectedScore.policyScore;
    const regretLcb = recommendation.policyScoreLcb - selectedScore.policyScoreUcb;
    return {
      ok: true,
      scoreSemantics: SCORE_SEMANTICS,
      recommendation,
      recommendationPositionKey: afterPositionKey(recommendation),
      selected: selectedScore,
      regret,
      regretLcb,
      eligible: regretLcb > limits.minRegretLcb,
      limits,
      coverage: {
        complete: true,
        candidateCount: scores.length,
        samplesPerCandidate: limits.samples,
        terminalOutcomes: scores.length * limits.samples,
        completedTerminalOutcomes,
        requiredTerminalOutcomes,
        commonDiceStreams: true,
        frozenPolicy: true,
        confidenceBoundsComplete: true,
        confidenceMethod: 'hoeffding-union-bound-v1',
      },
      seedFingerprint: digest(stableStringify(seedsBySample)),
      policyFingerprint: digest(stableStringify(limits.policy)),
      candidates: scores,
      outcomeUsed: false,
      cacheObservation: cacheObservation(),
      ...(journal ? { terminalJournalObservation: journalObservation() } : {}),
    };
  } finally {
    journal?.close();
  }
}

module.exports = {
  AUDITED_NATIVE_CACHE_POLICY,
  OPTIMIZED_NATIVE_CACHE_POLICY,
  AUDITED_NATIVE_CACHE_POLICIES,
  DEFAULT_ROLLOUT_LIMITS,
  NATIVE_CACHE_VERSION,
  SCORE_SEMANTICS,
  applyCompleteAction,
  derivePairedSeeds,
  canonicalNativeState,
  createNativeColdCohortCache,
  generatePairedPolicyOutcomes,
  normalizedLimits,
  playTerminalRollout,
  simultaneousHoeffding,
  validatePairedOutcomeEvidence,
};
