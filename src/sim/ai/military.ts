// FRONT ULTRA — AI military: armored divisions, air force, navy, cruise missiles and nuclear weapons (owner:
// sim-ai). Worker-only.
//
// * Armor rolls to the front of the current war and spearheads the attack.
// * Bombers and drones strike the enemy's air defenses, silos and airbases first, then cities, then troops at
//   the front; fighters fly combat air patrol over our own front.
// * Warships patrol off the enemy's coast (shelling it and hunting its transports) or guard our ports.
// * Cruise missiles knock out SAM sites and silos in range.
// * Nukes: nukers go nuclear from mid-game, everyone else late (earlier as the doomsday clock ticks), and anyone
//   who is nuked retaliates. Targets are the densest value in blast range (cities, silos, the front), never
//   where the blast would spill onto our own or allied land, and SAM umbrellas are cracked with cruise missiles.

import { HUMAN_ID, MAP_W, NUKE_DEFS } from '../../shared/constants';
import type { SimPlayer, SimStructure } from '../../shared/simapi';
import { StructureType, UnitState, UnitType, type WeaponType } from '../../shared/types';
import { alive, isMajor, relation, type AiContext } from './context';
import { nuclearThreat } from './economy';
import { dist2, friendlyShare, ownerShare, tileAt } from './mapindex';
import type { Brain } from './state';
import { atWar } from './diplomacy';

const AIR_RANGE: Record<number, number> = { [UnitType.FighterSquadron]: 160, [UnitType.Bomber]: 210, [UnitType.DroneSwarm]: 130 };
const CRUISE_RANGE = 300;
const SAM_COVER = 70;

const unitTile = (x: number, y: number) => tileAt(Math.floor(x), Math.floor(y));
/** Strategic (L2) targets: cities, ports, factories (§5.10). */
const STRATEGIC = new Set<number>([StructureType.City, StructureType.Port, StructureType.Factory]);

