// FRONT ULTRA — spatial indexes for the simulation (structures: incremental; units: rebuilt every tick).
// Owner: sim-core. Worker-only. Coordinates are continuous tile coords; x wraps around the planet.

import { MAP_H, MAP_W, TILE_KM } from '../shared/constants';

const SCELL = 32;
const SCW = MAP_W / SCELL;
const SCH = MAP_H / SCELL;

export interface Positioned {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** Bucketed index of static things (structures). */
export class StaticGrid<T extends Positioned> {
  private cells: T[][] = [];

  constructor() {
    for (let i = 0; i < SCW * SCH; i++) this.cells.push([]);
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(SCW - 1, Math.max(0, Math.floor(x / SCELL)));
    const cy = Math.min(SCH - 1, Math.max(0, Math.floor(y / SCELL)));
    return cy * SCW + cx;
  }

  add(item: T): void {
    this.cells[this.cellOf(item.x, item.y)].push(item);
  }

  remove(item: T): void {
    const c = this.cells[this.cellOf(item.x, item.y)];
    const i = c.indexOf(item);
    if (i >= 0) c.splice(i, 1);
  }

  /** Calls fn for each item within radius r of (x, y). Return true from fn to stop early. */
  query(x: number, y: number, r: number, fn: (item: T, d2: number) => boolean | void): void {
    const r2 = r * r;
    const cy0 = Math.max(0, Math.floor((y - r) / SCELL));
    const cy1 = Math.min(SCH - 1, Math.floor((y + r) / SCELL));
    const span = Math.min(SCW, Math.floor((2 * r) / SCELL) + 2);
    const cx0 = Math.floor((x - r) / SCELL);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let k = 0; k < span; k++) {
        const cx = (((cx0 + k) % SCW) + SCW) % SCW;
        const list = this.cells[cy * SCW + cx];
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          let dx = it.x - x;
          if (dx > MAP_W / 2) dx -= MAP_W;
          else if (dx < -MAP_W / 2) dx += MAP_W;
          const dy = it.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2 && fn(it, d2) === true) return;
        }
      }
    }
  }
}

const UCELL = 16;
const UCW = MAP_W / UCELL;
const UCH = MAP_H / UCELL;

/** Linked-list bucket grid rebuilt from scratch every tick (units move). */
export class DynamicGrid<T extends Positioned> {
  private head = new Int32Array(UCW * UCH).fill(-1);
  private next = new Int32Array(1024);
  private items: T[] = [];

  rebuild(list: Iterable<T>): void {
    this.head.fill(-1);
    this.items.length = 0;
    for (const it of list) {
      const i = this.items.length;
      this.items.push(it);
      if (i >= this.next.length) {
        const n = new Int32Array(this.next.length * 2);
        n.set(this.next);
        this.next = n;
      }
      const cx = Math.min(UCW - 1, Math.max(0, Math.floor(it.x / UCELL)));
      const cy = Math.min(UCH - 1, Math.max(0, Math.floor(it.y / UCELL)));
      const c = cy * UCW + cx;
      this.next[i] = this.head[c];
      this.head[c] = i;
    }
  }

  query(x: number, y: number, r: number, fn: (item: T, d2: number) => boolean | void): void {
    const r2 = r * r;
    const cy0 = Math.max(0, Math.floor((y - r) / UCELL));
    const cy1 = Math.min(UCH - 1, Math.floor((y + r) / UCELL));
    const span = Math.min(UCW, Math.floor((2 * r) / UCELL) + 2);
    const cx0 = Math.floor((x - r) / UCELL);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let k = 0; k < span; k++) {
        const cx = (((cx0 + k) % UCW) + UCW) % UCW;
        for (let i = this.head[cy * UCW + cx]; i >= 0; i = this.next[i]) {
          const it = this.items[i];
          let dx = it.x - x;
          if (dx > MAP_W / 2) dx -= MAP_W;
          else if (dx < -MAP_W / 2) dx += MAP_W;
          const dy = it.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2 && fn(it, d2) === true) return;
        }
      }
    }
  }
}

/** Signed shortest dx (b - a) with wrap. */
export function wdx(ax: number, bx: number): number {
  let d = bx - ax;
  if (d > MAP_W / 2) d -= MAP_W;
  else if (d < -MAP_W / 2) d += MAP_W;
  return d;
}

export function wrapXf(x: number): number {
  return x < 0 ? x + MAP_W : x >= MAP_W ? x - MAP_W : x;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = wdx(ax, bx), dy = by - ay;
  return dx * dx + dy * dy;
}

/** Surface distance in equatorial-tile units (x shrinks with cos(latitude)) — used for blast radii. */
export function surfDist2(ax: number, ay: number, bx: number, by: number): number {
  const lat = (90 - ((ay + by) * 0.5 / MAP_H) * 180) * (Math.PI / 180);
  const dx = wdx(ax, bx) * Math.cos(lat), dy = by - ay;
  return dx * dx + dy * dy;
}

// --- v2 (W1): metric movement (DESIGN_V2 §2.5) -----------------------------------------------------------------
// Tiles are 25.0 km north–south everywhere and 25.0·cos(lat) km east–west. Every mover advances a number of
// KILOMETRES per tick toward its target in the local metric, so a unit's speed in km/h is the same at every latitude.

const DEG_TO_RAD = Math.PI / 180;

/** cos(latitude) at tile row y (continuous), floored at 0.2 so polar moves stay finite. */
export function latCos(y: number): number {
  return Math.max(0.2, Math.cos((90 - (y / MAP_H) * 180) * DEG_TO_RAD));
}

/** Local-metric distance in km between two tile-space points (fine up to a few hundred km). */
export function distKm(ax: number, ay: number, bx: number, by: number): number {
  const c = latCos((ay + by) * 0.5);
  const dx = wdx(ax, bx) * TILE_KM * c, dy = (by - ay) * TILE_KM;
  return Math.sqrt(dx * dx + dy * dy);
}

export interface Mover {
  x: number;
  y: number;
  heading: number;
}

/**
 * Move `u` toward (tx, ty) by `km` kilometres in the local metric: a step of s km along the heading θ moves
 * (s·sinθ / (TILE_KM·cos φ), −s·cosθ / TILE_KM) in tile coordinates (x east, y south). Updates the heading
 * (0 = north, π/2 = east). Returns true on arrival (the unit is then exactly on the target).
 */
export function advanceKm(u: Mover, tx: number, ty: number, km: number): boolean {
  const c = latCos(u.y);
  const ex = wdx(u.x, tx) * TILE_KM * c; // km east
  const ny = (u.y - ty) * TILE_KM; // km north
  const d = Math.sqrt(ex * ex + ny * ny);
  if (d > 1e-9) u.heading = Math.atan2(ex, ny);
  if (d <= km) {
    u.x = wrapXf(tx);
    u.y = ty;
    return true;
  }
  const f = km / d;
  u.x = wrapXf(u.x + (ex * f) / (TILE_KM * c));
  u.y -= (ny * f) / TILE_KM;
  if (u.y < 0) u.y = 0;
  else if (u.y > MAP_H - 1e-3) u.y = MAP_H - 1e-3;
  return false;
}
