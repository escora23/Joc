// FRONT ULTRA — command mode: procedural armored vehicles, two design families (owner: command).
//   * 'west' (the player's side): angular MBT with a wedge-armored turret, long L55-class gun with thermal sleeve and
//     muzzle reference, full composite side skirts, commander's panoramic sight, rear bustle rack; tall boxy IFV.
//   * 'east' (the enemy): low MBT with a cast dome turret wrapped in reactive armor bricks, fuel drums on the rear,
//     rubber skirts, IR dazzlers; low pointed-nose IFV with a small round turret.
// Everything faces -Z and sits on y = 0. The running gear is real geometry: individual track links laid along the
// idler / road-wheel / sprocket loop, dished road wheels, toothed sprockets, return rollers. Named nodes drive the
// rig: `body` (suspension pitch / roll), `turret` (yaw), `gun` (pitch pivot), `muzzle` (barrel tip marker).
// Vertex colors: bright = camouflage-painted (the paint shader applies the team pattern), dark = bare metal / rubber.

import * as THREE from 'three';
import { bakeDust, GeoBuilder, type Pt } from './builder';

export type ArmorStyle = 'west' | 'east';

const PAINT = 0xeeeeea;
const PAINT_B = 0xd8d8d2;
const PAINT_C = 0xc4c4be;
const DARK = 0x1b1a18;
const TRACK = 0x2a2724;
const METAL = 0x3b3a37;
const RUBBER = 0x141414;
const OPTIC = 0x0c1418;
const LENS = 0x3a1010;

function mesh(g: THREE.BufferGeometry, role: string, name: string): THREE.Mesh {
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
// Running gear
// -------------------------------------------------------------------------------------------------

interface GearOpts {
  /** Hull length (m); the track loop spans slightly less. */
  L: number;
  /** Lateral center of each track (m from the centerline). */
  tx: number;
  /** Track width. */
  tw: number;
  wheels: number;
  wheelR: number;
  /** Idler / sprocket radius and the height of their centers. */
  endR: number;
  endY: number;
  /** Top run height (link centers). */
  topY: number;
  returnRollers: number;
  /** Rear (true) or front drive sprocket. */
  rearDrive: boolean;
}

/**
 * Track loop as a closed polyline (z, y) in the side plane: bottom run (front to rear), up around the rear wheel,
 * top run back to the front, down around the front wheel.
 */
function trackPath(o: GearOpts): Pt[] {
  const hl = o.L / 2;
  const zf = -hl + o.endR + 0.08, zr = hl - o.endR - 0.08;
  const r = o.endR;
  const bottom = 0.05;
  const zb0 = -hl + 0.95, zb1 = hl - 0.95;
  const pts: Pt[] = [];
  // Front ramp down to the bottom run
  const seg = 10;
  pts.push([zb0, bottom]);
  pts.push([zb1, bottom]);
  // Rear ramp up to the sprocket (tangent approx), then around the rear wheel (from below-rear to top).
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI / 2 + (i / seg) * Math.PI; // -90° (bottom) .. +90° (top), center at (zr, endY)
    const aa = -Math.PI / 2 + 0.35 + (i / seg) * (Math.PI - 0.35);
    void a;
    pts.push([zr + Math.cos(aa) * r, o.endY + Math.sin(aa) * r]);
  }
  pts.push([zr - 0.4, o.topY]);
  pts.push([zf + 0.4, o.topY]);
  for (let i = 0; i <= seg; i++) {
    const aa = Math.PI / 2 + (i / seg) * (Math.PI - 0.35);
    pts.push([zf + Math.cos(aa) * r, o.endY + Math.sin(aa) * r]);
  }
  return pts;
}

