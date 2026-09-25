// FRONT ULTRA — ground battle: front activity seen from altitude (owner: battle).
// Between ~600 km and ~15 km the individual soldiers are sub-pixel, but the war must still read: along every
// active front near the view, artillery flashes wink on both sides of the contact line, fires glow in the
// villages, and smoke columns kilometres high drift downwind. Density follows each front's intensity and length.
// Uses its own anchor frame (re-anchored rarely) and its own particle pools/uniforms.

import * as THREE from 'three';
import { MAP_H, MAP_W, TILE_KM } from '../../shared/constants';
import { latLonToVec3, tangentFrame, tileXYToLatLon } from '../../shared/geo';
import type { FrontView, LatLon } from '../../shared/types';
import { FastRng, R_M, createBattleUniforms, type BattleUniforms } from './common';
import { PK, createParticlePool, type ParticlePool } from './particles';

export interface FarLayer {
  readonly group: THREE.Group;
  readonly uniforms: BattleUniforms;
  readonly alpha: ParticlePool;
  readonly add: ParticlePool;
  readonly sunView: THREE.Vector3;
  /** Anchor basis (world) for lighting updates. */
  readonly up: THREE.Vector3;
  readonly east: THREE.Vector3;
  readonly north: THREE.Vector3;
  update(now: number, dt: number, fronts: readonly FrontView[], target: LatLon, altKm: number, fade: number,
    avoid: LatLon | null, surfaceRadiusAt: (lat: number, lon: number) => number): void;
  clear(): void;
  setBudget(n: number): void;
  /** Violence of the visible far fronts 0..1. */
  readonly activity: number;
}

const DEG = Math.PI / 180;

