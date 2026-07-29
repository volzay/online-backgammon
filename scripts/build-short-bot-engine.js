const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUTPUT = path.join(ROOT, "short-bot-engine.js");
const SOURCES = [
  "bot-engine/short/metrics.ts",
  "bot-engine/short/engine.ts",
  "bot-engine/short/nardu-game-adapter.ts",
  "bot-engine/short/browser.ts",
];

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+type[\s\S]*?;\s*$/gm, "")
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/gm, "")
    .replace(/^export\s+(?=(const|function|class))/gm, "")
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, "");
}

function buildShortBotEngine() {
  const body = SOURCES.map(file => (
    `\n/* ${file} */\n${stripModuleSyntax(fs.readFileSync(path.join(ROOT, file), "utf8"))}`
  )).join("\n");
  fs.writeFileSync(OUTPUT, `/* generated from bot-engine/short/*.ts */\n(function () {\n  'use strict';\n${body}\n}());\n`);
  console.log(`Short bot engine written to ${path.relative(ROOT, OUTPUT)}`);
}

if (require.main === module) buildShortBotEngine();
module.exports = buildShortBotEngine;
