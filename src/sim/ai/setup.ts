// FRONT ULTRA — AI world setup: real nations at their capitals, and neutral tribes (owner: sim-ai). Worker-only.
//
// Nations are drawn from WorldData.countries by geopolitical weight (the great powers nearly always play, a few
// surprises every game), spawn at their real capital, get a signature color that stays distinct from their
// neighbours and from the human, and a personality from a balanced deck. Tribes fill empty land far from every
// capital: small, earthy-colored clans with regional names that grab land early and are easy prey later.

import { HUMAN_ID, MAP_W, TILE_COUNT } from '../../shared/constants';
import { latLonToTile } from '../../shared/geo';
import type { Rng } from '../../shared/rng';
import type { SimGame } from '../../shared/simapi';
import type { CountryDef, Personality } from '../../shared/types';
import { independentColor, planNationColors } from '../../data/palette';
import { PREFERRED_COLORS } from '../../data/countries';
import { dist2, tileAt, tx, ty, type MapIndex } from './mapindex';
import { personalityDeck } from './profiles';

export interface SetupResult {
  nations: { id: number; personality: Personality }[];
  tribes: number[];
}

/** Built-in capitals when the world data carries none (tests with synthetic worlds). */
const FALLBACK_CAPITALS: [string, number, number, number][] = [
  ['United States of America', 38.9, -77.0, 1], ['China', 39.9, 116.4, 1], ['Russia', 55.75, 37.6, 0.9],
  ['India', 28.6, 77.2, 0.9], ['Brazil', -15.8, -47.9, 0.8], ['Germany', 52.5, 13.4, 0.8], ['France', 48.86, 2.35, 0.8],
  ['United Kingdom', 51.5, -0.13, 0.8], ['Japan', 35.7, 139.7, 0.8], ['Italy', 41.9, 12.5, 0.7], ['Canada', 45.4, -75.7, 0.7],
  ['Australia', -35.3, 149.1, 0.7], ['Mexico', 19.4, -99.1, 0.6], ['Indonesia', -6.2, 106.8, 0.6], ['Turkey', 39.9, 32.9, 0.6],
  ['Saudi Arabia', 24.7, 46.7, 0.6], ['Argentina', -34.6, -58.4, 0.5], ['South Africa', -25.7, 28.2, 0.5],
  ['Egypt', 30.0, 31.2, 0.5], ['Iran', 35.7, 51.4, 0.5], ['Nigeria', 9.1, 7.5, 0.5], ['Spain', 40.4, -3.7, 0.6],
  ['Poland', 52.2, 21.0, 0.5], ['Ukraine', 50.45, 30.5, 0.4], ['Pakistan', 33.7, 73.0, 0.5], ['Kazakhstan', 51.2, 71.4, 0.4],
  ['Ethiopia', 9.0, 38.75, 0.4], ['Colombia', 4.7, -74.1, 0.4], ['Peru', -12.05, -77.0, 0.35], ['Algeria', 36.75, 3.06, 0.4],
  ['Sweden', 59.3, 18.07, 0.4], ['Mongolia', 47.9, 106.9, 0.25], ['Thailand', 13.75, 100.5, 0.45], ['Vietnam', 21.0, 105.85, 0.4],
  ['Chile', -33.45, -70.67, 0.35], ['Venezuela', 10.5, -66.9, 0.3], ['Kenya', -1.3, 36.8, 0.3], ['Norway', 59.9, 10.75, 0.4],
  ['Sudan', 15.5, 32.5, 0.25], ['Angola', -8.8, 13.2, 0.25], ['Madagascar', -18.9, 47.5, 0.2], ['Iraq', 33.3, 44.4, 0.3],
  ['New Zealand', -41.3, 174.8, 0.3], ['Morocco', 34.0, -6.85, 0.3], ['Philippines', 14.6, 121.0, 0.4], ['South Korea', 37.57, 126.98, 0.6],
];

