// FRONT ULTRA — command mode: shared pieces of the player vehicle controllers (owner: command).

import * as THREE from 'three';
import type { CommandKind } from '../../shared/types';
import type { Effects } from '../fx/effects';
import type { Ground } from '../env/ground';
import type { CommandInput } from '../input';
import type { Ent, World } from '../world';

export interface WeaponSlot {
  key: string;
  /** i18n key for the label. */
  label: string;
  count: number;
  max: number;
  active: boolean;
  /** 0..1 ready fraction (1 = ready). */
  ready: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface HudState {
  kind: CommandKind;
  hp: number;
  maxHp: number;
  /** Compass heading of the view (rad, 0 = north, clockwise). */
  heading: number;
  /** Heading of the vehicle hull / nose. */
  hullHeading: number;
  /** Turret heading relative to the hull (tank / ship icon). */
  turretRel: number;
  speedKmh: number;
  altM: number;
  throttle: number;
  afterburner: boolean;
  telegraph: number;
  rudder: number;
  weapons: WeaponSlot[];
  /** Main weapon reload 0..1 (1 = loaded). */
  reload: number;
  rangeM: number;
  zoom: boolean;
  /** Where the gun actually points / where the nose is (screen px). */
  gun: ScreenPoint;
  /** Lead / impact prediction for the nearest target (screen px). */
  lead: ScreenPoint;
  /** Missile lock: 0 none, 1 locking, 2 locked. */
  lockState: number;
  lockProgress: number;
  lock: ScreenPoint;
  missileWarning: boolean;
  pullUp: boolean;
  stall: boolean;
  boundary: boolean;
  /** Direction (rad, screen) back toward the combat area when leaving it. */
  boundaryDir: number;
  pitch: number;
  roll: number;
  gLoad: number;
}

export function newHudState(kind: CommandKind): HudState {
  const sp = (): ScreenPoint => ({ x: 0, y: 0, visible: false });
  return {
    kind, hp: 1, maxHp: 1, heading: 0, hullHeading: 0, turretRel: 0, speedKmh: 0, altM: 0, throttle: 0, afterburner: false,
    telegraph: 0, rudder: 0, weapons: [], reload: 1, rangeM: 0, zoom: false, gun: sp(), lead: sp(), lockState: 0, lockProgress: 0,
    lock: sp(), missileWarning: false, pullUp: false, stall: false, boundary: false, boundaryDir: 0, pitch: 0, roll: 0, gLoad: 1,
  };
}

export interface ControllerCtx {
  world: World;
  ground: Ground;
  fx: Effects;
  camera: THREE.PerspectiveCamera;
  input: CommandInput;
  /** Mouse sensitivity multiplier (settings). */
  sens(): number;
  invertY(): boolean;
  /** Houses / obstacles (x, z, r) for ground collision. */
  obstacles: { x: number; z: number; r: number }[];
  shake(amount: number): void;
  /** Combat area radius (m). */
  radius: number;
  /** Viewport size in CSS px (for projecting HUD points). */
  viewW: number;
  viewH: number;
}

export interface Controller {
  readonly ent: Ent;
  readonly hud: HudState;
  /** Physics, input, weapons. dt already scaled (0 while frozen). */
  update(dt: number, allowInput: boolean): void;
  /** Place the camera (called after update, every frame even when frozen). */
  updateCamera(dt: number): void;
  /** Autopilot for staged shots / intro: aim at a target and optionally fire. */
  aimAt(p: THREE.Vector3): void;
  fire(): void;
}

const OC = new THREE.Vector3();
const CEN = new THREE.Vector3();
export interface RayHit {
  point: THREE.Vector3;
  dist: number;
  ent: Ent | null;
}

/** Raycast against entities (spheres) and the ground / sea surface. */
export function raycast(w: World, o: THREE.Vector3, d: THREE.Vector3, maxDist: number, ignore: Ent | null, out: RayHit): RayHit {
  let best = maxDist;
  let ent: Ent | null = null;
  for (const e of w.ents) {
    if (!e.alive || e === ignore) continue;
    w.center(e, CEN);
    OC.subVectors(o, CEN);
    const b = OC.dot(d);
    const c = OC.lengthSq() - e.radius * e.radius;
    const h = b * b - c;
    if (h < 0) continue;
    const t = -b - Math.sqrt(h);
    if (t > 0 && t < best) {
      best = t;
      ent = e;
    }
  }
  const g = w.ground;
  let t = 1.5;
  let prev = 0;
  while (t < best) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    if (y < g.surfaceAt(x, z)) {
      let lo = prev, hi = t;
      for (let i = 0; i < 8; i++) {
        const m = (lo + hi) * 0.5;
        const my = o.y + d.y * m;
        if (my < g.surfaceAt(o.x + d.x * m, o.z + d.z * m)) hi = m;
        else lo = m;
      }
      best = hi;
      ent = null;
      break;
    }
    prev = t;
    t += Math.max(2, t * 0.012);
  }
  out.dist = best;
  out.ent = ent;
  out.point.copy(o).addScaledVector(d, best);
  return out;
}

const PV = new THREE.Vector3();
/** Project a world point to CSS px. */
export function project(camera: THREE.Camera, p: THREE.Vector3, w: number, h: number, out: ScreenPoint): ScreenPoint {
  PV.copy(p).project(camera);
  out.visible = PV.z < 1 && PV.z > -1;
  out.x = (PV.x * 0.5 + 0.5) * w;
  out.y = (-PV.y * 0.5 + 0.5) * h;
  return out;
}
