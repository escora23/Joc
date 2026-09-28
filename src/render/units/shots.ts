// FRONT ULTRA — units & structures shots (owner: units).
//   units       naval battle + air battle over the western Mediterranean (Balearic sea, Algerian coast)
//   units-orbit the same battle seen from high orbit (screen-space minimum sizes, LOD)
//   structures  every structure type on a developed Spain at dusk (skylines lighting up), close orbit
//   unit-closeup one unit type up close at 300 / 100 / 30 km (models clearly visible, >= 24 px)

import type { CameraState, GameContext } from '../../shared/api';
import { HUMAN_ID } from '../../shared/constants';
import { latLonToTile, worldTimeForSubsolarLon } from '../../shared/geo';
import { registerShot } from '../../shared/shots';
import { StructureType, UnitMode, UnitState, UnitType } from '../../shared/types';
import { isLandTerrain } from '../../shared/terrain';

const at = (lat: number, lon: number) => latLonToTile(lat, lon);

/** An AI nation owning land near a point (searches outward), or the biggest AI. */
export function enemyNear(ctx: GameContext, lat: number, lon: number): number {
  const v = ctx.sim.view;
  for (let r = 0; r <= 6; r += 0.5) {
    for (let a = 0; a < 16; a++) {
      const o = v.ownerAt(at(lat + Math.sin(a) * r, lon + Math.cos(a) * r));
      if (o > 0 && o !== HUMAN_ID && v.players[o]?.kind === 'nation') return o;
    }
  }
  let best = 0, bestTiles = -1;
  for (const p of v.playerList) {
    if (p.id !== HUMAN_ID && p.alive && p.kind === 'nation' && p.tiles > bestTiles) {
      best = p.id;
      bestTiles = p.tiles;
    }
  }
  return best;
}

async function stageBattle(ctx: GameContext, wait: (ms: number) => Promise<void>, waitFrames: (n: number) => Promise<void>, runMs: number, cam: CameraState): Promise<void> {
  await ctx.app.startScriptedGame({ ticks: 600, speed: 0, nukes: false, worldTimeSec: worldTimeForSubsolarLon(-38) });
  // Camera first: effects size themselves for the camera that sees them.
  ctx.cameraRig.setState(cam);
  await waitFrames(2);
  const enemy = enemyNear(ctx, 36.6, 3.2);
  const sim = ctx.sim;
  sim.debug({ type: 'conquer', playerId: enemy, centerTile: at(36.4, 3.2), radius: 7 });
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(39.4, -0.6), radius: 6 });
  const spawn = (owner: number, unit: UnitType, from: [number, number], to: [number, number]) =>
    sim.debug({ type: 'spawnUnit', unit, owner, tile: at(...from), targetTile: at(...to) });
  // Enemy coastal defence: a SAM site and a city by Algiers; a Spanish port at Valencia.
  sim.debug({ type: 'spawnStructure', structure: StructureType.SamSite, owner: enemy, tile: at(36.55, 3.3), level: 2 });
  sim.debug({ type: 'spawnStructure', structure: StructureType.City, owner: enemy, tile: at(36.62, 2.95), level: 4 });
  sim.debug({ type: 'spawnStructure', structure: StructureType.Port, owner: HUMAN_ID, tile: at(39.45, -0.33), level: 2 });
  // Open hostilities (both fleets engage on sight) and a cruise missile at Algiers.
  sim.send({ type: 'targetPlayer', target: enemy });
  sim.send({ type: 'embargo', target: enemy, active: true });
  sim.debug({ type: 'launchNuke', weapon: UnitType.CruiseMissile, owner: HUMAN_ID, fromTile: at(39.4, -0.4), targetTile: at(36.7, 3.05) });
  // Two fleets closing on each other in the Balearic sea (spawned ~1 degree apart from where the frame catches them).
  spawn(HUMAN_ID, UnitType.Warship, [39.05, 2.1], [37.2, 2.8]);
  spawn(HUMAN_ID, UnitType.Warship, [39.15, 2.6], [37.3, 3.3]);
  spawn(HUMAN_ID, UnitType.Warship, [38.95, 1.65], [37.1, 2.4]);
  spawn(HUMAN_ID, UnitType.TransportShip, [39.3, 1.9], [36.9, 2.6]);
  spawn(HUMAN_ID, UnitType.TransportShip, [39.35, 2.35], [36.95, 3.2]);
  spawn(enemy, UnitType.Warship, [37.05, 2.95], [38.8, 2.1]);
  spawn(enemy, UnitType.Warship, [37.1, 3.4], [38.9, 2.6]);
  spawn(enemy, UnitType.Warship, [36.95, 2.5], [38.7, 1.8]);
  spawn(enemy, UnitType.TradeShip, [37.7, 4.4], [38.3, -0.2]);
  // Air battle overhead.
  spawn(HUMAN_ID, UnitType.FighterSquadron, [39.4, 1.9], [37.0, 3.3]);
  spawn(HUMAN_ID, UnitType.FighterSquadron, [39.5, 2.7], [37.1, 3.8]);
  spawn(HUMAN_ID, UnitType.Bomber, [39.3, 1.5], [36.75, 3.05]);
  spawn(enemy, UnitType.FighterSquadron, [36.8, 3.3], [39.2, 2.0]);
  spawn(enemy, UnitType.FighterSquadron, [36.85, 2.4], [39.3, 1.6]);
  spawn(enemy, UnitType.DroneSwarm, [37.3, 1.9], [38.9, 1.2]);
  sim.setSpeed(1);
  await wait(runMs);
  sim.setSpeed(0);
  await waitFrames(4);
}

