// FRONT ULTRA — command mode: soldiers with real proportions, uniforms in their nation's colours and vertex-shader
// animation (owner item 32). Owner: command.
//
// One merged geometry per variant and level of detail, drawn with InstancedMesh (thousands of figures in one draw
// call). Each vertex knows which body part it belongs to (`aPart`: upper body, the two thighs and shins, the arms with
// the weapon) and how it is coloured (`aTint`: fixed colour, uniform, the nation's band, helmet). Each instance carries
// its animation (`aAnim`: pose, gait phase, time of its last shot, time it took the pose) and its nation colour plus a
// seed (`aBand`). The vertex shader bends hips and knees, swings the arms, leans the torso and lays the body down, so
// running, kneeling to fire, going prone, firing (recoil) and falling when hit cost nothing on the CPU: the world only
// writes a pose code when it changes.
//
// Model frame: feet at y = 0, about 1.8 m tall, facing -Z (the command-mode convention). The arms and the weapon are
// modelled in the aiming pose (rifle at the shoulder); other poses rotate that group about the shoulders.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GeoBuilder, shade } from './builder';

/** Pose codes (aAnim.x). */
export const POSE = {
  idle: 0,
  walk: 1,
  run: 2,
  kneel: 3,
  prone: 4,
  dead: 5,
  aim: 6,
  /** Bent forward, rifle low: an advance under fire (the rushes of an assault wave). */
  rush: 7,
} as const;
export type Pose = (typeof POSE)[keyof typeof POSE];

/** Body parts (aPart). */
const P_UPPER = 0, P_THIGH_L = 1, P_SHIN_L = 2, P_THIGH_R = 3, P_SHIN_R = 4, P_ARMS = 5;
/** Colour channels (aTint). */
const T_FIXED = 0, T_UNIFORM = 1, T_BAND = 2, T_HELMET = 3, T_GEAR = 4;

const HIP_Y = 0.93;
const KNEE_Y = 0.51;
const HIP_X = 0.095;
const SHOULDER_Y = 1.41;

const C_UNI = 0xffffff; // multiplied by the instance's uniform colour
const C_UNI_D = 0xd6d6d6;
const C_SKIN = [0xb88a6c, 0x8a5e42, 0xd2a284];
const C_BOOT = 0x2b2620;
const C_SOLE = 0x1a1816;
const C_GLOVE = 0x6a5a44;
const C_GUN = 0x1f2022;
const C_GUN_W = 0x4a3a2a;
const C_LAUNCHER = 0x46503a;
const C_GOGGLE = 0x24221f;
const C_LENS = 0x3a4248;

interface Piece {
  g: THREE.BufferGeometry;
  part: number;
  tint: number;
}

/** A ring of a loft: height (or position along the axis), half-width, front and back depth, centre offsets. */
type Ring = [y: number, rx: number, rzFront: number, rzBack: number, x?: number, z?: number];

/**
 * A closed loft through elliptical rings stacked along Y (`p` > 2 squares the ellipse off: packs, pouches). Front
 * (-Z) and back (+Z) take their own depth, so a chest bulges forward and a back stays flat. Smooth normals, capped.
 */
function loftGeometry(rings: Ring[], segs: number, p = 2): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const e = 2 / p;
  for (const [y, rx, rf, rb, x = 0, z = 0] of rings) {
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const cx = Math.sign(c) * Math.pow(Math.abs(c), e), sz = Math.sign(s) * Math.pow(Math.abs(s), e);
      pos.push(x + rx * cx, y, z + (sz < 0 ? rf : rb) * sz);
    }
  }
  const R = rings.length;
  for (let r = 0; r < R - 1; r++) {
    for (let i = 0; i < segs; i++) {
      const a = r * segs + i, b = r * segs + ((i + 1) % segs), c = a + segs, d = b + segs;
      idx.push(a, c, b, b, c, d);
    }
  }
  // Caps: a centre vertex at each end, a little beyond the last ring (rounded ends).
  const b0 = pos.length / 3;
  const [y0, , , , x0 = 0, z0 = 0] = rings[0];
  const [y1, , , , x1 = 0, z1 = 0] = rings[R - 1];
  const dir = Math.sign(y1 - y0) || 1;
  pos.push(x0, y0 - dir * 0.004, z0, x1, y1 + dir * 0.004, z1);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    idx.push(b0, i, j);
    idx.push(b0 + 1, (R - 1) * segs + j, (R - 1) * segs + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // Outward winding whatever the stacking direction.
  if (dir < 0) {
    const ix = g.index as THREE.BufferAttribute;
    for (let i = 0; i < ix.count; i += 3) {
      const t = ix.getX(i + 1);
      ix.setX(i + 1, ix.getX(i + 2));
      ix.setX(i + 2, t);
    }
  }
  g.computeVertexNormals();
  return g;
}

class SoldierBuilder {
  readonly pieces: Piece[] = [];
  part = P_UPPER;
  tint = T_FIXED;
  constructor(readonly hi: boolean) {}

  push2(fn: (b: GeoBuilder) => void): void {
    this.push(fn);
  }

