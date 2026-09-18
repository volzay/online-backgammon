#!/usr/bin/env node
'use strict';

// Publication inspection only: GET requests, no credentials, no policy/game writes.
// Compare the exact Pages artifact, including the deployed GITHUB_SHA/env build.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const PROTOCOL = 'drand-quicknet-v1';
const CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const ASSETS = Object.freeze([
  'index.html', 'room.html', 'homegate.html', 'verify-game.html',
  'runtime-config.js', 'app.js', 'supabase-client.js', 'auth-client.js', 'rooms-client.js',
  'game.js', 'game-controller.js', 'homegate.js', 'admin-room-data.js',
  'fair-dice.js', 'fair-dice-crypto.js', 'game-verifier.js', 'verify-game-ui.js',
  'roll-verification-ui.js', 'verify-game.css', 'roll-verification.css',
]);
const RUNTIME_FIELDS = new Set(['supabaseUrl', 'supabaseAnonKey', 'siteBaseUrl', 'adminEmails',
  'deployTarget', 'fairDiceUrl', 'fairDicePublicKey']);
const sha256 = value => createHash('sha256').update(value).digest('hex');

class DeploymentError extends Error {
  constructor(code, asset) {
    super('Publication verification failed.');
    this.code = code;
    if (asset) this.asset = asset;
  }
}
function requireThat(condition, code, asset) { if (!condition) throw new DeploymentError(code, asset); }
function publicUrl(value, service = false) {
  requireThat(typeof value === 'string' && value.length <= 2048 && value === value.trim(), 'INVALID_CONFIG');
  let url;
  try { url = new URL(value); } catch { throw new DeploymentError('INVALID_CONFIG'); }
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'INVALID_CONFIG');
  if (service) {
    requireThat(url.pathname.replace(/\/$/, '') === '/fair-dice/v1', 'INVALID_CONFIG');
    return url.href.replace(/\/$/, '');
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function runtimeConfig(bytes) {
  // Never execute a downloaded script to inspect its configuration.
  const match = bytes.toString('utf8').match(/^\s*window\.NARDU_ENV\s*=\s*(\{[\s\S]*\})\s*;\s*$/);
  requireThat(match, 'RUNTIME_INVALID', 'runtime-config.js');
  let config;
  try { config = JSON.parse(match[1]); } catch { throw new DeploymentError('RUNTIME_INVALID', 'runtime-config.js'); }
  requireThat(config && typeof config === 'object' && !Array.isArray(config)
    && Object.keys(config).every(key => RUNTIME_FIELDS.has(key)), 'RUNTIME_INVALID', 'runtime-config.js');
  requireThat(config.deployTarget === 'github-pages', 'RUNTIME_INVALID', 'runtime-config.js');
  const anon = config.supabaseAnonKey;
  let publicAnon = typeof anon === 'string' && /^sb_publishable_[A-Za-z0-9_-]{20,200}$/.test(anon);
  if (!publicAnon && typeof anon === 'string' && anon.length <= 8192) {
    try {
      const parts = anon.split('.');
      const payload = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8'));
      publicAnon = parts.length === 3 && payload.role === 'anon';
    } catch { /* A secret/private/unknown key must not pass public configuration. */ }
  }
  requireThat(publicAnon, 'RUNTIME_PRIVATE_OR_INVALID_KEY', 'runtime-config.js');
  return config;
}

function checkRuntime(config, expected) {
  requireThat(config.fairDicePublicKey === expected.publicKey, 'RUNTIME_PIN_MISMATCH', 'runtime-config.js');
  requireThat(publicUrl(config.fairDiceUrl, true) === expected.fairUrl, 'RUNTIME_URL_MISMATCH', 'runtime-config.js');
  requireThat(publicUrl(config.siteBaseUrl) === expected.site, 'RUNTIME_SITE_MISMATCH', 'runtime-config.js');
  publicUrl(config.supabaseUrl);
}

function withAbort(value, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DeploymentError('FETCH_TIMEOUT'));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function bodyBytes(response, limit, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    requireThat(typeof response.arrayBuffer === 'function', 'FETCH_INVALID_BODY');
    const bytes = Buffer.from(await withAbort(response.arrayBuffer(), signal));
    requireThat(bytes.length <= limit, 'FETCH_TOO_LARGE');
    return bytes;
  }
  const chunks = [];
  let size = 0;
  let done = false;
  try {
    while (!done) {
      const next = await withAbort(reader.read(), signal);
      done = next.done;
      if (!done) {
        size += next.value.byteLength;
        requireThat(size <= limit, 'FETCH_TOO_LARGE');
        chunks.push(Buffer.from(next.value));
      }
    }
    return Buffer.concat(chunks);
  } finally {
    try { if (!done) void reader.cancel().catch(() => {}); reader.releaseLock(); } catch { /* Already aborted. */ }
  }
}

