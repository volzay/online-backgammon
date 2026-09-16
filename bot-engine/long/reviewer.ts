/**
 * A deterministic, side-effect-free reviewer for long-bot decisions.
 *
 * The reviewer is deliberately separate from the playing engine. It only
 * accepts a complete, freshly evaluated candidate set and emits at most one
 * kind of learning evidence: a penalty for the action that was actually
 * selected. A game result is never used to manufacture causal credit.
 */
export const LONG_BOT_REVIEWER_VERSION = 'long-counterfactual-review-v1';
export const LONG_POLICY_EVIDENCE_SCHEMA = 'long-policy-counterfactual-evidence-v1';
export const LONG_POLICY_SCORE_SEMANTICS = 'long-policy-evaluator-v1';
export const LONG_STATIC_SCORE_SEMANTICS = 'long-static-evaluator-v1';

const CATEGORY_ORDER = [
  'missed-home-entry',
  'head-fence-exposure',
  'released-opponent',
  'unsustainable-prime',
  'avoidable-home-shuffle',
  'tower',
];

const SCORE_FIELDS = ['policyScore', 'equity', 'score'];

/** Return a canonical key for a candidate's resulting board position. */
export function afterPositionKey(candidate) {
  const after = candidate?.after;
  if (!after || typeof after !== 'object' || !after.points || typeof after.points !== 'object') {
    return '';
  }
  const points = Object.entries(after.points)
    .filter(([, stack]) => (
      stack && typeof stack === 'object' && finiteNumber(stack.count, 0) > 0
    ))
    .sort(([left], [right]) => Number(left) - Number(right) || String(left).localeCompare(String(right)))
    .map(([point, stack]) => `${point}:${String(stack.color || '')}:${finiteNumber(stack.count, 0)}`)
    .join('|');
  const whiteOff = finiteNumber(after.off?.white, 0);
  const darkOff = finiteNumber(after.off?.dark, 0);
  const whiteBar = finiteNumber(after.bar?.white, 0);
  const darkBar = finiteNumber(after.bar?.dark, 0);
  return `${points}|bar:${whiteBar}:${darkBar}|off:${whiteOff}:${darkOff}`;
}

/**
 * Collapse move-order aliases that reach the same board. The highest-valued
 * representative is retained; exact ties are broken by canonical content,
 * so input ordering cannot change the result.
 */
export function dedupeCandidatesByAfterPosition(candidates, scoreField = null) {
  const list = Array.isArray(candidates) ? candidates : [];
  const field = scoreField || sharedScoreField(list);
  const byPosition = new Map();

  for (const candidate of list) {
    const key = afterPositionKey(candidate);
    if (!key) continue;
    const current = byPosition.get(key);
    if (!current || compareCandidateRepresentatives(candidate, current, field) < 0) {
      byPosition.set(key, candidate);
    }
  }

  return [...byPosition.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, candidate]) => candidate);
}

/**
 * Identify concrete structural dimensions on which the recommended move is
 * better than the selected move. Tags are intentionally based on replayed
 * features rather than the eventual game result.
 */
