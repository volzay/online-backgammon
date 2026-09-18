#!/usr/bin/env node
'use strict';

// Emit a reviewed installation + synthetic smoke as ONE transaction that ends
// only in ROLLBACK. This program does not connect to a server or read credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const REVIEWED = Object.freeze([
  ['fair-dice-v37.sql', '92013331d9120e5882c717f85869ed0287e290a74cc41daf019c2d60e33e5f15'],
  ['tests/fair-dice-v37-rollback-smoke.sql', '135956d796bc1a2188cc565c2be3415a00cce7a51c1f88e1af5f88fd983baf02'],
]);

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function buildSmoke(installer, fixtures) {
  if (typeof installer !== 'string' || !Array.isArray(fixtures) || fixtures.length !== 1
      || fixtures.some(value => typeof value !== 'string')
      || !/^begin;\s/i.test(installer) || !/commit;\s*$/i.test(installer)) {
    throw new Error('Unexpected migration or fixture wrapper.');
  }
  const migration = installer.replace(/^begin;\s*/i, '').replace(/commit;\s*$/i, '');
  for (const body of [migration, ...fixtures]) {
    if (/^\s*(?:begin|commit|rollback)\s*;/im.test(body) || /^\s*\\/m.test(body)) {
      throw new Error('Unexpected transaction or psql control.');
    }
  }
  return [
    '\\set ON_ERROR_STOP on',
    'BEGIN;',
    'SET LOCAL search_path = pg_catalog, public, extensions;',
    "SET LOCAL statement_timeout = '60s';",
    "SET LOCAL lock_timeout = '5s';",
    migration, ...fixtures,
    "SELECT 'fair_dice_v37_smoke_passed' AS result;",
    'ROLLBACK;', '',
  ].join('\n');
}

function main(args = process.argv.slice(2)) {
  if (args.length) throw new Error('No arguments are accepted.');
  const captured = REVIEWED.map(([name, expected]) => {
    const bytes = fs.readFileSync(path.join(root, 'supabase', name));
    if (digest(bytes) !== expected) throw new Error('Unreviewed smoke artifact.');
    return bytes.toString('utf8');
  });
  const output = buildSmoke(captured[0], [captured[1]]);
  process.stdout.write(output);
  return output;
}

if (require.main === module) main();

module.exports = { buildSmoke, main, REVIEWED };

