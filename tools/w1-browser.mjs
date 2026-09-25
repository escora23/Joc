// FRONT ULTRA — W1 browser acceptance (DESIGN_V2 §3.5): clock modes, crisis and observation time, on-screen speeds,
// interpolation smoothness and the top-bar clock, measured in the real game (headless Chromium).
//
//   node tools/w1-browser.mjs [--url http://127.0.0.1:5311/] [--out shots/W1-sim-pacing-warfare] [--only crisis,obs,...]
//
// Checks: T28 (debug atom bomb Madrid->Paris at 1x and 4x: crisis during the flight, 10-20 real s, strategic again
// <= 4 real s after the detonation), crisisTime 'mine' (a launch between two AIs does not change the clock), T41 clock
// (below 60 km observation at rate 60; above 85 km strategic within 1 s), T27b (__front.speedProbe at 1x), T40
// (__front.motionProbe at 0.5x/1x/2x/4x and in crisis), the top bar («DÍA n», 24 segments, tooltip, scale chip).
// SwiftShader renders slowly: T40 is reported both per frame and per real second (frame-time jitter is the renderer's).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5311/';
const out = args.out || 'shots/W1-sim-pacing-warfare';
const only = args.only ? new Set(String(args.only).split(',')) : null;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: Number(args.w || 1280), height: Number(args.h || 720) } });
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
    tip: document.querySelector('.fu-daybox')?.getAttribute('title') ?? '',
    chip: document.querySelector('.fu-clockchip')?.textContent ?? '',
    speeds: [...document.querySelectorAll('.fu-time-seg > button')].map((b) => b.textContent),
    hours: window.__front.ctx.sim.view.gameHours,
  }));
  row('§2.7', 'top bar day label', tb.day, 'DÍA n', /^DÍA \d+$/.test(tb.day));
  row('§2.7', 'hour bar segments', `${tb.segs} (${tb.on} lit at ${tb.hours.toFixed(1)} h)`, '24, one per hour', tb.segs === 24 && tb.on === Math.floor(tb.hours) % 24);
  row('§2.7', 'day tooltip', tb.tip.slice(0, 60) + '…', 'Día n de la partida…', tb.tip.startsWith('Día'));
  row('§2.7', 'scale chip at 1x', tb.chip, '1× · 1 s = 1 h', tb.chip === '1× · 1 s = 1 h');
  row('§2.7', 'speed buttons', tb.speeds.join(' | '), 'pause, 0.5x, 1x, 2x, 4x', tb.speeds.length === 5);
  await page.screenshot({ path: path.join(out, 'topbar-1x.png'), clip: { x: 1100, y: 0, width: 500, height: 140 } });
  for (const [sp, want] of [[0.5, '0,5× · 1 s = 30 min'], [2, '2× · 1 s = 2 h'], [4, '4× · 1 s = 4 h']]) {
    await setSpeed(sp);
    // The HUD text refreshes with the frames (a software renderer draws a frame every 1-2 s here).
    let chip = '';
    for (let i = 0; i < 40 && chip !== want; i++) {
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
  await page.screenshot({ path: path.join(out, 'topbar-observation.png'), clip: { x: 1100, y: 0, width: 500, height: 140 } });
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

// --- T27b: on-screen speeds at 1x -------------------------------------------------------------------
if (want('speed')) {
  await look(42, -8, 3500);
  await setSpeed(1);
  await sleep(1000);
  const rows = await ev(() => window.__front.speedProbe({ seconds: 10 }));
  for (const r of rows) row('T27b', `${r.unit} on-screen km/s at 1x (measured ${r.ticksPerSec} ticks/s)`, r.kmPerSecAt1x, r.target, r.pass);
}

// --- T40: interpolation smoothness -------------------------------------------------------------------
if (want('motion')) {
  await ev(() => {
    const { ctx } = window.__front;
    const tile = (lat, lon) => Math.floor(((90 - lat) / 180) * 800) * 1600 + (Math.floor(((lon + 180) / 360) * 1600) % 1600);
    ctx.sim.debug({ type: 'conquer', playerId: 1, centerTile: tile(40.9, -1.2), radius: 22 });
    for (let i = 0; i < 4; i++) ctx.sim.debug({ type: 'spawnUnit', unit: 2, owner: 1, tile: tile(39 + i * 0.6, -12 - i), targetTile: tile(40, -60) });
    for (let i = 0; i < 3; i++) ctx.sim.debug({ type: 'spawnUnit', unit: 3, owner: 1, tile: tile(40.4 + i * 0.3, -3.7), targetTile: tile(41.4, 2.2) });
    ctx.sim.debug({ type: 'spawnUnit', unit: 13, owner: 1, tile: tile(40.4, -3.7), targetTile: tile(41.4, 2.2) });
  });
  await look(40, -7, 2200);
  for (const sp of [0.5, 1, 2, 4]) {
    await setSpeed(sp);
    await sleep(1500);
    const r = await ev(() => window.__front.motionProbe({ seconds: 10 }));
    const worst = r.units.reduce((m, u) => Math.max(m, u.ratio), 0);
    const worstV = r.units.reduce((m, u) => Math.max(m, u.speedRatio), 0);
    row('T40', `${sp}x: max/mean per-frame displacement (${r.units.length} units, ${r.frames} frames, frame ms p50 ${r.frameMs.p50.toFixed(0)} max ${r.frameMs.max.toFixed(0)})`, `${worst.toFixed(2)} (velocity ${worstV.toFixed(2)})`, '<= 2', r.units.length > 0 && r.pass);
  }
  await setSpeed(1);
  // Crisis: a long flight keeps the world on the crisis clock during the probe.
  await ev(() => {
    const { ctx } = window.__front;
    const tile = (lat, lon) => Math.floor(((90 - lat) / 180) * 800) * 1600 + (Math.floor(((lon + 180) / 360) * 1600) % 1600);
    ctx.sim.debug({ type: 'launchNuke', weapon: 9, owner: 2, fromTile: tile(38.9, -77.0), targetTile: tile(55.75, 37.6) });
  });
  await sleep(1500);
  const r = await ev(() => window.__front.motionProbe({ seconds: 10, minMeanPx: 0.02 }));
  const worst = r.units.reduce((m, u) => Math.max(m, u.ratio), 0);
  const worstV = r.units.reduce((m, u) => Math.max(m, u.speedRatio), 0);
  row('T40', `crisis: max/mean per-frame displacement (${r.units.length} units, clock ${r.clock.mode}, frame ms p50 ${r.frameMs.p50.toFixed(0)} max ${r.frameMs.max.toFixed(0)})`, `${worst.toFixed(2)} (velocity ${worstV.toFixed(2)})`, '<= 2', r.clock.mode === 'crisis' && r.pass);
}

console.log('\n=== W1 browser checks ===');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(6)} ${r.what}: ${r.value}  (target ${r.target})`);
console.log(`--- ${results.filter((r) => r.pass).length}/${results.length} pass`);
for (const l of logs.filter((l) => !l.startsWith('[info]')).slice(0, 20)) console.log('  ', l);
fs.writeFileSync(path.join(out, 'w1-browser.json'), JSON.stringify(results, null, 2));
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
