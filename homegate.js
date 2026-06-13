const app = document.querySelector("#admin-app");
const THEME_KEY = "narduh-theme";
const LANG_KEY = "narduh-lang";
const WATCH_KEY = "narduh_admin_watch";
const TAB_KEY = "narduh_admin_tab";

const state = {
  admin: null,
  backend: "server",
  readonlyAdmin: false,
  configured: true,
  retentionHours: 60,
  adminTab: localStorage.getItem(TAB_KEY) || "rooms",
  adminPasswordOpen: false,
  active: [],
  archive: [],
  users: [],
  usersError: "",
  audit: [],
  detail: null,
  detailKey: "",
  watch: JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"),
  notice: "",
  theme: localStorage.getItem(THEME_KEY) || "night",
  lang: localStorage.getItem(LANG_KEY) || "ru",
};

const adminDict = {
  ru: {
    title: "Админ · Нарды Онлайн",
    day: "День",
    night: "Ночь",
    admin_panel: "Админ-панель",
    monitoring: "Мониторинг комнат",
    players: "Игроки",
    rooms: "Комнаты",
    change_password: "Сменить пароль",
    refresh: "Обновить",
    logout: "Выйти",
    login_eyebrow: "Администрирование",
    login_title: "Вход в панель",
    login_supabase_desc: "Войдите Supabase-аккаунтом администратора, чтобы открыть мониторинг комнат и управление игроками.",
    login_server_desc: "Введите пароль администратора, чтобы открыть мониторинг комнат и управление игроками.",
    admin_email: "Email администратора",
    password: "Пароль",
    sign_in: "Войти",
    room_monitor: "Экран монитора",
    room_detail: "Просмотр комнаты",
    active_rooms: "Активные комнаты",
    archive: "Архив",
    no_watched_rooms: "Выберите комнаты кнопкой “На монитор”.",
    no_active_rooms: "Активных комнат нет.",
    no_archive: "Архив пока пуст.",
    players_seen: "Игроки, замеченные сервером",
    nickname: "Никнейм",
    first_login: "Первый вход",
    games_played: "Сыгранные партии",
    wins: "Победы",
    rating: "Рейтинг",
    status: "Статус",
    actions: "Действия",
    online: "В сети",
    offline: "Не в сети",
    readonly: "только просмотр",
    unavailable_actions: "Действия недоступны",
    set_password: "Сменить",
    ban: "Забанить",
    unban: "Разбанить",
    delete: "Удалить",
    open: "Открыть",
    watch: "На монитор",
    unwatch: "Убрать",
  },
  en: {
    title: "Admin · Online Backgammon",
    day: "Day",
    night: "Night",
    admin_panel: "Admin panel",
    monitoring: "Room monitoring",
    players: "Players",
    rooms: "Rooms",
    change_password: "Change password",
    refresh: "Refresh",
    logout: "Log out",
    login_eyebrow: "Administration",
    login_title: "Panel login",
    login_supabase_desc: "Sign in with the Supabase admin account to monitor rooms and manage players.",
    login_server_desc: "Enter the admin password to monitor rooms and manage players.",
    admin_email: "Admin email",
    password: "Password",
    sign_in: "Sign in",
    room_monitor: "Monitor screen",
    room_detail: "Room preview",
    active_rooms: "Active rooms",
    archive: "Archive",
    no_watched_rooms: "Choose rooms with the “Monitor” button.",
    no_active_rooms: "No active rooms.",
    no_archive: "Archive is empty.",
    players_seen: "Players seen by the server",
    nickname: "Nickname",
    first_login: "First login",
    games_played: "Games played",
    wins: "Wins",
    rating: "Rating",
    status: "Status",
    actions: "Actions",
    online: "Online",
    offline: "Offline",
    readonly: "view only",
    unavailable_actions: "Actions unavailable",
    set_password: "Change",
    ban: "Ban",
    unban: "Unban",
    delete: "Delete",
    open: "Open",
    watch: "Monitor",
    unwatch: "Remove",
  },
};

function t(key) {
  return adminDict[state.lang]?.[key] || adminDict.ru[key] || key;
}

function applyAdminTheme(theme) {
  const nextTheme = theme === "day" ? "day" : "night";
  state.theme = nextTheme;
  document.documentElement.setAttribute("data-theme", nextTheme);
  localStorage.setItem(THEME_KEY, nextTheme);
}

function applyAdminLang(lang) {
  const nextLang = lang === "en" ? "en" : "ru";
  state.lang = nextLang;
  document.documentElement.lang = nextLang;
  document.title = t("title");
  localStorage.setItem(LANG_KEY, nextLang);
}

applyAdminTheme(state.theme);
applyAdminLang(state.lang);

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Ошибка админ-панели.");
  return data;
}

function supabaseAdminMode() {
  return Boolean(window.NarduSupabase?.configured?.());
}

function adminEmails() {
  const raw = window.NarduSupabase?.config?.().adminEmails || window.NARDU_ENV?.adminEmails || "";
  return new Set(String(raw).split(",").map(item => item.trim().toLowerCase()).filter(Boolean));
}

function adminEmailsText() {
  return [...adminEmails()].join(", ");
}

function isAllowedSupabaseAdmin(user) {
  const allowed = adminEmails();
  return Boolean(user?.email && allowed.has(String(user.email).toLowerCase()));
}

function isAllowedSupabaseAdminEmail(email) {
  return adminEmails().has(String(email || "").trim().toLowerCase());
}

function supabaseAdminActionsEnabled() {
  return state.backend === "supabase" && Boolean(state.admin?.email || state.admin?.login);
}

function isInvalidSupabaseCredentials(error) {
  return /invalid login credentials/i.test(String(error?.message || ""));
}

function adminAuthErrorMessage(error) {
  const message = String(error?.message || error || "");
  if (isInvalidSupabaseCredentials(error)) {
    return "Неверный пароль или такой Auth-пользователь ещё не создан в Supabase. Пароль от dashboard.supabase.com здесь не подходит.";
  }
  if (/email not confirmed/i.test(message)) {
    return "Email администратора ещё не подтверждён в Supabase Auth. Подтвердите письмо или временно отключите Confirm email.";
  }
  if (/email rate limit exceeded/i.test(message)) {
    return "Supabase временно ограничил отправку писем. Для теста отключите Confirm email или подключите SMTP.";
  }
  return message || "Ошибка входа в админ-панель.";
}

