'use strict';

// This module is deliberately a coordinator-side boundary. It reuses the same
// published rules as the board; it never asks a bot, a browser or a RNG to choose
// dice. Cryptographic verification of issuedProof belongs to the coordinator.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const math = Object.create(Math);
math.random = () => { throw failure('fair_random_forbidden', 'Rules replay must not generate dice'); };
const context = { window: {}, Date, Math: math, JSON };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8'), context, { filename: 'game.js' });
const rules = context.window.NarduGame;
const COLORS = new Set(['white', 'dark']);
const MAX_HISTORY = 20000;
const PROTOCOL = 'drand-quicknet-v1';
const PROTOCOLS = new Set([PROTOCOL, 'system-csprng-v1']);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireThat(condition, code, message) {
  if (!condition) throw failure(code, message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value, depth = 0) {
  requireThat(depth < 80, 'fair_invalid_state', 'State nesting is too deep');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => stable(item, depth + 1)).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + stable(value[key], depth + 1)).join(',') + '}';
}

function equal(a, b) { return stable(a) === stable(b); }

function pick(object, keys) {
  const result = {};
  for (const key of keys) if (object?.[key] !== undefined) result[key] = object[key];
  return result;
}

function botIdentity(state) {
  // Bot rooms have one real account controlling either physical color. SQL
  // derives resignation/authorship from this value, not the presentation-only
  // top-level playerColor (which remoteStatePayload deliberately removes).
  if (state.mode !== 'bot' || state.analysis?.playerColor === undefined) return {};
  return { analysis: { playerColor: state.analysis.playerColor } };
}

function openingOf(opening) {
  if (!opening) return null;
  return {
    host: pick(opening.host, ['color', 'die']),
    guest: pick(opening.guest, ['color', 'die']),
    ...pick(opening, ['winnerColor', 'rerolls', 'sha256', 'sha256Input', 'fairDiceProof']),
  };
}

function eventOf(event) {
  return pick(event, ['opening', 'host', 'guest', 'winnerColor', 'rerolls', 'color',
    'roll', 'openingMove', 'sha256', 'sha256Input', 'fairDiceProof', 'from', 'to',
    'die', 'hit', 'hitColor', 'resign', 'leave', 'networkLoss', 'timeout']);
}

// An internal deterministic rules position excludes names, analysis metadata,
// presentation and running clocks. The DB reservation commits to its locked
// full JSONB snapshot separately; this hash is not that SQL commitment.
function positionOf(state) {
  requireThat(state && typeof state === 'object' && !Array.isArray(state), 'fair_invalid_state', 'Game state is required');
  return {
    ...pick(state, ['variant', 'points', 'bar', 'off', 'score', 'dice', 'rolled',
      'turn', 'phase', 'winner', 'resultType', 'turnMoves', 'firstMoveDone',
      'headPlayedThisTurn', 'matchScore', 'startedAt', 'gameId', 'fairDiceGameId',
      'fairDicePolicy', 'roomCode', 'mode']),
    ...botIdentity(state),
    ...(state.fairDice ? { fairDice: pick(state.fairDice, ['protocol', 'required', 'gameId', 'policyVersion']) } : {}),
    openingRoll: openingOf(state.openingRoll),
    networkLoss: state.networkLoss && typeof state.networkLoss === 'object'
      ? pick(state.networkLoss, ['loserColor', 'winnerColor']) : null,
    history: (state.history || []).map(eventOf),
  };
}

function positionHash(state) {
  return createHash('sha256').update(stable(positionOf(state)), 'utf8').digest('hex');
}

function positiveInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function shape(state) {
  requireThat(state && typeof state === 'object' && !Array.isArray(state), 'fair_invalid_state', 'Game state is required');
  requireThat(state.variant === 'long' || state.variant === 'short', 'fair_invalid_state', 'Unknown game variant');
  if (state.fairDice?.protocol !== undefined) {
    requireThat(PROTOCOLS.has(state.fairDice.protocol), 'fair_proof_required', 'Unknown protected dice protocol');
  }
  if (state.mode === 'bot' && state.analysis?.playerColor !== undefined) {
    requireThat(COLORS.has(state.analysis.playerColor), 'fair_invalid_state', 'Invalid physical player color');
  }
  requireThat(state.points && typeof state.points === 'object' && !Array.isArray(state.points), 'fair_invalid_state', 'Invalid points');
  const total = { white: 0, dark: 0 };
  for (const [point, stack] of Object.entries(state.points)) {
    requireThat(/^(?:[1-9]|1[0-9]|2[0-4])$/.test(point) && stack && COLORS.has(stack.color)
      && positiveInteger(stack.count, 1, 15), 'fair_invalid_state', 'Invalid checker stack');
    total[stack.color] += stack.count;
  }
  for (const counter of ['bar', 'off', 'score']) {
    requireThat(state[counter] && typeof state[counter] === 'object' && !Array.isArray(state[counter]), 'fair_invalid_state', 'Invalid ' + counter);
    for (const color of COLORS) {
      requireThat(positiveInteger(state[counter][color], 0, counter === 'score' ? 1000000 : 15), 'fair_invalid_state', 'Invalid ' + counter);
      if (counter !== 'score') total[color] += state[counter][color];
    }
  }
  requireThat(total.white === 15 && total.dark === 15, 'fair_invalid_state', 'Checker totals must remain fifteen');
  for (const field of ['dice', 'rolled']) {
    requireThat(Array.isArray(state[field]) && state[field].length <= 4
      && state[field].every(die => positiveInteger(die, 1, 6)), 'fair_invalid_state', 'Invalid dice');
  }
  requireThat(['opening', 'opening-result', 'roll', 'move', 'over'].includes(state.phase), 'fair_invalid_state', 'Invalid game phase');
  requireThat(state.turn === null || COLORS.has(state.turn), 'fair_invalid_state', 'Invalid turn');
  requireThat(state.winner === null || COLORS.has(state.winner), 'fair_invalid_state', 'Invalid winner');
  requireThat(state.resultType === null || state.resultType === 'mars' || state.resultType === 'koks', 'fair_invalid_state', 'Invalid result type');
  requireThat(Array.isArray(state.turnMoves) && Array.isArray(state.history) && state.history.length <= MAX_HISTORY
    && state.history.every(event => event && typeof event === 'object' && !Array.isArray(event)), 'fair_invalid_state', 'Invalid history');
  requireThat(positiveInteger(state.startedAt, 1), 'fair_invalid_state', 'Invalid game epoch timestamp');
  requireThat(state.finishedAt === null || positiveInteger(state.finishedAt, 1), 'fair_invalid_state', 'Invalid finish timestamp');
  for (const field of ['firstMoveDone', 'headPlayedThisTurn']) {
    requireThat(state[field] && [...COLORS].every(color => typeof state[field][color] === 'boolean'), 'fair_invalid_state', 'Invalid ' + field);
  }
  requireThat(state.matchScore && positiveInteger(state.matchScore.white, 0, 10000)
    && positiveInteger(state.matchScore.dark, 0, 10000) && positiveInteger(state.matchScore.target, 1, 100)
    && (state.matchScore.recordedWinner === null || COLORS.has(state.matchScore.recordedWinner)), 'fair_invalid_state', 'Invalid match score');
}

function coreWithoutResultMetadata(state) {
  const core = positionOf(state);
  delete core.matchScore;
  return core;
}

function identity(state) {
  return {
    ...pick(state, ['variant', 'startedAt', 'roomCode', 'mode', 'gameId', 'fairDiceGameId', 'fairDicePolicy']),
    ...botIdentity(state),
    ...(state.fairDice ? { fairDice: pick(state.fairDice, ['protocol', 'required', 'gameId', 'policyVersion']) } : {}),
  };
}

function isRoll(event) { return event.opening === true || typeof event.roll === 'string' || event.fairDiceProof !== undefined; }
function isMove(event) { return event.from !== undefined && event.die !== undefined; }