export function thinkMilitary(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  const rng = ctx.rng;
  const prof = b.prof;
  const mine = g.structures(p.id);
  let armyBases = 0, airbases = 0, yards = 0;
  const airbaseTiles: number[] = b.scratch;
  airbaseTiles.length = 0;
  for (const s of mine) {
    if (s.built < 1) continue;
    if (s.type === StructureType.ArmyBase) armyBases += s.level;
    else if (s.type === StructureType.Airbase) {
      airbases += s.level;
      airbaseTiles.push(s.tile);
    } else if (s.type === StructureType.NavalYard) yards += s.level;
  }
  const units = g.units(p.id);
  let armor = 0, fighters = 0, bombers = 0, drones = 0, warships = 0;
  for (const u of units) {
    switch (u.type) {
      case UnitType.ArmoredDivision: armor++; break;
      case UnitType.FighterSquadron: fighters++; break;
      case UnitType.Bomber: bombers++; break;
      case UnitType.DroneSwarm: drones++; break;
      case UnitType.Warship: warships++; break;
    }
  }
  const rich = (type: UnitType, k: number) => p.gold > g.unitCost(p.id, type) * k;
  // v2: only a declared war makes an enemy (strikes, missiles and armor act on it alone).
  const atWar = b.enemy > 0 && alive(g.player(b.enemy)) && g.war.atWar(p.id, b.enemy);
  const reserveGold = atWar ? 1.2 : 1.8;

  // --- production -----------------------------------------------------------------------------------
  if (armyBases > 0 && armor < armyBases * 2 && rich(UnitType.ArmoredDivision, reserveGold)) {
    g.issue(p.id, { type: 'buildUnit', unit: UnitType.ArmoredDivision, structureId: -1 });
  } else if (airbases > 0) {
    const wantF = 1 + (atWar ? 1 : 0);
    if (fighters < wantF && rich(UnitType.FighterSquadron, reserveGold)) g.issue(p.id, { type: 'buildUnit', unit: UnitType.FighterSquadron, structureId: -1 });
    else if (bombers < 1 + (prof.aggression > 1.2 ? 1 : 0) && rich(UnitType.Bomber, reserveGold + 0.3)) g.issue(p.id, { type: 'buildUnit', unit: UnitType.Bomber, structureId: -1 });
    else if (drones < 2 && rich(UnitType.DroneSwarm, reserveGold)) g.issue(p.id, { type: 'buildUnit', unit: UnitType.DroneSwarm, structureId: -1 });
  }
  if (yards > 0 && warships < Math.min(4, 1 + Math.floor(p.tiles / 6000) + (prof.naval > 1 ? 1 : 0)) && rich(UnitType.Warship, reserveGold + 0.2)) {
    g.issue(p.id, { type: 'buildUnit', unit: UnitType.Warship, structureId: -1 });
  }

  // --- operations -----------------------------------------------------------------------------------
  const enemy = atWar ? g.player(b.enemy)! : null;
  // v2 escalation ladder (§5.10): L1 (military targets) from the end of our mobilization, L2 (cities, ports,
  // factories) after 72 h of war, when the enemy went L2 first, or in a war of conquest.
  let level = 0;
  if (enemy) {
    const w = g.war.between(p.id, enemy.id);
    if (w && g.war.mobilizingUntil(p.id, enemy.id) === 0) {
      level = g.war.escalation(p.id, enemy.id);
      if (level < 1) {
        g.war.raiseEscalation(p.id, enemy.id, 1, 'escalation.reason.military');
        level = 1;
      }
      const long = g.tick - w.startTick >= 720;
      const theirs = g.war.escalation(enemy.id, p.id) >= 2;
      if (level < 2 && (long || theirs || (w.a === p.id && w.goal === 'conquest'))) {
        g.war.raiseEscalation(p.id, enemy.id, 2, theirs ? 'escalation.reason.answer' : 'escalation.reason.strategic');
        level = 2;
      }
    }
  }
  const enemyAim = enemy ? b.front.aim.get(enemy.id) ?? -1 : -1;
  const ourFront = enemy ? b.front.ours.get(enemy.id) ?? -1 : -1;
  let targets: readonly SimStructure[] | null = null;
  // Naval path planning is expensive: at most one warship gets new orders per pass.
  let shipOrders = 0;
  const reserve = Math.max(0.15, b.prof.reserve + b.diff.reserveDelta);
  const offensive = p.troops > p.maxTroops * (reserve + 0.05);
  // Our side of the front facing the biggest incoming assault (defensive armor goes there).
  let threatFront = -1;
  {
    let top = 0;
    for (const a of g.incomingAttacks(p.id)) {
      if (a.naval || a.attacker <= 0 || a.troops <= top) continue;
      const t = b.front.ours.get(a.attacker);
      if (t !== undefined) {
        top = a.troops;
        threatFront = t;
      }
    }
  }
  for (const u of units) {
    if (u.state === UnitState.Controlled) continue;
    const here = unitTile(u.x, u.y);
    switch (u.type) {
      case UnitType.ArmoredDivision: {
        // Posture: on the offensive (troops above the reserve) the tanks spearhead our attack on the enemy front
        // (a division at an enemy front launches assaults on its own); on the defensive they dig in on our side
        // of the most threatened front, where defending armor makes attackers bleed.
        const targetsEnemy = u.targetTile >= 0 && g.ownerOf(u.targetTile) !== p.id;
        if (offensive && enemy) {
          if (u.state !== UnitState.Idle) break;
          const tgt = enemyAim >= 0 ? enemyAim : enemy.capitalTile;
          if (tgt >= 0) g.issue(p.id, { type: 'deployArmor', unitId: u.id, targetTile: tgt });
        } else if (targetsEnemy || u.state === UnitState.Idle) {
          const hold = threatFront >= 0 ? threatFront : ourFront >= 0 ? ourFront : b.homeTile;
          if (hold >= 0 && (targetsEnemy || u.targetTile !== hold)) g.issue(p.id, { type: 'deployArmor', unitId: u.id, targetTile: hold });
        }
        break;
      }
      case UnitType.Bomber:
      case UnitType.DroneSwarm: {
        if (!enemy || level < 1 || (u.state !== UnitState.Docked && u.state !== UnitState.Idle)) break;
        if (rng.next() < 0.25) break;
        targets ??= g.structures(enemy.id);
        const range = AIR_RANGE[u.type];
        let best = -1, bestScore = 0;
        for (const s of targets) {
          if (s.built < 1) continue;
          if (level < 2 && STRATEGIC.has(s.type)) continue;
          const d = Math.sqrt(nearestDist2(airbaseTiles, s.tile));
          if (d > range * 0.95) continue;
          const v = s.type === StructureType.SamSite ? 5 : s.type === StructureType.MissileSilo ? 4.5 : s.type === StructureType.Airbase ? 3.5
            : s.type === StructureType.City ? 1.5 + s.level * 0.4 : s.type === StructureType.Factory || s.type === StructureType.Port ? 1.8 : 1;
          const sc = v / (1 + d / range);
          if (sc > bestScore) {
            bestScore = sc;
            best = s.tile;
          }
        }
        if (best < 0 && enemyAim >= 0 && nearestDist2(airbaseTiles, enemyAim) < range * range * 0.8) best = enemyAim;
        if (best >= 0) g.issue(p.id, { type: 'airStrike', unitId: u.id, targetTile: best });
        break;
      }
      case UnitType.FighterSquadron: {
        if (u.state !== UnitState.Docked && u.state !== UnitState.Idle) break;
        // Combat air patrol over our front (intercepts bombers and transports), else over the capital.
        const cap = ourFront >= 0 ? ourFront : b.homeTile;
        if (cap >= 0 && nearestDist2(airbaseTiles, cap) < AIR_RANGE[u.type] * AIR_RANGE[u.type] * 0.8 && rng.next() < 0.7) {
          g.issue(p.id, { type: 'moveUnit', unitId: u.id, tile: cap });
        }
        break;
      }
      case UnitType.Warship: {
        if (u.state !== UnitState.Idle && u.state !== UnitState.Moving) break;
        if (shipOrders > 0 || rng.next() < 0.6) break;
        let dest = -1;
        if (enemy) {
          // Shell the enemy coast near the front, or near their capital.
          const near = enemyAim >= 0 && ctx.g.isShore(enemyAim) ? enemyAim : coastOf(ctx, enemy, here);
          if (near >= 0 && dist2(near, here) < 320 * 320) dest = near;
        }
        if (dest < 0 && b.front.shoreSample.length) dest = b.front.shoreSample[rng.int(b.front.shoreSample.length)];
        // Already heading there: leave it be.
        if (dest >= 0 && (u.targetTile < 0 || dist2(u.targetTile, dest) > 30 * 30)) {
          g.issue(p.id, { type: 'moveUnit', unitId: u.id, tile: dest });
          shipOrders++;
        }
        break;
      }
    }
  }

  // Cruise missiles (v2 §5.10): from the war plan's target list (the enemy's air defenses, silos and airbases in
  // range), within the sim's caps (1 per AI per 120 ticks, 3 per 600 ticks worldwide); never a dice roll.
  if (enemy && level >= 1 && rich(UnitType.CruiseMissile, 2.5)) {
    const silos = mine.filter((s) => s.type === StructureType.MissileSilo && s.built >= 1 && s.cooldownTicks <= 0);
    if (silos.length) {
      targets ??= g.structures(enemy.id);
      for (const s of targets) {
        if (s.built < 1 || (s.type !== StructureType.SamSite && s.type !== StructureType.MissileSilo && s.type !== StructureType.Airbase)) continue;
        if (nearestDist2(silos.map((x) => x.tile), s.tile) > CRUISE_RANGE * CRUISE_RANGE) continue;
        g.issue(p.id, { type: 'launch', weapon: UnitType.CruiseMissile, targetTile: s.tile, siloId: -1 });
        break;
      }
    }
  }
}

