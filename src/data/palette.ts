// FRONT ULTRA — nation colour palette (owner: data, reworked by W2 for DESIGN_V2 §10.2). Worker-safe.
//
// Every nation colour lives in OKLCH with lightness 0.60–0.82 and chroma ≥ 0.10: light and saturated enough to
// read over the dark Blue Marble ocean, green and brown land and white ice, and never a dark colour that looks
// like unowned land at night. Colours are assigned per game as a graph colouring: nations whose home countries
// border each other (directly, across a strait, or with capitals closer than 750 km) get hues at least 30° apart,
// and every AI hue stays at least 30° away from the human's colour, so no AI can ever share the human's hue.
// The human picks one of 16 readable presets (or a custom colour clamped to the same range).
// Rebels take their parent's hue rotated 25°; independent territories are muted (chroma 0.05, lightness 0.60).

import { hexToRgb, rgbToHex } from '../shared/color';

export interface PaletteColor {
  hex: number;
  en: string;
  es: string;
}

// -------------------------------------------------------------------------------------------------
// OKLab / OKLCH (Björn Ottosson), sRGB D65
// -------------------------------------------------------------------------------------------------

export interface Oklch {
  L: number;
  C: number;
  /** Hue in degrees 0..360. */
  h: number;
}

const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

export function hexToOklch(hex: number): Oklch {
  const [R, G, B] = hexToRgb(hex);
  const r = toLin(R / 255), g = toLin(G / 255), b = toLin(B / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(bb, a) * 180) / Math.PI;
  return { L, C: Math.hypot(a, bb), h: h < 0 ? h + 360 : h };
}

/** Linear sRGB of an OKLCH colour (may be out of gamut). */
function oklchToLinear(L: number, C: number, h: number, out: number[]): number[] {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return out;
}

const tmp3 = [0, 0, 0];
function inGamut(L: number, C: number, h: number): boolean {
  const c = oklchToLinear(L, C, h, tmp3);
  return c[0] >= -1e-4 && c[0] <= 1.0001 && c[1] >= -1e-4 && c[1] <= 1.0001 && c[2] >= -1e-4 && c[2] <= 1.0001;
}

