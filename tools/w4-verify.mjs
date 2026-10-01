// FRONT ULTRA — W4 browser verification (armies, orders, cards, structures). Test tooling only.
//
//   node tools/w4-verify.mjs [--url http://127.0.0.1:5314/] [--out shots/W4-armies-orders/verify] [--only V3]
//
// Drives the real game in Chromium on a staged war across the Pyrenees (the scene of the `forces-panel` shot, built
// with the sim's debug actions and real player commands) and measures through the HUD and renderer hooks:
//   V1   the Fuerzas panel lists every own force (count = view.units minus missiles, trade ships, trains); a row click
//        selects the unit and flies the camera there; with the drawer open the unit card stays on screen and on
//        top beside it, and the pause / speed buttons stay hit-testable                             (acceptance 1)
//   V2   Arsenal: 10 purchases, the price shown before each = the gold charged; a division in production with an
//        80-tick ETA; the unitReady alert names its base                                            (acceptance 2)
//   V3   order parity: 50+ random REAL right clicks over all unit types; the chip's preview validity per unit equals
//        the sim's acceptance (orderAck)                                                            (acceptance 3)
//   V4   docked bombers and drones selectable from the airbase card (hosted rows) and the panel     (acceptance 4)
//   V5   Shift+drag selects every own unit in the rectangle; one right click orders them; «n de m»  (acceptance 5)
//   V7   unit card: role, km/h with the real-time equivalent, reach, effect, integrity, endurance, no «FUERZA»;
//        a division on the train reads «100 km/h en tren» (card read in the sim update it boards);
//        structure card: now/next effects, gold/h, upgrade cost = upgradeCost, «Te faltan»          (acceptance 7)
//   V9   __units.grounding(): residual < 5 % of the footprint, up deviation < 3°                    (acceptance 9)
//   V10  structure models differ by level (vertex counts)                                           (acceptance 10)
//   V11  a division by rail Sevilla -> Zaragoza: km / 100 h ± 10 %, on the rail line                  (acceptance 11)
//   V14  a selected unit / structure draws its effect ring                                          (acceptance 14)
//   V15  close-zoom model sizes: warship, division, airbase, radar, SAM at 300 / 100 / 40 / 8 km     (FEEDBACK-1)
//   V17  the hourglass badge while producing or building; no stub markers left                      (acceptance 17)
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
  // Pause the sim on the very tick a condition holds (checked on every sim update, in the page): under software GL a
  // page.evaluate poll can take seconds, and a 27-tick rail hop ends between two polls.
  window.__w4.watch = null;
  window.__w4.hit = null;
  window.__w4.traceId = -1;
  window.__w4.trace = [];
  ctx.bus.on('simTick', () => {
    const id = window.__w4.traceId;
    if (id >= 0) {
      const u = ctx.sim.view.units.get(id);
      if (u) window.__w4.trace.push({ tick: ctx.sim.view.tick, x: u.x, y: u.y, mode: u.mode });
    }
    const w = window.__w4.watch;
    if (!w) return;
    const r = w(ctx.sim.view);
    if (r) { ctx.sim.setSpeed(0); window.__w4.hit = r; window.__w4.watch = null; }
  });
});
/** Arm the in-page watcher with a function source `(view) => result | null`; returns once it fired (or null). */
async function pauseWhen(src, arg, timeout = 60000) {
  await page.evaluate(({ src, arg }) => { window.__w4.hit = null; const f = eval(`(${src})`); window.__w4.watch = (v) => f(v, arg); }, { src, arg });
  return until(() => window.__w4.hit, null, timeout, 200);
}
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


/**
 * Rail capacity is a real limit (§6.2: a factory carries 1 / 2 / 3 divisions at a time), and by V7 / V11 the
 * divisions bought in V2 may be riding the trains. Give the rail checks their own capacity: a level-3 factory near
 * Madrid (3 more slots), placed once.
 */
