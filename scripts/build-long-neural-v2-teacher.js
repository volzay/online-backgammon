#!/usr/bin/env node
'use strict';

// Offline, local-rule certification only. Uploaded diagnostic logs are not
// authenticated match evidence and their losing actions are not optimal labels.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const neural = require('../lib/long-bot-neural');
const legacy = require('./train-long-bot-neural');

const SCHEMA = 'long-neural-v2-teacher-corpus-v1';
const INPUT_SCHEMA = 'nardu-neuro-audit-input-v1';
const SCOPE = 'training-only-untrusted-room-diagnostics';
const VERIFICATION = 'canonical-rule-local-replay-not-signed-room-evidence';
const TARGET_KIND = 'synthetic-pairwise-ranking-surrogate-not-win-probability';
const PREFERENCE_KIND = 'heuristic-preference-not-causal-probability';
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_POSITIONS = 4096;
const MAX_OUTCOMES = 100000;
const COLORS = ['white', 'dark'];
const HISTORICAL_RULES = 'sha256:769c571ad10cefa75a8c128aba5123df47684780fad1136a0ae98f3342f33e4b';
const OPTIMIZED_RULES = 'sha256:6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623';
const WARMSTART_MODEL = 'sha256:4254bfa9f4afccbeb73657f11e37ff39a7fcd9162e7887f1aae28eaa7fbe0155';
const ROOT = path.join(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const fingerprint = legacy.fingerprint;
const equal = (left, right) => legacy.canonical(left) === legacy.canonical(right);
function assert(condition, label) { if (!condition) throw new Error(`Neural v2 teacher: ${label}`); }
function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), label);
}
function digest(value, label) { assert(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), label); }
function planner() { return require('../lib/long-bot-neural-v2'); }

// An allowlist projection deliberately excludes identities, history, fair-dice
// proofs/seeds, clocks, future dice, arbitrary annotations and account fields.
function projectState(input, variant = 'long') {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'invalid positional state');
  assert(input.variant === undefined || input.variant === variant, 'wrong positional variant');
  const state = {
    variant, points: clone(input.points), off: clone(input.off), bar: clone(input.bar),
    turn: input.turn, phase: input.phase, winner: input.winner == null ? null : input.winner,
    dice: clone(input.dice), rolled: clone(input.rolled), turnMoves: clone(input.turnMoves),
    firstMoveDone: clone(input.firstMoveDone), headPlayedThisTurn: clone(input.headPlayedThisTurn),
    score: { white: 0, dark: 0 }, history: [],
  };
  for (const key of ['off', 'bar', 'firstMoveDone', 'headPlayedThisTurn']) {
    exactKeys(state[key], COLORS, `unexpected ${key} fields`);
  }
  for (const color of COLORS) assert(typeof state.headPlayedThisTurn[color] === 'boolean', 'invalid head context');
  assert(Array.isArray(state.turnMoves) && state.turnMoves.length <= 4, 'invalid turn move context');
  state.turnMoves = state.turnMoves.map(move => {
    assert(move && COLORS.includes(move.color) && Number.isSafeInteger(move.from)
      && move.from >= 1 && move.from <= 24 && Number.isSafeInteger(move.to)
      && move.to >= 0 && move.to <= 24 && Number.isSafeInteger(move.die)
      && move.die >= 1 && move.die <= 6 && typeof move.bearOff === 'boolean', 'invalid positional turn move');
    return { color: move.color, from: move.from, to: move.to, die: move.die, bearOff: move.bearOff };
  });
  for (const stack of Object.values(state.points)) exactKeys(stack, ['color', 'count'], 'unexpected point fields');
  // Existing exact network encoding checks checker totals, phases and all dice.
  neural.encodeState(state, COLORS.includes(state.turn) ? state.turn : 'white');
  if (state.phase === 'move') {
    assert(state.turnMoves.length === 0 && !state.headPlayedThisTurn.white && !state.headPlayedThisTurn.dark,
      'only whole-turn start positions are accepted');
    assert(equal(state.dice, state.rolled), 'remaining dice differ from whole-turn roll');
    assert(state.dice.length === 2 && state.dice[0] !== state.dice[1]
      || state.dice.length === 4 && state.dice.every(die => die === state.dice[0]), 'invalid complete roll expansion');
    assert(!state.winner, 'move position cannot be terminal');
  } else {
    assert(state.phase === 'roll' || state.phase === 'over', 'unsupported positional phase');
    if (state.phase === 'roll') assert(state.turnMoves.length === 0 && state.dice.length === 0
      && state.rolled.length === 0 && !state.headPlayedThisTurn.white && !state.headPlayedThisTurn.dark,
    'invalid whole-turn end context');
  }
  return state;
}

