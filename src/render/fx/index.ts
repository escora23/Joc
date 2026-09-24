// FRONT ULTRA — strategic-scale effects (owner: units).
// STUB by the architect: pooled additive spheres for explosions and a nuke flash sequence
// (post.flash + camera shake + expanding fireball + shockwave ring), driven by bus events.
// The units owner replaces it with the real FX (fireball, mushroom cloud, shockwave racing across the
// surface, smoke trails, tracers, burning cities...). Keep the export: createFx(ctx): FxApi.

import * as THREE from 'three';
import type { ExplosionKind, FrameInfo, FxApi, GameContext } from '../../shared/api';
import { UnitType } from '../../shared/types';
import { kmToUnits, latLonToVec3, tileXYToLatLon } from '../../shared/geo';

interface Blast {
  mesh: THREE.Mesh;
  t: number;
  life: number;
  maxScale: number;
}

const POOL = 48;

export function createFx(ctx: GameContext): FxApi {
  const root = new THREE.Group();
  root.name = 'fx';
  ctx.scene.add(root);
  const geo = new THREE.SphereGeometry(1, 24, 12);
  const pool: Blast[] = [];
  for (let i = 0; i < POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffaa55, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 50;
    root.add(mesh);
    pool.push({ mesh, t: 0, life: 0, maxScale: 0 });
  }
  let cursor = 0;

  function spawn(lat: number, lon: number, radiusUnits: number, life: number, color: number): void {
    const b = pool[cursor++ % POOL];
    latLonToVec3(lat, lon, 1, b.mesh.position);
    (b.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    b.t = 0;
    b.life = life;
    b.maxScale = radiusUnits;
    b.mesh.visible = true;
  }

  ctx.bus.on('nukeDetonated', (e) => {
    const ll = tileXYToLatLon(e.x, e.y);
    const big = e.weapon === UnitType.HydrogenBomb;
    const km = e.outerRadius * 25;
    spawn(ll.lat, ll.lon, kmToUnits(km * 0.35), big ? 5 : 3.5, 0xfff2cc);
    spawn(ll.lat, ll.lon, kmToUnits(km), big ? 8 : 6, 0xff7733);
    ctx.post.flash(big ? 1.6 : 0.9, big ? 2200 : 1400);
    ctx.cameraRig.shake(big ? 1 : 0.6, big ? 2500 : 1500);
  });

  const api: FxApi = {
    async init(progress) {
      progress(1);
    },
    warmup(on) {
      for (const b of pool) b.mesh.visible = on;
    },
    onGameEnd() {
      for (const b of pool) b.mesh.visible = false;
    },
    update(frame: FrameInfo) {
      for (const b of pool) {
        if (!b.mesh.visible) continue;
        b.t += frame.dt;
        const k = b.t / b.life;
        if (k >= 1) {
          b.mesh.visible = false;
          continue;
        }
        b.mesh.scale.setScalar(Math.max(1e-5, b.maxScale * Math.sqrt(k)));
        (b.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * (1 - k);
      }
    },
    explosion(lat: number, lon: number, sizeKm: number, _kind: ExplosionKind = 'medium') {
      spawn(lat, lon, kmToUnits(sizeKm), 1.2, 0xffaa55);
    },
    tracer() {},
  };
  return api;
}
