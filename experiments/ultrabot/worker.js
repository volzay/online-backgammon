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

// Estimate how many single dice a checker needs to enter home if the
// opponent's points stay put. Blocked faces wait, and routes can jump blocks.
function homeRouteCosts(state, color, opponent) {
  const path = rules.pathFor(color, state);
  const costs = new Map();
  const unreachable = 6 * path.length + 1;
  for (let index = path.length - 1; index >= 0; index--) {
    const point = path[index];
    if (state.points[point]?.color === opponent) continue;
    if (index >= 18) {
      costs.set(point, 0);
      continue;
    }
    let sum = 6;
    let exits = 0;
    for (const next of path.slice(index + 1, index + 7)) {
      const cost = costs.get(next);
      if (cost === undefined || cost === unreachable) continue;
      sum += cost;
      exits++;
    }
    costs.set(point, exits ? sum / exits : unreachable);
  }
  return costs;
}

function preferFirstBearOff(state, rows, moves, certifiedSequence) {
  const color = state.turn;
  const opponent = rules.opponentOf(color);
  if (state.off[color] > 0 || rows.length < 2
    || rules.pipsFor(state, color) - rules.pipsFor(state, opponent) < 36) return moves;
  const opponentHome = rules.pathFor(opponent, state).slice(18).reduce((total, point) => {
    const stack = state.points[point];
    return total + (stack?.color === opponent ? stack.count : 0);
  }, state.off[opponent]);
  if (opponentHome < 8) return moves;

  const choice = rows.find(row => row.moves === moves);
  if (choice.afterState.winner || choice.afterState.off[color] > 0) return moves;
  const costs = homeRouteCosts(state, color, opponent);
  const routeGain = row => certifiedSequence(row.moves).reduce((gain, move) =>
    gain + costs.get(move.from) - (move.bearOff ? 0 : costs.get(move.to)), 0);
  const longestRoute = row => Object.entries(row.afterState.points).reduce((longest, [point, stack]) =>
    stack.color === color ? Math.max(longest, costs.get(Number(point))) : longest, 0);
  const initialGain = routeGain(choice);
  const initialLongestRoute = longestRoute(choice);
  const initialResult = rules.resultTypeFor(choice.afterState, opponent);
  let best = choice;
  let bestScore = choice.score;
  for (const row of rows) {
    checkBudget();
    if (row === choice || row.opponentImmediateWinProbability > choice.opponentImmediateWinProbability) continue;
    if (row.afterState.off[color] > 0) {
      if (choice.opponentImmediateWinProbability > 0 || row.score + 0.04 > choice.score) return row.moves;
      continue;
    }
    if (choice.forcedNextTurnLoss || (initialResult === 'mars'
      && rules.resultTypeFor(row.afterState, opponent) === 'koks')) continue;
    const improvement = routeGain(row) - initialGain;
    if (improvement < 0.5 || longestRoute(row) >= initialLongestRoute) continue;
    // Preserve the forecast unless the open route makes up the utility gap.
    const score = row.score + Math.min(0.04, 0.018 * improvement);
    if (score > bestScore) {
      best = row;
      bestScore = score;
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
      if (moves !== rows[0].moves) {
        incumbent = { moves: movesOnly(certifiedSequence(moves)), search: 'full' };
        post('provisional');
      }
      const rescue = preferFirstBearOff(state, rows, moves, certifiedSequence);
      incumbent = { moves: movesOnly(certifiedSequence(rescue)), search: 'full' };
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
