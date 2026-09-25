// FRONT ULTRA — terrain grid builder (owner: data). Pure & worker-safe (typed arrays in, typed arrays out).
//
// Input: the NASA water mask (1600x800, exactly the tile grid, 255 = water), the NASA topology map (2048x1024
// grayscale, linear 0..TOPO_MAX_METERS) and the Blue Marble day color averaged per tile.
// Output: the gameplay terrain byte per tile (TerrainClass | flags), per-tile elevation, the relief field, and
// the data-layer extras (signed coast distance in km, TerrainDetail, Biome, cleaned water fraction).
//
// Pipeline:
//   1. water = mask >= 128 (antialiased values below that are rivers / coast blur),
//   2. hand-authored strait carving where the 25 km grid closes a real sea lane (Bosporus),
//   3. diagonal repair: water touching the ocean only through a corner gets a 1-tile channel (Gulf of Suez,
//      Gulf of Corinth, Strait of Magellan, Canadian Arctic channels...),
//   4. 4-connected water bodies: the largest is the world ocean (Navigable); others are Lakes; ponds smaller
//      than LAKE_MIN_TILES become land with the River flag (wet lowland),
//   5. River flag on land tiles the mask marks as partially water (inland, away from the coast),
//   6. elevation: bilinear resample of the topology at tile centers (== sampleElevation at the center),
//   7. signed coast distance (km, cos(lat)-corrected nearest-seed propagation),
//   8. land classes from elevation + local ruggedness; Ice south of ICE_LATITUDE, on the Greenland ice sheet and
//      on the High-Arctic ice caps,
//   9. Shore / Navigable flags, TerrainDetail (deep ocean / ocean / shelf / coastal / lake ...), Biome.

import { ICE_LATITUDE, MAP_H, MAP_W, TILE_COUNT, TOPO_MAX_METERS } from '../shared/constants';
import { DEG } from '../shared/geo';
import { TerrainClass, TerrainFlag, type HeightField } from '../shared/types';
import { Simplex3 } from './noise';
import { Biome, TerrainDetail } from './types';

// --- Tunables ---------------------------------------------------------------------------------------------

/** Water bodies (not connected to the ocean) smaller than this become land (River flag). */
export const LAKE_MIN_TILES = 12;
/** Mask values in [RIVER_MIN, 128) on inland land tiles mark rivers. */
const RIVER_MIN = 56;
/**
 * Elevation thresholds in topology meters (the linear gray/255 * 8848 convention used everywhere; the NASA
 * map reads ~1.4x the real altitude at the high end, so these correspond to ~450 m / ~1300 m real).
 */
export const HILLS_ELEV = 720;
export const MOUNTAINS_ELEV = 1900;
/** Rugged terrain (local relief over ~100 km) promotes a class even at lower altitude. */
const HILLS_RUGGED = { elev: 380, relief: 700 };
const MOUNTAINS_RUGGED = { elev: 1100, relief: 2000 };
/** Peaks need altitude AND ruggedness (so the flat Tibetan plateau stays "Mountains"). */
const PEAKS_ELEV = 6400;
const PEAKS_RUGGED = { elev: 2600, relief: 2600 };
const LOWLAND_ELEV = 160;

/** Hand-authored straits the 25 km grid closes (lat/lon polylines carved to water, 4-connected). */
const STRAITS: { name: string; path: [number, number][] }[] = [
  // Bosporus: Black Sea <-> Sea of Marmara (the mask peaks at 114/255 there).
  { name: 'Bosporus', path: [[41.25, 29.12], [41.0, 28.98]] },
];

export interface GridInput {
  /** MAP_W*MAP_H raw water mask values (0..255, 255 = water). */
  water: Uint8Array;
  /** Topology gray values (linear elevation). */
  topo: { width: number; height: number; data: Uint8Array };
  /** Day color per tile (sRGB RGB, 3 bytes per tile). */
  dayTile: Uint8Array;
}

