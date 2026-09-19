'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const builder = require('../scripts/build-long-neural-v2-public-model');
const { fingerprint } = require('../lib/long-neural-artifact');
const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

test('committed public V2 envelope is exact, truthful and contains only frozen inference material', () => {
  const payload = JSON.parse(read('vendor/long-neural/model-v2.json'));
  assert.equal(builder.validatePublicModel(payload), payload);
  assert.equal(payload.schema, 'nardu-public-long-neural-v2');
  assert.equal(payload.metadata.modelFingerprint, fingerprint(payload.model));
  assert.equal(payload.metadata.productionEligible, false);
  assert.equal(payload.metadata.playerTestingEnabled, true);
  assert.equal(payload.metadata.strengthGatePassed, false);
  assert.equal(payload.metadata.noHumanOrProductionWinRateClaim, true);
  assert.deepEqual(payload.metadata.policyOptions,
    { maxCandidates: 32, replyTopCandidates: 2, replyCandidates: 4, replyWeight: 0.35 });
  assert.deepEqual(payload.metadata.developmentEvaluation, {
    reportFingerprint: 'sha256:4323d15452f7541de410ff828af46c50b0d2e6cd1933fc0f87807d17f53ad98e',
    protocolFingerprint: 'sha256:4ecdda3b0bc8563bd4d6b5737f144633e495c07cf50ab99a554bc3e554139565',
    purpose: 'development-validation', requestedGames: 6, completedGames: 5, wins: 3,
    censoredOrNotRunGames: 1, complete: false, strongPoolMilestonePassed: false,
    scope: 'predeclared-offline-opponent-pool-not-human-or-production-win-rate',
  });
  const text = JSON.stringify(payload.metadata);
  for (const forbidden of ['diceStreams', 'trainingDiceStreams', 'reservedDiceStreams', 'results', 'segments',
    'replay', 'teacherCorpus', 'sourceLedger', 'playerName', 'account', 'password', 'token']) {
    assert(!text.includes(forbidden), `public metadata leaked ${forbidden}`);
  }
  const seedPaths = [];
  (function visit(value, path = []) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (/seed/i.test(key)) seedPaths.push(childPath.join('.'));
      visit(child, childPath);
    }
  }(payload));
  // `model.seed` is the public value-network initialization parameter and is
  // part of its fingerprint; no game, dice, worker or evaluation seed ships.
  assert.deepEqual(seedPaths, ['model.seed']);
  assert.equal(read('vendor/long-neural/model-v2.js'), builder.assetSource(payload));
});

test('browser asset recursively freezes model, policy metadata and every weight array', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(read('vendor/long-neural/model-v2.js'), context);
  const payload = context.window.NarduLongNeuralV2Model;
  function frozen(value) {
    return value === null || typeof value !== 'object'
      || Object.isFrozen(value) && Object.values(value).every(frozen);
  }
  assert(frozen(payload));
  assert.equal(payload.metadata.modelFingerprint, builder.PIN.modelFingerprint);
  assert.equal(payload.model.trainingSteps, 39040);
  assert.equal(Object.getOwnPropertyDescriptor(context.window, 'NarduLongNeuralV2Model').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(context.window, 'NarduLongNeuralV2Model').configurable, false);
});

test('normal build validates committed V2 weights without access to private training data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-v2-public-'));
  const assetPath = path.join(directory, 'model-v2.js');
  const result = builder({ assetPath });
  assert.equal(result.metadata.id, 'hard-neuro-search-v2-32games-v1');
  assert.equal(fs.readFileSync(assetPath, 'utf8'), read('vendor/long-neural/model-v2.js'));
  fs.unlinkSync(assetPath); fs.rmdirSync(directory);
});

test('public V2 validation rejects altered weights, policy, evidence and extra fields', () => {
  const baseline = JSON.parse(read('vendor/long-neural/model-v2.json'));
  for (const mutate of [
    value => { value.model.inputWeights[0] += 1e-6; },
    value => { value.model.trainingSteps -= 1; },
    value => { value.metadata.policyOptions.replyWeight = 0; },
    value => { value.metadata.playerTestingEnabled = false; },
    value => { value.metadata.productionEligible = true; },
    value => { value.metadata.strengthGatePassed = true; },
    value => { value.metadata.developmentEvaluation.completedGames = 6; },
    value => { value.metadata.claimedWinRate = 0.65; },
    value => { value.results = []; },
  ]) {
    const changed = plain(baseline); mutate(changed);
    assert.throws(() => builder.validatePublicModel(changed));
  }
});

test('one-time generation requires both exact V2 inputs and rejects the legacy public envelope', () => {
  const legacy = path.join(ROOT, 'vendor/long-neural/model.json');
  assert.throws(() => builder({ sourcePath: legacy }), /supplied together/);
  assert.throws(() => builder({ developmentReportPath: legacy }), /supplied together/);
  assert.throws(() => builder({ sourcePath: legacy, developmentReportPath: legacy }), /offline V2 candidate|V2/);
});