function runningGear(b: GeoBuilder, o: GearOpts): void {
  const hl = o.L / 2;
  const path = trackPath(o);
  // Resample the closed loop by arc length and lay links.
  const segs: { z0: number; y0: number; dz: number; dy: number; len: number }[] = [];
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    const [z0, y0] = path[i];
    const [z1, y1] = path[(i + 1) % path.length];
    const len = Math.hypot(z1 - z0, y1 - y0);
    if (len < 1e-4) continue;
    segs.push({ z0, y0, dz: z1 - z0, dy: y1 - y0, len });
    total += len;
  }
  const pitch = 0.19;
  const n = Math.floor(total / pitch);
  const step = total / n;
  for (const s of [-1, 1]) {
    const x = s * o.tx;
    let si = 0, acc = 0;
    for (let k = 0; k < n; k++) {
      const d = k * step;
      while (si < segs.length - 1 && d > acc + segs[si].len) {
        acc += segs[si].len;
        si++;
      }
      const sg = segs[si];
      const t = (d - acc) / sg.len;
      const z = sg.z0 + sg.dz * t, y = sg.y0 + sg.dy * t;
      const tz = sg.dz / sg.len, ty = sg.dy / sg.len;
      const rx = Math.atan2(-ty, tz);
      // Link plate + grouser bar (outward face) + center guide horn.
      b.box(o.tw, 0.07, step * 0.86, TRACK, x, y, z, rx);
      // Grouser sits on the outside of the loop: offset along the loop's outward normal.
      const nzv = ty, nyv = -tz; // rotate tangent -90° (outward for a clockwise loop in this plane)
      b.box(o.tw * 0.96, 0.05, 0.06, METAL, x, y + nyv * 0.05, z + nzv * 0.05, rx);
      if (k % 2 === 0) b.box(0.07, 0.09, 0.08, METAL, x, y - nyv * 0.06, z - nzv * 0.06, rx);
    }
    // Road wheels (dual, dished) with hubs.
    for (let i = 0; i < o.wheels; i++) {
      const z = -hl + 1.05 + (i * (o.L - 2.1)) / (o.wheels - 1);
      const y = o.wheelR + 0.1;
      for (const off of [-0.23, 0.23]) {
        b.cyl(o.wheelR, o.wheelR, o.tw * 0.26, 16, RUBBER, x + off * o.tw, y, z, 0, 0, Math.PI / 2);
        b.cyl(o.wheelR * 0.86, o.wheelR * 0.86, o.tw * 0.28, 16, PAINT_C, x + off * o.tw, y, z, 0, 0, Math.PI / 2);
      }
      b.cyl(o.wheelR * 0.3, o.wheelR * 0.36, o.tw * 0.66, 8, METAL, x + s * 0.02, y, z, 0, 0, Math.PI / 2);
      // Suspension arm
      b.box(0.1, 0.12, 0.55, METAL, s * (o.tx - o.tw * 0.52), y + 0.12, z - 0.22, -0.35);
    }
    // Return rollers
    for (let i = 0; i < o.returnRollers; i++) {
      const z = -hl + 1.6 + (i * (o.L - 3.2)) / Math.max(1, o.returnRollers - 1);
      b.cyl(0.13, 0.13, o.tw * 0.5, 10, METAL, x, o.topY - 0.13, z, 0, 0, Math.PI / 2);
    }
    // Idler and sprocket
    const zf = -hl + o.endR + 0.08, zr = hl - o.endR - 0.08;
    const zs = o.rearDrive ? zr : zf, zi = o.rearDrive ? zf : zr;
    b.cyl(o.endR * 0.92, o.endR * 0.92, o.tw * 0.7, 16, PAINT_C, x, o.endY, zi, 0, 0, Math.PI / 2);
    b.cyl(o.endR * 0.35, o.endR * 0.35, o.tw * 0.9, 8, METAL, x, o.endY, zi, 0, 0, Math.PI / 2);
    b.cyl(o.endR * 0.95, o.endR * 0.95, o.tw * 0.42, 18, METAL, x, o.endY, zs, 0, 0, Math.PI / 2);
    b.cyl(o.endR * 0.45, o.endR * 0.5, o.tw * 0.95, 8, DARK, x, o.endY, zs, 0, 0, Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      b.box(o.tw * 0.4, 0.1, 0.1, METAL, x, o.endY + Math.sin(a) * o.endR * 1.02, zs + Math.cos(a) * o.endR * 1.02, -a);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Western MBT
// -------------------------------------------------------------------------------------------------

function westTank(): THREE.Group {
  const root = new THREE.Group();
  const L = 7.7, W = 3.75;
  const hl = L / 2;
  const b = new GeoBuilder();
  const top = 1.62;
  // Lower hull between the tracks (side profile: lower glacis, upper glacis, deck, rear plate).
  b.profileX([
    [-hl + 0.05, 0.52], [hl - 0.75, 0.46], [hl + 0.02, 1.02], [hl - 0.05, 1.12], [hl - 1.55, top], [-hl + 0.2, top], [-hl - 0.02, top - 0.12], [-hl, 0.72],
  ], W * 0.58, PAINT, 0, 0, 0, 0.06);
  // Sponsons / fenders over the tracks (full width deck)
  b.profileX([[hl - 0.35, 1.18], [hl - 1.6, top - 0.02], [-hl + 0.15, top - 0.02], [-hl + 0.15, 1.22]], W - 0.02, PAINT_B, 0, 0, 0, 0.04);
  // Glacis details: driver's hatch, periscopes, headlight clusters with guards, tow shackles.
  b.box(0.95, 0.06, 0.75, PAINT_C, -0.55, top + 0.03, -hl + 1.95, 0.02);
  for (let i = 0; i < 3; i++) b.box(0.16, 0.1, 0.1, OPTIC, -0.9 + i * 0.35, top + 0.07, -hl + 1.55);
  for (const s of [-1, 1]) {
    b.box(0.26, 0.2, 0.14, PAINT_C, s * 1.28, 1.36, -hl + 0.9, -0.55);
    b.box(0.2, 0.12, 0.04, 0xd8d0a0, s * 1.28, 1.38, -hl + 0.82, -0.55);
    b.box(0.05, 0.28, 0.05, METAL, s * 1.46, 1.42, -hl + 0.86);
    b.box(0.2, 0.2, 0.18, METAL, s * 0.75, 0.62, -hl + 0.05);
  }
  // Composite side skirts: 2 thick front panels, thinner rear panels, lower edge scalloped by seams.
  for (const s of [-1, 1]) {
    const x = s * (W / 2 - 0.03);
    b.box(0.16, 0.72, 1.7, PAINT, x, 1.2, -hl + 1.25, 0, 0, s * -0.05);
    for (let k = 0; k < 4; k++) b.box(0.08, 0.62, 1.25, PAINT_B, x - s * 0.03, 1.25, -hl + 2.75 + k * 1.28);
    for (let k = 0; k < 5; k++) b.box(0.1, 0.62, 0.035, PAINT_C, x + s * 0.02, 1.25, -hl + 2.12 + k * 1.28);
    // Stowage bins on the rear fenders
    b.box(0.55, 0.36, 1.2, PAINT_B, s * (W / 2 - 0.35), top + 0.17, hl - 1.0);
    // Tow cable along the side
    b.cyl(0.035, 0.035, 3.4, 5, DARK, s * (W / 2 - 0.2), top + 0.04, 0.2, Math.PI / 2);
  }
  // Engine deck: grille banks + access panels
  for (let i = 0; i < 9; i++) b.box(1.9, 0.03, 0.07, DARK, 0, top + 0.02, hl - 2.2 + i * 0.2);
  b.box(2.1, 0.03, 1.9, METAL, 0, top + 0.005, hl - 1.4);
  for (const s of [-1, 1]) b.box(0.6, 0.05, 1.5, PAINT_C, s * 1.3, top + 0.02, hl - 2.4);
  // Rear plate: exhaust grilles, lights, spare track links, tow bar
  const rz = hl + 0.01;
  for (let i = 0; i < 6; i++) b.box(W * 0.46, 0.035, 0.08, DARK, 0, 0.95 + i * 0.09, rz);
  for (const s of [-1, 1]) {
    b.box(0.16, 0.1, 0.06, 0x8a1c10, s * W * 0.36, 1.45, rz);
    b.box(0.2, 0.2, 0.2, METAL, s * W * 0.26, 0.62, rz + 0.06);
  }
  for (let i = 0; i < 4; i++) b.box(0.62, 0.05, 0.19, TRACK, W * 0.32, 0.95 + i * 0.13, rz + 0.04, Math.PI / 2);
  runningGear(b, { L: L - 0.2, tx: W / 2 - 0.36, tw: 0.64, wheels: 7, wheelR: 0.36, endR: 0.34, endY: 0.62, topY: 1.02, returnRollers: 4, rearDrive: true });
  const body = group('body', mesh(bakeDust(b.build(), 0.25, 1.55, 0.9), 'paint', 'hull'));
  root.add(body);

  // Turret: wedge-armored front, flat sides, large bustle.
  const t = new GeoBuilder();
  const outline: Pt[] = [
    [2.05, 0.46], [1.25, 1.72], [-1.2, 1.72], [-2.45, 1.45], [-2.6, 0.9], [-2.6, -0.9], [-2.45, -1.45], [-1.2, -1.72], [1.25, -1.72], [2.05, -0.46],
  ];
  t.planY(outline, 0.78, PAINT, 0, 0, 0, 0, 0, 0, 0.08);
  // Wedge add-on armor: two sloped plates forming the arrow nose on each side of the mantlet.
  for (const s of [-1, 1]) {
    const w: Pt[] = [[2.7, s * 0.52], [1.25, s * 1.78], [0.95, s * 1.78], [2.05, s * 0.52]];
    t.planY(s > 0 ? w : w.slice().reverse(), 0.62, PAINT_B, 0, 0.12, 0, 0, 0, 0, 0.04);
    t.box(0.06, 0.62, 0.06, METAL, s * 1.2, 0.43, -1.35);
  }
  // Roof: panoramic commander sight on a pedestal, gunner's sight box, hatches, loader's MG.
  t.cyl(0.24, 0.28, 0.42, 10, PAINT_B, -0.75, 0.99, -0.15);
  t.box(0.46, 0.32, 0.46, PAINT_C, -0.75, 1.36, -0.15);
  t.box(0.36, 0.18, 0.05, OPTIC, -0.75, 1.38, -0.4);
  t.box(0.62, 0.36, 0.9, PAINT_B, 0.72, 0.92, -1.0);
  t.box(0.46, 0.2, 0.05, OPTIC, 0.72, 0.98, -1.46);
  t.cyl(0.36, 0.36, 0.08, 14, PAINT_C, 0.62, 0.82, 0.35);
  t.cyl(0.33, 0.33, 0.08, 14, PAINT_C, -0.6, 0.82, 0.55);
  t.cyl(0.03, 0.03, 1.1, 6, DARK, -0.6, 1.05, 0.0, Math.PI / 2);
  t.box(0.12, 0.18, 0.46, DARK, -0.6, 1.02, 0.45);
  t.box(0.28, 0.12, 0.12, DARK, -0.6, 0.92, 0.55);
  // Bustle rack with stowed rolls and boxes
  for (const yy of [0.3, 0.62]) t.box(3.0, 0.05, 0.05, METAL, 0, yy, 3.05);
  for (const xx of [-1.45, -0.5, 0.5, 1.45]) t.box(0.05, 0.45, 0.05, METAL, xx, 0.42, 3.05);
  for (const s of [-1, 1]) t.box(0.05, 0.05, 0.5, METAL, s * 1.45, 0.62, 2.8);
  t.cyl(0.2, 0.2, 1.3, 10, 0x5a5440, -0.6, 0.55, 2.8, 0, 0, Math.PI / 2);
  t.box(0.9, 0.42, 0.45, 0x4a4a3a, 0.75, 0.4, 2.8);
  // Smoke dischargers (banks of 4 on each side)
  for (const s of [-1, 1]) {
    t.box(0.35, 0.12, 0.5, PAINT_C, s * 1.62, 0.66, -0.8);
    for (let i = 0; i < 4; i++) t.cyl(0.065, 0.065, 0.36, 8, DARK, s * (1.52 + i * 0.07), 0.8, -1.02 + i * 0.1, 1.05, 0, s * 0.3);
  }
  // Antennas
  t.cyl(0.012, 0.02, 2.6, 4, DARK, 1.35, 2.05, 2.1);
  t.cyl(0.012, 0.02, 2.0, 4, DARK, -1.35, 1.75, 2.2);
  const turretMesh = mesh(t.build(), 'paint', 'turretShell');
  const m = new GeoBuilder();
  // Team panels on the turret sides and the bustle rear (nation color).
  for (const s of [-1, 1]) m.box(0.03, 0.34, 0.62, 0xffffff, s * 1.735, 0.42, 0.4);
  const markMesh = mesh(m.build(), 'mark', 'mark');

  // Gun: mantlet, thermal sleeve with bands, fume extractor, muzzle reference sensor, coax port.
  const g = new GeoBuilder();
  g.box(0.95, 0.66, 0.6, PAINT_B, 0, 0, 0.05);
  g.box(0.75, 0.5, 0.25, PAINT_C, 0, 0, -0.35);
  g.cyl(0.14, 0.15, 2.0, 16, PAINT_B, 0, 0, -1.45, Math.PI / 2);
  g.cyl(0.175, 0.175, 0.7, 16, PAINT_B, 0, 0, -2.75, Math.PI / 2);
  g.cyl(0.125, 0.13, 2.4, 16, PAINT_C, 0, 0, -4.25, Math.PI / 2);
  for (const z of [-1.0, -1.9, -3.6, -4.6]) g.cyl(0.155, 0.155, 0.06, 16, METAL, 0, 0, z, Math.PI / 2);
  g.cyl(0.13, 0.13, 0.3, 16, DARK, 0, 0, -5.55, Math.PI / 2);
  g.box(0.12, 0.08, 0.14, DARK, 0, 0.15, -5.55);
  g.cyl(0.06, 0.06, 0.1, 8, DARK, 0.32, 0.08, -0.29, Math.PI / 2);
  const gun = group('gun', mesh(g.build(), 'paint', 'gunMesh'), marker('muzzle', 0, 0, -5.75));
  gun.position.set(0, 0.42, -2.05);
  const turret = group('turret', turretMesh, markMesh, gun);
  turret.position.set(0, top + 0.02, 0.35);
  body.add(turret);
  return root;
}

// -------------------------------------------------------------------------------------------------
// Eastern MBT
// -------------------------------------------------------------------------------------------------

/** Upper hemisphere dome, scaled into a cast turret shape. */
function dome(b: GeoBuilder, color: number, sx: number, sy: number, sz: number, x: number, y: number, z: number): void {
  const g = new THREE.SphereGeometry(1, 22, 9, 0, Math.PI * 2, 0, Math.PI / 2);
  b.add(g, color, x, y, z, 0, 0, 0, sx, sy, sz);
}

function eastTank(): THREE.Group {
  const root = new THREE.Group();
  const L = 7.0, W = 3.55;
  const hl = L / 2;
  const top = 1.42;
  const b = new GeoBuilder();
  // Hull: steep lower glacis, long shallow upper glacis, flat deck.
  b.profileX([
    [-hl + 0.05, 0.5], [hl - 0.6, 0.46], [hl + 0.05, 0.98], [hl - 1.9, top], [-hl + 0.15, top], [-hl - 0.02, top - 0.1], [-hl, 0.7],
  ], W * 0.6, PAINT, 0, 0, 0, 0.05);
  b.profileX([[hl - 0.25, 1.04], [hl - 1.95, top - 0.02], [-hl + 0.1, top - 0.02], [-hl + 0.1, 1.08]], W - 0.02, PAINT_B, 0, 0, 0, 0.03);
  // Reactive armor bricks on the upper glacis (chevron rows) + splash guard (trim vane)
  for (let r = 0; r < 3; r++) {
    for (let c = -3; c <= 3; c++) {
      const z = -hl + 0.6 + r * 0.42, y = 1.1 + r * 0.12;
      b.box(0.42, 0.1, 0.38, PAINT_B, c * 0.46, y + 0.04, z, -0.22);
    }
  }
  b.box(W * 0.62, 0.3, 0.05, PAINT_C, 0, 1.05, -hl + 0.02, -0.5);
  // Rubber side skirts with ERA panels at the front
  for (const s of [-1, 1]) {
    const x = s * (W / 2 - 0.03);
    b.box(0.05, 0.5, L - 1.5, DARK, x, 1.12, 0.35);
    for (let k = 0; k < 4; k++) b.box(0.14, 0.52, 0.58, PAINT_B, x + s * 0.05, 1.12, -hl + 0.85 + k * 0.6, 0, 0, s * -0.08);
    // External fuel tanks along the fenders
    for (let k = 0; k < 3; k++) b.box(0.5, 0.4, 0.9, PAINT_C, x - s * 0.3, top + 0.2, 0.3 + k * 0.95);
  }
  // Rear: two fuel drums on the rear plate, unditching log, exhaust on the left side
  for (const s of [-1, 1]) b.cyl(0.3, 0.3, 1.1, 14, PAINT_C, s * 0.72, top - 0.05, hl + 0.35, 0, 0, Math.PI / 2);
  b.cyl(0.14, 0.14, W * 0.8, 10, 0x4a3a28, 0, top + 0.12, hl - 0.2, 0, 0, Math.PI / 2);
  b.box(0.08, 0.3, 0.7, DARK, -(W / 2 - 0.05), 1.3, hl - 1.6);
  for (let i = 0; i < 7; i++) b.box(1.6, 0.03, 0.07, DARK, 0.2, top + 0.02, hl - 1.9 + i * 0.2);
  for (const s of [-1, 1]) {
    b.box(0.22, 0.18, 0.15, PAINT_C, s * 1.3, 1.25, -hl + 0.85, -0.5);
    b.box(0.16, 0.12, 0.04, 0xd8d0a0, s * 1.3, 1.26, -hl + 0.77, -0.5);
    b.box(0.18, 0.18, 0.16, METAL, s * 0.7, 0.6, -hl + 0.02);
  }
  runningGear(b, { L: L - 0.1, tx: W / 2 - 0.34, tw: 0.58, wheels: 6, wheelR: 0.4, endR: 0.33, endY: 0.6, topY: 0.98, returnRollers: 3, rearDrive: true });
  const body = group('body', mesh(bakeDust(b.build(), 0.25, 1.55, 0.9), 'paint', 'hull'));
  root.add(body);

  // Turret: low cast dome + ERA horseshoe + roof gear.
  const t = new GeoBuilder();
  dome(t, PAINT, 1.55, 0.72, 1.85, 0, 0, 0.15);
  t.cyl(1.52, 1.56, 0.12, 22, PAINT_B, 0, 0.02, 0.15);
  // Rear stowage boxes wrapping the turret back
  for (let i = -2; i <= 2; i++) {
    const a = Math.PI + i * 0.36;
    t.box(0.7, 0.44, 0.34, PAINT_C, Math.sin(a) * 1.72, 0.25, 0.15 - Math.cos(a) * 1.95, 0, a);
  }
  // ERA bricks in a V on the turret front, sloped back
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const a = s * (0.3 + i * 0.26);
      t.box(0.5, 0.36, 0.2, PAINT_B, Math.sin(a) * 1.35, 0.42, 0.15 - Math.cos(a) * 1.5, -0.35, a);
      t.box(0.5, 0.3, 0.2, PAINT_C, Math.sin(a) * 1.08, 0.72, 0.15 - Math.cos(a) * 1.18, -0.75, a);
    }
    // IR dazzler (red lens) beside the gun
    t.box(0.34, 0.28, 0.3, PAINT_C, s * 0.72, 0.6, -1.45);
    t.box(0.26, 0.2, 0.03, LENS, s * 0.72, 0.6, -1.61);
    // Smoke grenade tubes
    for (let i = 0; i < 6; i++) t.cyl(0.06, 0.06, 0.3, 7, DARK, s * (1.25 + i * 0.05), 0.6 + (i % 2) * 0.1, -0.35 + i * 0.12, 1.1, 0, s * 0.35);
  }
  // Commander cupola with remote MG, gunner's sight
  t.cyl(0.42, 0.46, 0.22, 14, PAINT_B, -0.55, 0.8, 0.45);
  t.box(0.2, 0.2, 0.55, DARK, -0.55, 1.0, 0.15);
  t.cyl(0.03, 0.03, 1.0, 6, DARK, -0.55, 1.02, -0.4, Math.PI / 2);
  t.box(0.5, 0.36, 0.52, PAINT_C, 0.6, 0.82, -0.3);
  t.box(0.4, 0.18, 0.04, OPTIC, 0.6, 0.86, -0.57);
  t.cyl(0.3, 0.3, 0.07, 12, PAINT_C, 0.6, 0.76, 0.6);
  // Snorkel tube strapped to the rear
  t.cyl(0.13, 0.13, 2.4, 10, PAINT_C, 0, 0.62, 2.12, 0, 0, Math.PI / 2);
  t.cyl(0.012, 0.02, 2.3, 4, DARK, 0.9, 1.7, 1.2);
  const turretMesh = mesh(t.build(), 'paint', 'turretShell');
  const m = new GeoBuilder();
  for (const s of [-1, 1]) m.box(0.03, 0.26, 0.55, 0xffffff, s * 1.6, 0.32, 0.55, 0, s * 0.25);
  const markMesh = mesh(m.build(), 'mark', 'mark');

  const g = new GeoBuilder();
  g.box(0.7, 0.5, 0.5, PAINT_B, 0, -0.02, 0.05);
  g.cyl(0.15, 0.16, 1.9, 16, PAINT_B, 0, 0, -1.3, Math.PI / 2);
  g.cyl(0.19, 0.19, 0.55, 16, PAINT_B, 0, 0, -2.45, Math.PI / 2);
  g.cyl(0.12, 0.125, 2.7, 16, PAINT_C, 0, 0, -4.05, Math.PI / 2);
  for (const z of [-0.8, -1.9, -3.2, -4.4]) g.cyl(0.15, 0.15, 0.05, 16, METAL, 0, 0, z, Math.PI / 2);
  g.cyl(0.125, 0.125, 0.25, 16, DARK, 0, 0, -5.45, Math.PI / 2);
  const gun = group('gun', mesh(g.build(), 'paint', 'gunMesh'), marker('muzzle', 0, 0, -5.62));
  gun.position.set(0, 0.42, -1.55);
  const turret = group('turret', turretMesh, markMesh, gun);
  turret.position.set(0, top + 0.02, 0.05);
  body.add(turret);
  return root;
}

