'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const builder = require('../scripts/build-long-bot-engine');
const { verifyLongBotLearningCompatibility, ORIGINAL_LEARNING_POLICY,
  HISTORICAL_COMPATIBLE_RELEASE, CLEAR_FINAL_RACE_POLICY } = require('../scripts/verify-long-bot-learning-compatibility');
const ROOT = path.join(__dirname, '..');
const HISTORICAL_COMMIT = '31c8f3ee452b4b93ffb9bfd886aad3ba77d24ff3';
const historicalEntries = () => [...builder.SOURCES, 'game.js', 'strong-bot.js'].map(file => [
  file, execFileSync('git', ['show', `${HISTORICAL_COMMIT}:${file}`], { cwd: ROOT }),
]);

test('Pages preflight pins the new clear-race policy and rejects historical learning aliases', () => {
  const sourceEntries = builder.readPolicySourceEntries();
  const engineSource = builder.renderLongBotBundle(sourceEntries);
  const verified = verifyLongBotLearningCompatibility({ sourceEntries, engineSource });
  assert.equal(verified.required, true);
  assert.equal(verified.policyImplementationId, CLEAR_FINAL_RACE_POLICY);
  assert.equal(verified.learningPolicyImplementationId, CLEAR_FINAL_RACE_POLICY);
  assert.equal(verified.historicalAlias, false);
  assert.equal(builder.learningCompatibility(sourceEntries), null);
  const published = fs.readFileSync(path.join(ROOT, 'long-bot-engine.js'), 'utf8');
  assert.equal(published, engineSource);
});

test('the immutable previous release retains its own audited learning alias', () => {
  const sourceEntries = historicalEntries();
  assert.equal(builder.policyImplementationId(sourceEntries), HISTORICAL_COMPATIBLE_RELEASE);
  const verified = verifyLongBotLearningCompatibility({
    sourceEntries, engineSource: builder.renderLongBotBundle(sourceEntries),
  });
  assert.equal(verified.policyImplementationId, HISTORICAL_COMPATIBLE_RELEASE);
  assert.equal(verified.learningPolicyImplementationId, ORIGINAL_LEARNING_POLICY);
  assert.equal(verified.historicalAlias, true);
});

test('Pages preflight refuses the initial history-free build that would disable nonempty server learning', () => {
  const engineSource = execFileSync('git', ['show', '8e8b2146e2ec885b6c29444a0c3505195c0403b0:long-bot-engine.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.throws(() => verifyLongBotLearningCompatibility({ engineSource }), /preserve audited causal learning/);
});

test('a permissive policy predicate cannot pass publication by accepting arbitrary learning identities', () => {
  const sourceEntries = builder.readPolicySourceEntries();
  const engineSource = builder.renderLongBotBundle(sourceEntries)
    + '\nwindow.NarduLongBotEngine.acceptsLearningPolicyImplementationId = () => true;\n';
  assert.throws(() => verifyLongBotLearningCompatibility({ sourceEntries, engineSource }), /preserve audited causal learning/);
});

test('an unknown complete source identity cannot pass publication without explicit review', () => {
  const sourceEntries = builder.readPolicySourceEntries();
  const alteredEntries = sourceEntries.map(([name, bytes]) => [name, name === 'bot-engine/long/engine.ts'
    ? Buffer.concat([bytes, Buffer.from('\n// unaudited policy byte\n')]) : bytes]);
  assert.notEqual(builder.policyImplementationId(alteredEntries), CLEAR_FINAL_RACE_POLICY);
  assert.throws(() => verifyLongBotLearningCompatibility({
    sourceEntries: alteredEntries, engineSource: builder.renderLongBotBundle(alteredEntries),
  }), /preserve audited causal learning/);
});
