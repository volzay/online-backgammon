export function createShortNarduGameAdapter(game) {
  function normalizeSequence(state, color, sequence) {
    return sequence.map(move => ({
      from: Number(move.from),
      die: Number(move.die),
      to: move.bearOff ? 0 : Number(move.to || game.moveTo(color, move.from, move.die, state)),
      bearOff: Boolean(move.bearOff || move.to === 0),
      hit: Boolean(move.hit),
    }));
  }

  return {
    legalSequences(state, color, options = {}) {
      const prepared = { ...state, turn: color || state.turn, phase: 'move' };
      const limit = Math.max(0, Number(options.limit) || 0);
      const sequences = limit && game.sampledMoveSequences
        ? game.sampledMoveSequences(prepared, color, limit)
        : shortExactMoveSequences(game, prepared, color);
      return sequences
        .filter(sequence => sequence?.length)
        .map(sequence => normalizeSequence(prepared, color, sequence));
    },
    tacticalSequences(state, color, options = {}) {
      const prepared = { ...state, turn: color || state.turn, phase: 'move' };
      const limit = Math.max(4, Math.min(64, Math.floor(Number(options.limit) || 24)));
      const fallback = game.sampledMoveSequences
        ? game.sampledMoveSequences(prepared, color, limit)
        : game.bestMoveSequences(prepared, color);
      return shortTacticalMoveSequences(game, prepared, color, limit, fallback)
        .filter(sequence => sequence?.length)
        .map(sequence => normalizeSequence(prepared, color, sequence));
    },
    applySequence(state, sequence, color) {
      return applyKnownShortSequence(game, state, sequence, color || state.turn);
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

function shortExactMoveSequences(game, state, color) {
  const maximumDepth = Math.max(1, state.dice?.length || 0);
  let frontier = [{
    state: JSON.parse(JSON.stringify(state || {})),
    sequence: [],
  }];
  const terminal = [];

  for (let depth = 0; depth < maximumDepth && frontier.length; depth += 1) {
    const unique = new Map();
    frontier.forEach(node => {
      const moves = game.legalNextMoves(node.state, color);
      if (!moves.length || node.state.winner) {
        terminal.push(node);
        return;
      }
      moves.forEach(move => {
        const next = applyKnownShortSequence(game, node.state, [move], color);
        const candidate = { state: next, sequence: [...node.sequence, move] };
        const key = shortTacticalStateKey(next);
        const previous = unique.get(key);
        if (!previous || shortCanonicalSequenceKey(candidate.sequence, game, color, state)
          < shortCanonicalSequenceKey(previous.sequence, game, color, state)) {
          unique.set(key, candidate);
        }
      });
    });
    frontier = Array.from(unique.values());
  }

  terminal.push(...frontier);
  const maximumLength = Math.max(0, ...terminal.map(node => node.sequence.length));
  let complete = terminal.filter(node => node.sequence.length === maximumLength);
  const remainingValues = [...new Set(state.dice || [])];
  if (maximumLength === 1 && state.dice?.length === 2 && remainingValues.length === 2) {
    const high = Math.max(...remainingValues);
    const highDie = complete.filter(node => node.sequence[0]?.die === high);
    if (highDie.length) complete = highDie;
  }
  return complete
    .sort((left, right) => shortCanonicalSequenceKey(left.sequence, game, color, state)
      .localeCompare(shortCanonicalSequenceKey(right.sequence, game, color, state)))
    .map(node => node.sequence);
}

function shortTacticalMoveSequences(game, state, color, limit, fallbackSequences = []) {
  const maximumDepth = Math.max(1, state.dice?.length || 0);
  let frontier = [{
    state: JSON.parse(JSON.stringify(state || {})),
    sequence: [],
    features: { hits: 0, entries: 0, offGain: 0, terminal: 0 },
    rootKey: '',
  }];
  const terminal = [];

  for (let depth = 0; depth < maximumDepth && frontier.length; depth += 1) {
    const expanded = [];
    frontier.forEach(node => {
      const moves = game.legalNextMoves(node.state, color);
      if (!moves.length || node.state.winner) {
        terminal.push(node);
        return;
      }
      moves.forEach(rawMove => {
        const target = rawMove.bearOff ? null : node.state.points?.[rawMove.to];
        const move = {
          ...rawMove,
          hit: Boolean(target?.color && target.color !== color && Number(target.count) === 1),
        };
        const next = applyKnownShortSequence(game, node.state, [move], color);
        const features = {
          hits: node.features.hits + (move.hit ? 1 : 0),
          entries: node.features.entries + (Number(move.from) === game.barPoint(color) ? 1 : 0),
          offGain: node.features.offGain + (move.bearOff ? 1 : 0),
          terminal: next.winner === color ? 1 : 0,
        };
        expanded.push({
          state: next,
          sequence: [...node.sequence, move],
          features,
          rootKey: node.rootKey || shortCanonicalMoveKey(move, game, color, state),
        });
      });
    });

    const unique = new Map();
    expanded.forEach(node => {
      const key = shortTacticalStateKey(node.state);
      const previous = unique.get(key);
      if (!previous || compareShortTacticalNodes(node, previous, game, color) < 0) unique.set(key, node);
    });
    frontier = selectShortTacticalBeam(Array.from(unique.values()), limit, game, color);
  }

  terminal.push(...frontier);
  const fallback = (fallbackSequences || []).filter(sequence => sequence?.length).map(sequence => {
    const after = applyKnownShortSequence(game, state, sequence, color);
    const opponent = game.opponentOf(color);
    return {
      state: after,
      sequence,
      features: {
        hits: Math.max(0, (Number(after.bar?.[opponent]) || 0) - (Number(state.bar?.[opponent]) || 0)),
        entries: Math.max(0, (Number(state.bar?.[color]) || 0) - (Number(after.bar?.[color]) || 0)),
        offGain: Math.max(0, (Number(after.off?.[color]) || 0) - (Number(state.off?.[color]) || 0)),
        terminal: after.winner === color ? 1 : 0,
      },
      rootKey: shortCanonicalMoveKey(sequence[0], game, color, state),
    };
  });
  const candidates = [...terminal, ...fallback];
  const maxLength = Math.max(0, ...candidates.map(node => node.sequence.length));
  let complete = selectShortTacticalBeam(
    candidates.filter(node => node.sequence.length === maxLength),
    limit,
    game,
    color,
  );
  const remainingValues = [...new Set(state.dice || [])];
  if (maxLength === 1 && state.dice?.length === 2 && remainingValues.length === 2) {
    const high = Math.max(...remainingValues);
    const highDie = complete.filter(node => node.sequence[0]?.die === high);
    if (highDie.length) complete = highDie;
  }
  return complete.map(node => node.sequence);
}

function selectShortTacticalBeam(nodes, limit, game, color) {
  const ordered = nodes
    .slice()
    .sort((left, right) => compareShortTacticalNodes(left, right, game, color));
  const selected = [];
  const signatures = new Set();
  const add = node => {
    if (!node || selected.length >= limit) return;
    const signature = shortTacticalStateKey(node.state);
    if (signatures.has(signature)) return;
    selected.push(node);
    signatures.add(signature);
  };
  const reserveStrongest = feature => ordered
    .filter(node => Number(node.features?.[feature]) > 0)
    .slice(0, Math.max(2, Math.ceil(limit / 8)))
    .forEach(add);

  reserveStrongest('terminal');
  reserveStrongest('hits');
  reserveStrongest('entries');
  reserveStrongest('offGain');

  const rootRepresentatives = new Map();
  ordered.forEach(node => {
    if (!rootRepresentatives.has(node.rootKey)) rootRepresentatives.set(node.rootKey, node);
  });
  rootRepresentatives.forEach(add);

  const endpointRepresentatives = new Map();
  ordered.forEach(node => {
    const last = node.sequence[node.sequence.length - 1];
    const key = shortCanonicalMoveKey(last, game, color, node.state);
    if (!endpointRepresentatives.has(key)) endpointRepresentatives.set(key, node);
  });
  endpointRepresentatives.forEach(add);
  ordered.forEach(add);
  return selected.sort((left, right) => compareShortTacticalNodes(left, right, game, color));
}

function compareShortTacticalNodes(left, right, game, color) {
  const scoreDifference = shortTacticalNodePriority(right, game, color)
    - shortTacticalNodePriority(left, game, color);
  if (scoreDifference) return scoreDifference;
  return shortCanonicalSequenceKey(left.sequence, game, color, left.state)
    .localeCompare(shortCanonicalSequenceKey(right.sequence, game, color, right.state));
}

function shortTacticalNodePriority(node, game, color) {
  const opponent = game.opponentOf(color);
  const made = Object.values(node.state.points || {}).reduce((total, point) => (
    total + (point.color === color && Number(point.count) >= 2 ? 1 : 0)
  ), 0);
  return Number(node.features.terminal) * 1_000_000_000
    + Number(node.features.hits) * 20_000_000
    + Number(node.features.entries) * 4_000_000
    + (Number(node.state.off?.[color]) || 0) * 1_000_000
    + (Number(node.state.bar?.[opponent]) || 0) * 600_000
    - (Number(node.state.bar?.[color]) || 0) * 750_000
    - game.pipsFor(node.state, color) * 1200
    + made * 1800;
}

function shortCanonicalMoveKey(move, game, color, state) {
  if (!move) return '';
  const from = Number(move.from) === game.barPoint(color)
    ? -1
    : game.pathPos(color, Number(move.from), state);
  const to = move.bearOff || Number(move.to) === 0
    ? 24
    : game.pathPos(color, Number(move.to), state);
  return `${String(from).padStart(2, '0')}:${String(to).padStart(2, '0')}:${Number(move.die)}`;
}

function shortCanonicalSequenceKey(sequence, game, color, state) {
  return (sequence || []).map(move => shortCanonicalMoveKey(move, game, color, state)).join('|');
}

function shortTacticalStateKey(state) {
  const points = Object.entries(state.points || {})
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([point, stack]) => `${point}:${stack.color}:${stack.count}`)
    .join('|');
  return `${(state.dice || []).slice().sort().join(',')}|${state.bar?.white || 0}:${state.bar?.dark || 0}|${state.off?.white || 0}:${state.off?.dark || 0}|${points}`;
}

function applyKnownShortSequence(game, state, sequence, color) {
  const next = JSON.parse(JSON.stringify(state || {}));
  next.turn = color;
  next.phase = 'move';
  next.points ||= {};
  next.bar ||= { white: 0, dark: 0 };
  next.off ||= { white: 0, dark: 0 };
  next.score ||= { white: 0, dark: 0 };
  next.dice ||= [];
  next.turnMoves ||= [];
  const opponent = game.opponentOf(color);
  const barPoint = game.barPoint(color);

  (sequence || []).forEach(move => {
    const from = Number(move.from);
    const die = Number(move.die);
    const bearOff = Boolean(move.bearOff || Number(move.to) === 0);
    const to = bearOff ? 0 : Number(move.to || game.moveTo(color, from, die, next));
    if (from === barPoint) {
      next.bar[color] = Math.max(0, (Number(next.bar[color]) || 0) - 1);
    } else {
      const source = next.points[from];
      if (source?.color === color) {
        source.count -= 1;
        if (source.count <= 0) delete next.points[from];
      }
    }
    if (bearOff) {
      next.off[color] = (Number(next.off[color]) || 0) + 1;
      next.score[color] = (Number(next.score[color]) || 0) + 24 - game.pathPos(color, from, next);
    } else {
      const target = next.points[to];
      if (target?.color === opponent && Number(target.count) === 1) {
        next.bar[opponent] = (Number(next.bar[opponent]) || 0) + 1;
        delete next.points[to];
      }
      if (!next.points[to]) next.points[to] = { color, count: 0 };
      next.points[to].count += 1;
      next.score[color] = (Number(next.score[color]) || 0) + die;
    }
    const dieIndex = Number.isInteger(move.dieIndex) && next.dice[move.dieIndex] === die
      ? move.dieIndex
      : next.dice.indexOf(die);
    if (dieIndex !== -1) next.dice.splice(dieIndex, 1);
    next.turnMoves.push({ color, from, to, die, bearOff });
    if ((Number(next.off[color]) || 0) >= 15) {
      next.winner = color;
      next.resultType = game.resultTypeFor(next, color);
      next.phase = 'over';
    }
  });
  return next;
}
