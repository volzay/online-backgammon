const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const account = { id: 'account', createdAt: '2026-10-21T00:00:00Z' };
const accountKey = 'narduh-onboarding-v1:account';
const newDate = '2026-11-15T04:00:00Z';
const flush = () => new Promise(resolve => setImmediate(resolve));

function createBrowser({ sessionUser } = {}) {
  const data = new Map();
  const authUpdates = [];
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };

  function openPage(url = '/index.html', user = account) {
    const destination = new URL(url, 'https://example.test');
    const visits = [];
    class Element {
      constructor() {
        this.textContent = '';
        this.style = {};
        this.hidden = false;
        this.checked = false;
        this.listeners = new Map();
      }
      addEventListener(name, listener) { this.listeners.set(name, listener); }
      dispatch(name, extra = {}) {
        this.listeners.get(name)?.({ target: this, currentTarget: this, preventDefault() {}, ...extra });
      }
      click() { this.dispatch('click'); }
      setAttribute() {}
      focus() {}
    }
    const launcher = new Element();
    const parts = new Map();
    function part(selector) {
      if (!parts.has(selector)) parts.set(selector, new Element());
      return parts.get(selector);
    }
    part('.onboarding-card').getBoundingClientRect = () => ({ width: 360, height: 200 });
    const dialog = Object.assign(new Element(), {
      open: false,
      showModal() { this.open = true; },
      close() { this.open = false; this.dispatch('close'); },
      querySelector: part,
      querySelectorAll: () => Array.from({ length: 4 }, () => new Element()),
    });
    const practiceSlot = Object.assign(new Element(), { hidden: true, firstElementChild: { querySelector: part, contains: () => false } });
    const isPractice = destination.pathname === '/room.html' && destination.searchParams.has('practice');
    const document = {
      readyState: 'complete',
      body: { append() {}, classList: { contains: name => isPractice && name === 'practice-room' } },
      documentElement: { lang: 'ru', clientWidth: 1000, clientHeight: 800 },
      createElement: () => dialog,
      addEventListener() {},
      removeEventListener() {},
      getElementById: id => id === 'practice-guide-slot' && isPractice ? practiceSlot : null,
      querySelector: () => null,
      querySelectorAll: selector => selector === '[data-onboarding-start]'
        && ['/index.html', '/settings.html'].includes(destination.pathname) ? [launcher] : [],
    };
    const window = {
      NarduApp: { getUser: () => user },
      addEventListener() {},
      removeEventListener() {},
    };
    if (sessionUser) window.NarduSupabase = {
      configured: () => true,
      client: async () => ({
        auth: {
          getSession: async () => ({ data: { session: { user: sessionUser } } }),
          async updateUser({ data }) {
            authUpdates.push(data.site_guide_disabled);
            return { data: { user: sessionUser } };
          },
        },
      }),
    };
    const context = vm.createContext({
      window, document, HTMLElement: Element, URLSearchParams,
      localStorage: storage,
      location: { pathname: destination.pathname, search: destination.search, assign: url => visits.push(url) },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      MutationObserver: class { observe() {} disconnect() {} },
    });
    vm.runInContext(source('onboarding.js'), context);
    if (isPractice) vm.runInContext(source('practice-guide.js'), context);
    return { dialog, launcher, part, visits, practiceSlot, guide: window.NarduOnboarding };
  }

  return {
    openPage,
    authUpdates,
    signIn(user = account) { openPage('/login.html', null).guide.offer(user); },
    saved: () => JSON.parse(data.get(accountKey) ?? 'null'),
    save: state => data.set(accountKey, JSON.stringify(state)),
  };
}

test('an explicit login offers the guide to accounts created before the guide launched', () => {
  const browser = createBrowser();
  assert.equal(browser.openPage().dialog.open, false);
  browser.signIn();
  const lobby = browser.openPage();
  assert.equal(lobby.dialog.open, true);
  assert.equal(lobby.part('.onboarding-title').textContent, 'Знакомство с сайтом');
  assert.equal(browser.saved().status, 'pending');
});

test('recent registrations still recover the offer from an existing matching session', async () => {
  const userWithoutDate = { id: account.id };
  const matching = createBrowser({ sessionUser: { id: account.id, created_at: newDate } });
  const mismatched = createBrowser({ sessionUser: { id: 'other', created_at: newDate } });
  const sameAccount = matching.openPage('/index.html', userWithoutDate);
  const otherAccount = mismatched.openPage('/index.html', userWithoutDate);
  await flush();
  assert.equal(sameAccount.dialog.open, true);
  assert.equal(otherAccount.dialog.open, false);
  assert.equal(mismatched.saved(), null);
});

