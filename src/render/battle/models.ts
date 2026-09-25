// FRONT ULTRA — ground battle: procedural low-poly models (owner: battle).
// Every model is built from boxes / cylinders / cones with two extra per-vertex channels in `aPart`:
//   x = part (bone) index animated in the vertex shader, y = material id colored in the fragment shader.
// Models face +Z, Y up, origin on the ground at their centre.

import * as THREE from 'three';

export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  part: number[] = [];

  private push(p: THREE.Vector3, n: THREE.Vector3, part: number, mat: number): void {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.part.push(part, mat);
  }

  /** Axis-aligned box (optionally transformed by m), skipping faces listed in `skip` (e.g. 'bottom'). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, part: number, mat: number, m?: THREE.Matrix4, skip: string[] = ['bottom'], taper = 1): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const faces: [string, number[], number[][]][] = [
      ['right', [1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
      ['left', [-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
      ['top', [0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
      ['bottom', [0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
      ['front', [0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
      ['back', [0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    ];
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const n = new THREE.Vector3();
    for (const [name, fn, corners] of faces) {
      if (skip.includes(name)) continue;
      for (let i = 0; i < 4; i++) {
        const c = corners[i];
        const t = c[1] > 0 ? taper : 1;
        v[i].set(cx + c[0] * hx * t, cy + c[1] * hy, cz + c[2] * hz * t);
        if (m) v[i].applyMatrix4(m);
      }
      // Face normal from geometry (handles taper).
      const e1 = v[1].clone().sub(v[0]), e2 = v[2].clone().sub(v[0]);
      n.crossVectors(e1, e2).normalize();
      if (n.lengthSq() < 0.5) {
        n.set(fn[0], fn[1], fn[2]);
        if (nm) n.applyMatrix3(nm).normalize();
      }
      this.push(v[0], n, part, mat); this.push(v[1], n, part, mat); this.push(v[2], n, part, mat);
      this.push(v[0], n, part, mat); this.push(v[2], n, part, mat); this.push(v[3], n, part, mat);
    }
  }

  /** Cylinder along an axis ('x' | 'y' | 'z') centred at c. */
  cyl(cx: number, cy: number, cz: number, r: number, len: number, axis: 'x' | 'y' | 'z', seg: number, part: number, mat: number, caps = true, m?: THREE.Matrix4, r2 = r): void {
    const mk = (a: number, h: number, rr: number): THREE.Vector3 => {
      const ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
      const p = axis === 'x' ? new THREE.Vector3(h, ca, sa) : axis === 'y' ? new THREE.Vector3(ca, h, sa) : new THREE.Vector3(ca, sa, h);
      p.x += cx; p.y += cy; p.z += cz;
      if (m) p.applyMatrix4(m);
      return p;
    };
    const nOf = (a: number): THREE.Vector3 => {
      const ca = Math.cos(a), sa = Math.sin(a);
      const n = axis === 'x' ? new THREE.Vector3(0, ca, sa) : axis === 'y' ? new THREE.Vector3(ca, 0, sa) : new THREE.Vector3(ca, sa, 0);
      if (m) n.transformDirection(m);
      return n;
    };
    const h0 = -len / 2, h1 = len / 2;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p00 = mk(a0, h0, r), p01 = mk(a0, h1, r2), p10 = mk(a1, h0, r), p11 = mk(a1, h1, r2);
      const n0 = nOf(a0), n1 = nOf(a1);
      // winding: outward
      const flip = axis !== 'y';
      if (!flip) {
        this.push(p00, n0, part, mat); this.push(p01, n0, part, mat); this.push(p11, n1, part, mat);
        this.push(p00, n0, part, mat); this.push(p11, n1, part, mat); this.push(p10, n1, part, mat);
      } else {
        this.push(p00, n0, part, mat); this.push(p11, n1, part, mat); this.push(p01, n0, part, mat);
        this.push(p00, n0, part, mat); this.push(p10, n1, part, mat); this.push(p11, n1, part, mat);
      }
      if (caps) {
        const c0 = mk(0, h0, 0), c1 = mk(0, h1, 0);
        const ax = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
        if (m) ax.transformDirection(m);
        const nax = ax.clone().negate();
        if (!flip) {
          this.push(c1, ax, part, mat); this.push(p11, ax, part, mat); this.push(p01, ax, part, mat);
          this.push(c0, nax, part, mat); this.push(p00, nax, part, mat); this.push(p10, nax, part, mat);
        } else {
          this.push(c1, ax, part, mat); this.push(p01, ax, part, mat); this.push(p11, ax, part, mat);
          this.push(c0, nax, part, mat); this.push(p10, nax, part, mat); this.push(p00, nax, part, mat);
        }
      }
    }
  }

  /** Cone (y axis) from base radius r at y0 to apex at y1. */
  cone(cx: number, cz: number, y0: number, y1: number, r: number, seg: number, part: number, mat: number, rTop = 0): void {
    const slope = (r - rTop) / (y1 - y0);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const b0 = new THREE.Vector3(cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r);
      const b1 = new THREE.Vector3(cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r);
      const t0 = new THREE.Vector3(cx + Math.cos(a0) * rTop, y1, cz + Math.sin(a0) * rTop);
      const t1 = new THREE.Vector3(cx + Math.cos(a1) * rTop, y1, cz + Math.sin(a1) * rTop);
      const n0 = new THREE.Vector3(Math.cos(a0), slope, Math.sin(a0)).normalize();
      const n1 = new THREE.Vector3(Math.cos(a1), slope, Math.sin(a1)).normalize();
      this.push(b0, n0, part, mat); this.push(t1, n1, part, mat); this.push(b1, n1, part, mat);
      if (rTop > 0) {
        this.push(b0, n0, part, mat); this.push(t0, n0, part, mat); this.push(t1, n1, part, mat);
      } else {
        // apex normal averaged
      }
      // underside
      const nd = new THREE.Vector3(0, -1, 0);
      const c = new THREE.Vector3(cx, y0, cz);
      this.push(c, nd, part, mat); this.push(b0, nd, part, mat); this.push(b1, nd, part, mat);
    }
  }

  /** Low-poly blob (icosahedron, jittered) for tree crowns. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, part: number, mat: number, seed: number, detail = 1): void {
    const ico = new THREE.IcosahedronGeometry(1, detail);
    const p = ico.getAttribute('position');
    const tmp = new THREE.Vector3();
    const verts: THREE.Vector3[] = [];
    for (let i = 0; i < p.count; i++) {
      tmp.fromBufferAttribute(p, i);
      const j = 0.85 + 0.3 * frac(Math.sin(tmp.x * 12.9 + tmp.y * 78.2 + tmp.z * 37.7 + seed) * 43758.5);
      verts.push(new THREE.Vector3(cx + tmp.x * rx * j, cy + tmp.y * ry * j, cz + tmp.z * rz * j));
    }
    for (let i = 0; i < verts.length; i += 3) {
      const a = verts[i], b = verts[i + 1], c = verts[i + 2];
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      // blend with spherical normal for softer shading
      const sn = a.clone().add(b).add(c).multiplyScalar(1 / 3).sub(new THREE.Vector3(cx, cy, cz)).normalize();
      n.lerp(sn, 0.5).normalize();
      this.push(a, n, part, mat); this.push(b, n, part, mat); this.push(c, n, part, mat);
    }
    ico.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 2));
    return g;
  }
}

function frac(x: number): number {
  return x - Math.floor(x);
}

// ------------------------------------------------------------------------------------------------------------
// Infantry
// ------------------------------------------------------------------------------------------------------------

/** Soldier bones: 0 torso/head, 1 leg L, 2 leg R, 3 arm L, 4 arm R, 5 rifle. Materials: 0 uniform, 1 helmet,
 *  2 skin, 3 boots, 4 gear, 5 weapon. Arms/legs are modelled hanging straight down from their pivots. */
