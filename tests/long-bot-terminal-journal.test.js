const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  MANIFEST_SCHEMA, JOURNAL_SCHEMA, SLOT_SCHEMA, canonicalManifest, createTerminalJournal,
} = require('../scripts/long-bot-terminal-journal');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const CANDIDATES = [hash('mock-legal-board-a'), hash('mock-legal-board-b')];

// Opaque bindings are deliberately unit-test data, not a rules-valid game or
// causal label. Semantic validation of every real binding belongs to worker.
function fixture(overrides = {}) {
  return {
    schema: MANIFEST_SCHEMA, sampleCount: 32, candidateIds: [...CANDIDATES],
    seedsBySample: Array.from({ length: 32 }, (_, index) => ({ white: index * 2 + 1, dark: index * 2 + 2 })),
    botColor: 'white', maxPlies: 320,
    bindings: {
      archiveFingerprint: hash('archive'), originalLedgerHash: hash('whole-ledger'),
      decisionIndex: 22, decisionId: hash('decision'), state: { mock: 'exact-state' },
      action: [{ from: 8, die: 2, to: 6 }], after: { mock: 'exact-after' },
      descriptor: { contextKey: 'exact-context', actionKey: 'exact-action' },
      orderedLegalSet: CANDIDATES.map(id => ({ id, mock: 'exact-ordered-action-and-after' })),
      pi: { strategyProfile: 'v25', maxCandidates: 64, analysisNodeBudget: 480 },
      mu: { strategyProfile: 'v25', maxCandidates: 24, analysisNodeBudget: 64 },
      experience: { size: 0, frozen: true, patterns: [] },
      policyImplementationId: hash('core'), runtimeDigest: hash('worker'),
      rulesDigest: hash('rules'), bundleDigest: hash('bundle'), closureDigest: hash('closure'),
      node: process.versions.node, v8: process.versions.v8,
      caps: { samples: 32, maxPlies: 320, alpha: 0.05, minRegretLcb: 0.08 },
    },
    ...overrides,
  };
}

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'terminal-journal-test-'));
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, directory: path.join(base, 'journal') };
}

function outcome(manifest, sampleIndex = 0, candidateId = manifest.candidateIds[0], overrides = {}) {
  return { sampleIndex, candidateId, seeds: clone(manifest.seedsBySample[sampleIndex]),
    winner: sampleIndex % 2 ? 'dark' : 'white', plies: 12 + sampleIndex, complete: true, ...overrides };
}

function cohort(directory, journal) { return path.join(directory, journal.manifestId); }
function slotPath(directory, journal, sampleIndex = 0, candidateId = CANDIDATES[0]) {
  return path.join(cohort(directory, journal), `slot-s${String(sampleIndex).padStart(3, '0')}-c${candidateId}.json`);
}
function checkpointPath(directory, journal, sampleIndex = 0, candidateId = CANDIDATES[0]) {
  return path.join(cohort(directory, journal), `checkpoint-s${String(sampleIndex).padStart(3, '0')}-c${candidateId}.json`);
}
function rolloutCheckpoint(manifest, plies = 3, overrides = {}) {
  return { sampleIndex: 0, candidateId: manifest.candidateIds[0], seeds: clone(manifest.seedsBySample[0]),
    plies, rolls: { white: Math.ceil(plies / 2), dark: Math.floor(plies / 2) },
    state: { variant: 'long', phase: 'roll', turn: plies % 2 ? 'dark' : 'white',
      points: { 24: { color: 'white', count: 15 }, 12: { color: 'dark', count: 15 } },
      off: { white: 0, dark: 0 }, score: { ply: plies } }, ...overrides };
}

function signedSlot(payload, directory) {
  const payloadHash = hash(stable(payload));
  const key = fs.readFileSync(path.join(directory, 'terminal-journal.key'));
  const mac = crypto.createHmac('sha256', key).update(`${JOURNAL_SCHEMA}\0${payloadHash}\0${stable(payload)}`).digest('hex');
  return stable({ schema: SLOT_SCHEMA, payload, payloadHash, mac });
}

