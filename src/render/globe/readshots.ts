// FRONT ULTRA — map-readability shots (owner: globe, W2). Deterministic stagers for DESIGN_V2 §10 measurements:
// each one starts the seed-1337 scripted game, freezes the clock and places the camera at a fixed zoom, so
// tools/readability.mjs can capture the same frame with &territory=0, &clouds=hidden and &mask=owner and compare.
// Knobs: &tick= (staged ticks), &lat= &lon= &alt= &tilt= &heading= &sun= (subsolar longitude).

import { HUMAN_ID, MAP_H, MAP_W } from '../../shared/constants';
import { latLonToTile, worldTimeForSubsolarLon } from '../../shared/geo';
import { registerShot, type ShotContext } from '../../shared/shots';
import { isNavigableTerrain } from '../../shared/terrain';
import { UnitType } from '../../shared/types';

function num(params: URLSearchParams, key: string, def: number): number {
  const v = params.get(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

export interface ReadabilityView {
  lat: number;
  lon: number;
  alt: number;
  tilt?: number;
  heading?: number;
  /** Subsolar longitude (noon there). */
  sun: number;
  ticks?: number;
}

/** Start the standard staged game frozen at `ticks` and place the camera (game mode: strategic post, no CA). */
export async function stageReadability(s: ShotContext, v: ReadabilityView): Promise<void> {
  const p = s.params;
  await s.ctx.app.startScriptedGame({
    ticks: num(p, 'tick', v.ticks ?? 3000), speed: 0, worldTimeSec: worldTimeForSubsolarLon(num(p, 'sun', v.sun)),
  });
  s.ctx.cameraRig.setMode('game');
  s.ctx.cameraRig.setState({
    lat: num(p, 'lat', v.lat), lon: num(p, 'lon', v.lon), altitudeKm: num(p, 'alt', v.alt),
    tilt: num(p, 'tilt', v.tilt ?? 0), heading: num(p, 'heading', v.heading ?? 0),
  });
  await s.waitFrames(6);
}

registerShot('readability-europe', 'globe', 'Map readability: Europe at 3,000 km by day (DESIGN_V2 §10.1-10.3; measure with tools/readability.mjs)', async (s) => {
  await stageReadability(s, { lat: 47, lon: 8, alt: 3000, sun: 8 });
}, 20);

registerShot('readability-night', 'globe', 'Map readability: Europe at 3,000 km at night (DESIGN_V2 §10.4)', async (s) => {
  await stageReadability(s, { lat: 47, lon: 8, alt: 3000, sun: 8 - 180 });
}, 20);

registerShot('clouds-strategic', 'globe', 'Strategic clouds at 3,000 km: no cloud over the player, thin over other land (DESIGN_V2 §10.5)', async (s) => {
  await stageReadability(s, { lat: 43, lon: -2, alt: 3000, sun: -5 });
}, 20);

registerShot('labels-world', 'globe', 'Nation labels from 20,000 km with the HUD: no overlaps, none on the limb or under a panel (DESIGN_V2 §10.10)', async (s) => {
  await stageReadability(s, { lat: 22, lon: 18, alt: 20_000, sun: 18 });
  await s.wait(1200);
}, 20);

registerShot('icons-europe', 'units', 'NATO icons over Europe (&alt=6000 default, &alt=1500): frames by relation, glyphs, clusters (DESIGN_V2 §10.7)', async (s) => {
  await stageReadability(s, { lat: 44, lon: 4, alt: 6000, sun: 5, tilt: 0 });
}, 20);

registerShot('islands-caribbean', 'globe', 'Small-island markers over the Caribbean at 2,800 km (DESIGN_V2 §10.6)', async (s) => {
  await stageReadability(s, { lat: 16.5, lon: -68, alt: 2800, sun: -68 });
}, 20);

registerShot('islands-aegean', 'globe', 'Small-island markers over the Aegean at 2,600 km (DESIGN_V2 §10.6)', async (s) => {
  await stageReadability(s, { lat: 37.5, lon: 25, alt: 2600, sun: 25 });
}, 20);

/** Nearest navigable water tile to a lat/lon (for staging ships). */
function waterNear(s: ShotContext, lat: number, lon: number): number {
  const w = s.ctx.world;
  const t0 = latLonToTile(lat, lon);
  if (!w) return t0;
  const x0 = t0 % MAP_W, y0 = Math.floor(t0 / MAP_W);
  for (let r = 0; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const y = y0 + dy;
        if (y < 0 || y >= MAP_H) continue;
        const t = y * MAP_W + (((x0 + dx) % MAP_W) + MAP_W) % MAP_W;
        if (isNavigableTerrain(w.terrain[t])) return t;
      }
    }
  }
  return t0;
}

registerShot('routes-atlantic', 'units', 'Route lines: a Lisbon -> New York convoy with its line from departure and dashed path ahead, 100 trade ships and 10 AI warships (DESIGN_V2 §10.8; &ff= ticks sailed, &speed=)', async (s) => {
  const { ctx, params } = s;
  await ctx.app.startScriptedGame({ ticks: num(params, 'tick', 1200), speed: 0, worldTimeSec: worldTimeForSubsolarLon(num(params, 'sun', -40)) });
  const view = ctx.sim.view;
  const lisbon = waterNear(s, 38.6, -9.7), newYork = waterNear(s, 40.4, -73.6);
  ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.TransportShip, owner: HUMAN_ID, tile: lisbon, targetTile: newYork });
  // Traffic: 100 trade ships of the AI nations crossing the Atlantic and 10 AI warships.
  const ais = view.playerList.filter((p) => p.alive && p.kind === 'nation' && p.id !== HUMAN_ID).map((p) => p.id);
  let seed = 1337;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 110 && ais.length; i++) {
    const owner = ais[i % ais.length];
    const from = waterNear(s, 15 + rnd() * 40, -70 + rnd() * 55), to = waterNear(s, 15 + rnd() * 40, -70 + rnd() * 55);
    ctx.sim.debug({ type: 'spawnUnit', unit: i < 100 ? UnitType.TradeShip : UnitType.Warship, owner, tile: from, targetTile: to });
  }
  // Sail for a while (default 800 ticks = 80 h: 2,800 km of the 5,400 km crossing).
  const ff = num(params, 'ff', 800);
  if (ff > 0) await ctx.sim.fastForward(ff);
  ctx.sim.setSpeed(num(params, 'speed', 0) as 0 | 1 | 2 | 4);
  ctx.cameraRig.setMode('game');
  ctx.cameraRig.setState({ lat: num(params, 'lat', 38), lon: num(params, 'lon', -38), altitudeKm: num(params, 'alt', 7000), tilt: 0, heading: 0 });
  await s.waitFrames(8);
}, 20);
