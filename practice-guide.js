(function () {
  'use strict';

  const slot = document.getElementById('practice-guide-slot');
  if (!slot || !document.body.classList.contains('practice-room')) return;
  const player = window.NarduApp?.getUser();
  const key = window.NarduOnboarding?.keyFor(player);
  const controller = window.NarduController;
  let undone = false;
  let previousMoveCount = 0;
  let roomLesson = 'fullscreen-enter';
  let lastStep;
  let active = true;
  let highlights = [];
  let timer = 0;
  const copy = {
    ru: {
      guide: 'Пробная партия', skip: 'Пропустить гайд', point: 'Пункт', next: 'Далее',
      check: 'Проверить бросок', unavailable: 'Эта запись броска недоступна. Можно перейти дальше.',
      secondTurn: 'Ко второму ходу', home: 'К снятию шашек', retry: 'Повторить снятие',
      roll: ['Автоматический бросок', 'Вы играете белыми. Дождитесь, пока кубики выпадут автоматически.'],
      select: ['Выберите шашку', 'Нажмите на подсвеченную белую шашку мышью или пальцем. На доске подсветятся доступные пункты.'],
      move: ['Нажмите на подсвеченный пункт', 'Шашка автоматически переместится на этот пункт.'],
      undo: ['Попробуйте отмену', 'Кнопка «Отменить ход» возвращает последнее перемещение. Затем сыграйте его снова или выберите другой пункт.'],
      'finish-moves': ['Сыграйте оставшиеся значения', 'Нажмите на шашку, затем на подсвеченный пункт. Используйте доступные значения на кубиках.'],
      drag: ['Перетащите шашку', 'Зажмите белую шашку мышью на ноутбуке или пальцем на смартфоне. Удерживая её, перенесите на подсвеченный пункт и отпустите.'],
      confirm: ['Подтвердите ход', 'Нажмите «Подтвердить ход» сразу под доской.'],
      verify: ['Проверьте свой бросок', 'Игра на паузе. Нажмите «Проверить бросок» здесь или «Проверить» возле броска в истории. Затем перейдите ко второму ходу.'],
      'home-ready': ['Два хода сыграны', 'Перейдите к снятию. Шашки окажутся в случайной учебной расстановке в домах с подходящими значениями кубиков.'],
      'bear-button': ['Снимите шашку кнопкой', 'Нажмите на подсвеченную белую шашку в доме, затем нажмите «Снять» под доской.'],
      'bear-drag': ['Снимите шашку вручную', 'Зажмите подсвеченную шашку мышью или пальцем, перетащите на белую полоску снятых шашек под доской и отпустите. Можно также выбрать шашку и нажать на полоску.'],
      'bear-retry': ['Попробуйте снятие ещё раз', 'Кубики использованы. Начните новую учебную расстановку и снимите две шашки.'],
      'fullscreen-enter': ['Разверните доску', 'Нажмите «Развернуть поле» над доской. Чтобы вернуться, нажмите значок «Свернуть поле» под доской.'],
      'fullscreen-exit': ['Сверните доску', 'Нажмите значок «Свернуть поле» под доской.'],
      resign: ['Где сдаться', 'Кнопка «Сдаться» завершает партию поражением. Нажмите «Далее», чтобы перейти к выходу.'],
      lobby: ['Вернитесь в лобби', 'Нажмите подсвеченную кнопку «Лобби», чтобы закончить гайд.'],
    },
    en: {
      guide: 'Practice game', skip: 'Skip guide', point: 'Point', next: 'Next',
      check: 'Check roll', unavailable: 'This roll record is unavailable. You can still continue.',
      secondTurn: 'Play the second turn', home: 'Practice bearing off', retry: 'Try bearing off again',
      roll: ['Automatic dice roll', 'You are playing white. Wait for the dice to roll automatically.'],
      select: ['Choose a checker', 'Click or tap a highlighted white checker. The available points will light up.'],
      move: ['Select a highlighted point', 'The checker moves to that point automatically.'],
      undo: ['Try undoing a move', 'Undo move takes back the last move. You can replay it or pick a different point.'],
      'finish-moves': ['Play the remaining dice', 'Select a checker, then a highlighted point. Use the remaining playable dice.'],
      drag: ['Drag a checker', 'Hold down a white checker with your mouse or finger, drag it to a highlighted point, and release.'],
      confirm: ['Confirm your turn', 'Select Confirm turn just below the board.'],
      verify: ['Check your roll', 'The game is paused. Select Check roll here or beside your roll in the move history. Then play the second turn.'],
      'home-ready': ['Two turns played', 'Continue to bearing off. The guide will set up a random home-board position with dice you can use to bear off.'],
      'bear-button': ['Use the Bear off button', 'Select a highlighted white checker in your home board, then select Bear off below the board.'],
      'bear-drag': ['Bear off a checker by dragging', 'Hold down a highlighted checker and drag it to the white bear-off tray below the board. You can also select the checker and then select the tray.'],
      'bear-retry': ['Try bearing off again', 'The dice have been used. Start a new practice position and bear off two checkers.'],
      'fullscreen-enter': ['Expand the board', 'Select Expand board above the board. To return, select the Exit board view icon below the board.'],
      'fullscreen-exit': ['Exit full screen', 'Select the Exit board view icon below the board.'],
      resign: ['Find the Resign button', 'Resign ends the game as a loss. Select Next to see how to leave the room.'],
      lobby: ['Return to the lobby', 'Select the highlighted Lobby button to finish the guide.'],
    },
  };
  const labels = () => copy[document.documentElement.lang === 'en' ? 'en' : 'ru'];

  function storedState() {
    try { return key ? JSON.parse(localStorage.getItem(key)) : null; }
    catch { return null; }
  }

  function save(status) {
    try {
      if (key) localStorage.setItem(key, JSON.stringify({ ...storedState(), status }));
    } catch { /* The guide still works in this document. */ }
  }

  if (['skipped', 'completed'].includes(storedState()?.status)) return;
  slot.hidden = false;
  slot.innerHTML = `
    <aside class="practice-guide" aria-label="">
      <span class="onboarding-guide" aria-hidden="true"></span>
      <div class="practice-guide-copy" role="status" aria-atomic="true">
        <p class="onboarding-progress"></p>
        <h2 class="onboarding-title"></h2>
        <p class="onboarding-text"></p>
        <p class="onboarding-text practice-guide-proof" hidden></p>
      </div>
      <div class="practice-guide-actions">
        <button class="ghostbtn practice-guide-skip" type="button"></button>
        <button class="ghostbtn practice-guide-check" type="button" hidden></button>
        <button class="pillbtn practice-guide-next" type="button" hidden></button>
      </div>
    </aside>`;
  const guide = slot.firstElementChild;
  const title = guide.querySelector('.onboarding-title');
  const text = guide.querySelector('.onboarding-text');
  const proof = guide.querySelector('.practice-guide-proof');
  const progress = guide.querySelector('.onboarding-progress');
  const skip = guide.querySelector('.practice-guide-skip');
  const check = guide.querySelector('.practice-guide-check');
  const next = guide.querySelector('.practice-guide-next');
  const history = document.getElementById('history-list');
  const confirm = document.getElementById('practice-confirm');
  const bear = document.getElementById('bear-btn');
  const resign = document.getElementById('resign-btn');
  const lobby = document.querySelector('[data-room-lobby]');
  const expand = document.querySelector('.mobile-board-toggle');
  const collapse = document.querySelector('.action-exit-focus');
  const bearTrack = document.querySelector('.bear-track.white');
  let current = controller?.getPracticeStatus?.();
  let keyboardPoint = false;

  function finish(status) {
    if (!active) return;
    active = false;
    observer.disconnect();
    cancelAnimationFrame(timer);
    window.removeEventListener('nardu:practicechange', update);
    window.removeEventListener('nardu:langchange', schedule);
    document.removeEventListener('keydown', handleKey);
    clearHighlights();
    save(status);
    slot.hidden = true;
  }

  function skipGuide() {
    finish('skipped');
    location.assign('index.html');
  }

  function clearHighlights() {
    for (const element of highlights) {
      element.classList.remove('practice-target');
      if (element.classList.contains('point')) {
        element.removeAttribute('tabindex');
        element.removeAttribute('role');
        element.removeAttribute('aria-label');
      }
    }
    highlights = [];
  }

  function pointsAt(points) {
    return [...new Set(points)].map(point => document.querySelector(`#board [data-point="${point}"]`)).filter(Boolean);
  }

  function targetPoints(state) {
    const points = state.selected != null ? state.hints : Object.keys(state.points).map(Number)
      .filter(point => state.points[point].color === state.turn && window.NarduGame.legalDestinations(state, point).length > 0);
    return pointsAt(points);
  }

  function reveal(element) {
    const body = document.body.classList;
    if (body.contains('board-focus') || body.contains('checker-dragging')) return;
    const rect = element.getBoundingClientRect();
    const top = Math.max(0, slot.getBoundingClientRect().bottom);
    if (rect.top < top + 8 || rect.bottom > document.documentElement.clientHeight - 8) {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }

  function rollControl() {
    return [...history.querySelectorAll('[data-verify-roll]')].find(button => button.dataset.verifyHash === current.rollHash);
  }

  function bearingLesson(state, focused) {
    if (current.offCount >= 2) {
      if (roomLesson === 'fullscreen-enter' && focused) roomLesson = 'fullscreen-exit';
      if (roomLesson === 'fullscreen-exit' && !focused) roomLesson = 'resign';
      const targets = {
        'fullscreen-enter': [expand], 'fullscreen-exit': [collapse], resign: [resign], lobby: [lobby],
      };
      return [roomLesson, targets[roomLesson]];
    }
    if (current.paused) return ['bear-retry', []];
    if (!current.canMove) return null;
    const sources = pointsAt(window.NarduGame.legalNextMoves(state).filter(move => move.bearOff).map(move => move.from));
    if (current.offCount === 0) return ['bear-button', bear?.disabled ? sources : [bear]];
    return ['bear-drag', [...sources, bearTrack]];
  }

  function turnLesson(state) {
    const { confirmedTurns, moveCount, phase, paused, canMove, canConfirm } = current;
    if (paused) return confirmedTurns === 1 ? ['verify', [rollControl()]] : ['home-ready', []];
    if (phase !== 'move') return ['roll', []];
    if (!canMove) return null;
    if (confirmedTurns === 0 && moveCount < previousMoveCount) undone = true;
    previousMoveCount = moveCount;
    if (confirmedTurns === 0 && moveCount > 0 && !undone) return ['undo', [document.getElementById('undo-btn')]];
    if (canConfirm) return ['confirm', [confirm]];
    if (confirmedTurns === 1) return ['drag', targetPoints(state)];
    const step = undone ? 'finish-moves' : state.selected != null ? 'move' : 'select';
    return [step, targetPoints(state)];
  }

  function paint() {
    if (!active || !current) return;
    if (current.phase === 'over') {
      finish('skipped');
      return;
    }
    const state = controller.getState();
    const strings = labels();
    const focused = document.body.classList.contains('board-focus');
    const lesson = current.bearOff ? bearingLesson(state, focused) : turnLesson(state);
    if (!lesson) return;
    const [step, targets] = lesson;
    const verifying = step === 'verify';
    const verify = verifying ? targets[0] : null;
    const result = verify?.closest('.fair-hash')?.querySelector('[data-roll-result]');
    const status = verifying && (verify ? result?.textContent : strings.unavailable);
    proof.hidden = !status;
    if (status && status !== proof.textContent) proof.textContent = status;
    check.disabled = !verify || verify.disabled;
    clearHighlights();
    highlights = targets.filter(Boolean);
    for (const element of highlights) {
      element.classList.add('practice-target');
      if (element.classList.contains('point')) {
        element.tabIndex = 0;
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', `${strings.point} ${element.dataset.point}`);
      }
    }

    const change = lastStep !== step;
    const blockingLesson = verifying || step === 'home-ready' || step === 'bear-retry';
    if (blockingLesson && focused) collapse?.click();
    if (change || title.textContent !== strings[step][0]) {
      const nextLabel = {
        verify: strings.secondTurn, 'home-ready': strings.home, 'bear-retry': strings.retry,
        'fullscreen-enter': strings.next, resign: strings.next,
      }[step];
      guide.dataset.practiceStep = step;
      guide.setAttribute('aria-label', strings.guide);
      progress.textContent = strings.guide;
      [title.textContent, text.textContent] = strings[step];
      if (expand) expand.hidden = blockingLesson || step === 'resign' || step === 'lobby';
      skip.textContent = strings.skip;
      check.textContent = strings.check;
      check.hidden = !verifying;
      next.textContent = nextLabel || '';
      next.hidden = !nextLabel;
    }
    const target = highlights[0];
    if (target && !verifying && (change || keyboardPoint)) reveal(target);
    if (target && keyboardPoint && !target.disabled) target.focus({ preventScroll: true });
    keyboardPoint = false;
    if (change && blockingLesson) (verifying && !check.disabled ? check : next).focus({ preventScroll: true });
    lastStep = step;
  }

  function schedule() {
    if (timer || !active) return;
    timer = requestAnimationFrame(() => {
      timer = 0;
      paint();
    });
  }

  function update(event) {
    current = event.detail;
    schedule();
  }

  function handleKey(event) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      skipGuide();
    } else if (event.key === 'Enter' || event.key === ' ') {
      const point = event.target.closest?.('.point.practice-target');
      if (!point) return;
      event.preventDefault();
      keyboardPoint = true;
      point.click();
    }
  }

  skip.addEventListener('click', skipGuide);
  check.addEventListener('click', () => rollControl()?.click());
  next.addEventListener('click', () => {
    if (lastStep === 'verify') controller.resumePracticeGuide();
    else if (lastStep === 'home-ready' || lastStep === 'bear-retry') controller.startPracticeBearOff();
    else if (lastStep === 'fullscreen-enter' || lastStep === 'resign') {
      roomLesson = lastStep === 'resign' ? 'lobby' : 'resign';
      paint();
    }
  });
  lobby?.addEventListener('click', () => finish(lastStep === 'lobby' ? 'completed' : 'skipped'), { capture: true });
  const observer = new MutationObserver(schedule);
  if (history) observer.observe(history, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status', 'disabled'] });
  window.addEventListener('nardu:practicechange', update);
  window.addEventListener('nardu:langchange', schedule);
  document.addEventListener('keydown', handleKey);
  controller?.setPracticeGuideActive?.(true);
  schedule();
})();
