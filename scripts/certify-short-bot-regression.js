const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const buildShortBotEngine = require('./build-short-bot-engine');
const {
  RUNTIME_FILES,
  diceStreamSeeds,
  fileFingerprint,
  fingerprintNamedBuffers,
  loadRuntime,
  parseCliTokens,
  readHarnessSnapshot,
  readRuntimeSnapshot,
  validateDerivedStreamSeeds,
} = require('./simulate-short-bot-regression');

const ROOT = path.join(__dirname, '..');
const SIMULATOR = path.join(__dirname, 'simulate-short-bot-regression.js');
const UINT32_MAX = 0xffffffff;
const MAX_TIMEOUT_MS = 0x7fffffff;
const DEFAULT_SEED_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_JOBS = 5;
const MAX_JOBS = 5;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const CHILD_KILL_GRACE_MS = 1000;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const FAMILY_ERROR_RATE = 0.05;
const PER_BOUND_ERROR_RATE = FAMILY_ERROR_RATE / 2;
const BONFERRONI_ONE_SIDED_Z = 1.959963984540054;
const VALUE_OPTIONS = new Set(['output', 'checkpoint-dir', 'jobs', 'seed-timeout-ms']);
const FLAG_OPTIONS = new Set();

const OFFICIAL_SUITE = Object.freeze({
  id: 'short-heldout-v2-drand-6418748',
  derivation: 'first non-zero uint32be from SHA-256("nardu-short-bot/certification-v2\\0" + engineCommit + "\\0" + round + "\\0" + randomness + "\\0" + index + "\\0" + counter)',
  engineCommit: 'd7ff86f7569648a7cf0c5dd0ed7a93eba58d8e4b',
  beacon: Object.freeze({
    network: 'drand-mainnet',
    round: 6418748,
    randomness: '6d75fb90fa2fadaf78fc220836fe3b20af76906ed135b5e4a80f22727fd03c0c',
    signature: 'b627331bea8501602e647c843b0b698129550bbb4fdb159d98011c57e1f5275789dc6a22b854b2dcb53faabfbc2060081903cf6734090e4506beddc404c819089dc7dd5a00e94a73d0d3925984a54e5bb2a4c59bb4524a868ef5eaa22cc05b34',
  }),
  seeds: Object.freeze([2729353550, 1335326699, 513081538, 3238188421, 2278980036]),
  gamesPerSeed: 20,
});
const OFFICIAL_SUITE_FINGERPRINT = 'sha256:2df4acfe4e9661326a60d9a3bca7539cabd7a6e251bfd25ae56119e8a1b7d377';
const OFFICIAL_CRITERIA = Object.freeze({ minWinRate: 0.67, maxSevereLossRate: 0.1 });
const CHILD_OPTIONS = Object.freeze({
  games: OFFICIAL_SUITE.gamesPerSeed,
  botCandidates: 48,
  botAnalyze: 6,
  botReplyLimit: 12,
  maxPlies: 500,
  minWinRate: 0,
  maxSevereLossRate: 1,
  trace: false,
});
const FROZEN_BUILDER_BYTES = Buffer.from(
  "module.exports = function buildFrozenShortBotEngine() {};\n",
);
const OFFICIAL_EXECUTION_TOKEN = Symbol('official-short-certification');
const ENGINE_PINNED_FILES = Object.freeze([
  'game.js',
  'game-controller.js',
  'short-bot-engine.js',
  'short-bot-wildbg-client.js',
  'short-bot-wildbg-worker.js',
  'strong-bot.js',
  'bot.js',
  'vendor/wildbg/wildbg_wasm.js',
  'vendor/wildbg/wildbg_wasm_browser.js',
  'vendor/wildbg/wildbg_wasm_bg.wasm',
  'room.html',
  'bot-engine/short/metrics.ts',
  'bot-engine/short/engine.ts',
  'bot-engine/short/nardu-game-adapter.ts',
  'bot-engine/short/browser.ts',
  'scripts/build-short-bot-engine.js',
  'scripts/build-github-pages.js',
  'scripts/simulate-short-bot-regression.js',
  'server.js',
]);
const PROVENANCE_TRACKED_FILES = Object.freeze([
  ...ENGINE_PINNED_FILES,
  'scripts/certify-short-bot-regression.js',
]);

function assertCondition(condition, message) {
  if (!condition) throw new Error(`Invalid short certification payload: ${message}`);
}

function assertInteger(value, message, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  assertCondition(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    message,
  );
}

function assertClose(actual, expected, message) {
  assertCondition(
    Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-12,
    `${message} (expected ${expected}, received ${actual})`,
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deriveOfficialSeeds(engineCommit, round, randomness, count) {
  if (!GIT_COMMIT_PATTERN.test(engineCommit)) {
    throw new Error('Official seed derivation requires a canonical lowercase Git commit');
  }
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new Error('Official seed derivation requires a positive drand round');
  }
  if (!/^[0-9a-f]{64}$/.test(randomness)) {
    throw new Error('Official seed derivation requires 32-byte lowercase randomness');
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) {
    throw new Error('Official seed derivation count must be from 1 to 10000');
  }
  return Array.from({ length: count }, (_, index) => {
    for (let counter = 0; counter <= UINT32_MAX; counter += 1) {
      const digest = createHash('sha256')
        .update('nardu-short-bot/certification-v2\0')
        .update(engineCommit).update('\0')
        .update(String(round)).update('\0')
        .update(randomness).update('\0')
        .update(String(index)).update('\0')
        .update(String(counter)).digest();
      const seed = digest.readUInt32BE(0);
      if (seed !== 0) return seed;
    }
    throw new Error(`Could not derive a non-zero seed at index ${index}`);
  });
}

function validateDrandMainnetBeacon(beacon) {
  if (!beacon || beacon.network !== 'drand-mainnet') {
    throw new Error('Official beacon must use drand mainnet');
  }
  if (!Number.isSafeInteger(beacon.round) || beacon.round < 1) {
    throw new Error('Official drand beacon has an invalid round');
  }
  if (!/^[0-9a-f]{192}$/.test(beacon.signature || '')) {
    throw new Error('Official drand beacon has an invalid 96-byte signature');
  }
  if (!/^[0-9a-f]{64}$/.test(beacon.randomness || '')) {
    throw new Error('Official drand beacon has invalid randomness');
  }
  const derivedRandomness = createHash('sha256')
    .update(Buffer.from(beacon.signature, 'hex'))
    .digest('hex');
  if (derivedRandomness !== beacon.randomness) {
    throw new Error('Official drand randomness does not match SHA-256(signature)');
  }
  return true;
}

function validateOfficialSuite() {
  if (!GIT_COMMIT_PATTERN.test(OFFICIAL_SUITE.engineCommit)) {
    throw new Error('Official suite has an invalid engine commit');
  }
  validateDrandMainnetBeacon(OFFICIAL_SUITE.beacon);
  const derivedSeeds = deriveOfficialSeeds(
    OFFICIAL_SUITE.engineCommit,
    OFFICIAL_SUITE.beacon.round,
    OFFICIAL_SUITE.beacon.randomness,
    OFFICIAL_SUITE.seeds.length,
  );
  if (canonicalJson(derivedSeeds) !== canonicalJson([...OFFICIAL_SUITE.seeds])) {
    throw new Error('Official suite seeds do not match the declared beacon derivation');
  }
  if (new Set(derivedSeeds).size !== derivedSeeds.length) {
    throw new Error('Official suite contains duplicate derived seeds');
  }
  if (officialSuiteFingerprint() !== OFFICIAL_SUITE_FINGERPRINT) {
    throw new Error('Official held-out suite fingerprint does not match its frozen declaration');
  }
  return true;
}

function positiveIntegerOption(parsed, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!parsed.values.has(name)) return fallback;
  const raw = parsed.values.get(name);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`--${name} must be a positive integer not greater than ${maximum}`);
  }
  return value;
}

