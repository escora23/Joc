// FRONT ULTRA — headless audit of command mode's simulation side (W5, DESIGN_V2 §9.7, §9.8). Test tooling only.
//
//   npx tsx src/sim/test/command-audit.mjs
//
// Stages a human division next to a foreign border and checks, without a browser:
//   M1  controlledMove within the speed limit is applied at once (between ticks) and the unit really moves;
//   M2  a move beyond maxKmh × elapsed × 1.1 is snapped to the limit (logged), a jump (> 5 km and > 2× the allowed distance) is rejected;
//   M3  travel time checks against the strategic speed (40 km/h), tactical time against the tank's 65 km/h;
//   I1  crossing into a nation at peace emits borderIncursion 'entered' with the warning's grace (30 game s on land,
//       15 near the capital); staying past it brings the interception at once via sub-steps; the ground force
//       arrives 1.5–5 game minutes after dispatch; its last warning (90 s) ignored → the victim opens fire or declares war;
//   I4  turning back within the grace ends it with a protest and no force;
//   I2  with an alliance / open borders no incursion is raised;
//   I3  releasing the unit inside foreign land leaves it exactly there (no walk back) and the incursion goes on;
//   J2  a fighter staying in foreign airspace is intercepted by fighters scrambled from a real airbase in 1–3 min;
//   C1  commandCasualties: N×25 troops leave the victim; a unit hit of 0.25 takes 25 % integrity; a structure hit 0.35;
//   C2  controlledDamage lowers the unit's integrity; 0 destroys it;
//   S1  a warship in open sea raises nothing; in water next to a foreign coast at peace it raises an incursion (ship);
//   J1  a fighter over foreign land at peace raises an incursion (jet, airspace).

import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID, MAP_W, MAP_H, DEFAULT_START_WORLD_TIME, TILE_KM } from '../../shared/constants.ts';
import { latLonToTile } from '../../shared/geo.ts';
import { UnitType, StructureType, UnitState, UNIT_ORDER_KINDS } from '../../shared/types.ts';
import { isWaterTerrain } from '../../shared/terrain.ts';

const world = await loadWorldInit();
let pass = 0, fail = 0;
const ok = (c, m) => {
  if (c) pass++;
  else fail++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
};

function makeGame(seed = 7) {
  const config = {
    seed, playerName: 'Audit', playerColor: 0x2f6fd6, difficulty: 'normal', aiCount: 40, tribeCount: 0, speed: 1,
    nukes: false, worldEvents: false, startWorldTimeSec: DEFAULT_START_WORLD_TIME, spawnTimeoutTicks: 50,
    autoSpawnTile: latLonToTile(42.2, 0.5), instantStart: true, humanAutopilot: false,
  };
  const g = new Game(config, world);
  const events = [];
  const emit = g.emit.bind(g);
  g.emit = (e) => {
    events.push(e);
    emit(e);
  };
  for (let i = 0; i < 400 && g.phase !== 'playing'; i++) g.tick1();
  // A neighbour at peace: the first nation gets the land just east of ours.
  const nation = g.playerArr.find((p) => p.kind === 'nation' && p.alive);
  g.applyDebug({ type: 'conquer', playerId: nation.id, centerTile: latLonToTile(42.0, 3.9), radius: 8 });
  g.applyDebug({ type: 'conquer', playerId: HUMAN_ID, centerTile: latLonToTile(42.0, 0.2), radius: 9 });
  for (let i = 0; i < 3; i++) g.tick1();
  return { g, events };
}

const kmX = (y) => TILE_KM * Math.cos((90 - (y / MAP_H) * 180) * Math.PI / 180);

