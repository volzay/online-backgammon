const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const CONTEXT = 'route|h1|o2|po0|sz1|tr0|pd0';
const ACTION = 'head:release|route:0>1|prime:steady';

async function analysisModule() {
  return import(pathToFileURL(path.join(ROOT, 'bot-engine/long/analysis.ts')).href);
}

function causalPattern(overrides = {}) {
  return {
    contextKey: CONTEXT,
    actionKey: ACTION,
    creditVersion: 9,
    evidenceSchema: 'long-server-causal-pattern-v1',
    reviewerVersion: 'long-server-causal-review-v1',
    trustDomain: 'nardu/server-long-bot-causal/v1',
    outcomeUsed: false,
    runtimeDigest: 'a'.repeat(64),
    aggregateId: 'b'.repeat(64),
    samples: 3,
    losses: 3,
    wins: 0,
    lossWeight: 4.5,
    signalWeight: 4.5,
    severeLosses: 0,
    winWeight: 0,
    ...overrides,
  };
}

function descriptor(overrides = {}) {
  return {
    contextKey: CONTEXT,
    actionKey: ACTION,
    phase: 'route',
    mistakeSeverity: 2,
    riskSignal: 2,
    ...overrides,
  };
}

test('server causal credit nine normalizes only the exact context and action', async () => {
  const { normalizeExperiencePatterns } = await analysisModule();
  const normalized = normalizeExperiencePatterns([causalPattern()]);

  assert.deepEqual([...normalized.keys()], [`${CONTEXT}::${ACTION}`]);
  assert.equal(normalized.get(`${CONTEXT}::${ACTION}`).exactOnly, true);
});

test('three causal samples produce an exact correction but never transfer to another context', async () => {
  const { normalizeExperiencePatterns, experienceAdjustment } = await analysisModule();
  const normalized = normalizeExperiencePatterns([causalPattern()]);
  assert.ok(experienceAdjustment(descriptor(), normalized) < 0);

  const enoughForLegacyTransfer = normalizeExperiencePatterns([causalPattern({
    samples: 16,
    losses: 16,
    lossWeight: 24,
    signalWeight: 24,
  })]);
  for (const other of [
    descriptor({ contextKey: CONTEXT.replace('h1', 'h9') }),
    descriptor({ contextKey: 'route|h9|o9|po1|sz9|tr9|pd9' }),
    descriptor({ contextKey: 'bearoff|h0|o0|po1|sz0|tr0|pd0', phase: 'bearoff' }),
  ]) {
    assert.equal(experienceAdjustment(other, enoughForLegacyTransfer), 0);
  }
});

test('an exact causal entry cannot match another action through a same-context alias', async () => {
  const { normalizeExperiencePatterns, experienceAdjustment } = await analysisModule();
  const normalized = normalizeExperiencePatterns([causalPattern()]);
  // Isolate the exact entry so this test detects matcher transfer independently
  // of the strategy/phase/wildcard expansion regression.
  const exactEntry = new Map([[`${CONTEXT}::${ACTION}`, normalized.get(`${CONTEXT}::${ACTION}`)]]);
  for (const aliases of [
    { strategicActionKey: ACTION, familyActionKey: 'other-family' },
    { familyActionKey: ACTION },
    { behaviorActionKeys: [ACTION] },
    { legacyActionKey: ACTION },
  ]) {
    assert.equal(
      experienceAdjustment(descriptor({ actionKey: 'another-exact-action', ...aliases }), exactEntry),
      0,
    );
  }
});

test('legacy credit keeps its context and alias transfer behavior unchanged', async () => {
  const { normalizeExperiencePatterns, experienceAdjustment } = await analysisModule();
  const normalized = normalizeExperiencePatterns([causalPattern({
    creditVersion: 8,
    samples: 16,
    losses: 16,
    lossWeight: 24,
    signalWeight: 24,
    // Scope is derived from the server-causal contract, not a caller's flag.
    exactOnly: true,
  })]);
  assert.equal(normalized.size, 4);
  assert.ok(experienceAdjustment(descriptor({ contextKey: CONTEXT.replace('h1', 'h9') }), normalized) < 0);
  assert.ok(experienceAdjustment(descriptor({
    actionKey: 'another-exact-action',
    familyActionKey: ACTION,
  }), normalized) < 0);
});
