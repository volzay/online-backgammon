'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadRuntime, clearRuntimeCache, canonicalMoveKey } = require('../scripts/generate-long-bot-shadow-replay');

const root = path.join(__dirname, '..');
const modules = Promise.all(['metrics', 'analysis', 'evaluator'].map(name => (
  import(pathToFileURL(path.join(root, `bot-engine/long/${name}.ts`)).href)
)));
const copy = value => JSON.parse(JSON.stringify(value));
const fixture = () => ({ variant: 'long', turn: 'white', phase: 'move',
  points: { 24: { color: 'white', count: 10 }, 21: { color: 'white', count: 1 },
    10: { color: 'white', count: 4 }, 12: { color: 'dark', count: 8 },
    9: { color: 'dark', count: 2 }, 2: { color: 'dark', count: 5 } },
  off: { white: 0, dark: 0 } });
const mirror = state => ({ ...copy(state), turn: state.turn === 'white' ? 'dark' : 'white',
  points: Object.fromEntries(Object.entries(state.points).map(([point, stack]) => [
    (Number(point) + 11) % 24 + 1,
    { ...stack, color: stack.color === 'white' ? 'dark' : 'white' },
  ])), off: { white: state.off.dark, dark: state.off.white } });
function observation(descriptor, overrides = {}) {
  return { contextKey: descriptor.contextKey, actionKey: descriptor.actionKey,
    samples: 40, losses: 40, wins: 0, lossWeight: 60, severeLosses: 0,
    signalWeight: 60, winWeight: 0, ...overrides };
}
function causal(descriptor, overrides = {}) {
  return observation(descriptor, { creditVersion: 9, evidenceSchema: 'long-server-causal-pattern-v1',
    samples: 1, losses: 1, lossWeight: 1.5, signalWeight: 1.5, ...overrides });
}

test('quarters retain both colours on the same physical points and exact counts', async () => {
  const [{ quarterPositionProfile }] = await modules;
  const state = fixture();
  const original = copy(state);
  const profile = quarterPositionProfile(state, 'white');
  assert.deepEqual(profile.quarters.map(q => q.ownCount), [11, 0, 4, 0]);
  assert.deepEqual(profile.quarters.map(q => q.opponentCount), [0, 0, 10, 5]);
  assert.deepEqual(profile.quarters[0].own, [10, 0, 0, 1, 0, 0]);
  assert.deepEqual(profile.quarters[2].opponent, [8, 0, 0, 2, 0, 0]);
  assert.deepEqual(profile.quarters[2].own, [0, 0, 4, 0, 0, 0]);
  assert.equal(profile.quarters[0].ownMaxStack, 10);
  assert.equal(profile.quarters[0].ownOccupied, 2);
  assert.equal(profile.quarters[2].opponentOccupied, 2);
  assert.equal(profile.quarters[2].opponentMaxStack, 8);
  assert.equal(/[|]/.test(profile.key) || profile.key.includes('::'), false);
  assert.deepEqual(state, original);
  profile.quarters[0].own[0] = 99;
  assert.equal(quarterPositionProfile(state, 'white').quarters[0].own[0], 10);
});

test('colour rotation preserves relative quarter geometry, including off counts', async () => {
  const [{ quarterPositionProfile }] = await modules;
  const state = fixture();
  state.off = { white: 2, dark: 3 };
  assert.deepEqual(quarterPositionProfile(state, 'white'), quarterPositionProfile(mirror(state), 'dark'));
});

test('equal quarter totals do not conceal different towers or opponent gates', async () => {
  const [{ quarterPositionProfile }] = await modules;
  const state = fixture();
  for (const [from, to] of [[21, 20], [9, 8]]) {
    const changed = copy(state);
    changed.points[to] = changed.points[from];
    delete changed.points[from];
    const a = quarterPositionProfile(state, 'white');
    const b = quarterPositionProfile(changed, 'white');
    assert.deepEqual(a.quarters.map(q => [q.ownCount, q.opponentCount]),
      b.quarters.map(q => [q.ownCount, q.opponentCount]));
    assert.notEqual(a.key, b.key);
  }
  for (const point of [21, 9]) {
    const changed = copy(state);
    changed.points[point].count += 1;
    assert.notEqual(quarterPositionProfile(state, 'white').key, quarterPositionProfile(changed, 'white').key);
  }
  const removed = copy(state);
  removed.off.white = 1;
  assert.notEqual(quarterPositionProfile(state, 'white').key, quarterPositionProfile(removed, 'white').key);
});