export interface GridBuild {
  terrain: Uint8Array;
  elevation: Int16Array;
  relief: HeightField;
  landTiles: number;
  coastKm: Int16Array;
  detail: Uint8Array;
  biome: Uint8Array;
  waterFrac: Uint8Array;
  /** 4-connected land component id per tile (-1 water): lets the country pass keep coasts on their landmass. */
  landComp: Int32Array;
  stats: {
    iceTiles: number;
    oceanTiles: number;
    lakeTiles: number;
    lakes: number;
    riverTiles: number;
    removedPonds: number;
    carvedStraits: number;
    shoreTiles: number;
    plains: number;
    hills: number;
    mountains: number;
  };
}

const W = MAP_W;
const H = MAP_H;
const TILE_KM_Y = (Math.PI * 6371) / MAP_H; // ~25.02 km per tile north-south

function latOfRow(y: number): number {
  return 90 - ((y + 0.5) / H) * 180;
}

/** Stage callback: the worker uses it to report progress and yield. */
export type StageFn = (fraction: number, label: string) => void | Promise<void>;

export async function buildGrid(inp: GridInput, stage: StageFn = () => undefined): Promise<GridBuild> {
  const N = TILE_COUNT;
  const raw = inp.water;
  const isWater = new Uint8Array(N);
  for (let i = 0; i < N; i++) isWater[i] = raw[i] >= 128 ? 1 : 0;

  // --- 2. straits -----------------------------------------------------------------------------------------
  let carved = 0;
  for (const s of STRAITS) {
    for (let k = 0; k + 1 < s.path.length; k++) carved += carveLine(isWater, s.path[k], s.path[k + 1]);
  }

  // --- 3. diagonal repair ---------------------------------------------------------------------------------
  const lab = new Int32Array(N);
  let comps = labelComponents(isWater, 1, lab);
  for (let pass = 0; pass < 6; pass++) {
    const ocean = largest(comps.sizes);
    let changed = 0;
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const x1 = x === W - 1 ? 0 : x + 1;
        const a = y * W + x, b = y * W + x1, c = (y + 1) * W + x, d = (y + 1) * W + x1;
        // a d diagonal water, b c land (or b c diagonal water, a d land)
        let p = -1, q = -1, l1 = -1, l2 = -1;
        if (isWater[a] && isWater[d] && !isWater[b] && !isWater[c]) { p = a; q = d; l1 = b; l2 = c; }
        else if (isWater[b] && isWater[c] && !isWater[a] && !isWater[d]) { p = b; q = c; l1 = a; l2 = d; }
        if (p < 0) continue;
        const lp = lab[p], lq = lab[q];
        if (lp === lq || (lp !== ocean && lq !== ocean)) continue;
        // Open the land corner the mask considers "wetter" (ties: the first).
        const open = raw[l2] > raw[l1] ? l2 : l1;
        isWater[open] = 1;
        lab[open] = ocean;
        // Merge the other body into the ocean label for this pass (flood relabel).
        const other = lp === ocean ? lq : lp;
        relabel(lab, isWater, other === lp ? p : q, ocean);
        changed++;
      }
    }
    if (!changed) break;
    carved += changed;
    comps = labelComponents(isWater, 1, lab);
  }
  await stage(0.15, 'data.water');

  // --- 4. ocean / lakes / ponds ---------------------------------------------------------------------------
  const oceanId = largest(comps.sizes);
  const river = new Uint8Array(N);
  let removedPonds = 0;
  let lakes = 0;
  for (let c = 0; c < comps.sizes.length; c++) {
    if (c !== oceanId && comps.sizes[c] < LAKE_MIN_TILES) removedPonds++;
    else if (c !== oceanId) lakes++;
  }
  for (let i = 0; i < N; i++) {
    if (!isWater[i]) continue;
    const c = lab[i];
    if (c !== oceanId && comps.sizes[c] < LAKE_MIN_TILES) {
      isWater[i] = 0;
      river[i] = 1;
    }
  }
  // Water fraction consistent with the final classification (keeps the mask's antialiasing on the right side).
  const waterFrac = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const v = raw[i];
    waterFrac[i] = isWater[i] ? Math.max(v, 160) : Math.min(v, 110);
  }

  // --- 5. rivers ------------------------------------------------------------------------------------------
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (isWater[i] || raw[i] < RIVER_MIN) continue;
      // Inland only: no water in the 8-neighbourhood (otherwise it is coast blur, not a river).
      let nearWater = false;
      for (let dy = -1; dy <= 1 && !nearWater; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx < 0 ? W - 1 : x + dx >= W ? 0 : x + dx;
          if (isWater[(y + dy) * W + xx]) { nearWater = true; break; }
        }
      }
      if (!nearWater) river[i] = 1;
    }
  }

  // --- 6. relief + elevation ------------------------------------------------------------------------------
  const tw = inp.topo.width, th = inp.topo.height, tdat = inp.topo.data;
  const relief = new Int16Array(tw * th);
  const k = TOPO_MAX_METERS / 255;
  for (let i = 0; i < relief.length; i++) relief[i] = Math.round(tdat[i] * k);
  const reliefField: HeightField = { width: tw, height: th, data: relief };
  const elevation = new Int16Array(N);
  const elevRaw = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(th - 1, Math.max(0, ((y + 0.5) / H) * th - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(th - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = ((x + 0.5) / W) * tw - 0.5;
      const xf = Math.floor(fx);
      const tx = fx - xf;
      const x0 = (xf + tw) % tw, x1 = (x0 + 1) % tw;
      const a = relief[y0 * tw + x0] * (1 - tx) + relief[y0 * tw + x1] * tx;
      const b = relief[y1 * tw + x0] * (1 - tx) + relief[y1 * tw + x1] * tx;
      const e = a * (1 - ty) + b * ty;
      elevRaw[y * W + x] = e;
    }
  }
  // Local ruggedness: max - min elevation in a 5x5 tile window (~125 km).
  const rug = ruggedness(elevRaw, 2);
  await stage(0.35, 'data.relief');

  // --- 7. coast distance ----------------------------------------------------------------------------------
  const coastKm = signedCoastDistance(isWater);
  await stage(0.55, 'data.coast');

  // --- 8. land components (Greenland), classes ----------------------------------------------------------
  const land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = isWater[i] ? 0 : 1;
  const landLab = new Int32Array(N);
  labelComponents(land, 1, landLab);
  const greenland = landLab[tileAt(72, -40)];

  const terrain = new Uint8Array(N);
  const detail = new Uint8Array(N);
  const biome = new Uint8Array(N);
  const day = inp.dayTile;
  // Climate-zone latitude jitter (+-5 deg, smooth): biome bands follow ragged natural boundaries instead of
  // straight parallels.
  const climate = new Simplex3(4242);
  const stats = {
    iceTiles: 0, oceanTiles: 0, lakeTiles: 0, lakes, riverTiles: 0, removedPonds, carvedStraits: carved, shoreTiles: 0,
    plains: 0, hills: 0, mountains: 0,
  };
  let landTiles = 0;
  for (let y = 0; y < H; y++) {
    const lat = latOfRow(y);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const r = day[i * 3], g = day[i * 3 + 1], b = day[i * 3 + 2];
      if (isWater[i]) {
        const lake = lab[i] !== oceanId;
        terrain[i] = lake ? TerrainClass.Lake : TerrainClass.Ocean | TerrainFlag.Navigable;
        elevation[i] = 0;
        biome[i] = Biome.Water;
        if (lake) {
          detail[i] = TerrainDetail.Lake;
          stats.lakeTiles++;
        } else {
          stats.oceanTiles++;
          const dkm = -coastKm[i];
          // Blue Marble bathymetry shading: shelves are markedly brighter than the abyss.
          const bright = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (dkm <= 30) detail[i] = TerrainDetail.Coastal;
          else if (bright >= 52 || dkm <= 110) detail[i] = TerrainDetail.Shelf;
          else if (bright >= 30 || dkm <= 450) detail[i] = TerrainDetail.Ocean;
          else detail[i] = TerrainDetail.DeepOcean;
        }
        continue;
      }
      const e = elevRaw[i];
      elevation[i] = Math.round(e);
      const white = whiteness(r, g, b);
      let ice = lat < ICE_LATITUDE;
      if (!ice && landLab[i] === greenland && greenland >= 0) {
        // Greenland ice sheet: the white interior; the rocky coastal fringe stays playable.
        ice = white > 0.72 && (coastKm[i] >= 45 || e >= 1500);
      } else if (!ice && lat > 76 && white > 0.8 && e >= 700) {
        // High-Arctic ice caps (Ellesmere, Devon, Svalbard, Franz Josef Land, Severnaya Zemlya, Novaya Zemlya).
        ice = true;
      }
      if (ice) {
        terrain[i] = TerrainClass.Ice;
        detail[i] = TerrainDetail.IceSheet;
        biome[i] = Biome.Ice;
        stats.iceTiles++;
      } else {
        const rg = rug[i];
        let cls: number;
        if (e >= MOUNTAINS_ELEV || (e >= MOUNTAINS_RUGGED.elev && rg >= MOUNTAINS_RUGGED.relief)) cls = TerrainClass.Mountains;
        else if (e >= HILLS_ELEV || (e >= HILLS_RUGGED.elev && rg >= HILLS_RUGGED.relief)) cls = TerrainClass.Hills;
        else cls = TerrainClass.Plains;
        terrain[i] = cls;
        landTiles++;
        if (cls === TerrainClass.Mountains) {
          stats.mountains++;
          detail[i] = e >= PEAKS_ELEV || (e >= PEAKS_RUGGED.elev && rg >= PEAKS_RUGGED.relief) ? TerrainDetail.Peaks : TerrainDetail.Mountains;
        } else if (cls === TerrainClass.Hills) {
          stats.hills++;
          detail[i] = TerrainDetail.Hills;
        } else {
          stats.plains++;
          detail[i] = e < LOWLAND_ELEV ? TerrainDetail.Lowland : TerrainDetail.Plains;
        }
        const lonR = ((x + 0.5) / W) * 2 * Math.PI, cl = Math.cos(lat * DEG);
        const sx = cl * Math.cos(lonR), sy = Math.sin(lat * DEG), sz = cl * Math.sin(lonR);
        const jit = climate.noise(sx * 9, sy * 9, sz * 9) * 3.6 + climate.noise(sx * 33 + 5, sy * 33, sz * 33) * 1.4;
        biome[i] = classifyBiome(r, g, b, lat + (lat >= 0 ? jit : -jit), e, detail[i]);
        if (river[i]) {
          terrain[i] |= TerrainFlag.River;
          stats.riverTiles++;
        }
      }
    }
  }
  // Shore flags (4-neighbourhood, water includes lakes; ice counts as land).
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const w = isWater[i];
      const l = x === 0 ? i + W - 1 : i - 1;
      const rr = x === W - 1 ? i - W + 1 : i + 1;
      if (isWater[l] !== w || isWater[rr] !== w || (y > 0 && isWater[i - W] !== w) || (y < H - 1 && isWater[i + W] !== w)) {
        terrain[i] |= TerrainFlag.Shore;
        stats.shoreTiles++;
      }
    }
  }
  await stage(0.7, 'data.biomes');
  return { terrain, elevation, relief: reliefField, landTiles, coastKm, detail, biome, waterFrac, landComp: landLab, stats };
}

