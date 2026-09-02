const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const EXPERIENCE_KEY = 'narduh-long-bot-experience-v5';

async function analysisModule() {
  return import(pathToFileURL(path.join(ROOT, 'bot-engine/long/analysis.ts')).href);
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function loadStrongBot(storage = memoryStorage()) {
  const applied = [];
  const context = {
    window: {
      localStorage: storage,
      NarduLongBotEngine: {
        setExperience(patterns, source) { applied.push({ patterns, source }); },
      },
    },
    console,
    Date,
    Math,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'strong-bot.js'), 'utf8'), context, {
    filename: 'strong-bot.js',
  });
  return { context, storage, applied };
}

test('v25 treats loss frequency separately from loss severity', async () => {
  const { normalizeExperiencePatterns, experienceAdjustment } = await analysisModule();
  const descriptor = {
    phase: 'late-entry',
    contextKey: 'late-entry|h0|o2|po0|sz0|tr0|pd2',
    actionKey: 'exact:mostly-winning',
    familyActionKey: 'family:mostly-winning',
    legacyActionKey: 'legacy:mostly-winning',
    behaviorActionKeys: [],
    riskSignal: 2.5,
    mistakeSeverity: 2.5,
  };
  const experience = normalizeExperiencePatterns([{
    contextKey: descriptor.contextKey,
    actionKey: descriptor.actionKey,
    samples: 37,
    losses: 10,
    wins: 26,
    lossWeight: 21.45,
    severeLosses: 3,
    signalWeight: 30,
    winWeight: 29,
  }]);

  assert.equal(experienceAdjustment(descriptor, experience), 0);
});

test('v25 requires repeated outcomes even when one server loss has a large weight', async () => {
  const { normalizeExperiencePatterns, experienceAdjustment } = await analysisModule();
  const descriptor = {
    phase: 'late-entry',
    contextKey: 'late-entry|h0|o2|po0|sz0|tr0|pd2',
    actionKey: 'exact:weighted-loss',
    familyActionKey: 'family:weighted-loss',
    legacyActionKey: 'legacy:weighted-loss',
    behaviorActionKeys: [],
    riskSignal: 3,
    mistakeSeverity: 3,
  };
  const single = normalizeExperiencePatterns([{
    contextKey: descriptor.contextKey,
    actionKey: descriptor.actionKey,
    samples: 1,
    losses: 1,
    wins: 0,
    lossWeight: 30,
    severeLosses: 1,
    signalWeight: 3,
    winWeight: 0,
  }]);
  const repeated = normalizeExperiencePatterns([{
    contextKey: descriptor.contextKey,
    actionKey: descriptor.actionKey,
    samples: 3,
    losses: 3,
    wins: 0,
    lossWeight: 30,
    severeLosses: 1,
    signalWeight: 9,
    winWeight: 0,
  }]);

  assert.equal(experienceAdjustment(descriptor, single), 0);
  assert.ok(experienceAdjustment(descriptor, repeated) < 0);
});

test('v25 compact behavior keys transfer a harmful home-shuffle lesson', async () => {
  const { normalizeExperiencePatterns, experienceAdjustment } = await analysisModule();
  const behaviorKey = 'entry:gain|progress:gain|home:shuffle|tower:flat|off:no';
  const descriptor = {
    phase: 'late-entry',
    contextKey: 'late-entry|h0|o2|po0|sz0|tr0|pd2',
    actionKey: 'new-exact-route',
    strategicActionKey: 'new-strategy',
    familyActionKey: 'new-family',
    legacyActionKey: 'new-legacy',
    behaviorActionKeys: [behaviorKey],
    riskSignal: 2.6,
    mistakeSeverity: 2.6,
  };
  const experience = normalizeExperiencePatterns([{
    contextKey: descriptor.contextKey,
    actionKey: behaviorKey,
    samples: 6,
    losses: 6,
    wins: 0,
    lossWeight: 16,
    severeLosses: 3,
    signalWeight: 18,
    winWeight: 0,
  }]);

  assert.ok(experienceAdjustment(descriptor, experience) < -5000000);
});

