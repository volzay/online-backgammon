const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const simulator = require('../scripts/simulate-short-bot-regression');
const certifier = require('../scripts/certify-short-bot-regression');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const HASH_D = `sha256:${'d'.repeat(64)}`;
const HASH_E = `sha256:${'e'.repeat(64)}`;
const DIAGNOSTIC_PROVENANCE = Object.freeze({
  gitCommit: 'f'.repeat(40),
  engineCommit: 'e'.repeat(40),
  gitTreeClean: true,
  nodeVersion: 'v-test',
  platform: 'test-platform',
  arch: 'test-arch',
});

const IDENTITY = Object.freeze({
  engineVersion: 'short-analytic-v3',
  opponent: 'legacy-short-hard',
  runtimeFingerprint: HASH_A,
  simulatorHarnessFingerprint: HASH_B,
  wildbg: Object.freeze({
    assetFingerprint: HASH_D,
    version: 'test-wildbg',
    revision: 'test-wildbg-revision',
  }),
  experience: Object.freeze({
    mode: 'cold-empty',
    patternCount: 0,
    fingerprint: HASH_C,
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resultFor(seed, game, botWon, severe = false) {
  const pair = Math.floor((game - 1) / 2) + 1;
  const leg = (game - 1) % 2 + 1;
  const botColor = leg === 1 ? 'white' : 'dark';
  const controlColor = botColor === 'white' ? 'dark' : 'white';
  const winner = botWon ? botColor : controlColor;
  const loser = winner === 'white' ? 'dark' : 'white';
  const resultType = severe ? (game % 2 ? 'mars' : 'koks') : 'normal';
  const off = { white: 0, dark: 0 };
  off[winner] = 15;
  off[loser] = severe ? 0 : 6;
  return {
    game,
    pair,
    leg,
    botColor,
    controlColor,
    streamSeeds: simulator.diceStreamSeeds(seed, pair - 1),
    winner,
    botWon,
    resultType,
    plies: 40 + game % 7,
    botRolls: 20 + game % 3,
    controlRolls: 21 + game % 2,
    botDoubles: 3,
    controlDoubles: 4,
    off,
  };
}

function payloadFor(seed, wins, severeLosses = 0, identity = IDENTITY) {
  let severeRemaining = severeLosses;
  const results = Array.from({ length: 20 }, (_, index) => {
    const botWon = index < wins;
    const severe = !botWon && severeRemaining-- > 0;
    return resultFor(seed, index + 1, botWon, severe);
  });
  const pairs = Array.from({ length: 10 }, (_, index) => (
    results.filter(result => result.pair === index + 1)
  ));
  const botWins = results.filter(result => result.botWon).length;
  const severeBotLosses = results.filter(
    result => !result.botWon && result.resultType !== 'normal',
  ).length;
  const botRolls = results.reduce((sum, result) => sum + result.botRolls, 0);
  const controlRolls = results.reduce((sum, result) => sum + result.controlRolls, 0);
  const botDoubles = results.reduce((sum, result) => sum + result.botDoubles, 0);
  const controlDoubles = results.reduce((sum, result) => sum + result.controlDoubles, 0);
  const averagePlies = results.reduce((sum, result) => sum + result.plies, 0) / results.length;
  const summary = {
    engineVersion: identity.engineVersion,
    opponent: identity.opponent,
    runtimeFingerprint: identity.runtimeFingerprint,
    simulatorHarnessFingerprint: identity.simulatorHarnessFingerprint,
    wildbg: clone(identity.wildbg),
    experience: clone(identity.experience),
    games: 20,
    pairs: 10,
    botWins,
    controlWins: 20 - botWins,
    severeBotLosses,
    pairSweeps: pairs.filter(pair => pair.every(result => result.botWon)).length,
    pairSplits: pairs.filter(pair => pair.filter(result => result.botWon).length === 1).length,
    pairLosses: pairs.filter(pair => pair.every(result => !result.botWon)).length,
    botRolls,
    controlRolls,
    botDoubles,
    controlDoubles,
    averagePlies,
    options: certifier.expectedSimulatorOptions(seed, `/private/tmp/seed-${seed}.json`),
  };
  summary.winRate = botWins / 20;
  summary.severeLossRate = severeBotLosses / 20;
  summary.botDoubleRate = botDoubles / botRolls;
  summary.controlDoubleRate = controlDoubles / controlRolls;
  summary.doubleRateDifference = summary.botDoubleRate - summary.controlDoubleRate;
  summary.passed = true;
  return { summary, results };
}

function recordsFor(totalWins, totalSevereLosses = 0) {
  const winBase = Math.floor(totalWins / certifier.OFFICIAL_SUITE.seeds.length);
  let winRemainder = totalWins % certifier.OFFICIAL_SUITE.seeds.length;
  let severeRemaining = totalSevereLosses;
  return certifier.OFFICIAL_SUITE.seeds.map(seed => {
    const wins = winBase + (winRemainder-- > 0 ? 1 : 0);
    const severe = Math.min(20 - wins, severeRemaining);
    severeRemaining -= severe;
    return {
      seed,
      payload: payloadFor(seed, wins, severe),
      checkpointFingerprint: HASH_D,
      reused: false,
    };
  });
}

test('official short suite is frozen, unique, and cannot be weakened through CLI options', () => {
  assert.deepEqual([...certifier.OFFICIAL_SUITE.seeds], [
    2729353550, 1335326699, 513081538, 3238188421, 2278980036,
  ]);
  assert.equal(certifier.OFFICIAL_SUITE.engineCommit, 'd7ff86f7569648a7cf0c5dd0ed7a93eba58d8e4b');
  assert.equal(certifier.OFFICIAL_SUITE.beacon.round, 6418748);
  assert.equal(
    certifier.OFFICIAL_SUITE.beacon.randomness,
    '6d75fb90fa2fadaf78fc220836fe3b20af76906ed135b5e4a80f22727fd03c0c',
  );
  assert.equal(certifier.OFFICIAL_SUITE.gamesPerSeed, 20);
  assert.deepEqual(certifier.deriveOfficialSeeds(
    certifier.OFFICIAL_SUITE.engineCommit,
    certifier.OFFICIAL_SUITE.beacon.round,
    certifier.OFFICIAL_SUITE.beacon.randomness,
    certifier.OFFICIAL_SUITE.seeds.length,
  ), [...certifier.OFFICIAL_SUITE.seeds]);
  assert.doesNotThrow(() => certifier.validateDrandMainnetBeacon(
    certifier.OFFICIAL_SUITE.beacon,
  ));
  assert.doesNotThrow(() => certifier.validateOfficialSuite());
  assert.throws(() => certifier.validateDrandMainnetBeacon({
    ...certifier.OFFICIAL_SUITE.beacon,
    randomness: '0'.repeat(64),
  }), /does not match SHA-256/);
  assert.ok(!certifier.ENGINE_PINNED_FILES.includes(
    'scripts/certify-short-bot-regression.js',
  ));
  for (const file of [
    'game-controller.js',
    'short-bot-wildbg-client.js',
    'short-bot-wildbg-worker.js',
    'vendor/wildbg/wildbg_wasm_browser.js',
    'room.html',
    'scripts/build-github-pages.js',
  ]) {
    assert.ok(certifier.ENGINE_PINNED_FILES.includes(file), `${file} must be engine-pinned`);
  }
  assert.ok(certifier.PROVENANCE_TRACKED_FILES.includes(
    'scripts/certify-short-bot-regression.js',
  ));
  assert.equal(certifier.officialSuiteFingerprint(), certifier.OFFICIAL_SUITE_FINGERPRINT);
  assert.equal(simulator.validateDerivedStreamSeeds([...certifier.OFFICIAL_SUITE.seeds], 10), 100);
  assert.equal(certifier.minimumPairsForConfidence(), 185);

  const parsed = certifier.parseCertificationOptions([
    '--output', '/private/tmp/short-official.json',
    '--checkpoint-dir', '/private/tmp/short-official-checkpoints',
  ]);
  assert.equal(parsed.jobs, 5);
  assert.equal(parsed.seedTimeoutMs, 60 * 60 * 1000);
  assert.throws(() => certifier.parseCertificationOptions([
    '--output', '/private/tmp/out.json',
    '--checkpoint-dir', '/private/tmp/checkpoints',
    '--min-win-rate', '0.5',
  ]), /Unknown option/);
  assert.throws(() => certifier.parseCertificationOptions([
    '--output', '/private/tmp/checkpoints/out.json',
    '--checkpoint-dir', '/private/tmp/checkpoints',
  ]), /outside --checkpoint-dir/);
  assert.throws(() => certifier.parseCertificationOptions([]), /--output is required/);
});

test('seed payload validation checks every crossed pair, stream, result, and summary', () => {
  const seed = certifier.OFFICIAL_SUITE.seeds[0];
  const payload = payloadFor(seed, 14, 2);
  assert.doesNotThrow(() => certifier.validateSeedPayload(payload, seed, IDENTITY));

  const wrongStream = clone(payload);
  wrongStream.results[0].streamSeeds.white += 1;
  assert.throws(() => certifier.validateSeedPayload(wrongStream, seed, IDENTITY), /wrong derived stream/);

  const duplicateLeg = clone(payload);
  duplicateLeg.results[1].leg = 1;
  assert.throws(() => certifier.validateSeedPayload(duplicateLeg, seed, IDENTITY), /wrong game number|legs 1 and 2/);

  const badWinner = clone(payload);
  badWinner.results[0].botWon = !badWinner.results[0].botWon;
  assert.throws(() => certifier.validateSeedPayload(badWinner, seed, IDENTITY), /contradicts winner/);

  const badResult = clone(payload);
  const loss = badResult.results.find(result => !result.botWon && result.resultType === 'normal');
  loss.off[loss.winner === 'white' ? 'dark' : 'white'] = 0;
  assert.throws(() => certifier.validateSeedPayload(badResult, seed, IDENTITY), /result type contradicts/);

  const badSummary = clone(payload);
  badSummary.summary.botWins += 1;
  assert.throws(() => certifier.validateSeedPayload(badSummary, seed, IDENTITY), /summary.botWins mismatch/);

  const mixedRuntime = clone(payload);
  mixedRuntime.summary.runtimeFingerprint = HASH_D;
  assert.throws(() => certifier.validateSeedPayload(mixedRuntime, seed, IDENTITY), /frozen execution identity/);

  const mixedWildbg = clone(payload);
  mixedWildbg.summary.wildbg.revision = 'different-revision';
  assert.throws(() => certifier.validateSeedPayload(mixedWildbg, seed, IDENTITY), /WildBG identity/);
});

test('official aggregate passes exactly at 67 wins and 10 severe losses', () => {
  const boundary = certifier.aggregatePayloads(recordsFor(67, 10), IDENTITY);
  assert.equal(boundary.games, 100);
  assert.equal(boundary.pairs, 50);
  assert.equal(boundary.botWins, 67);
  assert.equal(boundary.severeBotLosses, 10);
  assert.equal(boundary.observedPassed, true);
  assert.equal(boundary.passed, true);
  assert.equal(boundary.diceAudit.uniqueDerivedStreamSeeds, 100);
  assert.equal(boundary.pairSweeps + boundary.pairSplits + boundary.pairLosses, 50);
  assert.equal(boundary.botWins, boundary.pairSweeps * 2 + boundary.pairSplits);

  assert.equal(certifier.aggregatePayloads(recordsFor(66, 10), IDENTITY).passed, false);
  assert.equal(certifier.aggregatePayloads(recordsFor(67, 11), IDENTITY).passed, false);
});

test('atomic publication and checkpoints never overwrite an existing artifact', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-atomic-'));
  try {
    const output = path.join(directory, 'report.json');
    certifier.persistJsonAtomicNoOverwrite(output, { version: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { version: 1 });
    assert.throws(
      () => certifier.persistJsonAtomicNoOverwrite(output, { version: 2 }),
      /Refusing to overwrite/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { version: 1 });
    assert.deepEqual(fs.readdirSync(directory), ['report.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('checkpoint loading reuses valid data and rejects corrupt, stale, or mixed directories', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-checkpoint-'));
  const seed = certifier.OFFICIAL_SUITE.seeds[0];
  try {
    const payload = payloadFor(seed, 14, 1);
    certifier.persistCheckpointAtomic(directory, seed, payload);
    const loaded = certifier.loadCheckpoint(directory, seed, IDENTITY);
    assert.equal(loaded.seed, seed);
    assert.equal(loaded.reused, true);
    assert.match(loaded.checkpointFingerprint, /^sha256:/);
    assert.throws(() => certifier.persistCheckpointAtomic(directory, seed, payload), /overwrite/);

    fs.writeFileSync(certifier.checkpointPath(directory, seed), '{broken');
    assert.throws(() => certifier.loadCheckpoint(directory, seed, IDENTITY), /stale or invalid/);
    fs.writeFileSync(path.join(directory, 'unexpected.json'), '{}');
    assert.throws(() => certifier.ensureCheckpointDirectory(directory), /unexpected entries/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-real-dir-'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-link-parent-'));
  const link = path.join(parent, 'checkpoints');
  try {
    fs.symlinkSync(target, link, 'dir');
    assert.throws(() => certifier.ensureCheckpointDirectory(link), /not a real directory/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('new seed payload is validated before checkpoint publication', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-before-publish-'));
  const seed = certifier.OFFICIAL_SUITE.seeds[0];
  try {
    const invalid = payloadFor(seed, 14, 1);
    invalid.summary.botWins += 1;
    await assert.rejects(() => certifier.runSeedWithCheckpoint(
      seed,
      {},
      1000,
      directory,
      IDENTITY,
      { seedRunner: async () => invalid },
    ), /summary.botWins mismatch/);
    assert.deepEqual(fs.readdirSync(directory), []);

    const valid = payloadFor(seed, 14, 1);
    const published = await certifier.runSeedWithCheckpoint(
      seed,
      {},
      1000,
      directory,
      IDENTITY,
      { seedRunner: async () => valid },
    );
    assert.equal(published.reused, false);
    assert.ok(fs.existsSync(certifier.checkpointPath(directory, seed)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('frozen bundle contains exact immutable runtime and a non-writing builder', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-bundle-test-'));
  const game = Buffer.from('window.NarduGame = {};\n');
  const engine = Buffer.from('window.NarduShortBotEngine = {};\n');
  const wildbgGlue = Buffer.from('exports.Wildbg = class {};\n');
  const wildbgWasm = Buffer.from('wildbg-wasm');
  const harnessBytes = Buffer.from('require("./build-short-bot-engine")();\n');
  const runtimeSnapshot = {
    entries: [
      ['game.js', game],
      ['short-bot-engine.js', engine],
      ['vendor/wildbg/wildbg_wasm.js', wildbgGlue],
      ['vendor/wildbg/wildbg_wasm_bg.wasm', wildbgWasm],
    ],
    fingerprint: simulator.fingerprintNamedBuffers([
      ['game.js', game],
      ['short-bot-engine.js', engine],
      ['vendor/wildbg/wildbg_wasm.js', wildbgGlue],
      ['vendor/wildbg/wildbg_wasm_bg.wasm', wildbgWasm],
    ]),
  };
  const harnessSnapshot = {
    bytes: harnessBytes,
    fingerprint: simulator.fingerprintNamedBuffers([
      ['simulate-short-bot-regression.js', harnessBytes],
    ]),
  };
  const bundle = certifier.createFrozenBundle(runtimeSnapshot, harnessSnapshot, { tempRoot });
  try {
    assert.equal(bundle.runtimeFingerprint, runtimeSnapshot.fingerprint);
    assert.equal(bundle.simulatorHarnessFingerprint, harnessSnapshot.fingerprint);
    assert.match(bundle.bundleFingerprint, /^sha256:/);
    assert.equal(fs.statSync(bundle.root).mode & 0o222, 0);
    assert.equal(fs.statSync(bundle.simulator).mode & 0o222, 0);
    const frozenWildbg = path.join(bundle.root, 'vendor', 'wildbg', 'wildbg_wasm_bg.wasm');
    assert.equal(fs.statSync(frozenWildbg).mode & 0o222, 0);
    assert.deepEqual(fs.readFileSync(frozenWildbg), wildbgWasm);
    const engineFile = path.join(bundle.root, 'short-bot-engine.js');
    const before = fs.readFileSync(engineFile, 'utf8');
    require(path.join(bundle.root, 'scripts', 'build-short-bot-engine.js'))();
    assert.equal(fs.readFileSync(engineFile, 'utf8'), before);
    game.fill(0);
    engine.fill(0);
    wildbgGlue.fill(0);
    wildbgWasm.fill(0);
    assert.equal(fs.readFileSync(engineFile, 'utf8'), before);
    assert.equal(fs.readFileSync(frozenWildbg, 'utf8'), 'wildbg-wasm');
  } finally {
    certifier.removeFrozenBundle(bundle);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parallel seed runner preserves official order at the concurrency limit', async () => {
  const seeds = [...certifier.OFFICIAL_SUITE.seeds];
  const delays = [25, 5, 18, 1, 10];
  const active = { value: 0, maximum: 0 };
  const completions = [];
  const values = await certifier.runSeedsOrdered(seeds, 3, async (_seed, index) => {
    active.value += 1;
    active.maximum = Math.max(active.maximum, active.value);
    await new Promise(resolve => setTimeout(resolve, delays[index]));
    active.value -= 1;
    return `result-${index}`;
  }, (result, seed) => completions.push({ result, seed }));
  assert.equal(active.maximum, 3);
  assert.deepEqual(values, seeds.map((_seed, index) => `result-${index}`));
  assert.deepEqual(completions, seeds.map((seed, index) => ({ result: `result-${index}`, seed })));
});

test('child runner uses an isolated output and removes it after success', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-child-'));
  const simulatorFile = path.join(directory, 'fake-simulator.js');
  fs.writeFileSync(simulatorFile, [
    "const fs = require('node:fs');",
    "const index = process.argv.indexOf('--output');",
    "fs.writeFileSync(process.argv[index + 1], JSON.stringify({ fixture: true }));",
  ].join('\n'));
  try {
    const value = await certifier.runSeed(
      certifier.OFFICIAL_SUITE.seeds[0],
      { root: directory, simulator: simulatorFile },
      1000,
      { tempRoot: directory },
    );
    assert.deepEqual(value, { fixture: true });
    assert.deepEqual(fs.readdirSync(directory), ['fake-simulator.js']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('injected orchestration is diagnostic-only and resume can never publish an official pass', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-main-'));
  const checkpointDirectory = path.join(directory, 'checkpoints');
  const firstOutput = path.join(directory, 'first.json');
  const secondOutput = path.join(directory, 'second.json');
  const runtimeSnapshot = simulator.readRuntimeSnapshot();
  const simulatorSnapshot = simulator.readHarnessSnapshot();
  const identity = certifier.currentExecutionIdentity(runtimeSnapshot, simulatorSnapshot);
  const wins = [14, 14, 13, 13, 13];
  const severe = [2, 2, 2, 2, 2];
  const payloads = new Map(certifier.OFFICIAL_SUITE.seeds.map((seed, index) => (
    [seed, payloadFor(seed, wins[index], severe[index], identity)]
  )));
  try {
    const first = await certifier.runDiagnosticCertification([
      '--output', firstOutput,
      '--checkpoint-dir', checkpointDirectory,
      '--jobs', '5',
    ], {
      buildEngine() {},
      readRuntimeSnapshot: () => runtimeSnapshot,
      readHarnessSnapshot: () => simulatorSnapshot,
      seedRunner: async seed => payloads.get(seed),
      bundleDependencies: { tempRoot: directory },
      provenance: DIAGNOSTIC_PROVENANCE,
    });
    assert.equal(first.report.aggregate.botWins, 67);
    assert.equal(first.report.aggregate.severeBotLosses, 10);
    assert.equal(first.report.official, false);
    assert.equal(first.report.passed, false);
    assert.equal(first.report.aggregate.observedPassed, true);
    assert.equal(first.report.aggregate.passed, false);
    assert.equal(first.report.execution.freshExecution, true);
    assert.equal(first.report.execution.productionExperienceCertified, false);
    assert.equal(first.report.execution.gitCommit, DIAGNOSTIC_PROVENANCE.gitCommit);
    assert.equal(first.report.execution.nodeVersion, DIAGNOSTIC_PROVENANCE.nodeVersion);
    assert.equal(fs.readdirSync(checkpointDirectory).length, 5);
    assert.ok(fs.existsSync(firstOutput));

    const second = await certifier.runDiagnosticCertification([
      '--output', secondOutput,
      '--checkpoint-dir', checkpointDirectory,
    ], {
      buildEngine() {},
      readRuntimeSnapshot: () => runtimeSnapshot,
      readHarnessSnapshot: () => simulatorSnapshot,
      seedRunner: async () => { throw new Error('valid checkpoints must be reused'); },
      bundleDependencies: { tempRoot: directory },
      provenance: DIAGNOSTIC_PROVENANCE,
    });
    assert.equal(second.report.official, false);
    assert.equal(second.report.passed, false);
    assert.equal(second.report.aggregate.observedPassed, true);
    assert.equal(second.report.aggregate.passed, false);
    assert.equal(second.report.execution.freshExecution, false);
    assert.ok(second.report.perSeed.every(item => item.checkpointReused));
    assert.ok(fs.existsSync(secondOutput));
    assert.deepEqual(
      fs.readdirSync(directory).sort(),
      ['checkpoints', 'first.json', 'second.json'],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('official entrypoint rejects dependency injection and official gate rejects checkpoints', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-official-fresh-'));
  const checkpointDirectory = path.join(directory, 'checkpoints');
  const output = path.join(directory, 'official.json');
  try {
    await assert.rejects(() => certifier.main([
      '--output', output,
      '--checkpoint-dir', checkpointDirectory,
    ], {
      seedRunner: async () => { throw new Error('must never be called'); },
    }), /does not accept dependency injection/);
    assert.equal(fs.existsSync(output), false);

    assert.doesNotThrow(() => certifier.assertFreshOfficialCheckpointSet(new Map()));
    assert.throws(
      () => certifier.assertFreshOfficialCheckpointSet(new Map([[1, {}]])),
      /requires an empty checkpoint directory and a fresh execution/,
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('official Git provenance requires one clean tracked worktree and remains stable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'short-cert-provenance-'));
  const calls = [];
  const cleanGit = args => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return directory;
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
      return 'a'.repeat(40);
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return certifier.OFFICIAL_SUITE.engineCommit;
    }
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'rev-parse' && args[1].startsWith('HEAD:')) return 'c'.repeat(40);
    if (args[0] === 'rev-parse'
      && args[1].startsWith(`${certifier.OFFICIAL_SUITE.engineCommit}:`)) {
      return 'c'.repeat(40);
    }
    if (args[0] === 'hash-object') return 'c'.repeat(40);
    if (args[0] === 'status') return '';
    if (args[0] === 'ls-files') return certifier.PROVENANCE_TRACKED_FILES.join('\n');
    throw new Error(`unexpected git invocation: ${args.join(' ')}`);
  };
  try {
    const provenance = certifier.readGitProvenance(directory, { runGit: cleanGit });
    assert.deepEqual(provenance, {
      gitCommit: 'a'.repeat(40),
      engineCommit: certifier.OFFICIAL_SUITE.engineCommit,
      gitTreeClean: true,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    });
    assert.ok(calls.some(args => args.includes('--untracked-files=no')));
    const trackedCall = calls.find(args => args[0] === 'ls-files');
    assert.deepEqual(
      trackedCall.slice(-certifier.PROVENANCE_TRACKED_FILES.length),
      [...certifier.PROVENANCE_TRACKED_FILES],
    );
    assert.equal(calls.filter(args => args[0] === 'hash-object').length,
      certifier.PROVENANCE_TRACKED_FILES.length);
    assert.doesNotThrow(() => certifier.assertSameOfficialProvenance(provenance, { ...provenance }));
    assert.throws(
      () => certifier.assertSameOfficialProvenance(provenance, {
        ...provenance,
        gitCommit: 'b'.repeat(40),
      }),
      /provenance changed/,
    );
    assert.throws(() => certifier.readGitProvenance(directory, {
      runGit: args => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return directory;
        if (args[0] === 'rev-parse') return 'a'.repeat(40);
        if (args[0] === 'status') return ' M game.js';
        return '';
      },
    }), /clean tracked Git worktree/);
    assert.throws(() => certifier.readGitProvenance(directory, {
      runGit: args => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return directory;
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
          return 'a'.repeat(40);
        }
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return certifier.OFFICIAL_SUITE.engineCommit;
        }
        if (args[0] === 'merge-base') return '';
        if (args[0] === 'status') return '';
        if (args[0] === 'ls-files') return certifier.PROVENANCE_TRACKED_FILES.join('\n');
        if (args[0] === 'rev-parse') return 'c'.repeat(40);
        if (args[0] === 'hash-object') return args.at(-1) === 'game.js'
          ? 'd'.repeat(40)
          : 'c'.repeat(40);
        throw new Error(`unexpected git invocation: ${args.join(' ')}`);
      },
    }), /does not match Git HEAD: game\.js/);
    assert.throws(() => certifier.readGitProvenance(directory, {
      runGit: args => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return directory;
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
          return 'a'.repeat(40);
        }
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return certifier.OFFICIAL_SUITE.engineCommit;
        }
        if (args[0] === 'status') return '';
        if (args[0] === 'merge-base') throw new Error('not ancestor');
        throw new Error(`unexpected git invocation: ${args.join(' ')}`);
      },
    }), /not an ancestor of HEAD/);
    assert.throws(() => certifier.readGitProvenance(directory, {
      runGit: args => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return directory;
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
          return 'a'.repeat(40);
        }
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return certifier.OFFICIAL_SUITE.engineCommit;
        }
        if (args[0] === 'status' || args[0] === 'merge-base') return '';
        if (args[0] === 'ls-files') return certifier.PROVENANCE_TRACKED_FILES.join('\n');
        if (args[0] === 'hash-object') return 'c'.repeat(40);
        if (args[0] === 'rev-parse' && args[1] === 'HEAD:game.js') return 'c'.repeat(40);
        if (args[0] === 'rev-parse'
          && args[1] === `${certifier.OFFICIAL_SUITE.engineCommit}:game.js`) {
          return 'd'.repeat(40);
        }
        if (args[0] === 'rev-parse') return 'c'.repeat(40);
        throw new Error(`unexpected git invocation: ${args.join(' ')}`);
      },
    }), /engine-pinned file differs.*game\.js/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('direct report construction is diagnostic-only and labels confidence as diagnostic', () => {
  const records = recordsFor(67, 10);
  const options = {
    jobs: 5,
    seedTimeoutMs: 60 * 60 * 1000,
    checkpointDirectory: '/private/tmp/checkpoints',
  };
  const report = certifier.createReport(
    records,
    IDENTITY,
    { bundleFingerprint: HASH_E },
    options,
    HASH_D,
    DIAGNOSTIC_PROVENANCE,
  );
  assert.equal(report.official, false);
  assert.equal(report.passed, false);
  assert.equal(report.aggregate.observedPassed, true);
  assert.equal(report.aggregate.passed, false);
  assert.equal(report.aggregate.confidenceRequiredForPass, false);
  assert.equal(report.criteria.minimumPairsForSimultaneousHoeffding95, 185);
  assert.equal(report.perSeed.length, 5);
  assert.equal(report.perSeed.reduce((sum, item) => sum + item.results.length, 0), 100);
  assert.equal(report.losses.length, 33);
  assert.equal(report.severeLosses.length, 10);
  assert.equal(report.execution.frozenBundleFingerprint, HASH_E);
  assert.equal(report.execution.mode, 'diagnostic-injected');
  assert.equal(report.execution.freshExecution, true);
  assert.equal(report.execution.productionExperienceCertified, false);
  assert.equal(report.execution.gitCommit, DIAGNOSTIC_PROVENANCE.gitCommit);
  assert.equal(report.execution.gitTreeClean, true);
  assert.equal(report.execution.nodeVersion, DIAGNOSTIC_PROVENANCE.nodeVersion);
  assert.equal(report.execution.platform, DIAGNOSTIC_PROVENANCE.platform);
  assert.equal(report.execution.arch, DIAGNOSTIC_PROVENANCE.arch);
  assert.equal(report.criteria.requiresFreshExecution, true);
  assert.ok(report.perSeed.every(item => item.summary.options.output === ''));
});
