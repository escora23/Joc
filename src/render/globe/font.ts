// FRONT ULTRA — signed-distance-field glyph atlas for nation labels (owner: globe).
// Rasterises the bundled Rajdhani Bold (OFL, @fontsource) with Canvas 2D at load, converts every glyph to an
// SDF with an exact Euclidean distance transform (Felzenszwalb), and exposes per-glyph metrics in em units.
// SDF text stays crisp at any size and gives us outlines and glows for free in the label shader.

import * as THREE from 'three';
import rajdhaniBold from '@fontsource/rajdhani/files/rajdhani-latin-700-normal.woff2?url';

export const LABEL_FONT_FAMILY = 'FU Globe Rajdhani';

export interface GlyphInfo {
  /** Advance in em. */
  adv: number;
  /** Quad bounds in em relative to the pen position on the baseline (y up). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Atlas uv rect (v = 0 at the top row, flipY = false). */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface SdfFont {
  texture: THREE.DataTexture;
  glyphs: Map<string, GlyphInfo>;
  /** Normalised SDF spread (fraction of the 0..1 range per em pixel), for shader smoothing. */
  spreadPx: number;
  fontPx: number;
  glyph(ch: string): GlyphInfo;
}

const CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ÁÉÍÓÚÜÑÇÀÈÌÒÙÂÊÎÔÛÄËÏÖÃÕÅØÆŒ .,-\'()&/:+%·#!?"';
const FONT_PX = 48;
const SPREAD = 8;
const CELL = 72;

async function loadFontFace(): Promise<string> {
  try {
    const face = new FontFace(LABEL_FONT_FAMILY, `url(${rajdhaniBold})`, { weight: '700' });
    await face.load();
    document.fonts.add(face);
    return `"${LABEL_FONT_FAMILY}"`;
  } catch (err) {
    console.warn('[globe] label font failed to load, falling back to system font', err);
    return 'sans-serif';
  }
}

// 1D squared distance transform (Felzenszwalb & Huttenlocher).
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

function edt2d(grid: Float64Array, w: number, h: number): void {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
}

export async function buildSdfFont(): Promise<SdfFont> {
  const family = await loadFontFace();
  const chars = [...new Set(CHARSET)];
  const cols = 14;
  const rows = Math.ceil(chars.length / cols);
  const W = cols * CELL, H = rows * CELL;
  const atlasW = THREE.MathUtils.ceilPowerOfTwo(W), atlasH = THREE.MathUtils.ceilPowerOfTwo(H);
  const atlas = new Uint8Array(atlasW * atlasH);

  const canvas = document.createElement('canvas');
  canvas.width = CELL;
  canvas.height = CELL;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('2D canvas unavailable');
  g.font = `700 ${FONT_PX}px ${family}`;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const baseline = Math.round(CELL * 0.7);
  const penX = SPREAD;
  const inside = new Float64Array(CELL * CELL), outside = new Float64Array(CELL * CELL);
  const INF = 1e20;
  const glyphs = new Map<string, GlyphInfo>();

  chars.forEach((ch, idx) => {
    g.clearRect(0, 0, CELL, CELL);
    g.fillStyle = '#000';
    g.fillRect(0, 0, CELL, CELL);
    g.fillStyle = '#fff';
    g.fillText(ch, penX, baseline);
    const m = g.measureText(ch);
    const img = g.getImageData(0, 0, CELL, CELL).data;
    for (let i = 0; i < CELL * CELL; i++) {
      const a = img[i * 4] / 255;
      // Sub-pixel edge offset from the anti-aliased coverage.
      if (a >= 0.999) {
        inside[i] = 0;
        outside[i] = INF;
      } else if (a <= 0.001) {
        inside[i] = INF;
        outside[i] = 0;
      } else {
        inside[i] = Math.pow(Math.max(0, 0.5 - a), 2);
        outside[i] = Math.pow(Math.max(0, a - 0.5), 2);
      }
    }
    edt2d(inside, CELL, CELL);
    edt2d(outside, CELL, CELL);
    const cx = (idx % cols) * CELL, cy = Math.floor(idx / cols) * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const i = y * CELL + x;
        const sd = Math.sqrt(outside[i]) - Math.sqrt(inside[i]); // > 0 inside the glyph
        const val = 0.5 + sd / (2 * SPREAD);
        atlas[(cy + y) * atlasW + cx + x] = Math.max(0, Math.min(255, Math.round(val * 255)));
      }
    }
    const adv = m.width / FONT_PX;
    glyphs.set(ch, {
      adv,
      x0: -penX / FONT_PX,
      x1: (CELL - penX) / FONT_PX,
      y0: -(CELL - baseline) / FONT_PX,
      y1: baseline / FONT_PX,
      u0: cx / atlasW,
      u1: (cx + CELL) / atlasW,
      v0: cy / atlasH,
      v1: (cy + CELL) / atlasH,
    });
  });

  const texture = new THREE.DataTexture(atlas, atlasW, atlasH, THREE.RedFormat, THREE.UnsignedByteType);
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  const space = glyphs.get(' ');
  const fallback = glyphs.get('?') ?? space!;
  return {
    texture,
    glyphs,
    spreadPx: SPREAD,
    fontPx: FONT_PX,
    glyph(ch) {
      const hit = glyphs.get(ch);
      if (hit) return hit;
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      return glyphs.get(base) ?? glyphs.get(base.toUpperCase()) ?? fallback;
    },
  };
}
