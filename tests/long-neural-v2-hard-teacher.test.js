'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('../scripts/build-long-neural-v2-hard-teacher');
const teacher = require('../scripts/build-long-neural-v2-teacher');
const shadow = require('../scripts/generate-long-bot-shadow-replay');
const legacy = require('../scripts/train-long-bot-neural');
const planner = require('../lib/long-bot-neural-v2');
const clone = legacy.clone;
let fixture; let nonExpertFixture; let contactFixture; let terminalFixture;
test.before(() => {
  shadow.clearRuntimeCache();
  const runtime = shadow.loadRuntime();
  runtime.engine.setExperience([], 'synthetic-fixture'); runtime.engine.freezeExperience('synthetic-fixture');
  const state = runtime.game.initialState('long');
  state.phase = 'move'; state.turn = 'dark'; state.dice = [2, 1]; state.rolled = [2, 1];
  state.firstMoveDone = { white: true, dark: true };
  state.points = { 13: { color: 'dark', count: 15 }, 24: { color: 'white', count: 15 } };
  runtime.engine.plan(state);
  const decision = clone(runtime.engine.consumeLastDecision());
  assert(decision?.stateSnapshotV2 && decision.selected?.after);
  decision.execution = { complete: true, fallback: false, substituted: false,
    executed: { moves: clone(decision.selected.moves), after: clone(decision.selected.after) } };
  fixture = { schema: helper.INPUT_SCHEMA, games: [{ roomCode: 'TEST-HARD', variant: 'long', botColor: 'dark',
    source: null, decisions: [decision] }] };
  const nonExpert = runtime.game.initialState('long');
  nonExpert.phase = 'move'; nonExpert.turn = 'dark'; nonExpert.dice = [1, 3]; nonExpert.rolled = [1, 3];
  nonExpert.firstMoveDone = { white: true, dark: true };
  nonExpert.points = { 12: { color: 'dark', count: 3 }, 14: { color: 'dark', count: 7 },
    4: { color: 'dark', count: 5 }, 24: { color: 'white', count: 15 } };
  // A real repository engine invocation with deliberately non-expert weights
  // proves that importer targets come from independent geometric guards, not
  // admiration for a hard-bot action. This is synthetic, NOT a historical game.
  runtime.engine.plan(nonExpert, { strategyProfile: 'v25', maxCandidates: 16, analysisNodeBudget: 64,
    weights: { headRelease: -1e9, progress: 0 } });
  const nonExpertDecision = clone(runtime.engine.consumeLastDecision());
  nonExpertDecision.execution = { complete: true, fallback: false, substituted: false,
    executed: { moves: clone(nonExpertDecision.selected.moves), after: clone(nonExpertDecision.selected.after) } };
  contactFixture = { schema: helper.INPUT_SCHEMA, games: [{ roomCode: 'TEST-STOP', variant: 'long', botColor: 'dark',
    source: null, decisions: [nonExpertDecision] }] };
  const noContact = clone(nonExpert);
  delete noContact.points[24]; noContact.points[1] = { color: 'white', count: 15 };
  runtime.engine.plan(noContact, { strategyProfile: 'v25', maxCandidates: 16, analysisNodeBudget: 64,
    weights: { headRelease: -1e9, progress: 0 } });
  const noContactDecision = clone(runtime.engine.consumeLastDecision());
  noContactDecision.execution = { complete: true, fallback: false, substituted: false,
    executed: { moves: clone(noContactDecision.selected.moves), after: clone(noContactDecision.selected.after) } };
  nonExpertFixture = { schema: helper.INPUT_SCHEMA, games: [{ roomCode: 'TEST-SOFT', variant: 'long', botColor: 'dark',
    source: null, decisions: [noContactDecision] }] };
  const terminal = runtime.game.initialState('long');
  terminal.phase = 'move'; terminal.turn = 'dark'; terminal.dice = [2, 4]; terminal.rolled = [2, 4];
  terminal.firstMoveDone = { white: true, dark: true };
  terminal.points = { 14: { color: 'dark', count: 1 }, 16: { color: 'dark', count: 1 },
    1: { color: 'white', count: 4 } };
  terminal.off = { white: 11, dark: 13 };
  runtime.engine.plan(terminal);
  const terminalDecision = clone(runtime.engine.consumeLastDecision());
  terminalDecision.execution = { complete: true, fallback: false, substituted: false,
    executed: { moves: clone(terminalDecision.selected.moves), after: clone(terminalDecision.selected.after) } };
  assert.deepEqual(terminalDecision.selected.moves.map(({ from, die }) => ({ from, die })),
    [{ from: 14, die: 2 }, { from: 16, die: 4 }]);
  assert.deepEqual(clone(planner.enumerateUniqueTurns(runtime.game, terminal).rows.find(row => row.afterState.winner).moves),
    [{ from: 16, die: 4 }, { from: 14, die: 2 }]);
  terminalFixture = { schema: helper.INPUT_SCHEMA, games: [{ roomCode: 'TEST-WINS', variant: 'long', botColor: 'dark',
    source: null, decisions: [terminalDecision] }] };
});

