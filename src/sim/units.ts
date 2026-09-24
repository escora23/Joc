// FRONT ULTRA — mobile units: transport ships (naval invasions), trade ships, warships, armored divisions,
// fighter squadrons, bombers, drone swarms and trains. Owner: sim-core. Worker-only.
// Missiles, nukes, SAM interceptors and shells are flown by weapons.ts (they share the unit maps).

import { HUMAN_ID, MAP_H, MAP_W, TILE_COUNT, UNIT_DEFS } from '../shared/constants';
import { StructureType, UnitState, UnitType, type BuildableUnit } from '../shared/types';
import {
  AIRBASE_CAPACITY, AIRBASE_INTERCEPT_RANGE, AIRCRAFT_FUEL_TICKS, AIRCRAFT_STRIKE_RANGE, ARMY_BASE_CAPACITY, MAX_BOATS,
  NAVAL_YARD_CAPACITY, RADAR_RANGE, WARSHIP_COAST_COOLDOWN, WARSHIP_COAST_RANGE, WARSHIP_FIRE_COOLDOWN,
  WARSHIP_FIRE_RANGE, WARSHIP_PATROL_RADIUS, WARSHIP_TARGET_RANGE, trainGold, tradeGold,
} from './balance';
import type { Game } from './game';
import { Attack, Mode, Player, Structure, Unit } from './state';
import { dist2, wdx, wrapXf } from './spatial';

const AIR_TYPES = new Set<number>([UnitType.FighterSquadron, UnitType.Bomber, UnitType.DroneSwarm]);
const PROJECTILES = new Set<number>([
  UnitType.CruiseMissile, UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.Mirv, UnitType.MirvWarhead,
  UnitType.SamInterceptor, UnitType.Shell,
]);

export class UnitSystem {
  private readonly frontArmorByOwner = new Map<number, Unit[]>();
  private readonly comps: number[] = [];
  private readonly rnd: () => number;
  private readonly scratch: Unit[] = [];

  constructor(private readonly g: Game) {
    this.rnd = () => g.rngUnits.next();
  }

  // =================================================================================================
  // Registry
  // =================================================================================================
  spawn(type: UnitType, owner: number, x: number, y: number, emit = true): Unit {
    const g = this.g;
    const u = new Unit(g.allocId(), type, owner, wrapXf(x), Math.min(MAP_H - 0.01, Math.max(0, y)), UNIT_DEFS[type].maxHp);
    u.toX = u.x;
    u.toY = u.y;
    g.unitMap.set(u.id, u);
    let list = g.unitsByOwner.get(owner);
    if (!list) g.unitsByOwner.set(owner, (list = []));
    list.push(u);
    const p = g.playerById[owner];
    if (p) p.unitCount[type]++;
    if (emit) g.emit({ type: 'unitSpawned', tick: g.tick, unitId: u.id, unit: type, owner, x: u.x, y: u.y });
    return u;
  }

  /** Remove a unit. `destroyed` = killed (death effect + unitDestroyed event), else it silently leaves the map. */
  remove(u: Unit, destroyed: boolean, by = 0): void {
    if (u.dead) return;
    const g = this.g;
    u.dead = true;
    u.killedBy = by;
    g.unitMap.delete(u.id);
    const list = g.unitsByOwner.get(u.owner);
    if (list) {
      const i = list.indexOf(u);
      if (i >= 0) list.splice(i, 1);
    }
    const p = g.playerById[u.owner];
    if (p) p.unitCount[u.type] = Math.max(0, p.unitCount[u.type] - 1);
    if (u.type === UnitType.TransportShip && p) {
      p.boats = Math.max(0, p.boats - 1);
      const a = g.attackList.find((x) => x.id === u.attackId && !x.ended);
      if (a && a.boatId === u.id) {
        if (destroyed) {
          p.stats.troopsLost += a.troops;
          const k = g.playerById[by];
          if (k) k.stats.troopsKilled += a.troops;
          a.troops = 0;
          g.attacks.end(a, 'exhausted', false);
          if (u.owner === HUMAN_ID) g.message(HUMAN_ID, 'msg.boatSunk', 'danger');
        }
      }
    }
    if (destroyed) {
      g.dyingUnits.push(u);
      const k = g.playerById[by];
      if (k && by !== u.owner) k.stats.unitsDestroyed++;
      g.emit({ type: 'unitDestroyed', tick: g.tick, unitId: u.id, unit: u.type, owner: u.owner, by, x: u.x, y: u.y });
    }
  }

  kill(u: Unit, by: number): void {
    this.remove(u, true, by);
  }

  damage(u: Unit, amount: number, by: number): void {
    if (u.dead || amount <= 0) return;
    u.hp -= amount;
    u.lastHitTick = this.g.tick;
    if (by > 0 && by !== u.owner) this.g.markHostile(by, u.owner);
    if (u.hp <= 0) this.kill(u, by);
  }

  changeOwner(u: Unit, owner: number): void {
    const g = this.g;
    const old = g.unitsByOwner.get(u.owner);
    if (old) {
      const i = old.indexOf(u);
      if (i >= 0) old.splice(i, 1);
    }
    const op = g.playerById[u.owner];
    if (op) op.unitCount[u.type] = Math.max(0, op.unitCount[u.type] - 1);
    u.owner = owner;
    let list = g.unitsByOwner.get(owner);
    if (!list) g.unitsByOwner.set(owner, (list = []));
    list.push(u);
    const np = g.playerById[owner];
    if (np) np.unitCount[u.type]++;
  }

  removeAllOf(pid: number, by: number): void {
    const list = this.g.unitsByOwner.get(pid);
    if (!list) return;
    for (const u of list.slice()) this.remove(u, true, by);
  }

  /** Armored divisions currently fighting at a front (used by the attack engine). */
  frontArmor(pid: number): readonly Unit[] {
    return this.frontArmorByOwner.get(pid) ?? NO_UNITS;
  }

