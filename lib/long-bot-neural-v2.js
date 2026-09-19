/* Offline experimental neural search. This module does not replace the public frozen bot. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./long-bot-neural'));
  else root.NarduLongNeuralV2 = factory(root.NarduLongNeural);
})(typeof window === 'object' ? window : globalThis, function (neural) {
  'use strict';
  const POLICY_SCHEMA = 'long-neural-search-v2';
  const DEFAULTS = Object.freeze({ maxCandidates: 32, replyTopCandidates: 8,
    replyCandidates: 8, replyWeight: 0.35 });
  const ROLLS = Object.freeze(Array.from({ length: 6 }, (_, a) =>
    Array.from({ length: 6 - a }, (_, offset) => {
      const b = a + offset;
      return Object.freeze({ dice: Object.freeze(a === b ? [a + 1, a + 1, a + 1, a + 1] : [a + 1, b + 1]),
        probability: a === b ? 1 / 36 : 2 / 36 });
    })).flat());
  function check(condition, message) {
    if (!condition) throw new Error(`Long neural v2: ${message}`);
  }
  function integer(value, min, max, name) {
    check(Number.isSafeInteger(value) && value >= min && value <= max, `invalid ${name}`);
  }
  function options(input = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 'invalid policy options');
    check(Object.keys(input).every(key => Object.hasOwn(DEFAULTS, key)), 'unexpected policy options');
    const result = { ...DEFAULTS, ...input };
    integer(result.maxCandidates, 1, 256, 'maxCandidates');
    integer(result.replyTopCandidates, 1, 256, 'replyTopCandidates');
    integer(result.replyCandidates, 1, 64, 'replyCandidates');
    check(typeof result.replyWeight === 'number' && Number.isFinite(result.replyWeight)
      && result.replyWeight >= 0 && result.replyWeight <= 1, 'invalid replyWeight');
    return Object.freeze(result);
  }
  function validateGame(game) {
    check(neural && typeof neural.validateState === 'function', 'missing neural core');
    check(game && ['bestMoveSequences', 'basicLegalMove', 'moveTo', 'resultTypeFor',
      'endTurn', 'applyRoll', 'pathFor', 'pathPos', 'headPoint', 'opponentOf', 'hasAnyMoves']
      .every(name => typeof game[name] === 'function'), 'incompatible long rules adapter');
    check(JSON.stringify(Array.from(game.pathFor('white', 'long'))) === JSON.stringify(Array.from({ length: 24 }, (_, n) => 24 - n))
      && JSON.stringify(Array.from(game.pathFor('dark', 'long'))) === JSON.stringify(Array.from({ length: 24 }, (_, n) => ((35 - n) % 24) + 1)),
    'incompatible long routes');
  }
  function ruleState(source) {
    neural.validateState(source);
    const score = source.score || { white: 0, dark: 0 };
    check(['white', 'dark'].every(color => Number.isFinite(score[color])), 'invalid score');
    return { variant: 'long', points: Object.fromEntries(Object.entries(source.points)
      .map(([point, stack]) => [point, { color: stack.color, count: stack.count }])),
      bar: { ...source.bar }, off: { ...source.off }, score: { ...score },
      turn: source.turn, phase: source.phase, winner: source.winner || null,
      resultType: source.resultType || null, dice: source.dice.slice(), rolled: source.rolled.slice(),
      firstMoveDone: { ...source.firstMoveDone },
      headPlayedThisTurn: { ...(source.headPlayedThisTurn || { white: false, dark: false }) },
      turnMoves: source.turnMoves.map(move => ({ ...move })), history: [] };
  }
  function sequenceKey(moves, color) {
    return moves.map(({ from, die }) => `${String(color === 'white' ? 24 - from : (36 - from) % 24).padStart(2, '0')}:${die}`).join('|');
  }
  // PRIVATE projection of a sequence just enumerated by the trusted rules engine.
  // This is not a public move validator. The live game still uses game.applyMove.
  function projectCertified(game, source, sequence) {
    const state = ruleState(source), color = state.turn;
    for (const move of sequence) {
      integer(move.from, 1, 24, 'certified source');
      integer(move.die, 1, 6, 'certified die');
      const dieIndex = state.dice.indexOf(move.die);
      check(dieIndex >= 0, 'certified die is not available');
      const to = game.moveTo(color, move.from, move.die, state);
      check(move.to === to && Boolean(move.bearOff) === (to === 0), 'certified destination differs');
      const valid = game.basicLegalMove(state, color, move.from, to, dieIndex);
      check(valid?.ok && valid.die === move.die, 'rules rejected certified movement');
      const sourceStack = state.points[move.from];
      check(sourceStack?.color === color && sourceStack.count > 0, 'certified checker missing');
      sourceStack.count--;
      if (!sourceStack.count) delete state.points[move.from];
      if (to === 0) {
        state.off[color]++;
        state.score[color] += 24 - game.pathPos(color, move.from, state);
      } else {
        check(!state.points[to] || state.points[to].color === color, 'certified destination occupied');
        state.points[to] = { color, count: (state.points[to]?.count || 0) + 1 };
        state.score[color] += move.die;
      }
      state.dice.splice(dieIndex, 1);
      state.turnMoves.push({ color, from: move.from, to, die: move.die, bearOff: to === 0 });
      if (move.from === game.headPoint(color, state)) state.headPlayedThisTurn[color] = true;
      if (state.off[color] === 15) {
        state.winner = color; state.resultType = game.resultTypeFor(state, color); state.phase = 'over';
        break;
      }
    }
    if (!state.winner) {
      check(!state.dice.length || !game.hasAnyMoves(state), 'certified turn is incomplete');
      game.endTurn(state);
    }
    neural.validateState(state);
    return state;
  }
  function enumerateUniqueTurns(game, source) {
    validateGame(game);
    const state = ruleState(source);
    check(state.phase === 'move' && !state.winner, 'planning requires a rolled move phase');
    const color = state.turn;
    const legal = game.bestMoveSequences(state, color);
    check(Array.isArray(legal) && legal.every(Array.isArray), 'invalid rules sequence collection');
    const sequences = legal.length ? legal : [[]];
    const unique = new Map();
    for (const sequence of sequences) {
      const afterState = projectCertified(game, state, sequence);
      const positionKey = Array.from(neural.encodeState(afterState, color)).join(',');
      const moves = sequence.map(({ from, die }) => ({ from, die }));
      const key = sequenceKey(moves, color), prior = unique.get(positionKey);
      if (!prior || key < prior.sequenceKey) unique.set(positionKey, { moves, afterState, positionKey, sequenceKey: key });
    }
    const rows = [...unique.values()].sort((a, b) => a.sequenceKey.localeCompare(b.sequenceKey));
    return { legalSequences: legal.length, rows };
  }
  function stateMetrics(game, state, color) {
    neural.validateState(state);
    check(color === 'white' || color === 'dark', 'invalid metric color');
    const opponent = game.opponentOf(color), path = Array.from(game.pathFor(color, 'long'));
    const enemyPath = Array.from(game.pathFor(opponent, 'long'));
    const enemyIndices = Object.entries(state.points).filter(([, stack]) => stack.color === opponent)
      .map(([point]) => enemyPath.indexOf(Number(point)));
    const enemyStart = enemyIndices.length ? Math.min(...enemyIndices) : 24;
    let home = 0, routeDebt = 0, laggardDebt = 0, escapeRisk = 0, stackDebt = 0, koksExposure = 0, blockingUseful = false;
    for (let index = 0; index < 24; index++) {
      const stack = state.points[path[index]];
      if (stack?.color !== color) continue;
      if (index >= 18) home += stack.count;
      else {
        routeDebt += stack.count * (18 - index);
        laggardDebt += stack.count * (18 - index) ** 2;
        let blocked = 0;
        for (let die = 1; die <= 6; die++) {
          if (index + die < 24 && state.points[path[index + die]]?.color === opponent) blocked++;
        }
        escapeRisk += stack.count * (blocked / 6) ** 2 * (1 + (18 - index) / 18);
      }
      // The portal's LONG resultTypeFor defines Koks by the loser's own
      // starting quarter (not the short-game opponent-home definition).
      if (index <= 5) koksExposure += stack.count;
      if (enemyPath.indexOf(path[index]) >= enemyStart) blockingUseful = true;
      stackDebt += Math.max(0, stack.count - (index === 0 ? 5 : 4)) ** 2;
    }
    return { head: state.points[path[0]]?.color === color ? state.points[path[0]].count : 0,
      home, outside: 15 - home - state.off[color], off: state.off[color],
      pips: path.reduce((sum, point, index) => sum + (state.points[point]?.color === color ? state.points[point].count * (24 - index) : 0), 0),
      routeDebt, laggardDebt, escapeRisk, stackDebt, koksExposure, blockingUseful };
  }
  function positionalAdjustment(game, state, color) {
    const own = stateMetrics(game, state, color), enemy = stateMetrics(game, state, game.opponentOf(color));
    const urgency = enemy.off > 0 ? Math.min(2, 1 + enemy.off / 15) : 0;
    // Explicit visible-state heuristics, not probability or validated causal lessons.
    const terms = {
      escape: -own.escapeRisk * 0.045,
      laggards: -own.laggardDebt * 0.00016,
      stacks: -own.stackDebt * 0.0015,
      home: own.home * (own.blockingUseful ? 0.008 : 0.024 + urgency * 0.016),
      bearOff: own.off * 0.055,
      koks: -own.koksExposure * urgency * 0.035,
      opponentEscape: own.blockingUseful ? enemy.escapeRisk * 0.012 : 0,
    };
    return { metrics: own, terms, adjustment: Object.values(terms).reduce((a, b) => a + b, 0) };
  }
  function valueRow(game, model, row, color) {
    const value = neural.predict(model, row.afterState, color);
    const tactics = positionalAdjustment(game, row.afterState, color);
    const rawScore = value + tactics.adjustment;
    check(Number.isFinite(rawScore), 'nonfinite positional utility');
    // A common ordered utility scale is essential: a known loss must never
    // outrank a negative heuristic score, nor a position outrank a known win.
    // This monotone transform is NOT a calibrated winning probability.
    const bounded = rawScore >= 0 ? 1 / (1 + Math.exp(-rawScore))
      : Math.exp(rawScore) / (1 + Math.exp(rawScore));
    const staticUtility = row.afterState.winner ? Number(row.afterState.winner === color)
      : Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, bounded));
    return { ...row, value, rawScore, staticUtility, score: staticUtility, tactics };
  }
  function boundedRows(rows, limit, color) {
    if (rows.length <= limit) return rows.slice();
    const result = [], selected = new Set();
    function add(row) {
      if (row && result.length < limit && !selected.has(row.positionKey)) {
        result.push(row); selected.add(row.positionKey);
      }
    }
    const sorted = (key, descending) => rows.slice().sort((a, b) =>
      (descending ? b.tactics.metrics[key] - a.tactics.metrics[key] : a.tactics.metrics[key] - b.tactics.metrics[key])
      || b.score - a.score || a.sequenceKey.localeCompare(b.sequenceKey));
    add(rows.find(row => row.afterState.winner === color));
    // All unique afterstates have already received a network evaluation; never
    // drop the network's own best alternative because of commuting moves.
    add(rows.slice().sort((a, b) => b.value - a.value || a.sequenceKey.localeCompare(b.sequenceKey))[0]);
    add(rows.slice().sort((a, b) => b.score - a.score || a.sequenceKey.localeCompare(b.sequenceKey))[0]);
    for (const [key, descending] of [['off', true], ['home', true], ['escapeRisk', false],
      ['head', false], ['laggardDebt', false], ['koksExposure', false]]) add(sorted(key, descending)[0]);
    const ordered = rows.slice().sort((a, b) => b.score - a.score || a.sequenceKey.localeCompare(b.sequenceKey));
    for (const row of ordered) add(row);
    return result;
  }
  function createNeuralBot(game, model, input = {}) {
    validateGame(game); neural.validateModel(model);
    const policyOptions = options(input);
    const frozen = { ...model };
    for (const key of ['inputWeights', 'hiddenBias', 'outputWeights']) frozen[key] = Object.freeze(model[key].slice());
    Object.freeze(frozen);
    let lastDecision = null;
    function rank(source) {
      const state = ruleState(source), color = state.turn;
      const enumeration = enumerateUniqueTurns(game, state);
      const allRows = enumeration.rows.map(row => valueRow(game, frozen, row, color));
      const chosen = boundedRows(allRows, policyOptions.maxCandidates, color);
      let replyCandidatesEvaluated = 0, replyLegalSequences = 0, replyUniquePositions = 0;
      const shortlist = policyOptions.replyWeight > 0
        ? boundedRows(chosen, Math.min(policyOptions.replyTopCandidates, chosen.length), color) : chosen;
      const replyCache = new Map();
      const output = [];
      for (const row of shortlist) {
        if (!policyOptions.replyWeight || row.afterState.winner || !row.moves.length) {
          output.push({ ...row, replyScore: null, replySearchComplete: !row.afterState.winner });
          continue;
        }
        let expected = 0, forcedPassProbability = 0, immediateWinProbability = 0, immediateWinningRolls = 0;
        const lossResultTypes = new Set();
        for (let rollIndex = 0; rollIndex < ROLLS.length; rollIndex++) {
          const roll = ROLLS[rollIndex], cacheKey = `${row.positionKey}|${rollIndex}`;
          let replies = replyCache.get(cacheKey);
          if (!replies) {
            const replyState = ruleState(row.afterState);
            game.applyRoll(replyState, roll.dice);
            const response = enumerateUniqueTurns(game, replyState);
            replyLegalSequences += response.legalSequences; replyUniquePositions += response.rows.length;
            // Select opponent champions with the same visible-state policy,
            // then take our worst continuation, rather than a random reply.
            const enemy = game.opponentOf(color);
            replies = boundedRows(response.rows.map(reply => valueRow(game, frozen, reply, enemy)), policyOptions.replyCandidates, enemy);
            replyCache.set(cacheKey, replies);
          }
          let worst = Infinity;
          const winningReply = replies.find(reply => reply.afterState.winner === game.opponentOf(color));
          if (winningReply) {
            immediateWinProbability += roll.probability; immediateWinningRolls++;
            // Public long rules represent a normal (single) result as null.
            lossResultTypes.add(winningReply.afterState.resultType === null ? 'normal' : winningReply.afterState.resultType);
          }
          for (const reply of replies) {
            replyCandidatesEvaluated++;
            const result = reply.afterState.winner
              ? Number(reply.afterState.winner === color)
              : valueRow(game, frozen, reply, color).score;
            worst = Math.min(worst, result);
          }
          check(Number.isFinite(worst), 'reply search produced no continuation');
          if (replies.every(reply => !reply.moves.length)) forcedPassProbability += roll.probability;
          expected += worst * roll.probability;
        }
        output.push({ ...row, replyScore: expected,
          opponentForcedPassProbability: Math.min(1, Math.max(0, forcedPassProbability)),
          opponentImmediateWinProbability: Math.min(1, Math.max(0, immediateWinProbability)),
          forcedNextTurnLoss: immediateWinningRolls === ROLLS.length,
          forcedLossResultType: immediateWinningRolls === ROLLS.length && lossResultTypes.size === 1
            ? [...lossResultTypes][0] : null,
          score: (1 - policyOptions.replyWeight) * row.score + policyOptions.replyWeight * expected,
          replySearchComplete: true });
      }
      const lossSeverity = type => ({ normal: 0, mars: 1, gammon: 1, koks: 2, backgammon: 2 })[type] ?? 3;
      output.sort((a, b) => Number(b.afterState.winner === color) - Number(a.afterState.winner === color)
        || Number(Boolean(a.forcedNextTurnLoss)) - Number(Boolean(b.forcedNextTurnLoss))
        || (a.forcedNextTurnLoss && b.forcedNextTurnLoss
          ? lossSeverity(a.forcedLossResultType) - lossSeverity(b.forcedLossResultType) : 0)
        || b.score - a.score || a.sequenceKey.localeCompare(b.sequenceKey));
      lastDecision = Object.freeze({ policySchema: POLICY_SCHEMA, policyOptions,
        legalSequences: enumeration.legalSequences, uniqueLegalPositions: allRows.length,
        sampledPositions: chosen.length, evaluatedPositions: allRows.length,
        forecastPositions: shortlist.length, truncated: allRows.length > chosen.length,
        replyRolls: policyOptions.replyWeight > 0 && shortlist.some(row => row.moves.length && !row.afterState.winner) ? ROLLS.length : 0,
        replyCandidatesPerRoll: policyOptions.replyCandidates, replyCandidatesEvaluated,
        replyLegalSequences, replyUniquePositions, replySearchComplete: true,
        replyCoverage: 'all-21-rolls-with-bounded-unique-responses-not-exhaustive-minimax',
        scoreKind: 'bounded-search-utility-not-calibrated-probability',
        terminalUtility: 'loss-zero-win-one-nonterminal-sigmoid-raw-score', onlineLearning: false });
      return output;
    }
    function plan(state) { return rank(state)[0]?.moves.map(move => ({ ...move })) || []; }
    return Object.freeze({ plan, rank, model: frozen, policyOptions, getLastDecision: () => lastDecision });
  }
  return Object.freeze({ POLICY_SCHEMA, DEFAULTS, ROLLS, options, createNeuralBot,
    enumerateUniqueTurns, stateMetrics });
});
