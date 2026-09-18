'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { demonstration } = require('../experiments/system-dice/program.js');
const { PROTOCOL, verifyProof } = require('../experiments/system-dice/protocol.js');
const { DiceJournal } = require('../experiments/system-dice/journal.js');
const PROGRAM = path.resolve(__dirname, '../experiments/system-dice/program.js');
const CONTEXT = { gameId: '11111111-1111-4111-8111-111111111111', nonce: 1, roomCode: 'DEMO-0001',
  variant: 'long', label: 'roll', color: 'white', positionHash: 'ab'.repeat(32) };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'system-dice-program-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, data) => {
    const filename = path.join(directory, name);
    fs.writeFileSync(filename, JSON.stringify(data));
    return filename;
  };
  return { directory, write };
}
function execute(...args) { return spawnSync(process.execPath, [PROGRAM, ...args], { encoding: 'utf8', timeout: 10000 }); }
function succeeded(result) { assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); return JSON.parse(result.stdout); }

test('demo creates actual CSPRNG proof and labels local-only timing and evidence limits', () => {
  const report = demonstration(100);
  assert.equal(report.count, 100);
  assert.equal(report.mode, 'local-same-process-demonstration');
  assert.equal(report.frequencies.length, 36);
  assert.equal(report.frequencies.reduce((a, b) => a + b, 0), 100);
  assert.equal(report.example.verification.verified, true);
  assert.equal(report.example.verification.independentSourceVerified, false);
  assert.match(report.timing.includes, /excludes network, storage and animation/);
  assert.ok(report.timing.p95Ms >= 0);
  const { proof } = report.example;
  assert.equal(verifyProof(proof, { context: proof.context, commitment: proof.commitment, clientSeed: proof.clientSeed }).verified, true);
});

test('demo has bounded count and no mock fast-network claim', () => {
  for (const count of [0, -1, 0.5, 10001, Infinity, NaN, '1']) assert.throws(() => demonstration(count));
  assert.equal(succeeded(execute('demo', '3')).count, 3);
  assert.equal(execute('demo', '10001').status, 1);
});

test('CLI help identifies isolated protocol; bad commands sanitize errors', () => {
  const help = succeeded(execute('--help'));
  assert.equal(help.protocol, PROTOCOL);
  assert.equal(help.productionConnected, false);
  assert.match(help.usage, /prepare/);
  const invalid = execute('unknown', 'secret-that-must-not-be-echoed');
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'DICE_COMMAND_FAILED\n');
});

test('CLI prepare -> client-seed -> reveal -> verify and restart preserve one result', t => {
  const { directory, write } = fixture(t);
  const journal = path.join(directory, 'journal');
  succeeded(execute('init', journal));
  const context = write('context.json', CONTEXT);
  const receipt = succeeded(execute('prepare', journal, context));
  assert.deepEqual(Object.keys(receipt).sort(), ['commitment', 'context', 'protocol']);
  assert.deepEqual(succeeded(execute('prepare', journal, context)), receipt);
  const receiptFile = write('receipt.json', receipt);
  // A separate client call occurs only after receipt has been obtained.
  const challenge = succeeded(execute('client-seed'));
  assert.match(challenge.clientSeed, /^[0-9a-f]{64}$/);
  const challengeFile = write('challenge.json', challenge);
  const proof = succeeded(execute('reveal', journal, context, receiptFile, challengeFile));
  const proofFile = write('proof.json', proof);
  const expected = write('expected.json', { context: CONTEXT, commitment: receipt.commitment, clientSeed: challenge.clientSeed });
  const verification = succeeded(execute('verify', proofFile, expected));
  assert.equal(verification.verified, true);
  assert.equal(verification.independentSourceVerified, false);
  assert.deepEqual(succeeded(execute('reveal', journal, context, receiptFile, challengeFile)), proof);
  assert.deepEqual(succeeded(execute('prepare', journal, context)), receipt);
});

