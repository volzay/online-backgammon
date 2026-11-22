'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('shared review dispatch falls through only after a valid native empty receipt', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-dispatch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'), state = path.join(root, 'state');
  fs.mkdirSync(app); fs.mkdirSync(state); fs.mkdirSync(path.join(app, 'scripts'));
  const previous = path.join(root, 'previous.sh'), called = path.join(root, 'prior-called');
  fs.writeFileSync(previous, `echo yes > '${called}'\n`);
  // This test exercises receipt/admission logic. Actual kernel flock and the
  // immutable production closure have separate native Linux integration tests.
  const flock = path.join(root, 'flock-stub.sh');
  fs.writeFileSync(flock, '#!/bin/bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  const script = path.join(root, 'dispatch.sh');
  let source = fs.readFileSync(path.join(__dirname, '../ops/timeweb/run-adaptive-review-slice.sh'), 'utf8')
    .replace('/opt/online-backgammon-hard-adaptive-1aebb4b1-r2', app)
    .replace('/var/lib/online-backgammon-hard-adaptive-1aebb4b1-review', state)
    .replace('/opt/online-backgammon-hard-quarters-d33a1c62/ops/timeweb/dispatch-targeted.sh', previous)
    .replace('$(/usr/bin/date -u +%s)', '0')
    .replaceAll('/usr/bin/node', process.execPath).replaceAll('/usr/bin/bash', '/bin/bash')
    .replace('/usr/bin/flock', flock);
  fs.writeFileSync(script, source);
  for (const [label, code, status, prior] of [
    ['empty', 'console.log(JSON.stringify({claimed:0,lifecycle:"long-server-resumable-slices-v2",completed:[]}))', 0, true],
    ['claimed', 'console.log(JSON.stringify({claimed:1,lifecycle:"long-server-resumable-slices-v2",completed:[]}))', 0, false],
    ['malformed', 'console.log("not-json")', 65, false],
    ['ambiguous empty', 'console.log(JSON.stringify({claimed:0,lifecycle:"long-server-resumable-slices-v2",completed:[{}]}))', 65, false],
    ['native failure', 'process.exit(7)', 7, false],
  ]) {
    fs.rmSync(called, { force: true });
    fs.writeFileSync(path.join(app, 'scripts/long-bot-causal-worker.js'), code);
    const result = spawnSync('bash', [script], { encoding: 'utf8' });
    assert.equal(result.status, status, label + ': ' + result.stderr);
    assert.equal(fs.existsSync(called), prior, label);
  }
});

test('the adaptive review schedule cannot permanently exclude an existing clock lane', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ops/timeweb/run-adaptive-review-slice.sh'), 'utf8');
  assert.match(source, /\/ 600 % 7/);
  assert.match(source, /slot != 0 && slot != 2 && slot != 4/);
  for (const period of [5, 6, 10]) for (let phase = 0; phase < period; phase++) {
    assert.ok(Array.from({ length: period * 7 }, (_, i) => i)
      .some(i => i % period === phase && ![0, 2, 4].includes(i % 7)), `period ${period}, phase ${phase}`);
  }
});
