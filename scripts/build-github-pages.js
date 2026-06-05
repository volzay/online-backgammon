const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const DEFAULT_SUPABASE_URL = "https://pzknykygxtbzdhuitzzh.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_MLLEF0G2GhSKSL7grWm-zg_FKHzDKNO";
const DEFAULT_SITE_BASE_URL = "https://volzay.github.io/online-backgammon";
const DEFAULT_ADMIN_EMAILS = "openthedoorcap@gmail.com";

const STATIC_FILES = [
  "index.html",
  "login.html",
  "register.html",
  "room.html",
  "settings.html",
  "homegate.html",
  "styles.css",
  "homegate.css",
  "app.js",
  "runtime-config.js",
  "supabase-client.js",
  "auth-client.js",
  "rooms-client.js",
  "game.js",
  "game-controller.js",
  "bot.js",
  "board-engine.js",
  "dice-engine.js",
  "dice-webgl.js",
  "sound.js",
  "rating.js",
  "homegate.js",
];

function copyFile(file) {
  const source = path.join(ROOT, file);
  if (!fs.existsSync(source)) return;
  const target = path.join(DIST, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function writeRuntimeConfig() {
  const config = {
    supabaseUrl: process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
    siteBaseUrl: process.env.SITE_BASE_URL || DEFAULT_SITE_BASE_URL,
    adminEmails: process.env.ADMIN_EMAILS || DEFAULT_ADMIN_EMAILS,
    deployTarget: "github-pages",
  };
  const body = `window.NARDU_ENV = ${JSON.stringify(config, null, 2)};\n`;
  fs.writeFileSync(path.join(DIST, "runtime-config.js"), body);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
STATIC_FILES.forEach(copyFile);
writeRuntimeConfig();
fs.writeFileSync(path.join(DIST, ".nojekyll"), "");
console.log(`GitHub Pages build written to ${path.relative(ROOT, DIST)}/`);
