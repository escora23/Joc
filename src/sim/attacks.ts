// FRONT ULTRA — offensives (DESIGN_V2 §4.3–§4.11). Owner: sim-core (W1). Worker-only.
//
// An offensive pushes one front toward an axis point (the click) on a CORRIDOR whose width is bought with troops,
// clamp(committed / 20,000, 3, 40) tiles, centred on the ray from the origin (the contact where the axis was set)
// through the axis point. Every frontier tile inside the corridor accumulates pressure each tick,
//
//     p[t] += min(8 km/h, v × armor(t)) × axis(t) × 0.1 h / (extent(t) × terrain(t))
//
// and falls when p passes its threshold θ = 1 + 0.3 (u − 0.5) (u drawn when the tile joins the frontier: speed-neutral
// desynchronisation, nothing carried over). extent(t) is the tile's size along the advance (25 km across a N/S edge,
// 25·cos(lat) km across an E/W edge, the diagonal layer thickness across both), so the depth speed of every part of the
// front is capped at 8 km/h in every direction and at every latitude. The force ratio R = Pa / Pd sets v up to the cap
// (v = 8 × clamp((R − 1) / 2, 0, 1)) and decides casualties; troops never raise the speed above the cap, they buy width.
//
// Caps: at most 3 + ceil(0.04 × frontier) tiles per offensive per tick, a contact phase of 10 ticks, and the per-war
// logistics bucket of the defender (WarSystem). Casualties: engagement E = 0.0005 × min(Pa, Pd) in power units; the
// attacker loses E·√(Pd/Pa)·terrainDefense·fortification, the defender E·√(Pa/Pd), converted to troops by each side's
// power per troop. Two-sided battles: opposing offensives on one front fight one battle (nothing annihilates at launch).
// Stall after 120 ticks at R < 1; the offensive ends (troops home in 20 ticks, 10 % loss) when R < 0.5 for 60 ticks or
// fewer than 10 % of the committed troops remain.
//
// Unclaimed land is taken at 7.5 km/h for a troop cost per tile (no declaration). Independent territories are fought
// with the full model and their own troops, without a declaration; they never attack nations (invariant 7).

import {
  ADVANCE_FULL_RATIO, ADVANCE_MAX_KMH, DEFENSE_REAR_SHARE, ENGAGEMENT_RATE, FRONTAGE_MAX, FRONTAGE_MIN, HUMAN_ID,
  LANDING_COAST_MUL, LANDING_STORM_TICKS, MAP_H, MAP_W, NEUTRAL_ADVANCE_KMH, NEUTRAL_TROOPS_PER_FRONT_TILE,
  OFFENSIVE_BREAK_TICKS, OFFENSIVE_CONTACT_TICKS, OFFENSIVE_RETURN_TICKS, OFFENSIVE_STALL_TICKS, RETREAT_LOSS,
  SIEGE_DEFENSE_MUL, THRESHOLD_JITTER, TILE_COUNT, TILE_KM, TROOPS_PER_FRONT_TILE,
} from '../shared/constants';
import { StructureType, TerrainClass, TerrainFlag, type AttackView } from '../shared/types';
import { NEUTRAL_LOSS_DIV, terrainCombat, type TerrainCombat } from './balance';
import type { Front } from './fronts';
import type { Game } from './game';
import { neighbors4 } from './game';
import { latCos, wdx } from './spatial';
import { Attack, Mode, type Player, type Unit } from './state';

type EndReason = 'exhausted' | 'retreat' | 'defenderEliminated' | 'cancelled';

/** Defense-post zones (§6.2): radius in tiles and the time / casualty multiplier by level. */
const POST_RADIUS = [0, 3, 4.5, 6];
const POST_MUL = [1, 1.5, 1.75, 2];
/** Terrain time multipliers (§4.5) and terrain defense for casualties (§4.6). */
const TERRAIN_TIME = { plains: 1, hills: 1.6, mountains: 2.6 };
const TERRAIN_DEF = { plains: 1, hills: 1.2, mountains: 1.5, urban: 1.4 };

/**
 * The capital district (§4.5): the capital tile and the 8 tiles around it, a city of ~50 km defended street by street.
 * Terrain time ×3 there (the table's "×3 the defender's capital"), so the last stand of a nation takes days.
 */
const CAPITAL_DISTRICT_TIME = 3;
function inCapitalDistrict(t: number, capital: number): boolean {
  let dx = Math.abs((t % MAP_W) - (capital % MAP_W));
  if (dx > MAP_W / 2) dx = MAP_W - dx;
  return dx <= 1 && Math.abs(((t / MAP_W) | 0) - ((capital / MAP_W) | 0)) <= 1;
}

/** Neutral offensives a player may run at once (further clicks reinforce the nearest). */
const MAX_NEUTRAL_OFFENSIVES = 3;
const MAX_PAIR_OFFENSIVES = 3;
/** Full frontier rebuild cadence (incremental updates in between). */
const REBUILD_EVERY = 20;
/** Tiles around the axis ray that get the full axis factor. */
const AXIS_CORE = 3;
const ARMOR_REACH = 3;

interface PostZone {
  x: number;
  y: number;
  r2: number;
  mul: number;
}

export class AttackSystem {
  private readonly byIdMap = new Map<number, Attack>();
  private readonly nb = new Int32Array(4);
  private readonly nb2 = new Int32Array(4);
  private readonly tc: TerrainCombat = { mag: 0, cost: 0, prio: 1 };
  /** Static terrain time multiplier per tile (class, altitude, river), computed once. */
  private readonly terrainTime: Float32Array;
  private readonly terrainDef: Float32Array;
  private readonly posts: PostZone[] = [];
  private readonly atkArmor: Unit[] = [];
  private readonly defArmor: Unit[] = [];
  private readonly ready: number[] = [];
  /** Terrain defense of tiles taken in the last 10 ticks (ring of per-tick sums). */
  private defSum = new Float64Array(10);
  private defN = new Int32Array(10);

