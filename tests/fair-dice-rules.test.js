'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rules, positionOf, positionHash, validateTransition, validateNewGame } = require('../lib/fair-dice-rules.js');

const clone = value => JSON.parse(JSON.stringify(value));
const AT = '2026-09-18T00:00:00.000Z';
const GAME_ID = 'eb9acac4-7621-4106-976f-08dd288b6585';

function initial(variant = 'long', mode = 'remote') {
  return Object.assign(clone(rules.initialState(variant)), {
    startedAt: 1789689600000, roomCode: 'TEST-ROOM', mode, gameId: GAME_ID,
  });
}

function proofFor(state, dice, label = 'roll') {
  const nonce = state.history.filter(event => event.fairDiceProof).length + 1;
  return {
    protocol: 'drand-quicknet-v1',
    request: {
      id: 'issued-' + nonce, roomCode: state.roomCode, gameId: state.gameId,
      nonce, label, color: label === 'opening' ? 'none' : state.turn,
      variant: state.variant, round: 1000 + nonce, createdAt: AT,
      positionHash: 'c'.repeat(64),
    },
    dice, sha256: String(nonce + 1).padStart(64, '0'),
    sha256Input: 'canonical-beacon-input-' + nonce, rerolls: 0,
  };
}

function opening(state, dice = [6, 1]) {
  const next = clone(state);
  const proof = proofFor(state, dice, 'opening');
  rules.decideOpeningRoll(next, { id: 'white', name: 'White', color: 'white', die: dice[0] },
    { id: 'dark', name: 'Dark', color: 'dark', die: dice[1] });
  Object.assign(next.openingRoll, { sha256: proof.sha256, sha256Input: proof.sha256Input,
    rerolls: proof.rerolls, fairDiceProof: clone(proof) });
  Object.assign(next.history[0], { sha256: proof.sha256, sha256Input: proof.sha256Input,
    rerolls: proof.rerolls, fairDiceProof: clone(proof), at: AT });
  return { next, proof };
}

function roll(state, dice = [2, 4]) {
  const next = clone(state);
  const proof = proofFor(state, dice);
  rules.applyRoll(next, dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : dice);
  next.history.unshift({ color: state.turn, roll: dice.join(':'),
    openingMove: Boolean(state.openingRoll) && !state.history.some(event => event.openingMove),
    sha256: proof.sha256, sha256Input: proof.sha256Input, fairDiceProof: clone(proof), at: AT });
  return { next, proof };
}

function ready(variant = 'long', mode = 'remote') {
  const opened = opening(initial(variant, mode)).next;
  rules.startOpeningTurn(opened);
  return opened;
}

function moved(state, move = rules.legalNextMoves(clone(state))[0], autoEnd = false) {
  const next = clone(state);
  assert.equal(rules.applyMove(next, move.from, move.die, { autoEnd }), true);
  return next;
}

function assertCode(fn, code) {
  assert.throws(fn, error => error.code === code, 'Expected error code ' + code);
}

test('rules replay cannot silently call a RNG', () => {
  assertCode(() => rules.rollDice(), 'fair_random_forbidden');
  assertCode(() => rules.decideOpeningRoll(initial(), { die: 2 }, { die: 2 }), 'fair_random_forbidden');
});

test('initialization requires the rules board and explicit coordinator authority', () => {
  for (const variant of ['long', 'short']) {
    const state = initial(variant);
    assert.equal(validateTransition(null, state, { actorColor: 'white', allowInitial: true }), true);
    assertCode(() => validateTransition(null, state, { actorColor: 'white' }), 'fair_initial_forbidden');
    const forged = clone(state);
    forged.phase = 'roll';
    forged.turn = 'white';
    assertCode(() => validateTransition(null, forged, { actorColor: 'white', allowInitial: true }), 'fair_initial_invalid');
  }
});

