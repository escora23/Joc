// FRONT ULTRA — command mode: tiny procedural geometry kit (owner: command).
// Accumulates primitive parts (boxes, cylinders, extrusions, lathes) with per-vertex colors and merges them into
// one BufferGeometry (position, normal, color). Vehicles are a handful of merged parts, so each rigid piece of a
// model costs one draw call.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

export type Pt = [number, number];

export class GeoBuilder {
  private parts: THREE.BufferGeometry[] = [];

  /** Add a geometry transformed by position / euler rotation / scale, colored with `color` (sRGB hex) x shade. */
  add(
    g: THREE.BufferGeometry, color: number,
    x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1,
  ): this {
    let geo = g.index ? g.toNonIndexed() : g;
    if (geo === g) geo = g.clone();
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    tmpE.set(rx, ry, rz);
    tmpQ.setFromEuler(tmpE);
    tmpP.set(x, y, z);
    tmpS.set(sx, sy, sz);
    tmpM.compose(tmpP, tmpQ, tmpS);
    geo.applyMatrix4(tmpM);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    tmpC.setHex(color);
    for (let i = 0; i < n; i++) {
      col[i * 3] = tmpC.r;
      col[i * 3 + 1] = tmpC.g;
      col[i * 3 + 2] = tmpC.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(geo);
    return this;
  }

  box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx, ry, rz);
  }

  /** Cylinder along Y (use rx = PI/2 to lay it along Z). */
  cyl(rTop: number, rBot: number, h: number, seg: number, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), color, x, y, z, rx, ry, rz);
  }

  sphere(r: number, ws: number, hs: number, color: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): this {
    return this.add(new THREE.SphereGeometry(r, ws, hs), color, x, y, z, 0, 0, 0, sx, sy, sz);
  }

  /**
   * Side profile extruded across the width: profile points are (forward, up) with forward = -Z in the result;
   * extruded symmetric along X over `width`.
   */
  profileX(pts: Pt[], width: number, color: number, x = 0, y = 0, z = 0, bevel = 0): this {
    const shape = new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b)));
    const g = bevel > 0
      ? new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, steps: 1 })
      : new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, steps: 1 });
    g.translate(0, 0, -width / 2 + bevel);
    // shape x (forward) -> -Z, shape y -> Y, extrusion z -> X.
    g.rotateY(Math.PI / 2);
    return this.add(g, color, x, y, z);
  }

  /** Top-view outline (forward, right) extruded upward by `height` from y = 0; forward = -Z. */
  planY(pts: Pt[], height: number, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, bevel = 0): this {
    const shape = new THREE.Shape(pts.map(([f, r]) => new THREE.Vector2(r, f)));
    const g = bevel > 0
      ? new THREE.ExtrudeGeometry(shape, { depth: height - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, steps: 1 })
      : new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
    if (bevel > 0) g.translate(0, 0, bevel);
    // shape (x = right, y = forward), extrude +Z -> rotate so extrude goes +Y and forward goes -Z.
    g.rotateX(-Math.PI / 2);
    return this.add(g, color, x, y, z, rx, ry, rz);
  }

  /** Lathe along the forward axis (-Z): profile points (radius, forward). */
  latheZ(pts: Pt[], seg: number, color: number, x = 0, y = 0, z = 0, sx = 1, sy = 1): this {
    const g = new THREE.LatheGeometry(pts.map(([r, f]) => new THREE.Vector2(r, f)), seg);
    // lathe axis Y -> -Z
    g.rotateX(-Math.PI / 2);
    return this.add(g, color, x, y, z, 0, 0, 0, sx, sy, 1);
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = this.parts.length ? mergeGeometries(this.parts, false) : new THREE.BufferGeometry();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Multiply a hex color by a scalar (shade), clamped. */
export function shade(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}
