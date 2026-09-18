/* Frozen long-narde value-network adapter. No dice generation or online learning. */
window.NarduNeuralBot = (function () {
  'use strict';
  const MODEL_ID = 'hard-neuro-448-v1';
  const MODEL_FINGERPRINT = 'sha256:4254bfa9f4afccbeb73657f11e37ff39a7fcd9162e7887f1aae28eaa7fbe0155';
  const MAX_CANDIDATES = 16;
  let planner = null;
  let loadedPayload = null;
  let loadedGame = null;
  let lastDecision = null;
  function fail(message) { throw new Error(`Neural bot unavailable: ${message}`); }
  function initialize() {
    const payload = window.NarduLongNeuralModel;
    const api = window.NarduLongNeural;
    const game = window.NarduGame;
    if (!payload || !api?.createNeuralBot || !api?.validateModel || !game) fail('trained assets have not loaded');
    const metadata = payload.metadata;
    if (payload.schema !== 'nardu-public-long-neural-v1'
      || metadata?.id !== MODEL_ID || metadata.modelFingerprint !== MODEL_FINGERPRINT
      || metadata.inferenceCodeFingerprint !== 'sha256:a46b184302d4b9bb2f8477d6f454b0cd2ceff0f06ff933d4ea59f28ae8976e3e'
      || metadata.rulesFingerprint !== 'sha256:769c571ad10cefa75a8c128aba5123df47684780fad1136a0ae98f3342f33e4b'
      || metadata.variant !== 'long' || metadata.trainingGames !== 448 || metadata.trainingSteps !== 35147
      || metadata.inputSize !== 127 || metadata.hiddenSize !== 32
      || metadata.maxCandidates !== MAX_CANDIDATES || metadata.epsilon !== 0
      || !Object.isFrozen(payload) || !Object.isFrozen(metadata) || !Object.isFrozen(payload.model)
      || !['inputWeights', 'hiddenBias', 'outputWeights'].every(key => Object.isFrozen(payload.model[key]))) {
      fail('frozen trained model metadata is invalid');
    }
    api.validateModel(payload.model);
    if (payload.model.trainingSteps !== metadata.trainingSteps || payload.model.hiddenSize !== metadata.hiddenSize
      || payload.model.inputSize !== metadata.inputSize) fail('trained model dimensions or counters differ');
    if (!planner || loadedPayload !== payload || loadedGame !== game) {
      planner = api.createNeuralBot(game, payload.model, { epsilon: 0, maxCandidates: MAX_CANDIDATES });
      loadedPayload = payload; loadedGame = game;
    }
    return planner;
  }
  function plan(state) {
    lastDecision = null;
    if (state?.variant !== 'long') fail('only long narde is supported');
    const bot = initialize();
    const rows = bot.rank(state);
    const selected = rows[0];
    lastDecision = Object.freeze({ ...bot.getLastDecision(),
      policy: 'hard-neuro', difficulty: 'hard-neuro', modelId: MODEL_ID, modelVersion: MODEL_ID,
      modelFingerprint: MODEL_FINGERPRINT, trainingGames: 448, trainingSteps: 35147,
      maxCandidates: MAX_CANDIDATES, exploration: 0, onlineLearning: false,
      value: selected ? selected.value : null, selectedValue: selected ? selected.value : null,
      plannedMoves: selected ? selected.moves.length : 0,
    });
    return selected ? selected.moves.map(({ from, die }) => ({ from, die })) : [];
  }
  function consumeLastDecision() { const decision = lastDecision; lastDecision = null; return decision; }
  return Object.freeze({ plan, getLastDecision: () => lastDecision, consumeLastDecision,
    clearLastDecision: () => { lastDecision = null; },
    getModelMetadata: () => initialize() && Object.freeze({ ...loadedPayload.metadata }) });
})();
