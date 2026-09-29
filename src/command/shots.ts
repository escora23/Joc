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
//   command-escort      tank that crossed into a neighbour at peace and stayed: the patrol APCs at their stations
//                       around it (one ahead blocking, two beside) and the radio's last warning (owner feedback #20)
//   command-jet-intercept  fighter in a neighbour's airspace: the neighbour's scrambled fighters on its wings
//   command-tank / -jet / -ship   the same at war (updated v1 names), command-intro, command-debrief, command-garage

import * as THREE from 'three';
import { HUMAN_ID, MAP_H, MAP_W, TILE_KM } from '../shared/constants';
import { latLonToTile, latLonToTileXY, tileToLatLon, worldTimeForSubsolarLon } from '../shared/geo';
import { deriveLocalForces } from '../shared/localForces';
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

/**
 * A human land tile touching a nation's land (4-neighbour), nearest to (lat, lon): the real border of the staged
 * world. `foe` restricts the neighbour.
 */
function humanBorder(s: ShotContext, lat: number, lon: number, foe = 0): { hx: number; hy: number; fx: number; fy: number; foe: number } | null {
  const view = s.ctx.sim.view;
  const t0 = latLonToTile(lat, lon);
  const cx = t0 % MAP_W, cy = Math.floor(t0 / MAP_W);
  let best: { hx: number; hy: number; fx: number; fy: number; foe: number } | null = null, bd = Infinity;
  for (let dy = -60; dy <= 60; dy++) {
    for (let dx = -60; dx <= 60; dx++) {
      const x = (cx + dx + MAP_W) % MAP_W, y = cy + dy;
      if (y < 1 || y >= MAP_H - 1 || view.owner[y * MAP_W + x] !== HUMAN_ID) continue;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = (x + ox + MAP_W) % MAP_W, ny = y + oy;
        const o = view.owner[ny * MAP_W + nx];
        if (!o || o === HUMAN_ID || (foe && o !== foe) || view.players[o]?.kind !== 'nation') continue;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = { hx: x, hy: y, fx: nx, fy: ny, foe: o };
        }
      }
    }
  }
  return best;
}

/** Conquer a chain of discs for `foe` from its capital to (lat, lon): a contiguous corridor of its land. */
function connectNation(s: ShotContext, foe: number, lat: number, lon: number): void {
  const view = s.ctx.sim.view;
  const cap = view.players[foe]?.capitalTile ?? -1;
  if (cap < 0) return;
  const a = tileToLatLon(cap);
  const n = Math.max(1, Math.ceil(Math.hypot(lat - a.lat, (lon - a.lon) * Math.cos((lat * Math.PI) / 180)) / 0.7));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    s.ctx.sim.debug({ type: 'conquer', playerId: foe, centerTile: latLonToTile(a.lat + (lat - a.lat) * t, a.lon + (lon - a.lon) * t), radius: 4 });
  }
}

async function startSession(s: ShotContext, lon: number, hour: number, headStart = 18): Promise<void> {
  const h = s.params.has('hour') ? Number(s.params.get('hour')) : hour;
  await s.ctx.app.startScriptedGame({
    speed: 0, tribeCount: 0, aiCount: 24, worldTimeSec: worldTimeForSubsolarLon(lon - (h - 12) * 15), autopilot: false, headStart,
    nukes: false, worldEvents: false,
  });
}

/**
 * Spawn the human's unit at a tile and walk it (through the real controlledMove, with its speed check) to `km` short
 * of the edge it shares with a neighbouring tile: the vehicle starts close to a real border or front.
 */
async function spawnNearEdge(s: ShotContext, type: UnitType, b: { hx: number; hy: number; fx: number; fy: number }, km: number): Promise<number> {
  const { ctx } = s;
  ctx.sim.debug({ type: 'spawnUnit', unit: type, owner: HUMAN_ID, tile: b.hy * MAP_W + b.hx, targetTile: -1 });
  const ll0 = tileToLatLon(b.hy * MAP_W + b.hx);
  const id = await waitUnit(s, type, HUMAN_ID, ll0);
  ctx.sim.send({ type: 'unitControl', unitId: id, controlled: true });
  await ctx.sim.fastForward(1);
  await waitView(s, () => !!ctx.sim.view.command?.controlled.some((c) => c.unitId === id), 60_000);
  await walkToward(s, id, (b.hx + b.fx) / 2 + 0.5, (b.hy + b.fy) / 2 + 0.5, km);
  return id;
}

