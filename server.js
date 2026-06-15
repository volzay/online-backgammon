const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4177);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const ADMIN_CONFIG_PATH = path.join(DATA_DIR, "admin.json");
const ADMIN_STATE_PATH = path.join(DATA_DIR, "admin-state.json");
const AUTH_STATE_PATH = path.join(DATA_DIR, "auth-users.json");
const MAIL_OUTBOX_PATH = path.join(DATA_DIR, "mail-outbox.json");
const DEFAULT_ADMIN_LOGIN = process.env.ADMIN_LOGIN || "admin";
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "adM)in27-05!26";
const ADMIN_COOKIE_NAME = "nardy_admin";
const ADMIN_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const configuredArchiveHours = Number(process.env.ADMIN_ARCHIVE_HOURS || 96);
const ADMIN_ARCHIVE_HOURS = Number.isFinite(configuredArchiveHours) && configuredArchiveHours > 0
  ? configuredArchiveHours
  : 96;
const ADMIN_ARCHIVE_TTL_MS = ADMIN_ARCHIVE_HOURS * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RATING = 1000;
const RATING_TIERS = [
  { name: "Diamond", min: 2100 },
  { name: "Platinum", min: 1800 },
  { name: "Gold", min: 1500 },
  { name: "Silver", min: 1200 },
  { name: "Bronze", min: 0 },
];
const rooms = [];
const adminState = loadAdminState();
const authState = loadAuthState();
const NETWORK_GRACE_MS = Number(process.env.NETWORK_GRACE_MS || 120000);
const PRESENCE_STALE_MS = Number(process.env.PRESENCE_STALE_MS || 8000);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, `http://${HOST}:${PORT}`);
  const decodedPath = decodeURIComponent(url.pathname);
  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(ROOT, normalizedPath);

  if (!path.extname(filePath)) {
    filePath += ".html";
  }

  return filePath;
}

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, statusCode, payload, headers = {}) {
  send(res, statusCode, JSON.stringify(payload), "application/json; charset=utf-8", headers);
}

function loadAdminState() {
  const fallback = { tokens: [], audit: [], archive: [], users: [] };
  if (!fs.existsSync(ADMIN_STATE_PATH)) return fallback;
  try {
    const saved = JSON.parse(fs.readFileSync(ADMIN_STATE_PATH, "utf8"));
    return {
      tokens: [],
      audit: Array.isArray(saved.audit) ? saved.audit : [],
      archive: Array.isArray(saved.archive) ? saved.archive : [],
      users: Array.isArray(saved.users) ? saved.users : [],
    };
  } catch {
    return fallback;
  }
}

function saveAdminState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_STATE_PATH, JSON.stringify({
    users: adminState.users,
    audit: adminState.audit.slice(0, 500),
    archive: adminState.archive,
    updatedAt: now(),
  }, null, 2));
}

function loadAuthState() {
  const fallback = { users: [], passwordResets: [] };
  if (!fs.existsSync(AUTH_STATE_PATH)) return fallback;
  try {
    const saved = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, "utf8"));
    return {
      users: Array.isArray(saved.users) ? saved.users : [],
      passwordResets: Array.isArray(saved.passwordResets) ? saved.passwordResets : [],
    };
  } catch {
    return fallback;
  }
}

function saveAuthState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const nowMs = Date.now();
  authState.passwordResets = authState.passwordResets.filter(item => Date.parse(item.expiresAt) > nowMs && !item.usedAt);
  fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({
    users: authState.users,
    passwordResets: authState.passwordResets,
    updatedAt: now(),
  }, null, 2));
}

function loadMailOutbox() {
  if (!fs.existsSync(MAIL_OUTBOX_PATH)) return [];
  try {
    const saved = JSON.parse(fs.readFileSync(MAIL_OUTBOX_PATH, "utf8"));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveMailOutbox(messages) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MAIL_OUTBOX_PATH, JSON.stringify(messages.slice(-300), null, 2));
}

function queueMail({ to, subject, text, type }) {
  const outbox = loadMailOutbox();
  const message = {
    id: id("mail"),
    to,
    subject,
    text,
    type,
    delivery: "local-outbox",
    createdAt: now(),
  };
  outbox.push(message);
  saveMailOutbox(outbox);
  return message;
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function constantTimeStringEqual(left, right) {
  const leftHash = Buffer.from(sha256(left), "hex");
  const rightHash = Buffer.from(sha256(right), "hex");
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password || ""), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const attempt = crypto.pbkdf2Sync(String(password || ""), salt, 120000, 32, "sha256");
  const original = Buffer.from(hash, "hex");
  return original.length === attempt.length && crypto.timingSafeEqual(original, attempt);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(item => {
    const [key, ...value] = item.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(raw || req.socket.remoteAddress || "unknown").split(",")[0].trim().replace(/^::ffff:/, "");
}

function loadAdminCredentials() {
  const credentials = {
    login: DEFAULT_ADMIN_LOGIN,
    password: DEFAULT_ADMIN_PASSWORD,
    passwordHash: "",
  };
  if (!fs.existsSync(ADMIN_CONFIG_PATH)) return credentials;
  try {
    const config = JSON.parse(fs.readFileSync(ADMIN_CONFIG_PATH, "utf8"));
    if (String(config.login || "").trim()) credentials.login = String(config.login).trim();
    if (typeof config.password === "string") credentials.password = config.password;
    if (typeof config.passwordHash === "string") credentials.passwordHash = config.passwordHash;
  } catch {
    return credentials;
  }
  return credentials;
}

function saveAdminCredentials(credentials) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_CONFIG_PATH, JSON.stringify({
    login: credentials.login || DEFAULT_ADMIN_LOGIN,
    passwordHash: credentials.passwordHash,
    updatedAt: now(),
  }, null, 2));
}

function adminPasswordConfigured() {
  const credentials = loadAdminCredentials();
  return Boolean(credentials.passwordHash || credentials.password);
}

function verifyAdminPassword(password, credentials) {
  if (credentials.passwordHash) {
    try {
      return verifyPassword(password, credentials.passwordHash);
    } catch {
      return false;
    }
  }
  if (credentials.password) return constantTimeStringEqual(password, credentials.password);
  return false;
}

function archiveExpiryMs(entry) {
  const archivedMs = Date.parse(entry?.archivedAt || entry?.session?.archivedAt || "");
  if (Number.isFinite(archivedMs)) return archivedMs + ADMIN_ARCHIVE_TTL_MS;
  const expiresMs = Date.parse(entry?.expiresAt || "");
  if (Number.isFinite(expiresMs)) return expiresMs;
  return Date.now() + ADMIN_ARCHIVE_TTL_MS;
}

function archiveExpiresAt(entry) {
  return new Date(archiveExpiryMs(entry)).toISOString();
}

function normalizeArchiveEntry(entry) {
  const expiresAt = archiveExpiresAt(entry);
  const changed = entry.expiresAt !== expiresAt;
  entry.expiresAt = expiresAt;
  if (entry.session) entry.session.archivedAt ||= entry.archivedAt || "";
  return { entry, changed };
}

function ensureAdminState() {
  const nowMs = Date.now();
  const beforeArchive = adminState.archive.length;
  const beforeAudit = adminState.audit.length;
  let archiveChanged = false;
  adminState.tokens = adminState.tokens.filter(item => Date.parse(item.expiresAt) > nowMs);
  adminState.archive = adminState.archive
    .map(item => {
      const normalized = normalizeArchiveEntry(item);
      archiveChanged ||= normalized.changed;
      return normalized.entry;
    })
    .filter(item => archiveExpiryMs(item) > nowMs);
  adminState.audit = adminState.audit.slice(0, 500);
  if (archiveChanged || adminState.archive.length !== beforeArchive || adminState.audit.length !== beforeAudit) saveAdminState();
}

function addAdminAudit(req, action, details = {}) {
  adminState.audit.unshift({ id: id("audit"), action, ip: clientIp(req), at: now(), ...details });
  adminState.audit = adminState.audit.slice(0, 500);
  saveAdminState();
}

function requireAdmin(req) {
  ensureAdminState();
  const token = parseCookies(req)[ADMIN_COOKIE_NAME];
  if (!token) return null;
  const adminToken = adminState.tokens.find(item => item.token === token && Date.parse(item.expiresAt) > Date.now());
  return adminToken ? { login: adminToken.login, token } : null;
}

function publicRoom(room, includePassword = false) {
  if (!room) return null;
  const safe = {
    id: room.id,
    code: room.code,
    hostName: room.hostName,
    hostRating: room.hostRegistered ? normalizeRating(room.hostRating) : null,
    hostTier: room.hostRegistered ? ratingTierFor(room.hostRating) : "",
    hostRegistered: Boolean(room.hostRegistered),
    hostRatingEligible: Boolean(room.hostRegistered),
    guestName: room.guestName || "",
    guestRating: room.guestRegistered ? normalizeRating(room.guestRating) : null,
    guestTier: room.guestRegistered ? ratingTierFor(room.guestRating) : "",
    guestRegistered: Boolean(room.guestRegistered),
    guestRatingEligible: Boolean(room.guestRegistered),
    opponent: "player",
    variant: room.variant,
    access: room.access,
    status: room.status,
    createdAt: room.createdAt,
    joinedAt: room.joinedAt || "",
  };
  if (includePassword) safe.password = room.password || "";
  return safe;
}

function publicChatMessage(message) {
  return {
    id: message.id,
    roomCode: message.roomCode,
    senderId: message.senderId,
    senderName: message.senderName,
    color: message.color,
    text: message.text,
    kind: message.kind || "text",
    audioData: message.audioData || "",
    mimeType: message.mimeType || "",
    duration: Number(message.duration || 0),
    at: message.at,
  };
}

function normalizeChatText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function normalizePlayerName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32)
    .toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

function normalizeNickname(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || ""));
}

function ratingTierFor(rating) {
  const value = Number(rating);
  if (!Number.isFinite(value)) return "Bronze";
  return RATING_TIERS.find(tier => value >= tier.min)?.name || "Bronze";
}

