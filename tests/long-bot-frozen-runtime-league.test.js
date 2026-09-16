const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { diceStreamSeeds } = require('../scripts/simulate-long-bot-regression');
const {
  DEFAULT_RESOURCES,
  buildRuntimeLeague,
  parseOptions,
  readGitRuntimeSnapshot,
  readRuntimeDirectory,
  snapshotFromEntries,
  summarizeResults,
  validatePairedResults,
  wilsonInterval,
  writeJsonAtomic,
} = require('../scripts/league-long-bot-frozen-runtime');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'league-long-bot-frozen-runtime.js');

function leagueResults({ pairs, seed, candidatePairWins = pairs, splits = 0 }) {
  return Array.from({ length: pairs }, (_, pairIndex) => {
    const pairNumber = pairIndex + 1;
    const isSweep = pairIndex < candidatePairWins;
    const isSplit = !isSweep && pairIndex < candidatePairWins + splits;
    return [0, 1].map(legIndex => {
      const botColor = legIndex === 0 ? 'white' : 'dark';
      const botWon = isSweep || (isSplit && legIndex === 0);
      return {
        game: pairIndex * 2 + legIndex + 1,
        pair: pairNumber,
        leg: legIndex + 1,
        botColor,
        controlColor: botColor === 'white' ? 'dark' : 'white',
        streamSeeds: diceStreamSeeds(seed, pairIndex),
        winner: botWon ? botColor : (botColor === 'white' ? 'dark' : 'white'),
        botWon,
        resultType: 'normal',
        productionDispatch: true,
        productionPolicyWeights: { homeEntry: 145000 },
      };
    });
  }).flat();
}

test('league CLI exposes one shared resource budget and rejects asymmetric knobs', () => {
  const options = parseOptions([
    '--pairs', '40',
    '--nodes', '320',
    '--candidates', '48',
    '--profile', 'v25',
    '--seed', '1234',
  ]);
  assert.deepEqual(options.resources, {
    nodes: 320,
    candidates: 48,
    profile: 'v25',
    maxPlies: DEFAULT_RESOURCES.maxPlies,
  });
  assert.deepEqual(options.control, { kind: 'git', ref: 'HEAD' });
  assert.equal(options.expectedCandidateVersion, 'long-analytic-v35');
  assert.equal(options.expectedControlVersion, 'long-analytic-v34');
  const explicitVersions = parseOptions([
    '--expected-candidate-version', 'long-analytic-v36',
    '--expected-control-version', 'long-analytic-v35',
  ]);
  assert.equal(explicitVersions.expectedCandidateVersion, 'long-analytic-v36');
  assert.equal(explicitVersions.expectedControlVersion, 'long-analytic-v35');
  assert.throws(() => parseOptions(['--bot-nodes', '480']), /Unknown option: --bot-nodes/);
  assert.throws(() => parseOptions(['--control-nodes', '64']), /Unknown option: --control-nodes/);
  assert.throws(() => parseOptions([
    '--control-runtime-dir', '/tmp/control',
    '--control-git-ref', 'HEAD',
  ]), /either --control-runtime-dir or --control-git-ref/);
});

