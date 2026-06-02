/* ───────────────────────────────────────────────────────
   rating.js — ELO-lite rating stored in the user's profile.
   Exposes: window.NarduRating
   ─────────────────────────────────────────────────────── */
window.NarduRating = (function () {
  const K = 24;
  const DEFAULT_RATING = 1000;
  const TIERS = [
    { name: 'Diamond', min: 2100 },
    { name: 'Platinum', min: 1800 },
    { name: 'Gold', min: 1500 },
    { name: 'Silver', min: 1200 },
    { name: 'Bronze', min: 0 },
  ];

  function expected(rA, rB) {
    return 1 / (1 + Math.pow(10, (rB - rA) / 400));
  }
  /* score 1=win, 0=loss, 0.5=draw */
  function next(rating, opponentRating, score) {
    const exp = expected(rating, opponentRating);
    return Math.round(rating + K * (score - exp));
  }
  function tierFor(r) {
    const rating = Number(r);
    if (!Number.isFinite(rating)) return 'Bronze';
    return TIERS.find(tier => rating >= tier.min)?.name || 'Bronze';
  }
  function normalizeRating(value) {
    const rating = Math.round(Number(value));
    return Number.isFinite(rating) && rating > 0 ? rating : DEFAULT_RATING;
  }
  function isRatedUser(user) {
    return Boolean(user && !user.guest && user.ratingEligible !== false && (user.id || user.email || user.nickname));
  }
  function assignProfileRating(user) {
    if (!user) return null;
    if (!isRatedUser(user)) {
      user.rating = null;
      user.tier = '';
      user.ratingEligible = false;
      return user;
    }
    user.rating = normalizeRating(user.rating);
    user.tier = tierFor(user.rating);
    user.ratingEligible = true;
    return user;
  }
  function syncRegisteredRating(user, entry) {
    if (!isRatedUser(user)) return;
    fetch('/api/rating/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        nickname: user.nickname || user.name,
        rating: user.rating,
        tier: user.tier,
        ...entry,
      }),
      keepalive: true,
    })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!data?.user) return;
        const current = NarduApp.getUser();
        if (!current || current.guest || (current.id && current.id !== data.user.id)) return;
        NarduApp.setUser(data.user);
        NarduApp.paintUser();
      })
      .catch(() => {});
  }

  /* record a finished game in the current user's profile */
  function record(opponentName, opponentRating, didWin, mode = 'bot', resultKey = '', details = {}) {
    const user = NarduApp.getUser();
    if (!isRatedUser(user)) return null;
    assignProfileRating(user);
    const opponent = normalizeRating(opponentRating);
    const delta = next(user.rating, opponent, didWin ? 1 : 0) - user.rating;
    user.rating += delta;
    user.tier   = tierFor(user.rating);
    user.ratingEligible = true;
    user.history = user.history || [];
    const entry = {
      resultKey: resultKey || `${mode}:${Date.now()}:${opponentName}:${didWin ? 1 : 0}`,
      ts: Date.now(),
      opponent: opponentName,
      opponentRating: opponent,
      didWin,
      mode,
      resultType: details.resultType || '',
      winner: details.winner || '',
      score: details.score || null,
      finishedAt: details.finishedAt || new Date().toISOString(),
      delta,
      ratingAfter: user.rating,
      tierAfter: user.tier,
    };
    user.history.unshift(entry);
    /* trim to last 50 games */
    if (user.history.length > 50) user.history.length = 50;
    NarduApp.setUser(user);
    NarduApp.paintUser();
    syncRegisteredRating(user, entry);
    return { delta, rating: user.rating, tier: user.tier };
  }

  return { expected, next, tierFor, normalizeRating, isRatedUser, assignProfileRating, record };
})();
