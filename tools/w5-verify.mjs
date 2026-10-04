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
//   F  at a front: the forces equal deriveLocalForces (infantry shown = the item-32 battle at the sim's density), a kill of an enemy soldier
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
  rec('D2i controlled unit view updates during the ×60 autopilot (real time, SwiftShader)', null, { distinctPositions: views, realS: Math.round((Date.now() - tDrive) / 1000), moves: s2.moves });
  // Criterion 3 in simulated time: drive at ×1 with W held; every whole local second of driving must carry ≥ 1 move
  // sent and ≥ 1 change of the unit's position in the sim view.
  await page.evaluate(() => { window.__cmd.clearWaypoint(); window.__cmd.requestRate(1); });
  await wait(3000);
  await page.keyboard.down('KeyW');
  let cad = [];
  const tW = Date.now();
  for (let i = 0; i < 300; i++) {
    await wait(1000);
    cad = await page.evaluate(() => window.__cmd.cadence());
    if (cad.length >= 12) break;
  }
  await page.keyboard.up('KeyW');
  const whole = cad.slice(1, -1);
  const worstMoves = whole.length ? Math.min(...whole.map((c) => c.moves)) : 0, worstViews = whole.length ? Math.min(...whole.map((c) => c.views)) : 0;
  rec('D2 at ×1: ≥ 1 move sent and ≥ 1 view update per local second of driving', whole.length >= 5 && worstMoves >= 1 && worstViews >= 1,
    { localSeconds: whole.length, worstMoves, worstViews, realS: Math.round((Date.now() - tW) / 1000), buckets: whole.slice(0, 20) });
  // Exit.
  await page.evaluate(() => window.__cmd.debrief());
  let exited = false;
  for (let i = 0; i < 300 && !exited; i++) {
    await wait(1000);
    exited = await page.evaluate(() => window.__front?.app?.state === 'playing');
  }
  for (let i = 0; i < 90; i++) {
    await wait(1000);
    const alt = await page.evaluate(() => { const c = { altitudeKm: 0 }; window.__front.ctx.cameraRig.getState(c); return c.altitudeKm; });
    if (alt > 850) break;
  }
  await wait(3000);
  const ex = await page.evaluate((id) => {
    const { ctx } = window.__front;
    const cam = { lat: 0, lon: 0, altitudeKm: 0, tilt: 0, heading: 0 };
    ctx.cameraRig.getState(cam);
    const u = ctx.sim.view.units.get(id);
    return { cam, unit: u ? { x: u.x, y: u.y } : null, controlled: (ctx.sim.view.command?.controlled ?? []).some((c) => c.unitId === id), clock: ctx.sim.view.clock };
  }, end.unitId);
  // Feedback 3 (29e): the strategic camera comes back looking at the place, at a regional altitude (900 km, tilted).
  const camOk = ex.unit && ex.cam.altitudeKm >= 600 && ex.cam.altitudeKm <= 2800 &&
    Math.abs(ex.cam.lat - (90 - (ex.unit.y / 800) * 180)) < 3 && Math.abs(ex.cam.lon - ((ex.unit.x / 1600) * 360 - 180)) < 3;
  rec('X1 exit: strategic camera over the new position (600-2,800 km)', exited && !!camOk, ex);
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
  // Gauntlet fix: Enter means «Volver» (safe default), and going back turns the tank physically (no 180° in a frame).
  const yaw0 = await page.evaluate(() => window.__cmd.controller.ent.yaw);
  await page.keyboard.press('Enter');
  await wait(1200);
  const back1 = await page.evaluate(() => ({ yaw: window.__cmd.controller.ent.yaw, dialog: window.__cmd.overlay.dialogOpen, turnBack: window.__cmdStats.turnBack, land: window.__cmdStats.landOwner, inc: window.__cmd.ctx.sim.view.command?.incursions?.length ?? 0 }));
  const dYaw = (a, b) => Math.abs(((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  rec('B2b Enter at the border means «Volver»: no crossing, no incursion', !back1.dialog && back1.inc === 0 && back1.turnBack > 0, back1);
  rec('B2c going back turns the tank physically (no instant 180°)', dYaw(yaw0, back1.yaw) < 2.6, { yaw0: +yaw0.toFixed(2), after: +back1.yaw.toFixed(2), turnedDeg: Math.round((dYaw(yaw0, back1.yaw) * 180) / Math.PI) });
  // Wait for the turn to finish (facing home, on our side), then drive at the line again: the question comes back.
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    if (!(await page.evaluate(() => window.__cmdStats.turnBack))) break;
  }
  asked = false;
  for (let i = 0; i < 200 && !asked; i++) {
    await push(15);
    await wait(1000);
    s = await stats(page);
    asked = !!s.dialog;
  }
  rec('B2d driving at the line again asks again', asked, { dialog: s.dialog });
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
    let radio = '';
    for (let i = 0; i < 15 && !radio; i++) {
      await wait(1000);
      radio = await page.evaluate(() => window.__cmd.overlay.radioText);
    }
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
      for (let i = 0; i < 1800 && !fired; i++) {
        // SwiftShader runs the local physics ~10× slower than real time while the sim's clock keeps real time; top the
        // local world up by one local second per wall second (no rendering) so the escort's drive in the scene keeps
        // roughly the pace it has on a GPU. Speeds are measured in local time either way. The sample is read after
        // rendered frames, so the HUD (radio) has caught up with the top-up.
        await page.evaluate(() => window.__cmd.simulate(30, 1 / 30));
        await wait(1000);
        // Two rendered frames after the top-up, so the radio (updated in the frame) describes the positions sampled.
        await page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 20000); }));
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
        if (i % 30 === 0) console.log(`  t=${i}s sec=${o.sec.toFixed(0)} ${o.response} arrived=${o.arrived} deadline=${o.deadline.toFixed(0)} nearest=${o.q.length ? Math.round(Math.min(...o.q.map((e) => e.d))) : '-'} m`);
        if (o.arrived && arrivedAt < 0) arrivedAt = o.sec;
        if (o.response === 'engage' || o.response === 'war') fired = o;
      }
      // In sight (≤ 1.5 km) the escort drives under vehicle physics; farther out it keeps the sim's road schedule.
      const near = samples.flatMap((o) => o.q.filter((e) => e.d < 1400));
      const minD = near.length ? Math.min(...near.map((e) => e.d)) : -1;
      const maxV = near.length ? Math.max(...near.map((e) => e.v)) : -1;
      const calm = samples.filter((o) => o.response !== 'engage' && o.response !== 'war').flatMap((o) => o.q);
      rec('B7 escort vehicles: APCs/tanks, road speeds (≤ 16 m/s near you), never closer than 25 m, neutral until told', near.length > 0 && minD >= 25 && maxV <= 16.5 && calm.every((e) => e.neutral) && samples.some((o) => o.q.every((e) => e.kind === 'ifv' || e.kind === 'tank')),
        { samplesNear: near.length, minDistM: Math.round(minD), maxSpeedMs: +maxV.toFixed(1), kinds: [...new Set(samples.flatMap((o) => o.q.map((e) => e.kind)))] });
      // Criterion #20: the last warning's clock starts only with a vehicle really alongside (≤ 160 m) in the scene.
      const firstDl = samples.find((o) => o.deadline > 0 && o.response === 'intercept');
      const dlNear = firstDl && firstDl.q.length ? Math.min(...firstDl.q.map((e) => e.d)) : -1;
      rec('B7b the last warning starts only when an escort vehicle is alongside in the scene', !!firstDl && dlNear >= 0 && dlNear <= 200 && samples.filter((o) => o.arrived && o.deadline === 0 && o.response === 'intercept').every((o) => !o.q.length || Math.min(...o.q.map((e) => e.d)) > 100),
        { nearestAtStartM: Math.round(dlNear), startSec: firstDl?.sec, deadline: firstDl?.deadline });
      const lastRadio = samples.find((o) => o.arrived && o.deadline > 0)?.radio ?? '';
      rec('B8 on arrival: the last warning on the radio', arrivedAt > 0 && /\d/.test(lastRadio), { radio: lastRadio.slice(0, 200) });
      // The radio matches the scene: «aquí la patrulla… no sigas avanzando» only with a vehicle within ~150 m; while it
      // is farther the radio says how far it still is («a 830 m de ti y acercándonos»).
      const esc = samples.filter((o) => o.arrived && o.response === 'intercept' && o.q.length);
      const bad = esc.filter((o) => { const d = Math.min(...o.q.map((e) => e.d)); const along = /no sigas avanzando|do not advance/i.test(o.radio); const closing = /acerc|closing/i.test(o.radio); return (along && d > 160) || (closing && d <= 140); });
      rec('B8b the radio says the patrol is alongside only when a vehicle is within ~150 m', esc.length > 0 && bad.length === 0, { samples: esc.length, mismatches: bad.slice(0, 3).map((o) => ({ d: Math.round(Math.min(...o.q.map((e) => e.d))), radio: o.radio.slice(0, 120) })) });
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
  // Owner item 32 replaced the 40-soldier token squad: a line at war stands as a battle at the sim's density
  // (src/command/battle.ts: front pool within ~16 km of line + offensive pool, at least min(60, pool), capped 900/650).
  const bt = s.battle?.sides ?? [];
  const infOk = near && war.some((p) => p.shownInfantry > 0) && war.every((p) => {
    const b = bt.find((q) => q.owner === p.owner);
    return p.shownInfantry === 0 || (!!b && b.target >= Math.min(60, Math.round(p.front + p.offensive)) && b.target <= 900 && Math.abs(p.shownInfantry - b.target) <= Math.max(3, b.target * 0.1));
  });
  rec('F1 infantry shown = the battle at the sim density (≥ min(60, pool), ≤ cap)', infOk, { frontKm: s.pools?.frontKm, sides: war.map((p) => ({ owner: p.owner, front: Math.round(p.front), offensive: Math.round(p.offensive), shown: p.shownInfantry, target: bt.find((q) => q.owner === p.owner)?.target })) });
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
  rec('J1 fighter at its real altitude', s.alt > 1500, { altM: Math.round(s.alt) });
  rec('jet page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// Criterion 11: enemy aircraft only from real covering squadrons or a scramble from an airbase at war within 150 km.
// Staged with both sources present (an enemy patrol ~40 km away, a docked squadron at an airbase ~95 km away).
if (ONLY.includes('jet') || ONLY.includes('jetsources')) {
  const { page, errs } = await open('command-jet-sources&live=1');
  // A few 2 s refreshes: the sources were staged just after the entry.
  await wait(30000);
  const r = await page.evaluate(() => {
    const I = window.__cmd, v = I.ctx.sim.view, P = I.controller.ent;
    const here = I.where();
    const km = (x, y) => Math.hypot((x - here.x) * 25 * Math.cos(here.lat * Math.PI / 180), (y - here.y) * 25);
    // Every real source: enemy squadrons airborne within the derivation radius (150 km), and enemy squadrons docked at
    // an airbase at war within 150 km.
    const war = (o) => v.pairState(1, o) === 'war';
    const sources = new Map();
    for (const u of v.units.values()) {
      // Fighter squadrons (UnitType 4) of a nation at war with us; docked = UnitMode 6 (ready) or 7 (rearming).
      if (u.type !== 4 || u.owner === 1 || !war(u.owner)) continue;
      const home = v.structures.get(u.home);
      const docked = u.mode === 6 || u.mode === 7;
      const d = km(u.x, u.y);
      if (!docked && d <= 150) sources.set(u.id, { kind: 'airborne', km: Math.round(d), mode: u.mode });
      else if (docked && home) {
        const hx = (home.tile % 1600) + 0.5, hy = Math.floor(home.tile / 1600) + 0.5;
        if (km(hx, hy) <= 150) sources.set(u.id, { kind: 'scramble', km: Math.round(km(hx, hy)), mode: u.mode });
      }
    }
    const jets = I.world.ents.filter((e) => e.kind === 'jet' && e.team === 1).map((e) => ({ src: e.src?.kind ?? 'none', id: e.src?.id ?? 0, alive: e.alive, distKm: +(e.pos.distanceTo(P.pos) / 1000).toFixed(1) }));
    return { jets, sources: Object.fromEntries(sources) };
  });
  const mapped = r.jets.every((j) => j.src === 'squadron' && r.sources[j.id]);
  const kinds = new Set(r.jets.map((j) => r.sources[j.id]?.kind).filter(Boolean));
  rec('J2 every enemy aircraft maps to a real source (a patrol within 150 km or a scramble from an airbase at war within 150 km), and some appear', r.jets.length > 0 && mapped, { jets: r.jets, sources: r.sources, kinds: [...kinds] });
  await page.screenshot({ path: 'shots/W5-command-v2/jet-sources.png', timeout: 180000 }).catch(() => undefined);
  rec('jetsources page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

if (ONLY.includes('ship')) {
  const { page, errs } = await open('command-ship-coast');
  const s = await stats(page);
  rec('S1 warship in own territorial waters, no hostiles at peace', /territoriales propias|own territorial/i.test(s.info) && s.hostiles === 0, { info: s.info.split('\n')[1]?.trim(), hostiles: s.hostiles });
  rec('ship page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// Criterion 5: compression drops to ×1 near a peaceful border (2 km) and is refused with contact (a front at war).
if (ONLY.includes('drops')) {
  {
    const { page, errs } = await open('command-border');
    // Back off to 3 km from the border, then travel toward a destination across it.
    const r = await page.evaluate(async () => {
      const I = window.__cmd, P = I.controller.ent, s = window.__cmdStats;
      const b = s.border, dx = b.x - P.pos.x, dz = b.z - P.pos.z, d = Math.hypot(dx, dz);
      P.pos.x -= (dx / d) * 1600;
      P.pos.z -= (dz / d) * 1600;
      P.pos.y = I.ground.heightAt(P.pos.x, P.pos.z);
      P.yaw = Math.atan2(-dx, -dz);
      const far = I.frame.latLonOfScene(P.pos.x + (dx / d) * 12000, P.pos.z + (dz / d) * 12000, { lat: 0, lon: 0 });
      I.setWaypoint(far.lat, far.lon);
      return { ok: I.requestRate(10), start: d + 1600 };
    });
    let st = null;
    for (let i = 0; i < 240; i++) {
      await wait(1000);
      st = await page.evaluate(() => ({ rate: window.__cmdStats.rate, requested: window.__cmdStats.requested, lastDrop: window.__cmdStats.lastDrop, borderM: window.__cmdStats.border?.distM ?? -1, dialog: window.__cmd.overlay.dialogOpen }));
      if (st.lastDrop || st.dialog) break;
    }
    rec('T5a travel drops to ×1 near a peaceful border', !!st && st.lastDrop === 'command.travel.border' && st.requested === 1 && st.borderM <= 2100, { ...r, ...st });
    rec('drops border page errors', errs.length === 0, errs.slice(0, 5));
    await page.close();
  }
  {
    const { page, errs } = await open('command-front');
    const r = await page.evaluate(() => {
      const I = window.__cmd;
      const P = I.controller.ent;
      const ll = I.frame.latLonOfScene(P.pos.x, P.pos.z - 20000, { lat: 0, lon: 0 });
      I.setWaypoint(ll.lat, ll.lon);
      const ok = I.requestRate(10);
      return { accepted: ok, notice: I.overlay.noticeText, requested: window.__cmdStats?.requested };
    });
    rec('T5b no compression with contact at a front', !r.accepted && /contacto|contact/i.test(r.notice), r);
    rec('drops front page errors', errs.length === 0, errs.slice(0, 5));
    await page.close();
  }
}

// Owner feedback #20 in local time (the escort's driving is local physics; under SwiftShader real time is too slow for it):
// the escort staging frozen in sim time, the tank driven with W for 90 local s, the patrol followed step by step.
if (ONLY.includes('escortsim')) {
  const { page, errs } = await open('command-escort&hold=1');
  const r = await page.evaluate(() => {
    const I = window.__cmd, P = I.controller.ent;
    I.freeze = true;
    // The intruder drives on at 30 km/h for 60 s (deeper in: the patrol must lead and flank it), then stops.
    const fwd = { x: -Math.sin(P.yaw), z: -Math.cos(P.yaw) };
    I.skipIntro();
    const esc = () => I.world.ents.filter((e) => e.alive && e.src?.kind === 'qrf' && e.kind !== 'soldier' && e.kind !== 'at');
    let minD = Infinity, maxV = 0, maxYawRate = 0, ram = 0;
    // Station keeping while the intruder drives on (30 km/h): each escort's distance from its station, 45-60 s.
    const lagLate = new Map();
    const prevYaw = new Map();
    const track = [];
    const start = P.pos.clone();
    for (let i = 0; i < 90 * 30; i++) {
      const v = i < 60 * 30 ? 8.3 : 0;
      // The intruder moves exactly v along its heading: the tank controller's own integration inside the step is
      // undone (it would add its coasting speed to the scripted displacement).
      const px = P.pos.x, pz = P.pos.z, pyaw = P.yaw;
      P.speed = v;
      I.simulate(1, 1 / 30);
      P.yaw = pyaw;
      P.speed = v;
      P.pos.x = px + fwd.x * v / 30;
      P.pos.z = pz + fwd.z * v / 30;
      P.pos.y = I.ground.heightAt(P.pos.x, P.pos.z);
      for (const e of esc()) {
        const d = Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z);
        minD = Math.min(minD, d);
        // Ramming: the escort's own velocity toward the intruder while within 40 m of it.
        if (d < 40 && d > 0.1) ram = Math.max(ram, (e.vel.x * (P.pos.x - e.pos.x) + e.vel.z * (P.pos.z - e.pos.z)) / d);
        maxV = Math.max(maxV, Math.abs(e.speed));
        const py = prevYaw.get(e.id);
        if (py !== undefined) { let dy = e.yaw - py; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI; maxYawRate = Math.max(maxYawRate, Math.abs(dy) * 30); }
        prevYaw.set(e.id, e.yaw);
      }
      if (i >= 45 * 30 && i < 60 * 30) for (const e of esc()) {
        const c = Math.cos(P.yaw), sn = Math.sin(P.yaw);
        const stx = P.pos.x + e.slot.x * c + e.slot.z * sn, stz = P.pos.z - e.slot.x * sn + e.slot.z * c;
        lagLate.set(e.id, Math.max(lagLate.get(e.id) ?? 0, Math.hypot(e.pos.x - stx, e.pos.z - stz)));
      }
      if (i % 300 === 0) track.push(esc().map((e) => {
        const c = Math.cos(P.yaw), sn = Math.sin(P.yaw);
        const stx = P.pos.x + e.slot.x * c + e.slot.z * sn, stz = P.pos.z - e.slot.x * sn + e.slot.z * c;
        return { d: Math.round(Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z)), lag: Math.round(Math.hypot(e.pos.x - stx, e.pos.z - stz)), v: +e.speed.toFixed(1) };
      }));
    }
    return { n: esc().length, minD: Math.round(minD), ramMs: +ram.toFixed(2), maxV: +maxV.toFixed(1), maxYawRateDeg: Math.round(maxYawRate * 180 / Math.PI), playerKm: +(P.pos.distanceTo(start) / 1000).toFixed(2), intruderKmh: +(P.pos.distanceTo(start) / 60 * 3.6).toFixed(1), final: esc().map((e) => Math.round(Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z))), track, lagLate: [...lagLate.values()].map((v) => Math.round(v)) };
  });
  rec('B10b while the intruder drives on at 30 km/h, every escort holds its station (≤ 60 m from it from 45 to 60 local s)', r.lagLate.length > 0 && r.lagLate.every((v) => v <= 60), { lagLate: r.lagLate, track: r.track });
  rec('B10 escort drives sensibly around an intruder driving at it (never drives into it: ≤ 1 m/s toward it inside 40 m; ≤ 16 m/s, turns ≤ 70°/s, stays with it)', r.n > 0 && r.ramMs <= 1 && r.maxV <= 16.5 && r.maxYawRateDeg <= 70 && r.final.every((d) => d < 400), r);
  rec('escortsim page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// Owner feedback #18: releasing control never sends the unit back. Tank inside a neighbour (the escort staging):
// exit, then the unit stays exactly there while the strategic clock runs, and the incursion goes on.
async function exitToMap(page) {
  // Wait on the app's own commandExit event (the report, the fade and the release take many SwiftShader frames).
  await page.evaluate(() => {
    window.__w5exit = false;
    window.__front.ctx.bus.on('commandExit', () => { window.__w5exit = true; });
    window.__cmd.debrief();
  });
  const ok = await page.waitForFunction(() => window.__w5exit === true && window.__front?.app?.state === 'playing', null, { timeout: 900000, polling: 1000 }).then(() => true).catch(() => false);
  return ok;
}
// Mean luma (0-255) of the middle of a screenshot: the first strategic frame after exit must show the globe, not a void.
async function frameLuma(page) {
  const { PNG } = await import('pngjs');
  const buf = await page.screenshot();
  const png = PNG.sync.read(buf);
  let sum = 0, n = 0;
  for (let y = Math.floor(png.height * 0.3); y < png.height * 0.7; y += 4) for (let x = Math.floor(png.width * 0.3); x < png.width * 0.7; x += 4) {
    const i = (y * png.width + x) * 4;
    sum += 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
    n++;
  }
  return sum / Math.max(1, n);
}
async function pausedState(page) {
  return page.evaluate(() => {
    const b = document.querySelector('.fu-autopause');
    return { speed: window.__front.ctx.sim.view.speed, banner: !!b && !b.classList.contains('fu-hidden'), kind: b?.dataset.kind ?? '', text: (b?.textContent ?? '').slice(0, 160) };
  });
}
if (ONLY.includes('release')) {
  const { page, errs } = await open('command-escort');
  const before = await page.evaluate(() => {
    const v = window.__cmd.ctx.sim.view, id = v.command.controlled[0].unitId, u = v.units.get(id);
    window.__w5unit = id;
    window.__front.ctx.bus.on('commandExit', () => { window.__w5exitSec = v.command?.sec ?? -1; });
    return { id, x: u.x, y: u.y, heading: u.heading, inc: v.command.incursions[0]?.response, sec: v.command.sec };
  });
  // The debrief's game time is the sim's command clock since entry (criterion 15).
  // The speed the player had on the map before entry comes back at exit (the staging held it at 0): ×1.
  await page.evaluate(() => window.__cmd.ctx.sim.setSpeed(1));
  const deb0 = await page.evaluate(() => { window.__cmd.debrief(); return window.__cmd.ctx.sim.view.command?.sec ?? -1; });
  await wait(1500);
  const deb = await page.evaluate(() => {
    const el = window.__cmd.overlay.debrief;
    return { text: el?.textContent ?? '', enterSec: window.__cmd.startCmdSec };
  });
  const out = await page.waitForFunction(() => window.__front?.app?.state === 'playing', null, { timeout: 900000, polling: 200 }).then(() => true).catch(() => false);
  // First frames after exit: the globe, never a black void (criterion 15).
  // Screens from the exit on: black while the fade covers it (luma ≈ 0), then every frame once it lifts shows the globe.
  const lumas = [];
  for (let i = 0; i < 10; i++) {
    lumas.push(Math.round(await frameLuma(page)));
    await wait(300);
  }
  const lift = lumas.findIndex((l) => l > 4);
  rec('X3 once the fade lifts after exit, every frame shows the globe (mean luma of the centre > 25)', out && lift >= 0 && lumas.slice(lift + 1).every((l) => l > 25), { lumas });
  const m = deb.text.match(/(\d+)\s*min\s*(\d+)\s*s/);
  const shownS = m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  rec('X4 debrief game time = the sim command clock since entry (±3 s)', shownS >= 0 && deb.enterSec >= 0 && Math.abs(shownS - (deb0 - deb.enterSec)) <= 3, { shownS, simS: +(deb0 - deb.enterSec).toFixed(1), text: deb.text.slice(0, 200) });
  const pz = await pausedState(page);
  rec('R0 released inside foreign land: the game pauses with the crisis (auto-pause «incursion»)', pz.speed === 0 && pz.banner && pz.kind === 'incursion' && /sigue dentro/i.test(pz.text), pz);
  // The player resumes without acting (the worst case): the unit must survive and the incident run its course.
  await page.evaluate(() => window.__front.ctx.sim.setSpeed(1));
  await wait(20000);
  const after = await page.evaluate((id) => {
    const v = window.__front.ctx.sim.view, u = v.units.get(id);
    const inc = v.command?.incursions?.find((i) => i.unitId === id);
    const feed = document.body.innerText.match(/sigue dentro de[^\n]*/i)?.[0] ?? '';
    return { log: (v.command?.log ?? []).slice(-6).map((l) => l.text.slice(0, 140)), war: inc ? v.pairState(1, inc.victim) : v.wars.map((w) => `${w.aggressor}-${w.target}`), tick: v.tick, x: u?.x, y: u?.y, heading: u?.heading, mode: u?.mode, controlled: (v.command?.controlled ?? []).some((c) => c.unitId === id), inc: inc ? { response: inc.response, left: inc.left } : null, feed };
  }, before.id);
  const km = after.x !== undefined ? Math.hypot((after.x - before.x) * 25 * Math.cos(42.5 * Math.PI / 180), (after.y - before.y) * 25) : -1;
  rec('R1 released inside foreign land: the division holds where it was left', out && !after.controlled && km >= 0 && km < 0.05, { km: +km.toFixed(3), before, after });
  // Either the incident still runs, or (the player resumed without acting for 20 game hours) it became a war — then
  // the incursion is over by definition and the unit, still in there, is at war inside that land; the row says so.
  const atWar = Array.isArray(after.war) ? after.war.length > 0 : after.war === 'war';
  rec('R2 the incursion goes on on the strategic map, or became a war with the unit still inside (and says so)', ((!!after.inc && !after.inc.left) || atWar) && /sigue dentro/i.test(after.feed), { inc: after.inc, war: after.war, feed: after.feed.slice(0, 160) });
  const hp = await page.evaluate((id) => window.__front.ctx.sim.view.units.get(id)?.hp ?? -1, before.id);
  rec('R1b left under fire by a 2-vehicle patrol, the division is worn down in proportion (≥ 85 % after 20 s at ×1)', hp >= 0.85, { hp, war: after.inc?.response === 'war' });
  rec('release page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// Owner feedback #18: the player can order a unit left inside out: paused on release, he selects it, orders it home
// and resumes; the victim holds fire while it leaves and the incursion ends without war or damage.
if (ONLY.includes('releaseout')) {
  const { page, errs } = await open('command-escort');
  const id = await page.evaluate(() => { const v = window.__cmd.ctx.sim.view; return v.command.controlled[0].unitId; });
  const out = await exitToMap(page);
  const pz = await pausedState(page);
  // Order it home: the nearest own land tile (as a right-click on own land does: unitOrder move).
  const ord = await page.evaluate((id) => {
    const { ctx } = window.__front, v = ctx.sim.view, u = v.units.get(id);
    let best = -1, bd = 1e9;
    const W = 1600;
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
      const t = (Math.floor(u.y) + dy) * W + ((Math.floor(u.x) + dx + W) % W);
      if (v.ownerAt(t) !== 1) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = t; }
    }
    ctx.sim.send({ type: 'unitOrder', unitIds: [id], order: 'move', tile: best, targetId: 0 });
    return { tile: best, hp: u.hp, inc: v.command?.incursions?.find((i) => i.unitId === id)?.response };
  }, id);
  // Resume with the banner's own button.
  await page.evaluate(() => document.querySelector('.fu-autopause .fu-btn--primary')?.click());
  let st = null;
  const seen = { leaving: false };
  for (let i = 0; i < 90; i++) {
    await wait(1000);
    st = await page.evaluate((id) => {
      const v = window.__front.ctx.sim.view, u = v.units.get(id);
      const inc = v.command?.incursions?.find((x) => x.unitId === id);
      return { hp: u?.hp ?? -1, x: u?.x, y: u?.y, inc: inc ? { response: inc.response, left: inc.left, leaving: inc.leaving } : null, war: v.pairState(1, inc?.victim ?? 0), speed: v.speed, feed: document.body.innerText.match(/ha salido de[^\n]*/i)?.[0] ?? '' };
    }, id);
    if (st.inc?.leaving) seen.leaving = true;
    if (!st.inc || st.inc.left) break;
    if (st.speed === 0) await page.evaluate(() => document.querySelector('.fu-autopause .fu-btn--primary')?.click());
  }
  rec('R4 ordered out after release: the victim holds fire while it leaves; out without war or damage', out && pz.speed === 0 && ord.tile >= 0 && (seen.leaving || !!st.inc?.left) && (!st.inc || st.inc.left) && st.hp >= ord.hp - 1e-6 && st.war !== 'war',
    { paused: pz.speed === 0, order: ord, seenLeaving: seen.leaving, end: st });
  rec('releaseout page errors', errs.length === 0, errs.slice(0, 5));
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
  // A few strategic ticks of holding (the orbit is flown tick by tick).
  const tick0 = await page.evaluate(() => window.__front.ctx.sim.view.tick);
  await page.waitForFunction((t0) => window.__front.ctx.sim.view.tick >= t0 + 4, tick0, { timeout: 600000, polling: 1000 }).catch(() => undefined);
  const after = await page.evaluate((id) => {
    const v = window.__front.ctx.sim.view, u = v.units.get(id);
    window.__fuHud?.shared?.select({ kind: 'unit', id });
    return { tick: v.tick, x: u?.x, y: u?.y, mode: u?.mode, alt: u?.alt, order: u?.order, etaTicks: u?.etaTicks };
  }, before.id);
  await wait(3000);
  const card = await page.evaluate(() => window.__fuCard?.text?.() ?? '');
  const km = after.x !== undefined ? Math.hypot((after.x - before.x) * 25 * Math.cos(41 * Math.PI / 180), (after.y - before.y) * 25) : -1;
  // Holding (order «hold» = 2) on a 12 km orbit around the release point, with its fuel left on the card.
  rec('R3 released fighter holds over the spot (≤ 20 km from it after 4 ticks; no return to base)', out && after.alt > 0 && after.order === 2 && km >= 0 && km <= 20, { km: +km.toFixed(1), after, exited: out });
  rec('R3b the card says it is holding and how much endurance is left', /en espera|holding/i.test(card) && /autonom|endurance/i.test(card) && after.etaTicks > 0, { card: card.split('\n').slice(0, 6).join(' | ') });
  await page.screenshot({ path: 'shots/W5-command-v2/jet-hold-card.png', timeout: 180000 }).catch(() => undefined);
  rec('jetrelease page errors', errs.length === 0, errs.slice(0, 5));
  await page.close();
}

// Criterion 14 / owner feedback #21: T on a division inside a visible ground battle keeps that battle's forces. Real UI:
// the battle view in live mode, the own division selected by clicking its marker (or, when its marker is not on screen,
// nothing selected: T takes your division in the battle), then T. The battle's soldiers come over one for one.
if (ONLY.includes('handoff')) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  await page.goto(`${BASE}?shot=front-ground-real&live=1`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 1000 });
  await wait(4000);
  await page.screenshot({ path: 'shots/W5-command-v2/h0-battle.png', timeout: 180000 }).catch(() => undefined);
  const h = await page.evaluate(() => {
    const { ctx } = window.__front;
    const ho = ctx.battle.handoff?.() ?? null;
    const bv = ctx.battle.view?.() ?? null;
    // The own division's marker, when it is drawn on screen.
    const marks = [...document.querySelectorAll('.fu-bdiv')].filter((e) => e.style.display !== 'none').map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    return { ho: ho && { ...ho, soldiers: undefined, nSoldiers: ho.soldiers?.length / 3 }, list: ho?.soldiers ?? [], divs: bv?.divisions.map((d) => ({ unitId: d.unitId, owner: d.owner, km: d.km })) ?? [], marks };
  });
  const own = h.divs.filter((d) => d.owner === 1).sort((a, b) => a.km - b.km)[0];
  if (!h.ho || !own) rec('H1 a visible ground battle with a human division to take', false, { ho: h.ho, divs: h.divs });
  else {
    // Select through the UI: the division's marker if it is on screen and names our division, else nothing selected.
    const ownLabel = await page.evaluate((id) => { const u = window.__front.ctx.sim.view.units.get(id); return u ? window.__fuCard?.home ? '' : '' : ''; }, own.unitId);
    void ownLabel;
    const mark = h.marks.find((m) => !/Suiza|Switzerland/i.test(m.text ?? '') && /Divisi|Division/i.test(m.text ?? ''));
    let how = 'T with nothing selected (your division in this battle)';
    if (mark) {
      await page.mouse.click(mark.x, mark.y);
      await wait(2500);
      const sel = await page.evaluate(() => window.__fuHud?.shared?.selection ?? null);
      how = `clicked marker «${mark.text}» ${JSON.stringify(sel)}`;
    } else {
      // Nothing selected (Escape deselects; with nothing selected it would open the pause menu instead).
      if (await page.evaluate(() => (window.__fuHud?.shared?.selection?.kind ?? 'none') !== 'none')) {
        await page.keyboard.press('Escape');
        await wait(1500);
      }
    }
    await page.keyboard.press('t');
    let entered = false;
    for (let i = 0; i < 60 && !entered; i++) {
      await wait(1000);
      entered = await page.evaluate(() => !!window.__cmdStats);
    }
    rec('H0 T from the battle view enters command mode (real UI)', entered, { how, own });
    // The first view: the battle view itself (intro), then the vehicle.
    await page.waitForFunction(() => window.__cmdStats?.phase === 'intro' || window.__cmdStats?.phase === 'play', null, { timeout: 300000, polling: 500 }).catch(() => undefined);
    await page.screenshot({ path: 'shots/W5-command-v2/h1-first-view.png', timeout: 180000 }).catch(() => undefined);
    await page.waitForFunction(() => window.__cmdStats?.phase === 'play', null, { timeout: 600000, polling: 1000 }).catch(() => undefined);
    await wait(6000);
    const c = await page.evaluate((list) => {
      const I = window.__cmd, P = I.controller.ent;
      const per = {}, active = {}, cen = {};
      for (const e of I.world.ents) {
        if (!e.alive || (e.kind !== 'soldier' && e.kind !== 'at')) continue;
        per[e.nation] = (per[e.nation] ?? 0) + 1;
        if (!e.dormant) active[e.nation] = (active[e.nation] ?? 0) + 1;
        const ll = I.frame.latLonOfScene(e.pos.x, e.pos.z, { lat: 0, lon: 0 });
        const c = (cen[e.nation] ??= { lat: 0, lon: 0, n: 0 });
        c.lat += ll.lat; c.lon += ll.lon; c.n++;
      }
      const bcen = {};
      for (let i = 0; i + 2 < list.length; i += 3) { const c = (bcen[list[i + 2]] ??= { lat: 0, lon: 0, n: 0 }); c.lat += list[i]; c.lon += list[i + 1]; c.n++; }
      const offM = {};
      for (const k of Object.keys(bcen)) {
        const a = bcen[k], b = cen[k];
        if (!b) continue;
        const la = a.lat / a.n, lo = a.lon / a.n, lb = b.lat / b.n, lob = b.lon / b.n;
        offM[k] = Math.round(Math.hypot((la - lb) * 111200, (lo - lob) * 111200 * Math.cos(la * Math.PI / 180)));
      }
      const divs = {};
      for (const e of I.world.ents) if (e.alive && e.src?.kind === 'division' && e.kind === 'tank') divs[e.src.id] = (divs[e.src.id] ?? 0) + 1;
      // Facing: the vehicle's heading against the bearing to the battle's look point.
      const ho = I.params?.battleHandoff;
      let la = 0, lo = 0, n = 0;
      for (let i = 0; i + 2 < (ho?.soldiers?.length ?? 0); i += 3) { la += ho.soldiers[i]; lo += ho.soldiers[i + 1]; n++; }
      const lk = n ? I.frame.sceneOf(la / n, lo / n, { x: 0, z: 0 }) : null;
      const face = lk ? Math.abs(((Math.atan2(-(lk.x - P.pos.x), -(lk.z - P.pos.z)) - P.yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * 180 / Math.PI : -1;
      const battleKm = lk ? Math.hypot(lk.x - P.pos.x, lk.z - P.pos.z) / 1000 : -1;
      return { per, active, offM, divs, faceDeg: Math.round(face), battleKm: +battleKm.toFixed(1), notice: window.__cmdStats.notice, stats: { soldiers: window.__cmdStats.soldiers, handoff: window.__cmdStats.handoff } };
    }, h.list);
    const rows = h.ho.infantry.map((s) => ({ owner: s.owner, battle: s.count, command: c.per[s.owner] ?? 0, active: c.active[s.owner] ?? 0, centroidOffM: c.offM[s.owner] }));
    rec('H1 infantry per side: battle view = command mode (±10 %), where they stood (centroid ≤ 150 m)', rows.every((r) => Math.abs(r.command - r.battle) <= Math.max(2, r.battle * 0.1) && (r.centroidOffM ?? 1e9) <= 150), rows);
    const drows = h.ho.divisions.map((d) => ({ unitId: d.unitId, battle: d.tanks, command: c.divs[d.unitId] ?? 0 }));
    rec('H2 the battle\'s real divisions are there with the same tanks', drows.every((d) => d.battle === d.command || d.unitId === own.unitId), drows);
    rec('H3 the vehicle faces the battle it was watching, and the HUD says where it is', c.faceDeg >= 0 && c.faceDeg <= 20 && /batalla|battle/i.test(c.notice ?? ''), { faceDeg: c.faceDeg, battleKm: c.battleKm, notice: c.notice });
    // H5 (owner #24): one distance to the battle everywhere — the battle view's marker (off screen), the entry notice, the
    // HUD's land line and the battle's world label all measure to the battle's centre, and a waypoint is set there.
    const texts = await page.evaluate(() => {
      const body = document.body.innerText;
      return { notice: window.__cmdStats.notice ?? '', info: window.__cmdStats.info ?? '', label: (window.__cmd.overlay.drawnLabels ?? []).find((l) => /soldados en la l[ií]nea|soldiers on the line/i.test(l)) ?? '', waypointKm: window.__cmdStats.waypointKm };
    });
    const kmOf = (str) => { const m = (str ?? '').match(/(\d+(?:[.,]\d+)?)\s*km(?!.*km)/); return m ? Number(m[1].replace('.', '').replace(',', '.')) : null; };
    const markText = h.marks.find((m) => /del combate|from the battle/i.test(m.text ?? '') && !/Suiza|Switzerland/i.test(m.text ?? ''))?.text ?? '';
    const kms = { marker: kmOf(markText.match(/[\d.,]+\s*km del combate|[\d.,]+\s*km from the battle/i)?.[0]), notice: kmOf(texts.notice.match(/a [\d.,]+ km|[\d.,]+ km to/i)?.[0]), hud: kmOf(texts.info.match(/combate con[^\n]*|battle with[^\n]*/i)?.[0]), label: kmOf(texts.label), measured: c.battleKm };
    const vals = [kms.notice, kms.hud, kms.label, kms.marker].filter((v) => v !== null);
    const tol = Math.max(0.6, c.battleKm * 0.05);
    rec('H5 one distance to the battle: notice = HUD = world label (= battle-view marker when shown) = measured (±max(0.6 km, 5 %)); waypoint set on it',
      kms.notice !== null && kms.hud !== null && kms.label !== null && vals.every((v) => Math.abs(v - c.battleKm) <= tol) && (c.battleKm < 1.5 || (texts.waypointKm >= 0 && Math.abs(texts.waypointKm - (c.battleKm - 0.6)) <= tol)),
      { kms, waypointKm: texts.waypointKm, markText, hud: texts.info.split('\n')[1]?.trim(), label: texts.label });
    await page.screenshot({ path: 'shots/W5-command-v2/h2-command.png', timeout: 180000 }).catch(() => undefined);
    // H4 (the crowd's level of detail): put the vehicle 600 m behind the watched line (test staging, the sim rejects the
    // jump): the soldiers within ~1 km wake up with the AI, the rest stay in the crowd; the totals do not change.
    const h4 = await page.evaluate(() => {
      const I = window.__cmd, P = I.controller.ent, ho = I.params.battleHandoff;
      let la = 0, lo = 0, n = 0;
      for (let i = 0; i + 2 < ho.soldiers.length; i += 3) { la += ho.soldiers[i]; lo += ho.soldiers[i + 1]; n++; }
      const lk = I.frame.sceneOf(la / n, lo / n, { x: 0, z: 0 });
      const dx = lk.x - P.pos.x, dz = lk.z - P.pos.z, d = Math.hypot(dx, dz);
      P.pos.x = lk.x - (dx / d) * 600;
      P.pos.z = lk.z - (dz / d) * 600;
      P.pos.y = I.ground.heightAt(P.pos.x, P.pos.z);
      return true;
    });
    void h4;
    // (read from the world itself: __cmdStats is refreshed every 10 frames, tens of seconds under SwiftShader)
    let c2 = {};
    for (let i = 0; i < 12; i++) {
      await wait(5000);
      c2 = await page.evaluate(() => window.__cmd.world.soldiersByNation());
      if (Object.values(c2).some((v) => v.active > 0)) break;
    }
    await wait(5000);
    c2 = await page.evaluate(() => window.__cmd.world.soldiersByNation());
    const rows2 = h.ho.infantry.map((s) => ({ owner: s.owner, battle: s.count, active: c2[s.owner]?.active ?? 0, crowd: c2[s.owner]?.crowd ?? 0 }));
    rec('H4 near the line the nearby soldiers wake (AI) and the far ones stay in the crowd; totals kept (±10 %)', rows2.some((r) => r.active > 0) && rows2.every((r) => r.active <= 320 && Math.abs(r.active + r.crowd - r.battle) <= Math.max(2, r.battle * 0.1)), rows2);
    await page.screenshot({ path: 'shots/W5-command-v2/h3-near-line.png', timeout: 180000 }).catch(() => undefined);
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
