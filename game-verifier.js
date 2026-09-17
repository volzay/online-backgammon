/* Local result verification. This does not attest prior commitment or RNG fairness. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NarduVerify = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const MAX_TEXT = 16384;
  function invalid(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function text(value, name, limit = MAX_TEXT, allowEmpty = false) {
    if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value.length)) {
      throw invalid('INVALID_INPUT', `${name}: требуется строка длиной ${allowEmpty ? '0' : '1'}–${limit} символов.`);
    }
    return value;
  }
  function normalizeHash(value) {
    if (typeof value !== 'string' || value.length > 512) throw invalid('INVALID_HASH', 'SHA-256 должен содержать 64 шестнадцатеричных символа.');
    const hash = value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw invalid('INVALID_HASH', 'SHA-256 должен содержать 64 шестнадцатеричных символа.');
    return hash;
  }
  function optionalHash(value) {
    return value === undefined || value === null || value === '' ? null : normalizeHash(value);
  }
  function bytesToHex(bytes) {
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }
  function webCrypto() {
    if (!root.crypto?.subtle || typeof root.TextEncoder !== 'function') {
      throw invalid('CRYPTO_UNAVAILABLE', 'Браузер не поддерживает Web Crypto. Откройте программу по HTTPS в современном браузере.');
    }
    return root.crypto.subtle;
  }
  async function sha256Hex(input) {
    text(input, 'Исходная строка', MAX_TEXT, true);
    try {
      const subtle = webCrypto();
      return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', new root.TextEncoder().encode(input))));
    } catch (error) {
      if (error.code === 'CRYPTO_UNAVAILABLE') throw error;
      throw invalid('CRYPTO_UNAVAILABLE', 'Web Crypto не смог вычислить SHA-256. Проверьте настройки браузера.');
    }
  }
  function normalizeDice(value) {
    if (value === undefined || value === null || value === '') return null;
    let parts;
    if (typeof value === 'string') {
      if (value.length > 64 || !value.trim()) throw invalid('INVALID_DICE', 'Укажите две кости от 1 до 6.');
      parts = value.trim().split(/\s*[:,]\s*|\s+/);
    } else if (Array.isArray(value)) parts = value;
    else throw invalid('INVALID_DICE', 'Укажите две кости от 1 до 6.');
    if (Array.isArray(value) && parts.some(part => typeof part !== 'number')) {
      throw invalid('INVALID_DICE', 'Массив костей должен содержать целые числа от 1 до 6.');
    }
    if (![2, 4].includes(parts.length) || parts.some(part => !(
      typeof part === 'number' && Number.isInteger(part) && part >= 1 && part <= 6
      || typeof part === 'string' && /^[1-6]$/.test(part)
    ))) throw invalid('INVALID_DICE', 'Укажите две кости от 1 до 6; четыре значения допустимы только для дубля.');
    const dice = parts.map(Number);
    if (dice.length === 4 && !dice.every(die => die === dice[0])) {
      throw invalid('INVALID_DICE', 'Четыре значения допустимы только для одного дубля.');
    }
    return dice.slice(0, 2);
  }
  function diceFromHash(input) {
    const hash = normalizeHash(input);
    const dice = [];
    const sourceBytes = [];
    for (let index = 0; index < 32 && dice.length < 2; index += 1) {
      const byte = parseInt(hash.slice(index * 2, index * 2 + 2), 16);
      if (byte >= 252) continue;
      const die = (byte % 6) + 1;
      dice.push(die);
      sourceBytes.push({ byteIndex: index, sourceByte: byte, die });
    }
    if (dice.length !== 2) throw invalid('INSUFFICIENT_BYTES', 'В хеше недостаточно допустимых байтов; старый резервный способ генерации не подтверждается.');
    return { dice, sourceBytes };
  }
  function comparison(actual, expected) {
    return expected === null ? 'unavailable' : actual.every((value, index) => value === expected[index]) ? 'verified' : 'mismatch';
  }
  function aggregate(hashStatus, diceStatus) {
    if (hashStatus === 'mismatch' || diceStatus === 'mismatch') return 'mismatch';
    return hashStatus === 'verified' && diceStatus === 'verified' ? 'verified' : 'incomplete';
  }
  async function verifyPortalRoll({ hash: rawHash, expectedDice, preimage } = {}) {
    const expected = normalizeDice(expectedDice);
    if (rawHash === undefined || rawHash === null || rawHash === '') {
      return { status: 'incomplete', hash: '', dice: [], sourceBytes: [], hashStatus: 'unavailable', diceStatus: 'unavailable',
        warning: 'В записи нет SHA-256; этот бросок проверить невозможно.' };
    }
    const hash = normalizeHash(rawHash);
    const hasPreimage = preimage !== undefined && preimage !== null && preimage !== '';
    const hashStatus = hasPreimage ? await sha256Hex(text(preimage, 'Исходная строка')) === hash ? 'verified' : 'mismatch' : 'unavailable';
    let extracted;
    try { extracted = diceFromHash(hash); }
    catch (error) {
      if (error.code !== 'INSUFFICIENT_BYTES') throw error;
      return { status: hashStatus === 'mismatch' ? 'mismatch' : 'incomplete', hash, dice: [], sourceBytes: [], hashStatus,
        diceStatus: 'unavailable', warning: error.message };
    }
    const diceStatus = comparison(extracted.dice, expected);
    const warning = hasPreimage
      ? 'Проверка подтверждает только соответствие строки, хеша и результата. Публикация обязательства до броска и непредсказуемость не подтверждаются.'
      : 'Исходная строка этого броска не сохранена. Можно проверить только соответствие костей хешу, но не вычисление SHA-256 или независимую честность генерации.';
    return { status: aggregate(hashStatus, diceStatus), hash, ...extracted, hashStatus, diceStatus, warning };
  }
  async function verifySeed({ seed, expectedHash } = {}) {
    const expected = optionalHash(expectedHash);
    const hash = await sha256Hex(text(seed, 'Server Seed'));
    return { status: expected === null ? 'incomplete' : hash === expected ? 'verified' : 'mismatch', hash };
  }
  function normalizeNonce(value) {
    if (typeof value === 'string') {
      if (value.length > 16 || !/^(0|[1-9][0-9]*)$/.test(value)) throw invalid('INVALID_INPUT', 'Nonce должен быть безопасным целым числом 0 или больше.');
      value = Number(value);
    }
    if (!Number.isSafeInteger(value) || value < 0) throw invalid('INVALID_INPUT', 'Nonce должен быть безопасным целым числом 0 или больше.');
    return value;
  }
  async function verifyHmacRoll({ serverSeed, gameId, clientSeed, nonce, expectedDice, expectedHash } = {}) {
    text(serverSeed, 'Server Seed');
    text(gameId, 'Game ID', 256);
    text(clientSeed, 'Client Seed', 256);
    const expected = normalizeDice(expectedDice);
    const expectedHmac = optionalHash(expectedHash);
    const number = normalizeNonce(nonce);
    const message = `${gameId}:${clientSeed}:${number}`;
    let hmac;
    try {
      const subtle = webCrypto();
      const encoder = new root.TextEncoder();
      const key = await subtle.importKey('raw', encoder.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      hmac = bytesToHex(new Uint8Array(await subtle.sign('HMAC', key, encoder.encode(message))));
    } catch (error) {
      if (error.code === 'CRYPTO_UNAVAILABLE') throw error;
      throw invalid('CRYPTO_UNAVAILABLE', 'Web Crypto не смог вычислить HMAC-SHA256. Проверьте настройки браузера.');
    }
    const hashStatus = expectedHmac === null ? 'unavailable' : hmac === expectedHmac ? 'verified' : 'mismatch';
    let extracted;
    try { extracted = diceFromHash(hmac); }
    catch (error) {
      if (error.code !== 'INSUFFICIENT_BYTES') throw error;
      return { status: hashStatus === 'mismatch' ? 'mismatch' : 'incomplete', diceStatus: 'unavailable', hashStatus, message, hmac,
        dice: [], sourceBytes: [], warning: error.message };
    }
    const diceStatus = comparison(extracted.dice, expected);
    return { status: hashStatus === 'mismatch' || diceStatus === 'mismatch' ? 'mismatch' : diceStatus === 'verified' ? 'verified' : 'incomplete',
      hashStatus, diceStatus, message, hmac, ...extracted,
      warning: 'Ручная проверка отдельной схемы HMAC; она не используется в текущих бросках портала. Само совпадение не доказывает, что хеш был опубликован заранее.' };
  }
  function portalRollFromHistory(item) {
    if (!item || typeof item !== 'object') throw invalid('INVALID_INPUT', 'Запись броска не найдена.');
    const hash = normalizeHash(item.sha256);
    const expectedDice = normalizeDice(item.opening ? [item.host, item.guest] : item.roll);
    if (!expectedDice) throw invalid('INVALID_DICE', 'В записи нет результата броска.');
    const preimage = typeof item.sha256Input === 'string' ? text(item.sha256Input, 'Исходная строка') : undefined;
    return { hash, expectedDice, ...(preimage !== undefined ? { preimage } : {}) };
  }
  function verificationUrl(item) {
    try {
      const { hash, expectedDice } = portalRollFromHistory(item);
      const color = ['white', 'dark'].includes(item.color) ? `&color=${item.color}` : '';
      // Only public hash/dice go in the fragment: never a seed or input preimage.
      return `verify-game.html#hash=${hash}&dice=${encodeURIComponent(expectedDice.join(','))}${color}`;
    } catch { return ''; }
  }
  async function verifyGameRolls(game) {
    if (!game || typeof game !== 'object' || !Array.isArray(game.history) || game.history.length > 5000
      || game.history.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw invalid('INVALID_INPUT', 'Для проверки нужна история партии: не более 5000 записей.');
    }
    // Capture one immutable view before the first asynchronous digest. A live
    // game may advance while verification runs; no original record is modified.
    const historyLength = game.history.length;
    const rolls = game.history.flatMap((item, historyIndex) => item.opening || item.openingMove
      || Object.prototype.hasOwnProperty.call(item, 'roll') || Object.prototype.hasOwnProperty.call(item, 'sha256Input') ? [{
      historyIndex, opening: Boolean(item.opening), host: item.host, guest: item.guest,
      roll: Array.isArray(item.roll) ? [...item.roll] : item.roll,
      sha256: item.sha256, sha256Input: item.sha256Input,
    }] : []);
    const results = [];
    const counts = { rolls: rolls.length, verified: 0, incomplete: 0, mismatch: 0, diceVerified: 0, hashVerified: 0 };
    for (const item of rolls) {
      let result;
      try {
        const expectedDice = normalizeDice(item.opening ? [item.host, item.guest] : item.roll);
        if (!expectedDice) throw invalid('INVALID_DICE', 'В записи нет результата броска.');
        if (item.sha256Input !== undefined && typeof item.sha256Input !== 'string') throw invalid('INVALID_INPUT', 'Исходная строка броска повреждена.');
        result = await verifyPortalRoll({ hash: item.sha256, expectedDice, preimage: item.sha256Input });
      } catch (error) {
        result = { status: 'incomplete', dice: [], hashStatus: 'unavailable', diceStatus: 'unavailable', warning: error.message, errorCode: error.code };
      }
      counts[result.status] += 1;
      if (result.diceStatus === 'verified') counts.diceVerified += 1;
      if (result.hashStatus === 'verified') counts.hashVerified += 1;
      results.push({ historyIndex: item.historyIndex, ...result });
    }
    const status = counts.mismatch ? 'mismatch' : counts.rolls && counts.verified === counts.rolls ? 'verified' : 'incomplete';
    return { status, historyLength, counts, results };
  }
  return Object.freeze({ MAX_TEXT, normalizeHash, normalizeDice, sha256Hex, diceFromHash,
    verifyPortalRoll, verifySeed, verifyHmacRoll, portalRollFromHistory, verificationUrl, verifyGameRolls });
});
