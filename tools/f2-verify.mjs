// Feedback #2 browser verifier (FEEDBACK-1 items 18-25, the parts not already covered by w5-verify / w6-verify).
// Drives the real game in Chromium (SwiftShader) on a staged but REAL war (?shot=air-front only issues sim commands
// and runs real ticks) through the real UI: the Guerra y frentes panel, its buttons, tooltips, the right-click chip.
//   node tools/f2-verify.mjs [--url http://127.0.0.1:5465/] [--out shots/feedback2/verify] [--only air,chip]
//
// air   #25: «Apoyo aéreo» lists own aircraft with ETA; its tooltip explains effect and threat; «Patrullar» and «Apoyar»
//       give the fighter a CAP and the drones close support over the front; after they arrive the front row says who
//       owns the sky; the offensive dialog shows the air row; with time running the REAL AI raids us and our patrol
//       shoots its aircraft down (unitDestroyed events by the human), and the AI escorts its bombers.
// chip  #25/#19: a selected fighter's right-click chip over enemy land explains the patrol and its risk; over a
//       nation at peace it is refused with the airspace reason.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5465/';
const out = args.out || 'shots/feedback2/verify';
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
  await page.goto(`${base}?shot=${shot}${params}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
  await page.waitForTimeout(1500);
  // Record every sim event the client re-emits on the bus (the same the alert feed reads).
  await page.evaluate(() => {
    window.__f2 = { destroyed: [], strikes: [], raids: [] };
    const bus = __front.ctx.bus;
    bus.on('unitDestroyed', (e) => window.__f2.destroyed.push(e));
    bus.on('strikeResult', (e) => window.__f2.strikes.push(e));
    bus.on('airRaid', (e) => window.__f2.raids.push(e));
  });
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), timeout: 300000 }).catch((e) => console.log(`   (screenshot ${name} failed: ${String(e?.message ?? e).split('\n')[0]})`));
async function uiClick(page, target, timeout = 20000) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target.first();
  try {
    await loc.click({ timeout: Math.min(timeout, 8000) });
    return;
  } catch (e) {
    if (!/not stable|Timeout/.test(String(e?.message ?? e))) throw e;
  }
  await loc.waitFor({ state: 'visible', timeout });
  const box = await loc.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function until(page, fn, arg, ms = 30000, every = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    await sleep(every);
  }
  return null;
}
/** Screen position (px) of lat/lon on the ground, as the game's camera projects it. */
function projectFn() {
  window.__proj = (lat, lon) => {
    const g = __front.ctx.globe;
    const r = g.surfaceRadiusAt(lat, lon);
    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    const cam = __front.ctx.camera;
    const x = r * Math.cos(la) * Math.cos(lo), y = r * Math.sin(la), z = -r * Math.cos(la) * Math.sin(lo);
    const e = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
    const vx = e[0] * x + e[4] * y + e[8] * z + e[12], vy = e[1] * x + e[5] * y + e[9] * z + e[13], vz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12], cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13], cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    return { x: ((cx / cw + 1) / 2) * window.innerWidth, y: ((1 - cy / cw) / 2) * window.innerHeight };
  };
}
const ORDER = { cap: 0, support: 0 };

async function air() {
  const page = await open('air-front');
  // Index of each order kind (UnitView.order) as the client knows it.
  const idx = await page.evaluate(async () => {
    const m = await import('/src/shared/types.ts');
    return { cap: m.UNIT_ORDER_KINDS.indexOf('cap'), support: m.UNIT_ORDER_KINDS.indexOf('support'), escort: m.UNIT_ORDER_KINDS.indexOf('escort') };
  });
  Object.assign(ORDER, idx);
  // A1: the panel's «Apoyo aéreo» list.
  await uiClick(page, '.fu-war-front .fu-war-airbtn');
  const list = await until(page, () => {
    const el = document.querySelector('.fu-war-airlist:not(.fu-hidden)');
    const items = el ? [...el.querySelectorAll('.fu-war-send')] : [];
    return items.length ? items.map((i) => i.innerText.replace(/\s+/g, ' ')) : null;
  }, null, 20000);
  row('A1', '«Apoyo aéreo» lists own aircraft with mission and ETA', (list ?? []).join(' | '), (list ?? []).length >= 3 && list.some((t) => /caza/.test(t)) && list.some((t) => /drones/.test(t)));
  await shot(page, 'a1-airlist');
  // A2: the tooltip of «Patrullar» explains the effect and the threat.
  const capBtn = page.locator('.fu-war-airlist .fu-war-send', { hasText: 'caza' }).first().locator('button');
  await capBtn.hover();
  const tipText = await until(page, () => {
    const t = [...document.querySelectorAll('.fu-tip-title')].map((x) => x.parentElement?.textContent ?? '').find((x) => /Patrullar/i.test(x));
    return t ? t.replace(/\s+/g, ' ') : null;
  }, null, 10000);
  row('A2', 'the Patrullar tooltip: effect, ETA and threat', (tipText ?? '').slice(0, 300), /superioridad aérea/.test(tipText ?? '') && /Amenaza/.test(tipText ?? ''));
  await shot(page, 'a2-tooltip');
  // A3: one click each.
  const before = await page.evaluate(() => [...__front.ctx.sim.view.units.values()].filter((u) => u.owner === 1 && (u.type === 4 || u.type === 5 || u.type === 6)).map((u) => ({ id: u.id, type: u.type, order: u.order })));
  await uiClick(page, capBtn);
  await sleep(800);
  const droneBtn = page.locator('.fu-war-airlist .fu-war-send', { hasText: 'drones' }).first().locator('button');
  // The list stays open after an order (several aircraft are often sent at once).
  await droneBtn.waitFor({ state: 'visible', timeout: 20000 });
  await uiClick(page, droneBtn);
  await page.evaluate(() => __front.ctx.sim.fastForward(2));
  const orders = await until(page, (o) => {
    const us = [...__front.ctx.sim.view.units.values()].filter((u) => u.owner === 1);
    const c = us.filter((u) => u.order === o.cap).length, s = us.filter((u) => u.order === o.support).length;
    return c >= 1 && s >= 1 ? { cap: c, support: s } : null;
  }, ORDER, 20000);
  row('A3', 'Patrullar / Apoyar give real orders (cap, support)', JSON.stringify(orders) + ` (before ${JSON.stringify(before.map((b) => b.order))})`, !!orders);
  // A4: they fly there; the row tells who owns the sky.
  await page.evaluate(() => __front.ctx.sim.fastForward(40));
  const sky = await until(page, () => {
    const el = document.querySelector('.fu-war-air');
    const v = __front.ctx.sim.view;
    const f = v.fronts.find((x) => (x.a === 1 || x.b === 1) && !x.quiet);
    return el && /superioridad aérea tuya/.test(el.textContent) ? { text: el.textContent, airA: f?.airA, airB: f?.airB, casA: f?.casA, casB: f?.casB, a: f?.a } : null;
  }, null, 60000);
  row('A4', 'the front row: our patrol owns the sky, drones counted', sky ? `${sky.text} (airA ${sky.airA}, airB ${sky.airB}, casA ${sky.casA}, casB ${sky.casB}, a=${sky.a})` : 'no superiority shown', !!sky);
  await shot(page, 'a4-sky');
  // A5: the offensive dialog's air row (Gestionar… opens the reinforce dialog of our running offensive).
  const manage = page.locator('.fu-war-front .fu-war-actions button', { hasText: /Gestionar|Ofensiva/ }).first();
  let dlg = '';
  if (await manage.count()) {
    await uiClick(page, manage);
    dlg = (await until(page, () => {
      const d = [...document.querySelectorAll('.fu-offdlg-row')].map((r) => r.innerText.replace(/\s+/g, ' ')).find((x) => /Apoyo aéreo/.test(x));
      return d ?? null;
    }, null, 15000)) ?? '';
    await shot(page, 'a5-dialog');
    await page.keyboard.press('Escape');
  }
  row('A5', 'the offensive dialog shows the air support it counts', dlg, /cielo tuyo/.test(dlg));
  // A6: time runs; the real AI raids us across the border; our patrol intercepts.
  const t0 = await page.evaluate(() => __front.ctx.sim.view.tick);
  await page.evaluate(() => { __front.ctx.app.setSpeed(4); });
  const t1 = Date.now();
  let st = null;
  const sorties = new Set();
  while (Date.now() - t1 < 420000) {
    await sleep(3000);
    for (const id of await page.evaluate(() => [...__front.ctx.sim.view.units.values()].filter((u) => u.owner !== 1 && (u.type === 5 || u.type === 6) && u.mode === 11).map((u) => u.id))) sorties.add(id);
    st = await page.evaluate((t0) => {
      const v = __front.ctx.sim.view;
      const w = window.__f2;
      return {
        ticks: v.tick - t0,
        raids: w.raids.filter((e) => e.target === 1).length,
        shot: w.destroyed.filter((e) => e.owner !== 1 && e.by === 1 && (e.unit === 5 || e.unit === 6)).length,
        fightersShot: w.destroyed.filter((e) => e.owner !== 1 && e.by === 1 && e.unit === 4).length,
        lostAir: w.destroyed.filter((e) => e.owner === 1 && (e.unit === 4 || e.unit === 5 || e.unit === 6)).length,
        hits: w.strikes.filter((e) => e.victim === 1).length,
        escorts: [...v.units.values()].filter((u) => u.owner !== 1 && u.type === 4 && u.mode === 10).length,
      };
    }, t0);
    st.sorties = sorties.size;
    if (st.ticks > 1500 || (st.shot >= 2 && st.ticks > 300)) break;
  }
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  row('A6', 'with time running the AI flies its bombers/drones at us and our patrol shoots them down (enemy bombers/drones only fly on AI orders)', JSON.stringify(st), st && st.shot >= 1);
  await shot(page, 'a6-after');
  // A7: the patrol's fuel. On station its Fuerzas row shows the fuel left; when it runs out the squadron flies home
  // to refuel and goes back to the same station by itself (the row says so at each step).
  const capId = await page.evaluate((o) => [...__front.ctx.sim.view.units.values()].find((u) => u.owner === 1 && u.type === 4 && u.order === o.cap)?.id ?? -1, ORDER);
  const seen = [];
  for (let i = 0; i < 40 && capId >= 0; i++) {
    const r = await page.evaluate((id) => window.__fuForces.rows().find((x) => x.id === id)?.state ?? '(gone)', capId);
    if (seen[seen.length - 1] !== r) seen.push(r);
    if (seen.some((x) => /Repostando/.test(x)) && /combustible/.test(r) && seen.findIndex((x) => /Repostando/.test(x)) < seen.length - 1) break;
    await page.evaluate(() => __front.ctx.sim.fastForward(15));
    await sleep(700);
  }
  const iFuel = seen.findIndex((x) => /combustible/.test(x)), iHome = seen.findIndex((x) => /Vuelve a repostar/.test(x));
  const iRearm = seen.findIndex((x) => /Repostando/.test(x)), iBack = seen.findLastIndex((x) => /combustible/.test(x));
  row('A7', 'the patrol shows its fuel, flies home to refuel and goes back by itself', `unit ${capId}: ${seen.join(' → ')}`, iFuel >= 0 && iHome > iFuel && iRearm > iHome && iBack > iRearm);
  await page.close();
}

async function chip() {
  const page = await open('air-front', '&panel=0');
  await page.evaluate(projectFn);
  // Select one of our fighters (the airbase card / Fuerzas panel do the same select).
  const id = await page.evaluate(() => {
    const u = [...__front.ctx.sim.view.units.values()].find((x) => x.owner === 1 && x.type === 4);
    if (u) window.__fuHud.shared.select({ kind: 'unit', id: u.id });
    return u?.id ?? -1;
  });
  // Hover enemy land north of the front (the enemy at war), read the chip.
  const readChip = async (lat, lon) => {
    const p = await page.evaluate(([la, lo]) => window.__proj(la, lo), [lat, lon]);
    await page.mouse.move(p.x, p.y);
    await sleep(400);
    await page.mouse.move(p.x + 2, p.y + 1);
    return (await until(page, () => {
      const c = document.querySelector('.fu-chip:not(.fu-hidden)');
      return c && c.innerText.trim().length > 4 ? c.innerText.replace(/\s+/g, ' ') : null;
    }, null, 20000, 400)) ?? '';
  };
  const war = await readChip(45.3, 0.6);
  row('C1', 'fighter over enemy land at war: the chip explains the patrol and its risk', `unit ${id}: ${war}`, /Patrulla/i.test(war) && /Riesgo/i.test(war));
  await shot(page, 'c1-chip-war');
  // A nation at peace: the nearest other capital that is not at war with us.
  const peace = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const atWar = new Set(v.wars.flatMap((w) => [w.aggressor, w.target]));
    const p = v.playerList.find((q) => q.alive && q.kind === 'nation' && q.id !== 1 && !atWar.has(q.id) && q.capitalTile >= 0 && Math.abs(Math.floor(q.capitalTile / 1600) - 190) < 120);
    if (!p) return null;
    const x = (p.capitalTile % 1600) + 0.5, y = Math.floor(p.capitalTile / 1600) + 0.5;
    return { id: p.id, lat: 90 - (y / 800) * 180, lon: (x / 1600) * 360 - 180 };
  });
  if (peace) {
    await page.evaluate((p) => __front.ctx.cameraRig.setState({ lat: p.lat, lon: p.lon, altitudeKm: 2500, tilt: 0, heading: 0 }), peace);
    await sleep(3000);
    const txt = await readChip(peace.lat, peace.lon);
    row('C2', 'fighter over a nation at peace: refused, with the airspace reason', txt, /Espacio aéreo/i.test(txt));
    await shot(page, 'c2-chip-peace');
  } else row('C2', 'fighter over a nation at peace', 'no nation at peace found', false);
  await page.close();
}

const sections = { air, chip };
for (const [name, fn] of Object.entries(sections)) {
  if (only && !only.has(name)) continue;
  const t = Date.now();
  try {
    await fn();
  } catch (e) {
    row(name, 'section crashed', String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '), false);
  }
  console.log(`[f2-verify] ${name} ${((Date.now() - t) / 1000).toFixed(0)} s`);
}
await browser.close();
const fail = results.filter((r) => !r.pass).length;
console.log(`[f2-verify] ${results.length - fail}/${results.length} pass, ${errors} page errors`);
const file = path.join(out, 'verify.json');
let prev = [];
try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
const merged = [...prev.filter((p) => !results.some((r) => r.id === p.id)), ...results];
fs.writeFileSync(file, JSON.stringify(merged, null, 2));
process.exit(fail ? 1 : 0);