function nearestDist2(list: readonly number[], t: number): number {
  let best = Infinity;
  for (const a of list) best = Math.min(best, dist2(a, t));
  return best;
}

/** A coastal tile of `q` (their capital's coast, else any shore structure), or -1. */
function coastOf(ctx: AiContext, q: SimPlayer, near: number): number {
  const g = ctx.g;
  let best = -1, bd = Infinity;
  for (const s of g.structures(q.id)) {
    if (s.type !== StructureType.Port && s.type !== StructureType.NavalYard) continue;
    const d = dist2(s.tile, near);
    if (d < bd) {
      bd = d;
      best = s.tile;
    }
  }
  if (best < 0 && q.capitalTile >= 0 && g.isShore(q.capitalTile)) best = q.capitalTile;
  return best;
}

// =================================================================================================
// Nuclear strategy
// =================================================================================================

/** Earliest tick this brain launches an unprovoked nuke. */
export function nukeTick(ctx: AiContext, b: Brain): number {
  return b.diff.nukeTick * b.prof.nukeDelay * (1 - ctx.world.doomsday * 0.45) * (ctx.world.detonations > 0 ? 0.85 : 1);
}

/** The nuclear taboo (§5.10): AI first uses of nuclear weapons per game; retaliation is not counted. */
const AI_FIRST_USES = 3;

