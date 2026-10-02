/* Frozen long-narde V2 search adapter for explicitly authorized player testing. */
window.NarduNeuralBot = (function () {
  'use strict';
  const MODEL_ID = 'hard-neuro-search-v2-32games-v1';
  const MODEL_FINGERPRINT = 'sha256:6484d2e9e489c63c0844b98a4bbcf616a62e48ce0f162c546fd66eb951f09c5e';
  const CORE_FINGERPRINT = 'sha256:a46b184302d4b9bb2f8477d6f454b0cd2ceff0f06ff933d4ea59f28ae8976e3e';
  const POLICY_FINGERPRINT = 'sha256:022664ae69e55f4b659b9755c63a0c82718db4972c53a52213ca75dfee361d81';
  const RULES_FINGERPRINT = 'sha256:6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623';
  const POLICY_SCHEMA = 'long-neural-search-v2';
  const TEACHER_GUARD_SCHEMA = 'long-neural-hard-teacher-guard-v1';
  const TEACHER_ENGINE_VERSION = 'long-analytic-v35';
  const TEACHER_POLICY_IMPLEMENTATION_ID = '4aede916c0f3a219e84582d3a8277f50b1041d6b7ae541bff7b807c42c82f526';
  const TEACHER_RUNTIME_POLICY_IMPLEMENTATION_ID = '6109e41cae1c8711aed43c7e2f104d621beab314c0e6bcdf277901b2f0c4d690';
  const TEACHER_TACTICAL_POLICY_IMPLEMENTATION_ID = '6c8c2e58287d73f855e4bb5b34fcee4f1e4eec91bb4c2c927370f50ad781fe89';
  const TEACHER_PREVIOUS_JSYS_POLICY_IMPLEMENTATION_ID = '541f4c011df371fe8201de56edd189d49ab40c18bf216c2c4b3dc080cf0733aa';
  const TEACHER_COMPLETE_JSYS_POLICY_IMPLEMENTATION_ID = '904e7062dcb499ed120ab92d3818e1b77227d5df51c8dfdb55d05f238ba52d6a';
  const TEACHER_PREVIOUS_LIVE_POLICY_IMPLEMENTATION_ID = 'c64f47e25f0580f7a42f11c0adf01b42bf60739a4c925039ed33c4d7339049b9';
  const TEACHER_PREVIOUS_CAUSAL_POLICY_IMPLEMENTATION_ID = 'f86ffd7312a574935eaa4dc158aee777336762cd22e701143fa732d86f7a05f2';
  const TEACHER_CURRENT_POLICY_IMPLEMENTATION_ID = '5cc8ff5d3120c3afd257e7cd1a17827814ef3896b20c316f778a6863d12768a0';
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
  function teacherRuleState(source) {
    return JSON.parse(JSON.stringify({
      variant: source.variant,
      points: source.points,
      bar: source.bar,
      off: source.off,
      score: source.score,
      matchScore: source.matchScore,
      turn: source.turn,
      phase: source.phase,
      winner: source.winner,
      resultType: source.resultType,
      dice: source.dice,
      rolled: source.rolled,
      firstMoveDone: source.firstMoveDone,
      headPlayedThisTurn: source.headPlayedThisTurn,
      turnMoves: source.turnMoves,
      history: [],
    }));
  }
  function moveKey(moves) {
    return JSON.stringify((moves || []).map(move => ({
      from: Number(move.from),
      die: Number(move.die),
    })));
  }
  function teacherPlan(state) {
    const game = window.NarduGame;
    const engine = window.NarduLongBotEngine;
    const teacher = window.NarduStrongBot;
    const publicBot = window.NarduBot;
    if (!engine || engine.version !== TEACHER_ENGINE_VERSION
      || (engine.policyImplementationId !== TEACHER_POLICY_IMPLEMENTATION_ID
        && engine.policyImplementationId !== TEACHER_RUNTIME_POLICY_IMPLEMENTATION_ID
        && engine.policyImplementationId !== TEACHER_TACTICAL_POLICY_IMPLEMENTATION_ID
        && engine.policyImplementationId !== TEACHER_PREVIOUS_JSYS_POLICY_IMPLEMENTATION_ID
        && engine.policyImplementationId !== TEACHER_COMPLETE_JSYS_POLICY_IMPLEMENTATION_ID
        && engine.policyImplementationId !== TEACHER_PREVIOUS_LIVE_POLICY_IMPLEMENTATION_ID
        && engine.policyImplementationId !== TEACHER_PREVIOUS_CAUSAL_POLICY_IMPLEMENTATION_ID
        && engine.policyImplementationId !== TEACHER_CURRENT_POLICY_IMPLEMENTATION_ID)
      || typeof engine.consumeLastDecision !== 'function'
      || typeof teacher?.plan !== 'function'
      || typeof publicBot?.plan !== 'function') {
      fail(`verified ${TEACHER_ENGINE_VERSION} teacher is unavailable`);
    }

    // Do not let telemetry from an earlier hard-bot call masquerade as the
    // teacher decision for this position. The neural model still evaluates the
    // position independently; until it passes its strength gate, only the
    // production hard policy is allowed to choose the live move.
    engine.consumeLastDecision();
    teacher.consumeLastFallbackDecision?.();
    const detached = teacherRuleState(state);
    const planned = publicBot.plan(detached, { difficulty: 'hard' });
    if (!Array.isArray(planned)) fail('hard teacher returned an invalid plan');
    const moves = planned.map(move => ({ from: Number(move.from), die: Number(move.die) }));
    const legal = game.bestMoveSequences(teacherRuleState(state), state.turn);
    if (legal.length) {
      const expected = moveKey(moves);
      if (!legal.some(sequence => moveKey(sequence) === expected)) {
        fail('hard teacher returned an illegal or incomplete plan');
      }
    } else if (moves.length || game.hasAnyMoves(teacherRuleState(state))) {
      fail('hard teacher returned an invalid pass');
    }
    const engineDecision = engine.consumeLastDecision();
    const fallbackDecision = teacher.consumeLastFallbackDecision?.() || null;
    const experience = engine.experienceSnapshot?.() || {};
    if (experience.frozen !== true || !String(experience.fingerprint || '')) {
      fail('hard teacher experience is not frozen');
    }
    return {
      moves,
      source: engineDecision ? 'long-analytic-engine'
        : fallbackDecision ? 'long-hard-certified-fallback'
          : moves.length ? 'long-hard-game-fallback' : 'rules-certified-pass',
      decision: engineDecision || fallbackDecision || null,
      experience: {
        fingerprint: String(experience.fingerprint || ''),
        size: Math.max(0, Number(experience.size) || 0),
        frozen: experience.frozen === true,
      },
    };
  }
  function plan(state) {
    lastDecision = null;
    if (state?.variant !== 'long') fail('only long narde is supported');
    const bot = initialize();
    const rows = bot.rank(state);
    const neuralSelected = rows[0];
    const diagnostics = bot.getLastDecision();
    if (!diagnostics || diagnostics.policySchema !== POLICY_SCHEMA
      || canonical(diagnostics.policyOptions) !== canonical(POLICY_OPTIONS)) {
      fail('V2 search diagnostics are missing or mismatched');
    }
    const guarded = teacherPlan(state);
    const teacherSelected = guarded.decision?.selected || null;
    const neuralMoves = neuralSelected
      ? neuralSelected.moves.map(({ from, die }) => ({ from, die })) : [];
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
      value: neuralSelected ? neuralSelected.value : null,
      selectedValue: neuralSelected ? neuralSelected.value : null,
      score: neuralSelected ? neuralSelected.score : null,
      replyScore: neuralSelected ? neuralSelected.replyScore : null,
      neuralProposedMoves: neuralMoves,
      neuralTeacherAgreement: moveKey(neuralMoves) === moveKey(guarded.moves),
      executionPolicy: TEACHER_GUARD_SCHEMA,
      teacherGuardActive: true,
      teacherEngineVersion: TEACHER_ENGINE_VERSION,
      teacherPolicyImplementationId: TEACHER_POLICY_IMPLEMENTATION_ID,
      teacherChoiceSource: guarded.source,
      teacherExperienceFingerprint: guarded.experience.fingerprint,
      teacherExperienceSize: guarded.experience.size,
      teacherExperienceFrozen: guarded.experience.frozen,
      teacherPositionId: String(guarded.decision?.positionId || ''),
      teacherScore: Number.isFinite(Number(teacherSelected?.score))
        ? Number(teacherSelected.score) : null,
      plannedMoves: guarded.moves.length,
    });
    return guarded.moves;
  }
  function consumeLastDecision() { const decision = lastDecision; lastDecision = null; return decision; }
  return Object.freeze({ plan, getLastDecision: () => lastDecision, consumeLastDecision,
    clearLastDecision: () => { lastDecision = null; },
    getModelMetadata: () => initialize() && Object.freeze({ ...loadedPayload.metadata }) });
})();