function moves(input) {
  assert(Array.isArray(input) && input.length <= 4, 'invalid move list');
  return input.map(move => {
    assert(move && Number.isSafeInteger(move.from) && move.from >= 1 && move.from <= 24
      && Number.isSafeInteger(move.die) && move.die >= 1 && move.die <= 6, 'invalid move');
    return { from: move.from, die: move.die };
  });
}

function certifyExecution(game, before, selected, recordedAfter) {
  const after = clone(before);
  for (let index = 0; index < selected.length; index += 1) {
    const move = selected[index];
    assert(game.applyMove(after, move.from, move.die, { autoEnd: false }), 'recorded execution is illegal');
    if (after.winner) {
      assert(index === selected.length - 1, 'recorded plan continues after terminal move');
      break;
    }
  }
  assert(after.winner || !game.hasAnyMoves(after), 'recorded execution is incomplete');
  if (!after.winner) game.endTurn(after);
  const canonicalAfter = projectState(after);
  assert(equal(canonicalAfter, projectState(recordedAfter)), 'recorded afterstate differs from canonical execution');
  return canonicalAfter;
}

function terminal(game, room) {
  assert(COLORS.includes(room.botColor) && room.playerColor === game.opponentOf(room.botColor), 'invalid room seats');
  assert(room.variant === 'long' && COLORS.includes(room.winner), 'nonterminal/wrong-variant diagnostic room');
  const final = room.final;
  assert(final && final.phase === 'over' && final.winner === room.winner, 'invalid reported terminal state');
  const full = projectState({ ...final, variant: 'long', turn: room.winner,
    bar: { white: 0, dark: 0 }, dice: [], rolled: [], turnMoves: [],
    firstMoveDone: { white: true, dark: true }, headPlayedThisTurn: { white: false, dark: false } });
  assert(game.resultTypeFor(full, room.winner) === room.resultType, 'reported terminal classification differs from rules');
  return { points: full.points, off: full.off, phase: 'over', winner: room.winner, resultType: room.resultType };
}

function mechanicalMetrics(game, state, color) {
  const ownPath = game.pathFor(color, 'long');
  const enemy = game.opponentOf(color);
  let head = 0; let home = 0; let outside = 0; let routeDebt = 0; let blockedNearHead = 0; let koksExposure = 0;
  let clearRoute = true;
  ownPath.forEach((point, index) => {
    const stack = state.points[point];
    if (stack?.color !== color) return;
    if (index === 0) head = stack.count;
    // Exactly the LONG portal rule: remaining checkers in the loser's own
    // starting quarter, not the SHORT game's opponent-home definition.
    if (index <= 5) koksExposure += stack.count;
    if (index >= 18) home += stack.count;
    else {
      outside += stack.count;
      routeDebt += stack.count * (18 - index);
      if (ownPath.slice(index + 1, 19).some(next => state.points[next]?.color === enemy)) clearRoute = false;
    }
    if (index <= 5) blockedNearHead += stack.count * ownPath.slice(index + 1, index + 7)
      .filter(next => state.points[next]?.color === enemy).length;
  });
  return { off: state.off[color], head, home, outside, routeDebt,
    pips: game.pipsFor(state, color), blockedNearHead, clearRoute, koksExposure, enemyOff: state.off[enemy] };
}

