// FRONT ULTRA — Natural Earth country raster + catalog assembly (owner: data). Pure & worker-safe.
//
// * Rasterises every world-atlas countries-50m polygon onto the 1600x800 grid by tile CENTER (even-odd scanline
//   fill, exact indices, no antialiasing). Rings crossing the antimeridian (Russia's Chukotka, Fiji) are unwrapped
//   into continuous tile space and written modulo MAP_W. Holes (Lesotho in South Africa, San Marino in Italy)
//   are honoured per polygon.
// * Islands too small to contain a tile center stamp the tile under their centroid when that tile is unclaimed
//   land (Malta, Bahrain, Singapore, Pacific atolls...).
// * Every remaining playable land tile gets its nearest country: first through the same landmass (so coasts stay
//   with their own country), then across water (islands missing from Natural Earth).
// * Only playable land carries a country (water, lakes and ice are 0). Countries without tiles are dropped and the
//   catalog is compacted: WorldData.countries[i].index === i.
// * Metadata: tiles per terrain class, capital tile, visual center (interior tile farthest from any border),
//   neighbours (shared border length), weight, and a palette color distinct from the neighbours.

import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { MAP_H, MAP_W, TILE_COUNT } from '../shared/constants';
import { DEG } from '../shared/geo';
import { TerrainClass, type LatLon } from '../shared/types';
import { COUNTRY_ROWS, DROP, MERGE, PREFERRED_COLORS, countryRowByNeName, countryWeight, type CountryRow } from './countries';
import { NATION_PALETTE, assignCountryColors } from './palette';
import type { CountryInfo, WorldRegion } from './types';

const W = MAP_W;
const H = MAP_H;

export type CountriesTopology = Topology<{ countries: GeometryCollection<{ name: string }> }>;

export interface CountryRaster {
  country: Uint16Array;
  countries: CountryInfo[];
  unassignedFilled: number;
  capitalsOnOwnLand: number;
  warnings: string[];
}

interface Poly {
  /** Rings in continuous tile coordinates, [x0, y0, x1, y1, ...], first ring = outer. */
  rings: Float64Array[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function isPlayableClass(t: number): boolean {
  const c = t & 0x0f;
  return c === TerrainClass.Plains || c === TerrainClass.Hills || c === TerrainClass.Mountains;
}

/** Convert a lon/lat ring to unwrapped tile coordinates. Returns null for rings that circle a pole. */
function ringToTiles(ring: number[][], anchorX: number | null): Float64Array | null {
  const n = ring.length;
  const out = new Float64Array(n * 2);
  let offset = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let x = ((ring[i][0] + 180) / 360) * W;
    const y = ((90 - ring[i][1]) / 180) * H;
    if (i > 0) {
      const d = x + offset - prev;
      if (d > W / 2) offset -= W;
      else if (d < -W / 2) offset += W;
    }
    x += offset;
    prev = x;
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  // A closed ring must come back to its start: a net offset means it circles a pole (Antarctica).
  if (n > 1 && Math.abs(out[(n - 1) * 2] - out[0]) > W / 2) return null;
  if (anchorX !== null) {
    // Holes: shift by whole turns so they sit in the same frame as their outer ring.
    const shift = Math.round((anchorX - out[0]) / W) * W;
    if (shift) for (let i = 0; i < n; i++) out[i * 2] += shift;
  }
  return out;
}

function polysOf(geom: GeoJSON.Geometry | null, warnings: string[], name: string): Poly[] {
  if (!geom) return [];
  const list: number[][][][] =
    geom.type === 'Polygon' ? [geom.coordinates as number[][][]] : geom.type === 'MultiPolygon' ? (geom.coordinates as number[][][][]) : [];
  const polys: Poly[] = [];
  for (const p of list) {
    const outer = ringToTiles(p[0], null);
    if (!outer) {
      warnings.push(`${name}: polar ring skipped`);
      continue;
    }
    const rings = [outer];
    for (let k = 1; k < p.length; k++) {
      const h = ringToTiles(p[k], outer[0]);
      if (h) rings.push(h);
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < outer.length; i += 2) {
      if (outer[i] < minX) minX = outer[i];
      if (outer[i] > maxX) maxX = outer[i];
      if (outer[i + 1] < minY) minY = outer[i + 1];
      if (outer[i + 1] > maxY) maxY = outer[i + 1];
    }
    polys.push({ rings, minX, maxX, minY, maxY });
  }
  return polys;
}

/** Even-odd scanline fill of one polygon by tile centers. Calls write(tile) per covered tile. Returns hit count. */
function fillPoly(p: Poly, write: (tile: number) => void): number {
  const y0 = Math.max(0, Math.ceil(p.minY - 0.5));
  const y1 = Math.min(H - 1, Math.floor(p.maxY - 0.5));
  if (y1 < y0) return 0;
  const rows: number[][] = [];
  for (let y = y0; y <= y1; y++) rows.push([]);
  for (const r of p.rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ax = r[i * 2], ay = r[i * 2 + 1], bx = r[j * 2], by = r[j * 2 + 1];
      if (ay === by) continue;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      // Scanlines fy = y + 0.5 with lo <= fy < hi (half-open: vertices are never counted twice).
      const ys = Math.max(y0, Math.ceil(lo - 0.5));
      const ye = Math.min(y1, Math.ceil(hi - 0.5) - 1);
      for (let y = ys; y <= ye; y++) {
        const fy = y + 0.5;
        rows[y - y0].push(ax + ((fy - ay) / (by - ay)) * (bx - ax));
      }
    }
  }
  let hits = 0;
  for (let y = y0; y <= y1; y++) {
    const xs = rows[y - y0];
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.ceil(xs[k] - 0.5), xb = Math.ceil(xs[k + 1] - 0.5) - 1;
      for (let x = xa; x <= xb; x++) {
        write(y * W + (((x % W) + W) % W));
        hits++;
      }
    }
  }
  return hits;
}

