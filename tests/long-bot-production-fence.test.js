'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { linuxDeviceParts, parseProcLock, matchesOwnExclusiveLock, assertProductionFence } = require('../scripts/long-bot-production-fence');
const { MANIFEST_SCHEMA } = require('../scripts/long-bot-terminal-journal');
const ROOT = path.join(__dirname, '..');
const FENCE = path.join(ROOT, 'scripts/long-bot-production-fence.js');
const JOURNAL = path.join(ROOT, 'scripts/long-bot-terminal-journal.js');
const FLOCK = '/usr/bin/flock';
const linux = process.platform === 'linux' && fs.existsSync(FLOCK);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'long-production-fence-test-'));
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, 'worker.flock'), '', { mode: 0o600, flag: 'wx' });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function manifest() {
  return { schema: MANIFEST_SCHEMA, sampleCount: 32, candidateIds: [sha('mock-board')],
    seedsBySample: Array.from({ length: 32 }, (_, index) => ({ white: index * 2 + 1, dark: index * 2 + 2 })),
    botColor: 'white', maxPlies: 320, bindings: { fixtureOnly: true, noLearningEvidence: true } };
}
function child(directory, body, { shared = false, noFork = true, locked = true } = {}) {
  const code = `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {assertProductionFence}=require(${JSON.stringify(FENCE)});
const {createTerminalJournal}=require(${JSON.stringify(JOURNAL)});
const directory=${JSON.stringify(directory)},journalDirectory=path.join(directory,'terminal-journal');
const manifest=${JSON.stringify(manifest())};
${body}`;
  return locked ? spawnSync(FLOCK, [shared ? '--shared' : '--exclusive', '--nonblock',
    ...(noFork ? ['--no-fork'] : []), path.join(directory, 'worker.flock'), process.execPath, '-e', code],
  { encoding: 'utf8', timeout: 10000 }) : spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 10000 });
}

test('Linux dev_t major/minor parsing is native BigInt exact, including high bits', () => {
  for (const [major, minor] of [[0n, 0n], [8n, 1n], [259n, 65536n], [0xffffffffn, 0xffffffffn]]) {
    const device = ((major & 0xfffn) << 8n) | ((major & 0xfffff000n) << 32n)
      | (minor & 0xffn) | ((minor & 0xffffff00n) << 12n);
    assert.deepEqual(linuxDeviceParts(device), { major, minor });
  }
  for (const value of [0, '0', null, false, -1n, 0x10000000000000000n]) assert.throws(() => linuxDeviceParts(value), /device-invalid/);
});

test('kernel lock parser rejects waiting rows and matches only whole-file own exclusive BSD flock', () => {
  const stat = { dev: 0x801n, ino: 99999999999999999n };
  const record = parseProcLock('  21: FLOCK  ADVISORY WRITE 123 08:01:99999999999999999 0 EOF');
  assert.equal(matchesOwnExclusiveLock(record, 123, stat), true);
  for (const changes of [{ type: 'POSIX' }, { type: 'OFDLCK' }, { advisory: 'MANDATORY' },
    { access: 'READ' }, { pid: 122n }, { major: 9n }, { minor: 2n }, { inode: 999n }, { start: 1n }, { end: 99n }]) {
    assert.equal(matchesOwnExclusiveLock({ ...record, ...changes }, 123, stat), false);
  }
  for (const line of ['21: -> FLOCK ADVISORY WRITE 123 08:01:999 0 EOF',
    '21: FLOCK ADVISORY WRITE 123 08:01:999 0 EOF extra', '', null, 'claimed-own-lock:true']) assert.equal(parseProcLock(line), null);
});

test('non-Linux production assertion cannot be authorized by options or forged provenance', { skip: process.platform === 'linux' }, () => {
  assert.throws(() => assertProductionFence({ journalDirectory: '/private/tmp/journal',
    platform: 'linux', pid: process.pid, procLocks: 'forged', trusted: true }), /linux-real-uid-required/);
});

