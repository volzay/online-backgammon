(() => {
  'use strict';

  const game = window.NarduGame;
  const bot = window.NarduUltrabotTest;
  const storageKey = 'nardu-ultrabot-player-test-v1';
  const ui = Object.fromEntries(
    ['board', 'status', 'dice', 'white-off', 'dark-off', 'roll', 'bear-off', 'undo', 'new-game']
      .map(id => [id, document.getElementById(id)]),
  );
  let state = restore() || newGame();
  let selected = null;
  let previousMove = null;
  let pendingBot = null;
  let problem = '';

  function newGame() {
    return { ...game.initialState('long'), phase: 'roll', turn: 'white' };
  }

  function restore() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey));
      if (value?.variant !== 'long' || !['white', 'dark'].includes(value.turn)
        || !['roll', 'move', 'over'].includes(value.phase)
        || !value.points || !value.off || !value.bar || !Array.isArray(value.turnMoves)
        || !Array.isArray(value.dice) || !Array.isArray(value.rolled)
        || ![...value.dice, ...value.rolled].every(die => Number.isInteger(die) && die >= 1 && die <= 6)) {
        return null;
      }
      const count = { ...value.off };
      for (const [number, stack] of Object.entries(value.points)) {
        if (!/^(?:[1-9]|1[0-9]|2[0-4])$/.test(number) || !['white', 'dark'].includes(stack?.color)
          || !Number.isInteger(stack.count) || stack.count < 1) return null;
        count[stack.color] += stack.count;
      }
      if (count.white !== 15 || count.dark !== 15 || value.bar.white !== 0 || value.bar.dark !== 0
        || !['white', 'dark'].every(color => Number.isInteger(value.off[color]) && value.off[color] >= 0)
        || (value.phase === 'over' ? !['white', 'dark'].includes(value.winner) : value.winner != null)) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify({ ...state, history: [] })); }
    catch { /* Storage can be disabled in a private browser. The game remains playable. */ }
  }

  function rollDice() {
    const byte = new Uint8Array(1);
    function die() {
      do { crypto.getRandomValues(byte); } while (byte[0] >= 252);
      return 1 + byte[0] % 6;
    }
    const first = die();
    const second = die();
    return first === second ? [first, first, first, first] : [first, second];
  }

  function playerMoves() {
    return state.turn === 'white' && state.phase === 'move' ? game.legalNextMoves(state, 'white') : [];
  }

  const pointOrder = [...Array.from({ length: 12 }, (_, index) => 13 + index),
    ...Array.from({ length: 12 }, (_, index) => 12 - index)];
  const points = new Map(pointOrder.map(number => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'point';
    button.dataset.point = number;
    button.dataset.half = number > 12 ? 'top' : 'bottom';
    const label = document.createElement('span');
    label.className = 'point-number';
    label.textContent = number;
    const stack = document.createElement('span');
    stack.className = 'stack';
    stack.setAttribute('aria-hidden', 'true');
    button.append(label, stack);
    ui.board.append(button);
    return [number, { button, stack }];
  }));

  function render() {
    const moves = playerMoves();
    for (const [number, { button, stack }] of points) {
      const occupied = state.points[number];
      const isSource = moves.some(move => move.from === number);
      const isTarget = moves.some(move => move.from === selected && move.to === number);
      button.disabled = !isSource && !isTarget;
      button.classList.toggle('legal', isTarget || (selected === null && isSource));
      button.classList.toggle('selected', selected === number);
      button.dataset.color = occupied?.color || '';
      button.setAttribute('aria-label', occupied
        ? `Пункт ${number}, ${occupied.color === 'white' ? 'белые' : 'тёмные'}: ${occupied.count}`
        : `Пункт ${number}, свободен`);
      const checkers = Array.from({ length: Math.min(occupied?.count || 0, 5) }, () => {
        const checker = document.createElement('span');
        checker.className = `checker ${occupied.color}`;
        return checker;
      });
      if ((occupied?.count || 0) > 5) {
        const badge = document.createElement('span');
        badge.className = 'stack-count';
        badge.textContent = occupied.count;
        checkers.push(badge);
      }
      stack.replaceChildren(...checkers);
    }
    const playerTurn = state.turn === 'white' && state.phase !== 'over';
    ui.dice.textContent = state.dice.length ? state.dice.join(' · ') : '—';
    ui['white-off'].textContent = state.off.white;
    ui['dark-off'].textContent = state.off.dark;
    ui.roll.disabled = !bot || !playerTurn || state.phase !== 'roll';
    ui['bear-off'].disabled = !moves.some(move => move.from === selected && move.to === 0);
    ui.undo.disabled = !previousMove || !playerTurn || state.phase !== 'move';
    ui.status.textContent = problem || (!bot ? 'Не удалось загрузить Ультработа. Обновите страницу.'
      : state.phase === 'over' ? (state.winner === 'white' ? 'Вы выиграли партию.' : 'Ультработ выиграл партию.')
      : !playerTurn ? 'Ультработ выбирает ход…'
      : state.phase === 'roll' ? 'Ваш ход. Бросьте кубики.'
      : selected === null ? 'Выберите белую шашку.' : 'Выберите подсвеченный пункт.');
  }

  function advance() {
    save();
    render();
    if (bot && !problem && state.turn === 'dark' && state.phase !== 'over' && !pendingBot) {
      void playBot();
    }
  }

  async function playBot() {
    const request = {};
    pendingBot = request;
    try {
      if (state.phase === 'roll') {
        game.applyRoll(state, rollDice());
        save();
        render();
      }
      const rules = { ...structuredClone(state), history: [] };
      const moves = game.legalNextMoves(rules).length ? await bot.plan(rules) : [];
      if (pendingBot !== request) return;
      // Apply to a copy so an invalid or incomplete plan cannot change the game.
      const next = structuredClone(state);
      for (const move of moves) {
        if (!game.isValidMove(next, move.from, move.die)
          || !game.applyMove(next, move.from, move.die, { autoEnd: false })) {
          throw new Error('Illegal Ultrabot move');
        }
      }
      if (!next.winner) {
        if (game.hasAnyMoves(next)) throw new Error('Incomplete Ultrabot turn');
        game.endTurn(next);
      }
      state = next;
    } catch {
      if (pendingBot === request) {
        problem = 'Ультработ не смог завершить ход. Обновите страницу, чтобы продолжить с тем же броском.';
      }
    } finally {
      if (pendingBot === request) {
        pendingBot = null;
        advance();
      }
    }
  }

  function playMove(move) {
    const before = structuredClone(state);
    if (!game.applyMove(state, move.from, move.die)) return;
    previousMove = state.turn === 'white' && state.phase === 'move' ? before : null;
    selected = null;
    advance();
  }

  ui.board.addEventListener('click', event => {
    const button = event.target.closest('button[data-point]');
    if (!button) return;
    const number = Number(button.dataset.point);
    const moves = playerMoves();
    const move = moves.find(move => move.from === selected && move.to === number);
    if (move) playMove(move);
    else if (moves.some(move => move.from === number)) {
      selected = selected === number ? null : number;
      render();
    }
  });
  ui.roll.addEventListener('click', () => {
    if (ui.roll.disabled) return;
    game.applyRoll(state, rollDice());
    if (!game.hasAnyMoves(state)) game.endTurn(state);
    advance();
  });
  ui['bear-off'].addEventListener('click', () => {
    const move = playerMoves().find(move => move.from === selected && move.to === 0);
    if (move) playMove(move);
  });
  ui.undo.addEventListener('click', () => {
    if (ui.undo.disabled) return;
    state = previousMove;
    previousMove = null;
    selected = null;
    advance();
  });
  ui['new-game'].addEventListener('click', () => {
    pendingBot = null;
    selected = previousMove = null;
    problem = '';
    state = newGame();
    advance();
  });

  advance();
})();