function regionFor(lat: number, lon: number): WorldRegion {
  if (lat < -10 && lon > 110) return 'oceania';
  if (lon < -30) return lat > 15 ? 'northAmerica' : lat > 7 ? 'centralAmerica' : 'southAmerica';
  if (lat > 35 && lon < 45) return 'europe';
  if (lon < 52 && lat < 35 && lat > -40 && lon > -20) return lat > 12 && lon > 34 ? 'middleEast' : 'africa';
  return 'asia';
}

export function rasterizeCountries(
  topo: CountriesTopology,
  terrain: Uint8Array,
  landComp: Int32Array,
): CountryRaster {
  const warnings: string[] = [];
  const fc = feature(topo, topo.objects.countries) as GeoJSON.FeatureCollection<GeoJSON.Geometry, { name: string }>;

  // --- provisional catalog ---------------------------------------------------------------------------------
  const rows: CountryRow[] = [];
  const rowIndex = new Map<string, number>(); // row key (ne name of the target row) -> provisional id (1-based)
  const featureTarget: number[] = [];
  const idOf = (row: CountryRow): number => {
    let id = rowIndex.get(row.ne);
    if (id === undefined) {
      rows.push(row);
      id = rows.length;
      rowIndex.set(row.ne, id);
    }
    return id;
  };
  for (const f of fc.features) {
    const name = f.properties?.name ?? '';
    if (DROP.has(name)) { featureTarget.push(0); continue; }
    const target = MERGE[name] ?? name;
    let row = countryRowByNeName(target);
    if (!row) {
      // Unknown feature (future world-atlas versions): keep it with its Natural Earth name.
      warnings.push(`no catalog row for "${name}"`);
      const c = centroidOf(f.geometry);
      row = { ne: name, iso3: '', iso2: '', en: name, es: name, capEn: name, capEs: name, lat: c.lat, lon: c.lon, pop: 0.1, gdp: 1, region: regionFor(c.lat, c.lon) };
    }
    featureTarget.push(idOf(row));
  }

  // --- raster ------------------------------------------------------------------------------------------------
  const raw = new Uint16Array(TILE_COUNT);
  const stamps: { id: number; x: number; y: number }[] = [];
  // Smallest features first with first-write-wins: where Natural Earth polygons overlap (Morocco's outline
  // includes Western Sahara), the more specific (smaller) feature keeps the tiles.
  const featurePolys = fc.features.map((f) => polysOf(f.geometry, warnings, f.properties?.name ?? '?'));
  const featureArea = featurePolys.map((ps) => ps.reduce((a, p) => a + Math.abs(ringArea(p.rings[0])), 0));
  const drawOrder = fc.features.map((_, i) => i).sort((a, b) => featureArea[a] - featureArea[b] || a - b);
  let overlaps = 0;
  drawOrder.forEach((fi) => {
    const id = featureTarget[fi];
    if (!id) return;
    for (const p of featurePolys[fi]) {
      const hits = fillPoly(p, (t) => {
        if (!raw[t]) raw[t] = id;
        else if (raw[t] !== id) overlaps++;
      });
      if (hits === 0) {
        // Too small for a tile center: remember its centroid.
        const r = p.rings[0];
        let sx = 0, sy = 0;
        const n = r.length / 2;
        for (let i = 0; i < n; i++) { sx += r[i * 2]; sy += r[i * 2 + 1]; }
        stamps.push({ id, x: sx / n, y: sy / n });
      }
    }
  });
  if (overlaps > 0) warnings.push(`overlapping polygon tiles resolved by size: ${overlaps}`);
  const country = new Uint16Array(TILE_COUNT);
  for (let i = 0; i < TILE_COUNT; i++) if (raw[i] && isPlayableClass(terrain[i])) country[i] = raw[i];
  // Stamps: unclaimed playable land at (or right next to) a tiny polygon's centroid.
  for (const s of stamps) {
    const cx = Math.floor(s.x), cy = Math.floor(s.y);
    let best = -1, bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const y = cy + dy;
        if (y < 0 || y >= H) continue;
        const t = y * W + (((cx + dx) % W) + W) % W;
        if (country[t] || !isPlayableClass(terrain[t])) continue;
        const d = (cx + dx + 0.5 - s.x) ** 2 + (y + 0.5 - s.y) ** 2;
        if (d < bd) { bd = d; best = t; }
      }
    }
    if (best >= 0) country[best] = s.id;
  }

  // --- nearest fill ------------------------------------------------------------------------------------------
  let unassigned = 0;
  for (let i = 0; i < TILE_COUNT; i++) if (!country[i] && isPlayableClass(terrain[i])) unassigned++;
  const filled = unassigned;
  if (unassigned > 0) {
    // Phase A: through land of the same landmass (4-neighbourhood BFS from every assigned tile).
    const q = new Int32Array(TILE_COUNT);
    let head = 0, tail = 0;
    for (let i = 0; i < TILE_COUNT; i++) if (country[i]) q[tail++] = i;
    while (head < tail) {
      const c = q[head++];
      const x = c % W;
      const nb0 = x === 0 ? c + W - 1 : c - 1;
      const nb1 = x === W - 1 ? c - W + 1 : c + 1;
      for (let k = 0; k < 4; k++) {
        const n = k === 0 ? nb0 : k === 1 ? nb1 : k === 2 ? c - W : c + W;
        if (n < 0 || n >= TILE_COUNT) continue;
        if (!country[n] && isPlayableClass(terrain[n]) && landComp[n] === landComp[c]) {
          country[n] = country[c];
          q[tail++] = n;
          unassigned--;
        }
      }
    }
    if (unassigned > 0) {
      // Phase B: islands with no Natural Earth polygon -> nearest country across water (8-neighbourhood BFS).
      const seen = new Uint16Array(TILE_COUNT);
      head = 0; tail = 0;
      for (let i = 0; i < TILE_COUNT; i++) if (country[i]) { q[tail++] = i; seen[i] = country[i]; }
      while (head < tail && unassigned > 0) {
        const c = q[head++];
        const x = c % W, y = (c / W) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const n = yy * W + (x + dx < 0 ? W - 1 : x + dx >= W ? 0 : x + dx);
            if (seen[n]) continue;
            seen[n] = seen[c];
            if (isPlayableClass(terrain[n])) { country[n] = seen[c]; unassigned--; }
            q[tail++] = n;
          }
        }
      }
    }
  }

  // --- per-country stats -------------------------------------------------------------------------------------
  const P = rows.length + 1;
  const tiles = new Int32Array(P);
  const terr = new Int32Array(P * 3);
  const bx0 = new Float64Array(P).fill(Infinity), by0 = new Float64Array(P).fill(Infinity);
  const bx1 = new Float64Array(P).fill(-Infinity), by1 = new Float64Array(P).fill(-Infinity);
  const border = new Map<number, number>(); // a*P+b -> shared edges
  for (let i = 0; i < TILE_COUNT; i++) {
    const c = country[i];
    if (!c) continue;
    tiles[c]++;
    const cls = terrain[i] & 0x0f;
    terr[c * 3 + (cls - TerrainClass.Plains)]++;
    const x = i % W, y = (i / W) | 0;
    if (y < by0[c]) by0[c] = y;
    if (y > by1[c]) by1[c] = y;
    const r = x === W - 1 ? i - W + 1 : i + 1;
    const d = i + W;
    for (const n of [r, d]) {
      if (n >= TILE_COUNT) continue;
      const o = country[n];
      if (o && o !== c) {
        const key = Math.min(c, o) * P + Math.max(c, o);
        border.set(key, (border.get(key) ?? 0) + 1);
      }
    }
  }
  // Horizontal extent with wrap: the smallest arc containing all columns of the country.
  const cols: Uint8Array[] = [];
  for (let c = 0; c < P; c++) cols.push(new Uint8Array(0));
  {
    const colMask = new Uint8Array(P * W);
    for (let i = 0; i < TILE_COUNT; i++) if (country[i]) colMask[country[i] * W + (i % W)] = 1;
    for (let c = 1; c < P; c++) {
      if (!tiles[c]) continue;
      // Largest empty gap in the circular column set -> extent is its complement.
      let bestGap = -1, gapStart = 0, run = 0, runStart = 0;
      for (let k = 0; k < 2 * W; k++) {
        const x = k % W;
        if (!colMask[c * W + x]) {
          if (run === 0) runStart = k;
          run++;
          if (run > bestGap && run <= W) { bestGap = run; gapStart = runStart; }
        } else run = 0;
      }
      if (bestGap <= 0) { bx0[c] = 0; bx1[c] = W - 1; }
      else {
        const start = (gapStart + bestGap) % W; // first column after the gap
        bx0[c] = start;
        bx1[c] = start + (W - bestGap) - 1;
      }
    }
  }

  // --- compact ---------------------------------------------------------------------------------------------
  const remap = new Uint16Array(P);
  const kept: number[] = [];
  for (let c = 1; c < P; c++) {
    if (tiles[c] > 0) {
      kept.push(c);
      remap[c] = kept.length;
    } else warnings.push(`dropped (no land tiles): ${rows[c - 1].ne}`);
  }
  for (let i = 0; i < TILE_COUNT; i++) if (country[i]) country[i] = remap[country[i]];
  const K = kept.length + 1;

  // Neighbours by shared border length.
  const nbList: [number, number][][] = Array.from({ length: K }, () => []);
  for (const [key, n] of border) {
    const a = remap[Math.floor(key / P)], b = remap[key % P];
    if (!a || !b) continue;
    nbList[a].push([b, n]);
    nbList[b].push([a, n]);
  }
  const neighbors = nbList.map((l) => l.sort((p, q) => q[1] - p[1] || p[0] - q[0]).map((p) => p[0]));

  // Visual centers: 4-neighbourhood distance from each tile to the nearest tile NOT of its country.
  const inner = new Int32Array(TILE_COUNT).fill(-1);
  {
    const q = new Int32Array(TILE_COUNT);
    let head = 0, tail = 0;
    for (let i = 0; i < TILE_COUNT; i++) {
      const c = country[i];
      if (!c) continue;
      const x = i % W;
      const l = x === 0 ? i + W - 1 : i - 1, r = x === W - 1 ? i - W + 1 : i + 1;
      if (country[l] !== c || country[r] !== c || i < W || i >= TILE_COUNT - W || country[i - W] !== c || country[i + W] !== c) {
        inner[i] = 0;
        q[tail++] = i;
      }
    }
    while (head < tail) {
      const c = q[head++];
      const x = c % W;
      const nbs = [x === 0 ? c + W - 1 : c - 1, x === W - 1 ? c - W + 1 : c + 1, c - W, c + W];
      for (const n of nbs) {
        if (n < 0 || n >= TILE_COUNT || inner[n] >= 0 || country[n] !== country[c]) continue;
        inner[n] = inner[c] + 1;
        q[tail++] = n;
      }
    }
  }
  const centerTile = new Int32Array(K).fill(-1);
  const centerScore = new Float64Array(K).fill(-Infinity);
  for (let i = 0; i < TILE_COUNT; i++) {
    const c = country[i];
    if (!c) continue;
    // Area-true-ish: horizontal distances shrink with latitude; prefer interior, then tiles nearer the capital.
    const s = inner[i];
    if (s > centerScore[c]) { centerScore[c] = s; centerTile[c] = i; }
  }

  const out: CountryInfo[] = [placeholder()];
  let capitalsOnOwnLand = 0;
  for (let k = 0; k < kept.length; k++) {
    const pc = kept[k];
    const idx = k + 1;
    const row = rows[pc - 1];
    const capTile = nearestTileOf(country, idx, row.lat, row.lon);
    const ownTile = tileOf(row.lat, row.lon);
    if (country[ownTile] === idx) capitalsOnOwnLand++;
    const ct = centerTile[idx];
    const center = ct >= 0 ? tileCenter(ct) : { lat: row.lat, lon: row.lon };
    out.push({
      index: idx,
      isoNumeric: numericFor(fc, row.ne),
      iso3: row.iso3,
      nameEn: row.en,
      nameEs: row.es,
      capital: { lat: row.lat, lon: row.lon },
      tiles: tiles[pc],
      weight: countryWeight(row.pop, row.gdp),
      neName: row.ne,
      iso2: row.iso2,
      capitalNameEn: row.capEn,
      capitalNameEs: row.capEs,
      capitalTile: capTile,
      center,
      centerTile: ct,
      population: row.pop,
      gdp: row.gdp,
      region: row.region,
      color: 0,
      paletteIndex: 0,
      neighbors: neighbors[idx],
      terrainTiles: [terr[pc * 3], terr[pc * 3 + 1], terr[pc * 3 + 2]],
      bbox: { x0: bx0[pc], y0: by0[pc], x1: bx1[pc], y1: by1[pc] },
    });
  }

  // --- colors ------------------------------------------------------------------------------------------------
  const order = out.slice(1).map((c) => c.index).sort((a, b) => out[b].weight * 3 + out[b].tiles / 20000 - (out[a].weight * 3 + out[a].tiles / 20000) || a - b);
  const pal = assignCountryColors(K, order, neighbors, (i) => PREFERRED_COLORS[out[i]?.iso3 ?? '']);
  for (let i = 1; i < K; i++) {
    out[i].paletteIndex = pal[i];
    out[i].color = NATION_PALETTE[pal[i]];
  }
  if (COUNTRY_ROWS.length + Object.keys(MERGE).length + DROP.size !== fc.features.length) {
    warnings.push(`catalog rows ${COUNTRY_ROWS.length} vs features ${fc.features.length}`);
  }
  return { country, countries: out, unassignedFilled: filled, capitalsOnOwnLand, warnings };
}

