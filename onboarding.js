(function () {
  'use strict';

  const storagePrefix = 'narduh-onboarding-v1:';
  const lobby = 'index.html';
  const account = 'settings.html';
  const lobbySteps = [
    [lobby, '#game-sessions-title',
      ['Открытые партии', 'В «Игровых сессиях» можно найти открытый стол и присоединиться к партии. Фильтры помогают выбрать длинные или короткие нарды.'],
      ['Open games', 'Find a table in Game Sessions and join it. Use the filters to find long or short backgammon.']],
    [lobby, '[data-action="bot"]',
      ['Игра с ботом', 'Выберите вид нард и сложность бота. В игровой комнате подсвечиваются доступные ходы, а броски можно проверить в истории партии.'],
      ['Play a bot', 'Choose a backgammon variant and bot difficulty. The game room can highlight legal moves, and you can verify rolls from the move history.']],
    [lobby, '[data-action="create"]',
      ['Создать игру', 'Настройте партию и выберите открытую или закрытую комнату. Для закрытой комнаты сообщите сопернику код и пароль.'],
      ['Create a game', 'Choose the game settings and whether to make the room public or private. Share the room code and password for a private game.']],
    [lobby, '[data-action="code"]',
      ['Войти по коду', 'Введите код комнаты, который прислал соперник. Для закрытой игры потребуется пароль.'],
      ['Join by code', 'Enter the room code from your opponent. Private rooms also require a password.']],
    [lobby, '#online-players-title',
      ['Игроки на сайте', 'Здесь видны игроки онлайн и открытые рейтинги. Нажмите «Пригласить» рядом с доступным игроком и выберите длинные или короткие нарды.'],
      ['Players online', 'See who is online and view public ratings. Select Invite next to an available player and choose long or short backgammon.']],
  ];
  const accountSteps = [
    [lobby, '.topnav a[href="settings.html#account"], .user-chip[data-go="settings.html"]',
      ['Личный кабинет', 'Откройте кабинет по ссылке в меню или через свой профиль. Гайд продолжится туда со следующего шага.'],
      ['Your account', 'Open your account from the navigation or your profile button. The next step takes you there.']],
    [account, '#account .account-summary',
      ['Статистика аккаунта', 'Здесь собраны сыгранные партии, победы, поражения и особые результаты. Текущий рейтинг также виден в лобби.'],
      ['Account statistics', 'See games played, wins, losses and special results. You can also see your current rating in the lobby.']],
    [account, '#history .account-block-head',
      ['История партий', 'Здесь можно сверить соперников, результаты и изменения рейтинга по завершённым партиям.'],
      ['Match history', 'Review opponents, results and rating changes from completed matches.']],
    [account, '#messages .message-source-nav',
      ['Сообщения', 'Здесь можно открыть переписку с друзьями и сообщения администрации. Индикатор рядом с разделом показывает непрочитанные сообщения.'],
      ['Messages', 'Open conversations with friends or messages from the site team. The counter shows unread messages.']],
    [account, '#friend-add-form',
      ['Друзья', 'Найдите зарегистрированного игрока по никнейму или email и отправьте заявку в друзья.'],
      ['Friends', 'Find a registered player by nickname or email and send a friend request.']],
    [account, '#game .s-row',
      ['Настройки игры', 'Здесь можно включить подсветку ходов, настроить скорость анимации и звук. Тему и оформление доски можно изменить в разделе «Внешний вид».'],
      ['Game preferences', 'Set move hints, animation speed and sound here. Use Appearance to change the theme and board style.']],
    [account, '#privacy .s-row',
      ['Видимость рейтинга', 'В разделе «Приватность» можно выбрать, увидят ли другие игроки ваш рейтинг.'],
      ['Rating visibility', 'Use Privacy to choose whether other players can see your rating.']],
  ];
  const practiceStep = [lobby, '#start-onboarding',
      ['Пробная партия с ботом', 'Кубики выпадут автоматически. Передвиньте шашку и подтвердите ход. Пробная партия без рейтинга.'],
      ['Practice with a bot', 'The dice roll automatically. Move a checker and confirm your turn. The practice game is unrated.'],
  ];
  const labels = {
    ru: { title: 'Знакомство с сайтом', guestIntro: 'Гайд покажет, как найти соперника, начать игру без регистрации и сыграть пробную партию с ботом.', intro: 'Гайд покажет, как начать партию, пригласить игрока и пользоваться личным кабинетом.',
      start: 'Начать', launch: 'Гайд по сайту', skip: 'Пропустить', back: 'Назад', next: 'Далее',
      account: 'В кабинет', lobby: 'В лобби', practice: 'В пробную партию', step: 'Шаг' },
    en: { title: 'Welcome to the site', guestIntro: 'See how to find an opponent, start a game as a guest and play a practice game with a bot.', intro: 'This guide shows how to start a game, invite a player and use your account.',
      start: 'Start', launch: 'Site guide', skip: 'Skip', back: 'Back', next: 'Next',
      account: 'Open account', lobby: 'Back to lobby', practice: 'Play a practice game', step: 'Step' },
  };
  const language = () => document.documentElement.lang === 'en' ? 'en' : 'ru';
  const page = location.pathname.endsWith('/settings.html') ? account : lobby;
  let progressKey;
  let guest;
  let steps;
  let state;
  let dialog;
  let view;
  let anchor;
  let frame;
  let observer;
  let previousFocus;

  function keyFor(user) {
    return user?.id ? storagePrefix + (user.guest === true ? 'guest' : user.id) : null;
  }

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); }
    catch { return null; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* Continue the tour in this document if storage is unavailable. */ }
  }

  function enroll(id) {
    if (typeof id !== 'string' || !id) return;
    const key = keyFor({ id });
    if (!read(key)) write(key, { status: 'pending', step: 0 });
  }
  window.NarduOnboarding = { enroll, keyFor };

  function setState(status, step = state?.step || 0) {
    state = { status, step };
    write(progressKey, state);
  }

  function createDialog() {
    dialog = document.createElement('dialog');
    dialog.id = 'onboarding-dialog';
    dialog.className = 'onboarding-dialog';
    dialog.setAttribute('aria-labelledby', 'onboarding-title');
    dialog.setAttribute('aria-describedby', 'onboarding-text');
    dialog.innerHTML = `
      <div class="onboarding-shade" aria-hidden="true"></div>
      <div class="onboarding-shade" aria-hidden="true"></div>
      <div class="onboarding-shade" aria-hidden="true"></div>
      <div class="onboarding-shade" aria-hidden="true"></div>
      <div class="onboarding-spotlight" aria-hidden="true"></div>
      <div class="onboarding-card">
        <div class="onboarding-card-header">
          <span class="onboarding-guide" aria-hidden="true"></span>
          <div>
            <p class="onboarding-progress"></p>
            <h2 id="onboarding-title" class="onboarding-title" tabindex="-1"></h2>
          </div>
        </div>
        <p id="onboarding-text" class="onboarding-text"></p>
        <div class="onboarding-controls">
          <button type="button" class="onboarding-skip"></button>
          <button type="button" class="onboarding-back"></button>
          <button type="button" class="onboarding-next"></button>
        </div>
      </div>`;
    const part = name => dialog.querySelector(`.onboarding-${name}`);
    view = {
      card: part('card'), shades: [...dialog.querySelectorAll('.onboarding-shade')], spotlight: part('spotlight'),
      progress: part('progress'), title: part('title'), text: part('text'),
      skip: part('skip'), back: part('back'), next: part('next'),
    };
    view.next.addEventListener('click', () => {
      if (state.status === 'pending') goToStep(0);
      else if (state.step === steps.length - 1) {
        setState('practice');
        location.assign('room.html?practice=1');
      }
      else goToStep(state.step + 1);
    });
    view.back.addEventListener('click', () => goToStep(state.step - 1));
    view.skip.addEventListener('click', () => finish('skipped'));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      finish('skipped');
    });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const controls = [view.skip, view.back, view.next].filter(button => !button.hidden);
      const boundary = event.shiftKey ? controls.at(0) : controls.at(-1);
      if (document.activeElement !== boundary) return;
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls.at(0)).focus();
    });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      observer?.disconnect();
      const focusTarget = previousFocus instanceof HTMLElement && previousFocus !== document.body
        ? previousFocus : document.querySelector('[data-onboarding-start]');
      focusTarget?.focus({ preventScroll: true });
    });
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('scroll', scheduleLayout, { passive: true });
    window.visualViewport?.addEventListener('resize', scheduleLayout);
    window.visualViewport?.addEventListener('scroll', scheduleLayout);
    if (typeof ResizeObserver === 'function') observer = new ResizeObserver(scheduleLayout);
    document.body.append(dialog);
  }

  function finish(status) {
    setState(status);
    dialog.close();
  }

  function goToStep(step) {
    if (!steps[step]) return;
    const [destination] = steps[step];
    setState('active', step);
    if (destination !== page) {
      location.assign(destination);
      return;
    }
    render(true);
  }

  function render(scrollToTarget = false) {
    if (!dialog) createDialog();
    const lang = language();
    const copy = labels[lang];
    const pending = state.status === 'pending';
    const step = pending ? null : steps[state.step];
    const [title, text] = step ? step[lang === 'ru' ? 2 : 3] : [copy.title, guest ? copy.guestIntro : copy.intro];
    view.title.textContent = title;
    view.text.textContent = text;
    view.progress.hidden = pending;
    view.progress.textContent = pending ? '' : `${copy.step} ${state.step + 1} / ${steps.length}`;
    view.skip.textContent = copy.skip;
    view.back.textContent = copy.back;
    view.back.hidden = pending || state.step === 0;
    const nextPage = steps[state.step + 1]?.[0];
    view.next.textContent = pending ? copy.start : !nextPage ? copy.practice
      : nextPage === page ? copy.next : nextPage === account ? copy.account : copy.lobby;
    anchor = step ? [...document.querySelectorAll(step[1])].find(node => node.getClientRects().length > 0) : null;
    if (scrollToTarget && anchor) anchor.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (!dialog.open) {
      previousFocus = document.activeElement;
      dialog.showModal();
      observer?.observe(document.querySelector('.app') || document.body);
      observer?.observe(view.card);
    }
    if (scrollToTarget) {
      view.card.scrollTop = 0;
      view.title.focus({ preventScroll: true });
    }
    layout();
    scheduleLayout();
  }

  function place(node, x, y, w, h) {
    Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  }

  function layout() {
    if (!dialog?.open) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || document.documentElement.clientWidth);
    const bottom = top + (viewport?.height || document.documentElement.clientHeight);
    const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
    const box = anchor?.getBoundingClientRect();
    const shown = box && box.width && box.height && box.right > left && box.left < right && box.bottom > top && box.top < bottom;
    const x = shown ? clamp(box.left - 5, left, right) : right;
    const y = shown ? clamp(box.top - 5, top, bottom) : bottom;
    const r = shown ? clamp(box.right + 5, left, right) : right;
    const b = shown ? clamp(box.bottom + 5, top, bottom) : bottom;
    const [above, below, before, after] = view.shades;
    place(above, left, top, right - left, y - top);
    place(below, left, b, right - left, bottom - b);
    place(before, left, y, x - left, b - y);
    place(after, r, y, right - r, b - y);
    view.spotlight.hidden = !shown;
    if (shown) place(view.spotlight, x, y, r - x, b - y);

    const gap = 12;
    view.card.style.maxWidth = `${Math.max(0, right - left - 2 * gap)}px`;
    view.card.style.maxHeight = `${Math.max(0, bottom - top - 2 * gap)}px`;
    const { width: w, height: h } = view.card.getBoundingClientRect();
    const centerX = shown ? (x + r - w) / 2 : (left + right - w) / 2;
    const centerY = (top + bottom - h) / 2;
    let cardX = centerX;
    let cardY = centerY;
    if (shown) {
      if (b + h + 2 * gap <= bottom) cardY = b + gap;
      else if (y - h - 2 * gap >= top) cardY = y - h - gap;
      else if (r + w + 2 * gap <= right || x - w - 2 * gap >= left) {
        cardX = r + w + 2 * gap <= right ? r + gap : x - w - gap;
        cardY = y;
      } else cardY = bottom - b >= y - top ? bottom - h - gap : top + gap;
    }
    view.card.style.left = `${clamp(cardX, left + gap, right - w - gap)}px`;
    view.card.style.top = `${clamp(cardY, top + gap, bottom - h - gap)}px`;
  }

  function scheduleLayout() {
    if (!dialog?.open || frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      layout();
    });
  }

  function initialize() {
    const buttons = [...document.querySelectorAll('[data-onboarding-start]')];
    const user = window.NarduApp?.getUser();
    if (!buttons.length || !user?.id || (user.guest && page !== lobby) || window.NARDU_ENTRY_BLOCKED
      || typeof document.createElement('dialog').showModal !== 'function') return;
    guest = user.guest === true;
    steps = [...lobbySteps, ...(guest ? [] : accountSteps), practiceStep];
    progressKey = keyFor(user);
    const localize = () => {
      for (const button of buttons) button.textContent = labels[language()].launch;
      if (dialog?.open) render();
    };
    for (const button of buttons) {
      button.hidden = false;
      button.addEventListener('click', () => goToStep(page === lobby ? 0 : steps.findIndex(step => step[0] === account)));
    }
    window.addEventListener('nardu:langchange', localize);
    localize();
    const resume = () => {
      state = read(progressKey);
      if (page === lobby && new URLSearchParams(location.search).has('join')) return;
      if (guest && !state) setState('pending', 0);
      if ((state?.status === 'pending' && page === lobby)
        || (state?.status === 'active' && steps[state.step]?.[0] === page)) render(true);
    };
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      if (dialog?.open) dialog.close();
      resume();
    });
    resume();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