/** A human land tile with a foreign (nation, at peace) tile straight east or west within 6 tiles. */
function borderSpot(g) {
  for (let t = 0; t < g.owner.length; t++) {
    if (g.owner[t] !== HUMAN_ID) continue;
    const x = t % MAP_W, y = (t / MAP_W) | 0;
    for (const dir of [1, -1]) {
      let ok = true;
      for (let k = 1; k <= 6; k++) {
        const o = g.owner[y * MAP_W + ((x + dir * k + MAP_W) % MAP_W)];
        if (o === HUMAN_ID) continue;
        if (o > 0 && g.playerById[o]?.kind === 'nation' && g.war.pairState(HUMAN_ID, o) === 'peace') {
          return { x: x + 0.5, y: y + 0.5, dir, victim: o, steps: k };
        }
        ok = false;
        break;
      }
      if (!ok) continue;
    }
  }
  return null;
}

function spawnDivision(g, x, y) {
  const tile = Math.floor(y) * MAP_W + Math.floor(x);
  g.applyDebug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: HUMAN_ID, tile, targetTile: -1 });
  let best = null;
  for (const u of g.unitMap.values()) if (u.owner === HUMAN_ID && u.type === UnitType.ArmoredDivision) best = u;
  return best;
}

// ------------------------------------------------------------------------------------------------ M1–M3
{
  const { g, events } = makeGame();
  const spot = borderSpot(g);
  ok(!!spot, `found a peaceful border spot (victim ${spot?.victim}, ${spot?.steps} tiles ${spot?.dir > 0 ? 'east' : 'west'})`);
  const u = spawnDivision(g, spot.x - spot.dir * 0.2, spot.y);
  u.x = spot.x - spot.dir * 0.2;
  u.y = spot.y;
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: true });
  ok(u.state === UnitState.Controlled, 'unitControl puts the division under control');
  const kx = kmX(u.y);
  // M1: 60 game s at 60 km/h tactical = 1 km.
  g.subStep(60);
  const x0 = u.x;
  g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: u.x - spot.dir * (1 / kx), y: u.y, heading: spot.dir > 0 ? 3 * Math.PI / 2 : Math.PI / 2 });
  ok(Math.abs(Math.abs(u.x - x0) * kx - 1) < 0.01, `M1 a legal 1 km move in 60 game s is applied between ticks (moved ${(Math.abs(u.x - x0) * kx).toFixed(3)} km)`);
  // M2: 3 km in 60 game s at 65 km/h × 1.1 = 1.19 km allowed → snapped.
  g.subStep(60);
  const x1 = u.x;
  g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: u.x + spot.dir * (3 / kx), y: u.y, heading: 0 });
  const moved = Math.abs(u.x - x1) * kx;
  ok(Math.abs(moved - 65 * 60 / 3600 * 1.1) < 0.02 && g.command.stats.snapped === 1, `M2 a 3 km move in 60 game s is snapped to ${moved.toFixed(3)} km (65 km/h × 1.1 = 1.192)`);
  const before = u.x;
  g.subStep(60);
  g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: u.x + spot.dir * (6 / kx), y: u.y, heading: 0 });
  ok(u.x === before && g.command.stats.rejected === 1, 'M2 a 6 km jump 60 game s after the last move is rejected (> 5 km and > 2× the allowed 1.19 km)');
  // A legal move resets the clock of the check.
  g.subStep(60);
  g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: u.x - spot.dir * (0.5 / kx), y: u.y, heading: 0 });
  // M3: travel time → 40 km/h: 1 km in 60 s is over 40 × 60/3600 × 1.1 = 0.733 km.
  g.commandTravel = true;
  g.subStep(60);
  const x2 = u.x;
  g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: u.x - spot.dir * (1 / kx), y: u.y, heading: 0 });
  const m3 = Math.abs(u.x - x2) * kx;
  ok(Math.abs(m3 - 40 * 60 / 3600 * 1.1) < 0.02, `M3 in travel time the limit is the strategic 40 km/h (${m3.toFixed(3)} km of 1 km in 60 s)`);
  g.commandTravel = false;
  void events;
}