  // =================================================================================================
  // Commands
  // =================================================================================================
  boatAttack(p: Player, targetTile: number, ratio: number): boolean {
    const g = this.g;
    if (g.phase !== 'playing' || !p.spawned) return false;
    if (p.boats >= MAX_BOATS) {
      g.message(p.id, 'msg.maxBoats');
      return false;
    }
    if (targetTile < 0 || targetTile >= TILE_COUNT) return false;
    const landing = this.findLanding(targetTile);
    if (landing < 0) {
      g.message(p.id, 'msg.noCoast');
      return false;
    }
    const o = g.owner[landing];
    if (o === p.id) {
      g.message(p.id, 'msg.invalidTarget');
      return false;
    }
    if (o !== 0 && g.isAllied(p.id, o)) {
      g.message(p.id, 'msg.cannotAttackAlly');
      return false;
    }
    // Departure: our coastal tile on the same sea, closest to the landing.
    g.nav.coastComponents(landing, this.comps);
    if (this.comps.length === 0) {
      g.message(p.id, 'msg.noCoast');
      return false;
    }
    const lx = (landing % MAP_W) + 0.5, ly = ((landing / MAP_W) | 0) + 0.5;
    let best = -1, bestD = Infinity, bestComp = -1;
    const tmp: number[] = [];
    for (const t of p.shore) {
      const d = dist2((t % MAP_W) + 0.5, ((t / MAP_W) | 0) + 0.5, lx, ly);
      if (d >= bestD) continue;
      g.nav.coastComponents(t, tmp);
      for (const c of tmp) {
        if (this.comps.includes(c)) {
          best = t;
          bestD = d;
          bestComp = c;
          break;
        }
      }
    }
    if (best < 0) {
      g.message(p.id, 'msg.noPath');
      return false;
    }
    const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.2;
    const troops = Math.floor(p.troops * r);
    if (troops < 50) {
      g.message(p.id, 'msg.notEnoughTroops');
      return false;
    }
    const start = g.nav.waterNear(best, bestComp);
    const goal = g.nav.waterNear(landing, bestComp);
    if (start < 0 || goal < 0) {
      g.message(p.id, 'msg.noPath');
      return false;
    }
    p.troops -= troops;
    p.boats++;
    const u = this.spawn(UnitType.TransportShip, p.id, (start % MAP_W) + 0.5, ((start / MAP_W) | 0) + 0.5, false);
    u.troops = troops;
    u.targetTile = landing;
    u.toX = lx;
    u.toY = ly;
    u.anchorTile = goal;
    u.aux = start;
    u.mode = Mode.WaitPath;
    u.state = UnitState.Launching;
    const a = g.attacks.createNaval(p, o, troops, landing);
    a.boatId = u.id;
    u.attackId = a.id;
    this.planPath(u, start, goal, false);
    g.emit({ type: 'unitSpawned', tick: g.tick, unitId: u.id, unit: u.type, owner: p.id, x: u.x, y: u.y });
    g.emit({ type: 'boatLaunched', tick: g.tick, unitId: u.id, owner: p.id, fromTile: best, toTile: landing, troops });
    g.emit({ type: 'attackStarted', tick: g.tick, attackId: a.id, attacker: p.id, defender: o, troops, tile: landing, naval: true });
    return true;
  }