/** Largest chroma displayable in sRGB at lightness L and hue h. */
export function maxChroma(L: number, h: number): number {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(L, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** OKLCH to 0xRRGGBB, chroma reduced into the sRGB gamut when needed. */
export function oklchToHex(L: number, C: number, h: number): number {
  const c = oklchToLinear(L, Math.min(C, maxChroma(L, h)), h, tmp3);
  const f = (v: number) => Math.round(Math.min(1, Math.max(0, toSrgb(Math.min(1, Math.max(0, v))))) * 255);
  return rgbToHex(f(c[0]), f(c[1]), f(c[2]));
}

/** Circular hue distance in degrees (0..180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

// -------------------------------------------------------------------------------------------------
// Rules (DESIGN_V2 §10.2)
// -------------------------------------------------------------------------------------------------

export const NATION_L_MIN = 0.6;
export const NATION_L_MAX = 0.82;
export const NATION_C_MIN = 0.1;
/** Minimum hue separation between bordering nations and between any AI and the human. */
export const HUE_GAP = 30;
/** Assignment margin over HUE_GAP so 8-bit rounding never breaks the rule. */
const HUE_MARGIN = 2;
/** Nations whose capitals are closer than this many tiles count as neighbours (750 km). */
const CAPITAL_NEIGHBOUR_TILES = 30;

/** Lightness levels used for nations (inside the range with margin). */
const LEVELS = [0.64, 0.71, 0.78];

/** A readable colour for hue h: the level whose sRGB chroma allows ≥ 0.12 (preferring `prefL`), chroma capped. */
function colourForHue(h: number, prefL = 0.71, cap = 0.17): { L: number; C: number; hex: number } {
  const order = [...LEVELS].sort((a, b) => Math.abs(a - prefL) - Math.abs(b - prefL));
  let best = { L: order[0], C: 0 };
  for (const L of order) {
    const C = Math.min(cap, maxChroma(L, h) * 0.94);
    if (C >= 0.12) {
      best = { L, C };
      break;
    }
    if (C > best.C) best = { L, C };
  }
  return { ...best, hex: oklchToHex(best.L, best.C, h) };
}

/** Clamp any colour into the nation range (custom human colours, legacy settings). */
export function clampNationColor(hex: number): number {
  const c = hexToOklch(hex);
  const L = Math.min(NATION_L_MAX - 0.02, Math.max(NATION_L_MIN + 0.02, c.L));
  const C = Math.max(NATION_C_MIN + 0.02, Math.min(0.2, c.C));
  const mc = maxChroma(L, c.h);
  if (mc < NATION_C_MIN + 0.01) return colourForHue(c.h, L).hex;
  return oklchToHex(L, Math.min(C, mc), c.h);
}

// -------------------------------------------------------------------------------------------------
// The human's 16 presets
// -------------------------------------------------------------------------------------------------

const PRESET_DEFS: readonly [number, number, string, string][] = [
  // hue, preferred lightness, English, Spanish
  [22, 0.66, 'Crimson', 'Carmesí'],
  [45, 0.7, 'Coral', 'Coral'],
  [62, 0.74, 'Orange', 'Naranja'],
  [82, 0.78, 'Amber', 'Ámbar'],
  [102, 0.8, 'Gold', 'Oro'],
  [124, 0.8, 'Lime', 'Lima'],
  [145, 0.74, 'Green', 'Verde'],
  [165, 0.72, 'Emerald', 'Esmeralda'],
  [188, 0.74, 'Turquoise', 'Turquesa'],
  [212, 0.72, 'Sky', 'Celeste'],
  [238, 0.66, 'Azure', 'Azur'],
  [264, 0.64, 'Royal blue', 'Azul real'],
  [288, 0.64, 'Violet', 'Violeta'],
  [312, 0.66, 'Purple', 'Púrpura'],
  [334, 0.68, 'Magenta', 'Magenta'],
  [356, 0.7, 'Rose', 'Rosa'],
];

/** The 16 human colour presets (setup screen swatches), all inside the nation range. */
export const HUMAN_PRESETS: readonly PaletteColor[] = PRESET_DEFS.map(([h, L, en, es]) => ({ hex: colourForHue(h, L, 0.19).hex, en, es }));

/** Setup swatches (kept under the v1 name). */
export const NATION_COLORS: readonly PaletteColor[] = HUMAN_PRESETS;

/**
 * Default human colour: orange. Blue presets remain available, but a blue fill over land reads as water from orbit
 * (AUDIT-1 D08), and a warm colour stands out on green, brown and blue alike.
 */
export const DEFAULT_HUMAN_COLOR = HUMAN_PRESETS[2].hex;

/** 48 general nation colours (debug maps, country suggestions): 24 hues × 2 lightness levels, all in range. */
export const NATION_PALETTE: readonly number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < 48; i++) {
    const h = ((i % 24) * 15 + (i >= 24 ? 7.5 : 0) + 20) % 360;
    out.push(colourForHue(h, i >= 24 ? 0.66 : 0.76).hex);
  }
  return out;
})();