export function structuralDominanceTags(selected, recommended) {
  const chosen = selected?.features || {};
  const better = recommended?.features || {};
  const tags = new Set();

  if (
    greater(better.outsideReduction, chosen.outsideReduction)
    || greater(better.homeEntryMoves, chosen.homeEntryMoves)
  ) {
    tags.add('missed-home-entry');
  }

  if (
    lower(better.headLandingBreak, chosen.headLandingBreak)
    || greater(better.fenceClosureDelta, chosen.fenceClosureDelta)
    || lower(better.fenceClosureRiskAfter, chosen.fenceClosureRiskAfter)
    || lower(
      better.avoidableProspectiveFenceInterruptionBreak,
      chosen.avoidableProspectiveFenceInterruptionBreak,
    )
    || lower(
      better.avoidableProspectiveFenceAnchorMiss,
      chosen.avoidableProspectiveFenceAnchorMiss,
    )
    || greater(better.escapeGatewayDelta, chosen.escapeGatewayDelta)
  ) {
    tags.add('head-fence-exposure');
  }

  if (
    greater(better.opponentHeadFreedomDelta, chosen.opponentHeadFreedomDelta)
    || greater(better.opponentMoveBlockGain, chosen.opponentMoveBlockGain)
    || greater(better.latentFenceExposureDelta, chosen.latentFenceExposureDelta)
    || lower(better.expectedOpponentHeadRelease, chosen.expectedOpponentHeadRelease)
    || lower(better.expectedOpponentOutsideReduction, chosen.expectedOpponentOutsideReduction)
  ) {
    tags.add('released-opponent');
  }

  const chosenRunBefore = numeric(chosen.primeRunBefore);
  const chosenRunAfter = numeric(chosen.primeRunAfter);
  const betterRunAfter = numeric(better.primeRunAfter);
  const selectedBrokePrime = chosenRunBefore !== null
    && chosenRunAfter !== null
    && chosenRunBefore >= 4
    && chosenRunAfter < chosenRunBefore;
  const betterKeepsPrime = selectedBrokePrime
    && betterRunAfter !== null
    && betterRunAfter > chosenRunAfter;
  const betterPrimeHealth = greater(better.primeSustainabilityAfter, chosen.primeSustainabilityAfter)
    || lower(better.primeCrunchRiskAfter, chosen.primeCrunchRiskAfter)
    || greater(better.primeCrunchRiskDelta, chosen.primeCrunchRiskDelta);
  if (betterKeepsPrime || ((chosenRunAfter || 0) >= 4 && betterPrimeHealth)) {
    tags.add('unsustainable-prime');
  }

  if (lower(better.avoidableHomeShuffleMoves, chosen.avoidableHomeShuffleMoves)) {
    tags.add('avoidable-home-shuffle');
  }

  if (
    lower(better.maxRouteTowerAfter, chosen.maxRouteTowerAfter)
    || lower(better.routeTowerAfter, chosen.routeTowerAfter)
    || greater(better.routeTowerDelta, chosen.routeTowerDelta)
  ) {
    tags.add('tower');
  }

  return CATEGORY_ORDER.filter(category => tags.has(category));
}

/**
 * Review one archived decision against a complete shadow re-evaluation.
 *
 * @param {object} decision the immutable decision record that was executed
 * @param {object[]} candidates every legal candidate, freshly evaluated
 * @param {object} replay identity, coverage and threshold metadata
 * @returns {object} rejected, no-regret, or one negative selected-action record
 */