function preferenceGuard(criterion, preferred, disfavored) {
  // These are transparent soft teaching objectives, NOT proven tactical regret.
  const noRetreat = preferred.off >= disfavored.off && preferred.home >= disfavored.home
    && preferred.pips <= disfavored.pips && preferred.blockedNearHead <= disfavored.blockedNearHead;
  if (criterion === 'bear-off-race') return preferred.outside === 0 && disfavored.outside === 0
    && preferred.off > disfavored.off && preferred.pips <= disfavored.pips;
  if (criterion === 'clear-route-home-progress') return noRetreat && preferred.clearRoute && disfavored.clearRoute
    && preferred.home > disfavored.home && preferred.routeDebt < disfavored.routeDebt;
  if (criterion === 'head-release-without-retreat') return noRetreat
    && preferred.head < disfavored.head && preferred.routeDebt <= disfavored.routeDebt;
  if (criterion === 'late-game-koks-exposure') return noRetreat
    && preferred.enemyOff >= 12 && disfavored.enemyOff >= 12
    && preferred.off === 0 && disfavored.off === 0 && preferred.koksExposure < disfavored.koksExposure;
  return false;
}

function preferences(outcomes, executedPositionKey) {
  const executed = outcomes.find(row => row.positionKey === executedPositionKey);
  assert(executed, 'executed outcome absent from canonical legal set');
  const result = [];
  for (const criterion of ['bear-off-race', 'clear-route-home-progress', 'head-release-without-retreat', 'late-game-koks-exposure']) {
    const alternatives = outcomes.filter(row => row.positionKey !== executedPositionKey
      && preferenceGuard(criterion, row.metrics, executed.metrics));
    alternatives.sort((a, b) => criterion === 'bear-off-race' ? b.metrics.off - a.metrics.off
      || a.metrics.pips - b.metrics.pips || a.positionKey.localeCompare(b.positionKey)
      : criterion === 'clear-route-home-progress' ? b.metrics.home - a.metrics.home
      || a.metrics.routeDebt - b.metrics.routeDebt || a.positionKey.localeCompare(b.positionKey)
      : criterion === 'late-game-koks-exposure' ? a.metrics.koksExposure - b.metrics.koksExposure
      || a.metrics.routeDebt - b.metrics.routeDebt || a.positionKey.localeCompare(b.positionKey)
      : a.metrics.head - b.metrics.head || a.metrics.routeDebt - b.metrics.routeDebt || a.positionKey.localeCompare(b.positionKey));
    if (alternatives.length) result.push({ kind: PREFERENCE_KIND, criterion,
      preferredPositionKey: alternatives[0].positionKey, disfavoredPositionKey: executedPositionKey, weight: 1 });
  }
  return result;
}

function runtimeOptions(options = {}) {
  const runtime = options.game ? { game: options.game, fingerprint: options.rulesFingerprint } : legacy.loadLongGame();
  digest(runtime.fingerprint, 'missing current rules fingerprint');
  assert(runtime.fingerprint === OPTIMIZED_RULES || runtime.fingerprint === HISTORICAL_RULES,
    'rules revision has not been independently approved for historical replay');
  const artifact = options.modelArtifact || JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/long-neural/model.json'), 'utf8'));
  neural.validateModel(artifact.model);
  const modelFingerprint = legacy.modelFingerprint(artifact.model);
  assert(modelFingerprint === WARMSTART_MODEL, 'teacher must replay the pinned historical neural model');
  assert(artifact.metadata?.modelFingerprint === modelFingerprint, 'historical model metadata fingerprint mismatch');
  const plannerFingerprint = fingerprint(fs.readFileSync(path.join(ROOT, 'lib/long-bot-neural-v2.js')));
  return { ...runtime, model: artifact.model, modelFingerprint, plannerFingerprint,
    modelSourceFingerprint: fingerprint(fs.readFileSync(path.join(ROOT, 'lib/long-bot-neural.js'))) };
}

