'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const builder = require('../scripts/build-long-bot-engine');
const { OPENING_SUPPORT_POLICY, FIRST_ENTRY_FENCE_DEFENSE_POLICY, OPENING_DEVELOPMENT_POLICY, CONTACT_FENCE_DEFENSE_POLICY } = require('../scripts/verify-long-bot-learning-compatibility');
const ROOT = path.join(__dirname, '..');
const ORIGINAL = 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';
const PREVIOUS = '4aede916c0f3a219e84582d3a8277f50b1041d6b7ae541bff7b807c42c82f526';
const PREVIOUS_LIVE = '6109e41cae1c8711aed43c7e2f104d621beab314c0e6bcdf277901b2f0c4d690';
const PREVIOUS_TACTICAL_LIVE = '6c8c2e58287d73f855e4bb5b34fcee4f1e4eec91bb4c2c927370f50ad781fe89';
const PREVIOUS_JSYS = '541f4c011df371fe8201de56edd189d49ab40c18bf216c2c4b3dc080cf0733aa';
const PREVIOUS_COMPLETE_JSYS = '904e7062dcb499ed120ab92d3818e1b77227d5df51c8dfdb55d05f238ba52d6a';
const PREVIOUS_LIVE_JSYS = 'c64f47e25f0580f7a42f11c0adf01b42bf60739a4c925039ed33c4d7339049b9';
const HISTORICAL_ACTUAL = 'f86ffd7312a574935eaa4dc158aee777336762cd22e701143fa732d86f7a05f2';
const CLEAR_FINAL_RACE = '5cc8ff5d3120c3afd257e7cd1a17827814ef3896b20c316f778a6863d12768a0';
const START_ZONE_ANALYSIS = '68d4a4f645374a29af252518d4391ddebe7ea200973aeb3852446be2e54a251d';
const SEPARATED_RACE = '5b13ec7702cf503c2fee59c3b5b99ca5de630060eb6df03732ab6de4b221a605';
const ACTUAL = OPENING_DEVELOPMENT_POLICY;
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

test('opening development policy has no historical learning alias', () => {
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
    PREVIOUS_LIVE_JSYS, CLEAR_FINAL_RACE, START_ZONE_ANALYSIS, SEPARATED_RACE, OPENING_SUPPORT_POLICY, FIRST_ENTRY_FENCE_DEFENSE_POLICY, CONTACT_FENCE_DEFENSE_POLICY, '0'.repeat(64)]) {
    assert.equal(engine.acceptsLearningPolicyImplementationId(id), false, id);
  }
});

test('live RPC applies only current analytical-policy lessons, never historical or forged patterns', async () => {
  for (const source of [pattern(), pattern(PREVIOUS), pattern(PREVIOUS_LIVE),
    pattern(PREVIOUS_TACTICAL_LIVE), pattern(PREVIOUS_JSYS), pattern(PREVIOUS_COMPLETE_JSYS),
    pattern(PREVIOUS_LIVE_JSYS), pattern(HISTORICAL_ACTUAL), pattern(CLEAR_FINAL_RACE),
    pattern(SEPARATED_RACE), pattern(OPENING_SUPPORT_POLICY), pattern(FIRST_ENTRY_FENCE_DEFENSE_POLICY), pattern(CONTACT_FENCE_DEFENSE_POLICY), pattern(ACTUAL), pattern('f'.repeat(64)),
    { ...pattern(), reviewerVersion: 'forged-reviewer' }]) {
    const { context, engine, values } = browser();
    values.set('narduh-long-bot-server-experience-v15', JSON.stringify({ savedAt: Date.now(), playerKey: 'tester',
      creditVersion: 9, patterns: [source] }));
    const applied = [];
    engine.setExperience = (patterns, trust) => applied.push({ patterns, trust });
    context.window.NarduSupabase = { configured: () => true,
      client: async () => ({ rpc: async (name, args) => {
        assert.equal(name, 'load_current_long_bot_experience');
        assert.equal(args.p_policy_implementation_id, ACTUAL);
        assert.equal(args.p_player_name, 'tester');
        return { data: { policyImplementationId: ACTUAL, patterns: [source] }, error: null };
      } }) };
    vm.runInContext(read('rooms-client.js'), context);
    const before = JSON.stringify(source);
    const accepted = source.policyImplementationId === ACTUAL && source.reviewerVersion !== 'forged-reviewer';
    const load = context.window.NarduRooms.loadLongBotExperience({ playerName: 'tester' });
    if (accepted) {
      const result = await load;
      assert.equal(result.length, 1);
      assert.equal(JSON.stringify(result[0]), before);
    } else {
      await assert.rejects(load, { code: 'LONG_BOT_EXPERIENCE_INVALID_RESPONSE' });
    }
    assert.equal(applied.some(item => item.trust === 'server-cache' && item.patterns.length), false);
    assert.equal(JSON.stringify(source), before);
  }
});

