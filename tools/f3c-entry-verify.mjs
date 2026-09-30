// Feedback #3 fix pass 2 (items 26 and 29e): the front-based ways into command mode reach contact WITHOUT driving.
// Real UI on the staged real war of `?shot=f3-missions` (Chromium/SwiftShader); nothing is pressed after the entry
// click (no G, no keys). Per entry it reports the phases: click → first frame of play, the march (legs, km, real s,
// why it stopped), every scene build (entry and any rebuild), and the time to the first enemy within 4 km.
//   node tools/f3c-entry-verify.mjs [--url http://127.0.0.1:5467/] [--out shots/feedback3-fix-2/entry] [--only panel,badge,mission,front]
//
// panel    Guerra panel «Tomar el control aquí» on our offensive's front.
// badge    double click on that front's badge on the map.
// mission  «Al mando, a su misión» on the card of a division that joined the offensive.
// front    a division already standing at the front (within 15 km of the line) taken from the badge of its front:
//          the march (if any) runs behind the entry fade and the scene is built once (no rebuild after the march).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5467/';
const out = args.out || 'shots/feedback3-fix-2/entry';
const only = args.only ? new Set(args.only.split(',')) : null;
const CONTACT_MS = +(args.contactMs || 300000);
fs.mkdirSync(out, { recursive: true });
let pass = 0, fail = 0, errors = 0;
const row = (id, what, value, ok) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${what} :: ${value}`);
};
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(page, fn, arg, ms = 30000, every = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}
async function open() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => { errors++; console.log(`[pageerror] ${e.message}`); });
  page.on('console', (m) => { if (/\[command\] (march|failed)/.test(m.text())) console.log(`   ${m.text().slice(0, 420)}`); });
  await page.goto(`${base}?shot=f3-missions&run=10&panel=0`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
  await sleep(1500);
  if (args.debug) await page.evaluate(() => { window.__marchDebug = true; });
  await page.evaluate(() => {
    window.__ev = { frames: 0, playAt: 0, contactAt: 0 };
    const loop = () => {
      window.__ev.frames++;
      const s = window.__cmdStats;
      if (s?.phase === 'play' && !window.__ev.playAt) window.__ev.playAt = performance.now();
      if (s?.phase === 'play' && s.nearestHostileM > 0 && s.nearestHostileM < 4000 && !window.__ev.contactAt) window.__ev.contactAt = performance.now();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  return page;
}
const snap = (page, n) => page.screenshot({ path: path.join(out, `${n}.png`), timeout: 300000 }).catch(() => {});
const ourOffensive = (page) => page.evaluate(() => {
  const off = __front.ctx.sim.view.attacks.find((a) => a.attacker === 1 && a.defender > 0 && !a.naval && a.contactX >= 0);
  return off ? { key: off.frontKey, id: off.id } : null;
});

/** From the click (t0 = performance.now() in the page) until contact: the phases and the verdict. */
async function measure(page, id, what, t0) {
  const c = await until(page, () => window.__ev.contactAt ? true : null, null, CONTACT_MS, 500);
  const r = await page.evaluate((t0) => {
    const s = window.__cmdStats ?? {};
    return {
      play: window.__ev.playAt ? (window.__ev.playAt - t0) / 1000 : -1,
      contact: window.__ev.contactAt ? (window.__ev.contactAt - t0) / 1000 : -1,
      frames: window.__ev.frames, near: s.nearestHostileM, combat: s.combat, transits: s.transits ?? [], builds: s.builds ?? [],
      et: s.entryTimes ? { enter: (s.entryTimes.enter - t0) / 1000, march: (s.entryTimes.marchEnd - s.entryTimes.enter) / 1000, build: (s.entryTimes.buildEnd - s.entryTimes.marchEnd) / 1000, intro: (s.entryTimes.play - s.entryTimes.buildEnd) / 1000, introFrames: s.entryTimes.introFrames } : null,
    };
  }, t0);
  const marchS = r.transits.reduce((a, x) => a + x.realMs / 1000, 0);
  const km = r.transits.reduce((a, x) => a + x.km, 0);
  const legs = r.transits.reduce((a, x) => a + (x.legs ?? 1), 0);
  const b = r.builds.map((x) => `${(x.ms / 1000).toFixed(1)} s${x.relocating ? ' (rebuild)' : ''}`).join(' + ') || 'none';
  const et = r.et ? `phases: click → command mode ${r.et.enter.toFixed(1)} s, march ${r.et.march.toFixed(1)} s, scene build ${r.et.build.toFixed(1)} s, intro ${r.et.intro.toFixed(1)} s (${r.et.introFrames} frames), play → contact ${(r.contact - r.play).toFixed(1)} s; ` : '';
  const phases = `${et}march ${legs} legs ${km.toFixed(1)} km in ${marchS.toFixed(1)} real s [${r.transits.map((x) => `${x.stop}${x.short ? '/' + x.short : ''}`).join(', ')}]; scene builds ${b}; first frame of play at ${r.play.toFixed(1)} s`;
  row(id, what, c ? `contact at ${r.contact.toFixed(1)} real s, enemy ${r.near} m; ${phases}; chip «${String(r.combat).slice(0, 90)}»` : `no contact after ${CONTACT_MS / 1000} s; ${phases}; chip «${String(r.combat).slice(0, 140)}»`, !!c);
  row(`${id}b`, 'one scene build (no rebuild after the march)', b, r.builds.length === 1);
  return r;
}

async function panel() {
  const page = await open();
  const off = await ourOffensive(page);
  if (!off) { row('P0', 'our offensive exists', 'none', false); return page; }
  await page.evaluate((k) => __front.ctx.bus.emit('frontSelected', { key: k, fly: false }), off.key);
  const ok = await until(page, (k) => !!document.querySelector(`.fu-war-front[data-key="${k}"] .fu-war-take`), off.key, 30000);
  row('P0', 'Guerra panel row of our offensive offers «Tomar el control aquí»', `front ${off.key}`, !!ok);
  if (!ok) return page;
  await snap(page, 'panel-0');
  const t0 = await page.evaluate(() => performance.now());
  await page.locator(`.fu-war-front[data-key="${off.key}"] .fu-war-take`).first().click();
  await measure(page, 'P1', 'Guerra panel «Tomar el control aquí» → contact without driving', t0);
  await snap(page, 'panel-1-contact');
  return page;
}

async function badge() {
  const page = await open();
  const off = await ourOffensive(page);
  const vis = off && await until(page, (k) => { const e = document.querySelector(`.fu-fb[data-key="${k}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, off.key, 30000);
  row('B0', 'front badge of our offensive visible', JSON.stringify(vis), !!vis);
  if (!vis) return page;
  await snap(page, 'badge-0');
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.dblclick(vis.x, vis.y);
  await measure(page, 'B1', 'double click on the front badge → contact without driving', t0);
  await snap(page, 'badge-1-contact');
  return page;
}

