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
const T_FIXED = 0, T_UNIFORM = 1, T_BAND = 2, T_HELMET = 3;

const HIP_Y = 0.93;
const KNEE_Y = 0.51;
const HIP_X = 0.1;
const SHOULDER_Y = 1.41;

const C_UNI = 0xc8c8c8; // multiplied by the instance's uniform colour
const C_UNI_D = 0xaaaaaa;
const C_SKIN = [0xc8987a, 0x9a6a4c, 0xe0b090];
const C_GEAR = 0x45463a;
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
      const g = new THREE.CapsuleGeometry((r + r2) / 2, Math.max(0.01, len - (r + r2) * 0.6), 3, 8);
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
 */
export function buildSoldierGeometry(variant: 0 | 1 | 2, hi: boolean, skin = 0): THREE.BufferGeometry {
  const s = new SoldierBuilder(hi);
  const sk = C_SKIN[skin % C_SKIN.length];
  // --- Legs (thigh / shin pairs) ---
  for (const side of [-1, 1]) {
    const x = side * HIP_X;
    s.part = side < 0 ? P_THIGH_L : P_THIGH_R;
    s.tint = T_UNIFORM;
    s.limb([x, HIP_Y + 0.02, 0], [x, KNEE_Y, -0.01], 0.095, C_UNI, 0.075);
    if (hi) {
      // Knee pad.
      s.tint = T_FIXED;
      s.box(0.1, 0.1, 0.05, C_GEAR, x, KNEE_Y + 0.02, -0.07);
    }
    s.part = side < 0 ? P_SHIN_L : P_SHIN_R;
    s.tint = T_UNIFORM;
    s.limb([x, KNEE_Y, -0.01], [x, 0.11, 0.02], 0.072, C_UNI_D, 0.058);
    s.tint = T_FIXED;
    s.box(0.12, 0.12, 0.27, C_BOOT, x, 0.06, -0.04);
  }
  // --- Upper body ---
  s.part = P_UPPER;
  s.tint = T_UNIFORM;
  s.box(0.36, 0.2, 0.22, C_UNI_D, 0, HIP_Y + 0.02, 0.0);
  if (hi) {
    const torso = new THREE.CapsuleGeometry(0.16, 0.3, 3, 10);
    torso.scale(1.18, 1, 0.74);
    s.pieces.push({ g: new GeoBuilder().add(torso, C_UNI, 0, 1.2, 0.0).build(), part: P_UPPER, tint: T_UNIFORM });
  } else s.box(0.38, 0.5, 0.24, C_UNI, 0, 1.19, 0);
  // Plate carrier with pouches, webbing belt, pack, collar.
  s.tint = T_FIXED;
  s.box(0.4, 0.34, 0.29, C_GEAR, 0, 1.22, -0.005);
  if (hi) {
    for (const px of [-0.12, 0, 0.12]) s.box(0.1, 0.12, 0.06, C_GEAR, px, 1.12, -0.165);
    s.box(0.42, 0.06, 0.27, C_GEAR, 0, 0.99, 0);
  }
  s.box(0.32, 0.36, 0.17, C_GEAR, 0, 1.24, 0.22);
  if (hi) s.box(0.34, 0.1, 0.14, 0x3a3a30, 0, 1.46, 0.2);
  // Neck and head.
  s.cyl(0.055, 0.06, 0.1, sk, 0, 1.49, -0.01);
  s.sphere(0.1, sk, 0, 1.585, -0.02, 0.92, 1.12, 1.0);
  if (hi) {
    // Nose and ears: a face that reads at 20 m.
    s.box(0.03, 0.045, 0.03, sk, 0, 1.58, -0.115);
    s.box(0.02, 0.04, 0.03, sk, -0.095, 1.585, -0.01);
    s.box(0.02, 0.04, 0.03, sk, 0.095, 1.585, -0.01);
  }
  // Helmet (uniform shade, darker) with the nation's band; chin strap.
  s.tint = T_HELMET;
  s.sphere(0.135, C_UNI, 0, 1.645, -0.005, 1.04, 0.74, 1.12);
  if (hi) s.cyl(0.143, 0.15, 0.03, C_UNI, 0, 1.6, -0.005, 0, 0, 0);
  s.tint = T_BAND;
  // The band sits proud of the helmet's widest part (no z-fighting with the shell).
  s.push2((b) => b.add(new THREE.CylinderGeometry(0.15, 0.152, 0.032, hi ? 14 : 8, 1, true), 0xffffff, 0, 1.635, -0.005, 0, 0, 0, 1.0, 1, 1.09));
  if (hi) {
    s.tint = T_FIXED;
    s.box(0.012, 0.09, 0.012, 0x222222, -0.09, 1.55, -0.03, 0, 0, -0.25);
    s.box(0.012, 0.09, 0.012, 0x222222, 0.09, 1.55, -0.03, 0, 0, 0.25);
  }
  // --- Arms and weapon (aiming pose: stock at the right shoulder, eyes along the sights) ---
  s.part = P_ARMS;
  const shR: [number, number, number] = [0.21, SHOULDER_Y, 0.0];
  const shL: [number, number, number] = [-0.21, SHOULDER_Y, 0.0];
  if (variant === 1) {
    // Anti-tank gunner: launcher tube on the right shoulder, both hands on its grips.
    s.tint = T_UNIFORM;
    s.limb(shR, [0.24, 1.25, -0.2], 0.06, C_UNI, 0.052);
    s.limb([0.24, 1.25, -0.2], [0.16, 1.43, -0.32], 0.05, C_UNI_D, 0.044);
    s.limb(shL, [-0.12, 1.24, -0.28], 0.06, C_UNI, 0.052);
    s.limb([-0.12, 1.24, -0.28], [0.1, 1.43, -0.55], 0.05, C_UNI_D, 0.044);
    s.tint = T_FIXED;
    s.cyl(0.055, 0.055, 1.15, C_LAUNCHER, 0.16, 1.52, -0.18, Math.PI / 2);
    s.cyl(0.085, 0.07, 0.36, 0x3b4230, 0.16, 1.52, -0.86, Math.PI / 2);
    s.box(0.04, 0.12, 0.06, C_GUN, 0.16, 1.43, -0.33);
    s.box(0.04, 0.12, 0.06, C_GUN, 0.16, 1.43, -0.55);
    if (hi) s.box(0.06, 0.06, 0.1, C_GUN, 0.09, 1.57, -0.3);
  } else {
    s.tint = T_UNIFORM;
    // Right arm: elbow out and down, hand on the grip.
    s.limb(shR, [0.25, 1.2, -0.17], 0.062, C_UNI, 0.054);
    s.limb([0.25, 1.2, -0.17], [0.09, 1.3, -0.29], 0.05, C_UNI_D, 0.044);
    // Left arm: reaching forward under the handguard.
    s.limb(shL, [-0.17, 1.2, -0.26], 0.062, C_UNI, 0.054);
    s.limb([-0.17, 1.2, -0.26], [0.04, 1.31, -0.5], 0.05, C_UNI_D, 0.044);
    // The nation's arm band on the left sleeve.
    s.tint = T_BAND;
    s.limb([-0.205, 1.33, -0.04], [-0.198, 1.28, -0.08], 0.068, 0xffffff);
    s.tint = T_FIXED;
    // Hands.
    s.box(0.07, 0.08, 0.09, C_SKIN[skin % C_SKIN.length], 0.09, 1.29, -0.3);
    s.box(0.07, 0.07, 0.09, C_SKIN[skin % C_SKIN.length], 0.04, 1.31, -0.5);
    if (variant === 2) {
      // Machine gun: thicker receiver, long barrel, belt box, bipod folded.
      s.box(0.09, 0.13, 0.62, C_GUN, 0.08, 1.37, -0.33);
      s.cyl(0.022, 0.022, 0.62, C_GUN, 0.08, 1.38, -0.92, Math.PI / 2);
      s.box(0.14, 0.12, 0.12, C_GEAR, 0.0, 1.27, -0.38);
      s.box(0.07, 0.11, 0.22, C_GUN_W, 0.08, 1.35, 0.02);
      if (hi) s.box(0.02, 0.02, 0.3, C_GUN, 0.06, 1.32, -1.0);
    } else {
      // Assault rifle: stock, receiver, magazine, handguard, barrel, sight.
      s.box(0.055, 0.09, 0.24, C_GUN, 0.08, 1.37, 0.0);
      s.box(0.06, 0.1, 0.36, C_GUN, 0.08, 1.37, -0.28);
      s.box(0.045, 0.16, 0.07, C_GUN, 0.08, 1.27, -0.32, 0.25);
      s.cyl(0.014, 0.014, 0.32, C_GUN, 0.08, 1.38, -0.62, Math.PI / 2);
      if (hi) {
        s.box(0.03, 0.04, 0.08, C_GUN, 0.08, 1.44, -0.22);
        s.box(0.05, 0.06, 0.16, 0x2c2c2a, 0.08, 1.36, -0.5);
      }
    }
  }
  return s.build();
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

/** Patch a material (standard or depth) so it animates the soldier geometry. */
function patch(m: THREE.Material, time: { value: number }, colour: boolean): void {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
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
    vec3 tc = aTint < 0.5 ? vec3(1.0) : aTint < 1.5 ? uni : aTint < 2.5 ? aBand.rgb : uni * 0.72;
    vColor.rgb *= tc;
  }
#endif
`);
    }
  };
  m.customProgramCacheKey = () => `soldier-anim-${colour ? 'c' : 'd'}`;
}

export interface SoldierMaterials {
  /** Shared clock of the animation (local world seconds; frozen with the scene). */
  time: { value: number };
  standard: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
}

export function makeSoldierMaterials(): SoldierMaterials {
  const time = { value: 0 };
  const standard = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.02, vertexColors: true });
  patch(standard, time, true);
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patch(depth, time, false);
  return { time, standard, depth };
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
