// FRONT ULTRA — shot registry wiring (owner: app). Importing an owner's shots module registers its shots.
// Owners add shots only in their own `shots.ts`; app lists the modules here.
import '../ui/shots';
import '../data/shots';
import '../render/globe/shots';
import '../render/units/shots';
import '../render/fx/shots';
import '../render/battle/shots';
import '../command/shots';
import '../sim/ai/shots';
import { registerShot } from '../shared/shots';
import { latLonToTile, worldTimeForSubsolarLon } from '../shared/geo';

registerShot('midgame', 'app', 'Typical mid-game view with HUD (Iberia, ~37 game days in)', async ({ ctx, waitFrames }) => {
  // v2 (W1): 1 tick = 6 game minutes; the land rush fills the world by ~9,000 ticks.
  await ctx.app.startScriptedGame({ ticks: 9000, speed: 1 });
  ctx.cameraRig.setState({ lat: 41, lon: 0, altitudeKm: 4000, tilt: 0.3, heading: 0 });
  await waitFrames(45);
});

registerShot('world-events-3d', 'app', 'World events drawn on the globe: a hurricane off the Caribbean, an earthquake and a gold rush in the Americas', async ({ ctx, wait, waitFrames }) => {
  await ctx.app.startScriptedGame({ ticks: 1200, speed: 0, worldTimeSec: worldTimeForSubsolarLon(-70) });
  ctx.sim.debug({ type: 'worldEvent', kind: 'hurricane', tile: latLonToTile(21, -62) });
  ctx.sim.debug({ type: 'worldEvent', kind: 'earthquake', tile: latLonToTile(18.5, -72.3) });
  ctx.sim.debug({ type: 'worldEvent', kind: 'goldRush', tile: latLonToTile(5, -60) });
  // Let the events leave their warning stage and publish their renderable state.
  ctx.sim.setSpeed(4);
  const t0 = performance.now();
  while (performance.now() - t0 < 25_000 && ctx.sim.view.worldEvents.filter((e) => e.kind !== 'doomsday').length < 3) await wait(500);
  ctx.sim.setSpeed(0);
  ctx.cameraRig.setState({ lat: 12, lon: -66, altitudeKm: 4200, tilt: 0.25, heading: 0 });
  await waitFrames(20);
});

/** Called once by bootstrap; the imports above already registered everything. */
export function registerAllShots(): void {}
