const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  DEFAULT_EXPECTED_CREDIT_VERSION,
  DEFAULT_EXPECTED_ENGINE_VERSION,
  DEFAULT_MAX_SEVERE_LOSS_RATE,
  DEFAULT_MIN_HOLDOUT_PAIRS,
  DEFAULT_SEED_SPLITS,
  DEFAULT_TARGET_WIN_RATE,
  buildReport,
  suiteFingerprint,
  summarizeSplit,
  validateSuiteDiceStreams,
  validationPassed,
} = require('./long-bot-v34-harness');
const {
  fileFingerprint,
  fingerprintNamedBuffers,
} = require('./simulate-long-bot-regression');

const ROOT = path.join(__dirname, '..');
const SIMULATOR = path.join(__dirname, 'simulate-long-bot-regression.js');
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_JOBS = 8;
const MAX_TIMEOUT_MS = 0x7fffffff;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const VALUE_OPTIONS = new Set([
  'output', 'trained-experience-output', 'initial-experience',
  'train-seeds', 'validation-seeds', 'holdout-seeds',
  'games-per-seed', 'target-win-rate', 'max-severe-loss-rate',
  'min-holdout-pairs',
  'jobs', 'seed-timeout-ms', 'bot-nodes', 'control-nodes',
  'bot-candidates', 'control-candidates', 'max-plies',
  'bot-profile', 'control-profile',
]);
const FLAG_OPTIONS = new Set(['dry-run']);
const EMPTY_EXPERIENCE_FINGERPRINT = fingerprintNamedBuffers([
  ['experience.json', Buffer.from('[]', 'utf8')],
]);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function parseTokens(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith('--') || token.length === 2) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (FLAG_OPTIONS.has(name)) {
      if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`);
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    values.set(name, String(value));
    index += 1;
  }
  return { values, flags };
}

function stringOption(parsed, name, fallback = '') {
  const value = parsed.values.has(name) ? parsed.values.get(name).trim() : fallback;
  if (parsed.values.has(name) && !value) throw new Error(`--${name} must not be empty`);
  return value;
}

function integerOption(parsed, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!parsed.values.has(name)) return fallback;
  const raw = parsed.values.get(name);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`--${name} must not exceed ${maximum}`);
  }
  return value;
}

function ratioOption(parsed, name, fallback) {
  if (!parsed.values.has(name)) return fallback;
  const value = Number(parsed.values.get(name));
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`--${name} must be greater than 0 and less than 1`);
  }
  return value;
}

function upperRateOption(parsed, name, fallback) {
  if (!parsed.values.has(name)) return fallback;
  const value = Number(parsed.values.get(name));
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`--${name} must be from 0 to less than 1`);
  }
  return value;
}

function seedListOption(parsed, name, fallback) {
  if (!parsed.values.has(name)) return [...fallback];
  const raw = parsed.values.get(name).split(',').map(value => value.trim());
  if (!raw.length || raw.some(value => !/^[1-9]\d*$/.test(value))) {
    throw new Error(`--${name} must be a comma-separated list of positive decimal integers`);
  }
  return raw.map(value => {
    const seed = Number(value);
    if (!Number.isSafeInteger(seed) || seed > 0xffffffff) {
      throw new Error(`--${name} seed ${value} is not a positive 32-bit integer`);
    }
    return seed;
  });
}

function derivedExperiencePath(output) {
  const extension = path.extname(output);
  return extension
    ? `${output.slice(0, -extension.length)}.experience.json`
    : `${output}.experience.json`;
}

function parseOptions(argv) {
  const parsed = parseTokens(argv);
  const output = stringOption(parsed, 'output');
  if (!output && !parsed.flags.has('dry-run')) throw new Error('--output is required');
  const gamesPerSeed = integerOption(parsed, 'games-per-seed', 20);
  if (gamesPerSeed < 2 || gamesPerSeed % 2 !== 0) {
    throw new Error('--games-per-seed must be an even integer of at least 2');
  }
  const minHoldoutPairs = integerOption(
    parsed,
    'min-holdout-pairs',
    DEFAULT_MIN_HOLDOUT_PAIRS,
  );
  if (minHoldoutPairs < DEFAULT_MIN_HOLDOUT_PAIRS) {
    throw new Error(`--min-holdout-pairs cannot be lower than ${DEFAULT_MIN_HOLDOUT_PAIRS}`);
  }
  const { splits: seedSplits } = validateSuiteDiceStreams({
    train: seedListOption(parsed, 'train-seeds', DEFAULT_SEED_SPLITS.train),
    validation: seedListOption(parsed, 'validation-seeds', DEFAULT_SEED_SPLITS.validation),
    holdout: seedListOption(parsed, 'holdout-seeds', DEFAULT_SEED_SPLITS.holdout),
  }, gamesPerSeed);
  const initialExperience = stringOption(parsed, 'initial-experience');
  if (initialExperience && !fs.existsSync(path.resolve(initialExperience))) {
    throw new Error(`Initial experience file does not exist: ${initialExperience}`);
  }
  const targetWinRate = ratioOption(parsed, 'target-win-rate', DEFAULT_TARGET_WIN_RATE);
  const maxSevereLossRate = upperRateOption(
    parsed,
    'max-severe-loss-rate',
    DEFAULT_MAX_SEVERE_LOSS_RATE,
  );
  const jobs = integerOption(parsed, 'jobs', 1, MAX_JOBS);
  const seedTimeoutMs = integerOption(
    parsed,
    'seed-timeout-ms',
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const simulatorArgs = [];
  for (const name of [
    'bot-nodes', 'control-nodes', 'bot-candidates', 'control-candidates',
    'max-plies', 'bot-profile', 'control-profile',
  ]) {
    if (parsed.values.has(name)) simulatorArgs.push(`--${name}`, parsed.values.get(name));
  }
  const resolvedOutput = output ? path.resolve(output) : '';
  const trainedExperienceOutput = path.resolve(stringOption(
    parsed,
    'trained-experience-output',
    output ? derivedExperiencePath(output) : 'long-bot-v34.experience.json',
  ));
  if (resolvedOutput && resolvedOutput === trainedExperienceOutput) {
    throw new Error('--output and --trained-experience-output must be different files');
  }
  return {
    output: resolvedOutput,
    trainedExperienceOutput,
    initialExperience: initialExperience ? path.resolve(initialExperience) : '',
    seedSplits,
    gamesPerSeed,
    criteria: {
      targetWinRate,
      maxSevereLossRate,
      minHoldoutPairs,
      expectedEngineVersion: DEFAULT_EXPECTED_ENGINE_VERSION,
      expectedCreditVersion: DEFAULT_EXPECTED_CREDIT_VERSION,
    },
    jobs,
    seedTimeoutMs,
    simulatorArgs,
    dryRun: parsed.flags.has('dry-run'),
  };
}

function collectChild(child, timeoutMs) {
  return new Promise(resolve => {
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let failure = null;
    let settled = false;
    let killTimer = null;
    const capture = target => chunk => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_CHILD_OUTPUT_BYTES) {
        failure = new Error(`child output exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes`);
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        return;
      }
      target.push(chunk);
    };
    const timer = setTimeout(() => {
      if (!failure) failure = new Error(`timed out after ${timeoutMs}ms`);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    }, timeoutMs);
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status,
        signal,
        failure,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', error => {
      failure = error;
      if (!child.pid) finish(null, null);
    });
    child.once('close', finish);
  });
}

async function runSimulator(args, timeoutMs, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess || spawn;
  const simulator = dependencies.simulator || SIMULATOR;
  const cwd = dependencies.cwd || ROOT;
  const child = spawnProcess(process.execPath, [simulator, ...args], {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await collectChild(child, timeoutMs);
  if (result.failure || result.status !== 0) {
    const details = [
      result.failure?.message,
      result.status === null ? `terminated by ${result.signal || 'unknown signal'}` : '',
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n').trim();
    throw new Error(`Simulator failed${details ? `:\n${details}` : ''}`);
  }
  return result;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label} ${file}: ${error.message}`);
  }
}