  private push(fn: (b: GeoBuilder) => void): void {
    const b = new GeoBuilder();
    fn(b);
    this.pieces.push({ g: b.build(), part: this.part, tint: this.tint });
  }

  box(w: number, h: number, d: number, c: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.push((b) => b.box(w, h, d, c, x, y, z, rx, ry, rz));
  }

  sphere(r: number, c: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): void {
    const ws = this.hi ? 12 : 6, hs = this.hi ? 8 : 4;
    this.push((b) => b.sphere(r, ws, hs, c, x, y, z, sx, sy, sz));
  }

  /** A loft along Y (see loftGeometry), rotated by (rx, ry, rz) about the origin of its rings, then moved by (x, y, z). */
  loft(rings: Ring[], c: number, segs: number, p = 2, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
    this.push((b) => b.add(loftGeometry(rings, segs, p), c, x, y, z, rx, ry, rz));
  }

  /**
   * A limb from a to b through `radii` (evenly spaced along it: muscle, elbow or knee bulge, wrist or ankle), round on
   * the close level of detail; a tapered box on the far one.
   */
  limb(a: [number, number, number], bb: [number, number, number], radii: number[], c: number, flat = 1): void {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...bb);
    const d = new THREE.Vector3().subVectors(B, A);
    const len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const e = new THREE.Euler().setFromQuaternion(q);
    const n = radii.length;
    if (this.hi) {
      // The end rings close in (a rounded joint where limbs meet), the inner ones follow the profile.
      const rings: Ring[] = [];
      rings.push([-0.25 * radii[0], radii[0] * 0.55, radii[0] * 0.55 * flat, radii[0] * 0.55 * flat]);
      radii.forEach((r, i) => rings.push([(i / (n - 1)) * len, r, r * flat, r * flat]));
      rings.push([len + 0.25 * radii[n - 1], radii[n - 1] * 0.55, radii[n - 1] * 0.55 * flat, radii[n - 1] * 0.55 * flat]);
      this.loft(rings, c, 10, 2, A.x, A.y, A.z, e.x, e.y, e.z);
    } else {
      const r0 = radii[0], r1 = radii[n - 1];
      const g = new THREE.CylinderGeometry(r1 * 0.9, r0 * 0.9, len, 4, 1);
      g.rotateY(Math.PI / 4);
      g.translate(0, len / 2, 0);
      this.push((b) => b.add(g, c, A.x, A.y, A.z, e.x, e.y, e.z));
    }
  }

  cyl(rt: number, rb: number, h: number, c: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    const seg = this.hi ? 10 : 6;
    this.push((b) => b.cyl(rt, rb, h, seg, c, x, y, z, rx, ry, rz));
  }

  build(): THREE.BufferGeometry {
    const geos = this.pieces.map((p, k) => {
      const n = p.g.attributes.position.count;
      p.g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(p.part), 1));
      p.g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(n).fill(p.tint), 1));
      p.g.setAttribute('aPiece', new THREE.BufferAttribute(new Float32Array(n).fill(k), 1));
      return p.g;
    });
    const g = mergeGeometries(geos, false);
    for (const p of geos) p.dispose();
    bakeOcclusion(g, this.hi);
    g.deleteAttribute('aPiece');
    g.computeBoundingSphere();
    // Animated poses reach about 1 m forward (prone) and back (fallen): a generous bound for culling.
    if (g.boundingSphere) g.boundingSphere.radius = 2.2;
    return g;
  }
}

/**
 * Gauntlet round 1: baked occlusion in the vertex colours, so a figure has creases and shade at 20 m and not the flat
 * look of lit blocks. Every vertex darkens with the surfaces of other pieces close in front of it (armpits, the
 * collar under the helmet, the seams of the vest, belt and pack, between the legs) — on the close level of detail —
 * and on both levels with how much it faces the ground (undersides) and toward the boots (less sky reaches low).
 */
function bakeOcclusion(g: THREE.BufferGeometry, hi: boolean): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const col = g.attributes.color as THREE.BufferAttribute;
  const piece = g.attributes.aPiece as THREE.BufferAttribute;
  const n = pos.count;
  const occ = new Float32Array(n);
  if (hi) {
    const R = 0.075, cell = R;
    const grid = new Map<string, number[]>();
    const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let i = 0; i < n; i++) {
      const k = key(pos.getX(i), pos.getY(i), pos.getZ(i));
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(i);
    }
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      const pc = piece.getX(i);
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let o = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const l = grid.get(`${cx + a},${cy + b},${cz + c}`);
        if (!l) continue;
        for (const j of l) {
          if (piece.getX(j) === pc) continue;
          const dx = pos.getX(j) - x, dy = pos.getY(j) - y, dz = pos.getZ(j) - z;
          const d = Math.hypot(dx, dy, dz);
          if (d > R || d < 1e-4) continue;
          const f = (dx * nx + dy * ny + dz * nz) / d;
          if (f > 0.05) o += f * (1 - d / R);
        }
      }
      occ[i] = o;
    }
  }
  for (let i = 0; i < n; i++) {
    const ny = nor.getY(i), y = pos.getY(i);
    let k = 1 - Math.min(0.42, occ[i] * 0.11);
    k *= 1 - 0.22 * Math.max(0, -ny);
    k *= 0.86 + 0.14 * Math.min(1, Math.max(0, y / 0.9));
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
}

