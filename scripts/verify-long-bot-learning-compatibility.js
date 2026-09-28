'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const builder = require('./build-long-bot-engine');
const ROOT = path.join(__dirname, '..');
const OPTIMIZED_RULES = '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623';
const ORIGINAL_LEARNING_POLICY = 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';
const PREVIOUS_PRODUCTION_POLICY = '4aede916c0f3a219e84582d3a8277f50b1041d6b7ae541bff7b807c42c82f526';
const PREVIOUS_LIVE_DOUBLES_POLICY = '6109e41cae1c8711aed43c7e2f104d621beab314c0e6bcdf277901b2f0c4d690';
const PREVIOUS_TACTICAL_LIVE_POLICY = '6c8c2e58287d73f855e4bb5b34fcee4f1e4eec91bb4c2c927370f50ad781fe89';
const PREVIOUS_JSYS_HOME_PRIORITY_POLICY = '541f4c011df371fe8201de56edd189d49ab40c18bf216c2c4b3dc080cf0733aa';
const PREVIOUS_COMPLETE_JSYS_HOME_PRIORITY_POLICY = '904e7062dcb499ed120ab92d3818e1b77227d5df51c8dfdb55d05f238ba52d6a';
const PREVIOUS_LIVE_JSYS_POLICY = 'c64f47e25f0580f7a42f11c0adf01b42bf60739a4c925039ed33c4d7339049b9';

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
    || !Object.isFrozen(compatibility.compatiblePolicyImplementationIds)
    || !compatibility.compatiblePolicyImplementationIds.includes(PREVIOUS_PRODUCTION_POLICY)
    || !compatibility.compatiblePolicyImplementationIds.includes(PREVIOUS_LIVE_DOUBLES_POLICY)
    || !compatibility.compatiblePolicyImplementationIds.includes(PREVIOUS_TACTICAL_LIVE_POLICY)
    || !compatibility.compatiblePolicyImplementationIds.includes(PREVIOUS_JSYS_HOME_PRIORITY_POLICY)
    || !compatibility.compatiblePolicyImplementationIds.includes(PREVIOUS_COMPLETE_JSYS_HOME_PRIORITY_POLICY)
    || !compatibility.compatiblePolicyImplementationIds.includes(PREVIOUS_LIVE_JSYS_POLICY)
    || engine.acceptsLearningPolicyImplementationId?.(ORIGINAL_LEARNING_POLICY) !== true
    || engine.acceptsLearningPolicyImplementationId?.(PREVIOUS_PRODUCTION_POLICY) !== true
    || engine.acceptsLearningPolicyImplementationId?.(PREVIOUS_LIVE_DOUBLES_POLICY) !== true
    || engine.acceptsLearningPolicyImplementationId?.(PREVIOUS_TACTICAL_LIVE_POLICY) !== true
    || engine.acceptsLearningPolicyImplementationId?.(PREVIOUS_JSYS_HOME_PRIORITY_POLICY) !== true
    || engine.acceptsLearningPolicyImplementationId?.(PREVIOUS_COMPLETE_JSYS_HOME_PRIORITY_POLICY) !== true
    || engine.acceptsLearningPolicyImplementationId?.(PREVIOUS_LIVE_JSYS_POLICY) !== true
    || engine.acceptsLearningPolicyImplementationId?.(actualPolicy) !== true
    || engine.acceptsLearningPolicyImplementationId?.('0'.repeat(64)) !== false) {
    throw new Error('Optimized v35 rules must preserve audited causal learning before publication');
  }
  return { required: true, policyImplementationId: actualPolicy,
    learningPolicyImplementationId: ORIGINAL_LEARNING_POLICY };
}
module.exports = { verifyLongBotLearningCompatibility, OPTIMIZED_RULES, ORIGINAL_LEARNING_POLICY };