/** Index of the preset nearest to `hex` (hue first, then lightness). */
export function nearestPaletteIndex(hex: number, exclude?: ReadonlySet<number>): number {
  const c = hexToOklch(hex);
  let best = 0, bd = Infinity;
  for (let i = 0; i < NATION_COLORS.length; i++) {
    if (exclude?.has(i)) continue;
    const p = hexToOklch(NATION_COLORS[i].hex);
    const d = hueDistance(c.h, p.h) / 180 + Math.abs(c.L - p.L);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// -------------------------------------------------------------------------------------------------
// Per-game nation colours: graph colouring of hues
// -------------------------------------------------------------------------------------------------

export interface NationColorInput {
  /** Home country (WorldData.countries index, 0 = none). */
  country: number;
  /** Capital / spawn tile (-1 unknown). */
  tile: number;
  /** Signature colour (e.g. PREFERRED_COLORS[iso3]) whose hue is preferred when free. */
  preferred?: number;
}

interface CountryRaster {
  width: number;
  height: number;
  country: Uint16Array;
  terrain?: Uint8Array;
}

const adjacencyCache = new WeakMap<object, Map<number, Set<number>>>();

/**
 * Country-to-country adjacency from the raster: direct land contact, plus contact across straits (land tiles of
 * two countries within 3 tiles of each other). Cached per world.
 */
export function countryAdjacency(world: CountryRaster): Map<number, Set<number>> {
  const hit = adjacencyCache.get(world.country);
  if (hit) return hit;
  const W = world.width, H = world.height, cty = world.country;
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (a <= 0 || b <= 0 || a === b) return;
    let s = adj.get(a);
    if (!s) adj.set(a, (s = new Set()));
    s.add(b);
    let t = adj.get(b);
    if (!t) adj.set(b, (t = new Set()));
    t.add(a);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = cty[y * W + x];
      if (a <= 0) continue;
      link(a, cty[y * W + ((x + 1) % W)]);
      if (y + 1 < H) link(a, cty[(y + 1) * W + x]);
    }
  }
  // Straits: coastal land tiles (a water neighbour) look up to 3 tiles away.
  const R = 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = cty[y * W + x];
      if (a <= 0) continue;
      const coastal = cty[y * W + ((x + 1) % W)] === 0 || cty[y * W + ((x + W - 1) % W)] === 0 || (y > 0 && cty[(y - 1) * W + x] === 0) || (y + 1 < H && cty[(y + 1) * W + x] === 0);
      if (!coastal) continue;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R * R) continue;
          const b = cty[yy * W + ((x + dx + W) % W)];
          if (b > 0 && b !== a) link(a, b);
        }
      }
    }
  }
  adjacencyCache.set(world.country, adj);
  return adj;
}

/** Neighbour lists between nations (indices into `nations`): bordering home countries or capitals < 750 km apart. */
export function nationNeighbors(world: CountryRaster, nations: readonly NationColorInput[]): number[][] {
  const adj = countryAdjacency(world);
  const W = world.width;
  const out: number[][] = nations.map(() => []);
  for (let i = 0; i < nations.length; i++) {
    for (let j = i + 1; j < nations.length; j++) {
      const a = nations[i], b = nations[j];
      let near = a.country > 0 && b.country > 0 && (a.country === b.country || adj.get(a.country)?.has(b.country) === true);
      if (!near && a.tile >= 0 && b.tile >= 0) {
        let dx = Math.abs((a.tile % W) - (b.tile % W));
        dx = Math.min(dx, W - dx);
        const dy = Math.floor(a.tile / W) - Math.floor(b.tile / W);
        near = dx * dx + dy * dy < CAPITAL_NEIGHBOUR_TILES * CAPITAL_NEIGHBOUR_TILES;
      }
      if (near) {
        out[i].push(j);
        out[j].push(i);
      }
    }
  }
  return out;
}

/**
 * Likely future neighbours: nations whose home countries both touch the same country that no nation starts in (the
 * land between them that both will expand into). Used as a soft constraint.
 */
export function nationSoftNeighbors(world: CountryRaster, nations: readonly NationColorInput[], hard: readonly (readonly number[])[]): number[][] {
  const adj = countryAdjacency(world);
  const home = new Set(nations.map((n) => n.country));
  const touching = new Map<number, number[]>();
  nations.forEach((n, i) => {
    for (const k of adj.get(n.country) ?? []) {
      if (home.has(k)) continue;
      let l = touching.get(k);
      if (!l) touching.set(k, (l = []));
      l.push(i);
    }
  });
  const out: Set<number>[] = nations.map(() => new Set());
  for (const l of touching.values()) {
    for (const i of l) for (const j of l) if (i !== j && !hard[i].includes(j)) out[i].add(j);
  }
  return out.map((s) => [...s]);
}

/**
 * Hues for `n` nations given their neighbour lists: bordering nations ≥ 30° apart, every hue ≥ 30° from the human's
 * hue, signature hues kept when possible, likely future neighbours (`soft`) and neighbours-of-neighbours spread
 * softly. DSATUR order, 2° candidate grid, then a repair pass. Deterministic.
 */
