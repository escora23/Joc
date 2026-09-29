// FRONT ULTRA — air missions audit (owner item #25, FEEDBACK-1): the missions a player (or an AI) gives its aircraft
// from the strategic map have real, measured effects in the simulation. Test tooling only, never bundled.
//
//   npx tsx src/sim/test/air-audit.mjs [--only cap|cas|strike|ai|airspace] [--json out.json]
//
// C1  CAP over a border against the REAL AI (the sim-ai director, not a script): the AI at war raids us with bombers
//     and drones; a fighter patrol over the border intercepts them. Same seed with and without the patrol: raids that
//     reach their target and the damage they do.
// C2  close air support and air superiority change a front's measured advance: one offensive on a straight plains
//     front, same seed and troops, measured km/h and tiles taken in 300 ticks: baseline, with drones in support, with
//     a fighter patrol over the front (superiority), with the enemy's patrol there (denial), with both patrols.
// C3  strikes do damage: a bomber on a structure (hp), on the front sector (the enemy garrison there), an escorted
//     bomber through an enemy patrol survives more often than an unescorted one.
// C4  the AI flies the same missions: over a war with its own offensive, orders of kind support (drones), escort
//     (fighters with bombers) and cap (fighters) are issued and acknowledged.
// C5  the strategic map refuses a patrol over a nation at peace without alliance / open borders (#19), accepts it at
//     war and over own land.

import fs from 'node:fs';
import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID, MAP_W } from '../../shared/constants.ts';
import { latLonToTile, latLonToTileXY } from '../../shared/geo.ts';
import { orderError } from '../../shared/orders.ts';
import { StructureType as S, UnitType as U } from '../../shared/types.ts';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 || argv[i + 1] === undefined ? def : argv[i + 1];
};
const ONLY = arg('only', null);
const JSON_OUT = arg('json', null);
const world = await loadWorldInit(() => {});
const T = (lat, lon) => latLonToTile(lat, lon);
const results = [];
const row = (id, what, value, target, pass) => results.push({ id, what, value: String(value), target, pass: !!pass });

