const SHORT_ENGINE_VERSION = 'short-analytic-v6';
const SHORT_WILDBG_NEAR_EQUITY_MARGIN = 0.025;
const SHORT_WILDBG_REAR_ESCAPE_EQUITY_MARGIN = 0.1;
const SHORT_WILDBG_EXPERIENCE_EQUITY_SCALE = 900_000;
const SHORT_WILDBG_EQUITY_EPSILON = 0.000001;

export function shortStateToWildbgBoard(game, state, color = state?.turn) {
  if (!game || !state || state.variant !== 'short' || !color) return null;
  const opponent = game.opponentOf(color);
  const board = new Int8Array(26);
  Object.entries(state.points || {}).forEach(([rawPoint, stack]) => {
    const point = Number(rawPoint);
    const pathPosition = game.pathPos(color, point, state);
    const count = Number(stack?.count) || 0;
    if (pathPosition < 0 || pathPosition > 23 || count < 1) return;
    board[24 - pathPosition] = stack.color === color ? count : -count;
  });
  board[25] = Number(state.bar?.[color]) || 0;
  board[0] = -(Number(state.bar?.[opponent]) || 0);
  return board;
}

export function prepareShortWildbgRequest(game, state, color = state?.turn) {
  if (!state || state.variant !== 'short' || !color) return null;
  const dice = (state.dice || []).map(Number);
  const isDouble = dice.length === 4 && dice.every(die => die === dice[0]);
  if ((!isDouble && dice.length !== 2)
    || dice.slice(0, 2).some(die => !Number.isInteger(die) || die < 1 || die > 6)) {
    return null;
  }
  const board = shortStateToWildbgBoard(game, state, color);
  return board ? {
    board,
    die1: dice[0],
    die2: dice[1],
    // The product distinguishes normal, Mars (gammon), and Koks
    // (backgammon) results. Money-game equity preserves those different
    // values; one-pointer scoring deliberately treats them as equal.
    isOnePointer: false,
  } : null;
}

function shortWildbgPlayForSequence(game, adapter, state, color, sequence) {
  let preview = JSON.parse(JSON.stringify(state || {}));
  const play = [];
  (sequence || []).forEach(move => {
    const from = Number(move.from) === game.barPoint(color)
      ? 25
      : 24 - game.pathPos(color, Number(move.from), preview);
    const to = move.bearOff || Number(move.to) === 0
      ? 0
      : 24 - game.pathPos(color, Number(move.to), preview);
    play.push({ from, to });
    preview = adapter.applySequence(preview, [move], color);
  });
  return {
    play,
    position: shortStateToWildbgBoard(game, preview, color),
  };
}

function validWildbgPlay(play) {
  return Array.isArray(play) && play.length > 0 && play.length <= 4 && play.every(step => (
    Number.isInteger(Number(step?.from))
    && Number(step.from) >= 1
    && Number(step.from) <= 25
    && Number.isInteger(Number(step?.to))
    && Number(step.to) >= 0
    && Number(step.to) <= 24
    && Number(step.from) > Number(step.to)
  ));
}

function validWildbgPosition(position) {
  return position && typeof position.length === 'number' && position.length === 26
    && Array.from(position).every(value => Number.isInteger(Number(value))
      && Number(value) >= -15 && Number(value) <= 15);
}

function sameWildbgPlay(left, right) {
  return left.length === right.length && left.every((step, index) => (
    Number(step.from) === Number(right[index]?.from)
    && Number(step.to) === Number(right[index]?.to)
  ));
}

function sameWildbgPosition(left, right) {
  return left && right && left.length === right.length
    && Array.from(left).every((value, index) => Number(value) === Number(right[index]));
}

export function matchShortWildbgAnalysis(game, state, analysis, color = state?.turn, adapter = null) {
  return matchShortWildbgCandidates(game, state, analysis, color, adapter)[0] || null;
}

