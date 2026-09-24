// FRONT ULTRA — globe shots (owner: globe). Stub stagers by the architect; the globe owner refines them.
import { worldTimeForSubsolarLon } from '../../shared/geo';
import { registerShot } from '../../shared/shots';

registerShot('orbit', 'globe', 'Photoreal Earth from orbit, daylight over Africa/Europe, no UI', async ({ ctx, waitFrames, setUiVisible }) => {
  setUiVisible(false);
  ctx.cameraRig.setMode('cinematic');
  ctx.cameraRig.setState({ lat: 18, lon: 12, altitudeKm: 19_000, tilt: 0, heading: 0 });
  await waitFrames(30);
});

registerShot('night', 'globe', 'Night side with city lights and the day/night terminator over Europe', async ({ ctx, waitFrames, setUiVisible }) => {
  setUiVisible(false);
  await ctx.app.startScriptedGame({ ticks: 600, speed: 0, worldTimeSec: worldTimeForSubsolarLon(-75) });
  ctx.cameraRig.setMode('cinematic');
  ctx.cameraRig.setState({ lat: 45, lon: 10, altitudeKm: 9000, tilt: 0.2, heading: 0 });
  await waitFrames(30);
});

registerShot('territory', 'globe', 'Mid-game territories: nation colors, glowing borders, labels (Europe)', async ({ ctx, waitFrames, setUiVisible }) => {
  setUiVisible(false);
  await ctx.app.startScriptedGame({ ticks: 3000, speed: 0 });
  ctx.cameraRig.setState({ lat: 46, lon: 12, altitudeKm: 5000, tilt: 0.15, heading: 0 });
  await waitFrames(30);
});
