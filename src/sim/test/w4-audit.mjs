// FRONT ULTRA — W4 headless audit (DESIGN_V2 §16.5): units with a job, structure levels, production, orders.
// Test tooling only, never bundled. Prints a table (value, target, pass) like pace-audit.
//
//   npx tsx src/sim/test/w4-audit.mjs [--only name] [--seed n]
//
// Scenarios (acceptance numbers of §16.5): production (2), strike (4), levels (8), rail (11), blockade (12),
// cap (13), detection (16), save (20), parity (3, headless half: the sim accepts exactly what orderError allows).

import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { SaveReader, SaveWriter } from '../save.ts';
import {
  BOMBER_DIRECT_DMG, BOMBER_STRUCT_DMG, HUMAN_ID, MAP_W, UNIT_DEFS, kmhToKmPerTick, structureLevel,
} from '../../shared/constants.ts';
import { greatCircleKm, latLonToTile, tileXYToLatLon } from '../../shared/geo.ts';
import { inferOrder, orderError } from '../../shared/orders.ts';
import { StructureType as S, UnitMode as M, UnitType as U, UNIT_ORDER_KINDS } from '../../shared/types.ts';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 || argv[i + 1] === undefined ? def : argv[i + 1];
};
const ONLY = arg('only', null);
const SEED = Number(arg('seed', 7));
const world = await loadWorldInit(() => {});
const T = (lat, lon) => latLonToTile(lat, lon);
const results = [];
function row(id, what, value, target, pass) {
  results.push({ id, what, value: String(value), target, pass: !!pass });
}
const kmXY = (ax, ay, bx, by) => {
  const a = tileXYToLatLon(ax, ay), b = tileXYToLatLon(bx, by);
  return greatCircleKm(a.lat, a.lon, b.lat, b.lon);
};

/** A quiet world: the human + `n` nations, AI and world events off, in the playing phase. Events are recorded. */
function quiet(n = 2) {
  Game.withFallbackAi = false;
  const g = new Game({
    seed: SEED, playerName: 'Audit', playerColor: 0x3366ff, difficulty: 'normal', aiCount: n, tribeCount: 0, speed: 1,
    nukes: true, worldEvents: false, startWorldTimeSec: 0, spawnTimeoutTicks: 50, autoSpawnTile: T(40.4, -3.7),
    instantStart: true, humanAutopilot: false, duration: 'normal',
  }, world);
  g.onError = (m, s) => {
    throw new Error(`sim error: ${m}\n${s ?? ''}`);
  };
  g.ai = { setup() {}, tick() {}, onEvent() {} };
  const events = [];
  const emit = g.emit.bind(g);
  g.emit = (e) => {
    events.push(e);
    emit(e);
  };
  while (g.phase === 'spawn') g.tick1();
  const step = (k = 1) => {
    for (let i = 0; i < k; i++) {
      g.tick1();
      g.buildUpdate(1);
    }
  };
  const H = g.playerById[HUMAN_ID];
  const others = g.playerArr.filter((p) => p.id !== HUMAN_ID && p.kind === 'nation');
  return { g, events, step, H, others };
}
const claim = (g, pid, tile, r) => g.applyDebug({ type: 'conquer', playerId: pid, centerTile: tile, radius: r });
const struct = (g, type, owner, tile, level = 1) => {
  g.applyDebug({ type: 'spawnStructure', structure: type, owner, tile, level });
  return g.structureMap.get(g.structAt[tile]);
};
const spawn = (g, type, owner, tile, target = -1) => {
  const before = new Set(g.unitMap.keys());
  g.applyDebug({ type: 'spawnUnit', unit: type, owner, tile, targetTile: target });
  return [...g.unitMap.values()].find((u) => !before.has(u.id) && u.type === type);
};
const war = (g, a, b) => g.applyDebug({ type: 'war', a, b, mobilizeTicks: 0 });
function coastal(g, lat, lon, owner = -1) {
  const t0 = T(lat, lon);
  for (let r = 0; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const t = t0 + dy * MAP_W + dx;
        if (g.playable[t] && g.nav.coastal[t] && (owner < 0 || g.owner[t] === owner)) return t;
      }
    }
  }
  return t0;
}
function water(g, lat, lon) {
  const t = T(lat, lon);
  return g.nav.comp[t] >= 0 ? t : g.nav.waterNear(t);
}

const scenarios = {};