function normalizeRating(value) {
  const rating = Math.round(Number(value));
  return Number.isFinite(rating) && rating > 0 ? rating : DEFAULT_RATING;
}

function assignRegisteredRating(user, rating = user?.rating) {
  if (!user) return null;
  user.rating = normalizeRating(rating);
  user.tier = ratingTierFor(user.rating);
  user.ratingEligible = true;
  return user;
}

function registeredRoomProfile({ name, userId, ratingEligible }) {
  const idValue = String(userId || "").trim();
  const nameValue = normalizePlayerName(name);
  if (ratingEligible === false) return null;
  const user = authState.users.find(item => (
    (idValue && item.id === idValue)
    || (nameValue && normalizePlayerName(item.nickname) === nameValue)
  )) || null;
  return user ? assignRegisteredRating(user) : null;
}

function publicUser(user) {
  assignRegisteredRating(user);
  return {
    id: user.id,
    name: user.nickname,
    nickname: user.nickname,
    email: user.email,
    rating: user.rating,
    tier: user.tier,
    ratingEligible: true,
    history: Array.isArray(user.ratingHistory) ? user.ratingHistory.slice(0, 100) : [],
    guest: false,
  };
}

function accountUserRef(user) {
  if (!user) return null;
  assignRegisteredRating(user);
  return {
    id: user.id,
    nickname: user.nickname,
    name: user.nickname,
    email: user.email,
    rating: user.rating,
    tier: user.tier,
  };
}

function ensureAccountData(user) {
  if (!user) return null;
  assignRegisteredRating(user);
  user.ratingHistory = Array.isArray(user.ratingHistory) ? user.ratingHistory : [];
  user.friends = Array.isArray(user.friends) ? user.friends : [];
  user.friendRequests = Array.isArray(user.friendRequests) ? user.friendRequests : [];
  user.friendMessages = Array.isArray(user.friendMessages) ? user.friendMessages : [];
  user.friends = user.friends
    .map(friend => {
      const friendUser = authState.users.find(item => item.id === friend.userId) || findAuthUserByNickname(friend.nickname);
      if (!friendUser || friendUser.id === user.id) return null;
      return {
        userId: friendUser.id,
        nickname: friendUser.nickname,
        addedAt: friend.addedAt || now(),
      };
    })
    .filter(Boolean)
    .filter((friend, index, all) => all.findIndex(item => item.userId === friend.userId) === index);
  user.friendRequests = user.friendRequests
    .map(request => {
      const fromUser = authState.users.find(item => item.id === request.fromUserId) || findAuthUserByNickname(request.fromName);
      const toUser = authState.users.find(item => item.id === request.toUserId) || findAuthUserByNickname(request.toName);
      if (!fromUser || !toUser || fromUser.id === toUser.id) return null;
      const status = ["pending", "accepted", "declined", "cancelled"].includes(request.status) ? request.status : "pending";
      return {
        id: request.id || id("frq"),
        fromUserId: fromUser.id,
        fromName: fromUser.nickname,
        toUserId: toUser.id,
        toName: toUser.nickname,
        status,
        createdAt: request.createdAt || now(),
        respondedAt: request.respondedAt || "",
        cancelledAt: request.cancelledAt || "",
      };
    })
    .filter(Boolean)
    .filter((request, index, all) => all.findIndex(item => item.id === request.id) === index)
    .slice(-500);
  user.friendMessages = user.friendMessages
    .filter(message => message && message.id && message.threadId && message.text)
    .slice(-500);
  return user;
}

function findAccountUser({ userId = "", nickname = "", email = "" } = {}) {
  const idValue = String(userId || "").trim();
  const emailValue = normalizeEmail(email);
  const nicknameValue = normalizePlayerName(nickname);
  return authState.users.find(user => (
    (idValue && user.id === idValue)
    || (emailValue && normalizeEmail(user.email) === emailValue)
    || (nicknameValue && normalizePlayerName(user.nickname) === nicknameValue)
  )) || null;
}

function accountUserFromRequest(url, body = {}) {
  return findAccountUser({
    userId: body.userId || url.searchParams.get("userId"),
    nickname: body.nickname || body.name || url.searchParams.get("nickname") || url.searchParams.get("name"),
    email: body.email || url.searchParams.get("email"),
  });
}

function friendSummaryFor(user, friendUser) {
  ensureAccountData(user);
  ensureAccountData(friendUser);
  const messages = user.friendMessages.filter(message => (
    message.fromUserId === friendUser.id || message.toUserId === friendUser.id
  ));
  const latest = messages.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
  const unread = messages.filter(message => message.fromUserId === friendUser.id && !message.readAt).length;
  return {
    ...accountUserRef(friendUser),
    addedAt: user.friends.find(friend => friend.userId === friendUser.id)?.addedAt || "",
    lastMessage: latest ? {
      id: latest.id,
      text: latest.text,
      at: latest.at,
      own: latest.fromUserId === user.id,
    } : null,
    unread,
  };
}

function accountFriendRequestCopy(request, fromUser, toUser) {
  return {
    id: request.id,
    fromUserId: fromUser.id,
    fromName: fromUser.nickname,
    toUserId: toUser.id,
    toName: toUser.nickname,
    status: request.status || "pending",
    createdAt: request.createdAt || now(),
    respondedAt: request.respondedAt || "",
    cancelledAt: request.cancelledAt || "",
  };
}

function syncFriendRequestCopies(request) {
  const fromUser = authState.users.find(item => item.id === request.fromUserId);
  const toUser = authState.users.find(item => item.id === request.toUserId);
  if (!fromUser || !toUser) return null;
  const copy = accountFriendRequestCopy(request, fromUser, toUser);
  [fromUser, toUser].forEach(holder => {
    holder.friendRequests = Array.isArray(holder.friendRequests) ? holder.friendRequests : [];
    const index = holder.friendRequests.findIndex(item => item.id === copy.id);
    if (index >= 0) {
      holder.friendRequests[index] = copy;
    } else {
      holder.friendRequests.unshift(copy);
    }
    holder.friendRequests = holder.friendRequests.slice(0, 500);
  });
  return copy;
}

function friendRequestSummaryFor(viewer, request) {
  const fromUser = authState.users.find(item => item.id === request.fromUserId);
  const toUser = authState.users.find(item => item.id === request.toUserId);
  if (!fromUser || !toUser) return null;
  const otherUser = request.fromUserId === viewer.id ? toUser : fromUser;
  return {
    id: request.id,
    status: request.status,
    direction: request.fromUserId === viewer.id ? "outgoing" : "incoming",
    createdAt: request.createdAt || "",
    respondedAt: request.respondedAt || "",
    cancelledAt: request.cancelledAt || "",
    player: accountUserRef(otherUser),
    from: accountUserRef(fromUser),
    to: accountUserRef(toUser),
  };
}

function publicFriendRequestsFor(user) {
  ensureAccountData(user);
  const active = user.friendRequests
    .filter(request => request.status !== "cancelled")
    .map(request => friendRequestSummaryFor(user, request))
    .filter(Boolean)
    .sort((a, b) => String(b.respondedAt || b.createdAt).localeCompare(String(a.respondedAt || a.createdAt)));
  return {
    incoming: active
      .filter(request => request.direction === "incoming" && request.status === "pending")
      .slice(0, 20),
    outgoing: active
      .filter(request => request.direction === "outgoing" && ["pending", "accepted", "declined"].includes(request.status))
      .slice(0, 20),
  };
}

function friendRelationship(user, otherUser) {
  ensureAccountData(user);
  if (user.friends.some(friend => friend.userId === otherUser.id)) return "friend";
  const request = user.friendRequests.find(item => (
    item.status === "pending"
    && ((item.fromUserId === user.id && item.toUserId === otherUser.id)
      || (item.fromUserId === otherUser.id && item.toUserId === user.id))
  ));
  if (!request) return "";
  return request.fromUserId === user.id ? "outgoing" : "incoming";
}

function publicAccountProfile(user) {
  ensureAccountData(user);
  const friends = user.friends
    .map(friend => authState.users.find(item => item.id === friend.userId))
    .filter(Boolean)
    .map(friendUser => friendSummaryFor(user, friendUser))
    .sort((a, b) => String(b.lastMessage?.at || b.addedAt).localeCompare(String(a.lastMessage?.at || a.addedAt)));
  const games = user.ratingHistory
    .slice(0, 100)
    .map(entry => ({
      resultKey: entry.resultKey,
      ts: Number(entry.ts || Date.parse(entry.finishedAt || "") || Date.now()),
      at: entry.finishedAt || (entry.ts ? new Date(Number(entry.ts)).toISOString() : ""),
      opponent: entry.opponent || "",
      opponentRating: Number.isFinite(Number(entry.opponentRating)) ? Number(entry.opponentRating) : null,
      didWin: Boolean(entry.didWin),
      mode: entry.mode || "",
      resultType: entry.resultType || "",
      score: entry.score || null,
      history: Array.isArray(entry.history) ? entry.history.slice(0, 500) : [],
      delta: Number(entry.delta || 0),
      ratingAfter: Number(entry.ratingAfter || user.rating),
      tierAfter: entry.tierAfter || user.tier,
    }));
  return {
    user: publicUser(user),
    games,
    stats: {
      gamesPlayed: games.length,
      wins: games.filter(game => game.didWin).length,
      losses: games.filter(game => !game.didWin).length,
      mars: games.filter(game => game.resultType === "mars").length,
      koks: games.filter(game => game.resultType === "koks").length,
    },
    friends,
    friendRequests: publicFriendRequestsFor(user),
  };
}

function normalizeFriendTarget(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 64);
}

