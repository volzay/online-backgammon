#!/usr/bin/env node
'use strict';

// Publish only the frozen value network and a bounded, truthful release
// manifest. Complete training/evaluation ledgers, dice streams, replay data and
// private teacher corpora must never enter either browser asset.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const neural = require('../lib/long-bot-neural');
const trainer = require('./train-long-bot-neural-v2');
const evaluator = require('./evaluate-long-bot-neural-v2');
const { canonical, fingerprint } = require('../lib/long-neural-artifact');

const ROOT = path.join(__dirname, '..');
const PUBLIC_PATH = path.join(ROOT, 'vendor/long-neural/model-v2.json');
const ASSET_PATH = path.join(ROOT, 'vendor/long-neural/model-v2.js');
const POLICY_OPTIONS = Object.freeze({
  maxCandidates: 32,
  replyTopCandidates: 2,
  replyCandidates: 4,
  replyWeight: 0.35,
});
const DEVELOPMENT_EVALUATION = Object.freeze({
  reportFingerprint: 'sha256:4323d15452f7541de410ff828af46c50b0d2e6cd1933fc0f87807d17f53ad98e',
  protocolFingerprint: 'sha256:4ecdda3b0bc8563bd4d6b5737f144633e495c07cf50ab99a554bc3e554139565',
  purpose: 'development-validation',
  requestedGames: 6,
  completedGames: 5,
  wins: 3,
  censoredOrNotRunGames: 1,
  complete: false,
  strongPoolMilestonePassed: false,
  scope: 'predeclared-offline-opponent-pool-not-human-or-production-win-rate',
});
const PIN = Object.freeze({
  id: 'hard-neuro-search-v2-32games-v1',
  name: 'Сложный бот-нейро',
  variant: 'long',
  mode: 'experimental-player-testing-frozen',
  releaseChannel: 'experimental-player-testing',
  modelFingerprint: 'sha256:6484d2e9e489c63c0844b98a4bbcf616a62e48ce0f162c546fd66eb951f09c5e',
  coreInferenceCodeFingerprint: 'sha256:a46b184302d4b9bb2f8477d6f454b0cd2ceff0f06ff933d4ea59f28ae8976e3e',
  searchPolicyCodeFingerprint: 'sha256:022664ae69e55f4b659b9755c63a0c82718db4972c53a52213ca75dfee361d81',
  rulesFingerprint: 'sha256:6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',
  policySchema: 'long-neural-search-v2',
  policyOptions: POLICY_OPTIONS,
  historicalWarmStartModelFingerprint: 'sha256:4254bfa9f4afccbeb73657f11e37ff39a7fcd9162e7887f1aae28eaa7fbe0155',
  historicalWarmStartGames: 448,
  historicalWarmStartUpdates: 35147,
  v2CompletedTrainingGames: 32,
  v2TrainingUpdates: 3893,
  modelTrainingSteps: 39040,
  inputSize: 127,
  hiddenSize: 32,
  trainingArtifactFingerprint: 'sha256:1885fced2b223f12eb22bfb1db6f4e7448175841031ed5f5b21a3a79216b7bc9',
  benchmarkProtocolFingerprint: DEVELOPMENT_EVALUATION.protocolFingerprint,
  developmentEvaluation: DEVELOPMENT_EVALUATION,
  strengthGatePassed: false,
  productionEligible: false,
  playerTestingEnabled: true,
  onlineLearning: false,
  noHumanOrProductionWinRateClaim: true,
});

function sourceHash(relative) {
  const bytes = fs.readFileSync(path.join(ROOT, relative));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}
