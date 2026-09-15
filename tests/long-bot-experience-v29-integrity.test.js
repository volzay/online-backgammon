const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const EXPERIENCE_KEY = 'narduh-long-bot-experience-v8';
const LEGACY_EXPERIENCE_KEY = 'narduh-long-bot-experience-v7';
const SHORT_EXPERIENCE_KEY = 'narduh-short-bot-experience-v6';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function loadStrongBot(storage = memoryStorage()) {
  const experienceCalls = [];
  const context = {
    window: { localStorage: storage },
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), context, {
    filename: 'game.js',
  });
  context.NarduGame = context.window.NarduGame;
  context.window.NarduLongBotEngine = {
    version: 'long-analytic-v29',
    productionOptions: { strategyProfile: 'v29' },
    describeSequence() {
      return {
        features: { outsideReduction: 1, primeScoreGain: 0 },
        experience: {
          contextKey: 'head-development|h4|o4|po0|sz4|tr0|pd2',
          actionKey: 'forced-opening',
          mistakeSeverity: 0,
          riskSignal: 0,
        },
      };
    },
    experienceSize() { return 0; },
    setExperience(patterns, source) { experienceCalls.push({ patterns, source }); },
  };
  context.NarduLongBotEngine = context.window.NarduLongBotEngine;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'strong-bot.js'), 'utf8'), context, {
    filename: 'strong-bot.js',
  });
  return { context, storage, experienceCalls };
}

function completeV29Memory(decisions, overrides = {}) {
  const botDecisions = decisions.filter(decision => decision?.actor !== 'opponent');
  const recovered = botDecisions.filter(decision => decision?.source === 'history-recovery').length;
  return {
    engineVersion: 'long-analytic-v29',
    decisions,
    coverage: {
      expectedBotDecisions: botDecisions.length,
      recordedBotDecisions: botDecisions.length - recovered,
      recoveredBotDecisions: recovered,
      complete: true,
    },
    ...overrides,
  };
}

function liveV29Decision(overrides = {}) {
  return {
    actor: 'bot',
    source: 'engine',
    engineVersion: 'long-analytic-v29',
    choiceCount: 2,
    experienceFrozen: true,
    experienceFingerprint: 'lbe6-test0001',
    experience: {
      contextKey: 'route|v29-loss',
      actionKey: 'route:unsafe',
      mistakeSeverity: 2,
      riskSignal: 2,
    },
    ...overrides,
  };
}

function forcedOpeningHistory(game, color = 'white') {
  const state = game.initialState('long');
  state.turn = color;
  state.phase = 'move';
  state.dice = [6, 1];
  state.rolled = [6, 1];
  state.turnMoves = [];
  state.headPlayedThisTurn = { white: false, dark: false };
  const raw = game.bestMoveSequences(state, color).filter(sequence => sequence.length);
  assert.equal(raw.length, 2, 'the fixture must expose both dice-order aliases');
  const sequence = raw[0];
  return {
    sequence,
    history: [
      ...sequence.slice().reverse().map(move => ({
        color,
        from: move.from,
        die: move.die,
      })),
      { color, roll: '6:1' },
    ],
  };
}

test('v29 counts unique resulting positions for recovered and opponent decisions', () => {
  const { context } = loadStrongBot();
  const game = context.window.NarduGame;
  const { sequence, history } = forcedOpeningHistory(game);
  const finalState = {
    ...game.initialState('long'),
    winner: 'white',
    resultType: 'normal',
    phase: 'over',
    history,
  };

  const captured = context.window.NarduStrongBot.captureOpponentDecisions(finalState, 'dark');
  const recovered = context.window.NarduStrongBot.recoverBotDecisions(finalState, 'white');

  assert.equal(captured.length, 1);
  assert.equal(captured[0].captureVersion, 2);
  assert.equal(captured[0].engineVersion, 'long-analytic-v29');
  assert.equal(captured[0].choiceCount, 1);
  assert.equal(captured[0].selected.moves.length, sequence.length);
  assert.equal(recovered.decisions.length, 1);
  assert.equal(recovered.decisions[0].captureVersion, 2);
  assert.equal(recovered.decisions[0].choiceCount, 1);
});

