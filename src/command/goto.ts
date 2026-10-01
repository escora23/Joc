// FRONT ULTRA — command mode: getting to the action (owner feedback #3, item 26; owner: command).
//
// Where the fighting is, seen from the controlled unit, and how to get there. Pure functions over the sim view:
//   combatTargets()  the nearest place to fight (an enemy unit at war, the live contact of an offensive, the nearest
//                    point of a front line at war, an enemy port for a warship) and the unit's own mission target (the
//                    offensive it joined, the structure it assaults, the sector it defends). The HUD marker, «Ir al
//                    combate» (G) and the far transit all read these, so the three always agree.
//   planRoute()      a route by own or friendly land (water for a warship, open or friendly sky for a fighter) from the
//                    unit to `stopKm` short of a target, never through a nation at peace: a straight line when it is
//                    clear, else a breadth-first search over the tiles around.
// Distances are in km on the local metric of the sim's tile grid (the same as the sim's controlledMove check).

import { HUMAN_ID, MAP_H, MAP_W, TILE_KM } from '../shared/constants';
import type { GameView } from '../shared/api';
import { deriveLocalForces } from '../shared/localForces';
import { StructureType, UNIT_ORDER_KINDS, UnitMode, UnitType, type CommandKind, type UnitView } from '../shared/types';

const DEG = Math.PI / 180;

export function wdx(ax: number, bx: number): number {
  let d = bx - ax;
  if (d > MAP_W / 2) d -= MAP_W;
  else if (d < -MAP_W / 2) d += MAP_W;
  return d;
}

function kmPerTileX(y: number): number {
  return TILE_KM * Math.max(0.05, Math.cos((90 - (y / MAP_H) * 180) * DEG));
}

/** Distance (km) between two points in continuous tile coords. */
export function tileKm(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(wdx(ax, bx) * kmPerTileX((ay + by) / 2), (by - ay) * TILE_KM);
}

/** Compass bearing (deg, 0 = north, clockwise) from a to b in tile coords. */
export function tileBearing(ax: number, ay: number, bx: number, by: number): number {
  const e = wdx(ax, bx) * kmPerTileX((ay + by) / 2), n = -(by - ay) * TILE_KM;
  return (Math.atan2(e, n) / DEG + 360) % 360;
}

export type TargetKind = 'battle' | 'front' | 'unit' | 'port' | 'mission';

export interface CombatTarget {
  kind: TargetKind;
  /** Continuous tile coords of the place. */
  tx: number;
  ty: number;
  km: number;
  /** The enemy there (0 = none known). */
  owner: number;
  /** For 'unit': the enemy unit; for 'mission': the order kind. */
  unitId?: number;
  order?: string;
  /** For a mission on a structure: its id. */
  structureId?: number;
  /** For a front: its key. */
  frontKey?: number;
}

export interface Targets {
  nearest: CombatTarget | null;
  mission: CombatTarget | null;
}

/** A nation at war with the human. */
export function atWar(view: GameView, o: number): boolean {
  return o > 0 && o !== HUMAN_ID && view.pairState(HUMAN_ID, o) === 'war';
}

/**
 * The nearest place to fight for a unit of `kind` at (ux, uy), and its mission's target. `unit` is the controlled
 * unit's view (its order and mission).
 */
