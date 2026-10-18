#!/usr/bin/env node
'use strict';
// Read-only research: authenticate existing journal endpoints and compare
// statistical power. Reads keys locally for authentication; NEVER exports
// keys, writes a journal, or publishes XP.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalManifest, JOURNAL_SCHEMA, SLOT_SCHEMA } = require('./long-bot-terminal-journal');
const { countsForPairedOutcomes, pairedDifferenceLowerBound } = require('../lib/long-bot-paired-confidence');
const HASH = /^[0-9a-f]{64}$/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);

function regular(file, maximum, mode, uid) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || (stat.mode & 0o777) !== mode
      || stat.uid !== uid) throw new Error('Research input is not an owned private regular file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function privateDirectory(directory, uid = null) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || uid !== null && stat.uid !== uid) throw new Error('Research input is not an owned private directory');
  return stat.uid;
}

function inspectCohort(directory, key, uid, runtimeDigest) {
  privateDirectory(directory, uid);
  const bytes = regular(path.join(directory, 'manifest.json'), 8388608, 0o444, uid);
  const manifest = JSON.parse(bytes);
  const preimage = canonicalManifest(manifest);
  const manifestId = path.basename(directory);
  if (preimage !== bytes.toString('utf8') || sha(preimage) !== manifestId) {
    throw new Error('Research manifest identity mismatch');
  }
  if (manifest.bindings.currentConfiguredRuntimeDigest !== runtimeDigest) return null;
  const selectedId = sha(manifest.bindings.selectedAfterPositionKey);
  if (!manifest.candidateIds.includes(selectedId) || manifest.candidateIds.length < 2) {
    throw new Error('Research selected candidate is absent');
  }
  const outcomes = new Map(manifest.candidateIds.map(id => [id, Array(manifest.sampleCount).fill(null)]));
  let endpoints = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^slot-s\d{3}-c[0-9a-f]{64}\.json$/.test(name)) continue;
    const raw = regular(path.join(directory, name), 16384, 0o600, uid);
    const envelope = JSON.parse(raw);
    if (Object.keys(envelope).sort().join(',') !== 'mac,payload,payloadHash,schema'
      || envelope.schema !== SLOT_SCHEMA || !HASH.test(envelope.payloadHash) || !HASH.test(envelope.mac)
      || canonical(envelope) !== raw.toString('utf8')) throw new Error('Research slot envelope mismatch');
    const payload = canonical(envelope.payload);
    const expectedMac = crypto.createHmac('sha256', key)
      .update(`${JOURNAL_SCHEMA}\0${envelope.payloadHash}\0${payload}`).digest();
    if (sha(payload) !== envelope.payloadHash
      || !crypto.timingSafeEqual(expectedMac, Buffer.from(envelope.mac, 'hex'))) {
      throw new Error('Research slot authentication failed');
    }
    const slot = envelope.payload;
    if (Object.keys(slot).sort().join(',') !== 'candidateId,complete,manifestId,plies,sampleIndex,seeds,winner'
      || slot.manifestId !== manifestId || slot.complete !== true
      || !Number.isSafeInteger(slot.sampleIndex) || slot.sampleIndex < 0 || slot.sampleIndex >= manifest.sampleCount
      || !outcomes.has(slot.candidateId) || !['white', 'dark'].includes(slot.winner)
      || !Number.isSafeInteger(slot.plies) || slot.plies < 0 || slot.plies > manifest.maxPlies
      || canonical(slot.seeds) !== canonical(manifest.seedsBySample[slot.sampleIndex])
      || name !== `slot-s${String(slot.sampleIndex).padStart(3, '0')}-c${slot.candidateId}.json`
      || outcomes.get(slot.candidateId)[slot.sampleIndex] !== null) throw new Error('Research slot context mismatch');
    outcomes.get(slot.candidateId)[slot.sampleIndex] = slot.winner === manifest.botColor ? 1 : 0;
    endpoints++;
  }
  const required = manifest.sampleCount * manifest.candidateIds.length;
  const complete = endpoints === required;
  const metadata = { serverJobId: manifest.bindings.serverJobId ?? null,
    decisionId: manifest.bindings.sourceDecisionId, decisionIndex: manifest.bindings.sourceDecisionIndex,
    manifestId, runtimeDigest, policyImplementationId: manifest.bindings.currentPolicyImplementationId,
    endpoints, required, complete, productionEvidence: false, journalIntegrityVerified: true };
  if (!complete) return metadata;
  const selected = outcomes.get(selectedId);
  const selectedWins = selected.reduce((sum, value) => sum + value, 0);
  const epsilon = Math.sqrt(Math.log(2 * outcomes.size / 0.05) / (2 * selected.length));
  const contrasts = [...outcomes.entries()].filter(([id]) => id !== selectedId).map(([candidateId, candidate]) => {
    const wins = candidate.reduce((sum, value) => sum + value, 0);
    const paired = pairedDifferenceLowerBound(countsForPairedOutcomes(selected, candidate),
      { comparisons: outcomes.size - 1 });
    return { candidateId, selectedWins, candidateWins: wins, samples: selected.length,
      marginalLowerBound: Math.max(0, wins / selected.length - epsilon)
        - Math.min(1, selectedWins / selected.length + epsilon), paired };
  });
  return { ...metadata, contrasts };
}

function inspectTerminalJournals({ directory, runtimeDigest, maximumCohorts = 1024 }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory
    || fs.realpathSync(directory) !== directory || !HASH.test(runtimeDigest)
    || !Number.isSafeInteger(maximumCohorts) || maximumCohorts < 1 || maximumCohorts > 4096) {
    throw new Error('Bounded physical journal directory and immutable runtime digest required');
  }
  const uid = privateDirectory(directory);
  const results = [];
  let examined = 0;
  for (const partition of fs.readdirSync(directory).sort()) {
    if (!HASH.test(partition)) continue;
    const partitionPath = path.join(directory, partition);
    privateDirectory(partitionPath, uid);
    const names = fs.readdirSync(partitionPath);
    const cohorts = names.filter(name => HASH.test(name));
    if (!cohorts.length) continue;
    const key = regular(path.join(partitionPath, 'terminal-journal.key'), 32, 0o600, uid);
    if (key.length !== 32) throw new Error('Research journal key has wrong size');
    for (const cohort of cohorts.sort()) {
      if (++examined > maximumCohorts) throw new Error('Research cohort cap exceeded');
      const result = inspectCohort(path.join(partitionPath, cohort), key, uid, runtimeDigest);
      if (result) results.push(result);
    }
  }
  return { schema: 'long-bot-paired-confidence-research-v1', productionEvidence: false,
    purpose: 'read-only-statistical-power-diagnostic', runtimeDigest, examined,
    completeCohorts: results.filter(row => row.complete).length, cohorts: results };
}

if (require.main === module) {
  const [directory, runtimeDigest] = process.argv.slice(2);
  try { process.stdout.write(JSON.stringify(inspectTerminalJournals({ directory, runtimeDigest })) + '\n'); }
  catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
}
module.exports = { inspectTerminalJournals };
