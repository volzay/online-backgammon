'use strict';

// Production recovery authority is a currently held KERNEL FLOCK, never a
// stored PID, environment flag, injected proc adapter or client provenance.
// This module does not validate outcomes: the unchanged terminal journal
// authenticates every endpoint after a recovered cohort is reopened.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { types } = require('node:util');
const { canonicalManifest, JOURNAL_SCHEMA } = require('./long-bot-terminal-journal');

const FENCE_SCHEMA = 'long-bot-linux-production-fence-v1';
const MAX_COHORTS = 4096;
const HASH = /^[0-9a-f]{64}$/;
const fail = reason => { throw new Error(`production-fence-${reason}`); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = stat => `${stat.dev}:${stat.ino}`;

// Linux/glibc's 64-bit dev_t encoding, without Number/32-bit bitwise truncation.
function linuxDeviceParts(device) {
  if (typeof device !== 'bigint' || device < 0n || device > 0xffffffffffffffffn) fail('device-invalid');
  return { major: ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n),
    minor: (device & 0xffn) | ((device >> 12n) & 0xffffff00n) };
}

function parseProcLock(line) {
  if (typeof line !== 'string') return null;
  const match = /^\s*\d+:\s+(FLOCK|POSIX|OFDLCK)\s+(ADVISORY|MANDATORY)\s+(READ|WRITE)\s+(-?\d+)\s+([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)\s+(\d+)\s+(EOF|\d+)\s*$/.exec(line);
  if (!match) return null; // In particular, never accept blocked "->" rows.
  return { type: match[1], advisory: match[2], access: match[3], pid: BigInt(match[4]),
    major: BigInt(`0x${match[5]}`), minor: BigInt(`0x${match[6]}`), inode: BigInt(match[7]),
    start: BigInt(match[8]), end: match[9] === 'EOF' ? 'EOF' : BigInt(match[9]) };
}

function matchesOwnExclusiveLock(lock, pid, stat) {
  const device = linuxDeviceParts(stat.dev);
  return Boolean(lock) && lock.type === 'FLOCK' && lock.advisory === 'ADVISORY'
    && lock.access === 'WRITE' && lock.pid === BigInt(pid)
    && lock.major === device.major && lock.minor === device.minor && lock.inode === stat.ino
    && lock.start === 0n && lock.end === 'EOF';
}

function assertProductionFence(options = {}) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function'
    || typeof process.geteuid !== 'function' || process.getuid() !== process.geteuid()) fail('linux-real-uid-required');
  if (!options || types.isProxy(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) fail('options-invalid');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
    || !['journalDirectory', 'applicationDirectory'].includes(key)
    || !Object.prototype.hasOwnProperty.call(descriptors[key], 'value'))) fail('options-invalid');
  const journalDirectory = descriptors.journalDirectory?.value;
  const applicationDirectory = descriptors.applicationDirectory?.value;
  for (const target of [journalDirectory, ...(applicationDirectory === undefined ? [] : [applicationDirectory])]) {
    if (typeof target !== 'string' || target.length > 4096 || !path.isAbsolute(target)
      || path.resolve(target) !== target) fail('path-invalid');
  }
  const uid = BigInt(process.getuid()), pid = process.pid;
  const stateDirectory = path.dirname(journalDirectory), flockPath = path.join(stateDirectory, 'worker.flock');
  let stateIdentity, journalIdentity, flockIdentity, heldDescriptor;
  const jobDirectories = new Map();
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!noFollow || fs.statfsSync('/proc', { bigint: true }).type !== 0x9fa0n) fail('real-procfs-required');

  function components(target, immutableRootOwned = false) {
    let current = path.parse(target).root;
    const targets = [current];
    for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component); targets.push(current);
    }
    for (const component of targets) {
      const stat = fs.lstatSync(component, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('directory-symlink-or-type');
      if (immutableRootOwned ? stat.uid !== 0n || (stat.mode & 0o022n) !== 0n
        : ![0n, uid].includes(stat.uid) || (stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n) {
        fail('directory-ancestor-untrusted');
      }
    }
    if (fs.realpathSync(target) !== target) fail('directory-realpath-mismatch');
  }

  function privateDirectory(target, expected) {
    components(target);
    const stat = fs.lstatSync(target, { bigint: true });
    if (stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n
      || expected !== undefined && identity(stat) !== expected) fail('private-directory-drift');
    return identity(stat);
  }

  function syncDirectory(target) {
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }

  function regular(target, mode, maxBytes, expected) {
    const before = fs.lstatSync(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid
      || (before.mode & 0o7777n) !== BigInt(mode) || before.nlink !== 1n
      || before.size > BigInt(maxBytes) || expected !== undefined && identity(before) !== expected) fail('regular-file-drift');
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    try {
      const stat = fs.fstatSync(descriptor, { bigint: true });
      if (identity(stat) !== identity(before) || stat.nlink !== 1n || stat.uid !== uid
        || (stat.mode & 0o7777n) !== BigInt(mode)) fail('regular-file-open-race');
      const bytes = fs.readFileSync(descriptor);
      if (BigInt(bytes.length) !== stat.size || bytes.length > maxBytes
        || identity(fs.lstatSync(target, { bigint: true })) !== identity(stat)) fail('regular-file-read-race');
      return { stat, bytes };
    } finally { fs.closeSync(descriptor); }
  }

  function procText(target, maximum = 4194304) {
    const bytes = fs.readFileSync(target);
    if (bytes.length > maximum) fail('proc-limit');
    return bytes.toString('utf8');
  }

  function fdOwnsExactLock(descriptor, stat) {
    try {
      const held = fs.fstatSync(descriptor, { bigint: true });
      return held.isFile() && identity(held) === identity(stat)
        && procText(`/proc/self/fdinfo/${descriptor}`, 65536).split('\n').some(line => (
          line.startsWith('lock:') && matchesOwnExclusiveLock(parseProcLock(line.slice(5)), pid, stat)
        ));
    } catch (cause) { if (['ENOENT', 'EBADF'].includes(cause.code)) return false; throw cause; }
  }

  function assertHeld() {
    privateDirectory(stateDirectory, stateIdentity);
    if (journalIdentity !== undefined) privateDirectory(journalDirectory, journalIdentity);
    for (const [directory, expected] of jobDirectories) privateDirectory(directory, expected);
    if (applicationDirectory !== undefined) components(applicationDirectory, true);
    const { stat } = regular(flockPath, 0o600, 0, flockIdentity);
    const ownLocks = procText('/proc/locks').split('\n').map(parseProcLock)
      .filter(lock => matchesOwnExclusiveLock(lock, pid, stat));
    if (ownLocks.length !== 1) fail('exclusive-own-kernel-lock-required');
    if (heldDescriptor === undefined) {
      const names = fs.readdirSync('/proc/self/fd');
      if (names.length > 4096) fail('descriptor-limit');
      heldDescriptor = names.filter(name => /^\d+$/.test(name)).map(Number)
        .find(descriptor => Number.isSafeInteger(descriptor) && fdOwnsExactLock(descriptor, stat));
    }
    if (heldDescriptor === undefined || !fdOwnsExactLock(heldDescriptor, stat)) fail('inherited-kernel-descriptor-required');
    if (identity(fs.lstatSync(flockPath, { bigint: true })) !== identity(stat)) fail('flock-path-race');
    return { schema: FENCE_SCHEMA, pid, inode: stat.ino.toString(), device: stat.dev.toString(), held: true };
  }

  function createPrivateDirectory(target) {
    assertHeld(); components(path.dirname(target));
    let created = false;
    try { fs.mkdirSync(target, { mode: 0o700 }); created = true; }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const result = privateDirectory(target);
    if (created) syncDirectory(path.dirname(target));
    assertHeld(); return result;
  }

  stateIdentity = privateDirectory(stateDirectory);
  flockIdentity = identity(regular(flockPath, 0o600, 0).stat);
  assertHeld(); // Prove authority BEFORE creating journal/recovery paths.
  journalIdentity = createPrivateDirectory(journalDirectory);
  assertHeld();

  function prepareJobJournal(binding) {
    assertHeld();
    if (!binding || types.isProxy(binding)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(binding))) fail('job-binding-invalid');
    const descriptors = Object.getOwnPropertyDescriptors(binding);
    if (Reflect.ownKeys(descriptors).length !== 1 || !descriptors.jobBindingId
      || !Object.prototype.hasOwnProperty.call(descriptors.jobBindingId, 'value')
      || typeof descriptors.jobBindingId.value !== 'string' || !HASH.test(descriptors.jobBindingId.value)) fail('job-binding-invalid');
    const target = path.join(journalDirectory, descriptors.jobBindingId.value);
    if (!jobDirectories.has(target)) {
      if (jobDirectories.size >= 32) fail('job-partition-handle-limit');
      jobDirectories.set(target, createPrivateDirectory(target));
    }
    privateDirectory(target, jobDirectories.get(target)); assertHeld();
    return target;
  }

  function staleLock(baseDirectory, cohortId) {
    const cohort = path.join(baseDirectory, cohortId);
    const cohortIdentity = privateDirectory(cohort);
    const lockPath = path.join(cohort, 'writer.lock');
    let lockRecord;
    try { lockRecord = regular(lockPath, 0o600, 4096); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    const manifestRecord = regular(path.join(cohort, 'manifest.json'), 0o444, 8388608);
    let manifest, lock;
    try { manifest = JSON.parse(manifestRecord.bytes); lock = JSON.parse(lockRecord.bytes); }
    catch { fail('recovery-json-invalid'); }
    const preimage = canonicalManifest(manifest);
    if (preimage !== manifestRecord.bytes.toString('utf8') || hash(preimage) !== cohortId) fail('recovery-manifest-mismatch');
    if (!lock || Array.isArray(lock) || Object.keys(lock).sort().join(',') !== 'manifestId,pid,schema,token,uid'
      || lock.schema !== JOURNAL_SCHEMA || lock.manifestId !== cohortId
      || !Number.isSafeInteger(lock.uid) || BigInt(lock.uid) !== uid
      || !Number.isSafeInteger(lock.pid) || lock.pid < 1 || lock.pid > 2147483647 || lock.pid === pid
      || typeof lock.token !== 'string' || !HASH.test(lock.token)) fail('recovery-lock-invalid-or-current-owner');
    const canonicalLock = `{${Object.keys(lock).sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(lock[key])}`).join(',')}}`;
    if (canonicalLock !== lockRecord.bytes.toString('utf8')) fail('recovery-lock-preimage');
    return { cohort, cohortId, cohortIdentity, lockPath, lockRecord, manifestRecord, writerPid: lock.pid };
  }

  function recoverStaleWriterLocks(selection = {}) {
    assertHeld();
    if (!selection || types.isProxy(selection)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(selection))) fail('recovery-selection-invalid');
    const keys = Reflect.ownKeys(selection);
    if (keys.some(key => !['manifestId', 'jobBindingId'].includes(key)) || keys.length > 2
      || keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(selection, key);
        return !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || typeof descriptor.value !== 'string' || !HASH.test(descriptor.value);
      })) fail('recovery-selection-invalid');
    const baseDirectory = keys.includes('jobBindingId') ? path.join(journalDirectory, selection.jobBindingId) : journalDirectory;
    if (baseDirectory !== journalDirectory && !jobDirectories.has(baseDirectory)) fail('job-journal-not-prepared');
    privateDirectory(baseDirectory, baseDirectory === journalDirectory ? journalIdentity : jobDirectories.get(baseDirectory));
    const names = fs.readdirSync(baseDirectory);
    if (names.length > MAX_COHORTS + 1) fail('cohort-limit');
    for (const name of names) {
      if (name === 'terminal-journal.key') {
        if (regular(path.join(baseDirectory, name), 0o600, 32).bytes.length !== 32) fail('journal-key-invalid');
      }
      else if (!HASH.test(name)) fail('journal-entry-invalid');
      else privateDirectory(path.join(baseDirectory, name));
    }
    const requested = keys.includes('manifestId') ? names.filter(name => name === selection.manifestId) : names.filter(name => HASH.test(name));
    const pending = requested.map(cohortId => staleLock(baseDirectory, cohortId)).filter(Boolean); // Validate ALL before any rename.
    const recovered = [];
    for (const record of pending) {
      assertHeld(); privateDirectory(record.cohort, record.cohortIdentity);
      if (!regular(record.lockPath, 0o600, 4096, identity(record.lockRecord.stat)).bytes.equals(record.lockRecord.bytes)
        || !regular(path.join(record.cohort, 'manifest.json'), 0o444, 8388608,
          identity(record.manifestRecord.stat)).bytes.equals(record.manifestRecord.bytes)) fail('recovery-source-drift');
      const recoveryDirectory = path.join(stateDirectory, 'recovery');
      createPrivateDirectory(recoveryDirectory);
      const quarantine = fs.mkdtempSync(path.join(recoveryDirectory, `${record.cohortId}-`));
      fs.chmodSync(quarantine, 0o700); privateDirectory(quarantine); syncDirectory(recoveryDirectory);
      const quarantinePath = path.join(quarantine, 'writer.lock');
      assertHeld();
      fs.renameSync(record.lockPath, quarantinePath); // New private reserved directory; never an existing target.
      const moved = regular(quarantinePath, 0o600, 4096, identity(record.lockRecord.stat));
      if (!moved.bytes.equals(record.lockRecord.bytes)) fail('recovery-quarantine-drift');
      syncDirectory(record.cohort); syncDirectory(quarantine); syncDirectory(recoveryDirectory);
      assertHeld();
      recovered.push({ manifestId: record.cohortId, writerPid: record.writerPid, quarantinedLock: quarantinePath });
    }
    return { schema: FENCE_SCHEMA, recoveredCount: recovered.length, recovered, kernelFenceHeld: true };
  }

  return Object.freeze({ assertHeld, prepareJobJournal, recoverStaleWriterLocks });
}

module.exports = { FENCE_SCHEMA, MAX_COHORTS, linuxDeviceParts, parseProcLock, matchesOwnExclusiveLock, assertProductionFence };
