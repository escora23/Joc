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
import { battleDebug } from './index';
import { deriveLocalForces } from '../../shared/localForces';
import { fxInternal } from '../fx/index';
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
export async function stageFrontWar(s: ShotContext, opts: { attacker?: 'enemy' | 'human' | 'none'; mobilize?: number; run?: number; minKmh?: number; theatre?: 'iberia' | 'plains'; div?: number; attachAtAxis?: boolean } = {}): Promise<StagedWar> {
  const { ctx, params } = s;
  await ctx.app.startScriptedGame({ ticks: Number(params.get('ticks') ?? 300), speed: 0, headStart: 10, autopilot: false });
  const view = ctx.sim.view;
  // The staged declaration must not stop the clock (auto-pause is the player's safety net, not the shot's).
  const ap = { ...ctx.settings.get().autoPause };
  for (const k of AUTO_PAUSE_KINDS) ap[k] = false;
  ctx.settings.set({ autoPause: ap });
  // Theatres: 'iberia' (default: northern Spain against south-western France, across the Pyrenees and the Ebro) or
  // 'plains' (the Ukrainian steppe: flat ground, the speed of the front is the plains speed of §4.5).
  const plains = (params.get('theatre') ?? opts.theatre) === 'plains';
  const TH = plains
    ? { near: [52.5, 36.0], human: [48.9, 33.0], enemy: [52.4, 35.8], hDiv: [49.7, 32.4], eDiv: [51.6, 34.6], aimH: [47.8, 32.2], aimE: [53.0, 36.3] }
    : { near: [45.8, 1.5], human: [41.6, -2.6], enemy: [45.9, 1.2], hDiv: [41.9, -1.6], eDiv: [45.0, -0.4], aimH: [40.9, -2.2], aimE: [46.2, 1.0] };
  const enemy = nearestNation(s, TH.near[0], TH.near[1]);
  const who = (params.get('attacker') as 'enemy' | 'human' | 'none' | null) ?? opts.attacker ?? 'enemy';
  ctx.sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: latLonToTile(TH.human[0], TH.human[1]), radius: 17 });
  ctx.sim.debug({ type: 'conquer', playerId: enemy, centerTile: latLonToTile(TH.enemy[0], TH.enemy[1]), radius: 17 });
  ctx.sim.debug({ type: 'addTroops', playerId: HUMAN_ID, amount: Number(params.get('humanTroops') ?? (who === 'human' ? 1_400_000 : 500_000)) });
  ctx.sim.debug({ type: 'addTroops', playerId: enemy, amount: Number(params.get('enemyTroops') ?? (who === 'enemy' ? 1_400_000 : 500_000)) });
  const attacker = who === 'human' ? HUMAN_ID : enemy;
  const defender = who === 'human' ? enemy : HUMAN_ID;
  const mob = opts.mobilize ?? 0;
  // Armored divisions of both sides near the border: they attach to the front and show in every view.
  const nDiv = Number(params.get('div') ?? opts.div ?? 2);
  for (let k = 0; k < nDiv; k++) {
    ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: enemy, tile: latLonToTile(TH.eDiv[0], TH.eDiv[1] + k * 1.2), targetTile: -1 });
    ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: HUMAN_ID, tile: latLonToTile(TH.hDiv[0], TH.hDiv[1] + k * 1.2), targetTile: -1 });
  }
  const aim = attacker === enemy ? latLonToTile(TH.aimH[0], TH.aimH[1]) : latLonToTile(TH.aimE[0], TH.aimE[1]);
  if (who === 'none') {
    ctx.sim.debug({ type: 'war', a: enemy, b: HUMAN_ID, mobilizeTicks: mob });
  } else if (mob > 0) {
    // Declared with a mobilization window: the aggressor may not attack before mobilizeUntilTick (§4.2).
    ctx.sim.debug({ type: 'war', a: attacker, b: defender, mobilizeTicks: mob });
  } else {
    ctx.sim.debug({ type: 'war', a: attacker, b: defender, mobilizeTicks: 0 });
  }
  // Staged in exact ticks (fastForward), never on wall-clock time: the same seed stages the same front every run.
  if (who !== 'none' && mob <= 0) ctx.sim.debug({ type: 'command', playerId: attacker, cmd: { type: 'attack', target: defender, ratio: 0.6, tile: aim } });
  // Both sides attach their divisions to the front as soon as it exists (a real order: they drive there).
  let attached = false;
  const attach = (): void => {
    const f = pairFront(s, attacker, defender, false);
    if (!f || attached) return;
    attached = true;
    const n = f.samples.length >> 1;
    // Spread along the front, or (ground shots) where the offensive's axis crosses it, where the battle is watched.
    const m = axisVertex(s, f);
    for (const side of [enemy, HUMAN_ID]) {
      const other = side === enemy ? HUMAN_ID : enemy;
      const into = other === f.b ? 1 : -1;
      const ids = [...view.units.values()].filter((u) => u.owner === side && u.type === UnitType.ArmoredDivision).map((u) => u.id);
      ids.forEach((id, k) => {
        const v = opts.attachAtAxis ? Math.max(0, Math.min(n - 1, m + (k % 2 ? 1 : -1) * Math.ceil(k / 2)))
          : Math.min(n - 1, Math.floor(((k + 1) / (ids.length + 1)) * n));
        const x = f.samples[v * 2] + f.dirX * (0.5 + into * 1.2), y = f.samples[v * 2 + 1] + f.dirY * (0.5 + into * 1.2);
        const tile = Math.floor(y) * MAP_W + ((Math.floor(x) % MAP_W) + MAP_W) % MAP_W;
        ctx.sim.debug({ type: 'command', playerId: side, cmd: { type: 'unitOrder', unitIds: [id], order: 'attach', tile, targetId: 0 } });
      });
    }
  };
  // Run real ticks (10 at a time) until the front has an offensive with a measured advance (or the requested ticks ran).
  const tick0 = view.tick;
  const runTicks = Number(params.get('run') ?? opts.run ?? (mob > 0 ? 20 : 160));
  const minKmh = opts.minKmh ?? (who === 'none' || mob > 0 ? 0 : 1);
  for (let guard = 0; guard < 150; guard++) {
    attach();
    const f = pairFront(s, attacker, defender, who !== 'none' && mob <= 0);
    const ran = view.tick - tick0;
    if (f && ran >= runTicks && f.advanceKmh >= minKmh) break;
    if (mob > 0 && view.wars.some((w) => w.aggressor === attacker && view.tick >= w.mobilizeUntilTick - 25) && f) break;
    await ctx.sim.fastForward(10);
  }
  ctx.sim.setSpeed(0);
  await s.waitFrames(2);
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
  const st = await stageFrontWar(s, { attacker: 'enemy', mobilize: Number(s.params.get('mob') ?? 400) });
  frameFront(s, st.front, 2200);
  await s.waitFrames(30);
}, 10);

