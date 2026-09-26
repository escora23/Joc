// FRONT ULTRA — ground battle shots (owner: battle).
//   front        low, dramatic view across a large battle at golden hour (explosions, tracers, burning hamlet)
//   front-wide   higher view over the whole local front line: both armies, armor, artillery and smoke columns
//   front-high   ~250 km over the front: artillery flashes, fires and smoke along the line (battle layer fading in)
//   front-night  the same battle after dusk: tracers, fires and muzzle flashes light the field
//   front-auto   unstaged: the camera descends over the hottest front of a running war (the real streaming path)
// A fixed two-nation theatre is staged over Champagne (whatever the AI did before): the human holds the land behind
// the contact line, the nearest AI nation the land ahead, the advance heading is chosen relative to the sun so the
// light is always dramatic, and the battle is anchored on the contact line.
// Extra params: &elev=<deg> sun elevation, &alt=<km>, &tilt=<rad>, &hdg=<rad> camera heading offset, &adv=<rad>
// advance heading from the sun azimuth, &shift=<km> target shift, &lat= &lon= theatre centre, &warm=<s> battle time
// simulated before capture, &bsplat=1|2 ground land-cover debug view.

import { DAY_LENGTH_SEC, HUMAN_ID } from '../../shared/constants';
import { latLonToTile, latLonToVec3, sunDirection, tileXYToLatLon } from '../../shared/geo';
import { registerShot, type ShotContext } from '../../shared/shots';
import type { FrontView, GameConfig } from '../../shared/types';
import { battleDebug } from './index';

/** World time at which the sun stands at `elevDeg` over lat/lon, in the evening (sun sinking) or morning. */
function worldTimeForSunElevation(lat: number, lon: number, elevDeg: number, evening = true): number {
  const up = latLonToVec3(lat, lon, 1, { x: 0, y: 0, z: 0 });
  const s = { x: 0, y: 0, z: 0 };
  const target = Math.sin((elevDeg * Math.PI) / 180);
  let best = 0, bestErr = Infinity;
  const N = 2880;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * DAY_LENGTH_SEC;
    sunDirection(t, s);
    const e = s.x * up.x + s.y * up.y + s.z * up.z;
    sunDirection(t + 1, s);
    const e2 = s.x * up.x + s.y * up.y + s.z * up.z;
    if ((e2 < e) !== evening) continue;
    const err = Math.abs(e - target);
    if (err < bestErr) {
      bestErr = err;
      best = t;
    }
  }
  return best;
}

interface Staged {
  lat: number;
  lon: number;
  enemy: number;
}

/**
 * A fixed two-nation theatre over Champagne (whatever the AI did before): the human holds the land behind the
 * contact line, the enemy the land ahead of it along the advance heading (compass, radians), and the human
 * attacks across it.
 */
async function stageTheatre(s: ShotContext, advHeading: number): Promise<Staged> {
  const { ctx, params } = s;
  const cLat = Number(params.get('lat') ?? 48.95);
  const cLon = Number(params.get('lon') ?? 4.35);
  await ctx.app.startScriptedGame({ ticks: Number(params.get('ticks') ?? 300), speed: 1, headStart: 10, autopilot: false });
  const view = ctx.sim.view;
  const T = (la: number, lo: number) => latLonToTile(la, lo);
  // The enemy: the living AI nation whose capital is closest to the theatre (a plausible neighbour).
  let enemy = 2, bestD = Infinity;
  for (const p of view.playerList) {
    if (!p.alive || p.kind !== 'nation' || p.id === HUMAN_ID || p.capitalTile < 0) continue;
    const q = tileXYToLatLon((p.capitalTile % 1600) + 0.5, Math.floor(p.capitalTile / 1600) + 0.5);
    const d = Math.hypot(q.lat - cLat, (q.lon - cLon) * Math.cos((cLat * Math.PI) / 180));
    if (d < bestD) {
      bestD = d;
      enemy = p.id;
    }
  }
  const cosL = Math.cos((cLat * Math.PI) / 180);
  const dLat = Math.cos(advHeading), dLon = Math.sin(advHeading) / cosL;
  const deg = 0.225;
  ctx.sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: T(cLat - dLat * 18 * deg, cLon - dLon * 18 * deg), radius: 19 });
  ctx.sim.debug({ type: 'conquer', playerId: enemy, centerTile: T(cLat + dLat * 19 * deg, cLon + dLon * 19 * deg), radius: 19 });
  ctx.sim.debug({ type: 'addTroops', playerId: HUMAN_ID, amount: 900_000 });
  ctx.sim.debug({ type: 'addTroops', playerId: enemy, amount: 700_000 });
  // v2: offensives need a declared war (staged without mobilization).
  ctx.sim.debug({ type: 'war', a: HUMAN_ID, b: enemy });
  ctx.sim.setSpeed(1);
  await s.waitFrames(2);
  // Attack across the line and freeze the sim as soon as the contact line shows up as a front (the globe's hot front
  // and the far layer read it), re-issuing the attack if the first wave dies out.
  // v2: every war has quiet fronts; wait for one with an offensive on it.
  const hasFront = () => view.fronts.some((f) => ((f.a === HUMAN_ID && f.b === enemy) || (f.a === enemy && f.b === HUMAN_ID)) && !f.quiet);
  // The sim worker ticks on wall-clock time, so poll by time (software-rendered frames can take seconds each).
  // The near battlefield does not depend on it (it falls back to the nations' troops), so the wait is bounded.
  const t0 = performance.now();
  let lastAttack = -1e9;
  while (!hasFront() && performance.now() - t0 < 12_000) {
    if (performance.now() - lastAttack > 2500) {
      lastAttack = performance.now();
      ctx.sim.send({ type: 'attack', target: enemy, ratio: 0.6, tile: T(cLat + dLat * 0.3, cLon + dLon * 0.3) });
    }
    await s.wait(120);
  }
  ctx.sim.setSpeed(0);
  console.info(`[battle] theatre front ${hasFront() ? 'live' : 'missing'} (enemy ${enemy})`);
  return { lat: cLat, lon: cLon, enemy };
}

