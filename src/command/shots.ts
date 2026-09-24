// FRONT ULTRA — command mode shots (owner: command). Stub stagers by the architect.
import { HUMAN_ID } from '../shared/constants';
import { latLonToTile } from '../shared/geo';
import { registerShot, type ShotContext } from '../shared/shots';
import { UnitType } from '../shared/types';

async function takeControl(s: ShotContext, unit: UnitType, lat: number, lon: number): Promise<void> {
  const { ctx } = s;
  await ctx.app.startScriptedGame({ ticks: 1200, speed: 1 });
  ctx.sim.debug({ type: 'spawnUnit', unit, owner: HUMAN_ID, tile: latLonToTile(lat, lon), targetTile: -1 });
  let id = -1;
  for (let i = 0; i < 600 && id < 0; i++) {
    await s.waitFrames(1);
    for (const u of ctx.sim.view.units.values()) if (u.owner === HUMAN_ID && u.type === unit) id = u.id;
  }
  if (id < 0) throw new Error('unit did not appear');
  await ctx.app.enterCommandMode(id);
}

registerShot('command-tank', 'command', 'Third-person tank battle at the front near the Pyrenees', async (s) => {
  await takeControl(s, UnitType.ArmoredDivision, 42.6, 0.5);
  await s.waitFrames(60);
});

registerShot('command-jet', 'command', 'Fighter jet dogfight above the front', async (s) => {
  await takeControl(s, UnitType.FighterSquadron, 43.5, 1.5);
  await s.waitFrames(60);
});

registerShot('command-ship', 'command', 'Warship naval battle in the western Mediterranean', async (s) => {
  await takeControl(s, UnitType.Warship, 38.5, 4.5);
  await s.waitFrames(60);
});
