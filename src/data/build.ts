// FRONT ULTRA — world build orchestration (owner: data). Pure & worker-safe: decoded pixels + topology JSON in,
// WorldData + WorldAux out. Runs inside src/data/worker.ts (normal path) or on the main thread (fallback), and
// in Node for offline verification.

import { MAP_H, MAP_W } from '../shared/constants';
import type { WorldData } from '../shared/types';
import { buildGrid, type StageFn } from './grid';
import { rasterizeCountries, type CountriesTopology } from './rasterize';
import type { WorldAux, WorldBuildStats } from './types';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA bytes. */
  data: Uint8Array | Uint8ClampedArray;
}

export interface WorldSources {
  /** earth-water.png, 1600x800 (white = water). */
  water: RgbaImage;
  /** earth-topology.png, 2048x1024 grayscale. */
  topo: RgbaImage;
  /** earth-blue-marble.jpg (any size, usually 4096x2048). */
  day: RgbaImage;
  /** earth-night.jpg (any size, usually 4096x2048). */
  night: RgbaImage;
  countries: CountriesTopology;
}

/** Resolution of WorldAux.day / WorldAux.lights (local terrain tint & urban density). */
export const AUX_W = 2048;
export const AUX_H = 1024;

export interface WorldBuildResult {
  world: WorldData;
  aux: Omit<WorldAux, 'relief'>;
}

/** Area-average (box) resample of an RGBA image to w x h, keeping `channels` channels (1 = luminance of RGB). */
export function boxResample(src: RgbaImage, w: number, h: number, channels: 1 | 3 | 4): Uint8Array {
  const out = new Uint8Array(w * h * channels);
  const sw = src.width, sh = src.height, d = src.data;
  const kx = sw / w, ky = sh / h;
  // Per destination column: source span [x0, x1) with fractional edge weights.
  const acc = new Float64Array(w * 4);
  const accW = new Float64Array(w);
  const colStart = new Int32Array(w), colEnd = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    colStart[x] = Math.floor(x * kx);
    colEnd[x] = Math.min(sw, Math.ceil((x + 1) * kx));
  }
  for (let y = 0; y < h; y++) {
    const fy0 = y * ky, fy1 = (y + 1) * ky;
    acc.fill(0);
    accW.fill(0);
    for (let sy = Math.floor(fy0); sy < Math.min(sh, Math.ceil(fy1)); sy++) {
      const wy = Math.min(fy1, sy + 1) - Math.max(fy0, sy);
      if (wy <= 0) continue;
      const row = sy * sw * 4;
      for (let x = 0; x < w; x++) {
        const fx0 = x * kx, fx1 = (x + 1) * kx;
        let r = 0, g = 0, b = 0, a = 0, ws = 0;
        for (let sx = colStart[x]; sx < colEnd[x]; sx++) {
          const wx = Math.min(fx1, sx + 1) - Math.max(fx0, sx);
          if (wx <= 0) continue;
          const o = row + sx * 4;
          r += d[o] * wx; g += d[o + 1] * wx; b += d[o + 2] * wx; a += d[o + 3] * wx;
          ws += wx;
        }
        acc[x * 4] += r * wy; acc[x * 4 + 1] += g * wy; acc[x * 4 + 2] += b * wy; acc[x * 4 + 3] += a * wy;
        accW[x] += ws * wy;
      }
    }
    for (let x = 0; x < w; x++) {
      const inv = accW[x] > 0 ? 1 / accW[x] : 0;
      const o = (y * w + x) * channels;
      const r = acc[x * 4] * inv, g = acc[x * 4 + 1] * inv, b = acc[x * 4 + 2] * inv;
      if (channels === 1) out[o] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      else {
        out[o] = Math.round(r); out[o + 1] = Math.round(g); out[o + 2] = Math.round(b);
        if (channels === 4) out[o + 3] = Math.round(acc[x * 4 + 3] * inv);
      }
    }
  }
  return out;
}

/** Red channel of an RGBA image at exactly w x h (resampled with a box filter when sizes differ). */
function grayOf(img: RgbaImage, w: number, h: number): Uint8Array {
  if (img.width === w && img.height === h) {
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4];
    return out;
  }
  const rgb = boxResample(img, w, h, 3);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = rgb[i * 3];
  return out;
}

export async function buildWorld(src: WorldSources, stage: StageFn = () => undefined, thread = 'main'): Promise<WorldBuildResult> {
  const timings: Record<string, number> = {};
  let t = now();
  const lap = (k: string) => {
    const n = now();
    timings[k] = Math.round((n - t) * 10) / 10;
    t = n;
  };

  const water = grayOf(src.water, MAP_W, MAP_H);
  const topoGray = grayOf(src.topo, src.topo.width, src.topo.height);
  const dayTile = boxResample(src.day, MAP_W, MAP_H, 3);
  lap('resampleTiles');
  await stage(0.05, 'data.water');

  const grid = await buildGrid(
    { water, topo: { width: src.topo.width, height: src.topo.height, data: topoGray }, dayTile },
    (f, l) => stage(0.05 + f * 0.6, l),
  );
  lap('grid');

  await stage(0.68, 'data.countries');
  const ras = rasterizeCountries(src.countries, grid.terrain, grid.landComp);
  lap('countries');
  await stage(0.88, 'data.aux');

  const day = { width: AUX_W, height: AUX_H, data: boxResample(src.day, AUX_W, AUX_H, 4) };
  const lights = { width: AUX_W, height: AUX_H, data: boxResample(src.night, AUX_W, AUX_H, 1) };
  lap('auxImages');

  const stats: WorldBuildStats = {
    landTiles: grid.landTiles,
    ...grid.stats,
    countries: ras.countries.length - 1,
    unassignedFilled: ras.unassignedFilled,
    capitalsOnOwnLand: ras.capitalsOnOwnLand,
    timings,
    thread,
    warnings: ras.warnings,
  };
  const world: WorldData = {
    width: MAP_W,
    height: MAP_H,
    terrain: grid.terrain,
    elevation: grid.elevation,
    country: ras.country,
    countries: ras.countries,
    landTiles: grid.landTiles,
    relief: grid.relief,
  };
  await stage(1, 'data.done');
  return {
    world,
    aux: { coastKm: grid.coastKm, detail: grid.detail, biome: grid.biome, waterFrac: grid.waterFrac, dayTile, day, lights, stats },
  };
}

/** Every typed-array buffer of a build result (for postMessage transfer). */
export function buildTransferables(r: WorldBuildResult): ArrayBuffer[] {
  const w = r.world, a = r.aux;
  const list = [w.terrain, w.elevation, w.country, w.relief.data, a.coastKm, a.detail, a.biome, a.waterFrac, a.dayTile, a.day.data, a.lights.data];
  const out: ArrayBuffer[] = [];
  for (const v of list) if (v.buffer instanceof ArrayBuffer && !out.includes(v.buffer)) out.push(v.buffer);
  return out;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

