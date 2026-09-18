(function () {
  const SUPABASE_CDNS = [
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
    "https://unpkg.com/@supabase/supabase-js@2",
  ];
  const SUPABASE_SDK_LOAD_TIMEOUT_MS = 5000;
  const SUPABASE_FETCH_TIMEOUT_MS = 6000;
  const GUEST_CREDENTIAL_KEY = 'narduh-guest-credential-v1';
  const GUEST_PUBLIC_ID_RE = /^guest:sha256:[0-9a-f]{64}$/;
  const GUEST_PROOF_RE = /^gproof:[0-9a-f]{64}$/;
  const FAIR_DICE_CLIENT_MARKER = 'nardu-fair-dice-v36';
  let clientPromise = null;
  const AUTH_RECLAIM_EXACT_KEYS = new Set([
    "narduh-long-bot-server-experience-v15",
    "narduh-long-bot-server-experience-v14",
    "narduh-long-bot-server-experience-v13",
    "narduh-long-bot-server-experience-v12",
    "narduh-long-bot-server-experience-v11",
    "narduh-long-bot-server-experience-v10",
    "narduh-long-bot-server-experience-v9",
    "narduh-long-bot-server-experience-v8",
    "narduh-long-bot-server-experience-v7",
    "narduh-long-bot-server-experience-v6",
    "narduh-long-bot-server-experience-v5",
    "narduh-long-bot-server-experience-v4",
    "narduh-long-bot-server-experience-v3",
    "narduh-long-bot-server-experience-v2",
    "narduh-long-bot-experience-v8",
    "narduh-long-bot-experience-v7",
    "narduh-long-bot-experience-v6",
    "narduh-long-bot-experience-v5",
    "narduh-long-bot-experience-v4",
    "narduh-long-bot-experience-v3",
    "narduh-long-bot-experience-v2",
    "narduh-long-bot-experience-v1",
    "narduh-short-bot-server-experience-v5",
    "narduh-short-bot-server-experience-v6",
    "narduh-short-bot-server-experience-v4",
    "narduh-short-bot-server-experience-v3",
    "narduh-short-bot-server-experience-v2",
    "narduh-short-bot-server-experience-v1",
    "narduh-short-bot-experience-v5",
    "narduh-short-bot-experience-v6",
    "narduh-short-bot-experience-v4",
    "narduh-short-bot-experience-v3",
    "narduh-short-bot-experience-v2",
    "narduh-short-bot-experience-v1",
    "narduh-room-reload-snapshot",
  ]);
  const AUTH_RECLAIM_PREFIXES = [
    "narduh-bot-game:",
    "narduh-room-state:",
  ];

  function storageKeys() {
    const keys = [];
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key) keys.push(key);
      }
    } catch {}
    return keys;
  }

  function reclaimAuthStorage() {
    let removed = 0;
    storageKeys().forEach(key => {
      if (!AUTH_RECLAIM_EXACT_KEYS.has(key) && !AUTH_RECLAIM_PREFIXES.some(prefix => key.startsWith(prefix))) return;
      try {
        localStorage.removeItem(key);
        removed += 1;
      } catch {}
    });
    return removed;
  }

  function compactLocalProfileCache() {
    try {
      const key = "narduh-user";
      const profile = JSON.parse(localStorage.getItem(key) || "null");
      if (!profile || typeof profile !== "object") return false;
      const compact = {
        id: profile.id || "",
        name: profile.name || profile.nickname || "Player",
        nickname: profile.nickname || profile.name || "Player",
        email: profile.email || "",
        rating: profile.rating,
        tier: profile.tier || "",
        ratingEligible: profile.ratingEligible !== false,
        registered: profile.registered !== false,
        guest: profile.guest === true,
        history: [],
      };
      localStorage.removeItem(key);
      localStorage.setItem(key, JSON.stringify(compact));
      return true;
    } catch {
      return false;
    }
  }

  const authStorage = {
    getItem(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    setItem(key, value) {
      try {
        localStorage.setItem(key, value);
        return;
      } catch (initialError) {
        reclaimAuthStorage();
        try {
          localStorage.setItem(key, value);
          return;
        } catch {}
        compactLocalProfileCache();
        try {
          localStorage.setItem(key, value);
          return;
        } catch {
          throw initialError;
        }
      }
    },
    removeItem(key) {
      try { localStorage.removeItem(key); } catch {}
    },
  };

  function config() {
    const env = window.NARDU_ENV || {};
    return {
      url: String(env.supabaseUrl || "").trim(),
      anonKey: String(env.supabaseAnonKey || "").trim(),
      siteBaseUrl: String(env.siteBaseUrl || "").trim(),
      adminEmails: String(env.adminEmails || "").trim(),
      deployTarget: String(env.deployTarget || "local"),
    };
  }

  function configured() {
    const cfg = config();
    return Boolean(cfg.url && cfg.anonKey);
  }

  function isAuthCriticalRequest(input) {
    const value = typeof input === "string" ? input : String(input?.url || input || "");
    return /\/auth\/v1\/|\/rest\/v1\/profiles(?:[/?#]|$)|\/rest\/v1\/rpc\/(?:nickname_auth_email|register_nickname_user)(?:[/?#]|$)/i.test(value);
  }

  function currentGuestRequestCredential() {
    try {
      const user = JSON.parse(localStorage.getItem('narduh-user') || 'null');
      const stored = JSON.parse(localStorage.getItem(GUEST_CREDENTIAL_KEY) || 'null');
      const guestId = user?.guest === true ? String(user.id || '').trim() : '';
      const proof = String(stored?.proof || '').trim();
      if (Number(stored?.version) !== 1 || stored?.guestId !== guestId) return null;
      if (!GUEST_PUBLIC_ID_RE.test(guestId) || !GUEST_PROOF_RE.test(proof)) return null;
      return { guestId, proof };
    } catch {
      return null;
    }
  }

  function isSupabaseRestRequest(input) {
    const value = typeof input === 'string' ? input : String(input?.url || input || '');
    const base = config().url.replace(/\/+$/, '');
    if (!base) return false;
    if (typeof URL === 'function') {
      try {
        const configuredUrl = new URL(base);
        const requestUrl = new URL(value, configuredUrl);
        return requestUrl.origin === configuredUrl.origin
          && requestUrl.pathname.startsWith(`${configuredUrl.pathname.replace(/\/+$/, '')}/rest/v1/`);
      } catch { return false; }
    }
    return value.startsWith(`${base}/rest/v1/`);
  }

  function withProtocolRequestHeaders(input, init = {}) {
    if (!isSupabaseRestRequest(input)) return init;
    const original = init.headers || input?.headers || {};
    if (typeof Headers === 'function') {
      const headers = new Headers(original);
      const info = headers.get('X-Client-Info') || '';
      if (!info.split(/\s+/).includes(FAIR_DICE_CLIENT_MARKER)) {
        headers.set('X-Client-Info', `${info} ${FAIR_DICE_CLIENT_MARKER}`.trim());
      }
      return { ...init, headers };
    }
    const headers = Array.isArray(original) || typeof original?.entries === 'function'
      ? Object.fromEntries(typeof original.entries === 'function' && !Array.isArray(original) ? original.entries() : original)
      : { ...original };
    const infoKey = Object.keys(headers).find(key => key.toLowerCase() === 'x-client-info') || 'X-Client-Info';
    const info = String(headers[infoKey] || '');
    if (!info.split(/\s+/).includes(FAIR_DICE_CLIENT_MARKER)) {
      headers[infoKey] = `${info} ${FAIR_DICE_CLIENT_MARKER}`.trim();
    }
    return { ...init, headers };
  }

  function withGuestRequestHeaders(input, init = {}) {
    if (!isSupabaseRestRequest(input)) return init;
    const credential = currentGuestRequestCredential();
    if (!credential) return init;
    if (typeof Headers === 'function') {
      const headers = new Headers(init.headers || input?.headers || {});
      headers.set('X-Guest-Id', credential.guestId);
      headers.set('X-Guest-Proof', credential.proof);
      return { ...init, headers };
    }
    return {
      ...init,
      headers: {
        ...(init.headers || {}),
        'X-Guest-Id': credential.guestId,
        'X-Guest-Proof': credential.proof,
      },
    };
  }

  async function boundedFetch(input, init = {}) {
    const requestInit = withGuestRequestHeaders(input, withProtocolRequestHeaders(input, init));
    if (!isAuthCriticalRequest(input)) return fetch(input, requestInit);
    if (typeof AbortController !== "function") return fetch(input, requestInit);

    const controller = new AbortController();
    const externalSignal = requestInit?.signal;
    let externallyAborted = false;
    let timedOut = false;
    let timer = null;
    const abortRequest = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    const forwardExternalAbort = () => {
      externallyAborted = true;
      abortRequest();
    };

    if (externalSignal?.aborted) {
      forwardExternalAbort();
    } else {
      externalSignal?.addEventListener?.("abort", forwardExternalAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (externallyAborted) return;
      timedOut = true;
      abortRequest();
    }, SUPABASE_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(input, { ...requestInit, signal: controller.signal });
      if (typeof response?.clone === "function") {
        const bodyProbe = response.clone();
        if (typeof bodyProbe?.arrayBuffer === "function") await bodyProbe.arrayBuffer();
      }
      return response;
    } catch (error) {
      if (!timedOut) throw error;
      const timeoutError = new Error("Supabase request timed out.");
      timeoutError.name = "TimeoutError";
      timeoutError.code = "SUPABASE_FETCH_TIMEOUT";
      timeoutError.cause = error;
      throw timeoutError;
    } finally {
      if (timer !== null) clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", forwardExternalAbort);
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const existing = document.querySelector(`script[src="${src}"]`);
      const script = existing || document.createElement("script");
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        script.removeEventListener?.("load", handleLoad);
        script.removeEventListener?.("error", handleError);
      };
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };
      const handleLoad = () => {
        if (window.supabase?.createClient) finish(resolve);
        else {
          script.remove?.();
          finish(reject, new Error(`Supabase SDK did not initialize from ${src}`));
        }
      };
      const handleError = () => {
        script.remove?.();
        finish(reject, new Error(`Could not load Supabase SDK from ${src}`));
      };

      if (window.supabase?.createClient) {
        finish(resolve);
        return;
      }

      script.addEventListener?.("load", handleLoad, { once: true });
      script.addEventListener?.("error", handleError, { once: true });
      timer = setTimeout(() => {
        script.remove?.();
        finish(reject, new Error(`Supabase SDK load timed out for ${src}`));
      }, SUPABASE_SDK_LOAD_TIMEOUT_MS);

      if (!existing) {
        script.src = src;
        script.async = true;
        document.head.appendChild(script);
      }
    });
  }

  async function loadSupabaseSdk() {
    if (window.supabase?.createClient) return;
    const errors = [];
    for (const src of SUPABASE_CDNS) {
      try {
        await loadScript(src);
        if (window.supabase?.createClient) return;
      } catch (error) {
        errors.push(error);
      }
    }
    throw new Error("Не удалось загрузить Supabase SDK. Проверьте интернет, блокировщик рекламы или попробуйте другой браузер.");
  }

  async function client() {
    if (!configured()) {
      throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY for GitHub Pages.");
    }
    if (!clientPromise) {
      const pending = (async () => {
        await loadSupabaseSdk();
        const cfg = config();
        return window.supabase.createClient(cfg.url, cfg.anonKey, {
          global: {
            fetch: boundedFetch,
          },
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storage: authStorage,
          },
          realtime: {
            params: { eventsPerSecond: 20 },
          },
        });
      })();
      clientPromise = pending;
      pending.catch(() => {
        if (clientPromise === pending) clientPromise = null;
      });
    }
    return clientPromise;
  }

  function roomTopic(code) {
    return `room:${String(code || "").trim().toUpperCase()}`;
  }

  window.NarduSupabase = {
    client,
    config,
    configured,
    reclaimAuthStorage,
    roomTopic,
  };
})();