test('systemd worker uses no-fork real flock, private persistent writable state and a bounded unprivileged service', () => {
  const service = fs.readFileSync(path.join(ROOT, 'ops/timeweb/long-bot-causal-worker.service'), 'utf8');
  const timer = fs.readFileSync(path.join(ROOT, 'ops/timeweb/long-bot-causal-worker.timer'), 'utf8');
  for (const setting of ['User=nardy-worker', 'Group=nardy-worker', 'StateDirectory=online-backgammon-causal-worker',
    'StateDirectoryMode=0700', 'UMask=0077', 'TimeoutStartSec=8min', 'TimeoutStopSec=30s', 'MemoryMax=768M',
    'CPUQuota=100%', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'PrivateTmp=true', 'KillMode=control-group',
    'ReadWritePaths=/var/lib/online-backgammon-causal-worker']) assert.ok(service.includes(setting), setting);
  assert.ok(service.includes('ExecStart=/usr/bin/flock --exclusive --nonblock --no-fork /var/lib/online-backgammon-causal-worker/worker.flock /usr/bin/node scripts/long-bot-causal-worker.js --once --limit 1 --production-journal-dir /var/lib/online-backgammon-causal-worker/terminal-journal'));
  assert.ok(timer.includes('OnUnitInactiveSec=1min')); assert.ok(timer.includes('Unit=long-bot-causal-worker.service'));
  assert.equal(service.includes('TimeoutStartSec=16h'), false);
});

test('actual Linux inherited exclusive flock is proved by proc locks and fdinfo before creating journal state', { skip: !linux }, t => {
  const directory = sandbox(t);
  const result = child(directory, `const fence=assertProductionFence({journalDirectory});
assert.equal(fence.assertHeld().pid,process.pid);assert.equal(fence.assertHeld().held,true);
assert.equal(fs.statSync(journalDirectory).mode&0o7777,0o700);
console.log(JSON.stringify(fence.recoverStaleWriterLocks()));`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).recoveredCount, 0);
});

for (const configuration of [{ label: 'no flock', locked: false },
  { label: 'shared flock', shared: true }, { label: 'forking wrapper owns another PID', noFork: false }]) {
  test(`actual Linux ${configuration.label} cannot authorize recovery`, { skip: !linux }, t => {
    const directory = sandbox(t);
    const result = child(directory, `assert.throws(()=>assertProductionFence({journalDirectory}),/exclusive-own-kernel-lock-required/);
assert.equal(fs.existsSync(journalDirectory),false);`, configuration);
    assert.equal(result.status, 0, result.stderr);
  });
}

test('Linux crash-recovery quarantines only stale writer lock and preserves manifest/key/authenticated mock endpoint bytes', { skip: !linux }, t => {
  const directory = sandbox(t);
  const crash = child(directory, `assertProductionFence({journalDirectory});
const journal=createTerminalJournal({directory:journalDirectory,manifest});
journal.commit({sampleIndex:0,candidateId:manifest.candidateIds[0],seeds:manifest.seedsBySample[0],winner:'white',plies:3,complete:true});
process.kill(process.pid,'SIGKILL');`);
  assert.equal(crash.signal, 'SIGKILL', crash.stderr);
  const journalDirectory = path.join(directory, 'terminal-journal');
  const cohortId = fs.readdirSync(journalDirectory).find(name => /^[0-9a-f]{64}$/.test(name));
  const cohortDirectory = path.join(journalDirectory, cohortId);
  const slotName = fs.readdirSync(cohortDirectory).find(name => name.startsWith('slot-'));
  const preserved = [path.join(journalDirectory, 'terminal-journal.key'), path.join(cohortDirectory, 'manifest.json'),
    path.join(cohortDirectory, slotName)].map(file => [file, fs.readFileSync(file)]);
  const oldLock = fs.readFileSync(path.join(cohortDirectory, 'writer.lock'));
  const recovered = child(directory, `const fence=assertProductionFence({journalDirectory});
const recovery=fence.recoverStaleWriterLocks();assert.equal(recovery.recoveredCount,1);
const journal=createTerminalJournal({directory:journalDirectory,manifest});
assert.equal(journal.lookup(0,manifest.candidateIds[0],manifest.seedsBySample[0]).winner,'white');
assert.equal(journal.observation().completedTerminalOutcomes,1);journal.close();
console.log(JSON.stringify(recovery));`);
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.recovered[0].manifestId, cohortId);
  assert.deepEqual(fs.readFileSync(result.recovered[0].quarantinedLock), oldLock);
  assert.equal(fs.statSync(path.dirname(result.recovered[0].quarantinedLock)).mode & 0o7777, 0o700);
  for (const [file, bytes] of preserved) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(path.join(cohortDirectory, 'writer.lock')), false);
});

test('Linux factory has no injected kernel/fs authority and rejects a current-process live journal owner', { skip: !linux }, t => {
  const directory = sandbox(t);
  const result = child(directory, `assert.throws(()=>assertProductionFence({journalDirectory,procRoot:directory}),/options-invalid/);
const fence=assertProductionFence({journalDirectory});
assert.throws(()=>fence.recoverStaleWriterLocks({manifestId:'false'}),/recovery-selection-invalid/);
const journal=createTerminalJournal({directory:journalDirectory,manifest});
assert.throws(()=>fence.recoverStaleWriterLocks(),/current-owner/);journal.close();`);
  assert.equal(result.status, 0, result.stderr);
});

