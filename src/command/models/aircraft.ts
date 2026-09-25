// FRONT ULTRA — command mode: procedural fighter jet + missiles (owner: command). Faces -Z, origin at the
// center of mass. Children: `flame` (afterburner cone, scale.z = thrust), `msl0..3` (pylons, hidden when fired),
// `gunPort` (cannon muzzle), `nozzle`.

import * as THREE from 'three';
import { GeoBuilder, type Pt } from './builder';
import type { Role } from './vehicles';

const PAINT = 0xf2f2f2;
const PAINT_B = 0xdcdcdc;
const PAINT_C = 0xc4c6c8;
const DARK = 0x222324;
const METAL = 0x4a4744;

function mesh(g: THREE.BufferGeometry, role: Role, name: string): THREE.Mesh {
  const m = new THREE.Mesh(g);
  m.userData.role = role;
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Thin fin: profile (forward, up) extruded across X by `thick`, forward = -Z. */
function fin(pts: Pt[], thick: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

export function buildMissileGeometry(scale = 1): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const s = scale;
  b.cyl(0.09 * s, 0.09 * s, 2.9 * s, 10, 0xeeeeee, 0, 0, 0, Math.PI / 2);
  b.add(new THREE.ConeGeometry(0.09 * s, 0.35 * s, 10), 0x9aa0a4, 0, 0, -1.62 * s, -Math.PI / 2);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    b.box(0.02 * s, 0.34 * s, 0.4 * s, 0xcccccc, Math.cos(a) * 0.17 * s, Math.sin(a) * 0.17 * s, 1.2 * s, 0, 0, a + Math.PI / 2);
    b.box(0.02 * s, 0.2 * s, 0.25 * s, 0xcccccc, Math.cos(a) * 0.13 * s, Math.sin(a) * 0.13 * s, -0.9 * s, 0, 0, a + Math.PI / 2);
  }
  b.cyl(0.07 * s, 0.07 * s, 0.1 * s, 8, 0x222222, 0, 0, 1.47 * s, Math.PI / 2);
  return b.build();
}

export function buildJet(): THREE.Group {
  const root = new THREE.Group();
  const b = new GeoBuilder();
  // Fuselage (lathe, flattened), nose cone darker.
  const prof: Pt[] = [
    [0.5, -8.3], [0.62, -7.6], [0.82, -6.0], [0.95, -3.5], [1.0, -1.0], [0.98, 1.5], [0.9, 3.5], [0.72, 5.3], [0.5, 6.6], [0.28, 7.6], [0.0, 8.4],
  ];
  b.latheZ(prof, 18, PAINT, 0, 0, 0, 1.12, 0.82);
  b.latheZ([[0.001, 7.55], [0.28, 7.6], [0.08, 8.3], [0.0, 8.45]], 12, 0x9ea4a8, 0, 0, 0, 1.12, 0.82);
  // Spine
  b.box(0.9, 0.5, 9, PAINT_B, 0, 0.62, 0.8);
  // Intakes
  for (const s of [-1, 1]) {
    b.box(0.75, 1.0, 5.2, PAINT_B, s * 1.12, -0.2, 0.2);
    b.box(0.62, 0.84, 0.1, DARK, s * 1.12, -0.2, -2.42);
  }
  // Wings, LERX, stabilators
  b.planY([[1.6, 0.9], [-2.8, 5.6], [-3.9, 5.6], [-4.4, 0.9], [-4.4, -0.9], [-3.9, -5.6], [-2.8, -5.6], [1.6, -0.9]], 0.14, PAINT_C, 0, -0.12, 0);
  b.planY([[4.4, 0.45], [1.6, 1.45], [1.6, -1.45], [4.4, -0.45]], 0.1, PAINT_C, 0, 0.05, 0);
  b.planY([[-5.9, 1.0], [-7.7, 3.4], [-8.5, 3.4], [-8.4, 1.0], [-8.4, -1.0], [-8.5, -3.4], [-7.7, -3.4], [-5.9, -1.0]], 0.1, PAINT_C, 0, -0.1, 0);
  // Twin canted fins
  for (const s of [-1, 1]) {
    b.add(fin([[-4.9, 0.4], [-7.4, 3.6], [-8.4, 3.6], [-8.3, 0.4]], 0.12), PAINT_B, s * 1.05, 0.35, 0, 0, 0, -s * 0.38);
  }
  // Nozzles
  b.cyl(0.62, 0.52, 1.1, 16, METAL, 0, 0, 8.55, Math.PI / 2);
  b.cyl(0.46, 0.46, 0.05, 16, 0x0d0d0d, 0, 0, 9.1, Math.PI / 2);
  // Pylons
  for (const x of [-3.5, -2.3, 2.3, 3.5]) b.box(0.08, 0.28, 1.3, PAINT_C, x, -0.3, 1.6);
  // Gun port
  b.box(0.15, 0.12, 0.5, DARK, 0.75, 0.35, -4.9);
  const hull = mesh(b.build(), 'paint', 'airframe');

  const c = new GeoBuilder();
  c.sphere(0.6, 16, 10, 0xffffff, 0, 0.72, -4.4, 0.95, 0.75, 2.6);
  const canopy = mesh(c.build(), 'glass', 'canopy');

  const m = new GeoBuilder();
  for (const s of [-1, 1]) {
    m.cyl(0.42, 0.42, 0.02, 16, 0xffffff, s * 3.6, 0.04, 2.4);
    m.box(0.13, 0.9, 1.3, 0xffffff, s * 1.33, 2.45, 7.4, 0, 0, -s * 0.38);
  }
  const mark = mesh(m.build(), 'mark', 'mark');

  const flameGeo = new THREE.CylinderGeometry(0.44, 0.05, 1, 14, 1, true);
  flameGeo.translate(0, -0.5, 0);
  flameGeo.rotateX(-Math.PI / 2); // extends toward +Z
  const flame = new THREE.Mesh(flameGeo);
  flame.userData.role = 'flame';
  flame.name = 'flame';
  flame.position.set(0, 0, 9.1);
  flame.scale.set(1, 1, 4);
  flame.castShadow = false;

  root.add(hull, canopy, mark, flame);
  const mg = buildMissileGeometry(1);
  const xs = [-3.5, 3.5, -2.3, 2.3];
  for (let i = 0; i < 4; i++) {
    const ms = new THREE.Mesh(mg);
    ms.userData.role = 'ordnance';
    ms.name = `msl${i}`;
    ms.position.set(xs[i], -0.55, 1.2);
    ms.castShadow = true;
    root.add(ms);
  }
  const gp = new THREE.Object3D();
  gp.name = 'gunPort';
  gp.position.set(0.75, 0.35, -5.3);
  root.add(gp);
  return root;
}

/** Small bomb geometry (friendly air strikes). */
export function buildBombGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.sphere(0.25, 10, 8, 0x5a5f55, 0, 0, 0, 1, 1, 4.5);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    b.box(0.02, 0.35, 0.35, 0x4d5249, Math.cos(a) * 0.18, Math.sin(a) * 0.18, 1.1, 0, 0, a);
  }
  return b.build();
}