function describeExperience(file) {
  const bytes = fs.readFileSync(file);
  const payload = JSON.parse(bytes.toString('utf8'));
  const patterns = Array.isArray(payload) ? payload : payload?.patterns;
  assertCondition(Array.isArray(patterns), 'Trained experience has no patterns array');
  const versions = Array.from(new Set(patterns
    .map(pattern => Number(pattern?.creditVersion))
    .filter(Number.isFinite)));
  const declaredCreditVersion = Number.isFinite(Number(payload?.creditVersion))
    ? Number(payload.creditVersion)
    : null;
  const creditVersion = versions.length === 1
    && (declaredCreditVersion === null || declaredCreditVersion === versions[0])
    ? versions[0]
    : versions.length === 0 && declaredCreditVersion !== null
      ? declaredCreditVersion
      : null;
  return {
    path: file,
    fingerprint: fingerprintNamedBuffers([['experience.json', bytes]]),
    patternCount: patterns.length,
    creditVersion,
    patternCreditVersions: versions,
    declaredCreditVersion,
    engineVersion: String(payload?.engineVersion || ''),
    storageKey: String(payload?.storageKey || ''),
  };
}

function atomicCopy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
}

function atomicWriteJson(destination, value) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, destination);
}

function assertExperienceIdentity(expected, actual, label = 'Experience artifact') {
  for (const field of [
    'fingerprint', 'patternCount', 'creditVersion', 'engineVersion', 'storageKey',
  ]) {
    assertCondition(
      expected?.[field] === actual?.[field],
      `${label} ${field} mismatch`,
    );
  }
}