/**
 * A soldier: variant 0 rifleman, 1 anti-tank gunner (launcher on the shoulder), 2 machine gunner (belt-fed gun);
 * `hi` = the close-up level of detail, else the crowd's (tapered boxes, about a quarter of the triangles). `skin` picks
 * one of three skin tones.
 *
 * Gauntlet round 1 (the owner's «muñequitos raros» at 20 m): a man in field gear with a human build, not a toy. Lofted
 * body: hips, a tapered waist, a chest that bulges forward, shoulders that slope (bevelled) into round deltoids; slim
 * limbs that taper with knee and elbow bulges, trousers bloused into shaped boots with a toe and heel, gloved hands
 * with a thumb; a thin plate carrier over the chest (not a crate) with small pouches, a pack about 60 % of the
 * torso's size; a neck gaiter up to the nose and goggles, so the face is a shaded band of skin and eyes under the
 * helmet's rim, not a flat block. The nation shows only as a small, muted patch on the helmet and the left sleeve
 * (and in the camouflage's patches, drawn by the shader). Creases are shaded by bakeOcclusion.
 */
export function buildSoldierGeometry(variant: 0 | 1 | 2, hi: boolean, skin = 0): THREE.BufferGeometry {
  const s = new SoldierBuilder(hi);
  const sk = C_SKIN[skin % C_SKIN.length];
  const SEG = hi ? 14 : 6;
  // --- Legs (thigh / shin pairs): trousers, cargo pocket, knee pad, boots ---
  for (const side of [-1, 1]) {
    const x = side * HIP_X;
    s.part = side < 0 ? P_THIGH_L : P_THIGH_R;
    s.tint = T_UNIFORM;
    s.limb([x, HIP_Y + 0.04, 0.005], [x * 1.04, KNEE_Y, -0.01], [0.088, 0.09, 0.08, 0.068, 0.06], C_UNI);
    if (hi) {
      // Cargo pocket on the outside of the thigh.
      s.loft([[0.64, 0.024, 0.055, 0.055], [0.7, 0.03, 0.06, 0.06], [0.77, 0.026, 0.055, 0.055]], C_UNI_D, 8, 3, x + side * 0.072, 0, 0.0);
      // Knee pad.
      s.tint = T_GEAR;
      s.sphere(0.052, C_UNI, x * 1.04, KNEE_Y + 0.005, -0.045, 0.95, 1.15, 0.6);
    }
    s.part = side < 0 ? P_SHIN_L : P_SHIN_R;
    s.tint = T_UNIFORM;
    s.limb([x * 1.04, KNEE_Y, -0.01], [x, 0.17, 0.012], [0.058, 0.064, 0.058, 0.05, 0.05], C_UNI_D);
    s.tint = T_FIXED;
    // Boot: an upper round the ankle, a foot that runs out to a rounded toe, a sole.
    if (hi) {
      s.loft([[0.2, 0.05, 0.05, 0.05, x, 0.012], [0.13, 0.054, 0.06, 0.06, x, 0.012], [0.08, 0.055, 0.1, 0.07, x, -0.01], [0.035, 0.056, 0.16, 0.075, x, -0.035], [0.012, 0.05, 0.165, 0.07, x, -0.035]], C_BOOT, 12);
      s.loft([[0.0, 0.054, 0.17, 0.075, x, -0.035], [0.022, 0.057, 0.173, 0.078, x, -0.035]], C_SOLE, 12);
    } else {
      s.box(0.11, 0.16, 0.14, C_BOOT, x, 0.09, 0.015);
      s.box(0.11, 0.06, 0.25, C_BOOT, x, 0.03, -0.04);
    }
  }
  // --- Upper body ---
  s.part = P_UPPER;
  s.tint = T_UNIFORM;
  // Pelvis, a tapered waist, a chest that bulges forward, shoulders that slope into the collar.
  s.loft([
    [0.84, 0.13, 0.085, 0.09], [0.9, 0.17, 0.1, 0.11], [0.98, 0.172, 0.105, 0.11], [1.06, 0.158, 0.1, 0.1],
    [1.16, 0.172, 0.118, 0.104], [1.26, 0.19, 0.128, 0.11], [1.34, 0.196, 0.118, 0.108], [1.4, 0.18, 0.1, 0.095],
    [1.44, 0.13, 0.08, 0.075], [1.465, 0.07, 0.06, 0.055],
  ], C_UNI, SEG);
  if (hi) {
    // Deltoids: round shoulders where the sleeves begin.
    for (const side of [-1, 1]) s.sphere(0.068, C_UNI, side * 0.192, SHOULDER_Y - 0.015, 0.0, 1, 0.95, 1.05);
  }
  // Plate carrier: a thin vest over the chest and back with small magazine pouches, the belt, a canteen and a pouch.
  s.tint = T_GEAR;
  s.loft([[1.05, 0.172, 0.118, 0.112], [1.1, 0.184, 0.132, 0.118], [1.22, 0.198, 0.146, 0.124], [1.33, 0.2, 0.136, 0.12], [1.375, 0.18, 0.12, 0.11]], C_UNI, SEG);
  s.loft([[0.955, 0.18, 0.112, 0.116], [0.975, 0.184, 0.116, 0.12], [1.005, 0.182, 0.114, 0.118], [1.02, 0.176, 0.11, 0.114]], C_UNI_D, SEG);
  if (hi) {
    for (const px of [-0.1, -0.034, 0.034, 0.1]) s.loft([[1.07, 0.028, 0.022, 0.022], [1.12, 0.03, 0.024, 0.024], [1.165, 0.028, 0.022, 0.022]], C_UNI_D, 8, 3.5, px, 0, -0.145);
    s.loft([[1.25, 0.045, 0.02, 0.02], [1.3, 0.048, 0.022, 0.022]], C_UNI_D, 8, 3.5, -0.09, 0, -0.152);
    s.cyl(0.042, 0.042, 0.13, C_UNI_D, 0.19, 0.93, 0.065);
    s.loft([[0.88, 0.03, 0.04, 0.04], [0.93, 0.034, 0.045, 0.045], [0.98, 0.03, 0.04, 0.04]], C_UNI_D, 8, 3.5, -0.19, 0, 0.04);
  }
  // Assault pack (about 60 % of the torso), in a darker shade, with a rolled mat strapped across its top.
  s.loft([[1.06, 0.105, 0.05, 0.055], [1.1, 0.12, 0.06, 0.068], [1.3, 0.122, 0.06, 0.07], [1.34, 0.105, 0.055, 0.06]], C_UNI_D, hi ? 12 : 6, 3, 0, 0, 0.19);
  if (hi) {
    s.loft([[1.1, 0.085, 0.02, 0.03], [1.14, 0.09, 0.025, 0.035], [1.2, 0.085, 0.02, 0.03]], C_UNI, 10, 3, 0, 0, 0.262);
    s.tint = T_FIXED;
    s.cyl(0.045, 0.045, 0.27, 0x55503f, 0, 1.38, 0.2, 0, 0, Math.PI / 2);
  }
  s.tint = T_FIXED;
  // Neck and head.
  s.cyl(0.05, 0.058, 0.1, sk, 0, 1.49, 0.0);
  s.sphere(0.094, sk, 0, 1.6, -0.008, 0.88, 1.1, 1.0);
  if (hi) {
    // Nose and ears.
    s.loft([[1.565, 0.016, 0.03, 0.01], [1.6, 0.011, 0.018, 0.01]], sk, 6, 2, 0, 0, -0.08);
    s.sphere(0.022, sk, -0.083, 1.6, 0.0, 0.5, 1.2, 0.9);
    s.sphere(0.022, sk, 0.083, 1.6, 0.0, 0.5, 1.2, 0.9);
    // Eyes in the shade of the brow, and the brow ridge.
    s.tint = T_FIXED;
    for (const ex of [-0.032, 0.032]) s.sphere(0.0105, 0x3a2c24, ex, 1.612, -0.084, 1.25, 0.65, 0.5);
    s.loft([[-0.008, 0.06, 0.012, 0.012], [0.008, 0.058, 0.01, 0.01]], shade(sk, 0.85), 10, 2, 0, 1.632, -0.083);
    // Neck gaiter (the uniform's cloth) rolled down round the neck and up to the chin.
    s.tint = T_UNIFORM;
    s.loft([[1.44, 0.066, 0.066, 0.062], [1.47, 0.07, 0.072, 0.066], [1.505, 0.074, 0.08, 0.07], [1.53, 0.072, 0.078, 0.068], [1.54, 0.064, 0.07, 0.062]], C_UNI_D, 14);
  }
  // Helmet: a dome sitting on the head with a flared rim over the brow; the nation's small patch on its side.
  s.tint = T_HELMET;
  s.push2((b) => b.add(new THREE.SphereGeometry(0.132, hi ? 16 : 8, hi ? 8 : 4, 0, Math.PI * 2, 0, Math.PI * 0.55), C_UNI, 0, 1.652, -0.005, 0, 0, 0, 1.0, 0.92, 1.1));
  if (hi) s.push2((b) => b.add(new THREE.CylinderGeometry(0.135, 0.148, 0.026, 18, 1, false), C_UNI_D, 0, 1.646, -0.005, 0, 0, 0, 1, 1, 1.1));
  else s.push2((b) => b.add(new THREE.CylinderGeometry(0.136, 0.146, 0.03, 8, 1, true), C_UNI_D, 0, 1.646, -0.005, 0, 0, 0, 1, 1, 1.1));
  if (hi) {
    // Helmet cover's strap (the goggles' band on the cover) and a counterweight pouch at the back.
    s.tint = T_FIXED;
    s.loft([[1.676, 0.134, 0.146, 0.146], [1.694, 0.13, 0.142, 0.142]], C_GOGGLE, 18, 2, 0, 0, -0.005);
    s.loft([[-0.022, 0.075, 0.018, 0.012], [0.022, 0.072, 0.016, 0.012]], C_GOGGLE, 12, 3, 0, 1.712, -0.128, -0.35);
    for (const ex of [-0.036, 0.036]) s.sphere(0.024, C_LENS, ex, 1.712, -0.142, 1.1, 0.75, 0.4);
    s.tint = T_GEAR;
    s.loft([[1.66, 0.04, 0.012, 0.012], [1.7, 0.042, 0.014, 0.014]], C_UNI_D, 8, 3, 0, 0, 0.142);
  }
  s.tint = T_BAND;
  s.loft([[-0.018, 0.006, 0.026, 0.026], [0.018, 0.006, 0.026, 0.026]], 0xffffff, hi ? 8 : 4, 4, -0.127, 1.7, -0.005, 0, 0, -0.42);
  // --- Arms and weapon (aiming pose: stock at the right shoulder, eyes along the sights) ---
  s.part = P_ARMS;
  const shR: [number, number, number] = [0.205, SHOULDER_Y - 0.01, 0.0];
  const shL: [number, number, number] = [-0.205, SHOULDER_Y - 0.01, 0.0];
  const UP = [0.066, 0.062, 0.056, 0.05, 0.047];
  const FORE = [0.046, 0.05, 0.046, 0.039, 0.034];
  /** A gloved hand from the wrist toward `to`: a flattened palm and fingers curled round a grip, a thumb on top. */
  const hand = (w: [number, number, number], to: [number, number, number]) => {
    s.tint = T_FIXED;
    const end: [number, number, number] = [w[0] + (to[0] - w[0]) * 0.11, w[1] + (to[1] - w[1]) * 0.11, w[2] + (to[2] - w[2]) * 0.11];
    s.limb(w, end, [0.036, 0.042, 0.04, 0.03], C_GLOVE, 0.7);
    if (hi) s.limb([end[0], end[1] + 0.02, end[2]], [end[0] - 0.01, end[1] + 0.03, end[2] - 0.03], [0.014, 0.013, 0.011], C_GLOVE);
  };
  if (variant === 1) {
    // Anti-tank gunner: launcher tube on the right shoulder, both hands on its grips.
    s.tint = T_UNIFORM;
    s.limb(shR, [0.25, 1.24, -0.18], UP, C_UNI);
    s.limb([0.25, 1.24, -0.18], [0.17, 1.4, -0.3], FORE, C_UNI_D);
    s.limb(shL, [-0.13, 1.24, -0.27], UP, C_UNI);
    s.limb([-0.13, 1.24, -0.27], [0.08, 1.4, -0.52], FORE, C_UNI_D);
    hand([0.17, 1.4, -0.3], [0.16, 1.44, -0.4]);
    hand([0.08, 1.4, -0.52], [0.16, 1.44, -0.6]);
    s.tint = T_BAND;
    s.loft([[-0.026, 0.007, 0.026, 0.026], [0.026, 0.007, 0.026, 0.026]], 0xffffff, hi ? 8 : 4, 4, -0.252, 1.33, -0.045, 0.4, 0, 0.12);
    s.tint = T_FIXED;
    s.cyl(0.06, 0.06, 1.15, C_LAUNCHER, 0.16, 1.52, -0.18, Math.PI / 2);
    s.cyl(0.09, 0.075, 0.36, 0x3b4230, 0.16, 1.52, -0.86, Math.PI / 2);
    if (hi) s.box(0.06, 0.07, 0.11, C_GUN, 0.09, 1.57, -0.3);
  } else {
    s.tint = T_UNIFORM;
    // Right arm: elbow out and down, hand on the grip.
    s.limb(shR, [0.25, 1.2, -0.16], UP, C_UNI);
    s.limb([0.25, 1.2, -0.16], [0.1, 1.29, -0.27], FORE, C_UNI_D);
    // Left arm: reaching forward under the handguard.
    s.limb(shL, [-0.17, 1.2, -0.25], UP, C_UNI);
    s.limb([-0.17, 1.2, -0.25], [0.02, 1.3, -0.45], FORE, C_UNI_D);
    hand([0.1, 1.29, -0.27], [0.085, 1.27, -0.36]);
    hand([0.02, 1.3, -0.45], [0.07, 1.33, -0.55]);
    // The nation's small patch on the left sleeve.
    s.tint = T_BAND;
    s.loft([[-0.026, 0.007, 0.026, 0.026], [0.026, 0.007, 0.026, 0.026]], 0xffffff, hi ? 8 : 4, 4, -0.252, 1.33, -0.045, 0.4, 0, 0.12);
    s.tint = T_FIXED;
    if (variant === 2) {
      // Machine gun: thicker receiver, long barrel, belt box, bipod folded.
      s.box(0.09, 0.13, 0.62, C_GUN, 0.08, 1.37, -0.33);
      s.cyl(0.024, 0.024, 0.62, C_GUN, 0.08, 1.38, -0.92, Math.PI / 2);
      s.box(0.14, 0.12, 0.12, C_LAUNCHER, 0.0, 1.27, -0.38);
      s.box(0.07, 0.11, 0.22, C_GUN_W, 0.08, 1.35, 0.02);
      if (hi) s.box(0.02, 0.02, 0.3, C_GUN, 0.06, 1.32, -1.0);
    } else {
      // Assault rifle: stock, receiver, pistol grip, magazine, handguard, barrel, sight.
      s.box(0.045, 0.09, 0.22, C_GUN, 0.08, 1.36, 0.0);
      s.box(0.055, 0.09, 0.34, C_GUN, 0.08, 1.37, -0.27);
      s.box(0.035, 0.08, 0.04, C_GUN, 0.08, 1.31, -0.24, -0.3);
      s.box(0.04, 0.15, 0.06, C_GUN, 0.08, 1.27, -0.33, 0.25);
      s.cyl(0.013, 0.013, 0.32, C_GUN, 0.08, 1.38, -0.62, Math.PI / 2);
      if (hi) {
        s.box(0.03, 0.045, 0.08, C_GUN, 0.08, 1.435, -0.22);
        s.box(0.05, 0.06, 0.18, 0x2c2c2a, 0.08, 1.365, -0.5);
      }
    }
  }
  return s.build();
}


