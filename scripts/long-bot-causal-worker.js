#!/usr/bin/env node
'use strict';

/**
 * Trusted, resource-bounded causal reviewer for long-bot v35.
 *
 * The browser is telemetry only. This worker always rebuilds legal moves and
 * policy recommendations from the checked-in runtime, never accepts an
 * attached replay/regret value, and emits evidence only after exact execution,
 * complete legal coverage and paired terminal-outcome rollouts with rigorous
 * simultaneous confidence bounds. Static scores can never create evidence.
 *
 * Until server-signed experience snapshots exist, recursively learned games
 * are deliberately excluded: only the canonical empty frozen experience can
 * create new evidence. Learned patterns can still be consumed by v35; they
 * simply cannot train the next generation yet.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const { pathToFileURL } = require('node:url');
const {
  DEFAULT_LIMITS: DEFAULT_SHADOW_LIMITS,
  afterPositionKey,
  canonicalMoveKey,
  canonicalMoves,
  generateLongBotShadowReplay,
  loadRuntime,
  replayExperienceForGame,
  stableStringify,
  stateFromSnapshot,
} = require('./generate-long-bot-shadow-replay');
const {
  DEFAULT_ROLLOUT_LIMITS,
  generatePairedPolicyOutcomes,
  validatePairedOutcomeEvidence,
} = require('./long-bot-paired-rollout');
const {
  SOURCES: POLICY_SOURCES,
  readPolicySourceEntries,
  policyImplementationId: calculatePolicyImplementationId,
  renderLongBotBundle,
} = require('./build-long-bot-engine');

const ROOT = path.join(__dirname, '..');
// This capability is created only after a verified server claim. Offline
// options, browser telemetry and exported helpers cannot construct it.
const PRODUCTION_SCOPE = Symbol('verified-production-review-slice');
const VERIFIED_SCOPES = new WeakSet();
const LEGACY_PROGRESS_SCHEMA = 'long-server-causal-progress-v1';
const PROGRESS_SCHEMA = 'long-server-causal-progress-v2';
const ENGINE_VERSION = 'long-analytic-v35';
const WORKER_RELEASE = 'long-server-causal-review-v1';
const EVIDENCE_SCHEMA = 'long-server-causal-evidence-v1';
const POLICY_ROLE = 'current-frozen-cold-re-review';
const RESULT_SCHEMA = 'long-server-causal-review-result-v1';
const TRUST_DOMAIN = 'nardu/server-long-bot-causal/v1';
const PRODUCTION_EXPENSIVE_REVIEW_LIMIT = 4;
const PRODUCTION_CHEAP_BURST_LIMIT = 64;
const PRODUCTION_CHEAP_BURST_MS = 60000;
const RPC_TIMEOUT_MS = 60000;
const RPC_PRECONNECT_RETRY_DELAYS_MS = Object.freeze([250, 750]);
// These failures occur before a TCP request can be delivered. A lost socket or
// response is deliberately absent: the database may already have committed a
// claim or checkpoint, so replaying that RPC could consume a second job/slice.
const RPC_PRECONNECT_CODES = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const RPC_TRANSPORT_DIAGNOSTIC_CODES = new Set([
  ...RPC_PRECONNECT_CODES, 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const PRODUCTION_REVIEW_SELECTION_SCHEMA = 'long-server-causal-strategic-risk-selection-v1';
const REVIEWER_PATH = path.join(ROOT, 'bot-engine', 'long', 'reviewer.ts');
const PRODUCTION_POLICY = Object.freeze({
  strategyProfile: 'v25', maxCandidates: 64, analysisNodeBudget: 480,
  weights: Object.freeze({
    opponentHeadFreedom: 48000, headLandingExposure: 62000, headRelease: 9800,
    foothold: 4300, homeEntry: 145000, rushPenalty: 12500,
    trapRisk: 62000, escapeGatewayRisk: 800000, distribution: 780,
  }),
});
// The browser dispatch has one deliberately smaller envelope for live doubles.
// It is not a caller-selected "fast mode": the immutable decision snapshot
// chooses this exact policy, while every other position keeps the full policy
// above. Keeping both policies in one attested envelope lets the causal worker
// replay what production actually selected without accepting arbitrary client
// resource knobs.
const PRODUCTION_LIVE_DOUBLES_POLICY = Object.freeze({
  strategyProfile: 'v25',
  maxCandidates: 16,
  initialSequenceLimit: 16,
  maxTacticalCandidates: 2,
  analysisNodeBudget: 58,
  weights: PRODUCTION_POLICY.weights,
});
// v35 was already deployed with this exact live-doubles envelope. Every one
// of the 17 audited games contains at least one such decision, so silently
// replacing it with the new envelope would make the whole immutable ledger
// unverifiable and would discard all historical learning. Keep this one exact
// tuple as replay-only compatibility; it is never selected for new play.
const PRODUCTION_LEGACY_LIVE_DOUBLES_POLICY = Object.freeze({
  strategyProfile: 'v25',
  maxCandidates: 16,
  initialSequenceLimit: 16,
  analysisNodeBudget: 12,
  weights: PRODUCTION_POLICY.weights,
});
const PRODUCTION_POLICY_ENVELOPE = Object.freeze({
  schema: 'long-v35-production-decision-policy-envelope-v1',
  selector: Object.freeze({
    schema: 'long-v35-live-doubles-snapshot-selector-v1',
    defaultPolicy: 'ordinary',
    liveDoublesPolicy: 'liveDoubles',
    rolledLength: 4,
    remainingDiceMinimum: 1,
    requiresOneRepeatedDie: true,
  }),
  ordinary: PRODUCTION_POLICY,
  liveDoubles: PRODUCTION_LIVE_DOUBLES_POLICY,
  replayOnlyLegacyLiveDoubles: PRODUCTION_LEGACY_LIVE_DOUBLES_POLICY,
});
const EXECUTABLE_DEPENDENCIES = Object.freeze([
  ['worker', __filename],
  ['reviewer', REVIEWER_PATH],
  ['paired-rollout', path.join(__dirname, 'long-bot-paired-rollout.js')],
  ['terminal-journal', path.join(__dirname, 'long-bot-terminal-journal.js')],
  ['production-fence', path.join(__dirname, 'long-bot-production-fence.js')],
  ['shadow-replay', path.join(__dirname, 'generate-long-bot-shadow-replay.js')],
  ['simulator-dice', path.join(__dirname, 'simulate-long-bot-regression.js')],
  ['production-dispatch', path.join(ROOT, 'strong-bot.js')],
  ['policy-build-binding', path.join(__dirname, 'build-long-bot-engine.js')],
  ...POLICY_SOURCES.map(file => [`policy-source:${file}`, path.join(ROOT, file)]),
]);
// These imported modules must not be re-labelled with edited-on-disk bytes in
// a long-lived process. Runtime/game files are checked against their VM bytes.
const CAPTURED_EXECUTABLE_BYTES = new Map(EXECUTABLE_DEPENDENCIES.map(([name, file]) => [name, fs.readFileSync(file)]));
const DEFAULT_LIMITS = Object.freeze({
  ...DEFAULT_SHADOW_LIMITS,
  // Trusted full-policy server replay can take tens of seconds. The
  // diagnostic standalone shadow CLI keeps its separate five-second cap.
  maxElapsedMs: 120000,
  maxDecisionsPerGame: 160,
  maxTotalDecisionsPerGame: 320,
});

let reviewerPromise = null;

function loadReviewer() {
  reviewerPromise ||= import(pathToFileURL(REVIEWER_PATH).href);
  return reviewerPromise;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return stableStringify(value);
}

function runtimeClosureEntries(options = {}) {
  const gamePath = path.resolve(options.gamePath || path.join(ROOT, 'game.js'));
  const runtimePath = path.resolve(options.runtimePath || path.join(ROOT, 'long-bot-engine.js'));
  const entries = [['game', fs.readFileSync(gamePath)], ['engine-bundle', fs.readFileSync(runtimePath)]];
  const loaded = loadRuntime(options);
  if (
    loaded.gameBytesDigest !== sha256(entries[0][1])
    || loaded.runtimeBytesDigest !== sha256(entries[1][1])
  ) throw new Error('Game/engine runtime changed after VM load; restart the immutable worker');
  for (const [name, file] of EXECUTABLE_DEPENDENCIES) {
    const bytes = fs.readFileSync(file);
    if (!bytes.equals(CAPTURED_EXECUTABLE_BYTES.get(name))) {
      throw new Error(`Executable dependency changed after worker load: ${name}`);
    }
    entries.push([name, bytes]);
  }
  return entries;
}

function runtimeClosureFiles(options = {}) {
  return [
    ['game.js', path.resolve(options.gamePath || path.join(ROOT, 'game.js'))],
    ['long-bot-engine.js', path.resolve(options.runtimePath || path.join(ROOT, 'long-bot-engine.js'))],
    ...EXECUTABLE_DEPENDENCIES.map(([, file]) => [path.relative(ROOT, file), file]),
  ];
}

function policyImplementationId(options = {}) {
  const id = String(loadRuntime(options).engine.policyImplementationId || '');
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Trusted policy requires a built SHA-256 implementation binding');
  const sourceEntries = readPolicySourceEntries(ROOT).map(([name, bytes]) => (
    name === 'game.js' && options.gamePath
      ? [name, fs.readFileSync(path.resolve(options.gamePath))] : [name, bytes]
  ));
  if (id !== calculatePolicyImplementationId(sourceEntries)) {
    throw new Error('Built policy implementation SHA does not match its source/rules/production-weight preimage; rebuild the immutable runtime');
  }
  const bundlePath = path.resolve(options.runtimePath || path.join(ROOT, 'long-bot-engine.js'));
  if (!fs.readFileSync(bundlePath).equals(Buffer.from(renderLongBotBundle(sourceEntries)))) {
    throw new Error('Engine executable bundle does not match its canonical policy implementation preimage');
  }
  return id;
}

function runtimeDigestFromEntries(entries, options = {}) {
  const digest = crypto.createHash('sha256');
  digest.update(`${TRUST_DOMAIN}\0${WORKER_RELEASE}\0`);
  for (const [name, bytes] of entries) {
    digest.update(name);
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');
  }
  digest.update(canonicalJson({ node: process.versions.node, v8: process.versions.v8 }));
  // Attest the whole decision-policy envelope, not merely the ordinary-roll
  // branch. Otherwise a live-doubles resource change could leave the release
  // identity claiming the wrong replay contract.
  digest.update(canonicalJson(serverOwnedPolicyEnvelope(options)));
  digest.update(canonicalJson(options.rolloutLimits || DEFAULT_ROLLOUT_LIMITS));
  return digest.digest('hex');
}

function runtimeDigest(options = {}) {
  policyImplementationId(options);
  return runtimeDigestFromEntries(runtimeClosureEntries(options), options);
}

function verifiedRuntimeDigest(options = {}) {
  const actual = runtimeDigest(options);
  if (options.runtimeDigest !== undefined && options.runtimeDigest !== actual) {
    throw new Error('Frozen worker runtime digest does not match its executable closure');
  }
  return actual;
}

function serverOwnedPolicy(options = {}) {
  if (options.trustedTrainingPolicy === undefined) return PRODUCTION_POLICY;
  const policy = options.trustedTrainingPolicy;
  if (
    !policy || policy.strategyProfile !== 'v25'
    || !Number.isInteger(policy.maxCandidates) || policy.maxCandidates < 1 || policy.maxCandidates > 128
    || !Number.isInteger(policy.analysisNodeBudget) || policy.analysisNodeBudget < 1 || policy.analysisNodeBudget > 1150
    || (policy.weights !== undefined && canonicalJson(policy.weights) !== canonicalJson(PRODUCTION_POLICY.weights))
    || Object.keys(policy).some(key => !['strategyProfile', 'maxCandidates', 'analysisNodeBudget', 'weights'].includes(key))
  ) throw new Error('Invalid explicit trusted offline training policy');
  return {
    strategyProfile: 'v25', maxCandidates: policy.maxCandidates, analysisNodeBudget: policy.analysisNodeBudget,
    ...(policy.weights === undefined ? {} : { weights: PRODUCTION_POLICY.weights }),
  };
}

function serverOwnedPolicyEnvelope(options = {}) {
  if (options.trustedTrainingPolicy === undefined) return PRODUCTION_POLICY_ENVELOPE;
  return {
    schema: 'long-v35-trusted-offline-uniform-policy-envelope-v1',
    selector: 'all-decisions',
    policy: serverOwnedPolicy(options),
  };
}

function isProductionLiveDoublesDecision(decision) {
  const snapshot = decision?.stateSnapshotV2;
  const rolled = snapshot?.rolled;
  const dice = snapshot?.dice;
  return Array.isArray(rolled)
    && rolled.length === PRODUCTION_POLICY_ENVELOPE.selector.rolledLength
    && rolled.every(die => Number.isInteger(die) && die >= 1 && die <= 6 && die === rolled[0])
    && Array.isArray(dice)
    && dice.length >= PRODUCTION_POLICY_ENVELOPE.selector.remainingDiceMinimum
    && dice.every(die => die === rolled[0]);
}

function serverOwnedDecisionPolicy(decision, options = {}) {
  if (options.trustedTrainingPolicy !== undefined) return serverOwnedPolicy(options);
  if (!isProductionLiveDoublesDecision(decision)) return PRODUCTION_POLICY;
  const archived = decision?.replayInput?.runtime;
  return canonicalJson(archived) === canonicalJson(PRODUCTION_LEGACY_LIVE_DOUBLES_POLICY)
    ? PRODUCTION_LEGACY_LIVE_DOUBLES_POLICY
    : PRODUCTION_LIVE_DOUBLES_POLICY;
}

function archivedPolicyFailure(decision, options = {}) {
  const archived = decision?.replayInput?.runtime;
  const approved = serverOwnedDecisionPolicy(decision, options);
  if (!archived || canonicalJson(archived) !== canonicalJson(approved)) {
    return options.trustedTrainingPolicy === undefined
      ? 'unapproved-production-policy' : 'trusted-training-policy-mismatch';
  }
  return '';
}

function finiteInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function exactMoves(moves) {
  if (!Array.isArray(moves) || moves.length < 1) return '';
  const normalized = [];
  for (const move of moves) {
    const from = finiteInteger(move?.from);
    const die = finiteInteger(move?.die);
    const rawTo = move?.bearOff || move?.to === 0 ? 0 : move?.to;
    const to = finiteInteger(rawTo);
    if (from === null || die === null || to === null) return '';
    normalized.push({ from, to, die, bearOff: to === 0 });
  }
  return canonicalMoveKey(normalized);
}

function executedCandidate(decision) {
  const execution = decision?.execution;
  if (!execution || execution.complete !== true) return null;
  return execution.executed
    || (execution.after ? {
      after: execution.after,
      moves: execution.executedMoves || execution.actualMoves || execution.moves,
      experience: execution.experience,
    } : null);
}

function exactExecution(decision) {
  const execution = decision?.execution;
  const selected = decision?.selected;
  const executed = executedCandidate(decision);
  if (
    !execution
    || execution.complete !== true
    || execution.fallback === true
    || execution.substituted === true
    || execution.selectedMatchesExecuted === false
    || (Array.isArray(execution.substitutions) && execution.substitutions.length > 0)
  ) return { ok: false, reason: 'execution-not-exact' };

  const selectedPositionKey = afterPositionKey(selected);
  const executedPositionKey = afterPositionKey(executed);
  const selectedMoveKey = exactMoves(selected?.moves);
  const executedMoveKey = exactMoves(
    execution.executedMoves
    || execution.actualMoves
    || execution.moves
    || executed?.moves,
  );
  const selectedActionKey = String(
    selected?.experience?.actionKey || decision?.experience?.actionKey || '',
  );
  const executedActionKey = String(
    execution.executedActionKey
    || executed?.experience?.actionKey
    || executed?.actionKey
    || '',
  );
  if (!selectedPositionKey || !executedPositionKey) {
    return { ok: false, reason: 'execution-position-missing' };
  }
  if (selectedPositionKey !== executedPositionKey) {
    return { ok: false, reason: 'execution-position-mismatch' };
  }
  if (!selectedMoveKey || !executedMoveKey || selectedMoveKey !== executedMoveKey) {
    return { ok: false, reason: 'execution-moves-mismatch' };
  }
  if (!selectedActionKey || !executedActionKey || selectedActionKey !== executedActionKey) {
    return { ok: false, reason: 'execution-action-mismatch' };
  }
  return {
    ok: true,
    selectedPositionKey,
    executedPositionKey,
    selectedMoveKey,
    executedMoveKey,
    selectedActionKey,
  };
}

function botDecision(decision, game) {
  const botColor = String(game?.bot_color || game?.botColor || '').toLowerCase();
  const decisionColor = String(decision?.color || '').toLowerCase();
  if (botColor && decisionColor) return botColor === decisionColor;
  return String(decision?.actor || 'bot').toLowerCase() === 'bot';
}

function gameLoss(game) {
  const winner = String(game?.winner || '').toLowerCase();
  const botColor = String(game?.bot_color || game?.botColor || '').toLowerCase();
  return ['white', 'dark'].includes(winner)
    && ['white', 'dark'].includes(botColor)
    && winner !== botColor;
}

function trainingDecisions(game) {
  if (Array.isArray(game?.decisions)) return game.decisions;
  return Array.isArray(game?.training_game?.decisions) ? game.training_game.decisions : [];
}

function nativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Keep this outcome-independent curriculum identical to the bounded offline
// army selector. Archived features decide only where expensive review effort
// goes; they can never establish regret or create evidence by themselves.
function archivedOutsideCount(game, decision) {
  const snapshot = decision?.stateSnapshotV2;
  const color = decision?.color;
  if (!['white', 'dark'].includes(color) || (game.bot_color || game.botColor) !== color
    || snapshot?.schema !== 'long-state-v2' || snapshot.variant !== 'long'
    || snapshot.phase !== 'move' || snapshot.turn !== color
    || !snapshot.points || typeof snapshot.points !== 'object' || Array.isArray(snapshot.points)
    || Object.keys(snapshot.points).length > 24 || !snapshot.off || !snapshot.bar) return null;
  const totals = { white: 0, dark: 0 };
  for (const side of ['white', 'dark']) {
    const off = snapshot.off[side];
    if (!Number.isSafeInteger(off) || off < 0 || off > 15 || snapshot.bar[side] !== 0) return null;
    totals[side] = off;
  }
  let outside = 0;
  for (const [key, stack] of Object.entries(snapshot.points)) {
    if (!/^(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || !stack || Array.isArray(stack)
      || !['white', 'dark'].includes(stack.color) || !Number.isSafeInteger(stack.count)
      || stack.count < 1 || stack.count > 15) return null;
    totals[stack.color] += stack.count;
    const point = Number(key);
    const inHome = color === 'white' ? point <= 6 : point >= 13 && point <= 18;
    if (stack.color === color && !inHome) outside += stack.count;
  }
  return totals.white === 15 && totals.dark === 15 ? outside : null;
}

function archivedStrategicRisk(game, decision) {
  const features = decision?.selected?.features;
  if ((game.engine_version || game.engineVersion) !== ENGINE_VERSION
    || decision?.engineVersion !== ENGINE_VERSION || decision?.source !== 'engine'
    || !features || typeof features !== 'object' || Array.isArray(features)) return { tier: 0, signals: [] };
  const choiceCount = decision.choiceCount;
  const multipleChoices = Number.isSafeInteger(choiceCount) && choiceCount > 1;
  const primeBefore = nativeFinite(features.primeRunBefore);
  const primeAfter = nativeFinite(features.primeRunAfter);
  if (multipleChoices && primeBefore !== null && primeAfter !== null
    && Number.isSafeInteger(primeBefore) && primeBefore >= 5 && primeBefore <= 15
    && Number.isSafeInteger(primeAfter) && primeAfter >= 0 && primeAfter < primeBefore) {
    return { tier: 4, signals: ['prime-loss-with-choice'] };
  }
  const primeScoreBefore = nativeFinite(features.primeScoreBefore);
  const blockBefore = nativeFinite(features.opponentMoveBlockBefore);
  const blockGain = nativeFinite(features.opponentMoveBlockGain);
  if (multipleChoices && primeBefore === 4
    && primeAfter !== null && Number.isSafeInteger(primeAfter) && primeAfter >= 0 && primeAfter < 4
    && primeScoreBefore !== null && primeScoreBefore > 0
    && blockBefore !== null && blockBefore > 0 && blockGain !== null && blockGain < 0) {
    return { tier: 4, signals: ['active-four-prime-loss-with-choice'] };
  }
  const structural = [
    ['headLandingBreak', 'head-support-break', value => value > 0],
    ['latentFenceExposureDelta', 'latent-fence-deterioration', value => value < 0],
    ['fenceClosureDelta', 'fence-deterioration', value => value < 0],
    ['escapeGatewayDelta', 'gateway-deterioration', value => value < 0],
  ].filter(([field, , worsens]) => {
    const value = nativeFinite(features[field]);
    return value !== null && worsens(value);
  }).map(([, signal]) => signal);
  if (structural.length) return { tier: 3, signals: structural };
  const shuffle = nativeFinite(features.homeShuffleMoves);
  const reduction = nativeFinite(features.outsideReduction);
  const outside = archivedOutsideCount(game, decision);
  if (shuffle !== null && Number.isSafeInteger(shuffle) && shuffle > 0 && shuffle <= 4
    && reduction !== null && Number.isSafeInteger(reduction) && reduction <= 0 && reduction >= -15
    && outside !== null && outside > 0) {
    return { tier: 2, signals: ['home-shuffle-with-outside-checkers'] };
  }
  const tactical = decision.selected.tactical;
  const missingAnalysis = tactical === null || tactical === undefined;
  const incompleteAnalysis = tactical && typeof tactical === 'object' && !Array.isArray(tactical)
    && (tactical.distributionComplete === undefined || tactical.distributionComplete === false
      || tactical.recoveryDistributionComplete === false || tactical.continuationCoverageComplete === false);
  if (multipleChoices && (missingAnalysis || incompleteAnalysis)) {
    return { tier: 1, signals: ['multiple-choice-analysis-diagnostic'] };
  }
  return { tier: 0, signals: [] };
}

function productionStrategicReviewPlan(game) {
  const risks = trainingDecisions(game).map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => botDecision(decision, game))
    .map(({ decision, index }) => ({ index, ...archivedStrategicRisk(game, decision),
      envelopeFailure: trustedDecisionEnvelopeFailure(game, decision) }))
    .sort((left, right) => right.tier - left.tier || right.index - left.index);
  // A malformed archived decision still receives an explicit original-ledger
  // rejection, but cannot consume one of the four expensive review slots for
  // independently valid decisions in the same finished game.
  const reviewable = risks.filter(risk => !risk.envelopeFailure);
  return {
    schema: PRODUCTION_REVIEW_SELECTION_SCHEMA,
    strategy: 'strategic-risk',
    ordering: 'strategic-tier-then-reverse-original-bot-ledger',
    riskRole: 'curriculum-only',
    outcomeUsed: false,
    maximumExpensiveReviews: PRODUCTION_EXPENSIVE_REVIEW_LIMIT,
    expensiveDecisionIndexes: reviewable.slice(0, PRODUCTION_EXPENSIVE_REVIEW_LIMIT).map(({ index }) => index),
    risks: risks.map(({ index, tier, signals }) => ({ index, tier, signals: [...signals] })),
  };
}

function validateGameEnvelope(game, limits = DEFAULT_LIMITS) {
  if (!game || typeof game !== 'object') return 'training-game-missing';
  if (String(game.engine_version || game.engineVersion || '') !== ENGINE_VERSION) {
    return 'engine-version-mismatch';
  }
  if (String(game.difficulty || '') !== 'hard') return 'difficulty-mismatch';
  const finalState = game.final_state || game.finalState || {};
  if (String(finalState.variant || game.variant || '') !== 'long') return 'variant-mismatch';
  // Outcome is only a queue/cohort selector. It never affects a decision's
  // recommendation, evidence weight or penalty.
  if (!gameLoss(game)) return 'not-loss-cohort';
  const decisions = trainingDecisions(game);
  if (!decisions.length) return 'decisions-missing';
  if (decisions.length > limits.maxTotalDecisionsPerGame) return 'decision-ledger-limit';
  // Native selector types prevent JSON falsy values from changing which
  // original rows the JS reviewer and SQL cursor consider bot decisions.
  if (decisions.some(decision => !decision || typeof decision !== 'object' || Array.isArray(decision)
    || (decision.color !== undefined && typeof decision.color !== 'string')
    || (decision.actor !== undefined && typeof decision.actor !== 'string'))) return 'decision-selector-invalid';
  const memory = finalState?.analysis?.botMemory || {};
  const coverage = memory.coverage || {};
  const expected = coverage.expectedBotDecisions;
  const recorded = coverage.recordedBotDecisions;
  const recovered = coverage.recoveredBotDecisions;
  const botCount = decisions.filter(decision => botDecision(decision, game)).length;
  if (botCount > limits.maxDecisionsPerGame) return 'decision-limit';
  if (
    memory.engineVersion !== ENGINE_VERSION
    || coverage.complete !== true
    || !Number.isSafeInteger(expected)
    || !Number.isSafeInteger(recorded) || recorded < 0
    || !Number.isSafeInteger(recovered) || recovered < 0
    || expected < 1
    || expected !== recorded + recovered
    || expected !== botCount
  ) return 'training-coverage-incomplete';
  if (decisions.some(decision => (
    botDecision(decision, game) && decision?.engineVersion !== ENGINE_VERSION
  ))) return 'mixed-engine-ledger';
  return '';
}

function emptyFrozenExperience(game, decision) {
  const experience = replayExperienceForGame(game, decision);
  return Boolean(
    experience
    && experience.complete === true
    && experience.frozen === true
    && experience.engineVersion === ENGINE_VERSION
    && experience.size === 0
    && experience.patternCount === 0
    && Array.isArray(experience.patterns)
    && experience.patterns.length === 0,
  );
}

function compactPolicyCandidate(candidate) {
  return {
    after: candidate?.after,
    moves: canonicalMoves(candidate?.sequence || candidate?.moves || []),
    score: Number(candidate?.score),
    features: candidate?.features || {},
    experience: candidate?.experience || null,
    tactical: candidate?.tactical || null,
  };
}

function findExactShadowSelected(decision, candidates) {
  const selectedPosition = afterPositionKey(decision?.selected);
  const selectedMoves = exactMoves(decision?.selected?.moves);
  return (Array.isArray(candidates) ? candidates : []).find(candidate => (
    afterPositionKey(candidate) === selectedPosition
    && exactMoves(candidate?.moves) === selectedMoves
  )) || null;
}

function regenerateArchivedSelection(game, decision, options = {}) {
  const policyFailure = archivedPolicyFailure(decision, options);
  if (policyFailure) return { ok: false, reason: policyFailure };
  const runtime = loadRuntime(options);
  runtime.engine.setExperience([], 'server-causal-review');
  const state = stateFromSnapshot(decision.stateSnapshotV2 || {});
  const ranked = runtime.engine.rank(state, serverOwnedDecisionPolicy(decision, options));
  const selected = compactPolicyCandidate(ranked?.[0]);
  if (
    afterPositionKey(selected) !== afterPositionKey(decision.selected)
    || exactMoves(selected.moves) !== exactMoves(decision.selected?.moves)
    || String(selected.experience?.contextKey || '') !== String(decision.selected?.experience?.contextKey || '')
    || String(selected.experience?.actionKey || '') !== String(decision.selected?.experience?.actionKey || '')
    || Number(decision.selected?.experienceAdjustment || 0) !== 0
  ) return { ok: false, reason: 'archived-policy-not-reproduced' };
  return { ok: true, selected };
}

function validateDecisionResources(game, decision) {
  const snapshot = decision?.stateSnapshotV2;
  const runtime = decision?.replayInput?.runtime;
  const approvedPolicy = serverOwnedDecisionPolicy(decision);
  const allowedRuntimeKeys = new Set(Object.keys(approvedPolicy));
  if (
    !runtime || runtime.strategyProfile !== 'v25'
    || typeof runtime !== 'object' || Array.isArray(runtime)
    || Object.keys(runtime).some(key => !allowedRuntimeKeys.has(key))
    || !Number.isInteger(runtime.maxCandidates)
    || runtime.maxCandidates < 1 || runtime.maxCandidates > 128
    || !Number.isInteger(runtime.analysisNodeBudget)
    || runtime.analysisNodeBudget < 1 || runtime.analysisNodeBudget > 1150
    || (Object.hasOwn(approvedPolicy, 'initialSequenceLimit') && (
      !Number.isInteger(runtime.initialSequenceLimit)
      || runtime.initialSequenceLimit < 1 || runtime.initialSequenceLimit > 128
    ))
    || (Object.hasOwn(approvedPolicy, 'maxTacticalCandidates') && (
      !Number.isInteger(runtime.maxTacticalCandidates)
      || runtime.maxTacticalCandidates < 1 || runtime.maxTacticalCandidates > 128
    ))
    || (runtime.weights !== undefined && (
      !runtime.weights || typeof runtime.weights !== 'object' || Array.isArray(runtime.weights)
      || Object.keys(runtime.weights).length > 128
      || Object.values(runtime.weights).some(value => !Number.isFinite(value) || Math.abs(value) > 1000000)
    ))
  ) return 'archived-runtime-resource-limit';
  const die = value => Number.isInteger(value) && value >= 1 && value <= 6;
  if (
    !snapshot || snapshot.schema !== 'long-state-v2'
    || snapshot.variant !== 'long' || snapshot.phase !== 'move'
    || !['white', 'dark'].includes(snapshot.turn)
    || snapshot.turn !== String(game?.bot_color || game?.botColor || '')
    || !snapshot.points || typeof snapshot.points !== 'object' || Array.isArray(snapshot.points)
    || Object.keys(snapshot.points).length > 24
    || !Array.isArray(snapshot.dice) || snapshot.dice.length < 1 || snapshot.dice.length > 4
    || !snapshot.dice.every(die)
    || !Array.isArray(snapshot.rolled) || ![2, 4].includes(snapshot.rolled.length) || !snapshot.rolled.every(die)
    || (snapshot.rolled.length === 4 && !snapshot.rolled.every(value => value === snapshot.rolled[0]))
    || !Array.isArray(snapshot.turnMoves) || snapshot.turnMoves.length > 4
    || snapshot.turnMoves.length + snapshot.dice.length > 4
  ) return 'decision-state-envelope-invalid';
  const totals = { white: 0, dark: 0 };
  for (const [point, stack] of Object.entries(snapshot.points)) {
    if (
      !/^(?:[1-9]|1[0-9]|2[0-4])$/.test(point)
      || !['white', 'dark'].includes(stack?.color)
      || !Number.isInteger(stack?.count) || stack.count < 1 || stack.count > 15
    ) return 'decision-state-envelope-invalid';
    totals[stack.color] += stack.count;
  }
  for (const color of ['white', 'dark']) {
    if (
      snapshot.bar?.[color] !== 0
      || !Number.isInteger(snapshot.off?.[color]) || snapshot.off[color] < 0 || snapshot.off[color] > 15
      || totals[color] + snapshot.off[color] !== 15
      || typeof snapshot.firstMoveDone?.[color] !== 'boolean'
      || typeof snapshot.headPlayedThisTurn?.[color] !== 'boolean'
    ) return 'decision-state-envelope-invalid';
  }
  const remaining = snapshot.rolled.length === 2 && snapshot.rolled[0] === snapshot.rolled[1]
    ? Array(4).fill(snapshot.rolled[0]) : [...snapshot.rolled];
  for (const value of snapshot.dice) {
    const index = remaining.indexOf(value);
    if (index < 0) return 'decision-state-envelope-invalid';
    remaining.splice(index, 1);
  }
  for (const move of snapshot.turnMoves) {
    if (
      !Number.isInteger(move?.from) || move.from < 1 || move.from > 24
      || !Number.isInteger(move?.to) || move.to < 0 || move.to > 24
      || !die(move?.die) || remaining.indexOf(move.die) < 0
    ) return 'decision-state-envelope-invalid';
    remaining.splice(remaining.indexOf(move.die), 1);
  }
  return '';
}

function trustedDecisionEnvelopeFailure(game, decision, options = {}) {
  if (!botDecision(decision, game)) return 'not-bot-decision';
  if (
    decision?.source !== 'engine'
    || decision?.fallback === true
    || decision?.fallbackReason
    || decision?.engineVersion !== ENGINE_VERSION
  ) return 'decision-provenance-invalid';
  const policyFailure = archivedPolicyFailure(decision, options);
  if (policyFailure) return policyFailure;
  const resourceFailure = validateDecisionResources(game, decision);
  if (resourceFailure) return resourceFailure;
  const execution = exactExecution(decision);
  if (!execution.ok) return execution.reason;
  if (!emptyFrozenExperience(game, decision)) return 'recursive-experience-provenance-unsigned';
  return '';
}

function collisionResistantIdentities(decision, selected, recommended) {
  const stateCanonical = canonicalJson(decision.stateSnapshotV2);
  const stateId = sha256(`${TRUST_DOMAIN}\0state\0${stateCanonical}`);
  const actionPayload = candidate => canonicalJson({
    stateId,
    moves: exactMoves(candidate?.moves),
    after: afterPositionKey(candidate),
    contextKey: String(candidate?.experience?.contextKey || ''),
    actionKey: String(candidate?.experience?.actionKey || ''),
  });
  return {
    stateId,
    selectedActionId: sha256(`${TRUST_DOMAIN}\0action\0${actionPayload(selected)}`),
    recommendedActionId: sha256(`${TRUST_DOMAIN}\0action\0${actionPayload(recommended)}`),
  };
}

function offlineTerminalJournalFailure(options) {
  const config = options.trustedOfflineTerminalJournal;
  if (config === undefined) return '';
  if (!VERIFIED_SCOPES.has(options[PRODUCTION_SCOPE])
    && (options.trustedTrainingPolicy === undefined || options.reviewDecisionIndexes === undefined)) {
    return 'terminal-journal-requires-explicit-trusted-offline-scope';
  }
  if (!config || typeof config !== 'object' || types.isProxy(config)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(config))) return 'terminal-journal-config-invalid';
  const descriptors = Object.getOwnPropertyDescriptors(config);
  if (Reflect.ownKeys(descriptors).length !== 1 || !descriptors.directory
    || !Object.prototype.hasOwnProperty.call(descriptors.directory, 'value')
    || typeof descriptors.directory.value !== 'string' || descriptors.directory.value.length > 4096
    || !path.isAbsolute(descriptors.directory.value)) return 'terminal-journal-config-invalid';
  if (options.runtime || options.outcomeRunner || options.pairedOutcomeGenerator
    || options.shadowReplayGenerator || options.archivedSelectionReplay) return 'terminal-journal-requires-native-replay';
  return '';
}

function offlineTerminalJournalBindings(game, decision, selected, options, nativeRuntime) {
  const ledger = trainingDecisions(game);
  const matchingIndexes = ledger.map((row, index) => canonicalJson(row) === canonicalJson(decision) ? index : null)
    .filter(index => index !== null);
  if (matchingIndexes.length !== 1) throw new Error('Terminal journal decision is not unique in the original ledger');
  const scope = options[PRODUCTION_SCOPE];
  const production = VERIFIED_SCOPES.has(scope);
  return {
    schema: 'long-offline-terminal-journal-bindings-v1',
    policyRole: POLICY_ROLE, historicalImplementationAttested: false,
    sourceGameId: String(game.id || game.training_game_id || ''),
    originalGameCanonicalSha256: sha256(canonicalJson(game)),
    originalLedgerCanonicalSha256: sha256(canonicalJson(ledger)),
    sourceDecisionIndex: matchingIndexes[0], sourceDecisionId: decision.id,
    originalArchiveFingerprintSemantics: 'offline canonical whole-game SHA, NOT PostgreSQL payload-text SHA',
    orderedOriginalExecutionCanonical: canonicalJson(decision.execution),
    regeneratedSelectedContextKey: selected.experience.contextKey,
    regeneratedSelectedActionKey: selected.experience.actionKey,
    currentPolicyImplementationId: policyImplementationId(options),
    currentConfiguredRuntimeDigest: verifiedRuntimeDigest(options),
    executableClosure: runtimeClosureEntries(options).map(([name, bytes]) => ({ name, sha256: sha256(bytes) })),
    gameBytesSha256: nativeRuntime.gameBytesDigest, bundleBytesSha256: nativeRuntime.runtimeBytesDigest,
    node: process.versions.node, v8: process.versions.v8,
    originalSelectionPolicy: serverOwnedDecisionPolicy(decision, options),
    frozenFutureExperienceCanonical: canonicalJson(nativeRuntime.engine.experienceReplaySnapshot()),
    legalSetSemantics: 'every unique legal after-board, one fixed native ordered action per board',
    ...(production ? {
      schema: 'long-server-terminal-journal-bindings-v1',
      originalArchiveFingerprintSemantics: 'PostgreSQL authoritative eight-field jsonb payload UTF8 text SHA-256',
      authoritativeArchiveFingerprint: scope.archiveFingerprint,
      authoritativeArchivePayloadText: scope.archiveFingerprintSource,
      serverJobId: scope.jobId,
    } : {}),
  };
}

async function reviewTrustedDecision(game, decision, options = {}) {
  const base = {
    decisionId: String(decision?.id || ''),
    positionId: String(decision?.positionId || ''),
    status: 'rejected',
    reason: '',
    evidence: null,
    outcomeUsed: false,
  };
  const journalFailure = offlineTerminalJournalFailure(options);
  if (journalFailure) return { ...base, reason: journalFailure };
  const envelopeFailure = trustedDecisionEnvelopeFailure(game, decision, options);
  if (envelopeFailure) return { ...base, reason: envelopeFailure };
  const execution = exactExecution(decision);

  // Always regenerate under the CURRENT frozen cold implementation. Matching
  // the archived action does not attest which source build played originally.
  // A client-provided replay is intentionally ignored.
  const shadowGenerator = options.shadowReplayGenerator || generateLongBotShadowReplay;
  const shadow = await shadowGenerator(game, decision, {
    ...options,
    limits: {
      ...DEFAULT_LIMITS,
      ...(options.shadowLimits || {}),
    },
  });
  if (!shadow?.ok || shadow.replay?.coverage?.complete !== true) {
    return { ...base, reason: shadow?.reason || 'complete-legal-replay-missing' };
  }
  const legalSelected = findExactShadowSelected(decision, shadow.replay.candidates);
  if (!legalSelected) return { ...base, reason: 'selected-shadow-identity-mismatch' };
  const uniqueLegalPositions = new Set(shadow.replay.candidates.map(afterPositionKey));
  if (uniqueLegalPositions.size < 2) {
    return { ...base, reason: 'rollout-alternatives-missing' };
  }
  let reproduced;
  try {
    reproduced = options.archivedSelectionReplay
      ? await options.archivedSelectionReplay(game, decision, options)
      : regenerateArchivedSelection(game, decision, options);
  } catch (error) {
    return { ...base, reason: 'archived-policy-replay-failed', detail: String(error?.message || error) };
  }
  if (!reproduced.ok) return { ...base, reason: reproduced.reason };
  const selected = reproduced.selected;

  let rollout;
  try {
    const outcomeGenerator = options.pairedOutcomeGenerator || generatePairedPolicyOutcomes;
    const nativeRuntime = outcomeGenerator === generatePairedPolicyOutcomes && !options.runtime && !options.outcomeRunner
      ? loadRuntime(options) : null;
    // Attest actual server bytes/current policy, never a client/injected claim.
    const rolloutOptions = nativeRuntime ? {
      ...options,
      ...(options.trustedOfflineTerminalJournal === undefined ? {} : {
        terminalJournalBindings: offlineTerminalJournalBindings(game, decision, selected, options, nativeRuntime),
      }),
      nativeCacheAttestation: {
        runtimeDigest: verifiedRuntimeDigest(options),
        policyImplementationId: policyImplementationId(options),
        gameBytesDigest: nativeRuntime.gameBytesDigest,
        runtimeBytesDigest: nativeRuntime.runtimeBytesDigest,
      },
    } : options;
    rollout = await outcomeGenerator(decision, shadow.replay.candidates, rolloutOptions);
  } catch (error) {
    return { ...base, reason: 'rollout-runtime-failed', detail: String(error?.message || error) };
  }
  if (!rollout.ok || rollout.coverage?.complete !== true) {
    return { ...base, reason: rollout.reason || 'rollout-coverage-incomplete',
      ...(rollout.cacheObservation ? { rollout: { coverage: rollout.coverage || { complete: false },
        cacheObservation: rollout.cacheObservation,
        ...(rollout.terminalJournalObservation ? { terminalJournalObservation: rollout.terminalJournalObservation } : {}) } } : {}) };
  }
  const outcomeContractFailure = validatePairedOutcomeEvidence(
    rollout, decision, shadow.replay.candidates,
  );
  if (outcomeContractFailure) return { ...base, reason: outcomeContractFailure };
  const selectedOutcome = rollout.candidates.find(candidate => (
    afterPositionKey(candidate) === execution.selectedPositionKey
  ));
  const recommendedOutcome = rollout.candidates.find(candidate => (
    afterPositionKey(candidate) === rollout.recommendationPositionKey
  ));
  if (
    rollout.recommendationPositionKey === execution.selectedPositionKey
    || rollout.regretLcb <= Math.max(0.08, Number(rollout.limits?.minRegretLcb) || 0.08)
  ) {
    return {
      ...base,
      status: 'no-regret',
      reason: '',
      rollout: {
        coverage: rollout.coverage,
        regret: rollout.regret,
        regretLcb: rollout.regretLcb,
        ...(rollout.cacheObservation ? { cacheObservation: rollout.cacheObservation } : {}),
        ...(rollout.terminalJournalObservation ? { terminalJournalObservation: rollout.terminalJournalObservation } : {}),
      },
    };
  }

  const legalRecommendation = shadow.replay.candidates.find(candidate => (
    afterPositionKey(candidate) === rollout.recommendationPositionKey
  ));
  if (!legalRecommendation) return { ...base, reason: 'rollout-recommendation-not-legal' };

  const reviewer = await loadReviewer();
  const categories = reviewer.structuralDominanceTags(selected, legalRecommendation);
  if (!categories.length) {
    return {
      ...base,
      status: 'diagnostic-disagreement',
      reason: 'structural-dominance-not-established',
      rollout: { coverage: rollout.coverage, regret: rollout.regret, regretLcb: rollout.regretLcb,
        ...(rollout.cacheObservation ? { cacheObservation: rollout.cacheObservation } : {}),
        ...(rollout.terminalJournalObservation ? { terminalJournalObservation: rollout.terminalJournalObservation } : {}) },
    };
  }

  const regeneratedContext = String(selected?.experience?.contextKey || '');
  const regeneratedAction = String(selected?.experience?.actionKey || '');
  if (!regeneratedContext || !regeneratedAction) {
    return { ...base, reason: 'server-experience-identity-missing' };
  }
  const identities = collisionResistantIdentities(
    decision,
    selected,
    legalRecommendation,
  );
  const digest = verifiedRuntimeDigest(options);
  const evidenceCore = {
    schema: EVIDENCE_SCHEMA,
    trustDomain: TRUST_DOMAIN,
    reviewerVersion: WORKER_RELEASE,
    engineVersion: ENGINE_VERSION,
    policyImplementationId: policyImplementationId(options),
    policyRole: POLICY_ROLE,
    historicalImplementationAttested: false,
    runtimeDigest: digest,
    trainingGameId: String(game?.id || game?.training_game_id || ''),
    roomCode: String(game?.room_code || game?.roomCode || ''),
    decisionId: String(decision.id || ''),
    positionId: String(decision.positionId || ''),
    stateId: identities.stateId,
    selectedActionId: identities.selectedActionId,
    recommendedActionId: identities.recommendedActionId,
    contextKey: regeneratedContext,
    selectedActionKey: regeneratedAction,
    selectedPositionKey: execution.selectedPositionKey,
    recommendedPositionKey: rollout.recommendationPositionKey,
    selectedMoveKey: execution.selectedMoveKey,
    recommendedMoveKey: exactMoves(legalRecommendation.moves),
    categories,
    exactExecution: true,
    completeLegalCoverage: true,
    pairedRolloutComplete: true,
    confidenceBoundsComplete: true,
    recursiveExperience: false,
    legalSequenceCount: Number(shadow.replay.coverage.legalSequenceCount) || 0,
    uniquePositionCount: Number(shadow.replay.coverage.expectedCandidates) || 0,
    scoreSemantics: rollout.scoreSemantics,
    confidenceMethod: rollout.coverage.confidenceMethod,
    rolloutSampleCount: rollout.coverage.samplesPerCandidate,
    rolloutCandidateCount: rollout.coverage.candidateCount,
    rolloutTerminalOutcomes: rollout.coverage.terminalOutcomes,
    selectedWinProbability: selectedOutcome.policyScore,
    selectedWinProbabilityUcb: selectedOutcome.policyScoreUcb,
    recommendedWinProbability: recommendedOutcome.policyScore,
    recommendedWinProbabilityLcb: recommendedOutcome.policyScoreLcb,
    regret: rollout.regret,
    regretLcb: rollout.regretLcb,
    rolloutSeedFingerprint: rollout.seedFingerprint,
    rolloutPolicyFingerprint: rollout.policyFingerprint,
    rolloutLimits: rollout.limits,
    rolloutCandidates: rollout.candidates.map(candidate => ({
      positionKey: afterPositionKey(candidate),
      moveKey: exactMoves(candidate.moves),
      wins: candidate.rolloutWins,
      samples: candidate.rolloutSamples,
      probability: candidate.policyScore,
      lower: candidate.policyScoreLcb,
      upper: candidate.policyScoreUcb,
      outcomeFingerprint: candidate.outcomeFingerprint,
    })),
    outcomeUsed: false,
  };
  const evidenceId = sha256([
    TRUST_DOMAIN,
    'evidence',
    digest,
    evidenceCore.trainingGameId,
    evidenceCore.decisionId,
    identities.stateId,
    identities.selectedActionId,
    identities.recommendedActionId,
  ].join('\x1f'));
  return {
    ...base,
    status: 'confirmed-regret',
    reason: '',
    rollout: { coverage: rollout.coverage, regret: rollout.regret, regretLcb: rollout.regretLcb,
      ...(rollout.cacheObservation ? { cacheObservation: rollout.cacheObservation } : {}),
      ...(rollout.terminalJournalObservation ? { terminalJournalObservation: rollout.terminalJournalObservation } : {}) },
    evidence: { ...evidenceCore, evidenceId },
  };
}

function trustedReviewSelection(game, options = {}) {
  const decisions = trainingDecisions(game);
  const available = decisions.map((decision, index) => botDecision(decision, game) ? index : null)
    .filter(index => index !== null);
  const requested = options.reviewDecisionIndexes;
  if (requested === undefined) return { indexes: available, available, reason: '' };
  if (options.trustedTrainingPolicy === undefined && !VERIFIED_SCOPES.has(options[PRODUCTION_SCOPE])) {
    return { indexes: [], available, reason: 'offline-review-scope-requires-trusted-policy' };
  }
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 8
    || new Set(requested).size !== requested.length
    || requested.some(index => !Number.isSafeInteger(index) || !available.includes(index))) {
    return { indexes: [], available, reason: 'trusted-review-decision-indexes-invalid' };
  }
  return { indexes: [...requested], available, reason: '' };
}

function uniqueCausalEvidence(evidence) {
  const unique = new Map();
  for (const item of evidence || []) {
    // Match the server ledger's exact-position/action uniqueness, not decision
    // IDs or repeated exports. selectedActionId itself preserves move order.
    const key = [item.runtimeDigest, item.stateId, item.selectedActionId].join('\x1f');
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

async function analyzeTrainingGame(game, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  // Validate the ORIGINAL complete ledger before selecting work. This does
  // not claim that unselected decision snapshots/execution were replayed.
  const envelopeRejection = validateGameEnvelope(game, limits);
  const selection = envelopeRejection ? null : trustedReviewSelection(game, options);
  const rejection = envelopeRejection || selection.reason || offlineTerminalJournalFailure(options);
  const digest = verifiedRuntimeDigest(options);
  const result = {
    schema: RESULT_SCHEMA,
    trustDomain: TRUST_DOMAIN,
    reviewerVersion: WORKER_RELEASE,
    engineVersion: ENGINE_VERSION,
    policyImplementationId: policyImplementationId(options),
    runtimeDigest: digest,
    gameId: String(game?.id || game?.training_game_id || ''),
    roomCode: String(game?.room_code || game?.roomCode || ''),
    accepted: !rejection,
    reason: rejection,
    selection: {
      lossesOnly: true,
      outcomeRole: 'cohort-filter-only',
      outcomeUsedAsDecisionLabel: false,
      policyRole: POLICY_ROLE,
      historicalImplementationAttested: false,
    },
    outcomeUsed: false,
    reviewCoverage: {
      schema: 'long-server-game-review-coverage-v1',
      fullGameEnvelopeValidated: !envelopeRejection,
      decisionSnapshotsVerified: 'reviewed-only',
      scope: options.reviewDecisionIndexes === undefined ? 'all-bot-decisions'
        : VERIFIED_SCOPES.has(options[PRODUCTION_SCOPE]) ? 'server-resumable-index' : 'trusted-offline-indexes',
      totalLedgerDecisions: trainingDecisions(game).length,
      totalBotDecisions: selection?.available.length || 0,
      requestedDecisionIndexes: selection?.indexes || [],
      attemptedDecisionIndexes: [],
      finishedDecisionIndexes: [],
      completedOutcomeCohorts: 0,
      selectionCoversWholeLedger: Boolean(selection) && !selection.reason
        && selection.indexes.length === selection.available.length,
      everyRequestedReviewFinished: false,
    },
    summary: {
      decisionsSeen: 0,
      botDecisionsSeen: 0,
      confirmedRegret: 0,
      noRegret: 0,
      diagnosticDisagreement: 0,
      rejected: 0,
      evidenceCount: 0,
    },
    reviews: [],
    evidence: [],
  };
  if (rejection) return result;

  result.summary.decisionsSeen = trainingDecisions(game).length;
  for (const index of selection.indexes) {
    const decision = trainingDecisions(game)[index];
    result.reviewCoverage.attemptedDecisionIndexes.push(index);
    result.summary.botDecisionsSeen += 1;
    const reviewOptions = { ...options, runtimeDigest: digest };
    const review = VERIFIED_SCOPES.has(options[PRODUCTION_SCOPE])
      ? await reviewStrategicallyBoundedProductionDecision(game, index, reviewOptions)
      : await reviewTrustedDecision(game, decision, reviewOptions);
    result.reviewCoverage.finishedDecisionIndexes.push(index);
    if (review.rollout?.coverage?.complete === true) result.reviewCoverage.completedOutcomeCohorts += 1;
    result.reviews.push(review);
    if (review.status === 'confirmed-regret') {
      result.summary.confirmedRegret += 1;
      result.evidence.push(review.evidence);
    } else if (review.status === 'no-regret') result.summary.noRegret += 1;
    else if (review.status === 'diagnostic-disagreement') {
      result.summary.diagnosticDisagreement += 1;
    } else result.summary.rejected += 1;
  }
  result.reviewCoverage.everyRequestedReviewFinished = true;
  result.evidence = uniqueCausalEvidence(result.evidence);
  result.summary.evidenceCount = result.evidence.length;
  return result;
}

function normalizeSupabaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function rpcPreconnectCode(error) {
  if (error?.message !== 'fetch failed') return null;
  const causes = Array.isArray(error.cause?.errors) ? error.cause.errors : [error.cause];
  if (!causes.length || causes.some(cause => !RPC_PRECONNECT_CODES.has(cause?.code))) return null;
  return causes.map(cause => cause.code).join('+');
}

function rpcTransportError(name, error, phase, attempts) {
  const causes = Array.isArray(error?.cause?.errors) ? error.cause.errors : [error?.cause];
  const codes = causes.map(cause => cause?.code);
  const code = codes.length > 1 && new Set(codes).size > 1 ? 'mixed'
    : RPC_TRANSPORT_DIAGNOSTIC_CODES.has(codes[0]) ? codes[0] : 'unknown';
  const kind = ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'transport';
  const failure = new Error(`${name} ${kind} failed (${code}; ${phase}; attempts=${attempts})`);
  failure.name = 'CausalRpcTransportError';
  // A response can disappear after commit. Never turn this into a job failure
  // or retry an ambiguous mutation; the lease and checkpoint remain authoritative.
  failure.rpcOutcomeUnknown = true;
  return failure;
}

async function supabaseRpc(url, serviceRoleKey, name, args = {}, beforeAttempt = () => {}) {
  const endpoint = `${normalizeSupabaseUrl(url)}/rest/v1/rpc/${name}`;
  const body = JSON.stringify(args);
  for (let attempt = 0; ; attempt += 1) {
    beforeAttempt();
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch (error) {
      if (rpcPreconnectCode(error) && attempt < RPC_PRECONNECT_RETRY_DELAYS_MS.length) {
        await new Promise(resolve => setTimeout(resolve, RPC_PRECONNECT_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      if (error?.message === 'fetch failed' || ['AbortError', 'TimeoutError'].includes(error?.name)) {
        throw rpcTransportError(name, error, 'request', attempt + 1);
      }
      throw error;
    }
    let responseText;
    try { responseText = await response.text(); }
    catch (error) { throw rpcTransportError(name, error, 'response', attempt + 1); }
    if (!response.ok) throw new Error(`${name} failed (${response.status}): ${responseText.slice(0, 500)}`);
    if (!responseText) return null;
    try { return JSON.parse(responseText); }
    catch {
      const failure = new Error(`${name} returned malformed JSON`);
      failure.rpcOutcomeUnknown = true;
      throw failure;
    }
  }
}

function productionDecisionIndexes(game) {
  return trainingDecisions(game).flatMap((decision, index) => botDecision(decision, game) ? [index] : []);
}

function productionReviewSelectionTelemetry(plan, decisionIndex) {
  const riskRank = plan.risks.findIndex(item => item.index === decisionIndex);
  const risk = riskRank < 0 ? { tier: 0, signals: [] } : plan.risks[riskRank];
  return {
    schema: plan.schema,
    strategy: plan.strategy,
    ordering: plan.ordering,
    riskRole: plan.riskRole,
    outcomeUsed: false,
    maximumExpensiveReviews: plan.maximumExpensiveReviews,
    selectedForExpensiveReview: plan.expensiveDecisionIndexes.includes(decisionIndex),
    priorityRank: riskRank < 0 ? null : riskRank + 1,
    tier: risk.tier,
    signals: [...risk.signals],
  };
}

async function reviewStrategicallyBoundedProductionDecision(
  game,
  decisionIndex,
  options = {},
  expensiveReviewer = reviewTrustedDecision,
) {
  const decisions = trainingDecisions(game);
  const indexes = productionDecisionIndexes(game);
  if (!Number.isSafeInteger(decisionIndex) || !indexes.includes(decisionIndex)) {
    throw new Error('Bounded production review requires an original bot decision index');
  }
  if (typeof expensiveReviewer !== 'function') throw new Error('Bounded production expensive reviewer is invalid');
  const plan = productionStrategicReviewPlan(game);
  const reviewSelection = productionReviewSelectionTelemetry(plan, decisionIndex);
  const decisionEnvelopeFailures = indexes.map(index => ({
    index,
    reason: trustedDecisionEnvelopeFailure(game, decisions[index], options),
  })).filter(item => item.reason);
  const decisionEnvelopeValidation = {
    schema: 'long-server-causal-decision-envelope-validation-v1',
    complete: true,
    valid: decisionEnvelopeFailures.length === 0,
    totalBotDecisions: indexes.length,
    ...(decisionEnvelopeFailures.length ? {
      firstInvalidDecisionIndex: decisionEnvelopeFailures[0].index,
      firstInvalidReason: decisionEnvelopeFailures[0].reason,
      invalidDecisionCount: decisionEnvelopeFailures.length,
    } : {}),
  };
  const base = {
    decisionId: String(decisions[decisionIndex]?.id || ''),
    positionId: String(decisions[decisionIndex]?.positionId || ''),
    status: 'rejected',
    evidence: null,
    outcomeUsed: false,
    reviewSelection,
    decisionEnvelopeValidation,
  };
  // The complete original ledger and every decision envelope are inspected.
  // A bad historical row cannot establish evidence for itself or prevent an
  // independently valid row from reaching exact replay and terminal proof.
  const targetFailure = decisionEnvelopeFailures.find(item => item.index === decisionIndex);
  if (targetFailure) {
    return { ...base, reason: 'production-decision-envelope-invalid',
      targetInvalidReason: targetFailure.reason };
  }
  if (!reviewSelection.selectedForExpensiveReview) {
    return { ...base, reason: 'production-strategic-risk-budget-skip' };
  }
  const review = await expensiveReviewer(game, decisions[decisionIndex], options);
  return { ...review, reviewSelection, decisionEnvelopeValidation };
}

function validProductionRolloutCheckpoint(value) {
  if (value === null) return true;
  const keys = ['manifestId', 'sampleIndex', 'candidateIndex', 'candidateId', 'plies', 'checkpointHash', 'stateHash'];
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson(keys.sort())
    && /^[0-9a-f]{64}$/.test(String(value.manifestId || ''))
    && /^[0-9a-f]{64}$/.test(String(value.candidateId || ''))
    && /^[0-9a-f]{64}$/.test(String(value.checkpointHash || ''))
    && /^[0-9a-f]{64}$/.test(String(value.stateHash || ''))
    && Number.isSafeInteger(value.sampleIndex) && value.sampleIndex >= 0 && value.sampleIndex < 128
    && Number.isSafeInteger(value.candidateIndex) && value.candidateIndex >= 0 && value.candidateIndex < 24
    && Number.isSafeInteger(value.plies) && value.plies >= 1 && value.plies < 600);
}

function normalizeProductionProgress(game, progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress) || types.isProxy(progress)) {
    throw new Error('Malformed server causal progress');
  }
  const legacyKeys = ['schema', 'finishedReviews', 'currentDecisionIndex', 'currentTerminalOutcomes', 'slices', 'stalledSlices'];
  const currentKeys = [...legacyKeys, 'currentRolloutCheckpoint'];
  if (progress.schema === LEGACY_PROGRESS_SCHEMA
    && canonicalJson(Object.keys(progress).sort()) === canonicalJson(legacyKeys.sort())) {
    // v1 could persist only complete terminal endpoints. Any computation after
    // the last endpoint was uncommitted, so this is the sole safe migration
    // boundary: resume from that endpoint with no invented mid-game state.
    return { ...structuredClone(progress), schema: PROGRESS_SCHEMA, currentRolloutCheckpoint: null };
  }
  if (progress.schema !== PROGRESS_SCHEMA
    || canonicalJson(Object.keys(progress).sort()) !== canonicalJson(currentKeys.sort())) {
    throw new Error('Malformed server causal progress');
  }
  return structuredClone(progress);
}

function validateProductionProgress(game, progress) {
  const normalized = normalizeProductionProgress(game, progress);
  const indexes = productionDecisionIndexes(game);
  if (!Array.isArray(normalized.finishedReviews)
    || normalized.finishedReviews.length > indexes.length
    || !Number.isSafeInteger(normalized.currentTerminalOutcomes) || normalized.currentTerminalOutcomes < 0
    || normalized.currentTerminalOutcomes > 3072
    || !Number.isSafeInteger(normalized.slices) || normalized.slices < 0 || normalized.slices > 10240
    || !Number.isSafeInteger(normalized.stalledSlices) || normalized.stalledSlices < 0 || normalized.stalledSlices > 10
    || !validProductionRolloutCheckpoint(normalized.currentRolloutCheckpoint)) {
    throw new Error('Malformed server causal progress');
  }
  for (const [offset, item] of normalized.finishedReviews.entries()) {
    const review = item?.review;
    if (!item || canonicalJson(Object.keys(item).sort()) !== canonicalJson(['decisionIndex', 'review'])
      || item.decisionIndex !== indexes[offset] || !review || typeof review !== 'object'
      || review.decisionId !== String(trainingDecisions(game)[indexes[offset]].id || '')
      || !['confirmed-regret', 'no-regret', 'diagnostic-disagreement', 'rejected'].includes(review.status)
      || ['rollout-time-limit', 'rollout-runtime-failed'].includes(review.reason)
      || review.outcomeUsed !== false
      || (review.status === 'confirmed-regret') !== Boolean(review.evidence)
      || (review.evidence && review.rollout?.coverage?.complete !== true)) {
      throw new Error('Server causal progress is not an exact finished original-ledger prefix');
    }
  }
  const next = indexes[normalized.finishedReviews.length] ?? null;
  if (normalized.currentDecisionIndex !== next
    && !(normalized.slices === 0 && normalized.finishedReviews.length === 0
      && normalized.currentDecisionIndex === null && normalized.currentTerminalOutcomes === 0
      && normalized.currentRolloutCheckpoint === null)) {
    throw new Error('Server causal progress cursor mismatch');
  }
  if (next === null && (normalized.currentTerminalOutcomes !== 0
    || normalized.currentRolloutCheckpoint !== null)) throw new Error('Completed progress retained partial outcomes');
  return { indexes, next };
}

function rolloutCheckpointAdvanced(previous, next) {
  if (previous === null) return next !== null;
  if (next === null) return false;
  for (const key of ['manifestId', 'sampleIndex', 'candidateIndex', 'candidateId']) {
    if (previous[key] !== next[key]) throw new Error('Current terminal rollout checkpoint identity changed without a completed endpoint');
  }
  if (next.plies < previous.plies) throw new Error('Current terminal rollout checkpoint regressed');
  if (next.plies === previous.plies && (next.checkpointHash !== previous.checkpointHash
    || next.stateHash !== previous.stateHash)) throw new Error('Current terminal rollout checkpoint conflicted at the same ply');
  return next.plies > previous.plies;
}

function advanceProductionProgress(game, previous, decisionIndex, review) {
  const normalizedPrevious = normalizeProductionProgress(game, previous);
  const { indexes, next } = validateProductionProgress(game, normalizedPrevious);
  if (next === null || decisionIndex !== next || review?.decisionId !== String(trainingDecisions(game)[next].id || '')) {
    throw new Error('Production slice is not the next original decision');
  }
  if (review.reason === 'rollout-runtime-failed') throw new Error(`Native rollout failed: ${review.detail || review.reason}`);
  const partial = review.reason === 'rollout-time-limit';
  const count = partial ? review.rollout?.terminalJournalObservation?.completedTerminalOutcomes : 0;
  const checkpoint = partial ? review.rollout?.terminalJournalObservation?.activeCheckpoint : null;
  if (partial && (review.status !== 'rejected' || review.evidence
    || review.rollout?.coverage?.complete !== false || !Number.isSafeInteger(count)
    || count < normalizedPrevious.currentTerminalOutcomes || count > 3072
    || !validProductionRolloutCheckpoint(checkpoint))) {
    throw new Error('Partial production slice lacks authenticated monotonic terminal progress');
  }
  let checkpointProgress = false;
  if (partial && count === normalizedPrevious.currentTerminalOutcomes) {
    checkpointProgress = rolloutCheckpointAdvanced(normalizedPrevious.currentRolloutCheckpoint, checkpoint);
    if (normalizedPrevious.currentRolloutCheckpoint !== null && checkpoint === null) {
      throw new Error('Current terminal rollout checkpoint disappeared without a completed endpoint');
    }
  }
  const finishedReviews = normalizedPrevious.finishedReviews.map(item => structuredClone(item));
  if (!partial) finishedReviews.push({ decisionIndex, review: structuredClone(review) });
  const progress = {
    schema: PROGRESS_SCHEMA, finishedReviews,
    currentDecisionIndex: indexes[finishedReviews.length] ?? null,
    currentTerminalOutcomes: count,
    currentRolloutCheckpoint: partial ? structuredClone(checkpoint) : null,
    slices: normalizedPrevious.slices + 1,
    stalledSlices: partial && count === normalizedPrevious.currentTerminalOutcomes && !checkpointProgress
      ? normalizedPrevious.stalledSlices + 1 : 0,
  };
  validateProductionProgress(game, progress);
  return progress;
}

function aggregateProductionResult(game, sliceResult, progress) {
  const { indexes, next } = validateProductionProgress(game, progress);
  if (next !== null) return sliceResult;
  const reviews = progress.finishedReviews.map(item => structuredClone(item.review));
  const evidence = uniqueCausalEvidence(reviews.flatMap(review => review.evidence ? [review.evidence] : []));
  return {
    ...sliceResult, reviews, evidence,
    reviewCoverage: {
      ...sliceResult.reviewCoverage, scope: 'all-bot-decisions', requestedDecisionIndexes: indexes,
      attemptedDecisionIndexes: indexes, finishedDecisionIndexes: indexes,
      completedOutcomeCohorts: reviews.filter(review => review.rollout?.coverage?.complete === true).length,
      selectionCoversWholeLedger: true, everyRequestedReviewFinished: true,
    },
    summary: {
      decisionsSeen: trainingDecisions(game).length, botDecisionsSeen: reviews.length,
      confirmedRegret: reviews.filter(review => review.status === 'confirmed-regret').length,
      noRegret: reviews.filter(review => review.status === 'no-regret').length,
      diagnosticDisagreement: reviews.filter(review => review.status === 'diagnostic-disagreement').length,
      rejected: reviews.filter(review => review.status === 'rejected').length, evidenceCount: evidence.length,
    },
  };
}

function mayContinueProductionCheapBurst(review, receipt) {
  return receipt?.status === 'pending'
    && review?.status === 'rejected'
    && review.evidence === null
    && ['production-strategic-risk-budget-skip', 'production-decision-envelope-invalid']
      .includes(review.reason);
}

async function runProductionCheapBurst(step) {
  const completed = [];
  const startedAt = Date.now();
  let claimed = 0;
  let firstJobId = null;
  for (let index = 0; index < PRODUCTION_CHEAP_BURST_LIMIT; index += 1) {
    const slice = await step();
    if (index === 0) claimed = slice.claimed;
    if (!slice.claimed) break;
    completed.push(slice.completed);
    if (firstJobId === null) firstJobId = slice.jobId;
    if (slice.jobId !== firstJobId
      || !mayContinueProductionCheapBurst(slice.review, slice.receipt)
      || Date.now() - startedAt >= PRODUCTION_CHEAP_BURST_MS) break;
  }
  return { claimed, completed };
}

function validateClaimedJobs(claimed, digest, implementationId) {
  if (!Array.isArray(claimed) || claimed.length > 1) throw new Error('Malformed causal review claim envelope');
  return claimed.map(job => {
    if (!job || !Number.isSafeInteger(job.jobId) || job.jobId < 1
      || job.runtimeDigest !== digest || job.policyImplementationId !== implementationId
      || typeof job.archiveFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(job.archiveFingerprint)
      || typeof job.archiveFingerprintSource !== 'string'
      || sha256(job.archiveFingerprintSource) !== job.archiveFingerprint) {
      throw new Error('Claimed causal review release or archive identity mismatch');
    }
    let game;
    try { game = JSON.parse(job.archiveFingerprintSource); }
    catch { throw new Error('Malformed causal review archive fingerprint source'); }
    const payloadKeys = ['id', 'room_code', 'engine_version', 'difficulty', 'bot_color', 'winner', 'decisions', 'final_state'].sort();
    if (!game || typeof game !== 'object' || Array.isArray(game)
      || canonicalJson(Object.keys(game).sort()) !== canonicalJson(payloadKeys)
      || !job.trainingGame || typeof job.trainingGame !== 'object' || Array.isArray(job.trainingGame)
      || canonicalJson(Object.keys(job.trainingGame).sort()) !== canonicalJson(payloadKeys)
      || canonicalJson(game) !== canonicalJson(job.trainingGame)) {
      throw new Error('Claimed causal review archive payload mismatch');
    }
    return { ...job, game };
  });
}

function assertImmutableProductionFiles() {
  for (const [, file] of runtimeClosureFiles()) {
    const physical = path.resolve(file);
    if (fs.realpathSync(physical) !== physical) throw new Error('Production executable is a symbolic path');
    const stat = fs.lstatSync(physical);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.nlink !== 1) {
      throw new Error('Production executable must be a root-owned immutable regular file');
    }
    let directory = path.dirname(physical);
    while (directory !== path.parse(directory).root) {
      const parent = fs.lstatSync(directory);
      if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) {
        throw new Error('Production executable ancestor is not immutable');
      }
      directory = path.dirname(directory);
    }
  }
}

async function runResumableClaimedBatch(options) {
  if (options.trustedOfflineTerminalJournal !== undefined || options.terminalJournalBindings !== undefined
    || options.reviewDecisionIndexes !== undefined || options.trustedTrainingPolicy !== undefined
    || options.runtime || options.outcomeRunner || options.pairedOutcomeGenerator || options.shadowReplayGenerator
    || options.archivedSelectionReplay || options.gamePath || options.runtimePath
    || options.rolloutLimits || options.shadowLimits || options.limits) {
    throw new Error('Production resumable slices require the unmodified native server policy and verified claim');
  }
  const { assertProductionFence } = require('./long-bot-production-fence');
  const fence = assertProductionFence({ journalDirectory: options.productionJournalDirectory, applicationDirectory: ROOT });
  assertImmutableProductionFiles();
  const digest = verifiedRuntimeDigest(options);
  const implementationId = policyImplementationId(options);
  const url = options.supabaseUrl || process.env.SUPABASE_URL;
  const serviceRoleKey = options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const workerId = options.workerId || `long-causal-${crypto.randomUUID()}`;
  const fencedRpc = (name, args) => {
    fence.assertHeld();
    return supabaseRpc(url, serviceRoleKey, name, args, () => fence.assertHeld());
  };
  // The SQL cursor accepts precisely one original index per checkpoint.
  // Reclaiming its immediately pending job lets one service invocation cross
  // many cheap, evidence-free rows without changing that durable contract.
  // An expensive review, a partial rollout, or another claimed job ends the
  // burst; the wall clock and count also bound a game with only cheap rows.
  const burst = await runProductionCheapBurst(async () => {
    const jobs = validateClaimedJobs(await fencedRpc('claim_long_bot_causal_review_slices', {
      p_worker_id: workerId, p_runtime_digest: digest,
    }), digest, implementationId);
    if (!jobs.length) return { claimed: 0 };
    // Malformed identities/progress are not caught as job failures: they must
    // never consume someone else's release or source revision.
    for (const job of jobs) {
      validateProductionProgress(job.game, job.progress);
      job.progress = normalizeProductionProgress(job.game, job.progress);
    }
    const job = jobs[0];
    try {
      fence.assertHeld();
      const rejection = validateGameEnvelope(job.game);
      if (rejection) {
        const result = { ...await analyzeTrainingGame(job.game, { runtimeDigest: digest }), archiveFingerprint: job.archiveFingerprint };
        const receipt = await fencedRpc('complete_long_bot_causal_review_job', {
          p_job_id: job.jobId, p_worker_id: workerId, p_result: result,
        });
        return { claimed: 1, jobId: job.jobId, completed: { result, receipt }, review: null, receipt };
      }
      const { next } = validateProductionProgress(job.game, job.progress);
      if (next === null) throw new Error('Already finished progress was incorrectly leased');
      // Partition durable cohorts by immutable server job/revision/release.
      // Completed historical games cannot exhaust a global recovery scan.
      const jobBindingId = sha256(canonicalJson({ jobId: job.jobId, archiveFingerprint: job.archiveFingerprint,
        archivePayloadText: job.archiveFingerprintSource, runtimeDigest: digest, policyImplementationId: implementationId }));
      const jobJournalDirectory = fence.prepareJobJournal({ jobBindingId });
      fence.recoverStaleWriterLocks({ jobBindingId });
      const scope = Object.freeze({ jobId: job.jobId, archiveFingerprint: job.archiveFingerprint,
        archiveFingerprintSource: job.archiveFingerprintSource });
      VERIFIED_SCOPES.add(scope);
      let slice;
      try {
        slice = await analyzeTrainingGame(job.game, {
          [PRODUCTION_SCOPE]: scope, runtimeDigest: digest, reviewDecisionIndexes: [next],
          trustedOfflineTerminalJournal: { directory: jobJournalDirectory },
        });
      } finally { VERIFIED_SCOPES.delete(scope); }
      if (!slice.accepted || slice.reviews.length !== 1) throw new Error('Verified production slice failed its original game envelope');
      const progress = advanceProductionProgress(job.game, job.progress, next, slice.reviews[0]);
      const result = { ...aggregateProductionResult(job.game, slice, progress), archiveFingerprint: job.archiveFingerprint };
      fence.assertHeld();
      const receipt = await fencedRpc('checkpoint_long_bot_causal_review_slice', {
        p_job_id: job.jobId, p_worker_id: workerId, p_result: result, p_progress: progress,
      });
      if (!receipt || receipt.ok !== true || !['pending', 'complete', 'failed'].includes(receipt.status)) {
        throw new Error('Malformed resumable checkpoint receipt');
      }
      // Do not log entire game, endpoints, evidence or secrets in journald.
      return { claimed: 1, jobId: job.jobId, review: slice.reviews[0], receipt,
        completed: { jobId: job.jobId, status: receipt.status, decisionIndex: next,
          finishedDecisions: progress.finishedReviews.length, totalBotDecisions: productionDecisionIndexes(job.game).length,
          completedTerminalOutcomes: progress.currentTerminalOutcomes, slices: progress.slices,
          evidenceCount: receipt.inserted || 0 } };
    } catch (error) {
      if (error?.rpcOutcomeUnknown === true) {
        // A checkpoint may have committed even if its response was lost. Leave
        // this lease to expire; its next claim reads the durable SQL progress.
        return { claimed: 1, jobId: job.jobId, review: null, receipt: null,
          completed: { jobId: job.jobId, accepted: false, reason: 'rpc-outcome-unknown',
            detail: String(error.message) } };
      }
      try {
        await fencedRpc('fail_long_bot_causal_review_job', {
          p_job_id: job.jobId, p_worker_id: workerId, p_error: String(error?.message || error).slice(0, 1000),
        });
      } catch { /* A lost kernel fence must never mutate even a failed job. */ }
      return { claimed: 1, jobId: job.jobId, review: null, receipt: null,
        completed: { jobId: job.jobId, accepted: false, reason: 'worker-error',
          detail: String(error?.message || error) } };
    }
  });
  return { workerId, claimed: burst.claimed, lifecycle: 'long-server-resumable-slices-v2', completed: burst.completed };
}