test('v25 marks a home shuffle as harmful while any checker still remains outside', async () => {
  const { experienceDescriptor } = await analysisModule();
  const state = {
    variant: 'long',
    points: {
      18: { color: 'dark', count: 13 },
      19: { color: 'dark', count: 2 },
      24: { color: 'white', count: 15 },
    },
    off: { white: 0, dark: 0 },
  };
  const descriptor = experienceDescriptor(state, 'dark', {
    outsideReduction: 1,
    outsidePipGain: 5,
    homeShuffleMoves: 1,
    avoidableHomeShuffleMoves: 1,
    routeTowerDelta: 0,
    bearOffMoves: 0,
    trapDelta: 0,
    fenceClosureDelta: 0,
    escapeGatewayDelta: 0,
    opponentMoveBlockGain: 0,
  });

  assert.equal(descriptor.phase, 'late-entry');
  assert.ok(descriptor.mistakeSeverity >= 0.8);
  assert.ok(descriptor.riskSignal >= 1.3);
  assert.ok(descriptor.behaviorActionKeys.includes(
    'entry:gain|progress:gain|home:shuffle|tower:flat|prime:flat|prime-run:0|off:no',
  ));
});

test('v25 does not blame forced or unannotated home shuffles', async () => {
  const { experienceDescriptor } = await analysisModule();
  const state = {
    variant: 'long',
    points: {
      18: { color: 'dark', count: 13 },
      19: { color: 'dark', count: 2 },
      24: { color: 'white', count: 15 },
    },
    off: { white: 0, dark: 0 },
  };
  const common = {
    outsideReduction: 1,
    outsidePipGain: 5,
    homeShuffleMoves: 1,
    routeTowerDelta: 0,
    bearOffMoves: 0,
    trapDelta: 0,
    fenceClosureDelta: 0,
    escapeGatewayDelta: 0,
    opponentMoveBlockGain: 0,
  };
  const forced = experienceDescriptor(state, 'dark', {
    ...common,
    avoidableHomeShuffleMoves: 0,
  });
  const unknown = experienceDescriptor(state, 'dark', common);

  assert.equal(forced.mistakeSeverity, 0);
  assert.equal(forced.riskSignal, 0);
  assert.match(forced.familyActionKey, /home:forced/);
  assert.equal(unknown.mistakeSeverity, 0);
  assert.equal(unknown.riskSignal, 0);
  assert.match(unknown.familyActionKey, /home:unknown/);
});

test('v25 learns a worsening latent fence before the visible fence closes', async () => {
  const { experienceDescriptor } = await analysisModule();
  const state = {
    variant: 'long',
    points: {
      18: { color: 'dark', count: 13 },
      19: { color: 'dark', count: 2 },
      24: { color: 'white', count: 15 },
    },
    off: { white: 0, dark: 0 },
  };
  const descriptor = experienceDescriptor(state, 'dark', {
    outsideReduction: 0,
    outsidePipGain: 0,
    homeShuffleMoves: 0,
    routeTowerDelta: 0,
    bearOffMoves: 0,
    trapDelta: 0,
    fenceClosureDelta: 0,
    escapeGatewayDelta: 0,
    opponentMoveBlockGain: 0,
    latentFenceExposureDelta: -2.5,
  });

  assert.ok(descriptor.mistakeSeverity >= 2.5);
  assert.ok(descriptor.riskSignal >= 2.5);
  assert.ok(descriptor.behaviorActionKeys.includes(
    'trap:flat|fence:flat|gateway:flat|block:flat|latent:loss',
  ));
});