registerShot('fronts-panel', 'battle', 'W6: the Guerra y frentes panel (G) on a war under an enemy offensive: garrisons of both sides, redeployment, measured km/h, priority, divisions', async (s) => {
  const st = await stageFrontWar(s, { attacker: 'enemy' });
  frameFront(s, st.front, 2500);
  if (st.front) s.ctx.bus.emit('frontSelected', { key: st.front.key, fly: false });
  await s.waitFrames(30);
}, 10);

/**
 * The front vertex where the offensive's axis crosses the line (the corridor's core advances at the full §4.5 speed;
 * its flanks at 0.8 of it), else the middle of the front.
 */
function axisVertex(s: ShotContext, f: FrontView): number {
  const n = f.samples.length >> 1;
  let m = Math.floor(n / 2);
  const a = s.ctx.sim.view.attacks.find((q) => q.frontKey === f.key && q.defender > 0);
  if (a && a.originX >= 0) {
    const cl = Math.cos((tileXYToLatLon(a.x, a.y).lat * Math.PI) / 180);
    let ux = (a.x - a.originX) * cl, uy = a.y - a.originY;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;
    let best = Infinity;
    for (let v = 0; v < n; v++) {
      const rx = (f.samples[v * 2] - a.originX) * cl, ry = f.samples[v * 2 + 1] - a.originY;
      const perp = Math.abs(rx * uy - ry * ux);
      if (perp < best) {
        best = perp;
        m = v;
      }
    }
  }
  return m;
}