registerShot('units', 'units', 'Naval + air battle over the Balearic sea: warships trading fire, wakes, contrails, a cruise missile and SAM interception', async ({ ctx, wait, waitFrames, params }) => {
  await stageBattle(ctx, wait, waitFrames, Number(params.get('run') ?? 900), {
    lat: Number(params.get('lat') ?? 37.95), lon: Number(params.get('lon') ?? 2.75),
    altitudeKm: Number(params.get('alt') ?? 180), tilt: Number(params.get('tilt') ?? 1.1), heading: Number(params.get('heading') ?? 3.14),
  });
  await waitFrames(4);
}, 8);

registerShot('units-orbit', 'units', 'The Balearic battle from high orbit: units stay readable (screen-space minimum size)', async ({ ctx, wait, waitFrames }) => {
  await stageBattle(ctx, wait, waitFrames, 700, { lat: 38.3, lon: 2.3, altitudeKm: 2600, tilt: 0.35, heading: 0 });
  await waitFrames(4);
}, 8);

async function stageStructures(ctx: GameContext, waitFrames: (n: number) => Promise<void>, wait: (ms: number) => Promise<void>, params: URLSearchParams, sunLon: number): Promise<void> {
  await ctx.app.startScriptedGame({ ticks: 600, speed: 0, nukes: false, worldTimeSec: worldTimeForSubsolarLon(Number(params.get('sun') ?? sunLon)) });
  const cam = {
    lat: Number(params.get('lat') ?? 39.47), lon: Number(params.get('lon') ?? -0.62),
    altitudeKm: Number(params.get('alt') ?? 120), tilt: Number(params.get('tilt') ?? 1.08), heading: Number(params.get('heading') ?? 1.35),
  };
  ctx.cameraRig.setState(cam);
  const sim = ctx.sim;
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(39.5, -0.9), radius: 9 });
  const S = StructureType;
  const put = (structure: StructureType, lat: number, lon: number, level: number) =>
    sim.debug({ type: 'spawnStructure', structure, owner: HUMAN_ID, tile: at(lat, lon), level });
  // A developed Valencian coast: a metropolis, its port and naval yard, industry on the rail network, and a
  // defended military belt inland.
  put(S.City, 39.47, -0.45, 10);
  put(S.Port, 39.45, -0.25, 3);
  put(S.NavalYard, 39.2, -0.27, 2);
  put(S.City, 39.7, -0.3, 6);
  put(S.City, 39.2, -0.55, 4);
  put(S.Factory, 39.65, -0.62, 3);
  put(S.Factory, 39.32, -0.75, 2);
  put(S.Airbase, 39.5, -0.95, 2);
  put(S.ArmyBase, 39.22, -0.98, 2);
  put(S.SamSite, 39.75, -0.88, 2);
  put(S.MissileSilo, 39.93, -0.7, 2);
  put(S.Radar, 39.9, -0.45, 1);
  put(S.DefensePost, 39.42, -1.22, 2);
  put(S.City, 39.7, -1.15, 3);
  sim.setSpeed(1);
  await wait(1500);
  sim.setSpeed(0);
  ctx.cameraRig.setState(cam);
  await waitFrames(10);
}