export function createFarLayer(puff: THREE.Texture, budget: number): FarLayer {
  const uniforms = createBattleUniforms();
  uniforms.uGroundSoft.value = 0;
  const sunView: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0, 1) };
  const alpha = createParticlePool(uniforms, puff, false, Math.floor(budget * 0.5), sunView);
  const add = createParticlePool(uniforms, puff, true, Math.floor(budget * 0.5), sunView);
  const group = new THREE.Group();
  group.name = 'battle-far';
  group.add(alpha.mesh, add.mesh);
  const up = new THREE.Vector3(0, 1, 0), east = new THREE.Vector3(1, 0, 0), north = new THREE.Vector3(0, 0, -1);
  let anchor: LatLon | null = null;
  const inv = new THREE.Matrix4();
  const rng = new FastRng(4242);
  const w = new THREE.Vector3();
  const ll: LatLon = { lat: 0, lon: 0 };
  let activity = 0;
  const acc = new Map<number, { flash: number; smoke: number }>();

  function setAnchor(lat: number, lon: number): void {
    anchor = { lat, lon };
    tangentFrame(lat, lon, east, north, up);
    const m = new THREE.Matrix4().makeBasis(east, up, north.clone().negate());
    group.quaternion.setFromRotationMatrix(m);
    group.position.copy(up);
    group.scale.setScalar(1 / R_M);
    group.updateMatrixWorld(true);
    inv.copy(group.matrixWorld).invert();
    alpha.clear();
    add.clear();
  }

  /** Local position (anchor frame, meters) of a point on the ground + height (m). */
  function local(lat: number, lon: number, h: number, surf: number, out: THREE.Vector3): THREE.Vector3 {
    latLonToVec3(lat, lon, surf + h / R_M, w);
    return out.copy(w).applyMatrix4(inv);
  }

  const p = new THREE.Vector3();
  const layer: FarLayer = {
    group, uniforms, alpha, add, up, east, north,
    sunView: sunView.value,
    get activity() {
      return activity;
    },
    update(now, dt, fronts, target, altKm, fade, avoid, surfaceRadiusAt) {
      group.visible = fade > 0.001;
      uniforms.uFade.value = fade;
      if (!anchor || gcKm(anchor.lat, anchor.lon, target.lat, target.lon) > 900) setAnchor(target.lat, target.lon);
      if (fade <= 0.001) {
        activity = 0;
        return;
      }
      const range = Math.min(2600, Math.max(250, altKm * 3.5));
      // Sizes grow a little with altitude so the flashes stay legible.
      const sizeK = Math.min(3, Math.max(1, altKm / 120));
      let act = 0;
      for (const f of fronts) {
        const s = f.samples;
        const n = s.length / 2;
        if (n < 2) continue;
        tileXYToLatLon(f.x, f.y, ll);
        const dk = gcKm(ll.lat, ll.lon, target.lat, target.lon);
        if (dk > range + f.length * TILE_KM * 0.5) continue;
        const lenKm = Math.max(25, f.length * TILE_KM);
        const heat = 0.25 + 0.75 * f.intensity;
        act = Math.max(act, heat * Math.max(0, 1 - dk / (range * 1.5)));
        let a = acc.get(f.id);
        if (!a) {
          a = { flash: 0, smoke: 0 };
          acc.set(f.id, a);
        }
        a.flash += dt * fade * heat * (2 + Math.sqrt(lenKm) * 1.1);
        a.smoke += dt * fade * heat * (0.05 + Math.sqrt(lenKm) * 0.015);
        // Border normal (tile space): the advance direction.
        const nx = f.dirX, ny = f.dirY;
        let guard = 0;
        while ((a.flash >= 1 || a.smoke >= 1) && guard++ < 40) {
          const k = rng.int(n - 1);
          const t = rng.next();
          const tx = s[k * 2] + (s[k * 2 + 2] - s[k * 2]) * t;
          const ty = s[k * 2 + 1] + (s[k * 2 + 3] - s[k * 2 + 1]) * t;
          // Contact line is ~half a tile ahead of the attacker samples; spread shells over both sides.
          const side = rng.range(-0.55, 0.9) + rng.gauss() * 0.15;
          let fx = tx + nx * (0.5 + side * 0.5) + rng.gauss() * 0.15;
          const fy = Math.min(MAP_H - 1, Math.max(0, ty + ny * (0.5 + side * 0.5) + rng.gauss() * 0.15));
          fx = ((fx % MAP_W) + MAP_W) % MAP_W;
          tileXYToLatLon(fx, fy, ll);
          if (avoid && gcKm(ll.lat, ll.lon, avoid.lat, avoid.lon) < 11) {
            a.flash -= 1;
            continue;
          }
          const surf = surfaceRadiusAt(ll.lat, ll.lon);
          if (a.flash >= 1) {
            a.flash -= 1;
            local(ll.lat, ll.lon, 150, surf, p);
            const big = rng.chance(0.2);
            const t0 = now + rng.range(0, 0.3);
            add.emit(p.x, p.y, p.z, 0, 0, 0, rng.range(0.18, 0.4), (big ? 900 : 450) * sizeK, (big ? 1500 : 700) * sizeK, 0, 0, 1, 0.72, 0.4, big ? 60 : 30, PK.Flash, 0, 0, t0);
            if (rng.chance(0.35)) {
              add.emit(p.x, p.y, p.z, 0, 0, 0, rng.range(4, 9), 600 * sizeK, 900 * sizeK, 0, 0, 1, 0.42, 0.12, rng.range(3, 7), PK.Glow, 0, 0, t0);
            }
          } else {
            a.smoke -= 1;
            local(ll.lat, ll.lon, 400, surf, p);
            const g = rng.range(0.05, 0.12);
            alpha.emit(p.x, p.y, p.z, rng.range(-4, 4), rng.range(18, 34), rng.range(-4, 4), rng.range(40, 70), 700, rng.range(2000, 3500), 0.02, 0.2, g, g * 0.96, g * 0.92, 0.45, PK.Smoke, rng.range(0, 6), rng.range(-0.01, 0.01), now);
            // A fire at the plume's foot.
            add.emit(p.x, p.y - 250, p.z, 0, 0, 0, rng.range(20, 40), 700 * sizeK, 900 * sizeK, 0, 0, 1, 0.45, 0.14, 3.5, PK.Glow, 0, 0, now);
          }
        }
        if (a.flash > 5) a.flash = 5;
        if (a.smoke > 3) a.smoke = 3;
      }
      activity += (act - activity) * Math.min(1, dt * 2);
      alpha.flush();
      add.flush();
    },
    clear() {
      alpha.clear();
      add.clear();
      acc.clear();
      anchor = null;
      activity = 0;
    },
    setBudget(n) {
      alpha.resize(Math.floor(n * 0.5));
      add.resize(Math.floor(n * 0.5));
    },
  };
  return layer;
}

export function gcKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dp = p2 - p1, dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}
