// FRONT ULTRA — FX shots (owner: units). Stub stager by the architect.
import { HUMAN_ID } from '../../shared/constants';
import { latLonToTile } from '../../shared/geo';
import { registerShot } from '../../shared/shots';
import { UnitType } from '../../shared/types';

registerShot('nuke', 'units', 'Hydrogen bomb detonation over Paris: fireball, mushroom cloud, shockwave', async ({ ctx, waitFrames, params }) => {
  await ctx.app.startScriptedGame({ ticks: 900, speed: 1 });
  ctx.cameraRig.setState({ lat: 45.5, lon: 2.3, altitudeKm: 1800, tilt: 0.75, heading: 0 });
  await waitFrames(5);
  const detonated = ctx.bus.wait('nukeDetonated');
  ctx.sim.debug({ type: 'launchNuke', weapon: UnitType.HydrogenBomb, owner: HUMAN_ID, fromTile: latLonToTile(40.4, -3.7), targetTile: latLonToTile(48.85, 2.35) });
  await detonated;
  await waitFrames(Number(params.get('after') ?? 45));
}, 0);