test('no-contact soft targets preserve progress learning and can penalize the actually recorded non-expert hard action', () => {
  const corpus = helper.buildTeacherCorpus(nonExpertFixture), samples = helper.createTrainingSamples(corpus);
  assert.equal(corpus.summary.heuristicPreferences, 1);
  assert.equal(samples.length, 2); assert.deepEqual(samples.map(row => row.target), [0.7, 0.3]);
  assert(samples.every(row => row.targetKind === helper.TARGET_KIND));
  assert.equal(samples[0].preferenceCriterion, 'head-release-without-retreat');
  assert.equal(legacy.canonical(samples[1].state), legacy.canonical(corpus.positions[0].executed.afterState));
  assert.notEqual(legacy.canonical(samples[0].state), legacy.canonical(samples[1].state));
  assert.equal(corpus.summary.archivedChoiceOptimalTargets, 0);
  assert.equal(corpus.summary.causalLabels, 0);
});
function rehash(corpus) {
  const { contentFingerprint, ...body } = corpus; corpus.contentFingerprint = legacy.fingerprint(body);
}

test('hard-only guard rejects a legal progress preference that releases a meaningful enemy barrier and recertification cannot restore it', () => {
  const corpus = helper.buildTeacherCorpus(contactFixture), position = corpus.positions[0];
  assert.equal(corpus.summary.eligibleDecisions, 1);
  const generic = teacher.preferences(position.outcomes, position.executed.positionKey);
  assert.equal(generic.length, 1); assert.equal(generic[0].criterion, 'head-release-without-retreat');
  const preferred = position.outcomes.find(row => row.positionKey === generic[0].preferredPositionKey),
    disfavored = position.outcomes.find(row => row.positionKey === generic[0].disfavoredPositionKey),
    game = legacy.loadLongGame().game, enemyRoute = Array.from(game.pathFor('white', 'long'));
  const earliestEnemy = Math.min(...Object.entries(disfavored.afterState.points)
    .filter(([, stack]) => stack.color === 'white').map(([point]) => enemyRoute.indexOf(Number(point))));
  assert(Object.entries(disfavored.afterState.points).some(([point, stack]) => stack.color === 'dark'
    && enemyRoute.indexOf(Number(point)) > earliestEnemy && preferred.afterState.points[point]?.color !== 'dark'));
  assert.equal(position.preferences.length, 0); assert.equal(corpus.summary.heuristicPreferences, 0);
  assert.equal(helper.createTrainingSamples(corpus).length, 0);
  assert.equal(helper.validateTeacherCorpus(corpus).eligibleDecisions, 1);
  const tampered = clone(corpus);
  tampered.positions[0].preferences = clone(generic); tampered.summary.heuristicPreferences = 1;
  rehash(tampered);
  assert.throws(() => helper.validateTeacherCorpus(tampered), /outcomes-or-preferences-not-canonical/);
});

