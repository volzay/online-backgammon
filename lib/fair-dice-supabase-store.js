'use strict';

const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLISHABLE_KEY_RE = /^sb_publishable_[A-Za-z0-9_-]{16,128}$/;

class FairDiceStoreError extends Error {}

function storeError(message, status = 502, code = 'FAIR_DICE_STORE_ERROR') {
  const error = new FairDiceStoreError(message);
  error.status = status;
  error.code = code;
  return error;
}

function roomCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) throw storeError('Invalid room code.', 400, 'INVALID_ROOM_CODE');
  return code;
}

function requestId(value) {
  const id = String(value || '').trim();
  if (!UUID_RE.test(id)) throw storeError('Invalid dice request ID.', 400, 'INVALID_REQUEST_ID');
  return id;
}

function playerHeaders(source, anonKey, publishableKey) {
  const get = name => typeof source?.get === 'function'
    ? source.get(name)
    : Object.entries(source || {}).find(([key]) => key.toLowerCase() === name)?.[1];
  let authorization = String(get('authorization') || `Bearer ${anonKey}`).trim();
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) throw storeError('Invalid player authentication.', 401, 'INVALID_CREDENTIAL');
  const headers = { authorization, apikey: anonKey, 'content-type': 'application/json' };
  for (const name of ['x-guest-id', 'x-guest-proof']) {
    const value = get(name);
    if (value != null) headers[name] = String(value);
  }
  // The public browser alias is not a JWT accepted by the internal Kong
  // gateway. Translate only the one configured alias with paired guest proof;
  // SQL still authenticates that proof. Never reinterpret a player JWT, an
  // unknown alias, or an alias without both guest headers as anonymous access.
  if (publishableKey && authorization === `Bearer ${publishableKey}`
    && headers['x-guest-id']?.trim() && headers['x-guest-proof']?.trim()) {
    headers.authorization = `Bearer ${anonKey}`;
  }
  return headers;
}