test('internal canonical position ignores clocks, names and analysis but binds legal state', () => {
  const state = ready();
  const metadata = clone(state);
  metadata.turnClock = { white: 900, dark: 40, active: 'white', startedAt: Date.now() };
  metadata.analysis = { arbitrary: 'metadata' };
  metadata.openingRoll.host.name = 'Renamed';
  metadata.history[0].hostName = 'Renamed';
  assert.equal(positionHash(metadata), positionHash(state));
  const reordered = clone(state);
  reordered.points = Object.fromEntries(Object.entries(reordered.points).reverse());
  assert.equal(positionHash(reordered), positionHash(state));
  const changed = clone(state);
  changed.matchScore.target = 3;
  assert.notEqual(positionHash(changed), positionHash(state));
  assert.equal(positionOf(state).openingRoll.host.name, undefined);
});

test('dark bot initialization preserves the actual minimal physical-color identity', () => {
  for (const variant of ['long', 'short']) {
    const state = initial(variant, 'bot');
    state.analysis = { playerColor: 'dark', updatedAt: AT, botMemory: { decisions: [] } };
    assert.equal(validateTransition(null, state, { actorColor: 'dark', botOwner: true, allowInitial: true }), true);
    assert.deepEqual(positionOf(state).analysis, { playerColor: 'dark' });
  }
});

test('bot physical-color identity cannot flip or disappear, while analysis timestamps remain metadata', () => {
  const state = ready('long', 'bot');
  state.analysis = { playerColor: 'dark', updatedAt: AT };
  const metadata = clone(state);
  metadata.analysis.updatedAt = '2026-09-18T00:01:00.000Z';
  metadata.analysis.botMemory = { decisions: [{ metadata: true }] };
  metadata.turnClock.white = 33;
  assert.equal(positionHash(metadata), positionHash(state));
  assert.equal(validateTransition(state, metadata, { actorColor: 'dark', botOwner: true }), true);
  assert.equal(validateTransition(state, metadata, { actorColor: 'dark', botOwner: true, pending: true }), true);
  const changed = clone(state);
  changed.analysis.playerColor = 'white';
  assert.notEqual(positionHash(changed), positionHash(state));
  assertCode(() => validateTransition(state, changed, { actorColor: 'dark', botOwner: true }), 'fair_epoch_changed');
  const missing = clone(state);
  delete missing.analysis.playerColor;
  assertCode(() => validateTransition(state, missing, { actorColor: 'dark', botOwner: true, pending: true }), 'fair_epoch_changed');
  const invalid = clone(state);
  invalid.analysis.playerColor = 'spectator';
  assertCode(() => validateTransition(state, invalid, { actorColor: 'dark', botOwner: true }), 'fair_invalid_state');
});

test('remote payload may remove presentation playerColor without changing legal identity', () => {
  const state = ready();
  state.playerColor = 'white';
  const payload = clone(state);
  delete payload.playerColor;
  payload.analysis = { updatedAt: AT };
  assert.equal(positionHash(state), positionHash(payload));
  assert.equal(validateTransition(state, payload, { actorColor: 'white' }), true);
});

test('opening uses only its issued two different dice, then transitions separately to roll', () => {
  const state = initial();
  const { next, proof } = opening(state);
  assert.equal(validateTransition(state, next, { actorColor: 'white', issuedProof: proof }), true);
  const started = clone(next);
  rules.startOpeningTurn(started);
  assert.equal(validateTransition(next, started, { actorColor: 'dark' }), true);
  const forged = clone(next);
  forged.openingRoll.guest.die = 5;
  assertCode(() => validateTransition(state, forged, { actorColor: 'white', issuedProof: proof }), 'fair_position_mismatch');
  assertCode(() => validateTransition(state, next, { actorColor: 'dark', issuedProof: proof }), 'fair_actor_forbidden');
});

test('full issued proof and optional exact SQL snapshot commitment are mandatory', () => {
  const state = ready();
  const { next, proof } = roll(state);
  assert.equal(validateTransition(state, next, { actorColor: 'white', issuedProof: proof, serverPositionHash: 'c'.repeat(64) }), true);
  assertCode(() => validateTransition(state, next, { actorColor: 'white', issuedProof: proof, serverPositionHash: 'd'.repeat(64) }), 'fair_proof_context');
  const forged = clone(next);
  forged.history[0].fairDiceProof.dice = [6, 6];
  assertCode(() => validateTransition(state, forged, { actorColor: 'white', issuedProof: proof }), 'fair_roll_history_changed');
  assertCode(() => validateTransition(state, next, { actorColor: 'white' }), 'fair_roll_history_changed');
  const wrongNonce = clone(proof);
  wrongNonce.request.nonce += 1;
  const invalid = clone(next);
  invalid.history[0].fairDiceProof = wrongNonce;
  assertCode(() => validateTransition(state, invalid, { actorColor: 'white', issuedProof: wrongNonce }), 'fair_proof_nonce');
});