export const SOLDIER_PIVOTS = {
  hipY: 0.9,
  legX: 0.1,
  shoulderY: 1.46,
  shoulderX: 0.25,
};

export function soldierGeometry(): THREE.BufferGeometry {
  // 7 boxes, ~70 triangles: boots, hands, helmet, webbing and pack are colored in the fragment shader.
  const b = new GeoBuilder();
  const P = SOLDIER_PIVOTS;
  b.box(-P.legX, 0.46, 0.01, 0.16, 0.9, 0.2, 1, 0);
  b.box(P.legX, 0.46, 0.01, 0.16, 0.9, 0.2, 2, 0);
  b.box(0, 1.19, -0.03, 0.42, 0.62, 0.32, 0, 0);
  b.box(0, 1.645, 0.0, 0.25, 0.3, 0.27, 0, 1, undefined, ['bottom'], 0.85);
  b.box(-P.shoulderX, 1.15, 0, 0.11, 0.64, 0.12, 3, 0);
  b.box(P.shoulderX, 1.15, 0, 0.11, 0.64, 0.12, 4, 0);
  // Rifle in its own frame: grip at origin, barrel along +Z.
  b.box(0, 0, 0.12, 0.055, 0.11, 0.95, 5, 5);
  return b.build();
}

// ------------------------------------------------------------------------------------------------------------
// Vehicles. Parts: 0 hull, 1 turret (yaw), 2 barrel (yaw + pitch + recoil), 3 main rotor, 4 tail rotor, 5 wheels.
// Materials: 0 body paint, 1 dark metal/tracks, 2 detail/light metal, 3 glass/optics, 4 rubber, 5 team marking.
// ------------------------------------------------------------------------------------------------------------