export function combatTargets(view: GameView, ux: number, uy: number, kind: CommandKind, unit: UnitView | null): Targets {
  let best: CombatTarget | null = null;
  const offer = (c: CombatTarget) => {
    // An offensive's live contact is where the fighting is: it wins over a plain line point up to 25 % farther.
    const score = (x: CombatTarget) => x.km * (x.kind === 'battle' ? 0.8 : 1);
    if (!best || score(c) < score(best)) best = c;
  };
  // Offensives touching the human (either side): their live contact.
  for (const a of view.attacks) {
    if (a.naval || a.contactX < 0) continue;
    const foe = a.attacker === HUMAN_ID ? a.defender : a.defender === HUMAN_ID ? a.attacker : 0;
    if (!foe || !atWar(view, foe)) continue;
    if (kind === 'ship') continue;
    offer({ kind: 'battle', tx: a.contactX, ty: a.contactY, km: tileKm(ux, uy, a.contactX, a.contactY), owner: foe, frontKey: a.frontKey });
  }
  // Fronts at war: the nearest point of the contact line.
  if (kind !== 'ship') {
    for (const f of view.fronts) {
      const foe = f.a === HUMAN_ID ? f.b : f.b === HUMAN_ID ? f.a : 0;
      if (!foe || !atWar(view, foe)) continue;
      // Samples are the centres of side a's contact tiles: the contact edge is half a tile along the advance.
      const s = f.samples;
      for (let i = 0; i + 1 < s.length; i += 2) {
        const cx = s[i] + f.dirX * 0.5, cy = s[i + 1] + f.dirY * 0.5;
        const km = tileKm(ux, uy, cx, cy);
        if (!best || km < (best as CombatTarget).km) offer({ kind: 'front', tx: cx, ty: cy, km, owner: foe, frontKey: f.key });
      }
    }
  }
  // Near a front, the one derivation of the local line (shared/localForces: the sub-tile line the battle view and the
  // command scene draw) gives the exact nearest point of it.
  // For an offensive, the line where its contact is; for a front, the point of its line nearest the unit.
  const b0 = best as CombatTarget | null;
  if (b0 && b0.frontKey && (b0.kind === 'front' || b0.kind === 'battle') && b0.km < 400) {
    const battle = b0.kind === 'battle';
    const ax = battle ? b0.tx : ux, ay = battle ? b0.ty : uy;
    const lf = deriveLocalForces(view, ax, ay, battle ? 30 : Math.min(250, Math.max(30, b0.km + 15)), HUMAN_ID);
    const fr = lf.fronts.find((q) => q.key === b0.frontKey);
    if (fr) best = { ...b0, tx: fr.nearest.x, ty: fr.nearest.y, km: tileKm(ux, uy, fr.nearest.x, fr.nearest.y) };
  }
  // Enemy units the vehicle can fight.
  for (const u of view.units.values()) {
    if (!atWar(view, u.owner) || !(u.hp > 0)) continue;
    const fits = kind === 'tank' ? u.type === UnitType.ArmoredDivision
      : kind === 'ship' ? u.type === UnitType.Warship
        : (u.type === UnitType.FighterSquadron || u.type === UnitType.Bomber || u.type === UnitType.DroneSwarm) && u.mode !== UnitMode.Docked && u.mode !== UnitMode.Rearming;
    if (!fits) continue;
    offer({ kind: 'unit', tx: u.x, ty: u.y, km: tileKm(ux, uy, u.x, u.y), owner: u.owner, unitId: u.id });
  }
  // A warship: enemy ports and naval yards.
  if (kind === 'ship') {
    for (const s of view.structures.values()) {
      if ((s.type !== StructureType.Port && s.type !== StructureType.NavalYard) || !atWar(view, s.owner)) continue;
      const x = (s.tile % MAP_W) + 0.5, y = Math.floor(s.tile / MAP_W) + 0.5;
      offer({ kind: 'port', tx: x, ty: y, km: tileKm(ux, uy, x, y), owner: s.owner, structureId: s.id });
    }
  }
  return { nearest: best, mission: missionTarget(view, ux, uy, unit) };
}

