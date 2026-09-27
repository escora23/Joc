// FRONT ULTRA — W1 browser acceptance (DESIGN_V2 §3.5): clock modes, crisis and observation time, on-screen speeds,
// interpolation smoothness and the top-bar clock, measured in the real game (headless Chromium).
//
//   node tools/w1-browser.mjs [--url http://127.0.0.1:5311/] [--out shots/W1-sim-pacing-warfare] [--only crisis,obs,...]
//
// Checks: T28 (debug atom bomb Madrid->Paris at 1x and 4x: crisis during the flight, 10-20 real s, strategic again
// <= 4 real s after the detonation), crisisTime 'mine' (a launch between two AIs does not change the clock), T41 clock
// (below 60 km observation at rate 60; above 85 km strategic within 1 s), T27b (__front.speedProbe at 1x), T40
// (__front.motionProbe at 0.5x/1x/2x/4x and in crisis), the top bar («DÍA n», 24 segments, tooltip, scale chip).
// SwiftShader renders slowly: T40 leaves out frames slower than 2x the window's median frame time (one stalled frame
// must not decide it), judges only windows with >= 3 staged movers on screen, and also reports the per-real-second ratio.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5311/';
// Screenshots are illustrations, not assertions: SwiftShader can take very long to render close zooms, so a slow
// capture is logged and skipped instead of aborting the run.
let page; // assigned below
async function snap(opts) {
  try { await page.screenshot({ timeout: 90000, ...opts }); } catch (e) { console.log(`(screenshot skipped: ${opts.path}: ${String(e.message).split('\n')[0]})`); }
}
const out = args.out || 'shots/W1-sim-pacing-warfare';
const only = args.only ? new Set(String(args.only).split(',')) : null;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
page = await browser.newPage({ viewport: { width: Number(args.w || 1280), height: Number(args.h || 720) } });
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || t.startsWith('[sim]')) logs.push(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);
const sleep = (ms) => page.waitForTimeout(ms);
const results = [];
const row = (id, what, value, target, pass) => {
  results.push({ id, what, value: String(value), target, pass });
  log(`${pass ? 'PASS' : 'FAIL'} ${id} ${what}: ${value} (target ${target})`);
};
const ev = (fn, a) => page.evaluate(fn, a);
const want = (k) => !only || only.has(k);

await page.goto(base, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__front?.app.state === 'menu', null, { timeout: 60000 });
log('menu');
await ev(async () => {
  const { app } = window.__front;
  await app.startScriptedGame({ ticks: 0, speed: 1, autopilot: false, worldEvents: false });
});
await page.waitForFunction(() => window.__front.app.state === 'playing', null, { timeout: 120000 });
await ev(() => {
  // Event recorder for the timing checks.
  const { ctx } = window.__front;
  window.__w1 = { det: [], launch: [], clock: [] };
  ctx.bus.on('nukeDetonated', (e) => window.__w1.det.push({ t: performance.now(), tick: e.tick, unit: e.unitId }));
  ctx.bus.on('nukeLaunched', (e) => window.__w1.launch.push({ t: performance.now(), tick: e.tick, unit: e.unitId }));
  ctx.bus.on('clockChanged', (e) => window.__w1.clock.push({ t: performance.now(), mode: e.mode, rate: e.rate }));
});
log('playing');
const look = (lat, lon, altitudeKm, tilt = 0) => ev((a) => window.__front.ctx.cameraRig.setState({ ...a, heading: 0 }), { lat, lon, altitudeKm, tilt });
const setSpeed = (s) => ev((s) => window.__front.app.setSpeed(s), s);
const clock = () => ev(() => window.__front.clock());