export const VehicleKind = {
  Tank: 0,
  Apc: 1,
  Artillery: 2,
  AntiAir: 3,
  Heli: 4,
  Truck: 5,
} as const;
export type VehicleKind = (typeof VehicleKind)[keyof typeof VehicleKind];

/** Turret pivot (y, z) and barrel pivot per vehicle kind (model space). */
export const VEHICLE_PIVOTS: Record<VehicleKind, { turretZ: number; barrelY: number; barrelZ: number }> = {
  [VehicleKind.Tank]: { turretZ: -0.3, barrelY: 2.05, barrelZ: 1.2 },
  [VehicleKind.Apc]: { turretZ: 0.4, barrelY: 2.75, barrelZ: 1.0 },
  [VehicleKind.Artillery]: { turretZ: -0.6, barrelY: 2.35, barrelZ: 1.4 },
  [VehicleKind.AntiAir]: { turretZ: -0.3, barrelY: 2.4, barrelZ: 0.8 },
  [VehicleKind.Heli]: { turretZ: 3.6, barrelY: 0.9, barrelZ: 3.6 },
  [VehicleKind.Truck]: { turretZ: 0, barrelY: 0, barrelZ: 0 },
};

function tracks(b: GeoBuilder, len: number, halfW: number): void {
  for (const s of [-1, 1]) {
    b.box(s * halfW, 0.48, 0, 0.66, 0.78, len, 0, 1, undefined, ['bottom']);
    // road wheels hint
    for (let i = 0; i < 6; i++) {
      const z = -len / 2 + 0.7 + (i * (len - 1.4)) / 5;
      b.cyl(s * (halfW + 0.34), 0.45, z, 0.36, 0.06, 'x', 8, 0, 4, true);
    }
    // side skirt
    b.box(s * (halfW + 0.02), 0.95, 0.1, 0.72, 0.22, len - 0.4, 0, 0, undefined, ['bottom']);
  }
}

