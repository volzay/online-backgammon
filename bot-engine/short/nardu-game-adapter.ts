export function createShortNarduGameAdapter(game) {
  return {
    legalSequences(state, color, options = {}) {
      const prepared = { ...state, turn: color || state.turn, phase: 'move' };
      const limit = Math.max(0, Number(options.limit) || 0);
      const sequences = limit && game.sampledMoveSequences
        ? game.sampledMoveSequences(prepared, color, limit)
        : game.bestMoveSequences(prepared, color);
      return sequences.filter(sequence => sequence?.length).map(sequence => sequence.map(move => ({
        from: Number(move.from),
        die: Number(move.die),
        to: move.bearOff ? 0 : Number(move.to || game.moveTo(color, move.from, move.die, prepared)),
        bearOff: Boolean(move.bearOff || move.to === 0),
      })));
    },
    applySequence(state, sequence, color) {
      const next = JSON.parse(JSON.stringify(state || {}));
      next.turn = color || state.turn;
      next.phase = 'move';
      sequence.forEach(move => game.applyMove(next, move.from, move.die, { autoEnd: false }));
      return next;
    },
    baselineSequence(state, color) {
      return (game.chooseBotSequence?.(state, color, { difficulty: 'hard' }) || []).map(move => ({
        from: Number(move.from),
        die: Number(move.die),
        to: move.bearOff ? 0 : Number(move.to || game.moveTo(color, move.from, move.die, state)),
        bearOff: Boolean(move.bearOff || move.to === 0),
      }));
    },
  };
}
