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
  /** Verifiers: flashes emitted, the farthest one from its contact line (tiles), smoke columns standing per front. */
  stats(): { flashes: number; maxLineDistTiles: number; columns: Record<number, number> };
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
  let flashes = 0, maxLineDist = 0;
  const acc = new Map<number, { flash: number; smoke: number; cols: number[] }>();
  /** §11.4: at most this many smoke columns alive per front (they last 40-70 s). */
  const MAX_COLUMNS = 6;

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
      const sizeK = Math.min(6, Math.max(1, altKm / 55));
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
        const fk = f.key || f.id;
        let a = acc.get(fk);
        if (!a) {
          a = { flash: 0, smoke: 0, cols: [] };
          acc.set(fk, a);
        }
        // Columns still standing (expiry times).
        for (let c = a.cols.length - 1; c >= 0; c--) if (a.cols[c] <= now) a.cols.splice(c, 1);
        // Quiet fronts have no fighting: nothing burns or flashes along them.
        if (f.quiet) continue;
        a.flash += dt * fade * heat * (3 + Math.sqrt(lenKm) * 1.6);
        a.smoke += dt * fade * heat * (0.03 + Math.sqrt(lenKm) * 0.008);
        // Border normal (tile space): the advance direction. Most shells fall on the side losing ground.
        const nx = f.dirX, ny = f.dirY;
        const lean = Math.max(-1, Math.min(1, f.momentum));
        let guard = 0;
        while ((a.flash >= 1 || a.smoke >= 1) && guard++ < 40) {
          const k = rng.int(n - 1);
          const t = rng.next();
          const tx = s[k * 2] + (s[k * 2 + 2] - s[k * 2]) * t;
          const ty = s[k * 2 + 1] + (s[k * 2 + 3] - s[k * 2 + 1]) * t;
          // Contact line is ~half a tile ahead of the attacker samples; shells spread over both sides of it, inside the
          // band (at most ~0.9 tile from the line), leaning toward the side being pushed.
          const side = Math.max(-1.6, Math.min(1.6, rng.range(-0.9, 0.9) + lean * 0.45 + rng.gauss() * 0.15));
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
            // Distance from the contact line (sample + half a tile along dir), across the line.
            const lx = tx + nx * 0.5, ly = ty + ny * 0.5;
            let ddx = fx - lx;
            if (ddx > MAP_W / 2) ddx -= MAP_W;
            else if (ddx < -MAP_W / 2) ddx += MAP_W;
            flashes++;
            maxLineDist = Math.max(maxLineDist, Math.abs(ddx * nx + (fy - ly) * ny));
            local(ll.lat, ll.lon, 150, surf, p);
            const big = rng.chance(0.2);
            const t0 = now + rng.range(0, 0.3);
            add.emit(p.x, p.y, p.z, 0, 0, 0, rng.range(0.18, 0.4), (big ? 900 : 450) * sizeK, (big ? 1500 : 700) * sizeK, 0, 0, 1, 0.72, 0.4, big ? 60 : 30, PK.Flash, 0, 0, t0);
            if (rng.chance(0.45)) {
              // Burning ground left by the shell: a fading ember glow.
              add.emit(p.x, p.y, p.z, 0, 0, 0, rng.range(5, 12), 450 * sizeK, 700 * sizeK, 0, 0, 1, 0.42, 0.12, rng.range(2, 4), PK.Glow, 0, 0, t0);
            }
          } else {
            a.smoke -= 1;
            if (a.cols.length >= MAX_COLUMNS) continue;
            // A burning town or depot: a thin smoke column leaning downwind, a fire glowing at its foot.
            local(ll.lat, ll.lon, 300, surf, p);
            const g = rng.range(0.2, 0.3);
            const life = rng.range(40, 70);
            a.cols.push(now + life + 3);
            // Three puffs stacked (0.3-1 km), rising 8-14 m/s: the column tops out under 3 km; each puff ≤ 0.22 so a
            // column's summed opacity stays ≤ 0.35 (§11.4).
            for (let k = 0; k < 3; k++) {
              alpha.emit(p.x, p.y + k * 350, p.z, rng.range(-3, 3), rng.range(8, 14), rng.range(-3, 3), life, 450 + k * 150, rng.range(900, 1300), 0.02, 0.2, g, g * 0.96, g * 0.9, 0.2, PK.Smoke, rng.range(0, 6), rng.range(-0.01, 0.01), now + k * 1.5);
            }
            add.emit(p.x, p.y - 200, p.z, 0, 0, 0, rng.range(20, 40), 500 * sizeK, 700 * sizeK, 0, 0, 1, 0.45, 0.14, 3.5, PK.Glow, 0, 0, now);
          }
        }
        if (a.flash > 5) a.flash = 5;
        if (a.smoke > 3) a.smoke = 3;
      }
      activity += (act - activity) * Math.min(1, dt * 2);
      alpha.flush();
      add.flush();
    },
    stats() {
      const columns: Record<number, number> = {};
      for (const [k, a] of acc) columns[k] = a.cols.length;
      return { flashes, maxLineDistTiles: maxLineDist, columns };
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
