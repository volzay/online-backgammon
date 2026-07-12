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
  async function syncSupabaseRating(user, entry) {
    if (!window.NarduSupabase?.configured?.() || !user?.id) return null;
    const client = await window.NarduSupabase.client();
    const rating = normalizeRating(user.rating);
    const tier = tierFor(rating);
    const now = new Date().toISOString();
    const { data: authData, error: authError } = await client.auth.getUser();
    if (authError || authData?.user?.id !== user.id) return null;

    if (entry?.resultKey) {
      const { data: result, error: resultError } = await client.rpc('record_rating_result', {
        p_result_key: String(entry.resultKey || '').slice(0, 120),
        p_opponent: String(entry.opponent || '').slice(0, 32),
        p_opponent_rating: Number.isFinite(Number(entry.opponentRating)) ? Number(entry.opponentRating) : DEFAULT_RATING,
        p_did_win: Boolean(entry.didWin),
        p_mode: String(entry.mode || '').slice(0, 20),
        p_result_type: ['mars', 'koks'].includes(entry.resultType) ? entry.resultType : '',
        p_winner: entry.winner === 'dark' ? 'dark' : (entry.winner === 'white' ? 'white' : ''),
        p_score: entry.score && typeof entry.score === 'object' ? entry.score : {},
        p_history: Array.isArray(entry.history) ? entry.history.slice(0, 500) : [],
        p_finished_at: entry.finishedAt || new Date().toISOString(),
      });
      if (!resultError) {
        user.rating = normalizeRating(result?.rating);
        user.tier = result?.tier || tierFor(user.rating);
        user.ratingEligible = true;
        const current = NarduApp.getUser();
        if (current && !current.guest && current.id === user.id) {
          NarduApp.setUser({ ...current, rating: user.rating, tier: user.tier, ratingEligible: true });
          NarduApp.paintUser();
        }
        return {
          delta: Number(result?.delta ?? entry?.delta ?? 0),
          rating: user.rating,
          tier: user.tier,
        };
      }
      if (!/record_rating_result|Could not find the function|schema cache/i.test(resultError.message || '')) {
        throw resultError;
      }
    }

    const { data: profile, error: profileError } = await client
      .from('profiles')
      .update({
        rating,
        tier,
        rating_eligible: true,
        last_seen_at: now,
      })
      .eq('id', user.id)
      .select('id,nickname,email,rating,tier,rating_eligible')
      .maybeSingle();
    if (profileError) throw profileError;

    if (entry?.resultKey) {
      const eventPayload = {
        user_id: user.id,
        result_key: String(entry.resultKey || '').slice(0, 120),
        opponent: String(entry.opponent || '').slice(0, 32),
        opponent_rating: Number.isFinite(Number(entry.opponentRating)) ? Number(entry.opponentRating) : null,
        did_win: Boolean(entry.didWin),
        mode: String(entry.mode || '').slice(0, 20),
        result_type: ['mars', 'koks'].includes(entry.resultType) ? entry.resultType : '',
        winner: entry.winner === 'dark' ? 'dark' : (entry.winner === 'white' ? 'white' : ''),
        score: entry.score && typeof entry.score === 'object' ? {
          white: Number(entry.score.white) || 0,
          dark: Number(entry.score.dark) || 0,
        } : null,
        history: Array.isArray(entry.history) ? entry.history.slice(0, 500) : [],
        delta: Number(entry.delta || 0),
        rating_after: rating,
      };
      let { error: eventError } = await client
        .from('rating_events')
        .insert(eventPayload);
      if (eventError && /history/i.test(eventError.message || '')) {
        const { history, ...legacyPayload } = eventPayload;
        const retry = await client.from('rating_events').insert(legacyPayload);
        eventError = retry.error;
      }
      if (eventError && eventError.code !== '23505') throw eventError;
    }

    const current = NarduApp.getUser();
    if (profile && current && !current.guest && current.id === profile.id) {
      NarduApp.setUser({
        ...current,
        name: profile.nickname || current.name,
        nickname: profile.nickname || current.nickname,
        email: profile.email || current.email || '',
        rating: profile.rating,
        tier: profile.tier,
        ratingEligible: profile.rating_eligible !== false,
        registered: true,
        guest: false,
      });
      NarduApp.paintUser();
    }
    return {
      delta: Number(entry?.delta || 0),
      rating: normalizeRating(profile?.rating ?? rating),
      tier: profile?.tier || tier,
    };
  }

  function syncServerRating(user, entry) {
    if (!isRatedUser(user)) return Promise.resolve(false);
    return fetch('/api/rating/sync', {
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
        if (!data?.user) return null;
        const current = NarduApp.getUser();
        if (!current || current.guest || (current.id && current.id !== data.user.id)) return null;
        NarduApp.setUser(data.user);
        NarduApp.paintUser();
        return {
          delta: Number(data.delta ?? entry?.delta ?? 0),
          rating: normalizeRating(data.user.rating),
          tier: data.user.tier || tierFor(data.user.rating),
        };
      })
      .catch(() => null);
  }

  function syncRegisteredRating(user, entry) {
    if (!isRatedUser(user)) return Promise.resolve(false);
    return syncSupabaseRating(user, entry)
      .then(result => {
        if (!result) return syncServerRating(user, entry);
        return result;
      })
      .catch(() => {
        if (!window.NarduSupabase?.configured?.()) return syncServerRating(user, entry);
        return null;
      });
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
      history: Array.isArray(details.history) ? details.history.map(item => ({ ...item })) : [],
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
    const syncPromise = syncRegisteredRating(user, entry);
    return { delta, rating: user.rating, tier: user.tier, syncPromise };
  }

  return { expected, next, tierFor, normalizeRating, isRatedUser, assignProfileRating, record };
})();
