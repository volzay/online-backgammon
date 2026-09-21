(function () {
  'use strict';

  const DEFAULT_PLAN_TIMEOUT_MS = 8000;
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

  function errorMessage(value, fallback = 'Long bot worker failed.') {
    if (value instanceof Error && value.message) return value.message;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value.message === 'string' && value.message.trim()) return value.message.trim();
    return fallback;
  }

  function workerUrl() {
    const url = new URL('long-bot-worker.js', document.baseURI);
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
    if (current) current.terminate();
    if (reason) rejectPending(reason);
  }

  function ensureWorker() {
    if (worker) return worker;
    if (typeof Worker !== 'function') throw new Error('Web Workers are not supported.');
    const instance = new Worker(workerUrl(), { name: 'nardu-long-hard-bot' });
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
      resetWorker(new Error(errorMessage(event, 'Long bot worker crashed.')));
    });
    instance.addEventListener('messageerror', () => {
      if (worker !== instance) return;
      resetWorker(new Error('Long bot worker returned an unreadable response.'));
    });
    worker = instance;
    return instance;
  }

  function request(type, payload, timeoutMs = DEFAULT_PLAN_TIMEOUT_MS) {
    const instance = ensureWorker();
    const id = ++requestSequence;
    const waitMs = Math.max(1, Number(timeoutMs) || DEFAULT_PLAN_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        resetWorker(new Error(`Long bot ${type} timed out after ${waitMs} ms.`));
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

  function normalizedMoves(value) {
    if (!Array.isArray(value)) throw new Error('Long bot worker returned an invalid plan.');
    return value.map((move) => {
      const from = Number(move?.from);
      const die = Number(move?.die);
      if (!Number.isInteger(from) || from < 1 || from > 24
        || !Number.isInteger(die) || die < 1 || die > 6) {
        throw new Error('Long bot worker returned an invalid move.');
      }
      return { from, die };
    });
  }

  function planningState(source) {
    const projected = { ...source, history: [] };
    delete projected.analysis;
    delete projected.selected;
    delete projected.hints;
    delete projected.fullHints;
    return projected;
  }

  async function plan({ engine, state, isCurrent, timeoutMs } = {}) {
    const current = typeof isCurrent === 'function' ? isCurrent : () => true;
    const stale = () => ({ stale: true, moves: [], decision: null });
    if (!current()) return stale();
    if (!engine || typeof engine.experienceReplaySnapshot !== 'function') {
      throw new Error('Long bot engine snapshot is unavailable.');
    }
    const experience = engine.experienceReplaySnapshot();
    const expected = {
      engineVersion: String(engine.version || ''),
      policyImplementationId: String(engine.policyImplementationId || ''),
      experienceFingerprint: String(experience?.fingerprint || ''),
    };
    const result = await request('plan', {
      state: planningState(state),
      expected,
      experience: {
        fingerprint: expected.experienceFingerprint,
        patterns: Array.isArray(experience?.patterns) ? experience.patterns : [],
      },
    }, timeoutMs);
    if (!current()) return stale();
    if (String(result?.engineVersion || '') !== expected.engineVersion
      || String(result?.policyImplementationId || '') !== expected.policyImplementationId
      || String(result?.experienceFingerprint || '') !== expected.experienceFingerprint) {
      throw new Error('Long bot worker provenance mismatch.');
    }
    return {
      stale: false,
      moves: normalizedMoves(result.moves),
      decision: result.decision && typeof result.decision === 'object' ? result.decision : null,
    };
  }

  window.NarduLongBotWorker = Object.freeze({
    plan,
    cancel() { resetWorker(new Error('Long bot task was cancelled.')); },
    dispose() { resetWorker(new Error('Long bot worker was disposed.')); },
  });
})();