export function thinkNukes(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  const rng = ctx.rng;
  if (!g.config.nukes) return;
  const silos = g.structures(p.id, StructureType.MissileSilo).filter((s) => s.built >= 1);
  if (silos.length === 0) return;
  const ready = silos.filter((s) => s.cooldownTicks <= 0);
  if (ready.length === 0) return;
  // v2 (§5.10): nuclear weapons only inside a war, after raising the escalation ladder for a stated reason:
  // L3 (atom) in retaliation or out of desperation, L4 (H-bomb, MIRV) in retaliation for a strike on our own land
  // or when the war is existential. The sim enforces the global caps and the aim rule (invariant 6).
  for (const w of g.war.warsOf(p.id)) {
    const enemy = w.a === p.id ? w.b : w.a;
    const q = g.player(enemy);
    if (!alive(q) || !isMajor(q)) continue;
    const s = w.a === p.id ? 0 : 1;
    const lost = s === 0 ? Math.max(0, -w.net) : Math.max(0, w.net);
    const r = relation(b, enemy);
    const nukedUs = r.nukedTick >= w.startTick;
    const allyNuked = b.allyNukedBy.get(enemy) ?? -1;
    // Proportionate answers (§5.10): one launch for each one received, and one for a nuclear strike on an ally; a
    // first use (desperation, existential) happens at most once per enemy, only while the world's fear (doomsday) is
    // low and the nuclear taboo still holds (AI_FIRST_USES per game). This ends tit-for-tat spirals after one exchange.
    const owed = nukedUs && (r.nukesReceived ?? 0) > r.nukesSent;
    const allyOwed = allyNuked >= w.startTick && r.nukesSent === 0 && ctx.world.doomsday < 0.5;
    const retaliation = owed || allyOwed;
    const firstUseOk = r.nukesSent === 0 && ctx.world.firstUses < AI_FIRST_USES && ctx.world.doomsday < 0.35;
    const desperate = firstUseOk && (lost >= w.tilesAtStart[s] * 0.4 || w.capitalLost[s]) && g.tick - w.startTick >= 1200 && b.prof.nukes >= 0.4;
    const existential = firstUseOk && w.capitalLost[s] && lost >= w.tilesAtStart[s] * 0.6 && (b.personality === 'nuker' || ctx.world.doomsday >= 0.7);
    let want = 0;
    if (retaliation || desperate) want = 3;
    if (owed || existential) want = 4;
    if (want === 0) continue;
    const level = g.war.escalation(p.id, enemy);
    if (level < want) {
      const reason = nukedUs ? 'escalation.reason.retaliation' : retaliation ? 'escalation.reason.allyRetaliation' : existential ? 'escalation.reason.existential' : 'escalation.reason.desperation';
      g.war.raiseEscalation(p.id, enemy, want, reason);
    }
    // Retaliation always answers; desperation only sometimes (personality and difficulty).
    if (!retaliation && rng.next() > b.prof.nukes * b.diff.nukeChance) continue;
    const top = g.war.escalation(p.id, enemy);
    const can = (wpn: WeaponType) => p.gold >= g.unitCost(p.id, wpn);
    const options: WeaponType[] = [];
    if (top >= 4 && can(UnitType.Mirv) && q.tiles > 9000 && (b.personality === 'nuker' || nukedUs)) options.push(UnitType.Mirv);
    if (top >= 4 && can(UnitType.HydrogenBomb)) options.push(UnitType.HydrogenBomb);
    if (top >= 3 && can(UnitType.AtomBomb)) options.push(UnitType.AtomBomb);
    for (const weapon of options) {
      const aim = chooseNukeTarget(ctx, b, p, q, weapon);
      if (aim < 0) continue;
      if (g.issue(p.id, { type: 'launch', weapon, targetTile: aim, siloId: -1 })) {
        b.lastNukeTick = g.tick;
        b.nukesLaunched++;
        r.nukesSent++;
        if (!retaliation) ctx.world.firstUses++;
        r.trust = -1;
        return;
      }
      break;
    }
  }
}

