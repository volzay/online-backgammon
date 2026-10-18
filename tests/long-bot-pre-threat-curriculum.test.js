'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { headPressure, preThreatDecisionHints } = require('../lib/long-bot-review-curriculum');
const { selectReviewDecisionIndexes, parseOptions, freezeTrainingRuntime } = require('../scripts/train-long-bot-causal-army');
const { readRuntimeSnapshot } = require('../scripts/simulate-long-bot-regression');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function decision(blocked, color = 'dark') {
  const head = color === 'dark' ? 12 : 24;
  const oppositeHead = color === 'dark' ? 24 : 12;
  const opponent = color === 'dark' ? 'white' : 'dark';
  const points = { [head]: { color, count: 15 }, [oppositeHead]: { color: opponent, count: 15 - blocked } };
  for (let step = 1; step <= blocked; step += 1) points[head - step] = { color: opponent, count: 1 };
  return { actor: 'bot', color, source: 'engine', engineVersion: 'long-analytic-v35', choiceCount: 3,
    selected: { features: {} }, stateSnapshotV2: { schema: 'long-state-v2', variant: 'long',
      phase: 'move', turn: color, points, off: { white: 0, dark: 0 }, bar: { white: 0, dark: 0 } } };
}
function game(color = 'dark') {
  return { bot_color: color, engine_version: 'long-analytic-v35',
    decisions: [decision(1, color), decision(3, color), decision(4, color), decision(6, color)] };
}

test('pre-threat curriculum reviews the actual preceding choice before a fence worsens for either color', () => {
  for (const color of ['white', 'dark']) {
    const original = game(color);
    const frozen = structuredClone(original);
    assert.deepEqual(headPressure(original, original.decisions[1]), { maximumBlocked: 3, checkers: 15 });
    assert.deepEqual(preThreatDecisionHints(original).map(h => [h.index, h.triggerIndex]), [[0, 1], [1, 2], [2, 3]]);
    const selection = selectReviewDecisionIndexes(original, { reviewSelection: 'pre-threat', reviewWorkDecisions: 2 });
    assert.deepEqual(selection.indexes, [0, 1]);
    assert.equal(selection.outcomeUsed, false);
    assert.equal(selection.riskRole, 'curriculum-only');
    assert.deepEqual(original, frozen);
    const lastHint = preThreatDecisionHints(original).at(-1);
    assert.equal(lastHint.signal, 'before-closed-head-fence');
  }
});

test('loss severity, evaluator scores and attached client regret cannot reorder the curriculum', () => {
  const source = game();
  const before = preThreatDecisionHints(source);
  source.winner = 'dark'; source.result_type = 'koks';
  source.decisions.forEach(d => { d.selected.score = -1e100; d.selected.features = { opponentFenceRunBefore: 1000 };
    d.regret = 1e100; d.alternatives = [{ score: 1e100 }]; });
  assert.deepEqual(preThreatDecisionHints(source), before);
});

test('invalid/recovery bot snapshots break adjacency and forced predecessors receive no hint', () => {
  for (const mutate of [d => { d.source = 'history-recovery'; },
    d => { d.stateSnapshotV2.points[12].count = '15'; },
    d => { d.stateSnapshotV2.turn = 'white'; }]) {
    const source = game(); mutate(source.decisions[1]);
    assert.deepEqual(preThreatDecisionHints(source).map(h => h.index), [2]);
  }
  const source = game(); source.decisions[0].choiceCount = 1;
  assert.deepEqual(preThreatDecisionHints(source).map(h => h.index), [1, 2]);
  source.decisions[1].choiceCount = '3';
  assert.deepEqual(preThreatDecisionHints(source).map(h => h.index), [2]);
});

test('predecessors retain original indexes across opponent rows and reject unknown generations/null rows', () => {
  const source = game();
  source.decisions.splice(1, 0, { actor: 'player', color: 'white' });
  assert.deepEqual(preThreatDecisionHints(source).map(h => [h.index, h.triggerIndex]), [[0, 2], [2, 3], [3, 4]]);
  source.engine_version = 'long-analytic-v34';
  assert.deepEqual(preThreatDecisionHints(source), []);
  const malformed = game(); malformed.decisions[1] = null;
  assert.deepEqual(preThreatDecisionHints(malformed).map(h => h.index), [2]);
});

test('pre-threat option is bounded and falls back without inventing predecessor hints', () => {
  assert.equal(parseOptions(['--review-selection', 'pre-threat']).reviewSelection, 'pre-threat');
  const source = game(); source.decisions = [decision(1), decision(1)];
  const selection = selectReviewDecisionIndexes(source, { reviewSelection: 'pre-threat', reviewWorkDecisions: 4 });
  assert.deepEqual(selection.indexes, [1, 0]);
  assert.deepEqual(selection.predecessorHints, []);
  assert.throws(() => selectReviewDecisionIndexes(game(), { reviewSelection: 'pre-threat', reviewWorkDecisions: 9 }));
});

test('the immutable training artifact preserves the exact scheduling dependency', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-threat-closure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const frozen = freezeTrainingRuntime(readRuntimeSnapshot(path.join(__dirname, '..')), directory);
  const target = 'lib/long-bot-review-curriculum.js';
  assert.ok(frozen.files.some(file => file.name === target));
  assert.ok(fs.readFileSync(path.join(frozen.directory, target)).equals(fs.readFileSync(path.join(__dirname, '..', target))));
  assert.equal(fs.statSync(path.join(frozen.directory, target)).mode & 0o777, 0o444);
});