test('complete fixed-cohort mock slots survive clean resume with identical ordered bits', t => {
  const { directory } = sandbox(t), manifest = fixture();
  let journal = createTerminalJournal({ directory, manifest });
  const bits = [];
  for (let sample = 0; sample < manifest.sampleCount; sample += 1) {
    for (const candidateId of manifest.candidateIds) {
      const entry = outcome(manifest, sample, candidateId);
      assert.equal(journal.commit(entry).committed, true);
      bits.push(entry.winner === manifest.botColor ? 1 : 0);
    }
  }
  assert.equal(journal.observation().complete, true);
  assert.equal(journal.observation().completedTerminalOutcomes, 64);
  assert.equal(journal.observation().learningEvidence, false);
  journal.close(); journal.close();
  journal = createTerminalJournal({ directory, manifest: clone(manifest) });
  const resumed = [];
  for (let sample = 0; sample < manifest.sampleCount; sample += 1) {
    for (const candidateId of manifest.candidateIds) {
      const entry = journal.lookup(sample, candidateId, manifest.seedsBySample[sample]);
      assert.equal(entry.complete, true);
      assert.equal(entry.manifestId, journal.manifestId);
      resumed.push(entry.winner === manifest.botColor ? 1 : 0);
    }
  }
  assert.deepEqual(resumed, bits);
  journal.close();
});

test('identical slot commits are idempotent; conflicting winners, plies or manifested IDs fail closed', t => {
  const { directory } = sandbox(t), manifest = fixture();
  const journal = createTerminalJournal({ directory, manifest });
  const entry = outcome(manifest), first = journal.commit(entry);
  assert.equal(first.duplicate, false);
  const saved = fs.readFileSync(slotPath(directory, journal));
  assert.equal(journal.commit(clone(entry)).duplicate, true);
  assert.equal(journal.commit({ ...entry, manifestId: journal.manifestId }).duplicate, true);
  assert.throws(() => journal.commit({ ...entry, winner: 'dark' }), /slot-conflict/);
  assert.throws(() => journal.commit({ ...entry, plies: entry.plies + 1 }), /slot-conflict/);
  assert.throws(() => journal.commit({ ...entry, manifestId: hash('wrong') }), /slot-invalid/);
  assert.deepEqual(fs.readFileSync(slotPath(directory, journal)), saved);
  assert.equal(journal.observation().completedTerminalOutcomes, 1);
  journal.close();
});

test('one authenticated in-game checkpoint advances monotonically and a terminal slot clears it exactly once', t => {
  const { directory } = sandbox(t), manifest = fixture();
  const journal = createTerminalJournal({ directory, manifest });
  const first = rolloutCheckpoint(manifest, 3);
  assert.equal(journal.saveCheckpoint(first).committed, true);
  const observation = journal.observation();
  assert.equal(observation.completedTerminalOutcomes, 0);
  assert.equal(observation.activeCheckpoint.sampleIndex, 0);
  assert.equal(observation.activeCheckpoint.candidateIndex, 0);
  assert.equal(observation.activeCheckpoint.plies, 3);
  assert.match(observation.activeCheckpoint.checkpointHash, /^[0-9a-f]{64}$/);
  assert.equal(journal.saveCheckpoint(clone(first)).duplicate, true);
  assert.throws(() => journal.saveCheckpoint(rolloutCheckpoint(manifest, 3,
    { state: { ...first.state, turn: 'white' } })), /checkpoint-conflict/);
  assert.throws(() => journal.saveCheckpoint(rolloutCheckpoint(manifest, 2)), /checkpoint-regression/);
  assert.equal(journal.saveCheckpoint(rolloutCheckpoint(manifest, 7)).committed, true);
  assert.equal(journal.lookupCheckpoint(0, CANDIDATES[0], manifest.seedsBySample[0]).plies, 7);
  assert.equal(journal.commit(outcome(manifest)).committed, true);
  assert.equal(journal.observation().activeCheckpoint, null);
  assert.equal(journal.observation().completedTerminalOutcomes, 1);
  assert.equal(journal.commit(outcome(manifest)).duplicate, true);
  assert.equal(journal.observation().completedTerminalOutcomes, 1);
  journal.close();
});