test('v25 local learning persists exact, strategic, family, behavior and legacy evidence', () => {
  const { context, storage, applied } = loadStrongBot();
  const losingDescriptor = {
    contextKey: 'late-entry|loss',
    actionKey: 'exact:loss',
    strategicActionKey: 'strategy:loss',
    familyActionKey: 'family:loss',
    behaviorActionKeys: ['behavior:route-loss', 'behavior:safety-loss'],
    legacyActionKey: 'legacy:loss',
    mistakeSeverity: 2.4,
    riskSignal: 3.1,
  };
  const winningDescriptor = {
    contextKey: 'route|winner',
    actionKey: 'exact:win',
    strategicActionKey: 'strategy:win',
    familyActionKey: 'family:win',
    behaviorActionKeys: ['behavior:route-win', 'behavior:safety-win'],
    legacyActionKey: 'legacy:win',
    mistakeSeverity: 0,
    riskSignal: 0,
  };

  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'normal',
    analysis: {
      botMemory: {
        decisions: [
          { actor: 'bot', experience: losingDescriptor },
          { actor: 'opponent', winQuality: 2.5, experience: winningDescriptor },
        ],
      },
    },
  }, 'dark');

  const learned = JSON.parse(storage.values.get(EXPERIENCE_KEY));
  const byKey = new Map(learned.map(pattern => [
    `${pattern.contextKey}::${pattern.actionKey}`,
    pattern,
  ]));
  [
    losingDescriptor.actionKey,
    losingDescriptor.strategicActionKey,
    losingDescriptor.familyActionKey,
    ...losingDescriptor.behaviorActionKeys,
    losingDescriptor.legacyActionKey,
  ].forEach((actionKey) => {
    const pattern = byKey.get(`${losingDescriptor.contextKey}::${actionKey}`);
    assert.equal(pattern.creditVersion, 5);
    assert.equal(pattern.losses, 1);
    assert.equal(pattern.wins, 0);
  });
  [
    winningDescriptor.actionKey,
    winningDescriptor.strategicActionKey,
    winningDescriptor.familyActionKey,
    ...winningDescriptor.behaviorActionKeys,
    winningDescriptor.legacyActionKey,
  ].forEach((actionKey) => {
    const pattern = byKey.get(`${winningDescriptor.contextKey}::${actionKey}`);
    assert.equal(pattern.creditVersion, 5);
    assert.equal(pattern.losses, 0);
    assert.equal(pattern.wins, 1);
    assert.equal(pattern.winWeight, 2.5);
  });
  assert.equal(applied.at(-1).source, 'local');
});

test('v27 discards outcome-poisoned local memory before engine sync', () => {
  const storage = memoryStorage({
    'narduh-long-bot-experience-v4': JSON.stringify([{
      contextKey: 'late-entry|forced-outcome-poison',
      actionKey: 'route:forced-loss',
      samples: 100,
      losses: 100,
      lossWeight: 400,
      creditVersion: 5,
    }]),
    'narduh-long-bot-experience-v3': JSON.stringify([{
      contextKey: 'route|broken-opponent-destination',
      actionKey: 'route:0>0+0>0',
      samples: 100,
      wins: 100,
      winWeight: 400,
      creditVersion: 4,
    }]),
    'narduh-long-bot-experience-v2': JSON.stringify([{
      contextKey: 'late-entry|v24-forced-shuffle',
      actionKey: 'entry:gain|progress:gain|home:shuffle|tower:flat|off:no',
      samples: 100,
      losses: 100,
      lossWeight: 400,
      creditVersion: 3,
    }]),
    'narduh-long-bot-experience-v1': JSON.stringify([{ contextKey: 'v1', actionKey: 'stale' }]),
  });
  const { context, applied } = loadStrongBot(storage);
  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'normal',
    analysis: { botMemory: { decisions: [] } },
  }, 'dark');

  assert.equal(applied.at(-1)?.patterns?.length || 0, 0);
  assert.equal(storage.values.has('narduh-long-bot-experience-v4'), false);
  assert.equal(storage.values.has('narduh-long-bot-experience-v3'), false);
  assert.equal(storage.values.has('narduh-long-bot-experience-v2'), false);
  assert.equal(storage.values.has('narduh-long-bot-experience-v1'), false);
});

test('v25 local learning discards zero-signal wins instead of teaching lucky mistakes', () => {
  const storage = memoryStorage({
    [EXPERIENCE_KEY]: JSON.stringify([{
      contextKey: 'old|zero',
      actionKey: 'old:zero',
      samples: 10,
      losses: 0,
      wins: 0,
    }]),
  });
  const { context } = loadStrongBot(storage);

  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'dark',
    resultType: 'normal',
    analysis: {
      botMemory: {
        decisions: [{
          actor: 'bot',
          experience: {
            contextKey: 'route|lucky',
            actionKey: 'home:shuffle',
            mistakeSeverity: 2.2,
            riskSignal: 2.2,
          },
        }],
      },
    },
  }, 'dark');

  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);
});

test('v26 local learning uses the same 1.1 harmful threshold as the server', () => {
  const { context, storage } = loadStrongBot();

  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'normal',
    analysis: {
      botMemory: {
        decisions: [{
          actor: 'bot',
          experience: {
            contextKey: 'route|weak-signal',
            actionKey: 'route:weak-signal',
            mistakeSeverity: 0.8,
            riskSignal: 0.8,
          },
        }],
      },
    },
  }, 'dark');

  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);
});

