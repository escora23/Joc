// FRONT ULTRA — cinematic loading screen (owner: ui).
// Animated logo reveal, a holographic wireframe globe (canvas 2D, only while loading), a segmented progress
// bar bound to the real loading steps reported by app (satellite imagery, world grid, countries, shader
// precompile), rotating gameplay tips, scanlines + grid, and a smooth exit into the menu.

import { h, setText, toggleClass } from './dom';
import { icon } from './icons';
import { createLogo } from './logo';
import { tx } from './tx';
import type { LoadingHandle } from '../shared/api';
import { hasKey, t } from '../shared/i18n';

type StepId = 'textures' | 'grid' | 'countries' | 'shaders';
const STEPS: StepId[] = ['textures', 'grid', 'countries', 'shaders'];

/** Which checklist step a progress label belongs to. */
function stepOf(label: string): StepId | null {
  if (label === 'loading.textures' || label === 'data.download' || label === 'data.decode') return 'textures';
  if (label === 'data.water' || label === 'data.relief' || label === 'data.coast' || label === 'data.biomes') return 'grid';
  if (label === 'data.countries' || label === 'data.aux' || label === 'data.done' || label === 'loading.data') return 'countries';
  if (label === 'loading.shaders') return 'shaders';
  return null;
}

const TIP_COUNT = 14;
const SEGMENTS = 48;

