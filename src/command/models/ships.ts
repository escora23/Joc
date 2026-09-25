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
const DECK = 0x4f5357;
const DECK_B = 0x44484c;

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
    col.push(cc.r, cc.g, cc.b, 1);
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
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
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

/** Rectangle-ish outline (forward, right) from f0 (aft) to f1 (fore), half-width hw, bow corners chamfered by c. */
function box2(f0: number, f1: number, hw: number, c = 0): Pt[] {
  return c > 0
    ? [[f1, hw - c], [f1 - c, hw], [f0, hw], [f0, -hw], [f1 - c, -hw], [f1, -(hw - c)]]
    : [[f1, hw], [f0, hw], [f0, -hw], [f1, -hw]];
}

/** Same outline pulled inward by d (sloped stealth faces). */
function inset(o: Pt[], d: number, df = d): Pt[] {
  let cf = 0, cr = 0;
  for (const [f, r] of o) {
    cf += f;
    cr += r;
  }
  cf /= o.length;
  cr /= o.length;
  return o.map(([f, r]) => [f - Math.sign(f - cf) * df, r - Math.sign(r - cr) * d] as Pt);
}

export function buildDestroyer(): THREE.Group {
  const L = 142, B = 17, F = 7.2;
  const root = new THREE.Group();
  const hull = mesh(hullGeometry({ L, B, draft: 5.6, freeboard: F, stations: 40 }), 'paint', 'hull');
  root.add(hull);
  const s = new GeoBuilder();
  const y0 = F - 0.3;
  // Forward superstructure: two sloped (stealth) tiers, bridge on top with a raked window band.
  const t1 = box2(-4, 25, 7.3, 2.2);
  s.prism(t1, inset(t1, 0.9, 0.7), y0, F + 6, PAINT);
  const t2 = box2(5, 22.5, 6.2, 2.0);
  s.prism(t2, inset(t2, 0.7, 0.9), F + 6, F + 9.6, PAINT_B);
  s.box(9.6, 0.95, 0.12, WINDOW, 0, F + 8.2, -21.95, -0.32);
  for (const sx of [-1, 1]) {
    s.box(0.12, 0.9, 11, WINDOW, sx * 5.78, F + 8.1, -13.5, 0, 0, sx * 0.2);
    // Phased-array radar faces on the tier-1 corners (angled 45°), flush with the sloped faces.
    s.box(0.25, 3.6, 3.6, PAINT_C, sx * 5.6, F + 3.6, -22.6, 0.12, sx * -0.78, 0);
    s.box(0.25, 3.6, 3.6, PAINT_C, sx * 6.8, F + 3.6, -1.2, 0.12, sx * 0.78, 0);
    // Bridge wings
    s.box(2.0, 0.3, 3.0, PAINT_B, sx * 7.0, F + 6.2, -18.5);
    // Doors and scuttles on tier 1
    for (let d = 0; d < 3; d++) s.box(0.1, 1.9, 0.9, 0x5d6166, sx * 6.95, F + 1.1, -6 - d * 5, 0, 0, sx * 0.14);
  }
  // Enclosed pyramid mast with the multi-function radar globe on top (the `radar` node spins inside it).
  const mb = box2(-1, 10, 3.6, 1.2), mt = box2(3, 6.6, 1.3, 0.5);
  s.prism(mb, mt, F + 9.4, F + 24.5, PAINT_C);
  s.box(5.8, 0.25, 0.25, PAINT_C, 0, F + 19, -5.2);
  s.cyl(0.9, 0.9, 1.6, 12, PAINT_B, 0, F + 25.3, -4.8);
  s.cyl(0.06, 0.1, 7, 4, DARK, 0, F + 33.5, -4.8);
  for (const sx of [-1, 1]) s.cyl(0.04, 0.07, 4.5, 4, DARK, sx * 2.3, F + 21.5, -5.2);
  // Funnel: sloped casing with a dark exhaust cap.
  const fu = box2(-37, -25, 3.7, 1.5);
  s.prism(fu, inset(fu, 1.0, 1.4), y0, F + 9, PAINT_B);
  s.box(3.8, 0.5, 7.2, DARK, 0, F + 9.1, 31);
  // Midships deckhouse between the funnel and the hangar (boats, launchers).
  const md = box2(-48, -22, 6.6, 0);
  s.prism(md, inset(md, 0.6, 0.3), y0, F + 3.2, PAINT);
  // Hangar + flight deck
  const hg = box2(-62, -48, 7.2, 0);
  s.prism(hg, inset(hg, 0.8, 0.4), y0, F + 6.5, PAINT);
  s.box(8, 5, 0.1, 0x5c6066, 0, F + 2.6, 62.05);
  s.box(13.5, 0.05, 8, DECK_B, 0, F + 0.06, 66);
  // Aft radar mast on the hangar roof
  s.prism(box2(-54, -50, 1.6, 0.4), box2(-53, -51, 0.6, 0.2), F + 6.4, F + 12, PAINT_C);
  s.sphere(1.3, 14, 10, 0xf2f2f2, 0, F + 12.8, 52);
  // Forward VLS (32 cells) and aft VLS
  s.box(8.2, 0.5, 7.4, 0x4a4e53, 0, F + 0.45, -33.5);
  for (let i = 0; i < 5; i++) s.box(8.3, 0.52, 0.1, 0x33363a, 0, F + 0.47, -37.1 + i * 1.8);
  for (let i = 0; i < 5; i++) s.box(0.1, 0.52, 7.5, 0x33363a, -4 + i * 2, F + 0.47, -33.5);
  // CIWS pedestal ahead of the bridge
  s.cyl(1.4, 1.7, 1.2, 14, PAINT_B, 0, F + 0.4, -27.2);
  s.box(7.4, 0.5, 5.2, 0x4a4e53, 0, F + 3.4, 40);
  for (let i = 0; i < 4; i++) s.box(7.5, 0.52, 0.1, 0x33363a, 0, F + 3.42, 37.6 + i * 1.6);
  // Anti-ship missile launchers (angled canisters) behind the funnel
  for (const sx of [-1, 1]) for (let i = 0; i < 2; i++) s.cyl(0.42, 0.42, 5.2, 10, PAINT_C, sx * (1.2 + i * 1.0), F + 4.3, 26 + i * 0.1, Math.PI / 2 - 0.25, sx * 0.9, 0);
  // Boats in their recesses
  for (const sx of [-1, 1]) {
    s.sphere(1.0, 12, 6, 0xe6ddc4, sx * 7.0, F + 2.6, 36, 1, 0.75, 3.6);
    s.box(0.6, 0.6, 7.6, 0x2e2f31, sx * 7.0, F + 2.0, 36);
  }
  // Deck-edge railings (both sides) with stanchions
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 14; k++) {
      const z0 = -60 + k * 9;
      const t = (71 - z0) / 142;
      const hb = (B / 2) * (t < 0.12 ? 0.86 + (t / 0.12) * 0.14 : t < 0.5 ? 1 : Math.max(0.1, Math.sqrt(Math.max(0, 1 - ((t - 0.5) / 0.5) ** 2 * 1.02)) * (1 - ((t - 0.5) / 0.5) * 0.25)));
      const fb = F * (1 + 0.55 * Math.pow(Math.max(0, (t - 0.55) / 0.45), 2));
      s.box(0.06, 0.06, 9, 0xd0d0d0, sx * (hb - 0.3), fb + 1.05, z0 - 4.5);
      s.box(0.06, 1.05, 0.06, 0xd0d0d0, sx * (hb - 0.3), fb + 0.52, z0);
    }
  }
  // Foredeck gear: breakwater, anchor windlasses, bollards
  s.prism([[50, 6.2], [54, 0], [50, -6.2], [49.4, -6.2], [53.2, 0], [49.4, 6.2]], [[50, 6.2], [54, 0], [50, -6.2], [49.4, -6.2], [53.2, 0], [49.4, 6.2]], F + 0.1, F + 1.1, PAINT_B);
  for (const sx of [-1, 1]) {
    s.cyl(0.5, 0.55, 0.6, 10, DARK, sx * 2.4, F + 0.6, -58);
    s.cyl(0.25, 0.25, 0.5, 8, DARK, sx * 5.2, F + 0.35, -40);
    s.cyl(0.25, 0.25, 0.5, 8, DARK, sx * 6.2, F + 0.3, 46);
  }
  root.add(mesh(s.build(), 'paint', 'superstructure'));
  // Flight deck markings (white): circle + center line.
  const fdm = new GeoBuilder();
  const ring = new THREE.RingGeometry(3.6, 3.9, 32);
  ring.rotateX(-Math.PI / 2);
  fdm.add(ring, 0xf0f0f0, 0, F + 0.11, 64);
  fdm.box(0.3, 0.02, 12, 0xf0f0f0, 0, F + 0.11, 64);
  fdm.box(11, 0.02, 0.3, 0xf0f0f0, 0, F + 0.11, 58.4);
  root.add(mesh(fdm.build(), 'paint', 'deckMarks'));
  // Nation marking: bow panels and a funnel band (team color).
  const m = new GeoBuilder();
  for (const sx of [-1, 1]) {
    m.box(0.08, 2.2, 6, 0xffffff, sx * 6.0, F - 1.8, -52);
    m.box(0.1, 1.2, 9, 0xffffff, sx * 3.05, F + 7.2, 31, 0, 0, sx * 0.13);
  }
  root.add(mesh(m.build(), 'mark', 'mark'));
  // Main gun: faceted stealth gun house (yaw) + long barrel (pitch).
  const t = new GeoBuilder();
  const gh: Pt[] = [[3.4, 0.6], [1.6, 2.2], [-2.6, 2.3], [-3.0, 1.6], [-3.0, -1.6], [-2.6, -2.3], [1.6, -2.2], [3.4, -0.6]];
  t.prism(gh, gh.map(([f, r]) => [f * 0.72 - 0.4, r * 0.62] as Pt), 0, 2.3, PAINT);
  t.cyl(2.6, 2.8, 0.5, 18, PAINT_B, 0, -0.15, 0.3);
  const gb = new GeoBuilder();
  gb.cyl(0.17, 0.24, 7.4, 14, PAINT_C, 0, 0, -3.9, Math.PI / 2);
  gb.cyl(0.25, 0.25, 0.45, 14, DARK, 0, 0, -7.55, Math.PI / 2);
  gb.box(1.0, 0.9, 1.4, PAINT_B, 0, 0, -0.1);
  const gun = new THREE.Group();
  gun.name = 'gun';
  gun.add(mesh(gb.build(), 'paint', 'gunMesh'));
  const mz = new THREE.Object3D();
  mz.name = 'muzzle';
  mz.position.set(0, 0, -7.9);
  gun.add(mz);
  gun.position.set(0, 1.1, -2.4);
  const turret = new THREE.Group();
  turret.name = 'turret';
  turret.add(mesh(t.build(), 'paint', 'turretShell'), gun);
  turret.position.set(0, F + 0.9, -44);
  root.add(turret);
  // Multi-function radar globe: a radome with two rotating array faces showing through its equator band.
  const r = new GeoBuilder();
  r.sphere(2.1, 20, 14, 0xf4f4f4, 0, 0, 0);
  for (const sz of [-1, 1]) r.box(2.6, 1.8, 0.2, 0x3a3f45, 0, 0, sz * 1.95);
  const radar = new THREE.Group();
  radar.name = 'radar';
  radar.add(mesh(r.build(), 'paint', 'radarMesh'));
  radar.position.set(0, F + 27.6, -4.8);
  root.add(radar);
  root.add(ciws('ciws0', 0, F + 1.0, -27.2));
  root.add(ciws('ciws1', 0, F + 6.5, 57.5));
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
