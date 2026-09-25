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
  HUMAN_ID, OFFENSIVE_CONTACT_TICKS, UNIT_DEFS, ballisticFlightTicks, kmhToKmPerTick,
} from '../../shared/constants.ts';
import { greatCircleKm, latLonToTile, latLonToTileXY, tileXYToLatLon } from '../../shared/geo.ts';
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
// dispatch
// =================================================================================================
const modes = { speeds, conquest, depth, attrition, regrowth, empire };
if (!modes[mode]) {
  console.error(`unknown mode ${mode}; modes: ${Object.keys(modes).join(', ')}`);
  process.exit(2);
}
if (QUIET) console.log(`[pace-audit] ${mode}`);
const failed = await modes[mode]();
process.exit(failed ? 1 : 0);