test('CLI rejects self-pinned evidence, tampered dice and challenge changes', t => {
  const { directory, write } = fixture(t);
  const journal = path.join(directory, 'journal');
  succeeded(execute('init', journal));
  const context = write('context.json', CONTEXT);
  const receipt = succeeded(execute('prepare', journal, context));
  const receiptFile = write('receipt.json', receipt);
  const challengeFile = write('challenge.json', { clientSeed: '01'.repeat(32) });
  const proof = succeeded(execute('reveal', journal, context, receiptFile, challengeFile));
  const proofFile = write('proof.json', proof);
  assert.equal(execute('verify', proofFile, write('no-expected.json', {})).status, 1);
  const expected = write('expected.json', { context: CONTEXT, commitment: receipt.commitment, clientSeed: proof.clientSeed });
  const tampered = { ...proof, dice: [proof.dice[0] % 6 + 1, proof.dice[1]] };
  assert.equal(execute('verify', write('tampered.json', tampered), expected).status, 1);
  const changed = execute('reveal', journal, context, receiptFile, write('changed.json', { clientSeed: '02'.repeat(32) }));
  assert.equal(changed.status, 1);
  assert.equal(changed.stderr, 'DICE_SEED_CONFLICT\n');
  assert.equal(changed.stdout, '');
});

test('CLI bounds input and does not reflect private JSON or failed file paths', t => {
  const { directory, write } = fixture(t);
  const journal = path.join(directory, 'journal');
  succeeded(execute('init', journal));
  const invalid = execute('prepare', journal, write('secret-invalid.json', { secret: 'unpublished-sensitive-seed' }));
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /unpublished|secret-invalid|system-dice-program-/);
  const enormous = execute('prepare', journal, write('huge.json', { context: 'x'.repeat(20000) }));
  assert.equal(enormous.status, 1);
  assert.equal(enormous.stdout, '');
  const symlink = path.join(directory, 'linked.json');
  fs.symlinkSync(write('valid.json', CONTEXT), symlink);
  assert.equal(execute('prepare', journal, symlink).status, 1);
});

test('experiment has no production imports or deployment build inclusion', () => {
  const root = path.resolve(__dirname, '..');
  for (const filename of ['rooms-client.js', 'game-controller.js', 'fair-dice.js', 'verify-game-ui.js', 'game-verifier.js', 'runtime-config.js', 'scripts/build-github-pages.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, filename), 'utf8'), /experiments\/(?:system-dice|random-org)/);
  }
});

test('SIGKILL after durable acceptance leaves a fail-closed lock; controlled recovery retains the same seed', t => {
  const { directory } = fixture(t);
  const journal = new DiceJournal(directory);
  const receipt = journal.prepare(CONTEXT);
  const journalPath = path.resolve(__dirname, '../experiments/system-dice/journal.js');
  const filename = path.join(directory, CONTEXT.gameId + '-1.json');
  const lock = path.join(directory, CONTEXT.gameId + '-1.lock');
  const clientSeed = '09'.repeat(32);
  // A controlled fixture hook kills the actual subprocess immediately after
  // fsync of the directory containing its accepted replacement, before reply.
  const childSource = `
    const fs = require('node:fs');
    const { DiceJournal } = require(process.argv[1]);
    const journal = new DiceJournal(process.argv[2]);
    const originalSync = fs.fsyncSync;
    fs.fsyncSync = function(fd) {
      originalSync(fd);
      if (fs.fstatSync(fd).isDirectory()) {
        const record = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
        if (record.state === 'accepted') process.kill(process.pid, 'SIGKILL');
      }
    };
    journal.accept(JSON.parse(process.argv[4]), process.argv[5], process.argv[6]);
  `;
  const killed = spawnSync(process.execPath, ['-e', childSource, journalPath, directory, filename,
    JSON.stringify(CONTEXT), receipt.commitment, clientSeed], { encoding: 'utf8', timeout: 10000 });
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(killed.stdout, '');
  assert.equal(killed.stderr, '');
  const before = fs.readFileSync(filename, 'utf8');
  const accepted = JSON.parse(before);
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.clientSeed, clientSeed);
  assert.ok(fs.existsSync(lock));
  assert.throws(() => new DiceJournal(directory).reveal(CONTEXT, receipt.commitment, clientSeed), { code: 'DICE_BUSY' });
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.ok(fs.existsSync(lock));
  // Only this exact fixture lock, after spawnSync confirmed its writer died.
  // The program itself must never clear a stale lock on a timer or reroll.
  fs.unlinkSync(lock);
  const proof = new DiceJournal(directory).reveal(CONTEXT, receipt.commitment, clientSeed);
  assert.equal(proof.serverSeed, accepted.privateSeed);
  assert.equal(proof.commitment, receipt.commitment);
  assert.equal(verifyProof(proof, { context: CONTEXT, commitment: receipt.commitment, clientSeed }).verified, true);
});