test('v29 fixtures discard the previous local generation and do not learn a forced win', () => {
  const storage = memoryStorage({
    [LEGACY_EXPERIENCE_KEY]: JSON.stringify([{
      creditVersion: 5,
      contextKey: 'head-development|legacy',
      actionKey: 'forced-opening',
      samples: 50,
      wins: 50,
      winWeight: 100,
    }]),
  });
  const { context } = loadStrongBot(storage);
  const game = context.window.NarduGame;
  const { history } = forcedOpeningHistory(game);

  context.window.NarduStrongBot.learnFromGame({
    ...game.initialState('long'),
    winner: 'white',
    resultType: 'normal',
    phase: 'over',
    history,
    analysis: { botMemory: { decisions: [] } },
  }, 'dark');

  assert.equal(storage.values.has(LEGACY_EXPERIENCE_KEY), false);
  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);
});

test('the current learning bridge writes local evidence with credit generation 8', () => {
  const { context, storage } = loadStrongBot();
  const decision = liveV29Decision();
  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'mars',
    analysis: {
      botMemory: completeV29Memory([decision]),
    },
  }, 'dark');

  const learned = JSON.parse(storage.values.get(EXPERIENCE_KEY));
  assert.equal(learned.length, 1);
  assert.equal(learned[0].creditVersion, 8);
});

test('v29 does not import a completed game from the previous engine generation', () => {
  const { context, storage } = loadStrongBot();
  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'mars',
    analysis: {
      botMemory: {
        engineVersion: 'long-analytic-v28',
        decisions: [{
          actor: 'bot',
          choiceCount: 2,
          experience: {
            contextKey: 'route|old-generation',
            actionKey: 'route:unsafe',
            mistakeSeverity: 6,
            riskSignal: 6,
          },
        }],
      },
    },
  }, 'dark');

  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);
});

test('v29 rejects a decision without an explicit engine generation', () => {
  const { context, storage } = loadStrongBot();
  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'koks',
    analysis: {
      botMemory: {
        engineVersion: 'long-analytic-v29',
        decisions: [{
          actor: 'bot',
          choiceCount: 3,
          experience: {
            contextKey: 'route|missing-generation',
            actionKey: 'route:unsafe',
            mistakeSeverity: 6,
            riskSignal: 6,
          },
        }],
      },
    },
  }, 'dark');

  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);
});

test('v29 loads existing local experience before the first frozen decision', () => {
  const pattern = {
    creditVersion: 8,
    contextKey: 'route|fresh-page',
    actionKey: 'route:known',
    samples: 4,
    wins: 4,
    winWeight: 4,
  };
  const { context, experienceCalls } = loadStrongBot(memoryStorage({
    [EXPERIENCE_KEY]: JSON.stringify([pattern]),
  }));

  context.window.NarduStrongBot.syncLocalExperience();

  assert.equal(experienceCalls.length, 1);
  assert.equal(experienceCalls[0].source, 'local');
  assert.deepEqual(JSON.parse(JSON.stringify(experienceCalls[0].patterns)), [pattern]);
});

test('v34 rejects a mixed local credit generation before engine sync', () => {
  const storage = memoryStorage({
    [EXPERIENCE_KEY]: JSON.stringify([
      {
        creditVersion: 8,
        contextKey: 'route|current',
        actionKey: 'route:current',
      },
      {
        creditVersion: 7,
        contextKey: 'route|stale',
        actionKey: 'route:stale',
      },
    ]),
  });
  const { context, experienceCalls } = loadStrongBot(storage);

  context.window.NarduStrongBot.syncLocalExperience();

  assert.equal(storage.getItem(EXPERIENCE_KEY), null);
  assert.equal(experienceCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(experienceCalls[0].patterns)), []);
});

test('v29 uses one most-specific evidence alias for a decision', async () => {
  const analysis = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/analysis.ts'),
  ).href);
  const descriptor = {
    phase: 'route',
    contextKey: 'route|h0|o3|po0|sz0|tr0|pd2',
    actionKey: 'exact:unsafe',
    strategicActionKey: 'strategy:unsafe',
    familyActionKey: 'family:unsafe',
    behaviorActionKeys: ['behavior:route', 'behavior:safety'],
    legacyActionKey: 'legacy:unsafe',
    riskSignal: 1.5,
    mistakeSeverity: 1.5,
  };
  const evidence = actionKey => ({
    contextKey: descriptor.contextKey,
    actionKey,
    samples: 4,
    losses: 4,
    wins: 0,
    lossWeight: 5,
    severeLosses: 0,
    signalWeight: 6,
    winWeight: 0,
  });
  const exactOnly = analysis.normalizeExperiencePatterns([evidence(descriptor.actionKey)]);
  const allAliases = analysis.normalizeExperiencePatterns([
    evidence(descriptor.actionKey),
    evidence(descriptor.strategicActionKey),
    evidence(descriptor.familyActionKey),
    ...descriptor.behaviorActionKeys.map(evidence),
    evidence(descriptor.legacyActionKey),
  ]);

  const expected = analysis.experienceAdjustment(descriptor, exactOnly);
  assert.ok(expected < 0);
  assert.equal(analysis.experienceAdjustment(descriptor, allAliases), expected);
});

