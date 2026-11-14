import { AuthClient } from '@supabase/auth-js';

const env = window.NARDU_ENV || {};
const HEARTBEAT_MS = 30_000;
const RETRY_MS = 5_000;

function readStored(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

async function startPresence() {
  const initialUser = readStored('narduh-user');
  if (!initialUser?.id || !env.supabaseUrl || !env.supabaseAnonKey) return;

  const base = new URL(env.supabaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return;
  const api = base.href.replace(/\/+$/, '');
  const heartbeatUrl = `${api}/rest/v1/rpc/touch_lobby_presence`;
  const tokenUrl = `${api}/auth/v1/token?grant_type=refresh_token`;
  const storageKey = `sb-${base.hostname.split('.')[0]}-auth-token`;
  const apikey = env.supabaseAnonKey;
  let auth;
  let timer;
  let updating = false;

  async function boundedFetch(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RETRY_MS);
    try {
      const response = await fetch(url, {
        ...options, signal: controller.signal, credentials: 'omit',
        redirect: 'error', referrerPolicy: 'no-referrer',
      });
      await response.clone().arrayBuffer();
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function updatePresence() {
    const user = readStored('narduh-user');
    if (!user?.id || user.id !== initialUser.id || user.guest !== initialUser.guest) return null;

    const headers = { apikey, 'Content-Type': 'application/json' };
    if (user.guest === true) {
      const credential = readStored('narduh-guest-credential-v1');
      if (Number(credential?.version) !== 1 || credential.guestId !== user.id
        || !/^guest:sha256:[a-f0-9]{64}$/.test(user.id)
        || !/^gproof:[a-f0-9]{64}$/.test(credential.proof)) return null;
      headers['X-Guest-Id'] = user.id;
      headers['X-Guest-Proof'] = credential.proof;
    } else {
      if (readStored(storageKey)?.user?.id !== user.id) return null;
      auth ??= new AuthClient({
        url: `${api}/auth/v1`, headers: { apikey }, storageKey, storage: localStorage,
        autoRefreshToken: false, detectSessionInUrl: false, skipAutoInitialize: true,
        // getSession can refresh existing credentials. The roll data and URL
        // never enter requests from this client.
        fetch(url, options) {
          if (url !== tokenUrl || options?.method !== 'POST') throw new Error('Unexpected presence auth request');
          return boundedFetch(url, options);
        },
      });
      const { data, error } = await auth.getSession();
      if (error) throw error;
      if (data?.session?.user?.id !== user.id || !data.session.access_token) return null;
      if (readStored('narduh-user')?.id !== user.id) return null;
      headers.Authorization = `Bearer ${data.session.access_token}`;
    }

    const response = await boundedFetch(heartbeatUrl, { method: 'POST', headers, body: '{}' });
    return response.ok && await response.json() === true;
  }

  async function heartbeat() {
    if (document.hidden || updating) return;
    clearTimeout(timer);
    updating = true;
    let next = RETRY_MS;
    try {
      const result = await updatePresence();
      if (result !== false) next = HEARTBEAT_MS;
    } catch {
      // Verification stays available during a presence or session outage.
    } finally {
      updating = false;
      timer = setTimeout(heartbeat, next);
    }
  }

  window.addEventListener('pageshow', heartbeat);
  window.addEventListener('online', heartbeat);
  document.addEventListener('visibilitychange', heartbeat);
  await heartbeat();
}

void startPresence().catch(() => {});
