const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  botColorForLeg,
  createDiceStream,
  createLegAssignment,
  diceStreamSeeds,
  fileFingerprint,
  loadIsolatedRuntimes,
  loadRuntime,
  pairedDiceStreams,
  playGame,
  readRuntimeSnapshot,
  runtimeFingerprint,
  validateDerivedStreamSeeds,
} = require('../scripts/simulate-long-bot-regression');
const {
  DEFAULT_JOBS,
  MAX_JOBS,
  aggregatePayloads,
  boundedMeanDiagnostics,
  checkpointPath,
  loadCheckpoint,
  loadCheckpointSet,
  minimumPairsForConfidence,
  parseSeeds,
  persistCheckpointAtomic,
  requestedSimulatorOptions,
  resolveJobs,
  runSeed,
  runSeedWithCheckpoint,
  runSeedsOrdered,
  validateConfidenceCapacity,
  validateSeedPayloads,
} = require('../scripts/certify-long-bot-regression');

const ROOT = path.join(__dirname, '..');
const SIMULATOR = path.join(ROOT, 'scripts', 'simulate-long-bot-regression.js');
const CERTIFIER = path.join(ROOT, 'scripts', 'certify-long-bot-regression.js');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

test('paired long-bot games swap both color and dice stream between algorithms', () => {
  const streamA = { id: 'A' };
  const streamB = { id: 'B' };
  const streams = pairedDiceStreams(streamA, streamB);
  const firstBotColor = botColorForLeg(0);
  const secondBotColor = botColorForLeg(1);

  assert.equal(streams[firstBotColor], streamA);
  assert.equal(streams[secondBotColor], streamB);
  assert.equal(streams[secondBotColor === 'white' ? 'dark' : 'white'], streamA);
  assert.notEqual(firstBotColor, secondBotColor);
});

function sampleStream(stream) {
  return {
    opening: [stream.openingDie(), stream.openingDie()],
    firstRoll: stream.roll(),
    secondRoll: stream.roll(),
  };
}

test('paired long-bot legs cross over the actual opening and turn dice sequences', () => {
  const firstLeg = createLegAssignment(430419993, 7, 0);
  const secondLeg = createLegAssignment(430419993, 7, 1);

  assert.equal(firstLeg.botColor, 'white');
  assert.equal(secondLeg.botColor, 'dark');
  assert.deepEqual(firstLeg.seeds, secondLeg.seeds);

  const firstBotDice = sampleStream(firstLeg.streams[firstLeg.botColor]);
  const firstControlDice = sampleStream(firstLeg.streams[firstLeg.controlColor]);
  const secondBotDice = sampleStream(secondLeg.streams[secondLeg.botColor]);
  const secondControlDice = sampleStream(secondLeg.streams[secondLeg.controlColor]);

  assert.deepEqual(firstBotDice, secondControlDice);
  assert.deepEqual(firstControlDice, secondBotDice);
  assert.notDeepEqual(firstBotDice, firstControlDice);
});

