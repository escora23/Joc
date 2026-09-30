// FRONT ULTRA — owner item 30 audit (naval warfare on the sea lanes). Test tooling only, never bundled.
//
//   npx tsx src/sim/test/naval-audit.mjs [--only canal,strait,filter,seize,sink,convoy,escort,port,command,ai,save] [--json out.json]
//
// A small staged world: the human (Spain, a port at Cádiz), an enemy at war with it (ports at Naples and Genoa), a
// neutral trading nation (ports at New York and Rio) and a third nation (Alexandria). The real economy sends their
// merchants; the tests measure what blockades do to them.
//
//   N1  canals: Suez and Panama are sailable (Med → Red Sea, Pacific → Caribbean short).
//   N2  a strait (Gibraltar) closed to the enemy: its merchants to the Atlantic reroute (via Suez and the Cape) or run
//       it and are seized; its trade gold per hour before / after; the human's seized gold; the neutral untouched.
//   N3  selective blockade: 'war' leaves the neutral alone; 'all' stops it: piracy (opinion, casus belli, allies).
//   N4  seize: the merchant changes flag, sails to our port, pays its cargo there.
//   N5  sink: merchants go down, the cargo is lost to both.
//   N6  convoys: an invasion convoy through the zone is turned back (seize: troops home) or sunk (troops lost).
//   N7  escorts: an escorted merchant at peace passes; at war the escort is fought first.
//   N8  a port inside the zone sends no merchants; the port card's lost income per hour.
//   N9  command mode: hail (heaves to), warning shot, board, sink; distance checks.
//   N10 the AI: blockades the human's trade at a strait when at war; a neutral whose ships are seized protests,
//       embargoes, escorts and finally declares war.
//   N11 save / restore keeps the blockade and its ledger.

