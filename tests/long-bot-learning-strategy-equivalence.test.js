'use strict';

// Source-frozen, deterministic strategy parity, not a win-rate benchmark or
// claim that these synthetic v9 records were produced by the production RPC.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const builder = require('../scripts/build-long-bot-engine');

const ROOT = path.join(__dirname, '..');
const BASELINE = '06a9b106944e8fb5e76f772b23b703ec067e2e8b';
const ORIGINAL_ID = 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';
const OLD_GAME_HASH = '769c571ad10cefa75a8c128aba5123df47684780fad1136a0ae98f3342f33e4b';
const OLD_ENGINE_HASH = '6b503dce9c72d2bdec9180dfe63aa2252b71e8c69095eea13bd1345732940255';
// Identical bounded tactical cohorts on both runtimes. This exercises the real
// hard strategy without turning a compatibility regression into a full league.
const OPTIONS = Object.freeze({ strategyProfile: 'v25', maxCandidates: 8, analysisNodeBudget: 32 });
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const historical = file => execFileSync('git', ['show', `${BASELINE}:${file}`], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
const oldGame = historical('game.js');
const oldBundle = historical('long-bot-engine.js');
assert.equal(digest(oldGame), OLD_GAME_HASH, 'Baseline must be the actual reviewed rules source');
assert.equal(digest(oldBundle), OLD_ENGINE_HASH, 'Baseline must be the actual reviewed executable bundle');

function memoryStorage() {
  const values = new Map();
  return { values, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(String(key)) ?? null, setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)) };
}

function runtime({ baseline = false, storage = memoryStorage() } = {}) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [1789732800000])); }
    static now() { return 1789732800000; }
  }
  const math = Object.create(Math);
  math.random = () => { throw new Error('Compatibility ranking must never generate or substitute dice'); };
  const window = { sessionStorage: storage };
  window.window = window;
  const context = vm.createContext({ window, sessionStorage: storage, Date: FixedDate, Math: math, JSON,
    console: { log() {}, warn() {}, error() {} }, URL, setTimeout, clearTimeout });
  vm.runInContext((baseline ? oldGame : fs.readFileSync(path.join(ROOT, 'game.js'))).toString('utf8'), context);
  vm.runInContext(baseline ? oldBundle.toString('utf8') : builder.renderLongBotBundle(), context);
  return { game: window.NarduGame, engine: window.NarduLongBotEngine, storage };
}

function positions(game) {
  const cases = [];
  for (const color of ['white', 'dark']) {
    const roll = (name, dice, configure) => {
      const state = game.initialState('long');
      state.turn = color;
      game.applyRoll(state, dice);
      configure?.(state);
      // Durable journal entries are retained and compared, but are not inputs
      // to a lesson's descriptor or the synthetic evidence source identity.
      state.history = [{ color, roll: dice.slice(0, 2).join(':'), at: '2026-09-18T00:00:00.000Z',
        sha256: 'a'.repeat(64), sha256Input: 'completed-unit-history-only' }];
      cases.push({ name: `${color}:${name}`, state: plain(state) });
    };
    roll('opening-double', color === 'white' ? [6, 6, 6, 6] : [3, 3, 3, 3]);
    roll('route', [2, 4], state => {
      state.points = color === 'white'
        ? { 24: { color, count: 4 }, 21: { color, count: 4 }, 17: { color, count: 4 }, 8: { color, count: 3 }, 12: { color: 'dark', count: 15 } }
        : { 12: { color, count: 4 }, 9: { color, count: 4 }, 5: { color, count: 4 }, 20: { color, count: 3 }, 24: { color: 'white', count: 15 } };
      state.firstMoveDone = { white: true, dark: true };
    });
    roll('late-bearoff', [2, 4], state => {
      state.points = color === 'white'
        ? { 1: { color, count: 3 }, 2: { color, count: 4 }, 4: { color, count: 8 }, 12: { color: 'dark', count: 15 } }
        : { 13: { color, count: 3 }, 14: { color, count: 4 }, 16: { color, count: 8 }, 24: { color: 'white', count: 15 } };
      state.firstMoveDone = { white: true, dark: true };
    });
  }
  return cases;
}

function evidenceFor(cold, cases) {
  const patterns = new Map();
  for (const { state } of cases) {
    for (const row of cold.engine.rank(plain(state), OPTIONS)) {
      const descriptor = row.experience;
      const key = `${descriptor.contextKey}::${descriptor.actionKey}`;
      patterns.set(key, { creditVersion: 9, evidenceSchema: 'long-server-causal-pattern-v1',
        reviewerVersion: 'long-server-causal-review-v1', trustDomain: 'nardu/server-long-bot-causal/v1',
        policyImplementationId: ORIGINAL_ID, runtimeDigest: 'a'.repeat(64), aggregateId: digest(key),
        contextKey: descriptor.contextKey, actionKey: descriptor.actionKey,
        samples: 3, losses: 3, wins: 0, lossWeight: 4.5, signalWeight: 4.5, severeLosses: 0, winWeight: 0,
        outcomeUsed: false });
    }
  }
  assert.ok(patterns.size > 0 && patterns.size <= 256);
  return [...patterns.values()];
}

