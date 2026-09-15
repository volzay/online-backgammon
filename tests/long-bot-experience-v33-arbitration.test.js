const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

async function analysisModule() {
  return import(pathToFileURL(path.join(ROOT, 'bot-engine/long/analysis.ts')).href);
}

async function engineModule() {
  return import(pathToFileURL(path.join(ROOT, 'bot-engine/long/engine.ts')).href);
}

test('risky decisions cannot let neutral exact evidence hide a harmful behavior alias', async () => {
  const analysis = await analysisModule();
  const behaviorKey = 'entry:flat|progress:flat|home:shuffle|tower:loss|prime:loss|prime-run:3|off:no';
  const descriptor = {
    phase: 'late-entry',
    contextKey: 'late-entry|h0|o2|po1|sz0|tr3|pd2',
    actionKey: 'exact:risky-route',
    strategicActionKey: 'strategy:risky-route',
    familyActionKey: 'family:risky-route',
    behaviorActionKeys: [behaviorKey],
    legacyActionKey: 'legacy:risky-route',
    riskSignal: 3.2,
    mistakeSeverity: 2.8,
  };
  const neutralExact = {
    contextKey: descriptor.contextKey,
    actionKey: descriptor.actionKey,
    samples: 12,
    losses: 4,
    wins: 8,
    lossWeight: 4,
    severeLosses: 0,
    signalWeight: 4,
    winWeight: 8,
  };
  const exactOnly = analysis.normalizeExperiencePatterns([neutralExact]);
  const experience = analysis.normalizeExperiencePatterns([
    neutralExact,
    {
      contextKey: descriptor.contextKey,
      actionKey: behaviorKey,
      samples: 9,
      losses: 9,
      wins: 0,
      lossWeight: 21,
      severeLosses: 4,
      signalWeight: 25,
      winWeight: 0,
    },
  ]);

  assert.equal(analysis.experienceAdjustment(descriptor, exactOnly), 0);
  assert.ok(analysis.experienceAdjustment(descriptor, experience) < -5000000);
});

test('risky alias arbitration keeps exact evidence when compatible aliases agree', async () => {
  const analysis = await analysisModule();
  const descriptor = {
    phase: 'route',
    contextKey: 'route|h0|o3|po0|sz0|tr1|pd2',
    actionKey: 'exact:known-risk',
    strategicActionKey: 'strategy:known-risk',
    familyActionKey: 'family:known-risk',
    behaviorActionKeys: ['behavior:known-risk'],
    legacyActionKey: 'legacy:known-risk',
    riskSignal: 2.1,
    mistakeSeverity: 1.6,
  };
  const exactEvidence = {
    contextKey: descriptor.contextKey,
    actionKey: descriptor.actionKey,
    samples: 8,
    losses: 8,
    wins: 0,
    lossWeight: 12,
    severeLosses: 2,
    signalWeight: 14,
    winWeight: 0,
  };
  const exactAdjustment = analysis.experienceAdjustment(
    descriptor,
    analysis.normalizeExperiencePatterns([exactEvidence]),
  );
  const compatibleAliases = analysis.normalizeExperiencePatterns([
    exactEvidence,
    {
      ...exactEvidence,
      actionKey: descriptor.behaviorActionKeys[0],
      samples: 4,
      losses: 4,
      lossWeight: 5,
      severeLosses: 0,
      signalWeight: 6,
    },
  ]);

  assert.ok(exactAdjustment < 0);
  assert.equal(analysis.experienceAdjustment(descriptor, compatibleAliases), exactAdjustment);
});

test('risky alias arbitration favors a penalty over conflicting exact rewards', async () => {
  const analysis = await analysisModule();
  const behaviorKey = 'trap:loss|fence:loss|gateway:loss|block:loss|latent:loss';
  const descriptor = {
    phase: 'route',
    contextKey: 'route|h0|o3|po0|sz0|tr3|pd2',
    actionKey: 'exact:conflicted',
    familyActionKey: 'family:conflicted',
    behaviorActionKeys: [behaviorKey],
    legacyActionKey: 'legacy:conflicted',
    riskSignal: 3.8,
    mistakeSeverity: 3.8,
  };
  const exactWins = {
    contextKey: descriptor.contextKey,
    actionKey: descriptor.actionKey,
    samples: 12,
    losses: 0,
    wins: 12,
    lossWeight: 0,
    severeLosses: 0,
    signalWeight: 0,
    winWeight: 16,
  };
  const exactOnly = analysis.normalizeExperiencePatterns([exactWins]);
  const conflicted = analysis.normalizeExperiencePatterns([
    exactWins,
    {
      contextKey: descriptor.contextKey,
      actionKey: behaviorKey,
      samples: 10,
      losses: 9,
      wins: 1,
      lossWeight: 24,
      severeLosses: 4,
      signalWeight: 28,
      winWeight: 1,
    },
  ]);

  assert.ok(analysis.experienceAdjustment(descriptor, exactOnly) > 0);
  assert.ok(analysis.experienceAdjustment(descriptor, conflicted) < 0);
});

test('fresh local loss evidence overrides an older live-server copy', async () => {
  const { createLongBotEngine } = await engineModule();
  const engine = createLongBotEngine({});
  const common = {
    creditVersion: 8,
    contextKey: 'route|egxa-memory',
    actionKey: 'route:self-lock',
  };
  engine.setExperience([{
    ...common,
    samples: 3,
    wins: 3,
    updatedAt: '2026-09-14T19:00:00.000Z',
  }], 'server');
  engine.setExperience([{
    ...common,
    samples: 4,
    losses: 4,
    updatedAt: '2026-09-14T20:00:00.000Z',
  }], 'local');

  const selected = engine.experienceSnapshotPatterns();
  assert.equal(selected.length, 1);
  assert.equal(selected[0].losses, 4);
  assert.equal(selected[0].updatedAt, '2026-09-14T20:00:00.000Z');
});

test('newer live-server evidence still supersedes an older local copy', async () => {
  const { createLongBotEngine } = await engineModule();
  const engine = createLongBotEngine({});
  const common = {
    creditVersion: 8,
    contextKey: 'route|fresh-server',
    actionKey: 'route:known',
  };
  engine.setExperience([{ ...common, losses: 2, updatedAt: '2026-09-14T19:00:00.000Z' }], 'local');
  engine.setExperience([{ ...common, wins: 5, updatedAt: '2026-09-14T21:00:00.000Z' }], 'server');

  const selected = engine.experienceSnapshotPatterns();
  assert.equal(selected.length, 1);
  assert.equal(selected[0].wins, 5);
  assert.equal(selected[0].updatedAt, '2026-09-14T21:00:00.000Z');
});
