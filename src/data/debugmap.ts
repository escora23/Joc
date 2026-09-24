// FRONT ULTRA — 2D debug renderings of the world grid (owner: data). Pure & worker-safe (RGBA bytes out), used by
// the `data-debug` shots and by offline verification. Row 0 = north, column 0 = lon -180 (the tile grid itself).

import { MAP_H, MAP_W, TILE_COUNT } from '../shared/constants';
import { hexToRgb } from '../shared/color';
import { TerrainClass, TerrainFlag, type WorldData } from '../shared/types';
import { Biome, TerrainDetail, type CountryInfo, type WorldAux } from './types';

export type DebugMapMode = 'political' | 'terrain' | 'biome' | 'coast';
export const DEBUG_MAP_MODES: readonly DebugMapMode[] = ['political', 'terrain', 'biome', 'coast'];

/** Colors per TerrainDetail (water shades, land relief classes, ice). */
export const DETAIL_RGB: readonly [number, number, number][] = [
  [10, 22, 52], // DeepOcean
  [16, 38, 84], // Ocean
  [28, 66, 122], // Shelf
  [52, 110, 160], // Coastal
  [40, 150, 170], // Lake
  [96, 150, 78], // Lowland
  [138, 168, 92], // Plains
  [176, 152, 96], // Hills
  [140, 104, 76], // Mountains
  [220, 214, 208], // Peaks
  [236, 244, 255], // IceSheet
];

export const BIOME_RGB: readonly [number, number, number][] = [
  [20, 44, 90], // Water
  [226, 196, 128], // Desert
  [196, 180, 112], // Steppe
  [122, 170, 78], // Grassland
  [172, 170, 70], // Savanna
  [52, 118, 56], // Forest
  [40, 88, 72], // Taiga
  [18, 96, 40], // Rainforest
  [150, 150, 128], // Tundra
  [230, 236, 244], // Snow
  [248, 252, 255], // Ice
  [128, 116, 110], // Rock
];

/** Lambert hillshade 0.55..1.25 of the tile elevation field (light from the north-west). */
function hillshade(world: WorldData, i: number): number {
  const x = i % MAP_W, y = (i / MAP_W) | 0;
  const e = world.elevation;
  const l = e[y * MAP_W + (x === 0 ? MAP_W - 1 : x - 1)], r = e[y * MAP_W + (x === MAP_W - 1 ? 0 : x + 1)];
  const u = e[Math.max(0, y - 1) * MAP_W + x], d = e[Math.min(MAP_H - 1, y + 1) * MAP_W + x];
  const dx = (r - l) / 50000, dy = (d - u) / 50000; // meters per ~25 km tile, exaggerated
  const nx = -dx * 18, ny = -dy * 18, nz = 1;
  const len = Math.hypot(nx, ny, nz);
  // light from NW, 45 deg high
  const lx = -0.5, ly = -0.5, lz = 0.707;
  const dot = (nx * lx + ny * -ly + nz * lz) / len;
  return Math.max(0.55, Math.min(1.25, 0.35 + dot * 0.95));
}

/**
 * Render the grid in `mode`. political: nation color per country (hillshaded, borders darkened), water by depth;
 * terrain: TerrainDetail classes with hillshade, rivers, lakes; biome: land cover; coast: signed coast distance bands.
 */
export function renderDebugMap(world: WorldData, aux: WorldAux | null, mode: DebugMapMode, out?: Uint8ClampedArray): Uint8ClampedArray {
  const px = out ?? new Uint8ClampedArray(TILE_COUNT * 4);
  const countries = world.countries as CountryInfo[];
  const rgbOf = countries.map((c) => hexToRgb(c.color ?? 0x888888));
  for (let i = 0; i < TILE_COUNT; i++) {
    const t = world.terrain[i];
    const cls = t & 0x0f;
    const water = cls === TerrainClass.Ocean || cls === TerrainClass.Lake;
    const det = aux ? aux.detail[i] : water ? TerrainDetail.Ocean : TerrainDetail.Plains;
    let r = 0, g = 0, b = 0;
    if (mode === 'coast' && aux) {
      const km = aux.coastKm[i];
      const band = Math.floor(Math.abs(km) / 100) % 2;
      const f = Math.max(0, 1 - Math.abs(km) / 1500);
      if (km < 0) { r = 20 + 60 * f; g = 50 + 110 * f; b = 110 + 120 * f; }
      else { r = 80 + 150 * f; g = 60 + 120 * f; b = 30 + 40 * f; }
      if (band) { r *= 0.82; g *= 0.82; b *= 0.82; }
      if (Math.abs(km) < 14) { r = 255; g = 255; b = 255; }
    } else if (water) {
      [r, g, b] = DETAIL_RGB[det] ?? DETAIL_RGB[1];
      if (cls === TerrainClass.Lake) [r, g, b] = DETAIL_RGB[TerrainDetail.Lake];
    } else if (cls === TerrainClass.Ice) {
      const s = hillshade(world, i);
      r = 214 * s; g = 226 * s; b = 240 * s;
    } else {
      const s = hillshade(world, i);
      if (mode === 'political') {
        const c = world.country[i];
        const [cr, cg, cb] = c ? rgbOf[c] : [255, 0, 255];
        // Nation color over a faint terrain tint so mountains read through.
        const [tr, tg, tb] = DETAIL_RGB[det] ?? DETAIL_RGB[6];
        r = (cr * 0.78 + tr * 0.22) * s; g = (cg * 0.78 + tg * 0.22) * s; b = (cb * 0.78 + tb * 0.22) * s;
        // Borders: any 4-neighbour of a different country (or unowned land).
        const x = i % MAP_W;
        const rr = x === MAP_W - 1 ? i - MAP_W + 1 : i + 1;
        const dd = i + MAP_W;
        const cr2 = world.country[rr], cd = dd < TILE_COUNT ? world.country[dd] : c;
        const landR = (world.terrain[rr] & 0x0f) >= TerrainClass.Plains && (world.terrain[rr] & 0x0f) <= TerrainClass.Mountains;
        const landD = dd < TILE_COUNT && (world.terrain[dd] & 0x0f) >= TerrainClass.Plains && (world.terrain[dd] & 0x0f) <= TerrainClass.Mountains;
        if ((landR && cr2 !== c) || (landD && cd !== c)) { r *= 0.35; g *= 0.35; b *= 0.35; }
      } else if (mode === 'biome' && aux) {
        [r, g, b] = BIOME_RGB[aux.biome[i]] ?? BIOME_RGB[Biome.Grassland];
        r *= s; g *= s; b *= s;
      } else {
        [r, g, b] = DETAIL_RGB[det] ?? DETAIL_RGB[6];
        r *= s; g *= s; b *= s;
        if (t & TerrainFlag.River) { r = r * 0.4 + 30; g = g * 0.4 + 110; b = b * 0.4 + 200; }
      }
    }
    // Shore flag on water tiles: a thin light rim, so coast lines are crisp in every mode.
    if (mode !== 'coast' && water && t & TerrainFlag.Shore) { r = r * 0.6 + 70; g = g * 0.6 + 100; b = b * 0.6 + 120; }
    const o = i * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  }
  return px;
}