function checkedPlans(old, candidate, cases) {
  let actualPenalties = 0;
  for (const { name, state } of cases) {
    const saved = plain(state);
    const originalRank = plain(old.engine.rank(plain(state), OPTIONS));
    const currentRank = plain(candidate.engine.rank(plain(state), OPTIONS));
    assert.ok(originalRank.length > 0, name);
    assert.deepEqual(currentRank, originalRank, `${name}: full ordered ranks, scores, features and after positions`);
    const penalties = currentRank.filter(row => row.experienceAdjustment < 0);
    assert.ok(penalties.length > 0, `${name}: matching lessons must actually affect score, not merely be stored`);
    actualPenalties += penalties.length;
    assert.deepEqual(plain(candidate.engine.plan(plain(state), OPTIONS)), plain(old.engine.plan(plain(state), OPTIONS)), `${name}: selected hard plan`);
    const originalDecision = old.engine.consumeLastDecision();
    const currentDecision = candidate.engine.consumeLastDecision();
    for (const field of ['selected', 'alternatives', 'experienceFingerprint', 'experienceSize', 'experienceFrozen', 'stateSnapshotV2', 'replayInput', 'weights']) {
      assert.deepEqual(plain(currentDecision[field]), plain(originalDecision[field]), `${name}: archived ${field}`);
    }
    assert.deepEqual(state, saved, `${name}: caller state and complete history are unchanged`);
  }
  assert.ok(actualPenalties >= cases.length);
}

test('optimized real hard strategy retains identical nonempty old-release lessons, ranks, scores and selected plans', () => {
  const old = runtime({ baseline: true });
  const candidate = runtime();
  assert.equal(old.engine.policyImplementationId, ORIGINAL_ID);
  assert.notEqual(candidate.engine.policyImplementationId, ORIGINAL_ID, 'Exact current source identity must remain truthful');
  const cases = positions(old.game);
  const patterns = evidenceFor(old, cases);
  const original = plain(patterns);
  old.engine.setExperience(patterns, 'server');
  candidate.engine.setExperience(patterns, 'server');
  assert.ok(candidate.engine.experienceSize() > 0, 'Equivalent new source must not silently discard old worker lessons');
  assert.deepEqual(plain(candidate.engine.experienceReplaySnapshot()), plain(old.engine.experienceReplaySnapshot()));
  checkedPlans(old, candidate, cases);
  assert.deepEqual(patterns, original, 'No pattern source ID, aggregate, runtime digest or descriptor is rewritten');
});

test('a nonempty original frozen session resumes on optimized rules with the same policy fingerprint and archived origin', () => {
  const storage = memoryStorage();
  const old = runtime({ baseline: true, storage });
  const cases = positions(old.game);
  const patterns = evidenceFor(old, cases);
  const session = 'source-frozen-v35-strategy-equivalence';
  old.engine.beginExperienceSession(session);
  old.engine.setExperience(patterns, 'server');
  const frozen = plain(old.engine.freezeExperience(session));
  assert.ok(frozen.size > 0 && frozen.frozen);
  const storedBefore = [...storage.values.entries()];
  const candidate = runtime({ storage });
  const restored = plain(candidate.engine.beginExperienceSession(session));
  assert.equal(restored.frozen, true);
  assert.equal(restored.fingerprint, frozen.fingerprint);
  assert.equal(restored.size, frozen.size);
  assert.deepEqual([...storage.values.entries()], storedBefore, 'Resume must not relabel the cached memory');
  const replay = plain(candidate.engine.experienceReplaySnapshot());
  assert.deepEqual(replay, plain(old.engine.experienceReplaySnapshot()));
  assert.ok(replay.patterns.every(pattern => pattern.policyImplementationId === ORIGINAL_ID));
  checkedPlans(old, candidate, cases);
  const persisted = plain(candidate.engine.freezeExperience(session));
  assert.equal(persisted.fingerprint, frozen.fingerprint);
  assert.equal(persisted.size, frozen.size);
  const storedAfter = [...storage.values.entries()];
  assert.deepEqual(storedAfter.map(([key]) => key), storedBefore.map(([key]) => key));
  for (let index = 0; index < storedBefore.length; index += 1) {
    const originalEnvelope = JSON.parse(storedBefore[index][1]);
    const currentEnvelope = JSON.parse(storedAfter[index][1]);
    for (const field of ['engineVersion', 'trust', 'patterns']) {
      assert.deepEqual(currentEnvelope[field], originalEnvelope[field], `Persisted ${field} keeps full original lesson provenance`);
    }
    // The envelope may truthfully describe the current executable, but must
    // never reattribute archived worker lessons to that different source ID.
    assert.equal(currentEnvelope.policyImplementationId, candidate.engine.policyImplementationId);
    assert.equal(currentEnvelope.learningPolicyImplementationId, ORIGINAL_ID);
    const sourceFingerprints = Object.fromEntries(builder.readPolicySourceEntries()
      .map(([name, bytes]) => [name, `sha256:${digest(bytes)}`]));
    assert.deepEqual(currentEnvelope.runtimeSourceFingerprints, sourceFingerprints);
  }
  assert.deepEqual(plain(candidate.engine.experienceReplaySnapshot()), replay);
});

test('learning compatibility also accepts current source evidence but never unknown or invalid causal provenance', () => {
  const candidate = runtime();
  const old = runtime({ baseline: true });
  const pattern = evidenceFor(old, positions(old.game))[0];
  const current = { ...pattern, policyImplementationId: candidate.engine.policyImplementationId };
  candidate.engine.setExperience([current], 'server');
  assert.ok(candidate.engine.experienceSize() > 0);
  assert.deepEqual(plain(candidate.engine.experienceReplaySnapshot().patterns), [current]);
  for (const invalid of [
    { ...pattern, policyImplementationId: 'f'.repeat(64) },
    { ...pattern, reviewerVersion: 'untrusted-reviewer' },
    { ...pattern, trustDomain: 'another-trust-domain' },
    { ...pattern, runtimeDigest: 'invalid' },
    { ...pattern, outcomeUsed: true },
  ]) {
    candidate.engine.setExperience([invalid], 'server');
    assert.equal(candidate.engine.experienceSize(), 0);
    assert.deepEqual(plain(candidate.engine.experienceReplaySnapshot().patterns), []);
  }
});
