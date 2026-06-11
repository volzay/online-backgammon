(function () {
  function normalizeProfile(profile = {}, authUser = {}) {
    const metadata = authUser.user_metadata || {};
    const rawRating = Math.round(Number(profile.rating ?? metadata.rating ?? 1000));
    const rating = Number.isFinite(rawRating) && rawRating > 0 ? rawRating : 1000;
    const nickname = profile.nickname || metadata.nickname || metadata.name || authUser.email?.split("@")[0] || "Player";
    return {
      id: profile.id || authUser.id || "",
      name: nickname,
      nickname,
      email: profile.email || authUser.email || "",
      rating,
      tier: profile.tier || NarduApp.ratingTierFor(rating),
      ratingEligible: profile.rating_eligible !== false,
      registered: true,
      guest: false,
    };
  }

  async function apiJson(url, options = {}, errorKey = "err_auth") {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(NarduApp.translateServerMessage(data.error) || NarduApp.t(errorKey));
    return data;
  }

  function authErrorMessage(error, fallbackKey = "err_auth") {
    const message = String(error?.message || error || "");
    if (/email rate limit exceeded/i.test(message)) {
      return "Supabase временно ограничил отправку писем подтверждения. Попробуйте позже или войдите, если аккаунт уже создан.";
    }
    if (/already registered|already been registered|user already registered/i.test(message)) {
      return "На эту электронную почту уже зарегистрирован аккаунт.";
    }
    if (/duplicate key|profiles_nickname|nickname/i.test(message)) {
      return "Такой никнейм уже занят.";
    }
    if (/anonymous|anon/i.test(message)) {
      return "Регистрация по никнейму временно недоступна в Supabase. Включите Anonymous sign-ins в настройках Auth.";
    }
    if (/invalid email/i.test(message)) return "Введите корректный email.";
    return message || NarduApp.t(fallbackKey);
  }

  function publicPageUrl(page) {
    const cfg = window.NarduSupabase?.config?.() || {};
    const configuredBase = String(cfg.siteBaseUrl || "").replace(/\/+$/, "");
    if (configuredBase) return `${configuredBase}/${page}`;
    return new URL(page, location.href).href;
  }

  async function profileForAuthUser(supabase, authUser) {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id,nickname,email,rating,tier,rating_eligible")
      .eq("id", authUser.id)
      .maybeSingle();
    if (error) throw error;
    if (profile) return normalizeProfile(profile, authUser);
    const metadata = authUser.user_metadata || {};
    const fallbackProfile = {
      id: authUser.id,
      nickname: metadata.nickname || metadata.name || authUser.email?.split("@")[0] || "Player",
      email: authUser.email || "",
      rating: 1000,
      tier: "Bronze",
      rating_eligible: true,
      last_seen_at: new Date().toISOString(),
    };
    const { data: savedProfile, error: upsertError } = await supabase
      .from("profiles")
      .upsert(fallbackProfile, { onConflict: "id" })
      .select("id,nickname,email,rating,tier,rating_eligible")
      .single();
    if (upsertError) throw upsertError;
    return normalizeProfile(savedProfile, authUser);
  }

  async function signInSupabase({ identifier, password }) {
    if (!window.NarduSupabase?.configured?.()) return null;
    const supabase = await window.NarduSupabase.client();
    const email = String(identifier || "").trim();
    if (!email.includes("@")) {
      throw new Error("Для входа через Supabase используйте email. Вход по никнейму будет включен после переноса профилей.");
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(authErrorMessage(error));
    if (!data.user) throw new Error(NarduApp.t("err_auth"));
    return { user: await profileForAuthUser(supabase, data.user) };
  }

  async function signUpSupabase({ nickname, email, password }) {
    if (!window.NarduSupabase?.configured?.()) return null;
    const supabase = await window.NarduSupabase.client();
    const nicknameOnly = !String(email || "").trim();
    if (nicknameOnly) {
      const { data, error } = await supabase.auth.signInAnonymously({
        options: { data: { nickname, name: nickname } },
      });
      if (error) throw new Error(authErrorMessage(error, "err_register"));
      if (!data.user) throw new Error(NarduApp.t("err_register"));
      const profile = {
        id: data.user.id,
        nickname,
        email: "",
        rating: 1000,
        tier: "Bronze",
        rating_eligible: true,
        last_seen_at: new Date().toISOString(),
      };
      const { data: savedProfile, error: profileError } = await supabase
        .from("profiles")
        .upsert(profile, { onConflict: "id" })
        .select("id,nickname,email,rating,tier,rating_eligible")
        .single();
      if (profileError) throw new Error(authErrorMessage(profileError, "err_register"));
      return { user: normalizeProfile(savedProfile, data.user), anonymous: true };
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { nickname, name: nickname },
        emailRedirectTo: publicPageUrl("login.html"),
      },
    });
    if (error) throw new Error(authErrorMessage(error, "err_register"));
    if (!data.user) throw new Error(NarduApp.t("err_register"));
    if (!data.session) {
      return { user: normalizeProfile({}, data.user), emailSent: true, pendingConfirmation: true };
    }

    const profile = {
      id: data.user.id,
      nickname,
      email,
      rating: 1000,
      tier: "Bronze",
      rating_eligible: true,
      last_seen_at: new Date().toISOString(),
    };
    const { data: savedProfile, error: profileError } = await supabase
      .from("profiles")
      .upsert(profile, { onConflict: "id" })
      .select("id,nickname,email,rating,tier,rating_eligible")
      .single();
    if (profileError) throw new Error(authErrorMessage(profileError, "err_register"));
    return { user: normalizeProfile(savedProfile, data.user), emailSent: Boolean(!data.session) };
  }

  async function login({ identifier, password }) {
    const supabaseResult = await signInSupabase({ identifier, password });
    if (supabaseResult) return supabaseResult;
    return apiJson("/api/login", {
      method: "POST",
      body: JSON.stringify({ identifier, password }),
    }, "err_auth");
  }

  async function register({ nickname, email, password }) {
    const supabaseResult = await signUpSupabase({ nickname, email, password });
    if (supabaseResult) return supabaseResult;
    const fallbackEmail = email || `${String(nickname || "player").toLowerCase().replace(/[^a-z0-9._-]+/g, "_")}@local.nardy`;
    const fallbackPassword = password || `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return apiJson("/api/register", {
      method: "POST",
      body: JSON.stringify({ nickname, email: fallbackEmail, password: fallbackPassword }),
    }, "err_register");
  }

  async function requestPasswordRecovery(email) {
    if (window.NarduSupabase?.configured?.()) {
      const supabase = await window.NarduSupabase.client();
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: publicPageUrl("login.html"),
      });
      if (error) throw new Error(authErrorMessage(error));
      return { ok: true, message: NarduApp.t("msg_recovery_code_sent"), supabaseLink: true };
    }
    return apiJson("/api/password-recovery/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    }, "err_auth");
  }

  async function handleAuthRedirect() {
    if (!window.NarduSupabase?.configured?.()) return null;
    const supabase = await window.NarduSupabase.client();
    const url = new URL(location.href);
    const hasHashSession = /(?:^|&)access_token=/.test(url.hash.replace(/^#/, ""));
    const code = url.searchParams.get("code");
    if (!hasHashSession && !code) return null;

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw new Error(authErrorMessage(error));
      url.searchParams.delete("code");
      history.replaceState(null, "", url.pathname + (url.search ? `?${url.searchParams.toString()}` : "") + url.hash);
    }

    let { data, error } = await supabase.auth.getSession();
    if (error) throw new Error(authErrorMessage(error));
    if (!data.session?.user && hasHashSession) {
      await new Promise(resolve => setTimeout(resolve, 500));
      ({ data, error } = await supabase.auth.getSession());
      if (error) throw new Error(authErrorMessage(error));
    }
    if (!data.session?.user) return null;
    if (hasHashSession) history.replaceState(null, "", location.pathname + location.search);
    return { user: await profileForAuthUser(supabase, data.session.user), authRedirect: true };
  }

  window.NarduAuth = {
    handleAuthRedirect,
    login,
    register,
    requestPasswordRecovery,
  };
})();
