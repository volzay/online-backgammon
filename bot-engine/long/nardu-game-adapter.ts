export function createNarduGameAdapter(game) {
  return {
    legalSequences(state, color) {
      if (!game?.bestMoveSequences) return [];
      const prepared = {
        ...state,
        turn: color || state.turn,
        phase: 'move',
      };
      return game.bestMoveSequences(prepared, color)
        .filter(sequence => sequence?.length)
        .map(sequence => sequence.map(move => ({
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
      sequence.forEach(move => {
        game.applyMove(next, move.from, move.die, { autoEnd: false });
      });
      return next;
    },

    moveTo(state, color, from, die) {
      return game.moveTo(color, from, die, state);
    },
  };
}