function requiredPathOption(parsed, name) {
  if (!parsed.values.has(name)) throw new Error(`--${name} is required`);
  const value = parsed.values.get(name).trim();
  if (!value) throw new Error(`--${name} must not be empty`);
  return path.resolve(value);
}

function officialSuiteFingerprint() {
  const serialized = JSON.stringify({
    id: OFFICIAL_SUITE.id,
    derivation: OFFICIAL_SUITE.derivation,
    engineCommit: OFFICIAL_SUITE.engineCommit,
    beacon: OFFICIAL_SUITE.beacon,
    seeds: [...OFFICIAL_SUITE.seeds],
    gamesPerSeed: OFFICIAL_SUITE.gamesPerSeed,
  });
  return fingerprintNamedBuffers([['suite.json', Buffer.from(serialized)]]);
}

function parseCertificationOptions(argv) {
  const parsed = parseCliTokens(argv, VALUE_OPTIONS, FLAG_OPTIONS);
  const jobs = positiveIntegerOption(parsed, 'jobs', DEFAULT_JOBS, MAX_JOBS);
  const output = requiredPathOption(parsed, 'output');
  const checkpointDirectory = requiredPathOption(parsed, 'checkpoint-dir');
  const relativeOutput = path.relative(checkpointDirectory, output);
  if (!relativeOutput || (!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput))) {
    throw new Error('--output must be outside --checkpoint-dir');
  }
  return {
    output,
    checkpointDirectory,
    jobs,
    seedTimeoutMs: positiveIntegerOption(
      parsed,
      'seed-timeout-ms',
      DEFAULT_SEED_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
  };
}

function syncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function ensureRealDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Path is not a real directory: ${directory}`);
  }
}

function assertDestinationAbsent(file) {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing output: ${file}`);
}

function persistJsonAtomicNoOverwrite(destination, payload) {
  const target = path.resolve(destination);
  const directory = path.dirname(target);
  ensureRealDirectory(directory);
  assertDestinationAbsent(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${process.hrtime.bigint()}.tmp`,
  );
  let descriptor = null;
  let installed = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.linkSync(temporary, target);
    installed = true;
    fs.unlinkSync(temporary);
    syncDirectory(directory);
    return target;
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing output: ${target}`);
    }
    throw new Error(`Could not publish ${target}: ${error.message}`);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (installed && !fs.existsSync(target)) {
      throw new Error(`Atomic publication failed for ${target}`);
    }
  }
}

function rawFileFingerprint(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function runGitCommand(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`Could not establish official Git provenance: ${detail}`);
  }
}

function readGitProvenance(root = ROOT, dependencies = {}) {
  const runGit = dependencies.runGit || (args => runGitCommand(root, args));
  const gitRoot = fs.realpathSync(runGit(['rev-parse', '--show-toplevel']));
  if (gitRoot !== fs.realpathSync(root)) {
    throw new Error(`Official certification root is not the Git worktree root: ${root}`);
  }
  const gitCommit = runGit(['rev-parse', '--verify', 'HEAD']).toLowerCase();
  if (!GIT_COMMIT_PATTERN.test(gitCommit)) {
    throw new Error(`Official certification received an invalid Git HEAD: ${gitCommit}`);
  }
  const trackedStatus = runGit(['status', '--porcelain=v1', '--untracked-files=no']);
  if (trackedStatus) {
    throw new Error('Official short certification requires a clean tracked Git worktree');
  }
  const engineCommit = OFFICIAL_SUITE.engineCommit;
  if (!GIT_COMMIT_PATTERN.test(engineCommit)) {
    throw new Error(`Official certification has an invalid engine commit: ${engineCommit}`);
  }
  let resolvedEngineCommit;
  try {
    resolvedEngineCommit = runGit([
      'rev-parse', '--verify', `${engineCommit}^{commit}`,
    ]).toLowerCase();
  } catch (error) {
    throw new Error(`Official engine commit cannot be resolved: ${error.message}`);
  }
  if (resolvedEngineCommit !== engineCommit) {
    throw new Error(`Official engine commit resolved unexpectedly: ${resolvedEngineCommit}`);
  }
  try {
    runGit(['merge-base', '--is-ancestor', engineCommit, 'HEAD']);
  } catch (error) {
    throw new Error(`Official engine commit is not an ancestor of HEAD: ${error.message}`);
  }
  runGit(['ls-files', '--error-unmatch', '--', ...PROVENANCE_TRACKED_FILES]);
  for (const file of PROVENANCE_TRACKED_FILES) {
    const committedBlob = runGit(['rev-parse', `HEAD:${file}`]);
    const workingBlob = runGit(['hash-object', `--path=${file}`, file]);
    if (committedBlob !== workingBlob) {
      throw new Error(`Official certification file does not match Git HEAD: ${file}`);
    }
  }
  for (const file of ENGINE_PINNED_FILES) {
    const engineBlob = runGit(['rev-parse', `${engineCommit}:${file}`]);
    const headBlob = runGit(['rev-parse', `HEAD:${file}`]);
    if (engineBlob !== headBlob) {
      throw new Error(`Official engine-pinned file differs from ${engineCommit}: ${file}`);
    }
  }
  return {
    gitCommit,
    engineCommit,
    gitTreeClean: true,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

function diagnosticProvenance(value = {}) {
  return {
    gitCommit: typeof value.gitCommit === 'string' ? value.gitCommit : 'diagnostic-unverified',
    engineCommit: typeof value.engineCommit === 'string'
      ? value.engineCommit
      : 'diagnostic-unverified',
    gitTreeClean: value.gitTreeClean === true,
    nodeVersion: typeof value.nodeVersion === 'string' ? value.nodeVersion : process.version,
    platform: typeof value.platform === 'string' ? value.platform : process.platform,
    arch: typeof value.arch === 'string' ? value.arch : process.arch,
  };
}

function assertSameOfficialProvenance(before, after) {
  assertCondition(
    canonicalJson(before) === canonicalJson(after),
    'official Git provenance changed during certification',
  );
  assertCondition(before.gitTreeClean === true, 'official Git worktree is not clean');
  assertCondition(GIT_COMMIT_PATTERN.test(before.gitCommit), 'official Git commit is invalid');
  assertCondition(before.engineCommit === OFFICIAL_SUITE.engineCommit,
    'official engine commit is not the frozen suite commit');
}

function checkpointFilename(seed) {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > UINT32_MAX) {
    throw new Error('Checkpoint seed must be a positive 32-bit integer');
  }
  return `seed-${seed}.json`;
}

function checkpointPath(checkpointDirectory, seed) {
  return path.join(checkpointDirectory, checkpointFilename(seed));
}

function ensureCheckpointDirectory(checkpointDirectory) {
  ensureRealDirectory(checkpointDirectory);
  const expected = new Set(OFFICIAL_SUITE.seeds.map(checkpointFilename));
  const unexpected = fs.readdirSync(checkpointDirectory).filter(name => !expected.has(name));
  if (unexpected.length) {
    throw new Error(`Checkpoint directory contains unexpected entries: ${unexpected.join(', ')}`);
  }
}

function validateArtifactLocations(output, checkpointDirectory) {
  ensureCheckpointDirectory(checkpointDirectory);
  ensureRealDirectory(path.dirname(output));
  const realCheckpointDirectory = fs.realpathSync(checkpointDirectory);
  const realOutput = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  const relativeOutput = path.relative(realCheckpointDirectory, realOutput);
  if (!relativeOutput || (!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput))) {
    throw new Error('--output must resolve outside --checkpoint-dir');
  }
}