function observedRuntimeFingerprint(metadata) {
  if (metadata.runtimeRulesFingerprint !== undefined || metadata.rulesCompatibility !== undefined) {
    assert(metadata.runtimeRulesFingerprint === OPTIMIZED_RULES
      && metadata.rulesCompatibility === 'history-free-rule-search-v1', 'unsupported observed historical runtime compatibility');
    return metadata.runtimeRulesFingerprint;
  }
  return metadata.rulesFingerprint;
}

function buildTeacherCorpus(input, options = {}) {
  exactKeys(input, ['schema', 'rooms'], 'unsupported diagnostic input schema; hard loss reviews require full-provenance importer');
  assert(input.schema === INPUT_SCHEMA && Array.isArray(input.rooms) && input.rooms.length > 0 && input.rooms.length <= 64,
    'unsupported diagnostic input schema; hard loss reviews require full-provenance importer');
  assert(Buffer.byteLength(JSON.stringify(input)) <= MAX_INPUT_BYTES, 'diagnostic input exceeds byte budget');
  const runtime = runtimeOptions(options);
  const { game, model } = runtime;
  const corpus = { schema: SCHEMA, scope: SCOPE, productionEligible: false,
    provenance: { rulesFingerprint: runtime.fingerprint, modelFingerprint: runtime.modelFingerprint,
      modelSourceFingerprint: runtime.modelSourceFingerprint, plannerFingerprint: runtime.plannerFingerprint,
      sourceLedgerFingerprint: fingerprint(input), verification: VERIFICATION },
    rooms: [], positions: [], summary: null };
  const seenRooms = new Set();
  let outcomeCount = 0;
  const started = Date.now();
  const maximumMs = options.maxElapsedMs ?? 60000;
  assert(Number.isSafeInteger(maximumMs) && maximumMs > 0 && maximumMs <= 3600000, 'invalid time budget');
  for (const room of input.rooms) {
    assert(room && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(room.roomCode) && !seenRooms.has(room.roomCode), 'invalid/duplicate room code');
    seenRooms.add(room.roomCode);
    assert(Array.isArray(room.decisions) && room.decisions.length > 0, 'missing diagnostic decisions');
    assert(room.neuralModel?.modelFingerprint === runtime.modelFingerprint
      && room.neuralModel?.rulesFingerprint === HISTORICAL_RULES
      && room.neuralModel?.inferenceCodeFingerprint === runtime.modelSourceFingerprint, 'historical model/runtime origin mismatch');
    const sourceRuntimeFingerprint = observedRuntimeFingerprint(room.neuralModel);
    const observedFinal = terminal(game, room);
    corpus.rooms.push({ roomCode: room.roomCode, botColor: room.botColor, observedFinal,
      decisionCount: room.decisions.length, sourceModelFingerprint: runtime.modelFingerprint,
      sourceRulesFingerprint: room.neuralModel.rulesFingerprint, sourceRuntimeFingerprint });
    for (let index = 0; index < room.decisions.length; index += 1) {
      assert(corpus.positions.length < MAX_POSITIONS && Date.now() - started < maximumMs, 'position/time budget exhausted; no partial corpus');
      const decision = room.decisions[index];
      assert(decision?.schema === 'nardu-neural-decision-v1' && decision.execution?.complete === true, 'unsupported/incomplete recorded decision');
      assert(decision.diagnostics?.policy === 'hard-neuro' && decision.diagnostics?.modelFingerprint === runtime.modelFingerprint,
        'decision model origin mismatch');
      const before = projectState(decision.before);
      assert(before.phase === 'move' && before.turn === room.botColor, 'wrong actor or decision phase');
      const selected = moves(decision.selected);
      assert(equal(selected, moves(decision.execution.executedMoves)), 'selected and executed moves differ');
      const afterState = certifyExecution(game, before, selected, decision.execution.after);
      const enumeration = planner().enumerateUniqueTurns(game, before);
      assert(Number.isSafeInteger(enumeration.legalSequences) && enumeration.legalSequences <= 65536,
        'legal sequence budget exceeded');
      outcomeCount += enumeration.rows.length;
      assert(outcomeCount <= MAX_OUTCOMES && Date.now() - started < maximumMs, 'outcome/time budget exhausted; no partial corpus');
      const outcomes = enumeration.rows.map(row => ({ moves: moves(row.moves), afterState: projectState(row.afterState),
        positionKey: row.positionKey, legacyValue: neural.predict(model, row.afterState, before.turn),
        metrics: mechanicalMetrics(game, row.afterState, before.turn) }));
      const executed = outcomes.find(row => equal(row.afterState, afterState));
      assert(executed, 'recorded complete execution absent from canonical legal outcomes');
      const positionId = fingerprint([room.roomCode, index + 1, before]);
      corpus.positions.push({ positionId, source: { roomCode: room.roomCode, decisionIndex: index + 1,
        observedRuntimeFingerprint: sourceRuntimeFingerprint, observedModelFingerprint: runtime.modelFingerprint },
      color: before.turn, before, executed: { moves: selected, afterState, positionKey: executed.positionKey,
        observedTerminalDiagnostic: { winner: room.winner, resultType: room.resultType,
          botLost: room.winner !== room.botColor, kind: 'behavior-monte-carlo-diagnostic-not-counterfactual-target' } },
      legalSequences: enumeration.legalSequences, outcomes, preferences: preferences(outcomes, executed.positionKey) });
    }
  }
  corpus.summary = { rooms: corpus.rooms.length, positions: corpus.positions.length,
    uniqueLegalOutcomes: outcomeCount, heuristicPreferences: corpus.positions.reduce((sum, row) => sum + row.preferences.length, 0),
    causalLabels: 0, terminalTrainingTargets: 0, authenticatedMatches: 0 };
  corpus.contentFingerprint = fingerprint(corpus);
  assert(Buffer.byteLength(JSON.stringify(corpus)) <= MAX_OUTPUT_BYTES, 'corpus exceeds output byte budget');
  return corpus;
}