function validateEventType(event) {
  for (const flag of ['opening', 'openingMove', 'hit', 'resign', 'leave', 'networkLoss', 'timeout']) {
    requireThat(event[flag] === undefined || typeof event[flag] === 'boolean', 'fair_history_invalid', 'Gameplay flags must be boolean');
  }
  const terminalFlags = ['resign', 'leave', 'networkLoss', 'timeout'].filter(flag => event[flag] === true);
  const kinds = Number(event.opening === true) + Number(event.roll !== undefined)
    + Number(event.from !== undefined || event.die !== undefined) + terminalFlags.length;
  requireThat(kinds === 1 && (isRoll(event) || (event.sha256 === undefined && event.sha256Input === undefined)),
    'fair_history_invalid', 'Gameplay events must have one unambiguous type');
  requireThat(event.fairDiceProof === undefined || event.opening === true || typeof event.roll === 'string',
    'fair_history_invalid', 'A move or concession cannot masquerade as a dice proof');
}

function authorizeMove(state, options) {
  requireThat(options.actorColor === state.turn || (options.botOwner === true && state.mode === 'bot'),
    'fair_actor_forbidden', 'Only the current player may move');
}

function canEnd(state) {
  return state.phase === 'move' && !state.winner && (!state.dice.length || !rules.hasAnyMoves(clone(state)));
}

function proofFor(state, event, options, historical) {
  const proof = event.fairDiceProof;
  const prior = state.history.filter(isRoll).map(item => item.fairDiceProof);
  const expectedProtocol = state.fairDice?.protocol || options.fairDiceProtocol
    || prior[0]?.protocol || options.issuedProof?.protocol || PROTOCOL;
  requireThat(PROTOCOLS.has(expectedProtocol) && proof && proof.protocol === expectedProtocol
    && Array.isArray(proof.dice) && proof.dice.length === 2
    && proof.dice.every(die => positiveInteger(die, 1, 6)), 'fair_proof_required', 'A coordinator-issued dice proof is required');
  if (!historical) requireThat(options.issuedProof && equal(proof, options.issuedProof), 'fair_proof_not_issued', 'Dice proof was not issued for this transition');
  const opening = event.opening === true;
  requireThat(proof.request && proof.request.label === (opening ? 'opening' : 'roll')
    && proof.request.variant === state.variant
    && proof.request.color === (opening ? 'none' : state.turn), 'fair_proof_context', 'Dice proof belongs to another turn');
  if (!historical && options.serverPositionHash !== undefined) {
    requireThat(proof.request.positionHash === options.serverPositionHash,
      'fair_proof_context', 'Dice proof belongs to another reserved DB snapshot');
  }
  requireThat(prior.every(item => item && item.protocol === expectedProtocol), 'fair_proof_required', 'Protected history contains an unissued or mixed-protocol roll');
  requireThat(!prior.some(item => item.request.id === proof.request.id), 'fair_proof_reused', 'Dice request cannot be reused');
  const newest = prior[0];
  requireThat(positiveInteger(proof.request.nonce, 1) && proof.request.nonce === (newest ? newest.request.nonce + 1 : 1)
    && (!newest || proof.request.gameId === newest.request.gameId), 'fair_proof_nonce', 'Dice nonce or game epoch is invalid');
  for (const epoch of [state.gameId, state.fairDiceGameId, state.fairDice?.gameId]) {
    if (epoch !== undefined) requireThat(proof.request.gameId === epoch, 'fair_proof_context', 'Dice proof belongs to another game');
  }
  if (state.roomCode !== undefined) requireThat(proof.request.roomCode === state.roomCode, 'fair_proof_context', 'Dice proof belongs to another room');
  requireThat(event.sha256 === proof.sha256 && event.sha256Input === proof.sha256Input,
    'fair_proof_context', 'Displayed SHA-256 is not the issued dice value');
  requireThat(positiveInteger(proof.rerolls, 0, 1000000), 'fair_proof_context', 'Invalid opening tie counter');
  return proof;
}