/** The nation that most deserves a nuclear strike from `p` (hostility, grudges, coalition, size), if any. */
function pickNukeTarget(ctx: AiContext, b: Brain, p: SimPlayer): SimPlayer | undefined {
  const g = ctx.g;
  const w = ctx.world;
  let best: SimPlayer | undefined, bestScore = 3;
  for (const q of g.players()) {
    if (q.id === p.id || !alive(q) || !isMajor(q) || q.tiles < 400 || g.isAllied(p.id, q.id)) continue;
    let s = Math.log10(q.tiles) * 0.6;
    if (q.id === b.enemy) s += 3;
    if (atWar(ctx, p.id, q.id)) s += 2;
    if (w.leader === q.id && w.leaderShare > b.diff.coalitionShare) s += 2 + b.prof.coalition * 2;
    const r = b.relations.get(q.id);
    if (r) {
      s += -r.trust * 1.5 + Math.min(3, r.grievance * 0.5);
      if (g.tick - r.nukedTick < 6000) s += 5;
      if (r.betrayedUs) s += 2;
    }
    if (q.id === HUMAN_ID) s *= b.diff.humanFocus;
    if (s > bestScore) {
      bestScore = s;
      best = q;
    }
  }
  return best;
}

/** Best aim tile for `weapon` on `q`: dense value, blast on the victim, away from our land and allies. */
function chooseNukeTarget(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer, weapon: WeaponType): number {
  const g = ctx.g;
  const def = NUKE_DEFS[weapon];
  const outer = weapon === UnitType.Mirv ? 14 : def.outerRadius;
  const candidates: { tile: number; value: number }[] = [];
  const structs = g.structures(q.id);
  const samTiles: number[] = [];
  for (const s of structs) {
    if (s.type === StructureType.SamSite && s.built >= 1) samTiles.push(s.tile);
    let v = 0;
    switch (s.type) {
      case StructureType.City: v = 3 + s.level * 1.2; break;
      case StructureType.MissileSilo: v = 6; break;
      case StructureType.Airbase: case StructureType.ArmyBase: case StructureType.NavalYard: v = 2.5; break;
      case StructureType.Factory: case StructureType.Port: v = 2; break;
      case StructureType.SamSite: v = 1.5; break;
      default: v = 1;
    }
    candidates.push({ tile: s.tile, value: v });
  }
  if (q.capitalTile >= 0) candidates.push({ tile: q.capitalTile, value: 4 });
  // Behind their side of our common front, where their troops mass (pushed deep enough to spare our land).
  const ours = b.front.ours.get(q.id), theirs = b.front.aim.get(q.id);
  if (ours !== undefined && theirs !== undefined) {
    let dx = (theirs % MAP_W) - (ours % MAP_W);
    if (dx > MAP_W / 2) dx -= MAP_W;
    if (dx < -MAP_W / 2) dx += MAP_W;
    const dy = ((theirs / MAP_W) | 0) - ((ours / MAP_W) | 0);
    const len = Math.max(1, Math.hypot(dx, dy));
    const deep = tileAt((theirs % MAP_W) + (dx / len) * outer * 1.35, ((theirs / MAP_W) | 0) + (dy / len) * outer * 1.35);
    let pressure = 0;
    for (const a of g.outgoingAttacks(q.id)) if (a.defender === p.id) pressure += a.troops;
    if (deep >= 0 && g.ownerOf(deep) === q.id) candidates.push({ tile: deep, value: 2 + (pressure / Math.max(1, q.troops)) * 5 });
  }
  let best = -1, bestScore = 0;
  const cap = Math.min(40, candidates.length);
  for (let i = 0; i < cap; i++) {
    const c = candidates[ctx.rng.int(candidates.length)];
    if (c.tile < 0) continue;
    // Never nuke near our own capital, and keep the blast off our and allied land.
    if (b.homeTile >= 0 && dist2(c.tile, b.homeTile) < (outer * 1.6) * (outer * 1.6)) continue;
    const friendly = friendlyShare(g, p.id, c.tile, outer * 1.1);
    if (friendly > 0) continue;
    // Invariant 6: the outer radius may only cover land of players at war with us (or nobody).
    if (!onlyEnemies(ctx, p.id, c.tile, weapon === UnitType.Mirv ? 14 : outer)) continue;
    const onTarget = ownerShare(g, q.id, c.tile, outer);
    if (onTarget < 0.35) continue;
    // Value of everything else inside the blast.
    let v = c.value * onTarget;
    for (const s of g.structuresNear((c.tile % MAP_W) + 0.5, ((c.tile / MAP_W) | 0) + 0.5, outer)) if (s.owner === q.id) v += 0.8;
    // Under a SAM umbrella the bomb will probably be shot down: only big salvos (MIRV) ignore it.
    if (weapon !== UnitType.Mirv) for (const t of samTiles) if (dist2(t, c.tile) < SAM_COVER * SAM_COVER) v *= 0.45;
    if (v > bestScore) {
      bestScore = v;
      best = c.tile;
    }
  }
  return bestScore > 1.2 ? best : -1;
}

