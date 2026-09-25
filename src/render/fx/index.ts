// FRONT ULTRA — strategic-scale effects (owner: units).
// Owns the shared GPU particle system, ribbon trails, projectile tracers, burning emitters and the nuclear
// detonation showpiece. Reacts to sim events (combat, unit/structure destruction, nuke launch / intercept /
// detonation) and exposes FxApi (explosion, tracer) to other subsystems (battle).
// The units renderer (same owner) reaches the internals through `fxInternal(ctx)` to drive unit trails.

import * as THREE from 'three';
import type { ExplosionKind, FrameInfo, FxApi, GameContext } from '../../shared/api';
import { presentationTime } from '../../shared/shots';
import { EARTH_RADIUS_KM, MIN_VISUAL_PROJECTILE_SEC, MIN_VISUAL_SAM_SEC, NUKE_DEFS, TILE_KM } from '../../shared/constants';
import { greatCircleKm, latLonToVec3, tileAtXY, tileToLatLon, tileXYToLatLon } from '../../shared/geo';
import type { NukeWeapon } from '../../shared/protocol';
import { TerrainClass, TERRAIN_CLASS_MASK, UnitType, type LatLon } from '../../shared/types';
import { env, refreshEnv } from '../units/common';
import { NukeSystem, type NukeParams } from './nuke';
import { PK, ParticleSystem } from './particles';
import { createSpriteAtlas } from './sprites';
import { TrailSystem, type Trail, type TrailStyleKey } from './trails';

export interface FxInternal extends FxApi {
  readonly particles: ParticleSystem;
  readonly trails: TrailSystem;
  readonly nukes: NukeSystem;
  /** Explosion at an arbitrary world point (airbursts, aircraft kills). */
  explosionAt(p: THREE.Vector3, sizeKm: number, kind: ExplosionKind): void;
  /** A fast projectile streak between two world points (strafing, flak). */
  tracer3D(from: THREE.Vector3, to: THREE.Vector3, durationSec: number, arcKm: number, style?: TrailStyleKey, impact?: ExplosionKind | null, impactKm?: number): void;
  /** Keep a spot burning (fire + smoke) for a while. */
  burn(p: THREE.Vector3, sizeKm: number, seconds: number): void;
  /** Muzzle flash / launch flash. */
  flashAt(p: THREE.Vector3, sizeKm: number): void;
  /** Water splash (misses, sinking debris). */
  splash(p: THREE.Vector3, sizeKm: number): void;
  /** Size (km) with an on-screen floor in px at a world point. */
  visKm(p: THREE.Vector3, km: number, minPx: number): number;
  /** Age (s) of the most recent nuclear detonation, -1 if none active. */
  latestNukeAge(): number;
  /** Advance the effect clock (shots). */
  advance(seconds: number): void;
  /** Shots that jump the effect clock skip the (real-time) whiteout and camera shake. */
  quietScreen: boolean;
}

const registry = new WeakMap<object, FxInternal>();
export function fxInternal(ctx: GameContext): FxInternal | undefined {
  return registry.get(ctx);
}

interface Projectile {
  active: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  arc: number;
  trail: Trail | null;
  impact: ExplosionKind | null;
  impactKm: number;
}

interface Burner {
  active: boolean;
  p: THREE.Vector3;
  until: number;
  size: number;
  acc: number;
}

interface Pending {
  at: number;
  kind: 'explosion' | 'splash';
  p: THREE.Vector3;
  sizeKm: number;
  ek: ExplosionKind;
}

const MAX_PROJ = 256;
const MAX_BURN = 96;

