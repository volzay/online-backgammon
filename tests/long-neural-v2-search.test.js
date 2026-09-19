'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const neural = require('../lib/long-bot-neural');
const candidate = require('../lib/long-bot-neural-v2');
const plain = value => JSON.parse(JSON.stringify(value));
const root = path.join(__dirname, '..');
const model = JSON.parse(fs.readFileSync(path.join(root, 'vendor/long-neural/model.json'), 'utf8')).model;

function rules() {
  const math = Object.create(Math);
  math.random = () => { throw Error('Neural search must not generate actual or hypothetical dice'); };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [1])); }
    static now() { return 1; }
  }
  const context = vm.createContext({ window: {}, Math: math, Date: FixedDate });
  vm.runInContext(fs.readFileSync(path.join(root, 'game.js'), 'utf8'), context);
  return context.window.NarduGame;
}

function position(game, { white, dark, color = 'dark', dice, off = { white: 0, dark: 0 }, first = true }) {
  const state = game.initialState('long');
  state.points = {};
  for (const [side, stacks] of [['white', white], ['dark', dark]]) {
    for (const [point, count] of Object.entries(stacks)) state.points[point] = { color: side, count };
  }
  state.turn = color; state.phase = 'roll'; state.off = { ...off };
  state.firstMoveDone = { white: first, dark: first };
  state.score = { white: 117, dark: 219 };
  game.applyRoll(state, dice);
  state.history = [];
  return state;
}

// Only checker placement and current rule context are retained from the real
// reported decisions. No names, account identifiers, timestamps or proof data.
function reported(game, fixture) {
  if (fixture === 'EPHZ-14') return position(game, {
    white: { 5: 1, 6: 1, 7: 1, 9: 1, 11: 1, 14: 1, 15: 1, 19: 1, 20: 1, 21: 2, 22: 1, 24: 3 },
    dark: { 4: 3, 8: 1, 10: 2, 12: 5, 13: 1, 16: 1, 17: 1, 23: 1 }, dice: [5, 5, 5, 5],
  });
  if (fixture === 'EPHZ-44') return position(game, {
    white: { 1: 1 }, dark: { 4: 1, 5: 1, 8: 2, 13: 8, 14: 2, 23: 1 },
    off: { white: 14, dark: 0 }, dice: [4, 3],
  });
  if (fixture === 'ANN3-42') return position(game, {
    white: { 1: 2 }, dark: { 7: 4, 8: 2, 10: 1, 11: 1, 14: 5, 22: 1, 23: 1 },
    off: { white: 13, dark: 0 }, dice: [1, 1, 1, 1],
  });
  throw Error('Unknown sanitized regression fixture');
}

function ruleFields(state) {
  return plain(Object.fromEntries(['variant', 'points', 'bar', 'off', 'score', 'turn', 'phase',
    'winner', 'resultType', 'dice', 'rolled', 'firstMoveDone', 'headPlayedThisTurn', 'turnMoves']
    .map(key => [key, state[key]])));
}
function execute(game, state, moves) {
  const after = plain(state);
  for (const move of moves) assert.equal(game.applyMove(after, move.from, move.die, { autoEnd: false }), true);
  if (!after.winner) {
    assert.equal(game.hasAnyMoves(after), false, 'A generated turn must use the maximum legally usable dice');
    game.endTurn(after);
  }
  return after;
}
function boardKey(state) {
  return JSON.stringify({ points: Object.entries(state.points).sort((a, b) => Number(a[0]) - Number(b[0])), off: state.off });
}
function homeCount(game, state, color) {
  return game.pathFor(color, 'long').slice(18).reduce((count, point) =>
    count + (state.points[point]?.color === color ? state.points[point].count : 0), 0);
}
function rotate(state) {
  const other = color => color === 'white' ? 'dark' : 'white';
  const point = from => ((Number(from) + 11) % 24) + 1;
  return { ...plain(state),
    points: Object.fromEntries(Object.entries(state.points).map(([from, stack]) =>
      [point(from), { color: other(stack.color), count: stack.count }])),
    turn: other(state.turn), winner: state.winner && other(state.winner),
    bar: { white: state.bar.dark, dark: state.bar.white },
    off: { white: state.off.dark, dark: state.off.white },
    score: { white: state.score.dark, dark: state.score.white },
    firstMoveDone: { white: state.firstMoveDone.dark, dark: state.firstMoveDone.white },
    headPlayedThisTurn: { white: state.headPlayedThisTurn.dark, dark: state.headPlayedThisTurn.white },
    turnMoves: state.turnMoves.map(move => ({ ...move, color: other(move.color),
      from: point(move.from), to: move.to ? point(move.to) : 0 })),
  };
}

