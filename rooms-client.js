(function () {
  const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const PRESENCE_STALE_MS = 30000;
  const NETWORK_GRACE_MS = 120000;
  const PROFILE_HEARTBEAT_MS = 30000;
  const MAX_VOICE_DATA_URL_CHARS = 6 * 1024 * 1024;
  const LONG_BOT_EXPERIENCE_CACHE_KEY = "narduh-long-bot-server-experience-v15";
  const LEGACY_LONG_BOT_EXPERIENCE_CACHE_KEY = "narduh-long-bot-server-experience-v14";
  const LONG_BOT_EXPERIENCE_CREDIT_VERSION = 8;
  const LONG_BOT_SERVER_CAUSAL_CREDIT_VERSION = 9;
  const LONG_BOT_SERVER_CAUSAL_SCHEMA = "long-server-causal-pattern-v1";
  const LONG_BOT_SERVER_CAUSAL_REVIEWER = "long-server-causal-review-v1";
  const LONG_BOT_SERVER_CAUSAL_TRUST_DOMAIN = "nardu/server-long-bot-causal/v1";
  const SHORT_BOT_EXPERIENCE_CACHE_KEY = "narduh-short-bot-server-experience-v6";
  const SHORT_BOT_EXPERIENCE_CREDIT_VERSION = 6;
  const LONG_BOT_EXPERIENCE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
  const SHORT_BOT_EXPERIENCE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const ROOM_SNAPSHOT_PREFIX = "narduh-room-state:";
  const ROOM_SNAPSHOT_MAX_AGE_MS = 96 * 60 * 60 * 1000;
  const ROOM_SNAPSHOT_RETAIN_LIMIT = 8;
  const ROOM_SNAPSHOT_SCAN_LIMIT = 256;
  const ROOM_SNAPSHOT_PRUNE_LIMIT = 32;
  const ACTIVE_ROOM_STORAGE_KEY = "narduh-active-room";
  const BOT_ANALYSIS_OWNER_STORAGE_VERSION = 1;
  const BOT_ANALYSIS_OWNER_STORAGE_PREFIX = "narduh-bot-analysis-owner-v2:";
  const NEURAL_BOT_DIFFICULTY = "hard-neuro";
  const NEURAL_BOT_METADATA = Object.freeze({
    id: "hard-neuro-448-v1", name: "Сложный бот-нейро", variant: "long", mode: "experimental-frozen",
    modelFingerprint: "sha256:4254bfa9f4afccbeb73657f11e37ff39a7fcd9162e7887f1aae28eaa7fbe0155",
    inferenceCodeFingerprint: "sha256:a46b184302d4b9bb2f8477d6f454b0cd2ceff0f06ff933d4ea59f28ae8976e3e",
    rulesFingerprint: "sha256:769c571ad10cefa75a8c128aba5123df47684780fad1136a0ae98f3342f33e4b",
    trainingGames: 448, trainingSteps: 35147, inputSize: 127, hiddenSize: 32, maxCandidates: 16, epsilon: 0,
  });
  const roomIdCache = new Map();
  const fairDicePolicies = new Map();
  const profileHeartbeatAt = new Map();
  const longBotExperiencePromises = new Map();
  const shortBotExperiencePromises = new Map();
  const botAnalysisOwnerTokens = new Map();
  let longBotExperienceLoadGeneration = 0;
  let shortBotExperienceLoadGeneration = 0;

  function longBotRequiresCausalExperience() {
    const match = String(window.NarduLongBotEngine?.version || "")
      .match(/^long-analytic-v(\d+)$/);
    return Boolean(match && Number(match[1]) >= 35);
  }

  function validatedLongBotExperience(patterns, { trustedRpc = false } = {}) {
    if (!Array.isArray(patterns)) return null;
    const causalOnly = longBotRequiresCausalExperience();
    // The dedicated service-role worker owns v9 ingestion. Accept it only
    // directly from the live read-only RPC; client storage and attached review
    // reports cannot assert this provenance or become executable policy.
    if (causalOnly) {
      if (patterns.length === 0) return [];
      if (!trustedRpc || patterns.length > 256) return null;
      return patterns.every(pattern => {
        const samples = pattern?.samples;
        return Boolean(
          pattern && typeof pattern === "object"
          && pattern.creditVersion === LONG_BOT_SERVER_CAUSAL_CREDIT_VERSION
          && pattern.evidenceSchema === LONG_BOT_SERVER_CAUSAL_SCHEMA
          && pattern.reviewerVersion === LONG_BOT_SERVER_CAUSAL_REVIEWER
          && pattern.trustDomain === LONG_BOT_SERVER_CAUSAL_TRUST_DOMAIN
          && /^[0-9a-f]{64}$/.test(String(window.NarduLongBotEngine?.policyImplementationId || ""))
          && pattern.policyImplementationId === window.NarduLongBotEngine.policyImplementationId
          && pattern.outcomeUsed === false
          && /^[0-9a-f]{64}$/.test(String(pattern.runtimeDigest || ""))
          && /^[0-9a-f]{64}$/.test(String(pattern.aggregateId || ""))
          && typeof pattern.contextKey === "string" && pattern.contextKey.length > 0
          && typeof pattern.actionKey === "string" && pattern.actionKey.length > 0
          && Number.isInteger(samples) && samples >= 1 && samples <= 32
          && pattern.losses === samples && pattern.wins === 0
          && pattern.lossWeight === samples * 1.5
          && pattern.signalWeight === samples * 1.5
          && pattern.severeLosses === 0 && pattern.winWeight === 0
        );
      }) ? patterns : null;
    }
    return patterns.every(pattern => (
      pattern
      && typeof pattern === "object"
      && Number(pattern.creditVersion) === LONG_BOT_EXPERIENCE_CREDIT_VERSION
    )) ? patterns : null;
  }

  function readLongBotExperienceCache(playerKey) {
    try {
      localStorage.removeItem(LEGACY_LONG_BOT_EXPERIENCE_CACHE_KEY);
      if (longBotRequiresCausalExperience()) {
        localStorage.removeItem(LONG_BOT_EXPERIENCE_CACHE_KEY);
        return [];
      }
      const cached = JSON.parse(localStorage.getItem(LONG_BOT_EXPERIENCE_CACHE_KEY) || "null");
      if (!cached) return [];
      if (Date.now() - Number(cached.savedAt || 0) > LONG_BOT_EXPERIENCE_CACHE_MAX_AGE_MS) {
        localStorage.removeItem(LONG_BOT_EXPERIENCE_CACHE_KEY);
        return [];
      }
      if (String(cached.playerKey || "") !== String(playerKey || "")) return [];
      const patterns = Number(cached.creditVersion) === LONG_BOT_EXPERIENCE_CREDIT_VERSION
        ? validatedLongBotExperience(cached.patterns)
        : null;
      if (patterns) return patterns;
      localStorage.removeItem(LONG_BOT_EXPERIENCE_CACHE_KEY);
      return [];
    } catch {
      return [];
    }
  }

  function writeLongBotExperienceCache(patterns, playerKey) {
    let payload = "";
    try {
      localStorage.removeItem(LEGACY_LONG_BOT_EXPERIENCE_CACHE_KEY);
      if (longBotRequiresCausalExperience()) {
        localStorage.removeItem(LONG_BOT_EXPERIENCE_CACHE_KEY);
        return false;
      }
      const validated = validatedLongBotExperience(patterns);
      if (!validated) {
        localStorage.removeItem(LONG_BOT_EXPERIENCE_CACHE_KEY);
        return false;
      }
      payload = JSON.stringify({
        savedAt: Date.now(),
        playerKey: String(playerKey || ""),
        creditVersion: LONG_BOT_EXPERIENCE_CREDIT_VERSION,
        patterns: validated,
      });
      localStorage.setItem(LONG_BOT_EXPERIENCE_CACHE_KEY, payload);
      return true;
    } catch (error) {
      if (!payload || !isStorageQuotaError(error)) return false;
      // Room recovery data must not prevent the next game from using shared
      // experience. Keep the active room plus the bounded recent recovery
      // window, remove only our own snapshots, then retry once.
      pruneOldRoomSnapshotsForBotCache();
      try {
        localStorage.setItem(LONG_BOT_EXPERIENCE_CACHE_KEY, payload);
        return true;
      } catch {
        return false;
      }
    }
  }

  function isStorageQuotaError(error) {
    const name = String(error?.name || "");
    const message = String(error?.message || "");
    const code = Number(error?.code);
    return name === "QuotaExceededError"
      || name === "NS_ERROR_DOM_QUOTA_REACHED"
      || code === 22
      || code === 1014
      || /quota/i.test(message);
  }

  function pruneOldRoomSnapshotsForBotCache() {
    const snapshots = [];
    try {
      const now = Date.now();
      let activeRoomCode = "";
      try {
        const activeRoom = JSON.parse(localStorage.getItem(ACTIVE_ROOM_STORAGE_KEY) || "null");
        activeRoomCode = normalizeCode(activeRoom?.code || activeRoom?.game || "");
      } catch {}
      let currentSnapshotKey = "";
      try {
        const pathname = String(window.location?.pathname || "");
        const search = String(window.location?.search || "");
        if (pathname) currentSnapshotKey = `${ROOM_SNAPSHOT_PREFIX}${pathname}${search}`;
      } catch {}

      const length = Math.min(
        ROOM_SNAPSHOT_SCAN_LIMIT,
        Math.max(0, Number(localStorage.length) || 0),
      );
      for (let index = 0; index < length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith(ROOM_SNAPSHOT_PREFIX)) continue;
        let at = 0;
        let valid = false;
        let roomCode = "";
        try {
          const snapshot = JSON.parse(localStorage.getItem(key) || "null");
          at = Number(snapshot?.at) || 0;
          valid = Boolean(snapshot?.state && at > 0);
          roomCode = normalizeCode(snapshot?.roomCode || snapshot?.state?.roomCode || "");
        } catch {}
        snapshots.push({
          key,
          at,
          valid,
          recent: valid && now - at <= ROOM_SNAPSHOT_MAX_AGE_MS,
          current: valid && key === currentSnapshotKey,
          activeRoom: valid && Boolean(activeRoomCode && roomCode === activeRoomCode),
        });
      }
      const protectedKeys = new Set(
        snapshots.filter(snapshot => snapshot.current).map(snapshot => snapshot.key),
      );
      const activeRoomSnapshot = snapshots
        .filter(snapshot => snapshot.activeRoom)
        .sort((left, right) => right.at - left.at)[0];
      if (activeRoomSnapshot) protectedKeys.add(activeRoomSnapshot.key);
      const recoverySlots = Math.max(0, ROOM_SNAPSHOT_RETAIN_LIMIT - protectedKeys.size);
      const retainedRecentKeys = new Set(
        snapshots
          .filter(snapshot => snapshot.recent && !protectedKeys.has(snapshot.key))
          .sort((left, right) => right.at - left.at)
          .slice(0, recoverySlots)
          .map(snapshot => snapshot.key),
      );
      snapshots
        .filter(snapshot => !protectedKeys.has(snapshot.key) && !retainedRecentKeys.has(snapshot.key))
        .sort((left, right) => left.at - right.at)
        .slice(0, ROOM_SNAPSHOT_PRUNE_LIMIT)
        .forEach(snapshot => localStorage.removeItem(snapshot.key));
    } catch {}
  }

  function validatedShortBotExperience(patterns) {
    if (!Array.isArray(patterns)) return null;
    return patterns.every(pattern => (
      pattern
      && typeof pattern === "object"
      && Number(pattern.creditVersion) === SHORT_BOT_EXPERIENCE_CREDIT_VERSION
    )) ? patterns : null;
  }

  function readShortBotExperienceCache(playerKey) {
    try {
      const cached = JSON.parse(localStorage.getItem(SHORT_BOT_EXPERIENCE_CACHE_KEY) || "null");
      if (!cached || Date.now() - Number(cached.savedAt || 0) > SHORT_BOT_EXPERIENCE_CACHE_MAX_AGE_MS) return [];
      if (String(cached.playerKey || "") !== String(playerKey || "")) return [];
      const patterns = Number(cached.creditVersion) === SHORT_BOT_EXPERIENCE_CREDIT_VERSION
        ? validatedShortBotExperience(cached.patterns)
        : null;
      if (patterns) return patterns;
      localStorage.removeItem(SHORT_BOT_EXPERIENCE_CACHE_KEY);
      return [];
    } catch {
      return [];
    }
  }

  function writeShortBotExperienceCache(patterns, playerKey) {
    try {
      const validated = validatedShortBotExperience(patterns);
      if (!validated) {
        localStorage.removeItem(SHORT_BOT_EXPERIENCE_CACHE_KEY);
        return;
      }
      localStorage.setItem(SHORT_BOT_EXPERIENCE_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(),
        playerKey: String(playerKey || ""),
        creditVersion: SHORT_BOT_EXPERIENCE_CREDIT_VERSION,
        patterns: validated,
      }));
    } catch {
      // Server experience remains optional when browser storage is unavailable.
    }
  }

  function configured() {
    return Boolean(window.NarduSupabase?.configured?.());
  }

  function normalizeCode(value) {
    const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (raw.length < 8) return String(value || "").trim().toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  }

  function createRoomCode() {
    const bytes = new Uint8Array(8);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    }
    let code = "";
    for (let i = 0; i < bytes.length; i += 1) code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  function validBotAnalysisOwnerToken(value) {
    const token = String(value || "");
    return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : "";
  }

  function botAnalysisOwnerContext(code) {
    const normalizedCode = normalizeCode(code);
    const localUser = window.NarduApp?.getUser?.() || {};
    const guestId = localUser.guest === true ? normalizedGuestId(localUser.id) : "";
    const userId = localUser.guest === true ? "" : String(localUser.id || "").trim().slice(0, 128);
    const ownerScope = guestId ? `guest|${guestId}` : (userId ? `user|${userId}` : "unknown");
    return {
      normalizedCode,
      guestId,
      cacheKey: `${ownerScope}|${normalizedCode}`,
      sessionKey: `narduh-bot-analysis-owner:${normalizedCode}`,
      persistentKey: guestId
        ? `${BOT_ANALYSIS_OWNER_STORAGE_PREFIX}${guestId}:${normalizedCode}`
        : `${BOT_ANALYSIS_OWNER_STORAGE_PREFIX}${normalizedCode}`,
    };
  }

  function readPersistentBotAnalysisOwnerToken(context) {
    if (!context.guestId) return "";
    try {
      const stored = JSON.parse(window.localStorage?.getItem(context.persistentKey) || "null");
      if (
        Number(stored?.version) !== BOT_ANALYSIS_OWNER_STORAGE_VERSION
        || stored?.guestId !== context.guestId
      ) return "";
      return validBotAnalysisOwnerToken(stored.token);
    } catch {
      return "";
    }
  }

  function persistBotAnalysisOwnerToken(context, token) {
    try { window.sessionStorage?.setItem(context.sessionKey, token); } catch {}
    if (!context.guestId) return;
    try {
      window.localStorage?.setItem(context.persistentKey, JSON.stringify({
        version: BOT_ANALYSIS_OWNER_STORAGE_VERSION,
        guestId: context.guestId,
        token,
      }));
    } catch {
      // sessionStorage still keeps existing tabs usable when persistent storage is unavailable.
    }
  }

  function botAnalysisOwnerToken(code) {
    const context = botAnalysisOwnerContext(code);
    if (botAnalysisOwnerTokens.has(context.cacheKey)) return botAnalysisOwnerTokens.get(context.cacheKey);

    const persisted = readPersistentBotAnalysisOwnerToken(context);
    if (persisted) {
      botAnalysisOwnerTokens.set(context.cacheKey, persisted);
      try { window.sessionStorage?.setItem(context.sessionKey, persisted); } catch {}
      return persisted;
    }

    try {
      const stored = validBotAnalysisOwnerToken(window.sessionStorage?.getItem(context.sessionKey));
      if (stored) {
        botAnalysisOwnerTokens.set(context.cacheKey, stored);
        persistBotAnalysisOwnerToken(context, stored);
        return stored;
      }
    } catch {}
    const bytes = new Uint8Array(32);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    botAnalysisOwnerTokens.set(context.cacheKey, token);
    persistBotAnalysisOwnerToken(context, token);
    return token;
  }

  function forgetBotAnalysisOwnerToken(code) {
    const context = botAnalysisOwnerContext(code);
    botAnalysisOwnerTokens.delete(context.cacheKey);
    try { window.sessionStorage?.removeItem(context.sessionKey); } catch {}
    try { window.localStorage?.removeItem(context.persistentKey); } catch {}
  }

  async function apiJson(url, options = {}) {
    const guestHeaders = window.NarduApp?.guestRequestHeaders?.() || {};
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...guestHeaders,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(window.NarduApp?.translateServerMessage?.(data.error) || data.error || window.NarduApp?.t?.("err_session") || "Game session error.");
      err.status = response.status;
      err.data = data;
      if (response.status === 401) err.code = "AUTH_SESSION_MISSING";
      throw err;
    }
    return data;
  }

  function abortReason(signal) {
    if (signal?.reason !== undefined) return signal.reason;
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }

  function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
    throw abortReason(signal);
  }

  function awaitWithAbort(value, signal) {
    throwIfAborted(signal);
    if (!signal || typeof signal.addEventListener !== "function") return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener?.("abort", onAbort);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(value).then(
        result => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        },
        error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  function withAbortSignal(query, signal) {
    throwIfAborted(signal);
    return signal && typeof query?.abortSignal === "function"
      ? query.abortSignal(signal)
      : query;
  }

  async function supabase(options = {}) {
    return awaitWithAbort(window.NarduSupabase.client(), options.signal);
  }

  function roomError(message, status = 400, data = {}) {
    const err = new Error(message);
    err.status = status;
    err.data = data;
    return err;
  }

  function supabaseError(error, fallback = "Supabase request failed.") {
    if (!error) return roomError(fallback, 500);
    const err = roomError(error.message || fallback, Number(error.status || 500));
    err.code = error.code;
    err.details = error.details;
    return err;
  }

  function isMissingAuthSession(error) {
    const message = String(error?.message || error || "");
    return /auth session missing|refresh token.*(?:missing|not found|invalid)|jwt.*(?:expired|invalid)|invalid jwt/i.test(message);
  }

  function missingAuthSessionError() {
    const error = roomError("Сессия аккаунта истекла. Войдите в аккаунт заново.", 401);
    error.code = "AUTH_SESSION_MISSING";
    return error;
  }

  async function sha256Hex(value) {
    const text = String(value || "");
    if (!text) return "";
    if (!window.crypto?.subtle) return `plain:${text}`;
    const bytes = new TextEncoder().encode(text);
    const hash = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function ratingTierFor(rating) {
    return window.NarduApp?.ratingTierFor?.(rating) || "Bronze";
  }

  function normalizeRating(value) {
    if (value === null || value === undefined || value === "") return null;
    const rating = Math.round(Number(value));
    return Number.isFinite(rating) && rating > 0 ? rating : null;
  }

  async function touchProfileHeartbeat(client, userId, options = {}) {
    if (!userId) return;
    const { signal } = options;
    throwIfAborted(signal);
    const now = Date.now();
    const lastTouch = profileHeartbeatAt.get(userId) || 0;
    if (now - lastTouch < PROFILE_HEARTBEAT_MS) return;
    profileHeartbeatAt.set(userId, now);
    const writtenAt = new Date(now).toISOString();
    let query = client
      .from("profiles")
      .update({ last_seen_at: writtenAt })
      .or(`last_seen_at.is.null,last_seen_at.lt.${writtenAt}`)
      .eq("id", userId);
    query = withAbortSignal(query, signal);
    let error = null;
    try {
      ({ error } = await awaitWithAbort(query, signal));
      throwIfAborted(signal);
    } catch (requestError) {
      profileHeartbeatAt.delete(userId);
      if (signal?.aborted) throwIfAborted(signal);
      console.warn("Could not update profile heartbeat", requestError?.message || requestError);
      return;
    }
    if (error) {
      profileHeartbeatAt.delete(userId);
      console.warn("Could not update profile heartbeat", error.message || error);
    }
  }

  function localRoomProfile(authProfile = {}, options = {}) {
    const user = window.NarduApp?.getUser?.() || {};
    const forceUnregistered = options.registered === false;
    if (user.guest || forceUnregistered) {
      return {
        name: String(user.name || user.nickname || "Guest").slice(0, 32),
        rating: null,
        registered: false,
        ratingEligible: false,
      };
    }
    const showRating = window.NarduApp?.shouldShowRatingToOthers?.() !== false;
    const rating = normalizeRating(user.rating ?? authProfile.rating);
    return {
      name: String(user.name || user.nickname || authProfile.name || "Игрок").slice(0, 32),
      rating: showRating ? rating : null,
      registered: true,
      ratingEligible: user.ratingEligible !== false,
    };
  }

  function activeSpectatorCount(spectators = {}) {
    const now = Date.now();
    return Object.values(spectators || {}).filter(item => {
      const lastSeen = Date.parse(item?.lastSeen || "");
      return Number.isFinite(lastSeen) && now - lastSeen <= 45000;
    }).length;
  }

  function publicRoom(row, extras = {}) {
    if (!row) return null;
    const hostRating = row.host_registered ? normalizeRating(row.host_rating) : null;
    const guestRating = row.guest_registered ? normalizeRating(row.guest_rating) : null;
    const botAnalysis = isBotAnalysisRow(row);
    const room = {
      id: row.id,
      code: normalizeCode(row.code),
      hostUserId: row.host_user_id || row.host_guest_id || row.hostUserId || "",
      hostGuestId: row.host_guest_id || row.hostGuestId || "",
      hostName: row.host_name || row.hostName || "",
      hostRating,
      hostTier: row.host_registered && hostRating ? ratingTierFor(hostRating) : "",
      hostRegistered: Boolean(row.host_registered),
      hostRatingEligible: Boolean(row.host_registered),
      guestUserId: row.guest_user_id || row.guest_guest_id || row.guestUserId || "",
      guestGuestId: row.guest_guest_id || row.guestGuestId || "",
      guestName: row.guest_name || row.guestName || "",
      guestRating,
      guestTier: row.guest_registered && guestRating ? ratingTierFor(guestRating) : "",
      guestRegistered: Boolean(row.guest_registered),
      guestRatingEligible: Boolean(row.guest_registered),
      opponent: botAnalysis ? "bot" : "player",
      botDifficulty: botAnalysis
        ? String(row.game_state?.analysis?.difficulty || row.game_state?.botDifficulty || row.botDifficulty || "")
        : "",
      playerColor: botAnalysis
        ? (row.game_state?.analysis?.playerColor === "dark" ? "dark" : "white")
        : "",
      variant: row.variant === "short" ? "short" : "long",
      access: row.access === "closed" ? "closed" : "open",
      status: row.status || "waiting",
      allowSpectators: Boolean(row.allow_spectators ?? row.allowSpectators),
      spectators: activeSpectatorCount(row.spectators),
      createdAt: row.created_at || row.createdAt || "",
      joinedAt: row.joined_at || row.joinedAt || "",
    };
    if (extras.password) room.password = extras.password;
    return room;
  }

  function isBotAnalysisRow(row) {
    const gameState = row?.game_state;
    const analysis = gameState && typeof gameState === "object" ? gameState.analysis : null;
    return Boolean(
      analysis?.mode === "bot" ||
      analysis?.opponent === "bot" ||
      gameState?.mode === "bot" ||
      gameState?.opponent === "bot"
    );
  }

  async function currentAuthContext(options = {}) {
    const { signal } = options;
    throwIfAborted(signal);
    const client = await supabase({ signal });
    throwIfAborted(signal);
    let session = null;
    if (client.auth.getSession) {
      const { data: sessionData, error: sessionError } = await awaitWithAbort(client.auth.getSession(), signal);
      if (sessionError) {
        if (isMissingAuthSession(sessionError)) throw missingAuthSessionError();
        throw supabaseError(sessionError, "Supabase auth failed.");
      }
      session = sessionData?.session || null;
      if (!session?.user?.id && client.auth.refreshSession) {
        const { data: refreshData, error: refreshError } = await awaitWithAbort(client.auth.refreshSession(), signal);
        if (refreshError && !isMissingAuthSession(refreshError)) throw supabaseError(refreshError, "Supabase auth refresh failed.");
        session = refreshData?.session || null;
      }
      if (!session?.user?.id) throw missingAuthSessionError();
    }
    let { data: authData, error: authError } = await awaitWithAbort(client.auth.getUser(), signal);
    if (authError && isMissingAuthSession(authError) && client.auth.refreshSession) {
      const { data: refreshData, error: refreshError } = await awaitWithAbort(client.auth.refreshSession(), signal);
      if (!refreshError && refreshData?.session?.user?.id) {
        ({ data: authData, error: authError } = await awaitWithAbort(client.auth.getUser(), signal));
      }
    }
    if (authError) {
      if (isMissingAuthSession(authError)) throw missingAuthSessionError();
      throw supabaseError(authError, "Supabase auth failed.");
    }
    const authUser = authData?.user;
    if (!authUser?.id) throw missingAuthSessionError();

    let profileQuery = client
      .from("profiles")
      .select("id,nickname,email,rating,tier,rating_eligible,banned_at,banned_reason")
      .eq("id", authUser.id);
    profileQuery = withAbortSignal(profileQuery, signal);
    let { data: profile, error: profileError } = await awaitWithAbort(profileQuery.maybeSingle(), signal);
    throwIfAborted(signal);
    if (profileError) throw supabaseError(profileError, "Could not load profile.");
    if (profile?.banned_at) {
      throw roomError(profile.banned_reason || "Аккаунт заблокирован администратором.", 403);
    }

    const localUser = window.NarduApp?.getUser?.() || {};
    const metadata = authUser.user_metadata || {};
    const nickname = profile?.nickname || await createMissingProfile(client, authUser, localUser, metadata, { signal });
    await touchProfileHeartbeat(client, authUser.id, { signal });
    const rating = normalizeRating(profile?.rating ?? localUser.rating);
    return {
      client,
      authUser,
      profile: {
        id: authUser.id,
        name: nickname,
        rating,
        registered: true,
        ratingEligible: profile?.rating_eligible !== false,
      },
    };
  }

  async function createMissingProfile(client, authUser, localUser = {}, metadata = {}, options = {}) {
    const { signal } = options;
    const baseNickname = String(metadata.nickname || metadata.name || localUser.nickname || localUser.name || authUser.email?.split("@")[0] || "Player")
      .trim()
      .slice(0, 20) || "Player";
    const email = authUser.email || localUser.email || "";
    const rating = normalizeRating(localUser.rating);
    const tier = ratingTierFor(rating);
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      throwIfAborted(signal);
      const nickname = attempt === 0
        ? baseNickname
        : `${baseNickname.slice(0, Math.max(3, 17 - String(attempt).length))}${attempt}`;
      let query = client
        .from("profiles")
        .insert({
          id: authUser.id,
          nickname,
          email,
          rating,
          tier,
          rating_eligible: true,
          last_seen_at: new Date().toISOString(),
        })
        .select("id,nickname,email,rating,tier,rating_eligible");
      query = withAbortSignal(query, signal);
      const { data, error } = await awaitWithAbort(query.maybeSingle(), signal);
      throwIfAborted(signal);
      if (!error && data) return data.nickname;
      lastError = error;
      if (error?.code !== "23505") break;
    }
    throw supabaseError(lastError, "Could not create profile.");
  }

  async function getRoomRow(code, { includePassword = false, maybeClosed = false, signal } = {}) {
    throwIfAborted(signal);
    const client = await supabase({ signal });
    const columns = includePassword ? "*" : "id,code,variant,access,status,host_user_id,guest_user_id,host_guest_id,guest_guest_id,host_name,guest_name,host_rating,guest_rating,host_registered,guest_registered,allow_spectators,spectators,game_state,created_at,joined_at,updated_at";
    let query = client
      .from("rooms")
      .select(columns)
      .eq("code", normalizeCode(code));
    if (!maybeClosed) query = query.neq("status", "closed");
    query = withAbortSignal(query, signal);
    const { data, error } = await awaitWithAbort(query.maybeSingle(), signal);
    throwIfAborted(signal);
    if (error) throw supabaseError(error, "Could not load room.");
    if (data?.id) roomIdCache.set(normalizeCode(code), data.id);
    return data || null;
  }

  function normalizedGuestId(value) {
    const guestId = String(value || "").trim();
    return /^guest:sha256:[0-9a-f]{64}$/.test(guestId) ? guestId : "";
  }

  function playerIdentity(authUser = null) {
    if (authUser?.id) return { userId: String(authUser.id), guestId: "" };
    const localUser = window.NarduApp?.getUser?.() || {};
    return localUser.guest === true
      ? { userId: "", guestId: normalizedGuestId(localUser.id) }
      : { userId: "", guestId: "" };
  }

  function isParticipant(row, identity) {
    if (!row || !identity) return false;
    if (identity.userId && (row.host_user_id === identity.userId || row.guest_user_id === identity.userId)) {
      return true;
    }
    return Boolean(
      identity.guestId
      && (row.host_guest_id === identity.guestId || row.guest_guest_id === identity.guestId)
    );
  }

  function localUserIsGuest() {
    return window.NarduApp?.getUser?.()?.guest === true;
  }

  async function roomClientContext(options = {}) {
    const { signal } = options;
    throwIfAborted(signal);
    if (localUserIsGuest()) {
      const client = await supabase({ signal });
      throwIfAborted(signal);
      await awaitWithAbort(client.auth.signOut().catch(() => {}), signal);
      return {
        client,
        authUser: null,
        profile: {},
        guest: true,
      };
    }
    return { ...(await currentAuthContext({ signal })), guest: false };
  }

  async function findActiveRoomFor(client, identity, options = {}) {
    const { signal, excludeCode = "" } = options;
    throwIfAborted(signal);
    const filters = [];
    if (identity?.userId) {
      filters.push(`host_user_id.eq.${identity.userId}`, `guest_user_id.eq.${identity.userId}`);
    }
    if (identity?.guestId) {
      filters.push(`host_guest_id.eq.${identity.guestId}`, `guest_guest_id.eq.${identity.guestId}`);
    }
    if (!filters.length) return null;
    let query = client
      .from("rooms")
      .select("*")
      .or(filters.join(","))
      .in("status", ["waiting", "joined"])
      .order("updated_at", { ascending: false })
      .limit(50);
    query = withAbortSignal(query, signal);
    const { data, error } = await awaitWithAbort(query, signal);
    throwIfAborted(signal);
    if (error) throw supabaseError(error, "Could not check active room.");
    const excluded = normalizeCode(excludeCode);
    return (data || []).find(row => !excluded || normalizeCode(row.code) !== excluded) || null;
  }

  function isActiveRoomConstraintError(error) {
    const text = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
    return error?.code === "23505" || /ACTIVE_ROOM_CONFLICT|one active room|active room per player/i.test(text);
  }

  function activeRoomError(row, extras = {}) {
    return roomError(
      "У вас уже есть активная игровая комната. Сначала вернитесь в неё или закройте её.",
      409,
      { room: publicRoom(row, extras) },
    );
  }

  async function getActiveRoom(options = {}) {
    const { signal } = options;
    throwIfAborted(signal);
    if (!configured()) {
      const localUser = window.NarduApp?.getUser?.() || {};
      const guestId = localUser.guest === true ? normalizedGuestId(localUser.id) : "";
      return apiJson("/api/rooms/active", {
        headers: guestId ? { "X-Guest-Id": guestId } : {},
        signal,
      });
    }
    const { client, authUser } = await roomClientContext({ signal });
    const identity = playerIdentity(authUser);
    const row = await findActiveRoomFor(client, identity, { signal });
    return { room: publicRoom(row) };
  }

  async function listRooms() {
    if (!configured()) return apiJson("/api/rooms");
    const client = await supabase();
    const { data, error } = await client
      .from("rooms")
      .select("id,code,variant,access,status,host_user_id,guest_user_id,host_guest_id,guest_guest_id,host_name,guest_name,host_rating,guest_rating,host_registered,guest_registered,allow_spectators,spectators,game_state,created_at,joined_at,updated_at")
      .in("status", ["waiting", "joined"])
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw supabaseError(error, "Could not load rooms.");
    const visibleRows = (data || []).filter(row => !isBotAnalysisRow(row));
    visibleRows.forEach(row => {
      if (row.id) roomIdCache.set(normalizeCode(row.code), row.id);
    });
    return { rooms: visibleRows.map(row => publicRoom(row)) };
  }

  async function createRoom(payload = {}) {
    if (!configured()) {
      return apiJson("/api/rooms", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    const { client, authUser, profile, guest } = await roomClientContext();
    const roomProfile = localRoomProfile(profile);
    const identity = playerIdentity(authUser);
    if (guest && !identity.guestId) throw roomError("Не удалось подтвердить гостевую сессию.", 401);
    const activeRoom = await findActiveRoomFor(client, identity);
    if (activeRoom) {
      throw activeRoomError(activeRoom, { password: payload.password || "" });
    }

    const access = payload.access === "closed" ? "closed" : "open";
    const password = access === "closed" ? String(payload.password || "").trim() : "";
    if (access === "closed" && password.length < 4) {
      throw roomError("Введите пароль закрытой игры минимум из 4 символов.", 400);
    }

    const passwordHash = access === "closed" ? await sha256Hex(password) : null;
    const baseRow = {
      variant: payload.variant === "short" ? "short" : "long",
      access,
      password_hash: passwordHash,
      status: "waiting",
      host_user_id: authUser?.id || null,
      host_guest_id: guest ? identity.guestId : null,
      guest_user_id: null,
      guest_guest_id: null,
      host_name: roomProfile.name,
      host_rating: roomProfile.registered ? roomProfile.rating : null,
      host_registered: roomProfile.registered,
      presence: { white: null, dark: null },
      left_players: {},
      allow_spectators: payload.allowSpectators === true,
      spectators: {},
    };

    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { data, error } = await client
        .from("rooms")
        .insert({ ...baseRow, code: createRoomCode() })
        .select("*")
        .single();
      if (!error) {
        const normalizedCode = normalizeCode(data.code);
        roomIdCache.set(normalizedCode, data.id);
        // Codes can be reused after a deleted legacy room. Never inherit its
        // cached protocol or epoch: these fields are stamped by the database.
        fairDicePolicies.set(normalizedCode, {
          required: data.fair_dice_required === true,
          gameId: data.fair_dice_game_id || null,
          ...(typeof data.fair_dice_protocol === 'string' ? { protocol: data.fair_dice_protocol } : {}),
        });
        return { room: publicRoom(data, { password }) };
      }
      lastError = error;
      if (isActiveRoomConstraintError(error)) {
        const existingRoom = await findActiveRoomFor(client, identity);
        if (existingRoom) {
          throw activeRoomError(existingRoom, { password });
        }
      }
      if (error.code !== "23505") break;
    }
    throw supabaseError(lastError, "Could not create room.");
  }

  async function ensureBotAnalysisRoom(payload = {}) {
    const normalizedCode = normalizeCode(payload.code);
    fairDicePolicies.delete(normalizedCode);
    if (!normalizedCode) throw roomError("Не указан код партии для анализа.", 400);

    const neuralBot = payload.difficulty === NEURAL_BOT_DIFFICULTY || isNeuralBotState(payload.state);
    if (neuralBot && ((payload.variant != null && payload.variant !== "long")
      || (payload.state?.variant != null && payload.state.variant !== "long"))) {
      throw roomError("Сложный бот-нейро доступен только для длинных нард.", 422);
    }
    const variant = payload.variant === "short" ? "short" : "long";
    const botName = neuralBot ? NEURAL_BOT_METADATA.name
      : String(payload.botName || payload.guestName || "Bot").trim().slice(0, 32) || "Bot";
    const botRating = neuralBot ? 1500 : normalizeRating(payload.botRating);
    const state = payload.state && typeof payload.state === "object"
      ? JSON.parse(JSON.stringify(payload.state))
      : {};
    state.mode = "bot";
    state.variant = variant;
    state.roomCode = normalizedCode;
    state.analysis = {
      ...(state.analysis || {}),
      mode: "bot",
      opponent: "bot",
      difficulty: String(payload.difficulty || state.botDifficulty || "").slice(0, 20),
      botName,
      playerColor: payload.playerColor === "dark" ? "dark" : "white",
      updatedAt: new Date().toISOString(),
    };
    if (neuralBot) canonicalNeuralBotState(state);

    if (!configured()) {
      const localUser = window.NarduApp?.getUser?.() || {};
      const roomProfile = localRoomProfile();
      const ownerToken = botAnalysisOwnerToken(normalizedCode);
      return apiJson("/api/rooms/bot-analysis", {
        method: "POST",
        body: JSON.stringify({
          code: normalizedCode,
          variant,
          botName,
          botRating,
          difficulty: neuralBot ? NEURAL_BOT_DIFFICULTY : String(payload.difficulty || state.botDifficulty || "").slice(0, 20),
          playerColor: payload.playerColor === "dark" ? "dark" : "white",
          state,
          hostName: roomProfile.name,
          hostUserId: localUser.id || "",
          hostRatingEligible: roomProfile.ratingEligible,
          ownerToken,
        }),
      });
    }

    const { client, authUser, profile, guest } = await roomClientContext();
    const identity = playerIdentity(authUser);
    if (guest && !identity.guestId) throw roomError("Не удалось подтвердить гостевую сессию.", 401);
    const roomProfile = localRoomProfile(profile, { registered: Boolean(authUser?.id) });

    const { data: existing, error: existingError } = await client
      .from("rooms")
      .select("id,code,status,host_user_id,host_guest_id,game_state,game_version")
      .eq("code", normalizedCode)
      .neq("status", "closed")
      .maybeSingle();
    if (existingError) throw supabaseError(existingError, "Could not load bot analysis room.");
    if (existing?.id) {
      const ownsExisting = authUser?.id
        ? existing.host_user_id === authUser.id
        : existing.host_guest_id === identity.guestId;
      if (!ownsExisting) {
        throw roomError("Код партии уже занят другой комнатой.", 409);
      }
      if (neuralBot !== isNeuralBotState(existing.game_state)) {
        throw roomError("Нельзя менять тип уже созданной бот-партии.", 409);
      }
      roomIdCache.set(normalizedCode, existing.id);
      if (!isBotAnalysisRow(existing)) throw roomError("Код партии уже занят онлайн-комнатой.", 409);
      return {
        ok: true,
        existing: true,
        version: Number(existing.game_version || 0),
      };
    }

    const activeRoom = await findActiveRoomFor(client, identity, { excludeCode: normalizedCode });
    if (activeRoom) throw activeRoomError(activeRoom);

    const now = new Date().toISOString();
    const { data, error } = await client
      .from("rooms")
      .insert({
        code: normalizedCode,
        variant,
        access: "open",
        status: "joined",
        host_user_id: authUser?.id || null,
        host_guest_id: guest ? identity.guestId : null,
        guest_user_id: null,
        guest_guest_id: null,
        host_name: roomProfile.name,
        host_rating: roomProfile.registered ? roomProfile.rating : null,
        host_registered: roomProfile.registered,
        guest_name: botName,
        guest_rating: botRating,
        guest_registered: false,
        joined_at: now,
        presence: {
          [payload.playerColor === "dark" ? "dark" : "white"]: {
            name: roomProfile.name,
            lastSeen: Date.now(),
          },
        },
        left_players: {},
        game_state: state,
        game_version: 0,
      })
      .select("id,game_version")
      .maybeSingle();
    if (error) {
      if (isActiveRoomConstraintError(error)) {
        const conflictingRoom = await findActiveRoomFor(client, identity, { excludeCode: normalizedCode });
        if (conflictingRoom) throw activeRoomError(conflictingRoom);
      }
      throw supabaseError(error, "Could not create bot analysis room.");
    }
    if (data?.id) roomIdCache.set(normalizedCode, data.id);
    return { ok: true, existing: false, version: Number(data?.game_version || 0) };
  }

  async function getRoom(code, options = {}) {
    const { signal } = options;
    throwIfAborted(signal);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizeCode(code))}`, { signal });
    }
    const row = await getRoomRow(code, { signal });
    if (!row) throw roomError("Комната не найдена.", 404);
    return { room: publicRoom(row) };
  }

  async function joinRoom(code, payload = {}, options = {}) {
    const { signal } = options;
    throwIfAborted(signal);
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/join`, {
        method: "POST",
        body: JSON.stringify(payload),
        signal,
      });
    }

    const { client, authUser, profile, guest } = await roomClientContext({ signal });
    throwIfAborted(signal);
    const identity = playerIdentity(authUser);
    if (guest && !identity.guestId) throw roomError("Не удалось подтвердить гостевую сессию.", 401);
    const roomProfile = localRoomProfile(profile);
    const room = await getRoomRow(normalizedCode, { includePassword: true, signal });
    if (!room) throw roomError("Комната с таким кодом не найдена.", 404);

    if (room.status !== "waiting") {
      if (isParticipant(room, identity)) return { room: publicRoom(room) };
      throw roomError("Эта комната уже занята.", 409);
    }
    if (isParticipant(room, identity)) {
      return { room: publicRoom(room) };
    }
    const activeRoom = await findActiveRoomFor(client, identity, {
      signal,
      excludeCode: normalizedCode,
    });
    if (activeRoom) throw activeRoomError(activeRoom);
    if (room.access === "closed") {
      throwIfAborted(signal);
      const providedHash = await sha256Hex(String(payload.password || "").trim());
      throwIfAborted(signal);
      if (providedHash !== room.password_hash) throw roomError("Неверный пароль закрытой комнаты.", 403);
    }

    throwIfAborted(signal);
    const joinedAt = new Date().toISOString();
    let joinQuery = client
      .from("rooms")
      .update({
        status: "joined",
        guest_user_id: authUser?.id || null,
        guest_guest_id: guest ? identity.guestId : null,
        guest_name: roomProfile.name,
        guest_rating: roomProfile.registered ? roomProfile.rating : null,
        guest_registered: roomProfile.registered,
        joined_at: joinedAt,
        presence: { white: null, dark: null },
        left_players: {},
      })
      .eq("code", normalizedCode)
      .eq("status", "waiting")
      .is("guest_user_id", null)
      .select("*");
    joinQuery = withAbortSignal(joinQuery, signal);
    const { data, error } = await awaitWithAbort(joinQuery.maybeSingle(), signal);
    throwIfAborted(signal);

    if (error) {
      if (isActiveRoomConstraintError(error)) {
        const conflictingRoom = await findActiveRoomFor(client, identity, {
          signal,
          excludeCode: normalizedCode,
        });
        if (conflictingRoom) throw activeRoomError(conflictingRoom);
      }
      throw supabaseError(error, "Could not join room.");
    }
    if (!data) {
      const latest = await getRoomRow(normalizedCode, { includePassword: true, signal });
      if (isParticipant(latest, identity)) return { room: publicRoom(latest) };
      throw roomError("Эта комната уже занята.", 409);
    }
    roomIdCache.set(normalizedCode, data.id);
    return { room: publicRoom(data) };
  }

  async function deleteRoom(code, options = {}) {
    const normalizedCode = normalizeCode(code);
    const { signal } = options;
    throwIfAborted(signal);
    if (options.waitingOnly !== true) {
      throw roomError("Закрытие комнаты требует точного безопасного режима.", 400);
    }
    if (!configured()) {
      const guestId = playerIdentity().guestId;
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}?waiting=1`, {
        method: "DELETE",
        headers: guestId ? { "X-Guest-Id": guestId } : {},
        signal,
      });
    }
    return closeWaitingRoom(normalizedCode, { signal });
  }

  async function closeWaitingRoom(code, options = {}) {
    const normalizedCode = normalizeCode(code);
    const { signal } = options;
    throwIfAborted(signal);
    if (!configured()) {
      return deleteRoom(normalizedCode, { waitingOnly: true, signal });
    }

    const { client, authUser, guest } = await roomClientContext({ signal });
    const identity = playerIdentity(authUser);
    if (guest && !identity.guestId) throw roomError("Не удалось подтвердить гостевую сессию.", 401);

    // A closed room is deliberately hidden by the rooms SELECT policy.  A
    // direct UPDATE from waiting -> closed is consequently rejected by RLS
    // before the active-room claim can be released.  The RPC keeps that
    // privacy boundary and performs only this ownership-checked transition.
    let query = client.rpc("close_own_waiting_room", {
      p_room_code: normalizedCode,
    });
    query = withAbortSignal(query, signal);
    const { data, error } = await awaitWithAbort(query, signal);
    throwIfAborted(signal);
    if (error) throw supabaseError(error, "Could not close waiting room.");
    const result = data && typeof data === "object" ? data : {};
    return {
      ok: true,
      removed: result.removed === true,
      closed: result.closed === true,
      code: normalizedCode,
      ...(result.room && typeof result.room === "object" ? { room: result.room } : {}),
    };
  }

  async function closeBotRoom(code, options = {}) {
    const normalizedCode = normalizeCode(code);
    const { signal } = options;
    throwIfAborted(signal);
    if (!configured()) {
      const ownerToken = botAnalysisOwnerToken(normalizedCode);
      const guestId = playerIdentity().guestId;
      const result = await apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}?bot=1`, {
        method: "DELETE",
        headers: {
          ...(ownerToken ? { "X-Bot-Owner": ownerToken } : {}),
          ...(guestId ? { "X-Guest-Id": guestId } : {}),
        },
        signal,
      });
      if (result?.ok && (result.removed || result.closed || !result.room)) {
        forgetBotAnalysisOwnerToken(normalizedCode);
      }
      return result;
    }
    if ((await fairDicePolicy(normalizedCode))?.required) {
      const result = await fairDiceJson('leave', { code: normalizedCode }, { signal });
      return { ...result, closed: result.ok === true, removed: result.ok === true, code: normalizedCode };
    }

    const { client, authUser, guest } = await roomClientContext({ signal });
    const identity = playerIdentity(authUser);
    if (guest && !identity.guestId) throw roomError("Не удалось подтвердить гостевую сессию.", 401);
    const current = await getRoomRow(normalizedCode, { includePassword: true, maybeClosed: true, signal });
    if (!current || current.status === "closed" || current.status === "over") {
      forgetBotAnalysisOwnerToken(normalizedCode);
      return { ok: true, removed: false, closed: true, code: normalizedCode };
    }
    const ownsCurrent = identity.userId
      ? current.host_user_id === identity.userId
      : current.host_guest_id === identity.guestId;
    if (!ownsCurrent || !isBotAnalysisRow(current)) {
      throw roomError("Закрыть бот-партию может только её создатель.", 403);
    }

    const closeAtVersion = async expectedVersion => {
      let query = client.rpc("close_own_bot_room", {
        p_room_code: normalizedCode,
        p_expected_version: expectedVersion,
      });
      query = withAbortSignal(query, signal);
      const { data, error } = await awaitWithAbort(query, signal);
      throwIfAborted(signal);
      if (error) throw supabaseError(error, "Could not close bot room.");
      return data && typeof data === "object" ? data : {};
    };

    const currentVersion = Math.max(0, Number(current.game_version) || 0);
    let payload = await closeAtVersion(currentVersion);
    const retryVersion = Number(payload?.room?.version);
    if (
      payload?.closed !== true &&
      payload?.conflict === true &&
      payload?.room?.status === "joined" &&
      Number.isInteger(retryVersion) &&
      retryVersion > currentVersion
    ) {
      // A final autosave may win the first compare-and-swap while the player
      // is pressing Lobby. Retry exactly once with the server-returned
      // version; never loop indefinitely against a still-running writer.
      payload = await closeAtVersion(retryVersion);
    }
    const result = {
      ok: true,
      removed: payload.removed === true,
      closed: payload.closed === true,
      code: normalizedCode,
      ...(payload.conflict === true ? { conflict: true } : {}),
      ...(Number.isInteger(Number(payload.version)) ? { version: Number(payload.version) } : {}),
      ...(payload.room && typeof payload.room === "object" ? { room: payload.room } : {}),
    };
    if (result.closed) forgetBotAnalysisOwnerToken(normalizedCode);
    return result;
  }

  async function closeOwnLobbyRooms(payload = {}) {
    const codes = [...new Set((payload.codes || []).map(normalizeCode).filter(Boolean))];
    const closed = [];
    for (const code of codes) {
      const result = await closeWaitingRoom(code);
      if (result.removed || result.closed === true) closed.push(code);
    }
    return { ok: true, closedCodes: closed };
  }

  const closeOwnWaitingRooms = closeOwnLobbyRooms;

  function finalGameState(state) {
    return Boolean(state && (state.phase === "over" || state.winner));
  }

  function isNeuralBotState(state) {
    return state?.botDifficulty === NEURAL_BOT_DIFFICULTY
      || state?.analysis?.difficulty === NEURAL_BOT_DIFFICULTY;
  }

  function canonicalNeuralBotState(state) {
    state.mode = "bot";
    state.opponent = "bot";
    state.variant = "long";
    state.botDifficulty = NEURAL_BOT_DIFFICULTY;
    state.analysis = {
      ...(state.analysis || {}), mode: "bot", opponent: "bot", difficulty: NEURAL_BOT_DIFFICULTY,
      botName: NEURAL_BOT_METADATA.name, neuralModel: {
        ...(state.analysis?.neuralModel && typeof state.analysis.neuralModel === "object"
          && !Array.isArray(state.analysis.neuralModel) ? state.analysis.neuralModel : {}), ...NEURAL_BOT_METADATA,
      },
    };
    return state;
  }

  function publishedBotState(state) {
    if (!isNeuralBotState(state)) return state;
    if (state.variant !== "long" || state.botDifficulty !== NEURAL_BOT_DIFFICULTY
      || (state.analysis?.difficulty && state.analysis.difficulty !== NEURAL_BOT_DIFFICULTY)) {
      throw roomError("Нельзя менять тип или вид нард нейро-партии.", 422);
    }
    return canonicalNeuralBotState(JSON.parse(JSON.stringify(state)));
  }

  async function getGameState(code, options = {}) {
    const { signal } = options;
    throwIfAborted(signal);
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      const ownerToken = botAnalysisOwnerToken(normalizedCode);
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/game`, {
        headers: ownerToken ? { 'X-Bot-Owner': ownerToken } : {},
        signal,
      });
    }
    const client = await supabase({ signal });
    let query = client
      .from("rooms")
      .select("id,game_state,game_version,status,fair_dice_required,fair_dice_game_id,fair_dice_protocol")
      .eq("code", normalizedCode)
      .neq("status", "closed");
    query = withAbortSignal(query, signal);
    let { data, error } = await awaitWithAbort(query.maybeSingle(), signal);
    // A v36 backend still has a protected dice policy. Missing ONLY the new
    // protocol column must never downgrade that policy to legacy/local RNG.
    if (error && ['42703', 'PGRST204'].includes(error.code)
      && /fair_dice_protocol/.test(error.message || '')
      && !/fair_dice_(?:required|game_id)/.test(error.message || '')) {
      let previous = client.from('rooms').select('id,game_state,game_version,status,fair_dice_required,fair_dice_game_id')
        .eq('code', normalizedCode).neq('status', 'closed');
      previous = withAbortSignal(previous, signal);
      ({ data, error } = await awaitWithAbort(previous.maybeSingle(), signal));
    }
    // Before v36 is installed, existing rooms are legacy. Only an explicit
    // missing-column error allows this compatibility read, never an auth,
    // network, service-key or signature failure for a protected room.
    if (error && ['42703', 'PGRST204'].includes(error.code)
      && /fair_dice_(?:required|game_id)/.test(error.message || '')) {
      let legacy = client.from('rooms').select('id,game_state,game_version,status')
        .eq('code', normalizedCode).neq('status', 'closed');
      legacy = withAbortSignal(legacy, signal);
      ({ data, error } = await awaitWithAbort(legacy.maybeSingle(), signal));
    }
    throwIfAborted(signal);
    if (error) throw supabaseError(error, "Could not load game state.");
    if (!data) throw roomError("Комната не найдена.", 404);
    roomIdCache.set(normalizedCode, data.id);
    fairDicePolicies.set(normalizedCode, {
      required: data.fair_dice_required === true, gameId: data.fair_dice_game_id,
      ...(typeof data.fair_dice_protocol === 'string' ? { protocol: data.fair_dice_protocol } : {}),
    });
    return { state: data.game_state || null, version: Number(data.game_version || 0),
      fairDice: fairDicePolicies.get(normalizedCode) || { required: false } };
  }

  function fairDiceConfigured() {
    const env = window.NARDU_ENV || {};
    return configured() && Boolean(env.fairDiceUrl) && /^[0-9a-f]{64}$/.test(env.fairDicePublicKey || '');
  }

  async function fairDicePolicy(code, { refresh = false } = {}) {
    if (!configured()) return { required: false };
    const normalizedCode = normalizeCode(code);
    if (refresh || !fairDicePolicies.has(normalizedCode)) await getGameState(normalizedCode);
    return fairDicePolicies.get(normalizedCode);
  }

  async function fairDiceJson(path, body, options = {}) {
    if (!fairDiceConfigured()) throw roomError("Сервис подтверждённых бросков не настроен.", 503);
    const base = new URL(window.NARDU_ENV.fairDiceUrl);
    if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
      throw roomError("Небезопасный адрес сервиса бросков.", 503);
    }
    if (base.username || base.password || base.search || base.hash) throw roomError("Неверный адрес сервиса бросков.", 503);
    const client = await supabase();
    const { data, error } = await client.auth.getSession();
    if (error) throw supabaseError(error, "Could not load dice session.");
    const token = localUserIsGuest() ? window.NARDU_ENV.supabaseAnonKey
      : data?.session?.access_token || window.NARDU_ENV.supabaseAnonKey;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = window.setTimeout(abort, 12000);
    try {
      const response = await fetch(`${base.href.replace(/\/$/, '')}/${path}`, {
        method: 'POST', cache: 'no-store', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
          ...(window.NarduApp?.guestRequestHeaders?.() || {}) },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      throwIfAborted(controller.signal);
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw roomError("Некорректный ответ сервиса бросков.", 502);
      }
      if (!response.ok) {
        const err = roomError("Подтверждённый бросок временно недоступен. Повторный запрос сохранит те же кости.", response.status, result);
        err.code = result.code || 'FAIR_DICE_UNAVAILABLE';
        throw err;
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw roomError("Сервис бросков не ответил вовремя. Повторный запрос сохранит тот же бросок.", 503);
      }
      if (error?.name === 'SyntaxError') throw roomError("Некорректный ответ сервиса бросков.", 502);
      throw error;
    } finally {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async function requestFairDice(code, { label, color } = {}) {
    const normalizedCode = normalizeCode(code);
    // Refresh the protected epoch after a rematch; it never comes from storage,
    // URL parameters, a bot or the proof's self-declared public key.
    const current = await getGameState(normalizedCode);
    const policy = current.fairDice;
    if (!policy?.required) throw roomError("Эта партия использует прежний протокол бросков.", 422);
    const context = { roomCode: normalizedCode, gameId: policy.gameId, label, color, variant: current.state?.variant };
    const reserved = await fairDiceJson('reserve', { code: normalizedCode, label, color });
    const receipt = reserved.receipt || reserved;
    if (!window.NarduFairDice?.verifyReservation(receipt, window.NARDU_ENV.fairDicePublicKey, context)) {
      throw roomError("Не удалось подтвердить серверную запись броска.", 422);
    }
    if (policy.protocol === 'system-csprng-v1') {
      if (!receipt.request?.commitment || receipt.request.round !== undefined) {
        throw roomError("Сервис вернул другой протокол броска.", 422);
      }
      const storageKey = `narduh-system-dice-current:${normalizedCode}`;
      let observed;
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) {
          if (saved.length > 4096) throw new Error('Invalid stored commitment');
          const value = JSON.parse(saved);
          if (value.requestId === receipt.request.id) {
            if (value.requestHash !== receipt.requestHash || value.commitment !== receipt.request.commitment
              || !/^[0-9a-f]{64}$/.test(value.clientSeed || '')) throw new Error('Conflicting stored commitment');
            observed = value;
          }
        }
      } catch {
        throw roomError("Не удалось сохранить обязательство броска. Разрешите хранилище сайта и повторите тот же запрос.", 503);
      }
      // A reconnect can recover the first accepted challenge. It is public,
      // but is not evidence that this particular browser generated its bytes.
      const acceptedSeed = reserved.clientSeed;
      if (acceptedSeed != null && !/^[0-9a-f]{64}$/.test(acceptedSeed)) throw roomError("Некорректный клиентский вклад.", 422);
      if (acceptedSeed && observed && acceptedSeed !== observed.clientSeed) {
        throw roomError("Клиентский вклад не совпадает с сохранёнными данными этого броска. Проверка остановлена.", 422);
      }
      let clientSeed = acceptedSeed || observed?.clientSeed;
      if (!clientSeed) {
        if (typeof window.crypto?.getRandomValues !== 'function') {
          throw roomError("В браузере недоступен защищённый генератор случайных значений.", 503);
        }
        // Receipt was verified above. No client entropy exists before it.
        const bytes = new Uint8Array(32);
        window.crypto.getRandomValues(bytes);
        clientSeed = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      }
      const witness = { requestId: receipt.request.id, requestHash: receipt.requestHash,
        commitment: receipt.request.commitment, clientSeed,
        ownContribution: observed ? observed.ownContribution === true : !acceptedSeed };
      try { window.localStorage.setItem(storageKey, JSON.stringify(witness)); }
      catch { throw roomError("Не удалось сохранить данные проверки броска. Освободите хранилище сайта и повторите тот же запрос.", 503); }
      const result = await fairDiceJson('challenge', { code: normalizedCode, requestId: receipt.request.id,
        requestHash: receipt.requestHash, clientSeed });
      if (!result.proof || result.proof.protocol !== policy.protocol
        || result.proof.requestHash !== receipt.requestHash
        || result.proof.receiptSignature !== receipt.receiptSignature
        || result.proof.request?.id !== receipt.request.id) throw roomError("Доказательство не относится к зарезервированному броску.", 422);
      const verified = await window.NarduFairDice.verifyProof(result.proof, {
        publicKey: window.NARDU_ENV.fairDicePublicKey, context, clientSeed,
      });
      if (!verified.commitmentVerified || !verified.reservationVerified) throw roomError("Обязательство или расчёт броска не подтверждены.", 422);
      return result.proof;
    }
    if (policy.protocol && policy.protocol !== 'drand-quicknet-v1') {
      throw roomError("Протокол этой комнаты не поддерживается. Обновите страницу.", 422);
    }
    if (receipt.request?.commitment !== undefined) throw roomError("Сервис вернул другой протокол броска.", 422);
    // All polling is for THIS immutable request. There is deliberately no
    // browser RNG, alternate nonce, beacon 'latest', or local fallback here.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const result = await fairDiceJson('result', { code: normalizedCode, requestId: receipt.request.id });
      if (result.proof) {
        if (result.proof.requestHash !== receipt.requestHash
          || result.proof.receiptSignature !== receipt.receiptSignature
          || result.proof.request?.id !== receipt.request.id) {
          throw roomError("Доказательство не относится к зарезервированному броску.", 422);
        }
        const verified = await window.NarduFairDice.verifyProof(result.proof, {
          publicKey: window.NARDU_ENV.fairDicePublicKey, context,
        });
        if (!verified.sourceVerified || !verified.reservationVerified) throw roomError("Подпись источника броска не подтверждена.", 422);
        return result.proof;
      }
      await new Promise(resolve => window.setTimeout(resolve, 750));
    }
    throw roomError("Источник броска задерживается. Повторный запрос продолжит тот же бросок.", 503);
  }

  async function putGameState(code, state, version = 0) {
    state = publishedBotState(state);
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      const ownerToken = botAnalysisOwnerToken(normalizedCode);
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/game`, {
        method: "PUT",
        body: JSON.stringify({ state, version, ownerToken }),
      });
    }
    if ((await fairDicePolicy(normalizedCode))?.required) {
      const result = await fairDiceJson('state', { code: normalizedCode, state, version: Number(version) || 0 });
      if (result.gameId) fairDicePolicies.set(normalizedCode, { ...fairDicePolicies.get(normalizedCode), required: true, gameId: result.gameId });
      return result;
    }
    const client = await supabase();
    const nextVersion = Math.max(0, Number(version) || 0) + 1;
    const updates = {
      game_state: state,
      game_version: nextVersion,
    };
    if (finalGameState(state)) {
      updates.status = "over";
      updates.archived_at = new Date().toISOString();
      updates.closed_reason = "finished";
    } else if (state?.phase !== "waiting") {
      updates.status = "joined";
      updates.archived_at = null;
      updates.closed_reason = null;
    }
    const { data, error } = await client
      .from("rooms")
      .update(updates)
      .eq("code", normalizedCode)
      .eq("game_version", Number(version) || 0)
      .eq("status", "joined")
      .select("game_version")
      .maybeSingle();
    if (error) throw supabaseError(error, "Could not save game state.");
    if (!data) {
      throw roomError("Состояние комнаты уже обновлено другим клиентом. Подтягиваем актуальный ход.", 409);
    }
    return { ok: true, version: nextVersion };
  }

  async function finishRoomGame(code, finalState, version = 0, trainingState = null) {
    finalState = publishedBotState(finalState);
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      const ownerToken = botAnalysisOwnerToken(normalizedCode);
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/game`, {
        method: "PUT",
        body: JSON.stringify({ state: finalState, version: Number(version) || 0, ownerToken }),
      });
    }
    const { client, authUser, guest } = await roomClientContext();
    const payload = JSON.parse(JSON.stringify(finalState || {}));
    let fairSaved = null;
    if ((await fairDicePolicy(normalizedCode))?.required) {
      fairSaved = await putGameState(normalizedCode, payload, version);
    }
    if (guest && !authUser?.id) {
      const saved = fairSaved || await putGameState(normalizedCode, payload, version);
      return { ...saved, trainingArchived: false };
    }
    const args = {
      p_room_code: normalizedCode,
      p_final_state: payload,
    };
    if (!isNeuralBotState(payload) && trainingState && typeof trainingState === "object") {
      args.p_training_state = JSON.parse(JSON.stringify(trainingState));
    }
    let { data, error } = await client.rpc("finish_room_game", args);
    let usedLegacyFinalizer = false;
    if (
      error &&
      args.p_training_state &&
      (
        error.code === "PGRST202" ||
        /Could not find the function .*finish_room_game.*p_training_state|schema cache/i.test(error.message || "")
      )
    ) {
      usedLegacyFinalizer = true;
      ({ data, error } = await client.rpc("finish_room_game", {
        p_room_code: normalizedCode,
        p_final_state: payload,
      }));
    }
    if (error) throw supabaseError(error, "Could not finish room game.");
    return {
      ...(data || { ok: true }),
      ...(fairSaved ? { version: fairSaved.version } : {}),
      trainingArchived: isNeuralBotState(payload) || usedLegacyFinalizer ? false : data?.trainingArchived === true,
    };
  }

  async function archiveBotTrainingGame(code, finalState = null) {
    // Neural decisions are archived in the normal completed-room final_state,
    // never in the legacy hard-only XP / causal-learning ingestion queue.
    if (isNeuralBotState(finalState)) return { skipped: true, reason: "neural-analysis-separate" };
    if (!configured()) return { skipped: true };
    const client = await supabase();
    const args = {
      p_room_code: normalizeCode(code),
    };
    if (finalState && typeof finalState === "object") {
      args.p_final_state = JSON.parse(JSON.stringify(finalState));
    }
    let { data, error } = await client.rpc("archive_bot_training_game", args);
    if (error && args.p_final_state && /function .*archive_bot_training_game|Could not find the function|schema cache/i.test(error.message || "")) {
      ({ data, error } = await client.rpc("archive_bot_training_game", {
        p_room_code: args.p_room_code,
      }));
    }
    if (error) throw supabaseError(error, "Could not archive bot training game.");
    return data || { ok: true };
  }

  function supersededLongBotExperienceError() {
    const error = new Error("Long-bot experience load was superseded.");
    error.code = "LONG_BOT_EXPERIENCE_SUPERSEDED";
    return error;
  }

  async function loadLongBotExperience({ refresh = false, playerName = "" } = {}) {
    if (!configured()) return [];
    const engine = window.NarduLongBotEngine;
    const resolvedPlayerName = String(
      playerName
      || window.NarduApp?.getUser?.()?.nickname
      || window.NarduApp?.getUser?.()?.name
      || "",
    ).trim().slice(0, 32);
    const playerKey = resolvedPlayerName.toLocaleLowerCase();
    const loadGeneration = ++longBotExperienceLoadGeneration;
    const cachedPatterns = refresh ? [] : readLongBotExperienceCache(playerKey);
    engine?.setExperience?.([], "server");
    engine?.setExperience?.([], "server-cache");
    if (cachedPatterns.length) {
      engine?.setExperience?.(cachedPatterns, "server-cache");
    }
    let experiencePromise = !refresh ? longBotExperiencePromises.get(playerKey) : null;
    if (!experiencePromise) {
      experiencePromise = (async () => {
        const client = await supabase();
        const { data, error } = await client.rpc("get_long_bot_experience_patterns", {
          p_player_name: resolvedPlayerName || null,
        });
        if (error) throw supabaseError(error, "Could not load long-bot experience.");
        const patterns = validatedLongBotExperience(data, { trustedRpc: true });
        if (!patterns) {
          console.warn("Ignored incompatible long-bot experience generation.");
          return { patterns: cachedPatterns, fresh: false };
        }
        return { patterns, fresh: true };
      })();
      longBotExperiencePromises.set(playerKey, experiencePromise);
      experiencePromise.finally(() => {
        if (longBotExperiencePromises.get(playerKey) === experiencePromise) {
          longBotExperiencePromises.delete(playerKey);
        }
      }).catch(() => {});
    }
    const currentPromise = experiencePromise.then(result => {
      if (loadGeneration !== longBotExperienceLoadGeneration) {
        throw supersededLongBotExperienceError();
      }
      const patterns = validatedLongBotExperience(result?.patterns, {
        trustedRpc: result?.fresh === true,
      }) || [];
      if (result?.fresh === true) {
        engine?.setExperience?.([], "server-cache");
        engine?.setExperience?.(patterns, "server");
        writeLongBotExperienceCache(patterns, playerKey);
      }
      return patterns;
    });
    if (cachedPatterns.length && !refresh) {
      currentPromise.catch(() => {});
      return cachedPatterns;
    }
    return currentPromise;
  }

  async function loadShortBotExperience({ refresh = false, playerName = "" } = {}) {
    if (!configured() || !window.NarduShortBotEngine?.setExperience) return [];
    const resolvedPlayerName = String(
      playerName
      || window.NarduApp?.getUser?.()?.nickname
      || window.NarduApp?.getUser?.()?.name
      || "",
    ).trim().slice(0, 32);
    const playerKey = resolvedPlayerName.toLocaleLowerCase();
    const loadGeneration = ++shortBotExperienceLoadGeneration;
    const cachedPatterns = refresh ? [] : readShortBotExperienceCache(playerKey);
    window.NarduShortBotEngine.setExperience([], "server");
    window.NarduShortBotEngine.setExperience([], "server-cache");
    if (cachedPatterns.length) {
      window.NarduShortBotEngine.setExperience(cachedPatterns, "server-cache");
    }
    if (shortBotExperiencePromises.has(playerKey) && !refresh) {
      const currentPromise = shortBotExperiencePromises.get(playerKey).then(patterns => {
        const validated = validatedShortBotExperience(patterns);
        if (validated && loadGeneration === shortBotExperienceLoadGeneration) {
          window.NarduShortBotEngine.setExperience(validated, "server");
          writeShortBotExperienceCache(validated, playerKey);
        }
        return validated || [];
      });
      if (cachedPatterns.length) {
        currentPromise.catch(() => {});
        return cachedPatterns;
      }
      return currentPromise;
    }
    const experiencePromise = (async () => {
      const client = await supabase();
      const { data, error } = await client.rpc("get_short_bot_experience_patterns", {
        p_player_name: resolvedPlayerName || null,
      });
      if (error) throw supabaseError(error, "Could not load short-bot experience.");
      const patterns = validatedShortBotExperience(data);
      if (!patterns) {
        console.warn("Ignored incompatible short-bot experience generation.");
        return cachedPatterns;
      }
      if (loadGeneration === shortBotExperienceLoadGeneration) {
        window.NarduShortBotEngine.setExperience([], "server-cache");
        window.NarduShortBotEngine.setExperience(patterns, "server");
        writeShortBotExperienceCache(patterns, playerKey);
      }
      return patterns;
    })();
    shortBotExperiencePromises.set(playerKey, experiencePromise);
    experiencePromise.finally(() => {
      if (shortBotExperiencePromises.get(playerKey) === experiencePromise) {
        shortBotExperiencePromises.delete(playerKey);
      }
    }).catch(() => {});
    if (cachedPatterns.length && !refresh) {
      experiencePromise.catch(() => {});
      return cachedPatterns;
    }
    return experiencePromise;
  }

  function opponentColor(color) {
    return color === "dark" ? "white" : "dark";
  }

  function latestGameActivityMs(room, color) {
    const history = Array.isArray(room?.game_state?.history) ? room.game_state.history : [];
    const latest = history.find(item => item?.color === color && item.at);
    const parsed = Date.parse(latest?.at || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function networkLossMessage() {
    return "Соединение потеряно";
  }

  function forceNetworkLossState(room, loserColor, nowMs = Date.now()) {
    const winnerColor = opponentColor(loserColor);
    const at = new Date(nowMs).toISOString();
    const state = room?.game_state && typeof room.game_state === "object"
      ? JSON.parse(JSON.stringify(room.game_state))
      : {
          points: {},
          off: { white: 0, dark: 0 },
          score: { white: 0, dark: 0 },
          history: [],
          matchScore: { white: 0, dark: 0, target: 5, recordedWinner: null },
        };
    state.dice = [];
    state.rolled = [];
    state.winner = winnerColor;
    state.resultType = null;
    state.phase = "over";
    state.finishedAt ||= nowMs;
    state.networkLoss = {
      loserColor,
      winnerColor,
      message: networkLossMessage(),
      at,
    };
    state.history ||= [];
    if (!state.history.some(item => item?.networkLoss && item.at === at)) {
      state.history.unshift({
        networkLoss: true,
        color: loserColor,
        winnerColor,
        message: networkLossMessage(),
        at,
      });
    }
    return state;
  }

  function publicPresence(room, viewerColor) {
    const nowMs = Date.now();
    const presence = room?.presence || {};
    const opponent = opponentColor(viewerColor);
    const opponentPresence = presence[opponent] || null;
    const lastSeen = Math.max(
      Number(opponentPresence?.lastSeen || 0),
      latestGameActivityMs(room, opponent),
    );
    const disconnectedAt = lastSeen && nowMs > lastSeen + PRESENCE_STALE_MS
      ? opponentPresence.disconnectedAt || lastSeen + PRESENCE_STALE_MS
      : null;
    const deadlineAt = disconnectedAt ? (opponentPresence.deadlineAt || disconnectedAt + NETWORK_GRACE_MS) : null;
    return {
      now: nowMs,
      graceMs: NETWORK_GRACE_MS,
      staleMs: PRESENCE_STALE_MS,
      viewerColor,
      opponent: {
        color: opponent,
        name: opponentPresence?.name || "",
        online: Boolean(lastSeen) && !disconnectedAt,
        disconnected: Boolean(disconnectedAt),
        disconnectedAt,
        deadlineAt,
        remainingMs: disconnectedAt ? Math.max(0, deadlineAt - nowMs) : NETWORK_GRACE_MS,
      },
      networkLoss: room?.game_state?.networkLoss || null,
      gameVersion: Number(room?.game_version || 0),
    };
  }

  async function updatePresence(code, payload = {}, options = {}) {
    const { signal } = options;
    throwIfAborted(signal);
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/presence`, {
        method: "POST",
        body: JSON.stringify(payload),
        signal,
      });
    }
    if ((await fairDicePolicy(normalizedCode))?.required) {
      return fairDiceJson('presence', { code: normalizedCode }, { signal });
    }
    const client = await supabase({ signal });
    throwIfAborted(signal);
    const color = payload.color === "dark" ? "dark" : "white";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let loadQuery = client
        .from("rooms")
        .select("id,presence,game_state,game_version,status,updated_at")
        .eq("code", normalizedCode)
        .neq("status", "closed")
        .maybeSingle();
      loadQuery = withAbortSignal(loadQuery, signal);
      const { data: room, error: loadError } = await awaitWithAbort(loadQuery, signal);
      throwIfAborted(signal);
      if (loadError) throw supabaseError(loadError, "Could not load room presence.");
      if (!room) throw roomError("Комната не найдена.", 404);
      if (room.status === "over" || finalGameState(room.game_state)) {
        return {
          ok: true,
          presence: publicPresence(room, color),
          state: room.game_state || null,
          version: Number(room.game_version || 0),
        };
      }

      const nowMs = Date.now();
      const presence = {
        ...(room.presence || {}),
        [color]: {
          ...(room.presence?.[color] || {}),
          color,
          name: String(payload.name || "").slice(0, 32),
          lastSeen: nowMs,
          disconnectedAt: null,
          deadlineAt: null,
        },
      };
      let gameState = room.game_state || null;
      let gameVersion = Number(room.game_version || 0);
      const opponent = opponentColor(color);
      const opponentPresence = presence[opponent] || room.presence?.[opponent] || null;
      const opponentLastSeen = Math.max(
        Number(opponentPresence?.lastSeen || 0),
        latestGameActivityMs(room, opponent),
      );
      const opponentDisconnectedAt = opponentLastSeen && nowMs > opponentLastSeen + PRESENCE_STALE_MS
        ? opponentPresence.disconnectedAt || opponentLastSeen + PRESENCE_STALE_MS
        : null;
      const opponentDeadlineAt = opponentDisconnectedAt
        ? opponentPresence.deadlineAt || opponentDisconnectedAt + NETWORK_GRACE_MS
        : null;
      if (opponentDisconnectedAt) {
        presence[opponent] = {
          ...(presence[opponent] || {}),
          disconnectedAt: opponentDisconnectedAt,
          deadlineAt: opponentDeadlineAt,
        };
      } else if (presence[opponent]?.disconnectedAt) {
        presence[opponent] = {
          ...(presence[opponent] || {}),
          disconnectedAt: null,
          deadlineAt: null,
        };
      }
      const alreadyOver = gameState?.phase === "over" || gameState?.winner;
      const shouldForceNetworkLoss = opponentDeadlineAt && nowMs >= opponentDeadlineAt && !alreadyOver;
      const updates = { presence };
      if (shouldForceNetworkLoss) {
        gameState = forceNetworkLossState(room, opponent, nowMs);
        gameVersion += 1;
        updates.game_state = gameState;
        updates.game_version = gameVersion;
        updates.status = "over";
        updates.archived_at = new Date(nowMs).toISOString();
        updates.closed_reason = "network_loss";
      }
      let updateQuery = client
        .from("rooms")
        .update(updates)
        .eq("id", room.id)
        .eq("updated_at", room.updated_at)
        .eq("game_version", Number(room.game_version || 0))
        .in("status", ["waiting", "joined"])
        .select("presence,game_state,game_version,status,updated_at")
        .maybeSingle();
      updateQuery = withAbortSignal(updateQuery, signal);
      const { data: updated, error: updateError } = await awaitWithAbort(updateQuery, signal);
      throwIfAborted(signal);
      if (updateError) throw supabaseError(updateError, "Could not update presence.");
      if (!updated) continue;
      return {
        ok: true,
        presence: publicPresence(updated, color),
        state: updated.game_state || gameState || null,
        version: Number(updated.game_version ?? gameVersion ?? 0),
      };
    }
    throw roomError("Состояние присутствия изменилось одновременно. Повторите запрос.", 409, {
      code: "PRESENCE_CONFLICT",
    });
  }

  async function leaveRoom(code, payload = {}) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/leave`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    if ((await fairDicePolicy(normalizedCode))?.required) {
      return fairDiceJson('leave', { code: normalizedCode });
    }
    const { client, authUser, guest } = await roomClientContext();
    const identity = playerIdentity(authUser);
    if (guest && !identity.guestId) throw roomError("Не удалось подтвердить гостевую сессию.", 401);
    const { data: room, error: loadError } = await client
      .from("rooms")
      .select("*")
      .eq("code", normalizedCode)
      .maybeSingle();
    if (loadError) throw supabaseError(loadError, "Could not load room.");
    if (!room) return { ok: true, removed: true };
    const color = identity.userId
      ? (room.host_user_id === identity.userId ? "white" : (room.guest_user_id === identity.userId ? "dark" : ""))
      : (room.host_guest_id === identity.guestId ? "white" : (room.guest_guest_id === identity.guestId ? "dark" : ""));
    if (!color) throw roomError("Покинуть комнату может только участник партии.", 403);
    if (payload.color && payload.color !== color) {
      throw roomError("Нельзя завершить сессию другого участника.", 403);
    }
    const leftPlayers = { ...(room.left_players || {}), [color]: true };
    const shouldClose = room.status === "waiting" || (leftPlayers.white && leftPlayers.dark);
    const updates = {
      left_players: leftPlayers,
      ...(shouldClose ? {
        status: "closed",
        archived_at: new Date().toISOString(),
        closed_reason: "left",
      } : {}),
    };
    let updateQuery = client
      .from("rooms")
      .update(updates)
      .eq("id", room.id)
      .in("status", ["waiting", "joined"]);
    updateQuery = identity.userId
      ? updateQuery.eq(color === "white" ? "host_user_id" : "guest_user_id", identity.userId)
      : updateQuery.eq(color === "white" ? "host_guest_id" : "guest_guest_id", identity.guestId);
    if (room.updated_at) updateQuery = updateQuery.eq("updated_at", room.updated_at);
    const { data: updated, error } = await updateQuery
      .select("*")
      .maybeSingle();
    if (error) throw supabaseError(error, "Could not leave room.");
    if (!updated) throw roomError("Состояние комнаты уже изменилось. Повторите выход.", 409);
    return { ok: true, removed: shouldClose, room: publicRoom(updated || room) };
  }

  async function watchRoom(code, payload = {}, options = {}) {
    const { signal } = options;
    throwIfAborted(signal);
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/spectators`, {
        method: "POST",
        body: JSON.stringify(payload),
        signal,
      });
    }
    const { client, authUser, profile } = await currentAuthContext({ signal });
    const spectatorId = String(payload.spectatorId || authUser.id || "").slice(0, 80);
    const spectatorName = String(payload.name || profile.nickname || "Spectator").slice(0, 32);
    throwIfAborted(signal);
    let query = client.rpc("touch_room_spectator", {
      p_code: normalizedCode,
      p_spectator_id: spectatorId,
      p_spectator_name: spectatorName,
      p_leave: false,
    });
    query = withAbortSignal(query, signal);
    const { data, error } = await awaitWithAbort(query, signal);
    throwIfAborted(signal);
    if (error) throw supabaseError(error, "Could not watch room.");
    const stateData = await getGameState(normalizedCode, { signal });
    return {
      ok: true,
      spectators: Number(data || 0),
      state: stateData.state || null,
      version: Number(stateData.version || 0),
    };
  }

  async function leaveSpectator(code, payload = {}, options = {}) {
    const { signal } = options;
    throwIfAborted(signal);
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/spectators`, {
        method: "DELETE",
        body: JSON.stringify(payload),
        signal,
      });
    }
    const { client, authUser } = await currentAuthContext({ signal });
    throwIfAborted(signal);
    let query = client.rpc("touch_room_spectator", {
      p_code: normalizedCode,
      p_spectator_id: String(payload.spectatorId || authUser.id || "").slice(0, 80),
      p_spectator_name: String(payload.name || "Spectator").slice(0, 32),
      p_leave: true,
    });
    query = withAbortSignal(query, signal);
    const { data, error } = await awaitWithAbort(query, signal);
    throwIfAborted(signal);
    if (error) throw supabaseError(error, "Could not leave spectator mode.");
    return { ok: true, spectators: Number(data || 0) };
  }

  async function roomIdForCode(code) {
    const normalizedCode = normalizeCode(code);
    if (roomIdCache.has(normalizedCode)) return roomIdCache.get(normalizedCode);
    const row = await getRoomRow(normalizedCode, { maybeClosed: true });
    if (!row?.id) throw roomError("Комната не найдена.", 404);
    roomIdCache.set(normalizedCode, row.id);
    return row.id;
  }

  function publicChatMessage(row) {
    return {
      id: Number(row.id || 0),
      roomCode: row.roomCode || "",
      senderId: row.sender_user_id || row.senderId || "",
      senderUserId: row.sender_user_id || "",
      senderName: row.sender_name || row.senderName || "",
      color: row.color === "dark" ? "dark" : "white",
      text: row.text || "",
      kind: row.kind || "text",
      audioData: row.audio_data || row.audioData || "",
      mimeType: row.mime_type || row.mimeType || "",
      duration: Number(row.duration || 0),
      at: row.created_at || row.at || new Date().toISOString(),
    };
  }

  async function listChatMessages(code, after = 0) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/chat?after=${Number(after || 0)}`);
    }
    const client = await supabase();
    const roomId = await roomIdForCode(normalizedCode);
    let query = client
      .from("room_messages")
      .select("id,sender_user_id,sender_name,color,kind,text,audio_data,mime_type,duration,created_at")
      .eq("room_id", roomId)
      .order("id", { ascending: true })
      .limit(100);
    if (Number(after) > 0) query = query.gt("id", Number(after));
    const { data, error } = await query;
    if (error) throw supabaseError(error, "Could not load chat.");
    return { messages: (data || []).map(row => ({ ...publicChatMessage(row), roomCode: normalizedCode })) };
  }

  async function sendChatMessage(code, message = {}) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/chat`, {
        method: "POST",
        body: JSON.stringify(message),
      });
    }
    const { client, authUser, profile } = await currentAuthContext();
    const roomId = await roomIdForCode(normalizedCode);
    const kind = message.kind === "voice" ? "voice" : (message.kind === "emoji" ? "emoji" : "text");
    const text = kind === "voice" ? "Голосовое сообщение" : String(message.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const audioData = kind === "voice" ? String(message.audioData || "") : null;
    if (kind === "voice" && (!audioData.startsWith("data:audio/") || audioData.length > MAX_VOICE_DATA_URL_CHARS)) {
      throw roomError("Голосовое сообщение слишком длинное или повреждено.", 400);
    }
    const row = {
      room_id: roomId,
      sender_user_id: authUser.id,
      sender_name: String(message.senderName || profile.name || "Игрок").slice(0, 32),
      color: message.color === "dark" ? "dark" : "white",
      kind,
      text,
      audio_data: audioData,
      mime_type: kind === "voice" ? String(message.mimeType || "").slice(0, 80) : null,
      duration: kind === "voice" ? Math.max(0, Math.min(180000, Number(message.duration || 0))) : 0,
      client_message_id: String(message.clientMessageId || "").slice(0, 100) || null,
    };
    if (!row.text && kind !== "voice") throw roomError("Сообщение не может быть пустым.", 400);
    const insertMessage = () => client
      .from("room_messages")
      .insert(row)
      .select("id,sender_user_id,sender_name,color,kind,text,audio_data,mime_type,duration,created_at")
      .single();
    let { data, error } = await insertMessage();
    if (error && /client_message_id/i.test(error.message || "")) {
      delete row.client_message_id;
      ({ data, error } = await insertMessage());
    }
    if (error?.code === "23505" && row.client_message_id) {
      const { data: existing, error: existingError } = await client
        .from("room_messages")
        .select("id,sender_user_id,sender_name,color,kind,text,audio_data,mime_type,duration,created_at")
        .eq("sender_user_id", authUser.id)
        .eq("client_message_id", row.client_message_id)
        .maybeSingle();
      if (!existingError && existing) return { message: { ...publicChatMessage(existing), roomCode: normalizedCode } };
    }
    if (error) throw supabaseError(error, "Could not send chat message.");
    return { message: { ...publicChatMessage(data), roomCode: normalizedCode } };
  }

  window.NarduRooms = {
    configured,
    normalizeCode,
    listRooms,
    createRoom,
    ensureBotAnalysisRoom,
    getActiveRoom,
    getRoom,
    joinRoom,
    deleteRoom,
    closeWaitingRoom,
    closeBotRoom,
    closeOwnLobbyRooms,
    closeOwnWaitingRooms,
    getGameState,
    fairDiceConfigured,
    fairDicePolicy,
    requestFairDice,
    putGameState,
    finishRoomGame,
    archiveBotTrainingGame,
    loadLongBotExperience,
    loadShortBotExperience,
    updatePresence,
    leaveRoom,
    watchRoom,
    leaveSpectator,
    listChatMessages,
    sendChatMessage,
  };
})();