test('v29 treats local evidence as a subset of the stronger server aggregate', async () => {
  const analysis = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/analysis.ts'),
  ).href);
  const descriptor = {
    phase: 'route',
    contextKey: 'route|h0|o3|po0|sz0|tr0|pd2',
    actionKey: 'exact:duplicate',
    familyActionKey: 'family:duplicate',
    behaviorActionKeys: [],
    legacyActionKey: 'legacy:duplicate',
    riskSignal: 1.5,
    mistakeSeverity: 1.5,
  };
  const localPattern = {
    contextKey: descriptor.contextKey,
    actionKey: descriptor.actionKey,
    samples: 3,
    losses: 3,
    wins: 0,
    lossWeight: 3.5,
    severeLosses: 0,
    signalWeight: 4.5,
    winWeight: 0,
  };
  const serverPattern = {
    ...localPattern,
    samples: 5,
    losses: 5,
    lossWeight: 6,
    signalWeight: 7.5,
  };
  const serverOnly = analysis.experienceAdjustment(
    descriptor,
    analysis.normalizeExperiencePatterns([serverPattern]),
  );
  const localThenServer = analysis.experienceAdjustment(
    descriptor,
    analysis.normalizeExperiencePatterns([localPattern, serverPattern]),
  );
  const serverThenLocal = analysis.experienceAdjustment(
    descriptor,
    analysis.normalizeExperiencePatterns([serverPattern, localPattern]),
  );

  assert.ok(serverOnly < 0);
  assert.ok(Math.abs(serverOnly) < 140000000);
  assert.equal(localThenServer, serverOnly);
  assert.equal(serverThenLocal, serverOnly);
});

test('v29 keeps server aggregate authoritative while retaining local-only keys', async () => {
  const browser = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/browser.ts'),
  ).href);
  const { context } = loadStrongBot();
  const engine = browser.createBrowserLongBotEngine(context.window.NarduGame);
  const reversed = browser.createBrowserLongBotEngine(context.window.NarduGame);
  const cached = browser.createBrowserLongBotEngine(context.window.NarduGame);
  const sharedKey = {
    contextKey: 'route|h0|o3|po0|sz0|tr0|pd2',
    actionKey: 'exact:shared',
  };
  const localPatterns = [{
    ...sharedKey,
    samples: 3,
    wins: 3,
    winWeight: 4,
  }, {
    contextKey: 'route|local-only',
    actionKey: 'exact:local-only',
    samples: 1,
    wins: 1,
    winWeight: 1,
  }];
  const serverPatterns = [{
    ...sharedKey,
    samples: 20,
    losses: 20,
    lossWeight: 30,
    severeLosses: 6,
    signalWeight: 35,
  }];
  engine.setExperience(localPatterns, 'local');
  engine.setExperience(serverPatterns, 'server');
  reversed.setExperience(serverPatterns, 'server');
  reversed.setExperience(localPatterns, 'local');
  cached.setExperience(localPatterns, 'local');
  cached.setExperience(serverPatterns, 'server-cache');

  const entries = engine.experienceSnapshotEntries();
  assert.deepEqual(
    entries.find(([key]) => key === `${sharedKey.contextKey}::${sharedKey.actionKey}`),
    [`${sharedKey.contextKey}::${sharedKey.actionKey}`, 20, 20, 0, 30, 6, 35, 0],
  );
  assert.ok(entries.some(([key]) => key === 'route|local-only::exact:local-only'));
  assert.deepEqual(reversed.experienceSnapshotEntries(), entries);
  assert.deepEqual(cached.experienceSnapshotEntries(), entries);
});

