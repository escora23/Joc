// FRONT ULTRA — headless simulation harness (owner: sim-core). Test tooling only, never bundled.
//
//   npx tsx src/sim/test/harness.mjs [--ais 40] [--tribes 30] [--minutes 15] [--seed 1337] [--difficulty hard]
//                                    [--fallback] [--quiet] [--nukes 0] [--events 0]
//
// Runs a full game (the AI also plays the human) at maximum speed in Node, exactly like the worker does
// (tick1 + buildUpdate every 4 ticks), prints leaderboards over time, per-minute tick timings, event counts and
// sanity checks (exceptions, invariants, dynamics). Exits with code 1 when a check fails.

import { performance } from 'node:perf_hooks';
import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID, MAP_W, TILE_COUNT, DEFAULT_START_WORLD_TIME } from '../../shared/constants.ts';
import { PF, PLAYER_STRIDE, UNIT_STRIDE, UF, tickUpdateTransferables } from '../../shared/protocol.ts';
import { latLonToTile } from '../../shared/geo.ts';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const AIS = Number(arg('ais', 40));
const TRIBES = Number(arg('tribes', 30));
const MINUTES = Number(arg('minutes', 15));
const SEED = Number(arg('seed', 1337));
const DIFF = String(arg('difficulty', 'hard'));
const QUIET = !!arg('quiet', false);
const FALLBACK = !!arg('fallback', false);
const NUKES = String(arg('nukes', '1')) !== '0';
const EVENTS = String(arg('events', '1')) !== '0';
const TICKS = Math.round(MINUTES * 600);

const world = await loadWorldInit();
console.log(`[harness] world ${world.width}x${world.height}, ${world.landTiles} land tiles, ${world.countries.length} countries`);

Game.withFallbackAi = FALLBACK;
const config = {
  seed: SEED, playerName: 'Harness', playerColor: 0x2f6fd6, difficulty: DIFF, aiCount: AIS, tribeCount: TRIBES, speed: 4,
  nukes: NUKES, worldEvents: EVENTS, startWorldTimeSec: DEFAULT_START_WORLD_TIME, spawnTimeoutTicks: 300,
  autoSpawnTile: latLonToTile(40.4, -3.7), instantStart: true, humanAutopilot: true,
};

const errors = [];
const t0 = performance.now();
const game = new Game(config, world);
game.onError = (msg, stack) => {
  errors.push(msg);
  if (errors.length <= 12) console.error(`[harness] sim error: ${msg}\n${(stack ?? '').split('\n').slice(0, 6).join('\n')}`);
};
console.log(`[harness] Game constructed in ${(performance.now() - t0).toFixed(0)} ms: ${game.playerArr.length} players (${FALLBACK ? 'fallback AI' : 'sim-ai director'})`);

// Per-system profiling: wrap the step functions of every system and keep total / max / spike counts.
const prof = new Map();
function wrap(obj, key, label) {
  const fn = obj[key];
  if (typeof fn !== 'function') return;
  const rec = { total: 0, max: 0, calls: 0, over5: 0 };
  prof.set(label, rec);
  obj[key] = function (...a) {
    const t = performance.now();
    try {
      return fn.apply(this, a);
    } finally {
      const d = performance.now() - t;
      rec.total += d;
      rec.calls++;
      if (d > rec.max) rec.max = d;
      if (d > 5) rec.over5++;
    }
  };
}
wrap(game.attacks, 'step', 'attacks');
wrap(game.enclaves, 'step', 'enclaves');
wrap(game.unitSys, 'step', 'units');
wrap(game.weapons, 'step', 'weapons');
wrap(game.economy, 'step', 'economy');
wrap(game.diplomacy, 'step', 'diplomacy');
wrap(game.labels, 'stage', 'labels');
wrap(game.fronts, 'update', 'fronts');
wrap(game.ai, 'tick', 'ai');
wrap(game.worldEvents, 'tick', 'worldEvents');
wrap(game.nav, 'findPath', 'nav.findPath');
function printProfile() {
  const rows = [...prof.entries()].filter(([, r]) => r.calls > 0).sort((a, b) => b[1].total - a[1].total);
  console.log('[harness] system profile (total ms · mean · max · calls>5ms):');
  for (const [k, r] of rows) console.log(`    ${k.padEnd(14)} ${r.total.toFixed(0).padStart(7)} · ${(r.total / r.calls).toFixed(3).padStart(7)} · ${r.max.toFixed(2).padStart(7)} · ${r.over5}`);
}

