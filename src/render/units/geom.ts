// FRONT ULTRA — tiny procedural modeling kit for units & structures (owner: units).
// Primitives (box, cylinder, cone, sphere, extruded hulls, custom tris) are placed with a transform stack,
// painted with a base color and material masks, then merged into ONE non-indexed BufferGeometry per model:
//   position, normal, aColor (linear albedo), aMask (x = nation tint, y = night lights/windows, z = engine heat),
//   aH (0..1 normalized model height, drives the "under construction" hologram).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface PaintOpts {
  /** 0..1 how much of the nation color replaces the base color. */
  team?: number;
  /** Night light / window emission strength. */
  glow?: number;
  /** Always-on hot emission (engines, exhaust, warning lights). */
  heat?: number;
  /** Recompute faceted normals (low-poly look). */
  flat?: boolean;
}

const tmpColor = new THREE.Color();

export class ModelBuilder {
  private parts: THREE.BufferGeometry[] = [];
  private stack: THREE.Matrix4[] = [];
  private m = new THREE.Matrix4();
  private t = new THREE.Matrix4();

  push(): this {
    this.stack.push(this.m.clone());
    return this;
  }
  pop(): this {
    const m = this.stack.pop();
    if (m) this.m.copy(m);
    return this;
  }
  translate(x: number, y: number, z: number): this {
    this.m.multiply(this.t.makeTranslation(x, y, z));
    return this;
  }
  rotateX(a: number): this {
    this.m.multiply(this.t.makeRotationX(a));
    return this;
  }
  rotateY(a: number): this {
    this.m.multiply(this.t.makeRotationY(a));
    return this;
  }
  rotateZ(a: number): this {
    this.m.multiply(this.t.makeRotationZ(a));
    return this;
  }
  scale(x: number, y: number, z: number): this {
    this.m.multiply(this.t.makeScale(x, y, z));
    return this;
  }