export function matchShortWildbgCandidates(game, state, analysis, color = state?.turn, adapter = null) {
  const best = analysis?.moves?.[0];
  if (!game || !state || state.variant !== 'short' || !color || !validWildbgPlay(best?.play)) {
    return [];
  }
  const rules = adapter || createShortNarduGameAdapter(game);
  const candidates = rules.legalSequences(state, color, { limit: 0 }).map(sequence => ({
    sequence,
    ...shortWildbgPlayForSequence(game, rules, state, color, sequence),
  }));
  function matchMove(move, wildbgRank) {
    if (!validWildbgPlay(move?.play)) return null;
    const hasPosition = Object.prototype.hasOwnProperty.call(move, 'position');
    if (hasPosition && !validWildbgPosition(move.position)) return null;
    const exact = candidates.find(candidate => sameWildbgPlay(candidate.play, move.play));
    if (exact) {
      if (hasPosition && !sameWildbgPosition(exact.position, move.position)) return null;
      return {
        ...exact,
        match: 'play',
        analysis: move,
        phase: analysis.phase || null,
        wildbgRank,
      };
    }
    if (!hasPosition) return null;
    const byPosition = candidates.find(candidate => sameWildbgPosition(candidate.position, move.position));
    return byPosition ? {
      ...byPosition,
      match: 'position',
      analysis: move,
      phase: analysis.phase || null,
      wildbgRank,
    } : null;
  }
  const first = matchMove(best, 0);
  if (!first) return [];
  const matched = [first];
  (analysis.moves || []).slice(1).forEach((move, index) => {
    const item = matchMove(move, index + 1);
    if (item) matched.push(item);
  });
  return matched;
}