// ------------------------------------------------------------------------------------------------ I1, I3, C1, C2
{
  const { g, events } = makeGame(11);
  const spot = borderSpot(g);
  const V = g.playerById[spot.victim];
  // Make the victim dislike us a little so it intercepts (opinion < -10), and give it a town near the border.
  g.applyDebug({ type: 'opinion', of: spot.victim, toward: HUMAN_ID, key: 'pastWar', value: -30 });
  const u = spawnDivision(g, spot.x, spot.y);
  u.x = spot.x;
  u.y = spot.y;
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: true });
  const kx = kmX(u.y);
  // Drive east/west 1 km per game minute until the tile is the victim's.
  let entered = null;
  for (let i = 0; i < 400 && !entered; i++) {
    g.subStep(60);
    g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: u.x + spot.dir * (1 / kx), y: u.y, heading: spot.dir > 0 ? Math.PI / 2 : 3 * Math.PI / 2 });
    entered = events.find((e) => e.type === 'borderIncursion' && e.stage === 'entered');
  }
  ok(!!entered && entered.victim === spot.victim, `I1 borderIncursion 'entered' on ${V?.name} (${spot.victim})`);
  const t0 = g.command.sec;
  const grace = entered.graceSec;
  ok(grace === 30 || grace === 15, `I1 the warning gives ${grace} game s to turn back (30 on land, 15 near the capital)`);
  // Stay inside, sub-stepping 1 game s at a time (×1 between ticks), until the answer.
  let resp = null;
  for (let i = 0; i < 200 && !resp; i++) {
    g.subStep(1);
    resp = events.find((e) => e.type === 'borderIncursion' && e.stage === 'response');
  }
  const dt = resp ? resp.sec - entered.sec : -1;
  ok(!!resp && dt >= grace - 0.01 && dt <= grace + 1.01, `I1 the victim answers ${resp?.response} ${dt.toFixed(1)} game s after entry (= the grace, via sub-steps, no tick ran: ${g.command.sec - t0 < 360})`);
  const icpt = events.find((e) => e.type === 'borderIncursion' && e.stage === 'response' && e.response === 'intercept');
  ok(!!icpt && icpt.qrfMode === 'ground', `I1 an interception was dispatched (${icpt?.qrfMode} force, eta ${icpt?.etaSec?.toFixed(0)} s)`);
  const inc = g.command.view(true).incursions.find((i) => i.unitId === u.id);
  const q = inc?.qrf;
  ok(!!q && q.soldiers >= 8 && q.soldiers <= 24 && q.vehicles >= 2, `I1 quick-reaction force of ${q?.vehicles} vehicles with ${q?.soldiers} soldiers from ${q?.source}`);
  // Fix 2 (#20): in command mode the force is in the area on the sim's schedule, but the last warning waits until one
  // of its vehicles is alongside in the scene (the client's escortAlongside).
  let inArea = null;
  for (let i = 0; i < 2000 && !inArea; i++) {
    g.subStep(1);
    inArea = g.command.view(true).incursions.find((x) => x.unitId === u.id && x.qrf?.arrived) ?? null;
  }
  const travel = inArea && q ? inArea.qrf.arriveSec - q.dispatchSec : -1;
  ok(travel >= 90 && travel <= 300, `I1 it arrives ${(travel / 60).toFixed(1)} game min after dispatch (1.5–5)`);
  for (let i = 0; i < 120; i++) g.subStep(1);
  const held = g.command.view(true).incursions.find((x) => x.unitId === u.id);
  ok(!!held && held.awaitingAlongside === true && held.deadlineSec === 0 && held.response === 'intercept' && !events.some((e) => e.type === 'borderIncursion' && e.stage === 'arrived'),
    `I1b no last warning while the escort is not alongside in the scene (120 game s after arrival: awaiting ${held?.awaitingAlongside}, deadline ${held?.deadlineSec})`);
  g.issue(HUMAN_ID, { type: 'escortAlongside', unitId: u.id });
  const arrived = events.find((e) => e.type === 'borderIncursion' && e.stage === 'arrived') ?? null;
  ok(arrived?.deadlineSec === 90 || arrived?.deadlineSec === 30, `I1 on arrival, the last warning: ${arrived?.deadlineSec} s to leave`);
  let fire = null;
  for (let i = 0; i < 200 && !fire; i++) {
    g.subStep(1);
    fire = events.find((e) => e.type === 'borderIncursion' && e.stage === 'response' && (e.response === 'engage' || e.response === 'war'));
  }
  ok(!!fire && Math.abs(fire.sec - arrived.sec - arrived.deadlineSec) <= 1.01, `I1 the warning ignored: ${fire?.response} ${(fire ? fire.sec - arrived.sec : -1).toFixed(1)} s after arrival`);
  // C1: casualties.
  const troops0 = V.troops;
  g.issue(HUMAN_ID, { type: 'commandCasualties', unitId: u.id, victim: spot.victim, troops: 12 * 25, unitHits: [], structureHits: [] });
  ok(Math.abs(troops0 - V.troops - 300) < 1e-6, `C1 killing 12 soldiers removes 300 troops (${(troops0 - V.troops).toFixed(0)})`);
  let vd = null;
  for (const x of g.unitsByOwner.get(spot.victim) ?? []) if (!x.dead && x.type === UnitType.ArmoredDivision) vd = x;
  if (!vd) {
    const t = Math.floor(spot.y) * MAP_W + Math.floor(spot.x + spot.dir * 3);
    g.applyDebug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: spot.victim, tile: t, targetTile: -1 });
    for (const x of g.unitsByOwner.get(spot.victim) ?? []) if (!x.dead && x.type === UnitType.ArmoredDivision) vd = x;
  }
  const hp0 = vd.hp / vd.maxHp;
  g.issue(HUMAN_ID, { type: 'commandCasualties', unitId: u.id, victim: spot.victim, troops: 0, unitHits: [{ unitId: vd.id, dmg: 0.25 }], structureHits: [] });
  ok(Math.abs(hp0 - vd.hp / vd.maxHp - 0.25) < 1e-3, `C1 a tank hit takes 25 % of the division (${(hp0 * 100).toFixed(0)} % → ${(vd.hp / vd.maxHp * 100).toFixed(0)} %)`);
  const st = [...(g.structByOwner.get(spot.victim) ?? [])].find((s) => s.built >= 1);
  if (st) {
    const h0 = st.hp;
    g.issue(HUMAN_ID, { type: 'commandCasualties', unitId: u.id, victim: spot.victim, troops: 0, unitHits: [], structureHits: [{ structureId: st.id, dmg: 0.35 }] });
    ok(Math.abs(h0 - st.hp - 0.35) < 1e-6 || !g.structureMap.has(st.id), `C1 a launcher hit takes 0.35 of the structure's hp (${h0.toFixed(2)} → ${st.hp.toFixed(2)})`);
  }
  // I3: release inside → the unit stays exactly there, holding, and the incursion goes on.
  const rx = u.x, ry = u.y;
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: false });
  for (let i = 0; i < 3; i++) g.tick1();
  const stillIn = g.command.view(true).incursions.find((i) => i.unitId === u.id && !i.left);
  ok(u.state !== UnitState.Controlled && Math.hypot(u.x - rx, u.y - ry) < 1e-6 && (!!stillIn || g.war.atWar(spot.victim, HUMAN_ID)),
    `I3 released inside foreign land: it holds where it was left (moved ${(Math.hypot(u.x - rx, u.y - ry) * TILE_KM).toFixed(3)} km), the incursion goes on (${stillIn ? stillIn.response : 'war'})`);
  // I5 (fix 2): left inside under fire, the force really there wears it down in proportion (two APCs cannot destroy
  // a division in half an hour); within 30 game minutes the incident becomes a war instead.
  const hpR = u.hp / u.maxHp;
  for (let i = 0; i < 6; i++) g.tick1();
  const inc5 = g.command.view(true).incursions.find((i) => i.unitId === u.id);
  ok(!u.dead && hpR - u.hp / u.maxHp <= 0.1 && (g.war.atWar(spot.victim, HUMAN_ID) || inc5?.response === 'engage'),
    `I5 released under fire for 36 game min: ${((hpR - u.hp / u.maxHp) * 100).toFixed(1)} % lost, ${g.war.atWar(spot.victim, HUMAN_ID) ? 'now a war' : inc5?.response}`);
  // C2: controlled damage.
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: true });
  const i0 = u.hp / u.maxHp;
  g.issue(HUMAN_ID, { type: 'controlledDamage', unitId: u.id, integrity: i0 - 0.25 });
  ok(Math.abs(u.hp / u.maxHp - (i0 - 0.25)) < 1e-6, `C2 losing a tank lowers the division to ${(u.hp / u.maxHp * 100).toFixed(0)} %`);
  g.issue(HUMAN_ID, { type: 'controlledDamage', unitId: u.id, integrity: 0 });
  ok(u.dead, 'C2 losing the last tank destroys the division');
}