  /** Add an arbitrary geometry (consumed) with a paint. */
  add(geo: THREE.BufferGeometry, color: number, o: PaintOpts = {}): this {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    g.applyMatrix4(this.m);
    if (o.flat) {
      g.deleteAttribute('normal');
      g.computeVertexNormals();
    }
    const n = g.getAttribute('position').count;
    tmpColor.setHex(color);
    const col = new Float32Array(n * 3);
    const mask = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = tmpColor.r;
      col[i * 3 + 1] = tmpColor.g;
      col[i * 3 + 2] = tmpColor.b;
      mask[i * 3] = o.team ?? 0;
      mask[i * 3 + 1] = o.glow ?? 0;
      mask[i * 3 + 2] = o.heat ?? 0;
    }
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aMask', new THREE.BufferAttribute(mask, 3));
    this.parts.push(g);
    return this;
  }

  /** Box centered at (x, y, z). */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, o: PaintOpts = {}): this {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return this.add(g, color, o);
  }

  /** Box resting on y (bottom at y). */
  block(w: number, h: number, d: number, x: number, y: number, z: number, color: number, o: PaintOpts = {}): this {
    return this.box(w, h, d, x, y + h / 2, z, color, o);
  }

  /** Vertical cylinder, bottom at y. */
  cyl(rTop: number, rBot: number, h: number, x: number, y: number, z: number, color: number, segs = 8, o: PaintOpts = {}): this {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, segs, 1, false);
    g.translate(x, y + h / 2, z);
    return this.add(g, color, o);
  }

  /** Cylinder along Z (forward axis), centered at (x, y, z). */
  cylZ(rFront: number, rBack: number, len: number, x: number, y: number, z: number, color: number, segs = 8, o: PaintOpts = {}): this {
    const g = new THREE.CylinderGeometry(rBack, rFront, len, segs, 1, false);
    // Cylinder axis is +Y (top = rTop = rBack); rotate so +Y -> -Z (front toward -Z).
    g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    return this.add(g, color, o);
  }

  sphere(r: number, x: number, y: number, z: number, color: number, ws = 8, hs = 6, o: PaintOpts = {}): this {
    const g = new THREE.SphereGeometry(r, ws, hs);
    g.translate(x, y, z);
    return this.add(g, color, o);
  }

  /** Half sphere dome resting on y. */
  dome(r: number, x: number, y: number, z: number, color: number, ws = 10, hs = 4, o: PaintOpts = {}): this {
    const g = new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, Math.PI / 2);
    g.translate(x, y, z);
    return this.add(g, color, o);
  }

  /**
   * Extruded convex outline (top view, points [x, z] counter-clockwise seen from above) from yBot to yTop.
   * The bottom ring is scaled by `bottomScale` toward the outline centroid (ship hull flare).
   */
  hull(outline: [number, number][], yBot: number, yTop: number, bottomScale: number, color: number, o: PaintOpts = {}): this {
    let cx = 0, cz = 0;
    for (const [x, z] of outline) {
      cx += x;
      cz += z;
    }
    cx /= outline.length;
    cz /= outline.length;
    const pos: number[] = [];
    const n = outline.length;
    const bot = outline.map(([x, z]) => [cx + (x - cx) * bottomScale, cz + (z - cz) * bottomScale]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [ax, az] = outline[i], [bx, bz] = outline[j];
      const [abx, abz] = bot[i], [bbx, bbz] = bot[j];
      // Wall quad (two tris), outward facing for a CCW-from-above outline.
      pos.push(ax, yTop, az, abx, yBot, abz, bbx, yBot, bbz);
      pos.push(ax, yTop, az, bbx, yBot, bbz, bx, yTop, bz);
      // Top cap (fan) and bottom cap.
      pos.push(cx, yTop, cz, ax, yTop, az, bx, yTop, bz);
      pos.push(cx, yBot, cz, bbx, yBot, bbz, abx, yBot, abz);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    fixWinding(g);
    g.computeVertexNormals();
    return this.add(g, color, { ...o, flat: false });
  }

  /** Triangular prism (roof, wedge): ridge along X, width along Z, from y to y+h. */
  prism(w: number, h: number, d: number, x: number, y: number, z: number, color: number, o: PaintOpts = {}): this {
    const hw = w / 2, hd = d / 2;
    const p = [
      // sloped faces
      -hw, 0, hd, hw, 0, hd, hw, h, 0, -hw, 0, hd, hw, h, 0, -hw, h, 0,
      hw, 0, -hd, -hw, 0, -hd, -hw, h, 0, hw, 0, -hd, -hw, h, 0, hw, h, 0,
      // gables
      -hw, 0, -hd, -hw, 0, hd, -hw, h, 0,
      hw, 0, hd, hw, 0, -hd, hw, h, 0,
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.translate(x, y, z);
    fixWinding(g);
    g.computeVertexNormals();
    return this.add(g, color, o);
  }

  /** Flat quad strip in XZ at height y (runways, markings). */
  plate(w: number, d: number, x: number, y: number, z: number, color: number, o: PaintOpts = {}): this {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    return this.add(g, color, o);
  }

  /** Thin wing/fin: triangle-ish polygon in the XZ plane (top view), thickness t. */
  wing(points: [number, number][], y: number, t: number, color: number, o: PaintOpts = {}): this {
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
    // Shape is in XY; extrude along +Z. Map shape Y -> model Z, extrusion -> model Y.
    g.rotateX(Math.PI / 2);
    g.translate(0, y + t / 2, 0);
    return this.add(g, color, { ...o, flat: true });
  }

  /** Vertical fin: polygon in the ZY plane (side view: [z, y]), thickness t along X. */
  fin(points: [number, number][], x: number, t: number, color: number, o: PaintOpts = {}): this {
    // Shape x = -z so that after the +90° Y rotation shape x lands on model +z; extrusion lands on model +X.
    const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(-z, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
    g.rotateY(Math.PI / 2);
    g.translate(x - t / 2, 0, 0);
    return this.add(g, color, { ...o, flat: true });
  }

  isEmpty(): boolean {
    return this.parts.length === 0;
  }

  /** Merge everything; computes aH from the model's vertical extent. */
  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    if (!merged) throw new Error('ModelBuilder: merge failed');
    for (const p of this.parts) p.dispose();
    this.parts = [];
    merged.computeBoundingBox();
    const bb = merged.boundingBox!;
    const pos = merged.getAttribute('position');
    const h = new Float32Array(pos.count);
    const span = Math.max(1e-6, bb.max.y - bb.min.y);
    for (let i = 0; i < pos.count; i++) h[i] = (pos.getY(i) - bb.min.y) / span;
    merged.setAttribute('aH', new THREE.BufferAttribute(h, 1));
    merged.computeBoundingSphere();
    return merged;
  }
}

/** Make every triangle of a non-indexed geometry face away from the geometry's centroid (robust winding). */
function fixWinding(g: THREE.BufferGeometry): void {
  if (g.index) return;
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), m = new THREE.Vector3(), ctr = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) ctr.x += p.getX(i), ctr.y += p.getY(i), ctr.z += p.getZ(i);
  ctr.multiplyScalar(1 / Math.max(1, p.count));
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    n.subVectors(b, a).cross(m.subVectors(c, a));
    m.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(ctr);
    if (n.dot(m) < 0) {
      p.setXYZ(i + 1, c.x, c.y, c.z);
      p.setXYZ(i + 2, b.x, b.y, b.z);
    }
  }
  p.needsUpdate = true;
}