class SupabaseFairDiceStore {
  #anonKey;
  #serviceRoleKey;
  #publishableKey;
  constructor({ url, anonKey, serviceRoleKey, publishableKey, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError('A backend HTTP(S) URL without credentials is required.');
    }
    if (!anonKey || !serviceRoleKey || typeof fetchImpl !== 'function') throw new TypeError('Backend keys and fetch are required.');
    if (publishableKey != null && (typeof publishableKey !== 'string' || !PUBLISHABLE_KEY_RE.test(publishableKey))) {
      throw new TypeError('A valid public publishable-key alias is required.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Invalid store timeout.');
    this.url = parsed.href.replace(/\/$/, '');
    // Keys are private and are never included in return data or error messages.
    this.#anonKey = String(anonKey);
    this.#serviceRoleKey = String(serviceRoleKey);
    this.#publishableKey = publishableKey;
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._validatedPlayers = new WeakMap();
  }

  async _rpc(name, body, credentials, privileged = false) {
    const headers = privileged
      ? { apikey: this.#serviceRoleKey, authorization: `Bearer ${this.#serviceRoleKey}`, 'content-type': 'application/json' }
      : playerHeaders(credentials, this.#anonKey, this.#publishableKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const response = await this._fetch(`${this.url}/rest/v1/rpc/${name}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });
      let payload;
      try { payload = await response.json(); } catch { throw storeError('Invalid response from dice persistence.'); }
      if (!response.ok) {
        const sqlCode = typeof payload?.code === 'string'
          && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(payload.code) ? payload.code : '';
        const status = sqlCode === '40001' || sqlCode === '23505' ? 409
          : sqlCode === '42501' ? 403 : sqlCode === 'P0002' ? 404
            : sqlCode === '22023' || sqlCode === '23514' || sqlCode === '55000' ? 422
              : response.status >= 400 && response.status < 500 ? response.status : 502;
        // Do not echo arbitrary gateway messages (which may contain secrets).
        throw storeError('Dice persistence rejected the operation.', status, sqlCode || 'FAIR_DICE_STORE_ERROR');
      }
      return payload;
    } catch (error) {
      if (error instanceof FairDiceStoreError) throw error;
      throw storeError(controller.signal.aborted ? 'Dice persistence request timed out.' : 'Dice persistence is unavailable.');
    } finally { clearTimeout(timer); }
  }

  async getRoom(code, credentialHeaders) {
    const normalizedCode = roomCode(code);
    if (!credentialHeaders || (typeof credentialHeaders !== 'object' && typeof credentialHeaders !== 'function')) {
      throw storeError('Player credentials are required.', 401, 'INVALID_CREDENTIAL');
    }
    const result = await this._rpc('get_fair_dice_room', { p_room_code: normalizedCode }, credentialHeaders);
    return this._acceptRoom(normalizedCode, credentialHeaders, result);
  }

  _acceptRoom(normalizedCode, credentialHeaders, result) {
    if (!result || result.roomCode !== normalizedCode || !Number.isSafeInteger(result.version)
      || !result.actor || typeof result.actor.ownsHost !== 'boolean'
      || !['white', 'dark'].includes(result.actor.actorColor)
      || (result.state != null && (!result.state || typeof result.state !== 'object'
        || Array.isArray(result.state) || !Array.isArray(result.state.history)))) {
      throw storeError('Invalid authoritative room response.');
    }
    this._validatedPlayers.set(credentialHeaders, {
      code: normalizedCode, version: result.version,
      pendingId: result.pending?.request?.id || null,
      gameId: result.gameId, positionHash: result.serverPositionHash,
      proofIds: new Set((result.state?.history || []).map(event => event?.fairDiceProof?.request?.id).filter(Boolean)),
    });
    return result;
  }

  async touchPresence(code, credentialHeaders) {
    const normalizedCode = roomCode(code);
    if (!credentialHeaders || (typeof credentialHeaders !== 'object' && typeof credentialHeaders !== 'function')) {
      throw storeError('Player credentials are required.', 401, 'INVALID_CREDENTIAL');
    }
    const result = await this._rpc('touch_fair_dice_presence', { p_room_code: normalizedCode }, credentialHeaders);
    return this._acceptRoom(normalizedCode, credentialHeaders, result);
  }

  async closeFairWaitingRoom(code, credentialHeaders) {
    return this._rpc('close_fair_dice_waiting_room', { p_room_code: roomCode(code) }, credentialHeaders);
  }

  async listPending() {
    const result = await this._rpc('list_pending_fair_dice_requests', {}, null, true);
    if (!Array.isArray(result) || result.length > 100) throw storeError('Invalid pending dice response.');
    return result;
  }

  async reserve(code, { label, color, positionHash } = {}, credentialHeaders) {
    const normalizedCode = roomCode(code);
    if (!['opening', 'roll'].includes(label) || !['none', 'white', 'dark'].includes(color)
      || (positionHash != null && !/^[0-9a-f]{64}$/.test(positionHash))) {
      throw storeError('Invalid roll intent.', 400, 'INVALID_ROLL_INTENT');
    }
    return this._rpc('reserve_fair_dice', {
      p_room_code: normalizedCode, p_label: label, p_color: color,
      p_position_hash: positionHash ?? null,
    }, credentialHeaders);
  }

  async getRequest(id) {
    return this._rpc('get_fair_dice_request', { p_request_id: requestId(id) }, null, true);
  }

  async commitProof(id, proof) {
    return this._rpc('commit_fair_dice_proof', { p_request_id: requestId(id), p_proof: proof }, null, true);
  }

  async acceptClientSeed(id, seed, credentialHeadersValidatedByGetRoom) {
    const normalizedId = requestId(id);
    const validated = this._validatedPlayers.get(credentialHeadersValidatedByGetRoom);
    if (!validated || validated.pendingId !== normalizedId) {
      throw storeError('Player room access must be validated before accepting a seed.', 403, 'UNVALIDATED_ACTOR');
    }
    if (typeof seed !== 'string' || !/^[0-9a-f]{64}$/.test(seed)) {
      throw storeError('Invalid client seed.', 400, 'INVALID_CLIENT_SEED');
    }
    if (!UUID_RE.test(validated.gameId) || typeof validated.positionHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(validated.positionHash)) {
      throw storeError('Invalid authoritative request context.');
    }
    return this._rpc('accept_system_fair_dice_client_seed', {
      p_request_id: normalizedId, p_client_seed: seed,
      p_room_code: validated.code, p_game_id: validated.gameId,
      p_position_hash: validated.positionHash,
    }, null, true);
  }

  async commitState(code, nextState, expectedVersion, credentialHeadersValidatedByGetRoom) {
    const normalizedCode = roomCode(code);
    const validated = this._validatedPlayers.get(credentialHeadersValidatedByGetRoom);
    if (!validated || validated.code !== normalizedCode || validated.version !== expectedVersion) {
      throw storeError('Player room access must be validated before committing state.', 403, 'UNVALIDATED_ACTOR');
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2147483646
      || !nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
      throw storeError('Invalid authoritative state.', 400, 'INVALID_STATE');
    }
    const newestProof = Array.isArray(nextState.history)
      ? nextState.history.find(event => event?.fairDiceProof)?.fairDiceProof
      : null;
    // A proof already present in the confirmed room is not a new request.
    const result = await this._rpc('commit_fair_dice_state', {
      p_room_code: normalizedCode, p_next_state: nextState,
      p_expected_version: expectedVersion,
      p_request_id: newestProof?.request?.id && !validated.proofIds.has(newestProof.request.id)
        ? requestId(newestProof.request.id) : null,
    }, null, true);
    this._validatedPlayers.delete(credentialHeadersValidatedByGetRoom);
    return result;
  }

  async resetFairGame(code, initialState, expectedVersion, credentialHeadersValidatedByGetRoom) {
    const normalizedCode = roomCode(code);
    const validated = this._validatedPlayers.get(credentialHeadersValidatedByGetRoom);
    if (!validated || validated.code !== normalizedCode || validated.version !== expectedVersion) {
      throw storeError('Player room access must be validated before resetting state.', 403, 'UNVALIDATED_ACTOR');
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2147483646
      || !initialState || typeof initialState !== 'object' || Array.isArray(initialState)) {
      throw storeError('Invalid authoritative initial state.', 400, 'INVALID_STATE');
    }
    const result = await this._rpc('reset_fair_dice_game', {
      p_room_code: normalizedCode, p_initial_state: initialState, p_expected_version: expectedVersion,
    }, null, true);
    this._validatedPlayers.delete(credentialHeadersValidatedByGetRoom);
    return result;
  }
}

module.exports = { SupabaseFairDiceStore };