// --- Helpers ------------------------------------------------------------------------------------------------

function tileAt(lat: number, lon: number): number {
  const x = Math.floor(((lon + 180) / 360) * W) % W;
  const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
  return y * W + x;
}

/** Carve a 4-connected line of water tiles between two lat/lon points. Returns tiles changed. */
function carveLine(isWater: Uint8Array, a: [number, number], b: [number, number]): number {
  let x0 = Math.floor(((a[1] + 180) / 360) * W), y0 = Math.floor(((90 - a[0]) / 180) * H);
  const x1 = Math.floor(((b[1] + 180) / 360) * W), y1 = Math.floor(((90 - b[0]) / 180) * H);
  let n = 0;
  const set = (x: number, y: number) => {
    const i = y * W + (((x % W) + W) % W);
    if (!isWater[i]) { isWater[i] = 1; n++; }
  };
  set(x0, y0);
  while (x0 !== x1 || y0 !== y1) {
    // Step along the axis with the larger remaining error (4-connected).
    if (Math.abs(x1 - x0) >= Math.abs(y1 - y0)) x0 += Math.sign(x1 - x0);
    else y0 += Math.sign(y1 - y0);
    set(x0, y0);
  }
  return n;
}

/** 4-connected component labelling of tiles where mask[i] === value (x wraps). Others get -1. */
export function labelComponents(mask: Uint8Array, value: number, lab: Int32Array): { sizes: number[] } {
  lab.fill(-1);
  const sizes: number[] = [];
  const q = new Int32Array(TILE_COUNT);
  for (let s = 0; s < TILE_COUNT; s++) {
    if (mask[s] !== value || lab[s] >= 0) continue;
    const id = sizes.length;
    let head = 0, tail = 0;
    q[tail++] = s;
    lab[s] = id;
    while (head < tail) {
      const c = q[head++];
      const x = c % W;
      const l = x === 0 ? c + W - 1 : c - 1;
      const r = x === W - 1 ? c - W + 1 : c + 1;
      if (mask[l] === value && lab[l] < 0) { lab[l] = id; q[tail++] = l; }
      if (mask[r] === value && lab[r] < 0) { lab[r] = id; q[tail++] = r; }
      if (c >= W) { const u = c - W; if (mask[u] === value && lab[u] < 0) { lab[u] = id; q[tail++] = u; } }
      if (c < TILE_COUNT - W) { const d = c + W; if (mask[d] === value && lab[d] < 0) { lab[d] = id; q[tail++] = d; } }
    }
    sizes.push(tail);
  }
  return { sizes };
}