async function runClaimedBatch(options = {}) {
  if (options.productionJournalDirectory !== undefined) return runResumableClaimedBatch(options);
  if (options.trustedOfflineTerminalJournal !== undefined || options.terminalJournalBindings !== undefined) {
    throw new Error('Terminal journals are offline-only; production requires a separately versioned resumable job lifecycle');
  }
  if (options.reviewDecisionIndexes !== undefined) {
    throw new Error('Scoped decision reviews are offline-only; production jobs review the complete ledger');
  }
  if (options.trustedTrainingPolicy !== undefined) {
    throw new Error('Trusted training policies are offline-only; production jobs use the canonical server policy');
  }
  const url = options.supabaseUrl || process.env.SUPABASE_URL;
  const serviceRoleKey = options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  // Claims are release-specific. Verify the installed executable closure
  // before the server is allowed to lease or increment any queue job.
  const digest = verifiedRuntimeDigest(options);
  const implementationId = policyImplementationId(options);
  const workerId = options.workerId || `long-causal-${crypto.randomUUID()}`;
  const claimed = await supabaseRpc(url, serviceRoleKey, 'claim_long_bot_causal_review_jobs', {
    p_worker_id: workerId,
    p_limit: 1,
    p_runtime_digest: digest,
  });
  if (!Array.isArray(claimed) || claimed.length > 1) throw new Error('Malformed causal review claim envelope');
  // Validate outside the fail/complete catch: a stale or malformed claim must
  // never consume, fail or complete a job belonging to another release.
  const jobs = validateClaimedJobs(claimed, digest, implementationId);
  const completed = [];
  for (const job of jobs) {
    try {
      const result = { ...await analyzeTrainingGame(job.game, { ...options, runtimeDigest: digest }),
        archiveFingerprint: job.archiveFingerprint };
      if (result.reviews.some(review => review.reason === 'rollout-time-limit')) {
        throw new Error('Incomplete cohorts require the production resumable slice lifecycle');
      }
      await supabaseRpc(url, serviceRoleKey, 'complete_long_bot_causal_review_job', {
        p_job_id: job.jobId,
        p_worker_id: workerId,
        p_result: result,
      });
      completed.push(result);
    } catch (error) {
      if (error?.rpcOutcomeUnknown !== true) {
        await supabaseRpc(url, serviceRoleKey, 'fail_long_bot_causal_review_job', {
          p_job_id: job.jobId,
          p_worker_id: workerId,
          p_error: String(error?.message || error).slice(0, 1000),
        }).catch(() => {});
      }
      completed.push({
        schema: RESULT_SCHEMA,
        accepted: false,
        reason: error?.rpcOutcomeUnknown === true ? 'rpc-outcome-unknown' : 'worker-error',
        detail: String(error?.message || error),
      });
    }
  }
  return { workerId, claimed: jobs.length, completed };
}

