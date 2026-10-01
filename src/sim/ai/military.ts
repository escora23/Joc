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

import { MAP_W, NUKE_DEFS } from '../../shared/constants';
import type { SimAttack, SimPlayer, SimStructure } from '../../shared/simapi';
import { StructureType, UNIT_ORDER_KINDS, UnitState, UnitType, type WeaponType } from '../../shared/types';
import { alive, isMajor, relation, type AiContext } from './context';
import { nuclearThreat } from './economy';
import { dist2, friendlyShare, ownerShare, tileAt } from './mapindex';
import type { Brain } from './state';
import { blockadeTile } from './navalwar';

/** Reach in tiles from the airbase (§6.3: 1,000 / 2,000 / 1,000 km) and the cruise missile's 2,500 km. */
const AIR_RANGE: Record<number, number> = { [UnitType.FighterSquadron]: 40, [UnitType.Bomber]: 80, [UnitType.DroneSwarm]: 40 };
const CRUISE_RANGE = 100;
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
  // The war plan's enemy; failing that (a war declared on us, a call to arms), the first war we are in.
  let enemyId = b.enemy > 0 && alive(g.player(b.enemy)) && g.war.atWar(p.id, b.enemy) ? b.enemy : 0;
  if (!enemyId) {
    for (const w of g.war.warsOf(p.id)) {
      const o = w.a === p.id ? w.b : w.a;
      if (alive(g.player(o))) {
        enemyId = o;
        break;
      }
    }
  }
  const atWar = enemyId > 0;
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
  const enemy = atWar ? g.player(enemyId)! : null;
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
  // Owner item #25: the AI flies the same missions as the player. Our land offensive against this enemy (drones give it
  // close air support, a fighter patrol wins the sky over it) and the free fighters that can escort a bomber.
  let pushing = false;
  if (enemy) for (const a of g.outgoingAttacks(p.id)) if (a.defender === enemy.id && !a.naval && a.state !== 'retreating') pushing = true;
  const freeFighters: number[] = [];
  for (const u of units) if (u.type === UnitType.FighterSquadron && (u.state === UnitState.Docked || u.state === UnitState.Idle)) freeFighters.push(u.id);
  let fighterN = 0;
  // Naval path planning is expensive: at most one warship gets new orders per pass.
  let shipOrders = 0;
  const reserve = Math.max(0.15, b.prof.reserve + b.diff.reserveDelta);
  // On the offensive with troops above the reserve, or while our own offensive against the enemy runs (its troops are
  // committed there; the divisions go with them, Feedback 3).
  const offensive = p.troops > p.maxTroops * (reserve + 0.05) || pushing;
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
  const outgoing = g.outgoingAttacks(p.id);
  let assaultIssued = false, defendersKept = 0;
  for (const u of units) {
    if (u.state === UnitState.Controlled) continue;
    const here = unitTile(u.x, u.y);
    switch (u.type) {
      case UnitType.ArmoredDivision: {
        // Posture: on the offensive (troops above the reserve) the tanks spearhead our attack on the enemy front
        // (a division at an enemy front launches assaults on its own); on the defensive they dig in on our side
        // of the most threatened front, where defending armor makes attackers bleed.
        // Feedback 3 (#28): the same missions as the player. On the offensive: join our running offensive against the
        // enemy (the division follows its spearhead and adds its power), or assault an enemy structure near the line
        // (defence posts first: they slow our advance); on the defensive: defend the threatened sector.
        const targetsEnemy = u.targetTile >= 0 && g.ownerOf(u.targetTile) !== p.id;
        const ord = u.order >= 0 ? UNIT_ORDER_KINDS[u.order] : '';
        // Feedback 3 fix 2 (#28): the missions are re-planned, not set once. A division holding a sector (defend /
        // attach) or idle goes with our running offensive (join); a joined one near an enemy structure the spearhead
        // is reaching assaults it (or razes it when the enemy is hated); against the human as against anyone.
        const onMission = ord === 'join' || ord === 'assault' || ord === 'raze';
        if (offensive && enemy) {
          if (u.state === UnitState.Moving && !onMission && ord !== 'defend' && ord !== 'attach') break;
          // Our offensive against this enemy nearest the division.
          let off: SimAttack | null = null, od = Infinity;
          for (const a of outgoing) {
            if (a.defender !== enemy.id || a.naval || a.state === 'retreating') continue;
            const ax = a.liveX >= 0 ? a.liveX : a.clickX, ay = a.liveY >= 0 ? a.liveY : a.clickY;
            const d = Math.hypot(ax - u.x, ay - u.y);
            if (d < od) {
              od = d;
              off = a;
            }
          }
          // The spearhead within reach of a structure: one assault (or raze) order per pass, from a joined division.
          if (ord === 'join' && off && !assaultIssued && rng.next() < 0.5) {
            const ax = off.liveX >= 0 ? off.liveX : off.clickX, ay = off.liveY >= 0 ? off.liveY : off.clickY;
            const tgt = assaultTarget(ctx, p, enemy, unitTile(ax, ay), 6);
            if (tgt) {
              const raze = tgt.type !== StructureType.City && g.diplomacy.opinion(p.id, enemy.id) < -60 && rng.next() < 0.4;
              if (g.issue(p.id, { type: 'unitOrder', unitIds: [u.id], order: raze ? 'raze' : 'assault', tile: tgt.tile, targetId: tgt.id })) {
                assaultIssued = true;
                break;
              }
            }
          }
          if (onMission) break;
          // A sector under a real threat keeps one defender.
          if (ord === 'defend' && threatFront >= 0 && defendersKept < 1) {
            defendersKept++;
            break;
          }
          if (off && g.issue(p.id, { type: 'unitOrder', unitIds: [u.id], order: 'join', tile: -1, targetId: off.id })) break;
          if (u.state !== UnitState.Idle) break;
          // No offensive of ours yet: a structure near the line, else deploy toward the enemy.
          if (rng.next() < 0.35) {
            const tgt = assaultTarget(ctx, p, enemy, enemyAim >= 0 ? enemyAim : here);
            if (tgt && g.issue(p.id, { type: 'unitOrder', unitIds: [u.id], order: 'assault', tile: tgt.tile, targetId: tgt.id })) break;
          }
          const tgt = enemyAim >= 0 ? enemyAim : enemy.capitalTile;
          if (tgt >= 0) g.issue(p.id, { type: 'deployArmor', unitId: u.id, targetTile: tgt });
        } else if (targetsEnemy || u.state === UnitState.Idle) {
          const hold = threatFront >= 0 ? threatFront : ourFront >= 0 ? ourFront : b.homeTile;
          if (hold >= 0 && (targetsEnemy || u.targetTile !== hold)) {
            if (!g.issue(p.id, { type: 'unitOrder', unitIds: [u.id], order: 'defend', tile: hold, targetId: 0 })) g.issue(p.id, { type: 'deployArmor', unitId: u.id, targetTile: hold });
          }
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
          // Feedback 3: cities are civilian targets with a diplomatic price: an AI bombs them in answer to strikes on its
          // own (or an ally's) cities, otherwise only as a last resort. Military targets first; a structure already in
          // ruins-to-be (heavily damaged) is worth finishing, one being repaired is worth hitting again.
          const answer = g.diplomacy.hasCasusBelli(p.id, enemy.id);
          const v = (s.type === StructureType.SamSite ? 5 : s.type === StructureType.MissileSilo ? 4.5 : s.type === StructureType.Airbase ? 3.5
            : s.type === StructureType.City ? (answer ? 2.5 + s.level * 0.3 : 0.5) : s.type === StructureType.Factory || s.type === StructureType.Port ? 1.8 : 1)
            * (s.hp < 0.4 ? 1.3 : 1);
          const sc = v / (1 + d / range);
          if (sc > bestScore) {
            bestScore = sc;
            best = s.tile;
          }
        }
        // Drones over our own offensive: close air support (+15 % advance) rather than a one-way strike.
        if (u.type === UnitType.DroneSwarm && pushing && enemyAim >= 0 && nearestDist2(airbaseTiles, enemyAim) < range * range * 0.8 && rng.next() < 0.65
          && g.issue(p.id, { type: 'unitOrder', unitIds: [u.id], order: 'support', tile: enemyAim, targetId: 0 })) break;
        if (best < 0 && enemyAim >= 0 && nearestDist2(airbaseTiles, enemyAim) < range * range * 0.8) best = enemyAim;
        if (best >= 0 && g.issue(p.id, { type: 'airStrike', unitId: u.id, targetTile: best }) && u.type === UnitType.Bomber && freeFighters.length > 1) {
          // An escorted strike: a free fighter flies with the bomber (enemy interceptors must get through it).
          const f = freeFighters.pop()!;
          g.issue(p.id, { type: 'unitOrder', unitIds: [f], order: 'escort', tile: unitTile(u.x, u.y), targetId: u.id });
        }
        break;
      }
      case UnitType.FighterSquadron: {
        if (u.state !== UnitState.Docked && u.state !== UnitState.Idle) break;
        if (!freeFighters.includes(u.id)) break; // taken as an escort this pass
        // Combat air patrol (intercepts bombers, drones and missiles): the first one over our offensive for air
        // superiority, then over the front where the enemy pushes, else over our front, else over the capital.
        const k = fighterN++;
        const cap = k === 0 && pushing && enemyAim >= 0 ? enemyAim : threatFront >= 0 && k <= 1 ? threatFront : ourFront >= 0 ? ourFront : b.homeTile;
        if (cap >= 0 && nearestDist2(airbaseTiles, cap) < AIR_RANGE[u.type] * AIR_RANGE[u.type] * 0.8 && rng.next() < 0.7) {
          g.issue(p.id, { type: 'moveUnit', unitId: u.id, tile: cap });
        }
        break;
      }
      case UnitType.Warship: {
        if (u.state !== UnitState.Idle && u.state !== UnitState.Moving) break;
        // Owner item 30: a warship holding a blockade keeps it while the war lasts.
        const held = g.naval.blockadeOfUnit(u.id);
        if (held && enemy) break;
        if (shipOrders > 0 || rng.next() < 0.6) break;
        let dest = -1;
        // Feedback 3 (#28) / owner item 30: close the strait the enemy's ships sail through, else blockade its nearest
        // port (its trade stops) when one lies within reach. Enemies only (the default blockade).
        if (enemy && !held && rng.next() < 0.5) {
          const port = nearestOf(ctx, enemy.id, StructureType.Port, here);
          const water = port && dist2(port.tile, here) < 320 * 320 ? waterBeside(ctx, port.tile) : -1;
          const at = blockadeTile(ctx, enemy.id, here, water);
          if (at >= 0 && g.issue(p.id, { type: 'unitOrder', unitIds: [u.id], order: 'blockade', tile: at, targetId: 0, blockade: { who: 'war', ships: 'all', action: 'seize' } })) {
            shipOrders++;
            break;
          }
        }
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

/**
 * Feedback 3: an enemy structure worth assaulting near `near`: a defence post (it slows our advance), an army base or
 * airbase, a city last; within 6 tiles of our land (the sim checks the exact depth and refuses the rest).
 */
function assaultTarget(ctx: AiContext, p: SimPlayer, enemy: SimPlayer, near: number, maxTiles = 14): SimStructure | null {
  const g = ctx.g;
  let best: SimStructure | null = null, bestV = 0;
  for (const s of g.structures(enemy.id)) {
    if (s.built < 1) continue;
    const d = Math.sqrt(dist2(s.tile, near));
    if (d > maxTiles) continue;
    const v = (s.type === StructureType.DefensePost ? 4 : s.type === StructureType.ArmyBase || s.type === StructureType.Airbase ? 3
      : s.type === StructureType.SamSite ? 2.5 : s.type === StructureType.City ? 1.5 : 1) / (1 + d / 6);
    if (v > bestV) {
      bestV = v;
      best = s;
    }
  }
  void p;
  return best;
}

function nearestOf(ctx: AiContext, owner: number, type: StructureType, near: number): SimStructure | null {
  let best: SimStructure | null = null, bd = Infinity;
  for (const s of ctx.g.structures(owner, type)) {
    const d = dist2(s.tile, near);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/** A water tile next to a coastal tile (the blockade station off a port), -1 if none. */
function waterBeside(ctx: AiContext, tile: number): number {
  const g = ctx.g;
  const x = tile % MAP_W, y = (tile / MAP_W) | 0;
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const t = (y + dy) * MAP_W + (((x + dx) % MAP_W) + MAP_W) % MAP_W;
        if (t >= 0 && t < MAP_W * (MAP_W / 2) && g.isWater(t)) return t;
      }
    }
  }
  return -1;
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