/**
 * Walk a controlled unit (real controlledMove, legal speed: one tick of game time per ≤ 4.5 km step) toward a point in
 * tile coords, stopping `km` short of it.
 */
async function walkToward(s: ShotContext, id: number, ex: number, ey: number, km: number): Promise<void> {
  const { ctx } = s;
  const u = ctx.sim.view.units.get(id);
  if (!u) return;
  const lat = 90 - (u.y / MAP_H) * 180;
  const kmX = TILE_KM * Math.cos((lat * Math.PI) / 180);
  let dxKm = (ex - u.x) * kmX, dyKm = (ey - u.y) * TILE_KM;
  const L = Math.hypot(dxKm, dyKm);
  if (L < 1e-6) return;
  const go = Math.max(0, L - km);
  dxKm /= L;
  dyKm /= L;
  let x = u.x, y = u.y;
  for (let done = 0; done < go - 1e-3;) {
    const st = Math.min(4.5, go - done);
    x += (dxKm * st) / kmX;
    y += (dyKm * st) / TILE_KM;
    done += st;
    // Game time must pass for the move to be legal (the sim checks 65 km/h × elapsed × 1.1): one tick = 6 game min.
    await ctx.sim.fastForward(1);
    ctx.sim.send({ type: 'controlledMove', unitId: id, x, y, heading: Math.atan2(dxKm, -dyKm) });
    const tx = x, ty = y;
    await waitView(s, () => {
      const v = ctx.sim.view.units.get(id);
      return !!v && Math.abs(v.x - tx) < 0.01 && Math.abs(v.y - ty) < 0.01;
    }, 60_000);
  }
}

/** Poll the client view until `cond` holds (the software-rendered page applies worker updates once per frame). */
async function waitView(s: ShotContext, cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) return false;
    await s.wait(100);
  }
  return true;
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
  await startSession(s, st.lon, st.hour);
  let foe = 0;
  if (st.neighbour) {
    foe = nearestNation(s, st.neighbour.lat, st.neighbour.lon);
    if (foe) ctx.sim.debug({ type: 'conquer', playerId: foe, centerTile: latLonToTile(st.neighbour.lat, st.neighbour.lon), radius: st.neighbour.radius });
  }
  if (st.ownRadius) {
    const t = latLonToTile(st.lat, st.lon);
    ctx.sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: t, radius: st.ownRadius });
    await waitView(s, () => ctx.sim.view.owner[t] === HUMAN_ID, 60_000);
  }
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

/**
 * The human's real border nearest to (lat, lon), at peace or (war > 0) after a war with that neighbour has run
 * `war` ticks; the unit is walked to `km` from the border / front line, then taken under control.
 */
