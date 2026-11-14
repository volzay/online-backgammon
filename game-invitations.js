(function () {
  const REFRESH_MS = 10000;
  const EMPTY = { incoming: [], outgoing: [] };
  let snapshot = EMPTY;
  let lastUserId = null;
  let pending = false;
  let guestSessionCheck;
  let notice;

  function currentPlayer() {
    return window.NARDU_ENTRY_BLOCKED ? null : window.NarduApp?.getUser?.();
  }

  async function rpc(name, args) {
    const player = currentPlayer();
    if (!player?.id || !window.NarduSupabase?.configured?.()) throw new Error('Game invitations unavailable');
    const client = await window.NarduSupabase.client();
    if (player.guest && client.auth?.getSession) {
      if (!guestSessionCheck) {
        guestSessionCheck = (async () => {
          const { data, error } = await client.auth.getSession();
          if (error) throw error;
          if (data?.session) {
            const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
            if (signOutError) throw signOutError;
          }
        })().finally(() => { guestSessionCheck = null; });
      }
      await guestSessionCheck;
    }
    if (currentPlayer()?.id !== player.id) throw new Error('Player changed');
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }

  function paintNotice() {
    if (document.getElementById('game-invitations')) return;
    if (!snapshot.incoming.length) {
      if (notice) notice.hidden = true;
      return;
    }
    if (!notice) {
      notice = document.createElement('a');
      notice.className = 'game-invitations-notice';
      notice.href = 'index.html#game-invitations';
      document.body.append(notice);
    }
    notice.textContent = window.NarduApp.t('game_invitation_notice');
    notice.hidden = false;
  }

  function publish(data) {
    snapshot = data;
    paintNotice();
    window.dispatchEvent(new CustomEvent('nardu:game-invitations', { detail: snapshot }));
  }

  async function refresh() {
    if (pending || document.hidden) return;
    const player = currentPlayer();
    if (lastUserId !== player?.id) {
      lastUserId = player?.id;
      publish(EMPTY);
    }
    if (!player?.id || !window.NarduSupabase?.configured?.()) return;
    pending = true;
    try {
      const data = await rpc('list_lobby_game_invitations');
      if (currentPlayer()?.id === player.id) publish({
        incoming: Array.isArray(data?.incoming) ? data.incoming : [],
        outgoing: Array.isArray(data?.outgoing) ? data.outgoing : [],
      });
    } catch {
      // A failed poll cannot dismiss an invitation that was already displayed.
    } finally {
      pending = false;
    }
  }

  window.NarduGameInvitations = {
    listTargets: () => rpc('list_lobby_invite_targets'),
    send: (target, variant) => rpc('send_lobby_game_invitation', { p_target: target, p_variant: variant }),
    answer: (id, accept) => rpc('answer_lobby_game_invitation', { p_invitation_id: id, p_accept: accept }),
    refresh,
  };
  function start() {
    window.addEventListener('pageshow', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('nardu:langchange', paintNotice);
    document.addEventListener('visibilitychange', refresh);
    setInterval(refresh, REFRESH_MS);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
