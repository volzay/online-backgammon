'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const worker = require('../scripts/long-bot-causal-worker');
const { loadRuntime, stateFromSnapshot } = require('../scripts/generate-long-bot-shadow-replay');
const { selectReviewDecisionIndexes } = require('../scripts/train-long-bot-causal-army');
const clone = value => structuredClone(value);

function snapshot(kind = 'four') {
  const white = kind === 'two' ? { 24: 14, 2: 1 }
    : kind === 'blocked-two' ? { 24: 13, 11: 1, 9: 1 }
      : kind === 'blocked-three' ? { 24: 12, 11: 1, 9: 1, 8: 1 }
        : { 24: 15 };
  const board = kind === 'two' || kind === 'three' ? 8
    : kind.startsWith('blocked') ? 7 : 9;
  return { schema: 'long-state-v2', variant: 'long', phase: 'move', turn: 'dark',
    points: Object.fromEntries([[12, { color: 'dark', count: 14 }], [board, { color: 'dark', count: 1 }],
      ...Object.entries(white).map(([point, count]) => [point, { color: 'white', count }])]),
    off: { white: 0, dark: 0 }, bar: { white: 0, dark: 0 },
    dice: [2, 4], rolled: [2, 4], turnMoves: [],
    firstMoveDone: { white: true, dark: true }, headPlayedThisTurn: { white: false, dark: false } };
}

function decision(index, kind = 'four', futureRisk = 0, choiceCount = 2) {
  const original = snapshot(kind), state = stateFromSnapshot(original), runtime = loadRuntime();
  const sequence = runtime.game.bestMoveSequences(state, 'dark')[0];
  assert.ok(sequence?.length);
  const after = clone(state);
  const moves = sequence.map(move => ({ from: move.from, to: move.to, die: move.die }));
  for (const move of moves) assert.equal(runtime.game.applyMove(after, move.from, move.die, { autoEnd: false }), true);
  const selected = { moves, after, features: { prospectiveFenceExtensionBefore: futureRisk },
    score: 0, experienceAdjustment: 0, tactical: { distributionComplete: true,
      recoveryDistributionComplete: true, continuationCoverageComplete: true },
    experience: { contextKey: 'synthetic-small-future', actionKey: `action-${index}` } };
  return { id: `synthetic-decision-${index}`, positionId: `synthetic-position-${index}`,
    actor: 'bot', color: 'dark', source: 'engine', engineVersion: worker.ENGINE_VERSION,
    choiceCount, experienceFrozen: true, experienceFingerprint: 'lbe8-empty',
    stateFingerprintV2: `synthetic-state-${index}`, stateSnapshotV2: original,
    replayInput: { runtime: clone(worker.PRODUCTION_POLICY) }, selected,
    experience: clone(selected.experience), execution: { complete: true, fallback: false,
      substituted: false, selectedMatchesExecuted: true, executedActionKey: selected.experience.actionKey,
      executed: clone(selected) } };
}

function game() {
  const decisions = Array.from({ length: 20 }, (_, index) => decision(index));
  decisions[5] = decision(5, 'blocked-two');
  decisions[7] = decision(7, 'blocked-three');
  for (const index of [18, 19]) {
    decisions[index].selected.features.primeRunBefore = 5;
    decisions[index].selected.features.primeRunAfter = 4;
  }
  return { id: 'synthetic-curriculum-ledger', engine_version: worker.ENGINE_VERSION,
    difficulty: 'hard', variant: 'long', bot_color: 'dark', winner: 'white', decisions,
    final_state: { variant: 'long', analysis: { botMemory: { engineVersion: worker.ENGINE_VERSION,
      coverage: { complete: true, expectedBotDecisions: decisions.length,
        recordedBotDecisions: decisions.length, recoveredBotDecisions: 0 },
      replayExperience: { schema: 'long-experience-replay-v1', engineVersion: worker.ENGINE_VERSION,
        fingerprint: 'lbe8-empty', size: 0, frozen: true, complete: true, patterns: [], patternCount: 0 } } } } };
}