/** Compass heading (0 = north, clockwise) of the sun seen from lat/lon at a world time. */
function sunHeading(lat: number, lon: number, worldTime: number): number {
  const sun = sunDirection(worldTime, { x: 0, y: 0, z: 0 });
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  const east = { x: -Math.sin(lo), y: 0, z: -Math.cos(lo) };
  const north = { x: -Math.sin(la) * Math.cos(lo), y: Math.cos(la), z: Math.sin(la) * Math.sin(lo) };
  const e = sun.x * east.x + sun.y * east.y + sun.z * east.z;
  const n = sun.x * north.x + sun.y * north.y + sun.z * north.z;
  return Math.atan2(e, n);
}

interface BattleFraming {
  altKm: number;
  tilt: number;
  /** Sun elevation (deg) at the battle. */
  elev: number;
  evening: boolean;
  /** Advance direction relative to the sun azimuth (rad): 0 = attacking straight into the sun. */
  advFromSun: number;
  /** Camera heading relative to the advance direction (rad). */
  camFromAdv: number;
  /** Camera target offset along the advance direction (km, negative = on the attacker's side). */
  targetShiftKm: number;
}

async function stageBattle(s: ShotContext, fr: BattleFraming): Promise<void> {
  const { ctx, params } = s;
  s.setUiVisible(params.get('hud') === '1');
  const lat0 = Number(params.get('lat') ?? 48.95);
  const lon0 = Number(params.get('lon') ?? 4.35);
  const elev = Number(params.get('elev') ?? fr.elev);
  const wt = worldTimeForSunElevation(lat0, lon0, elev, fr.evening);
  const advHeading = sunHeading(lat0, lon0, wt) + Number(params.get('adv') ?? fr.advFromSun);
  const st = await stageTheatre(s, advHeading);
  const cl = Math.cos((st.lat * Math.PI) / 180);
  // Tile-space advance direction (+x east, +y south).
  const dirX = Math.sin(advHeading) / cl, dirY = -Math.cos(advHeading);
  battleDebug()?.stageAt(st.lat, st.lon, HUMAN_ID, st.enemy, dirX, dirY);
  for (let i = 0; i < 120 && !battleDebug()?.built; i++) await s.waitFrames(1);
  const alt = Number(params.get('alt') ?? fr.altKm);
  const tl = Number(params.get('tilt') ?? fr.tilt);
  const hdg = advHeading + Number(params.get('hdg') ?? fr.camFromAdv);
  const shift = Number(params.get('shift') ?? fr.targetShiftKm) / 6371 * (180 / Math.PI);
  const tLat = st.lat + Math.cos(advHeading) * shift, tLon = st.lon + (Math.sin(advHeading) * shift) / cl;
  console.info(`[battle] staged at ${st.lat.toFixed(3)}, ${st.lon.toFixed(3)} enemy ${st.enemy} advance ${advHeading.toFixed(2)}`);
  // Freeze the sim and set the lighting (sun elevation at the battle).
  ctx.sim.setSpeed(0);
  const cfg = ctx.sim.view.config as GameConfig | null;
  if (cfg) (cfg as { startWorldTimeSec: number }).startWorldTimeSec = wt - ctx.sim.view.simTime;
  ctx.cameraRig.setState({ lat: tLat, lon: tLon, altitudeKm: alt, tilt: tl, heading: hdg });
  await s.waitFrames(3);
  // Let the battle rage a while (battle time) so shells, smoke and fires are in full swing at capture.
  battleDebug()?.prewarm(Number(params.get('warm') ?? 24));
  ctx.cameraRig.setState({ lat: tLat, lon: tLon, altitudeKm: alt, tilt: tl, heading: hdg });
  await s.waitFrames(3);
}

registerShot('front', 'battle', 'Low, dramatic view across a large battle at golden hour: infantry, tanks, artillery, explosions, tracers', async (s) => {
  await stageBattle(s, { altKm: 0.5, tilt: 1.45, elev: 6, evening: true, advFromSun: 0.62, camFromAdv: -0.45, targetShiftKm: -0.05 });
}, 8);

