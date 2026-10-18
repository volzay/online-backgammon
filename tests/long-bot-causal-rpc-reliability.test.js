'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ENGINE_VERSION, policyImplementationId, runClaimedBatch, runtimeDigest, supabaseRpc } =
  require('../scripts/long-bot-causal-worker');

function fetchFailure(code) {
  const error = new TypeError('fetch failed');
  error.cause = Object.assign(new Error('private transport detail'), { code });
  return error;
}

function response(value) {
  return { ok: true, text: async () => JSON.stringify(value) };
}

test('RPC retries only a pre-connect failure and rechecks the production fence', async () => {
  const original = global.fetch;
  const calls = [];
  let fenceChecks = 0;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw fetchFailure('EAI_AGAIN');
    return response({ ok: true });
  };
  try {
    const result = await supabaseRpc('https://fixture.invalid/', 'synthetic-key',
      'claim_long_bot_causal_review_slices', { p_worker_id: 'worker' }, () => { fenceChecks++; });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(fenceChecks, 2);
    assert.equal(calls[0].url, calls[1].url);
    assert.equal(calls[0].options.body, calls[1].options.body);
    assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
    assert.ok(calls.every(call => call.options.headers.Connection === 'close'));
  } finally { global.fetch = original; }
});

test('RPC checkpoint opens a fresh connection after CPU-bound review outlives the server idle socket', async () => {
  // The server must run independently: a server on this event loop would not
  // close its idle socket while the simulated synchronous search is running.
  const server = new Worker(`
    const http = require('node:http');
    const { parentPort } = require('node:worker_threads');
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, connection: request.headers.connection,
        clientPort: request.socket.remotePort }));
      response.on('finish', () => setTimeout(() => request.socket.destroy(), 50));
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
  `, { eval: true });
  try {
    const port = await new Promise((resolve, reject) => {
      server.once('message', resolve);
      server.once('error', reject);
    });
    const endpoint = `http://127.0.0.1:${port}`;
    const first = await supabaseRpc(endpoint, 'synthetic-key', 'fixture');
    await new Promise(resolve => setImmediate(resolve));
    const until = Date.now() + 300;
    while (Date.now() < until) { /* Simulate a synchronous terminal rollout. */ }
    const next = await supabaseRpc(endpoint, 'synthetic-key', 'fixture');
    assert.equal(first.connection, 'close');
    assert.equal(next.connection, 'close');
    assert.notEqual(first.clientPort, next.clientPort);
  } finally { await server.terminate(); }
});

test('RPC never replays an ambiguous lost request or exposes its private cause', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw fetchFailure('ECONNRESET'); };
  try {
    await assert.rejects(
      supabaseRpc('https://fixture.invalid', 'synthetic-key', 'checkpoint_long_bot_causal_review_slice'),
      error => error.rpcOutcomeUnknown === true && error.name === 'CausalRpcTransportError'
        && /checkpoint_long_bot_causal_review_slice transport failed \(ECONNRESET; request; attempts=1\)/.test(error.message)
        && !error.message.includes('private transport detail'),
    );
    assert.equal(calls, 1);
  } finally { global.fetch = original; }
});

test('pre-connect retries are bounded and a mixed-cause failure is never replayed', async () => {
  const original = global.fetch;
  try {
    let calls = 0;
    global.fetch = async () => { calls++; throw fetchFailure('ECONNREFUSED'); };
    await assert.rejects(
      supabaseRpc('https://fixture.invalid', 'synthetic-key', 'claim_long_bot_causal_review_slices'),
      /attempts=3/,
    );
    assert.equal(calls, 3);

    calls = 0;
    const mixed = new TypeError('fetch failed');
    mixed.cause = new AggregateError([
      Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
    ]);
    global.fetch = async () => { calls++; throw mixed; };
    await assert.rejects(
      supabaseRpc('https://fixture.invalid', 'synthetic-key', 'claim_long_bot_causal_review_slices'),
      error => error.rpcOutcomeUnknown === true,
    );
    assert.equal(calls, 1);
  } finally { global.fetch = original; }
});

test('RPC response loss, timeout and malformed success never replay a mutation', async () => {
  const original = global.fetch;
  try {
    for (const mocked of [
      async () => ({ ok: true, text: async () => { throw fetchFailure('UND_ERR_SOCKET'); } }),
      async (_url, options) => { assert.ok(options.signal instanceof AbortSignal);
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
      async () => ({ ok: true, text: async () => '{not-json' }),
    ]) {
      let calls = 0;
      global.fetch = async (...args) => { calls++; return mocked(...args); };
      await assert.rejects(supabaseRpc('https://fixture.invalid', 'synthetic-key',
        'checkpoint_long_bot_causal_review_slice'), error => error.rpcOutcomeUnknown === true);
      assert.equal(calls, 1);
    }
  } finally { global.fetch = original; }
});

test('production leaves an ambiguous checkpoint lease for SQL reconciliation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/long-bot-causal-worker.js'), 'utf8');
  const body = source.slice(source.indexOf('async function runResumableClaimedBatch'),
    source.indexOf('async function runClaimedBatch'));
  const uncertain = body.indexOf('if (error?.rpcOutcomeUnknown === true)');
  const failure = body.indexOf("await fencedRpc('fail_long_bot_causal_review_job'");
  assert.ok(uncertain > 0 && failure > uncertain);
  assert.match(body.slice(uncertain, failure), /reason: 'rpc-outcome-unknown'/);
  assert.doesNotMatch(body.slice(uncertain, failure), /p_progress:|p_result:|fail_long_bot_causal_review_job/);
});

test('a lost completion response never sends a failure RPC for that leased job', async () => {
  const game = { id: '42c6ab46-f84a-567f-8f75-cd948a9c8a2e', room_code: 'CLAIM-TEST',
    engine_version: ENGINE_VERSION, difficulty: 'hard', bot_color: 'white', winner: 'dark',
    decisions: [], final_state: { variant: 'long' } };
  const archiveFingerprintSource = JSON.stringify(game);
  const job = { jobId: 1, runtimeDigest: runtimeDigest(), policyImplementationId: policyImplementationId(),
    archiveFingerprintSource,
    archiveFingerprint: crypto.createHash('sha256').update(archiveFingerprintSource).digest('hex'),
    trainingGame: game };
  const original = global.fetch;
  const calls = [];
  global.fetch = async url => {
    const name = url.split('/').at(-1);
    calls.push(name);
    if (name === 'claim_long_bot_causal_review_jobs') return response([job]);
    if (name === 'complete_long_bot_causal_review_job') throw fetchFailure('ECONNRESET');
    throw new Error(`unexpected RPC: ${name}`);
  };
  try {
    const result = await runClaimedBatch({ supabaseUrl: 'https://fixture.invalid',
      serviceRoleKey: 'synthetic-key', workerId: 'test-worker' });
    assert.equal(result.completed[0].reason, 'rpc-outcome-unknown');
    assert.deepEqual(calls,
      ['claim_long_bot_causal_review_jobs', 'complete_long_bot_causal_review_job']);
  } finally { global.fetch = original; }
});
