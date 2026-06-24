/* ---------------------------------------------------------------
   bot.js - heuristic bot for Long Backgammon.
   Exposes: window.NarduBot
   --------------------------------------------------------------- */
window.NarduBot = (function () {
  const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

  function normalizeDifficulty(value, state = {}) {
    const raw = String(value || state.botDifficulty || '').trim().toLowerCase();
    if (DIFFICULTIES.has(raw)) return raw;
    if (/hard|слож|1500/.test(raw)) return 'hard';
    if (/medium|сред|1200/.test(raw)) return 'medium';
    return 'easy';
  }

  function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function headCount(state, color) {
    return state.points?.[NarduGame.headPoint(color, state)]?.count || 0;
  }

  /* score a candidate single move for the easy bot */
  function evalMove(state, from, die) {
    const color = state.turn;
    const to = NarduGame.moveTo(color, from, die, state);
    let score = die * 3;

    if (to === 0) return 1000 + die;
    if (!state.points?.[to]) score += 5;
    if (NarduGame.pointColor(state, to) === color) score += 2;
    if (NarduGame.allInHome(state, color)) {
      score += NarduGame.pointToTrack(color, to, state) * 2;
    }
    if (from === NarduGame.headPoint(color, state)) score += headCount(state, color) > 9 ? 6 : -2;
    score += Math.random() * 4;
    return score;
  }

  function pickEasyMove(state) {
    let best = null;
    let bestScore = -Infinity;
    const tried = new Set();
    for (const move of NarduGame.legalNextMoves(state)) {
      const key = `${move.from}:${move.die}`;
      if (tried.has(key)) continue;
      tried.add(key);
      if (!NarduGame.isValidMove(state, move.from, move.die)) continue;
      const score = evalMove(state, move.from, move.die);
      if (score > bestScore) {
        best = { from: move.from, die: move.die };
        bestScore = score;
      }
    }
    return best;
  }

  function chooseEasySequence(state) {
    const moves = [];
    const preview = cloneState(state);
    while (preview.phase === 'move' && preview.dice.length && NarduGame.hasAnyMoves(preview)) {
      const move = pickEasyMove(preview);
      if (!move) break;
      moves.push({ from: move.from, die: move.die });
      NarduGame.applyMove(preview, move.from, move.die, { autoEnd: false });
    }
    return moves;
  }

  function chooseSequence(state, difficulty = 'easy') {
    if (difficulty === 'easy') return chooseEasySequence(state);
    if (difficulty === 'hard' && window.NarduStrongBot?.plan) {
      const strong = window.NarduStrongBot.plan(state);
      if (strong?.length) return strong;
    }
    return NarduGame.chooseBotSequence?.(state, state.turn, { difficulty }) || [];
  }

  function pickBestMove(state, options = {}) {
    const difficulty = normalizeDifficulty(options.difficulty, state);
    const sequence = chooseSequence(state, difficulty);
    return sequence?.length ? { from: sequence[0].from, die: sequence[0].die } : null;
  }

  /* Play out the bot's turn, returning the list of moves it made.
     Each move is { from, die } so the UI can animate them sequentially. */
  function plan(state, options = {}) {
    const preview = cloneState(state);
    const difficulty = normalizeDifficulty(options.difficulty, preview);
    return chooseSequence(preview, difficulty)
      .map(move => ({ from: move.from, die: move.die }));
  }

  return {
    plan,
    pickBestMove,
    evalMove,
  };
})();