/** The target of the unit's current mission (join / assault / raze / defend / attack / blockade), null = none. */
export function missionTarget(view: GameView, ux: number, uy: number, unit: UnitView | null): CombatTarget | null {
  if (!unit || unit.order < 0) return null;
  const order = UNIT_ORDER_KINDS[unit.order];
  const m = unit.mission ?? 0;
  if (order === 'join' && m > 0) {
    const a = view.attacks.find((x) => x.id === m);
    if (!a) return null;
    const x = a.contactX >= 0 ? a.contactX : a.x, y = a.contactX >= 0 ? a.contactY : a.y;
    return { kind: 'mission', order, tx: x, ty: y, km: tileKm(ux, uy, x, y), owner: a.attacker === HUMAN_ID ? a.defender : a.attacker, frontKey: a.frontKey || undefined };
  }
  if ((order === 'assault' || order === 'raze' || order === 'blockade' || order === 'bombard') && m > 0) {
    const s = view.structures.get(m);
    if (!s) return null;
    const x = (s.tile % MAP_W) + 0.5, y = Math.floor(s.tile / MAP_W) + 0.5;
    return { kind: 'mission', order, tx: x, ty: y, km: tileKm(ux, uy, x, y), owner: s.owner, structureId: s.id };
  }
  if (order === 'defend' && m < 0) {
    const tile = -m - 1;
    const x = (tile % MAP_W) + 0.5, y = Math.floor(tile / MAP_W) + 0.5;
    return { kind: 'mission', order, tx: x, ty: y, km: tileKm(ux, uy, x, y), owner: 0 };
  }
  if ((order === 'attack' || order === 'move') && unit.targetX >= 0 && (unit.targetX !== unit.x || unit.targetY !== unit.y)) {
    return { kind: 'mission', order, tx: unit.targetX, ty: unit.targetY, km: tileKm(ux, uy, unit.targetX, unit.targetY), owner: 0 };
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------------------------------

export interface Route {
  /** Points in continuous tile coords, start first, the stop point last. */
  pts: { x: number; y: number }[];
  km: number;
}

const tileAt = (x: number, y: number): number => Math.max(0, Math.min(MAP_H - 1, Math.floor(y))) * MAP_W + (((Math.floor(x) % MAP_W) + MAP_W) % MAP_W);

/** Whether the straight segment a→b only crosses passable tiles (samples every ~5 km). */
function clear(ax: number, ay: number, bx: number, by: number, ok: (tile: number) => boolean): boolean {
  const km = tileKm(ax, ay, bx, by);
  const n = Math.max(1, Math.ceil(km / 5));
  const dx = wdx(ax, bx);
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    if (!ok(tileAt(ax + dx * f, ay + (by - ay) * f))) return false;
  }
  return true;
}

/** The point `km` short of (tx, ty) along the line from (ux, uy). */
function shortOf(ux: number, uy: number, tx: number, ty: number, km: number): { x: number; y: number } {
  const L = tileKm(ux, uy, tx, ty);
  if (L <= km) return { x: ux, y: uy };
  const f = (L - km) / L;
  return { x: ux + wdx(ux, tx) * f, y: uy + (ty - uy) * f };
}

/**
 * A route from (ux, uy) to `stopKm` short of (tx, ty) over passable tiles. The start tile always counts as passable.
 * Null when no such route exists within `maxKm` of travel.
 */
export function planRoute(ux: number, uy: number, tx: number, ty: number, stopKm: number, passable: (tile: number) => boolean, maxKm = 1500): Route | null {
  const start = tileAt(ux, uy);
  const ok = (tile: number) => tile === start || passable(tile);
  // 1. Straight.
  const stop = shortOf(ux, uy, tx, ty, stopKm);
  if (clear(ux, uy, stop.x, stop.y, ok)) return { pts: [{ x: ux, y: uy }, stop], km: tileKm(ux, uy, stop.x, stop.y) };
  // 2. Breadth-first over the tiles (8 neighbours) within reach; the reached tile nearest the target, not closer than
  // stopKm, ends the route.
  const R = Math.min(90, Math.ceil(maxKm / TILE_KM) + 2);
  const cx = Math.floor(ux), cy = Math.floor(uy);
  const size = 2 * R + 1;
  const prev = new Int32Array(size * size).fill(-2);
  const key = (x: number, y: number) => (y - cy + R) * size + (x - cx + R);
  const q: number[] = [cx, cy];
  prev[key(cx, cy)] = -1;
  let bestK = key(cx, cy), bestD = tileKm(cx + 0.5, cy + 0.5, tx, ty);
  for (let h = 0; h < q.length; h += 2) {
    const x = q[h], y = q[h + 1];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (ny < 0 || ny >= MAP_H || Math.abs(nx - cx) > R || Math.abs(ny - cy) > R) continue;
        const k = key(nx, ny);
        if (prev[k] !== -2) continue;
        if (!ok(tileAt(nx, ny))) {
          prev[k] = -3;
          continue;
        }
        // Diagonal steps only between two passable sides (no corner cutting across water or a closed border).
        if (dx && dy && (!ok(tileAt(x + dx, y)) || !ok(tileAt(x, y + dy)))) continue;
        prev[k] = key(x, y);
        q.push(nx, ny);
        const d = tileKm(nx + 0.5, ny + 0.5, tx, ty);
        if (d < bestD && d >= stopKm * 0.5) {
          bestD = d;
          bestK = k;
        }
      }
    }
  }
  if (bestK === key(cx, cy)) return null;
  const chain: { x: number; y: number }[] = [];
  for (let k = bestK; k >= 0; k = prev[k]) {
    const x = (k % size) - R + cx, y = Math.floor(k / size) - R + cy;
    chain.push({ x: x + 0.5, y: y + 0.5 });
    if (prev[k] === -1) break;
  }
  chain.reverse();
  chain[0] = { x: ux, y: uy };
  // The last stretch toward the target where it is clear.
  const last = chain[chain.length - 1];
  const end = shortOf(last.x, last.y, tx, ty, stopKm);
  if (clear(last.x, last.y, end.x, end.y, ok)) chain.push(end);
  // Straighten: skip points while the line stays clear.
  const pts: { x: number; y: number }[] = [chain[0]];
  let i = 0;
  while (i < chain.length - 1) {
    let j = chain.length - 1;
    while (j > i + 1 && !clear(chain[i].x, chain[i].y, chain[j].x, chain[j].y, ok)) j--;
    pts.push(chain[j]);
    i = j;
  }
  let km = 0;
  for (let k = 1; k < pts.length; k++) km += tileKm(pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y);
  return km <= maxKm ? { pts, km } : null;
}

