// Probe (sim-pacing-warfare fix): the staged war of the command-battle shot, headless. A big offensive of ours
// against the nation north of the Pyrenees; logs R, garrisons, losses, speed and the breakthrough state over time.
//   npx tsx tools/_probe-breakthrough.mjs [--ticks 1200] [--enemy 150000] [--ratio 0.4]
import { loadWorldInit } from '../src/sim/test/world.mjs';
import { Game } from '../src/sim/game.ts';
import { HUMAN_ID, MAP_W } from '../src/shared/constants.ts';
import { latLonToTile, tileToLatLon } from '../src/shared/geo.ts';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : Number(argv[i + 1]); };
const TICKS = arg('ticks', 1200), ENEMY = arg('enemy', 150_000), RATIO = arg('ratio', 0.4);
const world = await loadWorldInit(() => {});
const g = new Game({
  seed: 1337, playerName: 'Probe', playerColor: 0x3fa9f5, difficulty: 'normal', aiCount: 24, tribeCount: 40, speed: 1, nukes: false,
  worldEvents: false, startWorldTimeSec: 0, spawnTimeoutTicks: 600, autoSpawnTile: latLonToTile(40.4, -3.7),
  instantStart: true, humanAutopilot: false, duration: 'normal',
}, world);
const step = () => { g.tick1(); g.buildUpdate(1); };
const emit0 = g.emit.bind(g);
g.emit = (e) => {
  if ((e.type === 'offensive' && e.attacker === 1) || (e.type === 'message' && e.playerId === 1 && /offensive|war|peace|capit/i.test(e.key)) || /capitul|peace|warEnded/i.test(e.type)) console.log(`  [ev t${g.tick}] ${e.type} ${e.stage ?? e.key ?? ''} ${e.ratio ?? ''} ${JSON.stringify(e.params ?? '')}`);
  emit0(e);
};
while (g.phase !== 'playing') step();
const at = (lat, lon) => latLonToTile(lat, lon);
g.applyDebug({ type: 'conquer', playerId: HUMAN_ID, centerTile: g.config.autoSpawnTile, radius: 18 });
g.applyDebug({ type: 'addTroops', playerId: HUMAN_ID, amount: 60_000 });
for (let i = 0; i < 200; i++) step();
let enemy = 0, bd = Infinity;
for (const p of g.playerArr) {
  if (!p.alive || p.id === HUMAN_ID || p.kind !== 'nation' || p.capitalTile < 0) continue;
  const ll = tileToLatLon(p.capitalTile);
  const d = Math.hypot(ll.lat - 45.5, (ll.lon - 1.5) * Math.cos(45.5 * Math.PI / 180));
  if (d < bd) { bd = d; enemy = p.id; }
}
const E = g.playerById[enemy], H = g.playerById[HUMAN_ID];
console.log(`enemy ${E.name} (${enemy}) tiles ${E.tiles} troops ${Math.round(E.troops)}`);
g.applyDebug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(40.6, -2.5), radius: 20 });
g.applyDebug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(42.0, -0.5), radius: 9 });
g.applyDebug({ type: 'conquer', playerId: enemy, centerTile: at(44.3, 1.2), radius: 11 });
g.applyDebug({ type: 'war', a: HUMAN_ID, b: enemy, mobilizeTicks: 0 });
g.applyDebug({ type: 'addTroops', playerId: HUMAN_ID, amount: 900_000 });
g.applyDebug({ type: 'addTroops', playerId: enemy, amount: ENEMY });
for (let i = 0; i < 20; i++) step();
console.log(`staged: us ${Math.round(H.troops)} (${H.tiles} tiles), ${E.name} ${Math.round(E.troops)} (${E.tiles} tiles, max ${Math.round(E.maxTroops)})`);
g.issue(HUMAN_ID, { type: 'attack', target: enemy, ratio: RATIO, tile: at(43.4, 0.2), intensity: 1 });
const t0 = g.tick;
let consN = 0;
for (let i = 0; i < TICKS; i++) {
  step();
  const a = g.attackList.find((x) => !x.ended && x.attacker === HUMAN_ID && x.defender === enemy);
  if (a?.consolidating) consN++;
  if ((g.tick - t0) % 60 === 0 || !a) {
    if (!a) { console.log(`t+${g.tick - t0}: offensive over; ${E.name} ${Math.round(E.troops)} troops ${E.tiles} tiles`); break; }
    const f = a.frontKey ? g.fronts.get(a.frontKey) : undefined;
    const gar = f ? g.fronts.garrison(f, enemy) : -1;
    const lenKm = f ? f.length * 25 : 0;
    const cons = consN; consN = 0;
    console.log(`t+${g.tick - t0} ${a.state}${cons ? `(log ${cons})` : ''} pressure ${a.pressure.size}${a.breakthrough ? ' BREAKTHROUGH' : ''} R ${a.ratio.toFixed(1)} us ${Math.round(a.troops)} gar ${Math.round(gar)} on ${lenKm} km (${(gar / Math.max(1, lenKm)).toFixed(1)}/km) ${E.name} ${Math.round(E.troops)} tiles ${E.tiles} taken ${a.tilesTaken} v ${a.planKmh.toFixed(1)} meas ${a.advanceKmh.toFixed(1)} km/h lostA ${Math.round(a.attackerLosses)} lostD ${Math.round(a.defenderLosses)}${a.prisoners ? ' pris ' + Math.round(a.prisoners) : ''} frontage ${a.frontage.toFixed(1)}`);
  }
}
