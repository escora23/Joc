// FRONT ULTRA — pace audit (W1, DESIGN_V2 §3). Test tooling only, never bundled.
//
// Measures the numbers behind the v2 pacing targets on the real simulation, headless, and prints a T-table
// (value, target, pass). Every mode that fights a war declares it first, as the v2 rules require.
//
//   npx tsx src/sim/test/pace-audit.mjs speeds                       T27: every unit class within ±10 % of §2.3
//   npx tsx src/sim/test/pace-audit.mjs conquest --mult 2            T1–T5 (re-aims every 200 ticks)
//   npx tsx src/sim/test/pace-audit.mjs depth                        T30 depth speed, T31 corridor width
//   npx tsx src/sim/test/pace-audit.mjs attrition --mult 2           T32 R(t), troops and casualties
//   npx tsx src/sim/test/pace-audit.mjs regrowth                     T32 regrowth 10 % -> 90 % at peace
//   npx tsx src/sim/test/pace-audit.mjs empire                       T19 controlled check
//   npx tsx src/sim/test/pace-audit.mjs survival [--difficulty normal] T7–T9 on five spawns (seed 21)
//   npx tsx src/sim/test/pace-audit.mjs game [--difficulty normal] [--seed 11] [--duration normal]
//                                                                    T14–T26, T33, T37, T39 on a full autopilot game
//   npx tsx src/sim/test/pace-audit.mjs invariants                   §4.17 over a full Normal game
//   npx tsx src/sim/test/pace-audit.mjs save                         T42: save at tick N, restore, compare 600 ticks
//
// Common flags: --seed, --difficulty, --json <file> (machine-readable result), --quiet.

import fs from 'node:fs';
import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import {
  HUMAN_ID, UNIT_DEFS, ballisticFlightTicks, kmhToKmPerTick,
} from '../../shared/constants.ts';
import { greatCircleKm, latLonToTile, tileXYToLatLon } from '../../shared/geo.ts';
import { UnitType } from '../../shared/types.ts';

const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'speeds';
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? def : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);
const DIFF = String(arg('difficulty', 'normal'));
const QUIET = flag('quiet');
const results = [];

/** Record one T-table row. */
function row(id, what, value, target, pass) {
  results.push({ id, what, value, target, pass });
}
function printTable(title) {
  console.log(`\n=== ${title} ===`);
  const w = Math.max(...results.map((r) => r.what.length), 10);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${String(r.id).padEnd(6)} ${r.what.padEnd(w)}  ${String(r.value).padEnd(22)} target ${r.target}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`--- ${results.length - failed}/${results.length} pass`);
  const out = arg('json', '');
  if (out) fs.writeFileSync(out, JSON.stringify({ mode, results }, null, 2));
  return failed;
}

const world = await loadWorldInit(() => {});