function constantNetwork(outputBias) {
  const network = neural.createModel({ seed: 1, hiddenSize: 1 });
  network.inputWeights.fill(0); network.hiddenBias.fill(0); network.outputWeights.fill(0);
  network.outputBias = outputBias;
  return network;
}
function sigmoid(value) { return 1 / (1 + Math.exp(-value)); }
function immediateOpponentWinProbability(game, afterState) {
  const enemy = afterState.turn;
  let probability = 0;
  for (const roll of candidate.ROLLS) {
    const reply = plain(afterState); game.applyRoll(reply, Array.from(roll.dice));
    const options = candidate.enumerateUniqueTurns(game, reply);
    if (options.rows.some(row => row.afterState.winner === enemy)) probability += roll.probability;
  }
  return probability;
}

test('bounded forecast utility never rewards a certain opponent win over surviving a forced pass, for either color', () => {
  const game = rules(), dark = position(game, { dark: { 12: 14, 5: 1 }, white: { 6: 1 },
    off: { white: 14, dark: 0 }, dice: [1, 2] });
  const network = constantNetwork(-20);
  const options = { maxCandidates: 32, replyTopCandidates: 32, replyCandidates: 64, replyWeight: 1 };
  const beforeNetwork = JSON.stringify(network);
  const decisions = [];
  for (const state of [dark, rotate(dark)]) {
    const before = JSON.stringify(state), color = state.turn;
    const oldBlockPoint = color === 'dark' ? 5 : 17;
    const betterBlockPoint = color === 'dark' ? 2 : 14;
    const bot = candidate.createNeuralBot(game, network, options), rows = bot.rank(state);
    assert.equal(rows.length, 4); assert.equal(bot.getLastDecision().evaluatedPositions, 4);
    const holding = rows.find(row => row.afterState.points[oldBlockPoint]?.color === color);
    const lowerImmediateLoss = rows.find(row => row.afterState.points[betterBlockPoint]?.color === color);
    assert(holding && lowerImmediateLoss);
    assert(Math.abs(immediateOpponentWinProbability(game, holding.afterState) - 27 / 36) < 1e-12);
    assert(Math.abs(immediateOpponentWinProbability(game, lowerImmediateLoss.afterState) - 25 / 36) < 1e-12);
    assert(lowerImmediateLoss.replyScore > holding.replyScore,
      'Adding proven opponent wins must not inflate forecast utility just because surviving raw evaluations are negative');
    assert(Math.abs(immediateOpponentWinProbability(game, rows[0].afterState) - 25 / 36) < 1e-12);
    const holdingReply = plain(holding.afterState), defendedReply = plain(lowerImmediateLoss.afterState);
    game.applyRoll(holdingReply, [2, 2, 2, 2]); game.applyRoll(defendedReply, [2, 2, 2, 2]);
    assert(candidate.enumerateUniqueTurns(game, holdingReply).rows.every(row => row.afterState.winner === game.opponentOf(color)));
    assert(candidate.enumerateUniqueTurns(game, defendedReply).rows.every(row => !row.afterState.winner));
    for (const row of rows) {
      assert(row.rawScore < 0);
      assert.equal(row.rawScore, row.value + row.tactics.adjustment);
      assert(row.replyScore > 0 && row.replyScore < 1);
      assert(row.score > 0 && row.score < 1);
      assert.deepEqual(ruleFields(row.afterState), ruleFields(execute(game, state, row.moves)));
    }
    decisions.push(rows.map(row => ({ score: row.score, replyScore: row.replyScore, rawScore: row.rawScore })));
    assert.equal(JSON.stringify(state), before);
    assert.match(bot.getLastDecision().scoreKind, /not-calibrated-probability/);
  }
  assert.deepEqual(decisions[0], decisions[1]);
  assert.equal(JSON.stringify(network), beforeNetwork);
});