// --- top bar ---------------------------------------------------------------------------------------
if (want('topbar')) {
  await sleep(2500);
  const tb = await ev(() => ({
    day: document.querySelector('.fu-day-label')?.textContent ?? '',
    segs: document.querySelectorAll('.fu-hourbar i').length,
    on: document.querySelectorAll('.fu-hourbar i.is-on').length,
    chip: document.querySelector('.fu-clockchip')?.textContent ?? '',
    speeds: [...document.querySelectorAll('.fu-time-seg > button')].map((b) => b.textContent),
    hours: window.__front.ctx.sim.view.gameHours,
  }));
  row('§2.7', 'top bar day label', tb.day, 'DÍA n', /^DÍA \d+$/.test(tb.day));
  row('§2.7', 'hour bar segments', `${tb.segs} (${tb.on} lit at ${tb.hours.toFixed(1)} h)`, '24, one per hour', tb.segs === 24 && tb.on === Math.floor(tb.hours) % 24);
  // The day tooltip is the HUD tip() component: hover the day box like a player and read the tip that appears.
  const dayBox = await ev(() => {
    const r = document.querySelector('.fu-daybox')?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  let tipText = '';
  if (dayBox) {
    await page.mouse.move(dayBox.x, dayBox.y);
    for (let i = 0; i < 40 && !tipText; i++) {
      await sleep(250);
      tipText = await ev(() => document.querySelector('.fu-tip.is-on .fu-tip-text')?.textContent ?? '');
    }
    await page.mouse.move(640, 400);
  }
  row('§2.7', 'day tooltip (hovered .fu-daybox, read .fu-tip-text)', tipText.slice(0, 60) + '…', 'Día n de la partida…', /^(Día|Day) \d+/.test(tipText));
  row('§2.7', 'scale chip at 1x', tb.chip, '1× · 1 s = 1 h', tb.chip === '1× · 1 s = 1 h');
  row('§2.7', 'speed buttons', tb.speeds.join(' | '), 'pause, 0.5x, 1x, 2x, 4x', tb.speeds.length === 5);
  // Every speed button must be clickable with the mouse: hit-test the centre of each one (elementFromPoint) at the
  // three reference resolutions, then click 0.5x/1x/2x/4x for real and read the game speed back.
  const vp = page.viewportSize();
  for (const [w, hgt] of [[1280, 720], [1600, 900], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await sleep(1500);
    const hits = await ev(() => [...document.querySelectorAll('.fu-time-seg > button')].map((b) => {
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { label: (b.textContent || 'II').trim() || 'II', w: Math.round(r.width), hit: !!el && (el === b || b.contains(el)) };
    }));
    const seg = await ev(() => {
      const r = document.querySelector('.fu-time-seg')?.getBoundingClientRect();
      const want = [...document.querySelectorAll('.fu-time-seg > button')].reduce((a, b) => a + b.scrollWidth, 0);
      return { w: Math.round(r?.width ?? 0), want };
    });
    row('§2.7', `speed buttons hit-testable at ${w}x${hgt}`, hits.map((x) => `${x.label}:${x.hit ? 'hit' : 'COVERED'}(${x.w}px)`).join(' ') + ` seg ${seg.w}px`, '5 of 5 hit, segment at natural width', hits.length === 5 && hits.every((x) => x.hit && x.w >= 20) && seg.w + 1 >= seg.want);
    if (w === 1600) {
      const r = await ev(() => { const b = document.querySelector('.fu-time')?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; });
      if (r) await snap({ path: path.join(out, 'topbar-1x.png'), clip: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(r.width + 16, w - Math.max(0, r.x - 8)), height: r.height + 16 } });
      // Tutorial step 7 highlights '.fu-time-seg' (class fu-tut-hl): the highlighted box must frame all five buttons.
      const frame = await ev(() => {
        const seg = document.querySelector('.fu-time-seg');
        if (!seg) return null;
        seg.classList.add('fu-tut-hl');
        const s = seg.getBoundingClientRect();
        const inside = [...seg.querySelectorAll(':scope > button')].filter((b) => {
          const r = b.getBoundingClientRect();
          return r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5;
        }).length;
        return { inside, x: s.x, y: s.y, width: s.width, height: s.height };
      });
      if (frame) {
        await sleep(600);
        const cx = Math.max(0, frame.x - 16);
        await snap({ path: path.join(out, 'tutorial-clock-hl.png'), clip: { x: cx, y: Math.max(0, frame.y - 16), width: Math.min(frame.width + 32, w - cx), height: frame.height + 32 } });
        await ev(() => document.querySelector('.fu-time-seg')?.classList.remove('fu-tut-hl'));
      }
      row('§2.7', 'tutorial step 7 highlight frames the whole speed control', `${frame?.inside ?? 0}/5 buttons inside the highlighted box`, '5/5', frame?.inside === 5);
    }
  }
  if (vp) await page.setViewportSize(vp);
  await sleep(1500);
  const clicked = [];
  for (const [idx, sp] of [[1, 0.5], [3, 2], [4, 4], [2, 1]]) {
    const c = await ev((i) => { const r = document.querySelectorAll('.fu-time-seg > button')[i].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, idx);
    await page.mouse.click(c.x, c.y);
    let got = -1;
    for (let i = 0; i < 20 && got !== sp; i++) {
      await sleep(200);
      got = await ev(() => window.__front.ctx.sim.view.speed);
    }
    clicked.push(`${sp}->${got}`);
  }
  await page.mouse.move(640, 400);
  row('§2.7', 'mouse clicks on 0.5x/2x/4x/1x set the game speed', clicked.join(' '), 'each click sets its speed', clicked.every((c) => { const [a, b] = c.split('->'); return Number(a) === Number(b); }));
  for (const [sp, want] of [[0.5, '0,5× · 1 s = 30 min'], [2, '2× · 1 s = 2 h'], [4, '4× · 1 s = 4 h']]) {
    await setSpeed(sp);
    // The HUD text refreshes with the frames (a software renderer draws a frame every 1-2 s here).
    let chip = '';
    for (let i = 0; i < 100 && chip !== want; i++) {
      await sleep(250);
      chip = await ev(() => document.querySelector('.fu-clockchip')?.textContent ?? '');
    }
    row('§2.7', `scale chip at ${sp}x`, chip, want, chip === want);
  }
  await setSpeed(1);
}

// --- T41: observation ------------------------------------------------------------------------------
if (want('obs')) {
  await look(40.4, -3.7, 40);
  let c = null;
  const tIn = Date.now();
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    c = await clock();
    if (c.mode === 'observation' && Math.abs(c.rate - 60) < 0.5) break;
  }
  row('T41', 'camera 40 km: clock', `${c.mode} rate ${c.rate.toFixed(0)} after ${((Date.now() - tIn) / 1000).toFixed(1)} s`, "observation, rate 60", c.mode === 'observation' && Math.abs(c.rate - 60) < 0.5);
  let chip = '';
  for (let i = 0; i < 40 && chip !== 'OBSERVACIÓN · 1 s = 1 min'; i++) {
    await sleep(250);
    chip = await ev(() => document.querySelector('.fu-clockchip')?.textContent ?? '');
  }
  row('§2.7', 'scale chip in observation', chip, 'OBSERVACIÓN · 1 s = 1 min', chip === 'OBSERVACIÓN · 1 s = 1 min');
  await snap({ path: path.join(out, 'topbar-observation.png'), clip: { x: 1100, y: 0, width: 500, height: 140 } });
  await look(40.4, -3.7, 70);
  await sleep(1500);
  c = await clock();
  row('T41', 'camera 70 km (hysteresis band): clock', c.mode, 'observation (leave above 85 km)', c.mode === 'observation');
  await look(40.4, -3.7, 200);
  const tOut = Date.now();
  let back = -1;
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    c = await clock();
    if (c.mode === 'strategic' && back < 0) back = (Date.now() - tOut) / 1000;
    if (back >= 0 && c.rate >= 3599) break;
  }
  row('T41', 'camera 200 km: strategic again', `${back.toFixed(2)} s (rate ${c.rate.toFixed(0)})`, '<= 1 s', back >= 0 && back <= 1);
}

// --- T28: crisis time at 1x and 4x -------------------------------------------------------------------
async function crisisRun(speed) {
  await look(45, 0, 3000);
  await setSpeed(speed);
  await sleep(1500);
  // Timed from the worker updates as they ARRIVE (the frame rate of a software renderer must not skew it).
  const r = await ev(() => window.__front.crisisProbe({}));
  const crisisOnly = r.modesInFlight.length > 0 && r.modesInFlight.every((m) => m === 'crisis');
  row('T28', `${speed}x: clock during the flight`, r.modesInFlight.join(','), 'crisis', crisisOnly);
  row('T28', `${speed}x: flight Madrid->Paris`, `${r.flightSec.toFixed(1)} real s`, '10–20 real s', r.flightSec >= 10 && r.flightSec <= 20);
  row('T28', `${speed}x: strategic again after impact`, `${r.backSec.toFixed(1)} real s`, '<= 4 real s', r.backSec >= 0 && r.backSec <= 4);
  if (!(r.backSec >= 0 && r.backSec <= 4)) for (const l of r.after ?? []) log(`   after impact: ${l}`);
  await setSpeed(1);
}
if (want('crisis')) {
  await crisisRun(1);
  await sleep(3000);
  await crisisRun(4);
  // crisisTime 'mine': a launch between two AIs that are not our allies does not change the clock.
  await ev(() => window.__front.ctx.settings.set({ crisisTime: 'mine' }));
  await sleep(500);
  await ev(() => {
    const { ctx } = window.__front;
    const tile = (lat, lon) => Math.floor(((90 - lat) / 180) * 800) * 1600 + (Math.floor(((lon + 180) / 360) * 1600) % 1600);
    ctx.sim.debug({ type: 'launchNuke', weapon: 8, owner: 3, fromTile: tile(55.75, 37.6), targetTile: tile(39.9, 116.4) });
  });
  let modes = new Set();
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    modes.add((await clock()).mode);
  }
  row('§8.5', "crisisTime 'mine': AI->AI launch", [...modes].join(','), 'strategic only', modes.size === 1 && modes.has('strategic'));
  await ev(() => window.__front.ctx.settings.set({ crisisTime: 'always' }));
  await sleep(8000);
  const settingsLogged = logs.filter((l) => l.includes('[sim] settings')).length;
  row('§14.6', 'worker logs each settings message', settingsLogged, '>= 3 (start + 2 changes)', settingsLogged >= 3);
}

