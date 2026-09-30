// FRONT ULTRA — owner feedback #3 audit (FEEDBACK-1 items 27-29, strategic side). Test tooling only, never bundled.
//
//   npx tsx src/sim/test/f3-audit.mjs [--only damage|missions|ai|aar] [--json out.json]
//
// DAMAGE (#27)
//   D1  damage states and reduced function: a level-4 city and a level-3 factory hit by bombs: state, level, the
//       owner's gold per hour and troop cap before / after (the function is 1 / 0.6 / 0.25).
//   D2  level loss and rubble: hp through 0 costs one level (stands at 0.30); at level 1 it is destroyed and leaves a
//       ruin; rebuilding the same type on it costs half.
//   D3  paid repair: gold charged, +8 %/h, paused 2 h after a new hit; no free self-repair.
//   D4  city hits kill civilians and troops; the victim, its ally and a third nation think worse of the striker; the
//       victim and its ally hold a casus belli; escalation rises to L2.
//   D5  capture changes owner (at most 0.60 hp), a defence post included; a razed structure is destroyed instead.
//   D6  command-mode hook: commandStructureHit within 30 km is applied (the same rule), 100 km away refused; at peace it
//       is an act of war (the victim declares).
//   D7  the human's strike order on a city needs confirmation (order.err.civilian) and names the consequences.
//   D8  the real AI repairs its damaged structures by itself.

import fs from 'node:fs';
import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID, MAP_W } from '../../shared/constants.ts';
import { latLonToTile, latLonToTileXY } from '../../shared/geo.ts';
import { offensiveOutlook, orderCheck } from '../../shared/orders.ts';
import { damageState, repairCost } from '../../shared/damage.ts';
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

export function quiet(n, realAi, seed = 7) {
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
  return { g, events, step, H };
}
const struct = (g, type, owner, tile, level = 1) => {
  g.applyDebug({ type: 'spawnStructure', structure: type, owner, tile, level });
  return g.structureMap.get(g.structAt[tile]);
};
const spawn = (g, type, owner, tile, target = -1) => {
  const before = new Set(g.unitMap.keys());
  g.applyDebug({ type: 'spawnUnit', unit: type, owner, tile, targetTile: target });
  return [...g.unitMap.values()].find((u) => !before.has(u.id) && u.type === type);
};

/** Two nations side by side on the plains (human west, enemy east) plus a third nation and an ally of the enemy. */
export function twoNations(seed = 5, realAi = false) {
  const q = quiet(0, realAi, seed);
  const { g, step } = q;
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
  const A = g.addPlayer({ name: 'Aliado', kind: 'nation', personality: 'balanced', color: 0x33cc33, countryIndex: 0 });
  const N = g.addPlayer({ name: 'Neutral', kind: 'nation', personality: 'balanced', color: 0x3333cc, countryIndex: 0 });
  g.transferContext = 'staging';
  for (let t = 0; t < g.owner.length; t++) {
    if (!g.playable[t]) continue;
    if (inRect(t, cx - 30, cx - 1, cy - 20, cy + 20)) g.setOwner(t, HUMAN_ID);
    else if (inRect(t, cx, cx + 29, cy - 20, cy + 20)) g.setOwner(t, E);
    else if (inRect(t, cx + 30, cx + 50, cy - 20, cy + 20)) g.setOwner(t, A);
    else if (inRect(t, cx - 20, cx + 20, cy + 21, cy + 35)) g.setOwner(t, N);
  }
  g.transferContext = 'none';
  for (const id of [HUMAN_ID, E, A, N]) {
    const P = g.playerById[id];
    P.spawned = true;
    P.metaDirty = true;
  }
  g.playerById[HUMAN_ID].capitalTile = cy * W + cx - 18;
  g.playerById[E].capitalTile = cy * W + cx + 18;
  g.playerById[A].capitalTile = cy * W + cx + 40;
  g.playerById[N].capitalTile = (cy + 28) * W + cx;
  step();
  g.applyDebug({ type: 'treaty', a: E, b: A, kind: 'alliance' });
  step(2);
  return { ...q, E, A, N, cx, cy, at: (dx, dy) => (cy + dy) * W + cx + dx };
}

const hourGold = (g, pid) => g.economy.yieldOf(g.playerById[pid], false).income * 10;