function checkSources() {
  for (const [relative, expected] of [
    ['game.js', PIN.rulesFingerprint],
    ['lib/long-bot-neural.js', PIN.coreInferenceCodeFingerprint],
    ['lib/long-bot-neural-v2.js', PIN.searchPolicyCodeFingerprint],
  ]) {
    if (sourceHash(relative) !== expected) {
      throw new Error(`V2 public model source differs from trained candidate: ${relative}`);
    }
  }
}
function exactMetadata(metadata) {
  return metadata && canonical(metadata) === canonical(PIN);
}
function validatePublicModel(payload) {
  if (!payload || Object.keys(payload).sort().join(',') !== 'metadata,model,schema'
    || payload.schema !== 'nardu-public-long-neural-v2' || !exactMetadata(payload.metadata)) {
    throw new Error('Invalid or unpinned public V2 neural model metadata');
  }
  neural.validateModel(payload.model);
  if (fingerprint(payload.model) !== PIN.modelFingerprint
    || payload.model.trainingSteps !== PIN.modelTrainingSteps
    || payload.model.inputSize !== PIN.inputSize || payload.model.hiddenSize !== PIN.hiddenSize) {
    throw new Error('Public V2 neural weights differ from the frozen candidate');
  }
  return payload;
}
function validateReleaseInputs(artifact, report) {
  const training = trainer.validateArtifact(artifact);
  const development = evaluator.validateReport(report, artifact);
  if (artifact.artifactFingerprint !== PIN.trainingArtifactFingerprint
    || artifact.modelFingerprint !== PIN.modelFingerprint
    || artifact.policySchema !== PIN.policySchema
    || artifact.runtimeFingerprint !== PIN.rulesFingerprint
    || artifact.sourceFingerprints?.['lib/long-bot-neural.js'] !== PIN.coreInferenceCodeFingerprint
    || artifact.sourceFingerprints?.['lib/long-bot-neural-v2.js'] !== PIN.searchPolicyCodeFingerprint
    || canonical(artifact.benchmarkProtocol?.policyOptions) !== canonical(PIN.policyOptions)
    || artifact.benchmarkProtocolFingerprint !== PIN.benchmarkProtocolFingerprint
    || artifact.productionEligible !== false
    || artifact.trainingStatus?.noProductionOrHumanWinRateClaim !== true
    || training.games !== PIN.v2CompletedTrainingGames || training.samples !== PIN.v2TrainingUpdates
    || artifact.model.trainingSteps !== PIN.modelTrainingSteps) {
    throw new Error('V2 training provenance differs from the approved player-testing candidate');
  }
  if (report.reportFingerprint !== PIN.developmentEvaluation.reportFingerprint
    || report.trainingArtifactFingerprint !== PIN.trainingArtifactFingerprint
    || report.protocolFingerprint !== PIN.benchmarkProtocolFingerprint
    || report.purpose !== PIN.developmentEvaluation.purpose
    || development.requestedGames !== PIN.developmentEvaluation.requestedGames
    || development.completedGames !== PIN.developmentEvaluation.completedGames
    || development.wins !== PIN.developmentEvaluation.wins
    || development.censoredOrNotRunGames !== PIN.developmentEvaluation.censoredOrNotRunGames
    || development.complete !== false || development.strongPoolMilestonePassed !== false
    || development.scope !== PIN.developmentEvaluation.scope
    || development.productionEligible !== false || report.productionEligible !== false) {
    throw new Error('V2 development evidence differs from the approved incomplete report');
  }
  return { artifact, report };
}
function assetSource(payload) {
  return `/* Generated by scripts/build-long-neural-v2-public-model.js. Frozen inference for experimental player testing only. */\n`
    + `(function (root) { 'use strict';\nconst payload = ${JSON.stringify(payload)};\n`
    + `const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };\n`
    + `deepFreeze(payload);\n`
    + `Object.defineProperty(root, 'NarduLongNeuralV2Model', { value: payload, writable: false, configurable: false, enumerable: true });\n`
    + `})(window);\n`;
}
function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.next-${process.pid}`;
  fs.writeFileSync(temporary, contents, { flag: 'wx' });
  fs.renameSync(temporary, file);
}
function buildLongNeuralV2PublicModel(options = {}) {
  checkSources();
  const publicPath = options.publicPath || PUBLIC_PATH;
  const assetPath = options.assetPath || ASSET_PATH;
  const hasSource = Boolean(options.sourcePath), hasReport = Boolean(options.developmentReportPath);
  if (hasSource !== hasReport) throw new Error('V2 source and development report must be supplied together');
  let payload;
  if (hasSource) {
    const artifact = JSON.parse(fs.readFileSync(options.sourcePath, 'utf8'));
    const report = JSON.parse(fs.readFileSync(options.developmentReportPath, 'utf8'));
    validateReleaseInputs(artifact, report);
    payload = validatePublicModel({ schema: 'nardu-public-long-neural-v2', metadata: PIN, model: artifact.model });
    writeAtomic(publicPath, `${JSON.stringify(payload, null, 2)}\n`);
  } else {
    payload = validatePublicModel(JSON.parse(fs.readFileSync(publicPath, 'utf8')));
  }
  const source = assetSource(payload);
  if (!fs.existsSync(assetPath) || fs.readFileSync(assetPath, 'utf8') !== source) writeAtomic(assetPath, source);
  return { publicPath, assetPath, metadata: JSON.parse(JSON.stringify(payload.metadata)) };
}

if (require.main === module) {
  const options = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const names = { '--source': 'sourcePath', '--development-report': 'developmentReportPath' };
    if (!names[args[index]] || !args[index + 1]) {
      throw new Error('Usage: build-long-neural-v2-public-model.js [--source candidate.json --development-report report.json]');
    }
    options[names[args[index]]] = path.resolve(args[index + 1]);
  }
  const result = buildLongNeuralV2PublicModel(options);
  console.log(`Frozen V2 neural player-testing model ready: ${result.metadata.id}`);
}

module.exports = buildLongNeuralV2PublicModel;
module.exports.PIN = PIN;
module.exports.validatePublicModel = validatePublicModel;
module.exports.validateReleaseInputs = validateReleaseInputs;
module.exports.assetSource = assetSource;
