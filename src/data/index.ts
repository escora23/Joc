// FRONT ULTRA — world data (owner: data).
// STUB by the architect: real land/water + elevation from the NASA maps; countries are listed from
// Natural Earth but NOT rasterised yet (country[] is all zeros). The data owner replaces this with the full
// pipeline (river/lake cleanup, ocean connectivity, country raster, capitals, localisation, weights).
//
// Public API (keep these signatures):
//   loadWorldData(progress): Promise<WorldData>
//   sampleElevation(world, lat, lon): number   (meters, bilinear on world.relief)
//   worldInit(world): WorldInit                (strip main-thread-only fields before sending to the worker)

import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { TEXTURES, loadPixels } from '../shared/assets';
import { ICE_LATITUDE, MAP_H, MAP_W, TILE_COUNT } from '../shared/constants';
import { neighbors4, topoToMeters } from '../shared/geo';
import { HILLS_MIN_M, MOUNTAINS_MIN_M } from '../shared/terrain';
import { TerrainClass, TerrainFlag, type CountryDef, type WorldData, type WorldInit } from '../shared/types';
import type { ProgressFn } from '../shared/api';

export async function loadWorldData(progress: ProgressFn): Promise<WorldData> {
  progress(0, 'data.water');
  const water = await loadPixels(TEXTURES.water, MAP_W, MAP_H);
  progress(0.3, 'data.relief');
  const topo = await loadPixels(TEXTURES.topology);
  progress(0.6, 'data.countries');

  // Relief field at the topology resolution (meters).
  const relief = new Int16Array(topo.width * topo.height);
  for (let i = 0; i < relief.length; i++) relief[i] = Math.round(topoToMeters(topo.data[i * 4]));
  const reliefField = { width: topo.width, height: topo.height, data: relief };

  const terrain = new Uint8Array(TILE_COUNT);
  const elevation = new Int16Array(TILE_COUNT);
  const sx = topo.width / MAP_W;
  const sy = topo.height / MAP_H;
  let landTiles = 0;
  for (let y = 0; y < MAP_H; y++) {
    const lat = 90 - ((y + 0.5) / MAP_H) * 180;
    const ry = Math.min(topo.height - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < MAP_W; x++) {
      const i = y * MAP_W + x;
      const isWater = water.data[i * 4] > 127;
      const e = relief[ry * topo.width + Math.min(topo.width - 1, Math.floor((x + 0.5) * sx))];
      elevation[i] = isWater ? 0 : e;
      let c: number;
      if (isWater) c = TerrainClass.Ocean;
      else if (lat < ICE_LATITUDE) c = TerrainClass.Ice;
      else if (e >= MOUNTAINS_MIN_M) c = TerrainClass.Mountains;
      else if (e >= HILLS_MIN_M) c = TerrainClass.Hills;
      else c = TerrainClass.Plains;
      terrain[i] = c;
      if (c >= TerrainClass.Plains && c <= TerrainClass.Mountains) landTiles++;
    }
  }
  // Shore flags + (stub) every water tile navigable.
  const nb = new Int32Array(4);
  for (let i = 0; i < TILE_COUNT; i++) {
    const w = terrain[i] <= TerrainClass.Lake;
    if (w) terrain[i] |= TerrainFlag.Navigable;
    const n = neighbors4(i, nb);
    for (let k = 0; k < n; k++) {
      if ((terrain[nb[k]] & 0x0f) <= TerrainClass.Lake !== w) {
        terrain[i] |= TerrainFlag.Shore;
        break;
      }
    }
  }

  const countries = await listCountries();
  progress(1, 'data.done');
  return {
    width: MAP_W,
    height: MAP_H,
    terrain,
    elevation,
    country: new Uint16Array(TILE_COUNT),
    countries,
    landTiles,
    relief: reliefField,
  };
}

async function listCountries(): Promise<CountryDef[]> {
  const topo = (await import('world-atlas/countries-50m.json')).default as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  const fc = feature(topo, topo.objects.countries);
  const out: CountryDef[] = [
    { index: 0, isoNumeric: '', iso3: '', nameEn: '', nameEs: '', capital: { lat: 0, lon: 0 }, tiles: 0, weight: 0 },
  ];
  for (const f of fc.features) {
    const name = f.properties?.name ?? '';
    out.push({
      index: out.length,
      isoNumeric: String(f.id ?? ''),
      iso3: '',
      nameEn: name,
      nameEs: name,
      capital: { lat: 0, lon: 0 },
      tiles: 0,
      weight: 0,
    });
  }
  return out;
}

/** Bilinear elevation (meters) from world.relief. Water areas read as their relief value (usually 0). */
export function sampleElevation(world: WorldData, lat: number, lon: number): number {
  const r = world.relief;
  const fx = (((lon + 180) / 360) * r.width - 0.5 + r.width) % r.width;
  const fy = Math.min(r.height - 1, Math.max(0, ((90 - lat) / 180) * r.height - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = (x0 + 1) % r.width, y1 = Math.min(r.height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const d = r.data;
  const a = d[y0 * r.width + x0] * (1 - tx) + d[y0 * r.width + x1] * tx;
  const b = d[y1 * r.width + x0] * (1 - tx) + d[y1 * r.width + x1] * tx;
  return a * (1 - ty) + b * ty;
}

export function worldInit(world: WorldData): WorldInit {
  const { relief: _relief, ...rest } = world;
  return rest;
}
