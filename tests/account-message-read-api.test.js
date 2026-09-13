const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 42139;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let dataDir;

async function jsonResponse(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${response.status}: ${body.error || pathname}`);
  return { body, response };
}

async function json(pathname, options = {}) {
  return (await jsonResponse(pathname, options)).body;
}

async function register(nickname, email) {
  const { body, response } = await jsonResponse('/api/register', {
    method: 'POST',
    body: JSON.stringify({ nickname, email, password: 'secret1' }),
  });
  const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^nardy_user=/);
  return { user: body.user, cookie };
}

function asSession(cookie, options = {}) {
  return {
    ...options,
    headers: { ...(options.headers || {}), cookie },
  };
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/index.html`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(100);
  }
  throw new Error('account message test server did not start');
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nardy-account-read-'));
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: 'test',
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

test.after(() => {
  server?.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('fetching a conversation is read-only and explicit acknowledgement clears unread', async () => {
  const firstAccount = await register('ReadTesterA', 'read-a@example.test');
  const secondAccount = await register('ReadTesterB', 'read-b@example.test');
  const first = firstAccount.user;
  const second = secondAccount.user;

  await json('/api/account/friends', asSession(firstAccount.cookie, {
    method: 'POST',
    body: JSON.stringify({ userId: first.id, friendId: second.id }),
  }));
  const pending = await json(`/api/account/profile?userId=${encodeURIComponent(first.id)}`, asSession(secondAccount.cookie));
  assert.equal(pending.user.id, second.id, 'the authenticated cookie, not a caller-supplied userId, selects the account');
  const requestId = pending.friendRequests.incoming[0]?.id;
  assert.ok(requestId);
  await json(`/api/account/friend-requests/${encodeURIComponent(requestId)}/accept`, asSession(secondAccount.cookie, {
    method: 'POST',
    body: JSON.stringify({ userId: second.id }),
  }));
  await json('/api/account/messages', asSession(firstAccount.cookie, {
    method: 'POST',
    body: JSON.stringify({ userId: first.id, friendId: second.id, text: 'Unread until opened' }),
  }));

  const before = await json(`/api/account/profile?userId=${encodeURIComponent(second.id)}`, asSession(secondAccount.cookie));
  assert.equal(before.friends.find(friend => friend.id === first.id)?.unread, 1);

  const thread = await json(`/api/account/messages?userId=${encodeURIComponent(second.id)}&friendId=${encodeURIComponent(first.id)}`, asSession(secondAccount.cookie));
  assert.equal(thread.messages.at(-1)?.text, 'Unread until opened');
  const afterFetch = await json(`/api/account/profile?userId=${encodeURIComponent(second.id)}`, asSession(secondAccount.cookie));
  assert.equal(afterFetch.friends.find(friend => friend.id === first.id)?.unread, 1);

  const unauthenticated = await fetch(`${BASE}/api/account/messages/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: second.id, friendId: first.id }),
  });
  assert.equal(unauthenticated.status, 401);

  await json('/api/account/messages/read', asSession(secondAccount.cookie, {
    method: 'POST',
    body: JSON.stringify({ userId: first.id, friendId: first.id }),
  }));
  const afterRead = await json(`/api/account/profile?userId=${encodeURIComponent(second.id)}`, asSession(secondAccount.cookie));
  assert.equal(afterRead.friends.find(friend => friend.id === first.id)?.unread, 0);
});