function parseCli(argv) {
  const options = { input: '', output: '', once: false, limit: 1, pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--once') options.once = true;
    else if (token === '--pretty') options.pretty = true;
    else if (['--input', '--output', '--limit', '--supabase-url', '--terminal-journal-dir', '--decision-index', '--production-journal-dir'].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === '--input') options.input = value;
      else if (token === '--output') options.output = value;
      else if (token === '--supabase-url') options.supabaseUrl = value;
      else if (token === '--terminal-journal-dir') options.trustedOfflineTerminalJournal = { directory: path.resolve(value) };
      else if (token === '--production-journal-dir') {
        if (!path.isAbsolute(value) || path.resolve(value) !== value) throw new Error('--production-journal-dir must be a physical absolute path');
        options.productionJournalDirectory = value;
      }
      else if (token === '--decision-index') {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 319) {
          throw new Error('--decision-index must be an original ledger index in 0..319');
        }
        options.reviewDecisionIndexes = [Number(value)];
      }
      else {
        if (Number(value) !== 1) throw new Error('--limit must be 1; use isolated worker processes for parallelism');
        options.limit = 1;
      }
    } else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`unknown option: ${token}`);
  }
  if (options.trustedOfflineTerminalJournal || options.reviewDecisionIndexes) {
    if (!options.input || options.once || !options.trustedOfflineTerminalJournal || !options.reviewDecisionIndexes) {
      throw new Error('--terminal-journal-dir and --decision-index require offline --input and cannot claim production jobs');
    }
    options.trustedTrainingPolicy = PRODUCTION_POLICY;
  }
  if (options.productionJournalDirectory && (options.input || options.output || !options.once
    || options.trustedOfflineTerminalJournal || options.reviewDecisionIndexes)) {
    throw new Error('--production-journal-dir requires --once and cannot use offline input, scope or output');
  }
  return options;
}