// -------------------------------------------------------------------------------------------------------------
// 2: production queue, unitReady naming the base, the price shown = the gold charged over 10 purchases
// -------------------------------------------------------------------------------------------------------------
scenarios.production = () => {
  const { g, events, step, H } = quiet(1);
  claim(g, HUMAN_ID, T(40.4, -3.7), 30);
  const b1 = struct(g, S.ArmyBase, HUMAN_ID, T(41.65, -0.88), 3);
  const b2 = struct(g, S.ArmyBase, HUMAN_ID, T(39.47, -2.0), 3);
  g.addGold(HUMAN_ID, 50_000_000);
  step();
  const t0 = g.tick;
  let mismatches = 0;
  const log = [];
  for (let i = 0; i < 10; i++) {
    const shown = g.unitCost(HUMAN_ID, U.ArmoredDivision);
    const before = H.gold;
    g.issue(HUMAN_ID, { type: 'buildUnit', unit: U.ArmoredDivision, structureId: -1 });
    step();
    const charged = Math.round(before - H.gold + H.income);
    // The tick also paid the income: compare the charge with the income of that tick removed.
    if (Math.abs(charged - shown) > 1) mismatches++;
    log.push(`${shown}/${charged}`);
  }
  const prod = g.unitSys.productionViews();
  const first = prod[0];
  row('2', 'first division in production: ETA from the order', first ? first.readyTick - first.startTick : '-', '80 ticks (8 h)', first && first.readyTick - first.startTick === 80 && first.startTick <= t0 + 1);
  row('2', 'units queued (TickUpdate.production rows)', prod.length, 10, prod.length === 10);
  row('2', 'price shown = gold charged over 10 purchases', `${10 - mismatches}/10 (${log.slice(0, 4).join(', ')}…)`, '10/10', mismatches === 0);
  step(81);
  const ready = events.filter((e) => e.type === 'unitReady');
  const r0 = ready[0];
  row('2', 'unitReady when done, naming its base', r0 ? `tick ${r0.tick - t0}, base ${r0.structureId} (${r0.structureId === b1.id ? 'A' : r0.structureId === b2.id ? 'B' : '?'}), serial ${r0.serial}` : 'none', 'at +80..82, a base id, serial 1', r0 && r0.tick - t0 >= 80 && r0.tick - t0 <= 83 && (r0.structureId === b1.id || r0.structureId === b2.id) && r0.serial === 1);
};

