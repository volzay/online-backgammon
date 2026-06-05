(function () {
  const SUPABASE_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
  let clientPromise = null;

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

  async function client() {
    if (!configured()) {
      throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY for GitHub Pages.");
    }
    if (!clientPromise) {
      clientPromise = (async () => {
        if (!window.supabase?.createClient) await loadScript(SUPABASE_CDN);
        const cfg = config();
        return window.supabase.createClient(cfg.url, cfg.anonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
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
    roomTopic,
  };
})();