test('v27 local learning ignores a forced single-choice move in a lost game', () => {
  const { context, storage } = loadStrongBot();

  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'mars',
    analysis: {
      botMemory: {
        decisions: [{
          actor: 'bot',
          choiceCount: 1,
          experience: {
            contextKey: 'late-entry|forced-loss',
            actionKey: 'route:forced-loss',
            mistakeSeverity: 6,
            riskSignal: 6,
          },
        }],
      },
    },
  }, 'dark');

  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);
});

test('v25 does not learn a risky move merely because the opponent won', () => {
  const { context, storage } = loadStrongBot();

  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'normal',
    analysis: {
      botMemory: {
        decisions: [{
          actor: 'opponent',
          winQuality: 3,
          experience: {
            contextKey: 'route|lucky-opponent',
            actionKey: 'home:shuffle',
            mistakeSeverity: 2.2,
            riskSignal: 2.2,
          },
        }],
      },
    },
  }, 'dark');

  assert.deepEqual(JSON.parse(storage.values.get(EXPERIENCE_KEY)), []);
});

test('v25 local retention reserves equal space for losses and winner demonstrations', () => {
  const { context, storage } = loadStrongBot();
  const phases = ['head-development', 'route', 'late-entry', 'koks-rescue', 'bearoff'];
  const decisions = [];
  for (let index = 0; index < 80; index += 1) {
    const phase = phases[index % phases.length];
    decisions.push({
      actor: 'bot',
      experience: {
        contextKey: `${phase}|loss-${index}`,
        actionKey: `exact:loss-${index}`,
        strategicActionKey: `strategy:loss-${index}`,
        familyActionKey: `family:loss-${index}`,
        behaviorActionKeys: [`behavior:route-loss-${index}`, `behavior:safety-loss-${index}`],
        legacyActionKey: `legacy:loss-${index}`,
        mistakeSeverity: 3,
        riskSignal: 3,
      },
    });
    decisions.push({
      actor: 'opponent',
      winQuality: 2,
      experience: {
        contextKey: `${phase}|win-${index}`,
        actionKey: `exact:win-${index}`,
        strategicActionKey: `strategy:win-${index}`,
        familyActionKey: `family:win-${index}`,
        behaviorActionKeys: [`behavior:route-win-${index}`, `behavior:safety-win-${index}`],
        legacyActionKey: `legacy:win-${index}`,
        mistakeSeverity: 0,
        riskSignal: 0,
      },
    });
  }

  context.window.NarduStrongBot.learnFromGame({
    variant: 'long',
    winner: 'white',
    resultType: 'mars',
    analysis: { botMemory: { decisions } },
  }, 'dark');

  const learned = JSON.parse(storage.values.get(EXPERIENCE_KEY));
  const harmful = learned.filter(pattern => Number(pattern.losses || 0) > 0);
  const successful = learned.filter(pattern => Number(pattern.wins || 0) > 0);
  assert.equal(learned.length, 360);
  assert.equal(harmful.length, 180);
  assert.equal(successful.length, 180);
  assert.ok(successful.some(pattern => pattern.actionKey.startsWith('exact:win-')));
  assert.equal(new Set(successful.map(pattern => pattern.contextKey.split('|')[0])).size, phases.length);
});

