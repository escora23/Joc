// FRONT ULTRA — geographic conventions. THE single source of truth for tile <-> lat/lon <-> 3D.
// Owner: shared. Worker-safe (no three.js import; Vec3Like is satisfied by THREE.Vector3).
//
// Tile grid: MAP_W x MAP_H equirectangular. Tile (x, y): x = 0 at lon -180, y = 0 at lat +90.
//   tile index = y * MAP_W + x. x wraps horizontally, y clamps (no wrap over the poles).
//   Continuous tile coords (fx, fy): lon = fx / MAP_W * 360 - 180, lat = 90 - fy / MAP_H * 180.
//   The CENTER of tile (x, y) is (x + 0.5, y + 0.5).
//
// 3D: globe radius 1.0 == EARTH_RADIUS_KM, Three.js Y-up.
//   x = cos(lat) cos(lon),  y = sin(lat),  z = -cos(lat) sin(lon)
//   => lon 0 -> +X, lon +90 (E) -> -Z, lon -90 (W) -> +Z, north pole -> +Y.
//   This matches an unrotated THREE.SphereGeometry (default phi/theta) textured with the equirectangular
//   NASA maps (texture.flipY = true, default): verified numerically, max error 2e-7.

import {
  DAY_LENGTH_SEC, EARTH_RADIUS_KM, MAP_H, MAP_W, RELIEF_EXAGGERATION, SUBSOLAR_LAT_DEG, TOPO_MAX_METERS,
} from './constants';
import type { LatLon, TileXY, Vec3Like } from './types';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

// --- Tiles -------------------------------------------------------------------------------------

export function wrapX(x: number): number {
  return ((x % MAP_W) + MAP_W) % MAP_W;
}

/** Tile index from integer tile coords (x wraps, y clamps). */
export function tileIndex(x: number, y: number): number {
  const yy = y < 0 ? 0 : y >= MAP_H ? MAP_H - 1 : y;
  return yy * MAP_W + wrapX(x);
}

export function tileX(tile: number): number {
  return tile % MAP_W;
}

export function tileY(tile: number): number {
  return (tile / MAP_W) | 0;
}

/** Tile containing continuous tile coords (fx, fy). */
export function tileAtXY(fx: number, fy: number): number {
  return tileIndex(Math.floor(fx), Math.floor(fy));
}

export function tileXYToLatLon(fx: number, fy: number, out: LatLon = { lat: 0, lon: 0 }): LatLon {
  out.lon = (wrapX(fx) / MAP_W) * 360 - 180;
  out.lat = 90 - (fy / MAP_H) * 180;
  return out;
}

/** Lat/lon of the CENTER of a tile. */
export function tileToLatLon(tile: number, out: LatLon = { lat: 0, lon: 0 }): LatLon {
  return tileXYToLatLon(tileX(tile) + 0.5, tileY(tile) + 0.5, out);
}

export function latLonToTileXY(lat: number, lon: number, out: TileXY = { x: 0, y: 0 }): TileXY {
  out.x = wrapX(((lon + 180) / 360) * MAP_W);
  out.y = Math.min(MAP_H - 1e-6, Math.max(0, ((90 - lat) / 180) * MAP_H));
  return out;
}

export function latLonToTile(lat: number, lon: number): number {
  const fx = wrapX(((lon + 180) / 360) * MAP_W);
  const fy = ((90 - lat) / 180) * MAP_H;
  return tileIndex(Math.floor(fx), Math.floor(fy));
}

/** 4-neighbourhood with horizontal wrap. Writes into `out`, returns count (2..4). */
export function neighbors4(tile: number, out: Int32Array | number[]): number {
  const x = tile % MAP_W;
  const y = (tile / MAP_W) | 0;
  let n = 0;
  out[n++] = y * MAP_W + (x === 0 ? MAP_W - 1 : x - 1);
  out[n++] = y * MAP_W + (x === MAP_W - 1 ? 0 : x + 1);
  if (y > 0) out[n++] = tile - MAP_W;
  if (y < MAP_H - 1) out[n++] = tile + MAP_W;
  return n;
}

/** 8-neighbourhood with horizontal wrap. */
export function neighbors8(tile: number, out: Int32Array | number[]): number {
  const x = tile % MAP_W;
  const y = (tile / MAP_W) | 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= MAP_H) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      out[n++] = yy * MAP_W + wrapX(x + dx);
    }
  }
  return n;
}

/** Shortest signed horizontal difference b - a in tile units, honoring the wrap. */
export function wrapDX(ax: number, bx: number): number {
  let d = bx - ax;
  if (d > MAP_W / 2) d -= MAP_W;
  else if (d < -MAP_W / 2) d += MAP_W;
  return d;
}

/** Euclidean distance in tile units with horizontal wrap (NOT corrected for latitude; the sim uses this). */
export function tileDistance(a: number, b: number): number {
  const dx = wrapDX(tileX(a), tileX(b));
  const dy = tileY(b) - tileY(a);
  return Math.sqrt(dx * dx + dy * dy);
}

export function tileDistanceSq(a: number, b: number): number {
  const dx = wrapDX(tileX(a), tileX(b));
  const dy = tileY(b) - tileY(a);
  return dx * dx + dy * dy;
}

