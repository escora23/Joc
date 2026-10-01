// FRONT ULTRA — command mode: the local map frame (owner: W5-command-v2).
//
// One projection per session: an equirectangular map around the entry point (origin lat0/lon0, longitude scaled by
// cos(lat0)), in meters, x = east, z = south (the scene convention; y = up, m above sea level). Every streamed chunk,
// town, road, border and unit is placed through it, and the controlled unit's position goes back to the sim through
// its exact inverse, so what you drive is where the strategic unit is. Distortion stays below 1 % within 150 km of
// the origin; the east scale drifts ~3 % after 300 km north or south, which only stretches the scenery a little.
//
// Floating origin: scene coordinates are `abs - offset`. The command mode rebases (shifts `offset` by whole chunks)
// when the vehicle strays from the scene origin, so float32 GPU math stays precise anywhere on a long drive.

import { EARTH_RADIUS_KM, MAP_H, MAP_W } from '../shared/constants';

const DEG = Math.PI / 180;
const M_PER_DEG = EARTH_RADIUS_KM * 1000 * DEG;

export class LocalFrame {
  lat0 = 0;
  lon0 = 0;
  cos0 = 1;
  /** Scene origin in absolute map meters (x east, z south). */
  offX = 0;
  offZ = 0;

  set(lat0: number, lon0: number): void {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.cos0 = Math.max(0.05, Math.cos(lat0 * DEG));
    this.offX = 0;
    this.offZ = 0;
  }

  /** Absolute map meters (east, south) of a lat/lon. Longitudes wrap to the nearest copy. */
  absOf(lat: number, lon: number, out: { x: number; z: number }): { x: number; z: number } {
    let dl = lon - this.lon0;
    if (dl > 180) dl -= 360;
    else if (dl < -180) dl += 360;
    out.x = dl * M_PER_DEG * this.cos0;
    out.z = -(lat - this.lat0) * M_PER_DEG;
    return out;
  }

  /** Scene coordinates of a lat/lon. */
  sceneOf(lat: number, lon: number, out: { x: number; z: number }): { x: number; z: number } {
    this.absOf(lat, lon, out);
    out.x -= this.offX;
    out.z -= this.offZ;
    return out;
  }

  /** Lat/lon of absolute map meters. */
  latLonOfAbs(x: number, z: number, out: { lat: number; lon: number }): { lat: number; lon: number } {
    out.lat = this.lat0 - z / M_PER_DEG;
    let lon = this.lon0 + x / (M_PER_DEG * this.cos0);
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    out.lon = lon;
    return out;
  }

  latLonOfScene(x: number, z: number, out: { lat: number; lon: number }): { lat: number; lon: number } {
    return this.latLonOfAbs(x + this.offX, z + this.offZ, out);
  }

  /** Continuous tile coords (sim convention: x east from lon −180, y south from lat 90). */
  tileOfScene(x: number, z: number, out: { x: number; y: number }): { x: number; y: number } {
    const ll = this.latLonOfScene(x, z, TMP_LL);
    out.x = (((ll.lon + 180) / 360) * MAP_W + MAP_W) % MAP_W;
    out.y = ((90 - ll.lat) / 180) * MAP_H;
    return out;
  }

  /** Scene coordinates of continuous tile coords. */
  sceneOfTile(tx: number, ty: number, out: { x: number; z: number }): { x: number; z: number } {
    return this.sceneOf(90 - (ty / MAP_H) * 180, (tx / MAP_W) * 360 - 180, out);
  }

  /** Compass heading (rad, 0 north, clockwise) from a scene yaw (model forward −Z rotated by yaw). */
  static headingOfYaw(yaw: number): number {
    const h = -yaw % (Math.PI * 2);
    return h < 0 ? h + Math.PI * 2 : h;
  }

  static yawOfHeading(heading: number): number {
    return -heading;
  }
}

const TMP_LL = { lat: 0, lon: 0 };