// -------------------------------------------------------------------------------------------------------------
// 4: bombers and drones from the airbase: mission speed, the §6.3 hp on arrival, return
// -------------------------------------------------------------------------------------------------------------
scenarios.strike = () => {
  const { g, events, step, H, others } = quiet(1);
  const E = others[0];
  claim(g, HUMAN_ID, T(40.4, -3.7), 25);
  claim(g, E.id, T(46.5, 2.5), 25);
  const base = struct(g, S.Airbase, HUMAN_ID, T(40.42, -3.7), 2);
  const tgt = struct(g, S.Airbase, E.id, T(46.5, 2.5), 1);
  const nb = struct(g, S.Radar, E.id, T(46.5, 2.5) + 1, 1);
  war(g, HUMAN_ID, E.id);
  step();
  const bomber = spawn(g, U.Bomber, HUMAN_ID, base.tile);
  const drone = spawn(g, U.DroneSwarm, HUMAN_ID, base.tile);
  step();
  row('4', 'bomber and drone docked at the airbase (hosted there)', `${g.unitSys.publicMode(bomber)} / ${g.unitSys.publicMode(drone)}, hosted ${g.unitSys.hostedAt(base.id)}`, `docked (${M.Docked}), hosted 2`, g.unitSys.publicMode(bomber) === M.Docked && g.unitSys.publicMode(drone) === M.Docked && g.unitSys.hostedAt(base.id) === 2);
  const accepted = g.unitSys.order(H, [bomber.id], 'strike', tgt.tile, tgt.id);
  const hp0 = nb.hp;
  let prev = { x: bomber.x, y: bomber.y }, km = 0, n = 0, hitTick = -1, arriveTick = -1, back = -1, nbAtHit = 1, kmAtHit = -1;
  const start = g.tick;
  for (let i = 0; i < 200; i++) {
    step();
    if (bomber.dead) break;
    const d = kmXY(prev.x, prev.y, bomber.x, bomber.y);
    if (d > 1e-6 && hitTick < 0) {
      km += d;
      n++;
    }
    prev = { x: bomber.x, y: bomber.y };
    const sr = events.find((e) => e.type === 'strikeResult' && e.unitId === bomber.id);
    if (sr && hitTick < 0) {
      hitTick = sr.tick;
      arriveTick = g.tick;
      nbAtHit = nb.hp;
      kmAtHit = kmXY(bomber.x, bomber.y, tgt.x, tgt.y);
    }
    if (hitTick >= 0 && g.unitSys.publicMode(bomber) === M.Rearming && back < 0) back = g.tick;
  }
  const kmh = n ? (km / n) * 10 : 0;
  const sr = events.find((e) => e.type === 'strikeResult' && e.unitId === bomber.id);
  const destroyed = !g.structureMap.has(tgt.id);
  row('4', 'strike order accepted', accepted, true, accepted);
  row('4', 'bomber flies at its mission speed', `${kmh.toFixed(0)} km/h`, `${UNIT_DEFS[U.Bomber].speedKmh} ± 5 %`, Math.abs(kmh / UNIT_DEFS[U.Bomber].speedKmh - 1) <= 0.05);
  const dist = kmXY(base.x, base.y, tgt.x, tgt.y);
  const want = Math.ceil(dist / kmhToKmPerTick(400));
  row('4', `strike resolves when the bomber arrives (${dist.toFixed(0)} km)`, sr ? `+${sr.tick - start} ticks, bomber ${kmAtHit.toFixed(0)} km from the target that tick` : 'none', `+${want} ± 1`, sr && Math.abs(sr.tick - start - want) <= 1 && kmAtHit >= 0 && kmAtHit < 30);
  row('4', `target hp −${BOMBER_DIRECT_DMG} (direct) and the neighbour −${BOMBER_STRUCT_DMG}`, `target ${destroyed ? 'destroyed' : tgt.hp.toFixed(2)}, neighbour ${(hp0 - nbAtHit).toFixed(2)}`, `destroyed (hp 1 − 1.1), −0.55`, destroyed && Math.abs(hp0 - nbAtHit - BOMBER_STRUCT_DMG) < 0.02);
  row('4', 'bomber returns and rearms', back > 0 ? `back at +${back - start}, rearming ${bomber.eta} ticks` : `mode ${g.unitSys.publicMode(bomber)}`, 'rearming at its base', back > 0 && !bomber.dead && kmXY(bomber.x, bomber.y, base.x, base.y) < 5);
  // Drone: one-way strike on a structure (−0.6 direct).
  const t2 = struct(g, S.DefensePost, E.id, T(45.8, 3.1), 1);
  g.unitSys.order(H, [drone.id], 'strike', t2.tile, t2.id);
  let dkm = 0, dn = 0, dp = { x: drone.x, y: drone.y };
  for (let i = 0; i < 300 && !drone.dead; i++) {
    step();
    const d = kmXY(dp.x, dp.y, drone.x, drone.y);
    if (d > 1e-6) {
      dkm += d;
      dn++;
    }
    dp = { x: drone.x, y: drone.y };
  }
  const dr = events.find((e) => e.type === 'strikeResult' && e.unitId === drone.id);
  row('4', 'drone swarm: mission speed and −0.6 on its structure', `${((dkm / Math.max(1, dn)) * 10).toFixed(0)} km/h, hp ${t2.hp.toFixed(2)}`, '150 km/h ± 5 %, hp 0.40', dr && Math.abs((dkm / dn) * 10 / 150 - 1) <= 0.05 && Math.abs(t2.hp - 0.4) < 0.02);
  // Out of reach and at peace are refused by the same rule the preview uses.
  claim(g, E.id, T(55.75, 37.6), 6);
  const far = struct(g, S.ArmyBase, E.id, T(55.75, 37.6), 1);
  bomber.readyTick = g.tick;
  const eReach = orderError(g.rules, bomber.id, 'strike', far.tile, far.id);
  row('4', 'strike beyond reach (Moscow, ~3,900 km) refused', eReach ?? 'accepted', 'order.err.outOfReach', eReach === 'order.err.outOfReach');
};

