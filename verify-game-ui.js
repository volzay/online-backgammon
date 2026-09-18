/* Standalone, local-only UI. Never persist or send verification inputs. */
(function () {
  'use strict';

  const text = {
    ru: {
      title: 'Нарды — Проверка броска', back: 'В лобби', theme: 'Тема', language: 'Язык', day: 'День', night: 'Ночь',
      kicker: 'Нарды Онлайн · проверка данных', heading: 'Проверка броска',
      lead: 'Проверьте подписанный расчёт броска и соответствие костей истории партии. Вычисления выполняются в этом браузере; введённые значения не отправляются и не сохраняются.',
      portalTitle: 'Бросок на этом портале',
      portalIntro: 'В истории броска нажмите «Полная проверка»: данные завершённого броска передаются сюда автоматически между вкладками этого портала, без помещения JSON в адрес страницы. Для сохранённого файла или старой ссылки используйте ручной ввод ниже.',
      proofSummary: 'Ручной ввод JSON (для файла или старой ссылки)', proofLabel: 'JSON-доказательство (необязательно при автоматическом открытии)',
      proofHint: 'Вставьте запись завершённого броска из его подробностей. Программа проверит подпись сервера и расчёт по протоколу записи: серверный CSPRNG + HMAC либо drand. Ключ сервера берётся только из настроек портала. JSON не импортируется из адреса страницы.',
      portalHash: 'SHA-256 из истории броска', hashHint: 'Ровно 64 шестнадцатеричных символа: 0–9, a–f.',
      dieOne: 'Кость 1 из истории', dieTwo: 'Кость 2 из истории',
      preimageSummary: 'Ручной ввод исходной строки (старые SHA-записи)', preimageLabel: 'Исходное значение SHA-256 (необязательно)',
      preimageHint: 'Вставьте раскрытое значение именно этого завершённого броска. Пробелы и переводы строк значимы. Не вводите пароль от аккаунта.',
      checkPortal: 'Проверить бросок', explanationTitle: 'Что именно проверяется',
      explanationPortal: 'Байты потока читаются слева направо: значения 252–255 пропускаются, первые два подходящих байта дают кости по формуле (байт % 6) + 1. В серверной схеме поток создаётся HMAC-SHA256 из раскрытых server seed, client seed и контекста партии; SHA-256 записи подтверждает её целостность. Для неё необходим JSON броска, а не только хеш.',
      explanationSource: 'Серверная схема CSPRNG + commit/reveal проверяет подписанное обязательство, раскрытые значения и расчёт HMAC. Она одинакова для игроков и ботов и не использует их игровую стратегию. В прежней схеме drand отдельно проверяется подпись независимого источника и подписанное сервером резервирование.',
      limitationsSummary: 'Границы проверки',
      explanationLimits: 'Серверная схема подтверждает подпись, неизменность обязательства и расчёт, но не является независимым доказательством энтропии или времени публикации. Схема drand дополнительно подтверждает подпись независимого источника. Старые SHA-записи проверяют только соответствие. Законность перемещения шашек здесь не проверяется.',
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
      systemVerified: 'Подпись и расчёт броска подтверждены', systemDetail: 'Подпись сервера верна, раскрытый server seed совпадает с обязательством SHA-256, кости точно соответствуют расчёту HMAC-SHA256.',
      systemCalculationOnly: 'Расчёт HMAC-SHA256 совпал', systemDiceVerified: 'Кости соответствуют расчёту HMAC-SHA256.',
      systemShared: 'Игроки и боты используют один серверный криптографический протокол. Игровая стратегия не участвует в расчёте костей.',
      systemLimits: 'Случайность создаётся на сервере CSPRNG операционной системы. Проверка подтверждает подпись, обязательство и расчёт; она не является независимым доказательством источника энтропии или времени публикации обязательства.',
      systemProofRequired: 'Старая ссылка содержит только хеш и кости. Вернитесь к броску в «Ход партии» и нажмите «Полная проверка» либо «Проверить». Для независимой ручной проверки вставьте JSON из кнопки «Скопировать JSON» в открытое поле ниже: один SHA-256 не содержит расчёт этого протокола.',
      receiving: 'Получаем данные броска…', transferReady: 'Полные данные броска получены. Выполняем проверку подписи и расчёта.',
      transferUnavailable: 'Данные броска не получены: вкладка игры могла закрыться или время передачи истекло. Вернитесь к броску в «Ход партии» и нажмите «Полная проверка» либо «Проверить». Можно также нажать «Скопировать JSON» и вставить запись в открытое поле ручной проверки ниже.',
      transferMismatch: 'Полученные данные не соответствуют хешу и костям в ссылке. Вернитесь к нужному броску и нажмите «Полная проверка» либо «Проверить».',
      signedProofRequired: 'Для подписанного броска нужен полный JSON. Вернитесь к броску и нажмите «Полная проверка» либо «Проверить», или вставьте запись из «Скопировать JSON» в открытое поле ниже.',
      systemCommitment: 'Подписанное обязательство SHA-256', systemServerSeed: 'Раскрытый server seed', systemClientSeed: 'Client seed', systemStream: 'Поток HMAC-SHA256',
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
      lead: 'Verify the signed roll calculation and compare the dice with the game history. Calculations run in this browser; entered values are neither sent nor saved.',
      portalTitle: 'A roll on this portal',
      portalIntro: 'Select “Full verification” in the roll history: the completed roll data is transferred automatically between this portal’s tabs, without putting JSON in the URL. For a saved file or an older link, use the manual input below.',
      proofSummary: 'Manual JSON input (saved file or older link)', proofLabel: 'JSON proof (optional when opened automatically)',
      proofHint: 'Paste the completed roll’s record from its details. The verifier checks the server signature and recorded calculation protocol: server CSPRNG + HMAC or drand. The server key comes only from portal configuration. JSON is never imported from the URL.',
      portalHash: 'SHA-256 from the roll history', hashHint: 'Exactly 64 hexadecimal characters: 0–9, a–f.',
      dieOne: 'Die 1 from the history', dieTwo: 'Die 2 from the history',
      preimageSummary: 'Manual input string (older SHA-only records)', preimageLabel: 'SHA-256 input (optional)',
      preimageHint: 'Paste the disclosed input of this completed roll. Spaces and line breaks matter. Do not enter your account password.',
      checkPortal: 'Verify roll', explanationTitle: 'What this verifies',
      explanationPortal: 'Stream bytes are read left to right: values 252–255 are skipped and the first two accepted bytes become dice using (byte % 6) + 1. In the server scheme HMAC-SHA256 creates the stream from disclosed server seed, client seed and game context; the record’s SHA-256 verifies its integrity. This requires the roll JSON, not just its hash.',
      explanationSource: 'The server CSPRNG + commit/reveal scheme checks the signed commitment, disclosed inputs and HMAC calculation. Players and bots use the same scheme, without game-strategy inputs. The earlier drand scheme separately checks the independent source signature and signed server reservation.',
      limitationsSummary: 'Verification limits',
      explanationLimits: 'The server scheme verifies the signature, commitment integrity and calculation, not independent entropy or publication timing. The drand scheme additionally verifies the independent source signature. Older SHA-only records verify consistency. Checker-move legality is not checked.',
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
      systemVerified: 'Roll signature and calculation verified', systemDetail: 'The server signature is valid, the disclosed server seed matches the SHA-256 commitment, and the dice exactly match the HMAC-SHA256 calculation.',
      systemCalculationOnly: 'HMAC-SHA256 calculation matches', systemDiceVerified: 'The dice match the HMAC-SHA256 calculation.',
      systemShared: 'Players and bots use the same server cryptographic protocol. Game strategy is not used to calculate dice.',
      systemLimits: 'Randomness is created by the server operating system CSPRNG. Verification confirms the signature, commitment and calculation; it is not independent proof of entropy or commitment publication timing.',
      systemProofRequired: 'This older link contains only the hash and dice. Return to the roll in “Game history” and select “Full verification” or “Verify”. For an independent manual check, paste JSON from “Copy JSON” into the open field below: SHA-256 alone does not contain this protocol’s calculation.',
      receiving: 'Receiving roll data…', transferReady: 'Complete roll data received. Checking the signature and calculation.',
      transferUnavailable: 'The roll data was not received: the game tab may have closed or the transfer expired. Return to the roll in “Game history” and select “Full verification” or “Verify”. You can also select “Copy JSON” and paste the record into the open manual verification field below.',
      transferMismatch: 'The received data does not match the hash and dice in this link. Return to the correct roll and select “Full verification” or “Verify”.',
      signedProofRequired: 'A signed roll needs the complete JSON. Return to the roll and select “Full verification” or “Verify”, or paste the record from “Copy JSON” into the open field below.',
      systemCommitment: 'Signed SHA-256 commitment', systemServerSeed: 'Disclosed server seed', systemClientSeed: 'Client seed', systemStream: 'HMAC-SHA256 stream',
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
  let importedProtocol = '';
  let importedContext;
  let transferBlocked = false;
  let transferController;
  const forms = [];
  const get = id => document.getElementById(id);
  const translate = key => text[language][key] || key;
  const hashPattern = /^[0-9a-f]{64}$/i;
  const signedProtocols = ['system-csprng-v1', 'drand', 'drand-quicknet-v1'];

  function cancelTransfer() {
    if (transferController) transferController.abort();
    transferController = undefined;
  }

  function revealManualProof() {
    get('portal-proof-manual').open = true;
    get('portal-proof').focus();
  }

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
    const system = result.protocol === 'system-csprng-v1';
    const signed = system || ['drand', 'drand-quicknet-v1'].includes(result.protocol);
    const fullyVerified = signed && result.status === 'verified' && (system ? result.commitmentVerified === true : result.sourceVerified === true)
      && result.reservationVerified === true && result.diceStatus === 'verified';
    const titleKey = result.status === 'mismatch' ? 'mismatch' : fullyVerified ? system ? 'systemVerified' : 'fairVerified'
      : signed && result.sourceVerified ? 'sourceOnly' : result.diceStatus === 'verified' ? system ? 'systemCalculationOnly' : 'diceOnly' : 'incomplete';
    // Legacy consistency is a positive, neutral result, not a fair-source badge.
    const visualStatus = result.status === 'mismatch' ? 'mismatch' : fullyVerified ? 'verified'
      : !signed && result.diceStatus === 'verified' ? 'matched' : 'incomplete';
    const main = resultCard(visualStatus, translate(titleKey));
    addDice(main, result.dice);
    if (fullyVerified) {
      paragraph(main, translate(system ? 'systemDetail' : 'fairDetail'));
      paragraph(main, translate(system ? 'systemShared' : 'fairIndependent'));
    } else paragraph(main, translate(result.diceStatus === 'verified' ? system ? 'systemDiceVerified' : 'diceVerified' : result.diceStatus === 'mismatch' ? 'diceMismatch' : 'expectedMissing'));
    paragraph(main, translate(result.hashStatus === 'verified' ? 'hashVerified' : result.hashStatus === 'mismatch' ? 'hashMismatch' : 'hashUnavailable'));
    if (result.inputStatus === 'mismatch') paragraph(main, translate('inputMismatch'));
    if (signed) {
      if (system) {
        if (!result.reservationVerified) paragraph(main, translate('receiptUnknown'));
      } else if (!result.sourceVerified) paragraph(main, translate('sourceUnknown'));
      else if (!result.reservationVerified) paragraph(main, translate(result.receiptKeyAvailable === false ? 'receiptKeyMissing' : 'receiptUnknown'));
      limits(main, system ? 'systemLimits' : 'fairLimits');
    } else {
      paragraph(main, translate('legacyLimits'));
      limits(main, 'explanationLimits');
    }
    out.append(main);
    out.append(valueCard(translate('historyHash'), result.hash));
    if (signed && result.proof) {
      if (system) out.append(valueCard(translate('systemCommitment'), result.proof.request?.commitment || ''),
        valueCard(translate('systemServerSeed'), result.proof.commitReveal?.serverSeed || ''),
        valueCard(translate('systemClientSeed'), result.proof.commitReveal?.clientSeed || ''),
        disclosure(translate('systemStream'), (result.proof.commitReveal?.blocks || []).join('\n')));
      else out.append(valueCard(translate('sourceChain'), result.proof.chainHash || ''),
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
    if (proof.trim() === '' && (transferBlocked || signedProtocols.includes(importedProtocol))) {
      revealManualProof();
      throw fieldError(get('portal-proof'), transferBlocked ? 'transferUnavailable' : importedProtocol === 'system-csprng-v1' ? 'systemProofRequired' : 'signedProofRequired');
    }
    const options = { hash: readHash('portal-hash', proof.trim() === ''), expectedDice: readDice('portal') };
    const preimage = readText('portal-preimage', 4096, false);
    if (preimage !== '') options.preimage = preimage;
    if (proof.trim() !== '') {
      try {
        const parsed = JSON.parse(proof);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        options.proof = parsed;
      } catch { throw fieldError(get('portal-proof'), 'badProof'); }
      if (importedContext) options.context = importedContext;
    }
    return options;
  }

  function updateButton(state) {
    state.button.disabled = state.busy || state.receiving || !state.available;
    state.button.textContent = translate(state.receiving ? 'receiving' : state.busy ? 'busy' : state.buttonKey);
    state.form.setAttribute('aria-busy', state.busy || state.receiving ? 'true' : 'false');
  }

  function renderError(state, error) {
    state.out.replaceChildren();
    const card = resultCard('incomplete', translate('errorTitle'));
    const coreKey = { INVALID_HASH: 'badHash', INVALID_DICE: 'badDice', INVALID_INPUT: 'badInput', CRYPTO_UNAVAILABLE: 'unavailable',
      FAIR_PROOF_UNAVAILABLE: 'unavailable', FAIR_CRYPTO_UNAVAILABLE: 'unavailable', FAIR_REQUEST_INVALID: 'badProof',
      FAIR_PROTOCOL_INVALID: 'badProtocol', FAIR_RESERVATION_MISMATCH: 'badReservation', FAIR_RECEIPT_INVALID: 'badReceipt',
      FAIR_CONTEXT_MISMATCH: 'badContext', FAIR_REQUEST_NOT_FUTURE: 'badFuture', FAIR_BEACON_INVALID: 'badBeacon',
      FAIR_BEACON_SIGNATURE_INVALID: 'badSource', FAIR_DICE_MISMATCH: 'badDerived', FAIR_SYSTEM_PROOF_INVALID: 'badProof',
      FAIR_SYSTEM_SEED_INVALID: 'badProof', FAIR_SYSTEM_COMMITMENT_MISMATCH: 'badDerived' }[error.code];
    paragraph(card, error.verifyTranslationKey || coreKey ? translate(error.verifyTranslationKey || coreKey) : String(error.message || error));
    state.out.append(card);
  }

  function bindForm(kind, buttonKey, method) {
    const state = { kind, buttonKey, method, form: get(`verify-${kind}-form`), button: get(`verify-${kind}-submit`), out: get(`verify-${kind}-result`), revision: 0, epoch: 0, busy: false, result: null, error: null, lastInput: '', available: Boolean(window.NarduVerify && typeof window.NarduVerify[method] === 'function') };
    forms.push(state);
    updateButton(state);
    state.form.addEventListener('input', () => {
      cancelTransfer();
      state.receiving = false;
      importedContext = undefined;
      state.revision += 1;
      state.result = null;
      state.error = null;
      state.lastInput = '';
      state.form.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
      if (state.out.childNodes.length) state.out.replaceChildren(resultCard('incomplete', translate('changed')));
      if (noticeKey === 'receiving' || noticeKey === 'transferReady') showNotice('changed');
      updateButton(state);
    });
    state.form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!state.available || state.busy || state.receiving) return;
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
        if (error.verifyField) {
          if (error.verifyField === get('portal-proof')) revealManualProof();
          else error.verifyField.focus();
        }
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

  async function importPublicFragment() {
    cancelTransfer();
    importedProtocol = '';
    importedContext = undefined;
    transferBlocked = false;
    if (window.location.search) showNotice('queryIgnored');
    const fragment = window.location.hash.slice(1);
    const state = forms[0];
    state.epoch += 1;
    state.revision += 1;
    state.busy = false;
    state.receiving = false;
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
    if (fragment.length > 384) { showNotice('importInvalid'); return; }
    let params;
    try { params = new URLSearchParams(fragment); } catch (_) { showNotice('importInvalid'); return; }
    const keys = Array.from(params.keys());
    if (keys.some(key => !['hash', 'dice', 'color', 'protocol', 'transfer'].includes(key)) || new Set(keys).size !== keys.length || !hashPattern.test(params.get('hash') || '')) { showNotice('importInvalid'); return; }
    const dice = params.get('dice');
    const color = params.get('color');
    const protocol = params.get('protocol');
    const token = params.get('transfer');
    if ((dice !== null && !/^[1-6][,:][1-6]$/.test(dice)) || (color !== null && !['white', 'dark'].includes(color))
      || (protocol !== null && !signedProtocols.includes(protocol))
      || (token !== null && (!/^[a-f0-9]{48}$/.test(token) || dice === null))) { showNotice('importInvalid'); return; }
    importedProtocol = protocol || '';
    get('portal-hash').value = params.get('hash');
    if (dice !== null) {
      const values = dice.split(/[,:]/);
      get('portal-die-one').value = values[0];
      get('portal-die-two').value = values[1];
      if (token !== null) {
        transferBlocked = true;
        state.receiving = true;
        updateButton(state);
        showNotice('receiving');
        const epoch = state.epoch;
        const revision = state.revision;
        const initialFields = ['portal-hash', 'portal-die-one', 'portal-die-two', 'portal-preimage', 'portal-proof'].map(id => get(id).value);
        const unchanged = () => epoch === state.epoch && revision === state.revision && window.location.hash.slice(1) === fragment
          && initialFields.every((value, index) => value === get(['portal-hash', 'portal-die-one', 'portal-die-two', 'portal-preimage', 'portal-proof'][index]).value);
        let controller;
        try {
          if (typeof window.NarduRollProofTransfer?.receive !== 'function') throw new Error('transfer unavailable');
          controller = typeof window.AbortController === 'function' ? new window.AbortController() : undefined;
          transferController = controller;
          const payload = await window.NarduRollProofTransfer.receive(token, controller ? { signal: controller.signal } : {});
          if (!unchanged()) return;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('missing transfer payload');
          if (typeof payload.hash !== 'string' || payload.hash.toLowerCase() !== params.get('hash').toLowerCase()
            || !Array.isArray(payload.expectedDice) || payload.expectedDice.length !== 2
            || !payload.expectedDice.every((value, index) => Number.isInteger(value) && value === Number(values[index]))) {
            showNotice('transferMismatch');
            revealManualProof();
            return;
          }
          const proof = payload.proof;
          const proofText = proof === undefined ? '' : JSON.stringify(proof);
          if (proof !== undefined && (!proof || typeof proof !== 'object' || Array.isArray(proof) || proofText.length > 16384)
            || payload.preimage !== undefined && (typeof payload.preimage !== 'string' || payload.preimage.length > 4096)
            || payload.context !== undefined && (!payload.context || typeof payload.context !== 'object' || Array.isArray(payload.context))
            || importedProtocol && proof?.protocol !== importedProtocol
            || signedProtocols.includes(importedProtocol) && proof === undefined) throw new Error('invalid transfer payload');
          // The channel is transport, not a trust root. Crypto verification still
          // uses the configured portal key and the history's expected context.
          get('portal-proof').value = proofText;
          get('portal-preimage').value = payload.preimage || '';
          importedContext = payload.context === undefined ? undefined : JSON.parse(JSON.stringify(payload.context));
          transferBlocked = false;
          state.receiving = false;
          updateButton(state);
          showNotice('transferReady');
          if (state.available) {
            if (typeof state.form.requestSubmit === 'function') state.form.requestSubmit();
            else state.form.dispatchEvent(new Event('submit', { cancelable: true }));
          }
        } catch (_) {
          if (!unchanged()) return;
          showNotice('transferUnavailable');
          revealManualProof();
        } finally {
          if (epoch === state.epoch && revision === state.revision) {
            state.receiving = false;
            updateButton(state);
          }
          if (transferController === controller) transferController = undefined;
        }
        return;
      }
      showNotice(window.location.search ? 'queryIgnored' : importedProtocol === 'system-csprng-v1' ? 'systemProofRequired' : importedProtocol ? 'signedProofRequired' : 'importReady');
      if (importedProtocol) revealManualProof();
      if (forms[0].available && !importedProtocol) {
        if (typeof forms[0].form.requestSubmit === 'function') forms[0].form.requestSubmit();
        else forms[0].form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    } else if (importedProtocol) {
      showNotice(importedProtocol === 'system-csprng-v1' ? 'systemProofRequired' : 'signedProofRequired');
      revealManualProof();
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
