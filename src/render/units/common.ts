// FRONT ULTRA — units/fx shared render environment & visual scale rules (owner: units).
// One per-frame snapshot of what every units/fx shader and CPU placement needs (camera position, the
// world-units-per-pixel factor, the sun), plus the pure functions that decide how big and how high a unit is
// drawn. Units and FX both use these so a tracer fired by a fighter starts exactly at the rendered jet.

import * as THREE from 'three';
import { EARTH_RADIUS_KM } from '../../shared/constants';
import { UnitType } from '../../shared/types';

export interface RenderEnv {
  /** Camera world position. */
  readonly camPos: THREE.Vector3;
  /** World units per screen pixel at distance 1 (multiply by distance). */
  pixelK: number;
  /** Direction to the sun (world, unit). */
  readonly sunDir: THREE.Vector3;
  /** Camera altitude above the surface at its target (km). */
  altitudeKm: number;
  /** Real seconds since boot. */
  time: number;
  /** FX clock: real seconds that stop while the game is paused. */
  fxTime: number;
  fxDt: number;
}

export const env: RenderEnv = {
  camPos: new THREE.Vector3(0, 0, 3),
  pixelK: 0.001,
  sunDir: new THREE.Vector3(1, 0, 0),
  altitudeKm: 10000,
  time: 0,
  fxTime: 0,
  fxDt: 0,
};

/** Shared uniform objects: every units/fx material references these very objects (one update per frame). */
export const sharedUniforms = {
  uSunDir: { value: env.sunDir },
  uPixelK: { value: 0.001 },
  uTime: { value: 0 },
  uFxTime: { value: 0 },
};

let lastEnvFrame = -1;
let lastNowMs = -1;
const tmpV = new THREE.Vector3();

/**
 * Refresh the environment once per frame (idempotent within a frame). The FX clock follows wall time (capped at
 * 0.25 s per frame so a hitch never skips a whole explosion) and stops while the game is paused, so effects stay in
 * step with the simulation even when frames are slow.
 */
export function refreshEnv(
  frameNo: number, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement, sun: (out: THREE.Vector3) => THREE.Vector3,
  altitudeKm: number, time: number, paused: boolean, nowMs: number,
): void {
  if (frameNo === lastEnvFrame) return;
  lastEnvFrame = frameNo;
  const dt = lastNowMs < 0 ? 0 : Math.min(0.25, Math.max(0, (nowMs - lastNowMs) / 1000));
  lastNowMs = nowMs;
  const fxDt = paused ? 0 : dt;
  env.camPos.setFromMatrixPosition(camera.matrixWorld);
  const h = Math.max(1, canvas.clientHeight || canvas.height || 900);
  env.pixelK = (2 * Math.tan((camera.fov * Math.PI) / 360)) / (h * Math.max(0.0001, camera.zoom));
  sun(tmpV);
  if (tmpV.lengthSq() > 0.5) env.sunDir.copy(tmpV).normalize();
  env.altitudeKm = altitudeKm;
  env.time = time;
  env.fxDt = fxDt;
  env.fxTime += fxDt;
  sharedUniforms.uPixelK.value = env.pixelK;
  sharedUniforms.uTime.value = time;
  sharedUniforms.uFxTime.value = env.fxTime;
}

export const km = (v: number): number => v / EARTH_RADIUS_KM;

/** World units per pixel at a world position. */
export function worldPerPixel(p: THREE.Vector3): number {
  return env.pixelK * env.camPos.distanceTo(p);
}

// -------------------------------------------------------------------------------------------------
// Unit visual scale: real size (km) and minimum on-screen size (px). Drawn size = max(real, minPx * wpp).
// -------------------------------------------------------------------------------------------------

export interface UnitLook {
  /** Real-ish model length in km (the floor when zoomed in). */
  realKm: number;
  /** Minimum on-screen length in pixels (readability from orbit). */
  minPx: number;
  /** Largest drawn size in km (so a jet never grows bigger than a country when far away). */
  maxKm: number;
}

export const UNIT_LOOK: Record<UnitType, UnitLook> = {
  [UnitType.TransportShip]: { realKm: 0.35, minPx: 40, maxKm: 110 },
  [UnitType.TradeShip]: { realKm: 0.4, minPx: 38, maxKm: 110 },
  [UnitType.Warship]: { realKm: 0.3, minPx: 46, maxKm: 130 },
  [UnitType.ArmoredDivision]: { realKm: 0.35, minPx: 30, maxKm: 80 },
  [UnitType.FighterSquadron]: { realKm: 0.06, minPx: 30, maxKm: 70 },
  [UnitType.Bomber]: { realKm: 0.09, minPx: 44, maxKm: 110 },
  [UnitType.DroneSwarm]: { realKm: 0.05, minPx: 16, maxKm: 36 },
  [UnitType.CruiseMissile]: { realKm: 0.03, minPx: 24, maxKm: 50 },
  [UnitType.AtomBomb]: { realKm: 0.04, minPx: 30, maxKm: 90 },
  [UnitType.HydrogenBomb]: { realKm: 0.05, minPx: 34, maxKm: 100 },
  [UnitType.Mirv]: { realKm: 0.05, minPx: 36, maxKm: 110 },
  [UnitType.MirvWarhead]: { realKm: 0.02, minPx: 16, maxKm: 44 },
  [UnitType.SamInterceptor]: { realKm: 0.02, minPx: 16, maxKm: 34 },
  [UnitType.Train]: { realKm: 0.12, minPx: 16, maxKm: 34 },
  [UnitType.Shell]: { realKm: 0.01, minPx: 6, maxKm: 10 },
};

/** Drawn length (km) of a unit at distance `distUnits` from the camera. */
export function unitSizeKm(type: UnitType, distUnits: number): number {
  const l = UNIT_LOOK[type];
  const px = l.minPx * env.pixelK * distUnits * EARTH_RADIUS_KM;
  return Math.min(l.maxKm, Math.max(l.realKm, px));
}

/** Ballistic apex (km) for a flight of `rangeKm`. */
export function ballisticApexKm(rangeKm: number): number {
  return Math.min(1300, Math.max(140, rangeKm * 0.3));
}

/**
 * Visual height (km above ground) of an airborne unit.
 * alt: the sim's 0..1 altitude fraction. sizeKm: drawn size (so a boosted icon never clips into the ground).
 * rangeKm: flight range (ballistic missiles / shells), apexKm override (interceptors matching their target).
 */
export function airHeightKm(type: UnitType, alt: number, sizeKm: number, rangeKm: number, apexKm = 0): number {
  switch (type) {
    case UnitType.AtomBomb:
    case UnitType.HydrogenBomb:
    case UnitType.Mirv:
    case UnitType.MirvWarhead:
      return alt * (apexKm > 0 ? apexKm : ballisticApexKm(rangeKm)) + sizeKm * 0.3;
    case UnitType.SamInterceptor:
      return apexKm > 0 ? alt * apexKm + sizeKm * 0.3 : alt * (30 + sizeKm * 1.5);
    case UnitType.Shell:
      return alt * Math.max(6, rangeKm * 0.45);
    case UnitType.CruiseMissile:
      return alt * (60 + sizeKm * 2) + sizeKm * 0.5;
    case UnitType.FighterSquadron:
    case UnitType.Bomber:
      return alt * (14 + sizeKm * 1.6) + sizeKm * 0.25;
    case UnitType.DroneSwarm:
      return alt * (8 + sizeKm * 1.8) + sizeKm * 0.4;
    default:
      return 0;
  }
}