function helpText() {
  return [
    'Usage:',
    '  node scripts/long-bot-causal-worker.js --once [--limit N]',
    '  flock --exclusive --nonblock --no-fork STATE_DIR/worker.flock node scripts/long-bot-causal-worker.js --once --production-journal-dir STATE_DIR/terminal-journal',
    '  node scripts/long-bot-causal-worker.js --input training-game.json [--output result.json]',
    '  node scripts/long-bot-causal-worker.js --input original-game.json --decision-index N --terminal-journal-dir PRIVATE_DIR [--output result.json]',
    '',
    'Production mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    'The service-role secret must never be exposed to the browser.',
    'Offline terminal journals preserve complete slots and authenticated in-game checkpoints; partial cohorts never create evidence.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  let output;
  if (options.input) {
    const document = JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8'));
    output = await analyzeTrainingGame(document, options);
  } else {
    output = await runClaimedBatch(options);
  }
  const json = JSON.stringify(output, null, options.pretty ? 2 : 0);
  if (options.output) fs.writeFileSync(path.resolve(options.output), `${json}\n`);
  else process.stdout.write(`${json}\n`);
  return 0;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`long-bot causal worker failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_LIMITS,
  EXECUTABLE_DEPENDENCIES,
  ENGINE_VERSION,
  EVIDENCE_SCHEMA,
  POLICY_ROLE,
  RESULT_SCHEMA,
  TRUST_DOMAIN,
  WORKER_RELEASE,
  PRODUCTION_POLICY,
  PRODUCTION_LIVE_DOUBLES_POLICY,
  PRODUCTION_LEGACY_LIVE_DOUBLES_POLICY,
  PRODUCTION_POLICY_ENVELOPE,
  PRODUCTION_EXPENSIVE_REVIEW_LIMIT,
  PRODUCTION_CHEAP_BURST_LIMIT,
  mayContinueProductionCheapBurst,
  runProductionCheapBurst,
  analyzeTrainingGame,
  archivedOutsideCount,
  archivedStrategicRisk,
  botDecision,
  collisionResistantIdentities,
  emptyFrozenExperience,
  exactExecution,
  exactMoves,
  gameLoss,
  parseCli,
  reviewTrustedDecision,
  regenerateArchivedSelection,
  runClaimedBatch,
  runtimeDigest,
  verifiedRuntimeDigest,
  runtimeDigestFromEntries,
  runtimeClosureEntries,
  runtimeClosureFiles,
  policyImplementationId,
  serverOwnedPolicy,
  serverOwnedPolicyEnvelope,
  serverOwnedDecisionPolicy,
  isProductionLiveDoublesDecision,
  archivedPolicyFailure,
  sha256,
  supabaseRpc,
  trainingDecisions,
  trustedReviewSelection,
  uniqueCausalEvidence,
  LEGACY_PROGRESS_SCHEMA,
  PROGRESS_SCHEMA,
  productionDecisionIndexes,
  productionStrategicReviewPlan,
  reviewStrategicallyBoundedProductionDecision,
  normalizeProductionProgress,
  validateProductionProgress,
  advanceProductionProgress,
  aggregateProductionResult,
  validateClaimedJobs,
  validateGameEnvelope,
};
