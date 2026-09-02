const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

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

function buildLongBotEngine() {
  const body = SOURCES
    .map(file => {
      const sourcePath = path.join(ROOT, file);
      return `\n/* ${file} */\n${stripModuleSyntax(fs.readFileSync(sourcePath, "utf8"))}`;
    })
    .join("\n");

  writeOutputAtomically(
    OUTPUT,
    `/* generated from bot-engine/long/*.ts */\n(function () {\n  'use strict';\n${body}\n}());\n`,
  );
  console.log(`Long bot engine written to ${path.relative(ROOT, OUTPUT)}`);
}

if (require.main === module) buildLongBotEngine();

module.exports = buildLongBotEngine;
module.exports.writeOutputAtomically = writeOutputAtomically;