/** Signed shoelace area of a flat [x0, y0, x1, y1, ...] ring (tile units). */
function ringArea(r: Float64Array): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (r[j * 2] - r[i * 2]) * (r[j * 2 + 1] + r[i * 2 + 1]);
  return a / 2;
}

function placeholder(): CountryInfo {
  return {
    index: 0, isoNumeric: '', iso3: '', nameEn: '', nameEs: '', capital: { lat: 0, lon: 0 }, tiles: 0, weight: 0,
    neName: '', iso2: '', capitalNameEn: '', capitalNameEs: '', capitalTile: -1, center: { lat: 0, lon: 0 }, centerTile: -1,
    population: 0, gdp: 0, region: 'europe', color: 0x888888, paletteIndex: 0, neighbors: [], terrainTiles: [0, 0, 0],
    bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
  };
}

function numericFor(fc: GeoJSON.FeatureCollection<GeoJSON.Geometry, { name: string }>, ne: string): string {
  const f = fc.features.find((g) => g.properties?.name === ne);
  return f?.id !== undefined ? String(f.id) : '';
}

function tileOf(lat: number, lon: number): number {
  const x = ((Math.floor(((lon + 180) / 360) * W) % W) + W) % W;
  const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
  return y * W + x;
}

function tileCenter(t: number): LatLon {
  return { lat: 90 - (((t / W) | 0) + 0.5) * (180 / H), lon: ((t % W) + 0.5) * (360 / W) - 180 };
}