// =================================================================================================
// Uniform colours
// =================================================================================================

const UNI_BASE = [new THREE.Color(0x56603f), new THREE.Color(0x7c6e4e)];

/**
 * A soldier's field uniform (linear, multiplied by the model's vertex colours): the side's field shade (a dark olive
 * for ours, a dark khaki for theirs) with a little variety per man. Gauntlet round 1: the nation's colour no longer
 * tints the whole suit (a pink nation's men read pink, a pale one's mint); it shows only in the camouflage's patches,
 * muted to the cloth (the shader), and on the small patches of the helmet and the left sleeve.
 */
export function fieldUniform(team: 0 | 1, _nationHex: number, seed: number, out: THREE.Color): THREE.Color {
  out.copy(UNI_BASE[team]);
  return out.multiplyScalar(0.92 + ((seed * 997) % 1) * 0.16);
}

const MUTE_HSL = { h: 0, s: 0, l: 0 };
/**
 * The nation's colour as a figure small on screen takes it (farTint in world.ts): its hue at a cloth's saturation and
 * brightness, so a far line of men reads as theirs or ours without a magenta or neon man (gauntlet round 1).
 */
export function mutedNation(hex: number, out: THREE.Color): THREE.Color {
  out.setHex(hex).getHSL(MUTE_HSL, THREE.SRGBColorSpace);
  return out.setHSL(MUTE_HSL.h, Math.min(0.42, MUTE_HSL.s * 0.7), 0.34, THREE.SRGBColorSpace);
}