// -------------------------------------------------------------------------------------------------------------
// 8: level effects read from STRUCTURE_LEVELS
// -------------------------------------------------------------------------------------------------------------
scenarios.levels = () => {
  for (const L of [1, 2, 3]) {
    const { g, events, step, H, others } = quiet(1);
    const E = others[0];
    claim(g, HUMAN_ID, T(40.4, -3.7), 30);
    claim(g, E.id, T(46.5, 2.5), 20);
    war(g, HUMAN_ID, E.id);
    const sam = struct(g, S.SamSite, HUMAN_ID, T(40.42, -3.7), L);
    const reach = g.weapons.samReach(sam);
    // Salvo: a raid of 6 hostile bombers inside the air range; count interceptors before the reload.
    const eb = struct(g, S.Airbase, E.id, T(46.5, 2.5), 3);
    const tgtTile = T(40.42, -3.7) + 2;
    for (let k = 0; k < 6; k++) {
      const b = spawn(g, U.Bomber, E.id, T(41.6 + k * 0.05, -3.7), tgtTile);
      b.home = eb.id;
    }
    let shots = 0;
    for (let i = 0; i < 6 && sam.cooldownTicks <= 0; i++) {
      const n0 = events.length;
      step();
      shots += events.slice(n0).filter((e) => e.type === 'combat' && e.kind === 'sam' && e.owner === HUMAN_ID).length;
    }
    row('8', `SAM L${L}: air / anti-ballistic range, salvo`, `${reach.air} / ${reach.abm} tiles, ${shots} interceptors`, `${[0, 8, 10, 12][L]} / ${[0, 5, 6, 8][L]}, salvo ${L}`, reach.air === [0, 8, 10, 12][L] && reach.abm === [0, 5, 6, 8][L] && shots === L);
    // Silo unlocks.
    const silo = struct(g, S.MissileSilo, HUMAN_ID, T(39.0, -4.5), L);
    g.addGold(HUMAN_ID, 200_000_000);
    const tryW = (w) => {
      silo.cooldownTicks = 0;
      const n0 = events.length;
      g.issue(HUMAN_ID, { type: 'launch', weapon: w, targetTile: T(46.4, 2.2), siloId: silo.id });
      step();
      return events.slice(n0).some((e) => e.type === 'nukeLaunched' && e.owner === HUMAN_ID);
    };
    const hb = tryW(U.HydrogenBomb), mirv = tryW(U.Mirv);
    row('8', `silo L${L}: H-bomb / MIRV`, `${hb ? 'accepts' : 'rejects'} / ${mirv ? 'accepts' : 'rejects'}`, `${L >= 2 ? 'accepts' : 'rejects'} / ${L >= 3 ? 'accepts' : 'rejects'}`, hb === L >= 2 && mirv === L >= 3);
    // Airbase capacity: docked aircraft produced until full.
    const ab = struct(g, S.Airbase, HUMAN_ID, T(38.0, -3.0), L);
    let ok = 0;
    for (let k = 0; k < 12; k++) if (g.unitSys.buildUnit(H, U.DroneSwarm, ab.id)) ok++;
    row('8', `airbase L${L}: capacity`, ok, [0, 3, 6, 9][L], ok === [0, 3, 6, 9][L]);
    const dp = structureLevel(S.DefensePost, L), rd = structureLevel(S.Radar, L);
    // Radar coverage measured through radarCovers at the edge.
    const radar = struct(g, S.Radar, HUMAN_ID, T(42.0, -5.0), L);
    const cov = rd.coverageTiles;
    const inside = g.economy.radarCovers(HUMAN_ID, radar.x, radar.y - (cov - 0.3)), outside = g.economy.radarCovers(HUMAN_ID, radar.x, radar.y - (cov + 0.3));
    row('8', `radar L${L}: coverage (covers at r − 0.3, not at r + 0.3)`, `${cov} tiles, ${inside}/${outside}`, `${[0, 20, 28, 36][L]}, true/false`, cov === [0, 20, 28, 36][L] && inside && !outside);
    row('8', `defense post L${L}: radius, time and casualty multipliers`, `${dp.radiusTiles} tiles, ×${dp.timeMul} / ×${dp.casualtyMul}`, `${[0, 3, 4.5, 6][L]}`, dp.radiusTiles === [0, 3, 4.5, 6][L]);
  }
};

// -------------------------------------------------------------------------------------------------------------
// 11: a division by rail between two connected cities ~600 km apart: 6 h ± 10 %
// -------------------------------------------------------------------------------------------------------------
scenarios.rail = () => {
  const { g, events, step, H } = quiet(0);
  claim(g, HUMAN_ID, T(40.0, -3.5), 40);
  const A = T(37.39, -5.98), B = T(41.65, -0.88); // Sevilla -> Zaragoza
  struct(g, S.City, HUMAN_ID, A, 1);
  struct(g, S.City, HUMAN_ID, B, 1);
  struct(g, S.Factory, HUMAN_ID, T(40.42, -3.7), 1);
  step(3);
  const km = kmXY((A % MAP_W) + 0.5, Math.floor(A / MAP_W) + 0.5, (B % MAP_W) + 0.5, Math.floor(B / MAP_W) + 0.5);
  const div = spawn(g, U.ArmoredDivision, HUMAN_ID, A);
  const links = g.economy.railPairs();
  const sa = g.structAt[A], sb = g.structAt[B];
  let direct = false;
  for (let i = 0; i + 1 < links.length; i += 2) if ((links[i] === sa && links[i + 1] === sb) || (links[i] === sb && links[i + 1] === sa)) direct = true;
  g.unitSys.order(H, [div.id], 'move', B, 0);
  const route = g.unitSys.takeRoutes(false);
  const onRail = div.mode;
  const t0 = g.tick;
  let railTicks = 0;
  for (let i = 0; i < 300 && div.path; i++) {
    step();
    if (g.unitSys.publicMode(div) === M.Rail) railTicks++;
  }
  const h = (g.tick - t0) / 10;
  row('11', `Sevilla -> Zaragoza (${km.toFixed(0)} km, ${direct ? 'direct link' : 'via the network'}): arrival`, `${h.toFixed(1)} h, ${railTicks} ticks on the train`, `${(km / 100).toFixed(1)} h ± 10 %`, Math.abs(h / (km / 100) - 1) <= 0.1 && railTicks > 0);
  row('11', 'its route published (drawn along the rail line)', route ? `${route.length} route(s), ${route[0]?.tiles.length ?? 0} waypoints` : 'none', '>= 1', !!route && route.length >= 1);
  void onRail;
  void events;
};

