'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const root = path.join(__dirname, '..');
const load = file => import(pathToFileURL(path.join(root, 'bot-engine/long', file)).href);

function state(dark, white, overrides = {}) {
  return {
    variant: 'long', turn: 'dark', phase: 'move', dice: [3, 2], rolled: [3, 2],
    points: Object.fromEntries([
      ...Object.entries(dark).map(([p, count]) => [p, { color: 'dark', count }]),
      ...Object.entries(white).map(([p, count]) => [p, { color: 'white', count }]),
    ]),
    off: { dark: 0, white: 0 }, bar: { dark: 0, white: 0 }, history: [], turnMoves: [],
    headPlayedThisTurn: { dark: false, white: false }, firstMoveDone: { dark: true, white: true },
    ...overrides,
  };
}

test('situation recognizes a pip deficit and a trapped rear checker despite a pip lead', async () => {
  const { assessLongBotSituation } = await load('analysis.ts');
  const { pipsFor } = await load('metrics.ts');
  const trailing = state({ 12: 15 }, { 17: 15 });
  assert.equal(assessLongBotSituation(trailing, 'dark').mode, 'counterplay');
  assert.equal(assessLongBotSituation(trailing, 'white', 'dark').mode, 'protect');
  // Dark is far ahead in pips, but its rear checker faces a six-point fence.
  const trapped = state({ 12: 1, 13: 14 }, { 11: 3, 10: 3, 9: 3, 8: 2, 7: 2, 6: 2 });
  assert.ok(pipsFor(trapped, 'dark') < pipsFor(trapped, 'white'));
  const assessment = assessLongBotSituation(trapped, 'dark');
  assert.ok(assessment.ownTurns > pipsFor(trapped, 'dark') / (49 / 6) + 3);
  assert.ok(assessment.equity < assessLongBotSituation(
    state({ 11: 1, 13: 14 }, { 12: 3, 10: 3, 9: 3, 8: 2, 7: 2, 6: 2 }), 'dark',
  ).equity);
  const opposite = assessLongBotSituation(trapped, 'white', 'dark');
  assert.ok(Math.abs(opposite.equity + assessment.equity) < 1e-12);
});

test('tail policy seeks counterplay when behind and protects the lead', async () => {
  const { adaptiveReplyUtility } = await load('analysis.ts');
  const steady = { expectedEquity: -0.3, lowerTailEquity: -0.35, upperTailEquity: -0.25 };
  const chance = { expectedEquity: -0.3, lowerTailEquity: -0.5, upperTailEquity: 0.1 };
  assert.ok(adaptiveReplyUtility(steady, { comebackPressure: 0 })
    > adaptiveReplyUtility(chance, { comebackPressure: 0 }));
  assert.ok(adaptiveReplyUtility(chance, { comebackPressure: 1 })
    > adaptiveReplyUtility(steady, { comebackPressure: 1 }));
});

test('opponent evaluation finds a winning reply in either move order and requires all dice outcomes', async () => {
  const { analyzeOpponentReplies, assessLongBotSituation, createAnalysisBudget } = await load('analysis.ts');
  const { mergeWeights } = await load('evaluator.ts');
  const position = state({ 12: 15 }, { 17: 15 });
  const choices = () => [12, 11].map(point => ({
    after: state({ [point]: 15 }, { 17: 15 }), score: 0, features: {},
  }));
  for (const reversed of [false, true]) {
    const adapter = {
      legalSequences() {
        const replies = [[{ from: 17, to: 16, die: 1 }], [{ from: 17, to: 0, die: 2 }]];
        return reversed ? replies.reverse() : replies;
      },
      applySequence(before, sequence) {
        // Synthetic terminal branches isolate opponent choice from the real
        // move generator, which is exercised by the requested-room fixtures.
        return sequence[0].die === 2
          ? { ...before, winner: 'white', off: { dark: 0, white: 15 } }
          : { ...before, winner: 'dark', off: { dark: 15, white: 0 } };
      },
    };
    const candidates = choices();
    analyzeOpponentReplies(adapter, 'dark', candidates, mergeWeights(), createAnalysisBudget(42), {
      expandDoubles: true, situation: assessLongBotSituation(position, 'dark'),
    });
    for (const candidate of candidates) {
      assert.equal(candidate.tactical.expectedEquity, -1);
      assert.equal(candidate.tactical.distributionWeight, 36);
      assert.equal(candidate.tactical.plies, 2);
      assert.ok(candidate.tactical.expectedSelfEvaluation < 0);
      assert.ok(candidate.tactical.expectedOpponentEvaluation > 0);
    }
    const incomplete = choices();
    analyzeOpponentReplies(adapter, 'dark', incomplete, mergeWeights(), createAnalysisBudget(41), {
      expandDoubles: true, situation: assessLongBotSituation(position, 'dark'),
    });
    assert.ok(incomplete.every(candidate => !candidate.tactical));
  }
});