/** Relative real-world area of a tile in row y (cos(lat)). */
export function tileAreaWeight(y: number): number {
  return Math.cos((90 - ((y + 0.5) / MAP_H) * 180) * DEG);
}

// --- Sphere ------------------------------------------------------------------------------------

export function latLonToVec3<T extends Vec3Like>(lat: number, lon: number, radius: number, out: T): T {
  const la = lat * DEG;
  const lo = lon * DEG;
  const c = Math.cos(la);
  out.x = radius * c * Math.cos(lo);
  out.y = radius * Math.sin(la);
  out.z = -radius * c * Math.sin(lo);
  return out;
}

export function tileXYToVec3<T extends Vec3Like>(fx: number, fy: number, radius: number, out: T): T {
  const lon = (wrapX(fx) / MAP_W) * 360 - 180;
  const lat = 90 - (fy / MAP_H) * 180;
  return latLonToVec3(lat, lon, radius, out);
}

export function tileToVec3<T extends Vec3Like>(tile: number, radius: number, out: T): T {
  return tileXYToVec3(tileX(tile) + 0.5, tileY(tile) + 0.5, radius, out);
}

/** Inverse of latLonToVec3 (any radius). */
export function vec3ToLatLon(v: Vec3Like, out: LatLon = { lat: 0, lon: 0 }): LatLon {
  const r = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  out.lat = Math.asin(Math.max(-1, Math.min(1, v.y / r))) * RAD;
  out.lon = Math.atan2(-v.z, v.x) * RAD;
  return out;
}

/**
 * Local tangent frame at lat/lon: east, north, up unit vectors (world space).
 * Use it to orient units/terrain patches on the globe (e.g. makeBasis(east, up, -north) for a Y-up model).
 */
export function tangentFrame(lat: number, lon: number, east: Vec3Like, north: Vec3Like, up: Vec3Like): void {
  const la = lat * DEG;
  const lo = lon * DEG;
  const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  up.x = cl * co; up.y = sl; up.z = -cl * so;
  east.x = -so; east.y = 0; east.z = -co;
  north.x = -sl * co; north.y = cl; north.z = sl * so;
}

/** Great-circle distance in km. */
export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dp = p2 - p1, dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Spherical interpolation between two lat/lons (great-circle path). */
export function slerpLatLon(a: LatLon, b: LatLon, t: number, out: LatLon = { lat: 0, lon: 0 }): LatLon {
  const va = latLonToVec3(a.lat, a.lon, 1, { x: 0, y: 0, z: 0 });
  const vb = latLonToVec3(b.lat, b.lon, 1, { x: 0, y: 0, z: 0 });
  const dot = Math.max(-1, Math.min(1, va.x * vb.x + va.y * vb.y + va.z * vb.z));
  const om = Math.acos(dot);
  if (om < 1e-6) {
    out.lat = a.lat;
    out.lon = a.lon;
    return out;
  }
  const s = Math.sin(om);
  const ka = Math.sin((1 - t) * om) / s;
  const kb = Math.sin(t * om) / s;
  return vec3ToLatLon({ x: va.x * ka + vb.x * kb, y: va.y * ka + vb.y * kb, z: va.z * ka + vb.z * kb }, out);
}

// --- Scale & relief ------------------------------------------------------------------------------

export function kmToUnits(km: number): number {
  return km / EARTH_RADIUS_KM;
}

export function unitsToKm(u: number): number {
  return u * EARTH_RADIUS_KM;
}

/** Topology texture gray value (0..255) -> meters. The globe shader must use the same mapping. */
export function topoToMeters(gray: number): number {
  return (gray / 255) * TOPO_MAX_METERS;
}

/**
 * Radius (world units) of the rendered ground at a given real elevation. Water/negative = 1.0.
 * Globe displacement, battle terrain and unit placement MUST all use this so everything sits on the same surface.
 */
export function surfaceRadius(elevationMeters: number): number {
  return 1 + (Math.max(0, elevationMeters) * RELIEF_EXAGGERATION) / (EARTH_RADIUS_KM * 1000);
}

// --- Sun -----------------------------------------------------------------------------------------

/** Subsolar point for a world time (seconds). The sun moves westward: one revolution per DAY_LENGTH_SEC. */
export function subsolarPoint(worldTimeSec: number, out: LatLon = { lat: 0, lon: 0 }): LatLon {
  let lon = -(worldTimeSec / DAY_LENGTH_SEC) * 360;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  out.lat = SUBSOLAR_LAT_DEG;
  out.lon = lon;
  return out;
}

/** Unit vector from the planet center toward the sun (the globe itself never rotates). */
export function sunDirection<T extends Vec3Like>(worldTimeSec: number, out: T): T {
  const p = subsolarPoint(worldTimeSec, { lat: 0, lon: 0 });
  return latLonToVec3(p.lat, p.lon, 1, out);
}

/** World time at which the subsolar longitude equals `lon` (handy for shots: put noon over a place). */
export function worldTimeForSubsolarLon(lon: number): number {
  return (-lon / 360) * DAY_LENGTH_SEC;
}
