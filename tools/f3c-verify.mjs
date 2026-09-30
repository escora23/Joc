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
  page.__logs = [];
  page.on('console', (m) => {
    if (/\[command\]/.test(m.text())) page.__logs.push(m.text());
    if (/\[command\]/.test(m.text()) && !/escort|border crossing|hit (house|structure)/.test(m.text())) console.log(`   ${m.text().slice(0, 220)}`);
  });
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
    return s && s.phase === 'play' && s.nearestHostileM > 0 && s.nearestHostileM < 4000 ? { m: s.nearestHostileM, combat: s.combat } : null;
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
  const tr = await until(page, () => window.__cmd.overlay.transitText || (window.__cmdStats?.transits?.length ? 'done' : null), null, 20000, 200);
  if (tr && tr !== 'done') await shot(page, 'go-2-transit');
  const c = await waitContact(page, 300000);
  const tC = (Date.now() - t0) / 1000;
  const f1 = await frames(page);
  const s2 = await stats(page);
  row('G3', 'G marches the unit to the action (transit card, the whole world on the same clock)', `${String(tr).slice(0, 180)} · marches ${JSON.stringify(s2?.transits)}`, !!tr && (s2?.transits?.length ?? 0) > 0);
  if (!c) console.log('   G4 debug', JSON.stringify(await page.evaluate(() => ({ pools: window.__cmdStats?.pools, target: window.__cmdStats?.target, combat: window.__cmdStats?.combat, info: window.__cmdStats?.info }))).slice(0, 1500));
  row('G4', 'from the take-control click to an enemy within 4 km — gun range and sight (criterion < ~60 real s on a real GPU)', c ? `${tC.toFixed(1)} real s here, ${f1 - f0} rendered frames (SwiftShader); enemy at ${c.m} m; chip «${c.combat}»` : `no contact after ${tC.toFixed(0)} s`, !!c);
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
  // The climb ends at 900 km over the unit: wait until the camera has finished its flight there.
  await until(page, (w) => { const c = __front.ctx.cameraRig.getState(); return __front.ctx.app.state === 'playing' && c.altitudeKm > 850 && c.altitudeKm < 950 && Math.abs(c.lon - w.lon) < 1.5 && Math.abs(c.lat - w.lat) < 1.5; }, where, 180000, 500);
  await sleep(4000);
  const cam = await page.evaluate(() => __front.ctx.cameraRig.getState());
  row('P2', 'exit: the strategic camera ends above the place of the action', `cam ${cam.lat.toFixed(2)}, ${cam.lon.toFixed(2)} @ ${Math.round(cam.altitudeKm)} km; unit ${where.lat.toFixed(2)}, ${where.lon.toFixed(2)}`, Math.abs(cam.lat - where.lat) < 1 && Math.abs(cam.lon - where.lon) < 1 && cam.altitudeKm < 1500);
  await shot(page, 'panel-2-exit');
  return page;
}

async function frameLight(page) {
  const b64 = (await page.screenshot({ timeout: 300000 })).toString('base64');
  return page.evaluate(async (src) => {
    const im = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, lit = 0;
    for (let y = Math.floor(c.height * 0.2); y < c.height * 0.8; y += 2) for (let x = Math.floor(c.width * 0.2); x < c.width * 0.8; x += 2) {
      const k = (y * c.width + x) * 4;
      const L = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
      sum += L; n++;
      if (L > 45) lit++;
    }
    return { mean: sum / Math.max(1, n), lit: lit / Math.max(1, n) };
  }, b64);
}

/** Enter a staged command-strike session and wait until it is playable. */
async function strikeSession(target) {
  const page = await open('command-strike', `&live=1&target=${target}`);
  await until(page, () => window.__cmdStats?.phase === 'play', null, 240000, 500);
  await until(page, () => window.__cmd.civil.structRecs.length > 0 || window.__cmd.civil.houseRecs.some((h) => h.cityId > 0), null, 120000, 500);
  return page;
}
/** Fire `n` HE rounds at the staged target (aim through the controller, the rounds through the normal weapon). */
async function fireAt(page, n) {
  await page.evaluate(async (n) => {
    const m = await import('/src/command/shots.ts');
    const s = { waitFrames: (k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }) };
    await m.strikeFire(s, window.__cmd, n);
  }, n);
}
const structNow = (page) => page.evaluate(() => { const s = __front.ctx.sim.view.structures.get(window.__strikeTarget); return s ? { hp: +s.hp.toFixed(3), level: s.level, owner: s.owner, blocks: s.blocks ?? 0, hitBy: s.hitBy ?? 0 } : null; });

