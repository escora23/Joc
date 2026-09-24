// FRONT ULTRA — terrain byte helpers (worker-safe). See types.ts TerrainClass / TerrainFlag.

import { TERRAIN_CLASS_MASK, TerrainClass, TerrainFlag, type TerrainClass as TC } from './types';

export function terrainClass(t: number): TC {
  return (t & TERRAIN_CLASS_MASK) as TC;
}

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

/** Elevation thresholds (meters) used by the data owner to classify land. */
export const HILLS_MIN_M = 600;
export const MOUNTAINS_MIN_M = 1800;