// -------------------------------------------------------------------------------------------------------------
function damage() {
  // D1 / D2: function and level loss.
  {
    const { g, step, E, at } = twoNations(5);
    const city = struct(g, S.City, E, at(10, 0), 4);
    const fac = struct(g, S.Factory, E, at(10, 6), 3);
    step(2);
    const P = g.playerById[E];
    const gold0 = hourGold(g, E), cap0 = g.economy.yieldOf(P, false).maxTroops;
    g.economy.damage(city, 0.35, HUMAN_ID, 'bomber'); // 0.65 -> damaged
    step(1);
    const gold1 = hourGold(g, E), cap1 = g.economy.yieldOf(P, false).maxTroops;
    row('D1', 'city L4 hit 0.35 hp: state, gold/h, troop cap', `state ${damageState(city.hp)} (hp ${city.hp.toFixed(2)}), gold ${gold0.toFixed(0)} → ${gold1.toFixed(0)} /h, cap ${Math.round(cap0)} → ${Math.round(cap1)}`,
      'damaged (1), gold and cap fall by the city\'s 40 %', damageState(city.hp) === 1 && gold1 < gold0 && cap1 < cap0);
    g.economy.damage(city, 0.35, HUMAN_ID, 'bomber'); // 0.30 -> heavy
    step(1);
    const gold2 = hourGold(g, E);
    row('D1', 'city L4 heavily damaged: gold/h', `state ${damageState(city.hp)}, ${gold2.toFixed(0)} /h`, 'heavy (2), lower again', damageState(city.hp) === 2 && gold2 < gold1);
    const lv0 = fac.level;
    g.economy.damage(fac, 1.1, HUMAN_ID, 'bomber');
    row('D2', 'factory L3 direct bomber hit (1.1 hp)', `level ${lv0} → ${fac.level}, hp ${fac.hp.toFixed(2)}, exists ${g.structureMap.has(fac.id)}`, 'level 2 at 0.30, not destroyed', fac.level === 2 && Math.abs(fac.hp - 0.3) < 1e-6 && g.structureMap.has(fac.id));
    const sam = struct(g, S.SamSite, E, at(14, -6), 1);
    step(1);
    g.economy.damage(sam, 1.1, HUMAN_ID, 'bomber');
    step(1);
    const ruin = g.ruins.get(sam.tile);
    row('D2', 'SAM L1 direct hit: destroyed, rubble left', `exists ${g.structureMap.has(sam.id)}, ruin ${ruin ? `${ruin.type}/${ruin.cause}` : 'none'}`, 'gone, ruin of type SAM', !g.structureMap.has(sam.id) && ruin && ruin.type === S.SamSite);
    const normal = g.structureCost(E, S.SamSite), onRuin = g.economy.buildCost(E, S.SamSite, sam.tile);
    row('D2', 'rebuilding the SAM on its rubble', `${onRuin} vs ${normal}`, 'half price', onRuin === Math.round(normal * 0.5));
    g.ruinsDirty = true;
    const pub = g.buildUpdate(1).ruins ?? [];
    row('D2', 'rubble published to the client (TickUpdate.ruins)', `${pub.length} ruin(s)`, '>= 1', pub.length >= 1);
  }
  // D3: repair.
  {
    const { g, step, E, at } = twoNations(5);
    const fac = struct(g, S.Factory, E, at(10, 6), 2);
    step(2);
    g.economy.damage(fac, 0.6, HUMAN_ID, 'bomber');
    step(40);
    row('D3', 'no free self-repair (4 h after the hit)', `hp ${fac.hp.toFixed(2)}`, '0.40 still', Math.abs(fac.hp - 0.4) < 1e-6);
    const P = g.playerById[E];
    P.gold = 10_000_000;
    const cost = repairCost(fac.type, fac.level, fac.hp);
    const g0 = P.gold;
    g.issue(E, { type: 'repairStructure', structureId: fac.id });
    step(1);
    const paid = Math.round(g0 - P.gold);
    step(29);
    const hp3h = fac.hp;
    g.economy.damage(fac, 0.05, HUMAN_ID, 'naval');
    const hpHit = fac.hp;
    step(15);
    const paused = fac.hp;
    step(200);
    row('D3', 'repair paid up front', `${paid} (repairCost ${cost}; one tick of income runs meanwhile)`, '= repairCost', Math.abs(paid - cost) < cost * 0.01 && cost > 0);
    row('D3', 'repair +8 %/h', `hp 0.40 → ${hp3h.toFixed(3)} in 3 h`, '≈ 0.64', Math.abs(hp3h - 0.64) < 0.03);
    row('D3', 'repair paused after a new hit (2 h)', `${hpHit.toFixed(3)} → ${paused.toFixed(3)} 1.5 h later`, 'unchanged', Math.abs(paused - hpHit) < 1e-9);
    row('D3', 'repair completes', `hp ${fac.hp.toFixed(2)}, repairing ${fac.repairing}`, '1.00, done', fac.hp >= 0.999 && !fac.repairing);
  }
  // D4: city losses and diplomacy.
  {
    const { g, step, E, A, N, at, events } = twoNations(5);
    g.war.declare(HUMAN_ID, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
    g.war.raiseEscalation(HUMAN_ID, E, 1, 'escalation.reason.debug');
    const city = struct(g, S.City, E, at(10, 0), 5);
    step(2);
    const P = g.playerById[E];
    P.troops = 800_000;
    const pop0 = P.pop, tr0 = P.troops;
    const opV = g.diplomacy.opinion(E, HUMAN_ID), opA = g.diplomacy.opinion(A, HUMAN_ID), opN = g.diplomacy.opinion(N, HUMAN_ID);
    g.economy.damage(city, 0.55, HUMAN_ID, 'bomber');
    step(1);
    const ev = events.filter((e) => e.type === 'structureDamaged').pop();
    row('D4', 'city L5 hit 0.55 hp: civilians and troops killed', `civilians ${Math.round(pop0 - P.pop)} (event ${ev?.civilians}), troops ${Math.round(tr0 - P.troops)} (event ${ev?.troops})`, 'civilians ≈ 16,500 (6,000 × level × hp), troops > 0', ev && ev.civilians > 10_000 && ev.troops > 0);
    const dV = g.diplomacy.opinion(E, HUMAN_ID) - opV, dA = g.diplomacy.opinion(A, HUMAN_ID) - opA, dN = g.diplomacy.opinion(N, HUMAN_ID) - opN;
    row('D4', 'opinion of the striker: victim / victim\'s ally / third nation', `${dV} / ${dA} / ${dN}`, '≈ −20 / −12 / −5', dV <= -15 && dA <= -8 && dN <= -3 && dN > dA);
    row('D4', 'casus belli: victim and its ally against the striker, not the third', `${g.diplomacy.hasCasusBelli(E, HUMAN_ID)} / ${g.diplomacy.hasCasusBelli(A, HUMAN_ID)} / ${g.diplomacy.hasCasusBelli(N, HUMAN_ID)}`, 'true / true / false',
      g.diplomacy.hasCasusBelli(E, HUMAN_ID) && g.diplomacy.hasCasusBelli(A, HUMAN_ID) && !g.diplomacy.hasCasusBelli(N, HUMAN_ID));
    row('D4', 'escalation after striking a city', `L${g.war.escalation(HUMAN_ID, E)}`, 'L2', g.war.escalation(HUMAN_ID, E) >= 2);
  }
  // D5: capture and raze.
  {
    const { g, step, E, at } = twoNations(5);
    const post = struct(g, S.DefensePost, E, at(3, 0), 2);
    const fac = struct(g, S.Factory, E, at(3, 5), 1);
    step(2);
    g.transferContext = 'staging';
    g.setOwner(post.tile, HUMAN_ID);
    g.transferContext = 'none';
    step(1);
    row('D5', 'captured defence post changes owner', `owner ${post.owner}, hp ${post.hp.toFixed(2)}, exists ${g.structureMap.has(post.id)}`, 'human, ≤ 0.60', g.structureMap.has(post.id) && post.owner === HUMAN_ID && post.hp <= 0.6 + 1e-9);
    fac.razeBy.push(HUMAN_ID);
    g.transferContext = 'staging';
    g.setOwner(fac.tile, HUMAN_ID);
    g.transferContext = 'none';
    step(1);
    const ruin = g.ruins.get(fac.tile);
    row('D5', 'razed factory: destroyed, rubble (cause raze)', `exists ${g.structureMap.has(fac.id)}, ruin ${ruin?.cause}`, 'gone, raze', !g.structureMap.has(fac.id) && ruin?.cause === 'raze');
  }
  // D6: command-mode hook.
  {
    const { g, step, H, E, N, at } = twoNations(5);
    g.war.declare(HUMAN_ID, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
    const city = struct(g, S.City, E, at(2, 0), 3);
    const far = struct(g, S.Factory, E, at(12, 0), 1);
    const neutral = struct(g, S.Factory, N, at(-1, 21), 1);
    step(2);
    const tank = spawn(g, U.ArmoredDivision, HUMAN_ID, at(-1, 0));
    step(1);
    tank.x = city.x - 0.8;
    tank.y = city.y;
    const hp0 = city.hp;
    const ok = g.issue(HUMAN_ID, { type: 'commandStructureHit', unitId: tank.id, structureId: city.id, dmg: 0.2, block: 3 });
    const pub = g.buildUpdate(1).structures?.find((s) => s.id === city.id);
    row('D6', 'command-mode shell on a city ~15 km away', `accepted ${ok}, hp ${hp0.toFixed(2)} → ${city.hp.toFixed(2)}, block mask ${pub?.blocks}`, 'accepted, −0.20, block 3 published', ok && Math.abs(hp0 - city.hp - 0.2) < 1e-6 && pub?.blocks === 8);
    const okFar = g.issue(HUMAN_ID, { type: 'commandStructureHit', unitId: tank.id, structureId: far.id, dmg: 0.2 });
    row('D6', 'a structure 300 km away', `accepted ${okFar}`, 'refused', !okFar);
    tank.x = neutral.x - 0.4;
    tank.y = neutral.y;
    const okN = g.issue(HUMAN_ID, { type: 'commandStructureHit', unitId: tank.id, structureId: neutral.id, dmg: 0.2 });
    row('D6', 'hitting a nation at peace is an act of war', `accepted ${okN}, at war ${g.war.atWar(N, HUMAN_ID)}`, 'accepted, war declared by the victim', okN && g.war.atWar(N, HUMAN_ID));
  }
  // D7: confirmation for civilian targets.
  {
    const { g, step, H, E, at } = twoNations(5);
    g.war.declare(HUMAN_ID, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
    g.war.raiseEscalation(HUMAN_ID, E, 2, 'escalation.reason.debug');
    const ab = struct(g, S.Airbase, HUMAN_ID, at(-8, 0), 2);
    const city = struct(g, S.City, E, at(10, 0), 3);
    step(2);
    const b = spawn(g, U.Bomber, HUMAN_ID, ab.tile);
    step(1);
    const e1 = orderCheck(g.rules, b.id, 'strike', city.tile, city.id, {});
    const e2 = orderCheck(g.rules, b.id, 'strike', city.tile, city.id, { confirm: true });
    const e3 = orderCheck(g.rules, b.id, 'strike', city.tile, city.id, { ai: true });
    row('D7', 'bomber on a city at L2: needs the civilian confirmation', `${e1?.key}/${e1?.confirm}; confirmed ${e2?.key ?? 'ok'}; AI ${e3?.key ?? 'ok'}`, 'order.err.civilian/true; ok; ok', e1?.key === 'order.err.civilian' && e1.confirm && !e2 && !e3);
    void H;
  }
}

// -------------------------------------------------------------------------------------------------------------
function aiRepairs() {
  const { g, step } = quiet(8, true, 9);
  step(300);
  const nations = g.playerArr.filter((p) => p.id !== HUMAN_ID && p.kind === 'nation' && p.alive);
  const hit = [];
  for (const P of nations) {
    const list = (g.structByOwner.get(P.id) ?? []).filter((s) => s.built >= 1);
    if (!list.length) continue;
    P.gold = Math.max(P.gold, 3_000_000);
    g.economy.damage(list[0], 0.5, 0, 'strike');
    hit.push(list[0]);
  }
  let t = 0;
  const repaired = () => hit.filter((s) => s.repairing || s.hp > 0.5 + 1e-6).length;
  while (t < 600 && repaired() < hit.length) {
    step(10);
    t += 10;
  }
  row('D8', 'the real AI repairs its damaged structures', `${repaired()} of ${hit.length} nations repairing or repaired after ${t} ticks`, 'most within 60 h', hit.length > 0 && repaired() >= Math.ceil(hit.length * 0.6));
}

// -------------------------------------------------------------------------------------------------------------
// MISSIONS (#28)
// -------------------------------------------------------------------------------------------------------------
/** A human offensive east on the plains; `setup(ctx, phase)` adds units before / during. Returns measured figures. */
function offensiveRun(seed, setup, ticks = 300) {
  const w = twoNations(seed);
  const { g, step, H, E, at } = w;
  g.war.declare(HUMAN_ID, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  g.war.raiseEscalation(HUMAN_ID, E, 1, 'escalation.reason.debug');
  step(20);
  const ctx = { ...w, a: null };
  setup(ctx, 'before');
  H.troops = 1_000_000;
  g.playerById[E].troops = 700_000;
  g.issue(HUMAN_ID, { type: 'attack', target: E, ratio: 0.5, tile: at(8, 0) });
  const a = g.attackList.find((x) => !x.ended && x.attacker === HUMAN_ID);
  ctx.a = a;
  const t0 = g.tick;
  let kmh = 0, n = 0;
  for (let i = 0; i < ticks; i++) {
    setup(ctx, 'tick', i);
    step();
    if (a && g.tick - t0 > 180 && a.state === 'advancing') {
      kmh += a.advanceKmh;
      n++;
    }
  }
  return { kmh: n ? kmh / n : 0, taken: a?.tilesTaken ?? 0, a, g, ctx };
}

function missions() {
  // M1: join offensive X — its strength adds to the offensive, the preview predicts the new km/h.
  {
    let joinView = null;
    const base = offensiveRun(5, () => {});
    const joined = offensiveRun(5, (c, phase, i) => {
      if (phase !== 'tick' || i !== 150) return;
      joinView = c.g.attacks.view(c.a);
      for (let k = 0; k < 2; k++) {
        const d = spawn(c.g, U.ArmoredDivision, HUMAN_ID, c.at(-2, k * 2 - 1));
        c.g.unitSys.order(c.H, [d.id], 'join', -1, c.a.id);
      }
    });
    const pv = joinView ? offensiveOutlook(joinView, { divisions: 2 }) : null;
    const v = joined.a ? joined.g.attacks.view(joined.a) : null;
    row('M1', 'offensive without support (reference)', `${base.kmh.toFixed(2)} km/h, ${base.taken} tiles`, 'reference', base.taken > 0);
    row('M1', '2 divisions join the offensive', `${joined.kmh.toFixed(2)} km/h, ${joined.taken} tiles, divAtk ${v?.divAtk}`, 'faster, divAtk 2', joined.kmh > base.kmh * 1.1 && v?.divAtk === 2);
    row('M1', 'the preview before joining (offensiveOutlook)', pv ? `${joinView.advanceKmh.toFixed(2)} → ≈ ${pv.kmh.toFixed(2)} km/h (ratio ${joinView.ratio.toFixed(2)} → ${pv.ratio.toFixed(2)})` : 'none',
      'within 25 % of the measured', pv && joinView.advanceKmh > 0 && Math.abs(pv.kmh - joined.kmh) / joined.kmh < 0.25);
    const divs = [...joined.g.unitMap.values()].filter((u) => u.type === U.ArmoredDivision && u.owner === HUMAN_ID);
    const cx = joined.a.liveX, cy = joined.a.liveY;
    const dmax = Math.max(...divs.map((u) => Math.hypot(u.x - cx, u.y - cy)));
    row('M1', 'the joined divisions follow the spearhead', `farthest ${dmax.toFixed(1)} tiles from the live contact after ${joined.taken} tiles taken`, '≤ 4 tiles', dmax <= 4);
  }
  // M2: defend a sector — an enemy offensive into it is slower with two divisions defending there.
  {
    const enemyRun = (defend) => {
      const w = twoNations(6);
      const { g, step, H, E, at } = w;
      g.war.declare(E, HUMAN_ID, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
      step(20);
      if (defend) {
        for (let k = 0; k < 2; k++) {
          const d = spawn(g, U.ArmoredDivision, HUMAN_ID, at(-8, k * 2 - 1));
          g.unitSys.order(H, [d.id], 'defend', at(-2, 0), 0);
        }
      }
      step(60);
      g.playerById[E].troops = 1_000_000;
      H.troops = 600_000;
      g.issue(E, { type: 'attack', target: HUMAN_ID, ratio: 0.5, tile: at(-8, 0) });
      const a = g.attackList.find((x) => !x.ended && x.attacker === E);
      let kmh = 0, n = 0;
      for (let i = 0; i < 300; i++) {
        step();
        if (i > 90 && a.state === 'advancing') {
          kmh += a.advanceKmh;
          n++;
        }
      }
      const divs = [...g.unitMap.values()].filter((u) => u.type === U.ArmoredDivision && u.owner === HUMAN_ID);
      return { kmh: n ? kmh / n : 0, taken: a.tilesTaken, divDef: g.attacks.view(a).divDef, divs, at };
    };
    const open = enemyRun(false), held = enemyRun(true);
    row('M2', 'enemy offensive into an undefended sector', `${open.kmh.toFixed(2)} km/h, ${open.taken} tiles`, 'reference', open.taken > 0);
    row('M2', 'the same with 2 divisions defending the sector', `${held.kmh.toFixed(2)} km/h, ${held.taken} tiles, divDef ${held.divDef}`, 'slower, fewer tiles, divDef ≥ 1', held.taken < open.taken && held.divDef >= 1);
  }
  // M3 / M4: assault and raze a structure near the front.
  {
    const run = (order) => {
      const r = offensiveRun(5, (c, phase) => {
        if (phase === 'before') {
          c.target = struct(c.g, S.Factory, c.E, c.at(4, 0), 2);
          c.city = struct(c.g, S.City, c.E, c.at(4, 6), 2);
          c.d = spawn(c.g, U.ArmoredDivision, HUMAN_ID, c.at(-3, 0));
          c.g.step?.();
        }
      }, 1);
      const { g, ctx, a } = r;
      g.unitSys.order(g.playerById[HUMAN_ID], [ctx.d.id], order, ctx.target.tile, ctx.target.id, undefined, true);
      const hp0 = ctx.target.hp;
      let shelled = 0, t = 0;
      while (t < 900 && g.structureMap.has(ctx.target.id) && ctx.target.owner !== HUMAN_ID) {
        ctx.step(10);
        t += 10;
        if (g.structureMap.has(ctx.target.id)) shelled = Math.max(shelled, hp0 - ctx.target.hp + (2 - ctx.target.level));
      }
      const aar = ctx.events.filter((e) => e.type === 'afterAction' && e.kind === 'mission').pop();
      return { g, ctx, t, aar, a, exists: g.structureMap.has(ctx.target.id), owner: ctx.target.owner, ruin: g.ruins.get(ctx.target.tile) };
    };
    const as = run('assault');
    row('M3', 'assault a factory near the front: shelled, then captured', `after ${as.t} ticks: exists ${as.exists}, owner ${as.owner}, hp ${as.ctx.target.hp.toFixed(2)} L${as.ctx.target.level}; axis on it ${Math.hypot(as.a.clickX - as.ctx.target.x, as.a.clickY - as.ctx.target.y) < 1.5}`,
      'captured by us (damaged)', as.exists && as.owner === HUMAN_ID && as.ctx.target.hp < 1);
    row('M3', 'after-action report of the assault', as.aar ? `${as.aar.result}, damage ${as.aar.damage}` : 'none', 'captured', as.aar?.result === 'captured');
    const rz = run('raze');
    row('M4', 'raze a factory: destroyed when its tile falls (rubble)', `after ${rz.t} ticks: exists ${rz.exists}, ruin ${rz.ruin?.cause}`, 'destroyed, ruin', !rz.exists && !!rz.ruin);
  }
  // M5: blockade a port.
  {
    const { g, step, H, E, at } = twoNations(5);
    // A coast: the enemy's port needs water; use the sim's naval test coast near Florida instead.
    void at;
    const P = T(30.3, -81.6); // Jacksonville coast
    g.transferContext = 'staging';
    g.forDisc?.(P, 3, (t) => g.playable[t] && g.setOwner(t, E));
    g.transferContext = 'none';
    step(2);
    let portTile = -1;
    for (let r = 0; r < 6 && portTile < 0; r++) {
      for (let dy = -r; dy <= r && portTile < 0; dy++) for (let dx = -r; dx <= r; dx++) {
        const t = P + dy * MAP_W + dx;
        if (g.owner[t] === E && g.nav.coastal[t]) { portTile = t; break; }
      }
    }
    if (portTile < 0) {
      row('M5', 'blockade test coast', 'no coastal tile', 'coast', false);
    } else {
      const port = struct(g, S.Port, E, portTile, 2);
      struct(g, S.Port, HUMAN_ID, T(25.8, -80.2) >= 0 ? g.nav.waterNear(T(25.8, -80.2)) : -1, 1);
      g.war.declare(HUMAN_ID, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
      const w = g.nav.waterNear(portTile);
      const ship = spawn(g, U.Warship, HUMAN_ID, w);
      step(2);
      const ok = g.unitSys.order(H, [ship.id], 'blockade', w, 0);
      step(40);
      const by = g.unitSys.blockaded(port);
      const trade0 = [...g.unitMap.values()].filter((u) => u.type === U.TradeShip && u.home === port.id).length;
      const pub = g.buildUpdate(1).structures?.find((x) => x.id === port.id);
      row('M5', 'a warship blockading an enemy port', `order ${ok}, blockaded by ${by}, trade ships out ${trade0}, published ${pub?.blockadedBy ?? '(unchanged)'}`, 'blockaded by us, no trade ships leave', ok && by === HUMAN_ID);
    }
  }
}

function aiMissions() {
  const { g, step, events } = quiet(30, true, 11);
  step(1200);
  // Every AI at war with its biggest neighbour (the director's own war plans run on top).
  const nations = g.playerArr.filter((p) => p.kind === 'nation' && p.alive);
  for (const P of nations) {
    for (const Q of nations) {
      if (P.id >= Q.id || !g.sharesBorder(P.id, Q.id) || g.war.atWar(P.id, Q.id)) continue;
      const w = g.war.declare(P.id, Q.id, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
      if (!w) console.log(`[M6] declare ${P.id}->${Q.id}: ${g.war.declareError(P.id, Q.id, { force: true })}`);
      break;
    }
  }
  // Give every AI an army and a fleet (the director orders them; nothing here orders a unit).
  for (const P of nations) {
    if (P.capitalTile < 0) continue;
    struct(g, S.ArmyBase, P.id, P.capitalTile, 3);
    for (let k = 0; k < 3; k++) spawn(g, U.ArmoredDivision, P.id, P.capitalTile);
    P.gold = Math.max(P.gold, 4_000_000);
    P.troops = Math.max(P.troops, P.maxTroops * 0.9);
    const border = [...P.shore][0];
    if (border !== undefined) {
      const w = g.nav.waterNear(border);
      if (w >= 0) spawn(g, U.Warship, P.id, w);
    }
  }
  const seen = { join: 0, defend: 0, assault: 0, raze: 0, blockade: 0 };
  const kinds = ['join', 'defend', 'assault', 'raze', 'blockade'];
  const codes = kinds.map((k) => ['move', 'attach', 'hold', 'return', 'cap', 'intercept', 'escort', 'strike', 'support', 'patrol', 'blockade', 'bombard', 'rebase', 'attack', 'defend', 'join', 'assault', 'raze'].indexOf(k));
  const counted = new Set();
  for (let i = 0; i < 150; i++) {
    step(10);
    for (const u of g.unitMap.values()) {
      if (u.owner === HUMAN_ID) continue;
      const k = codes.indexOf(u.order);
      if (k < 0) continue;
      const key = `${u.id}:${u.order}`;
      if (counted.has(key)) continue;
      counted.add(key);
      seen[kinds[k]]++;
    }
  }
  const aars = events.filter((e) => e.type === 'structureDamaged' && e.cause === 'artillery' && e.by !== HUMAN_ID).length;
  const divs = [...g.unitMap.values()].filter((u) => u.owner !== HUMAN_ID && (u.type === U.ArmoredDivision || u.type === U.Warship));
  const brains = g.ai.brains ? [...g.ai.brains.values()].map((b) => b.enemy) : Object.keys(g.ai);
  console.log(`[M6] attacks ${g.attackList.filter((a) => !a.ended).length}, wars ${nations.map((P) => g.war.warsOf(P.id).length).join(',')}`);
  console.log(`[M6] AI divisions/warships: ${divs.length}; orders ${JSON.stringify(divs.slice(0, 12).map((u) => [u.type, u.order, u.state, u.mode]))}; `);
  row('M6', 'AI divisions and warships on the same missions (1,500 ticks of war)', JSON.stringify(seen), 'join, defend and at least one of assault / blockade', seen.join > 0 && seen.defend > 0 && seen.assault + seen.blockade > 0);
  row('M6', 'AI division artillery hits on structures', `${aars} damage events`, '> 0', aars > 0);
}

const sections = { damage, missions, ai: aiRepairs, aimissions: aiMissions };
for (const [k, fn] of Object.entries(sections)) {
  if (ONLY && ONLY !== k) continue;
  fn();
}
const pass = results.filter((r) => r.pass).length;
console.log(`\nf3-audit: ${pass}/${results.length} passed`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
process.exit(pass === results.length ? 0 : 1);
