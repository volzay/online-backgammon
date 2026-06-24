/* ------------------------------------------------------------------
   game.js - Long Backgammon rules engine.
   Rules are adapted from the backgammon-web server algorithm.
   Exposes: window.NarduGame
   ------------------------------------------------------------------ */

window.NarduGame = (function () {
  const LONG_WHITE_PATH = [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const LONG_DARK_PATH = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13];
  const SHORT_WHITE_PATH = LONG_WHITE_PATH;
  const SHORT_DARK_PATH = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];

  function normalizeVariant(value) {
    return value === 'short' ? 'short' : 'long';
  }

  function initialPointsFor(variant) {
    if (variant === 'short') {
      return {
        24: { color: 'white', count: 2 },
        13: { color: 'white', count: 5 },
        8: { color: 'white', count: 3 },
        6: { color: 'white', count: 5 },
        1: { color: 'dark', count: 2 },
        12: { color: 'dark', count: 5 },
        17: { color: 'dark', count: 3 },
        19: { color: 'dark', count: 5 },
      };
    }

    return {
      24: { color: 'white', count: 15 },
      12: { color: 'dark', count: 15 },
    };
  }

  function initialState(variant = 'long') {
    const normalizedVariant = normalizeVariant(variant);
    return {
      variant: normalizedVariant,
      points: initialPointsFor(normalizedVariant),
      bar: { white: 0, dark: 0 },
      off: { white: 0, dark: 0 },
      score: { white: 0, dark: 0 },
      dice: [],
      rolled: [],
      turn: null,
      phase: 'opening',
      startedAt: Date.now(),
      finishedAt: null,
      turnClock: { white: 0, dark: 0, active: null, startedAt: null },
      matchScore: { white: 0, dark: 0, target: 5, recordedWinner: null },
      winner: null,
      resultType: null,
      openingRoll: null,
      turnMoves: [],
      firstMoveDone: { white: false, dark: false },
      headPlayedThisTurn: { white: false, dark: false },
      history: [],
    };
  }

  function rollDice() {
    const a = 1 + Math.floor(Math.random() * 6);
    const b = 1 + Math.floor(Math.random() * 6);
    return a === b ? [a, a, a, a] : [a, b];
  }

  function rollSingleDie() {
    return 1 + Math.floor(Math.random() * 6);
  }

  function decideOpeningRoll(state, host = {}, guest = {}) {
    normalizeState(state);
    let hostDie = Number(host.die) || rollSingleDie();
    let guestDie = Number(guest.die) || rollSingleDie();
    let rerolls = 0;
    while (hostDie === guestDie) {
      rerolls += 1;
      hostDie = rollSingleDie();
      guestDie = rollSingleDie();
    }

    const hostColor = host.color || 'white';
    const guestColor = guest.color || 'dark';
    const winnerColor = hostDie > guestDie ? hostColor : guestColor;
    const at = new Date().toISOString();
    state.openingRoll = {
      host: {
        id: host.id || 'host',
        name: host.name || 'Белые',
        color: hostColor,
        die: hostDie,
      },
      guest: {
        id: guest.id || 'guest',
        name: guest.name || 'Тёмные',
        color: guestColor,
        die: guestDie,
      },
      winnerColor,
      rerolls,
      at,
    };
    state.turn = winnerColor;
    state.dice = [];
    state.rolled = [hostDie, guestDie];
    state.turnMoves = [];
    state.headPlayedThisTurn = { white: false, dark: false };
    state.phase = 'opening-result';
    state.history.unshift({
      opening: true,
      host: hostDie,
      guest: guestDie,
      hostName: state.openingRoll.host.name,
      guestName: state.openingRoll.guest.name,
      winnerColor,
      rerolls,
      at,
    });
    return state.openingRoll;
  }

  function startOpeningTurn(state) {
    normalizeState(state);
    const opening = state.openingRoll;
    if (!opening || state.phase === 'move' || state.winner) return false;
    const diceValues = [opening.host.die, opening.guest.die];
    state.turn = opening.winnerColor;
    state.rolled = diceValues.slice();
    state.dice = diceValues.slice();
    state.turnMoves = [];
    state.headPlayedThisTurn = { white: false, dark: false };
    state.phase = 'move';
    state.history.unshift({
      color: state.turn,
      roll: `${diceValues[0]}:${diceValues[1]}`,
      openingMove: true,
      at: new Date().toISOString(),
    });
    return true;
  }

  function applyRoll(state, roll) {
    normalizeState(state);
    state.rolled = roll.slice();
    state.dice = roll.slice();
    state.phase = 'move';
    state.turnMoves = [];
    state.headPlayedThisTurn = { white: false, dark: false };
    return state;
  }

  function variantOf(stateOrVariant = 'long') {
    return typeof stateOrVariant === 'object'
      ? normalizeVariant(stateOrVariant?.variant)
      : normalizeVariant(stateOrVariant);
  }

  function isShort(state) {
    return variantOf(state) === 'short';
  }

  function pathFor(color, stateOrVariant = 'long') {
    const variant = variantOf(stateOrVariant);
    if (variant === 'short') return color === 'white' ? SHORT_WHITE_PATH : SHORT_DARK_PATH;
    return color === 'white' ? LONG_WHITE_PATH : LONG_DARK_PATH;
  }

  function opponentOf(color) {
    return color === 'white' ? 'dark' : 'white';
  }

  function pathPos(color, point, stateOrVariant = 'long') {
    return pathFor(color, stateOrVariant).indexOf(Number(point));
  }

  function pointToTrack(color, point, stateOrVariant = 'long') {
    return pathPos(color, point, stateOrVariant);
  }

  function trackToPoint(color, track, stateOrVariant = 'long') {
    return pathFor(color, stateOrVariant)[track] || 0;
  }

  function barPoint(color) {
    return color === 'white' ? 25 : -1;
  }

  function isBarPointFor(color, point) {
    return Number(point) === barPoint(color);
  }

  function moveTo(color, fromPoint, distance, stateOrVariant = 'long') {
    if (variantOf(stateOrVariant) === 'short' && isBarPointFor(color, fromPoint)) {
      return pathFor(color, stateOrVariant)[distance - 1] || 0;
    }
    const pos = pathPos(color, fromPoint, stateOrVariant);
    if (pos < 0) return 0;
    const next = pos + distance;
    return next >= 24 ? 0 : pathFor(color, stateOrVariant)[next];
  }

  function pointColor(state, point) {
    if (isShort(state)) {
      if (isBarPointFor('white', point)) return (state.bar?.white || 0) > 0 ? 'white' : null;
      if (isBarPointFor('dark', point)) return (state.bar?.dark || 0) > 0 ? 'dark' : null;
    }
    return state.points[point]?.color || null;
  }

  function pointCount(state, point) {
    if (isShort(state)) {
      if (isBarPointFor('white', point)) return state.bar?.white || 0;
      if (isBarPointFor('dark', point)) return state.bar?.dark || 0;
    }
    return state.points[point]?.count || 0;
  }

  function headPoint(color, stateOrVariant = 'long') {
    return pathFor(color, stateOrVariant)[0];
  }

  function allInHome(state, color) {
    return homeReady(state, color);
  }

  function homeReady(state, color) {
    if (isShort(state) && (state.bar?.[color] || 0) > 0) return false;
    const home = new Set(pathFor(color, state).slice(18));
    return Object.entries(state.points).every(([point, data]) => (
      data.color !== color || home.has(Number(point))
    ));
  }

  function canBearOffFrom(state, color, from, die) {
    if (!homeReady(state, color)) return false;
    const pos = pathPos(color, from, state);
    if (pos < 18) return false;
    const exact = 24 - pos;
    if (die === exact) return true;
    if (die < exact) return false;
    const path = pathFor(color, state);
    return !path.slice(18, pos).some(point => state.points[point]?.color === color);
  }

  function farthestFromOff(state, color) {
    let maxDist = 0;
    Object.entries(state.points).forEach(([point, data]) => {
      if (data.color !== color) return;
      const pos = pathPos(color, Number(point), state);
      maxDist = Math.max(maxDist, 24 - pos);
    });
    return maxDist;
  }

  function headMoveLimit(state, color) {
    const first = !state.firstMoveDone?.[color];
    const firstDie = state.rolled?.[0] || state.dice?.[0];
    const isDouble = state.rolled?.length >= 2 && state.rolled.every(die => die === firstDie);
    const isSpecialDouble = isDouble && [3, 4, 6].includes(firstDie);
    return first && isSpecialDouble ? 2 : 1;
  }

  function pointOpenFor(state, color, point) {
    const target = state.points[point];
    if (isShort(state)) return !target || target.color === color || target.count === 1;
    return !target || target.color === color;
  }

  function moveSources(state, color) {
    if (isShort(state) && (state.bar?.[color] || 0) > 0) return [barPoint(color)];
    return Object.entries(state.points)
      .filter(([, data]) => data.color === color)
      .map(([point]) => Number(point));
  }

  function basicLegalMove(state, color, from, to, dieIndex = null) {
    normalizeState(state);
    if (state.phase !== 'move' || state.turn !== color || !state.dice.length || state.winner) {
      return { ok: false, message: 'Сейчас нельзя ходить.' };
    }

    const fromBar = isShort(state) && isBarPointFor(color, from);
    const source = fromBar
      ? { color, count: state.bar?.[color] || 0 }
      : state.points[from];
    if (!source || source.color !== color || source.count < 1) {
      return { ok: false, message: 'Выберите свою шашку.' };
    }
    if (isShort(state) && (state.bar?.[color] || 0) > 0 && !fromBar) {
      return { ok: false, message: 'Сначала нужно войти шашкой с бара.' };
    }

    const bearOff = to === 0 || to < 1 || to > 24;
    const indexes = dieIndex === null ? state.dice.map((_, index) => index) : [dieIndex];
    const matchedIndex = indexes.find(index => {
      const value = state.dice[index];
      const dest = moveTo(color, from, value, state);
      return bearOff
        ? dest === 0 && canBearOffFrom(state, color, from, value)
        : dest === to;
    });

    if (matchedIndex === undefined) {
      return { ok: false, message: 'Ход должен соответствовать одному из кубиков.' };
    }

    const die = state.dice[matchedIndex];
    if (bearOff && !canBearOffFrom(state, color, from, die)) {
      return { ok: false, message: 'Снимать шашки можно только из дома и по правилу старшего пункта.' };
    }
    if (!bearOff && moveTo(color, from, die, state) !== to) {
      return { ok: false, message: isShort(state) ? 'Ход должен соответствовать направлению коротких нард.' : 'Ход должен идти по маршруту длинных нард.' };
    }

    if (!isShort(state) && from === headPoint(color, state)) {
      const used = state.turnMoves.filter(move => move.from === from).length;
      if (used >= headMoveLimit(state, color)) {
        return { ok: false, message: 'С головы можно взять только одну шашку за ход.' };
      }
    }

    if (!bearOff) {
      if (!pointOpenFor(state, color, to)) {
        return { ok: false, message: 'Пункт закрыт соперником.' };
      }
      if (!isShort(state) && violatesLongBlockRuleDuringMove(state, color, from, to, false)) {
        return { ok: false, message: 'Нельзя строить блок из шести, запирающий все 15 шашек соперника.' };
      }
    }

    return { ok: true, dieIndex: matchedIndex, die, bearOff };
  }

  function legalNextMoves(state, color = state.turn) {
    normalizeState(state);
    const moves = [];
    const seen = new Set();
    for (const from of moveSources(state, color)) {
      state.dice.forEach((die, dieIndex) => {
        const dest = moveTo(color, from, die, state);
        const to = dest === 0 ? 0 : dest;
        const check = basicLegalMove(state, color, from, to, dieIndex);
        if (!check.ok) return;
        const key = `${from}:${to}:${die}`;
        if (seen.has(key)) return;
        seen.add(key);
        moves.push({ from, to, die, dieIndex: check.dieIndex, bearOff: check.bearOff });
      });
    }
    return moves;
  }

  function isValidMove(state, from, die) {
    normalizeState(state);
    if (state.phase !== 'move') return false;
    const color = state.turn;
    const to = moveTo(color, from, die, state);
    const basic = basicLegalMove(state, color, from, to, state.dice.indexOf(die));
    if (!basic.ok) return false;
    return bestMoveSequences(state, color).some(sequence => (
      sequence[0]?.from === from && sequence[0]?.to === to && sequence[0]?.die === die
    ));
  }

  function legalDestinations(state, from) {
    normalizeState(state);
    if (state.phase !== 'move' || pointColor(state, from) !== state.turn) return [];

    const results = [];
    const seen = new Set();
    bestMoveSequences(state, state.turn).forEach(sequence => {
      const move = sequence[0];
      if (!move || move.from !== from) return;
      const key = `${move.to}:${move.die}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ die: move.die, to: move.to, bearOff: move.bearOff });
    });
    return results;
  }

  function hasAnyMoves(state) {
    normalizeState(state);
    return bestMoveSequences(state, state.turn).some(sequence => sequence.length > 0);
  }

  function applyMove(state, from, dieOrTo, opts = {}) {
    normalizeState(state);
    if (state.phase !== 'move') return false;
    const color = state.turn;
    const value = Number(dieOrTo);
    const sequences = bestMoveSequences(state, color);
    let allowed = null;

    if (state.dice.includes(value)) {
      const to = moveTo(color, from, value, state);
      allowed = sequences.find(sequence => (
        sequence[0]?.from === from && sequence[0]?.to === to && sequence[0]?.die === value
      ));
    }

    if (!allowed) {
      const to = value < 1 || value > 24 ? 0 : value;
      allowed = sequences.find(sequence => (
        sequence[0]?.from === from && sequence[0]?.to === to
      ));
    }

    if (!allowed) return false;

    const move = allowed[0];
    commitMove(state, color, move);
    state.history.unshift({
      color,
      from,
      to: move.bearOff ? 'снято' : move.to,
      die: move.die,
      hit: Boolean(move.hit),
      hitColor: move.hitColor || null,
      at: new Date().toISOString(),
    });

    if (state.winner) {
      state.phase = 'over';
      return true;
    }
    if (opts.autoEnd !== false && (!state.dice.length || !hasAnyMoves(state))) endTurn(state);
    return true;
  }

  function commitMove(state, color, move) {
    const fromBar = isShort(state) && isBarPointFor(color, move.from);
    if (fromBar) {
      state.bar[color] = Math.max(0, (state.bar[color] || 0) - 1);
    } else {
      const source = state.points[move.from];
      source.count -= 1;
      if (source.count === 0) delete state.points[move.from];
    }

    if (move.bearOff) {
      state.off[color] += 1;
      state.score[color] += 24 - pathPos(color, move.from, state);
    } else {
      const target = state.points[move.to];
      const hit = isShort(state) && target?.color && target.color !== color && target.count === 1;
      if (hit) {
        const opponent = target.color;
        state.bar[opponent] = (state.bar[opponent] || 0) + 1;
        state.points[move.to] = { color, count: 0 };
        move.hit = true;
        move.hitColor = opponent;
      }
      if (!state.points[move.to]) state.points[move.to] = { color, count: 0 };
      state.points[move.to].count += 1;
      state.score[color] += move.die;
    }

    const removeIndex = Number.isInteger(move.dieIndex) && state.dice[move.dieIndex] === move.die
      ? move.dieIndex
      : state.dice.indexOf(move.die);
    if (removeIndex !== -1) state.dice.splice(removeIndex, 1);

    state.turnMoves.push({ color, from: move.from, to: move.to, die: move.die, bearOff: move.bearOff });
    if (!isShort(state) && move.from === headPoint(color, state)) state.headPlayedThisTurn[color] = true;

    if (state.off[color] >= 15) {
      state.winner = color;
      state.resultType = resultTypeFor(state, color);
      state.phase = 'over';
    }
  }

  function sequenceCacheKey(state, color) {
    const points = Object.entries(state.points)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([point, data]) => `${point}:${data.color}:${data.count}`)
      .join('|');
    const moves = state.turnMoves
      .map(move => `${move.from}:${move.to}:${move.die}`)
      .join('|');
    return [
      state.variant,
      color,
      state.turn,
      state.phase,
      state.dice.join(','),
      state.rolled.join(','),
      `${state.bar?.white || 0}:${state.bar?.dark || 0}`,
      `${state.off?.white || 0}:${state.off?.dark || 0}`,
      moves,
      points,
    ].join(';');
  }

  function rawMoveSequences(state, color, memo = new Map()) {
    normalizeState(state);
    if (!state.dice.length || state.winner || state.phase !== 'move') return [[]];
    const cacheKey = sequenceCacheKey(state, color);
    const cached = memo.get(cacheKey);
    if (cached) return cached;
    const moves = legalNextMoves(state, color);
    if (!moves.length) {
      const none = [[]];
      memo.set(cacheKey, none);
      return none;
    }

    const sequences = [];
    for (const move of moves) {
      const next = cloneState(state);
      commitMove(next, color, move);
      for (const tail of rawMoveSequences(next, color, memo)) {
        sequences.push([move, ...tail]);
      }
    }
    memo.set(cacheKey, sequences);
    return sequences;
  }

  function bestMoveSequences(state, color = state.turn) {
    const sequences = rawMoveSequences(state, color);
    const maxLength = Math.max(0, ...sequences.map(sequence => sequence.length));
    let best = sequences.filter(sequence => sequence.length === maxLength);

    const remainingValues = [...new Set(state.dice)];
    if (maxLength === 1 && state.dice.length === 2 && remainingValues.length === 2) {
      const high = Math.max(...remainingValues);
      const highDieSequences = best.filter(sequence => sequence[0]?.die === high);
      if (highDieSequences.length) best = highDieSequences;
    }
    return best;
  }

  function chooseBotSequence(state, color = state.turn, options = {}) {
    const difficulty = normalizeBotDifficulty(options.difficulty);
    const sequences = bestMoveSequences(state, color).filter(sequence => sequence.length);
    if (!sequences.length) return [];
    return sequences
      .map(sequence => ({ sequence, score: scoreSequence(state, color, sequence, difficulty) }))
      .sort((a, b) => b.score - a.score)[0]
      .sequence
      .map(move => ({ ...move }));
  }

  function normalizeBotDifficulty(value) {
    return value === 'hard' ? 'hard' : 'medium';
  }

  function checkersInTrackRange(state, color, start, end) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = pathPos(color, Number(point), state);
      return total + (pos >= start && pos <= end ? data.count : 0);
    }, 0);
  }

  function occupiedPointCount(state, color) {
    return Object.values(state.points).reduce((total, point) => (
      total + (point.color === color ? 1 : 0)
    ), 0);
  }

  function homeCheckersForScore(state, color) {
    return checkersInTrackRange(state, color, 18, 23) + (state.off[color] || 0);
  }

  function startZoneCount(state, color) {
    return checkersInTrackRange(state, color, 0, 5);
  }

  function madePointCountInTrackRange(state, color, start, end) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color || data.count < 2) return total;
      const pos = pathPos(color, Number(point), state);
      return total + (pos >= start && pos <= end ? 1 : 0);
    }, 0);
  }

  function outsideHomeCount(state, color) {
    return checkersInTrackRange(state, color, 0, 17);
  }

  function outsideHomePips(state, color) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = pathPos(color, Number(point), state);
      return total + (pos >= 0 && pos < 18 ? data.count * (18 - pos) : 0);
    }, 0);
  }

  function botStackPenalty(state, color) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = pathPos(color, Number(point), state);
      const excess = Math.max(0, data.count - (pos >= 18 ? 4 : 3));
      return total + excess * excess * (Number(point) === headPoint(color, state) ? 5 : 3);
    }, 0);
  }

  function blockControlScore(state, color) {
    const opponent = opponentOf(color);
    let run = 0;
    return pathFor(opponent, state).reduce((score, point, index) => {
      if (state.points[point]?.color === color) {
        run += 1;
        const zone = index < 12 ? 1.25 : index < 18 ? 1 : 0.55;
        return score + 5 * zone + run * run * 1.4;
      }
      run = 0;
      return score;
    }, 0);
  }

  function longHeadBridgeScore(state, color) {
    const head = headPoint(color, state);
    const headCheckers = pointCount(state, head);
    if (headCheckers <= 2) return 0;
    return pathFor(color, state).slice(1, 7).reduce((score, point, index) => {
      const data = state.points[point];
      if (data?.color !== color) return score;
      const weight = 7 - index;
      const made = data.count >= 2;
      const stackPenalty = Math.max(0, data.count - 3) * 0.7;
      return score + weight * (made ? 12 : 5) - stackPenalty;
    }, 0);
  }

  function opponentLongFenceThreat(state, color) {
    const opponent = opponentOf(color);
    const path = pathFor(color, state);
    let run = 0;
    let threat = 0;
    path.forEach((point, index) => {
      if (state.points[point]?.color === opponent) {
        run += 1;
        if (run >= 3) {
          const behind = path.slice(0, Math.max(0, index - run + 1))
            .reduce((total, p) => total + (state.points[p]?.color === color ? state.points[p].count : 0), 0);
          const zone = index < 12 ? 1.35 : index < 18 ? 1 : 0.65;
          threat += run * run * Math.max(1, behind) * zone;
        }
      } else {
        run = 0;
      }
    });
    return threat;
  }

  function longTrapRiskScore(state, color) {
    const opponent = opponentOf(color);
    const path = pathFor(color, state);
    let run = 0;
    let runStart = 0;
    let risk = 0;
    path.forEach((point, index) => {
      if (state.points[point]?.color === opponent) {
        if (run === 0) runStart = index;
        run += 1;
        if (run >= 3) {
          const ownBehind = path.slice(0, runStart)
            .reduce((total, p) => total + (state.points[p]?.color === color ? state.points[p].count : 0), 0);
          if (ownBehind > 0) {
            const inStartTrap = runStart <= 8 ? 1.45 : 1;
            const wall = run >= 6 ? 10 : run >= 5 ? 4.8 : run >= 4 ? 2.2 : 1;
            risk += ownBehind * run * run * wall * inStartTrap;
          }
        }
      } else {
        run = 0;
      }
    });
    return risk;
  }

  function longHeadEscapeOptions(state, color) {
    const head = headPoint(color, state);
    if (pointCount(state, head) <= 0) return 0;
    let options = 0;
    for (let die = 1; die <= 6; die += 1) {
      const to = moveTo(color, head, die, state);
      if (to && pointOpenFor(state, color, to)) options += state.points[to]?.color === color ? 2 : 1;
    }
    return options;
  }

  function longHeadLandingCoverageScore(state, color) {
    const head = headPoint(color, state);
    const headCheckers = pointCount(state, head);
    if (headCheckers <= 2) return 0;
    let score = 0;
    for (let die = 1; die <= 6; die += 1) {
      const to = moveTo(color, head, die, state);
      if (!to) continue;
      const data = state.points[to];
      const open = pointOpenFor(state, color, to);
      const weight = die >= 4 ? 18 : 10;
      if (data?.color === color) {
        score += weight * (data.count >= 2 ? 2.4 : 1.25);
      } else if (open) {
        score += weight * 0.35;
      } else {
        score -= weight * 1.8;
      }
    }
    return score;
  }

  function longHeadCorridorScore(state, color) {
    const head = headPoint(color, state);
    const headCheckers = pointCount(state, head);
    if (headCheckers <= 3) return 0;
    return pathFor(color, state).slice(1, 9).reduce((score, point, index) => {
      const data = state.points[point];
      const weight = 10 - index;
      if (!data) return score - weight * 5;
      if (data.color !== color) return score - weight * 18;
      const made = data.count >= 2;
      const tooTall = Math.max(0, data.count - 4);
      return score + weight * (made ? 18 : 7) - tooTall * weight * 2;
    }, 0);
  }

  function longFootholdScore(state, color) {
    return pathFor(color, state).slice(5, 12).reduce((score, point, index) => {
      const data = state.points[point];
      const weight = 8 - index;
      if (!data) return score - weight * 3.5;
      if (data.color !== color) return score - weight * 14;
      if (data.count >= 2) {
        const stackPenalty = Math.max(0, data.count - 3) * weight * 1.8;
        return score + weight * 24 - stackPenalty;
      }
      return score + weight * 7;
    }, 0);
  }

  function longPrematureRushScore(state, color) {
    return Object.entries(state.points).reduce((score, [point, data]) => {
      if (data.color !== color) return score;
      const pos = pathPos(color, Number(point), state);
      if (pos < 12 || pos >= 18) return score;
      const singlePenalty = data.count === 1 ? 2.6 : 1;
      return score + data.count * (pos - 10) * singlePenalty;
    }, 0);
  }

  function shortMadePointCount(state, color, rangeStart = 0, rangeEnd = 23) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color || data.count < 2) return total;
      const pos = pathPos(color, Number(point), state);
      return total + (pos >= rangeStart && pos <= rangeEnd ? 1 : 0);
    }, 0);
  }

  function shortPrimeScore(state, color) {
    const opponent = opponentOf(color);
    let run = 0;
    return pathFor(opponent, state).reduce((score, point, index) => {
      const made = state.points[point]?.color === color && state.points[point]?.count >= 2;
      if (!made) {
        run = 0;
        return score;
      }
      run += 1;
      const zone = index < 6 ? 1.35 : index < 18 ? 1 : 0.65;
      return score + run * run * 4.5 * zone;
    }, 0);
  }

  function shortCanBeHit(state, color, point) {
    const opponent = opponentOf(color);
    const target = Number(point);
    if ((state.bar?.[opponent] || 0) > 0) {
      for (let die = 1; die <= 6; die += 1) {
        if (moveTo(opponent, barPoint(opponent), die, state) === target) return true;
      }
      return false;
    }
    return Object.entries(state.points).some(([from, data]) => {
      if (data.color !== opponent) return false;
      for (let die = 1; die <= 6; die += 1) {
        if (moveTo(opponent, Number(from), die, state) === target) return true;
      }
      return false;
    });
  }

  function shortBlotExposureScore(state, color) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color || data.count !== 1) return total;
      const pos = pathPos(color, Number(point), state);
      let risk = pos >= 18 ? 18 : pos <= 5 ? 10 : 13;
      if (shortCanBeHit(state, color, Number(point))) risk += pos >= 18 ? 68 : 42;
      if (homeReady(state, color)) risk += 25;
      return total + risk;
    }, 0);
  }

  function shortBoardStrengthScore(state, color) {
    const opponent = opponentOf(color);
    const homeMade = shortMadePointCount(state, color, 18, 23);
    const homeCheckers = checkersInTrackRange(state, color, 18, 23);
    const opponentOnBar = state.bar?.[opponent] || 0;
    return homeMade * 28 + homeCheckers * 1.8 + opponentOnBar * (42 + homeMade * 18);
  }

  function scoreShortSequence(state, color, sequence, difficulty = 'medium') {
    const hard = difficulty === 'hard';
    const next = cloneState(state);
    const opponent = opponentOf(color);
    const beforePips = pipsFor(state, color);
    const beforeOpponentPips = pipsFor(state, opponent);
    const beforeExposure = shortBlotExposureScore(state, color);
    const beforeOpponentExposure = shortBlotExposureScore(state, opponent);
    const beforeMade = shortMadePointCount(state, color);
    const beforeHomeMade = shortMadePointCount(state, color, 18, 23);
    const beforePrime = shortPrimeScore(state, color);
    const beforeBoard = shortBoardStrengthScore(state, color);
    let score = 0;

    sequence.forEach(move => {
      const target = move.bearOff ? null : next.points[move.to];
      const fromBar = isBarPointFor(color, move.from);
      const fromPos = fromBar ? -1 : pathPos(color, move.from, next);
      const toPos = move.bearOff ? 24 : pathPos(color, move.to, next);
      const hit = !move.bearOff && target?.color === opponent && target.count === 1;

      if (fromBar) score += hard ? 260 : 120;
      if (move.bearOff) {
        score += hard ? 260 + move.die * 8 : 120 + move.die * 4;
      } else {
        if (hit) score += hard ? 210 + Math.max(0, 18 - toPos) * 5 : 95;
        if (!target) score += hard ? 20 : 8;
        else if (target.color === color) {
          score += target.count === 1 ? (hard ? 78 : 34) : -(target.count > 4 ? (target.count - 4) * 12 : 0);
        }
        if (toPos >= 18) score += hard ? 30 : 12;
        if (fromPos >= 0 && fromPos <= 5 && toPos > fromPos) score += hard ? 18 : 7;
        score += move.die * (hard ? 5 : 3);
      }
      commitMove(next, color, move);
    });

    const pipsGain = beforePips - pipsFor(next, color);
    const opponentPipsGain = beforeOpponentPips - pipsFor(next, opponent);
    const exposureGain = beforeExposure - shortBlotExposureScore(next, color);
    const opponentExposureGain = shortBlotExposureScore(next, opponent) - beforeOpponentExposure;
    const madeGain = shortMadePointCount(next, color) - beforeMade;
    const homeMadeGain = shortMadePointCount(next, color, 18, 23) - beforeHomeMade;
    const primeGain = shortPrimeScore(next, color) - beforePrime;
    const boardGain = shortBoardStrengthScore(next, color) - beforeBoard;

    score += pipsGain * (hard ? 3.3 : 1.8);
    score -= opponentPipsGain * (hard ? 1.4 : 0.5);
    score += exposureGain * (hard ? 2.8 : 1.1);
    score += opponentExposureGain * (hard ? 1.1 : 0.4);
    score += madeGain * (hard ? 38 : 16);
    score += homeMadeGain * (hard ? 72 : 28);
    score += primeGain * (hard ? 1.8 : 0.8);
    score += boardGain * (hard ? 1.35 : 0.55);
    score -= (next.bar?.[color] || 0) * (hard ? 260 : 120);
    score += (next.bar?.[opponent] || 0) * (hard ? 120 : 42);
    score += ((next.off[color] || 0) - (state.off[color] || 0)) * (hard ? 230 : 110);
    if (homeReady(next, color)) score += hard ? 70 + (next.off[color] || 0) * 65 : 30;
    score -= stackPenalty(next, color) * (hard ? 1.2 : 0.5);
    if (hard) {
      score += hardMarsEmergencyScore(state, next, color);
      score += hardKoksEmergencyScore(state, next, color);
    }
    return score;
  }

  function koksRiskScore(state, color) {
    const opponent = opponentOf(color);
    const ownStart = startZoneCount(state, color);
    if (!ownStart) return 0;
    const opponentThreat = finishPressureScore(state, opponent);
    const ownEscape = (state.off[color] || 0) * 24 + homeCheckersForScore(state, color) * 1.8;
    const danger = Math.max(0, opponentThreat - ownEscape - 28);
    const noCheckerOff = (state.off[color] || 0) === 0 ? 85 : 0;
    return ownStart * danger * 1.15 + noCheckerOff * Math.min(1, danger / 40);
  }

  function finishPressureScore(state, color) {
    const pips = pipsFor(state, color);
    const off = state.off[color] || 0;
    const home = homeCheckersForScore(state, color);
    let pressure = off * 22 + home * 2.4 + Math.max(0, 95 - pips) * 3;
    if (homeReady(state, color)) pressure += 80;
    return pressure;
  }

  function longSequenceFeatures(state, color, sequence) {
    const preview = cloneState(state);
    const head = headPoint(color, state);
    let headMoves = 0;
    let emptyHeadLandings = 0;
    let coveredHeadLandings = 0;
    let enterHomeMoves = 0;
    let outsideMovePips = 0;
    let homeInternalMoves = 0;
    let headCorridorExits = 0;
    let headCorridorMoves = 0;
    let prematureRushMoves = 0;
    let footholdBuildMoves = 0;

    sequence.forEach(move => {
      const fromHead = move.from === head;
      const target = move.bearOff ? null : preview.points[move.to];
      const fromPos = isBarPointFor(color, move.from) ? -1 : pathPos(color, move.from, preview);
      const toPos = move.bearOff ? 24 : pathPos(color, move.to, preview);

      if (fromHead) {
        headMoves += 1;
        if (!move.bearOff && !target) emptyHeadLandings += 1;
        if (!move.bearOff && target?.color === color && target.count === 1) coveredHeadLandings += 1;
      }
      if (fromPos >= 0 && fromPos < 18) {
        outsideMovePips += Math.max(0, Math.min(18, toPos) - fromPos);
        if (toPos >= 18) enterHomeMoves += 1;
      }
      if (fromPos >= 1 && fromPos <= 8) {
        if (toPos > 8) headCorridorExits += 1 + Math.max(0, toPos - 8) / 4;
        else headCorridorMoves += 1;
      }
      if (fromPos >= 5 && fromPos <= 11 && toPos >= 12 && toPos < 18) {
        prematureRushMoves += 1 + Math.max(0, toPos - 12) / 3;
      }
      if (toPos >= 5 && toPos <= 11 && target?.color === color && target.count === 1) {
        footholdBuildMoves += 1;
      }
      if (fromPos >= 18 && toPos >= 18 && !move.bearOff) {
        homeInternalMoves += 1 + Math.max(0, toPos - fromPos) / 6;
      }
      commitMove(preview, color, move);
    });

    return {
      headMoves,
      emptyHeadLandings,
      coveredHeadLandings,
      enterHomeMoves,
      outsideMovePips,
      homeInternalMoves,
      headCorridorExits,
      headCorridorMoves,
      prematureRushMoves,
      footholdBuildMoves,
    };
  }

  function hasLegalHeadMove(state, color) {
    const head = headPoint(color, state);
    return legalNextMoves(state, color).some(move => move.from === head);
  }

  function hasLegalOutsideProgress(state, color) {
    return legalNextMoves(state, color).some(move => {
      const fromPos = pathPos(color, move.from, state);
      if (fromPos < 0 || fromPos >= 18) return false;
      if (move.bearOff) return true;
      const toPos = pathPos(color, move.to, state);
      return toPos > fromPos;
    });
  }

  function hardKoksEmergencyActive(state, color) {
    return (state.off[color] || 0) === 0
      && finishPressureScore(state, opponentOf(color)) >= 135;
  }

  function hardKoksEmergencyScore(state, next, color) {
    if (!hardKoksEmergencyActive(state, color)) return 0;

    const beforeStart = startZoneCount(state, color);
    const afterStart = startZoneCount(next, color);
    const startReduction = beforeStart - afterStart;
    const homeGain = homeCheckersForScore(next, color) - homeCheckersForScore(state, color);
    const offGain = (next.off[color] || 0) - (state.off[color] || 0);
    const safeFromKoks = afterStart === 0 || (next.off[color] || 0) > 0;

    let score = 0;
    score += offGain * 220000;
    score += startReduction * 46000;
    score -= afterStart * 22000;
    score += homeGain * (startReduction > 0 || offGain > 0 ? 4200 : -6800);
    score += safeFromKoks ? 70000 : 0;
    score -= pipsFor(next, color) * 35;
    return score;
  }

  function marsRiskScore(state, color) {
    if ((state.off[color] || 0) > 0) return 0;
    const opponentPressure = finishPressureScore(state, opponentOf(color));
    const ownPressure = finishPressureScore(state, color);
    return Math.max(0, opponentPressure - ownPressure * 0.55 - 90);
  }

  function hardMarsEmergencyScore(state, next, color) {
    const risk = marsRiskScore(state, color);
    if (risk <= 0) return 0;

    const beforeOutside = outsideHomeCount(state, color);
    const afterOutside = outsideHomeCount(next, color);
    const outsideReduction = beforeOutside - afterOutside;
    const homeGain = homeCheckersForScore(next, color) - homeCheckersForScore(state, color);
    const offGain = (next.off[color] || 0) - (state.off[color] || 0);
    const pipsGain = pipsFor(state, color) - pipsFor(next, color);
    const outsideProgress = outsideHomePips(state, color) - outsideHomePips(next, color);
    const riskReduction = risk - marsRiskScore(next, color);
    const urgency = Math.min(2.2, 1 + risk / 220);

    let score = 0;
    score += offGain * 320000;
    score += outsideReduction * 52000;
    score -= afterOutside * 19000;
    score += outsideProgress * 28000;
    score -= outsideHomePips(next, color) * 3600;
    score += homeGain * (outsideReduction > 0 || offGain > 0 ? 8200 : -7200);
    score += pipsGain * 1700;
    score += riskReduction * 1800;
    score += homeReady(next, color) ? 90000 : 0;
    if (homeReady(next, color)) score -= farthestFromOff(next, color) * 4200;
    return score * urgency;
  }

  function hardMarsSurvivalScore(state, next, color, features = {}) {
    if ((state.off[color] || 0) > 0) return 0;
    const opponent = opponentOf(color);
    const opponentPressure = finishPressureScore(state, opponent);
    const opponentOff = state.off[opponent] || 0;
    const urgency = Math.max(
      0,
      opponentPressure - 92,
      opponentOff * 38,
      marsRiskScore(state, color) * 1.8,
      homeReady(state, opponent) ? 130 : 0,
    );
    if (urgency <= 0) return 0;

    const beforeOutside = outsideHomeCount(state, color);
    const afterOutside = outsideHomeCount(next, color);
    const outsideReduction = beforeOutside - afterOutside;
    const outsideProgress = outsideHomePips(state, color) - outsideHomePips(next, color);
    const offGain = (next.off[color] || 0) - (state.off[color] || 0);
    const canProgressOutside = hasLegalOutsideProgress(state, color);
    const readyBefore = homeReady(state, color);
    const readyAfter = homeReady(next, color);

    let score = 0;
    score += offGain * (520000 + urgency * 1800);
    if (readyBefore) {
      if (offGain <= 0) score -= 180000 + urgency * 1450;
      score -= (features.homeInternalMoves || 0) * (52000 + urgency * 220);
      score -= farthestFromOff(next, color) * (5200 + urgency * 18);
      return score;
    }

    score += outsideReduction * (98000 + urgency * 720);
    score += outsideProgress * (10500 + urgency * 95);
    score -= afterOutside * (26000 + urgency * 160);
    if (readyAfter) score += 240000 + urgency * 1200;
    if (canProgressOutside && outsideProgress <= 0) score -= 125000 + urgency * 900;
    if (beforeOutside > 0 && outsideReduction <= 0) {
      score -= (features.enterHomeMoves || 0) * (28000 + urgency * 180);
      score -= (features.homeInternalMoves || 0) * (52000 + urgency * 260);
    }
    return score;
  }

  function scoreMediumSequence(state, color, sequence) {
    const next = cloneState(state);
    let score = 0;
    sequence.forEach(move => {
      if (move.bearOff) score += 90 + move.die;
      else {
        const target = next.points[move.to];
        const headBefore = pointCount(next, headPoint(color, state));
        if (target?.color === color) score += 8;
        if (!target) score += 5;
        score += move.from === headPoint(color, state) && headBefore > 8 ? 8 : -2;
        score += move.die * 4;
      }
      commitMove(next, color, move);
    });
    score += (pipsFor(state, color) - pipsFor(next, color)) * 1.45;
    score += (madePointCount(next, color) - madePointCount(state, color)) * 12;
    score += (startZoneCount(state, color) - startZoneCount(next, color)) * 5;
    score -= stackPenalty(next, color);
    return score;
  }

  function scoreSequence(state, color, sequence, difficulty = 'medium') {
    if (isShort(state)) return scoreShortSequence(state, color, sequence, difficulty);

    const hard = difficulty === 'hard';
    if (!hard) return scoreMediumSequence(state, color, sequence);

    const next = cloneState(state);
    const opponent = opponentOf(color);
    const headBefore = pointCount(state, headPoint(color, state));
    const outsideBefore = outsideHomeCount(state, color);
    const outsidePipsBefore = outsideHomePips(state, color);
    const madeOutsideBefore = madePointCountInTrackRange(state, color, 0, 17);
    const startBefore = startZoneCount(state, color);
    const marsRiskBefore = marsRiskScore(state, color);
    const koksRiskBefore = koksRiskScore(state, color);
    const bridgeBefore = longHeadBridgeScore(state, color);
    const fenceBefore = opponentLongFenceThreat(state, color);
    const trapBefore = longTrapRiskScore(state, color);
    const footholdBefore = longFootholdScore(state, color);
    const rushBefore = longPrematureRushScore(state, color);
    const escapeOptionsBefore = longHeadEscapeOptions(state, color);
    const landingCoverageBefore = longHeadLandingCoverageScore(state, color);
    const corridorBefore = longHeadCorridorScore(state, color);
    let score = 0;
    sequence.forEach(move => {
      const target = move.bearOff ? null : next.points[move.to];
      const fromPos = pathPos(color, move.from, next);
      const toPos = move.bearOff ? 24 : pathPos(color, move.to, next);
      const headBefore = pointCount(next, headPoint(color, state));

      if (move.bearOff) score += 190 + move.die * 3;
      else {
        if (!target) score += move.from === headPoint(color, state) && headBefore > 6 ? -18 : 10;
        else if (target.color === color) score += target.count <= 1 ? 92 : -Math.min(22, (target.count - 1) * 5);
        if (move.from === headPoint(color, state)) score += 18 + Math.min(36, headBefore * 2);
        else if (fromPos >= 0 && fromPos <= 5) score += 14;
        if (toPos >= 18) score += 16;
        score += move.die * 6;
      }
      commitMove(next, color, move);
    });
    score += (pipsFor(state, color) - pipsFor(next, color)) * 3;
    score += ((next.off[color] || 0) - (state.off[color] || 0)) * 170;
    score -= ((next.off[opponent] || 0) - (state.off[opponent] || 0)) * 70;
    score += (occupiedPointCount(next, color) - occupiedPointCount(state, color)) * 7;
    score += (madePointCount(next, color) - madePointCount(state, color)) * 10;
    score += (blockControlScore(next, color) - blockControlScore(state, color)) * 0.45;
    score -= (botStackPenalty(next, color) - botStackPenalty(state, color)) * 1.15;
    score += (startZoneCount(state, color) - startZoneCount(next, color)) * 14;
    score -= startZoneCount(next, color) * 2.2;
    const features = longSequenceFeatures(state, color, sequence);
    const outsideAfter = outsideHomeCount(next, color);
    const outsideReduction = outsideBefore - outsideAfter;
    const outsidePipsGain = outsidePipsBefore - outsideHomePips(next, color);
    const madeOutsideGain = madePointCountInTrackRange(next, color, 0, 17) - madeOutsideBefore;
    const startReduction = startBefore - startZoneCount(next, color);
    const headReduction = headBefore - pointCount(next, headPoint(color, state));
    const finishPressure = finishPressureScore(state, opponent);
    const koksUrgency = (state.off[color] || 0) === 0 && startBefore > 0
      ? Math.max(0, finishPressure - 95)
      : 0;
    const canPlayHead = hasLegalHeadMove(state, color);
    const headUrgency = Math.max(0, headBefore - 3);
    const startUrgency = Math.max(0, startBefore - 5);
    const gammonUrgency = Math.max(marsRiskBefore * 0.08, koksRiskBefore * 0.055, koksUrgency * 0.12);
    const bridgeAfter = longHeadBridgeScore(next, color);
    const fenceAfter = opponentLongFenceThreat(next, color);
    const trapAfter = longTrapRiskScore(next, color);
    const trapIncrease = trapAfter - trapBefore;
    const footholdAfter = longFootholdScore(next, color);
    const footholdGain = footholdAfter - footholdBefore;
    const rushAfter = longPrematureRushScore(next, color);
    const rushIncrease = rushAfter - rushBefore;
    const escapeOptionsAfter = longHeadEscapeOptions(next, color);
    const landingCoverageAfter = longHeadLandingCoverageScore(next, color);
    const corridorAfter = longHeadCorridorScore(next, color);
    const headLocked = headBefore > 5 && (state.off[color] || 0) === 0;
    const criticalHeadLocked = headBefore > 8 && (state.off[color] || 0) === 0;
    const lateHeadDutyActive = canPlayHead
      && headBefore > 1
      && (state.off[color] || 0) === 0
      && (finishPressure > 80 || outsideBefore > 0 || marsRiskBefore > 0 || koksRiskBefore > 0);
    const headDutyActive = canPlayHead
      && (state.off[color] || 0) === 0
      && (headBefore > 4 || lateHeadDutyActive);
    const headDutyUrgency = Math.max(0, headBefore - 1) * (lateHeadDutyActive ? 9400 : 6200)
      + Math.max(0, finishPressure - 105) * 360
      + marsRiskBefore * 420
      + koksRiskBefore * 260
      + Math.max(0, fenceBefore - 18) * 520;

    score += outsideReduction * 780;
    score += outsidePipsGain * 42;
    score += features.enterHomeMoves * (headBefore > 7 ? -420 : (headBefore > 4 ? 60 : 980));
    score += features.outsideMovePips * 58;
    score += madeOutsideGain * 145;
    score += features.coveredHeadLandings * (headBefore > 7 ? 920 : 260);
    score -= features.emptyHeadLandings * (headBefore > 7 ? 380 : 90);
    score += features.headMoves * (900 + headUrgency * 420 + startUrgency * 260 + gammonUrgency * 140);
    if (lateHeadDutyActive) score += features.headMoves * (22000 + headBefore * 5200);
    score += headReduction * (headBefore > 8 ? 1450 : (lateHeadDutyActive ? 24000 : 420));
    score += (bridgeAfter - bridgeBefore) * (headBefore > 5 ? 1350 : 260);
    score += (escapeOptionsAfter - escapeOptionsBefore) * (headBefore > 5 ? 1150 : 360);
    score += (landingCoverageAfter - landingCoverageBefore) * (headBefore > 5 ? 720 : 180);
    score += (corridorAfter - corridorBefore) * (headBefore > 5 ? 1650 : 220);
    score += (trapBefore - trapAfter) * 2600;
    score -= Math.max(0, trapIncrease) * 9800;
    score -= trapAfter * (headBefore > 4 || outsideAfter > 0 ? 340 : 60);
    score += footholdGain * (headBefore > 4 && (state.off[color] || 0) === 0 ? 2600 : 420);
    score += features.footholdBuildMoves * (headBefore > 4 ? 16000 : 3200);
    if (headBefore > 4 && (state.off[color] || 0) === 0) {
      score -= Math.max(0, rushIncrease) * 21000;
      score -= features.prematureRushMoves * (18000 + Math.max(0, 44 - footholdAfter) * 620);
      score -= rushAfter * Math.max(0, 52 - footholdAfter) * 260;
    }
    if (headBefore > 5) {
      score += bridgeAfter * 95;
      score += escapeOptionsAfter * 180;
      score += landingCoverageAfter * 42;
      score += corridorAfter * 120;
    }
    score -= Math.max(0, 4 - escapeOptionsAfter) * Math.max(0, headBefore - 4) * 420;
    score -= Math.max(0, fenceAfter - fenceBefore) * (headBefore > 4 ? 240 : 90);
    score -= fenceAfter * Math.max(0, headBefore - 5) * 18;
    if (headLocked) {
      score -= features.headCorridorExits * (criticalHeadLocked ? 8200 : 3600);
      score += features.headCorridorMoves * (criticalHeadLocked ? 950 : 420);
    }
    if (canPlayHead && features.headMoves === 0 && (headBefore > 3 || lateHeadDutyActive)) {
      score -= 5200 + headUrgency * 1350 + startUrgency * 720 + gammonUrgency * 520;
      if (lateHeadDutyActive) score -= 36000 + headDutyUrgency;
    }
    if (headDutyActive) {
      if (features.headMoves === 0) {
        score -= 42000 + headDutyUrgency;
        score -= features.enterHomeMoves * 17500;
        score -= features.homeInternalMoves * 22000;
        if (outsideReduction <= 0) score -= 18000 + Math.max(0, headBefore - 6) * 9000;
      } else {
        score += features.headMoves * (18000 + Math.max(0, headBefore - 6) * 4200);
        score += headReduction * (22000 + Math.max(0, headBefore - 7) * 5200);
        score += features.coveredHeadLandings * 5200;
      }
    }
    if (features.headMoves === 0 && headBefore > 6) {
      score -= features.enterHomeMoves * Math.max(0, headBefore - 6) * 980;
    }
    if (headBefore > 5 && bridgeAfter <= bridgeBefore) {
      score -= features.enterHomeMoves * Math.max(1, headBefore - 5) * 720;
    }
    if (headBefore > 5 && footholdAfter < footholdBefore + 8) {
      score -= features.enterHomeMoves * Math.max(1, headBefore - 5) * 5200;
    }
    if (criticalHeadLocked && corridorAfter < corridorBefore) {
      score -= (corridorBefore - corridorAfter) * 4200;
    }
    if (criticalHeadLocked && features.headMoves === 0 && features.headCorridorExits > 0) {
      score -= 18000 + features.headCorridorExits * 9000;
    }
    score += startReduction * (koksUrgency > 0 ? 220 + koksUrgency * 68 : 55);
    if (outsideAfter > 0) {
      const homeShufflePenalty = marsRiskBefore > 0 || koksRiskBefore > 0 ? 15500 : 2600;
      score -= features.homeInternalMoves * homeShufflePenalty;
      score -= outsideHomePips(next, color) * (marsRiskBefore > 0 ? 560 : 24);
      if (trapBefore > 0 || trapAfter > 0) {
        score -= features.enterHomeMoves * (9000 + trapAfter * 180);
        score -= features.homeInternalMoves * (11000 + trapAfter * 220);
      }
    }
    if (outsideBefore > 0 && outsideReduction <= 0 && features.homeInternalMoves > 0) {
      score -= 8500 + features.homeInternalMoves * 3800;
    }
    score += hardMarsEmergencyScore(state, next, color);
    score += hardMarsSurvivalScore(state, next, color, features);
    score += hardKoksEmergencyScore(state, next, color);
    score += (koksRiskScore(state, color) - koksRiskScore(next, color)) * 0.85;
    score -= koksRiskScore(next, color) * 0.9;
    if (homeReady(next, color)) score += (next.off[color] || 0) * 55;
    score -= stackPenalty(next, color) * 0.35;
    return score;
  }

  function endTurn(state) {
    normalizeState(state);
    const previous = state.turn;
    state.dice = [];
    state.rolled = [];
    state.turnMoves = [];
    state.headPlayedThisTurn = { white: false, dark: false };
    state.firstMoveDone[previous] = true;
    state.turn = opponentOf(previous);
    state.phase = state.winner ? 'over' : 'roll';
  }

  function violatesLongBlockRuleDuringMove(state, color, from, to, bearOff) {
    if (bearOff) return false;
    const preview = previewMovePoints(state, color, from, to, false);
    return violatesLongBlockRule(preview, color, state.off, state);
  }

  function violatesLongBlockRule(points, color, off = { white: 0, dark: 0 }, stateOrVariant = 'long') {
    const opponent = opponentOf(color);
    const opponentPath = pathFor(opponent, stateOrVariant);
    const opponentOnBoard = Object.values(points).reduce((total, point) => (
      total + (point.color === opponent ? point.count : 0)
    ), 0);
    if (opponentOnBoard + (off[opponent] || 0) < 15) return false;
    if (opponentOnBoard < 15) return false;

    for (let start = 0; start <= opponentPath.length - 6; start += 1) {
      const block = opponentPath.slice(start, start + 6);
      const ownBlock = block.every(point => points[point]?.color === color);
      if (!ownBlock) continue;
      const hasOpponentAhead = opponentPath.slice(start + 6).some(point => points[point]?.color === opponent);
      if (!hasOpponentAhead) return true;
    }
    return false;
  }

  function previewMovePoints(state, color, from, to, bearOff) {
    const points = clonePoints(state.points);
    points[from].count -= 1;
    if (points[from].count === 0) delete points[from];
    if (!bearOff) {
      if (!points[to]) points[to] = { color, count: 0 };
      points[to].count += 1;
    }
    return points;
  }

  function resultTypeFor(state, winner) {
    const loser = opponentOf(winner);
    if (state.off[loser] > 0) return null;
    if (isShort(state)) {
      const winnerHome = new Set(pathFor(winner, state).slice(18));
      const hasCheckerInWinnerHome = Object.entries(state.points).some(([point, data]) => (
        data.color === loser && winnerHome.has(Number(point))
      ));
      return (state.bar?.[loser] || 0) > 0 || hasCheckerInWinnerHome ? 'koks' : 'mars';
    }
    const loserStart = new Set(pathFor(loser, state).slice(0, 6));
    const hasCheckerInStart = Object.entries(state.points).some(([point, data]) => (
      data.color === loser && loserStart.has(Number(point))
    ));
    return hasCheckerInStart ? 'koks' : 'mars';
  }

  function pipsFor(state, color) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      return total + data.count * Math.max(0, 24 - pathPos(color, Number(point), state));
    }, (state.bar?.[color] || 0) * 25);
  }

  function madePointCount(state, color) {
    return Object.values(state.points).reduce((total, point) => (
      total + (point.color === color && point.count >= 2 ? 1 : 0)
    ), 0);
  }

  function stackPenalty(state, color) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color || data.count <= 5) return total;
      const pos = pathPos(color, Number(point), state);
      return total + (data.count - 5) * (pos < 18 ? 4 : 1.2);
    }, 0);
  }

  function clonePoints(points) {
    return Object.fromEntries(Object.entries(points).map(([point, data]) => [point, { ...data }]));
  }

  function cloneState(state) {
    return {
      ...state,
      variant: normalizeVariant(state.variant),
      points: clonePoints(state.points),
      bar: { white: 0, dark: 0, ...(state.bar || {}) },
      off: { ...state.off },
      score: { ...state.score },
      dice: [...state.dice],
      rolled: [...state.rolled],
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      turnClock: { ...state.turnClock },
      matchScore: { ...state.matchScore },
      openingRoll: state.openingRoll ? {
        ...state.openingRoll,
        host: { ...state.openingRoll.host },
        guest: { ...state.openingRoll.guest },
      } : null,
      turnMoves: (state.turnMoves || []).map(move => ({ ...move })),
      firstMoveDone: { ...state.firstMoveDone },
      headPlayedThisTurn: { ...state.headPlayedThisTurn },
      history: (state.history || []).map(item => ({ ...item })),
    };
  }

  function normalizeState(state) {
    state.variant = normalizeVariant(state.variant);
    state.points ||= {};
    state.bar ||= { white: 0, dark: 0 };
    state.bar.white = Number(state.bar.white) || 0;
    state.bar.dark = Number(state.bar.dark) || 0;
    state.off ||= { white: 0, dark: 0 };
    state.score ||= { white: 0, dark: 0 };
    state.dice ||= [];
    state.rolled ||= [];
    state.startedAt ||= Date.now();
    state.finishedAt ||= null;
    state.turnClock ||= { white: 0, dark: 0, active: null, startedAt: null };
    state.turnClock.white = Number(state.turnClock.white) || 0;
    state.turnClock.dark = Number(state.turnClock.dark) || 0;
    state.turnClock.active = state.turnClock.active === 'white' || state.turnClock.active === 'dark'
      ? state.turnClock.active
      : null;
    state.turnClock.startedAt = Number(state.turnClock.startedAt) || null;
    state.matchScore ||= { white: 0, dark: 0, target: 5, recordedWinner: null };
    state.matchScore.white = Number(state.matchScore.white) || 0;
    state.matchScore.dark = Number(state.matchScore.dark) || 0;
    state.matchScore.target = Number(state.matchScore.target) || 5;
    state.matchScore.recordedWinner ||= null;
    state.openingRoll ||= null;
    state.turnMoves ||= [];
    state.firstMoveDone ||= { white: false, dark: false };
    state.headPlayedThisTurn ||= { white: false, dark: false };
    state.history ||= [];
    state.phase ||= state.winner ? 'over' : (state.dice.length ? 'move' : 'roll');
    return state;
  }

  return {
    initialState,
    rollDice,
    decideOpeningRoll,
    startOpeningTurn,
    applyRoll,
    applyMove,
    isValidMove,
    legalDestinations,
    legalNextMoves,
    bestMoveSequences,
    chooseBotSequence,
    hasAnyMoves,
    basicLegalMove,
    canBearOffFrom,
    pointColor,
    pointCount,
    allInHome,
    homeReady,
    moveTo,
    pointToTrack,
    trackToPoint,
    pathFor,
    pathPos,
    barPoint,
    pipsFor,
    opponentOf,
    endTurn,
    headPoint,
    farthestFromOff,
  };
})();