function relabel(lab: Int32Array, isWater: Uint8Array, start: number, to: number): void {
  const from = lab[start];
  if (from === to) return;
  const stack = [start];
  lab[start] = to;
  while (stack.length) {
    const c = stack.pop()!;
    const x = c % W;
    const nb = [x === 0 ? c + W - 1 : c - 1, x === W - 1 ? c - W + 1 : c + 1, c - W, c + W];
    for (const n of nb) {
      if (n < 0 || n >= TILE_COUNT) continue;
      if (isWater[n] && lab[n] === from) { lab[n] = to; stack.push(n); }
    }
  }
}

function largest(sizes: number[]): number {
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  return best;
}

/** max - min over a (2r+1)^2 window, separable (x wraps). */
function ruggedness(e: Float32Array, r: number): Float32Array {
  const mx = new Float32Array(TILE_COUNT), mn = new Float32Array(TILE_COUNT);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let a = -Infinity, b = Infinity;
      for (let d = -r; d <= r; d++) {
        const v = e[y * W + (((x + d) % W) + W) % W];
        if (v > a) a = v;
        if (v < b) b = v;
      }
      mx[y * W + x] = a;
      mn[y * W + x] = b;
    }
  }
  const out = new Float32Array(TILE_COUNT);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let a = -Infinity, b = Infinity;
      for (let d = -r; d <= r; d++) {
        const yy = Math.min(H - 1, Math.max(0, y + d));
        const i = yy * W + x;
        if (mx[i] > a) a = mx[i];
        if (mn[i] < b) b = mn[i];
      }
      out[y * W + x] = a - b;
    }
  }
  return out;
}