function validateTeacherCorpus(corpus, options = {}) {
  exactKeys(corpus, ['schema', 'scope', 'productionEligible', 'provenance', 'rooms', 'positions', 'summary', 'contentFingerprint'], 'unexpected corpus fields');
  assert(corpus.schema === SCHEMA && corpus.scope === SCOPE && corpus.productionEligible === false, 'unsupported teacher scope');
  exactKeys(corpus.provenance, ['rulesFingerprint', 'modelFingerprint', 'modelSourceFingerprint', 'plannerFingerprint',
    'sourceLedgerFingerprint', 'verification'], 'unexpected provenance fields');
  const runtime = runtimeOptions(options);
  assert(corpus.provenance.rulesFingerprint === runtime.fingerprint && corpus.provenance.modelFingerprint === runtime.modelFingerprint
    && corpus.provenance.modelSourceFingerprint === runtime.modelSourceFingerprint
    && corpus.provenance.plannerFingerprint === runtime.plannerFingerprint
    && corpus.provenance.verification === VERIFICATION, 'teacher provenance does not match captured runtime');
  if (options.modelFingerprint) assert(options.modelFingerprint === runtime.modelFingerprint, 'requested model fingerprint mismatch');
  digest(corpus.provenance.sourceLedgerFingerprint, 'invalid source ledger fingerprint');
  const unsigned = { ...corpus }; delete unsigned.contentFingerprint;
  assert(fingerprint(unsigned) === corpus.contentFingerprint, 'corpus content fingerprint mismatch');
  assert(Array.isArray(corpus.rooms) && corpus.rooms.length > 0 && corpus.rooms.length <= 64
    && Array.isArray(corpus.positions) && corpus.positions.length > 0 && corpus.positions.length <= MAX_POSITIONS,
    'invalid corpus dimensions');
  assert(Buffer.byteLength(JSON.stringify(corpus)) <= MAX_OUTPUT_BYTES, 'corpus exceeds output byte budget');
  const roomMap = new Map();
  for (const room of corpus.rooms) {
    exactKeys(room, ['roomCode', 'botColor', 'observedFinal', 'decisionCount', 'sourceModelFingerprint', 'sourceRulesFingerprint',
      'sourceRuntimeFingerprint'], 'unexpected room summary fields');
    assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(room.roomCode) && !roomMap.has(room.roomCode), 'invalid/duplicate corpus room');
    exactKeys(room.observedFinal, ['points', 'off', 'phase', 'winner', 'resultType'], 'unexpected final fields');
    terminal(runtime.game, { variant: 'long', botColor: room.botColor,
      playerColor: runtime.game.opponentOf(room.botColor), winner: room.observedFinal.winner,
      final: room.observedFinal, resultType: room.observedFinal.resultType });
    assert(room.sourceModelFingerprint === runtime.modelFingerprint && room.sourceRulesFingerprint === HISTORICAL_RULES
      && [HISTORICAL_RULES, OPTIMIZED_RULES].includes(room.sourceRuntimeFingerprint)
      && Number.isSafeInteger(room.decisionCount) && room.decisionCount > 0, 'invalid room origin/count');
    roomMap.set(room.roomCode, room);
  }
  const positions = new Set(); const roomCounts = new Map(); let outcomeCount = 0; let preferenceCount = 0;
  for (const position of corpus.positions) {
    exactKeys(position, ['positionId', 'source', 'color', 'before', 'executed', 'legalSequences', 'outcomes', 'preferences'], 'unexpected position fields');
    exactKeys(position.source, ['roomCode', 'decisionIndex', 'observedRuntimeFingerprint', 'observedModelFingerprint'], 'unexpected position source fields');
    const room = roomMap.get(position.source.roomCode);
    assert(room && position.source.observedModelFingerprint === room.sourceModelFingerprint
      && position.source.observedRuntimeFingerprint === room.sourceRuntimeFingerprint
      && position.color === room.botColor, 'position origin mismatch');
    const ordinal = (roomCounts.get(room.roomCode) || 0) + 1;
    assert(position.source.decisionIndex === ordinal, 'missing/reordered/duplicate decision index');
    roomCounts.set(room.roomCode, ordinal);
    const before = projectState(position.before);
    assert(equal(position.before, before) && before.phase === 'move' && before.turn === position.color, 'noncanonical beforestate');
    assert(position.positionId === fingerprint([room.roomCode, ordinal, before]) && !positions.has(position.positionId), 'position fingerprint mismatch/duplicate');
    positions.add(position.positionId);
    exactKeys(position.executed, ['moves', 'afterState', 'positionKey', 'observedTerminalDiagnostic'], 'unexpected executed fields');
    exactKeys(position.executed.observedTerminalDiagnostic, ['winner', 'resultType', 'botLost', 'kind'], 'unexpected terminal diagnostic fields');
    assert(equal(position.executed.observedTerminalDiagnostic, { winner: room.observedFinal.winner,
      resultType: room.observedFinal.resultType, botLost: room.observedFinal.winner !== room.botColor,
      kind: 'behavior-monte-carlo-diagnostic-not-counterfactual-target' }), 'terminal diagnostics cannot become causal labels');
    const executionMoves = moves(position.executed.moves);
    assert(equal(position.executed.moves, executionMoves), 'noncanonical executed moves');
    const canonicalAfter = certifyExecution(runtime.game, before, executionMoves, position.executed.afterState);
    const enumeration = planner().enumerateUniqueTurns(runtime.game, before);
    assert(enumeration.legalSequences <= 65536 && position.legalSequences === enumeration.legalSequences
      && Array.isArray(position.outcomes) && position.outcomes.length === enumeration.rows.length, 'incomplete canonical legal outcome set');
    const expected = enumeration.rows.map(row => ({ moves: moves(row.moves), afterState: projectState(row.afterState),
      positionKey: row.positionKey, legacyValue: neural.predict(runtime.model, row.afterState, position.color),
      metrics: mechanicalMetrics(runtime.game, row.afterState, position.color) }));
    assert(equal(position.outcomes, expected), 'counterfactual outcomes/values/metrics differ from canonical rules');
    const executed = expected.find(row => row.positionKey === position.executed.positionKey);
    assert(executed && equal(executed.afterState, canonicalAfter), 'executed outcome key mismatch');
    assert(equal(position.preferences, preferences(expected, executed.positionKey)), 'heuristic preference guard mismatch');
    outcomeCount += expected.length; preferenceCount += position.preferences.length;
    assert(outcomeCount <= MAX_OUTCOMES, 'outcome budget exceeded');
  }
  for (const room of corpus.rooms) assert(roomCounts.get(room.roomCode) === room.decisionCount, 'room decision count mismatch');
  assert(equal(corpus.summary, { rooms: corpus.rooms.length, positions: corpus.positions.length,
    uniqueLegalOutcomes: outcomeCount, heuristicPreferences: preferenceCount,
    causalLabels: 0, terminalTrainingTargets: 0, authenticatedMatches: 0 }), 'invalid corpus summary');
  return { ...corpus.summary, sourceLedgerFingerprint: corpus.provenance.sourceLedgerFingerprint,
    contentFingerprint: corpus.contentFingerprint, rulesFingerprint: runtime.fingerprint, modelFingerprint: runtime.modelFingerprint };
}

