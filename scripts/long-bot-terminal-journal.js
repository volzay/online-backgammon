'use strict';

// This primitive is an authenticated, server-owned OFFLINE progress store.
// It never evaluates a position, accepts a client label or emits learning
// evidence. It stores validated terminal endpoints plus one HMAC-authenticated
// in-game continuation checkpoint; neither partial form is learning evidence.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { types } = require('node:util');

const MANIFEST_SCHEMA = 'long-bot-terminal-cohort-manifest-v1';
const JOURNAL_SCHEMA = 'long-bot-terminal-journal-v1';
const SLOT_SCHEMA = 'long-bot-terminal-slot-v1';
const CHECKPOINT_SCHEMA = 'long-bot-terminal-rollout-checkpoint-v1';
const CHECKPOINT_ENVELOPE_SCHEMA = 'long-bot-terminal-checkpoint-envelope-v1';
const KEY_NAME = 'terminal-journal.key';
const LOCK_NAME = 'writer.lock';
const MANIFEST_NAME = 'manifest.json';
const MAX_MANIFEST_BYTES = 8388608;
const MAX_SLOT_BYTES = 16384;
const MAX_CHECKPOINT_BYTES = 131072;
const HASH = /^[0-9a-f]{64}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const error = reason => { throw new Error(`terminal-journal-${reason}`); };

function nativeJson(value, seen = new Set(), budget = { nodes: 500000 }, depth = 0) {
  if (--budget.nodes < 0 || depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype
    : prototype !== Object.prototype && prototype !== null) return false;
  if ('toJSON' in value) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value) && (Object.keys(value).length !== value.length
    || !Object.keys(value).every((key, index) => key === String(index)))) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return false;
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || !nativeJson(descriptor.value, seen, budget, depth + 1)) return false;
  }
  seen.delete(value);
  return true;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(Object.getOwnPropertyDescriptor(value, key).value)}`).join(',')}}`;
  return JSON.stringify(value);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}

function validSeeds(seeds) {
  return exactKeys(seeds, ['white', 'dark']) && ['white', 'dark'].every(color => (
    Number.isSafeInteger(seeds[color]) && seeds[color] > 0 && seeds[color] <= 0xffffffff
  ));
}

function canonicalManifest(manifest) {
  if (!nativeJson(manifest) || !exactKeys(manifest,
    ['schema', 'sampleCount', 'candidateIds', 'seedsBySample', 'botColor', 'maxPlies', 'bindings'])
    || manifest.schema !== MANIFEST_SCHEMA
    || !Number.isSafeInteger(manifest.sampleCount) || manifest.sampleCount < 32 || manifest.sampleCount > 128
    || !Number.isSafeInteger(manifest.maxPlies) || manifest.maxPlies < 1 || manifest.maxPlies > 600
    || !['white', 'dark'].includes(manifest.botColor)
    || !Array.isArray(manifest.candidateIds) || !manifest.candidateIds.length || manifest.candidateIds.length > 256
    || !manifest.candidateIds.every(id => typeof id === 'string' && HASH.test(id))
    || new Set(manifest.candidateIds).size !== manifest.candidateIds.length
    || !Array.isArray(manifest.seedsBySample) || manifest.seedsBySample.length !== manifest.sampleCount
    || !manifest.seedsBySample.every(validSeeds)
    || !manifest.bindings || typeof manifest.bindings !== 'object' || Array.isArray(manifest.bindings)
    || !Object.keys(manifest.bindings).length) error('manifest-invalid');
  const seeds = manifest.seedsBySample.flatMap(seed => [seed.white, seed.dark]);
  if (new Set(seeds).size !== seeds.length) error('manifest-seed-collision');
  const preimage = canonical(manifest);
  if (Buffer.byteLength(preimage) > MAX_MANIFEST_BYTES) error('manifest-too-large');
  return preimage;
}