/** Measurements of motion need the strategic clock: wait out any crisis (a flight still in the air) first. */
async function waitStrategic(maxSec = 90) {
  const t = Date.now();
  while (Date.now() - t < maxSec * 1000) {
    const c = await clock();
    if (c.mode === 'strategic' && c.rate >= 3599 * Math.max(0.5, c.speed || 1) - 1) return true;
    await sleep(500);
  }
  log('clock never returned to strategic');
  return false;
}

// --- T27b: on-screen speeds at 1x -------------------------------------------------------------------
if (want('speed')) {
  await waitStrategic();
  await look(42, -8, 3500);
  await setSpeed(1);
  await sleep(1000);
  const rows = await ev(() => window.__front.speedProbe({ seconds: 6 }));
  for (const r of rows) row('T27b', `${r.unit} on-screen km/s at 1x (measured ${r.ticksPerSec} ticks/s)`, r.kmPerSecAt1x, r.target, r.pass);
}

// --- T40: interpolation smoothness -------------------------------------------------------------------
// Before every window the previous movers are removed and fresh ones are staged in the open Atlantic west of Iberia,
// sailing due west on routes longer than the window (warships 55 km/h, trade ships 30 km/h); the camera is fitted to
// the stretch they cover in that window, so every mover stays moving and on screen. A window is judged only with >= 3
// movers; frames slower than 2x the median frame time are left out (see motionProbe).
const MOTION_SEC = 10;
let staged = [];
async function stageMovers(gameHoursPerRealSec, close = false) {
  const travelKm = 55 * gameHoursPerRealSec * (MOTION_SEC + 4); // the fastest mover over the settle + probe window
  const r = await ev(async (a) => {
    const { ctx } = window.__front;
    const tile = (lat, lon) => Math.floor(((90 - lat) / 180) * 800) * 1600 + (Math.floor(((lon + 180) / 360) * 1600) % 1600);
    for (const id of a.old) ctx.sim.debug({ type: 'removeUnit', unitId: id });
    const before = new Set(ctx.sim.view.units.keys());
    // In crisis a ship covers ~13 km in the window: the lanes sit 5.5 km apart under a 90 km camera.
    const lanes = a.close ? [40.1, 40.15, 40.2, 40.25, 40.3, 40.35] : [36.5, 38.0, 39.5, 41.0, 42.5, 44.0];
    lanes.forEach((lat, i) => ctx.sim.debug({ type: 'spawnUnit', unit: i % 2 ? 1 : 2, owner: 1, tile: tile(lat, -13.5), targetTile: tile(lat, -60) }));
    // The movers appear with the next worker update (a software renderer can take seconds per frame).
    for (let i = 0; i < 120; i++) {
      await new Promise((res) => setTimeout(res, 250));
      const ids = [...ctx.sim.view.units.values()].filter((u) => !before.has(u.id) && u.owner === 1 && (u.type === 1 || u.type === 2)).map((u) => u.id);
      if (ids.length >= lanes.length) return ids;
    }
    return [...ctx.sim.view.units.values()].filter((u) => !before.has(u.id) && u.owner === 1).map((u) => u.id);
  }, { old: staged, close });
  staged = r;
  // Frame the stretch from the spawn line (13.5 W) to where the fastest mover will be (1 deg lon = 85 km at 40 N).
  // Crisis: 90 km up (above the 85 km observation exit, so the clock stays on crisis) keeps ~13 km of travel legible.
  if (close) await look(40.225, -13.6, 90);
  else {
    const spanDeg = Math.max(4, travelKm / 85);
    await look(40.2, -13.5 - spanDeg / 2 + 0.5, Math.max(1500, spanDeg * 85 * 1.6));
  }
  return r;
}
async function motionWindow(label, gameHoursPerRealSec, extra = {}, beforeStaging = null) {
  // The clock must already run at the window's rate while the movers are staged: at 1x a warship covers 55 km per
  // real second, so staging before a crisis starts would carry it out of the close crisis framing.
  if (beforeStaging) await beforeStaging();
  const ids = await stageMovers(gameHoursPerRealSec, !!extra.crisis);
  await sleep(2500); // the movers get their paths, the camera settles
  const r = await ev((o) => window.__front.motionProbe(o), { seconds: MOTION_SEC, ids, minMeanPx: extra.minMeanPx, trace: !!args.trace });
  if (r.trace) for (const t of r.trace) log(`   trace ${JSON.stringify(t)}`);
  const worst = r.units.reduce((m, u) => Math.max(m, u.ratio), 0);
  const worstRaw = r.units.reduce((m, u) => Math.max(m, u.rawRatio), 0);
  const worstAll = r.units.reduce((m, u) => Math.max(m, u.ratioAll), 0);
  const detail = `${r.units.length}/${ids.length} movers judged, ${r.frames} frames (${r.droppedFrames} slower than 2x median dropped), frame ms p50 ${r.frameMs.p50.toFixed(0)} max ${r.frameMs.max.toFixed(0)}, clock ${r.clock.mode}`;
  row('T40', `${label}: max/mean per-frame displacement (${detail})`, `${worst.toFixed(2)} (all frames incl. slow ${worstAll.toFixed(2)}; raw px per frame ${worstRaw.toFixed(2)})`, '<= 2 per frame / frame dt (steady and all frames), >= 3 movers', r.units.length >= 3 && r.pass && (extra.crisis ? r.clock.mode === 'crisis' : r.clock.mode === 'strategic'));
  if (r.units.length < ids.length) log(`   tracked on screen ${r.tracked ?? "?"} of ${ids.length} (${r.units.map((u) => u.unit).join(",")}); skipped: ${(r.skipped ?? []).join(', ') || 'none'}`);
  if (!r.pass || r.units.length < 3 || extra.crisis) for (const u of r.units) log(`   ${u.unit} #${u.id}: mean ${u.meanPx} px max ${u.maxPx} px over ${u.frames} frames, ratio ${u.ratio} all ${u.ratioAll} raw ${u.rawRatio}`);
  return r;
}
if (want('motion')) {
  // Smoothness is a property of the interpolation, not of the resolution: the software renderer of this container
  // draws a 1280x720 'high' frame in seconds, so the windows run at 640x360 and 'low' quality to get enough frames
  // in 10 real s (restored afterwards).
  const q0 = await ev(() => window.__front.ctx.settings.get().quality);
  await page.setViewportSize({ width: 640, height: 360 });
  await ev(() => window.__front.ctx.settings.set({ quality: 'low' }));
  await waitStrategic();
  for (const sp of [0.5, 1, 2, 4]) {
    await setSpeed(sp);
    await motionWindow(`${sp}x`, sp);
  }
  await setSpeed(1);
  // Crisis: a long ballistic flight keeps the world on the crisis clock (1 game min per real s) during the window.
  await ev(() => window.__front.ctx.settings.set({ crisisTime: 'always' }));
  // At 1 game min per real s a 30 km/h trade ship moves ~0.03 px per 60 fps frame even at 90 km: the 'parked' cut-off
  // drops to 0.005 px (the staged ids are known movers; the judged ratio is per real second, independent of scale).
  await motionWindow('crisis', 1 / 60, { crisis: true, minMeanPx: 0.005 }, async () => {
    await ev(() => {
      const { ctx } = window.__front;
      const tile = (lat, lon) => Math.floor(((90 - lat) / 180) * 800) * 1600 + (Math.floor(((lon + 180) / 360) * 1600) % 1600);
      ctx.sim.debug({ type: 'launchNuke', weapon: 9, owner: 2, fromTile: tile(38.9, -77.0), targetTile: tile(55.75, 37.6) });
    });
    for (let i = 0; i < 40 && (await clock()).mode !== 'crisis'; i++) await sleep(250);
  });
  for (const id of staged) await ev((id) => window.__front.ctx.sim.debug({ type: 'removeUnit', unitId: id }), id);
  staged = [];
  await ev((q) => window.__front.ctx.settings.set({ quality: q }), q0);
  await page.setViewportSize({ width: Number(args.w || 1280), height: Number(args.h || 720) });
}

