'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const builder = require('../scripts/build-long-bot-engine');
const { verifyLongBotLearningCompatibility, ORIGINAL_LEARNING_POLICY } = require('../scripts/verify-long-bot-learning-compatibility');
const ROOT = path.join(__dirname, '..');

test('Pages preflight requires explicit old-learning compatibility while binding actual implementation source bytes', () => {
  const sourceEntries = builder.readPolicySourceEntries();
  const engineSource = builder.renderLongBotBundle(sourceEntries);
  const verified = verifyLongBotLearningCompatibility({ sourceEntries, engineSource });
  assert.equal(verified.required, true);
  assert.equal(verified.policyImplementationId, builder.policyImplementationId(sourceEntries));
  assert.equal(verified.learningPolicyImplementationId, ORIGINAL_LEARNING_POLICY);
  assert.notEqual(verified.policyImplementationId, ORIGINAL_LEARNING_POLICY);
  const published = fs.readFileSync(path.join(ROOT, 'long-bot-engine.js'), 'utf8');
  assert.equal(published, engineSource);
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
