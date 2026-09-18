/* ───────────────────────────────────────────────────────
   game-controller.js — wires NarduGame engine + NarduBot to the room.html UI.
   Owns turn flow, animations, win screen, and rating updates.
   Reads URL params:  ?mode=bot|hotseat   ?opp=Name   ?oppR=number
   Starts with an opening roll: one die per side, higher die moves first.
   ─────────────────────────────────────────────────────── */

window.NarduController = (function () {

  /* ── public state mirror for the existing renderQuad/makePoint code ── */
  let state;
  let mode = 'bot';
  let playerColor = 'white';
  let spectatorMode = false;
  let viewColor = 'white';
  let opponentName = 'Easy bot';
  let opponentRating = 900;
  let botDifficulty = 'easy';
  let variant = 'long';
  let pending = null;            /* { from } — currently selected source point */
  let isAnimating = false;
  let isRolling = false;
  let fairDiceError = '';
  let botPlannerError = '';
  let activeNeuralDecisionId = '';
  let neuralDecisionSerial = 0;
  let fairDiceInFlight = false;
  let autoRollTimer = null;
  let autoEndTimer = null;
  let onRender = null;           /* the existing renderQuad-chain renderer */
  let timers = [];
  let statTimer = null;
  let dragState = null;
  let suppressClickUntil = 0;
  let undoStack = [];
  let isChainingMove = false;
  let remoteCode = '';
  let remoteVersion = 0;
  let remotePublishQueue = Promise.resolve();
  let remotePollTimer = null;
  let isApplyingRemote = false;
  let botAnalysisReady = false;
  let botAnalysisDisabled = false;
  let botAnalysisOwnershipUnknown = false;
  let botAnalysisRestorePending = false;
  let botAnalysisConflictRedirected = false;
  let botAnalysisVersion = 0;
  let botAnalysisEnsurePromise = null;
  let botAnalysisEnsureGeneration = 0;
  let botAnalysisPublishQueue = Promise.resolve();
  let botAnalysisStartupPromise = null;
  let botAnalysisStartupRetry = null;
  let botAnalysisStartupGeneration = 0;
  let botRatingPersistenceKey = null;
  let botTrainingArchivePending = false;
  let botTrainingArchiveDone = false;
  let botTrainingArchivePromise = Promise.resolve(true);
  let botGameFinalizePromise = Promise.resolve(true);
  let gameOverPublishPromise = null;
  let remoteAnimatedRollTokens = new Set();
  let remoteMoveSoundKeys = new Set();
  let remoteMoveSoundReady = false;
  let localRatingRecordedKey = null;
  let lastRatingResult = null;
  let ratingRetryKey = null;
  let ratingRetryCount = 0;
  let gameOverSoundKey = null;
  let botLearningRecordedKey = null;
  let rematchRestartToken = null;
  let gameOverActionStarted = null;
  let botTurnActive = false;
  let botTurnGeneration = 0;
  let botTurnPlanPromise = null;
  let activeBotDecisionId = '';
  let fallbackBotDecisionSerial = 0;
  const ROOM_RELOAD_SNAPSHOT_KEY = 'narduh-room-reload-snapshot';
  const ROOM_PERSIST_SNAPSHOT_PREFIX = 'narduh-room-state:';
  const BOT_GAME_CONFIG_PREFIX = 'narduh-bot-game:';
  const CREATE_GAME_KEY = 'narduh-created-game';
  const ROOM_RELOAD_MAX_AGE_MS = 10 * 60 * 1000;
  const ROOM_PERSIST_MAX_AGE_MS = 96 * 60 * 60 * 1000;
  const ROOM_PERSIST_MAX_SNAPSHOTS = 8;
  const ROOM_PERSIST_SNAPSHOT_SCAN_LIMIT = 256;
  const ROOM_PERSIST_SNAPSHOT_PRUNE_LIMIT = 32;
  const ROOM_PERSIST_QUOTA_RECOVERY_REMOVALS = 4;
  const BOT_MEMORY_MAX_DECISIONS = 180;
  const LONG_BOT_REPLAY_EXPERIENCE_MAX_PATTERNS = 1024;
  const LONG_BOT_REPLAY_EXPERIENCE_MAX_CHARS = 512 * 1024;
  const OPENING_RESULT_PAUSE_MS = 2600;
  const MOVE_SOUND_SETTLE_MS = 210;
  const BEAR_OFF_SOUND_SETTLE_MS = 190;
  const GAME_OVER_SOUND_GAP_MS = 260;
  const WILDBG_ANALYSIS_TIMEOUT_MS = 30000;
  const LONG_BOT_EXPERIENCE_LOAD_TIMEOUT_MS = 8000;
  const LONG_BOT_EXPERIENCE_LOAD_ATTEMPTS = 2;
  // A live production load has legitimately taken almost seven seconds.  Do
  // not freeze an empty session until both bounded loader attempts can finish.
  // Restored frozen sessions take the separate immediate/deferred path below.
  const LONG_BOT_EXPERIENCE_STARTUP_WAIT_MS =
    LONG_BOT_EXPERIENCE_LOAD_TIMEOUT_MS * LONG_BOT_EXPERIENCE_LOAD_ATTEMPTS + 500;
  // The Supabase loader may spend 5 s on each of two CDNs before a room read
  // can begin. Keep restore bounded, but long enough for that fallback path.
  const BOT_ANALYSIS_RESTORE_TIMEOUT_MS = 12000;
  const BOT_ANALYSIS_ENSURE_TIMEOUT_MS = 5000;
  const BOT_ANALYSIS_WRITE_TIMEOUT_MS = 5000;
  // Covers drain + ownership confirmation + the first authoritative final write.
  const BOT_GAME_EXIT_WAIT_MS = 12500;
  const BOT_ANALYSIS_DRAIN_TIMEOUT_MS = 1200;
  let gameplaySoundBusyUntil = 0;
  const UI_TEXT = {
    ru: {
      bot_easy: 'Бот лёгкий',
      bot_medium: 'Бот средний',
      bot_hard: 'Бот сложный',
      bot_hard_neuro: 'Сложный бот-нейро',
      waiting_opponent: 'Ожидание соперника',
      opponent: 'Соперник',
      guest: 'Гость',
      you: 'Вы',
      side_white: 'Белые',
      side_dark: 'Тёмные',
      undo_last_title: 'Отменить последний ход',
      no_undo_title: 'Нет хода для отмены',
      resign_title: 'Сдаться и завершить партию',
      cannot_resign_title: 'Сдаться сейчас нельзя',
      dice_wait_opponent: 'Ожидание соперника',
      dice_opening_board: 'Розыгрыш первого хода на доске…',
      dice_opening_rolling: 'Кубики стартового броска катятся по доске…',
      dice_opponent_turn: 'Ход соперника',
      dice_your_first: 'Ваш первый ход',
      dice_auto_roll: 'Кубики бросаются автоматически…',
      dice_done: 'Ход завершён',
      dice_no_moves: 'Нет доступных ходов',
      turn_first: 'Первый ход',
      turn_auto_roll: 'Автобросок кубиков',
      turn_your: 'Ваш ход',
      turn_waiting: 'Ждём подключения соперника',
      turn_opening: 'Определяем право первого хода',
      turn_your_first_roll: 'Ваш первый ход: бросаем кубики',
      turn_your_roll: 'Ваш ход: бросаем кубики',
      turn_choose_move: 'Ваш ход: выберите шашку',
      turn_no_moves: 'Доступных ходов нет',
      turn_other: 'Ходит {name}',
      turn_watching: 'Ход: {name}',
      turn_roll_for: '{name}: бросаем кубики',
      turn_move_for: '{name}: выберите шашку',
      turn_complete: 'Партия завершена',
      turn_finished: 'Партия завершена: победил {winner}',
      history_wait_opening: 'Ожидаем стартовый бросок',
      history_wait_opening_sub: 'Оба игрока бросят по одному кубику.',
      history_room_created: 'Комната создана',
      history_code_wait: 'код {code} — ожидаем подключения соперника',
      history_opening_roll: 'Стартовый бросок',
      history_first_turn: 'первый ход',
      history_rerolls: ', перебросов: {count}',
      history_first_move: 'Первый ход',
      history_starting_dice: 'кубики первого хода {roll}',
      history_rolls: '{name} бросает',
      history_connection_lost: 'Соединение потеряно',
      history_victory: 'победа: {winner}',
      history_leaves: '{name} покидает комнату',
      history_resigns: '{name} сдаётся',
      history_moves: '{name} ходит',
      history_die: 'кубик {die}',
      borne_off: 'снято',
      copy_sha: 'Скопировать SHA-256',
      copy: 'Копировать',
      copied: 'Скопировано',
      not_copied: 'Не скопировано',
      bear_locked_title: 'Снятие станет доступно, когда все ваши шашки будут в доме.',
      bear_can_title: 'Снять выбранную шашку с доски',
      bear_pick_title: 'Выберите шашку в доме, которую можно снять по значениям кубиков.',
      mars: 'Марс',
      koks: 'Кокс',
      rematch_again: 'Ещё партия',
      rematch_again_question: 'Ещё партия?',
      lobby: 'В лобби',
      rematch_sent: 'Запрос отправлен. Ждём ответ соперника.',
      rematch_offer: 'Соперник предлагает: Ещё партия?',
      rematch_declined: 'Соперник отказался от новой партии.',
      rematch_starting: 'Начинаем новую партию...',
      preparing: 'Подготовка',
      yes: 'Да',
      no: 'Нет',
      white_won: 'Победили Белые',
      dark_won: 'Победили Тёмные',
      win: 'Победа!',
      lose: 'Поражение',
      pips_done: '{pips} пипов пройдено',
    },
    en: {
      bot_easy: 'Easy bot',
      bot_medium: 'Medium bot',
      bot_hard: 'Hard bot',
      bot_hard_neuro: 'Hard neural bot',
      waiting_opponent: 'Waiting for opponent',
      opponent: 'Opponent',
      guest: 'Guest',
      you: 'You',
      side_white: 'White',
      side_dark: 'Dark',
      undo_last_title: 'Undo the last move',
      no_undo_title: 'No move to undo',
      resign_title: 'Resign and finish the game',
      cannot_resign_title: 'You cannot resign right now',
      dice_wait_opponent: 'Waiting for opponent',
      dice_opening_board: 'Rolling for the first move on the board…',
      dice_opening_rolling: 'Opening dice are rolling on the board…',
      dice_opponent_turn: 'Opponent turn',
      dice_your_first: 'Your first move',
      dice_auto_roll: 'Dice roll automatically…',
      dice_done: 'Move finished',
      dice_no_moves: 'No available moves',
      turn_first: 'First move',
      turn_auto_roll: 'Auto-roll dice',
      turn_your: 'Your turn',
      turn_waiting: 'Waiting for opponent to connect',
      turn_opening: 'Determining who moves first',
      turn_your_first_roll: 'Your first move: rolling dice',
      turn_your_roll: 'Your turn: rolling dice',
      turn_choose_move: 'Your turn: choose a checker',
      turn_no_moves: 'No available moves',
      turn_other: '{name} is moving',
      turn_watching: 'Turn: {name}',
      turn_roll_for: '{name}: rolling dice',
      turn_move_for: '{name}: choose a checker',
      turn_complete: 'Game over',
      turn_finished: 'Game over: {winner} won',
      history_wait_opening: 'Waiting for the opening roll',
      history_wait_opening_sub: 'Both players will roll one die.',
      history_room_created: 'Room created',
      history_code_wait: 'code {code} — waiting for opponent to connect',
      history_opening_roll: 'Opening roll',
      history_first_turn: 'first move',
      history_rerolls: ', rerolls: {count}',
      history_first_move: 'First move',
      history_starting_dice: 'first-move dice {roll}',
      history_rolls: '{name} rolls',
      history_connection_lost: 'Connection lost',
      history_victory: 'winner: {winner}',
      history_leaves: '{name} leaves the room',
      history_resigns: '{name} resigns',
      history_moves: '{name} moves',
      history_die: 'die {die}',
      borne_off: 'borne off',
      copy_sha: 'Copy SHA-256',
      copy: 'Copy',
      copied: 'Copied',
      not_copied: 'Not copied',
      bear_locked_title: 'Bearing off becomes available when all your checkers are home.',
      bear_can_title: 'Bear the selected checker off the board',
      bear_pick_title: 'Select a checker in your home board that can be borne off with the dice.',
      mars: 'Mars',
      koks: 'Cox',
      rematch_again: 'Another game',
      rematch_again_question: 'Another game?',
      lobby: 'To lobby',
      rematch_sent: 'Request sent. Waiting for opponent response.',
      rematch_offer: 'Opponent offers: another game?',
      rematch_declined: 'Opponent declined a new game.',
      rematch_starting: 'Starting a new game...',
      preparing: 'Preparing',
      yes: 'Yes',
      no: 'No',
      white_won: 'White won',
      dark_won: 'Dark won',
      win: 'Victory!',
      lose: 'Defeat',
      pips_done: '{pips} pips moved',
    },
  };
  const NAME_KEYS = {
    'Бот лёгкий': 'bot_easy',
    'Easy bot': 'bot_easy',
    'Бот средний': 'bot_medium',
    'Medium bot': 'bot_medium',
    'Бот сложный': 'bot_hard',
    'Hard bot': 'bot_hard',
    'Сложный бот-нейро': 'bot_hard_neuro',
    'Hard neural bot': 'bot_hard_neuro',
    'Ожидание соперника': 'waiting_opponent',
    'Waiting for opponent': 'waiting_opponent',
    'Соперник': 'opponent',
    'Opponent': 'opponent',
    'Гость': 'guest',
    'Guest': 'guest',
  };
  const MESSAGE_KEYS = {
    'Соединение потеряно': 'history_connection_lost',
    'Connection lost': 'history_connection_lost',
  };

  function lang() {
    return localStorage.getItem('narduh-lang') === 'en' ? 'en' : 'ru';
  }

  function tr(key, vars = {}) {
    const pack = UI_TEXT[lang()] || UI_TEXT.ru;
    let text = pack[key] ?? UI_TEXT.ru[key] ?? key;
    Object.entries(vars).forEach(([name, value]) => {
      text = text.replaceAll(`{${name}}`, value);
    });
    return text;
  }

  function localizedName(name) {
    return tr(NAME_KEYS[String(name || '')] || '') || name;
  }

  function localizedMessage(message) {
    if (!message) return '';
    return tr(MESSAGE_KEYS[String(message)] || '') || message;
  }

  function sideName(color) {
    return color === 'white' ? tr('side_white') : tr('side_dark');
  }

  function setRenderer(fn) { onRender = fn; }

  function getState() { return state; }

  function roomReloadSignature() {
    return `${location.pathname}${location.search}`;
  }

  function roomPersistentSnapshotKey(signature = roomReloadSignature()) {
    return `${ROOM_PERSIST_SNAPSHOT_PREFIX}${signature}`;
  }

  function cloneStateForRestore(source) {
    return JSON.parse(JSON.stringify(source || {}));
  }

  function buildRoomSnapshot() {
    if (!state || state.phase === 'waiting') return false;
    try {
      syncTurnClock();
      return {
        v: 1,
        at: Date.now(),
        signature: roomReloadSignature(),
        mode,
        playerColor,
        roomCode: remoteCode || state.roomCode || '',
        state: cloneStateForRestore({
          ...state,
          selected: null,
          hints: [],
          fullHints: [],
        }),
      };
    } catch {
      return null;
    }
  }

  function roomSnapshotStorageError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    const code = Number(error?.code);
    if (
      name === 'QuotaExceededError' ||
      name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      code === 22 ||
      code === 1014 ||
      /quota/i.test(message)
    ) return 'quota-exceeded';
    return (name || 'storage-error').slice(0, 64);
  }

  function recordRoomSnapshotPersistence(details) {
    if (!state || typeof state !== 'object') return;
    if (!state.analysis || typeof state.analysis !== 'object' || Array.isArray(state.analysis)) {
      state.analysis = {};
    }
    state.analysis.roomSnapshotPersistence = {
      at: Date.now(),
      status: details.status,
      sessionSaved: details.sessionSaved,
      persistentSaved: details.persistentSaved,
      retried: details.retried,
      pruned: details.pruned,
      error: details.error || '',
    };
  }

  function roomSnapshotEntries(preserveKey = '') {
    const entries = [];
    try {
      const length = Math.min(
        ROOM_PERSIST_SNAPSHOT_SCAN_LIMIT,
        Math.max(0, Number(localStorage.length) || 0),
      );
      for (let index = 0; index < length; index += 1) {
        const key = localStorage.key(index);
        if (!key || key === preserveKey || !key.startsWith(ROOM_PERSIST_SNAPSHOT_PREFIX)) continue;
        let at = 0;
        let valid = false;
        try {
          const snapshot = JSON.parse(localStorage.getItem(key) || 'null');
          at = Number(snapshot?.at) || 0;
          valid = Boolean(snapshot?.state && at > 0);
        } catch {}
        entries.push({ key, at, valid });
      }
    } catch {}
    return entries;
  }

  function pruneRoomSnapshots({ preserveKey = '', quotaRecovery = false } = {}) {
    const now = Date.now();
    const entries = roomSnapshotEntries(preserveKey);
    const oldestFirst = entries.slice().sort((left, right) => left.at - right.at);
    const removable = new Set();

    oldestFirst.forEach(entry => {
      if (!entry.valid || now - entry.at > ROOM_PERSIST_MAX_AGE_MS) removable.add(entry.key);
    });

    const validNewestFirst = entries
      .filter(entry => entry.valid && !removable.has(entry.key))
      .sort((left, right) => right.at - left.at);
    const otherSnapshotLimit = Math.max(0, ROOM_PERSIST_MAX_SNAPSHOTS - 1);
    validNewestFirst.slice(otherSnapshotLimit).forEach(entry => removable.add(entry.key));

    if (quotaRecovery) {
      for (const entry of oldestFirst) {
        if (removable.size >= ROOM_PERSIST_QUOTA_RECOVERY_REMOVALS) break;
        removable.add(entry.key);
      }
    }

    let removed = 0;
    for (const key of removable) {
      if (removed >= ROOM_PERSIST_SNAPSHOT_PRUNE_LIMIT) break;
      try {
        localStorage.removeItem(key);
        removed += 1;
      } catch {}
    }
    return removed;
  }

  function setRoomSnapshot(storage, key, json, retryQuota) {
    try {
      storage.setItem(key, json);
      return { ok: true, retried: false, error: '' };
    } catch (error) {
      const firstError = roomSnapshotStorageError(error);
      if (firstError !== 'quota-exceeded') {
        return { ok: false, retried: false, error: firstError };
      }
      try {
        retryQuota?.();
        storage.setItem(key, json);
        return { ok: true, retried: true, error: '' };
      } catch (retryError) {
        return {
          ok: false,
          retried: true,
          error: roomSnapshotStorageError(retryError),
        };
      }
    }
  }

  function writeRoomSnapshot({ session = false, persistent = true } = {}) {
    const snapshot = buildRoomSnapshot();
    if (!snapshot) return false;
    let json;
    try {
      json = JSON.stringify(snapshot);
    } catch (error) {
      recordRoomSnapshotPersistence({
        status: 'failed',
        sessionSaved: false,
        persistentSaved: false,
        retried: false,
        pruned: 0,
        error: roomSnapshotStorageError(error),
      });
      return false;
    }

    let pruned = 0;
    let sessionResult = { ok: false, retried: false, error: '' };
    let persistentResult = { ok: false, retried: false, error: '' };
    if (session) {
      sessionResult = setRoomSnapshot(
        sessionStorage,
        ROOM_RELOAD_SNAPSHOT_KEY,
        json,
        () => {},
      );
    }
    if (persistent) {
      const persistentKey = roomPersistentSnapshotKey(snapshot.signature);
      pruned += pruneRoomSnapshots({ preserveKey: persistentKey });
      persistentResult = setRoomSnapshot(localStorage, persistentKey, json, () => {
        pruned += pruneRoomSnapshots({ preserveKey: persistentKey, quotaRecovery: true });
      });
    }

    const saved = (session && sessionResult.ok) || (persistent && persistentResult.ok);
    const degraded = saved && (
      (session && !sessionResult.ok) ||
      (persistent && !persistentResult.ok)
    );
    const errors = [
      session && !sessionResult.ok ? `session:${sessionResult.error}` : '',
      persistent && !persistentResult.ok ? `persistent:${persistentResult.error}` : '',
    ].filter(Boolean);
    recordRoomSnapshotPersistence({
      status: saved ? (degraded ? 'degraded' : 'ready') : 'failed',
      sessionSaved: session ? sessionResult.ok : null,
      persistentSaved: persistent ? persistentResult.ok : null,
      retried: sessionResult.retried || persistentResult.retried,
      pruned,
      error: errors.join(','),
    });
    if (!saved && (session || persistent)) {
      console.warn('Could not persist room snapshot', errors.join(',') || 'storage-error');
    }
    return Boolean(saved);
  }

  function prepareRoomReload() {
    return writeRoomSnapshot({ session: true, persistent: true });
  }

  function persistRoomSnapshot() {
    return writeRoomSnapshot({ session: true, persistent: true });
  }

  function clearRoomSnapshots() {
    try {
      sessionStorage.removeItem(ROOM_RELOAD_SNAPSHOT_KEY);
    } catch {}
    try {
      localStorage.removeItem(roomPersistentSnapshotKey());
    } catch {}
  }

  function readRoomSnapshot(storage, key) {
    try {
      return JSON.parse(storage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  function snapshotMatches(snapshot, expected = {}, maxAge = ROOM_RELOAD_MAX_AGE_MS) {
    if (!snapshot?.state || snapshot.signature !== roomReloadSignature()) return false;
    if (Date.now() - (Number(snapshot.at) || 0) > maxAge) return false;
    if (snapshot.mode && expected.mode && snapshot.mode !== expected.mode) return false;
    if (snapshot.playerColor && expected.playerColor && snapshot.playerColor !== expected.playerColor) return false;
    if ((snapshot.roomCode || '') !== (expected.roomCode || '')) return false;
    return true;
  }

  function consumeRoomReloadSnapshot(expected = {}) {
    const persistentKey = roomPersistentSnapshotKey();
    const sessionSnapshot = readRoomSnapshot(sessionStorage, ROOM_RELOAD_SNAPSHOT_KEY);
    try {
      sessionStorage.removeItem(ROOM_RELOAD_SNAPSHOT_KEY);
    } catch {}
    if (snapshotMatches(sessionSnapshot, expected, ROOM_RELOAD_MAX_AGE_MS)) return sessionSnapshot.state;

    const persistentSnapshot = readRoomSnapshot(localStorage, persistentKey);
    if (snapshotMatches(persistentSnapshot, expected, ROOM_PERSIST_MAX_AGE_MS)) return persistentSnapshot.state;
    if (persistentSnapshot) {
      try {
        localStorage.removeItem(persistentKey);
      } catch {}
    }
    return null;
  }

  function normalizeRestoredState(restored, url) {
    const saved = cloneStateForRestore(restored);
    const base = NarduGame.initialState(saved.variant || variant);
    return {
      ...base,
      ...saved,
      variant: saved.variant || base.variant,
      points: saved.points || base.points,
      bar: { ...base.bar, ...(saved.bar || {}) },
      off: { ...base.off, ...(saved.off || {}) },
      score: { ...base.score, ...(saved.score || {}) },
      dice: Array.isArray(saved.dice) ? saved.dice.slice() : [],
      rolled: Array.isArray(saved.rolled) ? saved.rolled.slice() : [],
      turnMoves: Array.isArray(saved.turnMoves) ? saved.turnMoves.map(move => ({ ...move })) : [],
      firstMoveDone: { ...base.firstMoveDone, ...(saved.firstMoveDone || {}) },
      headPlayedThisTurn: { ...base.headPlayedThisTurn, ...(saved.headPlayedThisTurn || {}) },
      history: Array.isArray(saved.history) ? saved.history.map(item => ({ ...item })) : [],
      openingRoll: saved.openingRoll ? cloneStateForRestore(saved.openingRoll) : null,
      selected: null,
      hints: [],
      fullHints: [],
      mode,
      playerColor,
      viewColor,
      roomCode: url.searchParams.get('room') || url.searchParams.get('game') || '',
      turnClock: normalizedTurnClock(saved.turnClock || base.turnClock),
      matchScore: normalizedMatchScore(saved.matchScore || base.matchScore),
    };
  }

  function attachRuntimeStateFields(roomCode) {
    state.hints = [];
    state.fullHints = [];
    state.selected = null;
    state.variant = state.variant || variant;
    state.mode = mode;
    state.playerColor = playerColor;
    state.spectator = spectatorMode;
    state.botDifficulty = botDifficulty;
    state.viewColor = viewColor;
    state.roomCode = roomCode;
    remoteCode = state.roomCode;
  }

  function longBotExperienceSessionKey(roomCode = remoteCode || state?.roomCode || '') {
    return `${String(roomCode || 'local')}:${Number(state?.startedAt) || 0}`;
  }

  /* ── init ──────────────────────────────────── */
  function init(opts = {}) {
    cancelBotTurnActivity();
    const startupGeneration = ++botAnalysisStartupGeneration;
    const url = new URL(location.href);
    const freshGame = opts.freshGame === true;
    mode = opts.mode || url.searchParams.get('mode') || 'bot';
    const roomCode = opts.roomCode || url.searchParams.get('room') || url.searchParams.get('game') || '';
    spectatorMode = Boolean(opts.spectator || url.searchParams.get('role') === 'spectator' || url.searchParams.get('spectator') === '1');
    const waitingForOpponent = opts.waiting || url.searchParams.get('waiting') === '1';
    opponentName = opts.opponent || url.searchParams.get('opp') || (waitingForOpponent ? tr('waiting_opponent') : (mode === 'bot' ? tr('bot_easy') : tr('opponent')));
    opponentRating = Number(opts.opponentRating || url.searchParams.get('oppR') || 900);
    const storedBotConfig = readBotGameConfig(roomCode);
    botDifficulty = resolveBotDifficulty(
      opts.difficulty,
      url.searchParams.get('difficulty'),
      storedBotConfig?.difficulty,
      opponentName,
      opponentRating,
    );
    variant = normalizeVariant(opts.variant || url.searchParams.get('variant') || variant);
    playerColor = opts.playerColor || url.searchParams.get('color') || (url.searchParams.get('guest') === '1' ? 'dark' : 'white');
    viewColor = spectatorMode
      ? (opts.viewColor || url.searchParams.get('view') || 'white')
      : (mode === 'remote' ? playerColor : 'white');

    if (statTimer) clearInterval(statTimer);
    statTimer = null;

    if (freshGame) clearRoomSnapshots();
    const restoredState = waitingForOpponent || freshGame
      ? null
      : consumeRoomReloadSnapshot({ mode, playerColor, roomCode });
    state = restoredState ? normalizeRestoredState(restoredState, url) : NarduGame.initialState(variant);
    if (mode === 'bot') {
      adoptBotIdentity(state);
      persistBotGameConfig(roomCode, url);
    }
    if (opts.matchScore && !restoredState) {
      state.matchScore = normalizedMatchScore({ ...opts.matchScore, recordedWinner: null });
    }
    attachRuntimeStateFields(roomCode);
    if (mode === 'bot' && variant === 'long' && botDifficulty === 'hard') {
      window.NarduLongBotEngine?.beginExperienceSession?.(
        longBotExperienceSessionKey(roomCode),
      );
      window.NarduStrongBot?.syncLocalExperience?.();
    }
    remoteVersion = 0;
    fairDiceError = '';
    botPlannerError = '';
    activeNeuralDecisionId = '';
    validateNeuralBotAvailability();
    fairDiceInFlight = false;
    botAnalysisReady = false;
    botAnalysisDisabled = false;
    botAnalysisOwnershipUnknown = false;
    botAnalysisRestorePending = false;
    botAnalysisConflictRedirected = false;
    botAnalysisVersion = 0;
    invalidateBotAnalysisEnsureAttempt();
    botAnalysisPublishQueue = Promise.resolve();
    botAnalysisStartupPromise = null;
    botAnalysisStartupRetry = null;
    botRatingPersistenceKey = null;
    botTrainingArchivePending = false;
    botTrainingArchiveDone = false;
    botTrainingArchivePromise = Promise.resolve(true);
    botGameFinalizePromise = Promise.resolve(true);
    gameOverPublishPromise = null;
    remoteAnimatedRollTokens = new Set();
    remoteMoveSoundKeys = new Set();
    remoteMoveSoundReady = false;
    localRatingRecordedKey = null;
    lastRatingResult = null;
    ratingRetryKey = null;
    ratingRetryCount = 0;
    gameOverSoundKey = null;
    botLearningRecordedKey = null;
    gameplaySoundBusyUntil = 0;
    rematchRestartToken = null;
    gameOverActionStarted = null;
    if (remotePollTimer) clearInterval(remotePollTimer);
    remotePollTimer = null;
    if (waitingForOpponent) {
      state.phase = 'waiting';
      state.waitingForOpponent = true;
      state.turn = null;
      state.rolled = [];
      state.dice = [];
      state.history = [{
        waiting: true,
        roomCode: state.roomCode,
        at: new Date().toISOString(),
      }];
    }
    const shouldRestoreBotAnalysis = mode === 'bot' && !botPlannerError && !freshGame && canPublishBotAnalysis();
    botAnalysisRestorePending = shouldRestoreBotAnalysis;
    undoStack = [];

    paintOpponent();
    startStatTimer();
    render();
    preloadWildbgForHardShortBot();

    if (applyLocalBearOffDemo(url)) {
      botAnalysisRestorePending = false;
      render();
      return;
    }
    if (waitingForOpponent || botPlannerError) return;
    if (!opts.skipRemoteSync) startRemoteSync();
    // Local storage makes reloads fast, but the server snapshot remains
    // authoritative. Always verify it before resuming writes under this code.
    if (shouldRestoreBotAnalysis) {
      botAnalysisStartupRetry = () => runBotAnalysisStartup({
        url,
        roomCode,
        startupGeneration,
        publishDelay: restoredState ? 200 : 900,
        skipAutoStart: opts.skipAutoStart === true,
      });
      void retryBotAnalysisStartup();
      return;
    }
    if (mode === 'bot') {
      persistRoomSnapshot();
      queueBotAnalysisPublish(900);
    }
    if (opts.skipAutoStart) return;
    ensureAutoProgressAfterExperience(mode === 'remote' ? 1300 : 650);
  }

  function invalidateBotAnalysisEnsureAttempt() {
    botAnalysisEnsureGeneration += 1;
    botAnalysisEnsurePromise = null;
  }

  function retryBotAnalysisStartup() {
    if (
      mode !== 'bot' ||
      !remoteCode ||
      !botAnalysisRestorePending ||
      botAnalysisConflictRedirected ||
      typeof botAnalysisStartupRetry !== 'function'
    ) return Promise.resolve(false);
    if (botAnalysisStartupPromise) return botAnalysisStartupPromise;

    // A timed-out ensure request cannot be reused forever. Its eventual result
    // is ignored, while the database constraint keeps a new retry idempotent.
    invalidateBotAnalysisEnsureAttempt();
    return botAnalysisStartupRetry();
  }

  function runBotAnalysisStartup({
    url,
    roomCode,
    startupGeneration,
    publishDelay,
    skipAutoStart,
  }) {
    if (botAnalysisStartupPromise) return botAnalysisStartupPromise;
    if (
      startupGeneration !== botAnalysisStartupGeneration ||
      botAnalysisConflictRedirected
    ) return Promise.resolve(false);

    botAnalysisReady = false;
    botAnalysisDisabled = false;
    botAnalysisOwnershipUnknown = false;
    botAnalysisRestorePending = true;
    render();
    const attempt = promiseWithTimeout(
      restoreBotAnalysisState(url, roomCode, startupGeneration),
      BOT_ANALYSIS_RESTORE_TIMEOUT_MS,
      'Bot room restore timed out',
    ).then(restored => {
      if (startupGeneration !== botAnalysisStartupGeneration) return false;
      if (!botAnalysisReady) {
        throw new Error('Bot room reservation was not confirmed.');
      }
      if (restored) {
        state = restored;
        adoptBotIdentity(state, true);
        attachRuntimeStateFields(roomCode);
        validateNeuralBotAvailability();
        if (variant === 'long' && botDifficulty === 'hard') {
          window.NarduLongBotEngine?.beginExperienceSession?.(
            longBotExperienceSessionKey(roomCode),
          );
          window.NarduStrongBot?.syncLocalExperience?.();
        }
        persistBotGameConfig(roomCode, url);
        pending = null;
        undoStack = [];
        persistRoomSnapshot();
      }

      botAnalysisDisabled = false;
      botAnalysisOwnershipUnknown = false;
      botAnalysisRestorePending = false;
      render();
      queueBotAnalysisPublish(publishDelay);
      if (!skipAutoStart) {
        ensureAutoProgressAfterExperience(
          650,
          LONG_BOT_EXPERIENCE_STARTUP_WAIT_MS,
        );
      }
      return true;
    }).catch(error => {
      if (startupGeneration !== botAnalysisStartupGeneration) return false;
      invalidateBotAnalysisEnsureAttempt();
      botAnalysisDisabled = true;
      botAnalysisOwnershipUnknown = true;
      botAnalysisRestorePending = true;
      render();
      console.warn('Could not restore bot room before startup', error?.message || error);
      return false;
    }).finally(() => {
      if (botAnalysisStartupPromise === attempt) botAnalysisStartupPromise = null;
    });
    botAnalysisStartupPromise = attempt;
    return attempt;
  }

  function ensureAutoProgressAfterExperience(delay, maxExperienceWaitMs = LONG_BOT_EXPERIENCE_STARTUP_WAIT_MS) {
    if (mode !== 'bot' || botDifficulty !== 'hard') {
      ensureAutoProgress(delay);
      return;
    }
    const startWithFrozenExperience = () => {
      if (variant === 'long') {
        window.NarduStrongBot?.syncLocalExperience?.();
        const snapshot = window.NarduLongBotEngine?.freezeExperience?.(
          longBotExperienceSessionKey(),
        );
        recordLongBotExperienceLoad({
          frozen: true,
          fingerprint: snapshot?.fingerprint || '',
          experienceSize: Number(snapshot?.size) || 0,
        });
      }
      ensureAutoProgress(delay);
    };
    if (variant === 'long') {
      const loadExperience = loadLongBotExperienceBeforeStart().catch(error => {
        console.warn('Could not load shared bot experience', error?.message || error);
      });
      // A restored game already owns an immutable evidence snapshot. Network
      // refreshes are intentionally queued for the next session, so waiting
      // here cannot improve this game's decisions and only stalls its resume.
      if (window.NarduLongBotEngine?.experienceSnapshot?.()?.frozen === true) {
        loadExperience.catch(() => {});
        startWithFrozenExperience();
        return;
      }
      Promise.race([
        loadExperience,
        new Promise(resolve => setTimeout(resolve, Math.max(0, Number(maxExperienceWaitMs) || 0))),
      ]).finally(startWithFrozenExperience);
      return;
    }
    const load = window.NarduRooms?.loadShortBotExperience?.();
    if (!load?.then) {
      startWithFrozenExperience();
      return;
    }
    Promise.race([
      load.catch(error => console.warn('Could not load shared bot experience', error?.message || error)),
      new Promise(resolve => setTimeout(resolve, 4500)),
    ]).finally(startWithFrozenExperience);
  }

  async function loadLongBotExperienceBeforeStart() {
    const loader = window.NarduRooms?.loadLongBotExperience;
    const startedAt = Date.now();
    if (typeof loader !== 'function') {
      recordLongBotExperienceLoad({
        status: 'unavailable',
        durationMs: 0,
        attempts: 0,
      });
      throw new Error('Long-bot experience loader is unavailable');
    }

    let lastError = null;
    for (let attempt = 1; attempt <= LONG_BOT_EXPERIENCE_LOAD_ATTEMPTS; attempt += 1) {
      recordLongBotExperienceLoad({
        status: 'loading',
        startedAt: new Date(startedAt).toISOString(),
        attempt,
        attempts: attempt,
      });
      try {
        const patterns = await promiseWithTimeout(
          loader({ refresh: attempt > 1 }),
          LONG_BOT_EXPERIENCE_LOAD_TIMEOUT_MS,
          'Long-bot experience request timed out',
        );
        const experienceSize = Number(window.NarduLongBotEngine?.experienceSize?.()) || 0;
        const engineSnapshot = window.NarduLongBotEngine?.experienceSnapshot?.();
        const experienceDeferred = Number(engineSnapshot?.pendingPatternCount) > 0;
        if (
          Array.isArray(patterns)
          && patterns.length > 0
          && engineSnapshot?.frozen === true
          && experienceDeferred
        ) {
          recordLongBotExperienceLoad({
            status: 'deferred',
            deferred: true,
            durationMs: Date.now() - startedAt,
            attempts: attempt,
            patternCount: patterns.length,
            experienceSize,
            error: '',
          });
          return patterns;
        }
        if (
          Array.isArray(patterns)
          && patterns.length > 0
          && (experienceSize <= 0 || experienceDeferred)
        ) {
          throw new Error('Long-bot experience was fetched but not applied');
        }
        recordLongBotExperienceLoad({
          status: 'ready',
          durationMs: Date.now() - startedAt,
          attempts: attempt,
          patternCount: Array.isArray(patterns) ? patterns.length : 0,
          experienceSize,
          deferred: false,
          error: '',
        });
        return patterns;
      } catch (error) {
        lastError = error;
        recordLongBotExperienceLoad({
          status: attempt < LONG_BOT_EXPERIENCE_LOAD_ATTEMPTS ? 'retrying' : 'failed',
          durationMs: Date.now() - startedAt,
          attempts: attempt,
          error: String(error?.message || error || 'Unknown experience error').slice(0, 240),
        });
      }
    }
    throw lastError || new Error('Could not load long-bot experience');
  }

  function promiseWithTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      Promise.resolve(promise).then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function recordLongBotExperienceLoad(update) {
    if (variant !== 'long' || mode !== 'bot' || botDifficulty !== 'hard' || !state) return;
    state.analysis ||= {};
    const memory = state.analysis.botMemory && typeof state.analysis.botMemory === 'object'
      ? state.analysis.botMemory
      : {};
    state.analysis.botMemory = {
      ...memory,
      experienceLoad: {
        ...(memory.experienceLoad || {}),
        ...update,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  function preloadWildbgForHardShortBot() {
    if (mode !== 'bot' || variant !== 'short' || botDifficulty !== 'hard') return;
    const preload = window.NarduShortBotWildbg?.preload;
    if (typeof preload !== 'function') return;
    Promise.resolve(preload.call(window.NarduShortBotWildbg))
      .catch(error => console.warn('Could not preload WildBG', error?.message || error));
  }

  function resolveBotDifficulty(...hints) {
    const levels = { easy: 1, medium: 2, hard: 3, 'hard-neuro': 4 };
    let resolved = null;
    hints.flat().forEach(value => {
      const raw = String(value ?? '').trim().toLowerCase();
      let candidate = null;
      const numeric = Number(raw);
      if (levels[raw]) candidate = raw;
      else if (/нейро|neuro|neural/.test(raw)) candidate = 'hard-neuro';
      else if (/hard|слож|трудн/.test(raw) || numeric >= 1450) candidate = 'hard';
      else if (/medium|средн/.test(raw) || numeric >= 1100) candidate = 'medium';
      else if (/easy|л[её]гк/.test(raw) || (numeric > 0 && numeric < 1100)) candidate = 'easy';
      if (candidate && (!resolved || levels[candidate] > levels[resolved])) resolved = candidate;
    });
    return resolved || 'easy';
  }

  function readBotGameConfig(roomCode) {
    if (!roomCode) return null;
    try {
      const direct = JSON.parse(localStorage.getItem(`${BOT_GAME_CONFIG_PREFIX}${roomCode}`) || 'null');
      if (direct?.game === roomCode) return direct;
      const recent = JSON.parse(localStorage.getItem(CREATE_GAME_KEY) || 'null');
      return recent?.game === roomCode ? recent : null;
    } catch {
      return null;
    }
  }

  function adoptBotIdentity(source = {}, authoritative = false) {
    botDifficulty = resolveBotDifficulty(
      botDifficulty,
      source.botDifficulty,
      source.analysis?.difficulty,
      source.analysis?.botName,
      opponentName,
      opponentRating,
    );
    // A verified server room owns its policy. Stale URL/name/config hints may
    // restore a neural room, but must not upgrade an existing ordinary room.
    if (authoritative) {
      const stored = [source.botDifficulty, source.analysis?.difficulty]
        .find(value => ['easy', 'medium', 'hard', 'hard-neuro'].includes(value));
      if (stored) botDifficulty = stored;
    }
    const botNames = {
      easy: tr('bot_easy'),
      medium: tr('bot_medium'),
      hard: tr('bot_hard'),
      'hard-neuro': tr('bot_hard_neuro'),
    };
    const botRatings = { easy: 900, medium: 1200, hard: 1500, 'hard-neuro': 1500 };
    opponentName = botNames[botDifficulty];
    opponentRating = botRatings[botDifficulty];
  }

  function persistBotGameConfig(roomCode, url = null) {
    if (mode !== 'bot' || !roomCode) return;
    const config = {
      game: roomCode,
      opponent: 'bot',
      difficulty: botDifficulty,
      variant,
      botName: opponentName,
      botRating: opponentRating,
      updatedAt: new Date().toISOString(),
    };
    if (window.NarduApp?.persistBotGameConfig) {
      window.NarduApp.persistBotGameConfig(config);
    } else {
      try {
        localStorage.setItem(`${BOT_GAME_CONFIG_PREFIX}${roomCode}`, JSON.stringify(config));
        localStorage.setItem(CREATE_GAME_KEY, JSON.stringify(config));
      } catch {}
    }
    if (!url) return;
    url.searchParams.set('difficulty', botDifficulty);
    url.searchParams.set('opp', opponentName);
    url.searchParams.set('oppR', String(opponentRating));
    if (url.href !== location.href) history.replaceState(null, '', url);
  }

  function normalizeVariant(value) {
    return value === 'short' ? 'short' : 'long';
  }

  function applyLocalBearOffDemo(url) {
    const host = location.hostname;
    const localHost = host === 'localhost' || host === '127.0.0.1' || host === '';
    if (!localHost || url.searchParams.get('demo') !== 'bearoff') return false;
    mode = 'hotseat';
    playerColor = 'white';
    state.points = {
      1: { color: 'white', count: 1 },
      12: { color: 'dark', count: 15 },
    };
    state.off = { white: 14, dark: 0 };
    state.score = { white: 0, dark: 0 };
    state.turn = 'white';
    state.phase = 'move';
    state.rolled = [1];
    state.dice = [1];
    state.selected = null;
    state.hints = [];
    state.fullHints = [];
    state.winner = null;
    state.resultType = null;
    state.turnMoves = [];
    state.firstMoveDone = { white: true, dark: true };
    state.headPlayedThisTurn = { white: false, dark: false };
    state.history = [{
      color: 'white',
      roll: '1',
      at: new Date().toISOString(),
    }];
    render();
    onPointClick(1);
    return true;
  }

  function paintOpponent() {
    document.querySelectorAll('[data-opp-name]').forEach(el => el.textContent = localizedName(opponentName));
    const user = window.NarduApp?.getUser?.();
    document.querySelectorAll('[data-you-name]').forEach(el => el.textContent = user?.name || tr('guest'));
  }

  /* ── re-render orchestration ──────────────── */
  function render() {
    clearStaleDragClones();
    if (onRender) onRender();
    paintOpponent();
    renderDice();
    renderBoardDice();
    renderTurn();
    renderPlayerStats();
    renderHistory();
    renderBearTargets();
    renderBearButton();
    renderUndo();
    renderResign();
    /* ensure auth/user paint is current */
    window.NarduApp?.paintUser?.();
  }

  function clearStaleDragClones() {
    if (dragState) return;
    removeDragClones();
  }

  function removeDragClones(except = null) {
    document.querySelectorAll('.board-drag-checker').forEach(clone => {
      if (clone !== except) clone.remove();
    });
  }

  function startRemoteSync() {
    if (mode !== 'remote' || !remoteCode) return;
    pollRemoteState();
    remotePollTimer = setInterval(pollRemoteState, 900);
  }

  function remoteStatePayload() {
    return JSON.parse(JSON.stringify({
      ...state,
      selected: null,
      hints: [],
      fullHints: [],
      playerColor: undefined,
      viewColor: undefined,
    }));
  }

  function botAnalysisPayload() {
    const payload = remoteStatePayload();
    payload.mode = 'bot';
    payload.variant = variant;
    payload.roomCode = remoteCode;
    payload.botDifficulty = botDifficulty;
    payload.opponent = 'bot';
    payload.analysis = {
      ...(payload.analysis || {}),
      mode: 'bot',
      opponent: 'bot',
      difficulty: botDifficulty,
      botName: opponentName,
      playerColor,
      updatedAt: new Date().toISOString(),
    };
    if (botDifficulty === 'hard-neuro' && !botPlannerError) {
      payload.analysis.neuralModel = { ...window.NarduNeuralBot.getModelMetadata() };
    }
    return payload;
  }

  function botFinalStatePayload() {
    const payload = botAnalysisPayload();
    const memory = payload.analysis?.botMemory;
    const isGuest = window.NarduApp?.getUser?.()?.guest === true;
    if (!isGuest && memory && typeof memory === 'object') {
      payload.analysis.botMemory = {
        ...memory,
        decisions: [],
      };
    }
    return payload;
  }

  function botTrainingStatePayload() {
    const payload = botAnalysisPayload();
    const replayExperience = boundedLongBotReplayExperience();
    if (replayExperience && payload.analysis?.botMemory) {
      payload.analysis.botMemory.replayExperience = replayExperience;
    }
    const isGuest = window.NarduApp?.getUser?.()?.guest === true;
    if (isGuest || botDifficulty === 'hard-neuro') return payload;
    // Decisions are the durable training record. The move history stays in the
    // compact room snapshot and would only duplicate bytes in the training half.
    payload.history = [];
    payload.turnMoves = [];
    return payload;
  }

  function boundedLongBotReplayExperience() {
    if (variant !== 'long' || botDifficulty !== 'hard') return null;
    const snapshot = window.NarduLongBotEngine?.experienceReplaySnapshot?.();
    if (!snapshot || typeof snapshot !== 'object') return null;
    const patterns = Array.isArray(snapshot.patterns) ? snapshot.patterns : [];
    const identity = {
      schema: 'long-experience-replay-v1',
      engineVersion: String(snapshot.engineVersion || window.NarduLongBotEngine?.version || ''),
      fingerprint: String(snapshot.fingerprint || ''),
      size: Math.max(0, Number(snapshot.size) || 0),
      frozen: snapshot.frozen === true,
      patternCount: patterns.length,
    };
    let serialized = '';
    try {
      serialized = JSON.stringify(patterns);
    } catch {
      return { ...identity, complete: false, reason: 'experience-patterns-not-serializable' };
    }
    if (
      patterns.length > LONG_BOT_REPLAY_EXPERIENCE_MAX_PATTERNS
      || serialized.length > LONG_BOT_REPLAY_EXPERIENCE_MAX_CHARS
    ) {
      return {
        ...identity,
        complete: false,
        reason: 'experience-snapshot-size-limit',
        serializedChars: serialized.length,
      };
    }
    return {
      ...identity,
      complete: true,
      serializedChars: serialized.length,
      patterns: JSON.parse(serialized),
    };
  }

  function validBotTrainingStatePayload(payload) {
    if (mode !== 'bot' || botDifficulty !== 'hard' || !payload) return false;
    const memory = payload.analysis?.botMemory;
    const decisions = Array.isArray(memory?.decisions) ? memory.decisions : [];
    if (!decisions.length) return false;
    if (payload.variant !== 'long') return true;
    const coverage = memory?.coverage;
    const expected = Number(coverage?.expectedBotDecisions);
    const recorded = Number(coverage?.recordedBotDecisions);
    const recovered = Number(coverage?.recoveredBotDecisions);
    const engineVersion = String(memory?.engineVersion || '');
    const requiresCompleteCoverage = /long-analytic-v(?:29|30|31|32|33|34|35)$/.test(engineVersion);
    const requiresHomogeneousV35Ledger = engineVersion === 'long-analytic-v35';
    const v35BotDecisions = requiresHomogeneousV35Ledger
      ? decisions.filter(decision => {
        const actor = String(decision?.actor || 'bot');
        return actor === 'bot';
      })
      : [];
    return coverage?.complete === true &&
      Number.isInteger(expected) && expected >= 0 &&
      Number.isInteger(recorded) && recorded >= 0 &&
      Number.isInteger(recovered) && recovered >= 0 &&
      expected === recorded + recovered &&
      (!requiresCompleteCoverage || expected > 0) &&
      (!requiresHomogeneousV35Ledger || (
        v35BotDecisions.length === expected &&
        v35BotDecisions.every(decision => String(decision?.engineVersion || '') === engineVersion)
      ));
  }

  function canPublishBotAnalysis(options = {}) {
    return mode === 'bot' &&
      Boolean(remoteCode) &&
      !botAnalysisOwnershipUnknown &&
      (options.force || !botAnalysisDisabled) &&
      Boolean(window.NarduRooms?.ensureBotAnalysisRoom);
  }

  function isBotAnalysisState(source) {
    if (!source) return false;
    return source.mode === 'bot' ||
      source.opponent === 'bot' ||
      source.analysis?.mode === 'bot' ||
      source.analysis?.opponent === 'bot' ||
      Boolean(source.botDifficulty);
  }

  async function restoreBotAnalysisState(url, roomCode, startupGeneration = botAnalysisStartupGeneration) {
    if (!canPublishBotAnalysis()) return null;
    try {
      const data = await window.NarduRooms.getGameState(remoteCode);
      if (startupGeneration !== botAnalysisStartupGeneration) return null;
      if (!data?.state || !isBotAnalysisState(data.state)) {
        throw new Error('Bot room state was not confirmed.');
      }
      if (Number.isFinite(data.version)) botAnalysisVersion = data.version;
      botAnalysisReady = true;
      return normalizeRestoredState({
        ...data.state,
        roomCode: roomCode || data.state.roomCode || remoteCode,
      }, url);
    } catch (error) {
      if (startupGeneration !== botAnalysisStartupGeneration) throw error;
      if (error?.status === 404) {
        // A new bot game must reserve its server room before the board becomes
        // interactive. This closes the cross-tab race between the lobby guard
        // and the database's authoritative single-room constraint.
        const reserved = await ensureBotAnalysisRoomReady(botAnalysisPayload());
        if (!reserved || !botAnalysisReady) {
          throw new Error('Bot room reservation was not confirmed.');
        }
        return null;
      }
      console.warn('Could not restore bot room state', error?.message || error);
      throw error;
    }
  }

  async function ensureBotAnalysisRoomReady(initialPayload = null) {
    if (!canPublishBotAnalysis()) return false;
    if (botAnalysisReady) return true;
    if (botAnalysisEnsurePromise) return botAnalysisEnsurePromise;
    const ensureGeneration = ++botAnalysisEnsureGeneration;
    const ensurePromise = Promise.resolve().then(async () => {
      try {
        const data = await window.NarduRooms.ensureBotAnalysisRoom({
          code: remoteCode,
          variant,
          botName: opponentName,
          botRating: opponentRating,
          difficulty: botDifficulty,
          playerColor,
          state: initialPayload || botAnalysisPayload(),
        });
        if (ensureGeneration !== botAnalysisEnsureGeneration) return false;
        if (!data || data.ok === false || data.skipped) return false;
        if (data?.existing) {
          botAnalysisDisabled = true;
          botAnalysisOwnershipUnknown = true;
          console.warn('Bot analysis room appeared before restore completed; keeping its server state unchanged');
          return false;
        }
        botAnalysisReady = true;
        botAnalysisVersion = Number.isFinite(data?.version) ? data.version : Number(data?.version || 0);
        return true;
      } catch (error) {
        if (ensureGeneration !== botAnalysisEnsureGeneration) return false;
        botAnalysisDisabled = true;
        botAnalysisOwnershipUnknown = true;
        if (Number(error?.status) === 409 && error?.data?.room) {
          botAnalysisConflictRedirected = true;
          botAnalysisRestorePending = true;
          try {
            window.NarduApp?.safeStorageSet?.('narduh-active-room-conflict', JSON.stringify(error.data.room));
          } catch {}
          const lobbyUrl = new URL('index.html', location.href);
          lobbyUrl.searchParams.set('roomConflict', '1');
          location.href = lobbyUrl.toString();
        }
        console.warn('Could not enable bot analysis sync', error?.message || error);
        return false;
      }
    }).finally(() => {
      if (ensureGeneration === botAnalysisEnsureGeneration) {
        botAnalysisEnsurePromise = null;
      }
    });
    botAnalysisEnsurePromise = ensurePromise;
    return ensurePromise;
  }

  function queueBotAnalysisPublish(delay = 0) {
    if (!canPublishBotAnalysis()) return;
    window.setTimeout(() => publishBotAnalysisState(), Math.max(0, Number(delay) || 0));
  }

  async function publishBotAnalysisState(options = {}) {
    const force = options.force === true;
    if (
      botAnalysisRestorePending ||
      !canPublishBotAnalysis({ force }) ||
      state.phase === 'waiting' ||
      state.phase === 'over' ||
      Boolean(state.winner) ||
      gameOverPublishPromise ||
      isApplyingRemote
    ) return false;
    if (force) botAnalysisDisabled = false;
    syncTurnClock();
    persistRoomSnapshot();
    const payload = botAnalysisPayload();
    botAnalysisPublishQueue = botAnalysisPublishQueue
      .catch(() => {})
      .then(async () => {
        if (gameOverPublishPromise || state.phase === 'over' || state.winner) return false;
        const ready = await ensureBotAnalysisRoomReady(payload);
        if (!ready) return;
        if (gameOverPublishPromise || state.phase === 'over' || state.winner) return false;
        try {
          const data = await window.NarduRooms.putGameState(remoteCode, payload, botAnalysisVersion);
          if (Number.isFinite(data?.version)) botAnalysisVersion = data.version;
          return true;
        } catch (error) {
          if (error?.status !== 409) {
            console.warn('Could not save bot analysis state', error?.message || error);
            await handleFairDiceFailure(error);
            return false;
          }
          if (gameOverPublishPromise || state.phase === 'over' || state.winner) return false;
          try {
            const current = await window.NarduRooms.getGameState(remoteCode);
            if (Number.isFinite(current?.version)) botAnalysisVersion = current.version;
            if (
              current?.state?.phase === 'over' ||
              current?.state?.winner ||
              gameOverPublishPromise ||
              state.phase === 'over' ||
              state.winner
            ) return false;
            const saved = await window.NarduRooms.putGameState(remoteCode, payload, botAnalysisVersion);
            if (Number.isFinite(saved?.version)) botAnalysisVersion = saved.version;
            return true;
          } catch (retryError) {
            console.warn('Could not recover bot analysis sync', retryError?.message || retryError);
            await handleFairDiceFailure(retryError);
            return false;
          }
        }
      });
    return botAnalysisPublishQueue;
  }

  function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function ensureBotFinalStatePublished(trainingPayload = null) {
    if (botAnalysisOwnershipUnknown) return Promise.resolve(false);
    if (gameOverPublishPromise) return gameOverPublishPromise;
    if (state?.gameOverPublishedAt) return Promise.resolve(true);
    // Registered games send the compact room state and the compact training
    // record through one atomic RPC. Guests still publish the exact full state
    // first because their archive RPC verifies it byte-for-byte.
    const payload = botFinalStatePayload();
    const trainingState = validBotTrainingStatePayload(trainingPayload)
      ? trainingPayload
      : null;
    const pendingAnalysisPublishes = botAnalysisPublishQueue;
    gameOverPublishPromise = (async () => {
      await Promise.race([
        Promise.resolve(pendingAnalysisPublishes).catch(() => false),
        wait(BOT_ANALYSIS_DRAIN_TIMEOUT_MS),
      ]);
      if (botAnalysisOwnershipUnknown) return false;
      if (!botAnalysisReady) {
        let ready = false;
        try {
          ready = await promiseWithTimeout(
            ensureBotAnalysisRoomReady(payload),
            BOT_ANALYSIS_ENSURE_TIMEOUT_MS,
            'Bot analysis room confirmation timed out',
          );
        } catch (error) {
          botAnalysisDisabled = true;
          botAnalysisOwnershipUnknown = true;
          console.warn('Could not confirm bot analysis room before finalization', error?.message || error);
          return false;
        }
        if (!ready || botAnalysisOwnershipUnknown) return false;
      }
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (botAnalysisOwnershipUnknown) return false;
        try {
          const saved = await promiseWithTimeout(
            window.NarduRooms.finishRoomGame(
              remoteCode,
              payload,
              botAnalysisVersion,
              trainingState,
            ),
            BOT_ANALYSIS_WRITE_TIMEOUT_MS,
            'Finished bot game write timed out',
          );
          if (Number.isFinite(saved?.version)) botAnalysisVersion = saved.version;
          state.gameOverPublishedAt = new Date().toISOString();
          if (saved?.trainingArchived === true) {
            botTrainingArchiveDone = true;
            return true;
          }
          if (trainingState && saved?.trainingArchived === false) {
            // The authoritative finished room is already committed. Start the
            // legacy archive fallback without delaying rating confirmation;
            // navigation still waits for botTrainingArchivePromise below.
            archiveBotTrainingGame(trainingState, { finalStateReady: true });
          }
          return true;
        } catch (error) {
          lastError = error;
          if (error?.status === 409 && window.NarduRooms?.getGameState) {
            try {
              const current = await window.NarduRooms.getGameState(remoteCode);
              if (Number.isFinite(current?.version)) botAnalysisVersion = current.version;
              const currentState = current?.state;
              if (
                currentState?.phase === 'over' &&
                currentState?.winner === payload.winner &&
                String(currentState?.finishedAt || '') === String(payload.finishedAt || '')
              ) {
                state.gameOverPublishedAt = new Date().toISOString();
                if (trainingState) {
                  archiveBotTrainingGame(trainingState, { finalStateReady: true });
                }
                return true;
              }
            } catch (refreshError) {
              lastError = refreshError;
            }
          }
          await wait(500 * attempt);
        }
      }
      console.warn('Could not persist finished bot game', lastError?.message || lastError);
      return false;
    })().finally(() => {
      if (!state?.gameOverPublishedAt) gameOverPublishPromise = null;
    });
    return gameOverPublishPromise;
  }

  function waitForFinishedBotPersistence() {
    if (mode !== 'bot' || !state?.winner) return Promise.resolve(true);
    return Promise.race([
      Promise.resolve(botGameFinalizePromise).catch(() => false),
      wait(BOT_GAME_EXIT_WAIT_MS).then(() => false),
    ]);
  }

  function ensureRemoteFinalStatePublished() {
    if (mode !== 'remote' || !remoteCode || !state?.winner || state.phase !== 'over') return Promise.resolve(false);
    if (state.gameOverPublishedAt) return Promise.resolve(true);
    if (gameOverPublishPromise) return gameOverPublishPromise;
    const payload = remoteStatePayload();
    gameOverPublishPromise = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const saved = await window.NarduRooms.finishRoomGame(remoteCode, payload, remoteVersion);
          if (Number.isFinite(saved?.version)) remoteVersion = saved.version;
          state.gameOverPublishedAt = new Date().toISOString();
          return true;
        } catch (error) {
          lastError = error;
          await wait(250 * attempt);
        }
      }
      console.warn('Could not persist finished remote game', lastError?.message || lastError);
      return false;
    })().finally(() => {
      if (!state?.gameOverPublishedAt) gameOverPublishPromise = null;
    });
    return gameOverPublishPromise;
  }

  async function publishRemoteState() {
    if (mode === 'bot') return publishBotAnalysisState();
    if (mode !== 'remote' || !remoteCode || state.phase === 'waiting' || isApplyingRemote) return;
    syncTurnClock();
    persistRoomSnapshot();
    const payload = remoteStatePayload();
    remotePublishQueue = remotePublishQueue
      .catch(() => {})
      .then(() => publishRemoteStateNow(payload));
    return remotePublishQueue;
  }

  async function publishRemoteStateNow(payload) {
    if (mode !== 'remote' || !remoteCode || payload.phase === 'waiting' || isApplyingRemote) return;
    const version = remoteVersion;
    try {
      if (window.NarduRooms?.configured?.()) {
        const data = await window.NarduRooms.putGameState(remoteCode, payload, version);
        if (Number.isFinite(data.version)) remoteVersion = data.version;
        return;
      }
      const response = await fetch(`/api/rooms/${encodeURIComponent(remoteCode)}/game`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(window.NarduApp?.guestRequestHeaders?.() || {}),
        },
        body: JSON.stringify({ state: payload, version }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && Number.isFinite(data.version)) remoteVersion = data.version;
    } catch (error) {
      if (error?.status === 409) {
        const rejectedState = state;
        const recovered = await recoverRemotePublishConflict(payload);
        if (!recovered) {
          await pollRemoteState({ force: true });
          if (state === rejectedState) await handleFairDiceFailure(error);
        }
      }
      // Legacy rooms keep their previous offline behavior. Protected games
      // must not continue on an unaccepted board or throw away known dice.
      if (error?.status !== 409) await handleFairDiceFailure(error);
    }
  }

  async function handleFairDiceFailure(error) {
    if (!remoteCode || mode === 'hotseat') return false;
    let policy;
    try { policy = await window.NarduRooms?.fairDicePolicy?.(remoteCode); } catch { return false; }
    if (!policy?.required) return false;
    fairDiceError = lang() === 'en'
      ? 'Verified dice are temporarily unavailable. Refresh the page: the same roll is preserved.'
      : 'Подтверждённый бросок временно недоступен. Обновите страницу: этот же бросок сохранён.';
    fairDiceInFlight = false;
    cancelBotTurnActivity();
    undoStack = [];
    try {
      const current = await window.NarduRooms.getGameState(remoteCode);
      if (current.state) state = normalizeRestoredState(current.state, new URL(location.href));
      if (Number.isFinite(current.version)) {
        if (mode === 'bot') botAnalysisVersion = current.version;
        else remoteVersion = current.version;
      }
    } catch { /* Remain paused; do not synthesize a replacement roll. */ }
    render();
    return true;
  }

  async function recoverRemotePublishConflict(payload) {
    if (!window.NarduRooms?.configured?.()) return false;
    try {
      const current = await window.NarduRooms.getGameState(remoteCode);
      if (!current.state || !Number.isFinite(current.version)) return false;
      if (!shouldRetryRemotePayload(payload, current.state)) {
        applyRemoteState(current.state, current.version);
        return false;
      }
      remoteVersion = current.version;
      const saved = await window.NarduRooms.putGameState(remoteCode, payload, current.version);
      if (Number.isFinite(saved.version)) remoteVersion = saved.version;
      return true;
    } catch {
      return false;
    }
  }

  function historyComparableKey(item = {}) {
    return [
      item.opening ? 'opening' : '',
      item.openingMove ? 'openingMove' : '',
      item.color || '',
      item.roll || '',
      item.from ?? '',
      item.to ?? '',
      item.die ?? '',
      item.resign ? 'resign' : '',
      item.leave ? 'leave' : '',
      item.winnerColor || '',
      item.sha256 || '',
    ].join('|');
  }

  function recentHistorySignature(source) {
    return (source?.history || [])
      .slice(0, 8)
      .map(historyComparableKey)
      .join('||');
  }

  function isExhaustedMoveState(source) {
    if (!source || source.phase !== 'move' || source.winner) return false;
    if (!Array.isArray(source.dice) || source.dice.length === 0) return true;
    try {
      return !NarduGame.hasAnyMoves(JSON.parse(JSON.stringify(source)));
    } catch {
      return false;
    }
  }

  function shouldRetryRemotePayload(payload, current) {
    if (!payload || !current || payload.phase === 'waiting') return false;
    if (payload.startedAt && current.startedAt && Number(payload.startedAt) !== Number(current.startedAt)) return false;
    const payloadHistory = payload.history || [];
    const currentHistory = current.history || [];
    if (payloadHistory.length > currentHistory.length) return true;
    if (payloadHistory.length < currentHistory.length) return false;

    const sameRecentHistory = recentHistorySignature(payload) === recentHistorySignature(current);
    if (!sameRecentHistory) return false;

    if (payload.phase === 'over' && !current.winner) return true;
    if (payload.phase === 'roll' && current.phase === 'move' && current.turn !== payload.turn) {
      return isExhaustedMoveState(current);
    }
    if (payload.phase === 'move' && current.phase === 'move' && payload.turn === current.turn) {
      const payloadDice = Array.isArray(payload.dice) ? payload.dice.length : 0;
      const currentDice = Array.isArray(current.dice) ? current.dice.length : 0;
      return payloadDice < currentDice;
    }
    return false;
  }

  async function pollRemoteState(options = {}) {
    if (mode !== 'remote' || !remoteCode || state.phase === 'waiting' || (!options.force && (isRolling || isAnimating || isChainingMove))) return;
    try {
      if (window.NarduRooms?.configured?.()) {
        const data = await window.NarduRooms.getGameState(remoteCode);
        if (!data.state || !Number.isFinite(data.version) || data.version <= remoteVersion) return;
        applyRemoteState(data.state, data.version);
        return;
      }
      const response = await fetch(`/api/rooms/${encodeURIComponent(remoteCode)}/game`, {
        headers: window.NarduApp?.guestRequestHeaders?.() || {},
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 404) {
        handleRemoteRoomMissing();
        return;
      }
      if (!response.ok || !data.state || !Number.isFinite(data.version) || data.version <= remoteVersion) return;
      applyRemoteState(data.state, data.version);
    } catch (err) {
      if (err?.status === 404) handleRemoteRoomMissing();
      /* the next poll will retry */
    }
  }

  function applyRemoteState(nextState, version) {
    isApplyingRemote = true;
    remoteVersion = version;
    const previousStateForAnimation = state;
    const animateIncomingOpeningRoll = shouldAnimateIncomingRemoteOpeningRoll(nextState);
    const animateIncomingRoll = shouldAnimateIncomingRemoteRoll(nextState);
    const incomingMoveSounds = collectIncomingRemoteMoveSounds(nextState);
    const incomingMoveAnimations = incomingMoveSounds.filter(canAnimateIncomingRemoteMove);
    const previousStartedAt = state?.startedAt;
    const previousFinishedAt = state?.finishedAt;
    const previousTurnClock = state?.turnClock;
    const previousMatchScore = state?.matchScore;
    if (autoRollTimer) clearTimeout(autoRollTimer);
    if (autoEndTimer) clearTimeout(autoEndTimer);
    autoRollTimer = null;
    autoEndTimer = null;
    const remoteState = {
      ...JSON.parse(JSON.stringify(nextState)),
      selected: null,
      hints: [],
      fullHints: [],
      mode,
      playerColor,
      viewColor,
      roomCode: remoteCode,
      startedAt: nextState.startedAt || previousStartedAt || Date.now(),
      finishedAt: nextState.finishedAt || previousFinishedAt || null,
      turnClock: normalizedTurnClock(nextState.turnClock || previousTurnClock),
      matchScore: normalizedMatchScore(nextState.matchScore || previousMatchScore),
    };
    state = remoteState;
    if (state.phase === 'over' && state.rematch?.status === 'accepted' && isRemoteHost()) {
      isApplyingRemote = false;
      startNextGame({ publish: true });
      return;
    }
    pending = null;
    playIncomingMoveSounds(incomingMoveSounds);
    if (animateIncomingOpeningRoll) {
      isRolling = true;
      render();
      animateRemoteIncomingOpeningRoll();
    } else if (animateIncomingRoll) {
      isRolling = true;
      render();
      animateRemoteIncomingRoll();
    } else if (previousStateForAnimation && incomingMoveAnimations.length > 0) {
      state = {
        ...JSON.parse(JSON.stringify(previousStateForAnimation)),
        selected: null,
        hints: [],
        fullHints: [],
        mode,
        playerColor,
        viewColor,
        roomCode: remoteCode,
      };
      animateRemoteIncomingMoves(incomingMoveAnimations, remoteState);
    } else {
      render();
      if (state.phase === 'over' && state.winner) onGameOver();
      ensureAutoProgress(650);
    }
    isApplyingRemote = false;
  }

  function receiveRemoteState(nextState, version) {
    if (!nextState || !Number.isFinite(version) || version <= remoteVersion) return false;
    applyRemoteState(nextState, version);
    return true;
  }

  function historyMoveKey(item) {
    return `${item.at || ''}|${item.color || ''}|${item.from || ''}|${item.to || ''}|${item.die || ''}`;
  }

  function isHistoryMove(item) {
    return item && item.color && item.from !== undefined && item.to !== undefined && item.die !== undefined;
  }

  function collectIncomingRemoteMoveSounds(nextState) {
    const history = (nextState?.history || []).filter(isHistoryMove);
    const fresh = [];
    history.forEach(item => {
      const key = historyMoveKey(item);
      if (remoteMoveSoundKeys.has(key)) return;
      remoteMoveSoundKeys.add(key);
      if (remoteMoveSoundReady && item.color !== playerColor) fresh.push(item);
    });
    if (remoteMoveSoundKeys.size > 160) {
      remoteMoveSoundKeys = new Set([...remoteMoveSoundKeys].slice(-80));
    }
    remoteMoveSoundReady = true;
    return fresh.reverse();
  }

  function playIncomingMoveSounds(moves) {
    let offset = 0;
    moves.forEach(move => {
      const kind = moveSoundKind(move);
      markGameplaySound(kind, offset);
      schedule(() => playMoveSound(move), offset);
      offset += kind === 'bearOff' ? 240 : 180;
    });
  }

  function canAnimateIncomingRemoteMove(move) {
    if (!move || move.color === playerColor) return false;
    const from = Number(move.from);
    if (!Number.isInteger(from) || from < 1 || from > 24) return false;
    const to = remoteMoveTarget(move);
    if (to !== 0 && (!Number.isInteger(to) || to < 1 || to > 24)) return false;
    return true;
  }

  function remoteMoveTarget(move) {
    return move?.to === 'снято' || move?.to === 'borne-off' ? 0 : Number(move?.to);
  }

  function animateRemoteIncomingMoves(moves, remoteState) {
    isAnimating = true;
    let index = 0;

    function finish() {
      isAnimating = false;
      state = remoteState;
      render();
      if (state.phase === 'over' && state.winner) onGameOver();
      else ensureAutoProgress(650);
    }

    function step() {
      if (index >= moves.length) {
        finish();
        return;
      }
      const move = moves[index++];
      const from = Number(move.from);
      const to = remoteMoveTarget(move);
      if (NarduGame.pointColor(state, from) !== move.color) {
        finish();
        return;
      }
      NarduBoardEngine.animateCheckerMove({
        from,
        to,
        color: move.color,
        destinationCount: to === 0 ? 0 : NarduGame.pointCount(state, to),
      }).then(() => {
        const applied = NarduGame.applyMove(state, from, move.die, { autoEnd: false });
        if (!applied) {
          finish();
          return;
        }
        render();
        if (state.phase === 'over' || state.winner) {
          finish();
          return;
        }
        schedule(step, 60);
      }).catch(error => {
        console.warn('Incoming checker animation failed', error?.message || error);
        finish();
      });
    }

    step();
  }

  function handleRemoteRoomMissing() {
    if (mode !== 'remote' || state?.phase === 'waiting') {
      leaveRoomToLobby(false);
      return;
    }
    if (state?.winner) {
      onGameOver();
      return;
    }
    leaveRoomToLobby(false);
  }

  function shouldAnimateIncomingRemoteRoll(nextState) {
    if (mode !== 'remote' || !nextState || nextState.phase !== 'move') return false;
    if (!nextState.rollToken || remoteAnimatedRollTokens.has(nextState.rollToken)) return false;
    if (!Array.isArray(nextState.rolled) || nextState.rolled.length === 0) return false;
    if (nextState.turn === playerColor) return false;
    if (state?.rollToken === nextState.rollToken) return false;
    remoteAnimatedRollTokens.add(nextState.rollToken);
    if (remoteAnimatedRollTokens.size > 24) {
      remoteAnimatedRollTokens = new Set([...remoteAnimatedRollTokens].slice(-12));
    }
    return true;
  }

  function shouldAnimateIncomingRemoteOpeningRoll(nextState) {
    if (mode !== 'remote' || !nextState || nextState.phase !== 'opening-result') return false;
    if (!nextState.openingRoll?.host || !nextState.openingRoll?.guest) return false;
    if (!nextState.rollToken || remoteAnimatedRollTokens.has(nextState.rollToken)) return false;
    if (state?.rollToken === nextState.rollToken) return false;
    remoteAnimatedRollTokens.add(nextState.rollToken);
    if (remoteAnimatedRollTokens.size > 24) {
      remoteAnimatedRollTokens = new Set([...remoteAnimatedRollTokens].slice(-12));
    }
    return true;
  }

  function animateRemoteIncomingOpeningRoll() {
    const token = state.rollToken;
    const opening = state.openingRoll;
    const boardDiceLayer = document.getElementById('board-dice-layer');
    if (boardDiceLayer) boardDiceLayer.dataset.boardDiceCount = '2';
    NarduSound.dice();

    Promise.all([
      NarduBoardEngine.animateOpeningRoll({
        layer: boardDiceLayer,
        opening,
        token,
        duration: state.openingRoll?.fairDiceProof?.protocol === 'system-csprng-v1' ? 380 : 800,
      }),
      trayRollAnimation(),
    ]).then(() => {
      isRolling = false;
      if (state.rollToken !== token) {
        render();
        return;
      }
      render();
      scheduleOpeningTurnRoll(OPENING_RESULT_PAUSE_MS);
    }).catch(error => {
      console.warn('Incoming opening roll animation failed', error?.message || error);
      isRolling = false;
      render();
      if (state.rollToken === token) scheduleOpeningTurnRoll(OPENING_RESULT_PAUSE_MS);
    });
  }

  function animateRemoteIncomingRoll() {
    const token = state.rollToken;
    const rollingTurn = state.turn;
    const faces = boardDiceFaces(state.rolled || []);
    const boardDiceLayer = document.getElementById('board-dice-layer');
    if (boardDiceLayer) boardDiceLayer.dataset.boardDiceCount = String(faces.length);
    NarduSound.dice();

    Promise.all([
      NarduBoardEngine.animateDiceRoll({
        layer: boardDiceLayer,
        faces,
        color: rollingTurn,
        token,
        duration: state.history?.[0]?.fairDiceProof?.protocol === 'system-csprng-v1' ? 380 : undefined,
      }),
      trayRollAnimation(),
    ]).then(() => {
      isRolling = false;
      if (state.rollToken !== token) {
        render();
        return;
      }
      render();
      ensureAutoProgress(650);
    }).catch(error => {
      console.warn('Incoming dice animation failed', error?.message || error);
      isRolling = false;
      render();
      ensureAutoProgress(650);
    });
  }

  function renderUndo() {
    const btn = document.getElementById('undo-btn');
    if (!btn) return;
    const canUndo = undoStack.length > 0 && !isAnimating && !isRolling && !isChainingMove && state.phase === 'move' && isMyTurn();
    btn.disabled = !canUndo;
    btn.title = canUndo ? tr('undo_last_title') : tr('no_undo_title');
  }

  function renderResign() {
    const btn = document.getElementById('resign-btn');
    if (!btn) return;
    const canResign = state
      && state.phase !== 'waiting'
      && state.phase !== 'over'
      && !state.winner
      && !isAnimating
      && !isRolling
      && !isChainingMove
      && !botAnalysisRestorePending;
    btn.disabled = !canResign;
    btn.title = canResign ? tr('resign_title') : tr('cannot_resign_title');
  }

  /* ── dice & roll button rendering ─────────── */
  function renderDice() {
    const row = document.getElementById('dice-row');
    if (!row) return;
    row.innerHTML = '';

    if (state.phase === 'over') return;

    if (botAnalysisRestorePending) {
      addDiceMessage(row, tr('preparing'));
      return;
    }

    if (state.phase === 'waiting') {
      addDiceMessage(row, tr('dice_wait_opponent'));
      return;
    }

    if (state.phase === 'opening' || state.phase === 'opening-result') {
      if (state.phase === 'opening') {
        addDiceMessage(row, tr('dice_opening_board'));
      } else if (isRolling) {
        addDiceMessage(row, tr('dice_opening_rolling'));
      } else if (state.turn && !isMyTurn()) {
        addDiceMessage(row, tr('dice_opponent_turn'));
      } else {
        addDiceMessage(row, tr('dice_your_first'));
      }
      return;
    }

    if (state.phase === 'roll' || isRolling) {
      addDiceMessage(row, isMyTurn() ? tr('dice_auto_roll') : tr('dice_opponent_turn'));
      return;
    }

    if (!isMyTurn()) {
      addDiceMessage(row, tr('dice_opponent_turn'));
      return;
    }

    /* show rolled dice */
    NarduBoardEngine.renderDice(row, state.rolled, {
      usedMask: NarduBoardEngine.usedDiceMask(state),
    });

    if (state.dice.length === 0) {
      addDiceMessage(row, tr('dice_done'));
    } else if (!NarduGame.hasAnyMoves(state)) {
      addDiceMessage(row, tr('dice_no_moves'));
    }
  }

  function addDiceMessage(row, text) {
    const wait = document.createElement('div');
    wait.className = 'dice-wait';
    wait.textContent = text;
    row.appendChild(wait);
  }

  function boardDiceFaces(faces) {
    if (faces.length === 4 && faces.every(face => face === faces[0])) {
      return faces.slice(0, 2);
    }
    return faces;
  }

  function boardDiceUsedMask() {
    if (state.phase === 'opening-result') {
      return state.rolled.map(() => false);
    }
    if (state.rolled.length === 4 && state.rolled.every(face => face === state.rolled[0])) {
      const usedCount = state.rolled.length - state.dice.length;
      return [usedCount >= 2, usedCount >= 4];
    }
    return NarduBoardEngine.usedDiceMask(state);
  }

  function renderBoardDice() {
    const layer = document.getElementById('board-dice-layer');
    if (!layer) return;
    // The active animation owns the existing canvas. Removing it here drops the
    // WebGL context for a frame and makes the dice flash or disappear.
    if (isRolling) return;
    layer.classList.remove('head-home-white', 'head-home-dark');

    if (state.phase === 'over' || state.rolled.length === 0) {
      NarduBoardEngine.renderDice(layer, [], { board: true });
      return;
    }

    if (state.phase === 'opening-result' && state.openingRoll) {
      layer.dataset.boardDiceCount = '2';
      layer.classList.add('head-home-white', 'head-home-dark');
      NarduBoardEngine.renderOpeningDice(layer, state.openingRoll, {
        token: state.rollToken,
      });
      return;
    }

    const faces = boardDiceFaces(state.rolled);
    layer.dataset.boardDiceCount = String(faces.length);
    layer.classList.add(state.turn === 'white' ? 'head-home-white' : 'head-home-dark');
    NarduBoardEngine.placeDiceLayer(layer, {
      color: state.turn,
      diceCount: faces.length,
      token: state.rollToken,
    });
    NarduBoardEngine.renderDice(layer, faces, {
      board: true,
      usedMask: boardDiceUsedMask(),
    });
  }

  function turnName(color) {
    if (spectatorMode) {
      const participant = [state?.openingRoll?.host, state?.openingRoll?.guest]
        .find(entry => entry?.color === color);
      return participant?.name ? localizedName(participant.name) : sideName(color);
    }
    if (mode === 'hotseat') return sideName(color);
    if (color === playerColor) {
      return window.NarduApp?.getUser?.()?.name || tr('you');
    }
    return localizedName(opponentName);
  }

  /* ── turn banners ─────────────────────────── */
  function paintTurnStatus(text, tone = 'waiting') {
    const status = document.querySelector('[data-turn-status]');
    const label = status?.querySelector('[data-turn-status-label]');
    if (!status || !label) return;
    if (status.dataset.tone !== tone) status.dataset.tone = tone;
    const turn = state?.turn === 'white' || state?.turn === 'dark' ? state.turn : '';
    if (status.dataset.turn !== turn) status.dataset.turn = turn;
    if (label.textContent !== text) label.textContent = text;
  }

  function currentTurnStatus() {
    if (!state) return { text: tr('turn_opening'), tone: 'waiting' };
    if (botPlannerError && !state.winner) return { text: botPlannerError, tone: 'waiting' };
    if (fairDiceError) return { text: fairDiceError, tone: 'waiting' };
    if (fairDiceInFlight) return { text: lang() === 'en' ? 'Preparing and verifying the dice roll…' : 'Подготавливаем и проверяем бросок…', tone: 'waiting' };
    if (botAnalysisRestorePending) return { text: tr('preparing'), tone: 'waiting' };
    if (state.phase === 'waiting') return { text: tr('turn_waiting'), tone: 'waiting' };
    if (state.phase === 'over' || state.winner) {
      return {
        text: state.winner
          ? tr('turn_finished', { winner: turnName(state.winner) })
          : tr('turn_complete'),
        tone: 'complete',
      };
    }
    if (state.phase === 'opening') return { text: tr('turn_opening'), tone: 'waiting' };

    const activeName = state.turn === 'white' || state.turn === 'dark'
      ? turnName(state.turn)
      : tr('opponent');
    if (spectatorMode) {
      return { text: tr('turn_watching', { name: activeName }), tone: 'watching' };
    }
    if (mode === 'hotseat') {
      return {
        text: tr(state.phase === 'move' ? 'turn_move_for' : 'turn_roll_for', { name: activeName }),
        tone: 'active',
      };
    }
    if (!isMyTurn()) return { text: tr('turn_other', { name: activeName }), tone: 'waiting' };
    if (state.phase === 'opening-result') return { text: tr('turn_your_first_roll'), tone: 'active' };
    if (state.phase === 'roll' || isRolling) return { text: tr('turn_your_roll'), tone: 'active' };
    if (state.phase === 'move' && !NarduGame.hasAnyMoves(state)) {
      return { text: tr('turn_no_moves'), tone: 'waiting' };
    }
    return { text: tr('turn_choose_move'), tone: 'active' };
  }

  function renderTurn() {
    document.querySelectorAll('.player').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.turn-banner').forEach(el => el.style.visibility = 'hidden');

    const opponentColor = playerColor === 'white' ? 'dark' : 'white';
    paintPlayerSideLabels(opponentColor);

    const status = currentTurnStatus();
    paintTurnStatus(status.text, status.tone);

    if (state.turn !== 'white' && state.turn !== 'dark') return;

    const sel = state.turn === playerColor ? '.player.white' : '.player.dark';
    const meCard = document.querySelector(sel);
    if (meCard) {
      meCard.classList.add('active');
      const banner = meCard.querySelector('.turn-banner');
      if (banner) {
        banner.style.visibility = 'visible';
        banner.querySelector('span:last-child').textContent =
          state.phase === 'opening-result' ? tr('turn_first') : (state.phase === 'roll' ? tr('turn_auto_roll') : tr('turn_your'));
      }
    }
  }

  function paintPlayerSideLabels(opponentColor) {
    const user = window.NarduApp?.getUser?.();
    const myMeta = document.querySelector('.player.white .meta span:last-child');
    const oppMeta = document.querySelector('.player.dark .meta span:last-child');
    if (myMeta) myMeta.textContent = `${sideName(playerColor)} · ${window.NarduApp?.formatRating?.(user) || '—'}`;
    if (oppMeta) oppMeta.textContent = sideName(opponentColor);
  }

  function startStatTimer() {
    renderPlayerStats();
    statTimer = setInterval(renderPlayerStats, 1000);
  }

  function renderPlayerStats() {
    if (!state) return;
    syncTurnClock();
    const opponentColor = playerColor === 'white' ? 'dark' : 'white';
    paintCardStats('.player.white', playerColor);
    paintCardStats('.player.dark', opponentColor);
  }

  function paintCardStats(selector, color) {
    const card = document.querySelector(selector);
    if (!card || !color) return;
    const stats = {
      time: formatElapsed(turnClockMs(color)),
      onboard: String(onBoardCount(color)),
      match: formatMatchScore(color),
      towin: String(remainingPips(color)),
    };
    Object.entries(stats).forEach(([key, value]) => {
      const node = card.querySelector(`[data-stat="${key}"]`);
      if (node) node.textContent = value;
    });
  }

  function formatElapsed(ms) {
    const total = Math.floor(ms / 1000);
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function onBoardCount(color) {
    return Object.values(state?.points || {}).reduce((total, point) => (
      total + (point.color === color ? point.count : 0)
    ), 0);
  }

  function normalizedTurnClock(source = {}) {
    source ||= {};
    const active = source.active === 'white' || source.active === 'dark' ? source.active : null;
    return {
      white: Number(source.white) || 0,
      dark: Number(source.dark) || 0,
      active,
      startedAt: active ? (Number(source.startedAt) || Date.now()) : null,
    };
  }

  function clockActiveColor() {
    if (!state || state.winner || state.finishedAt) return null;
    if (state.phase === 'waiting' || state.phase === 'opening' || state.phase === 'over') return null;
    return state.turn === 'white' || state.turn === 'dark' ? state.turn : null;
  }

  function syncTurnClock(now = Date.now()) {
    if (!state) return;
    const clock = normalizedTurnClock(state.turnClock);
    if (clock.active && clock.startedAt) {
      clock[clock.active] += Math.max(0, now - clock.startedAt);
    }
    const active = clockActiveColor();
    clock.active = active;
    clock.startedAt = active ? now : null;
    state.turnClock = clock;
  }

  function turnClockMs(color) {
    const clock = normalizedTurnClock(state?.turnClock);
    return clock[color] || 0;
  }

  function normalizedMatchScore(source = {}) {
    return {
      white: Number(source.white) || 0,
      dark: Number(source.dark) || 0,
      target: Number(source.target) || 5,
      recordedWinner: source.recordedWinner || null,
    };
  }

  function formatMatchScore(color) {
    const score = normalizedMatchScore(state?.matchScore);
    return `${score[color] || 0}/${score.target}`;
  }

  function remainingPips(color) {
    if (typeof NarduGame.pipsFor === 'function') {
      return NarduGame.pipsFor(state, color);
    }
    return Object.entries(state?.points || {}).reduce((total, [point, data]) => {
      if (data.color !== color) return total;
      const pos = NarduGame.pathPos(color, Number(point), state);
      return total + data.count * Math.max(0, 24 - pos);
    }, 0);
  }

  /* ── history ──────────────────────────────── */
  function renderHistory() {
    const list = document.getElementById('history-list') || document.querySelector('.history');
    if (!list) return;
    window.NarduVerifyUI?.setGameContext(list.parentElement, state);
    const items = state.history || [];
    if (!items.length) {
      list.innerHTML = `
        <div class="hist-item">
          <div class="n">01</div>
          <div>
            <div class="lbl"><span class="swatch dark"></span><span>${tr('history_wait_opening')}</span></div>
            <div class="sub">${tr('history_wait_opening_sub')}</div>
          </div>
        </div>`;
      return;
    }
    list.innerHTML = items.map((item, index) => {
      const number = String(items.length - index).padStart(2, '0');
      if (item.waiting) {
        return historyMarkup(number, 'white', tr('history_room_created'), tr('history_code_wait', { code: item.roomCode || '—' }));
      }
      if (item.opening) {
        const rerollText = item.rerolls ? tr('history_rerolls', { count: item.rerolls }) : '';
        return historyMarkup(number, 'dark', tr('history_opening_roll'), `${item.hostName || sideName('white')} ${item.host} : ${item.guestName || sideName('dark')} ${item.guest} — ${tr('history_first_turn')}: ${turnName(item.winnerColor)}${rerollText}`, item.sha256, item);
      }
      if (item.openingMove) {
        return historyMarkup(number, item.color, tr('history_first_move'), tr('history_starting_dice', { roll: item.roll }), item.sha256, item);
      }
      if (item.roll) {
        return historyMarkup(number, item.color, tr('history_rolls', { name: turnName(item.color) }), item.roll, item.sha256, item);
      }
      if (item.networkLoss) {
        return historyMarkup(number, item.color, localizedMessage(item.message) || tr('history_connection_lost'), tr('history_victory', { winner: turnName(item.winnerColor) }));
      }
      if (item.leave) {
        return historyMarkup(number, item.color, tr('history_leaves', { name: turnName(item.color) }), tr('history_victory', { winner: turnName(item.winnerColor) }));
      }
      if (item.resign) {
        return historyMarkup(number, item.color, tr('history_resigns', { name: turnName(item.color) }), tr('history_victory', { winner: turnName(item.winnerColor) }));
      }
      const to = item.to === 'снято' ? tr('borne_off') : item.to;
      return historyMarkup(number, item.color, tr('history_moves', { name: turnName(item.color) }), `${item.from} → ${to}, ${tr('history_die', { die: item.die })}`);
    }).join('');
  }

  function historyMarkup(number, color, title, sub, sha256 = '', rollItem) {
    const safeTitle = String(title).replace(/[&<>"']/g, escapeHtml);
    const safeSub = String(sub).replace(/[&<>"']/g, escapeHtml);
    const safeHash = String(sha256 || '').replace(/[&<>"']/g, escapeHtml);
    const hashBlock = safeHash ? `
          <div class="fair-hash">
            <span>SHA-256</span>
            <code>${safeHash}</code>
            <button type="button" data-copy-hash="${safeHash}" title="${tr('copy_sha')}">${tr('copy')}</button>
            ${rollItem ? window.NarduVerifyUI?.rollControls(rollItem, { lang: lang(), context: { roomCode: remoteCode || state.roomCode, variant: state.variant } }) || '' : ''}
          </div>` : '';
    return `
      <div class="hist-item">
        <div class="n">${number}</div>
        <div>
          <div class="lbl"><span class="swatch ${color === 'white' ? 'white' : 'dark'}"></span><span>${safeTitle}</span></div>
          <div class="sub">${safeSub}</div>
          ${hashBlock}
        </div>
      </div>`;
  }

  function escapeHtml(ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] || ch;
  }

  async function copyHashToClipboard(hash, button) {
    if (!hash) return;
    const fallbackCopy = () => {
      const area = document.createElement('textarea');
      area.value = hash;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.focus();
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) throw new Error('fallback copy failed');
    };
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(hash);
        } catch {
          fallbackCopy();
        }
      } else {
        fallbackCopy();
      }
      if (button) {
        const previous = button.textContent;
        button.textContent = tr('copied');
        button.disabled = true;
        setTimeout(() => {
          button.textContent = previous || tr('copy');
          button.disabled = false;
        }, 1200);
      }
    } catch {
      if (button) button.textContent = tr('not_copied');
    }
  }

  /* ── helpers ──────────────────────────────── */
  function isMyTurn() {
    if (spectatorMode || botAnalysisRestorePending || fairDiceError || botPlannerError) return false;
    if (mode === 'hotseat') return true;
    return state.turn === playerColor;
  }

  function isRemoteHost() {
    return mode === 'remote' && new URL(location.href).searchParams.get('host') === '1';
  }

  function leaveRoomToLobby(closeRoom = true) {
    clearAll();
    if (closeRoom && window.NarduRoom?.leaveToLobby) {
      window.NarduRoom.leaveToLobby({ immediate: Boolean(state?.winner) });
      return;
    }
    if (!closeRoom && window.NarduRoom?.closeCurrentRoom) {
      window.NarduRoom.closeCurrentRoom()
        .then(() => { location.href = 'index.html'; })
        .catch(error => console.warn('Could not close room before lobby navigation', error?.message || error));
      return;
    }
    location.href = 'index.html';
  }

  function schedule(fn, ms) {
    const t = setTimeout(fn, ms);
    timers.push(t);
    return t;
  }

  function randomHex(bytes = 32) {
    const data = new Uint8Array(bytes);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(data);
    } else {
      for (let i = 0; i < data.length; i += 1) data[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
  }

  function createGameRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(8);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    const code = Array.from(bytes, value => alphabet[value % alphabet.length]).join('');
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  function startBotGameInNewRoom() {
    const nextCode = createGameRoomCode();
    clearRoomSnapshots();
    persistBotGameConfig(nextCode);
    const url = new URL(location.href);
    ['room', 'host', 'guest', 'waiting', 'role', 'spectator', 'view'].forEach(key => url.searchParams.delete(key));
    url.searchParams.set('mode', 'bot');
    url.searchParams.set('game', nextCode);
    url.searchParams.set('opp', opponentName);
    url.searchParams.set('oppR', String(opponentRating));
    url.searchParams.set('variant', variant);
    url.searchParams.set('opponent', 'bot');
    url.searchParams.set('access', 'open');
    url.searchParams.set('difficulty', botDifficulty);
    location.href = url.toString();
    return nextCode;
  }

  function utf8Bytes(input) {
    if (window.TextEncoder) return new TextEncoder().encode(input);
    const encoded = unescape(encodeURIComponent(input));
    return Uint8Array.from(encoded, ch => ch.charCodeAt(0));
  }

  function sha256HexFallback(input) {
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const bytes = Array.from(utf8Bytes(input));
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);

    const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));
    for (let chunk = 0; chunk < bytes.length; chunk += 64) {
      const w = new Uint32Array(64);
      for (let i = 0; i < 16; i += 1) {
        const offset = chunk + i * 4;
        w[i] = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i += 1) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }
    return h.map(value => value.toString(16).padStart(8, '0')).join('');
  }

  async function sha256Hex(input) {
    if (window.crypto?.subtle) {
      try {
        const bytes = new TextEncoder().encode(input);
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      } catch {
        // Privacy modes can expose crypto.subtle while rejecting digest().
      }
    }
    return sha256HexFallback(input);
  }

  function diceValuesFromHash(hash, count = 2) {
    const bytes = String(hash).match(/.{1,2}/g)?.map(part => parseInt(part, 16)).filter(Number.isFinite) || [];
    const values = [];
    for (const byte of bytes) {
      if (values.length >= count) break;
      if (byte < 252) values.push((byte % 6) + 1);
    }
    while (values.length < count) {
      const byte = bytes[values.length % Math.max(bytes.length, 1)] || Math.floor(Math.random() * 252);
      values.push((byte % 6) + 1);
    }
    return values;
  }

  function expandRollValues(values) {
    const [a, b] = values;
    return a === b ? [a, a, a, a] : [a, b];
  }

  function compactRollText(roll) {
    if (roll.length === 4 && roll.every(value => value === roll[0])) return `${roll[0]}:${roll[0]}`;
    return roll.join(':');
  }

  async function shaDiceRoll({ label, color, noTie = false } = {}) {
    if (remoteCode && mode !== 'hotseat' && window.NarduRooms?.fairDicePolicy) {
      const policy = await window.NarduRooms.fairDicePolicy(remoteCode, { refresh: true });
      if (policy.required) {
        fairDiceInFlight = true;
        render();
        await publishRemoteState();
        if (fairDiceError) throw new Error('The protected room is paused.');
        const proof = await window.NarduRooms.requestFairDice(remoteCode, {
          label: label === 'opening' ? 'opening' : 'roll',
          color: label === 'opening' ? 'none' : color,
        });
        fairDiceInFlight = false;
        return { hash: proof.sha256, input: proof.sha256Input, values: proof.dice.slice(),
          roll: expandRollValues(proof.dice), rerolls: proof.rerolls, proof };
      }
    }
    let rerolls = 0;
    while (true) {
      const seed = [
        'nardu',
        state.roomCode || 'local',
        label || 'roll',
        color || state.turn || 'none',
        state.history?.length || 0,
        state.matchScore?.white || 0,
        state.matchScore?.dark || 0,
        Date.now(),
        rerolls,
        randomHex(32),
      ].join('|');
      const hash = await sha256Hex(seed);
      const values = diceValuesFromHash(hash, 2);
      if (!noTie || values[0] !== values[1]) {
        return {
          hash,
          // A one-use preimage is disclosed only after its dice are known.
          // It does not expose a seed for subsequent rolls or prove commitment.
          input: seed,
          values,
          roll: expandRollValues(values),
          rerolls,
        };
      }
      rerolls += 1;
    }
  }
  function clearAll() {
    cancelBotTurnActivity();
    timers.forEach(clearTimeout); timers = [];
    if (autoRollTimer) clearTimeout(autoRollTimer);
    if (autoEndTimer) clearTimeout(autoEndTimer);
    if (remotePollTimer) clearInterval(remotePollTimer);
    if (statTimer) clearInterval(statTimer);
    autoRollTimer = null;
    autoEndTimer = null;
    remotePollTimer = null;
    statTimer = null;
    isRolling = false;
  }

  /* ── user actions ─────────────────────────── */
  function scheduleAutoRoll(ms = 600) {
    if (botAnalysisRestorePending || state.phase !== 'roll' || state.phase === 'over' || isRolling || autoRollTimer) return;
    if (mode === 'remote' && !isMyTurn()) return;
    autoRollTimer = schedule(() => {
      autoRollTimer = null;
      autoRoll();
    }, ms);
  }

  function scheduleOpeningRoll(ms = 600) {
    if (botAnalysisRestorePending || state.phase !== 'opening' || state.phase === 'over' || isRolling || autoRollTimer) return;
    if (mode === 'remote' && !isRemoteHost()) return;
    autoRollTimer = schedule(() => {
      autoRollTimer = null;
      openingRoll();
    }, ms);
  }

  function scheduleOpeningTurnRoll(ms = OPENING_RESULT_PAUSE_MS) {
    if (botAnalysisRestorePending || state.phase !== 'opening-result' || state.phase === 'over' || isRolling || autoRollTimer) return;
    if (mode === 'remote' && !isRemoteHost()) return;
    autoRollTimer = schedule(() => {
      autoRollTimer = null;
      startOpeningTurnRoll();
    }, ms);
  }

  function finishOpeningRollAnimation(error = null) {
    if (error) console.warn('Opening roll animation failed', error?.message || error);
    isRolling = false;
    render();
    scheduleOpeningTurnRoll(OPENING_RESULT_PAUSE_MS);
  }

  function finishTurnRollAnimation(rollingTurn, error = null) {
    if (error) console.warn('Dice animation failed', error?.message || error);
    isRolling = false;
    render();
    if (state.winner) { onGameOver(); return; }
    if (state.phase === 'roll') {
      scheduleAutoRoll(650);
      return;
    }
    if (state.turn === rollingTurn && mode === 'bot' && !isMyTurn()) {
      schedule(playBotTurn, 700);
    } else {
      maybeScheduleAutoEndTurn();
    }
  }

  function ensureAutoProgress(ms = 650) {
    if (typeof botPlannerError !== 'undefined' && botPlannerError) return;
    if (fairDiceError) return;
    if (botAnalysisRestorePending || !state || state.phase === 'waiting' || state.phase === 'over' || state.winner) return;
    if (isRolling || isAnimating || isChainingMove) return;
    if (state.phase === 'opening') {
      scheduleOpeningRoll(ms);
      return;
    }
    if (state.phase === 'opening-result') {
      scheduleOpeningTurnRoll(ms);
      return;
    }
    if (state.phase === 'roll') {
      scheduleAutoRoll(ms);
      return;
    }
    if (state.phase === 'move') {
      if (mode === 'bot' && !isMyTurn()) {
        schedule(playBotTurn, Math.max(450, ms));
        return;
      }
      maybeScheduleAutoEndTurn();
    }
  }

  async function openingRoll() {
    if (typeof botPlannerError !== 'undefined' && botPlannerError) return;
    if (botAnalysisRestorePending || state.phase !== 'opening' || isRolling) return;
    if (mode === 'remote' && !isRemoteHost()) return;
    const user = window.NarduApp?.getUser?.();
    const startedAt = state.startedAt;
    const generation = botAnalysisStartupGeneration;
    isRolling = true;
    try {
      NarduSound.prime();
      NarduSound.dice();
      const fair = await shaDiceRoll({ label: 'opening', color: 'opening', noTie: true });
      if (generation !== botAnalysisStartupGeneration) return;
      if (fair.proof && (state.history?.some(item => item.fairDiceProof?.request?.id === fair.proof.request.id)
        || state.startedAt !== startedAt || state.phase !== 'opening')) {
        isRolling = false;
        render();
        ensureAutoProgress(800);
        return;
      }
      const whitePlayer = {
        id: 'white',
        name: playerColor === 'white' ? (user?.name || sideName('white')) : localizedName(opponentName),
        color: 'white',
        die: fair.values[0],
      };
      const darkPlayer = {
        id: 'dark',
        name: playerColor === 'dark' ? (user?.name || sideName('dark')) : localizedName(opponentName),
        color: 'dark',
        die: fair.values[1],
      };
      const opening = NarduGame.decideOpeningRoll(state, whitePlayer, darkPlayer);
      opening.sha256 = fair.hash;
      opening.sha256Input = fair.input;
      opening.rerolls = fair.rerolls;
      if (fair.proof) opening.fairDiceProof = fair.proof;
      const openingHistory = state.history?.find(item => item.opening);
      if (openingHistory) {
        openingHistory.sha256 = fair.hash;
        openingHistory.sha256Input = fair.input;
        openingHistory.rerolls = fair.rerolls;
        if (fair.proof) openingHistory.fairDiceProof = fair.proof;
      }
      state.rollToken = `opening:${fair.hash.slice(0, 16)}:${opening.host.die}:${opening.guest.die}`;
      if (fair.proof) {
        const saved = await publishRemoteState();
        if ((mode === 'bot' && !saved) || fairDiceError) throw new Error('Could not commit verified opening dice.');
      } else publishRemoteState();
      render();

      const boardDiceLayer = document.getElementById('board-dice-layer');
      if (boardDiceLayer) boardDiceLayer.dataset.boardDiceCount = '2';
      Promise.all([
        NarduBoardEngine.animateOpeningRoll({
          layer: boardDiceLayer,
          opening,
          token: state.rollToken,
          duration: fair.proof?.protocol === 'system-csprng-v1' ? 380 : 800,
        }),
        trayRollAnimation(),
      ])
        .then(() => finishOpeningRollAnimation())
        .catch(error => finishOpeningRollAnimation(error));
    } catch (error) {
      console.warn('Opening roll failed', error?.message || error);
      await handleFairDiceFailure(error);
      isRolling = false;
      render();
      ensureAutoProgress(800);
    }
  }

  function startOpeningTurnRoll() {
    if (typeof botPlannerError !== 'undefined' && botPlannerError) return;
    if (botAnalysisRestorePending || state.phase !== 'opening-result' || isRolling) return;
    const started = NarduGame.startOpeningTurn(state);
    if (!started) return;
    const openingHash = state.openingRoll?.sha256 || '';
    state.rollToken = `opening-complete:${openingHash.slice(0, 16) || Date.now()}`;
    undoStack = [];
    publishRemoteState();
    render();
    ensureAutoProgress(650);
  }

  async function autoRoll() {
    if (typeof botPlannerError !== 'undefined' && botPlannerError) return;
    if (botAnalysisRestorePending || state.phase !== 'roll' || isRolling) return;
    const rollingTurn = state.turn;
    const startedAt = state.startedAt;
    const generation = botAnalysisStartupGeneration;
    isRolling = true;
    try {
      NarduSound.prime();
      NarduSound.dice();
      const fair = await shaDiceRoll({ label: 'turn-roll', color: rollingTurn });
      if (generation !== botAnalysisStartupGeneration) return;
      if (fair.proof && (state.history?.some(item => item.fairDiceProof?.request?.id === fair.proof.request.id)
        || state.startedAt !== startedAt || state.phase !== 'roll' || state.turn !== rollingTurn)) {
        isRolling = false;
        render();
        ensureAutoProgress(800);
        return;
      }
      const r = fair.roll;
      const openingMove = Boolean(state.openingRoll)
        && !state.history?.some(item => item.openingMove);
      undoStack = [];
      NarduGame.applyRoll(state, r);
      state.history.unshift({
        color: rollingTurn,
        roll: compactRollText(r),
        openingMove,
        sha256: fair.hash,
        sha256Input: fair.input,
        ...(fair.proof ? { fairDiceProof: fair.proof } : {}),
        at: new Date().toISOString(),
      });
      state.rollToken = `roll:${fair.hash.slice(0, 16)}:${compactRollText(r)}`;
      if (fair.proof) {
        const saved = await publishRemoteState();
        if ((mode === 'bot' && !saved) || fairDiceError) throw new Error('Could not commit verified turn dice.');
      } else publishRemoteState();
      render();
      const boardFaces = boardDiceFaces(r);
      const boardDiceLayer = document.getElementById('board-dice-layer');
      if (boardDiceLayer) boardDiceLayer.dataset.boardDiceCount = String(boardFaces.length);

      Promise.all([
        NarduBoardEngine.animateDiceRoll({
          layer: boardDiceLayer,
          faces: boardFaces,
          color: rollingTurn,
          token: state.rollToken,
          duration: fair.proof?.protocol === 'system-csprng-v1' ? 380 : undefined,
        }),
        trayRollAnimation(),
      ])
        .then(() => finishTurnRollAnimation(rollingTurn))
        .catch(error => finishTurnRollAnimation(rollingTurn, error));
    } catch (error) {
      console.warn('Turn roll failed', error?.message || error);
      await handleFairDiceFailure(error);
      isRolling = false;
      render();
      ensureAutoProgress(800);
    }
  }

  function endTurnUser() {
    if (autoEndTimer) clearTimeout(autoEndTimer);
    autoEndTimer = null;
    undoStack = [];
    clearSelection();
    NarduGame.endTurn(state);
    publishRemoteState();
    afterTurn();
  }

  function afterTurn() {
    render();
    persistRoomSnapshot();
    if (state.winner) { onGameOver(); return; }
    if (mode === 'bot') queueBotAnalysisPublish(120);
    ensureAutoProgress(700);
  }

  /* ── point click — select source or apply move ── */
  function onPointClick(point) {
    if (isAnimating || isRolling || state.phase !== 'move' || !isMyTurn()) return;
    NarduSound.click();

    if (pending) {
      if (pending.from === point) {
        pending = null;
        state.selected = null; state.hints = []; state.fullHints = [];
        render();
        return;
      }
      const action = moveActionForPoint(pending.from, point);
      if (action?.type === 'sequence') {
        const from = pending.from;
        pending = null;
        state.selected = null; state.hints = []; state.fullHints = [];
        doUserMoveSequence(from, action.dest.moves);
        return;
      }
      if (action?.type === 'single') {
        const from = pending.from;
        pending = null;
        state.selected = null; state.hints = []; state.fullHints = [];
        doUserMove(from, action.dest.die, action.dest);
        return;
      }
      pending = null;
      state.selected = null; state.hints = []; state.fullHints = [];
    }

    /* try selecting */
    if (NarduGame.pointColor(state, point) === state.turn) {
      const targets = selectableTargets(point);
      if (targets.dests.length === 0 && targets.fullDests.length === 0) { render(); return; }
      setSelection(point, targets);
    }
    render();
  }

  function selectableTargets(from) {
    const dests = NarduGame.legalDestinations(state, from);
    const fullDests = legalFullDestinations(from);
    return {
      dests,
      fullDests,
      hints: [...new Set([...dests, ...fullDests].map(d => d.to).filter(to => to > 0))],
      fullHints: [...new Set(fullDests.map(d => d.to).filter(to => to > 0))],
    };
  }

  function setSelection(from, targets = selectableTargets(from)) {
    pending = { from };
    state.selected = from;
    state.hints = targets.hints;
    state.fullHints = targets.fullHints;
  }

  function clearSelection() {
    pending = null;
    state.selected = null;
    state.hints = [];
    state.fullHints = [];
  }

  function renderBearTargets() {
    document.querySelectorAll('.bear-track').forEach(track => track.classList.remove('target', 'drag-over'));
    if (state.phase !== 'move' || state.selected === null || !isMyTurn()) return;
    const action = moveActionForPoint(state.selected, 0);
    if (!action) return;
    document.querySelector(`.bear-track.${state.turn}`)?.classList.add('target');
  }

  function renderBearButton() {
    const btn = document.getElementById('bear-btn');
    if (!btn) return;
    const canShow = state.phase === 'move'
      && isMyTurn()
      && (state.turn === 'white' || state.turn === 'dark')
      && NarduGame.homeReady(state, state.turn);
    btn.hidden = !canShow;
    if (!canShow) {
      btn.disabled = true;
      btn.title = tr('bear_locked_title');
      return;
    }

    const action = selectedBearOffAction();
    const canBear = Boolean(action) && !isAnimating && !isRolling && !isChainingMove;
    btn.disabled = !canBear;
    btn.title = canBear
      ? tr('bear_can_title')
      : tr('bear_pick_title');
  }

  function selectedBearOffAction() {
    if (!pending || state.selected === null || pending.from !== state.selected) return null;
    if (NarduGame.pointColor(state, pending.from) !== state.turn) return null;
    const action = moveActionForPoint(pending.from, 0);
    return action ? { from: pending.from, ...action } : null;
  }

  function moveActionForPoint(from, point) {
    return preferredMoveAction(
      legalFullDestinations(from),
      NarduGame.legalDestinations(state, from),
      point,
    );
  }

  function preferredMoveAction(fullDestinations, destinations, point) {
    const single = destinations.find(destination => destination.to === point);
    if (point === 0 && single) return { type: 'single', dest: single };
    const sequence = fullDestinations.find(destination => destination.to === point);
    if (sequence) return { type: 'sequence', dest: sequence };
    if (single) return { type: 'single', dest: single };
    return null;
  }

  function legalFullDestinations(from) {
    if (!state?.dice || state.dice.length < 2) return [];
    const results = [];
    const seen = new Set();
    NarduGame.bestMoveSequences(state, state.turn).forEach(sequence => {
      if (sequence[0]?.from !== from) return;
      const moves = [];
      let currentFrom = from;
      for (const move of sequence) {
        if (move.from !== currentFrom) break;
        moves.push(move);
        if (move.bearOff || move.to === 0) {
          if (moves.length >= 2) addChainDestination(results, seen, moves);
          break;
        }
        currentFrom = move.to;
        if (moves.length >= 2) addChainDestination(results, seen, moves);
      }
    });
    return results;
  }

  function addChainDestination(results, seen, moves) {
    const finalMove = moves[moves.length - 1];
    const to = finalMove.bearOff ? 0 : finalMove.to;
    const key = `${to}:${moves.map(move => move.die).join(':')}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      to,
      bearOff: finalMove.bearOff,
      moves: moves.map(move => ({ ...move })),
    });
  }

  function onBearTrackClick(color) {
    /* clicking the bear track confirms a bear-off when a destination of 0 is legal */
    if (!pending || state.turn !== color) return;
    const action = moveActionForPoint(pending.from, 0);
    if (!action) return;
    const from = pending.from;
    pending = null; state.selected = null; state.hints = []; state.fullHints = [];
    if (action.type === 'sequence') {
      doUserMoveSequence(from, action.dest.moves);
      return;
    }
    doUserMove(from, action.dest.die, action.dest);
  }

  function onBearButtonClick() {
    const action = selectedBearOffAction();
    if (!action) {
      renderBearButton();
      return;
    }
    const from = action.from;
    clearSelection();
    render();
    if (action.type === 'sequence') {
      doUserMoveSequence(from, action.dest.moves);
      return;
    }
    doUserMove(from, action.dest.die, action.dest);
  }

  /* ── drag and drop checker movement ───────── */
  function canStartCheckerDrag(point) {
    if (isAnimating || isRolling || state.phase !== 'move' || !isMyTurn()) return false;
    if (NarduGame.pointColor(state, point) !== state.turn) return false;
    const targets = selectableTargets(point);
    return targets.dests.length > 0 || targets.fullDests.length > 0;
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const pt = e.target.closest('[data-point]');
    const board = pt?.closest('.board');
    if (!pt || !board) return;
    const point = parseInt(pt.dataset.point, 10);
    if (Number.isNaN(point) || !canStartCheckerDrag(point)) return;
    const checker = pt.querySelector('.stack')?.lastElementChild;
    if (!checker) return;

    if (dragState) cleanupDrag();
    removeDragClones();
    e.preventDefault();
    try {
      board.setPointerCapture?.(e.pointerId);
    } catch (err) {}

    dragState = {
      pointerId: e.pointerId,
      captureEl: board,
      from: point,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      sourceClone: checker.cloneNode(true),
      sourceRect: checker.getBoundingClientRect(),
      targets: selectableTargets(point),
      clone: null,
      hiddenChecker: null,
      hoverEl: null,
    };
  }

  function onPointerMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const distance = Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY);
    if (!dragState.active && distance < 7) return;
    if (!dragState.active) startCheckerDrag(e);
    if (!dragState.active) return;
    e.preventDefault();
    moveDragClone(e.clientX, e.clientY);
    updateDragHover(e.clientX, e.clientY);
  }

  function startCheckerDrag(e) {
    dragState.active = true;
    suppressClickUntil = Date.now() + 400;
    setSelection(dragState.from, dragState.targets);
    render();
    removeDragClones();

    const freshChecker = document.querySelector(`[data-point="${dragState.from}"] .stack`)?.lastElementChild;
    const rect = freshChecker?.getBoundingClientRect() || dragState.sourceRect;
    if (freshChecker) {
      freshChecker.style.visibility = 'hidden';
      dragState.hiddenChecker = freshChecker;
    }

    const clone = dragState.sourceClone;
    clone.classList.add('board-drag-checker');
    Object.assign(clone.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: '0',
      zIndex: '10000',
      pointerEvents: 'none',
    });
    document.body.appendChild(clone);
    dragState.clone = clone;
    document.body.classList.add('checker-dragging');
    moveDragClone(e.clientX, e.clientY);
  }

  function moveDragClone(clientX, clientY) {
    if (!dragState?.clone) return;
    const width = dragState.clone.offsetWidth || dragState.sourceRect.width;
    const height = dragState.clone.offsetHeight || dragState.sourceRect.height;
    dragState.clone.style.transform = `translate3d(${clientX - width / 2}px, ${clientY - height / 2}px, 0) scale(1.06)`;
  }

  function updateDragHover(clientX, clientY) {
    if (!dragState) return;
    dragState.hoverEl?.classList.remove('drag-over');
    dragState.hoverEl = null;
    const drop = dropActionAt(dragState.from, clientX, clientY);
    if (drop?.point) {
      const el = document.querySelector(`[data-point="${drop.point}"]`);
      el?.classList.add('drag-over');
      dragState.hoverEl = el;
    } else if (drop?.bear) {
      const el = document.querySelector(`.bear-track.${drop.bear}`);
      el?.classList.add('drag-over');
      dragState.hoverEl = el;
    }
  }

  function onPointerUp(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    if (!dragState.active) {
      const from = dragState.from;
      cleanupDrag();
      suppressClickUntil = Date.now() + 180;
      e.preventDefault();
      onPointClick(from);
      return;
    }
    e.preventDefault();
    suppressClickUntil = Date.now() + 400;

    const from = dragState.from;
    const drop = dropActionAt(from, e.clientX, e.clientY);

    if (!drop) {
      cleanupDrag();
      return;
    }
    const dragClone = cleanupDrag({ restoreHidden: false, removeClone: false });
    clearSelection();
    if (drop.type === 'sequence') {
      doUserMoveSequence(from, drop.dest.moves, { movingChecker: dragClone });
      return;
    }
    doUserMove(from, drop.dest.die, drop.dest, { movingChecker: dragClone });
  }

  function onPointerCancel(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    cleanupDrag();
  }

  function cleanupDrag({ restoreHidden = true, removeClone = true } = {}) {
    const clone = dragState?.clone || null;
    dragState?.hoverEl?.classList.remove('drag-over');
    if (restoreHidden && dragState?.hiddenChecker) dragState.hiddenChecker.style.visibility = '';
    try {
      if (dragState?.captureEl?.hasPointerCapture?.(dragState.pointerId)) {
        dragState.captureEl.releasePointerCapture(dragState.pointerId);
      }
    } catch (err) {}
    if (removeClone) {
      removeDragClones();
    } else {
      removeDragClones(clone);
    }
    document.body.classList.remove('checker-dragging');
    dragState = null;
    return clone;
  }

  function cancelActiveDrag() {
    if (dragState) cleanupDrag();
    else removeDragClones();
  }

  function releaseCommittedDragClone(clone) {
    if (!clone) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => clone.remove());
    });
  }

  function dropActionAt(from, clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const pt = el?.closest?.('[data-point]');
    if (pt && pt.closest('.board')) {
      const point = parseInt(pt.dataset.point, 10);
      if (!Number.isNaN(point)) {
        const action = moveActionForPoint(from, point);
        return action ? { ...action, point } : null;
      }
    }

    const bear = el?.closest?.('.bear-track');
    if (bear) {
      const color = bear.classList.contains('white') ? 'white' : 'dark';
      if (color !== state.turn) return null;
      const action = moveActionForPoint(from, 0);
      return action ? { ...action, bear: color } : null;
    }
    return null;
  }

  function doUserMove(from, die, dest, options = {}) {
    if (options.instant) {
      pushUndoSnapshot();
      const applied = NarduGame.applyMove(state, from, die, { autoEnd: false });
      if (!applied) {
        undoStack.pop();
        render();
        releaseCommittedDragClone(options.dragClone);
        return;
      }
      publishRemoteState();
      playMoveSound(dest);
      render();
      releaseCommittedDragClone(options.dragClone);
      if (state.winner) { onGameOver(); return; }
      maybeScheduleAutoEndTurn();
      return;
    }
    animateMove(from, NarduGame.moveTo(state.turn, from, die, state), () => {
      pushUndoSnapshot();
      const applied = NarduGame.applyMove(state, from, die, { autoEnd: false });
      if (!applied) {
        undoStack.pop();
        render();
        return;
      }
      publishRemoteState();
      playMoveSound(dest);
      render();
      if (state.winner) { onGameOver(); return; }
      maybeScheduleAutoEndTurn();
    }, { movingChecker: options.movingChecker });
  }

  function doUserMoveSequence(from, moves, options = {}) {
    const sequence = moves.map(move => ({ ...move }));
    const finalMove = sequence[sequence.length - 1];
    const finalTo = finalMove?.bearOff ? 0 : finalMove?.to;
    if (!sequence.length || finalTo === undefined) return;
    isChainingMove = true;

    if (options.instant) {
      let currentFrom = from;
      let appliedAll = true;

      for (const move of sequence) {
        if (state.phase !== 'move' || state.winner) {
          appliedAll = false;
          break;
        }
        pushUndoSnapshot();
        const applied = NarduGame.applyMove(state, currentFrom, move.die, { autoEnd: false });
        if (!applied) {
          undoStack.pop();
          appliedAll = false;
          break;
        }
        currentFrom = move.bearOff ? 0 : move.to;
      }

      if (appliedAll) {
        publishRemoteState();
        playMoveSound(finalMove);
      }
      render();
      releaseCommittedDragClone(options.dragClone);
      isChainingMove = false;
      if (!appliedAll || state.winner) {
        if (state.winner) onGameOver();
        return;
      }
      afterUserSequence();
      return;
    }

    if (options.movingChecker) {
      animateMove(from, finalTo, () => {
        let currentFrom = from;
        let appliedAll = true;

        for (const move of sequence) {
          if (state.phase !== 'move' || state.winner) {
            appliedAll = false;
            break;
          }
          pushUndoSnapshot();
          const applied = NarduGame.applyMove(state, currentFrom, move.die, { autoEnd: false });
          if (!applied) {
            undoStack.pop();
            appliedAll = false;
            break;
          }
          currentFrom = move.bearOff ? 0 : move.to;
        }

        if (appliedAll) {
          publishRemoteState();
          playMoveSound(finalMove);
        }
        render();
        isChainingMove = false;
        if (!appliedAll || state.winner) {
          if (state.winner) onGameOver();
          return;
        }
        afterUserSequence();
      }, { movingChecker: options.movingChecker });
      return;
    }

    let index = 0;
    let currentFrom = from;

    function finishSequence(appliedAll) {
      render();
      isChainingMove = false;
      if (!appliedAll || state.winner) {
        if (state.winner) onGameOver();
        return;
      }
      publishRemoteState();
      playMoveSound(finalMove);
      afterUserSequence();
    }

    function stepSequence() {
      if (index >= sequence.length) {
        finishSequence(true);
        return;
      }
      if (state.phase !== 'move' || state.winner) {
        finishSequence(false);
        return;
      }
      const move = sequence[index++];
      const to = move.bearOff ? 0 : move.to;
      animateMove(currentFrom, to, () => {
        pushUndoSnapshot();
        const applied = NarduGame.applyMove(state, currentFrom, move.die, { autoEnd: false });
        if (!applied) {
          undoStack.pop();
          finishSequence(false);
          return;
        }
        currentFrom = move.bearOff ? 0 : move.to;
        render();
        if (state.winner) {
          finishSequence(true);
          return;
        }
        schedule(stepSequence, 60);
      }, { movingChecker: index === 1 ? options.movingChecker : null });
    }

    stepSequence();
  }

  function afterUserSequence() {
    render();
    if (state.winner) { onGameOver(); return; }
    maybeScheduleAutoEndTurn();
  }

  function maybeScheduleAutoEndTurn() {
    if (autoEndTimer) clearTimeout(autoEndTimer);
    autoEndTimer = null;
    if (state.phase !== 'move' || state.winner) return;
    const canFinalizeTurn = isMyTurn() || (mode === 'remote' && !isMyTurn());
    if (!canFinalizeTurn) return;
    if (state.dice.length > 0 && NarduGame.hasAnyMoves(state)) return;

    autoEndTimer = schedule(() => {
      autoEndTimer = null;
      const canFinalizeNow = isMyTurn() || (mode === 'remote' && !isMyTurn());
      if (state.phase !== 'move' || state.winner || !canFinalizeNow) return;
      if (state.dice.length > 0 && NarduGame.hasAnyMoves(state)) return;
      endTurnUser();
    }, isMyTurn() ? 1200 : 1800);
  }

  function pushUndoSnapshot() {
    undoStack.push(cloneStateForUndo(state));
  }

  function cloneStateForUndo(source) {
    return JSON.parse(JSON.stringify({
      ...source,
      selected: null,
      hints: [],
      fullHints: [],
    }));
  }

  function undoLastMove() {
    if (isAnimating || isRolling || state.phase !== 'move' || !isMyTurn() || undoStack.length === 0) return;
    if (autoEndTimer) clearTimeout(autoEndTimer);
    autoEndTimer = null;
    syncTurnClock();
    const currentTurnClock = normalizedTurnClock(state.turnClock);
    const previous = undoStack.pop();
    state = previous;
    state.turnClock = currentTurnClock;
    clearSelection();
    NarduSound.click();
    render();
    publishRemoteState();
  }

  function resignGame() {
    if (botAnalysisRestorePending || !state || state.phase === 'waiting' || state.phase === 'over' || state.winner) return;
    if (isAnimating || isRolling || isChainingMove) return;

    if (autoRollTimer) clearTimeout(autoRollTimer);
    if (autoEndTimer) clearTimeout(autoEndTimer);
    autoRollTimer = null;
    autoEndTimer = null;

    const loser = mode === 'hotseat' && (state.turn === 'white' || state.turn === 'dark')
      ? state.turn
      : playerColor;
    const winner = NarduGame.opponentOf(loser);
    syncTurnClock();
    clearSelection();
    undoStack = [];
    state.dice = [];
    state.rolled = [];
    state.winner = winner;
    state.resultType = null;
    state.phase = 'over';
    state.finishedAt ||= Date.now();
    state.history.unshift({
      resign: true,
      color: loser,
      winnerColor: winner,
      at: new Date().toISOString(),
    });
    render();
    onGameOver();
  }

  function finishGameByPlayerLeave(loser) {
    if (!state || state.phase === 'waiting' || state.phase === 'over' || state.winner) return false;

    if (autoRollTimer) clearTimeout(autoRollTimer);
    if (autoEndTimer) clearTimeout(autoEndTimer);
    autoRollTimer = null;
    autoEndTimer = null;

    const winner = NarduGame.opponentOf(loser);
    syncTurnClock();
    clearSelection();
    undoStack = [];
    state.dice = [];
    state.rolled = [];
    state.winner = winner;
    state.resultType = null;
    state.phase = 'over';
    state.finishedAt ||= Date.now();
    state.history.unshift({
      leave: true,
      color: loser,
      winnerColor: winner,
      at: new Date().toISOString(),
    });
    return true;
  }

  async function concedeRemoteGameByLobbyExit() {
    if (mode !== 'remote' || !state || state.phase === 'waiting' || state.phase === 'over' || state.winner) return false;
    const changed = finishGameByPlayerLeave(playerColor);
    if (!changed) return false;
    render();
    return ensureRemoteFinalStatePublished();
  }

  /* ── bot ─────────────────────────────────── */
  function pauseNeuralBot(error) {
    botPlannerError = lang() === 'en'
      ? 'Neural bot unavailable. Refresh the page. The game is paused without replacing the bot.'
      : 'Нейробот недоступен. Обновите страницу. Игра приостановлена без замены бота.';
    if (variant !== 'long' || state?.variant !== 'long') {
      botPlannerError = lang() === 'en'
        ? 'Hard neural bot supports long narde only. Return to the lobby.'
        : 'Сложный бот-нейро доступен только в длинных нардах. Вернитесь в лобби.';
    }
    console.warn('Neural bot paused', error?.message || error);
    const decision = activeNeuralDecision();
    if (decision) decision.execution.error = String(error?.message || error || 'planner-failed').slice(0, 240);
    if (autoRollTimer) clearTimeout(autoRollTimer);
    if (autoEndTimer) clearTimeout(autoEndTimer);
    autoRollTimer = null;
    autoEndTimer = null;
  }

  function validateNeuralBotAvailability() {
    if (mode !== 'bot' || botDifficulty !== 'hard-neuro') return true;
    try {
      if (variant !== 'long' || state?.variant !== 'long') throw new Error('Unsupported short-neuro room');
      if (!window.NarduNeuralBot?.getModelMetadata) throw new Error('Neural model assets missing');
      state.analysis ||= {};
      state.analysis.neuralModel = { ...window.NarduNeuralBot.getModelMetadata() };
      botPlannerError = '';
      return true;
    } catch (error) {
      pauseNeuralBot(error);
      return false;
    }
  }

  function activeNeuralDecision() {
    if (botDifficulty !== 'hard-neuro') return null;
    return state?.analysis?.neuralDecisions?.find(item => item.id === activeNeuralDecisionId) || null;
  }

  function rememberNeuralDecision(planned, diagnostics) {
    state.analysis ||= {};
    const before = JSON.parse(JSON.stringify({
      variant: state.variant, points: state.points, bar: state.bar, off: state.off,
      phase: state.phase, turn: state.turn, winner: state.winner, dice: state.dice,
      rolled: state.rolled, firstMoveDone: state.firstMoveDone,
      headPlayedThisTurn: state.headPlayedThisTurn,
      turnMoves: state.turnMoves,
    }));
    const rows = Array.isArray(state.analysis.neuralDecisions) ? state.analysis.neuralDecisions : [];
    activeNeuralDecisionId = `nn-${state.startedAt}-${++neuralDecisionSerial}-${Date.now()}`;
    rows.push({ schema: 'nardu-neural-decision-v1', id: activeNeuralDecisionId,
      at: new Date().toISOString(), diagnostics: { ...diagnostics }, before,
      selected: planned.map(move => ({ from: move.from, die: move.die })),
      execution: { complete: false, executedMoves: [] },
    });
    state.analysis.neuralDecisions = rows.slice(-BOT_MEMORY_MAX_DECISIONS);
    state.analysis.neuralModel = { ...window.NarduNeuralBot.getModelMetadata() };
  }

  function recordNeuralExecution(move, to) {
    const decision = activeNeuralDecision();
    if (!decision) return;
    if (move) decision.execution.executedMoves.push({ from: move.from, die: move.die, to, bearOff: to === 0 });
    else {
      decision.execution.complete = true;
      decision.execution.completedAt = new Date().toISOString();
      decision.execution.after = JSON.parse(JSON.stringify({ points: state.points, bar: state.bar,
        off: state.off, turn: state.turn, phase: state.phase, winner: state.winner,
        dice: state.dice, rolled: state.rolled, firstMoveDone: state.firstMoveDone,
        headPlayedThisTurn: state.headPlayedThisTurn, turnMoves: state.turnMoves }));
    }
  }

  function botDecisionPositionId(source = state) {
    const color = source?.turn || '';
    const points = Object.entries(source?.points || {})
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([point, stack]) => `${point}:${String(stack?.color || '')[0] || '-'}${Number(stack?.count) || 0}`)
      .join(',');
    const fingerprintSource = `${color}|${(source?.dice || []).join(',')}|${points}|${source?.off?.white || 0}:${source?.off?.dark || 0}`;
    let hash = 2166136261;
    for (let index = 0; index < fingerprintSource.length; index += 1) {
      hash ^= fingerprintSource.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `lb4-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function fallbackDecisionMoves(source, planned) {
    const preview = JSON.parse(JSON.stringify(source));
    return (Array.isArray(planned) ? planned : []).map(move => {
      const from = Number(move?.from);
      const die = Number(move?.die);
      const to = Number(NarduGame.moveTo(preview.turn, from, die, preview)) || 0;
      const recorded = { from, to, die, bearOff: to === 0 };
      NarduGame.applyMove(preview, from, die, { autoEnd: false });
      return recorded;
    });
  }

  function createFallbackBotDecision(source, planned, reason) {
    if (
      mode !== 'bot'
      || botDifficulty !== 'hard'
      || variant !== 'long'
      || !source
      || !Array.isArray(planned)
      || !planned.length
    ) return null;
    const positionId = botDecisionPositionId(source);
    fallbackBotDecisionSerial += 1;
    return {
      id: `${positionId}-controller-fallback-${Date.now().toString(36)}-${String(fallbackBotDecisionSerial).padStart(4, '0')}`,
      positionId,
      source: 'fallback',
      fallbackReason: String(reason || 'controller-fallback'),
      fallback: {
        reason: String(reason || 'controller-fallback'),
        positionId,
      },
      at: new Date().toISOString(),
      engineVersion: window.NarduLongBotEngine?.version || 'long-fallback',
      color: source.turn,
      dice: [...(source.dice || [])],
      choiceCount: 1,
      experienceSize: Number(window.NarduLongBotEngine?.experienceSize?.()) || 0,
      position: {
        points: JSON.parse(JSON.stringify(source.points || {})),
        off: { white: Number(source.off?.white) || 0, dark: Number(source.off?.dark) || 0 },
      },
      selected: {
        score: null,
        moves: fallbackDecisionMoves(source, planned),
        features: { fallback: 1, fallbackReason: String(reason || 'controller-fallback') },
        tactical: null,
        experience: null,
        experienceAdjustment: 0,
      },
      alternatives: [],
      experience: null,
    };
  }

  function fallbackBotPlan(reason = 'controller-fallback') {
    if (botDifficulty === 'hard-neuro') throw new Error('Neural bot fallback is forbidden');
    try {
      const planned = (NarduGame.chooseBotSequence?.(state, state.turn, { difficulty: botDifficulty }) || [])
        .map(move => ({ from: move.from, die: move.die }));
      rememberBotDecision(createFallbackBotDecision(state, planned, reason));
      return planned;
    } catch (error) {
      console.warn('Fallback bot plan failed', error?.message || error);
      return [];
    }
  }

  function safeBotPlan() {
    if (botDifficulty === 'hard-neuro') {
      if (!validateNeuralBotAvailability()) throw new Error(botPlannerError);
      const planned = NarduBot.plan(state, { difficulty: botDifficulty });
      if (!Array.isArray(planned)) throw new Error('Invalid neural plan');
      // Validate the complete maximum-use legal turn, including genuine passes.
      const legal = NarduGame.bestMoveSequences(state, state.turn);
      const key = moves => JSON.stringify(moves.map(({ from, die }) => ({ from, die })));
      if (!legal.some(moves => key(moves) === key(planned))) throw new Error('Illegal or incomplete neural plan');
      const decision = window.NarduNeuralBot.consumeLastDecision();
      if (!decision || decision.difficulty !== 'hard-neuro') throw new Error('Neural diagnostics missing');
      rememberNeuralDecision(planned, decision);
      return planned.map(({ from, die }) => ({ from, die }));
    }
    const engine = variant === 'short' ? window.NarduShortBotEngine : window.NarduLongBotEngine;
    if (variant === 'long' && botDifficulty === 'hard') {
      engine?.consumeLastDecision?.();
      window.NarduStrongBot?.consumeLastFallbackDecision?.();
    }
    try {
      const planned = NarduBot.plan(state, { difficulty: botDifficulty });
      if (Array.isArray(planned)) {
        const engineDecision = engine?.consumeLastDecision?.();
        const fallbackDecision = variant === 'long'
          ? window.NarduStrongBot?.consumeLastFallbackDecision?.()
          : null;
        rememberBotDecision(
          engineDecision
          || fallbackDecision
          || createFallbackBotDecision(state, planned, 'planner-returned-without-decision'),
        );
        return planned.map(move => ({ from: move.from, die: move.die }));
      }
    } catch (error) {
      console.warn('Bot plan failed, using fallback', error?.message || error);
      engine?.consumeLastDecision?.();
      window.NarduStrongBot?.consumeLastFallbackDecision?.();
      return fallbackBotPlan('planner-exception');
    }
    return fallbackBotPlan('planner-invalid-result');
  }

  function botTurnStateKey(source = state) {
    const points = Object.entries(source?.points || {})
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([point, stack]) => `${point}:${stack?.color || '-'}:${Number(stack?.count) || 0}`)
      .join('|');
    return [
      source?.phase || '',
      source?.turn || '',
      source?.winner || '',
      Array.isArray(source?.dice) ? source.dice.join(',') : '',
      Number(source?.bar?.white) || 0,
      Number(source?.bar?.dark) || 0,
      Number(source?.off?.white) || 0,
      Number(source?.off?.dark) || 0,
      source?.rollToken || '',
      points,
    ].join(';');
  }

  function cancelBotTurnActivity() {
    botTurnGeneration += 1;
    botTurnActive = false;
    botTurnPlanPromise = null;
    activeBotDecisionId = '';
    activeNeuralDecisionId = '';
  }

  function releaseBotTurnActivity(generation) {
    if (generation !== botTurnGeneration) return false;
    botTurnActive = false;
    botTurnPlanPromise = null;
    return true;
  }

  function normalizedBotMoves(planned, engine) {
    if (!Array.isArray(planned)) return [];
    rememberBotDecision(engine?.consumeLastDecision?.());
    return planned.map(move => ({ from: move.from, die: move.die }));
  }

  async function resolveBotTurnPlan(sourceState, generation, stateKey) {
    const current = () => (
      generation === botTurnGeneration &&
      state === sourceState &&
      botTurnStateKey(sourceState) === stateKey &&
      sourceState.phase === 'move' &&
      !sourceState.winner
    );
    const engine = window.NarduShortBotEngine;
    const client = window.NarduShortBotWildbg;
    if (
      variant !== 'short' ||
      botDifficulty !== 'hard' ||
      typeof client?.plan !== 'function'
    ) {
      return { stale: !current(), moves: current() ? safeBotPlan() : [] };
    }

    const result = await client.plan({
      engine,
      state: sourceState,
      isCurrent: current,
      fallback: safeBotPlan,
      timeoutMs: WILDBG_ANALYSIS_TIMEOUT_MS,
    });
    if (result?.stale || !current()) return { stale: true, moves: [] };
    if (result?.fallback) return { stale: false, moves: result.planned || [] };
    return { stale: false, moves: normalizedBotMoves(result?.planned, engine) };
  }

  function compactBotExecutionBoard(source = state) {
    return {
      points: Object.fromEntries(
        Object.entries(source?.points || {})
          .filter(([, stack]) => stack && Number(stack.count) > 0)
          .sort(([left], [right]) => Number(left) - Number(right))
          .map(([point, stack]) => [point, {
            color: String(stack.color || ''),
            count: Number(stack.count) || 0,
          }]),
      ),
      bar: {
        white: Number(source?.bar?.white) || 0,
        dark: Number(source?.bar?.dark) || 0,
      },
      off: {
        white: Number(source?.off?.white) || 0,
        dark: Number(source?.off?.dark) || 0,
      },
    };
  }

  function botExecutionBoardKey(board) {
    const points = Object.entries(board?.points || {})
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([point, stack]) => `${point}:${String(stack?.color || '')}:${Number(stack?.count) || 0}`)
      .join('|');
    return `${points}|bar:${Number(board?.bar?.white) || 0}:${Number(board?.bar?.dark) || 0}|off:${Number(board?.off?.white) || 0}:${Number(board?.off?.dark) || 0}`;
  }

  function canonicalBotExecutionMoves(moves = []) {
    return (Array.isArray(moves) ? moves : []).map(move => ({
      from: Number(move?.from) || 0,
      to: move?.bearOff || Number(move?.to) === 0 ? 0 : Number(move?.to) || 0,
      die: Number(move?.die) || 0,
      bearOff: Boolean(move?.bearOff || Number(move?.to) === 0),
    }));
  }

  function initialBotDecisionExecution(decision) {
    const current = decision?.execution && typeof decision.execution === 'object'
      ? decision.execution
      : {};
    const moves = canonicalBotExecutionMoves(current.executedMoves || current.moves || []);
    return {
      ...current,
      complete: current.complete === true,
      fallback: current.fallback === true || decision?.source !== 'engine',
      substituted: current.substituted === true
        || (Array.isArray(current.substitutions) && current.substitutions.length > 0),
      selectedMoveCount: Array.isArray(decision?.selected?.moves)
        ? decision.selected.moves.length
        : 0,
      appliedMoveCount: moves.length,
      executedMoves: moves,
      startedAt: current.startedAt || new Date().toISOString(),
    };
  }

  function activeBotDecision() {
    const memory = state?.analysis?.botMemory;
    const decisions = Array.isArray(memory?.decisions) ? memory.decisions : [];
    return decisions.find(item => item?.id === activeBotDecisionId) || null;
  }

  function updateActiveBotDecisionExecution(update) {
    const decision = activeBotDecision();
    if (!decision) return null;
    const execution = initialBotDecisionExecution(decision);
    decision.execution = typeof update === 'function'
      ? update(execution, decision)
      : { ...execution, ...(update || {}) };
    if (state?.analysis?.botMemory) {
      state.analysis.botMemory.updatedAt = new Date().toISOString();
    }
    return decision;
  }

  function recordBotMoveApplied(actual, to, moveIndex) {
    if (mode !== 'bot' || botDifficulty !== 'hard' || variant !== 'long' || !actual) return null;
    return updateActiveBotDecisionExecution(execution => {
      const moves = canonicalBotExecutionMoves(execution.executedMoves);
      const index = Math.max(0, Number(moveIndex) || 0);
      moves[index] = {
        from: Number(actual.from),
        to: Number(to) || 0,
        die: Number(actual.die),
        bearOff: Number(to) === 0,
      };
      return {
        ...execution,
        complete: false,
        appliedMoveCount: moves.filter(Boolean).length,
        executedMoves: moves,
        lastAppliedAt: new Date().toISOString(),
      };
    });
  }

  function recordBotExecutionFailure(reason) {
    return updateActiveBotDecisionExecution(execution => ({
      ...execution,
      fallback: true,
      reason: String(reason || 'execution-failed'),
    }));
  }

  function completeBotDecisionExecution(reason = 'planned-sequence-complete') {
    if (mode !== 'bot' || botDifficulty !== 'hard' || variant !== 'long') return null;
    return updateActiveBotDecisionExecution((execution, decision) => {
      const executedMoves = canonicalBotExecutionMoves(execution.executedMoves);
      const selectedMoves = canonicalBotExecutionMoves(decision?.selected?.moves);
      const after = compactBotExecutionBoard(state);
      const selectedAfter = decision?.selected?.after;
      const actionMatches = JSON.stringify(selectedMoves) === JSON.stringify(executedMoves);
      const positionMatches = selectedAfter
        ? botExecutionBoardKey(selectedAfter) === botExecutionBoardKey(after)
        : null;
      const selectedExperience = decision?.selected?.experience || decision?.experience;
      const selectedActionKey = String(selectedExperience?.actionKey || '');
      const executedActionKey = actionMatches && positionMatches === true
        ? selectedActionKey
        : '';
      return {
        ...execution,
        complete: true,
        reason: execution.reason || String(reason || 'planned-sequence-complete'),
        substituted: execution.substituted === true
          || (Array.isArray(execution.substitutions) && execution.substitutions.length > 0),
        appliedMoveCount: executedMoves.length,
        executedMoves,
        after,
        selectedActionMatches: actionMatches,
        selectedPositionMatches: positionMatches,
        selectedMatchesExecuted: actionMatches && positionMatches === true && Boolean(executedActionKey),
        executedActionKey,
        executed: {
          moves: executedMoves,
          after,
          ...(executedActionKey ? {
            experience: {
              contextKey: String(selectedExperience?.contextKey || ''),
              actionKey: executedActionKey,
            },
          } : {}),
        },
        completedAt: new Date().toISOString(),
      };
    });
  }

  function rememberBotDecision(decision) {
    if (!decision || mode !== 'bot' || botDifficulty !== 'hard') return null;
    state.analysis ||= {};
    const memory = state.analysis.botMemory && typeof state.analysis.botMemory === 'object'
      ? state.analysis.botMemory
      : {};
    const decisions = Array.isArray(memory.decisions) ? memory.decisions : [];
    const existing = decisions.find(item => item?.id === decision.id);
    activeBotDecisionId = decision.id || '';
    if (existing) return existing;
    if (variant === 'long') decision.execution = initialBotDecisionExecution(decision);
    decisions.push(decision);
    if (decisions.length > BOT_MEMORY_MAX_DECISIONS) {
      decisions.splice(0, decisions.length - BOT_MEMORY_MAX_DECISIONS);
    }
    state.analysis.botMemory = {
      ...memory,
      format: 1,
      engineVersion: decision.engineVersion || memory.engineVersion || '',
      decisions,
      updatedAt: decision.at || new Date().toISOString(),
    };
    return decision;
  }

  function recordBotMoveSubstitution(planned, actual, moveIndex) {
    if (mode !== 'bot' || botDifficulty !== 'hard' || variant !== 'long' || !actual) return;
    state.analysis ||= {};
    const memory = state.analysis.botMemory && typeof state.analysis.botMemory === 'object'
      ? state.analysis.botMemory
      : {};
    const decisions = Array.isArray(memory.decisions) ? memory.decisions : [];
    let decision = decisions.find(item => item?.id === activeBotDecisionId) || null;
    if (!decision) {
      decision = createFallbackBotDecision(state, [actual], 'invalid-planned-move');
      if (!decision) return;
      rememberBotDecision(decision);
    }
    const actualTo = Number(NarduGame.moveTo(state.turn, actual.from, actual.die, state)) || 0;
    const positionId = decision.positionId || botDecisionPositionId(state);
    const substitution = {
      index: Math.max(0, Number(moveIndex) || 0),
      planned: planned ? { from: Number(planned.from), die: Number(planned.die) } : null,
      actual: {
        from: Number(actual.from),
        to: actualTo,
        die: Number(actual.die),
        bearOff: actualTo === 0,
      },
      at: new Date().toISOString(),
    };
    const substitutions = Array.isArray(decision.execution?.substitutions)
      ? decision.execution.substitutions
      : [];
    substitutions.push(substitution);
    decision.execution = {
      ...initialBotDecisionExecution(decision),
      fallback: true,
      substituted: true,
      reason: 'invalid-planned-move',
      positionId,
      substitutions,
    };
    memory.updatedAt = substitution.at;
    state.analysis.botMemory = { ...memory, decisions };
  }

  function finalizeBotMemory() {
    if (mode !== 'bot' || botDifficulty !== 'hard' || !state?.winner) return;
    state.analysis ||= {};
    const memory = state.analysis.botMemory && typeof state.analysis.botMemory === 'object'
      ? state.analysis.botMemory
      : {};
    const decisions = Array.isArray(memory.decisions) ? [...memory.decisions] : [];
    const botColor = NarduGame.opponentOf(playerColor);
    const decisionPositionId = (decision) => {
      if (decision?.positionId) return String(decision.positionId);
      const match = String(decision?.id || '').match(/^(lb4-[0-9a-f]{8})/i);
      return match ? match[1].toLowerCase() : '';
    };
    const positionOccurrences = (items) => {
      const counts = new Map();
      items.forEach((item) => {
        const positionId = typeof item === 'string' ? item : decisionPositionId(item);
        if (!positionId) return;
        counts.set(positionId, (counts.get(positionId) || 0) + 1);
      });
      return counts;
    };
    const consumePositionOccurrence = (counts, positionId) => {
      const remaining = Number(counts.get(positionId)) || 0;
      if (remaining <= 0) return false;
      if (remaining === 1) counts.delete(positionId);
      else counts.set(positionId, remaining - 1);
      return true;
    };
    let coverage;
    let expectedBotPositionIds = [];
    if (variant === 'long') {
      const recovery = window.NarduStrongBot?.recoverBotDecisions
        ? window.NarduStrongBot.recoverBotDecisions(state, botColor)
        : {
          available: false,
          expectedBotDecisions: 0,
          positions: [],
          turns: [],
          decisions: [],
        };
      const expectedPositions = Array.isArray(recovery?.positions)
        ? recovery.positions.map(String)
        : [];
      expectedBotPositionIds = expectedPositions;
      const recordedOccurrences = positionOccurrences(
        decisions
          .filter(decision => decision?.actor !== 'opponent' && decision?.source !== 'history-recovery'),
      );
      const recoveredOccurrences = positionOccurrences(
        decisions
          .filter(decision => decision?.actor !== 'opponent' && decision?.source === 'history-recovery'),
      );
      const recoveryDecisions = Array.isArray(recovery?.decisions) ? recovery.decisions : [];
      const decisionsByPosition = new Map();
      recoveryDecisions.forEach((decision) => {
        const positionId = decisionPositionId(decision);
        if (!positionId) return;
        if (!decisionsByPosition.has(positionId)) decisionsByPosition.set(positionId, []);
        decisionsByPosition.get(positionId).push(decision);
      });
      const recoveryTurns = Array.isArray(recovery?.turns) && recovery.turns.length
        ? recovery.turns
        : expectedPositions.map(positionId => ({
          positionId,
          decision: decisionsByPosition.get(positionId)?.shift() || null,
        }));
      let recordedBotDecisions = 0;
      let recoveredBotDecisions = 0;
      recoveryTurns.forEach((turn) => {
        const positionId = String(turn?.positionId || '');
        if (!positionId) return;
        if (consumePositionOccurrence(recordedOccurrences, positionId)) {
          recordedBotDecisions += 1;
          return;
        }
        if (consumePositionOccurrence(recoveredOccurrences, positionId)) {
          recoveredBotDecisions += 1;
          return;
        }
        const decision = turn?.decision;
        if (!decision || decisionPositionId(decision) !== positionId) return;
        decisions.push(decision);
        recoveredBotDecisions += 1;
      });
      const expectedBotDecisions = Math.max(
        Number(recovery?.expectedBotDecisions) || 0,
        expectedPositions.length,
      );
      coverage = {
        expectedBotDecisions,
        recordedBotDecisions,
        recoveredBotDecisions,
        complete: recovery?.available === true
          && recordedBotDecisions + recoveredBotDecisions === expectedBotDecisions,
        checkedAt: new Date().toISOString(),
      };
    } else {
      const recordedBotDecisions = decisions
        .filter(decision => decision?.actor !== 'opponent').length;
      coverage = {
        expectedBotDecisions: recordedBotDecisions,
        recordedBotDecisions,
        recoveredBotDecisions: 0,
        complete: true,
        checkedAt: new Date().toISOString(),
      };
    }
    const opponentDecisions = window.NarduStrongBot?.captureOpponentDecisions
      ? window.NarduStrongBot.captureOpponentDecisions(state, botColor)
      : [];
    opponentDecisions.forEach((decision) => {
      if (decision?.id && !decisions.some(existing => existing?.id === decision.id)) {
        decisions.push(decision);
      }
    });
    if (decisions.length > BOT_MEMORY_MAX_DECISIONS) {
      while (decisions.length > BOT_MEMORY_MAX_DECISIONS) {
        const opponentIndex = decisions.findIndex(decision => decision?.actor === 'opponent');
        decisions.splice(opponentIndex >= 0 ? opponentIndex : 0, 1);
      }
    }
    if (variant === 'long' && coverage.complete) {
      const retainedOccurrences = positionOccurrences(
        decisions
          .filter(decision => decision?.actor !== 'opponent'),
      );
      coverage.complete = expectedBotPositionIds.every(
        positionId => consumePositionOccurrence(retainedOccurrences, positionId),
      );
    }
    state.analysis.botMemory = {
      ...memory,
      format: 2,
      decisions,
      coverage,
      outcome: {
        winner: state.winner,
        botColor,
        resultType: state.resultType || 'normal',
        score: { ...(state.score || {}) },
        finishedAt: state.finishedAt
          ? new Date(state.finishedAt).toISOString()
          : new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  function archiveBotTrainingGame(finalPayload = null, options = {}) {
    if (botAnalysisOwnershipUnknown) return Promise.resolve(false);
    if (botTrainingArchivePending || botTrainingArchiveDone || !remoteCode || !window.NarduRooms?.archiveBotTrainingGame) {
      return botTrainingArchivePromise;
    }
    botTrainingArchivePending = true;
    const payload = finalPayload || botAnalysisPayload();
    botTrainingArchivePromise = (async () => {
      // Guest games can be archived only after the authoritative room snapshot
      // contains the same finished decision log. The atomic finalizer and its
      // legacy fallback call this with finalStateReady after that write settles.
      if (window.NarduApp?.getUser?.()?.guest === true && !options.finalStateReady) {
        await Promise.resolve(botGameFinalizePromise).catch(() => false);
      }
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const expectedDecisions = payload?.analysis?.botMemory?.decisions?.length || 0;
          if (!expectedDecisions) throw new Error('Bot training payload contains no decisions.');
          const coverage = payload?.analysis?.botMemory?.coverage;
          if (
            payload?.variant === 'long'
            && (
              coverage?.complete !== true
              || Number(coverage?.expectedBotDecisions) !== (
                Number(coverage?.recordedBotDecisions)
                + Number(coverage?.recoveredBotDecisions)
              )
            )
          ) {
            throw new Error('Bot training payload has incomplete decision coverage.');
          }
          const archived = await promiseWithTimeout(
            window.NarduRooms.archiveBotTrainingGame(remoteCode, payload),
            BOT_ANALYSIS_WRITE_TIMEOUT_MS,
            'Bot training archive timed out',
          );
          if (Number(archived?.decisionCount) !== expectedDecisions) {
            throw new Error(`Bot training archive saved ${archived?.decisionCount || 0}/${expectedDecisions} decisions.`);
          }
          botTrainingArchiveDone = true;
          return true;
        } catch (error) {
          lastError = error;
          await wait(500 * attempt);
        }
      }
      console.warn('Could not archive bot training game', lastError?.message || lastError);
      return false;
    })()
      .finally(() => {
        botTrainingArchivePending = false;
      });
    return botTrainingArchivePromise;
  }

  function nextLegalBotMove() {
    try {
      return NarduGame.legalNextMoves(state)
        .find(move => NarduGame.isValidMove(state, move.from, move.die));
    } catch {
      return null;
    }
  }

  function playBotTurn() {
    if (
      fairDiceError ||
      (typeof botPlannerError !== 'undefined' && botPlannerError) ||
      botAnalysisRestorePending ||
      !state ||
      state.phase !== 'move' ||
      state.winner ||
      isRolling ||
      isAnimating ||
      isChainingMove ||
      botTurnActive
    ) return;
    NarduSound.prime();
    undoStack = [];
    botTurnActive = true;
    activeBotDecisionId = '';
    activeNeuralDecisionId = '';
    const generation = ++botTurnGeneration;
    const sourceState = state;
    const stateKey = botTurnStateKey(sourceState);

    botTurnPlanPromise = resolveBotTurnPlan(sourceState, generation, stateKey)
      .then(({ stale, moves }) => {
        if (stale || generation !== botTurnGeneration || state !== sourceState) {
          if (releaseBotTurnActivity(generation)) ensureAutoProgress(250);
          return;
        }
        if (moves.length === 0) {
          NarduGame.endTurn(state);
          if (botDifficulty === 'hard-neuro') recordNeuralExecution();
          releaseBotTurnActivity(generation);
          afterTurn();
          return;
        }
        let i = 0;
        function step() {
          if (generation !== botTurnGeneration || state !== sourceState) {
            releaseBotTurnActivity(generation);
            return;
          }
          if (i >= moves.length) {
            if (botDifficulty === 'hard-neuro') recordNeuralExecution();
            completeBotDecisionExecution();
            releaseBotTurnActivity(generation);
            if (state.winner) onGameOver();
            else afterTurn();
            return;
          }
          let m = moves[i++];
          if (!NarduGame.isValidMove(state, m.from, m.die)) {
            if (botDifficulty === 'hard-neuro') {
              pauseNeuralBot(new Error('Neural planned move rejected; substitution forbidden'));
              releaseBotTurnActivity(generation);
              render();
              return;
            }
            const plannedMove = { ...m };
            m = nextLegalBotMove();
            if (!m) {
              recordBotExecutionFailure('invalid-planned-move-without-substitute');
              NarduGame.endTurn(state);
              completeBotDecisionExecution('execution-ended-without-substitute');
              releaseBotTurnActivity(generation);
              afterTurn();
              return;
            }
            recordBotMoveSubstitution(plannedMove, m, i - 1);
          }
          const to = NarduGame.moveTo(state.turn, m.from, m.die, state);
          animateMove(m.from, to, () => {
            if (generation !== botTurnGeneration || state !== sourceState) {
              releaseBotTurnActivity(generation);
              return;
            }
            const applied = NarduGame.applyMove(state, m.from, m.die);
            if (!applied) {
              if (botDifficulty === 'hard-neuro') {
                pauseNeuralBot(new Error('Neural move application rejected'));
                releaseBotTurnActivity(generation);
                render();
                return;
              }
              recordBotExecutionFailure('apply-move-rejected');
              completeBotDecisionExecution('execution-apply-rejected');
              releaseBotTurnActivity(generation);
              render();
              if (state.winner) onGameOver();
              else afterTurn();
              return;
            }
            recordBotMoveApplied(m, to, i - 1);
            if (botDifficulty === 'hard-neuro') recordNeuralExecution(m, to);
            playMoveSound(m);
            render();
            persistRoomSnapshot();
            if (state.winner) {
              if (botDifficulty === 'hard-neuro') recordNeuralExecution();
              completeBotDecisionExecution('game-ended-during-sequence');
              releaseBotTurnActivity(generation);
              onGameOver();
              return;
            }
            schedule(step, 380);
          });
        }
        step();
      })
      .catch(error => {
        console.warn('Bot planning failed', error?.message || error);
        if (botDifficulty === 'hard-neuro') {
          if (generation !== botTurnGeneration || state !== sourceState) return;
          pauseNeuralBot(error);
          releaseBotTurnActivity(generation);
          render();
          return;
        }
        if (releaseBotTurnActivity(generation)) ensureAutoProgress(350);
      });
  }

  /* ── animation: clone a flying checker from source to destination ── */
  function animateMove(from, to, done, options = {}) {
    isAnimating = true;
    NarduBoardEngine.animateCheckerMove({
      from,
      to,
      color: state.turn,
      destinationCount: to === 0 ? 0 : NarduGame.pointCount(state, to),
      movingChecker: options.movingChecker,
    }).then(() => {
      isAnimating = false;
      done();
    }).catch(error => {
      console.warn('Checker animation failed', error?.message || error);
      isAnimating = false;
      done();
    });
  }

  function moveSoundKind(move) {
    const to = move?.bearOff ? 0 : move?.to;
    return to === 0 || to === 'снято' ? 'bearOff' : 'move';
  }

  function moveSoundSettleMs(kind) {
    return kind === 'bearOff' ? BEAR_OFF_SOUND_SETTLE_MS : MOVE_SOUND_SETTLE_MS;
  }

  function markGameplaySound(kind, delayMs = 0) {
    gameplaySoundBusyUntil = Math.max(
      gameplaySoundBusyUntil,
      Date.now() + delayMs + moveSoundSettleMs(kind),
    );
  }

  function playMoveSound(move) {
    NarduSound.prime();
    const kind = moveSoundKind(move);
    markGameplaySound(kind);
    (kind === 'bearOff' ? NarduSound.bearOff : NarduSound.move)();
  }

  function recordMatchGame() {
    if (!state?.winner) return;
    syncTurnClock();
    state.finishedAt ||= Date.now();
    const matchScore = normalizedMatchScore(state.matchScore);
    if (matchScore.recordedWinner !== state.winner) {
      matchScore[state.winner] = (matchScore[state.winner] || 0) + 1;
      matchScore.recordedWinner = state.winner;
      state.matchScore = matchScore;
    }
  }

  /* ── game over screen + rating update ─────── */
  function onGameOver() {
    if (!state?.winner) return;
    let resultKey = gameResultKey();
    const safeStep = (label, fn, fallback = null) => {
      try {
        return fn();
      } catch (error) {
        console.warn(`${label} failed`, error?.message || error);
        return fallback;
      }
    };

    try {
      safeStep('Record match game', recordMatchGame);
      resultKey = gameResultKey();
      safeStep('Finalize bot memory', finalizeBotMemory);
      safeStep('Render player stats', renderPlayerStats);

      let botPublishPromise = botAnalysisPublishQueue;
      let botFinalPayload = null;
      if (mode === 'remote' && !state.gameOverPublishedAt) {
        ensureRemoteFinalStatePublished();
      }
      if (mode === 'bot') {
        botFinalPayload = safeStep('Build bot training payload', botTrainingStatePayload, null);
        botPublishPromise = ensureBotFinalStatePublished(botFinalPayload);
      }
      if (mode === 'bot') {
        botGameFinalizePromise = Promise.resolve(botPublishPromise).then(
          persisted => Promise.resolve(botTrainingArchivePromise)
            .catch(() => false)
            .then(() => persisted),
          () => false,
        );
      }
      if (
        mode === 'bot' &&
        botDifficulty === 'hard' &&
        window.NarduStrongBot?.learnFromGame &&
        botLearningRecordedKey !== resultKey
      ) {
        botLearningRecordedKey = resultKey;
        safeStep('Hard bot learning', () => window.NarduStrongBot.learnFromGame(state, NarduGame.opponentOf(playerColor)));
      }

      const didWin = state.winner === playerColor;
      const recordRating = () => {
        if (localRatingRecordedKey === resultKey || resultKey !== gameResultKey()) return;
        const r = safeStep('Record local rating', () => NarduRating.record(opponentName, opponentRating, didWin, mode, resultKey, {
          resultType: state.resultType || '',
          winner: state.winner,
          score: {
            ...state.score,
            roomCode: remoteCode || state.roomCode || '',
            off: { ...state.off },
            finalState: {
              ...remoteStatePayload(),
              history: undefined,
            },
          },
          history: Array.isArray(state.history) ? state.history.map(item => ({ ...item })) : [],
          finishedAt: state.finishedAt ? new Date(state.finishedAt).toISOString() : new Date().toISOString(),
        }));
        if (r) {
          lastRatingResult = { delta: r.delta || 0, rating: r.rating ?? null, key: resultKey };
          localRatingRecordedKey = resultKey;
          ratingRetryKey = null;
          ratingRetryCount = 0;
        }
        if (r?.syncPromise) {
          const ratingSyncPromise = Promise.resolve(r.syncPromise)
            .then(authoritative => {
              if (!authoritative || resultKey !== gameResultKey()) return authoritative;
              lastRatingResult = {
                delta: Number(authoritative.delta ?? r.delta ?? 0),
                rating: authoritative.rating ?? r.rating ?? null,
                key: resultKey,
              };
              renderGameOverModal();
              return authoritative;
            });
          // Rating is recoverable and must never keep the player trapped in the
          // finished-game modal after the room state itself has been saved.
          ratingSyncPromise.catch(() => null);
        } else if (!r && !NarduApp.getUser()?.guest) {
          if (ratingRetryKey !== resultKey) {
            ratingRetryKey = resultKey;
            ratingRetryCount = 0;
          }
          if (ratingRetryCount < 3) {
            ratingRetryCount += 1;
            schedule(() => {
              if (state?.winner && localRatingRecordedKey !== resultKey) onGameOver();
            }, 500 * ratingRetryCount);
          }
        }
      };
      if (mode === 'remote') {
        recordRating();
      } else if (mode === 'bot' && botRatingPersistenceKey !== resultKey) {
        // record_rating_result can also finalize a bot room. Do not invoke it
        // until this exact room code has been restored or created safely.
        botRatingPersistenceKey = resultKey;
        Promise.resolve(botPublishPromise).then(persisted => {
          if (botRatingPersistenceKey === resultKey) botRatingPersistenceKey = null;
          if (!persisted || botAnalysisOwnershipUnknown || resultKey !== gameResultKey()) return;
          recordRating();
          renderGameOverModal();
        }, () => {
          if (botRatingPersistenceKey === resultKey) botRatingPersistenceKey = null;
        });
      }
      if (gameOverSoundKey !== resultKey) {
        gameOverSoundKey = resultKey;
        const delay = Math.max(
          GAME_OVER_SOUND_GAP_MS,
          gameplaySoundBusyUntil - Date.now() + GAME_OVER_SOUND_GAP_MS,
        );
        schedule(() => (didWin ? NarduSound.win() : NarduSound.lose()), delay);
      }
    } finally {
      renderGameOverModal();
    }
  }

  function gameResultKey() {
    return `${state.finishedAt || ''}:${state.winner || ''}:${state.resultType || 'normal'}`;
  }

  function resultTypeLabel(type = state?.resultType) {
    if (type === 'mars') return tr('mars');
    if (type === 'koks') return tr('koks');
    return '';
  }

  function gameOverNoticeBlock() {
    const message = state?.networkLoss?.message;
    return message ? `<div class="go-note strong">${String(message).replace(/[&<>"']/g, escapeHtml)}</div>` : '';
  }

  function rematchMarkup() {
    const rematch = state.rematch || null;
    if (mode !== 'remote') {
      return `
        <div class="go-actions">
          <button class="go-btn primary" id="go-again">${tr('rematch_again')}</button>
          <button class="go-btn" id="go-lobby">${tr('lobby')}</button>
        </div>`;
    }
    if (rematch?.status === 'pending' && rematch.requestedBy === playerColor) {
      return `
        <div class="go-note">${tr('rematch_sent')}</div>
        <div class="go-actions">
          <button class="go-btn primary" disabled>${tr('rematch_again_question')}</button>
          <button class="go-btn" id="go-lobby">${tr('lobby')}</button>
        </div>`;
    }
    if (rematch?.status === 'pending' && rematch.requestedBy !== playerColor) {
      return `
        <div class="go-note strong">${tr('rematch_offer')}</div>
        <div class="go-actions">
          <button class="go-btn primary" id="rematch-yes">${tr('yes')}</button>
          <button class="go-btn" id="rematch-no">${tr('no')}</button>
        </div>`;
    }
    if (rematch?.status === 'declined') {
      return `
        <div class="go-note">${tr('rematch_declined')}</div>
        <div class="go-actions">
          <button class="go-btn primary" id="go-lobby">${tr('lobby')}</button>
        </div>`;
    }
    if (rematch?.status === 'accepted') {
      return `
        <div class="go-note">${tr('rematch_starting')}</div>
        <div class="go-actions">
          <button class="go-btn primary" disabled>${tr('preparing')}</button>
        </div>`;
    }
    return `
      <div class="go-actions">
        <button class="go-btn primary" id="go-again">${tr('rematch_again_question')}</button>
        <button class="go-btn" id="go-lobby">${tr('lobby')}</button>
      </div>`;
  }

  function renderGameOverModal() {
    const didWin = state.winner === playerColor;
    const resultLabel = resultTypeLabel();
    const rating = lastRatingResult?.key === gameResultKey() ? lastRatingResult : null;

    let modal = document.getElementById('game-over');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'game-over';
      modal.className = 'game-over';
      document.body.appendChild(modal);
    }
    const headline = mode === 'hotseat'
      ? (state.winner === 'white' ? tr('white_won') : tr('dark_won'))
      : (didWin ? tr('win') : tr('lose'));
    const subline = mode === 'hotseat'
      ? tr('pips_done', { pips: state.score[state.winner] })
      : `vs ${localizedName(opponentName)} · ${state.score.white}–${state.score.dark}`;
    const resultBlock = resultLabel ? `<div class="go-result">${resultLabel}</div>` : '';
    const ratingBlock = (rating?.rating !== null && rating?.rating !== undefined) ? `
      <div class="go-rating">
        <span class="go-r-num">${rating.rating}</span>
        <span class="go-r-delta ${rating.delta >= 0 ? 'up' : 'down'}">${rating.delta >= 0 ? '+' : ''}${rating.delta}</span>
      </div>` : '';
    modal.innerHTML = `
      <div class="go-card">
        <div class="go-emoji">${mode === 'hotseat' ? '🎲' : (didWin ? '🏆' : '×')}</div>
        <h2 class="go-title">${headline}</h2>
        <p class="go-sub">${subline}</p>
        ${gameOverNoticeBlock()}
        ${resultBlock}
        ${ratingBlock}
        ${rematchMarkup()}
      </div>
    `;
    requestAnimationFrame(() => modal.classList.add('show'));
    document.getElementById('go-again')?.addEventListener('click', requestRematchOrStart);
    document.getElementById('rematch-yes')?.addEventListener('click', acceptRematch);
    document.getElementById('rematch-no')?.addEventListener('click', declineRematch);
    document.getElementById('go-lobby')?.addEventListener('click', async () => {
      if (!claimGameOverAction('lobby')) return;
      if (mode === 'remote' && !(await ensureRemoteFinalStatePublished())) {
        gameOverActionStarted = null;
        renderGameOverModal();
        return;
      }
      await waitForFinishedBotPersistence();
      leaveRoomToLobby(true);
    });
  }

  function claimGameOverAction(action) {
    if (gameOverActionStarted) return false;
    gameOverActionStarted = action;
    document.getElementById('go-again')?.setAttribute?.('disabled', '');
    document.getElementById('go-lobby')?.setAttribute?.('disabled', '');
    return true;
  }

  async function requestRematchOrStart() {
    if (mode !== 'remote') {
      if (!claimGameOverAction('again')) return;
      if (mode === 'bot') {
        await waitForFinishedBotPersistence();
        startBotGameInNewRoom();
        return;
      }
      startNextGame({ publish: false });
      return;
    }
    if (!(await ensureRemoteFinalStatePublished())) return;
    state.rematch = {
      id: `${Date.now()}-${Math.random()}`,
      status: 'pending',
      requestedBy: playerColor,
      requestedAt: new Date().toISOString(),
    };
    publishRemoteState();
    renderGameOverModal();
  }

  async function acceptRematch() {
    if (mode !== 'remote') return;
    if (!(await ensureRemoteFinalStatePublished())) return;
    const id = state.rematch?.id || `${Date.now()}-${Math.random()}`;
    state.rematch = {
      ...(state.rematch || {}),
      id,
      status: 'accepted',
      acceptedBy: playerColor,
      acceptedAt: new Date().toISOString(),
    };
    if (isRemoteHost()) {
      startNextGame({ publish: true });
      return;
    }
    await publishRemoteState();
    renderGameOverModal();
  }

  async function declineRematch() {
    if (mode === 'remote') {
      if (!(await ensureRemoteFinalStatePublished())) return;
      state.rematch = {
        ...(state.rematch || {}),
        status: 'declined',
        declinedBy: playerColor,
        declinedAt: new Date().toISOString(),
      };
      await publishRemoteState();
    }
    leaveRoomToLobby(true);
  }

  function startNextGame({ publish = false, autoStart = true } = {}) {
    if (mode === 'remote' && publish) {
      const token = state.rematch?.id || `${Date.now()}-${Math.random()}`;
      if (rematchRestartToken === token) return;
      rematchRestartToken = token;
    }
    const nextMatchScore = normalizedMatchScore(state.matchScore);
    nextMatchScore.recordedWinner = null;
    clearRoomSnapshots();
    document.getElementById('game-over')?.remove();
    clearAll();
    schedule(async () => {
      const deferRemoteStart = mode === 'remote' && publish;
      init({
        mode,
        opponent: opponentName,
        opponentRating,
        difficulty: botDifficulty,
        variant,
        playerColor,
        matchScore: nextMatchScore,
        freshGame: true,
        skipRemoteSync: deferRemoteStart,
        skipAutoStart: deferRemoteStart || !autoStart,
      });
      state.rematch = null;
      if (publish) {
        await publishRemoteState();
        startRemoteSync();
        ensureAutoProgress(650);
      }
    }, 200);
  }

  function trayRollAnimation() {
    const row = document.getElementById('dice-row');
    if (!row) return Promise.resolve();
    row.classList.add('rolling');
    return new Promise(resolve => {
      setTimeout(() => {
        row.classList.remove('rolling');
        resolve();
      }, 380);
    });
  }

  /* ── event delegation: clicks on .point and bear tracks ── */
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('blur', cancelActiveDrag);
  window.addEventListener('pagehide', cancelActiveDrag);
  window.addEventListener('scroll', cancelActiveDrag, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelActiveDrag();
    else {
      void retryBotAnalysisStartup();
      ensureAutoProgress(350);
    }
  });
  window.addEventListener('online', () => {
    void retryBotAnalysisStartup();
    ensureAutoProgress(350);
  });

  document.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const copyButton = e.target.closest('[data-copy-hash]');
    if (copyButton) {
      e.preventDefault();
      e.stopPropagation();
      copyHashToClipboard(copyButton.dataset.copyHash, copyButton);
      return;
    }
    const pt = e.target.closest('[data-point]');
    if (pt && pt.closest('.board')) {
      const n = parseInt(pt.dataset.point, 10);
      if (!Number.isNaN(n)) onPointClick(n);
      return;
    }
    const bt = e.target.closest('.bear-track');
    if (bt) {
      const color = bt.classList.contains('white') ? 'white' : 'dark';
      onBearTrackClick(color);
    }
  });

  document.getElementById('bear-btn')?.addEventListener('click', onBearButtonClick);
  document.getElementById('undo-btn')?.addEventListener('click', undoLastMove);
  document.getElementById('resign-btn')?.addEventListener('click', resignGame);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'u' && e.key !== 'U' && e.key !== 'г' && e.key !== 'Г') return;
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (document.getElementById('undo-btn')?.disabled) return;
    e.preventDefault();
    undoLastMove();
  });

  return {
    init,
    getState,
    render,
    setRenderer,
    onPointClick,
    publishRemoteState,
    receiveRemoteState,
    prepareRoomReload,
    concedeRemoteGameByLobbyExit,
    startBotGameInNewRoom,
    startNextGame,
    resolveBotDifficulty,
    retryBotAnalysisStartup,
    preferredMoveAction,
  };
})();