export function tankGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  tracks(b, 7.0, 1.45);
  // Hull
  b.box(0, 1.1, -0.2, 2.3, 0.75, 6.4, 0, 0);
  // Glacis (sloped front plate)
  const g = new THREE.Matrix4().makeRotationX(-0.95).setPosition(0, 1.0, 3.25);
  b.box(0, 0, 0, 2.3, 0.2, 1.3, 0, 0, g, []);
  // Engine deck details
  b.box(0, 1.5, -2.6, 2.1, 0.08, 1.2, 0, 1, undefined, []);
  b.box(-1.0, 1.52, -1.4, 0.3, 0.1, 0.8, 0, 2);
  // Turret (part 1): angular wedge turret
  const P = VEHICLE_PIVOTS[VehicleKind.Tank];
  b.box(0, 1.85, P.turretZ, 2.7, 0.62, 3.2, 1, 0, undefined, ['bottom'], 0.86);
  b.box(0, 1.8, P.turretZ + 1.75, 2.0, 0.5, 0.6, 1, 0, undefined, ['bottom'], 0.7);
  b.box(0, 1.85, P.turretZ - 2.0, 2.3, 0.5, 0.9, 1, 0);
  b.box(0.65, 2.28, P.turretZ - 0.3, 0.55, 0.28, 0.55, 1, 1);
  b.box(-0.7, 2.24, P.turretZ + 0.4, 0.4, 0.22, 0.45, 1, 3);
  b.box(0, 1.85, P.turretZ - 2.35, 1.6, 0.3, 0.2, 1, 5, undefined, []); // team marking on the bustle
  // Barrel (part 2): along +Z from the mantlet.
  b.box(0, P.barrelY - 0.02, P.barrelZ + 0.3, 0.7, 0.45, 0.6, 2, 0);
  b.cyl(0, P.barrelY, P.barrelZ + 3.0, 0.09, 5.0, 'z', 8, 2, 1, true);
  b.cyl(0, P.barrelY, P.barrelZ + 2.2, 0.15, 0.8, 'z', 8, 2, 1, true);
  return b.build();
}

export function apcGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  // Wheels (4 per side)
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      b.cyl(s * 1.35, 0.6, -2.4 + i * 1.55, 0.6, 0.45, 'x', 10, 5, 4, true);
    }
  }
  b.box(0, 1.55, -0.1, 2.9, 1.5, 7.4, 0, 0, undefined, ['bottom'], 0.9);
  const g = new THREE.Matrix4().makeRotationX(-0.8).setPosition(0, 1.55, 3.85);
  b.box(0, 0, 0, 2.6, 0.2, 1.4, 0, 0, g, []);
  b.box(0, 2.35, -2.8, 2.2, 0.12, 1.2, 0, 1);
  const P = VEHICLE_PIVOTS[VehicleKind.Apc];
  b.box(0, 2.55, P.turretZ, 1.5, 0.5, 1.7, 1, 0, undefined, ['bottom'], 0.8);
  b.box(0.45, 2.85, P.turretZ - 0.3, 0.3, 0.2, 0.3, 1, 3);
  b.box(0, 2.1, -3.6, 1.8, 0.4, 0.1, 0, 5, undefined, []);
  b.cyl(0, P.barrelY, P.barrelZ + 1.5, 0.05, 2.4, 'z', 6, 2, 1, true);
  return b.build();
}

export function artilleryGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  tracks(b, 6.8, 1.45);
  b.box(0, 1.1, 0, 2.3, 0.8, 6.6, 0, 0);
  const g = new THREE.Matrix4().makeRotationX(-0.9).setPosition(0, 1.05, 3.35);
  b.box(0, 0, 0, 2.3, 0.2, 1.0, 0, 0, g, []);
  const P = VEHICLE_PIVOTS[VehicleKind.Artillery];
  // Big boxy turret
  b.box(0, 2.1, P.turretZ, 3.0, 1.3, 3.8, 1, 0, undefined, ['bottom'], 0.94);
  b.box(0, 2.1, P.turretZ - 2.1, 2.2, 0.9, 0.5, 1, 1);
  b.box(0, 2.3, P.turretZ - 2.4, 1.8, 0.4, 0.1, 1, 5, undefined, []);
  b.box(-1.1, 2.85, P.turretZ + 0.2, 0.5, 0.3, 0.6, 1, 2);
  // Long barrel with a muzzle brake
  b.box(0, P.barrelY, P.barrelZ + 0.3, 0.8, 0.6, 0.7, 2, 0);
  b.cyl(0, P.barrelY, P.barrelZ + 4.2, 0.12, 7.6, 'z', 8, 2, 1, true);
  b.box(0, P.barrelY, P.barrelZ + 8.0, 0.42, 0.3, 0.5, 2, 1);
  return b.build();
}

