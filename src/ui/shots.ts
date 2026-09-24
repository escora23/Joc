// FRONT ULTRA — UI shots (owner: ui). Stub stagers by the architect; the ui owner refines them.
import { HUMAN_ID } from '../shared/constants';
import { registerShot } from '../shared/shots';

registerShot('loading', 'ui', 'Cinematic loading screen frozen at ~62%', async ({ ctx, waitFrames }) => {
  ctx.ui.showLoading().setProgress(0.62, 'loading.shaders');
  await waitFrames(10);
});

registerShot('menu', 'ui', 'Main menu over the slowly rotating Earth', async ({ waitFrames }) => {
  await waitFrames(30);
});

registerShot('setup', 'ui', 'Skirmish setup screen', async ({ ctx, waitFrames }) => {
  ctx.app.goto('setup');
  await waitFrames(20);
});

registerShot('spawn', 'ui', 'Spawn phase: AI nations placed, human choosing a capital over Europe', async ({ ctx, waitFrames }) => {
  await ctx.app.startScriptedGame({ humanSpawn: null, stayInSpawn: true });
  ctx.cameraRig.setState({ lat: 38, lon: 8, altitudeKm: 11_000, tilt: 0, heading: 0 });
  await waitFrames(40);
});

registerShot('hud', 'ui', 'Full in-game HUD mid-game (panels, leaderboard, ticker)', async ({ ctx, waitFrames }) => {
  await ctx.app.startScriptedGame({ ticks: 1500, speed: 0 });
  ctx.cameraRig.setState({ lat: 41, lon: 2, altitudeKm: 3500, tilt: 0.3, heading: 0 });
  await waitFrames(30);
});

registerShot('end', 'ui', 'Victory screen with stats, territory graph and timelapse', async ({ ctx, waitFrames }) => {
  await ctx.app.startScriptedGame({ ticks: 1500 });
  const ended = ctx.app.state === 'ended' ? Promise.resolve() : ctx.bus.wait('appState', (e) => e.state === 'ended');
  ctx.sim.debug({ type: 'endGame', winner: HUMAN_ID, reason: 'domination' });
  await ended;
  await waitFrames(30);
});
