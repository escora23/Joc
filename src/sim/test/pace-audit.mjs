// FRONT ULTRA — pace audit (play-auditor, docs/AUDIT-1.md). Test tooling only, never bundled.
//
// Measures the numbers behind FEEDBACK-1 items 1, 3, 12 and 13 on the real simulation, headless, so every v2
// change to time scale, conquest or AI can be checked against the audit baseline:
//
//   npx tsx src/sim/test/pace-audit.mjs conquest [--difficulty normal] [--seed 5] [--radius 25] [--warm 1500] [--mult 2]
//       The human gets a disc of land around Madrid (radius tiles), stays passive for `warm` ticks, then the nation
//       with the longest shared border is given `mult` x the human's troops and attacks with 100 % of them.
//       Reports ticks to the first lost tile, capital, half and 90 % of the land, and the largest loss in one tick.
//   npx tsx src/sim/test/pace-audit.mjs survival [--difficulty normal] [--seed 12] [--lat 40.4 --lon -3.7] [--max 6000]
//       A passive human founded at lat/lon (no head start): when and how is it eliminated (attack or encirclement)?
//   npx tsx src/sim/test/pace-audit.mjs game [--difficulty normal] [--seed 11] [--max 60000]
//       Full game with the human on autopilot: length, winner, events per game-minute, first nuke, boat trip times.
//
// Times are reported in ticks and in real seconds at 1x (10 ticks/s) and 4x.

import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID, MAP_W } from '../../shared/constants.ts';
import { latLonToTile } from '../../shared/geo.ts';

const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'conquest';
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 || argv[i + 1] === undefined ? def : argv[i + 1];
};
const DIFF = String(arg('difficulty', 'normal'));
const sec = (ticks) => (ticks < 0 ? '-' : `${ticks} ticks = ${(ticks / 10).toFixed(1)} s at 1x, ${(ticks / 40).toFixed(2)} s at 4x`);
const nb4 = (t) => [t - 1, t + 1, t - MAP_W, t + MAP_W];

const world = await loadWorldInit(() => {});

function newGame(seed, spawnTile, autopilot, instant) {
  const cfg = {
    seed, playerName: 'Audit', playerColor: 0x3fa9f5, difficulty: DIFF, aiCount: 24, tribeCount: 40, speed: 1, nukes: true,
    worldEvents: mode === 'game', startWorldTimeSec: 0, spawnTimeoutTicks: 900, autoSpawnTile: spawnTile,
    instantStart: instant, humanAutopilot: autopilot,
  };
  const g = new Game(cfg, world);
  const events = [];
  const emit = g.emit.bind(g);
  g.emit = (e) => {
    if (e.type !== 'combat' && e.type !== 'goldBonus' && e.type !== 'tradeCompleted') events.push(e);
    emit(e);
  };
  const step = () => {
    g.tick1();
    g.buildUpdate(1);
  };
  return { g, events, step };
}

