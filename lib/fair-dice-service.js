'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const FairDice = require('../fair-dice.js');
const { positionOf, validateTransition, validateNewGame } = require('./fair-dice-rules.js');

const PREFIX = '/fair-dice/v1';
const RELAYS = Object.freeze(['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh']);
const CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUTH_HEADERS = ['authorization', 'x-guest-id', 'x-guest-proof'];
const PRESENCE_STALE_MS = 30000;
const NETWORK_GRACE_MS = 120000;
const SAFE_CODES = new Set(['INVALID_ROOM_CODE', 'INVALID_REQUEST_ID', 'INVALID_CREDENTIAL', 'PLAYER_AUTH_REQUIRED',
  'INVALID_ENCODING', 'JSON_REQUIRED', 'BODY_TOO_LARGE', 'INVALID_JSON', 'INVALID_FIELDS', 'SERVICE_STOPPING',
  'INVALID_STORE', 'INVALID_SIGNING_KEY', 'INVALID_SERVICE_CONFIG', 'INVALID_ORIGIN_CONFIG', 'RATE_LIMITED',
  'BEACON_WAIT', 'BEACON_RESPONSE_INVALID', 'SOURCE_BUSY', 'INVALID_FUTURE_ROUND', 'REQUEST_CONTEXT_MISMATCH',
  'FAIR_ROOM_REQUIRED', 'INVALID_ROLL_INTENT', 'DICE_REQUEST_CANCELLED', 'DICE_REQUEST_INVALID',
  'STATE_VERSION_CONFLICT', 'TOO_MANY_DICE_REQUESTS', 'PROOF_NOT_OUTSTANDING', 'ORIGIN_NOT_ALLOWED',
  'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'INVALID_CORS_HEADERS', 'UNVALIDATED_ACTOR', 'INVALID_STATE',
  'FAIR_DICE_STORE_ERROR', 'FAIR_DICE_UNAVAILABLE', '40001', '23505', '42501', 'P0002', '22023', '23514', '55000']);

function error(code, status = 422) {
  const failure = new Error('Fair dice operation could not be completed.');
  failure.code = code;
  failure.status = status;
  return failure;
}

function requireThat(condition, code, status) {
  if (!condition) throw error(code, status);
}

function same(a, b) { return isDeepStrictEqual(a, b); }

function normalizeCode(code) {
  requireThat(typeof code === 'string' && CODE.test(code.toUpperCase()), 'INVALID_ROOM_CODE', 400);
  return code.toUpperCase();
}

function normalizeId(id) {
  requireThat(typeof id === 'string' && UUID.test(id), 'INVALID_REQUEST_ID', 400);
  return id;
}

function credentialHeaders(request) {
  const result = {};
  for (const name of AUTH_HEADERS) {
    const value = request.headers[name];
    requireThat(value === undefined || (typeof value === 'string' && value.length <= 8192 && !/[\r\n]/.test(value)), 'INVALID_CREDENTIAL', 401);
    if (value !== undefined) result[name] = value;
  }
  requireThat(!result.authorization || /^Bearer [A-Za-z0-9._-]+$/.test(result.authorization), 'INVALID_CREDENTIAL', 401);
  requireThat(Boolean(result['x-guest-id']) === Boolean(result['x-guest-proof']), 'INVALID_CREDENTIAL', 401);
  requireThat(result.authorization || result['x-guest-proof'], 'PLAYER_AUTH_REQUIRED', 401);
  return result;
}