export function reviewLongBotDecision(decision, candidates, replay = {}) {
  const rejection = validateReviewInputs(decision, candidates, replay);
  if (rejection) return rejectedReview(rejection);

  const scoreField = sharedScoreField(candidates);
  if (!scoreField) return rejectedReview('candidate-score-missing');

  const selectedPositionKey = afterPositionKey(decision.selected);
  const selectedExperience = decision.selected?.experience || decision.experience;
  const selectedContextKey = String(selectedExperience?.contextKey || '');
  const selectedActionKey = String(selectedExperience?.actionKey || '');
  const archivedSelectedMoves = canonicalMoves(decision.selected?.moves);
  if (!selectedContextKey || !selectedActionKey) {
    return rejectedReview('selected-experience-identity-missing');
  }
  if (
    decision.selected?.experience
    && decision.experience
    && (
      String(decision.selected.experience.contextKey || '') !== selectedContextKey
      || String(decision.selected.experience.actionKey || '') !== selectedActionKey
    )
  ) {
    return rejectedReview('selected-experience-identity-mismatch');
  }
  const selected = candidates.find(candidate => (
    afterPositionKey(candidate) === selectedPositionKey
    && canonicalMoves(candidate?.moves) === archivedSelectedMoves
    && String(candidate?.experience?.contextKey || '') === selectedContextKey
    && String(candidate?.experience?.actionKey || '') === selectedActionKey
  ));
  if (!selected) return rejectedReview('selected-replay-experience-mismatch');

  // Move-order aliases may reach one board. Preserve the exact regenerated
  // candidate for the action that actually ran, while deduplicating every
  // other board deterministically.
  const uniqueCandidates = dedupeCandidatesByAfterPosition(candidates, scoreField)
    .map(candidate => (
      afterPositionKey(candidate) === selectedPositionKey ? selected : candidate
    ));

  const ranked = [...uniqueCandidates].sort((left, right) => compareRankedCandidates(
    left,
    right,
    scoreField,
  ));
  const recommended = ranked[0];
  const selectedScore = Number(selected[scoreField]);
  const recommendedScore = Number(recommended[scoreField]);
  // Positive regret always means the replay found a better action.
  const regret = recommendedScore - selectedScore;
  const eligibility = learningEligibility(
    selected,
    recommended,
    scoreField,
    regret,
    replay,
  );
  const regretLcb = eligibility.regretLcb;
  const minRegret = Math.max(0, finiteNumber(replay.minRegret, 0));
  const minRegretLcb = Math.max(0, finiteNumber(replay.minRegretLcb, minRegret));
  const categories = structuralDominanceTags(selected, recommended);

  const common = {
    accepted: true,
    reviewerVersion: LONG_BOT_REVIEWER_VERSION,
    engineVersion: decision.engineVersion,
    experienceFingerprint: decision.experienceFingerprint,
    stateFingerprintV2: decision.stateFingerprintV2,
    scoreField,
    candidateCount: candidates.length,
    uniquePositionCount: uniqueCandidates.length,
    selectedPositionKey,
    recommendedPositionKey: afterPositionKey(recommended),
    selectedPolicyScore: selectedScore,
    recommendedPolicyScore: recommendedScore,
    regret,
    regretLcb,
    categories,
    learningEligible: eligibility.eligible,
    learningIneligibleReason: eligibility.reason,
    outcomeUsed: false,
    credit: 0,
  };

  if (
    recommended === selected
    || regret <= minRegret
    || (regretLcb !== null && regretLcb <= minRegretLcb)
    || categories.length === 0
  ) {
    return {
      ...common,
      status: 'no-regret',
      records: [],
    };
  }

  // A complete static replay remains valuable for diagnosis, but a static
  // heuristic is not the policy that selected the live action. Likewise, a
  // bare policyScore without explicit trust and two-sided confidence bounds
  // cannot establish conservative causal regret. Keep both visible in the
  // report while making them structurally incapable of creating memory.
  if (!eligibility.eligible) {
    return {
      ...common,
      status: 'diagnostic-regret',
      records: [],
    };
  }

  return {
    ...common,
    status: 'confirmed-regret',
    records: [{
      evidenceVersion: LONG_BOT_REVIEWER_VERSION,
      evidenceType: 'negative-selected-penalty',
      direction: 'negative',
      decisionId: String(decision.id || ''),
      positionId: String(decision.positionId || ''),
      engineVersion: String(decision.engineVersion || ''),
      experienceFingerprint: String(decision.experienceFingerprint || ''),
      stateFingerprintV2: String(decision.stateFingerprintV2 || ''),
      selectedPositionKey,
      recommendedPositionKey: afterPositionKey(recommended),
      contextKey: selectedContextKey,
      selectedActionKey,
      actionIdentity: `${selectedContextKey}::${selectedActionKey}`,
      selectedPolicyScore: selectedScore,
      recommendedPolicyScore: recommendedScore,
      regret,
      regretLcb,
      categories,
      learningEligible: true,
      outcomeUsed: false,
    }],
  };
}

