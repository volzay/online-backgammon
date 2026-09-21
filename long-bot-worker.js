'use strict';

self.window = self;
let runtimeReady = false;
const MAX_EXPERIENCE_PATTERNS = 1024;

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Long bot planning failed.';
}

function assetUrl(name) {
  const current = new URL(self.location.href);
  const url = new URL(name, current);
  const version = current.searchParams.get('v');
  if (version) url.searchParams.set('v', version);
  return url.href;
}

function ensureRuntime() {
  if (runtimeReady) return;
  importScripts(
    assetUrl('game.js'),
    assetUrl('long-bot-engine.js'),
    assetUrl('strong-bot.js'),
  );
  if (!self.NarduGame || !self.NarduLongBotEngine?.plan || !self.NarduStrongBot?.plan) {
    throw new Error('Long bot worker runtime is incomplete.');
  }
  runtimeReady = true;
}

function assertRequest(payload) {
  if (!payload?.state || typeof payload.state !== 'object') {
    throw new Error('Long bot worker state is missing.');
  }
  if (!Array.isArray(payload?.experience?.patterns)
    || payload.experience.patterns.length > MAX_EXPERIENCE_PATTERNS) {
    throw new Error('Long bot worker experience snapshot is invalid.');
  }
  const expected = payload.expected || {};
  if (String(self.NarduLongBotEngine.version || '') !== String(expected.engineVersion || '')
    || String(self.NarduLongBotEngine.policyImplementationId || '')
      !== String(expected.policyImplementationId || '')) {
    throw new Error('Long bot worker runtime provenance mismatch.');
  }
}

function runPlan(id, payload) {
  ensureRuntime();
  assertRequest(payload);
  const engine = self.NarduLongBotEngine;
  const sessionKey = `worker:${id}`;
  engine.beginExperienceSession?.(sessionKey);
  engine.setExperience?.(payload.experience.patterns, 'worker-session');
  const snapshot = engine.freezeExperience?.(sessionKey) || engine.experienceSnapshot?.() || {};
  if (String(snapshot.fingerprint || '') !== String(payload.expected.experienceFingerprint || '')) {
    throw new Error('Long bot worker experience provenance mismatch.');
  }
  const moves = self.NarduStrongBot.plan(payload.state, { liveTurnLatencyBudget: true });
  const decision = engine.consumeLastDecision?.()
    || self.NarduStrongBot.consumeLastFallbackDecision?.()
    || null;
  return {
    moves,
    decision,
    engineVersion: String(engine.version || ''),
    policyImplementationId: String(engine.policyImplementationId || ''),
    experienceFingerprint: String(snapshot.fingerprint || ''),
  };
}

self.addEventListener('message', (event) => {
  const { id, type, payload } = event?.data || {};
  if (!Number.isInteger(id)) return;
  try {
    if (type !== 'plan') throw new Error(`Unsupported long bot worker request: ${String(type || '')}`);
    self.postMessage({ id, ok: true, result: runPlan(id, payload) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: errorMessage(error) });
  }
});
