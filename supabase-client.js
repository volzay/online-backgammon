(function () {
  const SUPABASE_CDNS = [
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
    "https://unpkg.com/@supabase/supabase-js@2",
  ];
  let clientPromise = null;
  const AUTH_RECLAIM_EXACT_KEYS = new Set([
    "narduh-long-bot-server-experience-v4",
    "narduh-long-bot-server-experience-v3",
    "narduh-long-bot-server-experience-v2",
    "narduh-long-bot-experience-v1",
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

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        if (window.supabase?.createClient) resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
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
      clientPromise = (async () => {
        await loadSupabaseSdk();
        const cfg = config();
        return window.supabase.createClient(cfg.url, cfg.anonKey, {
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
