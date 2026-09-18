#!/usr/bin/env node
'use strict';

// Run ONLY against at most four disposable rooms explicitly seeded by the deployment
// operator. This client never creates accounts, sets policy, or uses a real
// service-role credential. All writes go through the public authenticated API.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { randomBytes } = require('node:crypto');
const FairDice = require('../fair-dice.js');
const { rules, positionOf, validateTransition } = require('../lib/fair-dice-rules.js');
const { SupabaseFairDiceStore } = require('../lib/fair-dice-supabase-store.js');

const CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const samePosition = (a, b) => isDeepStrictEqual(clone(positionOf(a)), clone(positionOf(b)));
function failure(code) { return Object.assign(new Error('Controlled fair-dice canary failed.'), { code }); }
function check(value, code) { if (!value) throw failure(code); }
function safeCode(error) { return /^[A-Za-z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'CANARY_FAILED'; }

function endpoint(value, prefix = false) {
  const parsed = new URL(value);
  check(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash,
    'CANARY_HTTPS_REQUIRED');
  const base = parsed.href.replace(/\/$/, '');
  if (prefix) check(parsed.pathname.replace(/\/$/, '') === '/fair-dice/v1', 'CANARY_ENDPOINT_INVALID');
  return base;
}

function guestHeaders(source) {
  check(source && typeof source === 'object' && !Array.isArray(source), 'CANARY_HEADERS_INVALID');
  check(Object.keys(source).every(name => ['authorization', 'x-guest-id', 'x-guest-proof'].includes(name)), 'CANARY_HEADERS_INVALID');
  const result = {};
  for (const [name, value] of Object.entries(source)) {
    check(typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\r\n]/.test(value), 'CANARY_HEADERS_INVALID');
    result[name] = value;
  }
  check(result['x-guest-id'] && result['x-guest-proof'], 'CANARY_GUEST_FIXTURE_REQUIRED');
  check(!result.authorization || /^Bearer [A-Za-z0-9._-]+$/.test(result.authorization), 'CANARY_HEADERS_INVALID');
  return result;
}

function fixturesOf(fixtures) {
  check(Array.isArray(fixtures) && fixtures.length > 0 && fixtures.length <= 4, 'CANARY_FIXTURES_INVALID');
  const seen = new Set();
  return fixtures.map(fixture => {
    check(fixture && Object.keys(fixture).every(key => ['code', 'kind', 'headers', 'opponentHeaders'].includes(key))
      && CODE.test(fixture.code) && ['bot', 'remote'].includes(fixture.kind) && !seen.has(fixture.code), 'CANARY_FIXTURES_INVALID');
    seen.add(fixture.code);
    const headers = guestHeaders(fixture.headers);
    const opponentHeaders = fixture.opponentHeaders ? guestHeaders(fixture.opponentHeaders) : null;
    check(fixture.kind === 'bot' ? !opponentHeaders : opponentHeaders
      && opponentHeaders['x-guest-id'] !== headers['x-guest-id'], 'CANARY_FIXTURES_INVALID');
    return { code: fixture.code, kind: fixture.kind, headers, opponentHeaders };
  });
}

