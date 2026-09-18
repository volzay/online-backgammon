'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DiceJournal, initializeDirectory, MAX_RECORD_BYTES } = require('../experiments/system-dice/journal.js');
const protocol = require('../experiments/system-dice/protocol.js');

const CONTEXT = Object.freeze({
  gameId: '68a64c3b-11d9-4a45-81a6-4639d68695fd', nonce: 1,
  roomCode: 'TEST-0001', variant: 'long', label: 'roll', color: 'white',
  positionHash: 'ab'.repeat(32),
});
const CLIENT_SEED = '12'.repeat(32);
const OTHER_CLIENT_SEED = '34'.repeat(32);
const JOURNAL_PATH = path.resolve(__dirname, '../experiments/system-dice/journal.js');

function temporary(t) {
  // Resolve macOS's /var -> /private/var alias before journal validation.
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'system-dice-journal-test-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const recordPath = directory => path.join(directory, CONTEXT.gameId + '-' + CONTEXT.nonce + '.json');
const lockPath = directory => path.join(directory, CONTEXT.gameId + '-' + CONTEXT.nonce + '.lock');
const readRecord = directory => JSON.parse(fs.readFileSync(recordPath(directory), 'utf8'));
const hasCode = code => error => error.code === code;

function mutateRecord(directory, transform) {
  const record = readRecord(directory);
  transform(record);
  fs.writeFileSync(recordPath(directory), JSON.stringify(record), { mode: 0o600 });
}

// Children all load the module before starting together. The fixtures contain
// no keys, production configuration, or network calls.
async function concurrentOperations(t, directory, operations) {
  const childSource = `
    'use strict';
    const { DiceJournal } = require(process.argv[1]);
    const directory = process.argv[2];
    const context = JSON.parse(process.argv[3]);
    const operation = JSON.parse(process.argv[4]);
    process.on('message', message => {
      if (message !== 'go') return;
      let result;
      try {
        const journal = new DiceJournal(directory);
        result = operation.command === 'prepare'
          ? journal.prepare(context)
          : journal.reveal(context, operation.commitment, operation.clientSeed);
        process.send({ ok: true, result }, () => process.disconnect());
      } catch (error) {
        process.send({ ok: false, code: error.code }, () => process.disconnect());
      }
    });
    process.send({ ready: true });
  `;
  const workers = operations.map(operation => {
    const child = spawn(process.execPath, ['-e', childSource, JOURNAL_PATH, directory,
      JSON.stringify(CONTEXT), JSON.stringify(operation)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let response;
    let errors = '';
    child.stderr.on('data', chunk => { errors += String(chunk); });
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const finished = new Promise((resolve, reject) => {
      child.on('message', message => {
        if (message.ready) readyResolve();
        else response = message;
      });
      child.on('error', error => { readyReject(error); reject(error); });
      child.on('exit', (code, signal) => {
        if (code !== 0 || signal || !response) {
          const error = new Error('Fixture child failed: ' + code + '/' + signal + ' ' + errors);
          readyReject(error);
          reject(error);
        } else resolve(response);
      });
    });
    return { child, ready, finished };
  });
  const finished = Promise.all(workers.map(worker => worker.finished));
  // Register aggregate rejection handling before waiting on worker readiness.
  finished.catch(() => {});
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.child.send('go');
  return finished;
}

test('prepare persists a private commitment before exposing only its public receipt', t => {
  const directory = temporary(t);
  const receipt = new DiceJournal(directory).prepare(CONTEXT);
  const stored = readRecord(directory);
  assert.deepEqual(Object.keys(receipt).sort(), ['commitment', 'context', 'protocol']);
  assert.equal(receipt.protocol, protocol.PROTOCOL);
  assert.deepEqual(receipt.context, CONTEXT);
  assert.equal(receipt.commitment, stored.commitment);
  assert.equal(protocol.commitmentFor(CONTEXT, stored.privateSeed), receipt.commitment);
  assert.equal(stored.state, 'prepared');
  assert.equal(stored.clientSeed, null);
  assert.equal(stored.proof, null);
  assert.match(stored.privateSeed, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(receipt).includes(stored.privateSeed), false);
  assert.equal(fs.statSync(recordPath(directory)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(lockPath(directory)), false);
});

test('prepare is idempotent in the same journal and after constructing a new journal', t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  const first = journal.prepare(CONTEXT);
  const storedBefore = fs.readFileSync(recordPath(directory), 'utf8');
  assert.deepEqual(journal.prepare(CONTEXT), first);
  assert.deepEqual(new DiceJournal(directory).prepare({ ...CONTEXT }), first);
  assert.equal(fs.readFileSync(recordPath(directory), 'utf8'), storedBefore);
});

for (const state of ['prepared', 'accepted', 'complete']) {
  test('gameId + nonce fixes every context field while state is ' + state, t => {
    const directory = temporary(t);
    const journal = new DiceJournal(directory);
    const receipt = journal.prepare(CONTEXT);
    if (state === 'accepted') journal.accept(CONTEXT, receipt.commitment, CLIENT_SEED);
    if (state === 'complete') journal.reveal(CONTEXT, receipt.commitment, CLIENT_SEED);
    const before = fs.readFileSync(recordPath(directory), 'utf8');
    const changed = [
      { positionHash: 'cd'.repeat(32) }, { roomCode: 'OTHR-0002' },
      { label: 'opening', color: 'none' }, { color: 'dark' }, { variant: 'short' },
    ];
    for (const update of changed) {
      const context = { ...CONTEXT, ...update };
      assert.throws(() => journal.prepare(context), hasCode('DICE_CONTEXT_CONFLICT'));
      assert.throws(() => journal.reveal(context, receipt.commitment, CLIENT_SEED), hasCode('DICE_CONTEXT_CONFLICT'));
    }
    assert.equal(fs.readFileSync(recordPath(directory), 'utf8'), before);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.json')).length, 1);
  });
}

test('first client challenge is durable before revelation and resumes after restart', t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  const receipt = journal.prepare(CONTEXT);
  assert.deepEqual(journal.accept(CONTEXT, receipt.commitment, CLIENT_SEED), { accepted: true, commitment: receipt.commitment });
  const accepted = readRecord(directory);
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.clientSeed, CLIENT_SEED);
  assert.equal(accepted.proof, null);
  const proof = new DiceJournal(directory).reveal(CONTEXT, receipt.commitment, CLIENT_SEED);
  assert.equal(readRecord(directory).state, 'complete');
  assert.equal(proof.serverSeed, accepted.privateSeed);
  assert.equal(protocol.verifyProof(proof, { context: CONTEXT, commitment: receipt.commitment, clientSeed: CLIENT_SEED }).verified, true);
});

test('reveal, accept, and prepare retain the same result after completion and restart', t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  const receipt = journal.prepare(CONTEXT);
  const proof = journal.reveal(CONTEXT, receipt.commitment, CLIENT_SEED);
  const before = fs.readFileSync(recordPath(directory), 'utf8');
  assert.deepEqual(journal.reveal(CONTEXT, receipt.commitment, CLIENT_SEED), proof);
  assert.deepEqual(new DiceJournal(directory).reveal(CONTEXT, receipt.commitment, CLIENT_SEED), proof);
  assert.deepEqual(new DiceJournal(directory).prepare(CONTEXT), receipt);
  assert.deepEqual(journal.accept(CONTEXT, receipt.commitment, CLIENT_SEED), { accepted: true, commitment: receipt.commitment });
  assert.equal(fs.readFileSync(recordPath(directory), 'utf8'), before);
});

