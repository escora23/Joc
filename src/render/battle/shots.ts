// FRONT ULTRA — ground battle shots (owner: battle).
//   front        low, dramatic view across a large battle at golden hour (explosions, tracers, burning village)
//   front-wide   higher view over the whole local front line: both armies, artillery, smoke columns
//   front-high   ~250 km over the front: the battle layer fading in (artillery flashes, fires, smoke along the line)
//   front-night  the same battle after dusk: tracers, fires and muzzle flashes light the field
// A fixed two-nation theatre is staged over Champagne (whatever the AI did before), the human attacks, and the
// battle is anchored on the resulting contact line. Lighting is set to the requested sun elevation there.
// Extra params: &elev=<deg> sun elevation, &alt=<km>, &tilt=<rad>, &hdg=<rad offset>, &lat= &lon= theatre centre,
// &warm=<s> battle time simulated before capture.

import { DAY_LENGTH_SEC, HUMAN_ID } from '../../shared/constants';
import { latLonToTile, latLonToVec3, sunDirection, tileXYToLatLon, wrapDX } from '../../shared/geo';
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
  f: FrontView | null;
}

async function stageTheatre(s: ShotContext): Promise<Staged> {
  const { ctx, params } = s;
  const cLat = Number(params.get('lat') ?? 48.95);
  const cLon = Number(params.get('lon') ?? 4.35);
  console.info('[battle] staging: starting scripted game');
  await ctx.app.startScriptedGame({ ticks: Number(params.get('ticks') ?? 300), speed: 1, headStart: 10 });
  console.info('[battle] staging: game started');
  const view = ctx.sim.view;
  const T = (la: number, lo: number) => latLonToTile(la, lo);
  const enemy = view.playerList.find((p) => p.alive && p.kind === 'nation' && p.id !== HUMAN_ID)?.id ?? 2;
  // Human holds the south-west, the enemy the north-east; the enemy disc (conquered last) has its edge exactly on
  // the theatre centre, so the contact line runs NW-SE through it.
  const k = 0.225 / Math.SQRT2; // degrees per tile along the diagonal
  const cosL = Math.cos((cLat * Math.PI) / 180);
  ctx.sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: T(cLat - 16 * k, cLon - (16 * k) / cosL * cosL), radius: 20 });
  ctx.sim.debug({ type: 'conquer', playerId: enemy, centerTile: T(cLat + 20 * k, cLon + 20 * k), radius: 20 });
  ctx.sim.debug({ type: 'addTroops', playerId: HUMAN_ID, amount: 900_000 });
  ctx.sim.debug({ type: 'addTroops', playerId: enemy, amount: 700_000 });
  ctx.sim.setSpeed(1);
  const off = ctx.bus.on('message', (e) => console.info(`[battle] sim message ${e.key} for ${e.playerId}`));
  await s.waitFrames(4);
  let f: FrontView | null = null;
  console.info('[battle] staging: waiting for the front');
  // The contact line between the two staged nations closest to the theatre centre.
  const cx = ((cLon + 180) / 360) * 1600, cy = ((90 - cLat) / 180) * 800;
  let bd = Infinity, bx = 0, by = 0;
  for (let i = 0; i < 24 && bd > 2.5; i++) {
    // (Re)issue the attack until the sim has registered the new border and the front record appears.
    if (i % 6 === 0) ctx.sim.send({ type: 'attack', target: enemy, ratio: 0.5, tile: T(cLat + 0.3, cLon + 0.3) });
    await s.waitFrames(2);
    for (const q of view.fronts) {
      if (!((q.a === HUMAN_ID && q.b === enemy) || (q.a === enemy && q.b === HUMAN_ID))) continue;
      for (let k = 0; k < q.samples.length; k += 2) {
        const dx = wrapDX(cx, q.samples[k]), dy = q.samples[k + 1] - cy;
        const d = Math.hypot(dx, dy);
        if (d < bd) {
          bd = d;
          bx = q.samples[k];
          by = q.samples[k + 1];
          f = q;
        }
      }
    }
  }
  off();
  console.info(`[battle] fronts: ${view.fronts.map((q) => `${q.a}->${q.b}@${q.x.toFixed(0)},${q.y.toFixed(0)}`).join(' ')} enemy=${enemy} best=${bd.toFixed(1)}`);
  // The battle is always staged on the theatre centre (deterministic framing); the sim's contact line, when it
  // runs close by, gives the orientation.
  if (f && bd > 3) f = null;
  const lat = cLat, lon = cLon;
  return { lat, lon, f };
}

/** Compass heading (0 = north, clockwise) of the sun seen from lat/lon at a world time. */
function sunHeading(lat: number, lon: number, worldTime: number): number {
  const up = latLonToVec3(lat, lon, 1, { x: 0, y: 0, z: 0 });
  const sun = sunDirection(worldTime, { x: 0, y: 0, z: 0 });
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  const east = { x: -Math.sin(lo), y: 0, z: -Math.cos(lo) };
  const north = { x: -Math.sin(la) * Math.cos(lo), y: Math.cos(la), z: Math.sin(la) * Math.sin(lo) };
  void up;
  const e = sun.x * east.x + sun.y * east.y + sun.z * east.z;
  const n = sun.x * north.x + sun.y * north.y + sun.z * north.z;
  return Math.atan2(e, n);
}

/**
 * headingOffset: camera heading relative to the advance direction, or (sunRelative) relative to the sun's azimuth
 * (0 = looking straight into the low sun: backlit smoke, long shadows toward the camera).
 */
