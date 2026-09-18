'use strict';

// Toy native-shaped adapters only: this suite performs no real engine rank,
// training game, or terminal-cohort benchmark. Actual VM loading is identity
// inspection only, and never calls its planner.
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {
  AUDITED_NATIVE_CACHE_POLICY,
  OPTIMIZED_NATIVE_CACHE_POLICY,
  AUDITED_NATIVE_CACHE_POLICIES,
  DEFAULT_ROLLOUT_LIMITS,
  NATIVE_CACHE_VERSION,
  canonicalNativeState,
  createNativeColdCohortCache,
  generatePairedPolicyOutcomes,
  normalizedLimits,
  playTerminalRollout,
} = require('../scripts/long-bot-paired-rollout');
const { loadRuntime } = require('../scripts/generate-long-bot-shadow-replay');

const clone = value => JSON.parse(JSON.stringify(value));
const cold = () => ({ schema: 'long-experience-replay-v1', engineVersion: 'long-analytic-v35',
  size: 0, patterns: [], fingerprint: 'empty', frozen: true });
const limits = overrides => ({ ...DEFAULT_ROLLOUT_LIMITS,
  policy: { ...DEFAULT_ROLLOUT_LIMITS.policy }, ...(overrides || {}) });
const attestation = overrides => ({ ...AUDITED_NATIVE_CACHE_POLICY, runtimeDigest: 'a'.repeat(64), ...(overrides || {}) });
const cursor = (overrides = {}) => ({ seeds: { white: 123, dark: 456 }, rolls: { white: 0, dark: 0 }, ...overrides });

function state(overrides = {}) {
  return { variant: 'long', phase: 'roll', turn: 'white', winner: null, resultType: null,
    points: { 24: { color: 'white', count: 2 }, 12: { color: 'dark', count: 2 } },
    off: { white: 13, dark: 13 }, bar: { white: 0, dark: 0 }, dice: [], rolled: [],
    firstMoveDone: { white: true, dark: true }, headPlayedThisTurn: { white: false, dark: false },
    turnMoves: [], history: [], score: { white: 0, dark: 0 },
    turnClock: { white: 0, dark: 0, active: null, startedAt: null },
    matchScore: { white: 0, dark: 0, target: 5, recordedWinner: null },
    startedAt: 0, finishedAt: null, openingRoll: null, ...overrides };
}

function runtime() {
  const value = { ...AUDITED_NATIVE_CACHE_POLICY, plans: 0, applied: 0, experience: cold() };
  value.engine = {
    policyImplementationId: AUDITED_NATIVE_CACHE_POLICY.policyImplementationId,
    experienceReplaySnapshot: () => clone(value.experience),
    setExperience() {},
    plan(position) {
      value.plans += 1;
      return [{ from: position.turn === 'white' ? 24 : 12, die: position.dice[0] }];
    },
  };
  value.game = {
    applyRoll(position, dice) { position.dice = [...dice]; position.rolled = [...dice]; position.phase = 'move'; },
    applyMove(position, from, die) {
      value.applied += 1;
      if (!position.points[from] || position.points[from].color !== position.turn || !position.dice.includes(die)) return false;
      position.points[from].count -= 1;
      if (!position.points[from].count) delete position.points[from];
      position.off[position.turn] += 1;
      position.turnMoves.push({ color: position.turn, from, to: 0, die, bearOff: true });
      position.dice = [];
      if (position.off[position.turn] === 15) { position.winner = position.turn; position.resultType = 'normal'; position.phase = 'over'; }
      return true;
    },
    hasAnyMoves() { return false; },
    endTurn(position) { position.turn = position.turn === 'white' ? 'dark' : 'white'; position.phase = 'roll';
      position.dice = []; position.rolled = []; position.turnMoves = []; },
  };
  return value;
}