test('direct utilities map raw heuristic scores into strict nonterminal bounds and give exact terminal wins one', () => {
  const game = rules();
  const fixtures = [
    position(game, { dark: { 12: 14, 5: 1 }, white: { 6: 1 },
      off: { white: 14, dark: 0 }, dice: [1, 2] }),
    position(game, { color: 'white', white: { 3: 1, 1: 1 }, dark: { 12: 15 },
      off: { white: 13, dark: 0 }, dice: [2, 4] }),
  ];
  let terminalRows = 0; let negativeRaw = 0; let largerThanOneRaw = 0;
  for (const fixture of fixtures) for (const state of [fixture, rotate(fixture)]) {
    for (const outputBias of [-20, 100]) {
      const network = constantNetwork(outputBias);
      const rows = candidate.createNeuralBot(game, network, { maxCandidates: 32, replyWeight: 0 }).rank(state);
      for (const row of rows) {
        assert.equal(row.rawScore, row.value + row.tactics.adjustment);
        assert.equal(row.value, neural.predict(network, row.afterState, state.turn));
        if (row.afterState.winner) {
          terminalRows++; assert.equal(row.afterState.winner, state.turn); assert.equal(row.score, 1);
          assert.equal(rows[0].score, 1);
        } else {
          if (row.rawScore < 0) negativeRaw++;
          if (row.rawScore > 1) largerThanOneRaw++;
          assert(row.score > 0 && row.score < 1);
          assert(Math.abs(row.score - sigmoid(row.rawScore)) < 1e-15);
        }
        assert.deepEqual(ruleFields(row.afterState), ruleFields(execute(game, state, row.moves)));
      }
    }
  }
  assert(terminalRows > 0 && negativeRaw > 0 && largerThanOneRaw > 0,
    'Both ends of the formerly incomparable terminal/nonterminal scale must be exercised');
});

test('certified next-turn losses rank below a surviving alternative even with an overconfident network and mixed utility', () => {
  const game = rules(), dark = position(game, { dark: { 12: 14, 2: 1 }, white: { 3: 1 },
    off: { white: 14, dark: 0 }, dice: [1, 2] });
  const network = constantNetwork(100);
  const options = { maxCandidates: 32, replyTopCandidates: 32, replyCandidates: 64, replyWeight: 0.35 };
  for (const state of [dark, rotate(dark)]) {
    const before = JSON.stringify(state), color = state.turn;
    const blocker = color === 'dark' ? 2 : 14;
    const openedPoint = color === 'dark' ? 24 : 12;
    const bot = candidate.createNeuralBot(game, network, options), rows = bot.rank(state);
    const holding = rows.find(row => row.afterState.points[blocker]?.color === color);
    const opening = rows.find(row => row.moves.some(move => move.from === blocker && move.die === 2)
      && row.afterState.points[openedPoint]?.color === color);
    assert(holding && opening);
    assert.equal(opening.forcedNextTurnLoss, true);
    assert(Math.abs(opening.opponentImmediateWinProbability - 1) < 1e-12);
    assert(Math.abs(immediateOpponentWinProbability(game, opening.afterState) - 1) < 1e-12);
    assert.equal(holding.forcedNextTurnLoss, false);
    assert(holding.opponentImmediateWinProbability < 1 - 1e-12);
    const reply = plain(holding.afterState); game.applyRoll(reply, [1, 1, 1, 1]);
    const pass = candidate.enumerateUniqueTurns(game, reply);
    assert.equal(pass.rows.length, 1); assert.deepEqual(plain(pass.rows[0].moves), []);
    assert.equal(pass.rows[0].afterState.winner, null);
    const firstCertifiedLoss = rows.findIndex(row => row.forcedNextTurnLoss);
    assert(firstCertifiedLoss > 0);
    assert(rows.slice(0, firstCertifiedLoss).every(row => !row.forcedNextTurnLoss));
    assert(rows.slice(firstCertifiedLoss).every(row => row.forcedNextTurnLoss));
    assert.equal(rows[0].forcedNextTurnLoss, false,
      'Static utility, confidence or mixture weight cannot overrule a certified immediate forced loss');
    for (const row of rows) assert.deepEqual(ruleFields(row.afterState), ruleFields(execute(game, state, row.moves)));
    assert.equal(JSON.stringify(state), before);
    assert.equal(bot.getLastDecision().replyRolls, 21);
  }
});

