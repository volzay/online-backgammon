const fs = require("fs");
const path = require("path");
const buildLongBotEngine = require("./build-long-bot-engine");
const buildShortBotEngine = require("./build-short-bot-engine");
const buildFairDiceCrypto = require("./build-fair-dice-crypto");
const buildLongNeuralModel = require("./build-long-neural-model");
const { verifyLongBotLearningCompatibility } = require("./verify-long-bot-learning-compatibility");
const fairDiceBuildConfig = require("./fair-dice-build-config");
// Validate pins before replacing dist or regenerating any assets.
const FAIR_DICE_CONFIG = fairDiceBuildConfig();

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const DEFAULT_SUPABASE_URL = "https://api.201-51-7-193.sslip.io";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_kWyPnUGXGMJ0afLvIdRNNr_j7tZjhXC";
const DEFAULT_SITE_BASE_URL = "https://volzay.github.io/online-backgammon";
const DEFAULT_ADMIN_EMAILS = "volzay@yandex.ru,openthedoorcap@gmail.com";
const BUILD_VERSION = (process.env.GITHUB_SHA || Date.now().toString(36)).slice(0, 12);

const STATIC_FILES = [
  "index.html",
  "login.html",
  "register.html",
  "rules.html",
  "room.html",
  "settings.html",
  "homegate.html",
  "verify-game.html",
  "styles.css",
  "homegate.css",
  "verify-game.css",
  "roll-verification.css",
  "app.js",
  "runtime-config.js",
  "supabase-client.js",
  "auth-client.js",
  "rooms-client.js",
  "game.js",
  "game-controller.js",
  "fair-dice.js",
  "fair-dice-crypto.js",
  "game-verifier.js",
  "roll-proof-transfer.js",
  "verify-game-ui.js",
  "roll-verification-ui.js",
  "long-bot-engine.js",
  "short-bot-engine.js",
  "short-bot-wildbg-client.js",
  "short-bot-wildbg-worker.js",
  "strong-bot.js",
  "lib/long-bot-neural.js",
  "vendor/long-neural/model.js",
  "long-neural-bot.js",
  "bot.js",
  "board-engine.js",
  "dice-engine.js",
  "dice-webgl.js",
  "sound.js",
  "rating.js",
  "admin-room-data.js",
  "homegate.js",
  "vendor/wildbg/wildbg_wasm_browser.js",
  "vendor/wildbg/wildbg_wasm_bg.wasm",
  "vendor/wildbg/LICENSE-MIT",
  "vendor/wildbg/LICENSE-APACHE",
  "vendor/wildbg/NOTICE.md",
];

function copyFile(file) {
  const source = path.join(ROOT, file);
  if (!fs.existsSync(source)) return;
  const target = path.join(DIST, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function versionStaticAssets() {
  const htmlFiles = STATIC_FILES.filter(file => file.endsWith(".html"));
  const assetFiles = STATIC_FILES
    .filter(file => file.endsWith(".js") || file.endsWith(".css"))
    .map(file => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!assetFiles.length) return;
  const assetPattern = new RegExp(`(src|href)="(${assetFiles.join("|")})(?:\\?v=[^"]*)?"`, "g");
  htmlFiles.forEach(file => {
    const target = path.join(DIST, file);
    if (!fs.existsSync(target)) return;
    const html = fs.readFileSync(target, "utf8").replace(assetPattern, `$1="$2?v=${BUILD_VERSION}"`);
    fs.writeFileSync(target, html);
  });
}

function writeRuntimeConfig() {
  const config = {
    supabaseUrl: process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
    siteBaseUrl: process.env.SITE_BASE_URL || DEFAULT_SITE_BASE_URL,
    adminEmails: process.env.ADMIN_EMAILS || DEFAULT_ADMIN_EMAILS,
    deployTarget: "github-pages",
    ...FAIR_DICE_CONFIG,
  };
  const body = `window.NARDU_ENV = ${JSON.stringify(config, null, 2)};\n`;
  fs.writeFileSync(path.join(DIST, "runtime-config.js"), body);
}

buildLongBotEngine();
// Never publish a performance-only rules change that drops existing lessons.
// This preserves actual source identity and checks the explicit learning alias.
verifyLongBotLearningCompatibility();
buildShortBotEngine();
buildFairDiceCrypto();
buildLongNeuralModel();
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
STATIC_FILES.forEach(copyFile);
versionStaticAssets();
writeRuntimeConfig();
fs.writeFileSync(path.join(DIST, ".nojekyll"), "");
console.log(`GitHub Pages build written to ${path.relative(ROOT, DIST)}/`);
