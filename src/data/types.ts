// FRONT ULTRA — data layer types (owner: data). Worker-safe: no three.js, no DOM.
//
// These extend the shared contract (src/shared/types.ts) without changing it:
//   * `CountryInfo` is what every entry of `WorldData.countries` really is at runtime (a superset of CountryDef);
//     it is structured-cloned to the sim worker unchanged, so sim-ai can read `color`, `neighbors`, `region`...
//     through `countryInfo(world, index)`.
//   * `WorldAux` holds the main-thread-only extras (coast distance, detailed terrain, biomes, low-res day/night
//     colors) used by the globe, battle and command subsystems. Get it with `getWorldAux(world)`.

import type { CountryDef, HeightField, LatLon } from '../shared/types';

/** Detailed topographic class per tile (finer than the gameplay TerrainClass). */
export const TerrainDetail = {
  DeepOcean: 0,
  Ocean: 1,
  /** Continental shelf: shallow sea (brighter water in the Blue Marble bathymetry, or near a coast). */
  Shelf: 2,
  /** Water within ~1–2 tiles of land. */
  Coastal: 3,
  Lake: 4,
  /** Land below ~150 m (river valleys, deltas, coastal plains). */
  Lowland: 5,
  Plains: 6,
  Hills: 7,
  Mountains: 8,
  /** The highest, most rugged ranges (Himalaya, Andes crest, Alps core...). */
  Peaks: 9,
  /** Permanent ice sheet (Antarctica, Greenland interior, High Arctic caps): unplayable. */
  IceSheet: 10,
} as const;
export type TerrainDetail = (typeof TerrainDetail)[keyof typeof TerrainDetail];
export const TERRAIN_DETAIL_KEYS = [
  'deepOcean', 'ocean', 'shelf', 'coastal', 'lake', 'lowland', 'plains', 'hills', 'mountains', 'peaks', 'iceSheet',
] as const;

/** Land cover per tile, classified from the NASA Blue Marble color, latitude and elevation. */
export const Biome = {
  Water: 0,
  Desert: 1,
  /** Semi-arid steppe / scrub. */
  Steppe: 2,
  /** Temperate grassland & farmland. */
  Grassland: 3,
  /** Tropical savanna. */
  Savanna: 4,
  /** Temperate broadleaf / mixed forest. */
  Forest: 5,
  /** Boreal conifer forest. */
  Taiga: 6,
  /** Tropical rainforest. */
  Rainforest: 7,
  Tundra: 8,
  /** Seasonal snow cover / alpine snow (still playable). */
  Snow: 9,
  /** Permanent ice (glaciers, ice sheets). */
  Ice: 10,
  /** Bare rock / high mountains. */
  Rock: 11,
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];
export const BIOME_KEYS = [
  'water', 'desert', 'steppe', 'grassland', 'savanna', 'forest', 'taiga', 'rainforest', 'tundra', 'snow', 'ice', 'rock',
] as const;

/** Broad world regions (AI variety, UI grouping). */
export type WorldRegion = 'europe' | 'asia' | 'middleEast' | 'africa' | 'northAmerica' | 'centralAmerica' | 'southAmerica' | 'oceania';