// --- acceptance 15 / 16: declaration path, queued offensive, occupation after a resync ---------------------
if (want('declare')) {
  const st = await ev(async () => {
    const { ctx } = window.__front;
    const view = ctx.sim.view;
    const tile = (lat, lon) => Math.floor(((90 - lat) / 180) * 800) * 1600 + (Math.floor(((lon + 180) / 360) * 1600) % 1600);
    // The weakest living nation (the staged offensive must be able to take land for the occupation check).
    // (not the last nation: speedProbe staged a war and a truce with it)
    let enemy = 2, least = Infinity, lastId = 0;
    for (const p of view.playerList) if (p.alive && p.kind === 'nation') lastId = Math.max(lastId, p.id);
    for (const p of view.playerList) if (p.alive && p.kind === 'nation' && p.id !== lastId && p.troops < least) {
      least = p.troops;
      enemy = p.id;
    }
    ctx.sim.debug({ type: 'conquer', playerId: 1, centerTile: tile(40.4, -3.7), radius: 22 });
    ctx.sim.debug({ type: 'conquer', playerId: enemy, centerTile: tile(44.6, 1.5), radius: 14 });
    ctx.sim.debug({ type: 'addTroops', playerId: 1, amount: 2_500_000 }); // enough for real odds (§4.6) against any nation's garrison
    window.__decl = { msgs: [], wars: [], starts: [] };
    ctx.bus.on('message', (e) => window.__decl.msgs.push(e.key));
    ctx.bus.on('warDeclared', (e) => window.__decl.wars.push({ tick: e.tick, mob: e.mobilizeUntilTick, a: e.aggressor, b: e.target }));
    ctx.bus.on('attackStarted', (e) => window.__decl.starts.push({ tick: e.tick, a: e.attacker, d: e.defender }));
    return { enemy, target: tile(43.2, -0.5) };
  });
  await sleep(1500);
  // The raw command at peace is rejected.
  await ev((a) => window.__front.ctx.sim.send({ type: 'attack', target: a.enemy, ratio: 0.5, tile: a.target }), st);
  // The worker's answer reaches the bus with the next update (a software renderer can take seconds per frame).
  let msgs = [];
  for (let i = 0; i < 60 && !msgs.includes('msg.notAtWar'); i++) {
    await sleep(250);
    msgs = await ev(() => window.__decl.msgs.slice());
  }
  row('A15', 'raw attack on a nation at peace', msgs.includes('msg.notAtWar') ? 'msg.notAtWar' : msgs.join(',') || 'accepted', 'msg.notAtWar', msgs.includes('msg.notAtWar'));
  // A left click on its land opens the minimal declaration modal.
  await ev((a) => window.__front.ctx.bus.emit('worldClick', { button: 0, tile: a.target, lat: 43.2, lon: -0.5, unitId: -1, structureId: -1, clientX: 640, clientY: 360, shift: false, ctrl: false, alt: false }), st);
  await sleep(1200);
  const modal = await ev(() => ({ open: !!document.querySelector('.fu-declare-modal'), title: document.querySelector('.fu-declare-modal h2')?.textContent ?? '', lines: [...document.querySelectorAll('.fu-declare-line')].map((l) => l.textContent) }));
  await snap({ path: path.join(out, 'declare-modal.png') });
  row('A15', 'left click on a nation at peace opens the declaration', modal.open ? `«${modal.title}»` : 'no modal', 'modal', modal.open && /Declarar la guerra|Declare war/.test(modal.title));
  if (modal.open) {
    await page.click('.fu-declare-modal .fu-btn--danger');
    const t1 = Date.now();
    while (Date.now() - t1 < 60_000) {
      const d = await ev(() => window.__decl);
      if (d.starts.some((x) => x.a === 1 && x.d === st.enemy)) break;
      await sleep(500);
    }
    const d = await ev(() => window.__decl);
    const w = d.wars.find((x) => x.a === 1 && x.b === st.enemy);
    const s0 = d.starts.find((x) => x.a === 1 && x.d === st.enemy);
    row('A15', 'war declared; human mobilization (Normal)', w ? `${w.mob - w.tick} ticks` : 'no war', '60 ticks', !!w && w.mob - w.tick === 60);
    row('A15', 'queued offensive starts at mobilizeUntilTick', s0 && w ? `tick ${s0.tick} (mobilized ${w.mob})` : 'no offensive', 'equal', !!s0 && !!w && s0.tick === w.mob);
  }
  // Occupation after a fast-forward (a fullOwners resync): the drawn set equals the sim's (checked through the view).
  const occ = await ev(async () => {
    const { ctx } = window.__front;
    // Long enough for the offensive to take ground across the Pyrenees, short of the 720-tick occupation.
    await ctx.sim.fastForward(600);
    const v = ctx.sim.view;
    let owned = 0, occNotOwned = 0;
    for (const t of v.occupiedTiles) {
      if (v.owner[t] !== 0) owned++;
      else occNotOwned++;
    }
    const mine = v.attacks.filter((a) => a.attacker === 1 && a.defender > 0).map((a) => `${a.state} R ${(a.ratio ?? 0).toFixed(2)}`);
    return { n: v.occupiedTiles.size, owned, occNotOwned, human: v.occupiedCount(1), mine };
  });
  row('A16', 'occupied tiles after a fast-forward resync', `${occ.n} (human ${occ.human}), ${occ.occNotOwned} on unowned land${occ.n ? '' : `; our offensives: ${occ.mine.join(', ') || 'none'}`}`, '> 0, none unowned', occ.n > 0 && occ.occNotOwned === 0);
}

console.log('\n=== W1 browser checks ===');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(6)} ${r.what}: ${r.value}  (target ${r.target})`);
console.log(`--- ${results.filter((r) => r.pass).length}/${results.length} pass`);
for (const l of logs.filter((l) => !l.startsWith('[info]')).slice(0, 20)) console.log('  ', l);
fs.writeFileSync(path.join(out, 'w1-browser.json'), JSON.stringify(results, null, 2));
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