async function download(fetchImpl, url, { timeoutMs, limit, kind, origin, asset }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await withAbort(fetchImpl(url, {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { Accept: kind === 'json' ? 'application/json' : '*/*', ...(origin ? { Origin: origin } : {}) },
    }), controller.signal);
    requireThat(response.ok === true && response.status === 200, 'FETCH_HTTP_STATUS', asset);
    const type = response.headers?.get?.('content-type') || '';
    const validType = kind === 'json' ? /^application\/json(?:\s*;|$)/i.test(type)
      : kind === 'html' ? /^text\/html(?:\s*;|$)/i.test(type)
        : kind === 'css' ? /^text\/css(?:\s*;|$)/i.test(type)
          : /^(?:application|text)\/(?:javascript|x-javascript)(?:\s*;|$)/i.test(type);
    requireThat(validType, 'FETCH_CONTENT_TYPE', asset);
    const announced = response.headers?.get?.('content-length');
    requireThat(!announced || (/^\d+$/.test(announced) && Number(announced) <= limit), 'FETCH_TOO_LARGE', asset);
    const bytes = await bodyBytes(response, limit, controller.signal);
    requireThat(!controller.signal.aborted, 'FETCH_TIMEOUT', asset);
    return { bytes, headers: response.headers };
  } catch (error) {
    const code = controller.signal.aborted ? 'FETCH_TIMEOUT'
      : error instanceof DeploymentError ? error.code : 'FETCH_FAILED';
    throw new DeploymentError(code, asset);
  } finally { clearTimeout(timeout); }
}

function referencedAssets(bytes, site) {
  const urls = [];
  const base = new URL(site);
  for (const match of bytes.toString('utf8').matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    let url;
    try { url = new URL(match[1].replace(/&amp;/g, '&'), site); } catch { continue; }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) continue;
    const relative = url.pathname.slice(base.pathname.length);
    if (!ASSETS.includes(relative)) continue;
    requireThat(!url.username && !url.password && !url.hash
      && [...url.searchParams].every(([key, value]) => key === 'v' && /^[A-Za-z0-9_-]{1,64}$/.test(value))
      && url.searchParams.getAll('v').length <= 1, 'HTML_ASSET_URL_INVALID', relative);
    urls.push({ url: url.href, asset: relative });
  }
  return urls;
}

