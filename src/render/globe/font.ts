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

/** Private-use code points for the label icons drawn by code (DESIGN_V2 §10.10). */
export const GLYPH_STAR = '\uE000';
export const GLYPH_SWORDS = '\uE001';
export const GLYPH_HANDSHAKE = '\uE002';

const CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ÁÉÍÓÚÜÑÇÀÈÌÒÙÂÊÎÔÛÄËÏÖÃÕÅØÆŒ .,-\'()&/:+%·#!?"' + GLYPH_STAR + GLYPH_SWORDS + GLYPH_HANDSHAKE;

/** Draw one of the icon glyphs (white on black) into a CELL canvas; returns its advance in px. */
function drawIcon(g: CanvasRenderingContext2D, ch: string, penX: number, baseline: number): number {
  const em = FONT_PX;
  const cx = penX + em * 0.42, cy = baseline - em * 0.36;
  g.save();
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (ch === GLYPH_STAR) {
    const R = em * 0.4, r = R * 0.45;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? R : r;
      g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
  } else if (ch === GLYPH_SWORDS) {
    // Two crossed swords: blades, cross-guards and pommels.
    const L = em * 0.38;
    for (const s of [-1, 1]) {
      const dx = s * L * 0.72, dy = L * 0.72;
      g.lineWidth = em * 0.085;
      g.beginPath();
      g.moveTo(cx - dx, cy - dy);
      g.lineTo(cx + dx * 0.55, cy + dy * 0.55);
      g.stroke();
      // Guard (perpendicular), grip and pommel near the lower end.
      const gx = cx + dx * 0.55, gy = cy + dy * 0.55;
      const px = -dy / L, py = dx / L;
      g.lineWidth = em * 0.07;
      g.beginPath();
      g.moveTo(gx - px * em * 0.13, gy - py * em * 0.13);
      g.lineTo(gx + px * em * 0.13, gy + py * em * 0.13);
      g.stroke();
      g.lineWidth = em * 0.06;
      g.beginPath();
      g.moveTo(gx, gy);
      g.lineTo(cx + dx * 0.85, cy + dy * 0.85);
      g.stroke();
      g.beginPath();
      g.arc(cx + dx * 0.92, cy + dy * 0.92, em * 0.05, 0, Math.PI * 2);
      g.fill();
    }
  } else if (ch === GLYPH_HANDSHAKE) {
    // Two forearms meeting in a clasp.
    g.lineWidth = em * 0.13;
    g.beginPath();
    g.moveTo(cx - em * 0.42, cy + em * 0.16);
    g.lineTo(cx - em * 0.12, cy - em * 0.06);
    g.moveTo(cx + em * 0.42, cy + em * 0.16);
    g.lineTo(cx + em * 0.12, cy - em * 0.06);
    g.stroke();
    g.beginPath();
    g.ellipse(cx, cy - em * 0.02, em * 0.2, em * 0.13, 0, 0, Math.PI * 2);
    g.fill();
    // Knuckles: short strokes over the clasp.
    g.lineWidth = em * 0.045;
    g.strokeStyle = '#000';
    for (let i = -1; i <= 1; i++) {
      g.beginPath();
      g.moveTo(cx + i * em * 0.08, cy - em * 0.12);
      g.lineTo(cx + i * em * 0.08 + em * 0.04, cy + em * 0.05);
      g.stroke();
    }
  }
  g.restore();
  return em * 0.9;
}
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
    const isIcon = ch === GLYPH_STAR || ch === GLYPH_SWORDS || ch === GLYPH_HANDSHAKE;
    let advPx: number;
    if (isIcon) advPx = drawIcon(g, ch, penX, baseline);
    else {
      g.fillText(ch, penX, baseline);
      advPx = g.measureText(ch).width;
    }
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
    const adv = advPx / FONT_PX;
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