test('v27 RPC excludes forced choices, publishes balanced cohorts and matches the schema', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/long-bot-strategy-v27.sql'),
    'utf8',
  );
  const client = fs.readFileSync(path.join(ROOT, 'rooms-client.js'), 'utf8');
  const rpcDefinition = /create or replace function public\.get_long_bot_experience_patterns\([\s\S]*?\n\$\$;/;
  const rpc = migration.match(rpcDefinition)?.[0] || '';

  assert.equal(rpc, schema.match(rpcDefinition)?.[0]);
  assert.match(
    migration,
    /create or replace function public\.long_bot_safe_numeric\(p_value jsonb\)[\s\S]*?when jsonb_typeof\(p_value\) = 'number' then \(p_value #>> '\{\}'\)::numeric[\s\S]*?when abs\(value\) <= 1000000000000 then value[\s\S]*?else null/,
  );
  assert.doesNotMatch(
    rpc,
    /(?:decision|descriptor|features|tactical)->>'[^']+'[^\n]*::numeric/,
  );
  assert.match(rpc, /substring\(g\.engine_version from 'v\(\[0-9\]\{1,4\}\)\$'\)/);
  assert.match(migration, /descriptor->>'strategicActionKey'/);
  assert.match(migration, /descriptor->'behaviorActionKeys'/);
  assert.match(migration, /latentFenceExposureDelta/);
  assert.match(migration, /latentFenceExposureBefore/);
  assert.match(migration, /latentFenceExposureAfter/);
  assert.match(migration, /'\|latent:'/);
  assert.match(migration, /features \? 'avoidableHomeShuffleMoves'/);
  assert.match(
    migration,
    /when features \? 'avoidableHomeShuffleMoves'\s+and coalesce\(public\.long_bot_safe_numeric\(features->'avoidableHomeShuffleMoves'\), 0\) > 0\s+and coalesce\(descriptor->>'phase', ''\) <> 'bearoff'/,
  );
  assert.doesNotMatch(
    migration,
    /when features \? 'avoidableHomeShuffleMoves'\s+then coalesce\(nullif\(features->>'avoidableHomeShuffleMoves', ''\)::numeric, 0\)\s+else coalesce\(nullif\(features->>'homeShuffleMoves', ''\)::numeric, 0\)/,
  );
  assert.match(migration, /then 'forced'/);
  assert.match(
    migration,
    /when not \(features \? 'avoidableHomeShuffleMoves'\)\s+and coalesce\(public\.long_bot_safe_numeric\(features->'homeShuffleMoves'\), 0\) > 0\s+then 'unknown'/,
  );
  assert.match(rpc, /case when engine_generation >= 25 then descriptor->>'actionKey' end/);
  assert.match(rpc, /decision->'choiceCount'/);
  assert.match(rpc, /public\.long_bot_safe_numeric\(decision->'choiceCount'\),\s+2\s+\) as choice_count/);
  assert.doesNotMatch(rpc, /jsonb_array_length\(decision->'alternatives'\)/);
  assert.match(
    rpc,
    /actor = 'bot' and engine_generation >= 27 and choice_count > 1\s+and winner <> bot_color/,
  );
  assert.match(rpc, /case when engine_generation >= 25 then nullif\(descriptor->'behaviorActionKeys'->>0, ''\) end/);
  assert.match(
    rpc,
    /actor = 'opponent'\s+and capture_version >= 1\s+and winner <> bot_color\s+and harm_signal < 1\.1\s+\) as successful/,
  );
  assert.match(migration, /\) action\s+where \(harmful or successful\) and engine_weight > 0/);
  assert.match(migration, /count\(\*\)::integer as samples/);
  assert.match(migration, /count\(\*\) filter \(where harmful\)::integer as losses/);
  assert.match(migration, /count\(\*\) filter \(where successful\)::integer as wins/);
  assert.match(migration, /count\(\*\) filter \(\s*where harmful and \(result_type in \('mars', 'koks'\) or harm_signal >= 3\.2\)\s*\)::integer as severe_losses/);
  assert.match(migration, /sum\(case when harmful then harm_signal else 0 end\)::double precision as signal_weight/);
  assert.match(migration, /where losses > 0 or wins > 0/);
  assert.match(migration, /partition by phase, cohort/);
  assert.match(migration, /where cohort_rank <= 64/);
  assert.match(migration, /limit 640/);
  assert.match(migration, /winner = bot_color and harm_signal < 1\.1/);
  assert.match(migration, /decision->'captureVersion'/);
  assert.match(migration, /when actor = 'opponent' and capture_version >= 1 then 4\.0/);
  assert.match(migration, /when actor = 'opponent' then 0\.0/);
  assert.match(migration, /when engine_generation >= 25 then 4\.0/);
  assert.match(migration, /when engine_generation >= 24 then 3\.0/);
  assert.match(migration, /when engine_generation >= 23 then 1\.0/);
  assert.match(migration, /else 0\.0\s+end as engine_weight/);
  assert.match(migration, /player_weight \* engine_weight/);
  assert.match(migration, /'creditVersion', 5/);
  assert.match(client, /narduh-long-bot-server-experience-v10/);
  assert.match(fs.readFileSync(path.join(ROOT, 'strong-bot.js'), 'utf8'), /EXPERIENCE_KEY = 'narduh-long-bot-experience-v5'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'supabase-client.js'), 'utf8'), /narduh-long-bot-experience-v5/);
  assert.match(schema, /Guest bot game must match the finished room snapshot/);
});