async function supabaseClient() {
  if (!window.NarduSupabase?.client) throw new Error("Supabase не подключён.");
  return window.NarduSupabase.client();
}

function setSupabaseAdmin(user) {
  state.admin = { login: user.email, email: user.email, id: user.id };
  state.backend = "supabase";
  state.readonlyAdmin = true;
  state.configured = true;
  state.retentionHours = 0;
}

async function signInOrCreateSupabaseAdmin(client, email, password) {
  const normalizedEmail = String(email || "").trim();
  if (!isAllowedSupabaseAdminEmail(normalizedEmail)) {
    throw new Error("Этот email не входит в список администраторов.");
  }

  const { data, error } = await client.auth.signInWithPassword({ email: normalizedEmail, password });
  if (!error) return data.user;
  if (!isInvalidSupabaseCredentials(error)) throw new Error(adminAuthErrorMessage(error));

  const { data: signUpData, error: signUpError } = await client.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: { nickname: normalizedEmail.split("@")[0], name: normalizedEmail.split("@")[0], admin: true },
      emailRedirectTo: window.NarduSupabase?.config?.().siteBaseUrl
        ? `${window.NarduSupabase.config().siteBaseUrl.replace(/\/+$/, "")}/homegate.html`
        : new URL("homegate.html", location.href).href,
    },
  });
  if (signUpError) throw new Error(adminAuthErrorMessage(signUpError));
  if (signUpData.session?.user) return signUpData.session.user;
  throw new Error("Auth-пользователь администратора создан. Подтвердите email или отключите Confirm email в Supabase, затем войдите этим же паролем.");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function passwordToggleHtml() {
  return `
    <button class="password-toggle" type="button" data-action="toggle-password" aria-label="Показать пароль" aria-pressed="false" title="Показать пароль">
      <span class="password-toggle-eye" aria-hidden="true"></span>
    </button>`;
}

function adminPreferenceControls() {
  return `
    <div class="admin-prefs" aria-label="Настройки интерфейса">
      <div class="theme-switch admin-pref-switch" role="tablist" aria-label="Тема">
        <button type="button" data-admin-theme="day" class="${state.theme === "day" ? "active" : ""}">${t("day")}</button>
        <button type="button" data-admin-theme="night" class="${state.theme === "night" ? "active" : ""}">${t("night")}</button>
      </div>
      <div class="theme-switch lang-switch admin-pref-switch" role="tablist" aria-label="Language">
        <button type="button" data-admin-lang="ru" class="${state.lang === "ru" ? "active" : ""}">RU</button>
        <button type="button" data-admin-lang="en" class="${state.lang === "en" ? "active" : ""}">EN</button>
      </div>
    </div>`;
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function fmtTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

function fmtDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function roomKey(room) {
  return `${room.source}:${room.source === "archive" ? room.archiveId : room.id}`;
}

function allRooms() {
  return [...state.active, ...state.archive];
}

function archiveRetentionText() {
  if (state.backend === "supabase") return "Supabase";
  return `${state.retentionHours} часов`;
}

function roomByKey(key) {
  return allRooms().find(room => roomKey(room) === key) || null;
}

function saveWatch() {
  state.watch = state.watch.filter((key, index, list) => list.indexOf(key) === index);
  localStorage.setItem(WATCH_KEY, JSON.stringify(state.watch));
}

function clearRoomDetail() {
  state.detail = null;
  state.detailKey = "";
}

function statusLabel(status) {
  return {
    waiting: "Ожидает",
    joined: "Игра",
    playing: "Игра",
    paused: "Пауза",
    finished: "Завершена",
    abandoned: "Покинута",
    closed: "Закрыта",
    over: "Завершена",
  }[status] || status || "-";
}

function variantLabel(variant) {
  return variant === "short" ? "Короткие нарды" : "Длинные нарды";
}

function variantBadgeHtml(room) {
  const variant = room?.variant === "short" ? "short" : "long";
  return `<span class="variant-badge ${variant}">${variantLabel(variant)}</span>`;
}

function colorLabel(color) {
  if (color === "white") return "белые";
  if (color === "dark") return "тёмные";
  return color || "";
}

function playerLine(room) {
  const players = room.players || [];
  return players.map(player => `${player.name} (${colorLabel(player.color)})`).join(" · ") || "Нет игроков";
}

function borneOffText(room) {
  const off = room.borneOff || {};
  return `${off.white || 0}/${off.dark || 0}`;
}

function doubleText(room) {
  const rate = room.rolls ? `${Math.round(room.doubleRate * 1000) / 10}%` : "0%";
  return `${room.doubles || 0}/${room.rolls || 0} (${rate})`;
}

function winnerText(summary) {
  if (!summary?.winner) return "-";
  return summary.winnerName ? `${summary.winnerName} (${colorLabel(summary.winner)})` : colorLabel(summary.winner);
}

function isRecentActivity(value, maxAgeMs = 3 * 60 * 1000) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time <= maxAgeMs;
}

function userStatusText(user) {
  return user.online ? t("online") : t("offline");
}

function userStatusClass(user) {
  return user.online ? "online" : "offline";
}

