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

function renderLongBotBundle(sourceEntries = readPolicySourceEntries()) {
  const sourceBytes = new Map(sourceEntries);
  const implementationId = policyImplementationId(sourceEntries);
  const body = SOURCES
    .map(file => {
      return `\n/* ${file} */\n${stripModuleSyntax(sourceBytes.get(file).toString('utf8'))}`;
    })
    .join("\n");

  return `/* generated from bot-engine/long/*.ts */\n(function () {\n  'use strict';\n  const NARDU_LONG_BOT_POLICY_IMPLEMENTATION_ID = '${implementationId}';\n${body}\n}());\n`;
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
module.exports.SOURCES = Object.freeze([...SOURCES]);
module.exports.renderLongBotBundle = renderLongBotBundle;
