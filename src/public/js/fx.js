/* --- public/js/fx.js ---
(() => {
  // Flag: FX module owns shooting stars
  try { window.__syngestFxManaged = true; } catch {}

  'use strict';

  const FX_KEY = 'syngestFxDisabled';

  function fxEnabled() {
    try { return localStorage.getItem(FX_KEY) !== '1'; } catch { return true; }
  }

  function setFxEnabled(on) {
    try { localStorage.setItem(FX_KEY, on ? '0' : '1'); } catch {}
    applyFxClass();
    syncToggleLabel();
    if (on) {
      ensureConstellations();
    } else {
      clearTransientFx();
    }
  }

  function applyFxClass() {
    document.body.classList.toggle('fx-off', !fxEnabled());
  }

  function syncToggleLabel() {
    const btn = document.getElementById('fxToggleBtn');
    if (!btn) return;
    btn.textContent = fxEnabled() ? 'FX: ON' : 'FX: OFF';
  }

  function bindToggle() {
    const btn = document.getElementById('fxToggleBtn');
    if (!btn) return;
    btn.addEventListener('click', () => setFxEnabled(!document.body.classList.contains('fx-off')));
    syncToggleLabel();
  }

  /* -------------------- constellations -------------------- */

  function rand(a, b) { return a + Math.random() * (b - a); }
  function rint(a, b) { return Math.floor(rand(a, b + 1)); }

  function constellationSVG(w, h) {
    const clusters = rint(6, 10);
    const stars = [];
    const lines = [];

    for (let c = 0; c < clusters; c++) {
      const cx = rand(w * 0.12, w * 0.88);
      const cy = rand(h * 0.10, h * 0.90);
      const count = rint(5, 10);
      const points = [];

      for (let i = 0; i < count; i++) {
        const x = cx + rand(-w * 0.08, w * 0.08);
        const y = cy + rand(-h * 0.08, h * 0.08);
        const r = rand(0.9, 2.4);
        points.push({ x, y });
        stars.push(`<circle class="cStar" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" />`);
      }

      // Connect a sparse chain (keeps it readable)
      points.sort((a, b) => a.x - b.x);
      for (let i = 0; i < points.length - 1; i++) {
        if (Math.random() < 0.65) {
          const a = points[i];
          const b = points[i + 1];
          lines.push(`<line class="cLine" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" />`);
        }
      }
    }

    return `
<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="1.6" result="b" />
      <feMerge>
        <feMergeNode in="b" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <g filter="url(#glow)">
    ${lines.join('')}
    ${stars.join('')}
  </g>
</svg>`;
  }

  function ensureConstellations() {
    const host = document.querySelector('.constellations');
    if (!host) return;
    if (!fxEnabled()) { host.innerHTML = ''; return; }

    // Rebuild only if empty (static grouped stars)
    if (host.innerHTML && host.innerHTML.trim().length > 0) return;

    const w = Math.max(800, window.innerWidth || 800);
    const h = Math.max(600, window.innerHeight || 600);
    host.innerHTML = constellationSVG(w, h);
  }

  /* -------------------- shooting stars + comets -------------------- */

  function getMode() {
    const b = document.body;
    if (b.classList.contains('state-ingesting')) return 'ingesting';
    if (b.classList.contains('state-grazing')) return 'grazing';
    return 'idle';
  }

  function pickColor(mode, major = false) {
    if (mode === 'ingesting') return 'rgba(255, 140, 40, .98)';
    if (mode === 'idle') return major ? 'rgba(230, 250, 255, .98)' : 'rgba(210, 245, 255, .95)';

    // grazing: harmonious palette (avoid harsh greens)
    const hues = [190, 208, 238, 262, 295, 18, 34];
    const h = hues[Math.floor(Math.random() * hues.length)];
    const s = major ? 98 : 92 + Math.floor(Math.random() * 6);
    const l = major ? 74 : 66 + Math.floor(Math.random() * 10);
    return `hsl(${h} ${s}% ${l}%)`;
  }

  function edgePoint() {
    const edge = rint(0, 3);
    if (edge === 0) return { x: -10, y: rand(-10, 110) };    // left
    if (edge === 1) return { x: 110, y: rand(-10, 110) };    // right
    if (edge === 2) return { x: rand(-10, 110), y: -10 };    // top
    return { x: rand(-10, 110), y: 110 };                    // bottom
  }

  function spawnStar({ major = false, forceMode = null } = {}) {
    if (!fxEnabled()) return;

    const root = document.querySelector('.shootingStars');
    if (!root) return;

    const mode = forceMode || getMode();
    const a = edgePoint();
    let b = edgePoint();
    // Ensure the end isn't too close to the start
    let guard = 0;
    while (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 80 && guard++ < 8) b = edgePoint();
    const dx = (b.x - a.x);
    const dy = (b.y - a.y);
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;

    const dist = Math.hypot(dx, dy);
    const speed = mode === 'grazing' ? rand(0.85, 1.35) : mode === 'ingesting' ? rand(0.95, 1.55) : rand(1.4, 2.6);
    const dur = (dist / 120) * speed;

    const size = major ? rand(5.0, 7.0) : rand(1.8, 3.4);
    const trail = major ? rand(520, 760) : (mode === 'grazing' ? rand(170, 320) : rand(140, 290));
    const thick = major ? rand(3.0, 4.6) : rand(1.6, 2.4);
    const arc = major ? rand(-55, 55) : rand(-42, 42);

    const star = document.createElement('div');
    star.className = major ? 'shootingStar majorComet' : 'shootingStar';

    star.style.setProperty('--x0', `${a.x}vw`);
    star.style.setProperty('--y0', `${a.y}vh`);
    star.style.setProperty('--x1', `${b.x}vw`);
    star.style.setProperty('--y1', `${b.y}vh`);
    star.style.setProperty('--ang', `${ang}deg`);
    star.style.setProperty('--dur', `${dur.toFixed(2)}s`);
    star.style.setProperty('--trail', `${Math.round(trail)}px`);
    star.style.setProperty('--thick', `${thick.toFixed(1)}px`);
    star.style.setProperty('--size', `${size.toFixed(1)}px`);
    star.style.setProperty('--star-color', pickColor(mode, major));

    root.appendChild(star);

    const killMs = Math.ceil((dur + 0.25) * 1000);
    window.setTimeout(() => star.remove(), killMs);

    if (major) {
      document.body.classList.add('shake');
      window.setTimeout(() => document.body.classList.remove('shake'), 650);
    }
  }

  function clearTransientFx() {
    const root = document.querySelector('.shootingStars');
    if (root) root.innerHTML = '';
    const host = document.querySelector('.constellations');
    if (host) host.innerHTML = '';
    document.body.classList.remove('shake');
  }

  function startStarLoop() {
    let t = null;
    const step = () => {
      if (!fxEnabled()) {
        t = window.setTimeout(step, 1200);
        return;
      }

      const mode = getMode();
      const nextMs = mode === 'grazing'
        ? (220 + Math.random() * 520)
        : mode === 'ingesting'
          ? (500 + Math.random() * 850)
          : (1800 + Math.random() * 4200);

      const chance = mode === 'idle' ? 0.60 : 1.0;
      if (Math.random() < chance) spawnStar({ major: false });

      t = window.setTimeout(step, nextMs);
    };

    t = window.setTimeout(step, 900);
    return () => { if (t) window.clearTimeout(t); };
  }

  function startCometLoop() {
    let t = null;
    const step = () => {
      if (!fxEnabled()) {
        t = window.setTimeout(step, 2500);
        return;
      }

      const mode = getMode();
      const base = mode === 'grazing' ? rand(12000, 22000) : rand(24000, 52000);
      t = window.setTimeout(() => {
        // idle: rare, grazing: occasional “major event”, ingest: warm-only
        const chance = mode === 'grazing' ? 0.45 : mode === 'ingesting' ? 0.25 : 0.08;
        if (Math.random() < chance) spawnStar({ major: true });
        step();
      }, base);
    };

    t = window.setTimeout(step, 12000);
    return () => { if (t) window.clearTimeout(t); };
  }

  function initFx() {
    applyFxClass();
    bindToggle();
    ensureConstellations();

    // rebuild constellations on resize (debounced)
    let rz = null;
    window.addEventListener('resize', () => {
      if (rz) window.clearTimeout(rz);
      rz = window.setTimeout(() => {
        const host = document.querySelector('.constellations');
        if (host) host.innerHTML = '';
        ensureConstellations();
      }, 250);
    });

    if (fxStopStars) fxStopStars();
    if (fxStopComets) fxStopComets();
    fxStopStars = startStarLoop();
    fxStopComets = startCometLoop();

    // Trigger “major event” comet at the start of a new graze run.
    // We don't rely on run_id; we watch the UI state class transition.
    let lastMode = getMode();
    const obs = new MutationObserver(() => {
      const now = getMode();
      if (now !== lastMode) {
        if (now === 'grazing') {
          // new graze cycle started
          spawnStar({ major: true, forceMode: 'grazing' });
        }
        lastMode = now;
      }
    });

    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFx, { once: true });
  } else {
    initFx();
  }
})();
