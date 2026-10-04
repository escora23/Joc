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
import { GeoBuilder } from './builder';

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
const HIP_X = 0.1;
const SHOULDER_Y = 1.41;

const C_UNI = 0xffffff; // multiplied by the instance's uniform colour
const C_UNI_D = 0xd2d2d2;
const C_SKIN = [0xc8987a, 0x9a6a4c, 0xe0b090];
const C_BOOT = 0x26221e;
const C_GUN = 0x1f2022;
const C_GUN_W = 0x4a3a2a;
const C_LAUNCHER = 0x46503a;

interface Piece {
  g: THREE.BufferGeometry;
  part: number;
  tint: number;
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
    const ws = this.hi ? 10 : 6, hs = this.hi ? 7 : 4;
    this.push((b) => b.sphere(r, ws, hs, c, x, y, z, sx, sy, sz));
  }

  /** A limb (capsule) from a to b with radius r (a box on the far level of detail). */
  limb(a: [number, number, number], bb: [number, number, number], r: number, c: number, r2 = r): void {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...bb);
    const d = new THREE.Vector3().subVectors(B, A);
    const len = d.length();
    const mid = A.clone().add(B).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const e = new THREE.Euler().setFromQuaternion(q);
    if (this.hi) {
      const g = new THREE.CapsuleGeometry((r + r2) / 2, Math.max(0.01, len - (r + r2) * 0.6), 3, 10);
      // Taper: scale the top end toward r2.
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const t = (p.getY(i) / len) + 0.5;
        const k = (r + (r2 - r) * Math.max(0, Math.min(1, t))) / ((r + r2) / 2);
        p.setX(i, p.getX(i) * k);
        p.setZ(i, p.getZ(i) * k);
      }
      g.computeVertexNormals();
      this.push((b) => b.add(g, c, mid.x, mid.y, mid.z, e.x, e.y, e.z));
    } else {
      this.push((b) => b.add(new THREE.BoxGeometry(r * 1.8, len, r * 1.8), c, mid.x, mid.y, mid.z, e.x, e.y, e.z));
    }
  }

  cyl(rt: number, rb: number, h: number, c: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    const seg = this.hi ? 10 : 6;
    this.push((b) => b.cyl(rt, rb, h, seg, c, x, y, z, rx, ry, rz));
  }

  build(): THREE.BufferGeometry {
    const geos = this.pieces.map((p) => {
      const n = p.g.attributes.position.count;
      p.g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(p.part), 1));
      p.g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(n).fill(p.tint), 1));
      return p.g;
    });
    const g = mergeGeometries(geos, false);
    for (const p of geos) p.dispose();
    g.computeBoundingSphere();
    // Animated poses reach about 1 m forward (prone) and back (fallen): a generous bound for culling.
    if (g.boundingSphere) g.boundingSphere.radius = 2.2;
    return g;
  }
}

/**
 * A soldier: variant 0 rifleman, 1 anti-tank gunner (launcher on the shoulder), 2 machine gunner (belt-fed gun);
 * `hi` = the close-up level of detail (capsule limbs, rounded helmet), else the crowd's (boxes, about a third of the
 * triangles). `skin` picks one of three skin tones.
 *
 * Owner item 32 (pass 2): a soldier in field gear, not a mannequin: loose trousers and sleeves (thick limbs that taper
 * to the boots and gloves), broad shoulders, a plate carrier with magazine pouches and a radio or a canteen, a helmet
 * that sits ON the head (a dome with a rim over the brow, so the face shows under it) with goggles on the cover, and a
 * camouflage pattern on the uniform drawn by the shader (makeSoldierMaterials).
 */
