// FRONT ULTRA — command mode shots (owner: W5-command-v2).
// Every shot stages a REAL situation in the simulation (a division of the human at a real place, a neighbour at peace
// or at war with real land, real enemy units), then takes control through the normal entry (app.enterCommandMode),
// so what the capture shows is what command mode derives from the sim there. Staging only fast-forwards the local
// scene (no input) and then freezes it for a reproducible image. `&live=1` enters normally and stops (interactive
// tests and the verifier).
//   command-peace       tank near Zaragoza, own land at peace: towns, roads, bases, no enemies
//   command-border      tank near the border with a neighbour at peace: the painted line, posts, the warning
//   command-front       tank at a real front of a staged war: enemy infantry from the front pools, real divisions
//   command-travel      autopilot toward a destination 300 km away at ×300: the travel camera and the terrain stream
//   command-jet-cap     fighter squadron on patrol at its real altitude
//   command-ship-coast  warship at sea off the Spanish coast, at peace
//   command-tank / -jet / -ship   the same at war (updated v1 names), command-intro, command-debrief, command-garage

import * as THREE from 'three';
import { HUMAN_ID, MAP_W } from '../shared/constants';
import { latLonToTile, tileToLatLon, worldTimeForSubsolarLon } from '../shared/geo';
import { registerShot, type ShotContext } from '../shared/shots';
import { StructureType, UnitType } from '../shared/types';
import { commandInternals, type CommandInternals } from './index';
import type { Ent, EntKind } from './world';

function live(s: ShotContext): boolean {
  return s.params.get('live') === '1';
}

function internalsOrThrow(): CommandInternals {
  const I = commandInternals();
  if (!I || !I.controller) throw new Error('command mode not active');
  return I;
}

interface Stage {
  unit: UnitType;
  lat: number;
  lon: number;
  /** Local solar hour for the light. */
  hour: number;
  /** A neighbour nation given land around this point (the AI whose capital is nearest to it). */
  neighbour?: { lat: number; lon: number; radius: number };
  /** Put the human and the neighbour at war and let the front form for this many ticks. */
  war?: number;
  /** Extra staging before taking control (spawn enemy units, structures). */
  before?: (s: ShotContext, foe: number) => Promise<void> | void;
  /** Human land radius (tiles) around the unit (a sizeable own territory). */
  ownRadius?: number;
}

/** The AI nation whose capital is nearest to (lat, lon). */
function nearestNation(s: ShotContext, lat: number, lon: number): number {
  const view = s.ctx.sim.view;
  let best = 0, bd = Infinity;
  for (const p of view.playerList) {
    if (!p.alive || p.id === HUMAN_ID || p.kind !== 'nation' || p.capitalTile < 0) continue;
    const ll = tileToLatLon(p.capitalTile);
    const d = Math.hypot(ll.lat - lat, (ll.lon - lon) * Math.cos((lat * Math.PI) / 180));
    if (d < bd) {
      bd = d;
      best = p.id;
    }
  }
  return best;
}

async function waitUnit(s: ShotContext, type: UnitType, owner: number, near: { lat: number; lon: number }): Promise<number> {
  const t0 = latLonToTile(near.lat, near.lon);
  const tx = t0 % MAP_W, ty = Math.floor(t0 / MAP_W);
  for (let i = 0; i < 900; i++) {
    for (const u of s.ctx.sim.view.units.values()) {
      if (u.owner === owner && u.type === type && Math.abs(u.x - tx) < 3 && Math.abs(u.y - ty) < 3) return u.id;
    }
    await s.waitFrames(1);
  }
  throw new Error('unit did not appear');
}

/** Stage the situation and take control of the human's unit there. Returns the neighbour id (0 = none). */
async function stage(s: ShotContext, st: Stage): Promise<number> {
  const { ctx } = s;
  const hour = s.params.has('hour') ? Number(s.params.get('hour')) : st.hour;
  const subsolar = st.lon - (hour - 12) * 15;
  await ctx.app.startScriptedGame({
    speed: 0, tribeCount: 0, aiCount: 24, worldTimeSec: worldTimeForSubsolarLon(subsolar), autopilot: false, headStart: 18,
    nukes: false, worldEvents: false,
  });
  let foe = 0;
  if (st.neighbour) {
    foe = nearestNation(s, st.neighbour.lat, st.neighbour.lon);
    if (foe) ctx.sim.debug({ type: 'conquer', playerId: foe, centerTile: latLonToTile(st.neighbour.lat, st.neighbour.lon), radius: st.neighbour.radius });
  }
  ctx.sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: latLonToTile(st.lat, st.lon), radius: st.ownRadius ?? 6 });
  if (foe && st.war) {
    ctx.sim.debug({ type: 'war', a: foe, b: HUMAN_ID, mobilizeTicks: 0 });
    ctx.sim.debug({ type: 'addTroops', playerId: foe, amount: 400_000 });
  }
  await st.before?.(s, foe);
  if (st.war) await ctx.sim.fastForward(st.war);
  ctx.sim.debug({ type: 'spawnUnit', unit: st.unit, owner: HUMAN_ID, tile: latLonToTile(st.lat, st.lon), targetTile: -1 });
  const id = await waitUnit(s, st.unit, HUMAN_ID, st);
  await ctx.app.enterCommandMode(id);
  ctx.sim.setSpeed(0);
  return foe;
}

