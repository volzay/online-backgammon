'use strict';

const id = 'ultrabot-player-test-v1';
const searchOptions = Object.freeze({
  maxCandidates: 32,
  replyTopCandidates: 6,
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

function reviewCloseMoves(state, rows, certifiedSequence) {
  const [neuralChoice, ...alternatives] = rows;
  if (!alternatives.length || neuralChoice.afterState.winner || neuralChoice.forcedNextTurnLoss) {
    return neuralChoice.moves;
  }

  checkBudget();
  try {
    if (!self.NarduLongBotEngine) load('../../long-bot-engine.js');
  } catch {
    return neuralChoice.moves;
  }
  const engine = self.NarduLongBotEngine;
  if (typeof engine?.reviewSequenceStatic !== 'function') return neuralChoice.moves;

  // The analytic evaluator prices fences, escape routes and home entry.
  // Its raw units are unrelated to the neural utility, so bound its influence.
  const maxBonus = 0.04;
  const review = row => {
    checkBudget();
    const sequence = certifiedSequence(row.moves);
    try {
      const result = engine.reviewSequenceStatic(state, sequence);
      if (result?.scoreSemantics === 'long-static-evaluator-v1'
        && result.scoreIncludesTacticalSearch === false && result.scoreIncludesExperience === false) {
        return result.score;
      }
    } catch {
      // The completed neural plan remains playable if the adviser fails.
    }
    return null;
  };
  const baseline = review(neuralChoice);
  if (!Number.isFinite(baseline)) return neuralChoice.moves;
  let best = neuralChoice;
  let bestScore = best.score;
  for (const row of alternatives) {
    if (row.score + maxBonus <= bestScore || row.forcedNextTurnLoss
      || row.opponentImmediateWinProbability > neuralChoice.opponentImmediateWinProbability) continue;
    const score = review(row);
    if (!Number.isFinite(score)) return neuralChoice.moves;
    const combined = row.score + Math.min(maxBonus, (score - baseline) / 1e9);
    if (combined > bestScore) {
      best = row;
      bestScore = combined;
    }
  }
  checkBudget();
  return best.moves;
}

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
    function certifiedSequence(moves) {
      const sequence = rootSequences.find(candidate => sameMoves(candidate, moves));
      if (!sequence) throw new Error('Ultrabot preview turn rejected by the rules');
      return sequence;
    }

    function search(options, name) {
      const bot = self.NarduLongNeuralV2.createNeuralBot(searchRules, model, options);
      const rows = bot.rank(state);
      const moves = movesOnly(certifiedSequence(rows[0].moves));
      incumbent = { moves, search: name };
      return rows;
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
      const rows = search(searchOptions, 'full');
      post('provisional');
      const moves = reviewCloseMoves(state, rows, certifiedSequence);
      incumbent = { moves: movesOnly(certifiedSequence(moves)), search: 'full' };
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
