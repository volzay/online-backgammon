'use strict';

// Emit one all-or-nothing PostgreSQL transaction. No fixture may be installed
// persistently: ON_ERROR_STOP terminates a failed session and PG rolls it back.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const file = name => fs.readFileSync(path.join(root, 'supabase', name), 'utf8');
const installer = file('fair-dice-v36.sql');
if (!/^begin;\s/i.test(installer) || !/commit;\s*$/i.test(installer)) throw new Error('Unexpected migration wrapper.');
const migration = installer.replace(/^begin;\s*/i, '').replace(/commit;\s*$/i, '');
const fixtureNames = ['tests/fair-dice-v36-rollback-smoke.sql', 'tests/fair-dice-v36-extra-rollback-smoke.sql'];
const fixtures = fixtureNames.map(file);
if (fixtures.some(text => /^\s*(?:begin|commit|rollback)\s*;/im.test(text))) throw new Error('Nested fixture transaction.');
process.stdout.write('BEGIN;\nSET LOCAL search_path = pg_catalog, public, extensions;\nSET LOCAL statement_timeout = \'45s\';\nSET LOCAL lock_timeout = \'5s\';\n');
process.stdout.write(migration + '\n' + fixtures.join('\n') + '\n');
process.stdout.write("SELECT 'fair_dice_v36_smokes_passed' AS result;\nROLLBACK;\n");
