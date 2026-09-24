// FRONT ULTRA — local high-resolution terrain around any point on Earth (owner: data). Main thread or worker.
//
// buildLocalHeightfield(): a res x res vertex grid spanning sizeKm around lat/lon built from
//   * the real NASA relief (bilinear) — so the local terrain matches the globe at large scale,
//   * deterministic fractal detail on a FIXED global wavelength ladder (20 km ... 2.5 m) evaluated with 3D simplex
//     noise at the true position on the sphere: the same place always gets the same hills, whatever the patch
//     center, size or resolution. Ridged noise dominates in mountains, gentle fBm in plains,
//   * the cleaned NASA water mask (bilinear + noise-perturbed shoreline) carved below sea level,
//   * a splat / biome classification (sand, grass, forest, rock, snow, urban, dirt, wet) from the per-tile biome
//     (Blue Marble color + latitude), elevation vs. the latitude-dependent snow & tree lines, slope, shoreline and the
//     Black Marble city lights, broken into natural patches (fields and woods, scree, snowfields, city blocks).
// Speed: low octaves are evaluated on a 4x coarser grid and upsampled; 2 octaves per sample at full rate;
// all per-column / per-row lookups are precomputed. ~15-25 ms for 256x256 on a laptop.

import { EARTH_RADIUS_KM, MAP_H, MAP_W } from '../shared/constants';
import { DEG } from '../shared/geo';
import type { WorldData } from '../shared/types';
import { Simplex3 } from './noise';
import { Biome, SplatBiome, type LocalHeightfield, type LocalHeightfieldOptions, type WorldAux } from './types';

const R_M = EARTH_RADIUS_KM * 1000;
const M_PER_DEG = R_M * DEG;
/** Global wavelength ladder: octave k has wavelength LADDER0 / 2^k meters. */
const LADDER0 = 20480;
const MAX_OCT = 14;
const PERSIST = 0.6;
const FBM_NORM = (1 - PERSIST) / (1 - Math.pow(PERSIST, MAX_OCT));
const OCT_INV = new Float64Array(MAX_OCT);
const OCT_AMP = new Float64Array(MAX_OCT);
for (let k = 0; k < MAX_OCT; k++) {
  OCT_INV[k] = Math.pow(2, k) / LADDER0;
  OCT_AMP[k] = Math.pow(PERSIST, k);
}

/**
 * Land-cover mix per tile Biome: [sand, grass, forest, rock, snow, urban, dirt, wet] target coverage.
 * Patches are then drawn with noise thresholds so e.g. a Forest tile is ~60% woods and ~35% clearings.
 */
const COVER: Record<number, number[]> = {
  [Biome.Water]: [0.2, 0.4, 0.1, 0, 0, 0, 0.1, 0.2],
  [Biome.Desert]: [0.86, 0, 0, 0.06, 0, 0, 0.08, 0],
  [Biome.Steppe]: [0.12, 0.43, 0.02, 0.03, 0, 0, 0.4, 0],
  [Biome.Grassland]: [0.01, 0.66, 0.24, 0.01, 0, 0, 0.08, 0],
  [Biome.Savanna]: [0.05, 0.58, 0.14, 0.01, 0, 0, 0.22, 0],
  [Biome.Forest]: [0, 0.34, 0.6, 0.02, 0, 0, 0.04, 0],
  [Biome.Taiga]: [0, 0.2, 0.68, 0.02, 0.06, 0, 0.02, 0.02],
  [Biome.Rainforest]: [0, 0.1, 0.86, 0, 0, 0, 0.02, 0.02],
  [Biome.Tundra]: [0, 0.38, 0.04, 0.16, 0.14, 0, 0.24, 0.04],
  [Biome.Snow]: [0, 0.08, 0.04, 0.12, 0.72, 0, 0.04, 0],
  [Biome.Ice]: [0, 0, 0, 0.06, 0.94, 0, 0, 0],
  [Biome.Rock]: [0.02, 0.06, 0, 0.62, 0.2, 0, 0.1, 0],
};
const COVER_TABLE = new Float32Array(16 * 8);
for (let b = 0; b < 16; b++) {
  const c = COVER[b] ?? COVER[Biome.Grassland];
  for (let k = 0; k < 8; k++) COVER_TABLE[b * 8 + k] = c[k];
}

