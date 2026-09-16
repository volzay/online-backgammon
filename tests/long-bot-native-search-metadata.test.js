const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, '')
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(const|function|class))/gm, '')
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, '');
}

const ROOT = path.join(__dirname, '..');
const NOW = 1789500000000;
const plain = value => JSON.parse(JSON.stringify(value));

function loadRuntime() {
  class FrozenDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const copies = { count: 0, stateBytes: 0, analysisBytes: 0 };
  const trackedJSON = Object.create(JSON);
  trackedJSON.stringify = (value, ...args) => {
    const serialized = JSON.stringify(value, ...args);
    if (value?.variant === 'long' && value.points) {
      copies.count += 1;
      copies.stateBytes += serialized.length;
      copies.analysisBytes += JSON.stringify(value.analysis)?.length || 0;
    }
    return serialized;
  };
  const context = { window: {}, console, Date: FrozenDate, Math, JSON: trackedJSON };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context);
  const body = ['metrics', 'evaluator', 'analysis', 'engine', 'nardu-game-adapter', 'browser']
    .map(name => stripModuleSyntax(fs.readFileSync(path.join(ROOT, 'bot-engine/long', `${name}.ts`), 'utf8')))
    .join('\n');
  vm.runInContext(`(function () { ${body}\nwindow.metadataTest = {
    createLongBotEngine, createNarduGameAdapter, createBrowserLongBotEngine, hasBoundedFourPlyTactical,
    decisionRecord,
  }; }());`, context);
  const helpers = context.window.metadataTest;
  const adapter = helpers.createNarduGameAdapter(context.window.NarduGame);
  // Private/generic search retains the historical full-state adapter contract.
  // Only the native browser boundary is allowed to omit durable telemetry.
  const legacy = helpers.createLongBotEngine(adapter);
  return {
    helpers, adapter, copies,
    engine: helpers.createBrowserLongBotEngine(context.window.NarduGame, { experienceStorage: null }),
    legacy,
    reset() { Object.assign(copies, { count: 0, stateBytes: 0, analysisBytes: 0 }); },
  };
}

function state(dark, white, off = { dark: 0, white: 0 }, bytes = 0) {
  return {
    variant: 'long', phase: 'move', turn: 'dark', dice: [1], rolled: [1, 2],
    points: Object.fromEntries([
      ...Object.entries(dark).map(([point, count]) => [point, { color: 'dark', count }]),
      ...Object.entries(white).map(([point, count]) => [point, { color: 'white', count }]),
    ]),
    off, bar: { dark: 0, white: 0 }, score: { dark: 0, white: 0 },
    turnMoves: [], history: [{ type: 'durable-history', nested: { unchanged: true } }],
    firstMoveDone: { dark: true, white: true }, headPlayedThisTurn: { dark: false, white: false },
    startedAt: NOW, finishedAt: null, openingRoll: null,
    turnClock: { dark: 123, white: 456, active: null, startedAt: null },
    matchScore: { dark: 2, white: 1, target: 5, recordedWinner: null },
    match: { target: 5, extension: { preserved: true } }, extension: { arbitraryRuleData: [1, 2, 3] },
    analysis: { botMemory: { decisions: [{ nested: { original: true } }] }, payload: 'X'.repeat(bytes) },
  };
}

const oneNode = { strategyProfile: 'v25', maxCandidates: 1, analysisNodeBudget: 1 };

test('native one-node search removes durable analysis from internal serialization without changing any rank field', () => {
  const runtime = loadRuntime();
  const input = state({ 13: 15 }, { 24: 15 }, undefined, 256 * 1024);
  const original = plain(input);
  const legacy = runtime.legacy.rank(input, 'dark', oneNode);
  const legacyCopies = { ...runtime.copies };
  runtime.reset();
  const ranked = runtime.engine.rank(input, oneNode);
  assert.deepEqual(plain(ranked), plain(legacy), 'scores, order, rules, history, clocks and returned metadata are identical');
  assert.deepEqual(plain(input), original);
  assert.ok(legacyCopies.analysisBytes >= 2 * 256 * 1024, 'legacy copies the durable ledger at least twice');
  assert.equal(runtime.copies.count, legacyCopies.count, 'no search/budget work is removed');
  assert.equal(runtime.copies.analysisBytes, 0, 'ONLY the durable ledger is absent from every hypothetical state clone');
  assert.ok(legacyCopies.stateBytes - runtime.copies.stateBytes >= 2 * 256 * 1024);
  assert.notEqual(ranked[0].after.analysis, input.analysis);
});

test('native near-terminal bounded four-ply search is field-for-field identical with and without metadata projection', () => {
  const runtime = loadRuntime();
  // Six checkers each: even an expanded double cannot end the primary or
  // recovery turn, so this exercises actual moves at all four plies rather
  // than merely counting empty terminal continuations.
  const input = state({ 18: 6 }, { 6: 6 }, { dark: 9, white: 9 }, 8192);
  const original = plain(input);
  const options = { strategyProfile: 'v25', maxCandidates: 1, analysisNodeBudget: 96 };
  const legacy = runtime.legacy.rank(input, 'dark', options);
  runtime.reset();
  const ranked = runtime.engine.rank(input, options);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].tactical.plies, 4);
  assert.equal(runtime.helpers.hasBoundedFourPlyTactical(ranked[0]), true);
  assert.deepEqual(plain(ranked), plain(legacy));
  assert.deepEqual(plain(input), original);
  assert.ok(runtime.copies.count > 80, 'the check includes actual reply/recovery/continuation state clones');
  assert.equal(runtime.copies.analysisBytes, 0);
});