test('commuting final bear-offs retain literal ordered execution without admitting altered terminal moves or any terminal training target', () => {
  const corpus = helper.buildTeacherCorpus(terminalFixture), position = corpus.positions[0];
  assert.equal(corpus.summary.eligibleDecisions, 1);
  assert.equal(position.executed.afterState.winner, 'dark');
  const representative = position.outcomes.find(row => row.positionKey === position.executed.positionKey);
  assert(representative);
  assert.deepEqual(position.executed.moves, [{ from: 14, die: 2 }, { from: 16, die: 4 }]);
  assert.deepEqual(position.executed.afterState.turnMoves.map(({ from, die }) => ({ from, die })), position.executed.moves);
  assert.notDeepEqual(position.executed.afterState.turnMoves, representative.afterState.turnMoves);
  assert.equal(helper.validateTeacherCorpus(corpus).eligibleDecisions, 1);
  assert.equal(helper.createTrainingSamples(corpus).length, 0);
  assert.equal(corpus.summary.terminalTrainingTargets, 0);
  for (const mutate of [changed => { changed.positions[0].executed.afterState.turnMoves[0].to = 13; },
    changed => { changed.positions[0].executed.afterState.turnMoves[0].die = 3; },
    changed => { changed.positions[0].executed.afterState.turnMoves.reverse(); },
    changed => { changed.positions[0].outcomes.find(row => row.afterState.winner).afterState.turnMoves[0].from = 13; }]) {
    const changed = clone(corpus); mutate(changed); rehash(changed);
    assert.throws(() => helper.validateTeacherCorpus(changed), /outcomes-or-preferences-not-canonical/);
  }
  const changedExecution = clone(terminalFixture);
  changedExecution.games[0].decisions[0].execution.executed.moves.reverse();
  const rejected = helper.buildTeacherCorpus(changedExecution);
  assert.equal(rejected.summary.eligibleDecisions, 0);
  assert.equal(rejected.records[0].reason, 'selected-executed-movement-mismatch');
  assert.equal(helper.createTrainingSamples(rejected).length, 0);
});

test('nonterminal projected outcomes still require exact movement context during independent recertification', () => {
  const corpus = helper.buildTeacherCorpus(fixture);
  assert(corpus.positions.every(position => !position.executed.afterState.winner));
  for (const mutate of [changed => { changed.positions[0].executed.afterState.turnMoves.push(
    { color: 'dark', from: 13, to: 12, die: 1, bearOff: false }); },
    changed => { changed.positions[0].outcomes[0].afterState.turnMoves.push(
      { color: 'dark', from: 13, to: 12, die: 1, bearOff: false }); }]) {
    const changed = clone(corpus); mutate(changed); rehash(changed);
    assert.throws(() => helper.validateTeacherCorpus(changed), /outcomes-or-preferences-not-canonical/);
  }
});

test('actual generated hard decision becomes only current-rule replayed geometric training diagnostics, not signed expertise', () => {
  const before = legacy.fingerprint(fixture), corpus = helper.buildTeacherCorpus(fixture);
  assert.equal(corpus.schema, helper.SCHEMA); assert.equal(corpus.productionEligible, false);
  assert.equal(corpus.summary.inputDecisions, 1); assert.equal(corpus.summary.eligibleDecisions, 1);
  assert.equal(corpus.summary.skippedDecisions, 0); assert.equal(corpus.summary.unverifiedSourceDecisions, 1);
  assert.equal(corpus.positions[0].source.observedSource, null);
  assert.equal(corpus.positions[0].source.sourceIdentityVerified, false);
  assert.equal(corpus.positions[0].source.sourceVerification, 'unverified-playing-origin-current-rules-local-replay');
  assert.equal(corpus.positions[0].executed.archivedChoiceIsOptimalLabel, false);
  for (const key of ['causalLabels', 'terminalTrainingTargets', 'authenticatedMatches', 'archivedChoiceOptimalTargets']) {
    assert.equal(corpus.summary[key], 0);
  }
  assert.equal(helper.validateTeacherCorpus(corpus).eligibleDecisions, 1);
  assert.equal(legacy.fingerprint(fixture), before);
  for (const sample of helper.createTrainingSamples(corpus)) {
    assert([0.3, 0.7].includes(sample.target)); assert.equal(sample.targetKind, helper.TARGET_KIND);
    assert.equal(sample.state.history.length, 0);
  }
});

