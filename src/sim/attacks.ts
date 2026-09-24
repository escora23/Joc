// FRONT ULTRA — land attacks: expanding fronts conquered tile by tile. Owner: sim-core. Worker-only.
//
// Each attack owns a priority queue of frontier tiles (defender tiles touching the attacker). Every tick an attack
// spends a budget of 1 on tiles, each tile consuming a fraction that grows with terrain difficulty and with how
// outnumbered the attack is, divided by the frontier size: wide fronts advance everywhere at once, concavities
// fill first (tiles surrounded by the attacker get lower priorities), mountains and rivers slow the push, and
// the click point biases where the front bulges. Losses follow an attrition model on both sides.
// Modifiers: terrain & elevation, rivers, defender density, defense posts, fallout, traitor debuff, world-event
// modifiers, armored divisions (attack boost + spearheads) and defending armor.

import { HUMAN_ID, MAP_H, MAP_W, TILE_COUNT } from '../shared/constants';
import { StructureType } from '../shared/types';
import {
  ARMOR_ATTACK_COST_MUL, ARMOR_ATTACK_LOSS_MUL, ARMOR_DEFENSE_LOSS_MUL, ARMOR_RADIUS, ARMOR_SPEARHEAD_TILES,
  ARMOR_WEAR_PER_TROOP, ATTACK_LOSS_BASE, ATTACK_LOSS_PER_DENSITY, ATTACK_MIN_TROOPS, ATTACK_SPEED_DIV,
  AUTO_EMBARGO_TICKS, DEFENSE_POST_LOSS_MUL, DEFENSE_POST_SPEED_MUL, FALLOUT_COST_MUL, FALLOUT_LOSS_MUL,
  NEUTRAL_COST_SCALE, NEUTRAL_LOSS_DIV, NEUTRAL_MAX_COST, NEUTRAL_MIN_COST, RETREAT_MALUS, TRAITOR_LOSS_MUL,
  TRAITOR_SPEED_MUL, TRIBE_DEFENDER_LOSS_MUL, defensePostRadius, largeTerritoryBonus, terrainCombat,
  type TerrainCombat,
} from './balance';
import type { Game } from './game';
import { neighbors4 } from './game';
import { Attack, Mode, type Player, type Unit } from './state';
import { wdx } from './spatial';

type EndReason = 'exhausted' | 'retreat' | 'defenderEliminated' | 'cancelled';

const MAX_TILES_PER_ATTACK_TICK = 4000;

interface DefensePoint {
  x: number;
  y: number;
  r2: number;
}

export class AttackSystem {
  private readonly tc: TerrainCombat = { mag: 0, cost: 0, prio: 1 };
  private readonly nb = new Int32Array(4);
  private readonly nb2 = new Int32Array(4);
  private readonly dps: DefensePoint[] = [];
  private readonly atkArmor: Unit[] = [];
  private readonly defArmor: Unit[] = [];

  constructor(private readonly g: Game) {}

  // =================================================================================================
  // Commands
  // =================================================================================================
  command(p: Player, target: number, ratio: number, clickTile: number): boolean {
    const g = this.g;
    if (g.phase !== 'playing' || !p.spawned) {
      g.message(p.id, 'msg.notYet');
      return false;
    }
    if (target === p.id) return false;
    const d = target === 0 ? null : g.playerObj(target);
    if (target !== 0 && (!d || !d.alive)) {
      g.message(p.id, 'msg.invalidTarget');
      return false;
    }
    if (target !== 0 && g.isAllied(p.id, target)) {
      g.message(p.id, 'msg.cannotAttackAlly');
      return false;
    }
    if (!g.sharesBorder(p.id, target)) {
      g.message(p.id, target === 0 ? 'msg.noNeutralLand' : 'msg.noBorder');
      return false;
    }
    const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.2;
    let troops = Math.floor(p.troops * r);
    if (troops < 1) {
      g.message(p.id, 'msg.notEnoughTroops');
      return false;
    }
    p.troops -= troops;
    if (target !== 0) this.onHostileAct(p.id, target);

    // Opposing attack (target already attacking us): the two assaults collide and annihilate.
    if (target !== 0) {
      for (const b of g.attackList) {
        if (b.ended || b.naval || b.attacker !== target || b.defender !== p.id) continue;
        const clash = Math.min(b.troops, troops);
        b.troops -= clash;
        troops -= clash;
        p.stats.troopsLost += clash;
        p.stats.troopsKilled += clash;
        if (d) {
          d.stats.troopsLost += clash;
          d.stats.troopsKilled += clash;
        }
        if (b.troops < ATTACK_MIN_TROOPS) this.end(b, 'exhausted', false);
        g.attacksDirty = true;
        if (troops < 1) return true;
      }
    }

    // Reinforce an existing land attack on the same target.
    for (const a of g.attackList) {
      if (a.ended || a.naval || a.attacker !== p.id || a.defender !== target) continue;
      a.troops += troops;
      if (clickTile >= 0) {
        a.clickX = (clickTile % MAP_W) + 0.5;
        a.clickY = Math.floor(clickTile / MAP_W) + 0.5;
      }
      if (a.heap.size === 0) this.seedFromBorder(a);
      g.attacksDirty = true;
      return true;
    }

    const a = new Attack(g.allocId(), p.id, target, troops, false, g.tick, clickTile);
    this.seedFromBorder(a);
    if (a.heap.size === 0) {
      p.troops += troops;
      g.message(p.id, target === 0 ? 'msg.noNeutralLand' : 'msg.noBorder');
      return false;
    }
    g.attackList.push(a);
    g.attacksDirty = true;
    g.emit({ type: 'attackStarted', tick: g.tick, attackId: a.id, attacker: p.id, defender: target, troops: Math.floor(troops), tile: clickTile, naval: false });
    return true;
  }

