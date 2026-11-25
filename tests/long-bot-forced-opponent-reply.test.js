'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const load = file => import(pathToFileURL(path.join(root, 'bot-engine/long', file)).href);

// Synthetic adapter branches isolate mandatory-reply selection from the real
// game generator. No requested-room position or terminal outcome is a fixture.
function position() {
  return { variant: 'long', phase: 'move', turn: 'dark', dice: [3, 2], rolled: [3, 2],
    points: { 12: { color: 'dark', count: 15 }, 24: { color: 'white', count: 15 } },
    off: { dark: 0, white: 0 }, bar: { dark: 0, white: 0 },
    firstMoveDone: { dark: true, white: true }, headPlayedThisTurn: { dark: false, white: false },
    history: [], turnMoves: [] };
}

test('forced favorable replies are applied in balanced, protect and counterplay modes', async () => {
  const { analyzeOpponentReplies, createAnalysisBudget } = await load('analysis.ts');
  const { mergeWeights } = await load('evaluator.ts');
  for (const mode of ['balanced', 'protect', 'counterplay']) {
    const after = position();
    const candidates = [{ after, score: 0, features: {} }];
    const adapter = {
      legalSequences() { return [[{ from: 24, to: 23, die: 1 }]]; },
      applySequence(before) {
        // Every supplied reply improves our static evaluation. A real adapter
        // still owns legal transitions; this branch makes the selection error
        // observable without relying on a private archived board.
        return { ...before, winner: 'dark', points: { 23: { color: 'white', count: 15 } },
          off: { dark: 15, white: 0 } };
      },
    };
    analyzeOpponentReplies(adapter, 'dark', candidates, mergeWeights(), createAnalysisBudget(21), {
      expandDoubles: true, situation: { mode, comebackPressure: 0 },
    });
    assert.equal(candidates[0].tactical.rolls, 21);
    assert.equal(candidates[0].tactical.distributionWeight, 36);
    assert.equal(candidates[0].tactical.blockedProbability, 0);
    assert.equal(candidates[0].tactical.expectedEquity, 1, mode + ' must apply a forced reply');
    assert.equal(candidates[0].tactical.expectedOpponentPipGain, 15);
  }
});

test('a genuinely blocked opponent keeps its board and contributes no pip gain', async () => {
  const { analyzeOpponentReplies, createAnalysisBudget } = await load('analysis.ts');
  const { mergeWeights } = await load('evaluator.ts');
  const candidates = [{ after: position(), score: 0, features: {} }];
  analyzeOpponentReplies({ legalSequences: () => [], applySequence() { throw Error('No legal reply'); } },
    'dark', candidates, mergeWeights(), createAnalysisBudget(21), {
      expandDoubles: true, situation: { mode: 'balanced', comebackPressure: 0 },
    });
  assert.equal(candidates[0].tactical.blockedProbability, 1);
  assert.equal(candidates[0].tactical.expectedOpponentPipGain, 0);
});

test('native mandatory replies retain all pip progress even when they release our blockade', async () => {
  const { analyzeOpponentReplies, createAnalysisBudget } = await load('analysis.ts');
  const { mergeWeights } = await load('evaluator.ts');
  const { createNarduGameAdapter } = await load('nardu-game-adapter.ts');
  const { loadRuntime } = require('../scripts/generate-long-bot-shadow-replay');
  const { game } = loadRuntime();
  // Independent deterministic synthetic-board search: seed 481017, board 16.
  // Both armies have 15 checkers; this is not a requested-room board.
  const after = { ...position(), points: {
    1: { color: 'white', count: 2 }, 2: { color: 'dark', count: 1 },
    8: { color: 'white', count: 3 }, 11: { color: 'dark', count: 1 },
    14: { color: 'white', count: 2 }, 15: { color: 'dark', count: 3 },
    16: { color: 'dark', count: 5 }, 20: { color: 'white', count: 5 },
    22: { color: 'dark', count: 5 }, 24: { color: 'white', count: 3 },
  } };
  for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) {
    const dice = a === b ? [a, a, a, a] : [a, b];
    const reply = { ...after, turn: 'white', dice, rolled: dice };
    const legal = game.bestMoveSequences(reply, 'white');
    assert.ok(legal.length);
    for (const moves of legal) {
      assert.equal(moves.reduce((sum, move) => sum + move.die, 0), dice.reduce((x, y) => x + y, 0));
    }
  }
  for (const mode of ['balanced', 'protect', 'counterplay']) {
    const candidates = [{ after, score: 0, features: {} }];
    analyzeOpponentReplies(createNarduGameAdapter(game, { generatedSequenceFastPath: true }),
      'dark', candidates, mergeWeights(), createAnalysisBudget(21), {
        expandDoubles: true, situation: { mode, comebackPressure: 0 },
      });
    assert.ok(Math.abs(candidates[0].tactical.expectedOpponentPipGain - 49 / 6) < 1e-12, mode);
    assert.equal(candidates[0].tactical.blockedProbability, 0);
  }
});
