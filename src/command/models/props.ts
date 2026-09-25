// FRONT ULTRA — command mode: infantry figures and scenery props (owner: command). All are single merged
// geometries meant for InstancedMesh (instance color tints them: team for soldiers, variety for props).

import * as THREE from 'three';
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

export function coniferGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.cyl(0.18, 0.28, 3, 6, 0x5a4330, 0, 1.5, 0);
  b.add(new THREE.ConeGeometry(2.6, 5.0, 8), 0x2f4a26, 0, 4.2, 0);
  b.add(new THREE.ConeGeometry(2.1, 4.2, 8), 0x345228, 0, 6.3, 0, 0, 0.4);
  b.add(new THREE.ConeGeometry(1.4, 3.4, 8), 0x3a5a2c, 0, 8.4, 0, 0, 0.8);
  return b.build();
}

export function broadleafGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.cyl(0.22, 0.35, 3.6, 6, 0x5b4632, 0, 1.8, 0);
  b.add(new THREE.IcosahedronGeometry(2.8, 1), 0x3f5a2a, 0, 5.4, 0, 0, 0, 0, 1.1, 0.85, 1.05);
  b.add(new THREE.IcosahedronGeometry(2.0, 1), 0x48632e, 1.3, 6.4, 0.6);
  b.add(new THREE.IcosahedronGeometry(1.9, 1), 0x3b5527, -1.2, 6.0, -0.7);
  return b.build();
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