/** Camera down on the front's contact line (the ground battle streams in by itself: nothing is staged in the layer). */
async function descend(s: ShotContext, st: StagedWar, alt: number, tilt: number): Promise<void> {
  const f = st.front;
  if (!f) return;
  const m = axisVertex(s, f);
  const x = f.samples[m * 2] + f.dirX * 0.5, y = f.samples[m * 2 + 1] + f.dirY * 0.5;
  // Over the real (sub-tile) contact line, where the ground battle stands.
  const lf = deriveLocalForces(s.ctx.sim.view, x, y, 40, HUMAN_ID);
  const lfF = lf.fronts.find((q) => q.key === f.key);
  const ll = lfF ? { lat: lfF.nearest.lat, lon: lfF.nearest.lon } : tileXYToLatLon(x, y);
  const cl = Math.cos((ll.lat * Math.PI) / 180);
  const hdg = Math.atan2(f.dirX * cl, -f.dirY) + Number(s.params.get('hdg') ?? 1.1);
  s.ctx.cameraRig.setState({ lat: ll.lat, lon: ll.lon, altitudeKm: Number(s.params.get('alt') ?? alt), tilt: Number(s.params.get('tilt') ?? tilt), heading: hdg });
  const t0 = performance.now();
  for (let i = 0; i < 240 && !battleDebug()?.built; i++) {
    await s.waitFrames(1);
    if (i % 20 === 0) {
      const c = s.ctx.cameraRig.getState();
      console.info(`[w6] descend frame ${i} t=${Math.round(performance.now() - t0)}ms alt=${c.altitudeKm.toFixed(1)} anchor=${JSON.stringify(battleDebug()?.anchor)} built=${battleDebug()?.built}`);
    }
  }
  await s.waitFrames(8);
}

/**
 * A camera that frames every point (local km east / north of the target on the contact line) inside the part of the
 * screen no HUD panel covers, from as close as possible: headings every 15°, a few tilts, the distance growing by 8 %
 * steps (flat ground; at these distances the Earth's curvature is a few tens of metres).
 */
function framePoints(points: { e: number; n: number }[], tilts: number[], aspect: number, maxD = 30): { d: number; tilt: number; heading: number } | null {
  const half = Math.tan((45 / 2) * (Math.PI / 180));
  // Screen box clear of the HUD at 1600x900 (alerts left, leaderboard right, top bar, news ticker and strip on top,
  // build bar below), with room above each point for its banner.
  const X0 = -0.52, X1 = 0.52, Y0 = -0.58, Y1 = 0.42;
  let best = { d: maxD, tilt: tilts[0], heading: 0 };
  let found = false;
  for (let hk = 0; hk < 24; hk++) {
    const h = (hk / 24) * Math.PI * 2;
    const fe = Math.sin(h), fn = Math.cos(h);
    for (const t of tilts) {
      for (let d = 1.5; d < best.d; d *= 1.08) {
        // Camera at target + d·(cos t · up − sin t · fwd), looking at the target; camera up = fwd·cos t + up·sin t.
        const ce = -Math.sin(t) * d * fe, cn = -Math.sin(t) * d * fn, cu = Math.cos(t) * d;
        let ok = true;
        for (const p of points) {
          const ve = p.e - ce, vn = p.n - cn, vu = -cu;
          // Camera axes: z = (C − T)/d, x = right = (fn, −fe, 0)·… (heading rotated 90° clockwise), y = z × x.
          const zc = -(ve * (-Math.sin(t) * fe) + vn * (-Math.sin(t) * fn) + vu * Math.cos(t));
          const xc = ve * fn - vn * fe;
          const yc = ve * fe * Math.cos(t) + vn * fn * Math.cos(t) + vu * Math.sin(t);
          if (zc <= 0.1) {
            ok = false;
            break;
          }
          const nx = xc / zc / (half * aspect), ny = yc / zc / half;
          if (nx < X0 || nx > X1 || ny < Y0 || ny > Y1) {
            ok = false;
            break;
          }
        }
        if (ok) {
          best = { d, tilt: t, heading: h };
          found = true;
          break;
        }
      }
    }
  }
  return found ? best : null;
}

/**
 * One real division per side where the offensive's axis crosses the front: spawned on its own tile touching the enemy
 * and attached there (a real order), so the ground battle has armour on both sides, as a front under attack would.
 */
