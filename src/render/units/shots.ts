// FRONT ULTRA — units & structures shots (owner: units). Stub stagers by the architect.
import { HUMAN_ID } from '../../shared/constants';
import { latLonToTile } from '../../shared/geo';
import { registerShot } from '../../shared/shots';
import { STRUCTURE_TYPES, UnitType } from '../../shared/types';

registerShot('units', 'units', 'Ships with wakes, jets with contrails, missiles in flight over the Mediterranean', async ({ ctx, waitFrames }) => {
  await ctx.app.startScriptedGame({ ticks: 900, speed: 1 });
  const at = (lat: number, lon: number) => latLonToTile(lat, lon);
  const spawn = (unit: UnitType, from: [number, number], to: [number, number]) =>
    ctx.sim.debug({ type: 'spawnUnit', unit, owner: HUMAN_ID, tile: at(...from), targetTile: at(...to) });
  spawn(UnitType.Warship, [37.5, 3], [40, 8]);
  spawn(UnitType.Warship, [36.8, 5], [39, 12]);
  spawn(UnitType.TransportShip, [38.5, 1], [41, 9]);
  spawn(UnitType.TradeShip, [35.5, -5], [36, 14]);
  spawn(UnitType.FighterSquadron, [40.4, -3.7], [44, 6]);
  spawn(UnitType.Bomber, [41, -1], [46, 4]);
  spawn(UnitType.ArmoredDivision, [40.4, -3.7], [42.5, -1]);
  ctx.cameraRig.setState({ lat: 39, lon: 4, altitudeKm: 1400, tilt: 0.6, heading: 0 });
  await waitFrames(60);
});

registerShot('structures', 'units', 'Every structure type on a developed nation (Spain), close orbit', async ({ ctx, waitFrames }) => {
  await ctx.app.startScriptedGame({ ticks: 900, speed: 0 });
  STRUCTURE_TYPES.forEach((structure, i) => {
    const lat = 38.5 + (i % 4) * 1.2, lon = -6 + Math.floor(i / 4) * 2.2;
    ctx.sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: latLonToTile(lat, lon), radius: 4 });
    ctx.sim.debug({ type: 'spawnStructure', structure, owner: HUMAN_ID, tile: latLonToTile(lat, lon), level: 1 + (i % 3) });
  });
  ctx.cameraRig.setState({ lat: 39.5, lon: -3.5, altitudeKm: 700, tilt: 0.7, heading: 0 });
  await waitFrames(40);
});