/** Let the local scene run a little (forces arrive, dust settles) without input. */
async function settle(s: ShotContext, I: CommandInternals, seconds: number): Promise<void> {
  I.skipIntro();
  I.simulate(Math.round(seconds * 30), 1 / 30);
  await s.waitFrames(8);
}

async function freezeAndWait(s: ShotContext, I: CommandInternals): Promise<void> {
  I.freeze = true;
  await s.waitFrames(6);
}

async function waitFramesUntil(s: ShotContext, cond: () => boolean, max: number): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) await s.waitFrames(1);
}

function nearest(I: CommandInternals, from: THREE.Vector3, team: 0 | 1, kinds: EntKind[]): Ent | null {
  let best: Ent | null = null, bd = Infinity;
  for (const e of I.world.ents) {
    if (!e.alive || e.team !== team || e.player || e.neutral || !kinds.includes(e.kind)) continue;
    const d = e.pos.distanceTo(from);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

// =================================================================================================

const PEACE: Stage = {
  unit: UnitType.ArmoredDivision, lat: 41.6, lon: -0.95, hour: 16,
  before: (st) => {
    st.ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.City, owner: HUMAN_ID, tile: latLonToTile(41.65, -0.88), level: 4 });
    st.ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.ArmyBase, owner: HUMAN_ID, tile: latLonToTile(41.55, -1.1), level: 2 });
    st.ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.Airbase, owner: HUMAN_ID, tile: latLonToTile(41.7, -1.2), level: 1 });
  },
};

const FRONT: Stage = {
  unit: UnitType.ArmoredDivision, lat: 42.3, lon: -0.6, hour: 16, ownRadius: 3, neighbour: { lat: 43.2, lon: -0.5, radius: 4 }, war: 160,
  before: (st, foe) => {
    if (!foe) return;
    st.ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: foe, tile: latLonToTile(42.62, -0.55), targetTile: -1 });
    st.ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.DefensePost, owner: foe, tile: latLonToTile(42.7, -0.6), level: 2 });
  },
};

registerShot('command-peace', 'command', 'Take control at peace: a tank near Zaragoza in its own land (towns, roads, bases, no enemies)', async (s) => {
  await stage(s, PEACE);
  if (live(s)) return;
  const I = internalsOrThrow();
  await waitFramesUntil(s, () => I.civil.labels.length > 0, 600);
  await settle(s, I, 2);
  await freezeAndWait(s, I);
});

registerShot('command-border', 'command', 'Near the border with a nation at peace: the painted border line, posts and the approach warning', async (s) => {
  // Own land around Jaca, the neighbour's land north of the Pyrenees: the border runs along the tile edge between.
  await stage(s, { unit: UnitType.ArmoredDivision, lat: 42.45, lon: -0.55, hour: 15.5, ownRadius: 3, neighbour: { lat: 43.6, lon: -0.4, radius: 4 } });
  if (live(s)) return;
  const I = internalsOrThrow();
  // Face north, toward the border.
  I.controller!.ent.yaw = 0;
  await settle(s, I, 1);
  await freezeAndWait(s, I);
});

registerShot('command-front', 'command', 'At a real front of a staged war: enemy infantry and armor derived from the front, real divisions nearby', async (s) => {
  await stage(s, FRONT);
  if (live(s)) return;
  const I = internalsOrThrow();
  await settle(s, I, Number(s.params.get('fight') ?? 6));
  await freezeAndWait(s, I);
});

registerShot('command-travel', 'command', 'Travel mode: autopilot toward a destination 300 km away at ×300 (camera up, terrain streaming ahead)', async (s) => {
  await stage(s, { unit: UnitType.ArmoredDivision, lat: 40.6, lon: -3.2, hour: 15, ownRadius: 14 });
  if (live(s)) return;
  const I = internalsOrThrow();
  I.skipIntro();
  I.setWaypoint(41.4, 0.1);
  I.requestRate(60);
  await s.wait(300);
  I.requestRate(300);
  await s.wait(Number(s.params.get('ms') ?? 9000));
  await freezeAndWait(s, I);
});

registerShot('command-jet-cap', 'command', 'Fighter squadron on patrol over its own land, at its real altitude', async (s) => {
  await stage(s, { unit: UnitType.FighterSquadron, lat: 41.0, lon: -2.0, hour: 16.5, ownRadius: 10 });
  if (live(s)) return;
  const I = internalsOrThrow();
  await settle(s, I, 2);
  await freezeAndWait(s, I);
});

