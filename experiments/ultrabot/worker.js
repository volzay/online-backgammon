'use strict';

const id = 'ultrabot-player-test-v1';
const searchOptions = Object.freeze({
  maxCandidates: 32,
  replyTopCandidates: 4,
  replyCandidates: 4,
  replyWeight: 0.35,
});
const searchBudgetMs = 9000;
const staticBudgetMs = 2500;
const budgetExpired = new Error('Ultrabot forecast budget exhausted');
let deadline = Infinity;

function checkBudget() {
  if (performance.now() >= deadline) throw budgetExpired;
}

self.window = self;
const version = new URL(self.location.href).search;
const load = (...assets) => importScripts(...assets.map(asset => asset + version));
load('../../game.js', '../../fair-dice-crypto.js', '../../lib/long-bot-neural.js',
  'fast-inference.js', 'fast-rules.js');
const originalCore = self.NarduLongNeural;
self.NarduLongNeural = self.NarduUltrabotInference.createCore(originalCore, checkBudget);
load('../../lib/long-bot-neural-v2.js');
self.NarduLongNeural = originalCore;
load('../../vendor/long-neural/model-v2.js', '../../long-neural-bot.js');

const rules = self.NarduUltrabotRules.createAdapter(self.NarduGame, checkBudget);
const movesOnly = sequence => sequence.map(({ from, die }) => ({ from, die }));
const sameMoves = (sequence, moves) => sequence.length === moves.length
  && sequence.every(({ from, die }, index) => from === moves[index].from && die === moves[index].die);

self.onmessage = ({ data }) => {
  const start = performance.now();
  deadline = start + searchBudgetMs;
  try {
    const state = data?.state;
    if (data?.id !== id || state?.variant !== 'long' || state.phase !== 'move' || state.winner) {
      throw new Error('Invalid Ultrabot preview turn');
    }
    // This checks the bundled weights, without choosing a move with the teacher.
    self.NarduNeuralBot.getModelMetadata();
    const model = self.NarduLongNeuralV2Model.model;
    const first = rules.firstBestMoveSequence(state);
    let incumbent = { moves: movesOnly(first), search: 'legal' };
    const post = stage => self.postMessage({ id, ok: true, stage, ...incumbent });
    post('provisional');
    if (!first.length) {
      post('complete');
      return;
    }
    let rootSequences;
    // Forecasts only ask for the root turn or the opposite color's replies.
    // Share the exact root enumeration between the static and full searches.
    const searchRules = {
      ...rules,
      bestMoveSequences(position, color = position.turn) {
        checkBudget();
        if (color === state.turn) {
          rootSequences ||= rules.bestMoveSequences(position, color);
          return rootSequences;
        }
        return rules.bestMoveSequences(position, color);
      },
    };
    function search(options, name) {
      const bot = self.NarduLongNeuralV2.createNeuralBot(searchRules, model, options);
      const moves = bot.plan(state);
      if (!rootSequences.some(sequence => sameMoves(sequence, moves))) {
        throw new Error('Ultrabot preview turn rejected by the rules');
      }
      incumbent = { moves, search: name };
    }

    deadline = start + staticBudgetMs;
    try {
      search({ ...searchOptions, replyWeight: 0 }, 'static');
      post('provisional');
    } catch (error) {
      if (error !== budgetExpired) throw error;
    }
    deadline = start + searchBudgetMs;
    try {
      search(searchOptions, 'full');
    } catch (error) {
      if (error !== budgetExpired) throw error;
    }
    post('complete');
  } catch {
    self.postMessage({ id, ok: false });
  } finally {
    deadline = Infinity;
  }
};