/**
 * Signed distance to the coast in km (land > 0, water < 0): exact separable Euclidean distance transform
 * (Felzenszwalb & Huttenlocher) with a cos(latitude)-scaled horizontal axis (bands have the same width in km
 * everywhere on the globe) and horizontal wrap. Distances are center-to-center minus half a tile.
 */
export function signedCoastDistance(isWater: Uint8Array): Int16Array {
  const toWater = edt2d(isWater, 1); // for land tiles: distance^2 to the nearest water tile
  const toLand = edt2d(isWater, 0);
  const out = new Int16Array(TILE_COUNT);
  for (let i = 0; i < TILE_COUNT; i++) {
    const d2 = isWater[i] ? toLand[i] : toWater[i];
    const km = Math.max(0, Math.sqrt(d2) * TILE_KM_Y - TILE_KM_Y * 0.5);
    const v = Math.min(32767, Math.round(km));
    out[i] = isWater[i] ? -v : v;
  }
  return out;
}

const EDT_INF = 1e20;

/** Squared distance (in tile-height units) from every tile to the nearest tile whose mask equals `seedValue`. */
function edt2d(mask: Uint8Array, seedValue: number): Float64Array {
  const g = new Float64Array(TILE_COUNT);
  // Column pass (no wrap vertically).
  const fcol = new Float64Array(H), dcol = new Float64Array(H);
  const v = new Int32Array(3 * W + 1), z = new Float64Array(3 * W + 2);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) fcol[y] = mask[y * W + x] === seedValue ? 0 : EDT_INF;
    edt1d(fcol, H, dcol, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = dcol[y];
  }
  // Row pass on a tripled row (horizontal wrap), horizontal axis scaled by cos(lat).
  const out = new Float64Array(TILE_COUNT);
  const frow = new Float64Array(3 * W), drow = new Float64Array(3 * W);
  for (let y = 0; y < H; y++) {
    const c = Math.max(0.02, Math.cos(latOfRow(y) * DEG));
    const c2 = c * c;
    for (let k = 0; k < 3 * W; k++) {
      const val = g[y * W + (k % W)];
      frow[k] = val >= EDT_INF ? EDT_INF : val / c2;
    }
    edt1d(frow, 3 * W, drow, v, z);
    for (let x = 0; x < W; x++) out[y * W + x] = Math.min(EDT_INF, drow[W + x] * c2);
  }
  return out;
}