// ------------------------------------------------------------------------------------------------ I6
// Fix 2 (#18): released inside and then ordered out from the map: the victim holds its clocks and fire while the unit
// drives out; out of its land the incursion ends without war and without damage.
{
  const { g, events } = makeGame(11);
  const spot = borderSpot(g);
  g.applyDebug({ type: 'opinion', of: spot.victim, toward: HUMAN_ID, key: 'pastWar', value: -30 });
  const u = spawnDivision(g, spot.x, spot.y);
  u.x = spot.x;
  u.y = spot.y;
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: true });
  const kx = kmX(u.y);
  let entered = null, lastOwn = null;
  for (let i = 0; i < 400 && !entered; i++) {
    lastOwn = { x: u.x, y: u.y };
    g.subStep(60);
    g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: u.x + spot.dir * (1 / kx), y: u.y, heading: 0 });
    entered = events.find((e) => e.type === 'borderIncursion' && e.stage === 'entered');
  }
  for (let i = 0; i < 40; i++) g.subStep(1);
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: false });
  const hp0 = u.hp;
  const own = Math.floor(lastOwn.y) * MAP_W + Math.floor(lastOwn.x - spot.dir * 2);
  const P = g.playerById[HUMAN_ID];
  const ordered = g.unitSys.order(P, [u.id], 'move', own, 0);
  g.subStep(10);
  const lv = g.command.view(true).incursions.find((i) => i.unitId === u.id);
  let left = false;
  for (let i = 0; i < 40 && !left; i++) {
    g.tick1();
    left = events.some((e) => e.type === 'borderIncursion' && e.stage === 'left' && e.unitId === u.id);
  }
  ok(ordered && !!lv?.leaving && left && !u.dead && u.hp >= hp0 && !g.war.atWar(spot.victim, HUMAN_ID) && g.owner[own] === HUMAN_ID,
    `I6 released inside, then ordered home: leaving=${lv?.leaving}, out=${left}, integrity ${(u.hp / u.maxHp * 100).toFixed(0)} %, war ${g.war.atWar(spot.victim, HUMAN_ID)}`);
}

