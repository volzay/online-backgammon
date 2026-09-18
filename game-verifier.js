/* Read-only roll verification. Source/receipt claims require independent proofs. */
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
  function parseFairProof(value) {
    try {
      const encoded = typeof value === 'string' ? text(value, 'Доказательство броска') : JSON.stringify(value);
      if (typeof encoded !== 'string' || encoded.length > MAX_TEXT) throw invalid('INVALID_INPUT', 'Доказательство броска превышает допустимую длину.');
      const proof = JSON.parse(encoded);
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw invalid('INVALID_INPUT', 'Для доказательства броска нужен JSON-объект.');
      return proof;
    } catch (error) {
      if (error.code === 'INVALID_INPUT') throw error;
      throw invalid('INVALID_INPUT', 'Доказательство броска должно быть корректным JSON-объектом.');
    }
  }
  async function verifyFairRoll({ proof, expectedDice, hash: expectedHash, preimage, context } = {}) {
    // Snapshot all user-supplied values and the configured trust root before await.
    // Never adopt a receipt key from the proof itself.
    const snapshot = parseFairProof(proof);
    const expected = normalizeDice(expectedDice) || normalizeDice(snapshot.dice);
    const recordedHash = optionalHash(expectedHash);
    const recordedInput = preimage === undefined || preimage === null || preimage === '' ? null : text(preimage, 'Исходная строка');
    let expectedContext;
    if (context !== undefined) {
      if (!context || typeof context !== 'object' || Array.isArray(context)) throw invalid('INVALID_INPUT', 'Контекст броска должен быть объектом.');
      expectedContext = {};
      for (const field of ['id', 'roomCode', 'gameId', 'variant', 'label', 'color', 'commitment', 'positionHash', 'createdAt']) {
        if (context[field] !== undefined) expectedContext[field] = text(context[field], 'Контекст броска', 256);
      }
      if (context.nonce !== undefined) {
        if (!Number.isSafeInteger(context.nonce) || context.nonce < 1) throw invalid('INVALID_INPUT', 'Номер броска должен быть целым числом 1 или больше.');
        expectedContext.nonce = context.nonce;
      }
    }
    const publicKey = root.NARDU_ENV?.fairDicePublicKey;
    const hasPinnedKey = typeof publicKey === 'string' && publicKey.trim().length > 0 && publicKey.length <= 1024;
    if (typeof root.NarduFairDice?.verifyProof !== 'function') {
      throw invalid('FAIR_PROOF_UNAVAILABLE', 'Модуль проверки подписанного источника не загрузился.');
    }
    const checked = await root.NarduFairDice.verifyProof(snapshot, { publicKey: hasPinnedKey ? publicKey : undefined,
      ...(expectedContext ? { context: expectedContext } : {}) });
    const actualHash = normalizeHash(checked?.hash);
    const actualDice = normalizeDice(checked?.dice);
    if (!actualDice) throw invalid('INVALID_DICE', 'В доказательстве нет результата броска.');
    const input = text(checked?.input, 'Исходная строка', MAX_TEXT, true);
    const sourceVerified = checked.sourceVerified === true;
    const systemProtocol = checked.protocol === 'system-csprng-v1';
    const commitmentVerified = systemProtocol && checked.commitmentVerified === true;
    const reservationVerified = hasPinnedKey && checked.reservationVerified === true;
    const hashStatus = recordedHash === null || actualHash === recordedHash ? 'verified' : 'mismatch';
    const diceStatus = comparison(actualDice, expected);
    const inputStatus = recordedInput === null || input === recordedInput ? 'verified' : 'mismatch';
    const mismatch = hashStatus === 'mismatch' || diceStatus === 'mismatch' || inputStatus === 'mismatch';
    const status = mismatch ? 'mismatch' : (sourceVerified || commitmentVerified) && reservationVerified && diceStatus === 'verified' ? 'verified' : 'incomplete';
    return { status, protocol: checked.protocol || snapshot.protocol, hash: actualHash, dice: actualDice, input, proof: snapshot, sourceBytes: [],
      hashStatus, diceStatus, inputStatus, sourceVerified, reservationVerified, receiptKeyAvailable: hasPinnedKey,
      ...(systemProtocol ? { commitmentVerified, independentSourceVerified: false, entropyVerified: false, priorPublicationVerified: false } : {}),
      warning: systemProtocol ? reservationVerified && commitmentVerified
        ? 'Подпись сервера, обязательство SHA-256 и расчёт HMAC-SHA256 подтверждены. Игроки и боты используют одну серверную схему; эта проверка не является независимым доказательством источника случайности.'
        : 'Для серверной схемы подпись или обязательство не подтверждены настроенным ключом.'
        : !sourceVerified ? 'Подпись независимого источника не подтверждена.'
        : !reservationVerified ? 'Подпись источника drand подтверждена; резервирование броска не подтверждено настроенным ключом сервера.'
          : 'Подтверждены подпись независимого источника и подписанная запись резервирования. Это не доказывает намерения участников или внешнее время фиксации записи.' };
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
    const protocol = item.fairDiceProof?.protocol;
    return { hash, expectedDice, ...(preimage !== undefined ? { preimage } : {}),
      ...(['system-csprng-v1', 'drand', 'drand-quicknet-v1'].includes(protocol) ? { protocol } : {}) };
  }
  function verificationUrl(item) {
    try {
      const { hash, expectedDice, protocol } = portalRollFromHistory(item);
      const color = ['white', 'dark'].includes(item.color) ? `&color=${item.color}` : '';
      // Only public hash/dice go in the fragment: never a seed or input preimage.
      return `verify-game.html#hash=${hash}&dice=${encodeURIComponent(expectedDice.join(','))}${color}${protocol ? `&protocol=${protocol}` : ''}`;
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
      || Object.prototype.hasOwnProperty.call(item, 'roll') || Object.prototype.hasOwnProperty.call(item, 'sha256Input')
      || Object.prototype.hasOwnProperty.call(item, 'fairDiceProof') ? [{
      historyIndex, opening: Boolean(item.opening), host: item.host, guest: item.guest,
      color: item.color,
      roll: Array.isArray(item.roll) ? [...item.roll] : item.roll,
      sha256: item.sha256, sha256Input: item.sha256Input,
      ...(Object.prototype.hasOwnProperty.call(item, 'fairDiceProof') ? { fairDiceProof: (() => {
        try { return parseFairProof(item.fairDiceProof); } catch { return null; }
      })() } : {}),
    }] : []);
    const signedRolls = rolls.filter(item => Object.prototype.hasOwnProperty.call(item, 'fairDiceProof'));
    const epoch = signedRolls.find(item => typeof item.fairDiceProof?.request?.gameId === 'string')?.fairDiceProof.request.gameId;
    const gameContext = {
      ...(typeof game.roomCode === 'string' && game.roomCode ? { roomCode: game.roomCode } : {}),
      ...(typeof game.variant === 'string' && game.variant ? { variant: game.variant } : {}),
      ...(epoch ? { gameId: epoch } : {}),
    };
    const nonces = signedRolls.map(item => item.fairDiceProof?.request?.nonce);
    const knownSequence = signedRolls.length === rolls.length && nonces.every(nonce => Number.isSafeInteger(nonce) && nonce >= 1);
    const sequenceValid = !knownSequence || nonces.every((nonce, index) => nonce === nonces.length - index);
    const results = [];
    const counts = { rolls: rolls.length, verified: 0, incomplete: 0, mismatch: 0, diceVerified: 0, hashVerified: 0 };
    for (const item of rolls) {
      let result;
      try {
        const expectedDice = normalizeDice(item.opening ? [item.host, item.guest] : item.roll);
        if (!expectedDice) throw invalid('INVALID_DICE', 'В записи нет результата броска.');
        if (item.sha256Input !== undefined && typeof item.sha256Input !== 'string') throw invalid('INVALID_INPUT', 'Исходная строка броска повреждена.');
        if (Object.prototype.hasOwnProperty.call(item, 'fairDiceProof')) {
          if (!item.opening && !['white', 'dark'].includes(item.color)) throw invalid('INVALID_INPUT', 'В записи подписанного броска не указан цвет игрока.');
          result = await verifyFairRoll({ proof: item.fairDiceProof, hash: item.sha256, expectedDice, preimage: item.sha256Input,
            context: { ...gameContext, label: item.opening ? 'opening' : 'roll', color: item.opening ? 'none' : item.color } });
          if (!sequenceValid) result = { ...result, status: 'mismatch', contextStatus: 'mismatch',
            warning: 'Порядок или номера подписанных бросков не соответствуют последовательности резервирования.' };
        } else result = await verifyPortalRoll({ hash: item.sha256, expectedDice, preimage: item.sha256Input });
      } catch (error) {
        const mismatch = ['FAIR_CONTEXT_MISMATCH', 'FAIR_RESERVATION_MISMATCH', 'FAIR_BEACON_SIGNATURE_INVALID', 'FAIR_DICE_MISMATCH', 'FAIR_SYSTEM_COMMITMENT_MISMATCH'].includes(error.code);
        result = { status: mismatch ? 'mismatch' : 'incomplete', dice: [], hashStatus: 'unavailable', diceStatus: 'unavailable', warning: error.message, errorCode: error.code };
      }
      counts[result.status] += 1;
      if (result.diceStatus === 'verified') counts.diceVerified += 1;
      if (result.hashStatus === 'verified' && result.inputStatus !== 'mismatch') counts.hashVerified += 1;
      results.push({ historyIndex: item.historyIndex, ...result });
    }
    const status = counts.mismatch ? 'mismatch' : counts.rolls && counts.verified === counts.rolls ? 'verified' : 'incomplete';
    const sourceCounts = { signed: rolls.filter(item => Object.prototype.hasOwnProperty.call(item, 'fairDiceProof')).length,
      sourceVerified: results.filter(item => item.sourceVerified).length,
      reservationVerified: results.filter(item => item.reservationVerified).length,
      ...(signedRolls.some(item => item.fairDiceProof?.protocol === 'system-csprng-v1') ? {
        system: signedRolls.filter(item => item.fairDiceProof?.protocol === 'system-csprng-v1').length,
        commitmentVerified: results.filter(item => item.protocol === 'system-csprng-v1' && item.commitmentVerified).length,
      } : {}) };
    return { status, historyLength, counts, results, ...(sourceCounts.signed ? { sourceCounts } : {}) };
  }
  return Object.freeze({ MAX_TEXT, normalizeHash, normalizeDice, sha256Hex, diceFromHash,
    verifyPortalRoll, parseFairProof, verifyFairRoll, verifySeed, verifyHmacRoll, portalRollFromHistory, verificationUrl, verifyGameRolls });
});