function passwordStateText(user) {
  if (user.passwordState === "supabase") return "Supabase Auth";
  if (user.passwordState === "set") return "Задан админом";
  if (user.passwordState === "client") return "Локальный профиль";
  return "Нет пароля";
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

function supabasePlayersForRoom(room) {
  const players = [];
  if (room.host_name) {
    players.push({
      id: room.host_user_id || `host:${room.id}`,
      name: room.host_name,
      color: "white",
      rating: room.host_registered ? room.host_rating : null,
      ratingEligible: Boolean(room.host_registered),
    });
  }
  if (room.guest_name) {
    players.push({
      id: room.guest_user_id || `guest:${room.id}`,
      name: room.guest_name,
      color: "dark",
      rating: room.guest_registered ? room.guest_rating : null,
      ratingEligible: Boolean(room.guest_registered),
    });
  }
  return players;
}

function latestSupabaseRoomEventAt(room) {
  const game = room.game_state || {};
  const dates = [
    room.updated_at,
    room.joined_at,
    room.archived_at,
    room.created_at,
    game.finishedAt,
    game.history?.[0]?.at,
  ].filter(Boolean);
  return dates.sort().at(-1) || room.updated_at || room.created_at;
}

function supabaseRoomSummary(room) {
  const game = room.game_state || {};
  const players = supabasePlayersForRoom(room);
  const stats = rollStats(game);
  const winnerColor = game.winner || null;
  const winnerPlayer = winnerColor ? players.find(player => player.color === winnerColor) : null;
  return {
    id: room.id,
    archiveId: null,
    source: "active",
    code: room.code,
    name: `${room.host_name || "Хост"}${room.guest_name ? ` vs ${room.guest_name}` : ""}`,
    variant: room.variant,
    status: game.phase === "over" || game.winner ? "over" : room.status,
    privacy: room.access === "closed" ? "password" : "open",
    players,
    createdAt: room.created_at,
    updatedAt: latestSupabaseRoomEventAt(room),
    archivedAt: room.archived_at || null,
    adminCloseReason: room.closed_reason || null,
    winner: winnerColor,
    winnerName: winnerPlayer?.name || null,
    winnerPlayer: winnerPlayer || null,
    resultType: game.resultType || null,
    borneOff: game.borneOff || game.off || { white: 0, dark: 0 },
    historyCount: game.history?.length || 0,
    chatCount: game.chat?.length || 0,
    ...stats,
  };
}

function supabaseRoomDetail(room) {
  const summary = supabaseRoomSummary(room);
  const game = { ...(room.game_state || {}) };
  game.history = Array.isArray(game.history) ? game.history : [];
  game.chat = Array.isArray(game.chat) ? game.chat : [];
  game.off ||= { white: 0, dark: 0 };
  game.borneOff = game.borneOff || game.off;
  return {
    summary,
    session: {
      id: room.id,
      code: room.code,
      name: summary.name,
      variant: room.variant,
      status: summary.status,
      privacy: summary.privacy,
      players: summary.players,
      createdAt: room.created_at,
      updatedAt: summary.updatedAt,
      joinedAt: room.joined_at || null,
      closedByAdmin: null,
      game,
    },
  };
}

function banHistoryText(item) {
  const action = item.action === "unban" ? "Разбан" : "Бан";
  const by = item.by ? ` · ${escapeHtml(item.by)}` : "";
  const reason = item.reason ? `<span class="ban-reason-text">${escapeHtml(item.reason)}</span>` : "";
  return `
    <li>
      <span>${action}${by} · ${fmtTime(item.at)}</span>
      ${reason}
    </li>`;
}

function banPopoverHtml(user) {
  const history = Array.isArray(user.banHistory) ? [...user.banHistory].reverse() : [];
  const currentReason = user.banReason ? `<p>${escapeHtml(user.banReason)}</p>` : "";
  const historyHtml = history.length
    ? `<ul>${history.map(banHistoryText).join("")}</ul>`
    : `<p class="ban-empty">${user.banReason ? "История появится после следующего изменения статуса." : "Истории бана нет."}</p>`;
  return `
    <span class="ban-popover" role="tooltip">
      <strong>Причина бана</strong>
      ${currentReason}
      ${historyHtml}
    </span>`;
}

function roomCard(room) {
  const key = roomKey(room);
  const selected = state.watch.includes(key);
  const canClose = room.source === "active" && !state.readonlyAdmin;
  return `
    <article class="room-card ${selected ? "selected" : ""}">
      <div class="room-head">
        <span class="room-code-admin">${escapeHtml(room.code)}</span>
        <span class="room-head-badges">${variantBadgeHtml(room)}<span class="room-status">${statusLabel(room.status)}</span></span>
      </div>
      <div class="room-meta-grid">
        <span>Источник</span>
        <span>${room.source === "archive" ? "Архив" : "Активная"}</span>
        <span>Игроки</span>
        <span>${escapeHtml(playerLine(room))}</span>
        <span>Снято</span>
        <span>${borneOffText(room)}</span>
        <span>Дубли</span>
        <span>${doubleText(room)}</span>
        <span>Обновлена</span>
        <span>${fmtTime(room.updatedAt || room.archivedAt)}</span>
      </div>
      ${room.adminCloseReason ? `<p class="room-close-reason">Причина закрытия: ${escapeHtml(room.adminCloseReason)}</p>` : ""}
      <div class="room-actions">
        <button class="btn ghost small" data-open="${escapeHtml(key)}">${t("open")}</button>
        <button class="btn ghost small" data-watch="${escapeHtml(key)}">${selected ? t("unwatch") : t("watch")}</button>
        ${canClose ? `<button class="btn ghost danger small" data-admin-close="${escapeHtml(key)}">Закрыть</button>` : ""}
      </div>
    </article>`;
}

function monitorCard(key) {
  const room = roomByKey(key);
  if (!room) {
    return `
      <article class="room-card monitor-card">
        <div class="room-head"><span class="room-code-admin">Недоступна</span></div>
        <p class="admin-empty">Комната исчезла из активного списка и архива.</p>
        <button class="btn ghost small" data-watch="${escapeHtml(key)}">${t("unwatch")}</button>
      </article>`;
  }
  const canClose = room.source === "active" && !state.readonlyAdmin;
  return `
    <article class="room-card monitor-card selected">
      <div class="room-head">
        <span class="room-code-admin">${escapeHtml(room.code)}</span>
        <span class="room-head-badges">${variantBadgeHtml(room)}<span class="room-status">${statusLabel(room.status)}</span></span>
      </div>
      <div class="room-meta-grid">
        <span>Игроки</span>
        <span>${escapeHtml(playerLine(room))}</span>
        <span>Последний бросок</span>
        <span>${room.lastRoll ? `${room.lastRoll.roll} · ${colorLabel(room.lastRoll.color)}` : "-"}</span>
        <span>Дубли</span>
        <span>${doubleText(room)}</span>
        <span>Снято</span>
        <span class="monitor-number">${borneOffText(room)}</span>
      </div>
      <div class="room-actions">
        <button class="btn ghost small" data-open="${escapeHtml(key)}">${t("open")}</button>
        <button class="btn ghost small" data-watch="${escapeHtml(key)}">${t("unwatch")}</button>
        ${canClose ? `<button class="btn ghost danger small" data-admin-close="${escapeHtml(key)}">Закрыть</button>` : ""}
      </div>
    </article>`;
}

function shortHash(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 10)}...${text.slice(-6)}` : "";
}

function historyText(item) {
  if (item.adminClosed) return `Комната закрыта админом: ${item.reason || "-"}`;
  if (item.networkLoss) return `Потеря связи: ${colorLabel(item.color)}`;
  if (item.resign) return `${colorLabel(item.color)} сдались`;
  if (item.leave) return `${colorLabel(item.color)} покинули игру`;
  if (item.opening) return `Стартовый бросок`;
  if (item.openingMove) return `${colorLabel(item.color)}: первый ход ${item.roll}`;
  if (item.roll) return `${colorLabel(item.color)}: бросок ${item.roll}`;
  if (item.pass) return `${colorLabel(item.color)}: нет доступного хода`;
  return `${colorLabel(item.color)}: ${item.from} -> ${item.to}${item.die ? ` · кубик ${item.die}` : ""}`;
}

function historyCopyText(item, index) {
  const lines = [`#${index} ${historyText(item)}`, `Время: ${item.at || "-"}`];
  if (item.sha256) lines.push(`SHA-256: ${item.sha256}`);
  if (item.rerolls) lines.push(`Перебросов: ${item.rerolls}`);
  return lines.join("\n");
}