test('native two/three-position future review keeps the current first pre-threat onset and two tiered slots', () => {
  for (const kind of ['two', 'three']) {
    const source = game();
    assert.deepEqual(worker.productionStrategicReviewPlan(source).expensiveDecisionIndexes, [4, 7, 19, 18]);
    source.decisions[2] = decision(2, kind, 60);
    const frozen = JSON.stringify(source), plan = worker.productionStrategicReviewPlan(source);
    assert.deepEqual(plan.expensiveDecisionIndexes, [4, 2, 19, 18]);
    assert.equal(plan.maximumExpensiveReviews, 4);
    assert.match(plan.ordering, /^pre-threat-reserve-/);
    assert.ok(plan.risks[0].signals.includes('before-developing-head-fence'));
    const target = plan.risks.find(risk => risk.index === 2);
    assert.equal(target.capacity.eligible, true);
    assert.equal(target.capacity.uniquePositions, kind === 'two' ? 2 : 3);
    assert.ok(target.signals.includes('early-small-choice-future-head-threat'));
    assert.equal(plan.outcomeUsed, false);
    assert.equal(plan.riskRole, 'curriculum-only');
    const offline = selectReviewDecisionIndexes(source,
      { reviewSelection: 'strategic-risk', reviewWorkDecisions: 4 });
    assert.deepEqual(offline.indexes, plan.expensiveDecisionIndexes);
    assert.deepEqual(offline.risks, plan.risks.slice(0, 4));
    assert.equal(offline.ordering, plan.ordering);
    assert.equal(JSON.stringify(source), frozen);
  }
});

test('reported two choices cannot reserve a native four-position review or an invalid envelope', () => {
  const source = game(); source.decisions[2] = decision(2, 'four', 60, 2);
  const plan = worker.productionStrategicReviewPlan(source);
  assert.equal(plan.risks.find(risk => risk.index === 2).capacity.uniquePositions, 4);
  assert.deepEqual(plan.expensiveDecisionIndexes, [4, 7, 19, 18]);
  assert.deepEqual(selectReviewDecisionIndexes(source,
    { reviewSelection: 'strategic-risk', reviewWorkDecisions: 4 }).indexes, plan.expensiveDecisionIndexes);
  source.decisions[2] = decision(2, 'two', 60);
  source.decisions[2].execution.complete = false;
  const invalid = worker.productionStrategicReviewPlan(source);
  assert.deepEqual(invalid.expensiveDecisionIndexes, [4, 7, 19, 18]);
  assert.deepEqual(invalid.risks.find(risk => risk.index === 2).capacity,
    { eligible: false, reason: 'invalid-envelope' });
});

test('earliest eligible future review wins, while late hints and actual outcomes cannot choose work', () => {
  const source = game();
  source.decisions[2] = decision(2, 'two', 60);
  source.decisions[3] = decision(3, 'three', 6000, 3);
  source.decisions[15] = decision(15, 'two', 60000);
  const plan = worker.productionStrategicReviewPlan(source);
  assert.deepEqual(plan.expensiveDecisionIndexes, [4, 2, 19, 18]);
  const changed = clone(source); changed.winner = 'dark'; changed.result_type = 'mars';
  changed.decisions.forEach(row => { row.selected.score = 1e99; row.regret = -1e99; });
  assert.deepEqual(worker.productionStrategicReviewPlan(changed), plan);
});

test('a future-only priority-zero hint keeps offline and production ordering telemetry identical', () => {
  const source = game();
  source.decisions[5] = decision(5); source.decisions[7] = decision(7);
  source.decisions[2] = decision(2, 'two', 60);
  const plan = worker.productionStrategicReviewPlan(source);
  const offline = selectReviewDecisionIndexes(source,
    { reviewSelection: 'strategic-risk', reviewWorkDecisions: 4 });
  assert.equal(worker.archivedEarlyStrategicThreat(source, source.decisions[2]).priority, 0);
  assert.equal(plan.expensiveDecisionIndexes[0], 2);
  assert.match(plan.ordering, /^early-threat-reserve-/);
  assert.deepEqual(offline.indexes, plan.expensiveDecisionIndexes);
  assert.deepEqual(offline.risks, plan.risks.slice(0, 4));
  assert.equal(offline.ordering, plan.ordering);
});