  retreat(p: Player, attackId: number): boolean {
    const a = this.g.attackList.find((x) => x.id === attackId && x.attacker === p.id && !x.ended);
    if (!a) return false;
    if (a.boatId !== 0) {
      // Still at sea: the transport turns around and brings the troops home.
      return this.g.unitSys.recallBoat(a);
    }
    this.end(a, 'retreat', true);
    return true;
  }

  /** A naval attack whose troops are still at sea (the transport ship carries them). */
  createNaval(p: Player, target: number, troops: number, landingTile: number): Attack {
    const g = this.g;
    const a = new Attack(g.allocId(), p.id, target, troops, true, g.tick, landingTile);
    g.attackList.push(a);
    g.attacksDirty = true;
    if (target !== 0) this.onHostileAct(p.id, target);
    return a;
  }

  /** The transport reached the coast: the troops storm the beach and push inland from there. */
  land(a: Attack, tile: number): void {
    const g = this.g;
    a.boatId = 0;
    const p = g.playerObj(a.attacker);
    if (!p || !p.alive) {
      this.end(a, 'exhausted', false);
      return;
    }
    const o = g.owner[tile];
    if (o === p.id || g.isAllied(p.id, o) || !g.playable[tile]) {
      // Friendly shore: the troops simply disembark into the reserve.
      this.end(a, 'cancelled', true);
      return;
    }
    a.defender = o;
    a.sourceTile = tile;
    const d = g.playerObj(o);
    // Storm the beach tile itself.
    const density = d && d.tiles > 0 ? d.troops / d.tiles : 0;
    const cost = 60 + density;
    if (a.troops <= cost) {
      if (d) {
        const dl = Math.min(d.troops, a.troops * 0.5);
        d.troops -= dl;
        d.stats.troopsLost += dl;
      }
      p.stats.troopsLost += a.troops;
      a.troops = 0;
      this.end(a, 'exhausted', false);
      return;
    }
    a.troops -= cost;
    if (d) {
      const dl = Math.min(d.troops, density);
      d.troops -= dl;
      d.stats.troopsLost += dl;
      p.stats.troopsKilled += dl;
    }
    g.setOwner(tile, p.id);
    a.pushRecent(tile);
    this.addNeighbors(a, tile);
    g.attacksDirty = true;
  }

  /** End every attack of (or against) a player. */
  cancelAllOf(pid: number): void {
    for (const a of this.g.attackList) {
      if (a.ended) continue;
      if (a.attacker === pid) this.end(a, 'cancelled', false);
      else if (a.defender === pid && a.boatId === 0) this.end(a, 'defenderEliminated', true);
    }
  }

  /** Alliance formed: both sides stand down, troops go home. */
  cancelBetween(x: number, y: number): void {
    for (const a of this.g.attackList) {
      if (a.ended || a.boatId !== 0) continue;
      if ((a.attacker === x && a.defender === y) || (a.attacker === y && a.defender === x)) this.end(a, 'cancelled', true);
    }
  }

  /** Records hostility and the automatic trade embargo of the attacked nation. */
  onHostileAct(attacker: number, defender: number): void {
    const g = this.g;
    g.markHostile(attacker, defender);
    const d = g.playerObj(defender);
    const a = g.playerObj(attacker);
    if (!d || !a || d.kind === 'tribe' || a.kind === 'tribe') return;
    const prev = d.tempEmbargo.get(attacker) ?? 0;
    if (prev <= g.tick) d.metaDirty = true;
    d.tempEmbargo.set(attacker, g.tick + AUTO_EMBARGO_TICKS);
  }

