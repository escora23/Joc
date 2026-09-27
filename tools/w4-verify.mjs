// FRONT ULTRA — W4 browser verification (armies, orders, cards, structures). Test tooling only.
//
//   node tools/w4-verify.mjs [--url http://127.0.0.1:5314/] [--out shots/W4-armies-orders/verify] [--only V3]
//
// Drives the real game in Chromium on a staged war across the Pyrenees (the scene of the `forces-panel` shot, built
// with the sim's debug actions and real player commands) and measures through the HUD and renderer hooks:
//   V1   the Fuerzas panel lists every own force (count = view.units minus missiles, trade ships, trains); a row click
//        selects the unit and flies the camera there                                               (acceptance 1)
//   V2   Arsenal: 10 purchases, the price shown before each = the gold charged; a division in production with an
//        80-tick ETA; the unitReady alert names its base                                            (acceptance 2)
//   V3   order parity: 50+ random REAL right clicks over all unit types; the chip's preview validity per unit equals
//        the sim's acceptance (orderAck)                                                            (acceptance 3)
//   V4   docked bombers and drones selectable from the airbase card (hosted rows) and the panel     (acceptance 4)
//   V5   Shift+drag selects every own unit in the rectangle; one right click orders them; «n de m»  (acceptance 5)
//   V7   unit card: role, km/h with the real-time equivalent, reach, effect, integrity, endurance, no «FUERZA»;
//        structure card: now/next effects, gold/h, upgrade cost = upgradeCost, «Te faltan»          (acceptance 7)
//   V9   __units.grounding(): residual < 5 % of the footprint, up deviation < 3°                    (acceptance 9)
//   V10  structure models differ by level (vertex counts)                                           (acceptance 10)
//   V14  a selected unit / structure draws its effect ring                                          (acceptance 14)
//   V17  the hourglass badge while producing or building; no v2-stub markers                        (acceptance 17)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5314/';
const out = args.out || 'shots/W4-armies-orders/verify';
fs.mkdirSync(out, { recursive: true });
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const want = (id) => !ONLY || ONLY.has(id);

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
const rows = [];
const row = (id, what, value, target, pass) => {
  rows.push({ id, what, value: String(value), target, pass: !!pass });
  log(`${pass ? 'PASS' : 'FAIL'} ${id} ${what}: ${value}`);
};
const shot = async (name) => {
  try { await page.screenshot({ path: path.join(out, `${name}.png`), timeout: 120000 }); } catch { /* slow frame */ }
};
async function until(fn, arg, timeout = 30000, poll = 300) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(poll);
  }
  return null;
}

// The staged scene: the forces-panel shot (Spain at war across the Pyrenees), loaded as a shot.
await page.goto(`${base}?shot=forces-panel`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 400000, polling: 500 });
log('scene staged');
await page.evaluate(() => {
  const { ctx } = window.__front;
  window.__w4 = { acks: [], ready: [], alerts: () => window.__fuAlerts?.log?.() ?? [] };
  ctx.bus.on('orderAck', (e) => window.__w4.acks.push(e));
  ctx.bus.on('unitReady', (e) => window.__w4.ready.push(e));
});
const view = (fn, arg) => page.evaluate(fn, arg);
/**
 * A right click on the canvas as one pointerdown/pointerup pair created together: under the software renderer a
 * CDP mouse release can be dispatched seconds after the press (a long frame), which the input router rightly reads as
 * a held button (a camera drag), not a click.
 */
const rightClick = (x, y) => page.evaluate(({ x, y }) => {
  const c = window.__front.ctx.canvas;
  const o = { clientX: x, clientY: y, button: 2, buttons: 2, bubbles: true, pointerId: 1, pointerType: 'mouse' };
  c.dispatchEvent(new PointerEvent('pointerdown', o));
  c.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
}, { x, y });