function historyAdminItem(item, index) {
  const hash = item.sha256 || item.proof?.commit || "";
  const proof = hash ? `
    <div class="history-proof">
      <span>SHA-256</span>
      <code title="${escapeHtml(hash)}">${escapeHtml(shortHash(hash))}</code>
      <button class="mini-copy hash-copy" type="button" data-copy-hash="${escapeHtml(hash)}" title="Скопировать полный SHA-256">Скопировать хэш</button>
    </div>` : "";
  return `
    <li class="history-row">
      <div class="history-num">${index}</div>
      <div class="history-main">
        <div class="history-line">${escapeHtml(historyText(item))}</div>
        <div class="history-time">${fmtTime(item.at)}</div>
        ${proof}
      </div>
      <button class="mini-copy" type="button" data-copy="${escapeHtml(historyCopyText(item, index))}">Строку</button>
    </li>`;
}

function historyListHtml(history) {
  const chronological = [...(history || [])].reverse();
  return chronological.map((item, index) => historyAdminItem(item, index + 1)).join("") || `<li class="history-row empty">Истории пока нет.</li>`;
}

function gameProtocolText(detail = state.detail) {
  if (!detail) return "";
  const { summary, session } = detail;
  const game = session.game || {};
  const lines = [
    `Партия ${summary.code}`,
    `Комната: ${summary.name || "-"}`,
    `Тип: ${variantLabel(summary.variant)}`,
    `Статус: ${statusLabel(summary.status)}`,
    `Игроки: ${playerLine(summary)}`,
    `Создана: ${summary.createdAt || "-"}`,
    `Обновлена: ${summary.updatedAt || "-"}`,
    `Победитель: ${winnerText(summary)}`,
    `Снято: белые ${summary.borneOff?.white || 0}, тёмные ${summary.borneOff?.dark || 0}`,
    `Броски: ${summary.rolls || 0}`,
    `Дубли: ${doubleText(summary)}`,
    "",
    "ХОД ПАРТИИ",
  ];
  [...(game.history || [])].reverse().forEach((item, index) => {
    lines.push(historyCopyText(item, index + 1));
    lines.push("");
  });
  lines.push("ЧАТ");
  if (game.chat?.length) {
    [...game.chat].reverse().forEach((item, index) => {
      lines.push(`#${index + 1} ${item.author || "Игрок"} · ${item.at || "-"}`);
      lines.push(String(item.text || ""));
      lines.push("");
    });
  } else {
    lines.push("Сообщений нет.");
  }
  return lines.join("\n").trim();
}

function scrollSnapshot() {
  return {
    history: document.querySelector(".history-admin")?.scrollTop ?? null,
    chat: document.querySelector(".chat-admin")?.scrollTop ?? null,
  };
}

function restoreScrollSnapshot(snapshot) {
  if (!snapshot) return;
  window.setTimeout(() => {
    const history = document.querySelector(".history-admin");
    const chat = document.querySelector(".chat-admin");
    if (history && snapshot.history !== null) history.scrollTop = snapshot.history;
    if (chat && snapshot.chat !== null) chat.scrollTop = snapshot.chat;
  }, 0);
}

function detailHtml() {
  if (!state.detail) return `<p class="admin-empty">Откройте комнату, чтобы увидеть историю, чат и состояние партии.</p>`;
  const { summary, session } = state.detail;
  const game = session.game || {};
  const detailKey = roomKey(summary);
  return `
    <div class="detail-room">
      <div class="detail-section">
        <div class="detail-row"><span>Комната</span><strong>${escapeHtml(summary.code)}</strong></div>
        <div class="detail-row"><span>Вид нард</span><strong>${variantBadgeHtml(summary)}</strong></div>
        <div class="detail-row"><span>Статус</span><strong>${statusLabel(summary.status)}</strong></div>
        <div class="detail-row"><span>Игроки</span><strong>${escapeHtml(playerLine(summary))}</strong></div>
        <div class="detail-row"><span>Дубли</span><strong>${doubleText(summary)}</strong></div>
        <div class="detail-row"><span>Снято</span><strong>${borneOffText(summary)}</strong></div>
        <div class="detail-row"><span>Победитель</span><strong>${escapeHtml(winnerText(summary))}</strong></div>
        ${summary.adminCloseReason ? `<div class="detail-row"><span>Причина закрытия</span><strong>${escapeHtml(summary.adminCloseReason)}</strong></div>` : ""}
        ${summary.source === "active" && !state.readonlyAdmin ? `<button class="btn ghost danger small detail-close" type="button" data-admin-close="${escapeHtml(detailKey)}">Закрыть комнату</button>` : ""}
      </div>
      <div class="detail-section">
        <div class="detail-section-head">
          <h3>Ход партии</h3>
          <button class="btn ghost small" type="button" data-action="copy-game">Скопировать партию</button>
        </div>
        <ul class="history-admin">${historyListHtml(game.history)}</ul>
      </div>
      <div class="detail-section">
        <h3>Чат</h3>
        <ul class="chat-admin">${(game.chat || []).slice(0, 50).map(item => `<li>${escapeHtml(item.author || "Игрок")} · ${fmtTime(item.at)}<br>${escapeHtml(item.text)}</li>`).join("") || "<li>Сообщений пока нет.</li>"}</ul>
      </div>
    </div>`;
}