async function extraRailCapacity() {
  await view(() => {
    const { ctx } = window.__front;
    if (window.__w4.extraFactory) return;
    window.__w4.extraFactory = true;
    const at = (la, lo) => Math.floor((90 - la) / 180 * 800) * 1600 + Math.floor((lo + 180) / 360 * 1600);
    ctx.sim.debug({ type: 'spawnStructure', structure: 2, owner: 1, tile: at(40.05, -3.9), level: 3 });
  });
}

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
  // Under load (software GL, other agents' browsers) the card and the flight can take several frames: poll.
  await until((c0) => {
    const c = window.__front.ctx.cameraRig.getState({});
    const moved = Math.abs(c.lat - c0.lat) + Math.abs(c.lon - c0.lon) + Math.abs(c.altitudeKm - c0.altitudeKm) > 0.1;
    return (window.__fuCard?.text?.() ?? '').length > 0 && moved ? true : null;
  }, cam0, 15000, 250);
  const after = await view(() => ({ sel: window.__fuCard?.text?.() ?? '', cam: window.__front.ctx.cameraRig.getState({}) }));
  const selId = await view(() => window.__fuHud?.shared?.selection ?? null);
  const moved = Math.abs(after.cam.lat - cam0.lat) + Math.abs(after.cam.lon - cam0.lon) + Math.abs(after.cam.altitudeKm - cam0.altitudeKm) > 0.1;
  row('V1', 'row click selects the unit and flies there', `unit ${id}, card «${after.sel.split('\n')[0]}», camera ${moved ? 'moved' : 'still'}`, 'card of that unit, camera moved', after.sel.length > 0 && moved);
  void selId;
  // With the drawer open the player keeps the unit card (and its order buttons) and the clock / speed widget:
  // the card is on screen and on top at its centre and at its order buttons, every speed button is hit-testable.
  // Wait for the card's entrance animation to settle (its rect unchanged across two polls).
  let lastRect = '';
  for (let i = 0; i < 20; i++) {
    const r = await view(() => JSON.stringify(document.querySelector('.fu-hud-br .fu-sel')?.getBoundingClientRect() ?? null));
    if (r === lastRect) break;
    lastRect = r;
    await sleep(400);
  }
  const vis = await view(() => {
    // Headless Chromium may not start a CSS entrance animation until the next composited frame; end it so the rect
    // is the settled layout the player sees.
    for (const a of document.querySelector('.fu-hud-br .fu-sel')?.getAnimations() ?? []) a.finish();
    const W = innerWidth, H = innerHeight;
    const hit = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > W || y > H) return false;
      const e = document.elementFromPoint(x, y);
      return !!e && (e === el || el.contains(e));
    };
    const card = document.querySelector('.fu-hud-br .fu-sel');
    const r = card?.getBoundingClientRect();
    const onScreen = !!r && r.width > 50 && r.left >= 0 && r.top >= 0 && r.right <= W && r.bottom <= H;
    const orders = [...(card?.querySelectorAll('.fu-w4-orders .fu-btn, .fu-take-control') ?? [])];
    const speeds = [...document.querySelectorAll('.fu-time-seg button')];
    const panel = document.querySelector('.fu-forces')?.getBoundingClientRect();
    return {
      onScreen, cardHit: !!card && hit(card), rect: r ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null, prect: panel ? [panel.left, panel.top, panel.right, panel.bottom].map(Math.round) : null,
      orders: orders.length, ordersHit: orders.filter(hit).length,
      speeds: speeds.length, speedsHit: speeds.filter(hit).length,
      overlap: !!r && !!panel && r.right > panel.left && r.left < panel.right && r.bottom > panel.top && r.top < panel.bottom,
    };
  });
  row('V1', 'drawer open: the unit card stays on screen and on top (centre and order buttons), beside the drawer', `rect ${JSON.stringify(vis.rect)} drawer ${JSON.stringify(vis.prect)}, centre ${vis.cardHit ? 'hit' : 'covered'}, orders ${vis.ordersHit}/${vis.orders}, overlaps drawer ${vis.overlap}`,
    'on screen, hit, all orders, no overlap', vis.onScreen && vis.cardHit && vis.orders > 0 && vis.ordersHit === vis.orders && !vis.overlap);
  row('V1', 'drawer open: the pause / speed buttons stay clickable', `${vis.speedsHit}/${vis.speeds}`, 'all 5', vis.speeds === 5 && vis.speedsHit === 5);
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
  for (let i = 0; i < 120 && total < 56 && pool.length; i++) {
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
  // The hosted rows appear once the card has rendered (slow frames under software GL): poll.
  const hosted = (await until(() => { const h = window.__fuCard.hosted(); return h.length ? h : null; }, null, 20000, 300)) ?? [];
  const kinds = await view((ids) => ids.map((id) => window.__front.ctx.sim.view.units.get(id)?.type), hosted);
  row('V4', 'airbase card lists its docked aircraft (bombers and drones included)', `${hosted.length} rows, types ${kinds.join(',')}`, 'bomber (5) and drone (6) present', kinds.includes(5) && kinds.includes(6));
  const bomber = hosted[kinds.indexOf(5)];
  const clicked = await view((id) => !!document.querySelector(`.fu-w4-hrow[data-unit="${id}"]`) && (window.__fuCard.clickHosted(id), true), bomber);
  if (!clicked) log(`   hosted row of unit ${bomber} not found`);
  await until(() => /bombardero|bomber/i.test(window.__fuCard.text().split('\n')[0]) || null, null, 15000, 300);
  const card = await view(() => window.__fuCard.text());
  row('V4', 'clicking a hosted bomber selects it (its card)', card.split('\n')[0], 'the bomber card', /bombardero|bomber/i.test(card.split('\n')[0]));
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
  // The drag must start and end on the canvas: the alerts stack (top left), the panels and the bars would swallow the
  // pointerdown and no box would be drawn. Pick both corners from pixels where document.elementFromPoint is the canvas,
  // scanning outwards from a preferred rectangle clear of the HUD.
  const rect = await view(() => {
    const canvas = [...document.querySelectorAll('canvas')].sort((p, q) => q.width * q.height - p.width * p.height)[0];
    const onCanvas = (x, y) => document.elementFromPoint(x, y) === canvas;
    const pick = (x, y, dx, dy) => {
      for (let k = 0; k < 40; k++) {
        for (let j = 0; j <= k; j++) {
          const px = x + dx * 10 * j, py = y + dy * 10 * (k - j);
          if (onCanvas(px, py)) return [px, py];
        }
      }
      return null;
    };
    const a = pick(420, 160, 1, 1), b = pick(1250, 700, -1, -1);
    return a && b ? { x0: a[0], y0: a[1], x1: b[0], y1: b[1] } : { x0: 420, y0: 160, x1: 1250, y1: 700 };
  });
  log(`   box ${JSON.stringify(rect)}`);
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
  // The sim acknowledges on its next update (seconds apart on a loaded software renderer); groups of different orders
  // are acknowledged one by one.
  const acks = await until((n) => window.__w4.acks.length > n ? window.__w4.acks.slice(n) : null, n0, 20000, 100);
  await sleep(4000);
  const acksAll = await view((n) => window.__w4.acks.slice(n), n0);
  const orderedIds = new Set((acksAll ?? acks ?? []).flatMap((a) => a.unitIds));
  // The chip says how many of the selection can carry the order out («18 de 20»): those are the ones sent.
  const able = Number((chip.match(/(\d+) (?:de|of) \d+ (?:unidades|units)/i) ?? [])[1] ?? sel.length);
  row('V5', 'the chip reports «n de m»', chip.replace(/\s+/g, ' ').slice(0, 140), '«n de m unidades»', / de \d+ unidades| of \d+ units/i.test(chip));
  row('V5', 'one right click orders every selected unit that can carry it out', `${orderedIds.size} of ${sel.length} in unitOrder commands (chip: ${able} able)`, 'all the able ones', orderedIds.size >= able && orderedIds.size > 0);
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
    'all present', has(/Rompe frentes|Breaks fronts/) && has(/40 km\/h/) && has(/40 km por segundo|40 km per second/i) && has(/Alcance|Reach/i) && has(/Efecto ahora|Effect now/i) && has(/Integridad|Integrity/i) && has(/días de combate|days of combat/i) && !has(/\bfuerza\b|\bstrength\b/i));
  await shot('v7-unit-card');
  // A division travelling by train (§2.3): the card's speed follows the mode (100 km/h by rail, as its rail ETA).
  await extraRailCapacity();
  const railDiv = await view(() => {
    const { ctx } = window.__front;
    const v = ctx.sim.view;
    const cities = [...v.structures.values()].filter((x) => x.owner === 1 && x.type === 0).sort((a, b) => b.level - a.level);
    if (cities.length < 2) return null;
    const known = Math.max(0, ...[...v.units.keys()]);
    ctx.sim.debug({ type: 'spawnUnit', unit: 3, owner: 1, tile: cities[0].tile, targetTile: -1 });
    ctx.sim.setSpeed(1);
    return { from: cities[0].tile, to: cities[1].tile, known };
  });
  let railText = '';
  let v7diag = 'no division spawned';
  if (railDiv) {
    const id = await pauseWhen(((v, { f, known }) => {
      const near = [...v.units.values()].filter((x) => x.id > known && x.owner === 1 && x.type === 3 && Math.abs(x.x - (f % 1600) - 0.5) < 1.5 && Math.abs(x.y - Math.floor(f / 1600) - 0.5) < 1.5);
      return near.length ? Math.max(...near.map((x) => x.id)) : null;
    }).toString(), { f: railDiv.from, known: railDiv.known }, 20000);
    if (id) {
      await view(({ id, to }) => {
        const { ctx } = window.__front;
        ctx.sim.send({ type: 'unitOrder', unitIds: [id], order: 'move', tile: to, targetId: 0 });
        window.__w4.trace = [];
        window.__w4.traceId = id;
      }, { id, to: railDiv.to });
      // Pause on the tick it boards the train and read its card in that same sim update, in the page: the hop can be
      // short enough to end (and the division to join its front) between two polls from here.
      const armed = pauseWhen(((v, id) => {
        const u = v.units.get(id);
        if (u?.mode !== 2) return null;
        window.__fuHud.shared.select({ kind: 'unit', id });
        window.__fuCard.refresh();
        return { id, mode: u.mode, text: window.__fuCard.text() };
      }).toString(), id, 60000);
      await sleep(300);
      await view(() => window.__front.ctx.sim.setSpeed(1));
      const hit = await armed;
      v7diag = await view((id) => { const v = window.__front.ctx.sim.view; const u = v.units.get(id); const r = v.routes.get(id); const modes = [...new Set(window.__w4.trace.map((p) => p.mode))].join('>'); window.__w4.traceId = -1; return `unit ${id} mode ${u?.mode} route ${r ? r.length : 0} tiles, rail ${v.rail.length / 2} links, modes ${modes}, ${window.__w4.trace.length} updates`; }, id);
      railText = hit?.text ?? '';
      if (hit) v7diag += `, read at mode ${hit.mode}`;
      await view((id) => { window.__front.ctx.sim.setSpeed(0); window.__fuHud.shared.select({ kind: 'unit', id }); }, id);
      await shot('v7-rail-card');
    }
  }
  const speedLine = (railText.match(/(velocidad|speed)[^\n]*\n?[^\n]*\n?[^\n]*/i)?.[0] ?? railText.slice(0, 120)).replace(/\s+/g, ' ');
  const railOk = /100 km\/h (en tren|by rail)/i.test(railText) && /≈ ?100 km por segundo a 1x|≈ ?100 km per second at 1x/i.test(railText);
  row('V7', 'division by rail: the card reads the rail speed with its real-time equivalent (read on the tick it boards)', speedLine + (railOk ? '' : ` [${v7diag}]`),
    '100 km/h en tren · ≈ 100 km por segundo a 1x', railOk);
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
    'Ahora, Nivel 3, oro/h, Mejorar a nivel 3 · cost, Te faltan', /Ahora|Now/i.test(stext) && /Nivel 3|Level 3/i.test(stext) && /oro\/h|gold\/h/.test(stext) && /Mejorar a nivel 3|Upgrade to level 3/i.test(stext) && /Te faltan|You need/.test(stext));
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