async function mission() {
  const page = await open();
  const id = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const d = [...v.units.values()].find((u) => u.owner === 1 && u.type === 3 && u.order >= 0 && u.mission > 0 && v.attacks.some((a) => a.id === u.mission));
    if (!d) return 0;
    window.__fuHud.shared.select({ kind: 'unit', id: d.id });
    return d.id;
  });
  const btn = id && await until(page, () => { const b = document.querySelector('.fu-tc-mission:not(.fu-hidden)'); return b ? b.innerText : null; }, null, 30000);
  row('M0', 'card of a division that joined the offensive offers «Al mando, a su misión»', `unit ${id}: «${btn}»`, !!btn);
  if (!btn) return page;
  await snap(page, 'mission-0');
  const t0 = await page.evaluate(() => performance.now());
  await page.locator('.fu-tc-mission:not(.fu-hidden)').first().click();
  await measure(page, 'M1', '«Al mando, a su misión» → contact without driving', t0);
  await snap(page, 'mission-1-contact');
  return page;
}

/** A division already at the front: its front's badge takes it (it is the one engaged there). */
async function front() {
  const page = await open();
  const pick = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    // Our divisions holding a front (mode Front = 2? use frontKey), nearest to their front's samples.
    let best = null;
    for (const u of v.units.values()) {
      if (u.owner !== 1 || u.type !== 3 || !(u.hp > 0) || !u.frontKey) continue;
      const f = v.frontByKey.get(u.frontKey);
      if (!f) continue;
      let d = Infinity;
      for (let i = 0; i + 1 < f.samples.length; i += 2) d = Math.min(d, Math.hypot(f.samples[i] - u.x, f.samples[i + 1] - u.y));
      if (!best || d < best.d) best = { id: u.id, key: u.frontKey, d };
    }
    if (!best) return null;
    // Only this division is eligible: the others are parked out of the way of the choice (held, far from the front).
    return best;
  });
  row('F0', 'a division standing at its front', JSON.stringify(pick), !!pick && pick.d < 0.8);
  if (!pick) return page;
  await page.evaluate((k) => __front.ctx.bus.emit('frontSelected', { key: k, fly: false }), pick.key);
  const ok = await until(page, (k) => !!document.querySelector(`.fu-war-front[data-key="${k}"] .fu-war-take`), pick.key, 30000);
  if (!ok) { row('F1', 'Guerra row', 'no «Tomar el control aquí»', false); return page; }
  const t0 = await page.evaluate(() => performance.now());
  await page.locator(`.fu-war-front[data-key="${pick.key}"] .fu-war-take`).first().click();
  await until(page, () => window.__cmd?.params ? true : null, null, 60000, 200);
  const chosen = await page.evaluate(() => window.__cmd.params?.unitId ?? 0);
  console.log(`   chosen unit ${chosen} (the division at the front: ${pick.id})`);
  await measure(page, 'F1', 'a division at the front → contact without driving', t0);
  await snap(page, 'front-1-contact');
  return page;
}

const sections = { panel, badge, mission, front };
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
console.log(`\n${pass}/${pass + fail} passed, ${errors} page errors`);
await browser.close();