function createTrainingSamples(corpus, options = {}) {
  // Always independently recertify before exposing samples to gradient updates.
  validateTeacherCorpus(corpus, options);
  const result = [];
  for (const position of corpus.positions) for (const preference of position.preferences) {
    const preferred = position.outcomes.find(outcome => outcome.positionKey === preference.preferredPositionKey);
    const disfavored = position.outcomes.find(outcome => outcome.positionKey === preference.disfavoredPositionKey);
    // Exact terminal outcomes are handled by rules, never a one-sided surrogate.
    if (preferred.afterState.winner || disfavored.afterState.winner) continue;
    for (const [key, target] of [[preference.preferredPositionKey, 0.7], [preference.disfavoredPositionKey, 0.3]]) {
      const row = position.outcomes.find(outcome => outcome.positionKey === key);
      result.push({ state: clone(row.afterState), color: position.color, target,
        targetKind: TARGET_KIND, sourcePositionId: position.positionId, preferenceCriterion: preference.criterion });
    }
  }
  return result;
}

function cli(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    assert(['--input', '--output', '--max-elapsed-ms'].includes(key) && value !== undefined
      && !Object.hasOwn(result, key), 'usage: --input ABSOLUTE.json --output ABSOLUTE.json [--max-elapsed-ms N]');
    result[key] = value;
  }
  assert(path.isAbsolute(result['--input'] || '') && path.isAbsolute(result['--output'] || '')
    && path.resolve(result['--input']) !== path.resolve(result['--output']), 'explicit separate absolute input/output paths required');
  return result;
}

