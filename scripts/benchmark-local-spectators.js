#!/usr/bin/env node
/**
 * Diagnostic load test for the isolated, in-memory Node fallback server.
 * It never contacts Supabase or production and cannot establish a safe
 * production spectator limit. The current spectator UI polls game state at
 * 900 ms and heartbeats at 5 s; it no longer polls chat, and the heartbeat
 * asks for no game state. The fallback still differs from Supabase in that it
 * has no PostgreSQL row locks, RLS, or network latency.
 * Run: node scripts/benchmark-local-spectators.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const ROOT = path.join(__dirname, '..');
const COUNTS = [0, 1, 5, 10, 20, 50];
const STAGE_MS = 7000;
const GAME_POLL_MS = 900;
const HEARTBEAT_MS = 5000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)].toFixed(2));
}

async function unusedLoopbackPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function guestCredentials(label) {
  const proof = `gproof:${createHash('sha256').update(`${label}:${randomBytes(12).toString('hex')}`).digest('hex')}`;
  const id = `guest:sha256:${createHash('sha256').update(`nardu/guest/v1:${proof}`).digest('hex')}`;
  return { id, proof, headers: { 'x-guest-id': id, 'x-guest-proof': proof } };
}

function representativeState() {
  // A legal checker count plus a moderately long move/proof history. The
  // fallback validates board integrity, while the history makes reads and
  // writes closer in size to a mature short-backgammon game.
  return {
    variant: 'short', phase: 'move', turn: 'white', winner: null,
    points: {
      1: { color: 'white', count: 2 }, 12: { color: 'white', count: 5 },
      17: { color: 'white', count: 3 }, 19: { color: 'white', count: 5 },
      24: { color: 'dark', count: 2 }, 13: { color: 'dark', count: 5 },
      8: { color: 'dark', count: 3 }, 6: { color: 'dark', count: 5 },
    },
    off: { white: 0, dark: 0 }, bar: { white: 0, dark: 0 },
    history: Array.from({ length: 250 }, (_, index) => ({
      color: index % 2 ? 'white' : 'dark', from: (index % 24) + 1,
      to: ((index + 4) % 24) + 1, die: (index % 6) + 1,
      at: '2026-10-03T00:00:00.000Z', sha256: 'a'.repeat(64),
    })),
  };
}

async function run() {
  const port = await unusedLoopbackPort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nardy-spectator-bench-'));
  let server;
  let output = '';
  const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const started = performance.now();
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${data.error || ''}`);
    return { data, ms: performance.now() - started };
  };

  async function periodic(route, options, period, stopAt, firstDelay = 0) {
    let nextAt = Date.now() + firstDelay;
    while (Date.now() < stopAt) {
      await sleep(Math.max(0, nextAt - Date.now()));
      if (Date.now() >= stopAt) break;
      await request(route, options);
      nextAt += period;
      if (nextAt < Date.now()) nextAt = Date.now() + period;
    }
  }

  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
        ADMIN_PASSWORD: 'local-benchmark-only',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-8000); });
    server.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-8000); });
    const readyBy = Date.now() + 8000;
    while (Date.now() < readyBy) {
      if (server.exitCode !== null) throw new Error(`Local server exited: ${output}`);
      try {
        const response = await fetch(`${base}/index.html`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch { /* startup */ }
      await sleep(100);
    }
    if (Date.now() >= readyBy) throw new Error(`Local server did not start: ${output}`);

    const host = guestCredentials('host');
    const guest = guestCredentials('guest');
    const created = await request('/api/rooms', {
      method: 'POST', headers: host.headers,
      body: { hostName: 'BenchHost', hostUserId: host.id, hostRatingEligible: false,
        variant: 'short', access: 'open', allowSpectators: true },
    });
    const code = created.data.room.code;
    await request(`/api/rooms/${code}/join`, {
      method: 'POST', headers: guest.headers,
      body: { guestName: 'BenchGuest', guestUserId: guest.id, guestRatingEligible: false },
    });
    const state = representativeState();
    let version = 0;
    ({ data: { version } } = await request(`/api/rooms/${code}/game`, {
      method: 'PUT', headers: host.headers, body: { state, version },
    }));
    console.log(`Local Node fallback only; room ${code}; game state ${Buffer.byteLength(JSON.stringify(state))} bytes`);
    console.log('spectators\tgame PUT p95 ms\tgame GET p95 ms\tPUT samples');

    for (const count of COUNTS) {
      const ids = Array.from({ length: count }, (_, index) => `bench-${index}`);
      await Promise.all(ids.map(spectatorId => request(`/api/rooms/${code}/spectators?includeState=0`, {
        method: 'POST', body: { spectatorId, name: spectatorId },
      })));
      const stopAt = Date.now() + STAGE_MS;
      const watcherErrors = [];
      const watchers = ids.flatMap((spectatorId, index) => [
        periodic(`/api/rooms/${code}/game`, {}, GAME_POLL_MS, stopAt, index * 17 % GAME_POLL_MS),
        // The fixed spectator UI never polls chat: its database read policy
        // only permits the two room players, not viewers.
        periodic(`/api/rooms/${code}/spectators?includeState=0`, {
          method: 'POST', body: { spectatorId, name: spectatorId },
        }, HEARTBEAT_MS, stopAt, 5000 + index * 29 % 1000),
      ]).map(task => task.catch(error => { watcherErrors.push(error); }));
      const putSamples = [];
      const getSamples = [];
      try {
        while (Date.now() < stopAt - 100) {
          const put = await request(`/api/rooms/${code}/game`, {
            method: 'PUT', headers: host.headers, body: { state, version },
          });
          version = put.data.version;
          putSamples.push(put.ms);
          const get = await request(`/api/rooms/${code}/game`);
          assert.equal(get.data.version, version);
          getSamples.push(get.ms);
          await sleep(150);
        }
      } finally {
        await Promise.all(watchers);
        await Promise.allSettled(ids.map(spectatorId => request(`/api/rooms/${code}/spectators`, {
          method: 'DELETE', body: { spectatorId },
        })));
      }
      if (watcherErrors.length) throw watcherErrors[0];
      console.log(`${count}\t${percentile(putSamples, 0.95)}\t${percentile(getSamples, 0.95)}\t${putSamples.length}`);
    }
    console.log('These numbers exclude Supabase row locks, SQL/RLS, WAN latency and production fair-dice coordination.');
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => {
        server.once('exit', resolve);
        setTimeout(resolve, 2000).unref();
      });
    }
    if (path.dirname(dataDir) === os.tmpdir()
      && path.basename(dataDir).startsWith('nardy-spectator-bench-')) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

run().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
