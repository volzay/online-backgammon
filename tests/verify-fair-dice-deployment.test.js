'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const verifier = require('../scripts/verify-fair-dice-deployment.js');

const SITE = 'https://site.example.test/portal/';
const FAIR_URL = 'https://api.example.test/fair-dice/v1';
const PUBLIC_KEY = 'ab'.repeat(32); // Test-only public verification key, not a credential.
const RUNTIME = {
  supabaseUrl: 'https://api.example.test',
  supabaseAnonKey: `sb_publishable_${'p'.repeat(30)}`,
  siteBaseUrl: SITE,
  adminEmails: '',
  deployTarget: 'github-pages',
  fairDiceUrl: FAIR_URL,
  fairDicePublicKey: PUBLIC_KEY,
};
const HEALTH = { ok: true, protocol: verifier.PROTOCOL, chainHash: verifier.CHAIN_HASH,
  publicKey: PUBLIC_KEY, pendingJobs: 0 };
const CORS = { 'access-control-allow-origin': new URL(SITE).origin,
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, X-Guest-Id, X-Guest-Proof' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeBytes = config => Buffer.from(`window.NARDU_ENV = ${JSON.stringify(config)};\n`);
const typeFor = asset => asset.endsWith('.html') ? 'text/html' : asset.endsWith('.css') ? 'text/css' : 'text/javascript';

function fixture(t, { runtime = RUNTIME, override } = {}) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nardu-publication-test-'));
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  const bytes = new Map(verifier.ASSETS.map(asset => [asset, Buffer.from(asset.endsWith('.html')
    ? '<!doctype html><script src="runtime-config.js?v=release123"></script><script src="fair-dice.js?v=release123"></script><link href="verify-game.css?v=release123" rel="stylesheet">'
    : asset.endsWith('.css') ? '/* fixture */' : '// fixture\n')]));
  bytes.set('runtime-config.js', runtimeBytes(runtime));
  for (const [asset, content] of bytes) fs.writeFileSync(path.join(distDir, asset), content);
  const calls = [];
  const fetchImpl = async (href, init) => {
    const url = new URL(href);
    calls.push({ url, init });
    const asset = url.pathname.endsWith('/health') ? 'health' : url.pathname.slice(new URL(SITE).pathname.length);
    const custom = override?.({ asset, url, init, bytes, calls });
    if (custom !== undefined) return custom;
    assert.ok(asset === 'health' || bytes.has(asset), `Unexpected read-only URL: ${url.pathname}`);
    return new Response(asset === 'health' ? JSON.stringify(HEALTH) : bytes.get(asset), {
      status: 200, headers: { 'content-type': asset === 'health' ? 'application/json; charset=utf-8' : `${typeFor(asset)}; charset=utf-8`,
        ...(asset === 'health' ? CORS : {}) },
    });
  };
  return { distDir, bytes, calls, fetchImpl, options: { distDir, siteBaseUrl: SITE,
    expectedFairDiceUrl: FAIR_URL, expectedPublicKey: PUBLIC_KEY, fetchImpl, timeoutMs: 1000 } };
}

function rejected(code, asset) {
  return error => {
    assert.equal(error.code, code);
    if (asset) assert.equal(error.asset, asset);
    assert.equal(error.message, 'Publication verification failed.');
    return true;
  };
}

test('publication verifier matches exact artifacts and actual HTML cache URLs using GET only', async t => {
  const f = fixture(t);
  const result = await verifier.verifyDeployment(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'publication-and-health-metadata');
  assert.equal(result.referencedUrlsVerified, 3);
  assert.equal(result.files.length, verifier.ASSETS.length);
  for (const file of result.files) {
    assert.equal(file.sha256, digest(f.bytes.get(file.path)));
    assert.equal(file.bytes, f.bytes.get(file.path).length);
  }
  assert.deepEqual(result.notVerified, ['database-policy-activation', 'authenticated-gameplay', 'external-reservation-timing']);
  assert.equal(f.calls.length, verifier.ASSETS.length + 3 + 1);
  for (const { url, init } of f.calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers.Cookie, undefined);
    assert.equal(init.body, undefined);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.hash, '');
    if (url.pathname.endsWith('/health')) assert.equal(init.headers.Origin, new URL(SITE).origin);
    else assert.equal(init.headers.Origin, undefined);
  }
  const exact = f.calls.filter(call => call.url.searchParams.has('v'));
  assert.equal(exact.length, 3);
  assert.ok(exact.every(call => call.url.search === '?v=release123'));
});