test('future-head hint retains strict native field, ordinary-roll and head-presence guards', () => {
  const source = game();
  const base = decision(2, 'two', 60);
  assert.equal(worker.archivedEarlyStrategicThreat(source, base).smallChoiceFutureThreat, true);
  const changes = [
    row => { row.choiceCount = '2'; }, row => { row.choiceCount = 4; },
    row => { row.selected.features.prospectiveFenceExtensionBefore = 59.9999; },
    row => { row.selected.features.prospectiveFenceExtensionBefore = '60'; },
    row => { row.selected.features.prospectiveFenceExtensionBefore = Infinity; },
    row => { row.stateSnapshotV2.rolled = [2, 2]; row.stateSnapshotV2.dice = [2, 2, 2, 2]; },
    row => { row.stateSnapshotV2.dice = [2]; }, row => { row.stateSnapshotV2.dice = [2, 2]; },
    row => { row.stateSnapshotV2.points[8].count += 14; delete row.stateSnapshotV2.points[12]; },
    row => { row.source = 'history-recovery'; },
  ];
  for (const change of changes) {
    const row = clone(base); change(row);
    assert.equal(worker.archivedEarlyStrategicThreat(source, row).smallChoiceFutureThreat, undefined);
  }
  const white = clone(base); white.color = 'white'; white.stateSnapshotV2.turn = 'white';
  white.stateSnapshotV2.points = Object.fromEntries(Object.entries(base.stateSnapshotV2.points)
    .map(([point, stack]) => [((Number(point) + 11) % 24) + 1,
      { color: stack.color === 'dark' ? 'white' : 'dark', count: stack.count }]));
  assert.deepEqual(worker.archivedEarlyStrategicThreat({ ...source, bot_color: 'white' }, white),
    worker.archivedEarlyStrategicThreat(source, base));
});

test('a lone early slot retains its old pre-threat onset and rejects absent or malformed native capacity', () => {
  const risk = (index, overrides = {}) => ({ index, tier: 0, earlyWindow: true,
    earlyThreat: { priority: 0, fenceBlocked: 0, signals: [] },
    capacity: { eligible: true, uniquePositions: 2 }, ...overrides });
  const onset = risk(4, { preThreat: { index: 4 } });
  const future = risk(2, { earlyThreat: { priority: 0, fenceBlocked: 0, signals: [], smallChoiceFutureThreat: true } });
  const severe = risk(7, { earlyThreat: { priority: 300, fenceBlocked: 3, signals: [] } });
  const late = risk(19, { earlyWindow: false, tier: 4 });
  assert.equal(worker.prioritizeStrategicReviewRisks([future, onset, severe, late], 2)[0], onset);
  for (const capacity of [undefined, { eligible: false, uniquePositions: 2 },
    { eligible: true, uniquePositions: '2' }, { eligible: true, uniquePositions: 4 }]) {
    const rejected = { ...future, capacity };
    assert.deepEqual(worker.prioritizeStrategicReviewRisks([rejected, onset, severe, late], 4)
      .slice(0, 2).map(row => row.index), [4, 7]);
  }
});

test('the new reservation spends exactly four expensive calls and creates no evidence itself', async () => {
  const source = game(); source.decisions[2] = decision(2, 'two', 60);
  const calls = [], results = [];
  for (let index = 0; index < source.decisions.length; index++) {
    results.push(await worker.reviewStrategicallyBoundedProductionDecision(source, index, {}, async (_game, row) => {
      calls.push(row.id); return { status: 'diagnostic-disagreement', evidence: null, outcomeUsed: false };
    }));
  }
  assert.deepEqual(calls, [2, 4, 18, 19].map(index => `synthetic-decision-${index}`));
  assert.ok(results.every(result => result.evidence === null));
  assert.equal(results[7].reason, 'production-strategic-risk-budget-skip');
});