test('certified unavoidable normal losses use the actual null public result and rank ahead of Mars or Koks', () => {
  const game = rules(), white = position(game, { color: 'white',
    white: { 8: 1, 6: 1, 5: 1, 3: 5, 1: 7 }, dark: { 13: 1 },
    off: { white: 0, dark: 14 }, dice: [1, 2] });
  const network = constantNetwork(0);
  const options = { maxCandidates: 32, replyTopCandidates: 32, replyCandidates: 64, replyWeight: 0.35 };
  for (const state of [white, rotate(white)]) {
    const before = JSON.stringify(state), color = state.turn;
    const rows = candidate.createNeuralBot(game, network, options).rank(state);
    assert(rows.length > 1);
    assert(rows.every(row => row.forcedNextTurnLoss), 'Every compared candidate must have an actual all-21-roll winning reply');
    const normal = rows.filter(row => row.afterState.off[color] > 0);
    const severe = rows.filter(row => row.afterState.off[color] === 0);
    assert(normal.length > 0 && severe.length > 0, 'Fixture must offer both borne-off and zero-borne-off choices');
    assert.equal(rows[0].forcedLossResultType, 'normal');
    assert(rows[0].afterState.off[color] > 0);
    const firstSevere = rows.findIndex(row => row.afterState.off[color] === 0);
    assert(firstSevere > 0);
    assert(rows.slice(0, firstSevere).every(row => row.forcedLossResultType === 'normal'));
    assert(rows.slice(firstSevere).every(row => ['mars', 'koks'].includes(row.forcedLossResultType)));
    for (const row of rows) {
      assert(Math.abs(immediateOpponentWinProbability(game, row.afterState) - 1) < 1e-12,
        'The all-roll loss certificate must match independently enumerated legal winning replies');
      assert(Math.abs(row.opponentImmediateWinProbability - 1) < 1e-12);
      assert(row.opponentImmediateWinProbability >= 0 && row.opponentImmediateWinProbability <= 1,
        'Floating summation must never publish a probability outside [0,1]');
      assert(row.opponentForcedPassProbability >= 0 && row.opponentForcedPassProbability <= 1);
      assert.equal(row.forcedLossResultType, row.afterState.off[color] > 0 ? 'normal' : 'mars');
      assert.deepEqual(ruleFields(row.afterState), ruleFields(execute(game, state, row.moves)));
    }
    const reply = plain(rows[0].afterState); game.applyRoll(reply, [1, 2]);
    const winning = candidate.enumerateUniqueTurns(game, reply).rows;
    assert(winning.every(row => row.afterState.winner === game.opponentOf(color)));
    assert(winning.every(row => row.afterState.resultType === null),
      'Portal rules represent a normal long-narde win as null, not the string normal');
    assert.equal(JSON.stringify(state), before);
  }
});