test('chain and protocol match the actual common proof implementation', () => {
  const common = require('../fair-dice.js');
  assert.equal(verifier.PROTOCOL, common.PROTOCOL);
  assert.equal(verifier.CHAIN_HASH, common.CHAIN.hash);
});

test('dual coordinator health accepts only the exact supported protocol allowlist', async t => {
  for (const supportedProtocols of [[verifier.PROTOCOL, 'system-csprng-v1'],
    ['system-csprng-v1'], [verifier.PROTOCOL, 'unknown'], [verifier.PROTOCOL, 'system-csprng-v1', 'unknown'], 'system-csprng-v1']) {
    const f = fixture(t, { override: ({ asset }) => asset === 'health'
      ? new Response(JSON.stringify({ ...HEALTH, supportedProtocols }), { headers: { 'content-type': 'application/json', ...CORS } })
      : undefined });
    if (Array.isArray(supportedProtocols) && supportedProtocols.length === 2 && supportedProtocols[1] === 'system-csprng-v1') {
      assert.equal((await verifier.verifyDeployment(f.options)).ok, true);
    } else await assert.rejects(verifier.verifyDeployment(f.options), rejected('HEALTH_INVALID', 'health'));
  }
});

test('mismatched public asset fails without treating reachable deployment as verified', async t => {
  const f = fixture(t, { override: ({ asset }) => asset === 'game-controller.js'
    ? new Response('// old version', { headers: { 'content-type': 'text/javascript' } }) : undefined });
  await assert.rejects(verifier.verifyDeployment(f.options), rejected('ASSET_MISMATCH', 'game-controller.js'));
});

test('stale exact runtime URL is rejected even when cache-busted runtime matches', async t => {
  const f = fixture(t, { override: ({ asset, url }) => asset === 'runtime-config.js' && url.searchParams.has('v')
    ? new Response(runtimeBytes({ ...RUNTIME, fairDicePublicKey: '' }), { headers: { 'content-type': 'text/javascript' } }) : undefined });
  await assert.rejects(verifier.verifyDeployment(f.options), rejected('REFERENCED_ASSET_MISMATCH', 'runtime-config.js'));
});

test('local artifact public pin is independently checked before any network read', async t => {
  const f = fixture(t, { runtime: { ...RUNTIME, fairDicePublicKey: 'cd'.repeat(32) } });
  await assert.rejects(verifier.verifyDeployment(f.options), rejected('RUNTIME_PIN_MISMATCH', 'runtime-config.js'));
  assert.equal(f.calls.length, 0);
});

test('local artifact source and site cannot silently replace expected trusted URLs', async t => {
  for (const [field, value, code] of [
    ['fairDiceUrl', 'https://other.example.test/fair-dice/v1', 'RUNTIME_URL_MISMATCH'],
    ['siteBaseUrl', 'https://other.example.test/portal/', 'RUNTIME_SITE_MISMATCH'],
  ]) {
    const f = fixture(t, { runtime: { ...RUNTIME, [field]: value } });
    await assert.rejects(verifier.verifyDeployment(f.options), rejected(code, 'runtime-config.js'));
    assert.equal(f.calls.length, 0);
  }
});

