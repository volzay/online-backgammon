/* ---------------------------------------------------------------
   strong-bot.js - separate expert program for the hard long bot.
   Uses NarduGame only as the rules engine; owns position evaluation.
   Exposes: window.NarduStrongBot
   --------------------------------------------------------------- */
window.NarduStrongBot = (function () {
  const CANDIDATE_LIMIT = 18;
  const DEEP_SEQUENCE_LIMIT = 180;
  const REPLY_LIMIT = 4;
  const REPLY_ROLLS = [
    [6, 6], [6, 5], [5, 5], [4, 4], [3, 3], [2, 2],
  ];

  function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function colorAt(state, point) {
    return state.points?.[point]?.color || null;
  }

  function countAt(state, point) {
    return state.points?.[point]?.count || 0;
  }

  function countInRange(state, color, start, end) {
    return Object.entries(state.points || {}).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = NarduGame.pathPos(color, Number(point), state);
      return total + (pos >= start && pos <= end ? data.count : 0);
    }, 0);
  }

  function madeInRange(state, color, start, end) {
    return Object.entries(state.points || {}).reduce((total, [point, data]) => {
      if (data.color !== color || data.count < 2) return total;
      const pos = NarduGame.pathPos(color, Number(point), state);
      return total + (pos >= start && pos <= end ? 1 : 0);
    }, 0);
  }

  function occupiedInRange(state, color, start, end) {
    return Object.entries(state.points || {}).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = NarduGame.pathPos(color, Number(point), state);
      return total + (pos >= start && pos <= end ? 1 : 0);
    }, 0);
  }

  function homeCount(state, color) {
    return countInRange(state, color, 18, 23) + (state.off?.[color] || 0);
  }

  function outsideHomeCount(state, color) {
    return countInRange(state, color, 0, 17);
  }

  function outsideHomePips(state, color) {
    return Object.entries(state.points || {}).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = NarduGame.pathPos(color, Number(point), state);
      return total + (pos >= 0 && pos < 18 ? data.count * (18 - pos) : 0);
    }, 0);
  }

  function stackPenalty(state, color) {
    return Object.entries(state.points || {}).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = NarduGame.pathPos(color, Number(point), state);
      const limit = pos >= 18 ? 4 : 3;
      const excess = Math.max(0, data.count - limit);
      const headExtra = Number(point) === NarduGame.headPoint(color, state) ? 2.2 : 1;
      return total + excess * excess * headExtra * (pos < 12 ? 3.2 : 2.1);
    }, 0);
  }

  function runControlOnPath(state, color, pathColor, start, end) {
    let run = 0;
    return NarduGame.pathFor(pathColor, state).slice(start, end + 1).reduce((score, point, index) => {
      if (colorAt(state, point) !== color) {
        run = 0;
        return score;
      }
      run += 1;
      const data = state.points[point];
      const made = data.count >= 2;
      const weight = index + 4;
      return score + weight * (made ? 26 : 9) + run * run * 12;
    }, 0);
  }

  function opponentFenceThreat(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const path = NarduGame.pathFor(color, state);
    let run = 0;
    let runStart = 0;
    let threat = 0;
    path.forEach((point, index) => {
      if (colorAt(state, point) === opponent) {
        if (!run) runStart = index;
        run += 1;
        const behind = path.slice(0, runStart)
          .reduce((sum, p) => sum + (colorAt(state, p) === color ? countAt(state, p) : 0), 0);
        if (run >= 3 && behind > 0) threat += run * run * behind * (index < 12 ? 26 : 14);
      } else {
        run = 0;
      }
    });
    return threat;
  }

  function headChannelScore(state, color) {
    const head = NarduGame.headPoint(color, state);
    const headCheckers = countAt(state, head);
    if (headCheckers <= 2) return 0;
    let score = 0;
    for (let die = 1; die <= 6; die += 1) {
      const point = NarduGame.moveTo(color, head, die, state);
      if (!point) continue;
      const data = state.points?.[point];
      const weight = 8 - die;
      if (data?.color === color) score += weight * (data.count >= 2 ? 82 : 38);
      else if (!data) score += weight * 7;
      else score -= weight * 70;
    }
    return score;
  }

  function forwardAttackScore(state, color) {
    return runControlOnPath(state, color, color, 8, 18);
  }

  function defensiveBridgeScore(state, color) {
    return runControlOnPath(state, color, color, 1, 11);
  }

  function opponentReadiness(state, color) {
    const opponent = NarduGame.opponentOf(color);
    return (state.off?.[opponent] || 0) * 460
      + homeCount(state, opponent) * 54
      - NarduGame.pipsFor(state, opponent) * 4.2
      + madeInRange(state, opponent, 15, 23) * 120
      + runControlOnPath(state, opponent, opponent, 12, 23) * 0.8;
  }

  function evaluateState(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const ownPips = NarduGame.pipsFor(state, color);
    const opponentPips = NarduGame.pipsFor(state, opponent);
    const head = countAt(state, NarduGame.headPoint(color, state));
    const opponentHead = countAt(state, NarduGame.headPoint(opponent, state));
    const ownOff = state.off?.[color] || 0;
    const opponentOff = state.off?.[opponent] || 0;
    const ownHome = homeCount(state, color);
    const oppHome = homeCount(state, opponent);
    const ownOutside = outsideHomeCount(state, color);
    const oppOutside = outsideHomeCount(state, opponent);
    const pressure = Math.max(0, opponentOff * 80 + oppHome * 12 - ownHome * 10);

    let score = 0;
    score += ownOff * 12000 - opponentOff * 15500;
    score += (opponentPips - ownPips) * 92;
    score += ownHome * 210 - oppHome * 250;
    score -= outsideHomePips(state, color) * (42 + Math.min(80, pressure));
    score += outsideHomePips(state, opponent) * 18;
    score -= ownOutside * (320 + Math.min(1200, pressure * 5));
    score += oppOutside * 95;
    score -= head * (ownOff ? 120 : 740);
    score += opponentHead * 210;
    score += headChannelScore(state, color) * 22;
    score -= headChannelScore(state, opponent) * 11;
    score += defensiveBridgeScore(state, color) * (head > 6 ? 12 : 5);
    score += forwardAttackScore(state, color) * (head > 8 ? 5 : 17);
    score -= opponentFenceThreat(state, color) * 46;
    score += opponentFenceThreat(state, opponent) * 12;
    score += madeInRange(state, color, 5, 17) * 360;
    score += madeInRange(state, color, 18, 23) * 420;
    score -= madeInRange(state, opponent, 12, 23) * 300;
    score += occupiedInRange(state, color, 4, 18) * 150;
    score -= stackPenalty(state, color) * 420;
    score += stackPenalty(state, opponent) * 70;
    score -= opponentReadiness(state, color) * 18;
    if (!ownOff && opponentOff > 0) score -= 9000 + opponentOff * 2800;
    if (NarduGame.homeReady(state, color)) score += 2400 + ownOff * 2600;
    if (NarduGame.homeReady(state, opponent)) score -= 3200 + opponentOff * 3200;
    return score;
  }

  function applySequence(state, sequence) {
    const next = cloneState(state);
    sequence.forEach(move => {
      next.turn = state.turn;
      next.phase = 'move';
      NarduGame.applyMove(next, move.from, move.die, { autoEnd: false });
    });
    return next;
  }

  function rollState(state, color, roll) {
    const next = cloneState(state);
    const dice = roll[0] === roll[1]
      ? [roll[0], roll[0], roll[0], roll[0]]
      : [...roll];
    next.turn = color;
    next.phase = 'move';
    next.dice = dice;
    next.rolled = [...dice];
    next.turnMoves = [];
    next.headPlayedThisTurn = { ...(next.headPlayedThisTurn || {}), [color]: false };
    return next;
  }

  function quickScore(state, color, sequence) {
    return evaluateState(applySequence(state, sequence), color);
  }

  function opponentReplyRisk(state, color) {
    const opponent = NarduGame.opponentOf(color);
    let worst = -Infinity;
    let total = 0;
    REPLY_ROLLS.forEach(roll => {
      const replyState = rollState(state, opponent, roll);
      const replies = NarduGame.bestMoveSequences(replyState, opponent).filter(sequence => sequence.length);
      if (!replies.length) {
        const risk = evaluateState(replyState, color);
        worst = Math.max(worst, risk);
        total += risk;
        return;
      }
      const bestReply = replies
        .map(sequence => ({ sequence, score: quickScore(replyState, opponent, sequence) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, REPLY_LIMIT)
        .map(item => evaluateState(applySequence(replyState, item.sequence), color))
        .sort((a, b) => a - b)[0];
      worst = Math.max(worst, -bestReply);
      total += bestReply;
    });
    return worst * 0.62 - total / Math.max(1, REPLY_ROLLS.length) * 0.22;
  }

  function plan(state) {
    const color = state.turn;
    const sequences = NarduGame.bestMoveSequences(state, color).filter(sequence => sequence.length);
    if (!sequences.length) return [];

    const wideTree = sequences.length > DEEP_SEQUENCE_LIMIT;
    const base = wideTree ? [] : (NarduGame.chooseBotSequence?.(state, color, { difficulty: 'hard' }) || []);
    const pool = wideTree ? sequences.slice(0, DEEP_SEQUENCE_LIMIT) : sequences;
    const ranked = pool
      .map(sequence => ({ sequence, score: quickScore(state, color, sequence) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATE_LIMIT);
    if (base.length) ranked.push({ sequence: base, score: quickScore(state, color, base) });
    if (wideTree) {
      return ranked[0].sequence.map(move => ({ from: move.from, die: move.die }));
    }

    return ranked
      .map(item => {
        const next = applySequence(state, item.sequence);
        const replyRisk = opponentReplyRisk(next, color);
        return { sequence: item.sequence, score: item.score - replyRisk };
      })
      .sort((a, b) => b.score - a.score)[0]
      .sequence
      .map(move => ({ from: move.from, die: move.die }));
  }

  return {
    plan,
    evaluateState,
  };
})();
