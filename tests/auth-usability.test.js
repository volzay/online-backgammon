const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const authSource = fs.readFileSync(path.join(ROOT, 'auth-client.js'), 'utf8');
const loginHtml = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
const registerHtml = fs.readFileSync(path.join(ROOT, 'register.html'), 'utf8');
const rulesHtml = fs.readFileSync(path.join(ROOT, 'rules.html'), 'utf8');

function authRuntime({ href = 'https://example.test/login.html', lang = 'ru', supabaseConfigured = true } = {}) {
  const calls = {
    resetRedirect: '',
    exchangedCode: '',
    updatedPassword: '',
    nicknameRegistration: null,
    emailRegistration: null,
    fallbackRegistrations: [],
  };
  const authUser = {
    id: 'user-1',
    email: 'player@example.test',
    user_metadata: { nickname: 'tester1' },
  };
  const profile = {
    id: authUser.id,
    nickname: 'tester1',
    email: authUser.email,
    rating: 1200,
    tier: 'Silver',
    rating_eligible: true,
  };
  const query = {
    select() { return this; },
    eq() { return this; },
    upsert() { return this; },
    async maybeSingle() { return { data: profile, error: null }; },
    async single() { return { data: profile, error: null }; },
  };
  const supabase = {
    from() { return Object.create(query); },
    async rpc(name, args) {
      if (name !== 'register_nickname_user') throw new Error(`unexpected RPC ${name}`);
      calls.nicknameRegistration = args;
      return {
        data: {
          ...profile,
          auth_email: 'user-1@nickname.local',
        },
        error: null,
      };
    },
    auth: {
      async resetPasswordForEmail(_email, options) {
        calls.resetRedirect = options.redirectTo;
        return { error: null };
      },
      async exchangeCodeForSession(code) {
        calls.exchangedCode = code;
        return { error: null };
      },
      async getSession() {
        return { data: { session: { user: authUser } }, error: null };
      },
      async updateUser({ password }) {
        calls.updatedPassword = password;
        return { data: { user: authUser }, error: null };
      },
      async signInWithPassword() {
        return { data: { user: authUser }, error: null };
      },
      async signUp(payload) {
        calls.emailRegistration = payload;
        return { data: { user: authUser, session: { user: authUser } }, error: null };
      },
    },
  };
  const context = {
    URL,
    URLSearchParams,
    location: {
      href,
      pathname: new URL(href).pathname,
      search: new URL(href).search,
    },
    history: { replaceState() {} },
    fetch: async (_url, options = {}) => {
      const body = JSON.parse(options.body || '{}');
      calls.fallbackRegistrations.push(body);
      return {
        ok: true,
        async json() {
          return { user: { id: `fallback-${calls.fallbackRegistrations.length}`, name: body.nickname, nickname: body.nickname, email: body.email } };
        },
      };
    },
    NarduApp: {
      currentLang: () => lang,
      ratingTierFor: () => 'Silver',
      translateServerMessage: value => value,
      t: key => ({ err_auth: 'Ошибка авторизации.', err_register: 'Ошибка регистрации.' }[key] || key),
    },
  };
  context.window = context;
  context.NarduSupabase = {
    configured: () => supabaseConfigured,
    client: async () => supabase,
    config: () => ({ siteBaseUrl: 'https://example.test' }),
  };
  vm.createContext(context);
  vm.runInContext(authSource, context, { filename: 'auth-client.js' });
  return { auth: context.NarduAuth, calls };
}

test('password recovery uses an explicit link callback and completes through updateUser', async () => {
  const { auth, calls } = authRuntime({
    href: 'https://example.test/login.html?recovery=1&code=recovery-code',
  });

  const redirect = await auth.handleAuthRedirect();
  assert.equal(calls.exchangedCode, 'recovery-code');
  assert.equal(redirect.passwordRecovery, true);
  assert.equal(redirect.user.nickname, 'tester1');

  const updated = await auth.updateRecoveredPassword('new-password');
  assert.equal(calls.updatedPassword, 'new-password');
  assert.equal(updated.user.nickname, 'tester1');
});

