const SHORT_REPLY_ROLLS = [];
for (let first = 1; first <= 6; first += 1) {
  for (let second = first; second <= 6; second += 1) {
    SHORT_REPLY_ROLLS.push({
      dice: first === second ? [first, first, first, first] : [first, second],
      probability: first === second ? 1 / 36 : 2 / 36,
    });
  }
}

const SHORT_REPLY_POOL_CAP = 32;
const SHORT_SCORE_WEIGHTS = Object.freeze({
  base: 0.75,
  expectedReply: 0.2,
  worstReply: 0.05,
});
const SHORT_STRUCTURAL_DOMINANCE_BASE_MARGIN = 90_000;
const SHORT_STRUCTURAL_DOMINANCE_EXPOSURE_MARGIN = 2;
const SHORT_PUBEVAL_SCALE = 10_000_000;
const SHORT_HANDCRAFTED_BLEND = 0.01;

function clampShort(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cloneShortState(state) {
  return JSON.parse(JSON.stringify(state || {}));
}

function shortSequenceSignature(sequence, state, color) {
  return JSON.stringify((sequence || []).map(move => [
    Number(move.from) === NarduGame.barPoint(color)
      ? -1
      : NarduGame.pathPos(color, Number(move.from), state),
    move.bearOff || Number(move.to) === 0
      ? 24
      : NarduGame.pathPos(color, Number(move.to), state),
    Number(move.die),
    Boolean(move.bearOff),
  ]));
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

export function createShortBotEngine(adapter, options = {}) {
  const experience = new Map();
  const experienceSources = new Map();

  function evaluateState(state, color, pubevalPhase = '') {
    const terminal = terminalShortScore(state, color);
    if (terminal !== null) return terminal;
    const opponent = NarduGame.opponentOf(color);
    const own = shortMetrics(state, color);
    const other = shortMetrics(state, opponent);
    const raceLead = other.pips - own.pips;
    const phase = shortPhase(state, color);
    const raceResultSafety = own.off === 0
      ? -(other.off * 70000 + (other.off >= 8 ? 180000 : 0))
      : own.off * 35000;
    const raceScore = raceLead * 4800
      + (own.off - other.off) * 520000
      + (own.backmost - other.backmost) * 22000
      + (other.outsideHome - own.outsideHome) * 72000
      + (other.outsideHomePips - own.outsideHomePips) * 6500
      + (other.stacks - own.stacks) * 3200
      + raceResultSafety;
    let handcraftedScore = raceScore;
    if (phase !== 'contact' && phase !== 'bar') {
      return shortPubevalScore(state, color, pubevalPhase) * SHORT_PUBEVAL_SCALE
        + handcraftedScore * SHORT_HANDCRAFTED_BLEND;
    }
    const ownBoard = own.homeMade * own.homeMade * (3600 + other.bar * 11000);
    const otherBoard = other.homeMade * other.homeMade * (3600 + own.bar * 11000);
    const barValue = (
      other.bar * (52000 + own.homeMade * 17000)
      - own.bar * (65000 + other.homeMade * 21000)
    );
    const resultSafety = own.off === 0
      ? -(other.off * 24000 + (other.off >= 8 ? 90000 : 0))
      : own.off * 19000;
    const contactScore = raceLead * 1180
      + (own.off - other.off) * 150000
      + barValue
      + (own.made - other.made) * 10500
      + ownBoard - otherBoard
      + (own.primePressure - other.primePressure) * 8200
      + (other.exposure - own.exposure) * 7600
      + (own.anchorValue - other.anchorValue) * 5200
      + (other.stacks - own.stacks) * 13500
      + (own.backmost - other.backmost) * 7200
      + (other.outsideHome - own.outsideHome) * 13000
      + resultSafety;
    if (phase === 'bar') handcraftedScore = contactScore;
    else {
      const contactQuality = clampShort(Number(own.contactQuality) || 0, 0, 1);
      handcraftedScore = raceScore + (contactScore - raceScore) * contactQuality;
    }
    return shortPubevalScore(state, color, pubevalPhase) * SHORT_PUBEVAL_SCALE
      + handcraftedScore * SHORT_HANDCRAFTED_BLEND;
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
    let preview = cloneShortState(before);
    let capturedExposure = 0;
    (sequence || []).forEach(move => {
      const target = move.bearOff ? null : preview.points?.[Number(move.to)];
      if (target?.color === opponent && Number(target.count) === 1) {
        capturedExposure += blotRisk(preview, opponent, Number(move.to));
      }
      preview = adapter.applySequence(preview, [move], color);
    });
    return {
      pipsGain: ownBefore.pips - ownAfter.pips,
      hits,
      entries,
      offGain,
      madeGain: ownAfter.made - ownBefore.made,
      homeMadeGain: ownAfter.homeMade - ownBefore.homeMade,
      primeGain: ownAfter.longestPrime - ownBefore.longestPrime,
      backmostGain: ownAfter.backmost - ownBefore.backmost,
      exposureDelta: ownAfter.exposure - ownBefore.exposure,
      opponentExposureGain: otherAfter.exposure - otherBefore.exposure,
      capturedExposure,
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
    const phase = shortPhase(state, color);
    const contextKey = [
      phase,
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
    const contactSeverity = phase === 'contact' || phase === 'bar'
      ? features.ownBarAfter * 1.3
        + Math.max(0, features.exposureDelta) / 35
        + Math.max(0, -features.madeGain) * 0.75
      : 0;
    const bearoffWaste = phase === 'bearoff' && features.offGain === 0 ? 1.4 : 0;
    const structuralSeverity = phase === 'bearoff'
      ? 0
      : Math.max(0, features.stackDelta) * 0.25;
    const mistakeSeverity = Math.max(0,
      contactSeverity
      + structuralSeverity
      + bearoffWaste
      + (phase !== 'bearoff' && features.homeShuffleMoves > 0 && features.offGain === 0 ? 0.65 : 0));
    return { phase, contextKey, actionKey, mistakeSeverity };
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

  function baseCandidate(state, color, sequence, baseline = false, pubevalPhase = '') {
    const after = adapter.applySequence(state, sequence, color);
    const features = positionFeatures(state, after, color, sequence);
    const exp = descriptor(state, color, features);
    let score = evaluateState(after, color, pubevalPhase);
    score += features.hits * 21000;
    score += features.capturedExposure * 7600 * SHORT_HANDCRAFTED_BLEND;
    score += features.entries * 17000;
    score += features.offGain * 28000;
    score += features.madeGain * 9000;
    score += features.homeMadeGain * 14000;
    score += features.primeGain * 12000;
    score -= Math.max(0, features.exposureDelta) * 2600;
    score -= Math.max(0, features.stackDelta) * 3500;
    if (features.homeShuffleMoves && features.offGain === 0 && !NarduGame.homeReady(state, color)) {
      const outside = shortMetrics(state, color).outsideHome;
      score -= features.homeShuffleMoves * (26000 + outside * 6500);
    }
    if (baseline) score += 18000;
    return { sequence, after, features, experience: exp, baseline, baseScore: score, score };
  }

  function analyzeReplies(candidate, color, runtimeOptions) {
    const opponent = NarduGame.opponentOf(color);
    const replyLimit = Math.max(8, Number(runtimeOptions.replyLimit) || 12);
    const replyPoolLimit = Math.min(
      SHORT_REPLY_POOL_CAP,
      Math.max(replyLimit + 8, replyLimit * 2),
    );
    let expected = 0;
    let worst = Infinity;
    let blockedProbability = 0;
    let probabilityMass = 0;
    const reservations = {
      hitRolls: 0,
      barEntryRolls: 0,
      terminalRolls: 0,
      staticRolls: 0,
      outsideGeneric: 0,
    };
    let replyPoolCandidates = 0;
    let repliesEvaluated = 0;
    SHORT_REPLY_ROLLS.forEach(({ dice, probability }) => {
      const replyState = cloneShortState(candidate.after);
      replyState.turn = opponent;
      replyState.phase = 'move';
      replyState.dice = [...dice];
      replyState.rolled = [...dice];
      replyState.turnMoves = [];
      const pool = adapter.tacticalSequences
        ? adapter.tacticalSequences(replyState, opponent, { limit: replyPoolLimit })
        : adapter.legalSequences(replyState, opponent, { limit: replyPoolLimit });
      const genericSignatures = new Set(pool.slice(0, replyLimit)
        .map(sequence => shortSequenceSignature(sequence, replyState, opponent)));
      const annotated = pool.map(sequence => ({
        sequence,
        signature: shortSequenceSignature(sequence, replyState, opponent),
        features: replySequenceFeatures(replyState, opponent, sequence),
        botScore: evaluateState(
          adapter.applySequence(replyState, sequence, opponent),
          color,
          candidate.pubevalPhase,
        ),
      }));
      const generic = annotated.slice(0, replyLimit);
      const worstStatic = annotated
        .slice()
        .sort((left, right) => left.botScore - right.botScore
          || left.signature.localeCompare(right.signature))[0] || null;
      const reserved = [
        ['terminalRolls', strongestReplyFeature(annotated, 'terminal')],
        ['hitRolls', strongestReplyFeature(annotated, 'hits')],
        ['barEntryRolls', strongestReplyFeature(annotated, 'entries')],
        ['staticRolls', worstStatic],
      ];
      const selected = [];
      const selectedSignatures = new Set();
      reserved.forEach(([counter, item]) => {
        if (!item || selectedSignatures.has(item.signature) || selected.length >= replyLimit) return;
        selected.push(item);
        selectedSignatures.add(item.signature);
        reservations[counter] += 1;
        if (!genericSignatures.has(item.signature)) reservations.outsideGeneric += 1;
      });
      generic.forEach(item => {
        if (selected.length >= replyLimit || selectedSignatures.has(item.signature)) return;
        selected.push(item);
        selectedSignatures.add(item.signature);
      });
      replyPoolCandidates += pool.length;
      repliesEvaluated += selected.length;
      let botScore;
      if (!selected.length) {
        blockedProbability += probability;
        botScore = evaluateState(replyState, color, candidate.pubevalPhase) + 28000;
      } else {
        botScore = Math.min(...selected.map(reply => reply.botScore));
      }
      expected += botScore * probability;
      worst = Math.min(worst, botScore);
      probabilityMass += probability;
    });
    const tactical = {
      expectedImpact: expected - candidate.baseScore,
      worstImpact: worst - candidate.baseScore,
      rolls: SHORT_REPLY_ROLLS.length,
      probabilityMass,
      blockedProbability,
      replyPoolLimit,
      replyPoolCandidates,
      repliesEvaluated,
      reservations,
      plies: 2,
    };
    return {
      ...candidate,
      tactical: {
        ...tactical,
        scoreWeights: { ...SHORT_SCORE_WEIGHTS },
      },
      score: candidate.baseScore * SHORT_SCORE_WEIGHTS.base
        + expected * SHORT_SCORE_WEIGHTS.expectedReply
        + worst * SHORT_SCORE_WEIGHTS.worstReply,
    };
  }

  function replySequenceFeatures(state, color, sequence) {
    const opponent = NarduGame.opponentOf(color);
    const points = cloneShortState(state.points || {});
    const barPoint = NarduGame.barPoint(color);
    let hits = 0;
    let entries = 0;
    let bearOffs = 0;
    let pips = 0;
    (sequence || []).forEach(move => {
      const from = Number(move.from);
      const to = Number(move.to) || 0;
      if (from === barPoint) entries += 1;
      if (move.bearOff || to === 0) {
        bearOffs += 1;
      } else {
        const target = points[to];
        if (move.hit || (target?.color === opponent && Number(target.count) === 1)) hits += 1;
        points[to] = { color, count: target?.color === color ? Number(target.count) + 1 : 1 };
      }
      if (from !== barPoint && points[from]?.color === color) {
        points[from].count -= 1;
        if (points[from].count <= 0) delete points[from];
      }
      pips += Number(move.die) || 0;
    });
    return {
      hits,
      entries,
      terminal: (Number(state.off?.[color]) || 0) + bearOffs >= 15 ? 1 : 0,
      pips,
    };
  }

  function strongestReplyFeature(annotated, feature) {
    return annotated
      .filter(item => Number(item.features?.[feature]) > 0)
      .sort((left, right) => (
        Number(right.features[feature]) - Number(left.features[feature])
        || left.botScore - right.botScore
        || Number(right.features.hits) - Number(left.features.hits)
        || Number(right.features.entries) - Number(left.features.entries)
        || Number(right.features.pips) - Number(left.features.pips)
        || left.signature.localeCompare(right.signature)
      ))[0] || null;
  }

  function structurallyDominates(left, right) {
    const sameTacticalProgress = ['pipsGain', 'hits', 'entries', 'offGain']
      .every(key => Number(left.features[key]) === Number(right.features[key]));
    if (!sameTacticalProgress) return false;
    const structuralKeys = ['madeGain', 'homeMadeGain', 'primeGain'];
    const preservesStructure = structuralKeys
      .every(key => Number(left.features[key]) >= Number(right.features[key]));
    const improvesStructure = structuralKeys
      .some(key => Number(left.features[key]) > Number(right.features[key]));
    const exposureImprovement = Number(right.features.exposureDelta)
      - Number(left.features.exposureDelta);
    return preservesStructure
      && improvesStructure
      && exposureImprovement >= SHORT_STRUCTURAL_DOMINANCE_EXPOSURE_MARGIN
      && left.baseScore - right.baseScore >= SHORT_STRUCTURAL_DOMINANCE_BASE_MARGIN;
  }

  function removeStructurallyDominated(candidates) {
    return candidates.filter(candidate => !candidates.some(other => (
      other !== candidate && structurallyDominates(other, candidate)
    )));
  }

  function removePrematureAnchorBreaks(candidates, state, color) {
    const opponent = NarduGame.opponentOf(color);
    const other = shortMetrics(state, opponent);
    if (other.pips < 90) return candidates;
    return candidates.filter(candidate => {
      const features = candidate.features;
      const fragileBreak = features.hits === 0
        && features.entries === 0
        && features.offGain === 0
        && features.madeGain <= 0
        && features.anchorDelta < 0
        && features.exposureDelta >= 20;
      if (!fragileBreak) return true;
      return !candidates.some(otherCandidate => {
        const safer = otherCandidate.features;
        return safer.pipsGain === features.pipsGain
          && safer.hits === features.hits
          && safer.entries === features.entries
          && safer.offGain === features.offGain
          && safer.madeGain >= features.madeGain
          && safer.anchorDelta >= 0
          && safer.exposureDelta <= features.exposureDelta - 20;
      });
    });
  }

  function removeUnsafeBarEntryBlots(candidates, state, color) {
    if ((Number(state.bar?.[color]) || 0) <= 0) return candidates;
    const continuesEnteredChecker = sequence => {
      const entryDestinations = new Set();
      for (const move of sequence || []) {
        if (Number(move.from) === NarduGame.barPoint(color)) {
          if (!move.bearOff && Number(move.to)) entryDestinations.add(Number(move.to));
        } else if (entryDestinations.has(Number(move.from))) {
          return true;
        }
      }
      return false;
    };
    return candidates.filter(candidate => {
      const features = candidate.features;
      const exposedEntry = features.entries > 0
        && features.hits === 0
        && features.exposureDelta >= 50
        && !continuesEnteredChecker(candidate.sequence);
      if (!exposedEntry) return true;
      return !candidates.some(otherCandidate => {
        const safer = otherCandidate.features;
        return safer.pipsGain === features.pipsGain
          && safer.hits === features.hits
          && safer.entries === features.entries
          && safer.offGain === features.offGain
          && safer.madeGain >= features.madeGain
          && continuesEnteredChecker(otherCandidate.sequence)
          && safer.exposureDelta <= features.exposureDelta - 45;
      });
    });
  }

  function rank(state, color, runtimeOptions = {}) {
    const maxCandidates = Math.max(6, Number(runtimeOptions.maxCandidates) || 48);
    const analyzeCount = Math.max(4, Number(runtimeOptions.analyzeCandidates) || 6);
    const sequences = adapter.legalSequences(state, color, { limit: 0 });
    if (!sequences.length) return [];
    const baseline = adapter.baselineSequence?.(state, color) || [];
    if (baseline.length) sequences.push(baseline);
    const unique = new Map();
    const pubevalPhase = shortPhase(state, color);
    sequences.forEach(sequence => {
      const isBaseline = baseline.length > 0
        && JSON.stringify(sequence.map(move => [move.from, move.die]))
          === JSON.stringify(baseline.map(move => [move.from, move.die]));
      const item = {
        ...baseCandidate(state, color, sequence, isBaseline, pubevalPhase),
        pubevalPhase,
      };
      const signature = JSON.stringify({
        points: item.after.points,
        bar: item.after.bar,
        off: item.after.off,
      });
      const previous = unique.get(signature);
      if (!previous || item.baseScore > previous.baseScore || item.baseline) unique.set(signature, item);
    });
    let prefiltered = Array.from(unique.values())
      .sort((left, right) => right.baseScore - left.baseScore
        || shortSequenceSignature(left.sequence, state, color)
          .localeCompare(shortSequenceSignature(right.sequence, state, color)));
    const phase = shortPhase(state, color);
    if (phase === 'bearoff') {
      const maximumOff = Math.max(...prefiltered.map(item => item.features.offGain));
      prefiltered = prefiltered.filter(item => item.features.offGain === maximumOff);
    }
    if (phase === 'race'
      && !NarduGame.homeReady(state, color)
      && shortMetrics(state, color).outsideHome <= 4) {
      const maximumBackmostGain = Math.max(...prefiltered.map(item => item.features.backmostGain));
      if (maximumBackmostGain > 0) {
        prefiltered = prefiltered.filter(item => item.features.backmostGain === maximumBackmostGain);
      }
    }
    if (phase === 'contact' || phase === 'bar') {
      prefiltered = removeStructurallyDominated(prefiltered);
      prefiltered = removePrematureAnchorBreaks(prefiltered, state, color);
      prefiltered = removeUnsafeBarEntryBlots(prefiltered, state, color);
    }
    prefiltered = prefiltered.slice(0, maxCandidates);
    const selected = prefiltered.slice(0, Math.min(analyzeCount, 2));
    return selected
      .map(item => {
        const analyzed = analyzeReplies(item, color, runtimeOptions);
        const adjustment = experienceAdjustment(analyzed);
        return { ...analyzed, experienceAdjustment: adjustment, score: analyzed.score + adjustment };
      })
      .sort((left, right) => right.score - left.score
        || shortSequenceSignature(left.sequence, state, color)
          .localeCompare(shortSequenceSignature(right.sequence, state, color)));
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
