const fs = require("fs");
const path = require("path");
const { randomUUID, createHash } = require("crypto");

const ROOT = path.join(__dirname, "..");
const OUTPUT = path.join(ROOT, "long-bot-engine.js");
const SOURCES = [
  "bot-engine/long/metrics.ts",
  "bot-engine/long/evaluator.ts",
  "bot-engine/long/analysis.ts",
  "bot-engine/long/engine.ts",
  "bot-engine/long/nardu-game-adapter.ts",
  "bot-engine/long/browser.ts",
];
// An explicit learning alias, never a rewrite of the actual source-derived ID.
// Every source digest is reviewed and pinned, including the compatibility
// wrapper itself. A one-byte change anywhere removes the alias.
const HISTORY_FREE_LEARNING_SOURCES = Object.freeze({
  'bot-engine/long/metrics.ts': '8b9f767c67c07071f9deae7c43928f32aab35510f7b8477541ade18efd222d31',
  'bot-engine/long/evaluator.ts': '60174f290cb93994c6ef871f40e1df537aba760197740317d8a7aaf996efbab6',
  'bot-engine/long/analysis.ts': '3b375ae2403a15fae1224e72d9c19b683101215e2c4d2f3cd0ea63eada2e4fe0',
  'bot-engine/long/engine.ts': 'f920632e9a62045831f3fab9e326b65386c0c00c7f93c5ee1b8cff7d796f423f',
  'bot-engine/long/nardu-game-adapter.ts': 'ded05d6d4a39d1e4df201a1da634141911f04f9e2935ac694ea489e3c4647c0e',
  'bot-engine/long/browser.ts': '6962608b7327e7fe12f6a79f0935c04995693859fd91a88f9a6d701579da9213',
  'game.js': '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',
  'strong-bot.js': '96d05e36acbf4591cfbb40509f2e9a1d84e1720f1736c0cc905c745db1c10951',
});
const HISTORICAL_LEARNING_POLICY_ID = 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';
const PREVIOUS_PRODUCTION_POLICY_ID = '4aede916c0f3a219e84582d3a8277f50b1041d6b7ae541bff7b807c42c82f526';
const PREVIOUS_LIVE_DOUBLES_POLICY_ID = '6109e41cae1c8711aed43c7e2f104d621beab314c0e6bcdf277901b2f0c4d690';
const PREVIOUS_TACTICAL_LIVE_POLICY_ID = '6c8c2e58287d73f855e4bb5b34fcee4f1e4eec91bb4c2c927370f50ad781fe89';
const PREVIOUS_JSYS_HOME_PRIORITY_POLICY_ID = '541f4c011df371fe8201de56edd189d49ab40c18bf216c2c4b3dc080cf0733aa';
const PREVIOUS_COMPLETE_JSYS_HOME_PRIORITY_POLICY_ID = '904e7062dcb499ed120ab92d3818e1b77227d5df51c8dfdb55d05f238ba52d6a';
const PREVIOUS_LIVE_JSYS_POLICY_ID = 'c64f47e25f0580f7a42f11c0adf01b42bf60739a4c925039ed33c4d7339049b9';

function writeOutputAtomically(output, contents, fileSystem = fs) {
  const temporaryOutput = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fileSystem.writeFileSync(temporaryOutput, contents);
    fileSystem.renameSync(temporaryOutput, output);
  } finally {
    try {
      fileSystem.unlinkSync(temporaryOutput);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, "")
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, "")
    .replace(/^export\s+(?=(const|function|class))/gm, "")
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, "");
}

function readPolicySourceEntries(root = ROOT) {
  return [...SOURCES, 'game.js', 'strong-bot.js'].map(file => [file, fs.readFileSync(path.join(root, file))]);
}

function policyImplementationId(entries = readPolicySourceEntries()) {
  const hash = createHash('sha256');
  hash.update('nardu/long-bot-policy-implementation/v1\0');
  for (const [name, bytes] of entries) {
    hash.update(name.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function learningCompatibility(entries = readPolicySourceEntries()) {
  const names = [...SOURCES, 'game.js', 'strong-bot.js'];
  if (entries.length !== names.length || entries.some(([name, bytes], index) => name !== names[index]
    || createHash('sha256').update(bytes).digest('hex') !== HISTORY_FREE_LEARNING_SOURCES[name])) return null;
  return Object.freeze({ schema: 'long-v35-history-free-learning-compat-v1',
    policyImplementationId: policyImplementationId(entries), learningPolicyImplementationId: HISTORICAL_LEARNING_POLICY_ID,
    compatiblePolicyImplementationIds: Object.freeze([
      HISTORICAL_LEARNING_POLICY_ID,
      PREVIOUS_PRODUCTION_POLICY_ID,
      PREVIOUS_LIVE_DOUBLES_POLICY_ID,
      PREVIOUS_TACTICAL_LIVE_POLICY_ID,
      PREVIOUS_JSYS_HOME_PRIORITY_POLICY_ID,
      PREVIOUS_COMPLETE_JSYS_HOME_PRIORITY_POLICY_ID,
      PREVIOUS_LIVE_JSYS_POLICY_ID,
    ]),
    sourceFingerprints: Object.freeze(Object.fromEntries(names.map(name => [name, `sha256:${HISTORY_FREE_LEARNING_SOURCES[name]}`]))) });
}

function renderLongBotBundle(sourceEntries = readPolicySourceEntries()) {
  const sourceBytes = new Map(sourceEntries);
  const implementationId = policyImplementationId(sourceEntries);
  const compatibility = learningCompatibility(sourceEntries);
  const compatibilityLine = compatibility
    ? `\n  const NARDU_LONG_BOT_LEARNING_COMPATIBILITY = Object.freeze({ ...${JSON.stringify(compatibility)}, compatiblePolicyImplementationIds: Object.freeze(${JSON.stringify(compatibility.compatiblePolicyImplementationIds)}), sourceFingerprints: Object.freeze(${JSON.stringify(compatibility.sourceFingerprints)}) });`
    : '';
  const body = SOURCES
    .map(file => {
      return `\n/* ${file} */\n${stripModuleSyntax(sourceBytes.get(file).toString('utf8'))}`;
    })
    .join("\n");

  return `/* generated from bot-engine/long/*.ts */\n(function () {\n  'use strict';\n  const NARDU_LONG_BOT_POLICY_IMPLEMENTATION_ID = '${implementationId}';${compatibilityLine}\n${body}\n}());\n`;
}

function buildLongBotEngine() {
  writeOutputAtomically(OUTPUT, renderLongBotBundle());
  console.log(`Long bot engine written to ${path.relative(ROOT, OUTPUT)}`);
}

if (require.main === module) buildLongBotEngine();

module.exports = buildLongBotEngine;
module.exports.writeOutputAtomically = writeOutputAtomically;
module.exports.readPolicySourceEntries = readPolicySourceEntries;
module.exports.policyImplementationId = policyImplementationId;
module.exports.learningCompatibility = learningCompatibility;
module.exports.HISTORY_FREE_LEARNING_SOURCES = HISTORY_FREE_LEARNING_SOURCES;
module.exports.SOURCES = Object.freeze([...SOURCES]);
module.exports.renderLongBotBundle = renderLongBotBundle;