function appendEvent(state, event, options, historical = false) {
  requireThat(!state.winner, 'fair_game_over', 'Cannot append gameplay after the result');
  validateEventType(event);
  if (event.opening === true) {
    requireThat(state.phase === 'opening' && state.history.length === 0, 'fair_roll_phase', 'Opening roll is already fixed');
    if (!historical) requireThat(options.actorColor === 'white' || (options.botOwner === true && state.mode === 'bot'), 'fair_actor_forbidden', 'Only the room owner may request the opening');
    const proof = proofFor(state, event, options, historical);
    requireThat(proof.dice[0] !== proof.dice[1] && event.host === proof.dice[0] && event.guest === proof.dice[1]
      && event.winnerColor === (proof.dice[0] > proof.dice[1] ? 'white' : 'dark') && event.rerolls === proof.rerolls,
    'fair_proof_context', 'Opening result does not match the issued dice');
    rules.decideOpeningRoll(state, { id: 'white', color: 'white', name: event.hostName, die: proof.dice[0] },
      { id: 'dark', color: 'dark', name: event.guestName, die: proof.dice[1] });
    state.openingRoll.sha256 = proof.sha256;
    state.openingRoll.sha256Input = proof.sha256Input;
    state.openingRoll.rerolls = proof.rerolls;
    // The controller may show the proof on both the opening object and event.
    if (options.openingProofOnObject) state.openingRoll.fairDiceProof = clone(proof);
    state.history[0] = clone(event);
    return;
  }
  if (isRoll(event)) {
    if (historical && state.phase === 'opening-result') rules.startOpeningTurn(state);
    if (historical && canEnd(state)) rules.endTurn(state);
    requireThat(state.phase === 'roll', 'fair_roll_phase', 'Unconsumed dice cannot be discarded for a new roll');
    if (!historical) authorizeMove(state, options);
    const proof = proofFor(state, event, options, historical);
    requireThat(event.color === state.turn && event.roll === proof.dice.join(':'), 'fair_proof_context', 'Roll display does not match issued dice');
    const openingMove = Boolean(state.openingRoll) && !state.history.some(item => item.openingMove);
    requireThat(Boolean(event.openingMove) === openingMove, 'fair_proof_context', 'Invalid first-move marker');
    const [a, b] = proof.dice;
    rules.applyRoll(state, a === b ? [a, a, a, a] : [a, b]);
    state.history.unshift(clone(event));
    return;
  }
  if (isMove(event)) {
    requireThat(state.phase === 'move' && event.color === state.turn, 'fair_move_phase', 'Move belongs to another turn');
    if (!historical) authorizeMove(state, options);
    requireThat(Number.isSafeInteger(event.from) && positiveInteger(event.die, 1, 6)
      && rules.applyMove(state, event.from, event.die, { autoEnd: false }), 'fair_illegal_move', 'Move is not legal for the available dice');
    const generated = state.history[0];
    requireThat(equal(pick(generated, ['color', 'from', 'to', 'die', 'hit', 'hitColor']),
      pick(event, ['color', 'from', 'to', 'die', 'hit', 'hitColor'])), 'fair_illegal_move', 'Move destination or hit was forged');
    state.history[0] = clone(event);
    return;
  }
  const conceded = event.resign === true || event.leave === true;
  const networkLoss = event.networkLoss === true || event.timeout === true;
  requireThat(conceded || networkLoss, 'fair_history_invalid', 'Unsupported gameplay event');
  requireThat(COLORS.has(event.color) && event.winnerColor === rules.opponentOf(event.color), 'fair_result_invalid', 'Invalid concession result');
  if (!historical) {
    requireThat(conceded ? event.color === options.actorColor : options.allowNetworkLoss === true,
      'fair_actor_forbidden', 'A player cannot declare the opponent disconnected or resigned');
  }
  state.dice = [];
  state.rolled = [];
  state.winner = event.winnerColor;
  state.resultType = null;
  state.phase = 'over';
  if (event.networkLoss === true) {
    state.networkLoss = { loserColor: event.color, winnerColor: event.winnerColor,
      message: event.message, at: event.at };
  }
  state.history.unshift(clone(event));
}