registerShot('front-wide', 'battle', 'Higher view over the local front line: both armies, armor, artillery and smoke columns', async (s) => {
  await stageBattle(s, { altKm: 2.4, tilt: 1.25, elev: 9, evening: true, advFromSun: 1.1, camFromAdv: 2.3, targetShiftKm: 0 });
}, 8);

registerShot('front-high', 'battle', '~250 km over the front: artillery flashes, fires and smoke columns along the line (battle layer fading in)', async (s) => {
  const { ctx, params } = s;
  s.setUiVisible(params.get('hud') === '1');
  const lat0 = Number(params.get('lat') ?? 48.95), lon0 = Number(params.get('lon') ?? 4.35);
  const wt = worldTimeForSunElevation(lat0, lon0, Number(params.get('elev') ?? 12), true);
  const adv = sunHeading(lat0, lon0, wt) + 1.3;
  const st = await stageTheatre(s, adv);
  // Look at the middle of the staged war's front (the far layer lights every front in view).
  const f = ctx.sim.view.fronts.find((q) => (q.a === HUMAN_ID && q.b === st.enemy) || (q.a === st.enemy && q.b === HUMAN_ID));
  const ll = f ? tileXYToLatLon(f.x + f.dirX * 0.5, f.y + f.dirY * 0.5) : { lat: st.lat, lon: st.lon };
  const cl = Math.cos((ll.lat * Math.PI) / 180);
  const hdg = (f ? Math.atan2(f.dirX * cl, -f.dirY) : adv) + Number(params.get('hdg') ?? 0.9);
  const cfg = ctx.sim.view.config as GameConfig | null;
  if (cfg) (cfg as { startWorldTimeSec: number }).startWorldTimeSec = wt - ctx.sim.view.simTime;
  const alt = Number(params.get('alt') ?? 250), tilt = Number(params.get('tilt') ?? 0.85);
  ctx.cameraRig.setState({ lat: ll.lat, lon: ll.lon, altitudeKm: alt, tilt, heading: hdg });
  await s.waitFrames(3);
  battleDebug()?.prewarm(Number(params.get('warm') ?? 30));
  ctx.cameraRig.setState({ lat: ll.lat, lon: ll.lon, altitudeKm: alt, tilt, heading: hdg });
  await s.waitFrames(3);
  console.info(`[battle] front-high over ${ll.lat.toFixed(2)}, ${ll.lon.toFixed(2)} front=${!!f}`);
}, 8);

registerShot('front-night', 'battle', 'The same battle after dusk: tracers, fires and muzzle flashes light the field', async (s) => {
  await stageBattle(s, { altKm: 0.5, tilt: 1.45, elev: -7, evening: true, advFromSun: 0.62, camFromAdv: -0.45, targetShiftKm: -0.05 });
}, 8);

registerShot('front-auto', 'battle', 'Unstaged: the camera simply descends over the hottest front of a running war and the battlefield streams in by itself', async (s) => {
  const { ctx, params } = s;
  s.setUiVisible(params.get('hud') === '1');
  // v2 (W1c): wars follow a declaration, a tension lead and a mobilization; by tick 12,000 (50 game days) a dozen are
  // running (1,500 was still the land race).
  await ctx.app.startScriptedGame({ ticks: Number(params.get('ticks') ?? 12000), speed: 1 });
  await s.waitFrames(6);
  // The hottest, longest land front of the running war.
  let best: FrontView | null = null, bestScore = -1;
  for (const f of ctx.sim.view.fronts) {
    if (f.b === 0) continue;
    const score = (0.3 + f.intensity) * Math.sqrt(Math.max(1, f.length));
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  ctx.sim.setSpeed(0);
  const ll = best ? tileXYToLatLon(best.x + best.dirX * 0.5, best.y + best.dirY * 0.5) : { lat: 48.9, lon: 4.3 };
  const cl = Math.cos((ll.lat * Math.PI) / 180);
  const hdg = (best ? Math.atan2(best.dirX * cl, -best.dirY) : 0.4) + Number(params.get('hdg') ?? 0.6);
  const wt = worldTimeForSunElevation(ll.lat, ll.lon, Number(params.get('elev') ?? 20), false);
  const cfg = ctx.sim.view.config as GameConfig | null;
  if (cfg) (cfg as { startWorldTimeSec: number }).startWorldTimeSec = wt - ctx.sim.view.simTime;
  const alt = Number(params.get('alt') ?? 1.6), tilt = Number(params.get('tilt') ?? 1.25);
  ctx.cameraRig.setState({ lat: ll.lat, lon: ll.lon, altitudeKm: alt, tilt, heading: hdg });
  // Stream in (the battle layer finds the front by itself).
  for (let i = 0; i < 150 && !battleDebug()?.built; i++) await s.waitFrames(1);
  await s.waitFrames(4);
  battleDebug()?.prewarm(Number(params.get('warm') ?? 16));
  await s.waitFrames(4);
  console.info(`[battle] front-auto over ${ll.lat.toFixed(2)}, ${ll.lon.toFixed(2)} front ${best ? `${best.a}->${best.b}` : 'none'} built=${battleDebug()?.built}`);
}, 8);
