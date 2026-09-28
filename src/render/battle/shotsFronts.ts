// FRONT ULTRA — W6 front-clarity shots (owner: battle). DESIGN_V2 §11, §16.7.
//   front-orbit        2,500 km over an active offensive: bands, chevrons, the operational arrow and the badge
//   front-600          600 km over the same war: far layer (flashes and capped smoke inside the band), badges
//   front-mobilization a declared war during its mobilization: pulsing arrows on the aggressor's side, quiet dashes
//   fronts-panel       the Guerra y frentes panel (G) open on a war with an offensive and a quiet front
//   front-ground-real  the ground battle composed from the real front (deriveLocalForces): infantry per side, the
//                      real divisions at their positions, banners and the HUD strip
//   front-observation  the ground battle under observation time (1 s = 1 min): the line moves with the sim
// Every shot stages a REAL war in the running sim (debug conquer / war / command, then real ticks): nothing on screen
// is drawn from staging data, the renderers read ctx.sim.view like in a game.
// Params: &enemyTroops= &humanTroops= &run=<ticks> &alt= &tilt= &hdg= &attacker=enemy|human &div=<n divisions>

import { HUMAN_ID, MAP_W } from '../../shared/constants';
import { latLonToTile, tileXYToLatLon } from '../../shared/geo';
import { registerShot, type ShotContext } from '../../shared/shots';
import { AUTO_PAUSE_KINDS, UnitType, type FrontView } from '../../shared/types';

export interface StagedWar {
  enemy: number;
  attacker: number;
  defender: number;
  front: FrontView | null;
}

/** The living AI nation whose capital is nearest to lat/lon. */
function nearestNation(s: ShotContext, lat: number, lon: number): number {
  const view = s.ctx.sim.view;
  let best = 2, bd = Infinity;
  for (const p of view.playerList) {
    if (!p.alive || p.kind !== 'nation' || p.id === HUMAN_ID || p.capitalTile < 0) continue;
    const q = tileXYToLatLon((p.capitalTile % MAP_W) + 0.5, Math.floor(p.capitalTile / MAP_W) + 0.5);
    const d = Math.hypot(q.lat - lat, (q.lon - lon) * Math.cos((lat * Math.PI) / 180));
    if (d < bd) {
      bd = d;
      best = p.id;
    }
  }
  return best;
}

export function pairFront(s: ShotContext, a: number, b: number, active = true): FrontView | null {
  let best: FrontView | null = null;
  for (const f of s.ctx.sim.view.fronts) {
    if (!((f.a === a && f.b === b) || (f.a === b && f.b === a))) continue;
    if (active && f.quiet) continue;
    if (!best || f.length > best.length) best = f;
  }
  return best;
}

/**
 * A real war between the human (northern Spain) and the nearest nation (south-western France), with a long land
 * border across the Pyrenees and Aquitaine. attacker 'enemy': the nation's offensive drives south into the human's
 * land; 'human': the human attacks north; 'none': declared, both sides quiet. mobilize > 0: the war is declared with
 * that mobilization and the offensive is queued for its end (the shot freezes during the mobilization).
 */