function persistCheckpointAtomic(checkpointDirectory, seed, payload) {
  ensureCheckpointDirectory(checkpointDirectory);
  return persistJsonAtomicNoOverwrite(checkpointPath(checkpointDirectory, seed), payload);
}

function writeFrozenFile(file, bytes) {
  const descriptor = fs.openSync(file, 'wx', 0o400);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function createFrozenBundle(runtimeSnapshot, harnessSnapshot, dependencies = {}) {
  assertCondition(
    runtimeSnapshot?.entries?.length === RUNTIME_FILES.length,
    'frozen runtime snapshot is incomplete',
  );
  assertCondition(Buffer.isBuffer(harnessSnapshot?.bytes), 'frozen simulator snapshot has no bytes');
  const tempRoot = dependencies.tempRoot || os.tmpdir();
  const root = fs.mkdtempSync(path.join(tempRoot, 'short-bot-cert-bundle-'));
  const scriptsDirectory = path.join(root, 'scripts');
  const vendorDirectory = path.join(root, 'vendor');
  const wildbgDirectory = path.join(vendorDirectory, 'wildbg');
  fs.mkdirSync(scriptsDirectory);
  fs.mkdirSync(wildbgDirectory, { recursive: true });
  const entries = new Map(runtimeSnapshot.entries);
  const simulator = path.join(scriptsDirectory, 'simulate-short-bot-regression.js');
  const builder = path.join(scriptsDirectory, 'build-short-bot-engine.js');
  try {
    for (const file of RUNTIME_FILES) {
      assertCondition(Buffer.isBuffer(entries.get(file)), `frozen runtime is missing ${file}`);
      writeFrozenFile(path.join(root, file), entries.get(file));
    }
    writeFrozenFile(simulator, harnessSnapshot.bytes);
    writeFrozenFile(builder, FROZEN_BUILDER_BYTES);
    const bundleEntries = [
      ...RUNTIME_FILES.map(file => [file, entries.get(file)]),
      ['scripts/simulate-short-bot-regression.js', harnessSnapshot.bytes],
      ['scripts/build-short-bot-engine.js', FROZEN_BUILDER_BYTES],
    ];
    fs.chmodSync(scriptsDirectory, 0o500);
    fs.chmodSync(wildbgDirectory, 0o500);
    fs.chmodSync(vendorDirectory, 0o500);
    fs.chmodSync(root, 0o500);
    const frozenRuntime = readRuntimeSnapshot(root);
    assertCondition(
      frozenRuntime.fingerprint === runtimeSnapshot.fingerprint,
      'frozen runtime fingerprint changed while publishing the bundle',
    );
    assertCondition(
      fileFingerprint(simulator) === harnessSnapshot.fingerprint,
      'frozen simulator fingerprint changed while publishing the bundle',
    );
    return {
      root,
      simulator,
      runtimeFingerprint: frozenRuntime.fingerprint,
      simulatorHarnessFingerprint: harnessSnapshot.fingerprint,
      bundleFingerprint: fingerprintNamedBuffers(bundleEntries),
    };
  } catch (error) {
    removeFrozenBundle({ root });
    throw error;
  }
}

function removeFrozenBundle(bundle) {
  if (!bundle?.root || !fs.existsSync(bundle.root)) return;
  try {
    fs.chmodSync(bundle.root, 0o700);
    const scriptsDirectory = path.join(bundle.root, 'scripts');
    const vendorDirectory = path.join(bundle.root, 'vendor');
    const wildbgDirectory = path.join(vendorDirectory, 'wildbg');
    if (fs.existsSync(scriptsDirectory)) fs.chmodSync(scriptsDirectory, 0o700);
    if (fs.existsSync(vendorDirectory)) fs.chmodSync(vendorDirectory, 0o700);
    if (fs.existsSync(wildbgDirectory)) fs.chmodSync(wildbgDirectory, 0o700);
  } catch {}
  fs.rmSync(bundle.root, { recursive: true, force: true });
}

function currentExecutionIdentity(runtimeSnapshot, harnessSnapshot) {
  const runtime = loadRuntime(runtimeSnapshot);
  return {
    engineVersion: runtime.engine.version,
    opponent: 'legacy-short-hard',
    runtimeFingerprint: runtime.runtimeFingerprint,
    simulatorHarnessFingerprint: harnessSnapshot.fingerprint,
    wildbg: { ...runtime.wildbg },
    experience: { ...runtime.experience },
  };
}

function comparableOptions(options) {
  const comparable = { ...options };
  delete comparable.seed;
  delete comparable.output;
  return comparable;
}

function expectedSimulatorOptions(seed, output = '') {
  return {
    games: CHILD_OPTIONS.games,
    seed,
    botCandidates: CHILD_OPTIONS.botCandidates,
    botAnalyze: CHILD_OPTIONS.botAnalyze,
    botReplyLimit: CHILD_OPTIONS.botReplyLimit,
    maxPlies: CHILD_OPTIONS.maxPlies,
    minWinRate: CHILD_OPTIONS.minWinRate,
    maxSevereLossRate: CHILD_OPTIONS.maxSevereLossRate,
    output,
    trace: CHILD_OPTIONS.trace,
  };
}

function validateSeedPayload(payload, seed, expectedIdentity) {
  assertCondition(payload && typeof payload === 'object', `seed ${seed} has no payload object`);
  const { summary, results } = payload;
  assertCondition(summary && typeof summary === 'object', `seed ${seed} has no summary object`);
  assertCondition(Array.isArray(results), `seed ${seed} has no results array`);
  assertCondition(summary.games === OFFICIAL_SUITE.gamesPerSeed, `seed ${seed} summary.games mismatch`);
  assertCondition(summary.pairs === OFFICIAL_SUITE.gamesPerSeed / 2, `seed ${seed} summary.pairs mismatch`);
  assertCondition(results.length === OFFICIAL_SUITE.gamesPerSeed, `seed ${seed} results length mismatch`);
  assertCondition(summary.engineVersion === expectedIdentity.engineVersion,
    `seed ${seed} engine version does not match frozen runtime`);
  assertCondition(summary.opponent === expectedIdentity.opponent, `seed ${seed} opponent mismatch`);
  for (const field of ['runtimeFingerprint', 'simulatorHarnessFingerprint']) {
    assertCondition(SHA256_PATTERN.test(summary[field]), `seed ${seed} has invalid ${field}`);
    assertCondition(summary[field] === expectedIdentity[field],
      `seed ${seed} ${field} does not match frozen execution identity`);
  }
  assertCondition(summary.wildbg && typeof summary.wildbg === 'object',
    `seed ${seed} has no WildBG identity`);
  assertCondition(
    canonicalJson(summary.wildbg) === canonicalJson(expectedIdentity.wildbg),
    `seed ${seed} WildBG identity mismatch`,
  );
  assertCondition(SHA256_PATTERN.test(summary.wildbg.assetFingerprint),
    `seed ${seed} has invalid WildBG asset fingerprint`);
  assertCondition(typeof summary.wildbg.version === 'string' && summary.wildbg.version.length > 0,
    `seed ${seed} has invalid WildBG version`);
  assertCondition(typeof summary.wildbg.revision === 'string' && summary.wildbg.revision.length > 0,
    `seed ${seed} has invalid WildBG revision`);
  assertCondition(summary.experience && typeof summary.experience === 'object',
    `seed ${seed} has no experience identity`);
  assertCondition(
    canonicalJson(summary.experience) === canonicalJson(expectedIdentity.experience),
    `seed ${seed} experience identity mismatch`,
  );
  assertCondition(summary.experience.mode === 'cold-empty', `seed ${seed} is not cold-empty`);
  assertCondition(summary.experience.patternCount === 0, `seed ${seed} loaded experience patterns`);
  assertCondition(SHA256_PATTERN.test(summary.experience.fingerprint),
    `seed ${seed} has invalid experience fingerprint`);
  assertCondition(summary.options && typeof summary.options === 'object',
    `seed ${seed} has no options object`);
  assertCondition(summary.options.seed === seed, `seed ${seed} options.seed mismatch`);
  assertCondition(typeof summary.options.output === 'string' && summary.options.output.length > 0,
    `seed ${seed} has no child output path`);
  const expectedComparable = comparableOptions(expectedSimulatorOptions(seed));
  assertCondition(
    canonicalJson(comparableOptions(summary.options)) === canonicalJson(expectedComparable),
    `seed ${seed} simulator options differ from official production options`,
  );

  const pairCount = OFFICIAL_SUITE.gamesPerSeed / 2;
  const pairs = new Map();
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    assertCondition(result && typeof result === 'object', `seed ${seed} result ${index + 1} is invalid`);
    assertInteger(result.game, `seed ${seed} result has invalid game number`, 1);
    assertCondition(result.game === index + 1, `seed ${seed} results are not in canonical game order`);
    assertInteger(result.pair, `seed ${seed} result has invalid pair number`, 1, pairCount);
    assertInteger(result.leg, `seed ${seed} result has invalid leg number`, 1, 2);
    assertCondition(result.game === (result.pair - 1) * 2 + result.leg,
      `seed ${seed} pair ${result.pair} leg ${result.leg} has wrong game number`);
    const expectedBotColor = result.leg === 1 ? 'white' : 'dark';
    assertCondition(result.botColor === expectedBotColor,
      `seed ${seed} pair ${result.pair} leg ${result.leg} has wrong bot color`);
    assertCondition(result.controlColor === (expectedBotColor === 'white' ? 'dark' : 'white'),
      `seed ${seed} pair ${result.pair} leg ${result.leg} has wrong control color`);
    assertCondition(result.winner === 'white' || result.winner === 'dark',
      `seed ${seed} pair ${result.pair} has invalid winner`);
    assertCondition(typeof result.botWon === 'boolean',
      `seed ${seed} pair ${result.pair} has invalid botWon`);
    assertCondition(result.botWon === (result.winner === result.botColor),
      `seed ${seed} pair ${result.pair} botWon contradicts winner`);
    assertCondition(['normal', 'mars', 'koks'].includes(result.resultType),
      `seed ${seed} pair ${result.pair} has invalid result type`);
    assertInteger(result.plies, `seed ${seed} pair ${result.pair} has invalid plies`, 1, CHILD_OPTIONS.maxPlies);
    for (const field of ['botRolls', 'controlRolls', 'botDoubles', 'controlDoubles']) {
      assertInteger(result[field], `seed ${seed} pair ${result.pair} has invalid ${field}`);
    }
    assertCondition(result.botDoubles <= result.botRolls,
      `seed ${seed} pair ${result.pair} has more bot doubles than rolls`);
    assertCondition(result.controlDoubles <= result.controlRolls,
      `seed ${seed} pair ${result.pair} has more control doubles than rolls`);
    assertCondition(result.off && typeof result.off === 'object',
      `seed ${seed} pair ${result.pair} has invalid off counts`);
    for (const color of ['white', 'dark']) {
      assertInteger(result.off[color], `seed ${seed} pair ${result.pair} has invalid ${color} off`, 0, 15);
    }
    const loser = result.winner === 'white' ? 'dark' : 'white';
    assertCondition(result.off[result.winner] === 15,
      `seed ${seed} pair ${result.pair} winner has not borne off 15 checkers`);
    assertCondition(
      result.resultType === 'normal' ? result.off[loser] > 0 : result.off[loser] === 0,
      `seed ${seed} pair ${result.pair} result type contradicts loser off count`,
    );
    assertCondition(!Object.prototype.hasOwnProperty.call(result, 'decisions'),
      `seed ${seed} pair ${result.pair} unexpectedly contains trace decisions`);
    const expectedSeeds = diceStreamSeeds(seed, result.pair - 1);
    assertCondition(canonicalJson(result.streamSeeds) === canonicalJson(expectedSeeds),
      `seed ${seed} pair ${result.pair} has wrong derived stream seeds`);
    const pair = pairs.get(result.pair) || [];
    pair.push(result);
    pairs.set(result.pair, pair);
  }
  for (let pairNumber = 1; pairNumber <= pairCount; pairNumber += 1) {
    const pair = pairs.get(pairNumber) || [];
    assertCondition(pair.length === 2, `seed ${seed} pair ${pairNumber} is incomplete`);
    assertCondition(pair[0].leg === 1 && pair[1].leg === 2,
      `seed ${seed} pair ${pairNumber} must contain legs 1 and 2`);
    assertCondition(canonicalJson(pair[0].streamSeeds) === canonicalJson(pair[1].streamSeeds),
      `seed ${seed} pair ${pairNumber} does not reuse identical physical streams`);
  }

  const botWins = results.filter(result => result.botWon).length;
  const severeBotLosses = results.filter(
    result => !result.botWon && result.resultType !== 'normal',
  ).length;
  const botRolls = results.reduce((sum, result) => sum + result.botRolls, 0);
  const controlRolls = results.reduce((sum, result) => sum + result.controlRolls, 0);
  const botDoubles = results.reduce((sum, result) => sum + result.botDoubles, 0);
  const controlDoubles = results.reduce((sum, result) => sum + result.controlDoubles, 0);
  const plies = results.reduce((sum, result) => sum + result.plies, 0);
  const pairValues = [...pairs.values()];
  const expectedSummary = {
    botWins,
    controlWins: results.length - botWins,
    severeBotLosses,
    pairSweeps: pairValues.filter(pair => pair.every(result => result.botWon)).length,
    pairSplits: pairValues.filter(pair => pair.filter(result => result.botWon).length === 1).length,
    pairLosses: pairValues.filter(pair => pair.every(result => !result.botWon)).length,
    botRolls,
    controlRolls,
    botDoubles,
    controlDoubles,
  };
  for (const [field, expected] of Object.entries(expectedSummary)) {
    assertCondition(summary[field] === expected,
      `seed ${seed} summary.${field} mismatch (expected ${expected}, received ${summary[field]})`);
  }
  assertClose(summary.averagePlies, plies / results.length, `seed ${seed} averagePlies mismatch`);
  assertClose(summary.winRate, botWins / results.length, `seed ${seed} winRate mismatch`);
  assertClose(summary.severeLossRate, severeBotLosses / results.length,
    `seed ${seed} severeLossRate mismatch`);
  assertClose(summary.botDoubleRate, botRolls ? botDoubles / botRolls : 0,
    `seed ${seed} botDoubleRate mismatch`);
  assertClose(summary.controlDoubleRate, controlRolls ? controlDoubles / controlRolls : 0,
    `seed ${seed} controlDoubleRate mismatch`);
  assertClose(summary.doubleRateDifference,
    (botRolls ? botDoubles / botRolls : 0) - (controlRolls ? controlDoubles / controlRolls : 0),
    `seed ${seed} doubleRateDifference mismatch`);
  assertCondition(summary.passed === true, `seed ${seed} neutral child gate did not pass`);
  assertCondition(
    expectedSummary.pairSweeps + expectedSummary.pairSplits + expectedSummary.pairLosses === pairCount,
    `seed ${seed} pair accounting mismatch`,
  );
  assertCondition(botWins === expectedSummary.pairSweeps * 2 + expectedSummary.pairSplits,
    `seed ${seed} wins contradict pair accounting`);
  return {
    engineVersion: summary.engineVersion,
    runtimeFingerprint: summary.runtimeFingerprint,
    simulatorHarnessFingerprint: summary.simulatorHarnessFingerprint,
    wildbg: { ...summary.wildbg },
    experience: { ...summary.experience },
    comparableOptions: comparableOptions(summary.options),
  };
}

