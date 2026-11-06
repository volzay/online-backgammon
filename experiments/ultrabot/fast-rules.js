'use strict';

self.NarduUltrabotRules = Object.freeze({ createAdapter });

function createAdapter(game, checkBudget) {
  function seed(state, color) {
    if (state.variant !== 'long') throw new Error('Ultrabot rules require long narde');
    const head = game.headPoint(color, state);
    return {
      state: {
        variant: 'long', phase: state.phase, turn: state.turn, winner: state.winner,
        points: { ...state.points }, bar: { ...state.bar }, off: { ...state.off },
        dice: state.dice.slice(), rolled: state.rolled.slice(),
        firstMoveDone: { ...state.firstMoveDone }, turnMoves: state.turnMoves.slice(),
      },
      moves: [], key: '', headUsed: state.turnMoves.filter(move => move.from === head).length,
    };
  }

  function available(node) {
    const state = node.state;
    return state.phase === 'move' && !state.winner && state.dice.length;
  }

  function advance(node, move, color, head) {
    const { state } = node;
    const { from, to, die, dieIndex, bearOff } = move;
    // Native legalNextMoves certified the step. Only its private long-board
    // effects are needed to ask the native rules for the next legal steps.
    const points = { ...state.points };
    const source = points[from];
    if (source.count === 1) delete points[from];
    else points[from] = { color, count: source.count - 1 };
    const off = { ...state.off };
    if (bearOff) off[color] += 1;
    else points[to] = { color, count: (points[to]?.count || 0) + 1 };
    const dice = state.dice.slice();
    dice.splice(dieIndex, 1);
    const winner = off[color] === 15 ? color : null;
    const position = color === 'white' ? 24 - from : (36 - from) % 24;
    return {
      state: {
        variant: 'long', phase: winner ? 'over' : 'move', turn: color, winner,
        points, off, bar: { ...state.bar }, dice, rolled: state.rolled,
        firstMoveDone: state.firstMoveDone,
        turnMoves: [...state.turnMoves, { color, from, to, die, bearOff }],
      },
      moves: [...node.moves, move],
      // Each code unit sorts like the V2 key's two-digit position and die.
      key: node.key + String.fromCharCode(position * 8 + die),
      headUsed: node.headUsed + Number(from === head),
    };
  }

  function positionKey(node, color) {
    const { state, headUsed } = node;
    let board = '';
    for (let point = 1; point <= 24; point += 1) {
      const stack = state.points[point];
      board += String.fromCharCode(stack ? stack.count + (stack.color === 'dark' ? 16 : 0) : 0);
    }
    return `${board}|${state.off[color]}|${state.dice.join('')}|${headUsed}|${state.winner || ''}`;
  }

  function bestMoveSequences(state, color = state.turn) {
    checkBudget();
    const root = seed(state, color);
    if (!available(root) || state.turn !== color) return [[]];
    const head = game.headPoint(color, state);
    let frontier = [root];
    for (;;) {
      const next = new Map();
      for (const node of frontier) {
        checkBudget();
        if (!available(node)) continue;
        for (const move of game.legalNextMoves(node.state, color)) {
          checkBudget();
          const child = advance(node, move, color, head);
          const key = positionKey(child, color);
          const prior = next.get(key);
          // Equal board, dice and head usage have the same legal continuations.
          if (!prior || child.key < prior.key) next.set(key, child);
        }
      }
      if (!next.size) break;
      frontier = Array.from(next.values());
    }
    let best = frontier.map(node => node.moves);
    if (best[0].length === 1 && state.dice.length === 2 && state.dice[0] !== state.dice[1]) {
      const high = Math.max(...state.dice);
      const highMoves = best.filter(sequence => sequence[0].die === high);
      if (highMoves.length) best = highMoves;
    }
    return best;
  }

  function firstBestMoveSequence(state) {
    checkBudget();
    const color = state.turn;
    const root = seed(state, color);
    if (!available(root)) return [];
    const head = game.headPoint(color, state);
    const seen = new Set();
    let best = [];
    function visit(node) {
      checkBudget();
      const moves = node.moves;
      if (moves.length > best.length || (moves.length === 1 && best.length === 1
        && state.dice.length === 2 && moves[0].die > best[0].die)) best = moves;
      if (best.length === state.dice.length) return true;
      if (!available(node)) return false;
      const key = positionKey(node, color);
      if (seen.has(key)) return false;
      seen.add(key);
      const legal = game.legalNextMoves(node.state, color).sort((left, right) => right.die - left.die);
      return legal.some(move => visit(advance(node, move, color, head)));
    }
    visit(root);
    return best;
  }

  function hasAnyMoves(state) {
    checkBudget();
    const root = seed(state, state.turn);
    return Boolean(available(root) && game.legalNextMoves(root.state, state.turn).length);
  }

  return Object.freeze({ ...game, bestMoveSequences, firstBestMoveSequence, hasAnyMoves });
}