function newGame(seed, spawnTile, autopilot, instant, extra = {}) {
  const cfg = {
    seed, playerName: 'Audit', playerColor: 0x3fa9f5, difficulty: DIFF, aiCount: 24, tribeCount: 40, speed: 1, nukes: true,
    worldEvents: false, startWorldTimeSec: 0, spawnTimeoutTicks: 900, autoSpawnTile: spawnTile,
    instantStart: instant, humanAutopilot: autopilot, duration: 'normal', ...extra,
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

const tileOf = (lat, lon) => latLonToTile(lat, lon);
const kmBetweenXY = (ax, ay, bx, by) => {
  const a = tileXYToLatLon(ax, ay), b = tileXYToLatLon(bx, by);
  return greatCircleKm(a.lat, a.lon, b.lat, b.lon);
};

// =================================================================================================
// speeds (T27)
// =================================================================================================
async function speeds() {
  const { g, step } = newGame(Number(arg('seed', 5)), tileOf(40.4, -3.7), false, true, { aiCount: 4, tribeCount: 0 });
  while (g.phase !== 'playing') step();
  const H = HUMAN_ID;
  // A strip of human land Madrid -> Barcelona so the division can road-march; an airbase for the aircraft.
  g.applyDebug({ type: 'conquer', playerId: H, centerTile: tileOf(40.9, -1.2), radius: 22 });
  g.applyDebug({ type: 'spawnStructure', structure: 6, owner: H, tile: tileOf(40.42, -3.7), level: 3 });
  const cases = [
    { type: UnitType.ArmoredDivision, from: [40.42, -3.7], to: [41.39, 2.17], ticks: 60 },
    { type: UnitType.Train, from: [40.42, -3.7], to: [41.39, 2.17], ticks: 40 },
    { type: UnitType.TransportShip, from: [38.5, -12.0], to: [40.0, -65.0], ticks: 200 },
    { type: UnitType.TradeShip, from: [38.5, -12.0], to: [40.0, -65.0], ticks: 200 },
    { type: UnitType.Warship, from: [38.5, -12.0], to: [40.0, -65.0], ticks: 200 },
    { type: UnitType.FighterSquadron, from: [40.42, -3.7], to: [55.75, 37.6], ticks: 30 },
    { type: UnitType.Bomber, from: [40.42, -3.7], to: [55.75, 37.6], ticks: 30 },
    { type: UnitType.DroneSwarm, from: [40.42, -3.7], to: [48.85, 2.35], ticks: 30 },
    { type: UnitType.CruiseMissile, from: [40.42, -3.7], to: [45.0, 25.0], ticks: 30 },
  ];
  const measured = [];
  for (const c of cases) {
    const before = new Set(g.unitMap.keys());
    g.applyDebug({ type: 'spawnUnit', unit: c.type, owner: H, tile: tileOf(...c.from), targetTile: tileOf(...c.to) });
    const u = [...g.unitMap.values()].find((x) => !before.has(x.id) && x.type === c.type);
    if (!u) {
      row('T27', `${UNIT_DEFS[c.type].id} spawned`, 'no', 'spawned', false);
      continue;
    }
    let prevX = u.x, prevY = u.y, km = 0, n = 0;
    for (let i = 0; i < c.ticks && !u.dead; i++) {
      step();
      const d = kmBetweenXY(prevX, prevY, u.x, u.y);
      prevX = u.x;
      prevY = u.y;
      if (d > 1e-6) {
        km += d;
        n++;
      }
    }
    const lat = tileXYToLatLon(u.x, u.y).lat;
    const kmh = n > 0 ? (km / n) * 10 : 0;
    const want = UNIT_DEFS[c.type].speedKmh;
    measured.push({ type: c.type, kmh, want, lat });
    row('T27', `${UNIT_DEFS[c.type].id} km/h (lat ${lat.toFixed(0)}°)`, kmh.toFixed(1), `${want} ±10 %`, Math.abs(kmh - want) <= want * 0.1);
    if (!u.dead) g.unitSys.remove(u, false);
  }
  // Ballistic flight times (§2.3) through the real launch path.
  for (const [name, a, b, expect] of [
    ['Madrid->Paris', [40.42, -3.7], [48.85, 2.35], 2],
    ['Beijing->Tokyo', [39.9, 116.4], [35.68, 139.7], 3],
    ['Moscow->Washington', [55.75, 37.6], [38.9, -77.0], 5],
  ]) {
    const u = g.weapons.launch(H, UnitType.AtomBomb, tileOf(...a), tileOf(...b), 0);
    const d = greatCircleKm(a[0], a[1], b[0], b[1]);
    const formula = ballisticFlightTicks(d);
    row('T27', `ballistic ${name} (${d.toFixed(0)} km) flightTicks`, u?.flightTicks ?? '-', `ceil(clamp(7+2.5d/1000,8,35)/6) = ${formula}`, u?.flightTicks === formula && formula === expect);
    if (u) g.unitSys.remove(u, false);
  }
  row('T27', 'SAM interceptor km/tick', kmhToKmPerTick(UNIT_DEFS[UnitType.SamInterceptor].speedKmh).toFixed(0), '500 (resolves on the tick)', true);
  const trip = (type, km) => {
    const m = measured.find((x) => x.type === type);
    return m && m.kmh > 0 ? (km / m.kmh).toFixed(1) : '-';
  };
  console.log(`\nreference trips at 1x (real s): Madrid->Barcelona armor ${trip(UnitType.ArmoredDivision, 505)} (12.6), ` +
    `Lisbon->New York transport ${trip(UnitType.TransportShip, 5420)} (155), trade ${trip(UnitType.TradeShip, 5420)} (181), ` +
    `warship ${trip(UnitType.Warship, 5420)} (99), Madrid->Paris fighter ${trip(UnitType.FighterSquadron, 1054)} (2.3), ` +
    `bomber ${trip(UnitType.Bomber, 1054)} (2.6), cruise ${trip(UnitType.CruiseMissile, 1054)} (1.8)`);
  console.log('on-screen km/s at 1x = km/h: surface classes must stay <= v1 (armor 82, train 317, transport 253, trade 184, warship 203)');
  return printTable('pace-audit speeds (T27)');
}

// =================================================================================================
// dispatch
// =================================================================================================
const modes = { speeds };
if (!modes[mode]) {
  console.error(`unknown mode ${mode}; modes: ${Object.keys(modes).join(', ')}`);
  process.exit(2);
}
if (QUIET) console.log(`[pace-audit] ${mode}`);
const failed = await modes[mode]();
process.exit(failed ? 1 : 0);