async function stageBorder(s: ShotContext, unit: UnitType, lat: number, lon: number, hour: number, km: number, war = 0,
  before?: (s: ShotContext, foe: number, b: { hx: number; hy: number; fx: number; fy: number }) => Promise<void> | void, frontKm = 0): Promise<number> {
  const { ctx } = s;
  await startSession(s, lon, hour);
  // A real neighbour: the nation whose capital is nearest to the north of the point gets a contiguous strip of land
  // from its capital down to ~1 tile north of the point (staging only; the border then is a real sim border).
  const foe0 = nearestNation(s, lat + 2, lon);
  if (foe0) connectNation(s, foe0, lat + 0.55, lon);
  await waitView(s, () => !!humanBorder(s, lat, lon, foe0), 90_000);
  let b = humanBorder(s, lat, lon, foe0);
  if (!b) throw new Error('no border near the staging point');
  const foe = b.foe;
  if (war) {
    ctx.sim.debug({ type: 'war', a: foe, b: HUMAN_ID, mobilizeTicks: 0 });
    ctx.sim.debug({ type: 'addTroops', playerId: foe, amount: 300_000 });
    await ctx.sim.fastForward(war);
    b = humanBorder(s, lat, lon, foe) ?? b;
  }
  await before?.(s, foe, b);
  const id = await spawnNearEdge(s, unit, b, km);
  if (frontKm > 0) {
    // Close in on the real front line (the sub-tile contact line of this war, not the tile edge).
    // The line moves while the walk's ticks run (the war goes on): walk again from where it is until it is that close.
    for (let pass = 0; pass < 4; pass++) {
      const u = ctx.sim.view.units.get(id);
      if (!u) break;
      // The sim reads the precise (sub-tile) line under the focus, as it will under the vehicle in command mode.
      ctx.sim.setClock('observation', undefined, { x: u.x, y: u.y });
      await s.wait(1500);
      const lf = deriveLocalForces(ctx.sim.view, u.x, u.y, 40, HUMAN_ID);
      const fr = lf.fronts[0];
      if (!fr || fr.nearest.distKm <= frontKm + 0.3) break;
      const nl = latLonToTileXY(fr.nearest.lat, fr.nearest.lon);
      await walkToward(s, id, nl.x, nl.y, frontKm);
    }
    ctx.sim.setClock('strategic');
  }
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

registerShot('command-peace', 'command', 'Take control at peace: a tank near Zaragoza in its own land (towns, roads, bases, no enemies)', async (s) => {
  await stage(s, PEACE);
  if (live(s)) return;
  const I = internalsOrThrow();
  await waitFramesUntil(s, () => I.civil.labels.length > 0, 600);
  await settle(s, I, 2);
  await freezeAndWait(s, I);
});

registerShot('command-border', 'command', 'Near the real border with a nation at peace: the painted border line, posts and the approach warning', async (s) => {
  // The human's border nearest to the Pyrenees in the staged world; the tank stops 1.5 km short of it, facing it.
  await stageBorder(s, UnitType.ArmoredDivision, 42.7, -0.5, 15.5, 1.5);
  if (live(s)) return;
  const I = internalsOrThrow();
  await settle(s, I, 1);
  await freezeAndWait(s, I);
});

registerShot('command-front', 'command', 'At a real front of a staged war: enemy infantry and armor derived from the front, real divisions nearby', async (s) => {
  await stageBorder(s, UnitType.ArmoredDivision, Number(s.params.get('lat') ?? 42.1), Number(s.params.get('lon') ?? -1.2), 16, 2.5, 200, (st, foe, b) => {
    // A real enemy division and a defense post on the far side of the line.
    st.ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: foe, tile: b.fy * MAP_W + b.fx, targetTile: -1 });
    st.ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.DefensePost, owner: foe, tile: b.fy * MAP_W + b.fx, level: 2 });
  }, Number(s.params.get('frontKm') ?? 0.4));
  if (live(s)) return;
  const I = internalsOrThrow();
  await settle(s, I, Number(s.params.get('fight') ?? 6));
  // Face the nearest enemy the crew can actually see (a clear line of sight over the terrain), through the gunner's
  // sight: at 1-2 km a soldier is a few pixels in the chase view, the sight shows the enemy line itself.
  const p = I.controller!.ent;
  const eye = p.pos.clone().setY(p.pos.y + 3);
  const visible = (e: Ent): boolean => {
    for (let k = 1; k < 24; k++) {
      const f = k / 24;
      const x = eye.x + (e.pos.x - eye.x) * f, z = eye.z + (e.pos.z - eye.z) * f;
      if (I.ground.heightAt(x, z) > eye.y + (e.pos.y + 1.5 - eye.y) * f) return false;
    }
    return true;
  };
  let foeEnt: Ent | null = null, bd = Infinity;
  for (const e of I.world.ents) {
    if (!e.alive || e.team !== 1 || e.neutral || !['tank', 'ifv', 'at', 'soldier'].includes(e.kind)) continue;
    const d = e.pos.distanceTo(p.pos);
    if (d < bd && d < 3500 && visible(e)) {
      bd = d;
      foeEnt = e;
    }
  }
  foeEnt ??= nearest(I, p.pos, 1, ['tank', 'ifv', 'at', 'soldier']);
  if (foeEnt && bd > 250 && bd < 3500) {
    // Drive up behind the own line to ~200 m from the enemy (local staging of what the player would do: the enemy
    // line is 1-2 km off, a few pixels in any view from where the division stands).
    const f = (bd - 200) / bd;
    p.pos.x += (foeEnt.pos.x - p.pos.x) * f;
    p.pos.z += (foeEnt.pos.z - p.pos.z) * f;
    p.pos.y = I.ground.heightAt(p.pos.x, p.pos.z);
    bd = 200;
  }
  if (foeEnt) {
    p.yaw = Math.atan2(-(foeEnt.pos.x - p.pos.x), -(foeEnt.pos.z - p.pos.z));
    I.controller!.aimAt(foeEnt.pos.clone().setY(foeEnt.pos.y + 1.2));
    if (bd > 100 && 'setZoom' in I.controller!) (I.controller as unknown as { setZoom(on: boolean): void }).setZoom(true);
  }
  I.simulate(45, 1 / 30);
  await s.waitFrames(6);
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
  // ~10 km off Málaga (inside the territorial waters), bow north toward the east-west coast.
  await stage(s, { unit: UnitType.Warship, lat: 36.62, lon: -4.35, hour: 17, ownRadius: 8 });
  if (live(s)) return;
  const I = internalsOrThrow();
  await settle(s, I, 2);
  await freezeAndWait(s, I);
});

