// FRONT ULTRA — command mode: procedural textures (owner: command). Generated once at init, deterministic.
//   * noise: 256² tileable RGBA value-noise (4 different frequencies) for terrain detail, camo, water, clouds.
//   * particle atlas: 2x2 cells (smoke puff, soft glow, flame, spark) for the particle systems.
//   * decal atlas: 2x2 cells (scorch, crater, track tread, blood-free debris dirt) for ground decals.

import * as THREE from 'three';
import { Rng } from '../../shared/rng';

function lattice(size: number, rng: Rng): Float32Array {
  const a = new Float32Array(size * size);
  for (let i = 0; i < a.length; i++) a[i] = rng.next();
  return a;
}

/** Tileable smooth value noise sampled at (x, y) in lattice units, period = size. */
function vnoise(l: Float32Array, size: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const xa = ((x0 % size) + size) % size, xb = (xa + 1) % size;
  const ya = ((y0 % size) + size) % size, yb = (ya + 1) % size;
  const a = l[ya * size + xa], b = l[ya * size + xb], c = l[yb * size + xa], d = l[yb * size + xb];
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(ls: Float32Array[], sizes: number[], u: number, v: number, oct: number, base: number): number {
  let s = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < oct; o++) {
    const f = base << o;
    const li = Math.min(o, ls.length - 1);
    s += vnoise(ls[li], sizes[li], u * f, v * f) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return s / norm;
}

export function makeNoiseTexture(size = 256): THREE.DataTexture {
  const rng = new Rng(9137);
  const sizes = [4, 8, 16, 32, 64, 128, 256];
  const ls = sizes.map((s) => lattice(s, rng));
  // Each lattice level has period == its size, so sampling level k at u * size_k tiles seamlessly.
  const data = new Uint8Array(size * size * 4);
  const chan = (u: number, v: number, start: number, oct: number): number => {
    let s = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < oct; o++) {
      const k = Math.min(start + o, sizes.length - 1);
      s += vnoise(ls[k], sizes[k], u * sizes[k], v * sizes[k]) * amp;
      norm += amp;
      amp *= 0.55;
    }
    return s / norm;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = (y * size + x) * 4;
      data[i] = Math.round(stretch(chan(u, v, 1, 5)) * 255);
      data[i + 1] = Math.round(stretch(chan(u, v, 3, 4)) * 255);
      data[i + 2] = Math.round(stretch(chan(u, v, 0, 4)) * 255);
      data[i + 3] = Math.round(stretch(chan(u, v, 4, 3)) * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Expand value-noise contrast (it clusters around 0.5). */
function stretch(v: number): number {
  return Math.min(1, Math.max(0, (v - 0.5) * 1.9 + 0.5));
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** 2x2 atlas, 256 px cells: 0 smoke puff, 1 soft glow, 2 flame, 3 spark. Alpha carries the shape. */
export function makeParticleAtlas(): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S * 2, S * 2);
  const img = g.createImageData(S * 2, S * 2);
  const d = img.data;
  const rng = new Rng(4242);
  const sizes = [4, 8, 16, 32, 64];
  const ls = sizes.map((s) => lattice(s, rng));
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S, oy = Math.floor(cell / 2) * S;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S, v = (y + 0.5) / S;
        const dx = u - 0.5, dy = v - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy) * 2;
        const ang = Math.atan2(dy, dx);
        let a = 0, lum = 1;
        if (cell === 0) {
          // Billowy smoke: noisy radius + internal density variation.
          const n = fbm(ls, sizes, u + cell * 0.37, v, 4, 2);
          const edge = 0.8 + (n - 0.5) * 0.45;
          a = smooth(edge, edge - 0.62, r);
          const inner = fbm(ls, sizes, u * 1.7 + 0.21, v * 1.7, 4, 2);
          a *= (0.5 + inner * 0.65) * 0.9;
          lum = 0.72 + inner * 0.38 - dy * 0.35;
        } else if (cell === 1) {
          a = Math.pow(Math.max(0, 1 - r), 2.2);
          lum = 1;
        } else if (cell === 2) {
          // Flame blob: turbulent, bright core.
          const n = fbm(ls, sizes, u * 1.3 + 0.5, v * 1.3 + 0.1, 5, 2);
          const edge = 0.62 + (n - 0.5) * 0.7 + Math.sin(ang * 5) * 0.04;
          a = smooth(edge, edge - 0.5, r);
          lum = 0.55 + (1 - r) * 0.6 + (n - 0.5) * 0.4;
        } else {
          // Spark: tight core with a small halo.
          a = Math.max(Math.pow(Math.max(0, 1 - r * 2.2), 1.5), Math.pow(Math.max(0, 1 - r), 6) * 0.5);
          lum = 1;
        }
        const i = ((oy + y) * S * 2 + ox + x) * 4;
        const L = Math.round(Math.min(1, Math.max(0, lum)) * 255);
        d[i] = L;
        d[i + 1] = L;
        d[i + 2] = L;
        d[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
      }
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.premultiplyAlpha = false;
  return t;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 2x2 atlas, 256 px cells: 0 scorch, 1 crater, 2 track tread, 3 dirt splatter. RGB = color (sRGB), A = coverage. */
export function makeDecalAtlas(): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S * 2, S * 2);
  const img = g.createImageData(S * 2, S * 2);
  const d = img.data;
  const rng = new Rng(777);
  const sizes = [4, 8, 16, 32, 64];
  const ls = sizes.map((s) => lattice(s, rng));
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S, oy = Math.floor(cell / 2) * S;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S, v = (y + 0.5) / S;
        const dx = u - 0.5, dy = v - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy) * 2;
        const ang = Math.atan2(dy, dx);
        const n = fbm(ls, sizes, u + cell * 0.31, v + cell * 0.17, 5, 2);
        let rr = 30, gg = 26, bb = 22, a = 0;
        if (cell === 0) {
          // Scorch: ragged black burn with radial streaks.
          const streak = 0.5 + 0.5 * Math.sin(ang * 11 + n * 6);
          const edge = 0.55 + (n - 0.5) * 0.6 + streak * 0.18;
          a = smooth(edge, edge - 0.4, r) * 0.95;
          const k = 18 + n * 26;
          rr = k; gg = k * 0.92; bb = k * 0.85;
        } else if (cell === 1) {
          // Crater: dark pit, raised brown rim, ejecta rays.
          const rim = Math.exp(-Math.pow((r - 0.62) / 0.13, 2));
          const pit = smooth(0.62, 0.2, r);
          const ray = Math.pow(0.5 + 0.5 * Math.sin(ang * 9 + n * 5), 3) * smooth(1.0, 0.55, r);
          a = Math.min(1, pit * 0.95 + rim * 0.9 + ray * 0.5 * (0.6 + n)) * smooth(1.0, 0.85, r);
          const k = 20 + rim * 70 + n * 30;
          rr = k * 1.05; gg = k * 0.9; bb = k * 0.72;
        } else if (cell === 2) {
          // Track tread: repeating grousers across the strip (v along the track).
          const bar = (Math.sin(v * Math.PI * 16) > 0.15 ? 1 : 0.55);
          const side = smooth(0.5, 0.38, Math.abs(dx));
          a = side * (0.55 + 0.35 * bar) * (0.75 + n * 0.5);
          const k = 38 + n * 20;
          rr = k * 1.05; gg = k * 0.92; bb = k * 0.78;
        } else {
          const edge = 0.5 + (n - 0.5) * 0.9;
          a = smooth(edge, edge - 0.3, r) * 0.8;
          const k = 60 + n * 40;
          rr = k; gg = k * 0.85; bb = k * 0.65;
        }
        const i = ((oy + y) * S * 2 + ox + x) * 4;
        d[i] = rr;
        d[i + 1] = gg;
        d[i + 2] = bb;
        d[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
      }
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  return t;
}