registerShot('command-ship-coast', 'command', 'Warship at sea off the Spanish coast at peace: calm sea and the real coast', async (s) => {
  await stage(s, { unit: UnitType.Warship, lat: 39.3, lon: 0.05, hour: 17, ownRadius: 8 });
  if (live(s)) return;
  const I = internalsOrThrow();
  await settle(s, I, 2);
  await freezeAndWait(s, I);
});

registerShot('command-tank', 'command', 'Tank at a real front (the command-front staging, facing the nearest enemy)', async (s) => {
  await stage(s, FRONT);
  if (live(s)) return;
  const I = internalsOrThrow();
  I.skipIntro();
  I.world.godMode = true;
  const p = I.controller!.ent;
  const foeEnt = nearest(I, p.pos, 1, ['tank', 'ifv', 'at', 'soldier']);
  const aim = () => {
    if (foeEnt?.alive) I.controller!.aimAt(foeEnt.pos.clone().setY(foeEnt.pos.y + 1.4));
  };
  if (foeEnt) p.yaw = Math.atan2(-(foeEnt.pos.x - p.pos.x), -(foeEnt.pos.z - p.pos.z));
  aim();
  I.simulate(Math.round(Number(s.params.get('fight') ?? 8) * 30), 1 / 30, aim);
  await freezeAndWait(s, I);
});

registerShot('command-jet', 'command', 'Fighter over a front at war: enemy aircraft only from real squadrons', async (s) => {
  await stage(s, {
    unit: UnitType.FighterSquadron, lat: 42.4, lon: -0.6, hour: 17, ownRadius: 3, neighbour: { lat: 43.2, lon: -0.5, radius: 4 }, war: 160,
    before: (st, f) => {
      if (!f) return;
      st.ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.Airbase, owner: f, tile: latLonToTile(43.25, -0.4), level: 2 });
      st.ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.FighterSquadron, owner: f, tile: latLonToTile(43.25, -0.4), targetTile: -1 });
    },
  });
  if (live(s)) return;
  const I = internalsOrThrow();
  await settle(s, I, 4);
  await freezeAndWait(s, I);
});

registerShot('command-ship', 'command', 'Warship at war: enemy ships only where the sim has them', async (s) => {
  await stage(s, {
    unit: UnitType.Warship, lat: 39.3, lon: 0.05, hour: 17.3, ownRadius: 8, neighbour: { lat: 39.6, lon: 2.9, radius: 3 }, war: 100,
    before: (st, f) => {
      if (f) st.ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.Warship, owner: f, tile: latLonToTile(39.3, 0.35), targetTile: -1 });
    },
  });
  if (live(s)) return;
  const I = internalsOrThrow();
  await settle(s, I, 4);
  await freezeAndWait(s, I);
});

registerShot('command-intro', 'command', 'Take control: the swoop into the tank with the title card (unit, place, land status)', async (s) => {
  await stage(s, PEACE);
  const I = internalsOrThrow();
  I.hold = true;
  I.setPhaseTime(Number(s.params.get('t') ?? 1.9));
  I.simulate(10, 1 / 30);
  await s.waitFrames(6);
});

registerShot('command-debrief', 'command', 'The report on leaving command mode (synced numbers), climbing away from the unit', async (s) => {
  await stage(s, PEACE);
  const I = internalsOrThrow();
  I.skipIntro();
  I.simulate(30, 1 / 30);
  I.debrief();
  I.hold = true;
  I.setPhaseTime(Number(s.params.get('t') ?? 2.2));
  I.simulate(5, 1 / 30);
  await s.waitFrames(8);
});

registerShot('command-garage', 'command', 'Model check: the ground vehicles of both sides lined up in front of the player tank', async (s) => {
  await stage(s, { ...PEACE, hour: Number(s.params.get('hour') ?? 15.5) });
  const I = internalsOrThrow();
  I.skipIntro();
  const c = I.controller!;
  const p = c.ent;
  const kinds = (s.params.get('kinds') ?? 'tank,ifv,aa,sam,truck').split(',') as EntKind[];
  const dist = Number(s.params.get('dist') ?? 26);
  const gap = Number(s.params.get('gap') ?? 11);
  const fwd = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  let i = 0;
  for (const team of [1, 0] as const) {
    for (const k of kinds) {
      const side = (i - (kinds.length * 2 - 1) / 2) * gap;
      const v = p.pos.clone().addScaledVector(fwd, dist + (team === 0 ? 14 : 0)).addScaledVector(right, side);
      const e = I.world.spawn(k, team, v.x, v.z, p.yaw + Math.PI + 0.7);
      e.neutral = true;
      e.order = 'hold';
      e.fireCd = e.fireCd2 = 1e9;
      i++;
    }
  }
  const ahead = p.pos.clone().addScaledVector(fwd, dist + 7);
  c.aimAt(ahead.setY(I.world.ground.heightAt(ahead.x, ahead.z) + 1));
  I.simulate(4, 1 / 30);
  await freezeAndWait(s, I);
});