test('ordinary doubles remain two physical dice and four legal moves', () => {
  const state = ready();
  const { next, proof } = roll(state, [3, 3]);
  assert.deepEqual(next.dice, [3, 3, 3, 3]);
  assert.equal(next.history[0].roll, '3:3');
  assert.equal(validateTransition(state, next, { actorColor: 'white', issuedProof: proof }), true);
});

test('a player cannot discard a losing roll, clear its history, change turns or reset the epoch', () => {
  const state = roll(ready()).next;
  const discarded = clone(state);
  rules.endTurn(discarded);
  assertCode(() => validateTransition(state, discarded, { actorColor: 'white' }), 'fair_position_mismatch');
  const reroll = clone(state);
  reroll.dice = [];
  reroll.rolled = [];
  reroll.phase = 'roll';
  assertCode(() => validateTransition(state, reroll, { actorColor: 'white' }), 'fair_position_mismatch');
  const forgotten = initial();
  assertCode(() => validateTransition(state, forgotten, { actorColor: 'white' }), 'fair_roll_history_changed');
  const changedEpoch = clone(state);
  changedEpoch.startedAt += 1;
  assertCode(() => validateTransition(state, changedEpoch, { actorColor: 'white' }), 'fair_epoch_changed');
});

test('metadata checkpoints do not unlock a pending request', () => {
  const state = ready();
  const checkpoint = clone(state);
  checkpoint.turnClock.white = 33;
  checkpoint.analysis = { version: 35 };
  assert.equal(validateTransition(state, checkpoint, { actorColor: 'white', pending: true }), true);
  const { next, proof } = roll(state);
  assertCode(() => validateTransition(state, next, { actorColor: 'white', pending: true, issuedProof: proof }), 'fair_request_pending');
});

test('legal moves and batches replay exact destinations and dice consumption', () => {
  for (const variant of ['long', 'short']) {
    const state = roll(ready(variant)).next;
    const sequence = rules.bestMoveSequences(clone(state), state.turn)[0];
    let next = clone(state);
    for (const move of sequence) next = moved(next, move);
    assert.equal(validateTransition(state, next, { actorColor: 'white' }), true);
    const finished = clone(next);
    rules.endTurn(finished);
    assert.equal(validateTransition(state, finished, { actorColor: 'white' }), true);
    const one = moved(state);
    assertCode(() => validateTransition(state, one, { actorColor: 'dark' }), 'fair_actor_forbidden');
    const forged = clone(one);
    forged.history[0].to = 99;
    assertCode(() => validateTransition(state, forged, { actorColor: 'white' }), 'fair_illegal_move');
  }
});

test('bot owner can replay both sides only in a server-identified bot room', () => {
  const botState = roll(ready('long', 'bot')).next;
  const botMove = moved(botState);
  assert.equal(validateTransition(botState, botMove, { actorColor: 'dark', botOwner: true }), true);
  const remoteState = roll(ready()).next;
  assertCode(() => validateTransition(remoteState, moved(remoteState), { actorColor: 'dark', botOwner: true }), 'fair_actor_forbidden');
});

test('auto-ended last move is lawful but an opponent cannot fabricate moves', () => {
  const state = roll(ready(), [2, 4]).next;
  const sequence = rules.bestMoveSequences(clone(state), state.turn)[0];
  let beforeLast = state;
  for (const move of sequence.slice(0, -1)) beforeLast = moved(beforeLast, move);
  const next = moved(beforeLast, sequence.at(-1), true);
  assert.equal(validateTransition(beforeLast, next, { actorColor: 'white' }), true);
  assertCode(() => validateTransition(beforeLast, next, { actorColor: 'dark' }), 'fair_actor_forbidden');
});