test('explicit known source requires one complete exact audited tuple; mixed and unknown tuples never become eligible', () => {
  for (const tuple of helper.SOURCE_TUPLES) {
    const input = clone(fixture); input.games[0].source = clone(tuple);
    const corpus = helper.buildTeacherCorpus(input);
    assert.equal(corpus.summary.verifiedSourceDecisions, 1);
    assert.equal(corpus.positions[0].source.sourceVerification, 'allowlisted-playing-origin-not-authenticated');
    assert.equal(helper.validateTeacherCorpus(corpus).authenticatedMatches, 0);
  }
  for (const source of [{ ...helper.SOURCE_TUPLES[0], gameSourceFingerprint: helper.SOURCE_TUPLES[1].gameSourceFingerprint },
    { ...helper.SOURCE_TUPLES[1], policyImplementationId: 'f'.repeat(64) },
    { policyImplementationId: null, gameSourceFingerprint: helper.SOURCE_TUPLES[0].gameSourceFingerprint, runtimeBundleFingerprint: null }]) {
    const input = clone(fixture); input.games[0].source = source;
    const corpus = helper.buildTeacherCorpus(input);
    assert.equal(corpus.summary.eligibleDecisions, 0); assert.equal(corpus.summary.skippedDecisions, 1);
    assert.equal(corpus.records[0].reason, 'unsupported-source-identity');
    assert.equal(helper.createTrainingSamples(corpus).length, 0);
  }
});

test('missing snapshot, wrong FNV prefix, replay identity, incomplete/substituted execution and mechanical metrics are individually reported before labels', () => {
  const mutations = [decision => { delete decision.stateSnapshotV2; },
    decision => { decision.stateFingerprintV2 = 'lb4-12345678'; },
    decision => { decision.replayInput.stateFingerprintV2 = 'lbs2-00000000'; },
    decision => { decision.replayInput.engineVersion = 'long-analytic-v34'; },
    decision => { decision.execution.complete = false; },
    decision => { decision.execution.substituted = true; },
    decision => { decision.execution.executed.moves[0].die = 6; },
    decision => { decision.execution.executed.after.off.dark += 1; },
    decision => { decision.selected.features.pipGain += 1; },
    decision => { decision.selected.features.homeGain = '0'; },
  ];
  for (const mutate of mutations) {
    const input = clone(fixture), original = clone(input.games[0].decisions[0]);
    mutate(input.games[0].decisions[0]); input.games[0].decisions.push(original);
    const corpus = helper.buildTeacherCorpus(input);
    assert.equal(corpus.summary.inputDecisions, 2); assert.equal(corpus.summary.eligibleDecisions, 1);
    assert.equal(corpus.summary.skippedDecisions, 1); assert.equal(corpus.positions.length, 1);
    assert.equal(corpus.positions[0].source.decisionIndex, 2);
    assert.equal(corpus.records[0].status, 'skipped'); assert(corpus.records[0].reason);
    assert.equal(corpus.records[0].decision, undefined, 'Rejected logs must not leak into retained sample states');
    assert.equal(helper.validateTeacherCorpus(corpus).eligibleDecisions, 1);
  }
});

test('rehashing cannot bless altered rule states, metrics, outcomes, identities, preferences or skipped counters', () => {
  const clean = helper.buildTeacherCorpus(fixture);
  for (const mutate of [corpus => { corpus.positions[0].before.off.dark = 1; },
    corpus => { corpus.positions[0].outcomes[0].metrics.off += 1; },
    corpus => { corpus.positions[0].outcomes[0].legacyValue = 0.999; },
    corpus => { corpus.positions[0].outcomes.pop(); },
    corpus => { corpus.records[0].sourceIdentityVerified = true; },
    corpus => { corpus.positions[0].executed.archivedChoiceIsOptimalLabel = true; },
    corpus => { corpus.positions[0].preferences.push({ kind: 'causal', criterion: 'win', weight: 1 }); },
    corpus => { corpus.summary.skippedDecisions += 1; },
    corpus => { corpus.provenance.plannerFingerprint = `sha256:${'f'.repeat(64)}`; },
  ]) {
    const changed = clone(clean); mutate(changed); rehash(changed);
    assert.throws(() => helper.validateTeacherCorpus(changed));
  }
});