test('legacy skipped and completed states are reoffered only on a new login', () => {
  for (const status of ['skipped', 'completed']) {
    const browser = createBrowser();
    browser.save({ status, step: 4 });
    assert.equal(browser.openPage().dialog.open, false);
    browser.signIn();
    const lobby = browser.openPage();
    assert.equal(lobby.dialog.open, true);
    lobby.part('.onboarding-skip').click();
    assert.equal(lobby.dialog.open, false);
    assert.equal(browser.saved().status, 'skipped');
    const refreshedLobby = browser.openPage();
    assert.equal(refreshedLobby.dialog.open, false);
    assert.equal(refreshedLobby.launcher.hidden, false);
    browser.signIn();
    assert.equal(browser.openPage().dialog.open, true);
  }
});

test('the guide is offered after a login that returns directly to account settings', () => {
  const browser = createBrowser();
  browser.signIn();
  const settings = browser.openPage('/settings.html#account');
  assert.equal(settings.dialog.open, true);
  settings.part('.onboarding-next').click();
  assert.deepEqual(settings.visits, ['index.html']);
  assert.equal(browser.openPage().part('.onboarding-title').textContent, 'Открытые партии');
});

function chooseOptOut(page, checked) {
  const checkbox = page.part('.onboarding-opt-out');
  checkbox.checked = checked;
  checkbox.dispatch('change');
}

test('the opt-out suppresses later offers and leaves the manual launcher available', () => {
  const browser = createBrowser();
  browser.signIn();
  const lobby = browser.openPage();
  assert.equal(lobby.part('.onboarding-opt-out-label').textContent, 'Больше не показывать');
  assert.equal(lobby.part('.onboarding-opt-out').checked, false);
  chooseOptOut(lobby, true);
  lobby.part('.onboarding-skip').click();
  browser.signIn();
  const nextLobby = browser.openPage();
  assert.equal(nextLobby.dialog.open, false);
  nextLobby.launcher.click();
  assert.equal(nextLobby.dialog.open, true);
  assert.equal(nextLobby.part('.onboarding-title').textContent, 'Открытые партии');
});

test('unchecking the opt-out before leaving the guide restores offers after login', () => {
  const browser = createBrowser();
  browser.signIn();
  const lobby = browser.openPage();
  chooseOptOut(lobby, true);
  chooseOptOut(lobby, false);
  lobby.part('.onboarding-skip').click();
  browser.signIn();
  assert.equal(browser.openPage().dialog.open, true);
});

test('an account opt-out is honored on a device with no local guide state', async () => {
  const browser = createBrowser();
  const optedOut = { ...account, createdAt: newDate, siteGuideDisabled: true };
  assert.equal(browser.openPage('/index.html', optedOut).dialog.open, false);
  assert.equal(browser.saved(), null);
  browser.signIn(optedOut);
  const lobby = browser.openPage('/index.html', optedOut);
  await flush();
  assert.equal(lobby.dialog.open, false);
  assert.equal(lobby.launcher.hidden, false);
});

test('the choice is written to the matching signed-in account in order', async () => {
  const matching = createBrowser({ sessionUser: { id: account.id } });
  const mismatched = createBrowser({ sessionUser: { id: 'other' } });
  for (const browser of [matching, mismatched]) {
    browser.signIn();
    const lobby = browser.openPage();
    chooseOptOut(lobby, true);
    chooseOptOut(lobby, false);
  }
  await flush();
  assert.deepEqual(matching.authUpdates, [true, false]);
  assert.deepEqual(mismatched.authUpdates, []);
});

test('guest opt-out stays in this browser and does not affect a registered player', async () => {
  const browser = createBrowser({ sessionUser: { id: account.id } });
  const guest = browser.openPage('/index.html', { id: 'guest-a', guest: true });
  assert.equal(guest.dialog.open, true);
  chooseOptOut(guest, true);
  guest.part('.onboarding-skip').click();
  assert.equal(browser.openPage('/index.html', { id: 'guest-b', guest: true }).dialog.open, false);
  browser.signIn();
  assert.equal(browser.openPage().dialog.open, true);
  await flush();
  assert.deepEqual(browser.authUpdates, []);
});

test('skipping the practice guide keeps the opt-out selected in the welcome', () => {
  const browser = createBrowser();
  browser.signIn();
  let page = browser.openPage();
  chooseOptOut(page, true);
  for (const destination of ['settings.html', 'index.html', 'room.html?practice=1']) {
    for (let step = 0; step < 20 && !page.visits.length; step += 1) {
      page.part('.onboarding-next').click();
    }
    assert.deepEqual(page.visits, [destination]);
    page = browser.openPage(destination);
  }
  assert.equal(page.practiceSlot.hidden, false);
  page.part('.practice-guide-skip').click();
  assert.equal(page.practiceSlot.hidden, true);
  assert.equal(browser.saved().status, 'skipped');
  browser.signIn();
  assert.equal(browser.openPage().dialog.open, false);
});

test('an invitation landing defers the offer until the player returns to the ordinary lobby', () => {
  const browser = createBrowser();
  browser.signIn();
  const invitation = browser.openPage('/index.html?join=ABCD-EFGH');
  assert.equal(invitation.dialog.open, false);
  assert.equal(invitation.launcher.hidden, false);
  assert.equal(browser.saved().status, 'pending');
  assert.equal(browser.openPage().dialog.open, true);
});