  end(a: Attack, reason: EndReason, returnTroops: boolean): void {
    if (a.ended) return;
    const g = this.g;
    a.ended = true;
    const p = g.playerObj(a.attacker);
    if (p && returnTroops && a.troops > 0) {
      let back = a.troops;
      if (reason === 'retreat' && a.defender !== 0) {
        const lost = back * RETREAT_MALUS;
        back -= lost;
        p.stats.troopsLost += lost;
      }
      p.troops += back;
    }
    a.troops = 0;
    g.attacksDirty = true;
    g.emit({ type: 'attackEnded', tick: g.tick, attackId: a.id, attacker: a.attacker, defender: a.defender, reason });
  }

  // =================================================================================================
  // Frontier
  // =================================================================================================
  private seedFromBorder(a: Attack): void {
    const g = this.g;
    const p = g.playerObj(a.attacker);
    if (!p) return;
    a.refreshedAtTick = g.tick;
    for (const t of p.border) this.addNeighbors(a, t);
  }

  /** Queue the defender tiles around `tile` (which the attacker owns). */
  private addNeighbors(a: Attack, tile: number): void {
    const g = this.g;
    const owner = g.owner, playable = g.playable, stamp = g.frontStamp;
    const def = a.defender, atk = a.attacker;
    const nb = this.nb, nb2 = this.nb2;
    const n = neighbors4(tile, nb);
    const rng = g.rngCombat;
    for (let k = 0; k < n; k++) {
      const t = nb[k];
      if (owner[t] !== def || !playable[t] || stamp[t] === a.stamp) continue;
      stamp[t] = a.stamp;
      let mine = 0;
      const m = neighbors4(t, nb2);
      for (let j = 0; j < m; j++) if (owner[nb2[j]] === atk) mine++;
      terrainCombat(g.terrain[t], 0, this.tc);
      let pri = g.tick + (rng.int(8) + 10) * Math.max(0.15, 1 - mine * 0.5 + this.tc.prio / 2);
      if (a.clickX >= 0) {
        const dx = wdx(a.clickX, (t % MAP_W) + 0.5), dy = ((t / MAP_W) | 0) + 0.5 - a.clickY;
        const d = Math.sqrt(dx * dx + dy * dy);
        pri += Math.min(1, d / 90) * 16;
      }
      a.heap.push(t, pri);
      a.frontierSize++;
    }
  }

