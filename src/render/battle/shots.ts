// FRONT ULTRA — ground battle shots (owner: battle). Stub stagers by the architect.
import { tileXYToLatLon } from '../../shared/geo';
import { registerShot, type ShotContext } from '../../shared/shots';

async function toHottestFront(s: ShotContext, altitudeKm: number, tilt: number): Promise<void> {
  const { ctx } = s;
  await ctx.app.startScriptedGame({ ticks: 2400, speed: 1 });
  await s.waitFrames(10);
  const f = [...ctx.sim.view.fronts].sort((a, b) => b.intensity - a.intensity)[0];
  const ll = f ? tileXYToLatLon(f.x, f.y) : { lat: 45, lon: 5 };
  ctx.cameraRig.setState({ lat: ll.lat, lon: ll.lon, altitudeKm, tilt, heading: 0.4 });
}

registerShot('front', 'battle', 'Ground level over the hottest front: infantry, tanks, artillery, explosions', async (s) => {
  await toHottestFront(s, 2.5, 1.3);
  await s.waitFrames(60);
});

registerShot('front-wide', 'battle', 'Medium altitude over an active front: hot front line + battle layer fading in', async (s) => {
  await toHottestFront(s, 250, 0.9);
  await s.waitFrames(45);
});
