// FRONT ULTRA — headless AI & world-event harness (owner: sim-ai). Test tooling only, never bundled.
//
//   npx tsx src/sim/ai/test/aiharness.mjs [--ais 40] [--tribes 30] [--minutes 20] [--seed 1337]
//        [--difficulty normal|all] [--autopilot 1] [--every 1] [--quiet]
//
// Plays full games at maximum speed through the real Game (sim-core) with the sim-ai director and world events,
// and prints what matters for AI quality: land race and leaderboard over time, eliminations, wars, alliances,
// betrayals, naval invasions, air strikes, nukes (and when the first one flew), world events, the doomsday clock,
// and the AI's own cost per tick. Ends with PASS/FAIL checks for dynamism (not stagnant, not decided early).

import { performance } from 'node:perf_hooks';
import { loadWorldInit } from '../../test/world.mjs';
import { Game } from '../../game.ts';
import { HUMAN_ID, DEFAULT_START_WORLD_TIME } from '../../../shared/constants.ts';
import { latLonToTile } from '../../../shared/geo.ts';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const AIS = Number(arg('ais', 40));
const TRIBES = Number(arg('tribes', 30));
const MINUTES = Number(arg('minutes', 20));
const SEED = Number(arg('seed', 1337));
const DIFFS = String(arg('difficulty', 'normal')) === 'all' ? ['easy', 'normal', 'hard', 'insane'] : [String(arg('difficulty', 'normal'))];
const AUTOPILOT = String(arg('autopilot', '1')) !== '0';
const EVERY = Number(arg('every', 2));
const QUIET = !!arg('quiet', false);

const world = await loadWorldInit();
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(Math.round(n)));
let failures = 0;