export function createLoadingScreen(root: HTMLElement, onExit?: () => void): LoadingHandle {
  // ---- structure ----------------------------------------------------------------------------------
  const globe = h('canvas', { class: 'fu-ld-globe' });
  const segs: HTMLElement[] = [];
  const bar = h('div', { class: 'fu-ld-bar' });
  for (let i = 0; i < SEGMENTS; i++) {
    const sgm = h('i');
    segs.push(sgm);
    bar.append(sgm);
  }
  const pct = h('div', { class: 'fu-ld-pct fu-mono' }, '0');
  const status = h('div', { class: 'fu-ld-status' }, t('loading.systems'));
  const stepEls = new Map<StepId, HTMLElement>();
  const steps = h('div', { class: 'fu-ld-steps' });
  for (const id of STEPS) {
    const el = h('div', { class: 'fu-ld-step' }, h('span', { class: 'fu-ld-step-dot' }), tx(`loading.step.${id}`));
    stepEls.set(id, el);
    steps.append(el);
  }
  const tipText = h('div', { class: 'fu-ld-tip-text' });
  const tipDots = h('div', { class: 'fu-ld-tip-dots' });
  const tip = h('div', { class: 'fu-ld-tip fu-glass' },
    h('div', { class: 'fu-ld-tip-head' }, icon('info'), tx('loading.tip'), tipDots),
    tipText,
  );
  const press = h('div', { class: 'fu-ld-press' }, h('span', { class: 'fu-kbd' }, '⏎'), tx('loading.pressAnyKey'));
  const clock = h('span', { class: 'fu-mono' }, '00:00:00');
  const coords = h('span', { class: 'fu-mono' }, '');
  const screen = h('div', { class: 'fu-loading' },
    h('div', { class: 'fu-ld-bg' }),
    h('div', { class: 'fu-ld-floor' }),
    globe,
    h('div', { class: 'fu-ld-scan' }),
    h('div', { class: 'fu-ld-vignette' }),
    h('div', { class: 'fu-ld-corner fu-ld-tl' },
      h('b', null, 'FRONT ULTRA'), h('span', null, ' // '), tx('loading.system'),
    ),
    h('div', { class: 'fu-ld-corner fu-ld-tr' }, tx('loading.uplink'), h('span', { class: 'fu-ld-blink' }, ' ▮ '), 'UTC ', clock),
    h('div', { class: 'fu-ld-corner fu-ld-bl' }, coords),
    h('div', { class: 'fu-ld-corner fu-ld-br' }, 'BUILD 1.0.0 · WEBGL2 · ', tx('loading.offline')),
    h('div', { class: 'fu-ld-center' },
      createLogo({ size: 'hero' }),
      h('div', { class: 'fu-ld-progress' },
        h('div', { class: 'fu-ld-row' }, status, h('div', { class: 'fu-ld-pctwrap' }, pct, h('small', null, '%'))),
        bar,
        steps,
      ),
      press,
    ),
    tip,
  );
  root.appendChild(screen);

  // ---- tips ---------------------------------------------------------------------------------------
  const tips: string[] = [];
  for (let i = 1; i <= TIP_COUNT; i++) if (hasKey(`tip.${i}`)) tips.push(`tip.${i}`);
  let tipIndex = Math.floor((Date.now() / 1000) % Math.max(1, tips.length));
  const dotEls: HTMLElement[] = [];
  for (let i = 0; i < Math.min(tips.length, 8); i++) {
    const d = h('i');
    dotEls.push(d);
    tipDots.append(d);
  }
  function showTip(): void {
    if (!tips.length) return;
    tipText.classList.remove('is-in');
    void tipText.offsetWidth; // restart the CSS transition
    tipText.textContent = t(tips[tipIndex % tips.length]);
    tipText.classList.add('is-in');
    dotEls.forEach((d, i) => toggleClass(d, 'is-on', i === tipIndex % dotEls.length));
  }
  showTip();
  const tipTimer = window.setInterval(() => {
    tipIndex++;
    showTip();
  }, 5200);

  // ---- holographic globe + corner readouts --------------------------------------------------------
  const g2 = globe.getContext('2d');
  let raf = 0;
  let running = true;
  const t0 = performance.now();
  // Coastlines (Natural Earth 1:110m, ~55 KB) streamed in while everything else loads.
  let coast: Float32Array[] = [];
  void Promise.all([import('world-atlas/land-110m.json'), import('topojson-client')]).then(([land, topo]) => {
    const tp = land.default as unknown as Parameters<typeof topo.feature>[0];
    const obj = (tp as unknown as { objects: Record<string, unknown> }).objects.land;
    const geo = topo.feature(tp, obj as Parameters<typeof topo.feature>[1]) as unknown as { type: string; features?: { geometry: { type: string; coordinates: number[][][] | number[][][][] } }[]; geometry?: { type: string; coordinates: number[][][] | number[][][][] } };
    const geoms = geo.features ? geo.features.map((f) => f.geometry) : geo.geometry ? [geo.geometry] : [];
    const rings: Float32Array[] = [];
    for (const g of geoms) {
      const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as number[][][][];
      for (const poly of polys) {
        for (const ring of poly) {
          if (ring.length < 6) continue;
          const a = new Float32Array(ring.length * 2);
          for (let i = 0; i < ring.length; i++) {
            a[i * 2] = (ring[i][1] * Math.PI) / 180;
            a[i * 2 + 1] = (ring[i][0] * Math.PI) / 180;
          }
          rings.push(a);
        }
      }
    }
    coast = rings;
  }).catch(() => undefined);
  const cities: [number, number][] = [];
  for (let i = 0; i < 90; i++) {
    // Deterministic pseudo-random "cities" (golden-angle spiral clipped to land-ish latitudes).
    const a = i * 2.39996;
    const lat = Math.asin(((i * 0.618034) % 1) * 1.6 - 0.8);
    cities.push([lat, a % (Math.PI * 2)]);
  }
  let lastDraw = 0;
  function drawGlobe(now: number): void {
    if (!running) return;
    raf = requestAnimationFrame(drawGlobe);
    if (!g2 || now - lastDraw < 33) return;
    lastDraw = now;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = globe.clientWidth, hh = globe.clientHeight;
    if (globe.width !== Math.round(w * dpr) || globe.height !== Math.round(hh * dpr)) {
      globe.width = Math.round(w * dpr);
      globe.height = Math.round(hh * dpr);
    }
    const W = globe.width, H = globe.height;
    g2.setTransform(1, 0, 0, 1, 0, 0);
    g2.clearRect(0, 0, W, H);
    const R = Math.min(W, H) * 0.46;
    const cx = W / 2, cy = H / 2;
    const rot = ((now - t0) / 1000) * 0.12;
    const tilt = 0.38;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    g2.lineWidth = Math.max(1, dpr * 0.8);
    // Rim glow
    const grd = g2.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.12);
    grd.addColorStop(0, 'rgba(63,208,255,0)');
    grd.addColorStop(0.85, 'rgba(63,208,255,0.10)');
    grd.addColorStop(1, 'rgba(63,208,255,0)');
    g2.fillStyle = grd;
    g2.beginPath();
    g2.arc(cx, cy, R * 1.12, 0, Math.PI * 2);
    g2.fill();
    const project = (lat: number, lon: number): [number, number, number] => {
      const x = Math.cos(lat) * Math.sin(lon + rot);
      const y0 = Math.sin(lat);
      const z0 = Math.cos(lat) * Math.cos(lon + rot);
      const y = y0 * ct - z0 * st;
      const z = y0 * st + z0 * ct;
      return [cx + x * R, cy - y * R, z];
    };
    // Meridians & parallels (front half bright, back half faint)
    for (let pass = 0; pass < 2; pass++) {
      g2.strokeStyle = pass === 0 ? 'rgba(63,208,255,0.07)' : 'rgba(120,220,255,0.28)';
      g2.beginPath();
      for (let m = 0; m < 12; m++) {
        const lon = (m / 12) * Math.PI * 2;
        let pen = false;
        for (let k = 0; k <= 48; k++) {
          const lat = -Math.PI / 2 + (k / 48) * Math.PI;
          const [px, py, pz] = project(lat, lon);
          const vis = pass === 0 ? pz < 0 : pz >= 0;
          if (vis) {
            if (pen) g2.lineTo(px, py);
            else g2.moveTo(px, py);
            pen = true;
          } else pen = false;
        }
      }
      for (let p = 1; p < 8; p++) {
        const lat = -Math.PI / 2 + (p / 8) * Math.PI;
        let pen = false;
        for (let k = 0; k <= 72; k++) {
          const lon = (k / 72) * Math.PI * 2;
          const [px, py, pz] = project(lat, lon);
          const vis = pass === 0 ? pz < 0 : pz >= 0;
          if (vis) {
            if (pen) g2.lineTo(px, py);
            else g2.moveTo(px, py);
            pen = true;
          } else pen = false;
        }
      }
      g2.stroke();
    }
    // Coastlines, front hemisphere only
    if (coast.length) {
      g2.strokeStyle = 'rgba(120,225,255,0.55)';
      g2.lineWidth = Math.max(1, dpr * 0.9);
      g2.beginPath();
      for (const ring of coast) {
        let pen = false;
        for (let k = 0; k < ring.length; k += 2) {
          const [px, py, pz] = project(ring[k], ring[k + 1]);
          if (pz > 0) {
            if (pen) g2.lineTo(px, py);
            else g2.moveTo(px, py);
            pen = true;
          } else pen = false;
        }
      }
      g2.stroke();
    }
    // Outline
    g2.strokeStyle = 'rgba(140,230,255,0.45)';
    g2.beginPath();
    g2.arc(cx, cy, R, 0, Math.PI * 2);
    g2.stroke();
    // City blips + a few "strike" arcs
    const tt = (now - t0) / 1000;
    for (let i = 0; i < cities.length; i++) {
      const [lat, lon] = cities[i];
      const [px, py, pz] = project(lat, lon);
      if (pz < 0.05) continue;
      const pulse = 0.5 + 0.5 * Math.sin(tt * 2 + i);
      g2.fillStyle = i % 9 === 0 ? `rgba(255,181,61,${0.5 + 0.5 * pulse})` : `rgba(160,235,255,${0.25 + 0.45 * pz})`;
      const r = (i % 9 === 0 ? 2.2 : 1.2) * dpr;
      g2.fillRect(px - r / 2, py - r / 2, r, r);
    }
    g2.lineWidth = 1.4 * dpr;
    for (let k = 0; k < 4; k++) {
      const a = cities[(k * 23 + 7) % cities.length], b = cities[(k * 31 + 40) % cities.length];
      const ph = ((tt * 0.35 + k * 0.27) % 1);
      const [ax, ay, az] = project(a[0], a[1]);
      const [bx, by, bz] = project(b[0], b[1]);
      if (az < 0 || bz < 0) continue;
      const mx = (ax + bx) / 2 + (cy - (ay + by) / 2) * 0.0, my = Math.min(ay, by) - R * 0.35;
      g2.strokeStyle = `rgba(255,150,60,${0.55 * (1 - ph)})`;
      g2.beginPath();
      g2.moveTo(ax, ay);
      const steps = 24;
      const n = Math.floor(steps * Math.min(1, ph * 1.6));
      for (let s = 1; s <= n; s++) {
        const u = s / steps;
        const x = (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * mx + u * u * bx;
        const y = (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * my + u * u * by;
        g2.lineTo(x, y);
      }
      g2.stroke();
    }
    // Readouts (cheap string work, ~every frame is fine for a loading screen)
    const d = new Date();
    setText(clock, `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`);
    const la = (Math.sin(tt * 0.37) * 58).toFixed(4), lo = (((tt * 17) % 360) - 180).toFixed(4);
    setText(coords, `LAT ${la}  LON ${lo}  ALT 35786 KM`);
  }
  raf = requestAnimationFrame(drawGlobe);

  // ---- progress -----------------------------------------------------------------------------------
  let shown = 0;
  let target = 0;
  let lastLabelAt = 0;
  let pendingLabel = '';
  const seen = new Set<StepId>();
  function setStepStates(finalAll: boolean): void {
    const shaders = seen.has('shaders');
    for (const id of STEPS) {
      const el = stepEls.get(id)!;
      let done = finalAll;
      if (!done) {
        if (id === 'grid') done = seen.has('countries') || shaders;
        else if (id === 'textures' || id === 'countries') done = shaders;
      }
      const active = !done && seen.has(id);
      toggleClass(el, 'is-done', done);
      toggleClass(el, 'is-active', active);
    }
  }
  let animTimer = 0;
  function animateBar(): void {
    // Ease the displayed value toward the reported one (smooth even when reports are bursty).
    shown += (target - shown) * 0.18;
    if (Math.abs(target - shown) < 0.001) shown = target;
    const lit = Math.round(shown * SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) {
      toggleClass(segs[i], 'is-on', i < lit);
      toggleClass(segs[i], 'is-head', i === lit - 1 && shown < 1);
    }
    setText(pct, String(Math.floor(shown * 100)).padStart(2, '0'));
    if (shown !== target) animTimer = window.setTimeout(animateBar, 33);
    else animTimer = 0;
  }
  function kick(): void {
    if (!animTimer) animTimer = window.setTimeout(animateBar, 16);
  }

  let finished = false;
  const handle: LoadingHandle = {
    setProgress(fraction, label) {
      if (finished) return;
      target = Math.max(target, Math.min(1, Math.max(0, fraction)));
      kick();
      if (label) {
        const st = stepOf(label);
        if (st) seen.add(st);
        setStepStates(false);
        // Labels from parallel loaders interleave: hold each one on screen for a moment.
        const now = performance.now();
        if (now - lastLabelAt > 420 || label === 'loading.shaders') {
          lastLabelAt = now;
          setText(status, t(label));
          pendingLabel = '';
        } else pendingLabel = label;
      }
      if (pendingLabel && performance.now() - lastLabelAt > 420) {
        setText(status, t(pendingLabel));
        lastLabelAt = performance.now();
        pendingLabel = '';
      }
    },
    complete(requireInput) {
      finished = true;
      target = 1;
      kick();
      setStepStates(true);
      setText(status, t('loading.ready'));
      screen.classList.add('is-ready');
      const finish = () =>
        new Promise<void>((resolve) => {
          screen.classList.add('is-leaving');
          onExit?.();
          window.setTimeout(() => {
            running = false;
            cancelAnimationFrame(raf);
            window.clearInterval(tipTimer);
            screen.remove();
            resolve();
          }, 1100);
        });
      if (!requireInput) return finish();
      press.classList.add('is-on');
      return new Promise<void>((resolve) => {
        const go = (e: Event) => {
          if (e instanceof KeyboardEvent && (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta')) return;
          window.removeEventListener('keydown', go, true);
          window.removeEventListener('pointerdown', go, true);
          void finish().then(resolve);
        };
        window.addEventListener('keydown', go, true);
        window.addEventListener('pointerdown', go, true);
      });
    },
  };
  return handle;
}