test('a creative plan gets a bounded comparison slot, never an automatic selection', async () => {
  const { reserveAdaptiveCounterplay } = await load('engine.ts');
  const position = state({ 12: 15 }, { 17: 15 });
  const candidate = (p, equity, score) => ({ after: state({ [p]: 15 }, { 17: 15 }), score,
    features: { positionEquityAfter: equity, resultSafetyAfter: 0, missedKoksRescue: 0 } });
  const baseline = candidate(12, -0.5, 100), defense = candidate(11, -0.4, 90);
  const creative = candidate(9, -0.2, 20);
  const ranked = [baseline, defense, creative];
  const result = reserveAdaptiveCounterplay(position, 'dark', [baseline, defense], ranked,
    { mode: 'counterplay' }, 2);
  assert.deepEqual(result.slice(0, 2), [baseline, creative]);
  assert.equal(creative.features.counterplayTacticalReservation, 1);
  assert.deepEqual(ranked.map(c => c.score), [100, 90, 20]);
  assert.deepEqual(reserveAdaptiveCounterplay(position, 'dark', [baseline, defense], ranked,
    { mode: 'protect' }, 2), [baseline, defense]);
});

test('counterplay requires comparable complete replies and rejects hope with a worse mean', async () => {
  const { prioritizeAdaptiveCounterplay } = await load('engine.ts');
  const position = state({ 12: 10, 9: 5 }, { 17: 15 });
  const candidate = (p, score, utility) => ({ after: state({ [p]: 15 }, { 17: 15 }), score,
    features: { resultSafetyAfter: 0, missedKoksRescue: 0 }, tactical: {
      decisionModel: 'heuristic-turn-equity-v1', distributionComplete: true,
      rolls: 21, distributionWeight: 36, doublesExpanded: true, plies: 2,
      expectedEquity: -0.5, lowerTailEquity: -0.6, upperTailEquity: -0.2,
      worstEquity: -0.7, adaptiveUtility: utility,
    } });
  for (const mutate of [c => { c.tactical.rolls = 20; }, c => { c.tactical.plies = 3; },
    c => { c.tactical.expectedEquity = -0.7; }, c => { c.features.missedKoksRescue = 1; },
    c => { c.tactical.adaptiveUtility = NaN; }]) {
    const baseline = candidate(12, 100, -0.5), creative = candidate(9, 20, -0.4);
    mutate(creative);
    assert.equal(prioritizeAdaptiveCounterplay(position, 'dark', [baseline],
      [baseline, creative], { mode: 'counterplay' })[0], baseline);
  }
  const baseline = candidate(12, 100, -0.5), creative = candidate(9, 20, -0.4);
  assert.equal(prioritizeAdaptiveCounterplay(position, 'dark', [baseline],
    [baseline, creative], { mode: 'counterplay' })[0], creative);
});

