(function () {
  'use strict';

  const slot = document.getElementById('practice-guide-slot');
  if (!slot || !document.body.classList.contains('practice-room')) return;
  const player = window.NarduApp?.getUser();
  const key = window.NarduOnboarding?.keyFor(player);
  const lobby = 'index.html';
  let undoShown = false;
  let undone = false;
  let previousMoveCount = 0;
  let firstRollHash = '';
  let lastStep;
  let active = true;
  let highlights = [];
  let timer = 0;
  const copy = {
    ru: {
      guide: 'Пробная партия', skip: 'Пропустить гайд', leave: 'В лобби', done: 'Продолжить игру', point: 'Пункт',
      roll: ['Автоматический бросок', 'Вы играете белыми в длинные нарды. После броска выберите шашку.'],
      select: ['Выберите шашку', 'Нажмите на подсвеченную белую шашку. После выбора подсветятся доступные пункты.'],
      move: ['Передвиньте шашку', 'Нажмите на один из подсвеченных пунктов. Шашка переместится на выбранное место.'],
      undo: ['Попробуйте отмену', 'Нажмите «Отменить ход», чтобы вернуть последнее перемещение. Дальше можно сыграть тот же ход или выбрать другой.'],
      'finish-moves': ['Сыграйте оставшиеся значения', 'Выберите белую шашку и доступный пункт. Используйте значения на кубиках, пока не станет доступно подтверждение.'],
      confirm: ['Подтвердите ход', 'Нажмите «Подтвердить ход». После этого ход перейдёт к боту.'],
      verify: ['Проверьте свой бросок', 'В «Ходе партии» нажмите «Проверить» рядом со своим броском. В пробной партии проверка сверяет кубики с записью SHA‑256, созданной в браузере.'],
      complete: ['Ход завершён', 'Вы передвинули шашку, подтвердили ход и проверили бросок. Можно продолжить партию или вернуться в лобби.'],
    },
    en: {
      guide: 'Practice game', skip: 'Skip guide', leave: 'Back to lobby', done: 'Keep playing', point: 'Point',
      roll: ['Automatic dice roll', 'You are playing white in long backgammon. Choose a checker once the dice settle.'],
      select: ['Choose a checker', 'Select the highlighted white checker to see its available destinations.'],
      move: ['Move the checker', 'Select a highlighted point to move the checker there.'],
      undo: ['Try undoing a move', 'Select Undo move to put the last checker back. You can then play the same move or choose a different one.'],
      'finish-moves': ['Play the remaining dice', 'Choose a white checker and an available destination. Use the dice until the turn can be confirmed.'],
      confirm: ['Confirm your turn', 'Select Confirm turn to pass play to the bot.'],
      verify: ['Check your roll', 'Select Check roll beside your roll in the move history. In practice, this compares the dice with the SHA‑256 record created in your browser.'],
      complete: ['Turn complete', 'You moved a checker, confirmed your turn and checked your roll. You can keep playing or return to the lobby.'],
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
    } catch { /* The practice game is still playable in this document. */ }
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
      </div>
      <div class="practice-guide-actions">
        <button class="ghostbtn practice-guide-skip" type="button"></button>
        <a class="ghostbtn practice-guide-lobby" hidden></a>
        <button class="pillbtn practice-guide-next" type="button" hidden></button>
      </div>
    </aside>`;
  const guide = slot.firstElementChild;
  const title = guide.querySelector('.onboarding-title');
  const text = guide.querySelector('.onboarding-text');
  const progress = guide.querySelector('.onboarding-progress');
  const skip = guide.querySelector('.practice-guide-skip');
  const leave = guide.querySelector('.practice-guide-lobby');
  const next = guide.querySelector('.practice-guide-next');
  const history = document.getElementById('history-list');
  const confirm = document.getElementById('practice-confirm');
  let current = window.NarduController?.getPracticeStatus?.();
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
    const restoreFocus = guide.contains(document.activeElement);
    slot.hidden = true;
    if (restoreFocus) (document.querySelector('.practice-action:enabled') || document.querySelector('[data-room-lobby]'))?.focus({ preventScroll: true });
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

  function targetPoints(state) {
    const points = state.selected != null ? state.hints : Object.keys(state.points).map(Number)
      .filter(point => state.points[point].color === state.turn && window.NarduGame.legalDestinations(state, point).length > 0);
    return [...new Set(points)].map(point => document.querySelector(`#board [data-point="${point}"]`)).filter(Boolean);
  }

  function reveal(element) {
    const rect = element.getBoundingClientRect();
    const top = Math.max(0, slot.getBoundingClientRect().bottom);
    if (rect.top < top + 8 || rect.bottom > document.documentElement.clientHeight - 8) {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }

  function paint() {
    if (!active || !current) return;
    if (current.phase === 'over' && lastStep !== 'complete') {
      finish('skipped');
      return;
    }
    const state = window.NarduController.getState();
    const strings = labels();
    const { moveCount, phase, canMove } = current;
    if (!firstRollHash && current.rollHash) firstRollHash = current.rollHash;
    if (moveCount > 0 && !current.confirmed) undoShown = true;
    if (undoShown && moveCount < previousMoveCount && !current.confirmed) undone = true;
    previousMoveCount = moveCount;
    const verify = [...history.querySelectorAll('[data-verify-roll]')].find(button => button.dataset.verifyHash === firstRollHash);
    const result = verify?.closest('.fair-hash')?.querySelector('[data-roll-result]');
    let step = 'roll';
    let targets = [];
    if (current.confirmed) {
      const matched = ['matched', 'verified'].includes(result?.dataset.status);
      step = lastStep === 'complete' || matched ? 'complete' : 'verify';
      targets = step === 'verify' ? [verify] : [];
    } else if (phase === 'move' && canMove) {
      if (undoShown && !undone) {
        step = 'undo';
        targets = [document.getElementById('undo-btn')];
      } else if (current.canConfirm) {
        step = 'confirm';
        targets = [confirm];
      } else {
        step = undone ? 'finish-moves' : state.selected != null ? 'move' : 'select';
        targets = targetPoints(state);
      }
    } else if (phase === 'move' && lastStep) {
      return;
    }

    const focusedTarget = highlights.find(element => element === document.activeElement);
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
    if (change || title.textContent !== strings[step][0]) {
      guide.dataset.practiceStep = step;
      guide.setAttribute('aria-label', strings.guide);
      progress.textContent = strings.guide;
      [title.textContent, text.textContent] = strings[step];
      skip.textContent = strings.skip;
      skip.hidden = step === 'complete';
      leave.textContent = strings.leave;
      leave.hidden = step !== 'complete';
      leave.href = lobby;
      next.textContent = strings.done;
      next.hidden = step !== 'complete';
      if (step === 'complete') save('completed');
    }
    const target = highlights[0];
    if (target && (change || keyboardPoint)) reveal(target);
    if (target && keyboardPoint && !target.disabled) target.focus({ preventScroll: true });
    keyboardPoint = false;
    if (step === 'complete' && change && focusedTarget === verify) next.focus({ preventScroll: true });
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
      finish(lastStep === 'complete' ? 'completed' : 'skipped');
    } else if (event.key === 'Enter' || event.key === ' ') {
      const point = event.target.closest?.('.point.practice-target');
      if (!point) return;
      event.preventDefault();
      keyboardPoint = true;
      point.click();
    }
  }

  skip.addEventListener('click', () => finish('skipped'));
  next.addEventListener('click', () => finish('completed'));
  const observer = new MutationObserver(schedule);
  observer.observe(history, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] });
  window.addEventListener('nardu:practicechange', update);
  window.addEventListener('nardu:langchange', schedule);
  document.addEventListener('keydown', handleKey);
  schedule();
})();
