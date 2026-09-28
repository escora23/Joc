// FRONT ULTRA — headless audit of command mode's simulation side (W5, DESIGN_V2 §9.7, §9.8). Test tooling only.
//
//   npx tsx src/sim/test/command-audit.mjs
//
// Stages a human division next to a foreign border and checks, without a browser:
//   M1  controlledMove within the speed limit is applied at once (between ticks) and the unit really moves;
//   M2  a move beyond maxKmh × elapsed × 1.1 is snapped to the limit (logged), a jump (> 5 km and > 2× the allowed distance) is rejected;
//   M3  travel time checks against the strategic speed (40 km/h), tactical time against the tank's 65 km/h;
//   I1  crossing into a nation at peace emits borderIncursion 'entered'; the victim decides 30–90 game s later via
//       sub-steps; an interception's quick-reaction force arrives 5–15 game minutes after dispatch;
//   I2  with an alliance / open borders no incursion is raised;
//   I3  releasing the unit inside foreign land walks it back home and ends the incursion ('left');
//   C1  commandCasualties: N×25 troops leave the victim; a unit hit of 0.25 takes 25 % integrity; a structure hit 0.35;
//   C2  controlledDamage lowers the unit's integrity; 0 destroys it;
//   S1  a warship in open sea raises nothing; in water next to a foreign coast at peace it raises an incursion (ship);
//   J1  a fighter over foreign land at peace raises an incursion (jet, airspace).

import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID, MAP_W, MAP_H, DEFAULT_START_WORLD_TIME, TILE_KM } from '../../shared/constants.ts';
import { latLonToTile } from '../../shared/geo.ts';
import { UnitType, StructureType, UnitState } from '../../shared/types.ts';
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
  // Stay inside, sub-stepping 1 game s at a time (×1 between ticks), until the decision.
  let resp = null;
  for (let i = 0; i < 200 && !resp; i++) {
    g.subStep(1);
    resp = events.find((e) => e.type === 'borderIncursion' && e.stage === 'response');
  }
  const dt = resp ? resp.sec - entered.sec : -1;
  ok(!!resp && dt >= 30 && dt <= 90, `I1 the victim decides ${resp?.response} ${dt.toFixed(1)} game s after entry (30–90, via sub-steps, no tick ran: ${g.command.sec - t0 < 360})`);
  if (resp && resp.response === 'protest') {
    // Ignore the protest: after 6 game hours it escalates to an interception.
    for (let i = 0; i < 7 * 60; i++) g.subStep(60);
  }
  const icpt = events.find((e) => e.type === 'borderIncursion' && e.stage === 'response' && e.response === 'intercept');
  ok(!!icpt, `I1 an interception was dispatched (${icpt?.escalated ? 'after the ignored protest' : 'directly'})`);
  const inc = g.command.view(true).incursions.find((i) => i.unitId === u.id);
  const q = inc?.qrf;
  ok(!!q && q.soldiers >= 8 && q.soldiers <= 24, `I1 quick-reaction force of ${q?.soldiers} soldiers from ${q?.source}`);
  let arrived = null;
  for (let i = 0; i < 2000 && !arrived; i++) {
    g.subStep(1);
    arrived = events.find((e) => e.type === 'borderIncursion' && e.stage === 'arrived');
  }
  const travel = arrived && q ? arrived.sec - q.dispatchSec : -1;
  ok(travel >= 300 && travel <= 900, `I1 it arrives ${(travel / 60).toFixed(1)} game min after dispatch (5–15)`);
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
  // I3: release inside → walks back and the incursion ends.
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: false });
  ok(u.state === UnitState.Controlled && g.command.keepsControl(u.id), 'I3 released inside foreign land: the division walks back home first');
  let left = null;
  for (let i = 0; i < 400 && !left; i++) {
    g.tick1();
    left = events.find((e) => e.type === 'borderIncursion' && e.stage === 'left');
  }
  ok(!!left && g.owner[Math.floor(u.y) * MAP_W + Math.floor(u.x)] === HUMAN_ID && u.state !== UnitState.Controlled, 'I3 it is back on own land, released, and the incursion ended');
  // C2: controlled damage.
  g.issue(HUMAN_ID, { type: 'unitControl', unitId: u.id, controlled: true });
  const i0 = u.hp / u.maxHp;
  g.issue(HUMAN_ID, { type: 'controlledDamage', unitId: u.id, integrity: i0 - 0.25 });
  ok(Math.abs(u.hp / u.maxHp - (i0 - 0.25)) < 1e-6, `C2 losing a tank lowers the division to ${(u.hp / u.maxHp * 100).toFixed(0)} %`);
  g.issue(HUMAN_ID, { type: 'controlledDamage', unitId: u.id, integrity: 0 });
  ok(u.dead, 'C2 losing the last tank destroys the division');
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
    } else ok(false, 'J1 fighter spawned');
  }
}

console.log(`\ncommand-audit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