test('a recovery query flag without callback credentials reports an expired link and cannot change an active password', async () => {
  const { auth, calls } = authRuntime({
    href: 'https://example.test/login.html?recovery=1',
  });

  await assert.rejects(() => auth.handleAuthRedirect(), /Ссылка восстановления|recovery/i);
  await assert.rejects(() => auth.updateRecoveredPassword('attacker-password'), /Ссылка восстановления|recovery/i);
  assert.equal(calls.updatedPassword, '');
});

test('room invitations survive sign-in, guest entry, and registration navigation', () => {
  const { auth } = authRuntime({
    href: 'https://example.test/login.html?join=slwa-xwcq',
  });

  assert.equal(auth.postAuthDestination(), 'index.html?join=SLWA-XWCQ');
  assert.match(loginHtml, /location\.href = NarduAuth\.postAuthDestination\(\)/);
  assert.match(registerHtml, /location\.href = NarduAuth\.postAuthDestination\(\)/);
  assert.match(loginHtml, /NarduAuth\.preservePostAuthLinks\(\)/);
  assert.match(registerHtml, /NarduAuth\.preservePostAuthLinks\(\)/);
});

test('recovery email points back to the dedicated password-reset state', async () => {
  const { auth, calls } = authRuntime();
  const result = await auth.requestPasswordRecovery('player@example.test');

  assert.equal(result.supabaseLink, true);
  assert.equal(calls.resetRedirect, 'https://example.test/login.html?recovery=1');
  assert.match(result.message, /ссылка/i);

  const invited = authRuntime({ href: 'https://example.test/login.html?join=slwa-xwcq' });
  await invited.auth.requestPasswordRecovery('player@example.test');
  assert.equal(invited.calls.resetRedirect, 'https://example.test/login.html?recovery=1&join=SLWA-XWCQ');
});

test('optional recovery email preserves nickname-only registration', async () => {
  const nicknameOnly = authRuntime();
  await nicknameOnly.auth.register({ nickname: 'tester1', email: '', password: 'secret12' });
  assert.deepEqual(
    JSON.parse(JSON.stringify(nicknameOnly.calls.nicknameRegistration)),
    { p_nickname: 'tester1', p_password: 'secret12' },
  );
  assert.equal(nicknameOnly.calls.emailRegistration, null);

  const withEmail = authRuntime();
  await withEmail.auth.register({ nickname: 'tester1', email: 'player@example.test', password: 'secret12' });
  assert.equal(withEmail.calls.nicknameRegistration, null);
  assert.equal(withEmail.calls.emailRegistration.email, 'player@example.test');
  assert.equal(withEmail.calls.emailRegistration.options.emailRedirectTo, 'https://example.test/login.html');
});

test('email confirmation keeps the room invitation in its callback URL', async () => {
  const invited = authRuntime({ href: 'https://example.test/register.html?join=SLWA-XWCQ' });
  await invited.auth.register({ nickname: 'tester1', email: 'player@example.test', password: 'secret12' });
  assert.equal(invited.calls.emailRegistration.options.emailRedirectTo, 'https://example.test/login.html?join=SLWA-XWCQ');
});

test('nickname-only fallback registration gives different synthetic emails to Cyrillic users', async () => {
  const fallback = authRuntime({ supabaseConfigured: false });
  await fallback.auth.register({ nickname: 'Игрок', email: '', password: 'secret12' });
  await fallback.auth.register({ nickname: 'Победитель', email: '', password: 'secret12' });
  const emails = fallback.calls.fallbackRegistrations.map(item => item.email);
  assert.equal(new Set(emails).size, 2);
  assert.ok(emails.every(email => /^player\+[a-z0-9-]+@local\.nardy$/i.test(email)));
});

