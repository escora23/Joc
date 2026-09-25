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

registerShot('midgame', 'app', 'Typical mid-game view with HUD (Iberia, ~5 game minutes in)', async ({ ctx, waitFrames }) => {
  await ctx.app.startScriptedGame({ ticks: 3000, speed: 1 });
  ctx.cameraRig.setState({ lat: 41, lon: 0, altitudeKm: 4000, tilt: 0.3, heading: 0 });
  await waitFrames(45);
});

/** Called once by bootstrap; the imports above already registered everything. */
export function registerAllShots(): void {}