/** SAMs & radar when threatened (called from the build loop is not enough when nukes are already flying). */
export function emergencyAirDefense(ctx: AiContext, b: Brain, p: SimPlayer): boolean {
  const g = ctx.g;
  if (nuclearThreat(ctx, b, p) < 0.9) return false;
  if (g.structures(p.id, StructureType.SamSite).length >= 1 + Math.floor(p.tiles / 6000)) return false;
  return p.gold >= g.structureCost(p.id, StructureType.SamSite);
}

/** Every owned land tile within r tiles of `tile` belongs to an enemy at war with `p` (or to nobody). */
function onlyEnemies(ctx: AiContext, p: number, tile: number, r: number): boolean {
  const g = ctx.g;
  const cx = tile % MAP_W, cy = (tile / MAP_W) | 0;
  const lat = 90 - ((cy + 0.5) / (MAP_W / 2)) * 180;
  const cos = Math.max(0.12, Math.cos((lat * Math.PI) / 180));
  const rx = Math.ceil(r / cos), ry = Math.ceil(r);
  const seen = new Set<number>();
  for (let dy = -ry; dy <= ry; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= MAP_W / 2) continue;
    for (let dx = -rx; dx <= rx; dx++) {
      const ex = dx * cos;
      if (ex * ex + dy * dy > r * r) continue;
      const t = y * MAP_W + ((cx + dx + MAP_W) % MAP_W);
      const o = g.ownerOf(t);
      if (o === 0 || seen.has(o)) continue;
      seen.add(o);
      if (!g.war.atWar(p, o)) return false;
    }
  }
  return true;
}
