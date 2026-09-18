'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const configure = require('../scripts/fair-dice-build-config.js');
const key = 'ab'.repeat(32);

test('legacy builds remain unconfigured and never inherit a test receipt pin', () => {
  assert.deepEqual(configure({}), { fairDiceUrl: '', fairDicePublicKey: '' });
});

test('a production service base requires its pinned public key before assets change', () => {
  assert.throws(() => configure({ FAIR_DICE_URL: 'https://api.example.org/fair-dice/v1' }), /pinned public key/);
  assert.deepEqual(configure({ FAIR_DICE_URL: 'https://api.example.org/fair-dice/v1/', FAIR_DICE_PUBLIC_KEY: key }),
    { fairDiceUrl: 'https://api.example.org/fair-dice/v1', fairDicePublicKey: key });
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build-github-pages.js'), 'utf8');
  const validationOffset = source.indexOf('const FAIR_DICE_CONFIG = fairDiceBuildConfig();');
  assert.ok(validationOffset >= 0 && validationOffset < source.indexOf('fs.rmSync(DIST'));
  assert.ok(source.includes('...FAIR_DICE_CONFIG'));
});

test('offline receipt proof viewing permits a public pin without enabling a service', () => {
  assert.deepEqual(configure({ FAIR_DICE_PUBLIC_KEY: key }), { fairDiceUrl: '', fairDicePublicKey: key });
});

test('invalid keys, foreign insecure origins and ambiguous endpoint bases fail closed', () => {
  for (const publicKey of ['ab', 'AB'.repeat(32), 'xz'.repeat(32), `${key}\n`]) {
    assert.throws(() => configure({ FAIR_DICE_PUBLIC_KEY: publicKey }), /public key/);
  }
  for (const url of ['not a URL', 'http://api.example.org/fair-dice/v1', 'ftp://localhost/fair-dice/v1',
    'https://user:password@api.example.org/fair-dice/v1', 'https://api.example.org/fair-dice/v1?token=bad',
    'https://api.example.org/fair-dice/v1#bad', 'https://api.example.org/', 'https://api.example.org/fair-dice/v2']) {
    assert.throws(() => configure({ FAIR_DICE_URL: url, FAIR_DICE_PUBLIC_KEY: key }));
  }
});

test('explicit loopback development bases are permitted without weakening remote HTTPS', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const url = `http://${host}:3895/fair-dice/v1`;
    assert.equal(configure({ FAIR_DICE_URL: url, FAIR_DICE_PUBLIC_KEY: key }).fairDiceUrl, url);
  }
});
