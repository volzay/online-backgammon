# Онлайн-нарды

Браузерная игра в нарды на чистом HTML/CSS/JS с небольшим Node.js сервером. Клиент не требует сборки, а сервер отвечает за аккаунты, комнаты, чат, синхронизацию удалённой партии, рейтинг и админ-панель.

По умолчанию приложение открывается на `http://127.0.0.1:4177`.

## Быстрый старт

Нужен Node.js 18+.

```bash
npm start
```

Или напрямую:

```bash
node server.js
```

Для изолированного локального запуска удобно вынести данные во временную папку:

```bash
DATA_DIR=/tmp/nardy-dev ADMIN_PASSWORD=adminpass npm start
```

## Страницы

- `login.html` - вход, гостевой режим и восстановление пароля.
- `register.html` - регистрация аккаунта.
- `index.html` - лобби, быстрый старт, создание комнаты, вход по коду, список игровых сессий.
- `room.html` - игровая комната.
- `settings.html` - локальные настройки интерфейса и профиля.
- `homegate.html` - админ-панель для мониторинга комнат и игроков.

## Что уже работает

### Аккаунты

- Регистрация по никнейму, email и паролю.
- Вход по никнейму или email.
- Пароли хэшируются через PBKDF2.
- Гостевой вход остаётся локальным и не участвует в рейтинге.
- Восстановление пароля создаёт 6-значный код и кладёт письмо в локальный outbox.
- Зарегистрированные игроки получают рейтинг, tier и историю рейтинговых результатов.

### Лобби

- Быстрая игра против бота.
- Создание игры против бота или игрока.
- Выбор сложности бота: лёгкий, средний, сложный.
- Выбор варианта в интерфейсе: длинные / короткие.
- Открытые и закрытые комнаты с паролем.
- Вход по коду комнаты.
- Возврат в активную комнату, если игрок уже находится в партии.
- Фильтры сессий: все, длинные, короткие, друзья, в игре.

Лидерборд и список друзей сейчас работают как демонстрационные данные на клиенте.

### Игровая комната

- Правила длинных нард в `game.js`.
- Стартовый бросок по одному кубику для каждой стороны, первый ход делает победитель броска.
- Перемещение по клику и drag-and-drop.
- Подсветка легальных ходов.
- Снятие шашек с доски, когда все шашки игрока в доме.
- Правило головы, включая особый лимит для первого дубля.
- Проверка блоков в длинных нардах.
- Undo хода до завершения текущего хода.
- Сдача партии.
- Матч до 5 очков.
- Рематч в удалённой комнате.
- Анимация шашек и физика кубиков на canvas/WebGL fallback.
- Звуки через Web Audio без внешних аудиофайлов.

### Онлайн-игра

Удалённая игра реализована без WebSocket: клиент периодически обменивается состоянием через HTTP.

- `GET /api/rooms` показывает комнаты.
- `POST /api/rooms` создаёт комнату.
- `POST /api/rooms/:code/join` подключает второго игрока.
- `GET /api/rooms/:code/game` читает состояние партии.
- `PUT /api/rooms/:code/game` публикует новое состояние партии.
- `POST /api/rooms/:code/presence` отправляет heartbeat игрока.
- `POST /api/rooms/:code/leave` сообщает выход из комнаты.

Presence отслеживает потерю связи. По умолчанию игрок считается stale через 8 секунд без heartbeat, а партия принудительно завершается через 120 секунд grace-периода.

### Чат

- Текстовые сообщения.
- Быстрые фразы.
- Emoji.
- Голосовые сообщения через `MediaRecorder`.
- В удалённой комнате чат хранится в памяти комнаты и доступен через API.

### Рейтинг

- ELO-lite рейтинг с `K=24`.
- Рейтинг обновляется только для зарегистрированных игроков.
- После партии клиент обновляет локальный профиль и синхронизирует результат через `POST /api/rating/sync`.
- Гости не получают рейтинг, hot-seat партии не записываются в серверный рейтинг.

### Админ-панель

Админка доступна по адресу:

```text
http://127.0.0.1:4177/homegate.html
```

Возможности:

- вход администратора по cookie-сессии;
- список активных комнат;
- архив завершённых комнат;
- монитор выбранных комнат;
- просмотр истории партии, чата, бросков и SHA-256 доказательств;
- копирование протокола партии;
- принудительное закрытие комнаты с причиной;
- список игроков, замеченных сервером;
- смена пароля игрока;
- бан / разбан игрока;
- удаление игрока;
- смена пароля администратора;
- аудит админских действий.

Для разработки есть встроенный fallback-логин `admin`. Пароль лучше всегда задавать через `ADMIN_PASSWORD` или сохранить новый пароль в админке. Не используйте встроенный fallback-пароль в публичной среде.

## Данные

Сервер хранит данные в JSON-файлах внутри `DATA_DIR`:

