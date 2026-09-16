const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { analyzeTrainingDocuments } = require('../scripts/review-long-bot-losses');

const ROOT = path.join(__dirname, '..');
const LONG_EXPERIENCE_KEY = 'narduh-long-bot-experience-v8';
const SHORT_EXPERIENCE_KEY = 'narduh-short-bot-experience-v6';
const REVIEWER_VERSION = 'long-counterfactual-review-v1';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function loadStrongBot(initial = {}) {
  const storage = memoryStorage(initial);
  const longExperienceCalls = [];
  const shortExperienceCalls = [];
  const context = {
    window: {
      localStorage: storage,
      NarduLongBotEngine: {
        version: 'long-analytic-v35',
        setExperience(patterns, source) { longExperienceCalls.push({ patterns, source }); },
      },
      NarduShortBotEngine: {
        setExperience(patterns, source) { shortExperienceCalls.push({ patterns, source }); },
      },
    },
    console,
    Date,
    Math,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(ROOT, 'strong-bot.js'), 'utf8').replace(
    '    syncLocalExperience,\n  };',
    '    syncLocalExperience,\n    __causalTest: { validatedLongCounterfactualRecord },\n  };',
  );
  vm.runInContext(source, context, {
    filename: 'strong-bot.js',
  });
  return { context, storage, longExperienceCalls, shortExperienceCalls };
}

function causalReport(overrides = {}) {
  const selectedPositionKey = '1:dark:1|bar:0:0|off:0:0';
  const recommendedPositionKey = '2:dark:1|bar:0:0|off:0:0';
  const record = {
    evidenceVersion: REVIEWER_VERSION,
    evidenceType: 'negative-selected-penalty',
    direction: 'negative',
    decisionId: 'decision-causal-1',
    positionId: 'lb4-causal-test',
    engineVersion: 'long-analytic-v35',
    experienceFingerprint: 'lbe8-causal-test',
    stateFingerprintV2: 'lbs2-causal-test',
    selectedPositionKey,
    recommendedPositionKey,
    contextKey: 'late-entry|causal-test',
    selectedActionKey: 'entry:miss|home:shuffle',
    actionIdentity: 'late-entry|causal-test::entry:miss|home:shuffle',
    selectedScore: 100,
    recommendedScore: 140,
    scoreField: 'policyScore',
    scoreSemantics: 'long-policy-evaluator-v1',
    regret: 40,
    regretLcb: 30,
    categories: ['missed-home-entry'],
    executedPositionKey: selectedPositionKey,
    reviewComplete: true,
    candidateCoverageComplete: true,
    executionStatus: 'matched',
    candidateCount: 4,
    uniquePositionCount: 3,
    evidenceNature: 'decision-local-counterfactual-regret',
    learningEligible: true,
    outcomeUsed: false,
    ...overrides.record,
  };
  const review = {
    decisionId: record.decisionId,
    positionId: record.positionId,
    stateFingerprintV2: record.stateFingerprintV2,
    status: 'confirmed-regret',
    outcomeUsed: false,
    execution: {
      status: 'matched',
      selectedPositionKey,
      executedPositionKey: selectedPositionKey,
      selectedActionKey: record.selectedActionKey,
      executedActionKey: record.selectedActionKey,
    },
    counterfactual: {
      reviewerVersion: REVIEWER_VERSION,
      engineVersion: record.engineVersion,
      experienceFingerprint: record.experienceFingerprint,
      stateFingerprintV2: record.stateFingerprintV2,
      scoreField: record.scoreField,
      scoreSemantics: record.scoreSemantics,
      candidateCount: 4,
      uniquePositionCount: 3,
      selectedPositionKey,
      recommendedPositionKey,
      regret: record.regret,
      regretLcb: record.regretLcb,
      categories: structuredClone(record.categories),
      learningEligible: true,
      diagnosticOnly: false,
    },
    records: [structuredClone(record)],
    ...overrides.review,
  };
  return {
    schema: 'long-bot-loss-review-report-v1',
    reviewerVersion: REVIEWER_VERSION,
    outcomeUsed: false,
    reviews: [review],
    records: [record],
    ...overrides.report,
  };
}