for (const state of ['accepted', 'complete']) {
  test('a different seed or commitment cannot replace a ' + state + ' result', t => {
    const directory = temporary(t);
    const journal = new DiceJournal(directory);
    const receipt = journal.prepare(CONTEXT);
    journal.accept(CONTEXT, receipt.commitment, CLIENT_SEED);
    if (state === 'complete') journal.reveal(CONTEXT, receipt.commitment, CLIENT_SEED);
    const before = fs.readFileSync(recordPath(directory), 'utf8');
    assert.throws(() => journal.reveal(CONTEXT, receipt.commitment, OTHER_CLIENT_SEED), hasCode('DICE_SEED_CONFLICT'));
    const differentCommitment = receipt.commitment[0] === '0' ? '1' + receipt.commitment.slice(1) : '0' + receipt.commitment.slice(1);
    assert.throws(() => journal.reveal(CONTEXT, differentCommitment, CLIENT_SEED), hasCode('DICE_COMMITMENT_CONFLICT'));
    assert.equal(fs.readFileSync(recordPath(directory), 'utf8'), before);
  });
}

test('accept and reveal never implicitly prepare a fresh commitment', t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  assert.throws(() => journal.accept(CONTEXT, '56'.repeat(32), CLIENT_SEED), hasCode('DICE_NOT_PREPARED'));
  assert.throws(() => journal.reveal(CONTEXT, '56'.repeat(32), CLIENT_SEED), hasCode('DICE_NOT_PREPARED'));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('invalid seeds and commitments fail without creating any record', t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  for (const commitment of ['', 'a'.repeat(63), 'AB'.repeat(32), null]) {
    assert.throws(() => journal.reveal(CONTEXT, commitment, CLIENT_SEED), hasCode('DICE_COMMITMENT_INVALID'));
  }
  for (const clientSeed of ['', 'a'.repeat(63), 'AB'.repeat(32), null]) {
    assert.throws(() => journal.reveal(CONTEXT, '56'.repeat(32), clientSeed), hasCode('SYSTEM_DICE_SEED_INVALID'));
  }
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('directory initialization creates 0700 but never takes over an existing directory', t => {
  const parent = temporary(t);
  const directory = path.join(parent, 'journal');
  assert.equal(initializeDirectory(directory), directory);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.throws(() => initializeDirectory(directory), { code: 'EEXIST' });
  fs.chmodSync(directory, 0o755);
  assert.throws(() => new DiceJournal(directory), hasCode('DICE_DIRECTORY_INVALID'));
  assert.throws(() => initializeDirectory(directory), { code: 'EEXIST' });
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
});

test('symlinked directories and noncanonical directory paths are rejected', t => {
  const directory = temporary(t);
  const real = path.join(directory, 'real');
  initializeDirectory(real);
  const link = path.join(directory, 'link');
  fs.symlinkSync(real, link);
  assert.throws(() => new DiceJournal(link), hasCode('DICE_DIRECTORY_INVALID'));
  assert.throws(() => new DiceJournal(real + '/'), hasCode('DICE_DIRECTORY_INVALID'));
  assert.throws(() => new DiceJournal('relative-journal'), hasCode('DICE_DIRECTORY_INVALID'));
});

test('directory permissions are checked again before each operation', t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  journal.prepare(CONTEXT);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => journal.prepare(CONTEXT), hasCode('DICE_DIRECTORY_INVALID'));
});

