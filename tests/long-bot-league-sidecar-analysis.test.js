const test = require('node:test');
const assert = require('node:assert/strict');
const { playGame, diceStreamSeeds } = require('../scripts/simulate-long-bot-regression');
const army = require('../scripts/league-long-bot-army');
const frozen = require('../scripts/league-long-bot-frozen-runtime');
const { validateWorkerConfig } = require('../scripts/league-long-bot-army-worker');
const { loadRuntime } = require('../scripts/simulate-long-bot-regression');

const HASH = `sha256:${'c'.repeat(64)}`;
const OPTIONS = {
  seed: 1279413297, maxPlies: 4, trace: true, productionDispatch: true,
  botCandidates: 1, controlCandidates: 1, botNodes: 1, controlNodes: 1,
  botProfile: 'v25', controlProfile: 'v25',
};

function terminalRuntime(existingAnalysis) {
  const observed = [];
  let applied = 0;
  const game = {
    initialState() {
      applied = 0;
      return { variant: 'long', phase: 'opening', turn: 'white', dice: [], rolled: [],
        history: [], off: { white: 0, dark: 0 }, points: {},
        ...(existingAnalysis ? { analysis: structuredClone(existingAnalysis) } : {}),
      };
    },
    decideOpeningRoll(state) { state.turn = 'white'; },
    startOpeningTurn(state) { state.phase = 'move'; state.dice = [1]; state.rolled = [1]; },
    applyRoll(state, dice) { state.phase = 'move'; state.dice = [...dice]; state.rolled = [...dice]; },
    pipsFor: () => 1,
    hasAnyMoves: state => state.dice.length > 0,
    applyMove(state, from, die) {
      if (from !== 1 || die !== state.dice[0]) return false;
      state.dice = [];
      state.history.unshift({ color: state.turn, from, to: 0, die });
      state.off[state.turn] += 1;
      if (++applied === 3) { state.winner = 'white'; state.phase = 'over'; }
      return true;
    },
    endTurn(state) { state.turn = state.turn === 'white' ? 'dark' : 'white'; state.phase = 'roll'; },
  };
  const makeEngine = role => {
    let last = null;
    let serial = 0;
    return {
      version: `${role}-test`,
      plan(state) {
        observed.push({ role, memory: state.analysis?.botMemory, extra: state.analysis?.extra });
        const move = { from: 1, die: state.dice[0] };
        last = { id: `${role}-${++serial}`, source: 'engine', engineVersion: `${role}-test`,
          weights: { homeEntry: 145000 }, selected: { moves: [{ ...move, to: 0 }] } };
        return [move];
      },
      consumeLastDecision() { const decision = last; last = null; return decision; },
    };
  };
  const engine = makeEngine('candidate');
  const controlEngine = makeEngine('control');
  const dispatcher = current => ({ plan: state => current.plan(state) });
  return { game, engine, controlEngine, hardBot: dispatcher(engine), controlHardBot: dispatcher(controlEngine), observed };
}

function fixedTime(callback) {
  const OriginalDate = Date;
  class FixedDate extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [1789500000000])); }
    static now() { return 1789500000000; }
  }
  global.Date = FixedDate;
  try { return callback(); } finally { global.Date = OriginalDate; }
}
const fixedPlay = (runtime, options) => fixedTime(() => playGame(0, 0, runtime, options));

test('explicit sidecar production play keeps durable ledger out of working state and restores complete terminal export', () => {
  const runtime = terminalRuntime({ extra: { preserved: true } });
  const result = fixedPlay(runtime, { ...OPTIONS, sidecarAnalysis: true });
  assert.equal(result.sidecarAnalysis, true);
  assert.ok(runtime.observed.every(state => state.memory === undefined));
  assert.ok(runtime.observed.every(state => state.extra.preserved === true));
  const memory = result._state.analysis.botMemory;
  assert.equal(result._state.analysis.extra.preserved, true);
  assert.equal(memory.format, 2);
  assert.equal(memory.engineVersion, 'candidate-test');
  assert.deepEqual(memory.decisions.map(decision => decision.id), ['candidate-1', 'candidate-2']);
  assert.deepEqual(memory.coverage, { expectedBotDecisions: 2, recordedBotDecisions: 2, recoveredBotDecisions: 0, complete: true });
  assert.equal(result.decisions.length, 3, 'full trace includes both policies exactly as before');
  assert.equal(result._state.history.length, 5, 'actual completed history remains available for exports/review');
  const exported = JSON.parse(JSON.stringify(result._state));
  assert.deepEqual(exported.analysis.botMemory, memory, 'terminal learning/review export keeps the complete candidate ledger');
});

