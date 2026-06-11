/* ─── shared app logic — theme, lang, auth, top-bar wiring ─── */
(function () {
  const THEME_KEY = 'narduh-theme';
  const LANG_KEY = 'narduh-lang';
  const USER_KEY = 'narduh-user';
  const SOUND_KEY = 'narduh-sound';
  const SHOW_RATING_KEY = 'narduh-show-rating';
  const ACCENT_KEY = 'narduh-accent';
  const BOARD_STYLE_KEY = 'narduh-board-style';
  const DEFAULT_RATING = 1000;
  const ACCENTS = {
    amber: { accent: 'oklch(0.78 0.13 78)', soft: 'oklch(0.78 0.13 78 / 0.16)' },
    green: { accent: 'oklch(0.74 0.15 155)', soft: 'oklch(0.74 0.15 155 / 0.16)' },
    turn: { accent: 'oklch(0.65 0.20 25)', soft: 'oklch(0.65 0.20 25 / 0.15)' },
    azure: { accent: 'oklch(0.65 0.18 260)', soft: 'oklch(0.65 0.18 260 / 0.16)' },
    lilac: { accent: 'oklch(0.70 0.16 320)', soft: 'oklch(0.70 0.16 320 / 0.16)' },
  };
  const BOARD_STYLES = new Set(['wood', 'bone', 'stone']);
  const RATING_TIERS = [
    { name: 'Diamond', min: 2100, key: 'tier_diamond' },
    { name: 'Platinum', min: 1800, key: 'tier_platinum' },
    { name: 'Gold', min: 1500, key: 'tier_gold' },
    { name: 'Silver', min: 1200, key: 'tier_silver' },
    { name: 'Bronze', min: 0, key: 'tier_bronze' },
  ];

  /* ── THEME ── */
  function applyTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem(THEME_KEY, name);
    document.querySelectorAll('[data-theme-set]').forEach(b =>
      b.classList.toggle('active', b.dataset.themeSet === name));
  }
  function currentTheme() {
    return localStorage.getItem(THEME_KEY) || 'night';
  }
  applyTheme(currentTheme());

  function currentAccent() {
    const saved = localStorage.getItem(ACCENT_KEY);
    return ACCENTS[saved] ? saved : 'amber';
  }
  function applyAccent(name) {
    const key = ACCENTS[name] ? name : 'amber';
    const palette = ACCENTS[key];
    document.documentElement.style.setProperty('--accent', palette.accent);
    document.documentElement.style.setProperty('--accent-soft', palette.soft);
    localStorage.setItem(ACCENT_KEY, key);
    document.querySelectorAll('[data-accent-set]').forEach(b =>
      b.classList.toggle('active', b.dataset.accentSet === key));
  }
  applyAccent(currentAccent());

  function currentBoardStyle() {
    const saved = localStorage.getItem(BOARD_STYLE_KEY);
    return BOARD_STYLES.has(saved) ? saved : 'wood';
  }
  function applyBoardStyle(name) {
    const style = BOARD_STYLES.has(name) ? name : 'wood';
    document.documentElement.setAttribute('data-board-style', style);
    localStorage.setItem(BOARD_STYLE_KEY, style);
    document.querySelectorAll('[data-board-style-set]').forEach(b =>
      b.classList.toggle('active', b.dataset.boardStyleSet === style));
  }
  applyBoardStyle(currentBoardStyle());

  /* ── LANG ── */
  const dicts = {
    ru: {
      title_login: 'Нарды — Вход',
      title_register: 'Нарды — Регистрация',
      title_lobby: 'Нарды — Лобби',
      title_settings: 'Нарды — Настройки',
      brand_name: 'Нарды',
      brand_mark: 'Н',
      brand_sub: 'длинные · короткие · онлайн',
      nav_lobby: 'Лобби',
      nav_settings: 'Настройки',
      day: 'День', night: 'Ночь',
      logout: 'Выйти',
      vs: 'против',
      sound: 'Звук',
      sound_on: 'Звук включён',
      sound_off: 'Звук выключен',
      profile: 'Профиль',
      settings_icon: 'Настройки',
      show_password: 'Показать пароль',
      hide_password: 'Скрыть пароль',
      // lobby
      lobby_title: 'Лобби',
      lobby_ready_prefix: 'Готовы к партии, ',
      lobby_ready_suffix: '?',
      lobby_sub: 'Выберите формат — мы найдём соперника или соберём стол под вас.',
      qs_online: 'сейчас в сети',
      qs_games: 'партий идёт',
      qs_rating: 'ваш рейтинг',
      unrated: 'Без рейтинга',
      tier_bronze: 'Бронза',
      tier_silver: 'Серебро',
      tier_gold: 'Золото',
      tier_platinum: 'Платина',
      tier_diamond: 'Бриллиант',
      play_quick: 'Быстрая игра',
      play_quick_sub: 'Подберём соперника по рейтингу',
      play_create: 'Создать игру',
      play_create_sub: 'Настроить соперника и доступ',
      play_code: 'По коду',
      play_code_sub: 'Сыграть с другом по приглашению',
      long_backgammon: 'Длинные нарды',
      short_backgammon: 'Короткие нарды',
      create_game_title: 'Создать игру',
      create_game_text: 'Выберите параметры партии перед переходом на игровую доску.',
      hide: 'Скрыть',
      opponent_choice: 'Выбор соперника',
      opponent_player: 'Игрок',
      opponent_bot: 'Бот',
      bot_difficulty: 'Сложность бота',
      difficulty_easy: 'Лёгкий',
      difficulty_medium: 'Средний',
      difficulty_hard: 'Сложный',
      game_variant: 'Вид нард',
      access: 'Доступ',
      access_open: 'Открытая',
      access_closed: 'Закрытая',
      closed_game_password: 'Пароль закрытой игры',
      closed_game_password_ph: 'Например: 1234 или secret',
      closed_game_password_hint: 'Этот пароль сообщите сопернику для входа в закрытую игру.',
      join_by_code_title: 'Войти по коду',
      join_by_code_text: 'Введите код закрытой или открытой комнаты, который сообщил соперник.',
      room_code: 'Код комнаты',
      room_code_ph: 'Например: A7K2',
      room_password_ph: 'Если комната закрытая',
      filters_all: 'Все',
      filters_long: 'Длинные',
      filters_short: 'Короткие',
      filters_friends: 'Друзья',
      filters_in_game: 'В игре',
      updated_now: 'Обновлено только что',
      refresh: 'Обновить',
      season_7: 'сезон 7',
      friends_count: 'друзей',
      status_playing: 'играет',
      status_free: 'свободен',
      invite: 'Пригласить',
      return_to_room: 'Вернуться',
      in_game: 'В игре',
      waiting: 'Ожидает',
      open_room: 'Открытая',
      closed_room: 'Закрытая',
      opponent_waiting: 'Ожидание соперника',
      room_opponent: 'Соперник',
      bot_easy: 'Бот лёгкий',
      bot_medium: 'Бот средний',
      bot_hard: 'Бот сложный',
      no_sessions: 'Под этот фильтр сейчас нет игровых сессий.',
      err_session: 'Ошибка игровой сессии.',
      err_closed_password_min: 'Введите пароль закрытой игры минимум из 4 символов.',
      err_create_session: 'Не удалось создать игровую сессию.',
      err_enter_room_code: 'Введите код комнаты.',
      err_join_room: 'Не удалось войти в комнату.',
      open_tables: 'ИГРОВЫЕ СЕССИИ',
      online_now: 'Сейчас в сети',
      leaderboard: 'Лидерборд',
      recent_games: 'Недавние партии',
      join: 'Войти',
      // settings
      settings_title: 'Настройки',
      settings_sub: 'Личные предпочтения и параметры партий',
      sec_appearance: 'Внешний вид',
      sec_game: 'Игра',
      sec_account: 'Аккаунт',
      sec_notify: 'Уведомления',
      sec_privacy: 'Приватность',
      theme: 'Тема',
      theme_hint: 'Выбор сохраняется сразу',
      interface_language: 'Язык интерфейса',
      interface_language_hint: 'Перевод применяется сразу',
      russian: 'Русский',
      english: 'English',
      accent_color: 'Цвет акцента',
      accent_color_hint: 'Подсветка ваших ходов и кнопок',
      amber: 'Янтарь',
      green: 'Зелёный',
      turn: 'Тёрн',
      azure: 'Лазурь',
      lilac: 'Сирень',
      board_style: 'Стиль доски',
      board_style_hint: 'Текстура и тон сукна',
      wood: 'Дерево',
      bone: 'Кость',
      stone: 'Камень',
      animations: 'Анимации',
      animations_hint: 'Плавность ходов и кубиков',
      auto_roll: 'Авто-бросок кубиков',
      auto_roll_hint: 'Сразу после хода соперника',
      move_hints: 'Подсветка возможных ходов',
      move_hints_hint: 'Поля, куда можно поставить шашку',
      move_confirm: 'Подтверждение хода',
      move_confirm_hint: 'Запрос «применить» перед окончанием',
      animation_speed: 'Скорость анимации',
      animation_speed_hint: 'Чем меньше — тем быстрее',
      sounds: 'Звуки',
      sounds_hint: 'Кубики, ходы, уведомления',
      volume: 'Громкость',
      nickname_visible_hint: 'Видно соперникам в партии',
      save: 'Сохранить',
      email_hint: 'Используется для входа и восстановления',
      change: 'Изменить',
      password_change_hint: 'Для смены пароля укажите текущий пароль',
      current_password: 'Текущий пароль',
      new_password: 'Новый пароль',
      repeat_password: 'Повторите пароль',
      save_password: 'Сохранить пароль',
      sign_out_account: 'Выйти из аккаунта',
      sign_out_hint: 'Можно вернуться в любой момент',
      delete_account: 'Удалить аккаунт',
      delete_account_hint: 'Полное удаление профиля и истории',
      delete: 'Удалить',
      delete_account_question: 'Желаете удалить аккаунт?',
      yes: 'Да',
      no: 'Нет',
      tournaments_events: 'Турниры и события',
      weekly: 'Раз в неделю',
      show_rating: 'Показывать рейтинг другим',
      show_rating_hint: 'В лобби и в комнате',
      friends: 'Друзья',
      match_history: 'История партий',
      match_history_hint: 'Скачать архив ходов и кубиков',
      download_json: 'Скачать .json',
      // login
      welcome: 'Добро пожаловать',
      welcome_sub: 'Войдите, чтобы начать партию',
      auth_login_eyebrow: 'длинные нарды · онлайн',
      auth_login_headline: 'Играй с друзьями или ищи сильного соперника по рейтингу.',
      auth_login_headline_html: 'Играй с друзьями <em>или ищи</em> сильного соперника по рейтингу.',
      auth_bullet_fair: 'Провабли-фейр кубики с публикуемыми хэшами',
      auth_bullet_chat: 'Голосовой и текстовый чат за партией',
      auth_bullet_rating: 'Рейтинг ELO + сезоны и трофеи',
      auth_bullet_variants: 'Поддержка длинных и коротких нард',
      login: 'Войти',
      register: 'Регистрация',
      identifier: 'Никнейм или email',
      nickname: 'Никнейм',
      email: 'Email',
      password: 'Пароль',
      password_confirm: 'Подтвердите пароль',
      remember: 'Запомнить меня',
      forgot: 'Забыли пароль?',
      recovery_title: 'Восстановление пароля',
      recovery_text: 'Введите email аккаунта. Мы отправим код восстановления.',
      recovery_code: 'Код из письма',
      new_password: 'Новый пароль',
      send_code: 'Отправить код',
      change_password_submit: 'Сменить пароль',
      no_account: 'Нет аккаунта?',
      have_account: 'Уже есть аккаунт?',
      create_account: 'Создать аккаунт',
      continue_guest: 'Продолжить как гость',
      or_continue: 'или продолжите через',
      auth_register_eyebrow: 'создайте аккаунт',
      auth_register_headline_html: 'Личный рейтинг <em>и история партий</em>, сезоны, друзья и приватные комнаты.',
      auth_reg_bullet_name: 'Никнейм останется с вами навсегда',
      auth_reg_bullet_free: 'Бесплатно — и всегда без рекламы',
      auth_reg_bullet_import: 'Импорт прогресса с других платформ',
      tos_html: 'Согласен с <a href="#" class="auth-link">правилами</a> и <a href="#" class="auth-link">политикой конфиденциальности</a>',
      footer_brand: 'Нарды Онлайн',
      rules: 'Правила игры',
      support: 'Поддержка',
      err_auth: 'Ошибка авторизации.',
      err_register: 'Ошибка регистрации.',
      err_passwords_mismatch: 'Пароли не совпадают.',
      msg_recovery_code_sent: 'Код восстановления отправлен.',
      msg_password_changed: 'Пароль изменён. Войдите с новым паролем.',
      msg_account_created: 'Аккаунт создан.',
      msg_confirm_email: 'Аккаунт создан. Проверьте email и подтвердите регистрацию.',
    },
    en: {
      title_login: 'Backgammon — Sign in',
      title_register: 'Backgammon — Sign up',
      title_lobby: 'Backgammon — Lobby',
      title_settings: 'Backgammon — Settings',
      brand_name: 'Backgammon',
      brand_mark: 'B',
      brand_sub: 'long · short · online',
      nav_lobby: 'Lobby',
      nav_settings: 'Settings',
      day: 'Day', night: 'Night',
      logout: 'Sign out',
      vs: 'vs',
      sound: 'Sound',
      sound_on: 'Sound on',
      sound_off: 'Sound off',
      profile: 'Profile',
      settings_icon: 'Settings',
      show_password: 'Show password',
      hide_password: 'Hide password',
      lobby_title: 'Lobby',
      lobby_ready_prefix: 'Ready for a game, ',
      lobby_ready_suffix: '?',
      lobby_sub: 'Choose a format — we will find an opponent or set up a table for you.',
      qs_online: 'online now',
      qs_games: 'games live',
      qs_rating: 'your rating',
      unrated: 'Unrated',
      tier_bronze: 'Bronze',
      tier_silver: 'Silver',
      tier_gold: 'Gold',
      tier_platinum: 'Platinum',
      tier_diamond: 'Diamond',
      play_quick: 'Quick match',
      play_quick_sub: 'We will find you a rated opponent',
      play_create: 'Create game',
      play_create_sub: 'Choose opponent and access',
      play_code: 'By code',
      play_code_sub: 'Play with a friend via invite link',
      long_backgammon: 'Long backgammon',
      short_backgammon: 'Short backgammon',
      create_game_title: 'Create game',
      create_game_text: 'Choose match settings before moving to the board.',
      hide: 'Hide',
      opponent_choice: 'Opponent',
      opponent_player: 'Player',
      opponent_bot: 'Bot',
      bot_difficulty: 'Bot difficulty',
      difficulty_easy: 'Easy',
      difficulty_medium: 'Medium',
      difficulty_hard: 'Hard',
      game_variant: 'Backgammon type',
      access: 'Access',
      access_open: 'Open',
      access_closed: 'Private',
      closed_game_password: 'Private game password',
      closed_game_password_ph: 'For example: 1234 or secret',
      closed_game_password_hint: 'Share this password with your opponent to enter the private game.',
      join_by_code_title: 'Enter by code',
      join_by_code_text: 'Enter the code for the private or open room your opponent shared.',
      room_code: 'Room code',
      room_code_ph: 'For example: A7K2',
      room_password_ph: 'If the room is private',
      filters_all: 'All',
      filters_long: 'Long',
      filters_short: 'Short',
      filters_friends: 'Friends',
      filters_in_game: 'In game',
      updated_now: 'Updated just now',
      refresh: 'Refresh',
      season_7: 'season 7',
      friends_count: 'friends',
      status_playing: 'playing',
      status_free: 'available',
      invite: 'Invite',
      return_to_room: 'Return',
      in_game: 'In game',
      waiting: 'Waiting',
      open_room: 'Open',
      closed_room: 'Private',
      opponent_waiting: 'Waiting for opponent',
      room_opponent: 'Opponent',
      bot_easy: 'Bot easy',
      bot_medium: 'Bot medium',
      bot_hard: 'Bot hard',
      no_sessions: 'No game sessions match this filter right now.',
      err_session: 'Game session error.',
      err_closed_password_min: 'Enter a private game password of at least 4 characters.',
      err_create_session: 'Could not create a game session.',
      err_enter_room_code: 'Enter the room code.',
      err_join_room: 'Could not enter the room.',
      open_tables: 'Game sessions',
      online_now: 'Online now',
      leaderboard: 'Leaderboard',
      recent_games: 'Recent games',
      join: 'Join',
      settings_title: 'Settings',
      settings_sub: 'Personal preferences and match settings',
      sec_appearance: 'Appearance',
      sec_game: 'Gameplay',
      sec_account: 'Account',
      sec_notify: 'Notifications',
      sec_privacy: 'Privacy',
      theme: 'Theme',
      theme_hint: 'Saved immediately',
      interface_language: 'Interface language',
      interface_language_hint: 'Translation applies immediately',
      russian: 'Russian',
      english: 'English',
      accent_color: 'Accent color',
      accent_color_hint: 'Highlights your moves and buttons',
      amber: 'Amber',
      green: 'Green',
      turn: 'Turn',
      azure: 'Azure',
      lilac: 'Lilac',
      board_style: 'Board style',
      board_style_hint: 'Texture and felt tone',
      wood: 'Wood',
      bone: 'Bone',
      stone: 'Stone',
      animations: 'Animations',
      animations_hint: 'Smoothness of moves and dice',
      auto_roll: 'Auto-roll dice',
      auto_roll_hint: 'Right after the opponent moves',
      move_hints: 'Highlight legal moves',
      move_hints_hint: 'Points where a checker can move',
      move_confirm: 'Move confirmation',
      move_confirm_hint: 'Ask to apply before ending the turn',
      animation_speed: 'Animation speed',
      animation_speed_hint: 'Lower means faster',
      sounds: 'Sounds',
      sounds_hint: 'Dice, moves, notifications',
      volume: 'Volume',
      nickname_visible_hint: 'Visible to opponents during a match',
      save: 'Save',
      email_hint: 'Used for sign-in and recovery',
      change: 'Change',
      password_change_hint: 'Enter the current password to change it',
      current_password: 'Current password',
      new_password: 'New password',
      repeat_password: 'Repeat password',
      save_password: 'Save password',
      sign_out_account: 'Sign out of account',
      sign_out_hint: 'You can come back at any time',
      delete_account: 'Delete account',
      delete_account_hint: 'Fully remove profile and history',
      delete: 'Delete',
      delete_account_question: 'Do you want to delete the account?',
      yes: 'Yes',
      no: 'No',
      tournaments_events: 'Tournaments and events',
      weekly: 'Once a week',
      show_rating: 'Show rating to others',
      show_rating_hint: 'In the lobby and room',
      friends: 'Friends',
      match_history: 'Match history',
      match_history_hint: 'Download move and dice archive',
      download_json: 'Download .json',
      welcome: 'Welcome back',
      welcome_sub: 'Sign in to start a match',
      auth_login_eyebrow: 'long backgammon · online',
      auth_login_headline: 'Play with friends or find a strong rated opponent.',
      auth_login_headline_html: 'Play with friends <em>or find</em> a strong rated opponent.',
      auth_bullet_fair: 'Provably fair dice with published hashes',
      auth_bullet_chat: 'Voice and text chat during the match',
      auth_bullet_rating: 'ELO rating, seasons, and trophies',
      auth_bullet_variants: 'Long and short backgammon support',
      login: 'Sign in',
      register: 'Sign up',
      identifier: 'Nickname or email',
      nickname: 'Nickname',
      email: 'Email',
      password: 'Password',
      password_confirm: 'Confirm password',
      remember: 'Remember me',
      forgot: 'Forgot password?',
      recovery_title: 'Password recovery',
      recovery_text: 'Enter your account email. We will send a recovery code.',
      recovery_code: 'Email code',
      new_password: 'New password',
      send_code: 'Send code',
      change_password_submit: 'Change password',
      no_account: 'No account?',
      have_account: 'Already have an account?',
      create_account: 'Create account',
      continue_guest: 'Continue as guest',
      or_continue: 'or continue with',
      auth_register_eyebrow: 'create an account',
      auth_register_headline_html: 'Personal rating <em>and match history</em>, seasons, friends, and private rooms.',
      auth_reg_bullet_name: 'Your nickname stays with you forever',
      auth_reg_bullet_free: 'Free and always ad-free',
      auth_reg_bullet_import: 'Progress import from other platforms',
      tos_html: 'I agree to the <a href="#" class="auth-link">rules</a> and <a href="#" class="auth-link">privacy policy</a>',
      footer_brand: 'Online Backgammon',
      rules: 'Game rules',
      support: 'Support',
      err_auth: 'Authentication error.',
      err_register: 'Registration error.',
      err_passwords_mismatch: 'Passwords do not match.',
      msg_recovery_code_sent: 'Recovery code sent.',
      msg_password_changed: 'Password changed. Sign in with the new password.',
      msg_account_created: 'Account created.',
      msg_confirm_email: 'Account created. Check your email and confirm registration.',
    },
  };

  const serverMessageTranslations = {
    en: {
      'Никнейм должен быть от 3 до 20 символов.': 'Nickname must be 3 to 20 characters long.',
      'Никнейм может содержать буквы, цифры, пробел, дефис и подчёркивание.': 'Nickname may contain letters, numbers, spaces, hyphens, and underscores.',
      'Введите корректный email.': 'Enter a valid email address.',
      'Пароль должен быть не короче 6 символов.': 'Password must be at least 6 characters long.',
      'Пароль должен быть не короче 4 символов.': 'Password must be at least 4 characters long.',
      'На эту электронную почту уже зарегистрирован аккаунт.': 'An account is already registered with this email address.',
      'Такой никнейм уже занят.': 'This nickname is already taken.',
      'Этот никнейм заблокирован администратором.': 'This nickname has been blocked by an administrator.',
      'Неверный никнейм/email или пароль.': 'Incorrect nickname/email or password.',
      'Этот аккаунт заблокирован администратором.': 'This account has been blocked by an administrator.',
      'Если email зарегистрирован, на него отправлен код восстановления.': 'If this email is registered, a recovery code has been sent.',
      'Введите пароль закрытой игры минимум из 4 символов.': 'Enter a private game password of at least 4 characters.',
      'У вас уже есть активная игровая комната. Сначала завершите или покиньте текущую комнату.': 'You already have an active game room. Finish or leave it first.',
      'Активная комната не найдена.': 'Active room was not found.',
      'Комната не найдена.': 'Room was not found.',
      'Некорректное состояние партии.': 'Invalid game state.',
      'Комната с таким кодом не найдена.': 'No room with this code was found.',
      'Эта комната уже занята.': 'This room is already occupied.',
      'Неверный пароль закрытой комнаты.': 'Incorrect private room password.',
      'Этот игрок заблокирован администратором.': 'This player has been blocked by an administrator.',
      'Проверьте email и новый пароль. Пароль должен быть не короче 6 символов.': 'Check the email and new password. The password must be at least 6 characters.',
      'Код восстановления неверный или истёк.': 'The recovery code is incorrect or expired.',
      'Сообщение не может быть пустым.': 'Message cannot be empty.',
    },
  };

  function t(key, fallback = '') {
    const lang = currentLang();
    return (dicts[lang] && dicts[lang][key]) ?? (dicts.ru && dicts.ru[key]) ?? fallback ?? key;
  }

  function translateServerMessage(message) {
    const lang = currentLang();
    return serverMessageTranslations[lang]?.[message] || message;
  }

  function applyLang(lang) {
    const d = dicts[lang] || dicts.ru;
    document.documentElement.lang = lang;
    localStorage.setItem(LANG_KEY, lang);
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const v = d[el.dataset.i18n];
      if (v) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      const v = d[el.dataset.i18nHtml];
      if (v) el.innerHTML = v;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
      const v = d[el.dataset.i18nPh];
      if (v) el.placeholder = v;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const v = d[el.dataset.i18nTitle];
      if (v) el.title = v;
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const v = d[el.dataset.i18nAria];
      if (v) el.setAttribute('aria-label', v);
    });
    document.querySelectorAll('[data-lang-set]').forEach(b =>
      b.classList.toggle('active', b.dataset.langSet === lang));
    window.dispatchEvent(new CustomEvent('nardu:langchange', { detail: { lang } }));
  }
  function currentLang() {
    return localStorage.getItem(LANG_KEY) || 'ru';
  }

  /* ── AUTH ── */
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch { return null; }
  }
  function ratingTierFor(rating) {
    const value = Number(rating);
    if (!Number.isFinite(value)) return 'Bronze';
    return RATING_TIERS.find(tier => value >= tier.min)?.name || 'Bronze';
  }
  function isRatedUser(user = getUser()) {
    return Boolean(user && !user.guest && user.ratingEligible !== false && (user.id || user.email || user.nickname));
  }
  function assignProfileRating(user) {
    if (!user) return null;
    if (!isRatedUser(user)) {
      user.rating = null;
      user.tier = '';
      user.ratingEligible = false;
      return user;
    }
    const rating = Math.round(Number(user.rating));
    user.rating = Number.isFinite(rating) && rating > 0 ? rating : DEFAULT_RATING;
    user.tier = ratingTierFor(user.rating);
    user.ratingEligible = true;
    return user;
  }
  function tierLabel(tier) {
    const def = RATING_TIERS.find(item => item.name === tier);
    return def ? t(def.key) : t('unrated');
  }
  function formatRating(user = getUser()) {
    return isRatedUser(user) ? String(user.rating ?? DEFAULT_RATING) : '—';
  }
  function shouldShowRatingToOthers() {
    return localStorage.getItem(SHOW_RATING_KEY) !== '0';
  }
  function publicRating(user = getUser()) {
    return shouldShowRatingToOthers() && isRatedUser(user) ? Number(user.rating ?? DEFAULT_RATING) : null;
  }
  function setUser(u) {
    assignProfileRating(u);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  }
  function logout() {
    if (window.NarduSupabase?.configured?.()) {
      window.NarduSupabase.client()
        .then(client => client.auth.signOut())
        .catch(() => {});
    }
    localStorage.removeItem(USER_KEY);
    location.href = 'login.html';
  }
  function requireAuth() {
    if (!getUser()) location.href = 'login.html';
  }
  function requireGuest() {
    if (getUser()) location.href = 'index.html';
  }

  /* fill user chips on the page */
  function paintUser() {
    const u = getUser();
    document.querySelectorAll('[data-user-name]').forEach(el => el.textContent = u?.name || '—');
    document.querySelectorAll('[data-user-initial]').forEach(el => el.textContent = (u?.name || '?')[0].toUpperCase());
    document.querySelectorAll('[data-user-rating]').forEach(el => el.textContent = formatRating(u));
    document.querySelectorAll('[data-user-tier]').forEach(el => el.textContent = isRatedUser(u) ? tierLabel(u.tier) : t('unrated'));
  }

  /* ── SOUND TOGGLE (visual only) ── */
  function currentSound() { return localStorage.getItem(SOUND_KEY) !== '0'; }
  function setSound(on) {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0');
    if (on) {
      const vol = parseInt(localStorage.getItem('narduh-vol') || '70', 10);
      if (!Number.isFinite(vol) || vol <= 0) localStorage.setItem('narduh-vol', '70');
      window.NarduSound?.prime?.();
      window.NarduSound?.click?.();
    }
    paintSound();
  }
  function paintSound() {
    const on = currentSound();
    document.querySelectorAll('[data-sound-toggle]').forEach(b => {
      b.classList.toggle('off', !on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = on ? t('sound_on') : t('sound_off');
      b.setAttribute('aria-label', t('sound'));
    });
  }

  function wirePasswordToggles() {
    document.querySelectorAll('[data-password-toggle]').forEach(button => {
      if (button.dataset.bound === '1') return;
      button.dataset.bound = '1';
      button.addEventListener('click', () => {
        const input = button.closest('.password-field')?.querySelector('input');
        if (!input) return;
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        button.setAttribute('aria-pressed', String(visible));
        button.setAttribute('aria-label', visible ? t('hide_password') : t('show_password'));
        button.title = visible ? t('hide_password') : t('show_password');
        input.focus();
      });
    });
  }

  /* ── WIRE-UP ── */
  function wire() {
    document.querySelectorAll('[data-theme-set]').forEach(b => {
      b.addEventListener('click', () => applyTheme(b.dataset.themeSet));
    });
    document.querySelectorAll('[data-lang-set]').forEach(b => {
      b.addEventListener('click', () => applyLang(b.dataset.langSet));
    });
    document.querySelectorAll('[data-accent-set]').forEach(b => {
      b.addEventListener('click', () => applyAccent(b.dataset.accentSet));
    });
    document.querySelectorAll('[data-board-style-set]').forEach(b => {
      b.addEventListener('click', () => applyBoardStyle(b.dataset.boardStyleSet));
    });
    document.querySelectorAll('[data-sound-toggle]').forEach(b => {
      b.addEventListener('click', () => setSound(!currentSound()));
    });
    document.querySelectorAll('[data-go]').forEach(b => {
      b.addEventListener('click', () => location.href = b.dataset.go);
    });
    document.querySelectorAll('[data-logout]').forEach(b => {
      b.addEventListener('click', () => logout());
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.key === 't' || e.key === 'T') {
        applyTheme(currentTheme() === 'day' ? 'night' : 'day');
      }
    });
    applyAccent(currentAccent());
    applyBoardStyle(currentBoardStyle());
    applyLang(currentLang());
    paintUser();
    paintSound();
    wirePasswordToggles();
  }

  window.NarduApp = {
    applyTheme, currentTheme,
    applyAccent, currentAccent,
    applyBoardStyle, currentBoardStyle,
    applyLang, currentLang, dicts,
    getUser, setUser, logout, requireAuth, requireGuest,
    ratingTierFor, isRatedUser, assignProfileRating, tierLabel, formatRating,
    shouldShowRatingToOthers, publicRating,
    paintUser, currentSound, setSound, paintSound,
    wirePasswordToggles, t, translateServerMessage,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
