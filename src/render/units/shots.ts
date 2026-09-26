// FRONT ULTRA — units & structures shots (owner: units).
//   units       naval battle + air battle over the western Mediterranean (Balearic sea, Algerian coast)
//   units-orbit the same battle seen from high orbit (screen-space minimum sizes, LOD)
//   structures  every structure type on a developed Spain at dusk (skylines lighting up), close orbit
//   unit-closeup one unit type up close at 300 / 100 / 30 km (models clearly visible, >= 24 px)

import type { CameraState, GameContext } from '../../shared/api';
import { HUMAN_ID } from '../../shared/constants';
import { latLonToTile, worldTimeForSubsolarLon } from '../../shared/geo';
import { registerShot } from '../../shared/shots';
import { StructureType, UnitType } from '../../shared/types';

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