/** Tribe name syllables by region (fictional, language-neutral proper names). */
const TRIBE_NAMES: Record<string, [string[], string[]]> = {
  africa: [['Nda', 'Kwe', 'Ma', 'Zu', 'Ba', 'Tsho', 'Olu', 'Ki', 'Amo', 'Se'], ['ba', 'nga', 'lu', 'nde', 'mbe', 'wena', 'kossi', 'tamba', 'ro']],
  americas: [['Qui', 'Ta', 'Hua', 'Ay', 'Chi', 'Wa', 'Ixa', 'Mo', 'Tla', 'Ca'], ['lca', 'huan', 'mara', 'kota', 'pec', 'yuma', 'naco', 'tzin', 'rú']],
  asia: [['Khor', 'Ars', 'Tem', 'Bay', 'Kha', 'Ul', 'Sar', 'Tu', 'Ong', 'Bor'], ['lan', 'ghun', 'tai', 'jin', 'dash', 'khan', 'mar', 'suk', 'ri']],
  europe: [['Var', 'Kel', 'Ost', 'Bri', 'Dru', 'Sva', 'Hal', 'Ger', 'Lug', 'Ar'], ['gard', 'tic', 'mund', 'veni', 'rik', 'ovi', 'stad', 'auri', 'ni']],
  oceania: [['Wi', 'Ta', 'Ko', 'Mau', 'Pa', 'Nga', 'Yo', 'Ari', 'Ku', 'Ra'], ['rri', 'noa', 'lu', 'kai', 'wera', 'mbo', 'tahi', 'rua', 'ki']],
};

function regionOf(lat: number, lon: number): keyof typeof TRIBE_NAMES {
  if (lon < -30) return 'americas';
  if (lat < -10 && lon > 110) return 'oceania';
  if (lon > 55 || (lat > 50 && lon > 40)) return 'asia';
  if (lat < 36 && lon > -20 && lon < 55) return 'africa';
  return 'europe';
}

export function tileLatLon(t: number): { lat: number; lon: number } {
  return { lat: 90 - ((ty(t) + 0.5) / 800) * 180, lon: ((tx(t) + 0.5) / MAP_W) * 360 - 180 };
}

/** Nearest free playable tile to `tile` (same country preferred), keeping `minDist` from `avoid` tiles. */
function findSpawn(g: SimGame, tile: number, country: number, avoid: readonly number[], minDist: number, maxR: number, human = -1): number {
  const cx = tx(tile), cy = ty(tile);
  const md2 = minDist * minDist;
  let fallback = -1;
  for (let r = 0; r <= maxR; r++) {
    const steps = Math.max(1, Math.round(r * 6.3));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const t = tileAt(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      if (t < 0 || !g.isPlayable(t) || g.ownerOf(t) !== 0) continue;
      let ok = true;
      for (const o of avoid) if (dist2(o, t) < md2) { ok = false; break; }
      if (!ok || (human >= 0 && dist2(human, t) < 18 * 18)) continue;
      if (country <= 0 || g.world.country[t] === country) return t;
      if (fallback < 0) fallback = t;
    }
    if (fallback >= 0 && r > 8) return fallback;
  }
  return fallback;
}