for (const DIFF of DIFFS) {
  const config = {
    seed: SEED, playerName: 'Autopilot', playerColor: 0x2f6fd6, difficulty: DIFF, aiCount: AIS, tribeCount: TRIBES, speed: 4,
    nukes: true, worldEvents: true, startWorldTimeSec: DEFAULT_START_WORLD_TIME, spawnTimeoutTicks: 300,
    autoSpawnTile: latLonToTile(40.4, -3.7), instantStart: true, humanAutopilot: AUTOPILOT,
  };
  const errors = [];
  const game = new Game(config, world);
  game.onError = (msg, stack) => {
    errors.push(msg);
    if (errors.length <= 8) console.error(`[ai] sim error: ${msg}\n${(stack ?? '').split('\n').slice(0, 5).join('\n')}`);
  };
  // Time the AI and the world events.
  const cost = { ai: 0, aiMax: 0, ev: 0, evMax: 0, n: 0 };
  for (const [key, label] of [['ai', 'ai'], ['worldEvents', 'ev']]) {
    const obj = game[key];
    const fn = obj.tick;
    obj.tick = function () {
      const t = performance.now();
      try { return fn.call(this); } finally {
        const d = performance.now() - t;
        cost[label] += d;
        if (d > cost[label + 'Max']) cost[label + 'Max'] = d;
      }
    };
  }
  const counts = new Map();
  const firsts = new Map();
  const log = [];
  const tickOf = (e) => (e.tick / 600).toFixed(1);
  const name = (id) => game.playerById[id]?.name ?? (id === 0 ? 'neutral' : `#${id}`);
  const origEmit = game.emit.bind(game);
  game.emit = (e) => {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    let key = e.type;
    if (e.type === 'nukeLaunched') key = `nuke:${e.weapon}`;
    if (e.type === 'worldEvent') key = `event:${e.kind}:${e.stage}`;
    if (!firsts.has(key)) firsts.set(key, e.tick);
    if (e.type === 'worldEvent' && e.stage !== 'end') log.push(`${tickOf(e)}m EVENT ${e.kind} ${e.stage} at (${e.x.toFixed(0)},${e.y.toFixed(0)}) r=${e.radius.toFixed(0)} players=${e.players.map(name).join('/')}`);
    if (e.type === 'nukeLaunched' && e.weapon !== 7) log.push(`${tickOf(e)}m NUKE ${e.weapon === 8 ? 'A-bomb' : e.weapon === 9 ? 'H-bomb' : 'MIRV'} ${name(e.owner)} -> ${name(e.targetOwner)}`);
    if (e.type === 'allianceBroken') log.push(`${tickOf(e)}m BETRAYAL ${name(e.breaker)} stabs ${name(e.victim)}`);
    if (e.type === 'nationEliminated' && game.playerById[e.playerId]?.kind === 'nation') log.push(`${tickOf(e)}m ELIMINATED ${name(e.playerId)} by ${name(e.by)}`);
    if (e.type === 'doomsday') log.push(`${tickOf(e)}m DOOMSDAY level ${e.level.toFixed(2)} (${e.minutesToMidnight.toFixed(1)} min to midnight)`);
    if (e.type === 'gameOver') log.push(`${tickOf(e)}m GAME OVER winner ${name(e.winner)} (${e.reason})`);
    return origEmit(e);
  };

  // Keep the world running when the autopilot human dies (the real game would end with a defeat screen): the
  // harness judges the AI world, so only a domination victory ends it.
  let humanDiedAt = -1;
  const origEnd = game.end.bind(game);
  game.end = (winner, reason) => {
    if (reason === 'eliminated') {
      if (humanDiedAt < 0) humanDiedAt = game.tick;
      return;
    }
    return origEnd(winner, reason);
  };
  const slow = [];
  const t0 = performance.now();
  while (game.phase === 'spawn' && game.tick < 400) game.tick1();
  const TICKS = MINUTES * 600;
  const history = [];
  let fatal = null;
  try {
    while (game.tick < TICKS && game.phase === 'playing') {
      const aBefore = cost.ai, eBefore = cost.ev;
      game.tick1();
      cost.n++;
      if (cost.ai - aBefore > 4 || cost.ev - eBefore > 4) slow.push(`tick ${game.tick}: ai ${(cost.ai - aBefore).toFixed(1)} ms, events ${(cost.ev - eBefore).toFixed(1)} ms`);
      if (game.tick % 4 === 0) game.buildUpdate(4);
      if (game.tick % 600 === 0) {
        const m = game.tick / 600;
        const alive = game.playerArr.filter((p) => p.alive && p.spawned);
        const nations = alive.filter((p) => p.kind === 'nation' || p.kind === 'human' || p.kind === 'rebel');
        const sorted = nations.slice().sort((a, b) => b.tiles - a.tiles);
        const share = (p) => (100 * p.tiles) / game.landTiles;
        const alliances = game.diplomacy.allianceViews().length;
        const pvp = game.attackList.filter((a) => !a.ended && a.defender > 0).length;
        history.push({ m, top: sorted[0] ? share(sorted[0]) : 0, nations: nations.length, pvp });
        if (!QUIET && (m % EVERY === 0 || m === 1)) {
          const tribes = alive.filter((p) => p.kind === 'tribe').length;
          const rebels = alive.filter((p) => p.kind === 'rebel').length;
          const unowned = 100 - alive.reduce((s, p) => s + share(p), 0);
          console.log(`\n[${DIFF}] t=${m}m nations ${nations.length} tribes ${tribes} rebels ${rebels} · neutral ${unowned.toFixed(1)}% · attacks ${game.attackList.filter((a) => !a.ended).length} · alliances ${alliances} · units ${game.unitMap.size} · structures ${game.structureMap.size} · doomsday ${game.doomsdayLevel.toFixed(2)}`);
          console.log('   ' + sorted.slice(0, 8).map((p) => `${p.id === HUMAN_ID ? '*' : ''}${p.name.slice(0, 14)} ${share(p).toFixed(1)}% ${fmt(p.troops)} ${p.personality ? p.personality.slice(0, 4) : ''}`).join(' | '));
        }
      }
    }
  } catch (err) {
    fatal = err;
    console.error('[ai] FATAL', err);
  }
  const wall = (performance.now() - t0) / 1000;
  if (!QUIET) console.log('\n' + log.slice(0, 80).join('\n'));
  if (!QUIET) {
    // Brain snapshot of the biggest AI nations.
    const st = (pid, type) => (game.structByOwner.get(pid) ?? []).filter((s) => s.type === type).length;
    const top = game.playerArr.filter((p) => p.alive && p.kind === 'nation').sort((a, b) => b.tiles - a.tiles).slice(0, 12);
    console.log(`\n[${DIFF}] brains (fill · allies · enemy · idle · city/silo/sam/army/air/yard · gold):`);
    for (const p of top) {
      const b = p.aiMemory;
      console.log(`   ${p.name.slice(0, 16).padEnd(16)} ${String(p.personality).padEnd(11)} ${(p.troops / Math.max(1, p.maxTroops)).toFixed(2)} · ${[...p.allies].map((a) => name(a).slice(0, 8)).join('+') || '-'} · ${b ? name(b.enemy).slice(0, 12) : '?'} · ${b ? b.idleTicks : '?'} · ${st(p.id, 0)}/${st(p.id, 5)}/${st(p.id, 4)}/${st(p.id, 7)}/${st(p.id, 6)}/${st(p.id, 8)} · ${fmt(p.gold)}`);
    }
  }
  const c = (k) => counts.get(k) ?? 0;
  const nukes = [...firsts.entries()].filter(([k]) => k.startsWith('nuke:') && k !== 'nuke:7').map(([, t]) => t);
  const firstNuke = nukes.length ? Math.min(...nukes) : -1;
  const nukeCount = log.filter((l) => l.includes(' NUKE ')).length;
  const human = game.playerById[HUMAN_ID];
  if (slow.length) console.log(`[${DIFF}] slow ticks (${slow.length}): ${slow.slice(0, 6).join(' | ')}`);
  if (humanDiedAt >= 0) console.log(`[${DIFF}] (autopilot human eliminated at ${(humanDiedAt / 600).toFixed(1)} min; world kept running)`);
  console.log(`\n[${DIFF}] ${(game.tick / 600).toFixed(1)} min in ${wall.toFixed(1)} s · phase ${game.phase} · winner ${game.winner ? name(game.winner) : '-'} · human ${human.alive ? (100 * human.tiles / game.landTiles).toFixed(1) + '%' : 'dead'}`);
  console.log(`[${DIFF}] attacks ${c('attackStarted')} · boats ${c('boatLaunched')} · alliances ${c('allianceFormed')} (rejected ${c('allianceRejected')}, expired ${c('allianceExpired')}) · betrayals ${c('allianceBroken')} · eliminated ${c('nationEliminated')} · capitals ${c('capitalCaptured')}`);
  console.log(`[${DIFF}] structures ${c('structureBuilt')} · units ${c('unitSpawned')} · combat ${c('combat')} · nukes ${nukeCount} (first at ${firstNuke >= 0 ? (firstNuke / 600).toFixed(1) + 'm' : 'never'}) · detonations ${c('nukeDetonated')} · intercepted ${c('nukeIntercepted')} · emotes ${c('emote')} · donations ${c('donation')} · embargo ${c('embargoChanged')}`);
  console.log(`[${DIFF}] world events ${log.filter((l) => l.includes('EVENT')).length} · AI ms/tick mean ${(cost.ai / Math.max(1, cost.n)).toFixed(3)} max ${cost.aiMax.toFixed(2)} · events ms/tick mean ${(cost.ev / Math.max(1, cost.n)).toFixed(3)} max ${cost.evMax.toFixed(2)} · errors ${errors.length}`);
  const late = history.filter((h) => h.m >= 5);
  const pvpAvg = late.length ? late.reduce((a, h) => a + h.pvp, 0) / late.length : 0;
  console.log(`[${DIFF}] player-vs-player fronts per minute sample (5 min+): avg ${pvpAvg.toFixed(1)} · leader share by minute: ${history.filter((h) => h.m % 4 === 0).map((h) => `${h.m}m ${h.top.toFixed(0)}%`).join(' ')}`);
  const problems = [];
  if (fatal) problems.push(`fatal ${fatal.message}`);
  if (errors.length) problems.push(`${errors.length} sim errors`);
  const at = (m) => history.find((h) => h.m === m);
  if (at(2) && at(2).top > 30) problems.push(`decided too early: leader ${at(2).top.toFixed(1)}% at 2 min`);
  if (game.winner && game.tick < 12 * 600) problems.push(`game over at ${(game.tick / 600).toFixed(1)} min`);
  if (c('attackStarted') < 200) problems.push('too few attacks');
  if (late.length >= 5 && pvpAvg < 2) problems.push(`stagnant mid/late game (avg ${pvpAvg.toFixed(1)} player fronts)`);
  if (c('allianceFormed') < 3) problems.push('no alliances');
  if (MINUTES >= 20 && c('nukeLaunched') === 0) problems.push('no nukes');
  if (MINUTES >= 20 && firstNuke >= 0 && firstNuke < 5 * 600) problems.push(`first nuke too early (${(firstNuke / 600).toFixed(1)} min)`);
  if (cost.ai / Math.max(1, cost.n) > 1) problems.push('AI too slow');
  if (problems.length) {
    failures++;
    console.log(`[${DIFF}] FAIL: ${problems.join('; ')}`);
  } else console.log(`[${DIFF}] PASS`);
}
process.exit(failures ? 1 : 0);
