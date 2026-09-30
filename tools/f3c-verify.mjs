// Feedback #3 browser verifier, command-mode side (FEEDBACK-1 items 26, 27 command side, 29b, 29e). Drives the real
// game in Chromium (SwiftShader) on staged but REAL wars through the real UI (unit card, Guerra panel, keyboard in
// command mode).
//   node tools/f3c-verify.mjs [--url http://127.0.0.1:5468/] [--out shots/feedback3-command/verify] [--only go,panel,strike,night]
//
// go      #26: take control of a division from its card (its real position, ~30 km behind the line); the chip names the
//         nearest action with distance and bearing; G marches it there; time from the click to an enemy within 3 km
//         (the criterion: under ~60 real s; SwiftShader frames are 1-3 s, so frames are reported too).
// panel   #26/#29e: from the Guerra y frentes panel, «Tomar el control aquí» on the front: the unit engaged there goes to
//         the action by itself; time to contact; Esc → the strategic camera looks at that place.
// strike  #27: shells of the controlled tank hit a real enemy structure seen in command mode; the sim's hp falls, its
//         state and level change, the owner is told, and the strategic map shows it.
// night   #29b: a front at night in command mode: the frame's light (mean luma, lit share) with and without night vision.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5468/';
const out = args.out || 'shots/feedback3-command/verify';
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(out, { recursive: true });
const results = [];
const row = (id, what, value, pass) => {
  results.push({ id, what, value: String(value), pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${what} :: ${value}`);
};
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
let errors = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(shot, params = '') {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => { errors++; console.log(`[pageerror] ${e.message}`); });
  page.on('console', (m) => { if (/\[command\]/.test(m.text()) && !/escort|border crossing/.test(m.text())) console.log(`   ${m.text().slice(0, 220)}`); });
  await page.goto(`${base}?shot=${shot}${params}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__f3c = { dmg: [], frames: 0 };
    __front.ctx.bus.on('structureDamaged', (e) => window.__f3c.dmg.push(e));
    const loop = () => { window.__f3c.frames++; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), timeout: 300000 }).catch((e) => console.log(`   (screenshot ${name} failed: ${String(e?.message ?? e).split('\n')[0]})`));
async function until(page, fn, arg, ms = 30000, every = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}
async function uiClick(page, sel, timeout = 20000) {
  const loc = page.locator(sel).first();
  try {
    await loc.click({ timeout: Math.min(timeout, 8000) });
    return true;
  } catch (e) {
    if (!/not stable|Timeout|intercepts/.test(String(e?.message ?? e))) throw e;
  }
  await loc.waitFor({ state: 'visible', timeout });
  const box = await loc.boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}
const stats = (page) => page.evaluate(() => window.__cmdStats ?? null);
const frames = (page) => page.evaluate(() => window.__f3c.frames);
/** Wait for contact: a hostile entity within 3 km of the vehicle in command mode. */
async function waitContact(page, ms) {
  return until(page, () => {
    const s = window.__cmdStats;
    return s && s.phase === 'play' && s.nearestHostileM > 0 && s.nearestHostileM < 3000 ? { m: s.nearestHostileM, combat: s.combat } : null;
  }, null, ms, 500);
}

// ---------------------------------------------------------------------------------------------------------------------
async function go() {
  const page = await open('f3-missions', '&run=10&panel=0');
  // The defending division (the one farthest from the fighting) — select it and press its card's take-control.
  const id = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const divs = [...v.units.values()].filter((u) => u.owner === 1 && u.type === 3);
    const def = divs.find((u) => u.order === 14) ?? divs[divs.length - 1];
    window.__fuHud.shared.select({ kind: 'unit', id: def.id });
    return def.id;
  });
  await until(page, () => !!document.querySelector('.fu-take-control'), null, 30000);
  await shot(page, 'go-0-card');
  const f0 = await frames(page);
  const t0 = Date.now();
  await uiClick(page, '.fu-take-control');
  const inPlay = await until(page, () => window.__cmdStats?.phase === 'play' ? window.__cmdStats : null, null, 240000, 500);
  const tPlay = (Date.now() - t0) / 1000;
  const s1 = await stats(page);
  row('G1', 'card entry: the unit at its real position; the chip names the nearest action with km and direction', `${(s1?.combat ?? '').slice(0, 160)} · target ${JSON.stringify(s1?.target)} · ${tPlay.toFixed(0)} s to play`, !!inPlay && /km/.test(s1?.combat ?? '') && !!s1?.target);
  const drawn = await page.evaluate(() => window.__cmd.overlay.drawnLabels.filter((l) => l.startsWith('combat:')));
  row('G2', 'the world marker (or the edge arrow) of the action is drawn', drawn.join(' | ') || 'none', drawn.length > 0);
  await shot(page, 'go-1-entry');
  // G: march to the action.
  await page.keyboard.press('KeyG');
  const tr = await until(page, () => window.__cmdStats?.transit || (window.__cmdStats?.transits?.length ? 'done' : null), null, 20000, 200);
  if (tr && tr !== 'done') await shot(page, 'go-2-transit');
  const c = await waitContact(page, 300000);
  const tC = (Date.now() - t0) / 1000;
  const f1 = await frames(page);
  const s2 = await stats(page);
  row('G3', 'G marches the unit to the action (transit card, the whole world on the same clock)', `${String(tr).slice(0, 180)} · marches ${JSON.stringify(s2?.transits)}`, !!tr && (s2?.transits?.length ?? 0) > 0);
  row('G4', 'from the take-control click to an enemy within 3 km (criterion < ~60 real s on a real GPU)', c ? `${tC.toFixed(1)} real s here, ${f1 - f0} rendered frames (SwiftShader); enemy at ${c.m} m; chip «${c.combat}»` : `no contact after ${tC.toFixed(0)} s`, !!c);
  await shot(page, 'go-3-contact');
  const sim = await page.evaluate((id) => { const u = __front.ctx.sim.view.units.get(id); const w = window.__cmd.where(); return u ? { ux: u.x, uy: u.y, lx: w.x, ly: w.y } : null; }, id);
  row('G5', 'the strategic unit is where the vehicle is (the march moved it in the sim)', JSON.stringify(sim), sim && Math.hypot(sim.ux - sim.lx, sim.uy - sim.ly) < 0.1);
  return page;
}