/** Runtime shape of `WorldData.countries[i]` (index 0 is the "no country" placeholder). */
export interface CountryInfo extends CountryDef {
  /** Natural Earth feature name (e.g. "United States of America", "Dem. Rep. Congo"). */
  neName: string;
  iso2: string;
  capitalNameEn: string;
  capitalNameEs: string;
  /** Playable land tile of this country nearest to its capital (-1 if the country has no tiles). */
  capitalTile: number;
  /** Visual center: interior tile farthest from the country's border (label anchor). */
  center: LatLon;
  centerTile: number;
  /** Population (millions, ~2023) and GDP (billion USD, ~2023): the inputs of `weight`. */
  population: number;
  gdp: number;
  region: WorldRegion;
  /** Suggested nation color (0xRRGGBB) from NATION_PALETTE, distinct from its land neighbours. */
  color: number;
  /** Index of `color` in NATION_PALETTE. */
  paletteIndex: number;
  /** Countries sharing a land border (by index), most shared border first. */
  neighbors: number[];
  /** Tiles per terrain class: [plains, hills, mountains]. */
  terrainTiles: [number, number, number];
  /** Tile-space bounding box (x may exceed MAP_W for countries crossing the antimeridian). */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Main-thread-only world extras (NOT sent to the sim worker). */
export interface WorldAux {
  /** Signed distance to the nearest coast in km (>0 land, <0 water), clamped to +-32767. Cos(lat)-corrected. */
  coastKm: Int16Array;
  /** TerrainDetail per tile. */
  detail: Uint8Array;
  /** Biome per tile. */
  biome: Uint8Array;
  /** Cleaned water fraction per tile 0..255 (255 = water), consistent with `terrain`; bilinear-sample it for smooth coastlines. */
  waterFrac: Uint8Array;
  /** Tile-grid-aligned day color (sRGB RGB, 3 bytes per tile, 1600x800). */
  dayTile: Uint8Array;
  /** Day texture (sRGB RGBA) at reduced resolution for local terrain coloring. */
  day: { width: number; height: number; data: Uint8Array };
  /** City-light luminance 0..255 (Black Marble) at reduced resolution: urban density. */
  lights: { width: number; height: number; data: Uint8Array };
  /** Relief field (same object as WorldData.relief). */
  relief: HeightField;
  /** Stats and timings of the build (debug shot, console). */
  stats: WorldBuildStats;
}

export interface WorldBuildStats {
  landTiles: number;
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
  countries: number;
  unassignedFilled: number;
  capitalsOnOwnLand: number;
  timings: Record<string, number>;
  /** Where the build ran: 'worker' or 'main'. */
  thread: string;
  /** Non-fatal catalog/raster notes (dropped features, overlaps...). */
  warnings: string[];
}

/** Output of getLocalHeightfield(). Vertex grid: `resolution` x `resolution` samples spanning `sizeKm` (edges included). */
export interface LocalHeightfield {
  lat: number;
  lon: number;
  sizeKm: number;
  resolution: number;
  /** Distance between adjacent samples in meters: sizeKm * 1000 / (resolution - 1). */
  cellMeters: number;
  /**
   * Heights in meters above sea level (real relief + deterministic fractal detail). Row-major, row 0 = NORTH edge,
   * column 0 = WEST edge. Sample (i, j) sits at local east = (j / (res-1) - 0.5) * size, north = (0.5 - i / (res-1)) * size.
   * Water is carved below 0 (sea level = 0): shorelines are where heights cross 0.
   */
  heights: Float32Array;
  /** Height at the exact center (meters), same scale as `heights`. */
  centerHeight: number;
  minHeight: number;
  maxHeight: number;
  /** Real (coarse) elevation from sampleElevation() at the center: the globe surface height there. */
  baseCenterElevation: number;
  /** 0..255 per sample: 255 = open water (sea or lake), smooth across the shoreline. */
  water: Uint8Array;
  /** Dominant SplatBiome per sample. */
  biome: Uint8Array;
  /**
   * Splat weights, 8 per sample split in two RGBA arrays (ready for THREE.DataTexture, row 0 = north):
   * splatA = sand, grass, forest, rock; splatB = snow, urban, dirt, wet(shore/mud). Each sample's 8 weights sum to 255.
   */
  splatA: Uint8Array;
  splatB: Uint8Array;
  /** Day-texture tint per sample (sRGB RGB bytes, 3 per sample): the real regional color. */
  tint: Uint8Array;
  /** Wall time spent generating (ms). */
  ms: number;
}

/** Classes of LocalHeightfield.biome (and splat channels in this order). */
export const SplatBiome = {
  Sand: 0,
  Grass: 1,
  Forest: 2,
  Rock: 3,
  Snow: 4,
  Urban: 5,
  Dirt: 6,
  Wet: 7,
  Water: 8,
} as const;
export type SplatBiome = (typeof SplatBiome)[keyof typeof SplatBiome];

export interface LocalHeightfieldOptions {
  /** Extra seed mixed into the fractal detail (default 0: the same place always looks the same). */
  seed?: number;
  /** Multiplier on the fractal detail amplitude (default 1). */
  detail?: number;
  /** Vertical exaggeration applied to the whole field (default 1 = real meters). */
  verticalScale?: number;
  /** Reuse these output arrays when they have the right size (avoid allocations for repeated calls). */
  reuse?: LocalHeightfield;
}
