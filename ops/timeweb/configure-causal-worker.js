#!/usr/bin/env node
'use strict';

// Root-only installation helper. Secrets are read on the VPS and never
// returned, copied into the checkout, sent to Pages, or printed in logs.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Root Linux installation required');
const directory = '/etc/online-backgammon';
const target = path.join(directory, 'long-bot-causal-worker.env');
if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
const stat = fs.lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o7777) !== 0o700
  || fs.realpathSync(directory) !== directory || fs.existsSync(target)) {
  throw new Error('Refusing an untrusted configuration directory or existing environment file');
}
const inspected = JSON.parse(execFileSync('/usr/bin/docker', ['inspect', 'supabase-kong'], { encoding: 'utf8' }));
const environment = new Map(inspected[0].Config.Env.map(entry => {
  const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)];
}));
const secret = environment.get('SUPABASE_SERVICE_KEY');
let role;
try { role = JSON.parse(Buffer.from(secret.split('.')[1], 'base64url')).role; } catch { /* Fail closed below. */ }
if (role !== 'service_role' || typeof secret !== 'string' || !/^[A-Za-z0-9_.-]{100,4096}$/.test(secret)) {
  throw new Error('No valid existing service-role JWT found in the Supabase gateway');
}
const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
  | fs.constants.O_NOFOLLOW, 0o600);
try {
  fs.writeFileSync(descriptor, `SUPABASE_URL=https://api.201-51-7-193.sslip.io\nSUPABASE_SERVICE_ROLE_KEY=${secret}\n`);
  fs.fchmodSync(descriptor, 0o600); fs.fsyncSync(descriptor);
} finally { fs.closeSync(descriptor); }
const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
process.stdout.write('Private worker environment installed (root-owned 0600); secret not displayed.\n');