export function antiAirGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  tracks(b, 6.6, 1.4);
  b.box(0, 1.1, 0, 2.2, 0.8, 6.4, 0, 0);
  const P = VEHICLE_PIVOTS[VehicleKind.AntiAir];
  b.box(0, 1.95, P.turretZ, 2.3, 1.0, 2.6, 1, 0, undefined, ['bottom'], 0.9);
  // Radar dishes
  b.box(0, 2.8, P.turretZ - 1.0, 1.4, 0.7, 0.12, 1, 2);
  b.box(0, 2.6, P.turretZ + 1.1, 0.9, 0.5, 0.1, 1, 1);
  b.box(0, 1.95, P.turretZ - 1.4, 1.6, 0.3, 0.1, 1, 5, undefined, []);
  // Twin cannons on the sides
  for (const s of [-1, 1]) {
    b.box(s * 1.35, P.barrelY, P.barrelZ, 0.45, 0.55, 1.4, 2, 0);
    b.cyl(s * 1.35, P.barrelY, P.barrelZ + 2.2, 0.06, 3.0, 'z', 6, 2, 1, true);
  }
  return b.build();
}

export function heliGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  // Fuselage (narrow tandem attack helicopter), model origin = centre of mass.
  b.box(0, 0, 0.6, 1.3, 1.6, 5.2, 0, 0, undefined, [], 0.75);
  b.box(0, 0.35, 3.3, 0.9, 1.0, 1.6, 0, 3, undefined, [], 0.7); // canopy
  b.box(0, -0.1, 4.3, 0.6, 0.7, 0.8, 0, 0, undefined, []); // nose
  b.box(0, 0.25, -2.2, 0.55, 0.55, 6.0, 0, 0, undefined, []); // tail boom
  b.box(0, 1.0, -5.0, 0.2, 1.8, 1.0, 0, 0, undefined, []); // fin
  b.box(0, 0.35, -4.2, 2.2, 0.08, 0.6, 0, 0, undefined, []); // stabilizer
  b.box(0, 1.0, 0.3, 0.9, 0.6, 1.8, 0, 1, undefined, []); // engines
  // Stub wings + rocket pods
  b.box(0, -0.05, 0.4, 4.2, 0.12, 1.0, 0, 0, undefined, []);
  for (const s of [-1, 1]) {
    b.cyl(s * 1.7, -0.45, 0.5, 0.25, 1.6, 'z', 8, 0, 1, true);
    b.cyl(s * 1.1, -0.45, 0.5, 0.2, 1.4, 'z', 6, 0, 2, true);
  }
  b.box(0, -0.2, -1.2, 1.0, 0.3, 0.6, 0, 5, undefined, []);
  // Landing skids
  for (const s of [-1, 1]) b.box(s * 0.9, -1.1, 0.5, 0.1, 0.1, 3.6, 0, 1, undefined, []);
  // Chin gun (part 2)
  b.cyl(0, -0.75, 4.2, 0.05, 1.2, 'z', 6, 2, 1, true);
  // Main rotor (part 3): 4 blades around the mast at y = 1.45
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Matrix4().makeRotationY((i * Math.PI) / 2);
    b.box(0, 1.45, 3.3, 0.5, 0.05, 6.6, 3, 1, m, []);
  }
  b.cyl(0, 1.3, 0, 0.14, 0.4, 'y', 6, 3, 1, true);
  // Tail rotor (part 4): in the YZ plane at the fin
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Matrix4().makeRotationX((i * Math.PI) / 2).setPosition(0.2, 1.2, -5.2);
    b.box(0, 0, 0, 0.04, 2.4, 0.22, 4, 1, m, []);
  }
  return b.build();
}

export function truckGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (const s of [-1, 1]) {
    for (const z of [2.2, -0.9, -2.2]) b.cyl(s * 1.05, 0.5, z, 0.5, 0.35, 'x', 8, 5, 4, true);
  }
  b.box(0, 0.95, 0, 2.2, 0.35, 7.0, 0, 1);
  b.box(0, 1.9, 2.55, 2.3, 1.6, 1.9, 0, 0, undefined, ['bottom'], 0.95);
  b.box(0, 2.25, 3.5, 2.0, 0.6, 0.05, 0, 3, undefined, []);
  b.box(0, 2.1, -1.1, 2.4, 1.9, 4.6, 0, 2); // canvas cover
  b.box(0, 1.2, -3.45, 1.4, 0.35, 0.05, 0, 5, undefined, []);
  return b.build();
}

