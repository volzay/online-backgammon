/* ---------------------------------------------------------------
   strong-bot.js - separate expert program for the hard long bot.
   Uses NarduGame only as the rules engine; owns position evaluation.
   Exposes: window.NarduStrongBot
   --------------------------------------------------------------- */
window.NarduStrongBot = (function () {
  const CANDIDATE_LIMIT = 18;
  const DEEP_SEQUENCE_LIMIT = 180;
  const REPLY_LIMIT = 4;
  const PROFILE_KEY = 'narduh-strong-bot-profile-v1';
  const DEFAULT_PROFILE = {
    version: 1,
    games: 0,
    losses: 0,
    headBlock: 1.18,
    routeControl: 1.14,
    preserveHeadLandings: 1.22,
    avoidRush: 1.12,
    avoidTowers: 1.08,
  };
  const REPLY_ROLLS = [
    [6, 6], [6, 5], [5, 5], [4, 4], [3, 3], [2, 2],
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function storage() {
    try {
      return typeof window !== 'undefined' ? window.localStorage : null;
    } catch (error) {
      return null;
    }
  }

  function learningProfile() {
    const store = storage();
    if (!store) return { ...DEFAULT_PROFILE };
    try {
      const parsed = JSON.parse(store.getItem(PROFILE_KEY) || 'null');
      return {
        ...DEFAULT_PROFILE,
        ...(parsed && typeof parsed === 'object' ? parsed : {}),
        version: DEFAULT_PROFILE.version,
      };
    } catch (error) {
      return { ...DEFAULT_PROFILE };
    }
  }

  function saveLearningProfile(profile) {
    const store = storage();
    if (!store) return;
    try {
      store.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch (error) {
      // Learning is optional; gameplay must not depend on storage availability.
    }
  }

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

  function routeControlScore(state, color, pathColor, start, end) {
    let run = 0;
    return NarduGame.pathFor(pathColor, state).slice(start, end + 1).reduce((score, point, index) => {
      const data = state.points?.[point];
      const weight = end - start + 2 - index;
      if (data?.color !== color) {
        run = 0;
        return score;
      }
      run += 1;
      const made = data.count >= 2;
      const tower = Math.max(0, data.count - 3);
      return score
        + weight * (made ? 42 : 16)
        + run * run * 18
        - tower * tower * weight * 10;
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

  function headLandingAnchorScore(state, color) {
    const head = NarduGame.headPoint(color, state);
    const headCheckers = countAt(state, head);
    if (headCheckers <= 2) return 0;
    const pressure = Math.min(5.5, 1 + headCheckers / 5 + Math.max(0, outsideHomeCount(state, color) - 7) / 8);
    let score = 0;
    for (let die = 1; die <= 6; die += 1) {
      const point = NarduGame.moveTo(color, head, die, state);
      if (!point) continue;
      const data = state.points?.[point];
      const odd = die === 1 || die === 3 || die === 5;
      const weight = odd ? 9 - die * 0.45 : 3.4;
      if (data?.color === color) {
        const made = data.count >= 2;
        const stack = Math.max(0, data.count - 3);
        score += weight * (made ? 210 : 94) - stack * stack * weight * 16;
      } else if (!data) {
        score -= weight * (odd ? 150 : 45);
      } else {
        score -= weight * (odd ? 260 : 70);
      }
    }
    return score * pressure;
  }

  function keyHeadLandingBreakPenalty(before, next, color) {
    const head = NarduGame.headPoint(color, before);
    const headCheckers = countAt(before, head);
    if (headCheckers <= 3) return 0;
    let penalty = 0;
    [1, 3, 5].forEach(die => {
      const point = NarduGame.moveTo(color, head, die, before);
      if (!point) return;
      const beforeData = before.points?.[point];
      const nextData = next.points?.[point];
      if (beforeData?.color !== color) return;
      const beforeCount = beforeData.count || 0;
      const nextCount = nextData?.color === color ? nextData.count || 0 : 0;
      const weight = die === 1 ? 1.25 : die === 3 ? 1.18 : 1.1;
      if (nextCount <= 0) penalty += (headCheckers > 8 ? 115000 : 52000) * weight;
      else if (beforeCount >= 2 && nextCount < 2) penalty += (headCheckers > 8 ? 52000 : 24000) * weight;
      else if (nextCount < beforeCount) penalty += 9000 * weight;
    });
    return penalty;
  }

  function keyHeadLandingGain(before, next, color) {
    const head = NarduGame.headPoint(color, before);
    const headCheckers = countAt(before, head);
    if (headCheckers <= 2) return 0;
    let gain = 0;
    [1, 3, 5].forEach(die => {
      const point = NarduGame.moveTo(color, head, die, before);
      if (!point) return;
      const beforeData = before.points?.[point];
      const nextData = next.points?.[point];
      const beforeCount = beforeData?.color === color ? beforeData.count || 0 : 0;
      const nextCount = nextData?.color === color ? nextData.count || 0 : 0;
      if (nextCount > beforeCount) {
        const weight = die === 1 ? 1.22 : die === 3 ? 1.18 : 1.12;
        gain += (beforeCount === 0 ? 76000 : 22000) * weight;
        if (beforeCount < 2 && nextCount >= 2) gain += 38000 * weight;
      }
    });
    return gain;
  }

  function opponentHeadBlockScore(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const head = NarduGame.headPoint(opponent, state);
    const headCheckers = countAt(state, head);
    if (headCheckers <= 2) return 0;
    let score = 0;
    for (let die = 1; die <= 6; die += 1) {
      const point = NarduGame.moveTo(opponent, head, die, state);
      if (!point) continue;
      const data = state.points?.[point];
      const weight = 8 - die;
      const odd = die === 1 || die === 3 || die === 5;
      const oddBoost = odd ? 1.55 : 1;
      if (data?.color === color) score += weight * oddBoost * (data.count >= 2 ? 220 : 96);
      else if (!data) score -= weight * oddBoost * 58;
      else score -= weight * oddBoost * 24;
    }
    return score * Math.min(4, 1 + headCheckers / 6);
  }

  function opponentHeadFreedomScore(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const head = NarduGame.headPoint(opponent, state);
    const headCheckers = countAt(state, head);
    if (headCheckers <= 2) return 0;
    let freedom = 0;
    for (let die = 1; die <= 6; die += 1) {
      const point = NarduGame.moveTo(opponent, head, die, state);
      if (!point) continue;
      const data = state.points?.[point];
      const weight = 8 - die;
      const odd = die === 1 || die === 3 || die === 5;
      const oddBoost = odd ? 1.65 : 1;
      if (!data || data.color === opponent) freedom += weight * oddBoost * (data?.count >= 2 ? 22 : 42);
      else if (data.count === 1) freedom += weight * oddBoost * 10;
    }
    return freedom * Math.min(5, 1 + headCheckers / 5);
  }

  function opponentRouteControlScore(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const opponentHead = countAt(state, NarduGame.headPoint(opponent, state));
    const opponentPressure = opponentReadiness(state, color);
    return routeControlScore(state, color, opponent, 1, 13)
      * Math.min(4.5, 1 + opponentHead / 7 + opponentPressure / 900);
  }

  function homeTowerPenalty(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const opponentHead = countAt(state, NarduGame.headPoint(opponent, state));
    const opponentOff = state.off?.[opponent] || 0;
    const ownOff = state.off?.[color] || 0;
    const pressure = 1 + opponentHead / 8 + opponentOff / 5 + (!ownOff && opponentOff ? 1.4 : 0);
    return Object.entries(state.points || {}).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = NarduGame.pathPos(color, Number(point), state);
      if (pos < 18) return total;
      const excess = Math.max(0, data.count - 3);
      const tower = Math.max(0, data.count - 5);
      return total + (excess * excess * 42 + tower * tower * 180) * pressure;
    }, 0);
  }

  function prematureRacePenalty(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const opponentHead = countAt(state, NarduGame.headPoint(opponent, state));
    const ownHead = countAt(state, NarduGame.headPoint(color, state));
    const routeControl = opponentRouteControlScore(state, color);
    const attack = forwardAttackScore(state, color);
    const home = countInRange(state, color, 18, 23);
    if (home < 4) return 0;
    const missingControl = Math.max(0, 180 - routeControl - attack * 0.35);
    const headDebt = Math.max(0, ownHead - 4) + Math.max(0, opponentHead - 4) * 0.8;
    return home * missingControl * (1 + headDebt / 5);
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

  function emergencyPressure(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const ownOff = state.off?.[color] || 0;
    const opponentOff = state.off?.[opponent] || 0;
    const ownOutside = outsideHomeCount(state, color);
    const opponentHome = homeCount(state, opponent);
    const opponentPips = NarduGame.pipsFor(state, opponent);
    let pressure = 0;

    if (!ownOff && opponentOff > 0) pressure += 190 + opponentOff * 58;
    if (!ownOff && NarduGame.homeReady(state, opponent)) pressure += 170 + opponentOff * 36;
    if (opponentHome >= 12 && ownOutside > 0) pressure += (opponentHome - 11) * 34;
    if (opponentPips < 75 && ownOutside > 0) pressure += (75 - opponentPips) * 5.5;
    pressure += Math.max(0, outsideHomePips(state, color) - 18) * 1.5;
    return pressure;
  }

  function emergencyActive(state, color) {
    return emergencyPressure(state, color) >= 120;
  }

  function survivalScore(before, next, color) {
    const opponent = NarduGame.opponentOf(color);
    const beforeOff = before.off?.[color] || 0;
    const nextOff = next.off?.[color] || 0;
    const opponentOff = next.off?.[opponent] || 0;
    const offGain = nextOff - beforeOff;
    const outsideBefore = outsideHomeCount(before, color);
    const outsideAfter = outsideHomeCount(next, color);
    const outsidePipsBefore = outsideHomePips(before, color);
    const outsidePipsAfter = outsideHomePips(next, color);
    const readyBefore = NarduGame.homeReady(before, color);
    const readyAfter = NarduGame.homeReady(next, color);
    const pipGain = NarduGame.pipsFor(before, color) - NarduGame.pipsFor(next, color);
    const pressure = emergencyPressure(before, color);

    let score = 0;
    score += offGain * 10000000;
    if (!beforeOff && nextOff > 0) score += 30000000;
    if (readyAfter && !readyBefore) score += 9000000;
    score += (outsideBefore - outsideAfter) * (2600000 + pressure * 9000);
    score += (outsidePipsBefore - outsidePipsAfter) * (320000 + pressure * 1300);
    score -= outsideAfter * (1100000 + pressure * 6000);
    score -= outsidePipsAfter * (130000 + pressure * 850);
    score += pipGain * (160000 + pressure * 750);
    score += (homeCount(next, color) - homeCount(before, color)) * 520000;
    if (!nextOff && opponentOff > 0) score -= 7000000 + opponentOff * 4100000;
    if (NarduGame.homeReady(next, opponent) && !nextOff) score -= 9000000;
    score -= opponentFenceThreat(next, color) * 12000;
    score += evaluateState(next, color) * 0.08;
    return score;
  }

  function evaluateState(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const profile = learningProfile();
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
    score += headLandingAnchorScore(state, color) * 34 * profile.preserveHeadLandings;
    score -= headLandingAnchorScore(state, opponent) * 10;
    score += opponentHeadBlockScore(state, color) * 24 * profile.headBlock;
    score -= opponentHeadFreedomScore(state, color) * 42 * profile.headBlock;
    score += opponentRouteControlScore(state, color) * 14 * profile.routeControl;
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
    score -= homeTowerPenalty(state, color) * 8.5 * profile.avoidTowers;
    score -= prematureRacePenalty(state, color) * 0.45 * profile.avoidRush;
    if (!ownOff && opponentOff > 0) score -= 9000 + opponentOff * 2800;
    if (!ownOff && (opponentOff > 0 || oppHome >= 12 || opponentPips < 75)) {
      score -= 52000
        + opponentOff * 18000
        + outsideHomePips(state, color) * 820
        + ownOutside * 9200;
      if (NarduGame.homeReady(state, color)) score += 36000;
    }
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
    const next = applySequence(state, sequence);
    const profile = learningProfile();
    return evaluateState(next, color)
      + keyHeadLandingGain(state, next, color) * profile.preserveHeadLandings
      - keyHeadLandingBreakPenalty(state, next, color) * profile.preserveHeadLandings;
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
    const emergency = emergencyActive(state, color);
    const base = NarduGame.chooseBotSequence?.(state, color, { difficulty: 'hard' }) || [];
    const pool = wideTree && !emergency ? sequences.slice(0, DEEP_SEQUENCE_LIMIT) : sequences;
    const candidateCap = emergency ? Math.max(CANDIDATE_LIMIT * 4, 72) : CANDIDATE_LIMIT;
    const ranked = pool
      .map(sequence => ({ sequence, score: quickScore(state, color, sequence) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateCap);
    if (base.length) ranked.push({ sequence: base, score: quickScore(state, color, base) });
    if (emergency) {
      return ranked
        .map(item => ({ sequence: item.sequence, score: survivalScore(state, applySequence(state, item.sequence), color) }))
        .sort((a, b) => b.score - a.score)[0]
        .sequence
        .map(move => ({ from: move.from, die: move.die }));
    }
    if (wideTree) {
      return ranked
        .sort((a, b) => b.score - a.score)[0]
        .sequence
        .map(move => ({ from: move.from, die: move.die }));
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

  function learnFromGame(state, botColor) {
    if (!state?.winner || !botColor) return null;
    const opponent = NarduGame.opponentOf(botColor);
    const botWon = state.winner === botColor;
    const profile = learningProfile();
    const lossPressure = botWon ? -0.012 : 0.04;
    const resultBoost = state.resultType === 'koks' ? 2.8 : state.resultType === 'mars' ? 2.1 : 1;
    const opponentOff = state.off?.[opponent] || 0;
    const botOff = state.off?.[botColor] || 0;
    const opponentHead = countAt(state, NarduGame.headPoint(opponent, state));
    const botHead = countAt(state, NarduGame.headPoint(botColor, state));
    const tower = homeTowerPenalty(state, botColor);
    const route = opponentRouteControlScore(state, botColor);
    const freedom = opponentHeadFreedomScore(state, botColor);
    const danger = Math.max(1, resultBoost + opponentOff / 8 + Math.max(0, opponentOff - botOff) / 6);

    profile.games = (Number(profile.games) || 0) + 1;
    if (!botWon) profile.losses = (Number(profile.losses) || 0) + 1;
    profile.headBlock = clamp(profile.headBlock + lossPressure * danger * (1 + freedom / 800 + opponentHead / 12), 0.9, 1.85);
    profile.routeControl = clamp(profile.routeControl + lossPressure * danger * (route < 180 ? 1.25 : 0.45), 0.9, 1.8);
    profile.preserveHeadLandings = clamp(profile.preserveHeadLandings + lossPressure * danger * 1.35, 1, 1.95);
    profile.avoidRush = clamp(profile.avoidRush + lossPressure * danger * (botHead > 3 || opponentOff > botOff ? 1.2 : 0.55), 0.9, 1.75);
    profile.avoidTowers = clamp(profile.avoidTowers + lossPressure * danger * (tower > 0 ? 1.35 : 0.55), 0.9, 1.7);
    profile.updatedAt = new Date().toISOString();
    saveLearningProfile(profile);
    return profile;
  }

  return {
    plan,
    evaluateState,
    emergencyActive,
    survivalScore,
    learnFromGame,
    learningProfile,
  };
})();