import fs from 'node:fs';
import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID, MAP_W, TILE_KM } from '../../shared/constants.ts';
import { latLonToTile } from '../../shared/geo.ts';
import { BLOCKADE_RADIUS_TILES, CHOKEPOINTS, chokepointTile } from '../../shared/naval.ts';
import { SaveReader, SaveWriter } from '../save.ts';
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
const row = (id, what, value, target, pass) => {
  results.push({ id, what, value: String(value), target, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${what}: ${value}  [${target}]`);
};
const want = (k) => !ONLY || ONLY.split(',').includes(k);

function makeGame(seed = 7, realAi = false, aiCount = 0) {
  Game.withFallbackAi = false;
  const g = new Game({
    seed, playerName: 'Audit', playerColor: 0x3366ff, difficulty: 'normal', aiCount, tribeCount: 0, speed: 1,
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
      if (i % 4 === 3) g.buildUpdate(4);
    }
  };
  return { g, events, step };
}

/** A coastal land tile near (lat, lon) conquered for `owner` with a port on it. */
function portAt(g, owner, lat, lon, level = 2) {
  const c = T(lat, lon);
  let best = -1, bd = Infinity;
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    const t = c + dy * MAP_W + dx;
    if (!g.playable[t] || !g.nav.coastal[t]) continue;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  if (best < 0) throw new Error(`no coast near ${lat},${lon}`);
  g.applyDebug({ type: 'conquer', playerId: owner, centerTile: best, radius: 3 });
  g.applyDebug({ type: 'spawnStructure', structure: S.Port, owner, tile: best, level });
  return g.structureMap.get(g.structAt[best]);
}

function spawn(g, type, owner, tile, target = -1) {
  const before = new Set(g.unitMap.keys());
  g.applyDebug({ type: 'spawnUnit', unit: type, owner, tile, targetTile: target });
  return [...g.unitMap.values()].find((u) => !before.has(u.id) && u.type === type);
}

const water = (g, lat, lon) => {
  const t = T(lat, lon);
  return g.nav.comp[t] >= 0 ? t : g.nav.waterNear(t);
};
const cp = (key) => CHOKEPOINTS.find((c) => c.key === key);

/** The staged Mediterranean world. */
function medWorld(seed = 7) {
  const q = makeGame(seed);
  const { g } = q;
  const add = (name, color) => g.addPlayer({ name, kind: 'nation', personality: 'balanced', color, countryIndex: 0 });
  const E = add('Enemigo', 0xcc3333);
  const N = add('Neutral', 0x3333cc);
  const M = add('Tercero', 0x33aa33);
  const H = g.playerById[HUMAN_ID];
  const ports = {
    cadiz: portAt(g, HUMAN_ID, 36.5, -6.3),
    naples: portAt(g, E, 40.8, 14.25, 3),
    genoa: portAt(g, E, 44.4, 8.9, 3),
    ny: portAt(g, N, 40.6, -74.0, 3),
    rio: portAt(g, N, -22.9, -43.2, 3),
    alex: portAt(g, M, 31.2, 29.9, 2),
    marseille: portAt(g, N, 43.3, 5.35, 2),
  };
  for (const id of [HUMAN_ID, E, N, M]) {
    const P = g.playerById[id];
    P.spawned = true;
    P.metaDirty = true;
    P.gold = Math.max(P.gold, 5_000_000);
  }
  g.war.declare(HUMAN_ID, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  q.step(2);
  return { ...q, E, N, M, H, ports };
}

/** Ships of `owner` (merchants) at sea now. */
const merchants = (g, owner) => [...g.unitMap.values()].filter((u) => u.type === U.TradeShip && u.owner === owner && !u.prize);

// -------------------------------------------------------------------------------------------------
if (want('canal')) {
  const { g } = makeGame(7);
  const km = (p) => {
    let s = 0;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      let dx = Math.abs((a % MAP_W) - (b % MAP_W));
      if (dx > 800) dx = 1600 - dx;
      const dy = Math.floor(a / MAP_W) - Math.floor(b / MAP_W);
      const c = Math.cos(((Math.floor(a / MAP_W) / 800) * 180 - 90) * Math.PI / 180);
      s += Math.hypot(dx * c, dy) * TILE_KM;
    }
    return Math.round(s);
  };
  g.nav.beginTick();
  const suez = g.nav.findPath(water(g, 33.5, 30), water(g, 20, 38.5));
  g.nav.beginTick();
  const pan = g.nav.findPath(water(g, 8, -80), water(g, 12, -78));
  row('N1', 'Suez canal: Mediterranean → Red Sea', suez ? `${km(suez)} km` : 'no path', '< 3000 km (was 21,477 around Africa)', suez && km(suez) < 3000);
  row('N1b', 'Panama canal: Pacific → Caribbean', pan ? `${km(pan)} km` : 'no path', '< 1500 km (was 19,063 around South America)', pan && km(pan) < 1500);
}

// -------------------------------------------------------------------------------------------------
if (want('strait') || want('filter') || want('seize')) {
  const W = medWorld(7);
  const { g, step, events, E, N, H, ports } = W;
  // Let the trade settle (merchants on every lane).
  step(600);
  const tradeE0 = g.playerById[E].tradeGold;
  step(480);
  const perHourBefore = (g.playerById[E].tradeGold - tradeE0) / 48;
  const gib = cp('gibraltar');
  const gt = chokepointTile(gib);
  const ws = [spawn(g, U.Warship, HUMAN_ID, water(g, 36.2, -6.6)), spawn(g, U.Warship, HUMAN_ID, water(g, 36.0, -6.9))];
  step(2);
  const ok = g.unitSys.order(H, ws.map((w) => w.id), 'blockade', gt, 0, undefined, undefined, { who: 'war', ships: 'all', action: 'seize' });
  step(60);
  const b = [...g.naval.blockades.values()][0];
  row('N2', 'order «Bloquear» at Gibraltar (enemies only, seize)', `accepted ${ok}, kind ${b?.kind}/${b?.key}, in force ${b?.active}, on station ${b?.onStation}`, 'strait blockade in force', ok && b?.kind === 'strait' && b.key === 'gibraltar' && b.active);
  const t1 = g.playerById[E].tradeGold;
  const g1 = g.naval.economyView(HUMAN_ID);
  step(1440);
  const perHourAfter = (g.playerById[E].tradeGold - t1) / 144;
  const rer = events.filter((e) => e.type === 'shipRerouted' && e.owner === E);
  const stops = events.filter((e) => e.type === 'shipStopped' && e.victim === E);
  const view = g.naval.views()[0];
  const nE = view.nations.find((n) => n.id === E);
  const nN = view.nations.find((n) => n.id === N);
  const avgExtra = rer.length ? Math.round(rer.reduce((s, e) => s + e.extraKm, 0) / rer.length) : 0;
  row('N2b', 'enemy merchants reroute around the strait (the long way, via Suez or the Cape)', `${view.rerouted} rerouted (${rer.length} events, +${avgExtra} km each on average)`, '≥ 2 rerouted, extra ≥ 2,000 km', view.rerouted >= 2 && avgExtra >= 2000);
  row('N2c', 'enemy merchants that ran it or were inside the zone: boarded and taken', `seized ${view.seized}, sunk ${view.sunk}, events ${stops.length}`, '≥ 1 seized', view.seized >= 1);
  row('N2d', 'enemy trade income per hour before / after (tradeGold of the enemy)', `${perHourBefore.toFixed(0)} → ${perHourAfter.toFixed(0)} gold/h (${Math.round((1 - perHourAfter / Math.max(1, perHourBefore)) * 100)} % less); the blockade's ledger: ${view.enemyLost} lost, ${view.enemyLostPerHour}/h`, 'lower after; ledger > 0', perHourAfter < perHourBefore && view.enemyLost > 0);
  const g2 = g.naval.economyView(HUMAN_ID);
  row('N2e', 'our gains: seized cargo delivered to Cádiz', `blockade gold ${view.gold} (${view.goldPerHour}/h), our ledger ${g1.gainTotal} → ${g2.gainTotal}`, '> 0', view.gold > 0 && g2.gainTotal > 0);
  row('N3', 'selective (enemies only): the neutral\'s ships pass untouched', `neutral stats: ${nN ? JSON.stringify(nN) : 'none'}; neutral opinion of us ${g.diplomacy.opinion(N, HUMAN_ID)}`, 'no neutral ship stopped or rerouted', !nN || (nN.seized + nN.sunk + nN.rerouted + nN.turnedBack === 0));
  const enemyLoss = g.naval.economyView(E);
  row('N2f', 'the enemy\'s ledger: trade lost to blockades', `${enemyLoss.lostTotal} total, ${enemyLoss.lostPerHour}/h, ${enemyLoss.rerouted} of its merchants on a detour now`, '> 0', enemyLoss.lostTotal > 0);
  void nE;
  // N4 seize: a merchant of the enemy placed inside the zone.
  if (want('seize')) {
    const m = spawn(g, U.TradeShip, E, water(g, 36.0, -5.2), water(g, 40.6, -70));
    m.cargo = 1234;
    const before = g.playerById[HUMAN_ID].gold;
    let flagged = false, arrived = false, paid = 0;
    for (let i = 0; i < 1200 && !arrived; i++) {
      step(1);
      if (m.owner === HUMAN_ID && m.prize) flagged = true;
      if (m.dead && flagged) arrived = true;
    }
    const del = events.find((e) => e.type === 'prizeDelivered' && e.unitId === m.id);
    paid = del?.gold ?? 0;
    row('N4', 'seize: boarded merchant changes flag and sails to our port, cargo paid on arrival', `flag ${flagged ? 'ours' : 'unchanged'}, delivered ${!!del} (+${paid} gold at ${del ? 'Cádiz' : '-'}), our gold ${Math.round(before)} → ${Math.round(g.playerById[HUMAN_ID].gold)}`, 'ours, delivered, +1234', flagged && del && paid === 1234);
  }
  // N3b: blockade everyone (at peace with the neutral): piracy.
  if (want('filter')) {
    const op0 = g.diplomacy.opinion(N, HUMAN_ID);
    g.unitSys.order(H, ws.map((w) => w.id), 'blockade', gt, 0, undefined, undefined, { who: 'all', ships: 'all', action: 'seize' });
    const m = spawn(g, U.TradeShip, N, water(g, 36.0, -5.0), water(g, 40.6, -70));
    step(200);
    const st = events.filter((e) => e.type === 'shipStopped' && e.victim === N && e.piracy);
    const op1 = g.diplomacy.opinion(N, HUMAN_ID);
    row('N3b', 'blockade of everyone: a neutral merchant boarded at peace is piracy', `stops ${st.length} (piracy), neutral opinion ${op0} → ${op1}, casus belli ${g.diplomacy.hasCasusBelli(N, HUMAN_ID)}`, 'opinion falls ≥ 10, casus belli', st.length >= 1 && op1 <= op0 - 10 && g.diplomacy.hasCasusBelli(N, HUMAN_ID));
    void m;
  }
}

// -------------------------------------------------------------------------------------------------
if (want('sink')) {
  const W = medWorld(9);
  const { g, step, events, E, H } = W;
  step(400);
  const gt = chokepointTile(cp('gibraltar'));
  const w = spawn(g, U.Warship, HUMAN_ID, water(g, 36.2, -6.6));
  step(1);
  g.unitSys.order(H, [w.id], 'blockade', gt, 0, undefined, undefined, { who: 'war', ships: 'trade', action: 'sink' });
  step(40);
  const m = spawn(g, U.TradeShip, E, water(g, 36.0, -5.2), water(g, 40.6, -70));
  m.cargo = 800;
  const gold0 = g.playerById[HUMAN_ID].gold;
  step(200);
  const ev = events.find((e) => e.type === 'shipStopped' && e.unitId === m.id);
  const paid = events.some((e) => (e.type === 'prizeDelivered' || e.type === 'tradeCompleted') && e.unitId === m.id);
  const lost = g.naval.views()[0]?.nations.find((n) => n.id === E)?.lost ?? 0;
  void gold0;
  row('N5', 'sink: the merchant goes down, nobody gets its cargo', `dead ${m.dead}, action ${ev?.action}, cargo paid to anyone ${paid}, enemy's loss counted ${lost}`, 'sunk, unpaid, loss ≥ 800', m.dead && ev?.action === 'sunk' && !paid && lost >= 800);
}

// -------------------------------------------------------------------------------------------------
if (want('convoy')) {
  for (const action of ['seize', 'sink']) {
    const W = medWorld(11);
    const { g, step, events, E, H } = W;
    step(20);
    const gt = chokepointTile(cp('gibraltar'));
    const ws = [spawn(g, U.Warship, HUMAN_ID, water(g, 36.2, -6.6)), spawn(g, U.Warship, HUMAN_ID, water(g, 36.1, -6.8))];
    step(1);
    g.unitSys.order(H, ws.map((w) => w.id), 'blockade', gt, 0, undefined, undefined, { who: 'war', ships: 'all', action });
    step(40);
    // The enemy invades our Atlantic coast from Naples: its convoy must pass the strait.
    const P = g.playerById[E];
    P.troops = Math.max(P.troops, 200_000);
    const troops0 = P.troops;
    // The landing is inside the zone (Cádiz, 70 km from the strait): there is no way around it.
    g.applyDebug({ type: 'conquer', playerId: HUMAN_ID, centerTile: T(36.4, -6.1), radius: 2 });
    const ok = g.issue(E, { type: 'boatAttack', targetTile: T(36.4, -6.1), ratio: 0.2 });
    const convoy = [...g.unitMap.values()].find((u) => u.type === U.TransportShip && u.owner === E);
    const aboard = convoy?.troops ?? 0;
    let turned = false;
    for (let i = 0; i < 1600 && convoy && !convoy.dead; i++) {
      step(1);
      if (convoy.mode === 4) turned = true;
    }
    const ev = events.filter((e) => e.type === 'shipStopped' && e.victim === E && e.unit === U.TransportShip);
    const bv = g.naval.views()[0];
    if (action === 'seize') {
      row('N6', 'convoy through a boarding blockade: forced back, troops home', `launched ${ok}, ${aboard} aboard, turned back ${turned}, events ${ev.map((e) => e.action).join(',')}, troops denied ${bv?.troopsDenied}, enemy reserve ${Math.round(troops0)} → ${Math.round(P.troops)}`, 'turned back, troops denied ≥ aboard × 0.9', turned && bv?.troopsDenied >= aboard * 0.9);
    } else {
      row('N6b', 'convoy through a sinking blockade: sunk, troops lost', `${aboard} aboard, dead ${convoy?.dead}, events ${ev.map((e) => e.action).join(',')}, troops denied ${bv?.troopsDenied}`, 'sunk', convoy?.dead && ev.some((e) => e.action === 'sunk'));
    }
  }
}

// -------------------------------------------------------------------------------------------------
if (want('escort')) {
  const W = medWorld(13);
  const { g, step, events, E, N, H } = W;
  step(20);
  const gt = chokepointTile(cp('gibraltar'));
  const w = spawn(g, U.Warship, HUMAN_ID, water(g, 36.2, -6.6));
  step(1);
  g.unitSys.order(H, [w.id], 'blockade', gt, 0, undefined, undefined, { who: 'all', ships: 'all', action: 'seize' });
  step(40);
  // A neutral merchant with its escort: at peace the blockade lets it pass.
  const m = spawn(g, U.TradeShip, N, water(g, 36.0, -4.6), water(g, 40.6, -70));
  const esc = spawn(g, U.Warship, N, water(g, 36.0, -4.5));
  step(1);
  g.unitSys.order(g.playerById[N], [esc.id], 'escort', 0, m.id);
  step(150);
  const passed = events.some((e) => e.type === 'shipStopped' && e.unitId === m.id && e.action === 'passed');
  row('N7', 'an escorted neutral merchant: the blockade lets it pass (firing on its escort would be war)', `passed ${passed}, still ${m.owner === N ? 'neutral' : 'taken'}, alive ${!m.dead}`, 'passed, not taken', passed && m.owner === N);
  // At war: the escort is fought first.
  const m2 = spawn(g, U.TradeShip, E, water(g, 36.0, -4.6), water(g, 40.6, -70));
  const esc2 = spawn(g, U.Warship, E, water(g, 36.0, -4.5));
  step(1);
  g.unitSys.order(g.playerById[E], [esc2.id], 'escort', 0, m2.id);
  let fired = 0;
  for (let i = 0; i < 300; i++) {
    step(1);
    if (esc2.hp < esc2.maxHp) fired++;
  }
  row('N7b', 'an escorted enemy merchant: the escort is fought first', `escort integrity ${Math.round((esc2.dead ? 0 : esc2.hp / esc2.maxHp) * 100)} %, merchant ${m2.dead ? 'gone' : m2.owner === HUMAN_ID ? 'taken after the escort' : 'still enemy'}`, 'escort hit', esc2.dead || esc2.hp < esc2.maxHp);
}

// -------------------------------------------------------------------------------------------------
if (want('port')) {
  const W = medWorld(15);
  const { g, step, E, H, ports } = W;
  step(400);
  const w = spawn(g, U.Warship, HUMAN_ID, water(g, 40.6, 14.0));
  step(1);
  g.unitSys.order(H, [w.id], 'blockade', water(g, 40.6, 14.0), 0);
  step(40);
  const blocked = g.unitSys.blockaded(ports.naples);
  const outBefore = merchants(g, E).filter((u) => u.home === ports.naples.id).length;
  const idMark = g.allocId();
  step(600);
  const outAfter = merchants(g, E).filter((u) => u.home === ports.naples.id && u.id > idMark).length;
  const view = g.buildUpdate(1);
  const all = g.buildUpdate(1);
  void all;
  g.structuresDirty = true;
  const sv = g.buildUpdate(1).structures?.find((s) => s.id === ports.naples.id);
  row('N8', 'a blockaded port sends no merchants; its card shows the lost income per hour', `blockaded by ${blocked}, Naples merchants at sea when it began ${outBefore}, new ones since ${outAfter}, card: tradeLoss ${sv?.tradeLoss} gold/h by ${sv?.tradeLossBy}; kind ${g.naval.views()[0]?.kind}`, 'blockaded by us, no new merchant, loss > 0', blocked === HUMAN_ID && outAfter === 0 && (sv?.tradeLoss ?? 0) > 0);
  void view;
}

// -------------------------------------------------------------------------------------------------
if (want('command')) {
  const W = medWorld(17);
  const { g, step, events, N } = W;
  step(5);
  const w = spawn(g, U.Warship, HUMAN_ID, water(g, 36.0, -9.5));
  const m = spawn(g, U.TradeShip, N, water(g, 36.0, -9.6), water(g, 40.6, -70));
  step(1);
  const op0 = g.diplomacy.opinion(N, HUMAN_ID);
  const hail = g.issue(HUMAN_ID, { type: 'navalIntercept', unitId: w.id, targetId: m.id, act: 'hail' });
  step(1);
  const x0 = m.x;
  step(5);
  const hove = Math.abs(m.x - x0) < 1e-6;
  const warn = g.issue(HUMAN_ID, { type: 'navalIntercept', unitId: w.id, targetId: m.id, act: 'warn' });
  step(1);
  const op1 = g.diplomacy.opinion(N, HUMAN_ID);
  const board = g.issue(HUMAN_ID, { type: 'navalIntercept', unitId: w.id, targetId: m.id, act: 'board' });
  step(1);
  row('N9', 'command mode: hail → it heaves to; warning shot at peace costs opinion; board → seized', `hail ${hail} (stopped ${hove}), warn ${warn} (opinion ${op0} → ${op1}), board ${board} → owner ${m.owner === HUMAN_ID ? 'ours' : m.owner}, prize ${m.prize}`, 'all true, opinion lower, ours', hail && hove && warn && op1 < op0 && board && m.owner === HUMAN_ID && m.prize);
  const far = spawn(g, U.TradeShip, N, water(g, 38.0, -12.0), water(g, 40.6, -70));
  step(1);
  const refused = !g.issue(HUMAN_ID, { type: 'navalIntercept', unitId: w.id, targetId: far.id, act: 'board' });
  const msg = events.filter((e) => e.type === 'message' && e.key === 'naval.err.tooFarBoard').length;
  const sink = g.issue(HUMAN_ID, { type: 'navalIntercept', unitId: w.id, targetId: spawn(g, U.TradeShip, N, water(g, 36.1, -9.5), water(g, 40.6, -70)).id, act: 'sink' });
  row('N9b', 'command mode: boarding a ship 250 km away is refused; sink works alongside', `refused ${refused} (${msg} message), sink ${sink}`, 'refused, sunk', refused && msg >= 1 && sink);
}

// -------------------------------------------------------------------------------------------------
if (want('ai')) {
  // The AI blockades the human's lanes when at war, and answers piracy (real AI).
  const q = makeGame(21, true, 24);
  const { g, step, events } = q;
  step(600);
  const H = g.playerById[HUMAN_ID];
  const nations = g.playerArr.filter((p) => p.kind === 'nation' && p.alive && p.id !== HUMAN_ID);
  const byName = (n) => nations.find((p) => p.name === n);
  // Our trade: ports at Barcelona and Valencia; partners across the Atlantic (Canada, Argentina): our merchants sail
  // through Gibraltar.
  portAt(g, HUMAN_ID, 41.35, 2.17, 3);
  portAt(g, HUMAN_ID, 39.45, -0.3, 3);
  for (const [n, la, lo] of [['Canada', 44.6, -63.6], ['Argentina', -34.6, -58.3], ['Mexico', 19.2, -96.1]]) if (byName(n)) portAt(g, byName(n).id, la, lo, 3);
  // Algeria goes to war with us, with a port at Algiers and a small fleet.
  const enemy = byName('Algeria') ?? nations[0];
  const yard = portAt(g, enemy.id, 36.77, 3.06, 2);
  g.war.declare(enemy.id, HUMAN_ID, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  for (let k = 0; k < 3; k++) spawn(g, U.Warship, enemy.id, g.nav.waterNear(yard.tile));
  step(2400);
  const aiBlk = g.naval.views().filter((b) => b.owner !== HUMAN_ID);
  const vsHuman = aiBlk.filter((b) => b.spec.who === 'war' && g.war.atWar(b.owner, HUMAN_ID));
  const hs = g.naval.economyView(HUMAN_ID);
  row('N10', 'the AI at war with us blockades (a port or a strait) and our trade suffers', `${aiBlk.length} AI blockades (${aiBlk.map((b) => `${g.playerById[b.owner].name}:${b.kind}${b.key ? '/' + b.key : ''}${b.active ? ' in force' : ' ended'}, stopped ${b.seized + b.sunk + b.turnedBack}, rerouted ${b.rerouted}`).join('; ')}); our loss ${hs.lostTotal} (${hs.lostPerHour}/h)`, '≥ 1 by our enemy', vsHuman.length >= 1);
  // Peace with Algeria first (the early-war cap lets one AI war on the human before day 75).
  g.applyDebug({ type: 'war', a: enemy.id, b: HUMAN_ID, peace: true });
  // Piracy against an AI: we seize its merchants at peace until it answers.
  const victim = nations.find((p) => p.id !== enemy.id && !g.war.atWar(p.id, HUMAN_ID) && merchants(g, p.id).length > 0);
  if (!victim) row('N10b', 'AI answers to piracy', 'no AI merchant at sea', 'a victim', false);
  else {
    const w = spawn(g, U.Warship, HUMAN_ID, g.nav.waterNear(H.capitalTile) >= 0 ? g.nav.waterNear(T(36.4, -6.5)) : 0);
    let seized = 0;
    const reactions = new Set();
    for (let round = 0; round < 14 && !g.war.atWar(victim.id, HUMAN_ID); round++) {
      const m = merchants(g, victim.id)[0] ?? spawn(g, U.TradeShip, victim.id, g.nav.waterNear(T(36.0, -9.6)), T(40.6, -70));
      w.x = m.x;
      w.y = m.y + 0.3;
      // Board the first ones, then sink them (worse): the answer grows from a protest to war.
      g.naval.commandIntercept(w, m, round < 3 ? 'board' : 'sink');
      seized++;
      step(300);
      if (events.some((e) => e.type === 'tension' && e.from === victim.id && e.to === HUMAN_ID)) reactions.add('protest');
      if (g.playerById[victim.id].embargoes.has(HUMAN_ID)) reactions.add('embargo');
      if ([...g.unitMap.values()].some((u) => u.owner === victim.id && u.type === U.Warship && u.mode === 19)) reactions.add('escort');
      if (g.war.atWar(victim.id, HUMAN_ID)) reactions.add('war');
    }
    row('N10b', 'an AI whose merchants we seize and sink at peace answers', `${g.playerById[victim.id].name}: ${seized} stopped by tick ${g.tick}, opinion ${g.diplomacy.opinion(victim.id, HUMAN_ID)}, answers: ${[...reactions].join(', ') || 'none'}`, 'protest, embargo, escorts, war when angry enough', reactions.has('protest') && reactions.has('embargo') && reactions.has('war'));
  }
}

// -------------------------------------------------------------------------------------------------
if (want('save')) {
  const W = medWorld(19);
  const { g, step, H } = W;
  step(200);
  const w = spawn(g, U.Warship, HUMAN_ID, water(g, 36.2, -6.6));
  step(1);
  g.unitSys.order(H, [w.id], 'blockade', chokepointTile(cp('gibraltar')), 0, undefined, undefined, { who: 'list', nations: [W.E], ships: 'trade', action: 'sink' });
  step(200);
  const before = JSON.stringify(g.naval.views());
  const wr = new SaveWriter();
  g.serialize(wr);
  const g2 = Game.restore(new SaveReader(wr.finish()), world);
  g2.ai = { setup() {}, tick() {}, onEvent() {} };
  const after = JSON.stringify(g2.naval.views());
  for (let i = 0; i < 20; i++) g2.tick1();
  row('N11', 'save / restore keeps the blockade, its spec and its ledger', `equal ${before === after}, spec ${JSON.stringify(g2.naval.views()[0]?.spec)}, active after 20 ticks ${g2.naval.views()[0]?.active}`, 'equal, active', before === after && g2.naval.views()[0]?.active);
}

const fails = results.filter((r) => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} pass`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
process.exit(fails.length ? 1 : 0);