/** The point `km` along a route (tile coords) and the heading there (rad, 0 north, clockwise). */
export function alongRoute(r: Route, km: number): { x: number; y: number; heading: number; done: boolean } {
  let left = Math.max(0, km);
  for (let k = 1; k < r.pts.length; k++) {
    const a = r.pts[k - 1], b = r.pts[k];
    const L = tileKm(a.x, a.y, b.x, b.y);
    const heading = tileBearing(a.x, a.y, b.x, b.y) * DEG;
    if (left <= L || k === r.pts.length - 1) {
      const f = L > 0 ? Math.min(1, left / L) : 1;
      return { x: a.x + wdx(a.x, b.x) * f, y: a.y + (b.y - a.y) * f, heading, done: k === r.pts.length - 1 && left >= L };
    }
    left -= L;
  }
  const p = r.pts[r.pts.length - 1];
  return { x: p.x, y: p.y, heading: 0, done: true };
}

/** How far along a route (km) the point (x, y) is: its projection on the nearest leg. */
export function routeProgress(r: Route, x: number, y: number): number {
  let best = Infinity, at = 0, acc = 0;
  for (let k = 1; k < r.pts.length; k++) {
    const a = r.pts[k - 1], b = r.pts[k];
    const kx = kmPerTileX((a.y + b.y) / 2);
    const bx = wdx(a.x, b.x) * kx, by = (b.y - a.y) * TILE_KM;
    const px = wdx(a.x, x) * kx, py = (y - a.y) * TILE_KM;
    const L2 = bx * bx + by * by;
    const f = L2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
    const d = Math.hypot(px - bx * f, py - by * f);
    const L = Math.sqrt(L2);
    if (d < best) {
      best = d;
      at = acc + L * f;
    }
    acc += L;
  }
  return at;
}