test('runtime config is parsed as JSON without eval or private/unknown fields', () => {
  globalThis.narduPublicationMustNotRun = 0;
  assert.throws(() => verifier.runtimeConfig(Buffer.from('window.NARDU_ENV = (globalThis.narduPublicationMustNotRun = 1, {});')), rejected('RUNTIME_INVALID', 'runtime-config.js'));
  assert.throws(() => verifier.runtimeConfig(Buffer.from(`window.NARDU_ENV = ${JSON.stringify(RUNTIME)}; globalThis.narduPublicationMustNotRun = 1;`)), rejected('RUNTIME_INVALID', 'runtime-config.js'));
  assert.equal(globalThis.narduPublicationMustNotRun, 0);
  delete globalThis.narduPublicationMustNotRun;
  assert.throws(() => verifier.runtimeConfig(runtimeBytes({ ...RUNTIME, serviceRoleKey: 'private' })), rejected('RUNTIME_INVALID', 'runtime-config.js'));
  for (const key of ['sb_secret_private', `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.y`, 'not-a-public-key']) {
    assert.throws(() => verifier.runtimeConfig(runtimeBytes({ ...RUNTIME, supabaseAnonKey: key })), rejected('RUNTIME_PRIVATE_OR_INVALID_KEY', 'runtime-config.js'));
  }
  const anon = `x.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.y`;
  assert.equal(verifier.runtimeConfig(runtimeBytes({ ...RUNTIME, supabaseAnonKey: anon })).supabaseAnonKey, anon);
});

test('unsafe or secret-bearing public URLs and missing expected pins fail before fetch', async t => {
  const f = fixture(t);
  for (const config of [
    { siteBaseUrl: 'http://site.example.test/portal/' },
    { siteBaseUrl: 'https://user:secret@site.example.test/portal/' },
    { siteBaseUrl: `${SITE}?token=private` },
    { siteBaseUrl: `${SITE}#proof=private` },
    { expectedFairDiceUrl: `${FAIR_URL}?key=private` },
    { expectedFairDiceUrl: 'https://api.example.test/wrong-path' },
    { expectedPublicKey: '' },
    { expectedPublicKey: PUBLIC_KEY.toUpperCase() },
    { timeoutMs: 30001 },
    { timeoutMs: 0 },
  ]) await assert.rejects(verifier.verifyDeployment({ ...f.options, ...config }), rejected('INVALID_CONFIG'));
  assert.equal(f.calls.length, 0);
});

test('referenced assets are restricted to the site path and safe release query', () => {
  assert.deepEqual(verifier.referencedAssets(Buffer.from('<script src="https://external.test/portal/runtime-config.js"></script><script src="/aaaaaa/runtime-config.js"></script>'), SITE), []);
  assert.deepEqual(verifier.referencedAssets(Buffer.from('<script src="runtime-config.js?v=release_123"></script>'), SITE), [
    { url: `${SITE}runtime-config.js?v=release_123`, asset: 'runtime-config.js' },
  ]);
  for (const suffix of ['?token=private', '?v=a&v=b', '#proof=private', '?v=%3Cscript%3E']) {
    assert.throws(() => verifier.referencedAssets(Buffer.from(`<script src="runtime-config.js${suffix}"></script>`), SITE), rejected('HTML_ASSET_URL_INVALID', 'runtime-config.js'));
  }
});

test('missing and symbolic-link local assets cannot be published as matching regular files', async t => {
  const missing = fixture(t);
  fs.unlinkSync(path.join(missing.distDir, 'game-controller.js'));
  await assert.rejects(verifier.verifyDeployment(missing.options), rejected('LOCAL_ASSET_UNAVAILABLE', 'game-controller.js'));
  assert.equal(missing.calls.length, 0);
  const linked = fixture(t);
  fs.unlinkSync(path.join(linked.distDir, 'game-controller.js'));
  fs.symlinkSync(path.join(linked.distDir, 'game.js'), path.join(linked.distDir, 'game-controller.js'));
  await assert.rejects(verifier.verifyDeployment(linked.options), rejected('LOCAL_ASSET_INVALID', 'game-controller.js'));
  assert.equal(linked.calls.length, 0);
});

test('HTTP failures, incorrect content types and announced oversized files fail closed', async t => {
  for (const [code, response] of [
    ['FETCH_HTTP_STATUS', () => new Response('missing', { status: 404, headers: { 'content-type': 'text/html' } })],
    ['FETCH_CONTENT_TYPE', () => new Response('// wrong MIME', { headers: { 'content-type': 'text/plain' } })],
    ['FETCH_TOO_LARGE', () => new Response('', { headers: { 'content-type': 'text/html', 'content-length': String(4 * 1024 * 1024 + 1) } })],
  ]) {
    const f = fixture(t, { override: ({ asset }) => asset === 'index.html' ? response() : undefined });
    await assert.rejects(verifier.verifyDeployment(f.options), rejected(code, 'index.html'));
  }
});