function validateReviewInputs(decision, candidates, replay) {
  if (!decision || typeof decision !== 'object') return 'decision-missing';
  if (decision.source !== 'engine' || decision.fallback || decision.fallbackReason) {
    return 'fallback-decision';
  }
  if (!decision.execution || decision.execution.complete !== true) {
    return 'execution-completion-missing';
  }
  if (
    decision.execution?.substituted === true
    || decision.execution?.fallback === true
    || (Array.isArray(decision.execution?.substitutions)
      && decision.execution.substitutions.length > 0)
  ) {
    return 'execution-substitution';
  }
  if (decision.execution.selectedMatchesExecuted === false) {
    return 'execution-selected-mismatch';
  }
  const executed = decision.execution.executed
    || (decision.execution.after
      ? { after: decision.execution.after, moves: decision.execution.executedMoves }
      : null);
  const selectedPosition = afterPositionKey(decision.selected);
  const executedPosition = afterPositionKey(executed);
  if (!selectedPosition || !executedPosition) {
    return 'execution-position-missing';
  }
  if (selectedPosition !== executedPosition) {
    return 'execution-selected-mismatch';
  }
  const selectedMoves = canonicalMoves(decision.selected?.moves);
  const executedMoves = canonicalMoves(
    decision.execution.executedMoves
    || decision.execution.actualMoves
    || decision.execution.moves
    || executed?.moves,
  );
  if (!selectedMoves || !executedMoves) return 'execution-moves-missing';
  if (selectedMoves !== executedMoves) return 'execution-selected-mismatch';
  const selectedActionKey = String(
    decision.selected?.experience?.actionKey
    || decision.experience?.actionKey
    || '',
  );
  const executedActionKey = String(
    decision.execution.executedActionKey
    || executed?.experience?.actionKey
    || executed?.actionKey
    || '',
  );
  if (!selectedActionKey || !executedActionKey) return 'execution-action-identity-missing';
  if (selectedActionKey !== executedActionKey) {
    return 'execution-selected-mismatch';
  }

  if (!nonEmptyString(replay.reviewerVersion)
    || replay.reviewerVersion !== LONG_BOT_REVIEWER_VERSION) {
    return 'reviewer-version-mismatch';
  }
  if (replay.outcomeUsed !== false) return 'replay-outcome-provenance-invalid';
  if (!nonEmptyString(decision.engineVersion)
    || !nonEmptyString(replay.engineVersion)
    || decision.engineVersion !== replay.engineVersion) {
    return 'engine-version-mismatch';
  }
  if (!nonEmptyString(decision.experienceFingerprint)
    || !nonEmptyString(replay.experienceFingerprint)
    || decision.experienceFingerprint !== replay.experienceFingerprint) {
    return 'experience-fingerprint-mismatch';
  }
  if (!nonEmptyString(decision.stateFingerprintV2)
    || !nonEmptyString(replay.stateFingerprintV2)
    || decision.stateFingerprintV2 !== replay.stateFingerprintV2) {
    return 'state-fingerprint-v2-mismatch';
  }
  if (!decision.stateSnapshotV2 || !replay.stateSnapshotV2) {
    return 'state-snapshot-v2-missing';
  }
  if (stableStringify(decision.stateSnapshotV2) !== stableStringify(replay.stateSnapshotV2)) {
    return 'state-snapshot-v2-mismatch';
  }

  if (!Array.isArray(candidates) || candidates.length === 0) return 'candidates-missing';
  const expected = numeric(replay.coverage?.expectedCandidates);
  const evaluated = numeric(replay.coverage?.evaluatedCandidates);
  if (
    replay.coverage?.complete !== true
    || expected === null
    || evaluated === null
    || expected < 1
    || expected !== evaluated
    || evaluated !== candidates.length
  ) {
    return 'candidate-coverage-incomplete';
  }
  if (decision.coverage && decision.coverage.complete !== true) {
    return 'decision-coverage-incomplete';
  }
  if (!decision.selected || !afterPositionKey(decision.selected)) {
    return 'selected-position-missing';
  }

  for (const candidate of candidates) {
    if (!afterPositionKey(candidate)) return 'candidate-position-missing';
    if (candidate.engineVersion !== undefined && candidate.engineVersion !== replay.engineVersion) {
      return 'candidate-engine-version-mismatch';
    }
    if (candidate.experienceFingerprint !== undefined
      && candidate.experienceFingerprint !== replay.experienceFingerprint) {
      return 'candidate-experience-fingerprint-mismatch';
    }
    if (candidate.stateSnapshotV2 !== undefined
      && stableStringify(candidate.stateSnapshotV2) !== stableStringify(replay.stateSnapshotV2)) {
      return 'candidate-state-snapshot-v2-mismatch';
    }
  }
  return '';
}

