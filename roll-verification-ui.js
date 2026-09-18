/* Read-only local verification shared by the live room and admin archive. */
(function (root) {
  'use strict';
  const sources = new WeakMap();
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const language = () => root.document.documentElement.lang === 'en' ? 'en' : 'ru';
  function gameSignature(game) {
    if (!Array.isArray(game?.history) || game.history.length > 5000) return null;
    try {
      return JSON.stringify([[game.roomCode, game.gameId, game.startedAt, game.variant], game.history.map(item => item && typeof item === 'object' ? [
        Boolean(item.opening), Boolean(item.openingMove), item.color, Object.prototype.hasOwnProperty.call(item, 'roll'),
        Object.prototype.hasOwnProperty.call(item, 'sha256Input'), item.host, item.guest, item.roll, item.sha256, item.sha256Input,
        Object.prototype.hasOwnProperty.call(item, 'fairDiceProof'), item.fairDiceProof,
      ] : null)]);
    } catch { return null; }
  }
  function clearResult(output) {
    if (!output) return;
    output.hidden = true;
    output.textContent = '';
    delete output.dataset.status;
  }
  function rollControls(item, { lang = language(), context } = {}) {
    try {
      const input = root.NarduVerify.portalRollFromHistory(item);
      const url = root.NarduVerify.verificationUrl(item);
      if (!url) return '';
      const preimage = input.preimage === undefined ? '' : ` data-verify-input="${escape(input.preimage)}"`;
      const signed = Object.prototype.hasOwnProperty.call(item, 'fairDiceProof');
      const encodedProof = signed ? JSON.stringify(item.fairDiceProof) : '';
      if (signed && (typeof encodedProof !== 'string' || encodedProof.length > root.NarduVerify.MAX_TEXT)) return '';
      const fair = signed ? ` data-verify-fair-proof="${escape(encodedProof)}"` : '';
      const expectedContext = {};
      if (signed) {
        for (const field of ['roomCode', 'gameId', 'variant']) {
          if (context?.[field] !== undefined) expectedContext[field] = context[field];
        }
        expectedContext.label = item.opening ? 'opening' : 'roll';
        expectedContext.color = item.opening ? 'none' : typeof item.color === 'string' ? item.color : '';
      }
      const encodedContext = signed ? JSON.stringify(expectedContext) : '';
      if (encodedContext.length > root.NarduVerify.MAX_TEXT) return '';
      const fairContext = signed ? ` data-verify-fair-context="${escape(encodedContext)}"` : '';
      const copy = (value, kind) => `<button type="button" data-copy-roll-${kind} data-copy-value="${escape(value)}">${lang === 'en' ? 'Copy' : 'Скопировать'}</button>`;
      const system = item.fairDiceProof?.protocol === 'system-csprng-v1';
      const drand = ['drand', 'drand-quicknet-v1'].includes(item.fairDiceProof?.protocol);
      const source = signed && item.fairDiceProof && typeof item.fairDiceProof === 'object'
        ? system ? `<p>${lang === 'en' ? 'Recorded protocol' : 'Сохранённый протокол'}: server CSPRNG · commit/reveal · HMAC-SHA256</p><p>${lang === 'en' ? 'Signed commitment' : 'Подписанное обязательство'}:</p><pre>${escape(item.fairDiceProof.request?.commitment || '')}</pre><p>Server seed:</p><pre>${escape(item.fairDiceProof.commitReveal?.serverSeed || '')}</pre><p>Client seed:</p><pre>${escape(item.fairDiceProof.commitReveal?.clientSeed || '')}</pre>`
          : drand ? `<p>${lang === 'en' ? 'Recorded source' : 'Сохранённый источник'}: drand quicknet · ${lang === 'en' ? 'round' : 'раунд'} ${escape(item.fairDiceProof.beacon?.round ?? '')}</p><p>${lang === 'en' ? 'Chain' : 'Цепочка'}: <code>${escape(item.fairDiceProof.chainHash || '')}</code></p><p>${lang === 'en' ? 'Source signature' : 'Подпись источника'}:</p><pre>${escape(item.fairDiceProof.beacon?.signature || '')}</pre>`
            : `<p>${lang === 'en' ? 'Recorded protocol (unverified)' : 'Сохранённый протокол (не проверен)'}: ${escape(item.fairDiceProof.protocol || '')}</p>` : '';
      const details = input.preimage !== undefined || signed ? `<details class="roll-proof-details"><summary>${lang === 'en' ? 'Source and complete data' : 'Источник и полные данные'}</summary>${source}${input.preimage === undefined ? '' : `<p>${lang === 'en' ? 'Complete SHA-256 input' : 'Исходная строка SHA-256 (целиком)'}</p><pre>${escape(input.preimage)}</pre>${copy(input.preimage, 'input')}`}${signed ? `<details><summary>${lang === 'en' ? 'Roll JSON proof' : 'JSON-доказательство броска'}</summary><pre>${escape(encodedProof)}</pre>${copy(encodedProof, 'proof')}<p>${lang === 'en' ? 'You can paste this JSON into the standalone verifier. It is not passed in the page URL.' : 'Этот JSON можно вставить в отдельную страницу проверки. В адресе страницы он не передаётся.'}</p></details>` : ''}<p class="roll-proof-limits">${lang === 'en' ? 'Verification checks recorded data and signatures, not externally observed reservation timing, intentions or checker-move legality.' : 'Проверяются записанные данные и подписи, но не внешнее время резервирования, намерения участников или законность перемещения шашек.'}</p></details>` : '';
      return `<span class="roll-verify-controls"><button type="button" data-verify-roll data-verify-hash="${input.hash}" data-verify-dice="${input.expectedDice.join(',')}"${preimage}${fair}${fairContext}>${lang === 'en' ? 'Check roll' : 'Проверить'}</button><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${lang === 'en' ? 'Details' : 'Подробнее'}</a></span><span class="roll-verify-status" data-roll-result role="status" aria-live="polite" hidden></span>${details}`;
    } catch { return ''; }
  }
  function setGameContext(element, game) {
    if (!element) return;
    const previous = sources.get(element);
    const signature = gameSignature(game);
    const changed = previous && previous.signature !== signature;
    if (changed) clearResult(element.querySelector('[data-game-result]'));
    sources.set(element, { game, signature, revision: (previous?.revision || 0) + (changed ? 1 : 0) });
    element.setAttribute('data-verifier-context', '');
  }
  function summary(result, lang) {
    const dice = result.dice.join(':');
    if (result.status === 'mismatch') return lang === 'en' ? `Mismatch detected.${dice ? ` Calculated dice: ${dice}.` : ''}` : `Обнаружено несовпадение.${dice ? ` Рассчитанные кости: ${dice}.` : ''}`;
    if (!result.dice.length) return lang === 'en' ? 'Insufficient data to verify this roll.' : 'Недостаточно данных для проверки этого броска.';
    if (result.protocol === 'system-csprng-v1') {
      if (result.status === 'verified' && result.commitmentVerified && result.reservationVerified && result.diceStatus === 'verified') {
        return lang === 'en' ? `Roll signature and calculation verified. The revealed seed matches the signed commitment and HMAC-SHA256 gives dice ${dice}. Players and bots use the same server cryptographic protocol.`
          : `Подпись и расчёт броска подтверждены. Раскрытый seed соответствует подписанному обязательству, HMAC-SHA256 даёт кости ${dice}. Игроки и боты используют один серверный криптографический протокол.`;
      }
      return lang === 'en' ? `Dice ${dice} calculated using server HMAC-SHA256. The server signature or commitment verification is incomplete.`
        : `Кости ${dice} рассчитаны по серверной схеме HMAC-SHA256. Проверка подписи сервера или обязательства не завершена.`;
    }
    if (['drand', 'drand-quicknet-v1'].includes(result.protocol)) {
      if (result.status === 'verified' && result.sourceVerified && result.reservationVerified && result.diceStatus === 'verified') {
        return lang === 'en' ? `Verification passed. The roll source is verified and the dice were calculated correctly. Result: ${dice}. Players and bots use the same independent drand source.`
          : `Проверка пройдена. Источник броска подтверждён, кости рассчитаны верно. Результат: ${dice}. Игроки и боты используют один независимый источник drand.`;
      }
      return lang === 'en' ? `${result.sourceVerified ? 'The drand signature is verified.' : 'The source signature is unverified.'} ${result.reservationVerified ? 'The signed server record is verified.' : 'The reservation is not verified with the configured server key.'} ${result.diceStatus === 'verified' ? `Dice ${dice} match.` : 'Add both history dice to compare the result.'}`
        : `${result.sourceVerified ? 'Подпись drand подтверждена.' : 'Подпись источника не подтверждена.'} ${result.reservationVerified ? 'Подписанная серверная запись подтверждена.' : 'Резервирование не подтверждено настроенным ключом сервера.'} ${result.diceStatus === 'verified' ? `Кости ${dice} совпадают.` : 'Для сравнения добавьте обе кости из истории.'}`;
    }
    if (result.status === 'verified') return lang === 'en' ? `Dice ${dice} match the hash. The complete input SHA-256 also matches. This record’s protocol does not include an independent source signature.` : `Кости ${dice} соответствуют хешу. SHA-256 исходной строки тоже совпал. Протокол этой записи не содержит независимую подпись источника.`;
    if (result.diceStatus === 'verified') return lang === 'en' ? `Dice ${dice} match the hash. This record’s protocol does not disclose the input or an independent source signature.` : `Кости ${dice} соответствуют хешу. Протокол этой записи не раскрывает исходную строку или независимую подпись источника.`;
    return lang === 'en' ? `Calculated dice: ${dice}; insufficient data for full verification.` : `Рассчитанные кости: ${dice}; недостаточно данных для полной проверки.`;
  }
  function gameSummary(result, lang) {
    const c = result.counts;
    if (!c.rolls) return lang === 'en' ? 'There are no recorded rolls to verify.' : 'В истории пока нет бросков для проверки.';
    const source = result.sourceCounts;
    if (source?.system) {
      const checked = Math.min(source.sourceVerified + (source.commitmentVerified || 0), source.reservationVerified);
      const complete = source.signed === c.rolls && checked === c.rolls && c.diceVerified === c.rolls && result.status === 'verified';
      const heading = complete ? lang === 'en' ? 'All recorded roll signatures and calculations verified. ' : 'Подписи и расчёты всех записанных бросков подтверждены. ' : '';
      const details = lang === 'en'
        ? `Rolls: ${c.rolls}. Dice match: ${c.diceVerified}. Input SHA-256 matches: ${c.hashVerified}. Mismatches: ${c.mismatch}. Server commitments verified: ${source.commitmentVerified || 0}/${source.system}. Independent drand signatures: ${source.sourceVerified}/${source.signed - source.system}. Server records: ${source.reservationVerified}/${source.signed}.`
        : `Бросков: ${c.rolls}. Кости совпали: ${c.diceVerified}. SHA-256 исходной строки совпал: ${c.hashVerified}. Несовпадений: ${c.mismatch}. Серверные обязательства подтверждены: ${source.commitmentVerified || 0}/${source.system}. Независимые подписи drand: ${source.sourceVerified}/${source.signed - source.system}. Серверные записи: ${source.reservationVerified}/${source.signed}.`;
      return heading + details + (lang === 'en'
        ? ' Server CSPRNG verification confirms signed commitments and HMAC calculations, not an independent entropy source. Checker-move legality is not checked.'
        : ' Серверная схема CSPRNG подтверждает подписанные обязательства и расчёт HMAC, а не независимый источник энтропии. Законность перемещения шашек не проверяется.');
    }
    const withoutSource = c.rolls - (source ? Math.min(source.sourceVerified, source.reservationVerified) : 0);
    const complete = source && source.signed === c.rolls && source.sourceVerified === c.rolls
      && source.reservationVerified === c.rolls && c.diceVerified === c.rolls && result.status === 'verified';
    const heading = complete ? lang === 'en' ? 'Verification passed. All recorded roll sources and dice are verified. ' : 'Проверка пройдена. Источники всех записанных бросков и кости подтверждены. ' : '';
    const details = lang === 'en'
      ? `Rolls: ${c.rolls}. Dice match: ${c.diceVerified}. Input SHA-256 matches: ${c.hashVerified}. Mismatches: ${c.mismatch}. Records without full source proof: ${withoutSource}.`
      : `Бросков: ${c.rolls}. Кости совпали: ${c.diceVerified}. SHA-256 исходной строки совпал: ${c.hashVerified}. Несовпадений: ${c.mismatch}. Записей без полного доказательства источника: ${withoutSource}.`;
    const verifiedSources = source ? lang === 'en' ? ` drand signatures verified: ${source.sourceVerified}/${source.signed}. Server records verified: ${source.reservationVerified}/${source.signed}.`
      : ` Подписи drand подтверждены: ${source.sourceVerified}/${source.signed}. Серверные записи подтверждены: ${source.reservationVerified}/${source.signed}.` : '';
    const legacy = !source || source.signed < c.rolls;
    return heading + details + verifiedSources + (legacy
      ? lang === 'en' ? ' Older SHA-only records verify consistency, not an independent source.' : ' Старые SHA-записи подтверждают соответствие, а не независимый источник.'
      : complete ? lang === 'en' ? ' Players and bots use the same independent drand source.' : ' Игроки и боты используют один независимый источник drand.'
        : lang === 'en' ? ' Verification of the signed roll records is incomplete.' : ' Проверка подписанных записей бросков не завершена.')
      + (lang === 'en' ? ' Checker-move legality is not checked.' : ' Законность перемещения шашек не проверяется.');
  }
  function rollSignature(button) {
    return JSON.stringify([button.dataset.verifyHash, button.dataset.verifyDice, button.dataset.verifyInput,
      button.hasAttribute('data-verify-fair-proof'), button.dataset.verifyFairProof,
      button.hasAttribute('data-verify-fair-context'), button.dataset.verifyFairContext]);
  }
  function errorSummary(error, lang) {
    const messages = {
      FAIR_RECEIPT_INVALID: ['Подпись серверной записи не соответствует настроенному ключу.', 'The server record signature does not match the configured key.'],
      FAIR_BEACON_SIGNATURE_INVALID: ['Подпись независимого источника не прошла проверку.', 'The independent source signature failed verification.'],
      FAIR_BEACON_INVALID: ['Данные раунда drand не соответствуют записи источника.', 'The drand round data does not match the source record.'],
      FAIR_CONTEXT_MISMATCH: ['Доказательство относится к другому броску или партии.', 'The proof belongs to a different roll or game.'],
      FAIR_DICE_MISMATCH: ['Кости или исходная строка не соответствуют подписанному источнику.', 'The dice or input do not match the signed source.'],
      FAIR_RESERVATION_MISMATCH: ['Хеш резервирования не соответствует его данным.', 'The reservation hash does not match its data.'],
      FAIR_PROTOCOL_INVALID: ['Этот протокол или цепочка drand не поддерживаются.', 'This protocol or drand chain is not supported.'],
      FAIR_REQUEST_INVALID: ['Некорректная запись резервирования броска.', 'Invalid roll reservation record.'],
      FAIR_REQUEST_NOT_FUTURE: ['Запись резервирования не указывает будущий раунд по своему времени.', 'The reservation does not specify a future round according to its recorded time.'],
      FAIR_CRYPTO_UNAVAILABLE: ['Модуль проверки подписанного источника не загрузился.', 'The signed source verifier did not load.'],
      FAIR_PROOF_UNAVAILABLE: ['Модуль проверки подписанного источника не загрузился.', 'The signed source verifier did not load.'],
      FAIR_SYSTEM_COMMITMENT_MISMATCH: ['Раскрытый server seed не соответствует подписанному обязательству.', 'The revealed server seed does not match its signed commitment.'],
      FAIR_SYSTEM_PROOF_INVALID: ['Запись серверного броска повреждена или содержит неподдерживаемые поля.', 'The server roll record is malformed or contains unsupported fields.'],
      FAIR_SYSTEM_SEED_INVALID: ['Недопустимое значение server seed или client seed.', 'Invalid server seed or client seed.'],
    };
    return messages[error.code]?.[lang === 'en' ? 1 : 0] || (lang === 'en' ? 'Verification unavailable. Check the recorded data and cryptographic support.' : `Проверка недоступна: ${error.message || 'проверьте данные и поддержку криптографии'}`);
  }
  async function run(button, wholeGame) {
    const parent = button.closest(wholeGame ? '[data-verifier-context]' : '.fair-hash, .history-proof');
    const output = parent?.querySelector(wholeGame ? '[data-game-result]' : '[data-roll-result]');
    if (!output) return;
    const lang = language();
    const context = wholeGame ? sources.get(parent) : null;
    const signature = wholeGame ? null : rollSignature(button);
    output.hidden = false;
    output.dataset.status = 'incomplete';
    output.textContent = lang === 'en' ? 'Checking…' : 'Проверяем…';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const options = wholeGame ? null : {
        hash: button.dataset.verifyHash, expectedDice: button.dataset.verifyDice, preimage: button.dataset.verifyInput,
        ...(button.hasAttribute('data-verify-fair-proof') ? { proof: button.dataset.verifyFairProof } : {}),
        ...(button.hasAttribute('data-verify-fair-context') ? { context: root.NarduVerify.parseFairProof(button.dataset.verifyFairContext) } : {}),
      };
      const result = wholeGame ? await root.NarduVerify.verifyGameRolls(context?.game)
        : await root.NarduVerify[Object.prototype.hasOwnProperty.call(options, 'proof') ? 'verifyFairRoll' : 'verifyPortalRoll'](options);
      if (output.isConnected === false) return;
      if (!wholeGame && rollSignature(button) !== signature) { clearResult(output); return; }
      if (wholeGame) {
        const current = sources.get(parent);
        if (!context || current?.revision !== context.revision || gameSignature(current?.game) !== context.signature) {
          clearResult(output);
          return;
        }
      }
      const resultLanguage = language();
      const signed = wholeGame ? Boolean(result.sourceCounts) : ['drand', 'drand-quicknet-v1', 'system-csprng-v1'].includes(result.protocol);
      const fullSource = wholeGame ? result.sourceCounts && result.sourceCounts.signed === result.counts.rolls
        && result.sourceCounts.sourceVerified + (result.sourceCounts.commitmentVerified || 0) === result.counts.rolls && result.sourceCounts.reservationVerified === result.counts.rolls
        && result.counts.rolls > 0 && result.counts.diceVerified === result.counts.rolls
        : (result.protocol === 'system-csprng-v1' ? result.commitmentVerified : result.sourceVerified) && result.reservationVerified && result.diceStatus === 'verified';
      output.dataset.status = result.status === 'mismatch' ? 'mismatch' : signed && fullSource && result.status === 'verified' ? 'verified'
        : !signed && (wholeGame ? result.counts.diceVerified > 0 : result.diceStatus === 'verified') ? 'matched' : 'incomplete';
      output.textContent = wholeGame ? gameSummary(result, resultLanguage) : summary(result, resultLanguage);
      if (wholeGame && result.counts.mismatch) {
        const mismatches = result.results.filter(item => item.status === 'mismatch').slice(0, 20).map(item => result.historyLength - item.historyIndex);
        output.textContent += resultLanguage === 'en' ? ` History entries: ${mismatches.join(', ')}.` : ` Записи истории: ${mismatches.join(', ')}.`;
      }
    } catch (error) {
      if (output.isConnected === false) return;
      if (!wholeGame && rollSignature(button) !== signature) { clearResult(output); return; }
      if (wholeGame) {
        const current = sources.get(parent);
        if (!context || current?.revision !== context.revision || gameSignature(current?.game) !== context.signature) {
          clearResult(output);
          return;
        }
      }
      output.dataset.status = 'incomplete';
      output.textContent = errorSummary(error, language());
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
  root.NarduVerifyUI = Object.freeze({ rollControls, setGameContext });
  root.document.addEventListener('click', event => {
    const copy = event.target.closest?.('[data-copy-roll-input], [data-copy-roll-proof]');
    if (copy) {
      event.preventDefault();
      const value = copy.dataset.copyValue;
      if (typeof value !== 'string' || value.length > root.NarduVerify.MAX_TEXT) return;
      const copied = () => { if (copy.isConnected !== false) copy.textContent = language() === 'en' ? 'Copied' : 'Скопировано'; };
      const unavailable = () => { if (copy.isConnected !== false) copy.textContent = language() === 'en' ? 'Copy the displayed value manually' : 'Скопируйте показанное значение вручную'; };
      if (typeof root.navigator?.clipboard?.writeText !== 'function') unavailable();
      else Promise.resolve().then(() => root.navigator.clipboard.writeText(value)).then(copied, unavailable);
      return;
    }
    const button = event.target.closest?.('[data-verify-roll], [data-verify-game]');
    if (!button || button.disabled) return;
    event.preventDefault();
    void run(button, button.hasAttribute('data-verify-game'));
  });
})(window);
