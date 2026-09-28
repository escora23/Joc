// FRONT ULTRA — missile launch plumes (DESIGN_V2 §10.12; owner: fx, built by W6).
//
// A launch leaves a column of exhaust smoke with a fire core at its foot. v1 sized it once, at launch, from the camera
// distance of that moment (visKm), so a plume launched while the camera was at 2,000 km stayed 170 km wide and filled the
// screen when the player zoomed in. Here the plume has a WORLD size that grows from 6 km at ignition to 20 km, and its
// drawn size is recomputed every frame: never smaller than a minimum on-screen size (so it reads from orbit), never
// taller than 8 % of the screen height, never larger than its world size unless the minimum-pixel rule asks for it.
// One instanced draw call of soft billboards (smoke puffs + the fire core), at most 8 plumes alive.

import * as THREE from 'three';
import { EARTH_RADIUS_KM } from '../../shared/constants';

const MAX_PLUMES = 8;
const PUFFS = 11;
/** Real seconds a plume lives (it fades over the last third). */
const LIFE_S = 36;
export const PLUME_START_KM = 6;
export const PLUME_MAX_KM = 20;
const GROW_S = 24;
/** Drawn column height never exceeds this share of the screen height, and never goes under PLUME_MIN_PX. */
export const PLUME_MAX_SCREEN = 0.08;
const PLUME_MIN_PX = 22;
/** Full drawn extent of the column (foot to the top of its highest puff) in units of its size. */
const PLUME_EXTENT = 1.5;

interface Plume {
  on: boolean;
  t: number;
  k: number;
  pos: THREE.Vector3;
  up: THREE.Vector3;
  /** Last frame: drawn size (km), world size (km) and the projected column height (px). */
  drawnKm: number;
  worldKm: number;
  heightPx: number;
  seed: number;
}

export interface PlumeStats {
  alive: number;
  plumes: { t: number; worldKm: number; drawnKm: number; heightPx: number; screenFrac: number }[];
}

const VERT = /* glsl */ `
attribute vec4 iPos;   // world centre xyz, radius (world units)
attribute vec4 iCol;   // rgb, alpha
attribute float iKind; // 0 smoke, 1 fire
varying vec2 vUv;
varying vec4 vCol;
varying float vKind;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
  mv.xy += position.xy * iPos.w;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  vCol = iCol;
  vKind = iKind;
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vCol;
varying float vKind;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = vKind > 0.5 ? pow(1.0 - r, 1.6) : smoothstep(1.0, 0.25, r) * (0.85 + 0.15 * sin(vUv.x * 7.0 + vUv.y * 5.0));
  vec3 c = vKind > 0.5 ? vCol.rgb * (1.0 + 1.5 * (1.0 - r)) : vCol.rgb;
  gl_FragColor = vec4(c, a * vCol.a);
}`;

export interface LaunchPlumes {
  readonly mesh: THREE.Mesh;
  launch(p: THREE.Vector3, k: number): void;
  /** Per frame: advance by dt real seconds (0 when paused) and size every plume for this camera. */
  update(dt: number, camera: THREE.PerspectiveCamera, screenH: number): void;
  clear(): void;
  stats(): PlumeStats;
}