function archivedDecisionForReport(report) {
  const record = report.records[0];
  const selected = {
    after: {
      points: { 1: { color: 'dark', count: 1 } },
      bar: { white: 0, dark: 0 },
      off: { white: 0, dark: 0 },
    },
    moves: [{ from: 3, to: 1, die: 2 }],
    experience: {
      contextKey: record.contextKey,
      actionKey: record.selectedActionKey,
    },
  };
  return {
    id: record.decisionId,
    positionId: record.positionId,
    actor: 'bot',
    source: 'engine',
    engineVersion: record.engineVersion,
    experienceFingerprint: record.experienceFingerprint,
    stateFingerprintV2: record.stateFingerprintV2,
    selected,
    experience: structuredClone(selected.experience),
    execution: {
      complete: true,
      fallback: false,
      substituted: false,
      selectedMatchesExecuted: true,
      executed: structuredClone(selected),
    },
  };
}

function longFinishedState(report, winner = 'white') {
  return {
    variant: 'long',
    winner,
    resultType: winner === 'white' ? 'koks' : 'normal',
    analysis: {
      botMemory: report ? {
        decisions: [archivedDecisionForReport(report)],
        counterfactualReview: report,
      } : {},
    },
  };
}

test('v35 quarantines local long-bot patterns even when no review is attached', () => {
  const existing = JSON.stringify([{
    creditVersion: 8,
    contextKey: 'route|existing',
    actionKey: 'route:existing',
    samples: 3,
    losses: 3,
    lossWeight: 6,
  }]);
  const { context, storage, longExperienceCalls } = loadStrongBot({
    [LONG_EXPERIENCE_KEY]: existing,
  });

  context.window.NarduStrongBot.learnFromGame(longFinishedState(null), 'dark');

  assert.equal(storage.getItem(LONG_EXPERIENCE_KEY), null);
  assert.equal(longExperienceCalls.length, 1);
  assert.deepEqual(Array.from(longExperienceCalls[0].patterns), []);
});

test('v35 local sync never applies an old outcome-only v8 pattern', () => {
  const oldPattern = {
    creditVersion: 8,
    contextKey: 'route|old-outcome',
    actionKey: 'route:old-outcome',
    samples: 12,
    losses: 12,
    lossWeight: 30,
  };
  const { context, storage, longExperienceCalls } = loadStrongBot({
    [LONG_EXPERIENCE_KEY]: JSON.stringify([oldPattern]),
  });

  context.window.NarduStrongBot.syncLocalExperience();

  assert.equal(storage.getItem(LONG_EXPERIENCE_KEY), null);
  assert.equal(longExperienceCalls.length, 1);
  assert.equal(longExperienceCalls[0].source, 'local');
  assert.equal(longExperienceCalls[0].patterns.length, 0);
});

test('v35 keeps even internally consistent client-attached evidence diagnostic-only', () => {
  const { context, storage, longExperienceCalls } = loadStrongBot();
  const state = longFinishedState(causalReport());

  context.window.NarduStrongBot.learnFromGame(state, 'dark');

  assert.equal(storage.getItem(LONG_EXPERIENCE_KEY), null);
  assert.equal(longExperienceCalls.length, 1);
  assert.deepEqual(Array.from(longExperienceCalls[0].patterns), []);
});

