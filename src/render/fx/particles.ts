// FRONT ULTRA — GPU particle system (owner: units / fx; shared with every strategic-scale effect).
// Particles are written ONCE into instanced attribute ring buffers when emitted (spawn position, velocity,
// spawn time, life, sizes, kind, drag, buoyancy). The vertex shader integrates the motion analytically from the
// FX clock (drag via exponential decay, buoyancy/gravity along the local planet "up"), builds a view-aligned
// billboard, and the fragment shader shades by kind (HDR fire ramps, sun-lit smoke, spark streaks).
// Per frame the CPU only uploads the freshly written slots (addUpdateRange): no per-particle CPU work.
// Two pools: additive (fire, sparks, flashes, embers) and alpha-blended (smoke, dust, spray, debris).

import * as THREE from 'three';
import { sharedUniforms } from '../units/common';

export const PK = {
  Fire: 0,
  Smoke: 1,
  Spark: 2,
  Flash: 3,
  Dust: 4,
  Spray: 5,
  Ember: 6,
  White: 7,
  Debris: 8,
  /** Blue-white electric flash (SAM kills, interceptions). */
  Blue: 9,
} as const;
export type ParticleKind = (typeof PK)[keyof typeof PK];

const ADDITIVE = new Set<number>([PK.Fire, PK.Spark, PK.Flash, PK.Ember, PK.Blue]);

const VERT = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aVel;
attribute vec4 aT;   // spawn time, life, size0, size1
attribute vec4 aK;   // kind, seed, drag, buoyancy
uniform float uFxTime;
uniform float uPixelK;
uniform vec3 uSunDir;
varying vec2 vUv;
varying float vT;
varying float vKind;
varying float vSeed;
varying float vDay;
varying float vFade;
varying vec2 vSun2;