// ------------------------------------------------------------------------------------------------ I4
{
  const { g, events } = makeGame(17);
  const spot = borderSpot(g);
  const u = spawnDivision(g, spot.x, spot.y);
  u.x = spot.x;
  u.y = spot.y;
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: true });
  const kx = kmX(u.y);
  let entered = null;
  let lastOwn = { x: u.x, y: u.y };
  for (let i = 0; i < 2000 && !entered; i++) {
    lastOwn = { x: u.x, y: u.y };
    g.subStep(6);
    g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: u.x + spot.dir * (0.1 / kx), y: u.y, heading: 0 });
    entered = events.find((e) => e.type === 'borderIncursion' && e.stage === 'entered');
  }
  for (let i = 0; i < 10; i++) g.subStep(1);
  g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: lastOwn.x, y: lastOwn.y, heading: 0 });
  ok(Math.abs(u.x - lastOwn.x) < 1e-9, 'I4 the unit turns back 10 s after the warning');
  for (let i = 0; i < 60; i++) g.subStep(1);
  const kinds = events.filter((e) => e.type === 'borderIncursion').map((e) => e.stage + (e.response ? ':' + e.response : ''));
  ok(!!entered && kinds.includes('response:protest') && kinds.includes('left') && !kinds.includes('response:intercept'), `I4 back within the grace: a protest, no force (${kinds.join(', ')})`);
}