test('v34 uses a newer local lesson before a stale server cache can hide it', async () => {
  const browser = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/browser.ts'),
  ).href);
  const { context } = loadStrongBot();
  const engine = browser.createBrowserLongBotEngine(context.window.NarduGame);
  const sharedKey = {
    contextKey: 'route|fresh-local-lesson',
    actionKey: 'route:preserve-anchor',
  };
  engine.setExperience([{
    ...sharedKey,
    creditVersion: 8,
    samples: 20,
    wins: 20,
    winWeight: 30,
    updatedAt: '2026-09-13T10:00:00.000Z',
  }], 'server-cache');
  engine.setExperience([{
    ...sharedKey,
    creditVersion: 8,
    samples: 3,
    losses: 3,
    lossWeight: 8,
    severeLosses: 2,
    signalWeight: 12,
    updatedAt: '2026-09-13T10:05:00.000Z',
  }], 'local');

  assert.deepEqual(
    engine.experienceSnapshotEntries().find(([key]) => (
      key === `${sharedKey.contextKey}::${sharedKey.actionKey}`
    )),
    [`${sharedKey.contextKey}::${sharedKey.actionKey}`, 3, 3, 0, 8, 2, 12, 0],
  );

  engine.setExperience([{
    ...sharedKey,
    creditVersion: 8,
    samples: 24,
    wins: 20,
    losses: 4,
    lossWeight: 9,
    winWeight: 30,
    updatedAt: '2026-09-13T10:06:00.000Z',
  }], 'server');
  assert.equal(
    engine.experienceSnapshotEntries().find(([key]) => (
      key === `${sharedKey.contextKey}::${sharedKey.actionKey}`
    ))[1],
    24,
  );
});

test('v29 fingerprint follows effective evidence, not its transport source', async () => {
  const browser = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/browser.ts'),
  ).href);
  const { context } = loadStrongBot();
  const pattern = {
    contextKey: 'route|reload',
    actionKey: 'route:stable',
    samples: 4,
    losses: 2,
    wins: 2,
    lossWeight: 3,
    signalWeight: 5,
    winWeight: 2,
  };
  const fromServer = browser.createBrowserLongBotEngine(context.window.NarduGame);
  const fromCache = browser.createBrowserLongBotEngine(context.window.NarduGame);
  const changed = browser.createBrowserLongBotEngine(context.window.NarduGame);
  fromServer.setExperience([pattern], 'server');
  fromCache.setExperience([pattern], 'server-cache');
  changed.setExperience([{ ...pattern, losses: 3 }], 'server');

  assert.equal(
    fromServer.experienceSnapshot().fingerprint,
    fromCache.experienceSnapshot().fingerprint,
  );
  assert.notEqual(
    fromServer.experienceSnapshot().fingerprint,
    changed.experienceSnapshot().fingerprint,
  );
});

test('v29 restores the frozen evidence snapshot when an active game reloads', async () => {
  const browser = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/browser.ts'),
  ).href);
  const { context } = loadStrongBot();
  const storage = memoryStorage();
  storage.setItem('narduh-long-bot-frozen-experience-v32:stale', JSON.stringify({
    engineVersion: 'long-analytic-v32',
    patterns: [],
  }));
  const first = browser.createBrowserLongBotEngine(context.window.NarduGame, {
    experienceStorage: storage,
  });
  const initial = [{
    contextKey: 'route|reload-game',
    actionKey: 'route:stable',
    samples: 4,
    losses: 4,
    lossWeight: 5,
  }];
  const updated = [
    { ...initial[0], samples: 5, losses: 5, lossWeight: 7 },
    {
      contextKey: 'route|new-server-key',
      actionKey: 'route:new-server-key',
      samples: 4,
      wins: 4,
      winWeight: 4,
    },
  ];
  first.beginExperienceSession('GUKS-UURG:1000');
  first.setExperience(initial, 'server-cache');
  const originalFingerprint = first.freezeExperience().fingerprint;
  assert.equal(storage.getItem('narduh-long-bot-frozen-experience-v32:stale'), null);
  first.setExperience(updated, 'server');
  assert.deepEqual(first.experienceSnapshot().pendingSources, ['server']);
  assert.equal(first.experienceSnapshot().pendingPatternCount, updated.length);

  const reloaded = browser.createBrowserLongBotEngine(context.window.NarduGame, {
    experienceStorage: storage,
  });
  reloaded.beginExperienceSession('GUKS-UURG:1000');
  reloaded.setExperience(updated, 'server');
  assert.equal(reloaded.freezeExperience().fingerprint, originalFingerprint);
  assert.equal(
    reloaded.experienceSnapshotEntries().some(([key]) => key.includes('new-server-key')),
    false,
  );

  first.beginExperienceSession('GUKS-UURG:2000');
  assert.notEqual(first.freezeExperience().fingerprint, originalFingerprint);
});