void main() {
  float age = uFxTime - aT.x;
  float life = aT.y;
  if (age < 0.0 || age > life || life <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float t = age / life;
  vec3 up = normalize(aP0);
  float drag = aK.z;
  float k = drag > 0.0 ? (1.0 - exp(-drag * age)) / drag : age;
  vec3 p = aP0 + aVel * k + up * (0.5 * aK.w * age * age);
  float kind = aK.x;
  float grow = 1.0 - (1.0 - t) * (1.0 - t);
  float size = mix(aT.z, aT.w, grow);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 1e-6);
  size = max(size, 1.5 * uPixelK * dist);
  vec2 c = position.xy;
  vec2 off;
  if (kind > 1.5 && kind < 2.5) {
    // Spark: stretched along its screen-space velocity.
    vec3 vv = (viewMatrix * vec4(aVel * exp(-drag * age) + up * aK.w * age, 0.0)).xyz;
    vec2 d = vv.xy;
    float dl = length(d);
    d = dl > 1e-9 ? d / dl : vec2(1.0, 0.0);
    float stretch = 1.0 + clamp(dl * 0.04 / size, 0.0, 3.0);
    off = d * c.x * size * stretch + vec2(-d.y, d.x) * c.y * size * 0.35;
  } else {
    float ang = aK.y * 6.2831 + age * (aK.y - 0.5) * 0.8;
    float cs = cos(ang), sn = sin(ang);
    off = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
  }
  mv.xy += off;
  // Pull the billboard toward the camera by its size so relief does not slice ground-level puffs in half.
  mv.z += size * 0.9;
  gl_Position = projectionMatrix * mv;
  vUv = c * 0.5 + 0.5;
  vT = t;
  vKind = kind;
  vSeed = aK.y;
  float mu = dot(up, uSunDir);
  vDay = smoothstep(-0.14, 0.18, mu);
  // Fade particles that get too close to the camera (no screen-filling blobs).
  vFade = smoothstep(size * 0.6, size * 2.5, dist);
  vec3 sv = (viewMatrix * vec4(uSunDir, 0.0)).xyz;
  vSun2 = normalize(sv.xy + 1e-6);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vT;
varying float vKind;
varying float vSeed;
varying float vDay;
varying float vFade;
varying vec2 vSun2;

vec4 cell(float i, vec2 uv) {
  vec2 o = vec2(mod(i, 2.0), floor(i / 2.0)) * 0.5;
  return texture2D(uAtlas, o + clamp(uv, 0.01, 0.99) * 0.5);
}

void main() {
  float t = vT;
  vec3 col;
  float a;
  if (vKind < 0.5) {
    // Fire: white-hot -> yellow -> orange -> deep red, soft glow core with puff breakup.
    vec4 g = cell(2.0, vUv);
    vec4 p = cell(vSeed > 0.5 ? 0.0 : 1.0, vUv);
    float d = mix(g.a, p.a, 0.55);
    vec3 c0 = vec3(6.0, 5.0, 3.2), c1 = vec3(5.0, 2.2, 0.55), c2 = vec3(1.6, 0.35, 0.06), c3 = vec3(0.25, 0.05, 0.01);
    col = t < 0.2 ? mix(c0, c1, t / 0.2) : t < 0.55 ? mix(c1, c2, (t - 0.2) / 0.35) : mix(c2, c3, (t - 0.55) / 0.45);
    a = d * (1.0 - smoothstep(0.6, 1.0, t)) * smoothstep(0.0, 0.05, t);
  } else if (vKind < 1.5 || (vKind > 6.5 && vKind < 7.5) || (vKind > 3.5 && vKind < 5.5)) {
    // Smoke family (1 smoke, 4 dust, 5 spray, 7 white smoke): sun-lit puffs.
    vec4 p = cell(vSeed > 0.5 ? 0.0 : 1.0, vUv);
    vec3 base = vKind < 1.5 ? vec3(0.13, 0.12, 0.115) : vKind < 4.5 ? vec3(0.42, 0.34, 0.24) : vKind < 5.5 ? vec3(0.85, 0.9, 0.95) : vec3(0.75, 0.75, 0.76);
    base = mix(base, base * 1.8 + 0.04, smoothstep(0.2, 1.0, t) * (vKind < 1.5 ? 0.7 : 0.0));
    vec2 dir = vUv * 2.0 - 1.0;
    float lit = 0.55 + 0.45 * clamp(dot(dir, vSun2) * 0.8 + p.g * 0.6, 0.0, 1.0);
    vec3 sun = vec3(1.9, 1.8, 1.65) * lit * vDay + vec3(0.03, 0.04, 0.06);
    vec3 amb = mix(vec3(0.015, 0.018, 0.028), vec3(0.2, 0.24, 0.3), vDay);
    col = base * (sun + amb);
    float fin = vKind > 4.5 && vKind < 5.5 ? 0.12 : 0.08;
    a = p.a * smoothstep(0.0, fin, t) * (1.0 - smoothstep(0.45, 1.0, t)) * (vKind > 4.5 && vKind < 5.5 ? 0.8 : 0.72);
  } else if (vKind < 2.5) {
    vec4 s = cell(3.0, vUv);
    col = mix(vec3(7.0, 5.5, 3.0), vec3(3.0, 0.8, 0.15), t);
    a = s.a * (1.0 - t) * (1.0 - t);
  } else if (vKind < 3.5) {
    vec4 g = cell(2.0, vUv);
    col = mix(vec3(5.0, 4.4, 3.6), vec3(3.5, 1.6, 0.5), t) * (1.0 - t * 0.5);
    a = g.a * (1.0 - t) * (1.0 - t);
  } else if (vKind < 6.5) {
    vec4 g = cell(2.0, vUv);
    float fl = 0.6 + 0.4 * sin(t * 40.0 + vSeed * 30.0);
    col = vec3(4.0, 1.4, 0.25) * fl;
    a = g.a * (1.0 - t) * smoothstep(0.0, 0.1, t);
  } else if (vKind < 8.5) {
    // Debris: dark chunks.
    vec4 g = cell(2.0, vUv);
    col = vec3(0.03, 0.028, 0.025);
    a = smoothstep(0.25, 0.6, g.a) * (1.0 - smoothstep(0.7, 1.0, t));
  } else {
    vec4 g = cell(2.0, vUv);
    col = mix(vec3(5.0, 7.0, 10.0), vec3(1.0, 2.0, 5.0), t);
    a = g.a * (1.0 - t) * (1.0 - t);
  }
  a *= vFade;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Pool {
  readonly mesh: THREE.Mesh;
  readonly geo: THREE.InstancedBufferGeometry;
  private p0: THREE.InstancedBufferAttribute;
  private vel: THREE.InstancedBufferAttribute;
  private tt: THREE.InstancedBufferAttribute;
  private kk: THREE.InstancedBufferAttribute;
  private head = 0;
  private emittedThisFrame = 0;
  private frameStart = 0;
  private written = 0;
  readonly cap: number;

  constructor(cap: number, material: THREE.ShaderMaterial, name: string) {
    this.cap = cap;
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(2, 2);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    this.p0 = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.vel = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const t = new Float32Array(cap * 4);
    for (let i = 0; i < cap; i++) t[i * 4] = -1e9;
    this.tt = new THREE.InstancedBufferAttribute(t, 4);
    this.kk = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    for (const a of [this.p0, this.vel, this.tt, this.kk]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aP0', this.p0);
    geo.setAttribute('aVel', this.vel);
    geo.setAttribute('aT', this.tt);
    geo.setAttribute('aK', this.kk);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 51;
  }

  emit(now: number, kind: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number, drag: number, buoy: number, seed: number): void {
    if (this.emittedThisFrame === 0) this.frameStart = this.head;
    if (this.emittedThisFrame >= this.cap) return;
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.emittedThisFrame++;
    this.written = Math.min(this.cap, this.written + 1);
    const p = this.p0.array as Float32Array, v = this.vel.array as Float32Array;
    const t = this.tt.array as Float32Array, k = this.kk.array as Float32Array;
    p[i * 3] = px; p[i * 3 + 1] = py; p[i * 3 + 2] = pz;
    v[i * 3] = vx; v[i * 3 + 1] = vy; v[i * 3 + 2] = vz;
    t[i * 4] = now; t[i * 4 + 1] = life; t[i * 4 + 2] = s0; t[i * 4 + 3] = s1;
    k[i * 4] = kind; k[i * 4 + 1] = seed; k[i * 4 + 2] = drag; k[i * 4 + 3] = buoy;
  }

  flush(): void {
    const n = this.emittedThisFrame;
    if (n === 0) return;
    this.emittedThisFrame = 0;
    this.geo.instanceCount = this.written;
    const attrs = [this.p0, this.vel, this.tt, this.kk];
    const start = this.frameStart;
    for (const a of attrs) {
      const s = a.itemSize;
      if (start + n <= this.cap) a.addUpdateRange(start * s, n * s);
      else {
        a.addUpdateRange(start * s, (this.cap - start) * s);
        a.addUpdateRange(0, (start + n - this.cap) * s);
      }
      a.needsUpdate = true;
    }
  }

  clear(): void {
    const t = this.tt.array as Float32Array;
    for (let i = 0; i < this.cap; i++) t[i * 4] = -1e9;
    this.tt.clearUpdateRanges();
    this.tt.needsUpdate = true;
    this.head = 0;
    this.written = 0;
    this.emittedThisFrame = 0;
    this.geo.instanceCount = 0;
  }
}

export class ParticleSystem {
  readonly group = new THREE.Group();
  private add: Pool;
  private alpha: Pool;
  private now = 0;
  private seedState = 1234567;
  /** Emission budget scaling (quality). */
  density = 1;

  constructor(capacity: number, atlas: THREE.Texture) {
    const mk = (additive: boolean) => new THREE.ShaderMaterial({
      name: additive ? 'fx-particles-add' : 'fx-particles-alpha',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uAtlas: { value: atlas },
        uFxTime: sharedUniforms.uFxTime,
        uPixelK: sharedUniforms.uPixelK,
        uSunDir: sharedUniforms.uSunDir,
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const capA = Math.max(512, Math.round(capacity * 0.4));
    const capB = Math.max(512, capacity - capA);
    this.add = new Pool(capA, mk(true), 'fx-particles-add');
    this.alpha = new Pool(capB, mk(false), 'fx-particles-alpha');
    this.alpha.mesh.renderOrder = 50;
    this.add.mesh.renderOrder = 52;
    this.group.add(this.alpha.mesh, this.add.mesh);
    this.density = Math.min(1.5, Math.max(0.35, capacity / 15000));
  }

  /** Deterministic-ish cheap random (render only). */
  rand(): number {
    this.seedState = (Math.imul(this.seedState, 1664525) + 1013904223) >>> 0;
    return this.seedState / 4294967296;
  }

  setTime(t: number): void {
    this.now = t;
  }

  /** Emit one particle. Positions in world units, velocity in world units/s, sizes are billboard half-widths. */
  emit(kind: ParticleKind, px: number, py: number, pz: number, vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number, drag = 0, buoy = 0, delay = 0): void {
    const pool = ADDITIVE.has(kind) ? this.add : this.alpha;
    pool.emit(this.now + delay, kind, px, py, pz, vx, vy, vz, life, s0, s1, drag, buoy, this.rand());
  }

  flush(): void {
    this.add.flush();
    this.alpha.flush();
  }

  clear(): void {
    this.add.clear();
    this.alpha.clear();
  }

  warmup(on: boolean): void {
    if (on) {
      this.add.geo.instanceCount = Math.max(1, this.add.geo.instanceCount);
      this.alpha.geo.instanceCount = Math.max(1, this.alpha.geo.instanceCount);
    }
  }
}
