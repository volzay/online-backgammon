const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const buildLongBotEngine = require("../scripts/build-long-bot-engine");

let cachedContext = null;

function loadContext() {
  if (cachedContext) return cachedContext;
  buildLongBotEngine();
  const context = {
    window: {},
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
  };
  context.window.window = context.window;
  context.globalThis = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "long-bot-engine.js"), "utf8"), context);
  cachedContext = {
    game: context.window.NarduGame,
    engine: context.window.NarduLongBotEngine,
  };
  return cachedContext;
}

function state(points, turn = "dark") {
  return {
    variant: "long",
    phase: "move",
    turn,
    dice: [2, 4],
    rolled: [2, 4],
    points,
    off: { white: 0, dark: 0 },
    bar: { white: 0, dark: 0 },
    score: { white: 0, dark: 0 },
    turnMoves: [],
    history: [],
    headPlayedThisTurn: { white: false, dark: false },
    firstMoveDone: { white: true, dark: true },
  };
}

function stateWithDice(points, dice, turn = "dark") {
  return {
    ...state(points, turn),
    dice,
    rolled: dice,
  };
}

function rank(position, label) {
  const { engine } = loadContext();
  engine.setExperience([], label);
  return engine.rank(position, {
    strategyProfile: "v25",
    maxCandidates: 64,
    analysisNodeBudget: 480,
  });
}

function descriptorKeys(descriptor) {
  return Array.from(new Set([
    descriptor.actionKey,
    descriptor.strategicActionKey,
    descriptor.familyActionKey,
    descriptor.legacyActionKey,
    ...(descriptor.behaviorActionKeys || []),
  ].filter(Boolean)));
}

function hostilePatterns(position, color, safeSequence, archivedSequence) {
  const { engine } = loadContext();
  const describe = sequence => engine.describeSequence(position, sequence, {
    strategyProfile: "v25",
    color,
  }).experience;
  const safe = describe(safeSequence);
  const archived = describe(archivedSequence);
  const safeKeys = new Set(descriptorKeys(safe));
  const archivedKeys = new Set(descriptorKeys(archived));
  const rewardKeys = [...archivedKeys].filter(key => !safeKeys.has(key));
  const penaltyKeys = [...safeKeys].filter(key => !archivedKeys.has(key));

  assert.ok(rewardKeys.length > 0, "the archived move needs a distinct reward key");
  assert.ok(penaltyKeys.length > 0, "the safe move needs a distinct penalty key");
  return [
    ...rewardKeys.map(actionKey => ({
      contextKey: archived.contextKey,
      actionKey,
      samples: 120,
      wins: 120,
      losses: 0,
      winWeight: 360,
      lossWeight: 0,
      severeLosses: 0,
      signalWeight: 0,
    })),
    ...penaltyKeys.map(actionKey => ({
      contextKey: safe.contextKey,
      actionKey,
      samples: 120,
      wins: 0,
      losses: 120,
      winWeight: 0,
      lossWeight: 360,
      severeLosses: 120,
      signalWeight: 360,
    })),
  ];
}

function rankAgainstHostileMemory(position, color, safeSequence, archivedSequence, label) {
  const { engine } = loadContext();
  engine.setExperience(
    hostilePatterns(position, color, safeSequence, archivedSequence),
    label,
  );
  try {
    return engine.rank(position, {
      strategyProfile: "v25",
      maxCandidates: 64,
      analysisNodeBudget: 480,
    });
  } finally {
    engine.setExperience([], `${label}-reset`);
  }
}

function hasMove(candidate, from, to, die) {
  return candidate.sequence.some(move => (
    Number(move.from) === from
    && Number(move.to) === to
    && Number(move.die) === die
  ));
}

function hasBearOff(candidate, from, die) {
  return candidate.sequence.some(move => (
    Number(move.from) === from
    && Number(move.die) === die
    && (move.bearOff || Number(move.to) === 0)
  ));
}

function maxLegalOffGain(position, color) {
  const { game } = loadContext();
  return Math.max(...game.bestMoveSequences(position, color).map(sequence => {
    const after = JSON.parse(JSON.stringify(position));
    sequence.forEach(move => game.applyMove(after, move.from, move.die, { autoEnd: false }));
    return Number(after.off[color] || 0) - Number(position.off[color] || 0);
  }));
}

function legalSequences(position, color) {
  return loadContext().game.bestMoveSequences(position, color);
}

// Production decision 36 / history event 232 / position lb4-5dab8ab3.
const TURN_232_DARK = {
  3: { color: "white", count: 5 },
  4: { color: "white", count: 1 },
  5: { color: "white", count: 4 },
  6: { color: "white", count: 4 },
  7: { color: "white", count: 1 },
  15: { color: "dark", count: 2 },
  16: { color: "dark", count: 3 },
  17: { color: "dark", count: 6 },
  18: { color: "dark", count: 3 },
  20: { color: "dark", count: 1 },
};

const TURN_232_WHITE_MIRROR = {
  3: { color: "white", count: 2 },
  4: { color: "white", count: 3 },
  5: { color: "white", count: 6 },
  6: { color: "white", count: 3 },
  8: { color: "white", count: 1 },
  15: { color: "dark", count: 5 },
  16: { color: "dark", count: 1 },
  17: { color: "dark", count: 4 },
  18: { color: "dark", count: 4 },
  19: { color: "dark", count: 1 },
};