function addMutualFriend(user, friendUser) {
  ensureAccountData(user);
  ensureAccountData(friendUser);
  if (user.id === friendUser.id) {
    return { ok: false, message: "Нельзя добавить себя в друзья." };
  }
  const addedAt = now();
  if (!user.friends.some(friend => friend.userId === friendUser.id)) {
    user.friends.unshift({ userId: friendUser.id, nickname: friendUser.nickname, addedAt });
  }
  if (!friendUser.friends.some(friend => friend.userId === user.id)) {
    friendUser.friends.unshift({ userId: user.id, nickname: user.nickname, addedAt });
  }
  return { ok: true };
}

function findPendingFriendRequestBetween(user, friendUser) {
  ensureAccountData(user);
  return user.friendRequests.find(request => (
    request.status === "pending"
    && ((request.fromUserId === user.id && request.toUserId === friendUser.id)
      || (request.fromUserId === friendUser.id && request.toUserId === user.id))
  )) || null;
}

function createFriendRequest(user, friendUser) {
  ensureAccountData(user);
  ensureAccountData(friendUser);
  if (user.id === friendUser.id) {
    return { ok: false, status: "self", message: "Нельзя добавить себя в друзья." };
  }
  if (user.friends.some(friend => friend.userId === friendUser.id)) {
    return { ok: false, status: "friends", message: "Игрок уже у вас в друзьях." };
  }
  const existing = findPendingFriendRequestBetween(user, friendUser);
  if (existing) {
    if (existing.toUserId === user.id) {
      return acceptFriendRequest(user, existing.id);
    }
    return { ok: true, status: "pending", message: "Заявка уже отправлена." };
  }
  const request = {
    id: id("frq"),
    fromUserId: user.id,
    fromName: user.nickname,
    toUserId: friendUser.id,
    toName: friendUser.nickname,
    status: "pending",
    createdAt: now(),
    respondedAt: "",
    cancelledAt: "",
  };
  syncFriendRequestCopies(request);
  return { ok: true, status: "pending", message: "Заявка отправлена." };
}

function acceptFriendRequest(user, requestId) {
  ensureAccountData(user);
  const request = user.friendRequests.find(item => item.id === requestId && item.toUserId === user.id && item.status === "pending");
  if (!request) {
    return { ok: false, status: "missing", message: "Заявка не найдена или уже обработана." };
  }
  const friendUser = authState.users.find(item => item.id === request.fromUserId);
  if (!friendUser) {
    return { ok: false, status: "missing", message: "Игрок не найден." };
  }
  addMutualFriend(user, friendUser);
  request.status = "accepted";
  request.respondedAt = now();
  syncFriendRequestCopies(request);
  return { ok: true, status: "accepted", message: "Заявка принята." };
}

function declineFriendRequest(user, requestId) {
  ensureAccountData(user);
  const request = user.friendRequests.find(item => item.id === requestId && item.toUserId === user.id && item.status === "pending");
  if (!request) {
    return { ok: false, status: "missing", message: "Заявка не найдена или уже обработана." };
  }
  request.status = "declined";
  request.respondedAt = now();
  syncFriendRequestCopies(request);
  return { ok: true, status: "declined", message: "Заявка отклонена." };
}

function cancelFriendRequest(user, requestId) {
  ensureAccountData(user);
  const request = user.friendRequests.find(item => item.id === requestId && item.fromUserId === user.id && item.status === "pending");
  if (!request) {
    return { ok: false, status: "missing", message: "Заявка не найдена или уже обработана." };
  }
  request.status = "cancelled";
  request.cancelledAt = now();
  syncFriendRequestCopies(request);
  return { ok: true, status: "cancelled", message: "Заявка отменена." };
}

function removeMutualFriend(user, friendUser) {
  ensureAccountData(user);
  ensureAccountData(friendUser);
  user.friends = user.friends.filter(friend => friend.userId !== friendUser.id);
  friendUser.friends = friendUser.friends.filter(friend => friend.userId !== user.id);
}

function accountThreadId(a, b) {
  return [String(a || ""), String(b || "")].sort().join(":");
}

function publicFriendMessage(message, viewerId) {
  return {
    id: message.id,
    threadId: message.threadId,
    fromUserId: message.fromUserId,
    fromName: message.fromName,
    toUserId: message.toUserId,
    toName: message.toName,
    text: message.text,
    kind: message.kind || "text",
    audioData: message.audioData || "",
    mimeType: message.mimeType || "",
    duration: Number(message.duration || 0),
    at: message.at,
    own: message.fromUserId === viewerId,
    readAt: message.readAt || null,
  };
}

function findAuthUserByNickname(nickname) {
  const key = normalizePlayerName(nickname);
  return authState.users.find(user => normalizePlayerName(user.nickname) === key) || null;
}

function findAuthUserByEmail(email) {
  const key = normalizeEmail(email);
  return authState.users.find(user => normalizeEmail(user.email) === key) || null;
}

function findAuthUserByIdentifier(identifier) {
  const value = String(identifier || "").trim();
  return value.includes("@") ? findAuthUserByEmail(value) : findAuthUserByNickname(value);
}

function validateAccountInput({ nickname, email, password }) {
  const cleanNickname = normalizeNickname(nickname);
  const cleanEmail = normalizeEmail(email);
  const cleanPassword = String(password || "");
  if (cleanNickname.length < 3 || cleanNickname.length > 20) {
    return { ok: false, message: "Никнейм должен быть от 3 до 20 символов." };
  }
  if (!/^[\p{L}\p{N}_ -]+$/u.test(cleanNickname)) {
    return { ok: false, message: "Никнейм может содержать буквы, цифры, пробел, дефис и подчёркивание." };
  }
  if (!isValidEmail(cleanEmail)) {
    return { ok: false, message: "Введите корректный email." };
  }
  if (cleanPassword.length < 6) {
    return { ok: false, message: "Пароль должен быть не короче 6 символов." };
  }
  return { ok: true, nickname: cleanNickname, email: cleanEmail, password: cleanPassword };
}

function sendRegistrationEmail(user) {
  return queueMail({
    to: user.email,
    subject: "Online Backgammon registration",
    type: "registration",
    text: `Congratulations, you've registered on the online backgammon portal under the nickname ${user.nickname}. We wish you a pleasant game!`,
  });
}

function createPasswordReset(user) {
  const code = String(crypto.randomInt(100000, 1000000));
  const reset = {
    id: id("rst"),
    userId: user.id,
    email: user.email,
    codeHash: sha256(code),
    createdAt: now(),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString(),
  };
  authState.passwordResets = authState.passwordResets.filter(item => item.userId !== user.id && Date.parse(item.expiresAt) > Date.now() && !item.usedAt);
  authState.passwordResets.push(reset);
  queueMail({
    to: user.email,
    subject: "Online Backgammon password recovery",
    type: "password-recovery",
    text: `Password recovery code for ${user.nickname}: ${code}. The code is valid for 30 minutes.`,
  });
  saveAuthState();
  return reset;
}

function adminUserKey(value) {
  return normalizePlayerName(value);
}

function findAdminUser(value) {
  const key = decodeURIComponent(String(value || ""));
  const normalized = adminUserKey(key);
  hydrateAdminUsersFromRooms();
  return adminState.users.find(user => user.id === key || adminUserKey(user.name) === normalized) || null;
}

function touchAdminUser({ name, email = "", rating = null, tier = "", registered = false, ratingEligible = false, ip = "", source = "room" } = {}) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim().slice(0, 32);
  const key = adminUserKey(cleanName);
  if (!key) return null;
  const canRate = Boolean(registered || ratingEligible || email);
  const cleanRating = canRate ? normalizeRating(rating) : null;
  let user = adminState.users.find(item => adminUserKey(item.name) === key);
  if (!user) {
    user = {
      id: `ply_${sha256(key).slice(0, 16)}`,
      name: cleanName,
      email: normalizeEmail(email),
      rating: cleanRating,
      tier: canRate ? ratingTierFor(cleanRating) : "",
      ratingEligible: canRate,
      source: canRate ? "account" : source,
      firstSeenAt: now(),
      createdAt: now(),
      gamesPlayed: 0,
      gamesWon: 0,
      banHistory: [],
    };
    adminState.users.push(user);
  }
  user.name = cleanName;
  if (email) {
    user.email = normalizeEmail(email);
    user.source = "account";
    user.ratingEligible = true;
  } else if (!user.source) {
    user.source = source;
  }
  if (canRate || user.ratingEligible) {
    user.rating = normalizeRating(rating ?? user.rating);
    user.tier = ratingTierFor(user.rating);
    user.ratingEligible = true;
  } else {
    user.rating = null;
    user.tier = "";
    user.ratingEligible = false;
  }
  user.lastSeenAt = now();
  if (ip) user.ip = ip;
  return user;
}

function hydrateAdminUsersFromRooms() {
  authState.users.forEach(user => {
    assignRegisteredRating(user);
    touchAdminUser({ name: user.nickname, email: user.email, rating: user.rating, tier: user.tier, registered: true, source: "account" });
  });
  rooms.forEach(room => {
    touchAdminUser({ name: room.hostName, rating: room.hostRating, registered: room.hostRegistered, ratingEligible: room.hostRatingEligible, source: room.hostRegistered ? "account" : "guest" });
    if (room.guestName) touchAdminUser({ name: room.guestName, rating: room.guestRating, registered: room.guestRegistered, ratingEligible: room.guestRatingEligible, source: room.guestRegistered ? "account" : "guest" });
  });
}

function isAdminUserBanned(name) {
  const user = findAdminUser(name);
  return Boolean(user?.bannedAt);
}

function roomHasAdminUser(room, user) {
  const key = adminUserKey(user?.name);
  if (!key) return false;
  return adminUserKey(room.hostName) === key || adminUserKey(room.guestName) === key;
}

function setAdminUserPassword(user, password) {
  const cleanPassword = String(password || "").trim();
  if (cleanPassword.length < 4) return { ok: false, message: "Пароль должен быть не короче 4 символов." };
  user.passwordHash = hashPassword(cleanPassword);
  user.passwordChangedAt = now();
  const authUser = findAuthUserByNickname(user.name);
  if (authUser) {
    authUser.passwordHash = user.passwordHash;
    authUser.passwordChangedAt = user.passwordChangedAt;
    saveAuthState();
  }
  return { ok: true };
}