function readFixtureFile(file) {
  check(typeof file === 'string' && path.isAbsolute(file), 'CANARY_FIXTURE_FILE_INVALID');
  const metadata = fs.lstatSync(file);
  check(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0
    && metadata.size <= 65536 && metadata.uid === process.getuid?.(), 'CANARY_FIXTURE_FILE_INVALID');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let payload;
  try {
    const opened = fs.fstatSync(descriptor);
    check(opened.isFile() && opened.ino === metadata.ino && opened.dev === metadata.dev
      && (opened.mode & 0o077) === 0 && opened.size <= 65536 && opened.uid === process.getuid?.(), 'CANARY_FIXTURE_FILE_INVALID');
    payload = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally { fs.closeSync(descriptor); }
  check(payload && Object.keys(payload).every(key => ['backendUrl', 'anonKey', 'fixtures'].includes(key))
    && typeof payload.anonKey === 'string' && payload.anonKey.length > 0, 'CANARY_FIXTURE_FILE_INVALID');
  return { backendUrl: endpoint(payload.backendUrl), anonKey: payload.anonKey, fixtures: fixturesOf(payload.fixtures) };
}

async function runCanary({ serviceUrl, publicKey, fixtures, readRoom, fetchImpl = globalThis.fetch,
  now = Date.now, pollIntervalMs = 750, timeoutMs = 90000, report = () => {}, protocol = FairDice.PROTOCOL } = {}) {
  check([FairDice.PROTOCOL, FairDice.SYSTEM_PROTOCOL].includes(protocol), 'CANARY_PROTOCOL_INVALID');
  const base = endpoint(serviceUrl, true);
  check(/^[0-9a-f]{64}$/.test(publicKey || '') && typeof readRoom === 'function' && typeof fetchImpl === 'function', 'CANARY_CONFIG_INVALID');
  check(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 1 && pollIntervalMs <= 5000
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000, 'CANARY_CONFIG_INVALID');
  const controlled = fixturesOf(fixtures);
  const results = [];

  async function api(route, body, headers, method = 'POST') {
    const response = await fetchImpl(`${base}/${route}`, {
      method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(12000),
      headers: { ...(headers || {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    check(Buffer.byteLength(text, 'utf8') <= 4 * 1024 * 1024, 'CANARY_RESPONSE_INVALID');
    let json;
    try { json = JSON.parse(text); } catch { throw failure('CANARY_RESPONSE_INVALID'); }
    return { status: response.status, ok: response.ok, body: json };
  }

  async function requireApi(route, body, headers, method) {
    const reply = await api(route, body, headers, method);
    check(reply.ok, `CANARY_${route.toUpperCase()}_REJECTED`);
    return reply.body;
  }

  const health = await requireApi('health', null, null, 'GET');
  check(health.ok && health.publicKey === publicKey && health.protocol === FairDice.PROTOCOL
    && health.chainHash === FairDice.CHAIN.hash
    && (protocol === FairDice.PROTOCOL || health.supportedProtocols?.includes(protocol)), 'CANARY_PIN_MISMATCH');

  for (const fixture of controlled) {
    const { code, headers, opponentHeaders, kind } = fixture;
    let room = await readRoom(code, headers);
    check(room?.roomCode === code && room.fairDiceRequired && room.status === 'joined'
      && room.state?.phase === 'opening' && room.actor?.ownsHost
      && room.actor.bot === (kind === 'bot'), 'CANARY_NOT_DISPOSABLE_INITIAL_ROOM');
    validateTransition(null, room.state, { actorColor: room.actor.actorColor, botOwner: room.actor.bot, allowInitial: true });
    const ownerColor = room.actor.actorColor;
    const reports = [];
    const rejected = [];
    let cleanupNeeded = true;

    function actorFor(color) { return kind === 'bot' || color === ownerColor ? headers : opponentHeaders; }

    async function refresh() { room = await readRoom(code, headers); return room; }

    async function rejectedAttempt(label, route, body, actor = headers) {
      const before = await refresh();
      const reply = await api(route, body, actor);
      check(reply.status >= 400 && reply.status < 500, 'CANARY_TAMPER_ACCEPTED');
      const after = await refresh();
      check(before.version === after.version && before.gameId === after.gameId
        && samePosition(before.state, after.state), 'CANARY_TAMPER_MUTATED_ROOM');
      const codeValue = safeCode({ code: reply.body?.code });
      rejected.push({ test: label, status: reply.status, code: codeValue });
      report({ event: 'rejected', room: code, test: label, status: reply.status, code: codeValue });
    }

    async function save(next, actor = headers) {
      const saved = await requireApi('state', { code, state: next, version: room.version }, actor);
      check(saved.ok && Number.isSafeInteger(saved.version), 'CANARY_STATE_INVALID');
      await refresh();
      check(samePosition(room.state, next), 'CANARY_STATE_NOT_PERSISTED');
      return saved;
    }

    async function roll(label, { testPending = false, testTamper = false } = {}) {
      await refresh();
      const color = label === 'opening' ? 'none' : room.state.turn;
      const actor = label === 'opening' ? headers : actorFor(color);
      const context = { roomCode: code, gameId: room.gameId, variant: room.variant, label, color };
      const started = now();
      const reserves = await Promise.all([0, 1].map(() => requireApi('reserve', { code, label, color }, actor)));
      const receipt = reserves[0].receipt || reserves[0];
      const repeated = reserves[1].receipt || reserves[1];
      check(receipt.request.id === repeated.request.id && receipt.request.nonce === repeated.request.nonce,
        'CANARY_DUPLICATE_RESERVATION');
      check(FairDice.verifyReservation(receipt, publicKey, context), 'CANARY_RECEIPT_INVALID');
      report({ event: 'reserved', room: code, gameId: receipt.request.gameId, requestId: receipt.request.id,
        nonce: receipt.request.nonce, round: receipt.request.round });
      if (testPending) {
        const forged = clone(room.state);
        const point = Object.keys(forged.points)[0];
        const destination = Number(point) === 1 ? 2 : 1;
        forged.points[point].count -= 1;
        forged.points[destination] = { color: room.state.points[point].color, count: 1 };
        await rejectedAttempt('pending-board-change', 'state', { code, state: forged, version: room.version }, actor);
        const metadata = clone(room.state);
        metadata.turnClock.white += 1;
        const checkpoint = await requireApi('state', { code, state: metadata, version: room.version }, actor);
        check(checkpoint.deferred === true && checkpoint.version === room.version, 'CANARY_PENDING_CHECKPOINT_MUTATED');
      }
      let issued;
      let clientSeed;
      let preparedMs;
      let verifiedMs;
      if (protocol === FairDice.SYSTEM_PROTOCOL) {
        check(receipt.request.commitment && receipt.request.round === undefined, 'CANARY_PROTOCOL_INVALID');
        // Controlled test client only, after authentic receipt. Production
        // human clients obtain this contribution from their browser CSPRNG.
        clientSeed = reserves[0].clientSeed || randomBytes(32).toString('hex');
        const ready = await requireApi('challenge', { code, requestId: receipt.request.id,
          requestHash: receipt.requestHash, clientSeed }, actor);
        issued = ready.proof;
        preparedMs = now() - started;
        await FairDice.verifyProof(issued, { publicKey, context: receipt.request, clientSeed });
        verifiedMs = now() - started;
        const same = await requireApi('challenge', { code, requestId: receipt.request.id,
          requestHash: receipt.requestHash, clientSeed }, actor);
        check(isDeepStrictEqual(same.proof, issued), 'CANARY_DUPLICATE_CHALLENGE');
        const otherSeed = (clientSeed[0] === '0' ? '1' : '0') + clientSeed.slice(1);
        await rejectedAttempt('replace-client-seed', 'challenge', { code, requestId: receipt.request.id,
          requestHash: receipt.requestHash, clientSeed: otherSeed }, actor);
      }
      while (now() - started < timeoutMs) {
        if (issued) break;
        const result = await requireApi('result', { code, requestId: receipt.request.id }, actor);
        if (result.proof) { issued = result.proof; break; }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
      check(issued, 'CANARY_BEACON_TIMEOUT');
      const verified = await FairDice.verifyProof(issued, { publicKey, context: receipt.request, ...(clientSeed ? { clientSeed } : {}) });
      check((protocol === FairDice.SYSTEM_PROTOCOL ? verified.commitmentVerified : verified.sourceVerified)
        && verified.reservationVerified && issued.protocol === protocol, 'CANARY_PROOF_INVALID');
      const entry = { event: 'verified', room: code, gameId: issued.request.gameId,
        requestId: issued.request.id, nonce: issued.request.nonce, round: issued.request.round,
        dice: issued.dice, sha256: issued.sha256, elapsedMs: now() - started,
        ...(protocol === FairDice.SYSTEM_PROTOCOL ? { preparedMs, verifiedMs, proof: issued,
          timingScope: testPending ? 'includes-pending-negative-tests' : 'reserve-challenge-local-verification' } : {}),
        protocol, sourceVerified: verified.sourceVerified === true, commitmentVerified: verified.commitmentVerified === true,
        reservationVerified: true };
      reports.push(entry);
      report(entry);
      await refresh();
      const next = clone(room.state);
      if (label === 'opening') {
        rules.decideOpeningRoll(next, { id: 'white', color: 'white', die: issued.dice[0] },
          { id: 'dark', color: 'dark', die: issued.dice[1] });
        Object.assign(next.openingRoll, { sha256: issued.sha256, sha256Input: issued.sha256Input,
          rerolls: issued.rerolls, fairDiceProof: clone(issued) });
        Object.assign(next.history[0], { sha256: issued.sha256, sha256Input: issued.sha256Input,
          rerolls: issued.rerolls, fairDiceProof: clone(issued) });
      } else {
        const [a, b] = issued.dice;
        rules.applyRoll(next, a === b ? [a, a, a, a] : [a, b]);
        next.history.unshift({ color, roll: issued.dice.join(':'),
          openingMove: Boolean(next.openingRoll) && !next.history.some(event => event.openingMove),
          sha256: issued.sha256, sha256Input: issued.sha256Input, fairDiceProof: clone(issued),
          at: new Date(now()).toISOString() });
      }
      if (testTamper) {
        const forged = clone(next);
        forged.history[0].fairDiceProof.dice[0] = (issued.dice[0] % 6) + 1;
        await rejectedAttempt('forged-proof-dice', 'state', { code, state: forged, version: room.version }, actor);
      }
      await save(next, actor);
      return issued;
    }

    try {
      await requireApi('presence', { code }, headers);
      if (opponentHeaders) await requireApi('presence', { code }, opponentHeaders);
      await refresh();
      const first = await roll('opening', { testPending: true, testTamper: true });
      const ready = clone(room.state);
      rules.startOpeningTurn(ready);
      await save(ready);
      for (let turn = 0; turn < 2; turn += 1) {
        await roll('roll', { testTamper: turn === 0 });
        const actor = actorFor(room.state.turn);
        if (turn === 0) {
          const discarded = clone(room.state);
          rules.endTurn(discarded);
          await rejectedAttempt('discard-known-roll', 'state', { code, state: discarded, version: room.version }, actor);
          await rejectedAttempt('reroll-known-dice', 'reserve', { code, label: 'roll', color: room.state.turn }, actor);
        }
        const moved = clone(room.state);
        const moves = rules.bestMoveSequences(clone(moved), moved.turn)[0] || [];
        for (const move of moves) check(rules.applyMove(moved, move.from, move.die, { autoEnd: false }), 'CANARY_MOVE_INVALID');
        check(!moved.dice.length || !rules.hasAnyMoves(clone(moved)), 'CANARY_MOVES_INCOMPLETE');
        rules.endTurn(moved);
        await save(moved, actor);
      }
      const fakeResign = clone(room.state);
      const foreignColor = rules.opponentOf(ownerColor);
      fakeResign.dice = [];
      fakeResign.rolled = [];
      fakeResign.winner = ownerColor;
      fakeResign.phase = 'over';
      fakeResign.finishedAt = now();
      fakeResign.history.unshift({ resign: true, color: foreignColor, winnerColor: ownerColor, at: new Date(now()).toISOString() });
      await rejectedAttempt('opponent-resignation', 'state', { code, state: fakeResign, version: room.version });
      const terminal = await requireApi('leave', { code }, headers);
      check(terminal.ok && terminal.removed && terminal.state?.phase === 'over'
        && terminal.state.history[0]?.leave && terminal.state.history[0].color === ownerColor, 'CANARY_LEAVE_INVALID');
      await refresh();
      const oldEpoch = room.gameId;
      const rematch = Object.assign(clone(rules.initialState(room.variant)), {
        mode: room.state.mode, roomCode: code, startedAt: Math.max(now(), room.state.startedAt + 1),
        ...(room.state.mode === 'bot' ? { analysis: clone(room.state.analysis || {}) } : {}),
        ...(room.state.fairDicePolicy !== undefined ? { fairDicePolicy: room.state.fairDicePolicy } : {}),
        ...(room.state.fairDice ? { fairDice: { protocol: room.state.fairDice.protocol,
          required: room.state.fairDice.required, policyVersion: room.state.fairDice.policyVersion } } : {}),
        matchScore: { ...clone(room.state.matchScore), recordedWinner: null },
      });
      await save(rematch);
      check(room.gameId !== oldEpoch, 'CANARY_EPOCH_NOT_RESET');
      await rejectedAttempt('old-epoch-proof-result', 'result', { code, requestId: first.request.id });
      const second = await roll('opening');
      check(second.request.nonce === 1 && second.request.gameId !== first.request.gameId
        && second.request.id !== first.request.id, 'CANARY_REMATCH_NONCE_INVALID');
      results.push({ room: code, kind, rolls: reports, rejected, rematch: true });
    } finally {
      if (cleanupNeeded) {
        const cleanup = await requireApi('leave', { code }, headers);
        const ended = await readRoom(code, headers);
        check(cleanup.ok && cleanup.removed && ended.state?.phase === 'over' && ended.status === 'over', 'CANARY_CLEANUP_FAILED');
        cleanupNeeded = false;
        report({ event: 'cleaned', room: code, phase: ended.state.phase, winner: ended.state.winner,
          ownLeave: ended.state.history[0]?.leave === true && ended.state.history[0].color === ownerColor });
      }
    }
  }
  return { ok: true, fixtures: results };
}

function parseArguments(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    check(['--url', '--public-key', '--fixture-file', '--publishable-key', '--protocol'].includes(argv[index]) && argv[index + 1]
      && !Object.hasOwn(flags, argv[index]), 'CANARY_ARGUMENTS_INVALID');
    flags[argv[index]] = argv[index + 1];
  }
  check(['--url', '--public-key', '--fixture-file'].every(name => Object.hasOwn(flags, name)), 'CANARY_ARGUMENTS_INVALID');
  check(!Object.hasOwn(flags, '--publishable-key')
    || /^sb_publishable_[A-Za-z0-9_-]{16,128}$/.test(flags['--publishable-key']), 'CANARY_PUBLISHABLE_KEY_INVALID');
  check(!Object.hasOwn(flags, '--protocol') || [FairDice.PROTOCOL, FairDice.SYSTEM_PROTOCOL].includes(flags['--protocol']), 'CANARY_PROTOCOL_INVALID');
  return flags;
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArguments(argv);
  const config = readFixtureFile(flags['--fixture-file']);
  const store = new SupabaseFairDiceStore({ url: config.backendUrl, anonKey: config.anonKey,
    publishableKey: flags['--publishable-key'],
    serviceRoleKey: 'unused-client-canary-do-not-authorize' });
  const report = result => process.stdout.write(JSON.stringify(result) + '\n');
  const result = await runCanary({ serviceUrl: flags['--url'], publicKey: flags['--public-key'], fixtures: config.fixtures,
    readRoom: (code, headers) => store.getRoom(code, headers), report,
    protocol: flags['--protocol'] || FairDice.PROTOCOL });
  report({ ok: result.ok, rooms: result.fixtures.map(fixture => fixture.room), completed: result.fixtures.length });
}

if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, error: safeCode(error) }) + '\n');
  process.exitCode = 1;
});

module.exports = { runCanary, main, parseArguments, readFixtureFile, fixturesOf, safeCode };
