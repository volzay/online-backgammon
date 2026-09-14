(function () {
  const AUTH_FETCH_TIMEOUT_MS = 6000;
  let recoveryAuthorized = false;
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

  async function boundedAuthFetch(input, init = {}) {
    if (typeof AbortController !== "function") return fetch(input, init);

    const controller = new AbortController();
    const externalSignal = init?.signal;
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
    }, AUTH_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (typeof response?.clone === "function") {
        const bodyProbe = response.clone();
        if (typeof bodyProbe?.arrayBuffer === "function") await bodyProbe.arrayBuffer();
      }
      return response;
    } catch (error) {
      if (!timedOut) throw error;
      const timeoutError = new Error("Authentication request timed out.");
      timeoutError.name = "TimeoutError";
      timeoutError.code = "AUTH_FETCH_TIMEOUT";
      timeoutError.cause = error;
      throw timeoutError;
    } finally {
      if (timer !== null) clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", forwardExternalAbort);
    }
  }

  async function apiJson(url, options = {}, errorKey = "err_auth") {
    const response = await boundedAuthFetch(url, {
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

  function isTransientAuthError(error) {
    const code = String(error?.code || error?.cause?.code || "").toUpperCase();
    if ([
      "SUPABASE_FETCH_TIMEOUT",
      "AUTH_FETCH_TIMEOUT",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENETDOWN",
      "ENETRESET",
      "ENETUNREACH",
    ].includes(code)) return true;
    const name = String(error?.name || error?.cause?.name || "");
    if (/^TimeoutError$/i.test(name)) return true;
    const message = String(error?.message || error || "");
    return /failed to fetch|network(?:error| request failed)|load failed|fetch failed|request timed out|timed out|timeout|could not reach the server|не удалось связаться с сервером/i.test(message);
  }

  async function retryTransientStage(run) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        lastError = error;
        if (attempt > 0 || !isTransientAuthError(error)) throw error;
      }
    }
    throw lastError;
  }

  function authErrorMessage(error, fallbackKey = "err_auth") {
    const message = String(error?.message || error || "");
    const localize = (ru, en) => NarduApp.currentLang?.() === "en" ? en : ru;
    const alreadyNormalized = /^(?:Не удалось связаться с сервером|Could not reach the server|Вход по никнейму ещё не включён|Nickname sign-in is not enabled|Отправка писем временно ограничена|Email delivery is temporarily limited|Сервис временно ограничил запросы|The service has temporarily limited requests|Ссылка восстановления недействительна|This recovery link is invalid|Сессия истекла|Your session expired|Проверьте email|Check the email|Incorrect nickname|Enter a valid email|Password must be at least|Nickname must|Nickname may|This nickname|This account|An account is already)/;
    if (alreadyNormalized.test(message)) return message;
    if (/не удалось загрузить supabase sdk|could not load supabase sdk/i.test(message)) {
      return localize(
        "Не удалось загрузить модуль входа. Проверьте интернет, блокировщик рекламы или попробуйте другой браузер.",
        "Could not load the sign-in module. Check your connection, ad blocker, or try another browser.",
      );
    }
    if (isTransientAuthError(error)) {
      return localize(
        "Не удалось связаться с сервером. Проверьте интернет и повторите попытку.",
        "Could not reach the server. Check your connection and try again.",
      );
    }
    if (/email rate limit exceeded/i.test(message)) {
      return localize(
        "Отправка писем временно ограничена. Попробуйте позже или войдите, если аккаунт уже создан.",
        "Email delivery is temporarily limited. Try again later, or sign in if the account already exists.",
      );
    }
    if (/quota has been exceeded|over quota|rate limit/i.test(message)) {
      return localize(
        "Сервис временно ограничил запросы. Подождите несколько минут и повторите попытку.",
        "The service has temporarily limited requests. Wait a few minutes and try again.",
      );
    }
    if (/already registered|already been registered|user already registered/i.test(message)) {
      return localize(
        "На эту электронную почту уже зарегистрирован аккаунт.",
        "An account is already registered with this email address.",
      );
    }
    if (/nickname.*(?:3\s*(?:to|and|–|-)\s*20|between.*3.*20)/i.test(message)) {
      return localize(
        "Никнейм должен быть от 3 до 20 символов.",
        "Nickname must be 3 to 20 characters long.",
      );
    }
    if (/nickname.*(?:may contain|letters.*numbers)|Никнейм может содержать/i.test(message)) {
      return localize(
        "Никнейм может содержать буквы, цифры, пробел, дефис и подчёркивание.",
        "Nickname may contain letters, numbers, spaces, hyphens, and underscores.",
      );
    }
    if (/duplicate key|profiles_nickname|nickname.*(?:taken|occupied|already)|никнейм.*занят/i.test(message)) {
      return localize("Такой никнейм уже занят.", "This nickname is already taken.");
    }
    if (/invalid email/i.test(message)) {
      return localize("Введите корректный email.", "Enter a valid email address.");
    }
    if (/invalid login credentials|invalid credentials|email not confirmed/i.test(message)) {
      return localize("Неверный никнейм/email или пароль.", "Incorrect nickname/email or password.");
    }
    if (/password should be at least|weak password/i.test(message)) {
      return localize("Пароль должен быть не короче 6 символов.", "Password must be at least 6 characters long.");
    }
    if (/otp expired|token.*expired|invalid.*token|recovery.*expired/i.test(message)) {
      return localize(
        "Ссылка восстановления недействительна или устарела. Запросите новую ссылку.",
        "This recovery link is invalid or expired. Request a new link.",
      );
    }
    if (/auth session missing|session.*(?:missing|expired)/i.test(message)) {
      return fallbackKey === "err_recovery"
        ? localize(
            "Ссылка восстановления недействительна или устарела. Запросите новую ссылку.",
            "This recovery link is invalid or expired. Request a new link.",
          )
        : localize("Сессия истекла. Войдите снова.", "Your session expired. Sign in again.");
    }
    const translated = NarduApp.translateServerMessage?.(message);
    const safeValidation = /^(Никнейм|Пароль|Введите|Такой|На эту|Этот|Неверный|Вход по никнейму|Если email|Код восстановления|Проверьте email|Nickname|Password|Enter|Nickname sign-in|This nickname|This account|An account|Incorrect|If the account|The recovery code|Check the email)/;
    if (translated && safeValidation.test(message)) return translated;
    return NarduApp.t(fallbackKey);
  }

  function publicPageUrl(page) {
    const cfg = window.NarduSupabase?.config?.() || {};
    const configuredBase = String(cfg.siteBaseUrl || "").replace(/\/+$/, "");
    if (configuredBase) return `${configuredBase}/${page}`;
    return new URL(page, location.href).href;
  }

  function postAuthDestination() {
    const compact = String(new URLSearchParams(location.search).get("join") || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    return compact.length === 8
      ? `index.html?join=${encodeURIComponent(`${compact.slice(0, 4)}-${compact.slice(4)}`)}`
      : "index.html";
  }

  function authCallbackDestination() {
    const destination = postAuthDestination();
    const query = destination.includes("?") ? destination.slice(destination.indexOf("?")) : "";
    return `login.html${query}`;
  }

  function recoveryCallbackDestination() {
    const destination = new URL(postAuthDestination(), location.href);
    const params = new URLSearchParams({ recovery: "1" });
    const join = destination.searchParams.get("join");
    if (join) params.set("join", join);
    return `login.html?${params.toString()}`;
  }

  function preservePostAuthLinks() {
    const destination = postAuthDestination();
    const query = destination.includes("?") ? destination.slice(destination.indexOf("?")) : "";
    document.querySelectorAll('a[href="login.html"], a[href="register.html"], a[href="rules.html"]').forEach(link => {
      const target = link.getAttribute("href").split("?")[0];
      link.setAttribute("href", `${target}${query}`);
    });
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
    let email = String(identifier || "").trim();
    if (!email.includes("@")) {
      const nicknameEmail = await retryTransientStage(async () => {
        const { data, error } = await supabase
          .rpc("nickname_auth_email", { p_identifier: email });
        if (error) {
          if (isTransientAuthError(error)) throw error;
          if (/function .*nickname_auth_email|could not find the function/i.test(error.message || "")) {
            throw new Error(NarduApp.currentLang?.() === "en"
              ? "Nickname sign-in is not enabled in Supabase. Run the updated supabase/schema.sql."
              : "Вход по никнейму ещё не включён в Supabase. Выполните обновлённый supabase/schema.sql.");
          }
          throw new Error(authErrorMessage(error));
        }
        return data;
      });
      if (!nicknameEmail) throw new Error("Неверный никнейм/email или пароль.");
      email = nicknameEmail;
    }
    const { data } = await retryTransientStage(async () => {
      const result = await supabase.auth.signInWithPassword({ email, password });
      if (result.error) {
        if (isTransientAuthError(result.error)) throw result.error;
        throw new Error(authErrorMessage(result.error));
      }
      return result;
    });
    if (!data.user) throw new Error(NarduApp.t("err_auth"));
    return { user: await retryTransientStage(() => profileForAuthUser(supabase, data.user)) };
  }

  async function signUpSupabase({ nickname, email, password }) {
    if (!window.NarduSupabase?.configured?.()) return null;
    const supabase = await window.NarduSupabase.client();
    const nicknameOnly = !String(email || "").trim();
    if (nicknameOnly) {
      const { data: created, error: createError } = await supabase
        .rpc("register_nickname_user", { p_nickname: nickname, p_password: password });
      if (createError) {
        if (/function .*register_nickname_user|Could not find the function/i.test(createError.message || "")) {
          throw new Error("Регистрация по никнейму ещё не включена в Supabase. Выполните обновлённый supabase/schema.sql.");
        }
        throw new Error(authErrorMessage(createError, "err_register"));
      }
      const profile = Array.isArray(created) ? created[0] : created;
      if (!profile?.auth_email) throw new Error(NarduApp.t("err_register"));
      const { data: sessionData, error: signInError } = await supabase.auth.signInWithPassword({
        email: profile.auth_email,
        password,
      });
      if (signInError) throw new Error(authErrorMessage(signInError, "err_register"));
      if (!sessionData.user) throw new Error(NarduApp.t("err_register"));
      return { user: normalizeProfile(profile, sessionData.user), nicknameOnly: true };
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { nickname, name: nickname },
        emailRedirectTo: publicPageUrl(authCallbackDestination()),
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
    return retryTransientStage(() => apiJson("/api/login", {
      method: "POST",
      body: JSON.stringify({ identifier, password }),
    }, "err_auth"));
  }

  async function register({ nickname, email, password }) {
    const supabaseResult = await signUpSupabase({ nickname, email, password });
    if (supabaseResult) return supabaseResult;
    const emailStem = String(nickname || "player").toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "player";
    const emailNonce = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const fallbackEmail = email || `${emailStem}+${String(emailNonce).replace(/[^a-z0-9-]/gi, "")}@local.nardy`;
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
        redirectTo: publicPageUrl(recoveryCallbackDestination()),
      });
      if (error) throw new Error(authErrorMessage(error));
      return {
        ok: true,
        message: NarduApp.currentLang?.() === "en"
          ? "If the account exists, a password reset link has been sent to that email."
          : "Если аккаунт существует, ссылка для смены пароля отправлена на этот email.",
        supabaseLink: true,
      };
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
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const hasHashSession = hashParams.has("access_token");
    const code = url.searchParams.get("code");
    const recoveryHint = url.searchParams.get("recovery") === "1" || hashParams.get("type") === "recovery";
    const hasCallbackCredentials = hasHashSession || Boolean(code);
    const passwordRecovery = recoveryHint && hasCallbackCredentials;
    const callbackError = hashParams.get("error_description") || hashParams.get("error") || url.searchParams.get("error_description") || url.searchParams.get("error");
    if (callbackError) throw new Error(authErrorMessage(new Error(callbackError), recoveryHint ? "err_recovery" : "err_auth"));
    if (!hasCallbackCredentials) {
      if (recoveryHint) throw new Error(authErrorMessage(new Error("invalid recovery token"), "err_recovery"));
      return null;
    }

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw new Error(authErrorMessage(error));
      url.searchParams.delete("code");
      history.replaceState(null, "", url.pathname + (url.search ? `?${url.searchParams.toString()}` : "") + url.hash);
    }

    let { data, error } = await supabase.auth.getSession();
    if (error) throw new Error(authErrorMessage(error, passwordRecovery ? "err_recovery" : "err_auth"));
    if (!data.session?.user && hasHashSession) {
      await new Promise(resolve => setTimeout(resolve, 500));
      ({ data, error } = await supabase.auth.getSession());
      if (error) throw new Error(authErrorMessage(error, passwordRecovery ? "err_recovery" : "err_auth"));
    }
    if (!data.session?.user) return null;
    recoveryAuthorized = passwordRecovery;
    if (hasHashSession) history.replaceState(null, "", location.pathname + location.search);
    return {
      user: await profileForAuthUser(supabase, data.session.user),
      authRedirect: true,
      passwordRecovery,
    };
  }

  async function updateRecoveredPassword(password) {
    if (!recoveryAuthorized) {
      throw new Error(authErrorMessage(new Error("invalid recovery token"), "err_recovery"));
    }
    if (!window.NarduSupabase?.configured?.()) {
      throw new Error(NarduApp.t("err_auth"));
    }
    const supabase = await window.NarduSupabase.client();
    const { data, error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(authErrorMessage(error, "err_recovery"));
    const authUser = data?.user;
    if (!authUser) throw new Error(NarduApp.t("err_auth"));
    recoveryAuthorized = false;
    return { user: await profileForAuthUser(supabase, authUser) };
  }

  window.NarduAuth = {
    handleAuthRedirect,
    login,
    register,
    requestPasswordRecovery,
    updateRecoveredPassword,
    postAuthDestination,
    preservePostAuthLinks,
    errorMessage: authErrorMessage,
  };
})();
