// FRONT ULTRA — command mode: procedural support vehicles: SPAAG, truck, SAM launcher, coastal battery (owner: command).
// Every model faces -Z, sits on y = 0 and is built from merged primitives: one mesh per rigid part and material
// role. Named sub-groups drive animation: `body` (suspension pitch/roll), `turret` (yaw), `gun` (pitch pivot),
// `muzzle` (empty at the barrel tip), `radar` (spinning dish), `wheels*`.

import * as THREE from 'three';
import { bakeDust, GeoBuilder, type Pt } from './builder';
import { addRunningGear } from './armor';

export type Role = 'paint' | 'mark' | 'glass' | 'flame' | 'ordnance' | 'prop';

const PAINT = 0xeeeeea;
const PAINT_B = 0xd6d6d0;
const PAINT_C = 0xc2c2bc;
const DARK = 0x1d1c1a;
const TRACK = 0x2b2926;
const METAL = 0x3d3c3a;
const RUBBER = 0x161616;

function mesh(g: THREE.BufferGeometry, role: Role, name = ''): THREE.Mesh {
  const m = new THREE.Mesh(g);
  m.userData.role = role;
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function group(name: string, ...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  for (const c of children) g.add(c);
  return g;
}

function marker(name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

// -------------------------------------------------------------------------------------------------
// Tracked chassis
// -------------------------------------------------------------------------------------------------

interface ChassisOpts {
  length: number;
  width: number;
  hullH: number;
  wheels: number;
  wheelR: number;
  skirt: boolean;
  noseRake: number;
}

function trackedChassis(o: ChassisOpts): THREE.Group {
  const b = new GeoBuilder();
  const L = o.length, W = o.width;
  const hl = L / 2;
  const top = 0.5 + o.hullH;
  const prof: Pt[] = [
    [-hl + 0.1, 0.5], [hl - 0.55, 0.5], [hl, 0.5 + o.hullH * 0.45], [hl - o.noseRake, top], [-hl + 0.15, top], [-hl - 0.05, top - 0.3],
  ];
  b.profileX(prof, W * 0.66, PAINT, 0, 0, 0, 0.1);
  // Fender deck over the tracks.
  b.box(W, 0.1, L - 0.5, PAINT_B, 0, top - 0.12, 0.1);
  // Tracks + running gear (shared with the MBTs), skirts.
  addRunningGear(b, L, W, o.wheels, o.wheelR);
  for (const s of [-1, 1]) {
    if (o.skirt) {
      b.box(0.07, 0.55, L - 1.0, PAINT_B, s * (W / 2 - 0.02), top - 0.42, -0.1);
      for (let k = 0; k < 5; k++) b.box(0.08, 0.5, 0.04, PAINT_C, s * (W / 2 - 0.01), top - 0.42, -hl + 1.2 + k * ((L - 2.2) / 4));
    }
  }
  // Rear engine deck grille, headlights, tow hooks, stowage.
  b.box(W * 0.5, 0.05, L * 0.28, DARK, 0, top + 0.01, hl * 0.62);
  b.box(W * 0.5, 0.035, 0.08, METAL, 0, top + 0.035, hl * 0.62 - L * 0.1);
  b.box(W * 0.5, 0.035, 0.08, METAL, 0, top + 0.035, hl * 0.62 + L * 0.1);
  for (const s of [-1, 1]) {
    b.box(0.22, 0.14, 0.1, 0x9a9a88, s * W * 0.3, top - 0.25, -hl + o.noseRake * 0.3);
    b.box(0.16, 0.16, 0.2, METAL, s * W * 0.22, 0.62, -hl - 0.02);
    b.box(0.5, 0.3, 0.7, PAINT_C, s * (W / 2 - 0.3), top + 0.15, hl * 0.55);
  }
  // Rear plate: exhaust louvers, tail lights, tow hooks, spare track links, jerrycans.
  const rz = hl - 0.02;
  b.box(W * 0.46, 0.42, 0.06, DARK, 0, top - 0.62, rz + 0.04);
  for (let i = 0; i < 5; i++) b.box(W * 0.44, 0.03, 0.08, METAL, 0, top - 0.8 + i * 0.09, rz + 0.07);
  for (const s of [-1, 1]) {
    b.box(0.14, 0.1, 0.06, 0x7a1e14, s * W * 0.34, top - 0.38, rz + 0.05);
    b.box(0.18, 0.18, 0.22, METAL, s * W * 0.26, 0.6, rz + 0.1);
    b.box(0.22, 0.42, 0.34, 0x4d553a, s * W * 0.42, top - 0.05, rz - 0.15);
  }
  for (let i = 0; i < 3; i++) b.box(0.48, 0.12, 0.07, TRACK, -W * 0.16 + i * 0.02, 0.9 + i * 0.16, rz + 0.06);
  b.cyl(0.04, 0.04, W * 0.6, 6, DARK, 0, 1.05, rz + 0.1, 0, 0, Math.PI / 2);
  const body = group('body', mesh(bakeDust(b.build(), 0.25, 1.6, 0.85), 'paint', 'hull'));
  return body;
}

// -------------------------------------------------------------------------------------------------
// SPAAG (self-propelled anti-aircraft gun)
// -------------------------------------------------------------------------------------------------

export function buildAa(): THREE.Group {
  const root = new THREE.Group();
  const body = trackedChassis({ length: 7.0, width: 3.3, hullH: 1.05, wheels: 6, wheelR: 0.34, skirt: false, noseRake: 1.2 });
  root.add(body);
  const t = new GeoBuilder();
  t.planY([[1.3, 0.8], [0.9, 1.1], [-1.4, 1.1], [-1.6, 0.9], [-1.6, -0.9], [-1.4, -1.1], [0.9, -1.1], [1.3, -0.8]], 1.05, PAINT);
  t.box(0.8, 0.4, 0.7, PAINT_B, 0, 1.1, 1.0);
  t.box(0.5, 0.5, 0.35, PAINT_B, 0, 0.6, -1.35);
  t.cyl(0.25, 0.25, 0.12, 12, DARK, 0, 0.62, -1.54, Math.PI / 2);
  const m = new GeoBuilder();
  for (const s of [-1, 1]) m.box(0.03, 0.2, 1.0, 0xffffff, s * 1.12, 0.6, 0);
  const g = new GeoBuilder();
  for (const s of [-1, 1]) {
    g.box(0.36, 0.5, 1.1, PAINT_B, s * 1.35, 0, 0);
    g.cyl(0.055, 0.055, 2.9, 8, DARK, s * 1.35, 0.05, -1.9, Math.PI / 2);
    g.cyl(0.085, 0.085, 0.25, 8, DARK, s * 1.35, 0.05, -3.3, Math.PI / 2);
  }
  const gun = group('gun', mesh(g.build(), 'paint', 'gunMesh'), marker('muzzle', 1.35, 0.05, -3.5));
  gun.position.set(0, 0.6, -0.1);
  // Search radar dish (spins).
  const r = new GeoBuilder();
  r.box(1.8, 0.7, 0.08, PAINT_C, 0, 0.35, 0, -0.25);
  r.cyl(0.06, 0.06, 0.4, 6, DARK, 0, -0.1, 0.1);
  const radar = group('radar', mesh(r.build(), 'paint', 'radarMesh'));
  radar.position.set(0, 1.45, 1.0);
  const turret = group('turret', mesh(t.build(), 'paint', 'turretShell'), mesh(m.build(), 'mark', 'mark'), gun, radar);
  turret.position.set(0, 1.5, 0.2);
  body.add(turret);
  return root;
}

// -------------------------------------------------------------------------------------------------
// Wheeled: truck and SAM launcher
// -------------------------------------------------------------------------------------------------

function wheeledChassis(b: GeoBuilder, L: number, W: number, axles: number[]): void {
  b.box(W * 0.8, 0.35, L, DARK, 0, 0.95, 0);
  for (const z of axles) {
    for (const s of [-1, 1]) {
      b.cyl(0.55, 0.55, 0.45, 14, RUBBER, s * (W / 2 - 0.2), 0.55, z, 0, 0, Math.PI / 2);
      b.cyl(0.28, 0.28, 0.47, 10, METAL, s * (W / 2 - 0.2), 0.55, z, 0, 0, Math.PI / 2);
    }
  }
}

export function buildTruck(): THREE.Group {
  const root = new THREE.Group();
  const b = new GeoBuilder();
  wheeledChassis(b, 7.2, 2.5, [-2.6, 1.1, 2.6]);
  b.box(2.5, 1.4, 1.9, PAINT, 0, 1.9, -2.55);
  b.box(2.4, 0.6, 0.05, 0x121820, 0, 2.25, -3.51);
  b.box(2.5, 0.35, 0.6, PAINT_B, 0, 1.35, -3.5);
  b.box(2.55, 0.15, 4.8, PAINT_B, 0, 1.2, 1.1);
  b.box(2.5, 1.9, 4.6, PAINT_C, 0, 2.2, 1.15);
  for (let i = 0; i < 5; i++) b.box(2.56, 0.05, 0.08, METAL, 0, 3.15, -1.0 + i * 1.08);
  const body = group('body', mesh(bakeDust(b.build(), 0.25, 1.6, 0.85), 'paint', 'hull'));
  const m = new GeoBuilder();
  for (const s of [-1, 1]) m.box(0.03, 0.4, 0.6, 0xffffff, s * 1.27, 2.0, -2.55);
  body.add(mesh(m.build(), 'mark', 'mark'));
  root.add(body);
  return root;
}

export function buildSam(): THREE.Group {
  const root = new THREE.Group();
  const b = new GeoBuilder();
  wheeledChassis(b, 8.4, 2.7, [-3.0, -1.4, 1.6, 3.2]);
  b.box(2.7, 1.5, 1.8, PAINT, 0, 1.95, -3.3);
  b.box(2.6, 0.55, 0.05, 0x121820, 0, 2.35, -4.21);
  b.box(2.7, 0.3, 5.8, PAINT_B, 0, 1.3, 0.9);
  for (const s of [-1, 1]) b.box(0.25, 0.25, 0.25, METAL, s * 1.25, 1.2, 3.9);
  const body = group('body', mesh(bakeDust(b.build(), 0.25, 1.6, 0.85), 'paint', 'hull'));
  const m = new GeoBuilder();
  for (const s of [-1, 1]) m.box(0.03, 0.45, 0.7, 0xffffff, s * 1.37, 2.1, -3.3);
  body.add(mesh(m.build(), 'mark', 'mark'));
  // Launcher: yaw (turret) + elevation (gun) with 4 canisters.
  const r = new GeoBuilder();
  r.box(1.3, 0.3, 1.3, PAINT_B, 0, 0.15, 0);
  const l = new GeoBuilder();
  for (let i = 0; i < 4; i++) {
    const x = (i % 2 === 0 ? -0.5 : 0.5), y = i < 2 ? 0.25 : 0.85;
    l.box(0.56, 0.56, 5.4, PAINT, x, y, -1.8);
    l.box(0.45, 0.45, 0.04, DARK, x, y, -4.52);
  }
  const gun = group('gun', mesh(l.build(), 'paint', 'gunMesh'), marker('muzzle', 0, 0.55, -4.7));
  gun.position.set(0, 0.35, 1.2);
  gun.rotation.x = 0.6;
  const turret = group('turret', mesh(r.build(), 'paint', 'turretShell'), gun);
  turret.position.set(0, 1.45, 1.4);
  body.add(turret);
  root.add(body);
  return root;
}

// -------------------------------------------------------------------------------------------------
// Coastal battery (concrete casemate + long gun)
// -------------------------------------------------------------------------------------------------

export function buildBattery(): THREE.Group {
  const root = new THREE.Group();
  const b = new GeoBuilder();
  b.profileX([[-6, 0], [6, 0], [3.8, 3.2], [-5.4, 3.4], [-6, 2.8]], 11, 0xb4ad9c);
  b.box(13, 0.6, 13, 0x8f887a, 0, 0.2, 0);
  for (const s of [-1, 1]) b.box(2.2, 2.4, 2.2, 0x9f988a, s * 6.2, 1.2, 3);
  const body = group('body', mesh(b.build(), 'prop', 'casemate'));
  const t = new GeoBuilder();
  t.cyl(2.2, 2.5, 1.4, 16, PAINT, 0, 0.7, 0);
  t.planY([[2.2, 1.0], [1.0, 2.0], [-2.0, 2.0], [-2.4, 1.4], [-2.4, -1.4], [-2.0, -2.0], [1.0, -2.0], [2.2, -1.0]], 1.2, PAINT_B, 0, 1.2, 0);
  const g = new GeoBuilder();
  g.box(1.0, 0.8, 0.8, PAINT_B, 0, 0, 0);
  g.cyl(0.22, 0.26, 7.0, 12, PAINT_C, 0, 0, -3.8, Math.PI / 2);
  g.cyl(0.3, 0.3, 0.5, 12, DARK, 0, 0, -7.2, Math.PI / 2);
  const gun = group('gun', mesh(g.build(), 'paint', 'gunMesh'), marker('muzzle', 0, 0, -7.6));
  gun.position.set(0, 1.9, -1.6);
  const turret = group('turret', mesh(t.build(), 'paint', 'turretShell'), gun);
  turret.position.set(0, 3.3, 0.4);
  body.add(turret);
  root.add(body);
  return root;
}