// ------------------------------------------------------------------------------------------------ I2
{
  const { g, events } = makeGame(13);
  const spot = borderSpot(g);
  g.applyDebug({ type: 'treaty', a: HUMAN_ID, b: spot.victim, kind: 'openBorders' });
  const u = spawnDivision(g, spot.x, spot.y);
  u.x = spot.x;
  u.y = spot.y;
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: true });
  const kx = kmX(u.y);
  let inForeign = false;
  for (let i = 0; i < 400 && !inForeign; i++) {
    g.subStep(60);
    g.issue(HUMAN_ID, { type: 'controlledMove', unitId: u.id, x: u.x + spot.dir * (1 / kx), y: u.y, heading: 0 });
    inForeign = g.owner[Math.floor(u.y) * MAP_W + Math.floor(u.x)] === spot.victim;
  }
  for (let i = 0; i < 120; i++) g.subStep(1);
  ok(inForeign && !events.some((e) => e.type === 'borderIncursion'), 'I2 with open borders, entering raises no incursion');
}

// ------------------------------------------------------------------------------------------------ S1, J1
{
  const { g, events } = makeGame(21);
  const nationTiles = (t) => { const o = g.owner[t]; return o > 0 && o !== HUMAN_ID && g.playerById[o]?.kind === 'nation' && g.war.pairState(HUMAN_ID, o) === 'peace' ? o : 0; };
  const landNear = (x, y, r) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy;
      if (yy < 0 || yy >= MAP_H) continue;
      const t = yy * MAP_W + ((x + dx + MAP_W) % MAP_W);
      if (!isWaterTerrain(g.terrain[t]) || g.owner[t] > 0) return true;
    }
    return false;
  };
  // A water tile next to a foreign coast at peace, with open sea (no land within 2 tiles) 3 tiles straight out.
  let spot = null;
  for (let t = 0; t < g.owner.length && !spot; t++) {
    if (!isWaterTerrain(g.terrain[t])) continue;
    const x = t % MAP_W, y = (t / MAP_W) | 0;
    let victim = 0;
    for (let dy = -1; dy <= 1 && !victim; dy++) for (let dx = -1; dx <= 1 && !victim; dx++) victim = nationTiles((y + dy) * MAP_W + ((x + dx + MAP_W) % MAP_W));
    if (!victim) continue;
    for (const dir of [1, -1]) {
      const ox = x + dir * 3;
      const ot = y * MAP_W + ((ox + MAP_W) % MAP_W);
      if (isWaterTerrain(g.terrain[ot]) && !landNear(ox, y, 2) && isWaterTerrain(g.terrain[y * MAP_W + x + dir]) && isWaterTerrain(g.terrain[y * MAP_W + x + 2 * dir])) {
        spot = { x, y, ox, victim, dir };
        break;
      }
    }
  }
  ok(!!spot, `S1 found a foreign coast at peace with open sea 3 tiles out (victim ${spot?.victim})`);
  if (spot) {
    g.applyDebug({ type: 'spawnUnit', unit: UnitType.Warship, owner: HUMAN_ID, tile: spot.y * MAP_W + spot.ox, targetTile: -1 });
    let ship = null;
    for (const u of g.unitMap.values()) if (u.owner === HUMAN_ID && u.type === UnitType.Warship) ship = u;
    ok(!!ship, 'S1 a warship spawned in open sea');
    if (ship) {
      ship.x = spot.ox + 0.5;
      ship.y = spot.y + 0.5;
      g.issue(HUMAN_ID, { type: 'unitControl', unitId: ship.id, controlled: true });
      const kx = kmX(ship.y);
      // Sail around in open sea (1 km steps), then toward the coast until the water next to it.
      const n0 = events.filter((e) => e.type === 'borderIncursion').length;
      for (let i = 0; i < 5; i++) {
        g.subStep(60);
        g.issue(HUMAN_ID, { type: 'controlledMove', unitId: ship.id, x: ship.x, y: ship.y + (i % 2 ? 1 : -1) / TILE_KM, heading: 0 });
      }
      ok(events.filter((e) => e.type === 'borderIncursion').length === n0, 'S1 sailing in open sea raises no incursion');
      let entered = null;
      for (let i = 0; i < 200 && !entered; i++) {
        g.subStep(60);
        g.issue(HUMAN_ID, { type: 'controlledMove', unitId: ship.id, x: ship.x - spot.dir * (1 / kx), y: spot.y + 0.5, heading: 0 });
        entered = events.find((e) => e.type === 'borderIncursion' && e.stage === 'entered' && e.unitId === ship.id) ?? null;
        if (Math.floor(ship.x) === spot.x) break;
      }
      entered ??= events.find((e) => e.type === 'borderIncursion' && e.stage === 'entered' && e.unitId === ship.id) ?? null;
      ok(!!entered && entered.kind === 'ship' && entered.victim === spot.victim, `S1 water next to ${spot.victim}'s coast at peace raises an incursion (${entered ? entered.kind + ' → ' + entered.victim : 'none'})`);
      // S2: staying in its waters: a ship (or a patrol boat from a port) comes to shadow it, or a protest with a deadline.
      let r = null;
      for (let i = 0; i < 80 && !r; i++) {
        g.subStep(1);
        r = events.find((e) => e.type === 'borderIncursion' && e.stage === 'response' && e.unitId === ship.id) ?? null;
      }
      const inc = g.command.view(true).incursions.find((i) => i.unitId === ship.id);
      const tt = inc?.qrf ? inc.qrf.arriveSec - inc.qrf.dispatchSec : -1;
      ok(!!r && r.sec - entered.sec <= 41 && ((r.response === 'intercept' && r.qrfMode === 'sea' && tt >= 120 && tt <= 420) || (r.response === 'protest' && (r.deadlineSec ?? 0) > 0)),
        `S2 after the 40 s grace at sea: ${r?.response} (${inc?.qrf ? `${inc.qrf.source}, ${(tt / 60).toFixed(1)} min` : 'nothing in reach'})`);
    }
  }
  // J1: a fighter squadron from own land into the neighbour's airspace.
  const b = borderSpot(g);
  if (b) {
    g.applyDebug({ type: 'spawnUnit', unit: UnitType.FighterSquadron, owner: HUMAN_ID, tile: Math.floor(b.y) * MAP_W + Math.floor(b.x), targetTile: -1 });
    let jet = null;
    for (const u of g.unitMap.values()) if (u.owner === HUMAN_ID && u.type === UnitType.FighterSquadron) jet = u;
    if (jet) {
      jet.x = b.x;
      jet.y = b.y;
      g.issue(HUMAN_ID, { type: 'unitControl', unitId: jet.id, controlled: true });
      const kx = kmX(jet.y);
      let entered = null;
      for (let i = 0; i < 40 && !entered; i++) {
        g.subStep(30);
        g.issue(HUMAN_ID, { type: 'controlledMove', unitId: jet.id, x: jet.x + b.dir * (10 / kx), y: jet.y, heading: 0, alt: 0.8 });
        entered = events.find((e) => e.type === 'borderIncursion' && e.stage === 'entered' && e.unitId === jet.id) ?? null;
      }
      ok(!!entered && entered.kind === 'jet' && entered.victim === b.victim, `J1 a fighter over ${b.victim}'s land at peace raises an airspace incursion (${entered ? entered.kind : 'none'})`);
      // J2: stay: fighters come from a real airbase of the victim (give it one with a ready squadron if it has none).
      const V = g.playerById[b.victim];
      let hasFighter = [...(g.unitsByOwner.get(b.victim) ?? [])].some((x) => !x.dead && x.type === UnitType.FighterSquadron);
      if (!hasFighter) {
        let t = -1;
        for (let k = 0; k < g.owner.length && t < 0; k++) if (g.owner[k] === b.victim && !isWaterTerrain(g.terrain[k]) && Math.hypot((k % MAP_W) - jet.x, ((k / MAP_W) | 0) - jet.y) < 12) t = k;
        g.applyDebug({ type: 'spawnStructure', owner: b.victim, structure: StructureType.Airbase, tile: t, level: 1 });
        g.applyDebug({ type: 'spawnUnit', unit: UnitType.FighterSquadron, owner: b.victim, tile: t, targetTile: -1 });
        hasFighter = [...(g.unitsByOwner.get(b.victim) ?? [])].some((x) => !x.dead && x.type === UnitType.FighterSquadron);
      }
      let resp = null, arr = null;
      for (let i = 0; i < 400 && !arr; i++) {
        g.subStep(1);
        resp ??= events.find((e) => e.type === 'borderIncursion' && e.stage === 'response' && e.unitId === jet.id) ?? null;
        // On the wing in the scene: the client reports it alongside.
        if (g.command.view(true).incursions.some((x) => x.unitId === jet.id && x.awaitingAlongside)) g.issue(HUMAN_ID, { type: 'escortAlongside', unitId: jet.id });
        arr = events.find((e) => e.type === 'borderIncursion' && e.stage === 'arrived' && e.unitId === jet.id) ?? null;
      }
      const inc = g.command.view(true).incursions.find((i) => i.unitId === jet.id);
      const tt = inc?.qrf ? inc.qrf.arriveSec - inc.qrf.dispatchSec : -1;
      ok(hasFighter && resp?.response === 'intercept' && resp.qrfMode === 'air' && !!inc?.qrf?.unitId && tt >= 60 && tt <= 180 && !!arr,
        `J2 fighters (${V?.name}, unit ${inc?.qrf?.unitId}, from ${inc?.qrf?.source}) intercept ${(entered ? resp?.sec - entered.sec : -1).toFixed(0)} s after entry and arrive in ${(tt / 60).toFixed(1)} min (1–3)`);
    } else ok(false, 'J1 fighter spawned');
  }
}

