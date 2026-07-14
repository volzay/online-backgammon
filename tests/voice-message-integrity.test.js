const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function source(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

test("voice recorders preserve one complete browser media container", () => {
  const room = source("room.html");
  const settings = source("settings.html");

  assert.match(room, /mediaRecorder\.start\(\);/);
  assert.match(settings, /friendMediaRecorder\.start\(\);/);
  assert.doesNotMatch(room, /mediaRecorder\.start\(1000\)|mediaRecorder\?\.requestData/);
  assert.doesNotMatch(settings, /friendMediaRecorder\.start\(1000\)|friendMediaRecorder\?\.requestData/);
});

test("all remote chat paths validate the full base64 audio payload consistently", () => {
  const server = source("server.js");
  const rooms = source("rooms-client.js");
  const settings = source("settings.html");

  assert.match(server, /MAX_JSON_BODY_BYTES = 8 \* 1024 \* 1024/);
  assert.match(server, /MAX_VOICE_DATA_URL_CHARS = 6 \* 1024 \* 1024/);
  assert.match(server, /validVoiceDataUrl\(audioData\)/);
  assert.match(rooms, /MAX_VOICE_DATA_URL_CHARS = 6 \* 1024 \* 1024/);
  assert.match(settings, /FRIEND_VOICE_MAX_DATA_URL_CHARS = 6 \* 1024 \* 1024/);
});
