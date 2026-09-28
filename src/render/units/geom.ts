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

  /**
   * Box whose top face is scaled (sloped sides): bottom w x d, top tw x td, from y to y + h, centered on (x, z).
   * Stealthy superstructures, bunkers, pyramids, hipped roofs.
   */
  frustum(w: number, d: number, tw: number, td: number, h: number, x: number, y: number, z: number, color: number, o: PaintOpts = {}): this {
    const a = w / 2, b = d / 2, c = tw / 2, e = td / 2;
    const B = [[-a, 0, -b], [a, 0, -b], [a, 0, b], [-a, 0, b]];
    const T = [[-c, h, -e], [c, h, -e], [c, h, e], [-c, h, e]];
    const p: number[] = [];
    const quad = (q: number[][]) => p.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quad([B[i], B[j], T[j], T[i]]);
    }
    quad([T[0], T[1], T[2], T[3]]);
    quad([B[3], B[2], B[1], B[0]]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.translate(x, y, z);
    fixWinding(g);
    return this.add(g, color, { ...o, flat: true });
  }

  /** A square-section rod of thickness t from point A to point B (lattice members, booms, masts, rails). */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, color: number, o: PaintOpts = {}): this {
    const A = new THREE.Vector3(ax, ay, az), Bv = new THREE.Vector3(bx, by, bz);
    const len = A.distanceTo(Bv);
    if (len < 1e-6) return this;
    const g = new THREE.BoxGeometry(t, len, t);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), Bv.clone().sub(A).normalize());
    g.applyQuaternion(q);
    g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    return this.add(g, color, { ...o, flat: true });
  }

  /** Surface of revolution around the vertical axis: profile [radius, y] bottom to top, centered on (x, y, z). */
  lathe(profile: [number, number][], x: number, y: number, z: number, color: number, segs = 12, o: PaintOpts = {}): this {
    const g = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(Math.max(r, 1e-5), h)), segs);
    g.translate(x, y, z);
    return this.add(g, color, o);
  }

  /**
   * Surface of revolution along the forward axis: profile [z, radius] from nose (most negative z) to tail, centered
   * on (x, y) with the section squashed vertically by `sy` (fuselages, missiles, pods).
   */
  latheZ(profile: [number, number][], x: number, y: number, color: number, segs = 10, sy = 1, o: PaintOpts = {}): this {
    // LatheGeometry revolves (r, h) around +Y; rotateX(+90°) sends +Y to +Z, so h = z.
    const g = new THREE.LatheGeometry(profile.map(([zz, r]) => new THREE.Vector2(Math.max(r, 1e-5), zz)), segs);
    g.rotateX(Math.PI / 2);
    g.scale(1, sy, 1);
    g.translate(x, y, 0);
    return this.add(g, color, o);
  }

  /**
   * A lofted ship hull band between yBot and yTop (so bands can be painted apart: anti-fouling, boot-top, topsides),
   * plus the deck surface when `deck` is set. `beam(t)` = half-beam at the deck for t = 0 (bow) .. 1 (stern);
   * `deckY(t)` = deck height (sheer); `flare` = half-beam at the keel as a fraction of the deck half-beam.
   * Bow at z = -len/2, stern at +len/2.
   */
  shipHull(spec: {
    len?: number; beam: (t: number) => number; deckY: (t: number) => number; keelY: number; flare: number;
    yBot: number; yTop: number; stations?: number; deck?: boolean; transom?: boolean;
  }, color: number, o: PaintOpts = {}): this {
    const n = spec.stations ?? 24;
    const L = spec.len ?? 1;
    const p: number[] = [];
    const halfW = (t: number, y: number): number => {
      const top = spec.deckY(t);
      const f = Math.min(1, Math.max(0, (y - spec.keelY) / Math.max(1e-6, top - spec.keelY)));
      return spec.beam(t) * (spec.flare + (1 - spec.flare) * Math.sqrt(f));
    };
    const rows = 2;
    const lvl = (t: number, r: number) => Math.min(spec.deckY(t), spec.yBot + ((spec.yTop - spec.yBot) * r) / rows);
    for (let i = 0; i < n; i++) {
      // Stations bunched toward the bow, where the hull curves.
      const t0 = Math.pow(i / n, 1.35), t1 = Math.pow((i + 1) / n, 1.35);
      const z0 = (t0 - 0.5) * L, z1 = (t1 - 0.5) * L;
      for (let r = 0; r < rows; r++) {
        const ya0 = lvl(t0, r), ya1 = lvl(t0, r + 1), yb0 = lvl(t1, r), yb1 = lvl(t1, r + 1);
        for (const side of [1, -1]) {
          const a = [side * halfW(t0, ya0), ya0, z0], b = [side * halfW(t1, yb0), yb0, z1];
          const c = [side * halfW(t1, yb1), yb1, z1], d = [side * halfW(t0, ya1), ya1, z0];
          if (side > 0) p.push(...a, ...c, ...b, ...a, ...d, ...c);
          else p.push(...a, ...b, ...c, ...a, ...c, ...d);
        }
      }
      if (spec.deck) {
        const ya = spec.deckY(t0), yb = spec.deckY(t1);
        const wa = halfW(t0, ya), wb = halfW(t1, yb);
        p.push(-wa, ya, z0, wb, yb, z1, wa, ya, z0, -wa, ya, z0, -wb, yb, z1, wb, yb, z1);
      }
    }
    if (spec.transom !== false) {
      const y0 = spec.yBot, y1 = Math.min(spec.deckY(1), spec.yTop);
      const w0 = halfW(1, y0), w1 = halfW(1, y1), z = 0.5 * L;
      p.push(-w0, y0, z, w0, y0, z, w1, y1, z, -w0, y0, z, w1, y1, z, -w1, y1, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.computeVertexNormals();
    return this.add(g, color, o);
  }

  /** Extruded polygon (top view [x, z], any winding, may be concave) from y to y + h: aprons, quays, walls. */
  slab(points: [number, number][], y: number, h: number, color: number, o: PaintOpts = {}): this {
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 4 });
    g.rotateX(Math.PI / 2);
    g.translate(0, y + h, 0);
    return this.add(g, color, { ...o, flat: true });
  }

  /**
   * Merge an already painted model (the output of another builder's build(), not consumed) under the current
   * transform, keeping its own paint: a naval yard's warships, a port's moored freighters.
   */
  merge(built: THREE.BufferGeometry): this {
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'aColor', 'aMask']) g.setAttribute(name, built.getAttribute(name).clone());
    g.applyMatrix4(this.m);
    this.parts.push(g);
    return this;
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
