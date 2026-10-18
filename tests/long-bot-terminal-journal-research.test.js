'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTerminalJournal } = require('../scripts/long-bot-terminal-journal');
const { inspectTerminalJournals } = require('../scripts/review-long-bot-terminal-journals');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = 'a'.repeat(64);

function fixture(t, complete = true) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'paired-research-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const partition = path.join(directory, 'b'.repeat(64));
  fs.mkdirSync(partition, { mode: 0o700 });
  const candidateIds = [sha('selected-position'), sha('alternative-position')];
  const seedsBySample = Array.from({ length: 32 }, (_, i) => ({ white: i * 2 + 1, dark: i * 2 + 2 }));
  const journal = createTerminalJournal({ directory: partition, manifest: {
    schema: 'long-bot-terminal-cohort-manifest-v1', sampleCount: 32,
    candidateIds, seedsBySample, botColor: 'dark', maxPlies: 320,
    bindings: { currentConfiguredRuntimeDigest: digest, currentPolicyImplementationId: 'c'.repeat(64),
      selectedAfterPositionKey: 'selected-position', sourceDecisionId: 'synthetic-only',
      sourceDecisionIndex: 0, serverJobId: 1 },
  } });
  for (let sample = 0; sample < (complete ? 32 : 1); sample++) for (const [i, id] of candidateIds.entries()) {
    journal.commit({ sampleIndex: sample, candidateId: id, seeds: seedsBySample[sample],
      winner: i === 1 && sample < 16 ? 'dark' : 'white', plies: 1, complete: true });
  }
  return { directory, partition, journal };
}

test('journal research verifies all signed slots but cannot create production evidence or mutate the writer lock', t => {
  const { directory, partition, journal } = fixture(t);
  const cohort = path.join(partition, journal.manifestId);
  const lock = fs.readFileSync(path.join(cohort, 'writer.lock'));
  const names = fs.readdirSync(cohort).sort();
  try {
    const result = inspectTerminalJournals({ directory, runtimeDigest: digest });
    assert.equal(result.productionEvidence, false);
    assert.equal(result.completeCohorts, 1);
    assert.equal(result.cohorts[0].endpoints, 64);
    assert.equal(result.cohorts[0].journalIntegrityVerified, true);
    assert.ok(result.cohorts[0].contrasts[0].marginalLowerBound < 0.08);
    assert.ok(result.cohorts[0].contrasts[0].paired.lower > 0.08);
    assert.deepEqual(fs.readdirSync(cohort).sort(), names);
    assert.deepEqual(fs.readFileSync(path.join(cohort, 'writer.lock')), lock);
  } finally { journal.close(); }
});

test('an incomplete native cohort yields counts only, never a partial confidence verdict', t => {
  const { directory, journal } = fixture(t, false);
  try {
    const result = inspectTerminalJournals({ directory, runtimeDigest: digest });
    assert.equal(result.completeCohorts, 0);
    assert.equal(result.cohorts[0].contrasts, undefined);
    assert.equal(result.cohorts[0].endpoints, 2);
  } finally { journal.close(); }
});

test('changed or unauthenticated terminal endpoint fails closed', t => {
  const { directory, partition, journal } = fixture(t);
  const cohort = path.join(partition, journal.manifestId);
  const file = path.join(cohort, fs.readdirSync(cohort).find(name => name.startsWith('slot-')));
  journal.close();
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  envelope.mac = '0'.repeat(64);
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  fs.writeFileSync(file, canonical(envelope));
  assert.throws(() => inspectTerminalJournals({ directory, runtimeDigest: digest }), /authentication failed/);
});