const eventCounts = new Map();
const perMinute = [];
let minuteTimes = [];
let updateBytes = 0, updates = 0, maxOwners = 0, fullResyncs = 0;
let ownerChanges = 0;
const allTimes = [];
const packTimes = [];

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toString();
}

function leaderboard(tick) {
  const alive = game.playerArr.filter((p) => p.alive && p.spawned).sort((a, b) => b.tiles - a.tiles);
  const units = new Map();
  for (const u of game.unitMap.values()) units.set(u.type, (units.get(u.type) ?? 0) + 1);
  const lines = [];
  lines.push(`\n=== t=${(tick / 600).toFixed(1)} min (tick ${tick}) · alive ${alive.length}/${game.playerArr.length} · attacks ${game.attackList.length} · units ${game.unitMap.size} · structures ${game.structureMap.size} · scars ${game.scars.length} · doomsday ${game.doomsdayLevel.toFixed(2)}`);
  lines.push('  #  name                        kind     land%   tiles   troops/max        gold      income/s  str  units');
  for (let i = 0; i < Math.min(12, alive.length); i++) {
    const p = alive[i];
    const nUnits = (game.unitsByOwner.get(p.id) ?? []).length;
    const nStr = (game.structByOwner.get(p.id) ?? []).length;
    lines.push(
      `  ${String(i + 1).padStart(2)} ${(p.id === HUMAN_ID ? '*' : ' ') + p.name.slice(0, 26).padEnd(27)} ${p.kind.padEnd(8)} ${((100 * p.tiles) / game.landTiles).toFixed(2).padStart(6)} ${String(p.tiles).padStart(7)} ${(fmt(p.troops) + '/' + fmt(p.maxTroops)).padStart(14)} ${fmt(p.gold).padStart(10)} ${fmt(p.incomeEma * 10).padStart(10)} ${String(nStr).padStart(4)} ${String(nUnits).padStart(5)}`,
    );
  }
  const unitStr = [...units.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}:${n}`).join(' ');
  lines.push(`  units by type: ${unitStr || '-'}`);
  console.log(lines.join('\n'));
}

function checkInvariants(tick) {
  // Tile counts & border sets must match the owner array exactly.
  const counts = new Int32Array(game.playerArr.length + 2);
  for (let t = 0; t < TILE_COUNT; t++) counts[game.owner[t]]++;
  for (const p of game.playerArr) {
    if (counts[p.id] !== p.tiles) throw new Error(`tick ${tick}: player ${p.id} tiles ${p.tiles} != counted ${counts[p.id]}`);
    if (!Number.isFinite(p.troops) || p.troops < 0) throw new Error(`tick ${tick}: player ${p.id} troops ${p.troops}`);
    if (!Number.isFinite(p.gold) || p.gold < -1) throw new Error(`tick ${tick}: player ${p.id} gold ${p.gold}`);
    for (const t of p.border) if (game.owner[t] !== p.id) throw new Error(`tick ${tick}: border tile ${t} of ${p.id} owned by ${game.owner[t]}`);
  }
  for (let t = 0; t < TILE_COUNT; t++) if (game.owner[t] !== 0 && !game.playable[t]) throw new Error(`tick ${tick}: unplayable tile ${t} owned`);
  for (const u of game.unitMap.values()) {
    if (!Number.isFinite(u.x) || !Number.isFinite(u.y)) throw new Error(`tick ${tick}: unit ${u.id} type ${u.type} NaN position`);
    if (u.x < 0 || u.x >= MAP_W + 1e-3) throw new Error(`tick ${tick}: unit ${u.id} x out of range ${u.x}`);
  }
  for (const s of game.structureMap.values()) {
    if (game.owner[s.tile] !== s.owner) throw new Error(`tick ${tick}: structure ${s.id} owner ${s.owner} on tile of ${game.owner[s.tile]}`);
  }
}

let fatal = null;
const simStart = performance.now();
let tick = 0;
let pendingTicks = 0;
try {
  // Spawn phase (instantStart ends it right after the human is placed).
  while (game.phase === 'spawn' && tick < 400) {
    game.tick1();
    tick++;
  }
  console.log(`[harness] spawn phase done at tick ${game.tick}; phase=${game.phase}`);
  leaderboard(game.tick);
  for (let i = 0; i < TICKS; i++) {
    if (game.phase !== 'playing') break;
    const a = performance.now();
    game.tick1();
    const dt = performance.now() - a;
    minuteTimes.push(dt);
    allTimes.push(dt);
    pendingTicks++;
    if (pendingTicks >= 4) {
      const b = performance.now();
      const u = game.buildUpdate(pendingTicks);
      const packMs = performance.now() - b;
      pendingTicks = 0;
      updates++;
      if (u.fullOwners) fullResyncs++;
      maxOwners = Math.max(maxOwners, u.owners.length);
      ownerChanges += u.owners.length;
      for (const buf of tickUpdateTransferables(u)) updateBytes += buf.byteLength;
      for (const e of u.events) eventCounts.set(e.type, (eventCounts.get(e.type) ?? 0) + 1);
      if (u.players.length % PLAYER_STRIDE !== 0 || u.units.length % UNIT_STRIDE !== 0) throw new Error('bad packing');
      for (let o = 0; o < u.players.length; o += PLAYER_STRIDE) if (!Number.isFinite(u.players[o + PF.troops])) throw new Error('NaN troops packed');
      for (let o = 0; o < u.units.length; o += UNIT_STRIDE) if (!Number.isFinite(u.units[o + UF.x])) throw new Error('NaN unit packed');
      packTimes.push(packMs);
    }
    if (game.tick % 600 === 0) {
      const ts = minuteTimes.slice().sort((x, y) => x - y);
      const mean = ts.reduce((s, x) => s + x, 0) / Math.max(1, ts.length);
      const p95 = ts[Math.floor(ts.length * 0.95)] ?? 0;
      const max = ts[ts.length - 1] ?? 0;
      perMinute.push({ minute: game.tick / 600, mean, p95, max });
      minuteTimes = [];
      if (!QUIET) leaderboard(game.tick);
      console.log(`  tick ms: mean ${mean.toFixed(2)} · p95 ${p95.toFixed(2)} · max ${max.toFixed(2)} · errors ${errors.length}`);
      checkInvariants(game.tick);
    }
  }
} catch (err) {
  fatal = err;
  console.error('[harness] FATAL', err);
}
const wall = (performance.now() - simStart) / 1000;

leaderboard(game.tick);
console.log(`\n[harness] simulated ${(game.tick / 600).toFixed(1)} min (${game.tick} ticks) in ${wall.toFixed(1)} s wall = ${((game.tick * 0.1) / wall).toFixed(1)}x realtime`);
const sorted = allTimes.slice().sort((a, b) => a - b);
const mean = sorted.reduce((s, x) => s + x, 0) / Math.max(1, sorted.length);
console.log(`[harness] tick ms overall: mean ${mean.toFixed(2)} · p50 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(2)} · p95 ${sorted[Math.floor(sorted.length * 0.95)]?.toFixed(2)} · p99 ${sorted[Math.floor(sorted.length * 0.99)]?.toFixed(2)} · max ${sorted[sorted.length - 1]?.toFixed(2)}`);
const pk = packTimes.slice().sort((a, b) => a - b);
console.log(`[harness] buildUpdate ms: mean ${(pk.reduce((s, x) => s + x, 0) / Math.max(1, pk.length)).toFixed(2)} · max ${(pk[pk.length - 1] ?? 0).toFixed(2)}`);
console.log(`[harness] updates ${updates} · avg transfer ${(updateBytes / Math.max(1, updates) / 1024).toFixed(1)} KB · max owner delta ${maxOwners} · full resyncs ${fullResyncs} · tile changes ${ownerChanges}`);
console.log(`[harness] events: ${[...eventCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
const humanP = game.playerById[HUMAN_ID];
console.log(`[harness] phase ${game.phase} · winner ${game.winner} · human alive ${humanP.alive} tiles ${humanP.tiles}`);

printProfile();
const problems = [];
if (fatal) problems.push(`fatal: ${fatal.message}`);
if (errors.length) problems.push(`${errors.length} sim errors`);
if (game.tick > 3000 && ownerChanges < 20_000) problems.push(`world too static: only ${ownerChanges} tile changes`);
const attacks = eventCounts.get('attackStarted') ?? 0;
if (game.tick > 3000 && attacks < 50) problems.push(`too few attacks (${attacks})`);
if (sorted.length && sorted[Math.floor(sorted.length * 0.95)] > 15) problems.push(`p95 tick time ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms > 15 ms`);
try {
  checkInvariants(game.tick);
} catch (err) {
  problems.push(`invariant: ${err.message}`);
}
if (problems.length) {
  console.log(`\n[harness] FAILED:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log('\n[harness] OK');
process.exit(0);