function loginView() {
  const supabaseMode = state.backend === "supabase" || supabaseAdminMode();
  const description = supabaseMode
    ? t("login_supabase_desc")
    : t("login_server_desc");
  const allowedEmails = adminEmailsText();
  const supabaseHelp = allowedEmails
    ? `Email администратора: ${allowedEmails}. Введите пароль игрового Auth-пользователя проекта; пароль от dashboard.supabase.com здесь не подходит.`
    : "Email администратора задаётся в runtime-config.js. Нужен пароль Auth-пользователя проекта, а не пароль от dashboard.supabase.com.";
  const fields = supabaseMode
    ? `
          <div class="field"><label>${t("admin_email")}</label><input name="email" type="email" autocomplete="username" value="${escapeHtml(allowedEmails.split(",")[0] || "")}" autofocus /></div>
          <div class="field"><label>${t("password")}</label><div class="password-field"><input name="password" type="password" autocomplete="current-password" />${passwordToggleHtml()}</div></div>`
    : `
          <input name="login" type="hidden" value="admin" />
          <div class="field"><label>${t("password")}</label><div class="password-field"><input name="password" type="password" autocomplete="current-password" autofocus />${passwordToggleHtml()}</div></div>`;
  return `
    <div class="admin-shell">
      <section class="admin-panel admin-login">
        <div class="admin-login-top">
          <div class="eyebrow">${t("login_eyebrow")}</div>
          ${adminPreferenceControls()}
        </div>
        <h1>${t("login_title")}</h1>
        <p>${description}</p>
        ${supabaseMode ? `<p class="admin-hint">${escapeHtml(supabaseHelp)}</p>` : ""}
        ${supabaseMode ? `<p class="admin-warning">GitHub Pages работает через Supabase: комнаты доступны для просмотра, действия с игроками выполняются защищёнными RPC-функциями.</p>` : ""}
        ${state.configured ? "" : `<p class="admin-warning">На сервере не задан админ-пароль.</p>`}
        <form data-form="admin-login">
          ${fields}
          <button class="btn full">${t("sign_in")}</button>
        </form>
        ${state.notice ? `<p class="notice">${escapeHtml(state.notice)}</p>` : ""}
      </section>
    </div>`;
}

function adminTabsHtml() {
  return `
    <nav class="admin-tabs" aria-label="Разделы админ-панели">
      <button class="${state.adminTab === "rooms" ? "active" : ""}" type="button" data-admin-tab="rooms">${t("rooms")}</button>
      <button class="${state.adminTab === "players" ? "active" : ""}" type="button" data-admin-tab="players">${t("players")}</button>
    </nav>`;
}

function adminPasswordPanelHtml() {
  if (state.readonlyAdmin) return "";
  if (!state.adminPasswordOpen) return "";
  return `
    <section class="admin-panel admin-password-panel">
      <div class="detail-section-head">
        <h2>Смена пароля администратора</h2>
        <button class="btn ghost small" type="button" data-action="toggle-admin-password">Закрыть</button>
      </div>
      <form class="admin-password-form" data-form="admin-password">
        <div class="field">
          <label>Текущий пароль</label>
          <div class="password-field"><input name="currentPassword" type="password" required autocomplete="current-password" />${passwordToggleHtml()}</div>
        </div>
        <div class="field">
          <label>Новый пароль</label>
          <div class="password-field"><input name="newPassword" type="password" required minlength="4" autocomplete="new-password" />${passwordToggleHtml()}</div>
        </div>
        <div class="field">
          <label>Повторите новый пароль</label>
          <div class="password-field"><input name="repeatPassword" type="password" required minlength="4" autocomplete="new-password" />${passwordToggleHtml()}</div>
        </div>
        <button class="btn small" type="submit">Сохранить пароль</button>
      </form>
    </section>`;
}

function roomsDashboardHtml() {
  const watched = state.watch.map(monitorCard).join("") || `<p class="admin-empty">${t("no_watched_rooms")}</p>`;
  const archiveEmpty = state.backend === "supabase"
    ? "Архив закрытых комнат на GitHub Pages недоступен без server-side admin function."
    : t("no_archive");
  return `
    <section class="admin-grid">
      <div class="admin-column">
        <div class="admin-panel">
          <h2>${t("active_rooms")}</h2>
          <div class="room-list">${state.active.map(roomCard).join("") || `<p class="admin-empty">${t("no_active_rooms")}</p>`}</div>
        </div>
        <div class="admin-panel">
          <h2>${t("archive")} ${archiveRetentionText()}</h2>
          <div class="room-list">${state.archive.map(roomCard).join("") || `<p class="admin-empty">${archiveEmpty}</p>`}</div>
        </div>
      </div>
      <div class="admin-column">
        <div class="admin-panel">
          <h2>${t("room_monitor")}</h2>
          <div class="monitor-grid">${watched}</div>
        </div>
        <div class="admin-panel">
          <h2>${t("room_detail")}</h2>
          ${detailHtml()}
        </div>
      </div>
    </section>`;
}