// -------------------------------------------------------------------------------------------------
// IFVs
// -------------------------------------------------------------------------------------------------

function westIfv(): THREE.Group {
  const root = new THREE.Group();
  const L = 6.7, W = 3.3, hl = L / 2, top = 2.05;
  const b = new GeoBuilder();
  b.profileX([
    [-hl, 0.55], [hl - 0.7, 0.5], [hl + 0.05, 1.15], [hl - 1.2, 1.75], [hl - 1.5, top], [-hl + 0.05, top], [-hl, 0.8],
  ], W * 0.64, PAINT, 0, 0, 0, 0.06);
  b.profileX([[hl - 1.0, 1.3], [hl - 1.5, 1.5], [-hl + 0.1, 1.5], [-hl + 0.1, 1.3]], W - 0.02, PAINT_B, 0, 0, 0, 0.03);
  // Applique armor boxes on the hull sides, rear ramp, trim, hatches
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) b.box(0.14, 0.5, 1.25, PAINT_B, s * (W * 0.32 + 0.07), 1.72, -hl + 1.35 + k * 1.3);
    b.box(0.12, 0.55, L - 1.6, PAINT_C, s * (W / 2 - 0.04), 1.2, 0.3);
    b.box(0.26, 0.16, 0.12, PAINT_C, s * 1.2, 1.35, -hl + 0.55, -0.6);
  }
  b.box(1.5, 1.1, 0.08, PAINT_B, 0, 1.15, hl + 0.02);
  for (const s of [-1, 1]) b.cyl(0.28, 0.28, 0.06, 12, PAINT_C, s * 0.55, top + 0.03, hl - 1.1);
  for (let i = 0; i < 5; i++) b.box(0.9, 0.03, 0.08, DARK, -0.8, top + 0.02, -hl + 1.6 + i * 0.18);
  runningGear(b, { L: L - 0.2, tx: W / 2 - 0.32, tw: 0.55, wheels: 6, wheelR: 0.33, endR: 0.3, endY: 0.62, topY: 0.98, returnRollers: 3, rearDrive: false });
  const body = group('body', mesh(bakeDust(b.build(), 0.25, 1.55, 0.9), 'paint', 'hull'));
  root.add(body);
  const t = new GeoBuilder();
  t.planY([[1.05, 0.55], [0.55, 1.0], [-1.0, 1.0], [-1.25, 0.75], [-1.25, -0.75], [-1.0, -1.0], [0.55, -1.0], [1.05, -0.55]], 0.62, PAINT, 0, 0, 0, 0, 0, 0, 0.05);
  // ATGM launcher box on the left side, sights, smoke tubes
  t.box(0.5, 0.42, 1.25, PAINT_B, -1.25, 0.55, 0.05);
  for (const yy of [0.42, 0.66]) t.box(0.36, 0.16, 0.04, DARK, -1.25, yy, -0.59);
  t.box(0.42, 0.34, 0.42, PAINT_C, 0.45, 0.78, -0.2);
  t.box(0.32, 0.16, 0.04, OPTIC, 0.45, 0.82, -0.42);
  for (let i = 0; i < 4; i++) t.cyl(0.06, 0.06, 0.28, 7, DARK, 0.95 + i * 0.05, 0.45, -0.5 + i * 0.1, 1.1, 0, 0.3);
  t.cyl(0.012, 0.02, 2.0, 4, DARK, -0.6, 1.6, 0.9);
  const m = new GeoBuilder();
  for (const s of [-1, 1]) m.box(0.03, 0.22, 0.7, 0xffffff, s * 1.02, 0.3, 0.1);
  const g = new GeoBuilder();
  g.box(0.55, 0.38, 0.45, PAINT_B, 0, 0, 0);
  g.cyl(0.07, 0.07, 1.3, 10, PAINT_C, 0, 0, -0.85, Math.PI / 2);
  g.cyl(0.045, 0.045, 1.4, 8, DARK, 0, 0, -2.2, Math.PI / 2);
  g.cyl(0.075, 0.075, 0.28, 8, DARK, 0, 0, -2.9, Math.PI / 2);
  const gun = group('gun', mesh(g.build(), 'paint', 'gunMesh'), marker('muzzle', 0, 0, -3.1));
  gun.position.set(0, 0.36, -1.05);
  const turret = group('turret', mesh(t.build(), 'paint', 'turretShell'), mesh(m.build(), 'mark', 'mark'), gun);
  turret.position.set(0, top + 0.01, -0.35);
  body.add(turret);
  return root;
}