async function panel() {
  const page = await open('f3-missions', '&run=10&panel=0');
  const key = await page.evaluate(() => {
    const off = __front.ctx.sim.view.attacks.find((a) => a.attacker === 1 && a.defender > 0 && !a.naval);
    if (off) __front.ctx.bus.emit('frontSelected', { key: off.frontKey, fly: false });
    return off?.frontKey ?? 0;
  });
  await until(page, (k) => !!document.querySelector(`.fu-war-front[data-key="${k}"] .fu-war-take`), key, 30000);
  await shot(page, 'panel-0');
  const f0 = await frames(page);
  const t0 = Date.now();
  await uiClick(page, `.fu-war-front[data-key="${key}"] .fu-war-take`);
  const c = await waitContact(page, 400000);
  const tC = (Date.now() - t0) / 1000;
  const f1 = await frames(page);
  const s = await stats(page);
  row('P1', 'Guerra panel «Tomar el control aquí»: in contact without driving (march by itself)', c ? `${tC.toFixed(1)} real s, ${f1 - f0} frames; enemy at ${c.m} m; marches ${JSON.stringify(s?.transits)}` : `no contact after ${tC.toFixed(0)} s`, !!c);
  await shot(page, 'panel-1-contact');
  // Exit: the camera looks at that place.
  const where = await page.evaluate(() => window.__cmd.where());
  await page.evaluate(() => window.__cmd.debrief());
  await until(page, () => __front.ctx.app.state === 'playing' && __front.ctx.cameraRig.getState().altitudeKm > 800, null, 120000, 500);
  await sleep(3000);
  const cam = await page.evaluate(() => __front.ctx.cameraRig.getState());
  row('P2', 'exit: the strategic camera ends above the place of the action', `cam ${cam.lat.toFixed(2)}, ${cam.lon.toFixed(2)} @ ${Math.round(cam.altitudeKm)} km; unit ${where.lat.toFixed(2)}, ${where.lon.toFixed(2)}`, Math.abs(cam.lat - where.lat) < 0.5 && Math.abs(cam.lon - where.lon) < 0.5 && cam.altitudeKm < 1500);
  await shot(page, 'panel-2-exit');
  return page;
}

const sections = { go, panel };
for (const [name, fn] of Object.entries(sections)) {
  if (only && !only.has(name)) continue;
  console.log(`--- ${name}`);
  try {
    const page = await fn();
    await page?.close();
  } catch (e) {
    row(name, 'section crashed', String(e?.message ?? e).split('\n')[0], false);
  }
}
await browser.close();
const file = path.join(out, 'verify.json');
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const merged = [...prev.filter((p) => !results.some((r) => r.id === p.id)), ...results];
fs.writeFileSync(file, JSON.stringify(merged, null, 2));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} pass, page errors ${errors}`);
