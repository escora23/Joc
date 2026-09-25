// FRONT ULTRA — ground battle: CPU single-scattering atmosphere (owner: battle).
// The same physical model as the globe (Rayleigh + Mie, Chapman light depth, identical coefficients and shell),
// re-implemented on the CPU so the battlefield's sun color, sky ambient and aerial perspective are computed once
// per frame at the anchor and match the globe's shading at the patch rim (seamless horizon).

import * as THREE from 'three';
import { EARTH_RADIUS_KM } from '../../shared/constants';
import { smoothstep } from '../../shared/math';
import type { BattleUniforms } from './common';

const TOP = 1 + 95 / EARTH_RADIUS_KM;
const HR = 9.0 / EARTH_RADIUS_KM;
const HM = 1.6 / EARTH_RADIUS_KM;
const BR = [5.8e-6 * 6.371e6, 13.5e-6 * 6.371e6, 33.1e-6 * 6.371e6];
const BM = 1.3e-5 * 6.371e6;
const MIE_G = 0.78;
/** Globe shading constants this module mirrors (sun irradiance, sky inscatter gain). */
const SUN_E = 1.9;
const SKY_E = 7.5;

function chapman(X: number, h: number, cosZ: number): number {
  const c = Math.sqrt(X + h);
  if (cosZ >= 0) return (c / (c * cosZ + 1)) * Math.exp(-h);
  const x0 = Math.sqrt(Math.max(0, 1 - cosZ * cosZ)) * (X + h);
  const c0 = Math.sqrt(x0);
  return 2 * c0 * Math.exp(Math.min(X - x0, 60)) - (c / (1 - c * cosZ)) * Math.exp(-h);
}

function sunTrans(px: number, py: number, pz: number, L: THREE.Vector3, out: number[]): void {
  const r = Math.sqrt(px * px + py * py + pz * pz);
  const h = Math.max(r - 1, 0);
  const cosZ = (px * L.x + py * L.y + pz * L.z) / r;
  const odR = HR * chapman(1 / HR, h / HR, cosZ);
  const odM = HM * chapman(1 / HM, h / HM, cosZ);
  for (let k = 0; k < 3; k++) out[k] = Math.exp(-(BR[k] * odR + BM * 1.1 * odM));
}

function phaseR(mu: number): number {
  return 0.0596831 * (1 + mu * mu);
}
function phaseM(mu: number): number {
  const g2 = MIE_G * MIE_G;
  return (0.1193662 * (1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * MIE_G * mu, 1e-4), 1.5));
}

const ts = [0, 0, 0];
/** Inscatter & transmittance along ro + rd * [0, tMax] (world units). */
function integrate(ro: THREE.Vector3, rd: THREE.Vector3, tMax: number, L: THREE.Vector3, ins: THREE.Vector3, trans: THREE.Vector3, samples = 8): void {
  const b = ro.dot(rd);
  const c = ro.lengthSq() - TOP * TOP;
  const disc = b * b - c;
  ins.set(0, 0, 0);
  trans.set(1, 1, 1);
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  const t0 = Math.max(-b - sq, 0);
  const t1 = Math.min(-b + sq, tMax);
  if (t1 <= t0) return;
  const ds = (t1 - t0) / samples;
  let sRr = 0, sRg = 0, sRb = 0, sMr = 0, sMg = 0, sMb = 0;
  let odR = 0, odM = 0;
  for (let i = 0; i < samples; i++) {
    const t = t0 + (i + 0.5) * ds;
    const px = ro.x + rd.x * t, py = ro.y + rd.y * t, pz = ro.z + rd.z * t;
    const h = Math.max(Math.sqrt(px * px + py * py + pz * pz) - 1, 0);
    const dR = Math.exp(-h / HR) * ds;
    const dM = Math.exp(-h / HM) * ds;
    odR += dR * 0.5;
    odM += dM * 0.5;
    sunTrans(px, py, pz, L, ts);
    const tvr = Math.exp(-(BR[0] * odR + BM * 1.1 * odM));
    const tvg = Math.exp(-(BR[1] * odR + BM * 1.1 * odM));
    const tvb = Math.exp(-(BR[2] * odR + BM * 1.1 * odM));
    sRr += dR * tvr * ts[0]; sRg += dR * tvg * ts[1]; sRb += dR * tvb * ts[2];
    sMr += dM * tvr * ts[0]; sMg += dM * tvg * ts[1]; sMb += dM * tvb * ts[2];
    odR += dR * 0.5;
    odM += dM * 0.5;
  }
  const mu = rd.dot(L);
  const pr = phaseR(mu), pm = phaseM(mu);
  ins.set(sRr * BR[0] * pr + sMr * BM * pm, sRg * BR[1] * pr + sMg * BM * pm, sRb * BR[2] * pr + sMb * BM * pm);
  trans.set(
    Math.exp(-(BR[0] * odR + BM * 1.1 * odM)),
    Math.exp(-(BR[1] * odR + BM * 1.1 * odM)),
    Math.exp(-(BR[2] * odR + BM * 1.1 * odM)),
  );
}

