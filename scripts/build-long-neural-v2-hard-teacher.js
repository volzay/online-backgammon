#!/usr/bin/env node
'use strict';

// Diagnostic hard-bot boards are NOT authenticated matches, policy-regret
// evidence, or expert actions. Only independently replayed geometric soft
// preferences enter this offline corpus. Recorded outcomes never become labels.
const fs = require('node:fs');
const path = require('node:path');
const legacy = require('./train-long-bot-neural');
const teacher = require('./build-long-neural-v2-teacher');
const shadow = require('./generate-long-bot-shadow-replay');
const neural = require('../lib/long-bot-neural');
const planner = require('../lib/long-bot-neural-v2');
const SCHEMA = 'long-neural-v2-hard-teacher-corpus-v1';
const INPUT_SCHEMA = 'long-neural-v2-hard-archive-input-v1';
const SCOPE = 'training-only-untrusted-hard-archive-diagnostics';
const { TARGET_KIND, VERIFICATION } = teacher;
const OLD_RULES = 'sha256:769c571ad10cefa75a8c128aba5123df47684780fad1136a0ae98f3342f33e4b';
const NEW_RULES = 'sha256:6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623';
const SOURCE_TUPLES = Object.freeze([
  Object.freeze({ policyImplementationId: 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1',
    gameSourceFingerprint: OLD_RULES, runtimeBundleFingerprint: 'sha256:6b503dce9c72d2bdec9180dfe63aa2252b71e8c69095eea13bd1345732940255' }),
  Object.freeze({ policyImplementationId: '4aede916c0f3a219e84582d3a8277f50b1041d6b7ae541bff7b807c42c82f526',
    gameSourceFingerprint: NEW_RULES, runtimeBundleFingerprint: 'sha256:caef0f369bb9438ff3be7edd9c986dcf5ba5d967fe6233054d731673d5b43b0d' }),
]);
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DECISIONS = 4096;
const MAX_OUTCOMES = 100000;
const STRATEGY_PROFILES = Object.freeze(['v19', 'v20', 'v25']);
const clone = legacy.clone, fingerprint = legacy.fingerprint;
const equal = (a, b) => legacy.canonical(a) === legacy.canonical(b);
function check(ok, reason) { if (!ok) throw Error(`Hard teacher: ${reason}`); }
function keys(value, expected, reason) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)), reason);
}
function sourceIdentity(input) {
  if (input == null) return { source: null, verified: false };
  keys(input, ['policyImplementationId', 'gameSourceFingerprint', 'runtimeBundleFingerprint'], 'unsupported-source-identity');
  if (Object.values(input).every(value => value === null)) return { source: clone(input), verified: false };
  check(SOURCE_TUPLES.some(tuple => equal(tuple, input)), 'unsupported-source-identity');
  return { source: clone(input), verified: true };
}
function runtime(options = {}) {
  const rules = options.game ? { game: options.game, fingerprint: options.rulesFingerprint } : legacy.loadLongGame();
  check([OLD_RULES, NEW_RULES].includes(rules.fingerprint), 'unsupported-replay-rules');
  const artifact = options.modelArtifact || JSON.parse(fs.readFileSync(path.join(legacy.ROOT, 'vendor/long-neural/model.json'), 'utf8'));
  neural.validateModel(artifact.model);
  check(legacy.modelFingerprint(artifact.model) === teacher.WARMSTART_MODEL
    && artifact.metadata?.modelFingerprint === teacher.WARMSTART_MODEL, 'unpinned-analysis-model');
  return { ...rules, model: artifact.model,
    provenance: { rulesFingerprint: rules.fingerprint, modelFingerprint: teacher.WARMSTART_MODEL,
      modelSourceFingerprint: fingerprint(fs.readFileSync(path.join(legacy.ROOT, 'lib/long-bot-neural.js'))),
      plannerFingerprint: fingerprint(fs.readFileSync(path.join(legacy.ROOT, 'lib/long-bot-neural-v2.js'))),
      verification: VERIFICATION } };
}
function moves(input) {
  check(Array.isArray(input) && input.length <= 4, 'invalid-move-list');
  return input.map(move => {
    check(move && Number.isSafeInteger(move.from) && move.from >= 1 && move.from <= 24
      && Number.isSafeInteger(move.to) && move.to >= 0 && move.to <= 24
      && Number.isSafeInteger(move.die) && move.die >= 1 && move.die <= 6
      && (move.bearOff === undefined || move.bearOff === (move.to === 0)), 'invalid-movement');
    return { from: move.from, to: move.to, die: move.die, bearOff: move.to === 0 };
  });
}
function compact(state) { return { points: clone(state.points), bar: clone(state.bar), off: clone(state.off) }; }
function decodeDecision(game, decision, botColor) {
  check(decision?.source === 'engine' && decision.engineVersion === 'long-analytic-v35', 'unsupported-engine-origin');
  const snapshot = decision.stateSnapshotV2;
  keys(snapshot, ['schema', 'variant', 'phase', 'turn', 'points', 'bar', 'off', 'dice', 'rolled',
    'firstMoveDone', 'headPlayedThisTurn', 'turnMoves'], 'missing-or-malformed-state-snapshot-v2');
  check(snapshot.schema === 'long-state-v2' && snapshot.variant === 'long', 'unsupported-snapshot-schema');
  const digest = shadow.snapshotFingerprintV2(snapshot), replay = decision.replayInput;
  check(/^lbs2-[a-f0-9]{8}$/.test(decision.stateFingerprintV2 || '')
    && digest === decision.stateFingerprintV2 && replay?.stateFingerprintV2 === digest, 'snapshot-fingerprint-mismatch');
  check(replay?.schema === 'long-shadow-replay-input-v1' && replay.engineVersion === decision.engineVersion,
    'missing-or-mismatched-replay-input');
  // browser.ts experienceSnapshot uses exactly this FNV-derived marker. It is
  // only diagnostic identity, not authentication or permission to retain an
  // arbitrary opaque value (which could contain a name, token or seed).
  check(/^lbe8-[a-f0-9]{8}$/.test(decision.experienceFingerprint || '')
    && replay.experienceFingerprint === decision.experienceFingerprint
    && Number.isSafeInteger(decision.experienceSize) && decision.experienceSize >= 0
    && replay.experienceSize === decision.experienceSize
    && typeof decision.experienceFrozen === 'boolean' && replay.experienceFrozen === decision.experienceFrozen,
  'replay-experience-envelope-mismatch');
  check(replay.runtime && STRATEGY_PROFILES.includes(replay.runtime.strategyProfile)
    && Number.isSafeInteger(replay.runtime.maxCandidates) && replay.runtime.maxCandidates >= 1 && replay.runtime.maxCandidates <= 65536
    && Number.isSafeInteger(replay.runtime.analysisNodeBudget) && replay.runtime.analysisNodeBudget >= 1
    && replay.runtime.analysisNodeBudget <= 1000000, 'incomplete-runtime-envelope');
  const before = teacher.projectState({ ...snapshot, winner: null });
  check(before.phase === 'move' && before.turn === botColor && decision.color === botColor
    && equal(decision.dice, before.dice), 'actor-or-roll-mismatch');
  check(equal(decision.position, { points: before.points, off: before.off }), 'position-preview-mismatch');
  const execution = decision.execution;
  check(execution?.complete === true && execution.fallback === false && execution.substituted === false
    && (!execution.substitutions || execution.substitutions.length === 0), 'missing-or-incomplete-execution');
  const selected = moves(decision.selected?.moves), executed = moves(execution.executed?.moves);
  check(equal(selected, executed), 'selected-executed-movement-mismatch');
  if (execution.executedMoves !== undefined) check(equal(selected, moves(execution.executedMoves)), 'execution-preview-mismatch');
  for (const flag of ['selectedActionMatches', 'selectedPositionMatches', 'selectedMatchesExecuted']) {
    if (execution[flag] !== undefined) check(execution[flag] === true, 'execution-match-flag-false');
  }
  for (const field of ['appliedMoveCount', 'selectedMoveCount']) {
    if (execution[field] !== undefined) check(execution[field] === selected.length, 'execution-move-count-mismatch');
  }
  if (execution.executedActionKey !== undefined) check(typeof execution.executedActionKey === 'string'
    && execution.executedActionKey === decision.selected?.experience?.actionKey, 'execution-action-key-mismatch');
  const after = clone(before);
  for (let index = 0; index < selected.length; index++) {
    const move = selected[index];
    check(game.moveTo(before.turn, move.from, move.die, after) === move.to
      && game.applyMove(after, move.from, move.die, { autoEnd: false }), 'illegal-recorded-movement');
    if (after.winner) { check(index === selected.length - 1, 'execution-continues-after-win'); break; }
  }
  check(after.winner || !game.hasAnyMoves(after), 'incomplete-recorded-turn');
  check(equal(compact(after), decision.selected.after)
    && equal(compact(after), execution.executed.after), 'recorded-after-board-mismatch');
  if (execution.after !== undefined) check(equal(compact(after), execution.after), 'execution-after-preview-mismatch');
  const first = teacher.mechanicalMetrics(game, before, before.turn), last = teacher.mechanicalMetrics(game, after, before.turn);
  const factual = { offGain: last.off - first.off, homeGain: last.home - first.home,
    pipGain: first.pips - last.pips, headGain: first.head - last.head,
    outsideReduction: Math.max(0, first.outside - last.outside), startZoneBefore: first.koksExposure,
    startZoneAfter: last.koksExposure, startZoneReduction: Math.max(0, first.koksExposure - last.koksExposure),
    bearOffMoves: selected.filter(move => move.bearOff).length };
  check(decision.selected.features && Object.entries(factual).every(([key, value]) =>
    Object.hasOwn(decision.selected.features, key) && decision.selected.features[key] === value), 'archived-mechanical-feature-mismatch');
  if (!after.winner) game.endTurn(after);
  return { before, afterState: teacher.projectState(after), selected, factual };
}
function cleanDecision(decision, factual) {
  const replay = decision.replayInput;
  return { source: 'engine', engineVersion: decision.engineVersion, stateSnapshotV2: clone(decision.stateSnapshotV2),
    stateFingerprintV2: decision.stateFingerprintV2, experienceFingerprint: decision.experienceFingerprint,
    experienceSize: decision.experienceSize, experienceFrozen: decision.experienceFrozen,
    replayInput: { schema: replay.schema, stateFingerprintV2: replay.stateFingerprintV2, engineVersion: replay.engineVersion,
      experienceFingerprint: replay.experienceFingerprint, experienceSize: replay.experienceSize,
      experienceFrozen: replay.experienceFrozen, runtime: { strategyProfile: replay.runtime.strategyProfile,
        maxCandidates: replay.runtime.maxCandidates, analysisNodeBudget: replay.runtime.analysisNodeBudget } },
    color: decision.color, dice: clone(decision.dice), position: clone(decision.position),
    selected: { moves: moves(decision.selected.moves), after: clone(decision.selected.after), features: factual },
    execution: { complete: true, fallback: false, substituted: false,
      executed: { moves: moves(decision.execution.executed.moves), after: clone(decision.execution.executed.after) } } };
}
function sameExecutedOutcome(candidate, recorded) {
  if (equal(candidate, recorded)) return true;
  // Unique-position enumeration retains one representative ordering. Two
  // independently legal final bear-offs may commute at a terminal win while
  // leaving identical rule fields except the order of the movement ledger.
  // Ordered recorded execution has already been publicly replayed in full;
  // retain it literally and permit ONLY a permutation of the exact same
  // terminal moves, never different movements or nonterminal rule contexts.
  if (!candidate.winner || candidate.winner !== recorded.winner
    || candidate.phase !== 'over' || recorded.phase !== 'over') return false;
  const terminal = state => ({ ...state,
    turnMoves: state.turnMoves.map(move => legacy.canonical(move)).sort() });
  return equal(terminal(candidate), terminal(recorded));
}
function preservesMeaningfulBlockers(game, preferred, disfavored, color) {
  const enemy = game.opponentOf(color), route = Array.from(game.pathFor(enemy, 'long'));
  const enemyIndices = Object.entries(disfavored.points).filter(([, stack]) => stack.color === enemy)
    .map(([point]) => route.indexOf(Number(point)));
  if (!enemyIndices.length) return true;
  const earliestEnemy = Math.min(...enemyIndices);
  // Long-game single checkers already block a point. Conservatively reject
  // a soft teacher preference that withdraws any such existing barrier still
  // ahead of a surviving enemy checker, even when own progress improves.
  return Object.entries(disfavored.points).every(([point, stack]) => stack.color !== color
    || route.indexOf(Number(point)) <= earliestEnemy || preferred.points[point]?.color === color);
}
function makePosition(captured, record, budget = null) {
  budget?.check();
  const decoded = decodeDecision(captured.game, record.decision, record.color);
  budget?.check();
  const enumeration = planner.enumerateUniqueTurns(captured.game, decoded.before);
  budget?.check();
  check(enumeration.legalSequences <= 65536, 'legal-sequence-budget');
  if (budget) check(enumeration.rows.length <= budget.remainingOutcomes, 'global-outcome-budget-no-partial-corpus');
  const outcomes = enumeration.rows.map(row => {
    budget?.check();
    return { moves: row.moves.map(({ from, die }) => ({ from, die })),
      afterState: teacher.projectState(row.afterState), positionKey: row.positionKey,
      legacyValue: neural.predict(captured.model, row.afterState, decoded.before.turn),
      metrics: teacher.mechanicalMetrics(captured.game, row.afterState, decoded.before.turn) };
  });
  budget?.check();
  const executed = outcomes.find(row => sameExecutedOutcome(row.afterState, decoded.afterState));
  check(executed, 'recorded-turn-not-in-complete-legal-set');
  const byPosition = new Map(outcomes.map(row => [row.positionKey, row]));
  const preferences = teacher.preferences(outcomes, executed.positionKey).filter(preference => {
    const preferred = byPosition.get(preference.preferredPositionKey), disfavored = byPosition.get(preference.disfavoredPositionKey);
    return preferred && disfavored && preservesMeaningfulBlockers(captured.game,
      preferred.afterState, disfavored.afterState, decoded.before.turn);
  });
  return { positionId: fingerprint([record.roomCode, record.decisionIndex, decoded.before]),
    source: { roomCode: record.roomCode, decisionIndex: record.decisionIndex,
      sourceIdentityVerified: record.sourceIdentityVerified, observedSource: record.observedSource,
      sourceVerification: record.sourceIdentityVerified ? 'allowlisted-playing-origin-not-authenticated'
        : 'unverified-playing-origin-current-rules-local-replay' },
    color: decoded.before.turn, before: decoded.before,
    executed: { moves: decoded.selected.map(({ from, die }) => ({ from, die })),
      afterState: decoded.afterState, positionKey: executed.positionKey, archivedChoiceIsOptimalLabel: false },
    legalSequences: enumeration.legalSequences, outcomes,
    preferences };
}
function resourceLimits(options) {
  const maxElapsedMs = options.maxElapsedMs ?? 120000, maxOutcomes = options.maxOutcomes ?? MAX_OUTCOMES;
  check(Number.isSafeInteger(maxElapsedMs) && maxElapsedMs > 0 && maxElapsedMs <= 3600000, 'invalid-time-budget');
  check(Number.isSafeInteger(maxOutcomes) && maxOutcomes > 0 && maxOutcomes <= MAX_OUTCOMES, 'invalid-outcome-budget');
  return { maxElapsedMs, maxOutcomes };
}
function summary(corpus) {
  const accepted = corpus.records.filter(row => row.status === 'locally-replayed'), skipped = corpus.records.filter(row => row.status === 'skipped');
  const reasons = {};
  for (const record of skipped) reasons[record.reason] = (reasons[record.reason] || 0) + 1;
  return { games: corpus.games.length, inputDecisions: corpus.records.length, eligibleDecisions: accepted.length,
    skippedDecisions: skipped.length, skippedReasons: reasons,
    verifiedSourceDecisions: accepted.filter(row => row.sourceIdentityVerified).length,
    unverifiedSourceDecisions: accepted.filter(row => !row.sourceIdentityVerified).length,
    uniqueLegalOutcomes: corpus.positions.reduce((sum, row) => sum + row.outcomes.length, 0),
    heuristicPreferences: corpus.positions.reduce((sum, row) => sum + row.preferences.length, 0),
    causalLabels: 0, terminalTrainingTargets: 0, authenticatedMatches: 0, archivedChoiceOptimalTargets: 0 };
}
function buildTeacherCorpus(input, options = {}) {
  keys(input, ['schema', 'games'], 'unsupported-input-schema');
  check(input.schema === INPUT_SCHEMA && Array.isArray(input.games) && input.games.length > 0 && input.games.length <= 64,
    'unsupported-input-schema');
  check(Buffer.byteLength(JSON.stringify(input)) <= MAX_INPUT_BYTES, 'input-byte-budget');
  const { maxElapsedMs, maxOutcomes } = resourceLimits(options), start = Date.now(), captured = runtime(options);
  const checkBudget = () => check(Date.now() - start < maxElapsedMs, 'global-time-budget-no-partial-corpus');
  checkBudget();
  const corpus = { schema: SCHEMA, scope: SCOPE, productionEligible: false,
    provenance: { ...captured.provenance, sourceLedgerFingerprint: fingerprint(input) }, games: [], records: [], positions: [], summary: null };
  const seen = new Set(); let outcomes = 0;
  for (const archive of input.games) {
    keys(archive, ['roomCode', 'variant', 'botColor', 'source', 'decisions'], 'unexpected-game-fields');
    check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(archive.roomCode) && !seen.has(archive.roomCode)
      && Array.isArray(archive.decisions), 'invalid-or-duplicate-game'); seen.add(archive.roomCode);
    check(corpus.records.length + archive.decisions.length <= MAX_DECISIONS, 'decision-budget');
    const gameSummary = { roomCode: archive.roomCode, decisionCount: archive.decisions.length };
    corpus.games.push(gameSummary);
    for (let index = 0; index < archive.decisions.length; index++) {
      checkBudget();
      const decision = archive.decisions[index], record = { roomCode: archive.roomCode, decisionIndex: index + 1,
        diagnosticFingerprint: fingerprint(decision), status: 'skipped', reason: null };
      try {
        check(archive.variant === 'long' && ['white', 'dark'].includes(archive.botColor), 'unsupported-variant-or-seat');
        const identity = sourceIdentity(archive.source), decoded = decodeDecision(captured.game, decision, archive.botColor);
        Object.assign(record, { status: 'locally-replayed', color: archive.botColor,
          observedSource: identity.source, sourceIdentityVerified: identity.verified,
          decision: cleanDecision(decision, decoded.factual) });
        const position = makePosition(captured, record, { check: checkBudget, remainingOutcomes: maxOutcomes - outcomes });
        checkBudget();
        outcomes += position.outcomes.length; corpus.positions.push(position);
      } catch (error) {
        const reason = String(error.message).replace(/^Hard teacher: /, '');
        if (reason.startsWith('global-')) throw error;
        for (const key of ['color', 'observedSource', 'sourceIdentityVerified', 'decision']) delete record[key];
        record.status = 'skipped'; record.reason = reason.slice(0, 160);
      }
      corpus.records.push(record);
    }
  }
  checkBudget();
  corpus.summary = summary(corpus); corpus.contentFingerprint = fingerprint(corpus);
  check(Buffer.byteLength(JSON.stringify(corpus)) <= MAX_OUTPUT_BYTES, 'output-byte-budget');
  return corpus;
}
function validateTeacherCorpus(corpus, options = {}) {
  const { maxElapsedMs, maxOutcomes } = resourceLimits(options), start = Date.now();
  const checkBudget = () => check(Date.now() - start < maxElapsedMs, 'global-time-budget-no-partial-corpus');
  keys(corpus, ['schema', 'scope', 'productionEligible', 'provenance', 'games', 'records', 'positions', 'summary', 'contentFingerprint'], 'unexpected-corpus-fields');
  check(corpus.schema === SCHEMA && corpus.scope === SCOPE && corpus.productionEligible === false, 'unsupported-corpus-scope');
  const captured = runtime(options);
  checkBudget();
  keys(corpus.provenance, ['rulesFingerprint', 'modelFingerprint', 'modelSourceFingerprint', 'plannerFingerprint',
    'verification', 'sourceLedgerFingerprint'], 'unexpected-provenance-fields');
  const provenance = { ...corpus.provenance }; delete provenance.sourceLedgerFingerprint;
  check(equal(provenance, captured.provenance) && /^sha256:[a-f0-9]{64}$/.test(corpus.provenance.sourceLedgerFingerprint), 'replay-provenance-mismatch');
  const body = { ...corpus }; delete body.contentFingerprint;
  check(fingerprint(body) === corpus.contentFingerprint && Buffer.byteLength(JSON.stringify(corpus)) <= MAX_OUTPUT_BYTES,
    'corpus-content-fingerprint-mismatch');
  checkBudget();
  check(Array.isArray(corpus.games) && corpus.games.length > 0 && corpus.games.length <= 64
    && Array.isArray(corpus.records) && corpus.records.length <= MAX_DECISIONS && Array.isArray(corpus.positions), 'invalid-corpus-dimensions');
  const gameMap = new Map(), counts = new Map();
  for (const archive of corpus.games) {
    keys(archive, ['roomCode', 'decisionCount'], 'unexpected-game-summary-fields');
    check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(archive.roomCode) && !gameMap.has(archive.roomCode)
      && Number.isSafeInteger(archive.decisionCount) && archive.decisionCount >= 0, 'invalid-game-summary');
    gameMap.set(archive.roomCode, archive);
  }
  const expected = []; let outcomes = 0;
  for (const record of corpus.records) {
    checkBudget();
    check(gameMap.has(record.roomCode) && record.decisionIndex === (counts.get(record.roomCode) || 0) + 1
      && /^sha256:[a-f0-9]{64}$/.test(record.diagnosticFingerprint), 'record-origin-or-order-mismatch');
    counts.set(record.roomCode, record.decisionIndex);
    if (record.status === 'skipped') {
      keys(record, ['roomCode', 'decisionIndex', 'diagnosticFingerprint', 'status', 'reason'], 'unexpected-skipped-record-fields');
      check(typeof record.reason === 'string' && record.reason.length > 0 && record.reason.length <= 160, 'invalid-skipped-reason');
      continue;
    }
    keys(record, ['roomCode', 'decisionIndex', 'diagnosticFingerprint', 'status', 'reason', 'color', 'observedSource',
      'sourceIdentityVerified', 'decision'], 'unexpected-accepted-record-fields');
    check(record.status === 'locally-replayed' && record.reason === null
      && sourceIdentity(record.observedSource).verified === record.sourceIdentityVerified, 'source-verification-mismatch');
    const decoded = decodeDecision(captured.game, record.decision, record.color);
    check(equal(record.decision, cleanDecision(record.decision, decoded.factual)), 'noncanonical-retained-decision');
    const position = makePosition(captured, record, { check: checkBudget, remainingOutcomes: maxOutcomes - outcomes });
    outcomes += position.outcomes.length;
    expected.push(position);
  }
  checkBudget();
  for (const archive of corpus.games) check((counts.get(archive.roomCode) || 0) === archive.decisionCount, 'game-count-mismatch');
  check(equal(corpus.positions, expected), 'outcomes-or-preferences-not-canonical');
  check(equal(corpus.summary, summary(corpus)) && corpus.summary.uniqueLegalOutcomes <= maxOutcomes, 'summary-mismatch');
  checkBudget();
  return { ...corpus.summary, contentFingerprint: corpus.contentFingerprint, rulesFingerprint: captured.fingerprint,
    modelFingerprint: teacher.WARMSTART_MODEL, sourceLedgerFingerprint: corpus.provenance.sourceLedgerFingerprint };
}
function createTrainingSamples(corpus, options = {}) {
  validateTeacherCorpus(corpus, options);
  const result = [];
  for (const position of corpus.positions) for (const preference of position.preferences) {
    const good = position.outcomes.find(row => row.positionKey === preference.preferredPositionKey),
      bad = position.outcomes.find(row => row.positionKey === preference.disfavoredPositionKey);
    if (good.afterState.winner || bad.afterState.winner) continue;
    for (const [row, target] of [[good, 0.7], [bad, 0.3]]) result.push({ state: clone(row.afterState),
      color: position.color, target, targetKind: TARGET_KIND, sourcePositionId: position.positionId,
      preferenceCriterion: preference.criterion });
  }
  return result;
}
module.exports = { SCHEMA, INPUT_SCHEMA, SCOPE, TARGET_KIND, VERIFICATION, SOURCE_TUPLES,
  STRATEGY_PROFILES, buildTeacherCorpus, validateTeacherCorpus, createTrainingSamples, decodeDecision };
