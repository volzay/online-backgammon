/* ---------------------------------------------------------------
   strong-bot.js - separate expert program for the hard long bot.
   Uses NarduGame only as the rules engine; owns position evaluation.
   Exposes: window.NarduStrongBot
   --------------------------------------------------------------- */
window.NarduStrongBot = (function () {
  const CANDIDATE_LIMIT = 18;
  const DEEP_SEQUENCE_LIMIT = 180;
  const PREFILTER_SEQUENCE_LIMIT = 48;
  const REPLY_LIMIT = 4;
  const PLAN_TIME_LIMIT_MS = 900;
  const PROFILE_KEY = 'narduh-strong-bot-profile-v3';
  const DEFAULT_PROFILE = {
    version: 2,
    games: 0,
    losses: 0,
    headBlock: 1.18,
    headEscape: 1.32,
    routeControl: 1.14,
    preserveHeadLandings: 1.22,
    avoidRush: 1.12,
    avoidTowers: 1.08,
  };
  const REPLY_ROLLS = [
    [6, 6], [6, 5], [5, 5], [4, 4], [3, 3], [2, 2],
  ];
  const KEY_HEAD_LANDING_DICE = [1, 3, 5, 6];

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

  function longEngineWeights(profile = learningProfile()) {
    const ratio = (key, min = 0.82, max = 1.38) => clamp(
      Number(profile[key] || DEFAULT_PROFILE[key]) / DEFAULT_PROFILE[key],
      min,
      max,
    );
    return {
      opponentHeadFreedom: 48000 * ratio('headBlock'),
      headLandingExposure: 62000 * ratio('preserveHeadLandings'),
      headRelease: 9800 * ratio('preserveHeadLandings'),
      foothold: 4300 * ratio('headEscape'),
      homeEntry: 145000 * ratio('avoidRush'),
      rushPenalty: 12500 * ratio('avoidRush'),
      trapRisk: 62000 * ratio('routeControl'),
      distribution: 780 * ratio('avoidTowers'),
    };
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
    if (headCheckers <= 0) return 0;
    let penalty = 0;
    KEY_HEAD_LANDING_DICE.forEach(die => {
      if (die !== 6 && headCheckers <= 3) return;
      const point = NarduGame.moveTo(color, head, die, before);
      if (!point) return;
      const beforeData = before.points?.[point];
      const nextData = next.points?.[point];
      if (beforeData?.color !== color) return;
      const beforeCount = beforeData.count || 0;
      const nextCount = nextData?.color === color ? nextData.count || 0 : 0;
      const weight = die === 1 ? 1.25 : die === 3 ? 1.18 : die === 5 ? 1.1 : 1.35;
      if (die === 6) {
        if (nextCount <= 0) penalty += (headCheckers > 6 ? 3400000 : 2100000) * weight;
        else if (beforeCount >= 2 && nextCount < 2) penalty += (headCheckers > 6 ? 2200000 : 1500000) * weight;
        else if (nextCount < beforeCount && beforeCount <= 3) penalty += 680000 * weight;
        else if (nextCount < beforeCount) penalty += 160000 * weight;
        return;
      }
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
    KEY_HEAD_LANDING_DICE.forEach(die => {
      const point = NarduGame.moveTo(color, head, die, before);
      if (!point) return;
      const beforeData = before.points?.[point];
      const nextData = next.points?.[point];
      const beforeCount = beforeData?.color === color ? beforeData.count || 0 : 0;
      const nextCount = nextData?.color === color ? nextData.count || 0 : 0;
      if (nextCount > beforeCount) {
        const weight = die === 1 ? 1.22 : die === 3 ? 1.18 : die === 5 ? 1.12 : 1.3;
        const emptyGain = die === 6 ? 180000 : 76000;
        const reinforceGain = die === 6 ? 90000 : 22000;
        const floorGain = die === 6 ? 520000 : 38000;
        gain += (beforeCount === 0 ? emptyGain : reinforceGain) * weight;
        if (beforeCount < 2 && nextCount >= 2) gain += floorGain * weight;
      }
    });
    return gain;
  }

  function headSixReserveScore(state, color) {
    const head = NarduGame.headPoint(color, state);
    const headCheckers = countAt(state, head);
    if (headCheckers <= 0) return 0;
    const point = NarduGame.moveTo(color, head, 6, state);
    if (!point) return 0;
    const data = state.points?.[point];
    const reserve = data?.color === color ? data.count || 0 : 0;
    const pressure = 1 + Math.max(0, headCheckers - 2) / 3 + outsideHomeCount(state, color) / 18;
    if (reserve >= 3) return 180000 * pressure;
    if (reserve >= 2) return 95000 * pressure;
    if (reserve === 1) return -760000 * pressure;
    return -1800000 * pressure;
  }

  function headSixSourcePenalty(before, next, color, sequence = []) {
    const head = NarduGame.headPoint(color, before);
    const headCheckers = countAt(before, head);
    if (headCheckers <= 0) return 0;
    const point = NarduGame.moveTo(color, head, 6, before);
    if (!point) return 0;
    const startReserve = before.points?.[point]?.color === color ? before.points[point].count || 0 : 0;
    if (startReserve <= 0) return 0;
    const usedFromReserve = sequence.filter(move => Number(move.from) === Number(point)).length;
    if (!usedFromReserve) return 0;
    const endReserve = next.points?.[point]?.color === color ? next.points[point].count || 0 : 0;
    const restoredFromHead = sequence.some(move => Number(move.from) === Number(head) && Number(move.die) === 6);
    const pressure = 1 + Math.max(0, headCheckers - 1) / 2.5 + Math.max(0, 3 - startReserve) * 0.7;
    let penalty = 0;
    if (endReserve < startReserve) penalty += (2600000 + headCheckers * 420000) * pressure;
    if (endReserve < Math.min(2, startReserve)) penalty += (3600000 + headCheckers * 620000) * pressure;
    if (!restoredFromHead && startReserve <= 3) penalty += usedFromReserve * (1900000 + headCheckers * 360000) * pressure;
    if (!restoredFromHead && startReserve <= 1) penalty += usedFromReserve * (12000000 + headCheckers * 1800000) * pressure;
    if (restoredFromHead && endReserve >= startReserve) {
      penalty += usedFromReserve * (startReserve <= 2 ? 1800000 : 520000) * pressure;
    }
    return penalty;
  }

  function headExitPressure(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const head = NarduGame.headPoint(color, state);
    const headCheckers = countAt(state, head);
    if (headCheckers <= 0) return 0;
    const opponentHome = homeCount(state, opponent);
    const opponentOff = state.off?.[opponent] || 0;
    const opponentPips = NarduGame.pipsFor(state, opponent);
    return 1
      + headCheckers / 3.2
      + Math.max(0, opponentHome - 4) / 7
      + opponentOff * 0.45
      + Math.max(0, 170 - opponentPips) / 115;
  }

  function headExitSecurityScore(state, color) {
    const head = NarduGame.headPoint(color, state);
    const headCheckers = countAt(state, head);
    if (headCheckers <= 0) return 0;
    const pressure = headExitPressure(state, color);
    let score = 0;
    let ownExits = 0;
    let openExits = 0;
    let opponentRun = 0;
    let longestOpponentRun = 0;

    for (let die = 1; die <= 6; die += 1) {
      const point = NarduGame.moveTo(color, head, die, state);
      if (!point) continue;
      const data = state.points?.[point];
      const critical = die === 1 || die === 3 || die === 5 || die === 6;
      const weight = (critical ? 1.35 : 1) * (8 - die * 0.55);
      if (data?.color === color) {
        ownExits += 1;
        opponentRun = 0;
        const made = data.count >= 2;
        const reserve = Math.min(4, data.count || 0);
        score += weight * (made ? 520000 : 220000) * pressure;
        score += weight * reserve * 58000 * pressure;
        if (data.count > 4) score -= weight * Math.pow(data.count - 4, 2) * 52000;
      } else if (!data) {
        openExits += 1;
        opponentRun = 0;
        score -= weight * 170000 * pressure;
      } else {
        opponentRun += 1;
        longestOpponentRun = Math.max(longestOpponentRun, opponentRun);
        score -= weight * (data.count >= 2 ? 1450000 : 980000) * pressure;
      }
    }

    if (ownExits <= 0) score -= (4600000 + headCheckers * 640000) * pressure;
    if (ownExits === 1 && openExits <= 1) score -= (1700000 + headCheckers * 360000) * pressure;
    if (longestOpponentRun >= 3) score -= Math.pow(longestOpponentRun, 3) * (260000 + headCheckers * 70000) * pressure;
    if (longestOpponentRun >= 5) score -= (5200000 + headCheckers * 900000) * pressure;
    return score;
  }

  function headExitStrategyScore(before, next, color, sequence = []) {
    const head = NarduGame.headPoint(color, before);
    const headCheckers = countAt(before, head);
    if (headCheckers <= 0) return 0;
    const pressure = headExitPressure(before, color);
    let score = headExitSecurityScore(next, color) - headExitSecurityScore(before, color);

    for (let die = 1; die <= 6; die += 1) {
      const point = NarduGame.moveTo(color, head, die, before);
      if (!point) continue;
      const beforeCount = before.points?.[point]?.color === color ? before.points[point].count || 0 : 0;
      const nextCount = next.points?.[point]?.color === color ? next.points[point].count || 0 : 0;
      const usedFromExit = sequence.filter(move => Number(move.from) === Number(point)).length;
      const restoredFromHead = sequence.some(move => Number(move.from) === Number(head) && Number(move.die) === die);
      const critical = die === 1 || die === 3 || die === 5 || die === 6;
      const weight = (critical ? 1.45 : 1) * (8 - die * 0.5);

      if (nextCount > beforeCount) {
        score += (beforeCount === 0 ? 980000 : 360000) * weight * pressure;
        if (beforeCount < 2 && nextCount >= 2) score += 1280000 * weight * pressure;
      }
      if (usedFromExit && beforeCount > 0) {
        if (nextCount < beforeCount) score -= usedFromExit * (1450000 + headCheckers * 280000) * weight * pressure;
        if (beforeCount >= 2 && nextCount < 2) score -= (2200000 + headCheckers * 360000) * weight * pressure;
        if (nextCount <= 0) score -= (3600000 + headCheckers * 540000) * weight * pressure;
        if (!restoredFromHead && nextCount <= beforeCount) score -= usedFromExit * 840000 * weight * pressure;
      }
    }
    return score;
  }

  function headBlockadeRuns(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const path = NarduGame.pathFor(color, state);
    const runs = [];
    let start = 0;
    let length = 0;
    path.slice(1, 12).forEach((point, offset) => {
      const index = offset + 1;
      if (state.points?.[point]?.color === opponent) {
        if (!length) start = index;
        length += 1;
        return;
      }
      if (length >= 3 && start <= 7) runs.push({ start, end: index - 1, length });
      length = 0;
    });
    if (length >= 3 && start <= 7) runs.push({ start, end: start + length - 1, length });
    return runs;
  }

  function headFootholdPressure(state, color, run) {
    const opponent = NarduGame.opponentOf(color);
    const head = countAt(state, NarduGame.headPoint(color, state));
    const outside = outsideHomeCount(state, color);
    const opponentHome = homeCount(state, opponent);
    return 1
      + head / 3.5
      + outside / 18
      + Math.max(0, run.length - 3) * 0.8
      + Math.max(0, opponentHome - 5) / 10;
  }

  function headFootholdScore(state, color) {
    const head = countAt(state, NarduGame.headPoint(color, state));
    if (head <= 0) return 0;
    const path = NarduGame.pathFor(color, state);
    const runs = headBlockadeRuns(state, color);
    if (!runs.length) return 0;
    let score = 0;
    runs.forEach(run => {
      const pressure = headFootholdPressure(state, color, run);
      let immediateOwn = 0;
      [1, 2, 3].forEach(offset => {
        const index = run.end + offset;
        if (index >= path.length || index > 15) return;
        const point = path[index];
        const data = state.points?.[point];
        const weight = offset === 1 ? 3.2 : offset === 2 ? 1.6 : 0.8;
        if (data?.color === color) {
          if (offset === 1) immediateOwn = data.count || 0;
          const made = data.count >= 2;
          score += weight * (made ? 2600000 : 820000) * pressure;
          score += Math.min(4, data.count || 0) * weight * 180000 * pressure;
          if (data.count > 4) score -= Math.pow(data.count - 4, 2) * weight * 180000;
        } else if (!data) {
          score -= weight * 720000 * pressure;
        } else {
          score -= weight * (data.count >= 2 ? 2400000 : 1550000) * pressure;
        }
      });
      if (!immediateOwn) score -= (5200000 + head * 620000 + run.length * 850000) * pressure;
      else if (immediateOwn === 1) score -= (900000 + run.length * 260000) * pressure;
    });
    return score;
  }

  function headFootholdStrategyScore(before, next, color, sequence = []) {
    const head = countAt(before, NarduGame.headPoint(color, before));
    if (head <= 0) return 0;
    const path = NarduGame.pathFor(color, before);
    const runs = headBlockadeRuns(before, color);
    if (!runs.length) return 0;
    let score = headFootholdScore(next, color) - headFootholdScore(before, color);

    runs.forEach(run => {
      const pressure = headFootholdPressure(before, color, run);
      [1, 2].forEach(offset => {
        const index = run.end + offset;
        if (index >= path.length || index > 15) return;
        const point = path[index];
        const beforeCount = before.points?.[point]?.color === color ? before.points[point].count || 0 : 0;
        const nextCount = next.points?.[point]?.color === color ? next.points[point].count || 0 : 0;
        const usedFromFoothold = sequence.filter(move => Number(move.from) === Number(point)).length;
        const weight = offset === 1 ? 3.2 : 1.6;
        if (nextCount > beforeCount) {
          score += (beforeCount === 0 ? 3200000 : 1700000) * weight * pressure;
          if (beforeCount < 2 && nextCount >= 2) score += 4200000 * weight * pressure;
        }
        if (usedFromFoothold && beforeCount > 0) {
          score -= usedFromFoothold * (2200000 + head * 420000 + run.length * 360000) * weight * pressure;
          if (nextCount < beforeCount) score -= (2600000 + head * 520000) * weight * pressure;
          if (nextCount <= 0) score -= (6200000 + head * 820000 + run.length * 900000) * weight * pressure;
          if (beforeCount >= 2 && nextCount < 2) score -= (5200000 + head * 620000) * weight * pressure;
        }
      });
    });
    return score;
  }

  function uniqueDice(state) {
    return [...new Set((state.dice || state.rolled || []).map(Number).filter(Boolean))];
  }

  function legalHeadDice(state, color) {
    const head = NarduGame.headPoint(color, state);
    return uniqueDice(state).filter(die => NarduGame.isValidMove(state, head, die));
  }

  function sequenceHeadDice(state, color, sequence) {
    const head = NarduGame.headPoint(color, state);
    return sequence.filter(move => Number(move.from) === head).map(move => Number(move.die));
  }

  function headDisciplineScore(before, next, color, sequence) {
    const head = NarduGame.headPoint(color, before);
    const headCheckers = countAt(before, head);
    if (headCheckers <= 3) return 0;

    const legal = legalHeadDice(before, color);
    if (!legal.length) return 0;
    const oddLegal = legal.filter(die => die === 1 || die === 3 || die === 5);
    const played = sequenceHeadDice(before, color, sequence);
    const playedOdd = played.some(die => die === 1 || die === 3 || die === 5);
    const playedAny = played.length > 0;
    const pressure = 1 + Math.max(0, headCheckers - 4) / 4 + outsideHomeCount(before, color) / 15;

    let score = 0;
    if (oddLegal.length) {
      if (playedOdd) score += 420000 * pressure;
      else score -= 640000 * pressure;
    } else if (playedAny) {
      score += 210000 * pressure;
    } else if (headCheckers > 6) {
      score -= 360000 * pressure;
    }

    const brokeKey = keyHeadLandingBreakPenalty(before, next, color) > 0;
    if (brokeKey && !playedOdd && oddLegal.length) score -= 420000 * pressure;
    if (playedAny) score += (headCheckers - countAt(next, head)) * 160000 * pressure;
    return score;
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

  function developmentReadiness(state, color) {
    return forwardAttackScore(state, color) * 0.34
      + defensiveBridgeScore(state, color) * 0.26
      + opponentRouteControlScore(state, color) * 0.018
      + madeInRange(state, color, 5, 17) * 185
      + occupiedInRange(state, color, 5, 17) * 64;
  }

  function developmentDebt(state, color) {
    if ((state.off?.[color] || 0) > 0 || NarduGame.homeReady(state, color)) return 0;
    const head = countAt(state, NarduGame.headPoint(color, state));
    const outside = outsideHomeCount(state, color);
    if (head <= 3 && outside <= 5) return 0;
    const readiness = developmentReadiness(state, color);
    return 1
      + Math.max(0, head - 3) / 2.6
      + Math.max(0, outside - 6) / 14
      + Math.max(0, 260 - readiness) / 140;
  }

  function prematureRunnerPenalty(state, color) {
    const debt = developmentDebt(state, color);
    if (debt <= 0) return 0;
    const head = countAt(state, NarduGame.headPoint(color, state));
    let penalty = 0;

    Object.entries(state.points || {}).forEach(([point, data]) => {
      if (data.color !== color) return;
      const pos = NarduGame.pathPos(color, Number(point), state);
      const count = data.count || 0;
      if (pos >= 10 && pos < 18) {
        const advance = pos - 9;
        const singleWeight = count === 1 ? 1.65 : 0.46;
        penalty += advance * advance * Math.max(1, count) * 120000 * singleWeight * debt;
        if (count === 1 && head > 6) penalty += 620000 * debt;
      }
      if (pos >= 18) {
        const homeAdvance = pos - 17;
        penalty += homeAdvance * homeAdvance * count * 220000 * debt;
        if (count === 1) penalty += 950000 * debt;
        if (count > 3) penalty += Math.pow(count - 3, 2) * 720000 * debt;
      }
    });

    return penalty;
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

  function marsRacePressure(state, color) {
    const opponent = NarduGame.opponentOf(color);
    const ownOff = state.off?.[color] || 0;
    const ownOutside = outsideHomeCount(state, color);
    if (ownOff > 0 || ownOutside <= 0) return 0;

    const opponentHead = countAt(state, NarduGame.headPoint(opponent, state));
    const opponentOff = state.off?.[opponent] || 0;
    const opponentHome = homeCount(state, opponent);
    const opponentPips = NarduGame.pipsFor(state, opponent);
    const ownPips = NarduGame.pipsFor(state, color);

    let pressure = 0;
    pressure += Math.max(0, 8 - opponentHead) * 55;
    pressure += Math.max(0, opponentHome - 5) * 28;
    pressure += opponentOff * 150;
    pressure += Math.max(0, 145 - opponentPips) * 2.8;
    if (NarduGame.homeReady(state, opponent)) pressure += 300;
    if (ownOutside <= 2) pressure += 210;
    if (ownPips > opponentPips + 35) pressure += 120;
    return pressure;
  }

  function emergencyActive(state, color) {
    return emergencyPressure(state, color) + marsRacePressure(state, color) >= 120;
  }

  function sequenceProgressStats(before, color, sequence) {
    const preview = cloneState(before);
    const outsideBefore = outsideHomeCount(before, color);
    const outsidePipsBefore = outsideHomePips(before, color);
    const outsidePositions = Object.entries(before.points || {})
      .filter(([, data]) => data.color === color)
      .map(([point]) => NarduGame.pathPos(color, Number(point), before))
      .filter(pos => pos >= 0 && pos < 18);
    const deepestBefore = outsidePositions.length ? Math.min(...outsidePositions) : 24;
    let outsideMoves = 0;
    let homeShuffleMoves = 0;
    let enterHomeMoves = 0;
    let developmentMoves = 0;
    let attackBuildMoves = 0;
    let deepestMoves = 0;
    let laggardGain = 0;

    sequence.forEach(move => {
      const fromPos = NarduGame.pathPos(color, Number(move.from), preview);
      const to = move.bearOff ? 0 : NarduGame.moveTo(color, move.from, move.die, preview);
      const target = to === 0 ? null : preview.points?.[to];
      const toPos = to === 0 ? 24 : NarduGame.pathPos(color, Number(to), preview);
      if (fromPos >= 0 && fromPos < 18) {
        outsideMoves += 1;
        if (fromPos <= deepestBefore + 2) deepestMoves += 1;
        laggardGain += Math.max(0, 18 - fromPos) * Math.max(0, toPos - fromPos);
        if (toPos >= 18) enterHomeMoves += 1;
        if (toPos >= 5 && toPos < 18) {
          developmentMoves += 1 + Math.max(0, toPos - 5) / 8;
          if (target?.color === color && target.count === 1) attackBuildMoves += 1;
        }
      }
      if (fromPos >= 18 && toPos >= 18 && outsideHomeCount(preview, color) > 0) homeShuffleMoves += 1;
      NarduGame.applyMove(preview, move.from, move.die, { autoEnd: false });
    });
    const afterPositions = Object.entries(preview.points || {})
      .filter(([, data]) => data.color === color)
      .map(([point]) => NarduGame.pathPos(color, Number(point), preview))
      .filter(pos => pos >= 0 && pos < 18);

    return {
      outsideBefore,
      outsideAfter: outsideHomeCount(preview, color),
      outsidePipsGain: outsidePipsBefore - outsideHomePips(preview, color),
      outsideMoves,
      homeShuffleMoves,
      enterHomeMoves,
      developmentMoves,
      attackBuildMoves,
      deepestBefore,
      deepestAfter: afterPositions.length ? Math.min(...afterPositions) : 24,
      deepestMoves,
      laggardGain,
    };
  }

  function bearingOffRaceScore(before, next, color, sequence = []) {
    if (!NarduGame.homeReady(before, color)) return 0;
    const offGain = (next.off?.[color] || 0) - (before.off?.[color] || 0);
    const pipGain = NarduGame.pipsFor(before, color) - NarduGame.pipsFor(next, color);
    const opponent = NarduGame.opponentOf(color);
    const opponentOff = before.off?.[opponent] || 0;
    const opponentReady = NarduGame.homeReady(before, opponent);
    const pressure = 1 + opponentOff / 3 + (opponentReady ? 2.4 : 0);
    let homeShuffleMoves = 0;
    let nonBearHomePips = 0;

    sequence.forEach(move => {
      const fromPos = NarduGame.pathPos(color, Number(move.from), before);
      if (move.bearOff) return;
      const to = NarduGame.moveTo(color, move.from, move.die, before);
      const toPos = to === 0 ? 24 : NarduGame.pathPos(color, Number(to), before);
      if (fromPos >= 18 && toPos >= 18) {
        homeShuffleMoves += 1;
        nonBearHomePips += Math.max(1, toPos - fromPos);
      }
    });

    return offGain * (180000000 + pressure * 26000000)
      + pipGain * (4200000 + pressure * 420000)
      - NarduGame.pipsFor(next, color) * (620000 + pressure * 90000)
      - homeShuffleMoves * (26000000 + pressure * 7000000)
      - nonBearHomePips * (1100000 + pressure * 220000)
      - homeTowerPenalty(next, color) * 22000;
  }

  function chooseBearingOffSequence(state, color, sequences) {
    const maxOffMoves = Math.max(0, ...sequences.map(sequence => (
      sequence.reduce((total, move) => total + (move.bearOff ? 1 : 0), 0)
    )));
    const candidates = sequences
      .filter(sequence => sequence.reduce((total, move) => total + (move.bearOff ? 1 : 0), 0) === maxOffMoves)
      .sort((a, b) => roughBearingPips(state, color, b) - roughBearingPips(state, color, a))
      .slice(0, PREFILTER_SEQUENCE_LIMIT);

    return candidates
      .map(sequence => {
        const next = applySequence(state, sequence);
        return {
          sequence,
          offGain: (next.off?.[color] || 0) - (state.off?.[color] || 0),
          pipsAfter: NarduGame.pipsFor(next, color),
          score: bearingOffRaceScore(state, next, color, sequence),
        };
      })
      .sort((a, b) => (
        b.offGain - a.offGain
        || b.score - a.score
        || a.pipsAfter - b.pipsAfter
      ))[0]?.sequence || [];
  }

  function roughBearingPips(state, color, sequence) {
    return sequence.reduce((total, move) => {
      if (move.bearOff) return total + Math.max(1, 24 - NarduGame.pathPos(color, Number(move.from), state)) + 8;
      return total + Number(move.die || 0);
    }, 0);
  }

  function lateEscapeScore(before, next, color, sequence = []) {
    const opponent = NarduGame.opponentOf(color);
    const stats = sequenceProgressStats(before, color, sequence);
    if (stats.outsideBefore <= 0) return 0;

    const opponentOff = before.off?.[opponent] || 0;
    const opponentReady = NarduGame.homeReady(before, opponent);
    const lateRace = stats.outsideBefore <= 5 || opponentOff > 0 || opponentReady;
    if (!lateRace) return 0;

    const outsideReduction = stats.outsideBefore - stats.outsideAfter;
    const pressure = 1
      + Math.max(0, 6 - stats.outsideBefore) * 0.6
      + opponentOff * 0.95
      + (opponentReady ? 3.2 : 0);

    let score = 0;
    score += outsideReduction * (18000000 + pressure * 4200000);
    score += stats.outsidePipsGain * (620000 + pressure * 135000);
    score += stats.laggardGain * (720000 + pressure * 130000);
    score += stats.deepestMoves * (5200000 + pressure * 1200000);
    if (stats.outsideBefore > 0 && stats.outsideAfter === 0) score += 36000000 + pressure * 9000000;
    if (stats.outsideMoves <= 0) score -= 22000000 + pressure * 5200000;
    if (stats.deepestBefore <= 8 && stats.deepestMoves <= 0) score -= 26000000 + pressure * 5200000;
    if (stats.homeShuffleMoves > 0) score -= stats.homeShuffleMoves * (14000000 + pressure * 3600000);
    if (stats.enterHomeMoves > 0 && stats.outsideAfter > 0) score -= stats.enterHomeMoves * (9000000 + pressure * 2200000);
    score -= Math.max(0, homeTowerPenalty(next, color) - homeTowerPenalty(before, color)) * (52000 + pressure * 12000);
    return score;
  }

  function outsideMobilityScore(state, color) {
    const path = NarduGame.pathFor(color, state);
    const opponent = NarduGame.opponentOf(color);
    let score = 0;

    Object.entries(state.points || {}).forEach(([point, data]) => {
      if (data.color !== color) return;
      const pos = NarduGame.pathPos(color, Number(point), state);
      if (pos < 0 || pos >= 18) return;
      let options = 0;
      let progress = 0;
      for (let die = 1; die <= 6; die += 1) {
        const to = path[pos + die];
        if (!to) continue;
        const target = state.points?.[to];
        if (target?.color === opponent) continue;
        options += 1;
        progress += die;
      }
      const pressure = 1 + Math.max(0, 10 - pos) / 4;
      const count = data.count || 0;
      score += count * options * options * 420 * pressure;
      score += count * progress * 95 * pressure;
      if (options <= 0) score -= count * (28000 + Math.max(0, 12 - pos) * 4200);
      else if (options === 1) score -= count * (7600 + Math.max(0, 10 - pos) * 1600);
    });

    return score;
  }

  function outsideMobilityStrategyScore(before, next, color, sequence = []) {
    const outsideBefore = outsideHomeCount(before, color);
    if (outsideBefore <= 0) return 0;
    const outsideAfter = outsideHomeCount(next, color);
    const opponent = NarduGame.opponentOf(color);
    const opponentOff = before.off?.[opponent] || 0;
    const opponentHome = homeCount(before, opponent);
    const pressure = 1
      + Math.max(0, 7 - outsideBefore) * 0.75
      + opponentOff * 0.8
      + Math.max(0, opponentHome - 8) * 0.28;
    const beforeMobility = outsideMobilityScore(before, color);
    const afterMobility = outsideMobilityScore(next, color);
    const stats = sequenceProgressStats(before, color, sequence);

    let score = (afterMobility - beforeMobility) * (850 + pressure * 180);
    score += (outsideBefore - outsideAfter) * (7200000 + pressure * 2100000);
    if (outsideAfter > 0 && afterMobility < beforeMobility) {
      score -= (beforeMobility - afterMobility) * (1200 + pressure * 260);
    }
    if (outsideAfter > 0 && afterMobility < 12000) {
      score -= (12000 - afterMobility) * (900 + pressure * 240);
    }
    if (stats.homeShuffleMoves > 0 && outsideAfter > 0) {
      score -= stats.homeShuffleMoves * (6200000 + pressure * 1600000);
    }
    if (stats.enterHomeMoves > 0 && outsideAfter > 0 && afterMobility < beforeMobility + 8000) {
      score -= stats.enterHomeMoves * (5200000 + pressure * 1200000);
    }
    return score;
  }

  function developmentStrategyScore(before, next, color, sequence = []) {
    const debt = developmentDebt(before, color);
    if (debt <= 0) return 0;
    const stats = sequenceProgressStats(before, color, sequence);
    const attackGain = forwardAttackScore(next, color) - forwardAttackScore(before, color);
    const bridgeGain = defensiveBridgeScore(next, color) - defensiveBridgeScore(before, color);
    const routeGain = opponentRouteControlScore(next, color) - opponentRouteControlScore(before, color);
    const madeGain = madeInRange(next, color, 5, 17) - madeInRange(before, color, 5, 17);
    const occupiedGain = occupiedInRange(next, color, 5, 17) - occupiedInRange(before, color, 5, 17);
    const homeGain = countInRange(next, color, 18, 23) - countInRange(before, color, 18, 23);
    const runnerPenaltyBefore = prematureRunnerPenalty(before, color);
    const runnerPenaltyAfter = prematureRunnerPenalty(next, color);
    const readinessAfter = developmentReadiness(next, color);
    const outsideBefore = outsideHomeCount(before, color);
    const head = countAt(before, NarduGame.headPoint(color, before));

    let score = 0;
    score += (runnerPenaltyBefore - runnerPenaltyAfter) * 1.15;
    score += Math.max(0, attackGain) * 22000 * debt;
    score += Math.max(0, bridgeGain) * 15000 * debt;
    score += Math.max(0, routeGain) * 1800 * debt;
    score += madeGain * 1700000 * debt;
    score += occupiedGain * 420000 * debt;
    score += stats.developmentMoves * (780000 + Math.max(0, head - 5) * 145000);
    score += stats.attackBuildMoves * (2400000 + Math.max(0, head - 5) * 320000);

    if (outsideBefore > 0) {
      score -= stats.homeShuffleMoves * (1800000 + debt * 420000);
      score -= stats.enterHomeMoves * (5200000 + Math.max(0, head - 4) * 900000);
      if (homeGain > 0 && readinessAfter < 300) {
        score -= homeGain * (2100000 + Math.max(0, 300 - readinessAfter) * 14000) * Math.min(2.4, debt / 2);
      }
      if (stats.developmentMoves <= 0 && stats.enterHomeMoves > 0) {
        score -= 8200000 + stats.enterHomeMoves * 5200000;
      }
    }

    return score;
  }

  function sequenceDevelopmentPriority(state, color, sequence = []) {
    const debt = developmentDebt(state, color);
    if (debt <= 0) return 0;
    const next = applySequence(state, sequence);
    const stats = sequenceProgressStats(state, color, sequence);
    const head = NarduGame.headPoint(color, state);
    const headMoves = sequence.filter(move => Number(move.from) === Number(head)).length;
    const readinessGain = developmentReadiness(next, color) - developmentReadiness(state, color);
    const runnerReduction = prematureRunnerPenalty(state, color) - prematureRunnerPenalty(next, color);

    return runnerReduction * 0.0018
      + readinessGain * 18
      + stats.developmentMoves * 5200
      + stats.attackBuildMoves * 14000
      + stats.outsidePipsGain * 180
      + stats.laggardGain * 90
      + (stats.outsideBefore <= 5 ? stats.outsideMoves * 9000 + stats.deepestMoves * 14000 : 0)
      + headMoves * (4200 + Math.max(0, countAt(state, head) - 5) * 700)
      - stats.enterHomeMoves * (22000 + Math.max(0, countAt(state, head) - 5) * 2600)
      - stats.homeShuffleMoves * 16000;
  }

  function raceRescueScore(before, next, color, sequence = []) {
    const pressure = marsRacePressure(before, color);
    if (pressure <= 0) return 0;

    const stats = sequenceProgressStats(before, color, sequence);
    const opponent = NarduGame.opponentOf(color);
    const opponentOff = before.off?.[opponent] || 0;
    const outsideReduction = stats.outsideBefore - stats.outsideAfter;
    const offGain = (next.off?.[color] || 0) - (before.off?.[color] || 0);
    let score = 0;
    score += outsideReduction * (820000 + pressure * 5200 + opponentOff * 1200000);
    score += stats.outsidePipsGain * (78000 + pressure * 950);
    score += stats.laggardGain * (94000 + pressure * 620);
    score += offGain * (12000000 + pressure * 26000);
    if (stats.outsideBefore > 0 && stats.outsideAfter === 0) score += 9000000 + pressure * 36000;
    if (stats.outsideBefore <= 2 && opponentOff >= 6) {
      score += outsideReduction * (5200000 + opponentOff * 650000);
      if (outsideReduction <= 0) score -= 2600000 + pressure * 13000 + opponentOff * 420000;
    }
    if (!NarduGame.homeReady(before, color) && NarduGame.homeReady(next, color)) score += 6500000 + pressure * 24000;
    if (stats.outsideMoves === 0 && stats.outsideBefore > 0) score -= 1600000 + pressure * 9000;
    if (stats.deepestBefore <= 8 && stats.deepestMoves === 0) score -= 2600000 + pressure * 11000;
    if (stats.deepestAfter <= stats.deepestBefore && stats.deepestBefore <= 8) score -= 1200000 + pressure * 5200;
    if (stats.homeShuffleMoves > 0 && stats.outsideBefore > 0) {
      score -= stats.homeShuffleMoves * (1150000 + pressure * 8200);
    }
    if ((next.off?.[color] || 0) === 0 && (next.off?.[NarduGame.opponentOf(color)] || 0) > 0) {
      score -= 5000000 + pressure * 18000;
    }
    return score;
  }

  function survivalScore(before, next, color, sequence = []) {
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
    const debt = developmentDebt(before, color);
    const developmentStats = debt > 0 ? sequenceProgressStats(before, color, sequence) : null;

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
    score += keyHeadLandingGain(before, next, color) * 0.9;
    score -= keyHeadLandingBreakPenalty(before, next, color) * 2.4;
    score -= headSixSourcePenalty(before, next, color, sequence) * 2.8;
    score += headExitStrategyScore(before, next, color, sequence) * 2.2;
    score += headFootholdStrategyScore(before, next, color, sequence) * 2.6;
    score += (headSixReserveScore(next, color) - headSixReserveScore(before, color)) * 1.6;
    if (!nextOff && opponentOff > 0) score -= 7000000 + opponentOff * 4100000;
    if (NarduGame.homeReady(next, opponent) && !nextOff) score -= 9000000;
    score -= opponentFenceThreat(next, color) * 12000;
    score += raceRescueScore(before, next, color, sequence);
    score += lateEscapeScore(before, next, color, sequence);
    score += outsideMobilityStrategyScore(before, next, color, sequence);
    score += bearingOffRaceScore(before, next, color, sequence);
    score += developmentStrategyScore(before, next, color, sequence) * 1.35;
    if (developmentStats) {
      score += developmentStats.developmentMoves * (9000000 + pressure * 38000);
      score += developmentStats.attackBuildMoves * (18000000 + pressure * 64000);
      if (developmentStats.enterHomeMoves > 0) {
        score -= developmentStats.enterHomeMoves * (16000000 + pressure * 52000);
        if (developmentStats.developmentMoves <= 0) score -= 22000000 + pressure * 90000;
      }
    }
    score -= Math.max(0, prematureRunnerPenalty(next, color) - prematureRunnerPenalty(before, color))
      * (2.6 + Math.min(3, pressure / 140));
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
    score += headSixReserveScore(state, color) * profile.preserveHeadLandings;
    score += headExitSecurityScore(state, color) * profile.headEscape;
    score += headFootholdScore(state, color) * profile.headEscape;
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
    score -= prematureRunnerPenalty(state, color) * 2.2 * profile.avoidRush;
    score += developmentReadiness(state, color) * 420 * profile.routeControl;
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
      - keyHeadLandingBreakPenalty(state, next, color) * profile.preserveHeadLandings
      - headSixSourcePenalty(state, next, color, sequence) * profile.preserveHeadLandings
      + headExitStrategyScore(state, next, color, sequence) * profile.headEscape
      + headFootholdStrategyScore(state, next, color, sequence) * profile.headEscape
      + headDisciplineScore(state, next, color, sequence) * profile.preserveHeadLandings
      + developmentStrategyScore(state, next, color, sequence) * profile.avoidRush
      + raceRescueScore(state, next, color, sequence)
      + lateEscapeScore(state, next, color, sequence)
      + outsideMobilityStrategyScore(state, next, color, sequence)
      + bearingOffRaceScore(state, next, color, sequence);
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
    if ((state?.variant || 'long') === 'long' && window.NarduLongBotEngine?.plan) {
      try {
        const enginePlan = window.NarduLongBotEngine.plan(state, {
          maxCandidates: PREFILTER_SEQUENCE_LIMIT,
          timeLimitMs: PLAN_TIME_LIMIT_MS,
          weights: longEngineWeights(),
        });
        if (enginePlan?.length) return enginePlan;
      } catch (error) {
        console.warn('Long bot engine failed, falling back to strong bot', error?.message || error);
      }
    }

    const startedAt = Date.now();
    const overBudget = () => Date.now() - startedAt > PLAN_TIME_LIMIT_MS;
    const color = state.turn;
    const sequences = NarduGame.bestMoveSequences(state, color).filter(sequence => sequence.length);
    if (!sequences.length) return [];
    if (NarduGame.homeReady(state, color)) {
      return chooseBearingOffSequence(state, color, sequences)
        .map(move => ({ from: move.from, die: move.die }));
    }

    const emergency = emergencyActive(state, color);
    const base = NarduGame.chooseBotSequence?.(state, color, { difficulty: 'hard' }) || [];
    const poolLimit = emergency ? PREFILTER_SEQUENCE_LIMIT : Math.min(DEEP_SEQUENCE_LIMIT, PREFILTER_SEQUENCE_LIMIT);
    const wideTree = sequences.length > poolLimit;
    const pool = wideTree
      ? sequences
        .map(sequence => ({ sequence, priority: sequenceDevelopmentPriority(state, color, sequence) }))
        .sort((a, b) => b.priority - a.priority)
        .slice(0, poolLimit)
        .map(item => item.sequence)
      : sequences;
    const candidateCap = emergency ? Math.max(CANDIDATE_LIMIT * 4, 72) : CANDIDATE_LIMIT;
    const ranked = pool
      .map(sequence => ({ sequence, score: quickScore(state, color, sequence) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateCap);
    if (base.length) ranked.push({ sequence: base, score: quickScore(state, color, base) });
    if (overBudget()) {
      return ranked
        .sort((a, b) => b.score - a.score)[0]
        .sequence
        .map(move => ({ from: move.from, die: move.die }));
    }
    if (emergency) {
      return ranked
        .map(item => {
          const next = applySequence(state, item.sequence);
          return { sequence: item.sequence, score: survivalScore(state, next, color, item.sequence) };
        })
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

    let best = ranked[0];
    for (const item of ranked) {
      if (overBudget()) break;
      const next = applySequence(state, item.sequence);
      const replyRisk = opponentReplyRisk(next, color);
      const score = item.score - replyRisk;
      if (!best || score > best.score) best = { sequence: item.sequence, score };
    }
    return best
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
    profile.headEscape = clamp(profile.headEscape + lossPressure * danger * (1 + botHead / 8 + headExitPressure(state, botColor) / 5), 1.05, 2.2);
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
