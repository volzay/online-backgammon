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
  let opponentName = 'Easy bot';
  let opponentRating = 900;
  let botDifficulty = 'easy';
  let pending = null;            /* { from } — currently selected source point */
  let isAnimating = false;
  let isRolling = false;
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
  let remotePollTimer = null;
  let isApplyingRemote = false;
  let remoteAnimatedRollTokens = new Set();
  let remoteMoveSoundKeys = new Set();
  let remoteMoveSoundReady = false;
  let localRatingRecordedKey = null;
  let lastRatingResult = null;
  let gameOverSoundKey = null;
  let rematchRestartToken = null;
  const ROOM_RELOAD_SNAPSHOT_KEY = 'narduh-room-reload-snapshot';
  const OPENING_RESULT_PAUSE_MS = 2600;
  const MOVE_SOUND_SETTLE_MS = 210;
  const BEAR_OFF_SOUND_SETTLE_MS = 190;
  const GAME_OVER_SOUND_GAP_MS = 260;
  let gameplaySoundBusyUntil = 0;
  const UI_TEXT = {
    ru: {
      bot_easy: 'Бот лёгкий',
      bot_medium: 'Бот средний',
      bot_hard: 'Бот сложный',
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
      history_wait_opening: 'Ожидаем стартовый бросок',
      history_wait_opening_sub: 'Оба игрока бросят по одному кубику.',
      history_room_created: 'Комната создана',
      history_code_wait: 'код {code} — ожидаем подключения соперника',
      history_opening_roll: 'Стартовый бросок',
      history_first_turn: 'первый ход',
      history_rerolls: ', перебросов: {count}',
      history_first_move: 'Первый ход',
      history_starting_dice: 'стартовые кубики {roll}',
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
      history_wait_opening: 'Waiting for the opening roll',
      history_wait_opening_sub: 'Both players will roll one die.',
      history_room_created: 'Room created',
      history_code_wait: 'code {code} — waiting for opponent to connect',
      history_opening_roll: 'Opening roll',
      history_first_turn: 'first move',
      history_rerolls: ', rerolls: {count}',
      history_first_move: 'First move',
      history_starting_dice: 'opening dice {roll}',
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

  function cloneStateForRestore(source) {
    return JSON.parse(JSON.stringify(source || {}));
  }

  function prepareRoomReload() {
    if (!state || state.phase === 'waiting') return false;
    try {
      syncTurnClock();
      const snapshot = {
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
      sessionStorage.setItem(ROOM_RELOAD_SNAPSHOT_KEY, JSON.stringify(snapshot));
      return true;
    } catch {
      return false;
    }
  }

  function consumeRoomReloadSnapshot(expected = {}) {
    let snapshot = null;
    try {
      snapshot = JSON.parse(sessionStorage.getItem(ROOM_RELOAD_SNAPSHOT_KEY) || 'null');
    } catch {}
    try {
      sessionStorage.removeItem(ROOM_RELOAD_SNAPSHOT_KEY);
    } catch {}
    if (!snapshot?.state || snapshot.signature !== roomReloadSignature()) return null;
    if (Date.now() - (Number(snapshot.at) || 0) > 10 * 60 * 1000) return null;
    if (snapshot.mode && expected.mode && snapshot.mode !== expected.mode) return null;
    if (snapshot.playerColor && expected.playerColor && snapshot.playerColor !== expected.playerColor) return null;
    if ((snapshot.roomCode || '') !== (expected.roomCode || '')) return null;
    return snapshot.state;
  }

  function normalizeRestoredState(restored, url) {
    const base = NarduGame.initialState();
    const saved = cloneStateForRestore(restored);
    return {
      ...base,
      ...saved,
      points: saved.points || base.points,
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
      viewColor: mode === 'remote' ? playerColor : 'white',
      roomCode: url.searchParams.get('room') || '',
      turnClock: normalizedTurnClock(saved.turnClock || base.turnClock),
      matchScore: normalizedMatchScore(saved.matchScore || base.matchScore),
    };
  }

  /* ── init ──────────────────────────────────── */
  function init(opts = {}) {
    const url = new URL(location.href);
    mode = opts.mode || url.searchParams.get('mode') || 'bot';
    const waitingForOpponent = opts.waiting || url.searchParams.get('waiting') === '1';
    opponentName = opts.opponent || url.searchParams.get('opp') || (waitingForOpponent ? tr('waiting_opponent') : (mode === 'bot' ? tr('bot_easy') : tr('opponent')));
    opponentRating = Number(opts.opponentRating || url.searchParams.get('oppR') || 900);
    botDifficulty = normalizeBotDifficulty(opts.difficulty || url.searchParams.get('difficulty') || botDifficulty);
    playerColor = opts.playerColor || url.searchParams.get('color') || (url.searchParams.get('guest') === '1' ? 'dark' : 'white');

    if (statTimer) clearInterval(statTimer);
    statTimer = null;

    const roomCode = url.searchParams.get('room') || '';
    const restoredState = waitingForOpponent ? null : consumeRoomReloadSnapshot({ mode, playerColor, roomCode });
    state = restoredState ? normalizeRestoredState(restoredState, url) : NarduGame.initialState();
    if (opts.matchScore && !restoredState) {
      state.matchScore = normalizedMatchScore({ ...opts.matchScore, recordedWinner: null });
    }
    state.hints = [];
    state.fullHints = [];
    state.selected = null;
    state.mode = mode;
    state.playerColor = playerColor;
    state.botDifficulty = botDifficulty;
    state.viewColor = mode === 'remote' ? playerColor : 'white';
    state.roomCode = roomCode;
    remoteCode = state.roomCode;
    remoteVersion = 0;
    remoteAnimatedRollTokens = new Set();
    remoteMoveSoundKeys = new Set();
    remoteMoveSoundReady = false;
    localRatingRecordedKey = null;
    lastRatingResult = null;
    gameOverSoundKey = null;
    gameplaySoundBusyUntil = 0;
    rematchRestartToken = null;
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
    undoStack = [];

    paintOpponent();
    startStatTimer();
    render();

    if (applyLocalBearOffDemo(url)) return;
    if (waitingForOpponent) return;
    if (!opts.skipRemoteSync) startRemoteSync();
    if (opts.skipAutoStart) return;
    const autoStartDelay = mode === 'remote' ? 1300 : 650;
    if (state.phase === 'opening') scheduleOpeningRoll(autoStartDelay);
    else scheduleAutoRoll(autoStartDelay);
  }

  function normalizeBotDifficulty(value) {
    const key = String(value || '').trim().toLowerCase();
    return ['easy', 'medium', 'hard'].includes(key) ? key : 'easy';
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

  async function publishRemoteState() {
    if (mode !== 'remote' || !remoteCode || state.phase === 'waiting' || isApplyingRemote) return;
    syncTurnClock();
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(remoteCode)}/game`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: remoteStatePayload(), version: remoteVersion }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && Number.isFinite(data.version)) remoteVersion = data.version;
    } catch {
      /* keep local play responsive while the room server recovers */
    }
  }

  async function pollRemoteState() {
    if (mode !== 'remote' || !remoteCode || state.phase === 'waiting' || isRolling || isAnimating || isChainingMove) return;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(remoteCode)}/game`);
      const data = await response.json().catch(() => ({}));
      if (response.status === 404) {
        handleRemoteRoomMissing();
        return;
      }
      if (!response.ok || !data.state || !Number.isFinite(data.version) || data.version <= remoteVersion) return;
      applyRemoteState(data.state, data.version);
    } catch {
      /* the next poll will retry */
    }
  }

  function applyRemoteState(nextState, version) {
    isApplyingRemote = true;
    remoteVersion = version;
    const animateIncomingOpeningRoll = shouldAnimateIncomingRemoteOpeningRoll(nextState);
    const animateIncomingRoll = shouldAnimateIncomingRemoteRoll(nextState);
    const incomingMoveSounds = collectIncomingRemoteMoveSounds(nextState);
    const previousStartedAt = state?.startedAt;
    const previousFinishedAt = state?.finishedAt;
    const previousTurnClock = state?.turnClock;
    const previousMatchScore = state?.matchScore;
    if (autoRollTimer) clearTimeout(autoRollTimer);
    if (autoEndTimer) clearTimeout(autoEndTimer);
    autoRollTimer = null;
    autoEndTimer = null;
    state = {
      ...JSON.parse(JSON.stringify(nextState)),
      selected: null,
      hints: [],
      fullHints: [],
      mode,
      playerColor,
      viewColor: mode === 'remote' ? playerColor : 'white',
      roomCode: remoteCode,
      startedAt: nextState.startedAt || previousStartedAt || Date.now(),
      finishedAt: nextState.finishedAt || previousFinishedAt || null,
      turnClock: normalizedTurnClock(nextState.turnClock || previousTurnClock),
      matchScore: normalizedMatchScore(nextState.matchScore || previousMatchScore),
    };
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
    } else {
      render();
      if (state.phase === 'over' && state.winner) onGameOver();
      if (state.phase === 'roll' && isMyTurn()) scheduleAutoRoll(650);
    }
    isApplyingRemote = false;
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
    const isOpeningTurnRoll = nextState.rollToken.startsWith('opening-turn:')
      && nextState.history?.[0]?.openingMove
      && ['opening', 'opening-result'].includes(state?.phase);
    if (nextState.turn === playerColor && !isOpeningTurnRoll) return false;
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
        duration: 2600,
      }),
      trayRollAnimation(),
    ]).then(() => {
      isRolling = false;
      if (state.rollToken !== token) {
        render();
        return;
      }
      render();
      if (state.phase === 'opening-result' && isRemoteHost()) {
        schedule(() => {
          startOpeningTurnRoll();
        }, OPENING_RESULT_PAUSE_MS);
      }
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
        duration: token?.startsWith('opening-turn:') ? 1800 : undefined,
      }),
      trayRollAnimation(),
    ]).then(() => {
      isRolling = false;
      if (state.rollToken !== token) {
        render();
        return;
      }
      render();
      if (state.phase === 'roll' && isMyTurn()) scheduleAutoRoll(650);
      else maybeScheduleAutoEndTurn();
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
      && !isChainingMove;
    btn.disabled = !canResign;
    btn.title = canResign ? tr('resign_title') : tr('cannot_resign_title');
  }

  /* ── dice & roll button rendering ─────────── */
  function renderDice() {
    const row = document.getElementById('dice-row');
    if (!row) return;
    row.innerHTML = '';

    if (state.phase === 'over') return;

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
    layer.innerHTML = '';
    layer.classList.remove('head-home-white', 'head-home-dark');

    if (isRolling || state.phase === 'over' || state.rolled.length === 0) return;

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
    if (mode === 'hotseat') return sideName(color);
    if (color === playerColor) {
      return window.NarduApp?.getUser?.()?.name || tr('you');
    }
    return localizedName(opponentName);
  }

  /* ── turn banners ─────────────────────────── */
  function renderTurn() {
    document.querySelectorAll('.player').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.turn-banner').forEach(el => el.style.visibility = 'hidden');

    const opponentColor = playerColor === 'white' ? 'dark' : 'white';
    paintPlayerSideLabels(opponentColor);

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
      const pos = NarduGame.pathPos(color, Number(point));
      return total + data.count * Math.max(0, 24 - pos);
    }, 0);
  }

  /* ── history (last few moves) ─────────────── */
  function renderHistory() {
    const list = document.getElementById('history-list') || document.querySelector('.history');
    if (!list) return;
    const items = (state.history || []).slice(0, 8);
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
        return historyMarkup(number, 'dark', tr('history_opening_roll'), `${item.hostName || sideName('white')} ${item.host} : ${item.guestName || sideName('dark')} ${item.guest} — ${tr('history_first_turn')}: ${turnName(item.winnerColor)}${rerollText}`, item.sha256);
      }
      if (item.openingMove) {
        return historyMarkup(number, item.color, tr('history_first_move'), tr('history_starting_dice', { roll: item.roll }), item.sha256);
      }
      if (item.roll) {
        return historyMarkup(number, item.color, tr('history_rolls', { name: turnName(item.color) }), item.roll, item.sha256);
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

  function historyMarkup(number, color, title, sub, sha256 = '') {
    const safeTitle = String(title).replace(/[&<>"']/g, escapeHtml);
    const safeSub = String(sub).replace(/[&<>"']/g, escapeHtml);
    const safeHash = String(sha256 || '').replace(/[&<>"']/g, escapeHtml);
    const hashBlock = safeHash ? `
          <div class="fair-hash">
            <span>SHA-256</span>
            <code>${safeHash}</code>
            <button type="button" data-copy-hash="${safeHash}" title="${tr('copy_sha')}">${tr('copy')}</button>
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
    if (mode === 'hotseat') return true;
    return state.turn === playerColor;
  }

  function isRemoteHost() {
    return mode === 'remote' && new URL(location.href).searchParams.get('host') === '1';
  }

  function leaveRoomToLobby(closeRoom = true) {
    clearAll();
    if (closeRoom && window.NarduRoom?.leaveToLobby) {
      window.NarduRoom.leaveToLobby();
      return;
    }
    if (!closeRoom && window.NarduRoom?.closeCurrentRoom) {
      window.NarduRoom.closeCurrentRoom().finally(() => { location.href = 'index.html'; });
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
    if (!window.crypto?.subtle) return sha256HexFallback(input);
    const bytes = new TextEncoder().encode(input);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
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
          values,
          roll: expandRollValues(values),
          rerolls,
        };
      }
      rerolls += 1;
    }
  }
  function clearAll() {
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
    if (state.phase !== 'roll' || state.phase === 'over' || isRolling || autoRollTimer) return;
    if (mode === 'remote' && !isMyTurn()) return;
    autoRollTimer = schedule(() => {
      autoRollTimer = null;
      autoRoll();
    }, ms);
  }

  function scheduleOpeningRoll(ms = 600) {
    if (state.phase !== 'opening' || state.phase === 'over' || isRolling || autoRollTimer) return;
    if (mode === 'remote' && !isRemoteHost()) return;
    autoRollTimer = schedule(() => {
      autoRollTimer = null;
      openingRoll();
    }, ms);
  }

  async function openingRoll() {
    if (state.phase !== 'opening' || isRolling) return;
    if (mode === 'remote' && !isRemoteHost()) return;
    const user = window.NarduApp?.getUser?.();
    isRolling = true;
    NarduSound.prime();
    NarduSound.dice();
    const fair = await shaDiceRoll({ label: 'opening', color: 'opening', noTie: true });
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
    opening.rerolls = fair.rerolls;
    const openingHistory = state.history?.find(item => item.opening);
    if (openingHistory) {
      openingHistory.sha256 = fair.hash;
      openingHistory.rerolls = fair.rerolls;
    }
    state.rollToken = `opening:${fair.hash.slice(0, 16)}:${opening.host.die}:${opening.guest.die}`;
    publishRemoteState();
    render();

    const boardDiceLayer = document.getElementById('board-dice-layer');
    if (boardDiceLayer) boardDiceLayer.dataset.boardDiceCount = '2';
    Promise.all([
      NarduBoardEngine.animateOpeningRoll({
        layer: boardDiceLayer,
        opening,
        token: state.rollToken,
        duration: 2600,
      }),
      trayRollAnimation(),
    ]).then(() => {
      isRolling = false;
      render();
      schedule(() => {
        startOpeningTurnRoll();
      }, OPENING_RESULT_PAUSE_MS);
    });
  }

  function startOpeningTurnRoll() {
    if (state.phase !== 'opening-result' || isRolling) return;
    const started = NarduGame.startOpeningTurn(state);
    if (!started) return;
    const openingHash = state.openingRoll?.sha256 || '';
    if (openingHash && state.history?.[0]?.openingMove) {
      state.history[0].sha256 = openingHash;
    }

    const rollingTurn = state.turn;
    const boardFaces = boardDiceFaces(state.rolled);
    const boardDiceLayer = document.getElementById('board-dice-layer');
    state.rollToken = `opening-turn:${openingHash.slice(0, 16) || Date.now()}:${state.rolled.join(':')}`;
    undoStack = [];
    isRolling = true;

    NarduSound.prime();
    NarduSound.dice();
    render();
    if (boardDiceLayer) boardDiceLayer.dataset.boardDiceCount = String(boardFaces.length);

    Promise.all([
      NarduBoardEngine.animateDiceRoll({
        layer: boardDiceLayer,
        faces: boardFaces,
        color: rollingTurn,
        token: state.rollToken,
        duration: 1800,
      }),
      trayRollAnimation(),
    ]).then(() => {
      isRolling = false;
      render();
      publishRemoteState();
      if (state.winner) { onGameOver(); return; }
      if (state.turn === rollingTurn && mode === 'bot' && !isMyTurn()) {
        schedule(playBotTurn, 700);
      } else {
        maybeScheduleAutoEndTurn();
      }
    });
  }

  async function autoRoll() {
    if (state.phase !== 'roll' || isRolling) return;
    const rollingTurn = state.turn;
    NarduSound.prime();
    NarduSound.dice();
    isRolling = true;
    const fair = await shaDiceRoll({ label: 'turn-roll', color: rollingTurn });
    const r = fair.roll;
    undoStack = [];
    NarduGame.applyRoll(state, r);
    state.history.unshift({
      color: rollingTurn,
      roll: compactRollText(r),
      sha256: fair.hash,
      at: new Date().toISOString(),
    });
    state.rollToken = `roll:${fair.hash.slice(0, 16)}:${compactRollText(r)}`;
    publishRemoteState();
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
      }),
      trayRollAnimation(),
    ]).then(() => {
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
    });
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
    if (state.winner) { onGameOver(); return; }
    if (state.phase === 'roll') scheduleAutoRoll(700);
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
    const fullDest = legalFullDestinations(from).find(d => d.to === point);
    if (fullDest) return { type: 'sequence', dest: fullDest };
    const dest = NarduGame.legalDestinations(state, from).find(d => d.to === point);
    if (dest) return { type: 'single', dest };
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
        if (move.bearOff || move.to === 0) break;
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
    const dests = NarduGame.legalDestinations(state, pending.from);
    const fullDests = legalFullDestinations(pending.from);
    const fullDest = fullDests.find(d => d.to === 0);
    if (fullDest) {
      const from = pending.from;
      pending = null; state.selected = null; state.hints = []; state.fullHints = [];
      doUserMoveSequence(from, fullDest.moves);
      return;
    }
    const dest = dests.find(d => d.to === 0);
    if (!dest) return;
    const from = pending.from;
    pending = null; state.selected = null; state.hints = []; state.fullHints = [];
    doUserMove(from, dest.die, dest);
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
      doUserMoveSequence(from, drop.dest.moves, { instant: true, dragClone });
      return;
    }
    doUserMove(from, drop.dest.die, drop.dest, { instant: true, dragClone });
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
    animateMove(from, NarduGame.moveTo(state.turn, from, die), () => {
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
    });
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
      if (!appliedAll || state.winner) {
        isChainingMove = false;
        if (state.winner) onGameOver();
        return;
      }
      isChainingMove = false;
      afterUserSequence();
    });
  }

  function afterUserSequence() {
    render();
    if (state.winner) { onGameOver(); return; }
    maybeScheduleAutoEndTurn();
  }

  function maybeScheduleAutoEndTurn() {
    if (autoEndTimer) clearTimeout(autoEndTimer);
    autoEndTimer = null;
    if (state.phase !== 'move' || state.winner || !isMyTurn()) return;
    if (state.dice.length > 0 && NarduGame.hasAnyMoves(state)) return;

    autoEndTimer = schedule(() => {
      autoEndTimer = null;
      if (state.phase !== 'move' || state.winner || !isMyTurn()) return;
      if (state.dice.length > 0 && NarduGame.hasAnyMoves(state)) return;
      endTurnUser();
    }, 1200);
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
    if (!state || state.phase === 'waiting' || state.phase === 'over' || state.winner) return;
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
    await publishRemoteState();
    return true;
  }

  /* ── bot ─────────────────────────────────── */
  function playBotTurn() {
    NarduSound.prime();
    undoStack = [];
    const moves = NarduBot.plan(state, { difficulty: botDifficulty });
    if (moves.length === 0) {
      NarduGame.endTurn(state); afterTurn(); return;
    }
    let i = 0;
    function step() {
      if (i >= moves.length) {
        if (state.winner) onGameOver();
        else afterTurn();
        return;
      }
      const m = moves[i++];
      const to = NarduGame.moveTo(state.turn, m.from, m.die);
      animateMove(m.from, to, () => {
        const applied = NarduGame.applyMove(state, m.from, m.die);
        if (!applied) {
          render();
          if (state.winner) onGameOver();
          else afterTurn();
          return;
        }
        playMoveSound(m);
        render();
        if (state.winner) { onGameOver(); return; }
        schedule(step, 380);
      });
    }
    step();
  }

  /* ── animation: clone a flying checker from source to destination ── */
  function animateMove(from, to, done) {
    isAnimating = true;
    NarduBoardEngine.animateCheckerMove({
      from,
      to,
      color: state.turn,
      destinationCount: to === 0 ? 0 : NarduGame.pointCount(state, to),
    }).then(() => {
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
    recordMatchGame();
    renderPlayerStats();
    if (mode === 'remote' && !state.gameOverPublishedAt) {
      state.gameOverPublishedAt = new Date().toISOString();
      publishRemoteState();
    }

    const didWin = state.winner === playerColor;
    const resultKey = gameResultKey();
    if ((mode === 'bot' || mode === 'remote') && localRatingRecordedKey !== resultKey) {
      const r = NarduRating.record(opponentName, opponentRating, didWin, mode, resultKey, {
        resultType: state.resultType || '',
        winner: state.winner,
        score: { ...state.score },
        finishedAt: state.finishedAt ? new Date(state.finishedAt).toISOString() : new Date().toISOString(),
      });
      lastRatingResult = r ? { delta: r.delta || 0, rating: r.rating ?? null, key: resultKey } : null;
      localRatingRecordedKey = resultKey;
    }
    if (gameOverSoundKey !== resultKey) {
      gameOverSoundKey = resultKey;
      const delay = Math.max(
        GAME_OVER_SOUND_GAP_MS,
        gameplaySoundBusyUntil - Date.now() + GAME_OVER_SOUND_GAP_MS,
      );
      schedule(() => (didWin ? NarduSound.win() : NarduSound.lose()), delay);
    }

    renderGameOverModal();
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
    document.getElementById('go-lobby')?.addEventListener('click', () => leaveRoomToLobby(true));
  }

  function requestRematchOrStart() {
    if (mode !== 'remote') {
      startNextGame({ publish: false });
      return;
    }
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

  function startNextGame({ publish = false } = {}) {
    if (mode === 'remote' && publish) {
      const token = state.rematch?.id || `${Date.now()}-${Math.random()}`;
      if (rematchRestartToken === token) return;
      rematchRestartToken = token;
    }
    const nextMatchScore = normalizedMatchScore(state.matchScore);
    nextMatchScore.recordedWinner = null;
    document.getElementById('game-over')?.remove();
    clearAll();
    schedule(async () => {
      const deferRemoteStart = mode === 'remote' && publish;
      init({
        mode,
        opponent: opponentName,
        opponentRating,
        difficulty: botDifficulty,
        playerColor,
        matchScore: nextMatchScore,
        skipRemoteSync: deferRemoteStart,
        skipAutoStart: deferRemoteStart,
      });
      state.rematch = null;
      if (publish) {
        await publishRemoteState();
        startRemoteSync();
        if (state.phase === 'opening') scheduleOpeningRoll(650);
        else scheduleAutoRoll(650);
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

  return { init, getState, render, setRenderer, onPointClick, publishRemoteState, prepareRoomReload, concedeRemoteGameByLobbyExit };
})();
