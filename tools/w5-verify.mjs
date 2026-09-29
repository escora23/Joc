// FRONT ULTRA — W5 command mode v2 verifier (DESIGN_V2 §9, V2-STATUS W5 acceptance criteria). Test tooling only.
//
//   node tools/w5-verify.mjs [--url http://127.0.0.1:5450/] [--only peace,travel,border,front,jet,ship]
// Results merge into shots/W5-command-v2/verify.json (one section per run fits a SwiftShader session).
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
//      sim's borderIncursion, the radio warning with its countdown, the interception when the grace ends, the escort's
//      driving (speeds, distance, no ramming) and, ignoring the last warning, fire or war (owner feedback #19/#20);
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
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); if (/^\[command\] border/.test(m.text())) console.log('  ' + m.text()); });
  await page.goto(`${BASE}?shot=${shot}&live=1`, { waitUntil: 'load', timeout: 120000 });
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
  // Drive at it at ×1 (near a border travel drops to ×1). Under SwiftShader a frame takes seconds and the local step
  // is clamped to 0.1 s, so the vehicle is advanced here at 15 m per real second (below the tank's 18 m/s, the sim's
  // clock runs 1:1 with real time), straight at the nearest border point; the frame loop does the rest.
  const push = (m) => page.evaluate((m) => {
    const s = window.__cmdStats, I = window.__cmd, P = I.controller.ent;
    const b = s.border;
    if (!b && !window.__w5dir) return false;
    // The direction is fixed once, toward the nearest border point at the start: the drawn line can lie past that
    // tile-edge point, and aiming at it again from beyond would turn the tank around.
    if (!window.__w5dir) {
      const dx = b.x - P.pos.x, dz = b.z - P.pos.z, d = Math.hypot(dx, dz) || 1;
      window.__w5dir = { x: dx / d, z: dz / d };
    }
    const ux = window.__w5dir.x, uz = window.__w5dir.z;
    P.pos.x += ux * m;
    P.pos.z += uz * m;
    P.pos.y = I.ground.heightAt(P.pos.x, P.pos.z);
    P.yaw = Math.atan2(-ux, -uz);
    return true;
  }, m);
  let asked = false;
  for (let i = 0; i < 200 && !asked; i++) {
    await push(15);
    await wait(1000);
    s = await stats(page);
    asked = !!s.dialog;
  }
  const early = await page.evaluate(() => window.__cmd.ctx.sim.view.command?.incursions?.length ?? 0);
  rec('B2 confirmation before crossing (no incursion in the sim yet)', asked && early === 0, { dialog: s.dialog, border: s.border, simIncursions: early });
  // Accept: the first button of the command dialog.
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('.fu-cmdx-dialog.show button.danger');
    btn?.click();
    return btn?.textContent ?? null;
  });
  let inc = null;
  for (let i = 0; i < 240 && !inc; i++) {
    if (i < 90) await page.evaluate(() => {
      const I = window.__cmd, P = I.controller.ent;
      P.pos.x += window.__w5dir.x * 15;
      P.pos.z += window.__w5dir.z * 15;
      P.pos.y = I.ground.heightAt(P.pos.x, P.pos.z);
    });
    await wait(1000);
    inc = await page.evaluate(() => window.__cmd.ctx.sim.view.command?.incursions?.[0] ?? null);
  }
  const dbg = await page.evaluate(() => {
    const I = window.__cmd, v = I.ctx.sim.view, s = window.__cmdStats;
    return { land: s.landOwner, local: I.where(), sim: v.command?.controlled?.[0], moves: v.command?.moves, dialog: I.overlay.dialogOpen, log: v.command?.log?.slice(-4) };
  });
  rec('B3 incursion raised by the sim after the confirmation', !!inc && !!clicked && !inc.left, { clicked, incursion: inc, ...(inc ? {} : { dbg }) });
  if (inc) {
    // Owner feedback #19: the warning at once, with its countdown, a short grace in real seconds, then the interception.
    await wait(1500);
    const radio = await page.evaluate(() => window.__cmd.overlay.radioText);
    rec('B4 radio warning at once with a countdown', /\d+\s*s/.test(radio) && inc.graceSec > 0 && inc.graceSec <= 40, { graceSec: inc.graceSec, radio: radio.slice(0, 220) });
    // Hold still inside (never touch the controls): the grace runs out.
    let r = inc;
    for (let i = 0; i < 200 && !(r && r.response !== 'none'); i++) {
      await wait(1000);
      r = await page.evaluate(() => window.__cmd.ctx.sim.view.command?.incursions?.[0] ?? null);
    }
    const since = r && r.response !== 'none' ? r.respondedSec - r.enteredSec : -1;
    rec('B5 the victim answers when the grace ends (game s = real s at ×1)', !!r && r.response !== 'none' && Math.abs(since - r.graceSec) <= 2, { response: r?.response, gameS: +since.toFixed(1), graceSec: r?.graceSec, qrf: r?.qrf && { mode: r.qrf.mode, source: r.qrf.source, vehicles: r.qrf.vehicles, etaS: Math.round(r.qrf.arriveSec - r.qrf.dispatchSec) } });
    if (r?.qrf) {
      const eta = r.qrf.arriveSec - r.qrf.dispatchSec;
      rec('B6 interception arrives in 1.5–5 game min (ground)', eta >= 90 && eta <= 300, { etaS: Math.round(eta), source: r.qrf.source });
      // Watch the escort: speeds, distance to the intruder, turning; until the last warning runs out.
      const samples = [];
      let arrivedAt = -1, fired = null;
      for (let i = 0; i < 520 && !fired; i++) {
        await wait(1000);
        const o = await page.evaluate(() => {
          const I = window.__cmd, v = I.ctx.sim.view, P = I.controller.ent;
          const inc = v.command?.incursions?.[0] ?? null;
          const q = I.world.ents.filter((e) => e.alive && e.src?.kind === 'qrf' && !['soldier', 'at'].includes(e.kind));
          return {
            sec: v.command?.sec ?? 0, response: inc?.response, arrived: !!inc?.qrf?.arrived, deadline: inc?.deadlineSec ?? 0, radio: I.overlay.radioText,
            q: q.map((e) => ({ id: e.id, kind: e.kind, d: Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z), v: e.speed, yaw: e.yaw, neutral: e.neutral })),
          };
        });
        samples.push(o);
        if (o.arrived && arrivedAt < 0) arrivedAt = o.sec;
        if (o.response === 'engage' || o.response === 'war') fired = o;
      }
      const near = samples.flatMap((o) => o.q.filter((e) => e.d < 2500));
      const minD = near.length ? Math.min(...near.map((e) => e.d)) : -1;
      const maxV = near.length ? Math.max(...near.map((e) => e.v)) : -1;
      rec('B7 escort vehicles: APCs/tanks, road speeds (≤ 16 m/s near you), never closer than 25 m, neutral until told', near.length > 0 && minD >= 25 && maxV <= 16.5 && near.every((e) => e.neutral) && samples.some((o) => o.q.every((e) => e.kind === 'ifv' || e.kind === 'tank')),
        { samplesNear: near.length, minDistM: Math.round(minD), maxSpeedMs: +maxV.toFixed(1), kinds: [...new Set(samples.flatMap((o) => o.q.map((e) => e.kind)))] });
      const lastRadio = samples.find((o) => o.arrived)?.radio ?? '';
      rec('B8 on arrival: the last warning on the radio', arrivedAt > 0 && /\d/.test(lastRadio), { radio: lastRadio.slice(0, 200) });
      rec('B9 ignoring it: the victim opens fire or declares war', !!fired, fired ? { response: fired.response, afterArrivalS: Math.round(fired.sec - arrivedAt) } : { last: samples.at(-1)?.response });
    }
  }
  rec('border page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
if (ONLY.includes('front')) {
  const { page, errs } = await open('command-front');
  const s = await stats(page);
  const sides = s.pools?.sides ?? [];
  const war = sides.filter((p) => p.relation === 'war');
  const near = s.pools?.frontKm >= 0 && s.pools.frontKm < 6;
  const infOk = near && war.some((p) => p.shownInfantry > 0) && war.every((p) => p.shownInfantry === 0 || p.shownInfantry === Math.min(40, Math.round(p.front + p.offensive)));
  rec('F1 infantry shown = min(40, front + offensive pool)', infOk, { frontKm: s.pools?.frontKm, sides: war.map((p) => ({ owner: p.owner, front: Math.round(p.front), offensive: Math.round(p.offensive), shown: p.shownInfantry })) });
  // The same point through the shared derivation (window.__localForces = deriveLocalForces): equal pools; every real
  // enemy division within 30 km drawn with its tanks at its position.
  const same = await page.evaluate(() => {
    const I = window.__cmd, w = I.where();
    const lf = window.__localForces.at(w.x, w.y, 30);
    const log = window.__cmdStats.pools.sides;
    const poolsEqual = lf.sides.every((sd) => {
      const l = log.find((x) => x.owner === sd.owner);
      return !!l && Math.abs(l.front - sd.pools.front) <= Math.max(2, sd.pools.front * 0.1) && Math.abs(l.rear - sd.pools.rear) <= Math.max(2, sd.pools.rear * 0.1);
    });
    const divs = lf.units.filter((u) => u.tanks > 0 && u.distKm <= 30);
    const drawn = divs.map((u) => {
      const ents = I.world.ents.filter((e) => e.alive && e.kind === 'tank' && e.src?.kind === 'division' && e.src.id === u.unitId);
      let cx = 0, cz = 0;
      for (const e of ents) { cx += e.pos.x; cz += e.pos.z; }
      const sc = I.frame.sceneOf(u.lat, u.lon, { x: 0, z: 0 });
      const off = ents.length ? Math.hypot(cx / ents.length - sc.x, cz / ents.length - sc.z) : -1;
      return { unitId: u.unitId, owner: u.owner, tanks: u.tanks, drawn: ents.length, offM: Math.round(off) };
    });
    return { poolsEqual, drawn, src: 'deriveLocalForces' };
  });
  const ctrlId = await page.evaluate(() => window.__cmd.ctx.sim.view.command?.controlled?.[0]?.unitId);
  const others = same.drawn.filter((d) => d.unitId !== ctrlId);
  rec('F1b pools = deriveLocalForces at the same point; real divisions drawn as 1 tank per 25 %', same.poolsEqual && others.every((d) => d.drawn === d.tanks), others);
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
  // The casualties go out with the next flush (every 2 s of frames); poll the sim view (SwiftShader frames are slow).
  const tKill = Date.now();
  let f2 = null;
  for (let i = 0; i < 40; i++) {
    await wait(1000);
    f2 = await page.evaluate(({ owner, divId }) => {
      const v = window.__cmd.ctx.sim.view;
      return { troops1: v.players?.get?.(owner)?.troops ?? v.playerList.find((p) => p.id === owner)?.troops, div1: divId ? v.units.get(divId)?.hp : null, stats: { killsBy: window.__cmdStats.killsBy, unitHitN: window.__cmdStats.unitHitN } };
    }, f);
    if ((!f.soldier || f.troops0 - f2.troops1 >= 25 - 1e-6) && (!f.tank || f2.div1 == null || f.div0 - f2.div1 > 0.2)) break;
  }
  f2.realS = Math.round((Date.now() - tKill) / 1000);
  rec('F2 soldier kill → 25 troops leave the owner', f.soldier && f.troops0 - f2.troops1 >= 25 - 1e-6, { before: f.troops0, after: f2.troops1, realS: f2.realS });
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
  // Lose every remaining tank: the division dies in the sim, the debrief shows and the app returns to the map.
  const unitId = await page.evaluate(() => window.__cmd.ctx.sim.view.command?.controlled?.[0]?.unitId ?? window.__w5unit);
  let back = false, st2 = null;
  for (let i = 0; i < 150 && !back; i++) {
    st2 = await page.evaluate(() => {
      const I = window.__cmd, s = window.__cmdStats;
      if (I?.world?.player?.alive && s?.phase === 'play') I.world.kill(I.world.player, null, false);
      return { phase: s?.phase, lost: s?.vehiclesLost, integrity: s?.integrity, app: window.__front.app.state };
    });
    back = st2.app === 'playing';
    await wait(1000);
  }
  const gone = await page.evaluate((id) => !window.__front.ctx.sim.view.units.get(id), unitId);
  rec('F5 last tank lost → division destroyed, debrief, back to the map', back && gone, { ...st2, unitGone: gone });
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

// Owner feedback #18: releasing control never sends the unit back. Tank inside a neighbour (the escort staging):
// exit, then the unit stays exactly there while the strategic clock runs, and the incursion goes on.
async function exitToMap(page) {
  await page.evaluate(() => window.__cmd.debrief());
  for (let i = 0; i < 120; i++) {
    await wait(1000);
    if (await page.evaluate(() => window.__front?.app?.state === 'playing')) return true;
  }
  return false;
}
if (ONLY.includes('release')) {
  const { page, errs } = await open('command-escort');
  const before = await page.evaluate(() => {
    const v = window.__cmd.ctx.sim.view, id = v.command.controlled[0].unitId, u = v.units.get(id);
    window.__w5unit = id;
    return { id, x: u.x, y: u.y, heading: u.heading, inc: v.command.incursions[0]?.response };
  });
  const out = await exitToMap(page);
  await page.evaluate(() => window.__front.ctx.sim.setSpeed(1));
  await wait(20000);
  const after = await page.evaluate((id) => {
    const v = window.__front.ctx.sim.view, u = v.units.get(id);
    const inc = v.command?.incursions?.find((i) => i.unitId === id);
    const feed = document.body.innerText.match(/sigue dentro de[^\n]*/i)?.[0] ?? '';
    return { tick: v.tick, x: u?.x, y: u?.y, heading: u?.heading, mode: u?.mode, controlled: (v.command?.controlled ?? []).some((c) => c.unitId === id), inc: inc ? { response: inc.response, left: inc.left } : null, feed };
  }, before.id);
  const km = after.x !== undefined ? Math.hypot((after.x - before.x) * 25 * Math.cos(42.5 * Math.PI / 180), (after.y - before.y) * 25) : -1;
  rec('R1 released inside foreign land: the division holds where it was left', out && !after.controlled && km >= 0 && km < 0.05, { km: +km.toFixed(3), before, after });
  rec('R2 the incursion goes on on the strategic map (and says so)', !!after.inc && (!after.inc.left || after.inc.response === 'war') && /sigue dentro/i.test(after.feed), { inc: after.inc, feed: after.feed.slice(0, 120) });
  rec('release page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}
if (ONLY.includes('jetrelease')) {
  const { page, errs } = await open('command-jet-cap');
  const before = await page.evaluate(() => {
    const v = window.__cmd.ctx.sim.view, id = v.command.controlled[0].unitId, u = v.units.get(id);
    return { id, x: u.x, y: u.y };
  });
  const out = await exitToMap(page);
  await page.evaluate(() => window.__front.ctx.sim.setSpeed(1));
  await wait(25000);
  const after = await page.evaluate((id) => {
    const v = window.__front.ctx.sim.view, u = v.units.get(id);
    return { tick: v.tick, x: u?.x, y: u?.y, mode: u?.mode, alt: u?.alt, order: u?.order };
  }, before.id);
  const km = after.x !== undefined ? Math.hypot((after.x - before.x) * 25 * Math.cos(41 * Math.PI / 180), (after.y - before.y) * 25) : -1;
  // A combat air patrol orbits its station at 0.6 × the 6-tile CAP radius (~90 km): it holds over the spot.
  rec('R3 released fighter flies a holding orbit over the spot (no return to base)', out && after.alt > 0 && after.order === 4 && km >= 0 && km < 120, { km: +km.toFixed(1), after });
  rec('jetrelease page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// Criterion 14 / owner feedback #21: T on a division inside a visible ground battle keeps that battle's forces.
if (ONLY.includes('handoff')) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}?shot=front-ground-real`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 1000 });
  const h = await page.evaluate(() => {
    const { ctx } = window.__front;
    const ho = ctx.battle.handoff?.() ?? null;
    let best = null, bd = Infinity;
    if (ho) {
      for (const u of ctx.sim.view.units.values()) {
        if (u.owner !== 1 || u.type !== 3 || !(u.hp > 0)) continue;
        const lat = 90 - (u.y / 800) * 180, lon = (u.x / 1600) * 360 - 180;
        const d = Math.hypot(lat - ho.lat, (lon - ho.lon) * Math.cos((lat * Math.PI) / 180));
        if (d < bd) { bd = d; best = u.id; }
      }
    }
    return { ho, unitId: best, degFromAnchor: bd };
  });
  if (!h.ho || !h.unitId) rec('H1 a visible ground battle with a human division to take', false, h);
  else {
    await page.evaluate((id) => window.__front.app.enterCommandMode(id), h.unitId);
    await page.waitForFunction(() => window.__cmdStats?.phase === 'play' || window.__cmdStats?.phase === 'intro', null, { timeout: 300000, polling: 1000 }).catch(() => undefined);
    await wait(8000);
    const c = await page.evaluate(() => {
      const I = window.__cmd, per = {};
      for (const e of I.world.ents) if (e.alive && (e.kind === 'soldier' || e.kind === 'at') && e.src?.kind === 'pool') per[e.nation] = (per[e.nation] ?? 0) + 1;
      const divs = {};
      for (const e of I.world.ents) if (e.alive && e.src?.kind === 'division' && e.kind === 'tank') divs[e.src.id] = (divs[e.src.id] ?? 0) + 1;
      return { per, divs };
    });
    const rows = h.ho.infantry.map((s) => ({ owner: s.owner, battle: s.count, command: c.per[s.owner] ?? 0 }));
    const ok = rows.every((r) => Math.abs(r.command - r.battle) <= Math.max(2, r.battle * 0.1));
    rec('H1 infantry per side: battle view = command mode (±10 %)', ok, rows);
    const drows = h.ho.divisions.map((d) => ({ unitId: d.unitId, battle: d.tanks, command: c.divs[d.unitId] ?? 0 }));
    rec('H2 the battle\'s real divisions are there with the same tanks', drows.every((d) => d.battle === d.command || d.unitId === h.unitId), drows);
  }
  rec('handoff page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

await browser.close();
const fails = results.filter((r) => r.ok === false).length;
console.log(`\n${results.filter((r) => r.ok === true).length} pass, ${fails} fail, ${results.filter((r) => r.ok === null).length} info`);
fs.mkdirSync('shots/W5-command-v2', { recursive: true });
// Merge with the results of earlier runs of other sections (a section at a time fits a SwiftShader session).
let prev = [];
try { prev = JSON.parse(fs.readFileSync('shots/W5-command-v2/verify.json', 'utf8')); } catch { prev = []; }
const ids = new Set(results.map((r) => r.id));
fs.writeFileSync('shots/W5-command-v2/verify.json', JSON.stringify([...prev.filter((r) => !ids.has(r.id)), ...results.map((r) => ({ ...r, at: new Date().toISOString() }))], null, 1));
process.exit(fails ? 1 : 0);