test('checkpoint tamper with a recomputed public hash fails its private MAC before resume', t => {
  const { directory } = sandbox(t), manifest = fixture();
  const journal = createTerminalJournal({ directory, manifest });
  journal.saveCheckpoint(rolloutCheckpoint(manifest, 5));
  const file = checkpointPath(directory, journal), original = fs.readFileSync(file);
  const envelope = JSON.parse(original);
  envelope.payload.state.score.ply = 999;
  envelope.payload.stateHash = hash(stable(envelope.payload.state));
  envelope.payloadHash = hash(stable(envelope.payload));
  fs.writeFileSync(file, stable(envelope));
  assert.throws(() => journal.lookupCheckpoint(0, CANDIDATES[0], manifest.seedsBySample[0]),
    /checkpoint-authentication-failed/);
  fs.writeFileSync(file, original);
  assert.equal(journal.lookupCheckpoint(0, CANDIDATES[0], manifest.seedsBySample[0]).plies, 5);
  journal.close();
});

for (const [stage, expectedPly, temporaryCount] of [
  ['after-checkpoint-temp-fsync', 3, 1],
  ['after-checkpoint-rename-before-directory-fsync', 7, 0],
  ['after-checkpoint-directory-fsync', 7, 0],
]) {
  test(`checkpoint mock crash at ${stage} resumes one authenticated boundary`, t => {
    const { directory } = sandbox(t), manifest = fixture();
    let armed = false;
    const journal = createTerminalJournal({ directory, manifest,
      _testHooks: { crash(current) { if (armed && current === stage) throw new Error('mock-checkpoint-crash'); } } });
    journal.saveCheckpoint(rolloutCheckpoint(manifest, 3));
    armed = true;
    assert.throws(() => journal.saveCheckpoint(rolloutCheckpoint(manifest, 7)), /mock-checkpoint-crash/);
    assert.throws(() => journal.observation(), /faulted/);
    journal.close();
    const resumed = createTerminalJournal({ directory, manifest });
    assert.equal(resumed.lookupCheckpoint(0, CANDIDATES[0], manifest.seedsBySample[0]).plies, expectedPly);
    assert.equal(resumed.observation().ignoredTemporaryFiles, temporaryCount);
    assert.equal(resumed.observation().completedTerminalOutcomes, 0);
    resumed.close();
  });
}

test('crash after a terminal slot is durable discards its older checkpoint on reopen', t => {
  const { directory } = sandbox(t), manifest = fixture();
  let armed = false;
  const journal = createTerminalJournal({ directory, manifest,
    _testHooks: { crash(stage) { if (armed && stage === 'after-directory-fsync') throw new Error('mock-terminal-crash'); } } });
  journal.saveCheckpoint(rolloutCheckpoint(manifest, 5));
  armed = true;
  assert.throws(() => journal.commit(outcome(manifest)), /mock-terminal-crash/);
  journal.close();
  const resumed = createTerminalJournal({ directory, manifest });
  assert.equal(resumed.observation().completedTerminalOutcomes, 1);
  assert.equal(resumed.observation().activeCheckpoint, null);
  assert.equal(resumed.lookupCheckpoint(0, CANDIDATES[0], manifest.seedsBySample[0]), null);
  resumed.close();
});

test('manifest and lookup/commit return values cannot mutate the captured cohort', t => {
  const { directory } = sandbox(t), manifest = fixture(), pristine = clone(manifest);
  const journal = createTerminalJournal({ directory, manifest });
  const entry = outcome(manifest), untouched = clone(entry), result = journal.commit(entry);
  assert.deepEqual(entry, untouched);
  manifest.seedsBySample[0].white = 9999;
  manifest.bindings.state.mock = 'changed-after-open';
  result.slot.seeds.white = 8888;
  const returned = journal.lookup(0, CANDIDATES[0], pristine.seedsBySample[0]);
  assert.equal(returned.seeds.white, 1);
  returned.winner = 'dark';
  assert.equal(journal.lookup(0, CANDIDATES[0], pristine.seedsBySample[0]).winner, 'white');
  assert.throws(() => journal.lookup(0, CANDIDATES[0], manifest.seedsBySample[0]), /lookup-invalid/);
  journal.close();
});