function validateSeedRecords(seedRecords, expectedIdentity) {
  assertCondition(Array.isArray(seedRecords), 'certification seed records are missing');
  assertCondition(seedRecords.length === OFFICIAL_SUITE.seeds.length,
    `certification must contain exactly ${OFFICIAL_SUITE.seeds.length} seeds`);
  assertCondition(
    canonicalJson(seedRecords.map(record => record.seed)) === canonicalJson([...OFFICIAL_SUITE.seeds]),
    'certification seeds or seed order differ from the official held-out suite',
  );
  for (const record of seedRecords) {
    assertCondition(SHA256_PATTERN.test(record.checkpointFingerprint),
      `seed ${record.seed} has invalid checkpoint fingerprint`);
    assertCondition(typeof record.reused === 'boolean',
      `seed ${record.seed} has invalid checkpoint reuse status`);
  }
  const metadata = seedRecords.map(record => validateSeedPayload(
    record.payload,
    record.seed,
    expectedIdentity,
  ));
  const baseline = metadata[0];
  for (const current of metadata.slice(1)) {
    for (const field of ['engineVersion', 'runtimeFingerprint', 'simulatorHarnessFingerprint']) {
      assertCondition(current[field] === baseline[field], `seed payloads do not share one ${field}`);
    }
    assertCondition(canonicalJson(current.experience) === canonicalJson(baseline.experience),
      'seed payloads do not share one experience identity');
    assertCondition(canonicalJson(current.wildbg) === canonicalJson(baseline.wildbg),
      'seed payloads do not share one WildBG identity');
    assertCondition(canonicalJson(current.comparableOptions) === canonicalJson(baseline.comparableOptions),
      'seed payloads do not share identical simulator options');
  }
  return baseline;
}

