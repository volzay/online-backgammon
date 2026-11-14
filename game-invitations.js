(function () {
  const REFRESH_MS = 10000;
  const EMPTY = { incoming: [], outgoing: [] };
  let snapshot = EMPTY;
  let lastUserId = null;
  let pending = false;
  let guestSessionCheck;
  let notice;
  let inbox;
  let answering = false;
  let statusKey = '';
  let statusTimer;
  let beforeAccept = () => () => true;
  const answered = new Set();
  const sounded = new Set();
  const soundKey = 'narduh-invitation-sounds';
  const activeRoomKey = 'narduh-active-room';

  function t(key) {
    return window.NarduApp.t(key);
  }

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

  function readSoundedIds() {
    try {
      const ids = JSON.parse(localStorage.getItem(soundKey) || '[]');
      if (Array.isArray(ids)) ids.forEach(id => sounded.add(id));
    } catch {
      // Sound can still be deduplicated in the current page.
    }
  }

  function notify() {
    if (document.hidden || currentPlayer()?.id !== lastUserId) return;
    readSoundedIds();
    const unheard = snapshot.incoming.map(({ id }) => id).filter(id => !sounded.has(id));
    if (!unheard.length) return;
    if (window.NarduApp.currentSound?.() !== false && window.NarduSound?.invitation?.() === false) return;
    unheard.forEach(id => sounded.add(id));
    while (sounded.size > 64) sounded.delete(sounded.values().next().value);
    try { localStorage.setItem(soundKey, JSON.stringify([...sounded])); } catch {}
  }

  function createInbox() {
    notice = document.getElementById('game-invitations');
    if (notice) return {
      rows: document.getElementById('game-invitations-list'),
      status: document.getElementById('game-invitations-status'),
    };
    notice = document.createElement('section');
    notice.className = 'game-invitations-notice';
    const heading = document.createElement('h2');
    heading.id = 'game-invitations-notice-title';
    notice.setAttribute('aria-labelledby', heading.id);
    const rows = document.createElement('div');
    rows.setAttribute('aria-live', 'polite');
    const status = document.createElement('p');
    status.className = 'game-invitations-feedback';
    status.setAttribute('role', 'status');
    notice.append(heading, rows, status);
    document.body.append(notice);
    return { heading, rows, status };
  }

  function invitationCard(id) {
    const row = document.createElement('div');
    row.className = 'game-invitation-row';
    const label = document.createElement('span');
    const actions = document.createElement('div');
    actions.className = 'game-invitation-actions';
    const buttons = [true, false].map(accept => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = accept ? 'joinbtn' : 'ghostbtn';
      button.addEventListener('click', () => respond(id, accept));
      actions.append(button);
      return button;
    });
    row.append(label, actions);
    return { row, label, buttons };
  }

  function paintNotice() {
    if (!inbox && !snapshot.incoming.length && !statusKey) return;
    inbox ||= { ...createInbox(), cards: new Map(), order: '' };
    notice.hidden = !snapshot.incoming.length && !statusKey;
    if (inbox.heading) {
      inbox.heading.textContent = t('game_invitation_notice');
      inbox.heading.hidden = !snapshot.incoming.length;
    }
    const status = statusKey ? t(statusKey) : '';
    if (inbox.status.textContent !== status) inbox.status.textContent = status;
    inbox.status.hidden = !statusKey;
    const cards = new Map(snapshot.incoming.map(({ id, nickname, variant }) => {
      const card = inbox.cards.get(id) || invitationCard(id);
      const label = `${nickname} · ${t(variant === 'short' ? 'short_backgammon' : 'long_backgammon')}`;
      if (card.label.textContent !== label) card.label.textContent = label;
      for (const [index, key] of ['game_invitation_accept', 'game_invitation_decline'].entries()) {
        const button = card.buttons[index];
        const text = t(key);
        if (button.textContent !== text) button.textContent = text;
        button.disabled = answering;
      }
      return [id, card];
    }));
    const order = [...cards.keys()].join(',');
    if (inbox.order !== order) inbox.rows.replaceChildren(...[...cards.values()].map(({ row }) => row));
    inbox.cards = cards;
    inbox.order = order;
  }

  function publish(data) {
    snapshot = data;
    paintNotice();
    notify();
    window.dispatchEvent(new CustomEvent('nardu:game-invitations', { detail: snapshot }));
  }

  function forgetInvitation(id) {
    answered.add(id);
    while (answered.size > 40) answered.delete(answered.values().next().value);
    publish({ ...snapshot, incoming: snapshot.incoming.filter(invite => invite.id !== id) });
  }

  function showStatus(key) {
    clearTimeout(statusTimer);
    statusKey = key;
    paintNotice();
    if (key) statusTimer = setTimeout(() => showStatus(''), 8000);
  }

  async function enterRoom(code, variant, playerId, isCurrent) {
    if (!code || !isCurrent()) return false;
    const controller = new AbortController();
    let timeout;
    try {
      const { room } = await Promise.race([
        window.NarduRooms.getRoom(code, { signal: controller.signal }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Invitation room load timed out'));
          }, 6000);
        }),
      ]);
      if (!isCurrent() || currentPlayer()?.id !== playerId || room?.code !== code
        || room.status !== 'joined' || room.guestUserId !== playerId || room.variant !== variant) return false;
      const url = new URL('room.html', location.href);
      url.search = new URLSearchParams({
        mode: 'remote', room: code, color: 'dark', guest: '1',
        opp: room.hostName || t('opponent'), oppR: String(room.hostRating || 0),
        variant, opponent: 'player', access: room.access || 'closed',
      });
      window.NarduApp.safeStorageSet(activeRoomKey, JSON.stringify({ ...room, role: 'guest' }));
      location.href = url.href;
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function respond(id, accept) {
    const invitation = snapshot.incoming.find(item => item.id === id);
    const playerId = currentPlayer()?.id;
    if (answering || !invitation || !playerId || playerId !== lastUserId) return;
    answering = true;
    showStatus('');
    try {
      const isCurrent = accept ? await beforeAccept() : () => true;
      if (!isCurrent?.() || currentPlayer()?.id !== playerId) return;
      const result = await answer(id, accept);
      if (currentPlayer()?.id !== playerId) return;
      forgetInvitation(id);
      if (accept && isCurrent() && !await enterRoom(result?.room_code, invitation.variant, playerId, isCurrent)) {
        showStatus('game_invitation_room_failed');
      }
    } catch (error) {
      if (currentPlayer()?.id !== playerId) return;
      let key = 'game_invitation_answer_failed';
      if (error?.message === 'lobby_invite_unavailable') {
        key = 'game_invitation_unavailable';
        forgetInvitation(id);
      } else if (error?.message === 'lobby_invite_player_busy' || error?.code === '23505') {
        key = 'game_invitation_player_busy';
      }
      showStatus(key);
    } finally {
      answering = false;
      paintNotice();
      refresh();
    }
  }

  async function refresh() {
    if (pending || document.hidden) return;
    const player = currentPlayer();
    if (lastUserId !== player?.id) {
      lastUserId = player?.id;
      answered.clear();
      showStatus('');
      publish(EMPTY);
    }
    if (!player?.id || !window.NarduSupabase?.configured?.()) return;
    pending = true;
    try {
      const data = await rpc('list_lobby_game_invitations');
      if (currentPlayer()?.id === player.id) publish({
        incoming: Array.isArray(data?.incoming) ? data.incoming.filter(item => !answered.has(item.id)) : [],
        outgoing: Array.isArray(data?.outgoing) ? data.outgoing : [],
      });
    } catch {
      // A failed poll cannot dismiss an invitation that was already displayed.
    } finally {
      pending = false;
    }
  }

  const answer = (id, accept) => rpc('answer_lobby_game_invitation', { p_invitation_id: id, p_accept: accept });
  window.NarduGameInvitations = {
    listTargets: () => rpc('list_lobby_invite_targets'),
    send: (target, variant) => rpc('send_lobby_game_invitation', { p_target: target, p_variant: variant }),
    answer,
    isAnswering: () => answering,
    setBeforeAccept: callback => { beforeAccept = callback; },
    refresh,
  };
  function start() {
    window.addEventListener('pageshow', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('nardu:langchange', paintNotice);
    window.addEventListener('nardu:audio-ready', notify);
    document.addEventListener('visibilitychange', refresh);
    setInterval(refresh, REFRESH_MS);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