/** Nearest tile of `country` id to lat/lon (cos-lat metric), searching outward; -1 if none within 60 tiles. */
function nearestTileOf(country: Uint16Array, id: number, lat: number, lon: number): number {
  const cx = ((lon + 180) / 360) * W, cy = ((90 - lat) / 180) * H;
  const c = Math.max(0.05, Math.cos(lat * DEG));
  let best = -1, bd = Infinity;
  for (let r = 0; r <= 60; r++) {
    const y0 = Math.floor(cy) - r, y1 = Math.floor(cy) + r;
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= H) continue;
      const edgeRow = y === y0 || y === y1;
      for (let x = Math.floor(cx) - r; x <= Math.floor(cx) + r; x++) {
        if (!edgeRow && x !== Math.floor(cx) - r && x !== Math.floor(cx) + r) continue;
        const t = y * W + (((x % W) + W) % W);
        if (country[t] !== id) continue;
        const d = ((x + 0.5 - cx) * c) ** 2 + (y + 0.5 - cy) ** 2;
        if (d < bd) { bd = d; best = t; }
      }
    }
    if (best >= 0 && r >= 2) break;
  }
  return best;
}

function centroidOf(geom: GeoJSON.Geometry | null): LatLon {
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return { lat: 0, lon: 0 };
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let sx = 0, sy = 0, n = 0;
  for (const p of polys) for (const pt of p[0]) { sx += pt[0]; sy += pt[1]; n++; }
  return n ? { lat: sy / n, lon: sx / n } : { lat: 0, lon: 0 };
}