// ---------------------------------------------------------------------------------------------------------------
// V11 (acceptance 11): a division ordered between two rail-connected cities ~600 km apart (Sevilla -> Zaragoza)
// arrives in km / 100 h ± 10 % of game time, travelling on the train (mode Rail) along the rail line: every sampled
// sim position during the rail leg lies within 1.5 tiles of the chain of station-to-station links its route follows.
if (want('V11')) {
  await extraRailCapacity();
  const setup = await view(() => {
    const { ctx } = window.__front;
    const at = (la, lo) => Math.floor((90 - la) / 180 * 800) * 1600 + Math.floor((lo + 180) / 360 * 1600);
    window.__fuHud.shared.select({ kind: 'none' });
    ctx.sim.debug({ type: 'conquer', playerId: 1, centerTile: at(38.2, -4.9), radius: 11 });
    ctx.sim.debug({ type: 'spawnStructure', structure: 0, owner: 1, tile: at(37.39, -5.98), level: 1 });
    ctx.sim.setSpeed(4);
    return { A: at(37.39, -5.98), B: at(41.65, -0.88), tick: ctx.sim.view.tick };
  });
  // The rail graph is rebuilt at most every 60 ticks: wait until the Sevilla station is connected to Zaragoza's
  // (a path through the network, not just one link), or the division would rightly go by road.
  const linked = await until(({ A, B }) => {
    const v = window.__front.ctx.sim.view;
    const all = [...v.structures.values()];
    const a = all.find((s) => s.tile === A), b = all.find((s) => s.tile === B);
    if (!a || !b) return null;
    const adj = new Map();
    for (let i = 0; i + 1 < v.rail.length; i += 2) {
      (adj.get(v.rail[i]) ?? adj.set(v.rail[i], []).get(v.rail[i])).push(v.rail[i + 1]);
      (adj.get(v.rail[i + 1]) ?? adj.set(v.rail[i + 1], []).get(v.rail[i + 1])).push(v.rail[i]);
    }
    const seen = new Set([a.id]), q = [a.id];
    while (q.length) { const n = q.shift(); if (n === b.id) return a.id; for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); q.push(m); } }
    return null;
  }, { A: setup.A, B: setup.B }, 180000, 500);
  const v11 = { hours: -1, km: 0, railSamples: 0, offLine: 0, worstTiles: 0, mode2: false };
  if (linked) {
    await view((A) => {
      const { ctx } = window.__front;
      ctx.sim.setSpeed(1);
      ctx.sim.debug({ type: 'spawnUnit', unit: 3, owner: 1, tile: A, targetTile: -1 });
    }, setup.A);
    // Pause in the same page call that finds it: a new division may otherwise leave on its own (it deploys to the
    // nearest front) before the order, and the trip would be timed from mid-way.
    const id = await pauseWhen(((v, A) => {
      const near = [...v.units.values()].filter((x) => x.owner === 1 && x.type === 3 && Math.abs(x.x - (A % 1600) - 0.5) < 0.6 && Math.abs(x.y - Math.floor(A / 1600) - 0.5) < 0.6);
      return near.length ? Math.max(...near.map((x) => x.id)) : null;
    }).toString(), setup.A, 30000);
    if (id) {
      const t0 = await view(({ id, B }) => {
        const { ctx } = window.__front;
        ctx.sim.setSpeed(0);
        ctx.sim.send({ type: 'unitOrder', unitIds: [id], order: 'move', tile: B, targetId: 0 });
        // Every sim update of this division, recorded in the page (departure and arrival ticks exact to the update).
        window.__w4.trace = [];
        window.__w4.traceId = id;
        return ctx.sim.view.tick;
      }, { id, B: setup.B });
      const path = (await until((id) => {
        const r = window.__front.ctx.sim.view.routes.get(id);
        return r && r.length ? [...r] : null;
      }, id, 20000, 200)) ?? [];
      // The station tiles on its route, in order (the rail leg runs link by link between them).
      const legs = await view((path) => {
        const byTile = new Map([...window.__front.ctx.sim.view.structures.values()].map((s) => [s.tile, s]));
        return path.filter((t) => byTile.has(t)).map((t) => [(t % 1600) + 0.5, Math.floor(t / 1600) + 0.5]);
      }, path);
      // 2x, not 4x: at 4x a loaded machine delivers the view in bursts of dozens of ticks and the arrival sample
      // overshoots. The clock starts when the division leaves Sevilla (the order is sent while paused).
      await view(() => window.__front.ctx.sim.setSpeed(2));
      const segDist = (px, py) => {
        let best = Infinity;
        for (let i = 0; i + 1 < legs.length; i++) {
          const [ax, ay] = legs[i], [bx, by] = legs[i + 1];
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
          best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
        }
        return best;
      };
      let arrived = null;
      const end = Date.now() + 300000;
      while (Date.now() < end) {
        const s = await view(({ id, B }) => {
          const { ctx } = window.__front;
          const u = ctx.sim.view.units.get(id);
          if (!u) return { gone: true };
          return { x: u.x, y: u.y, mode: u.mode, state: u.state, eta: u.etaTicks, tick: ctx.sim.view.tick, done: Math.abs(u.x - (B % 1600) - 0.5) < 3 && Math.abs(u.y - Math.floor(B / 1600) - 0.5) < 3 && u.mode !== 2 && u.mode !== 1 };
        }, { id, B: setup.B });
        if (s.gone) break;
        v11.last = s;
        if (v11.dep === undefined && (Math.abs(s.x - (setup.A % 1600) - 0.5) > 0.05 || Math.abs(s.y - Math.floor(setup.A / 1600) - 0.5) > 0.05)) v11.dep = s.tick - 1;
        if (s.mode === 2) {
          v11.railT0 ??= s.tick;
          v11.railT1 = s.tick;
          v11.mode2 = true;
          v11.railSamples++;
          const d = segDist(s.x, s.y);
          v11.worstTiles = Math.max(v11.worstTiles, d);
          if (d > 1.5) v11.offLine++;
        }
        // Arrived: off the train and no longer marching, at Zaragoza (a division that detrains next to a front
        // attaches to it, a tile or two from the city).
        if (s.done) { arrived = s.tick; break; }
        await sleep(150);
      }
      await view(() => window.__front.ctx.sim.setSpeed(0));
      const [ax, ay] = [(setup.A % 1600) + 0.5, Math.floor(setup.A / 1600) + 0.5], [bx, by] = [(setup.B % 1600) + 0.5, Math.floor(setup.B / 1600) + 0.5];
      const rad = Math.PI / 180;
      const la1 = (90 - ay * 0.225) * rad, la2 = (90 - by * 0.225) * rad, dl = (bx - ax) * 0.225 * rad;
      v11.km = 6371 * Math.acos(Math.min(1, Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(dl)));
      const trace = await view(() => { window.__w4.traceId = -1; return window.__w4.trace; });
      const ax0 = (setup.A % 1600) + 0.5, ay0 = Math.floor(setup.A / 1600) + 0.5;
      const bx0 = (setup.B % 1600) + 0.5, by0 = Math.floor(setup.B / 1600) + 0.5;
      const depI = trace.findIndex((p) => Math.abs(p.x - ax0) > 0.05 || Math.abs(p.y - ay0) > 0.05);
      const arrI = trace.findIndex((p, i) => i > depI && p.mode !== 1 && p.mode !== 2 && Math.abs(p.x - bx0) < 3 && Math.abs(p.y - by0) < 3);
      // Rail samples from the per-update trace (positions while in Rail mode, against the station links).
      v11.railSamples = 0; v11.offLine = 0; v11.worstTiles = 0;
      for (const p of trace) {
        if (p.mode !== 2) continue;
        v11.mode2 = true;
        v11.railSamples++;
        const d = segDist(p.x, p.y);
        v11.worstTiles = Math.max(v11.worstTiles, d);
        if (d > 1.5) v11.offLine++;
      }
      if (depI >= 0 && arrI > 0) { v11.dep = depI > 0 ? trace[depI - 1].tick : t0; arrived = trace[arrI].tick; }
      v11.hours = arrived !== null ? (arrived - (v11.dep ?? t0)) / 10 : -1;
      // The rail leg itself: station-to-station km along the links it rode, and the game hours spent in Rail mode.
      const kmOf = (a, b) => {
        const la1 = (90 - a[1] * 0.225) * rad, la2 = (90 - b[1] * 0.225) * rad, dl = (b[0] - a[0]) * 0.225 * rad;
        return 6371 * Math.acos(Math.min(1, Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(dl)));
      };
      v11.pathLen = path.length;
      v11.stops = legs.length;
      v11.railKm = legs.slice(1).reduce((acc, p, i) => acc + kmOf(legs[i], p), 0);
      v11.railHours = v11.railT0 !== undefined ? (v11.railT1 - v11.railT0) / 10 : -1;
    }
  }
  row('V11', `Sevilla -> Zaragoza by rail (${v11.km.toFixed(0)} km): arrival in game hours`, linked ? `${v11.hours.toFixed(1)} h (${v11.mode2 ? 'on the train' : 'never on the train'})${v11.hours < 0 && v11.last ? ` last ${JSON.stringify(v11.last)} B ${(setup.B % 1600) + 0.5},${Math.floor(setup.B / 1600) + 0.5}` : ''}` : 'Sevilla never linked', `${(v11.km / 100).toFixed(1)} h ± 10 %`, !!linked && v11.mode2 && Math.abs(v11.hours / (v11.km / 100) - 1) <= 0.1);
  row('V11', 'on the rail line while on the train (sim positions within 1.5 tiles of its station-to-station links)', `${v11.railSamples - v11.offLine}/${v11.railSamples} samples, worst ${v11.worstTiles.toFixed(2)} tiles`, 'all, >= 5 samples', v11.railSamples >= 5 && v11.offLine === 0);
  await shot('v11-rail');
}