export function buildSoldierGeometry(variant: 0 | 1 | 2, hi: boolean, skin = 0): THREE.BufferGeometry {
  const s = new SoldierBuilder(hi);
  const sk = C_SKIN[skin % C_SKIN.length];
  // --- Legs (thigh / shin pairs): loose trousers, cargo pocket, knee pad, boots ---
  for (const side of [-1, 1]) {
    const x = side * HIP_X;
    s.part = side < 0 ? P_THIGH_L : P_THIGH_R;
    s.tint = T_UNIFORM;
    s.limb([x, HIP_Y + 0.03, 0], [x * 1.05, KNEE_Y, -0.01], 0.108, C_UNI, 0.085);
    if (hi) {
      // Cargo pocket on the outside of the thigh.
      s.box(0.05, 0.14, 0.12, C_UNI_D, x + side * 0.095, 0.7, 0.0);
      // Knee pad.
      s.tint = T_GEAR;
      s.box(0.12, 0.12, 0.06, C_UNI, x * 1.05, KNEE_Y + 0.01, -0.075);
    }
    s.part = side < 0 ? P_SHIN_L : P_SHIN_R;
    s.tint = T_UNIFORM;
    s.limb([x * 1.05, KNEE_Y, -0.01], [x, 0.16, 0.015], 0.082, C_UNI_D, 0.068);
    s.tint = T_FIXED;
    // Boot: upper and a sole with a toe.
    s.box(0.125, 0.15, 0.17, C_BOOT, x, 0.1, 0.02);
    s.box(0.13, 0.07, 0.3, C_BOOT, x, 0.035, -0.04);
  }
  // --- Upper body ---
  s.part = P_UPPER;
  s.tint = T_UNIFORM;
  // Hips and seat.
  s.box(0.38, 0.22, 0.24, C_UNI_D, 0, HIP_Y + 0.03, 0.0);
  if (hi) {
    const torso = new THREE.CapsuleGeometry(0.17, 0.3, 4, 12);
    torso.scale(1.22, 1, 0.78);
    s.pieces.push({ g: new GeoBuilder().add(torso, C_UNI, 0, 1.2, 0.0).build(), part: P_UPPER, tint: T_UNIFORM });
    // Shoulders (the sleeves' tops): a broad, round silhouette.
    for (const side of [-1, 1]) s.sphere(0.085, C_UNI, side * 0.2, SHOULDER_Y - 0.01, 0.0, 1, 0.9, 1);
  } else {
    s.box(0.42, 0.52, 0.26, C_UNI, 0, 1.19, 0);
    s.box(0.5, 0.12, 0.22, C_UNI, 0, SHOULDER_Y - 0.03, 0);
  }
  // Plate carrier (its shade of the uniform's colour), magazine pouches across the front, belt, radio or canteen.
  s.tint = T_GEAR;
  s.box(0.43, 0.36, 0.33, C_UNI, 0, 1.22, -0.005);
  if (hi) {
    s.box(0.38, 0.3, 0.02, C_UNI_D, 0, 1.23, -0.175);
    for (const px of [-0.13, -0.045, 0.045, 0.13]) s.box(0.075, 0.13, 0.065, C_UNI_D, px, 1.13, -0.2);
    s.box(0.12, 0.08, 0.05, C_UNI_D, -0.1, 1.3, -0.19);
    s.box(0.45, 0.065, 0.29, C_UNI_D, 0, 0.99, 0);
    // Canteen on the hip, a pouch on the other.
    s.cyl(0.05, 0.05, 0.14, C_UNI_D, 0.22, 0.95, 0.06);
    s.box(0.08, 0.12, 0.1, C_UNI_D, -0.22, 0.95, 0.04);
  }
  // Assault pack, in a darker shade, with the bedroll on top.
  s.box(0.3, 0.32, 0.16, C_UNI_D, 0, 1.2, 0.22);
  if (hi) {
    s.box(0.24, 0.13, 0.06, C_UNI, 0, 1.1, 0.31);
    s.tint = T_FIXED;
    s.cyl(0.06, 0.06, 0.34, 0x5d5848, 0, 1.4, 0.21, 0, 0, Math.PI / 2);
  }
  s.tint = T_FIXED;
  // Neck and head (the face under the helmet's rim: brow, eyes, nose).
  s.cyl(0.058, 0.064, 0.1, sk, 0, 1.49, -0.005);
  s.sphere(0.098, sk, 0, 1.6, -0.015, 0.9, 1.12, 1.0);
  if (hi) {
    s.box(0.034, 0.05, 0.035, sk, 0, 1.59, -0.115);
    s.box(0.13, 0.022, 0.02, 0x2a2420, 0, 1.628, -0.098);
    s.box(0.022, 0.045, 0.035, sk, -0.092, 1.6, -0.01);
    s.box(0.022, 0.045, 0.035, sk, 0.092, 1.6, -0.01);
    // Chin strap.
    s.box(0.012, 0.1, 0.012, 0x2a2a26, -0.085, 1.58, -0.03, 0, 0, -0.2);
    s.box(0.012, 0.1, 0.012, 0x2a2a26, 0.085, 1.58, -0.03, 0, 0, 0.2);
  }
  // Helmet: a dome sitting on the head with a rim over the brow (the face shows beneath it); the nation's band.
  s.tint = T_HELMET;
  s.push2((b) => b.add(new THREE.SphereGeometry(0.142, hi ? 14 : 8, hi ? 7 : 4, 0, Math.PI * 2, 0, Math.PI * 0.56), C_UNI, 0, 1.655, -0.005, 0, 0, 0, 1.0, 0.92, 1.1));
  s.push2((b) => b.add(new THREE.CylinderGeometry(0.15, 0.162, 0.035, hi ? 16 : 8, 1, true), C_UNI_D, 0, 1.64, -0.005, 0, 0, 0, 1, 1, 1.1));
  if (hi) {
    // Goggles strapped on the cover.
    s.tint = T_FIXED;
    s.box(0.12, 0.035, 0.03, 0x33302a, 0, 1.73, -0.13, -0.5);
  }
  s.tint = T_BAND;
  s.push2((b) => b.add(new THREE.CylinderGeometry(0.146, 0.152, 0.03, hi ? 16 : 8, 1, true), 0xffffff, 0, 1.685, -0.005, 0, 0, 0, 1.01, 1, 1.11));
  // --- Arms and weapon (aiming pose: stock at the right shoulder, eyes along the sights) ---
  s.part = P_ARMS;
  const shR: [number, number, number] = [0.215, SHOULDER_Y, 0.0];
  const shL: [number, number, number] = [-0.215, SHOULDER_Y, 0.0];
  const glove = 0x3a3830;
  if (variant === 1) {
    // Anti-tank gunner: launcher tube on the right shoulder, both hands on its grips.
    s.tint = T_UNIFORM;
    s.limb(shR, [0.25, 1.25, -0.2], 0.072, C_UNI, 0.06);
    s.limb([0.25, 1.25, -0.2], [0.16, 1.43, -0.32], 0.058, C_UNI_D, 0.05);
    s.limb(shL, [-0.13, 1.24, -0.28], 0.072, C_UNI, 0.06);
    s.limb([-0.13, 1.24, -0.28], [0.1, 1.43, -0.55], 0.058, C_UNI_D, 0.05);
    s.tint = T_FIXED;
    s.cyl(0.06, 0.06, 1.15, C_LAUNCHER, 0.16, 1.52, -0.18, Math.PI / 2);
    s.cyl(0.09, 0.075, 0.36, 0x3b4230, 0.16, 1.52, -0.86, Math.PI / 2);
    s.box(0.05, 0.12, 0.07, glove, 0.16, 1.43, -0.33);
    s.box(0.05, 0.12, 0.07, glove, 0.16, 1.43, -0.55);
    if (hi) s.box(0.06, 0.07, 0.11, C_GUN, 0.09, 1.57, -0.3);
  } else {
    s.tint = T_UNIFORM;
    // Right arm: elbow out and down, hand on the grip.
    s.limb(shR, [0.26, 1.2, -0.17], 0.074, C_UNI, 0.062);
    s.limb([0.26, 1.2, -0.17], [0.09, 1.3, -0.29], 0.06, C_UNI_D, 0.05);
    // Left arm: reaching forward under the handguard.
    s.limb(shL, [-0.18, 1.2, -0.26], 0.074, C_UNI, 0.062);
    s.limb([-0.18, 1.2, -0.26], [0.04, 1.31, -0.5], 0.06, C_UNI_D, 0.05);
    // The nation's arm band on the left sleeve.
    s.tint = T_BAND;
    s.limb([-0.212, 1.34, -0.03], [-0.204, 1.28, -0.075], 0.079, 0xffffff);
    s.tint = T_FIXED;
    // Gloved hands.
    s.box(0.075, 0.085, 0.095, glove, 0.09, 1.29, -0.3);
    s.box(0.075, 0.075, 0.095, glove, 0.04, 1.31, -0.5);
    if (variant === 2) {
      // Machine gun: thicker receiver, long barrel, belt box, bipod folded.
      s.box(0.09, 0.13, 0.62, C_GUN, 0.08, 1.37, -0.33);
      s.cyl(0.024, 0.024, 0.62, C_GUN, 0.08, 1.38, -0.92, Math.PI / 2);
      s.box(0.14, 0.12, 0.12, C_LAUNCHER, 0.0, 1.27, -0.38);
      s.box(0.07, 0.11, 0.22, C_GUN_W, 0.08, 1.35, 0.02);
      if (hi) s.box(0.02, 0.02, 0.3, C_GUN, 0.06, 1.32, -1.0);
    } else {
      // Assault rifle: stock, receiver, magazine, handguard, barrel, sight.
      s.box(0.055, 0.1, 0.24, C_GUN, 0.08, 1.37, 0.0);
      s.box(0.06, 0.1, 0.36, C_GUN, 0.08, 1.37, -0.28);
      s.box(0.045, 0.17, 0.07, C_GUN, 0.08, 1.27, -0.32, 0.25);
      s.cyl(0.015, 0.015, 0.32, C_GUN, 0.08, 1.38, -0.62, Math.PI / 2);
      if (hi) {
        s.box(0.035, 0.05, 0.09, C_GUN, 0.08, 1.445, -0.22);
        s.box(0.05, 0.065, 0.16, 0x2c2c2a, 0.08, 1.36, -0.5);
      }
    }
  }
  return s.build();
}