test('real hard dispatcher records self and opponent evaluations on every fair dice outcome', async () => {
  const { renderLongBotBundle } = require('../scripts/build-long-bot-engine');
  const context = vm.createContext({ window: {}, console, Date, Math });
  for (const source of [fs.readFileSync(path.join(root, 'game.js'), 'utf8'),
    renderLongBotBundle(), fs.readFileSync(path.join(root, 'strong-bot.js'), 'utf8')]) {
    vm.runInContext(source, context);
  }
  const engine = context.window.NarduLongBotEngine;
  const position = state({ 12: 10, 9: 5 }, { 17: 15 });
  const before = JSON.stringify(position);
  const moves = context.window.NarduStrongBot.plan(position);
  assert.ok(moves.length > 0);
  assert.equal(JSON.stringify(position), before);
  const decision = engine.consumeLastDecision();
  assert.equal(decision.replayInput.runtime.strategyProfile, 'v26');
  assert.equal(decision.selected.features.decisionMode, 'counterplay');
  const tactic = decision.selected.tactical;
  assert.equal(tactic.decisionModel, 'heuristic-turn-equity-v1');
  assert.equal(tactic.distributionComplete, true);
  assert.equal(tactic.distributionWeight, 36);
  for (const field of ['selfEvaluation', 'opponentEvaluation', 'expectedSelfEvaluation',
    'expectedOpponentEvaluation', 'expectedEquity', 'adaptiveUtility']) {
    assert.ok(Number.isFinite(tactic[field]), field);
  }
  assert.ok(decision.selected.features.analysisNodesUsed <= 480);
  const repeated = context.window.NarduStrongBot.plan(position);
  assert.equal(JSON.stringify(repeated), JSON.stringify(moves));
});

test('reviewer accepts the adaptive decision envelope and retains exact earlier replay policies', () => {
  const worker = require('../scripts/long-bot-causal-worker');
  const ordinary = worker.PRODUCTION_POLICY;
  const doubles = worker.PRODUCTION_LIVE_DOUBLES_POLICY;
  assert.equal(ordinary.strategyProfile, 'v26');
  const decision = (runtime, rolled = [3, 2]) => ({
    stateSnapshotV2: { rolled, dice: rolled }, replayInput: { runtime },
  });
  assert.equal(worker.archivedPolicyFailure(decision(ordinary)), '');
  assert.equal(worker.archivedPolicyFailure(decision(doubles, [2, 2, 2, 2])), '');
  assert.equal(worker.archivedPolicyFailure(decision({ ...ordinary, strategyProfile: 'v25' })), '');
  assert.equal(worker.archivedPolicyFailure(decision({ ...doubles, strategyProfile: 'v25' }, [2, 2, 2, 2])), '');
  assert.equal(worker.archivedPolicyFailure(decision({ ...ordinary, analysisNodeBudget: 481 })),
    'unapproved-production-policy');
  assert.equal(worker.archivedPolicyFailure(decision({ ...ordinary, strategyProfile: 'v27' })),
    'unapproved-production-policy');
});

test('requested-room positions produce legal, deterministic plans inside the real live budgets', () => {
  const { renderLongBotBundle } = require('../scripts/build-long-bot-engine');
  const { positions } = require('./fixtures/long-bot-adaptive-room-positions.json');
  const context = vm.createContext({ window: {}, console, Date, Math });
  for (const source of [fs.readFileSync(path.join(root, 'game.js'), 'utf8'),
    renderLongBotBundle(), fs.readFileSync(path.join(root, 'strong-bot.js'), 'utf8')]) {
    vm.runInContext(source, context);
  }
  const { NarduStrongBot: bot, NarduLongBotEngine: engine, NarduGame: game } = context.window;
  for (const row of positions) {
    const position = { ...row.state, history: [] };
    const original = JSON.stringify(position);
    const plan = bot.plan(position, { liveTurnLatencyBudget: true });
    const decision = engine.consumeLastDecision();
    assert.ok(plan.length > 0, row.room);
    assert.equal(JSON.stringify(position), original);
    const executed = JSON.parse(original);
    for (const move of plan) {
      assert.ok(game.isValidMove(executed, move.from, move.die), row.room);
      game.applyMove(executed, move.from, move.die, { autoEnd: false });
    }
    const selected = decision.selected;
    assert.equal(selected.features.decisionMode, 'counterplay');
    assert.equal(selected.tactical.distributionComplete, true);
    assert.equal(selected.tactical.distributionWeight, 36);
    const double = position.rolled.length === 4;
    assert.equal(selected.features.analysisNodeBudget, double ? 58 : 480);
    assert.ok(selected.features.analysisNodesUsed <= selected.features.analysisNodeBudget);
    assert.equal(JSON.stringify(bot.plan(position, { liveTurnLatencyBudget: true })), JSON.stringify(plan));
  }
});