function loadCheckpoint(checkpointDirectory, seed, expectedIdentity) {
  const file = checkpointPath(checkpointDirectory, seed);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not inspect checkpoint for seed ${seed}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Checkpoint for seed ${seed} is stale or invalid: not a regular file`);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateSeedPayload(payload, seed, expectedIdentity);
  } catch (error) {
    throw new Error(`Checkpoint for seed ${seed} is stale or invalid: ${error.message}`);
  }
  return {
    seed,
    payload,
    checkpointFingerprint: fileFingerprint(file),
    reused: true,
  };
}

function loadCheckpointSet(checkpointDirectory, expectedIdentity) {
  ensureCheckpointDirectory(checkpointDirectory);
  const records = new Map();
  for (const seed of OFFICIAL_SUITE.seeds) {
    const record = loadCheckpoint(checkpointDirectory, seed, expectedIdentity);
    if (record) records.set(seed, record);
  }
  return records;
}

function assertFreshOfficialCheckpointSet(preloadedCheckpoints) {
  if (!(preloadedCheckpoints instanceof Map) || preloadedCheckpoints.size > 0) {
    throw new Error(
      'Official short certification requires an empty checkpoint directory and a fresh execution',
    );
  }
}

function collectChildResult(child, timeoutMs) {
  return new Promise(resolve => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let childError = null;
    let terminationError = null;
    let killTimer = null;
    let settled = false;
    const terminate = error => {
      if (terminationError) return;
      terminationError = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), CHILD_KILL_GRACE_MS);
    };
    const capture = target => chunk => {
      if (terminationError) return;
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CHILD_OUTPUT_BYTES) {
        terminate(new Error(`child output exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes`));
        return;
      }
      target.push(chunk);
    };
    const timeoutTimer = setTimeout(() => terminate(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status,
        signal,
        error: terminationError || childError,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    };
    child.stdout.on('data', capture(stdoutChunks));
    child.stderr.on('data', capture(stderrChunks));
    child.once('error', error => {
      childError = error;
      if (!child.pid) finish(null, null);
    });
    child.once('close', finish);
  });
}

async function runSeed(seed, frozenBundle, timeoutMs, dependencies = {}) {
  const tempRoot = dependencies.tempRoot || os.tmpdir();
  const spawnProcess = dependencies.spawnProcess || spawn;
  const tempDirectory = fs.mkdtempSync(path.join(tempRoot, 'short-bot-cert-seed-'));
  const output = path.join(tempDirectory, 'result.json');
  const options = expectedSimulatorOptions(seed, output);
  const args = [
    frozenBundle.simulator,
    '--games', String(options.games),
    '--seed', String(seed),
    '--bot-candidates', String(options.botCandidates),
    '--bot-analyze', String(options.botAnalyze),
    '--bot-reply-limit', String(options.botReplyLimit),
    '--max-plies', String(options.maxPlies),
    '--min-win-rate', String(options.minWinRate),
    '--max-severe-loss-rate', String(options.maxSevereLossRate),
    '--output', output,
  ];
  try {
    const childProcess = spawnProcess(process.execPath, args, {
      cwd: frozenBundle.root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = await collectChildResult(childProcess, timeoutMs);
    let stat = null;
    try { stat = fs.lstatSync(output); } catch {}
    if (child.error || child.status !== 0 || !stat || !stat.isFile() || stat.isSymbolicLink()) {
      const detail = [
        child.error ? `${child.error.code || child.error.name}: ${child.error.message}` : '',
        child.status === null ? `terminated by ${child.signal || 'unknown signal'}` : '',
        child.stdout,
        child.stderr,
      ].filter(Boolean).join('\n').trim();
      throw new Error(`Seed ${seed} failed${detail ? `:\n${detail}` : ''}`);
    }
    if (stat.size > MAX_RESULT_BYTES) {
      throw new Error(`Seed ${seed} result exceeded ${MAX_RESULT_BYTES} bytes`);
    }
    try {
      return JSON.parse(fs.readFileSync(output, 'utf8'));
    } catch (error) {
      throw new Error(`Seed ${seed} produced invalid JSON: ${error.message}`);
    }
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function runSeedWithCheckpoint(
  seed,
  frozenBundle,
  timeoutMs,
  checkpointDirectory,
  expectedIdentity,
  dependencies = {},
) {
  const preloaded = dependencies.preloadedCheckpoints;
  if (preloaded instanceof Map && preloaded.has(seed)) return preloaded.get(seed);
  const seedRunner = dependencies.seedRunner || runSeed;
  const payload = await seedRunner(seed, frozenBundle, timeoutMs, dependencies.seedDependencies || {});
  validateSeedPayload(payload, seed, expectedIdentity);
  persistCheckpointAtomic(checkpointDirectory, seed, payload);
  const published = loadCheckpoint(checkpointDirectory, seed, expectedIdentity);
  assertCondition(
    canonicalJson(published.payload) === canonicalJson(payload),
    `seed ${seed} checkpoint changed between validation and publication`,
  );
  published.reused = false;
  return published;
}

async function runSeedsOrdered(seeds, jobs, runner, onComplete = () => {}) {
  if (!Array.isArray(seeds) || seeds.length === 0) throw new Error('At least one seed is required');
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > seeds.length) {
    throw new Error('Effective job count must be between 1 and the seed count');
  }
  const results = new Array(seeds.length);
  const completed = new Array(seeds.length).fill(false);
  let nextIndex = 0;
  let nextCompletionIndex = 0;
  let firstError = null;
  const flush = () => {
    while (completed[nextCompletionIndex]) {
      onComplete(results[nextCompletionIndex], seeds[nextCompletionIndex], nextCompletionIndex);
      nextCompletionIndex += 1;
    }
  };
  const worker = async () => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= seeds.length) return;
      try {
        results[index] = await runner(seeds[index], index);
        completed[index] = true;
        flush();
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function pairedScores(seedRecords) {
  return seedRecords.flatMap(record => Array.from(
    { length: OFFICIAL_SUITE.gamesPerSeed / 2 },
    (_, pairIndex) => {
      const pair = record.payload.results.filter(result => result.pair === pairIndex + 1);
      assertCondition(pair.length === 2, `seed ${record.seed} pair ${pairIndex + 1} is incomplete`);
      return {
        winRate: pair.filter(result => result.botWon).length / 2,
        severeLossRate: pair.filter(
          result => !result.botWon && result.resultType !== 'normal',
        ).length / 2,
      };
    },
  ));
}

function boundedMeanDiagnostics(values) {
  assertCondition(values.length > 0, 'confidence diagnostics have no paired observations');
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  const standardError = Math.sqrt(variance / values.length);
  const hoeffdingMargin = Math.sqrt(Math.log(1 / PER_BOUND_ERROR_RATE) / (2 * values.length));
  return {
    observations: values.length,
    mean,
    sampleVariance: variance,
    standardError,
    perBoundErrorRate: PER_BOUND_ERROR_RATE,
    normalLower95: Math.max(0, mean - BONFERRONI_ONE_SIDED_Z * standardError),
    normalUpper95: Math.min(1, mean + BONFERRONI_ONE_SIDED_Z * standardError),
    hoeffdingLower95: Math.max(0, mean - hoeffdingMargin),
    hoeffdingUpper95: Math.min(1, mean + hoeffdingMargin),
  };
}

function minimumPairsForConfidence(criteria = OFFICIAL_CRITERIA) {
  const headroom = Math.min(1 - criteria.minWinRate, criteria.maxSevereLossRate);
  return Math.ceil(Math.log(1 / PER_BOUND_ERROR_RATE) / (2 * headroom ** 2));
}

function aggregatePayloads(seedRecords, expectedIdentity) {
  validateSeedRecords(seedRecords, expectedIdentity);
  const summaries = seedRecords.map(record => record.payload.summary);
  const results = seedRecords.flatMap(record => record.payload.results);
  const pairValues = pairedScores(seedRecords);
  const games = results.length;
  const pairs = pairValues.length;
  assertCondition(games === 100, `official certification must aggregate 100 games, received ${games}`);
  assertCondition(pairs === 50, `official certification must aggregate 50 pairs, received ${pairs}`);
  const botWins = results.filter(result => result.botWon).length;
  const severeBotLosses = results.filter(
    result => !result.botWon && result.resultType !== 'normal',
  ).length;
  const botRolls = results.reduce((sum, result) => sum + result.botRolls, 0);
  const controlRolls = results.reduce((sum, result) => sum + result.controlRolls, 0);
  const botDoubles = results.reduce((sum, result) => sum + result.botDoubles, 0);
  const controlDoubles = results.reduce((sum, result) => sum + result.controlDoubles, 0);
  const pairSweeps = summaries.reduce((sum, summary) => sum + summary.pairSweeps, 0);
  const pairSplits = summaries.reduce((sum, summary) => sum + summary.pairSplits, 0);
  const pairLosses = summaries.reduce((sum, summary) => sum + summary.pairLosses, 0);
  assertCondition(pairSweeps + pairSplits + pairLosses === pairs, 'aggregate pair accounting mismatch');
  assertCondition(botWins === pairSweeps * 2 + pairSplits, 'aggregate wins contradict pair accounting');
  const winRate = botWins / games;
  const severeLossRate = severeBotLosses / games;
  const pairedWinConfidence95 = boundedMeanDiagnostics(pairValues.map(pair => pair.winRate));
  const pairedSevereLossConfidence95 = boundedMeanDiagnostics(
    pairValues.map(pair => pair.severeLossRate),
  );
  const observedPassed = botWins >= 67 && severeBotLosses <= 10;
  const confidencePassed = pairedWinConfidence95.hoeffdingLower95 >= OFFICIAL_CRITERIA.minWinRate
    && pairedSevereLossConfidence95.hoeffdingUpper95 <= OFFICIAL_CRITERIA.maxSevereLossRate;
  const streamSeeds = new Set();
  for (const seed of OFFICIAL_SUITE.seeds) {
    for (let pair = 0; pair < OFFICIAL_SUITE.gamesPerSeed / 2; pair += 1) {
      const derived = diceStreamSeeds(seed, pair);
      streamSeeds.add(derived.white);
      streamSeeds.add(derived.dark);
    }
  }
  assertCondition(streamSeeds.size === 100, 'official suite derived dice streams are not unique');
  return {
    seeds: seedRecords.length,
    games,
    pairs,
    botWins,
    controlWins: games - botWins,
    winRate,
    severeBotLosses,
    severeLossRate,
    pairSweeps,
    pairSplits,
    pairLosses,
    botRolls,
    controlRolls,
    rollCountDifference: botRolls - controlRolls,
    botDoubles,
    controlDoubles,
    botDoubleRate: botRolls ? botDoubles / botRolls : 0,
    controlDoubleRate: controlRolls ? controlDoubles / controlRolls : 0,
    doubleRateDifference: (botRolls ? botDoubles / botRolls : 0)
      - (controlRolls ? controlDoubles / controlRolls : 0),
    botWhiteWins: results.filter(result => result.botColor === 'white' && result.botWon).length,
    botDarkWins: results.filter(result => result.botColor === 'dark' && result.botWon).length,
    physicalWhiteWins: results.filter(result => result.winner === 'white').length,
    physicalDarkWins: results.filter(result => result.winner === 'dark').length,
    diceAudit: {
      expectedDerivedStreamSeeds: 100,
      uniqueDerivedStreamSeeds: streamSeeds.size,
      collisions: 100 - streamSeeds.size,
      pairedStreamMismatches: 0,
    },
    pairedWinConfidence95,
    pairedSevereLossConfidence95,
    confidenceRequiredForPass: false,
    confidencePassed,
    observedPassed,
    passed: observedPassed,
  };
}

function reportLosses(seedRecords) {
  return seedRecords.flatMap(record => record.payload.results
    .filter(result => !result.botWon)
    .map(result => ({
      seed: record.seed,
      game: result.game,
      pair: result.pair,
      leg: result.leg,
      botColor: result.botColor,
      winner: result.winner,
      resultType: result.resultType,
      plies: result.plies,
      streamSeeds: { ...result.streamSeeds },
      off: { ...result.off },
    })));
}

function buildReport(
  seedRecords,
  expectedIdentity,
  execution,
  options,
  certifierHarnessFingerprint,
  executionToken = null,
  provenance = diagnosticProvenance(),
) {
  const aggregate = aggregatePayloads(seedRecords, expectedIdentity);
  const official = executionToken === OFFICIAL_EXECUTION_TOKEN;
  const freshExecution = seedRecords.every(record => record.reused === false);
  const certificationPassed = official && freshExecution && aggregate.observedPassed;
  aggregate.passed = certificationPassed;
  const losses = reportLosses(seedRecords);
  const lostPairs = [];
  for (const record of seedRecords) {
    for (let pair = 1; pair <= OFFICIAL_SUITE.gamesPerSeed / 2; pair += 1) {
      const legs = record.payload.results.filter(result => result.pair === pair);
      if (legs.every(result => !result.botWon)) lostPairs.push({ seed: record.seed, pair });
    }
  }
  return {
    schemaVersion: 1,
    official,
    passed: certificationPassed,
    certifierHarnessFingerprint,
    suite: {
      id: OFFICIAL_SUITE.id,
      derivation: OFFICIAL_SUITE.derivation,
      seeds: [...OFFICIAL_SUITE.seeds],
      gamesPerSeed: OFFICIAL_SUITE.gamesPerSeed,
      fingerprint: OFFICIAL_SUITE_FINGERPRINT,
    },
    methodology: {
      pairing: 'white and dark physical streams stay fixed while analytical and control algorithms swap colors',
      independentUnit: 'paired score; adaptive learning and mutable experience are forbidden',
      opponent: 'legacy short hard policy from the same frozen game.js runtime',
      runtime: 'all child processes use one read-only frozen JS, WildBG WASM, and simulator byte bundle',
      diceStreams: 'SHA-256 domain-separated, non-zero, collision-checked xorshift32 seeds',
      gate: 'observed 100-game result only; confidence bounds are diagnostics and do not alter the gate',
      experienceScope: 'cold-empty analytical engine baseline; mutable production experience is excluded',
    },
    criteria: {
      ...OFFICIAL_CRITERIA,
      minimumWins: 67,
      maximumSevereLosses: 10,
      requiresOfficialExecution: true,
      requiresFreshExecution: true,
      confidenceRequired: false,
      minimumPairsForSimultaneousHoeffding95: minimumPairsForConfidence(),
    },
    execution: {
      ...expectedIdentity,
      frozenBundleFingerprint: execution.bundleFingerprint,
      mode: official ? 'official-fresh' : 'diagnostic-injected',
      freshExecution,
      productionExperienceCertified: false,
      ...provenance,
    },
    options: {
      jobs: options.jobs,
      seedTimeoutMs: options.seedTimeoutMs,
      checkpointDirectory: options.checkpointDirectory,
      simulatorOptions: { ...CHILD_OPTIONS },
    },
    aggregate,
    losses,
    severeLosses: losses.filter(loss => loss.resultType !== 'normal'),
    lostPairs,
    perSeed: seedRecords.map(record => {
      const summary = JSON.parse(JSON.stringify(record.payload.summary));
      summary.options.output = '';
      return {
        seed: record.seed,
        checkpointFingerprint: record.checkpointFingerprint,
        checkpointReused: record.reused,
        summary,
        results: record.payload.results,
      };
    }),
  };
}

function createReport(
  seedRecords,
  expectedIdentity,
  execution,
  options,
  certifierHarnessFingerprint,
  provenance = diagnosticProvenance(),
) {
  return buildReport(
    seedRecords,
    expectedIdentity,
    execution,
    options,
    certifierHarnessFingerprint,
    null,
    diagnosticProvenance(provenance),
  );
}

async function executeCertification(argv, dependencies, executionToken = null) {
  const official = executionToken === OFFICIAL_EXECUTION_TOKEN;
  const certifierSnapshot = readHarnessSnapshot(__filename);
  const options = parseCertificationOptions(argv);
  validateOfficialSuite();
  validateDerivedStreamSeeds([...OFFICIAL_SUITE.seeds], OFFICIAL_SUITE.gamesPerSeed / 2);
  assertDestinationAbsent(options.output);
  validateArtifactLocations(options.output, options.checkpointDirectory);

  const buildEngine = dependencies.buildEngine || buildShortBotEngine;
  buildEngine();
  const startingProvenance = official
    ? readGitProvenance(ROOT)
    : diagnosticProvenance(dependencies.provenance);
  const runtimeSnapshot = (dependencies.readRuntimeSnapshot || readRuntimeSnapshot)(ROOT);
  const simulatorSnapshot = (dependencies.readHarnessSnapshot || readHarnessSnapshot)(SIMULATOR);
  const expectedIdentity = currentExecutionIdentity(runtimeSnapshot, simulatorSnapshot);
  const preloadedCheckpoints = loadCheckpointSet(options.checkpointDirectory, expectedIdentity);
  if (official) assertFreshOfficialCheckpointSet(preloadedCheckpoints);
  const createBundle = dependencies.createFrozenBundle || createFrozenBundle;
  const frozenBundle = createBundle(runtimeSnapshot, simulatorSnapshot, dependencies.bundleDependencies || {});
  try {
    console.log(
      `short certification: ${OFFICIAL_SUITE.seeds.length} held-out seeds, `
      + `${OFFICIAL_SUITE.gamesPerSeed} games per seed, ${options.jobs} parallel jobs`,
    );
    const records = await runSeedsOrdered(
      [...OFFICIAL_SUITE.seeds],
      options.jobs,
      seed => runSeedWithCheckpoint(
        seed,
        frozenBundle,
        options.seedTimeoutMs,
        options.checkpointDirectory,
        expectedIdentity,
        {
          preloadedCheckpoints,
          seedRunner: dependencies.seedRunner,
          seedDependencies: dependencies.seedDependencies,
        },
      ),
      record => {
        const summary = record.payload.summary;
        console.log(
          `seed ${record.seed}: ${summary.botWins}/${summary.games}, `
          + `severe ${summary.severeBotLosses}${record.reused ? ' (checkpoint)' : ''}`,
        );
      },
    );
    if (official) assertSameOfficialProvenance(startingProvenance, readGitProvenance(ROOT));
    const report = buildReport(
      records,
      expectedIdentity,
      frozenBundle,
      options,
      certifierSnapshot.fingerprint,
      executionToken,
      startingProvenance,
    );
    persistJsonAtomicNoOverwrite(options.output, report);
    const artifactFingerprint = rawFileFingerprint(options.output);
    console.log(JSON.stringify({ ...report.aggregate, artifactFingerprint }));
    if (official && !report.passed) process.exitCode = 1;
    return { report, artifactFingerprint };
  } finally {
    removeFrozenBundle(frozenBundle);
  }
}

async function runDiagnosticCertification(argv, dependencies = {}) {
  return executeCertification(argv, dependencies);
}

async function main(argv = process.argv.slice(2)) {
  if (arguments.length > 1) {
    throw new Error('Official certification main does not accept dependency injection');
  }
  return executeCertification(argv, {}, OFFICIAL_EXECUTION_TOKEN);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 2;
  });
}

module.exports = {
  CHILD_OPTIONS,
  DEFAULT_JOBS,
  DEFAULT_SEED_TIMEOUT_MS,
  ENGINE_PINNED_FILES,
  MAX_JOBS,
  OFFICIAL_CRITERIA,
  OFFICIAL_SUITE,
  OFFICIAL_SUITE_FINGERPRINT,
  PROVENANCE_TRACKED_FILES,
  aggregatePayloads,
  assertFreshOfficialCheckpointSet,
  assertSameOfficialProvenance,
  boundedMeanDiagnostics,
  checkpointFilename,
  checkpointPath,
  createFrozenBundle,
  createReport,
  currentExecutionIdentity,
  diagnosticProvenance,
  deriveOfficialSeeds,
  ensureCheckpointDirectory,
  expectedSimulatorOptions,
  loadCheckpoint,
  loadCheckpointSet,
  main,
  minimumPairsForConfidence,
  officialSuiteFingerprint,
  pairedScores,
  parseCertificationOptions,
  persistCheckpointAtomic,
  persistJsonAtomicNoOverwrite,
  rawFileFingerprint,
  readGitProvenance,
  removeFrozenBundle,
  reportLosses,
  runDiagnosticCertification,
  runSeed,
  runSeedWithCheckpoint,
  runSeedsOrdered,
  validateSeedPayload,
  validateSeedRecords,
  validateArtifactLocations,
  validateDrandMainnetBeacon,
  validateOfficialSuite,
};