async function stageBattle(s: ShotContext, altKm: number, tilt: number, headingOffset: number, sunElev: number, evening = true, sunRelative = false): Promise<void> {
  const { ctx, params } = s;
  s.setUiVisible(params.get('hud') === '1');
  const st = await stageTheatre(s);
  const dirX = st.f ? st.f.dirX : 0.7, dirY = st.f ? st.f.dirY : -0.7;
  const a = st.f ? st.f.a : HUMAN_ID, b = st.f ? st.f.b : 2;
  battleDebug()?.stageAt(st.lat, st.lon, a, b, dirX, dirY);
  // Wait for the battlefield to stream in.
  for (let i = 0; i < 120 && !battleDebug()?.built; i++) await s.waitFrames(1);
  console.info(`[battle] staged at ${st.lat.toFixed(3)}, ${st.lon.toFixed(3)} front ${a}->${b} dir ${dirX.toFixed(2)},${dirY.toFixed(2)} found=${!!st.f}`);
  // Advance direction as a compass heading (0 = north, clockwise): tile +x = east, +y = south.
  const cl = Math.cos((st.lat * Math.PI) / 180);
  const advHeading = Math.atan2(dirX * cl, -dirY);
  const alt = Number(params.get('alt') ?? altKm);
  const tl = Number(params.get('tilt') ?? tilt);
  const elev = Number(params.get('elev') ?? sunElev);
  const wt = worldTimeForSunElevation(st.lat, st.lon, elev, evening);
  const hdg = (sunRelative ? sunHeading(st.lat, st.lon, wt) : advHeading) + Number(params.get('hdg') ?? headingOffset);
  ctx.cameraRig.setState({ lat: st.lat, lon: st.lon, altitudeKm: alt, tilt: tl, heading: hdg });
  await s.waitFrames(6);
  // Freeze the sim and set the lighting (sun elevation at the battle).
  ctx.sim.setSpeed(0);
  await s.waitFrames(3);
  const cfg = ctx.sim.view.config as GameConfig | null;
  if (cfg) (cfg as { startWorldTimeSec: number }).startWorldTimeSec = wt - ctx.sim.view.simTime;
  ctx.cameraRig.setState({ lat: st.lat, lon: st.lon, altitudeKm: alt, tilt: tl, heading: hdg });
  await s.waitFrames(4);
  // Let the battle rage a while (battle time) so shells, smoke and fires are in full swing at capture.
  battleDebug()?.prewarm(Number(params.get('warm') ?? 24));
  await s.waitFrames(4);
  console.info(`[battle] shadow coverage ${battleDebug()?.shadowCoverage().toFixed(3)}`);
}

registerShot('front', 'battle', 'Low, dramatic view across a large battle at golden hour: infantry, tanks, artillery, explosions, tracers', async (s) => {
  await stageBattle(s, 0.42, 1.45, 0.45, 6, true, true);
}, 12);

registerShot('front-wide', 'battle', 'Higher view over the local front line: both armies, armor, artillery and smoke columns', async (s) => {
  await stageBattle(s, 2.2, 1.27, 0.8, 8, true, true);
}, 12);

registerShot('front-high', 'battle', '~250 km over the hottest front: artillery flashes, fires and smoke columns along the line (battle layer fading in)', async (s) => {
  const { ctx, params } = s;
  s.setUiVisible(params.get('hud') === '1');
  await ctx.app.startScriptedGame({ ticks: Number(params.get('ticks') ?? 1200), speed: 1 });
  await s.waitFrames(10);
  // The hottest, longest land front of the running war.
  let best: FrontView | null = null, bestScore = -1;
  for (const f of ctx.sim.view.fronts) {
    const score = (0.3 + f.intensity) * Math.sqrt(Math.max(1, f.length));
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  const ll = best ? tileXYToLatLon(best.x + best.dirX * 0.5, best.y + best.dirY * 0.5) : { lat: 48.9, lon: 4.3 };
  const cl = Math.cos((ll.lat * Math.PI) / 180);
  const hdg = best ? Math.atan2(best.dirX * cl, -best.dirY) + 0.5 : 0.4;
  const alt = Number(params.get('alt') ?? 250);
  ctx.cameraRig.setState({ lat: ll.lat, lon: ll.lon, altitudeKm: alt, tilt: Number(params.get('tilt') ?? 0.8), heading: hdg });
  await s.waitFrames(8);
  ctx.sim.setSpeed(0);
  await s.waitFrames(3);
  const wt = worldTimeForSunElevation(ll.lat, ll.lon, Number(params.get('elev') ?? 14), true);
  const cfg = ctx.sim.view.config as GameConfig | null;
  if (cfg) (cfg as { startWorldTimeSec: number }).startWorldTimeSec = wt - ctx.sim.view.simTime;
  console.info(`[battle] front-high over ${ll.lat.toFixed(2)}, ${ll.lon.toFixed(2)} fronts=${ctx.sim.view.fronts.length}`);
  // The far layer accumulates activity over (battle) time: let it run a little with the sim frozen.
  battleDebug()?.prewarm(Number(params.get('warm') ?? 30));
  await s.waitFrames(6);
}, 12);

registerShot('front-night', 'battle', 'The same battle after dusk: tracers, fires and muzzle flashes light the field', async (s) => {
  await stageBattle(s, 0.5, 1.42, 0.95, -7);
}, 12);
