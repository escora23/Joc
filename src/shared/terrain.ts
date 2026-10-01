// FRONT ULTRA — terrain byte helpers (worker-safe). See types.ts TerrainClass / TerrainFlag.

import { TERRAIN_CLASS_MASK, TerrainClass, TerrainFlag } from './types';

export function isWaterTerrain(t: number): boolean {
  const c = t & TERRAIN_CLASS_MASK;
  return c === TerrainClass.Ocean || c === TerrainClass.Lake;
}

export function isLandTerrain(t: number): boolean {
  return !isWaterTerrain(t);
}

/** Land that can be owned/conquered (not Ice). */
export function isPlayableTerrain(t: number): boolean {
  const c = t & TERRAIN_CLASS_MASK;
  return c === TerrainClass.Plains || c === TerrainClass.Hills || c === TerrainClass.Mountains;
}

export function isShoreTerrain(t: number): boolean {
  return (t & TerrainFlag.Shore) !== 0;
}

export function isNavigableTerrain(t: number): boolean {
  return (t & TerrainFlag.Navigable) !== 0;
}

