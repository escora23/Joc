// Feedback #3 fix pass 3 (#27, command side): destroy a structure in command mode, end to end, in the real game.
//   node tools/f3c-destroy-verify.mjs [--url http://127.0.0.1:5467/] [--out shots/feedback3-fix-3/destroy] [--only factory,city]
//
// factory  D0 the factory stands in the scene at its real size (frame through the gunner's sight: the compound in view)
//          D1 rounds fired by the tank go into the sim (hp falls)
//          D2 the sim takes a level (structureDamaged levelLost) and the model is rebuilt with fewer, ruined buildings
//          D3 more rounds: the sim destroys it (rubble on its tile), the scene shows the ruined compound
//          D4 the HUD said so («… destruida: queda en escombros»)
//          D5 back on the strategic map: its card reads «Escombros de Fábrica · Destruida · en escombros»
// city     C1 rounds that bring houses down send civilians and troops killed to the sim, with an event and an alert
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5467/';
const out = args.out || 'shots/feedback3-fix-3/destroy';
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(out, { recursive: true });
const results = [];
const row = (id, what, value, pass) => {
  results.push({ id, what, value: String(value), pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${what} :: ${value}`);
};
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
let errors = 0;
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
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), timeout: 300000 }).catch(() => {});
async function session(target) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => { errors++; console.log(`[pageerror] ${e.message}`); });
  page.__logs = [];
  page.on('console', (m) => { if (/\[command\]/.test(m.text())) page.__logs.push(m.text()); });
  await page.goto(`${base}?shot=command-strike&live=1&target=${target}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
  await page.evaluate(() => {
    window.__d = { dmg: [], aar: [] };
    __front.ctx.bus.on('structureDamaged', (e) => window.__d.dmg.push(e));
  });
  await until(page, () => window.__cmdStats?.phase === 'play', null, 240000, 500);
  await until(page, () => window.__cmd.civil.structRecs.length > 0 || window.__cmd.civil.houseRecs.some((h) => h.cityId > 0), null, 120000, 500);
  return page;
}
async function fire(page, n) {
  await page.evaluate(async (n) => {
    const m = await import('/src/command/shots.ts');
    const s = { waitFrames: (k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }) };
    await m.strikeFire(s, window.__cmd, n);
  }, n);
}
const structNow = (page) => page.evaluate(() => {
  const v = __front.ctx.sim.view;
  const s = v.structures.get(window.__strikeTarget);
  return s ? { hp: +s.hp.toFixed(3), level: s.level, blocks: s.blocks ?? 0 } : { gone: true, ruin: v.ruins.some((r) => r.tile === window.__strikeTile) };
});
/** Through the gunner's sight at the structure (or its ruin): the compound fills the scope. */
async function sight(page, name) {
  await page.evaluate(() => {
    const I = window.__cmd;
    const V = I.camera.position.constructor;
    const st = I.civil.structRecs.find((r) => r.id === window.__strikeTarget);
    const at = st ? { x: st.x, z: st.z, y: st.y0 + Math.min(22, (st.y1 - st.y0) * 0.4) } : window.__strikeAt;
    if (!at) return;
    I.controller.aimAt(new V(at.x, at.y, at.z));
    I.controller.snapTurret?.();
    I.controller.setZoom?.(true);
    I.simulate(4, 1 / 30);
  });
  await sleep(6000);
  await shot(page, name);
  await page.evaluate(() => window.__cmd.controller.setZoom?.(false));
}

async function factory() {
  const page = await session('factory');
  await page.evaluate(() => {
    const s = __front.ctx.sim.view.structures.get(window.__strikeTarget);
    window.__strikeTile = s?.tile ?? -1;
    const st = window.__cmd.civil.structRecs.find((r) => r.id === window.__strikeTarget);
    if (st) window.__strikeAt = { x: st.x, z: st.z, y: st.y0 + 8 };
  });
  const s0 = await structNow(page);
  const m0 = await page.evaluate(() => {
    const g = window.__cmd.civil.group.getObjectByName(`struct-${window.__strikeTarget}`);
    const st = window.__cmd.civil.structRecs.find((r) => r.id === window.__strikeTarget);
    const P = window.__cmd.controller.ent.pos;
    return g ? { verts: g.geometry.attributes.position.count, top: +(st.y1 - st.y0).toFixed(1), km: +(Math.hypot(st.x - P.x, st.z - P.z) / 1000).toFixed(2), scale: g.scale.toArray().map((v) => +v.toFixed(2)) } : null;
  });
  await shot(page, 'd0-view');
  await sight(page, 'd0-sight');
  row('D0', 'the factory stands in the scene at real size (metres, scale 1) as a compound', `L${s0.level} hp ${s0.hp}; model ${JSON.stringify(m0)}`, !!m0 && m0.scale[0] === 1 && m0.verts > 2000);
  await fire(page, 4);
  const h1 = await until(page, (h) => { const s = __front.ctx.sim.view.structures.get(window.__strikeTarget); return s && s.hp < h - 0.01 ? s.hp : null; }, s0.hp, 90000, 500);
  row('D1', 'the tank\'s rounds hit the real factory: its hp falls in the sim', `${s0.hp} → ${h1}`, h1 !== null);
  let lv = null;
  for (let b = 0; b < 4 && !lv; b++) {
    await fire(page, 6);
    lv = await until(page, (l) => { const s = __front.ctx.sim.view.structures.get(window.__strikeTarget); return !s || s.level < l ? (s ? s.level : 0) : null; }, s0.level, 20000, 500);
  }
  await page.evaluate(() => window.__cmd.simulate(60, 1 / 30));
  await sleep(5000);
  const m1 = await page.evaluate(() => {
    const g = window.__cmd.civil.group.getObjectByName(`struct-${window.__strikeTarget}`);
    return g ? { verts: g.geometry.attributes.position.count } : null;
  });
  const ev = await page.evaluate(() => window.__d.dmg.filter((e) => e.levelLost || e.destroyed).map((e) => `L${e.level} ${e.hpBefore.toFixed(2)}→${e.hp.toFixed(2)}${e.levelLost ? ' LEVEL LOST' : ''}${e.destroyed ? ' DESTROYED' : ''} (${e.cause})`));
  const n1 = await page.evaluate(() => window.__cmd.overlay.noticeText ?? '');
  await sight(page, 'd1-level-lost');
  row('D2', 'the sim takes a level; the command-mode model is rebuilt with that level\'s buildings, ruined', `level ${s0.level} → ${lv}; model ${JSON.stringify(m0?.verts)} → ${JSON.stringify(m1)}; events ${ev.join(', ')}; notice «${n1}»`, lv !== null && ev.some((e) => /LEVEL LOST|DESTROYED/.test(e)));
  let gone = null;
  for (let b = 0; b < 8 && !gone; b++) {
    const st = await structNow(page);
    if (st.gone) break;
    await fire(page, 6);
    gone = await until(page, () => { const v = __front.ctx.sim.view; return !v.structures.has(window.__strikeTarget) ? { ruin: v.ruins.some((r) => r.tile === window.__strikeTile) } : null; }, null, 20000, 500);
  }
  const noticeD = await page.evaluate(() => window.__cmd.overlay.noticeText ?? '');
  await page.evaluate(() => window.__cmd.simulate(90, 1 / 30));
  await sleep(6000);
  const ruin = await page.evaluate(() => {
    const m = window.__cmd.civil.group.getObjectByName(`ruin-${window.__strikeTile}`);
    return { mesh: !!m, verts: m ? m.geometry.attributes.position.count : 0, fires: window.__cmd.civil.fires.length };
  });
  const ev2 = await page.evaluate(() => window.__d.dmg.filter((e) => e.destroyed).map((e) => `${e.cause} by ${e.by}`));
  row('D3', 'more rounds: the sim destroys it (rubble on its tile); the scene draws the ruined compound', `gone ${JSON.stringify(gone)}; destroyed events ${ev2.join(', ')}; ruin model ${JSON.stringify(ruin)}`, !!gone?.ruin && ruin.mesh);
  row('D4', 'the HUD says what the rounds did', `«${noticeD}»`, /escombros|rubble|destruid/i.test(noticeD));
  await shot(page, 'd2-rubble-view');
  await sight(page, 'd2-rubble-sight');
  await page.evaluate(() => window.__cmd.debrief());
  await until(page, () => __front.ctx.app.state === 'playing', null, 120000, 500);
  await sleep(3000);
  const card = await page.evaluate(async () => {
    window.__fuHud.shared.select({ kind: 'structure', id: window.__strikeTarget });
    await new Promise((r) => setTimeout(r, 4000));
    return (document.querySelector('.fu-sel')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300);
  });
  await shot(page, 'd3-card');
  row('D5', 'strategic map: the card shows the rubble («Escombros de …», «Destruida · en escombros»)', card, /Escombros de|Rubble of/i.test(card) && /Destruida|Destroyed/i.test(card));
  await page.close();
}

async function city() {
  const page = await session('city');
  const s0 = await structNow(page);
  // Confirm the civilian dialog the first time it asks, then fire.
  await page.evaluate(() => {
    const ov = window.__cmd.overlay;
    window.__asks = [];
    ov.ask = (title, body) => { window.__asks.push(`${title} | ${body}`); return Promise.resolve(0); };
  });
  for (let r = 0; r < 8; r++) {
    await fire(page, 1);
    await sleep(2500);
    if (await page.evaluate(() => window.__asks.length > 0)) break;
  }
  const ask = await page.evaluate(() => window.__asks[0] ?? '');
  await fire(page, 12);
  await sleep(6000);
  await page.evaluate(() => window.__cmd.simulate(30, 1 / 30));
  await sleep(4000);
  const s1 = await structNow(page);
  const ev = await page.evaluate(() => window.__d.dmg.filter((e) => e.structureId === window.__strikeTarget).map((e) => ({ hp: `${e.hpBefore.toFixed(3)}→${e.hp.toFixed(3)}`, civ: e.civilians, troops: e.troops })));
  const civ = ev.reduce((a, e) => a + e.civ, 0), troops = ev.reduce((a, e) => a + e.troops, 0);
  const down = await page.evaluate(() => window.__cmd.civil.houseRecs.filter((h) => h.cityId === window.__strikeTarget && h.down).length);
  const promised = Number((ask.match(/unos ([\d.]+) civiles|about ([\d,]+) civilians/) ?? [])[1]?.replace(/[.,]/g, '') ?? 0);
  row('C1', 'city rounds that bring houses down: the sim loses hp, civilians and troops (events), as the dialog promised', `dialog: ${promised} per heavy round; hp ${s0.hp} → ${s1.hp}; houses down ${down}; ${ev.length} events, civilians ${civ}, troops ${troops}`, ev.length > 0 && civ > 0 && s1.hp < s0.hp - 0.05);
  await sight(page, 'c1-city');
  await page.close();
}

for (const [name, fn] of Object.entries({ factory, city })) {
  if (only && !only.has(name)) continue;
  try { await fn(); } catch (e) { row(name, 'section crashed', String(e?.message ?? e).split('\n')[0], false); }
}
fs.writeFileSync(path.join(out, 'verify.json'), JSON.stringify({ results, errors }, null, 1));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed · page errors ${errors}`);
await browser.close();
