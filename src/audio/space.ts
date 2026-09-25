// FRONT ULTRA — strategic-camera listener model (owner: audio).
// Turns a point on the globe into what the camera "hears": distance attenuation with a per-cue
// reference distance, air absorption (low-pass), stereo pan from the bearing relative to the camera
// heading, and occlusion when the point is below the horizon (behind the planet).

import type { CameraState } from '../shared/api';
import { greatCircleKm } from '../shared/geo';

const EARTH_KM = 6371;
const DEG = Math.PI / 180;

/** Distance (km) at which a cue is heard at roughly half level. */
export const CUE_REF_KM: Record<string, number> = {
  gunfire: 9, artillery: 70, explosionSmall: 45, explosionLarge: 180, tankCannon: 18, tankEngine: 4,
  navalGun: 70, jetFlyby: 30, jetCannon: 10, missileLaunch: 120, samLaunch: 60, nukeLaunch: 2500,
  shipHorn: 60, build: 2500, upgrade: 2500, capture: 3000, earthquake: 3000, thunder: 600, radar: 3000,
  eliminated: 6000, coins: 3000, attack: 8000,
};

export interface Heard {
  gain: number;
  pan: number;
  lowpass: number;
  /** 0 near .. 1 far (timbre). */
  dist: number;
  hidden: boolean;
  /** Straight-line distance, km. */
  km: number;
}

export function hear(cam: CameraState, lat: number, lon: number, refKm: number, out: Heard): Heard {
  const ground = greatCircleKm(cam.lat, cam.lon, lat, lon);
  const alt = Math.max(0.3, cam.altitudeKm);
  const km = Math.sqrt(ground * ground + alt * alt);
  const r = km / refKm;
  let gain = 1 / (1 + r * r);
  // Horizon: angular distance beyond acos(R / (R + h)) from the sub-camera point is hidden.
  const horizon = Math.acos(EARTH_KM / (EARTH_KM + alt));
  const hidden = ground / EARTH_KM > horizon + 0.02;
  const dist = km / (km + refKm);
  let lowpass = 300 + 17700 * (1 - dist) * (1 - dist);
  if (hidden) {
    gain *= 0.3;
    lowpass = Math.min(lowpass, 420);
  }
  // Bearing from the camera target to the point, relative to the camera heading (0 = north up).
  const p1 = cam.lat * DEG, p2 = lat * DEG, dl = (lon - cam.lon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const bearing = Math.atan2(y, x);
  const rel = bearing - cam.heading;
  const spread = Math.min(1, ground / (alt * 0.6 + 5));
  out.gain = gain;
  out.pan = Math.sin(rel) * spread * 0.85;
  out.lowpass = lowpass;
  out.dist = dist;
  out.hidden = hidden;
  out.km = km;
  return out;
}