// =================================================================================================
// Material: MeshStandardMaterial with the animation and the uniform colours injected
// =================================================================================================

const ANIM_GLSL = /* glsl */ `
attribute float aPart;
attribute float aTint;
attribute vec4 aAnim;
attribute vec4 aBand;
uniform float uTime;
mat3 sRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 sRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
/** How far the hips drop so the lower foot of two legs (hip and knee angles) stands on the ground. */
float legIK(float hL, float kL, float hR, float kR) {
  float lt = ${(HIP_Y - KNEE_Y).toFixed(3)}, ls = ${KNEE_Y.toFixed(3)};
  float eL = lt * cos(hL) + ls * cos(hL + kL);
  float eR = lt * cos(hR) + ls * cos(hR + kR);
  return max(0.0, ${HIP_Y.toFixed(3)} - max(eL, eR));
}
void soldierAnim(inout vec3 p, inout vec3 n) {
  float pose = floor(aAnim.x + 0.5);
  float seed = aBand.w;
  float hipL = 0.0, knL = 0.0, hipR = 0.0, knR = 0.0, lean = 0.03, arm = -0.5, drop = 0.0, body = 0.0, roll = 0.0, slide = 0.0;
  float TAU = 6.2831853;
  if (pose == 1.0 || pose == 2.0 || pose == 7.0) {
    // Gait: the thighs swing about the vertical under the body (a rush crouches by bending both knees, it does not
    // throw the legs forward and sit), the knee folds in the swing phase, and the hips drop by exactly what keeps the
    // planted foot on the ground (legIK below), so the feet neither float nor sink and the run does not fold.
    float f = pose == 1.0 ? 1.75 : pose == 2.0 ? 2.5 : 2.2;
    float amp = pose == 1.0 ? 0.42 : pose == 2.0 ? 0.62 : 0.5;
    float ph = TAU * (uTime * f + aAnim.y);
    float s1 = sin(ph), c1 = cos(ph);
    float base = pose == 1.0 ? -0.08 : pose == 2.0 ? -0.22 : -0.55;
    float swing = pose == 1.0 ? 0.55 : pose == 2.0 ? 1.1 : 0.85;
    float fwd = pose == 7.0 ? 0.28 : pose == 2.0 ? 0.1 : 0.0;
    hipL = amp * s1 + fwd;
    hipR = -amp * s1 + fwd;
    knL = base - swing * max(0.0, c1);
    knR = base - swing * max(0.0, -c1);
    lean = pose == 1.0 ? 0.07 : pose == 2.0 ? 0.26 : 0.5;
    arm = pose == 1.0 ? -0.55 : pose == 2.0 ? -0.75 : -0.3;
    drop = legIK(hipL, knL, hipR, knR) + abs(s1) * (pose == 1.0 ? 0.015 : 0.03);
  } else if (pose == 3.0) {
    // Kneeling to fire: left foot planted forward, right knee on the ground.
    hipL = 1.42; knL = -1.48; hipR = -0.08; knR = -1.5; drop = 0.43; lean = 0.08; arm = 0.0;
  } else if (pose == 4.0) {
    // Prone, firing: lying forward on the ground, chest raised on the elbows, weapon along the ground.
    body = -1.5708; lean = -0.3; arm = 1.32; hipL = -0.05; hipR = 0.05; slide = 0.85;
  } else if (pose == 5.0) {
    // Hit: the knees give and the body falls back (or forward), then lies still.
    float k = clamp((uTime - aAnim.w) * 2.2, 0.0, 1.0);
    k = k * k * (3.0 - 2.0 * k);
    float dir = seed < 0.62 ? 1.0 : -1.0;
    float buckle = sin(k * 3.14159);
    knL = -1.1 * buckle; knR = -0.8 * buckle; hipL = 0.6 * buckle; hipR = 0.4 * buckle;
    drop = 0.35 * buckle;
    body = dir * 1.5708 * k;
    roll = (seed - 0.5) * 0.9 * k;
    arm = mix(-0.5, dir > 0.0 ? 1.6 : 1.2, k);
    lean = -0.15 * k * dir;
    slide = dir < 0.0 ? 0.6 * k : -0.25 * k;
  } else if (pose == 6.0) {
    hipL = 0.18; knL = -0.16; hipR = -0.1; knR = -0.06; lean = 0.06; arm = 0.0; drop = legIK(hipL, knL, hipR, knR);
  } else {
    // Idle: weight on one leg, rifle at the low ready, a slow breath.
    hipL = 0.06; knL = -0.06; hipR = -0.04; arm = -0.55 + 0.03 * sin(uTime * 1.3 + seed * 20.0); lean = 0.04; drop = legIK(hipL, knL, hipR, knR);
  }
  // Recoil of the last shot.
  float since = uTime - aAnim.z;
  if (since >= 0.0 && since < 0.4 && pose != 5.0) {
    float kick = exp(-since * 16.0);
    arm += 0.12 * kick;
    lean -= 0.05 * kick;
  }
  int part = int(aPart + 0.5);
  if (part == 1 || part == 2) {
    vec3 hip = vec3(-${HIP_X.toFixed(3)}, ${HIP_Y.toFixed(3)}, 0.0);
    if (part == 2) { vec3 kn = vec3(-${HIP_X.toFixed(3)}, ${KNEE_Y.toFixed(3)}, 0.0); mat3 R = sRotX(knL); p = R * (p - kn) + kn; n = R * n; }
    mat3 H = sRotX(hipL); p = H * (p - hip) + hip; n = H * n;
  } else if (part == 3 || part == 4) {
    vec3 hip = vec3(${HIP_X.toFixed(3)}, ${HIP_Y.toFixed(3)}, 0.0);
    if (part == 4) { vec3 kn = vec3(${HIP_X.toFixed(3)}, ${KNEE_Y.toFixed(3)}, 0.0); mat3 R = sRotX(knR); p = R * (p - kn) + kn; n = R * n; }
    mat3 H = sRotX(hipR); p = H * (p - hip) + hip; n = H * n;
  }
  if (part == 5) { vec3 sh = vec3(0.0, ${SHOULDER_Y.toFixed(3)}, 0.0); mat3 A = sRotX(arm); p = A * (p - sh) + sh; n = A * n; }
  if (part == 0 || part == 5) { vec3 hc = vec3(0.0, ${HIP_Y.toFixed(3)}, 0.0); mat3 L = sRotX(-lean); p = L * (p - hc) + hc; n = L * n; }
  p.y -= drop;
  if (body != 0.0) {
    mat3 B = sRotX(body); p = B * p; n = B * n;
    p.y += 0.2 * abs(sin(body));
  }
  if (roll != 0.0) { mat3 Z = sRotZ(roll); p = Z * p; n = Z * n; }
  p.z += slide;
}
`;