test('v2 removes duplicate positions before its candidate cap: EPHZ decision 14 no longer hides the network-best turn', () => {
  const game = rules(), state = reported(game, 'EPHZ-14');
  const legacy = neural.createNeuralBot(game, model, { maxCandidates: 16 }).rank(state);
  const turns = candidate.enumerateUniqueTurns(game, state);
  assert.equal(turns.legalSequences, 56); assert.equal(turns.rows.length, 8);
  const best = [...turns.rows].sort((a, b) => neural.predict(model, b.afterState, 'dark')
    - neural.predict(model, a.afterState, 'dark'))[0];
  assert(Math.abs(neural.predict(model, best.afterState, 'dark') - 0.5625833641941563) < 1e-12);
  assert.equal(legacy.length, 7);
  assert(!legacy.some(row => boardKey(row.afterState) === boardKey(best.afterState)), 'Counterexample must detect the actual old omission');
  const bot = candidate.createNeuralBot(game, model, { maxCandidates: 16, replyWeight: 0 });
  const rows = bot.rank(state);
  assert.equal(rows.length, 8);
  assert(rows.some(row => boardKey(row.afterState) === boardKey(best.afterState)));
  assert.equal(bot.getLastDecision().policySchema, 'long-neural-search-v2');
  assert.equal(bot.getLastDecision().uniqueLegalPositions, 8);
});

test('v2 unique coverage counts real ANN3 decision 42: 2250 sequences, 188 boards, exactly 32 distinct bounded candidates', () => {
  const game = rules(), state = reported(game, 'ANN3-42');
  const before = JSON.stringify(state), turns = candidate.enumerateUniqueTurns(game, state);
  assert.equal(turns.legalSequences, 2250); assert.equal(turns.rows.length, 188);
  assert.equal(new Set(turns.rows.map(row => row.positionKey)).size, 188);
  const bot = candidate.createNeuralBot(game, model, { maxCandidates: 32, replyWeight: 0 });
  const rows = bot.rank(state);
  assert.equal(rows.length, 32); assert.equal(new Set(rows.map(row => boardKey(row.afterState))).size, 32);
  assert.equal(Math.max(...rows.map(row => row.value)),
    Math.max(...turns.rows.map(row => neural.predict(model, row.afterState, state.turn))),
    'The capped distinct candidate set must retain the network champion across every one of the 188 legal afterstates');
  assert.equal(bot.getLastDecision().uniqueLegalPositions, 188);
  assert.equal(bot.getLastDecision().evaluatedPositions, 188);
  assert.equal(bot.getLastDecision().sampledPositions, 32);
  assert.equal(JSON.stringify(state), before);
  for (const row of rows.filter((_, index) => index % 4 === 0)) {
    assert.deepEqual(ruleFields(row.afterState), ruleFields(execute(game, state, row.moves)));
  }
});

test('v2 keeps a legal safe home-entry alternative visible on EPHZ decision 44 instead of disguising unchanged weak weights', () => {
  const game = rules(), state = reported(game, 'EPHZ-44');
  const rows = candidate.createNeuralBot(game, model, { maxCandidates: 32, replyWeight: 0 }).rank(state);
  assert.equal(rows.length, 11);
  const safeEntry = rows.find(row => homeCount(game, row.afterState, 'dark') === 11);
  assert(safeEntry, 'At least one full legal turn must enter the last checker safely');
  assert.deepEqual(ruleFields(safeEntry.afterState), ruleFields(execute(game, state, safeEntry.moves)));
  assert(Math.abs(safeEntry.value - neural.predict(model, safeEntry.afterState, 'dark')) < 1e-12);
  assert(Number.isFinite(safeEntry.score));
  // This board is already a forced loss on the opponent's next roll. We test
  // coverage and raw-value honesty, not a fabricated rescue or win-rate claim.
  assert(safeEntry.value < Math.max(...rows.map(row => row.value)));
});