```text
data/
├── admin.json
├── admin-state.json
├── auth-users.json
└── mail-outbox.json
```

`data/` добавлен в `.gitignore`. Комнаты хранятся в памяти процесса; при перезапуске сервера активные комнаты исчезают, а аккаунты, админское состояние и outbox остаются в JSON.

`mail-outbox.json` - локальная имитация отправки email. Реальный SMTP-провайдер пока не подключён.

## Переменные окружения

| Переменная | Значение по умолчанию | Назначение |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Адрес, на котором слушает сервер |
| `PORT` | `4177` | Порт сервера |
| `DATA_DIR` | `./data` | Папка JSON-хранилища |
| `ADMIN_LOGIN` | `admin` | Логин администратора |
| `ADMIN_PASSWORD` | dev fallback | Первичный пароль администратора |
| `ADMIN_ARCHIVE_HOURS` | `60` | Сколько часов хранить архив комнат |
| `NETWORK_GRACE_MS` | `120000` | Grace-период после потери связи |
| `PRESENCE_STALE_MS` | `8000` | Через сколько heartbeat считается устаревшим |

## API

Основные маршруты:

```text
POST   /api/register
POST   /api/login
POST   /api/password-recovery/request
POST   /api/password-recovery/reset
POST   /api/rating/sync

GET    /api/rooms
POST   /api/rooms
GET    /api/rooms/:code
DELETE /api/rooms/:code
POST   /api/rooms/:code/join
GET    /api/rooms/:code/game
PUT    /api/rooms/:code/game
GET    /api/rooms/:code/chat
POST   /api/rooms/:code/chat
POST   /api/rooms/:code/presence
POST   /api/rooms/:code/leave

POST   /api/admin/login
GET    /api/admin/me
POST   /api/admin/password
POST   /api/admin/logout
GET    /api/admin/sessions
GET    /api/admin/sessions/:id
POST   /api/admin/sessions/:id/close
GET    /api/admin/users
POST   /api/admin/users/:id/password
POST   /api/admin/users/:id/ban
POST   /api/admin/users/:id/unban
DELETE /api/admin/users/:id
```

## Структура проекта

```text
.
├── index.html          # лобби
├── login.html          # вход и восстановление пароля
├── register.html       # регистрация
├── room.html           # игровая комната
├── settings.html       # настройки
├── homegate.html       # админ-панель
│
├── app.js              # общая логика UI: тема, язык, auth, профиль
├── game.js             # правила длинных нард
├── game-controller.js  # игровой flow, remote polling, анимации, рейтинг
├── bot.js              # эвристический бот
├── board-engine.js     # canvas-анимации шашек и кубиков
├── dice-engine.js      # физика кубиков
├── dice-webgl.js       # WebGL-рендер кубиков
├── sound.js            # Web Audio эффекты
├── rating.js           # ELO-lite рейтинг
├── homegate.js         # логика админ-панели
│
├── styles.css          # основной UI
├── homegate.css        # стили админ-панели
├── server.js           # HTTP/static/API сервер
├── package.json
├── vercel.json
└── README.md
```

## Проверка

В проекте пока нет отдельного test runner. Быстрая синтаксическая проверка:

```bash
node --check server.js
node --check app.js
node --check game.js
node --check game-controller.js
node --check board-engine.js
node --check dice-engine.js
node --check dice-webgl.js
node --check homegate.js
```

## Деплой

Текущая версия зависит от `server.js`, поэтому ей нужен Node.js runtime с постоянным процессом и writable storage для `DATA_DIR`.

Статический деплой на Vercel / GitHub Pages / Netlify покажет HTML/CSS/JS, но не даст рабочие аккаунты, комнаты, чат, рейтинг и админку. Для полноценного деплоя используйте Node-хостинг, контейнер или VPS.

Альтернативный бесплатный путь в работе: GitHub Pages для frontend и Supabase Auth/Postgres/Realtime для backend. Подготовительные файлы:

- `docs/deploy-supabase-github-pages.md`;
- `supabase/schema.sql`;
- `supabase-client.js`;
- `auth-client.js`;
- `runtime-config.js`;
- `.github/workflows/pages.yml`.

Для GitHub Pages используйте source `GitHub Actions`. Workflow `Deploy GitHub Pages` собирает `dist` командой `npm run build`.
Ожидаемый адрес GitHub Pages: `https://volzay.github.io/online-backgammon/`.

Для production нужно заменить JSON-хранилище на БД, подключить SMTP/почтовый сервис и задать сильный `ADMIN_PASSWORD`.

## Текущие ограничения

- Сервер принимает опубликованное клиентом состояние партии; полноценная серверная валидация каждого хода ещё не вынесена на backend.
- Активные комнаты живут в памяти процесса.
- Email отправляется только в локальный outbox.
- Реальные лидерборд, друзья, matchmaking, турниры и сезоны пока не подключены к серверу.
- Realtime построен на HTTP polling, не на WebSocket.