if (mode === 'conquest') {
  const { g, events, step } = newGame(Number(arg('seed', 5)), latLonToTile(40.4, -3.7), false, true);
  while (g.phase !== 'playing') step();
  const H = g.playerById[HUMAN_ID];
  g.applyDebug({ type: 'conquer', playerId: HUMAN_ID, centerTile: H.capitalTile, radius: Number(arg('radius', 25)) });
  g.applyDebug({ type: 'addTroops', playerId: HUMAN_ID, amount: 200_000 });
  for (let i = 0; i < Number(arg('warm', 1500)) && H.alive; i++) step();
  if (!H.alive) {
    console.log('human eliminated during the warm-up:', events.filter((e) => e.playerId === HUMAN_ID || e.defender === HUMAN_ID).slice(-3));
    process.exit(0);
  }
  const contact = new Map();
  for (let t = 0; t < g.owner.length; t++) {
    if (g.owner[t] !== HUMAN_ID) continue;
    for (const n of nb4(t)) {
      const o = g.owner[n];
      if (o && o !== HUMAN_ID) contact.set(o, (contact.get(o) ?? 0) + 1);
    }
  }
  const A = [...contact.keys()].map((id) => g.playerById[id]).filter((p) => p?.alive && p.kind === 'nation')
    .sort((a, b) => contact.get(b.id) - contact.get(a.id))[0];
  if (!A) {
    console.log('no nation borders the human');
    process.exit(0);
  }
  A.troops = Math.max(A.troops, H.troops * Number(arg('mult', 2)));
  let click = -1;
  for (let t = 0; t < g.owner.length && click < 0; t++) if (g.owner[t] === HUMAN_ID && nb4(t).some((n) => g.owner[n] === A.id)) click = t;
  const d0 = H.tiles, t0 = g.tick;
  console.log(`attacker ${A.name}: ${Math.round(A.troops)} troops, ${A.tiles} tiles; defender (human): ${Math.round(H.troops)} troops, ${d0} tiles; shared border ${contact.get(A.id)} edges`);
  g.issue(A.id, { type: 'attack', target: HUMAN_ID, ratio: 1, tile: click });
  const r = { first: -1, capital: -1, half: -1, ninety: -1, gone: -1, maxPerTick: 0 };
  let prev = d0;
  for (let i = 0; i < 3000; i++) {
    step();
    const dt = g.tick - t0;
    r.maxPerTick = Math.max(r.maxPerTick, prev - H.tiles);
    prev = H.tiles;
    if (r.first < 0 && H.tiles < d0) r.first = dt;
    if (r.capital < 0 && events.some((e) => e.type === 'capitalCaptured' && e.playerId === HUMAN_ID)) r.capital = dt;
    if (r.half < 0 && H.tiles <= d0 / 2) r.half = dt;
    if (r.ninety < 0 && H.tiles <= d0 / 10) r.ninety = dt;
    if (!H.alive) { r.gone = dt; break; }
    if (!g.attackList.some((a) => !a.ended && a.attacker === A.id && a.defender === HUMAN_ID)) break;
  }
  console.log(`first tile lost: ${sec(r.first)}\ncapital lost:    ${sec(r.capital)}\nhalf the land:   ${sec(r.half)}\n90% of the land: ${sec(r.ninety)}\neliminated:      ${sec(r.gone)}`);
  console.log(`largest loss in one tick: ${r.maxPerTick} tiles; human tiles left: ${H.tiles}`);
} else if (mode === 'survival') {
  const tile = latLonToTile(Number(arg('lat', 40.4)), Number(arg('lon', -3.7)));
  const { g, events, step } = newGame(Number(arg('seed', 12)), tile, false, false);
  const H = () => g.playerById[HUMAN_ID];
  let playing = -1;
  for (let i = 0; i < Number(arg('max', 6000)); i++) {
    step();
    if (playing < 0 && g.phase === 'playing') playing = g.tick;
    if (g.phase === 'ended' || (H() && !H().alive)) break;
  }
  const h = H();
  const attacked = events.filter((e) => e.type === 'attackStarted' && e.defender === HUMAN_ID);
  const elim = events.find((e) => e.type === 'nationEliminated' && e.playerId === HUMAN_ID);
  console.log(`playing from tick ${playing}; human alive: ${h?.alive}; tiles ${h?.tiles}`);
  if (elim) {
    const by = g.playerById[elim.by]?.name ?? elim.by;
    console.log(`eliminated by ${by} after ${sec(elim.tick - playing)} of play; attacks on the human before that: ${attacked.length}` +
      (attacked.length ? '' : ' -> encirclement capture (enclaves.ts), no attack and no warning'));
  }
} else {
  const { g, events, step } = newGame(Number(arg('seed', 11)), latLonToTile(40.4, -3.7), true, false);
  let playing = -1;
  const max = Number(arg('max', 60000));
  for (let i = 0; i < max && g.phase !== 'ended'; i++) {
    step();
    if (playing < 0 && g.phase === 'playing') playing = g.tick;
  }
  const mins = (g.tick - playing) / 600;
  const over = events.find((e) => e.type === 'gameOver');
  console.log(`game length ${mins.toFixed(1)} game-min (= real min at 1x; ${(mins / 4).toFixed(1)} real min at 4x); winner ${over ? g.playerById[over.winner]?.name : '-'} (${over?.reason ?? 'not finished'})`);
  const count = {};
  for (const e of events) {
    if (e.tick < playing) continue;
    const k = e.type === 'nukeLaunched' ? `nukeLaunched:${e.weapon}` : e.type === 'worldEvent' ? `worldEvent:${e.stage}` : e.type;
    count[k] = (count[k] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(count).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${String(v).padStart(6)}  ${(v / mins).toFixed(2)}/game-min`);
  const firstNuke = events.find((e) => e.type === 'nukeLaunched' && e.weapon !== 7);
  console.log(`first nuke (not cruise): ${firstNuke ? ((firstNuke.tick - playing) / 600).toFixed(1) + ' game-min' : '-'}`);
  const launched = new Map(), trips = [];
  for (const e of events) {
    if (e.type === 'boatLaunched') launched.set(e.unitId, e.tick);
    if (e.type === 'boatLanded' && launched.has(e.unitId)) trips.push(e.tick - launched.get(e.unitId));
  }
  trips.sort((a, b) => a - b);
  if (trips.length) console.log(`boat trip launch->landing: median ${sec(trips[trips.length >> 1])}, p10 ${trips[Math.floor(trips.length * 0.1)]} ticks`);
}