function playerRow(user) {
  const statusClass = userStatusClass(user);
  const canManageSupabaseUser = supabaseAdminActionsEnabled();
  const canManageServerUser = !state.readonlyAdmin;
  const canManageUser = canManageServerUser || canManageSupabaseUser;
  const passwordAction = canManageUser
    ? `<button class="mini-copy" type="button" data-user-password="${escapeHtml(user.id)}">${t("set_password")}</button>`
    : `<span class="readonly-note">${t("readonly")}</span>`;
  const userActions = canManageUser
    ? `${user.banned
        ? `<button class="btn ghost small" type="button" data-user-unban="${escapeHtml(user.id)}">${t("unban")}</button>`
        : `<button class="btn ghost danger small" type="button" data-user-ban="${escapeHtml(user.id)}">${t("ban")}</button>`}
        <button class="btn ghost danger small" type="button" data-user-delete="${escapeHtml(user.id)}">${t("delete")}</button>`
    : `<span class="readonly-note">${t("unavailable_actions")}</span>`;
  return `
    <div class="player-row">
      <div class="player-main">
        <strong>${escapeHtml(user.name)}</strong>
        <span class="player-id">${escapeHtml(user.id)}</span>
      </div>
      <div>${escapeHtml(user.email || "—")}</div>
      <div>${escapeHtml(user.ip || "-")}</div>
      <div class="password-cell">
        <span>${passwordStateText(user)}</span>
        ${passwordAction}
      </div>
      <div>${fmtDate(user.createdAt)}</div>
      <div class="metric-number">${user.gamesPlayed || 0}</div>
      <div class="metric-number">${user.gamesWon || 0}</div>
      <div class="metric-number">${user.rating ?? "-"}</div>
      <div class="status-cell">
        <span class="state-pill ${statusClass}" tabindex="0">${userStatusText(user)}</span>
        ${banPopoverHtml(user)}
      </div>
      <div class="player-actions">
        ${userActions}
      </div>
    </div>`;
}

function playersDashboardHtml() {
  return `
    <section class="admin-panel players-panel">
      <div class="detail-section-head">
        <h2>${t("players_seen")}</h2>
        <span class="admin-count">${state.users.length}</span>
      </div>
      <div class="players-table-wrap">
        <div class="players-table">
          <div class="player-row players-head">
            <div>${t("nickname")}</div>
            <div>Email</div>
            <div>IP</div>
            <div>${t("password")}</div>
            <div>${t("first_login")}</div>
            <div>${t("games_played")}</div>
            <div>${t("wins")}</div>
            <div>${t("rating")}</div>
            <div>${t("status")}</div>
            <div>${t("actions")}</div>
          </div>
          ${state.usersError ? `<p class="admin-empty">Список игроков недоступен: ${escapeHtml(state.usersError)}.</p>` : state.users.map(playerRow).join("") || `<p class="admin-empty">Игроков пока нет.</p>`}
        </div>
      </div>
    </section>`;
}

function dashboardView() {
  const adminModeLabel = state.readonlyAdmin ? "GitHub Pages · Supabase мониторинг" : `архив ${archiveRetentionText()}`;
  return `
    <div class="admin-shell">
      <header class="admin-top">
        <div>
          <div class="eyebrow">${t("admin_panel")} · ${adminModeLabel}</div>
          <h1>${state.adminTab === "players" ? t("players") : t("monitoring")}</h1>
        </div>
        <div class="admin-actions">
          ${adminPreferenceControls()}
          ${state.readonlyAdmin ? "" : `<button class="btn ghost small" data-action="toggle-admin-password">${t("change_password")}</button>`}
          <button class="btn ghost small" data-action="refresh">${t("refresh")}</button>
          <button class="btn ghost small" data-action="logout">${t("logout")}</button>
        </div>
      </header>
      ${adminTabsHtml()}
      ${adminPasswordPanelHtml()}
      ${state.notice ? `<p class="notice">${escapeHtml(state.notice)}</p>` : ""}
      ${state.adminTab === "players" ? playersDashboardHtml() : roomsDashboardHtml()}
    </div>`;
}

function render() {
  app.innerHTML = state.admin ? dashboardView() : loginView();
}

function renderPreservingScroll() {
  const snapshot = scrollSnapshot();
  render();
  restoreScrollSnapshot(snapshot);
}

async function loadMe() {
  if (supabaseAdminMode()) {
    state.backend = "supabase";
    state.readonlyAdmin = true;
    state.configured = true;
    try {
      const client = await supabaseClient();
      const { data, error } = await client.auth.getUser();
      if (error && !/session missing/i.test(error.message || "")) throw error;
      if (data.user && isAllowedSupabaseAdmin(data.user)) {
        setSupabaseAdmin(data.user);
        await refresh();
        return;
      }
      if (data.user) await client.auth.signOut();
      state.admin = null;
      render();
      return;
    } catch (error) {
      state.notice = error.message;
      render();
      return;
    }
  }
  const data = await api("/api/admin/me");
  state.admin = data.admin;
  state.configured = data.configured;
  state.retentionHours = data.retentionHours || 60;
  if (state.admin) await refresh();
  else render();
}

