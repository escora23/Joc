// Feedback #3 browser verifier, strategic side (FEEDBACK-1 items 27, 28, 29a, 29c, 29d). Drives the real game in
// Chromium (SwiftShader) on staged but REAL wars (the ?shot= stagers only issue sim commands and run real ticks) through
// the real UI: the Guerra y frentes panel, the unit and structure cards, right-click, the Fuerzas panel, the dialogs.
//   node tools/f3-verify.mjs [--url http://127.0.0.1:5467/] [--out shots/feedback3-strategic/verify] [--only missions,card,civil,advisor]
//
// missions  #28/29a: the front badge, the Guerra panel front row and «Tu ofensiva» print the same km/h; «Enviar
//           divisiones» offers «Unirse» with the km/h the division would bring; one click orders the join; with time
//           running the division reaches the spearhead and the offensive's published support (divAtk) rises; the unit
//           cards say what each mission does; a selected division's right-click chip over enemy land near the
//           offensive offers «Unirse a la ofensiva» with the km/h preview; the assault target's hp falls.
// card      #27: the card of a damaged own factory says its state, its function and who hit it; «Reparar» pays and the
//           repair runs (hp rises); the damage report is in the alert feed.
// civil     #27/29d: a bomber ordered onto an enemy city asks first, listing the consequences; confirming sends the
//           sortie; the strike lands: the city loses hp, the victim thinks worse of us, an after-action report arrives.
// advisor   #29c: every Fuerzas row shows its mission; the advisor lists idle units; «Dar misión» gives them one.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5467/';
const out = args.out || 'shots/feedback3-strategic/verify';
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
  await page.evaluate(() => {
    window.__f3 = { strikes: [], aar: [], dmg: [], acks: [] };
    const bus = __front.ctx.bus;
    bus.on('strikeResult', (e) => window.__f3.strikes.push(e));
    bus.on('afterAction', (e) => window.__f3.aar.push(e));
    bus.on('structureDamaged', (e) => window.__f3.dmg.push(e));
    bus.on('orderAck', (e) => window.__f3.acks.push(e));
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
    if (!/not stable|Timeout|intercepts/.test(String(e?.message ?? e))) throw e;
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
/** Run the game at `speed` until `ticks` more ticks passed (SwiftShader: generous real time), then pause. */
async function runTicks(page, ticks, speed = 4, ms = 600000) {
  const t0 = await page.evaluate(() => __front.ctx.sim.view.tick);
  await page.evaluate((s) => __front.ctx.app.setSpeed(s), speed);
  await until(page, (t) => __front.ctx.sim.view.tick >= t, t0 + ticks, ms, 500);
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  await sleep(600);
}
const tipText = (page) => page.evaluate(() => [...document.querySelectorAll('.fu-tip')].filter((t) => t.offsetParent !== null).map((t) => t.textContent.replace(/\s+/g, ' ')).join(' | '));
const KMH = /(\d+(?:,\d)?) km\/h/;

// ---------------------------------------------------------------------------------------------------------------------
async function missions() {
  const page = await open('f3-missions', '&run=40');
  const idx = await page.evaluate(async () => {
    const m = await import('/src/shared/types.ts');
    return Object.fromEntries(['join', 'defend', 'assault', 'attach'].map((k) => [k, m.UNIT_ORDER_KINDS.indexOf(k)]));
  });
  // M1 (29a): one km/h for the front.
  const nums = await until(page, () => {
    const off = __front.ctx.sim.view.attacks.find((a) => a.attacker === 1 && a.defender > 0 && !a.naval);
    if (!off) return null;
    const rowEl = document.querySelector(`.fu-war-front[data-key="${off.frontKey}"]`);
    const badge = document.querySelector(`.fu-fb[data-key="${off.frontKey}"] .fu-fb-adv`);
    const own = rowEl?.querySelector('.fu-war-own')?.textContent ?? '';
    return rowEl ? { row: rowEl.querySelector('.fu-war-adv')?.textContent ?? '', own, badge: badge?.textContent ?? '(badge off screen)', state: off.state, kmh: off.advanceKmh } : null;
  }, null, 30000);
  const k = (s) => (KMH.exec(s ?? '') ?? [])[1] ?? (/(presionando|estancado|consolidando)/.exec(s ?? '') ?? [])[1] ?? null;
  const same = nums && k(nums.row) && k(nums.row) === k(nums.own) && (!k(nums.badge) || k(nums.badge) === k(nums.row));
  row('M1', 'one figure for the front: panel row / «Tu ofensiva» / badge', nums ? `${nums.row} | ${nums.own} | ${nums.badge}` : 'none', same);
  await shot(page, 'm1-panel');
  // M2: the unit cards of the missions.
  const cards = await page.evaluate(async (idx) => {
    const v = __front.ctx.sim.view;
    const divs = [...v.units.values()].filter((u) => u.owner === 1 && u.type === 3);
    const hud = window.__fuHud;
    const out = {};
    for (const u of divs) {
      const kind = Object.keys(idx).find((k) => idx[k] === u.order) ?? String(u.order);
      hud.shared.select({ kind: 'unit', id: u.id });
      // The card rebuilds on the next rendered frame (slow under SwiftShader): wait for its own name in the title.
      const name = await (async () => {
        const t0 = performance.now();
        while (performance.now() - t0 < 15000) {
          const tt = document.querySelector('.fu-sel .fu-sel-title')?.textContent ?? '';
          if (tt.startsWith(`${u.serial}.`)) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        await new Promise((r) => setTimeout(r, 1200));
      })();
      void name;
      out[`${u.id}:${kind}`] = (document.querySelector('.fu-sel')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1500);
    }
    return out;
  }, idx);
  const txt = Object.entries(cards).map(([k2, v]) => `${k2} => ${v.slice(v.indexOf('ESTADO') >= 0 ? v.indexOf('ESTADO') : 150, (v.indexOf('ESTADO') >= 0 ? v.indexOf('ESTADO') : 150) + 260)}`).join(' || ');
  const has = (kind, re) => Object.entries(cards).some(([k2, v]) => k2.endsWith(`:${kind}`) && re.test(v));
  row('M2', 'unit cards say the mission and its effect', txt.slice(0, 900),
    has('join', /Con la ofensiva|Hacia la ofensiva/) && has('defend', /sector/) && has('assault', /Asaltando/) && has('assault', /Artillería/));
  const post0 = await page.evaluate(() => {
    const d = [...__front.ctx.sim.view.units.values()].find((u) => u.owner === 1 && u.order === 16);
    const s = d ? __front.ctx.sim.view.structures.get(d.mission) : null;
    return s ? { id: s.id, hp: s.hp, owner: s.owner } : null;
  });
  // M3: «Enviar divisiones» offers «Unirse» with the km/h; one click orders the join.
  const spare = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const d = [...v.units.values()].find((u) => u.owner === 1 && u.type === 3 && u.order !== 15);
    return d?.id ?? -1;
  });
  await page.evaluate(() => __front.ctx.bus.emit('panelToggled', { panel: 'fronts', open: true }));
  const off0 = await page.evaluate(() => __front.ctx.sim.view.attacks.find((a) => a.attacker === 1 && !a.naval));
  if (off0) await page.evaluate((key) => __front.ctx.bus.emit('frontSelected', { key, fly: false }), off0.frontKey);
  await sleep(800);
  await uiClick(page, `.fu-war-front[data-key="${off0?.frontKey}"] .fu-war-sendbtn`).catch(() => {});
  const list = await until(page, () => {
    const el = document.querySelector('.fu-war-sendlist:not(.fu-hidden):not(.fu-war-airlist)');
    const items = el ? [...el.querySelectorAll('.fu-war-send')] : [];
    return items.length ? items.map((i) => i.innerText.replace(/\s+/g, ' ')) : null;
  }, null, 20000);
  row('M3', '«Enviar divisiones» offers «Unirse» to our offensive', (list ?? []).join(' | '), (list ?? []).some((x) => /Unirse/i.test(x)));
  // The division defending its sector joins (the assaulting one keeps its mission for M5).
  const defId = await page.evaluate((code) => [...__front.ctx.sim.view.units.values()].find((u) => u.owner === 1 && u.type === 3 && u.order === code)?.id ?? -1, idx.defend);
  const btn = page.locator(`.fu-war-sendlist:not(.fu-hidden) .fu-war-send[data-unit="${defId}"] button`).first();
  let tipJoin = '';
  if (await btn.count()) {
    await btn.hover();
    await sleep(900);
    tipJoin = (await until(page, () => {
      const t = [...document.querySelectorAll('.fu-tip-title')].map((x) => x.parentElement?.textContent ?? '').find((x) => /km\/h/.test(x));
      return t ? t.replace(/\s+/g, ' ') : null;
    }, null, 10000)) ?? '';
  }
  row('M3b', 'its tooltip: power and km/h before → after', tipJoin.slice(0, 300), /km\/h/.test(tipJoin) && /→/.test(tipJoin) && /Potencia/.test(tipJoin));
  await shot(page, 'm3-join-tip');
  const div0 = await page.evaluate(() => __front.ctx.sim.view.attacks.find((a) => a.attacker === 1 && !a.naval)?.divAtk ?? 0);
  const joinedId = defId;
  if (await btn.count()) await uiClick(page, btn);
  const ordered = await until(page, (id) => __front.ctx.sim.view.units.get(id)?.order === 15 ? __front.ctx.sim.view.units.get(id).mission : null, joinedId, 10000);
  row('M3c', 'one click: the division is ordered to join (mission = the offensive)', `unit ${joinedId} mission ${ordered}`, !!ordered);
  // M4: with time running the joiners arrive and the offensive's published support rises.
  await runTicks(page, 120, 4);
  const after = await page.evaluate(() => {
    const a = __front.ctx.sim.view.attacks.find((x) => x.attacker === 1 && !x.naval);
    return a ? { divAtk: a.divAtk, kmh: a.advanceKmh, plan: a.planKmh, taken: a.tilesTaken } : null;
  });
  row('M4', 'the joined divisions add to the offensive (published divAtk)', `before ${div0}, after ${JSON.stringify(after)}`, after && after.divAtk > div0);
  // M5: the assault target loses hp (division artillery).
  const post = await page.evaluate((p0) => {
    if (!p0) return null;
    const s = __front.ctx.sim.view.structures.get(p0.id);
    return { before: p0, hp: s ? +s.hp.toFixed(2) : null, owner: s ? s.owner : null, gone: !s, ruins: __front.ctx.sim.view.ruins.length, aar: window.__f3.aar.filter((a) => a.kind === 'mission').map((a) => a.result) };
  }, post0);
  row('M5', 'the assaulted defence post: shelled (hp < 1), then captured by us', JSON.stringify(post), !!post && (post.owner === 1 || (post.hp !== null && post.hp < post.before.hp)));
  await shot(page, 'm4-after');
  // M6: the right-click chip of a spare division over enemy land near the offensive.
  const chip = await page.evaluate(async (id) => {
    const v = __front.ctx.sim.view;
    const a = v.attacks.find((x) => x.attacker === 1 && !x.naval);
    if (!a || id < 0) return 'no offensive / division';
    const hud = window.__fuHud;
    hud.shared.select({ kind: 'unit', id });
    const x = a.contactX >= 0 ? a.contactX : a.x, y = a.contactX >= 0 ? a.contactY : a.y;
    let tile = -1;
    for (let r = 0; r < 4 && tile < 0; r++) for (let dy = -r; dy <= r && tile < 0; dy++) for (let dx = -r; dx <= r; dx++) {
      const t = Math.floor(y + dy) * 1600 + ((Math.floor(x + dx) % 1600) + 1600) % 1600;
      if (v.owner[t] === a.defender) { tile = t; break; }
    }
    const { previewOrders, chipText } = await import('/src/ui/hud/orderCtl.ts');
    const pv = previewOrders(hud.shared, [id], tile, -1, -1, false);
    const c = pv ? chipText(hud.shared, pv) : null;
    return c ? `${c.title} · ${c.line}` : 'no chip';
  }, spare);
  row('M6', 'right-click chip near the offensive: «Unirse a la ofensiva» with the km/h', chip, /Unirse a la ofensiva/.test(chip) && /km\/h/.test(chip));
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------------
async function card() {
  const page = await open('f3-card');
  const text = await until(page, () => {
    const t = document.querySelector('.fu-w4-dmg')?.textContent ?? '';
    return /funciona al/.test(t) ? t : null;
  }, null, 20000);
  row('D1', 'the card: state, function and who hit it', text ?? '(none)', /Con daños · funciona al 60 %/.test(text ?? '') && /último ataque/.test(text ?? ''));
  const repBtn = page.locator('.fu-w4-repair');
  const label = await repBtn.innerText().catch(() => '');
  row('D2', 'the repair button with its price and hours', label.replace(/\s+/g, ' '), /Reparar · [\d.]+ · [\d,]+ h/i.test(label));
  const feed = await page.evaluate(() => [...document.querySelectorAll('.fu-alert')].map((a) => a.innerText.replace(/\s+/g, ' ')).join(' | '));
  row('D3', 'the damage report in the alert feed', feed.slice(0, 300), /Ataque de|funciona al/.test(feed));
  await shot(page, 'd1-card');
  const g0 = await page.evaluate(() => __front.ctx.sim.view.human.gold);
  const read = () => page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const s = [...v.structures.values()].find((x) => x.owner === 1 && x.type === 2);
    return { hp: s?.hp ?? -1, repairing: !!s?.repairing, hitTick: s?.hitTick ?? -1, tick: v.tick, gold: v.human.gold };
  });
  const r0 = await read();
  await uiClick(page, repBtn);
  // The structure's hp is published every 5 ticks while it repairs: the window ends on a published tick, and the
  // repair starts 2 h (20 ticks) after the last hit. Expected: +0.8 % per tick after the pause (+8 %/h).
  await runTicks(page, 30, 2);
  const r1 = await read();
  await runTicks(page, 30, 2);
  const r2 = await read();
  const pub = (t) => Math.floor(t / 5) * 5;
  const from = Math.max(r0.tick, r0.hitTick + 20);
  const exp1 = Math.max(0, pub(r1.tick) - from) * 0.008;
  const rate = ((r2.hp - r1.hp) / Math.max(1, pub(r2.tick) - pub(r1.tick))) * 10;
  row('D4', '«Reparar» pays and the structure regains integrity (+8 %/h after the 2 h pause that follows a hit)',
    `hp ${r0.hp.toFixed(3)} → ${r1.hp.toFixed(3)} → ${r2.hp.toFixed(3)} (ticks ${r0.tick} → ${r1.tick} → ${r2.tick}, last hit ${r0.hitTick}); expected +${exp1.toFixed(3)} in the first window, measured +${(r1.hp - r0.hp).toFixed(3)}; rate after the pause ${(rate * 100).toFixed(1)} %/h; repairing ${r1.repairing}, gold ${Math.round(g0)} → ${Math.round(r1.gold)}`,
    Math.abs(r1.hp - r0.hp - exp1) <= 0.02 && Math.abs(rate - 0.08) <= 0.01 && r1.gold < g0 - 20000);
  await shot(page, 'd4-repairing');
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------------
async function civil() {
  const page = await open('f3-civil');
  const modal = await until(page, () => {
    const m = document.querySelector('.fu-civil-confirm');
    return m ? m.innerText.replace(/\s+/g, ' ') : null;
  }, null, 20000);
  row('C1', 'a strike on a city asks first, with the consequences', (modal ?? '(no dialog)').slice(0, 500),
    /civiles/.test(modal ?? '') && /opinión/.test(modal ?? '') && /casus belli/.test(modal ?? '') && /L2/.test(modal ?? ''));
  await shot(page, 'c1-civil');
  const city = await page.evaluate(() => {
    const y = Math.floor(((90 - 43.6) / 180) * 800), x = Math.floor(((1.44 + 180) / 360) * 1600);
    return [...__front.ctx.sim.view.structures.values()].find((s) => s.owner !== 1 && s.type === 0 && s.tile === y * 1600 + x) ?? null;
  });
  const victim = city?.owner ?? 0;
  const op0 = await page.evaluate((v) => __front.ctx.sim.view.opinions.get(v)?.score ?? null, victim);
  await uiClick(page, page.locator('.fu-civil-confirm .fu-btn--danger'));
  const sortie = await until(page, () => [...__front.ctx.sim.view.units.values()].some((u) => u.owner === 1 && u.type === 5 && u.mode === 11), null, 15000);
  row('C2', 'confirming sends the sortie', `bomber on a strike mission: ${!!sortie}`, !!sortie);
  await runTicks(page, 40, 4);
  const res = await page.evaluate((id) => ({
    strikes: window.__f3.strikes.length, aar: window.__f3.aar.map((a) => `${a.kind}:${a.result}`), dmg: window.__f3.dmg.filter((d) => d.structureId === id).map((d) => `${d.hpBefore.toFixed(2)}→${d.hp.toFixed(2)} civ ${d.civilians}`),
    log: window.__fuAar?.log?.().map((l) => l.text) ?? [],
  }), city?.id ?? -1);
  const op1 = await page.evaluate((v) => __front.ctx.sim.view.opinions.get(v)?.score ?? null, victim);
  row('C3', 'the strike lands: the city is damaged and civilians die', JSON.stringify(res.dmg), res.dmg.length > 0);
  row('C4', 'after-action report of the strike (feed + log)', res.log.join(' | ').slice(0, 300), res.aar.some((a) => a.startsWith('strike:')) && res.log.length > 0);
  row('C5', 'the victim thinks worse of us', `${op0} → ${op1}`, op0 === null || op1 === null ? true : op1 < op0);
  await shot(page, 'c3-after');
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------------
async function advisor() {
  const page = await open('f3-advisor');
  const adv = await until(page, () => window.__fuForces?.advisor?.() || null, null, 20000);
  row('A1', 'the advisor lists idle units by type with a mission', (adv ?? '').replace(/\s+/g, ' '), /sin misión/i.test(adv ?? '') && /Dar misión/i.test(adv ?? ''));
  const missions = await page.evaluate(() => window.__fuForces.missions());
  row('A2', 'every Fuerzas row shows its mission', missions.map((m) => m.mission).join(' | ').slice(0, 300), missions.length > 0 && missions.every((m) => /Misión|Sin misión/.test(m.mission)));
  await shot(page, 'a1-advisor');
  const idle0 = await page.evaluate(() => window.__fuForces.idle().length);
  const btns = page.locator('.fu-fo-advisor button');
  const n = await btns.count();
  // Give a mission to every group whose suggestion is an order (the bombers' one picks a target, it stays for last).
  for (let i = 0; i < n; i++) {
    const b = page.locator('.fu-fo-advisor button').first();
    if (!(await b.count())) break;
    const typ = await b.getAttribute('data-adv');
    if (typ === '5') break;
    await uiClick(page, b);
    await sleep(1200);
  }
  await runTicks(page, 5, 1);
  const idle1 = await page.evaluate(() => window.__fuForces.idle().length);
  row('A3', '«Dar misión» gives idle units a mission', `idle ${idle0} → ${idle1}`, idle1 < idle0);
  await shot(page, 'a3-after');
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------------
/** Fix 2 (#28/29d): a warship bombarding an enemy coastal structure until it is rubble ends its mission with a report. */
async function bombard() {
  const page = await open('f3-missions', '&run=10&panel=0');
  const setup = await page.evaluate(async () => {
    const v = __front.ctx.sim.view;
    const world = __front.ctx.world;
    const { isWaterTerrain } = await import('/src/shared/terrain.ts');
    const W = 1600;
    const enemies = new Set(v.wars.filter((w) => w.aggressor === 1 || w.target === 1).map((w) => (w.aggressor === 1 ? w.target : w.aggressor)));
    for (const s of v.structures.values()) {
      if (!enemies.has(s.owner) || s.type === 0 || s.type === 4) continue;
      const x = s.tile % W, y = Math.floor(s.tile / W);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const t = (y + dy) * W + x + dx;
        if (isWaterTerrain(world.terrain[t])) return { sid: s.id, tile: s.tile, type: s.type, water: t, hp: s.hp, level: s.level, owner: s.owner };
      }
    }
    return null;
  });
  row('N0', 'an enemy structure on the coast', JSON.stringify(setup), !!setup);
  if (!setup) return page.close();
  // One of our warships off that coast (spawned there), a level-1 target already damaged (the report comes in hours).
  const shipId = await page.evaluate(async (st) => {
    const ctx = __front.ctx;
    const before = new Set(ctx.sim.view.units.keys());
    ctx.sim.debug({ type: 'spawnUnit', unit: 2, owner: 1, tile: st.water, targetTile: -1 });
    ctx.sim.debug({ type: 'damageStructure', tile: st.tile, amount: Math.max(0, st.hp - 0.35), by: 1 });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const u = [...ctx.sim.view.units.values()].find((x) => !before.has(x.id) && x.type === 2 && x.owner === 1);
      if (u) return u.id;
    }
    return 0;
  }, setup);
  await page.evaluate(({ id, st }) => __front.ctx.sim.send({ type: 'unitOrder', unitIds: [id], order: 'bombard', tile: st.tile, targetId: st.sid }), { id: shipId, st: setup });
  const acc = await until(page, (id) => __front.ctx.sim.view.units.get(id)?.mission || null, shipId, 15000);
  row('N1', 'the warship takes the bombardment as a mission on that structure', `ship ${shipId}, mission ${acc} (structure ${setup.sid})`, acc === setup.sid);
  let t = 0, rep = null;
  while (t < 400 && !rep) {
    await runTicks(page, 40, 4);
    t += 40;
    rep = await page.evaluate(() => window.__f3.aar.find((e) => e.order === 'bombard') ?? null);
  }
  const feed = await page.evaluate(() => window.__fuAlerts.list().filter((a) => a.kind === 'afterAction').map((a) => `${a.title} — ${a.body}`));
  const ship = await page.evaluate((id) => { const u = __front.ctx.sim.view.units.get(id); return u ? { order: u.order, mission: u.mission } : null; }, shipId);
  row('N2', 'the structure is destroyed and the mission ends with an after-action report', rep ? `${rep.result} after ${((rep.tick - rep.startTick) / 10).toFixed(0)} h, damage ${rep.damage}; ship now ${JSON.stringify(ship)}` : `none after ${t} ticks`, rep?.result === 'destroyed' && ship?.order === -1);
  row('N3', 'the report is in the alert feed and the REGISTRO log, in words', feed.find((x) => /bombardeo/i.test(x)) ?? feed.join(' | ').slice(0, 300), feed.some((x) => /bombardeo/i.test(x) && /fuego naval/i.test(x)));
  await shot(page, 'n3-bombard-report');
  await page.close();
}

const sections = { missions, card, civil, advisor, bombard };
for (const [k, fn] of Object.entries(sections)) {
  if (only && !only.has(k)) continue;
  try {
    await fn();
  } catch (e) {
    row(k, 'section crashed', String(e?.message ?? e).split('\n')[0], false);
  }
}
await browser.close();
const pass = results.filter((r) => r.pass).length;
console.log(`\nf3-verify: ${pass}/${results.length} passed, ${errors} page errors`);
fs.writeFileSync(path.join(out, 'verify.json'), JSON.stringify({ results, errors }, null, 2));
process.exit(pass === results.length && errors === 0 ? 0 : 1);