const up = new THREE.Vector3();
const east = new THREE.Vector3();
const north = new THREE.Vector3();
const az = new THREE.Vector3();
const pt = new THREE.Vector3();
const rd = new THREE.Vector3();
const insS = new THREE.Vector3();
const trS = new THREE.Vector3();
const insA = new THREE.Vector3();
const trA = new THREE.Vector3();
const st = [0, 0, 0];

export interface AirState {
  /** Sun elevation sine at the anchor. */
  muS: number;
  /** Sun color (linear, HDR) at the anchor. */
  sun: THREE.Vector3;
}

/**
 * Update sun/sky/fog uniforms for an anchor (world-space unit vectors up/east/north of the anchor frame),
 * the world sun direction and the camera world position.
 */
export function updateAir(
  u: BattleUniforms,
  anchorUp: THREE.Vector3, anchorEast: THREE.Vector3, anchorNorth: THREE.Vector3,
  sunW: THREE.Vector3, camW: THREE.Vector3, altKm: number, out: AirState,
): void {
  up.copy(anchorUp);
  east.copy(anchorEast);
  north.copy(anchorNorth);
  // Sun in the local frame (+X east, +Y up, +Z south).
  const sx = sunW.dot(east), sy = sunW.dot(up), sz = -sunW.dot(north);
  u.uSunDir.value.set(sx, sy, sz).normalize();
  const muS = sy;
  out.muS = muS;

  // Sunlight at the ground (the globe evaluates it slightly above the surface; so do we).
  sunTrans(up.x * 1.0005, up.y * 1.0005, up.z * 1.0005, sunW, st);
  const geo = smoothstep(-0.1, 0.02, muS); // planet shadow
  u.uSunCol.value.set(st[0], st[1], st[2]).multiplyScalar(SUN_E * geo);
  out.sun.copy(u.uSunCol.value);

  // Sky ambient: the globe's model plus a little extra fill (the ground layer has no multiple scattering).
  const dayK = smoothstep(-0.2, 0.25, muS);
  const tw = Math.exp(-Math.pow((muS + 0.02) / 0.075, 2));
  const sky = u.uSkyCol.value;
  sky.set(0.07, 0.12, 0.24).multiplyScalar(dayK * 0.6 * 1.9).addScalar(0);
  sky.x += 0.016 * 1.6 + 0.22 * tw * 1.0 + st[0] * 0.05 * dayK;
  sky.y += 0.026 * 1.6 + 0.22 * tw * 0.42 + st[1] * 0.05 * dayK;
  sky.z += 0.055 * 1.6 + 0.22 * tw * 0.16 + st[2] * 0.05 * dayK;
  const g = u.uGndCol.value;
  const bounce = Math.max(muS, 0) * 0.07 * SUN_E * geo;
  g.set(sky.x * 0.35 + st[0] * bounce * 0.9, sky.y * 0.35 + st[1] * bounce * 0.75, sky.z * 0.35 + st[2] * bounce * 0.5);

  // Aerial perspective at a reference distance toward / away from the sun.
  const haze = 0.3 + 0.7 * smoothstep(80, 3000, altKm);
  // Reference points 8 km from the anchor toward / away from the sun; uFogRef becomes the camera's distance to them,
  // so shaders scale the reference transmittance by (distance / uFogRef) along the real viewing path (from orbit the
  // path to the ground is short in air mass, not 30x an 8 km ground-level path).
  const ref = 8000 / (EARTH_RADIUS_KM * 1000);
  let lenSum = 0;
  let hx = sx, hz = sz;
  const hl = Math.hypot(hx, hz);
  if (hl < 1e-4) { hx = 1; hz = 0; } else { hx /= hl; hz /= hl; }
  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? 1 : -1;
    // local (x east, z south) -> world
    az.copy(east).multiplyScalar(hx * sgn).addScaledVector(north, -hz * sgn);
    pt.copy(up).addScaledVector(az, ref);
    rd.copy(pt).sub(camW);
    const len = rd.length();
    lenSum += len;
    rd.multiplyScalar(1 / Math.max(len, 1e-9));
    if (side === 0) integrate(camW, rd, len, sunW, insS, trS);
    else integrate(camW, rd, len, sunW, insA, trA);
  }
  u.uFogRef.value = Math.max(1000, lenSum * 0.5 * EARTH_RADIUS_KM * 1000);
  u.uSunW.value.copy(sunW);
  u.uHazeK.value = haze;
  const k = SKY_E * haze;
  u.uFogSun.value.copy(insS).multiplyScalar(k);
  u.uFogAnti.value.copy(insA).multiplyScalar(k);
  u.uFogTrans.value.set(
    Math.pow((trS.x + trA.x) * 0.5, haze),
    Math.pow((trS.y + trA.y) * 0.5, haze),
    Math.pow((trS.z + trA.z) * 0.5, haze),
  );
}