function banAdminUser(user, adminLogin, reason = "") {
  const at = now();
  const cleanReason = String(reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
  user.bannedAt = at;
  user.bannedBy = adminLogin;
  user.banReason = cleanReason;
  user.banHistory ||= [];
  user.banHistory.push({ action: "ban", by: adminLogin, reason: cleanReason, at });
  user.banHistory = user.banHistory.slice(-50);
  [...rooms].forEach(room => {
    if (roomHasAdminUser(room, user)) closeRoomByAdmin(room, adminLogin, cleanReason || "Игрок заблокирован администратором");
  });
  return { at, reason: user.banReason };
}

function unbanAdminUser(user, adminLogin) {
  if (!user.bannedAt) return false;
  const at = now();
  user.banHistory ||= [];
  user.banHistory.push({ action: "unban", by: adminLogin, at });
  user.banHistory = user.banHistory.slice(-50);
  delete user.bannedAt;
  delete user.bannedBy;
  delete user.banReason;
  return true;
}

function deleteAdminUser(user, adminLogin) {
  [...rooms].forEach(room => {
    if (roomHasAdminUser(room, user)) closeRoomByAdmin(room, adminLogin, "Аккаунт удалён администратором");
  });
  adminState.users = adminState.users.filter(item => item.id !== user.id);
  const removedAuthIds = authState.users
    .filter(item => normalizePlayerName(item.nickname) === normalizePlayerName(user.name))
    .map(item => item.id);
  authState.users = authState.users.filter(item => !removedAuthIds.includes(item.id));
  authState.passwordResets = authState.passwordResets.filter(item => !removedAuthIds.includes(item.userId));
  saveAuthState();
}

function isRoomActiveForPlayer(room, playerName) {
  const name = normalizePlayerName(playerName);
  if (!name || !["waiting", "joined"].includes(room.status)) return false;
  const left = room.leftPlayers || {};
  const isHost = normalizePlayerName(room.hostName) === name && left.white !== true;
  const isGuest = normalizePlayerName(room.guestName) === name && left.dark !== true;
  return isHost || isGuest;
}

function opponentColor(color) {
  return color === "dark" ? "white" : "dark";
}

function ensurePresence(room) {
  room.presence ||= { white: null, dark: null };
  return room.presence;
}

function touchPresence(room, color, name) {
  const presence = ensurePresence(room);
  const now = Date.now();
  presence[color] = {
    ...(presence[color] || {}),
    color,
    name: String(name || "").slice(0, 32),
    lastSeen: now,
    disconnectedAt: null,
    deadlineAt: null,
  };
  room.presenceUpdatedAt = new Date(now).toISOString();
}

function networkLossMessage() {
  return "Соединение потеряно, игра принудительно завершена";
}

function forceNetworkLoss(room, loserColor, now = Date.now()) {
  if (room.gameState?.phase === "over" || room.gameState?.winner) return false;
  const winnerColor = opponentColor(loserColor);
  const at = new Date(now).toISOString();
  const state = room.gameState && typeof room.gameState === "object"
    ? JSON.parse(JSON.stringify(room.gameState))
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
  state.finishedAt ||= now;
  state.networkLoss = {
    loserColor,
    winnerColor,
    message: networkLossMessage(),
    at,
  };
  state.history ||= [];
  state.history.unshift({
    networkLoss: true,
    color: loserColor,
    winnerColor,
    message: networkLossMessage(),
    at,
  });
  room.gameState = state;
  room.networkLoss = state.networkLoss;
  room.gameVersion = (room.gameVersion || 0) + 1;
  room.gameUpdatedAt = at;
  archiveFinishedRoom(room, "network_loss");
  return true;
}

function updatePresenceStatus(room, now = Date.now()) {
  if (!room || room.status !== "joined") return;
  const presence = ensurePresence(room);
  ["white", "dark"].forEach(color => {
    const item = presence[color];
    if (!item?.lastSeen) return;
    const lostAt = item.lastSeen + PRESENCE_STALE_MS;
    if (now <= lostAt) return;
    item.disconnectedAt ||= lostAt;
    item.deadlineAt ||= item.disconnectedAt + NETWORK_GRACE_MS;
    if (now >= item.deadlineAt) forceNetworkLoss(room, color, now);
  });
}

function publicPresence(room, viewerColor) {
  const now = Date.now();
  updatePresenceStatus(room, now);
  const presence = ensurePresence(room);
  const opponent = opponentColor(viewerColor);
  const opponentPresence = presence[opponent] || null;
  const disconnected = Boolean(opponentPresence?.disconnectedAt);
  return {
    now,
    graceMs: NETWORK_GRACE_MS,
    staleMs: PRESENCE_STALE_MS,
    viewerColor,
    opponent: {
      color: opponent,
      name: opponentPresence?.name || "",
      online: Boolean(opponentPresence?.lastSeen) && !disconnected,
      disconnected,
      disconnectedAt: opponentPresence?.disconnectedAt || null,
      deadlineAt: opponentPresence?.deadlineAt || null,
      remainingMs: disconnected ? Math.max(0, (opponentPresence.deadlineAt || now) - now) : NETWORK_GRACE_MS,
    },
    networkLoss: room.networkLoss || room.gameState?.networkLoss || null,
    gameVersion: room.gameVersion || 0,
  };
}

function statusForAdmin(room) {
  if (room.closedByAdmin) return "closed";
  if (isFinalGameState(room.gameState)) return "closed";
  if (room.status === "joined") return "playing";
  return room.status || "waiting";
}

function adminPlayersForRoom(room) {
  const players = [];
  if (room.hostName) {
    const user = touchAdminUser({ name: room.hostName, rating: room.hostRating, registered: room.hostRegistered, ratingEligible: room.hostRatingEligible, source: room.hostRegistered ? "account" : "guest" });
    players.push({
      id: user?.id || `ply_${sha256(adminUserKey(room.hostName)).slice(0, 16)}`,
      name: room.hostName,
      color: "white",
      rating: room.hostRegistered ? normalizeRating(room.hostRating) : null,
      tier: room.hostRegistered ? ratingTierFor(room.hostRating) : "",
      ratingEligible: Boolean(room.hostRegistered),
    });
  }
  if (room.guestName) {
    const user = touchAdminUser({ name: room.guestName, rating: room.guestRating, registered: room.guestRegistered, ratingEligible: room.guestRatingEligible, source: room.guestRegistered ? "account" : "guest" });
    players.push({
      id: user?.id || `ply_${sha256(adminUserKey(room.guestName)).slice(0, 16)}`,
      name: room.guestName,
      color: "dark",
      rating: room.guestRegistered ? normalizeRating(room.guestRating) : null,
      tier: room.guestRegistered ? ratingTierFor(room.guestRating) : "",
      ratingEligible: Boolean(room.guestRegistered),
    });
  }
  return players;
}

function latestRoomEventAt(room) {
  const dates = [
    room.gameUpdatedAt,
    room.presenceUpdatedAt,
    room.joinedAt,
    room.lastLeftAt,
    room.closedByAdmin?.at,
    room.networkLoss?.at,
    room.gameState?.finishedAt ? new Date(room.gameState.finishedAt).toISOString() : "",
    room.gameState?.history?.[0]?.at,
    room.chat?.[room.chat.length - 1]?.at,
    room.createdAt,
  ].filter(Boolean);
  return dates.sort().at(-1) || now();
}

function rollStats(game) {
  const rolls = (game?.history || []).filter(item => item.roll);
  const doubles = rolls.filter(item => {
    const [a, b] = String(item.roll).split(":").map(Number);
    return Number.isFinite(a) && a === b;
  });
  return {
    rolls: rolls.length,
    doubles: doubles.length,
    doubleRate: rolls.length ? doubles.length / rolls.length : 0,
    lastRoll: rolls[0] ? { color: rolls[0].color, roll: rolls[0].roll, at: rolls[0].at, sha256: rolls[0].sha256 } : null,
  };
}

function adminSessionFromRoom(room) {
  const game = deepClone(room.gameState || {});
  game.history ||= [];
  game.chat = (room.chat || []).map(message => ({
    id: message.id,
    author: message.senderName,
    color: message.color,
    text: message.kind === "voice" ? "Голосовое сообщение" : message.text,
    kind: message.kind || "text",
    at: message.at,
  })).reverse();
  game.off ||= { white: 0, dark: 0 };
  game.borneOff = game.off;
  return {
    id: room.id,
    code: room.code,
    name: `${room.hostName || "Хост"}${room.guestName ? ` vs ${room.guestName}` : ""}`,
    variant: room.variant,
    status: statusForAdmin(room),
    privacy: room.access === "closed" ? "password" : "open",
    players: adminPlayersForRoom(room),
    createdAt: room.createdAt,
    updatedAt: latestRoomEventAt(room),
    joinedAt: room.joinedAt || null,
    closedByAdmin: room.closedByAdmin || null,
    game,
  };
}

function adminSessionSummary(session, archive = null) {
  const stats = rollStats(session.game);
  const winnerColor = session.game?.winner || null;
  const winnerPlayer = winnerColor ? session.players.find(player => player.color === winnerColor) : null;
  return {
    id: session.id,
    archiveId: archive?.id || null,
    source: archive ? "archive" : "active",
    code: session.code,
    name: session.name,
    variant: session.variant,
    status: session.status,
    privacy: session.privacy,
    players: session.players,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt || session.createdAt,
    archivedAt: archive?.archivedAt || null,
    expiresAt: archive?.expiresAt || null,
    archiveReason: archive?.reason || null,
    adminCloseReason: session.closedByAdmin?.reason || archive?.adminReason || null,
    closedByAdmin: session.closedByAdmin || archive?.closedByAdmin || null,
    winner: winnerColor,
    winnerName: winnerPlayer?.name || null,
    winnerPlayer: winnerPlayer || null,
    resultType: session.game?.resultType || null,
    borneOff: session.game?.borneOff || session.game?.off || { white: 0, dark: 0 },
    historyCount: session.game?.history?.length || 0,
    chatCount: session.game?.chat?.length || 0,
    ...stats,
  };
}

function isFinalGameState(gameState) {
  return Boolean(gameState && typeof gameState === "object" && (
    gameState.phase === "over"
    || gameState.winner
    || gameState.finishedAt
  ));
}

function archiveReasonForRoom(room) {
  const game = room.gameState || {};
  const latest = Array.isArray(game.history) ? game.history[0] : null;
  if (room.closedByAdmin || game.adminClosed) return "admin_closed";
  if (room.networkLoss || game.networkLoss || latest?.networkLoss) return "network_loss";
  if (latest?.resign) return "resignation";
  if (latest?.leave) return "player_leave";
  return "finished";
}

function archiveRoom(room, reason = "snapshot", adminReason = "") {
  ensureAdminState();
  const archivedAt = now();
  const expiresAt = archiveExpiresAt({ archivedAt });
  const session = adminSessionFromRoom(room);
  session.status = "closed";
  session.archivedAt = archivedAt;
  const archiveId = `arc_${room.id}`;
  const entry = {
    id: archiveId,
    sessionId: room.id,
    code: room.code,
    reason,
    adminReason,
    archivedAt,
    expiresAt,
    closedByAdmin: session.closedByAdmin,
    session,
  };
  const existing = adminState.archive.find(item => item.id === archiveId || item.sessionId === room.id);
  if (existing) Object.assign(existing, entry);
  else adminState.archive.unshift(entry);
  adminState.archive = adminState.archive
    .map(item => normalizeArchiveEntry(item).entry)
    .filter(item => archiveExpiryMs(item) > Date.now())
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  saveAdminState();
  return entry;
}

function archiveFinishedRoom(room, reason = archiveReasonForRoom(room)) {
  if (!room || !isFinalGameState(room.gameState)) return null;
  room.status = "closed";
  return archiveRoom(room, reason);
}

function normalizeAdminCloseReason(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function closeRoomByAdmin(room, adminLogin, reason) {
  const cleanReason = normalizeAdminCloseReason(reason);
  const closedAt = now();
  room.closedByAdmin = { login: adminLogin, reason: cleanReason, at: closedAt };
  room.status = "closed";
  room.gameState ||= {
    points: {},
    off: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    history: [],
  };
  room.gameState.phase = "over";
  room.gameState.resultType = "admin_closed";
  room.gameState.dice = [];
  room.gameState.rolled = [];
  room.gameState.adminClosed = room.closedByAdmin;
  room.gameState.history ||= [];
  room.gameState.history.unshift({ adminClosed: true, by: adminLogin, reason: cleanReason, at: closedAt });
  room.gameVersion = (room.gameVersion || 0) + 1;
  room.gameUpdatedAt = closedAt;
  const archive = archiveRoom(room, "admin_closed", cleanReason);
  const index = rooms.findIndex(item => item.id === room.id);
  if (index !== -1) rooms.splice(index, 1);
  return archive;
}

function findAdminRoom(value) {
  const key = decodeURIComponent(String(value || ""));
  const active = rooms.find(room => room.id === key || room.code === key.toUpperCase());
  if (active) return { session: adminSessionFromRoom(active), room: active, archive: null };
  const archive = adminState.archive.find(item => item.id === key || item.sessionId === key || item.code === key.toUpperCase());
  return archive ? { session: archive.session, room: null, archive } : null;
}

function deleteAdminRoom(value) {
  const key = decodeURIComponent(String(value || ""));
  const activeIndex = rooms.findIndex(room => room.id === key || room.code === key.toUpperCase());
  if (activeIndex !== -1) {
    const [room] = rooms.splice(activeIndex, 1);
    return { code: room.code, sessionId: room.id, source: "active" };
  }
  const archiveIndex = adminState.archive.findIndex(item => item.id === key || item.sessionId === key || item.code === key.toUpperCase());
  if (archiveIndex !== -1) {
    const [archive] = adminState.archive.splice(archiveIndex, 1);
    return { code: archive.code || archive.session?.code || key, sessionId: archive.sessionId || archive.session?.id || key, archiveId: archive.id, source: "archive" };
  }
  return null;
}

function adminUserSummary(user) {
  const activeRooms = rooms.filter(room => roomHasAdminUser(room, user));
  const archiveRooms = adminState.archive.filter(item => (item.session?.players || []).some(player => adminUserKey(player.name) === adminUserKey(user.name)));
  const wins = archiveRooms.filter(item => item.session?.game?.winner && item.session.players.some(player => (
    adminUserKey(player.name) === adminUserKey(user.name) && player.color === item.session.game.winner
  )));
  return {
    id: user.id,
    name: user.name,
    email: user.email || "",
    ip: user.ip || "",
    source: user.source || "room",
    passwordState: user.passwordHash ? "set" : "client",
    createdAt: user.createdAt || user.firstSeenAt || now(),
    firstSeenAt: user.firstSeenAt || user.createdAt || now(),
    lastSeenAt: user.lastSeenAt || null,
    gamesPlayed: Number(user.gamesPlayed || archiveRooms.length),
    gamesWon: Number(user.gamesWon || wins.length),
    activeRooms: activeRooms.length,
    rating: user.ratingEligible ? normalizeRating(user.rating) : null,
    tier: user.ratingEligible ? ratingTierFor(user.rating) : "",
    ratingEligible: Boolean(user.ratingEligible),
    banned: Boolean(user.bannedAt),
    bannedAt: user.bannedAt || null,
    bannedBy: user.bannedBy || null,
    banReason: user.banReason || "",
    banHistory: Array.isArray(user.banHistory) ? user.banHistory.slice(-20) : [],
  };
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 4; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (rooms.some(room => room.code === code));
  return code;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function handleAdminApi(req, res, url) {
  ensureAdminState();
  hydrateAdminUsersFromRooms();
  const pathname = url.pathname;
  const body = req.method === "GET" ? {} : await readJsonBody(req);

  if (pathname === "/api/admin/login" && req.method === "POST") {
    const credentials = loadAdminCredentials();
    if (!credentials.passwordHash && !credentials.password) {
      sendJson(res, 503, { error: "Админ-пароль не задан." });
      return;
    }
    const login = String(body.login || DEFAULT_ADMIN_LOGIN).trim();
    const password = String(body.password || "");
    if (login !== credentials.login || !verifyAdminPassword(password, credentials)) {
      addAdminAudit(req, "login_failed", { login });
      sendJson(res, 401, { error: "Неверный пароль администратора." });
      return;
    }
    const token = id("adm");
    const expiresAt = new Date(Date.now() + ADMIN_TOKEN_TTL_MS).toISOString();
    adminState.tokens.push({ token, login, createdAt: now(), expiresAt, ip: clientIp(req) });
    adminState.tokens = adminState.tokens.slice(-20);
    addAdminAudit(req, "login", { login });
    sendJson(res, 200, {
      admin: { login },
      retentionHours: Math.round(ADMIN_ARCHIVE_HOURS),
      tokenExpiresAt: expiresAt,
    }, {
      "Set-Cookie": `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ADMIN_TOKEN_TTL_MS / 1000)}`,
      "Cache-Control": "no-store",
    });
    return;
  }

  if (pathname === "/api/admin/me" && req.method === "GET") {
    const admin = requireAdmin(req);
    sendJson(res, 200, {
      admin: admin ? { login: admin.login } : null,
      configured: adminPasswordConfigured(),
      retentionHours: Math.round(ADMIN_ARCHIVE_HOURS),
    }, { "Cache-Control": "no-store" });
    return;
  }

  const admin = requireAdmin(req);
  if (!admin) {
    sendJson(res, 401, { error: "Нужен вход администратора." });
    return;
  }

  if (pathname === "/api/admin/password" && req.method === "POST") {
    const credentials = loadAdminCredentials();
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "").trim();
    if (!verifyAdminPassword(currentPassword, credentials)) {
      sendJson(res, 403, { error: "Текущий пароль администратора указан неверно." });
      return;
    }
    if (newPassword.length < 4) {
      sendJson(res, 400, { error: "Новый пароль должен быть не короче 4 символов." });
      return;
    }
    saveAdminCredentials({ login: credentials.login, passwordHash: hashPassword(newPassword) });
    adminState.tokens = adminState.tokens.filter(item => item.token === admin.token);
    addAdminAudit(req, "change_admin_password", { login: admin.login });
    sendJson(res, 200, { ok: true, admin: { login: credentials.login } });
    return;
  }

  if (pathname === "/api/admin/logout" && req.method === "POST") {
    adminState.tokens = adminState.tokens.filter(item => item.token !== admin.token);
    addAdminAudit(req, "logout", { login: admin.login });
    sendJson(res, 200, { ok: true }, {
      "Set-Cookie": `${ADMIN_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`,
      "Cache-Control": "no-store",
    });
    return;
  }

  if (pathname === "/api/admin/sessions" && req.method === "GET") {
    rooms.forEach(room => archiveFinishedRoom(room));
    const active = rooms
      .filter(room => !(room.status === "closed" && isFinalGameState(room.gameState)))
      .map(room => adminSessionSummary(adminSessionFromRoom(room)))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const archive = adminState.archive
      .map(item => adminSessionSummary(item.session, item))
      .sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
    sendJson(res, 200, {
      active,
      archive,
      audit: adminState.audit.slice(0, 50),
      retentionHours: Math.round(ADMIN_ARCHIVE_HOURS),
    }, { "Cache-Control": "no-store" });
    return;
  }

  if (pathname === "/api/admin/users" && req.method === "GET") {
    const users = adminState.users
      .map(adminUserSummary)
      .sort((a, b) => String(b.lastSeenAt || b.createdAt).localeCompare(String(a.lastSeenAt || a.createdAt)));
    sendJson(res, 200, { users }, { "Cache-Control": "no-store" });
    return;
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)(?:\/(password|ban|unban))?$/);
  if (userMatch) {
    const user = findAdminUser(userMatch[1]);
    if (!user) {
      sendJson(res, 404, { error: "Игрок не найден." });
      return;
    }
    const action = userMatch[2] || "";

    if (action === "password" && req.method === "POST") {
      const result = setAdminUserPassword(user, body.password);
      if (!result.ok) {
        sendJson(res, 400, { error: result.message });
        return;
      }
      addAdminAudit(req, "reset_user_password", { login: admin.login, userId: user.id, name: user.name });
      saveAdminState();
      sendJson(res, 200, { user: adminUserSummary(user) });
      return;
    }

    if (action === "ban" && req.method === "POST") {
      const ban = banAdminUser(user, admin.login, body.reason);
      addAdminAudit(req, "ban_user", { login: admin.login, userId: user.id, name: user.name, reason: ban.reason });
      saveAdminState();
      sendJson(res, 200, { user: adminUserSummary(user) });
      return;
    }

    if (action === "unban" && req.method === "POST") {
      unbanAdminUser(user, admin.login);
      addAdminAudit(req, "unban_user", { login: admin.login, userId: user.id, name: user.name });
      saveAdminState();
      sendJson(res, 200, { user: adminUserSummary(user) });
      return;
    }

    if (!action && req.method === "DELETE") {
      const deleted = { id: user.id, name: user.name };
      deleteAdminUser(user, admin.login);
      addAdminAudit(req, "delete_user", { login: admin.login, userId: deleted.id, name: deleted.name });
      saveAdminState();
      sendJson(res, 200, { ok: true, deleted });
      return;
    }
  }

  const roomCloseMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/close$/);
  if (roomCloseMatch && req.method === "POST") {
    const key = decodeURIComponent(String(roomCloseMatch[1] || ""));
    const room = rooms.find(item => item.id === key || item.code === key.toUpperCase());
    if (!room) {
      sendJson(res, 404, { error: "Активная комната не найдена." });
      return;
    }
    const reason = normalizeAdminCloseReason(body.reason);
    if (!reason) {
      sendJson(res, 400, { error: "Укажите причину закрытия комнаты." });
      return;
    }
    const archive = closeRoomByAdmin(room, admin.login, reason);
    addAdminAudit(req, "close_room", { login: admin.login, code: room.code, sessionId: room.id, reason });
    sendJson(res, 200, {
      ok: true,
      summary: adminSessionSummary(archive.session, archive),
      archive: { id: archive.id, reason: archive.reason, adminReason: archive.adminReason, archivedAt: archive.archivedAt, expiresAt: archive.expiresAt },
    });
    return;
  }

  const roomMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)$/);
  if (roomMatch && req.method === "DELETE") {
    const deleted = deleteAdminRoom(roomMatch[1]);
    if (!deleted) {
      sendJson(res, 404, { error: "Комната не найдена." });
      return;
    }
    addAdminAudit(req, "delete_room", { login: admin.login, code: deleted.code, sessionId: deleted.sessionId, archiveId: deleted.archiveId || null, source: deleted.source });
    saveAdminState();
    sendJson(res, 200, { ok: true, deleted });
    return;
  }

  if (roomMatch && req.method === "GET") {
    const found = findAdminRoom(roomMatch[1]);
    if (!found) {
      sendJson(res, 404, { error: "Комната не найдена." });
      return;
    }
    addAdminAudit(req, "view_room", { login: admin.login, code: found.session.code, sessionId: found.session.id, source: found.archive ? "archive" : "active" });
    sendJson(res, 200, {
      summary: adminSessionSummary(found.session, found.archive),
      session: found.session,
      archive: found.archive ? { id: found.archive.id, reason: found.archive.reason, archivedAt: found.archive.archivedAt, expiresAt: found.archive.expiresAt } : null,
    }, { "Cache-Control": "no-store" });
    return;
  }

  sendJson(res, 404, { error: "Неизвестный admin API-маршрут." });
}