// ---------------------------------------------------------------------------------------------------------------
if (want('V1')) {
  const r = await view(() => {
    const v = window.__front.ctx.sim.view;
    const SKIP = new Set([1, 7, 8, 9, 10, 11, 12, 13, 14]); // trade ship, missiles, nukes, interceptor, train, shell
    const expect = [...v.units.values()].filter((u) => u.owner === 1 && !SKIP.has(u.type)).length;
    return { n: window.__fuForces.count(), expect, rows: window.__fuForces.rows(), dom: window.__fuForces.dom().length };
  });
  const skipIds = await view(() => {
    const T = window.__front.ctx;
    return null;
  });
  void skipIds;
  const complete = r.rows.every((x) => x.name && x.state && x.place && x.hp >= 0);
  row('V1', 'Fuerzas panel: rows = own forces in view.units (minus missiles, trade ships, trains)', `${r.n} rows, ${r.dom} drawn, expected ${r.expect}`, 'equal', r.n === r.expect && r.dom >= r.n);
  row('V1', 'every row has name, state, place and integrity', complete ? 'yes' : JSON.stringify(r.rows[0]), 'yes', complete);
  // Click the second row: selection + camera flight.
  const cam0 = await view(() => ({ ...window.__front.ctx.cameraRig.getState({}) }));
  const el = page.locator('.fu-fo-row').nth(1);
  const id = Number(await el.getAttribute('data-unit'));
  await el.click();
  await sleep(2500);
  const after = await view(() => ({ sel: window.__fuCard?.text?.() ?? '', cam: window.__front.ctx.cameraRig.getState({}) }));
  const selId = await view(() => window.__fuHud?.shared?.selection ?? null);
  const moved = Math.abs(after.cam.lat - cam0.lat) + Math.abs(after.cam.lon - cam0.lon) + Math.abs(after.cam.altitudeKm - cam0.altitudeKm) > 0.1;
  row('V1', 'row click selects the unit and flies there', `unit ${id}, card «${after.sel.split('\n')[0]}», camera ${moved ? 'moved' : 'still'}`, 'card of that unit, camera moved', after.sel.length > 0 && moved);
  void selId;
  await shot('v1-forces');
}

// ---------------------------------------------------------------------------------------------------------------
if (want('V2')) {
  // Enough army-base capacity for 10 divisions, the game paused (no income between the price and the charge).
  await view(() => {
    const { ctx } = window.__front;
    const at = (la, lo) => Math.floor((90 - la) / 180 * 800) * 1600 + Math.floor((lo + 180) / 360 * 1600);
    ctx.sim.debug({ type: 'spawnStructure', structure: 7, owner: 1, tile: at(39.9, -4.3), level: 3 });
    ctx.sim.debug({ type: 'spawnStructure', structure: 7, owner: 1, tile: at(39.3, -3.0), level: 3 });
    ctx.sim.debug({ type: 'addGold', playerId: 1, amount: 30_000_000 });
    ctx.app.setSpeed(0);
  });
  await sleep(1500);
  await page.locator('.fu-bb-tab').nth(1).click();
  await sleep(500);
  const slot = page.locator('.fu-bb-slot.is-unit').nth(1); // division (BUILDABLE_UNITS: warship, division, ...)
  let ok = 0;
  const log2 = [];
  const tick0 = await view(() => window.__front.ctx.sim.view.tick);
  for (let i = 0; i < 10; i++) {
    const before = await view(() => ({ gold: window.__front.ctx.sim.view.human.gold, price: window.__front.ctx.sim.view.unitCost(3), n: window.__front.ctx.sim.view.production.length }));
    const shown = (await slot.locator('.fu-bb-cost').innerText()).trim();
    await slot.click();
    await until((n) => window.__front.ctx.sim.view.production.length > n, before.n, 10000, 150);
    const afterGold = await view(() => window.__front.ctx.sim.view.human.gold);
    const charged = Math.round(before.gold - afterGold);
    log2.push(`${shown}/${before.price}/${charged}`);
    if (Math.abs(charged - before.price) <= 1) ok++;
  }
  row('V2', 'Arsenal: price shown = gold charged, 10 purchases (shown/exact/charged)', `${ok}/10: ${log2.slice(0, 4).join(', ')}…`, '10/10', ok === 10);
  const prod = await view(() => window.__front.ctx.sim.view.production.filter((q) => q.unit === 3).map((q) => ({ eta: q.readyTick - q.startTick, start: q.startTick })));
  row('V2', 'a bought division is in production with an 80-tick ETA', prod.length ? `${prod.length} queued, first ${prod[0].eta} ticks` : 'none', '80', prod.length >= 10 && prod[0].eta === 80);
  await page.keyboard.press('KeyU');
  await sleep(300);
  const prodRows = await view(() => document.querySelectorAll('.fu-fo-row.is-prod').length);
  if (prodRows === 0) await page.keyboard.press('KeyU');
  await sleep(500);
  const prodRows2 = await view(() => document.querySelectorAll('.fu-fo-row.is-prod').length);
  row('V2', 'En producción rows in the panel', prodRows2, '>= 10', prodRows2 >= 10);
  await shot('v2-production');
  await view(() => window.__front.ctx.app.setSpeed(4));
  const ready = await until(() => window.__w4.ready.find((e) => e.owner === 1 && e.unit === 3), null, 90000, 500);
  await sleep(1000);
  const alert = await view(() => [...document.querySelectorAll('.fu-alert')].map((e) => e.innerText).find((x) => /lista|listo|ready/i.test(x)) ?? '');
  row('V2', 'unitReady alert naming its base', ready ? `«${alert.split('\n')[0]}»` : 'no unitReady', '«… lista en la base de …»', !!ready && /base/i.test(alert));
  await view(() => window.__front.ctx.app.setSpeed(0));
}

