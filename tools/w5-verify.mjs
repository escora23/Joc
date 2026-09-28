// FRONT ULTRA — W5 command mode v2 verifier (DESIGN_V2 §9, V2-STATUS W5 acceptance criteria). Test tooling only.
//
//   node tools/w5-verify.mjs [--url http://127.0.0.1:5450/] [--only peace,travel,border,front,jet,ship] [--lang en]
//
// Plays the command shots in `live` mode (the staged session keeps running) and measures, in the browser:
//   E  entry at the unit's real position (≤ 1 km), own land at peace: no hostiles, towns and roads around, no
//      scripted mission text anywhere in the page;
//   K  tactical clock: game seconds ≈ real seconds, at most one sim tick per 5 game minutes;
//   D  a waypoint ~20 km away driven by autopilot: the sim unit moves as far as the local unit (±10 %), the
//      controlled unit's view keeps updating;
//   T  travel ×900 toward a waypoint 300 km away: ticks ≈ game seconds / 360 (±15 %), no chunk missing ahead,
//      throttled or dropped when the terrain lags, chunk main-thread p95;
//   B  near a border at peace: the warning, the confirmation when the autopilot reaches it, after crossing the
//      sim's borderIncursion and the victim's decision 30–90 game s later;
//   F  at a front: the forces equal deriveLocalForces (infantry shown = min(40, pool)), a kill of an enemy soldier
//      removes 25 troops, of an enemy tank 25 % of its division; losing the own tank costs 25 % and the next
//      vehicle takes over;
//   J  fighter at its real altitude; S warship in own territorial waters, calm sea;
//   X  Esc: the report, then the strategic camera at 2,500 km above the unit's new position, unit released.
// Timings here are real browser time: under SwiftShader a frame can take seconds, so the real-time checks
// (views per real second) are informative only; game-time checks are exact.
import { chromium } from 'playwright';
import fs from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--url', 'http://127.0.0.1:5450/');
const ONLY = (arg('--only', 'peace,travel,border,front,jet,ship')).split(',');
const LANG = arg('--lang', '');
const results = [];
const rec = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'} ${id}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

