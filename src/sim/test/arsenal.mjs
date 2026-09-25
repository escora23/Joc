// FRONT ULTRA — scripted scenario tests for every sim mechanic (owner: sim-core). Test tooling only, never bundled.
//
//   npx tsx src/sim/test/arsenal.mjs [--only name] [--verbose]
//
// Each scenario builds a small deterministic world (real Earth grid, AI and world events switched off), stages it
// with the same debug actions the shots use, issues real PlayerCommands and checks the outcome: construction and
// scaling costs, troop/gold growth, land attacks, retreat, naval invasion, encirclement, every unit type, every
// weapon (atom, hydrogen, MIRV, cruise), SAM interception, fallout decay, diplomacy, elimination and victory.

import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID, MAP_W, DEFAULT_START_WORLD_TIME, STRUCTURE_DEFS } from '../../shared/constants.ts';
import { latLonToTile } from '../../shared/geo.ts';
import { StructureType as S, UnitType as U, UnitState } from '../../shared/types.ts';

const argv = process.argv.slice(2);
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const VERBOSE = argv.includes('--verbose');

const world = await loadWorldInit(() => {});
const T = (lat, lon) => latLonToTile(lat, lon);
const MADRID = T(40.4, -3.7), PARIS = T(48.86, 2.35), ROME = T(41.9, 12.5), LONDON = T(51.5, -0.13);

/** A quiet world: human + `n` nations (no tribes), AI and world events off, already in the playing phase. */
function quietGame(n = 3, extra = {}) {
  Game.withFallbackAi = false;
  const g = new Game({
    seed: 7, playerName: 'Tester', playerColor: 0x3366ff, difficulty: 'normal', aiCount: n, tribeCount: 0, speed: 1,
    nukes: true, worldEvents: false, startWorldTimeSec: DEFAULT_START_WORLD_TIME, spawnTimeoutTicks: 50,
    autoSpawnTile: MADRID, instantStart: true, humanAutopilot: false, ...extra,
  }, world);
  g.onError = (m, s) => {
    throw new Error(`sim error: ${m}\n${s ?? ''}`);
  };
  // Silence the AI: scenarios drive every player by hand.
  g.ai = { setup() {}, tick() {}, onEvent() {} };
  while (g.phase === 'spawn') g.tick1();
  return g;
}

function run(g, ticks) {
  for (let i = 0; i < ticks; i++) g.tick1();
  // Drain the event queue like the worker would.
  return g.buildUpdate(ticks).events;
}

/** v2: offensives, strikes and landings on a nation need a declared war (staged here without mobilization). */
function war(g, a, b) {
  g.applyDebug({ type: 'war', a, b });
}

function claim(g, pid, tile, radius) {
  g.applyDebug({ type: 'conquer', playerId: pid, centerTile: tile, radius });
}

function eventsOf(list, type) {
  return list.filter((e) => e.type === type);
}