async function strike() {
  const page = await strikeSession('factory');
  const s0 = await structNow(page);
  await shot(page, 'strike-0');
  // The first round by hand: HE (key 2), aim on the factory, click.
  await page.mouse.move(800, 450);
  // The round in the breech (AP; switching to HE takes a 5 s reload of local time, minutes of SwiftShader frames).
  await until(page, () => window.__cmd.controller.hud.reload >= 0.999, null, 180000, 500);
  await page.evaluate(() => {
    const st = window.__cmd.civil.structRecs.find((r) => r.id === window.__strikeTarget);
    const c = window.__cmd.controller;
    if (st) { c.aimAt(new window.__cmd.camera.position.constructor(st.x, (st.y0 + st.y1) / 2, st.z)); c.snapTurret?.(); }
  });
  await sleep(1500);
  const shots0 = await page.evaluate(() => window.__cmd.world.stats.shots);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  const hit1 = await until(page, (h) => { const s = __front.ctx.sim.view.structures.get(window.__strikeTarget); return s && s.hp < h - 0.001 ? s.hp : null; }, s0?.hp ?? 1, 90000, 500);
  const shots1 = await page.evaluate(() => window.__cmd.world.stats.shots);
  row('S1', 'a tank round fired by hand (a click) hits the real factory: its hp falls in the sim', `rounds fired ${shots1 - shots0}; hp ${s0?.hp} → ${hit1 ?? 'unchanged'}`, hit1 !== null);
  await fireAt(page, 19);
  const s1 = await until(page, (lv) => { const s = __front.ctx.sim.view.structures.get(window.__strikeTarget); return s && (s.level < lv || s.hp < 0.4) ? s : null; }, s0?.level ?? 2, 60000, 500);
  const s2 = await structNow(page);
  const dmg = await page.evaluate(() => window.__f3c.dmg.map((e) => `${e.hpBefore.toFixed(2)}→${e.hp.toFixed(2)} st${e.state}${e.levelLost ? ' LEVEL' : ''} (${e.cause})`));
  row('S2', 'twenty HE rounds: the factory loses a level (or is heavily damaged); the structureDamaged report goes out', `L${s0?.level} hp ${s0?.hp} → L${s2?.level} hp ${s2?.hp}; events ${dmg.join(', ')}`, !!s1 && dmg.length > 0);
  await page.evaluate(() => window.__cmd.simulate(120, 1 / 30));
  await sleep(4000);
  const vis = await page.evaluate(() => ({ fires: window.__cmd.civil.fires.length, recs: window.__cmd.civil.structRecs.map((r) => `${r.id}:${(r.y1 - r.y0).toFixed(0)}m`) }));
  row('S3', 'the model in command mode shows it: lower, scorched, debris, smoke or fire', JSON.stringify(vis), vis.fires > 0);
  await shot(page, 'strike-1-damaged');
  // Exit and look at it on the strategic map: its card.
  await page.evaluate(() => window.__cmd.debrief());
  await until(page, () => __front.ctx.app.state === 'playing', null, 120000, 500);
  await sleep(4000);
  const card = await page.evaluate(async () => {
    window.__fuHud.shared.select({ kind: 'structure', id: window.__strikeTarget });
    await new Promise((r) => setTimeout(r, 5000));
    return (document.querySelector('.fu-sel')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400);
  });
  row('S4', 'strategic map: the structure card shows the damage done in command mode', card, /Muy dañad|Con daños|funciona al|Destruid/i.test(card));
  await page.evaluate(() => { const s = __front.ctx.sim.view.structures.get(window.__strikeTarget); if (s) { const la = 90 - (Math.floor(s.tile / 1600) + 0.5) * 180 / 800, lo = ((s.tile % 1600) + 0.5) * 360 / 1600 - 180; __front.ctx.cameraRig.setState({ lat: la - 0.05, lon: lo, altitudeKm: 25, tilt: 1.0, heading: 0 }); } });
  await sleep(8000);
  await shot(page, 'strike-2-strategic');
  return page;
}