const noises = new Map<number, Simplex3>();
function simplex(seed: number): Simplex3 {
  let s = noises.get(seed);
  if (!s) {
    s = new Simplex3(seed * 7919 + 17);
    noises.set(seed, s);
  }
  return s;
}

interface Scratch {
  res: number;
  latI: Float64Array; lonJ: Float64Array; cosI: Float64Array; sinI: Float64Array; cosJ: Float64Array; sinJ: Float64Array;
  fbm: Float32Array; ridge: Float32Array; slope: Float32Array;
  colRX0: Int32Array; colRX1: Int32Array; colRT: Float32Array;
  colDX0: Int32Array; colDX1: Int32Array; colDT: Float32Array;
  colTX0: Int32Array; colTX1: Int32Array; colTT: Float32Array; colTile: Int32Array;
  cpos: Int32Array; cw: Float32Array; ctint: Float32Array; ax0: Int32Array; axT: Float32Array; cov: Float32Array; wS: Float32Array;
}
let scratch: Scratch | null = null;
function getScratch(res: number): Scratch {
  if (scratch && scratch.res >= res) return scratch;
  const n = res * res;
  scratch = {
    res,
    latI: new Float64Array(res), lonJ: new Float64Array(res), cosI: new Float64Array(res), sinI: new Float64Array(res),
    cosJ: new Float64Array(res), sinJ: new Float64Array(res),
    fbm: new Float32Array(n), ridge: new Float32Array(n), slope: new Float32Array(n),
    colRX0: new Int32Array(res), colRX1: new Int32Array(res), colRT: new Float32Array(res),
    colDX0: new Int32Array(res), colDX1: new Int32Array(res), colDT: new Float32Array(res),
    colTX0: new Int32Array(res), colTX1: new Int32Array(res), colTT: new Float32Array(res), colTile: new Int32Array(res),
    cpos: new Int32Array(0), cw: new Float32Array(0), ctint: new Float32Array(0), ax0: new Int32Array(0), axT: new Float32Array(0),
    cov: new Float32Array(8), wS: new Float32Array(8),
  };
  return scratch;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Horizontal bilinear setup for a grid of width w (pixel centers at +0.5, wrap). */
function colSetup(u: number, w: number, x0: Int32Array, x1: Int32Array, t: Float32Array, j: number): void {
  const fx = u * w - 0.5;
  const xf = Math.floor(fx);
  t[j] = fx - xf;
  x0[j] = ((xf % w) + w) % w;
  x1[j] = (x0[j] + 1) % w;
}

export function buildLocalHeightfield(
  world: WorldData,
  aux: WorldAux | null,
  lat0: number,
  lon0: number,
  sizeKm: number,
  resolution: number,
  opts: LocalHeightfieldOptions = {},
): LocalHeightfield {
  const t0 = performance.now();
  const res = Math.max(2, Math.min(2048, Math.floor(resolution)));
  const n = res * res;
  const size = Math.max(0.01, sizeKm) * 1000;
  const cell = size / (res - 1);
  const detailMul = opts.detail ?? 1;
  const vScale = opts.verticalScale ?? 1;
  const noise = simplex(opts.seed ?? 0);

  const reuse = opts.reuse;
  const ok = !!reuse && reuse.resolution === res;
  const heights = ok ? reuse.heights : new Float32Array(n);
  const water = ok ? reuse.water : new Uint8Array(n);
  const biome = ok ? reuse.biome : new Uint8Array(n);
  const splatA = ok ? reuse.splatA : new Uint8Array(n * 4);
  const splatB = ok ? reuse.splatB : new Uint8Array(n * 4);
  const tint = ok ? reuse.tint : new Uint8Array(n * 3);

  const sc = getScratch(res);
  const { latI, lonJ, cosI, sinI, cosJ, sinJ, fbm, ridge, slope } = sc;
  const cosLat0 = Math.max(0.01, Math.cos(lat0 * DEG));
  for (let i = 0; i < res; i++) {
    latI[i] = Math.max(-89.99, Math.min(89.99, lat0 + ((0.5 - i / (res - 1)) * size) / M_PER_DEG));
    cosI[i] = Math.cos(latI[i] * DEG);
    sinI[i] = Math.sin(latI[i] * DEG);
  }
  for (let j = 0; j < res; j++) {
    const lon = lon0 + ((j / (res - 1) - 0.5) * size) / (M_PER_DEG * cosLat0);
    lonJ[j] = ((((lon + 180) % 360) + 360) % 360) - 180;
    cosJ[j] = Math.cos(lonJ[j] * DEG);
    sinJ[j] = Math.sin(lonJ[j] * DEG);
  }

  // --- fractal detail -----------------------------------------------------------------------------------------
  // Finest octave: wavelength >= 3 cells. Octaves with wavelength >= 24 cells run on a 4x coarser lattice, those
  // >= 8 cells on a 2x coarser lattice (bilinear upsampling is exact enough at >= 4 samples per wavelength), so a
  // 256^2 patch evaluates ~1 simplex octave per sample instead of ~7.
  const kFine = Math.min(MAX_OCT - 1, Math.floor(Math.log2(LADDER0 / (cell * 3))));
  const kSplit = Math.max(0, Math.min(kFine + 1, Math.floor(Math.log2(LADDER0 / (cell * 24))) + 1));
  const kMid = Math.max(kSplit, Math.min(kFine + 1, Math.floor(Math.log2(LADDER0 / (cell * 8))) + 1));
  fbm.fill(0, 0, n);
  ridge.fill(0, 0, n);
  latticeOctaves(noise, lat0, lon0, size, cosLat0, res, 4, 0, kSplit, fbm, ridge);
  latticeOctaves(noise, lat0, lon0, size, cosLat0, res, 2, kSplit, kMid, fbm, ridge);
  for (let i = 0; i < res; i++) {
    const ci = cosI[i], si = sinI[i];
    for (let j = 0; j < res; j++) {
      const p = i * res + j;
      let f = fbm[p], r = ridge[p];
      if (kMid <= kFine) {
        const px = R_M * ci * cosJ[j], py = R_M * si, pz = -R_M * ci * sinJ[j];
        for (let k = kMid; k <= kFine; k++) {
          const inv = OCT_INV[k], o = k * 31.7;
          const v = noise.noise(px * inv + o, py * inv - o * 0.7, pz * inv + o * 1.3);
          f += v * OCT_AMP[k];
          const rv = 1 - Math.abs(v);
          r += rv * rv * OCT_AMP[k];
        }
      }
      fbm[p] = f * FBM_NORM;
      ridge[p] = r * FBM_NORM;
    }
  }

  // --- per-column lookups -------------------------------------------------------------------------------------
  const rel = world.relief;
  const rw = rel.width, rh = rel.height, rd = rel.data;
  const day = aux?.day, lights = aux?.lights;
  const dw = day?.width ?? 1, dh = day?.height ?? 1;
  for (let j = 0; j < res; j++) {
    const u = (lonJ[j] + 180) / 360;
    colSetup(u, rw, sc.colRX0, sc.colRX1, sc.colRT, j);
    colSetup(u, dw, sc.colDX0, sc.colDX1, sc.colDT, j);
    colSetup(u, MAP_W, sc.colTX0, sc.colTX1, sc.colTT, j);
    sc.colTile[j] = Math.min(MAP_W - 1, Math.floor(u * MAP_W));
  }
  const waterFrac = aux?.waterFrac;
  const tileBiome = aux?.biome;
  const terrain = world.terrain;
  // Patch-level ruggedness of the real relief (sharpens mountains that the 20 km map smooths away).
  let rug = 0;
  {
    const cx = Math.floor(((lon0 + 180) / 360) * rw), cy = Math.floor(((90 - lat0) / 180) * rh);
    let mx = -Infinity, mn = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      const y = Math.min(rh - 1, Math.max(0, cy + dy));
      for (let dx = -2; dx <= 2; dx++) {
        const v = rd[y * rw + (((cx + dx) % rw) + rw) % rw];
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
    }
    rug = mx - mn;
  }

  // --- heights ------------------------------------------------------------------------------------------------
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < res; i++) {
    const fy = Math.min(rh - 1, Math.max(0, ((90 - latI[i]) / 180) * rh - 0.5));
    const ry0 = Math.floor(fy), ry1 = Math.min(rh - 1, ry0 + 1), rty = fy - ry0;
    const ty = Math.min(MAP_H - 1, Math.max(0, ((90 - latI[i]) / 180) * MAP_H - 0.5));
    const ty0 = Math.floor(ty), ty1 = Math.min(MAP_H - 1, ty0 + 1), tty = ty - ty0;
    for (let j = 0; j < res; j++) {
      const p = i * res + j;
      const x0 = sc.colRX0[j], x1 = sc.colRX1[j], tx = sc.colRT[j];
      const base =
        (rd[ry0 * rw + x0] * (1 - tx) + rd[ry0 * rw + x1] * tx) * (1 - rty) + (rd[ry1 * rw + x0] * (1 - tx) + rd[ry1 * rw + x1] * tx) * rty;
      // Water fraction (0 land .. 1 water), perturbed so shorelines get bays, spits and inlets.
      let w: number;
      const a0 = sc.colTX0[j], a1 = sc.colTX1[j], at = sc.colTT[j];
      if (waterFrac) {
        w = ((waterFrac[ty0 * MAP_W + a0] * (1 - at) + waterFrac[ty0 * MAP_W + a1] * at) * (1 - tty) +
          (waterFrac[ty1 * MAP_W + a0] * (1 - at) + waterFrac[ty1 * MAP_W + a1] * at) * tty) / 255;
      } else {
        w = (terrain[Math.round(ty) * MAP_W + sc.colTile[j]] & 0x0f) <= 1 ? 1 : 0;
      }
      const f = fbm[p], rr = ridge[p];
      w += f * 0.5 + (rr - 0.45) * 0.1;
      const mount = smoothstep(700, 2600, base);
      const hill = smoothstep(120, 1000, base);
      const amp = (22 + 90 * hill + 820 * mount + Math.min(400, rug * 0.12)) * detailMul;
      const detail = amp * ((1 - mount) * f * 2.2 + mount * (rr - 0.45) * 2.2);
      // Land: real relief + detail, lifted just above sea level near the coast (beaches, not swamps).
      const shore = Math.min(1, Math.max(0, (0.5 - w) * 6));
      let hLand = Math.max(0, base) + detail * (0.35 + 0.65 * shore);
      const floor = 0.6 + shore * 6;
      if (hLand < floor) hLand = floor;
      // Water: shelving seabed.
      const depth = 1.5 + Math.min(1, Math.max(0, (w - 0.5) * 4)) * 38 + Math.abs(f) * 6;
      const land = smoothstep(0.53, 0.47, w);
      const h = (hLand * land - depth * (1 - land)) * vScale;
      heights[p] = h;
      // 0..255 linear across ~12 km of coast; > 127 exactly where the sample is under water.
      const wq = Math.round(Math.min(1, Math.max(0, (w - 0.25) * 2)) * 255);
      water[p] = land < 0.5 ? Math.max(128, wq) : Math.min(127, wq);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }

  // --- slope ---------------------------------------------------------------------------------------------------
  const inv2 = 1 / (2 * cell * vScale);
  for (let i = 0; i < res; i++) {
    const im = i > 0 ? i - 1 : i, ip = i < res - 1 ? i + 1 : i;
    const sy = 2 / (ip - im);
    for (let j = 0; j < res; j++) {
      const jm = j > 0 ? j - 1 : j, jp = j < res - 1 ? j + 1 : j;
      const dx = (heights[i * res + jp] - heights[i * res + jm]) * inv2 * (2 / (jp - jm));
      const dy = (heights[ip * res + j] - heights[im * res + j]) * inv2 * sy;
      slope[i * res + j] = Math.sqrt(dx * dx + dy * dy);
    }
  }

  // --- tint + splat ----------------------------------------------------------------------------------------------
  // Land cover is a smooth field (regional biome mix, altitude bands, slope, patch noise >= 3 cells), so it is
  // evaluated on a 2x coarser lattice for big grids and bilinearly upsampled; water / shoreline stays per sample.
  const st = res >= 96 ? 2 : 1;
  const gn = Math.ceil((res - 1) / st) + 1;
  const cpos = sc.cpos.length >= gn ? sc.cpos : (sc.cpos = new Int32Array(gn));
  for (let a = 0; a < gn; a++) cpos[a] = Math.min(res - 1, a * st);
  const cw = sc.cw.length >= gn * gn * 8 ? sc.cw : (sc.cw = new Float32Array(gn * gn * 8));
  const ctint = sc.ctint.length >= gn * gn * 3 ? sc.ctint : (sc.ctint = new Float32Array(gn * gn * 3));
  const cov = sc.cov, wS = sc.wS;
  const ctab = COVER_TABLE;
  for (let a = 0; a < gn; a++) {
    const i = cpos[a];
    const lat = latI[i];
    const alat = Math.abs(lat);
    const snowLine = 7000 * Math.pow(Math.max(0.05, Math.cos(lat * DEG)), 1.6);
    const treeLine = snowLine * 0.72;
    const dfy = Math.min(dh - 1, Math.max(0, ((90 - lat) / 180) * dh - 0.5));
    const dy0 = Math.floor(dfy), dy1 = Math.min(dh - 1, dy0 + 1), dty = dfy - dy0;
    const ty = Math.min(MAP_H - 1, Math.max(0, ((90 - lat) / 180) * MAP_H - 0.5));
    const ty0 = Math.floor(ty), ty1 = Math.min(MAP_H - 1, ty0 + 1), tty = ty - ty0;
    const tileRow = Math.min(MAP_H - 1, Math.floor(((90 - lat) / 180) * MAP_H)) * MAP_W;
    const polar = alat > 40 ? 1 : 0.5;
    const whiteLat = 0.5 * smoothstep(40, 55, alat);
    for (let b = 0; b < gn; b++) {
      const j = cpos[b];
      const p = i * res + j;
      const q = a * gn + b;
      let r = 110, g = 120, bl = 80, lum = 0;
      if (day) {
        const x0 = sc.colDX0[j], x1 = sc.colDX1[j], tx = sc.colDT[j];
        const d = day.data;
        const i00 = (dy0 * dw + x0) * 4, i01 = (dy0 * dw + x1) * 4, i10 = (dy1 * dw + x0) * 4, i11 = (dy1 * dw + x1) * 4;
        const w00 = (1 - tx) * (1 - dty), w01 = tx * (1 - dty), w10 = (1 - tx) * dty, w11 = tx * dty;
        r = d[i00] * w00 + d[i01] * w01 + d[i10] * w10 + d[i11] * w11;
        g = d[i00 + 1] * w00 + d[i01 + 1] * w01 + d[i10 + 1] * w10 + d[i11 + 1] * w11;
        bl = d[i00 + 2] * w00 + d[i01 + 2] * w01 + d[i10 + 2] * w10 + d[i11 + 2] * w11;
        if (lights) {
          const L = lights.data;
          lum = (L[dy0 * dw + x0] * w00 + L[dy0 * dw + x1] * w01 + L[dy1 * dw + x0] * w10 + L[dy1 * dw + x1] * w11) / 255;
        }
      }
      ctint[q * 3] = r; ctint[q * 3 + 1] = g; ctint[q * 3 + 2] = bl;
      // Biome coverage: bilinear blend of the 4 surrounding tiles' mixes (smooth regional transitions).
      if (tileBiome) {
        const a0 = sc.colTX0[j], a1 = sc.colTX1[j], at = sc.colTT[j];
        const b00 = tileBiome[ty0 * MAP_W + a0] * 8, b01 = tileBiome[ty0 * MAP_W + a1] * 8;
        const b10 = tileBiome[ty1 * MAP_W + a0] * 8, b11 = tileBiome[ty1 * MAP_W + a1] * 8;
        const w00 = (1 - at) * (1 - tty), w01 = at * (1 - tty), w10 = (1 - at) * tty, w11 = at * tty;
        for (let k = 0; k < 8; k++) cov[k] = ctab[b00 + k] * w00 + ctab[b01 + k] * w01 + ctab[b10 + k] * w10 + ctab[b11 + k] * w11;
      } else {
        for (let k = 0; k < 8; k++) cov[k] = ctab[Biome.Grassland * 8 + k];
      }
      const h = heights[p] / vScale;
      const s = slope[p];
      const wv = water[p] / 255;
      const f = fbm[p];
      const rr = ridge[p];
      // Two decorrelated patch fields in ~[0,1] from the same octaves (no extra noise calls).
      const pa = Math.min(1, Math.max(0, 0.5 + f * 3.2));
      const pb = Math.min(1, Math.max(0, (rr - 0.3) * 2.4));
      const bright = (r + g + bl) / 3;
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      const white = Math.max(0, Math.min(1, (bright / 255 - 0.45) / 0.4)) * Math.max(0, 1 - ((mx - mn) / Math.max(1, mx)) * 2.2);
      // Patches: a class is present where its patch field falls under its coverage (soft edge).
      const forest = smoothstep(cov[2] + 0.07, cov[2] - 0.07, pa) * (1 - smoothstep(treeLine * 0.85, treeLine * 1.05, h)) * (1 - smoothstep(0.55, 0.9, s));
      const sand = smoothstep(1 - cov[0] - 0.08, 1 - cov[0] + 0.08, pa);
      const dirt = smoothstep(cov[6] + 0.1, cov[6] - 0.1, pb) * (1 - forest);
      const altitudeRock = smoothstep(treeLine, snowLine * 1.02, h);
      const rock = Math.max(smoothstep(0.5, 0.9, s + (pb - 0.5) * 0.25), altitudeRock * (0.5 + 0.5 * pb), smoothstep(cov[3] + 0.05, cov[3] - 0.05, 1 - pb) * 0.8);
      const snowAlt = smoothstep(snowLine * 0.94, snowLine * 1.06, h + f * 600);
      const snowCover = smoothstep(1 - cov[4] - 0.06, 1 - cov[4] + 0.06, 1 - pb) * polar;
      const snow = Math.max(snowAlt, snowCover, white * whiteLat) * (1 - smoothstep(0.8, 1.2, s));
      const beach = smoothstep(0.4, 0.48, wv) * (1 - smoothstep(3, 12, h)) * (1 - smoothstep(0.25, 0.5, s));
      const urban = smoothstep(0.22, 0.7, lum + f * 0.35) * (1 - smoothstep(0.3, 0.55, s));
      const river = terrain[tileRow + sc.colTile[j]] & 0x40 ? 0.18 : 0;
      const wet = smoothstep(0.34, 0.47, wv) * (1 - beach) * 0.7 + river * smoothstep(0.4, 0.7, pa);
      wS[0] = Math.max(sand * (0.6 + 0.4 * cov[0]), beach * 1.4);
      wS[1] = (1 - forest) * (1 - sand) * (0.25 + cov[1]) + 0.04;
      wS[2] = forest * 1.2;
      wS[3] = rock * (1 - snow * 0.6) * 1.2;
      wS[4] = snow * 1.6;
      wS[5] = urban * 2;
      wS[6] = dirt * 0.8 + smoothstep(0.35, 0.55, s) * 0.2;
      wS[7] = wet;
      if (snow > 0.3) { wS[1] *= 1 - snow; wS[2] *= 1 - snow * 0.7; wS[6] *= 1 - snow; }
      if (urban > 0.3) { wS[2] *= 1 - urban; wS[1] *= 1 - urban * 0.6; }
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        const v = wS[k] > 0 ? wS[k] : 0;
        wS[k] = v;
        sum += v;
      }
      const inv = 1 / (sum > 0 ? sum : 1);
      for (let k = 0; k < 8; k++) cw[q * 8 + k] = wS[k] * inv;
    }
  }
  // Upsample: per-axis lattice lookup (the last lattice step may be shorter than `st`).
  const ax0 = sc.ax0.length >= res ? sc.ax0 : (sc.ax0 = new Int32Array(res));
  const axT = sc.axT.length >= res ? sc.axT : (sc.axT = new Float32Array(res));
  for (let i = 0; i < res; i++) {
    let a = Math.min(gn - 2, Math.floor(i / st));
    if (a < 0) a = 0;
    const span = gn > 1 ? cpos[a + 1] - cpos[a] : 1;
    ax0[i] = a;
    axT[i] = gn > 1 ? (i - cpos[a]) / span : 0;
  }
  const g1 = gn > 1 ? 1 : 0;
  for (let i = 0; i < res; i++) {
    const a = ax0[i], ta = axT[i];
    for (let j = 0; j < res; j++) {
      const p = i * res + j;
      const bq = ax0[j], tb = axT[j];
      const q00 = a * gn + bq, q01 = q00 + g1, q10 = q00 + g1 * gn, q11 = q10 + g1;
      const w00 = (1 - ta) * (1 - tb), w01 = (1 - ta) * tb, w10 = ta * (1 - tb), w11 = ta * tb;
      tint[p * 3] = ctint[q00 * 3] * w00 + ctint[q01 * 3] * w01 + ctint[q10 * 3] * w10 + ctint[q11 * 3] * w11;
      tint[p * 3 + 1] = ctint[q00 * 3 + 1] * w00 + ctint[q01 * 3 + 1] * w01 + ctint[q10 * 3 + 1] * w10 + ctint[q11 * 3 + 1] * w11;
      tint[p * 3 + 2] = ctint[q00 * 3 + 2] * w00 + ctint[q01 * 3 + 2] * w01 + ctint[q10 * 3 + 2] * w10 + ctint[q11 * 3 + 2] * w11;
      const wv = water[p];
      if (wv > 127) {
        // Open water: wet sand / mud bed.
        wS[0] = 50; wS[1] = 0; wS[2] = 0; wS[3] = 0; wS[4] = 0; wS[5] = 0; wS[6] = 18; wS[7] = 187;
        biome[p] = SplatBiome.Water;
      } else {
        let best = 0, used = 0;
        const o00 = q00 * 8, o01 = q01 * 8, o10 = q10 * 8, o11 = q11 * 8;
        for (let k = 0; k < 8; k++) {
          const v = Math.round((cw[o00 + k] * w00 + cw[o01 + k] * w01 + cw[o10 + k] * w10 + cw[o11 + k] * w11) * 255);
          wS[k] = v;
          used += v;
          if (v > wS[best]) best = k;
        }
        wS[best] += 255 - used;
        biome[p] = best;
      }
      const o = p * 4;
      splatA[o] = wS[0]; splatA[o + 1] = wS[1]; splatA[o + 2] = wS[2]; splatA[o + 3] = wS[3];
      splatB[o] = wS[4]; splatB[o + 1] = wS[5]; splatB[o + 2] = wS[6]; splatB[o + 3] = wS[7];
    }
  }
  // Center height (exact center, bilinear over the grid).
  const c = (res - 1) / 2;
  const ci = Math.floor(c), ct = c - ci;
  const i1 = Math.min(res - 1, ci + 1);
  const centerHeight =
    (heights[ci * res + ci] * (1 - ct) + heights[ci * res + i1] * ct) * (1 - ct) +
    (heights[i1 * res + ci] * (1 - ct) + heights[i1 * res + i1] * ct) * ct;
  const result: LocalHeightfield = ok ? reuse : ({} as LocalHeightfield);
  result.lat = lat0;
  result.lon = lon0;
  result.sizeKm = sizeKm;
  result.resolution = res;
  result.cellMeters = cell;
  result.heights = heights;
  result.centerHeight = centerHeight;
  result.minHeight = minH;
  result.maxHeight = maxH;
  result.baseCenterElevation = sampleRelief(world, lat0, lon0);
  result.water = water;
  result.biome = biome;
  result.splatA = splatA;
  result.splatB = splatB;
  result.tint = tint;
  result.ms = performance.now() - t0;
  return result;
}