/**
 * Owner item 32 (pass 2): the uniform's camouflage, in the fragment shader. Blotches of three tones over the field
 * shade: the nation's colour (muted to the cloth's brightness, so a red nation's men wear brown-red patches, a blue
 * nation's blue-grey), a dark tone and a light one. It fades out with distance (beyond ~100 m a figure is a few
 * pixels: its average, the instance colour, is what reads).
 */
const CAMO_GLSL = /* glsl */ `
uniform vec3 uSoldierFill;
varying vec3 vCamoP;
varying float vCamoK;
varying vec3 vCamoN;
float sHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sHash(i), sHash(i + vec3(1, 0, 0)), f.x), mix(sHash(i + vec3(0, 1, 0)), sHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(sHash(i + vec3(0, 0, 1)), sHash(i + vec3(1, 0, 1)), f.x), mix(sHash(i + vec3(0, 1, 1)), sHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void soldierCamo(inout vec3 col, float dist) {
  float k = vCamoK * (1.0 - smoothstep(45.0, 140.0, dist));
  if (k < 0.01) return;
  float n1 = sNoise(vCamoP) * 0.7 + sNoise(vCamoP * 2.3) * 0.3;
  float n2 = sNoise(vCamoP * 1.4 + 17.3) * 0.7 + sNoise(vCamoP * 3.1 + 5.1) * 0.3;
  float lum = dot(col, vec3(0.3, 0.55, 0.15));
  vec3 nat = mix(vec3(dot(vCamoN, vec3(0.3, 0.55, 0.15))), vCamoN, 0.3);
  nat = mix(nat * (lum / max(1e-3, dot(nat, vec3(0.3, 0.55, 0.15)))) * 0.72, col * 0.8, 0.4);
  vec3 c = col * 1.1;
  c = mix(c, nat, smoothstep(0.52, 0.56, n1));
  c = mix(c, col * 0.48, smoothstep(0.6, 0.64, n2));
  col = mix(col, c, k);
}
`;