test('v35 removes contaminated local v8 patterns and does not replace them from a report', () => {
  const contaminated = {
    creditVersion: 8,
    contextKey: 'late-entry|causal-test',
    actionKey: 'entry:miss|home:shuffle',
    samples: 20,
    losses: 2,
    wins: 18,
    lossWeight: 3,
    severeLosses: 0,
    signalWeight: 2,
    winWeight: 30,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const unrelated = {
    creditVersion: 8,
    contextKey: 'route|unrelated',
    actionKey: 'route:unrelated',
    samples: 5,
    losses: 5,
    wins: 0,
    lossWeight: 9,
    severeLosses: 0,
    signalWeight: 8,
    winWeight: 0,
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const { context, storage } = loadStrongBot({
    [LONG_EXPERIENCE_KEY]: JSON.stringify([contaminated, unrelated]),
  });

  context.window.NarduStrongBot.learnFromGame(longFinishedState(causalReport()), 'dark');

  assert.equal(storage.getItem(LONG_EXPERIENCE_KEY), null);
});

test('v35 server loading rejects both legacy and self-asserted causal v8 patterns', async () => {
  async function loadServerPatterns(data) {
    const storage = memoryStorage();
    const applied = [];
    const context = {
      window: {
        NarduSupabase: {
          configured() { return true; },
          async client() {
            return { async rpc() { return { data, error: null }; } };
          },
        },
        NarduLongBotEngine: {
          version: 'long-analytic-v35',
          setExperience(patterns, source) { applied.push({ patterns, source }); },
        },
      },
      localStorage: storage,
      console: { warn() {} },
      Date,
      Math,
      JSON,
      Map,
      Uint8Array,
      TextEncoder,
      fetch,
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'rooms-client.js'), 'utf8'), context, {
      filename: 'rooms-client.js',
    });
    const loaded = await context.window.NarduRooms.loadLongBotExperience({
      refresh: true,
      playerName: 'causal-tester',
    });
    return { applied, loaded, storage };
  }

  const outcomePattern = {
    creditVersion: 8,
    contextKey: 'route|outcome-rpc',
    actionKey: 'route:outcome-rpc',
    samples: 20,
    losses: 20,
    lossWeight: 40,
  };
  const rejected = await loadServerPatterns([outcomePattern]);
  assert.deepEqual(Array.from(rejected.loaded), []);
  assert.equal(rejected.applied.some(item => item.patterns.length > 0), false);
  assert.equal(
    rejected.storage.getItem('narduh-long-bot-server-experience-v15'),
    null,
  );

  const causalPattern = {
    ...outcomePattern,
    evidenceVersion: REVIEWER_VERSION,
    outcomeUsed: false,
  };
  const accepted = await loadServerPatterns([causalPattern]);
  assert.equal(accepted.loaded.length, 0);
  assert.equal(accepted.applied.some(item => item.patterns.length > 0), false);
});