test('ordered legal candidate/seed/cap/color and every opaque source binding are committed separately', t => {
  const { directory } = sandbox(t), manifest = fixture();
  const original = createTerminalJournal({ directory, manifest });
  original.commit(outcome(manifest)); const originalId = original.manifestId; original.close();
  const variants = [
    { ...clone(manifest), candidateIds: [...manifest.candidateIds].reverse() },
    { ...clone(manifest), botColor: 'dark' }, { ...clone(manifest), maxPlies: 319 },
    { ...clone(manifest), seedsBySample: [...manifest.seedsBySample].reverse() },
  ];
  for (const key of Object.keys(manifest.bindings)) {
    const changed = clone(manifest);
    changed.bindings[key] = { changed: key, original: changed.bindings[key] };
    variants.push(changed);
  }
  for (const changed of variants) {
    const journal = createTerminalJournal({ directory, manifest: changed });
    assert.notEqual(journal.manifestId, originalId);
    assert.equal(journal.observation().completedTerminalOutcomes, 0);
    journal.close();
  }
  const reopened = createTerminalJournal({ directory, manifest });
  assert.equal(reopened.observation().completedTerminalOutcomes, 1);
  reopened.close();
});

test('canonical key ordering is stable but a wrong exact preimage at the cohort hash path is rejected', t => {
  const { directory } = sandbox(t), manifest = fixture();
  const reversedKeys = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(canonicalManifest(reversedKeys), canonicalManifest(manifest));
  const journal = createTerminalJournal({ directory, manifest });
  const manifestPath = path.join(cohort(directory, journal), 'manifest.json');
  journal.close();
  const changed = clone(manifest); changed.bindings.state.mock = 'different-source';
  fs.chmodSync(manifestPath, 0o600);
  fs.writeFileSync(manifestPath, canonicalManifest(changed));
  fs.chmodSync(manifestPath, 0o444);
  assert.throws(() => createTerminalJournal({ directory, manifest }), /manifest-preimage-mismatch/);
});

test('native manifest counts, colors, candidate/seed identities and complete bindings cannot be coerced', () => {
  for (const [key, values] of [
    ['sampleCount', [null, false, true, '32', 31, 129, 32.5, NaN, Infinity]],
    ['maxPlies', [null, false, '320', 0, 601, 1.5, NaN, Infinity]],
    ['botColor', [null, false, 'WHITE', 'guest']], ['bindings', [null, [], {}, 'source']],
    ['candidateIds', [[], ['x'], [CANDIDATES[0], CANDIDATES[0]]]],
  ]) {
    for (const value of values) assert.throws(() => canonicalManifest(fixture({ [key]: value })), /manifest-invalid/);
  }
  for (const value of [null, false, '1', 0, -1, 4294967296, 1.5, NaN, Infinity]) {
    const changed = fixture(); changed.seedsBySample[0].white = value;
    assert.throws(() => canonicalManifest(changed), /manifest-invalid/);
  }
  const collision = fixture(); collision.seedsBySample[1].dark = collision.seedsBySample[0].white;
  assert.throws(() => canonicalManifest(collision), /manifest-seed-collision/);
});

