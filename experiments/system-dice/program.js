#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const protocol = require('./protocol.js');
const { DiceJournal, initializeDirectory } = require('./journal.js');
const USAGE = 'init DIR | client-seed | prepare DIR CONTEXT.json | reveal DIR CONTEXT.json RECEIPT.json CHALLENGE.json | verify PROOF.json EXPECTED.json | demo [1..10000]';

function readJson(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('DICE_INPUT_INVALID');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error('DICE_INPUT_INVALID');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > 16384) throw new Error('DICE_INPUT_INVALID');
    return JSON.parse(bytes.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function demonstration(count = 1) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('DICE_COUNT_INVALID');
  const durations = [];
  const frequencies = Array(36).fill(0);
  const gameId = randomUUID();
  let example;
  for (let nonce = 1; nonce <= count; nonce += 1) {
    const context = { roomCode: 'DEMO-0001', gameId, nonce, label: 'roll', color: 'white', variant: 'long',
      positionHash: createHash('sha256').update('isolated demonstration ' + nonce).digest('hex') };
    const start = performance.now();
    const { privateSeed, commitment } = protocol.createCommitment(context);
    // This same-process demo exercises mechanics, NOT independent participants.
    // A real browser must receive/store commitment BEFORE generating its seed.
    const clientSeed = protocol.randomClientSeed();
    const proof = protocol.deriveProof({ context, privateSeed, clientSeed, commitment });
    const verification = protocol.verifyProof(proof, { context, commitment, clientSeed });
    durations.push(performance.now() - start);
    frequencies[(proof.dice[0] - 1) * 6 + proof.dice[1] - 1] += 1;
    example ||= { proof, verification };
  }
  durations.sort((a, b) => a - b);
  const percentile = value => durations[Math.min(durations.length - 1, Math.ceil(value * durations.length) - 1)];
  return { mode: 'local-same-process-demonstration', count, example,
    timing: { includes: 'CSPRNG, commitment, HMAC, proof verification; excludes network, storage and animation',
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: durations.at(-1) },
    frequencies, note: 'Distribution is a diagnostic, not proof of randomness. Production was not changed.' };
}

function main(args = process.argv.slice(2)) {
  const [command, ...values] = args;
  let result;
  if ((command === '--help' || command === 'help') && values.length === 0) result = { protocol: protocol.PROTOCOL, usage: USAGE, productionConnected: false };
  else if (command === 'init' && values.length === 1) result = { initialized: initializeDirectory(values[0]) };
  else if (command === 'client-seed' && values.length === 0) result = { clientSeed: protocol.randomClientSeed() };
  else if (command === 'prepare' && values.length === 2) result = new DiceJournal(values[0]).prepare(readJson(values[1]));
  else if (command === 'reveal' && values.length === 4) {
    const context = readJson(values[1]);
    const receipt = readJson(values[2]);
    const challenge = readJson(values[3]);
    if (receipt.protocol !== protocol.PROTOCOL || protocol.canonicalContext(receipt.context) !== protocol.canonicalContext(context)) throw new Error('DICE_INPUT_INVALID');
    result = new DiceJournal(values[0]).reveal(context, receipt.commitment, challenge.clientSeed);
  } else if (command === 'verify' && values.length === 2) result = protocol.verifyProof(readJson(values[0]), readJson(values[1]));
  else if (command === 'demo' && values.length <= 1) result = demonstration(values.length ? Number(values[0]) : 1);
  else throw new Error('DICE_USAGE');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    // Never reflect paths, journal contents or arbitrary upstream exception text.
    const code = typeof error.code === 'string' && /^(DICE|SYSTEM_DICE)_[A-Z_]+$/.test(error.code) ? error.code : 'DICE_COMMAND_FAILED';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  }
}

module.exports = { main, demonstration };
