// Independent verifier (feedback #3, iteration 2): take control from the ground-battle strip («Tomar el control aquí»),
// the one entry point no builder tool drives. Real UI; nothing pressed after the click until contact; exit with Escape.
//   node tools/_v4_strip.mjs --url http://127.0.0.1:5469/ --out shots/feedback3-verify-2/strip
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5469/';
const out = args.out || 'shots/feedback3-verify-2/strip';
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
const snap = (page, n) => page.screenshot({ path: path.join(out, `${n}.png`), timeout: 300000 }).catch(() => {});

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`${base}?shot=f3-missions&run=10&panel=0`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
await sleep(1500);
// Down to our offensive's contact, as a player would with the battle pointer.
const p = await page.evaluate(() => {
  const v = __front.ctx.sim.view;
  const off = v.attacks.find((a) => a.attacker === 1 && a.defender > 0 && !a.naval);
  window.__front.ctx.sim.setSpeed(0);
  return off ? { cx: off.contactX, cy: off.contactY, x: off.x, y: off.y, key: off.frontKey } : null;
});
row('S0', 'our offensive exists', JSON.stringify(p), !!p);
const ptr = await until(page, () => __front.ctx.battle.pointer?.() ?? null, null, 20000);
// Use the pointer's own «Ir a la batalla» button when shown; else fly to the offensive's contact.
let flew = false;
const go = await until(page, () => { const b = document.querySelector('.fu-bpointer:not(.fu-hidden) button'); return b ? true : null; }, null, 5000);
if (go) { await page.locator('.fu-bpointer:not(.fu-hidden) button').first().click(); flew = 'pointer'; }
else {
  await page.evaluate((q) => {
    const ctx = __front.ctx;
    const off = ctx.sim.view.attacks.find((a) => a.attacker === 1 && a.defender > 0 && !a.naval);
    const x = off.contactX >= 0 ? off.contactX : off.x, y = off.contactX >= 0 ? off.contactY : off.y;
    // tile x/y → lat/lon (equirectangular map 0..MAP_W)
    const W = 1600, H = 800;
    const lon = (x / W) * 360 - 180, lat = 90 - (y / H) * 180;
    ctx.cameraRig.flyTo({ lat, lon, altitudeKm: 3, tilt: 1.12, heading: 0 }, 1500);
  }, p);
  flew = 'flyTo';
}
const strip = await until(page, () => { const e = document.querySelector('.fu-bstrip:not(.fu-hidden) .fu-bstrip-take'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 ? { text: document.querySelector('.fu-bstrip')?.innerText.replace(/\s+/g, ' ').slice(0, 220) } : null; }, null, 240000, 1000);
row('S1', `ground battle strip shows «Tomar el control aquí» (camera by ${flew}; pointer ${JSON.stringify(ptr)?.slice(0, 120)})`, JSON.stringify(strip), !!strip);
await snap(page, 'strip-0');
if (strip) {
  // 29a: the strip's advance and the badge of the same front must agree.
  const nums = await page.evaluate((k) => {
    const s = document.querySelector('.fu-bstrip')?.textContent ?? '';
    const b = document.querySelector(`.fu-fb[data-key="${k}"]`)?.textContent ?? '';
    return { strip: s.replace(/\s+/g, ' ').slice(0, 260), badge: b.replace(/\s+/g, ' ').slice(0, 260) };
  }, p?.key);
  const kmh = (t) => (t.match(/(\d+(?:[.,]\d+)?)\s*km\/h/) ?? [])[1];
  row('S1b', '29a: battle strip and front badge give the same km/h', `strip «${nums.strip}» | badge «${nums.badge}»`, kmh(nums.strip) !== undefined && kmh(nums.strip) === kmh(nums.badge));

  await page.evaluate(() => window.__front.ctx.sim.setSpeed(1));
  const t0 = Date.now();
  await page.locator('.fu-bstrip:not(.fu-hidden) .fu-bstrip-take').first().click();
  const play = await until(page, () => window.__cmdStats?.phase === 'play' ? true : null, null, 400000);
  const tp = (Date.now() - t0) / 1000;
  const c = await until(page, () => {
    const s = window.__cmdStats;
    return s && s.phase === 'play' && s.nearestHostileM > 0 && s.nearestHostileM < 4000 ? { m: s.nearestHostileM, combat: s.combat, transits: (s.transits ?? []).map((x) => ({ km: Math.round(x.km), legs: x.legs, short: x.short })), builds: (s.builds ?? []).length } : null;
  }, null, 400000);
  const tc = (Date.now() - t0) / 1000;
  const st = await page.evaluate(() => ({ phase: window.__cmdStats?.phase, near: window.__cmdStats?.nearestHostileM, combat: window.__cmdStats?.combat, et: window.__cmdStats?.entryTimes }));
  row('S2', 'battle strip → in command at the battle, contact without driving', c ? `play at ${tp.toFixed(1)} s, contact at ${tc.toFixed(1)} s; ${JSON.stringify(c)}` : `play ${!!play} at ${tp.toFixed(0)} s; no contact after ${tc.toFixed(0)} s: ${JSON.stringify(st).slice(0, 400)}`, !!c && tc < 150);
  await snap(page, 'strip-1-contact');
  // Exit.
  const where = await page.evaluate(() => window.__cmd?.where?.() ?? null);
  await page.keyboard.press('Escape');
  await sleep(2500);
  await page.keyboard.press('Enter');
  await sleep(3000);
  if (await page.evaluate(() => window.__cmdStats?.phase) === 'debrief') { await sleep(2000); await page.keyboard.press('Escape'); }
  const ok = where && await until(page, (w) => { const c = __front.ctx.cameraRig.getState(); return __front.ctx.app.state === 'playing' && c.altitudeKm > 300 && c.altitudeKm < 1500 && Math.abs(c.lon - w.lon) < 1.5 && Math.abs(c.lat - w.lat) < 1.5 ? c : null; }, where, 240000, 1000);
  const cam = await page.evaluate(() => ({ st: __front.ctx.app.state, c: __front.ctx.cameraRig.getState() }));
  row('S3', 'exit: strategic camera looking at the place', `${cam.st}; cam ${cam.c.lat.toFixed(2)},${cam.c.lon.toFixed(2)} @ ${Math.round(cam.c.altitudeKm)} km; unit ${JSON.stringify(where)}`, !!ok);
  await snap(page, 'strip-2-exit');
}
await browser.close();