test('the offline reviewer report remains diagnostic and cannot feed browser policy', async () => {
  const stateSnapshotV2 = {
    schema: 'long-state-v2',
    color: 'dark',
    dice: [2, 4],
    points: {
      12: { color: 'dark', count: 2 },
      24: { color: 'white', count: 15 },
    },
    off: { white: 0, dark: 0 },
  };
  const selected = {
    after: {
      points: {
        8: { color: 'dark', count: 2 },
        24: { color: 'white', count: 15 },
      },
      off: { white: 0, dark: 0 },
    },
    moves: [{ from: 12, to: 8, die: 4 }],
    policyScore: 100,
    policyScoreUcb: 103,
    features: { outsideReduction: 0, homeEntryMoves: 0 },
    experience: {
      contextKey: 'late-entry|generated-report',
      actionKey: 'generated:selected',
    },
  };
  const recommended = {
    after: {
      points: {
        6: { color: 'dark', count: 1 },
        10: { color: 'dark', count: 1 },
        24: { color: 'white', count: 15 },
      },
      off: { white: 0, dark: 0 },
    },
    moves: [{ from: 12, to: 10, die: 2 }, { from: 10, to: 6, die: 4 }],
    policyScore: 140,
    policyScoreLcb: 135,
    features: { outsideReduction: 1, homeEntryMoves: 1 },
    experience: {
      contextKey: 'late-entry|generated-report',
      actionKey: 'generated:recommended',
    },
  };
  const decision = {
    id: 'generated-decision',
    positionId: 'lb4-generated',
    actor: 'bot',
    color: 'dark',
    source: 'engine',
    engineVersion: 'long-analytic-v35',
    experienceFingerprint: 'lbe8-generated',
    stateFingerprintV2: 'lbs2-generated',
    stateSnapshotV2,
    selected: structuredClone(selected),
    experience: structuredClone(selected.experience),
    execution: {
      complete: true,
      fallback: false,
      substituted: false,
      executed: structuredClone(selected),
      selectedMatchesExecuted: true,
    },
    counterfactualReplay: {
      reviewerVersion: REVIEWER_VERSION,
      engineVersion: 'long-analytic-v35',
      experienceFingerprint: 'lbe8-generated',
      stateFingerprintV2: 'lbs2-generated',
      stateSnapshotV2: structuredClone(stateSnapshotV2),
      scoreSemantics: 'long-policy-evaluator-v1',
      learningEvidence: {
        schema: 'long-policy-counterfactual-evidence-v1',
        trusted: true,
        conservativeBoundsComplete: true,
      },
      outcomeUsed: false,
      coverage: { complete: true, expectedCandidates: 2, evaluatedCandidates: 2 },
      candidates: [selected, recommended],
      minRegret: 5,
      minRegretLcb: 5,
    },
  };
  const report = await analyzeTrainingDocuments([{
    id: 'generated-game',
    room_code: 'GENERATED',
    winner: 'white',
    result_type: 'normal',
    bot_color: 'dark',
    decisions: [decision],
  }], { allowAttachedReplayForTests: true });
  const { context, storage } = loadStrongBot();

  context.window.NarduStrongBot.learnFromGame(longFinishedState(report), 'dark');

  assert.equal(storage.getItem(LONG_EXPERIENCE_KEY), null);
});

test('forged, incomplete, mismatched, and outcome-only long evidence fails closed', async t => {
  const forgedFlatRecord = causalReport();
  forgedFlatRecord.records[0].selectedActionKey = 'forged:selected';
  forgedFlatRecord.records[0].actionIdentity = 'late-entry|causal-test::forged:selected';
  const stringCounterfactualCandidateCount = causalReport();
  stringCounterfactualCandidateCount.reviews[0].counterfactual.candidateCount = '4';
  const stringNestedCandidateCount = causalReport();
  stringNestedCandidateCount.reviews[0].records[0].candidateCount = '4';
  const cases = [
    ['forged action identity', causalReport({ record: { actionIdentity: 'other::key' } })],
    ['flat record does not match its reviewed record', forgedFlatRecord],
    ['incomplete review', causalReport({ record: { reviewComplete: false } })],
    ['incomplete candidate coverage', causalReport({ record: { candidateCoverageComplete: false } })],
    ['diverged execution', causalReport({ record: { executionStatus: 'diverged' } })],
    ['non-positive LCB', causalReport({ record: { regretLcb: 0 } })],
    ['string regret is not trusted numeric evidence', causalReport({ record: { regret: '40' } })],
    ['null selected score is not trusted numeric evidence', causalReport({ record: { selectedScore: null } })],
    ['string candidate count is not trusted numeric evidence', causalReport({ record: { candidateCount: '4' } })],
    ['string counterfactual candidate count is not trusted numeric evidence', stringCounterfactualCandidateCount],
    ['string nested candidate count is not trusted numeric evidence', stringNestedCandidateCount],
    ['result-derived evidence', causalReport({ record: { outcomeUsed: true } })],
    ['untrusted report outcome flag', causalReport({ report: { outcomeUsed: true } })],
  ];

  for (const [label, report] of cases) {
    await t.test(label, () => {
      const { context, storage, longExperienceCalls } = loadStrongBot();
      context.window.NarduStrongBot.learnFromGame(longFinishedState(report), 'dark');
      assert.equal(storage.getItem(LONG_EXPERIENCE_KEY), null);
      assert.equal(longExperienceCalls.length, 1);
      assert.deepEqual(Array.from(longExperienceCalls[0].patterns), []);
    });
  }

  await t.test('a win without causal review creates no positive memory', () => {
    const { context, storage, longExperienceCalls } = loadStrongBot();
    context.window.NarduStrongBot.learnFromGame(longFinishedState(null, 'dark'), 'dark');
    assert.equal(storage.getItem(LONG_EXPERIENCE_KEY), null);
    assert.equal(longExperienceCalls.length, 1);
    assert.deepEqual(Array.from(longExperienceCalls[0].patterns), []);
  });

  await t.test('a report without the exact archived decision is rejected', () => {
    const report = causalReport();
    const state = longFinishedState(report, 'white');
    state.analysis.botMemory.decisions = [];
    const { context, storage, longExperienceCalls } = loadStrongBot();
    context.window.NarduStrongBot.learnFromGame(state, 'dark');
    assert.equal(storage.getItem(LONG_EXPERIENCE_KEY), null);
    assert.equal(longExperienceCalls.length, 1);
    assert.deepEqual(Array.from(longExperienceCalls[0].patterns), []);
  });
});

