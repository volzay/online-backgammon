(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NarduUltrabotInference = api;
})(typeof self === 'object' ? self : globalThis, function () {
  'use strict';

  function isImmutableModel(model) {
    if (!model || typeof model !== 'object' || !Object.isFrozen(model)) return false;
    if (!Object.values(Object.getOwnPropertyDescriptors(model))
      .every(descriptor => Object.hasOwn(descriptor, 'value'))) return false;
    for (const name of ['inputWeights', 'hiddenBias', 'outputWeights']) {
      const weights = model[name];
      if (!Object.hasOwn(model, name) || !Array.isArray(weights) || !Object.isFrozen(weights)) return false;
      for (let index = 0; index < weights.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(weights, index);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
      }
    }
    return true;
  }

  function copyWeights(weights) {
    const copy = new Float64Array(weights.length);
    for (let index = 0; index < weights.length; index++) copy[index] = weights[index];
    return copy;
  }

  function createCore(neural, checkBudget) {
    const preparedModels = new WeakMap();

    function predict(model, state, color) {
      checkBudget();
      let prepared = preparedModels.get(model);
      if (!prepared) {
        if (!isImmutableModel(model)) return neural.predict(model, state, color);
        neural.validateModel(model);
        prepared = {
          inputSize: model.inputSize,
          hiddenSize: model.hiddenSize,
          inputWeights: copyWeights(model.inputWeights),
          hiddenBias: copyWeights(model.hiddenBias),
          outputWeights: copyWeights(model.outputWeights),
          outputBias: model.outputBias,
        };
        preparedModels.set(model, prepared);
      }
      const input = neural.encodeState(state, color);
      if (state.winner) return Number(state.winner === color);
      const { inputSize, hiddenSize, inputWeights, hiddenBias, outputWeights } = prepared;
      let output = prepared.outputBias;
      for (let neuron = 0; neuron < hiddenSize; neuron++) {
        let sum = hiddenBias[neuron];
        const offset = neuron * inputSize;
        for (let feature = 0; feature < inputSize; feature++) {
          sum += inputWeights[offset + feature] * input[feature];
        }
        output += outputWeights[neuron] * Math.tanh(sum);
      }
      return output >= 0 ? 1 / (1 + Math.exp(-output)) : Math.exp(output) / (1 + Math.exp(output));
    }

    return Object.freeze({ ...neural, predict });
  }

  return Object.freeze({ createCore });
});