/**
 * Walk the controlled unit `km` into the neighbour's land across the shared edge (a real incursion in the sim), then
 * let `ticks` strategic ticks run: the warning's grace, the interception and its arrival happen in them.
 */
async function crossAndWait(s: ShotContext, id: number, b: { hx: number; hy: number; fx: number; fy: number }, km: number, ticks: number): Promise<void> {
  const { ctx } = s;
  // `km` past the middle of the shared edge, straight across it (one legal step from 1 km short of the edge).
  const mx = (b.hx + b.fx) / 2 + 0.5, my = (b.hy + b.fy) / 2 + 0.5;
  const lat = 90 - (my / MAP_H) * 180;
  const kmX = TILE_KM * Math.cos((lat * Math.PI) / 180);
  const ex = mx + ((b.fx - b.hx) * km) / kmX, ey = my + ((b.fy - b.hy) * km) / TILE_KM;
  await walkToward(s, id, ex, ey, 0);
  await waitView(s, () => !!ctx.sim.view.command?.incursions.some((i) => i.unitId === id), 30_000);
  for (let i = 0; i < ticks; i++) await ctx.sim.fastForward(1);
  if (ticks > 0) await waitView(s, () => !!ctx.sim.view.command?.incursions.some((i) => i.unitId === id && !!i.qrf?.arrived), 30_000);
}

registerShot('command-escort', 'command', 'Incursion ignored: the neighbour\'s patrol APCs at their stations around the tank, the radio\'s last warning', async (s) => {
  const { ctx } = s;
  await startSession(s, -0.5, 15.5);
  const foe0 = nearestNation(s, 44.7, -0.5);
  if (foe0) connectNation(s, foe0, 43.25, -0.5);
  await waitView(s, () => !!humanBorder(s, 42.7, -0.5, foe0), 90_000);
  const b = humanBorder(s, 42.7, -0.5, foe0);
  if (!b) throw new Error('no border near the staging point');
  ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.DefensePost, owner: b.foe, tile: b.fy * MAP_W + b.fx, level: 1 });
  const id = await spawnNearEdge(s, UnitType.ArmoredDivision, b, 1);
  // One strategic tick (in 10 s steps): the 30 s grace, the patrol's ≤ 5 min drive, 30 s left of its last warning.
  await crossAndWait(s, id, b, 3, 1);
  // Hold the sim's clock from the first frame (the last warning is running) unless it is a live session.
  const I0 = commandInternals();
  if (I0 && (!live(s) || s.params.get('hold') === '1')) I0.freezeOnEnter = true;
  await ctx.app.enterCommandMode(id);
  ctx.sim.setSpeed(0);
  if (live(s)) return;
  const I = internalsOrThrow();

  await settle(s, I, Number(s.params.get('settle') ?? 6));
  // Look at the vehicle blocking the way.
  const p = I.controller!.ent;
  const q = I.world.ents.find((e) => e.alive && e.src?.kind === 'qrf' && e.slot.z < 0) ?? I.world.ents.find((e) => e.alive && e.src?.kind === 'qrf');
  if (q) I.controller!.aimAt(q.pos.clone().setY(q.pos.y + 1.5));
  I.simulate(20, 1 / 30);
  void p;
  await freezeAndWait(s, I);
});

