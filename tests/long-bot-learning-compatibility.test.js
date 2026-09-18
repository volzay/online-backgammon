'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const builder = require('../scripts/build-long-bot-engine');
const ROOT = path.join(__dirname, '..');
const ORIGINAL = 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';
const ACTUAL = 'ca0e5738f16583c29dfb84867b159091df30cd1fb5cef2a75e0827a6810c6c8e';
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

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

test('learning compatibility preserves truthful actual identity and pins every reviewed source byte', () => {
  const entries = builder.readPolicySourceEntries();
  assert.equal(builder.policyImplementationId(entries), ACTUAL);
  const compatibility = builder.learningCompatibility(entries);
  assert.equal(compatibility.policyImplementationId, ACTUAL);
  assert.equal(compatibility.learningPolicyImplementationId, ORIGINAL);
  assert.equal(Object.isFrozen(compatibility), true);
  assert.equal(Object.isFrozen(compatibility.sourceFingerprints), true);
  const { engine } = browser();
  assert.equal(engine.policyImplementationId, ACTUAL);
  assert.equal(engine.acceptsLearningPolicyImplementationId(ACTUAL), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId(ORIGINAL), true);
  assert.equal(engine.acceptsLearningPolicyImplementationId('0'.repeat(64)), false);
  for (const [changedName] of entries) {
    const changed = entries.map(([name, bytes]) => [name, name === changedName
      ? Buffer.concat([bytes, Buffer.from('\n// unknown source byte\n')]) : bytes]);
    assert.equal(builder.learningCompatibility(changed), null, changedName);
    const changedActual = builder.policyImplementationId(changed);
    assert.notEqual(changedActual, ACTUAL, changedName);
    const altered = browser(builder.renderLongBotBundle(changed)).engine;
    assert.equal(altered.policyImplementationId, changedActual, changedName);
    assert.equal(altered.learningPolicyImplementationId, changedActual, changedName);
    assert.equal(altered.learningCompatibility, null, changedName);
    assert.equal(altered.acceptsLearningPolicyImplementationId(ORIGINAL), false, changedName);
    assert.equal(altered.acceptsLearningPolicyImplementationId(changedActual), true, changedName);
  }
});

test('live RPC accepts original and current lessons without rewriting provenance; wrong/local lessons are rejected', async () => {
  for (const source of [pattern(), pattern(ACTUAL), pattern('f'.repeat(64)),
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
    const accepted = source.policyImplementationId !== 'f'.repeat(64) && source.reviewerVersion !== 'forged-reviewer';
    assert.equal(result.length, accepted ? 1 : 0);
    assert.equal(applied.some(item => item.trust === 'server-cache' && item.patterns.length), false);
    assert.equal(JSON.stringify(source), before);
    if (accepted) assert.equal(JSON.stringify(result[0]), before);
  }
});
