// FRONT ULTRA — ground battle: instanced infantry (owner: battle).
// One draw call for every soldier of both nations. Each soldier is an instance of a ~120-triangle figure whose
// limbs are posed in the vertex shader (stand-fire, run, kneel-fire, prone, walk, fall/dead) with blended
// transitions; motion is a GPU-interpolated move segment (x0,z0 -> x1,z1 between t0 and t1) on the battlefield
// heightfield (texture lookup), so the CPU only writes an instance when a squad takes a decision or a soldier
// is hit. Squads fight by fire-and-maneuver: bound forward, go to ground, fire, bound again.

import * as THREE from 'three';
import {
  FastRng, GLSL_BATTLE_FRAG, GLSL_BATTLE_HEAD, GLSL_BATTLE_VERT, GLSL_ROT, GLSL_TAIL, hexToLinear, type BattleUniforms,
} from './common';
import { SOLDIER_PIVOTS, soldierGeometry } from './models';
import type { FrontGeom } from './front';

export const Anim = { StandFire: 0, Run: 1, KneelFire: 2, Prone: 3, Dead: 4, Walk: 5 } as const;

const P = SOLDIER_PIVOTS;
const vert = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_VERT}
${GLSL_ROT}
attribute vec2 aPart;
attribute vec4 iMove;
attribute vec4 iTime;
attribute vec4 iMisc;
uniform vec2 uFace[2];
varying vec3 vN;
varying vec3 vPos;
varying vec3 vObj;
varying float vMat;
varying float vTeam;
varying float vSpawn;
varying float vDead;
varying float vBone;

void poseOf(float A, float ph, float seed, float fallT, out vec4 la, out vec4 bd) {
  if (A < 0.5) {
    la = vec4(-0.12, 0.16, -1.2, -1.42); bd = vec4(0.06, 0.0, 0.0, 1.0);
  } else if (A < 1.5) {
    float s = sin(ph);
    la = vec4(-0.7 * s, 0.7 * s, -0.95 + 0.3 * s, -1.0 - 0.25 * s); bd = vec4(0.3, -abs(cos(ph)) * 0.08, 0.0, 0.0);
  } else if (A < 2.5) {
    la = vec4(-1.5, 1.15, -1.25, -1.45); bd = vec4(0.12, -0.5, 0.0, 1.0);
  } else if (A < 3.5) {
    la = vec4(0.08, -0.06, -2.75, -2.9); bd = vec4(0.0, 0.16, 1.5, 1.0);
  } else if (A < 4.5) {
    float dir = seed > 0.45 ? -1.0 : 1.0;
    float f = fallT * fallT;
    la = vec4(-0.35, 0.25, -0.5 - 1.8 * fract(seed * 3.7), 0.5) * fallT;
    bd = vec4(0.25 * fallT * dir, 0.13 * fallT, dir * 1.52 * f, 0.0);
  } else {
    float s = sin(ph);
    la = vec4(-0.38 * s, 0.38 * s, -0.8 + 0.1 * s, -0.85); bd = vec4(0.1, -abs(cos(ph)) * 0.03, 0.0, 0.0);
  }
}

