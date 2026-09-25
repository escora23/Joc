// FRONT ULTRA — world events check (owner: sim-ai). Test tooling only, never bundled.
//
//   npx tsx src/sim/ai/test/events.mjs
//
// Plays 5 minutes, then forces every world event at a real place (SimDebugAction 'worldEvent', exactly what the
// shots use) and runs 4 more minutes, printing the event stream (warning/start/end with locations, magnitudes
// and affected players), the ships and structures they destroyed, the doomsday clock, and the fate of the rebels.

import { loadWorldInit } from '../../test/world.mjs';
import { Game } from '../../game.ts';
import { DEFAULT_START_WORLD_TIME } from '../../../shared/constants.ts';
import { latLonToTile } from '../../../shared/geo.ts';

const world = await loadWorldInit();
const game = new Game({
  seed: 7, playerName: 'A', playerColor: 0x2f6fd6, difficulty: 'normal', aiCount: 30, tribeCount: 20, speed: 4, nukes: true, worldEvents: true,
  startWorldTimeSec: DEFAULT_START_WORLD_TIME, spawnTimeoutTicks: 300, autoSpawnTile: latLonToTile(40.4, -3.7), instantStart: true, humanAutopilot: true,
}, world);
game.end = () => {};
const name = (id) => game.playerById[id]?.name ?? `#${id}`;
let sunk = 0, collapsed = 0;
const orig = game.emit.bind(game);
game.emit = (e) => {
  if (e.type === 'worldEvent') console.log(`${(game.tick / 600).toFixed(2)}m ${e.kind.padEnd(10)} ${e.stage.padEnd(7)} at (${e.x.toFixed(0)},${e.y.toFixed(0)}) r=${e.radius.toFixed(0)} m=${Number(e.magnitude).toFixed(1)} players=${e.players.map(name).join('/')}`);
  if (e.type === 'doomsday') console.log(`${(game.tick / 600).toFixed(2)}m doomsday level ${e.level.toFixed(2)} (${e.minutesToMidnight.toFixed(1)} min to midnight)`);
  if (e.type === 'unitDestroyed' && e.by === 0) sunk++;
  if (e.type === 'structureDestroyed' && e.by === 0) collapsed++;
  return orig(e);
};
const run = (n) => { for (let i = 0; i < n; i++) { game.tick1(); if (game.tick % 4 === 0) game.buildUpdate(4); } };
while (game.phase === 'spawn') game.tick1();
run(3000);
const T = (a, b) => latLonToTile(a, b);
game.applyDebug({ type: 'worldEvent', kind: 'earthquake', tile: T(35.7, 139.7) });
game.applyDebug({ type: 'worldEvent', kind: 'hurricane', tile: T(15, -45) });
game.applyDebug({ type: 'worldEvent', kind: 'goldRush', tile: T(-26.2, 28) });
game.applyDebug({ type: 'worldEvent', kind: 'pandemic', tile: T(28.6, 77.2) });
const big = game.playerArr.filter((p) => p.alive && p.kind === 'nation').sort((a, b) => b.tiles - a.tiles)[0];
game.applyDebug({ type: 'worldEvent', kind: 'rebellion', tile: Math.floor(big.labelY) * 1600 + Math.floor(big.labelX) });
game.applyDebug({ type: 'worldEvent', kind: 'doomsday', tile: 0 });
run(2400);
console.log(`ships/units destroyed by events ${sunk} · structures destroyed by events ${collapsed}`);
console.log('active states:', [...game.eventStates.values()].map((s) => `${s.kind}:${s.progress.toFixed(2)}`).join(' ') || '-');
for (const r of game.playerArr.filter((p) => p.kind === 'rebel')) console.log(`rebels ${r.name}: tiles ${r.tiles}, troops ${Math.round(r.troops)}, alive ${r.alive}`);
