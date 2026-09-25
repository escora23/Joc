// FRONT ULTRA — command mode: ribbon trails (owner: command).
// Camera-facing strips following a moving point: wingtip vortices on hard-turning jets, faint contrails. A fixed pool
// of ribbons, each a ring buffer of samples, rebuilt into one dynamic triangle buffer per frame (one draw call, no
// allocation). Samples age and fade; width grows slightly with age as the vortex diffuses.

import * as THREE from 'three';

const MAX_RIBBONS = 16;
const MAX_PTS = 64;

const VERT = /* glsl */ `
attribute float aAlpha;
attribute float aV;
varying float vAlpha;
varying float vV;
varying float vFog;
uniform float uFogDensity;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(mv.xyz);
  // Trails streaming past the chase camera would fill the screen: fade them out close to it.
  vAlpha = aAlpha * smoothstep(12.0, 55.0, d);
  vV = aV;
  vFog = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uFogColor;
varying float vAlpha;
varying float vV;
varying float vFog;
void main() {
  // Soft across the strip (vV = -1..1), fading with age.
  float edge = 1.0 - vV * vV;
  float a = vAlpha * edge * edge;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uColor, uFogColor, vFog), a * (1.0 - vFog * 0.8));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface Ribbon {
  used: boolean;
  /** Owner key (so a caller can find its ribbon again). */
  key: number;
  head: number;
  n: number;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  age: Float32Array;
  a0: Float32Array;
  width: number;
  life: number;
  /** Seconds since the last sample was pushed (a ribbon nobody feeds is released once it has faded). */
  idle: number;
}

export class Ribbons {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly ribbons: Ribbon[] = [];
  private readonly pos: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vv: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly cam = new THREE.Vector3();

  constructor() {
    const maxVerts = MAX_RIBBONS * (MAX_PTS - 1) * 6;
    this.pos = new Float32Array(maxVerts * 3);
    this.alpha = new Float32Array(maxVerts);
    this.vv = new Float32Array(maxVerts);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aV', new THREE.BufferAttribute(this.vv, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color(0.95, 0.97, 1.0) },
        uFogColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
        uFogDensity: { value: 0.0001 },
      },
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 49;
    this.mesh.name = 'ribbons';
    for (let i = 0; i < MAX_RIBBONS; i++) {
      this.ribbons.push({
        used: false, key: -1, head: 0, n: 0, px: new Float32Array(MAX_PTS), py: new Float32Array(MAX_PTS), pz: new Float32Array(MAX_PTS),
        age: new Float32Array(MAX_PTS), a0: new Float32Array(MAX_PTS), width: 1, life: 2, idle: 0,
      });
    }
  }

  setFog(color: THREE.Color, density: number, light: THREE.Color): void {
    (this.material.uniforms.uFogColor.value as THREE.Color).copy(color);
    this.material.uniforms.uFogDensity.value = density;
    (this.material.uniforms.uColor.value as THREE.Color).copy(light).multiplyScalar(1.15);
  }

  clear(): void {
    for (const r of this.ribbons) {
      r.used = false;
      r.n = 0;
    }
    this.geo.setDrawRange(0, 0);
  }

  /**
   * Feed a sample for the ribbon identified by `key` (e.g. entity id * 2 + wing). `alpha` 0 still advances the trail
   * (a gap), so vapor appears and disappears with the G load. Samples closer than `minStep` to the last one are skipped.
   */
  push(key: number, x: number, y: number, z: number, alpha: number, width: number, life: number, minStep = 4): void {
    let r: Ribbon | null = null;
    for (const o of this.ribbons) if (o.used && o.key === key) r = o;
    if (!r) {
      if (alpha <= 0.01) return;
      for (const o of this.ribbons) if (!o.used && !r) r = o;
      if (!r) return;
      r.used = true;
      r.key = key;
      r.n = 0;
      r.head = 0;
    }
    r.width = width;
    r.life = life;
    r.idle = 0;
    if (r.n > 0) {
      const h = (r.head + MAX_PTS - 1) % MAX_PTS;
      const dx = x - r.px[h], dy = y - r.py[h], dz = z - r.pz[h];
      if (dx * dx + dy * dy + dz * dz < minStep * minStep) {
        // Keep the newest point glued to the emitter so the ribbon never lags behind the wing.
        r.px[h] = x;
        r.py[h] = y;
        r.pz[h] = z;
        r.a0[h] = Math.max(r.a0[h], alpha);
        return;
      }
    }
    const i = r.head;
    r.px[i] = x;
    r.py[i] = y;
    r.pz[i] = z;
    r.age[i] = 0;
    r.a0[i] = alpha;
    r.head = (r.head + 1) % MAX_PTS;
    r.n = Math.min(MAX_PTS, r.n + 1);
  }

  update(dt: number): void {
    for (const r of this.ribbons) {
      if (!r.used) continue;
      r.idle += dt;
      for (let k = 0; k < r.n; k++) r.age[(r.head - 1 - k + MAX_PTS * 2) % MAX_PTS] += dt;
      if (r.idle > r.life) {
        r.used = false;
        r.n = 0;
      }
    }
  }

  /** Rebuild the strip geometry facing `camera` (call once per rendered frame). */
  build(camera: THREE.Camera): void {
    camera.getWorldPosition(this.cam);
    let v = 0;
    const cx = this.cam.x, cy = this.cam.y, cz = this.cam.z;
    for (const r of this.ribbons) {
      if (!r.used || r.n < 2) continue;
      // Oldest to newest
      for (let k = r.n - 1; k > 0; k--) {
        const i0 = (r.head - 1 - k + MAX_PTS * 2) % MAX_PTS;
        const i1 = (i0 + 1) % MAX_PTS;
        const f0 = Math.max(0, 1 - r.age[i0] / r.life), f1 = Math.max(0, 1 - r.age[i1] / r.life);
        const a0 = r.a0[i0] * f0 * f0, a1 = r.a0[i1] * f1 * f1;
        if (a0 < 0.004 && a1 < 0.004) continue;
        const x0 = r.px[i0], y0 = r.py[i0], z0 = r.pz[i0], x1 = r.px[i1], y1 = r.py[i1], z1 = r.pz[i1];
        // Side vector = segment x view direction
        const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
        const vx = (x0 + x1) * 0.5 - cx, vy = (y0 + y1) * 0.5 - cy, vz = (z0 + z1) * 0.5 - cz;
        let nx = sy * vz - sz * vy, ny = sz * vx - sx * vz, nz = sx * vy - sy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const w0 = r.width * (1 + (1 - f0) * 2.5), w1 = r.width * (1 + (1 - f1) * 2.5);
        // Two triangles: (0-,0+,1+) (0-,1+,1-)
        v = this.vert(v, x0 - nx * w0, y0 - ny * w0, z0 - nz * w0, a0, -1);
        v = this.vert(v, x0 + nx * w0, y0 + ny * w0, z0 + nz * w0, a0, 1);
        v = this.vert(v, x1 + nx * w1, y1 + ny * w1, z1 + nz * w1, a1, 1);
        v = this.vert(v, x0 - nx * w0, y0 - ny * w0, z0 - nz * w0, a0, -1);
        v = this.vert(v, x1 + nx * w1, y1 + ny * w1, z1 + nz * w1, a1, 1);
        v = this.vert(v, x1 - nx * w1, y1 - ny * w1, z1 - nz * w1, a1, -1);
      }
    }
    this.geo.setDrawRange(0, v);
    const pa = this.geo.attributes.position as THREE.BufferAttribute;
    pa.needsUpdate = true;
    pa.clearUpdateRanges();
    pa.addUpdateRange(0, v * 3);
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aV as THREE.BufferAttribute).needsUpdate = true;
  }

  private vert(v: number, x: number, y: number, z: number, a: number, side: number): number {
    this.pos[v * 3] = x;
    this.pos[v * 3 + 1] = y;
    this.pos[v * 3 + 2] = z;
    this.alpha[v] = a;
    this.vv[v] = side;
    return v + 1;
  }

  warmup(on: boolean): void {
    if (on) {
      this.push(-99, 0, 5, -10, 1, 1, 2, 0);
      this.push(-99, 0, 5, -20, 1, 1, 2, 0);
      this.build(new THREE.PerspectiveCamera());
    } else this.clear();
  }
}
