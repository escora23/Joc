// FRONT ULTRA — command mode: infantry figures and scenery props (owner: command). All are single merged
// geometries meant for InstancedMesh (instance color tints them: team for soldiers, variety for props).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GeoBuilder } from './builder';

const UNIFORM = 0xb8b8a4;
const UNIFORM_B = 0xa4a490;
const SKIN = 0xc89a78;
const GEAR = 0x6a6a5a;
const GUN = 0x262626;

/** Soldier ~1.8 m, rifle at the ready, facing -Z. variant 1 = AT gunner with a launcher tube on the shoulder. */
export function soldierGeometry(variant: 0 | 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  // legs (slight stride)
  b.box(0.17, 0.82, 0.2, UNIFORM_B, -0.12, 0.42, 0.06, 0.12);
  b.box(0.17, 0.82, 0.2, UNIFORM_B, 0.12, 0.42, -0.08, -0.16);
  b.box(0.19, 0.12, 0.3, GEAR, -0.12, 0.05, 0.0);
  b.box(0.19, 0.12, 0.3, GEAR, 0.12, 0.05, -0.16);
  // torso + vest + pack
  b.box(0.46, 0.62, 0.28, UNIFORM, 0, 1.12, 0, 0.08);
  b.box(0.5, 0.42, 0.33, GEAR, 0, 1.18, -0.01, 0.08);
  b.box(0.36, 0.44, 0.2, GEAR, 0, 1.2, 0.26, 0.08);
  // head + helmet
  b.sphere(0.12, 8, 6, SKIN, 0, 1.58, -0.04, 1, 1.1, 1);
  b.sphere(0.16, 10, 6, UNIFORM_B, 0, 1.64, -0.02, 1.05, 0.72, 1.1);
  // arms
  b.box(0.12, 0.5, 0.12, UNIFORM, -0.27, 1.14, -0.14, 0.9, 0, 0.2);
  b.box(0.12, 0.5, 0.12, UNIFORM, 0.26, 1.1, -0.22, 1.1, 0, -0.3);
  if (variant === 0) {
    b.box(0.06, 0.1, 0.95, GUN, 0.05, 1.22, -0.42, 0.05);
    b.box(0.05, 0.16, 0.08, GUN, 0.05, 1.12, -0.38);
  } else {
    b.cyl(0.08, 0.08, 1.25, 10, 0x4a5236, 0.16, 1.5, -0.08, Math.PI / 2 - 0.08);
    b.cyl(0.12, 0.1, 0.3, 10, 0x3b4230, 0.16, 1.54, -0.75, Math.PI / 2 - 0.08);
  }
  return b.build();
}

/** Cheap deterministic 3D hash noise for vertex displacement. */
function hn(x: number, y: number, z: number): number {
  const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Foliage pass on a merged canopy geometry: soft normals pointing away from the crown center (so the crown reads as
 * one lit volume instead of facets) and baked occlusion (dark inside and underneath, bright on the outer top).
 */
function foliage(g: THREE.BufferGeometry, cx: number, cy: number, cz: number, rx: number, ry: number, soft: number): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const c = g.attributes.color as THREE.BufferAttribute;
  const v = new THREE.Vector3(), fn = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set((p.getX(i) - cx) / rx, (p.getY(i) - cy) / ry, (p.getZ(i) - cz) / rx);
    const r = v.length();
    v.normalize();
    fn.set(n.getX(i), n.getY(i), n.getZ(i));
    fn.lerp(v, soft).normalize();
    n.setXYZ(i, fn.x, fn.y, fn.z);
    const ao = Math.max(0.28, Math.min(1.15, 0.45 + 0.4 * Math.min(1, r) + 0.3 * v.y));
    c.setXYZ(i, c.getX(i) * ao, c.getY(i) * ao, c.getZ(i) * ao);
  }
  return g;
}

function lumpySphere(r: number, detail: number, seed: number, amp: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (hn(x * 1.7 + seed, y * 1.7, z * 1.7) - 0.5) * amp + (hn(x * 4.1, y * 4.1 + seed, z * 4.1) - 0.5) * amp * 0.5;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}