function validateResultMetadata(previous, next) {
  const base = previous.matchScore;
  const recorded = clone(base);
  if (next.winner && base.recordedWinner !== next.winner) {
    recorded[next.winner] += 1;
    recorded.recordedWinner = next.winner;
  }
  requireThat(equal(next.matchScore, base) || (next.winner && equal(next.matchScore, recorded)),
    'fair_match_score_invalid', 'Match score can only record the legal winner once');
  if (!next.winner) requireThat(next.finishedAt === previous.finishedAt, 'fair_result_invalid', 'An unfinished game cannot acquire a finish timestamp');
  if (previous.finishedAt !== null) requireThat(next.finishedAt === previous.finishedAt, 'fair_result_invalid', 'Finish timestamp is immutable');
}

function matchesLawfulPhase(expected, next) {
  const target = coreWithoutResultMetadata(next);
  if (equal(coreWithoutResultMetadata(expected), target)) return true;
  const progressed = clone(expected);
  if (progressed.phase === 'opening-result') rules.startOpeningTurn(progressed);
  else if (canEnd(progressed)) rules.endTurn(progressed);
  else return false;
  return equal(coreWithoutResultMetadata(progressed), target);
}

function replayForUndo(previous, next, options) {
  const replay = clone(rules.initialState(previous.variant));
  Object.assign(replay, identity(previous));
  replay.matchScore = clone(previous.matchScore);
  const openingProofOnObject = Boolean(previous.openingRoll?.fairDiceProof);
  // Browser snapshots need not carry fairDice metadata. The opening still
  // belongs to the room's pinned protocol, not the historical drand default.
  // Infer only from the already-confirmed history when no room pin is given;
  // never let a proposed undo choose its own protocol.
  const fairDiceProtocol = previous.fairDice?.protocol || options.fairDiceProtocol
    || previous.history.find(isRoll)?.fairDiceProof?.protocol || PROTOCOL;
  for (const event of next.history.slice().reverse()) appendEvent(replay, event, {
    openingProofOnObject, fairDiceProtocol,
  }, true);
  return replay;
}