// J3 (owner feedback #18): a fighter released over its own land holds over the spot on a 12 km orbit with its fuel
// shown (UnitView eta = ticks left), then flies home to refuel when the endurance runs out.
{
  const { g } = makeGame(11);
  const t0 = latLonToTile(42.0, 0.2);
  g.applyDebug({ type: 'spawnStructure', owner: HUMAN_ID, structure: StructureType.Airbase, tile: latLonToTile(41.7, -0.6), level: 1 });
  g.applyDebug({ type: 'spawnUnit', unit: UnitType.FighterSquadron, owner: HUMAN_ID, tile: t0, targetTile: t0 });
  let jet = null;
  for (const u of g.unitMap.values()) if (u.owner === HUMAN_ID && u.type === UnitType.FighterSquadron) jet = u;
  if (jet) {
    g.issue(HUMAN_ID, { type: 'unitControl', unitId: jet.id, controlled: true });
    g.subStep(10);
    const rx = jet.x, ry = jet.y, kx = kmX(ry);
    g.issue(HUMAN_ID, { type: 'unitControl', unitId: jet.id, controlled: false });
    const eta0 = jet.eta;
    let maxKm = 0;
    for (let i = 0; i < 20; i++) {
      g.tick1();
      maxKm = Math.max(maxKm, Math.hypot((jet.x - rx) * kx, (jet.y - ry) * TILE_KM));
    }
    ok(jet.order === UNIT_ORDER_KINDS.indexOf('hold') && maxKm <= 15 && jet.alt > 0,
      `J3 a released fighter holds over the spot: ${maxKm.toFixed(1)} km at most from it in 20 ticks (orbit 12 km), order ${UNIT_ORDER_KINDS[jet.order]}`);
    ok(eta0 === 120 && jet.eta === 100, `J3 its endurance is published and runs down (eta ${eta0} → ${jet.eta} ticks)`);
    for (let i = 0; i < 102; i++) g.tick1();
    ok(!jet.dead && jet.holdUntil === 0 && (jet.state === UnitState.Returning || jet.state === UnitState.Docked), `J3 at the end of its 12 game h it flies home to refuel (state ${jet.state})`);
  } else ok(false, 'J3 fighter spawned');
}

console.log(`\ncommand-audit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