// =================================================================================================
// Uniform colours
// =================================================================================================

const UNI_BASE = [new THREE.Color(0x7f8862), new THREE.Color(0x998a66)];
const UNI_HSL = { h: 0, s: 0, l: 0 };
const UNI_TMP = new THREE.Color();

/**
 * A soldier's field uniform (linear, multiplied by the model's vertex colours): the side's field shade (olive for
 * ours, khaki for theirs) blended with a muted, dark version of the nation's colour, so a red nation wears a brown-red
 * field dress and a blue one a blue-grey (never a pink or bright suit that reads as bare skin), plus a little variety
 * per man. The nation's full colour is on the helmet band and the arm band.
 */
export function fieldUniform(team: 0 | 1, nationHex: number, seed: number, out: THREE.Color): THREE.Color {
  out.copy(UNI_BASE[team]);
  UNI_TMP.setHex(nationHex).getHSL(UNI_HSL, THREE.SRGBColorSpace);
  UNI_TMP.setHSL(UNI_HSL.h, Math.min(0.36, UNI_HSL.s * 0.5), 0.4, THREE.SRGBColorSpace);
  out.lerp(UNI_TMP, 0.3);
  return out.multiplyScalar(0.9 + ((seed * 997) % 1) * 0.18);
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
void soldierAnim(inout vec3 p, inout vec3 n) {
  float pose = floor(aAnim.x + 0.5);
  float seed = aBand.w;
  float hipL = 0.0, knL = 0.0, hipR = 0.0, knR = 0.0, lean = 0.03, arm = -0.5, drop = 0.0, body = 0.0, roll = 0.0, slide = 0.0;
  float TAU = 6.2831853;
  if (pose == 1.0 || pose == 2.0 || pose == 7.0) {
    float f = pose == 1.0 ? 1.75 : pose == 2.0 ? 2.5 : 2.2;
    float amp = pose == 1.0 ? 0.42 : pose == 2.0 ? 0.72 : 0.6;
    float ph = TAU * (uTime * f + aAnim.y);
    float s1 = sin(ph), c1 = cos(ph);
    hipL = amp * s1;
    hipR = -amp * s1;
    knL = -0.12 - (pose == 1.0 ? 0.55 : 1.05) * max(0.0, c1);
    knR = -0.12 - (pose == 1.0 ? 0.55 : 1.05) * max(0.0, -c1);
    lean = pose == 1.0 ? 0.07 : pose == 2.0 ? 0.28 : 0.55;
    arm = pose == 1.0 ? -0.55 : pose == 2.0 ? -0.8 : -0.35;
    drop = abs(sin(ph)) * (pose == 1.0 ? 0.02 : 0.05) + (pose == 7.0 ? 0.22 : 0.0);
    hipL += pose == 7.0 ? 0.35 : 0.0;
    hipR += pose == 7.0 ? 0.35 : 0.0;
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
    hipL = 0.18; knL = -0.12; hipR = -0.1; knR = -0.06; lean = 0.06; arm = 0.0;
  } else {
    // Idle: weight on one leg, rifle at the low ready, a slow breath.
    hipL = 0.06; hipR = -0.04; arm = -0.55 + 0.03 * sin(uTime * 1.3 + seed * 20.0); lean = 0.04;
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
  vec3 nat = mix(vec3(dot(vCamoN, vec3(0.3, 0.55, 0.15))), vCamoN, 0.36);
  nat = mix(nat * (lum / max(1e-3, dot(nat, vec3(0.3, 0.55, 0.15)))) * 0.72, col * 0.8, 0.3);
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
    vec3 tc = aTint < 0.5 ? vec3(1.0) : aTint < 1.5 ? uni : aTint < 2.5 ? aBand.rgb : aTint < 3.5 ? uni * 0.78 : gear;
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