export function createFx(ctx: GameContext): FxApi {
  const root = new THREE.Group();
  root.name = 'fx';
  ctx.scene.add(root);

  const atlas = createSpriteAtlas(256);
  const particles = new ParticleSystem(ctx.quality.particles, atlas);
  // Room for the 64 route lines of DESIGN_V2 §10.8 (up to 256 points each) on top of the effect trails.
  const trails = new TrailSystem(ctx.quality.particles >= 15000 ? 96000 : 64000);
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3();
  const up = new THREE.Vector3(), tA = new THREE.Vector3(), tB = new THREE.Vector3();
  const ll: LatLon = { lat: 0, lon: 0 };

  const nukes = new NukeSystem(ctx.quality.particles, atlas, {
    groundFire(x, y, z, sizeUnits, t) {
      const s = sizeUnits;
      up.set(x, y, z).normalize();
      const r = () => particles.rand() - 0.5;
      particles.emit(PK.Fire, x, y, z, up.x * s * 0.15 + r() * s * 0.1, up.y * s * 0.15 + r() * s * 0.1, up.z * s * 0.15 + r() * s * 0.1,
        0.9 + particles.rand() * 0.8, s * 0.18, s * 0.42, 1.5, s * 0.08);
      if (t > 1.5 && particles.rand() < 0.6) {
        particles.emit(PK.Smoke, x, y, z, up.x * s * 0.1, up.y * s * 0.1, up.z * s * 0.1, 5 + particles.rand() * 4, s * 0.2, s * 0.75, 0.5, s * 0.008);
      }
      if (particles.rand() < 0.5) {
        particles.emit(PK.Ember, x, y, z, r() * s * 0.4, r() * s * 0.4, r() * s * 0.4, 1 + particles.rand(), s * 0.06, s * 0.03, 1, 0);
      }
    },
  });
  root.add(nukes.group, particles.group, trails.group);

  const projectiles: Projectile[] = [];
  for (let i = 0; i < MAX_PROJ; i++) {
    projectiles.push({ active: false, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0, dur: 1, arc: 0, trail: null, impact: null, impactKm: 1 });
  }
  const burners: Burner[] = [];
  for (let i = 0; i < MAX_BURN; i++) burners.push({ active: false, p: new THREE.Vector3(), until: 0, size: 1, acc: 0 });
  const pending: Pending[] = [];
  const pendingPool: Pending[] = [];
  const camState = { lat: 0, lon: 0, altitudeKm: 0, tilt: 0, heading: 0 };

  // -----------------------------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------------------------
  function surfacePoint(lat: number, lon: number, out: THREE.Vector3, liftKm = 0): THREE.Vector3 {
    const r = ctx.globe.surfaceRadiusAt(lat, lon) + liftKm / EARTH_RADIUS_KM;
    return latLonToVec3(lat, lon, r, out);
  }

  function tilePoint(x: number, y: number, out: THREE.Vector3, liftKm = 0): THREE.Vector3 {
    tileXYToLatLon(x, y, ll);
    return surfacePoint(ll.lat, ll.lon, out, liftKm);
  }

  function isWaterXY(x: number, y: number): boolean {
    const w = ctx.world;
    if (!w) return false;
    const c = w.terrain[tileAtXY(x, y)] & TERRAIN_CLASS_MASK;
    return c === TerrainClass.Ocean || c === TerrainClass.Lake;
  }

  /** Visible size (km) with an on-screen floor so strategic-scale effects read from orbit. */
  function visKm(p: THREE.Vector3, km: number, minPx: number): number {
    // Live camera position: events can fire right after a camera cut, before env is refreshed.
    return Math.max(km, Math.min(km * 12, minPx * env.pixelK * ctx.camera.position.distanceTo(p) * EARTH_RADIUS_KM));
  }

  function schedule(delay: number, kind: Pending['kind'], p: THREE.Vector3, sizeKm: number, ek: ExplosionKind = 'medium'): void {
    const e = pendingPool.pop() ?? { at: 0, kind, p: new THREE.Vector3(), sizeKm, ek };
    e.at = env.fxTime + delay;
    e.kind = kind;
    e.p.copy(p);
    e.sizeKm = sizeKm;
    e.ek = ek;
    pending.push(e);
  }

  function randDir(out: THREE.Vector3, upBias: number): THREE.Vector3 {
    const R = () => particles.rand() * 2 - 1;
    out.set(R(), R(), R());
    if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
    out.normalize();
    out.addScaledVector(up, upBias);
    const dd = out.dot(up);
    if (upBias > 0 && dd < 0) out.addScaledVector(up, -dd * 1.2);
    return out.normalize();
  }

  // -----------------------------------------------------------------------------------------------
  // Effect recipes
  // -----------------------------------------------------------------------------------------------
  function explosionAt(p: THREE.Vector3, sizeKm: number, kind: ExplosionKind): void {
    const s = sizeKm / EARTH_RADIUS_KM;
    const d = particles.density;
    const R = () => particles.rand();
    up.copy(p).normalize();
    const air = kind === 'air';
    const naval = kind === 'naval';
    const big = kind === 'large' ? 1.6 : kind === 'small' ? 0.6 : 1;
    const n = (k: number) => Math.max(1, Math.round(k * d * big));
    particles.emit(PK.Flash, p.x, p.y, p.z, 0, 0, 0, 0.1 + 0.05 * big, s * 0.5, s * 1.0);
    for (let i = 0, c = n(9); i < c; i++) {
      randDir(tmp, air ? 0 : 0.2);
      const sp = s * (0.9 + R() * 1.4);
      particles.emit(PK.Fire, p.x, p.y, p.z, tmp.x * sp, tmp.y * sp, tmp.z * sp, 0.7 + R() * 0.9, s * 0.35, s * (0.8 + R() * 0.5), 3.2, s * 0.5, R() * 0.08);
    }
    for (let i = 0, c = n(10); i < c; i++) {
      randDir(tmp, air ? -0.5 : 0.35);
      const sp = s * (4 + R() * 6);
      particles.emit(PK.Spark, p.x, p.y, p.z, tmp.x * sp, tmp.y * sp, tmp.z * sp, 0.4 + R() * 0.5, s * 0.04, s * 0.02, 1.2, -s * 5);
    }
    if (naval) {
      for (let i = 0, c = n(10); i < c; i++) {
        randDir(tmp, 0.85);
        const sp = s * (3 + R() * 3);
        particles.emit(PK.Spray, p.x, p.y, p.z, tmp.x * sp, tmp.y * sp, tmp.z * sp, 1.3 + R() * 1.2, s * 0.25, s * 0.9, 1.5, -s * 4.5);
      }
    }
    for (let i = 0, c = n(air ? 5 : 8); i < c; i++) {
      randDir(tmp, air ? 0 : 0.5);
      const sp = s * (0.4 + R() * 0.6);
      particles.emit(PK.Smoke, p.x + tmp.x * s * 0.3, p.y + tmp.y * s * 0.3, p.z + tmp.z * s * 0.3,
        tmp.x * sp, tmp.y * sp, tmp.z * sp, 3 + R() * 3 * big, s * 0.3, s * (0.9 + 0.5 * R()), 0.8, s * 0.15, 0.15 + R() * 0.3);
    }
    if (!air && !naval) {
      for (let i = 0, c = n(5); i < c; i++) {
        randDir(tmp, 0.05);
        const sp = s * (1.5 + R() * 1.5);
        particles.emit(PK.Dust, p.x, p.y, p.z, tmp.x * sp, tmp.y * sp, tmp.z * sp, 2.5 + R() * 2, s * 0.4, s * 1.6, 2.0, s * 0.05, 0.05);
      }
    }
    if (kind === 'large' || air) {
      for (let i = 0, c = n(6); i < c; i++) {
        randDir(tmp, air ? -0.2 : 0.6);
        const sp = s * (3 + R() * 3);
        particles.emit(PK.Debris, p.x, p.y, p.z, tmp.x * sp, tmp.y * sp, tmp.z * sp, 1.2 + R(), s * 0.08, s * 0.05, 0.6, -s * 6);
      }
    }
  }

  function flashAt(p: THREE.Vector3, sizeKm: number): void {
    const s = sizeKm / EARTH_RADIUS_KM;
    particles.emit(PK.Fire, p.x, p.y, p.z, 0, 0, 0, 0.18, s * 0.35, s * 0.6);
    up.copy(p).normalize();
    particles.emit(PK.White, p.x, p.y, p.z, up.x * s * 0.5, up.y * s * 0.5, up.z * s * 0.5, 1.6, s * 0.4, s * 1.4, 1.2, s * 0.1);
  }

  function splash(p: THREE.Vector3, sizeKm: number): void {
    const s = sizeKm / EARTH_RADIUS_KM;
    up.copy(p).normalize();
    for (let i = 0; i < Math.max(2, Math.round(6 * particles.density)); i++) {
      randDir(tmp, 1.2);
      const sp = s * (2.5 + particles.rand() * 2);
      particles.emit(PK.Spray, p.x, p.y, p.z, tmp.x * sp, tmp.y * sp, tmp.z * sp, 1 + particles.rand(), s * 0.2, s * 0.7, 1.5, -s * 5);
    }
  }

  function burn(p: THREE.Vector3, sizeKm: number, seconds: number): void {
    let b = burners.find((x) => !x.active);
    if (!b) b = burners.reduce((a, c) => (a.until < c.until ? a : c));
    b.active = true;
    b.p.copy(p);
    b.until = env.fxTime + seconds;
    b.size = sizeKm / EARTH_RADIUS_KM;
    b.acc = 0;
  }

  function tracer3D(from: THREE.Vector3, to: THREE.Vector3, durationSec: number, arcKm: number, style: TrailStyleKey = 'tracer',
    impact: ExplosionKind | null = null, impactKm = 2): void {
    const pr = projectiles.find((x) => !x.active);
    if (!pr) return;
    pr.active = true;
    pr.from.copy(from);
    pr.to.copy(to);
    pr.t = 0;
    pr.dur = Math.max(0.05, durationSec);
    pr.arc = arcKm / EARTH_RADIUS_KM;
    pr.impact = impact;
    pr.impactKm = impactKm;
    pr.trail = trails.start(style, from.x, from.y, from.z);
  }

  function projectilePos(pr: Projectile, t: number, out: THREE.Vector3): THREE.Vector3 {
    out.lerpVectors(pr.from, pr.to, t);
    const r0 = pr.from.length(), r1 = pr.to.length();
    const r = r0 + (r1 - r0) * t + pr.arc * 4 * t * (1 - t);
    return out.normalize().multiplyScalar(r);
  }

  function launchPlume(p: THREE.Vector3, k: number): void {
    const km = visKm(p, 6 * k, 14);
    const s = km / EARTH_RADIUS_KM;
    up.copy(p).normalize();
    particles.emit(PK.Flash, p.x, p.y, p.z, 0, 0, 0, 0.5, s * 0.8, s * 1.6);
    for (let i = 0; i < Math.round(22 * particles.density * k + 6); i++) {
      randDir(tmp, 0.0);
      tmp.addScaledVector(up, -tmp.dot(up)).normalize();
      const sp = s * (0.8 + particles.rand() * 1.6);
      particles.emit(PK.White, p.x, p.y, p.z, tmp.x * sp + up.x * s * 0.2, tmp.y * sp + up.y * s * 0.2, tmp.z * sp + up.z * s * 0.2,
        6 + particles.rand() * 6, s * 0.3, s * 1.6, 0.7, s * 0.03, particles.rand() * 0.6);
    }
    for (let i = 0; i < Math.round(10 * particles.density + 3); i++) {
      const sp = s * (1.5 + particles.rand() * 2);
      particles.emit(PK.Fire, p.x, p.y, p.z, up.x * sp, up.y * sp, up.z * sp, 0.6 + particles.rand() * 0.4, s * 0.25, s * 0.5, 2.0, 0, i * 0.04);
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Nukes
  // -----------------------------------------------------------------------------------------------
  function nukeParams(weapon: NukeWeapon, inner: number, outer: number): NukeParams {
    const yieldK = weapon === UnitType.HydrogenBomb ? 1 : weapon === UnitType.AtomBomb ? 0.62 : weapon === UnitType.MirvWarhead ? 0.42 : 0.5;
    const def = NUKE_DEFS[weapon];
    const oT = outer > 0 ? outer : def.outerRadius;
    const iT = inner > 0 ? inner : def.innerRadius;
    return { yieldK, outerKm: oT * TILE_KM, innerKm: iT * TILE_KM * 0.55 };
  }

  function detonateNuke(p: THREE.Vector3, weapon: NukeWeapon, inner: number, outer: number, staggerIdx: number): void {
    const np = nukeParams(weapon, inner, outer);
    nukes.detonate(p, np);
    const s = (250 * Math.pow(np.yieldK, 0.75)) / EARTH_RADIUS_KM;
    particles.emit(PK.Flash, p.x, p.y, p.z, 0, 0, 0, 0.9, s * 0.3, s * 0.9);
    particles.emit(PK.Flash, p.x, p.y, p.z, 0, 0, 0, 0.3, s * 0.7, s * 1.5);
    up.copy(p).normalize();
    // Ground-hugging dust ring (base surge seeds).
    for (let i = 0; i < Math.round(18 * particles.density); i++) {
      randDir(tmp, 0);
      tmp.addScaledVector(up, -tmp.dot(up)).normalize();
      const sp = s * (0.25 + particles.rand() * 0.2);
      particles.emit(PK.Dust, p.x, p.y, p.z, tmp.x * sp, tmp.y * sp, tmp.z * sp, 6 + particles.rand() * 3, s * 0.03, s * 0.11, 0.6, 0, 0.3 + particles.rand() * 0.4);
    }
    // Screen: whiteout + shake, scaled by how directly and how close the camera sees it.
    tmp2.subVectors(ctx.camera.position, p);
    const distKm = tmp2.length() * EARTH_RADIUS_KM;
    const facing = up.dot(tmp2.normalize());
    tmp.copy(p).project(ctx.camera);
    const onScreen = facing > -0.05 && Math.abs(tmp.x) < 1.3 && Math.abs(tmp.y) < 1.3 && tmp.z < 1 ? 1 : 0.12;
    const near = Math.min(1.2, Math.max(0.04, 1800 / Math.max(300, distKm)));
    const k = np.yieldK * onScreen * near * (staggerIdx > 0 ? 0.35 : 1);
    if (k > 0.03 && !api.quietScreen) {
      ctx.post.flash(Math.min(1.25, 0.2 + k * 1.0), 500 + 1700 * np.yieldK * Math.min(1, k * 1.5));
      ctx.cameraRig.shake(Math.min(1, 0.15 + k * 0.85), 900 + 2600 * np.yieldK * Math.min(1, k * 1.5));
    }
  }

  let mirvBurst = 0;
  let mirvBurstAt = -100;

  // -----------------------------------------------------------------------------------------------
  // Bus
  // -----------------------------------------------------------------------------------------------
  ctx.bus.on('nukeDetonated', (e) => {
    tilePoint(e.x, e.y, tmp3);
    if (e.weapon === UnitType.CruiseMissile) {
      const km = visKm(tmp3, 14, 14);
      explosionAt(tmp3, km, 'large');
      burn(tmp3, km * 0.6, 14);
      return;
    }
    // MIRV salvos: keep the whiteout from strobing for every warhead.
    if (env.fxTime - mirvBurstAt > 3) mirvBurst = 0;
    mirvBurstAt = env.fxTime;
    detonateNuke(tmp3, e.weapon, e.innerRadius, e.outerRadius, e.weapon === UnitType.MirvWarhead ? mirvBurst++ : 0);
  });

  ctx.bus.on('nukeLaunched', (e) => {
    tileToLatLon(e.fromTile, ll);
    surfacePoint(ll.lat, ll.lon, tmp3);
    launchPlume(tmp3, e.weapon === UnitType.CruiseMissile ? 0.5 : e.weapon === UnitType.HydrogenBomb || e.weapon === UnitType.Mirv ? 1.2 : 1);
  });

  ctx.bus.on('nukeIntercepted', (e) => {
    // Airburst where the interceptor met the warhead (non-nuclear: blue-white kill flash, burning debris).
    const pos = tmp3;
    if (!ctx.units.getUnitWorldPosition(e.unitId, pos)) tilePoint(e.x, e.y, pos, 60);
    const km = visKm(pos, 10, 16);
    const s = km / EARTH_RADIUS_KM;
    particles.emit(PK.Blue, pos.x, pos.y, pos.z, 0, 0, 0, 0.5, s * 1.2, s * 3.2);
    explosionAt(pos, km, 'air');
    up.copy(pos).normalize();
    for (let i = 0; i < Math.round(8 * particles.density); i++) {
      randDir(tmp, -0.3);
      const sp = s * (2 + particles.rand() * 3);
      particles.emit(PK.Ember, pos.x, pos.y, pos.z, tmp.x * sp, tmp.y * sp, tmp.z * sp, 1.5 + particles.rand(), s * 0.12, s * 0.05, 0.5, -s * 2.5);
    }
  });

  ctx.bus.on('unitDestroyed', (e) => {
    const pos = tmp3;
    switch (e.unit) {
      case UnitType.Shell:
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
      case UnitType.Mirv:
      case UnitType.MirvWarhead:
        return;
    }
    if (!ctx.units.getUnitWorldPosition(e.unitId, pos)) tilePoint(e.x, e.y, pos);
    switch (e.unit) {
      case UnitType.Warship:
      case UnitType.TransportShip:
      case UnitType.TradeShip: {
        const km = visKm(pos, 3, 18);
        explosionAt(pos, km, 'naval');
        schedule(0.5, 'explosion', pos, km * 0.7, 'naval');
        burn(pos, km * 0.5, 9);
        break;
      }
      case UnitType.ArmoredDivision:
      case UnitType.Train: {
        const km = visKm(pos, 2, 14);
        explosionAt(pos, km, 'medium');
        burn(pos, km * 0.4, 6);
        break;
      }
      case UnitType.FighterSquadron:
      case UnitType.Bomber:
      case UnitType.DroneSwarm:
      case UnitType.CruiseMissile:
      case UnitType.SamInterceptor:
        explosionAt(pos, visKm(pos, 1.5, e.unit === UnitType.Bomber ? 16 : 11), 'air');
        break;
    }
  });

  ctx.bus.on('structureDestroyed', (e) => {
    tileToLatLon(e.tile, ll);
    surfacePoint(ll.lat, ll.lon, tmp3);
    const km = visKm(tmp3, 9, 20);
    explosionAt(tmp3, km, 'large');
    schedule(0.35, 'explosion', tmp3, km * 0.7, 'medium');
    burn(tmp3, km * 0.35, 22);
  });

  ctx.bus.on('combat', (e) => {
    if (ctx.app.state === 'command') return;
    switch (e.kind) {
      case 'shell': {
        // v2 (W1): the salvo resolves on the tick; draw the shell's flight for at least MIN_VISUAL_PROJECTILE_SEC.
        tilePoint(e.fromX, e.fromY, tmp3, 0.1);
        flashAt(tmp3, visKm(tmp3, 0.6, 5));
        tilePoint(e.fromX, e.fromY, tA, 0.1);
        tilePoint(e.toX, e.toY, tB, 0.05);
        {
          const dKm = tA.distanceTo(tB) * EARTH_RADIUS_KM;
          tracer3D(tA, tB, Math.max(MIN_VISUAL_PROJECTILE_SEC, Math.min(1.1, dKm / 300)), dKm * 0.12, 'shell', e.hit ? 'small' : null, visKm(tB, 1, 6));
        }
        break;
      }
      case 'sam': {
        tilePoint(e.fromX, e.fromY, tmp3, 0.2);
        const km = visKm(tmp3, 1.2, 7);
        flashAt(tmp3, km);
        // v2 (W1): the interception resolves on the tick; the streak is drawn for at least MIN_VISUAL_SAM_SEC.
        tilePoint(e.fromX, e.fromY, tA, 0.2);
        tilePoint(e.toX, e.toY, tB, 12);
        tracer3D(tA, tB, Math.max(MIN_VISUAL_SAM_SEC, Math.min(1.2, (tA.distanceTo(tB) * EARTH_RADIUS_KM) / 400)), 6, 'tracer', e.hit ? 'air' : null, visKm(tB, 1.5, 9));
        const s = km / EARTH_RADIUS_KM;
        up.copy(tmp3).normalize();
        for (let i = 0; i < 6; i++) {
          randDir(tmp, 0.1);
          particles.emit(PK.White, tmp3.x, tmp3.y, tmp3.z, tmp.x * s, tmp.y * s, tmp.z * s, 3 + particles.rand() * 2, s * 0.5, s * 2, 1.5, s * 0.05);
        }
        break;
      }
      case 'artillery': {
        tilePoint(e.fromX, e.fromY, tA, 0.1);
        flashAt(tA, visKm(tA, 0.5, 4));
        // Land artillery and (v2: resolved on the tick) naval shore bombardment get an arcing tracer.
        {
          tilePoint(e.toX, e.toY, tB, 0);
          const dKm = tA.distanceTo(tB) * EARTH_RADIUS_KM;
          tracer3D(tA, tB, Math.min(1.4, Math.max(MIN_VISUAL_PROJECTILE_SEC, dKm / 120)), dKm * 0.18, 'shell', 'small', visKm(tB, 1.2, 7));
        }
        break;
      }
      case 'bomb': {
        tilePoint(e.toX, e.toY, tmp3);
        schedule(0.2 + particles.rand() * 0.9, isWaterXY(e.toX, e.toY) ? 'splash' : 'explosion', tmp3, visKm(tmp3, 2.5, 10), 'medium');
        break;
      }
      case 'strafe': {
        // Air-to-air bursts between the dogfighting squadrons, at the rendered flight level.
        tilePoint(e.fromX, e.fromY, tA);
        const sizeKm = visKm(tA, 0.06, 20);
        const h = 14 + sizeKm * 1.6 + sizeKm * 0.25;
        tilePoint(e.fromX, e.fromY, tA, h);
        tilePoint(e.toX, e.toY, tB, h);
        const dur = Math.min(0.4, Math.max(0.12, (tA.distanceTo(tB) * EARTH_RADIUS_KM) / 400));
        tracer3D(tA, tB, dur, 0, 'tracer', null);
        break;
      }
    }
  });

  // -----------------------------------------------------------------------------------------------
  // API
  // -----------------------------------------------------------------------------------------------
  let lastUpdateFrame = -1;
  const api: FxInternal = {
    particles,
    trails,
    nukes,
    explosionAt,
    tracer3D,
    burn,
    flashAt,
    splash,
    visKm,
    latestNukeAge: () => nukes.latestAge(),
    quietScreen: false,
    advance(seconds: number) {
      const step = 1 / 30;
      for (let t = 0; t < seconds; t += step) {
        env.fxTime += step;
        particles.setTime(env.fxTime);
        trails.setTime(env.fxTime);
        nukes.update(step, env.camPos, ctx.camera);
      }
      particles.flush();
    },
    async init(progress) {
      progress(1);
    },
    setQuality(q) {
      // Buffers keep their boot-time capacity; the emission density follows the preset.
      particles.density = Math.min(1.5, Math.max(0.35, q.particles / 15000));
    },
    warmup(on) {
      particles.warmup(on);
      nukes.warmup(on);
      for (const o of [particles.group, trails.group, nukes.group]) o.visible = true;
    },
    onGameEnd() {
      particles.clear();
      trails.clear();
      nukes.clear();
      for (const p of projectiles) p.active = false;
      for (const b of burners) b.active = false;
      pending.length = 0;
    },
    update(frame: FrameInfo) {
      if (frame.frame === lastUpdateFrame) return;
      lastUpdateFrame = frame.frame;
      const paused = ctx.sim.running && ctx.sim.view.speed === 0;
      refreshEnv(frame.frame, ctx.camera, ctx.canvas, (o) => ctx.globe.getSunDirection(o), ctx.cameraRig.getState(camState).altitudeKm, presentationTime(frame.time), paused, frame.now);
      const now = env.fxTime;
      particles.setTime(now);
      trails.setTime(now);
      const dt = env.fxDt;

      // Delayed effects.
      for (let i = pending.length - 1; i >= 0; i--) {
        const e = pending[i];
        if (e.at > now) continue;
        if (e.kind === 'explosion') explosionAt(e.p, e.sizeKm, e.ek);
        else splash(e.p, e.sizeKm);
        pending[i] = pending[pending.length - 1];
        pending.pop();
        pendingPool.push(e);
      }

      if (dt > 0) {
        // Projectiles.
        for (const pr of projectiles) {
          if (!pr.active) continue;
          pr.t += dt / pr.dur;
          const t = Math.min(1, pr.t);
          projectilePos(pr, t, tmp);
          if (pr.trail) trails.push(pr.trail, tmp.x, tmp.y, tmp.z);
          if (pr.t >= 1) {
            pr.active = false;
            trails.release(pr.trail);
            pr.trail = null;
            if (pr.impact) explosionAt(pr.to, pr.impactKm, pr.impact);
          }
        }
        // Burning spots.
        for (const b of burners) {
          if (!b.active) continue;
          if (now > b.until) {
            b.active = false;
            continue;
          }
          const left = b.until - now;
          b.acc += dt * (left > 3 ? 14 : 5) * particles.density;
          const s = b.size;
          up.copy(b.p).normalize();
          // Prevailing wind (eastward, veering with latitude) bends the smoke into leaning plumes.
          tmp2.set(-up.z, 0, up.x);
          if (tmp2.lengthSq() < 1e-8) tmp2.set(1, 0, 0);
          tmp2.normalize().multiplyScalar(-s * 0.35);
          while (b.acc >= 1) {
            b.acc -= 1;
            const jx = (particles.rand() - 0.5) * s, jy = (particles.rand() - 0.5) * s, jz = (particles.rand() - 0.5) * s;
            if (particles.rand() < 0.6) {
              particles.emit(PK.Fire, b.p.x + jx, b.p.y + jy, b.p.z + jz, up.x * s * 0.4, up.y * s * 0.4, up.z * s * 0.4, 0.8 + particles.rand() * 0.6, s * 0.3, s * 0.6, 1.5, s * 0.4);
            }
            particles.emit(PK.Smoke, b.p.x + jx * 0.5, b.p.y + jy * 0.5, b.p.z + jz * 0.5, up.x * s * 1.3 + tmp2.x, up.y * s * 1.3 + tmp2.y, up.z * s * 1.3 + tmp2.z,
              6 + particles.rand() * 4, s * 0.12, s * 0.7, 0.08, s * 0.03);
          }
        }
      }
      nukes.update(dt, env.camPos, ctx.camera);
      trails.update();
      particles.flush();
    },
    explosion(lat: number, lon: number, sizeKm: number, kind: ExplosionKind = 'medium') {
      surfacePoint(lat, lon, tmp3, kind === 'air' ? Math.max(1, sizeKm * 2) : 0);
      explosionAt(tmp3, visKm(tmp3, sizeKm, 4), kind);
    },
    tracer(fromLat: number, fromLon: number, toLat: number, toLon: number, color?: number) {
      surfacePoint(fromLat, fromLon, tA, 0.05);
      surfacePoint(toLat, toLon, tB, 0);
      const dKm = greatCircleKm(fromLat, fromLon, toLat, toLon);
      const dur = Math.min(1.6, Math.max(0.3, dKm / 150));
      const pr = projectiles.find((x) => !x.active);
      tracer3D(tA, tB, dur, dKm * 0.15, 'shell', null);
      if (color !== undefined && pr?.trail) pr.trail.color.setHex(color).multiplyScalar(6);
    },
  };
  registry.set(ctx, api);
  if (import.meta.env.DEV) (window as unknown as { __fx?: FxInternal }).__fx = api;
  return api;
}