  private isFrontier(t: number, atk: number, def: number): boolean {
    const g = this.g;
    if (g.owner[t] !== def || !g.playable[t]) return false;
    const nb = this.nb2;
    const n = neighbors4(t, nb);
    for (let k = 0; k < n; k++) if (g.owner[nb[k]] === atk) return true;
    return false;
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  step(): void {
    const g = this.g;
    const list = g.attackList;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.ended || a.boatId !== 0) continue;
      this.stepAttack(a);
    }
    // Compact ended attacks & recompute committed troops.
    let j = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].ended) list[j++] = list[i];
    list.length = j;
    for (const p of g.playerArr) p.attackingTroops = 0;
    for (const a of list) {
      const p = g.playerById[a.attacker];
      if (p) p.attackingTroops += a.troops;
    }
  }

  private stepAttack(a: Attack): void {
    const g = this.g;
    const A = g.playerById[a.attacker];
    if (!A || !A.alive) {
      this.end(a, 'cancelled', false);
      return;
    }
    const neutral = a.defender === 0;
    const D = neutral ? undefined : g.playerById[a.defender];
    if (!neutral) {
      if (!D || !D.alive) {
        this.end(a, 'defenderEliminated', true);
        return;
      }
      if (g.isAllied(a.attacker, a.defender)) {
        this.end(a, 'cancelled', true);
        return;
      }
      g.markHostile(a.attacker, a.defender);
    }
    const tick = g.tick;
    const atkPower = A.mod('attackPower', tick);

    // --- per-tick combat constants ----------------------------------------------------------------
    let lossK = 0, speedK = 0, density = 0;
    if (D) {
      const ratio = D.troops / Math.max(1, a.troops);
      density = D.tiles > 0 ? D.troops / D.tiles : 0;
      const bigAtt = largeTerritoryBonus(A.tiles, 0.7);
      const bigDef = largeTerritoryBonus(D.tiles, 0.3);
      const bigAttSpd = largeTerritoryBonus(A.tiles, 0.73);
      const traitor = D.traitorUntilTick > tick;
      const defPower = D.mod('defensePower', tick);
      lossK = Math.min(2, Math.max(0.6, ratio)) * (ATTACK_LOSS_BASE * bigAtt * bigDef + ATTACK_LOSS_PER_DENSITY * density)
        * (traitor ? TRAITOR_LOSS_MUL : 1) * (D.kind === 'tribe' ? TRIBE_DEFENDER_LOSS_MUL : 1) * defPower / atkPower;
      speedK = (Math.min(7.5, Math.max(0.82, ratio)) * Math.max(1, ratio / 20)) / ATTACK_SPEED_DIV
        * bigAttSpd * bigDef * (traitor ? TRAITOR_SPEED_MUL : 1) * Math.sqrt(defPower / atkPower);
    }
    const neutralLossK = (A.kind === 'tribe' ? 0.5 : 1) / NEUTRAL_LOSS_DIV / atkPower;

    // Defense posts of the defender, and armor of both sides, near this front.
    const dps = this.dps;
    dps.length = 0;
    if (D) {
      for (const s of g.structByOwner.get(D.id) ?? []) {
        if (s.type !== StructureType.DefensePost || !s.operational) continue;
        const r = defensePostRadius(s.level);
        dps.push({ x: s.x, y: s.y, r2: r * r });
      }
    }
    const atkArmor = this.atkArmor, defArmor = this.defArmor;
    atkArmor.length = 0;
    defArmor.length = 0;
    for (const u of g.unitSys.frontArmor(A.id)) if (u.targetPlayer === a.defender || u.targetPlayer < 0) atkArmor.push(u);
    if (D) for (const u of g.unitSys.frontArmor(D.id)) defArmor.push(u);

    const B = Math.max(1, a.frontierSize) + g.rngCombat.int(5);
    let budget = 1;
    let conquered = 0;
    let lossTick = 0;
    const owner = g.owner, terrain = g.terrain, elevation = g.elevation, fallout = g.falloutUntil;
    const tc = this.tc;
    const armorR2 = ARMOR_RADIUS * ARMOR_RADIUS;

    // Armored spearheads punch through first (they bite where the division stands).
    if (atkArmor.length > 0) {
      for (const u of atkArmor) {
        for (let s = 0; s < ARMOR_SPEARHEAD_TILES; s++) {
          const t = this.spearheadTile(u, a.attacker, a.defender);
          if (t < 0) break;
          const loss = this.tileLoss(t, neutral, lossK, neutralLossK, density) * ARMOR_ATTACK_LOSS_MUL;
          if (a.troops <= loss) break;
          a.troops -= loss;
          lossTick += loss;
          u.hp -= loss * ARMOR_WEAR_PER_TROOP * 2;
          this.takeTile(a, A, D, t, loss, density);
          conquered++;
        }
      }
    }

    while (budget > 0 && conquered < MAX_TILES_PER_ATTACK_TICK) {
      if (a.heap.size === 0) {
        if (a.refreshedAtTick !== tick && !a.naval) this.seedFromBorder(a);
        if (a.heap.size === 0) {
          this.end(a, neutral || D === undefined ? 'exhausted' : 'exhausted', true);
          break;
        }
      }
      const t = a.heap.pop();
      a.frontierSize = Math.max(0, a.frontierSize - 1);
      if (g.frontStamp[t] === a.stamp) g.frontStamp[t] = 0;
      if (!this.isFrontier(t, a.attacker, a.defender)) continue;

      terrainCombat(terrain[t], elevation[t], tc);
      let lossMul = 1, costMul = 1;
      if (fallout[t] > tick) {
        lossMul *= FALLOUT_LOSS_MUL;
        costMul *= FALLOUT_COST_MUL;
      }
      const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
      for (let k = 0; k < dps.length; k++) {
        const dx = wdx(dps[k].x, tx), dy = ty - dps[k].y;
        if (dx * dx + dy * dy <= dps[k].r2) {
          lossMul *= DEFENSE_POST_LOSS_MUL;
          costMul *= DEFENSE_POST_SPEED_MUL;
          break;
        }
      }
      let supporting: Unit | null = null;
      for (let k = 0; k < atkArmor.length; k++) {
        const u = atkArmor[k];
        const dx = wdx(u.x, tx), dy = ty - u.y;
        if (dx * dx + dy * dy <= armorR2) {
          supporting = u;
          lossMul *= ARMOR_ATTACK_LOSS_MUL;
          costMul *= ARMOR_ATTACK_COST_MUL;
          break;
        }
      }
      for (let k = 0; k < defArmor.length; k++) {
        const u = defArmor[k];
        const dx = wdx(u.x, tx), dy = ty - u.y;
        if (dx * dx + dy * dy <= armorR2) {
          lossMul *= ARMOR_DEFENSE_LOSS_MUL;
          u.hp -= tc.mag * 0.02;
          break;
        }
      }

      let loss: number, frac: number;
      if (neutral) {
        loss = tc.mag * neutralLossK * lossMul;
        const c = (NEUTRAL_COST_SCALE * tc.cost * costMul) / Math.max(1, a.troops);
        frac = Math.min(NEUTRAL_MAX_COST, Math.max(NEUTRAL_MIN_COST, c)) / (2 * B);
      } else {
        loss = tc.mag * lossK * lossMul;
        frac = (speedK * tc.cost * costMul) / B;
      }
      if (a.troops <= loss) {
        // Not enough left to take this tile: the offensive runs out of steam.
        if (D) {
          const dl = Math.min(D.troops, a.troops * 0.4);
          D.troops -= dl;
          D.stats.troopsLost += dl;
          A.stats.troopsKilled += dl;
        }
        A.stats.troopsLost += a.troops;
        lossTick += a.troops;
        a.troops = 0;
        this.end(a, 'exhausted', false);
        break;
      }
      a.troops -= loss;
      lossTick += loss;
      budget -= frac;
      if (supporting) supporting.hp -= loss * ARMOR_WEAR_PER_TROOP;
      this.takeTile(a, A, D, t, loss, density);
      conquered++;
    }

    a.conqueredThisTick = conquered;
    a.lossThisTick = lossTick;
    a.conquestEma = a.conquestEma * 0.85 + conquered * 0.15;
    a.lossEma = a.lossEma * 0.85 + lossTick * 0.15;
    if (conquered > 0) a.lastActiveTick = tick;
    if (!a.ended && a.troops < ATTACK_MIN_TROOPS) this.end(a, 'exhausted', false);
    if (!a.ended && tick - a.lastActiveTick > 300 && a.heap.size === 0) this.end(a, 'exhausted', true);
  }

  private tileLoss(t: number, neutral: boolean, lossK: number, neutralLossK: number, _density: number): number {
    const g = this.g;
    terrainCombat(g.terrain[t], g.elevation[t], this.tc);
    let m = 1;
    if (g.falloutUntil[t] > g.tick) m *= FALLOUT_LOSS_MUL;
    return this.tc.mag * (neutral ? neutralLossK : lossK) * m;
  }

  private takeTile(a: Attack, A: Player, D: Player | undefined, t: number, loss: number, density: number): void {
    const g = this.g;
    A.stats.troopsLost += loss;
    a.attackerLosses += loss;
    if (D) {
      const dl = Math.min(D.troops, density);
      D.troops -= dl;
      D.stats.troopsLost += dl;
      D.stats.troopsKilled += loss;
      A.stats.troopsKilled += dl;
      a.defenderLosses += dl;
    }
    g.setOwner(t, a.attacker);
    a.pushRecent(t);
    this.addNeighbors(a, t);
  }

  /** Best defender tile for an armored division to punch into (adjacent to the attacker, toward its objective). */
  private spearheadTile(u: Unit, atk: number, def: number): number {
    const g = this.g;
    const cx = Math.floor(u.x), cy = Math.floor(u.y);
    let best = -1, bestD = Infinity;
    const R = 3;
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= MAP_H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const t = y * MAP_W + ((cx + dx + MAP_W) % MAP_W);
        if (!this.isFrontier(t, atk, def)) continue;
        const ex = wdx(u.toX, (t % MAP_W) + 0.5), ey = y + 0.5 - u.toY;
        const d = ex * ex + ey * ey + (dx * dx + dy * dy) * 4;
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
    }
    return best;
  }

  /** Armor at the front without an ongoing offensive launches one (a slice of the reserve follows the tanks). */
  armoredAssault(p: Player, u: Unit, defender: number): void {
    const g = this.g;
    for (const a of g.attackList) {
      if (!a.ended && !a.naval && a.attacker === p.id && a.defender === defender) return;
    }
    if (defender !== 0 && g.isAllied(p.id, defender)) return;
    if (!g.sharesBorder(p.id, defender)) return;
    const share = p.id === HUMAN_ID ? 0.1 : 0.12;
    const troops = Math.max(Math.min(p.troops, 2_000), p.troops * share);
    if (troops < 500) return;
    const tile = Math.floor(u.toY) * MAP_W + Math.floor(u.toX);
    this.command(p, defender, troops / Math.max(1, p.troops), tile >= 0 && tile < TILE_COUNT ? tile : -1);
  }
}

export { Mode };