test('Linux job-partitioned recovery is independent of over4096 unrelated historical job directories', { skip: !linux }, t => {
  const directory = sandbox(t);
  const result = child(directory, `const fence=assertProductionFence({journalDirectory});
for(let index=0;index<4097;index++)fs.mkdirSync(path.join(journalDirectory,index.toString(16).padStart(64,'0')),{mode:0o700});
const jobBindingId='f'.repeat(64),jobDirectory=fence.prepareJobJournal({jobBindingId});
assert.equal(jobDirectory,path.join(journalDirectory,jobBindingId));
assert.equal(fs.statSync(jobDirectory).mode&0o7777,0o700);
assert.equal(fence.recoverStaleWriterLocks({jobBindingId}).recoveredCount,0);
assert.equal(fence.prepareJobJournal({jobBindingId}),jobDirectory);
assert.throws(()=>fence.recoverStaleWriterLocks({jobBindingId:'e'.repeat(64)}),/job-journal-not-prepared/);
let hooks=0;const invalidGetter={};Object.defineProperty(invalidGetter,'jobBindingId',{get(){hooks++;return jobBindingId}});
for(const invalid of [null,false,{jobBindingId:false},{jobBindingId:'false'},{jobBindingId,trust:true},invalidGetter])
  assert.throws(()=>fence.prepareJobJournal(invalid),/job-binding-invalid/);
assert.equal(hooks,0);`);
  assert.equal(result.status, 0, result.stderr);
});

test('Linux held descriptor/path inode and permissions are rechecked before any recovery', { skip: !linux }, t => {
  const directory = sandbox(t);
  const result = child(directory, `const fence=assertProductionFence({journalDirectory});
fs.renameSync(path.join(directory,'worker.flock'),path.join(directory,'old.flock'));
fs.writeFileSync(path.join(directory,'worker.flock'),'',{mode:0o600,flag:'wx'});
assert.throws(()=>fence.assertHeld(),/regular-file-drift/);
assert.throws(()=>fence.recoverStaleWriterLocks(),/regular-file-drift/);`);
  assert.equal(result.status, 0, result.stderr);
});

test('Linux releasing the inherited flock descriptor invalidates recovery authority immediately', { skip: !linux }, t => {
  const directory = sandbox(t);
  const result = child(directory, `const fence=assertProductionFence({journalDirectory});
for(const name of fs.readdirSync('/proc/self/fd')){
  let text;try{text=fs.readFileSync('/proc/self/fdinfo/'+name,'utf8')}catch{continue}
  if(text.includes('FLOCK')&&text.includes('WRITE'))fs.closeSync(Number(name));
}
assert.throws(()=>fence.assertHeld(),/exclusive-own-kernel-lock-required/);
assert.throws(()=>fence.recoverStaleWriterLocks(),/exclusive-own-kernel-lock-required/);`);
  assert.equal(result.status, 0, result.stderr);
});

test('Linux recovery rejects malformed lock, wrong manifest and symlink targets without a partial rename', { skip: !linux }, t => {
  const directory = sandbox(t);
  const result = child(directory, `const fence=assertProductionFence({journalDirectory});
const journal=createTerminalJournal({directory:journalDirectory,manifest}),id=journal.manifestId;
const cohort=path.join(journalDirectory,id),lockPath=path.join(cohort,'writer.lock');journal.close();
const original={manifestId:id,pid:process.pid+1,schema:'long-bot-terminal-journal-v1',token:'a'.repeat(64),uid:process.getuid()};
const canonical=value=>'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+JSON.stringify(value[key])).join(',')+'}';
for(const changes of [{pid:String(process.pid+1)},{uid:String(process.getuid())},{token:false},{manifestId:'b'.repeat(64)},{complete:true}]){
  fs.writeFileSync(lockPath,canonical({...original,...changes}),{mode:0o600});
  assert.throws(()=>fence.recoverStaleWriterLocks(),/recovery-lock-invalid/);assert.equal(fs.existsSync(lockPath),true);
}
fs.unlinkSync(lockPath);const victim=path.join(directory,'victim');fs.writeFileSync(victim,'untouched',{mode:0o600});
fs.symlinkSync(victim,lockPath);assert.throws(()=>fence.recoverStaleWriterLocks(),/regular-file-drift/);
assert.equal(fs.readFileSync(victim,'utf8'),'untouched');assert.equal(fs.existsSync(path.join(directory,'recovery')),false);`);
  assert.equal(result.status, 0, result.stderr);
});