function createTerminalJournal({ directory, manifest, _testHooks } = {}) {
  const preimage = canonicalManifest(manifest);
  const immutable = JSON.parse(preimage);
  const manifestId = sha256(preimage);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
    || path.resolve(directory) !== directory || typeof process.getuid !== 'function') error('directory-invalid');
  const ownerUid = process.getuid();
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!noFollow) error('no-follow-unavailable');
  const candidateIds = new Set(immutable.candidateIds);
  const cohortDirectory = path.join(directory, manifestId);
  const keyPath = path.join(directory, KEY_NAME);
  const lockPath = path.join(cohortDirectory, LOCK_NAME);
  const manifestPath = path.join(cohortDirectory, MANIFEST_NAME);
  let rootIdentity, cohortIdentity, keyIdentity, lockIdentity, key, lockBytes;
  let closed = false, faulted = false, ignoredTemporaryFiles = 0;
  const records = new Map();
  const checkpoints = new Map();
  const identity = stat => `${stat.dev}:${stat.ino}`;

  function noSymlinkComponents(target) {
    let current = path.parse(target).root;
    for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) error('directory-symlink-or-nondirectory');
      // A non-sticky group/world-writable ancestor could exchange a path
      // component between fences. Root-owned sticky /tmp is acceptable; a
      // different user's directory or an unprotected writable parent is not.
      if (![0, ownerUid].includes(stat.uid)
        || (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) error('directory-ancestor-untrusted');
    }
    if (fs.realpathSync(target) !== target) error('directory-realpath-mismatch');
  }

  function privateDirectory(target, expected) {
    noSymlinkComponents(target);
    const stat = fs.lstatSync(target);
    if (stat.uid !== ownerUid || (stat.mode & 0o7777) !== 0o700
      || expected && identity(stat) !== expected) error('directory-owner-mode-or-identity');
    return identity(stat);
  }

  function createPrivateDirectory(target) {
    noSymlinkComponents(path.dirname(target));
    let created = false;
    try { fs.mkdirSync(target, { mode: 0o700 }); created = true; }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const result = privateDirectory(target);
    if (created) {
      syncDirectory(path.dirname(target));
      checkpoint('after-parent-directory-fsync');
    }
    return result;
  }

  function syncDirectory(target) {
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }

  function readRegular(target, mode, maximum, expected) {
    const before = fs.lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== ownerUid
      || (before.mode & 0o7777) !== mode || before.nlink !== 1
      || before.size > maximum || expected && identity(before) !== expected) error('file-owner-mode-type-or-identity');
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    try {
      const stat = fs.fstatSync(descriptor);
      if (identity(stat) !== identity(before) || !stat.isFile() || stat.uid !== ownerUid
        || (stat.mode & 0o7777) !== mode || stat.nlink !== 1 || stat.size > maximum) error('file-open-race');
      const bytes = fs.readFileSync(descriptor);
      if (bytes.length !== stat.size || identity(fs.lstatSync(target)) !== identity(stat)) error('file-read-race');
      return { bytes, identity: identity(stat) };
    } finally { fs.closeSync(descriptor); }
  }

  function createExclusive(target, bytes, mode) {
    const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, mode);
    try { fs.writeFileSync(descriptor, bytes); fs.fchmodSync(descriptor, mode); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  }

  function checkpoint(stage) { _testHooks?.crash?.(stage); }

  function atomicCommit(name, bytes, mode) {
    const temporary = path.join(cohortDirectory, `.tmp-${name === MANIFEST_NAME ? 'manifest' : 'slot'}-${crypto.randomBytes(16).toString('hex')}`);
    createExclusive(temporary, bytes, mode);
    checkpoint('after-temp-fsync');
    if (!readRegular(temporary, mode, Math.max(MAX_SLOT_BYTES, bytes.length)).bytes.equals(bytes)) error('temporary-preimage-mismatch');
    // link() is atomic and refuses to replace an existing final pathname.
    fs.linkSync(temporary, path.join(cohortDirectory, name));
    checkpoint('after-link-before-temp-unlink');
    fs.unlinkSync(temporary);
    syncDirectory(cohortDirectory);
    if (!readRegular(path.join(cohortDirectory, name), mode, Math.max(MAX_SLOT_BYTES, bytes.length)).bytes.equals(bytes)) error('committed-preimage-mismatch');
    checkpoint('after-directory-fsync');
  }

  function atomicReplace(name, bytes, mode) {
    const target = path.join(cohortDirectory, name);
    const temporary = path.join(cohortDirectory, `.tmp-checkpoint-${crypto.randomBytes(16).toString('hex')}`);
    createExclusive(temporary, bytes, mode);
    checkpoint('after-checkpoint-temp-fsync');
    if (!readRegular(temporary, mode, bytes.length).bytes.equals(bytes)) error('temporary-preimage-mismatch');
    fs.renameSync(temporary, target);
    checkpoint('after-checkpoint-rename-before-directory-fsync');
    syncDirectory(cohortDirectory);
    if (!readRegular(target, mode, bytes.length).bytes.equals(bytes)) error('committed-preimage-mismatch');
    checkpoint('after-checkpoint-directory-fsync');
  }

  function slotName(sampleIndex, candidateId) {
    return `slot-s${String(sampleIndex).padStart(3, '0')}-c${candidateId}.json`;
  }

  function checkpointName(sampleIndex, candidateId) {
    return `checkpoint-s${String(sampleIndex).padStart(3, '0')}-c${candidateId}.json`;
  }

  function validateSlot(slot, sampleIndex, candidateId, seeds) {
    if (!nativeJson(slot) || !exactKeys(slot,
      ['sampleIndex', 'candidateId', 'seeds', 'winner', 'plies', 'complete', 'manifestId'])
      || slot.complete !== true || slot.manifestId !== manifestId
      || !Number.isSafeInteger(slot.sampleIndex) || slot.sampleIndex < 0 || slot.sampleIndex >= immutable.sampleCount
      || typeof slot.candidateId !== 'string' || !candidateIds.has(slot.candidateId)
      || !validSeeds(slot.seeds) || canonical(slot.seeds) !== canonical(immutable.seedsBySample[slot.sampleIndex])
      || !['white', 'dark'].includes(slot.winner)
      || !Number.isSafeInteger(slot.plies) || slot.plies < 0 || slot.plies > immutable.maxPlies
      || sampleIndex !== undefined && slot.sampleIndex !== sampleIndex
      || candidateId !== undefined && slot.candidateId !== candidateId
      || seeds !== undefined && canonical(slot.seeds) !== canonical(seeds)) error('slot-invalid');
  }

  function mac(payload, payloadHash) {
    return crypto.createHmac('sha256', key).update(`${JOURNAL_SCHEMA}\0${payloadHash}\0${payload}`).digest('hex');
  }

  function readSlot(name) {
    const { bytes } = readRegular(path.join(cohortDirectory, name), 0o600, MAX_SLOT_BYTES);
    let envelope;
    try { envelope = JSON.parse(bytes); } catch { error('slot-json-invalid'); }
    if (!nativeJson(envelope) || !exactKeys(envelope, ['schema', 'payload', 'payloadHash', 'mac'])
      || envelope.schema !== SLOT_SCHEMA || typeof envelope.payloadHash !== 'string' || !HASH.test(envelope.payloadHash)
      || typeof envelope.mac !== 'string' || !HASH.test(envelope.mac)) error('slot-envelope-invalid');
    const payload = canonical(envelope.payload), payloadHash = sha256(payload);
    if (payloadHash !== envelope.payloadHash
      || !crypto.timingSafeEqual(Buffer.from(envelope.mac, 'hex'), Buffer.from(mac(payload, payloadHash), 'hex'))) error('slot-authentication-failed');
    validateSlot(envelope.payload);
    if (slotName(envelope.payload.sampleIndex, envelope.payload.candidateId) !== name
      || canonical(envelope) !== bytes.toString('utf8')) error('slot-preimage-or-filename-mismatch');
    return envelope.payload;
  }

  function validateCheckpoint(value, sampleIndex, candidateId, seeds) {
    if (!nativeJson(value) || !exactKeys(value,
      ['schema', 'sampleIndex', 'candidateId', 'seeds', 'plies', 'rolls', 'state', 'stateHash', 'manifestId'])
      || value.schema !== CHECKPOINT_SCHEMA || value.manifestId !== manifestId
      || !Number.isSafeInteger(value.sampleIndex) || value.sampleIndex < 0 || value.sampleIndex >= immutable.sampleCount
      || typeof value.candidateId !== 'string' || !candidateIds.has(value.candidateId)
      || !validSeeds(value.seeds) || canonical(value.seeds) !== canonical(immutable.seedsBySample[value.sampleIndex])
      || !Number.isSafeInteger(value.plies) || value.plies < 1 || value.plies >= immutable.maxPlies
      || !exactKeys(value.rolls, ['white', 'dark'])
      || !['white', 'dark'].every(color => Number.isSafeInteger(value.rolls[color])
        && value.rolls[color] >= 0 && value.rolls[color] <= immutable.maxPlies)
      || value.rolls.white + value.rolls.dark !== value.plies
      || !nativeJson(value.state) || !value.state || Array.isArray(value.state)
      || typeof value.stateHash !== 'string' || !HASH.test(value.stateHash)
      || value.stateHash !== sha256(canonical(value.state))
      || sampleIndex !== undefined && value.sampleIndex !== sampleIndex
      || candidateId !== undefined && value.candidateId !== candidateId
      || seeds !== undefined && canonical(value.seeds) !== canonical(seeds)) error('checkpoint-invalid');
  }

  function readCheckpoint(name) {
    const { bytes } = readRegular(path.join(cohortDirectory, name), 0o600, MAX_CHECKPOINT_BYTES);
    let envelope;
    try { envelope = JSON.parse(bytes); } catch { error('checkpoint-json-invalid'); }
    if (!nativeJson(envelope) || !exactKeys(envelope, ['schema', 'payload', 'payloadHash', 'mac'])
      || envelope.schema !== CHECKPOINT_ENVELOPE_SCHEMA
      || typeof envelope.payloadHash !== 'string' || !HASH.test(envelope.payloadHash)
      || typeof envelope.mac !== 'string' || !HASH.test(envelope.mac)) error('checkpoint-envelope-invalid');
    const payload = canonical(envelope.payload), payloadHash = sha256(payload);
    if (payloadHash !== envelope.payloadHash
      || !crypto.timingSafeEqual(Buffer.from(envelope.mac, 'hex'), Buffer.from(mac(payload, payloadHash), 'hex'))) {
      error('checkpoint-authentication-failed');
    }
    validateCheckpoint(envelope.payload);
    if (checkpointName(envelope.payload.sampleIndex, envelope.payload.candidateId) !== name
      || canonical(envelope) !== bytes.toString('utf8')) error('checkpoint-preimage-or-filename-mismatch');
    return { payload: envelope.payload, checkpointHash: payloadHash };
  }

  function validateRequest(sampleIndex, candidateId, seeds) {
    if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= immutable.sampleCount
      || typeof candidateId !== 'string' || !candidateIds.has(candidateId)
      || !nativeJson(seeds) || !validSeeds(seeds)
      || canonical(seeds) !== canonical(immutable.seedsBySample[sampleIndex])) error('lookup-invalid');
  }

  function fence() {
    privateDirectory(directory, rootIdentity);
    privateDirectory(cohortDirectory, cohortIdentity);
    const currentKey = readRegular(keyPath, 0o600, 32, keyIdentity).bytes;
    if (currentKey.length !== 32 || !crypto.timingSafeEqual(currentKey, key)) error('key-drift');
    if (!readRegular(lockPath, 0o600, 4096, lockIdentity).bytes.equals(lockBytes)) error('lock-fence-lost');
  }

  function guard() {
    if (closed) error('closed');
    if (faulted) error('faulted');
    fence();
    if (readRegular(manifestPath, 0o444, MAX_MANIFEST_BYTES).bytes.toString('utf8') !== preimage) error('manifest-preimage-mismatch');
  }

  function releaseOwnedLock() {
    if (!lockIdentity) return;
    privateDirectory(directory, rootIdentity);
    privateDirectory(cohortDirectory, cohortIdentity);
    const current = readRegular(lockPath, 0o600, 4096, lockIdentity).bytes;
    if (!current.equals(lockBytes)) error('lock-fence-lost');
    fs.unlinkSync(lockPath);
    syncDirectory(cohortDirectory);
    lockIdentity = null;
  }

  try {
    rootIdentity = createPrivateDirectory(directory);
    try { createExclusive(keyPath, crypto.randomBytes(32), 0o600); syncDirectory(directory); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const keyRecord = readRegular(keyPath, 0o600, 32);
    if (keyRecord.bytes.length !== 32) error('key-invalid');
    key = keyRecord.bytes; keyIdentity = keyRecord.identity;
    cohortIdentity = createPrivateDirectory(cohortDirectory);
    syncDirectory(directory);
    lockBytes = Buffer.from(canonical({ schema: JOURNAL_SCHEMA, uid: ownerUid, pid: process.pid,
      manifestId, token: crypto.randomBytes(32).toString('hex') }));
    try { createExclusive(lockPath, lockBytes, 0o600); syncDirectory(cohortDirectory); }
    catch (cause) { if (cause.code === 'EEXIST') error('writer-locked'); throw cause; }
    lockIdentity = readRegular(lockPath, 0o600, 4096).identity;
    // No stale-lock takeover: unexpected process death requires a separate
    // explicitly authorized, fenced operator recovery. Never trust a PID alone.
    // Clean only reserved staging names under the acquired private cohort lock.
    const names = fs.readdirSync(cohortDirectory);
    if (names.length > 40000) error('directory-entry-limit');
    for (const name of names) {
      if (!/^\.tmp-(?:manifest|slot|checkpoint)-[0-9a-f]{32}$/.test(name)) continue;
      const temporary = path.join(cohortDirectory, name), stat = fs.lstatSync(temporary);
      const expectedMode = name.startsWith('.tmp-manifest-') ? 0o444 : 0o600;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== ownerUid
        || (stat.mode & 0o7777) !== expectedMode || stat.nlink < 1 || stat.nlink > 2) error('temporary-file-unsafe');
      fs.unlinkSync(temporary); ignoredTemporaryFiles += 1;
    }
    if (ignoredTemporaryFiles) syncDirectory(cohortDirectory);
    if (!fs.existsSync(manifestPath)) atomicCommit(MANIFEST_NAME, Buffer.from(preimage), 0o444);
    if (readRegular(manifestPath, 0o444, MAX_MANIFEST_BYTES).bytes.toString('utf8') !== preimage) error('manifest-preimage-mismatch');
    for (const name of fs.readdirSync(cohortDirectory)) {
      if (name === MANIFEST_NAME || name === LOCK_NAME) continue;
      if (/^slot-s\d{3}-c[0-9a-f]{64}\.json$/.test(name)) {
        const slot = readSlot(name), id = `${slot.sampleIndex}:${slot.candidateId}`;
        if (records.has(id)) error('duplicate-slot');
        records.set(id, slot);
      } else if (/^checkpoint-s\d{3}-c[0-9a-f]{64}\.json$/.test(name)) {
        const current = readCheckpoint(name), id = `${current.payload.sampleIndex}:${current.payload.candidateId}`;
        if (checkpoints.has(id) || checkpoints.size > 0) error('duplicate-checkpoint');
        checkpoints.set(id, current);
      } else error('unexpected-file');
    }
    for (const [id, current] of checkpoints) {
      if (!records.has(id)) continue;
      fs.unlinkSync(path.join(cohortDirectory,
        checkpointName(current.payload.sampleIndex, current.payload.candidateId)));
      checkpoints.delete(id);
      syncDirectory(cohortDirectory);
    }
    guard();
  } catch (cause) {
    try { releaseOwnedLock(); } catch { /* Never unlink a lock we no longer own. */ }
    throw cause;
  }

  function lookup(sampleIndex, candidateId, seeds) {
    guard(); validateRequest(sampleIndex, candidateId, seeds);
    const id = `${sampleIndex}:${candidateId}`, name = slotName(sampleIndex, candidateId);
    if (!fs.existsSync(path.join(cohortDirectory, name))) {
      if (records.has(id)) error('slot-disappeared');
      return null;
    }
    const slot = readSlot(name);
    validateSlot(slot, sampleIndex, candidateId, seeds);
    records.set(id, slot);
    return clone(slot);
  }

  function lookupCheckpoint(sampleIndex, candidateId, seeds) {
    guard(); validateRequest(sampleIndex, candidateId, seeds);
    const id = `${sampleIndex}:${candidateId}`, name = checkpointName(sampleIndex, candidateId);
    if (!fs.existsSync(path.join(cohortDirectory, name))) {
      if (checkpoints.has(id)) error('checkpoint-disappeared');
      return null;
    }
    const current = readCheckpoint(name);
    validateCheckpoint(current.payload, sampleIndex, candidateId, seeds);
    checkpoints.set(id, current);
    return { ...clone(current.payload), checkpointHash: current.checkpointHash };
  }

  function clearCheckpoint(sampleIndex, candidateId, seeds, expectedHash) {
    guard(); validateRequest(sampleIndex, candidateId, seeds);
    const id = `${sampleIndex}:${candidateId}`, name = checkpointName(sampleIndex, candidateId);
    const target = path.join(cohortDirectory, name);
    if (!fs.existsSync(target)) {
      if (checkpoints.has(id)) error('checkpoint-disappeared');
      return false;
    }
    const current = readCheckpoint(name);
    validateCheckpoint(current.payload, sampleIndex, candidateId, seeds);
    if (expectedHash !== undefined && current.checkpointHash !== expectedHash) error('checkpoint-hash-mismatch');
    fs.unlinkSync(target);
    syncDirectory(cohortDirectory);
    checkpoints.delete(id);
    return true;
  }

  return Object.freeze({
    manifestId,
    lookup,
    lookupCheckpoint,
    saveCheckpoint(value) {
      guard();
      if (!nativeJson(value) || !exactKeys(value,
        ['sampleIndex', 'candidateId', 'seeds', 'plies', 'rolls', 'state'])) error('checkpoint-invalid');
      validateRequest(value.sampleIndex, value.candidateId, value.seeds);
      const payload = { schema: CHECKPOINT_SCHEMA, sampleIndex: value.sampleIndex,
        candidateId: value.candidateId, seeds: clone(value.seeds), plies: value.plies,
        rolls: clone(value.rolls), state: clone(value.state), stateHash: sha256(canonical(value.state)), manifestId };
      validateCheckpoint(payload);
      const id = `${payload.sampleIndex}:${payload.candidateId}`;
      if (checkpoints.size > 0 && !checkpoints.has(id)) error('checkpoint-slot-conflict');
      const existing = lookupCheckpoint(payload.sampleIndex, payload.candidateId, payload.seeds);
      if (existing) {
        const current = checkpoints.get(id);
        if (payload.plies < existing.plies) error('checkpoint-regression');
        if (payload.plies === existing.plies) {
          if (canonical(current.payload) !== canonical(payload)) error('checkpoint-conflict');
          return { committed: false, duplicate: true, checkpoint: clone(existing) };
        }
      }
      const payloadText = canonical(payload), payloadHash = sha256(payloadText);
      const bytes = Buffer.from(canonical({ schema: CHECKPOINT_ENVELOPE_SCHEMA, payload,
        payloadHash, mac: mac(payloadText, payloadHash) }));
      if (bytes.length > MAX_CHECKPOINT_BYTES) error('checkpoint-too-large');
      try {
        atomicReplace(checkpointName(payload.sampleIndex, payload.candidateId), bytes, 0o600);
        guard();
        checkpoints.set(id, { payload, checkpointHash: payloadHash });
      } catch (cause) { faulted = true; throw cause; }
      return { committed: true, duplicate: false,
        checkpoint: { ...clone(payload), checkpointHash: payloadHash } };
    },
    clearCheckpoint,
    commit(outcome) {
      guard();
      if (!nativeJson(outcome) || !exactKeys(outcome, Object.prototype.hasOwnProperty.call(outcome || {}, 'manifestId')
        ? ['sampleIndex', 'candidateId', 'seeds', 'winner', 'plies', 'complete', 'manifestId']
        : ['sampleIndex', 'candidateId', 'seeds', 'winner', 'plies', 'complete'])) error('slot-invalid');
      const slot = clone(outcome);
      if (!Object.prototype.hasOwnProperty.call(slot, 'manifestId')) slot.manifestId = manifestId;
      validateSlot(slot);
      const existing = lookup(slot.sampleIndex, slot.candidateId, slot.seeds);
      if (existing) {
        if (canonical(existing) !== canonical(slot)) error('slot-conflict');
        clearCheckpoint(slot.sampleIndex, slot.candidateId, slot.seeds);
        return { committed: false, duplicate: true, slot: clone(existing) };
      }
      const payload = canonical(slot), payloadHash = sha256(payload);
      const bytes = Buffer.from(canonical({ schema: SLOT_SCHEMA, payload: slot,
        payloadHash, mac: mac(payload, payloadHash) }));
      try {
        atomicCommit(slotName(slot.sampleIndex, slot.candidateId), bytes, 0o600);
        guard();
        records.set(`${slot.sampleIndex}:${slot.candidateId}`, slot);
        clearCheckpoint(slot.sampleIndex, slot.candidateId, slot.seeds);
      } catch (cause) { faulted = true; throw cause; }
      return { committed: true, duplicate: false, slot: clone(slot) };
    },
    observation() {
      guard();
      for (const slot of records.values()) {
        const current = readSlot(slotName(slot.sampleIndex, slot.candidateId));
        if (canonical(current) !== canonical(slot)) error('slot-drift');
      }
      for (const current of checkpoints.values()) {
        const reread = readCheckpoint(checkpointName(current.payload.sampleIndex, current.payload.candidateId));
        if (canonical(reread) !== canonical(current)) error('checkpoint-drift');
      }
      const active = checkpoints.size === 1 ? [...checkpoints.values()][0] : null;
      return { schema: JOURNAL_SCHEMA, manifestId, completedTerminalOutcomes: records.size,
        requiredTerminalOutcomes: immutable.sampleCount * immutable.candidateIds.length,
        sampleCount: immutable.sampleCount, candidateCount: immutable.candidateIds.length,
        complete: records.size === immutable.sampleCount * immutable.candidateIds.length,
        activeCheckpoint: active ? { manifestId, sampleIndex: active.payload.sampleIndex,
          candidateIndex: immutable.candidateIds.indexOf(active.payload.candidateId),
          candidateId: active.payload.candidateId, plies: active.payload.plies,
          checkpointHash: active.checkpointHash, stateHash: active.payload.stateHash } : null,
        ignoredTemporaryFiles, learningEvidence: false };
    },
    close() {
      if (closed) return;
      try { releaseOwnedLock(); } finally { closed = true; }
    },
  });
}

module.exports = { MANIFEST_SCHEMA, JOURNAL_SCHEMA, SLOT_SCHEMA, CHECKPOINT_SCHEMA,
  CHECKPOINT_ENVELOPE_SCHEMA, canonicalManifest, createTerminalJournal };
