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
        Boolean(item.opening), Boolean(item.openingMove), Object.prototype.hasOwnProperty.call(item, 'roll'),
        Object.prototype.hasOwnProperty.call(item, 'sha256Input'), item.host, item.guest, item.roll, item.sha256, item.sha256Input,
      ] : null)]);
    } catch { return null; }
  }
  function clearResult(output) {
    if (!output) return;
    output.hidden = true;
    output.textContent = '';
    delete output.dataset.status;
  }
  function rollControls(item, { lang = language() } = {}) {
    try {
      const input = root.NarduVerify.portalRollFromHistory(item);
      const url = root.NarduVerify.verificationUrl(item);
      if (!url) return '';
      const preimage = input.preimage === undefined ? '' : ` data-verify-input="${escape(input.preimage)}"`;
      return `<span class="roll-verify-controls"><button type="button" data-verify-roll data-verify-hash="${input.hash}" data-verify-dice="${input.expectedDice.join(',')}"${preimage}>${lang === 'en' ? 'Check roll' : 'Проверить'}</button><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${lang === 'en' ? 'Details' : 'Подробнее'}</a></span><span class="roll-verify-status" data-roll-result role="status" aria-live="polite" hidden></span>`;
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
    if (result.status === 'verified') return lang === 'en' ? `Input, SHA-256 and dice ${dice} match. This does not prove prior commitment or RNG fairness.` : `Исходная строка, SHA-256 и кости ${dice} совпадают. Это не доказывает публикацию хеша заранее или случайность генерации.`;
    if (result.diceStatus === 'verified') return lang === 'en' ? `Dice ${dice} match the hash. The input was not saved; full SHA-256 verification is unavailable.` : `Кости ${dice} соответствуют хешу. Исходная строка не сохранена; полная проверка SHA-256 недоступна.`;
    return lang === 'en' ? `Calculated dice: ${dice}; insufficient data for full verification.` : `Рассчитанные кости: ${dice}; недостаточно данных для полной проверки.`;
  }
  function gameSummary(result, lang) {
    const c = result.counts;
    if (!c.rolls) return lang === 'en' ? 'There are no recorded rolls to verify.' : 'В истории пока нет бросков для проверки.';
    return lang === 'en'
      ? `Rolls: ${c.rolls}. Dice match: ${c.diceVerified}. Input SHA-256 matches: ${c.hashVerified}. Mismatches: ${c.mismatch}. Incomplete: ${c.incomplete}. This does not attest fairness or checker-move legality.`
      : `Бросков: ${c.rolls}. Кости совпали: ${c.diceVerified}. SHA-256 исходной строки совпал: ${c.hashVerified}. Несовпадений: ${c.mismatch}. Неполных проверок: ${c.incomplete}. Это не подтверждает случайность генерации или законность перемещений шашек.`;
  }
  async function run(button, wholeGame) {
    const parent = button.closest(wholeGame ? '[data-verifier-context]' : '.fair-hash, .history-proof');
    const output = parent?.querySelector(wholeGame ? '[data-game-result]' : '[data-roll-result]');
    if (!output) return;
    const lang = language();
    const context = wholeGame ? sources.get(parent) : null;
    output.hidden = false;
    output.dataset.status = 'incomplete';
    output.textContent = lang === 'en' ? 'Checking…' : 'Проверяем…';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const result = wholeGame ? await root.NarduVerify.verifyGameRolls(context?.game) : await root.NarduVerify.verifyPortalRoll({
        hash: button.dataset.verifyHash, expectedDice: button.dataset.verifyDice, preimage: button.dataset.verifyInput,
      });
      if (output.isConnected === false) return;
      if (wholeGame) {
        const current = sources.get(parent);
        if (!context || current?.revision !== context.revision || gameSignature(current?.game) !== context.signature) {
          clearResult(output);
          return;
        }
      }
      const resultLanguage = language();
      output.dataset.status = result.status;
      output.textContent = wholeGame ? gameSummary(result, resultLanguage) : summary(result, resultLanguage);
      if (wholeGame && result.counts.mismatch) {
        const mismatches = result.results.filter(item => item.status === 'mismatch').slice(0, 20).map(item => result.historyLength - item.historyIndex);
        output.textContent += resultLanguage === 'en' ? ` History entries: ${mismatches.join(', ')}.` : ` Записи истории: ${mismatches.join(', ')}.`;
      }
    } catch (error) {
      if (output.isConnected === false) return;
      output.dataset.status = 'incomplete';
      output.textContent = lang === 'en' ? 'Verification unavailable. Check the recorded data and browser Web Crypto support.' : `Проверка недоступна: ${error.message || 'проверьте данные и поддержку Web Crypto'}`;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
  root.NarduVerifyUI = Object.freeze({ rollControls, setGameContext });
  root.document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-verify-roll], [data-verify-game]');
    if (!button || button.disabled) return;
    event.preventDefault();
    void run(button, button.hasAttribute('data-verify-game'));
  });
})(window);