function eastIfv(): THREE.Group {
  const root = new THREE.Group();
  const L = 6.9, W = 3.1, hl = L / 2, top = 1.62;
  const b = new GeoBuilder();
  // Sharp wedge nose with the characteristic ribbed glacis
  b.profileX([
    [-hl, 0.55], [hl - 0.4, 0.5], [hl + 0.1, 0.78], [hl - 2.1, top], [-hl + 0.05, top], [-hl, 0.8],
  ], W * 0.66, PAINT, 0, 0, 0, 0.05);
  for (let i = 0; i < 6; i++) b.box(W * 0.6, 0.04, 0.06, PAINT_B, 0, 0.9 + i * 0.12, -hl + 0.4 + i * 0.3, -0.33);
  b.box(W * 0.62, 0.35, 0.04, PAINT_C, 0, 0.92, -hl + 0.62, -1.0);
  for (const s of [-1, 1]) {
    b.box(0.1, 0.35, L - 1.3, PAINT_B, s * (W / 2 - 0.04), 1.2, 0.2);
    for (let k = 0; k < 4; k++) b.cyl(0.08, 0.08, 0.06, 8, DARK, s * (W / 2 - 0.02), 1.35, 0.6 + k * 0.55, 0, 0, Math.PI / 2);
  }
  // Rear doors (fuel-tank doors), roof hatches
  for (const s of [-1, 1]) b.box(0.62, 0.8, 0.1, PAINT_B, s * 0.42, 1.15, hl + 0.02);
  for (let k = 0; k < 4; k++) b.box(0.55, 0.05, 0.7, PAINT_C, (k % 2 ? 1 : -1) * 0.42, top + 0.02, 0.5 + Math.floor(k / 2) * 0.9);
  runningGear(b, { L: L - 0.1, tx: W / 2 - 0.3, tw: 0.46, wheels: 6, wheelR: 0.36, endR: 0.28, endY: 0.58, topY: 0.95, returnRollers: 3, rearDrive: false });
  const body = group('body', mesh(bakeDust(b.build(), 0.25, 1.55, 0.9), 'paint', 'hull'));
  root.add(body);
  const t = new GeoBuilder();
  t.cyl(0.9, 1.05, 0.5, 16, PAINT, 0, 0.25, 0);
  dome(t, PAINT_B, 0.9, 0.22, 0.9, 0, 0.5, 0);
  t.box(0.34, 0.3, 0.3, PAINT_C, 0.55, 0.6, -0.35);
  t.box(0.28, 0.14, 0.03, OPTIC, 0.55, 0.62, -0.51);
  t.cyl(0.07, 0.07, 1.1, 8, PAINT_C, -0.3, 0.9, 0.0, Math.PI / 2 - 0.1);
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) t.cyl(0.05, 0.05, 0.26, 7, DARK, s * (0.8 + i * 0.05), 0.5, 0.2 + i * 0.1, 1.1, 0, s * 0.3);
  t.cyl(0.012, 0.02, 1.9, 4, DARK, -0.6, 1.4, 0.6);
  const m = new GeoBuilder();
  for (const s of [-1, 1]) m.box(0.03, 0.2, 0.5, 0xffffff, s * 1.0, 0.25, 0.1, 0, s * 0.2);
  const g = new GeoBuilder();
  g.box(0.36, 0.3, 0.4, PAINT_B, 0, 0, 0);
  g.cyl(0.05, 0.05, 2.3, 8, DARK, 0, 0, -1.4, Math.PI / 2);
  g.cyl(0.07, 0.07, 0.24, 8, DARK, 0, 0, -2.55, Math.PI / 2);
  const gun = group('gun', mesh(g.build(), 'paint', 'gunMesh'), marker('muzzle', 0, 0, -2.75));
  gun.position.set(0, 0.42, -0.85);
  const turret = group('turret', mesh(t.build(), 'paint', 'turretShell'), mesh(m.build(), 'mark', 'mark'), gun);
  turret.position.set(0, top, 0.2);
  body.add(turret);
  return root;
}

export function buildArmorTank(style: ArmorStyle): THREE.Group {
  return style === 'west' ? westTank() : eastTank();
}

export function buildArmorIfv(style: ArmorStyle): THREE.Group {
  return style === 'west' ? westIfv() : eastIfv();
}

/** Shared tracked running gear for other tracked vehicles (SPAAG). */
export function addRunningGear(b: GeoBuilder, L: number, W: number, wheels: number, wheelR: number): void {
  runningGear(b, { L: L - 0.2, tx: W / 2 - 0.33, tw: 0.56, wheels, wheelR, endR: 0.31, endY: 0.6, topY: 0.98, returnRollers: 3, rearDrive: true });
}