// -------------------------------------------------------------------------------------------------------------
// 12: blockade: an enemy trade ship entering the zone is captured (payout to the captor); convoys are engaged
// -------------------------------------------------------------------------------------------------------------
scenarios.blockade = () => {
  const { g, events, step, H, others } = quiet(1);
  const E = others[0];
  claim(g, HUMAN_ID, T(40.4, -3.7), 30);
  claim(g, E.id, T(43.5, 11.5), 12); // Tuscany
  war(g, HUMAN_ID, E.id);
  step();
  const station = water(g, 43.3, 9.8);
  const ws = spawn(g, U.Warship, HUMAN_ID, water(g, 41.5, 3.5));
  const accepted = g.unitSys.order(H, [ws.id], 'blockade', station, 0);
  for (let i = 0; i < 400 && ws.path; i++) step();
  step(3);
  const atStation = kmXY(ws.x, ws.y, (station % MAP_W) + 0.5, Math.floor(station / MAP_W) + 0.5);
  row('12', 'blockade order accepted, warship on station', `${accepted}, ${atStation.toFixed(0)} km from the station, mode ${g.unitSys.publicMode(ws)}`, 'true, < 40 km', accepted && atStation < 40);
  const gold0 = H.gold;
  const ts = spawn(g, U.TradeShip, E.id, water(g, 42.6, 9.6), water(g, 44.1, 9.7));
  ts.cargo = 5000;
  let cap = null;
  for (let i = 0; i < 80 && !cap; i++) {
    step();
    cap = events.find((e) => e.type === 'shipCaptured' && e.unitId === ts.id);
  }
  row('12', 'enemy trade ship in the zone captured, payout to the captor', cap ? `captured, +${cap.gold} to ${cap.by === HUMAN_ID ? 'us' : cap.by}` : 'not captured', 'shipCaptured, gold 5000 to the human', cap && cap.by === HUMAN_ID && cap.gold === 5000 && H.gold - gold0 >= 4999);
  const cv = spawn(g, U.TransportShip, E.id, water(g, 43.0, 9.4), water(g, 41.0, 5));
  let shots = 0;
  for (let i = 0; i < 60 && !cv.dead; i++) {
    const n0 = events.length;
    step();
    shots += events.slice(n0).filter((e) => e.type === 'combat' && e.kind === 'shell' && e.owner === HUMAN_ID).length;
  }
  row('12', 'enemy convoy in the zone engaged', `${shots} salvoes, convoy ${cv.dead ? 'sunk' : `${(cv.hp / cv.maxHp * 100).toFixed(0)} %`}`, '>= 1 salvo', shots >= 1);
};