test('sidecar and in-state production play have identical terminal state/trace/outcome under fixed time', () => {
  const baselineRuntime = terminalRuntime();
  const baseline = fixedPlay(baselineRuntime, OPTIONS);
  const optimized = fixedPlay(terminalRuntime(), { ...OPTIONS, sidecarAnalysis: true });
  assert.ok(baselineRuntime.observed.some(state => state.memory), 'default still retains historical working-ledger behavior');
  assert.equal(baseline.sidecarAnalysis, false);
  delete baseline.sidecarAnalysis;
  delete optimized.sidecarAnalysis;
  assert.deepEqual(optimized, baseline);
});

test('sidecar preserves pre-existing bot memory separately and never deletes unrelated analysis', () => {
  const prior = { extra: { preserved: true }, botMemory: { format: 2, custom: 'kept', decisions: [{ id: 'prior' }] } };
  const runtime = terminalRuntime(prior);
  const result = fixedPlay(runtime, { ...OPTIONS, sidecarAnalysis: true });
  assert.ok(runtime.observed.every(state => state.memory === undefined));
  assert.equal(result._state.analysis.botMemory.custom, 'kept');
  assert.deepEqual(result._state.analysis.botMemory.decisions.map(decision => decision.id), ['prior', 'candidate-1', 'candidate-2']);
  assert.deepEqual(prior.botMemory.decisions, [{ id: 'prior' }]);
});

test('frozen paired league forwards the explicit sidecar flag to both terminal legs', () => {
  const runtime = terminalRuntime();
  const results = fixedTime(() => frozen.playLeaguePairs(runtime, {
    seed: OPTIONS.seed, trace: true, sidecarAnalysis: true,
    resources: { nodes: 1, candidates: 1, profile: 'v25', maxPlies: 4 },
  }, [0]));
  assert.equal(results.length, 2);
  assert.ok(results.every(result => result.sidecarAnalysis === true && result.decisions.length === 3));
  assert.ok(runtime.observed.every(state => state.memory === undefined));
});

test('current native production plans and full telemetry are unchanged by durable ledger removal at canonical contact and terminal positions', () => {
  fixedTime(() => {
    const contacts = [
      { dark: { 12: 14, 9: 1 }, white: { 24: 15 }, off: { dark: 0, white: 0 }, dice: [1, 2] },
      { dark: { 1: 1, 3: 1, 5: 1, 6: 3, 7: 1, 9: 2, 10: 1, 11: 1, 12: 1, 13: 1, 15: 1, 20: 1 },
        white: { 2: 1, 4: 1, 8: 1, 14: 2, 16: 1, 18: 3, 19: 1, 22: 3, 23: 1, 24: 1 }, off: { dark: 0, white: 0 }, dice: [1, 2] },
      { dark: { 13: 1 }, white: { 6: 15 }, off: { dark: 14, white: 0 }, dice: [1] },
    ];
    for (const position of contacts) {
      const baseline = loadRuntime();
      const optimized = loadRuntime();
      const state = baseline.game.initialState('long');
      Object.assign(state, { phase: 'move', turn: 'dark', dice: position.dice, rolled: position.dice,
        off: position.off, firstMoveDone: { dark: true, white: true },
        points: Object.fromEntries([
          ...Object.entries(position.dark).map(([point, count]) => [point, { color: 'dark', count }]),
          ...Object.entries(position.white).map(([point, count]) => [point, { color: 'white', count }]),
        ]), analysis: { extra: { retained: true }, botMemory: { format: 2, decisions: [{ id: 'diagnostic', payload: 'X'.repeat(8192) }] } },
      });
      const projected = structuredClone(state);
      delete projected.analysis.botMemory;
      const options = { maxCandidates: 1, analysisNodeBudget: 1, strategyProfile: 'v25' };
      const plan = baseline.hardBot.plan(state, options);
      const sidecarPlan = optimized.hardBot.plan(projected, options);
      const plain = value => JSON.parse(JSON.stringify(value));
      assert.ok(plan.length);
      assert.deepEqual(plain(sidecarPlan), plain(plan));
      assert.deepEqual(plain(optimized.engine.consumeLastDecision()), plain(baseline.engine.consumeLastDecision()));
      assert.equal(baseline.hardBot.consumeLastFallbackDecision(), null);
      assert.equal(optimized.hardBot.consumeLastFallbackDecision(), null);
    }
  });
});