test('certified private projection agrees with public rules on first-double head exceptions, partial turns, blocks, bear-off and passes', () => {
  const game = rules();
  const fixtures = [
    ...[3, 4, 6].map(die => position(game, { white: { 24: 15 }, dark: { 12: 15 },
      color: 'white', first: false, dice: [die, die, die, die] })),
    position(game, { white: { 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 13: 10 }, dark: { 12: 15 }, color: 'white', dice: [2, 3] }),
    position(game, { white: { 1: 1, 2: 1, 6: 1 }, dark: { 12: 15 },
      color: 'white', off: { white: 12, dark: 0 }, dice: [2, 4] }),
    position(game, { white: { 1: 1 }, dark: { 12: 15 },
      color: 'white', off: { white: 14, dark: 0 }, dice: [1, 2] }),
    position(game, { white: { 24: 15 }, dark: { 12: 13, 22: 1, 23: 1 }, color: 'white', dice: [1, 2] }),
    position(game, { white: { 1: 2, 2: 1 }, dark: { 12: 15 },
      color: 'white', off: { white: 12, dark: 0 }, dice: [6, 5] }),
    position(game, { white: { 1: 1 }, dark: { 13: 15 },
      color: 'white', off: { white: 14, dark: 0 }, dice: [1, 2] }),
    position(game, { white: { 1: 1 }, dark: { 13: 14 },
      color: 'white', off: { white: 14, dark: 1 }, dice: [1, 2] }),
  ];
  assert.equal(game.basicLegalMove(plain(fixtures[3]), 'white', 13, 11, 0).ok, false,
    'The six-point block fixture must actually prohibit trapping all opponent checkers');
  const partial = plain(fixtures[0]);
  assert(game.applyMove(partial, 24, 3, { autoEnd: false })); fixtures.push(partial);
  for (const state of fixtures) {
    const before = JSON.stringify(state), legal = game.bestMoveSequences(plain(state));
    const turns = candidate.enumerateUniqueTurns(game, state);
    assert.equal(turns.legalSequences, legal.length);
    for (const row of turns.rows) {
      assert(legal.some(sequence => JSON.stringify(plain(sequence.map(({ from, die }) => ({ from, die })))) === JSON.stringify(row.moves)));
      assert.deepEqual(ruleFields(row.afterState), ruleFields(execute(game, state, row.moves)));
      assert.deepEqual(plain(row.afterState.history), []);
    }
    assert.equal(JSON.stringify(state), before, 'Projection must never mutate the real game state');
  }
  const pass = candidate.enumerateUniqueTurns(game, fixtures[6]);
  assert.equal(pass.rows.length, 1); assert.deepEqual(plain(pass.rows[0].moves), []);
  assert.equal(pass.rows[0].afterState.phase, 'roll'); assert.equal(pass.rows[0].afterState.turn, 'dark');
  const oversized = candidate.enumerateUniqueTurns(game, fixtures[7]);
  assert(oversized.rows.every(row => row.afterState.score.white === fixtures[7].score.white + 3),
    'Oversized bear-off earns actual remaining distance, not the oversized die');
  for (const [index, result] of [[5, 'koks'], [8, 'mars'], [9, null]]) {
    const terminal = candidate.enumerateUniqueTurns(game, fixtures[index]);
    assert(terminal.rows.every(row => row.afterState.winner === 'white' && row.afterState.resultType === result));
  }
});

