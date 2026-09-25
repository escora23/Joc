// FRONT ULTRA — procedural sprite atlas for particles, puffs and glows (owner: units / fx).
// 2x2 atlas, generated once at init (no image files):
//   cell 0: billowy smoke puff A (fbm-eroded sphere, alpha = density, G = fake "thickness" for lighting)
//   cell 1: billowy smoke puff B (different seed, more broken up)
//   cell 2: hot radial glow (fire cores, flashes)
//   cell 3: soft streak (sparks, spray; stretched along velocity in the shader)

import * as THREE from 'three';

function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, s: number, oct = 5): number {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += a * valueNoise(x * f, y * f, s + i * 17);
    norm += a;
    a *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

export const ATLAS_CELLS = 2;

export function createSpriteAtlas(size = 256): THREE.DataTexture {
  const cell = size / ATLAS_CELLS;
  const data = new Uint8Array(size * size * 4);
  const put = (cx: number, cy: number, fn: (u: number, v: number) => [number, number]) => {
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x + 0.5) / cell * 2 - 1, v = (y + 0.5) / cell * 2 - 1;
        const [dens, thick] = fn(u, v);
        const o = ((cy * cell + y) * size + cx * cell + x) * 4;
        const d = Math.max(0, Math.min(1, dens));
        data[o] = Math.round(d * 255);
        data[o + 1] = Math.round(Math.max(0, Math.min(1, thick)) * 255);
        data[o + 2] = Math.round(d * 255);
        data[o + 3] = Math.round(d * 255);
      }
    }
  };
  const puff = (seed: number, erosion: number) => (u: number, v: number): [number, number] => {
    const r = Math.sqrt(u * u + v * v);
    const n = fbm(u * 2.4 + 5, v * 2.4 + 3, seed, 5);
    const n2 = fbm(u * 6.3 + 1, v * 6.3 + 9, seed + 7, 4);
    // Billowy silhouette: a sphere whose edge is pushed in and out by two noise scales.
    const edge = r + (n - 0.5) * 0.5 + (n2 - 0.5) * 0.22;
    const inside = 1 - edge;
    let dens = Math.max(0, Math.min(1, inside * 3.2));
    dens *= 1 - erosion * Math.max(0, 0.55 - n2) * 0.9;
    dens *= Math.max(0, Math.min(1, (1 - r) * 3.2));
    // "Thickness" drives fake lighting: rounded lobes with crevices between them.
    const thick = Math.sqrt(Math.max(0, 1 - Math.min(1, edge) ** 2)) * (0.55 + 0.45 * n2);
    return [dens, thick];
  };
  put(0, 0, puff(11, 0.4));
  put(1, 0, puff(29, 0.8));
  put(0, 1, (u, v) => {
    const r = Math.sqrt(u * u + v * v);
    const core = Math.exp(-r * r * 9);
    const halo = Math.exp(-r * 3.2) * 0.45;
    const d = (core + halo) * Math.max(0, Math.min(1, (1 - r) * 4));
    return [d, core];
  });
  put(1, 1, (u, v) => {
    const d = Math.exp(-(v * v) * 38) * Math.max(0, 1 - Math.abs(u)) ** 1.5;
    return [d * 1.2, d];
  });
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