test('teacher retains no timestamp, names, future dice, opaque tactics or terminal game labels', () => {
  const input = clone(fixture), decision = input.games[0].decisions[0];
  decision.playerName = 'PRIVATE-IDENTITY'; decision.nextDice = [6, 6]; decision.at = 'PRIVATE-TIMESTAMP';
  decision.selected.tactical = { falseFutureWin: true }; decision.selected.score = 999999999999;
  decision.observedWinner = 'white'; decision.observedResult = 'koks';
  const corpus = helper.buildTeacherCorpus(input), text = JSON.stringify(corpus);
  assert.equal(corpus.summary.eligibleDecisions, 1);
  assert(!text.includes('PRIVATE-IDENTITY')); assert(!text.includes('PRIVATE-TIMESTAMP'));
  assert(!text.includes('falseFutureWin')); assert(!text.includes('999999999999'));
  assert(!text.includes('observedWinner')); assert(!text.includes('nextDice'));
  assert.equal(helper.validateTeacherCorpus(corpus).eligibleDecisions, 1);
});

test('opaque private-looking experience identity and strategy profile never pass into the corpus', () => {
  for (const mutate of [decision => {
    decision.experienceFingerprint = 'PRIVATE-NAME-TOKEN-SEED';
    decision.replayInput.experienceFingerprint = decision.experienceFingerprint;
  }, decision => { decision.replayInput.runtime.strategyProfile = 'PRIVATE-PROFILE-NAME'; },
  decision => {
    decision.experienceFingerprint = 'lbe8-NOTHEX00';
    decision.replayInput.experienceFingerprint = decision.experienceFingerprint;
  }]) {
    const input = clone(fixture); mutate(input.games[0].decisions[0]);
    const corpus = helper.buildTeacherCorpus(input);
    assert.equal(corpus.summary.eligibleDecisions, 0); assert.equal(corpus.summary.skippedDecisions, 1);
    assert(!JSON.stringify(corpus).includes('PRIVATE-'));
    assert(!JSON.stringify(corpus).includes('NOTHEX00'));
    assert.equal(helper.validateTeacherCorpus(corpus).eligibleDecisions, 0);
  }
});

test('both building and recertification abort on incremental outcome budget exhaustion instead of granting partial labels', () => {
  const corpus = helper.buildTeacherCorpus(nonExpertFixture);
  assert(corpus.summary.uniqueLegalOutcomes > 1);
  assert.throws(() => helper.buildTeacherCorpus(nonExpertFixture, { maxOutcomes: 1 }), /global-outcome-budget/);
  assert.throws(() => helper.validateTeacherCorpus(corpus, { maxOutcomes: 1 }), /global-outcome-budget/);
  const forgedCount = clone(corpus); forgedCount.summary.uniqueLegalOutcomes = 0; rehash(forgedCount);
  assert.throws(() => helper.validateTeacherCorpus(forgedCount, { maxOutcomes: 1 }), /global-outcome-budget/,
    'Independent enumeration must enforce the budget rather than relying on an attacker-controlled summary');
  for (const options of [{ maxElapsedMs: 0 }, { maxElapsedMs: Infinity }, { maxOutcomes: 0 }, { maxOutcomes: 100001 }]) {
    assert.throws(() => helper.validateTeacherCorpus(corpus, options), /invalid-.*-budget/);
  }
});

test('validation has its own deadline and sample creation cannot bypass that deadline', () => {
  const corpus = helper.buildTeacherCorpus(nonExpertFixture), originalNow = Date.now;
  let tick = 0;
  Date.now = () => { tick += 5; return tick; };
  try {
    assert.throws(() => helper.validateTeacherCorpus(corpus, { maxElapsedMs: 4 }), /global-time-budget-no-partial-corpus/);
    assert.throws(() => helper.createTrainingSamples(corpus, { maxElapsedMs: 4 }), /global-time-budget-no-partial-corpus/);
    assert.throws(() => helper.buildTeacherCorpus(nonExpertFixture, { maxElapsedMs: 4 }), /global-time-budget-no-partial-corpus/);
  } finally { Date.now = originalNow; }
});
