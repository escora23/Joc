// FRONT ULTRA — ground battle: procedural textures generated at load time (owner: battle).
//   * detail: tileable RGBA noise (R fine fBm, G medium fBm, B Worley cells, A ridged) for ground micro-detail,
//     crater fields and material variation.
//   * puff: soft billowy smoke/dust sprite with a baked pseudo-normal (lit smoke at golden hour).

import * as THREE from 'three';

function hashI(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Tileable value noise with period p (lattice units). */
function vnoise(x: number, y: number, p: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p;
  const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
  const a = hashI(x0, y0, s), b = hashI(x1, y0, s), c = hashI(x0, y1, s), d = hashI(x1, y1, s);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function fbm(x: number, y: number, p: number, oct: number, s: number, ridged = false): number {
  let sum = 0, amp = 0.5, norm = 0, per = p, f = 1;
  for (let o = 0; o < oct; o++) {
    let v = vnoise(x * f, y * f, per, s + o * 101);
    if (ridged) {
      v = 1 - Math.abs(v * 2 - 1);
      v *= v;
    }
    sum += v * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
    per *= 2;
  }
  return sum / norm;
}

/** Tileable Worley F1 (normalized 0..1 distance to the nearest feature point) with period p cells. */
function worley(x: number, y: number, p: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % p) + p) % p, wy = ((cy % p) + p) % p;
      const px = cx + 0.15 + 0.7 * hashI(wx, wy, s), py = cy + 0.15 + 0.7 * hashI(wx, wy, s + 7);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

export function makeDetailTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const P = 8; // base lattice period over the tile
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i / size) * P, v = (j / size) * P;
      const o = (j * size + i) * 4;
      data[o] = Math.round(fbm(u * 2, v * 2, P * 2, 5, 11) * 255);
      data[o + 1] = Math.round(fbm(u * 0.5 + 3.1, v * 0.5 + 7.7, P / 2, 5, 23) * 255);
      data[o + 2] = Math.round(worley(u * 2, v * 2, P * 2, 37) * 255);
      data[o + 3] = Math.round(fbm(u, v, P, 5, 53, true) * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Billowy puff sprite (2x2 atlas of variations): a union of hemispherical lumps ("cauliflower") eroded by noise.
 * R = density (alpha), G/B = surface normal xy of the lumps (0.5 = facing the viewer) for lit smoke,
 * A = a harder, wispier density for flames.
 */
export function makePuffTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const cell = size / 2;
  const hf = new Float32Array(size * size);
  const dens = new Float32Array(size * size);
  let seed = 17;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * cell, oy = Math.floor(q / 2) * cell;
    const lumps: [number, number, number][] = [];
    const n = 10 + Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * 0.36;
      const r = 0.36 - rr * 0.4 + rnd() * 0.07;
      lumps.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.9 - 0.02, r]);
    }
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const x = ((i + 0.5) / cell) * 2 - 1, y = ((j + 0.5) / cell) * 2 - 1;
        // Smooth union of hemispherical lumps (soft creases between them).
        let acc = 0;
        for (const [cx, cy, r] of lumps) {
          const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
          if (d2 < r * r) acc += Math.exp(18 * Math.sqrt(r * r - d2));
          else acc += 1;
        }
        const h = Math.max(0, Math.log(acc / lumps.length) / 18);
        const nz = fbm(x * 3 + q * 10, y * 3 + q * 7, 256, 5, 91 + q);
        const erode = smooth(0.0, 0.13, h + (nz - 0.5) * 0.1) * smooth(0, 0.012, h);
        const edgeFade = 1 - smooth(0.82, 0.98, Math.sqrt(x * x + y * y));
        const k = (oy + j) * size + ox + i;
        hf[k] = h;
        dens[k] = Math.max(0, Math.min(1, erode * (0.7 + 0.6 * nz) * edgeFade));
      }
    }
  }
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const o = k * 4;
      const d = dens[k];
      const hl = hf[j * size + Math.max(0, i - 1)], hr = hf[j * size + Math.min(size - 1, i + 1)];
      const hu = hf[Math.max(0, j - 1) * size + i], hd = hf[Math.min(size - 1, j + 1) * size + i];
      const sc = cell * 0.5;
      let nx = (hl - hr) * sc, ny = (hu - hd) * sc;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= l;
      ny /= l;
      data[o] = Math.round(d * 255);
      data[o + 1] = Math.round(Math.max(0, Math.min(1, 0.5 + nx * 0.5)) * 255);
      data[o + 2] = Math.round(Math.max(0, Math.min(1, 0.5 + ny * 0.5)) * 255);
      const wisp = fbm(i / 18, j / 18, size / 18, 4, 131);
      data[o + 3] = Math.round(Math.max(0, Math.min(1, Math.pow(d, 1.4) * (0.55 + 0.9 * wisp))) * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** CPU twin of sampling the detail texture on the GPU (bilinear, repeat): lets scatterers follow the shaders. */
export type DetailSampler = (u: number, v: number, channel: number) => number;
export function detailSampler(t: THREE.DataTexture): DetailSampler {
  const img = t.image as { data: Uint8Array; width: number; height: number };
  const d = img.data, n = img.width;
  const inv = 1 / 255;
  return (u, v, c) => {
    const x = u * n - 0.5, y = v * n - 0.5;
    const xf = Math.floor(x), yf = Math.floor(y);
    const fx = x - xf, fy = y - yf;
    const x0 = ((xf % n) + n) % n, y0 = ((yf % n) + n) % n;
    const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const a = d[(y0 * n + x0) * 4 + c], b = d[(y0 * n + x1) * 4 + c];
    const e = d[(y1 * n + x0) * 4 + c], f = d[(y1 * n + x1) * 4 + c];
    return ((a + (b - a) * fx) * (1 - fy) + (e + (f - e) * fx) * fy) * inv;
  };
}