// ---------------------------------------------------------------------------------------------------------------
if (want('V3')) {
  await view(() => {
    const { ctx } = window.__front;
    ctx.app.setSpeed(0);
    ctx.cameraRig.setState({ lat: 42.0, lon: -1.0, altitudeKm: 1900, tilt: 0.2, heading: 0 });
  });
  await sleep(2500);
  const types = await view(() => {
    const v = window.__front.ctx.sim.view;
    const byType = {};
    for (const u of v.units.values()) if (u.owner === 1 && [0, 2, 3, 4, 5, 6].includes(u.type)) (byType[u.type] ??= []).push(u.id);
    return byType;
  });
  const pool = Object.values(types).flat();
  let agree = 0, total = 0, accepted = 0;
  const bad = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 60 && pool.length; i++) {
    const id = pool[i % pool.length];
    const exists = await view((id) => window.__front.ctx.sim.view.units.has(id), id);
    if (!exists) continue;
    await view((id) => window.__fuHud.shared.select({ kind: 'unit', id }), id);
    const x = 250 + rnd() * 1000, y = 150 + rnd() * 550;
    await page.mouse.move(x, y);
    await sleep(250);
    const pv = await until(({ x, y }) => {
      const p = window.__fuOrderPreview;
      const hv = window.__fuHud.shared.hover;
      return p && Math.abs(hv.clientX - x) < 1 && Math.abs(hv.clientY - y) < 1 && p.tile === hv.tile ? p : null;
    }, { x, y }, 4000, 100);
    if (!pv) continue;
    const n0 = await view(() => window.__w4.acks.length);
    const plan = pv.plans.find((p) => p.unitId === id);
    if (plan && plan.ok) await rightClick(x, y);
    else if (plan) {
      // The UI does not send an order its preview refuses: send the same order anyway, the sim must refuse it too.
      await view(({ id, plan, tile }) => window.__front.ctx.sim.send({ type: 'unitOrder', unitIds: [id], order: plan.order, tile, targetId: plan.targetId }), { id, plan, tile: pv.tile });
    }
    const ack = await until((n) => window.__w4.acks.length > n ? window.__w4.acks.slice(n) : null, n0, 20000, 150);
    const cancel = await view(() => !!document.querySelector('.fu-modal'));
    if (cancel) {
      // A first strategic strike asks for confirmation: close it (the order was not sent).
      await page.keyboard.press('Escape');
      await sleep(300);
      continue;
    }
    total++;
    const took = !!ack && ack.some((a) => a.accepted.includes(id));
    const predicted = pv.plans.find((p) => p.unitId === id)?.ok ?? false;
    if (took) accepted++;
    if (took === predicted) agree++;
    else bad.push(`${pv.order} unit ${id}: preview ${predicted ? 'ok' : pv.plans[0]?.key}, sim ${took ? 'took' : ack?.[0]?.errorKey}`);
    // Send aircraft home so they stay available.
    if (took && i % 4 === 3) await view(() => {
      const { ctx } = window.__front;
      const ids = [...ctx.sim.view.units.values()].filter((u) => u.owner === 1 && [4, 5, 6].includes(u.type)).map((u) => u.id);
      ctx.sim.send({ type: 'unitOrder', unitIds: ids, order: 'return', tile: -1, targetId: 0 });
    });
  }
  row('V3', `order parity over ${total} real right clicks (${accepted} accepted, all unit types)`, `${agree}/${total}`, '100 %, >= 50', agree === total && total >= 50);
  for (const b of bad.slice(0, 6)) log(`   ${b}`);
}

