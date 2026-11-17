// Plant Doctor — effets : sons (Web Audio, aucun fichier), vibrations, musique d'ambiance, lucioles.
const FX = (() => {
  const MUSIC_LEVEL = 0.5;   // volume de la musique (0 à 1) : à ajuster si besoin
  const SFX_LEVEL = 0.5;     // volume des bruitages

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v ? "1" : "0"); } catch (_) {} },
  };
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let ctx = null, musicGain = null, sfxGain = null, delay = null;
  let musicOn = store.get("pd_music", true);
  let sfxOn = store.get("pd_sfx", true);
  let started = false, ducked = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      musicGain = ctx.createGain(); musicGain.gain.value = 0; musicGain.connect(ctx.destination);
      sfxGain = ctx.createGain(); sfxGain.gain.value = SFX_LEVEL; sfxGain.connect(ctx.destination);
      delay = ctx.createDelay(1); delay.delayTime.value = 0.42;
      const fb = ctx.createGain(); fb.gain.value = 0.38;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1800;
      delay.connect(lp); lp.connect(fb); fb.connect(delay); lp.connect(musicGain);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function tone(freq, { type = "sine", start = 0, dur = 0.15, vol = 0.2, dest, attack = 0.005, slideTo = null } = {}) {
    const t0 = ctx.currentTime + start;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(dest || sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  function vibrate(p) { if (sfxOn && navigator.vibrate) { try { navigator.vibrate(p); } catch (_) {} } }

  // ---------- Bruitages ----------
  const sfx = {
    click() { if (!sfxOn || !ensure()) return; tone(740, { dur: 0.09, vol: 0.2, slideTo: 520 }); tone(1480, { type: "triangle", dur: 0.05, vol: 0.05 }); vibrate(12); },
    pop()   { if (!sfxOn || !ensure()) return; tone(520, { dur: 0.12, vol: 0.18, slideTo: 900 }); vibrate(15); },
    success() {
      if (!sfxOn || !ensure()) return;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, { type: "triangle", start: i * 0.09, dur: 0.35, vol: 0.16 }));
      vibrate([20, 40, 20]);
    },
    chime() { if (!sfxOn || !ensure()) return; tone(880, { dur: 0.4, vol: 0.12 }); tone(1320, { start: 0.1, dur: 0.5, vol: 0.08 }); vibrate(15); },
    error() { if (!sfxOn || !ensure()) return; tone(220, { type: "triangle", dur: 0.28, vol: 0.18, slideTo: 150 }); vibrate([60, 40, 60]); },
  };

  // ---------- Musique d'ambiance (générée, pas de fichier audio) ----------
  const CHORDS = [
    [110.0, 164.81, 261.63, 392.0],     // La mineur
    [87.31, 130.81, 220.0, 329.63],     // Fa
    [130.81, 196.0, 329.63, 493.88],    // Do
    [98.0, 146.83, 246.94, 293.66],     // Sol
  ];
  const PENTA = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

  function pad(freqs, dur) {
    const t0 = ctx.currentTime;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 900;
    lp.connect(musicGain);
    freqs.forEach((f) => [-4, 4].forEach((cents) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "triangle"; o.frequency.value = f; o.detune.value = cents;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.03, t0 + 4);
      g.gain.setValueAtTime(0.03, t0 + dur - 3.5);
      g.gain.linearRampToValueAtTime(0.0001, t0 + dur + 3);
      o.connect(g); g.connect(lp);
      o.start(t0); o.stop(t0 + dur + 3.2);
    }));
  }

  function pluck() {
    const f = PENTA[Math.floor(Math.random() * PENTA.length)];
    const t0 = ctx.currentTime;
    [[1, 0.07], [2, 0.02]].forEach(([mult, vol]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f * mult;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.8);
      o.connect(g); g.connect(musicGain); g.connect(delay);
      o.start(t0); o.stop(t0 + 3);
    });
  }

  function chordLoop(i = 0) {
    if (musicOn && ctx && ctx.state === "running") pad(CHORDS[i % CHORDS.length], 12);
    setTimeout(() => chordLoop(i + 1), 12000);
  }
  function pluckLoop() {
    if (musicOn && ctx && ctx.state === "running") pluck();
    setTimeout(pluckLoop, 2500 + Math.random() * 3200);
  }

  function applyMusicLevel() {
    if (!ctx) return;
    const target = musicOn ? (ducked ? MUSIC_LEVEL * 0.22 : MUSIC_LEVEL) : 0;
    musicGain.gain.setTargetAtTime(target, ctx.currentTime, musicOn ? 1.2 : 0.3);
  }

  function startMusic() {
    if (!musicOn || !ensure()) return;
    if (!started) { started = true; chordLoop(); pluckLoop(); }
    applyMusicLevel();
  }

  // ---------- Contrôles ----------
  function syncButtons() {
    const m = document.getElementById("fx-music"), s = document.getElementById("fx-sfx");
    if (m) m.setAttribute("aria-pressed", String(musicOn));
    if (s) s.setAttribute("aria-pressed", String(sfxOn));
  }
  function toggleMusic() { musicOn = !musicOn; store.set("pd_music", musicOn); syncButtons(); musicOn ? startMusic() : applyMusicLevel(); }
  function toggleSfx() { sfxOn = !sfxOn; store.set("pd_sfx", sfxOn); syncButtons(); if (sfxOn) sfx.click(); }

  // ---------- Lucioles (décor animé) ----------
  function fireflies() {
    const box = document.querySelector(".fireflies");
    if (!box || reduceMotion) return;
    for (let i = 0; i < 18; i++) {
      const s = document.createElement("span");
      const size = 3 + Math.random() * 4;
      s.className = "firefly";
      s.style.cssText = `left:${Math.random() * 100}%;bottom:${Math.random() * 45}%;width:${size}px;height:${size}px;` +
        `--dx:${(Math.random() - 0.5) * 120}px;animation-duration:${8 + Math.random() * 9}s;animation-delay:${-Math.random() * 12}s`;
      box.appendChild(s);
    }
  }

  // ---------- Branchement ----------
  function init() {
    syncButtons();
    fireflies();

    const unlock = (e) => {
      if (e.target.closest && e.target.closest(".fx-controls")) return;
      startMusic();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    document.getElementById("fx-music")?.addEventListener("click", toggleMusic);
    document.getElementById("fx-sfx")?.addEventListener("click", toggleSfx);

    // bruitage + onde sur tout bouton / zone cliquable
    document.addEventListener("click", (e) => {
      const el = e.target.closest("button, .dropzone");
      if (el && !el.disabled && !el.closest(".fx-controls")) sfx.click();
    });
    document.addEventListener("pointerdown", (e) => {
      const b = e.target.closest(".btn");
      if (!b || b.disabled || reduceMotion) return;
      const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2;
      const w = document.createElement("span");
      w.className = "ripple";
      w.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
      b.appendChild(w);
      setTimeout(() => w.remove(), 600);
    });

    // pause quand l'onglet est caché
    document.addEventListener("visibilitychange", () => {
      if (!ctx) return;
      if (document.hidden) ctx.suspend(); else if (musicOn || sfxOn) ctx.resume();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  return { ...sfx, duck(on) { ducked = on; applyMusicLevel(); } };
})();
