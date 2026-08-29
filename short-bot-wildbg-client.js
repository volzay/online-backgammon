(function () {
  'use strict';

  const DEFAULT_INIT_TIMEOUT_MS = 45000;
  const DEFAULT_ANALYSIS_TIMEOUT_MS = 30000;
  const CLIENT_VERSION = (() => {
    try {
      return new URL(document.currentScript?.src || location.href).searchParams.get('v') || '';
    } catch {
      return '';
    }
  })();
  const pending = new Map();
  let worker = null;
  let requestSequence = 0;
  let preloadPromise = null;

  function errorMessage(value, fallback = 'WildBG worker failed.') {
    if (value instanceof Error && value.message) return value.message;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value.message === 'string' && value.message.trim()) return value.message.trim();
    return fallback;
  }

  function workerUrl() {
    const url = new URL('short-bot-wildbg-worker.js', document.baseURI);
    if (CLIENT_VERSION) url.searchParams.set('v', CLIENT_VERSION);
    return url;
  }

  function rejectPending(reason) {
    const error = reason instanceof Error ? reason : new Error(errorMessage(reason));
    pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(error);
    });
    pending.clear();
  }

  function resetWorker(reason = null) {
    const current = worker;
    worker = null;
    preloadPromise = null;
    if (current) current.terminate();
    if (reason) rejectPending(reason);
  }

  function ensureWorker() {
    if (worker) return worker;
    if (typeof Worker !== 'function') throw new Error('Web Workers are not supported.');

    const instance = new Worker(workerUrl(), {
      type: 'module',
      name: 'nardu-short-bot-wildbg',
    });
    instance.addEventListener('message', (event) => {
      const id = event?.data?.id;
      if (!pending.has(id)) return;
      const task = pending.get(id);
      pending.delete(id);
      clearTimeout(task.timer);
      if (event.data.ok) task.resolve(event.data.result);
      else task.reject(new Error(errorMessage(event.data.error)));
    });
    instance.addEventListener('error', (event) => {
      if (worker !== instance) return;
      resetWorker(new Error(errorMessage(event, 'WildBG worker crashed.')));
    });
    instance.addEventListener('messageerror', () => {
      if (worker !== instance) return;
      resetWorker(new Error('WildBG worker returned an unreadable response.'));
    });
    worker = instance;
    return instance;
  }

  function request(type, payload = {}, timeoutMs = DEFAULT_ANALYSIS_TIMEOUT_MS) {
    const instance = ensureWorker();
    const id = ++requestSequence;
    const waitMs = Math.max(1, Number(timeoutMs) || DEFAULT_ANALYSIS_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        resetWorker(new Error(`WildBG ${type} timed out after ${waitMs} ms.`));
      }, waitMs);
      pending.set(id, { resolve, reject, timer });
      try {
        instance.postMessage({ id, type, payload });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function preload(options = {}) {
    if (!preloadPromise) {
      preloadPromise = request(
        'preload',
        {},
        options.timeoutMs || DEFAULT_INIT_TIMEOUT_MS,
      ).catch((error) => {
        preloadPromise = null;
        throw error;
      });
    }
    return preloadPromise;
  }

  async function analyze(prepared, options = {}) {
    if (!prepared || typeof prepared !== 'object') {
      throw new Error('WildBG analysis request is missing.');
    }
    await preload({ timeoutMs: options.initTimeoutMs || DEFAULT_INIT_TIMEOUT_MS });
    return request(
      'analyze',
      prepared,
      options.timeoutMs || DEFAULT_ANALYSIS_TIMEOUT_MS,
    );
  }

  async function plan({ engine, state, isCurrent, fallback, timeoutMs } = {}) {
    const current = typeof isCurrent === 'function' ? isCurrent : () => true;
    let fallbackUsed = false;
    const useFallback = () => {
      if (fallbackUsed) return [];
      fallbackUsed = true;
      return typeof fallback === 'function' ? fallback() : [];
    };
    const stale = () => ({ stale: true, fallback: false, planned: [] });

    if (!current()) return stale();
    if (
      !engine ||
      typeof engine.prepareWildbgRequest !== 'function' ||
      typeof engine.planFromWildbgAnalysis !== 'function'
    ) {
      return { stale: false, fallback: true, planned: useFallback() };
    }

    let prepared;
    try {
      prepared = engine.prepareWildbgRequest(state);
      if (!prepared) throw new Error('The current position cannot be converted for WildBG.');
      const analysis = await analyze(prepared, { timeoutMs });
      if (!current()) return stale();
      const planned = engine.planFromWildbgAnalysis(state, analysis);
      if (!Array.isArray(planned)) throw new Error('WildBG adapter returned an invalid plan.');
      return { stale: false, fallback: false, planned };
    } catch (error) {
      if (!current()) return stale();
      console.warn('WildBG plan failed, using analytic fallback', errorMessage(error));
      return { stale: false, fallback: true, planned: useFallback() };
    }
  }

  window.NarduShortBotWildbg = Object.freeze({
    preload,
    analyze,
    plan,
    dispose() { resetWorker(new Error('WildBG client was disposed.')); },
  });
})();