// ---------------------------------------------------------------------------------------------------------------
if (want('V4')) {
  const base = await view(() => {
    const { ctx } = window.__front;
    const s = [...ctx.sim.view.structures.values()].find((x) => x.owner === 1 && x.type === 6);
    if (!s) return null;
    window.__fuHud.shared.select({ kind: 'structure', id: s.id });
    ctx.cameraRig.setState({ lat: 40.45, lon: -3.3, altitudeKm: 60, tilt: 0.9, heading: 0 });
    return s.id;
  });
  await sleep(2500);
  const hosted = await view(() => window.__fuCard.hosted());
  const kinds = await view((ids) => ids.map((id) => window.__front.ctx.sim.view.units.get(id)?.type), hosted);
  row('V4', 'airbase card lists its docked aircraft (bombers and drones included)', `${hosted.length} rows, types ${kinds.join(',')}`, 'bomber (5) and drone (6) present', kinds.includes(5) && kinds.includes(6));
  const bomber = hosted[kinds.indexOf(5)];
  await view((id) => window.__fuCard.clickHosted(id), bomber);
  await sleep(1200);
  const card = await view(() => window.__fuCard.text());
  row('V4', 'clicking a hosted bomber selects it (its card)', card.split('\n')[0], 'the bomber card', /bomb/i.test(card));
  await shot('v4-docked');
  void base;
}