/** 1D squared-distance transform of a sampled function (lower envelope of parabolas). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  let first = -1;
  for (let q = 0; q < n; q++) if (f[q] < EDT_INF) { first = q; break; }
  if (first < 0) {
    for (let q = 0; q < n; q++) d[q] = EDT_INF;
    return;
  }
  v[0] = first;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = first + 1; q < n; q++) {
    if (f[q] >= EDT_INF) continue;
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** 0..1: how snow/ice-white a color is (bright and unsaturated). */
export function whiteness(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  const bright = (r + g + b) / (3 * 255);
  return Math.max(0, Math.min(1, (bright - 0.45) / 0.4)) * Math.max(0, 1 - sat * 2.2);
}

/**
 * Land cover from the Blue Marble color, latitude, elevation and topographic detail. Tuned on probes of the NASA
 * image (Congo 25,38,7 / Borneo 17,29,4 rainforest; Germany 51,54,25 forest; Finland 17,24,4 taiga; Ukraine
 * 57,53,28 grassland; Kazakh steppe 119,99,69; Serengeti 98,79,52 and Cerrado 103,84,54 savanna; Tassili
 * 119,91,60 and Kalahari 152,122,86 desert). `lat` may be jittered by the caller for ragged zone boundaries.
 */
export function classifyBiome(r: number, g: number, b: number, lat: number, elev: number, detail: number): number {
  const alat = Math.abs(lat);
  if (whiteness(r, g, b) > 0.55) return Biome.Snow;
  const bright = (r + g + b) / 3;
  // Greenness: green relative to red; redness: warm (sand / bare soil) relative to blue.
  const green = (g - r) / Math.max(24, bright);
  const redness = (r - b) / Math.max(24, bright);
  if (detail === TerrainDetail.Peaks && bright > 90) return Biome.Rock;
  // Dense vegetation: dark and green (or dark olive in the wet tropics).
  if ((bright < 60 && green > 0) || (bright < 62 && alat < 12 && g > b * 1.5 && green > -0.08)) {
    if (alat < 15) return Biome.Rainforest;
    return alat > 55 ? Biome.Taiga : Biome.Forest;
  }
  // Sand seas and stony deserts: bright, warm, not green.
  if (bright > 120 && redness > 0.3 && green < 0.02) return alat < 45 ? Biome.Desert : Biome.Steppe;
  // Dry brown ground: desert in the subtropical dry belts, savanna in the tropics, steppe further out.
  if (green < -0.15 && redness > 0.4) {
    if (alat >= 16 && alat <= 31 && bright > 80) return Biome.Desert;
    if (alat < 17) return Biome.Savanna;
    return Biome.Steppe;
  }
  if (alat > 64) return green > 0.05 && bright < 90 ? Biome.Taiga : Biome.Tundra;
  if (alat < 24) return redness > 0.5 && bright > 95 ? Biome.Steppe : Biome.Savanna;
  if (detail >= TerrainDetail.Mountains && bright > 95) return Biome.Rock;
  if (alat > 55) return green > 0.02 ? Biome.Taiga : Biome.Grassland;
  return green > -0.05 || bright < 72 ? Biome.Grassland : Biome.Steppe;
}
