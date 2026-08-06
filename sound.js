/* ───────────────────────────────────────────────────────
   sound.js — Web Audio synthesized sound effects.
   No audio files — everything is generated on the fly.
   Exposes: window.NarduSound
   ─────────────────────────────────────────────────────── */
window.NarduSound = (function () {
  let ctx = null;
  let unlocked = false;

  function getCtx() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { ctx = null; }
    }
    /* iOS / Chrome autoplay policies — must resume on first interaction */
    if (ctx && ctx.state === 'suspended') ctx.resume()?.catch?.(() => {});
    return ctx;
  }

  function isOn() { return localStorage.getItem('narduh-sound') !== '0'; }
  function volume() {
    const v = parseInt(localStorage.getItem('narduh-vol') || '70', 10);
    return Math.max(0, Math.min(1, v / 100));
  }

  function tone(freq, dur, type = 'sine', vol = 0.18) {
    if (!isOn()) return;
    const c = getCtx(); if (!c) return;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol * volume(), c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    osc.connect(g).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + dur);
  }

  function noise(dur = 0.12, vol = 0.10) {
    if (!isOn()) return;
    const c = getCtx(); if (!c) return;
    const sz = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, sz, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < sz; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / sz);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = vol * volume();
    const filt = c.createBiquadFilter();
    filt.type = 'bandpass'; filt.frequency.value = 1200; filt.Q.value = 1.2;
    src.connect(filt).connect(g).connect(c.destination);
    src.start();
  }

  function unlockTick(c) {
    if (!c || unlocked || !isOn()) return;
    try {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.frequency.value = 24;
      g.gain.value = 0.0001;
      osc.connect(g).connect(c.destination);
      osc.start(c.currentTime);
      osc.stop(c.currentTime + 0.025);
      unlocked = c.state === 'running';
    } catch {
      unlocked = false;
    }
  }

  function prime() {
    const c = getCtx();
    if (!c) return;
    if (c.state === 'running') {
      unlockTick(c);
      unlocked = true;
      return;
    }
    const resume = c.resume?.();
    if (resume?.then) {
      resume.then(() => unlockTick(c)).catch(() => {});
    }
  }

  function bindUnlock() {
    if (typeof window === 'undefined') return;
    const unlock = () => prime();
    window.addEventListener('pointerdown', unlock, { capture: true, once: true });
    window.addEventListener('mousedown', unlock, { capture: true, once: true });
    window.addEventListener('touchstart', unlock, { capture: true, once: true, passive: true });
    window.addEventListener('click', unlock, { capture: true, once: true });
    window.addEventListener('keydown', unlock, { capture: true, once: true });
  }

  bindUnlock();

  return {
    /* dice tumble: 3 quick clacks */
    dice() {
      prime();
      noise(0.10, 0.18);
      setTimeout(() => noise(0.08, 0.14), 70);
      setTimeout(() => noise(0.07, 0.10), 140);
    },
    /* single die knock against the wooden board or rail */
    diceHit(intensity = 0.5) {
      prime();
      const hit = Math.max(0.18, Math.min(1, intensity));
      noise(0.028, 0.09 * hit);
      tone(155 + Math.random() * 45, 0.035, 'triangle', 0.07 * hit);
    },
    /* wooden checker landing */
    move() {
      prime();
      tone(220, 0.05, 'triangle', 0.10);
      setTimeout(() => tone(140, 0.10, 'sine', 0.16), 30);
    },
    /* checker dropping into the bear-off tray */
    bearOff() {
      prime();
      noise(0.035, 0.06);
      tone(190, 0.045, 'triangle', 0.08);
      setTimeout(() => tone(120, 0.07, 'sine', 0.08), 28);
    },
    /* selection click */
    click() {
      prime();
      tone(880, 0.025, 'square', 0.05);
    },
    /* victory arpeggio */
    win() {
      prime();
      [392, 523, 659, 784, 988].forEach((n, i) =>
        setTimeout(() => tone(n, 0.22, 'sine', 0.18), i * 110));
    },
    /* defeat */
    lose() {
      prime();
      [392, 311, 247].forEach((n, i) =>
        setTimeout(() => tone(n, 0.30, 'triangle', 0.14), i * 160));
    },
    /* used by buttons on first interaction to unlock autoplay */
    prime,
  };
})();
