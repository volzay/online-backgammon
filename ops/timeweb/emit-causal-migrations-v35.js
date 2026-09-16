#!/usr/bin/env node
'use strict';

// Local emitter for ONE transaction. It never connects to production or
// handles credentials. Only reviewed migration bytes are accepted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const files = [
  ['supabase/long-bot-strategy-v35.sql', '791dd970bde3a55e783f073c5eee5fc8e31627cd787010d2556378cbb9c6a5d3'],
  ['supabase/long-bot-causal-learning-v35.sql', '47a404ee6ac78449b7a46e276365033d3359d73e8300eff297a7aaa920fbb273'],
  ['supabase/long-bot-causal-resume-v35.sql', 'e8673f8e09a29c8e2fb958f95d9906dc4f57373ac82608ff18e82a6cd78ee0c6'],
];
const captured = files.map(([name, expected]) => {
  const bytes = fs.readFileSync(path.join(root, name));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const text = bytes.toString('utf8');
  if (digest !== expected || !/^begin;\s/.test(text) || !/\scommit;\s*$/.test(text)) {
    throw new Error(`Unreviewed migration/wrapper: ${name}`);
  }
  const body = text.replace(/^begin;\s*/, '').replace(/\scommit;\s*$/, '');
  if (/^\s*(?:begin|commit|rollback)\s*;/im.test(body) || /^\s*\\/m.test(body)) {
    throw new Error(`Unexpected transaction/psql control: ${name}`);
  }
  return { name, digest, body };
});
process.stdout.write(['\\set ON_ERROR_STOP on', 'BEGIN;',
  "SET LOCAL lock_timeout = '5s';", "SET LOCAL statement_timeout = '120s';",
  "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('long-bot-v35-causal-deployment', 0));",
  ...captured.map(({ name, digest, body }) => `-- ${name} SHA256 ${digest}\n${body}`),
  "notify pgrst, 'reload schema';", 'COMMIT;'].join('\n') + '\n');