test('v2 enumerates all 21 counterfactual reply rolls evenly, without RNG or claiming future dice knowledge', () => {
  const game = rules(), state = reported(game, 'EPHZ-14');
  const appliedReplyRolls = [], applyRoll = game.applyRoll;
  game.applyRoll = (scratch, dice) => {
    appliedReplyRolls.push(Array.from(dice)); return applyRoll(scratch, dice);
  };
  game.rollDice = () => { throw Error('Forecasting must enumerate counterfactual rolls, not call the real dice generator'); };
  const bot = candidate.createNeuralBot(game, model, { maxCandidates: 8, replyCandidates: 2,
    replyTopCandidates: 2, replyWeight: 0.35 });
  const realRandom = Math.random;
  let rows;
  Math.random = () => { throw Error('Deterministic inference must not use a host-side RNG'); };
  try { rows = bot.rank(state); } finally { Math.random = realRandom; }
  const d = bot.getLastDecision();
  assert(rows.length > 0); assert.equal(d.replyRolls, 21);
  assert(d.replyCandidatesEvaluated > 0 && d.replyCandidatesEvaluated <= 2 * 21 * 2);
  assert.equal(d.policySchema, 'long-neural-search-v2');
  assert.equal(candidate.ROLLS.length, 21);
  assert(Object.isFrozen(candidate.ROLLS));
  assert(Math.abs(candidate.ROLLS.reduce((sum, roll) => sum + roll.probability, 0) - 1) < 1e-12);
  for (const roll of candidate.ROLLS) {
    assert(Object.isFrozen(roll)); assert(Object.isFrozen(roll.dice));
    assert.equal(roll.probability, roll.dice[0] === roll.dice[1] ? 1 / 36 : 2 / 36);
  }
  assert.equal(appliedReplyRolls.length, 2 * 21, 'Both compared shortlist candidates must receive the same complete 21-roll forecast');
  const expected = [];
  for (let a = 1; a <= 6; a += 1) for (let b = a; b <= 6; b += 1) {
    expected.push(JSON.stringify(a === b ? [a, a, a, a] : [a, b]));
  }
  for (let index = 0; index < 2; index += 1) {
    assert.deepEqual(appliedReplyRolls.slice(index * 21, (index + 1) * 21).map(dice => JSON.stringify(dice)).sort(), expected.slice().sort());
  }
  const disabled = candidate.createNeuralBot(game, model, { maxCandidates: 8, replyWeight: 0 });
  disabled.rank(state); assert.equal(disabled.getLastDecision().replyRolls, 0);
  assert.equal(disabled.getLastDecision().replyCandidatesEvaluated, 0);
  assert.equal(appliedReplyRolls.length, 42, 'Disabled forecasts must not enumerate or obtain dice');
  for (const row of rows) assert.equal(row.value, neural.predict(bot.model, row.afterState, state.turn));
});

test('v2 plans, scores and budget coverage are color-rotation invariant and independent of archived analytics or identities', () => {
  const game = rules(), state = reported(game, 'EPHZ-14'), mirror = rotate(state);
  const options = { maxCandidates: 16, replyCandidates: 2, replyTopCandidates: 2, replyWeight: 0.35 };
  const darkBot = candidate.createNeuralBot(game, model, options), whiteBot = candidate.createNeuralBot(game, model, options);
  const darkRows = darkBot.rank(state), whiteRows = whiteBot.rank(mirror);
  assert.deepEqual(darkRows.map(row => Array.from(neural.encodeState(row.afterState, 'dark'))),
    whiteRows.map(row => Array.from(neural.encodeState(row.afterState, 'white'))));
  assert.deepEqual(darkRows.map(row => ({ value: row.value, score: row.score })),
    whiteRows.map(row => ({ value: row.value, score: row.score })));
  assert.deepEqual(plain(darkBot.getLastDecision()), plain(whiteBot.getLastDecision()));
  const enriched = { ...plain(state), history: Array.from({ length: 1200 }, (_, index) =>
    ({ index, fairDiceProof: { retained: true } })), analysis: { fabricatedFutureDice: [6, 6] },
    playerName: 'excluded metadata', nextDice: [6, 6], roomCode: 'excluded' };
  const before = JSON.stringify(enriched);
  assert.deepEqual(darkBot.plan(enriched), darkRows[0].moves);
  assert.equal(JSON.stringify(enriched), before);
  assert.equal(JSON.stringify(darkBot.getLastDecision()).includes('excluded'), false);
});