async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (parts[0] === "api" && parts[1] === "admin") {
      await handleAdminApi(req, res, url);
      return;
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "register") {
      const body = await readJsonBody(req);
      const validation = validateAccountInput({
        nickname: body.nickname || body.name,
        email: body.email,
        password: body.password,
      });
      if (!validation.ok) {
        sendJson(res, 400, { error: validation.message });
        return;
      }
      if (findAuthUserByEmail(validation.email)) {
        sendJson(res, 409, { error: "На эту электронную почту уже зарегистрирован аккаунт." });
        return;
      }
      if (findAuthUserByNickname(validation.nickname)) {
        sendJson(res, 409, { error: "Такой никнейм уже занят." });
        return;
      }
      if (isAdminUserBanned(validation.nickname)) {
        sendJson(res, 403, { error: "Этот никнейм заблокирован администратором." });
        return;
      }
      const user = {
        id: id("usr"),
        nickname: validation.nickname,
        email: validation.email,
        passwordHash: hashPassword(validation.password),
        rating: DEFAULT_RATING,
        tier: ratingTierFor(DEFAULT_RATING),
        ratingEligible: true,
        ratingHistory: [],
        registrationIp: clientIp(req),
        lastIp: clientIp(req),
        createdAt: now(),
        lastSeenAt: now(),
      };
      assignRegisteredRating(user);
      authState.users.push(user);
      touchAdminUser({ name: user.nickname, email: user.email, rating: user.rating, tier: user.tier, registered: true, ip: clientIp(req), source: "account" });
      sendRegistrationEmail(user);
      saveAuthState();
      saveAdminState();
      sendJson(res, 201, { user: publicUser(user), emailSent: true });
      return;
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "login") {
      const body = await readJsonBody(req);
      const identifier = String(body.identifier || body.nickname || body.email || "").trim();
      const password = String(body.password || "");
      const user = findAuthUserByIdentifier(identifier);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        sendJson(res, 401, { error: "Неверный никнейм/email или пароль." });
        return;
      }
      if (isAdminUserBanned(user.nickname)) {
        sendJson(res, 403, { error: "Этот аккаунт заблокирован администратором." });
        return;
      }
      user.lastIp = clientIp(req);
      user.lastSeenAt = now();
      assignRegisteredRating(user);
      touchAdminUser({ name: user.nickname, email: user.email, rating: user.rating, tier: user.tier, registered: true, ip: clientIp(req), source: "account" });
      saveAuthState();
      saveAdminState();
      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    if (method === "POST" && parts.length === 3 && parts[0] === "api" && parts[1] === "password-recovery" && parts[2] === "request") {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const user = findAuthUserByEmail(email);
      if (user) createPasswordReset(user);
      sendJson(res, 200, {
        ok: true,
        message: "Если email зарегистрирован, на него отправлен код восстановления.",
      });
      return;
    }

    if (method === "POST" && parts.length === 3 && parts[0] === "api" && parts[1] === "password-recovery" && parts[2] === "reset") {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const code = String(body.code || "").replace(/\s+/g, "");
      const password = String(body.password || "");
      const user = findAuthUserByEmail(email);
      if (!user || password.length < 6) {
        sendJson(res, 400, { error: "Проверьте email и новый пароль. Пароль должен быть не короче 6 символов." });
        return;
      }
      const reset = authState.passwordResets.find(item => (
        item.userId === user.id
        && !item.usedAt
        && Date.parse(item.expiresAt) > Date.now()
        && constantTimeStringEqual(item.codeHash, sha256(code))
      ));
      if (!reset) {
        sendJson(res, 400, { error: "Код восстановления неверный или истёк." });
        return;
      }
      user.passwordHash = hashPassword(password);
      user.passwordChangedAt = now();
      user.lastSeenAt = now();
      reset.usedAt = now();
      const adminUser = findAdminUser(user.nickname);
      if (adminUser) {
        adminUser.passwordHash = user.passwordHash;
        adminUser.passwordChangedAt = user.passwordChangedAt;
      }
      saveAuthState();
      saveAdminState();
      sendJson(res, 200, { ok: true, user: publicUser(user) });
      return;
    }

    if (method === "POST" && parts.length === 3 && parts[0] === "api" && parts[1] === "rating" && parts[2] === "sync") {
      const body = await readJsonBody(req);
      const userId = String(body.userId || "").trim();
      const nickname = String(body.nickname || body.name || "").trim();
      const user = authState.users.find(item => (
        (userId && item.id === userId)
        || (nickname && normalizePlayerName(item.nickname) === normalizePlayerName(nickname))
      )) || null;
      if (!user) {
        sendJson(res, 403, { error: "Рейтинг доступен только зарегистрированным игрокам." });
        return;
      }
      assignRegisteredRating(user, body.rating);
      const resultKey = String(body.resultKey || "").slice(0, 120);
      user.ratingHistory = Array.isArray(user.ratingHistory) ? user.ratingHistory : [];
      if (resultKey && !user.ratingHistory.some(item => item.resultKey === resultKey)) {
        user.ratingHistory.unshift({
          resultKey,
          ts: Number(body.ts || Date.now()),
          finishedAt: body.finishedAt || new Date(Number(body.ts || Date.now())).toISOString(),
          opponent: String(body.opponent || "").slice(0, 32),
          opponentRating: Number.isFinite(Number(body.opponentRating)) ? Number(body.opponentRating) : null,
          didWin: Boolean(body.didWin),
          mode: String(body.mode || "").slice(0, 20),
          resultType: ["mars", "koks"].includes(body.resultType) ? body.resultType : "",
          winner: body.winner === "dark" ? "dark" : (body.winner === "white" ? "white" : ""),
          score: body.score && typeof body.score === "object"
            ? {
                white: Number(body.score.white) || 0,
                dark: Number(body.score.dark) || 0,
              }
            : null,
          history: Array.isArray(body.history) ? body.history.slice(0, 500) : [],
          delta: Number(body.delta || 0),
          ratingAfter: user.rating,
          tierAfter: user.tier,
        });
        user.ratingHistory = user.ratingHistory.slice(0, 100);
      }
      user.lastSeenAt = now();
      touchAdminUser({ name: user.nickname, email: user.email, rating: user.rating, tier: user.tier, registered: true, ip: clientIp(req), source: "account" });
      saveAuthState();
      saveAdminState();
      sendJson(res, 200, { ok: true, user: publicUser(user) });
      return;
    }

    if (parts[0] === "api" && parts[1] === "account") {
      const body = method === "GET" ? {} : await readJsonBody(req);
      const user = accountUserFromRequest(url, body);
      if (!user) {
        sendJson(res, 401, { error: "Нужен зарегистрированный аккаунт." });
        return;
      }
      ensureAccountData(user);

      if (method === "GET" && parts.length === 3 && parts[2] === "profile") {
        user.lastSeenAt = now();
        saveAuthState();
        touchAdminUser({ name: user.nickname, email: user.email, rating: user.rating, tier: user.tier, registered: true, ip: clientIp(req), source: "account" });
        saveAdminState();
        sendJson(res, 200, publicAccountProfile(user), { "Cache-Control": "no-store" });
        return;
      }

      if (method === "PATCH" && parts.length === 3 && parts[2] === "profile") {
        const nextNickname = normalizeNickname(body.nickname || body.name || user.nickname);
        const nextEmail = normalizeEmail(body.email || user.email);
        if (nextNickname.length < 3 || nextNickname.length > 20 || !/^[\p{L}\p{N}_ -]+$/u.test(nextNickname)) {
          sendJson(res, 400, { error: "Никнейм должен быть от 3 до 20 символов." });
          return;
        }
        const nicknameOwner = findAuthUserByNickname(nextNickname);
        if (nicknameOwner && nicknameOwner.id !== user.id) {
          sendJson(res, 409, { error: "Такой никнейм уже занят." });
          return;
        }
        if (nextEmail && !isValidEmail(nextEmail)) {
          sendJson(res, 400, { error: "Введите корректный email." });
          return;
        }
        const emailOwner = nextEmail ? findAuthUserByEmail(nextEmail) : null;
        if (emailOwner && emailOwner.id !== user.id) {
          sendJson(res, 409, { error: "На эту электронную почту уже зарегистрирован аккаунт." });
          return;
        }
        const oldNickname = user.nickname;
        user.nickname = nextNickname;
        if (nextEmail) user.email = nextEmail;
        user.lastSeenAt = now();
        authState.users.forEach(item => {
          ensureAccountData(item);
          item.friends.forEach(friend => {
            if (friend.userId === user.id) friend.nickname = user.nickname;
          });
          item.friendMessages.forEach(message => {
            if (message.fromUserId === user.id) message.fromName = user.nickname;
            if (message.toUserId === user.id) message.toName = user.nickname;
          });
          item.friendRequests.forEach(request => {
            if (request.fromUserId === user.id) request.fromName = user.nickname;
            if (request.toUserId === user.id) request.toName = user.nickname;
          });
        });
        const adminUser = findAdminUser(oldNickname);
        if (adminUser) {
          adminUser.name = user.nickname;
          adminUser.email = user.email;
        }
        touchAdminUser({ name: user.nickname, email: user.email, rating: user.rating, tier: user.tier, registered: true, ip: clientIp(req), source: "account" });
        saveAuthState();
        saveAdminState();
        sendJson(res, 200, publicAccountProfile(user));
        return;
      }

      if (method === "DELETE" && parts.length === 3 && parts[2] === "profile") {
        authState.users = authState.users.filter(item => item.id !== user.id);
        authState.passwordResets = authState.passwordResets.filter(item => item.userId !== user.id);
        authState.users.forEach(item => {
          ensureAccountData(item);
          item.friends = item.friends.filter(friend => friend.userId !== user.id);
          item.friendRequests = item.friendRequests.filter(request => request.fromUserId !== user.id && request.toUserId !== user.id);
          item.friendMessages = item.friendMessages.filter(message => message.fromUserId !== user.id && message.toUserId !== user.id);
        });
        adminState.users = adminState.users.filter(item => normalizePlayerName(item.name) !== normalizePlayerName(user.nickname));
        saveAuthState();
        saveAdminState();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && parts.length === 3 && parts[2] === "players") {
        const q = normalizePlayerName(url.searchParams.get("q"));
        const players = q
          ? authState.users
              .filter(item => item.id !== user.id && normalizePlayerName(item.nickname).includes(q))
              .slice(0, 8)
              .map(item => ({
                ...accountUserRef(item),
                relationship: friendRelationship(user, item),
              }))
          : [];
        sendJson(res, 200, { players }, { "Cache-Control": "no-store" });
        return;
      }

      if (method === "POST" && parts.length === 3 && parts[2] === "friends") {
        const target = normalizeFriendTarget(body.friend || body.friendNickname || body.friendId || body.target);
        const friendUser = findAccountUser({ userId: target, nickname: target, email: target });
        if (!friendUser) {
          sendJson(res, 404, { error: "Игрок не найден." });
          return;
        }
        const result = createFriendRequest(user, friendUser);
        if (!result.ok) {
          sendJson(res, 400, { error: result.message });
          return;
        }
        user.lastSeenAt = now();
        friendUser.lastSeenAt ||= now();
        saveAuthState();
        sendJson(res, 200, {
          ...publicAccountProfile(user),
          requestStatus: result.status,
          message: result.message,
        });
        return;
      }

      if (method === "POST" && parts.length === 5 && parts[2] === "friend-requests") {
        const requestId = parts[3];
        const action = parts[4];
        const result = action === "accept"
          ? acceptFriendRequest(user, requestId)
          : (action === "decline" ? declineFriendRequest(user, requestId) : null);
        if (!result) {
          sendJson(res, 404, { error: "Неизвестное действие с заявкой." });
          return;
        }
        if (!result.ok) {
          sendJson(res, 400, { error: result.message });
          return;
        }
        user.lastSeenAt = now();
        saveAuthState();
        sendJson(res, 200, {
          ...publicAccountProfile(user),
          requestStatus: result.status,
          message: result.message,
        });
        return;
      }

      if (method === "DELETE" && parts.length === 4 && parts[2] === "friend-requests") {
        const result = cancelFriendRequest(user, parts[3]);
        if (!result.ok) {
          sendJson(res, 400, { error: result.message });
          return;
        }
        user.lastSeenAt = now();
        saveAuthState();
        sendJson(res, 200, {
          ...publicAccountProfile(user),
          requestStatus: result.status,
          message: result.message,
        });
        return;
      }

      if (method === "DELETE" && parts.length === 4 && parts[2] === "friends") {
        const friendUser = findAccountUser({ userId: parts[3], nickname: decodeURIComponent(parts[3]) });
        if (!friendUser) {
          sendJson(res, 404, { error: "Игрок не найден." });
          return;
        }
        removeMutualFriend(user, friendUser);
        user.lastSeenAt = now();
        saveAuthState();
        sendJson(res, 200, publicAccountProfile(user));
        return;
      }

      if (method === "GET" && parts.length === 3 && parts[2] === "messages") {
        const friendUser = findAccountUser({
          userId: url.searchParams.get("friendId"),
          nickname: url.searchParams.get("friend"),
        });
        if (!friendUser) {
          sendJson(res, 404, { error: "Игрок не найден." });
          return;
        }
        ensureAccountData(friendUser);
        const threadId = accountThreadId(user.id, friendUser.id);
        const messages = user.friendMessages
          .filter(message => message.threadId === threadId)
          .sort((a, b) => String(a.at).localeCompare(String(b.at)));
        const readAt = now();
        messages.forEach(message => {
          if (message.toUserId === user.id && !message.readAt) message.readAt = readAt;
        });
        friendUser.friendMessages.forEach(message => {
          if (message.threadId === threadId && message.toUserId === user.id && !message.readAt) message.readAt = readAt;
        });
        saveAuthState();
        sendJson(res, 200, {
          friend: accountUserRef(friendUser),
          messages: messages.map(message => publicFriendMessage(message, user.id)),
        }, { "Cache-Control": "no-store" });
        return;
      }

      if (method === "POST" && parts.length === 3 && parts[2] === "messages") {
        const friendUser = findAccountUser({
          userId: body.friendId,
          nickname: body.friend || body.friendNickname,
        });
        if (!friendUser) {
          sendJson(res, 404, { error: "Игрок не найден." });
          return;
        }
        ensureAccountData(friendUser);
        if (!user.friends.some(friend => friend.userId === friendUser.id)) {
          sendJson(res, 403, { error: "Сначала добавьте игрока в друзья." });
          return;
        }
        const kind = body.kind === "voice" ? "voice" : (body.kind === "emoji" ? "emoji" : "text");
        const text = kind === "voice" ? "Голосовое сообщение" : normalizeChatText(body.text);
        if (!text && kind !== "voice") {
          sendJson(res, 400, { error: "Сообщение не может быть пустым." });
          return;
        }
        const message = {
          id: id("msg"),
          threadId: accountThreadId(user.id, friendUser.id),
          fromUserId: user.id,
          fromName: user.nickname,
          toUserId: friendUser.id,
          toName: friendUser.nickname,
          text,
          kind,
          audioData: kind === "voice" ? String(body.audioData || "") : "",
          mimeType: kind === "voice" ? String(body.mimeType || "").slice(0, 80) : "",
          duration: kind === "voice" ? Math.max(0, Math.min(180000, Number(body.duration || 0))) : 0,
          at: now(),
          readAt: null,
        };
        user.friendMessages.push(message);
        friendUser.friendMessages.push({ ...message });
        user.friendMessages = user.friendMessages.slice(-500);
        friendUser.friendMessages = friendUser.friendMessages.slice(-500);
        user.lastSeenAt = now();
        friendUser.lastSeenAt ||= now();
        saveAuthState();
        sendJson(res, 201, { message: publicFriendMessage(message, user.id) });
        return;
      }
    }

    if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "rooms") {
      const visibleRooms = rooms.filter(room => {
        updatePresenceStatus(room);
        if (room.status === "waiting") return true;
        if (room.status !== "joined") return false;
        return !room.leftPlayers?.white && !room.leftPlayers?.dark;
      });
      sendJson(res, 200, { rooms: visibleRooms.map(room => publicRoom(room)) });
      return;
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "rooms") {
      const body = await readJsonBody(req);
      const access = body.access === "closed" ? "closed" : "open";
      const password = access === "closed" ? String(body.password || "").trim() : "";
      const hostName = String(body.hostName || "Гость").slice(0, 32);
      const hostProfile = registeredRoomProfile({
        name: hostName,
        userId: body.hostUserId,
        ratingEligible: body.hostRatingEligible,
      });
      const hostRegistered = Boolean(hostProfile);
      const hostRating = hostRegistered ? normalizeRating(hostProfile.rating) : null;
      if (access === "closed" && password.length < 4) {
        sendJson(res, 400, { error: "Введите пароль закрытой игры минимум из 4 символов." });
        return;
      }
      if (isAdminUserBanned(hostName)) {
        sendJson(res, 403, { error: "Этот игрок заблокирован администратором." });
        return;
      }
      const activeRoom = rooms.find(room => isRoomActiveForPlayer(room, hostName));
      if (activeRoom) {
        sendJson(res, 409, {
          error: "У вас уже есть активная игровая комната. Сначала завершите или покиньте текущую комнату.",
          room: publicRoom(activeRoom, true),
        });
        return;
      }

      const room = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        code: createRoomCode(),
        hostName,
        hostRating,
        hostTier: hostRegistered ? ratingTierFor(hostRating) : "",
        hostRegistered,
        hostRatingEligible: hostRegistered,
        opponent: "player",
        variant: body.variant === "short" ? "short" : "long",
        access,
        password,
        status: "waiting",
        createdAt: new Date().toISOString(),
        chat: [],
        chatVersion: 0,
      };
      touchAdminUser({ name: hostName, email: hostProfile?.email || "", rating: hostRating, registered: hostRegistered, ratingEligible: hostRegistered, ip: clientIp(req), source: hostRegistered ? "account" : "guest" });
      saveAdminState();
      rooms.unshift(room);
      sendJson(res, 201, { room: publicRoom(room, true) });
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "rooms") {
      const room = rooms.find(item => item.code === parts[2].toUpperCase());
      if (!room) {
        sendJson(res, 404, { error: "Комната не найдена." });
        return;
      }
      updatePresenceStatus(room);
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    if (method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "game") {
      const room = rooms.find(item => item.code === parts[2].toUpperCase());
      if (!room) {
        sendJson(res, 404, { error: "Комната не найдена." });
        return;
      }
      updatePresenceStatus(room);
      sendJson(res, 200, { state: room.gameState || null, version: room.gameVersion || 0 });
      return;
    }

    if (method === "PUT" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "game") {
      const room = rooms.find(item => item.code === parts[2].toUpperCase());
      if (!room) {
        sendJson(res, 404, { error: "Комната не найдена." });
        return;
      }
      const body = await readJsonBody(req);
      if (!body.state || typeof body.state !== "object") {
        sendJson(res, 400, { error: "Некорректное состояние партии." });
        return;
      }
      room.gameState = body.state;
      room.gameVersion = (room.gameVersion || 0) + 1;
      room.gameUpdatedAt = new Date().toISOString();
      if (isFinalGameState(room.gameState)) {
        room.gameState.finishedAt ||= Date.now();
        archiveFinishedRoom(room);
      }
      sendJson(res, 200, { ok: true, version: room.gameVersion });
      return;
    }

    if (method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "chat") {
      const room = rooms.find(item => item.code === parts[2].toUpperCase());
      if (!room) {
        sendJson(res, 404, { error: "Комната не найдена." });
        return;
      }
      const after = Number(url.searchParams.get("after") || 0);
      const messages = (room.chat || [])
        .filter(message => !Number.isFinite(after) || message.id > after)
        .map(publicChatMessage);
      sendJson(res, 200, { messages, version: room.chatVersion || 0 });
      return;
    }

    if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "chat") {
      const room = rooms.find(item => item.code === parts[2].toUpperCase());
      if (!room) {
        sendJson(res, 404, { error: "Комната не найдена." });
        return;
      }
      const body = await readJsonBody(req);
      const kind = body.kind === "emoji" ? "emoji" : (body.kind === "voice" ? "voice" : "text");
      const text = kind === "voice" ? "Голосовое сообщение" : normalizeChatText(body.text);
      const audioData = kind === "voice" ? String(body.audioData || "") : "";
      const mimeType = kind === "voice" ? String(body.mimeType || "").slice(0, 80) : "";
      const duration = kind === "voice" ? Math.max(0, Math.min(180000, Number(body.duration || 0))) : 0;
      if (!text || (kind === "voice" && (!audioData.startsWith("data:audio/") || audioData.length > 1500000))) {
        sendJson(res, 400, { error: "Сообщение не может быть пустым." });
        return;
      }
      room.chatVersion = (room.chatVersion || 0) + 1;
      const message = {
        id: room.chatVersion,
        roomCode: room.code,
        senderId: String(body.senderId || "").slice(0, 80),
        senderName: String(body.senderName || "Игрок").slice(0, 32),
        color: body.color === "dark" ? "dark" : "white",
        text,
        kind,
        audioData,
        mimeType,
        duration,
        at: new Date().toISOString(),
      };
      room.chat ||= [];
      room.chat.push(message);
      if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
      sendJson(res, 201, { message: publicChatMessage(message), version: room.chatVersion });
      return;
    }

    if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "join") {
      const room = rooms.find(item => item.code === parts[2].toUpperCase());
      if (!room) {
        sendJson(res, 404, { error: "Комната с таким кодом не найдена." });
        return;
      }
      const body = await readJsonBody(req);
      const guestName = String(body.guestName || "Соперник").slice(0, 32);
      const guestProfile = registeredRoomProfile({
        name: guestName,
        userId: body.guestUserId,
        ratingEligible: body.guestRatingEligible,
      });
      const guestRegistered = Boolean(guestProfile);
      const guestRating = guestRegistered ? normalizeRating(guestProfile.rating) : null;
      if (room.status !== "waiting") {
        if (isRoomActiveForPlayer(room, guestName)) {
          sendJson(res, 200, { room: publicRoom(room) });
          return;
        }
        sendJson(res, 409, { error: "Эта комната уже занята." });
        return;
      }

      if (room.access === "closed" && room.password !== String(body.password || "").trim()) {
        sendJson(res, 403, { error: "Неверный пароль закрытой комнаты." });
        return;
      }
      if (isAdminUserBanned(guestName)) {
        sendJson(res, 403, { error: "Этот игрок заблокирован администратором." });
        return;
      }

      room.status = "joined";
      room.guestName = guestName;
      room.guestRating = guestRating;
      room.guestTier = guestRegistered ? ratingTierFor(guestRating) : "";
      room.guestRegistered = guestRegistered;
      room.guestRatingEligible = guestRegistered;
      room.joinedAt = new Date().toISOString();
      room.presence = {
        white: null,
        dark: null,
      };
      touchAdminUser({ name: guestName, email: guestProfile?.email || "", rating: guestRating, registered: guestRegistered, ratingEligible: guestRegistered, ip: clientIp(req), source: guestRegistered ? "account" : "guest" });
      saveAdminState();
      sendJson(res, 200, { room: publicRoom(room) });
      return;
    }

    if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "presence") {
      const room = rooms.find(item => item.code === parts[2].toUpperCase());
      if (!room) {
        sendJson(res, 404, { error: "Комната не найдена." });
        return;
      }
      const body = await readJsonBody(req);
      const color = body.color === "dark" ? "dark" : "white";
      touchPresence(room, color, body.name || (color === "white" ? room.hostName : room.guestName));
      updatePresenceStatus(room);
      sendJson(res, 200, {
        ok: true,
        presence: publicPresence(room, color),
        state: room.gameState || null,
        version: room.gameVersion || 0,
      });
      return;
    }

    if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "leave") {
      const code = parts[2].toUpperCase();
      const index = rooms.findIndex(item => item.code === code);
      if (index === -1) {
        sendJson(res, 200, { ok: true, removed: true });
        return;
      }
      const room = rooms[index];
      const body = await readJsonBody(req);
      const color = body.color === "dark" ? "dark" : "white";
      room.leftPlayers ||= {};
      room.leftPlayers[color] = true;
      room.lastLeftAt = new Date().toISOString();
      room.lastLeftBy = String(body.name || "").slice(0, 32);

      if (room.status === "waiting" || (room.leftPlayers.white && room.leftPlayers.dark)) {
        archiveFinishedRoom(room);
        rooms.splice(index, 1);
        sendJson(res, 200, { ok: true, removed: true });
        return;
      }

      sendJson(res, 200, { ok: true, removed: false, room: publicRoom(room) });
      return;
    }

    if (method === "DELETE" && parts.length === 3 && parts[0] === "api" && parts[1] === "rooms") {
      const code = parts[2].toUpperCase();
      const index = rooms.findIndex(item => item.code === code);
      if (index === -1) {
        sendJson(res, 200, { ok: true });
        return;
      }
      archiveFinishedRoom(rooms[index]);
      rooms.splice(index, 1);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, err.message === "Invalid JSON" ? 400 : 500, { error: err.message || "Server error" });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }

  if (!["GET", "HEAD"].includes(req.method)) {
    send(res, 405, "Method not allowed");
    return;
  }

  const filePath = resolveRequestPath(req.url);
  const relativePath = path.relative(ROOT, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      send(res, err.code === "ENOENT" ? 404 : 500, err.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });

    res.end(req.method === "HEAD" ? undefined : content);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Nardy portal is running at http://${HOST}:${PORT}`);
});