// -------------------------------------------------------------------------------------------------------------
// 13: a fighter CAP persists until recalled and intercepts raids crossing its circle
// -------------------------------------------------------------------------------------------------------------
scenarios.cap = () => {
  const { g, events, step, H, others } = quiet(1);
  const E = others[0];
  claim(g, HUMAN_ID, T(40.4, -3.7), 30);
  claim(g, E.id, T(46.5, 2.5), 25);
  war(g, HUMAN_ID, E.id);
  const base = struct(g, S.Airbase, HUMAN_ID, T(40.42, -3.7), 1);
  const eb = struct(g, S.Airbase, E.id, T(46.5, 2.5), 3);
  const f = spawn(g, U.FighterSquadron, HUMAN_ID, base.tile);
  step();
  const station = T(42.3, -1.5);
  g.unitSys.order(H, [f.id], 'cap', station, 0);
  // 20 raids crossing the circle toward Madrid, one every 120 ticks.
  let killed = 0, launched = 0;
  const raiders = [];
  for (let i = 0; i < 2600; i++) {
    if (i >= 100 && i % 120 === 0 && launched < 20) {
      const b = spawn(g, U.Bomber, E.id, T(44.5, 0.4), T(40.1, -3.2));
      b.home = eb.id;
      raiders.push(b);
      launched++;
    }
    step();
  }
  for (const b of raiders) if (b.dead && b.killedBy === HUMAN_ID) killed++;
  const alive = !f.dead;
  const mode = g.unitSys.publicMode(f);
  // Owner feedback #2 item 25: the patrol refuels at its base every ~22 h and goes back by itself; it keeps its order.
  const onCap = f.order === UNIT_ORDER_KINDS.indexOf('cap');
  row('13', 'CAP persists (>= 2400 ticks, until recalled; refuels and goes back by itself)', `${alive ? 'alive' : 'lost'}, mode ${mode}, order ${UNIT_ORDER_KINDS[f.order] ?? 'none'}, ${g.tick} ticks`, 'patrolling or refuelling, order cap', alive && onCap && (mode === M.Patrol || mode === M.Engaged || mode === M.Returning || mode === M.Rearming));
  row('13', '20 bomber sorties crossing the circle intercepted', `${killed}/20`, '>= 10', killed >= 10);
  g.unitSys.order(H, [f.id], 'return', -1, 0);
  step(80);
  row('13', 'recalled: returns to base', `mode ${g.unitSys.publicMode(f)}`, 'docked / rearming', g.unitSys.publicMode(f) === M.Docked || g.unitSys.publicMode(f) === M.Rearming);
  void events;
};

// -------------------------------------------------------------------------------------------------------------
// 16: radar coverage from STRUCTURE_LEVELS: invasion at embarkation, air raids at take-off, never after the strike
// -------------------------------------------------------------------------------------------------------------
scenarios.detection = () => {
  {
    const { g, events, step, H, others } = quiet(1);
    const E = others[0];
    claim(g, HUMAN_ID, T(40.4, -3.7), 30);
    claim(g, E.id, T(35.0, -5.0), 12); // northern Morocco
    struct(g, S.Radar, HUMAN_ID, T(36.8, -4.5), 1); // Málaga: 500 km covers the Strait and Tangier
    war(g, E.id, HUMAN_ID);
    step();
    E.troops = 200_000;
    const ok = g.unitSys.boatAttack(E, coastal(g, 36.7, -4.4, HUMAN_ID), 0.3);
    const t0 = g.tick;
    step(2);
    const d = events.find((e) => e.type === 'invasionDetected' && e.target === HUMAN_ID);
    row('16', 'invasion embarking inside the radar coverage: detected at embarkation', d ? `${d.by} at +${d.tick - t0} (embarking)` : `none (launch ${ok})`, 'radar at +0', d && d.by === 'radar' && d.tick - t0 <= 1);
  }
  const raid = (withRadar, radarAtBase) => {
    const { g, events, step, H, others } = quiet(1);
    const E = others[0];
    claim(g, HUMAN_ID, T(40.4, -3.7), 30);
    claim(g, E.id, T(45.5, 1.5), 25);
    war(g, E.id, HUMAN_ID);
    const target = struct(g, S.ArmyBase, HUMAN_ID, T(41.65, -0.88), 1);
    if (withRadar) struct(g, S.Radar, HUMAN_ID, radarAtBase ? T(42.8, -1.6) : T(40.0, -3.0), radarAtBase ? 3 : 1);
    const eb = struct(g, S.Airbase, E.id, T(45.5, 1.5), 1);
    g.war.raiseEscalation(E.id, HUMAN_ID, 1, 'escalation.reason.player');
    const b = spawn(g, U.Bomber, E.id, eb.tile);
    step();
    const t0 = g.tick;
    g.unitSys.order(E, [b.id], 'strike', target.tile, target.id);
    step(1);
    let raidE = null, hitE = null;
    for (let i = 0; i < 100; i++) {
      raidE ??= events.find((e) => e.type === 'airRaid' && e.unitId === b.id);
      hitE ??= events.find((e) => e.type === 'strikeResult' && e.unitId === b.id);
      if (hitE) break;
      step();
    }
    raidE ??= events.find((e) => e.type === 'airRaid' && e.unitId === b.id);
    return { raid: raidE, hit: hitE, t0, kmLeft: raidE ? kmXY(b.x, b.y, target.x, target.y) : 0 };
  };
  const r1 = raid(true, true);
  row('16', 'raid from an airbase inside our coverage: airRaid on its take-off tick', r1.raid ? `${r1.raid.by} at +${r1.raid.tick - r1.t0}, ETA ${r1.raid.etaTicks} ticks` : 'none', 'takeoff at +0', r1.raid && r1.raid.by === 'takeoff' && r1.raid.tick === r1.t0);
  row('16', 'T36: announced before the strike', r1.raid && r1.hit ? `raid ${r1.raid.tick}, strike ${r1.hit.tick}` : '-', 'raid < strike', r1.raid && r1.hit && r1.raid.tick < r1.hit.tick);
  const r2 = raid(true, false);
  row('16', 'raid from outside the coverage: on entering it', r2.raid ? `${r2.raid.by}, strike ${r2.hit ? r2.hit.tick - r2.raid.tick : '-'} ticks later` : 'none', 'radar, before the strike', r2.raid && r2.raid.by === 'radar' && r2.hit && r2.raid.tick < r2.hit.tick);
  const r3 = raid(false, false);
  row('16', 'no radar: observers 250 km from the target', r3.raid ? `${r3.raid.by}, strike ${r3.hit ? r3.hit.tick - r3.raid.tick : '-'} ticks later` : 'none', 'observers, before the strike', r3.raid && r3.raid.by === 'observers' && r3.hit && r3.raid.tick < r3.hit.tick);
};