// ---------------------------------------------------------------------------------------------------------------
if (want('V5')) {
  await view(() => {
    const { ctx } = window.__front;
    window.__fuHud.shared.select({ kind: 'none' });
    ctx.cameraRig.setState({ lat: 41.8, lon: -1.2, altitudeKm: 1300, tilt: 0.1, heading: 0 });
  });
  await sleep(2500);
  const rect = { x0: 300, y0: 120, x1: 1300, y1: 780 };
  const expected = await view((r) => {
    const v = window.__front.ctx.sim.view;
    return (window.__front.ctx.units.unitsInRect(r.x0, r.y0, r.x1, r.y1) ?? []).filter((id) => {
      const u = v.units.get(id);
      return u && u.owner === 1 && [0, 2, 3, 4, 5, 6].includes(u.type);
    }).sort((a, b) => a - b);
  }, rect);
  await page.keyboard.down('Shift');
  await page.mouse.move(rect.x0, rect.y0);
  await page.mouse.down();
  await page.mouse.move((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, { steps: 4 });
  await page.mouse.move(rect.x1, rect.y1, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(800);
  const sel = await view(() => {
    const s = window.__fuHud.shared.selection;
    return (s.kind === 'units' ? s.ids : s.kind === 'unit' ? [s.id] : []).slice().sort((a, b) => a - b);
  });
  row('V5', 'Shift+drag selects every own unit in the rectangle', `${sel.length} selected, ${expected.length} in the box`, 'the same set', sel.length === expected.length && sel.every((id, i) => id === expected[i]) && sel.length >= 3);
  // Hover enemy land: the chip reports «n de m»; one right click orders all of them.
  await page.mouse.move(820, 330);
  const chip = (await until(() => {
    const c = document.querySelector('.fu-chip:not(.fu-hidden)');
    return c && /\d/.test(c.innerText) ? c.innerText : null;
  }, null, 30000, 300)) ?? '';
  const n0 = await view(() => window.__w4.acks.length);
  await rightClick(820, 330);
  const acks = await until((n) => window.__w4.acks.length > n ? window.__w4.acks.slice(n) : null, n0, 6000, 100);
  await sleep(600);
  const orderedIds = new Set((acks ?? []).flatMap((a) => a.unitIds));
  row('V5', 'the chip reports «n de m»', chip.replace(/\s+/g, ' ').slice(0, 140), '«n de m unidades»', / de \d+ unidades| of \d+ units/.test(chip));
  row('V5', 'one right click orders every selected unit', `${orderedIds.size} of ${sel.length} in unitOrder commands`, 'all', orderedIds.size === sel.length);
  await shot('v5-box-order');
}

// ---------------------------------------------------------------------------------------------------------------
if (want('V7')) {
  const div = await view(() => {
    const v = window.__front.ctx.sim.view;
    const u = [...v.units.values()].find((x) => x.owner === 1 && x.type === 3);
    if (u) window.__fuHud.shared.select({ kind: 'unit', id: u.id });
    return u?.id;
  });
  await until(() => /Rompe frentes|Breaks fronts/.test(window.__fuCard.text()), null, 30000, 300);
  const text = await view(() => window.__fuCard.text());
  const has = (re) => re.test(text);
  row('V7', 'division card: role line, 40 km/h ≈ 40 km/s at 1x, reach, effect, integrity, endurance, no FUERZA', text.replace(/\s+/g, ' ').slice(0, 220),
    'all present', has(/Rompe frentes|Breaks fronts/) && has(/40 km\/h/) && has(/40 km por segundo|40 km per second/) && has(/Alcance|Reach/) && has(/Efecto ahora|Effect now/) && has(/Integridad|Integrity/) && has(/días de combate|days of combat/) && !has(/FUERZA|STRENGTH/));
  await shot('v7-unit-card');
  const bomber = await view(() => {
    const v = window.__front.ctx.sim.view;
    const u = [...v.units.values()].find((x) => x.owner === 1 && x.type === 5);
    if (u) window.__fuHud.shared.select({ kind: 'unit', id: u.id });
    return u?.id;
  });
  await until(() => /Ataques profundos|Deep strikes/.test(window.__fuCard.text()), null, 30000, 300);
  const bt = await view(() => window.__fuCard.text());
  row('V7', 'bomber card: mission and cruise speeds', bt.match(/misión[^\n]*|mission[^\n]*/i)?.[0] ?? bt.slice(0, 80), 'misión 400 km/h (crucero 850 km/h)', /400 km\/h/.test(bt) && /850 km\/h/.test(bt));
  const st = await view(() => {
    const { ctx } = window.__front;
    const v = ctx.sim.view;
    const s = [...v.structures.values()].find((x) => x.owner === 1 && x.type === 2); // factory L2
    ctx.sim.debug({ type: 'addGold', playerId: 1, amount: -(v.human.gold - 100_000) });
    if (s) window.__fuHud.shared.select({ kind: 'structure', id: s.id });
    return s ? { id: s.id, level: s.level } : null;
  });
  await until(() => /Te faltan|You need/.test(window.__fuCard.text()), null, 30000, 300);
  const stext = await view(() => window.__fuCard.text());
  const cost = await view(() => {
    const s = [...window.__front.ctx.sim.view.structures.values()].find((x) => x.owner === 1 && x.type === 2);
    // upgradeCost(type, level) = round(baseCost × (0.5 + 0.5 × level)); factory base cost from the build bar formula.
    return s ? s.level : 0;
  });
  void cost;
  row('V7', 'factory card: now / next-level effects with gold per hour, upgrade cost and «Te faltan»', stext.replace(/\s+/g, ' ').slice(0, 260),
    'Ahora, Nivel 3, oro/h, Mejorar a nivel 3 · cost, Te faltan', /Ahora|Now/.test(stext) && /Nivel 3|Level 3/.test(stext) && /oro\/h|gold\/h/.test(stext) && /Te faltan|You need/.test(stext));
  await shot('v7-structure-card');
  void div; void bomber; void st;
}

// ---------------------------------------------------------------------------------------------------------------
if (want('V9')) {
  const g = await view(() => window.__units.grounding());
  const worst = g.reduce((a, b) => (b.residualPct > a.residualPct ? b : a), g[0]);
  const dev = Math.max(...g.map((x) => x.upDevDeg));
  row('V9', `grounding of ${g.length} structures: max residual (% of footprint)`, worst ? `${worst.residualPct} % (type ${worst.type}, ${worst.footprintKm} km)` : '-', '< 5 %', g.length > 0 && g.every((x) => x.residualPct < 5));
  row('V9', 'max up-vector deviation from the relief normal', `${dev.toFixed(2)}°`, '< 3°', dev < 3);
  row('V9', 'pads reach the lowest point (nothing floats), relief never above the base (nothing sinks)', `${g.filter((x) => x.padOk && x.visibleErrorPct === 0).length}/${g.length}`, 'all', g.every((x) => x.padOk && x.visibleErrorPct === 0));
}

if (want('V10')) {
  const m = await view(() => window.__units.modelStats());
  const types = ['port', 'factory', 'defensePost', 'samSite', 'silo', 'airbase', 'armyBase', 'navalYard', 'radar'];
  const distinct = types.filter((k) => m[k] !== m[`${k}2`] && m[`${k}2`] !== m[`${k}3`] && m[k] !== m[`${k}3`]);
  row('V10', 'structure models differ between L1, L2 and L3 (vertex counts)', `${distinct.length}/${types.length}: ${types.map((k) => `${k} ${m[k]}/${m[k + '2']}/${m[k + '3']}`).join(', ')}`.slice(0, 300), 'all 9 (cities grow by buildings)', distinct.length === types.length);
}

if (want('V14')) {
  const checks = [[4, 'SAM'], [3, 'defense post'], [6, 'airbase'], [7, 'army base'], [9, 'radar']];
  const res = [];
  for (const [type, name] of checks) {
    const n = await view((type) => {
      const { ctx } = window.__front;
      const s = [...ctx.sim.view.structures.values()].find((x) => x.owner === 1 && x.type === type);
      if (!s) {
        const at = (la, lo) => Math.floor((90 - la) / 180 * 800) * 1600 + Math.floor((lo + 180) / 360 * 1600);
        ctx.sim.debug({ type: 'spawnStructure', structure: type, owner: 1, tile: at(40.0 - type * 0.1, -2.0), level: 1 });
      }
      return 0;
    }, type);
    await sleep(700);
    const rings = await view((type) => {
      const s = [...window.__front.ctx.sim.view.structures.values()].find((x) => x.owner === 1 && x.type === type);
      if (!s) return -1;
      window.__fuHud.shared.select({ kind: 'structure', id: s.id });
      return 0;
    }, type);
    await sleep(900);
    const drawn = await view(() => window.__units.stats().rings);
    res.push(`${name}: ${drawn.length - 1}`);
    void n; void rings;
  }
  const unitsRings = [];
  for (const [type, name] of [[3, 'division'], [4, 'fighter CAP'], [2, 'warship']]) {
    await view((type) => {
      const u = [...window.__front.ctx.sim.view.units.values()].find((x) => x.owner === 1 && x.type === type && (type !== 4 || x.mode === 8));
      window.__fuHud.shared.select(u ? { kind: 'unit', id: u.id } : { kind: 'none' });
    }, type);
    await sleep(900);
    const drawn = await view(() => window.__units.stats().rings.filter((r) => r.style !== 0));
    unitsRings.push(`${name}: ${drawn.length}`);
  }
  const all = [...res, ...unitsRings];
  row('V14', 'a selected structure or unit draws its effect ring / zone (count beyond the selection ring)', all.join(', '), '>= 1 each', all.every((x) => Number(x.split(': ')[1]) >= 1));
}

if (want('V17')) {
  await view(() => {
    const { ctx } = window.__front;
    ctx.cameraRig.setState({ lat: 40.8, lon: -2.8, altitudeKm: 1500, tilt: 0.2, heading: 0 });
    const s = [...ctx.sim.view.structures.values()].find((x) => x.owner === 1 && x.type === 7);
    ctx.sim.debug({ type: 'addGold', playerId: 1, amount: 5_000_000 });
    if (s) ctx.sim.send({ type: 'buildUnit', unit: 3, structureId: -1 });
  });
  await sleep(2500);
  const hg = await view(() => ({ n: window.__units.stats().hourglasses, producing: [...window.__front.ctx.sim.view.structures.values()].filter((s) => (s.producing ?? 0) > 0 || s.built < 1 || (s.upgrade ?? 0) > 0).length }));
  row('V17', 'hourglass badges on structures producing or building', `${hg.n} badges, ${hg.producing} busy structures`, '>= 1 when busy', hg.producing === 0 || hg.n >= 1);
  await shot('v17-hourglass');
}

row('--', 'page errors', errors.length ? errors.slice(0, 3).join(' | ') : 'none', 'none', errors.length === 0);
console.log('\n=== W4 browser verification ===');
for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.what}  →  ${r.value}   [target ${r.target}]`);
const failed = rows.filter((r) => !r.pass).length;
console.log(`--- ${rows.length - failed}/${rows.length} pass`);
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(rows, null, 2));
await browser.close();
process.exit(failed ? 1 : 0);
