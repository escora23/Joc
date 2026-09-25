// FRONT ULTRA — command mode: procedural warships (owner: command). Lofted hull (flared bow, sheer, transom,
// anti-fouling below the waterline) + superstructure, mast, radars, main gun, CIWS. Faces -Z, waterline at y = 0.
// Children: `turret` (main gun yaw) > `gun` (pitch) > `muzzle`; `radar` (spins); `ciws0/1` (auto AA mounts).

import * as THREE from 'three';
import { GeoBuilder, type Pt } from './builder';
import type { Role } from './vehicles';

const PAINT = 0xf0f0f0;
const PAINT_B = 0xdadada;
const PAINT_C = 0xc6c6c6;
const DARK = 0x1c1d1f;
const WINDOW = 0x0f151b;
const DECK = 0x6c6e70;

function mesh(g: THREE.BufferGeometry, role: Role, name: string): THREE.Mesh {
  const m = new THREE.Mesh(g);
  m.userData.role = role;
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

interface HullOpts {
  L: number;
  B: number;
  draft: number;
  freeboard: number;
  stations: number;
}

/** Lofted hull geometry with vertex colors: anti-fouling red, black boot top, gray topsides, deck gray. */
export function hullGeometry(o: HullOpts): THREE.BufferGeometry {
  const N = o.stations;
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const colorAt = (y: number, isDeck: boolean): THREE.Color => {
    if (isDeck) return c.setHex(DECK);
    if (y < -0.4) return c.setHex(0x6a2c24);
    if (y < 0.5) return c.setHex(0x1d1c1c);
    return c.setHex(PAINT);
  };
  const halfBeam = (t: number): number => {
    // t: 0 = stern, 1 = bow
    if (t < 0.12) return 0.86 + (t / 0.12) * 0.14;
    if (t < 0.5) return 1;
    const u = (t - 0.5) / 0.5;
    return Math.max(0, Math.sqrt(Math.max(0, 1 - u * u * 1.02)) * (1 - u * 0.25));
  };
  const depth = (t: number): number => (t > 0.8 ? 1 - ((t - 0.8) / 0.2) * 0.55 : t < 0.05 ? 0.75 + t * 5 : 1);
  const fb = (t: number): number => o.freeboard * (1 + 0.55 * Math.pow(Math.max(0, (t - 0.55) / 0.45), 2));
  // Section: list of (x, y) from keel center up the starboard side (mirrored for port).
  const section = (t: number): Pt[] => {
    const hb = (o.B / 2) * halfBeam(t);
    const d = o.draft * depth(t);
    const f = fb(t);
    const flare = 1 + 0.12 * Math.max(0, (t - 0.55) / 0.45);
    return [[0, -d], [hb * 0.5, -d * 0.95], [hb * 0.84, -d * 0.66], [hb * 0.98, -d * 0.2], [hb, 0.25], [hb * flare, f]];
  };
  const zAt = (t: number, y: number): number => {
    // Raked stem: the bow top leans forward.
    const z = o.L / 2 - t * o.L;
    if (t > 0.97) return z - (Math.max(0, y) / o.freeboard) * o.L * 0.02;
    return z;
  };
  const push = (x: number, y: number, z: number, deck = false) => {
    pos.push(x, y, z);
    const cc = colorAt(y, deck);
    col.push(cc.r, cc.g, cc.b);
  };
  const tri = (a: number[], b: number[], d: number[], deck = false) => {
    push(a[0], a[1], a[2], deck);
    push(b[0], b[1], b[2], deck);
    push(d[0], d[1], d[2], deck);
  };
  let prev = section(0);
  let prevT = 0;
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const cur = section(t);
    for (const s of [1, -1]) {
      for (let k = 0; k < cur.length - 1; k++) {
        const a = [s * prev[k][0], prev[k][1], zAt(prevT, prev[k][1])];
        const b = [s * prev[k + 1][0], prev[k + 1][1], zAt(prevT, prev[k + 1][1])];
        const cc = [s * cur[k][0], cur[k][1], zAt(t, cur[k][1])];
        const d = [s * cur[k + 1][0], cur[k + 1][1], zAt(t, cur[k + 1][1])];
        if (s > 0) {
          tri(a, cc, b);
          tri(b, cc, d);
        } else {
          tri(a, b, cc);
          tri(b, d, cc);
        }
      }
      // Deck strip
      const pa = prev[prev.length - 1], ca = cur[cur.length - 1];
      const a = [s * pa[0], pa[1], zAt(prevT, pa[1])], b = [0, pa[1], zAt(prevT, pa[1])];
      const cc = [s * ca[0], ca[1], zAt(t, ca[1])], d = [0, ca[1], zAt(t, ca[1])];
      if (s > 0) {
        tri(a, cc, b, true);
        tri(b, cc, d, true);
      } else {
        tri(a, b, cc, true);
        tri(b, d, cc, true);
      }
    }
    prev = cur;
    prevT = t;
  }
  // Transom (stern face at t = 0).
  const st = section(0);
  for (let k = 0; k < st.length - 1; k++) {
    const z = o.L / 2;
    const a = [st[k][0], st[k][1], z], b = [st[k + 1][0], st[k + 1][1], z];
    const a2 = [-st[k][0], st[k][1], z], b2 = [-st[k + 1][0], st[k + 1][1], z];
    tri(a, b, a2);
    tri(a2, b, b2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function ciws(name: string, x: number, y: number, z: number): THREE.Group {
  const b = new GeoBuilder();
  b.cyl(0.9, 1.0, 1.0, 12, PAINT_B, 0, 0.5, 0);
  b.cyl(0.7, 0.7, 1.4, 12, 0xf6f6f6, 0, 1.7, 0.1);
  b.sphere(0.7, 12, 8, 0xf6f6f6, 0, 2.4, 0.1);
  b.cyl(0.12, 0.12, 1.8, 8, DARK, 0, 1.3, -1.2, Math.PI / 2);
  const g = new THREE.Group();
  g.name = name;
  g.add(mesh(b.build(), 'paint', `${name}Mesh`));
  g.position.set(x, y, z);
  return g;
}

export function buildDestroyer(): THREE.Group {
  const L = 142, B = 17, F = 7.2;
  const root = new THREE.Group();
  const hull = mesh(hullGeometry({ L, B, draft: 5.6, freeboard: F, stations: 40 }), 'paint', 'hull');
  root.add(hull);
  const s = new GeoBuilder();
  // Forward superstructure (bridge block): stepped levels.
  s.planY([[22, 7.2], [4, 7.4], [4, -7.4], [22, -7.2]], 5.5, PAINT, 0, F, 0);
  s.planY([[19, 6.2], [9, 6.8], [9, -6.8], [19, -6.2]], 3.2, PAINT_B, 0, F + 5.5, 0);
  s.box(12.2, 1.0, 0.1, WINDOW, 0, F + 7.3, -19.05);
  for (const sx of [-1, 1]) s.box(0.1, 1.0, 6, WINDOW, sx * 6.55, F + 7.2, -15);
  // Flat SPY-style radar panels on the bridge corners.
  for (const sx of [-1, 1]) s.box(0.3, 3.2, 3.2, PAINT_C, sx * 6.9, F + 3.2, -19.5, 0, -sx * 0.6, 0);
  // Mast: tapered tripod + yards + radar
  s.cyl(0.35, 0.8, 16, 8, PAINT_C, 0, F + 8.7 + 8, -8);
  s.cyl(0.15, 0.4, 13, 6, PAINT_C, 2.0, F + 8.7 + 6, -5.5, -0.15, 0, -0.14);
  s.cyl(0.15, 0.4, 13, 6, PAINT_C, -2.0, F + 8.7 + 6, -5.5, -0.15, 0, 0.14);
  s.box(9, 0.3, 0.3, PAINT_C, 0, F + 20.5, -8);
  s.box(6, 0.3, 0.3, PAINT_C, 0, F + 23.5, -8);
  s.cyl(0.05, 0.08, 6, 4, DARK, 0, F + 27.5, -8);
  // Funnel(s)
  s.planY([[-26, 3.2], [-34, 3.6], [-34, -3.6], [-26, -3.2]], 8, PAINT_B, 0, F, 0);
  s.box(5.8, 0.6, 6.6, DARK, 0, F + 8.2, 30);
  s.planY([[-44, 3.0], [-50, 3.3], [-50, -3.3], [-44, -3.0]], 6.5, PAINT_B, 0, F, 0);
  s.box(5.2, 0.6, 5.2, DARK, 0, F + 6.7, 47);
  // Hangar + flight deck marking
  s.planY([[-52, 7.0], [-64, 7.2], [-64, -7.2], [-52, -7.0]], 6, PAINT, 0, F, 0);
  s.box(12.5, 0.05, 12, 0x55575a, 0, F + 0.05, 58 + 6);
  // VLS block forward
  s.box(8, 0.35, 7, DARK, 0, F + 0.6, -30);
  for (let i = 0; i < 4; i++) s.box(8.1, 0.38, 0.12, 0x2d2e30, 0, F + 0.62, -33 + i * 2);
  // Boats and davits
  for (const sx of [-1, 1]) {
    s.sphere(1.0, 10, 6, 0xe8e0c8, sx * 7.4, F + 3.4, 38, 1, 0.7, 3.8);
    s.box(0.3, 3, 0.3, PAINT_C, sx * 7.4, F + 1.6, 35);
    s.box(0.3, 3, 0.3, PAINT_C, sx * 7.4, F + 1.6, 41);
  }
  // Harpoon canisters
  for (let i = 0; i < 4; i++) s.cyl(0.4, 0.4, 5, 8, PAINT_C, -3 + i * 1.6, F + 1.0, -1.5 + 0, Math.PI / 2 - 0.2, 0, 0);
  // Bridge wings, window bands on every deck level, doors.
  for (const sx of [-1, 1]) {
    s.box(2.2, 0.35, 3.2, PAINT_B, sx * 7.9, F + 7.6, -16.5);
    s.box(0.12, 0.9, 12, WINDOW, sx * 7.25, F + 3.4, -13);
    s.box(0.12, 0.7, 10, WINDOW, sx * 7.05, F + 2.2, 36);
    s.box(0.12, 0.7, 11, WINDOW, sx * 7.25, F + 4.3, 58);
    for (let d = 0; d < 3; d++) s.box(0.1, 1.9, 0.9, 0x55595e, sx * 7.3, F + 1.0, -8 - d * 5);
  }
  s.box(13.5, 0.8, 0.1, WINDOW, 0, F + 3.4, -22.05);
  // Deck-edge railings (both sides, full length) and stanchions.
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 14; k++) {
      const z0 = -60 + k * 9;
      const t = (71 - z0) / 142;
      const hb = (B / 2) * (t < 0.12 ? 0.86 + (t / 0.12) * 0.14 : t < 0.5 ? 1 : Math.max(0.1, Math.sqrt(Math.max(0, 1 - ((t - 0.5) / 0.5) ** 2 * 1.02)) * (1 - ((t - 0.5) / 0.5) * 0.25)));
      const fb = F * (1 + 0.55 * Math.pow(Math.max(0, (t - 0.55) / 0.45), 2));
      s.box(0.06, 0.06, 9, 0xd8d8d8, sx * (hb - 0.3), fb + 1.05, z0 - 4.5);
      s.box(0.06, 1.05, 0.06, 0xd8d8d8, sx * (hb - 0.3), fb + 0.52, z0);
    }
  }
  // Radomes, satcom domes, whip antennas, yard lights
  s.sphere(1.1, 12, 8, 0xf4f4f4, 3.2, F + 10.3, -12);
  s.sphere(1.1, 12, 8, 0xf4f4f4, -3.2, F + 10.3, -12);
  s.sphere(0.8, 10, 8, 0xf4f4f4, 0, F + 29.5, -8);
  for (const [x, z, h] of [[5.5, 26, 10], [-5.5, 26, 10], [4.8, 50, 8], [-4.8, 50, 8]] as const) s.cyl(0.05, 0.09, h, 4, DARK, x, F + 6 + h / 2, z);
  // Anchor hawse, bollards, deck gear on the foredeck
  for (const sx of [-1, 1]) {
    s.box(0.5, 0.5, 0.5, DARK, sx * 3.6, F + 0.3, -56);
    s.cyl(0.3, 0.3, 0.5, 8, DARK, sx * 5.2, F + 0.35, -40);
    s.cyl(0.3, 0.3, 0.5, 8, DARK, sx * 6.2, F + 0.3, 44);
    s.cyl(0.55, 0.55, 1.6, 10, 0xe0e0e0, sx * 6.4, F + 1.2, 2, Math.PI / 2);
  }
  // Funnel caps & exhaust grilles
  s.box(6.2, 0.25, 7.2, PAINT_C, 0, F + 8.05, 30);
  s.box(5.4, 0.25, 5.8, PAINT_C, 0, F + 6.55, 47);
  root.add(mesh(s.build(), 'paint', 'superstructure'));
  // Flight deck markings (white): circle + center line.
  const fdm = new GeoBuilder();
  const ring = new THREE.RingGeometry(3.6, 3.9, 32);
  ring.rotateX(-Math.PI / 2);
  fdm.add(ring, 0xf0f0f0, 0, F + 0.11, 64);
  fdm.box(0.3, 0.02, 12, 0xf0f0f0, 0, F + 0.11, 64);
  fdm.box(11, 0.02, 0.3, 0xf0f0f0, 0, F + 0.11, 58.4);
  root.add(mesh(fdm.build(), 'paint', 'deckMarks'));
  // Hull number / flag marking (team color) on both sides of the bow and a stripe on the funnel.
  const m = new GeoBuilder();
  for (const sx of [-1, 1]) {
    m.box(0.08, 2.4, 6, 0xffffff, sx * 6.0, F - 1.8, -52);
    m.box(0.1, 1.6, 7.8, 0xffffff, sx * 3.62, F + 6.2, 30);
  }
  root.add(mesh(m.build(), 'mark', 'mark'));
  // Main gun turret (yaw) + barrel (pitch)
  const t = new GeoBuilder();
  t.planY([[3.2, 0.8], [1.2, 2.3], [-2.8, 2.3], [-3.2, 1.6], [-3.2, -1.6], [-2.8, -2.3], [1.2, -2.3], [3.2, -0.8]], 2.4, PAINT);
  t.cyl(2.6, 2.8, 0.6, 16, PAINT_B, 0, -0.1, 0.3);
  const gb = new GeoBuilder();
  gb.cyl(0.18, 0.24, 7.2, 12, PAINT_C, 0, 0, -3.8, Math.PI / 2);
  gb.cyl(0.26, 0.26, 0.5, 12, DARK, 0, 0, -7.4, Math.PI / 2);
  gb.box(1.1, 1.0, 1.0, PAINT_B, 0, 0, -0.2);
  const gun = new THREE.Group();
  gun.name = 'gun';
  gun.add(mesh(gb.build(), 'paint', 'gunMesh'));
  const mz = new THREE.Object3D();
  mz.name = 'muzzle';
  mz.position.set(0, 0, -7.8);
  gun.add(mz);
  gun.position.set(0, 1.2, -2.6);
  const turret = new THREE.Group();
  turret.name = 'turret';
  turret.add(mesh(t.build(), 'paint', 'turretShell'), gun);
  turret.position.set(0, F + 1.0, -44);
  root.add(turret);
  // Spinning air-search radar on the mast.
  const r = new GeoBuilder();
  r.box(6.5, 1.3, 0.25, PAINT_C, 0, 0, 0, 0.2);
  r.box(0.4, 0.8, 0.4, DARK, 0, -0.9, 0.2);
  const radar = new THREE.Group();
  radar.name = 'radar';
  radar.add(mesh(r.build(), 'paint', 'radarMesh'));
  radar.position.set(0, F + 25, -8);
  root.add(radar);
  root.add(ciws('ciws0', 0, F + 5.5 + 3.2, -4.5));
  root.add(ciws('ciws1', 0, F + 6, 55.0));
  return root;
}

export function buildPatrolBoat(): THREE.Group {
  const L = 44, B = 7.6, F = 3.0;
  const root = new THREE.Group();
  root.add(mesh(hullGeometry({ L, B, draft: 2.0, freeboard: F, stations: 26 }), 'paint', 'hull'));
  const s = new GeoBuilder();
  s.planY([[3, 3.1], [-10, 3.4], [-10, -3.4], [3, -3.1]], 3.2, PAINT, 0, F, 0);
  s.planY([[1.5, 2.6], [-5, 2.9], [-5, -2.9], [1.5, -2.6]], 2.2, PAINT_B, 0, F + 3.2, 0);
  s.box(5.2, 0.8, 0.1, WINDOW, 0, F + 4.4, -1.55);
  s.cyl(0.2, 0.4, 8, 6, PAINT_C, 0, F + 5.4 + 4, 2.5);
  s.box(3.6, 0.2, 0.2, PAINT_C, 0, F + 11, 2.5);
  s.planY([[-12, 2.4], [-18, 2.6], [-18, -2.6], [-12, -2.4]], 1.4, PAINT_B, 0, F, 0);
  for (const sx of [-1, 1]) s.cyl(0.35, 0.35, 4, 8, PAINT_C, sx * 1.8, F + 0.7, 14, Math.PI / 2 - 0.15, 0, 0);
  root.add(mesh(s.build(), 'paint', 'superstructure'));
  const m = new GeoBuilder();
  for (const sx of [-1, 1]) m.box(0.08, 1.1, 3.5, 0xffffff, sx * 2.9, F - 0.9, -15);
  root.add(mesh(m.build(), 'mark', 'mark'));
  const t = new GeoBuilder();
  t.cyl(1.2, 1.4, 1.2, 12, PAINT, 0, 0.6, 0);
  t.sphere(1.2, 12, 6, PAINT_B, 0, 1.2, 0, 1, 0.6, 1.2);
  const gb = new GeoBuilder();
  gb.cyl(0.1, 0.12, 3.6, 8, PAINT_C, 0, 0, -1.9, Math.PI / 2);
  const gun = new THREE.Group();
  gun.name = 'gun';
  gun.add(mesh(gb.build(), 'paint', 'gunMesh'));
  const mz = new THREE.Object3D();
  mz.name = 'muzzle';
  mz.position.set(0, 0, -3.8);
  gun.add(mz);
  gun.position.set(0, 1.2, -0.6);
  const turret = new THREE.Group();
  turret.name = 'turret';
  turret.add(mesh(t.build(), 'paint', 'turretShell'), gun);
  turret.position.set(0, F, -12);
  root.add(turret);
  const r = new GeoBuilder();
  r.box(2.6, 0.5, 0.15, PAINT_C, 0, 0, 0);
  const radar = new THREE.Group();
  radar.name = 'radar';
  radar.add(mesh(r.build(), 'paint', 'radarMesh'));
  radar.position.set(0, F + 12, 2.5);
  root.add(radar);
  return root;
}