// -------------------------------------------------------------------------------------------------------------
// 3 (headless half): the sim takes an order exactly when orderError allows it
// -------------------------------------------------------------------------------------------------------------
scenarios.parity = () => {
  const { g, events, step, H, others } = quiet(2);
  const [E, P] = others;
  claim(g, HUMAN_ID, T(40.4, -3.7), 30);
  claim(g, E.id, T(46.5, 2.5), 25);
  claim(g, P.id, T(51.2, 10.4), 20);
  war(g, HUMAN_ID, E.id);
  const ab = struct(g, S.Airbase, HUMAN_ID, T(40.42, -3.7), 3);
  struct(g, S.ArmyBase, HUMAN_ID, T(41.0, -2.0), 1);
  struct(g, S.NavalYard, HUMAN_ID, coastal(g, 39.47, -0.38, HUMAN_ID), 1);
  struct(g, S.Airbase, E.id, T(46.5, 2.5), 1);
  struct(g, S.City, E.id, T(45.8, 4.8), 1);
  struct(g, S.City, P.id, T(51.2, 10.4), 1);
  step();
  const units = [
    spawn(g, U.ArmoredDivision, HUMAN_ID, T(41.5, -1.0)),
    spawn(g, U.ArmoredDivision, HUMAN_ID, T(40.0, -4.0)),
    spawn(g, U.FighterSquadron, HUMAN_ID, ab.tile),
    spawn(g, U.Bomber, HUMAN_ID, ab.tile),
    spawn(g, U.DroneSwarm, HUMAN_ID, ab.tile),
    spawn(g, U.Warship, HUMAN_ID, water(g, 39.0, 1.0)),
  ];
  step();
  let rng = 12345;
  const rnd = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let agree = 0, total = 0;
  const bad = [];
  for (let i = 0; i < 200; i++) {
    const u = units[i % units.length];
    if (u.dead) continue;
    const lat = 34 + rnd() * 22, lon = -12 + rnd() * 28;
    const tile = T(lat, lon);
    const tStruct = g.structAt[tile] || 0;
    const inf = inferOrder(g.rules, u.id, tile, 0, tStruct, rnd() < 0.2);
    const pred = orderError(g.rules, u.id, inf.order, tile, inf.targetId);
    const n0 = events.length;
    g.issue(HUMAN_ID, { type: 'unitOrder', unitIds: [u.id], order: inf.order, tile, targetId: inf.targetId });
    step();
    const ack = events.slice(n0).find((e) => e.type === 'orderAck');
    const took = !!ack && ack.accepted.includes(u.id);
    total++;
    if (took === (pred === null)) agree++;
    else bad.push(`${UNIT_DEFS[u.type].id} ${inf.order} @${lat.toFixed(1)},${lon.toFixed(1)}: preview ${pred ?? 'ok'}, sim ${took ? 'took' : ack?.errorKey}`);
    // Keep the units available: send aircraft home at once, stop divisions.
    if (took && i % 3 === 0) for (const x of units) if (!x.dead && (x.type === U.FighterSquadron || x.type === U.Bomber || x.type === U.DroneSwarm)) {
      g.unitSys.order(H, [x.id], 'return', -1, 0);
    }
  }
  row('3', `order parity over ${total} random right-click orders (all unit types)`, `${agree}/${total}`, '100 %', agree === total && total >= 50);
  for (const b of bad.slice(0, 5)) console.log('   ', b);
};