test('v34 isolates v33 frozen evidence and duplicate begin keeps the session immutable', async () => {
  const browser = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/browser.ts'),
  ).href);
  const { context } = loadStrongBot();
  const storage = memoryStorage();
  const sessionKey = 'EGXA-Z2PG:1000';
  const stalePattern = {
    contextKey: 'route|v33-stale',
    actionKey: 'prime-timing:loss|self-crunch:loss|prime-run:6',
    samples: 9,
    losses: 9,
    lossWeight: 18,
  };
  storage.setItem(`narduh-long-bot-frozen-experience-v33:${sessionKey}`, JSON.stringify({
    engineVersion: 'long-analytic-v33',
    patterns: [stalePattern],
  }));

  const engine = browser.createBrowserLongBotEngine(context.window.NarduGame, {
    experienceStorage: storage,
  });
  const initial = [{
    contextKey: 'route|v34-current',
    actionKey: 'prime-timing:gain|self-crunch:gain|prime-run:5',
    samples: 4,
    wins: 4,
    winWeight: 4,
  }];
  const pending = [{
    contextKey: 'route|arrived-mid-game',
    actionKey: 'prime-timing:flat|self-crunch:flat|prime-run:4',
    samples: 4,
    losses: 4,
    lossWeight: 6,
  }];

  engine.setExperience(initial, 'server-cache');
  const begun = engine.beginExperienceSession(sessionKey);
  assert.equal(begun.frozen, false);
  assert.equal(
    engine.experienceSnapshotEntries().some(([key]) => key.includes('v33-stale')),
    false,
  );

  const frozen = engine.freezeExperience();
  const frozenSize = engine.experienceSize();
  const storedV34 = JSON.parse(storage.getItem(
    `narduh-long-bot-frozen-experience-v34:${sessionKey}`,
  ));
  assert.equal(storedV34.engineVersion, 'long-analytic-v34');
  assert.equal(storage.getItem(`narduh-long-bot-frozen-experience-v33:${sessionKey}`), null);

  engine.setExperience(pending, 'server');
  const beforeDuplicateBegin = engine.experienceSnapshot();
  assert.deepEqual(beforeDuplicateBegin.pendingSources, ['server']);
  const duplicate = engine.beginExperienceSession(sessionKey);

  assert.equal(duplicate.fingerprint, frozen.fingerprint);
  assert.equal(duplicate.size, frozenSize);
  assert.deepEqual(duplicate.pendingSources, ['server']);
  assert.equal(duplicate.pendingPatternCount, pending.length);
  assert.deepEqual(engine.experienceSnapshot(), beforeDuplicateBegin);
});

test('v29 local learning rejects unfrozen or mixed experience snapshots', () => {
  const { context, storage } = loadStrongBot();
  const learnMemory = botMemory => context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'mars',
    analysis: { botMemory },
  }, 'dark');
  const learn = decisions => learnMemory(completeV29Memory(decisions));

  learn([liveV29Decision({ experienceFrozen: false })]);
  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);

  learn([
    liveV29Decision({ experienceFingerprint: 'lbe6-first' }),
    liveV29Decision({ experienceFingerprint: 'lbe6-second' }),
  ]);
  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);

  [0, null, '2'].forEach(choiceCount => {
    learn([liveV29Decision({ choiceCount })]);
  });
  learn([liveV29Decision({ actor: 'unknown' })]);
  learnMemory(completeV29Memory([liveV29Decision()], {
    coverage: {
      expectedBotDecisions: '1',
      recordedBotDecisions: 1,
      recoveredBotDecisions: 0,
      complete: true,
    },
  }));
  learn([
    liveV29Decision(),
    {
      actor: 'opponent',
      captureVersion: '2',
      engineVersion: 'long-analytic-v29',
      choiceCount: 2,
    },
  ]);
  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);
});

