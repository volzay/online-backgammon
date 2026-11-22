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
  function persistUserSafely(user) {
    try {
      NarduApp.setUser(user);
      NarduApp.paintUser();
      return true;
    } catch (error) {
      console.warn('Could not persist the local rating cache', error?.message || error);
      return false;
    }
  }
  function compactHistoryEntry(entry = {}) {
    const { history, ...compact } = entry;
    const historyCount = Math.max(
      Array.isArray(history) ? history.length : 0,
      Number(entry.historyCount) || 0,
    );
    return { ...compact, historyCount };
  }

  function needsConfirmedRating(mode, score) {
    return mode === 'remote' || (mode === 'bot' && Boolean(score?.roomCode) && window.NarduSupabase?.configured?.());
  }

  async function syncSupabaseRating(user, entry, { onlyIfMissing = false } = {}) {
    if (!window.NarduSupabase?.configured?.() || !user?.id) return null;
    const client = await window.NarduSupabase.client();
    const rating = normalizeRating(user.rating);
    const tier = tierFor(rating);
    const now = new Date().toISOString();
    const confirmed = needsConfirmedRating(entry?.mode, entry?.score);
    if (confirmed) {
      const { data, error } = await client.auth.getSession();
      if (error || data?.session?.user?.id !== user.id) return null;
    } else {
      const { data, error } = await client.auth.getUser();
      if (error || data?.user?.id !== user.id) return null;
    }

    if (entry?.resultKey) {
      if (onlyIfMissing) {
        const { data, error } = await client.from('rating_events')
          .select('result_key').eq('user_id', user.id).eq('result_key', entry.resultKey).maybeSingle();
        if (error || data) return null;
      }
      // Bot room completion already saved the authoritative state and journal.
      // Award from that saved result using selectors, without uploading the
      // full analysis ledger again while the result window is waiting.
      const savedBotResult = confirmed && entry.mode === 'bot' && Boolean(entry.score?.roomCode);
      const rpcName = savedBotResult ? 'record_saved_bot_rating' : 'record_rating_result';
      const payload = savedBotResult ? {
        p_room_code: String(entry.score.roomCode),
        p_result_key: String(entry.resultKey || '').slice(0, 120),
      } : {
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
      };
      const { data: result, error: resultError } = await client.rpc(rpcName, payload);
      if (!resultError) {
        if (confirmed && (!Number.isInteger(result?.rating) || result.rating <= 0 || !Number.isInteger(result.delta))) return null;
        user.rating = normalizeRating(result?.rating);
        user.tier = result?.tier || tierFor(user.rating);
        user.ratingEligible = true;
        const current = NarduApp.getUser();
        if (current && !current.guest && current.id === user.id) {
          persistUserSafely({ ...current, rating: user.rating, tier: user.tier, ratingEligible: true });
        }
        return {
          delta: Number(result?.delta ?? entry?.delta ?? 0),
          rating: user.rating,
          tier: user.tier,
        };
      }
      // A confirmed room result must go through the participant-checked RPC.
      if (confirmed) throw resultError;
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
      persistUserSafely({
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
        persistUserSafely(data.user);
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
    const onlyIfMissing = details.onlyIfMissing === true;
    if (onlyIfMissing && (mode !== 'bot' || !resultKey || !details.score?.roomCode
      || !window.NarduSupabase?.configured?.())) return null;
    assignProfileRating(user);
    const opponent = normalizeRating(opponentRating);
    const delta = next(user.rating, opponent, didWin ? 1 : 0) - user.rating;
    const projectedRating = user.rating + delta;
    const confirmed = needsConfirmedRating(mode, details.score);
    if (!confirmed) {
      user.rating = projectedRating;
      user.tier = tierFor(user.rating);
      user.ratingEligible = true;
    }
    const fullHistory = Array.isArray(details.history) ? details.history.map(item => ({ ...item })) : [];
    const syncEntry = {
      resultKey: resultKey || `${mode}:${Date.now()}:${opponentName}:${didWin ? 1 : 0}`,
      ts: Date.now(),
      opponent: opponentName,
      opponentRating: opponent,
      didWin,
      mode,
      resultType: details.resultType || '',
      winner: details.winner || '',
      score: details.score || null,
      history: fullHistory,
      historyCount: Math.max(fullHistory.length, Number(details.historyCount) || 0),
      finishedAt: details.finishedAt || new Date().toISOString(),
      delta,
      ratingAfter: projectedRating,
      tierAfter: tierFor(projectedRating),
    };
    if (confirmed) {
      // A spectator or stale tab can compute a plausible local result. Keep
      // the profile unchanged until the server confirms participant identity
      // and the exact finished room; a rejected result leaves no local +1.
      const initialUserId = user.id;
      const submit = window.NarduSupabase?.configured?.()
        ? syncSupabaseRating({ ...user }, syncEntry, { onlyIfMissing })
        : syncServerRating({ ...user, rating: projectedRating, tier: tierFor(projectedRating) }, syncEntry);
      const syncPromise = Promise.resolve(submit).then(authoritative => {
        if (!authoritative) return null;
        const current = NarduApp.getUser();
        if (current && !current.guest && current.id === initialUserId) {
          const compactEntry = compactHistoryEntry({
            ...syncEntry,
            delta: Number(authoritative.delta ?? delta),
            ratingAfter: normalizeRating(authoritative.rating),
            tierAfter: authoritative.tier || tierFor(authoritative.rating),
          });
          const previous = Array.isArray(current.history) ? current.history.map(compactHistoryEntry) : [];
          persistUserSafely({
            ...current,
            rating: normalizeRating(authoritative.rating),
            tier: authoritative.tier || tierFor(authoritative.rating),
            ratingEligible: true,
            history: [compactEntry, ...previous.filter(item => item.resultKey !== compactEntry.resultKey)].slice(0, 50),
          });
        }
        return authoritative;
      }).catch(() => null);
      return { delta: 0, rating: null, tier: user.tier, syncPromise, authoritativePending: true };
    }
    const compactEntry = compactHistoryEntry(syncEntry);
    user.history = [
      compactEntry,
      ...(Array.isArray(user.history) ? user.history.map(compactHistoryEntry) : []),
    ].slice(0, 50);
    persistUserSafely(user);
    const syncPromise = syncRegisteredRating(user, syncEntry);
    return { delta, rating: user.rating, tier: user.tier, syncPromise };
  }

  return { expected, next, tierFor, normalizeRating, isRatedUser, assignProfileRating, record };
})();
