/* ───────────────────────────────────────────────────────
   bot.js — simple heuristic bot for Long Backgammon
   Exposes: window.NarduBot
   ─────────────────────────────────────────────────────── */
window.NarduBot = (function () {

  /* score a candidate single move */
  function evalMove(state, from, die) {
    const color = state.turn;
    const to = NarduGame.moveTo(color, from, die);
    let s = 0;

    if (to === 0) return 1000 + die;        /* bearing off is great */

    s += die * 3;                            /* more pips ≈ more progress */

    /* stacking on own column = mild bonus */
    if (NarduGame.pointColor(state, to) === color) s += 6;

    /* moving deeper into home = strong bonus when close to bear-off */
    if (NarduGame.allInHome(state, color)) {
      const trackTo = NarduGame.pointToTrack(color, to);
      s += trackTo * 2;
    }

    /* avoid leaving single-checker exposure (less critical without hitting,
       but keeps stacks tidy) */
    const srcCount = state.points[from].count;
    if (srcCount === 1) s -= 2;
    if (srcCount > 4)   s += 2;

    /* prefer to move from head only when needed */
    if (from === NarduGame.headPoint(color)) s -= 3;

    return s;
  }

  function pickBestMove(state) {
    const sequence = NarduGame.chooseBotSequence?.(state, state.turn);
    if (sequence?.length) {
      return { from: sequence[0].from, die: sequence[0].die };
    }

    let best = null, bestScore = -Infinity;
    for (const k in state.points) {
      const p = state.points[k];
      if (p.color !== state.turn) continue;
      const from = +k;
      const tried = new Set();
      for (const d of state.dice) {
        if (tried.has(d)) continue;
        tried.add(d);
        if (!NarduGame.isValidMove(state, from, d)) continue;
        const sc = evalMove(state, from, d);
        if (sc > bestScore) { bestScore = sc; best = { from, die: d }; }
      }
    }
    return best;
  }

  /* Play out the bot's turn, returning the list of moves it made.
     Each move is { from, die } so the UI can animate them sequentially. */
  function plan(state) {
    /* clone state so we don't mutate before animation finishes */
    const s = JSON.parse(JSON.stringify(state));
    const sequence = NarduGame.chooseBotSequence?.(s, s.turn);
    if (sequence?.length) {
      return sequence.map(move => ({ from: move.from, die: move.die }));
    }

    const moves = [];
    while (s.phase === 'move' && s.dice.length && NarduGame.hasAnyMoves(s)) {
      const m = pickBestMove(s);
      if (!m) break;
      NarduGame.applyMove(s, m.from, m.die);
      moves.push(m);
    }
    return moves;
  }

  return { plan, pickBestMove, evalMove };
})();
