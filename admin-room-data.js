(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.NarduAdminRoomData = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function archives(room) {
    return [...(room?.room_game_archives || [])]
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

  return { archives, latestArchive, borneOff, displayedGame };
});