export function setupWorld(g: SimGame, rng: Rng, index: MapIndex): SetupResult {
  const res: SetupResult = { nations: [], tribes: [] };
  const w = g.world;
  const count = Math.max(0, Math.min(64, g.config.aiCount | 0));
  const humanTile = g.config.autoSpawnTile;
  const humanCountry = humanTile >= 0 && humanTile < TILE_COUNT ? w.country[humanTile] : 0;
  const humanColor = g.player(HUMAN_ID)?.color ?? g.config.playerColor;

  type Pick = { name: string; country: number; lat: number; lon: number; weight: number; iso3: string };
  const picks: Pick[] = [];
  const pool: CountryDef[] = w.countries.filter((c) => c.index > 0 && c.tiles > 12 && (c.capital.lat !== 0 || c.capital.lon !== 0) && c.index !== humanCountry);
  if (pool.length >= count) {
    const chosen = new Set<number>();
    while (picks.length < count && chosen.size < pool.length) {
      const avail = pool.filter((c) => !chosen.has(c.index));
      // Great powers nearly always play; mid-size countries fill the rest; micro-states are rare.
      const c = rng.pickWeighted(avail, (x) => 0.04 + x.weight * x.weight * 5 + Math.min(1.2, x.tiles / 3500));
      chosen.add(c.index);
      picks.push({ name: c.nameEn, country: c.index, lat: c.capital.lat, lon: c.capital.lon, weight: c.weight, iso3: c.iso3 });
    }
  } else {
    for (const [name, lat, lon, weight] of FALLBACK_CAPITALS.slice(0, count)) {
      const country = w.countries.findIndex((c) => c.nameEn === name);
      picks.push({ name, country: Math.max(0, country), lat, lon, weight, iso3: country > 0 ? w.countries[country].iso3 : '' });
    }
  }
  // Big nations spawn first.
  picks.sort((a, b) => b.weight - a.weight || a.country - b.country);
  const deck = personalityDeck(picks.length, () => rng.next());
  // Colours (DESIGN_V2 §10.2): a hue graph colouring over bordering home countries, every hue ≥ 30° from the
  // human's colour, signature hues kept where they fit. Planned from the capitals before anyone spawns.
  const colors = planNationColors(
    w, picks.map((pk) => ({ country: pk.country, tile: latLonToTile(pk.lat, pk.lon), preferred: PREFERRED_COLORS[pk.iso3] })), humanColor,
  );
  const avoid: number[] = [];
  const human = humanTile >= 0 && humanTile < TILE_COUNT ? humanTile : -1;
  picks.forEach((pk, i) => {
    let tile = findSpawn(g, latLonToTile(pk.lat, pk.lon), pk.country, avoid, 8, 45, human);
    for (let k = 0; k < 6 && tile < 0; k++) tile = findSpawn(g, index.randomPlayable(rng), 0, avoid, 8, 30, human);
    const color = colors[i];
    const personality = deck[i];
    const id = g.addPlayer({ name: pk.name, kind: 'nation', personality, color, countryIndex: pk.country });
    if (id <= 0) return;
    res.nations.push({ id, personality });
    if (tile >= 0 && g.issue(id, { type: 'spawn', tile })) avoid.push(tile);
  });

  // Tribes: empty land far from every capital, spread out.
  const tribes = Math.max(0, Math.min(120, g.config.tribeCount | 0));
  const tribeTiles: number[] = [];
  for (let i = 0; i < tribes; i++) {
    let tile = -1;
    for (let k = 0; k < 500 && tile < 0; k++) {
      const t = index.randomPlayable(rng);
      const { lat } = tileLatLon(t);
      if (lat > 68 || lat < -48 || g.ownerOf(t) !== 0) continue;
      let clear = true;
      for (const a of avoid) if (dist2(a, t) < 16 * 16) { clear = false; break; }
      if (clear && human >= 0 && dist2(human, t) < 16 * 16) clear = false;
      if (clear) for (const a of tribeTiles) if (dist2(a, t) < 11 * 11) { clear = false; break; }
      if (clear) tile = t;
    }
    if (tile < 0) continue;
    const { lat, lon } = tileLatLon(tile);
    const [pre, post] = TRIBE_NAMES[regionOf(lat, lon)];
    const name = rng.pick(pre) + rng.pick(post);
    // Independent territories: muted earth tones (three draws, as in v1, so the rng stream is unchanged).
    const r1 = rng.int(38) / 38, r2 = rng.next();
    rng.next();
    const color = independentColor(r1, r2);
    const id = g.addPlayer({ name, kind: 'tribe', personality: null, color, countryIndex: 0 });
    if (id <= 0) continue;
    if (g.issue(id, { type: 'spawn', tile })) {
      tribeTiles.push(tile);
      res.tribes.push(id);
    }
  }
  return res;
}
