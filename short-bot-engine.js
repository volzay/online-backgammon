/* generated from bot-engine/short/*.ts */
(function () {
  'use strict';

/* bot-engine/short/metrics.ts */
function shortMetrics(state, color) {
  const opponent = NarduGame.opponentOf(color);
  const path = NarduGame.pathFor(color, state);
  let made = 0;
  let homeMade = 0;
  let homeCheckers = Number(state.off?.[color]) || 0;
  let blots = 0;
  let exposure = 0;
  let stacks = 0;
  let anchors = 0;
  let anchorValue = 0;
  let longestPrime = 0;
  let run = 0;

  path.forEach((point, pos) => {
    const stack = state.points?.[point];
    if (stack?.color !== color) {
      run = 0;
      return;
    }
    if (pos >= 18) homeCheckers += stack.count;
    if (stack.count >= 2) {
      made += 1;
      run += 1;
      longestPrime = Math.max(longestPrime, run);
      if (pos >= 18) homeMade += 1;
      if (pos <= 5) {
        anchors += 1;
        anchorValue += 7 - pos;
      }
    } else {
      run = 0;
      blots += 1;
      exposure += blotRisk(state, color, point, pos);
    }
    const excess = Math.max(0, stack.count - (pos >= 18 ? 5 : 4));
    stacks += excess * excess;
  });

  return {
    pips: NarduGame.pipsFor(state, color),
    off: Number(state.off?.[color]) || 0,
    bar: Number(state.bar?.[color]) || 0,
    opponentBar: Number(state.bar?.[opponent]) || 0,
    made,
    homeMade,
    homeCheckers,
    blots,
    exposure,
    stacks,
    anchors,
    anchorValue,
    longestPrime,
  };
}

function blotRisk(state, color, point, pos = NarduGame.pathPos(color, point, state)) {
  const opponent = NarduGame.opponentOf(color);
  let hittingDice = 0;
  const sources = Number(state.bar?.[opponent]) > 0
    ? [NarduGame.barPoint(opponent)]
    : Object.entries(state.points || {})
      .filter(([, stack]) => stack.color === opponent)
      .map(([source]) => Number(source));
  for (let die = 1; die <= 6; die += 1) {
    if (sources.some(source => NarduGame.moveTo(opponent, source, die, state) === Number(point))) {
      hittingDice += 1;
    }
  }
  if (!hittingDice) return 2 + (pos >= 18 ? 3 : 0);
  const zone = pos >= 18 ? 2.2 : pos <= 5 ? 1.35 : 1.7;
  return 8 + hittingDice * 11 * zone;
}

function shortPhase(state, color) {
  const opponent = NarduGame.opponentOf(color);
  if ((state.bar?.[color] || 0) > 0 || (state.bar?.[opponent] || 0) > 0) return 'bar';
  if (NarduGame.homeReady(state, color)) return 'bearoff';
  const own = shortMetrics(state, color);
  const other = shortMetrics(state, opponent);
  if (own.exposure || other.exposure || own.anchors || other.anchors) return 'contact';
  return 'race';
}



/* bot-engine/short/engine.ts */
const SHORT_REPLY_ROLLS = [];
for (let first = 1; first <= 6; first += 1) {
  for (let second = first; second <= 6; second += 1) {
    SHORT_REPLY_ROLLS.push({
      dice: first === second ? [first, first, first, first] : [first, second],
      probability: first === second ? 1 / 36 : 2 / 36,
    });
  }
}

function clampShort(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cloneShortState(state) {
  return JSON.parse(JSON.stringify(state || {}));
}

function terminalShortScore(state, color) {
  if (!state?.winner) return null;
  if (state.winner === color) return 1_000_000_000;
  const opponent = NarduGame.opponentOf(color);
  const severity = state.resultType === 'koks' ? 3 : state.resultType === 'mars' ? 2 : 1;
  const ownOff = Number(state.off?.[color]) || 0;
  const opponentOff = Number(state.off?.[opponent]) || 0;
  return -1_000_000_000 - severity * 80_000_000 + ownOff * 2_000_000 - opponentOff * 500_000;
}

function createShortBotEngine(adapter, options = {}) {
  const experience = new Map();
  const experienceSources = new Map();

  function evaluateState(state, color) {
    const terminal = terminalShortScore(state, color);
    if (terminal !== null) return terminal;
    const opponent = NarduGame.opponentOf(color);
    const own = shortMetrics(state, color);
    const other = shortMetrics(state, opponent);
    const raceLead = other.pips - own.pips;
    const contact = shortPhase(state, color) !== 'race';
    const ownBoard = own.homeMade * own.homeMade * 9500;
    const otherBoard = other.homeMade * other.homeMade * 9500;
    const barValue = (
      other.bar * (52000 + own.homeMade * 17000)
      - own.bar * (65000 + other.homeMade * 21000)
    );
    const resultSafety = own.off === 0
      ? -(other.off * 24000 + (other.off >= 8 ? 90000 : 0))
      : own.off * 19000;
    return raceLead * (contact ? 1180 : 2050)
      + (own.off - other.off) * 150000
      + barValue
      + (own.made - other.made) * 10500
      + ownBoard - otherBoard
      + (own.longestPrime ** 3 - other.longestPrime ** 3) * 3900
      + (other.exposure - own.exposure) * 7600
      + (own.anchorValue - other.anchorValue) * 5200
      + (other.stacks - own.stacks) * 4400
      + resultSafety;
  }

  function positionFeatures(before, after, color, sequence) {
    const opponent = NarduGame.opponentOf(color);
    const ownBefore = shortMetrics(before, color);
    const ownAfter = shortMetrics(after, color);
    const otherBefore = shortMetrics(before, opponent);
    const otherAfter = shortMetrics(after, opponent);
    const hits = Math.max(0, otherAfter.bar - otherBefore.bar);
    const entries = Math.max(0, ownBefore.bar - ownAfter.bar);
    const offGain = ownAfter.off - ownBefore.off;
    return {
      pipsGain: ownBefore.pips - ownAfter.pips,
      hits,
      entries,
      offGain,
      madeGain: ownAfter.made - ownBefore.made,
      homeMadeGain: ownAfter.homeMade - ownBefore.homeMade,
      primeGain: ownAfter.longestPrime - ownBefore.longestPrime,
      exposureDelta: ownAfter.exposure - ownBefore.exposure,
      opponentExposureGain: otherAfter.exposure - otherBefore.exposure,
      anchorDelta: ownAfter.anchorValue - ownBefore.anchorValue,
      stackDelta: ownAfter.stacks - ownBefore.stacks,
      ownBarAfter: ownAfter.bar,
      opponentBarAfter: otherAfter.bar,
      homeShuffleMoves: sequence.filter(move => (
        !move.bearOff
        && NarduGame.pathPos(color, move.from, before) >= 18
        && NarduGame.pathPos(color, move.to, before) >= 18
      )).length,
    };
  }

  function descriptor(state, color, features) {
    const opponent = NarduGame.opponentOf(color);
    const own = shortMetrics(state, color);
    const other = shortMetrics(state, opponent);
    const lead = clampShort(Math.round((other.pips - own.pips) / 20), -4, 4);
    const contextKey = [
      shortPhase(state, color),
      `lead:${lead}`,
      `bar:${Math.min(2, own.bar)}-${Math.min(2, other.bar)}`,
      `board:${Math.min(6, own.homeMade)}-${Math.min(6, other.homeMade)}`,
      `off:${Math.min(3, Math.floor(own.off / 5))}-${Math.min(3, Math.floor(other.off / 5))}`,
    ].join('|');
    const actionKey = [
      `hit:${Math.min(2, features.hits)}`,
      `enter:${Math.min(2, features.entries)}`,
      `off:${Math.min(2, features.offGain)}`,
      `make:${clampShort(features.madeGain, -1, 2)}`,
      `prime:${clampShort(features.primeGain, -1, 2)}`,
      `risk:${clampShort(Math.round(features.exposureDelta / 25), -3, 3)}`,
    ].join('|');
    const mistakeSeverity = Math.max(
      0,
      features.ownBarAfter * 1.3
      + Math.max(0, features.exposureDelta) / 35
      + Math.max(0, -features.madeGain) * 0.75
      + Math.max(0, features.stackDelta) * 0.25
      + (features.homeShuffleMoves > 0 && features.offGain === 0 ? 0.65 : 0),
    );
    return { phase: shortPhase(state, color), contextKey, actionKey, mistakeSeverity };
  }

  function experienceAdjustment(item) {
    const pattern = experience.get(`${item.experience.contextKey}::${item.experience.actionKey}`);
    if (!pattern) return 0;
    const samples = Math.max(1, Number(pattern.samples) || 1);
    const wins = Number(pattern.wins) || 0;
    const losses = Number(pattern.losses) || 0;
    const winWeight = Number(pattern.winWeight) || wins;
    const lossWeight = Number(pattern.lossWeight) || losses;
    const confidence = Math.min(1, Math.log2(samples + 1) / 4);
    return clampShort((winWeight - lossWeight * 1.15) / samples * 13000 * confidence, -18000, 18000);
  }

  function baseCandidate(state, color, sequence, baseline = false) {
    const after = adapter.applySequence(state, sequence, color);
    const features = positionFeatures(state, after, color, sequence);
    const exp = descriptor(state, color, features);
    let score = evaluateState(after, color);
    score += features.hits * 21000;
    score += features.entries * 17000;
    score += features.offGain * 28000;
    score += features.madeGain * 9000;
    score += features.homeMadeGain * 14000;
    score += features.primeGain * 12000;
    score -= Math.max(0, features.exposureDelta) * 2600;
    score -= Math.max(0, features.stackDelta) * 3500;
    if (features.homeShuffleMoves && features.offGain === 0 && !NarduGame.homeReady(state, color)) score -= 26000;
    if (baseline) score += 18000;
    return { sequence, after, features, experience: exp, baseline, baseScore: score, score };
  }

  function analyzeReplies(candidate, color, runtimeOptions) {
    const opponent = NarduGame.opponentOf(color);
    const replyLimit = Math.max(8, Number(runtimeOptions.replyLimit) || 12);
    let expected = 0;
    let worst = Infinity;
    let blockedProbability = 0;
    SHORT_REPLY_ROLLS.forEach(({ dice, probability }) => {
      const replyState = cloneShortState(candidate.after);
      replyState.turn = opponent;
      replyState.phase = 'move';
      replyState.dice = [...dice];
      replyState.rolled = [...dice];
      replyState.turnMoves = [];
      const replies = adapter.legalSequences(replyState, opponent, { limit: replyLimit });
      let botScore;
      if (!replies.length) {
        blockedProbability += probability;
        botScore = evaluateState(replyState, color) + 28000;
      } else {
        botScore = Math.min(...replies.map(reply => evaluateState(
          adapter.applySequence(replyState, reply, opponent),
          color,
        )));
      }
      expected += botScore * probability;
      worst = Math.min(worst, botScore);
    });
    const tactical = {
      expectedImpact: expected - candidate.baseScore,
      worstImpact: worst - candidate.baseScore,
      rolls: SHORT_REPLY_ROLLS.length,
      blockedProbability,
      plies: 2,
    };
    return {
      ...candidate,
      tactical,
      score: candidate.baseScore * 0.42 + expected * 0.46 + worst * 0.12,
    };
  }

  function rank(state, color, runtimeOptions = {}) {
    const maxCandidates = Math.max(6, Number(runtimeOptions.maxCandidates) || 48);
    const analyzeCount = Math.max(4, Number(runtimeOptions.analyzeCandidates) || 6);
    const sequences = adapter.legalSequences(state, color, { limit: maxCandidates });
    if (!sequences.length) return [];
    const baseline = adapter.baselineSequence?.(state, color) || [];
    if (baseline.length) sequences.push(baseline);
    const unique = new Map();
    sequences.forEach(sequence => {
      const isBaseline = baseline.length > 0
        && JSON.stringify(sequence.map(move => [move.from, move.die]))
          === JSON.stringify(baseline.map(move => [move.from, move.die]));
      const item = baseCandidate(state, color, sequence, isBaseline);
      const signature = JSON.stringify({
        points: item.after.points,
        bar: item.after.bar,
        off: item.after.off,
      });
      const previous = unique.get(signature);
      if (!previous || item.baseScore > previous.baseScore || item.baseline) unique.set(signature, item);
    });
    const prefiltered = Array.from(unique.values())
      .sort((left, right) => right.baseScore - left.baseScore);
    const selected = prefiltered.slice(0, analyzeCount);
    const baselineCandidate = prefiltered.find(item => item.baseline);
    if (baselineCandidate && !selected.includes(baselineCandidate)) {
      selected[selected.length - 1] = baselineCandidate;
    }
    return selected
      .map(item => {
        const analyzed = analyzeReplies(item, color, runtimeOptions);
        const adjustment = experienceAdjustment(analyzed);
        return { ...analyzed, experienceAdjustment: adjustment, score: analyzed.score + adjustment };
      })
      .sort((left, right) => right.score - left.score);
  }

  return {
    rank,
    evaluateState,
    describeSequence(state, sequence, color) {
      const item = baseCandidate(state, color, sequence);
      return {
        sequence: item.sequence,
        score: item.score,
        features: item.features,
        experience: item.experience,
      };
    },
    setExperience(patterns, source = 'runtime') {
      const sourcePatterns = new Map();
      (Array.isArray(patterns) ? patterns : []).forEach(pattern => {
        if (pattern?.contextKey && pattern?.actionKey) {
          sourcePatterns.set(`${pattern.contextKey}::${pattern.actionKey}`, { ...pattern });
        }
      });
      experienceSources.set(String(source || 'runtime'), sourcePatterns);
      experience.clear();
      experienceSources.forEach(patternMap => patternMap.forEach((pattern, key) => {
        const previous = experience.get(key);
        if (!previous) {
          experience.set(key, { ...pattern });
          return;
        }
        experience.set(key, {
          ...previous,
          samples: (Number(previous.samples) || 0) + (Number(pattern.samples) || 0),
          losses: (Number(previous.losses) || 0) + (Number(pattern.losses) || 0),
          wins: (Number(previous.wins) || 0) + (Number(pattern.wins) || 0),
          lossWeight: (Number(previous.lossWeight) || 0) + (Number(pattern.lossWeight) || 0),
          severeLosses: (Number(previous.severeLosses) || 0) + (Number(pattern.severeLosses) || 0),
          signalWeight: (Number(previous.signalWeight) || 0) + (Number(pattern.signalWeight) || 0),
          winWeight: (Number(previous.winWeight) || 0) + (Number(pattern.winWeight) || 0),
        });
      }));
      return experience.size;
    },
    experienceSize: () => experience.size,
  };
}


/* bot-engine/short/nardu-game-adapter.ts */
function createShortNarduGameAdapter(game) {
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


/* bot-engine/short/browser.ts */
const SHORT_ENGINE_VERSION = 'short-analytic-v1';

function createBrowserShortBotEngine(game, options = {}) {
  const engine = createShortBotEngine(createShortNarduGameAdapter(game), options);
  let lastDecision = null;
  return {
    plan(state, runtimeOptions = {}) {
      const color = state?.turn;
      if (!state || state.variant !== 'short' || !color) return [];
      const ranked = engine.rank(state, color, runtimeOptions);
      lastDecision = shortDecisionRecord(state, color, ranked, engine.experienceSize());
      return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
    },
    rank(state, runtimeOptions = {}) {
      if (!state || state.variant !== 'short' || !state.turn) return [];
      return engine.rank(state, state.turn, runtimeOptions);
    },
    describeSequence(state, sequence, runtimeOptions = {}) {
      const color = runtimeOptions.color || state?.turn;
      return state && color && sequence?.length
        ? engine.describeSequence(state, sequence, color)
        : null;
    },
    evaluateState: engine.evaluateState,
    setExperience: engine.setExperience,
    experienceSize: engine.experienceSize,
    consumeLastDecision() {
      const decision = lastDecision;
      lastDecision = null;
      return decision;
    },
    version: SHORT_ENGINE_VERSION,
  };
}

function shortDecisionRecord(state, color, ranked, experienceSize) {
  const candidates = ranked.slice(0, 4).map(candidate => ({
    score: Math.round(candidate.score),
    moves: candidate.sequence.map(move => ({
      from: move.from,
      to: move.bearOff ? 0 : move.to,
      die: move.die,
    })),
    features: { ...candidate.features },
    tactical: candidate.tactical ? { ...candidate.tactical } : null,
    experience: { ...candidate.experience },
    experienceAdjustment: Math.round(candidate.experienceAdjustment || 0),
  }));
  if (!candidates.length) return null;
  const source = `${color}|${(state.dice || []).join(',')}|${JSON.stringify(state.points)}|${JSON.stringify(state.bar)}|${JSON.stringify(state.off)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    id: `sb1-${(hash >>> 0).toString(16).padStart(8, '0')}`,
    at: new Date().toISOString(),
    engineVersion: SHORT_ENGINE_VERSION,
    experienceSize,
    color,
    dice: [...(state.dice || [])],
    position: {
      points: JSON.parse(JSON.stringify(state.points || {})),
      bar: { white: Number(state.bar?.white) || 0, dark: Number(state.bar?.dark) || 0 },
      off: { white: Number(state.off?.white) || 0, dark: Number(state.off?.dark) || 0 },
    },
    selected: candidates[0],
    alternatives: candidates.slice(1),
    experience: candidates[0].experience,
  };
}

function installBrowserShortBotEngine(root = globalThis) {
  if (!root?.NarduGame) return null;
  const api = createBrowserShortBotEngine(root.NarduGame);
  root.NarduShortBotEngine = api;
  return api;
}

if (typeof window !== 'undefined') installBrowserShortBotEngine(window);


}());
