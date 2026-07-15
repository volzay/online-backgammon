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

test("voice playback decodes base64 into a browser Blob instead of streaming a data URL", () => {
  const room = source("room.html");
  const settings = source("settings.html");

  for (const page of [room, settings]) {
    assert.match(page, /audioDataObjectUrl\(/);
    assert.match(page, /URL\.createObjectURL\(new Blob\(\[bytes\]/);
    assert.match(page, /audioContainerMime\(recorderMime\)/);
  }
  assert.doesNotMatch(room, /audio\.src = message\.audioData;/);
  assert.doesNotMatch(settings, /audio\.src = message\.audioData;/);
});

test("chat sends are locked and server rows carry idempotency keys", () => {
  const room = source("room.html");
  const rooms = source("rooms-client.js");
  const settings = source("settings.html");
  const schema = source("supabase/schema.sql");

  assert.match(room, /chatSendPending/);
  assert.match(room, /clientMessageId: payload\.clientMessageId \|\| newChatMessageId\(\)/);
  assert.match(settings, /friendMessageSending/);
  assert.match(settings, /client_message_id: String\(payload\.clientMessageId/);
  assert.match(rooms, /client_message_id: String\(message\.clientMessageId/);
  assert.match(settings, /delete row\.client_message_id/);
  assert.match(rooms, /delete row\.client_message_id/);
  assert.match(schema, /friend_messages_sender_client_unique/);
  assert.match(schema, /room_messages_sender_client_unique/);
});

test("room chat polling cannot skip a concurrent message after a local send", () => {
  const room = source("room.html");

  assert.match(room, /chatPollAfterId/);
  assert.match(room, /chatSeenIds/);
  assert.match(room, /appendChatMessages\(\[message\], \{ advanceCursor: false \}\)/);
  assert.match(room, /appendChatMessages\(data\.messages \|\| \[\], \{ advanceCursor: true \}\)/);
  assert.doesNotMatch(room, /chatLastId/);
});

test("accepted requests are materialized and transient reads keep the displayed friends", () => {
  const settings = source("settings.html");
  const schema = source("supabase/schema.sql");

  assert.match(settings, /\.from\('friendships'\)/);
  assert.match(settings, /if \(!accountState\.profile\) accountState\.profile = fallbackProfile\(\)/);
  assert.match(schema, /friend_requests_sync_friendships/);
  assert.match(schema, /insert into public\.friendships/);
});