test('record permissions, symlinks, and hard links fail closed without replacing the record', t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  journal.prepare(CONTEXT);
  const filename = recordPath(directory);
  const original = fs.readFileSync(filename, 'utf8');
  fs.chmodSync(filename, 0o644);
  assert.throws(() => journal.prepare(CONTEXT), hasCode('DICE_RECORD_INVALID'));
  fs.chmodSync(filename, 0o600);
  const hardLink = path.join(directory, 'hard-link');
  fs.linkSync(filename, hardLink);
  assert.throws(() => journal.prepare(CONTEXT), hasCode('DICE_RECORD_INVALID'));
  fs.unlinkSync(hardLink);
  const renamed = path.join(directory, 'original');
  fs.renameSync(filename, renamed);
  fs.symlinkSync(renamed, filename);
  assert.throws(() => journal.prepare(CONTEXT), hasCode('DICE_STORAGE_ERROR'));
  assert.equal(fs.readFileSync(renamed, 'utf8'), original);
  assert.equal(fs.lstatSync(filename).isSymbolicLink(), true);
});

test('wrong-owner directory is rejected when ownership fixtures are permitted', { skip: process.getuid() !== 0 }, t => {
  const directory = temporary(t);
  fs.chownSync(directory, 65534, 65534);
  assert.throws(() => new DiceJournal(directory), hasCode('DICE_DIRECTORY_INVALID'));
});

