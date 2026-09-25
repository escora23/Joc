// FRONT ULTRA — AI spatial helpers (owner: sim-ai). Worker-only, deterministic.
//
// Built once per game from the static terrain: an index of coastal land tiles bucketed in coarse cells (naval
// invasions look for landing beaches without scanning the map), plus small allocation-light helpers to sample a
// nation's territory (interior tiles for factories and silos, border tiles for defense posts).

import { MAP_H, MAP_W, TILE_COUNT } from '../../shared/constants';
import type { Rng } from '../../shared/rng';
import type { SimGame } from '../../shared/simapi';

export const CELL = 20;
export const CELLS_X = Math.ceil(MAP_W / CELL);
export const CELLS_Y = Math.ceil(MAP_H / CELL);

export const tx = (t: number): number => t % MAP_W;
export const ty = (t: number): number => (t / MAP_W) | 0;

/** Wrapped tile index (x wraps, y clamps -> -1 when outside). */
export function tileAt(x: number, y: number): number {
  const yi = Math.round(y);
  if (yi < 0 || yi >= MAP_H) return -1;
  const xi = ((Math.round(x) % MAP_W) + MAP_W) % MAP_W;
  return yi * MAP_W + xi;
}

/** Squared wrapped distance in tiles. */
export function dist2(a: number, b: number): number {
  let dx = Math.abs(tx(a) - tx(b));
  if (dx > MAP_W / 2) dx = MAP_W - dx;
  const dy = ty(a) - ty(b);
  return dx * dx + dy * dy;
}

export class MapIndex {
  /** Coastal playable land tiles, grouped by cell: cellStart[c]..cellStart[c+1] in `coast`. */
  readonly coast: Int32Array;
  readonly cellStart: Int32Array;
  /** Latitude-band friendly list of all playable tiles (for random picks). */
  readonly playable: Int32Array;

  constructor(private readonly g: SimGame) {
    const counts = new Int32Array(CELLS_X * CELLS_Y + 1);
    let nCoast = 0, nPlay = 0;
    for (let t = 0; t < TILE_COUNT; t++) {
      if (!g.isPlayable(t)) continue;
      nPlay++;
      if (g.isShore(t)) {
        nCoast++;
        counts[cellOf(t)]++;
      }
    }
    this.cellStart = new Int32Array(CELLS_X * CELLS_Y + 1);
    let acc = 0;
    for (let c = 0; c < CELLS_X * CELLS_Y; c++) {
      this.cellStart[c] = acc;
      acc += counts[c];
    }
    this.cellStart[CELLS_X * CELLS_Y] = acc;
    this.coast = new Int32Array(nCoast);
    this.playable = new Int32Array(nPlay);
    const fill = this.cellStart.slice();
    let k = 0;
    for (let t = 0; t < TILE_COUNT; t++) {
      if (!g.isPlayable(t)) continue;
      this.playable[k++] = t;
      if (g.isShore(t)) this.coast[fill[cellOf(t)]++] = t;
    }
  }

  /** Random coastal land tile in a cell (or -1). */
  coastInCell(cx: number, cy: number, rng: Rng): number {
    if (cy < 0 || cy >= CELLS_Y) return -1;
    const c = cy * CELLS_X + (((cx % CELLS_X) + CELLS_X) % CELLS_X);
    const a = this.cellStart[c], b = this.cellStart[c + 1];
    if (b <= a) return -1;
    return this.coast[a + rng.int(b - a)];
  }

  /** A random coastal land tile within `radius` tiles of `center` (tries a few cells), or -1. */
  randomCoastNear(center: number, radius: number, minRadius: number, rng: Rng): number {
    const cx = tx(center), cy = ty(center);
    for (let k = 0; k < 10; k++) {
      const a = rng.next() * Math.PI * 2;
      const r = minRadius + Math.sqrt(rng.next()) * Math.max(1, radius - minRadius);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.75;
      const t = this.coastInCell(Math.floor(x / CELL), Math.floor(y / CELL), rng);
      if (t >= 0) return t;
    }
    return -1;
  }

  randomPlayable(rng: Rng): number {
    return this.playable[rng.int(this.playable.length)];
  }
}

function cellOf(t: number): number {
  return Math.floor(ty(t) / CELL) * CELLS_X + Math.floor(tx(t) / CELL);
}

/** A tile owned by `pid` near `center` (random disc sampling), or -1. */
export function ownTileNear(g: SimGame, pid: number, center: number, radius: number, rng: Rng, tries = 24): number {
  const cx = tx(center), cy = ty(center);
  for (let k = 0; k < tries; k++) {
    const a = rng.next() * Math.PI * 2;
    const r = Math.sqrt(rng.next()) * radius;
    const t = tileAt(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    if (t >= 0 && g.ownerOf(t) === pid) return t;
  }
  return -1;
}

/**
 * How deep inside `pid`'s territory a tile is: the smallest radius (probing 8 directions at 2, 4, 8, 16 tiles)
 * that reaches foreign land or water. 0 on the border.
 */
export function depthOf(g: SimGame, pid: number, t: number): number {
  const x = tx(t), y = ty(t);
  let depth = 0;
  for (const r of PROBE_R) {
    for (let k = 0; k < 8; k++) {
      const u = tileAt(x + DIRS[k * 2] * r, y + DIRS[k * 2 + 1] * r);
      if (u < 0 || g.ownerOf(u) !== pid) return depth;
    }
    depth = r;
  }
  return depth;
}

const PROBE_R = [2, 4, 8, 16];
const DIRS = [1, 0, 0.707, 0.707, 0, 1, -0.707, 0.707, -1, 0, -0.707, -0.707, 0, -1, 0.707, -0.707];

/** Fraction of sample points in a disc owned by `pid` or its allies (nuke safety checks). */
export function friendlyShare(g: SimGame, pid: number, center: number, radius: number): number {
  const cx = tx(center), cy = ty(center);
  let own = 0, n = 0;
  for (let ring = 1; ring <= 3; ring++) {
    const r = (radius * ring) / 3;
    const steps = 6 * ring;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const t = tileAt(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      if (t < 0 || !g.isPlayable(t)) continue;
      n++;
      const o = g.ownerOf(t);
      if (o === pid || (o !== 0 && g.isAllied(pid, o))) own++;
    }
  }
  return n === 0 ? 0 : own / n;
}

/** Share of land sample points in a disc owned by `target` (how much of the blast lands on the victim). */
export function ownerShare(g: SimGame, target: number, center: number, radius: number): number {
  const cx = tx(center), cy = ty(center);
  let hit = 0, n = 0;
  for (let ring = 1; ring <= 3; ring++) {
    const r = (radius * ring) / 3;
    const steps = 6 * ring;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const t = tileAt(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      if (t < 0) continue;
      n++;
      if (g.ownerOf(t) === target) hit++;
    }
  }
  return n === 0 ? 0 : hit / n;
}

/** Iterates a live Set once, handing out ~`k` evenly spread random elements (reservoir-free, O(size)). */
export function sampleSet(set: ReadonlySet<number>, k: number, rng: Rng, out: number[]): number[] {
  out.length = 0;
  const n = set.size;
  if (n === 0 || k <= 0) return out;
  if (n <= k) {
    for (const t of set) out.push(t);
    return out;
  }
  const step = n / k;
  let next = rng.next() * step;
  let i = 0;
  for (const t of set) {
    if (i >= next) {
      out.push(t);
      next += step;
      if (out.length >= k) break;
    }
    i++;
  }
  return out;
}