test('CLI rejects asymmetric options before loading either runtime', () => {
  const result = spawnSync(process.execPath, [CLI, '--bot-candidates', '64'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option: --bot-candidates/);
});

test('Wilson gate cannot certify a merely observed 65 percent result', () => {
  const marginal = wilsonInterval(130, 200);
  const strong = wilsonInterval(180, 200);
  assert.ok(marginal.lower < 0.65);
  assert.ok(strong.lower > 0.65);

  const seed = 99173;
  const marginalSummary = summarizeResults(
    leagueResults({ pairs: 200, seed, candidatePairWins: 130 }),
    { pairs: 200, seed, targetWinRate: 0.65 },
  );
  assert.equal(marginalSummary.observedWinRate, 0.65);
  assert.equal(marginalSummary.checks.observedThresholdMet, true);
  assert.equal(marginalSummary.checks.pairedWilsonLowerThresholdMet, false);
  assert.equal(marginalSummary.checks.pairedHoeffdingLowerThresholdMet, false);
  assert.equal(marginalSummary.verdict, 'not-certified');
  assert.equal(marginalSummary.passed, false);

  const strongSummary = summarizeResults(
    leagueResults({ pairs: 200, seed, candidatePairWins: 180 }),
    { pairs: 200, seed, targetWinRate: 0.65 },
  );
  assert.equal(strongSummary.observedWinRate, 0.9);
  assert.equal(strongSummary.verdict, 'certified');
  assert.equal(strongSummary.passed, true);
});

test('paired summary treats a split as half a success and a pair as the sampling unit', () => {
  const seed = 77123;
  const results = leagueResults({ pairs: 4, seed, candidatePairWins: 1, splits: 2 });
  const summary = summarizeResults(results, { pairs: 4, seed, targetWinRate: 0.5 });
  assert.equal(summary.candidateWins, 4);
  assert.equal(summary.observedWinRate, 0.5);
  assert.deepEqual(summary.pairOutcomes, { sweeps: 1, splits: 2, losses: 1 });
  assert.equal(summary.pairedWilson95.trials, 4);
  assert.equal(summary.pairedWilson95.successes, 2);
});

test('paired validation rejects incomplete crossover and altered dice streams', () => {
  const seed = 55119;
  const valid = leagueResults({ pairs: 2, seed });
  assert.doesNotThrow(() => validatePairedResults(valid, 2, seed));

  const repeatedColor = structuredClone(valid);
  repeatedColor[1].botColor = 'white';
  repeatedColor[1].controlColor = 'dark';
  assert.throws(() => validatePairedResults(repeatedColor, 2, seed), /does not swap/);

  const changedDice = structuredClone(valid);
  changedDice[3].streamSeeds.white += 1;
  assert.throws(() => validatePairedResults(changedDice, 2, seed), /exact color-bound dice/);

  const invalidLegs = structuredClone(valid);
  invalidLegs[0].leg = 7;
  assert.throws(() => validatePairedResults(invalidLegs, 2, seed), /legs 1 and 2/);

  const invalidColor = structuredClone(valid);
  invalidColor[0].botColor = 'red';
  invalidColor[0].controlColor = 'white';
  assert.throws(() => validatePairedResults(invalidColor, 2, seed), /invalid candidate color/);

  const inconsistentWinner = structuredClone(valid);
  inconsistentWinner[0].botWon = !inconsistentWinner[0].botWon;
  assert.throws(() => validatePairedResults(inconsistentWinner, 2, seed), /inconsistent winner flag/);

  const defaultsOnly = structuredClone(valid);
  defaultsOnly[0].productionDispatch = false;
  assert.throws(() => validatePairedResults(defaultsOnly, 2, seed), /production hard-bot dispatcher/);

  const changedWeights = structuredClone(valid);
  changedWeights[3].productionPolicyWeights.homeEntry = 0;
  assert.throws(() => validatePairedResults(changedWeights, 2, seed), /weights are not identical/);
});

test('git control snapshots resolve HEAD to immutable commit bytes', () => {
  const first = readGitRuntimeSnapshot(ROOT, 'HEAD');
  const second = readGitRuntimeSnapshot(ROOT, first.source.commit);
  assert.match(first.source.commit, /^[0-9a-f]{40,64}$/);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.entries.map(([name]) => name), [
    'game.js', 'long-bot-engine.js', 'strong-bot.js',
  ]);
});

test('league binds both engine versions and rejects identical runtime snapshots', () => {
  const candidate = readRuntimeDirectory(ROOT);
  const control = readGitRuntimeSnapshot(ROOT, 'HEAD');
  const runtime = buildRuntimeLeague(
    candidate,
    control,
    'long-analytic-v34',
    'long-analytic-v35',
  );
  assert.equal(runtime.candidate.engine.version, 'long-analytic-v35');
  assert.equal(runtime.control.engine.version, 'long-analytic-v34');

  assert.throws(() => buildRuntimeLeague(
    candidate,
    control,
    'long-analytic-v34',
    'long-analytic-v36',
  ), /Candidate version mismatch/);
  assert.throws(() => buildRuntimeLeague(
    candidate,
    candidate,
    'long-analytic-v35',
    'long-analytic-v35',
  ), /runtime snapshots are identical/);
});

test('runtime fingerprints cover names, order and bytes', () => {
  const first = snapshotFromEntries([
    ['game.js', Buffer.from('game')],
    ['long-bot-engine.js', Buffer.from('engine-a')],
    ['strong-bot.js', Buffer.from('bot')],
  ]);
  const second = snapshotFromEntries([
    ['game.js', Buffer.from('game')],
    ['long-bot-engine.js', Buffer.from('engine-b')],
    ['strong-bot.js', Buffer.from('bot')],
  ]);
  assert.match(first.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test('league report output is complete JSON installed atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'long-frozen-league-'));
  const output = path.join(directory, 'nested', 'report.json');
  try {
    writeJsonAtomic(output, { passed: false, reason: 'test' });
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
      passed: false,
      reason: 'test',
    });
    assert.deepEqual(
      fs.readdirSync(path.dirname(output)).sort(),
      ['report.json'],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