async function divisionsAtAxis(s: ShotContext, st: StagedWar): Promise<void> {
  const f = st.front;
  if (!f) return;
  const { ctx } = s;
  const view = ctx.sim.view;
  const m = axisVertex(s, f);
  const px = f.samples[m * 2] + f.dirX * 0.5, py = f.samples[m * 2 + 1] + f.dirY * 0.5;
  const tileOf = (x: number, y: number) => Math.floor(y) * MAP_W + (((Math.floor(x) % MAP_W) + MAP_W) % MAP_W);
  const before = new Set(view.units.keys());
  const orders: { side: number; enemyTile: number }[] = [];
  for (const side of [f.a, f.b]) {
    const other = side === f.a ? f.b : f.a;
    let best = -1, enemyTile = -1, bd = Infinity;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const tx = Math.floor(px) + dx, ty = Math.floor(py) + dy;
        const t = tileOf(tx, ty);
        if (view.owner[t] !== side) continue;
        const nb = [tileOf(tx - 1, ty), tileOf(tx + 1, ty), tileOf(tx, ty - 1), tileOf(tx, ty + 1)].find((q) => view.owner[q] === other);
        if (nb === undefined) continue;
        const d = (tx + 0.5 - px) ** 2 + (ty + 0.5 - py) ** 2;
        if (d < bd) {
          bd = d;
          best = t;
          enemyTile = nb;
        }
      }
    }
    if (best < 0) continue;
    ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: side, tile: best, targetTile: -1 });
    orders.push({ side, enemyTile });
  }
  await ctx.sim.fastForward(1);
  for (const o of orders) {
    const ids = [...view.units.values()].filter((u) => !before.has(u.id) && u.owner === o.side && u.type === UnitType.ArmoredDivision).map((u) => u.id);
    if (ids.length) ctx.sim.debug({ type: 'command', playerId: o.side, cmd: { type: 'unitOrder', unitIds: ids, order: 'attach', tile: o.enemyTile, targetId: 0 } });
  }
  await ctx.sim.fastForward(5);
  ctx.sim.setSpeed(0);
  await s.waitFrames(2);
}

/**
 * The ground battle framed from the sim alone, before it is built: close on the contact line where the offensive's
 * axis crosses it (the soldiers must read), with the nearest real division in view too when it fits within 4.5 km of
 * camera distance, all inside the screen area clear of the HUD; divisions out of view wait at the screen's edge with
 * their bearing and distance (HUD). The camera target stays on the line (the battle anchors on the line nearest to it).
 */
async function frameGround(s: ShotContext, st: StagedWar): Promise<void> {
  const f = st.front;
  if (!f) return;
  const view = s.ctx.sim.view;
  const m = axisVertex(s, f);
  const x = f.samples[m * 2] + f.dirX * 0.5, y = f.samples[m * 2 + 1] + f.dirY * 0.5;
  const lf0 = deriveLocalForces(view, x, y, 40, HUMAN_ID);
  const fr0 = lf0.fronts.find((q) => q.key === f.key);
  if (!fr0) {
    await descend(s, st, 3, 1.2);
    return;
  }
  const L0 = fr0.nearest;
  const te = Math.sin(fr0.lineBearing), tn = Math.cos(fr0.lineBearing);
  const lf = deriveLocalForces(view, L0.x, L0.y, 40, HUMAN_ID);
  const divs = lf.units.filter((u) => u.type === UnitType.ArmoredDivision && (u.owner === f.a || u.owner === f.b))
    .sort((p, q) => p.distKm - q.distKm);
  // Target: on the line, abreast of the nearest division (within ±4 km along the line).
  const along = divs.length ? Math.max(-4, Math.min(4, divs[0].eastKm * te + divs[0].northKm * tn)) : 0;
  const tLatLon = tileXYToLatLon(L0.x + (along * te) / (25.02 * Math.cos((L0.lat * Math.PI) / 180)), L0.y - (along * tn) / 25.02);
  const line = [{ e: -2 * te, n: -2 * tn }, { e: 2 * te, n: 2 * tn }];
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);
  const near = divs[0] ? [{ e: divs[0].eastKm - along * te, n: divs[0].northKm - along * tn }] : [];
  // The soldiers read up to ~3 km of camera distance: the nearest division joins the frame only if it fits by then;
  // else a close diagonal view along the line (the divisions' markers wait at the screen's edge).
  const withDiv = near.length ? framePoints([...line, ...near], [1.25, 1.2, 1.15], aspect, 3.1) : null;
  const fr = withDiv ?? { d: 2.2, tilt: 1.22, heading: Math.atan2(te, tn) + 1.1 };
  console.info(`[w6] frame ground: ${divs.length} divisions (nearest ${divs[0] ? divs[0].distKm.toFixed(1) : '-'} km, ${withDiv ? 'in view' : 'marked at the edge'}) -> d ${fr.d.toFixed(1)} km tilt ${fr.tilt} hdg ${fr.heading.toFixed(2)}`);
  s.ctx.cameraRig.setState({
    lat: tLatLon.lat, lon: tLatLon.lon, altitudeKm: Number(s.params.get('alt') ?? fr.d), tilt: Number(s.params.get('tilt') ?? fr.tilt),
    heading: Number(s.params.get('hdg') ?? fr.heading),
  });
  for (let i = 0; i < 240 && !battleDebug()?.built; i++) await s.waitFrames(1);
  await s.waitFrames(8);
}

