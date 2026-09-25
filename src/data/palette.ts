// FRONT ULTRA — nation color palette (owner: data). Worker-safe.
//
// 48 hand-picked nation colors that read well painted over the NASA Blue Marble (deep blue oceans, green/brown
// land, white ice) and against each other: saturated but not neon, mid lightness, spread over hue AND
// lightness so neighbouring nations never look alike. Every entry has an English/Spanish display name
// (setup screen color picker, tooltips).

import { colorDistance, hexToRgb, rgbToHex } from '../shared/color';

export interface PaletteColor {
  hex: number;
  en: string;
  es: string;
}

export const NATION_COLORS: readonly PaletteColor[] = [
  // Reds & pinks
  { hex: 0xd62839, en: 'Crimson', es: 'Carmesí' },
  { hex: 0xef5b3f, en: 'Vermilion', es: 'Bermellón' },
  { hex: 0x9b2335, en: 'Burgundy', es: 'Burdeos' },
  { hex: 0xe94f86, en: 'Rose', es: 'Rosa' },
  { hex: 0xff8fab, en: 'Flamingo', es: 'Flamenco' },
  { hex: 0xc2185b, en: 'Raspberry', es: 'Frambuesa' },
  // Oranges & browns
  { hex: 0xf57c1f, en: 'Tangerine', es: 'Mandarina' },
  { hex: 0xffa24a, en: 'Apricot', es: 'Albaricoque' },
  { hex: 0xb5541c, en: 'Rust', es: 'Óxido' },
  { hex: 0x8a5a3c, en: 'Chestnut', es: 'Castaño' },
  { hex: 0xd9a066, en: 'Caramel', es: 'Caramelo' },
  // Yellows
  { hex: 0xf5c518, en: 'Gold', es: 'Oro' },
  { hex: 0xffe066, en: 'Lemon', es: 'Limón' },
  { hex: 0xb8962e, en: 'Bronze', es: 'Bronce' },
  // Greens
  { hex: 0x9bd33d, en: 'Lime', es: 'Lima' },
  { hex: 0x2bb34a, en: 'Emerald', es: 'Esmeralda' },
  { hex: 0x0f6b3a, en: 'Forest', es: 'Bosque' },
  { hex: 0x6f8f2f, en: 'Olive', es: 'Oliva' },
  { hex: 0x5fe0a0, en: 'Mint', es: 'Menta' },
  { hex: 0x00a88f, en: 'Jade', es: 'Jade' },
  { hex: 0x1b7f79, en: 'Teal', es: 'Verde azulado' },
  // Cyans & blues
  { hex: 0x22c1c3, en: 'Turquoise', es: 'Turquesa' },
  { hex: 0x7fdcff, en: 'Ice blue', es: 'Azul hielo' },
  { hex: 0x3ea6f0, en: 'Sky', es: 'Celeste' },
  { hex: 0x2f6fd6, en: 'Royal blue', es: 'Azul real' },
  { hex: 0xff7a6b, en: 'Coral', es: 'Coral' },
  { hex: 0x5c7cfa, en: 'Cornflower', es: 'Aciano' },
  { hex: 0x7d97b8, en: 'Steel', es: 'Acero' },
  { hex: 0x9cbf7a, en: 'Sage', es: 'Salvia' },
  // Purples & magentas
  { hex: 0x7b2cbf, en: 'Violet', es: 'Violeta' },
  { hex: 0xa66cff, en: 'Lavender', es: 'Lavanda' },
  { hex: 0x6247c9, en: 'Indigo', es: 'Índigo' },
  { hex: 0x8e3b8a, en: 'Plum', es: 'Ciruela' },
  { hex: 0xd63aaf, en: 'Magenta', es: 'Magenta' },
  { hex: 0xf06bf0, en: 'Orchid', es: 'Orquídea' },
  { hex: 0x5e1f4f, en: 'Aubergine', es: 'Berenjena' },
  // Neutrals & specials
  { hex: 0x8c9eff, en: 'Periwinkle', es: 'Pervinca' },
  { hex: 0xa9b4c2, en: 'Silver', es: 'Plata' },
  { hex: 0x3d3d45, en: 'Graphite', es: 'Grafito' },
  { hex: 0x6d6875, en: 'Slate', es: 'Pizarra' },
  { hex: 0xc08fb0, en: 'Mauve', es: 'Malva' },
  { hex: 0xc9b8a0, en: 'Sand', es: 'Arena' },
  // Extra saturated accents
  { hex: 0xff3864, en: 'Cherry', es: 'Cereza' },
  { hex: 0x00d4b4, en: 'Aqua', es: 'Aguamarina' },
  { hex: 0xc6ff3d, en: 'Chartreuse', es: 'Chartreuse' },
  { hex: 0xff6f00, en: 'Blaze', es: 'Llama' },
  { hex: 0x2d9cdb, en: 'Azure', es: 'Azur' },
  { hex: 0x9d0208, en: 'Blood', es: 'Sangre' },
];