test('short learning writes the v6 policy credit generation', () => {
  const { context, storage } = loadStrongBot();
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
            contextKey: 'race|short-loss',
            actionKey: 'short:unsafe',
            mistakeSeverity: 2,
            riskSignal: 2,
          },
        }],
      },
    },
  }, 'dark');

  const learned = JSON.parse(storage.values.get(SHORT_EXPERIENCE_KEY));
  assert.equal(learned.length, 1);
  assert.equal(learned[0].creditVersion, 6);
});

test('short v6 migrates compatible local v5 experience before its first move', () => {
  const previousKey = 'narduh-short-bot-experience-v5';
  const storage = memoryStorage({
    [previousKey]: JSON.stringify([{
      creditVersion: 5,
      contextKey: 'contact|saved-v5',
      actionKey: 'risk:low',
      samples: 4,
      wins: 3,
      winWeight: 3,
    }]),
  });
  const { context } = loadStrongBot(storage);
  const applied = [];
  context.window.NarduShortBotEngine = {
    setExperience(patterns, source) { applied.push({ patterns, source }); },
    plan() { return [{ from: 1, die: 1 }]; },
  };

  context.window.NarduStrongBot.plan({ variant: 'short' });

  assert.equal(storage.getItem(previousKey), null);
  const migrated = JSON.parse(storage.getItem(SHORT_EXPERIENCE_KEY));
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].creditVersion, 6);
  assert.equal(migrated[0].contextKey, 'contact|saved-v5');
  assert.equal(applied.at(-1).source, 'local');
  assert.equal(applied.at(-1).patterns[0].creditVersion, 6);
});

test('short v6 keeps v5 experience available when migration storage is full', () => {
  const previousKey = 'narduh-short-bot-experience-v5';
  const storage = memoryStorage({
    [previousKey]: JSON.stringify([{
      creditVersion: 5,
      contextKey: 'contact|quota-v5',
      actionKey: 'risk:low',
      samples: 2,
    }]),
  });
  const originalSetItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === SHORT_EXPERIENCE_KEY) throw new Error('quota');
    originalSetItem.call(storage, key, value);
  };
  const { context } = loadStrongBot(storage);
  const applied = [];
  context.window.NarduShortBotEngine = {
    setExperience(patterns, source) { applied.push({ patterns, source }); },
    plan() { return [{ from: 1, die: 1 }]; },
  };

  context.window.NarduStrongBot.plan({ variant: 'short' });

  assert.notEqual(storage.getItem(previousKey), null);
  assert.equal(storage.getItem(SHORT_EXPERIENCE_KEY), null);
  assert.equal(applied.at(-1).patterns[0].creditVersion, 6);
  assert.equal(applied.at(-1).patterns[0].contextKey, 'contact|quota-v5');
});

test('v29 prefers an exact context alias over a global exact-action alias', async () => {
  const analysis = await import(pathToFileURL(
    path.join(ROOT, 'bot-engine/long/analysis.ts'),
  ).href);
  const descriptor = {
    phase: 'route',
    contextKey: 'route|h0|o3|po0|sz0|tr0|pd2',
    actionKey: 'exact:shared',
    strategicActionKey: 'strategy:contextual',
    familyActionKey: 'family:contextual',
    behaviorActionKeys: [],
    legacyActionKey: 'legacy:contextual',
    riskSignal: 0,
    mistakeSeverity: 0,
  };
  const patterns = analysis.normalizeExperiencePatterns([
    {
      contextKey: 'route|h4|o4|po0|sz4|tr0|pd1',
      actionKey: descriptor.actionKey,
      samples: 24,
      losses: 24,
      lossWeight: 40,
      severeLosses: 8,
      signalWeight: 45,
    },
    {
      contextKey: descriptor.contextKey,
      actionKey: descriptor.strategicActionKey,
      samples: 24,
      wins: 24,
      winWeight: 30,
    },
  ]);

  assert.ok(analysis.experienceAdjustment(descriptor, patterns) > 0);
});

test('v29 SQL accepts only one frozen live experience snapshot per game', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/long-bot-strategy-v29.sql'),
    'utf8',
  );
  assert.match(migration, /decision->'experienceFrozen'[\s\S]*?'true'::jsonb/);
  assert.match(migration, /decision->>'experienceFingerprint'[\s\S]*?<> ''/);
  assert.match(migration, /count\(distinct decision->>'experienceFingerprint'\)[\s\S]*?<= 1/);
  assert.match(migration, /'updatedAt', updated_at/);
});
