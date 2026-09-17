/* Standalone, local-only UI. Never persist or send verification inputs. */
(function () {
  'use strict';

  const text = {
    ru: {
      title: 'Нарды — Проверка броска', back: 'В лобби', theme: 'Тема', language: 'Язык', day: 'День', night: 'Ночь',
      kicker: 'Нарды Онлайн · проверка данных', heading: 'Проверка броска',
      lead: 'Сверьте кости с SHA-256 из истории партии. Вычисления выполняются только в этом браузере; введённые значения не отправляются и не сохраняются.',
      portalTitle: 'Бросок на этом портале',
      portalIntro: 'В истории броска откройте «Проверить» или скопируйте SHA-256 и обе кости. Одного хеша достаточно для проверки соответствия костей, но не для подтверждения происхождения хеша.',
      portalHash: 'SHA-256 из истории броска', hashHint: 'Ровно 64 шестнадцатеричных символа: 0–9, a–f.',
      dieOne: 'Кость 1 из истории', dieTwo: 'Кость 2 из истории', expectedOne: 'Ожидаемая кость 1', expectedTwo: 'Ожидаемая кость 2',
      preimageSummary: 'Есть раскрытое исходное значение для этого броска?', preimageLabel: 'Исходное значение SHA-256 (необязательно)',
      preimageHint: 'Вставьте раскрытое значение именно этого завершённого броска. Пробелы и переводы строк значимы. Не вводите пароль от аккаунта.',
      checkPortal: 'Проверить бросок', explanationTitle: 'Что именно проверяется',
      explanationPortal: 'Для бросков портала байты SHA-256 читаются слева направо. Значения 252–255 пропускаются; первые два подходящих байта дают кости по формуле (байт % 6) + 1. Пропуск исключает смещение при таком преобразовании байтов.',
      explanationLimits: 'Совпадение костей и хеша не доказывает случайность или невозможность подбора хеша сервером. Раскрытое исходное значение позволяет дополнительно сверить SHA-256, но эта страница не подтверждает, когда хеш был опубликован. Проверка законности перемещения шашек здесь не выполняется.',
      manualTitle: 'Дополнительная ручная проверка по образцу',
      manualNotice: 'Это отдельный протокол из образца, а не алгоритм бросков этого портала. Server Seed, Client Seed, Game ID и Nonce в старых записях портала отсутствуют; их нельзя восстановить по SHA-256 броска.',
      seedTitle: '1. Сверить раскрытый Server Seed', seedHashLabel: 'Опубликованный SHA-256 (необязательно)',
      seedHashHint: 'Хеш, опубликованный до игры в системе с этим протоколом. Без него можно только рассчитать SHA-256.',
      checkSeed: 'Проверить SHA-256', hmacTitle: '2. Рассчитать бросок HMAC-SHA256',
      hmacIntro: 'Ключ — UTF-8(Server Seed). Формат сообщения фиксирован: {gameId}:{clientSeed}:{nonce}. Кости извлекаются из байтов HMAC с тем же пропуском 252–255.',
      hmacHashLabel: 'Ожидаемый HMAC-SHA256 (необязательно)', hmacHashHint: 'HMAC именно этого броска по ручному протоколу, не SHA-256 Server Seed и не хеш броска портала.', nonceHint: 'Целое число от 0 до 9007199254740991. Протокол определяет нумерацию бросков.',
      messageFormat: 'Формат сообщения', checkHmac: 'Рассчитать и сверить HMAC',
      footer: 'Проверка доступна без входа в аккаунт. Не вводите пароли, токены или значения для будущих бросков.',
      busy: 'Проверяем…', unavailable: 'Модуль проверки недоступен. Откройте страницу по HTTPS или на localhost и проверьте, загрузились ли её скрипты.',
      changed: 'Данные изменены. Нажмите кнопку для новой проверки.', errorTitle: 'Не удалось выполнить проверку',
      required: 'Заполните обязательное поле.', badHash: 'SHA-256 должен содержать ровно 64 символа 0–9 или a–f.',
      tooLong: 'Значение превышает допустимую длину.', badDice: 'Укажите обе кости целыми числами от 1 до 6 или оставьте обе пустыми.', badInput: 'Проверьте обязательные поля и формат введённых значений.',
      badNonce: 'Nonce должен быть целым десятичным числом от 0 до 9007199254740991.',
      portalVerified: 'Хеш и бросок совпадают', mismatch: 'Обнаружено несовпадение', incomplete: 'Проверка неполная',
      diceOnly: 'Кости совпадают. Доказательство неполное', diceVerified: 'Кости соответствуют указанному хешу.', diceMismatch: 'Кости не соответствуют указанному хешу.',
      diceUnavailable: 'Нет двух ожидаемых костей или недостаточно подходящих байтов для их расчёта.',
      hashVerified: 'Раскрытое исходное значение соответствует SHA-256.', hashMismatch: 'SHA-256 раскрытого исходного значения не совпадает с указанным хешем.',
      hashUnavailable: 'Исходное значение не раскрыто: происхождение SHA-256 не подтверждено.',
      noFairness: 'Эта проверка не доказывает случайность броска или публикацию хеша до броска.',
      computedHash: 'Рассчитанный SHA-256', historyHash: 'SHA-256 броска', computedDice: 'Рассчитанные кости',
      seedVerified: 'Server Seed соответствует опубликованному SHA-256', seedMismatch: 'Server Seed не соответствует опубликованному SHA-256', seedCalculated: 'SHA-256 рассчитан; опубликованный хеш не указан',
      hmacVerified: 'Данные совпадают по протоколу HMAC-SHA256', hmacCalculated: 'HMAC рассчитан; проверка неполная',
      hmacLimits: 'Результат относится только к указанному ручному протоколу. Он не подтверждает алгоритм этого портала или время публикации Server Seed Hash.',
      hmacMessage: 'Сообщение HMAC', hmacHash: 'HMAC-SHA256', byteSources: 'Байты — источники костей',
      byte: 'Байт', die: 'кость', importInvalid: 'Параметры ссылки не прошли проверку. Заполните поля вручную.',
      importReady: 'SHA-256 и кости импортированы из истории. Исходное значение в ссылке не передаётся.',
      importHashReady: 'SHA-256 импортирован. Для сверки добавьте обе кости из истории.',
      queryIgnored: 'Параметры после «?» не импортируются. Секретные исходные значения нельзя передавать в адресе страницы.',
    },
    en: {
      title: 'Backgammon — Roll verification', back: 'Back to lobby', theme: 'Theme', language: 'Language', day: 'Day', night: 'Night',
      kicker: 'Backgammon Online · data verification', heading: 'Verify a roll',
      lead: 'Compare the dice with the SHA-256 in the game history. Calculations run only in this browser; entered values are neither sent nor saved.',
      portalTitle: 'A roll on this portal',
      portalIntro: 'Select “Verify” in the roll history, or copy its SHA-256 and both dice. The hash alone lets you check the dice mapping, but not the origin of the hash.',
      portalHash: 'SHA-256 from the roll history', hashHint: 'Exactly 64 hexadecimal characters: 0–9, a–f.',
      dieOne: 'Die 1 from the history', dieTwo: 'Die 2 from the history', expectedOne: 'Expected die 1', expectedTwo: 'Expected die 2',
      preimageSummary: 'Have the disclosed input for this roll?', preimageLabel: 'SHA-256 input (optional)',
      preimageHint: 'Paste the disclosed input of this completed roll. Spaces and line breaks matter. Do not enter your account password.',
      checkPortal: 'Verify roll', explanationTitle: 'What this verifies',
      explanationPortal: 'For portal rolls, SHA-256 bytes are read from left to right. Values 252–255 are skipped; the first two eligible bytes become dice using (byte % 6) + 1. Skipping these values removes bias in the byte-to-die conversion.',
      explanationLimits: 'Matching dice and hash do not prove randomness or prevent the server from choosing a hash. A disclosed input additionally lets you compare SHA-256, but this page cannot verify when the hash was published. This page does not check the legality of checker moves.',
      manualTitle: 'Additional manual verification from the example',
      manualNotice: 'This is the separate protocol from the example, not this portal’s roll algorithm. Server Seed, Client Seed, Game ID and Nonce are absent from historical portal records; they cannot be recovered from a roll’s SHA-256.',
      seedTitle: '1. Check a disclosed Server Seed', seedHashLabel: 'Published SHA-256 (optional)',
      seedHashHint: 'The hash published before a game in a system using this protocol. Without it, only SHA-256 can be calculated.',
      checkSeed: 'Verify SHA-256', hmacTitle: '2. Calculate an HMAC-SHA256 roll',
      hmacIntro: 'The key is UTF-8(Server Seed). The fixed message format is {gameId}:{clientSeed}:{nonce}. Dice are extracted from HMAC bytes, skipping 252–255 in the same way.',
      hmacHashLabel: 'Expected HMAC-SHA256 (optional)', hmacHashHint: 'The HMAC of this roll under the manual protocol, not SHA-256 of Server Seed or the portal roll hash.', nonceHint: 'An integer from 0 to 9007199254740991. The protocol defines roll numbering.',
      messageFormat: 'Message format', checkHmac: 'Calculate and compare HMAC',
      footer: 'No account login is required. Do not enter passwords, tokens or inputs for future rolls.',
      busy: 'Verifying…', unavailable: 'The verifier is unavailable. Open this page using HTTPS or localhost and check that its scripts loaded.',
      changed: 'Inputs changed. Select the button to verify again.', errorTitle: 'Unable to verify',
      required: 'Fill in the required field.', badHash: 'SHA-256 must contain exactly 64 characters from 0–9 or a–f.',
      tooLong: 'The value exceeds the permitted length.', badDice: 'Enter both dice as integers from 1 to 6, or leave both empty.', badInput: 'Check the required fields and the format of the entered values.',
      badNonce: 'Nonce must be a decimal integer from 0 to 9007199254740991.',
      portalVerified: 'Hash and dice match', mismatch: 'A mismatch was found', incomplete: 'Verification is incomplete',
      diceOnly: 'Dice match. Proof is incomplete', diceVerified: 'The dice match the supplied hash.', diceMismatch: 'The dice do not match the supplied hash.',
      diceUnavailable: 'Two expected dice were not supplied, or too few eligible bytes were available to calculate them.',
      hashVerified: 'The disclosed input matches SHA-256.', hashMismatch: 'SHA-256 of the disclosed input does not match the supplied hash.',
      hashUnavailable: 'The input has not been disclosed: the origin of SHA-256 is unverified.',
      noFairness: 'This check does not prove a random roll or publication of its hash before the roll.',
      computedHash: 'Calculated SHA-256', historyHash: 'Roll SHA-256', computedDice: 'Calculated dice',
      seedVerified: 'Server Seed matches the published SHA-256', seedMismatch: 'Server Seed does not match the published SHA-256', seedCalculated: 'SHA-256 calculated; no published hash supplied',
      hmacVerified: 'The data match the HMAC-SHA256 protocol', hmacCalculated: 'HMAC calculated; verification is incomplete',
      hmacLimits: 'This result applies only to the specified manual protocol. It does not verify this portal’s algorithm or when the Server Seed Hash was published.',
      hmacMessage: 'HMAC message', hmacHash: 'HMAC-SHA256', byteSources: 'Source bytes for the dice',
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
    if (['verified', 'mismatch', 'incomplete'].includes(status)) card.dataset.status = status;
    if (title) card.append(element('h3', 'verify-result-title', title));
    return card;
  }

  function paragraph(card, value) { card.append(element('p', '', value)); }

  function valueCard(label, value) {
    const card = resultCard();
    card.append(element('span', 'verify-output-label', label), element('code', 'verify-output-value', value));
    return card;
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
    if (formState.kind === 'seed') {
      const key = result.status === 'verified' ? 'seedVerified' : result.status === 'mismatch' ? 'seedMismatch' : 'seedCalculated';
      out.append(resultCard(result.status, translate(key)), valueCard(translate('computedHash'), result.hash));
      return;
    }
    const isPortal = formState.kind === 'portal';
    const titleKey = result.status === 'mismatch' ? 'mismatch' : result.status === 'verified' ? (isPortal ? 'portalVerified' : 'hmacVerified') : isPortal && result.diceStatus === 'verified' ? 'diceOnly' : isPortal ? 'incomplete' : 'hmacCalculated';
    const main = resultCard(result.status, translate(titleKey));
    addDice(main, result.dice);
    if (isPortal) {
      paragraph(main, translate(result.diceStatus === 'verified' ? 'diceVerified' : result.diceStatus === 'mismatch' ? 'diceMismatch' : 'diceUnavailable'));
      paragraph(main, translate(result.hashStatus === 'verified' ? 'hashVerified' : result.hashStatus === 'mismatch' ? 'hashMismatch' : 'hashUnavailable'));
      paragraph(main, translate('noFairness'));
    } else paragraph(main, translate('hmacLimits'));
    out.append(main);
    if (isPortal) out.append(valueCard(translate('historyHash'), result.hash));
    else {
      if (typeof result.message === 'string') out.append(valueCard(translate('hmacMessage'), result.message));
      if (typeof result.hmac === 'string') out.append(valueCard(translate('hmacHash'), result.hmac));
      if (typeof result.hash === 'string') out.append(valueCard(translate('computedHash'), result.hash));
    }
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

  function readNonce() {
    const input = get('hmac-nonce');
    if (!/^(0|[1-9][0-9]{0,15})$/.test(input.value)) throw fieldError(input, 'badNonce');
    const value = Number(input.value);
    if (!Number.isSafeInteger(value) || value < 0) throw fieldError(input, 'badNonce');
    return input.value;
  }

  function argumentsFor(kind) {
    if (kind === 'portal') {
      const options = { hash: readHash('portal-hash', true), expectedDice: readDice('portal') };
      const preimage = readText('portal-preimage', 4096, false);
      if (preimage !== '') options.preimage = preimage;
      return options;
    }
    if (kind === 'seed') return { seed: readText('verify-seed', 4096, true), expectedHash: readHash('verify-seed-hash', false) };
    return {
      serverSeed: readText('hmac-server-seed', 4096, true),
      expectedHash: readHash('hmac-expected-hash', false),
      gameId: readText('hmac-game-id', 256, true),
      clientSeed: readText('hmac-client-seed', 256, true),
      nonce: readNonce(), expectedDice: readDice('hmac'),
    };
  }

  function updateButton(state) {
    state.button.disabled = state.busy || !state.available;
    state.button.textContent = translate(state.busy ? 'busy' : state.buttonKey);
    state.form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
  }

  function renderError(state, error) {
    state.out.replaceChildren();
    const card = resultCard('mismatch', translate('errorTitle'));
    const coreKey = { INVALID_HASH: 'badHash', INVALID_DICE: 'badDice', INVALID_INPUT: 'badInput', INVALID_NONCE: 'badNonce', CRYPTO_UNAVAILABLE: 'unavailable' }[error.code];
    paragraph(card, error.verifyTranslationKey || coreKey ? translate(error.verifyTranslationKey || coreKey) : String(error.message || error));
    state.out.append(card);
  }

  function bindForm(kind, buttonKey, method) {
    const state = { kind, buttonKey, method, form: get(`verify-${kind}-form`), button: get(`verify-${kind}-submit`), out: get(`verify-${kind}-result`), revision: 0, epoch: 0, busy: false, result: null, error: null, available: Boolean(window.NarduVerify && typeof window.NarduVerify[method] === 'function') };
    forms.push(state);
    updateButton(state);
    state.form.addEventListener('input', () => {
      state.revision += 1;
      state.result = null;
      state.error = null;
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
        const result = await window.NarduVerify[method](argumentsFor(kind));
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
    state.out.replaceChildren();
    ['portal-hash', 'portal-die-one', 'portal-die-two', 'portal-preimage'].forEach(id => {
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
  bindForm('seed', 'checkSeed', 'verifySeed');
  bindForm('hmac', 'checkHmac', 'verifyHmacRoll');
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