test('blocked bar dice can be finalized by either participant, never replaced', () => {
  const state = initial('short');
  state.points = Object.fromEntries([19, 20, 21, 22, 23, 24].map(point => [point, { color: 'dark', count: 2 }]));
  state.bar.white = 15;
  state.off.dark = 3;
  state.turn = 'white';
  state.phase = 'move';
  state.dice = [2, 4];
  state.rolled = [2, 4];
  const next = clone(state);
  assert.equal(rules.hasAnyMoves(clone(state)), false);
  rules.endTurn(next);
  assert.equal(validateTransition(state, next, { actorColor: 'dark' }), true);
});

test('undo reconstructs only the same current turn and preserves its known roll', () => {
  const rolled = roll(ready()).next;
  const one = moved(rolled);
  const two = rules.hasAnyMoves(clone(one)) ? moved(one) : one;
  assert.equal(validateTransition(two, one, { actorColor: 'white' }), true);
  assert.equal(validateTransition(one, rolled, { actorColor: 'white' }), true);
  const alteredUndo = clone(rolled);
  alteredUndo.score.white += 1;
  assertCode(() => validateTransition(one, alteredUndo, { actorColor: 'white' }), 'fair_position_mismatch');
  assertCode(() => validateTransition(one, ready(), { actorColor: 'white' }), 'fair_roll_history_changed');
  const completed = clone(two);
  while (rules.hasAnyMoves(clone(completed)) && completed.dice.length) {
    const move = rules.legalNextMoves(clone(completed))[0];
    rules.applyMove(completed, move.from, move.die, { autoEnd: false });
  }
  rules.endTurn(completed);
  assertCode(() => validateTransition(completed, rolled, { actorColor: 'white' }), 'fair_undo_forbidden');
});

for (const variant of ['long', 'short']) {
  for (const mode of ['bot', 'remote']) {
    test(`system-csprng ${variant} ${mode}: first checker undo works without snapshot protocol metadata (QM5N-CCQG)`, () => {
      const rolled = roll(ready(variant, mode)).next;
      assert.equal(rolled.fairDice, undefined);
      for (const event of rolled.history) {
        if (event.fairDiceProof) event.fairDiceProof.protocol = 'system-csprng-v1';
      }
      rolled.openingRoll.fairDiceProof.protocol = 'system-csprng-v1';
      const one = moved(rolled);
      const options = { actorColor: 'white', botOwner: mode === 'bot', fairDiceProtocol: 'system-csprng-v1' };
      assert.equal(validateTransition(one, rolled, options), true);
      assert.equal(validateTransition(one, rolled, { actorColor: 'white', botOwner: mode === 'bot' }), true,
        'standalone replay derives the protocol from confirmed history, not the proposed undo');
      assertCode(() => validateTransition(one, rolled, { ...options, actorColor: 'dark', botOwner: false }), 'fair_actor_forbidden');
      const changed = clone(rolled);
      changed.history[0].fairDiceProof.protocol = 'drand-quicknet-v1';
      assertCode(() => validateTransition(one, changed, options), 'fair_roll_history_changed');
      assertCode(() => validateTransition(one, rolled, { ...options, fairDiceProtocol: 'drand-quicknet-v1' }), 'fair_proof_required');
    });
  }
}

test('system-csprng long undo replays completed turns, keeps all issued proofs and rejects mixed protocols', () => {
  let state = ready('long', 'bot');
  state.analysis = { playerColor: 'white' };
  for (const event of state.history) if (event.fairDiceProof) event.fairDiceProof.protocol = 'system-csprng-v1';
  state.openingRoll.fairDiceProof.protocol = 'system-csprng-v1';
  const options = { actorColor: 'white', botOwner: true, fairDiceProtocol: 'system-csprng-v1' };
  for (const dice of [[4, 1], [6, 2], [3, 3], [2, 5]]) {
    const issued = roll(state, dice);
    issued.proof.protocol = 'system-csprng-v1';
    issued.next.history[0].fairDiceProof.protocol = 'system-csprng-v1';
    assert.equal(validateTransition(state, issued.next, { ...options, issuedProof: issued.proof }), true);
    state = issued.next;
    for (const move of rules.bestMoveSequences(clone(state), state.turn)[0]) state = moved(state, move);
    const finished = clone(state);
    rules.endTurn(finished);
    assert.equal(validateTransition(state, finished, options), true);
    state = finished;
  }
  const current = roll(state, [1, 5]).next;
  current.history[0].fairDiceProof.protocol = 'system-csprng-v1';
  const one = moved(current);
  assert.equal(validateTransition(one, current, options), true);
  const alteredBoard = clone(current);
  alteredBoard.score[current.turn] += 1;
  assertCode(() => validateTransition(one, alteredBoard, options), 'fair_position_mismatch');
  const mixedPrevious = clone(one);
  const mixedNext = clone(current);
  mixedPrevious.history.at(-1).fairDiceProof.protocol = 'drand-quicknet-v1';
  mixedNext.history.at(-1).fairDiceProof.protocol = 'drand-quicknet-v1';
  assertCode(() => validateTransition(mixedPrevious, mixedNext, options), 'fair_proof_required');
});