test('full-turn analysis describes transfers across quarters and into bearoff', async () => {
  const [{ quarterPositionProfile }, , { sequenceStats }] = await modules;
  const before = { variant: 'long', points: { 19: { color: 'white', count: 1 },
    6: { color: 'white', count: 1 }, 12: { color: 'dark', count: 15 } },
  off: { white: 13, dark: 0 } };
  const after = copy(before);
  delete after.points[19];
  delete after.points[6];
  after.points[18] = { color: 'white', count: 1 };
  after.off.white += 1;
  const features = sequenceStats(before, after, 'white', [
    { from: 19, to: 18, die: 1 }, { from: 6, to: 0, die: 6, bearOff: true },
  ]);
  // This synthetic transition tests the descriptor, not native move legality.
  assert.deepEqual(features.quartersBefore, quarterPositionProfile(before, 'white'));
  assert.deepEqual(features.quartersAfter, quarterPositionProfile(after, 'white'));
  assert.deepEqual(features.quartersAfter.quarters.map(q => q.ownCount), [0, 1, 0, 0]);
  assert.equal(features.quartersAfter.ownOff, 14);
});

test('new context separates boards that the previous descriptor merged', async () => {
  const [, { experienceDescriptor }] = await modules;
  const state = fixture();
  const features = { startZoneBefore: 11, riskSignal: 2 };
  const a = experienceDescriptor(state, 'white', features);
  for (const [from, to] of [[21, 20], [9, 8]]) {
    const changed = copy(state);
    changed.points[to] = changed.points[from];
    delete changed.points[from];
    const b = experienceDescriptor(changed, 'white', features);
    assert.equal(a.legacyContextKey, b.legacyContextKey, 'fixture must collide under the old buckets');
    assert.notEqual(a.contextKey, b.contextKey);
  }
  assert.equal(a.contextKey.split('|').slice(0, 7).join('|'), a.legacyContextKey);
  assert.deepEqual(experienceDescriptor(mirror(state), 'dark', features), a);
});

test('causal credit applies to matching geometry and never another quarter layout', async () => {
  const [, { experienceDescriptor, normalizeExperiencePatterns, experienceAdjustment }] = await modules;
  const state = fixture();
  const a = experienceDescriptor(state, 'white', { startZoneBefore: 11 });
  const changed = copy(state);
  changed.points[8] = changed.points[9]; delete changed.points[9];
  const b = experienceDescriptor(changed, 'white', { startZoneBefore: 11 });
  assert.equal(a.actionKey, b.actionKey, 'isolate context geometry from action differences');
  const memory = normalizeExperiencePatterns([causal(a)]);
  assert.ok(experienceAdjustment(a, memory) < 0);
  assert.equal(experienceAdjustment(b, memory), 0);
  assert.equal(memory.size, 1, 'causal observations remain exact-only');
});

test('all observational fallback aliases retain geometry; legacy rows survive unchanged', async () => {
  const [, { experienceDescriptor, normalizeExperiencePatterns, experienceAdjustment }] = await modules;
  const a = experienceDescriptor(fixture(), 'white', { startZoneBefore: 11 });
  const changed = fixture(); changed.points[20] = changed.points[21]; delete changed.points[21];
  const b = experienceDescriptor(changed, 'white', { startZoneBefore: 11 });
  const historical = { ...a, contextKey: a.legacyContextKey };
  const memory = normalizeExperiencePatterns([observation(a), observation(historical)]);
  assert.ok(memory.has(`${historical.contextKey}::${historical.actionKey}`));
  assert.ok(experienceAdjustment(historical, memory) < 0);
  assert.ok(experienceAdjustment(a, memory) < 0);
  assert.equal(experienceAdjustment(b, memory), 0);
  for (const key of normalizeExperiencePatterns([observation(a)]).keys()) {
    assert.ok(key.includes(`|quarters:${a.quarterContextKey}::`), key);
  }
  // Simulate future aggregation levels with a different coarse context. They
  // may generalize those old buckets, but must still require equal geometry.
  const sameBoard = { ...a, contextKey: a.contextKey.replace('|pd2|', '|pd4|') };
  assert.ok(experienceAdjustment(sameBoard, normalizeExperiencePatterns([observation(a)])) < 0);
});

