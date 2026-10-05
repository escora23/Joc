// Scratch check (gauntlet round 1, ai-diplomacy): a nation at war with the human capitulates to a third nation; the
// land it occupied goes back to the human, and the warEnded event states it. Run: npx tsx tools/scratch/g1d-peace.mjs
import { loadWorldInit } from '../../src/sim/test/world.mjs';
import { Game } from '../../src/sim/game.ts';
import { HUMAN_ID } from '../../src/shared/constants.ts';
import { latLonToTile } from '../../src/shared/geo.ts';

const world = await loadWorldInit(() => {});
const g = new Game({ seed: 21, playerName: 'Audit', playerColor: 0x3fa9f5, difficulty: 'normal', aiCount: 24, tribeCount: 40, speed: 1, nukes: true,
  worldEvents: false, startWorldTimeSec: 0, spawnTimeoutTicks: 900, autoSpawnTile: latLonToTile(40.4, -3.7), instantStart: true, humanAutopilot: false, duration: 'normal' }, world);
const events = [];
const emit = g.emit.bind(g);
g.emit = (e) => { if (e.type === 'warEnded' || e.type === 'capitulation') events.push(e); emit(e); };
const step = () => { g.tick1(); g.buildUpdate(1); };
while (g.tick < 5000) step();
const H = g.playerById[HUMAN_ID];
// The human's land neighbour with the most contact, and a third nation bordering that neighbour.
const nb = g.playerArr.filter((p) => p.alive && p.kind === 'nation' && g.sharesBorder(p.id, HUMAN_ID)).sort((a, b) => b.tiles - a.tiles)[0];
if (!nb) { console.log('neighbours', g.playerArr.filter((p) => p.alive && g.sharesBorder(p.id, HUMAN_ID)).map((p) => p.name + ':' + p.kind)); process.exit(2); }
const third = g.playerArr.filter((p) => p.alive && p.kind === 'nation' && p.id !== nb.id).sort((a, b) => (g.sharesBorder(b.id, nb.id) ? 1 : 0) - (g.sharesBorder(a.id, nb.id) ? 1 : 0))[0];
console.log(`human ${H.tiles} tiles; aggressor ${nb.name} ${nb.tiles}; third ${third?.name}`);

g.war.declare(nb.id, HUMAN_ID, 'conquest', 'war.reason.debug', { force: true, mobilizeTicks: 0 });
g.war.declare(third.id, nb.id, 'conquest', 'war.reason.debug', { force: true, mobilizeTicks: 0 });
nb.troops = nb.maxTroops;
g.attacks.command(nb, HUMAN_ID, 0.6, H.capitalTile);
const t0 = H.tiles;
for (let i = 0; i < 600 && H.tiles > t0 * 0.6; i++) step();
console.log(`after the offensive: human ${H.tiles} tiles (was ${t0})`);
const lost = t0 - H.tiles;
g.war.capitulate(nb.id, third.id);
for (let i = 0; i < 40; i++) step();
console.log(`after ${nb.name} capitulates to ${third.name}: human ${H.tiles} tiles`);
for (const e of events) console.log(JSON.stringify({ type: e.type, a: e.a, b: e.b, winner: e.winner, terms: e.terms, reason: e.reasonKey, held: e.held, by: e.by, returned: e.returned, loser: e.loser }));
const ev = events.find((e) => e.type === 'warEnded' && (e.a === HUMAN_ID || e.b === HUMAN_ID));
const ok = ev && ev.reasonKey === 'peace.reason.capitulation' && ev.by === third.id && ev.returned > 0 && H.tiles >= t0 - Math.max(2, lost * 0.1);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