registerShot('command-jet-intercept', 'command', 'Fighter in a neighbour\'s airspace at peace: its scrambled fighters on your wings, rocking theirs', async (s) => {
  const { ctx } = s;
  await startSession(s, -0.5, 16.5);
  const foe0 = nearestNation(s, 44.7, -0.5);
  if (foe0) connectNation(s, foe0, 43.25, -0.5);
  await waitView(s, () => !!humanBorder(s, 42.7, -0.5, foe0), 90_000);
  const b = humanBorder(s, 42.7, -0.5, foe0);
  if (!b) throw new Error('no border near the staging point');
  const ab = latLonToTile(43.6, -0.4);
  ctx.sim.debug({ type: 'conquer', playerId: b.foe, centerTile: ab, radius: 2 });
  ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.Airbase, owner: b.foe, tile: ab, level: 2 });
  ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.FighterSquadron, owner: b.foe, tile: ab, targetTile: -1 });
  await ctx.sim.fastForward(2);
  const id = await spawnNearEdge(s, UnitType.FighterSquadron, b, 1);
  // Cross, take control at once and let the real clock run: the 25 s grace, then the fighters' 1-3 min scramble.
  await crossAndWait(s, id, b, 3, 0);
  await ctx.app.enterCommandMode(id);
  ctx.sim.setSpeed(0);
  if (live(s)) return;
  const I = internalsOrThrow();
  await waitView(s, () => !!ctx.sim.view.command?.incursions.some((i) => i.unitId === id && !!i.qrf?.arrived), 400_000);
  I.freeze = true;
  // Let them form up on the wings (local time only; the sim's clock is held).
  I.skipIntro();
  I.simulate(Math.round(Number(s.params.get('settle') ?? 20) * 30), 1 / 30);
  await s.waitFrames(6);
});

registerShot('command-tank', 'command', 'Tank at a real front (the command-front staging, facing the nearest enemy)', async (s) => {
  await stageBorder(s, UnitType.ArmoredDivision, 42.7, -0.5, 16, 2, 200, (st, foe, b) => {
    st.ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: foe, tile: b.fy * MAP_W + b.fx, targetTile: -1 });
  }, 2);
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

/**
 * Criterion 11 (enemy aircraft only from real sources): a fighter over a front at war with both sources staged — a
 * fighter squadron of the enemy docked at its airbase ~95 km away (it scrambles), and another of its squadrons flying a
 * patrol ~40 km from the fighter (it covers the place). Nothing else may put an enemy aircraft in the sky.
 */
registerShot('command-jet-sources', 'command', 'Fighter at war: enemy jets only from a real airborne patrol and a scramble from a real airbase within 150 km', async (s) => {
  let base = -1;
  const foe = await stage(s, {
    unit: UnitType.FighterSquadron, lat: 42.4, lon: -0.6, hour: 17, ownRadius: 3, neighbour: { lat: 43.2, lon: -0.5, radius: 4 }, war: 160,
    before: (st, f) => {
      if (!f) return;
      base = latLonToTile(43.25, -0.4);
      st.ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.Airbase, owner: f, tile: base, level: 2 });
    },
  });
  const { ctx } = s;
  // The two sources, placed after the war ran so that the enemy's own AI has not flown them elsewhere yet.
  if (foe && base >= 0) {
    ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.FighterSquadron, owner: foe, tile: base, targetTile: -1 });
    ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.FighterSquadron, owner: foe, tile: base, targetTile: latLonToTile(42.7, -0.4) });
    await s.waitFrames(20);
  }
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
