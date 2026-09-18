/* Ephemeral, same-origin tab handoff. Never writes storage or sends a network request. */
(function (root) {
  'use strict';
  const PREFIX = 'nardu/roll-proof/v1/';
  const TOKEN = /^[0-9a-f]{48}$/;
  const MAX_PACKET = 32768;
  const publishers = new Set();
  const fail = () => Object.assign(new Error('Roll data transfer unavailable.'), { code: 'ROLL_TRANSFER_UNAVAILABLE' });
  function supported() {
    return typeof root.BroadcastChannel === 'function' && typeof root.crypto?.getRandomValues === 'function';
  }
  function payload(value) {
    const api = root.NarduVerify;
    if (!api || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['hash', 'expectedDice', 'preimage', 'proof', 'context'].includes(key))) throw fail();
    const result = { hash: api.normalizeHash(value.hash), expectedDice: api.normalizeDice(value.expectedDice) };
    if (!result.expectedDice) throw fail();
    if (value.preimage !== undefined) {
      if (typeof value.preimage !== 'string' || value.preimage.length > 4096) throw fail();
      result.preimage = value.preimage;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'proof')) result.proof = api.parseFairProof(value.proof);
    if (value.context !== undefined) {
      const allowed = ['id', 'roomCode', 'gameId', 'variant', 'label', 'color', 'commitment', 'positionHash', 'createdAt', 'nonce'];
      if (!value.context || typeof value.context !== 'object' || Array.isArray(value.context)
        || Object.keys(value.context).some(key => !allowed.includes(key))) throw fail();
      result.context = {};
      for (const [key, field] of Object.entries(value.context)) {
        if (key === 'nonce' ? !Number.isSafeInteger(field) || field < 1 : typeof field !== 'string' || field.length > 256) throw fail();
        result.context[key] = field;
      }
    }
    const encoded = JSON.stringify(result);
    if (encoded.length > MAX_PACKET) throw fail();
    return encoded;
  }
  function publish(input) {
    if (!supported()) throw fail();
    const encoded = payload(input); // Snapshot only the selected roll, before navigation.
    const bytes = new Uint8Array(24);
    root.crypto.getRandomValues(bytes);
    const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const channel = new root.BroadcastChannel(PREFIX + token);
    let timer;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      root.clearTimeout(timer);
      channel.close();
      publishers.delete(close);
    };
    while (publishers.size >= 8) publishers.values().next().value();
    publishers.add(close);
    channel.onmessage = event => {
      const message = event.data;
      if (closed || !message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).length !== 1) return;
      if (message.type === 'ready') channel.postMessage({ type: 'payload', value: encoded });
      else if (message.type === 'ack') close();
    };
    timer = root.setTimeout(close, 60000);
    return { token, close };
  }
  function receive(token, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (!supported() || !TOKEN.test(token || '') || signal?.aborted) { reject(fail()); return; }
      let channel;
      try { channel = new root.BroadcastChannel(PREFIX + token); } catch { reject(fail()); return; }
      let finished = false;
      let timer;
      let retry;
      const end = (error, value) => {
        if (finished) return;
        finished = true;
        root.clearTimeout(timer);
        root.clearInterval(retry);
        signal?.removeEventListener('abort', aborted);
        channel.close();
        if (error) reject(fail()); else resolve(value);
      };
      const aborted = () => end(fail());
      signal?.addEventListener('abort', aborted, { once: true });
      channel.onmessage = event => {
        const message = event.data;
        if (finished || !message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'payload') return;
        try {
          if (Object.keys(message).length !== 2 || typeof message.value !== 'string' || message.value.length > MAX_PACKET) throw fail();
          const value = JSON.parse(payload(JSON.parse(message.value)));
          channel.postMessage({ type: 'ack' });
          end(null, value);
        } catch { end(fail()); }
      };
      const request = () => { try { channel.postMessage({ type: 'ready' }); } catch { end(fail()); } };
      timer = root.setTimeout(() => end(fail()), 20000);
      retry = root.setInterval(request, 500);
      request();
    });
  }
  root.addEventListener?.('pagehide', () => { for (const close of [...publishers]) close(); });
  root.NarduRollProofTransfer = Object.freeze({ publish, receive });
})(window);
