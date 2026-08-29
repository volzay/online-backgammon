const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const simulator = require('../scripts/simulate-short-bot-regression');

test('short simulator swaps algorithms while preserving physical dice streams', () => {
  const first = simulator.createLegAssignment(20260829, 3, 0);
  const second = simulator.createLegAssignment(20260829, 3, 1);

  assert.equal(first.botColor, 'white');
  assert.equal(first.controlColor, 'dark');
  assert.equal(second.botColor, 'dark');
  assert.equal(second.controlColor, 'white');
  assert.deepEqual(first.streamSeeds, second.streamSeeds);
  assert.deepEqual(first.streams.white.roll(), second.streams.white.roll());
  assert.deepEqual(first.streams.dark.roll(), second.streams.dark.roll());
});

test('short simulator defaults match production analytical settings', () => {
  const options = simulator.parseOptions([]);
  assert.equal(options.games, 100);
  assert.equal(options.botCandidates, 48);
  assert.equal(options.botAnalyze, 6);
  assert.equal(options.botReplyLimit, 12);
  assert.equal(options.minWinRate, 0.67);
  assert.equal(options.maxSevereLossRate, 0.1);
  assert.equal(options.trace, false);
});

test('short simulator rejects incomplete pairs and malformed CLI values', () => {
  assert.throws(() => simulator.parseOptions(['--games', '3']), /even number/);
  assert.throws(() => simulator.parseOptions(['--games', '0']), /positive integer/);
  assert.throws(() => simulator.parseOptions(['--unknown', '1']), /Unknown option/);
  assert.throws(() => simulator.parseOptions(['--min-win-rate', '1.1']), /from 0 to 1/);
});

test('short dice stream seeds are domain-separated, non-zero, and collision checked', () => {
  const seen = new Set();
  for (let pair = 0; pair < 50; pair += 1) {
    const seeds = simulator.diceStreamSeeds(20260829, pair);
    for (const color of ['white', 'dark']) {
      assert.ok(seeds[color] > 0);
      assert.ok(!seen.has(seeds[color]));
      seen.add(seeds[color]);
    }
  }
  assert.equal(simulator.validateDerivedStreamSeeds([20260829], 50), 100);
});

test('short simulator fails closed on illegal and incomplete plans', () => {
  const state = { phase: 'move', turn: 'white', winner: null };
  assert.throws(() => simulator.applyPlan({
    applyMove: () => false,
    hasAnyMoves: () => true,
  }, state, [{ from: 1, die: 2 }]), /illegal move/);
  assert.throws(() => simulator.applyPlan({
    applyMove: () => true,
    hasAnyMoves: () => true,
  }, state, []), /empty or incomplete plan/);
});

test('short simulator fails closed if experience mutates during certification', () => {
  assert.equal(simulator.assertColdEmptyExperience({
    engine: { experienceSize: () => 0 },
  }, 'before play'), 0);
  assert.throws(() => simulator.assertColdEmptyExperience({
    engine: { experienceSize: () => 1 },
  }, 'after game 1'), /requires empty experience at after game 1/);
  assert.throws(() => simulator.assertColdEmptyExperience({ engine: {} }), /cannot verify/);
});

test('short simulator rejects duplicated legs and mismatched streams', () => {
  const base = {
    pair: 1,
    botColor: 'white',
    controlColor: 'dark',
    streamSeeds: { white: 11, dark: 22 },
  };
  assert.throws(() => simulator.validatePairedResults([
    { ...base, leg: 1 },
    { ...base, leg: 1 },
  ], 2), /legs 1 and 2/);
  assert.throws(() => simulator.validatePairedResults([
    { ...base, leg: 1 },
    {
      ...base,
      leg: 2,
      botColor: 'dark',
      controlColor: 'white',
      streamSeeds: { white: 11, dark: 23 },
    },
  ], 2), /identical physical dice streams/);
});

test('short simulator fingerprints the exact immutable runtime files', () => {
  const snapshot = simulator.readRuntimeSnapshot();
  const harness = simulator.readHarnessSnapshot();
  assert.match(snapshot.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(harness.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(simulator.runtimeFingerprint(snapshot), snapshot.fingerprint);
  assert.deepEqual(snapshot.entries.map(([name]) => name), [
    'game.js',
    'short-bot-engine.js',
  ]);
  assert.match(simulator.fileFingerprint(require.resolve('../scripts/simulate-short-bot-regression')), /^sha256:/);
});

test('short simulator reports the harness snapshot captured before play', () => {
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const results = [
    {
      pair: 1, leg: 1, botColor: 'white', controlColor: 'dark',
      streamSeeds: { white: 11, dark: 22 }, botWon: true, resultType: 'normal',
      botRolls: 1, controlRolls: 1, botDoubles: 0, controlDoubles: 0, plies: 2,
    },
    {
      pair: 1, leg: 2, botColor: 'dark', controlColor: 'white',
      streamSeeds: { white: 11, dark: 22 }, botWon: false, resultType: 'normal',
      botRolls: 1, controlRolls: 1, botDoubles: 0, controlDoubles: 0, plies: 2,
    },
  ];
  const summary = simulator.summarize(results, {
    engine: { version: 'test', experienceSize: () => 0 },
    runtimeFingerprint: `sha256:${'b'.repeat(64)}`,
    experience: { mode: 'cold-empty', patternCount: 0, fingerprint: `sha256:${'c'.repeat(64)}` },
  }, {
    games: 2,
    minWinRate: 0,
    maxSevereLossRate: 1,
  }, { fingerprint });
  assert.equal(summary.simulatorHarnessFingerprint, fingerprint);
  assert.deepEqual(summary.experience, {
    mode: 'cold-empty', patternCount: 0, fingerprint: `sha256:${'c'.repeat(64)}`,
  });
});

test('short simulator writes complete reports atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'short-bot-report-'));
  const output = path.join(directory, 'report.json');
  try {
    simulator.writeJsonAtomic(output, { complete: true, games: 100 });
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { complete: true, games: 100 });
    assert.deepEqual(fs.readdirSync(directory), ['report.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
