const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const EXPERIENCE_KEY = 'narduh-long-bot-experience-v6';
const LEGACY_EXPERIENCE_KEY = 'narduh-long-bot-experience-v5';
const SHORT_EXPERIENCE_KEY = 'narduh-short-bot-experience-v5';

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

test('v29 removes v5 memory and does not learn a forced winning demonstration', () => {
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

test('v29 writes new local evidence with credit generation 6', () => {
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
  assert.equal(learned[0].creditVersion, 6);
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
    creditVersion: 6,
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
  first.setExperience(updated, 'server');

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

test('short learning keeps its credit generation at 5', () => {
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
  assert.equal(learned[0].creditVersion, 5);
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
