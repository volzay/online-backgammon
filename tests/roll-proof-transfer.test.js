'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const verifier = require('../game-verifier.js');
const Fair = require('../fair-dice.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'roll-proof-transfer.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function harness({ supported = true } = {}) {
  const channels = new Set();
  const timers = new Map();
  const pageEvents = new Map();
  const packets = [];
  let sequence = 0;
  class Channel {
    constructor(name) { this.name = name; this.closed = false; channels.add(this); }
    postMessage(data) {
      packets.push(plain(data));
      for (const other of channels) {
        if (other === this || other.name !== this.name) continue;
        const snapshot = plain(data);
        queueMicrotask(() => { if (!other.closed) other.onmessage?.({ data: snapshot }); });
      }
    }
    close() { this.closed = true; channels.delete(this); }
  }
  const forbidden = new Proxy({}, { get() { throw new Error('No persistent storage access'); } });
  const root = { NarduVerify: verifier, crypto: webcrypto, BroadcastChannel: supported ? Channel : undefined,
    Uint8Array, JSON, AbortController, localStorage: forbidden, sessionStorage: forbidden,
    Math: { random() { throw new Error('No weak random tokens'); } },
    fetch() { throw new Error('No network'); },
    setTimeout(callback, ms) { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval(callback, ms) { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
    clearInterval: id => timers.delete(id), addEventListener: (name, handler) => pageEvents.set(name, handler) };
  root.window = root;
  vm.runInNewContext(source, root);
  return { api: root.NarduRollProofTransfer, channels, timers, packets,
    fire(ms) { for (const timer of [...timers.values()]) if (timer.ms === ms) timer.callback(); },
    hide() { pageEvents.get('pagehide')(); } };
}
function input() {
  const seed = '22'.repeat(32);
  const key = '11'.repeat(32);
  const request = { id: '11111111-1111-4111-8111-111111111111', roomCode: 'ABCD-EFGH',
    gameId: '22222222-2222-4222-8222-222222222222', nonce: 2, label: 'roll', color: 'white', variant: 'long',
    commitment: '00'.repeat(32), createdAt: '2026-09-18T00:00:00.000Z', positionHash: '44'.repeat(32) };
  request.commitment = Fair.systemCommitment(request, seed);
  const proof = Fair.createSystemProof(Fair.signReservation(request, key), seed, '33'.repeat(32));
  return { hash: proof.sha256, expectedDice: proof.dice, preimage: proof.sha256Input, proof,
    context: { roomCode: request.roomCode, gameId: request.gameId, variant: 'long', label: 'roll', color: 'white', nonce: 2 } };
}
test('completed system JSON crosses only its random in-memory channel and retains proof/context', async () => {
  const h = harness();
  const original = input();
  const before = plain(original);
  const sent = h.api.publish(original);
  assert.match(sent.token, /^[a-f0-9]{48}$/);
  original.proof.dice[0] = 0;
  const received = await h.api.receive(sent.token);
  assert.deepEqual(plain(received), before);
  assert.equal((await Fair.verifyProof(received.proof, { publicKey: Fair.receiptPublicKey('11'.repeat(32)), context: received.context })).commitmentVerified, true);
  await Promise.resolve();
  assert.equal(h.channels.size, 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.packets.map(packet => packet.type), ['ready', 'payload', 'ack']);
});
test('two roll tabs cannot receive each other’s proof', async () => {
  const h = harness();
  const first = input();
  const second = { hash: 'a'.repeat(64), expectedDice: [1, 2], preimage: '  exact legacy input\n' };
  const a = h.api.publish(first);
  const b = h.api.publish(second);
  assert.notEqual(a.token, b.token);
  const values = await Promise.all([h.api.receive(b.token), h.api.receive(a.token)]);
  assert.deepEqual(plain(values), [second, first]);
});
test('expired, missing, unsupported and aborted transfers fail neutrally and close their channels', async () => {
  const missing = harness();
  const receive = missing.api.receive('a'.repeat(48));
  const rejected = assert.rejects(receive, { code: 'ROLL_TRANSFER_UNAVAILABLE' });
  missing.fire(20000);
  await rejected;
  assert.equal(missing.channels.size, 0);
  assert.equal(missing.timers.size, 0);
  const expired = harness();
  expired.api.publish(input());
  expired.fire(60000);
  assert.equal(expired.channels.size, 0);
  const unsupported = harness({ supported: false });
  assert.throws(() => unsupported.api.publish(input()), { code: 'ROLL_TRANSFER_UNAVAILABLE' });
  await assert.rejects(unsupported.api.receive('a'.repeat(48)), { code: 'ROLL_TRANSFER_UNAVAILABLE' });
  const abort = harness();
  const controller = new AbortController();
  const work = abort.api.receive('b'.repeat(48), { signal: controller.signal });
  const aborted = assert.rejects(work, { code: 'ROLL_TRANSFER_UNAVAILABLE' });
  controller.abort();
  await aborted;
  assert.equal(abort.channels.size, 0);
  assert.equal(abort.timers.size, 0);
});
test('publisher memory is capped, page navigation closes all channels and close is idempotent', () => {
  const h = harness();
  const sent = Array.from({ length: 20 }, () => h.api.publish(input()));
  assert.equal(h.channels.size, 8);
  assert.equal(h.timers.size, 8);
  h.hide();
  sent.forEach(item => item.close());
  assert.equal(h.channels.size, 0);
  assert.equal(h.timers.size, 0);
});
test('invalid tokens, account data, untrusted keys and oversized packets are refused before transfer', async () => {
  const h = harness();
  for (const token of ['', 'abc', 'A'.repeat(48), 'a'.repeat(49), '<script>']) await assert.rejects(h.api.receive(token));
  for (const value of [{ ...input(), account: { password: 'never transfer' } },
    { ...input(), context: { publicKey: 'untrusted' } }, { ...input(), preimage: 'a'.repeat(4097) },
    { ...input(), proof: { large: 'a'.repeat(16385) } }, { ...input(), expectedDice: [0, 1] }]) {
    assert.throws(() => h.api.publish(value));
  }
  assert.equal(h.channels.size, 0);
});
test('malformed or oversized received payloads cannot become a trusted handoff', async () => {
  for (const packet of [{ type: 'payload', value: '{bad' }, { type: 'payload', value: 'a'.repeat(32769) },
    { type: 'payload', value: JSON.stringify({ ...input(), publicKey: 'attacker' }) },
    { type: 'payload', value: JSON.stringify(input()), extra: true }]) {
    const h = harness();
    const received = h.api.receive('c'.repeat(48));
    const rejected = assert.rejects(received, { code: 'ROLL_TRANSFER_UNAVAILABLE' });
    [...h.channels][0].onmessage({ data: packet });
    await rejected;
    assert.equal(h.channels.size, 0);
    assert.equal(h.timers.size, 0);
  }
});
test('transfer module is bundled and loaded before both sender and receiver interfaces', () => {
  for (const file of ['room.html', 'homegate.html', 'verify-game.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const transfer = html.indexOf('src="roll-proof-transfer.js');
    const ui = html.indexOf(file === 'verify-game.html' ? 'src="verify-game-ui.js' : 'src="roll-verification-ui.js');
    assert.ok(transfer > 0 && transfer < ui, file);
  }
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts/build-github-pages.js'), 'utf8').includes('"roll-proof-transfer.js"'));
});
