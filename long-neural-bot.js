/* Frozen long-narde V2 search adapter for explicitly authorized player testing. */
window.NarduNeuralBot = (function () {
  'use strict';
  const MODEL_ID = 'hard-neuro-search-v2-32games-v1';
  const MODEL_FINGERPRINT = 'sha256:6484d2e9e489c63c0844b98a4bbcf616a62e48ce0f162c546fd66eb951f09c5e';
  const CORE_FINGERPRINT = 'sha256:a46b184302d4b9bb2f8477d6f454b0cd2ceff0f06ff933d4ea59f28ae8976e3e';
  const POLICY_FINGERPRINT = 'sha256:022664ae69e55f4b659b9755c63a0c82718db4972c53a52213ca75dfee361d81';
  const RULES_FINGERPRINT = 'sha256:6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623';
  const POLICY_SCHEMA = 'long-neural-search-v2';
  const POLICY_OPTIONS = Object.freeze({ maxCandidates: 32, replyTopCandidates: 2,
    replyCandidates: 4, replyWeight: 0.35 });
  const DEVELOPMENT_EVALUATION = Object.freeze({
    reportFingerprint: 'sha256:4323d15452f7541de410ff828af46c50b0d2e6cd1933fc0f87807d17f53ad98e',
    protocolFingerprint: 'sha256:4ecdda3b0bc8563bd4d6b5737f144633e495c07cf50ab99a554bc3e554139565',
    purpose: 'development-validation', requestedGames: 6, completedGames: 5, wins: 3,
    censoredOrNotRunGames: 1, complete: false, strongPoolMilestonePassed: false,
    scope: 'predeclared-offline-opponent-pool-not-human-or-production-win-rate',
  });
  const EXPECTED_METADATA = Object.freeze({
    id: MODEL_ID, name: 'Сложный бот-нейро', variant: 'long',
    mode: 'experimental-player-testing-frozen', releaseChannel: 'experimental-player-testing',
    modelFingerprint: MODEL_FINGERPRINT, coreInferenceCodeFingerprint: CORE_FINGERPRINT,
    searchPolicyCodeFingerprint: POLICY_FINGERPRINT, rulesFingerprint: RULES_FINGERPRINT,
    policySchema: POLICY_SCHEMA, policyOptions: POLICY_OPTIONS,
    historicalWarmStartModelFingerprint: 'sha256:4254bfa9f4afccbeb73657f11e37ff39a7fcd9162e7887f1aae28eaa7fbe0155',
    historicalWarmStartGames: 448, historicalWarmStartUpdates: 35147,
    v2CompletedTrainingGames: 32, v2TrainingUpdates: 3893, modelTrainingSteps: 39040,
    inputSize: 127, hiddenSize: 32,
    trainingArtifactFingerprint: 'sha256:1885fced2b223f12eb22bfb1db6f4e7448175841031ed5f5b21a3a79216b7bc9',
    benchmarkProtocolFingerprint: DEVELOPMENT_EVALUATION.protocolFingerprint,
    developmentEvaluation: DEVELOPMENT_EVALUATION,
    strengthGatePassed: false, productionEligible: false, playerTestingEnabled: true,
    onlineLearning: false, noHumanOrProductionWinRateClaim: true,
  });
  let planner = null;
  let loadedPayload = null;
  let loadedGame = null;
  let integrityCheckedPayload = null;
  let lastDecision = null;

  function fail(message) { throw new Error(`Neural bot unavailable: ${message}`); }
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function frozenPayload(payload) {
    return Object.isFrozen(payload) && Object.isFrozen(payload.metadata)
      && Object.isFrozen(payload.metadata.policyOptions)
      && Object.isFrozen(payload.metadata.developmentEvaluation)
      && Object.isFrozen(payload.model)
      && ['inputWeights', 'hiddenBias', 'outputWeights'].every(key => Object.isFrozen(payload.model[key]));
  }
  function initialize() {
    const payload = window.NarduLongNeuralV2Model;
    const core = window.NarduLongNeural;
    const api = window.NarduLongNeuralV2;
    const game = window.NarduGame;
    if (!payload || !core?.validateModel || !api?.createNeuralBot || !api?.options || !game) {
      fail('V2 trained assets have not loaded');
    }
    if (payload.schema !== 'nardu-public-long-neural-v2'
      || canonical(payload.metadata) !== canonical(EXPECTED_METADATA)
      || api.POLICY_SCHEMA !== POLICY_SCHEMA
      || canonical(api.options(POLICY_OPTIONS)) !== canonical(POLICY_OPTIONS)
      || !frozenPayload(payload)) fail('frozen V2 player-testing metadata is invalid');
    const hash = window.NarduFairDiceCrypto?.hash;
    if (typeof hash !== 'function') fail('SHA-256 model integrity verifier has not loaded');
    if (integrityCheckedPayload !== payload) {
      if (`sha256:${hash(canonical(payload.model))}` !== MODEL_FINGERPRINT) {
        fail('V2 model weights failed their SHA-256 commitment');
      }
      integrityCheckedPayload = payload;
    }
    core.validateModel(payload.model);
    if (payload.model.trainingSteps !== EXPECTED_METADATA.modelTrainingSteps
      || payload.model.inputSize !== EXPECTED_METADATA.inputSize
      || payload.model.hiddenSize !== EXPECTED_METADATA.hiddenSize) {
      fail('trained V2 model dimensions or counters differ');
    }
    if (!planner || loadedPayload !== payload || loadedGame !== game) {
      planner = api.createNeuralBot(game, payload.model, POLICY_OPTIONS);
      loadedPayload = payload;
      loadedGame = game;
    }
    return planner;
  }
  function plan(state) {
    lastDecision = null;
    if (state?.variant !== 'long') fail('only long narde is supported');
    const bot = initialize();
    const rows = bot.rank(state);
    const selected = rows[0];
    const diagnostics = bot.getLastDecision();
    if (!diagnostics || diagnostics.policySchema !== POLICY_SCHEMA
      || canonical(diagnostics.policyOptions) !== canonical(POLICY_OPTIONS)) {
      fail('V2 search diagnostics are missing or mismatched');
    }
    lastDecision = Object.freeze({ ...diagnostics,
      policy: 'hard-neuro', difficulty: 'hard-neuro', modelId: MODEL_ID, modelVersion: MODEL_ID,
      modelFingerprint: MODEL_FINGERPRINT, modelTrainingSteps: EXPECTED_METADATA.modelTrainingSteps,
      v2CompletedTrainingGames: EXPECTED_METADATA.v2CompletedTrainingGames,
      v2TrainingUpdates: EXPECTED_METADATA.v2TrainingUpdates,
      historicalWarmStartGames: EXPECTED_METADATA.historicalWarmStartGames,
      coreInferenceCodeFingerprint: CORE_FINGERPRINT,
      searchPolicyCodeFingerprint: POLICY_FINGERPRINT, rulesFingerprint: RULES_FINGERPRINT,
      trainingArtifactFingerprint: EXPECTED_METADATA.trainingArtifactFingerprint,
      benchmarkProtocolFingerprint: EXPECTED_METADATA.benchmarkProtocolFingerprint,
      strengthGatePassed: false, productionEligible: false, playerTestingEnabled: true,
      noHumanOrProductionWinRateClaim: true, exploration: 0, onlineLearning: false,
      value: selected ? selected.value : null, selectedValue: selected ? selected.value : null,
      score: selected ? selected.score : null, replyScore: selected ? selected.replyScore : null,
      plannedMoves: selected ? selected.moves.length : 0,
    });
    return selected ? selected.moves.map(({ from, die }) => ({ from, die })) : [];
  }
  function consumeLastDecision() { const decision = lastDecision; lastDecision = null; return decision; }
  return Object.freeze({ plan, getLastDecision: () => lastDecision, consumeLastDecision,
    clearLastDecision: () => { lastDecision = null; },
    getModelMetadata: () => initialize() && Object.freeze({ ...loadedPayload.metadata }) });
})();
