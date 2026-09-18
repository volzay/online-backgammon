'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const builder = require('./build-long-bot-engine');
const ROOT = path.join(__dirname, '..');
const OPTIMIZED_RULES = '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623';
const ORIGINAL_LEARNING_POLICY = 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';

function verifyLongBotLearningCompatibility({ sourceEntries = builder.readPolicySourceEntries(),
  engineSource = fs.readFileSync(path.join(ROOT, 'long-bot-engine.js'), 'utf8') } = {}) {
  const gameSource = new Map(sourceEntries).get('game.js');
  if (createHash('sha256').update(gameSource).digest('hex') !== OPTIMIZED_RULES) return { required: false };
  const context = vm.createContext({ window: {} });
  vm.runInContext(gameSource.toString('utf8'), context, { timeout: 3000 });
  vm.runInContext(engineSource, context, { timeout: 3000 });
  const engine = context.window.NarduLongBotEngine;
  const actualPolicy = builder.policyImplementationId(sourceEntries);
  const compatibility = engine?.learningCompatibility;
  if (engine?.version !== 'long-analytic-v35' || engine.policyImplementationId !== actualPolicy
    || !compatibility || !Object.isFrozen(compatibility)
    || compatibility.schema !== 'long-v35-history-free-learning-compat-v1'
    || compatibility.policyImplementationId !== actualPolicy
    || compatibility.learningPolicyImplementationId !== ORIGINAL_LEARNING_POLICY
    || engine.acceptsLearningPolicyImplementationId?.(ORIGINAL_LEARNING_POLICY) !== true
    || engine.acceptsLearningPolicyImplementationId?.(actualPolicy) !== true
    || engine.acceptsLearningPolicyImplementationId?.('0'.repeat(64)) !== false) {
    throw new Error('Optimized v35 rules must preserve audited causal learning before publication');
  }
  return { required: true, policyImplementationId: actualPolicy,
    learningPolicyImplementationId: ORIGINAL_LEARNING_POLICY };
}
module.exports = { verifyLongBotLearningCompatibility, OPTIMIZED_RULES, ORIGINAL_LEARNING_POLICY };