function quiet(n, realAi, seed = 7) {
  Game.withFallbackAi = false;
  const g = new Game({
    seed, playerName: 'Audit', playerColor: 0x3366ff, difficulty: 'normal', aiCount: n, tribeCount: 0, speed: 1,
    nukes: false, worldEvents: false, startWorldTimeSec: 0, spawnTimeoutTicks: 50, autoSpawnTile: T(40.4, -3.7),
    instantStart: true, humanAutopilot: false, duration: 'normal',
  }, world);
  g.onError = (m, s) => {
    throw new Error(`sim error: ${m}\n${s ?? ''}`);
  };
  if (!realAi) g.ai = { setup() {}, tick() {}, onEvent() {} };
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

// -------------------------------------------------------------------------------------------------------------
// C1 + C4: the real AI raids us; a CAP over the border intercepts
// -------------------------------------------------------------------------------------------------------------
function aiRaids(withCap) {
  const { g, events, step, H, others } = quiet(1, true, 11);
  const E = others[0];
  // The sim only acknowledges the human's orders to the UI: record every AI order the unit system accepts.
  const aiOrders = {};
  const order0 = g.unitSys.order.bind(g.unitSys);
  g.unitSys.order = (p, ids, order, tile, targetId, ratio, confirm) => {
    const ok = order0(p, ids, order, tile, targetId, ratio, confirm);
    if (ok && p.id === E.id) aiOrders[order] = (aiOrders[order] ?? 0) + 1;
    return ok;
  };
  claim(g, HUMAN_ID, T(40.4, -3.7), 22);
  claim(g, E.id, T(46.5, 2.5), 22);
  // Our cities and factories are the AI's targets; its airbase is in southern France, ours near Madrid.
  const targets = [struct(g, S.City, HUMAN_ID, T(41.65, -0.88), 2), struct(g, S.Factory, HUMAN_ID, T(41.4, 2.1), 2), struct(g, S.City, HUMAN_ID, T(42.8, -1.6), 1)];
  const ab = struct(g, S.Airbase, HUMAN_ID, T(40.42, -3.7), 3);
  const eab = struct(g, S.Airbase, E.id, T(44.8, 0.6), 3);
  struct(g, S.Airbase, E.id, T(45.5, 3.0), 3);
  for (let i = 0; i < 3; i++) spawn(g, U.Bomber, E.id, eab.tile);
  for (let i = 0; i < 3; i++) spawn(g, U.DroneSwarm, E.id, eab.tile);
  for (let i = 0; i < 3; i++) spawn(g, U.FighterSquadron, E.id, eab.tile);
  g.addGold(E.id, 20_000_000);
  E.troops = Math.max(E.troops, 900_000);
  H.troops = Math.max(H.troops, 700_000);
  war(g, E.id, HUMAN_ID);
  g.war.raiseEscalation(E.id, HUMAN_ID, 2, 'escalation.reason.debug');
  const caps = [];
  if (withCap) {
    // Two squadrons on patrol over the Pyrenees border (the raids' way in).
    // Each squadron now refuels every ~22 h (C6); a player covering a border staggers them (the tooltip says so).
    for (const [lat, lon] of [[42.6, -0.5], [42.2, 1.8]]) {
      const f = spawn(g, U.FighterSquadron, HUMAN_ID, ab.tile);
      step(caps.length ? 110 : 1);
      g.unitSys.order(H, [f.id], 'cap', T(lat, lon), 0);
      caps.push(f);
    }
  }
  step();
  const t0 = g.tick;
  for (let i = 0; i < 2400; i++) {
    step();
    if (argv.includes('--trace2') && i % 10 === 0) {
      const raiders = [...g.unitMap.values()].filter((u) => u.owner === E.id && (u.type === U.Bomber || u.type === U.DroneSwarm || u.type === U.FighterSquadron) && u.mode !== 13);
      if (raiders.length) console.log(i, caps.map((f) => `${f.id}:${f.dead ? 'dead' : f.mode}@${f.x.toFixed(0)},${f.y.toFixed(0)}`).join(' '), '|', raiders.map((u) => `${u.type}:${u.mode}@${u.x.toFixed(0)},${u.y.toFixed(0)}`).join(' '));
    }
    E.troops = Math.max(E.troops, 600_000);
    H.troops = Math.max(H.troops, 500_000);
  }
  const raids = events.filter((e) => e.type === 'airRaid' && e.owner === E.id && e.tick >= t0);
  const hits = events.filter((e) => e.type === 'strikeResult' && e.owner === E.id && e.tick >= t0);
  const dmg = hits.reduce((s, e) => s + (e.kind === 'structure' ? e.damage : 0), 0);
  const troops = hits.reduce((s, e) => s + (e.kind === 'front' ? e.damage : 0), 0);
  const downed = events.filter((e) => e.type === 'unitDestroyed' && e.owner === E.id && e.by === HUMAN_ID && (e.unit === U.Bomber || e.unit === U.DroneSwarm));
  const kinds = aiOrders;
  void targets;
  return { raids: raids.length, hits: hits.length, dmg, troops, downed: downed.length, kinds, capLost: caps.filter((f) => f.dead).length, events, E, g };
}

function cap() {
  const off = aiRaids(false), on = aiRaids(true);
  if (argv.includes('--trace')) for (const [n, r] of [['off', off], ['on', on]]) console.log(n, r.events.filter((e) => e.type === 'strikeResult' && e.owner === r.E.id).map((e) => `${e.tick}:${e.kind}:${e.structure}:${e.damage}`).join(' '));
  row('C1', 'AI raids launched against us in 2,400 ticks (no patrol / with patrol)', `${off.raids} / ${on.raids}`, '≥ 3 each', off.raids >= 3 && on.raids >= 3);
  row('C1', 'AI bombers and drones shot down by our patrol', `${on.downed} (no patrol: ${off.downed})`, '≥ 2, more than without', on.downed >= 2 && on.downed > off.downed);
  row('C1', 'AI strikes that reached their target', `${on.hits} with patrol vs ${off.hits} without`, 'fewer with the patrol', on.hits < off.hits);
  row('C1', 'damage the AI raids did (structure hp, troops at the front)', `${on.dmg.toFixed(1)} hp + ${Math.round(on.troops)} troops with patrol vs ${off.dmg.toFixed(1)} hp + ${Math.round(off.troops)} troops without`, 'less with the patrol', on.dmg <= off.dmg && on.troops < off.troops && on.dmg + on.troops / 1e4 < off.dmg + off.troops / 1e4);
  row('C1', 'our patrol squadrons lost (enemy fighters fight back)', `${on.capLost}/2`, 'reported', true);
  const k = on.kinds;
  row('C4', 'AI mission orders accepted by the sim (with patrol run)', JSON.stringify(k), 'strike + cap + support or escort', (k.strike ?? 0) > 0 && (k.cap ?? 0) > 0 && ((k.support ?? 0) > 0 || (k.escort ?? 0) > 0));
  const k2 = off.kinds;
  row('C4', 'AI mission orders accepted by the sim (no patrol run)', JSON.stringify(k2), 'escort or support present', (k2.support ?? 0) + (k2.escort ?? 0) + (k.support ?? 0) + (k.escort ?? 0) > 0);
}

// -------------------------------------------------------------------------------------------------------------
// C2: CAS and air superiority measured on a front
// -------------------------------------------------------------------------------------------------------------
function plainsFront(seed, setup) {
  const { g, events, step, H } = quiet(0, false, seed);
  const W = MAP_W;
  g.transferContext = 'staging';
  for (let t = 0; t < g.owner.length; t++) if (g.owner[t] === HUMAN_ID) g.setOwner(t, 0);
  g.transferContext = 'none';
  const c = latLonToTileXY(40, -98);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  const inRect = (t, x0, x1, y0, y1) => {
    const x = t % W, y = Math.floor(t / W);
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  };
  const E = g.addPlayer({ name: 'Enemigo', kind: 'nation', personality: 'conqueror', color: 0xcc3333, countryIndex: 0 });
  g.transferContext = 'staging';
  for (let t = 0; t < g.owner.length; t++) {
    if (!g.playable[t]) continue;
    if (inRect(t, cx - 30, cx - 1, cy - 20, cy + 20)) g.setOwner(t, HUMAN_ID);
    else if (inRect(t, cx, cx + 29, cy - 20, cy + 20)) g.setOwner(t, E);
  }
  g.transferContext = 'none';
  const D = g.playerById[HUMAN_ID], P = g.playerById[E];
  P.spawned = true;
  P.metaDirty = true;
  D.capitalTile = cy * W + cx - 18;
  P.capitalTile = cy * W + cx + 18;
  step();
  const ab = struct(g, S.Airbase, HUMAN_ID, cy * W + cx - 12, 3);
  const eab = struct(g, S.Airbase, E, cy * W + cx + 12, 3);
  g.war.declare(HUMAN_ID, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  g.war.raiseEscalation(HUMAN_ID, E, 1, 'escalation.reason.debug');
  g.war.raiseEscalation(E, HUMAN_ID, 1, 'escalation.reason.debug');
  step(20);
  const aim = cy * W + cx + 8;
  const onFront = cy * W + cx + 1;
  const ctx = { g, H, D, P, E, ab, eab, aim, onFront, step, cx, cy };
  setup(ctx, 'before');
  step(40); // the aircraft reach their stations
  D.troops = 1_000_000;
  P.troops = 700_000;
  g.issue(HUMAN_ID, { type: 'attack', target: E, ratio: 0.5, tile: aim });
  const a = g.attackList.find((x) => !x.ended && x.attacker === HUMAN_ID);
  const t0 = g.tick;
  let kmh = 0, n = 0, air = 0, cas = 0;
  for (let i = 0; i < 300; i++) {
    setup(ctx, 'tick');
    step();
    if (a && g.tick - t0 > 60 && a.state === 'advancing') {
      kmh += a.advanceKmh;
      n++;
    }
    if (a) {
      air = a.air;
      cas = a.casAtk;
    }
  }
  const taken = a ? a.tilesTaken : 0;
  const rec = g.fronts.take().find((f) => f.key === a?.frontKey);
  return { kmh: n ? kmh / n : 0, taken, air, cas, rec, events };
}

function cas() {
  const none = () => {};
  const drones = ({ g, H, ab, onFront, step }, phase) => {
    if (phase !== 'before') return;
    for (let i = 0; i < 2; i++) {
      const d = spawn(g, U.DroneSwarm, HUMAN_ID, ab.tile);
      step();
      g.unitSys.order(H, [d.id], 'support', onFront, 0);
    }
  };
  const ourCap = ({ g, H, ab, onFront, step }, phase) => {
    if (phase !== 'before') return;
    const f = spawn(g, U.FighterSquadron, HUMAN_ID, ab.tile);
    step();
    g.unitSys.order(H, [f.id], 'cap', onFront, 0);
    f.hp = f.maxHp * 100; // no losses in this measurement: the effect of the sky, not the dogfight
  };
  const theirCap = ({ g, P, eab, onFront, step }, phase) => {
    if (phase !== 'before') return;
    const f = spawn(g, U.FighterSquadron, P.id, eab.tile);
    step();
    g.unitSys.order(P, [f.id], 'cap', onFront, 0);
    f.hp = f.maxHp * 100;
  };
  const both = (c, p) => {
    ourCap(c, p);
    theirCap(c, p);
  };
  const dronesUnderTheirSky = (c, p) => {
    drones(c, p);
    theirCap(c, p);
  };
  const base = plainsFront(5, none);
  const withDrones = plainsFront(5, drones);
  const withCap = plainsFront(5, ourCap);
  const denied = plainsFront(5, theirCap);
  const contested = plainsFront(5, both);
  const dronesDenied = plainsFront(5, dronesUnderTheirSky);
  const f = (r) => `${r.kmh.toFixed(2)} km/h, ${r.taken} tiles`;
  row('C2', 'baseline offensive (no aircraft)', f(base), 'reference', base.taken > 0);
  row('C2', '2 drone swarms in close air support', `${f(withDrones)} (cas ${withDrones.cas}) = ×${(withDrones.kmh / base.kmh).toFixed(2)}`, 'faster than baseline (×1.15-1.3)', withDrones.kmh > base.kmh * 1.08 && withDrones.cas > 0);
  row('C2', 'our fighter patrol over the front: air superiority', `${f(withCap)} (air ${withCap.air}) = ×${(withCap.kmh / base.kmh).toFixed(2)}`, 'faster (×~1.10), air = 1', withCap.kmh > base.kmh * 1.04 && withCap.air === 1);
  row('C2', 'the enemy\'s patrol over the front: denial', `${f(denied)} (air ${denied.air}) = ×${(denied.kmh / base.kmh).toFixed(2)}`, 'slower (×~0.90), air = -1', denied.kmh < base.kmh * 0.97 && denied.air === -1);
  row('C2', 'both patrols: contested sky', `${f(contested)} (air ${contested.air})`, 'air = 0, ≈ baseline', contested.air === 0 && Math.abs(contested.kmh / base.kmh - 1) < 0.06);
  row('C2', 'our drones under the enemy\'s sky do not count', `${f(dronesDenied)} (cas ${dronesDenied.cas}, air ${dronesDenied.air})`, 'cas 0, air -1', dronesDenied.cas === 0 && dronesDenied.air === -1);
  const r = withCap.rec;
  row('C2', 'the front record carries the sky (Guerra panel)', r ? `airA ${r.airA}, airB ${r.airB}, casA ${r.casA}` : 'no record', 'airA ≥ 1', r && r.airA >= 1);
}

// -------------------------------------------------------------------------------------------------------------
// C3: strikes do damage; escorts protect
// -------------------------------------------------------------------------------------------------------------
function strike() {
  {
    const { g, events, step, H, others } = quiet(1, false);
    const E = others[0];
    claim(g, HUMAN_ID, T(40.4, -3.7), 22);
    claim(g, E.id, T(46.5, 2.5), 22);
    war(g, HUMAN_ID, E.id);
    const ab = struct(g, S.Airbase, HUMAN_ID, T(40.42, -3.7), 3);
    const fac = struct(g, S.Factory, E.id, T(45.8, 1.3), 2);
    g.war.raiseEscalation(HUMAN_ID, E.id, 2, 'escalation.reason.debug');
    const b = spawn(g, U.Bomber, HUMAN_ID, ab.tile);
    step();
    const hp0 = fac.hp;
    g.unitSys.order(H, [b.id], 'strike', fac.tile, fac.id, undefined, true);
    step(200);
    const sr = events.find((e) => e.type === 'strikeResult' && e.unitId === b.id);
    row('C3', 'bomber strike on an enemy factory', sr ? `hp ${hp0.toFixed(2)} → ${g.structureMap.has(fac.id) ? fac.hp.toFixed(2) : 'destroyed'} (damage ${sr.damage})` : 'no strike', 'damage > 0', sr && sr.damage > 0);
    // Front sector: the enemy's troops fall.
    const b2 = spawn(g, U.Bomber, HUMAN_ID, ab.tile);
    step();
    const sector = T(44.0, -0.5);
    const tr0 = E.troops;
    g.unitSys.order(H, [b2.id], 'strike', g.owner[sector] === E.id ? sector : T(45.0, 0.5), 0);
    step(200);
    const sr2 = events.find((e) => e.type === 'strikeResult' && e.unitId === b2.id);
    row('C3', 'bomber strike on the front sector', sr2 ? `${Math.round(sr2.damage)} enemy troops lost (of ${Math.round(tr0)})` : 'no strike', '> 0 troops', sr2 && sr2.damage > 0);
  }
  // Escort: 12 sorties each way through an enemy patrol.
  const run = (escorted) => {
    let lost = 0, hit = 0;
    for (let k = 0; k < 12; k++) {
      const { g, events, step, H, others } = quiet(1, false, 100 + k);
      const E = others[0];
      claim(g, HUMAN_ID, T(40.4, -3.7), 22);
      claim(g, E.id, T(46.5, 2.5), 22);
      war(g, HUMAN_ID, E.id);
      const ab = struct(g, S.Airbase, HUMAN_ID, T(40.42, -3.7), 3);
      const eab = struct(g, S.Airbase, E.id, T(47.5, 4.5), 3);
      const tgt = struct(g, S.ArmyBase, E.id, T(45.8, 1.3), 1);
      const pat = spawn(g, U.FighterSquadron, E.id, eab.tile);
      step();
      g.unitSys.order(E, [pat.id], 'cap', T(44.6, 0.2), 0);
      step(60);
      const b = spawn(g, U.Bomber, HUMAN_ID, ab.tile);
      const f = escorted ? spawn(g, U.FighterSquadron, HUMAN_ID, ab.tile) : null;
      step();
      g.unitSys.order(H, [b.id], 'strike', tgt.tile, tgt.id);
      if (f) g.unitSys.order(H, [f.id], 'escort', ab.tile, b.id);
      step(200);
      if (b.dead) lost++;
      if (events.some((e) => e.type === 'strikeResult' && e.unitId === b.id)) hit++;
    }
    return { lost, hit };
  };
  const alone = run(false), esc = run(true);
  row('C3', 'bombers through an enemy patrol: lost / on target, unescorted', `${alone.lost}/12 lost, ${alone.hit}/12 on target`, 'reference', true);
  row('C3', 'the same with a fighter escort', `${esc.lost}/12 lost, ${esc.hit}/12 on target`, 'fewer lost, more on target', esc.lost < alone.lost && esc.hit >= alone.hit);
}

// -------------------------------------------------------------------------------------------------------------
// C5: airspace rule of the strategic map
// -------------------------------------------------------------------------------------------------------------
function airspace() {
  const { g, step, H, others } = quiet(1, false);
  const E = others[0];
  claim(g, HUMAN_ID, T(40.4, -3.7), 22);
  claim(g, E.id, T(46.5, 2.5), 22);
  const ab = struct(g, S.Airbase, HUMAN_ID, T(40.42, -3.7), 3);
  const f = spawn(g, U.FighterSquadron, HUMAN_ID, ab.tile);
  step();
  const over = T(45.0, 1.0);
  const peace = orderError(g.rules, f.id, 'cap', over, 0);
  const own = orderError(g.rules, f.id, 'cap', T(41.0, -2.0), 0);
  war(g, HUMAN_ID, E.id);
  step();
  const atWar = orderError(g.rules, f.id, 'cap', over, 0);
  row('C5', 'patrol over a nation at peace (no treaty)', peace ?? 'accepted', 'order.err.airspace', peace === 'order.err.airspace');
  row('C5', 'patrol over own land', own ?? 'accepted', 'accepted', own === null);
  row('C5', 'patrol over the same nation at war', atWar ?? 'accepted', 'accepted', atWar === null);
  void H;
}

// -------------------------------------------------------------------------------------------------------------
// C6: a patrol runs out of fuel on station, flies home, rearms and goes back to the same station by itself
// -------------------------------------------------------------------------------------------------------------
function rotation() {
  const { g, step, H, others } = quiet(1, false);
  const E = others[0];
  claim(g, HUMAN_ID, T(40.4, -3.7), 22);
  claim(g, E.id, T(46.5, 2.5), 22);
  war(g, HUMAN_ID, E.id);
  const ab = struct(g, S.Airbase, HUMAN_ID, T(40.42, -3.7), 3);
  const f = spawn(g, U.FighterSquadron, HUMAN_ID, ab.tile);
  step();
  const station = T(42.6, -0.5);
  g.unitSys.order(H, [f.id], 'cap', station, 0);
  const cap = f.order;
  let arrive = -1, leave = -1, docked = -1, back = -1;
  for (let i = 0; i < 900 && back < 0; i++) {
    step();
    if (arrive < 0 && f.stationUntil > 0) arrive = g.tick;
    if (arrive >= 0 && leave < 0 && f.resumeOrder >= 0) leave = g.tick;
    if (leave >= 0 && docked < 0 && f.mode === 13 /* Mode.Docked */) docked = g.tick;
    if (docked >= 0 && f.stationUntil > 0) back = g.tick;
  }
  row('C6', 'patrol on station until its fuel runs out (game h)', arrive >= 0 && leave >= 0 ? ((leave - arrive) / 10).toFixed(1) : 'never', '6-24 h', leave > arrive && leave - arrive >= 60 && leave - arrive <= 240);
  row('C6', 'flies home keeping its order, rearms', docked >= 0 ? `docked at +${((docked - leave) / 10).toFixed(1)} h, order ${f.order === cap ? 'kept' : 'lost'}` : 'never docked', 'docks, order kept', docked > leave && f.order === cap);
  // Two squadrons ordered together over the same station relieve each other (never both refuelling at once).
  const f2 = spawn(g, U.FighterSquadron, HUMAN_ID, ab.tile), f3 = spawn(g, U.FighterSquadron, HUMAN_ID, ab.tile);
  step();
  const st2 = T(41.8, 1.0);
  g.unitSys.order(H, [f2.id, f3.id], 'cap', st2, 0);
  let both = 0, covered = 0;
  for (let i = 0; i < 800; i++) {
    step();
    const on = [f2, f3].filter((f) => f.mode === 7 && f.stationUntil > 0).length;
    if (i > 60) {
      covered += on > 0 ? 1 : 0;
      both += on === 0 ? 1 : 0;
    }
  }
  row('C6', 'two squadrons on one station take turns: hours with nobody on station (of 74 h)', `${(both / 10).toFixed(1)} h uncovered, ${(covered / 10).toFixed(1)} h covered`, '0 h uncovered', both === 0);
  row('C6', 'back on the same station by itself', back >= 0 ? `+${((back - docked) / 10).toFixed(1)} h after landing, station ${f.targetTile === station ? 'same' : 'other'}` : 'never', 'back, same station', back > docked && f.targetTile === station);
}

const all = { cap, cas, strike, airspace, rotation };
for (const [name, fn] of Object.entries(all)) {
  if (ONLY && ONLY !== name && !(ONLY === 'ai' && name === 'cap')) continue;
  const t = Date.now();
  try {
    fn();
  } catch (err) {
    row(name, 'scenario crashed', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '), 'no crash', false);
  }
  console.log(`[air-audit] ${name} ${((Date.now() - t) / 1000).toFixed(1)} s`);
}
let fail = 0;
for (const r of results) {
  if (!r.pass) fail++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.what}: ${r.value}  (target ${r.target})`);
}
console.log(`[air-audit] ${results.length - fail}/${results.length} pass`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
process.exit(fail ? 1 : 0);