test('causal validator links evidence to exactly one immutable archived decision', () => {
  const report = causalReport();
  const state = longFinishedState(report, 'white');
  const memory = state.analysis.botMemory;
  const { context } = loadStrongBot();
  const validate = context.window.NarduStrongBot.__causalTest.validatedLongCounterfactualRecord;

  assert.ok(validate(memory, report, report.records[0], 'long-analytic-v35'));

  const mutations = [
    decision => { decision.id = 'other-decision'; },
    decision => { decision.positionId = 'other-position'; },
    decision => { decision.engineVersion = 'long-analytic-v34'; },
    decision => { decision.experienceFingerprint = 'other-experience'; },
    decision => { decision.stateFingerprintV2 = 'other-state'; },
    decision => { decision.selected.experience.actionKey = 'forged-action'; },
    decision => { decision.selected.after.points = { 2: { color: 'dark', count: 1 } }; },
    decision => { decision.execution.selectedMatchesExecuted = false; },
    decision => {
      decision.execution.executed.moves = [{ from: 4, to: 1, die: 3 }];
    },
    decision => {
      decision.execution.executed.experience.actionKey = 'different-executed-action';
    },
  ];
  for (const mutate of mutations) {
    const forgedMemory = structuredClone(memory);
    mutate(forgedMemory.decisions[0]);
    assert.equal(
      validate(forgedMemory, report, report.records[0], 'long-analytic-v35'),
      null,
    );
  }

  const duplicate = structuredClone(memory);
  duplicate.decisions.push(structuredClone(duplicate.decisions[0]));
  assert.equal(validate(duplicate, report, report.records[0], 'long-analytic-v35'), null);
});

test('short-bot outcome learning remains unchanged', () => {
  const { context, storage, shortExperienceCalls } = loadStrongBot();
  context.window.NarduStrongBot.learnFromGame({
    variant: 'short',
    winner: 'white',
    resultType: 'normal',
    analysis: {
      botMemory: {
        decisions: [{
          actor: 'bot',
          choiceCount: 2,
          experience: {
            contextKey: 'contact|short-loss',
            actionKey: 'short:unsafe',
            mistakeSeverity: 2,
            riskSignal: 2,
          },
        }],
      },
    },
  }, 'dark');

  const patterns = JSON.parse(storage.getItem(SHORT_EXPERIENCE_KEY));
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].creditVersion, 6);
  assert.equal(patterns[0].contextKey, 'contact|short-loss');
  assert.equal(patterns[0].actionKey, 'short:unsafe');
  assert.equal(patterns[0].losses, 1);
  assert.equal(shortExperienceCalls.length, 1);
});