test('auth pages expose honest controls and guard every asynchronous form', () => {
  assert.doesNotMatch(loginHtml, /Запомнить меня|data-i18n="remember"/);
  assert.doesNotMatch(`${loginHtml}\n${registerHtml}`, /href="#"/);
  assert.match(registerHtml, /href="rules\.html"[^>]*data-i18n="rules"/);
  assert.match(authSource, /a\[href="rules\.html"\]/);
  assert.match(rulesHtml, /data-rules-lang="ru"[\s\S]*data-rules-lang="en"/);
  assert.match(`${loginHtml}\n${registerHtml}`, /github\.com\/volzay\/online-backgammon\/issues\/new/);
  assert.doesNotMatch(registerHtml, /Импорт прогресса|auth_reg_bullet_import/);
  assert.match(registerHtml, /id="reg-email"[^>]*autocomplete="email"/);
  assert.doesNotMatch(registerHtml, /id="reg-email"[^>]*required/);
  assert.match(registerHtml, /NarduAuth\.register\(\{ nickname: nick, email, password: pass \}\)/);
  assert.match(loginHtml, /id="recovery-link-form"/);
  assert.match(loginHtml, /data-auth-copy-ru="Отправить инструкции" data-auth-copy-en="Send recovery instructions"/);
  assert.doesNotMatch(loginHtml, /Отправить ссылку|Send reset link/);
  assert.match(loginHtml, /redirect\.passwordRecovery/);
  assert.match(loginHtml, /updateRecoveredPassword\(password\)/);
  assert.match(loginHtml, /getElementById\('login-form'\)\.hidden = true/);
  assert.match(loginHtml, /getElementById\('login-form'\)\.hidden = false/);
  assert.match(loginHtml, /getElementById\('auth-card-title'\)\.hidden = true/);
  assert.match(loginHtml, /function showLoginForm[\s\S]*?getElementById\('login-form'\)\.hidden = false/);
  assert.match(registerHtml, /\^\[\\p\{L\}\\p\{N\}_ -\]\+\$\/u/);
  assert.ok((loginHtml.match(/beginSubmit\(/g) || []).length >= 5);
  assert.ok((registerHtml.match(/beginSubmit\(/g) || []).length >= 2);
  assert.match(loginHtml, /setAttribute\('aria-busy', 'true'\)/);
  assert.match(registerHtml, /setAttribute\('aria-busy', 'true'\)/);
});

test('technical auth failures are replaced by actionable messages', () => {
  const { auth } = authRuntime();
  const quotaMessage = auth.errorMessage(new Error('The quota has been exceeded'));
  assert.match(quotaMessage, /Подождите несколько минут/);
  assert.equal(auth.errorMessage(new Error(quotaMessage)), quotaMessage);
  const recoveryMessage = 'Проверьте email и новый пароль. Пароль должен быть не короче 6 символов.';
  assert.equal(auth.errorMessage(new Error(recoveryMessage)), recoveryMessage);
  assert.match(auth.errorMessage(new Error('TypeError: Failed to fetch')), /Проверьте интернет/);
  assert.equal(auth.errorMessage(new Error('database relation profiles_internal missing')), 'Ошибка авторизации.');
});

test('normalized English validation errors remain actionable on a second formatting pass', () => {
  const { auth } = authRuntime({ lang: 'en' });
  assert.equal(auth.errorMessage(new Error('Incorrect nickname/email or password.')), 'Incorrect nickname/email or password.');
  assert.equal(auth.errorMessage(new Error('Enter a valid email address.')), 'Enter a valid email address.');
  assert.equal(auth.errorMessage(new Error('Password must be at least 6 characters long.')), 'Password must be at least 6 characters long.');
  const recoveryMessage = 'Check the email and new password. The password must be at least 6 characters.';
  assert.equal(auth.errorMessage(new Error(recoveryMessage)), recoveryMessage);
  const blockedMessage = 'This account has been blocked by an administrator.';
  assert.equal(auth.errorMessage(new Error(blockedMessage)), blockedMessage);
});

test('inline auth page scripts remain syntactically valid', () => {
  for (const [file, source] of [['login.html', loginHtml], ['register.html', registerHtml]]) {
    const scripts = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0, `${file} should contain an inline controller`);
    scripts.forEach((match, index) => {
      assert.doesNotThrow(
        () => new vm.Script(match[1], { filename: `${file}:inline-${index + 1}` }),
      );
    });
  }
});
