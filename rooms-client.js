(function () {
  const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const PRESENCE_STALE_MS = 30000;
  const NETWORK_GRACE_MS = 120000;
  const PROFILE_HEARTBEAT_MS = 30000;
  const MAX_VOICE_DATA_URL_CHARS = 6 * 1024 * 1024;
  const LONG_BOT_EXPERIENCE_CACHE_KEY = "narduh-long-bot-server-experience-v2";
  const LONG_BOT_EXPERIENCE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const roomIdCache = new Map();
  const profileHeartbeatAt = new Map();
  let longBotExperiencePromise = null;

  function readLongBotExperienceCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(LONG_BOT_EXPERIENCE_CACHE_KEY) || "null");
      if (!cached || Date.now() - Number(cached.savedAt || 0) > LONG_BOT_EXPERIENCE_CACHE_MAX_AGE_MS) return [];
      return Array.isArray(cached.patterns) ? cached.patterns : [];
    } catch {
      return [];
    }
  }

  function writeLongBotExperienceCache(patterns) {
    try {
      localStorage.setItem(LONG_BOT_EXPERIENCE_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(),
        patterns: Array.isArray(patterns) ? patterns : [],
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

  async function apiJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(window.NarduApp?.translateServerMessage?.(data.error) || data.error || window.NarduApp?.t?.("err_session") || "Game session error.");
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function supabase() {
    return window.NarduSupabase.client();
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

  async function touchProfileHeartbeat(client, userId) {
    if (!userId) return;
    const now = Date.now();
    const lastTouch = profileHeartbeatAt.get(userId) || 0;
    if (now - lastTouch < PROFILE_HEARTBEAT_MS) return;
    profileHeartbeatAt.set(userId, now);
    const { error } = await client
      .from("profiles")
      .update({ last_seen_at: new Date(now).toISOString() })
      .eq("id", userId);
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
    const room = {
      id: row.id,
      code: normalizeCode(row.code),
      hostName: row.host_name || row.hostName || "",
      hostRating,
      hostTier: row.host_registered && hostRating ? ratingTierFor(hostRating) : "",
      hostRegistered: Boolean(row.host_registered),
      hostRatingEligible: Boolean(row.host_registered),
      guestName: row.guest_name || row.guestName || "",
      guestRating,
      guestTier: row.guest_registered && guestRating ? ratingTierFor(guestRating) : "",
      guestRegistered: Boolean(row.guest_registered),
      guestRatingEligible: Boolean(row.guest_registered),
      opponent: "player",
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

  async function currentAuthContext() {
    const client = await supabase();
    let session = null;
    if (client.auth.getSession) {
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError) {
        if (isMissingAuthSession(sessionError)) throw missingAuthSessionError();
        throw supabaseError(sessionError, "Supabase auth failed.");
      }
      session = sessionData?.session || null;
      if (!session?.user?.id && client.auth.refreshSession) {
        const { data: refreshData, error: refreshError } = await client.auth.refreshSession();
        if (refreshError && !isMissingAuthSession(refreshError)) throw supabaseError(refreshError, "Supabase auth refresh failed.");
        session = refreshData?.session || null;
      }
      if (!session?.user?.id) throw missingAuthSessionError();
    }
    let { data: authData, error: authError } = await client.auth.getUser();
    if (authError && isMissingAuthSession(authError) && client.auth.refreshSession) {
      const { data: refreshData, error: refreshError } = await client.auth.refreshSession();
      if (!refreshError && refreshData?.session?.user?.id) {
        ({ data: authData, error: authError } = await client.auth.getUser());
      }
    }
    if (authError) {
      if (isMissingAuthSession(authError)) throw missingAuthSessionError();
      throw supabaseError(authError, "Supabase auth failed.");
    }
    const authUser = authData?.user;
    if (!authUser?.id) throw missingAuthSessionError();

    let { data: profile, error: profileError } = await client
      .from("profiles")
      .select("id,nickname,email,rating,tier,rating_eligible,banned_at,banned_reason")
      .eq("id", authUser.id)
      .maybeSingle();
    if (profileError) throw supabaseError(profileError, "Could not load profile.");
    if (profile?.banned_at) {
      throw roomError(profile.banned_reason || "Аккаунт заблокирован администратором.", 403);
    }

    const localUser = window.NarduApp?.getUser?.() || {};
    const metadata = authUser.user_metadata || {};
    const nickname = profile?.nickname || await createMissingProfile(client, authUser, localUser, metadata);
    await touchProfileHeartbeat(client, authUser.id);
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

  async function createMissingProfile(client, authUser, localUser = {}, metadata = {}) {
    const baseNickname = String(metadata.nickname || metadata.name || localUser.nickname || localUser.name || authUser.email?.split("@")[0] || "Player")
      .trim()
      .slice(0, 20) || "Player";
    const email = authUser.email || localUser.email || "";
    const rating = normalizeRating(localUser.rating);
    const tier = ratingTierFor(rating);
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const nickname = attempt === 0
        ? baseNickname
        : `${baseNickname.slice(0, Math.max(3, 17 - String(attempt).length))}${attempt}`;
      const { data, error } = await client
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
        .select("id,nickname,email,rating,tier,rating_eligible")
        .maybeSingle();
      if (!error && data) return data.nickname;
      lastError = error;
      if (error?.code !== "23505") break;
    }
    throw supabaseError(lastError, "Could not create profile.");
  }

  async function getRoomRow(code, { includePassword = false, maybeClosed = false } = {}) {
    const client = await supabase();
    const columns = includePassword ? "*" : "id,code,variant,access,status,host_user_id,guest_user_id,host_name,guest_name,host_rating,guest_rating,host_registered,guest_registered,allow_spectators,spectators,created_at,joined_at,updated_at";
    let query = client
      .from("rooms")
      .select(columns)
      .eq("code", normalizeCode(code));
    if (!maybeClosed) query = query.neq("status", "closed");
    const { data, error } = await query.maybeSingle();
    if (error) throw supabaseError(error, "Could not load room.");
    if (data?.id) roomIdCache.set(normalizeCode(code), data.id);
    return data || null;
  }

  function isParticipant(row, userId) {
    return Boolean(row && userId && (row.host_user_id === userId || row.guest_user_id === userId));
  }

  function localUserIsGuest() {
    return window.NarduApp?.getUser?.()?.guest === true;
  }

  async function roomClientContext(options = {}) {
    if (localUserIsGuest()) {
      const client = await supabase();
      await client.auth.signOut().catch(() => {});
      return {
        client,
        authUser: null,
        profile: {},
        guest: true,
      };
    }
    try {
      return { ...(await currentAuthContext()), guest: false };
    } catch (error) {
      if (!options.allowLocalFallback || Number(error?.status) !== 401) throw error;
      const client = await supabase();
      window.NarduApp?.touchPresence?.({ force: true });
      return {
        client,
        authUser: null,
        profile: {},
        guest: true,
        authFallback: true,
      };
    }
  }

  async function findActiveRoomFor(client, userId) {
    const { data, error } = await client
      .from("rooms")
      .select("*")
      .or(`host_user_id.eq.${userId},guest_user_id.eq.${userId}`)
      .in("status", ["waiting", "joined"])
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) throw supabaseError(error, "Could not check active room.");
    return (data || []).find(row => !isBotAnalysisRow(row)) || null;
  }

  async function listRooms() {
    if (!configured()) return apiJson("/api/rooms");
    const client = await supabase();
    const { data, error } = await client
      .from("rooms")
      .select("id,code,variant,access,status,host_user_id,guest_user_id,host_name,guest_name,host_rating,guest_rating,host_registered,guest_registered,allow_spectators,spectators,game_state,created_at,joined_at,updated_at")
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
    const activeRoom = authUser?.id ? await findActiveRoomFor(client, authUser.id) : null;
    if (!guest && activeRoom) {
      throw roomError(
        "У вас уже есть активная игровая комната. Сначала завершите или покиньте текущую комнату.",
        409,
        { room: publicRoom(activeRoom, { password: payload.password || "" }) }
      );
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
        roomIdCache.set(normalizeCode(data.code), data.id);
        return { room: publicRoom(data, { password }) };
      }
      lastError = error;
      if (error.code === "23505" && authUser?.id) {
        const existingRoom = await findActiveRoomFor(client, authUser.id);
        if (existingRoom) {
          throw roomError(
            "У вас уже есть активная игровая комната. Сначала завершите или покиньте текущую комнату.",
            409,
            { room: publicRoom(existingRoom, { password }) }
          );
        }
      }
      if (error.code !== "23505") break;
    }
    throw supabaseError(lastError, "Could not create room.");
  }

  async function ensureBotAnalysisRoom(payload = {}) {
    if (!configured()) return { skipped: true };
    const normalizedCode = normalizeCode(payload.code);
    if (!normalizedCode) throw roomError("Не указан код партии для анализа.", 400);

    const { client, authUser, profile } = await roomClientContext({ allowLocalFallback: true });
    const roomProfile = localRoomProfile(profile, { registered: Boolean(authUser?.id) });
    const variant = payload.variant === "short" ? "short" : "long";
    const botName = String(payload.botName || payload.guestName || "Bot").trim().slice(0, 32) || "Bot";
    const botRating = normalizeRating(payload.botRating);
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
      updatedAt: new Date().toISOString(),
    };

    const { data: existing, error: existingError } = await client
      .from("rooms")
      .select("id,code,status,host_user_id,game_state,game_version")
      .eq("code", normalizedCode)
      .neq("status", "closed")
      .maybeSingle();
    if (existingError) throw supabaseError(existingError, "Could not load bot analysis room.");
    if (existing?.id) {
      if (existing.host_user_id && existing.host_user_id !== authUser?.id) {
        throw roomError("Код партии уже занят другой комнатой.", 409);
      }
      roomIdCache.set(normalizedCode, existing.id);
      if (!isBotAnalysisRow(existing)) throw roomError("Код партии уже занят онлайн-комнатой.", 409);
      return { ok: true, version: Number(existing.game_version || 0) };
    }

    const now = new Date().toISOString();
    const { data, error } = await client
      .from("rooms")
      .insert({
        code: normalizedCode,
        variant,
        access: "open",
        status: "joined",
        host_user_id: authUser?.id || null,
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
    if (error) throw supabaseError(error, "Could not create bot analysis room.");
    if (data?.id) roomIdCache.set(normalizedCode, data.id);
    return { ok: true, version: Number(data?.game_version || 0) };
  }

  async function getRoom(code) {
    if (!configured()) return apiJson(`/api/rooms/${encodeURIComponent(normalizeCode(code))}`);
    const row = await getRoomRow(code);
    if (!row) throw roomError("Комната не найдена.", 404);
    return { room: publicRoom(row) };
  }

  async function joinRoom(code, payload = {}) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/join`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    const { client, authUser, profile, guest } = await roomClientContext();
    const roomProfile = localRoomProfile(profile);
    const room = await getRoomRow(normalizedCode, { includePassword: true });
    if (!room) throw roomError("Комната с таким кодом не найдена.", 404);

    if (room.status !== "waiting") {
      if (authUser?.id && isParticipant(room, authUser.id)) return { room: publicRoom(room) };
      throw roomError("Эта комната уже занята.", 409);
    }
    if (authUser?.id && room.host_user_id === authUser.id) return { room: publicRoom(room) };
    if (String(room.host_name || "").trim().toLowerCase() === String(roomProfile.name || "").trim().toLowerCase()) {
      return { room: publicRoom(room) };
    }
    if (room.access === "closed") {
      const providedHash = await sha256Hex(String(payload.password || "").trim());
      if (providedHash !== room.password_hash) throw roomError("Неверный пароль закрытой комнаты.", 403);
    }

    const joinedAt = new Date().toISOString();
    const { data, error } = await client
      .from("rooms")
      .update({
        status: "joined",
        guest_user_id: authUser?.id || null,
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
      .select("*")
      .maybeSingle();

    if (error) throw supabaseError(error, "Could not join room.");
    if (!data) {
      const latest = await getRoomRow(normalizedCode, { includePassword: true });
      if (authUser?.id && isParticipant(latest, authUser.id)) return { room: publicRoom(latest) };
      throw roomError("Эта комната уже занята.", 409);
    }
    roomIdCache.set(normalizedCode, data.id);
    return { room: publicRoom(data) };
  }

  async function deleteRoom(code) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}`, { method: "DELETE" });
    }
    const { client } = await roomClientContext();
    const { data, error } = await client
      .from("rooms")
      .update({
        status: "closed",
        archived_at: new Date().toISOString(),
        closed_reason: "removed",
      })
      .eq("code", normalizedCode)
      .neq("status", "closed")
      .select("code")
      .maybeSingle();
    if (error) throw supabaseError(error, "Could not close room.");
    return { ok: true, removed: Boolean(data), code: normalizedCode };
  }

  async function closeOwnLobbyRooms(payload = {}) {
    const codes = [...new Set((payload.codes || []).map(normalizeCode).filter(Boolean))];
    if (!configured()) {
      const closed = [];
      for (const code of codes) {
        const result = await deleteRoom(code);
        if (result.removed) closed.push(code);
      }
      return { ok: true, closedCodes: closed };
    }

    const { client, authUser } = await roomClientContext();
    if (authUser?.id) {
      const { data: rpcData, error: rpcError } = await client.rpc("close_own_lobby_rooms");
      if (!rpcError) {
        return {
          ok: true,
          closedCodes: (rpcData || []).map(normalizeCode).filter(Boolean),
        };
      }
      if (!/function .*close_own_lobby_rooms|Could not find the function|schema cache/i.test(rpcError.message || "")) {
        throw supabaseError(rpcError, "Could not close rooms on lobby entry.");
      }
      const { data, error } = await client
        .from("rooms")
        .update({
          status: "closed",
          archived_at: new Date().toISOString(),
          closed_reason: "lobby_exit",
        })
        .eq("host_user_id", authUser.id)
        .in("status", ["waiting", "joined"])
        .select("code");
      if (error) throw supabaseError(error, "Could not close waiting rooms.");
      return {
        ok: true,
        closedCodes: (data || []).map(row => normalizeCode(row.code)).filter(Boolean),
      };
    }

    const closed = [];
    for (const code of codes) {
      const result = await deleteRoom(code);
      if (result.removed) closed.push(code);
    }
    return { ok: true, closedCodes: closed };
  }

  const closeOwnWaitingRooms = closeOwnLobbyRooms;

  function finalGameState(state) {
    return Boolean(state && (state.phase === "over" || state.winner));
  }

  async function getGameState(code) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/game`);
    const client = await supabase();
    const { data, error } = await client
      .from("rooms")
      .select("id,game_state,game_version,status")
      .eq("code", normalizedCode)
      .neq("status", "closed")
      .maybeSingle();
    if (error) throw supabaseError(error, "Could not load game state.");
    if (!data) throw roomError("Комната не найдена.", 404);
    roomIdCache.set(normalizedCode, data.id);
    return { state: data.game_state || null, version: Number(data.game_version || 0) };
  }

  async function putGameState(code, state, version = 0) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/game`, {
        method: "PUT",
        body: JSON.stringify({ state, version }),
      });
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
      .select("game_version")
      .maybeSingle();
    if (error) throw supabaseError(error, "Could not save game state.");
    if (!data) {
      throw roomError("Состояние комнаты уже обновлено другим клиентом. Подтягиваем актуальный ход.", 409);
    }
    return { ok: true, version: nextVersion };
  }

  async function finishRoomGame(code, finalState, version = 0) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/game`, {
        method: "PUT",
        body: JSON.stringify({ state: finalState, version: Number(version) || 0 }),
      });
    }
    const { client } = await roomClientContext();
    const { data, error } = await client.rpc("finish_room_game", {
      p_room_code: normalizedCode,
      p_final_state: JSON.parse(JSON.stringify(finalState || {})),
    });
    if (error) throw supabaseError(error, "Could not finish room game.");
    return data || { ok: true };
  }

  async function archiveBotTrainingGame(code, finalState = null) {
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

  async function loadLongBotExperience({ refresh = false } = {}) {
    if (!configured() || !window.NarduLongBotEngine?.setExperience) return [];
    const cachedPatterns = refresh ? [] : readLongBotExperienceCache();
    if (cachedPatterns.length) {
      window.NarduLongBotEngine.setExperience(cachedPatterns, "server-cache");
    }
    if (longBotExperiencePromise && !refresh) {
      return cachedPatterns.length ? cachedPatterns : longBotExperiencePromise;
    }
    longBotExperiencePromise = (async () => {
      const client = await supabase();
      const { data, error } = await client.rpc("get_long_bot_experience_patterns");
      if (error) throw supabaseError(error, "Could not load long-bot experience.");
      const patterns = Array.isArray(data) ? data : [];
      window.NarduLongBotEngine.setExperience([], "server-cache");
      window.NarduLongBotEngine.setExperience(patterns, "server");
      writeLongBotExperienceCache(patterns);
      return patterns;
    })().catch(error => {
      longBotExperiencePromise = null;
      throw error;
    });
    if (cachedPatterns.length && !refresh) {
      longBotExperiencePromise.catch(() => {});
      return cachedPatterns;
    }
    return longBotExperiencePromise;
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

  async function updatePresence(code, payload = {}) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/presence`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    const client = await supabase();
    const color = payload.color === "dark" ? "dark" : "white";
    const { data: room, error: loadError } = await client
      .from("rooms")
      .select("id,presence,game_state,game_version,status")
      .eq("code", normalizedCode)
      .neq("status", "closed")
      .maybeSingle();
    if (loadError) throw supabaseError(loadError, "Could not load room presence.");
    if (!room) throw roomError("Комната не найдена.", 404);
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
      updates.updated_at = new Date(nowMs).toISOString();
      updates.status = "over";
      updates.archived_at = new Date(nowMs).toISOString();
      updates.closed_reason = "network_loss";
    }
    const { data: updated, error: updateError } = await client
      .from("rooms")
      .update(updates)
      .eq("code", normalizedCode)
      .select("presence,game_state,game_version,status")
      .maybeSingle();
    if (updateError) throw supabaseError(updateError, "Could not update presence.");
    return {
      ok: true,
      presence: publicPresence(updated || { ...room, presence }, color),
      state: updated?.game_state || gameState || null,
      version: Number(updated?.game_version ?? gameVersion ?? 0),
    };
  }

  async function leaveRoom(code, payload = {}) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/leave`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    const client = await supabase();
    const color = payload.color === "dark" ? "dark" : "white";
    const { data: room, error: loadError } = await client
      .from("rooms")
      .select("*")
      .eq("code", normalizedCode)
      .maybeSingle();
    if (loadError) throw supabaseError(loadError, "Could not load room.");
    if (!room) return { ok: true, removed: true };
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
    const { data: updated, error } = await client
      .from("rooms")
      .update(updates)
      .eq("code", normalizedCode)
      .select("*")
      .maybeSingle();
    if (error) throw supabaseError(error, "Could not leave room.");
    return { ok: true, removed: shouldClose, room: publicRoom(updated || room) };
  }

  async function watchRoom(code, payload = {}) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/spectators`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    const { client, authUser, profile } = await currentAuthContext();
    const spectatorId = String(payload.spectatorId || authUser.id || "").slice(0, 80);
    const spectatorName = String(payload.name || profile.nickname || "Spectator").slice(0, 32);
    const { data, error } = await client.rpc("touch_room_spectator", {
      p_code: normalizedCode,
      p_spectator_id: spectatorId,
      p_spectator_name: spectatorName,
      p_leave: false,
    });
    if (error) throw supabaseError(error, "Could not watch room.");
    const stateData = await getGameState(normalizedCode);
    return {
      ok: true,
      spectators: Number(data || 0),
      state: stateData.state || null,
      version: Number(stateData.version || 0),
    };
  }

  async function leaveSpectator(code, payload = {}) {
    const normalizedCode = normalizeCode(code);
    if (!configured()) {
      return apiJson(`/api/rooms/${encodeURIComponent(normalizedCode)}/spectators`, {
        method: "DELETE",
        body: JSON.stringify(payload),
      });
    }
    const { client, authUser } = await currentAuthContext();
    const { data, error } = await client.rpc("touch_room_spectator", {
      p_code: normalizedCode,
      p_spectator_id: String(payload.spectatorId || authUser.id || "").slice(0, 80),
      p_spectator_name: String(payload.name || "Spectator").slice(0, 32),
      p_leave: true,
    });
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
    };
    if (!row.text && kind !== "voice") throw roomError("Сообщение не может быть пустым.", 400);
    const { data, error } = await client
      .from("room_messages")
      .insert(row)
      .select("id,sender_user_id,sender_name,color,kind,text,audio_data,mime_type,duration,created_at")
      .single();
    if (error) throw supabaseError(error, "Could not send chat message.");
    return { message: { ...publicChatMessage(data), roomCode: normalizedCode } };
  }

  window.NarduRooms = {
    configured,
    normalizeCode,
    listRooms,
    createRoom,
    ensureBotAnalysisRoom,
    getRoom,
    joinRoom,
    deleteRoom,
    closeOwnLobbyRooms,
    closeOwnWaitingRooms,
    getGameState,
    putGameState,
    finishRoomGame,
    archiveBotTrainingGame,
    loadLongBotExperience,
    updatePresence,
    leaveRoom,
    watchRoom,
    leaveSpectator,
    listChatMessages,
    sendChatMessage,
  };
})();