export function assignHues(
  n: number, neighbors: readonly (readonly number[])[], humanHue: number | null, preferredHue: (i: number) => number | undefined,
  soft: readonly (readonly number[])[] = [],
): number[] {
  const hue = new Array<number>(n).fill(NaN);
  const gap = HUE_GAP + HUE_MARGIN;
  const allowed = (h: number) => humanHue === null || hueDistance(h, humanHue) >= gap;
  const cands: number[] = [];
  for (let h = 0; h < 360; h += 2) if (allowed(h)) cands.push(h);
  const coloured = new Uint8Array(n);
  const conflictsAt = (i: number, h: number) => {
    let k = 0;
    for (const j of neighbors[i]) if (coloured[j] && hueDistance(h, hue[j]) < gap) k++;
    return k;
  };
  const choose = (i: number): number => {
    const pref = preferredHue(i);
    let best = cands[0], bs = -Infinity;
    for (const h of cands) {
      let minNb = 180, conflicts = 0;
      for (const j of neighbors[i]) {
        if (!coloured[j]) continue;
        const d = hueDistance(h, hue[j]);
        if (d < gap) conflicts++;
        minNb = Math.min(minNb, d);
      }
      let min2 = 180, softConf = 0, minSoft = 180;
      for (const j of neighbors[i]) for (const k of neighbors[j]) if (k !== i && coloured[k]) min2 = Math.min(min2, hueDistance(h, hue[k]));
      for (const j of soft[i] ?? []) {
        if (!coloured[j]) continue;
        const d = hueDistance(h, hue[j]);
        if (d < gap) softConf++;
        minSoft = Math.min(minSoft, d);
      }
      let same = 0;
      for (let k = 0; k < n; k++) if (coloured[k] && hueDistance(h, hue[k]) < 8) same++;
      let score = -conflicts * 100 - softConf * 3 + Math.min(minNb, 90) / 90 + (Math.min(min2, 40) / 40) * 0.6 + (Math.min(minSoft, 45) / 45) * 0.8 - same * 0.04;
      if (pref !== undefined) score -= (hueDistance(h, pref) / 180) * 1.6;
      // Cyan-to-azure fills read as water from orbit (AUDIT-1 D08): used only when nothing else fits.
      if (h >= 192 && h <= 250) score -= 0.9;
      score += ((i * 31 + h * 7) % 97) * 1e-6;
      if (score > bs) {
        bs = score;
        best = h;
      }
    }
    return best;
  };
  // DSATUR: most constrained first (distinct coloured neighbours), then most neighbours.
  for (let step = 0; step < n; step++) {
    let pick = -1, ps = -1;
    for (let i = 0; i < n; i++) {
      if (coloured[i]) continue;
      let sat = 0;
      for (const j of neighbors[i]) if (coloured[j]) sat++;
      const sc = sat * 1000 + neighbors[i].length;
      if (sc > ps) {
        ps = sc;
        pick = i;
      }
    }
    hue[pick] = choose(pick);
    coloured[pick] = 1;
  }
  // Repair: recolour any node still in conflict (rare), a few rounds.
  for (let round = 0; round < 6; round++) {
    let bad = 0;
    for (let i = 0; i < n; i++) {
      if (conflictsAt(i, hue[i]) === 0) continue;
      bad++;
      coloured[i] = 0;
      hue[i] = choose(i);
      coloured[i] = 1;
    }
    if (!bad) break;
  }
  return hue;
}

/**
 * Colours for the AI nations of one game (sim/ai/setup.ts calls this at setup, after the human chose a colour).
 * Returns 0xRRGGBB per nation, all inside the nation range.
 */
