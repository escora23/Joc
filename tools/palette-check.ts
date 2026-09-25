// FRONT ULTRA — palette acceptance check (W2, DESIGN_V2 §10.2, §16.3 acceptance 12).
// Runs the in-game colour planner (src/data/palette.ts planNationColors, the function sim/ai/setup.ts calls) for the
// 64 heaviest nations of the real world raster, once per human preset, and checks every rule:
//   * every colour (presets and AI) has OKLCH L in [0.60, 0.82] and C >= 0.10,
//   * bordering nations (home countries in contact, across straits, or capitals < 750 km) differ by >= 30° of hue,
//   * every AI hue is >= 30° from the human's colour,
//   * rebel and independent colours follow their rules (rebel L 0.64 hue +25°, independent C 0.05 L 0.60).
// Usage: npx tsx tools/palette-check.ts [--out shots/W2-map-readability/palette-check.json]
import fs from 'node:fs';
import path from 'node:path';
import {
  HUE_GAP, HUMAN_PRESETS, NATION_C_MIN, NATION_L_MAX, NATION_L_MIN, NATION_PALETTE, hexToOklch, hueDistance, independentColor,
  nationNeighbors, planNationColors, rebelColor,
} from '../src/data/palette';
import { PREFERRED_COLORS } from '../src/data/countries';
import { latLonToTile } from '../src/shared/geo';
// @ts-expect-error JS module without types (test tooling)
import { loadWorldInit } from '../src/sim/test/world.mjs';
import type { WorldInit } from '../src/shared/types';

const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? process.argv[outArg + 1] : 'shots/W2-map-readability/palette-check.json';
const world = (await loadWorldInit(() => undefined)) as WorldInit;

const inRange = (hex: number) => {
  const c = hexToOklch(hex);
  return c.L >= NATION_L_MIN - 1e-9 && c.L <= NATION_L_MAX + 1e-9 && c.C >= NATION_C_MIN;
};
const hex = (h: number) => `#${h.toString(16).padStart(6, '0')}`;

const human = world.countries.find((c) => c.iso3 === 'ESP');
const pool = world.countries
  .filter((c) => c.index > 0 && c.tiles > 12 && (c.capital.lat !== 0 || c.capital.lon !== 0) && c.index !== human?.index)
  .sort((a, b) => b.weight - a.weight || a.index - b.index)
  .slice(0, 64);
const nations = pool.map((c) => ({ country: c.index, tile: latLonToTile(c.capital.lat, c.capital.lon), preferred: PREFERRED_COLORS[c.iso3] }));
const neighbors = nationNeighbors(world, nations);
const edges = neighbors.reduce((s, l) => s + l.length, 0) / 2;

const failures: string[] = [];
for (const p of HUMAN_PRESETS) if (!inRange(p.hex)) failures.push(`preset ${p.en} ${hex(p.hex)} out of range`);
for (const c of NATION_PALETTE) if (!inRange(c)) failures.push(`palette ${hex(c)} out of range`);

const perPreset = HUMAN_PRESETS.map((p) => {
  const hh = hexToOklch(p.hex).h;
  const cols = planNationColors(world, nations, p.hex);
  let minNeighbour = 180, minHuman = 180, bad = 0;
  let minL = 1, maxL = 0, minC = 1;
  cols.forEach((c, i) => {
    const o = hexToOklch(c);
    minL = Math.min(minL, o.L);
    maxL = Math.max(maxL, o.L);
    minC = Math.min(minC, o.C);
    if (!inRange(c)) {
      bad++;
      failures.push(`${p.en}: ${pool[i].nameEn} ${hex(c)} L ${o.L.toFixed(3)} C ${o.C.toFixed(3)}`);
    }
    const dh = hueDistance(o.h, hh);
    minHuman = Math.min(minHuman, dh);
    if (dh < HUE_GAP) failures.push(`${p.en}: ${pool[i].nameEn} hue ${o.h.toFixed(1)} only ${dh.toFixed(1)}° from the human`);
    for (const j of neighbors[i]) {
      if (j < i) continue;
      const d = hueDistance(o.h, hexToOklch(cols[j]).h);
      minNeighbour = Math.min(minNeighbour, d);
      if (d < HUE_GAP) failures.push(`${p.en}: ${pool[i].nameEn} / ${pool[j].nameEn} hues ${d.toFixed(1)}° apart`);
    }
  });
  return { preset: p.en, human: hex(p.hex), minNeighbourHueGap: +minNeighbour.toFixed(1), minHueGapToHuman: +minHuman.toFixed(1), minL: +minL.toFixed(3), maxL: +maxL.toFixed(3), minC: +minC.toFixed(3), outOfRange: bad };
});

// Rebels and independent territories.
const rebels = NATION_PALETTE.map((c) => {
  const r = hexToOklch(rebelColor(c)), pc = hexToOklch(c);
  return { dh: hueDistance(r.h, (pc.h + 25) % 360), L: r.L, C: r.C };
});
const rebelOk = rebels.every((r) => r.dh < 2 && Math.abs(r.L - 0.64) < 0.01 && r.C >= NATION_C_MIN);
if (!rebelOk) failures.push('rebel colours off rule');
const indep = [0, 0.25, 0.5, 0.75, 0.99].map((r) => hexToOklch(independentColor(r, 0.5)));
const indepOk = indep.every((c) => Math.abs(c.L - 0.6) < 0.01 && Math.abs(c.C - 0.05) < 0.01);
if (!indepOk) failures.push('independent colours off rule');

const report = {
  nations: pool.length, neighbourPairs: edges, presets: perPreset, rebelOk, independentOk: indepOk,
  pass: failures.length === 0, failures: failures.slice(0, 50),
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, presets: perPreset.map((p) => `${p.preset}: gap ${p.minNeighbourHueGap}°, human ${p.minHueGapToHuman}°, L ${p.minL}-${p.maxL}, C>=${p.minC}`) }, null, 2));
process.exit(failures.length ? 1 : 0);
