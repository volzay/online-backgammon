(() => {
  'use strict';
  const script = document.currentScript;
  if (!script?.src) return;
  const scriptUrl = new URL(script.src);
  const location = window.location;
  if (scriptUrl.origin !== location.origin
    || !scriptUrl.pathname.endsWith('/experiments/ultrabot/player-test.js')) return;

  const loopback = location.hostname === '127.0.0.1'
    && (location.protocol === 'http:' || location.protocol === 'https:');
  const preview = new URL('../../ultrabot/', scriptUrl);
  const publicPreview = (location.protocol === 'https:' || loopback)
    && (location.pathname === preview.pathname || location.pathname === `${preview.pathname}index.html`);
  const params = new URLSearchParams(location.search);
  const localRoom = loopback && location.pathname === '/room.html'
    && params.get('mode') === 'bot' && params.get('variant') === 'long'
    && params.get('difficulty') === 'ultrabot';
  if (!publicPreview && !localRoom) return;

  const id = 'ultrabot-player-test-v1';
  const workerUrl = new URL('worker.js', scriptUrl);
  const version = scriptUrl.searchParams.get('v');
  if (version) workerUrl.searchParams.set('v', version);
  const timeoutMs = 12000;

  function plan(detachedRulesState) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl, { name: id });
      let provisional = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (provisional !== null) finish(null, provisional);
        else finish(new Error('Ультработ не успел выбрать ход.'));
      }, timeoutMs);

      function finish(error, moves) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.terminate();
        if (error) reject(error);
        else resolve(moves);
      }

      worker.onmessage = ({ data }) => {
        if (data?.id !== id || data.ok !== true || !Array.isArray(data.moves)
          || data.moves.length > 4 || !data.moves.every(move => move
            && Number.isInteger(move.from) && move.from >= 1 && move.from <= 24
            && Number.isInteger(move.die) && move.die >= 1 && move.die <= 6)) {
          finish(new Error('Ультработ не смог выбрать допустимый ход.'));
          return;
        }
        if (data.stage === 'provisional') provisional = data.moves;
        else if (data.stage === 'complete') finish(null, data.moves);
        else finish(new Error('Не удалось прочитать ход Ультработа.'));
      };
      worker.onerror = () => finish(new Error('Не удалось запустить Ультработа.'));
      worker.onmessageerror = () => finish(new Error('Не удалось прочитать ход Ультработа.'));
      try {
        worker.postMessage({ id, state: detachedRulesState });
      } catch (error) {
        finish(error);
      }
    });
  }

  window.NarduUltrabotTest = Object.freeze({ id, plan });

  if (!localRoom) return;
  function addBanner() {
    const board = document.querySelector('#board');
    if (!board) return;
    const banner = document.createElement('p');
    banner.className = 'ultrabot-preview-banner';
    banner.textContent = 'Ультработ · Локальная тестовая партия без рейтинга';
    (board.closest('.board-wrap') || board).before(banner);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBanner, { once: true });
  else addBanner();
})();