void main() {
  float t = uTime;
  float team = iMisc.x;
  float seed = iMisc.y;
  float deathT = iMisc.z;
  float spawnT = iMisc.w;
  float t0 = iTime.x, t1 = iTime.y;
  vec2 p0 = iMove.xy, p1 = iMove.zw;
  float dist = distance(p0, p1);
  bool hasMove = t1 > t0 + 0.05 && dist > 0.3;
  bool dead = deathT > 0.0 && t >= deathT;
  float tt = dead ? deathT : t;
  float mk = hasMove ? clamp((tt - t0) / (t1 - t0), 0.0, 1.0) : 1.0;
  vec2 xz = mix(p0, p1, mk);
  float speed = hasMove ? dist / (t1 - t0) : 0.0;
  float moveAnim = speed > 2.2 ? 1.0 : 5.0;
  float animA, animB, blend;
  if (hasMove && tt >= t0 && tt < t1) { animA = iTime.z; animB = moveAnim; blend = smoothstep(0.0, 0.25, tt - t0); }
  else if (hasMove && tt >= t1) { animA = moveAnim; animB = iTime.w; blend = smoothstep(0.0, 0.35, tt - t1); }
  else { animA = iTime.z; animB = iTime.w; blend = smoothstep(0.0, 0.4, tt - t0); }
  float ph = (tt - t0) * speed * 2.0 + seed * 6.2831;
  float fallT = 0.0;
  if (dead) { animA = 4.0; animB = 4.0; blend = 1.0; fallT = clamp((t - deathT) / 0.75, 0.0, 1.0); }
  vec4 laA, bdA, laB, bdB;
  poseOf(animA, ph, seed, fallT, laA, bdA);
  poseOf(animB, ph, seed, fallT, laB, bdB);
  vec4 la = mix(laA, laB, blend);
  vec4 bd = mix(bdA, bdB, blend);
  // Firing recoil in bursts.
  bool firing = !dead && (!hasMove || tt >= t1 + 0.4) && (animB < 0.5 || (animB > 1.5 && animB < 3.5));
  if (firing) {
    float burst = step(fract(t * 0.37 + seed * 5.3), 0.45);
    float kick = exp(-fract(t * 7.0 + seed * 13.0) * 7.0) * 0.14 * burst;
    la.w += kick;
    la.z += kick * 0.6;
    bd.x -= kick * 0.3;
  }

  vec3 p = position;
  vec3 n = normal;
  int bone = int(aPart.x + 0.5);
  if (bone == 1 || bone == 2) {
    vec3 piv = vec3(bone == 1 ? -${P.legX} : ${P.legX}, ${P.hipY}, 0.0);
    float a = bone == 1 ? la.x : la.y;
    p = rotX(p - piv, a) + piv; n = rotX(n, a);
  } else if (bone == 3 || bone == 4) {
    vec3 piv = vec3(bone == 3 ? -${P.shoulderX} : ${P.shoulderX}, ${P.shoulderY}, 0.0);
    float a = bone == 3 ? la.z : la.w;
    p = rotX(p - piv, a) + piv; n = rotX(n, a);
  } else if (bone == 5) {
    // Shouldered (aiming) vs. port arms (running), blended.
    vec3 pa = p + vec3(0.13, 1.42, 0.22);
    vec3 na = n;
    vec3 pb = rotY(rotX(p, -0.95), -0.55) + vec3(0.03, 1.18, 0.2);
    vec3 nb = rotY(rotX(n, -0.95), -0.55);
    p = mix(pb, pa, bd.w); n = normalize(mix(nb, na, bd.w));
  }
  if (bone != 1 && bone != 2) {
    vec3 hip = vec3(0.0, ${P.hipY}, 0.0);
    p = rotX(p - hip, bd.x) + hip; n = rotX(n, bd.x);
  }
  p.y += bd.y;
  p = rotX(p, bd.z); n = rotX(n, bd.z);

  float yaw;
  if (hasMove && tt < t1 + 0.35) {
    vec2 d = p1 - p0;
    yaw = atan(d.x, d.y);
  } else {
    vec2 f = team < 0.5 ? uFace[0] : uFace[1];
    yaw = atan(f.x, f.y) + (seed - 0.5) * 0.7;
  }
  float gy = battleHeight(xz);
  vec3 base = vec3(xz.x, gy, xz.y);
  float ex = unitExaggeration(base);
  p *= ex;
  p = rotY(p, yaw); n = rotY(n, yaw);
  // Sink the fallen slowly into the mud after a while (the CPU recycles them).
  if (dead) p.y -= max(0.0, t - deathT - 25.0) * 0.06 * ex;
  vec3 wp = base + p;
  vPos = wp;
  vN = n;
  vObj = position;
  vMat = aPart.y;
  vBone = aPart.x;
  vTeam = team;
  vSpawn = clamp((t - spawnT) / 1.2, 0.0, 1.0);
  vDead = dead ? 1.0 : 0.0;
  gl_Position = battleProject(wp);
}`;

const frag = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_FRAG}
uniform vec3 uTeamCol[2];
uniform vec3 uCamo[6];
varying vec3 vN;
varying vec3 vPos;
varying vec3 vObj;
varying float vMat;
varying float vTeam;
varying float vSpawn;
varying float vDead;
varying float vBone;
void main() {
  battleFadeDiscard();
  if (vSpawn < 0.999 && bHash12(floor(gl_FragCoord.xy) + 3.7) > vSpawn) discard;
  int m = int(vMat + 0.5);
  int bone = int(vBone + 0.5);
  int tb = vTeam < 0.5 ? 0 : 3;
  vec3 team = uTeamCol[vTeam < 0.5 ? 0 : 1];
  vec3 alb;
  // Three-tone camouflage tinted toward the nation color.
  float c = bHash12(floor(vObj.xy * 7.0 + vObj.z * 5.0) + vTeam * 17.0);
  vec3 camo = c < 0.45 ? uCamo[tb] : c < 0.8 ? uCamo[tb + 1] : uCamo[tb + 2];
  if (m == 5) {
    alb = vec3(0.03, 0.03, 0.028);
  } else if (m == 1) {
    // Head: face below, helmet (with a nation-color band) above.
    alb = vObj.y > 1.69 ? mix(uCamo[tb + 1] * 0.8, team * 0.5, 0.35) : vec3(0.3, 0.19, 0.12);
    if (vObj.y > 1.7 && vObj.y < 1.73) alb = team * 0.55;
  } else if ((bone == 1 || bone == 2) && vObj.y < 0.15) {
    alb = vec3(0.025, 0.022, 0.02);
  } else if ((bone == 3 || bone == 4) && vObj.y < 0.9) {
    alb = vec3(0.3, 0.19, 0.12);
  } else if (bone == 0 && (vObj.z < -0.12 || abs(vObj.y - 0.98) < 0.045)) {
    alb = uCamo[tb + 2] * 0.8;
  } else {
    alb = camo;
  }
  if (vDead > 0.5) alb *= 0.7;
  // Far away: lean toward a bright nation color so the armies read as two colored masses.
  float d = length(vPos - uCamL);
  float boost = smoothstep(uUnitScale.z, uUnitScale.w, d) * (1.0 - vDead * 0.6);
  alb = mix(alb, team * 0.6 + 0.02, boost * 0.6);
  vec3 N = normalize(vN);
  vec3 col = battleShade(alb, N, vPos, 1.0, 1.0);
  // Rim light keeps silhouettes readable against the ground at dusk.
  vec3 V = normalize(uCamL - vPos);
  col += uSunCol * pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.08 * alb * 4.0;
  col = battleAir(col, vPos);
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_TAIL}
}`;

