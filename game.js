/* ------------------------------------------------------------------
   game.js - Long Backgammon rules engine.
   Rules are adapted from the backgammon-web server algorithm.
   Exposes: window.NarduGame
   ------------------------------------------------------------------ */

window.NarduGame = (function () {
  const WHITE_PATH = [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const DARK_PATH = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13];

  function initialState() {
    return {
      points: {
        24: { color: 'white', count: 15 },
        12: { color: 'dark', count: 15 },
      },
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

  function pathFor(color) {
    return color === 'white' ? WHITE_PATH : DARK_PATH;
  }

  function opponentOf(color) {
    return color === 'white' ? 'dark' : 'white';
  }

  function pathPos(color, point) {
    return pathFor(color).indexOf(Number(point));
  }

  function pointToTrack(color, point) {
    return pathPos(color, point);
  }

  function trackToPoint(color, track) {
    return pathFor(color)[track] || 0;
  }

  function moveTo(color, fromPoint, distance) {
    const pos = pathPos(color, fromPoint);
    if (pos < 0) return 0;
    const next = pos + distance;
    return next >= 24 ? 0 : pathFor(color)[next];
  }

  function pointColor(state, point) {
    return state.points[point]?.color || null;
  }

  function pointCount(state, point) {
    return state.points[point]?.count || 0;
  }

  function headPoint(color) {
    return pathFor(color)[0];
  }

  function allInHome(state, color) {
    return homeReady(state, color);
  }

  function homeReady(state, color) {
    const home = new Set(pathFor(color).slice(18));
    return Object.entries(state.points).every(([point, data]) => (
      data.color !== color || home.has(Number(point))
    ));
  }

  function canBearOffFrom(state, color, from, die) {
    if (!homeReady(state, color)) return false;
    const pos = pathPos(color, from);
    if (pos < 18) return false;
    const exact = 24 - pos;
    if (die === exact) return true;
    if (die < exact) return false;
    const path = pathFor(color);
    return !path.slice(18, pos).some(point => state.points[point]?.color === color);
  }

  function farthestFromOff(state, color) {
    let maxDist = 0;
    Object.entries(state.points).forEach(([point, data]) => {
      if (data.color !== color) return;
      const pos = pathPos(color, Number(point));
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
    return !target || target.color === color;
  }

  function moveSources(state, color) {
    return Object.entries(state.points)
      .filter(([, data]) => data.color === color)
      .map(([point]) => Number(point));
  }

  function basicLegalMove(state, color, from, to, dieIndex = null) {
    normalizeState(state);
    if (state.phase !== 'move' || state.turn !== color || !state.dice.length || state.winner) {
      return { ok: false, message: 'Сейчас нельзя ходить.' };
    }

    const source = state.points[from];
    if (!source || source.color !== color || source.count < 1) {
      return { ok: false, message: 'Выберите свою шашку.' };
    }

    const bearOff = to === 0 || to < 1 || to > 24;
    const indexes = dieIndex === null ? state.dice.map((_, index) => index) : [dieIndex];
    const matchedIndex = indexes.find(index => {
      const value = state.dice[index];
      const dest = moveTo(color, from, value);
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
    if (!bearOff && moveTo(color, from, die) !== to) {
      return { ok: false, message: 'Ход должен идти по маршруту длинных нард.' };
    }

    if (from === headPoint(color)) {
      const used = state.turnMoves.filter(move => move.from === from).length;
      if (used >= headMoveLimit(state, color)) {
        return { ok: false, message: 'С головы можно взять только одну шашку за ход.' };
      }
    }

    if (!bearOff) {
      if (!pointOpenFor(state, color, to)) {
        return { ok: false, message: 'Пункт закрыт соперником.' };
      }
      if (violatesLongBlockRuleDuringMove(state, color, from, to, false)) {
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
        const dest = moveTo(color, from, die);
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
    const to = moveTo(color, from, die);
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
      const to = moveTo(color, from, value);
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
    const source = state.points[move.from];
    source.count -= 1;
    if (source.count === 0) delete state.points[move.from];

    if (move.bearOff) {
      state.off[color] += 1;
      state.score[color] += 24 - pathPos(color, move.from);
    } else {
      if (!state.points[move.to]) state.points[move.to] = { color, count: 0 };
      state.points[move.to].count += 1;
      state.score[color] += move.die;
    }

    const removeIndex = Number.isInteger(move.dieIndex) && state.dice[move.dieIndex] === move.die
      ? move.dieIndex
      : state.dice.indexOf(move.die);
    if (removeIndex !== -1) state.dice.splice(removeIndex, 1);

    state.turnMoves.push({ color, from: move.from, to: move.to, die: move.die, bearOff: move.bearOff });
    if (move.from === headPoint(color)) state.headPlayedThisTurn[color] = true;

    if (state.off[color] >= 15) {
      state.winner = color;
      state.resultType = resultTypeFor(state, color);
      state.phase = 'over';
    }
  }

  function rawMoveSequences(state, color) {
    normalizeState(state);
    if (!state.dice.length || state.winner || state.phase !== 'move') return [[]];
    const moves = legalNextMoves(state, color);
    if (!moves.length) return [[]];

    const sequences = [];
    for (const move of moves) {
      const next = cloneState(state);
      commitMove(next, color, move);
      for (const tail of rawMoveSequences(next, color)) {
        sequences.push([move, ...tail]);
      }
    }
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
      const pos = pathPos(color, Number(point));
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

  function botStackPenalty(state, color) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = pathPos(color, Number(point));
      const excess = Math.max(0, data.count - (pos >= 18 ? 4 : 3));
      return total + excess * excess * (Number(point) === headPoint(color) ? 5 : 3);
    }, 0);
  }

  function blockControlScore(state, color) {
    const opponent = opponentOf(color);
    let run = 0;
    return pathFor(opponent).reduce((score, point, index) => {
      if (state.points[point]?.color === color) {
        run += 1;
        const zone = index < 12 ? 1.25 : index < 18 ? 1 : 0.55;
        return score + 5 * zone + run * run * 1.4;
      }
      run = 0;
      return score;
    }, 0);
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
    score += homeGain * 5200;
    score += safeFromKoks ? 70000 : 0;
    score -= pipsFor(next, color) * 35;
    return score;
  }

  function scoreMediumSequence(state, color, sequence) {
    const next = cloneState(state);
    let score = 0;
    sequence.forEach(move => {
      if (move.bearOff) score += 90 + move.die;
      else {
        const target = next.points[move.to];
        const headBefore = pointCount(next, headPoint(color));
        if (target?.color === color) score += 8;
        if (!target) score += 5;
        score += move.from === headPoint(color) && headBefore > 8 ? 8 : -2;
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
    const hard = difficulty === 'hard';
    if (!hard) return scoreMediumSequence(state, color, sequence);

    const next = cloneState(state);
    const opponent = opponentOf(color);
    let score = 0;
    sequence.forEach(move => {
      const target = move.bearOff ? null : next.points[move.to];
      const fromPos = pathPos(color, move.from);
      const toPos = move.bearOff ? 24 : pathPos(color, move.to);
      const headBefore = pointCount(next, headPoint(color));

      if (move.bearOff) score += 190 + move.die * 3;
      else {
        if (!target) score += 13;
        else if (target.color === color) score += target.count <= 1 ? 3 : -Math.min(18, (target.count - 1) * 5);
        if (move.from === headPoint(color)) score += 18 + Math.min(36, headBefore * 2);
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
    return violatesLongBlockRule(preview, color, state.off);
  }

  function violatesLongBlockRule(points, color, off = { white: 0, dark: 0 }) {
    const opponent = opponentOf(color);
    const opponentPath = pathFor(opponent);
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
    const loserStart = new Set(pathFor(loser).slice(0, 6));
    const hasCheckerInStart = Object.entries(state.points).some(([point, data]) => (
      data.color === loser && loserStart.has(Number(point))
    ));
    return hasCheckerInStart ? 'koks' : 'mars';
  }

  function pipsFor(state, color) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      return total + data.count * Math.max(0, 24 - pathPos(color, Number(point)));
    }, 0);
  }

  function madePointCount(state, color) {
    return Object.values(state.points).reduce((total, point) => (
      total + (point.color === color && point.count >= 2 ? 1 : 0)
    ), 0);
  }

  function stackPenalty(state, color) {
    return Object.entries(state.points).reduce((total, [point, data]) => {
      if (data.color !== color || data.count <= 5) return total;
      const pos = pathPos(color, Number(point));
      return total + (data.count - 5) * (pos < 18 ? 4 : 1.2);
    }, 0);
  }

  function clonePoints(points) {
    return Object.fromEntries(Object.entries(points).map(([point, data]) => [point, { ...data }]));
  }

  function cloneState(state) {
    return {
      ...state,
      points: clonePoints(state.points),
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
    state.points ||= {};
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
    pipsFor,
    opponentOf,
    endTurn,
    headPoint,
    farthestFromOff,
  };
})();