async function open(shot) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  await page.goto(`${BASE}?shot=${shot}&live=1${LANG ? `&lang=${LANG}` : ''}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 560000, polling: 500 });
  await page.waitForFunction(() => !!window.__cmdStats && window.__cmdStats.phase === 'play', null, { timeout: 120000, polling: 500 }).catch(() => undefined);
  return { page, errs };
}

const stats = (page) => page.evaluate(() => window.__cmdStats);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Sim unit position (tile coords) and the km between it and the local unit.
const syncState = (page) => page.evaluate(() => {
  const I = window.__cmd, v = I.ctx.sim.view, w = I.where();
  const id = v.command?.controlled?.[0]?.unitId ?? window.__w5unit;
  window.__w5unit = id;
  const u = v.units.get(id);
  const kmX = 25.0; // tile ≈ 25 km at the equator (1600×800 map)
  const cos = Math.cos((w.lat * Math.PI) / 180);
  return {
    unitId: id, sim: u ? { x: u.x, y: u.y, hp: u.hp } : null, local: { x: w.x, y: w.y, lat: w.lat, lon: w.lon },
    km: u ? Math.hypot((u.x - w.x) * kmX * cos, (u.y - w.y) * kmX) : -1, tick: v.tick, sec: v.command?.sec ?? -1,
  };
});

// ---------------------------------------------------------------------------------------------------------------
if (ONLY.includes('peace')) {
  const { page, errs } = await open('command-peace');
  const s = await stats(page);
  const sy = await syncState(page);
  rec('E1 entry at the unit', sy.km >= 0 && sy.km <= 1, { km: +sy.km.toFixed(3), local: sy.local });
  rec('E2 own land at peace, no hostiles', s.hostiles === 0 && /propio|own/i.test(s.info), { hostiles: s.hostiles, info: s.info.split('\n')[1]?.trim() });
  rec('E3 towns and roads around', s.civil.towns > 0 && s.civil.roads > 0, s.civil);
  const txt = await page.evaluate(() => document.body.innerText);
  const bad = txt.match(/objetivo|oleada|operaci[oó]n [A-Z]|ataque a[eé]reo|misi[oó]n|objective|wave \d|operation [A-Z]|air ?strike|mission/gi);
  rec('E4 no scripted mission text', !bad, bad ? bad.slice(0, 5) : 'none');
  // Tactical clock.
  const a = await syncState(page);
  const t0 = Date.now();
  await wait(30000);
  const b = await syncState(page);
  const real = (Date.now() - t0) / 1000, game = b.sec - a.sec;
  rec('K1 tactical clock ≈ 1:1', game > 0 && game <= real * 1.3, { realS: +real.toFixed(1), gameS: +game.toFixed(1) });
  rec('K2 ≤ 1 tick per 5 game min', b.tick - a.tick <= Math.ceil(game / 300) + 0, { ticks: b.tick - a.tick, gameS: +game.toFixed(1) });
  // Drive ~20 km (autopilot toward a waypoint east) and compare the strategic displacement.
  const start = await syncState(page);
  await page.evaluate(() => {
    const w = window.__cmd.where();
    window.__cmd.setWaypoint(w.lat, w.lon + 20 / (111.32 * Math.cos((w.lat * Math.PI) / 180)));
    window.__cmd.requestRate(60);
  });
  const d0 = (await stats(page)).distanceM;
  let views = 0, lastXY = '', s2 = null;
  const tDrive = Date.now();
  for (let i = 0; i < 240; i++) {
    await wait(1000);
    s2 = await stats(page);
    const sy2 = await syncState(page);
    const xy = sy2.sim ? `${sy2.sim.x.toFixed(4)},${sy2.sim.y.toFixed(4)}` : '';
    if (xy !== lastXY) views++;
    lastXY = xy;
    if (s2.waypointKm >= 0 && s2.waypointKm < 0.3) break;
    if (s2.waypointKm < 0 && (s2.distanceM - d0) > 15000) break;
  }
  const end = await syncState(page);
  const localKm = (s2.distanceM - d0) / 1000;
  const cos = Math.cos((end.local.lat * Math.PI) / 180);
  const simKm = end.sim && start.sim ? Math.hypot((end.sim.x - start.sim.x) * 25 * cos, (end.sim.y - start.sim.y) * 25) : -1;
  rec("D1 drive ≈20 km: sim moved as far", localKm > 15 && Math.abs(simKm - localKm) <= Math.max(2, localKm * 0.1), { localKm: +localKm.toFixed(2), simKm: +simKm.toFixed(2), gapKm: +end.km.toFixed(3), rate: s2.rate, requested: s2.requested, waypointKm: s2.waypointKm, from: start.local, to: end.local });
  rec('D2 controlled unit view updates', null, { distinctPositions: views, realS: Math.round((Date.now() - tDrive) / 1000), moves: s2.moves });
  // Exit.
  await page.evaluate(() => window.__cmd.debrief());
  let exited = false;
  for (let i = 0; i < 120 && !exited; i++) {
    await wait(1000);
    exited = await page.evaluate(() => window.__front?.app?.state === 'playing');
  }
  for (let i = 0; i < 90; i++) {
    await wait(1000);
    const alt = await page.evaluate(() => { const c = { altitudeKm: 0 }; window.__front.ctx.cameraRig.getState(c); return c.altitudeKm; });
    if (alt > 2450) break;
  }
  await wait(3000);
  const ex = await page.evaluate((id) => {
    const { ctx } = window.__front;
    const cam = { lat: 0, lon: 0, altitudeKm: 0, tilt: 0, heading: 0 };
    ctx.cameraRig.getState(cam);
    const u = ctx.sim.view.units.get(id);
    return { cam, unit: u ? { x: u.x, y: u.y } : null, controlled: (ctx.sim.view.command?.controlled ?? []).some((c) => c.unitId === id), clock: ctx.sim.view.clock };
  }, end.unitId);
  const camOk = ex.unit && Math.abs(ex.cam.altitudeKm - 2500) < 300 &&
    Math.abs(ex.cam.lat - (90 - (ex.unit.y / 800) * 180)) < 3 && Math.abs(ex.cam.lon - ((ex.unit.x / 1600) * 360 - 180)) < 3;
  rec('X1 exit: strategic camera 2,500 km above the new position', exited && !!camOk, ex);
  rec('X2 unit released, clock strategic', !ex.controlled && ex.clock.mode === 'strategic', { controlled: ex.controlled, clock: ex.clock.mode });
  rec('peace page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
if (ONLY.includes('travel')) {
  const { page, errs } = await open('command-travel');
  await page.evaluate(() => {
    const w = window.__cmd.where();
    window.__cmd.setWaypoint(w.lat + 0.3, w.lon + 3.5); // ~300 km east-north-east
  });
  const ok900 = await page.evaluate(() => window.__cmd.requestRate(900));
  const a = await syncState(page);
  let maxMissing = 0, throttledSeen = false, drops = new Set(), p95 = 0, rates = new Set();
  const t0 = Date.now();
  let s;
  for (let i = 0; i < 150; i++) {
    await wait(1000);
    s = await stats(page);
    maxMissing = Math.max(maxMissing, s.missingChunksAhead);
    throttledSeen ||= !!s.throttled;
    if (s.lastDrop) drops.add(s.lastDrop);
    rates.add(s.rate);
    p95 = Math.max(p95, s.chunkMsP95);
  }
  const b = await syncState(page);
  const game = b.sec - a.sec, ticks = b.tick - a.tick, exp = game / 360;
  rec('T1 ×900 accepted with a waypoint', ok900, { requested: s.requested, rates: [...rates] });
  rec('T2 ticks ≈ game s / 360 (±15 %)', game > 3600 && Math.abs(ticks - exp) <= Math.max(1, exp * 0.15), { gameS: Math.round(game), ticks, expected: +exp.toFixed(1), realS: Math.round((Date.now() - t0) / 1000) });
  rec('T3 no chunk missing ahead (max seen)', maxMissing === 0, { maxMissing, throttledSeen, drops: [...drops] });
  rec('T4 chunk main-thread p95 (ms, SwiftShader)', p95 <= 6, { p95, workers: s.chunkWorker });
  rec('T5 distance travelled (km)', null, { km: +(s.distanceM / 1000).toFixed(1), waypointKm: +s.waypointKm.toFixed(1), rebases: s.rebases, simGapKm: +b.km.toFixed(2) });
  rec('travel page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
if (ONLY.includes('border')) {
  const { page, errs } = await open('command-border');
  let s = await stats(page);
  rec('B1 border warning at ~1.5 km', !!s.border && s.border.distM < 2500, s.border);
  // Autopilot across the border: it must stop and ask.
  await page.evaluate(() => {
    const s = window.__cmdStats, I = window.__cmd, w = I.where();
    const b = s.border; // {owner, distM, x, z}
    const P = I.controller.ent;
    const dx = b.x - P.pos.x, dz = b.z - P.pos.z, d = Math.hypot(dx, dz) || 1;
    const tx = P.pos.x + (dx / d) * (d + 3000), tz = P.pos.z + (dz / d) * (d + 3000);
    const ll = I.frame.latLonOfScene(tx, tz, { lat: 0, lon: 0 });
    I.setWaypoint(ll.lat, ll.lon);
    I.requestRate(10);
    void w;
  });
  let asked = false;
  for (let i = 0; i < 180 && !asked; i++) {
    await wait(1000);
    s = await stats(page);
    asked = !!s.dialog;
  }
  rec('B2 confirmation before crossing', asked, { dialog: s.dialog, border: s.border, rate: s.rate });
  // Accept: the first button of the command dialog.
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('.fu-cmdx-dialog.show button.danger');
    btn?.click();
    return btn?.textContent ?? null;
  });
  let inc = null;
  for (let i = 0; i < 240 && !inc; i++) {
    await wait(1000);
    inc = await page.evaluate(() => window.__cmd.ctx.sim.view.command?.incursions?.[0] ?? null);
  }
  rec('B3 incursion raised by the sim', !!inc, { clicked, incursion: inc });
  if (inc) {
    const t0 = await page.evaluate(() => window.__cmd.ctx.sim.view.command.sec);
    let r = inc;
    for (let i = 0; i < 300 && !(r && r.response !== 'none'); i++) {
      await wait(1000);
      r = await page.evaluate(() => window.__cmd.ctx.sim.view.command?.incursions?.[0] ?? null);
    }
    const t1 = await page.evaluate(() => window.__cmd.ctx.sim.view.command.sec);
    const decided = r && r.response !== 'none' ? r.response : null;
    const since = decided ? r.respondedSec - r.enteredSec : t1 - t0;
    rec('B4 AI decision 30–90 game s after entering', !!decided && since >= 25 && since <= 100, { response: decided, gameS: Math.round(since), incursion: r });
    const alerts = await page.evaluate(() => document.querySelector('.fu-cmdx-alerts, [class*="alert"]')?.textContent?.slice(0, 200) ?? '');
    rec('B5 alert in the command HUD', null, alerts);
  }
  rec('border page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
if (ONLY.includes('front')) {
  const { page, errs } = await open('command-front');
  const s = await stats(page);
  const pools = s.pools?.pools ?? [];
  const war = pools.filter((p) => p.relation === 'war');
  const infOk = war.every((p) => p.shownInfantry === Math.min(40, Math.floor(p.front + p.offensive)) || p.shownInfantry === Math.min(40, Math.round(p.front + p.offensive)));
  rec('F1 forces from deriveLocalForces (infantry = min(40, pool))', war.length > 0 && infOk, war.map((p) => ({ owner: p.owner, front: Math.round(p.front), shown: p.shownInfantry, divisions: p.divisions })));
  const f = await page.evaluate(async () => {
    const I = window.__cmd, v = I.ctx.sim.view, w = I.world;
    const soldier = w.ents.find((e) => e.alive && e.team === 1 && e.kind === 'soldier' && e.src && !e.neutral);
    const tank = w.ents.find((e) => e.alive && e.team === 1 && e.kind === 'tank' && e.src?.kind === 'division');
    const owner = soldier?.src.owner ?? tank?.src.owner;
    const troops0 = v.players?.get?.(owner)?.troops ?? v.playerList.find((p) => p.id === owner)?.troops;
    const div0 = tank ? v.units.get(tank.src.id)?.hp : null;
    if (soldier) w.kill(soldier, w.player, true);
    if (tank) w.kill(tank, w.player, true);
    return { owner, troops0, div0, divId: tank?.src.id ?? 0, soldier: !!soldier, tank: !!tank };
  });
  await wait(6000);
  const f2 = await page.evaluate(({ owner, divId }) => {
    const v = window.__cmd.ctx.sim.view;
    return { troops1: v.players?.get?.(owner)?.troops ?? v.playerList.find((p) => p.id === owner)?.troops, div1: divId ? v.units.get(divId)?.hp : null, stats: { killsBy: window.__cmdStats.killsBy, unitHitN: window.__cmdStats.unitHitN } };
  }, f);
  rec('F2 soldier kill → 25 troops leave the owner', f.soldier && f.troops0 - f2.troops1 >= 25 - 1e-6, { before: f.troops0, after: f2.troops1, note: 'troops also change with the sim economy' });
  rec('F3 tank kill → 25 % off its division', f.tank && f.div0 != null && f2.div1 != null && Math.abs(f.div0 - f2.div1 - 0.25) < 0.06, { before: f.div0, after: f2.div1, ...f2.stats });
  // Own loss.
  const own0 = await page.evaluate(() => ({ integrity: window.__cmdStats.integrity, alive: window.__cmdStats.formationAlive }));
  await page.evaluate(() => { const I = window.__cmd; I.world.godMode = false; I.world.kill(I.world.player, null, false); });
  let own1 = null;
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    own1 = await page.evaluate(() => ({ integrity: window.__cmdStats.integrity, alive: window.__cmdStats.formationAlive, phase: window.__cmdStats.phase, lost: window.__cmdStats.vehiclesLost }));
    if (own1.phase === 'play' && own1.lost > 0) break;
  }
  const hpSim = (await syncState(page)).sim?.hp;
  rec('F4 own tank lost → −25 % and next vehicle', Math.abs(own0.integrity - own1.integrity - 0.25) < 0.02 && own1.phase === 'play', { before: own0, after: own1, simHp: hpSim });
  rec('front page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
if (ONLY.includes('jet')) {
  const { page, errs } = await open('command-jet');
  const s = await stats(page);
  const hostile = await page.evaluate(() => window.__cmd.world.ents.filter((e) => e.alive && e.team === 1 && e.kind === 'jet').map((e) => e.src?.kind ?? 'none'));
  rec('J1 fighter at its real altitude', s.alt > 1500, { altM: Math.round(s.alt) });
  rec('J2 enemy aircraft only from real squadrons', hostile.every((k) => k === 'squadron'), hostile);
  rec('jet page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

if (ONLY.includes('ship')) {
  const { page, errs } = await open('command-ship-coast');
  const s = await stats(page);
  rec('S1 warship in own territorial waters, no hostiles at peace', /territoriales propias|own territorial/i.test(s.info) && s.hostiles === 0, { info: s.info.split('\n')[1]?.trim(), hostiles: s.hostiles });
  rec('ship page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

await browser.close();
const fails = results.filter((r) => r.ok === false).length;
console.log(`\n${results.filter((r) => r.ok === true).length} pass, ${fails} fail, ${results.filter((r) => r.ok === null).length} info`);
fs.mkdirSync('shots/W5-command-v2', { recursive: true });
fs.writeFileSync('shots/W5-command-v2/verify.json', JSON.stringify(results, null, 1));
process.exit(fails ? 1 : 0);