export function coniferGeometry(): THREE.BufferGeometry {
  const trunk = new GeoBuilder();
  trunk.cyl(0.14, 0.3, 4.2, 7, 0x4a3626, 0, 2.1, 0);
  const crown = new GeoBuilder();
  const tiers = 6;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = 2.9 * (1 - t * 0.78);
    const h = 3.1 * (1 - t * 0.45);
    const y = 2.4 + i * 1.45;
    const cone = new THREE.ConeGeometry(r, h, 11, 2, true);
    // Jagged, drooping branch tips.
    const p = cone.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), yy = p.getY(k), z = p.getZ(k);
      const rad = Math.hypot(x, z);
      if (rad < 1e-3) continue;
      const a = Math.atan2(z, x);
      const jag = 1 + (Math.sin(a * 11 + i * 1.3) * 0.5 + 0.5) * 0.28 * (rad / r) + (hn(x, yy + i, z) - 0.5) * 0.18;
      p.setXYZ(k, x * jag, yy - (rad / r) * 0.35, z * jag);
    }
    cone.computeVertexNormals();
    const shadeK = 0.8 + t * 0.35;
    const col = (Math.round(0x27 * shadeK) << 16) | (Math.round(0x3e * shadeK) << 8) | Math.round(0x22 * shadeK);
    crown.add(cone, col, 0, y, 0, 0, i * 0.7, 0);
  }
  const cg = foliage(crown.build(), 0, 5.5, 0, 3.0, 6.0, 0.7);
  const tg = trunk.build();
  const g = mergeGeometries([tg, cg], false);
  tg.dispose();
  cg.dispose();
  g.computeBoundingSphere();
  return g;
}

export function broadleafGeometry(): THREE.BufferGeometry {
  const trunk = new GeoBuilder();
  trunk.cyl(0.2, 0.36, 3.8, 7, 0x4d3b2a, 0, 1.9, 0);
  trunk.cyl(0.09, 0.16, 2.4, 5, 0x4d3b2a, 0.7, 4.0, 0.2, 0.25, 0, -0.55);
  trunk.cyl(0.08, 0.15, 2.2, 5, 0x4d3b2a, -0.6, 4.0, -0.3, -0.3, 0, 0.5);
  const crown = new GeoBuilder();
  const lobes: [number, number, number, number, number][] = [
    [0, 6.1, 0, 2.7, 0x34462a], [1.6, 5.4, 0.6, 1.9, 0x384c2c], [-1.5, 5.6, -0.5, 2.0, 0x314328], [0.3, 7.4, -0.4, 1.9, 0x3e5230],
    [-0.4, 5.0, 1.5, 1.7, 0x324429], [0.6, 5.2, -1.6, 1.7, 0x36492b], [-1.1, 6.9, 0.8, 1.5, 0x3b4f2e],
  ];
  lobes.forEach(([x, y, z, r, col], i) => crown.add(lumpySphere(r, 1, i * 3.1, 0.4), col, x, y, z, 0, 0, 0, 1, 0.82, 1));
  const cg = foliage(crown.build(), 0, 6.0, 0, 3.2, 2.6, 0.88);
  const tg = trunk.build();
  const g = mergeGeometries([tg, cg], false);
  tg.dispose();
  cg.dispose();
  g.computeBoundingSphere();
  return g;
}

export function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.75 + 0.3 * Math.sin(x * 5.1 + z * 3.7) * Math.cos(y * 4.3);
    p.setXYZ(i, x * k * 1.3, Math.max(-0.3, y * k * 0.75), z * k);
  }
  const b = new GeoBuilder();
  b.add(g, 0x8a847a);
  return b.build();
}

/** Simple house block with a pitched roof (unit footprint, scaled per instance). */
export function houseGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.box(1, 0.7, 1, 0xd8d0c0, 0, 0.35, 0);
  const roof = new THREE.CylinderGeometry(0.62, 0.62, 1.04, 3, 1);
  b.add(roof, 0x8a4a38, 0, 0.84, 0, -Math.PI / 2, 0, 0, 1.05, 1, 0.42);
  // windows
  for (const s of [-1, 1]) {
    b.box(0.16, 0.14, 0.02, 0x2a3036, s * 0.24, 0.42, 0.505);
    b.box(0.16, 0.14, 0.02, 0x2a3036, s * 0.24, 0.42, -0.505);
  }
  b.box(0.14, 0.26, 0.02, 0x4a3a2a, 0, 0.13, 0.505);
  return b.build();
}

/** Sandbag wall / trench segment (3 m long). */
export function sandbagGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 6; i++) {
      b.sphere(0.3, 6, 4, 0xa89a78 - row * 0x040404, -1.4 + i * 0.56 + (row % 2) * 0.28, 0.16 + row * 0.26, 0, 1, 0.55, 0.7);
    }
  }
  return b.build();
}