// ------------------------------------------------------------------------------------------------------------
// Buildings: unit house (x,z in [-0.5,0.5], walls y in [0,1], gable roof y in [1, 1 + roofScale]).
// Parts: 0 walls, 1 roof (scaled by roof height), 2 chimney. Materials: 0 wall, 1 roof, 2 trim/door.
// ------------------------------------------------------------------------------------------------------------

export function houseGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.box(0, 0.5, 0, 1, 1, 1, 0, 0, undefined, ['bottom']);
  // Gable roof: two sloped quads + two gable triangles, overhanging a little.
  const o = 0.06;
  const quads: [number[], number[], number[], number[], number[]][] = [
    [[-0.5 - o, 1, -0.5 - o], [-0.5 - o, 1, 0.5 + o], [0, 2, 0.5 + o], [0, 2, -0.5 - o], [-1, 1, 0]],
    [[0.5 + o, 1, 0.5 + o], [0.5 + o, 1, -0.5 - o], [0, 2, -0.5 - o], [0, 2, 0.5 + o], [1, 1, 0]],
  ];
  const push = (p: number[], n: THREE.Vector3, part: number, mat: number) => {
    b.pos.push(p[0], p[1], p[2]);
    b.nrm.push(n.x, n.y, n.z);
    b.part.push(part, mat);
  };
  for (const [a, bb, c, d, nn] of quads) {
    const n = new THREE.Vector3(nn[0], nn[1], nn[2]).normalize();
    push(a, n, 1, 1); push(bb, n, 1, 1); push(c, n, 1, 1);
    push(a, n, 1, 1); push(c, n, 1, 1); push(d, n, 1, 1);
  }
  const nf = new THREE.Vector3(0, 0, 1), nb = new THREE.Vector3(0, 0, -1);
  push([-0.5, 1, 0.5], nf, 1, 0); push([0.5, 1, 0.5], nf, 1, 0); push([0, 2, 0.5], nf, 1, 0);
  push([0.5, 1, -0.5], nb, 1, 0); push([-0.5, 1, -0.5], nb, 1, 0); push([0, 2, -0.5], nb, 1, 0);
  // Chimney
  b.box(0.25, 1.6, 0.2, 0.1, 0.8, 0.1, 2, 2, undefined, ['bottom']);
  return b.build();
}

// ------------------------------------------------------------------------------------------------------------
// Trees. Parts: 0 trunk, 1 crown. Materials: 0 bark, 1 foliage.
// ------------------------------------------------------------------------------------------------------------

export function coniferGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.cyl(0, 1.5, 0, 0.2, 3.0, 'y', 5, 0, 0, false, undefined, 0.14);
  b.cone(0, 0, 1.4, 5.2, 2.1, 7, 1, 1, 0.5);
  b.cone(0, 0, 3.6, 7.6, 1.75, 7, 1, 1, 0.35);
  b.cone(0, 0, 5.8, 9.8, 1.35, 6, 1, 1, 0.2);
  b.cone(0, 0, 8.0, 12.2, 0.9, 6, 1, 1);
  return b.build();
}

export function broadleafGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.cyl(0, 1.7, 0, 0.26, 3.4, 'y', 5, 0, 0, false, undefined, 0.17);
  b.blob(0, 5.6, 0, 3.0, 2.5, 3.0, 1, 1, 1);
  b.blob(1.5, 6.6, 0.7, 2.2, 1.9, 2.2, 1, 1, 2, 0);
  b.blob(-1.3, 6.3, -0.9, 2.3, 2.0, 2.1, 1, 1, 3, 0);
  b.blob(0.2, 7.9, -0.2, 1.8, 1.5, 1.8, 1, 1, 4, 0);
  return b.build();
}

/** Distant LOD of the conifer (same parts/materials, ~10 triangles). */
export function coniferFarGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.cone(0, 0, 1.2, 12.2, 2.0, 5, 1, 1);
  return b.build();
}

/** Distant LOD of the broadleaf tree (~26 triangles). */
export function broadleafFarGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.cyl(0, 1.7, 0, 0.3, 3.4, 'y', 3, 0, 0, false);
  b.blob(0, 6.2, 0, 3.3, 2.9, 3.3, 1, 1, 1, 0);
  return b.build();
}

/** Unit quad on the XZ plane (decals). */
export function decalGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}