test('v2 gives certified wins priority over saturated networks and does not fall back to an easy bot', () => {
  const game = rules(), state = position(game, { white: { 1: 1, 2: 1 }, dark: { 12: 15 },
    color: 'white', off: { white: 13, dark: 0 }, dice: [1, 2] });
  game.chooseBotSequence = () => { throw Error('Easy or hard fallback is forbidden in this candidate'); };
  const saturated = neural.createModel({ hiddenSize: 4 }); saturated.outputBias = 100;
  const bot = candidate.createNeuralBot(game, saturated, { maxCandidates: 1 });
  const plan = bot.plan(state), after = execute(game, state, plan);
  assert.equal(after.winner, 'white'); assert.equal(bot.getLastDecision().policySchema, 'long-neural-search-v2');
  assert(Object.isFrozen(bot.model)); assert(Object.isFrozen(bot.model.inputWeights));
  const bytes = JSON.stringify(bot.model); saturated.outputBias = -100;
  assert.equal(JSON.stringify(bot.model), bytes);
});

test('late EPHZ decision 44 uses the actual long-narde Koks zone and evacuates it rather than pretending to rescue a forced loss', () => {
  const game = rules(), state = reported(game, 'EPHZ-44');
  assert.equal(candidate.stateMetrics(game, state, 'dark').koksExposure, 2,
    'Long Koks concerns the loser own first six points (dark12..7), not winner home (white6..1)');
  const legacyPlan = neural.createNeuralBot(game, model, { maxCandidates: 16 }).plan(state);
  const legacyAfter = execute(game, state, legacyPlan);
  assert.equal(game.resultTypeFor(legacyAfter, 'white'), 'koks', 'The reported old turn must retain Koks-zone checkers');
  for (const replyWeight of [0, 0.35]) {
    const bot = candidate.createNeuralBot(game, model, { maxCandidates: 32, replyCandidates: 2,
      replyTopCandidates: 4, replyWeight });
    const ranked = bot.rank(state);
    const after = execute(game, state, ranked[0].moves);
    assert.equal(candidate.stateMetrics(game, after, 'dark').koksExposure, 0);
    assert.equal(game.resultTypeFor(after, 'white'), 'mars',
      'The available full turn must remove avoidable Koks while not claiming an impossible win');
    assert.equal(after.winner, null);
    if (replyWeight > 0) {
      assert.equal(ranked[0].forcedNextTurnLoss, true);
      assert.equal(ranked[0].forcedLossResultType, 'mars',
        'A certified unavoidable next-turn defeat must prefer the available Mars over Koks');
    }
  }
});

test('v2 refuses incomplete rule adapters, malformed budgets and non-long/non-rolled states', () => {
  const game = rules(), state = reported(game, 'EPHZ-14');
  for (const missing of ['basicLegalMove', 'moveTo', 'pathFor', 'pathPos', 'headPoint', 'resultTypeFor', 'endTurn', 'applyRoll', 'bestMoveSequences']) {
    const adapter = { ...game }; delete adapter[missing];
    assert.throws(() => candidate.createNeuralBot(adapter, model), /rule|engine|adapter|missing/i);
  }
  const wrongDarkRoute = { ...game, pathFor(color, variant) {
    const route = Array.from(game.pathFor(color, variant));
    if (color === 'dark') [route[1], route[2]] = [route[2], route[1]];
    return route;
  } };
  assert.throws(() => candidate.createNeuralBot(wrongDarkRoute, model), /route|adapter/i,
    'A dark route with the correct head but wrong remaining order is still an incompatible long engine');
  for (const options of [{ maxCandidates: 0 }, { maxCandidates: Infinity }, { replyCandidates: 0 },
    { replyTopCandidates: 0 }, { replyWeight: NaN }, { replyWeight: -0.1 }, { replyWeight: 1.1 }]) {
    assert.throws(() => candidate.createNeuralBot(game, model, options));
  }
  const bot = candidate.createNeuralBot(game, model);
  assert.throws(() => bot.plan({ ...state, variant: 'short' }));
  assert.throws(() => bot.plan(game.initialState('long')));
});