export function createBrowserShortBotEngine(game, options = {}) {
  const adapter = createShortNarduGameAdapter(game);
  const engine = createShortBotEngine(adapter, options);
  let lastDecision = null;

  function analyzer() {
    return options.getWildbgAnalyzer?.() || options.wildbgAnalyzer || null;
  }

  function wildbgValue(matched) {
    if (Number.isFinite(Number(matched?.analysis?.equity))) {
      return Number(matched.analysis.equity);
    }
    return Number.isFinite(Number(matched?.analysis?.score))
      ? Number(matched.analysis.score)
      : null;
  }

  function severeLossProbability(matched) {
    const probabilities = matched?.analysis?.probabilities;
    if (!probabilities) return null;
    const gammon = Number(probabilities.lose_gammon);
    // WildBG's gammon probability already includes backgammons.
    return Number.isFinite(gammon) ? Math.max(0, gammon) : null;
  }

  function assessWildbgCandidates(state, color, analysis) {
    return matchShortWildbgCandidates(game, state, analysis, color, adapter).map(matched => {
      const described = engine.describeSequence(state, matched.sequence, color);
      return {
        matched,
        described,
        equity: wildbgValue(matched),
        severeLossProbability: severeLossProbability(matched),
        after: adapter.applySequence(state, matched.sequence, color),
      };
    });
  }

  function sameTacticalProgress(left, right) {
    return ['pipsGain', 'hits', 'entries', 'offGain'].every(key => (
      Number(left?.[key]) === Number(right?.[key])
    ));
  }

  function structurallyDominatesWildbg(left, right) {
    if (!sameTacticalProgress(left?.described?.features, right?.described?.features)) return false;
    const leftFeatures = left.described.features;
    const rightFeatures = right.described.features;
    const maximize = ['madeGain', 'homeMadeGain', 'primeGain', 'anchorDelta', 'backmostGain'];
    const preserves = maximize.every(key => Number(leftFeatures[key]) >= Number(rightFeatures[key]));
    const safer = Number(leftFeatures.exposureDelta) <= Number(rightFeatures.exposureDelta)
      && Number(leftFeatures.stackDelta) <= Number(rightFeatures.stackDelta);
    if (!preserves || !safer) return false;
    return maximize.some(key => Number(leftFeatures[key]) > Number(rightFeatures[key]))
      || Number(leftFeatures.exposureDelta) < Number(rightFeatures.exposureDelta)
      || Number(leftFeatures.stackDelta) < Number(rightFeatures.stackDelta);
  }

  function rearBlot(state, color) {
    const own = Object.entries(state.points || {})
      .filter(([, stack]) => stack.color === color)
      .map(([point, stack]) => ({
        point: Number(point),
        count: Number(stack.count) || 0,
        pos: game.pathPos(color, Number(point), state),
      }))
      .sort((left, right) => left.pos - right.pos);
    const rear = own[0];
    return rear?.count === 1 && rear.pos <= 5 ? rear : null;
  }

  function replyHitProbability(state, color, point) {
    const opponent = game.opponentOf(color);
    let hitWeight = 0;
    let totalWeight = 0;
    for (let first = 1; first <= 6; first += 1) {
      for (let second = first; second <= 6; second += 1) {
        const weight = first === second ? 1 : 2;
        const reply = JSON.parse(JSON.stringify(state || {}));
        reply.turn = opponent;
        reply.phase = 'move';
        reply.dice = first === second
          ? [first, first, first, first]
          : [first, second];
        reply.rolled = [...reply.dice];
        reply.turnMoves = [];
        const canHit = adapter.legalSequences(reply, opponent, { limit: 0 })
          .some(sequence => sequence.some(move => Number(move.to) === Number(point)));
        if (canHit) hitWeight += weight;
        totalWeight += weight;
      }
    }
    return totalWeight === 36 ? hitWeight / totalWeight : 0;
  }

  function chooseBearoffTie(candidates, selected, phase) {
    if (phase !== 'bearoff' || !Number.isFinite(selected.equity)) return null;
    const tied = candidates.filter(candidate => (
      Number.isFinite(candidate.equity)
      && selected.equity - candidate.equity <= SHORT_WILDBG_EQUITY_EPSILON
    ));
    return tied.sort((left, right) => (
      Number(right.described.features.offGain) - Number(left.described.features.offGain)
      || Number(left.described.features.homeShuffleMoves) - Number(right.described.features.homeShuffleMoves)
      || Number(right.described.features.backmostGain) - Number(left.described.features.backmostGain)
      || right.equity - left.equity
      || left.matched.wildbgRank - right.matched.wildbgRank
    ))[0] || null;
  }

  function chooseCriticalRearEscape(state, color, candidates, selected, phase) {
    if ((phase !== 'contact' && phase !== 'bar') || !Number.isFinite(selected.equity)) return null;
    const rear = rearBlot(state, color);
    if (!rear) return null;
    const selectedHitProbability = replyHitProbability(selected.after, color, rear.point);
    if (selectedHitProbability < 0.45) return null;
    if (selected.after.points?.[rear.point]?.color !== color
      || Number(selected.after.points[rear.point].count) !== 1) return null;
    const opponent = game.opponentOf(color);
    const own = shortMetrics(state, color);
    const other = shortMetrics(state, opponent);
    if (own.off > 0 || (other.off <= 0 && own.pips - other.pips < 15)) return null;
    const selectedSevere = selected.severeLossProbability;
    if (!Number.isFinite(selectedSevere) || selectedSevere < 0.08) return null;
    return candidates
      .filter(candidate => {
        if (!Number.isFinite(candidate.equity)
          || selected.equity - candidate.equity > SHORT_WILDBG_REAR_ESCAPE_EQUITY_MARGIN) return false;
        if (!sameTacticalProgress(candidate.described.features, selected.described.features)) return false;
        const features = candidate.described.features;
        const severe = candidate.severeLossProbability;
        const rearAfter = candidate.after.points?.[rear.point];
        if (rearAfter?.color === color && Number(rearAfter.count) === 1) return false;
        if (Number(features.backmostGain) < Number(selected.described.features.backmostGain) + 5
          || Number(features.exposureDelta) > Number(selected.described.features.exposureDelta) - 25
          || !Number.isFinite(severe)
          || selectedSevere - severe < 0.08
          || severe > selectedSevere * 0.35) return false;
        const candidateRear = rearBlot(candidate.after, color);
        const candidateHitProbability = candidateRear
          ? replyHitProbability(candidate.after, color, candidateRear.point)
          : 0;
        return candidateHitProbability <= 0.1
          && selectedHitProbability - candidateHitProbability >= 0.35;
      })
      .sort((left, right) => (
        Number(left.described.features.exposureDelta) - Number(right.described.features.exposureDelta)
        || Number(right.described.features.backmostGain) - Number(left.described.features.backmostGain)
        || left.severeLossProbability - right.severeLossProbability
        || right.equity - left.equity
      ))[0] || null;
  }

  function chooseStructuralNearTie(candidates, selected, phase) {
    if ((phase !== 'contact' && phase !== 'bar') || !Number.isFinite(selected.equity)) return null;
    return candidates
      .filter(candidate => (
        Number.isFinite(candidate.equity)
        && selected.equity - candidate.equity <= SHORT_WILDBG_NEAR_EQUITY_MARGIN
        && structurallyDominatesWildbg(candidate, selected)
      ))
      .sort((left, right) => right.equity - left.equity
        || left.matched.wildbgRank - right.matched.wildbgRank)[0] || null;
  }

  function chooseExperiencedNearTie(candidates, selected) {
    if (!Number.isFinite(selected.equity)) return null;
    const adjusted = candidates
      .filter(candidate => Number.isFinite(candidate.equity)
        && selected.equity - candidate.equity <= SHORT_WILDBG_NEAR_EQUITY_MARGIN)
      .map(candidate => ({
        candidate,
        adjustedEquity: candidate.equity
          + Number(candidate.described.experienceAdjustment || 0)
            / SHORT_WILDBG_EXPERIENCE_EQUITY_SCALE,
      }))
      .sort((left, right) => right.adjustedEquity - left.adjustedEquity
        || right.candidate.equity - left.candidate.equity
        || left.candidate.matched.wildbgRank - right.candidate.matched.wildbgRank);
    const best = adjusted[0];
    const original = adjusted.find(item => item.candidate === selected);
    return best && original && best.candidate !== selected
      && best.adjustedEquity > original.adjustedEquity + 0.002
      ? best.candidate
      : null;
  }

  function selectWildbgCandidate(state, color, analysis) {
    const candidates = assessWildbgCandidates(state, color, analysis);
    if (!candidates.length) return null;
    const original = candidates[0];
    let chosen = original;
    let reason = 'wildbg-top';
    const phase = shortPhase(state, color);
    const bearoff = chooseBearoffTie(candidates, chosen, phase);
    if (bearoff && bearoff !== chosen) {
      chosen = bearoff;
      reason = 'equal-equity-bearoff';
    }
    if (reason === 'wildbg-top') {
      const rearEscape = chooseCriticalRearEscape(state, color, candidates, chosen, phase);
      if (rearEscape && rearEscape !== chosen) {
        chosen = rearEscape;
        reason = 'critical-rear-blot-rescue';
      }
    }
    if (reason === 'wildbg-top') {
      const structural = chooseStructuralNearTie(candidates, chosen, phase);
      if (structural && structural !== chosen) {
        chosen = structural;
        reason = 'near-equity-structural-safety';
      }
    }
    if (reason === 'wildbg-top') {
      const experienced = chooseExperiencedNearTie(candidates, chosen);
      if (experienced && experienced !== chosen) {
        chosen = experienced;
        reason = 'near-equity-experience';
      }
    }
    return { candidates, original, chosen, reason, phase };
  }

  function recordWildbgDecision(state, color, selection) {
    const ordered = [
      selection.chosen,
      ...selection.candidates.filter(candidate => candidate !== selection.chosen),
    ];
    const described = ordered.map(candidate => ({
      ...candidate.described,
      wildbgRank: candidate.matched.wildbgRank,
      wildbgEquity: candidate.equity,
      wildbgProbabilities: candidate.matched.analysis?.probabilities || null,
    }));
    const decision = shortDecisionRecord(
      state,
      color,
      described,
      engine.experienceSize(),
      selection.candidates.length,
    );
    if (!decision) return null;
    const matched = selection.chosen.matched;
    decision.engine = {
      name: 'wildbg',
      provenance: 'wildbg-wasm',
      match: matched.match,
      phase: matched.phase,
      equity: Number.isFinite(Number(matched.analysis?.equity))
        ? Number(matched.analysis.equity)
        : null,
      score: Number.isFinite(Number(matched.analysis?.score))
        ? Number(matched.analysis.score)
        : null,
      originalRank: selection.original.matched.wildbgRank,
      originalEquity: selection.original.equity,
      selectedRank: matched.wildbgRank,
      candidateCount: selection.candidates.length,
      choiceReason: selection.reason,
      policyPhase: selection.phase,
    };
    return decision;
  }

  function planFromWildbgAnalysis(state, analysis) {
    const color = state?.turn;
    const selection = selectWildbgCandidate(state, color, analysis);
    if (!selection) return null;
    lastDecision = recordWildbgDecision(state, color, selection);
    return selection.chosen.matched.sequence.map(move => ({ from: move.from, die: move.die }));
  }

  function analyticPlan(state, runtimeOptions, wildbgFailure = '') {
    const color = state.turn;
    const ranked = engine.rank(state, color, runtimeOptions);
    lastDecision = shortDecisionRecord(state, color, ranked, engine.experienceSize());
    if (lastDecision) {
      lastDecision.engine = {
        name: 'short-analytic',
        provenance: wildbgFailure ? 'builtin-fallback' : 'builtin',
        wildbgFailure: wildbgFailure || null,
      };
    }
    return (ranked[0]?.sequence || []).map(move => ({ from: move.from, die: move.die }));
  }

  return {
    plan(state, runtimeOptions = {}) {
      const color = state?.turn;
      if (!state || state.variant !== 'short' || !color) return [];
      const request = prepareShortWildbgRequest(game, state, color);
      const wildbg = analyzer();
      if (request && typeof wildbg?.analyze === 'function') {
        try {
          const analysis = wildbg.analyze(
            request.board,
            request.die1,
            request.die2,
            request.isOnePointer,
          );
          if (!analysis || typeof analysis.then === 'function') {
            return analyticPlan(state, runtimeOptions, 'async-or-empty-analysis');
          }
          const plan = planFromWildbgAnalysis(state, analysis);
          if (plan) return plan;
          return analyticPlan(state, runtimeOptions, 'illegal-or-unmatched-analysis');
        } catch (error) {
          return analyticPlan(state, runtimeOptions, `analysis-error:${error?.message || error}`);
        }
      }
      return analyticPlan(state, runtimeOptions);
    },
    prepareWildbgRequest(state) {
      return prepareShortWildbgRequest(game, state, state?.turn);
    },
    planFromWildbgAnalysis,
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

function shortDecisionRecord(state, color, ranked, experienceSize, choiceCount = null) {
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
    wildbgRank: Number.isInteger(candidate.wildbgRank) ? candidate.wildbgRank : null,
    wildbgEquity: Number.isFinite(candidate.wildbgEquity) ? candidate.wildbgEquity : null,
    wildbgProbabilities: candidate.wildbgProbabilities
      ? { ...candidate.wildbgProbabilities }
      : null,
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
    choiceCount: Number.isInteger(choiceCount) && choiceCount > 0 ? choiceCount : candidates.length,
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

export function installBrowserShortBotEngine(root = globalThis) {
  if (!root?.NarduGame) return null;
  const api = createBrowserShortBotEngine(root.NarduGame, {
    getWildbgAnalyzer: () => root.NarduWildbgAnalyzer,
  });
  root.NarduShortBotEngine = api;
  return api;
}

if (typeof window !== 'undefined') installBrowserShortBotEngine(window);
