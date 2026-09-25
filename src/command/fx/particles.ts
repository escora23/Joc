// FRONT ULTRA — command mode: particle system (owner: command).
// CPU-simulated structure-of-arrays pool (fixed capacity from quality.particles), rendered as two instanced
// billboard batches: alpha-blended (smoke, dust, spray, dirt) and additive HDR (fire, flashes, sparks, tracers).
// Particles can be velocity-stretched (tracers, sparks, debris streaks). "Immediate" particles live for one frame
// (projectile tracers). No per-frame allocation: dead particles are swap-removed; GPU buffers are rewritten with
// only the live range.

import * as THREE from 'three';

export const PK = {
  Smoke: 0,
  SmokeLight: 1,
  Dust: 2,
  Splash: 3,
  Dirt: 4,
  Fire: 5,
  Flash: 6,
  Spark: 7,
  Flare: 8,
  Ember: 9,
  Muzzle: 10,
  Foam: 11,
  Steam: 12,
} as const;
export type PK = (typeof PK)[keyof typeof PK];

interface KindDef {
  additive: boolean;
  /** Self-lit (fire): drawn in the alpha batch but not shaded by the scene light. */
  emissive?: boolean;
  cell: number;
  gravity: number;
  drag: number;
  stretch: number;
  /** alpha envelope: fade-in fraction */
  fadeIn: number;
}

const KINDS: KindDef[] = [];
KINDS[PK.Smoke] = { additive: false, cell: 0, gravity: -0.6, drag: 0.9, stretch: 0, fadeIn: 0.06 };
KINDS[PK.SmokeLight] = { additive: false, cell: 0, gravity: -0.25, drag: 1.2, stretch: 0, fadeIn: 0.08 };
KINDS[PK.Dust] = { additive: false, cell: 0, gravity: 0.3, drag: 1.6, stretch: 0, fadeIn: 0.05 };
KINDS[PK.Splash] = { additive: false, cell: 0, gravity: 9.8, drag: 0.4, stretch: 0, fadeIn: 0.02 };
KINDS[PK.Dirt] = { additive: false, cell: 3, gravity: 9.8, drag: 0.2, stretch: 0.045, fadeIn: 0 };
KINDS[PK.Fire] = { additive: false, emissive: true, cell: 2, gravity: -3.0, drag: 1.8, stretch: 0, fadeIn: 0.04 };
KINDS[PK.Flash] = { additive: true, cell: 1, gravity: 0, drag: 0, stretch: 0, fadeIn: 0 };
KINDS[PK.Spark] = { additive: true, cell: 3, gravity: 9.8, drag: 0.5, stretch: 0.03, fadeIn: 0 };
KINDS[PK.Flare] = { additive: true, cell: 1, gravity: 4, drag: 0.6, stretch: 0, fadeIn: 0 };
KINDS[PK.Ember] = { additive: true, cell: 3, gravity: -1.5, drag: 1.0, stretch: 0.02, fadeIn: 0.1 };
KINDS[PK.Muzzle] = { additive: false, emissive: true, cell: 2, gravity: 0, drag: 6, stretch: 0, fadeIn: 0 };
KINDS[PK.Foam] = { additive: false, cell: 1, gravity: 0, drag: 2.5, stretch: 0, fadeIn: 0.1 };
KINDS[PK.Steam] = { additive: false, cell: 0, gravity: -2.0, drag: 1.4, stretch: 0, fadeIn: 0.1 };

const VERT = /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute float iD;
uniform float uFogDensity;
varying vec2 vUv;
varying vec4 vCol;
varying float vFog;
varying float vEmissive;
void main() {
  vec4 mv = viewMatrix * vec4(iA.xyz, 1.0);
  vec2 c = position.xy;
  float size = iA.w;
  if (dot(iC.xyz, iC.xyz) > 1e-8) {
    vec3 sv = (viewMatrix * vec4(iC.xyz, 0.0)).xyz;
    vec2 dir = sv.xy;
    float l = length(dir);
    dir = l > 1e-5 ? dir / l : vec2(0.0, 1.0);
    vec2 side = vec2(-dir.y, dir.x);
    mv.xyz += vec3(side * c.x * size, 0.0) - sv * (c.y + 0.5) + vec3(dir * c.y * size * 0.5, 0.0);
  } else {
    float cs = cos(iC.w), sn = sin(iC.w);
    mv.xy += vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y) * size;
  }
  gl_Position = projectionMatrix * mv;
  vEmissive = step(3.5, iD);
  float cell = mod(iD, 4.0);
  vec2 off = vec2(mod(cell, 2.0) * 0.5, 0.5 - floor(cell / 2.0) * 0.5);
  vUv = (position.xy + 0.5) * 0.5 + off;
  vCol = iB;
  float d = length(mv.xyz);
  vFog = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
  vCol.a *= smoothstep(0.4, 2.5, d);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uFogColor;