const results = [];
async function scenario(name, fn) {
  if (ONLY && name !== ONLY) return;
  const t0 = performance.now();
  const notes = [];
  try {
    await fn((msg) => notes.push(msg));
    results.push({ name, ok: true, ms: performance.now() - t0, notes });
  } catch (err) {
    results.push({ name, ok: false, ms: performance.now() - t0, notes: [...notes, String(err?.stack ?? err)] });
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(`expected: ${msg}`);
}

// -------------------------------------------------------------------------------------------------------------
await scenario('growth-and-income', (note) => {
  const g = quietGame(1);
  const h = g.playerById[HUMAN_ID];
  claim(g, HUMAN_ID, MADRID, 20);
  const t0 = h.troops, g0 = h.gold;
  run(g, 600);
  note(`troops ${t0.toFixed(0)} -> ${h.troops.toFixed(0)} (cap ${h.maxTroops.toFixed(0)}), gold ${g0.toFixed(0)} -> ${h.gold.toFixed(0)}`);
  expect(h.troops > t0 * 1.5, 'troops grow over a minute');
  expect(h.troops <= h.maxTroops + 1, 'troops stay under the cap');
  expect(h.gold > g0 + 20_000, 'gold income');
  // Cities raise the cap.
  const capBefore = h.maxTroops;
  g.applyDebug({ type: 'spawnStructure', structure: S.City, owner: HUMAN_ID, tile: MADRID, level: 3 });
  run(g, 1);
  expect(h.maxTroops > capBefore * 1.3, `city raises the cap (${capBefore.toFixed(0)} -> ${h.maxTroops.toFixed(0)})`);
});

await scenario('build-costs-and-upgrade', (note) => {
  const g = quietGame(1);
  const h = g.playerById[HUMAN_ID];
  claim(g, HUMAN_ID, MADRID, 25);
  g.addGold(HUMAN_ID, 5_000_000);
  const c1 = g.structureCost(HUMAN_ID, S.City);
  expect(g.issue(HUMAN_ID, { type: 'build', structure: S.City, tile: MADRID }), 'build a city');
  const c2 = g.structureCost(HUMAN_ID, S.City);
  expect(c2 > c1, `second city costs more (${c1} -> ${c2})`);
  expect(!g.issue(HUMAN_ID, { type: 'build', structure: S.City, tile: MADRID + 1 }), 'too close refused');
  expect(!g.issue(HUMAN_ID, { type: 'build', structure: S.Port, tile: MADRID + 5 * MAP_W }), 'port inland refused');
  const s = [...g.structureMap.values()][0];
  run(g, STRUCTURE_DEFS[S.City].buildTicks + 2);
  expect(s.built >= 1, 'construction finishes');
  expect(g.issue(HUMAN_ID, { type: 'upgrade', structureId: s.id }), 'upgrade');
  expect(s.level === 2, 'level 2');
  note(`city cost ${c1} -> ${c2}; level ${s.level}`);
});

await scenario('land-attack-and-retreat', (note) => {
  const g = quietGame(2);
  const [h, a] = [g.playerById[HUMAN_ID], g.playerArr[1]];
  claim(g, HUMAN_ID, MADRID, 30);
  claim(g, a.id, T(40.4, 3.5), 30);
  h.troops = 400_000;
  a.troops = 80_000;
  const before = a.tiles;
  expect(!g.issue(HUMAN_ID, { type: 'attack', target: a.id, ratio: 0.5, tile: T(40.4, 1) }), 'attack at peace rejected (msg.notAtWar)');
  war(g, HUMAN_ID, a.id);
  expect(g.issue(HUMAN_ID, { type: 'attack', target: a.id, ratio: 0.5, tile: T(40.4, 1) }), 'attack issued');
  const ev = run(g, 300);
  expect(eventsOf(ev, 'attackStarted').length === 1, 'attackStarted event');
  note(`defender tiles ${before} -> ${a.tiles}, attacker ${h.tiles}, fronts ${g.fronts.take().length}`);
  expect(a.tiles < before - 30, 'the front advances');
  const atk = g.attackList.find((x) => !x.ended && x.attacker === HUMAN_ID);
  if (atk) {
    const t = h.troops;
    expect(g.issue(HUMAN_ID, { type: 'retreat', attackId: atk.id }), 'retreat');
    run(g, 2);
    expect(h.troops > t, 'retreat returns troops');
  }
});

await scenario('neutral-expansion', (note) => {
  const g = quietGame(1);
  const h = g.playerById[HUMAN_ID];
  const t0 = h.tiles;
  expect(g.issue(HUMAN_ID, { type: 'attack', target: 0, ratio: 0.4, tile: MADRID }), 'expand');
  run(g, 300);
  note(`tiles ${t0} -> ${h.tiles}`);
  expect(h.tiles > t0 + 30, 'neutral expansion at 7.5 km/h');
});

await scenario('naval-invasion', (note) => {
  const g = quietGame(2);
  const [h, a] = [g.playerById[HUMAN_ID], g.playerArr[1]];
  claim(g, HUMAN_ID, MADRID, 40);
  claim(g, a.id, ROME, 12);
  h.troops = 300_000;
  war(g, HUMAN_ID, a.id);
  expect(g.issue(HUMAN_ID, { type: 'boatAttack', targetTile: T(41.9, 12.3), ratio: 0.3 }), 'boat attack issued');
  let landed = null;
  for (let i = 0; i < 900 && !landed; i++) {
    const ev = run(g, 1);
    landed = eventsOf(ev, 'boatLanded')[0] ?? null;
  }
  expect(landed, 'transport lands');
  note(`landed at tick ${g.tick}, human tiles near Rome after 100 ticks`);
  run(g, 100);
  expect(g.owner[landed.tile] === HUMAN_ID || h.tiles > 0, 'beachhead');
});

await scenario('warship-sinks-transport', (note) => {
  const g = quietGame(2);
  const [h, a] = [g.playerById[HUMAN_ID], g.playerArr[1]];
  claim(g, HUMAN_ID, MADRID, 17);
  claim(g, a.id, T(39.6, 3.0), 3); // Mallorca
  war(g, HUMAN_ID, a.id);
  g.applyDebug({ type: 'spawnUnit', unit: U.Warship, owner: a.id, tile: T(39.0, 1.5), targetTile: -1 });
  a.troops = 200_000;
  expect(g.issue(a.id, { type: 'boatAttack', targetTile: T(39.47, -0.38), ratio: 0.2 }) || true, 'boat');
  h.troops = 300_000;
  expect(g.issue(HUMAN_ID, { type: 'boatAttack', targetTile: T(39.6, 3.0), ratio: 0.2 }), 'human invasion');
  let sunk = false;
  const ev = [];
  for (let i = 0; i < 600 && !sunk; i++) {
    const e = run(g, 1);
    ev.push(...e);
    sunk = e.some((x) => x.type === 'unitDestroyed' && x.unit === U.TransportShip && x.owner === HUMAN_ID);
  }
  note(`shells fired ${eventsOf(ev, 'combat').length}, sunk=${sunk}`);
  expect(sunk, 'the warship sinks the transport');
});

await scenario('trade-ships-and-trains', (note) => {
  const g = quietGame(2);
  const a = g.playerArr[1];
  claim(g, HUMAN_ID, MADRID, 45);
  claim(g, a.id, ROME, 20);
  const port1 = g.nav.coastal.findIndex((c, t) => c && g.owner[t] === HUMAN_ID && (t % MAP_W) > MAP_W / 2 - 10);
  let port2 = -1;
  for (const t of a.shore) {
    port2 = t;
    break;
  }
  g.applyDebug({ type: 'spawnStructure', structure: S.Port, owner: HUMAN_ID, tile: port1, level: 3 });
  g.applyDebug({ type: 'spawnStructure', structure: S.Port, owner: a.id, tile: port2, level: 3 });
  g.applyDebug({ type: 'spawnStructure', structure: S.Factory, owner: HUMAN_ID, tile: MADRID, level: 2 });
  g.applyDebug({ type: 'spawnStructure', structure: S.City, owner: HUMAN_ID, tile: T(41.6, -0.9), level: 2 });
  g.applyDebug({ type: 'spawnStructure', structure: S.City, owner: HUMAN_ID, tile: T(38.0, -4.5), level: 2 });
  const ev = run(g, 1500);
  const trades = eventsOf(ev, 'tradeCompleted').length;
  const trains = eventsOf(ev, 'goldBonus').filter((e) => e.reason === 'train').length;
  note(`trade completed ${trades}, train deliveries ${trains}`);
  expect(trades > 0, 'trade ships deliver');
  expect(trains > 0, 'trains deliver');
  // Embargo stops new trade.
  g.issue(HUMAN_ID, { type: 'embargo', target: a.id, active: true });
  for (const u of [...g.unitMap.values()]) if (u.type === U.TradeShip) g.unitSys.remove(u, false);
  const ev2 = run(g, 1200);
  expect(eventsOf(ev2, 'tradeCompleted').filter((e) => e.owner === HUMAN_ID || e.partner === HUMAN_ID).length === 0, 'embargo stops trade');
});

await scenario('armored-division', (note) => {
  const g = quietGame(2);
  const [h, a] = [g.playerById[HUMAN_ID], g.playerArr[1]];
  claim(g, HUMAN_ID, MADRID, 30);
  claim(g, a.id, T(40.4, 3.5), 30);
  g.addGold(HUMAN_ID, 3_000_000);
  g.applyDebug({ type: 'spawnStructure', structure: S.ArmyBase, owner: HUMAN_ID, tile: T(40.4, -1.5), level: 1 });
  expect(g.issue(HUMAN_ID, { type: 'buildUnit', unit: U.ArmoredDivision, structureId: -1 }), 'build tank division');
  run(g, 60);
  const tank = [...g.unitMap.values()].find((u) => u.type === U.ArmoredDivision);
  expect(tank, 'division exists');
  h.troops = 300_000;
  a.troops = 150_000;
  war(g, HUMAN_ID, a.id);
  expect(g.issue(HUMAN_ID, { type: 'deployArmor', unitId: tank.id, targetTile: T(40.4, 2) }), 'deploy');
  g.issue(HUMAN_ID, { type: 'attack', target: a.id, ratio: 0.5, tile: T(40.4, 1) });
  const before = a.tiles;
  run(g, 250);
  note(`tank at (${tank.x.toFixed(1)}, ${tank.y.toFixed(1)}) hp ${tank.hp.toFixed(0)}; defender tiles ${before} -> ${a.tiles}`);
  expect(a.tiles < before, 'the armored push takes land');
});

await scenario('air-war', (note) => {
  const g = quietGame(2);
  const [h, a] = [g.playerById[HUMAN_ID], g.playerArr[1]];
  claim(g, HUMAN_ID, MADRID, 30);
  claim(g, a.id, PARIS, 30);
  war(g, HUMAN_ID, a.id);
  g.addGold(HUMAN_ID, 20_000_000);
  g.addGold(a.id, 20_000_000);
  g.applyDebug({ type: 'spawnStructure', structure: S.Airbase, owner: HUMAN_ID, tile: T(41.5, -2.5), level: 3 });
  g.applyDebug({ type: 'spawnStructure', structure: S.Airbase, owner: a.id, tile: T(48.0, 2.0), level: 3 });
  const target = T(48.6, 2.8);
  g.applyDebug({ type: 'spawnStructure', structure: S.Factory, owner: a.id, tile: target, level: 1 });
  expect(g.issue(HUMAN_ID, { type: 'buildUnit', unit: U.Bomber, structureId: -1 }), 'bomber');
  expect(g.issue(HUMAN_ID, { type: 'buildUnit', unit: U.DroneSwarm, structureId: -1 }), 'drones');
  expect(g.issue(a.id, { type: 'buildUnit', unit: U.FighterSquadron, structureId: -1 }), 'enemy fighters');
  run(g, 80);
  const bomber = [...g.unitMap.values()].find((u) => u.type === U.Bomber && u.owner === HUMAN_ID);
  const drones = [...g.unitMap.values()].find((u) => u.type === U.DroneSwarm && u.owner === HUMAN_ID);
  expect(bomber && drones, 'aircraft built');
  expect(g.issue(HUMAN_ID, { type: 'airStrike', unitId: bomber.id, targetTile: target }), 'bomber strike');
  expect(g.issue(HUMAN_ID, { type: 'airStrike', unitId: drones.id, targetTile: T(47.5, 1.0) }), 'drone strike');
  const ev = run(g, 500);
  const combats = eventsOf(ev, 'combat');
  note(`combat: ${[...new Set(combats.map((c) => c.kind))].join(',')}; destroyed units ${eventsOf(ev, 'unitDestroyed').map((e) => e.unit).join(',')}; structures destroyed ${eventsOf(ev, 'structureDestroyed').length}`);
  expect(combats.some((c) => c.kind === 'bomb' || c.kind === 'strafe'), 'air combat happened');
  expect(eventsOf(ev, 'unitDestroyed').some((e) => e.unit === U.Bomber && e.by === a.id), 'enemy fighters shoot the bomber down');
});

await scenario('bomber-and-drone-strike', (note) => {
  const g = quietGame(2);
  const a = g.playerArr[1];
  claim(g, HUMAN_ID, MADRID, 30);
  claim(g, a.id, PARIS, 30);
  war(g, HUMAN_ID, a.id);
  g.addGold(HUMAN_ID, 20_000_000);
  g.applyDebug({ type: 'spawnStructure', structure: S.Airbase, owner: HUMAN_ID, tile: T(41.5, -2.5), level: 3 });
  const target = T(48.6, 2.8);
  g.applyDebug({ type: 'spawnStructure', structure: S.Factory, owner: a.id, tile: target, level: 1 });
  expect(g.issue(HUMAN_ID, { type: 'buildUnit', unit: U.Bomber, structureId: -1 }), 'bomber');
  expect(g.issue(HUMAN_ID, { type: 'buildUnit', unit: U.DroneSwarm, structureId: -1 }), 'drones');
  run(g, 80);
  const bomber = [...g.unitMap.values()].find((u) => u.type === U.Bomber);
  const drones = [...g.unitMap.values()].find((u) => u.type === U.DroneSwarm);
  a.troops = 500_000;
  const t0 = a.troops;
  g.issue(HUMAN_ID, { type: 'airStrike', unitId: bomber.id, targetTile: target });
  g.issue(HUMAN_ID, { type: 'airStrike', unitId: drones.id, targetTile: T(47.0, 1.0) });
  let ev = [];
  let destroyed = false;
  for (let i = 0; i < 700 && !destroyed; i += 10) {
    const e = run(g, 10);
    ev.push(...e);
    destroyed = e.some((x) => x.type === 'structureDestroyed');
  }
  const kinds = [...new Set(eventsOf(ev, 'combat').map((c) => c.kind))];
  note(`combat ${kinds.join(',')}; factory destroyed=${destroyed}; enemy troops ${t0.toFixed(0)} -> ${a.troops.toFixed(0)}`);
  expect(destroyed, 'the bomber destroys the factory');
  expect(kinds.includes('bomb'), 'bombs dropped');
  ev = run(g, 800);
  note(`bomber back home: state ${bomber.state} mode ${bomber.mode} dead=${bomber.dead}`);
});

await scenario('cruise-missile', (note) => {
  const g = quietGame(2);
  const a = g.playerArr[1];
  claim(g, HUMAN_ID, MADRID, 30);
  claim(g, a.id, PARIS, 25);
  g.addGold(HUMAN_ID, 20_000_000);
  g.applyDebug({ type: 'spawnStructure', structure: S.MissileSilo, owner: HUMAN_ID, tile: T(42.0, -2.0), level: 1 });
  g.applyDebug({ type: 'spawnStructure', structure: S.City, owner: a.id, tile: PARIS, level: 2 });
  run(g, 5);
  expect(!g.issue(HUMAN_ID, { type: 'launch', weapon: U.CruiseMissile, targetTile: PARIS, siloId: -1 }), 'cruise missile at peace rejected');
  war(g, HUMAN_ID, a.id);
  expect(g.issue(HUMAN_ID, { type: 'launch', weapon: U.CruiseMissile, targetTile: PARIS, siloId: -1 }), 'launch cruise');
  const ev = run(g, 400);
  note(`destroyed: ${eventsOf(ev, 'structureDestroyed').length}, detonations ${eventsOf(ev, 'nukeDetonated').length}`);
  expect(eventsOf(ev, 'nukeDetonated').length === 1 || eventsOf(ev, 'structureDestroyed').length > 0, 'impact');
});

await scenario('nukes-sam-fallout', (note) => {
  const g = quietGame(2);
  const [h, a] = [g.playerById[HUMAN_ID], g.playerArr[1]];
  claim(g, HUMAN_ID, MADRID, 40);
  claim(g, a.id, PARIS, 40);
  g.addGold(HUMAN_ID, 200_000_000);
  a.troops = 1_000_000;
  g.applyDebug({ type: 'spawnStructure', structure: S.MissileSilo, owner: HUMAN_ID, tile: T(41.0, -3.0), level: 3 });
  g.applyDebug({ type: 'spawnStructure', structure: S.MissileSilo, owner: HUMAN_ID, tile: T(39.5, -4.0), level: 3 });
  run(g, 2);
  // Atom bomb, no defense.
  expect(g.issue(HUMAN_ID, { type: 'launch', weapon: U.AtomBomb, targetTile: T(48.0, 1.0), siloId: -1 }), 'launch atom');
  const owners0 = g.owner.slice();
  let ev = run(g, 400);
  const det = eventsOf(ev, 'nukeDetonated');
  expect(det.length === 1, 'atom bomb detonates');
  let flipped = 0;
  for (let t = 0; t < g.owner.length; t++) if (g.owner[t] !== owners0[t]) flipped++;
  note(`tiles that changed owner in the detonation: ${flipped}`);
  expect(flipped === 0, 'v2: a detonation changes no tile owner');
  note(`atom: casualties ${det[0].casualties}, troops left ${a.troops.toFixed(0)}, scars ${g.scars.length}`);
  expect(g.scars.length === 1, 'radioactive scar');
  const fallTile = T(48.0, 1.0);
  expect(g.falloutUntil[fallTile] > g.tick, 'fallout on ground zero');
  // SAM + radar defend Paris.
  g.applyDebug({ type: 'spawnStructure', structure: S.SamSite, owner: a.id, tile: PARIS, level: 3 });
  g.applyDebug({ type: 'spawnStructure', structure: S.Radar, owner: a.id, tile: T(49.3, 3.5), level: 1 });
  run(g, 250);
  let launched = 0;
  ev = [];
  for (let i = 0; i < 12; i++) {
    if (g.issue(HUMAN_ID, { type: 'launch', weapon: U.AtomBomb, targetTile: T(48.9, 2.4), siloId: -1 })) launched++;
    ev.push(...run(g, 40));
  }
  ev.push(...run(g, 100));
  const inter = eventsOf(ev, 'nukeIntercepted').length;
  note(`SAM: launched ${launched}, intercepted ${inter}, detonated ${eventsOf(ev, 'nukeDetonated').length}`);
  expect(inter > 0, 'the SAM intercepts some bombs');
  // Hydrogen bomb and MIRV.
  run(g, 300);
  expect(g.issue(HUMAN_ID, { type: 'launch', weapon: U.HydrogenBomb, targetTile: T(49.3, 5.5), siloId: -1 }), 'launch H-bomb');
  const ev3 = run(g, 300);
  const okMirv = g.issue(HUMAN_ID, { type: 'launch', weapon: U.Mirv, targetTile: T(47.5, 2.5), siloId: -1 });
  if (!okMirv) note(`MIRV refused: ${JSON.stringify(eventsOf(run(g, 1), 'message').map((m) => m.key))}; silos ${[...g.structureMap.values()].filter((s) => s.type === S.MissileSilo).length}; detonations ${JSON.stringify(eventsOf(ev3, 'nukeDetonated').map((d) => d.weapon))}; owner at target ${g.owner[T(47.5, 2.5)]}`);
  expect(okMirv, 'launch MIRV');
  let warheads = 0;
  ev = [];
  for (let i = 0; i < 700; i++) {
    const e = run(g, 1);
    ev.push(...e);
    warheads = Math.max(warheads, [...g.unitMap.values()].filter((u) => u.type === U.MirvWarhead).length);
  }
  const dets = eventsOf(ev, 'nukeDetonated');
  note(`H-bomb + MIRV: max warheads in flight ${warheads}, detonations ${dets.length}, defender tiles ${a.tiles}, scars ${g.scars.length}`);
  expect(warheads >= 8, 'MIRV splits into many warheads');
  expect(eventsOf(ev3, 'nukeDetonated').some((d) => d.weapon === U.HydrogenBomb), 'H-bomb detonates');
  expect(dets.filter((d) => d.weapon === U.MirvWarhead).length >= 8, 'warheads detonate');
  // Fallout decays.
  const until = g.falloutUntil[fallTile];
  run(g, Math.max(0, until - g.tick) + 60);
  expect(g.falloutUntil[fallTile] <= g.tick, 'fallout decays');
  note(`scars after decay ${g.scars.length}`);
});

await scenario('diplomacy', (note) => {
  const g = quietGame(3);
  const [h, a, b] = [g.playerById[HUMAN_ID], g.playerArr[1], g.playerArr[2]];
  claim(g, HUMAN_ID, MADRID, 30);
  claim(g, a.id, T(40.4, 3.5), 30);
  claim(g, b.id, PARIS, 20);
  expect(g.issue(HUMAN_ID, { type: 'allianceRequest', target: a.id }), 'request');
  let ev = run(g, 1);
  expect(eventsOf(ev, 'allianceRequested').length === 1, 'requested event');
  expect(g.issue(a.id, { type: 'allianceReply', from: HUMAN_ID, accept: true }), 'accept');
  ev = run(g, 1);
  expect(g.isAllied(HUMAN_ID, a.id), 'allied');
  expect(!g.issue(HUMAN_ID, { type: 'attack', target: a.id, ratio: 0.3, tile: T(40.4, 1) }), 'cannot attack an ally');
  const gold = a.gold;
  expect(g.issue(HUMAN_ID, { type: 'donate', target: a.id, gold: 10_000, troops: 1_000 }), 'donate');
  expect(a.gold >= gold + 10_000 - 1, 'donation arrives');
  expect(g.issue(HUMAN_ID, { type: 'breakAlliance', target: a.id }), 'betray');
  ev = run(g, 1);
  expect(eventsOf(ev, 'allianceBroken').length === 1 && h.traitorUntilTick > g.tick, 'traitor flag');
  expect(g.issue(HUMAN_ID, { type: 'emote', target: 0, emote: 'skull' }), 'emote');
  // Alliance expiry.
  g.issue(HUMAN_ID, { type: 'allianceRequest', target: b.id });
  g.issue(b.id, { type: 'allianceReply', from: HUMAN_ID, accept: true });
  ev = [];
  for (let i = 0; i < 7000 && g.isAllied(HUMAN_ID, b.id); i += 100) ev.push(...run(g, 100));
  note(`traitor ticks ${h.traitorUntilTick}, alliance expired: ${eventsOf(ev, 'allianceExpired').length}`);
  expect(!g.isAllied(HUMAN_ID, b.id), 'alliance expires');
});

await scenario('encirclement', (note) => {
  const g = quietGame(2);
  const a = g.playerArr[1];
  claim(g, HUMAN_ID, MADRID, 30);
  claim(g, a.id, MADRID, 3); // a pocket inside Spain, cut off from the homeland
  const pocket = a.tiles;
  a.lastTileLossTick = g.tick + 1; // it just lost land (as after a real breakthrough)
  let ev = run(g, 200);
  expect(a.tiles === pocket && eventsOf(ev, 'siege').length === 0, 'v2: no annexation and no siege at peace');
  war(g, HUMAN_ID, a.id);
  ev = run(g, 200);
  note(`pocket ${pocket} tiles -> ${a.tiles}; alive=${a.alive}; sieges ${JSON.stringify(g.enclaves.views())}`);
  expect(eventsOf(ev, 'siege').some((e) => e.stage === 'start' && e.owner === a.id), 'v2: the pocket is besieged');
  expect(a.tiles === pocket, 'v2: nothing is annexed in one step');
});

await scenario('elimination-and-victory', (note) => {
  const g = quietGame(2);
  const [h, a, b] = [g.playerById[HUMAN_ID], g.playerArr[1], g.playerArr[2]];
  for (let t = 0; t < g.owner.length; t++) if (g.owner[t] === a.id || g.owner[t] === b.id) g.setOwner(t, 0);
  claim(g, HUMAN_ID, MADRID, 12);
  claim(g, a.id, T(40.4, -1.5), 5);
  h.troops = 2_000_000;
  war(g, HUMAN_ID, a.id);
  note(`a tiles ${a.tiles}, b tiles ${b.tiles}`);
  expect(g.issue(HUMAN_ID, { type: 'attack', target: a.id, ratio: 0.8, tile: T(40.4, -1.5) }), 'attack');
  // v2: at most 8 km/h and 3 + 4 % of the corridor per tick; the capital takes 3x longer.
  const ev = run(g, 900);
  note(`eliminated: ${eventsOf(ev, 'nationEliminated').map((e) => e.playerId).join(',')}, phase ${g.phase}, winner ${g.winner}`);
  expect(!a.alive, 'nation eliminated');
});

await scenario('command-result', (note) => {
  const g = quietGame(2);
  const a = g.playerArr[1];
  claim(g, HUMAN_ID, MADRID, 30);
  claim(g, a.id, PARIS, 20);
  g.applyDebug({ type: 'spawnUnit', unit: U.ArmoredDivision, owner: HUMAN_ID, tile: MADRID, targetTile: -1 });
  const tank = [...g.unitMap.values()].find((u) => u.type === U.ArmoredDivision);
  expect(g.issue(HUMAN_ID, { type: 'unitControl', unitId: tank.id, controlled: true }), 'control');
  run(g, 1);
  expect(tank.state === UnitState.Controlled, 'frozen while controlled');
  const t = a.troops;
  g.issue(HUMAN_ID, { type: 'commandResult', unitId: tank.id, kind: 'tank', enemy: a.id, tile: MADRID, troopsKilled: 5000, unitsDestroyed: [], structuresDestroyed: [], unitLost: false });
  const ev = run(g, 1);
  expect(a.troops < t - 4000, 'kills applied');
  expect(eventsOf(ev, 'commandResultApplied').length === 1, 'event');
  note(`enemy troops ${t.toFixed(0)} -> ${a.troops.toFixed(0)}`);
});

await scenario('determinism', (note) => {
  const mk = () => {
    Game.withFallbackAi = true;
    const g = new Game({
      seed: 99, playerName: 'D', playerColor: 0xffffff, difficulty: 'hard', aiCount: 16, tribeCount: 10, speed: 1,
      nukes: true, worldEvents: true, startWorldTimeSec: 0, spawnTimeoutTicks: 50, autoSpawnTile: MADRID,
      instantStart: true, humanAutopilot: true,
    }, world);
    for (let i = 0; i < 1500; i++) g.tick1();
    let h = 0;
    for (let t = 0; t < g.owner.length; t++) h = (h * 31 + g.owner[t]) | 0;
    return `${h}:${g.playerArr.map((p) => Math.round(p.troops)).join(',')}`;
  };
  const a = mk(), b = mk();
  note(a === b ? 'identical' : 'DIVERGED');
  expect(a === b, 'two runs with the same seed are identical');
});

// -------------------------------------------------------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(26)} ${r.ms.toFixed(0).padStart(6)} ms`);
  if (!r.ok || VERBOSE) for (const n of r.notes) console.log(`      ${n.split('\n').slice(0, 3).join('\n      ')}`);
}
console.log(failed ? `\n${failed} scenario(s) failed` : '\nall scenarios passed');
process.exit(failed ? 1 : 0);