test('verified empty experience is distinct from an unavailable, unattested, or malformed response', async () => {
  const { context } = browser();
  let configured = false;
  let data = { policyImplementationId: ACTUAL, patterns: [] };
  const calls = [];
  context.window.NarduSupabase = {
    configured: () => configured,
    client: async () => ({ rpc: async (name, args) => {
      calls.push([name, args.p_policy_implementation_id, args.p_player_name]);
      return { data, error: null };
    } }),
  };
  vm.runInContext(read('rooms-client.js'), context);
  const load = () => context.window.NarduRooms.loadLongBotExperience({ refresh: true });
  await assert.rejects(load(), { code: 'LONG_BOT_EXPERIENCE_UNAVAILABLE' });
  assert.equal(calls.length, 0);
  configured = true;
  assert.deepEqual(Array.from(await load()), []);
  for (const invalid of [
    null, [], { patterns: [] }, { policyImplementationId: null, patterns: [] },
    { policyImplementationId: OPENING_SUPPORT_POLICY, patterns: [] },
    { policyImplementationId: OPENING_SUPPORT_POLICY, patterns: [pattern(ACTUAL)] },
    { policyImplementationId: ACTUAL, patterns: null },
  ]) {
    data = invalid;
    await assert.rejects(load(), { code: 'LONG_BOT_EXPERIENCE_INVALID_RESPONSE' });
  }
  assert.equal(calls.length, 8);
  assert.ok(calls.every(([name, policy, player]) =>
    name === 'load_current_long_bot_experience' && policy === ACTUAL && player === null));
});

test('an in-flight opening-support RPC cannot satisfy the new policy for the same player', async () => {
  const { context, engine } = browser();
  context.window.NarduLongBotEngine = { ...engine, policyImplementationId: OPENING_SUPPORT_POLICY };
  const calls = [];
  let resolvePriorRequest;
  const priorResponse = new Promise(resolve => { resolvePriorRequest = resolve; });
  context.window.NarduSupabase = {
    configured: () => true,
    client: async () => ({ rpc: (name, args) => {
      calls.push([name, args.p_policy_implementation_id]);
      return name === 'get_long_bot_experience_patterns'
        ? priorResponse
        : Promise.resolve({ data: { policyImplementationId: ACTUAL, patterns: [] }, error: null });
    } }),
  };
  vm.runInContext(read('rooms-client.js'), context);
  const load = () => context.window.NarduRooms.loadLongBotExperience({ playerName: 'tester' });
  const previous = assert.rejects(load(), { code: 'LONG_BOT_EXPERIENCE_SUPERSEDED' });
  context.window.NarduLongBotEngine = engine;
  const current = load();
  resolvePriorRequest({ data: [], error: null });
  await previous;
  assert.deepEqual(Array.from(await current), []);
  assert.deepEqual(calls, [
    ['get_long_bot_experience_patterns', undefined],
    ['load_current_long_bot_experience', ACTUAL],
  ]);
});