async function readBody(request, limit) {
  requireThat(!request.headers['content-encoding'] || request.headers['content-encoding'] === 'identity', 'INVALID_ENCODING', 415);
  requireThat(/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''), 'JSON_REQUIRED', 415);
  const contentLength = request.headers['content-length'];
  requireThat(contentLength === undefined || (/^\d+$/.test(contentLength) && Number(contentLength) <= limit), 'BODY_TOO_LARGE', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw error('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error('INVALID_JSON', 400); }
  requireThat(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_JSON', 400);
  return body;
}

async function readBeaconBody(response) {
  const limit = 16384;
  const announced = response.headers?.get?.('content-length');
  requireThat(!announced || (/^\d+$/.test(announced) && Number(announced) <= limit), 'BEACON_RESPONSE_INVALID', 503);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    requireThat(Buffer.byteLength(text, 'utf8') <= limit, 'BEACON_RESPONSE_INVALID', 503);
    return text;
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw error('BEACON_RESPONSE_INVALID', 503);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function exactFields(body, fields) {
  requireThat(Object.keys(body).length === fields.length && fields.every(field => Object.hasOwn(body, field)), 'INVALID_FIELDS', 400);
}

function wait(ms, signal) {
  if (signal.aborted) return Promise.reject(error('SERVICE_STOPPING', 503));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(error('SERVICE_STOPPING', 503)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function ownConcession(previous, next, actorColor) {
  const history = next?.history;
  const event = history?.[0];
  return Boolean(previous && history && history.length === previous.history.length + 1
    && next.phase === 'over' && event?.color === actorColor
    && (event.resign === true || event.leave === true)
    && !event.networkLoss && !event.timeout
    && same(history.slice(1), previous.history));
}

function createFairDiceService({ store, signingKey, fetchImpl = globalThis.fetch,
  allowedOrigins = [], bodyLimit = 4 * 1024 * 1024, beaconTimeoutMs = 8000,
  jobDeadlineMs = 120000, retryDelayMs = 500, rateLimit = 300,
  rateWindowMs = 60000, maxJobs = 256, maxRequests = 16, now = Date.now } = {}) {
  requireThat(store && ['getRoom', 'reserve', 'getRequest', 'commitProof', 'commitState', 'resetFairGame']
    .every(name => typeof store[name] === 'function'), 'INVALID_STORE', 500);
  requireThat(typeof signingKey === 'string' && /^[0-9a-f]{64}$/.test(signingKey), 'INVALID_SIGNING_KEY', 500);
  requireThat(typeof fetchImpl === 'function' && typeof now === 'function', 'INVALID_SERVICE_CONFIG', 500);
  requireThat(Number.isSafeInteger(bodyLimit) && bodyLimit > 0 && bodyLimit <= 4 * 1024 * 1024
    && Number.isSafeInteger(beaconTimeoutMs) && beaconTimeoutMs > 0 && beaconTimeoutMs <= 30000
    && Number.isSafeInteger(jobDeadlineMs) && jobDeadlineMs > 0 && jobDeadlineMs <= 600000
    && Number.isSafeInteger(retryDelayMs) && retryDelayMs > 0 && retryDelayMs <= 10000
    && Number.isSafeInteger(rateLimit) && rateLimit > 0 && Number.isSafeInteger(rateWindowMs) && rateWindowMs > 0
    && Number.isSafeInteger(maxJobs) && maxJobs > 0 && maxJobs <= 10000
    && Number.isSafeInteger(maxRequests) && maxRequests > 0 && maxRequests <= 256, 'INVALID_SERVICE_CONFIG', 500);
  const origins = new Set(allowedOrigins.map(value => {
    const parsed = new URL(value);
    requireThat(['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value
      && !parsed.username && !parsed.password, 'INVALID_ORIGIN_CONFIG', 500);
    return value;
  }));
  const publicKey = FairDice.receiptPublicKey(signingKey);
  const jobs = new Map();
  const limits = new Map();
  const controller = new AbortController();
  let closed = false;
  let inFlight = 0;

  function checkRate(request, headers) {
    const identity = createHash('sha256').update(AUTH_HEADERS.map(name => headers[name] || '').join('|')
      + '|' + (request.socket?.remoteAddress || '')).digest('hex');
    const at = now();
    for (const [key, record] of limits) if (at >= record.until) limits.delete(key);
    const existing = limits.get(identity);
    if (!existing) {
      requireThat(limits.size < 10000, 'RATE_LIMITED', 429);
      limits.set(identity, { count: 1, until: at + rateWindowMs });
    } else {
      existing.count += 1;
      requireThat(existing.count <= rateLimit, 'RATE_LIMITED', 429);
    }
  }

  async function fetchBeacon(request) {
    for (const relay of RELAYS) {
      if (controller.signal.aborted) throw error('SERVICE_STOPPING', 503);
      const abort = new AbortController();
      const onClose = () => abort.abort();
      controller.signal.addEventListener('abort', onClose, { once: true });
      const timer = setTimeout(() => abort.abort(), beaconTimeoutMs);
      timer.unref?.();
      try {
        // Explicit immutable round only. Never request /latest or execute data
        // supplied by a client/relay; chain key and scheme are pinned locally.
        const response = await fetchImpl(`${relay}/${FairDice.CHAIN.hash}/public/${request.round}`, {
          method: 'GET', headers: { accept: 'application/json' }, signal: abort.signal,
          redirect: 'error',
        });
        requireThat(response.ok, 'BEACON_WAIT', 503);
        const text = await readBeaconBody(response);
        const beacon = JSON.parse(text);
        await FairDice.verifyBeacon(beacon, request.round);
        return beacon;
      } catch {
        if (controller.signal.aborted) throw error('SERVICE_STOPPING', 503);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onClose);
      }
    }
    throw error('BEACON_WAIT', 503);
  }

  function startJob(request) {
    if (closed || jobs.has(request.id)) return;
    requireThat(jobs.size < maxJobs, 'SOURCE_BUSY', 503);
    const receipt = FairDice.signReservation(request, signingKey);
    requireThat(FairDice.roundTime(request.round) <= now() + 30000, 'INVALID_FUTURE_ROUND', 503);
    const job = { request, promise: null };
    jobs.set(request.id, job);
    job.promise = (async () => {
      const deadline = now() + jobDeadlineMs;
      const initialDelay = Math.max(0, FairDice.roundTime(request.round) - now());
      if (initialDelay) await wait(initialDelay, controller.signal);
      let proof;
      let attempts = 0;
      while (!closed && now() <= deadline) {
        try {
          const recorded = await store.getRequest(request.id);
          requireThat(recorded?.request && same(recorded.request, request), 'REQUEST_CONTEXT_MISMATCH', 503);
          if (recorded.cancelled || recorded.consumed) return;
          if (recorded.proof) {
            await FairDice.verifyProof(recorded.proof, { publicKey, context: request });
            return;
          }
          if (!proof) proof = await FairDice.createProof(receipt, await fetchBeacon(request));
          await store.commitProof(request.id, proof);
          return;
        } catch {
          if (closed) return;
          attempts += 1;
          await wait(Math.min(retryDelayMs * Math.pow(2, Math.min(attempts - 1, 3)), 4000), controller.signal);
        }
      }
      // Failure deliberately leaves the same reservation outstanding. A later
      // authenticated retry or startup resume continues this request, never
      // allocates another nonce or falls back to browser/server random dice.
    })().catch(() => {}).finally(() => jobs.delete(request.id));
  }

  async function getAuthorizedRoom(code, headers) {
    const room = await store.getRoom(code, headers);
    requireThat(room?.roomCode === code && room.fairDiceRequired === true && UUID.test(room.gameId)
      && room.actor && ['white', 'dark'].includes(room.actor.actorColor)
      && typeof room.actor.ownsHost === 'boolean' && typeof room.actor.bot === 'boolean'
      && Number.isSafeInteger(room.version) && room.version >= 0, 'FAIR_ROOM_REQUIRED', 422);
    return room;
  }

  function binding(request, room) {
    requireThat(request?.roomCode === room.roomCode && request.gameId === room.gameId
      && request.variant === room.variant, 'REQUEST_CONTEXT_MISMATCH', 403);
  }

  async function reserve(body, headers) {
    exactFields(body, ['code', 'label', 'color']);
    const code = normalizeCode(body.code);
    const room = await getAuthorizedRoom(code, headers);
    requireThat(['opening', 'roll'].includes(body.label) && ['none', 'white', 'dark'].includes(body.color), 'INVALID_ROLL_INTENT', 400);
    const request = await store.reserve(code, { label: body.label, color: body.color, positionHash: room.serverPositionHash }, headers);
    binding(request, room);
    requireThat(request.label === body.label && request.color === body.color, 'REQUEST_CONTEXT_MISMATCH', 409);
    const receipt = FairDice.signReservation(request, signingKey);
    startJob(request);
    return { status: 202, body: { status: 'pending', ...receipt, receipt } };
  }

  async function result(body, headers) {
    exactFields(body, ['code', 'requestId']);
    const room = await getAuthorizedRoom(normalizeCode(body.code), headers);
    const id = normalizeId(body.requestId);
    const recorded = await store.getRequest(id);
    binding(recorded?.request, room);
    requireThat(!recorded.cancelled, 'DICE_REQUEST_CANCELLED', 409);
    if (recorded.proof) {
      await FairDice.verifyProof(recorded.proof, { publicKey, context: recorded.request });
      return { status: 200, body: { status: 'ready', proof: recorded.proof } };
    }
    requireThat(!recorded.consumed, 'DICE_REQUEST_INVALID', 409);
    startJob(recorded.request);
    return { status: 202, body: { status: 'pending', requestId: id } };
  }

  async function state(body, headers) {
    exactFields(body, ['code', 'state', 'version']);
    const code = normalizeCode(body.code);
    const room = await getAuthorizedRoom(code, headers);
    requireThat(Number.isSafeInteger(body.version) && body.version >= 0, 'STATE_VERSION_CONFLICT', 409);
    const previous = room.state;
    const next = body.state;
    const options = { actorColor: room.actor.actorColor, botOwner: room.actor.bot && room.actor.ownsHost };
    if (previous == null) requireThat(room.actor.ownsHost, 'UNVALIDATED_ACTOR', 403);
    if (previous?.phase === 'over' && next?.phase === 'over') {
      validateTransition(previous, next, options);
      if (same(positionOf(previous), positionOf(next)) && previous.finishedAt === next.finishedAt) {
        // Final archive/publish retries are idempotent even if a harmless UI
        // marker or running clock differs, or the first reply was lost.
        return { status: 200, body: { ok: true, unchanged: true, version: room.version, state: previous, gameId: room.gameId } };
      }
    }
    requireThat(body.version === room.version, 'STATE_VERSION_CONFLICT', 409);
    if (previous?.phase === 'over' && next?.phase === 'opening') {
      const score = previous.matchScore;
      const white = score.white + (previous.winner === 'white' && score.recordedWinner !== 'white' ? 1 : 0);
      const dark = score.dark + (previous.winner === 'dark' && score.recordedWinner !== 'dark' ? 1 : 0);
      validateNewGame(previous, next, { ...options, resetMatch: white >= score.target || dark >= score.target });
      return { status: 200, body: await store.resetFairGame(code, next, room.version, headers) };
    }
    const oldIds = new Set((previous?.history || []).map(event => event?.fairDiceProof?.request?.id).filter(Boolean));
    const addedProofs = (Array.isArray(next?.history) ? next.history : [])
      .map(event => event?.fairDiceProof).filter(proof => proof && !oldIds.has(proof.request?.id));
    requireThat(addedProofs.length <= 1, 'TOO_MANY_DICE_REQUESTS', 422);
    let issuedProof;
    if (addedProofs.length) {
      const recorded = await store.getRequest(normalizeId(addedProofs[0].request?.id));
      binding(recorded?.request, room);
      requireThat(recorded.proof && !recorded.cancelled && !recorded.consumed
        && recorded.request.positionHash === room.serverPositionHash
        && same(recorded.proof, addedProofs[0]), 'PROOF_NOT_OUTSTANDING', 409);
      await FairDice.verifyProof(recorded.proof, { publicKey, context: recorded.request });
      issuedProof = recorded.proof;
    }
    const pending = Boolean(room.pending && !room.pending.cancelled && !room.pending.consumed);
    const concession = ownConcession(previous, next, options.actorColor);
    validateTransition(previous, next, {
      ...options, allowInitial: previous == null, issuedProof,
      serverPositionHash: issuedProof ? room.serverPositionHash : undefined,
      pending: pending && !issuedProof && !concession,
    });
    if (pending && !issuedProof && !concession) {
      return { status: 200, body: { ok: true, deferred: true, version: room.version, state: previous, gameId: room.gameId } };
    }
    return { status: 200, body: await store.commitState(code, next, room.version, headers) };
  }

  async function leave(body, headers) {
    exactFields(body, ['code']);
    const code = normalizeCode(body.code);
    const room = await getAuthorizedRoom(code, headers);
    if (room.status === 'over' || room.status === 'closed' || room.state?.phase === 'over') {
      return { status: 200, body: { ok: true, removed: true, unchanged: true, state: room.state, version: room.version } };
    }
    if (room.status === 'waiting') {
      requireThat(room.actor.ownsHost && typeof store.closeFairWaitingRoom === 'function', 'UNVALIDATED_ACTOR', 403);
      return { status: 200, body: await store.closeFairWaitingRoom(code, headers) };
    }
    requireThat(room.status === 'joined' && room.state && Number.isSafeInteger(room.serverNowMs)
      && room.serverNowMs > 0, 'FAIR_ROOM_REQUIRED', 422);
    const next = JSON.parse(JSON.stringify(room.state));
    const loser = room.actor.actorColor;
    const winner = loser === 'white' ? 'dark' : 'white';
    const at = new Date(room.serverNowMs).toISOString();
    next.dice = [];
    next.rolled = [];
    next.winner = winner;
    next.resultType = null;
    next.phase = 'over';
    next.finishedAt = room.serverNowMs;
    next.history.unshift({ leave: true, color: loser, winnerColor: winner, at });
    if (next.matchScore.recordedWinner !== winner) {
      next.matchScore[winner] += 1;
      next.matchScore.recordedWinner = winner;
    }
    // This endpoint constructs only the authenticated actor's concession. Its
    // terminal commit cancels any future request but retains the old evidence.
    validateTransition(room.state, next, { actorColor: loser, botOwner: room.actor.bot && room.actor.ownsHost });
    return { status: 200, body: { ...await store.commitState(code, next, room.version, headers), removed: true } };
  }

  function publicPresence(room) {
    const actorColor = room.actor.actorColor;
    const opponentColor = actorColor === 'white' ? 'dark' : 'white';
    const at = room.serverNowMs;
    const player = room.presence?.[opponentColor];
    const seen = Number.isSafeInteger(player?.lastSeen) && player.lastSeen > 0 ? player.lastSeen : 0;
    const joinedAt = Date.parse(room.joinedAt || '');
    const lastSeen = Math.max(seen, Number.isFinite(joinedAt) ? joinedAt : 0);
    const disconnectedAt = !room.actor.bot && lastSeen && at > lastSeen + PRESENCE_STALE_MS
      ? lastSeen + PRESENCE_STALE_MS : null;
    const deadlineAt = disconnectedAt ? disconnectedAt + NETWORK_GRACE_MS : null;
    return { now: at, staleMs: PRESENCE_STALE_MS, graceMs: NETWORK_GRACE_MS, viewerColor: actorColor,
      opponent: { color: opponentColor, name: player?.name || '',
        online: room.actor.bot || Boolean(lastSeen && !disconnectedAt), disconnected: Boolean(disconnectedAt),
        disconnectedAt, deadlineAt, remainingMs: deadlineAt ? Math.max(0, deadlineAt - at) : NETWORK_GRACE_MS },
      networkLoss: room.state?.networkLoss || null, gameVersion: room.version };
  }

  async function presence(body, headers) {
    exactFields(body, ['code']);
    const code = normalizeCode(body.code);
    await getAuthorizedRoom(code, headers);
    let touched = await store.touchPresence(code, headers);
    requireThat(touched?.roomCode === code && touched.fairDiceRequired === true
      && Number.isSafeInteger(touched.serverNowMs) && touched.serverNowMs > 0,
    'FAIR_ROOM_REQUIRED', 422);
    const report = publicPresence(touched);
    if (!touched.actor.bot && touched.status === 'joined' && touched.state && !touched.state.winner
      && report.opponent.deadlineAt && touched.serverNowMs >= report.opponent.deadlineAt) {
      const next = JSON.parse(JSON.stringify(touched.state));
      const loser = report.opponent.color;
      const winner = touched.actor.actorColor;
      const at = new Date(touched.serverNowMs).toISOString();
      next.dice = [];
      next.rolled = [];
      next.winner = winner;
      next.resultType = null;
      next.phase = 'over';
      next.finishedAt = touched.serverNowMs;
      next.networkLoss = { loserColor: loser, winnerColor: winner, message: 'Соединение потеряно', at };
      next.history.unshift({ networkLoss: true, color: loser, winnerColor: winner, message: 'Соединение потеряно', at });
      if (next.matchScore.recordedWinner !== winner) {
        next.matchScore[winner] += 1;
        next.matchScore.recordedWinner = winner;
      }
      validateTransition(touched.state, next, { actorColor: winner, allowNetworkLoss: true });
      try {
        // The SQL capability rechecks current server-timed lastSeen under its
        // room lock. A reconnect between heartbeat and commit wins that race.
        const committed = await store.commitState(code, next, touched.version, headers);
        touched = { ...touched, state: committed.state, version: committed.version, status: 'over', pending: null };
      } catch (failure) {
        if (!['40001', '42501'].includes(failure?.code)) throw failure;
        touched = await getAuthorizedRoom(code, headers);
      }
    }
    return { status: 200, body: { ok: true, presence: publicPresence(touched), state: touched.state, version: touched.version } };
  }

  function cors(request, response) {
    response.setHeader('vary', 'Origin');
    const origin = request.headers.origin;
    requireThat(origin === undefined || (typeof origin === 'string' && origins.has(origin)), 'ORIGIN_NOT_ALLOWED', 403);
    if (origin !== undefined) response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
    response.setHeader('access-control-allow-headers', 'Authorization, Content-Type, X-Guest-Id, X-Guest-Proof');
    response.setHeader('access-control-max-age', '600');
  }

  function send(response, status, body) {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (status === 202) response.setHeader('retry-after', '1');
    response.end(body === undefined ? '' : JSON.stringify(body));
  }

  async function handler(request, response) {
    let admitted = false;
    try {
      requireThat(!closed, 'SERVICE_STOPPING', 503);
      cors(request, response);
      requireThat(request.url.startsWith(PREFIX + '/') && !request.url.includes('?'), 'NOT_FOUND', 404);
      if (request.method === 'OPTIONS') {
        requireThat(request.headers['access-control-request-method'] === 'POST', 'METHOD_NOT_ALLOWED', 405);
        const requested = (request.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
        requireThat(requested.every(name => AUTH_HEADERS.includes(name) || name === 'content-type'), 'INVALID_CORS_HEADERS', 403);
        send(response, 204);
        return;
      }
      if (request.method === 'GET' && request.url === PREFIX + '/health') {
        send(response, 200, { ok: true, protocol: FairDice.PROTOCOL, chainHash: FairDice.CHAIN.hash, publicKey, pendingJobs: jobs.size });
        return;
      }
      requireThat(request.method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      const routes = { [PREFIX + '/reserve']: reserve, [PREFIX + '/result']: result, [PREFIX + '/state']: state,
        [PREFIX + '/leave']: leave };
      if (typeof store.touchPresence === 'function') routes[PREFIX + '/presence'] = presence;
      const operation = routes[request.url];
      requireThat(operation, 'NOT_FOUND', 404);
      const headers = credentialHeaders(request);
      checkRate(request, headers);
      requireThat(inFlight < maxRequests, 'SOURCE_BUSY', 503);
      inFlight += 1;
      admitted = true;
      const reply = await operation(await readBody(request, bodyLimit), headers);
      send(response, reply.status, reply.body);
    } catch (failure) {
      // No exception text is returned or logged: SQL, fetch and file errors can
      // contain private credentials. Stable codes give the client retry policy.
      const knownInternalCode = typeof failure?.code === 'string' &&
        (/^fair_[a-z_]{1,50}$/.test(failure.code) || /^FAIR_[A-Z_]{1,50}$/.test(failure.code));
      const code = SAFE_CODES.has(failure?.code) || knownInternalCode ? failure.code : 'FAIR_DICE_UNAVAILABLE';
      const status = Number.isInteger(failure?.status) && failure.status >= 400 && failure.status <= 599
        ? failure.status : code.startsWith('fair_') || code.startsWith('FAIR_') ? 422 : 503;
      if (!response.writableEnded && !response.destroyed) send(response, status, { error: code, code,
        message: 'Не удалось подтвердить бросок. Повторная попытка использует тот же запрос.' });
      request.resume?.();
    } finally {
      if (admitted) inFlight -= 1;
    }
  }

  async function resumePending() {
    if (typeof store.listPending !== 'function' || closed) return 0;
    const pending = await store.listPending();
    let started = 0;
    for (const item of pending) {
      if (!item.cancelled && !item.consumed && !item.proof) {
        startJob(item.request || item);
        started += 1;
      }
    }
    return started;
  }

  async function close() {
    closed = true;
    controller.abort();
    await Promise.allSettled([...jobs.values()].map(job => job.promise));
    limits.clear();
  }

  return { handler, publicKey, resumePending, close,
    waitForIdle: () => Promise.allSettled([...jobs.values()].map(job => job.promise)),
    get pendingJobs() { return jobs.size; } };
}

module.exports = { createFairDiceService, RELAYS };