test('actual streamed body is bounded independently of content-length', async t => {
  const f = fixture(t, { override: ({ asset }) => asset === 'index.html'
    ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); controller.close(); } }), { headers: { 'content-type': 'text/html' } }) : undefined });
  await assert.rejects(verifier.verifyDeployment(f.options), rejected('FETCH_TOO_LARGE', 'index.html'));
});

test('upstream fetch that ignores AbortSignal still has bounded timeout', async t => {
  const f = fixture(t, { override: ({ asset }) => asset === 'index.html' ? new Promise(() => {}) : undefined });
  await assert.rejects(verifier.verifyDeployment({ ...f.options, timeoutMs: 5 }), rejected('FETCH_TIMEOUT', 'index.html'));
});

test('response body that never arrives cannot produce successful status after timeout', async t => {
  const f = fixture(t, { override: ({ asset }) => asset === 'index.html' ? {
    ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: () => new Promise(() => {}),
  } : undefined });
  await assert.rejects(verifier.verifyDeployment({ ...f.options, timeoutMs: 5 }), rejected('FETCH_TIMEOUT', 'index.html'));
});

test('health requires exact chain, protocol and independent key with valid bounded metadata', async t => {
  for (const mutation of [
    { ok: false }, { protocol: 'unknown-v1' }, { chainHash: '00'.repeat(32) },
    { publicKey: 'cd'.repeat(32) }, { pendingJobs: -1 }, { pendingJobs: 1.5 }, { pendingJobs: undefined },
  ]) {
    const f = fixture(t, { override: ({ asset }) => asset === 'health'
      ? new Response(JSON.stringify({ ...HEALTH, ...mutation }), { headers: { 'content-type': 'application/json', ...CORS } }) : undefined });
    await assert.rejects(verifier.verifyDeployment(f.options), rejected('HEALTH_PIN_OR_PROTOCOL_MISMATCH', 'health'));
  }
});

test('health parse and unexpected fields do not echo upstream private information', async t => {
  for (const text of ['{password:secret}', JSON.stringify({ ...HEALTH, privateKey: 'private-test-marker' })]) {
    const f = fixture(t, { override: ({ asset }) => asset === 'health'
      ? new Response(text, { headers: { 'content-type': 'application/json', ...CORS } }) : undefined });
    await assert.rejects(verifier.verifyDeployment(f.options), error => {
      rejected('HEALTH_INVALID', 'health')(error);
      assert.doesNotMatch(String(error), /secret|private-test-marker/);
      return true;
    });
  }
});

test('health CORS must permit actual Pages origin and authorized browser request headers', async t => {
  for (const mutation of [
    { 'access-control-allow-origin': '*' },
    { 'access-control-allow-methods': 'GET, OPTIONS' },
    { 'access-control-allow-headers': 'Authorization, Content-Type, X-Guest-Id' },
  ]) {
    const f = fixture(t, { override: ({ asset }) => asset === 'health'
      ? new Response(JSON.stringify(HEALTH), { headers: { 'content-type': 'application/json', ...CORS, ...mutation } }) : undefined });
    await assert.rejects(verifier.verifyDeployment(f.options), rejected('HEALTH_CORS_MISMATCH', 'health'));
  }
});

test('CLI errors contain only stable codes, never unsafe URL credentials or expected key', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'verify-fair-dice-deployment.js'),
    '--site', 'https://user:private-test-password@site.example.test/portal/',
    '--fair-url', FAIR_URL, '--public-key', PUBLIC_KEY], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, code: 'INVALID_CONFIG' });
  assert.doesNotMatch(result.stderr, /private-test-password|user:|abababab/);
});

test('CLI rejects unknown and inherited-property flags rather than silently ignoring them', async () => {
  const env = { SITE_BASE_URL: SITE, FAIR_DICE_URL: FAIR_URL, FAIR_DICE_PUBLIC_KEY: PUBLIC_KEY };
  for (const args of [['--unknown', 'x'], ['constructor', 'x'], ['__proto__', 'x'], ['--dist']]) {
    await assert.rejects(verifier.main(args, env), rejected('INVALID_CONFIG'));
  }
});