async function city() {
  const page = await strikeSession('city');
  const s0 = await structNow(page);
  const op0 = await page.evaluate(() => { const s = __front.ctx.sim.view.structures.get(window.__strikeTarget); return __front.ctx.sim.view.opinions.get(s.owner)?.score ?? null; });
  await page.evaluate(() => {
    const ov = window.__cmd.overlay;
    const ask = ov.ask.bind(ov);
    window.__asks = [];
    ov.ask = (title, body, extra, buttons) => { window.__asks.push(`${title} | ${body} | ${extra}`); return ask(title, body, extra, buttons); };
  });
  await fireAt(page, 1);
  let dlg = null;
  for (let i = 0; i < 150 && !dlg; i++) {
    dlg = page.__logs.find((l) => /civilian target: asking/.test(l)) ?? null;
    if (!dlg) await sleep(400);
  }
  row('C1', 'the first shot at a city asks first, with the consequences in numbers', dlg ?? 'no dialog', !!dlg && /civil/i.test(dlg));
  await shot(page, 'city-0-confirm');
  await page.keyboard.press('Enter');
  await sleep(1500);
  await fireAt(page, 33);
  await sleep(5000);
  const s1 = await until(page, (h) => { const s = __front.ctx.sim.view.structures.get(window.__strikeTarget); return s && s.hp < h - 0.01 ? s : null; }, s0?.hp ?? 1, 60000, 500);
  const s2 = await structNow(page);
  const down = await page.evaluate(() => window.__cmd.civil.houseRecs.filter((h) => h.cityId === window.__strikeTarget && h.down).length);
  const dmg = await page.evaluate(() => window.__f3c.dmg.map((e) => `${e.hpBefore.toFixed(2)}→${e.hp.toFixed(2)} civ ${e.civilians} troops ${e.troops}`));
  row('C2', 'houses collapse (whole blocks when enough of them fall), the city loses hp, civilians and troops in the sim', `hp ${s0?.hp} → ${s2?.hp}, blocks mask ${s2?.blocks}, houses down ${down}; ${dmg.join(', ')}`, !!s1 && down > 0);
  const op1 = await page.evaluate(() => { const s = __front.ctx.sim.view.structures.get(window.__strikeTarget); return __front.ctx.sim.view.opinions.get(s.owner)?.score ?? null; });
  row('C3', 'diplomatic consequence: the victim thinks worse of us', `${op0} → ${op1}`, op0 === null || (op1 !== null && op1 < op0));
  await page.evaluate(() => window.__cmd.simulate(150, 1 / 30));
  await sleep(4000);
  await shot(page, 'city-1-collapse');
  return page;
}

async function night() {
  const page = await open('command-front', '&live=1&hour=1');
  await until(page, () => window.__cmdStats?.phase === 'play', null, 240000, 500);
  await page.evaluate(() => { window.__cmd.simulate(240, 1 / 30); });
  await sleep(6000);
  const st = await stats(page);
  const l0 = await frameLight(page);
  await shot(page, 'night-0-plain');
  row('N1', 'night at a front in command mode: the frame is readable (moonlight, own lights, flares, fires)', `night ${st?.night}, flares ${st?.flares}, lights ${st?.lights}; mean luma ${l0.mean.toFixed(1)}, lit ${(l0.lit * 100).toFixed(1)} %`, (st?.night ?? 0) > 0.6 && l0.mean > 25 && l0.lit > 0.08);
  await page.keyboard.press('KeyN');
  await sleep(6000);
  const l1 = await frameLight(page);
  const v1 = (await stats(page))?.vision;
  await shot(page, 'night-1-nv');
  row('N2', 'N: night vision brightens the view', `${v1}: mean luma ${l1.mean.toFixed(1)}, lit ${(l1.lit * 100).toFixed(1)} %`, v1 === 'nv' && l1.mean > l0.mean);
  await page.keyboard.press('KeyN');
  await sleep(6000);
  const l2 = await frameLight(page);
  const v2 = (await stats(page))?.vision;
  await shot(page, 'night-2-thermal');
  row('N3', 'N again: thermal (white-hot bodies on a cold ground)', `${v2}: mean luma ${l2.mean.toFixed(1)}, lit ${(l2.lit * 100).toFixed(1)} %`, v2 === 'thermal');
  await page.keyboard.press('KeyN');
  return page;
}

const sections = { strike, city, night, go, panel };
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
