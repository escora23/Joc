// Independent verifier (feedback #3, iteration 1): take control from the front badge (double click), from a unit
// card's «Al mando, a su misión», and exit with the real Escape key (decision dialog) — camera must look at the place.
//   node tools/_v3_entry.mjs --url http://127.0.0.1:5469/ --out shots/feedback3-verify-1/entry [--only badge,mission]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5469/';
const out = args.out || 'shots/feedback3-verify-1/entry';
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(out, { recursive: true });
const row = (id, what, value, pass) => console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${what} :: ${value}`);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(page, fn, arg, ms = 30000, every = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}
async function open(shot, params = '') {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`${base}?shot=${shot}${params}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
  await sleep(1500);
  return page;
}
const snap = (page, n) => page.screenshot({ path: path.join(out, `${n}.png`), timeout: 300000 }).catch(() => {});
const contact = (page, ms) => until(page, () => {
  const s = window.__cmdStats;
  return s && s.phase === 'play' && s.nearestHostileM > 0 && s.nearestHostileM < 4000 ? { m: s.nearestHostileM, combat: s.combat, transits: s.transits } : null;
}, null, ms, 500);

async function exitWithEsc(page, id) {
  const where = await page.evaluate(() => window.__cmd.where());
  await page.keyboard.press('Escape');
  const dlg = await until(page, () => document.querySelector('.fu-cmd-decide, .fu-cmd-dialog, [class*="decide"]')?.innerText?.slice(0, 200) || (window.__cmd?.overlay?.dialogOpen ? 'dialog' : null), null, 20000);
  row(`${id}x1`, 'Escape opens the exit decision', String(dlg).replace(/\s+/g, ' '), !!dlg);
  await snap(page, `${id}-exit-dialog`);
  // First option = leave (Enter).
  await page.keyboard.press('Enter');
  await sleep(3000);
  const ph = await page.evaluate(() => window.__cmdStats?.phase);
  if (ph === 'debrief') { await sleep(2000); await page.keyboard.press('Escape'); }
  const ok = await until(page, (w) => { const c = __front.ctx.cameraRig.getState(); return __front.ctx.app.state === 'playing' && c.altitudeKm > 300 && c.altitudeKm < 1500 && Math.abs(c.lon - w.lon) < 1.5 && Math.abs(c.lat - w.lat) < 1.5 ? c : null; }, where, 240000, 1000);
  await sleep(3000);
  const cam = await page.evaluate(() => ({ st: __front.ctx.app.state, c: __front.ctx.cameraRig.getState() }));
  row(`${id}x2`, 'exit by keyboard: strategic camera above the action', `phase ${ph}; state ${cam.st}; cam ${cam.c.lat.toFixed(2)},${cam.c.lon.toFixed(2)} @ ${Math.round(cam.c.altitudeKm)} km; unit ${where.lat.toFixed(2)},${where.lon.toFixed(2)}`, !!ok);
  await snap(page, `${id}-exit-cam`);
}

async function badge() {
  const page = await open('f3-missions', '&run=10&panel=0');
  const key = await page.evaluate(() => {
    const off = __front.ctx.sim.view.attacks.find((a) => a.attacker === 1 && a.defender > 0 && !a.naval);
    return off?.frontKey ?? 0;
  });
  const vis = await until(page, (k) => { const e = document.querySelector(`.fu-fb[data-key="${k}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, key, 30000);
  row('B0', 'front badge of our offensive visible', JSON.stringify(vis), !!vis);
  await snap(page, 'badge-0');
  if (!vis) return page;
  const t0 = Date.now();
  await page.mouse.dblclick(vis.x, vis.y);
  const play = await until(page, () => window.__cmdStats?.phase === 'play' ? true : null, null, 400000);
  const tp = (Date.now() - t0) / 1000;
  const c = await contact(page, 400000);
  const tc = (Date.now() - t0) / 1000;
  row('B1', 'double click on the front badge → in contact without driving', c ? `play at ${tp.toFixed(0)} s, contact at ${tc.toFixed(1)} s; enemy ${c.m} m; chip «${c.combat}»; marches ${JSON.stringify((c.transits ?? []).map((x) => Math.round(x.km)))}` : `play ${!!play}; no contact after ${tc.toFixed(0)} s`, !!c);
  await snap(page, 'badge-1-contact');
  if (c) await exitWithEsc(page, 'B');
  return page;
}

async function mission() {
  const page = await open('f3-missions', '&run=10&panel=0');
  // A division with a mission (join / defend / assault).
  const id = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const divs = [...v.units.values()].filter((u) => u.owner === 1 && u.type === 3 && u.order >= 14);
    const d = divs[0];
    if (!d) return 0;
    window.__fuHud.shared.select({ kind: 'unit', id: d.id });
    return d.id;
  });
  const btn = await until(page, () => { const b = document.querySelector('.fu-tc-mission:not(.fu-hidden)'); return b ? b.innerText : null; }, null, 30000);
  row('M0', 'unit card with a mission offers «Al mando, a su misión»', `unit ${id}: «${btn}»`, !!btn);
  await snap(page, 'mission-0');
  if (!btn) return page;
  const t0 = Date.now();
  await page.locator('.fu-tc-mission:not(.fu-hidden)').first().click();
  const c = await contact(page, 400000);
  const tc = (Date.now() - t0) / 1000;
  const s = await page.evaluate(() => ({ target: window.__cmdStats?.target, combat: window.__cmdStats?.combat, phase: window.__cmdStats?.phase, near: window.__cmdStats?.nearestHostileM }));
  row('M1', 'mission entry → at the mission / in contact', c ? `${tc.toFixed(1)} s; enemy ${c.m} m; «${c.combat}»` : `no contact after ${tc.toFixed(0)} s: ${JSON.stringify(s).slice(0, 300)}`, !!c);
  await snap(page, 'mission-1');
  if (c) await exitWithEsc(page, 'M');
  return page;
}

const sections = { badge, mission };
for (const [name, fn] of Object.entries(sections)) {
  if (only && !only.has(name)) continue;
  console.log(`--- ${name}`);
  try {
    const p = await fn();
    await p?.close();
  } catch (e) {
    row(name, 'crashed', String(e?.message ?? e).split('\n')[0], false);
  }
}
await browser.close();
