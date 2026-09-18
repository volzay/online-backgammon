#!/usr/bin/env node
'use strict';

// Run as an unprivileged systemd user behind the existing HTTPS reverse proxy.
// Signing and Supabase service credentials remain on the server, never Pages.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SupabaseFairDiceStore } = require('../lib/fair-dice-supabase-store.js');
const { createFairDiceService } = require('../lib/fair-dice-service.js');

function listenHost(env = process.env, existsSync = fs.existsSync) {
  const host = env.FAIR_DICE_HOST || '127.0.0.1';
  if (host === '127.0.0.1') return host;
  // Docker-only internal listener: the deployment template attaches it to the
  // private backend network without publishing a host port. The flag alone is
  // deliberately insufficient on a normal host.
  if (host === '0.0.0.0' && env.FAIR_DICE_INTERNAL_CONTAINER === '1' && existsSync('/.dockerenv')) return host;
  throw new Error('CONFIG');
}

async function main() {
  const host = listenHost();
  const keyFile = process.env.FAIR_DICE_SIGNING_KEY_FILE;
  if (!keyFile || !path.isAbsolute(keyFile)) throw new Error('CONFIG');
  const metadata = fs.lstatSync(keyFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 256) throw new Error('CONFIG');
  const signingKey = fs.readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(signingKey)) throw new Error('CONFIG');
  const origins = (process.env.FAIR_DICE_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error('CONFIG');
  const port = Number(process.env.FAIR_DICE_PORT || '3895');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('CONFIG');
  const store = new SupabaseFairDiceStore({
    url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const service = createFairDiceService({ store, signingKey, allowedOrigins: origins });
  const server = http.createServer({ maxHeaderSize: 16384 }, service.handler);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  console.log('Fair dice coordinator listening on its protected interface.');
  // SQL ledger survives restarts. Recovery cannot allocate another reservation.
  const resume = async () => {
    try { await service.resumePending(); }
    catch { console.warn('Fair dice ledger recovery will retry; backend temporarily unavailable.'); }
  };
  await resume();
  const recovery = setInterval(resume, 30000);
  recovery.unref();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(recovery);
    const timeout = setTimeout(() => process.exit(1), 12000);
    timeout.unref();
    await service.close();
    await new Promise(resolve => server.close(resolve));
    clearTimeout(timeout);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) main().catch(() => {
  // Never print environment values, key-file contents or upstream error text.
  console.error('Fair dice coordinator failed to start; check protected server configuration.');
  process.exitCode = 1;
});

module.exports = { main, listenHost };