  constructor(private readonly g: Game) {
    const n = TILE_COUNT;
    this.terrainTime = new Float32Array(n);
    this.terrainDef = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      const tr = g.terrain[t];
      const c = tr & 0x0f;
      let m = c === TerrainClass.Mountains ? TERRAIN_TIME.mountains : c === TerrainClass.Hills ? TERRAIN_TIME.hills : TERRAIN_TIME.plains;
      if (g.elevation[t] > 3000) m *= 1.5;
      if (tr & TerrainFlag.River) m *= 1.5;
      this.terrainTime[t] = m;
      this.terrainDef[t] = c === TerrainClass.Mountains ? TERRAIN_DEF.mountains : c === TerrainClass.Hills ? TERRAIN_DEF.hills : TERRAIN_DEF.plains;
    }
  }

  // =================================================================================================
  // Queries
  // =================================================================================================
  byId(id: number): Attack | undefined {
    return this.byIdMap.get(id);
  }

  isActive(id: number): boolean {
    const a = this.byIdMap.get(id);
    return !!a && !a.ended && a.returnAt < 0 && a.boatId === 0 && this.g.tick >= a.contactUntil;
  }

  activeBetween(x: number, y: number): boolean {
    for (const a of this.g.attackList) {
      if (a.ended) continue;
      if ((a.attacker === x && a.defender === y) || (a.attacker === y && a.defender === x)) return true;
    }
    return false;
  }

  /** Attached divisions of `p` near a front (v2-stub(W1→W4): v1 frontArmor lists). */
  divisionsNear(p: number, f: Front): number {
    let n = 0;
    for (const u of this.g.unitSys.frontArmor(p)) {
      for (let i = 0; i < f.samples.length; i += 2) {
        const dx = wdx(u.x, f.samples[i]), dy = f.samples[i + 1] - u.y;
        if (dx * dx + dy * dy <= 16) {
          n++;
          break;
        }
      }
    }
    return n;
  }

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
    if (d) {
      // Independent territories never attack a nation or the human (§4.10, invariant 7).
      if (p.kind === 'tribe' && d.kind !== 'tribe') return false;
      if (d.kind !== 'tribe') {
        if (g.isAllied(p.id, target)) {
          g.message(p.id, 'msg.cannotAttackAlly');
          return false;
        }
        if (!g.war.atWar(p.id, target)) {
          g.message(p.id, 'msg.notAtWar');
          return false;
        }
        // An aggressor still mobilizing: the order is queued and starts by itself when the mobilization ends.
        if (g.war.mobilizingUntil(p.id, target) > 0) {
          g.war.queue(p.id, target, clickTile, ratio, false);
          g.message(p.id, 'msg.mobilizing', 'info');
          return true;
        }
      }
    }
    if (!g.sharesBorder(p.id, target)) {
      g.message(p.id, target === 0 ? 'msg.noNeutralLand' : 'msg.noBorder');
      return false;
    }
    const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.2;
    const troops = Math.floor(p.troops * r);
    if (troops < 1) {
      g.message(p.id, 'msg.notEnoughTroops');
      return false;
    }
    // A second click on the same front reinforces the offensive and moves its axis (§4.3).
    const existing = this.offensiveNear(p.id, target, clickTile);
    if (existing) {
      p.troops -= troops;
      existing.troops += troops;
      existing.committed += troops;
      if (clickTile >= 0) this.setAxis(existing, clickTile);
      if (existing.returnAt >= 0) {
        existing.returnAt = -1;
        existing.lowTicks = existing.breakTicks = 0;
      }
      g.attacksDirty = true;
      return true;
    }
    const a = new Attack(g.allocId(), p.id, target, troops, false, g.tick, clickTile);
    a.contactUntil = g.tick + OFFENSIVE_CONTACT_TICKS;
    a.state = 'contact';
    if (!this.setAxis(a, clickTile)) {
      g.message(p.id, target === 0 ? 'msg.noNeutralLand' : 'msg.noBorder');
      return false;
    }
    p.troops -= troops;
    this.register(a);
    this.resolveFront(a);
    this.rebuildFrontier(a);
    g.emit({
      type: 'attackStarted', tick: g.tick, attackId: a.id, attacker: p.id, defender: target, troops, tile: clickTile,
      naval: false, frontKey: a.frontKey, x: a.clickX, y: a.clickY,
    });
    g.invariants?.onOffensiveStart(a);
    return true;
  }

  private register(a: Attack): void {
    this.g.attackList.push(a);
    this.byIdMap.set(a.id, a);
    this.g.attacksDirty = true;
  }

  /** The front an offensive pushes on, and the opposing offensive on it (two-sided battle). */
  private resolveFront(a: Attack): void {
    const g = this.g;
    const D = g.playerObj(a.defender);
    if (!D || D.kind === 'tribe' || a.defender === 0) return;
    const f = g.fronts.frontAt(a.attacker, a.defender, a.originX, a.originY);
    a.frontKey = f?.key ?? 0;
    if (f) f.offensive[f.a === a.attacker ? 0 : 1] = a.id;
    a.counterId = 0;
    for (const o of g.attackList) {
      if (o.ended || o === a || o.attacker !== a.defender || o.defender !== a.attacker || o.frontKey !== a.frontKey || !a.frontKey) continue;
      a.counterId = o.id;
      o.counterId = a.id;
    }
  }

  private offensiveNear(attacker: number, target: number, clickTile: number): Attack | null {
    const g = this.g;
    const list = g.attackList.filter((x) => !x.ended && !x.naval && x.attacker === attacker && x.defender === target);
    if (list.length === 0) return null;
    const cx = clickTile >= 0 ? (clickTile % MAP_W) + 0.5 : list[0].clickX, cy = clickTile >= 0 ? Math.floor(clickTile / MAP_W) + 0.5 : list[0].clickY;
    const D = g.playerObj(target);
    if (D && D.kind !== 'tribe') {
      const f = g.fronts.frontAt(attacker, target, cx, cy);
      if (f) {
        const same = list.find((x) => x.frontKey === f.key);
        if (same) return same;
      }
    }
    let best: Attack | null = null, bd = Infinity;
    for (const x of list) {
      const dx = wdx(cx, x.originX), dy = x.originY - cy;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = x;
      }
    }
    const cap = target === 0 || (D && D.kind === 'tribe') ? MAX_NEUTRAL_OFFENSIVES : MAX_PAIR_OFFENSIVES;
    const near = best && bd <= Math.max(20, best.frontage) ** 2;
    return near || list.length >= cap ? best : null;
  }

  /**
   * Set the corridor: origin = centroid of the attacker's contact tiles near the contact point closest to the click,
   * direction = toward the click (the local outward normal when the click is on the border itself or sideways).
   */
  private setAxis(a: Attack, clickTile: number): boolean {
    const g = this.g;
    const A = g.playerById[a.attacker];
    if (!A) return false;
    const def = a.defender;
    const owner = g.owner, nb = this.nb;
    let cx = clickTile >= 0 ? (clickTile % MAP_W) + 0.5 : -1, cy = clickTile >= 0 ? Math.floor(clickTile / MAP_W) + 0.5 : -1;
    // Nearest contact tile to the click (or any contact tile without a click).
    let c0 = -1, bd = Infinity;
    for (const t of A.border) {
      const n = neighbors4(t, nb);
      let touch = false;
      for (let k = 0; k < n; k++) if (owner[nb[k]] === def && g.playable[nb[k]]) {
        touch = true;
        break;
      }
      if (!touch) continue;
      if (cx < 0) {
        c0 = t;
        break;
      }
      const dx = wdx(cx, (t % MAP_W) + 0.5), dy = ((t / MAP_W) | 0) + 0.5 - cy;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        c0 = t;
      }
    }
    if (c0 < 0) return false;
    const x0 = (c0 % MAP_W) + 0.5, y0 = ((c0 / MAP_W) | 0) + 0.5;
    if (cx < 0) {
      cx = x0;
      cy = y0;
    }
    // Local contact centroid and outward normal (radius 12 tiles around c0).
    let sx = 0, sy = 0, sn = 0, nx = 0, ny = 0;
    for (const t of A.border) {
      const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
      const ex = wdx(x0, tx), ey = ty - y0;
      if (ex * ex + ey * ey > 144) continue;
      const n = neighbors4(t, nb);
      let touch = false;
      for (let k = 0; k < n; k++) {
        const q = nb[k];
        if (owner[q] !== def || !g.playable[q]) continue;
        touch = true;
        nx += wdx(tx, (q % MAP_W) + 0.5);
        ny += ((q / MAP_W) | 0) + 0.5 - ty;
      }
      if (!touch) continue;
      sx += ex;
      sy += ey;
      sn++;
    }
    const ox = x0 + (sn ? sx / sn : 0), oy = y0 + (sn ? sy / sn : 0);
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    let dx = wdx(ox, cx), dy = cy - oy;
    const dl = Math.hypot(dx, dy);
    if (dl < 4 || (dx * nx + dy * ny) / Math.max(1e-6, dl) < 0.2) {
      dx = nx;
      dy = ny;
    } else {
      dx /= dl;
      dy /= dl;
    }
    if (!Number.isFinite(dx) || (dx === 0 && dy === 0)) {
      dx = 0;
      dy = 1;
    }
    a.originX = ((ox % MAP_W) + MAP_W) % MAP_W;
    a.originY = oy;
    a.dirX = dx;
    a.dirY = dy;
    a.clickX = cx;
    a.clickY = cy;
    a.frontage = this.frontageOf(a);
    a.frontierDirty = true;
    return true;
  }

  private frontageOf(a: Attack): number {
    const per = a.defender === 0 ? NEUTRAL_TROOPS_PER_FRONT_TILE : TROOPS_PER_FRONT_TILE;
    return Math.min(FRONTAGE_MAX, Math.max(FRONTAGE_MIN, a.troops / per));
  }

  /** Is tile t (tile coords of its centre) inside the corridor? Returns the perpendicular distance, or -1. */
  private corridor(a: Attack, t: number): number {
    const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
    const rx = wdx(a.originX, tx), ry = ty - a.originY;
    const along = rx * a.dirX + ry * a.dirY;
    const half = a.frontage / 2;
    if (along < -half) return -1;
    const perp = Math.abs(rx * a.dirY - ry * a.dirX);
    return perp <= half ? perp : -1;
  }

  /**
   * Does attacker tile `from` push on defender tile `t` along the offensive's axis? An offensive advances toward its
   * axis point (§4.3): it presses the tiles in front of it and on its flanks, never a tile from the far side (that is
   * another army's front). On a straight front every contact qualifies; around an encircled pocket only the side the
   * offensive comes from does, so a pocket is taken by advancing through it, not peeled from every side at once.
   * Neutral land keeps the free expansion of the land race.
   */
  private pushesFrom(a: Attack, t: number, from: number): boolean {
    if (a.defender === 0) return true;
    const ex = wdx((t % MAP_W) + 0.5, (from % MAP_W) + 0.5), ey = ((from / MAP_W) | 0) - ((t / MAP_W) | 0);
    return ex * a.dirX + ey * a.dirY <= 0.05;
  }

  /** Full rebuild of the corridor's frontier (defender tiles touching the attacker inside the corridor). */
  private rebuildFrontier(a: Attack): void {
    const g = this.g;
    a.frontierDirty = false;
    a.lastRebuildTick = g.tick;
    const A = g.playerById[a.attacker];
    if (!A) return;
    const def = a.defender, owner = g.owner, nb = this.nb;
    const keep = new Set<number>();
    let anyInCorridor = -1;
    if (a.sourceTile >= 0 && a.state === 'landing') {
      // Storming the beach: the landing tile is the whole front until it falls.
      if (owner[a.sourceTile] === def) keep.add(a.sourceTile);
    } else {
      for (const t of A.border) {
        const n = neighbors4(t, nb);
        for (let k = 0; k < n; k++) {
          const q = nb[k];
          if (owner[q] !== def || !g.playable[q] || keep.has(q)) continue;
          if (this.corridor(a, q) < 0) continue;
          anyInCorridor = q;
          if (!this.pushesFrom(a, q, t)) continue;
          keep.add(q);
        }
      }
      // A corridor whose every contact faces backwards (an axis drawn across a salient): it pushes where it touches.
      if (keep.size === 0 && anyInCorridor >= 0) {
        for (const t of A.border) {
          const n = neighbors4(t, nb);
          for (let k = 0; k < n; k++) {
            const q = nb[k];
            if (owner[q] === def && g.playable[q] && this.corridor(a, q) >= 0) keep.add(q);
          }
        }
      }
    }
    for (const t of [...a.pressure.keys()]) {
      if (!keep.has(t)) {
        a.pressure.delete(t);
        a.theta.delete(t);
      }
    }
    for (const t of keep) if (!a.pressure.has(t)) this.addFrontier(a, t);
  }

  private addFrontier(a: Attack, t: number): void {
    a.pressure.set(t, 0);
    a.theta.set(t, 1 + THRESHOLD_JITTER * (this.g.rngFront.next() - 0.5));
  }

  retreat(p: Player, attackId: number): boolean {
    const a = this.byIdMap.get(attackId);
    if (!a || a.ended || a.attacker !== p.id) return false;
    if (a.boatId !== 0) return this.g.unitSys.recallBoat(a);
    this.startRetreat(a);
    return true;
  }

  /** Survivors return home after 20 ticks with a 10 % loss (§4.9). */
  private startRetreat(a: Attack): void {
    const g = this.g;
    if (a.returnAt >= 0) return;
    a.returnAt = g.tick + OFFENSIVE_RETURN_TICKS;
    a.state = 'retreating';
    a.pressure.clear();
    a.theta.clear();
    g.attacksDirty = true;
    g.emit({ type: 'offensive', tick: g.tick, attackId: a.id, attacker: a.attacker, defender: a.defender, stage: 'retreating', x: a.clickX, y: a.clickY, ratio: +a.ratio.toFixed(2) });
    if (a.attacker === HUMAN_ID && a.defender > 0) g.message(HUMAN_ID, 'msg.offensiveRetreating', 'info', { player: a.defender });
  }

  /** A naval attack whose troops are still at sea (the transport convoy carries them, §4.11). */
  createNaval(p: Player, target: number, troops: number, landingTile: number): Attack {
    const g = this.g;
    const a = new Attack(g.allocId(), p.id, target, troops, true, g.tick, landingTile);
    a.state = 'embarking';
    this.register(a);
    return a;
  }

  /** The convoy reached the coast: the troops storm the beach (2 h × coastal defense), then push inland. */
  land(a: Attack, tile: number): void {
    const g = this.g;
    a.boatId = 0;
    const p = g.playerObj(a.attacker);
    if (!p || !p.alive) {
      this.end(a, 'exhausted', false);
      return;
    }
    const o = g.owner[tile];
    const D = g.playerObj(o);
    if (o === p.id || g.isAllied(p.id, o) || !g.playable[tile] || (D && D.kind !== 'tribe' && (!g.war.atWar(p.id, o) || g.war.mobilizingUntil(p.id, o) > 0))) {
      // Friendly (or no longer hostile) shore, or an enemy we are still mobilizing against (invariant 4: no offensive
      // before the mobilization ends): the troops do not storm it and go back to the reserve.
      this.end(a, 'cancelled', true);
      return;
    }
    a.defender = o;
    a.sourceTile = tile;
    a.state = 'landing';
    a.storm = 0;
    a.startTick = g.tick;
    a.contactUntil = g.tick;
    a.originX = (tile % MAP_W) + 0.5;
    a.originY = ((tile / MAP_W) | 0) + 0.5;
    a.frontage = this.frontageOf(a);
    this.rebuildFrontier(a);
    g.attacksDirty = true;
    g.invariants?.onOffensiveStart(a);
  }

  /** End every attack of (or against) a player. */
  cancelAllOf(pid: number): void {
    for (const a of this.g.attackList) {
      if (a.ended) continue;
      if (a.attacker === pid) this.end(a, 'cancelled', false);
      else if (a.defender === pid && a.boatId === 0) this.end(a, 'defenderEliminated', true);
    }
  }

  /** Peace (or an alliance): both sides stand down, troops go home. Convoys at sea turn back. */
  endBetween(x: number, y: number): void {
    for (const a of this.g.attackList) {
      if (a.ended) continue;
      if (!((a.attacker === x && a.defender === y) || (a.attacker === y && a.defender === x))) continue;
      if (a.boatId !== 0) this.g.unitSys.recallBoat(a);
      else this.end(a, 'cancelled', true);
    }
  }

  /** Kept for callers of the v1 API (alliances). */
  cancelBetween(x: number, y: number): void {
    this.endBetween(x, y);
  }

  end(a: Attack, reason: EndReason, returnTroops: boolean): void {
    if (a.ended) return;
    const g = this.g;
    a.ended = true;
    const p = g.playerObj(a.attacker);
    if (p && returnTroops && a.troops > 0) p.troops += a.troops;
    a.troops = 0;
    a.pressure.clear();
    a.theta.clear();
    this.byIdMap.delete(a.id);
    g.attacksDirty = true;
    g.emit({ type: 'attackEnded', tick: g.tick, attackId: a.id, attacker: a.attacker, defender: a.defender, reason });
    if (a.defender > 0 && a.attacker > 0) {
      g.emit({ type: 'offensive', tick: g.tick, attackId: a.id, attacker: a.attacker, defender: a.defender, stage: 'ended', x: a.clickX, y: a.clickY, ratio: +a.ratio.toFixed(2) });
    }
  }

  /** Records hostility (bookkeeping for independent territories; wars are explicit). */
  onHostileAct(attacker: number, defender: number): void {
    this.g.markHostile(attacker, defender);
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  step(): void {
    const g = this.g;
    const slot = g.tick % 10;
    this.defSum[slot] = 0;
    this.defN[slot] = 0;
    const list = g.attackList;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.ended) continue;
      if (a.boatId !== 0) continue; // at sea: the convoy (units.ts) drives the state
      this.stepOffensive(a);
    }
    let j = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].ended) list[j++] = list[i];
    list.length = j;
    for (const p of g.playerArr) p.attackingTroops = 0;
    for (const a of list) {
      const p = g.playerById[a.attacker];
      if (p) p.attackingTroops += a.troops;
    }
  }

  private stepOffensive(a: Attack): void {
    const g = this.g;
    const tick = g.tick;
    const A = g.playerById[a.attacker];
    if (!A || !A.alive) {
      this.end(a, 'cancelled', false);
      return;
    }
    a.conqueredThisTick = 0;
    a.lossThisTick = 0;
    a.consolidating = false;
    // Retreat in progress: the column is on its way home.
    if (a.returnAt >= 0) {
      a.state = 'retreating';
      if (tick >= a.returnAt) {
        const lost = a.troops * RETREAT_LOSS;
        A.stats.troopsLost += lost;
        a.troops -= lost;
        this.end(a, 'retreat', true);
      }
      return;
    }
    const neutral = a.defender === 0;
    const D = neutral ? undefined : g.playerById[a.defender];
    if (!neutral) {
      if (!D || !D.alive || D.tiles === 0) {
        this.end(a, 'defenderEliminated', true);
        return;
      }
      if (D.kind !== 'tribe' && !g.war.atWar(a.attacker, a.defender)) {
        this.end(a, 'cancelled', true);
        return;
      }
    }
    const tribeDef = !!D && D.kind === 'tribe';
    // Corridor width follows the committed troops; the frontier is rebuilt when it changes and periodically.
    const fr = this.frontageOf(a);
    if (Math.abs(fr - a.frontage) >= 1) {
      a.frontage = fr;
      a.frontierDirty = true;
    }
    if (a.frontierDirty || tick - a.lastRebuildTick >= REBUILD_EVERY || a.pressure.size === 0) this.rebuildFrontier(a);
    if (a.pressure.size === 0) {
      this.end(a, neutral ? 'exhausted' : 'cancelled', true);
      return;
    }
    if (!neutral && !tribeDef && tick % 5 === 0) this.resolveFrontKeepCounter(a);
    // Contact phase: the troops move up to the line.
    if (tick < a.contactUntil) {
      a.state = 'contact';
      return;
    }
    const landing = a.state === 'landing';
    // --- forces (§4.4) ---------------------------------------------------------------------------------
    const atkPower = A.mod('attackPower', tick);
    this.collectArmor(a, A, D);
    let v: number, Pa = 0, Pd = 0, garrison = 0, counterTroops = 0, counter: Attack | undefined;
    if (neutral || !D) {
      v = NEUTRAL_ADVANCE_KMH;
      a.ratio = 0;
    } else {
      const armorA = Math.min(2, 1 + 0.25 * this.atkArmor.length);
      const armorD = Math.min(2, 1 + 0.25 * this.defArmor.length);
      Pa = a.troops * atkPower * armorA;
      if (tribeDef) {
        let n = 0;
        for (const o of g.attackList) if (!o.ended && o.defender === D.id && o.boatId === 0) n++;
        garrison = D.troops * (1 - DEFENSE_REAR_SHARE) / Math.max(1, n);
      } else if (landing) {
        // A surprise landing meets the thin coastal watch until the garrison redeploys (§4.4, §4.11).
        const f = g.fronts.frontsOf(D.id);
        garrison = f.length === 0 ? D.troops * (1 - DEFENSE_REAR_SHARE) * 0.1 : D.troops * (1 - DEFENSE_REAR_SHARE) * 0.05;
      } else {
        const f = a.frontKey ? g.fronts.get(a.frontKey) : undefined;
        garrison = f ? g.fronts.garrison(f, D.id) : D.troops * (1 - DEFENSE_REAR_SHARE) * 0.5;
      }
      counter = a.counterId ? this.byIdMap.get(a.counterId) : undefined;
      if (counter && (counter.ended || counter.returnAt >= 0 || counter.frontKey !== a.frontKey)) counter = undefined;
      // Two-sided battle (§4.8): the troops of the offensive launched first defend at half weight (they are on the attack).
      counterTroops = counter ? counter.troops * (counter.id < a.id ? 0.5 : 1) : 0;
      const traitor = D.traitorUntilTick > tick ? 0.75 : 1;
      const siege = g.enclaves.besiegedFront(D.id, a) ? SIEGE_DEFENSE_MUL : 1;
      Pd = (garrison + counterTroops) * D.mod('defensePower', tick) * armorD * traitor * siege;
      const R = Pa / Math.max(1, Pd);
      a.ratio = R;
      v = ADVANCE_MAX_KMH * Math.min(1, Math.max(0, (R - 1) / (ADVANCE_FULL_RATIO - 1)));
    }
    a.pa = Pa;
    a.pd = Pd;
    // --- pressure (§4.5) -------------------------------------------------------------------------------
    const owner = g.owner, nb = this.nb;
    const att = a.attacker, def = a.defender;
    const capital = D ? D.capitalTile : -1;
    const ready = this.ready;
    ready.length = 0;
    let fortSum = 0, fortN = 0;
    for (const [t, p0] of a.pressure) {
      // Lazy validation: still the defender's, still touching the attacker.
      if (owner[t] !== def) {
        a.pressure.delete(t);
        a.theta.delete(t);
        continue;
      }
      const n = neighbors4(t, nb);
      let ns = false, ew = false;
      for (let k = 0; k < n; k++) {
        if (owner[nb[k]] !== att) continue;
        const q = nb[k];
        if (q === t - MAP_W || q === t + MAP_W) ns = true;
        else ew = true;
      }
      if (!ns && !ew && !(landing && t === a.sourceTile)) {
        a.pressure.delete(t);
        a.theta.delete(t);
        continue;
      }
      const y = ((t / MAP_W) | 0) + 0.5;
      const H = TILE_KM, W = TILE_KM * latCos(y);
      const extent = ns && !ew ? H : ew && !ns ? W : (H * W) / Math.sqrt(H * H + W * W);
      const post = D ? this.postMul(t) : 1;
      fortSum += post;
      fortN++;
      let inc: number;
      if (landing && t === a.sourceTile) {
        // Storming the beach: 2 h of pressure × coastal defense (× defense post) at the full rate.
        inc = (v / ADVANCE_MAX_KMH) / (LANDING_STORM_TICKS * LANDING_COAST_MUL * post);
      } else {
        let terrain = this.terrainTime[t];
        if (D) {
          if (g.structAt[t] !== 0) terrain *= 2;
          terrain *= post;
          if (capital >= 0 && inCapitalDistrict(t, capital)) terrain *= CAPITAL_DISTRICT_TIME;
          if (this.defArmor.length && this.nearUnit(this.defArmor, t)) terrain *= 1.4;
        }
        if (g.falloutUntil[t] > tick) terrain *= 2;
        const armor = this.atkArmor.length && this.nearUnit(this.atkArmor, t) ? 1.5 : 1;
        const perp = this.corridor(a, t);
        const axis = perp < 0 ? 0.8 : perp <= AXIS_CORE ? 1 : 0.8;
        inc = (Math.min(ADVANCE_MAX_KMH, v * armor) * axis * 0.1) / (extent * terrain);
      }
      const p = p0 + inc;
      a.pressure.set(t, p);
      if (p >= a.theta.get(t)!) ready.push(t);
    }
    // --- casualties (§4.6) -----------------------------------------------------------------------------
    let lostA = 0, lostD = 0;
    if (D && Pa > 0 && Pd > 0 && a.pressure.size > 0 && !(counter && counter.id < a.id)) {
      const E = ENGAGEMENT_RATE * Math.min(Pa, Pd);
      const fort = fortN ? fortSum / fortN : 1;
      const atkPowLoss = E * Math.sqrt(Pd / Pa) * this.recentTerrainDefense() * fort;
      const defPowLoss = E * Math.sqrt(Pa / Pd);
      lostA = Math.min(a.troops, (atkPowLoss * a.troops) / Pa);
      const defTroops = garrison + counterTroops;
      const defLoss = (defPowLoss * defTroops) / Pd;
      const toCounter = counter ? defLoss * (counterTroops / Math.max(1, defTroops)) : 0;
      const toGarrison = Math.min(D.troops, defLoss - toCounter);
      if (counter) counter.troops = Math.max(0, counter.troops - toCounter);
      lostD = toGarrison + toCounter;
      a.troops -= lostA;
      D.troops -= toGarrison;
      A.stats.troopsLost += lostA;
      A.stats.troopsKilled += lostD;
      D.stats.troopsLost += lostD;
      D.stats.troopsKilled += lostA;
      a.attackerLosses += lostA;
      a.defenderLosses += lostD;
      g.war.addCasualties(att, def, lostA, lostD);
    }
    a.lossThisTick = lostA + lostD;
    // --- captures under the caps (§4.5) --------------------------------------------------------------
    if (ready.length) {
      ready.sort((x, y) => (a.pressure.get(y)! - a.theta.get(y)!) - (a.pressure.get(x)! - a.theta.get(x)!) || x - y);
      const cap = 3 + Math.ceil(0.04 * a.pressure.size);
      const warBound = !!D && !tribeDef;
      let areaKm2 = 0;
      for (let i = 0; i < ready.length && a.conqueredThisTick < cap; i++) {
        const t = ready[i];
        if (owner[t] !== def || g.flipTick[t] === tick) continue;
        if (warBound && g.war.logistics(att, def) < 1) {
          a.consolidating = true;
          break;
        }
        if (neutral || tribeDef) {
          const cost = this.neutralCost(A, t);
          if (neutral && a.troops <= cost) {
            this.end(a, 'exhausted', true);
            break;
          }
          if (neutral) {
            a.troops -= cost;
            A.stats.troopsLost += cost;
          }
        }
        areaKm2 += this.take(a, A, D, t);
        if (landing && t === a.sourceTile) this.beachhead(a);
        // Mop-up of notches left behind (inside the corridor, same caps).
        this.mopUp(a, A, D, t, cap);
      }
      g.invariants?.onCaptures(a, a.conqueredThisTick, cap);
      if (areaKm2 > 0) {
        const W = TILE_KM * latCos(a.originY), H = TILE_KM;
        const widthKm = a.frontage * Math.sqrt((a.dirY * W) ** 2 + (a.dirX * H) ** 2);
        a.advanceKmh = a.advanceKmh * 0.9 + 0.1 * ((10 * areaKm2) / Math.max(1, widthKm));
      } else a.advanceKmh *= 0.9;
    } else a.advanceKmh *= 0.9;
    if (a.ended) return;
    a.conquestEma = a.conquestEma * 0.85 + a.conqueredThisTick * 0.15;
    a.lossEma = a.lossEma * 0.85 + a.lossThisTick * 0.15;
    if (a.conqueredThisTick > 0) a.lastActiveTick = tick;
    g.fronts.noteOffensive(a, lostA, lostD);
    // --- state, stall and break (§4.9) -----------------------------------------------------------------
    if (a.state === 'landing' && a.sourceTile >= 0 && owner[a.sourceTile] !== att) a.state = 'landing';
    else if (a.consolidating) a.state = 'consolidating';
    else if (a.state !== 'landing') a.state = a.stalled ? 'stalled' : 'advancing';
    if (!neutral) {
      const R = a.ratio;
      if (R < 1) a.lowTicks++;
      else {
        if (a.stalled) {
          a.stalled = false;
          g.emit({ type: 'offensive', tick, attackId: a.id, attacker: att, defender: def, stage: 'resumed', x: a.clickX, y: a.clickY, ratio: +R.toFixed(2) });
        }
        a.lowTicks = 0;
      }
      if (!a.stalled && a.lowTicks >= OFFENSIVE_STALL_TICKS) {
        a.stalled = true;
        a.state = 'stalled';
        g.emit({ type: 'offensive', tick, attackId: a.id, attacker: att, defender: def, stage: 'stalled', x: a.clickX, y: a.clickY, ratio: +R.toFixed(2) });
      }
      a.breakTicks = R < 0.5 ? a.breakTicks + 1 : 0;
      if (a.breakTicks >= OFFENSIVE_BREAK_TICKS || a.troops < a.committed * 0.1) this.startRetreat(a);
    }
    if (a.troops < 1 && !a.ended) this.end(a, 'exhausted', false);
  }

  /** Keep the front key current (fronts re-cluster) and relink the opposing offensive. */
  private resolveFrontKeepCounter(a: Attack): void {
    const f = this.g.fronts.frontAt(a.attacker, a.defender, a.originX, a.originY);
    if (f && f.key !== a.frontKey) this.resolveFront(a);
    else if (f) f.offensive[f.a === a.attacker ? 0 : 1] = a.id;
  }

  /** The beach fell: the offensive continues inland as a normal front from the landing tile toward the click. */
  private beachhead(a: Attack): void {
    a.state = 'advancing';
    const cx = a.clickX, cy = a.clickY;
    let dx = wdx(a.originX, cx), dy = cy - a.originY;
    const dl = Math.hypot(dx, dy);
    if (dl < 3) {
      // Aim inland: away from the sea (average direction to the defender's neighbours).
      const nb = this.nb;
      const n = neighbors4(a.sourceTile, nb);
      dx = 0;
      dy = 0;
      for (let k = 0; k < n; k++) {
        if (this.g.owner[nb[k]] !== a.defender) continue;
        dx += wdx(a.originX, (nb[k] % MAP_W) + 0.5);
        dy += ((nb[k] / MAP_W) | 0) + 0.5 - a.originY;
      }
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      if (dx === 0 && dy === 0) dy = 1;
    } else {
      dx /= dl;
      dy /= dl;
    }
    a.dirX = dx;
    a.dirY = dy;
    a.frontierDirty = true;
    this.resolveFront(a);
  }

  private neutralCost(A: Player, t: number): number {
    terrainCombat(this.g.terrain[t], this.g.elevation[t], this.tc);
    return (this.tc.mag * (A.kind === 'tribe' ? 0.5 : 1)) / NEUTRAL_LOSS_DIV / A.mod('attackPower', this.g.tick);
  }

  /** Transfer one tile to the attacker and grow the frontier around it. Returns the tile's area (km²). */
  private take(a: Attack, A: Player, D: Player | undefined, t: number): number {
    const g = this.g;
    g.transferContext = 'attack';
    g.setOwner(t, a.attacker);
    g.transferContext = 'none';
    a.pressure.delete(t);
    a.theta.delete(t);
    a.pushRecent(t);
    a.conqueredThisTick++;
    a.tilesTaken++;
    if (D && D.kind !== 'tribe') g.war.consumeLogistics(a.attacker, a.defender);
    const slot = g.tick % 10;
    this.defSum[slot] += g.structAt[t] !== 0 ? TERRAIN_DEF.urban : this.terrainDef[t];
    this.defN[slot]++;
    // New frontier tiles behind the one that fell.
    const nb = this.nb2;
    const n = neighbors4(t, nb);
    for (let k = 0; k < n; k++) {
      const q = nb[k];
      if (g.owner[q] !== a.defender || !g.playable[q] || a.pressure.has(q)) continue;
      if (this.corridor(a, q) < 0 || !this.pushesFrom(a, q, t)) continue;
      this.addFrontier(a, q);
    }
    if (D && a.counterId) {
      const c = this.byIdMap.get(a.counterId);
      if (c) c.tilesLost++;
    }
    const y = ((t / MAP_W) | 0) + 0.5;
    return TILE_KM * TILE_KM * latCos(y);
  }

  /** A defender tile left with 3+ attacker neighbours (a notch) falls with the tile just taken, under the caps. */
  private mopUp(a: Attack, A: Player, D: Player | undefined, t: number, cap: number): void {
    const g = this.g;
    const owner = g.owner, playable = g.playable;
    const nb = this.nb2;
    const around: number[] = [];
    const n = neighbors4(t, nb);
    for (let k = 0; k < n; k++) around.push(nb[k]);
    for (const q of around) {
      if (a.conqueredThisTick >= cap || a.ended) return;
      if (owner[q] !== a.defender || !playable[q] || g.structAt[q] !== 0 || g.flipTick[q] === g.tick) continue;
      if (D && D.capitalTile >= 0 && inCapitalDistrict(q, D.capitalTile)) continue;
      if (this.corridor(a, q) < 0) continue;
      let mine = 0, other = 0;
      const m = neighbors4(q, this.nb);
      for (let j = 0; j < m; j++) {
        const o = owner[this.nb[j]];
        if (o === a.attacker) mine++;
        else if (o !== a.defender && playable[this.nb[j]]) other++;
      }
      if (mine < 3 || other > 0) continue;
      if (D && D.kind !== 'tribe' && g.war.logistics(a.attacker, a.defender) < 1) return;
      if (!D) {
        const cost = this.neutralCost(A, q);
        if (a.troops <= cost) return;
        a.troops -= cost;
      }
      this.take(a, A, D, q);
    }
  }

  private recentTerrainDefense(): number {
    let s = 0, n = 0;
    for (let i = 0; i < 10; i++) {
      s += this.defSum[i];
      n += this.defN[i];
    }
    return n > 0 ? s / n : 1;
  }

  /** Defense-post multiplier at tile t (the defender's posts, §6.2). */
  private postMul(t: number): number {
    const posts = this.posts;
    if (posts.length === 0) return 1;
    const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
    let m = 1;
    for (let k = 0; k < posts.length; k++) {
      const dx = wdx(posts[k].x, tx) * latCos(ty), dy = ty - posts[k].y;
      if (dx * dx + dy * dy <= posts[k].r2 && posts[k].mul > m) m = posts[k].mul;
    }
    return m;
  }

  /** Attached divisions near this offensive (v2-stub(W1→W4): v1 frontArmor lists) and the defender's posts. */
  private collectArmor(a: Attack, A: Player, D: Player | undefined): void {
    const g = this.g;
    const atk = this.atkArmor, dfn = this.defArmor;
    atk.length = 0;
    dfn.length = 0;
    this.posts.length = 0;
    if (!D) return;
    const reach = a.frontage / 2 + ARMOR_REACH;
    for (const u of g.unitSys.frontArmor(A.id)) {
      if (u.targetPlayer !== a.defender && u.targetPlayer >= 0) continue;
      if (this.nearAxis(a, u, reach)) atk.push(u);
    }
    for (const u of g.unitSys.frontArmor(D.id)) if (this.nearAxis(a, u, reach + 3)) dfn.push(u);
    for (const s of g.structByOwner.get(D.id) ?? []) {
      if (s.type !== StructureType.DefensePost || !s.operational) continue;
      const lv = Math.max(1, Math.min(3, s.level));
      this.posts.push({ x: s.x, y: s.y, r2: POST_RADIUS[lv] * POST_RADIUS[lv], mul: POST_MUL[lv] });
    }
  }

  private nearAxis(a: Attack, u: Unit, reach: number): boolean {
    const rx = wdx(a.originX, u.x), ry = u.y - a.originY;
    return Math.abs(rx * a.dirY - ry * a.dirX) <= reach && rx * a.dirX + ry * a.dirY >= -reach;
  }

  private nearUnit(list: Unit[], t: number): boolean {
    const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
    for (const u of list) {
      const dx = wdx(u.x, tx), dy = ty - u.y;
      if (dx * dx + dy * dy <= ARMOR_REACH * ARMOR_REACH) return true;
    }
    return false;
  }

  /**
   * v1 API kept for the armor AI: a division at the edge of unclaimed land or an independent territory with no offensive
   * launches one. v2 (§4.4, §5.7): against a nation or the human a division only supports the offensives its staff
   * launches (armor ×1.25 power, ×1.5 speed around it); the war plan alone decides when the odds justify one.
   */
  armoredAssault(p: Player, u: Unit, defender: number): void {
    const g = this.g;
    for (const a of g.attackList) {
      if (!a.ended && !a.naval && a.attacker === p.id && a.defender === defender) return;
    }
    const D = g.playerObj(defender);
    if (defender !== 0 && (!D || D.kind !== 'tribe')) return;
    if (defender !== 0 && g.isAllied(p.id, defender)) return;
    if (!g.sharesBorder(p.id, defender)) return;
    if (p.id === HUMAN_ID) return; // the human launches its own offensives
    const troops = Math.max(Math.min(p.troops, 20_000), p.troops * 0.12);
    if (troops < 5_000) return;
    const tile = Math.floor(u.toY) * MAP_W + Math.floor(u.toX);
    this.command(p, defender, troops / Math.max(1, p.troops), tile >= 0 && tile < TILE_COUNT ? tile : -1);
  }

  // =================================================================================================
  // Views
  // =================================================================================================
  view(a: Attack): AttackView {
    const g = this.g;
    let eta = -1;
    if (a.state === 'contact') eta = Math.max(0, a.contactUntil - g.tick);
    else if (a.state === 'retreating') eta = Math.max(0, a.returnAt - g.tick);
    else if (a.boatId) {
      const u = g.unitMap.get(a.boatId);
      if (u) eta = g.unitSys.convoyEta(u);
    }
    return {
      id: a.id, attacker: a.attacker, defender: a.defender, troops: Math.floor(a.troops), naval: a.naval, startTick: a.startTick,
      x: a.clickX, y: a.clickY, originX: a.originX, originY: a.originY, frontKey: a.frontKey, frontageTiles: +a.frontage.toFixed(1),
      tilesTaken: a.tilesTaken, tilesLost: a.tilesLost, ratio: +a.ratio.toFixed(2), advanceKmh: +a.advanceKmh.toFixed(2),
      committed: Math.floor(a.committed), etaTicks: eta, state: a.state, defensePower: Math.round(a.pd), attackPower: Math.round(a.pa),
    };
  }

  /** Queued offensives (the aggressor still mobilizes) appear as 'mobilizing' views so the UI can show the massing. */
  queuedViews(): AttackView[] {
    const g = this.g;
    const out: AttackView[] = [];
    let i = 0;
    for (const q of g.war.allQueued()) {
      const p = g.playerById[q.attacker];
      const w = g.war.get(q.war);
      if (!p || !w) continue;
      const x = q.tile >= 0 ? (q.tile % MAP_W) + 0.5 : -1, y = q.tile >= 0 ? Math.floor(q.tile / MAP_W) + 0.5 : -1;
      out.push({
        id: -(++i), attacker: q.attacker, defender: q.target, troops: Math.floor(p.troops * q.ratio), naval: q.naval, startTick: w.mobilizeUntilTick,
        x, y, originX: x, originY: y, frontKey: 0, frontageTiles: 0, tilesTaken: 0, tilesLost: 0, ratio: 0, advanceKmh: 0,
        committed: 0, etaTicks: Math.max(0, w.mobilizeUntilTick - g.tick), state: 'mobilizing', defensePower: 0, attackPower: 0,
      });
    }
    return out;
  }
}

export { Mode, MAP_H };