export function createLaunchPlumes(): LaunchPlumes {
  const N = MAX_PLUMES * (PUFFS + 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  const iCol = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  const iKind = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
  for (const a of [iPos, iCol, iKind]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iCol', iCol);
  geo.setAttribute('iKind', iKind);
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    name: 'launch-plumes', vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 34;
  mesh.name = 'launch-plumes';

  const plumes: Plume[] = [];
  for (let i = 0; i < MAX_PLUMES; i++) {
    plumes.push({ on: false, t: 0, k: 1, pos: new THREE.Vector3(), up: new THREE.Vector3(), drawnKm: 0, worldKm: 0, heightPx: 0, seed: i * 0.37 });
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Vector3();
  const stats: PlumeStats = { alive: 0, plumes: [] };

  function project(v: THREE.Vector3, cam: THREE.PerspectiveCamera, h: number): number {
    q.copy(v).project(cam);
    return ((1 - q.y) / 2) * h;
  }

  return {
    mesh,
    launch(p, k) {
      let pl = plumes.find((x) => !x.on);
      if (!pl) pl = plumes.reduce((o, x) => (x.t > o.t ? x : o), plumes[0]);
      pl.on = true;
      pl.t = 0;
      pl.k = Math.max(0.5, Math.min(1.3, k));
      pl.pos.copy(p);
      pl.up.copy(p).normalize();
      pl.seed = (pl.seed + 0.618) % 1;
    },
    update(dt, cam, screenH) {
      const P = iPos.array as Float32Array, C = iCol.array as Float32Array, K = iKind.array as Float32Array;
      let n = 0;
      stats.alive = 0;
      stats.plumes.length = 0;
      const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
      for (const pl of plumes) {
        if (!pl.on) continue;
        pl.t += dt;
        if (pl.t > LIFE_S) {
          pl.on = false;
          continue;
        }
        // World size: 6 km at ignition growing to 20 km (a heavier missile a little larger, never above 20 km).
        const world = Math.min(PLUME_MAX_KM, (PLUME_START_KM + (PLUME_MAX_KM - PLUME_START_KM) * Math.min(1, pl.t / GROW_S)) * Math.min(1, pl.k));
        // Pixels per km at the plume (column height ≈ 1.1 × size).
        const dist = cam.position.distanceTo(pl.pos) * EARTH_RADIUS_KM;
        const pxPerKm = screenH / (2 * tanHalf * Math.max(1, dist));
        const maxKm = (PLUME_MAX_SCREEN * screenH) / (PLUME_EXTENT * pxPerKm);
        const minKm = PLUME_MIN_PX / pxPerKm;
        const size = Math.min(maxKm, Math.max(minKm, world));
        pl.worldKm = world;
        pl.drawnKm = size;
        const S = size / EARTH_RADIUS_KM;
        const fade = pl.t > LIFE_S * 0.66 ? 1 - (pl.t - LIFE_S * 0.66) / (LIFE_S * 0.34) : 1;
        const rise = Math.min(1, pl.t / 5);
        // Smoke column: puffs stacked up the column, widening and thinning with height, leaning slightly.
        for (let i = 0; i < PUFFS; i++) {
          const f = i / (PUFFS - 1);
          const hgt = f * 1.1 * S * rise;
          const lean = f * f * 0.12 * S;
          a.copy(pl.pos).addScaledVector(pl.up, hgt + S * 0.08);
          a.x += lean * Math.cos(pl.seed * 6.28);
          a.z += lean * Math.sin(pl.seed * 6.28);
          const r = S * (0.1 + 0.16 * f + 0.02 * Math.sin(i * 1.7 + pl.seed * 9));
          const o = n * 4;
          P[o] = a.x; P[o + 1] = a.y; P[o + 2] = a.z; P[o + 3] = r;
          const g = 0.82 - 0.2 * f;
          C[o] = g; C[o + 1] = g; C[o + 2] = g * 0.98; C[o + 3] = (0.55 - 0.3 * f) * fade;
          K[n] = 0;
          n++;
        }
        // Fire core at the foot (bright for the first seconds).
        const o = n * 4;
        a.copy(pl.pos).addScaledVector(pl.up, S * 0.06);
        P[o] = a.x; P[o + 1] = a.y; P[o + 2] = a.z; P[o + 3] = S * 0.16 * Math.max(0.25, 1 - pl.t / 8);
        C[o] = 1.0; C[o + 1] = 0.55; C[o + 2] = 0.2; C[o + 3] = Math.max(0, 1 - pl.t / 10) * fade;
        K[n] = 1;
        n++;
        // Measurement: the drawn column's projected height (foot to the top of the last puff).
        a.copy(pl.pos);
        b.copy(pl.pos).addScaledVector(pl.up, 1.1 * S * rise + S * 0.4);
        pl.heightPx = Math.abs(project(b, cam, screenH) - project(a, cam, screenH));
        stats.alive++;
        stats.plumes.push({ t: +pl.t.toFixed(2), worldKm: +world.toFixed(2), drawnKm: +size.toFixed(2), heightPx: Math.round(pl.heightPx), screenFrac: +(PLUME_EXTENT * size * pxPerKm / screenH).toFixed(4) });
      }
      geo.instanceCount = n;
      for (const at of [iPos, iCol, iKind]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, Math.max(1, n) * at.itemSize);
        at.needsUpdate = true;
      }
      mesh.visible = n > 0;
    },
    clear() {
      for (const pl of plumes) pl.on = false;
      geo.instanceCount = 0;
    },
    stats() {
      return stats;
    },
  };
}
