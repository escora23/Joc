// FRONT ULTRA — map-readability shots (owner: globe, W2). Deterministic stagers for DESIGN_V2 §10 measurements:
// each one starts the seed-1337 scripted game, freezes the clock and places the camera at a fixed zoom, so
// tools/readability.mjs can capture the same frame with &territory=0, &clouds=hidden and &mask=owner and compare.
// Knobs: &tick= (staged ticks), &lat= &lon= &alt= &tilt= &heading= &sun= (subsolar longitude).

import { worldTimeForSubsolarLon } from '../../shared/geo';
import { registerShot, type ShotContext } from '../../shared/shots';

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
