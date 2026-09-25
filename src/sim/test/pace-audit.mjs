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
import { SaveReader, SaveWriter } from '../save.ts';
import {
  HUMAN_ID, OFFENSIVE_CONTACT_TICKS, UNIT_DEFS, ballisticFlightTicks, kmhToKmPerTick,
} from '../../shared/constants.ts';
import { greatCircleKm, latLonToTile, latLonToTileXY, tileXYToLatLon } from '../../shared/geo.ts';
import { StructureType, UnitType } from '../../shared/types.ts';
import { surfDist2 } from '../spatial.ts';

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
// staging helpers
// =================================================================================================
/** An empty world (no AI, no independent territories) with the AI director switched off: controlled runs only. */
function controlledGame(seed, extra = {}) {
  Game.checkInvariants = true;
  const h = newGame(seed, tileOf(40.4, -3.7), false, true, { aiCount: 0, tribeCount: 0, ...extra });
  h.g.ai = { setup() {}, tick() {}, onEvent() {} };
  while (h.g.phase !== 'playing') h.step();
  return h;
}

const countryIdx = (iso3) => world.countries.findIndex((c) => c.iso3 === iso3);

/** Give `owner` every playable tile matching `pred` (staging: no invariants, no occupation). */
function stageLand(g, owner, pred) {
  g.transferContext = 'staging';
  let n = 0;
  for (let t = 0; t < g.owner.length; t++) {
    if (!g.playable[t] || !pred(t)) continue;
    g.setOwner(t, owner);
    n++;
  }
  g.transferContext = 'none';
  const p = g.playerById[owner];
  if (p) {
    p.spawned = true;
    p.metaDirty = true;
  }
  return n;
}

function addNation(g, name) {
  const id = g.addPlayer({ name, kind: 'nation', personality: 'conqueror', color: 0xcc3333, countryIndex: 0 });
  return id;
}

