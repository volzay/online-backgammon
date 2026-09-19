'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const teacher = require('../scripts/build-long-neural-v2-teacher');
const legacy = require('../scripts/train-long-bot-neural');
const runtime = legacy.loadLongGame();
const modelArtifact = JSON.parse(fs.readFileSync(path.join(legacy.ROOT, 'vendor/long-neural/model.json'), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const options = { game: runtime.game, rulesFingerprint: runtime.fingerprint,
  modelArtifact, modelFingerprint: teacher.WARMSTART_MODEL };

function diagnosticInput({ points = { 8: { color: 'white', count: 1 }, 7: { color: 'white', count: 1 },
  6: { color: 'white', count: 1 }, 5: { color: 'white', count: 1 }, 12: { color: 'dark', count: 15 } },
off = { white: 11, dark: 0 }, selected = [{ from: 8, die: 4 }, { from: 4, die: 2 }],
dice = [2, 4] } = {}) {
  const before = runtime.game.initialState('long');
  Object.assign(before, { points, off, turn: 'white', phase: 'move', dice, rolled: [...dice],
    firstMoveDone: { white: true, dark: true } });
  const after = clone(before);
  for (const move of selected) {
    assert(runtime.game.applyMove(after, move.from, move.die, { autoEnd: false }));
    if (after.winner) break;
  }
  assert(after.winner || !runtime.game.hasAnyMoves(after));
  if (!after.winner) runtime.game.endTurn(after);
  const winner = after.winner || 'dark';
  const final = after.winner ? { points: after.points, off: after.off, phase: 'over', winner }
    : { points: { 24: { color: 'white', count: 15 } }, off: { white: 0, dark: 15 }, phase: 'over', winner };
  const resultType = after.winner ? runtime.game.resultTypeFor(after, winner) : 'koks';
  return { schema: teacher.INPUT_SCHEMA, rooms: [{ variant: 'long', roomCode: 'TEST-A123',
    botColor: 'white', playerColor: 'dark', winner, resultType, final,
    neuralModel: clone(modelArtifact.metadata), decisions: [{ schema: 'nardu-neural-decision-v1',
      before, selected, diagnostics: { policy: 'hard-neuro', modelFingerprint: teacher.WARMSTART_MODEL },
      execution: { complete: true, executedMoves: clone(selected), after } }] }] };
}

function rehash(corpus) {
  delete corpus.contentFingerprint;
  corpus.contentFingerprint = legacy.fingerprint(corpus);
  return corpus;
}

test('teacher certifies complete execution and all unique legal outcomes, not diagnostic authenticity', () => {
  const input = diagnosticInput();
  const before = clone(input);
  const corpus = teacher.buildTeacherCorpus(input, options);
  assert.deepEqual(input, before);
  assert.equal(corpus.schema, teacher.SCHEMA);
  assert.equal(corpus.productionEligible, false);
  assert.equal(corpus.provenance.verification, teacher.VERIFICATION);
  assert.equal(corpus.provenance.modelFingerprint, teacher.WARMSTART_MODEL);
  assert.equal(corpus.summary.positions, 1);
  assert.equal(corpus.summary.causalLabels, 0);
  assert.equal(corpus.summary.authenticatedMatches, 0);
  assert.equal(corpus.summary.terminalTrainingTargets, 0);
  assert(corpus.positions[0].outcomes.length > 1);
  assert.equal(new Set(corpus.positions[0].outcomes.map(row => row.positionKey)).size,
    corpus.positions[0].outcomes.length);
  assert.equal(teacher.validateTeacherCorpus(corpus, options).positions, 1);
});

test('clear-route home teaching uses guarded pairwise surrogates, never a losing move as optimal', () => {
  const corpus = teacher.buildTeacherCorpus(diagnosticInput(), options);
  const position = corpus.positions[0];
  assert(position.preferences.some(preference => preference.criterion === 'clear-route-home-progress'));
  const samples = teacher.createTrainingSamples(corpus, options);
  assert(samples.length > 0 && samples.length % 2 === 0);
  for (let index = 0; index < samples.length; index += 2) {
    assert.equal(samples[index].target, 0.7);
    assert.equal(samples[index + 1].target, 0.3);
    assert.equal(samples[index].targetKind, teacher.TARGET_KIND);
    assert.notDeepEqual(samples[index].state.points, samples[index + 1].state.points);
    assert.equal(samples[index].sourcePositionId, position.positionId);
    assert.equal(samples[index].preferenceCriterion, samples[index + 1].preferenceCriterion);
  }
  const second = teacher.createTrainingSamples(corpus, options);
  samples[0].state.points = {};
  assert.notDeepEqual(samples[0].state, second[0].state);
  assert.deepEqual(teacher.buildTeacherCorpus(diagnosticInput(), options), corpus);
});

test('projection strips identity, authorization, historical proofs and future-dice annotations', () => {
  const input = diagnosticInput();
  input.rooms[0].account = { password: 'SECRET_IDENTITY_MARKER' };
  input.rooms[0].decisions[0].id = 'PRIVATE_USER_MARKER';
  input.rooms[0].decisions[0].before.auth = 'SECRET_ACCESS_MARKER';
  input.rooms[0].decisions[0].before.history = [{ proof: { serverSeed: 'SECRET_SEED_MARKER' } }];
  input.rooms[0].decisions[0].before.futureDice = ['SECRET_FUTURE_MARKER'];
  input.rooms[0].decisions[0].execution.after.session = 'SECRET_SESSION_MARKER';
  const corpus = teacher.buildTeacherCorpus(input, options);
  const text = JSON.stringify(corpus);
  for (const marker of ['SECRET_IDENTITY_MARKER', 'PRIVATE_USER_MARKER', 'SECRET_ACCESS_MARKER',
    'SECRET_SEED_MARKER', 'SECRET_FUTURE_MARKER', 'SECRET_SESSION_MARKER']) assert(!text.includes(marker));
  const samples = teacher.createTrainingSamples(corpus, options);
  assert(samples.every(sample => sample.state.history.length === 0 && !Object.hasOwn(sample.state, 'auth')));
});

test('incomplete, illegal, changed execution or unknown historical origin is rejected', () => {
  const mutations = [
    input => { input.rooms[0].decisions[0].execution.complete = false; },
    input => { input.rooms[0].decisions[0].selected[0].from = 12; },
    input => { input.rooms[0].decisions[0].execution.executedMoves[0].die = 1; },
    input => { input.rooms[0].decisions[0].execution.after.off.white += 1; },
    input => { input.rooms[0].neuralModel.modelFingerprint = `sha256:${'0'.repeat(64)}`; },
    input => { input.rooms[0].neuralModel.rulesFingerprint = `sha256:${'0'.repeat(64)}`; },
    input => { input.rooms[0].neuralModel.runtimeRulesFingerprint = `sha256:${'0'.repeat(64)}`; },
    input => { input.rooms[0].resultType = 'mars'; },
    input => { input.rooms.push(clone(input.rooms[0])); },
    input => { input.rooms[0].decisions[0].before.headPlayedThisTurn.white = true; },
    input => { input.rooms[0].decisions[0].before.dice = [2]; },
  ];
  for (const mutate of mutations) {
    const input = diagnosticInput(); mutate(input);
    assert.throws(() => teacher.buildTeacherCorpus(input, options));
  }
  assert.throws(() => teacher.buildTeacherCorpus({ schema: 'hard-loss-review-v9', rooms: [] }, options), /full-provenance/);
  assert.throws(() => teacher.buildTeacherCorpus(diagnosticInput(), { ...options, rulesFingerprint: `sha256:${'0'.repeat(64)}` }), /rules revision/);
});

test('corpus validation rejects rehashed forged legal sets, preference labels and causal assertions', () => {
  const original = teacher.buildTeacherCorpus(diagnosticInput(), options);
  const mutations = [
    corpus => { corpus.positions[0].outcomes.pop(); },
    corpus => { corpus.positions[0].outcomes[0].moves[0].die = 1; },
    corpus => { corpus.positions[0].outcomes[0].legacyValue += 0.1; },
    corpus => { corpus.positions[0].outcomes[0].metrics.pips = 0; },
    corpus => { corpus.positions[0].preferences[0].kind = 'verified-causal-win-probability'; },
    corpus => { corpus.positions[0].preferences[0].preferredPositionKey = corpus.positions[0].executed.positionKey; },
    corpus => { corpus.positions[0].executed.observedTerminalDiagnostic.kind = 'terminal-counterfactual-target'; },
    corpus => { corpus.positions[0].source.decisionIndex = 2; },
    corpus => { corpus.summary.authenticatedMatches = 1; },
    corpus => { corpus.positions[0].executed.moves[0].auth = 'private'; },
  ];
  for (const mutate of mutations) {
    const corpus = clone(original); mutate(corpus); rehash(corpus);
    assert.throws(() => teacher.validateTeacherCorpus(corpus, options));
    assert.throws(() => teacher.createTrainingSamples(corpus, options));
  }
  const altered = clone(original); altered.summary.positions = 999;
  assert.throws(() => teacher.validateTeacherCorpus(altered, options), /fingerprint/);
  assert.throws(() => teacher.validateTeacherCorpus(original, { ...options,
    modelFingerprint: `sha256:${'0'.repeat(64)}` }), /requested model/);
});

test('forced pass and genuine terminal alternatives preserve exact rule context without fake pair labels', () => {
  // White has one checker at home point 1; its next legal move ends the game.
  const terminalInput = diagnosticInput({ points: { 1: { color: 'white', count: 1 }, 12: { color: 'dark', count: 15 } },
    off: { white: 14, dark: 0 }, selected: [{ from: 1, die: 4 }] });
  const corpus = teacher.buildTeacherCorpus(terminalInput, options);
  assert(corpus.positions[0].executed.afterState.winner === 'white');
  assert.equal(teacher.validateTeacherCorpus(corpus, options).positions, 1);
  assert.deepEqual(teacher.createTrainingSamples(corpus, options), []);
  // The recorded move leaves one checker, but an alternative wins now. A
  // terminal preferred row must not leave an orphaned .3 surrogate sample.
  const terminalPreferenceInput = diagnosticInput({ points: {
    3: { color: 'white', count: 1 }, 1: { color: 'white', count: 1 },
    12: { color: 'dark', count: 15 } }, off: { white: 13, dark: 0 },
  selected: [{ from: 3, die: 2 }, { from: 1, die: 4 }] });
  const terminalPreferenceCorpus = teacher.buildTeacherCorpus(terminalPreferenceInput, options);
  assert(terminalPreferenceCorpus.positions[0].preferences.some(preference => {
    const preferred = terminalPreferenceCorpus.positions[0].outcomes.find(row => row.positionKey === preference.preferredPositionKey);
    const disfavored = terminalPreferenceCorpus.positions[0].outcomes.find(row => row.positionKey === preference.disfavoredPositionKey);
    return preferred.afterState.winner === 'white' && !disfavored.afterState.winner;
  }));
  assert.deepEqual(teacher.createTrainingSamples(terminalPreferenceCorpus, options), []);
  const pass = diagnosticInput({ points: { 24: { color: 'white', count: 15 },
    23: { color: 'dark', count: 8 }, 21: { color: 'dark', count: 7 } },
  off: { white: 0, dark: 0 }, dice: [1, 3], selected: [] });
  const passCorpus = teacher.buildTeacherCorpus(pass, options);
  assert.equal(passCorpus.positions[0].outcomes.length, 1);
  assert.deepEqual(passCorpus.positions[0].outcomes[0].moves, []);
  assert.equal(passCorpus.positions[0].outcomes[0].afterState.turn, 'dark');
  assert.equal(teacher.validateTeacherCorpus(passCorpus, options).positions, 1);
});

test('late-game Koks teaching matches actual own starting quarter and has no probability claim', () => {
  const before = runtime.game.initialState('long');
  Object.assign(before, { phase: 'move', turn: 'white', points: {
    20: { color: 'white', count: 2 }, 17: { color: 'white', count: 13 },
    1: { color: 'dark', count: 1 } }, off: { white: 0, dark: 14 },
  dice: [2, 4], rolled: [2, 4], firstMoveDone: { white: true, dark: true } });
  const input = diagnosticInput({ points: before.points, off: before.off,
    selected: [{ from: 17, die: 4 }, { from: 17, die: 2 }] });
  const corpus = teacher.buildTeacherCorpus(input, options);
  const preferences = corpus.positions[0].preferences.filter(preference => preference.criterion === 'late-game-koks-exposure');
  assert.equal(preferences.length, 1);
  const preferred = corpus.positions[0].outcomes.find(row => row.positionKey === preferences[0].preferredPositionKey);
  assert.equal(preferred.metrics.koksExposure, 0);
  assert.equal(corpus.positions[0].outcomes.find(row => row.positionKey === corpus.positions[0].executed.positionKey).metrics.koksExposure, 2);
  assert.equal(preferences[0].kind, 'heuristic-preference-not-causal-probability');
  assert.equal(teacher.validateTeacherCorpus(corpus, options).positions, 1);
});

test('CLI requires explicit separate paths and writes exclusively without touching existing artifacts', () => {
  assert.deepEqual(teacher.cli(['--help']), { help: true });
  assert.throws(() => teacher.cli(['--input', 'relative.json', '--output', '/private/tmp/output.json']), /absolute/);
  assert.throws(() => teacher.cli(['--input', '/private/tmp/a.json', '--output', '/private/tmp/a.json']), /separate/);
  assert.throws(() => teacher.cli(['--input', '/private/tmp/a.json', '--input', '/private/tmp/b.json']), /usage/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-v2-teacher-cli-'));
  const input = path.join(directory, 'input.json'); const output = path.join(directory, 'output.json');
  fs.writeFileSync(input, JSON.stringify(diagnosticInput()), { mode: 0o600 });
  const command = ['scripts/build-long-neural-v2-teacher.js', '--input', input, '--output', output];
  const first = spawnSync(process.execPath, command, { cwd: legacy.ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(first.status, 0, first.stderr);
  const saved = fs.readFileSync(output);
  const second = spawnSync(process.execPath, command, { cwd: legacy.ROOT, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(second.status, 0);
  assert.deepEqual(fs.readFileSync(output), saved);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});