test('real optimized native identity enables a separately pinned cache without calling its planner', () => {
  const native = loadRuntime();
  const cache = createNativeColdCohortCache(native, limits());
  assert.equal(cache.observation().enabled, true, cache.observation().bypassReason);
  assert.equal(native.engine.policyImplementationId, OPTIMIZED_NATIVE_CACHE_POLICY.policyImplementationId);
  assert.equal(native.gameBytesDigest, OPTIMIZED_NATIVE_CACHE_POLICY.gameBytesDigest);
  assert.equal(native.runtimeBytesDigest, OPTIMIZED_NATIVE_CACHE_POLICY.runtimeBytesDigest);
  assert.deepEqual(AUDITED_NATIVE_CACHE_POLICIES, [AUDITED_NATIVE_CACHE_POLICY, OPTIMIZED_NATIVE_CACHE_POLICY]);
  assert.equal(Object.isFrozen(AUDITED_NATIVE_CACHE_POLICIES), true);
});

test('historical tuple is preserved; optimized, historical and mixed tuples never share a cache namespace', () => {
  assert.equal(AUDITED_NATIVE_CACHE_POLICY.gameBytesDigest, '769c571ad10cefa75a8c128aba5123df47684780fad1136a0ae98f3342f33e4b');
  assert.equal(AUDITED_NATIVE_CACHE_POLICY.policyImplementationId, 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1');
  assert.equal(AUDITED_NATIVE_CACHE_POLICY.runtimeBytesDigest, '6b503dce9c72d2bdec9180dfe63aa2252b71e8c69095eea13bd1345732940255');
  const oldRuntime = runtime(), optimizedRuntime = runtime();
  Object.assign(optimizedRuntime, OPTIMIZED_NATIVE_CACHE_POLICY);
  optimizedRuntime.engine.policyImplementationId = OPTIMIZED_NATIVE_CACHE_POLICY.policyImplementationId;
  const oldCache = createNativeColdCohortCache(oldRuntime, limits(), attestation());
  const optimizedAttestation = { ...OPTIMIZED_NATIVE_CACHE_POLICY, runtimeDigest: 'a'.repeat(64) };
  const newCache = createNativeColdCohortCache(optimizedRuntime, limits(), optimizedAttestation);
  assert.equal(oldCache.observation().enabled, true);
  assert.equal(newCache.observation().enabled, true);
  assert.notEqual(oldCache.observation().namespaceFingerprint, newCache.observation().namespaceFingerprint);
  assert.equal(createNativeColdCohortCache(optimizedRuntime, limits(), attestation()).observation().bypassReason, 'native-attestation-mismatch');
  for (const field of ['policyImplementationId', 'gameBytesDigest', 'runtimeBytesDigest']) {
    const hybrid = runtime();
    if (field === 'policyImplementationId') hybrid.engine[field] = OPTIMIZED_NATIVE_CACHE_POLICY[field];
    else hybrid[field] = OPTIMIZED_NATIVE_CACHE_POLICY[field];
    assert.equal(createNativeColdCohortCache(hybrid, limits()).observation().bypassReason, 'native-implementation-not-audited');
  }
});

test('normalized mode/caps are explicit, native, bounded and default to audited native cold', () => {
  assert.equal(normalizedLimits().cacheMode, NATIVE_CACHE_VERSION);
  assert.equal(normalizedLimits({ rolloutLimits: { cacheMode: 'off' } }).cacheMode, 'off');
  assert.equal(normalizedLimits({ rolloutLimits: { cacheMode: true } }).cacheMode, 'off');
  for (const [key, bad] of [['cacheMaxEntries', '1'], ['cacheMaxEntries', 4097], ['cacheMaxEntries', null],
    ['cacheMaxBytes', false], ['cacheMaxBytes', 33554433], ['cacheMaxBytes', NaN]]) {
    const normalized = normalizedLimits({ rolloutLimits: { [key]: bad } });
    assert.equal(normalized[key], 0);
    assert.equal(createNativeColdCohortCache(runtime(), normalized).observation().enabled, false);
  }
});

test('canonical exact state ignores only audited native metadata and accepts cross-realm plain JSON', () => {
  const original = state({ phase: 'move', dice: [2, 4], rolled: [2, 4] });
  const before = clone(original);
  const cache = createNativeColdCohortCache(runtime(), limits(), attestation());
  cache.putValidatedPlan(original, [{ from: 24, die: 2 }]);
  const metadata = clone(original);
  metadata.history = [{ arbitrary: 'history' }]; metadata.startedAt = 999;
  metadata.turnClock.white = 100; metadata.score.dark = 6; metadata.matchScore.target = 9;
  metadata.analysis = { botMemory: { hugeButPlain: [1, 2, 3] } };
  metadata.openingRoll = { host: { value: 6 }, guest: { value: 1 } };
  assert.deepEqual(cache.getPlan(metadata), [{ from: 24, die: 2 }]);
  assert.equal(canonicalNativeState(original), canonicalNativeState(vm.runInNewContext(`(${JSON.stringify(original)})`)));
  assert.deepEqual(original, before);
});

test('every rule-relevant field, ordered dice/rolled and ordered moves distinguish plan keys', () => {
  const original = state({ phase: 'move', dice: [2, 4], rolled: [2, 4] });
  const cache = createNativeColdCohortCache(runtime(), limits(), attestation());
  cache.putValidatedPlan(original, [{ from: 24, die: 2 }]);
  const variants = [
    { phase: 'roll' }, { turn: 'dark' }, { dice: [4, 2] }, { rolled: [4, 2] },
    { firstMoveDone: { white: false, dark: true } }, { headPlayedThisTurn: { white: true, dark: false } },
    { points: { 23: { color: 'white', count: 2 }, 12: { color: 'dark', count: 2 } } },
    { points: { 24: { color: 'white', count: 1 }, 12: { color: 'dark', count: 2 } }, off: { white: 14, dark: 13 } },
    { turnMoves: [{ color: 'white', from: 24, to: 22, die: 2, bearOff: false }] },
  ];
  for (const changed of variants) assert.equal(cache.getPlan(state({ ...original, ...changed })), null, JSON.stringify(changed));
  const moves = [{ color: 'white', from: 24, to: 22, die: 2, bearOff: false },
    { color: 'white', from: 22, to: 18, die: 4, bearOff: false }];
  const one = state({ ...original, turnMoves: moves });
  cache.putValidatedPlan(one, []);
  assert.equal(cache.getPlan(state({ ...one, turnMoves: [...moves].reverse() })), null);
});

test('getters, proxies, toJSON, unknown fields and malformed native identities bypass without executing hooks', () => {
  let calls = 0;
  const getter = state(); Object.defineProperty(getter, 'analysis', { enumerable: true, get() { calls += 1; return {}; } });
  const json = state({ analysis: { toJSON() { calls += 1; return {}; } } });
  const proxy = new Proxy(state(), { get() { calls += 1; return null; } });
  const inherited = []; Object.setPrototypeOf(inherited, { toJSON() { calls += 1; return []; } });
  const nonenumerable = state(); Object.defineProperty(nonenumerable, 'turn', { enumerable: false, value: 'white' });
  const nullStack = state(); nullStack.points[1] = null;
  const malformed = [getter, json, proxy, nonenumerable, nullStack, state({ analysis: inherited }), state({ outsider: true }), state({ history: null }), state({ score: null }),
    state({ points: { 24: false, 12: { color: 'dark', count: 2 } } }),
    state({ dice: ['2'] }), state({ rolled: [2, 2, 4, 4] }), state({ turnMoves: [null] }),
    state({ off: { white: '13', dark: 13 } }), state({ winner: 'white' }), state({ resultType: 'mars' })];
  for (const value of malformed) assert.equal(canonicalNativeState(value), null);
  assert.equal(calls, 0);
  assert.notEqual(canonicalNativeState(state({ rolled: [2, 2, 2, 2] })), null);
});

test('plan data is independently cloned and only native ordered from/die arrays are stored', () => {
  const cache = createNativeColdCohortCache(runtime(), limits());
  const position = state(); const plan = [{ from: 24, die: 2 }];
  cache.putValidatedPlan(position, plan); plan[0].die = 6;
  const returned = cache.getPlan(position); returned[0].from = 12;
  assert.deepEqual(cache.getPlan(position), [{ from: 24, die: 2 }]);
  for (const invalid of [[{ from: '24', die: 2 }], [{ from: 24, die: 2, unknown: 1 }], { 0: plan[0], length: 1 }, [null]]) {
    const fresh = createNativeColdCohortCache(runtime(), limits()); fresh.putValidatedPlan(position, invalid);
    assert.equal(fresh.getPlan(position), null);
  }
});

test('exact preimage equality survives a forced hash collision', () => {
  const cache = createNativeColdCohortCache(runtime(), limits(), {}, () => 'collision');
  const one = state(), two = state({ turn: 'dark' });
  cache.putValidatedPlan(one, [{ from: 24, die: 2 }]);
  assert.equal(cache.getPlan(two), null);
  cache.putValidatedPlan(two, [{ from: 12, die: 2 }]);
  assert.equal(cache.getPlan(one), null);
  assert.deepEqual(cache.getPlan(two), [{ from: 12, die: 2 }]);
});

test('entry/byte caps bound shared plan and suffix LRU with safe eviction misses', () => {
  const cache = createNativeColdCohortCache(runtime(), limits({ cacheMaxEntries: 1 }));
  const one = state(), two = state({ turn: 'dark' });
  cache.putValidatedPlan(one, []); cache.putTerminalSuffix(two, cursor(), { complete: true, winner: 'dark', plies: 3 });
  assert.equal(cache.getPlan(one), null); assert.equal(cache.getSuffix(two, cursor()).winner, 'dark');
  assert.equal(cache.observation().entries, 1); assert.equal(cache.observation().evictions, 1);
  const tooSmall = createNativeColdCohortCache(runtime(), limits({ cacheMaxBytes: 1 }));
  tooSmall.putValidatedPlan(one, []); assert.equal(tooSmall.getPlan(one), null); assert.equal(tooSmall.observation().bytes, 0);
});

test('unknown policy/rules/bundle, bad attestation and nonempty/canonical-cold violations bypass', () => {
  for (const mutate of [value => { value.engine.policyImplementationId = 'b'.repeat(64); },
    value => { value.gameBytesDigest = 'b'.repeat(64); }, value => { value.runtimeBytesDigest = 'b'.repeat(64); },
    value => { value.experience.size = 1; }, value => { value.experience.patterns = [{}]; },
    value => { value.experience.size = false; }]) {
    const value = runtime(); mutate(value);
    assert.equal(createNativeColdCohortCache(value, limits()).observation().enabled, false);
  }
  for (const changed of [{ runtimeDigest: '' }, { runtimeDigest: true }, { gameBytesDigest: 'b'.repeat(64) },
    { policyImplementationId: 'b'.repeat(64) }]) {
    assert.equal(createNativeColdCohortCache(runtime(), limits(), attestation(changed)).observation().enabled, false);
  }
  assert.equal(createNativeColdCohortCache(runtime(), limits({ cacheMode: 'off' })).observation().bypassReason, 'cache-off');
});

test('XP, policy, runtime identity, attestation, caps and implementation drift clear/bypass each get/put', () => {
  for (const mutate of [({ value }) => { value.experience.size = 1; },
    ({ value }) => { value.experience.fingerprint = 'other-empty-source'; },
    ({ config }) => { config.policy.analysisNodeBudget += 1; },
    ({ value }) => { value.gameBytesDigest = 'b'.repeat(64); },
    ({ value }) => { value.engine.policyImplementationId = 'b'.repeat(64); },
    ({ proof }) => { proof.runtimeDigest = 'b'.repeat(64); },
    ({ config }) => { config.cacheMaxEntries = 0; },
    ({ value }) => { value.engine.plan = () => []; },
    ({ value }) => { value.game.applyRoll = () => {}; }]) {
    const value = runtime(), config = limits(), proof = attestation();
    const cache = createNativeColdCohortCache(value, config, proof);
    cache.putValidatedPlan(state(), []); assert.equal(cache.observation().entries, 1);
    mutate({ value, config, proof });
    assert.equal(cache.getPlan(state()), null); cache.putValidatedPlan(state(), []);
    assert.equal(cache.observation().enabled, false); assert.equal(cache.observation().entries, 0);
  }
  const one = createNativeColdCohortCache(runtime(), limits(), attestation());
  const two = createNativeColdCohortCache(runtime(), limits(), attestation({ runtimeDigest: 'b'.repeat(64) }));
  assert.notEqual(one.observation().namespaceFingerprint, two.observation().namespaceFingerprint);
});

test('suffix identity binds both seeds and exact per-color roll counters; only complete terminal winner/plies stored', () => {
  const cache = createNativeColdCohortCache(runtime(), limits());
  const position = state(), stream = cursor();
  cache.putTerminalSuffix(position, stream, { complete: true, winner: 'white', plies: 3, botWon: false });
  assert.deepEqual(cache.getSuffix(position, stream), { winner: 'white', plies: 3 });
  for (const changed of [cursor({ seeds: { white: 124, dark: 456 } }), cursor({ seeds: { white: 123, dark: 457 } }),
    cursor({ rolls: { white: 1, dark: 0 } }), cursor({ rolls: { white: 0, dark: 1 } }),
    cursor({ seeds: { white: '123', dark: 456 } }), cursor({ rolls: { white: null, dark: 0 } })]) {
    assert.equal(cache.getSuffix(position, changed), null);
  }
  for (const invalid of [{ complete: false, winner: 'white', plies: 1 }, { complete: true, winner: null, plies: 1 },
    { complete: true, winner: 'white', plies: 0 }, { complete: true, winner: 'white', plies: '3' }]) {
    const fresh = createNativeColdCohortCache(runtime(), limits()); fresh.putTerminalSuffix(position, stream, invalid);
    assert.equal(fresh.getSuffix(position, stream), null);
  }
});

test('toy terminal suffix reuse retains exact winner and total plies and recomputes botWon', () => {
  const value = runtime(), config = limits(), cache = createNativeColdCohortCache(value, config);
  const original = state(), before = clone(original);
  const first = playTerminalRollout(value, original, 'white', cursor().seeds, config, Date.now(), { nativeCache: cache });
  assert.deepEqual(first, { complete: true, winner: 'white', botWon: true, plies: 3 });
  const calls = value.plans;
  const reused = playTerminalRollout(value, original, 'dark', cursor().seeds, config, Date.now(), { nativeCache: cache });
  assert.deepEqual(reused, { complete: true, winner: 'white', botWon: false, plies: 3 });
  assert.equal(value.plans, calls); assert.ok(cache.observation().suffixHits > 0);
  const uncached = playTerminalRollout(runtime(), original, 'dark', cursor().seeds, config, Date.now());
  assert.deepEqual(reused, uncached); assert.deepEqual(original, before);
});

test('plan reuse across different seeds leaves every toy rollout transition/outcome intact', () => {
  const value = runtime(), config = limits(), cache = createNativeColdCohortCache(value, config);
  const original = state({ phase: 'move', dice: [2], rolled: [2, 3] });
  const first = playTerminalRollout(value, original, 'white', { white: 111, dark: 222 }, config, Date.now(), { nativeCache: cache });
  const second = playTerminalRollout(value, original, 'white', { white: 333, dark: 444 }, config, Date.now(), { nativeCache: cache });
  assert.deepEqual(first, second); assert.ok(cache.observation().planHits >= 1);
  assert.equal(value.applied, 6, 'a hit must still execute and validate actual moves');
});

test('deadline before lookup/use and remaining-ply guard cannot be bypassed by a suffix hit', () => {
  const value = runtime(), config = limits(), cache = createNativeColdCohortCache(value, config);
  playTerminalRollout(value, state(), 'white', cursor().seeds, config, Date.now(), { nativeCache: cache });
  const calls = value.plans;
  assert.deepEqual(playTerminalRollout(value, state(), 'white', cursor().seeds, config,
    Date.now() - config.maxElapsedMs - 100, { nativeCache: cache }), { complete: false, reason: 'rollout-time-limit' });
  assert.equal(value.plans, calls);
  assert.deepEqual(playTerminalRollout(value, state(), 'white', cursor().seeds, { ...config, maxPlies: 2 },
    Date.now(), { nativeCache: cache }), { complete: false, reason: 'rollout-ply-limit' });
  const originalNow = Date.now;
  let now = 0;
  const expiresDuringLookup = { enabled: () => true, getSuffix() { now = 101; return { winner: 'white', plies: 1 }; } };
  try {
    Date.now = () => now;
    assert.deepEqual(playTerminalRollout(value, state(), 'white', cursor().seeds, { ...config, maxElapsedMs: 100 },
      0, { nativeCache: expiresDuringLookup }), { complete: false, reason: 'rollout-time-limit' });
    now = 0;
    const expiresDuringPlanLookup = { enabled: () => true,
      getPlan() { now = 101; return [{ from: 24, die: 2 }]; } };
    assert.deepEqual(playTerminalRollout(value, state({ phase: 'move', dice: [2], rolled: [2, 3] }), 'white',
      cursor().seeds, { ...config, maxElapsedMs: 100 }, 0, { nativeCache: expiresDuringPlanLookup }),
    { complete: false, reason: 'rollout-time-limit' });
  } finally { Date.now = originalNow; }
});

test('an injected runtime alone bypasses native cache even when its fingerprints advertise the audited core', async () => {
  const value = runtime();
  const snapshot = state({ phase: 'move', dice: [2], rolled: [2, 3] });
  const afterOne = clone(snapshot); value.game.applyMove(afterOne, 24, 2);
  const candidates = [{ after: afterOne, moves: [{ from: 24, die: 2 }] }, { after: clone(snapshot), moves: [] }];
  const result = await generatePairedPolicyOutcomes({ stateSnapshotV2: snapshot, color: 'white', selected: candidates[0] },
    candidates, { runtime: value, nativeCacheAttestation: attestation() });
  assert.equal(result.ok, true); assert.equal(result.coverage.terminalOutcomes, 64);
  assert.equal(result.cacheObservation.bypassReason, 'custom-runtime-or-runner');
  assert.equal(result.cacheObservation.planHits, 0); assert.equal(result.cacheObservation.suffixHits, 0);
  assert.ok(value.plans >= 64, 'each outcome still invokes its toy planner independently');
});

test('custom outcomeRunner alone bypasses cache with real rules identity but never calls a native planner', async () => {
  const native = loadRuntime();
  const snapshot = state({ phase: 'move', dice: [2, 3], rolled: [2, 3],
    points: { 3: { color: 'white', count: 1 }, 2: { color: 'white', count: 1 }, 12: { color: 'dark', count: 2 } } });
  const actions = [[{ from: 3, die: 3 }, { from: 2, die: 2 }], [{ from: 3, die: 2 }, { from: 2, die: 3 }]];
  const candidates = actions.map(moves => {
    const after = clone(snapshot);
    for (const move of moves) assert.equal(native.game.applyMove(after, move.from, move.die, { autoEnd: false }), true);
    return { moves, after };
  });
  // Outcomes here are mocked, not measured native terminal trajectories.
  let calls = 0;
  const result = await generatePairedPolicyOutcomes({ stateSnapshotV2: snapshot, color: 'white', selected: candidates[0] },
    candidates, { outcomeRunner: async (_runtime, _after, _color, _seeds, _limits, _started, metadata) => {
      calls += 1; assert.equal(metadata.nativeCache, null);
      return { complete: true, winner: 'white', botWon: true, plies: 1 };
    } });
  assert.equal(result.ok, true); assert.equal(calls, 64);
  assert.equal(result.cacheObservation.bypassReason, 'custom-runtime-or-runner');
});

test('illegal/incomplete/censored toy rollouts never store an unvalidated plan or terminal suffix', () => {
  for (const failure of ['illegal', 'incomplete', 'phase', 'ply']) {
    const value = runtime(), config = limits({ maxPlies: 1 });
    if (failure === 'illegal') value.game.applyMove = () => false;
    if (failure === 'incomplete') value.game.hasAnyMoves = () => true;
    if (failure === 'phase') value.game.applyRoll = () => {};
    const cache = createNativeColdCohortCache(value, config);
    const result = playTerminalRollout(value, state(), 'white', cursor().seeds, config, Date.now(), { nativeCache: cache });
    assert.equal(result.complete, false);
    assert.equal(cache.getSuffix(state(), cursor()), null);
    if (failure !== 'ply') assert.equal(cache.observation().entries, 0);
    // A fully validated individual plan may be cached even if its later
    // trajectory hits the ply cap; that is not a terminal suffix or label.
  }
});

test('injected runtime/custom runner bypass still produces ALL K x N separate terminal slots', async () => {
  const value = runtime();
  const snapshot = state({ phase: 'move', dice: [2], rolled: [2, 3] });
  const afterOne = clone(snapshot); value.game.applyMove(afterOne, 24, 2);
  const afterTwo = clone(snapshot); afterTwo.points[24].count = 2; afterTwo.off.white = 13;
  // Synthetic complete actions for a custom runner: the second legal-shaped
  // action is a pass under this toy adapter, never a native training label.
  const candidates = [{ after: afterOne, moves: [{ from: 24, die: 2 }] }, { after: afterTwo, moves: [] }];
  const decision = { stateSnapshotV2: snapshot, color: 'white', selected: candidates[0] };
  let calls = 0;
  const result = await generatePairedPolicyOutcomes(decision, candidates, { runtime: value,
    nativeCacheAttestation: attestation(), outcomeRunner: async (_runtime, _state, _color, _seeds, _limits, _started, metadata) => {
      calls += 1; assert.equal(metadata.nativeCache, null);
      return { complete: true, winner: 'white', botWon: true, plies: 1 };
    } });
  assert.equal(result.ok, true); assert.equal(calls, 64);
  assert.equal(result.coverage.terminalOutcomes, 64); assert.equal(result.coverage.samplesPerCandidate, 32);
  assert.equal(result.coverage.completedTerminalOutcomes, 64); assert.equal(result.coverage.requiredTerminalOutcomes, 64);
  assert.equal(result.cacheObservation.enabled, false);
  assert.equal(result.cacheObservation.bypassReason, 'custom-runtime-or-runner');
  assert.equal(result.coverage.confidenceMethod, 'hoeffding-union-bound-v1');
});

test('incomplete endpoint reports only already completed progress and creates no partial causal evidence', async () => {
  const value = runtime(), snapshot = state({ phase: 'move', dice: [2], rolled: [2, 3] });
  const after = clone(snapshot); value.game.applyMove(after, 24, 2);
  const candidates = [{ after, moves: [{ from: 24, die: 2 }] }, { after: clone(snapshot), moves: [] }];
  let calls = 0;
  const result = await generatePairedPolicyOutcomes({ stateSnapshotV2: snapshot, color: 'white', selected: candidates[0] },
    candidates, { runtime: value, outcomeRunner: async () => {
      calls += 1;
      return calls === 4 ? { complete: false, reason: 'rollout-time-limit' }
        : { complete: true, winner: 'white', botWon: true, plies: 1 };
    } });
  assert.equal(result.ok, false); assert.equal(result.reason, 'rollout-time-limit');
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.completedTerminalOutcomes, 3);
  assert.equal(result.coverage.requiredTerminalOutcomes, 64); assert.equal(result.coverage.samplesPerCandidate, 32);
  assert.equal(result.coverage.candidateCount, 2); assert.equal(result.coverage.currentCandidateIndex, 1);
  assert.equal(result.coverage.sample, 1); assert.equal(calls, 4);
  assert.equal(result.candidates, undefined); assert.equal(result.evidence, undefined); assert.equal(result.eligible, undefined);
});