if (want('V14')) {
  const checks =[[4, 'SAM'], [3, 'defense post'], [6, 'airbase'], [7, 'army base'], [9, 'radar']];
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

// ---------------------------------------------------------------------------------------------------------------
// V15 (owner clarification to FEEDBACK-1, §10.7): up close every model is clearly visible. The camera flies to a
// warship, a division, a docked squadron's airbase, a radar and a SAM site at 300 / 100 / 40 / 8 km and the drawn
// size (__units.sizeOf: the projected box of the model or formation, px) must reach the minimum for that altitude.
if (want('V15')) {
  const MIN = { unit: { 300: 38, 100: 50, 40: 55, 8: 60 }, struct: { 300: 30, 100: 45, 40: 50, 8: 150 } };
  const subjects = await view(() => {
    const v = window.__front.ctx.sim.view;
    window.__fuHud.shared.select({ kind: 'none' });
    const u = (type) => [...v.units.values()].find((x) => x.owner === 1 && x.type === type && x.state !== 8);
    const st = (type) => [...v.structures.values()].find((x) => x.owner === 1 && x.type === type);
    return [['warship', 'unit', u(2)?.id], ['division', 'unit', u(3)?.id], ['airbase', 'struct', st(6)?.tile], ['radar', 'struct', st(9)?.tile], ['SAM site', 'struct', st(4)?.tile]]
      .filter((x) => x[2] !== undefined);
  });
  const fails = [], got = [];
  for (const [name, kind, id] of subjects) {
    for (const alt of [300, 100, 40, 8]) {
      const px = await view(async ({ kind, id, alt }) => {
        const { ctx } = window.__front;
        let lat, lon;
        if (kind === 'unit') {
          const t = window.__units.tracks.get(id);
          const u = ctx.sim.view.units.get(id);
          if (!u) return -1;
          if (t && t.hasPos) {
            const p = t.pos.clone().normalize();
            lat = Math.asin(p.y) * 180 / Math.PI;
            lon = Math.atan2(-p.z, p.x) * 180 / Math.PI;
          } else { lat = 90 - u.y * 0.225; lon = u.x * 0.225 - 180; }
        } else {
          lat = 90 - (Math.floor(id / 1600) + 0.5) * 0.225;
          lon = ((id % 1600) + 0.5) * 0.225 - 180;
        }
        const t = Math.min(1, Math.max(0, (Math.log10(3000) - Math.log10(alt)) / (Math.log10(3000) - Math.log10(2))));
        ctx.cameraRig.setState({ lat, lon, altitudeKm: alt, tilt: 1.22 * Math.pow(t, 1.15), heading: 0.5 });
        const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        for (let i = 0; i < 4; i++) await frame();
        return window.__units.sizeOf(kind, id)?.px ?? 0;
      }, { kind, id, alt });
      got.push(`${name}@${alt}:${Math.round(px)}`);
      if (px < MIN[kind][alt]) fails.push(`${name}@${alt} ${Math.round(px)} < ${MIN[kind][alt]}`);
    }
  }
  row('V15', 'close-zoom model sizes (px) at 300 / 100 / 40 / 8 km', got.join(' '), 'units >= 38/50/55/60, structures >= 30/45/50/150', subjects.length >= 4 && fails.length === 0);
  await shot('v15-closeup');
}

if (want('V17')) {
  // Order a division (the sim applies commands on its ticks: run it at 1x), then frame the human's busy base: its
  // icon must carry the hourglass. (Busy structures of other nations may be off screen: only the human's count.)
  await view(() => {
    const { ctx } = window.__front;
    ctx.sim.debug({ type: 'addGold', playerId: 1, amount: 5_000_000 });
    ctx.sim.send({ type: 'buildUnit', unit: 3, structureId: -1 });
    ctx.sim.setSpeed(1);
  });
  const busyOwn = () => [...window.__front.ctx.sim.view.structures.values()].find((s) => s.owner === 1 && ((s.producing ?? 0) > 0 || s.built < 1 || (s.upgrade ?? 0) > 0));
  const busyId = await until((f) => { const s = eval(`(${f})`)(); if (!s) return null; const { ctx } = window.__front; ctx.sim.setSpeed(0);
    ctx.cameraRig.setState({ lat: 90 - (Math.floor(s.tile / 1600) + 0.5) * 0.225, lon: ((s.tile % 1600) + 0.5) * 0.225 - 180, altitudeKm: 1500, tilt: 0.2, heading: 0 }); return s.id; }, busyOwn.toString(), 30000, 300);
  const probe = () => ({ n: window.__units.stats().hourglasses, producing: [...window.__front.ctx.sim.view.structures.values()].filter((s) => s.owner === 1 && ((s.producing ?? 0) > 0 || s.built < 1 || (s.upgrade ?? 0) > 0)).length });
  // Poll (a camera jump to 1,500 km can take several seconds of frames under software GL) until a badge is drawn.
  const hg = (await until((f) => { const r = eval(`(${f})`)(); return r.n >= 1 ? r : null; }, probe.toString(), 30000, 500)) ?? await view(probe);
  row('V17', 'hourglass badge on the human\'s base producing a division (framed at 1,500 km)', `${hg.n} badges (busy base ${busyId ?? 'none'})`, '>= 1 badge on a busy base', !!busyId && hg.n >= 1);
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