export async function stageFrontWar(s: ShotContext, opts: { attacker?: 'enemy' | 'human' | 'none'; mobilize?: number; run?: number; minKmh?: number } = {}): Promise<StagedWar> {
  const { ctx, params } = s;
  await ctx.app.startScriptedGame({ ticks: Number(params.get('ticks') ?? 300), speed: 0, headStart: 10, autopilot: false });
  const view = ctx.sim.view;
  // The staged declaration must not stop the clock (auto-pause is the player's safety net, not the shot's).
  const ap = { ...ctx.settings.get().autoPause };
  for (const k of AUTO_PAUSE_KINDS) ap[k] = false;
  ctx.settings.set({ autoPause: ap });
  const enemy = nearestNation(s, 45.8, 1.5);
  const who = (params.get('attacker') as 'enemy' | 'human' | 'none' | null) ?? opts.attacker ?? 'enemy';
  ctx.sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: latLonToTile(41.6, -2.6), radius: 17 });
  ctx.sim.debug({ type: 'conquer', playerId: enemy, centerTile: latLonToTile(45.9, 1.2), radius: 17 });
  ctx.sim.debug({ type: 'addTroops', playerId: HUMAN_ID, amount: Number(params.get('humanTroops') ?? (who === 'human' ? 1_400_000 : 500_000)) });
  ctx.sim.debug({ type: 'addTroops', playerId: enemy, amount: Number(params.get('enemyTroops') ?? (who === 'enemy' ? 1_400_000 : 500_000)) });
  const attacker = who === 'human' ? HUMAN_ID : enemy;
  const defender = who === 'human' ? enemy : HUMAN_ID;
  const mob = opts.mobilize ?? 0;
  // Armored divisions of both sides near the border: they attach to the front and show in every view.
  const nDiv = Number(params.get('div') ?? 2);
  for (let k = 0; k < nDiv; k++) {
    ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: enemy, tile: latLonToTile(45.0, -0.4 + k * 1.2), targetTile: -1 });
    ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: HUMAN_ID, tile: latLonToTile(41.9, -1.6 + k * 1.2), targetTile: -1 });
  }
  const aim = attacker === enemy ? latLonToTile(40.9, -2.2) : latLonToTile(46.2, 1.0);
  if (who === 'none') {
    ctx.sim.debug({ type: 'war', a: enemy, b: HUMAN_ID, mobilizeTicks: mob });
  } else if (mob > 0) {
    // The aggressor declares with its offensive queued for the end of the mobilization (the real §4.2 flow).
    ctx.sim.debug({ type: 'command', playerId: attacker, cmd: { type: 'declareWar', target: defender, queuedAttack: { tile: aim, ratio: 0.6 } } });
  } else {
    ctx.sim.debug({ type: 'war', a: attacker, b: defender, mobilizeTicks: 0 });
  }
  ctx.sim.setSpeed(4);
  await s.waitFrames(2);
  if (who !== 'none' && mob <= 0) ctx.sim.debug({ type: 'command', playerId: attacker, cmd: { type: 'attack', target: defender, ratio: 0.6, tile: aim } });
  // Run real ticks until the front has an offensive with a measured advance (or the requested ticks passed).
  const t0 = performance.now();
  const tick0 = view.tick;
  const runTicks = Number(params.get('run') ?? opts.run ?? (mob > 0 ? 20 : 160));
  const minKmh = opts.minKmh ?? (who === 'none' || mob > 0 ? 0 : 1);
  while (performance.now() - t0 < 90_000) {
    const f = pairFront(s, attacker, defender, who !== 'none' && mob <= 0);
    const ran = view.tick - tick0;
    if (f && ran >= runTicks && f.advanceKmh >= minKmh) break;
    if (mob > 0 && view.wars.some((w) => w.aggressor === attacker && view.tick >= w.mobilizeUntilTick - 25) && f) break;
    await s.wait(150);
  }
  ctx.sim.setSpeed(0);
  await s.wait(400);
  const front = pairFront(s, attacker, defender, who !== 'none' && mob <= 0) ?? pairFront(s, attacker, defender, false);
  console.info(`[w6] staged war ${attacker}->${defender} ticks=${view.tick - tick0} front=${front ? `${front.key} q=${front.quiet} kmh=${front.advanceKmh.toFixed(2)} mom=${front.momentum.toFixed(2)}` : 'none'}`);
  return { enemy, attacker, defender, front };
}

/** Camera over the middle of a front, looking at it from `alt` km. */
export function frameFront(s: ShotContext, f: FrontView | null, alt: number, tilt = 0, hdgOff = 0): { lat: number; lon: number } {
  const { ctx, params } = s;
  const n = f ? f.samples.length >> 1 : 0;
  const mid = n > 0 ? Math.floor(n / 2) : 0;
  const ll = f && n ? tileXYToLatLon(f.samples[mid * 2] + f.dirX * 0.5, f.samples[mid * 2 + 1] + f.dirY * 0.5) : { lat: 43.5, lon: -0.5 };
  const cl = Math.cos((ll.lat * Math.PI) / 180);
  const hdg = f && tilt > 0 ? Math.atan2(f.dirX * cl, -f.dirY) + hdgOff : 0;
  ctx.cameraRig.setState({
    lat: ll.lat, lon: ll.lon, altitudeKm: Number(params.get('alt') ?? alt), tilt: Number(params.get('tilt') ?? tilt),
    heading: Number(params.get('hdg') ?? hdg),
  });
  return ll;
}

registerShot('front-orbit', 'battle', 'W6: 2,500 km over an active offensive: two-colour front band with chevrons, the corridor-wide operational arrow and the front badge (ISO3, tug-of-war bar, measured km/h)', async (s) => {
  const st = await stageFrontWar(s, { attacker: 'enemy' });
  frameFront(s, st.front, 2500);
  await s.waitFrames(30);
}, 10);

registerShot('front-600', 'battle', 'W6: 600 km over the same war: flashes and fires inside the band only, capped smoke, badges', async (s) => {
  const st = await stageFrontWar(s, { attacker: 'enemy' });
  frameFront(s, st.front, 600, 0.35, 0.8);
  await s.waitFrames(40);
}, 10);

registerShot('front-mobilization', 'battle', 'W6: a declared war during its mobilization: pulsing arrows on the aggressor side of the border, the quiet front dashed', async (s) => {
  const st = await stageFrontWar(s, { attacker: 'enemy', mobilize: 80 });
  frameFront(s, st.front, 2200);
  await s.waitFrames(30);
}, 10);

registerShot('fronts-panel', 'battle', 'W6: the Guerra y frentes panel (G) on a war under an enemy offensive: garrisons of both sides, redeployment, measured km/h, priority, divisions', async (s) => {
  const st = await stageFrontWar(s, { attacker: 'enemy' });
  frameFront(s, st.front, 2500);
  if (st.front) s.ctx.bus.emit('frontSelected', { key: st.front.key, fly: false });
  await s.waitFrames(30);
}, 10);
