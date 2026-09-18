/* Standalone, local-only UI. Never persist or send verification inputs. */
(function () {
  'use strict';

  const text = {
    ru: {
      title: 'Нарды — Проверка броска', back: 'В лобби', theme: 'Тема', language: 'Язык', day: 'День', night: 'Ночь',
      kicker: 'Нарды Онлайн · проверка данных', heading: 'Проверка броска',
      lead: 'Проверьте источник броска и соответствие костей истории партии. Вычисления выполняются в этом браузере; введённые значения не отправляются и не сохраняются.',
      portalTitle: 'Бросок на этом портале',
      portalIntro: 'В истории броска откройте «Проверить» или скопируйте SHA-256 и обе кости. Для нового подписанного протокола можно вручную вставить JSON-доказательство броска. Для старых записей проверяется соответствие костей хешу.',
      proofSummary: 'Есть JSON-доказательство источника броска?', proofLabel: 'JSON-доказательство (необязательно)',
      proofHint: 'Вставьте запись завершённого броска из его подробностей. Подпись drand и подписанное резервирование проверяются локально; ключ сервера берётся только из настроек портала. JSON не импортируется из адреса страницы.',
      portalHash: 'SHA-256 из истории броска', hashHint: 'Ровно 64 шестнадцатеричных символа: 0–9, a–f.',
      dieOne: 'Кость 1 из истории', dieTwo: 'Кость 2 из истории',
      preimageSummary: 'Есть раскрытое исходное значение для этого броска?', preimageLabel: 'Исходное значение SHA-256 (необязательно)',
      preimageHint: 'Вставьте раскрытое значение именно этого завершённого броска. Пробелы и переводы строк значимы. Не вводите пароль от аккаунта.',
      checkPortal: 'Проверить бросок', explanationTitle: 'Что именно проверяется',
      explanationPortal: 'Для бросков портала байты SHA-256 читаются слева направо. Значения 252–255 пропускаются; первые два подходящих байта дают кости по формуле (байт % 6) + 1. Пропуск исключает смещение при таком преобразовании байтов.',
      explanationSource: 'В новом протоколе игроки и боты используют один независимый источник drand. Подпись источника привязана к его раунду; кости вычисляются из подписанного значения и контекста партии. Подписанная сервером запись резервирования проверяется отдельным настроенным ключом.',
      limitationsSummary: 'Границы проверки',
      explanationLimits: 'Для старых записей совпадение строки, хеша и костей подтверждает только их соответствие. Для нового протокола подтверждаются подпись drand и подписанная запись резервирования, но не внешнее время её публикации или намерения игроков и оператора. Проверка законности перемещения шашек здесь не выполняется.',
      footer: 'Проверка доступна без входа в аккаунт. Не вводите пароли, токены или значения для будущих бросков.',
      busy: 'Проверяем…', unavailable: 'Модуль проверки недоступен. Откройте страницу по HTTPS или на localhost и проверьте, загрузились ли её скрипты.',
      changed: 'Данные изменены. Нажмите кнопку для новой проверки.', errorTitle: 'Не удалось выполнить проверку',
      required: 'Заполните обязательное поле.', badHash: 'SHA-256 должен содержать ровно 64 символа 0–9 или a–f.',
      tooLong: 'Значение превышает допустимую длину.', badDice: 'Укажите обе кости целыми числами от 1 до 6 или оставьте обе пустыми.', badInput: 'Проверьте обязательные поля и формат введённых значений.',
      portalVerified: 'Кости соответствуют хешу', mismatch: 'Обнаружено несовпадение', incomplete: 'Добавьте данные для проверки',
      diceOnly: 'Кости соответствуют хешу', diceVerified: 'Кости соответствуют указанному хешу.', diceMismatch: 'Кости не соответствуют указанному хешу.',
      diceUnavailable: 'Нет двух ожидаемых костей или недостаточно подходящих байтов для их расчёта.',
      hashVerified: 'Раскрытое исходное значение соответствует SHA-256.', hashMismatch: 'SHA-256 раскрытого исходного значения не совпадает с указанным хешем.',
      hashUnavailable: 'Протокол этой записи не раскрывает исходную строку SHA-256.',
      legacyLimits: 'Для этой записи подтверждается соответствие костей хешу; независимая подпись источника в её протоколе отсутствует.',
      fairVerified: 'Проверка пройдена', fairDetail: 'Источник броска подтверждён, кости рассчитаны верно.',
      fairIndependent: 'Источник случайного значения — независимый drand, а не игрок или бот. Протокол броска одинаков для игроков и ботов.',
      sourceOnly: 'Подпись drand подтверждена', sourceUnknown: 'Подпись источника не подтверждена',
      receiptUnknown: 'Резервирование броска не подтверждено настроенным ключом сервера.',
      receiptKeyMissing: 'Ключ проверки серверной записи не настроен: проверена подпись drand, но не резервирование броска.',
      inputMismatch: 'Исходная строка из истории отличается от строки подписанного броска.',
      fairLimits: 'Подпись drand относится к источнику; подпись сервера — к записи резервирования броска. Внешнее время публикации этой записи, намерения участников и законность ходов эта проверка не подтверждает.',
      expectedMissing: 'Добавьте обе кости из истории, чтобы сравнить их с рассчитанным результатом.',
      sourceChain: 'Цепочка drand', sourceRound: 'Раунд drand', sourceSignature: 'Подпись источника',
      fullInput: 'Исходная строка SHA-256 (целиком)', proofDetails: 'JSON-доказательство броска',
      copy: 'Скопировать', copied: 'Скопировано', copyUnavailable: 'Выделите значение и скопируйте его вручную.', badProof: 'Вставьте корректный JSON-объект доказательства броска.',
      badReceipt: 'Подпись серверной записи не соответствует настроенному ключу.', badSource: 'Подпись независимого источника не прошла проверку.',
      badBeacon: 'Данные раунда drand не соответствуют записи источника.', badContext: 'Доказательство относится к другому броску или партии.',
      badReservation: 'Хеш резервирования не соответствует его данным.', badProtocol: 'Этот протокол или цепочка drand не поддерживаются.',
      badDerived: 'Кости или исходная строка не соответствуют подписанному источнику.', badFuture: 'Запись резервирования не указывает будущий раунд по своему времени.',
      historyHash: 'SHA-256 броска', computedDice: 'Рассчитанные кости', byteSources: 'Байты — источники костей',
      byte: 'Байт', die: 'кость', importInvalid: 'Параметры ссылки не прошли проверку. Заполните поля вручную.',
      importReady: 'SHA-256 и кости импортированы из истории. Исходное значение в ссылке не передаётся.',
      importHashReady: 'SHA-256 импортирован. Для сверки добавьте обе кости из истории.',
      queryIgnored: 'Параметры после «?» не импортируются. Секретные исходные значения нельзя передавать в адресе страницы.',
    },
    en: {
      title: 'Backgammon — Roll verification', back: 'Back to lobby', theme: 'Theme', language: 'Language', day: 'Day', night: 'Night',
      kicker: 'Backgammon Online · data verification', heading: 'Verify a roll',
      lead: 'Verify the roll source and compare the dice with the game history. Calculations run in this browser; entered values are neither sent nor saved.',
      portalTitle: 'A roll on this portal',
      portalIntro: 'Select “Verify” in the roll history, or copy its SHA-256 and both dice. For the new signed protocol you may manually paste the roll’s JSON proof. Older records support checking that dice match the hash.',
      proofSummary: 'Have the roll’s JSON source proof?', proofLabel: 'JSON proof (optional)',
      proofHint: 'Paste the completed roll’s record from its details. The drand signature and signed reservation are checked locally; the server key comes only from portal configuration. JSON is never imported from the URL.',
      portalHash: 'SHA-256 from the roll history', hashHint: 'Exactly 64 hexadecimal characters: 0–9, a–f.',
      dieOne: 'Die 1 from the history', dieTwo: 'Die 2 from the history',
      preimageSummary: 'Have the disclosed input for this roll?', preimageLabel: 'SHA-256 input (optional)',
      preimageHint: 'Paste the disclosed input of this completed roll. Spaces and line breaks matter. Do not enter your account password.',
      checkPortal: 'Verify roll', explanationTitle: 'What this verifies',
      explanationPortal: 'For portal rolls, SHA-256 bytes are read from left to right. Values 252–255 are skipped; the first two eligible bytes become dice using (byte % 6) + 1. Skipping these values removes bias in the byte-to-die conversion.',
      explanationSource: 'In the new protocol, players and bots use the same independent drand source. The source signature is bound to its round; dice are derived from the signed value and game context. The signed server reservation is checked with a separately configured key.',
      limitationsSummary: 'Verification limits',
      explanationLimits: 'For older records, a matching input, hash and dice verifies their consistency only. The new protocol verifies the drand signature and signed reservation, but not its externally observed publication time or player and operator intentions. This page does not check checker-move legality.',
      footer: 'No account login is required. Do not enter passwords, tokens or inputs for future rolls.',
      busy: 'Verifying…', unavailable: 'The verifier is unavailable. Open this page using HTTPS or localhost and check that its scripts loaded.',
      changed: 'Inputs changed. Select the button to verify again.', errorTitle: 'Unable to verify',
      required: 'Fill in the required field.', badHash: 'SHA-256 must contain exactly 64 characters from 0–9 or a–f.',
      tooLong: 'The value exceeds the permitted length.', badDice: 'Enter both dice as integers from 1 to 6, or leave both empty.', badInput: 'Check the required fields and the format of the entered values.',
      portalVerified: 'Dice match the hash', mismatch: 'A mismatch was found', incomplete: 'Add the data to verify',
      diceOnly: 'Dice match the hash', diceVerified: 'The dice match the supplied hash.', diceMismatch: 'The dice do not match the supplied hash.',
      diceUnavailable: 'Two expected dice were not supplied, or too few eligible bytes were available to calculate them.',
      hashVerified: 'The disclosed input matches SHA-256.', hashMismatch: 'SHA-256 of the disclosed input does not match the supplied hash.',
      hashUnavailable: 'This record’s protocol does not disclose the SHA-256 input.',
      legacyLimits: 'This record supports checking that dice match the hash; its protocol does not include an independent source signature.',
      fairVerified: 'Verification passed', fairDetail: 'The roll source is verified and the dice were calculated correctly.',
      fairIndependent: 'The random value comes from independent drand, not a player or bot. Players and bots use the same roll protocol.',
      sourceOnly: 'The drand signature is verified', sourceUnknown: 'The source signature is unverified',
      receiptUnknown: 'The roll reservation has not been verified with the configured server key.',
      receiptKeyMissing: 'No server verification key is configured: the drand signature is checked, but the reservation is not.',
      inputMismatch: 'The history input differs from the signed roll’s input.',
      fairLimits: 'The drand signature refers to the source; the server signature refers to the roll reservation record. This does not verify its externally observed publication time, participant intentions or checker-move legality.',
      expectedMissing: 'Add both dice from the history to compare them with the calculated result.',
      sourceChain: 'drand chain', sourceRound: 'drand round', sourceSignature: 'Source signature',
      fullInput: 'Complete SHA-256 input', proofDetails: 'Roll JSON proof',
      copy: 'Copy', copied: 'Copied', copyUnavailable: 'Select the value and copy it manually.', badProof: 'Paste a valid JSON object containing the roll proof.',
      badReceipt: 'The server record signature does not match the configured key.', badSource: 'The independent source signature failed verification.',
      badBeacon: 'The drand round data does not match the source record.', badContext: 'The proof belongs to a different roll or game.',
      badReservation: 'The reservation hash does not match its data.', badProtocol: 'This protocol or drand chain is not supported.',
      badDerived: 'The dice or input do not match the signed source.', badFuture: 'The reservation does not specify a future round according to its recorded time.',
      historyHash: 'Roll SHA-256', computedDice: 'Calculated dice', byteSources: 'Source bytes for the dice',
      byte: 'Byte', die: 'die', importInvalid: 'The link parameters failed validation. Fill in the fields manually.',
      importReady: 'SHA-256 and dice were imported from the history. The input is never included in this link.',
      importHashReady: 'SHA-256 was imported. Add both dice from the history to compare them.',
      queryIgnored: 'Parameters after “?” are not imported. Secret inputs must not be passed in this page’s URL.',
    },
  };

  let language = document.documentElement.lang === 'en' ? 'en' : 'ru';
  let noticeKey = '';
  const forms = [];
  const get = id => document.getElementById(id);
  const translate = key => text[language][key] || key;
  const hashPattern = /^[0-9a-f]{64}$/i;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function resultCard(status, title) {
    const card = element('div', 'verify-result-card');
    if (['verified', 'mismatch', 'incomplete', 'matched'].includes(status)) card.dataset.status = status;
    if (title) card.append(element('h3', 'verify-result-title', title));
    return card;
  }

  function paragraph(card, value) { card.append(element('p', '', value)); }

  function valueCard(label, value) {
    const card = resultCard();
    card.append(element('span', 'verify-output-label', label), element('code', 'verify-output-value', value));
    return card;
  }

  function disclosure(label, value) {
    const details = element('details', 'verify-output-details');
    details.append(element('summary', '', label));
    const code = element('code', 'verify-output-value', value);
    const copy = element('button', 'verify-copy', translate('copy'));
    copy.setAttribute('type', 'button');
    copy.addEventListener('click', async event => {
      event.preventDefault();
      try {
        if (typeof window.navigator?.clipboard?.writeText !== 'function') throw new Error('clipboard unavailable');
        await window.navigator.clipboard.writeText(String(value));
        copy.textContent = translate('copied');
      } catch { copy.textContent = translate('copyUnavailable'); }
    });
    details.append(code, copy);
    return details;
  }

  function limits(card, key) {
    const details = element('details', 'verify-limits');
    details.append(element('summary', '', translate('limitationsSummary')), element('p', '', translate(key)));
    card.append(details);
  }

  function addDice(card, dice) {
    if (!Array.isArray(dice) || dice.length !== 2 || dice.some(value => !Number.isInteger(value) || value < 1 || value > 6)) return;
    const diceNode = element('div', 'verify-dice');
    diceNode.setAttribute('aria-label', `${translate('computedDice')}: ${dice[0]}:${dice[1]}`);
    dice.forEach(value => diceNode.append(element('span', 'verify-die', value)));
    card.append(diceNode);
  }

  function renderResult(formState, result) {
    const out = formState.out;
    out.replaceChildren();
    const signed = ['drand', 'drand-quicknet-v1'].includes(result.protocol);
    const fullyVerified = signed && result.status === 'verified' && result.sourceVerified === true
      && result.reservationVerified === true && result.diceStatus === 'verified';
    const titleKey = result.status === 'mismatch' ? 'mismatch' : fullyVerified ? 'fairVerified'
      : signed && result.sourceVerified ? 'sourceOnly' : result.diceStatus === 'verified' ? 'diceOnly' : 'incomplete';
    // Legacy consistency is a positive, neutral result, not a fair-source badge.
    const visualStatus = result.status === 'mismatch' ? 'mismatch' : fullyVerified ? 'verified'
      : !signed && result.diceStatus === 'verified' ? 'matched' : 'incomplete';
    const main = resultCard(visualStatus, translate(titleKey));
    addDice(main, result.dice);
    if (fullyVerified) {
      paragraph(main, translate('fairDetail'));
      paragraph(main, translate('fairIndependent'));
    } else paragraph(main, translate(result.diceStatus === 'verified' ? 'diceVerified' : result.diceStatus === 'mismatch' ? 'diceMismatch' : 'expectedMissing'));
    paragraph(main, translate(result.hashStatus === 'verified' ? 'hashVerified' : result.hashStatus === 'mismatch' ? 'hashMismatch' : 'hashUnavailable'));
    if (result.inputStatus === 'mismatch') paragraph(main, translate('inputMismatch'));
    if (signed) {
      if (!result.sourceVerified) paragraph(main, translate('sourceUnknown'));
      else if (!result.reservationVerified) paragraph(main, translate(result.receiptKeyAvailable === false ? 'receiptKeyMissing' : 'receiptUnknown'));
      limits(main, 'fairLimits');
    } else {
      paragraph(main, translate('legacyLimits'));
      limits(main, 'explanationLimits');
    }
    out.append(main);
    out.append(valueCard(translate('historyHash'), result.hash));
    if (signed && result.proof) {
      out.append(valueCard(translate('sourceChain'), result.proof.chainHash || ''),
        valueCard(translate('sourceRound'), result.proof.beacon?.round ?? ''),
        disclosure(translate('sourceSignature'), result.proof.beacon?.signature || ''));
      out.append(disclosure(translate('proofDetails'), JSON.stringify(result.proof, null, 2)));
    }
    const fullInput = result.input === undefined ? formState.lastInput : result.input;
    if (typeof fullInput === 'string' && fullInput !== '') out.append(disclosure(translate('fullInput'), fullInput));
    if (Array.isArray(result.sourceBytes) && result.sourceBytes.length) {
      const bytes = result.sourceBytes.map((source, index) => {
        const value = typeof source === 'number' ? source : source && (source.sourceByte !== undefined ? source.sourceByte : source.value);
        const byteIndex = source && typeof source === 'object' ? (source.byteIndex !== undefined ? source.byteIndex : source.index) : undefined;
        if (!Number.isInteger(value) || value < 0 || value > 255) return '';
        const position = Number.isInteger(byteIndex) ? `[${byteIndex}]` : '';
        return `${translate('byte')}${position} = ${value} → (${value} % 6) + 1 = ${result.dice[index] || (value % 6) + 1}`;
      }).filter(Boolean);
      if (bytes.length) out.append(valueCard(translate('byteSources'), bytes.join('\n')));
    }
  }

  function showNotice(key) {
    noticeKey = key;
    const notice = get('verify-page-notice');
    notice.hidden = !key;
    notice.textContent = key ? translate(key) : '';
  }

  function fieldError(field, key) {
    field.setAttribute('aria-invalid', 'true');
    const error = new Error(translate(key));
    error.verifyTranslationKey = key;
    error.verifyField = field;
    return error;
  }

  function readText(id, maximum, required) {
    const input = get(id);
    const value = input.value;
    if (value.length > maximum) throw fieldError(input, 'tooLong');
    if (required && value.length === 0) throw fieldError(input, 'required');
    return value;
  }

  function readHash(id, required) {
    const input = get(id);
    const value = input.value.trim();
    if (!value && !required) return undefined;
    if (!hashPattern.test(value)) throw fieldError(input, 'badHash');
    return value;
  }

  function readDice(prefix) {
    const first = get(`${prefix}-die-one`);
    const second = get(`${prefix}-die-two`);
    const values = [first.value, second.value];
    if (values.every(value => value === '')) return undefined;
    if (values.some(value => !/^[1-6]$/.test(value))) {
      first.setAttribute('aria-invalid', 'true');
      throw fieldError(second, 'badDice');
    }
    return values.map(Number);
  }

  function argumentsFor() {
    const proof = readText('portal-proof', 16384, false);
    const options = { hash: readHash('portal-hash', proof.trim() === ''), expectedDice: readDice('portal') };
    const preimage = readText('portal-preimage', 4096, false);
    if (preimage !== '') options.preimage = preimage;
    if (proof.trim() !== '') {
      try {
        const parsed = JSON.parse(proof);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        options.proof = parsed;
      } catch { throw fieldError(get('portal-proof'), 'badProof'); }
    }
    return options;
  }

  function updateButton(state) {
    state.button.disabled = state.busy || !state.available;
    state.button.textContent = translate(state.busy ? 'busy' : state.buttonKey);
    state.form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  function renderError(state, error) {
    state.out.replaceChildren();
    const card = resultCard('incomplete', translate('errorTitle'));
    const coreKey = { INVALID_HASH: 'badHash', INVALID_DICE: 'badDice', INVALID_INPUT: 'badInput', CRYPTO_UNAVAILABLE: 'unavailable',
      FAIR_PROOF_UNAVAILABLE: 'unavailable', FAIR_CRYPTO_UNAVAILABLE: 'unavailable', FAIR_REQUEST_INVALID: 'badProof',
      FAIR_PROTOCOL_INVALID: 'badProtocol', FAIR_RESERVATION_MISMATCH: 'badReservation', FAIR_RECEIPT_INVALID: 'badReceipt',
      FAIR_CONTEXT_MISMATCH: 'badContext', FAIR_REQUEST_NOT_FUTURE: 'badFuture', FAIR_BEACON_INVALID: 'badBeacon',
      FAIR_BEACON_SIGNATURE_INVALID: 'badSource', FAIR_DICE_MISMATCH: 'badDerived' }[error.code];
    paragraph(card, error.verifyTranslationKey || coreKey ? translate(error.verifyTranslationKey || coreKey) : String(error.message || error));
    state.out.append(card);
  }

  function bindForm(kind, buttonKey, method) {
    const state = { kind, buttonKey, method, form: get(`verify-${kind}-form`), button: get(`verify-${kind}-submit`), out: get(`verify-${kind}-result`), revision: 0, epoch: 0, busy: false, result: null, error: null, lastInput: '', available: Boolean(window.NarduVerify && typeof window.NarduVerify[method] === 'function') };
    forms.push(state);
    updateButton(state);
    state.form.addEventListener('input', () => {
      state.revision += 1;
      state.result = null;
      state.error = null;
      state.lastInput = '';
      state.form.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
      if (state.out.childNodes.length) state.out.replaceChildren(resultCard('incomplete', translate('changed')));
    });
    state.form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!state.available || state.busy) return;
      const epoch = ++state.epoch;
      const revision = state.revision;
      state.result = null;
      state.error = null;
      state.form.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
      state.busy = true;
      updateButton(state);
      state.out.replaceChildren(resultCard('incomplete', translate('busy')));
      try {
        const options = argumentsFor();
        state.lastInput = options.preimage || '';
        const selectedMethod = Object.prototype.hasOwnProperty.call(options, 'proof') ? 'verifyFairRoll' : method;
        if (typeof window.NarduVerify[selectedMethod] !== 'function') throw Object.assign(new Error(translate('unavailable')), { code: 'FAIR_PROOF_UNAVAILABLE' });
        const result = await window.NarduVerify[selectedMethod](options);
        if (epoch !== state.epoch || revision !== state.revision) return;
        state.result = result;
        renderResult(state, result);
      } catch (error) {
        if (epoch !== state.epoch || revision !== state.revision) return;
        state.error = error;
        renderError(state, error);
        if (error.verifyField) error.verifyField.focus();
      } finally {
        if (epoch === state.epoch) { state.busy = false; updateButton(state); }
      }
    });
    return state;
  }

  function applyLanguage(next) {
    if (!['ru', 'en'].includes(next)) return;
    language = next;
    document.documentElement.lang = next;
    document.title = translate('title');
    document.querySelectorAll('[data-verify-i18n]').forEach(node => { node.textContent = translate(node.dataset.verifyI18n); });
    document.querySelectorAll('[data-verify-i18n-aria]').forEach(node => { node.setAttribute('aria-label', translate(node.dataset.verifyI18nAria)); });
    document.querySelectorAll('[data-verify-lang]').forEach(button => { button.setAttribute('aria-pressed', button.dataset.verifyLang === next ? 'true' : 'false'); });
    forms.forEach(state => {
      updateButton(state);
      if (state.result) renderResult(state, state.result);
      else if (state.error) renderError(state, state.error);
    });
    showNotice(noticeKey);
  }

  function importPublicFragment() {
    if (window.location.search) showNotice('queryIgnored');
    const fragment = window.location.hash.slice(1);
    const state = forms[0];
    state.epoch += 1;
    state.revision += 1;
    state.busy = false;
    state.result = null;
    state.error = null;
    state.lastInput = '';
    state.out.replaceChildren();
    ['portal-hash', 'portal-die-one', 'portal-die-two', 'portal-preimage', 'portal-proof'].forEach(id => {
      const input = get(id);
      input.value = '';
      input.removeAttribute('aria-invalid');
    });
    updateButton(state);
    if (!fragment) { showNotice(window.location.search ? 'queryIgnored' : ''); return; }
    if (fragment.length > 256) { showNotice('importInvalid'); return; }
    let params;
    try { params = new URLSearchParams(fragment); } catch (_) { showNotice('importInvalid'); return; }
    const keys = Array.from(params.keys());
    if (keys.some(key => !['hash', 'dice', 'color'].includes(key)) || new Set(keys).size !== keys.length || !hashPattern.test(params.get('hash') || '')) { showNotice('importInvalid'); return; }
    const dice = params.get('dice');
    const color = params.get('color');
    if ((dice !== null && !/^[1-6][,:][1-6]$/.test(dice)) || (color !== null && !['white', 'dark'].includes(color))) { showNotice('importInvalid'); return; }
    get('portal-hash').value = params.get('hash');
    if (dice !== null) {
      const values = dice.split(/[,:]/);
      get('portal-die-one').value = values[0];
      get('portal-die-two').value = values[1];
      showNotice(window.location.search ? 'queryIgnored' : 'importReady');
      if (forms[0].available) {
        if (typeof forms[0].form.requestSubmit === 'function') forms[0].form.requestSubmit();
        else forms[0].form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    } else showNotice(window.location.search ? 'queryIgnored' : 'importHashReady');
  }

  bindForm('portal', 'checkPortal', 'verifyPortalRoll');
  document.querySelectorAll('[data-verify-lang]').forEach(button => button.addEventListener('click', () => applyLanguage(button.dataset.verifyLang)));
  document.querySelectorAll('[data-verify-theme]').forEach(button => button.addEventListener('click', () => {
    const next = button.dataset.verifyTheme;
    if (!['day', 'night'].includes(next)) return;
    document.documentElement.dataset.theme = next;
    document.querySelectorAll('[data-verify-theme]').forEach(item => item.setAttribute('aria-pressed', item.dataset.verifyTheme === next ? 'true' : 'false'));
  }));
  applyLanguage(language);
  if (forms.some(state => !state.available)) showNotice('unavailable');
  else {
    importPublicFragment();
    window.addEventListener('hashchange', importPublicFragment);
  }
})();
