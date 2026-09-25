// FRONT ULTRA — human <-> AI diplomacy check (owner: sim-ai). Test tooling only, never bundled.
//
//   npx tsx src/sim/ai/test/diplomacy.mjs
//
// A scripted human (expanding, otherwise passive) waves at six AI nations, asks them all for an alliance, donates
// gold, insults one, threatens another, and marks a target for its ally. Prints every AI answer with its tick so
// reaction delays, accept/reject decisions, emote replies and the ally's target switch can be checked.
import { loadWorldInit } from '../../test/world.mjs';
import { Game } from '../../game.ts';
import { DEFAULT_START_WORLD_TIME } from '../../../shared/constants.ts';
import { latLonToTile } from '../../../shared/geo.ts';
const world = await loadWorldInit();
const game = new Game({ seed: 99, playerName: 'Yo', playerColor: 0x2f6fd6, difficulty: 'normal', aiCount: 30, tribeCount: 10, speed: 4, nukes: true, worldEvents: true, startWorldTimeSec: DEFAULT_START_WORLD_TIME, spawnTimeoutTicks: 300, autoSpawnTile: latLonToTile(40.4, -3.7), instantStart: true, humanAutopilot: false }, world);
const name = (id) => game.playerById[id]?.name ?? id;
const orig = game.emit.bind(game);
game.emit = (e) => {
  if ((e.from === 1 || e.to === 1 || e.a === 1 || e.b === 1 || e.victim === 1 || e.breaker === 1) && ['allianceRequested', 'allianceFormed', 'allianceRejected', 'emote', 'donation', 'allianceBroken'].includes(e.type))
    console.log(`${game.tick} ${e.type} ${name(e.from ?? e.a ?? e.breaker)} -> ${name(e.to ?? e.b ?? e.victim)} ${e.emote ?? ''}`);
  return orig(e);
};
while (game.phase === 'spawn') game.tick1();
const run = (n) => { for (let i = 0; i < n; i++) { if (game.tick % 40 === 0) game.queueHuman({ type: 'attack', target: 0, ratio: 0.3, tile: game.playerById[1].capitalTile }); game.tick1(); if (game.tick % 4 === 0) game.buildUpdate(4); } };
run(300);
console.log('phase', game.phase, 'human tiles', game.playerById[1].tiles);
const ais = game.playerArr.filter((p) => p.alive && p.kind === 'nation').slice(0, 6);
game.addGold(1, 5_000_000);
for (const p of ais) game.queueHuman({ type: 'emote', target: p.id, emote: 'wave' }), run(45);
for (const p of ais) game.queueHuman({ type: 'allianceRequest', target: p.id }), run(5);
run(300);
game.queueHuman({ type: 'donate', target: ais[0].id, gold: 1_000_000, troops: 0 }); run(120);
game.queueHuman({ type: 'emote', target: ais[1].id, emote: 'clown' }); run(120);
game.queueHuman({ type: 'emote', target: ais[2].id, emote: 'nuke' }); run(120);
const ally = [...game.playerById[1].allies][0];
if (ally) {
  const enemy = game.playerArr.find((p) => p.alive && p.kind === 'nation' && p.id !== ally && !game.isAllied(1, p.id));
  game.queueHuman({ type: 'targetPlayer', target: enemy.id }); run(200);
  console.log('ally', name(ally), 'brain allyTarget ->', name(game.playerById[ally].aiMemory.allyTarget), 'expected', name(enemy.id));
}
console.log('human allies:', [...game.playerById[1].allies].map(name));