registerShot('structures', 'units', 'A developed nation up close (Valencian coast, afternoon): every structure type, skylines, rail network', async ({ ctx, waitFrames, wait, params }) => {
  await stageStructures(ctx, waitFrames, wait, params, -68);
}, 8);

registerShot('structures-night', 'units', 'The same developed coast at night: skylines, streets and bases lit up', async ({ ctx, waitFrames, wait, params }) => {
  await stageStructures(ctx, waitFrames, wait, params, -112);
}, 8);

/**
 * One unit up close (owner clarification to FEEDBACK-1: close-zoom models must be clearly visible). &unit= a UnitType
 * name (TransportShip, TradeShip, Warship, ArmoredDivision, FighterSquadron, Bomber, DroneSwarm, Train), &alt= 300 /
 * 100 / 30 km. The human's unit sails, drives or flies off the Valencian coast, paused, the camera centred on it with a
 * 0.6 rad tilt. tools/w2-verify.mjs (check `models`) reads its projected size from __units.stats().unitModelsInView.
 */
registerShot('unit-closeup', 'units', 'One unit up close (&unit=Warship|TransportShip|TradeShip|ArmoredDivision|FighterSquadron|Bomber|DroneSwarm|Train, &alt=300|100|30): the 3D model is clearly visible (>= 24 px)', async ({ ctx, waitFrames, wait, params }) => {
  await ctx.app.startScriptedGame({ ticks: 600, speed: 0, nukes: false, worldTimeSec: worldTimeForSubsolarLon(Number(params.get('sun') ?? -20)) });
  const name = (params.get('unit') ?? 'Warship') as keyof typeof UnitType;
  const type = UnitType[name] ?? UnitType.Warship;
  const sim = ctx.sim;
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(39.5, -0.9), radius: 9 });
  sim.debug({ type: 'spawnStructure', structure: StructureType.City, owner: HUMAN_ID, tile: at(39.47, -0.45), level: 4 });
  sim.debug({ type: 'spawnStructure', structure: StructureType.Airbase, owner: HUMAN_ID, tile: at(39.5, -0.95), level: 2 });
  const naval = type === UnitType.TransportShip || type === UnitType.TradeShip || type === UnitType.Warship;
  const air = type === UnitType.FighterSquadron || type === UnitType.Bomber || type === UnitType.DroneSwarm;
  const from: [number, number] = naval ? [39.3, 0.9] : air ? [39.4, -0.2] : [39.55, -1.2];
  // Trains get a long staged line (a short one can be finished, and the train gone, before the pause lands).
  const to: [number, number] = naval ? [38.2, 4.5] : air ? [38.6, 3.5] : type === UnitType.Train ? [40.9, -2.9] : [39.3, -0.6];
  sim.debug({ type: 'spawnUnit', unit: type, owner: HUMAN_ID, tile: at(...from), targetTile: at(...to) });
  // A moment of motion so the unit is under way (aircraft airborne, ships with a heading), then paused.
  sim.setSpeed(1);
  await wait(Number(params.get('run') ?? 600));
  sim.setSpeed(0);
  await waitFrames(4);
  let lat = from[0], lon = from[1];
  for (const u of sim.view.units.values()) {
    if (u.owner === HUMAN_ID && u.type === type) {
      const w = ctx.world;
      const mw = w ? w.width : 1600, mh = w ? w.height : 800;
      lon = ((((u.x % mw) + mw) % mw) / mw) * 360 - 180;
      lat = 90 - (u.y / mh) * 180;
      (window as unknown as { __closeupUnit?: number }).__closeupUnit = u.id;
      break;
    }
  }
  ctx.cameraRig.setMode('game');
  ctx.cameraRig.setState({ lat, lon, altitudeKm: Number(params.get('alt') ?? 100), tilt: Number(params.get('tilt') ?? 0.6), heading: Number(params.get('heading') ?? 0) });
  await waitFrames(10);
}, 8);