test('exact action includes the resulting layout, survives JSON, and cannot use an action alias', async () => {
  const [{ quarterPositionProfile }, { experienceDescriptor, normalizeExperiencePatterns, experienceAdjustment }] = await modules;
  const state = fixture();
  const after1 = copy(state); after1.points[20] = after1.points[21]; delete after1.points[21];
  const after2 = copy(state); after2.points[19] = after2.points[21]; delete after2.points[21];
  const a = experienceDescriptor(state, 'white', { quartersAfter: quarterPositionProfile(after1, 'white') });
  const b = experienceDescriptor(state, 'white', { quartersAfter: quarterPositionProfile(after2, 'white') });
  assert.equal(a.contextKey, b.contextKey);
  assert.notEqual(a.actionKey, b.actionKey);
  const memory = normalizeExperiencePatterns([causal(a)]);
  assert.ok(experienceAdjustment(copy(a), memory) < 0);
  assert.equal(experienceAdjustment({ ...b, familyActionKey: a.actionKey }, memory), 0);
  assert.ok(a.contextKey.length <= 2048);
  assert.ok(a.actionKey.length <= 4096);
  assert.deepEqual(copy(a).quartersAfter, quarterPositionProfile(after1, 'white'));
});

test('published-channel contract can change a native choice and records exact before/after quarters', () => {
  clearRuntimeCache();
  const { game, engine } = loadRuntime();
  const state = game.initialState('long');
  Object.assign(state, { phase: 'move', turn: 'dark', dice: [3, 4], rolled: [3, 4],
    points: { 2: { color: 'white', count: 2 }, 6: { color: 'white', count: 1 },
      14: { color: 'dark', count: 3 }, 16: { color: 'dark', count: 3 }, 17: { color: 'dark', count: 3 } },
    off: { white: 12, dark: 6 }, firstMoveDone: { white: true, dark: true },
    headPlayedThisTurn: { white: false, dark: false } });
  try {
    const options = { ...engine.productionOptions };
    const cold = engine.rank(state, options)[0];
    assert.equal(cold.experience.quarterSchema, 'long-quarter-layout-v1');
    const pattern = causal(cold.experience, {
      reviewerVersion: 'long-server-causal-review-v1', trustDomain: 'nardu/server-long-bot-causal/v1',
      runtimeDigest: 'a'.repeat(64), aggregateId: 'b'.repeat(64),
      policyImplementationId: engine.policyImplementationId, outcomeUsed: false,
    });
    // Synthetic proof of the channel, NOT evidence of actual playing strength.
    engine.beginExperienceSession('synthetic-quarter-round');
    engine.setExperience([pattern], 'server');
    engine.freezeExperience('synthetic-quarter-round');
    const learned = engine.rank(state, options);
    const penalized = learned.find(candidate => candidate.experience.actionKey === pattern.actionKey);
    assert.ok(penalized.experienceAdjustment < 0);
    assert.notEqual(canonicalMoveKey(learned[0].sequence), canonicalMoveKey(cold.sequence));
    engine.plan(state, options);
    const record = copy(engine.consumeLastDecision());
    assert.equal(record.selected.experience.quarterContextKey, cold.experience.quarterContextKey);
    assert.equal(record.selected.experience.quartersBefore.quarters.length, 4);
    assert.equal(record.selected.experience.quartersAfter.quarters.length, 4);
    assert.equal(record.selected.experience.quarterActionKey, record.selected.features.quartersAfter.key);
    assert.equal(record.selected.features.analysisNodeBudget, options.analysisNodeBudget);
    // Key-only compact recovery still retains the complete arrangement.
    assert.ok(record.selected.experience.contextKey.includes(record.selected.experience.quarterContextKey));
    assert.ok(record.selected.experience.actionKey.includes(record.selected.experience.quarterActionKey));
  } finally { clearRuntimeCache(); }
});