uniform vec3 uLight;
uniform float uAdditive;
varying vec2 vUv;
varying vec4 vCol;
varying float vFog;
varying float vEmissive;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vCol.a;
  if (a < 0.003) discard;
  vec3 c;
  if (uAdditive > 0.5) {
    c = vCol.rgb * (0.6 + 0.4 * tex.r) * (1.0 - vFog);
  } else if (vEmissive > 0.5) {
    c = vCol.rgb * (0.55 + 0.45 * tex.r) * (1.0 - vFog * 0.7);
    a *= 0.92;
  } else {
    c = vCol.rgb * tex.r * uLight;
    c = mix(c, uFogColor, vFog);
  }
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Batch {
  readonly mesh: THREE.Mesh;
  readonly geo: THREE.InstancedBufferGeometry;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly c: Float32Array;
  readonly d: Float32Array;
  readonly attrs: THREE.InstancedBufferAttribute[];
  n = 0;
  constructor(readonly cap: number, readonly material: THREE.ShaderMaterial, name: string, order: number) {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    this.a = new Float32Array(cap * 4);
    this.b = new Float32Array(cap * 4);
    this.c = new Float32Array(cap * 4);
    this.d = new Float32Array(cap);
    const mk = (arr: Float32Array, size: number) => {
      const at = new THREE.InstancedBufferAttribute(arr, size);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    this.attrs = [mk(this.a, 4), mk(this.b, 4), mk(this.c, 4), mk(this.d, 1)];
    geo.setAttribute('iA', this.attrs[0]);
    geo.setAttribute('iB', this.attrs[1]);
    geo.setAttribute('iC', this.attrs[2]);
    geo.setAttribute('iD', this.attrs[3]);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.name = name;
  }
  push(x: number, y: number, z: number, size: number, r: number, g: number, bl: number, al: number, sx: number, sy: number, sz: number, rot: number, cell: number): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    const i4 = i * 4;
    this.a[i4] = x; this.a[i4 + 1] = y; this.a[i4 + 2] = z; this.a[i4 + 3] = size;
    this.b[i4] = r; this.b[i4 + 1] = g; this.b[i4 + 2] = bl; this.b[i4 + 3] = al;
    this.c[i4] = sx; this.c[i4 + 1] = sy; this.c[i4 + 2] = sz; this.c[i4 + 3] = rot;
    this.d[i] = cell;
  }
  flush(): void {
    const n = this.n;
    for (let k = 0; k < 4; k++) {
      const at = this.attrs[k];
      at.clearUpdateRanges();
      const w = k === 3 ? 1 : 4;
      if (n > 0) at.addUpdateRange(0, n * w);
      at.needsUpdate = n > 0;
    }
    this.geo.instanceCount = n;
    this.n = 0;
  }
}

export class Particles {
  readonly group = new THREE.Group();
  private cap: number;
  private count = 0;
  // SoA state
  private kind: Uint8Array;
  private age: Float32Array;
  private life: Float32Array;
  private px: Float32Array; private py: Float32Array; private pz: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private s0: Float32Array; private s1: Float32Array;
  private rot: Float32Array; private rotV: Float32Array;
  private cr: Float32Array; private cg: Float32Array; private cb: Float32Array; private ca: Float32Array;
  private grav: Float32Array;
  private readonly alpha: Batch;
  private readonly add: Batch;
  readonly alphaMat: THREE.ShaderMaterial;
  readonly addMat: THREE.ShaderMaterial;
  private seed = 1;