export function planNationColors(world: CountryRaster, nations: readonly NationColorInput[], humanColor: number | null): number[] {
  const neighbors = nationNeighbors(world, nations);
  const soft = nationSoftNeighbors(world, nations, neighbors);
  const humanHue = humanColor === null ? null : hexToOklch(humanColor).h;
  const hues = assignHues(nations.length, neighbors, humanHue, (i) => {
    const p = nations[i].preferred;
    return p === undefined ? undefined : hexToOklch(p).h;
  }, soft);
  // Lightness: spread neighbours whose hues are close, starting from each hue's natural level.
  const L: number[] = hues.map((h) => colourForHue(h).L);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < nations.length; i++) {
      let best = L[i], bs = -Infinity;
      for (const lv of LEVELS) {
        if (maxChroma(lv, hues[i]) * 0.94 < 0.115) continue;
        let s = 0;
        for (const j of neighbors[i]) {
          const hd = hueDistance(hues[i], hues[j]);
          if (hd < 70) s += Math.abs(lv - L[j]) * (1 - hd / 70);
        }
        s -= Math.abs(lv - colourForHue(hues[i]).L) * 0.3;
        if (s > bs) {
          bs = s;
          best = lv;
        }
      }
      L[i] = best;
    }
  }
  return hues.map((h, i) => oklchToHex(L[i], Math.min(0.17, maxChroma(L[i], h) * 0.94), h));
}

/**
 * `count` colours ≥ 30° of hue from `avoid` (e.g. the human's colour) and, when neighbour lists are given, from
 * their neighbours; without lists every colour is treated as bordering the previous ones in a ring. Deterministic
 * for a seed.
 */
export function pickDistinctColors(count: number, seed = 1, avoid: readonly number[] = [], neighbors?: readonly (readonly number[])[]): number[] {
  const nb: number[][] = [];
  for (let i = 0; i < count; i++) nb.push(neighbors ? [...neighbors[i]] : [(i + count - 1) % count, (i + 1) % count].filter((j) => j !== i));
  const humanHue = avoid.length ? hexToOklch(avoid[0]).h : null;
  const offset = ((seed >>> 0) % 360);
  const hues = assignHues(count, nb, humanHue, (i) => (offset + i * 137.508) % 360);
  return hues.map((h, i) => colourForHue(h, LEVELS[i % 3]).hex);
}

/** Rebels: the parent's hue rotated 25°, lightness 0.64. */
export function rebelColor(parent: number): number {
  const p = hexToOklch(parent);
  const h = (p.h + 25) % 360;
  return oklchToHex(0.64, Math.max(0.12, Math.min(0.17, maxChroma(0.64, h) * 0.94)), h);
}

/** Independent territories (v1 "tribes"): muted earth tones, chroma 0.05, lightness 0.60. r1, r2 in [0, 1). */
export function independentColor(r1: number, r2: number): number {
  return oklchToHex(0.6, 0.05, 45 + r1 * 60 + (r2 - 0.5) * 10);
}

/**
 * Graph-colour the countries (debug maps and country suggestions): every country gets a palette index whose hue is
 * ≥ 30° from its land neighbours. `order` = country indices by priority. Returns palette index per country index.
 */
export function assignCountryColors(
  countryCount: number,
  order: readonly number[],
  neighbors: readonly (readonly number[])[],
  preferred: (index: number) => number | undefined,
  soft?: readonly (readonly number[])[],
): Int16Array {
  const res = new Int16Array(countryCount).fill(-1);
  const P = NATION_PALETTE.length;
  const pHue = NATION_PALETTE.map((c) => hexToOklch(c).h);
  const usage = new Int32Array(P);
  for (const c of order) {
    const pref = preferred(c);
    const prefHue = pref === undefined ? undefined : hexToOklch(pref).h;
    let best = 0, bs = -Infinity;
    for (let i = 0; i < P; i++) {
      let dNear = 180, dFar = 180;
      for (const n of neighbors[c] ?? []) if (res[n] >= 0) dNear = Math.min(dNear, hueDistance(pHue[i], pHue[res[n]]));
      for (const m of soft?.[c] ?? []) if (m !== c && res[m] >= 0) dFar = Math.min(dFar, hueDistance(pHue[i], pHue[res[m]]));
      let score = (dNear < HUE_GAP ? -10 : 0) + Math.min(dNear, 60) / 30 + Math.min(dFar, 30) / 60 - usage[i] * 0.03;
      if (prefHue !== undefined) score -= (hueDistance(pHue[i], prefHue) / 180) * 3;
      score += ((c * 31 + i * 17) % 97) * 1e-5;
      if (score > bs) {
        bs = score;
        best = i;
      }
    }
    res[c] = best;
    usage[best]++;
  }
  return res;
}
