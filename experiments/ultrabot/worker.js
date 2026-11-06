'use strict';

const id = 'ultrabot-player-test-v1';
const searchOptions = Object.freeze({
  maxCandidates: 32,
  replyTopCandidates: 4,
  replyCandidates: 4,
  replyWeight: 0.35,
});

self.window = self;
const version = new URL(self.location.href).search;
importScripts(...[
  '../../game.js',
  '../../fair-dice-crypto.js',
  '../../lib/long-bot-neural.js',
  '../../lib/long-bot-neural-v2.js',
  '../../vendor/long-neural/model-v2.js',
  '../../long-neural-bot.js',
].map(asset => asset + version));

self.onmessage = ({ data }) => {
  try {
    const state = data?.state;
    if (data?.id !== id || state?.variant !== 'long' || state.phase !== 'move' || state.winner) {
      throw new Error('Invalid Ultrabot preview turn');
    }
    // Validate the bundled model through the existing adapter without using its teacher choice.
    self.NarduNeuralBot.getModelMetadata();
    const game = self.NarduGame;
    const bot = self.NarduLongNeuralV2.createNeuralBot(game, self.NarduLongNeuralV2Model.model, searchOptions);
    const moves = bot.plan(state).map(({ from, die }) => ({ from, die }));
    const legal = game.bestMoveSequences(state, state.turn);
    if (!legal.some(sequence => sequence.length === moves.length
      && sequence.every(({ from, die }, index) => from === moves[index].from && die === moves[index].die))) {
      throw new Error('Ultrabot preview turn rejected by the rules');
    }
    self.postMessage({ id, ok: true, moves });
  } catch {
    self.postMessage({ id, ok: false });
  }
};