if (require.main === module) {
  try {
    const args = cli(process.argv.slice(2));
    if (args.help) console.log('Offline teacher: --input ABSOLUTE.json --output ABSOLUTE.json [--max-elapsed-ms N]. Untrusted logs receive local legality certification, not signed/causal evidence.');
    else {
      const input = args['--input']; const stat = fs.lstatSync(input);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_INPUT_BYTES, 'input must be a bounded regular JSON file');
      const corpus = buildTeacherCorpus(JSON.parse(fs.readFileSync(input, 'utf8')),
        { ...(args['--max-elapsed-ms'] ? { maxElapsedMs: Number(args['--max-elapsed-ms']) } : {}) });
      // Exclusive output preserves previous artifacts and refuses a symlink target.
      const descriptor = fs.openSync(args['--output'], 'wx', 0o600);
      try { fs.writeFileSync(descriptor, `${JSON.stringify(corpus, null, 2)}\n`); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      console.log(JSON.stringify({ ok: true, ...corpus.summary, contentFingerprint: corpus.contentFingerprint,
        scope: corpus.scope, productionEligible: false }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { SCHEMA, INPUT_SCHEMA, SCOPE, VERIFICATION, TARGET_KIND, WARMSTART_MODEL,
  buildTeacherCorpus, validateTeacherCorpus, createTrainingSamples, projectState,
  mechanicalMetrics, preferenceGuard, preferences, cli };
