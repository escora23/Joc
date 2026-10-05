import { loadWorldInit } from '../../src/sim/test/world.mjs';
import { Game } from '../../src/sim/game.ts';
import { DEFAULT_START_WORLD_TIME, HUMAN_ID } from '../../src/shared/constants.ts';
import { latLonToTile } from '../../src/shared/geo.ts';
const world = await loadWorldInit();
const config = { seed: 3, playerName: 'T', playerColor: 0x2f6fd6, difficulty: 'normal', aiCount: 20, tribeCount: 10, speed: 1,
  nukes: false, worldEvents: true, startWorldTimeSec: DEFAULT_START_WORLD_TIME, spawnTimeoutTicks: 0, autoSpawnTile: -1, instantStart: false, humanAutopilot: false };
const g = new Game(config, world);
for (let i = 0; i < 1800; i++) g.tick1(); // 3 minutes choosing at 10 ticks/s
console.log('after 3 min of choosing: phase', g.phase, 'tick', g.tick, 'deadline (published)', g.spawnDeadlineTick);
g.issue(HUMAN_ID, { type: 'spawn', tile: latLonToTile(40.4, -3.7) });
let n = 0;
while (g.phase === 'spawn' && n < 2000) { g.tick1(); n++; }
console.log('countdown ticks', n, 'phase', g.phase, 'tick at start of play', g.tick);
for (let i = 0; i < 240; i++) g.tick1();
console.log('one game day later tick', g.tick, 'day', Math.floor(g.tick / 240) + 1);
// Auto-spawn on the deadline when the human never picks.
const g2 = new Game({ ...config, seed: 4, spawnTimeoutTicks: 600 }, world);
let m = 0;
while (g2.phase === 'spawn' && m < 5000) { g2.tick1(); m++; }
console.log('no pick: spawn ticks', m, 'phase', g2.phase, 'tick', g2.tick, 'human spawned', g2.playerById[HUMAN_ID].spawned);