/** Patch a material (standard or depth) so it animates the soldier geometry. */
function patch(m: THREE.Material, time: { value: number }, colour: boolean, fill?: { value: THREE.Color }): void {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    if (fill) sh.uniforms.uSoldierFill = fill;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${ANIM_GLSL}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3( position );\n{ vec3 nTmp = vec3(0.0, 1.0, 0.0); soldierAnim(transformed, nTmp); }');
    if (sh.vertexShader.includes('#include <beginnormal_vertex>')) {
      sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( normal );\n{ vec3 pTmp = vec3( position ); soldierAnim(pTmp, objectNormal); }\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif');
    }
    if (colour) {
      sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', /* glsl */ `
#if defined( USE_COLOR_ALPHA )
  vColor = vec4( 1.0 );
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  {
    vec3 uni = instanceColor.rgb;
    // Fixed colours, the uniform, the nation's band, the helmet cover (a darker shade), the gear (the uniform's
    // colour toward a neutral webbing olive).
    vec3 gear = mix(uni * 0.72, vec3(0.085, 0.088, 0.066), 0.35);
    // The nation's patch: its hue at a cloth's saturation and brightness (a small, muted badge, not a neon band).
    vec3 bandC = mix(vec3(dot(aBand.rgb, vec3(0.3, 0.55, 0.15))), aBand.rgb, 0.6) * 0.7;
    vec3 tc = aTint < 0.5 ? vec3(1.0) : aTint < 1.5 ? uni : aTint < 2.5 ? bandC : aTint < 3.5 ? uni * 0.82 : gear;
    vColor.rgb *= tc;
  }
#endif
  // The camouflage pattern follows the body (the model's own frame, before the pose) and differs per man.
  vCamoP = position * 3.1 + vec3(aBand.w * 37.0, aBand.w * 11.0, aBand.w * 23.0);
  vCamoK = aTint > 0.5 && aTint < 1.5 ? 1.0 : aTint > 2.5 && aTint < 3.5 ? 0.75 : aTint > 3.5 ? 0.55 : 0.0;
  vCamoN = aBand.rgb;
`);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCamoP;\nvarying float vCamoK;\nvarying vec3 vCamoN;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${CAMO_GLSL}`)
        .replace('#include <color_fragment>', '#include <color_fragment>\nsoldierCamo(diffuseColor.rgb, length(vViewPosition));')
        // A soft sky fill on the side away from the sun (cloth and skin scatter the sky's light): a man seen against
        // the light is a figure in the uniform's colours, not a black cut-out.
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += diffuseColor.rgb * uSoldierFill;');
    }
  };
  m.customProgramCacheKey = () => `soldier-anim-${colour ? 'c' : 'd'}`;
}

export interface SoldierMaterials {
  /** Shared clock of the animation (local world seconds; frozen with the scene). */
  time: { value: number };
  /** Sky fill on the shaded side (linear radiance × albedo; command mode sets it from the sky light, ~0.3 by day). */
  fill: { value: THREE.Color };
  standard: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
}

export function makeSoldierMaterials(): SoldierMaterials {
  const time = { value: 0 };
  const fill = { value: new THREE.Color(0.25, 0.27, 0.3) };
  const standard = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.02, vertexColors: true });
  patch(standard, time, true, fill);
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patch(depth, time, false);
  return { time, fill, standard, depth };
}

/** Add the per-instance animation attributes to a soldier geometry used by an InstancedMesh of `cap` instances. */
export function addSoldierInstancing(g: THREE.BufferGeometry, cap: number): { anim: THREE.InstancedBufferAttribute; band: THREE.InstancedBufferAttribute } {
  const anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  const band = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  anim.setUsage(THREE.DynamicDrawUsage);
  band.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < cap; i++) anim.setXYZW(i, 0, 0, -100, -100);
  g.setAttribute('aAnim', anim);
  g.setAttribute('aBand', band);
  return { anim, band };
}