  constructor(atlas: THREE.Texture, capacity: number) {
    this.cap = capacity;
    this.kind = new Uint8Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.px = new Float32Array(capacity); this.py = new Float32Array(capacity); this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity); this.vy = new Float32Array(capacity); this.vz = new Float32Array(capacity);
    this.s0 = new Float32Array(capacity); this.s1 = new Float32Array(capacity);
    this.rot = new Float32Array(capacity); this.rotV = new Float32Array(capacity);
    this.cr = new Float32Array(capacity); this.cg = new Float32Array(capacity); this.cb = new Float32Array(capacity); this.ca = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    const mkMat = (additive: boolean) =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        uniforms: {
          uMap: { value: atlas },
          uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
          uFogDensity: { value: 0.0003 },
          uLight: { value: new THREE.Color(1, 1, 1) },
          uAdditive: { value: additive ? 1 : 0 },
        },
      });
    this.alphaMat = mkMat(false);
    this.addMat = mkMat(true);
    // Immediate particles need headroom on top of the pool.
    this.alpha = new Batch(capacity + 512, this.alphaMat, 'particles-alpha', 50);
    this.add = new Batch(capacity + 2048, this.addMat, 'particles-add', 51);
    this.group.add(this.alpha.mesh, this.add.mesh);
  }

  get live(): number {
    return this.count;
  }

  setFog(color: THREE.Color, density: number, light: THREE.Color): void {
    for (const m of [this.alphaMat, this.addMat]) {
      (m.uniforms.uFogColor.value as THREE.Color).copy(color);
      m.uniforms.uFogDensity.value = density;
      (m.uniforms.uLight.value as THREE.Color).copy(light);
    }
  }

  clear(): void {
    this.count = 0;
    this.alpha.n = 0;
    this.add.n = 0;
    this.alpha.flush();
    this.add.flush();
  }

  private rand(): number {
    // xorshift: cheap deterministic jitter for rotations
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s >>> 0 || 1;
    return this.seed / 4294967296;
  }

  /** Spawn a particle. Color is linear HDR (additive kinds may exceed 1). */
  emit(k: PK, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size0: number, size1: number, r: number, g: number, b: number, a = 1): void {
    let i = this.count;
    if (i >= this.cap) {
      // Pool full: recycle the oldest-looking slot (random) so big moments still read.
      i = Math.floor(this.rand() * this.cap);
    } else this.count++;
    this.kind[i] = k;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, life);
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.s0[i] = size0; this.s1[i] = size1;
    this.rot[i] = this.rand() * Math.PI * 2;
    this.rotV[i] = (this.rand() - 0.5) * (k === PK.Fire ? 1.6 : 0.5);
    this.cr[i] = r; this.cg[i] = g; this.cb[i] = b; this.ca[i] = a;
    this.grav[i] = KINDS[k].gravity;
  }

  /** Override gravity of the most recently emitted particle (e.g. heavy spray, hanging smoke). */
  setLastGravity(g: number): void {
    if (this.count > 0) this.grav[this.count - 1] = g;
  }

  /** One-frame additive streak (projectile tracers, beams). */
  streak(x: number, y: number, z: number, sx: number, sy: number, sz: number, width: number, r: number, g: number, b: number, a = 1): void {
    this.add.push(x, y, z, width, r, g, b, a, sx, sy, sz, 0, 3);
  }

  /** One-frame additive glow sprite. */
  glow(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a = 1): void {
    this.add.push(x, y, z, size, r, g, b, a, 0, 0, 0, 0, 1);
  }

  simulate(dt: number): void {
    let n = this.count;
    const { kind, age, life, px, py, pz, vx, vy, vz, s0, s1, rot, rotV, cr, cg, cb, ca, grav } = this;
    let i = 0;
    while (i < n) {
      const a = age[i] + dt;
      if (a >= life[i]) {
        n--;
        this.move(n, i);
        continue;
      }
      age[i] = a;
      const k = kind[i];
      const def = KINDS[k];
      const damp = Math.max(0, 1 - def.drag * dt);
      vx[i] *= damp;
      vz[i] *= damp;
      vy[i] = vy[i] * damp - grav[i] * dt;
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      pz[i] += vz[i] * dt;
      rot[i] += rotV[i] * dt;
      const t = a / life[i];
      const e = 1 - (1 - t) * (1 - t);
      const size = s0[i] + (s1[i] - s0[i]) * e;
      // Alpha envelope
      let al = ca[i];
      if (def.fadeIn > 0 && t < def.fadeIn) al *= t / def.fadeIn;
      al *= k === PK.Flash || k === PK.Muzzle ? (1 - t) * (1 - t) : 1 - t * t;
      let r = cr[i], g = cg[i], b = cb[i];
      if (k === PK.Fire) {
        // white-hot -> orange -> deep red -> sooty
        const h = 1 - t;
        const hot = h * h;
        r *= 0.25 + 2.6 * hot + 0.6 * h;
        g *= 0.06 + 1.6 * hot * hot + 0.25 * h;
        b *= 0.02 + 0.8 * hot * hot * hot;
      } else if (k === PK.Spark || k === PK.Ember) {
        const h = 1 - t;
        r *= 0.5 + h * 1.5;
        g *= 0.2 + h * h;
        b *= h * h * 0.6;
      }
      if (def.additive) {
        const sv = def.stretch;
        this.add.push(px[i], py[i], pz[i], size, r, g, b, al, vx[i] * sv, vy[i] * sv, vz[i] * sv, rot[i], def.cell);
      } else {
        const sv = def.stretch;
        this.alpha.push(px[i], py[i], pz[i], size, r, g, b, al, vx[i] * sv, vy[i] * sv, vz[i] * sv, rot[i], def.cell + (def.emissive ? 4 : 0));
      }
      i++;
    }
    this.count = n;
  }

  /** Drop this substep's draw lists without uploading (only the last substep of a frame is drawn). */
  discardFrame(): void {
    this.alpha.n = 0;
    this.add.n = 0;
  }

  /** Upload this frame's particles (call after simulate + immediates). */
  flush(): void {
    this.alpha.flush();
    this.add.flush();
  }

  private move(from: number, to: number): void {
    if (from === to) return;
    this.kind[to] = this.kind[from];
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.px[to] = this.px[from]; this.py[to] = this.py[from]; this.pz[to] = this.pz[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.s0[to] = this.s0[from]; this.s1[to] = this.s1[from];
    this.rot[to] = this.rot[from]; this.rotV[to] = this.rotV[from];
    this.cr[to] = this.cr[from]; this.cg[to] = this.cg[from]; this.cb[to] = this.cb[from]; this.ca[to] = this.ca[from];
    this.grav[to] = this.grav[from];
  }

  warmup(on: boolean): void {
    if (on) {
      this.alpha.push(0, 0, -5, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0);
      this.add.push(0, 0, -5, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1);
      this.alpha.flush();
      this.add.flush();
    } else {
      this.clear();
    }
  }
}