test('manifest proxies/getters/hooks/custom prototypes/sparse arrays/symbols/cycles reject without invoking hooks', () => {
  let calls = 0;
  const getter = fixture(); Object.defineProperty(getter.bindings, 'getter', { enumerable: true, get() { calls += 1; return 1; } });
  const custom = fixture(); custom.bindings = Object.assign(Object.create({ inherited: true }), custom.bindings);
  const hooked = fixture(); hooked.bindings.toJSON = () => { calls += 1; return {}; };
  const sparse = fixture(); sparse.candidateIds = Array(1); sparse.candidateIds.extra = CANDIDATES[0];
  const symbol = fixture(); symbol.bindings[Symbol('hidden')] = 1;
  const cycle = fixture(); cycle.bindings.loop = cycle;
  const boxed = fixture(); boxed.bindings.number = new Number(1);
  for (const value of [new Proxy(fixture(), { get() { calls += 1; return 1; } }), getter,
    custom, hooked, sparse, symbol, cycle, boxed]) assert.throws(() => canonicalManifest(value), /manifest-invalid/);
  assert.equal(calls, 0);
});

test('only native complete terminal slot fields are accepted, with manifested sample/candidate/seeds and ply cap', t => {
  const { directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
  for (const [key, values] of [
    ['sampleIndex', [null, false, true, '0', -1, 32, 0.5, NaN, Infinity]],
    ['candidateId', [null, false, hash('not-legal')]], ['winner', [null, false, 'WHITE', 'guest']],
    ['plies', [null, false, true, '12', -1, 321, 1.5, NaN, Infinity]],
    ['complete', [null, false, true.toString(), 1]],
  ]) for (const value of values) assert.throws(() => journal.commit(outcome(manifest, 0, CANDIDATES[0], { [key]: value })), /slot-invalid/);
  const wrongSeed = { white: 65, dark: 66 };
  assert.throws(() => journal.commit(outcome(manifest, 0, CANDIDATES[0], { seeds: wrongSeed })), /slot-invalid/);
  assert.throws(() => journal.commit({ ...outcome(manifest), botWon: true }), /slot-invalid/);
  const missing = outcome(manifest); delete missing.complete;
  assert.throws(() => journal.commit(missing), /slot-invalid/);
  assert.equal(journal.observation().completedTerminalOutcomes, 0);
  assert.equal(journal.commit(outcome(manifest, 0, CANDIDATES[0], { plies: 0 })).committed, true,
    'an already-terminal original action can require zero future plies');
  journal.close();
});

test('lookup rejects native count/seed/candidate drift and commit does not delegate to forged receiver hooks', t => {
  const { directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
  for (const sample of [null, false, '0', -1, 32, NaN, Infinity]) {
    assert.throws(() => journal.lookup(sample, CANDIDATES[0], manifest.seedsBySample[0]), /lookup-invalid/);
  }
  assert.throws(() => journal.lookup(0, hash('other'), manifest.seedsBySample[0]), /lookup-invalid/);
  assert.throws(() => journal.lookup(0, CANDIDATES[0], { white: '1', dark: 2 }), /lookup-invalid/);
  let invoked = false;
  journal.commit.call({ lookup() { invoked = true; return outcome(manifest); } }, outcome(manifest));
  assert.equal(invoked, false);
  assert.equal(journal.observation().completedTerminalOutcomes, 1);
  journal.close();
});

for (const [stage, survives, temporaryCount] of [
  ['after-temp-fsync', false, 1], ['after-link-before-temp-unlink', true, 1],
  ['after-directory-fsync', true, 0],
]) {
  test(`atomic mock crash at ${stage} never invents a terminal slot`, t => {
    const { directory } = sandbox(t), manifest = fixture();
    let armed = false;
    const journal = createTerminalJournal({ directory, manifest,
      _testHooks: { crash(current) { if (armed && current === stage) throw new Error('mock-fs-crash'); } } });
    armed = true;
    assert.throws(() => journal.commit(outcome(manifest)), /mock-fs-crash/);
    assert.throws(() => journal.observation(), /faulted/);
    journal.close();
    const resumed = createTerminalJournal({ directory, manifest });
    assert.equal(resumed.observation().completedTerminalOutcomes, survives ? 1 : 0);
    assert.equal(resumed.observation().ignoredTemporaryFiles, temporaryCount);
    assert.equal(Boolean(resumed.lookup(0, CANDIDATES[0], manifest.seedsBySample[0])), survives);
    assert.equal(resumed.observation().learningEvidence, false);
    resumed.close();
  });
}

test('a successful endpoint is file-fsynced before the final nooverwrite link and directory-fsynced before return', t => {
  const { directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
  const original = fs.fsyncSync, calls = [];
  fs.fsyncSync = descriptor => { calls.push(fs.fstatSync(descriptor).isDirectory() ? 'directory' : 'file'); original(descriptor); };
  try { journal.commit(outcome(manifest)); } finally { fs.fsyncSync = original; }
  assert.deepEqual(calls, ['file', 'directory']);
  assert.equal(fs.statSync(slotPath(directory, journal)).nlink, 1);
  journal.close();
});

test('fresh private root creation fsyncs its parent before initialization can return', t => {
  const { base, directory } = sandbox(t), manifest = fixture();
  const original = fs.fsyncSync, syncedDirectories = [], checkpoints = [];
  fs.fsyncSync = descriptor => {
    const stat = fs.fstatSync(descriptor);
    if (stat.isDirectory()) syncedDirectories.push(`${stat.dev}:${stat.ino}`);
    original(descriptor);
  };
  let journal;
  try {
    journal = createTerminalJournal({ directory, manifest,
      _testHooks: { crash(stage) { checkpoints.push(stage); } } });
  } finally { fs.fsyncSync = original; }
  const parent = fs.statSync(base);
  assert.ok(syncedDirectories.includes(`${parent.dev}:${parent.ino}`));
  assert.equal(checkpoints[0], 'after-parent-directory-fsync');
  assert.equal(checkpoints.filter(stage => stage === 'after-parent-directory-fsync').length, 2,
    'both new root and new cohort links have durable parents');
  journal.close();
});

test('observation authenticates persisted completeness rather than trusting cached records after deletion or tamper', t => {
  const { directory } = sandbox(t), manifest = fixture({ candidateIds: [CANDIDATES[0]] });
  const journal = createTerminalJournal({ directory, manifest });
  for (let sample = 0; sample < manifest.sampleCount; sample += 1) journal.commit(outcome(manifest, sample));
  assert.equal(journal.observation().complete, true);
  const file = slotPath(directory, journal), original = fs.readFileSync(file);
  const envelope = JSON.parse(original);
  envelope.payload.winner = 'dark'; envelope.payloadHash = hash(stable(envelope.payload));
  fs.writeFileSync(file, stable(envelope));
  assert.throws(() => journal.observation(), /slot-authentication-failed/);
  fs.writeFileSync(file, original);
  assert.equal(journal.observation().completedTerminalOutcomes, 32);
  fs.unlinkSync(file);
  assert.throws(() => journal.observation(), /ENOENT/);
  journal.close();
});

test('exclusive writer locking, stale lock fail-closed and close fence never release another owner', t => {
  const { directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
  assert.throws(() => createTerminalJournal({ directory, manifest }), /writer-locked/);
  const lockPath = path.join(cohort(directory, journal), 'writer.lock');
  const changed = JSON.parse(fs.readFileSync(lockPath)); changed.token = hash('foreign-writer');
  fs.writeFileSync(lockPath, stable(changed));
  assert.throws(() => journal.lookup(0, CANDIDATES[0], manifest.seedsBySample[0]), /lock-fence-lost/);
  assert.throws(() => journal.close(), /lock-fence-lost/);
  assert.equal(fs.existsSync(lockPath), true);
  assert.throws(() => createTerminalJournal({ directory, manifest }), /writer-locked/);
});

test('private root/key/manifest/lock/slot modes and owner identity are enforced; no key/MAC escapes API', t => {
  const { directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
  journal.commit(outcome(manifest));
  const keyPath = path.join(directory, 'terminal-journal.key');
  for (const [file, mode] of [[directory, 0o700], [cohort(directory, journal), 0o700],
    [keyPath, 0o600], [path.join(cohort(directory, journal), 'manifest.json'), 0o444],
    [path.join(cohort(directory, journal), 'writer.lock'), 0o600], [slotPath(directory, journal), 0o600]]) {
    assert.equal(fs.statSync(file).mode & 0o7777, mode);
    assert.equal(fs.statSync(file).uid, process.getuid());
  }
  const key = fs.readFileSync(keyPath), envelope = JSON.parse(fs.readFileSync(slotPath(directory, journal)));
  const publicOutput = JSON.stringify([journal, journal.observation(), journal.lookup(0, CANDIDATES[0], manifest.seedsBySample[0])]);
  assert.equal(publicOutput.includes(key.toString('hex')), false);
  assert.equal(publicOutput.includes(key.toString('base64')), false);
  assert.equal(publicOutput.includes(envelope.mac), false);
  fs.chmodSync(keyPath, 0o644);
  assert.throws(() => journal.observation(), /file-owner-mode-type-or-identity/);
  journal.close();
  assert.throws(() => createTerminalJournal({ directory, manifest }), /file-owner-mode-type-or-identity/);
});

test('a replaced or mutated owner key cannot authenticate an existing journal', t => {
  const { directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
  journal.commit(outcome(manifest));
  const keyPath = path.join(directory, 'terminal-journal.key');
  fs.writeFileSync(keyPath, crypto.randomBytes(32));
  assert.throws(() => journal.lookup(0, CANDIDATES[0], manifest.seedsBySample[0]), /key-drift/);
  journal.close();
  assert.throws(() => createTerminalJournal({ directory, manifest }), /slot-authentication-failed/);
});

test('slot tamper with recomputed payload hash still fails the private MAC', t => {
  const { directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
  journal.commit(outcome(manifest));
  const file = slotPath(directory, journal), envelope = JSON.parse(fs.readFileSync(file));
  envelope.payload.winner = 'dark'; envelope.payloadHash = hash(stable(envelope.payload));
  fs.writeFileSync(file, stable(envelope));
  assert.throws(() => journal.lookup(0, CANDIDATES[0], manifest.seedsBySample[0]), /slot-authentication-failed/);
  journal.close();
  assert.throws(() => createTerminalJournal({ directory, manifest }), /slot-authentication-failed/);
});

test('the loader rejects authenticated native-invalid/censored fields, filename duplicates and noncanonical bytes', t => {
  const { directory } = sandbox(t), manifest = fixture();
  let journal = createTerminalJournal({ directory, manifest });
  journal.commit(outcome(manifest)); const file = slotPath(directory, journal);
  const valid = JSON.parse(fs.readFileSync(file)).payload; journal.close();
  for (const mutation of [{ complete: false }, { complete: 'true' }, { sampleIndex: '0' },
    { plies: '12' }, { winner: 'guest' }, { seeds: { white: 65, dark: 66 } }]) {
    fs.writeFileSync(file, signedSlot({ ...valid, ...mutation }, directory));
    assert.throws(() => createTerminalJournal({ directory, manifest }), /slot-invalid/);
  }
  fs.writeFileSync(file, signedSlot(valid, directory));
  const duplicateName = path.join(path.dirname(file), `slot-s001-c${CANDIDATES[0]}.json`);
  fs.copyFileSync(file, duplicateName);
  assert.throws(() => createTerminalJournal({ directory, manifest }), /filename-mismatch/);
  fs.unlinkSync(duplicateName);
  fs.writeFileSync(file, `${JSON.stringify(JSON.parse(signedSlot(valid, directory)), null, 2)}\n`);
  assert.throws(() => createTerminalJournal({ directory, manifest }), /preimage-or-filename-mismatch/);
});

test('only regex-reserved uncommitted regular temp files are ignored, never partial final/unknown files', t => {
  const { directory } = sandbox(t), manifest = fixture();
  const journal = createTerminalJournal({ directory, manifest }), folder = cohort(directory, journal); journal.close();
  const temporary = path.join(folder, `.tmp-slot-${'a'.repeat(32)}`);
  fs.writeFileSync(temporary, '{partial', { mode: 0o600 });
  const reopened = createTerminalJournal({ directory, manifest });
  assert.equal(reopened.observation().ignoredTemporaryFiles, 1);
  assert.equal(reopened.observation().completedTerminalOutcomes, 0);
  reopened.close();
  const partialFinal = path.join(folder, `slot-s000-c${CANDIDATES[0]}.json`);
  fs.writeFileSync(partialFinal, '{partial', { mode: 0o600 });
  assert.throws(() => createTerminalJournal({ directory, manifest }), /slot-json-invalid/);
  fs.unlinkSync(partialFinal);
  fs.writeFileSync(path.join(folder, '.tmp-not-reserved'), '{partial', { mode: 0o600 });
  assert.throws(() => createTerminalJournal({ directory, manifest }), /unexpected-file/);
});

test('symlink roots or ancestor components are rejected without following their targets', t => {
  const { base } = sandbox(t), manifest = fixture(), actual = path.join(base, 'actual');
  fs.mkdirSync(actual, { mode: 0o700 });
  const alias = path.join(base, 'alias'); fs.symlinkSync(actual, alias);
  assert.throws(() => createTerminalJournal({ directory: alias, manifest }), /directory-symlink/);
  assert.throws(() => createTerminalJournal({ directory: path.join(alias, 'child'), manifest }), /directory-symlink/);
  assert.deepEqual(fs.readdirSync(actual), []);
});

test('non-sticky group or world writable ancestors are rejected before creating a private root', t => {
  const { base } = sandbox(t), manifest = fixture(), parent = path.join(base, 'unsafe-parent');
  fs.mkdirSync(parent, { mode: 0o700 });
  for (const mode of [0o770, 0o777]) {
    fs.chmodSync(parent, mode);
    const directory = path.join(parent, 'journal');
    assert.throws(() => createTerminalJournal({ directory, manifest }), /directory-ancestor-untrusted/);
    assert.equal(fs.existsSync(directory), false);
  }
  fs.chmodSync(parent, 0o700);
});

for (const target of ['key', 'manifest', 'slot', 'temporary']) {
  test(`journal rejects a symlink ${target} rather than trusting or deleting its target`, t => {
    const { base, directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
    journal.commit(outcome(manifest));
    const folder = cohort(directory, journal), victim = path.join(base, 'victim'); journal.close();
    let file;
    if (target === 'key') file = path.join(directory, 'terminal-journal.key');
    else if (target === 'manifest') file = path.join(folder, 'manifest.json');
    else if (target === 'slot') file = slotPath(directory, journal);
    else file = path.join(folder, `.tmp-slot-${'b'.repeat(32)}`);
    const original = target === 'temporary' ? Buffer.from('untouched') : fs.readFileSync(file);
    fs.writeFileSync(victim, original, { mode: 0o600 });
    if (target !== 'temporary') fs.unlinkSync(file);
    fs.symlinkSync(victim, file);
    assert.throws(() => createTerminalJournal({ directory, manifest }), /file-owner-mode-type-or-identity|temporary-file-unsafe/);
    assert.deepEqual(fs.readFileSync(victim), original);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  });
}

test('insecure root directory and externally hardlinked private keys fail closed', t => {
  const { base, directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
  journal.close(); fs.chmodSync(directory, 0o755);
  assert.throws(() => createTerminalJournal({ directory, manifest }), /directory-owner-mode-or-identity/);
  fs.chmodSync(directory, 0o700);
  fs.linkSync(path.join(directory, 'terminal-journal.key'), path.join(base, 'key-hardlink'));
  assert.throws(() => createTerminalJournal({ directory, manifest }), /file-owner-mode-type-or-identity/);
});

test('closed writers cannot perform lookups, observations or commits', t => {
  const { directory } = sandbox(t), manifest = fixture(), journal = createTerminalJournal({ directory, manifest });
  journal.close();
  assert.throws(() => journal.observation(), /closed/);
  assert.throws(() => journal.lookup(0, CANDIDATES[0], manifest.seedsBySample[0]), /closed/);
  assert.throws(() => journal.commit(outcome(manifest)), /closed/);
});