function realRunners(options, directory, dependencies = {}) {
  let serial = 0;
  const commonArgs = [
    '--games', String(options.gamesPerSeed),
    '--min-win-rate', '0',
    '--max-severe-loss-rate', '1',
    ...options.simulatorArgs,
  ];
  return {
    async train(seed, inputExperience) {
      serial += 1;
      const resultFile = path.join(directory, `train-${serial}-${seed}.json`);
      const experienceFile = path.join(directory, `experience-${serial}-${seed}.json`);
      const args = [
        ...commonArgs,
        '--seed', String(seed),
        '--learn',
        '--output', resultFile,
        '--experience-output', experienceFile,
      ];
      if (inputExperience) args.push('--experience', inputExperience);
      await runSimulator(args, options.seedTimeoutMs, dependencies);
      assertCondition(fs.existsSync(resultFile), `Training seed ${seed} produced no result`);
      assertCondition(fs.existsSync(experienceFile), `Training seed ${seed} produced no experience`);
      const payload = readJson(resultFile, 'training result');
      const experienceDescription = describeExperience(experienceFile);
      const reportedExperience = payload.summary?.trainedExperience;
      assertCondition(reportedExperience, `Training seed ${seed} did not describe its experience output`);
      assertCondition(
        reportedExperience.fingerprint === experienceDescription.fingerprint,
        `Training seed ${seed} experience fingerprint mismatch`,
      );
      assertCondition(
        Number(reportedExperience.patternCount) === experienceDescription.patternCount,
        `Training seed ${seed} experience pattern count mismatch`,
      );
      return {
        record: { seed, payload },
        experience: experienceFile,
      };
    },
    async evaluate(seed, experience, split) {
      serial += 1;
      const resultFile = path.join(directory, `${split}-${serial}-${seed}.json`);
      const args = [
        ...commonArgs,
        '--seed', String(seed),
        '--output', resultFile,
        '--experience', experience,
      ];
      await runSimulator(args, options.seedTimeoutMs, dependencies);
      assertCondition(fs.existsSync(resultFile), `${split} seed ${seed} produced no result`);
      return { seed, payload: readJson(resultFile, `${split} result`) };
    },
    describeExperience,
  };
}

async function mapLimit(items, limit, operation) {
  assertCondition(Number.isSafeInteger(limit) && limit > 0, 'Concurrency must be positive');
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;
  async function worker() {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await operation(items[index], index);
      } catch (error) {
        firstError = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstError) throw firstError;
  return results;
}