async function refresh() {
  const snapshot = scrollSnapshot();
  if (state.backend === "supabase") {
    const client = await supabaseClient();
    const { data: rooms, error: roomsError } = await client
      .from("rooms")
      .select("id,code,variant,access,status,host_user_id,guest_user_id,host_name,guest_name,host_rating,guest_rating,host_registered,guest_registered,game_state,game_version,presence,left_players,created_at,joined_at,updated_at,archived_at,closed_reason")
      .neq("status", "closed")
      .order("updated_at", { ascending: false });
    if (roomsError) throw roomsError;
    state.active = (rooms || []).map(supabaseRoomSummary);
    state.archive = [];
    state.audit = [];
    state.retentionHours = 0;
    try {
      const { data: users, error: usersError } = await client
        .from("profiles")
        .select("id,nickname,email,rating,tier,rating_eligible,banned_at,banned_reason,created_at,last_seen_at,updated_at")
        .order("updated_at", { ascending: false });
      if (usersError) throw usersError;
      const activeRoomCounts = new Map();
      const onlineUserIds = new Set();
      state.active.forEach(room => {
        (room.players || []).forEach(player => {
          if (!player.id) return;
          activeRoomCounts.set(player.id, (activeRoomCounts.get(player.id) || 0) + 1);
        });
      });
      (rooms || []).forEach(room => {
        const presence = room.presence || {};
        [
          [room.host_user_id, presence.white],
          [room.guest_user_id, presence.dark],
        ].forEach(([userId, item]) => {
          if (!userId) return;
          if (isRecentActivity(item?.lastSeen) && !item?.disconnectedAt) onlineUserIds.add(userId);
        });
      });
      const statByUser = new Map();
      const { data: stats, error: statsError } = await client.rpc("admin_player_stats");
      if (statsError && !/function .*admin_player_stats/i.test(statsError.message || "")) throw statsError;
      (stats || []).forEach(item => {
        statByUser.set(item.user_id, {
          gamesPlayed: Number(item.games_played || 0),
          gamesWon: Number(item.games_won || 0),
        });
      });
      state.users = (users || []).map(user => ({
        id: user.id,
        name: user.nickname || user.email || user.id,
        email: user.email || "",
        ip: "-",
        passwordState: "supabase",
        createdAt: user.created_at,
        activeRooms: activeRoomCounts.get(user.id) || 0,
        gamesPlayed: statByUser.get(user.id)?.gamesPlayed || 0,
        gamesWon: statByUser.get(user.id)?.gamesWon || 0,
        rating: user.rating,
        online: onlineUserIds.has(user.id) || isRecentActivity(user.last_seen_at),
        banned: Boolean(user.banned_at),
        banReason: user.banned_reason || "",
        banHistory: [],
      }));
      state.usersError = "";
    } catch (error) {
      state.users = [];
      state.usersError = error.message;
    }
    saveWatch();
    if (state.detailKey && !roomByKey(state.detailKey)) clearRoomDetail();
    render();
    restoreScrollSnapshot(snapshot);
    return;
  }
  const sessionsData = await api("/api/admin/sessions");
  state.active = sessionsData.active || [];
  state.archive = sessionsData.archive || [];
  state.audit = sessionsData.audit || [];
  state.retentionHours = sessionsData.retentionHours || state.retentionHours;
  try {
    const usersData = await api("/api/admin/users");
    state.users = (usersData.users || []).map(user => ({
      ...user,
      online: isRecentActivity(user.lastSeenAt) || Number(user.activeRooms || 0) > 0,
    }));
    state.usersError = "";
  } catch (error) {
    state.users = [];
    state.usersError = error.message;
  }
  saveWatch();
  if (state.detailKey && !roomByKey(state.detailKey)) clearRoomDetail();
  render();
  restoreScrollSnapshot(snapshot);
}

async function openRoom(key) {
  const room = roomByKey(key);
  if (!room) return;
  if (state.backend === "supabase") {
    const client = await supabaseClient();
    const { data, error } = await client
      .from("rooms")
      .select("id,code,variant,access,status,host_user_id,guest_user_id,host_name,guest_name,host_rating,guest_rating,host_registered,guest_registered,game_state,game_version,presence,left_players,created_at,joined_at,updated_at,archived_at,closed_reason")
      .eq("id", room.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Комната недоступна.");
    state.detail = supabaseRoomDetail(data);
    state.detailKey = key;
    render();
    return;
  }
  const id = room.source === "archive" ? room.archiveId : room.id;
  state.detail = await api(`/api/admin/sessions/${encodeURIComponent(id)}`);
  state.detailKey = key;
  render();
}

async function closeRoom(key) {
  if (state.readonlyAdmin) {
    state.notice = "На GitHub Pages закрытие комнаты требует серверной Supabase Edge Function.";
    renderPreservingScroll();
    return;
  }
  const room = roomByKey(key);
  if (!room || room.source !== "active") return;
  const reason = window.prompt(`Причина закрытия комнаты ${room.code}`, "");
  if (reason === null) return;
  const cleanReason = reason.trim();
  if (!cleanReason) {
    state.notice = "Укажите причину закрытия комнаты.";
    renderPreservingScroll();
    return;
  }
  const response = await api(`/api/admin/sessions/${encodeURIComponent(room.id)}/close`, {
    method: "POST",
    body: { reason: cleanReason },
  });
  state.notice = `Комната ${room.code} закрыта и отправлена в архив.`;
  await refresh();
  if (response.archive?.id) await openRoom(`archive:${response.archive.id}`);
}

function userById(id) {
  return state.users.find(user => user.id === id) || null;
}

async function changeUserPassword(userId) {
  const user = userById(userId);
  if (!user) return;
  const password = window.prompt(`Новый пароль для ${user.name}`, "");
  if (password === null) return;
  const cleanPassword = password.trim();
  if (cleanPassword.length < 6) {
    state.notice = "Пароль должен быть не короче 6 символов.";
    renderPreservingScroll();
    return;
  }
  if (state.backend === "supabase") {
    const client = await supabaseClient();
    const { error } = await client.rpc("admin_set_user_password", {
      target_profile_id: userId,
      new_password: cleanPassword,
    });
    if (error) throw error;
    state.notice = `Пароль игрока ${user.name} изменён.`;
    await refresh();
    return;
  }
  if (state.readonlyAdmin) {
    state.notice = "Смена пароля игрока недоступна в текущем режиме.";
    renderPreservingScroll();
    return;
  }
  await api(`/api/admin/users/${encodeURIComponent(userId)}/password`, {
    method: "POST",
    body: { password: cleanPassword },
  });
  state.notice = `Пароль игрока ${user.name} изменён в админской базе.`;
  await refresh();
}

async function banPlayer(userId) {
  const user = userById(userId);
  if (!user) return;
  const reason = window.prompt(`Причина бана для ${user.name}`, "");
  if (reason === null) return;
  const cleanReason = reason.trim();
  if (state.backend === "supabase") {
    const client = await supabaseClient();
    const { error } = await client.rpc("admin_set_profile_ban", {
      target_profile_id: userId,
      should_ban: true,
      ban_reason: cleanReason,
    });
    if (error) throw error;
    state.notice = `Игрок ${user.name} забанен.`;
    await refresh();
    return;
  }
  if (state.readonlyAdmin) {
    state.notice = "Бан игрока недоступен в текущем режиме.";
    renderPreservingScroll();
    return;
  }
  await api(`/api/admin/users/${encodeURIComponent(userId)}/ban`, {
    method: "POST",
    body: { reason: cleanReason },
  });
  state.notice = `Игрок ${user.name} забанен.`;
  await refresh();
}

async function unbanPlayer(userId) {
  const user = userById(userId);
  if (!user) return;
  if (state.backend === "supabase") {
    const client = await supabaseClient();
    const { error } = await client.rpc("admin_set_profile_ban", {
      target_profile_id: userId,
      should_ban: false,
      ban_reason: "",
    });
    if (error) throw error;
    state.notice = `Игрок ${user.name} разбанен.`;
    await refresh();
    return;
  }
  if (state.readonlyAdmin) {
    state.notice = "Разбан игрока недоступен в текущем режиме.";
    renderPreservingScroll();
    return;
  }
  await api(`/api/admin/users/${encodeURIComponent(userId)}/unban`, { method: "POST" });
  state.notice = `Игрок ${user.name} разбанен.`;
  await refresh();
}

async function deletePlayer(userId) {
  const user = userById(userId);
  if (!user) return;
  if (!window.confirm(`Удалить игрока ${user.name}? Активные комнаты игрока будут закрыты.`)) return;
  if (state.backend === "supabase") {
    const client = await supabaseClient();
    const { error } = await client.rpc("admin_delete_profile", {
      target_profile_id: userId,
    });
    if (error) throw error;
    state.notice = `Игрок ${user.name} удалён.`;
    await refresh();
    return;
  }
  if (state.readonlyAdmin) {
    state.notice = "Удаление игрока недоступно в текущем режиме.";
    renderPreservingScroll();
    return;
  }
  await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
  state.notice = `Игрок ${user.name} удалён.`;
  await refresh();
}

document.addEventListener("submit", async event => {
  const form = event.target;
  if (!["admin-login", "admin-password"].includes(form.dataset.form)) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.dataset.form === "admin-login") {
      if (supabaseAdminMode()) {
        const client = await supabaseClient();
        const email = String(data.email || "").trim();
        const password = String(data.password || "");
        if (!email || !password) throw new Error("Введите email и пароль администратора.");
        const user = await signInOrCreateSupabaseAdmin(client, email, password);
        if (!isAllowedSupabaseAdmin(user)) {
          await client.auth.signOut();
          throw new Error("Этот Supabase-аккаунт не входит в список администраторов.");
        }
        setSupabaseAdmin(user);
        state.notice = "";
        await refresh();
        return;
      }
      const response = await api("/api/admin/login", { method: "POST", body: data });
      state.admin = response.admin;
      state.notice = "";
      await refresh();
    }
    if (form.dataset.form === "admin-password") {
      if (state.readonlyAdmin) throw new Error("Смена пароля администратора недоступна в режиме GitHub Pages.");
      if (String(data.newPassword || "") !== String(data.repeatPassword || "")) {
        throw new Error("Новый пароль и повтор не совпадают.");
      }
      await api("/api/admin/password", {
        method: "POST",
        body: {
          currentPassword: data.currentPassword,
          newPassword: data.newPassword,
        },
      });
      form.reset();
      state.adminPasswordOpen = false;
      state.notice = "Пароль администратора изменён.";
      await refresh();
    }
  } catch (error) {
    state.notice = error.message;
    render();
  }
});