interface Squad {
  team: number;
  first: number;
  count: number;
  u: number;
  v: number;
  /** 0 firing line, 1 support, 2 reserve */
  role: number;
  nextT: number;
  bounding: boolean;
  aggression: number;
  width: number;
}

export interface Infantry {
  readonly mesh: THREE.Mesh;
  readonly count: number;
  /** Build a new army for the current front geometry. */
  deploy(front: FrontGeom, counts: [number, number], seed: number, now: number, heightAt: (x: number, z: number) => number, blocked: (x: number, z: number) => boolean): void;
  clear(): void;
  update(now: number, front: FrontGeom, intensity: number, casualties: [number, number]): void;
  /** A random firing soldier of a team (for muzzle flashes / tracers). Returns false if none. */
  pickShooter(team: number, rng: FastRng, now: number, out: THREE.Vector3): boolean;
  /** A random live soldier position of a team (tracer targets). */
  pickTarget(team: number, rng: FastRng, out: THREE.Vector3): boolean;
  /** Kill soldiers within radius of a point (artillery). Returns kills. */
  blast(x: number, z: number, radius: number, now: number): number;
  setColors(a: number, b: number): void;
  alive(team: number): number;
  setCapacity(n: number): void;
}

export function createInfantry(uniforms: BattleUniforms, capacity: number): Infantry {
  const geo = new THREE.InstancedBufferGeometry();
  const base = soldierGeometry();
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('normal', base.getAttribute('normal'));
  geo.setAttribute('aPart', base.getAttribute('aPart'));
  const camo: THREE.Vector3[] = [];
  for (let i = 0; i < 6; i++) camo.push(new THREE.Vector3());
  const teamCol = [new THREE.Vector3(), new THREE.Vector3()];
  const face = [new THREE.Vector2(0, 1), new THREE.Vector2(0, -1)];
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { ...uniforms, uTeamCol: { value: teamCol }, uCamo: { value: camo }, uFace: { value: face } },
  });
  mat.name = 'battle-infantry';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  mesh.name = 'battle-infantry';

  let cap = 0;
  let iMove!: THREE.InstancedBufferAttribute, iTime!: THREE.InstancedBufferAttribute, iMisc!: THREE.InstancedBufferAttribute;
  let M!: Float32Array, T!: Float32Array, X!: Float32Array;
  let squadOf!: Int32Array;
  let offU!: Float32Array, offV!: Float32Array;
  let n = 0;
  const squads: Squad[] = [];
  const bySide: [Squad[], Squad[]] = [[], []];
  const rng = new FastRng(1);
  let squadCursor = 0;
  let deadCursor = 0;
  const ranges: [number, number][] = [];

  function alloc(c: number): void {
    cap = c;
    iMove = new THREE.InstancedBufferAttribute(new Float32Array(c * 4), 4);
    iTime = new THREE.InstancedBufferAttribute(new Float32Array(c * 4), 4);
    iMisc = new THREE.InstancedBufferAttribute(new Float32Array(c * 4), 4);
    for (const a of [iMove, iTime, iMisc]) a.setUsage(THREE.DynamicDrawUsage);
    M = iMove.array as Float32Array;
    T = iTime.array as Float32Array;
    X = iMisc.array as Float32Array;
    geo.setAttribute('iMove', iMove);
    geo.setAttribute('iTime', iTime);
    geo.setAttribute('iMisc', iMisc);
    squadOf = new Int32Array(c);
    offU = new Float32Array(c);
    offV = new Float32Array(c);
    geo.instanceCount = 0;
    n = 0;
  }
  alloc(Math.max(16, capacity));

  function markRange(a: number, count: number): void {
    ranges.push([a, count]);
  }

  function flush(): void {
    if (ranges.length === 0) return;
    ranges.sort((p, q) => p[0] - q[0]);
    for (const attr of [iMove, iTime, iMisc]) {
      let s = ranges[0][0], e = s + ranges[0][1];
      for (let k = 1; k < ranges.length; k++) {
        const [a, c] = ranges[k];
        if (a <= e + 8) e = Math.max(e, a + c);
        else {
          attr.addUpdateRange(s * 4, (e - s) * 4);
          s = a;
          e = a + c;
        }
      }
      attr.addUpdateRange(s * 4, (e - s) * 4);
      attr.needsUpdate = true;
    }
    ranges.length = 0;
  }

  /** Current (or final) ground position of soldier i at time now. */
  function posAt(i: number, now: number, out: THREE.Vector3): THREE.Vector3 {
    const o = i * 4;
    const t0 = T[o], t1 = T[o + 1];
    const d = X[o + 2] > 0 && now >= X[o + 2] ? X[o + 2] : now;
    const k = t1 > t0 + 0.05 ? Math.min(1, Math.max(0, (d - t0) / (t1 - t0))) : 1;
    out.x = M[o] + (M[o + 2] - M[o]) * k;
    out.z = M[o + 1] + (M[o + 3] - M[o + 1]) * k;
    return out;
  }
  function animAt(i: number, now: number): number {
    const o = i * 4;
    if (X[o + 2] > 0 && now >= X[o + 2]) return Anim.Dead;
    const t0 = T[o], t1 = T[o + 1];
    const moving = t1 > t0 + 0.05 && now < t1 && now >= t0;
    return moving ? Anim.Run : now < t0 ? T[o + 2] : T[o + 3];
  }

  const tmp = new THREE.Vector3();
  let frontRef: FrontGeom | null = null;
  let heightFn: (x: number, z: number) => number = () => 0;
  let blockedFn: (x: number, z: number) => boolean = () => false;

  function slotXZ(front: FrontGeom, team: number, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
    return front.toXZ(u, team === 0 ? -v : v, out);
  }

  function coverAnim(role: number, v: number): number {
    const r = rng.next();
    if (role === 2) return r < 0.6 ? Anim.StandFire : Anim.KneelFire;
    if (v < 90) return r < 0.55 ? Anim.Prone : r < 0.9 ? Anim.KneelFire : Anim.StandFire;
    return r < 0.35 ? Anim.Prone : r < 0.8 ? Anim.KneelFire : Anim.StandFire;
  }

  function orderSquad(s: Squad, now: number, front: FrontGeom, intensity: number): void {
    const minV = s.role === 0 ? 18 + (1 - s.aggression) * 30 : s.role === 1 ? 110 : 420;
    let dv = 0, du = 0;
    const attacking = s.team === 0 ? front.pushA : front.pushB;
    if (!s.bounding) {
      // Bound: forward if attacking and room, else a lateral shift / small reposition.
      if (attacking > 0.2 && s.v > minV + 8 && rng.chance(0.55 + 0.35 * s.aggression)) dv = -Math.min(s.v - minV, rng.range(18, 55));
      else if (s.v < minV) dv = rng.range(10, 30);
      else if (attacking < -0.2 && rng.chance(0.3)) dv = rng.range(20, 60);
      else dv = rng.range(-12, 12);
      du = rng.range(-25, 25);
      s.bounding = true;
    } else {
      s.bounding = false;
    }
    s.v = Math.max(minV * 0.8, s.v + dv);
    s.u = Math.max(-front.halfLen * 0.92, Math.min(front.halfLen * 0.92, s.u + du));
    const run = s.role !== 2 || rng.chance(0.3);
    const speed = run ? rng.range(3.0, 4.6) : rng.range(1.2, 1.7);
    let latest = now;
    for (let k = 0; k < s.count; k++) {
      const i = s.first + k;
      const o = i * 4;
      if (X[o + 2] > 0) continue; // dead
      posAt(i, now, tmp);
      const cx = tmp.x, cz = tmp.z;
      const cur = animAt(i, now);
      let tu = s.u + offU[i] + rng.range(-2.5, 2.5);
      let tv = Math.max(8, s.v + offV[i] + rng.range(-3, 3));
      slotXZ(front, s.team, tu, tv, tmp);
      let tries = 0;
      while (blockedFn(tmp.x, tmp.z) && tries++ < 4) {
        tu += rng.range(-12, 12);
        tv += rng.range(0, 10);
        slotXZ(front, s.team, tu, tv, tmp);
      }
      const d = Math.hypot(tmp.x - cx, tmp.z - cz);
      const stagger = rng.range(0, 0.9);
      const t0 = now + stagger;
      const t1 = d > 0.5 ? t0 + d / (speed * rng.range(0.9, 1.1)) : t0;
      M[o] = cx; M[o + 1] = cz; M[o + 2] = tmp.x; M[o + 3] = tmp.z;
      T[o] = t0; T[o + 1] = t1; T[o + 2] = cur === Anim.Run ? T[o + 3] : cur; T[o + 3] = coverAnim(s.role, s.v);
      if (t1 > latest) latest = t1;
    }
    markRange(s.first, s.count);
    const hold = s.bounding ? 0.5 : rng.range(3, 9) * (1.3 - intensity * 0.5) * (s.role === 2 ? 2.5 : 1);
    s.nextT = latest + hold;
  }

  function killOne(i: number, now: number): void {
    const o = i * 4;
    if (X[o + 2] > 0) return;
    // Freeze the move at the death time (the shader does it too, but keep the CPU view coherent).
    posAt(i, now, tmp);
    M[o] = tmp.x; M[o + 1] = tmp.z; M[o + 2] = tmp.x; M[o + 3] = tmp.z;
    T[o + 2] = animAt(i, now) === Anim.Run ? Anim.Run : T[o + 3];
    T[o] = now; T[o + 1] = now;
    X[o + 2] = now;
    markRange(i, 1);
  }

  function respawn(i: number, now: number, front: FrontGeom): void {
    const o = i * 4;
    const s = squads[squadOf[i]];
    // Reinforcements appear behind their squad and run up to it.
    const u = s.u + offU[i] + rng.range(-10, 10);
    const v0 = s.v + 180 + rng.range(0, 250);
    slotXZ(front, s.team, u, v0, tmp);
    const x0 = tmp.x, z0 = tmp.z;
    slotXZ(front, s.team, u, Math.max(8, s.v + offV[i]), tmp);
    const d = Math.hypot(tmp.x - x0, tmp.z - z0);
    M[o] = x0; M[o + 1] = z0; M[o + 2] = tmp.x; M[o + 3] = tmp.z;
    T[o] = now + 0.5; T[o + 1] = now + 0.5 + d / rng.range(3.2, 4.5);
    T[o + 2] = Anim.Run; T[o + 3] = coverAnim(s.role, s.v);
    X[o + 2] = -1;
    X[o + 3] = now;
    markRange(i, 1);
  }

  const api: Infantry = {
    mesh,
    get count() {
      return n;
    },
    setCapacity(c) {
      if (c !== cap) alloc(Math.max(16, c));
    },
    setColors(a, b) {
      hexToLinear(a, teamCol[0]);
      hexToLinear(b, teamCol[1]);
      const olive = new THREE.Vector3(0.075, 0.08, 0.045);
      const khaki = new THREE.Vector3(0.16, 0.14, 0.085);
      const dark = new THREE.Vector3(0.035, 0.038, 0.025);
      for (let t = 0; t < 2; t++) {
        const c = teamCol[t];
        const lum = Math.max(0.05, c.x * 0.2126 + c.y * 0.7152 + c.z * 0.0722);
        const tint = c.clone().multiplyScalar(0.12 / lum);
        camo[t * 3].copy(olive).lerp(tint, 0.42);
        camo[t * 3 + 1].copy(khaki).lerp(tint.clone().multiplyScalar(1.4), 0.38);
        camo[t * 3 + 2].copy(dark).lerp(tint.clone().multiplyScalar(0.45), 0.35);
      }
    },
    deploy(front, counts, seed, now, heightAt, blocked) {
      frontRef = front;
      heightFn = heightAt;
      blockedFn = blocked;
      void heightFn;
      const r = new FastRng(seed);
      squads.length = 0;
      bySide[0].length = 0;
      bySide[1].length = 0;
      n = 0;
      for (let team = 0; team < 2; team++) {
        let left = Math.min(counts[team], cap - n);
        while (left > 0) {
          const size = Math.min(left, 8 + r.int(5));
          const roleR = r.next();
          const role = roleR < 0.55 ? 0 : roleR < 0.85 ? 1 : 2;
          // Concentrate the fighting near the anchor (where the camera looks), thinning toward the flanks.
          const u = Math.max(-1, Math.min(1, r.gauss() * 0.42)) * front.halfLen * 0.9;
          const v = role === 0 ? r.range(25, 110) : role === 1 ? r.range(140, 420) : r.range(450, 1100);
          const width = size * r.range(5.5, 8.5);
          const s: Squad = { team, first: n, count: size, u, v, role, nextT: now + r.range(0, 6), bounding: r.chance(0.5), aggression: r.next(), width };
          squads.push(s);
          bySide[team].push(s);
          for (let k = 0; k < size; k++) {
            const i = n + k;
            squadOf[i] = squads.length - 1;
            offU[i] = (k / Math.max(1, size - 1) - 0.5) * width + r.range(-2, 2);
            offV[i] = r.range(-4, 4) + (k % 2) * 3;
            const o = i * 4;
            slotXZ(front, team, u + offU[i], Math.max(8, v + offV[i]), tmp);
            let tries = 0;
            while (blocked(tmp.x, tmp.z) && tries++ < 4) slotXZ(front, team, u + offU[i] + r.range(-15, 15), v + offV[i] + r.range(0, 20), tmp);
            M[o] = tmp.x; M[o + 1] = tmp.z; M[o + 2] = tmp.x; M[o + 3] = tmp.z;
            const a = role === 2 ? (r.chance(0.5) ? Anim.StandFire : Anim.KneelFire) : r.chance(0.5) ? Anim.Prone : Anim.KneelFire;
            T[o] = now - 10; T[o + 1] = now - 10; T[o + 2] = a; T[o + 3] = a;
            X[o] = team; X[o + 1] = r.next(); X[o + 2] = -1; X[o + 3] = now - 10;
          }
          n += size;
          left -= size;
        }
      }
      // A few fallen already lie in no-man's-land.
      const fallen = Math.floor(n * 0.04);
      for (let k = 0; k < fallen; k++) {
        const i = r.int(n);
        const o = i * 4;
        const s = squads[squadOf[i]];
        if (s.role !== 0) continue;
        slotXZ(front, s.team, s.u + offU[i] + r.range(-30, 30), r.range(5, s.v), tmp);
        M[o] = tmp.x; M[o + 1] = tmp.z; M[o + 2] = tmp.x; M[o + 3] = tmp.z;
        X[o + 2] = now - r.range(3, 20);
      }
      geo.instanceCount = n;
      for (const a of [iMove, iTime, iMisc]) {
        a.clearUpdateRanges();
        a.needsUpdate = true;
      }
      ranges.length = 0;
      squadCursor = 0;
      rng.next();
    },
    clear() {
      n = 0;
      geo.instanceCount = 0;
      squads.length = 0;
      bySide[0].length = 0;
      bySide[1].length = 0;
      frontRef = null;
    },
    update(now, front, intensity, casualties) {
      if (n === 0) return;
      frontRef = front;
      face[0].set(front.nx, front.nz);
      face[1].set(-front.nx, -front.nz);
      // Squad decisions (a bounded number per frame).
      let budget = 6;
      const ns = squads.length;
      for (let k = 0; k < ns && budget > 0; k++) {
        const s = squads[(squadCursor + k) % ns];
        if (now >= s.nextT) {
          orderSquad(s, now, front, intensity);
          budget--;
        }
      }
      squadCursor = (squadCursor + 7) % Math.max(1, ns);
      // Casualties: expected hits this frame per team.
      for (let team = 0; team < 2; team++) {
        let c = casualties[team];
        while (c > 0) {
          if (c < 1 && rng.next() > c) break;
          c -= 1;
          const side = bySide[team];
          if (side.length === 0) break;
          // Mostly the firing line.
          const s = side[rng.int(side.length)];
          if (s.role === 2 && rng.chance(0.8)) continue;
          const i = s.first + rng.int(s.count);
          killOne(i, now);
        }
      }
      // Recycle long-dead soldiers as reinforcements (a slice per frame).
      const slice = Math.min(n, 64);
      for (let k = 0; k < slice; k++) {
        const i = (deadCursor + k) % n;
        const d = X[i * 4 + 2];
        if (d > 0 && now - d > 42) respawn(i, now, front);
      }
      deadCursor = (deadCursor + slice) % n;
      flush();
    },
    pickShooter(team, r, now, out) {
      const side = bySide[team];
      if (side.length === 0) return false;
      for (let tries = 0; tries < 6; tries++) {
        const s = side[r.int(side.length)];
        if (s.role === 2 && r.chance(0.7)) continue;
        const i = s.first + r.int(s.count);
        const o = i * 4;
        if (X[o + 2] > 0) continue;
        const a = animAt(i, now);
        if (a === Anim.Run || a === Anim.Walk || now < T[o + 1] + 0.4) continue;
        posAt(i, now, out);
        out.y = a === Anim.Prone ? 0.3 : a === Anim.KneelFire ? 1.0 : 1.4;
        return true;
      }
      return false;
    },
    pickTarget(team, r, out) {
      const side = bySide[team];
      if (side.length === 0 || !frontRef) return false;
      const s = side[r.int(side.length)];
      const i = s.first + r.int(s.count);
      posAt(i, 1e9, out);
      return true;
    },
    blast(x, z, radius, now) {
      let kills = 0;
      const r2 = radius * radius;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (X[o + 2] > 0) continue;
        const dx = M[o + 2] - x, dz = M[o + 3] - z;
        if (dx * dx + dz * dz < r2 && rng.chance(0.7)) {
          killOne(i, now + rng.range(0, 0.15));
          kills++;
        }
      }
      return kills;
    },
    alive(team) {
      let c = 0;
      for (const s of bySide[team]) c += s.count;
      return c;
    },
  };
  return api;
}
