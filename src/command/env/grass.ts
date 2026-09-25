// FRONT ULTRA — command mode: grass & low scrub around the player (owner: command).
// Instanced clumps of crossed alpha-tested blade cards on a jittered grid within ~120 m of the focus point, density
// and hue driven by the data layer's splat weights (lush in grassland, sparse and straw-colored in steppe, none on
// rock / sand / water / roads). Re-laid when the focus moves far enough; wind sway in the vertex shader.

import * as THREE from 'three';
import type { LocalHeightfield } from '../../data/types';
import type { Ground } from './ground';

const MAX = 14000;
const CELL = 1.7;

function bladeTexture(): THREE.Texture {
  const W = 128, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  let s = 99;
  const r = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < 46; i++) {
    const x = 6 + r() * (W - 12);
    const h = H * (0.45 + r() * 0.55);
    const lean = (r() - 0.5) * 30;
    const w = 2 + r() * 3;
    const shade = 150 + Math.floor(r() * 105);
    g.fillStyle = `rgb(${shade},${shade},${shade})`;
    g.beginPath();
    g.moveTo(x - w, H);
    g.quadraticCurveTo(x + lean * 0.3, H - h * 0.6, x + lean, H - h);
    g.quadraticCurveTo(x + lean * 0.3 + w * 0.3, H - h * 0.6, x + w, H);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function clumpGeometry(): THREE.BufferGeometry {
  const parts: number[] = [];
  const uvs: number[] = [];
  const cols: number[] = [];
  const W = 1.1, H = 0.75;
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3;
    const cx = Math.cos(a) * W * 0.5, cz = Math.sin(a) * W * 0.5;
    const quad = [
      [-cx, 0, -cz, 0, 0], [cx, 0, cz, 1, 0], [cx, H, cz, 1, 1],
      [-cx, 0, -cz, 0, 0], [cx, H, cz, 1, 1], [-cx, H, -cz, 0, 1],
    ];
    for (const [x, y, z, u, v] of quad) {
      parts.push(x, y, z);
      uvs.push(u, v);
      const k2 = 0.66 + 0.34 * v;
      cols.push(k2, k2, k2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(parts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  // Normals pointing up: grass is lit like the ground under it (no card seams).
  const n = new Float32Array(parts.length);
  for (let i = 0; i < n.length; i += 3) n[i + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return g;
}

export class Grass {
  readonly mesh: THREE.InstancedMesh;
  private readonly time = { value: 0 };
  private cx = 1e9;
  private cz = 1e9;
  private hf: LocalHeightfield | null = null;
  private ground: Ground | null = null;
  private radius = 110;
  private density = 1;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);
  enabled = false;

  constructor() {
    const mat = new THREE.MeshStandardMaterial({
      map: bladeTexture(), alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true, roughness: 0.95, metalness: 0,
    });
    const time = this.time;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = time;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float sway = sin(uTime * 1.7 + ip.x * 0.21 + ip.z * 0.17) * 0.5 + sin(uTime * 3.1 + ip.x * 0.7) * 0.2;
          transformed.x += sway * 0.12 * uv.y;
          transformed.z += sway * 0.07 * uv.y;
          #endif`,
        );
    };
    mat.customProgramCacheKey = () => 'fu-cmd-grass';
    this.mesh = new THREE.InstancedMesh(clumpGeometry(), mat, MAX);
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'grass';
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  }

  warmup(on: boolean): void {
    this.mesh.count = on ? 1 : 0;
    if (on) this.mesh.setMatrixAt(0, this.m.makeTranslation(0, 0, -6));
  }

  configure(ground: Ground | null, hf: LocalHeightfield | null, density: number): void {
    this.ground = ground;
    this.hf = hf;
    this.density = density;
    this.enabled = !!hf && density > 0;
    this.radius = 60 + 70 * density;
    this.cx = this.cz = 1e9;
    this.mesh.count = 0;
  }

  update(focus: THREE.Vector3, time: number): void {
    this.time.value = time;
    if (!this.enabled) return;
    if (Math.hypot(focus.x - this.cx, focus.z - this.cz) < 14) return;
    this.cx = focus.x;
    this.cz = focus.z;
    this.layout();
  }

  private layout(): void {
    const hf = this.hf, g = this.ground;
    if (!hf || !g) return;
    const size = hf.sizeKm * 1000, res = hf.resolution;
    const R = this.radius;
    const x0 = Math.floor((this.cx - R) / CELL), x1 = Math.ceil((this.cx + R) / CELL);
    const z0 = Math.floor((this.cz - R) / CELL), z1 = Math.ceil((this.cz + R) / CELL);
    let n = 0;
    const keep = 0.35 + 0.65 * this.density;
    for (let iz = z0; iz <= z1 && n < MAX; iz++) {
      for (let ix = x0; ix <= x1 && n < MAX; ix++) {
        const h1 = hash(ix, iz), h2 = hash(iz * 7 + 3, ix * 13 + 1), h3 = hash(ix + 91, iz - 17);
        if (h3 > keep) continue;
        const x = (ix + h1) * CELL, z = (iz + h2) * CELL;
        const dx = x - this.cx, dz = z - this.cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R || d2 < 30) continue;
        if (Math.abs(x) > size / 2 - 2 || Math.abs(z) > size / 2 - 2) continue;
        const j = Math.round((x / size + 0.5) * (res - 1)), i = Math.round((z / size + 0.5) * (res - 1));
        const k = i * res + j;
        const grass = hf.splatA[k * 4 + 1] / 255, forest = hf.splatA[k * 4 + 2] / 255, dirt = hf.splatB[k * 4 + 2] / 255;
        const sand = hf.splatA[k * 4] / 255, rock = hf.splatA[k * 4 + 3] / 255, urban = hf.splatB[k * 4 + 1] / 255, snow = hf.splatB[k * 4] / 255;
        const cover = grass + forest * 0.8 + dirt * 0.35;
        if (cover < 0.25 + h3 * 0.5 || rock + sand + urban + snow > 0.5) continue;
        const y = g.heightAt(x, z);
        if (y < 0.6) continue;
        // Fade out at the edge by shrinking.
        const edge = 1 - Math.max(0, (Math.sqrt(d2) - R * 0.7) / (R * 0.3));
        const sc = (0.55 + h1 * 0.6) * (0.55 + 0.45 * edge) * (dirt > grass ? 0.7 : 1);
        this.q.setFromAxisAngle(this.up, h2 * Math.PI * 2);
        this.s.set(sc * (0.9 + h3 * 0.4), sc * (0.8 + h2 * 0.6), sc * (0.9 + h3 * 0.4));
        this.p.set(x, y - 0.05, z);
        this.m.compose(this.p, this.q, this.s);
        this.mesh.setMatrixAt(n, this.m);
        // Color from the terrain albedo under it (same palette as the terrain shader), a touch greener and
        // brighter at the tips so the clumps add texture instead of dark dots.
        const w0 = sand, w1 = grass, w2 = forest, w3 = rock, w4 = snow, w5 = urban, w6 = dirt, w7 = hf.splatB[k * 4 + 3] / 255;
        let r = 0.57 * w0 + 0.18 * w1 + 0.07 * w2 + 0.33 * w3 + 0.8 * w4 + 0.37 * w5 + 0.3 * w6 + 0.15 * w7;
        let gg = 0.47 * w0 + 0.21 * w1 + 0.1 * w2 + 0.3 * w3 + 0.84 * w4 + 0.35 * w5 + 0.23 * w6 + 0.13 * w7;
        let b = 0.31 * w0 + 0.07 * w1 + 0.04 * w2 + 0.28 * w3 + 0.9 * w4 + 0.32 * w5 + 0.15 * w6 + 0.1 * w7;
        const ti = k * 3;
        const tr = Math.pow(hf.tint[ti] / 255, 2.2), tg = Math.pow(hf.tint[ti + 1] / 255, 2.2), tb = Math.pow(hf.tint[ti + 2] / 255, 2.2);
        const lt = tr * 0.299 + tg * 0.587 + tb * 0.114 + 1e-3, lc = r * 0.299 + gg * 0.587 + b * 0.114;
        r += (tr * (lc / lt) - r) * 0.3;
        gg += (tg * (lc / lt) - gg) * 0.3;
        b += (tb * (lc / lt) - b) * 0.3;
        const v = (1.35 + h2 * 0.5) * 1.45;
        this.c.setRGB(r * v * 0.92, gg * v * 1.06, b * v * 0.8);
        this.mesh.setColorAt(n, this.c);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 10007) / 10007;
}