document.addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.dataset.action === "toggle-password") {
      const input = button.closest(".password-field")?.querySelector("input");
      if (!input) return;
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", visible ? "true" : "false");
      button.setAttribute("aria-label", visible ? "Скрыть пароль" : "Показать пароль");
      button.setAttribute("title", visible ? "Скрыть пароль" : "Показать пароль");
      input.focus();
      return;
    }
    if (button.dataset.adminTheme) {
      applyAdminTheme(button.dataset.adminTheme);
      renderPreservingScroll();
      return;
    }
    if (button.dataset.adminLang) {
      applyAdminLang(button.dataset.adminLang);
      renderPreservingScroll();
      return;
    }
    if (button.dataset.action === "toggle-admin-password") {
      if (state.readonlyAdmin) {
        state.notice = "Смена пароля администратора недоступна в режиме GitHub Pages.";
        renderPreservingScroll();
        return;
      }
      state.adminPasswordOpen = !state.adminPasswordOpen;
      state.notice = "";
      renderPreservingScroll();
      return;
    }
    if (button.dataset.adminTab) {
      state.adminTab = button.dataset.adminTab;
      localStorage.setItem(TAB_KEY, state.adminTab);
      state.notice = "";
      renderPreservingScroll();
      return;
    }
    if (button.dataset.action === "refresh") await refresh();
    if (button.dataset.action === "logout") {
      if (state.backend === "supabase") {
        const client = await supabaseClient();
        await client.auth.signOut();
      } else {
        await api("/api/admin/logout", { method: "POST" });
      }
      state.admin = null;
      state.detail = null;
      render();
    }
    if (button.dataset.watch) {
      const key = button.dataset.watch;
      const wasWatched = state.watch.includes(key);
      state.watch = wasWatched ? state.watch.filter(item => item !== key) : [...state.watch, key];
      if (wasWatched && state.detailKey === key) clearRoomDetail();
      saveWatch();
      renderPreservingScroll();
    }
    if (button.dataset.open) await openRoom(button.dataset.open);
    if (button.dataset.adminClose) await closeRoom(button.dataset.adminClose);
    if (button.dataset.userPassword) await changeUserPassword(button.dataset.userPassword);
    if (button.dataset.userBan) await banPlayer(button.dataset.userBan);
    if (button.dataset.userUnban) await unbanPlayer(button.dataset.userUnban);
    if (button.dataset.userDelete) await deletePlayer(button.dataset.userDelete);
    if (button.dataset.copy) {
      await copyToClipboard(button.dataset.copy);
      state.notice = "Скопировано.";
      renderPreservingScroll();
    }
    if (button.dataset.copyHash) {
      await copyToClipboard(button.dataset.copyHash);
      state.notice = "Хэш хода скопирован.";
      renderPreservingScroll();
    }
    if (button.dataset.action === "copy-game") {
      await copyToClipboard(gameProtocolText());
      state.notice = "Протокол партии скопирован.";
      renderPreservingScroll();
    }
  } catch (error) {
    state.notice = error.message;
    renderPreservingScroll();
  }
});

window.setInterval(() => {
  if (state.admin) refresh().catch(() => {});
}, 5000);

loadMe().catch(error => {
  state.notice = error.message;
  render();
});