  /** Nearest coastal playable tile to a target (the target itself when coastal). */
  private findLanding(tile: number): number {
    const g = this.g;
    if (g.playable[tile] && g.nav.coastal[tile]) return tile;
    const cx = tile % MAP_W, cy = (tile / MAP_W) | 0;
    const want = g.playable[tile] ? g.owner[tile] : -1;
    let fallback = -1;
    for (let r = 1; r <= 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= MAP_H) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const t = y * MAP_W + ((cx + dx + MAP_W) % MAP_W);
          if (!g.playable[t] || !g.nav.coastal[t]) continue;
          if (want < 0 || g.owner[t] === want) return t;
          if (fallback < 0) fallback = t;
        }
      }
      if (fallback >= 0 && r >= 4) return fallback;
    }
    return fallback;
  }

  recallBoat(a: Attack): boolean {
    const u = this.g.unitMap.get(a.boatId);
    if (!u || u.mode === Mode.Return) return false;
    u.mode = Mode.Return;
    u.state = UnitState.Returning;
    const here = this.nearestWater(u);
    this.planPath(u, here, u.aux, false);
    return true;
  }

  buildUnit(p: Player, type: BuildableUnit, structureId: number): boolean {
    const g = this.g;
    if (g.phase !== 'playing' || !p.spawned) return false;
    const def = UNIT_DEFS[type];
    if (!def || def.producedBy === -1 || def.cost <= 0) return false;
    const prodType = def.producedBy as StructureType;
    let base: Structure | undefined;
    if (structureId >= 0) {
      const s = g.structureMap.get(structureId);
      if (s && s.owner === p.id && s.type === prodType && s.operational && this.hasCapacity(s, type)) base = s;
    } else {
      for (const s of g.structByOwner.get(p.id) ?? []) {
        if (s.type === prodType && s.operational && this.hasCapacity(s, type)) {
          if (!base || s.level > base.level) base = s;
        }
      }
    }
    if (!base) {
      g.message(p.id, structureId >= 0 ? 'msg.baseFull' : 'msg.noProducer', 'warning', { structure: prodType });
      return false;
    }
    const cost = g.unitCost(p.id, type);
    if (p.gold < cost) {
      g.message(p.id, 'msg.notEnoughGold');
      return false;
    }
    let x = base.x, y = base.y;
    if (type === UnitType.Warship) {
      const w = g.nav.waterNear(base.tile);
      if (w < 0) {
        g.message(p.id, 'msg.noCoast');
        return false;
      }
      x = (w % MAP_W) + 0.5;
      y = ((w / MAP_W) | 0) + 0.5;
    }
    p.gold -= cost;
    p.stats.goldSpent += cost;
    p.stats.unitsBuilt++;
    const u = this.spawn(type, p.id, x, y);
    u.home = base.id;
    if (AIR_TYPES.has(type)) {
      u.mode = Mode.Docked;
      u.state = UnitState.Docked;
    } else if (type === UnitType.Warship) {
      u.anchorTile = Math.floor(y) * MAP_W + Math.floor(x);
      u.mode = Mode.Patrol;
      u.state = UnitState.Moving;
    } else {
      u.mode = Mode.None;
      u.state = UnitState.Idle;
    }
    return true;
  }

  private hasCapacity(s: Structure, type: UnitType): boolean {
    const g = this.g;
    let used = 0;
    for (const u of g.unitsByOwner.get(s.owner) ?? []) if (u.home === s.id && (u.type === type || (AIR_TYPES.has(u.type) && AIR_TYPES.has(type)))) used++;
    const per = s.type === StructureType.Airbase ? AIRBASE_CAPACITY : s.type === StructureType.NavalYard ? NAVAL_YARD_CAPACITY : ARMY_BASE_CAPACITY;
    return used < per * s.level;
  }

  moveUnit(p: Player, unitId: number, tile: number): boolean {
    const g = this.g;
    const u = g.unitMap.get(unitId);
    if (!u || u.owner !== p.id || u.state === UnitState.Controlled || tile < 0 || tile >= TILE_COUNT) return false;
    const tx = (tile % MAP_W) + 0.5, ty = ((tile / MAP_W) | 0) + 0.5;
    switch (u.type) {
      case UnitType.Warship: {
        const here = this.nearestWater(u);
        const c = g.nav.comp[here];
        const dest = g.nav.comp[tile] === c ? tile : g.nav.waterNear(tile, c);
        if (dest < 0) {
          g.message(p.id, 'msg.noPath');
          return false;
        }
        u.anchorTile = dest;
        u.targetUnit = 0;
        u.mode = Mode.Sail;
        u.state = UnitState.Moving;
        this.planPath(u, here, dest, false);
        return true;
      }
      case UnitType.ArmoredDivision:
        u.mode = Mode.Deploy;
        u.state = UnitState.Moving;
        u.toX = tx;
        u.toY = ty;
        u.targetTile = tile;
        u.targetPlayer = -2; // plain move: never auto-assault
        return true;
      case UnitType.FighterSquadron: {
        if (!this.inAirRange(u, tx, ty)) {
          g.message(p.id, 'msg.outOfRange');
          return false;
        }
        this.takeOff(u);
        u.mode = Mode.Cap;
        u.toX = tx;
        u.toY = ty;
        u.targetTile = tile;
        return true;
      }
      default:
        return false;
    }
  }

  deployArmor(p: Player, unitId: number, targetTile: number): boolean {
    const g = this.g;
    const u = g.unitMap.get(unitId);
    if (!u || u.owner !== p.id || u.type !== UnitType.ArmoredDivision || u.state === UnitState.Controlled) return false;
    if (targetTile < 0 || targetTile >= TILE_COUNT) return false;
    const o = g.owner[targetTile];
    if (o !== 0 && o !== p.id && g.isAllied(p.id, o)) {
      g.message(p.id, 'msg.cannotAttackAlly');
      return false;
    }
    u.mode = Mode.Deploy;
    u.state = UnitState.Moving;
    u.toX = (targetTile % MAP_W) + 0.5;
    u.toY = ((targetTile / MAP_W) | 0) + 0.5;
    u.targetTile = targetTile;
    u.targetPlayer = o === p.id ? -1 : o;
    u.cooldown = 0;
    return true;
  }

  airStrike(p: Player, unitId: number, targetTile: number): boolean {
    const g = this.g;
    const u = g.unitMap.get(unitId);
    if (!u || u.owner !== p.id || !AIR_TYPES.has(u.type) || u.state === UnitState.Controlled) return false;
    if (targetTile < 0 || targetTile >= TILE_COUNT) return false;
    const tx = (targetTile % MAP_W) + 0.5, ty = ((targetTile / MAP_W) | 0) + 0.5;
    const o = g.owner[targetTile];
    if (o === p.id || (o !== 0 && g.isAllied(p.id, o))) {
      g.message(p.id, 'msg.invalidTarget');
      return false;
    }
    if (!this.inAirRange(u, tx, ty)) {
      g.message(p.id, 'msg.outOfRange');
      return false;
    }
    this.takeOff(u);
    u.mode = Mode.Strike;
    u.toX = tx;
    u.toY = ty;
    u.targetTile = targetTile;
    u.targetPlayer = o;
    if (o > 0) g.attacks.onHostileAct(p.id, o);
    return true;
  }

  private inAirRange(u: Unit, tx: number, ty: number): boolean {
    const base = this.g.structureMap.get(u.home);
    const bx = base ? base.x : u.x, by = base ? base.y : u.y;
    const r = AIRCRAFT_STRIKE_RANGE[u.type] ?? 150;
    return dist2(bx, by, tx, ty) <= r * r;
  }

  private takeOff(u: Unit): void {
    if (u.mode === Mode.Docked) {
      u.fuel = AIRCRAFT_FUEL_TICKS;
      u.alt = 0;
    }
    u.state = UnitState.Moving;
    u.targetUnit = 0;
  }

  control(p: Player, unitId: number, controlled: boolean): boolean {
    const u = this.g.unitMap.get(unitId);
    if (!u || u.owner !== p.id) return false;
    if (controlled) {
      if (u.state !== UnitState.Controlled) u.savedState = u.state;
      u.state = UnitState.Controlled;
    } else if (u.state === UnitState.Controlled) {
      u.state = u.savedState === UnitState.Controlled ? UnitState.Idle : u.savedState;
      if (AIR_TYPES.has(u.type) && u.mode !== Mode.Docked) u.mode = Mode.Return;
    }
    return true;
  }

  /** Staging: create any unit type at a tile heading to targetTile. */
  debugSpawn(type: UnitType, owner: number, tile: number, targetTile: number): void {
    const g = this.g;
    if (tile < 0 || tile >= TILE_COUNT) return;
    const x = (tile % MAP_W) + 0.5, y = ((tile / MAP_W) | 0) + 0.5;
    const hasTarget = targetTile >= 0 && targetTile < TILE_COUNT;
    const tx = hasTarget ? (targetTile % MAP_W) + 0.5 : x, ty = hasTarget ? ((targetTile / MAP_W) | 0) + 0.5 : y;
    switch (type) {
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
      case UnitType.Mirv:
      case UnitType.CruiseMissile:
      case UnitType.MirvWarhead:
        g.weapons.launch(owner, type, tile, hasTarget ? targetTile : tile, 0);
        return;
      case UnitType.SamInterceptor:
      case UnitType.Shell: {
        const u = this.spawn(type, owner, x, y);
        g.weapons.initProjectile(u, tx, ty, type === UnitType.Shell ? 8 : 30);
        return;
      }
    }
    const u = this.spawn(type, owner, x, y);
    u.home = this.nearestHome(owner, type, x, y);
    switch (type) {
      case UnitType.TransportShip:
      case UnitType.TradeShip:
      case UnitType.Warship: {
        const c = g.nav.comp[tile];
        u.anchorTile = tile;
        u.mode = type === UnitType.Warship ? Mode.Patrol : Mode.Sail;
        u.state = UnitState.Moving;
        u.troops = type === UnitType.TransportShip ? 5_000 : 0;
        if (type === UnitType.TradeShip) u.cargo = tradeGold(40);
        if (hasTarget && c >= 0) {
          const dest = g.nav.comp[targetTile] === c ? targetTile : g.nav.waterNear(targetTile, c);
          if (dest >= 0) {
            if (type === UnitType.Warship) u.anchorTile = dest;
            u.toX = tx;
            u.toY = ty;
            this.planPath(u, tile, dest, false);
          }
        }
        if (type !== UnitType.Warship && !hasTarget) u.mode = Mode.None;
        u.aux = -1; // staged: no attack attached
        return;
      }
      case UnitType.ArmoredDivision:
        if (hasTarget) this.deployArmor(g.playerObj(owner)!, u.id, targetTile);
        return;
      case UnitType.FighterSquadron:
      case UnitType.Bomber:
      case UnitType.DroneSwarm:
        u.fuel = AIRCRAFT_FUEL_TICKS;
        u.alt = 1;
        if (hasTarget) {
          u.mode = type === UnitType.FighterSquadron ? Mode.Cap : Mode.Strike;
          u.state = UnitState.Moving;
          u.toX = tx;
          u.toY = ty;
          u.targetTile = targetTile;
          u.targetPlayer = g.owner[targetTile];
        } else {
          u.mode = Mode.Cap;
          u.state = UnitState.Moving;
        }
        return;
      case UnitType.Train:
        u.mode = Mode.Rail;
        u.state = UnitState.Moving;
        u.aux = -1; // staged: the path holds tiles, not stations
        u.path = Int32Array.of(tile, hasTarget ? targetTile : tile);
        u.pathI = 1;
        u.cargo = trainGold(20, false);
        u.toX = tx;
        u.toY = ty;
        return;
    }
  }

  private nearestHome(owner: number, type: UnitType, x: number, y: number): number {
    const prod = UNIT_DEFS[type].producedBy;
    if (prod === -1) return 0;
    let best = 0, bestD = Infinity;
    for (const s of this.g.structByOwner.get(owner) ?? []) {
      if (s.type !== prod) continue;
      const d = dist2(s.x, s.y, x, y);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    return best;
  }

  // =================================================================================================
  // Movement helpers
  // =================================================================================================
  /** Move toward (tx, ty) by `speed` tiles; returns true on arrival. Updates heading. */
  private moveToward(u: Unit, tx: number, ty: number, speed: number): boolean {
    const dx = wdx(u.x, tx), dy = ty - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-6) u.heading = Math.atan2(dx, -dy);
    if (d <= speed) {
      u.x = wrapXf(tx);
      u.y = ty;
      return true;
    }
    u.x = wrapXf(u.x + (dx / d) * speed);
    u.y += (dy / d) * speed;
    return false;
  }

  /** Follow u.path; returns true when the last waypoint is reached. */
  private followPath(u: Unit, speed: number): boolean {
    const path = u.path;
    if (!path) return true;
    let budget = speed;
    while (budget > 1e-6 && u.pathI < path.length) {
      const t = path[u.pathI];
      const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
      const dx = wdx(u.x, tx), dy = ty - u.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1e-6) u.heading = Math.atan2(dx, -dy);
      if (d <= budget) {
        u.x = wrapXf(tx);
        u.y = ty;
        budget -= d;
        u.pathI++;
      } else {
        u.x = wrapXf(u.x + (dx / d) * budget);
        u.y += (dy / d) * budget;
        budget = 0;
      }
    }
    return u.pathI >= path.length;
  }

  /** Plan a water path; if the per-tick search budget is exhausted the unit waits (WaitPath) and retries. */
  private planPath(u: Unit, from: number, to: number, cacheable: boolean): boolean {
    const nav = this.g.nav;
    const path = nav.findPath(from, to, cacheable);
    if (path) {
      u.path = path;
      u.pathI = 1;
      if (u.mode === Mode.WaitPath) u.mode = Mode.Sail;
      return true;
    }
    if (!nav.canSearch()) {
      // Try again next tick.
      u.path = null;
      u.aux2From = from;
      u.aux2To = to;
      u.waitingPath = true;
      return false;
    }
    u.path = null;
    u.pathFailed = true;
    return false;
  }

  private nearestWater(u: Unit): number {
    const g = this.g;
    const t = Math.floor(u.y) * MAP_W + Math.floor(u.x);
    if (g.nav.comp[t] >= 0) return t;
    const w = g.nav.waterNear(t);
    return w >= 0 ? w : t;
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  step(): void {
    const g = this.g;
    g.unitGrid.rebuild(g.unitMap.values());
    // Snapshot to allow removal during iteration.
    const list = this.scratch;
    list.length = 0;
    for (const u of g.unitMap.values()) list.push(u);
    for (const fl of this.frontArmorByOwner.values()) fl.length = 0;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (u.dead) continue;
      if (u.state === UnitState.Controlled) continue;
      if (u.waitingPath) {
        u.waitingPath = false;
        if (!this.planPath(u, u.aux2From, u.aux2To, u.type === UnitType.TradeShip)) {
          if (u.waitingPath) continue;
        }
      }
      if (PROJECTILES.has(u.type)) {
        g.weapons.stepProjectile(u);
        continue;
      }
      switch (u.type) {
        case UnitType.TransportShip: this.stepTransport(u); break;
        case UnitType.TradeShip: this.stepTrade(u); break;
        case UnitType.Warship: this.stepWarship(u); break;
        case UnitType.ArmoredDivision: this.stepArmor(u); break;
        case UnitType.FighterSquadron:
        case UnitType.Bomber:
        case UnitType.DroneSwarm: this.stepAircraft(u); break;
        case UnitType.Train: this.stepTrain(u); break;
      }
    }
  }

  // --- transport ships --------------------------------------------------------------------------------
  private stepTransport(u: Unit): void {
    const g = this.g;
    if (u.pathFailed) {
      // No route: troops go back to the reserve.
      const p = g.playerById[u.owner];
      const a = g.attackList.find((x) => x.id === u.attackId && !x.ended);
      if (a) {
        a.boatId = 0;
        g.attacks.end(a, 'cancelled', true);
      } else if (p) p.troops += u.troops;
      if (u.owner === HUMAN_ID) g.message(HUMAN_ID, 'msg.noPath');
      this.remove(u, false);
      return;
    }
    if (!u.path) return;
    u.state = u.mode === Mode.Return ? UnitState.Returning : UnitState.Moving;
    if (!this.followPath(u, UNIT_DEFS[UnitType.TransportShip].speed)) return;
    const a = g.attackList.find((x) => x.id === u.attackId && !x.ended);
    const p = g.playerById[u.owner];
    if (u.mode === Mode.Return || u.aux < 0) {
      // Back home (or a staged boat): troops rejoin the reserve.
      if (a) {
        a.boatId = 0;
        g.attacks.end(a, 'cancelled', true);
      } else if (p && u.aux >= 0) p.troops += u.troops;
      this.remove(u, false);
      return;
    }
    const landing = u.targetTile;
    const defender = g.owner[landing];
    const troops = a ? a.troops : u.troops;
    // Remove first so the player's boat counter is right when the landing resolves.
    u.attackId = 0;
    this.remove(u, false);
    if (a) g.attacks.land(a, landing);
    g.emit({ type: 'boatLanded', tick: g.tick, unitId: u.id, owner: u.owner, tile: landing, defender, troops: Math.floor(troops) });
  }

  // --- trade ships ------------------------------------------------------------------------------------
  private stepTrade(u: Unit): void {
    const g = this.g;
    if (u.pathFailed) {
      this.remove(u, false);
      return;
    }
    if (!u.path) {
      if (!u.waitingPath) this.remove(u, false);
      return;
    }
    u.state = UnitState.Moving;
    if (!this.followPath(u, UNIT_DEFS[UnitType.TradeShip].speed)) return;
    const dest = g.structureMap.get(u.targetStructure);
    const owner = g.playerById[u.owner];
    if (dest && owner && owner.alive && dest.type === StructureType.Port) {
      const partner = g.playerById[dest.owner];
      if (dest.owner === u.owner) {
        // A captured ship brought home its cargo.
        g.addGold(u.owner, u.cargo);
        g.emit({ type: 'goldBonus', tick: g.tick, playerId: u.owner, gold: Math.round(u.cargo), tile: dest.tile, reason: 'trade' });
      } else if (partner && partner.alive && !g.hasEmbargo(u.owner, dest.owner) && !g.hasEmbargo(dest.owner, u.owner)) {
        g.addGold(u.owner, u.cargo);
        g.addGold(dest.owner, u.cargo);
        g.emit({ type: 'tradeCompleted', tick: g.tick, owner: u.owner, partner: dest.owner, gold: Math.round(u.cargo), tile: dest.tile });
        g.emit({ type: 'goldBonus', tick: g.tick, playerId: u.owner, gold: Math.round(u.cargo), tile: dest.tile, reason: 'trade' });
        g.emit({ type: 'goldBonus', tick: g.tick, playerId: dest.owner, gold: Math.round(u.cargo), tile: dest.tile, reason: 'trade' });
      }
    }
    this.remove(u, false);
  }

  /** A warship boards a trade ship: it now sails to the pirate's nearest port. */
  private captureTrade(ship: Unit, pirate: Unit): void {
    const g = this.g;
    let best: Structure | null = null, bestD = Infinity;
    for (const s of g.structByOwner.get(pirate.owner) ?? []) {
      if (s.type !== StructureType.Port || !s.operational) continue;
      const d = dist2(s.x, s.y, ship.x, ship.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    const victim = ship.owner;
    if (!best) {
      // No port to bring it to: plunder and scuttle.
      g.addGold(pirate.owner, ship.cargo * 0.5);
      g.emit({ type: 'goldBonus', tick: g.tick, playerId: pirate.owner, gold: Math.round(ship.cargo * 0.5), tile: Math.floor(ship.y) * MAP_W + Math.floor(ship.x), reason: 'trade' });
      this.kill(ship, pirate.owner);
      return;
    }
    const here = this.nearestWater(ship);
    const dest = g.nav.waterNear(best.tile, g.nav.comp[here]);
    this.changeOwner(ship, pirate.owner);
    ship.targetStructure = best.id;
    ship.targetPlayer = pirate.owner;
    ship.toX = best.x;
    ship.toY = best.y;
    if (dest < 0 || !this.planPath(ship, here, dest, false)) {
      if (!ship.waitingPath) this.kill(ship, pirate.owner);
    }
    g.markHostile(pirate.owner, victim);
    if (victim === HUMAN_ID) g.message(HUMAN_ID, 'msg.tradeCaptured', 'warning');
  }

  // --- warships ---------------------------------------------------------------------------------------
  private stepWarship(u: Unit): void {
    const g = this.g;
    if (u.cooldown > 0) u.cooldown--;
    const speed = UNIT_DEFS[UnitType.Warship].speed;
    // Healing near own naval yards / ports.
    if (g.tick - u.lastHitTick > 60 && u.hp < u.maxHp) {
      let heal = 0.15;
      g.structGrid.query(u.x, u.y, 10, (s) => {
        if (s.owner === u.owner && (s.type === StructureType.NavalYard || s.type === StructureType.Port)) {
          heal = 1.2;
          return true;
        }
      });
      u.hp = Math.min(u.maxHp, u.hp + heal);
    }
    // Target acquisition (staggered).
    if ((g.tick + u.id) % 5 === 0 || (u.targetUnit && !g.unitMap.has(u.targetUnit))) this.acquireNavalTarget(u);
    const target = u.targetUnit ? g.unitMap.get(u.targetUnit) : undefined;
    if (target && !target.dead) {
      u.state = UnitState.Attacking;
      const d2 = dist2(u.x, u.y, target.x, target.y);
      if (target.type === UnitType.TradeShip && d2 <= 4) {
        this.captureTrade(target, u);
        u.targetUnit = 0;
        return;
      }
      if (target.type !== UnitType.TradeShip && d2 <= WARSHIP_FIRE_RANGE * WARSHIP_FIRE_RANGE && u.cooldown <= 0) {
        g.weapons.fireShell(u.owner, u.x, u.y, target, 0);
        u.cooldown = WARSHIP_FIRE_COOLDOWN;
      }
      // Close in (direct line when open water).
      const here = Math.floor(u.y) * MAP_W + Math.floor(u.x);
      const there = Math.floor(target.y) * MAP_W + Math.floor(target.x);
      const c = g.nav.comp[here];
      if (d2 > 36 && c >= 0 && g.nav.comp[there] === c && g.nav.lineOfSight(here, there, c)) {
        this.moveToward(u, target.x, target.y, speed);
        u.path = null;
      }
      return;
    }
    u.targetUnit = 0;
    // Coastal bombardment of enemies at war with us.
    if ((g.tick + u.id) % WARSHIP_COAST_COOLDOWN === 0) this.shellCoast(u);
    // Patrol / sail.
    u.state = UnitState.Moving;
    if (u.path && !this.followPath(u, speed)) return;
    if (u.mode === Mode.Sail) u.mode = Mode.Patrol;
    if (u.mode === Mode.Patrol && !u.waitingPath) {
      const here = this.nearestWater(u);
      const c = g.nav.comp[here];
      if (c < 0) return;
      const ax = (u.anchorTile % MAP_W) + 0.5, ay = ((u.anchorTile / MAP_W) | 0) + 0.5;
      const dest = g.nav.randomWaterNear(ax, ay, WARSHIP_PATROL_RADIUS, c, this.rnd);
      if (dest >= 0 && g.nav.canSearch()) this.planPath(u, here, dest, false);
      u.pathFailed = false;
    }
  }

  private acquireNavalTarget(u: Unit): void {
    const g = this.g;
    let best: Unit | null = null, bestScore = Infinity;
    g.unitGrid.query(u.x, u.y, WARSHIP_TARGET_RANGE, (o, d2) => {
      if (o.dead || o.owner === u.owner || g.isAllied(u.owner, o.owner)) return;
      let prio: number;
      if (o.type === UnitType.TransportShip) {
        // Invasion fleets heading to us/our allies are always engaged; others only when at war with their owner.
        const tgt = g.owner[o.targetTile] ?? 0;
        if (!(tgt === u.owner || g.isAllied(u.owner, tgt) || g.isHostile(u.owner, o.owner))) return;
        prio = 0;
      } else if (o.type === UnitType.Warship) {
        if (!g.isHostile(u.owner, o.owner)) return;
        prio = 1;
      } else if (o.type === UnitType.TradeShip) {
        if (!g.isHostile(u.owner, o.owner)) return;
        prio = 2;
      } else return;
      const s = prio * 10_000 + d2;
      if (s < bestScore) {
        bestScore = s;
        best = o;
      }
    });
    u.targetUnit = best ? (best as Unit).id : 0;
  }

  private shellCoast(u: Unit): void {
    const g = this.g;
    // Structures first, then troops on the shore.
    let hit = false;
    g.structGrid.query(u.x, u.y, WARSHIP_COAST_RANGE, (s) => {
      if (s.owner !== u.owner && g.isHostile(u.owner, s.owner)) {
        g.weapons.fireShellAt(u.owner, u.x, u.y, s.x, s.y, s.owner);
        hit = true;
        return true;
      }
    });
    if (hit) return;
    for (let k = 0; k < 10; k++) {
      const a = this.rnd() * Math.PI * 2, r = 2 + this.rnd() * (WARSHIP_COAST_RANGE - 2);
      const y = Math.floor(u.y + Math.sin(a) * r);
      if (y < 0 || y >= MAP_H) continue;
      const t = y * MAP_W + ((Math.floor(u.x + Math.cos(a) * r) % MAP_W) + MAP_W) % MAP_W;
      const o = g.owner[t];
      if (o > 0 && o !== u.owner && g.playable[t] && g.isHostile(u.owner, o)) {
        g.weapons.fireShellAt(u.owner, u.x, u.y, (t % MAP_W) + 0.5, y + 0.5, o);
        return;
      }
    }
  }

  // --- armored divisions --------------------------------------------------------------------------------
  private stepArmor(u: Unit): void {
    const g = this.g;
    const p = g.playerById[u.owner];
    if (!p) return;
    const speed = UNIT_DEFS[UnitType.ArmoredDivision].speed;
    const here = Math.floor(u.y) * MAP_W + Math.floor(u.x);
    const hereOwner = g.owner[here];
    if (hereOwner !== u.owner && !g.isAllied(u.owner, hereOwner)) {
      // Overrun: fall back toward home territory, taking damage.
      this.damage(u, 4, hereOwner);
      if (u.dead) return;
      const cap = p.capitalTile;
      if (cap >= 0) this.moveToward(u, (cap % MAP_W) + 0.5, ((cap / MAP_W) | 0) + 0.5, speed);
      u.state = UnitState.Returning;
      return;
    }
    // Tank duels with hostile armor nearby.
    if ((g.tick + u.id) % 4 === 0) {
      g.unitGrid.query(u.x, u.y, 2.5, (o) => {
        if (o.dead || o.type !== UnitType.ArmoredDivision || o.owner === u.owner || !g.isHostile(u.owner, o.owner)) return;
        this.damage(o, 10 + this.rnd() * 8, u.owner);
        this.damage(u, 10 + this.rnd() * 8, o.owner);
        if ((g.tick + u.id) % 12 === 0) {
          g.emit({ type: 'combat', tick: g.tick, kind: 'artillery', owner: u.owner, fromX: u.x, fromY: u.y, toX: o.x, toY: o.y, hit: true });
        }
        return true;
      });
      if (u.dead) return;
    }
    if (u.mode === Mode.Deploy || u.mode === Mode.Front) {
      const arrived = this.advanceOverOwnLand(u, speed);
      const ahead = this.tileAhead(u);
      const aheadOwner = ahead >= 0 ? g.owner[ahead] : u.owner;
      const atFront = ahead >= 0 && aheadOwner !== u.owner && g.playable[ahead] && !g.isAllied(u.owner, aheadOwner);
      if (atFront && u.targetPlayer !== -2) {
        u.mode = Mode.Front;
        u.state = UnitState.Attacking;
        if (u.targetPlayer === -1 || u.targetPlayer !== aheadOwner) u.targetPlayer = aheadOwner;
        let fl = this.frontArmorByOwner.get(u.owner);
        if (!fl) this.frontArmorByOwner.set(u.owner, (fl = []));
        fl.push(u);
        if (u.cooldown <= 0) {
          g.attacks.armoredAssault(p, u, aheadOwner);
          u.cooldown = 40;
        }
        if ((g.tick + u.id) % 9 === 0) {
          g.emit({ type: 'combat', tick: g.tick, kind: 'artillery', owner: u.owner, fromX: u.x, fromY: u.y, toX: (ahead % MAP_W) + 0.5, toY: ((ahead / MAP_W) | 0) + 0.5, hit: true });
        }
      } else if (arrived) {
        const tgtOwner = u.targetTile >= 0 ? g.owner[u.targetTile] : u.owner;
        if (tgtOwner === u.owner && u.targetPlayer >= 0) {
          // Objective taken: keep rolling in the same direction while there is enemy land ahead.
          const dx = wdx(u.originX, u.toX), dy = u.toY - u.originY;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          u.originX = u.x;
          u.originY = u.y;
          u.toX = wrapXf(u.x + (dx / d) * 12);
          u.toY = Math.min(MAP_H - 1, Math.max(0, u.y + (dy / d) * 12));
          u.targetTile = Math.floor(u.toY) * MAP_W + Math.floor(u.toX);
          const no = g.owner[u.targetTile];
          if (!g.playable[u.targetTile] || no === u.owner || g.isAllied(u.owner, no)) {
            u.mode = Mode.None;
            u.state = UnitState.Idle;
          }
        } else {
          u.mode = Mode.None;
          u.state = UnitState.Idle;
        }
      } else {
        u.state = UnitState.Moving;
      }
      if (u.cooldown > 0) u.cooldown--;
    } else {
      u.state = UnitState.Idle;
      if (u.hp < u.maxHp && g.tick - u.lastHitTick > 50) u.hp = Math.min(u.maxHp, u.hp + 0.8);
    }
  }

  /** Drive toward (toX, toY) staying on own/allied land. Returns true when at the objective or blocked. */
  private advanceOverOwnLand(u: Unit, speed: number): boolean {
    const g = this.g;
    const dx = wdx(u.x, u.toX), dy = u.toY - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.6) return true;
    const step = Math.min(speed, d);
    const nx = wrapXf(u.x + (dx / d) * step), ny = u.y + (dy / d) * step;
    const t = Math.floor(ny) * MAP_W + Math.floor(nx);
    u.heading = Math.atan2(dx, -dy);
    if (t >= 0 && t < TILE_COUNT && g.playable[t] && (g.owner[t] === u.owner || g.isAllied(u.owner, g.owner[t]))) {
      u.x = nx;
      u.y = ny;
      return false;
    }
    // Blocked by the front line (or water): try to slide along it.
    for (const ang of [0.6, -0.6, 1.2, -1.2]) {
      const h = Math.atan2(dx, -dy) + ang;
      const sx = wrapXf(u.x + Math.sin(h) * step * 0.7), sy = u.y - Math.cos(h) * step * 0.7;
      const st = Math.floor(sy) * MAP_W + Math.floor(sx);
      if (st >= 0 && st < TILE_COUNT && g.playable[st] && g.owner[st] === u.owner) {
        const before = dist2(u.x, u.y, u.toX, u.toY);
        const after = dist2(sx, sy, u.toX, u.toY);
        if (after < before) {
          u.x = sx;
          u.y = sy;
          return false;
        }
      }
    }
    return true;
  }

  private tileAhead(u: Unit): number {
    const dx = wdx(u.x, u.toX), dy = u.toY - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.3) return Math.floor(u.y) * MAP_W + Math.floor(u.x);
    const ax = wrapXf(u.x + (dx / d) * 1.2), ay = u.y + (dy / d) * 1.2;
    if (ay < 0 || ay >= MAP_H) return -1;
    return Math.floor(ay) * MAP_W + Math.floor(ax);
  }

  // --- aircraft -------------------------------------------------------------------------------------------
  private stepAircraft(u: Unit): void {
    const g = this.g;
    const def = UNIT_DEFS[u.type];
    const base = g.structureMap.get(u.home);
    if (!base || base.owner !== u.owner) {
      // Home lost: divert to another airbase, or ditch.
      const nh = this.nearestHome(u.owner, u.type, u.x, u.y);
      if (nh === 0) {
        if (u.mode === Mode.Docked) {
          this.kill(u, 0);
          return;
        }
      } else {
        u.home = nh;
      }
    }
    if (u.mode === Mode.Docked) {
      u.state = UnitState.Docked;
      u.alt = 0;
      if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.002);
      if (u.type === UnitType.FighterSquadron && (g.tick + u.id) % 5 === 0) this.scramble(u);
      return;
    }
    u.fuel--;
    if (u.alt < 1) u.alt = Math.min(1, u.alt + 0.12);
    const home = g.structureMap.get(u.home);
    if (u.fuel <= 0 && u.mode !== Mode.Return) {
      u.mode = Mode.Return;
      u.targetUnit = 0;
    }
    switch (u.mode) {
      case Mode.Strike: {
        u.state = UnitState.Moving;
        if (this.moveToward(u, u.toX, u.toY, def.speed)) {
          if (u.type === UnitType.DroneSwarm) {
            g.weapons.airStrikeImpact(u, 'drone');
            this.remove(u, false);
            g.emit({ type: 'unitDestroyed', tick: g.tick, unitId: u.id, unit: u.type, owner: u.owner, by: 0, x: u.x, y: u.y });
            return;
          }
          g.weapons.airStrikeImpact(u, u.type === UnitType.Bomber ? 'bomb' : 'strafe');
          u.mode = Mode.Return;
          u.state = UnitState.Returning;
        } else u.state = UnitState.Attacking;
        return;
      }
      case Mode.Intercept: {
        const t = g.unitMap.get(u.targetUnit);
        const range = AIRBASE_INTERCEPT_RANGE * 1.6;
        if (!t || t.dead || (home && dist2(home.x, home.y, u.x, u.y) > range * range)) {
          u.targetUnit = 0;
          u.mode = Mode.Return;
          return;
        }
        u.state = UnitState.Attacking;
        const arrived = this.moveToward(u, t.x, t.y, def.speed);
        if (arrived || dist2(u.x, u.y, t.x, t.y) < 2.5) this.dogfight(u, t);
        return;
      }
      case Mode.Cap: {
        u.state = UnitState.Moving;
        const dx = wdx(u.x, u.toX), dy = u.toY - u.y;
        if (dx * dx + dy * dy > 30) this.moveToward(u, u.toX, u.toY, def.speed);
        else {
          // Orbit the patrol point.
          const ang = Math.atan2(dy, dx) + 0.5;
          this.moveToward(u, u.toX - Math.cos(ang) * 4, u.toY - Math.sin(ang) * 4, def.speed * 0.6);
        }
        if ((g.tick + u.id) % 4 === 0) {
          const hostile = this.findAirThreat(u, u.x, u.y, 20);
          if (hostile) {
            u.targetUnit = hostile.id;
            u.mode = Mode.Intercept;
          }
        }
        return;
      }
      default: {
        // Return to base and land.
        u.mode = Mode.Return;
        u.state = UnitState.Returning;
        if (!home) {
          this.kill(u, 0);
          return;
        }
        const d2 = dist2(u.x, u.y, home.x, home.y);
        if (d2 < 16) u.alt = Math.max(0.05, u.alt - 0.2);
        if (this.moveToward(u, home.x, home.y, def.speed)) {
          u.mode = Mode.Docked;
          u.state = UnitState.Docked;
          u.alt = 0;
          u.fuel = AIRCRAFT_FUEL_TICKS;
        }
      }
    }
  }

  /** Docked fighters launch at hostile aircraft & cruise missiles entering their base's airspace. */
  private scramble(u: Unit): void {
    const g = this.g;
    const base = g.structureMap.get(u.home);
    if (!base || !base.operational) return;
    const radar = g.economy.radarCovers(u.owner, base.x, base.y);
    const r = AIRBASE_INTERCEPT_RANGE * (radar ? 1.5 : 1);
    const threat = this.findAirThreat(u, base.x, base.y, r);
    if (threat) {
      this.takeOff(u);
      u.alt = 0.2;
      u.mode = Mode.Intercept;
      u.targetUnit = threat.id;
    }
  }

  private findAirThreat(u: Unit, x: number, y: number, r: number): Unit | null {
    const g = this.g;
    let best: Unit | null = null, bestD = Infinity;
    g.unitGrid.query(x, y, r, (o, d2) => {
      if (o.dead || o.owner === u.owner || g.isAllied(u.owner, o.owner)) return;
      if (o.type !== UnitType.Bomber && o.type !== UnitType.DroneSwarm && o.type !== UnitType.CruiseMissile && o.type !== UnitType.FighterSquadron) return;
      if (o.mode === Mode.Docked) return;
      const tgt = o.targetTile >= 0 && o.targetTile < TILE_COUNT ? g.owner[o.targetTile] : 0;
      const threat = tgt === u.owner || g.isAllied(u.owner, tgt) || g.isHostile(u.owner, o.owner);
      if (!threat) return;
      if (o.engagedBy > 1 && o.type !== UnitType.FighterSquadron) return;
      if (d2 < bestD) {
        bestD = d2;
        best = o;
      }
    });
    if (best) (best as Unit).engagedBy++;
    return best;
  }

  private dogfight(u: Unit, t: Unit): void {
    const g = this.g;
    if ((g.tick + u.id) % 3 === 0) {
      g.emit({ type: 'combat', tick: g.tick, kind: 'strafe', owner: u.owner, fromX: u.x, fromY: u.y, toX: t.x, toY: t.y, hit: true });
    }
    if (t.type === UnitType.FighterSquadron) {
      this.damage(t, 6 + this.rnd() * 10, u.owner);
      if (!t.dead && t.mode !== Mode.Intercept) {
        t.mode = Mode.Intercept;
        t.targetUnit = u.id;
      }
    } else {
      const p = t.type === UnitType.CruiseMissile ? 0.18 : t.type === UnitType.DroneSwarm ? 0.35 : 0.25;
      if (this.rnd() < p) {
        if (t.type === UnitType.CruiseMissile) g.weapons.intercept(t, u.owner, false);
        else this.kill(t, u.owner);
      } else if (t.type === UnitType.Bomber && this.rnd() < 0.15) {
        this.damage(u, 20, t.owner); // tail gunners
      }
    }
    if (t.dead) {
      u.targetUnit = 0;
      u.mode = Mode.Return;
    }
  }

  // --- trains -------------------------------------------------------------------------------------------
  private stepTrain(u: Unit): void {
    const g = this.g;
    const path = u.path;
    if (!path) {
      this.remove(u, false);
      return;
    }
    u.state = UnitState.Moving;
    const speed = UNIT_DEFS[UnitType.Train].speed;
    let budget = speed;
    while (budget > 1e-6 && u.pathI < path.length) {
      const sid = path[u.pathI];
      const s = u.aux < 0 ? null : g.structureMap.get(sid);
      const tx = s ? s.x : (sid % MAP_W) + 0.5, ty = s ? s.y : ((sid / MAP_W) | 0) + 0.5;
      if (u.aux >= 0 && (!s || (s.owner !== u.owner && !g.isAllied(u.owner, s.owner)))) {
        this.remove(u, false); // the line was cut
        return;
      }
      const dx = wdx(u.x, tx), dy = ty - u.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1e-6) u.heading = Math.atan2(dx, -dy);
      if (d <= budget) {
        u.x = wrapXf(tx);
        u.y = ty;
        budget -= d;
        u.pathI++;
      } else {
        u.x = wrapXf(u.x + (dx / d) * budget);
        u.y += (dy / d) * budget;
        budget = 0;
      }
    }
    if (u.pathI < path.length) return;
    const last = u.aux < 0 ? null : g.structureMap.get(path[path.length - 1]);
    const tile = last ? last.tile : Math.floor(u.y) * MAP_W + Math.floor(u.x);
    if (u.cargo > 0) {
      g.addGold(u.owner, u.cargo);
      g.emit({ type: 'goldBonus', tick: g.tick, playerId: u.owner, gold: Math.round(u.cargo), tile, reason: 'train' });
      if (last && last.owner !== u.owner && g.isAllied(u.owner, last.owner)) {
        const share = Math.round(u.cargo * 0.5);
        g.addGold(last.owner, share);
        g.emit({ type: 'goldBonus', tick: g.tick, playerId: last.owner, gold: share, tile, reason: 'train' });
      }
    }
    this.remove(u, false);
  }

  /** Spawn a trade ship between two ports (economy decides when). */
  launchTrade(from: Structure, to: Structure): boolean {
    const g = this.g;
    const nav = g.nav;
    const comps: number[] = [];
    nav.coastComponents(from.tile, comps);
    const other: number[] = [];
    nav.coastComponents(to.tile, other);
    const c = comps.find((x) => other.includes(x));
    if (c === undefined) return false;
    const a = nav.waterNear(from.tile, c), b = nav.waterNear(to.tile, c);
    if (a < 0 || b < 0) return false;
    if (!nav.canSearch()) {
      // Cached routes still work when the search budget is spent.
      const path = nav.findPath(a, b, true);
      if (!path) return false;
      return this.spawnTrade(from, to, path, a);
    }
    const path = nav.findPath(a, b, true);
    if (!path) return false;
    return this.spawnTrade(from, to, path, a);
  }

  private spawnTrade(from: Structure, to: Structure, path: Int32Array, start: number): boolean {
    const g = this.g;
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      const p0 = path[i - 1], p1 = path[i];
      len += Math.sqrt(dist2((p0 % MAP_W) + 0.5, ((p0 / MAP_W) | 0) + 0.5, (p1 % MAP_W) + 0.5, ((p1 / MAP_W) | 0) + 0.5));
    }
    const u = this.spawn(UnitType.TradeShip, from.owner, (start % MAP_W) + 0.5, ((start / MAP_W) | 0) + 0.5);
    u.path = path;
    u.pathI = 1;
    u.mode = Mode.Sail;
    u.state = UnitState.Moving;
    u.home = from.id;
    u.targetStructure = to.id;
    u.targetPlayer = to.owner;
    u.cargo = tradeGold(len) * (0.5 + 0.25 * (from.level + to.level)) / 1.0;
    u.toX = to.x;
    u.toY = to.y;
    u.targetTile = to.tile;
    return true;
  }

  /** Spawn a train following a list of station ids. */
  launchTrain(owner: number, stations: number[], cargo: number): void {
    const g = this.g;
    const first = g.structureMap.get(stations[0]);
    const last = g.structureMap.get(stations[stations.length - 1]);
    if (!first || !last) return;
    const u = this.spawn(UnitType.Train, owner, first.x, first.y);
    u.path = Int32Array.from(stations);
    u.pathI = 1;
    u.mode = Mode.Rail;
    u.state = UnitState.Moving;
    u.cargo = cargo;
    u.home = first.id;
    u.targetStructure = last.id;
    u.toX = last.x;
    u.toY = last.y;
    u.targetTile = last.tile;
  }
}

const NO_UNITS: readonly Unit[] = [];

export { AIR_TYPES, PROJECTILES, RADAR_RANGE };