function validateTransition(previous, next, options = {}) {
  shape(next);
  requireThat(options.fairDiceProtocol === undefined || PROTOCOLS.has(options.fairDiceProtocol)
    && (next.fairDice?.protocol === undefined || options.fairDiceProtocol === next.fairDice.protocol),
  'fair_proof_required', 'Protected room protocol cannot change');
  requireThat(COLORS.has(options.actorColor), 'fair_actor_forbidden', 'An authenticated room participant is required');
  if (!previous) {
    requireThat(options.allowInitial === true, 'fair_initial_forbidden', 'Only the coordinator may initialize a protected game');
    const initial = clone(rules.initialState(next.variant));
    Object.assign(initial, identity(next));
    requireThat(equal(coreWithoutResultMetadata(initial), coreWithoutResultMetadata(next))
      && equal(initial.matchScore, next.matchScore) && next.finishedAt === null,
    'fair_initial_invalid', 'Protected games must begin with the published initial position');
    return true;
  }
  shape(previous);
  requireThat(equal(identity(previous), identity(next)), 'fair_epoch_changed', 'Room policy and game epoch are immutable; rematches need a new server epoch');
  validateResultMetadata(previous, next);
  const oldHistory = previous.history;
  const newHistory = next.history;
  const oldRolls = oldHistory.filter(isRoll);
  const newRolls = newHistory.filter(isRoll);
  const rollDelta = newRolls.length - oldRolls.length;
  requireThat((rollDelta === 0 || rollDelta === 1) && equal(newRolls.slice(rollDelta), oldRolls)
    && (!rollDelta || (options.issuedProof && equal(newRolls[0].fairDiceProof, options.issuedProof))),
  'fair_roll_history_changed', 'An issued roll cannot be changed, deleted or reordered');

  const delta = newHistory.length - oldHistory.length;
  if (options.pending) {
    requireThat(delta === 0 && equal(oldHistory, newHistory)
      && equal(positionOf(previous), positionOf(next)), 'fair_request_pending', 'Gameplay is locked while its future dice request is pending');
    return true;
  }
  if (delta >= 0) {
    requireThat(equal(newHistory.slice(delta), oldHistory), 'fair_history_changed', 'Existing gameplay history is immutable');
    const additions = newHistory.slice(0, delta);
    requireThat(additions.filter(isRoll).length <= 1, 'fair_roll_phase', 'Only one reserved roll may be applied');
    const expected = clone(previous);
    for (const event of additions.slice().reverse()) appendEvent(expected, event, {
      ...options, openingProofOnObject: Boolean(next.openingRoll?.fairDiceProof),
    });
    requireThat(matchesLawfulPhase(expected, next), 'fair_position_mismatch', 'Proposed board does not follow the published rules');
    return true;
  }
  const removed = oldHistory.slice(0, -delta);
  requireThat(previous.phase === 'move' && next.phase === 'move' && previous.turn === next.turn
    && !previous.winner && removed.every(isMove) && equal(oldHistory.slice(-delta), newHistory),
  'fair_undo_forbidden', 'Undo may remove only moves from the current, uncompleted turn');
  authorizeMove(previous, options);
  const replay = replayForUndo(previous, next, options);
  requireThat(equal(coreWithoutResultMetadata(replay), coreWithoutResultMetadata(next)),
    'fair_position_mismatch', 'Undo board does not match the authenticated turn history');
  return true;
}

// A fresh board is a separate privileged coordinator operation. Merely clearing
// history via validateTransition never creates a new roll allowance/epoch.
function validateNewGame(previous, next, options = {}) {
  shape(previous);
  shape(next);
  requireThat(COLORS.has(options.actorColor), 'fair_actor_forbidden', 'An authenticated room participant is required');
  requireThat(previous.winner && previous.phase === 'over', 'fair_rematch_forbidden', 'A live game cannot be reset');
  const sameRoom = ['variant', 'roomCode', 'mode'];
  requireThat(equal(pick(previous, sameRoom), pick(next, sameRoom)) && equal(botIdentity(previous), botIdentity(next)),
    'fair_epoch_changed', 'Rematch cannot change room identity or physical player color');
  requireThat(equal(previous.fairDicePolicy, next.fairDicePolicy)
    && equal(pick(previous.fairDice, ['protocol', 'required', 'policyVersion']), pick(next.fairDice, ['protocol', 'required', 'policyVersion'])),
    'fair_epoch_changed', 'Rematch cannot disable the room dice policy');
  requireThat(next.startedAt > previous.startedAt, 'fair_epoch_changed', 'A rematch needs a fresh game timestamp');
  const initial = clone(rules.initialState(next.variant));
  Object.assign(initial, identity(next));
  requireThat(equal(coreWithoutResultMetadata(initial), coreWithoutResultMetadata(next)) && next.finishedAt === null,
    'fair_initial_invalid', 'Rematch must begin with the published initial board');
  const carry = clone(previous.matchScore);
  if (carry.recordedWinner !== previous.winner) carry[previous.winner] += 1;
  carry.recordedWinner = null;
  const finishedMatch = carry.white >= carry.target || carry.dark >= carry.target;
  const restart = { white: 0, dark: 0, target: carry.target, recordedWinner: null };
  requireThat(equal(next.matchScore, carry) || (finishedMatch && options.resetMatch === true && equal(next.matchScore, restart)),
    'fair_match_score_invalid', 'Rematch must preserve the legitimately recorded match score');
  return true;
}

module.exports = { rules, positionOf, positionHash, validateTransition, validateNewGame };
