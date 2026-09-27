function supportsGeneratedSequencePreview(game) {
  return typeof game?.basicLegalMove === 'function'
    && typeof game?.moveTo === 'function'
    && typeof game?.pathPos === 'function'
    && typeof game?.headPoint === 'function'
    && typeof game?.resultTypeFor === 'function';
}

function previewGeneratedLongSequence(game, state, color, sequence) {
  if (
    String(state?.variant || 'long').toLowerCase() !== 'long'
    || !Array.isArray(sequence)
    || !sequence.length
  ) return null;

  const next = JSON.parse(JSON.stringify(state || {}));
  const activeColor = color || next.turn;
  if (activeColor !== 'white' && activeColor !== 'dark') return null;
  next.variant = 'long';
  next.turn = activeColor;
  next.phase = 'move';
  next.points ||= {};
  next.bar ||= { white: 0, dark: 0 };
  next.off ||= { white: 0, dark: 0 };
  next.score ||= { white: 0, dark: 0 };
  next.dice ||= [];
  next.rolled ||= [];
  next.turnMoves ||= [];
  next.history ||= [];
  next.firstMoveDone ||= { white: false, dark: false };
  next.headPlayedThisTurn ||= { white: false, dark: false };

  for (let index = 0; index < sequence.length; index += 1) {
    const generated = sequence[index] || {};
    const from = Number(generated.from);
    const die = Number(generated.die);
    const dieIndex = next.dice.findIndex(value => Number(value) === die);
    if (!Number.isInteger(from) || dieIndex < 0) return null;

    const expectedTo = game.moveTo(activeColor, from, die, next);
    const hasExplicitTo = Object.prototype.hasOwnProperty.call(generated, 'to');
    const to = generated.bearOff || hasExplicitTo && Number(generated.to) === 0
      ? 0
      : hasExplicitTo ? Number(generated.to) : expectedTo;
    if (!Number.isFinite(to) || expectedTo !== to) {
      return null;
    }
    const check = game.basicLegalMove(next, activeColor, from, to, dieIndex);
    if (!check?.ok || Number(check.die) !== die) return null;

    const source = next.points[from];
    if (!source || source.color !== activeColor || !(Number(source.count) > 0)) {
      return null;
    }
    source.count -= 1;
    if (source.count === 0) delete next.points[from];

    if (check.bearOff) {
      next.off[activeColor] = (Number(next.off[activeColor]) || 0) + 1;
      next.score[activeColor] = (Number(next.score[activeColor]) || 0)
        + 24 - game.pathPos(activeColor, from, next);
    } else {
      const target = next.points[to];
      if (target && target.color !== activeColor) return null;
      if (!target) next.points[to] = { color: activeColor, count: 0 };
      next.points[to].count += 1;
      next.score[activeColor] = (Number(next.score[activeColor]) || 0) + die;
    }

    const removeIndex = Number.isInteger(check.dieIndex)
      && Number(next.dice[check.dieIndex]) === die
      ? check.dieIndex
      : next.dice.findIndex(value => Number(value) === die);
    if (removeIndex < 0) return null;
    next.dice.splice(removeIndex, 1);
    next.turnMoves.push({ color: activeColor, from, to, die, bearOff: check.bearOff });
    if (from === game.headPoint(activeColor, next)) {
      next.headPlayedThisTurn[activeColor] = true;
    }

    if (next.off[activeColor] >= 15) {
      next.winner = activeColor;
      next.resultType = game.resultTypeFor(next, activeColor);
      next.phase = 'over';
    }
    next.history.unshift({
      color: activeColor,
      from,
      to: check.bearOff ? 'снято' : to,
      die,
      hit: false,
      hitColor: null,
      at: new Date().toISOString(),
    });

    // A generated maximum-use sequence cannot continue after the final
    // checker. Reject an externally forged continuation instead of previewing
    // a state which the public rules could never produce.
    if (next.winner && index !== sequence.length - 1) return null;
  }
  return next;
}

export function createNarduGameAdapter(game, options = {}) {
  const generatedSequenceFastPath = options.generatedSequenceFastPath === true
    && supportsGeneratedSequencePreview(game);
  return {
    legalSequences(state, color, options = {}) {
      if (!game?.bestMoveSequences) return [];
      const prepared = {
        ...state,
        turn: color || state.turn,
        phase: 'move',
      };
      const limit = Math.max(0, Number(options.limit) || 0);
      const exhaustiveLongDoubles = options.exhaustiveLongDoubles === true
        && String(prepared.variant || 'long').toLowerCase() === 'long'
        && Array.isArray(prepared.dice)
        && prepared.dice.length >= 3
        && new Set(prepared.dice.map(Number)).size === 1;
      const sequences = exhaustiveLongDoubles
        ? game.bestMoveSequences(prepared, color)
        : limit > 0 && game.sampledMoveSequences
        ? game.sampledMoveSequences(prepared, color, limit)
        : game.bestMoveSequences(prepared, color);
      return sequences
        .filter(sequence => sequence?.length)
        .map(sequence => sequence.map(move => ({
          from: Number(move.from),
          die: Number(move.die),
          to: move.bearOff ? 0 : Number(move.to || game.moveTo(color, move.from, move.die, prepared)),
          bearOff: Boolean(move.bearOff || move.to === 0),
        })));
    },

    applySequence(state, sequence, color) {
      // Sequences reaching this adapter were produced by legalSequences above.
      // Validate each move against the native rules on its intermediate board,
      // then preview the long-only transition without recursively rebuilding
      // the complete move tree for every checker. Public moves and all custom
      // adapters continue through applyMove.
      if (generatedSequenceFastPath) {
        const preview = previewGeneratedLongSequence(
          game,
          state,
          color || state.turn,
          sequence,
        );
        if (preview) return preview;
        throw new Error('Generated long sequence failed native validation');
      }
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