/** Typical Blue Marble open-ocean color: nation colors must stay clearly distinct from it. */
const OCEAN_RGB = 0x14305c;

/** Just the colors (0xRRGGBB). */
export const NATION_PALETTE: readonly number[] = NATION_COLORS.map((c) => c.hex);

/** Default human color (royal blue, the classic player color; the setup screen lets the player change it). */
export const DEFAULT_HUMAN_COLOR = 0x2f6fd6;

/** Index of the palette color nearest to `hex`. */
export function nearestPaletteIndex(hex: number, exclude?: ReadonlySet<number>): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < NATION_PALETTE.length; i++) {
    if (exclude?.has(i)) continue;
    const d = colorDistance(hex, NATION_PALETTE[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return best < 0 ? 0 : best;
}

/**
 * Pick `count` colors that are as distinct as possible from each other and from `avoid` (e.g. the human's color),
 * deterministic for a seed. Greedy farthest-point selection over the palette; beyond 48 it derives lighter/darker
 * variants.
 */
export function pickDistinctColors(count: number, seed = 1, avoid: readonly number[] = []): number[] {
  const out: number[] = [];
  const used = new Set<number>();
  const taken: number[] = [...avoid];
  let s = (seed >>> 0) || 1;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  while (out.length < count) {
    if (used.size >= NATION_PALETTE.length) {
      // Palette exhausted: derive variants of already used colors.
      const base = out[out.length % Math.max(1, NATION_PALETTE.length)] ?? NATION_PALETTE[0];
      const [r, g, b] = hexToRgb(base);
      const k = out.length % 2 === 0 ? 0.72 : 1.25;
      out.push(rgbToHex(Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k)));
      continue;
    }
    let best = -1, bd = -1;
    for (let i = 0; i < NATION_PALETTE.length; i++) {
      if (used.has(i)) continue;
      let dmin = 10;
      for (const t of taken) dmin = Math.min(dmin, colorDistance(t, NATION_PALETTE[i]));
      const score = dmin + rand() * 0.04;
      if (score > bd) { bd = score; best = i; }
    }
    used.add(best);
    taken.push(NATION_PALETTE[best]);
    out.push(NATION_PALETTE[best]);
  }
  return out;
}

/**
 * Graph-color the countries: every country gets a palette index distinct from its land neighbours (and, softly,
 * from its neighbours' neighbours), preferring its signature color when it has one. Deterministic.
 * `order` = country indices by priority (big countries first). Returns palette index per country index.
 */
export function assignCountryColors(
  countryCount: number,
  order: readonly number[],
  neighbors: readonly (readonly number[])[],
  preferred: (index: number) => number | undefined,
  /** Optional regional neighbours (kept apart softly, like neighbours-of-neighbours). */
  soft?: readonly (readonly number[])[],
): Int16Array {
  const res = new Int16Array(countryCount).fill(-1);
  const P = NATION_PALETTE.length;
  const usage = new Int32Array(P);
  for (const c of order) {
    const near = new Set<number>();
    const far = new Set<number>();
    for (const n of neighbors[c] ?? []) {
      if (res[n] >= 0) near.add(res[n]);
      for (const m of neighbors[n] ?? []) if (m !== c && res[m] >= 0) far.add(res[m]);
    }
    for (const m of soft?.[c] ?? []) if (m !== c && res[m] >= 0) far.add(res[m]);
    const pref = preferred(c);
    let best = 0, bs = -Infinity;
    for (let i = 0; i < P; i++) {
      const col = NATION_PALETTE[i];
      let dNear = 2, dFar = 2;
      for (const j of near) dNear = Math.min(dNear, colorDistance(col, NATION_PALETTE[j]));
      for (const j of far) dFar = Math.min(dFar, colorDistance(col, NATION_PALETTE[j]));
      if (near.has(i)) dNear = 0;
      // Hard rule: clearly distinct from every land neighbour. Then the signature color wins; then distance from
      // neighbours-of-neighbours and spreading usage over the whole palette.
      let score = (dNear < 0.13 ? -10 : 0) + Math.min(dNear, 0.28) * 2 + Math.min(dFar, 0.2) * 0.8 - (dFar < 0.08 ? 0.35 : 0) - usage[i] * 0.025;
      if (pref !== undefined) score -= colorDistance(col, pref) * 6;
      // Must read against the dark Blue Marble ocean (island nations, coasts).
      score -= Math.max(0, 0.3 - colorDistance(col, OCEAN_RGB)) * 8;
      // Deterministic tie-break.
      score += ((c * 31 + i * 17) % 97) * 1e-5;
      if (score > bs) { bs = score; best = i; }
    }
    res[c] = best;
    usage[best]++;
  }
  return res;
}