test('existing roll proofs and move history cannot be rewritten or reordered', () => {
  const state = moved(roll(ready()).next);
  const tampered = clone(state);
  tampered.history[1].sha256Input = 'changed';
  assertCode(() => validateTransition(state, tampered, { actorColor: 'white' }), 'fair_roll_history_changed');
  const timestamp = clone(state);
  timestamp.history[0].at = '2026-09-18T00:01:00.000Z';
  assertCode(() => validateTransition(state, timestamp, { actorColor: 'white' }), 'fair_history_changed');
});

test('undo remains deterministic after both sides have completed multiple authenticated turns', () => {
  let state = ready('short');
  for (const dice of [[2, 4], [6, 1], [3, 3], [2, 5]]) {
    const issued = roll(state, dice);
    assert.equal(validateTransition(state, issued.next, { actorColor: state.turn, issuedProof: issued.proof }), true);
    state = issued.next;
    const actorColor = state.turn;
    const sequence = rules.bestMoveSequences(clone(state), actorColor)[0];
    for (const move of sequence) {
      const next = moved(state, move);
      assert.equal(validateTransition(state, next, { actorColor }), true);
      state = next;
    }
    const next = clone(state);
    rules.endTurn(next);
    assert.equal(validateTransition(state, next, { actorColor: rules.opponentOf(actorColor) }), true);
    state = next;
  }
  const current = roll(state, [3, 2]).next;
  const one = moved(current);
  assert.equal(validateTransition(one, current, { actorColor: current.turn }), true);
  const wrongHistory = clone(current);
  const oldMove = wrongHistory.history.find(event => event.from !== undefined);
  oldMove.to = 0;
  assertCode(() => validateTransition(one, wrongHistory, { actorColor: current.turn }), 'fair_undo_forbidden');
});

test('a used request cannot be replayed as another turn even with its old physical dice', () => {
  const oldRoll = roll(ready());
  let state = oldRoll.next;
  const sequence = rules.bestMoveSequences(clone(state), state.turn)[0];
  for (const move of sequence) state = moved(state, move);
  rules.endTurn(state);
  const attempted = roll(state);
  attempted.next.history[0].fairDiceProof = clone(oldRoll.proof);
  assertCode(() => validateTransition(state, attempted.next, { actorColor: state.turn, issuedProof: oldRoll.proof }), 'fair_proof_context');
  const changedColor = clone(oldRoll.proof);
  changedColor.request.color = state.turn;
  attempted.next.history[0].fairDiceProof = changedColor;
  assertCode(() => validateTransition(state, attempted.next, { actorColor: state.turn, issuedProof: changedColor }), 'fair_proof_reused');
});

function resigned(state, loser = 'white') {
  const next = clone(state);
  next.dice = [];
  next.rolled = [];
  next.winner = rules.opponentOf(loser);
  next.resultType = null;
  next.phase = 'over';
  next.finishedAt = state.startedAt + 5000;
  next.history.unshift({ resign: true, color: loser, winnerColor: next.winner, at: AT });
  return next;
}

test('only a real actor can concede, network loss needs a separate privileged capability', () => {
  const state = roll(ready()).next;
  const next = resigned(state);
  assert.equal(validateTransition(state, next, { actorColor: 'white' }), true);
  assertCode(() => validateTransition(state, next, { actorColor: 'dark', botOwner: true }), 'fair_actor_forbidden');
  const network = clone(next);
  delete network.history[0].resign;
  network.history[0].networkLoss = true;
  network.networkLoss = { loserColor: 'white', winnerColor: 'dark', message: 'Disconnected', at: AT };
  assertCode(() => validateTransition(state, network, { actorColor: 'dark' }), 'fair_actor_forbidden');
  assert.equal(validateTransition(state, network, { actorColor: 'dark', allowNetworkLoss: true }), true);
});