async function verifyDeployment({ distDir = path.join(__dirname, '..', 'dist'), siteBaseUrl,
  expectedFairDiceUrl, expectedPublicKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  requireThat(typeof fetchImpl === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000
    && typeof expectedPublicKey === 'string' && /^[0-9a-f]{64}$/.test(expectedPublicKey), 'INVALID_CONFIG');
  const expected = { site: publicUrl(siteBaseUrl), fairUrl: publicUrl(expectedFairDiceUrl, true), publicKey: expectedPublicKey };
  const local = new Map();
  for (const asset of ASSETS) {
    try {
      const target = path.join(distDir, asset);
      const metadata = fs.lstatSync(target);
      requireThat(metadata.isFile() && metadata.size <= 4 * 1024 * 1024, 'LOCAL_ASSET_INVALID', asset);
      local.set(asset, fs.readFileSync(target));
    } catch (error) {
      if (error instanceof DeploymentError) throw error;
      throw new DeploymentError('LOCAL_ASSET_UNAVAILABLE', asset);
    }
  }
  checkRuntime(runtimeConfig(local.get('runtime-config.js')), expected);
  const manifest = [];
  for (let offset = 0; offset < ASSETS.length; offset += 4) {
    const verified = await Promise.all(ASSETS.slice(offset, offset + 4).map(async asset => {
      const hash = sha256(local.get(asset));
      const url = new URL(asset, expected.site);
      // Public content fingerprint only, never a proof, seed, credential or pin.
      url.searchParams.set('nardu_verify', hash.slice(0, 16));
      const { bytes } = await download(fetchImpl, url.href, { timeoutMs, limit: 4 * 1024 * 1024,
        kind: asset.endsWith('.html') ? 'html' : asset.endsWith('.css') ? 'css' : 'js', asset });
      requireThat(sha256(bytes) === hash, 'ASSET_MISMATCH', asset);
      if (asset === 'runtime-config.js') checkRuntime(runtimeConfig(bytes), expected);
      return { path: asset, sha256: hash, bytes: bytes.length };
    }));
    manifest.push(...verified);
  }
  const references = new Map();
  for (const asset of ASSETS.filter(file => file.endsWith('.html'))) {
    for (const reference of referencedAssets(local.get(asset), expected.site)) references.set(reference.url, reference.asset);
  }
  for (const [url, asset] of references) {
    const { bytes } = await download(fetchImpl, url, { timeoutMs, limit: 4 * 1024 * 1024,
      kind: asset.endsWith('.css') ? 'css' : asset.endsWith('.html') ? 'html' : 'js', asset });
    requireThat(sha256(bytes) === sha256(local.get(asset)), 'REFERENCED_ASSET_MISMATCH', asset);
  }
  const origin = new URL(expected.site).origin;
  const health = await download(fetchImpl, `${expected.fairUrl}/health`, { timeoutMs, limit: 16384, kind: 'json', origin, asset: 'health' });
  let metadata;
  try { metadata = JSON.parse(health.bytes.toString('utf8')); } catch { throw new DeploymentError('HEALTH_INVALID', 'health'); }
  requireThat(metadata && metadata.ok === true && metadata.protocol === PROTOCOL && metadata.chainHash === CHAIN_HASH
    && metadata.publicKey === expected.publicKey && Number.isSafeInteger(metadata.pendingJobs) && metadata.pendingJobs >= 0,
  'HEALTH_PIN_OR_PROTOCOL_MISMATCH', 'health');
  requireThat(Object.keys(metadata).every(key => ['ok', 'protocol', 'chainHash', 'publicKey', 'pendingJobs'].includes(key)), 'HEALTH_INVALID', 'health');
  requireThat(health.headers.get('access-control-allow-origin') === origin
    && (health.headers.get('access-control-allow-methods') || '').split(',').map(value => value.trim()).includes('POST')
    && ['authorization', 'content-type', 'x-guest-id', 'x-guest-proof'].every(header =>
      (health.headers.get('access-control-allow-headers') || '').toLowerCase().split(',').map(value => value.trim()).includes(header)),
  'HEALTH_CORS_MISMATCH', 'health');
  return { ok: true, scope: 'publication-and-health-metadata', siteBaseUrl: expected.site,
    fairDiceUrl: expected.fairUrl, protocol: PROTOCOL, chainHash: CHAIN_HASH, publicKey: expected.publicKey,
    files: manifest, referencedUrlsVerified: references.size,
    notVerified: ['database-policy-activation', 'authenticated-gameplay', 'external-reservation-timing'] };
}

async function main(args = process.argv.slice(2), env = process.env) {
  const config = { siteBaseUrl: env.SITE_BASE_URL || 'https://volzay.github.io/online-backgammon/',
    expectedFairDiceUrl: env.FAIR_DICE_URL, expectedPublicKey: env.FAIR_DICE_PUBLIC_KEY };
  const fields = { '--dist': 'distDir', '--site': 'siteBaseUrl', '--fair-url': 'expectedFairDiceUrl', '--public-key': 'expectedPublicKey', '--timeout-ms': 'timeoutMs' };
  for (let index = 0; index < args.length; index += 1) {
    requireThat(Object.hasOwn(fields, args[index]) && typeof args[index + 1] === 'string', 'INVALID_CONFIG');
    config[fields[args[index]]] = args[index] === '--timeout-ms' ? Number(args[++index]) : args[++index];
  }
  return verifyDeployment(config);
}
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => {
  // Stable codes only: do not echo unsafe URLs, upstream bodies, keys or env.
  console.error(JSON.stringify({ ok: false, code: error instanceof DeploymentError ? error.code : 'VERIFICATION_FAILED',
    ...(error instanceof DeploymentError && error.asset ? { asset: error.asset } : {}) }));
  process.exitCode = 1;
});
module.exports = { ASSETS, PROTOCOL, CHAIN_HASH, runtimeConfig, referencedAssets, verifyDeployment, main };