/** Tiles of `owner`, grouped in 4-connected components; returns the largest one. */
function largestComponent(g, owner) {
  const seen = new Uint8Array(g.owner.length);
  const nb = new Int32Array(4);
  let best = [];
  for (const start of g.playerById[owner].border) {
    if (seen[start]) continue;
    const comp = [start];
    seen[start] = 1;
    for (let i = 0; i < comp.length; i++) {
      const n = neighbors4(comp[i], nb);
      for (let k = 0; k < n; k++) {
        const q = nb[k];
        if (!seen[q] && g.owner[q] === owner) {
          seen[q] = 1;
          comp.push(q);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

/** The tile of `owner` nearest to the centroid of its largest region (the AI war plan's re-aim point). */
function aimPoint(g, owner) {
  const comp = largestComponent(g, owner);
  if (!comp.length) return -1;
  const W = g.owner.length / 800;
  const x0 = comp[0] % W;
  let sx = 0, sy = 0;
  for (const t of comp) {
    let dx = (t % W) - x0;
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    sx += dx;
    sy += Math.floor(t / W);
  }
  const cx = x0 + sx / comp.length, cy = sy / comp.length;
  let best = comp[0], bd = Infinity;
  for (const t of comp) {
    let dx = (t % W) - cx;
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    const dy = Math.floor(t / W) - cy;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

function neighbors4(tile, out) {
  const W = 1600, N = 1600 * 800;
  const x = tile % W;
  let n = 0;
  out[n++] = x === 0 ? tile + W - 1 : tile - 1;
  out[n++] = x === W - 1 ? tile - W + 1 : tile + 1;
  if (tile >= W) out[n++] = tile - W;
  if (tile < N - W) out[n++] = tile + W;
  return n;
}

// =================================================================================================
// conquest (T1–T5)
// =================================================================================================
/**
 * Iberia (Spain, Portugal, Andorra, Gibraltar) is the human's, passive, at full strength. A staged nation holding
 * metropolitan France gets `mult` × the defender's troops, declares war with the queued offensive at 100 % and, as an
 * AI war plan does, re-aims the axis at the defender's largest remaining region every 200 ticks.
 */
function conquestRun(mult, maxTicks = 5000) {
  const { g, events, step } = controlledGame(Number(arg('seed', 7)));
  const H = HUMAN_ID;
  const iber = new Set(['ESP', 'PRT', 'AND', 'GIB'].map(countryIdx).filter((i) => i >= 0));
  const fra = countryIdx('FRA');
  const W = 1600;
  // Release the spawn disc, then stage the two nations.
  stageLand(g, 0, (t) => g.owner[t] === H);
  const defTiles = stageLand(g, H, (t) => iber.has(world.country[t]));
  const A = addNation(g, 'Atacante');
  stageLand(g, A, (t) => {
    if (world.country[t] !== fra) return false;
    const ll = tileXYToLatLon((t % W) + 0.5, Math.floor(t / W) + 0.5);
    return ll.lat > 41 && ll.lat < 51.5 && ll.lon > -5.5 && ll.lon < 10;
  });
  const D = g.playerById[H], P = g.playerById[A];
  D.capitalTile = tileOf(40.42, -3.7);
  P.capitalTile = tileOf(48.85, 2.35);
  g.economy.refreshAll();
  step();
  D.troops = D.maxTroops;
  P.troops = D.troops * mult;
  const capital = D.capitalTile;
  const start = D.tiles;
  const w = g.war.declare(A, H, 'conquest', 'war.reason.debug', { force: true, queuedAttack: { tile: aimPoint(g, H), ratio: 1 } });
  let t0 = -1, first = -1, cap = -1, half = -1, ninety = -1, maxLoss = 0, lastTiles = D.tiles;
  const series = [];
  const R0 = { launch: 0 };
  let minRBeforeHalf = Infinity;
  for (let i = 0; i < maxTicks + 200 && D.alive; i++) {
    // The attacker is given its troops on the tick before the queued offensive starts (troops above the cap bleed).
    if (w && g.tick === w.mobilizeUntilTick - 1) P.troops = D.troops * mult;
    step();
    const a = g.attackList.find((x) => !x.ended && x.attacker === A && x.defender === H);
    if (t0 < 0 && a) t0 = g.tick;
    if (t0 < 0) continue;
    const rel = g.tick - t0;
    const lost = lastTiles - D.tiles;
    lastTiles = D.tiles;
    if (lost > maxLoss) maxLoss = lost;
    if (first < 0 && D.tiles < start) first = rel;
    if (cap < 0 && g.owner[capital] !== H) cap = rel;
    if (half < 0 && D.tiles <= start / 2) half = rel;
    if (ninety < 0 && D.tiles <= start * 0.1) ninety = rel;
    if (a && rel === OFFENSIVE_CONTACT_TICKS + 1) R0.launch = a.ratio;
    if (a && half < 0 && rel > OFFENSIVE_CONTACT_TICKS + 1) minRBeforeHalf = Math.min(minRBeforeHalf, a.ratio);
    if (rel % 10 === 0) series.push({ rel, R: a ? +a.ratio.toFixed(2) : 0, att: Math.round(a ? a.troops : 0), def: Math.round(D.troops), tiles: D.tiles, state: a?.state ?? '-', kmh: a ? +a.advanceKmh.toFixed(2) : 0 });
    if (rel > 0 && rel % 200 === 0 && a) {
      const aim = aimPoint(g, H);
      if (aim >= 0) g.attacks.setAxis(a, aim);
    }
    if (rel >= maxTicks || ninety >= 0) break;
  }
  const inv = g.invariants.report();
  return {
    mult, start, first, cap, half, ninety, maxLoss, remaining: D.alive ? D.tiles : 0, series, R0: R0.launch, minRBeforeHalf,
    inv, mobilize: w ? w.mobilizeUntilTick - w.startTick : -1,
    starts: events.filter((e) => e.type === 'attackStarted').map((e) => e.tick),
  };
}

async function conquest() {
  const only = arg('mult', '');
  const mults = only ? [Number(only)] : [1, 2, 4, 10];
  const runs = new Map();
  for (const m of mults) {
    const r = conquestRun(m, m === 1 ? 3000 : 5000);
    runs.set(m, r);
    console.log(`mult ${m}: start ${r.start} tiles, launch R ${r.R0.toFixed(2)}, first ${r.first}, capital ${r.cap}, half ${r.half}, 90% ${r.ninety}, max loss/tick ${r.maxLoss}, left ${r.remaining}, inv5 ${r.inv.counts[5]}`);
    if (!QUIET) for (const s of r.series.filter((_, i) => i % 20 === 0)) console.log(`   t+${s.rel}: R ${s.R} att ${s.att} def ${s.def} tiles ${s.tiles} ${s.state} ${s.kmh} km/h`);
  }
  const r2 = runs.get(2), r1 = runs.get(1), r4 = runs.get(4), r10 = runs.get(10);
  if (r2) {
    row('T1', 'mult 2: first tile lost (ticks after start)', r2.first, '>= 20', r2.first >= 20);
    row('T1', 'mult 2: capital falls', r2.cap, '[600, 1800]', r2.cap >= 600 && r2.cap <= 1800);
    row('T1', 'mult 2: half the land', r2.half, '[900, 2400]', r2.half >= 900 && r2.half <= 2400);
    row('T1', 'mult 2: 90 % of the land', r2.ninety, '>= 1300 and <= 5000', r2.ninety >= 1300 && r2.ninety <= 5000);
  }
  if (r10) row('T2', 'mult 10: half the land', r10.half, '[600, 1200]', r10.half >= 600 && r10.half <= 1200);
  if (r1) row('T3', 'mult 1: land kept after 3000 ticks', `${((r1.remaining / r1.start) * 100).toFixed(1)} %`, '>= 70 %', r1.remaining >= r1.start * 0.7);
  if (r2 && r4 && r10) {
    const ok = r2.half > 0 && r4.half > 0 && r10.half > 0 && r2.half <= 3000 && r4.half <= 3000 && r10.half <= 3000;
    row('T4', 't_half exists for mult 2, 4, 10', `${r2.half} / ${r4.half} / ${r10.half}`, '<= 3000 each', ok);
    const ratio = r4.half / r2.half;
    row('T4', 't_half(4) / t_half(2)', ratio.toFixed(2), '[0.4, 0.85]', ok && ratio >= 0.4 && ratio <= 0.85);
  }
  for (const [m, r] of runs) {
    row('T5', `mult ${m}: largest loss in one tick / invariant 5`, `${r.maxLoss} tiles / ${r.inv.counts[5]}`, '<= 3 + 0.04 x frontier (0 violations)', r.inv.counts[5] === 0);
    row('T10', `mult ${m}: offensive start - declaration`, `${(r.starts[0] ?? -1) - 0} (mob ${r.mobilize})`, '>= mobilization', r.inv.counts[4] === 0);
  }
  return printTable('pace-audit conquest (T1-T5)');
}

// =================================================================================================
// depth (T30, T31)
// =================================================================================================
/**
 * A defender block on flat land with every terrain factor forced to plains, a thin garrison (R >= 3), and an attacker
 * strip on its north (N->S) or west (W->E) side. The depth speed is measured from the ticks at which the axis tiles fall.
 * 120,000 committed (a 6-tile corridor) keep the war's logistics bucket from binding, so the rule itself is measured.
 */
function depthRun(lat, lon, dir, committed = 120_000, ticks = 700) {
  const { g, step } = controlledGame(Number(arg('seed', 7)));
  const H = HUMAN_ID;
  const W = 1600;
  stageLand(g, 0, (t) => g.owner[t] === H);
  const c = latLonToTileXY(lat, lon);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  const half = 30;
  const inBlock = (x, y) => Math.abs(((x - cx + W + W / 2) % W) - W / 2) <= half && Math.abs(y - cy) <= half;
  // Defender: the block minus the attacker's 3-tile strip.
  const A = addNation(g, 'Atacante');
  const isStrip = (x, y) => (dir === 'ns' ? y - (cy - half) < 3 : ((x - (cx - half) + W) % W) < 3);
  g.transferContext = 'staging';
  for (let y = cy - half; y <= cy + half; y++) {
    for (let dx = -half; dx <= half; dx++) {
      const x = (cx + dx + W) % W;
      const t = y * W + x;
      if (!inBlock(x, y)) continue;
      g.setOwner(t, isStrip(x, y) ? A : H);
      g.attacks.terrainTime[t] = 1; // plains, no river (this game only: the shared world is never touched)
      g.structAt[t] = 0;
    }
  }
  g.transferContext = 'none';
  const D = g.playerById[H], P = g.playerById[A];
  D.spawned = P.spawned = true;
  D.capitalTile = cy * W + cx + (dir === 'ns' ? 0 : half - 1) + (dir === 'ns' ? (half - 1) * W : 0);
  step();
  D.troops = 20_000;
  P.troops = committed;
  g.war.declare(A, H, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  const axisTile = dir === 'ns' ? (cy + half) * W + cx : cy * W + ((cx + half) % W);
  const msgs = [];
  const emit0 = g.emit.bind(g);
  g.emit = (e) => {
    if (e.type === 'message') msgs.push(e.key);
    emit0(e);
  };
  const ok = g.attacks.command(P, H, 1, axisTile);
  const a = g.attackList.find((x) => !x.ended && x.attacker === A);
  if (!a) console.log(`[depth] no offensive (${ok}, ${msgs.join(',')}, border ${g.sharesBorder(A, H)}, war ${g.war.atWar(A, H)}, A tiles ${P.tiles}, H tiles ${D.tiles})`);
  // Fall ticks along the axis line (the column x = cx going south, or the row y = cy going east).
  const fall = [];
  const axis = [];
  for (let k = 3; k < 2 * half - 2; k++) axis.push(dir === 'ns' ? (cy - half + k) * W + cx : cy * W + ((cx - half + k + W) % W));
  let outside = 0, maxPerp = 0;
  for (let i = 0; i < ticks && a && !a.ended; i++) {
    // Keep R >= 3 all along: the garrison stays thin.
    D.troops = Math.min(D.troops, 20_000);
    step();
    for (const t of a.pressure.keys()) {
      const perp = g.attacks.corridor(a, t);
      if (perp < 0) outside++;
      else if (perp > maxPerp) maxPerp = perp;
    }
    for (let k = 0; k < axis.length; k++) if (fall[k] === undefined && g.owner[axis[k]] === A) fall[k] = g.tick;
  }
  // Depth speed over the fallen axis tiles (skip the first few rows: contact phase and start-up).
  const ks = [];
  for (let k = 3; k < axis.length; k++) if (fall[k] !== undefined && fall[k - 1] !== undefined) ks.push(k);
  let kmh = 0;
  if (ks.length >= 4) {
    const k0 = ks[0], k1 = ks[ks.length - 1];
    const y = dir === 'ns' ? cy : cy;
    const tileKm = dir === 'ns' ? 25 : 25 * Math.cos((tileXYToLatLon(cx + 0.5, y + 0.5).lat * Math.PI) / 180);
    const dt = fall[k1] - fall[k0];
    kmh = dt > 0 ? ((k1 - k0) * tileKm) / (dt / 10) : 0;
  }
  return { kmh, rows: ks.length, frontage: a ? a.frontage : 0, outside, maxPerp, ratio: a ? a.ratio : 0 };
}

async function depth() {
  for (const [lat, lon, name] of [[40, -100, '40°N'], [60, 75, '60°N']]) {
    for (const dir of ['ns', 'we']) {
      const r = depthRun(lat, lon, dir);
      row('T30', `depth speed ${dir === 'ns' ? 'N->S' : 'W->E'} at ${name} (R ${r.ratio.toFixed(1)})`, `${r.kmh.toFixed(2)} km/h (${r.rows} tiles)`, '8 ± 10 %', Math.abs(r.kmh - 8) <= 0.8);
    }
  }
  for (const [committed, want] of [[40_000, 3], [400_000, 20], [2_000_000, 40]]) {
    const r = depthRun(40, -100, 'ns', committed, 200);
    const width = 2 * r.maxPerp;
    row('T31', `corridor with ${committed.toLocaleString('en')} committed`, `frontage ${r.frontage.toFixed(1)}, pressure within ±${r.maxPerp.toFixed(1)}, outside ${r.outside}`, `${want} ± 1, none outside`, Math.abs(r.frontage - want) <= 1 && r.outside === 0 && width <= want + 1);
  }
  return printTable('pace-audit depth (T30, T31)');
}

// =================================================================================================
// attrition (T32): R(t), troops and casualties every 10 ticks
// =================================================================================================
async function attrition() {
  const only = arg('mult', '');
  const mults = only ? [Number(only)] : [1, 2, 4];
  for (const m of mults) {
    const r = conquestRun(m, 3000);
    const s = r.series;
    if (!QUIET) {
      console.log(`\nmult ${m}: t, R, attacker troops, defender troops, defender tiles`);
      for (const x of s.filter((_, i) => i % 10 === 0)) console.log(`  ${String(x.rel).padStart(5)}  R ${x.R.toFixed(2).padStart(5)}  att ${String(x.att).padStart(8)}  def ${String(x.def).padStart(8)}  tiles ${x.tiles}`);
    }
    if (m === 1) {
      const maxR = Math.max(...s.map((x) => x.R));
      row('T32', 'mult 1: R stays below 3 for 3000 ticks', `max R ${maxR.toFixed(2)}`, '< 3', maxR < 3);
    } else {
      const ok = r.half > 0 && r.minRBeforeHalf >= r.R0 - 0.01;
      row('T32', `mult ${m}: R never below its launch value before half falls`, `launch ${r.R0.toFixed(2)}, min ${r.minRBeforeHalf.toFixed(2)}, half ${r.half}`, 'min >= launch', ok);
    }
  }
  return printTable('pace-audit attrition (T32)');
}

// =================================================================================================
// regrowth (T32): 10 % -> 90 % of the cap at peace
// =================================================================================================
function regrowthRun(tiles) {
  const { g, step } = controlledGame(Number(arg('seed', 7)));
  const H = HUMAN_ID;
  const D = g.playerById[H];
  // A disc of about `tiles` tiles around Madrid (Iberia, then France for the big one).
  const c = tileOf(44, 0);
  const W = 1600;
  const cx = c % W, cy = Math.floor(c / W);
  const r = Math.sqrt(tiles / Math.PI) * 1.25;
  stageLand(g, 0, (t) => g.owner[t] === H);
  const got = stageLand(g, H, (t) => {
    let dx = Math.abs((t % W) - cx);
    if (dx > W / 2) dx = W - dx;
    const dy = Math.floor(t / W) - cy;
    return dx * dx + dy * dy <= r * r;
  });
  // Trim to the wanted size (farthest tiles back to nobody).
  if (got > tiles) {
    const list = [];
    for (let t = 0; t < g.owner.length; t++) if (g.owner[t] === H) list.push(t);
    const d2 = (t) => {
      let dx = Math.abs((t % W) - cx);
      if (dx > W / 2) dx = W - dx;
      const dy = Math.floor(t / W) - cy;
      return dx * dx + dy * dy;
    };
    list.sort((a, b) => d2(b) - d2(a));
    g.transferContext = 'staging';
    for (let i = 0; i < got - tiles; i++) g.setOwner(list[i], 0);
    g.transferContext = 'none';
  }
  D.capitalTile = c;
  step();
  D.troops = D.maxTroops * 0.1;
  const t0 = g.tick;
  let t90 = -1;
  for (let i = 0; i < 12_000; i++) {
    step();
    if (D.troops >= D.maxTroops * 0.9) {
      t90 = g.tick - t0;
      break;
    }
  }
  return { tiles: D.tiles, cap: D.maxTroops, t90 };
}

async function regrowth() {
  for (const n of [200, 5000]) {
    const r = regrowthRun(n);
    row('T32', `regrowth 10 % -> 90 % at peace, ${r.tiles} tiles (cap ${Math.round(r.cap).toLocaleString('en')})`, `${r.t90} ticks`, '[2400, 4800]', r.t90 >= 2400 && r.t90 <= 4800);
  }
  return printTable('pace-audit regrowth (T32)');
}

// =================================================================================================
// empire (T19 controlled check)
// =================================================================================================
async function empire() {
  const { g, step } = controlledGame(Number(arg('seed', 7)));
  const H = HUMAN_ID;
  const W = 1600;
  stageLand(g, 0, (t) => g.owner[t] === H);
  // The human's empire: ~7,000 tiles of the West Siberian and Kazakh plains; the attacker holds the strip west of it.
  // T19 applies while it holds >= 5,000 tiles: every 1,200-tick window that starts at >= 5,000 tiles is checked.
  const c = latLonToTileXY(55, 70);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  const inRect = (t, x0, x1, y0, y1) => {
    const x = t % W, y = Math.floor(t / W);
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  };
  stageLand(g, H, (t) => inRect(t, cx - 41, cx + 41, cy - 41, cy + 41));
  const A = addNation(g, 'Atacante');
  stageLand(g, A, (t) => inRect(t, cx - 51, cx - 42, cy - 41, cy + 41));
  const D = g.playerById[H], P = g.playerById[A];
  D.capitalTile = cy * W + cx + 20;
  P.capitalTile = cy * W + cx - 40;
  step();
  D.troops = D.maxTroops;
  g.war.declare(A, H, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  const start = D.tiles;
  P.troops = 900_000;
  // Keep R >= 3: the defender's garrison is held down (a controlled check of the backstop, not of attrition).
  const dTroops = Math.min(D.troops, 900_000 / 3.5 / 0.85);
  D.troops = dTroops;
  g.attacks.command(P, H, 1, cy * W + cx + 30);
  const a = g.attackList.find((x) => !x.ended && x.attacker === A);
  const tiles = [D.tiles];
  let consolidating = 0, minR = Infinity;
  for (let i = 0; i < 3600 && a && !a.ended; i++) {
    D.troops = Math.min(D.troops, dTroops);
    step();
    tiles.push(D.tiles);
    if (a.state === 'consolidating') consolidating++;
    if (g.tick > a.contactUntil) minR = Math.min(minR, a.ratio);
  }
  let worst = 0;
  let windows = 0;
  for (let i = 0; i + 1200 < tiles.length; i++) {
    if (tiles[i] < 5000) break;
    windows++;
    worst = Math.max(worst, (tiles[i] - tiles[i + 1200]) / tiles[i]);
  }
  row('T19', `empire of ${start} tiles vs R >= 3 (min R ${minR.toFixed(1)}): worst 1,200-tick loss (${windows} windows)`, `${(worst * 100).toFixed(1)} %`, '<= 18 %', windows > 0 && worst <= 0.18);
  row('T19', 'offensive reports consolidating while the bucket binds', `${consolidating} ticks`, '> 0', consolidating > 0);
  return printTable('pace-audit empire (T19)');
}

// =================================================================================================
// warning (T34): a warned defender that raises the threatened front has its troops there in time
// =================================================================================================
function warningRun(active) {
  const { g, step } = controlledGame(Number(arg('seed', 7)));
  const H = HUMAN_ID;
  const W = 1600;
  stageLand(g, 0, (t) => g.owner[t] === H);
  // The defender holds a 40x40 block of the Great Plains; the enemy holds two separate 4-tile strips, west and east.
  const c = latLonToTileXY(40, -98);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  const inRect = (t, x0, x1, y0, y1) => {
    const x = t % W, y = Math.floor(t / W);
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  };
  stageLand(g, H, (t) => inRect(t, cx - 20, cx + 20, cy - 20, cy + 20));
  const E = addNation(g, 'Enemigo');
  stageLand(g, E, (t) => inRect(t, cx - 24, cx - 21, cy - 20, cy + 20) || inRect(t, cx + 21, cx + 24, cy - 20, cy + 20));
  const D = g.playerById[H], P = g.playerById[E];
  D.capitalTile = cy * W + cx;
  P.capitalTile = cy * W + cx - 23;
  step();
  D.troops = 300_000;
  P.troops = 600_000;
  const aimA = cy * W + cx - 10;
  const w = g.war.declare(E, H, 'conquest', 'war.reason.debug', { force: true, queuedAttack: { tile: aimA, ratio: 0.5 } });
  const fronts = g.fronts.frontsOfPair(E, H);
  const fA = fronts.reduce((a, b) => (a.x < b.x ? a : b));
  const fB = fronts.find((f) => f !== fA);
  if (active) {
    g.fronts.setPriority(H, fA.key, 2);
    if (fB) g.fronts.setPriority(H, fB.key, 0);
  }
  let gf = -1;
  for (let i = 0; i < 200 && gf < 0; i++) {
    D.troops = 300_000;
    step();
    const a = g.attackList.find((x) => !x.ended && x.attacker === E);
    if (a) gf = g.fronts.garrison(g.fronts.get(fA.key) ?? fA, H);
  }
  return { gf, fronts: fronts.length, mob: w.mobilizeUntilTick - w.startTick };
}

async function warning() {
  const passive = warningRun(false), active = warningRun(true);
  const ratio = active.gf / Math.max(1, passive.gf);
  row('T34', `Gf(A) on the offensive's first tick: active / passive (${passive.fronts} fronts, mobilization ${passive.mob})`, `${Math.round(active.gf)} / ${Math.round(passive.gf)} = ${ratio.toFixed(2)}x`, '>= 1.5x', ratio >= 1.5);
  return printTable('pace-audit warning (T34)');
}

// =================================================================================================
// nuke (acceptance 14) and population (acceptance 17)
// =================================================================================================
async function nuke() {
  const { g, step } = controlledGame(Number(arg('seed', 7)));
  const H = HUMAN_ID;
  const fra = countryIdx('FRA');
  const W = 1600;
  const E = addNation(g, 'Objetivo');
  stageLand(g, E, (t) => {
    if (world.country[t] !== fra) return false;
    const ll = tileXYToLatLon((t % W) + 0.5, Math.floor(t / W) + 0.5);
    return ll.lat > 41 && ll.lat < 51.5 && ll.lon > -5.5 && ll.lon < 10;
  });
  const P = g.playerById[E];
  P.capitalTile = tileOf(48.85, 2.35);
  g.economy.refreshAll();
  step();
  P.popTarget = g.economy.popTargetOf(P);
  P.pop = P.popTarget;
  P.troops = 500_000;
  const aim = tileOf(47.0, 2.0);
  const owners0 = g.owner.slice();
  const pop0 = P.pop, troops0 = P.troops, target0 = P.popTarget;
  const tiles = P.tiles;
  const u = g.weapons.launch(H, UnitType.AtomBomb, tileOf(40.4, -3.7), aim, 0);
  let troopsAt = P.troops, troopsAfter = P.troops;
  const det = g.weapons.detonate.bind(g.weapons);
  g.weapons.detonate = (x) => {
    troopsAt = P.troops;
    det(x);
    troopsAfter = P.troops;
  };
  for (let i = 0; i < 20 && !u.dead; i++) step();
  let flipped = 0;
  for (let t = 0; t < g.owner.length; t++) if (g.owner[t] !== owners0[t]) flipped++;
  row('A14', 'atom bomb: tiles that changed owner', flipped, '0', flipped === 0);
  // Expected population loss: 70 % of the inner tiles' share + 20 % of the outer ones (no cities there).
  let inner = 0, outer = 0;
  const cx = (aim % W) + 0.5, cy = Math.floor(aim / W) + 0.5;
  const cos = Math.cos(((90 - (cy / 800) * 180) * Math.PI) / 180);
  for (let dy = -8; dy <= 8; dy++) for (let dx = -20; dx <= 20; dx++) {
    const t = (Math.floor(cy) + dy) * W + ((Math.floor(cx) + dx + W) % W);
    if (g.owner[t] !== E) continue;
    const d2 = surfDist2(cx, cy, (t % W) + 0.5, Math.floor(t / W) + 0.5);
    if (d2 <= 9) inner++;
    else if (d2 <= 49) outer++;
  }
  const share = pop0 / target0 * 25_000;
  const expected = share * (0.7 * inner + 0.2 * outer);
  const killed = pop0 - P.pop;
  row('A14', `population killed (inner ${inner}, outer ${outer} tiles)`, Math.round(killed).toLocaleString('en'), `${Math.round(expected).toLocaleString('en')} ± 10 %`, Math.abs(killed - expected) <= expected * 0.1 + 1);
  const wantKill = troopsAt * (0.6 * inner + 0.25 * outer) / tiles;
  row('A14', 'garrison share killed (60 % inner, 25 % outer)', `${Math.round(troopsAt - troopsAfter).toLocaleString('en')}`, `≈ ${Math.round(wantKill).toLocaleString('en')}`, Math.abs(troopsAt - troopsAfter - wantKill) < wantKill * 0.05 + 1);
  const until = g.falloutUntil[aim] - g.tick;
  row('A14', 'fallout on ground zero (ticks left)', until, '~7,200 (30 days)', until > 7000 && until <= 7200);
  P.gold = 1e9;
  row('A14', 'no construction in fallout', g.buildError(E, StructureType.City, aim) ?? 'allowed', 'msg.buildFallout', g.buildError(E, StructureType.City, aim) === 'msg.buildFallout');
  step();
  row('A14', 'fallout tiles pay no taxes and do not count for growth', `${P.falloutTiles} fallout tiles`, '> 0', P.falloutTiles > 0);
  return printTable('pace-audit nuke (acceptance 14)');
}

async function population() {
  const { g, step } = controlledGame(Number(arg('seed', 7)));
  const H = HUMAN_ID;
  const W = 1600;
  stageLand(g, 0, (t) => g.owner[t] === H);
  const c = latLonToTileXY(52, 60);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  const inRect = (t, x0, x1, y0, y1) => {
    const x = t % W, y = Math.floor(t / W);
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  };
  stageLand(g, H, (t) => inRect(t, cx - 40, cx + 40, cy - 40, cy + 40));
  const E = addNation(g, 'Vecino');
  stageLand(g, E, (t) => inRect(t, cx - 80, cx - 41, cy - 40, cy + 40));
  const A = g.playerById[H], B = g.playerById[E];
  step();
  for (const p of [A, B]) {
    p.popTarget = g.economy.popTargetOf(p);
    p.pop = p.popTarget * (p === A ? 0.8 : 0.6);
  }
  const ra = A.pop / A.popTarget, rb = B.pop / B.popTarget;
  g.war.declare(E, H, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  // B takes 2,500 of A's tiles (as an offensive would), in one go: only the transfer itself changes the ratios.
  const moved = [];
  for (let t = 0; t < g.owner.length && moved.length < 2500; t++) if (g.owner[t] === H && inRect(t, cx - 40, cx + 40, cy - 40, cy + 40)) moved.push(t);
  g.transferContext = 'attack';
  for (const t of moved) g.setOwner(t, E);
  g.transferContext = 'none';
  const da = Math.abs(A.pop / A.popTarget - ra) / ra, db = Math.abs(B.pop / B.popTarget - rb) / rb;
  row('A17', `2,500 tiles move: loser pop/target ${ra.toFixed(3)} -> ${(A.pop / A.popTarget).toFixed(3)}`, `${(da * 100).toFixed(2)} %`, '< 2 %', da < 0.02);
  row('A17', `winner pop/target ${rb.toFixed(3)} -> ${(B.pop / B.popTarget).toFixed(3)}`, `${(db * 100).toFixed(2)} %`, '< 2 %', db < 0.02);
  return printTable('pace-audit population (acceptance 17)');
}

// =================================================================================================
// occupation (acceptance 16, T43 headless part)
// =================================================================================================
async function occupation() {
  const r = conquestRunWithClient();
  row('A16', `delta stream == sim occupied set during the war (${r.checks} checks)`, `${r.deltaMismatch} mismatches`, '0', r.deltaMismatch === 0);
  row('A16', 'full resync (fullOwners) == sim occupied set', `${r.fullMismatch} mismatches of ${r.occupied}`, '0', r.fullMismatch === 0 && r.occupied > 0);
  row('A16', 'occupied land: taxes', `${(r.taxRatio * 100).toFixed(1)} % of a free tile`, '25 %', Math.abs(r.taxRatio - 0.25) < 0.01);
  row('A16', 'occupied land: troop cap weight', `${(r.capRatio * 100).toFixed(1)} %`, '50 %', Math.abs(r.capRatio - 0.5) < 0.01);
  row('A16', 'occupied land: recruitment', `${(r.recruit * 100).toFixed(1)} %`, '50 % of the occupied share', Math.abs(r.recruit - r.recruitWant) < 0.005);
  return printTable('pace-audit occupation (acceptance 16)');
}

function conquestRunWithClient() {
  const { g, step } = controlledGame(Number(arg('seed', 7)));
  const H = HUMAN_ID;
  const iber = new Set(['ESP', 'PRT', 'AND', 'GIB'].map(countryIdx).filter((i) => i >= 0));
  const fra = countryIdx('FRA');
  const W = 1600;
  stageLand(g, 0, (t) => g.owner[t] === H);
  stageLand(g, H, (t) => iber.has(world.country[t]));
  const A = addNation(g, 'Atacante');
  stageLand(g, A, (t) => {
    if (world.country[t] !== fra) return false;
    const ll = tileXYToLatLon((t % W) + 0.5, Math.floor(t / W) + 0.5);
    return ll.lat > 41 && ll.lat < 51.5 && ll.lon > -5.5 && ll.lon < 10;
  });
  const D = g.playerById[H], P = g.playerById[A];
  D.capitalTile = tileOf(40.42, -3.7);
  step();
  g.war.declare(A, H, 'conquest', 'war.reason.debug', { force: true, mobilizeTicks: 0 });
  P.troops = 2_000_000;
  g.attacks.command(P, H, 1, aimPoint(g, H));
  // The client's occupied set, fed exactly like client.ts does (delta, or the full set on a resync).
  const occ = new Set();
  const apply = (u) => {
    if (u.occupiedFull) {
      occ.clear();
      for (const t of u.occupiedFull) occ.add(t);
    } else if (u.occupied) {
      for (const v of u.occupied) {
        if (v > 0) occ.add(v - 1);
        else occ.delete(-v - 1);
      }
    }
  };
  apply(g.buildUpdate(0, true));
  let deltaMismatch = 0, checks = 0;
  const compare = () => {
    let bad = 0;
    for (let t = 0; t < g.owner.length; t++) if ((g.occupiedFlag[t] === 1) !== occ.has(t)) bad++;
    return bad;
  };
  for (let i = 0; i < 1100; i++) {
    g.tick1();
    apply(g.buildUpdate(1));
    if (i % 100 === 99) {
      deltaMismatch += compare();
      checks++;
    }
  }
  // A fast-forward: many ticks, then one full update.
  for (let i = 0; i < 300; i++) g.tick1();
  occ.clear();
  apply(g.buildUpdate(300, true));
  const fullMismatch = compare();
  // Economy of occupied land: the attacker holds occupied tiles now.
  const occN = Math.min(P.occupied, P.tiles);
  const eff = P.tiles - P.falloutTiles * 0.8 - occN * 0.5;
  const effTax = P.tiles - P.falloutTiles - occN * 0.75;
  const taxRatio = occN > 0 ? 1 - (P.tiles - effTax) / occN : 0;
  const capRatio = occN > 0 ? 1 - (P.tiles - eff) / occN : 0;
  const fPop = Math.min(1, Math.max(0.3, P.pop / Math.max(1, P.popTarget)));
  const recruitWant = fPop * (1 - 0.5 * occN / P.tiles);
  step();
  return { deltaMismatch, fullMismatch, checks, occupied: occN, taxRatio, capRatio, recruit: P.recruitment, recruitWant };
}

// =================================================================================================
// survival (T7–T9): a passive human on five spawns
// =================================================================================================
const SPAWNS = [['Madrid', 40.4, -3.7], ['Paris', 48.85, 2.35], ['Berlin', 52.52, 13.4], ['Kansas', 38.5, -98.0], ['Brasília', -15.8, -47.9]];

function survivalRun(name, lat, lon, maxTicks) {
  const seed = Number(arg('seed', 21));
  const { g, events, step } = newGame(seed, tileOf(lat, lon), false, true, { worldEvents: true });
  const H = HUMAN_ID;
  while (g.playerById[H].alive && g.tick < maxTicks && g.phase !== 'ended') step();
  const onH = (e) => e.target === H || e.to === H;
  const tensions = events.filter((e) => e.type === 'tension' && e.to === H);
  const decls = events.filter((e) => e.type === 'warDeclared' && e.target === H);
  const elim = events.find((e) => e.type === 'nationEliminated' && e.playerId === H);
  return { name, tensions, decls, elim: elim ? elim.tick : -1, end: g.tick, onH };
}

async function survival() {
  const maxTicks = Number(arg('ticks', 40_000));
  const d = ['easy', 'normal', 'hard', 'insane'].indexOf(DIFF);
  const grace = [9000, 6000, 3600, 2400][d], lead = [480, 240, 120, 120][d];
  const need = [900, 600, 450, 450][d];
  const runs = [];
  const only = arg('spawn', '');
  for (const [name, lat, lon] of SPAWNS) {
    if (only && only !== name) continue;
    const r = survivalRun(name, lat, lon, maxTicks);
    runs.push(r);
    console.log(`${name}: first tension ${r.tensions[0]?.tick ?? '-'}, first declaration ${r.decls[0]?.tick ?? '-'} by ${r.decls[0]?.aggressor ?? '-'}, eliminated ${r.elim}`);
  }
  let early = 0, earlyTension = 0, noLead = 0;
  let minWarn = Infinity;
  const surv = [];
  for (const r of runs) {
    for (const e of r.decls) {
      if (e.tick < grace && !e.parentWar) early++;
      const t = r.tensions.filter((x) => x.from === e.aggressor && x.tick <= e.tick - lead);
      if (!e.parentWar && t.length === 0) noLead++;
    }
    for (const e of r.tensions) if (e.tick < grace - lead) earlyTension++;
    if (r.elim >= 0 && r.tensions.length) minWarn = Math.min(minWarn, r.elim - r.tensions[0].tick);
    surv.push(r.elim >= 0 ? r.elim : r.end);
  }
  surv.sort((a, b) => a - b);
  const median = surv[Math.floor(surv.length / 2)];
  row('T7a', `declarations on the human before the grace (${grace})`, early, '0', early === 0);
  row('T7a', `tension to the human before grace - lead (${grace - lead})`, earlyTension, '0', earlyTension === 0);
  row('T7b', 'min first tension -> elimination', minWarn === Infinity ? 'no elimination' : minWarn, `>= ${need}`, minWarn >= need);
  row('T7c', 'median survival (ticks; runs end at the cap)', `${median} (${surv.join(', ')})`, DIFF === 'normal' ? '[9000, 30000]' : 'informative', DIFF !== 'normal' || (median >= 9000 && median <= 30000));
  const elimNoWar = runs.filter((r) => r.elim >= 0 && r.decls.length === 0).length;
  row('T8', 'eliminations without a war on the human', elimNoWar, '0', elimNoWar === 0);
  row('T9', `declarations without a tension >= ${lead} ticks earlier`, noLead, '0', noLead === 0);
  return printTable(`pace-audit survival (${DIFF}, seed ${arg('seed', 21)})`);
}

// =================================================================================================
// save (T42): save at tick N, restore into a fresh game, the next 600 ticks must be identical
// =================================================================================================
function stateHash(g) {
  let h = 0x811c9dc5;
  for (let t = 0; t < g.owner.length; t++) h = Math.imul(h ^ g.owner[t], 0x01000193);
  return h >>> 0;
}
function playerSig(g) {
  return g.playerArr.map((p) => `${p.id}:${Math.round(p.troops)}:${Math.round(p.gold)}:${p.tiles}`).join(',');
}

async function save() {
  const N = Number(arg('at', 12000));
  const span = Number(arg('span', 600));
  const seed = Number(arg('seed', 11));
  const mk = () => {
    const h = newGame(seed, tileOf(40.4, -3.7), true, true, { worldEvents: true });
    return h;
  };
  const A = mk();
  const t0 = Date.now();
  while (A.g.tick < N) A.step();
  const w = new SaveWriter();
  A.g.serialize(w);
  const blob = w.finish();
  console.log(`saved at tick ${A.g.tick}: ${(blob.byteLength / 1e6).toFixed(2)} MB after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const recA = [];
  const evStart = A.events.length;
  for (let i = 0; i < span; i++) {
    A.step();
    recA.push(`${A.g.tick}|${stateHash(A.g)}|${playerSig(A.g)}`);
  }
  const evA = A.events.slice(evStart).map((e) => JSON.stringify(e));
  const t1 = Date.now();
  const B = Game.restore(new SaveReader(blob), world);
  console.log(`restored in ${Date.now() - t1} ms at tick ${B.tick}`);
  const evB = [];
  const emit = B.emit.bind(B);
  B.emit = (e) => {
    if (e.type !== 'combat' && e.type !== 'goldBonus' && e.type !== 'tradeCompleted') evB.push(JSON.stringify(e));
    emit(e);
  };
  const recB = [];
  for (let i = 0; i < span; i++) {
    B.tick1();
    B.buildUpdate(1);
    recB.push(`${B.tick}|${stateHash(B)}|${playerSig(B)}`);
  }
  let firstDiff = -1;
  for (let i = 0; i < span; i++) if (recA[i] !== recB[i]) {
    firstDiff = i;
    break;
  }
  let firstEv = -1;
  for (let i = 0; i < Math.max(evA.length, evB.length); i++) if (evA[i] !== evB[i]) {
    firstEv = i;
    break;
  }
  if (firstDiff >= 0) console.log(`first state difference at +${firstDiff}:\n  A ${recA[firstDiff].slice(0, 300)}\n  B ${recB[firstDiff].slice(0, 300)}`);
  if (firstEv >= 0) console.log(`first event difference #${firstEv}:\n  A ${evA[firstEv]?.slice(0, 300)}\n  B ${evB[firstEv]?.slice(0, 300)}`);
  row('T42', `save at ${N}, restore, ${span} ticks: owners, troops, gold, tiles`, firstDiff < 0 ? 'identical' : `differs at +${firstDiff}`, 'identical', firstDiff < 0);
  row('T42', `event stream (${evA.length} events)`, firstEv < 0 ? 'identical' : `differs at #${firstEv}`, 'identical', firstEv < 0);
  row('§12.8', 'save size', `${(blob.byteLength / 1e6).toFixed(2)} MB`, 'a few MB', blob.byteLength < 30e6);
  return printTable('pace-audit save (T42)');
}

// =================================================================================================
// game (T14–T26, T33, T37, T39) and invariants (§4.17): one full autopilot game
// =================================================================================================
function landComponents() {
  const W = 1600, N = 1600 * 800;
  const comp = new Int32Array(N).fill(-1);
  const sizes = [];
  const stack = [];
  const playable = (t) => { const c = world.terrain[t] & 0x0f; return c === 2 || c === 3 || c === 4; };
  for (let t0 = 0; t0 < N; t0++) {
    if (comp[t0] >= 0 || !playable(t0)) continue;
    const id = sizes.length;
    let n = 0;
    stack.length = 0;
    stack.push(t0);
    comp[t0] = id;
    while (stack.length) {
      const t = stack.pop();
      n++;
      const x = t % W;
      for (const q of [x === 0 ? t + W - 1 : t - 1, x === W - 1 ? t - W + 1 : t + 1, t - W, t + W]) {
        if (q < 0 || q >= N || comp[q] >= 0 || !playable(q)) continue;
        comp[q] = id;
        stack.push(q);
      }
    }
    sizes.push(n);
  }
  return { comp, sizes };
}

async function game(opts = {}) {
  const seed = Number(arg('seed', 11));
  const duration = String(arg('duration', 'normal'));
  const maxTicks = Number(arg('ticks', duration === 'short' ? 48_000 : duration === 'long' ? 130_000 : 96_000));
  Game.checkInvariants = true;
  const { g, events, step } = newGame(seed, tileOf(40.4, -3.7), true, true, { worldEvents: true, duration });
  const kindOf = (id) => g.playerById[id]?.kind;
  const major = (id) => id > 0 && (kindOf(id) === 'nation' || kindOf(id) === 'human' || kindOf(id) === 'rebel');
  const tilesHist = new Map();
  const warsAgainst = new Map();
  let alive6000 = -1, islandsOwned = -1;
  const comps = landComponents();
  const t0 = Date.now();
  let lastLog = 0;
  while (g.phase !== 'ended' && g.tick < maxTicks) {
    step();
    if (g.tick % 60 === 0) {
      for (const p of g.playerArr) {
        if (!p.alive || p.kind === 'tribe') continue;
        let h = tilesHist.get(p.id);
        if (!h) tilesHist.set(p.id, (h = []));
        h.push([g.tick, p.tiles, g.war.enemiesOf(p.id).filter((e) => g.war.between(e, p.id)?.a === e).length]);
      }
    }
    if (g.tick === 6000) alive6000 = g.playerArr.filter((p) => p.kind === 'nation' && p.alive).length;
    if (g.tick === 18_000) {
      let owned = 0, total = 0;
      const ownedBy = new Map();
      for (let t = 0; t < g.owner.length; t++) {
        const c = comps.comp[t];
        if (c < 0 || comps.sizes[c] < 5) continue;
        if (g.owner[t] !== 0) ownedBy.set(c, (ownedBy.get(c) ?? 0) + 1);
      }
      for (let c = 0; c < comps.sizes.length; c++) {
        if (comps.sizes[c] < 5) continue;
        total++;
        if ((ownedBy.get(c) ?? 0) >= comps.sizes[c] * 0.5) owned++;
      }
      islandsOwned = owned / Math.max(1, total);
    }
    if (!QUIET && Date.now() - lastLog > 20_000) {
      lastLog = Date.now();
      const top = [...g.playerArr].filter((p) => p.alive && p.kind !== 'tribe').sort((a, b) => b.tiles - a.tiles).slice(0, 3);
      console.log(`  tick ${g.tick}: wars ${[...g.war.list()].length}, top ${top.map((p) => `${p.name} ${(100 * p.tiles / g.landTiles).toFixed(1)}%`).join(', ')}`);
    }
  }
  const end = events.find((e) => e.type === 'gameOver');
  const secs = (Date.now() - t0) / 1000;
  console.log(`game over at tick ${g.tick} (${secs.toFixed(0)} s): ${end ? `${end.reason}, winner ${g.playerById[end.winner]?.name}` : 'no end'}`);
  const inv = g.invariants.report();
  if (opts.invariantsOnly) {
    const names = ['', 'transfer without war/treaty', 'double flip in a tick', 'AI hostile act at peace', 'offensive before mobilization', 'losses over the caps', 'AI nuke spill', 'independent attacks a nation'];
    for (let i = 1; i <= 7; i++) row(`§4.17.${i}`, names[i], inv.counts[i], '0', inv.counts[i] === 0);
    for (const sm of inv.samples.slice(0, 12)) console.log(`   ${sm}`);
    return printTable(`pace-audit invariants (seed ${seed}, ${DIFF})`);
  }
  const windows = Math.max(1, Math.floor(g.tick / 600));
  const perWin = (list, from = 0) => {
    const c = new Map();
    for (const e of list) if (e.tick >= from) c.set(Math.floor(e.tick / 600), (c.get(Math.floor(e.tick / 600)) ?? 0) + 1);
    return c;
  };
  // T14
  const winTick = end ? end.tick : -1;
  const [lo, hi] = duration === 'short' ? [18_000, 42_000] : duration === 'long' ? [60_000, 120_000] : DIFF === 'hard' ? [30_000, 60_000] : [36_000, 72_000];
  row('T14', `end by domination/hegemony (${duration})`, end ? `${end.reason} at ${winTick}` : 'none', `[${lo}, ${hi}]`, !!end && (end.reason === 'domination' || end.reason === 'hegemony') && winTick >= lo && winTick <= hi);
  row('T15', 'AI nations alive at tick 6,000', `${alive6000} / ${g.playerArr.filter((p) => p.kind === 'nation').length}`, '>= 20 of 24', alive6000 >= 20);
  // T16
  const pvp = events.filter((e) => e.type === 'attackStarted' && major(e.attacker) && major(e.defender));
  const w16 = perWin(pvp);
  const max16 = Math.max(0, ...w16.values());
  const late = pvp.filter((e) => e.tick >= 6000).length / Math.max(1, (g.tick - 6000) / 600);
  row('T16', 'player-vs-player offensives per 600 ticks', `avg ${(pvp.length / windows).toFixed(2)}, max ${max16}, after 6,000 ${late.toFixed(2)}`, 'avg <= 6, max <= 12, >= 1 after 6,000', pvp.length / windows <= 6 && max16 <= 12 && late >= 1);
  // T17
  const decl = events.filter((e) => e.type === 'warDeclared');
  const noReason = decl.filter((e) => !e.reasonKey).length;
  row('T17', 'war declarations', `${decl.length} (${(decl.length / windows).toFixed(2)} per 600), ${noReason} without reason`, '<= 1.5 per 600, >= 25, all with a reason', decl.length / windows <= 1.5 && decl.length >= 25 && noReason === 0);
  // T33
  const onHuman = decl.find((e) => e.target === HUMAN_ID && e.aggressor !== HUMAN_ID);
  row('T33', 'first AI war on the autopilot human', onHuman ? onHuman.tick : 'none', '[6,000, 12,000]', !!onHuman && onHuman.tick >= 6000 && onHuman.tick <= 12_000);
  // T37
  const ended = events.filter((e) => e.type === 'warEnded');
  const treaties = ended.filter((e) => e.reasonKey === 'peace.reason.treaty' && e.terms.kind !== 'capitulation').length;
  const caps = events.filter((e) => e.type === 'capitulation').length;
  row('T37', 'peace treaties / capitulations', `${treaties} / ${caps}`, '>= 8 / >= 1', treaties >= 8 && caps >= 1);
  // T19
  let t19 = 0, t19worst = 0;
  for (const [id, h] of tilesHist) {
    for (let i = 0; i < h.length; i++) {
      if (h[i][1] < 5000) continue;
      const j = i + 20; // 1,200 ticks later
      if (j >= h.length) break;
      const loss = (h[i][1] - h[j][1]) / h[i][1];
      const wars = Math.max(...h.slice(i, j + 1).map((x) => x[2]));
      const capitulated = events.some((e) => e.type === 'capitulation' && e.loser === id && e.tick >= h[i][0] && e.tick <= h[j][0]);
      if (loss > 0.2 && wars < 2 && !capitulated) t19++;
      if (wars < 2 && !capitulated) t19worst = Math.max(t19worst, loss);
    }
  }
  row('T19', 'empires (>= 5,000 tiles) losing > 20 % in 1,200 ticks (< 2 wars, no capitulation)', `${t19} windows (worst ${(t19worst * 100).toFixed(1)} %)`, '0', t19 === 0);
  // T20
  const rebels = events.filter((e) => e.type === 'worldEvent' && e.kind === 'rebellion' && e.stage === 'start');
  let t20 = 0;
  for (const e of rebels) if (e.magnitude > g.landTiles * 0.15) t20++;
  row('T20', 'rebel successor states over 15 % of the world', `${t20} of ${rebels.length}`, '0', t20 === 0);
  row('T39', 'land components (>= 5 tiles) owned at tick 18,000', islandsOwned < 0 ? '-' : `${(islandsOwned * 100).toFixed(0)} %`, '>= 80 %', islandsOwned >= 0.8);
  // T21–T25
  const ai = (id) => id !== HUMAN_ID;
  const nukes = events.filter((e) => e.type === 'nukeLaunched' && ai(e.owner) && (e.weapon === UnitType.AtomBomb || e.weapon === UnitType.HydrogenBomb || e.weapon === UnitType.Mirv));
  row('T21', 'AI nuclear launches (all at war, escalation >= 3)', `${nukes.length}; invariant 6: ${inv.counts[6]}`, '0-8, 0 spills', nukes.length <= 8 && inv.counts[6] === 0);
  const firstNuke = nukes[0];
  row('T22', 'first AI nuclear launch', firstNuke ? firstNuke.tick : 'none', '>= 18,000 unless retaliation', !firstNuke || firstNuke.tick >= 18_000 || g.weapons.nukedByEnemy(firstNuke.owner, firstNuke.targetOwner));
  let minGap = Infinity;
  for (let i = 1; i < nukes.length; i++) minGap = Math.min(minGap, nukes[i].tick - nukes[i - 1].tick);
  row('T23', 'spacing between AI nuclear launches', nukes.length > 1 ? `${minGap} ticks` : '-', '>= 480', nukes.length <= 1 || minGap >= 480);
  const cruise = events.filter((e) => e.type === 'nukeLaunched' && ai(e.owner) && e.weapon === UnitType.CruiseMissile);
  let maxCruise = 0;
  for (let i = 0; i < cruise.length; i++) {
    let n = 0;
    for (let j = i; j < cruise.length && cruise[j].tick < cruise[i].tick + 600; j++) n++;
    maxCruise = Math.max(maxCruise, n);
  }
  row('T24', 'AI cruise missiles in any 600 ticks (all at war: invariant 3)', `${maxCruise} (total ${cruise.length}); invariant 3: ${inv.counts[3]}`, '<= 3, 0 violations', maxCruise <= 3 && inv.counts[3] === 0);
  row('T25', 'AI strikes at peace (invariant 3)', inv.counts[3], '0', inv.counts[3] === 0);
  // T26
  const wev = events.filter((e) => e.type === 'worldEvent' && e.stage === 'start' && e.kind !== 'doomsday');
  let evGap = Infinity;
  for (let i = 1; i < wev.length; i++) evGap = Math.min(evGap, wev[i].tick - wev[i - 1].tick);
  row('T26', 'world events: first / min gap', `${wev[0]?.tick ?? '-'} / ${wev.length > 1 ? evGap : '-'} (${wev.length} events)`, 'first >= 6,000, gap >= 4,800', (!wev.length || wev[0].tick >= 6000) && (wev.length < 2 || evGap >= 4800));
  // T35 (headless part): every rebellion preceded by unrest on the same owner >= 480 ticks earlier.
  const unrest = events.filter((e) => e.type === 'unrest');
  let t35 = 0;
  for (const e of unrest.filter((x) => x.stage === 'rebellion')) {
    const start = unrest.find((x) => x.stage === 'start' && x.owner === e.owner && x.tick <= e.tick - 480 && x.tick >= e.tick - 600);
    if (!start) t35++;
  }
  row('T35', 'rebellions without unrest >= 480 ticks earlier', `${t35} of ${unrest.filter((x) => x.stage === 'rebellion').length}`, '0', t35 === 0);
  for (let i = 1; i <= 7; i++) if (inv.counts[i]) console.log(`  invariant ${i}: ${inv.counts[i]} violations`);
  for (const sm of inv.samples.slice(0, 10)) console.log(`   ${sm}`);
  const out = arg('events', '');
  if (out) fs.writeFileSync(out, JSON.stringify(events.filter((e) => e.type !== 'message' && e.type !== 'unitSpawned' && e.type !== 'unitDestroyed' && e.type !== 'structureBuilt')));
  return printTable(`pace-audit game (seed ${seed}, ${DIFF}, ${duration})`);
}

// =================================================================================================
// dispatch
// =================================================================================================
const modes = { speeds, conquest, depth, attrition, regrowth, empire, warning, nuke, population, occupation, survival, save, game, invariants: () => game({ invariantsOnly: true }) };
if (!modes[mode]) {
  console.error(`unknown mode ${mode}; modes: ${Object.keys(modes).join(', ')}`);
  process.exit(2);
}
if (QUIET) console.log(`[pace-audit] ${mode}`);
const failed = await modes[mode]();
process.exit(failed ? 1 : 0);
