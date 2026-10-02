'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const builder = require('../scripts/build-long-bot-engine');
const ROOT = path.join(__dirname, '..');
const ORIGINAL = 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';
const PREVIOUS = '4aede916c0f3a219e84582d3a8277f50b1041d6b7ae541bff7b807c42c82f526';
const PREVIOUS_LIVE = '6109e41cae1c8711aed43c7e2f104d621beab314c0e6bcdf277901b2f0c4d690';
const PREVIOUS_TACTICAL_LIVE = '6c8c2e58287d73f855e4bb5b34fcee4f1e4eec91bb4c2c927370f50ad781fe89';
const PREVIOUS_JSYS = '541f4c011df371fe8201de56edd189d49ab40c18bf216c2c4b3dc080cf0733aa';
const PREVIOUS_COMPLETE_JSYS = '904e7062dcb499ed120ab92d3818e1b77227d5df51c8dfdb55d05f238ba52d6a';
const PREVIOUS_LIVE_JSYS = 'c64f47e25f0580f7a42f11c0adf01b42bf60739a4c925039ed33c4d7339049b9';
const HISTORICAL_ACTUAL = 'f86ffd7312a574935eaa4dc158aee777336762cd22e701143fa732d86f7a05f2';
const ACTUAL = '5cc8ff5d3120c3afd257e7cd1a17827814ef3896b20c316f778a6863d12768a0';
const HISTORICAL_COMMIT = '31c8f3ee452b4b93ffb9bfd886aad3ba77d24ff3';
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const historicalEntries = () => [...builder.SOURCES, 'game.js', 'strong-bot.js'].map(file => [
  file, execFileSync('git', ['show', `${HISTORICAL_COMMIT}:${file}`], { cwd: ROOT }),
]);

function pattern(policyImplementationId = ORIGINAL) {
  return { creditVersion: 9, evidenceSchema: 'long-server-causal-pattern-v1',
    reviewerVersion: 'long-server-causal-review-v1', trustDomain: 'nardu/server-long-bot-causal/v1',
    runtimeDigest: 'a'.repeat(64), aggregateId: 'b'.repeat(64), policyImplementationId,
    contextKey: 'route|paired-test', actionKey: 'selected:route', samples: 3,
    losses: 3, wins: 0, lossWeight: 4.5, signalWeight: 4.5,
    severeLosses: 0, winWeight: 0, outcomeUsed: false };
}
function browser(bundle = read('long-bot-engine.js')) {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key), key: index => [...values.keys()][index] || null,
    get length() { return values.size; } };
  const context = { window: {}, sessionStorage: storage, localStorage: storage,
    Date, Math, JSON, Map, Uint8Array, TextEncoder, fetch, console, URL, setTimeout, clearTimeout };
  context.window.sessionStorage = storage;
  vm.createContext(context);
  vm.runInContext(read('game.js'), context);
  vm.runInContext(bundle, context);
  return { context, engine: context.window.NarduLongBotEngine, values };
}

