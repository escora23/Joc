// FRONT ULTRA — land components of the world grid, computed once per world on the client (owner: globe).
// DESIGN_V2 §10.6 / §14.9: 4-connected playable tiles form components; the ones of ≤ SMALL_ISLAND_TILES tiles
// (about 480 of 557) are the "small islands" that get a screen-space marker (islands.ts), a white shoreline in
// the ground shader (territory flag) and a hover line. Pure data, no three.js.

import { MAP_H, MAP_W, TILE_COUNT } from '../../shared/constants';
import { isNavigableTerrain, isPlayableTerrain } from '../../shared/terrain';
import type { WorldData } from '../../shared/types';

/** Components up to this many tiles are "small islands". */
export const SMALL_ISLAND_TILES = 20;

export interface LandComponent {
  id: number;
  /** Number of tiles. */
  size: number;
  /** First tile of the component (a stable representative). */
  tile: number;
  /** Tiles of the component (only kept for small components). */
  tiles: Int32Array | null;
  /** Centroid in continuous tile coordinates (x may exceed MAP_W across the date line; wrap before use). */
  cx: number;
  cy: number;
  /** Radius of the component around its centroid, in tiles (at least 0.5). */
  radius: number;
}

export interface LandComponents {
  /** Component id per tile (-1 = not playable land). */
  compOf: Int32Array;
  list: LandComponent[];
  /** Small islands: components of ≤ SMALL_ISLAND_TILES tiles in the sea (see the filter below). */
  small: LandComponent[];
}

const cache = new WeakMap<WorldData, LandComponents>();

export function landComponents(world: WorldData): LandComponents {
  const hit = cache.get(world);
  if (hit) return hit;
  const compOf = new Int32Array(TILE_COUNT).fill(-1);
  const list: LandComponent[] = [];
  const small: LandComponent[] = [];
  const stack = new Int32Array(TILE_COUNT);
  const tmp: number[] = [];
  const terrain = world.terrain;
  for (let start = 0; start < TILE_COUNT; start++) {
    if (compOf[start] >= 0 || !isPlayableTerrain(terrain[start])) continue;
    const id = list.length;
    let sp = 0;
    stack[sp++] = start;
    compOf[start] = id;
    tmp.length = 0;
    // Centroid with the date line handled: x relative to the start tile, unwrapped.
    const x0 = start % MAP_W;
    let sx = 0, sy = 0, n = 0;
    while (sp > 0) {
      const t = stack[--sp];
      const x = t % MAP_W, y = (t / MAP_W) | 0;
      let dx = x - x0;
      if (dx > MAP_W / 2) dx -= MAP_W;
      else if (dx < -MAP_W / 2) dx += MAP_W;
      sx += dx + 0.5;
      sy += y + 0.5;
      n++;
      if (tmp.length <= SMALL_ISLAND_TILES) tmp.push(t);
      const push = (nt: number) => {
        if (compOf[nt] < 0 && isPlayableTerrain(terrain[nt])) {
          compOf[nt] = id;
          stack[sp++] = nt;
        }
      };
      push(y * MAP_W + ((x + 1) % MAP_W));
      push(y * MAP_W + ((x + MAP_W - 1) % MAP_W));
      if (y > 0) push(t - MAP_W);
      if (y < MAP_H - 1) push(t + MAP_W);
    }
    const cx = x0 + sx / n, cy = sy / n;
    let r2 = 0;
    if (n <= SMALL_ISLAND_TILES) {
      for (const t of tmp) {
        let dx = (t % MAP_W) + 0.5 - cx;
        dx -= MAP_W * Math.round(dx / MAP_W);
        const dy = ((t / MAP_W) | 0) + 0.5 - cy;
        r2 = Math.max(r2, dx * dx + dy * dy);
      }
    }
    const c: LandComponent = {
      id, size: n, tile: start, tiles: n <= SMALL_ISLAND_TILES ? Int32Array.from(tmp) : null,
      cx, cy, radius: Math.max(0.5, Math.sqrt(r2) + 0.5),
    };
    list.push(c);
    if (n <= SMALL_ISLAND_TILES) small.push(c);
  }
  // A small component is an island (marker, shoreline) only when it lies in the sea: it touches ocean water through a
  // side (4-neighbourhood, the Navigable flag). Land specks enclosed by lake tiles (salt pans and dry lakes in the water
  // mask across the Sahara, Arabia and the Sahel) would otherwise scatter hundreds of meaningless rings over the
  // continents. Specks that touch a larger coast only diagonally ARE islands: the sim is 4-connected, so they can only
  // be taken by sea, and the player must see them (FEEDBACK-1 #6).
  const islands = small.filter((c) => {
    for (const t of c.tiles!) {
      const x = t % MAP_W, y = (t / MAP_W) | 0;
      if (isNavigableTerrain(terrain[y * MAP_W + ((x + 1) % MAP_W)]) || isNavigableTerrain(terrain[y * MAP_W + ((x + MAP_W - 1) % MAP_W)])) return true;
      if (y > 0 && isNavigableTerrain(terrain[t - MAP_W])) return true;
      if (y < MAP_H - 1 && isNavigableTerrain(terrain[t + MAP_W])) return true;
    }
    return false;
  });
  small.length = 0;
  small.push(...islands);
  const res = { compOf, list, small };
  cache.set(world, res);
  return res;
}