test('moves cannot smuggle concession flags and network-result metadata is authoritative', () => {
  const state = roll(ready()).next;
  const next = moved(state);
  next.history[0].resign = true;
  assertCode(() => validateTransition(state, next, { actorColor: 'white' }), 'fair_history_invalid');
  const fakeNetwork = clone(state);
  fakeNetwork.networkLoss = { loserColor: 'dark', winnerColor: 'white' };
  assertCode(() => validateTransition(state, fakeNetwork, { actorColor: 'white' }), 'fair_position_mismatch');
});

test('match recording is exact, once, and cannot change target or reward the wrong player', () => {
  const state = roll(ready()).next;
  const next = resigned(state);
  next.matchScore.dark += 1;
  next.matchScore.recordedWinner = 'dark';
  assert.equal(validateTransition(state, next, { actorColor: 'white' }), true);
  assert.equal(validateTransition(next, clone(next), { actorColor: 'dark' }), true);
  const inflated = clone(next);
  inflated.matchScore.dark += 1;
  assertCode(() => validateTransition(next, inflated, { actorColor: 'dark' }), 'fair_match_score_invalid');
  const target = clone(state);
  target.matchScore.target = 3;
  assertCode(() => validateTransition(state, target, { actorColor: 'white' }), 'fair_match_score_invalid');
});

test('new game is separate, fresh, initial, preserves lawful match score and never resets a live game', () => {
  const live = roll(ready()).next;
  const previous = resigned(live);
  const next = initial();
  next.startedAt = previous.startedAt + 6000;
  next.gameId = '46acbb60-cce4-4653-a9e8-53761fa43ef6';
  next.matchScore.dark = 1;
  assert.equal(validateNewGame(previous, next, { actorColor: 'white' }), true);
  assertCode(() => validateNewGame(live, next, { actorColor: 'white' }), 'fair_rematch_forbidden');
  const reset = clone(next);
  reset.matchScore.dark = 0;
  assertCode(() => validateNewGame(previous, reset, { actorColor: 'white' }), 'fair_match_score_invalid');
  const forged = clone(next);
  forged.points[24].count -= 1;
  forged.points[23] = { color: 'white', count: 1 };
  assertCode(() => validateNewGame(previous, forged, { actorColor: 'white' }), 'fair_initial_invalid');
});

test('completed match reset requires explicit capability and never drops an unfinished match', () => {
  const previous = resigned(roll(ready()).next);
  previous.matchScore.dark = 4;
  const next = initial();
  next.startedAt = previous.startedAt + 6000;
  assert.equal(validateNewGame(previous, next, { actorColor: 'white', resetMatch: true }), true);
  assertCode(() => validateNewGame(previous, next, { actorColor: 'white' }), 'fair_match_score_invalid');
  previous.matchScore.dark = 3;
  assertCode(() => validateNewGame(previous, next, { actorColor: 'white', resetMatch: true }), 'fair_match_score_invalid');
});

test('dark bot undo and new game retain the same physical account color', () => {
  const baseline = initial('long', 'bot');
  baseline.analysis = { playerColor: 'dark', updatedAt: AT };
  const opened = opening(baseline).next;
  rules.startOpeningTurn(opened);
  const current = roll(opened).next;
  const one = moved(current);
  assert.equal(validateTransition(one, current, { actorColor: 'dark', botOwner: true }), true);
  const previous = resigned(current, 'dark');
  const next = initial('long', 'bot');
  next.analysis = { playerColor: 'dark', updatedAt: '2026-09-18T00:01:00.000Z' };
  next.startedAt = previous.startedAt + 6000;
  next.matchScore.white = 1;
  assert.equal(validateNewGame(previous, next, { actorColor: 'dark', botOwner: true }), true);
  const flipped = clone(next);
  flipped.analysis.playerColor = 'white';
  assertCode(() => validateNewGame(previous, flipped, { actorColor: 'dark', botOwner: true }), 'fair_epoch_changed');
});