test('signed-root contracts remain byte-identical apart from the reviewed cache registrations', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/long-bot-causal-worker.js'), 'utf8');
  // Public function-region hashes from the effective 9e9118af worker in
  // runtime86. The curriculum patch must preserve every signed-root boundary.
  const expected = {
    verifiedWarmRoot: 'e5e105447c134a7c12896d198b2e024fccdffdc1d0bc85efac1fdb8503632372',
    validatedWarmExperienceAttestation: '1a6e0a1df3513deed37bcb082aaa73cbb5e5c4fd4017fc055c819fb200be5caa',
    regenerateArchivedSelection: '9b26b50f93beecb33a53e8bfd29eb4204c1471a2b12e3266ce7e68b4c019ed9b',
    trustedDecisionEnvelopeFailure: 'b2e6661304ed8d6bed730ba97e9df4e7e5002a34dd1460282d8564664449dfbc',
    offlineTerminalJournalBindings: 'c7b02d7576e59b8eed407a903e3d38ca56ff1a9e8fe3ead69c1144dd29761ec8',
    reviewTrustedDecision: '6970b9bdadf01b1dab5d2a2f3dc5c82fce1e4dafec3a33a14295d98b9054ff08',
    runClaimedBatch: '8439b4720817e77760df91b28e9bf5dff57c7f650047e45011724469a0df4871',
  };
  for (const [name, digest] of Object.entries(expected)) {
    const at = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
    assert.ok(at >= 0, name);
    const tail = source.slice(at);
    const next = tail.slice(1).search(/\n(?:async )?function [A-Za-z_$][A-Za-z0-9_$]*\(/);
    const body = next < 0 ? tail : tail.slice(0, next + 1);
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'), digest, name);
  }
  assert.match(worker.productionStrategicReviewPlan.toString(), /productionStrategicReviewPlan\(game, options = \{\}\)/);
  assert.match(worker.productionStrategicReviewPlan.toString(), /trustedDecisionEnvelopeFailure\(game, decision, options\)/);
  assert.match(worker.reviewStrategicallyBoundedProductionDecision.toString(), /productionStrategicReviewPlan\(game, options\)/);
  const paired = fs.readFileSync(path.join(__dirname, '../scripts/long-bot-paired-rollout.js'), 'utf8');
  // Admit precisely this immutable native tuple plus its list/export entries.
  // Hash the remaining bytes against the original proof, so changing rollout
  // logic, scientific limits, older tuples or even unrelated bytes still fails.
  const quarterRegistration = `// Quarter geometry is derived only from canonical board/off counts. Its exact
// source tuple receives a separate namespace; old audited tuples stay intact.
const QUARTER_GEOMETRY_NATIVE_CACHE_POLICY = Object.freeze({
  policyImplementationId: 'd33a1c6219a986aee5e64312d233fa38db5aeb86e84aa13e6cd3578918d38306',
  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',
  runtimeBytesDigest: 'ce5d1150655fd642e77f04488819eb5003b63413b712ed962144d6adf1a65bf3',
});
`;
  const quarterReference = '  QUARTER_GEOMETRY_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(quarterRegistration).length - 1, 1,
    'only the exact reviewed quarter tuple may be removed');
  assert.equal(paired.split(quarterReference).length - 1, 2,
    'the reviewed tuple occurs once in the admitted list and once in exports');
  const adaptiveRegistration = `// Adaptive assessment reads canonical board, turn, dice and result only.
// Preserve all historical cache namespaces and bind this policy separately.
const ADAPTIVE_COUNTERPLAY_NATIVE_CACHE_POLICY = Object.freeze({
  policyImplementationId: '1aebb4b1b4ef8cf9fe02f86748d8dc3a9f41376710ac74b475f3b30011821946',
  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',
  runtimeBytesDigest: 'cb0902f60ece78841a400b1448662183de2312f42ddfb7c7dc4eaa294d558a69',
});
`;
  const adaptiveReference = '  ADAPTIVE_COUNTERPLAY_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(adaptiveRegistration).length - 1, 1);
  assert.equal(paired.split(adaptiveReference).length - 1, 2);
  const boardRegistration = `// Exact-position board advice reads only canonical rules state. Cold
// continuations contain no advice; the metadata-independence tests audit this
// new tuple separately without relabelling historical caches or evidence.
const BOARD_MODEL_LEARNING_NATIVE_CACHE_POLICY = Object.freeze({
  policyImplementationId: '2eac358adb59616fd96c7fe84fad43ef252d010906d6f6d7c69ac46c92c207b2',
  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',
  runtimeBytesDigest: '91228846724b92af4ca25ecbf9f16fb05257f6605c83150bcfc46832faa61fd8',
});
`;
  const boardReference = '  BOARD_MODEL_LEARNING_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(boardRegistration).length - 1, 1);
  assert.equal(paired.split(boardReference).length - 1, 2);
  const transferRegistration = "// Advice transfer changes learned choices; cold continuations still depend only\n// on canonical state and the exact audited native runtime.\nconst LIVE_TRANSFER_NATIVE_CACHE_POLICY = Object.freeze({\n  policyImplementationId: '7a263bcd3a44b7248b1b369e18dd552f1a5053e4f0772561f13c9a95e56abfa7',\n  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',\n  runtimeBytesDigest: 'eaef5de3e3125b41d6fc8b9b229416a70d94986ad327039c646a74cd44bd1389',\n});\n";
  const transferReference = '  LIVE_TRANSFER_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(transferRegistration).length - 1, 1);
  assert.equal(paired.split(transferReference).length - 1, 2);
  const libraryRegistration = "// The library safety guard affects model overrides only. Cold continuations\n// remain canonical; this independently pinned tuple has no historical alias.\nconst TRAINING_LIBRARY_NATIVE_CACHE_POLICY = Object.freeze({\n  policyImplementationId: 'db212e88d758f309b3ac3027c857acc55e8a415d1cdf4da3b5d753eea82be10b',\n  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',\n  runtimeBytesDigest: '1a1b19b954230e7b21c7a1a5b3c829937e6922e04690d51a02a3010cdd99a7e9',\n});\n";
  const libraryReference = "  TRAINING_LIBRARY_NATIVE_CACHE_POLICY,\n";
  assert.equal(paired.split(libraryRegistration).length - 1, 1);
  assert.equal(paired.split(libraryReference).length - 1, 2);
  const headEscapeRegistration = "// The head-exit guard changes model overrides only. Empty-experience native\n// continuations keep their own newly audited namespace; all old tuples stay.\nconst HEAD_ESCAPE_NATIVE_CACHE_POLICY = Object.freeze({\n  policyImplementationId: '1df51161ea08533712a1f392adc76a7116b4f20bf0e566c1ca244a9d46295f0a',\n  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',\n  runtimeBytesDigest: 'dc1402ccf10a0faf97e601335cd081d1b190ec3636f13b35b39f0d0ffb8da3f1',\n});\n";
  const headEscapeReference = '  HEAD_ESCAPE_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(headEscapeRegistration).length - 1, 1);
  assert.equal(paired.split(headEscapeReference).length - 1, 2);
  const contactDefenseRegistration = "// Contact defense changes choices and has its own immutable cold-cache tuple.\n// Canonical board/dice/off remain the complete planner input.\nconst CONTACT_DEFENSE_NATIVE_CACHE_POLICY = Object.freeze({\n  policyImplementationId: '06611894f7abdfe158a431d564f05bf47772ff05b1a684f26bacb775b711578a',\n  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',\n  runtimeBytesDigest: '01f998d2ce337a25af782ec7090bd7301905286d0c60daa41b95387c2b3c753b',\n});\n";
  const contactDefenseReference = '  CONTACT_DEFENSE_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(contactDefenseRegistration).length - 1, 1);
  assert.equal(paired.split(contactDefenseReference).length - 1, 2);
  const defensiveTransferRegistration = "// Legacy transfer requires the original board's defensive context. The cold\n// cache keeps a distinct source tuple; every published predecessor stays pinned.\nconst DEFENSIVE_TRANSFER_NATIVE_CACHE_POLICY = Object.freeze({\n  policyImplementationId: 'd8cfc3442dd5c9e81a8f13bfe34052a86aa6df4bbf3fe9b7e3aca780161dece9',\n  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',\n  runtimeBytesDigest: 'f570c3051b8e6e469d5c66030573597f04aa218aa4a8613028fb538a5161a6cd',\n});\n";
  const defensiveTransferReference = '  DEFENSIVE_TRANSFER_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(defensiveTransferRegistration).length - 1, 1);
  assert.equal(paired.split(defensiveTransferReference).length - 1, 2);
  const legalReplyRegistration = "// Mandatory legal replies have a distinct cold-cache identity. Published\n// predecessor tuples and their completed statistical cohorts stay unchanged.\nconst LEGAL_REPLY_NATIVE_CACHE_POLICY = Object.freeze({\n  policyImplementationId: '9417fd02f1f6957e878c0376aa00dbf91d2c6e3065269d27a3b2846b52e3ff13',\n  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',\n  runtimeBytesDigest: 'e5e8e9d8e0fa11912c186e1e40864f78381cdcfaea26504264ff467757b04920',\n});\n";
  const legalReplyReference = '  LEGAL_REPLY_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(legalReplyRegistration).length - 1, 1);
  assert.equal(paired.split(legalReplyReference).length - 1, 2);
  const deepLessonRegistration = "// Deep lesson comparisons have their own immutable cache identity. Older\n// policy cohorts and terminal evidence keep their original namespaces.\nconst DEEP_LESSON_NATIVE_CACHE_POLICY = Object.freeze({\n  policyImplementationId: '4f657d76f2d0e13d6ed2c09b123a52747140d76227a6703f7cb08cd03d4d8b98',\n  gameBytesDigest: '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',\n  runtimeBytesDigest: '727523ba3ee8f966efe1dd63138d5831671f38e1e3d5b8f41336bfa82fb6150d',\n});\n";
  const deepLessonReference = '  DEEP_LESSON_NATIVE_CACHE_POLICY,\n';
  assert.equal(paired.split(deepLessonRegistration).length - 1, 1);
  assert.equal(paired.split(deepLessonReference).length - 1, 2);
  const processCacheRegistration = "// Retain only validated native cold caches across resumable slices. The\n// namespace, exact VM object and the existing drift guards all must match.\n// Rules, policy decisions, fixed dice streams and terminal contracts stay\n// unchanged; the same deterministic work need not be repeated after a slice.\nfunction createProcessNativeCacheProvider(createCache, maxScopes = 2) {\n  if (typeof createCache !== 'function' || !Number.isInteger(maxScopes)\n    || maxScopes < 1 || maxScopes > 2) throw new Error('Invalid native cache scope bound');\n  const scopes = new Map();\n  return function processNativeCache(runtime, limits, attestation = {}) {\n    const fresh = createCache(runtime, limits, attestation);\n    const key = fresh.observation().namespaceFingerprint;\n    if (!key || !fresh.enabled()) return fresh;\n    const previous = scopes.get(key);\n    if (previous?.runtime === runtime && previous.cache.enabled()) {\n      scopes.delete(key); scopes.set(key, previous);\n      return previous.cache;\n    }\n    scopes.delete(key); scopes.set(key, { runtime, cache: fresh });\n    while (scopes.size > maxScopes) scopes.delete(scopes.keys().next().value);\n    return fresh;\n  };\n}\nconst processNativeColdCohortCache = createProcessNativeCacheProvider(createNativeColdCohortCache);\n\n";
  assert.equal(paired.split(processCacheRegistration).length - 1, 1);
  const originalPaired = paired.replace(quarterRegistration, '').replaceAll(quarterReference, '')
    .replace(adaptiveRegistration, '').replaceAll(adaptiveReference, '')
    .replace(boardRegistration, '').replaceAll(boardReference, '')
    .replace(transferRegistration, '').replaceAll(transferReference, '')
    .replace(libraryRegistration, '').replaceAll(libraryReference, '')
    .replace(headEscapeRegistration, '').replaceAll(headEscapeReference, '')
    .replace(contactDefenseRegistration, '').replaceAll(contactDefenseReference, '')
    .replace(defensiveTransferRegistration, '').replaceAll(defensiveTransferReference, '')
    .replace(legalReplyRegistration, '').replaceAll(legalReplyReference, '')
    .replace(deepLessonRegistration, '').replaceAll(deepLessonReference, '')
    .replace(processCacheRegistration, '')
    .replace('const nativeCache = bypass ? null : processNativeColdCohortCache(', 'const nativeCache = bypass ? null : createNativeColdCohortCache(')
    .replace('  createProcessNativeCacheProvider,\n', '');
  assert.equal(crypto.createHash('sha256').update(originalPaired).digest('hex'),
    '9c8e4c5c5b4c54e445faa265c328dc7a426e05b9d5f4ba8316a8b34f9830e39b');
});

test('reserving a future review cannot authorize an unsigned nonempty experience root', async () => {
  const source = game(); source.decisions[2] = decision(2, 'two', 60);
  const experience = source.final_state.analysis.botMemory.replayExperience;
  experience.size = experience.patternCount = 1;
  experience.patterns = [{ contextKey: 'unattested', actionKey: 'unattested', samples: 1 }];
  let called = false;
  const result = await worker.reviewStrategicallyBoundedProductionDecision(source, 2, {}, async () => {
    called = true; return { evidence: {} };
  });
  assert.equal(called, false);
  assert.equal(result.reason, 'production-decision-envelope-invalid');
  assert.equal(result.targetInvalidReason, 'recursive-experience-provenance-unsigned');
  assert.equal(result.evidence, null);
});