test('long-bot simulator rejects incomplete paired runs before loading the engine', () => {
  const result = spawnSync(process.execPath, [
    SIMULATOR,
    '--games', '3',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--games must be an even number/);
});

test('derived dice streams are domain-separated, non-zero, and collision-checked', () => {
  const seen = new Set();
  for (const seed of [1, 1640531527, 2654435770]) {
    for (let pairIndex = 0; pairIndex < 20; pairIndex += 1) {
      const streams = diceStreamSeeds(seed, pairIndex);
      assert.ok(streams.white > 0);
      assert.ok(streams.dark > 0);
      assert.notEqual(streams.white, streams.dark);
      assert.equal(seen.has(streams.white), false);
      assert.equal(seen.has(streams.dark), false);
      seen.add(streams.white);
      seen.add(streams.dark);
    }
  }
  assert.equal(validateDerivedStreamSeeds([1, 1640531527, 2654435770], 20), 120);
  assert.throws(() => validateDerivedStreamSeeds([1, 1], 1), /collision/);
  assert.throws(() => createDiceStream(0), /non-zero 32-bit integer/);
});

test('runtime snapshot and fingerprints describe immutable bytes actually loaded', () => {
  const snapshot = readRuntimeSnapshot();
  const originalFingerprint = runtimeFingerprint(snapshot);
  assert.match(originalFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(runtimeFingerprint(snapshot), originalFingerprint);
  assert.equal(fileFingerprint(SIMULATOR), fileFingerprint(SIMULATOR));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-experience-test-'));
  try {
    const first = path.join(directory, 'first.json');
    const second = path.join(directory, 'second.json');
    const learned = path.join(directory, 'learned.json');
    fs.writeFileSync(first, '[]');
    fs.writeFileSync(second, '{"patterns":[]}');
    fs.writeFileSync(learned, JSON.stringify({
      patterns: [{
        contextKey: 'route|h2|o2|po0|sz1|tr0|pd2',
        actionKey: 'head:1|entry:0|off:0|shuffle:0',
        samples: 8,
        losses: 5,
      }],
    }));
    const firstRuntime = loadRuntime(first, snapshot);
    const secondRuntime = loadRuntime(second, snapshot);
    const learnedRuntime = loadRuntime(learned, snapshot);
    assert.equal(firstRuntime.runtimeFingerprint, originalFingerprint);
    assert.equal(secondRuntime.runtimeFingerprint, originalFingerprint);
    assert.notEqual(firstRuntime.experienceFingerprint, secondRuntime.experienceFingerprint);
    assert.equal(firstRuntime.engine.experienceSize(), 0);
    assert.ok(learnedRuntime.engine.experienceSize() > 0);
    assert.equal(learnedRuntime.experienceCount, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('treatment experience and adaptive learning stay isolated from the control engine', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-isolation-test-'));
  const experienceFile = path.join(directory, 'experience.json');
  fs.writeFileSync(experienceFile, JSON.stringify({
    patterns: [{
      creditVersion: 6,
      contextKey: 'route|imported-isolation-test',
      actionKey: 'head:1|entry:0|off:0|shuffle:0',
      samples: 4,
      losses: 4,
      lossWeight: 5,
    }],
  }));

  try {
    const runtime = loadIsolatedRuntimes(experienceFile);
    assert.notEqual(runtime.engine, runtime.controlEngine);
    assert.ok(runtime.engine.experienceSize() > 0);
    assert.equal(runtime.controlEngine.experienceSize(), 0);
    assert.equal(runtime.controlExperienceCount, 0);

    const importedSize = runtime.engine.experienceSize();
    runtime.hardBot.learnFromGame({
      variant: 'long',
      winner: 'white',
      resultType: 'normal',
      analysis: {
        botMemory: {
          engineVersion: runtime.engine.version,
          coverage: {
            expectedBotDecisions: 1,
            recordedBotDecisions: 1,
            recoveredBotDecisions: 0,
            complete: true,
          },
          decisions: [{
            actor: 'bot',
            source: 'engine',
            engineVersion: runtime.engine.version,
            choiceCount: 2,
            experienceFrozen: true,
            experienceFingerprint: 'lbe6-simulator-isolation',
            winQuality: 1,
            experience: {
              contextKey: 'route|adaptive-isolation-test',
              actionKey: 'head:0|entry:1|off:0|shuffle:0',
              mistakeSeverity: 0,
              riskSignal: 0,
            },
          }],
        },
      },
    }, 'white');

    assert.ok(runtime.engine.experienceSize() > importedSize);
    assert.equal(runtime.controlEngine.experienceSize(), 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('simulator fails closed when an engine plan leaves mandatory moves unused', () => {
  const runtime = loadIsolatedRuntimes();
  runtime.engine.plan = () => [];

  assert.throws(() => playGame(0, 0, runtime, {
    seed: 430419993,
    maxPlies: 2,
    botProfile: 'v25',
    controlProfile: 'v19',
    botCandidates: 64,
    controlCandidates: 24,
    botNodes: 480,
    controlNodes: 64,
    trace: false,
  }), /empty or incomplete plan[\s\S]*legal moves remain/);
});

test('simulator fails closed after applying only the first move of a real multi-move plan', () => {
  const runtime = loadIsolatedRuntimes();
  const originalPlan = runtime.engine.plan.bind(runtime.engine);
  let originalMultiMovePlan = null;
  let returnedPartialPlan = null;
  runtime.engine.plan = (state, options) => {
    const plan = originalPlan(state, options);
    if (!originalMultiMovePlan && plan.length > 1) {
      originalMultiMovePlan = plan.map(move => ({ ...move }));
      returnedPartialPlan = [{ ...plan[0] }];
      return returnedPartialPlan;
    }
    return plan;
  };

  assert.throws(() => playGame(0, 0, runtime, {
    seed: 430419993,
    maxPlies: 4,
    botProfile: 'v25',
    controlProfile: 'v19',
    botCandidates: 64,
    controlCandidates: 24,
    botNodes: 480,
    controlNodes: 64,
    trace: false,
  }), /empty or incomplete plan[\s\S]*legal moves remain/);
  assert.ok(originalMultiMovePlan?.length > 1);
  assert.deepEqual(returnedPartialPlan, [originalMultiMovePlan[0]]);
});

test('simulator CLI rejects invalid numbers, unknown options, and unsupported profiles', () => {
  const cases = [
    { args: ['--games', 'oops'], message: /positive integer/ },
    { args: ['--seed', '4294967296'], message: /not greater than 4294967295/ },
    { args: ['--unknown', '1'], message: /Unknown option/ },
    { args: ['--games', '2', '--bot-profile', 'v23'], message: /must be one of: v19, v25/ },
  ];
  for (const item of cases) {
    const result = spawnSync(process.execPath, [SIMULATOR, ...item.args], { encoding: 'utf8' });
    assert.equal(result.status, 2, `${item.args.join(' ')} should be an input error`);
    assert.match(result.stderr, item.message);
  }
});

test('multi-seed certification aggregates independent pair scores without lowering 70%', () => {
  const seedPayload = (seed, wins) => ({
    seed,
    payload: {
      summary: {
        engineVersion: 'long-analytic-v25',
        games: 2,
        botWins: wins,
        controlWins: 2 - wins,
        severeBotLosses: 0,
        botRolls: 20,
        controlRolls: 20,
        botDoubles: 3,
        controlDoubles: 3,
        pairSweeps: wins === 2 ? 1 : 0,
        pairSplits: wins === 1 ? 1 : 0,
        pairLosses: wins === 0 ? 1 : 0,
      },
      results: [
        { pair: 1, botWon: wins >= 1, resultType: 'normal' },
        { pair: 1, botWon: wins >= 2, resultType: 'normal' },
      ],
    },
  });
  const aggregate = aggregatePayloads([
    seedPayload(11, 2),
    seedPayload(22, 1),
    seedPayload(33, 2),
  ], {
    minWinRate: 0.7,
    maxSevereLossRate: 0.1,
    requireConfidence: false,
  });

  assert.equal(aggregate.games, 6);
  assert.equal(aggregate.pairs, 3);
  assert.equal(aggregate.winRate, 5 / 6);
  assert.equal(aggregate.observedPassed, true);
  assert.equal(aggregate.passed, true);
  assert.equal(aggregate.pairedWinConfidence95.mean, 5 / 6);

  const strict = aggregatePayloads([
    seedPayload(11, 2),
    seedPayload(22, 1),
    seedPayload(33, 2),
  ], {
    minWinRate: 0.7,
    maxSevereLossRate: 0.1,
    requireConfidence: true,
  });
  assert.equal(strict.observedPassed, true);
  assert.equal(strict.confidencePassed, false);
  assert.equal(strict.passed, false);
});

test('certification validates distinct seeds and reports bounded confidence diagnostics', () => {
  assert.deepEqual(parseSeeds('1,2,3'), [1, 2, 3]);
  assert.throws(() => parseSeeds('1,1,2'), /unique/);
  assert.throws(() => parseSeeds('1,2'), /at least three/);
  assert.throws(() => parseSeeds('1e0,2,3'), /decimal 32-bit/);
  assert.throws(() => parseSeeds('0x1,2,3'), /decimal 32-bit/);

  const diagnostic = boundedMeanDiagnostics([1, 0.5, 1, 0.5]);
  assert.equal(diagnostic.mean, 0.75);
  assert.equal(diagnostic.perBoundErrorRate, 0.025);
  assert.ok(diagnostic.hoeffdingLower95 < diagnostic.mean);
  assert.ok(diagnostic.hoeffdingUpper95 >= diagnostic.mean);
});

test('certification jobs are strict, bounded, and capped at the seed count', () => {
  const parsed = values => ({ values: new Map(values), flags: new Set() });

  assert.deepEqual(resolveJobs(parsed([]), 5), {
    requested: DEFAULT_JOBS,
    effective: Math.min(DEFAULT_JOBS, 5),
  });
  assert.equal(DEFAULT_JOBS, 1);
  assert.deepEqual(resolveJobs(parsed([['jobs', '8']]), 3), {
    requested: 8,
    effective: 3,
  });
  assert.equal(MAX_JOBS, 8);
  for (const raw of ['0', '-1', '1.5', 'nope', String(MAX_JOBS + 1)]) {
    assert.throws(() => resolveJobs(parsed([['jobs', raw]]), 5), /--jobs/);
  }
  assert.throws(() => resolveJobs(parsed([]), 0), /seed count/);
});

test('parallel certification preserves seed and completion order at the concurrency limit', async () => {
  const seeds = [41, 17, 93, 8, 65];
  const delays = new Map([[41, 50], [17, 5], [93, 20], [8, 1], [65, 2]]);
  const completions = [];
  let active = 0;
  let maximumActive = 0;

  const results = await runSeedsOrdered(seeds, 2, async seed => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, delays.get(seed)));
    active -= 1;
    return `result-${seed}`;
  }, (result, seed) => completions.push({ result, seed }));

  assert.equal(maximumActive, 2);
  assert.deepEqual(results, seeds.map(seed => `result-${seed}`));
  assert.deepEqual(completions, seeds.map(seed => ({
    result: `result-${seed}`,
    seed,
  })));
});

test('async seed runner uses no shell, enforces timeout, and always removes temp output', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-cert-runner-test-'));
  const fixture = path.join(directory, 'fake-simulator.js');
  fs.writeFileSync(fixture, `
const fs = require('node:fs');
const value = name => process.argv[process.argv.indexOf(name) + 1];
const seed = Number(value('--seed'));
if (seed === 2) {
  setTimeout(() => {}, 10000);
} else if (seed === 3) {
  console.error('deliberate child failure');
  process.exitCode = 7;
} else {
  fs.writeFileSync(value('--output'), JSON.stringify({ seed }));
}
`);
  let shellOption = null;
  const dependencies = {
    simulator: fixture,
    cwd: directory,
    tempRoot: directory,
    spawnProcess(command, args, options) {
      shellOption = options.shell;
      return spawn(command, args, options);
    },
  };

  try {
    assert.deepEqual(await runSeed(1, 2, [], 1000, dependencies), { seed: 1 });
    assert.equal(shellOption, false);
    await assert.rejects(
      runSeed(2, 2, [], 30, dependencies),
      /Seed 2 failed[\s\S]*timed out after 30ms/,
    );
    await assert.rejects(
      runSeed(3, 2, [], 1000, dependencies),
      /Seed 3 failed[\s\S]*deliberate child failure/,
    );
    assert.deepEqual(fs.readdirSync(directory), ['fake-simulator.js']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('confidence certification fails fast when the configured sample cannot satisfy its bounds', () => {
  const criteria = { minWinRate: 0.7, maxSevereLossRate: 0.1 };
  assert.equal(minimumPairsForConfidence(criteria), 185);
  assert.throws(() => validateConfidenceCapacity(50, criteria), /at least 185 independent pairs/);
  assert.equal(validateConfidenceCapacity(185, criteria), 185);

  const result = spawnSync(process.execPath, [CERTIFIER, '--require-confidence'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /at least 185 independent pairs/);
  assert.doesNotMatch(result.stdout, /^seed /m);
});

test('certification rejects adaptive learning and unsupported profiles before spawning games', () => {
  for (const args of [
    ['--learn'],
    ['--bot-profile', 'v23'],
    ['--control-profile', 'legacy'],
    ['--seed-timeout-ms', '0'],
  ]) {
    const result = spawnSync(process.execPath, [CERTIFIER, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
});

function validSeedPayload(seed, fingerprints = {}) {
  const streamSeeds = diceStreamSeeds(seed, 0);
  const results = [
    {
      game: 1,
      pair: 1,
      leg: 1,
      botColor: 'white',
      controlColor: 'dark',
      streamSeeds,
      winner: 'white',
      botWon: true,
      resultType: 'normal',
      plies: 80,
      botRolls: 40,
      controlRolls: 39,
      botDoubles: 6,
      controlDoubles: 5,
    },
    {
      game: 2,
      pair: 1,
      leg: 2,
      botColor: 'dark',
      controlColor: 'white',
      streamSeeds,
      winner: 'white',
      botWon: false,
      resultType: 'normal',
      plies: 82,
      botRolls: 40,
      controlRolls: 41,
      botDoubles: 5,
      controlDoubles: 6,
    },
  ];
  const summary = {
    engineVersion: 'long-analytic-v25',
    runtimeFingerprint: fingerprints.runtime || HASH_A,
    simulatorHarnessFingerprint: fingerprints.simulator || HASH_B,
    experienceFingerprint: fingerprints.experience || HASH_C,
    experiencePatterns: 0,
    games: 2,
    botWins: 1,
    controlWins: 1,
    severeBotLosses: 0,
    botRolls: 80,
    controlRolls: 80,
    botDoubles: 11,
    controlDoubles: 11,
    pairSweeps: 0,
    pairSplits: 1,
    pairLosses: 0,
    averagePlies: 81,
    options: {
      games: 2,
      seed,
      botNodes: 480,
      controlNodes: 64,
      botCandidates: 64,
      controlCandidates: 24,
      maxPlies: 320,
      minWinRate: 0,
      maxSevereLossRate: 1,
      botProfile: 'v25',
      controlProfile: 'v19',
      output: '/tmp/result.json',
      experience: '',
      trace: false,
      learn: false,
    },
    winRate: 0.5,
    severeLossRate: 0,
    botDoubleRate: 11 / 80,
    controlDoubleRate: 11 / 80,
    doubleRateDifference: 0,
    passed: true,
  };
  return { seed, payload: { summary, results } };
}

function certificationRequest(games = 2, values = [], flags = []) {
  return requestedSimulatorOptions({
    values: new Map(values),
    flags: new Set(flags),
  }, games);
}

function fixtureExecutionIdentity(fingerprints = {}) {
  return {
    engineVersion: 'long-analytic-v25',
    runtimeFingerprint: fingerprints.runtime || HASH_A,
    simulatorHarnessFingerprint: fingerprints.simulator || HASH_B,
    experienceFingerprint: fingerprints.experience || HASH_C,
  };
}

test('certification checkpoints publish complete payloads atomically without overwriting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-checkpoint-write-'));
  const directory = path.join(root, 'nested', 'checkpoints');
  const payload = validSeedPayload(11).payload;
  try {
    const destination = persistCheckpointAtomic(directory, 11, payload);
    assert.equal(destination, checkpointPath(directory, 11));
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), payload);
    assert.deepEqual(fs.readdirSync(directory), ['seed-11.json']);

    assert.throws(
      () => persistCheckpointAtomic(directory, 11, { replaced: true }),
      /refusing to overwrite/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), payload);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('certification reuses a valid checkpoint without spawning its seed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-checkpoint-reuse-'));
  const item = validSeedPayload(11);
  const requestedOptions = certificationRequest();
  let runs = 0;
  try {
    persistCheckpointAtomic(directory, item.seed, item.payload);
    const loaded = loadCheckpoint(
      directory,
      item.seed,
      2,
      requestedOptions,
      fixtureExecutionIdentity(),
    );
    assert.deepEqual(loaded, item.payload);

    const result = await runSeedWithCheckpoint(
      item.seed,
      2,
      [],
      1000,
      directory,
      requestedOptions,
      fixtureExecutionIdentity(),
      {
        async seedRunner() {
          runs += 1;
          throw new Error('seed runner must not execute');
        },
      },
    );
    assert.equal(runs, 0);
    assert.deepEqual(result, item.payload);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('certification fails closed on corrupt or stale checkpoints without rerunning them', async () => {
  const corruptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-checkpoint-corrupt-'));
  const staleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-checkpoint-stale-'));
  const identityDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-checkpoint-identity-'));
  let runs = 0;
  const dependencies = {
    async seedRunner() {
      runs += 1;
      return validSeedPayload(11).payload;
    },
  };
  try {
    fs.writeFileSync(checkpointPath(corruptDirectory, 11), '{not-json');
    await assert.rejects(
      runSeedWithCheckpoint(
        11, 2, [], 1000, corruptDirectory, certificationRequest(),
        fixtureExecutionIdentity(), dependencies,
      ),
      /Checkpoint for seed 11 is stale or invalid/,
    );

    persistCheckpointAtomic(staleDirectory, 11, validSeedPayload(11).payload);
    await assert.rejects(
      runSeedWithCheckpoint(
        11, 2, [], 1000, staleDirectory,
        certificationRequest(2, [['bot-nodes', '700']]),
        fixtureExecutionIdentity(), dependencies,
      ),
      /stale or invalid[\s\S]*options do not match/,
    );

    persistCheckpointAtomic(identityDirectory, 11, validSeedPayload(11).payload);
    await assert.rejects(
      runSeedWithCheckpoint(
        11, 2, [], 1000, identityDirectory, certificationRequest(),
        fixtureExecutionIdentity({ runtime: HASH_B }), dependencies,
      ),
      /stale or invalid[\s\S]*runtimeFingerprint does not match/,
    );
    assert.equal(runs, 0);
  } finally {
    fs.rmSync(corruptDirectory, { recursive: true, force: true });
    fs.rmSync(staleDirectory, { recursive: true, force: true });
    fs.rmSync(identityDirectory, { recursive: true, force: true });
  }
});

test('checkpoint preflight rejects a mixed execution fingerprint before any new seed runs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-checkpoint-mixed-'));
  try {
    persistCheckpointAtomic(directory, 11, validSeedPayload(11).payload);
    persistCheckpointAtomic(
      directory,
      22,
      validSeedPayload(22, { runtime: HASH_B }).payload,
    );
    assert.throws(
      () => loadCheckpointSet(
        directory,
        [11, 22, 33],
        2,
        certificationRequest(),
        null,
      ),
      /do not share one runtimeFingerprint/,
    );
    assert.equal(fs.existsSync(checkpointPath(directory, 33)), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a newly completed seed is validated and checkpointed before it is returned', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-checkpoint-new-'));
  const item = validSeedPayload(11);
  let runs = 0;
  try {
    const result = await runSeedWithCheckpoint(
      11,
      2,
      [],
      1000,
      directory,
      certificationRequest(),
      fixtureExecutionIdentity(),
      {
        async seedRunner() {
          runs += 1;
          return item.payload;
        },
      },
    );
    assert.equal(runs, 1);
    assert.deepEqual(result, item.payload);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(checkpointPath(directory, 11), 'utf8')),
      item.payload,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('certification derives exact child defaults and validates requested overrides', () => {
  assert.deepEqual(certificationRequest(), {
    games: 2,
    botNodes: 480,
    controlNodes: 64,
    botCandidates: 64,
    controlCandidates: 24,
    maxPlies: 320,
    minWinRate: 0,
    maxSevereLossRate: 1,
    botProfile: 'v25',
    controlProfile: 'v19',
    experience: '',
    trace: false,
    learn: false,
  });

  assert.deepEqual(certificationRequest(6, [
    ['bot-nodes', '700'],
    ['control-nodes', '80'],
    ['bot-candidates', '72'],
    ['control-candidates', '30'],
    ['max-plies', '400'],
    ['bot-profile', 'V19'],
    ['control-profile', 'V25'],
    ['experience', '  /tmp/experience.json  '],
  ], ['trace']), {
    games: 6,
    botNodes: 700,
    controlNodes: 80,
    botCandidates: 72,
    controlCandidates: 30,
    maxPlies: 400,
    minWinRate: 0,
    maxSevereLossRate: 1,
    botProfile: 'v19',
    controlProfile: 'v25',
    experience: '/tmp/experience.json',
    trace: true,
    learn: false,
  });
});

test('certification validates complete crossed pairs and homogeneous execution identity', () => {
  const first = validSeedPayload(11);
  const second = validSeedPayload(22);
  const third = validSeedPayload(33);
  const requestedOptions = certificationRequest();
  assert.doesNotThrow(() => validateSeedPayloads(
    [first, second, third], 2, requestedOptions,
  ));

  const mixedRuntime = validSeedPayload(22, { runtime: HASH_C });
  assert.throws(
    () => validateSeedPayloads([first, mixedRuntime, third], 2, requestedOptions),
    /do not share one runtimeFingerprint/,
  );
  const mixedHarness = validSeedPayload(22, { simulator: HASH_C });
  assert.throws(
    () => validateSeedPayloads([first, mixedHarness, third], 2, requestedOptions),
    /do not share one simulatorHarnessFingerprint/,
  );
  const mixedExperience = validSeedPayload(22, { experience: HASH_A });
  assert.throws(
    () => validateSeedPayloads([first, mixedExperience, third], 2, requestedOptions),
    /do not share one experienceFingerprint/,
  );
});

test('certification rejects homogeneous child options that ignore its request', () => {
  const payloads = [11, 22, 33].map(seed => validSeedPayload(seed));
  const requestedOptions = certificationRequest(2, [['bot-nodes', '700']]);

  assert.throws(
    () => validateSeedPayloads(payloads, 2, requestedOptions),
    /simulator options do not match the certifier request/,
  );

  payloads.forEach(({ payload }) => { payload.summary.options.botNodes = 700; });
  assert.doesNotThrow(() => validateSeedPayloads(payloads, 2, requestedOptions));
});

test('certification rejects duplicated legs, wrong stream seeds, and contradictory summaries', () => {
  const requestedOptions = certificationRequest();
  const duplicatedLeg = validSeedPayload(11);
  duplicatedLeg.payload.results[1].leg = 1;
  duplicatedLeg.payload.results[1].game = 1;
  duplicatedLeg.payload.results[1].botColor = 'white';
  duplicatedLeg.payload.results[1].controlColor = 'dark';
  duplicatedLeg.payload.results[1].botWon = true;
  assert.throws(
    () => validateSeedPayloads([duplicatedLeg], 2, requestedOptions),
    /repeats a leg/,
  );

  const wrongStreams = validSeedPayload(11);
  wrongStreams.payload.results[1].streamSeeds = { ...wrongStreams.payload.results[1].streamSeeds };
  wrongStreams.payload.results[1].streamSeeds.white += 1;
  assert.throws(
    () => validateSeedPayloads([wrongStreams], 2, requestedOptions),
    /wrong derived stream seeds/,
  );

  const wrongSummary = validSeedPayload(11);
  wrongSummary.payload.summary.botWins = 2;
  assert.throws(
    () => validateSeedPayloads([wrongSummary], 2, requestedOptions),
    /summary\.botWins mismatch/,
  );
});