// Same-day transfer case: the selected move staged both dice before home even
// though the checker on 22 could legally cross into dark's home board.
const Q4TL_NZ4L_DECISION_29 = {
  1: { color: "dark", count: 1 },
  4: { color: "dark", count: 1 },
  5: { color: "white", count: 2 },
  6: { color: "white", count: 8 },
  13: { color: "white", count: 2 },
  14: { color: "white", count: 2 },
  15: { color: "dark", count: 2 },
  16: { color: "dark", count: 4 },
  17: { color: "white", count: 1 },
  18: { color: "dark", count: 4 },
  20: { color: "dark", count: 1 },
  22: { color: "dark", count: 1 },
  23: { color: "dark", count: 1 },
};

test("8RMS-89BZ turn 232 enters the last dark checker and bears off with 2:4", () => {
  const position = state(TURN_232_DARK);
  const ranked = rank(position, "8rms-turn-232-dark");
  const selected = ranked[0];

  assert.equal(maxLegalOffGain(position, "dark"), 1);
  assert.ok(legalSequences(position, "dark").some(sequence => (
    hasMove({ sequence }, 20, 18, 2) && hasMove({ sequence }, 18, 14, 4)
  )), "the archived 20→18, 18→14 mistake must remain a legal alternative");
  assert.ok(hasMove(selected, 20, 18, 2), JSON.stringify(selected.sequence));
  assert.ok(hasBearOff(selected, 16, 4), JSON.stringify(selected.sequence));
  assert.equal(selected.features.outsideReduction, 1);
  assert.equal(selected.features.offGain, 1);
  assert.equal(selected.features.homeShuffleMoves, 0);
});

test("8RMS transition bear-off policy is color-symmetric", () => {
  const position = state(TURN_232_WHITE_MIRROR, "white");
  const ranked = rank(position, "8rms-turn-232-white");
  const selected = ranked[0];

  assert.equal(maxLegalOffGain(position, "white"), 1);
  assert.ok(hasMove(selected, 8, 6, 2), JSON.stringify(selected.sequence));
  assert.ok(hasBearOff(selected, 4, 4), JSON.stringify(selected.sequence));
  assert.equal(selected.features.outsideReduction, 1);
  assert.equal(selected.features.offGain, 1);
  assert.equal(selected.features.homeShuffleMoves, 0);
});

test("8RMS transition bear-off cannot be reversed by hostile experience", () => {
  const position = state(TURN_232_DARK);
  const safe = [{ from: 20, die: 2 }, { from: 16, die: 4 }];
  const archived = [{ from: 20, die: 2 }, { from: 18, die: 4 }];
  const selected = rankAgainstHostileMemory(
    position,
    "dark",
    safe,
    archived,
    "8rms-transition-hostile",
  )[0];

  assert.ok(hasMove(selected, 20, 18, 2), JSON.stringify(selected.sequence));
  assert.ok(hasBearOff(selected, 16, 4), JSON.stringify(selected.sequence));
  assert.equal(selected.features.offGain, 1);
  assert.equal(selected.features.homeShuffleMoves, 0);
});

test("8RMS avoidable transition shuffle is harmful even though the game was won", async () => {
  const position = state(TURN_232_DARK);
  const { experienceDescriptor } = await import(pathToFileURL(
    path.join(ROOT, "bot-engine/long/analysis.ts"),
  ).href);
  const descriptor = experienceDescriptor(position, "dark", {
    outsideReduction: 1,
    outsidePipGain: 2,
    homeShuffleMoves: 1,
    avoidableHomeShuffleMoves: 1,
    bearOffMoves: 0,
    offGain: 0,
  });

  assert.equal(descriptor.phase, "late-entry");
  assert.ok(descriptor.mistakeSeverity >= 1.1, descriptor.mistakeSeverity);
  assert.ok(descriptor.riskSignal >= 1.1, descriptor.riskSignal);
});

test("clear race enters both available outside checkers despite hostile staging memory", () => {
  const position = state({
    1: { color: "white", count: 15 },
    15: { color: "dark", count: 2 },
    16: { color: "dark", count: 3 },
    17: { color: "dark", count: 5 },
    18: { color: "dark", count: 3 },
    20: { color: "dark", count: 1 },
    22: { color: "dark", count: 1 },
  });
  const safe = [{ from: 20, die: 2 }, { from: 22, die: 4 }];
  const staged = [{ from: 22, die: 2 }, { from: 20, die: 4 }];
  const selected = rankAgainstHostileMemory(
    position,
    "dark",
    safe,
    staged,
    "8rms-clear-entry-hostile",
  )[0];

  assert.ok(hasMove(selected, 20, 18, 2), JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 22, 18, 4), JSON.stringify(selected.sequence));
  assert.equal(selected.features.outsideReduction, 2);
  assert.equal(selected.features.homeShuffleMoves, 0);
});

test("Q4TL-NZ4L clear late race enters a checker instead of staging before home", () => {
  const position = stateWithDice(Q4TL_NZ4L_DECISION_29, [1, 6]);
  const selected = rank(position, "q4tl-decision-29-entry")[0];

  assert.equal(selected.features.outsideReduction, 1, JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 22, 21, 1), JSON.stringify(selected.sequence));
  assert.ok(hasMove(selected, 21, 15, 6), JSON.stringify(selected.sequence));
  assert.equal(selected.features.homeEntryMoves, 1);
});

test("server learning does not reward safely avoidable late-entry shuffles", () => {
  for (const file of ["supabase/long-bot-strategy-v34.sql", "supabase/schema.sql"]) {
    const sql = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\s+/g, " ");
    assert.match(sql, /features \? 'avoidableHomeShuffleMoves' and coalesce\(public\.long_bot_safe_numeric\(features->'avoidableHomeShuffleMoves'\), 0\) > 0 and coalesce\(descriptor->>'phase', ''\) <> 'bearoff' then 1\.5/);
  }
});