test('the prior learning alias remains pinned to every byte of its reviewed source', () => {
  const entries = historicalEntries();
  assert.equal(builder.policyImplementationId(entries), HISTORICAL_ACTUAL);
  const compatibility = builder.learningCompatibility(entries);
  assert.equal(compatibility.policyImplementationId, HISTORICAL_ACTUAL);
  assert.equal(compatibility.learningPolicyImplementationId, ORIGINAL);
  assert.equal(Object.isFrozen(compatibility), true);
  assert.equal(Object.isFrozen(compatibility.compatiblePolicyImplementationIds), true);
  assert.equal(Object.isFrozen(compatibility.sourceFingerprints), true);
  const { engine } = browser(builder.renderLongBotBundle(entries));
  assert.equal(engine.policyImplementationId, HISTORICAL_ACTUAL);
  assert.equal(engine.acceptsLearningPolicyImplementationId(HISTORICAL_ACTUAL), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId(ORIGINAL), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId(PREVIOUS), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId(PREVIOUS_LIVE), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId(PREVIOUS_TACTICAL_LIVE), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId(PREVIOUS_JSYS), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId(PREVIOUS_COMPLETE_JSYS), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId(PREVIOUS_LIVE_JSYS), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId('0'.repeat(64)), false);
  for (const [changedName] of entries) {
    const changed = entries.map(([name, bytes]) => [name, name === changedName
      ? Buffer.concat([bytes, Buffer.from('\n// unknown source byte\n')]) : bytes]);
    assert.equal(builder.learningCompatibility(changed), null, changedName);
    const changedActual = builder.policyImplementationId(changed);
    assert.notEqual(changedActual, HISTORICAL_ACTUAL, changedName);
    const altered = browser(builder.renderLongBotBundle(changed)).engine;
    assert.equal(altered.policyImplementationId, changedActual, changedName);
    assert.equal(altered.learningPolicyImplementationId, changedActual, changedName);
    assert.equal(altered.learningCompatibility, null, changedName);
    assert.equal(altered.acceptsLearningPolicyImplementationId(ORIGINAL), false, changedName);
    assert.equal(altered.acceptsLearningPolicyImplementationId(changedActual), true, changedName);
  }
});

test('new clear-race policy has no historical learning alias', () => {
  const entries = builder.readPolicySourceEntries();
  assert.equal(builder.policyImplementationId(entries), ACTUAL);
  assert.equal(builder.learningCompatibility(entries), null);
  const { engine } = browser();
  assert.equal(engine.policyImplementationId, ACTUAL);
  assert.equal(engine.learningPolicyImplementationId, ACTUAL);
  assert.equal(engine.learningCompatibility, null);
  assert.equal(engine.acceptsLearningPolicyImplementationId(ACTUAL), true);
  for (const id of [ORIGINAL, HISTORICAL_ACTUAL, PREVIOUS, PREVIOUS_LIVE,
    PREVIOUS_TACTICAL_LIVE, PREVIOUS_JSYS, PREVIOUS_COMPLETE_JSYS,
    PREVIOUS_LIVE_JSYS, '0'.repeat(64)]) {
    assert.equal(engine.acceptsLearningPolicyImplementationId(id), false, id);
  }
});

test('live RPC applies only current clear-race lessons, never historical or forged patterns', async () => {
  for (const source of [pattern(), pattern(PREVIOUS), pattern(PREVIOUS_LIVE),
    pattern(PREVIOUS_TACTICAL_LIVE), pattern(PREVIOUS_JSYS), pattern(PREVIOUS_COMPLETE_JSYS),
    pattern(PREVIOUS_LIVE_JSYS), pattern(HISTORICAL_ACTUAL),
    pattern(ACTUAL), pattern('f'.repeat(64)),
    { ...pattern(), reviewerVersion: 'forged-reviewer' }]) {
    const { context, engine, values } = browser();
    values.set('narduh-long-bot-server-experience-v15', JSON.stringify({ savedAt: Date.now(), playerKey: 'tester',
      creditVersion: 9, patterns: [source] }));
    const applied = [];
    engine.setExperience = (patterns, trust) => applied.push({ patterns, trust });
    context.window.NarduSupabase = { configured: () => true,
      client: async () => ({ rpc: async () => ({ data: [source], error: null }) }) };
    vm.runInContext(read('rooms-client.js'), context);
    const before = JSON.stringify(source);
    const result = await context.window.NarduRooms.loadLongBotExperience({ playerName: 'tester' });
    const accepted = source.policyImplementationId === ACTUAL && source.reviewerVersion !== 'forged-reviewer';
    assert.equal(result.length, accepted ? 1 : 0);
    assert.equal(applied.some(item => item.trust === 'server-cache' && item.patterns.length), false);
    assert.equal(JSON.stringify(source), before);
    if (accepted) assert.equal(JSON.stringify(result[0]), before);
  }
});
