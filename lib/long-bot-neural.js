/* Experimental long-narde value network. No network access or dice generation. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NarduLongNeural = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const MODEL_SCHEMA = 'nardu-long-neural-value-v1';
  const ENCODING_VERSION = 'long-relative-127-v1';
  const INPUT_SIZE = 127;
  const MAX_HIDDEN_SIZE = 128;
  const MAX_WEIGHT = 100;
  const COLORS = ['white', 'dark'];
  const PHASES = ['opening', 'opening-result', 'roll', 'move', 'over'];
  const MODEL_KEYS = ['schema', 'encodingVersion', 'inputSize', 'hiddenSize', 'seed',
    'trainingSteps', 'inputWeights', 'hiddenBias', 'outputWeights', 'outputBias'];

  function check(condition, message) {
    if (!condition) throw new Error(`Long neural: ${message}`);
  }
  function integer(value, minimum, maximum, label) {
    check(Number.isSafeInteger(value) && value >= minimum && value <= maximum, label);
  }
  function other(color) { return color === 'white' ? 'dark' : 'white'; }
  function colorCheck(color) { check(COLORS.includes(color), 'invalid color'); }
  function weight(value) {
    check(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_WEIGHT,
      'weights must be finite and bounded');
  }
  function validateModel(model) {
    check(model && typeof model === 'object' && !Array.isArray(model), 'model must be an object');
    check(Object.keys(model).length === MODEL_KEYS.length
      && MODEL_KEYS.every(key => Object.hasOwn(model, key)), 'unexpected model fields');
    check(model.schema === MODEL_SCHEMA && model.encodingVersion === ENCODING_VERSION
      && model.inputSize === INPUT_SIZE, 'incompatible model schema or encoding');
    integer(model.hiddenSize, 1, MAX_HIDDEN_SIZE, 'invalid hidden size');
    integer(model.seed, 0, 0xffffffff, 'invalid initialization seed');
    integer(model.trainingSteps, 0, Number.MAX_SAFE_INTEGER - 1, 'invalid training step count');
    for (const [name, size] of [['inputWeights', INPUT_SIZE * model.hiddenSize],
      ['hiddenBias', model.hiddenSize], ['outputWeights', model.hiddenSize]]) {
      check(Array.isArray(model[name]) && model[name].length === size, `invalid ${name} dimensions`);
      // Explicit indexed iteration also rejects sparse arrays.
      for (let index = 0; index < size; index += 1) weight(model[name][index]);
    }
    weight(model.outputBias);
    return model;
  }
  function seededRandom(seed) {
    integer(seed, 0, 0xffffffff, 'seed must be uint32');
    let value = seed;
    return function () {
      value = (value + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }
  function createModel({ seed = 1, hiddenSize = 32 } = {}) {
    integer(hiddenSize, 1, MAX_HIDDEN_SIZE, 'invalid hidden size');
    const rng = seededRandom(seed);
    const inputScale = Math.sqrt(6 / (INPUT_SIZE + hiddenSize));
    const outputScale = Math.sqrt(6 / (hiddenSize + 1));
    return {
      schema: MODEL_SCHEMA, encodingVersion: ENCODING_VERSION, inputSize: INPUT_SIZE,
      hiddenSize, seed, trainingSteps: 0,
      inputWeights: Array.from({ length: INPUT_SIZE * hiddenSize }, () => (rng() * 2 - 1) * inputScale),
      hiddenBias: Array(hiddenSize).fill(0),
      outputWeights: Array.from({ length: hiddenSize }, () => (rng() * 2 - 1) * outputScale),
      outputBias: 0,
    };
  }
  function validateState(state) {
    check(state && typeof state === 'object' && state.variant === 'long', 'only long narde supported');
    check(state.points && typeof state.points === 'object' && !Array.isArray(state.points), 'invalid points');
    check(PHASES.includes(state.phase), 'invalid phase');
    check(state.turn === null && state.phase === 'opening' || COLORS.includes(state.turn), 'invalid turn');
    check(state.winner == null || COLORS.includes(state.winner), 'invalid winner');
    check(state.off && state.bar && state.firstMoveDone, 'missing rule context');
    const totals = { white: 0, dark: 0 };
    for (const [point, stack] of Object.entries(state.points)) {
      integer(Number(point), 1, 24, 'invalid board point');
      check(String(Number(point)) === point && stack && COLORS.includes(stack.color), 'invalid point stack');
      integer(stack.count, 1, 15, 'invalid checker count');
      totals[stack.color] += stack.count;
    }
    for (const color of COLORS) {
      integer(state.off[color], 0, 15, 'invalid borne-off count');
      check(state.bar[color] === 0, 'long narde cannot have checkers on the bar');
      check(typeof state.firstMoveDone[color] === 'boolean', 'invalid first-turn context');
      check(totals[color] + state.off[color] === 15, 'each color must have exactly 15 checkers');
      check(state.off[color] !== 15 || state.winner === color, 'missing terminal winner');
    }
    check((state.phase === 'over') === Boolean(state.winner), 'inconsistent terminal state');
    if (state.winner) check(state.off[state.winner] === 15, 'terminal winner has not borne off all checkers');
    for (const name of ['dice', 'rolled']) {
      check(Array.isArray(state[name]) && state[name].length <= 4, `invalid ${name}`);
      for (const die of state[name]) integer(die, 1, 6, 'invalid die');
    }
    check(Array.isArray(state.turnMoves) && state.turnMoves.length <= 4, 'invalid turn moves');
    for (const move of state.turnMoves) {
      check(move && move.color === state.turn, 'invalid current-turn move color');
      integer(move.from, 1, 24, 'invalid current-turn source');
      integer(move.die, 1, 6, 'invalid current-turn die');
    }
    return state;
  }
  function ownPath(color) {
    return Array.from({ length: 24 }, (_, index) => color === 'white'
      ? 24 - index : ((35 - index) % 24) + 1);
  }
  function encodeState(state, color) {
    colorCheck(color);
    validateState(state);
    const opponent = other(color);
    const path = ownPath(color);
    const input = new Float64Array(INPUT_SIZE);
    let index = 0;
    for (const point of path) {
      const stack = state.points[point];
      const own = stack?.color === color ? stack.count : 0;
      const enemy = stack?.color === opponent ? stack.count : 0;
      input[index++] = own / 15;
      input[index++] = enemy / 15;
      input[index++] = own > 0 ? 1 : 0;
      input[index++] = enemy > 0 ? 1 : 0;
    }
    input[index++] = state.off[color] / 15;
    input[index++] = state.off[opponent] / 15;
    input[index++] = Number(state.firstMoveDone[color]);
    input[index++] = Number(state.firstMoveDone[opponent]);
    input[index++] = Number(state.turn === color);
    input[index++] = Number(state.turn === opponent);
    for (const name of ['dice', 'rolled']) {
      for (let die = 1; die <= 6; die += 1) {
        input[index++] = state[name].filter(value => value === die).length / 4;
      }
    }
    input[index++] = state.turnMoves.filter(move => move.color === color && move.from === ownPath(color)[0]).length / 2;
    input[index++] = state.turnMoves.filter(move => move.color === opponent && move.from === ownPath(opponent)[0]).length / 2;
    for (const phase of PHASES) input[index++] = Number(state.phase === phase);
    input[index++] = Number(state.winner === color);
    input[index++] = Number(state.winner === opponent);
    for (const side of [color, opponent]) {
      const sidePath = ownPath(side);
      let pips = 0;
      let outside = 0;
      sidePath.forEach((point, position) => {
        const count = state.points[point]?.color === side ? state.points[point].count : 0;
        pips += count * (24 - position);
        if (position < 18) outside += count;
      });
      input[index++] = Number(outside === 0);
      input[index++] = pips / 360;
    }
    check(index === INPUT_SIZE, 'encoding dimension mismatch');
    return input;
  }
  function sigmoid(value) {
    return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
  }
  function forward(model, input) {
    const hidden = new Float64Array(model.hiddenSize);
    let output = model.outputBias;
    for (let neuron = 0; neuron < model.hiddenSize; neuron += 1) {
      let sum = model.hiddenBias[neuron];
      const offset = neuron * INPUT_SIZE;
      for (let feature = 0; feature < INPUT_SIZE; feature += 1) {
        sum += model.inputWeights[offset + feature] * input[feature];
      }
      hidden[neuron] = Math.tanh(sum);
      output += model.outputWeights[neuron] * hidden[neuron];
    }
    return { value: sigmoid(output), hidden };
  }
  function predict(model, state, color) {
    validateModel(model);
    const input = encodeState(state, color);
    return state.winner ? Number(state.winner === color) : forward(model, input).value;
  }
  function trainSample(model, state, color, target, { learningRate = 0.01 } = {}) {
    validateModel(model);
    const input = encodeState(state, color);
    check(!state.winner, 'train on preceding afterstates, not hard-coded terminal predictions');
    check(typeof target === 'number' && Number.isFinite(target) && target >= 0 && target <= 1,
      'target must be a probability');
    check(typeof learningRate === 'number' && Number.isFinite(learningRate)
      && learningRate > 0 && learningRate <= 1, 'invalid learning rate');
    check(!Object.isFrozen(model) && ['inputWeights', 'hiddenBias', 'outputWeights']
      .every(name => !Object.isFrozen(model[name])), 'cannot train a frozen inference model');
    const { value, hidden } = forward(model, input);
    // Gradient of half squared error, using the pre-update output weights.
    const delta = (value - target) * value * (1 - value);
    const inputWeights = model.inputWeights.slice();
    const hiddenBias = model.hiddenBias.slice();
    const outputWeights = model.outputWeights.slice();
    const bounded = value => {
      check(Number.isFinite(value), 'non-finite gradient update');
      return Math.max(-MAX_WEIGHT, Math.min(MAX_WEIGHT, value));
    };
    for (let neuron = 0; neuron < model.hiddenSize; neuron += 1) {
      const hiddenDelta = delta * model.outputWeights[neuron] * (1 - hidden[neuron] ** 2);
      hiddenBias[neuron] = bounded(hiddenBias[neuron] - learningRate * hiddenDelta);
      outputWeights[neuron] = bounded(outputWeights[neuron] - learningRate * delta * hidden[neuron]);
      const offset = neuron * INPUT_SIZE;
      for (let feature = 0; feature < INPUT_SIZE; feature += 1) {
        inputWeights[offset + feature] = bounded(inputWeights[offset + feature] - learningRate * hiddenDelta * input[feature]);
      }
    }
    const outputBias = bounded(model.outputBias - learningRate * delta);
    Object.assign(model, { inputWeights, hiddenBias, outputWeights, outputBias,
      trainingSteps: model.trainingSteps + 1 });
    return { value, target, loss: (value - target) ** 2 / 2 };
  }
  function frozenModel(model) {
    validateModel(model);
    const copy = { ...model };
    for (const name of ['inputWeights', 'hiddenBias', 'outputWeights']) {
      copy[name] = Object.freeze(model[name].slice());
    }
    return Object.freeze(copy);
  }
  function ruleState(state) {
    // An explicit whitelist prevents history/analysis/auth fields entering the network or search.
    return {
      variant: state.variant, points: Object.fromEntries(Object.entries(state.points)
        .map(([point, stack]) => [point, { color: stack.color, count: stack.count }])),
      bar: { ...state.bar }, off: { ...state.off }, score: { white: 0, dark: 0 },
      turn: state.turn, phase: state.phase, winner: state.winner || null, resultType: state.resultType || null,
      dice: state.dice.slice(), rolled: state.rolled.slice(),
      firstMoveDone: { ...state.firstMoveDone }, headPlayedThisTurn: { white: false, dark: false },
      turnMoves: state.turnMoves.map(move => ({ ...move })), history: [],
    };
  }
  function sequenceKey(sequence, color) {
    return sequence.map(move => {
      const relativePoint = color === 'white' ? 24 - move.from : (36 - move.from) % 24;
      return `${String(relativePoint).padStart(2, '0')}:${move.die}`;
    }).join('|');
  }
  function createNeuralBot(game, model, { epsilon = 0, rng, maxCandidates = 64 } = {}) {
    check(game && ['bestMoveSequences', 'applyMove', 'endTurn', 'hasAnyMoves']
      .every(name => typeof game[name] === 'function'), 'missing rules engine');
    check(typeof epsilon === 'number' && Number.isFinite(epsilon) && epsilon >= 0 && epsilon <= 1,
      'invalid exploration probability');
    check(epsilon === 0 || typeof rng === 'function', 'exploration requires an explicit offline RNG');
    integer(maxCandidates, 1, 4096, 'invalid candidate limit');
    const inferenceModel = frozenModel(model);
    let lastDecision = null;
    function rank(state) {
      validateState(state);
      check(state.phase === 'move' && !state.winner, 'planning requires an already rolled move phase');
      const color = state.turn;
      const legal = game.bestMoveSequences(ruleState(state), color)
        .filter(sequence => sequence.length).sort((left, right) => sequenceKey(left, color).localeCompare(sequenceKey(right, color)));
      const selected = legal.length <= maxCandidates ? legal : Array.from({ length: maxCandidates }, (_, index) =>
        legal[Math.floor(index * legal.length / maxCandidates)]);
      // A search budget must never hide a rules-certified immediate victory.
      const winning = legal.find(sequence => state.off[color]
        + sequence.filter(move => move.bearOff).length >= 15);
      if (winning && !selected.includes(winning)) selected[selected.length - 1] = winning;
      const rows = [];
      const seen = new Set();
      for (const sequence of selected) {
        const afterState = ruleState(state);
        for (const move of sequence) {
          check(game.applyMove(afterState, move.from, move.die, { autoEnd: false }), 'rules rejected generated sequence');
          if (afterState.winner) break;
        }
        if (!afterState.winner) {
          check(!game.hasAnyMoves(afterState), 'incomplete legal sequence');
          game.endTurn(afterState);
        }
        const encoded = encodeState(afterState, color);
        const key = Array.from(encoded).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const value = afterState.winner ? Number(afterState.winner === color)
          : forward(inferenceModel, encoded).value;
        rows.push({ moves: sequence.map(({ from, die }) => ({ from, die })), afterState, value });
      }
      rows.sort((left, right) => Number(right.afterState.winner === color) - Number(left.afterState.winner === color)
        || right.value - left.value
        || sequenceKey(left.moves, color).localeCompare(sequenceKey(right.moves, color)));
      lastDecision = Object.freeze({ legalSequences: legal.length, sampledSequences: selected.length,
        evaluatedPositions: rows.length, truncated: legal.length > selected.length });
      return rows;
    }
    function random() {
      const value = rng();
      check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1,
        'offline exploration RNG returned an invalid value');
      return value;
    }
    function plan(state) {
      const rows = rank(state);
      if (!rows.length) return [];
      const selected = !rows[0].afterState.winner && epsilon > 0 && random() < epsilon
        ? rows[Math.floor(random() * rows.length)] : rows[0];
      return selected.moves.map(move => ({ ...move }));
    }
    return Object.freeze({ plan, rank, model: inferenceModel, getLastDecision: () => lastDecision });
  }
  return Object.freeze({ MODEL_SCHEMA, ENCODING_VERSION, INPUT_SIZE, MAX_HIDDEN_SIZE,
    createModel, validateModel, validateState, encodeState, predict, trainSample,
    createNeuralBot, seededRandom });
});