async function runPipeline(options, runners) {
  const { splits: seedSplits } = validateSuiteDiceStreams(
    options.seedSplits,
    options.gamesPerSeed,
  );
  const trainRecords = [];
  const trainingChain = [];
  let experience = options.initialExperience || '';
  let inputExperienceFingerprint = experience
    ? (await runners.describeExperience(experience)).fingerprint
    : EMPTY_EXPERIENCE_FINGERPRINT;
  for (const seed of seedSplits.train) {
    const trained = await runners.train(seed, experience);
    summarizeSplit([trained.record], [seed], options.gamesPerSeed, true);
    assertCondition(
      trained.record.payload.summary?.experienceFingerprint === inputExperienceFingerprint,
      `Training seed ${seed} did not load the preceding experience snapshot`,
    );
    trainRecords.push(trained.record);
    experience = trained.experience;
    const outputExperience = await runners.describeExperience(experience);
    trainingChain.push({
      seed,
      inputExperienceFingerprint,
      outputExperienceFingerprint: outputExperience.fingerprint,
      outputPatternCount: outputExperience.patternCount,
    });
    inputExperienceFingerprint = outputExperience.fingerprint;
  }
  assertCondition(experience, 'Training did not produce an experience snapshot');
  const trainedExperience = await runners.describeExperience(experience);
  const validationRecords = await mapLimit(seedSplits.validation, options.jobs, seed => (
    runners.evaluate(seed, experience, 'validation')
  ));
  const validation = summarizeSplit(
    validationRecords,
    seedSplits.validation,
    options.gamesPerSeed,
    false,
  );
  const qualified = validationPassed(validation, options.criteria, trainedExperience);
  const holdoutRecords = qualified
    ? await mapLimit(seedSplits.holdout, options.jobs, seed => (
      runners.evaluate(seed, experience, 'holdout')
    ))
    : null;
  const report = buildReport({
    seedSplits,
    gamesPerSeed: options.gamesPerSeed,
    trainRecords,
    validationRecords,
    holdoutRecords,
    trainedExperience,
    criteria: options.criteria,
  });
  report.trainingChain = trainingChain;
  return { report, experience };
}

function dryRunReport(options) {
  const suiteValidation = validateSuiteDiceStreams(
    options.seedSplits,
    options.gamesPerSeed,
  );
  const holdoutPairs = options.seedSplits.holdout.length * options.gamesPerSeed / 2;
  return {
    harness: 'long-bot-v34-offline-training-certification',
    dryRun: true,
    provenance: provenance(),
    suiteFingerprint: suiteFingerprint(options.seedSplits, options.gamesPerSeed),
    seedSplits: options.seedSplits,
    gamesPerSeed: options.gamesPerSeed,
    projected: {
      trainGames: options.seedSplits.train.length * options.gamesPerSeed,
      validationGames: options.seedSplits.validation.length * options.gamesPerSeed,
      holdoutGames: options.seedSplits.holdout.length * options.gamesPerSeed,
      holdoutPairs,
      derivedDiceStreamCount: suiteValidation.derivedDiceStreamCount,
      sampleSufficient: holdoutPairs >= options.criteria.minHoldoutPairs,
    },
    criteria: options.criteria,
  };
}

function provenance() {
  return {
    orchestratorFingerprint: fileFingerprint(__filename),
    metricsFingerprint: fileFingerprint(path.join(__dirname, 'long-bot-v34-harness.js')),
    simulatorFingerprint: fileFingerprint(SIMULATOR),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.dryRun) {
    console.log(JSON.stringify(dryRunReport(options), null, 2));
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-bot-v34-'));
  try {
    const outcome = await runPipeline(options, realRunners(options, directory));
    atomicCopy(outcome.experience, options.trainedExperienceOutput);
    const publishedExperience = describeExperience(options.trainedExperienceOutput);
    assertExperienceIdentity(
      outcome.report.trainedExperience,
      publishedExperience,
      'Published experience artifact',
    );
    outcome.report.provenance = provenance();
    outcome.report.trainedExperience = publishedExperience;
    outcome.report.artifacts = {
      report: options.output,
      trainedExperience: options.trainedExperienceOutput,
    };
    atomicWriteJson(options.output, outcome.report);
    const summary = {
      validationQualified: outcome.report.validation.qualified,
      holdoutGames: outcome.report.holdout?.games || 0,
      holdoutWinRate: outcome.report.holdout?.winRate ?? null,
      holdoutMatchPoints: outcome.report.holdout?.matchPoints || null,
      holdoutSevereLossRate: outcome.report.holdout?.severeLossRate ?? null,
      pairedWilsonLower95: outcome.report.holdout?.pairedWinWilson95?.lower ?? null,
      gatePassed: outcome.report.gate.passed,
    };
    console.log(JSON.stringify(summary));
    if (!outcome.report.gate.passed) process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 2;
  });
}

module.exports = {
  MAX_JOBS,
  EMPTY_EXPERIENCE_FINGERPRINT,
  atomicCopy,
  atomicWriteJson,
  assertExperienceIdentity,
  describeExperience,
  dryRunReport,
  mapLimit,
  parseOptions,
  provenance,
  realRunners,
  runPipeline,
  runSimulator,
};
