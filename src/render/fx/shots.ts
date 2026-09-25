// FRONT ULTRA — FX shots (owner: units).
//   nuke        hydrogen bomb on Paris mid-detonation: fireball, rising mushroom with rolling cap, shockwave ring
//               (&age=<seconds> picks the moment, default 9 s; &alt/&tilt/&heading/&lat/&lon move the camera)
//   nuke-flash  the same bomb 0.6 s after detonation (fireball + condensation dome + whiteout)
//   mirv        a MIRV salvo on a nation: warheads splitting mid-flight and a carpet of detonations
//   nuke-launch ICBMs climbing on their ballistic arcs with smoke trails (DEFCON-style arcs)

import type { GameContext } from '../../shared/api';
import { HUMAN_ID } from '../../shared/constants';
import { latLonToTile, worldTimeForSubsolarLon } from '../../shared/geo';
import { registerShot } from '../../shared/shots';
import { UnitType } from '../../shared/types';
import { fxInternal } from './index';

const at = (lat: number, lon: number) => latLonToTile(lat, lon);

/** Jump the effect clock so the most recent detonation is exactly `age` seconds old (deterministic, fast). */
async function waitNukeAge(ctx: GameContext, age: number, waitFrames: (n: number) => Promise<void>): Promise<void> {
  const fx = fxInternal(ctx);
  if (!fx) return;
  await waitFrames(1);
  const a = fx.latestNukeAge();
  if (a >= 0 && a < age) fx.advance(age - a);
}

async function nukeShot(ctx: GameContext, waitFrames: (n: number) => Promise<void>, params: URLSearchParams, defAge: number): Promise<void> {
  await ctx.app.startScriptedGame({ ticks: 600, speed: 0, autopilot: false, worldTimeSec: worldTimeForSubsolarLon(Number(params.get('sun') ?? 45)) });
  // A low, side-on cinematic framing (a held camera flight keeps tilts the free camera clamps at this altitude).
  const pose = {
    lat: Number(params.get('lat') ?? 50.2), lon: Number(params.get('lon') ?? 4.3),
    altitudeKm: Number(params.get('alt') ?? 1150), tilt: Number(params.get('tilt') ?? 1.47), heading: Number(params.get('heading') ?? 0.6),
  };
  ctx.cameraRig.setMode('cinematic');
  ctx.cameraRig.setState(pose);
  void ctx.cameraRig.flyTo(pose, 3_600_000);
  const fx = fxInternal(ctx);
  if (fx) fx.quietScreen = true;
  const detonated = ctx.bus.wait('nukeDetonated');
  const weapon = params.get('weapon') === 'atom' ? UnitType.AtomBomb : UnitType.HydrogenBomb;
  ctx.sim.debug({ type: 'launchNuke', weapon, owner: HUMAN_ID, fromTile: at(52.2, 14.5), targetTile: at(48.85, 2.35) });
  ctx.sim.setSpeed(1);
  await detonated;
  // Let the sim run on so the per-tile capture flashes of the blast settle, then freeze and set the moment.
  const age = Number(params.get('age') ?? defAge);
  if (age > 4) await new Promise((r) => setTimeout(r, 8000));
  ctx.sim.setSpeed(0);
  await waitNukeAge(ctx, Number(params.get('age') ?? defAge), waitFrames);
  await waitFrames(2);
}

registerShot('nuke', 'units', 'Hydrogen bomb detonation over Paris: fireball, mushroom cloud, shockwave ring', async ({ ctx, waitFrames, params }) => {
  await nukeShot(ctx, waitFrames, params, 6);
}, 3);

registerShot('nuke-flash', 'units', 'Hydrogen bomb over Paris 1.2 s after detonation: white-hot fireball, condensation dome, fading whiteout', async ({ ctx, waitFrames, params }) => {
  await nukeShot(ctx, waitFrames, params, 1.2);
  // The real whiteout decays in wall time; stage its tail explicitly so the frame is deterministic.
  ctx.post.flash(Number(params.get('flash') ?? 0.1), 60000);
}, 1);

registerShot('mirv', 'units', 'MIRV salvo: warheads splitting mid-flight over Europe, then a carpet of detonations', async ({ ctx, waitFrames, params }) => {
  await ctx.app.startScriptedGame({ ticks: 600, speed: 0, worldTimeSec: worldTimeForSubsolarLon(-10) });
  ctx.cameraRig.setState({ lat: 44.5, lon: 4.5, altitudeKm: Number(params.get('alt') ?? 2400), tilt: 0.75, heading: 0.2 });
  const fx = fxInternal(ctx);
  if (fx) fx.quietScreen = params.get('stage') !== 'split' && params.get('stage') !== null;
  ctx.sim.debug({ type: 'launchNuke', weapon: UnitType.Mirv, owner: HUMAN_ID, fromTile: at(40.4, -3.7), targetTile: at(50.5, 9.5) });
  ctx.sim.setSpeed(1);
  const stage = params.get('stage') ?? 'split';
  if (stage === 'split') {
    await ctx.bus.wait('unitSpawned', (e) => e.unit === UnitType.MirvWarhead);
    await new Promise((r) => setTimeout(r, Number(params.get('ms') ?? 700)));
  } else {
    await ctx.bus.wait('nukeDetonated');
    await new Promise((r) => setTimeout(r, 1200));
    ctx.sim.setSpeed(0);
    await waitNukeAge(ctx, Number(params.get('age') ?? 5), waitFrames);
  }
  ctx.sim.setSpeed(0);
  await waitFrames(3);
}, 3);

registerShot('nuke-launch', 'units', 'ICBMs on ballistic arcs with smoke trails', async ({ ctx, waitFrames }) => {
  await ctx.app.startScriptedGame({ ticks: 600, speed: 0, worldTimeSec: worldTimeForSubsolarLon(-5) });
  ctx.cameraRig.setState({ lat: 44, lon: 2, altitudeKm: 2600, tilt: 0.9, heading: 0.3 });
  ctx.sim.debug({ type: 'launchNuke', weapon: UnitType.HydrogenBomb, owner: HUMAN_ID, fromTile: at(40.4, -3.7), targetTile: at(52.5, 13.4) });
  ctx.sim.debug({ type: 'launchNuke', weapon: UnitType.AtomBomb, owner: HUMAN_ID, fromTile: at(38.0, -4.5), targetTile: at(45.5, 9.2) });
  ctx.sim.debug({ type: 'launchNuke', weapon: UnitType.AtomBomb, owner: HUMAN_ID, fromTile: at(41.5, -1.0), targetTile: at(51.5, -0.1) });
  ctx.sim.setSpeed(1);
  await new Promise((r) => setTimeout(r, 3500));
  ctx.sim.setSpeed(0);
  await waitFrames(3);
}, 3);
