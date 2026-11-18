(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.NarduAdminRoomData = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function archives(room) {
    const completed = [...(room?.room_game_archives || [])];
    (room?.bot_training_games || []).forEach(item => {
      const finalState = item?.final_state || {};
      const hasFinalState = Boolean(finalState.winner || finalState.finishedAt || finalState.history);
      if (!finalState.winner && !item?.winner) return;
      // The training payload may omit history. Prefer the full room snapshot
      // of that same finished game, without replacing a genuinely newer game.
      if (finalState.finishedAt && completed.some(archive =>
        archive.final_state?.finishedAt === finalState.finishedAt
        && (archive.final_state?.winner || archive.winner) === (finalState.winner || item.winner))) return;
      completed.push({
        id: `training:${item.id || item.room_code || completed.length}`,
        result_key: `training:${item.id || item.room_code || completed.length}`,
        winner: finalState.winner || item.winner,
        result_type: finalState.resultType || item.result_type || "normal",
        borne_off: finalState.borneOff || finalState.off || {},
        history_count: Array.isArray(finalState.history)
          ? finalState.history.length
          : Number(item.decision_count || 0),
        final_state: hasFinalState ? finalState : null,
        bot_color: item.bot_color || null,
        completed_at: item.completed_at || finalState.finishedAt || "",
      });
    });
    return completed
      .sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
  }

  function latestArchive(room) {
    return archives(room)[0] || null;
  }

  function borneOff(game = {}) {
    const explicit = game.borneOff || game.off || {};
    const result = {
      white: Math.max(0, Number(explicit.white || 0)),
      dark: Math.max(0, Number(explicit.dark || 0)),
    };
    if (result.white || result.dark || !Array.isArray(game.history)) return result;
    game.history.forEach(item => {
      if (!item || !["снято", "borne-off"].includes(item.to)) return;
      if (item.color === "white" || item.color === "dark") result[item.color] += 1;
    });
    return result;
  }

  function rollStats(game = {}) {
    game = game || {};
    const byColor = {
      white: { rolls: 0, doubles: 0, doubleRate: 0 },
      dark: { rolls: 0, doubles: 0, doubleRate: 0 },
    };
    const seen = new Set();
    const rolls = (Array.isArray(game.history) ? game.history : []).filter(item => {
      if (!item || !Object.hasOwn(byColor, item.color) || item.opening || item.openingRoll
        || item.fairDiceProof?.request?.label === "opening" || !/^[1-6]:[1-6]$/.test(String(item.roll))) return false;
      const id = item.fairDiceProof?.request?.id;
      if (typeof id === "string" && id) {
        if (seen.has(id)) return false;
        seen.add(id);
      }
      const stats = byColor[item.color];
      stats.rolls += 1;
      if (item.roll[0] === item.roll[2]) stats.doubles += 1;
      return true;
    });
    for (const stats of Object.values(byColor)) {
      stats.doubleRate = stats.rolls ? stats.doubles / stats.rolls : 0;
    }
    const doubles = byColor.white.doubles + byColor.dark.doubles;
    return {
      historyAvailable: Array.isArray(game.history) && !(game.winner && game.history.length === 0),
      byColor,
      rolls: rolls.length,
      doubles,
      doubleRate: rolls.length ? doubles / rolls.length : 0,
      lastRoll: rolls[0]
        ? { color: rolls[0].color, roll: rolls[0].roll, at: rolls[0].at, sha256: rolls[0].sha256 }
        : null,
    };
  }

  function botPlayerColor(game = {}, fallbackBotColor = null) {
    const outcomeColor = game.analysis?.botMemory?.outcome?.botColor;
    if (game.mode !== "bot" && !outcomeColor && !fallbackBotColor) return null;
    if (["white", "dark"].includes(game.analysis?.playerColor)) return game.analysis.playerColor;
    const botColor = ["white", "dark"].includes(outcomeColor) ? outcomeColor : fallbackBotColor;
    return botColor === "white" ? "dark" : botColor === "dark" ? "white" : null;
  }

  function displayedGame(room) {
    const liveGame = room?.game_state || {};
    const archive = latestArchive(room);
    if (liveGame.winner || !archive) return { game: liveGame, liveGame, archive, archived: false };
    const game = archive.final_state || {
      winner: archive.winner,
      resultType: archive.result_type,
      off: archive.borne_off,
      history: [],
    };
    return { game, liveGame, archive, archived: true };
  }

  return { archives, latestArchive, borneOff, rollStats, botPlayerColor, displayedGame };
});