/**
 * Model gallery (owner clarification to FEEDBACK-1: every model clearly visible up close). Every structure type at
 * levels 1-3 (cities 1 / 5 / 10) on Castilian land and the Valencian coast, 50 km apart, airbases with their docked
 * aircraft, and every unit type (warship, convoy, trade ship, division, fighter patrol, bomber and drone sorties,
 * train), paused. window.__gallery lists the subjects; tools/w4-closeups.mjs flies the camera to each one at 300 /
 * 100 / 40 / 8 km and captures what the player sees.
 */
registerShot('model-gallery', 'units', 'Every unit and structure model (levels 1-3) staged for close-up review at 300 / 100 / 40 / 8 km (tools/w4-closeups.mjs)', async ({ ctx, wait, waitFrames, params }) => {
  await ctx.app.startScriptedGame({ ticks: 100, speed: 0, nukes: false, autopilot: false, worldEvents: false, worldTimeSec: worldTimeForSubsolarLon(Number(params.get('sun') ?? -45)) });
  const sim = ctx.sim;
  const S = StructureType;
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(39.7, -3.4), radius: 18 });
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(39.5, -0.7), radius: 9 });
  const inland = [S.City, S.Factory, S.DefensePost, S.SamSite, S.MissileSilo, S.Airbase, S.ArmyBase, S.Radar];
  const subjects: { name: string; kind: 'struct' | 'unit'; type: number; level: number; tile: number }[] = [];
  inland.forEach((type, i) => {
    const r = Math.floor(i / 2), c0 = (i % 2) * 3;
    [1, 2, 3].forEach((L, c) => {
      const level = type === S.City ? [1, 5, 10][c] : L;
      const tile = at(40.75 - r * 0.5, -5.0 + (c0 + c) * 0.5);
      subjects.push({ name: `${['city', 'port', 'factory', 'defensePost', 'samSite', 'silo', 'airbase', 'armyBase', 'navalYard', 'radar'][type]}${L}`, kind: 'struct', type, level, tile });
    });
  });
  // Ports and naval yards on the coast between Castellón and Dénia (the first land tile west of the sea).
  const w = ctx.world;
  const coast = (lat: number): number => {
    const t0 = at(lat, 0.6);
    if (!w) return t0;
    const y = Math.floor(t0 / w.width);
    for (let x = t0 % w.width; x > (t0 % w.width) - 40; x--) {
      const t = y * w.width + x;
      if (w.terrain[t] !== undefined && isLandTerrain(w.terrain[t]) && !isLandTerrain(w.terrain[t + 1])) return t;
    }
    return t0;
  };
  [[S.Port, [40.35, 40.0, 39.65]], [S.NavalYard, [39.3, 39.0, 38.75]]].forEach(([type, lats]) => {
    (lats as number[]).forEach((lat, c) => subjects.push({ name: `${type === S.Port ? 'port' : 'navalYard'}${c + 1}`, kind: 'struct', type: type as number, level: c + 1, tile: coast(lat) }));
  });
  for (const s of subjects) sim.debug({ type: 'spawnStructure', structure: s.type as StructureType, owner: HUMAN_ID, tile: s.tile, level: s.level });
  await until(() => sim.view.structures.size >= subjects.length, 60000, wait);
  // Docked aircraft: 3 / 6 / 9 squadrons on the airbases of levels 1 / 2 / 3 (fighters, bombers and drones).
  for (const s of subjects.filter((x) => x.type === S.Airbase)) {
    for (let i = 0; i < 3 * s.level; i++) {
      const unit = i % 3 === 1 ? UnitType.Bomber : i % 3 === 2 ? UnitType.DroneSwarm : UnitType.FighterSquadron;
      sim.debug({ type: 'spawnUnit', unit, owner: HUMAN_ID, tile: s.tile, targetTile: -1 });
    }
  }
  const spawn = (unit: UnitType, from: [number, number], to?: [number, number]) =>
    sim.debug({ type: 'spawnUnit', unit, owner: HUMAN_ID, tile: at(...from), targetTile: to ? at(...to) : -1 });
  // A bomber and a drone swarm on a real sortie: war with the nation across the sea, strikes on its army base (a
  // military target: escalation level 1).
  const enemy = enemyNear(ctx, 36.6, 3.2);
  sim.debug({ type: 'conquer', playerId: enemy, centerTile: at(36.4, 3.2), radius: 7 });
  sim.debug({ type: 'spawnStructure', structure: S.ArmyBase, owner: enemy, tile: at(36.62, 2.95), level: 1 });
  sim.debug({ type: 'war', a: HUMAN_ID, b: enemy, mobilizeTicks: 0 });
  sim.debug({ type: 'escalate', by: HUMAN_ID, against: enemy, level: 1 });
  sim.setSpeed(1);
  await until(() => [...sim.view.units.values()].some((u) => u.owner === HUMAN_ID && u.type === UnitType.DroneSwarm) && [...sim.view.structures.values()].some((x) => x.owner === enemy && x.type === S.ArmyBase), 30000, wait);
  sim.setSpeed(0);
  const target = [...sim.view.structures.values()].find((x) => x.owner === enemy && x.type === S.ArmyBase);
  // The drone swarm (slow) leaves first; the bomber (fast) is sent once the drones are out, so both are in cruise
  // together, far short of the target.
  const sortie: number[] = [];
  for (const ty of [UnitType.Bomber, UnitType.DroneSwarm]) {
    const u = [...sim.view.units.values()].find((x) => x.owner === HUMAN_ID && x.type === ty);
    if (u) sortie.push(u.id);
  }
  const strike = (id: number): void => {
    if (target) sim.send({ type: 'unitOrder', unitIds: [id], order: 'strike', tile: target.tile, targetId: target.id });
  };
  if (sortie[1] !== undefined) strike(sortie[1]);
  // Ships bound far away (still under way when the frame is paused), a division, a fighter patrol, a train.
  spawn(UnitType.Warship, [39.2, 1.0], [38.9, 2.2]);
  spawn(UnitType.TransportShip, [39.7, 1.2], [37.6, 6.5]);
  spawn(UnitType.TradeShip, [38.6, 1.1], [37.4, 8.0]);
  spawn(UnitType.ArmoredDivision, [39.25, -1.2]);
  spawn(UnitType.FighterSquadron, [39.9, -1.4], [39.9, -1.4]);
  spawn(UnitType.Train, [40.3, -1.2], [39.4, -3.9]);
  const want = [UnitType.Warship, UnitType.TransportShip, UnitType.TradeShip, UnitType.ArmoredDivision, UnitType.FighterSquadron, UnitType.Bomber, UnitType.DroneSwarm, UnitType.Train];
  // Stepped with the sim paused (fastForward runs exact tick counts in the worker, whatever the page's frame rate):
  // the drone swarm (slow) is sent first; once it cruises at least 60 km out the bomber (fast) is sent, and the
  // gallery stops on the first tick the bomber also cruises 60 km out, both far short of the 800 km strike. So the
  // two are frozen in flight, never at the strike (a frozen fireball) nor back on the apron. w4-closeups fails the
  // run, naming what is missing, if either is not.
  const outbound = (id: number): boolean => {
    const u = sim.view.units.get(id);
    const home = u ? sim.view.structures.get(u.home) : undefined;
    if (!u || !home || u.state === UnitState.Docked || u.mode === UnitMode.Docked || u.mode === UnitMode.Rearming || u.mode === UnitMode.Returning) return false;
    const hx = (home.tile % 1600) + 0.5, hy = Math.floor(home.tile / 1600) + 0.5;
    const km = Math.hypot((u.x - hx) * Math.cos((39.5 * Math.PI) / 180), u.y - hy) * 25;
    return km >= 60 && u.alt > 0.6;
  };
  const present = (): boolean => want.every((ty) => [...sim.view.units.values()].some((u) => u.type === ty && u.owner === HUMAN_ID && u.state !== UnitState.Docked));
  const t0 = sim.view.tick;
  sim.setSpeed(0);
  let bomberSent = false;
  for (let k = 0; k < 80; k++) {
    await sim.fastForward(1);
    if (!bomberSent && sortie.length === 2 && outbound(sortie[1])) {
      bomberSent = true;
      strike(sortie[0]);
    }
    if (bomberSent && sortie.every(outbound) && present() && sim.view.tick >= t0 + 4) break;
  }
  await waitFrames(6);
  const names = ['transport', 'trade', 'warship', 'division', 'fighter', 'bomber', 'drone', 'cruise', 'atom', 'hbomb', 'mirv', 'warhead', 'sam', 'train', 'shell'];
  const missing: string[] = [];
  // The train subject: one a factory dispatched along the rail network (its route is the chain of stations, drawn as
  // the rail line), rather than the staged one, whose straight path follows no drawn line.
  const stationTiles = new Set([...sim.view.structures.values()].map((x) => x.tile));
  const railTrain = [...sim.view.units.values()].find((u) => {
    if (u.type !== UnitType.Train || u.owner !== HUMAN_ID) return false;
    const r = sim.view.routes.get(u.id);
    return !!r && r.length >= 2 && [...r].every((t) => stationTiles.has(t));
  });
  for (const ty of want) {
    const u = ty === UnitType.Train && railTrain ? railTrain : ty === UnitType.Bomber || ty === UnitType.DroneSwarm
      ? sortie.map((id) => sim.view.units.get(id)).find((x) => x && x.type === ty && outbound(x.id))
      : [...sim.view.units.values()].find((x) => x.type === ty && x.owner === HUMAN_ID && x.state !== UnitState.Docked);
    if (u) subjects.push({ name: names[ty], kind: 'unit', type: ty, level: 1, tile: u.id });
    else missing.push(names[ty]);
  }
  const diag = sortie.map((id) => {
    const u = sim.view.units.get(id);
    return u ? `${names[u.type]} ${id}: state ${u.state} mode ${u.mode} alt ${u.alt.toFixed(2)} at ${u.x.toFixed(1)},${u.y.toFixed(1)}` : `${id} gone`;
  });
  (window as unknown as { __gallery?: unknown }).__gallery = { subjects, missing, diag: `paused at tick ${sim.view.tick} (${sim.view.tick - t0} after the sortie), bomber sent ${bomberSent}; ${diag.join('; ')}` };
  const first = subjects[0];
  ctx.cameraRig.setState({ lat: 90 - (Math.floor(first.tile / 1600) + 0.5) * 0.225, lon: ((first.tile % 1600) + 0.5) * 0.225 - 180, altitudeKm: 300, tilt: 0.5, heading: 0 });
  await waitFrames(6);
}, 6);

async function until(cond: () => boolean, ms: number, wait: (ms: number) => Promise<void>): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (cond()) return true;
    await wait(150);
  }
  return cond();
}