registerShot('front-ground-real', 'battle', 'W6: the ground battle composed from the real front: infantry per side from the local forces, the real divisions as 1 tank per 25 % integrity + 2 IFVs at their positions, the sub-tile line, banners and the HUD strip', async (s) => {
  // One division per side, attached where the offensive's axis crosses the front: the battle the camera frames.
  const st = await stageFrontWar(s, { attacker: 'enemy', run: 220, div: 0 });
  await divisionsAtAxis(s, st);
  await frameGround(s, st);
  battleDebug()?.prewarm(Number(s.params.get('warm') ?? 10));
  await s.waitFrames(6);
  console.info(`[w6] ground ${JSON.stringify(battleDebug()?.shown() ?? null)}`);
}, 10);

registerShot('front-observation', 'battle', 'W6: the ground battle under observation time (1 s = 1 min): the line and the armies move with the sim, continuously', async (s) => {
  const st = await stageFrontWar(s, { attacker: 'enemy', run: 220, theatre: 'plains', div: 0 });
  await divisionsAtAxis(s, st);
  // Close enough to see the soldiers on both sides of the line (1 km up, looking 2.4 km ahead along the line).
  await descend(s, st, 2.6, 1.2);
  // Let the world run: below 60 km the app switches the clock to observation time (60 game s per real s).
  s.ctx.sim.setSpeed(1);
  await s.wait(Number(s.params.get('observe') ?? 20000));
  console.info(`[w6] observation ${JSON.stringify(battleDebug()?.shown() ?? null)} clock=${s.ctx.sim.view.clock.mode}`);
}, 10);

registerShot('plume-zoom', 'battle', 'W6: a missile launched from Madrid seen at 700 km, then at 200 km: the plume keeps its world size (6 → 20 km) and never covers more than 8 % of the screen height', async (s) => {
  const { ctx, params } = s;
  await ctx.app.startScriptedGame({ ticks: 200, speed: 0, headStart: 10, autopilot: false });
  const fx = fxInternal(ctx);
  const from = latLonToTile(40.42, -3.7), target = latLonToTile(48.85, 2.35);
  const samples: { alt: number; plumes: unknown }[] = [];
  ctx.cameraRig.setState({ lat: 40.42, lon: -3.7, altitudeKm: 700, tilt: Number(params.get('tilt') ?? 0.6), heading: 0.3 });
  ctx.sim.setSpeed(1);
  ctx.sim.debug({ type: 'launchNuke', weapon: UnitType.AtomBomb, owner: 2, fromTile: from, targetTile: target });
  const t0 = performance.now();
  while (performance.now() - t0 < 20_000 && !(fx?.plumes().alive)) await s.wait(100);
  // Let the plume grow for a few real seconds (its world size follows its age, 6 -> 20 km).
  await s.wait(Number(params.get('grow') ?? 10000));
  for (const alt of [700, 200]) {
    ctx.cameraRig.setState({ lat: 40.42, lon: -3.7, altitudeKm: alt, tilt: Number(params.get('tilt') ?? 0.6), heading: 0.3 });
    await s.waitFrames(6);
    samples.push({ alt, plumes: fx?.plumes().plumes.map((p) => ({ ...p })) ?? [] });
  }
  const at = Number(params.get('alt') ?? 200);
  ctx.cameraRig.setState({ lat: 40.42, lon: -3.7, altitudeKm: at, tilt: Number(params.get('tilt') ?? 0.6), heading: 0.3 });
  await s.waitFrames(6);
  ctx.sim.setSpeed(0);
  (window as unknown as { __plumeZoom?: unknown }).__plumeZoom = samples;
  console.info(`[w6] plume-zoom ${JSON.stringify(samples)}`);
}, 6);
