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
  'bot-engine/long/analysis.ts': '24f4135e29c84213f406a89d58f29b01c59d7a1e9f1b228f0dcd2f85a2f28932',
  'bot-engine/long/engine.ts': '2bd192f607f3aa1e82e55e27ae193b25557ad69f2a4658569d02d53adbe31f0b',
  'bot-engine/long/nardu-game-adapter.ts': 'f0f1d24d008238c409a8619b1a71e5ef165f995adc3e4594e46ad7c0cc88af08',
  'bot-engine/long/browser.ts': '09a8e00cc5893e3b2763a7dd553c530035a742691533f6fffbb7d47dcd993231',
  'game.js': '6561996b3d148e0a10a972347474c7be4332a891437e3d6565d36020f7520623',
  'strong-bot.js': '49d17327ad4bc93393e1cf76619279341b520984be9af023c5b550091fd96573',
});
const HISTORICAL_LEARNING_POLICY_ID = 'fcdc849c54cb2c12ba4fac25d6b8f4d623e70589674fd77bdb08b16381d46aa1';

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
    sourceFingerprints: Object.freeze(Object.fromEntries(names.map(name => [name, `sha256:${HISTORY_FREE_LEARNING_SOURCES[name]}`]))) });
}

function renderLongBotBundle(sourceEntries = readPolicySourceEntries()) {
  const sourceBytes = new Map(sourceEntries);
  const implementationId = policyImplementationId(sourceEntries);
  const compatibility = learningCompatibility(sourceEntries);
  const compatibilityLine = compatibility
    ? `\n  const NARDU_LONG_BOT_LEARNING_COMPATIBILITY = Object.freeze({ ...${JSON.stringify(compatibility)}, sourceFingerprints: Object.freeze(${JSON.stringify(compatibility.sourceFingerprints)}) });`
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