test('sidecar is default OFF and rejects custom/nonproduction or coerced flags before any planner runs', () => {
  assert.equal(army.parseOptions([]).sidecarAnalysis, false);
  assert.equal(frozen.parseOptions([]).sidecarAnalysis, false);
  assert.equal(army.parseOptions(['--sidecar-analysis']).sidecarAnalysis, true);
  assert.equal(frozen.parseOptions(['--sidecar-analysis']).sidecarAnalysis, true);
  for (const productionDispatch of [false, undefined, 1]) {
    const runtime = terminalRuntime();
    assert.throws(() => fixedPlay(runtime, { ...OPTIONS, productionDispatch, sidecarAnalysis: true }), /sidecar.*production/i);
    assert.equal(runtime.observed.length, 0);
  }
  for (const flag of ['true', 1, null]) {
    assert.throws(() => fixedPlay(terminalRuntime(), { ...OPTIONS, sidecarAnalysis: flag }), /sidecar.*boolean/i);
  }
  const generic = { ...OPTIONS, productionDispatch: false };
  assert.deepEqual(fixedPlay(terminalRuntime(), generic), fixedPlay(terminalRuntime(), { ...generic, sidecarAnalysis: false }));
});

test('worker config and aggregation bind native sidecar flag and exact harness source fingerprint', () => {
  const resources = { nodes: 1, candidates: 1, profile: 'v25', maxPlies: 4 };
  const options = { pairs: 1, workers: 1, minimumGames: 2, seed: OPTIONS.seed, resources, targetWinRate: 0, sidecarAnalysis: true };
  const identity = { candidate: { engineVersion: 'candidate-test', runtimeFingerprint: `sha256:${'a'.repeat(64)}` },
    control: { engineVersion: 'control-test', runtimeFingerprint: `sha256:${'b'.repeat(64)}` }, harnessSourceFingerprint: HASH };
  const assignments = [{ shardId: 0, pairIndices: [0] }];
  const results = [1, 2].map(leg => ({ game: leg, pair: 1, leg, botColor: leg === 1 ? 'white' : 'dark',
    controlColor: leg === 1 ? 'dark' : 'white', winner: leg === 1 ? 'white' : 'dark', botWon: true,
    streamSeeds: diceStreamSeeds(options.seed, 0), productionDispatch: true,
    productionPolicyWeights: { homeEntry: 145000 }, sidecarAnalysis: true }));
  const canonical = { shardId: 0, pairIndices: [0], completed: true, seed: options.seed, resources,
    candidate: identity.candidate, control: identity.control, results,
    sidecarAnalysis: true, harnessSourceFingerprint: HASH };
  const config = { shardId: 0, pairIndices: [0], resources, options: { ...options },
    candidateRuntimeDirectory: '/tmp/candidate', controlRuntimeDirectory: '/tmp/control',
    expectedCandidateVersion: 'candidate-test', expectedControlVersion: 'control-test',
    sidecarAnalysis: true, harnessSourceFingerprint: HASH };
  assert.doesNotThrow(() => validateWorkerConfig(config));
  for (const patch of [{ sidecarAnalysis: 'true' }, { sidecarAnalysis: false },
    { harnessSourceFingerprint: 'invalid' }, { harnessSourceFingerprint: null },
    { harnessSourceFingerprint: { toString: () => HASH } }]) {
    assert.throws(() => validateWorkerConfig({ ...config, ...patch }), /sidecar|harness/i);
  }
  const aggregate = report => army.aggregateArmyReports({ options, identity, assignments, shardReports: [report] });
  const accepted = aggregate(canonical);
  assert.equal(accepted.completion.complete, true);
  assert.equal(accepted.methodology.sidecarAnalysis, true);
  assert.equal(accepted.harnessSourceFingerprint, HASH);
  for (const patch of [{ sidecarAnalysis: false }, { sidecarAnalysis: 'true' }, { harnessSourceFingerprint: `sha256:${'d'.repeat(64)}` }]) {
    const rejected = aggregate({ ...canonical, ...patch });
    assert.equal(rejected.completion.complete, false);
    assert.equal(rejected.summary.completedGames, 0, 'mismatched harness/ledger reports never contribute outcomes');
  }
  const alteredLeg = structuredClone(canonical);
  alteredLeg.results[0].sidecarAnalysis = false;
  assert.equal(aggregate(alteredLeg).completion.complete, false);
});
