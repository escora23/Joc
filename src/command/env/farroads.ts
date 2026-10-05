// FRONT ULTRA — command mode: the road network seen from the travel camera (command gauntlet fix, DESIGN_V2 §9.5).
//
// The scene's own roads (civil.ts) are 7 m ribbons draped within a few km of the vehicle: from the travel camera
// (1 km up, looking tens of km ahead) they vanish and the villages read as unconnected dot-clouds. This layer draws
// every road between the towns in reach (civil.mapRoads, the same meanders) as a ribbon whose width grows with the
// distance from the camera, so it stays about 2.6 px wide (asphalt grey: it reads on dry plains and on fields alike) on screen at any range (never thinner than the real road).
// Shown only while the camera is high (travel mode at ×300 and up, or a jet); fogged like the ground.

import * as THREE from 'three';
import type { LocalFrame } from '../frame';
import type { Ground } from '../stream';

/** Target width on screen (px) and the real road's half width (m), the floor of the ribbon. */
const PX = 2.6;
const MIN_HALF_M = 4;
/** Points along a road for draping (m): a ribbon chord cutting through a crest hides it. */
const STEP_M = 120;
/** Lift over the ground (m). */
const LIFT_M = 3;

export class FarRoads {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly uPxAngle = { value: 0.001 };
  private sig = '';
  private builtAt = { x: 0, z: 0 };
  private chunksAt = -1;
  private drapedAt = 0;
  /** Tools: segments drawn. */
  segments = 0;

  constructor() {
    this.mat = new THREE.MeshBasicMaterial({ color: 0x47423b, fog: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const uPx = this.uPxAngle;
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uPxAngle = uPx;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 aDir;
attribute float aSide;
uniform float uPxAngle;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  float dist = length(cameraPosition - wp.xyz);
  vec2 n = normalize(vec2(-aDir.y, aDir.x));
  // Seen from a low angle the ribbon's width is foreshortened by the sine of the view's depression wherever it runs
  // across the line of sight (a road crossing the view at 10 km from 1 km up drew half a pixel): widen it by the
  // inverse of that foreshortening so it stays ~PX px wide on screen whatever its heading.
  vec2 vd = normalize(wp.xz - cameraPosition.xz + vec2(1e-3, 0.0));
  float sDep = clamp((cameraPosition.y - wp.y) / max(1.0, dist), 0.0, 1.0);
  float along = dot(n, vd), across = dot(n, vec2(-vd.y, vd.x));
  float fk = sqrt(across * across + along * along * sDep * sDep);
  float halfW = max(${MIN_HALF_M.toFixed(1)}, dist * uPxAngle * ${(PX / 2).toFixed(2)} / max(fk, 0.12));
  transformed.xz += n * aSide * halfW;
  // A little more lift far out, where the ground under the ribbon is a coarser level than the one drawn.
  transformed.y += dist * 0.0015;
}`);
    };
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.name = 'cmd-far-roads';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  /** Floating origin moved: the ribbon moves with the ground. */
  rebase(dx: number, dz: number): void {
    this.mesh.position.x -= dx;
    this.mesh.position.z -= dz;
  }

  /**
   * Per frame: shown when `show` (the camera is high); rebuilt when the road set changed or the vehicle moved far from
   * where it was built (heights come from the ground streamed around it).
   */
  update(roads: readonly number[][], frame: LocalFrame, ground: Ground, camera: THREE.PerspectiveCamera, viewH: number, show: boolean, ax: number, az: number): void {
    this.mesh.visible = show && roads.length > 0;
    if (!this.mesh.visible) return;
    // Radians per screen pixel (vertical).
    this.uPxAngle.value = ((camera.fov * Math.PI) / 180) / Math.max(1, viewH);
    const sig = `${roads.length}:${roads[0]?.[0] ?? 0}:${roads[roads.length - 1]?.[1] ?? 0}`;
    // The heights come from whatever terrain level is built under each point (the coarse horizon patch far out, a
    // few hundred metres off the mid level drawn later): re-drape once a second while new chunks keep arriving, or
    // the ribbon ends up buried under the hills (or floating) as the finer ground streams in.
    const now = performance.now();
    const redrape = ground.stats.built !== this.chunksAt && now - this.drapedAt > 1000;
    if (sig === this.sig && !redrape && Math.hypot(ax - this.builtAt.x, az - this.builtAt.z) < 6000) return;
    this.chunksAt = ground.stats.built;
    this.drapedAt = now;
    this.sig = sig;
    this.builtAt = { x: ax, z: az };
    this.build(roads, frame, ground);
  }

  private build(roads: readonly number[][], frame: LocalFrame, ground: Ground): void {
    const pos: number[] = [], dir: number[] = [], side: number[] = [], idx: number[] = [];
    let n = 0;
    let segs = 0;
    for (const line of roads) {
      // Resample along the polyline every STEP_M (absolute map metres), draped on the ground.
      const pts: number[] = [];
      for (let i = 0; i + 3 < line.length; i += 2) {
        const x0 = line[i], z0 = line[i + 1], x1 = line[i + 2], z1 = line[i + 3];
        const L = Math.hypot(x1 - x0, z1 - z0);
        const k = Math.max(1, Math.ceil(L / STEP_M));
        for (let q = i === 0 ? 0 : 1; q <= k; q++) pts.push(x0 + ((x1 - x0) * q) / k, z0 + ((z1 - z0) * q) / k);
      }
      const m = pts.length / 2;
      if (m < 2) continue;
      for (let q = 0; q < m; q++) {
        const sx = pts[q * 2] - frame.offX, sz = pts[q * 2 + 1] - frame.offZ;
        const h = ground.heightAt(sx, sz);
        const a = Math.max(0, q - 1), b = Math.min(m - 1, q + 1);
        let tx = pts[b * 2] - pts[a * 2], tz = pts[b * 2 + 1] - pts[a * 2 + 1];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const y = Math.max(0, h) + LIFT_M;
        for (const s of [-1, 1]) {
          pos.push(sx, y, sz);
          dir.push(tx, tz);
          side.push(s);
        }
        if (q > 0) {
          const p = n + (q - 1) * 2;
          // Counter-clockwise seen from above (the camera always looks down on it): the old order was clockwise, and
          // the whole layer was back-face culled.
          idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
          segs++;
        }
      }
      n += m * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 2));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    g.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.mesh.position.set(0, 0, 0);
    this.segments = segs;
  }

  clear(): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.BufferGeometry();
    this.mesh.visible = false;
    this.sig = '';
    this.chunksAt = -1;
  }
}