test('wrong-owner record is rejected when ownership fixtures are permitted', { skip: process.getuid() !== 0 }, t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  journal.prepare(CONTEXT);
  fs.chownSync(recordPath(directory), 65534, 65534);
  assert.throws(() => journal.prepare(CONTEXT), hasCode('DICE_RECORD_INVALID'));
});

for (const [name, mutation] of [
  ['unrecognized state', record => { record.state = 'retry'; }],
  ['prepared challenge', record => { record.clientSeed = CLIENT_SEED; }],
  ['prepared proof', record => { record.proof = {}; }],
  ['accepted missing challenge', record => { record.state = 'accepted'; }],
  ['complete missing proof', record => { record.state = 'complete'; record.clientSeed = CLIENT_SEED; }],
  ['changed private seed', record => { record.privateSeed = record.privateSeed[0] === '0' ? '1' + record.privateSeed.slice(1) : '0' + record.privateSeed.slice(1); }],
  ['changed commitment', record => { record.commitment = record.commitment[0] === '0' ? '1' + record.commitment.slice(1) : '0' + record.commitment.slice(1); }],
  ['unsupported version', record => { record.version = 2; }],
  ['surplus field', record => { record.extra = true; }],
]) {
  test('malformed journal rejects ' + name + ' without creating a new seed', t => {
    const directory = temporary(t);
    const journal = new DiceJournal(directory);
    journal.prepare(CONTEXT);
    mutateRecord(directory, mutation);
    const before = fs.readFileSync(recordPath(directory), 'utf8');
    assert.throws(() => journal.prepare(CONTEXT), hasCode('DICE_RECORD_INVALID'));
    assert.equal(fs.readFileSync(recordPath(directory), 'utf8'), before);
    assert.equal(fs.existsSync(lockPath(directory)), false);
  });
}

test('a changed stored proof is rejected instead of returned after restart', t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  const receipt = journal.prepare(CONTEXT);
  journal.reveal(CONTEXT, receipt.commitment, CLIENT_SEED);
  mutateRecord(directory, record => { record.proof.dice[0] = (record.proof.dice[0] % 6) + 1; });
  const before = fs.readFileSync(recordPath(directory), 'utf8');
  assert.throws(() => new DiceJournal(directory).reveal(CONTEXT, receipt.commitment, CLIENT_SEED), hasCode('SYSTEM_DICE_DICE_MISMATCH'));
  assert.equal(fs.readFileSync(recordPath(directory), 'utf8'), before);
});

test('invalid JSON and oversized records fail closed rather than being replaced', t => {
  const directory = temporary(t);
  const journal = new DiceJournal(directory);
  journal.prepare(CONTEXT);
  fs.writeFileSync(recordPath(directory), '{', { mode: 0o600 });
  assert.throws(() => journal.prepare(CONTEXT), hasCode('DICE_STORAGE_ERROR'));
  assert.equal(fs.readFileSync(recordPath(directory), 'utf8'), '{');
  const oversized = ' '.repeat(MAX_RECORD_BYTES + 1);
  fs.writeFileSync(recordPath(directory), oversized, { mode: 0o600 });
  assert.throws(() => journal.prepare(CONTEXT), hasCode('DICE_RECORD_INVALID'));
  assert.equal(fs.statSync(recordPath(directory)).size, MAX_RECORD_BYTES + 1);
});

