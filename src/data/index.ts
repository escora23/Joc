// FRONT ULTRA — world data layer, public API (owner: data).
//
// Builds the real-Earth world from the NASA maps and Natural Earth in a Web Worker (main-thread fallback) and
// exposes fast sampling helpers for every other subsystem.
//
// Contract API (ARCHITECTURE.md §3 / §16 — keep these signatures):
//   loadWorldData(progress): Promise<WorldData>
//   sampleElevation(world, lat, lon): number   (meters, bilinear on world.relief)
//   worldInit(world): WorldInit                (strip main-thread-only fields before sending to the worker)
//
// Extras (main thread):
//   getWorldAux(world)                           coast distance, TerrainDetail, biomes, day/night colors, stats
//   elevationAt(lat, lon)                        sampleElevation on the loaded world (0 before loading)
//   getLocalHeightfield(lat, lon, sizeKm, res)   high-res local terrain + splat/biome (battle, command)
//   countryInfo(world, i), countryAtLatLon(world, lat, lon), terrainDetailAt(lat, lon), coastDistanceKm(lat, lon)
//   NATION_COLORS / NATION_PALETTE / pickDistinctColors / DEFAULT_HUMAN_COLOR (setup color picker, AI colors)

import { TEXTURES, assetUrl } from '../shared/assets';
import { MAP_H, MAP_W } from '../shared/constants';
import type { ProgressFn } from '../shared/api';
import type { WorldData, WorldInit } from '../shared/types';
import type { WorldBuildResult } from './build';
import { buildLocalHeightfield, sampleRelief } from './heightfield';
import { registerDataStrings } from './strings';
import type { CountryInfo, LocalHeightfield, LocalHeightfieldOptions, WorldAux } from './types';

export * from './types';
export { NATION_COLORS, NATION_PALETTE, DEFAULT_HUMAN_COLOR, pickDistinctColors, nearestPaletteIndex } from './palette';
export { buildLocalHeightfield } from './heightfield';
export { renderDebugMap, DEBUG_MAP_MODES, type DebugMapMode } from './debugmap';

registerDataStrings();

const auxByWorld = new WeakMap<WorldData, WorldAux>();
let current: WorldData | null = null;

/** Build the world. Reports 0..1 with i18n labels (`data.*`). Uses a worker when available. */
export async function loadWorldData(progress: ProgressFn): Promise<WorldData> {
  const urls = {
    water: absUrl(TEXTURES.water),
    topo: absUrl(TEXTURES.topology),
    day: absUrl(TEXTURES.day),
    night: absUrl(TEXTURES.night),
  };
  progress(0, 'data.download');
  let result: WorldBuildResult;
  try {
    result = await buildInWorker(urls, progress);
  } catch (err) {
    console.warn('[data] worker build failed, building on the main thread', err);
    const { runBuild } = await import('./worker');
    result = await runBuild(
      urls,
      async (f, l) => {
        progress(f, l);
        // Yield so the loading screen can repaint.
        await new Promise<void>((r) => setTimeout(r, 0));
      },
      'main',
    );
  }
  const world = result.world;
  const aux: WorldAux = { ...result.aux, relief: world.relief };
  auxByWorld.set(world, aux);
  current = world;
  const s = aux.stats;
  console.info(
    `[data] world built (${s.thread}): ${s.landTiles} land tiles, ${s.countries} countries, ${s.lakes} lakes, ` +
      `${s.riverTiles} river tiles, timings ${JSON.stringify(s.timings)}`,
  );
  if (s.warnings.length) console.debug('[data] notes:', s.warnings);
  progress(1, 'data.done');
  return world;
}

function absUrl(path: string): string {
  return new URL(assetUrl(path), location.href).href;
}

function buildInWorker(urls: Record<'water' | 'topo' | 'day' | 'night', string>, progress: ProgressFn): Promise<WorldBuildResult> {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      reject(new Error('no Worker/OffscreenCanvas'));
      return;
    }
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'world-data' });
    w.onmessage = (ev: MessageEvent<{ type: string; f?: number; label?: string; result?: WorldBuildResult; message?: string }>) => {
      const m = ev.data;
      if (m.type === 'progress') progress(m.f ?? 0, m.label);
      else if (m.type === 'done' && m.result) {
        w.terminate();
        resolve(m.result);
      } else if (m.type === 'error') {
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'world worker error'));
    };
    w.postMessage({ type: 'build', urls });
  });
}

/** Bilinear elevation (meters) from world.relief. Water areas read as their relief value (usually 0). */
export function sampleElevation(world: WorldData, lat: number, lon: number): number {
  return sampleRelief(world, lat, lon);
}

/** sampleElevation on the loaded world (0 before loading). */
export function elevationAt(lat: number, lon: number): number {
  return current ? sampleRelief(current, lat, lon) : 0;
}

/** The world built by the last loadWorldData() (null before). */
export function getLoadedWorld(): WorldData | null {
  return current;
}

/** Main-thread extras of a world built by loadWorldData (null for a world from elsewhere). */
export function getWorldAux(world: WorldData | null = current): WorldAux | null {
  return world ? auxByWorld.get(world) ?? null : null;
}

export function worldInit(world: WorldData): WorldInit {
  const { relief: _relief, ...rest } = world;
  return rest;
}

/** Full metadata of a country (index 0 = the "no country" placeholder). */
export function countryInfo(world: WorldData, index: number): CountryInfo | undefined {
  return world.countries[index] as CountryInfo | undefined;
}

function tileIndex(lat: number, lon: number): number {
  const x = ((Math.floor(((lon + 180) / 360) * MAP_W) % MAP_W) + MAP_W) % MAP_W;
  const y = Math.min(MAP_H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * MAP_H)));
  return y * MAP_W + x;
}

/** Country index at lat/lon (0 = water, ice or none). */
export function countryAtLatLon(world: WorldData, lat: number, lon: number): number {
  return world.country[tileIndex(lat, lon)];
}

/** TerrainDetail class at lat/lon on the loaded world (-1 before loading). */
export function terrainDetailAt(lat: number, lon: number): number {
  const aux = getWorldAux();
  return aux ? aux.detail[tileIndex(lat, lon)] : -1;
}

/** Signed distance to the coast in km (>0 inland, <0 at sea) on the loaded world (0 before loading). */
export function coastDistanceKm(lat: number, lon: number): number {
  const aux = getWorldAux();
  return aux ? aux.coastKm[tileIndex(lat, lon)] : 0;
}

/**
 * High-resolution local terrain around lat/lon: `resolution`^2 heights (meters, real relief + deterministic fractal
 * detail, water carved below 0) spanning `sizeKm`, with splat weights, dominant biome and the regional day tint.
 * ~25 ms for 256x256. Deterministic: the same place always looks the same. Pass `opts.reuse` to avoid allocations.
 * Throws if the world is not loaded yet.
 */
export function getLocalHeightfield(lat: number, lon: number, sizeKm: number, resolution: number, opts?: LocalHeightfieldOptions): LocalHeightfield {
  if (!current) throw new Error('[data] getLocalHeightfield before loadWorldData');
  return buildLocalHeightfield(current, getWorldAux(current), lat, lon, sizeKm, resolution, opts);
}
