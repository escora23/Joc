// FRONT ULTRA — globe shots (owner: globe). Deterministic beauty shots of the planet, territories, the menu
// composition and a low horizon view. Knobs: &lat= &lon= &alt= &tilt= &heading= &sun= (subsolar longitude).

import { HUMAN_ID } from '../../shared/constants';
import { latLonToTile, tileDistance, tileIndex, tileToLatLon, worldTimeForSubsolarLon } from '../../shared/geo';
import { UnitType } from '../../shared/types';
import { registerShot, type ShotContext } from '../../shared/shots';
import { setMenuWorldTimeOverride } from '../camera';
import { setGlobeWorldTimeOverride } from './index';

function num(params: URLSearchParams, key: string, def: number): number {
  const v = params.get(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Freeze the sun over a subsolar longitude for a planet-only shot (no session running). */
function freezeSun(s: ShotContext, subsolarLon: number): void {
  const t = worldTimeForSubsolarLon(num(s.params, 'sun', subsolarLon));
  setGlobeWorldTimeOverride(t);
  setMenuWorldTimeOverride(t);
}

function place(s: ShotContext, lat: number, lon: number, alt: number, tilt: number, heading: number): void {
  const p = s.params;
  s.ctx.cameraRig.setMode('cinematic');
  s.ctx.cameraRig.setState({
    lat: num(p, 'lat', lat), lon: num(p, 'lon', lon), altitudeKm: num(p, 'alt', alt),
    tilt: num(p, 'tilt', tilt), heading: num(p, 'heading', heading),
  });
}

registerShot('orbit', 'globe', 'Photoreal Earth from orbit, daylight over Africa/Europe, no UI', async (s) => {
  s.setUiVisible(false);
  freezeSun(s, 2);
  place(s, 22, 14, 17_500, 0, 0);
  await s.waitFrames(4);
}, 8);

registerShot('menu-bg', 'globe', 'Menu background composition (sun on the limb, crescent, city lights), no UI', async (s) => {
  s.setUiVisible(false);
  freezeSun(s, 20);
  s.ctx.cameraRig.setMode('menu');
  await s.waitFrames(4);
}, 8);

registerShot('night', 'globe', 'Night side: city lights and the day/night terminator over the Americas', async (s) => {
  s.setUiVisible(false);
  freezeSun(s, 35);
  place(s, 27, -82, 9_500, 0.12, 0);
  await s.waitFrames(4);
}, 8);

registerShot('territory', 'globe', 'Mid-game territories: nation colors, glowing borders, hot fronts, labels (Europe)', async (s) => {
  s.setUiVisible(false);
  await s.ctx.app.startScriptedGame({ ticks: num(s.params, 'tick', 3000), speed: 0, worldTimeSec: worldTimeForSubsolarLon(num(s.params, 'sun', 5)) });
  place(s, 47, 14, 4800, 0.18, 0);
  s.ctx.cameraRig.setMode('game');
  await s.waitFrames(4);
}, 8);

registerShot('territory-close', 'globe', 'Territory borders up close (~1300 km, tilted) with a hovered nation', async (s) => {
  s.setUiVisible(false);
  await s.ctx.app.startScriptedGame({ ticks: num(s.params, 'tick', 3000), speed: 0, worldTimeSec: worldTimeForSubsolarLon(num(s.params, 'sun', -10)) });
  place(s, 45, 6, 1300, 0.55, 0.2);
  s.ctx.cameraRig.setMode('game');
  const h = s.ctx.sim.view.human;
  if (h && h.capitalTile >= 0) s.ctx.globe.setHoverTile(h.capitalTile);
  await s.waitFrames(4);
}, 8);

registerShot('horizon', 'globe', 'Low horizon view over the Alps at golden hour (relief, haze, sky)', async (s) => {
  s.setUiVisible(false);
  freezeSun(s, -18);
  place(s, 46.3, 6.6, 150, 1.22, 1.95);
  await s.waitFrames(4);
}, 8);

registerShot('horizon-himalaya', 'globe', 'Low horizon view over the Himalayas in raking morning light', async (s) => {
  s.setUiVisible(false);
  freezeSun(s, 150);
  place(s, 27.2, 86.5, 110, 1.28, 0.1);
  await s.waitFrames(4);
}, 8);

registerShot('territory-war', 'globe', 'War up close: hot front lines, a fallout scar, capture flashes and the hover highlight', async (s) => {
  s.setUiVisible(false);
  const { ctx } = s;
  await ctx.app.startScriptedGame({ ticks: num(s.params, 'tick', 2400), speed: 0, worldTimeSec: worldTimeForSubsolarLon(num(s.params, 'sun', 0)) });
  const view = ctx.sim.view;
  const human = view.human;
  // Nuke the capital of the biggest rival within reach so a fallout scar is on screen.
  let target = -1, best = 0;
  if (human) {
    for (const p of view.playerList) {
      if (!p || p.id === HUMAN_ID || !p.alive || p.capitalTile < 0) continue;
      const d = tileDistance(human.capitalTile, p.capitalTile);
      if (d < 260 && p.tiles > best) {
        best = p.tiles;
        target = p.capitalTile;
      }
    }
  }
  if (human && target >= 0) {
    ctx.sim.debug({ type: 'launchNuke', weapon: UnitType.HydrogenBomb, owner: HUMAN_ID, fromTile: human.capitalTile, targetTile: target });
    await ctx.sim.fastForward(num(s.params, 'ff', 260));
    ctx.sim.setSpeed(0);
  }
  let focus = target >= 0 ? target : human?.capitalTile ?? latLonToTile(46, 8);
  if (s.params.get('focus') === 'front' && view.fronts.length) {
    const f = [...view.fronts].sort((a, b) => b.intensity * b.length - a.intensity * a.length)[0];
    focus = latLonToTile(tileToLatLon(tileIndex(Math.floor(f.x), Math.floor(f.y))).lat, tileToLatLon(tileIndex(Math.floor(f.x), Math.floor(f.y))).lon);
  }
  const ll = tileToLatLon(focus);
  place(s, ll.lat - 4, ll.lon, num(s.params, 'alt', 2600), 0.45, 0);
  ctx.cameraRig.setMode('game');
  ctx.globe.setHoverTile(focus);
  await s.waitFrames(6);
}, 8);