/** Sum octaves [kA, kB) on a lattice every `step` samples and add them, bilinearly upsampled, into f / r. */
function latticeOctaves(
  noise: Simplex3, lat0: number, lon0: number, size: number, cosLat0: number, res: number, step: number,
  kA: number, kB: number, fOut: Float32Array, rOut: Float32Array,
): void {
  if (kB <= kA) return;
  const gs = Math.ceil((res - 1) / step) + 1;
  const need = gs * gs;
  if (latticeScratch.cf.length < need) { latticeScratch.cf = new Float32Array(need); latticeScratch.cr = new Float32Array(need); }
  const cf = latticeScratch.cf, cr = latticeScratch.cr;
  for (let gi = 0; gi < gs; gi++) {
    const la = (lat0 + ((0.5 - Math.min(res - 1, gi * step) / (res - 1)) * size) / M_PER_DEG) * DEG;
    const cl = Math.cos(la), sl = Math.sin(la);
    for (let gj = 0; gj < gs; gj++) {
      const lo = (lon0 + ((Math.min(res - 1, gj * step) / (res - 1) - 0.5) * size) / (M_PER_DEG * cosLat0)) * DEG;
      const px = R_M * cl * Math.cos(lo), py = R_M * sl, pz = -R_M * cl * Math.sin(lo);
      let f = 0, r = 0;
      for (let k = kA; k < kB; k++) {
        const inv = OCT_INV[k], o = k * 31.7;
        const v = noise.noise(px * inv + o, py * inv - o * 0.7, pz * inv + o * 1.3);
        f += v * OCT_AMP[k];
        const rv = 1 - Math.abs(v);
        r += rv * rv * OCT_AMP[k];
      }
      cf[gi * gs + gj] = f;
      cr[gi * gs + gj] = r;
    }
  }
  for (let i = 0; i < res; i++) {
    const gy0 = Math.min(gs - 2, Math.floor(i / step));
    const ty = (i - gy0 * step) / (Math.min(res - 1, (gy0 + 1) * step) - gy0 * step);
    for (let j = 0; j < res; j++) {
      const gx0 = Math.min(gs - 2, Math.floor(j / step));
      const tx = (j - gx0 * step) / (Math.min(res - 1, (gx0 + 1) * step) - gx0 * step);
      const a = gy0 * gs + gx0;
      const p = i * res + j;
      fOut[p] += (cf[a] * (1 - tx) + cf[a + 1] * tx) * (1 - ty) + (cf[a + gs] * (1 - tx) + cf[a + gs + 1] * tx) * ty;
      rOut[p] += (cr[a] * (1 - tx) + cr[a + 1] * tx) * (1 - ty) + (cr[a + gs] * (1 - tx) + cr[a + gs + 1] * tx) * ty;
    }
  }
}
const latticeScratch = { cf: new Float32Array(0), cr: new Float32Array(0) };

/** Bilinear relief (meters) — same as data/index sampleElevation, kept here to avoid an import cycle. */
export function sampleRelief(world: WorldData, lat: number, lon: number): number {
  const r = world.relief;
  const fx = (((((lon + 180) / 360) * r.width - 0.5) % r.width) + r.width) % r.width;
  const fy = Math.min(r.height - 1, Math.max(0, ((90 - lat) / 180) * r.height - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = (x0 + 1) % r.width, y1 = Math.min(r.height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const d = r.data;
  const a = d[y0 * r.width + x0] * (1 - tx) + d[y0 * r.width + x1] * tx;
  const b = d[y1 * r.width + x0] * (1 - tx) + d[y1 * r.width + x1] * tx;
  return a * (1 - ty) + b * ty;
}