function rejectedReview(reason) {
  return {
    accepted: false,
    status: 'rejected',
    reason,
    reviewerVersion: LONG_BOT_REVIEWER_VERSION,
    records: [],
    outcomeUsed: false,
    credit: 0,
  };
}

function sharedScoreField(candidates) {
  return SCORE_FIELDS.find(field => (
    candidates.length > 0 && candidates.every(candidate => numeric(candidate?.[field]) !== null)
  )) || '';
}

function compareCandidateRepresentatives(left, right, scoreField) {
  if (scoreField) {
    const scoreDelta = Number(right?.[scoreField]) - Number(left?.[scoreField]);
    if (scoreDelta !== 0) return scoreDelta;
  }
  return stableStringify(left).localeCompare(stableStringify(right));
}

function compareRankedCandidates(left, right, scoreField) {
  const scoreDelta = Number(right[scoreField]) - Number(left[scoreField]);
  if (scoreDelta !== 0) return scoreDelta;
  const positionDelta = afterPositionKey(left).localeCompare(afterPositionKey(right));
  if (positionDelta !== 0) return positionDelta;
  return stableStringify(left).localeCompare(stableStringify(right));
}

function conservativeRegretLowerBound(selected, recommended, scoreField, regret) {
  const recommendedLower = firstFinite(
    recommended[`${scoreField}Lcb`],
    recommended[`${scoreField}LCB`],
    recommended.lcb,
    recommended.lowerConfidenceBound,
  );
  const selectedUpper = firstFinite(
    selected[`${scoreField}Ucb`],
    selected[`${scoreField}UCB`],
    selected.ucb,
    selected.upperConfidenceBound,
  );
  // Both sides are mandatory. Falling back to either point estimate silently
  // converts ordinary score regret into a fabricated confidence bound.
  if (recommendedLower === null || selectedUpper === null) return null;
  return Math.min(regret, recommendedLower - selectedUpper);
}

function learningEligibility(selected, recommended, scoreField, regret, replay) {
  const scoreSemantics = String(replay?.scoreSemantics || '');
  if (scoreSemantics === LONG_STATIC_SCORE_SEMANTICS) {
    return { eligible: false, reason: 'static-evaluator-diagnostic-only', regretLcb: null };
  }
  const evidence = replay?.learningEvidence;
  if (
    scoreField !== 'policyScore'
    || scoreSemantics !== LONG_POLICY_SCORE_SEMANTICS
    || !evidence
    || evidence.schema !== LONG_POLICY_EVIDENCE_SCHEMA
    || evidence.trusted !== true
    || evidence.conservativeBoundsComplete !== true
  ) {
    return { eligible: false, reason: 'trusted-policy-evidence-missing', regretLcb: null };
  }
  const regretLcb = conservativeRegretLowerBound(
    selected,
    recommended,
    scoreField,
    regret,
  );
  if (regretLcb === null) {
    return { eligible: false, reason: 'conservative-bounds-incomplete', regretLcb: null };
  }
  return { eligible: true, reason: '', regretLcb };
}

function greater(left, right, epsilon = 1e-9) {
  const leftNumber = numeric(left);
  const rightNumber = numeric(right);
  return leftNumber !== null && rightNumber !== null && leftNumber > rightNumber + epsilon;
}

function lower(left, right, epsilon = 1e-9) {
  const leftNumber = numeric(left);
  const rightNumber = numeric(right);
  return leftNumber !== null && rightNumber !== null && leftNumber + epsilon < rightNumber;
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteNumber(value, fallback) {
  const number = numeric(value);
  return number === null ? fallback : number;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = numeric(value);
    if (number !== null) return number;
  }
  return null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function canonicalMoves(moves) {
  if (!Array.isArray(moves) || moves.length < 1) return '';
  const result = [];
  for (const move of moves) {
    const from = numeric(move?.from);
    const die = numeric(move?.die);
    const to = move?.bearOff || move?.to === 0 ? 0 : numeric(move?.to);
    if (
      from === null
      || die === null
      || to === null
      || !Number.isInteger(from)
      || !Number.isInteger(die)
      || !Number.isInteger(to)
    ) return '';
    result.push(`${from}>${to}@${die}`);
  }
  return result.join(';');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}
