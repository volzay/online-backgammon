'use strict';

// A private, local single-host journal for the standalone program. This is NOT
// the production room-authority/SQL ledger and provides no account authorization.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const protocol = require('./protocol.js');
const MAX_RECORD_BYTES = 16384;

class DiceJournalError extends Error {
  constructor(code) { super(code); this.name = 'DiceJournalError'; this.code = code; }
}
const fail = code => { throw new DiceJournalError(code); };
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function privateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) fail('DICE_DIRECTORY_INVALID');
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
      (metadata.mode & 0o777) !== 0o700 || metadata.uid !== process.getuid()) fail('DICE_DIRECTORY_INVALID');
  return directory;
}

function initializeDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) fail('DICE_DIRECTORY_INVALID');
  // Never chmod or take over an existing directory. Parent must already exist.
  fs.mkdirSync(directory, { mode: 0o700 });
  return privateDirectory(directory);
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readPrivateRecord(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid() ||
        (metadata.mode & 0o777) !== 0o600 || metadata.size > MAX_RECORD_BYTES) fail('DICE_RECORD_INVALID');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX_RECORD_BYTES) fail('DICE_RECORD_INVALID');
    return JSON.parse(bytes.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function recordBytes(record) {
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > MAX_RECORD_BYTES) fail('DICE_RECORD_INVALID');
  return bytes;
}

function writeNew(filename, record, directory) {
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, recordBytes(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(directory);
}

function writeReplacement(filename, record, directory) {
  const temporary = path.join(directory, '.write-' + randomUUID());
  let renamed = false;
  try {
    writeNew(temporary, record, directory);
    fs.renameSync(temporary, filename);
    renamed = true;
    syncDirectory(directory);
  } finally {
    // Only this call's exclusive temporary file, never any journal reservation.
    if (!renamed && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function keyFor(context) {
  protocol.canonicalContext(context);
  return context.gameId + '-' + context.nonce;
}

function validateRecord(record, context) {
  const fields = ['version', 'context', 'privateSeed', 'commitment', 'clientSeed', 'state', 'proof'];
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key)) ||
      record.version !== 1 || !hex(record.privateSeed) || !hex(record.commitment)) fail('DICE_RECORD_INVALID');
  if (protocol.canonicalContext(record.context) !== protocol.canonicalContext(context)) fail('DICE_CONTEXT_CONFLICT');
  if (protocol.commitmentFor(context, record.privateSeed) !== record.commitment) fail('DICE_RECORD_INVALID');
  if (record.state === 'prepared') {
    if (record.clientSeed !== null || record.proof !== null) fail('DICE_RECORD_INVALID');
  } else if (record.state === 'accepted') {
    if (!hex(record.clientSeed) || record.proof !== null) fail('DICE_RECORD_INVALID');
  } else if (record.state === 'complete') {
    if (!hex(record.clientSeed) || !record.proof) fail('DICE_RECORD_INVALID');
    protocol.verifyProof(record.proof, { context, commitment: record.commitment, clientSeed: record.clientSeed });
  } else fail('DICE_RECORD_INVALID');
  return record;
}

class DiceJournal {
  constructor(directory) { this.directory = privateDirectory(directory); }

  _locked(context, action) {
    privateDirectory(this.directory);
    const key = keyFor(context);
    const lock = path.join(this.directory, key + '.lock');
    let fd;
    try { fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('DICE_BUSY'); fail('DICE_STORAGE_ERROR'); }
    try {
      fs.writeFileSync(fd, String(process.pid));
      fs.fsyncSync(fd);
      const filename = path.join(this.directory, key + '.json');
      let record = null;
      try { record = validateRecord(readPrivateRecord(filename), context); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return action(record, filename);
    } catch (error) {
      if (error instanceof DiceJournalError || /^SYSTEM_DICE_/.test(error.code || '')) throw error;
      fail('DICE_STORAGE_ERROR');
    } finally {
      fs.closeSync(fd);
      // A crash deliberately leaves a lock. No TTL-based deletion or new seed.
      fs.unlinkSync(lock);
      syncDirectory(this.directory);
    }
  }

  prepare(context) {
    return this._locked(context, (record, filename) => {
      if (!record) {
        const generated = protocol.createCommitment(context);
        record = { version: 1, context: JSON.parse(JSON.stringify(context)), ...generated,
          clientSeed: null, state: 'prepared', proof: null };
        writeNew(filename, record, this.directory);
      }
      // In particular, never return privateSeed or other unpublished records.
      return { protocol: protocol.PROTOCOL, context: record.context, commitment: record.commitment };
    });
  }

  accept(context, expectedCommitment, clientSeed) {
    if (!hex(expectedCommitment)) fail('DICE_COMMITMENT_INVALID');
    protocol.validateClientSeed(clientSeed);
    return this._locked(context, (record, filename) => {
      if (!record) fail('DICE_NOT_PREPARED');
      if (record.commitment !== expectedCommitment) fail('DICE_COMMITMENT_CONFLICT');
      if (record.clientSeed !== null && record.clientSeed !== clientSeed) fail('DICE_SEED_CONFLICT');
      if (record.state === 'prepared') {
        record.clientSeed = clientSeed;
        record.state = 'accepted';
        // First challenge is durable BEFORE the server seed can be revealed.
        writeReplacement(filename, record, this.directory);
      }
      return { accepted: true, commitment: record.commitment };
    });
  }

  reveal(context, expectedCommitment, clientSeed) {
    this.accept(context, expectedCommitment, clientSeed);
    return this._locked(context, (record, filename) => {
      if (!record || record.clientSeed !== clientSeed || record.commitment !== expectedCommitment) fail('DICE_RECORD_INVALID');
      if (record.state === 'accepted') {
        record.proof = protocol.deriveProof({ context: record.context, privateSeed: record.privateSeed,
          clientSeed: record.clientSeed, commitment: record.commitment });
        record.state = 'complete';
        writeReplacement(filename, record, this.directory);
      }
      if (record.state !== 'complete') fail('DICE_RECORD_INVALID');
      return record.proof;
    });
  }
}

module.exports = { DiceJournal, DiceJournalError, initializeDirectory, MAX_RECORD_BYTES };
