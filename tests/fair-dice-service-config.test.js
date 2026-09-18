'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { listenHost } = require('../scripts/fair-dice-service.js');

test('coordinator defaults to loopback even when an internal-container flag is present', () => {
  const unexpectedCheck = () => { throw new Error('No container check is needed for loopback'); };
  assert.equal(listenHost({}, unexpectedCheck), '127.0.0.1');
  assert.equal(listenHost({ FAIR_DICE_INTERNAL_CONTAINER: '1' }, unexpectedCheck), '127.0.0.1');
  assert.equal(listenHost({ FAIR_DICE_HOST: '127.0.0.1', FAIR_DICE_INTERNAL_CONTAINER: '1' }, unexpectedCheck), '127.0.0.1');
});

test('all-interface listening requires both explicit opt-in and a real Docker marker check', () => {
  const checks = [];
  const exists = file => { checks.push(file); return true; };
  assert.equal(listenHost({ FAIR_DICE_HOST: '0.0.0.0', FAIR_DICE_INTERNAL_CONTAINER: '1' }, exists), '0.0.0.0');
  assert.deepEqual(checks, ['/.dockerenv']);
  assert.throws(() => listenHost({ FAIR_DICE_HOST: '0.0.0.0', FAIR_DICE_INTERNAL_CONTAINER: '1' }, () => false), /CONFIG/);
  for (const flag of [undefined, '', 'true', 'yes', '0', 1]) {
    assert.throws(() => listenHost({ FAIR_DICE_HOST: '0.0.0.0', FAIR_DICE_INTERNAL_CONTAINER: flag }, exists), /CONFIG/);
  }
});

test('production listener validation reads the filesystem marker rather than trusting the flag', () => {
  const env = { FAIR_DICE_HOST: '0.0.0.0', FAIR_DICE_INTERNAL_CONTAINER: '1' };
  if (fs.existsSync('/.dockerenv')) assert.equal(listenHost(env), '0.0.0.0');
  else assert.throws(() => listenHost(env), /CONFIG/);
});

test('arbitrary DNS, IPv6, wildcard and public interface hosts are rejected', () => {
  for (const host of ['localhost', '::', '::1', '*', '127.0.0.2', '201.51.7.193', '0.0.0.0 ', 'supabase-caddy']) {
    assert.throws(() => listenHost({ FAIR_DICE_HOST: host, FAIR_DICE_INTERNAL_CONTAINER: '1' }, () => true), /CONFIG/);
  }
});