test('every native returned candidate owns an independent original-analysis deep copy', () => {
  const runtime = loadRuntime();
  const input = state({ 17: 1, 18: 1 }, { 1: 2 }, { dark: 13, white: 13 });
  const original = plain(input);
  const ranked = runtime.engine.rank(input, { ...oneNode, maxCandidates: 2, analysisNodeBudget: 2 });
  assert.equal(ranked.length, 2);
  ranked.forEach(candidate => assert.deepEqual(plain(candidate.after.analysis), original.analysis));
  assert.notEqual(ranked[0].after.analysis, ranked[1].after.analysis);
  ranked[0].after.analysis.botMemory.decisions[0].nested.original = false;
  ranked[0].after.analysis.payload = 'changed';
  assert.deepEqual(plain(ranked[1].after.analysis), original.analysis);
  assert.deepEqual(plain(input), original);
});

test('custom adapters still receive and return their exact analysis contract', () => {
  const { helpers } = loadRuntime();
  const input = state({ 13: 15 }, { 24: 15 });
  input.analysis.customTo = 12;
  const seen = [];
  const adapter = {
    legalSequences(current) {
      seen.push(current.analysis);
      return [[{ from: 13, to: current.analysis.customTo, die: 1 }]];
    },
    applySequence(current, sequence) {
      seen.push(current.analysis);
      assert.equal(sequence[0].to, current.analysis.customTo);
      return { ...current, points: { 13: { color: 'dark', count: 14 }, 12: { color: 'dark', count: 1 }, 24: { color: 'white', count: 15 } } };
    },
  };
  const ranked = helpers.createLongBotEngine(adapter).rank(input, 'dark', oneNode);
  assert.ok(seen.length >= 2);
  seen.forEach(analysis => assert.equal(analysis, input.analysis));
  assert.equal(ranked[0].after.analysis, input.analysis, 'generic results are not silently cloned or overwritten');
});

test('native plan searches without durable metadata but records the ORIGINAL state and unchanged decision telemetry', () => {
  const runtime = loadRuntime();
  const input = state({ 13: 15 }, { 24: 15 }, undefined, 32768);
  const original = plain(input);
  const legacy = runtime.legacy.rank(input, 'dark', oneNode);
  const identity = runtime.engine.experienceSnapshot();
  const expectedDecision = runtime.helpers.decisionRecord(input, 'dark', legacy, undefined, 0, identity, 1, oneNode);
  runtime.reset();
  const plan = runtime.engine.plan(input, oneNode);
  assert.deepEqual(plain(plan), plain(legacy[0].sequence.map(move => ({ from: move.from, die: move.die }))));
  assert.deepEqual(plain(runtime.engine.consumeLastDecision()), plain(expectedDecision));
  assert.deepEqual(plain(input), original);
  assert.equal(runtime.copies.analysisBytes, 0);
});

test('native static review preserves every returned field and analysis independence; describe features do not change', () => {
  const runtime = loadRuntime();
  const input = state({ 13: 15 }, { 24: 15 }, undefined, 32768);
  const original = plain(input);
  const sequence = [{ from: 13, to: 0, die: 1, bearOff: true }];
  const described = runtime.legacy.describeSequence(input, sequence, 'dark', oneNode);
  const expected = {
    sequence,
    after: runtime.adapter.applySequence(input, sequence, 'dark'),
    score: runtime.legacy.scoreSequence(input, sequence, 'dark'),
    scoreSemantics: 'long-static-evaluator-v1', scoreIncludesTacticalSearch: false,
    scoreIncludesExperience: false, features: described.features, experience: described.experience,
  };
  runtime.reset();
  assert.deepEqual(plain(runtime.engine.describeSequence(input, sequence, oneNode)), plain(described));
  const reviewed = runtime.engine.reviewSequenceStatic(input, sequence, oneNode);
  assert.deepEqual(plain(reviewed), plain(expected));
  assert.equal(runtime.copies.analysisBytes, 0);
  reviewed.after.analysis.botMemory.decisions[0].nested.original = false;
  assert.deepEqual(plain(input), original);
});

test('native restoration preserves JSON presence semantics for absent, undefined, null and non-enumerable analysis', () => {
  const runtime = loadRuntime();
  for (const mode of ['absent', 'undefined', 'null', 'non-enumerable']) {
    const input = state({ 13: 15 }, { 24: 15 });
    if (mode === 'absent') delete input.analysis;
    else if (mode === 'undefined') input.analysis = undefined;
    else if (mode === 'null') input.analysis = null;
    else Object.defineProperty(input, 'analysis', { value: input.analysis, enumerable: false });
    const legacy = runtime.legacy.rank(input, 'dark', oneNode);
    const ranked = runtime.engine.rank(input, oneNode);
    assert.deepEqual(plain(ranked), plain(legacy), mode);
    assert.equal(Object.hasOwn(ranked[0].after, 'analysis'), mode === 'null', mode);
  }
});