// -------------------------------------------------------------------------------------------------------------
// 20: units, structures and production survive a save and restore identically
// -------------------------------------------------------------------------------------------------------------
scenarios.save = () => {
  const mk = () => {
    const q = quiet(1);
    const { g, step, H, others } = q;
    const E = others[0];
    claim(g, HUMAN_ID, T(40.4, -3.7), 30);
    claim(g, E.id, T(46.5, 2.5), 25);
    war(g, HUMAN_ID, E.id);
    const ab = struct(g, S.Airbase, HUMAN_ID, T(40.42, -3.7), 2);
    const armyBase = struct(g, S.ArmyBase, HUMAN_ID, T(41.0, -2.0), 2);
    struct(g, S.Port, HUMAN_ID, coastal(g, 39.47, -0.38, HUMAN_ID), 2);
    struct(g, S.Airbase, E.id, T(46.5, 2.5), 1);
    g.addGold(HUMAN_ID, 20_000_000);
    step();
    const f = spawn(g, U.FighterSquadron, HUMAN_ID, ab.tile);
    const b = spawn(g, U.Bomber, HUMAN_ID, ab.tile);
    const d = spawn(g, U.ArmoredDivision, HUMAN_ID, T(41.5, -1.0));
    step();
    g.unitSys.order(H, [f.id], 'cap', T(42.5, -1.5), 0);
    g.unitSys.order(H, [b.id], 'strike', T(46.5, 2.5), g.structAt[T(46.5, 2.5)]);
    g.unitSys.order(H, [d.id], 'attach', T(43.5, 0.5), 0);
    g.unitSys.buildUnit(H, U.ArmoredDivision, armyBase.id);
    g.unitSys.buildUnit(H, U.DroneSwarm, ab.id);
    step(30);
    return q;
  };
  const A = mk();
  const w = new SaveWriter();
  A.g.serialize(w);
  const blob = w.finish();
  const B = { g: Game.restore(new SaveReader(blob), world) };
  B.g.ai = { setup() {}, tick() {}, onEvent() {} };
  const sig = (g) => {
    const us = [...g.unitMap.values()].map((u) => `${u.id}:${u.type}:${u.owner}:${u.x.toFixed(3)},${u.y.toFixed(3)}:${u.hp.toFixed(3)}:${u.mode}:${u.order}:${u.serial}:${u.home}`).sort().join('|');
    const ss = [...g.structureMap.values()].map((s) => `${s.id}:${s.type}:${s.level}:${s.hp.toFixed(3)}:${s.queue.map((q) => `${q.unit}@${q.readyTick}#${q.serial}`).join('+')}`).sort().join('|');
    return { us, ss, prod: JSON.stringify(g.unitSys.productionViews()) };
  };
  const a0 = sig(A.g), b0 = sig(B.g);
  row('20', 'units, structures, queues identical right after restore', a0.us === b0.us && a0.ss === b0.ss && a0.prod === b0.prod ? 'identical' : 'differ', 'identical', a0.us === b0.us && a0.ss === b0.ss && a0.prod === b0.prod);
  for (let i = 0; i < 300; i++) {
    A.g.tick1();
    A.g.buildUpdate(1);
    B.g.tick1();
    B.g.buildUpdate(1);
  }
  const a1 = sig(A.g), b1 = sig(B.g);
  const same = a1.us === b1.us && a1.ss === b1.ss && a1.prod === b1.prod;
  if (!same) {
    const au = a1.us.split('|'), bu = b1.us.split('|');
    for (let i = 0; i < Math.max(au.length, bu.length); i++) if (au[i] !== bu[i]) {
      console.log(`   first unit difference: A ${au[i]} / B ${bu[i]}`);
      break;
    }
  }
  row('20', '300 ticks later (orders, production, sorties): identical', same ? 'identical' : 'differ', 'identical', same);
};

for (const [name, fn] of Object.entries(scenarios)) {
  if (ONLY && ONLY !== name) continue;
  try {
    fn();
  } catch (err) {
    row(name, 'scenario crashed', String(err?.stack ?? err).slice(0, 400), 'no crash', false);
  }
}
console.log('\n=== W4 audit ===');
const w = Math.max(...results.map((r) => r.what.length), 10);
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${String(r.id).padEnd(10)} ${r.what.padEnd(w)}  ${r.value.padEnd(24)} target ${r.target}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`--- ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