test('an old crash reservation stays BUSY; it is never expired or deleted automatically', t => {
  const directory = temporary(t);
  const filename = lockPath(directory);
  fs.writeFileSync(filename, '999999999', { mode: 0o600 });
  const old = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(filename, old, old);
  assert.throws(() => new DiceJournal(directory).prepare(CONTEXT), hasCode('DICE_BUSY'));
  assert.throws(() => new DiceJournal(directory).reveal(CONTEXT, '56'.repeat(32), CLIENT_SEED), hasCode('DICE_BUSY'));
  assert.equal(fs.readFileSync(filename, 'utf8'), '999999999');
  assert.equal(fs.existsSync(recordPath(directory)), false);
});

test('a symlink crash reservation is BUSY without touching its target', t => {
  const directory = temporary(t);
  const target = path.join(directory, 'lock-target');
  fs.writeFileSync(target, 'unchanged', { mode: 0o600 });
  fs.symlinkSync(target, lockPath(directory));
  assert.throws(() => new DiceJournal(directory).prepare(CONTEXT), hasCode('DICE_BUSY'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
});

test('20 simultaneous processes prepare only one durable commitment', { timeout: 30000 }, async t => {
  const directory = temporary(t);
  const results = await concurrentOperations(t, directory, Array.from({ length: 20 }, () => ({ command: 'prepare' })));
  const successes = results.filter(result => result.ok);
  assert.ok(successes.length >= 1);
  const receipt = successes[0].result;
  for (const result of results) {
    if (result.ok) assert.deepEqual(result.result, receipt);
    else assert.equal(result.code, 'DICE_BUSY');
  }
  const stored = readRecord(directory);
  assert.equal(stored.commitment, receipt.commitment);
  assert.equal(protocol.commitmentFor(CONTEXT, stored.privateSeed), receipt.commitment);
  assert.equal(stored.state, 'prepared');
  assert.deepEqual(fs.readdirSync(directory), [path.basename(recordPath(directory))]);
  assert.deepEqual(new DiceJournal(directory).prepare(CONTEXT), receipt);
});

test('two simultaneous challenges accept only one seed and keep a stable proof', { timeout: 30000 }, async t => {
  const directory = temporary(t);
  const receipt = new DiceJournal(directory).prepare(CONTEXT);
  const results = await concurrentOperations(t, directory, [CLIENT_SEED, OTHER_CLIENT_SEED].map(clientSeed => ({
    command: 'reveal', commitment: receipt.commitment, clientSeed,
  })));
  const successes = results.filter(result => result.ok);
  // accept and reveal intentionally acquire separate locks. A first challenge
  // can be durably accepted while its initial caller sees BUSY on revelation;
  // restart must finish that same challenge, not issue another commitment.
  assert.ok(successes.length <= 1);
  for (const result of results.filter(result => !result.ok)) assert.ok(['DICE_BUSY', 'DICE_SEED_CONFLICT'].includes(result.code));
  const stored = readRecord(directory);
  assert.ok(['accepted', 'complete'].includes(stored.state));
  assert.ok([CLIENT_SEED, OTHER_CLIENT_SEED].includes(stored.clientSeed));
  const journal = new DiceJournal(directory);
  const proof = journal.reveal(CONTEXT, receipt.commitment, stored.clientSeed);
  assert.equal(readRecord(directory).state, 'complete');
  assert.deepEqual(readRecord(directory).proof, proof);
  if (successes.length) assert.deepEqual(successes[0].result, proof);
  assert.deepEqual(journal.reveal(CONTEXT, receipt.commitment, proof.clientSeed), proof);
  const losingSeed = proof.clientSeed === CLIENT_SEED ? OTHER_CLIENT_SEED : CLIENT_SEED;
  assert.throws(() => journal.reveal(CONTEXT, receipt.commitment, losingSeed), hasCode('DICE_SEED_CONFLICT'));
});
