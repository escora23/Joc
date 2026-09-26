// FRONT ULTRA — mobile units: transport convoys (naval invasions), trade ships, warships, armored divisions, fighter
// squadrons, bombers, drone swarms and trains. Owner: sim-core (v2: W4). Worker-only.
// Missiles, nukes, SAM interceptors and shells are flown by weapons.ts (they share the unit maps).
//
// v2 (DESIGN_V2 §6.3, §6.4, §7): every unit has a job and takes explicit orders (unitOrder, validated by the shared
// orders.ts rules the UI previews with):
//   * divisions march over own, allied and open-border land at 40 km/h (A* over allowed tiles), take the train at
//     100 km/h when a rail route is faster, attach to fronts (attack +25 % power and pressure ×1.5 around them, defense
//     +25 % and enemy advance time ×1.4, via frontSupport), wear while engaged and repair on quiet fronts and at bases;
//   * fighters fly persistent combat air patrols that intercept raids crossing their circle, intercept, escort and
//     rebase; bombers and drones fly sorties at their mission speed and the strike resolves when they arrive;
//   * warships move, patrol, blockade (capturing enemy trade and engaging convoys), bombard coasts, escort convoys;
//   * production is a queue per base with an ETA and a unitReady event; units carry ordinals;
//   * paths are published once per plan (TickUpdate.routes) and air raids are announced to their target (airRaid).

import {
  AIR_RAID_OBSERVER_KM, BOMBARD_GARRISON_PER_HOUR, BOMBER_DIRECT_DMG, BOMBER_DIVISION_DMG, BOMBER_GARRISON_SHARE,
  BOMBER_STRUCT_DMG, CAP_HIT_AIRCRAFT, CAP_HIT_CRUISE, CAP_RADIUS_TILES, CONVOY_HIT, DEFENSE_REAR_SHARE,
  DIVISION_ATTACH_TILES, DIVISION_FIELD_REPAIR, DIVISION_WEAR_AT_CAP, DIVISION_WEAR_ENGAGED, DRONE_DIRECT_DMG,
  DRONE_GARRISON_PER_HOUR, DRONE_STRUCT_DMG, DRONE_SUPPORT_TILES, EMBARK_PORT_RANGE_KM, EMBARK_SHORE_TICKS, ESCORT_SURVIVAL,
  ESCORT_TILES, HUMAN_ID, INVASION_DETECT_TILES, MAP_H, MAP_W, OFFENSIVE_CONTACT_TICKS, PORT_TRADE_GOLD_PER_HOUR,
  RADAR_SCRAMBLE_MUL, RAIL_GOLD_PER_HOUR, REARM_TICKS, TILE_COUNT, TILE_KM, TRADE_AGREEMENT_BONUS, TRADE_DEST_SHARE,
  UNIT_DEFS, WARSHIP_BOMBARD_TILES, WARSHIP_ENGAGE_TILES, WARSHIP_HIT, WARSHIP_HOME_PATROL_TILES, ADVANCE_MAX_KMH,
  kmhToKmPerTick, structureLevel, ARMOR_RAIL_KMH,
} from '../shared/constants';
import {
  baseCapacity, canTransit, hostileTo, homeTypeOf, inferOrder, isAircraft, orderCheck, planDivision, strikeTarget, tileCx,
  tileCy, tileKm, type StationLike,
} from '../shared/orders';
import {
  StructureType, UNIT_ORDER_KINDS, UnitMode, UnitState, UnitType, type BuildableUnit, type ProductionView,
  type UnitOrderKind,
} from '../shared/types';
import { MAX_BOATS, WARSHIP_FIRE_COOLDOWN, tradeGold, trainGold } from './balance';
import type { Game } from './game';
import { TileHeap } from './heap';
import { Attack, Mode, Player, Structure, Unit } from './state';
import { advanceKm, dist2, distKm, latCos, wdx, wrapXf } from './spatial';

const AIR_TYPES = new Set<number>([UnitType.FighterSquadron, UnitType.Bomber, UnitType.DroneSwarm]);
const PROJECTILES = new Set<number>([
  UnitType.CruiseMissile, UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.Mirv, UnitType.MirvWarhead,
  UnitType.SamInterceptor, UnitType.Shell,
]);
const ORDER_CODE = new Map<UnitOrderKind, number>(UNIT_ORDER_KINDS.map((k, i) => [k, i]));
const orderCode = (k: UnitOrderKind): number => ORDER_CODE.get(k) ?? -1;

/** Kilometres each unit type covers per tick (from UNIT_DEFS.speedKmh, §2.3). */
const KM_PER_TICK: Record<number, number> = Object.fromEntries(
  Object.values(UNIT_DEFS).map((d) => [d.type, kmhToKmPerTick(d.speedKmh)]),
);
const RAIL_KM_PER_TICK = kmhToKmPerTick(ARMOR_RAIL_KMH);
/** Strike kinds stored on a sortie. */
const SK_STRUCT = 1, SK_DIV = 2, SK_SHIP = 3, SK_FRONT = 4;
/** A* budget (expanded tiles) for a division's road march. */
const LAND_SEARCH_BUDGET = 60_000;

/** Units supporting one offensive (§4.4): the attacker's and the defender's attached divisions, drones, warships. */
export interface FrontSupport {
  atk: Unit[];
  def: Unit[];
  /** Drone swarms supporting each side over this front. */
  dronesAtk: number;
  dronesDef: number;
  /** Warships bombarding the defender's coast within reach of the corridor. */
  navalAtk: number;
}

export class UnitSystem {
  private readonly comps: number[] = [];
  private readonly rnd: () => number;
  private readonly scratch: Unit[] = [];
  private readonly stations: StationLike[] = [];
  /** Routes planned since the last update (TickUpdate.routes). */
  private readonly routesOut: Unit[] = [];
  /** The human's production queue changed. */
  productionDirty = true;
  /** Per-tick cache of the support of each offensive. */
  private supportTick = -1;
  private readonly support = new Map<number, FrontSupport>();
  // A* scratch (never saved).
  private readonly heap = new TileHeap(4096);
  private readonly aStamp = new Int32Array(TILE_COUNT);
  private readonly aG = new Float32Array(TILE_COUNT);
  private readonly aParent = new Int32Array(TILE_COUNT);
  private aGen = 0;

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
    u.bornTick = g.tick;
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

  /** Units homed at a base plus the units queued there (capacity, §6.2). */
  hostedAt(structureId: number): number {
    const g = this.g;
    const s = g.structureMap.get(structureId);
    if (!s) return 0;
    let n = s.queue.length;
    for (const u of g.unitsByOwner.get(s.owner) ?? []) if (u.home === structureId && homeTypeOf(u.type) === s.type) n++;
    return n;
  }

  // =================================================================================================
  // Published state
  // =================================================================================================
  /** The mode a client reads (UF.mode). */
  publicMode(u: Unit): UnitMode {
    const g = this.g;
    switch (u.type) {
      case UnitType.ArmoredDivision:
        if (u.mode === Mode.Rail) return UnitMode.Rail;
        if (u.mode === Mode.Deploy) return UnitMode.Moving;
        if (u.mode === Mode.Return) return UnitMode.Returning;
        if (u.mode === Mode.Front) return u.onOffensive ? UnitMode.Offensive : UnitMode.Front;
        return UnitMode.Idle;
      case UnitType.FighterSquadron:
      case UnitType.Bomber:
      case UnitType.DroneSwarm:
        switch (u.mode) {
          case Mode.Docked: return u.readyTick > g.tick ? UnitMode.Rearming : UnitMode.Docked;
          case Mode.Cap: return UnitMode.Patrol;
          case Mode.Intercept: return UnitMode.Intercept;
          case Mode.Chase: return UnitMode.Escort;
          case Mode.Strike: return UnitMode.Strike;
          case Mode.Patrol: return UnitMode.Support;
          case Mode.Return: return UnitMode.Returning;
          default: return UnitMode.Moving;
        }
      case UnitType.Warship:
        if (u.state === UnitState.Attacking) return UnitMode.Engaged;
        switch (u.mode) {
          case Mode.Sail: return UnitMode.Moving;
          case Mode.Return: return UnitMode.Returning;
          case Mode.Blockade: return UnitMode.Blockade;
          case Mode.Bombard: return UnitMode.Bombard;
          case Mode.Escort: return UnitMode.Escort;
          case Mode.Chase: return UnitMode.Engaged;
          case Mode.Patrol: return u.order >= 0 ? UnitMode.Patrol : UnitMode.Idle;
          default: return UnitMode.Idle;
        }
      case UnitType.TransportShip:
        return g.tick < u.embarkUntil ? UnitMode.Embarking : u.mode === Mode.Return ? UnitMode.Returning : UnitMode.Moving;
      default:
        return u.state === UnitState.Idle ? UnitMode.Idle : UnitMode.Moving;
    }
  }

  /** Routes planned since the last call (unit id, waypoint tiles). A full resync sends every live path. */
  takeRoutes(full: boolean): { unitId: number; tiles: Int32Array }[] | undefined {
    const out: { unitId: number; tiles: Int32Array }[] = [];
    const push = (u: Unit) => {
      if (u.dead || !u.path) return;
      u.routeDirty = false;
      out.push({ unitId: u.id, tiles: this.routeTiles(u) });
    };
    if (full) {
      for (const u of this.g.unitMap.values()) if (u.path && u.type !== UnitType.Shell) push(u);
    } else {
      for (const u of this.routesOut) if (u.routeDirty) push(u);
    }
    this.routesOut.length = 0;
    return out.length ? out : undefined;
  }

  private routeTiles(u: Unit): Int32Array {
    const path = u.path!;
    if (u.type !== UnitType.Train || u.aux < 0) return Int32Array.from(path);
    // Trains follow station ids: publish the stations' tiles.
    const out = new Int32Array(path.length);
    for (let i = 0; i < path.length; i++) out[i] = this.g.structureMap.get(path[i])?.tile ?? 0;
    return out;
  }

  private publishRoute(u: Unit): void {
    if (!u.routeDirty) this.routesOut.push(u);
    u.routeDirty = true;
  }

  /** The human's production queue (TickUpdate.production). */
  productionViews(): ProductionView[] {
    const out: ProductionView[] = [];
    for (const s of this.g.structByOwner.get(HUMAN_ID) ?? []) {
      for (const q of s.queue) out.push({ structureId: s.id, unit: q.unit, startTick: q.startTick, readyTick: q.readyTick, serial: q.serial });
    }
    out.sort((a, b) => a.readyTick - b.readyTick);
    return out;
  }

  // =================================================================================================
  // Front support (§4.4): what attacks.ts adds to an offensive's power and pressure
  // =================================================================================================
  /** Attached divisions, drones and warships supporting offensive `attackId` (cached per tick). */
  frontSupport(attackId: number): FrontSupport {
    const g = this.g;
    if (this.supportTick !== g.tick) {
      this.supportTick = g.tick;
      for (const s of this.support.values()) {
        s.atk.length = 0;
        s.def.length = 0;
        s.dronesAtk = s.dronesDef = s.navalAtk = 0;
      }
    }
    let s = this.support.get(attackId);
    if (s && s.atk.length + s.def.length + s.dronesAtk + s.dronesDef + s.navalAtk > 0) return s;
    if (!s) {
      s = { atk: [], def: [], dronesAtk: 0, dronesDef: 0, navalAtk: 0 };
      this.support.set(attackId, s);
    }
    const a = g.attacks.byId(attackId);
    if (!a || a.ended || a.defender <= 0) return s;
    const reach = a.frontage / 2 + DIVISION_ATTACH_TILES;
    const scan = (owner: number, fn: (u: Unit) => void) => {
      for (const u of g.unitsByOwner.get(owner) ?? []) if (!u.dead && u.state !== UnitState.Controlled) fn(u);
    };
    scan(a.attacker, (u) => {
      if (u.type === UnitType.ArmoredDivision && u.mode === Mode.Front && u.enemy === a.defender && nearAxis(a, u.x, u.y, reach)) s!.atk.push(u);
      else if (u.type === UnitType.DroneSwarm && u.mode === Mode.Patrol && u.enemy === a.defender && this.atStation(u) && nearAxis(a, u.stationX, u.stationY, reach)) s!.dronesAtk++;
      else if (u.type === UnitType.Warship && u.mode === Mode.Bombard && u.enemy === a.defender && this.atStation(u) && nearAxis(a, u.stationX, u.stationY, reach + WARSHIP_BOMBARD_TILES)) s!.navalAtk++;
    });
    scan(a.defender, (u) => {
      if (u.type === UnitType.ArmoredDivision && u.mode === Mode.Front && u.enemy === a.attacker && nearAxis(a, u.x, u.y, reach + DIVISION_ATTACH_TILES)) s!.def.push(u);
      else if (u.type === UnitType.DroneSwarm && u.mode === Mode.Patrol && u.enemy === a.attacker && this.atStation(u) && nearAxis(a, u.stationX, u.stationY, reach)) s!.dronesDef++;
    });
    return s;
  }

  /** Attached divisions of `p` near a front's contact line (FrontView.divisionsA/B). */
  divisionsNear(p: number, samples: readonly number[] | Float32Array, enemy: number): number {
    let n = 0;
    for (const u of this.g.unitsByOwner.get(p) ?? []) {
      if (u.type !== UnitType.ArmoredDivision || u.mode !== Mode.Front || u.enemy !== enemy) continue;
      for (let i = 0; i < samples.length; i += 2) {
        const dx = wdx(u.x, samples[i]), dy = samples[i + 1] - u.y;
        if (dx * dx + dy * dy <= (DIVISION_ATTACH_TILES + 1) ** 2) {
          n++;
          break;
        }
      }
    }
    return n;
  }

  private atStation(u: Unit): boolean {
    return dist2(u.x, u.y, u.stationX, u.stationY) <= 4;
  }

  // =================================================================================================
  // Orders (unitOrder, §6.4, §7.3)
  // =================================================================================================
  /** A unitOrder from `p`: every unit is validated with the shared rules; the ack says who took it. */
  order(p: Player, unitIds: number[], order: UnitOrderKind, tile: number, targetId: number, ratio?: number, confirm?: boolean): boolean {
    const g = this.g;
    if (g.phase !== 'playing' || !Array.isArray(unitIds)) return false;
    const accepted: number[] = [];
    let firstErr: string | null = null;
    let strategicConfirmed = false;
    const ai = p.kind !== 'human';
    for (const id of unitIds.slice(0, 64)) {
      const u = g.unitMap.get(id);
      if (!u || u.dead || u.owner !== p.id) {
        firstErr ??= 'order.err.noUnit';
        continue;
      }
      const err = orderCheck(g.rules, id, order, tile, targetId, { confirm, ai });
      if (err) {
        firstErr ??= err.key;
        continue;
      }
      if (this.apply(p, u, order, tile, targetId)) {
        accepted.push(id);
        if (confirm && order === 'strike') strategicConfirmed = true;
      }
    }
    if (accepted.length && order === 'attack' && ratio !== undefined && ratio > 0) this.launchFromDivision(p, tile, ratio);
    if (strategicConfirmed) {
      const tgt = strikeTarget(g.rules, tile, targetId);
      if (tgt && tgt.strategic && g.war.escalation(p.id, tgt.owner) < 2) g.war.raiseEscalation(p.id, tgt.owner, 2, 'escalation.reason.player');
    }
    if (p.id === HUMAN_ID) {
      g.emit({ type: 'orderAck', tick: g.tick, owner: p.id, order, unitIds: unitIds.slice(0, 64), accepted, tile, errorKey: accepted.length ? null : firstErr });
      if (!accepted.length && firstErr) g.message(p.id, firstErr, 'warning');
    }
    return accepted.length > 0;
  }

  /** Carry out a validated order. */
  private apply(p: Player, u: Unit, order: UnitOrderKind, tile: number, targetId: number): boolean {
    u.order = orderCode(order);
    switch (u.type) {
      case UnitType.ArmoredDivision: return this.orderDivision(p, u, order, tile);
      case UnitType.Warship: return this.orderWarship(p, u, order, tile, targetId);
      default: return this.orderAircraft(p, u, order, tile, targetId);
    }
  }

  /** «Atacar hacia aquí» without an offensive on that front: launch one with the slider share (§6.4). */
  private launchFromDivision(p: Player, tile: number, ratio: number): void {
    const g = this.g;
    const o = g.owner[tile];
    if (o <= 0) return;
    for (const a of g.attackList) {
      if (!a.ended && !a.naval && a.attacker === p.id && a.defender === o) {
        g.attacks.setAxis(a, tile);
        return;
      }
    }
    g.attacks.command(p, o, Math.min(1, Math.max(0.01, ratio)), tile);
  }

  // --- divisions ---------------------------------------------------------------------------------------
  private orderDivision(p: Player, u: Unit, order: UnitOrderKind, tile: number): boolean {
    const g = this.g;
    switch (order) {
      case 'hold':
        this.stopDivision(u);
        u.order = orderCode('hold');
        return true;
      case 'return': {
        const base = this.nearestOwn(u.owner, StructureType.ArmyBase, u.x, u.y);
        if (!base) return false;
        u.enemy = 0;
        return this.marchTo(u, base.tile, Mode.Return);
      }
      case 'move':
        u.enemy = 0;
        u.frontKey = 0;
        return this.marchTo(u, tile, Mode.Deploy);
      case 'attach':
      case 'attack': {
        const enemy = g.owner[tile];
        const rally = this.rallyTile(u.owner, enemy, tile);
        if (rally < 0) return false;
        u.enemy = enemy;
        const f = g.fronts.frontAt(u.owner, enemy, tileCx(rally), tileCy(rally));
        u.frontKey = f?.key ?? 0;
        if (order === 'attack') {
          // Set the axis of our offensive on this front toward the click.
          for (const a of g.attackList) {
            if (!a.ended && !a.naval && a.attacker === p.id && a.defender === enemy) {
              g.attacks.setAxis(a, tile);
              break;
            }
          }
        }
        if (dist2(u.x, u.y, tileCx(rally), tileCy(rally)) <= DIVISION_ATTACH_TILES ** 2) {
          this.attach(u, enemy);
          return true;
        }
        return this.marchTo(u, rally, Mode.Deploy);
      }
      default:
        return false;
    }
  }

  private stopDivision(u: Unit): void {
    u.mode = Mode.None;
    u.state = UnitState.Idle;
    u.path = null;
    u.pathRail = null;
    u.toX = u.x;
    u.toY = u.y;
    u.eta = -1;
  }

  private attach(u: Unit, enemy: number): void {
    u.mode = Mode.Front;
    u.state = UnitState.Attacking;
    u.enemy = enemy;
    u.path = null;
    u.pathRail = null;
    u.eta = -1;
    const f = this.g.fronts.frontAt(u.owner, enemy, u.x, u.y);
    if (f) u.frontKey = f.key;
  }

  /** Plan and start a march (road or rail) to `tile`; `mode` = Deploy (move/attach) or Return. */
  private marchTo(u: Unit, tile: number, mode: Mode): boolean {
    const g = this.g;
    const route = planDivision(g.rules, { id: u.id, type: u.type, owner: u.owner, x: u.x, y: u.y, state: u.state, mode: this.publicMode(u), home: u.home, etaTicks: u.eta }, tile, this.stations);
    const here = tileOf(u.x, u.y);
    const waypoints: number[] = [];
    const rail: number[] = [];
    const road = (from: number, to: number): boolean => {
      const p = this.landPath(u.owner, from, to);
      if (!p) return false;
      for (let i = 1; i < p.length; i++) {
        waypoints.push(p[i]);
        rail.push(0);
      }
      return true;
    };
    let ok = false;
    if (route.rail && route.stations.length >= 2) {
      const first = g.structureMap.get(route.stations[0])!, last = g.structureMap.get(route.stations[route.stations.length - 1])!;
      if (road(here, first.tile)) {
        for (let i = 1; i < route.stations.length; i++) {
          waypoints.push(g.structureMap.get(route.stations[i])!.tile);
          rail.push(1);
        }
        ok = road(last.tile, tile);
      }
      if (!ok) {
        waypoints.length = 0;
        rail.length = 0;
      }
    }
    if (!ok) ok = road(here, tile);
    if (!ok) {
      // No path over allowed land within the budget: the order still stands, the division drives as far as it can.
      waypoints.length = 0;
      rail.length = 0;
      waypoints.push(tile);
      rail.push(0);
    }
    u.path = Int32Array.from(waypoints);
    u.pathRail = Uint8Array.from(rail);
    u.pathI = 0;
    u.mode = mode;
    u.state = mode === Mode.Return ? UnitState.Returning : UnitState.Moving;
    u.originX = u.x;
    u.originY = u.y;
    u.toX = tileCx(tile);
    u.toY = tileCy(tile);
    u.targetTile = tile;
    this.publishRoute(u);
    u.eta = this.pathEta(u);
    return true;
  }

  /** Own tile touching `enemy` nearest to `tile` (the division's rally point on the front line), -1 if none. */
  private rallyTile(owner: number, enemy: number, tile: number): number {
    const g = this.g;
    const cx = tile % MAP_W, cy = (tile / MAP_W) | 0;
    const nb = [0, 0, 0, 0];
    const touches = (t: number): boolean => {
      const x = t % MAP_W;
      nb[0] = x === 0 ? t + MAP_W - 1 : t - 1;
      nb[1] = x === MAP_W - 1 ? t - MAP_W + 1 : t + 1;
      nb[2] = t >= MAP_W ? t - MAP_W : -1;
      nb[3] = t < TILE_COUNT - MAP_W ? t + MAP_W : -1;
      for (const q of nb) if (q >= 0 && g.owner[q] === enemy) return true;
      return false;
    };
    for (let r = 0; r <= 60; r++) {
      let best = -1, bd = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= MAP_H) continue;
        const step = Math.abs(dy) === r ? 1 : 2 * r;
        for (let dx = -r; dx <= r; dx += Math.max(1, step)) {
          const t = y * MAP_W + (((cx + dx) % MAP_W) + MAP_W) % MAP_W;
          if (g.owner[t] !== owner || !g.playable[t] || !touches(t)) continue;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = t;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * A* over land a division of `owner` may enter (own, allied, open borders), 8-neighbourhood, km costs. Returns the
   * tile path from `from` to `to` (both included), or null when the budget runs out or nothing connects them.
   */
  private landPath(owner: number, from: number, to: number): Int32Array | null {
    const g = this.g;
    if (from === to) return Int32Array.of(from, to);
    const ok = (t: number): boolean => g.playable[t] === 1 && canTransit(g.rules, owner, g.owner[t]);
    if (!ok(to)) return null;
    const gen = ++this.aGen;
    const stamp = this.aStamp, G = this.aG, parent = this.aParent, heap = this.heap;
    heap.clear();
    const tx = tileCx(to), ty = tileCy(to);
    stamp[from] = gen;
    G[from] = 0;
    parent[from] = -1;
    heap.push(from, tileKm(tileCx(from), tileCy(from), tx, ty));
    let expanded = 0;
    while (heap.size > 0 && expanded < LAND_SEARCH_BUDGET) {
      const t = heap.pop();
      if (t === to) break;
      expanded++;
      const x = t % MAP_W, y = (t / MAP_W) | 0;
      const gt = G[t];
      const cxT = x + 0.5, cyT = y + 0.5;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= MAP_H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const n = ny * MAP_W + (((x + dx) % MAP_W) + MAP_W) % MAP_W;
          if (!ok(n) && n !== to) continue;
          const step = tileKm(cxT, cyT, cxT + dx, cyT + dy);
          const ng = gt + step;
          if (stamp[n] === gen && G[n] <= ng) continue;
          stamp[n] = gen;
          G[n] = ng;
          parent[n] = t;
          heap.push(n, ng + tileKm(cxT + dx, cyT + dy, tx, ty));
        }
      }
    }
    if (stamp[to] !== gen) return null;
    const rev: number[] = [];
    for (let t = to; t !== -1; t = parent[t]) {
      rev.push(t);
      if (rev.length > 20_000) return null;
    }
    rev.reverse();
    // Keep the corners only (straight runs are collapsed): fewer waypoints, the same route.
    const out: number[] = [rev[0]];
    for (let i = 1; i < rev.length - 1; i++) {
      const a = rev[i - 1], b = rev[i], c = rev[i + 1];
      const d1x = wdxI(a, b), d1y = ((b / MAP_W) | 0) - ((a / MAP_W) | 0);
      const d2x = wdxI(b, c), d2y = ((c / MAP_W) | 0) - ((b / MAP_W) | 0);
      if (d1x !== d2x || d1y !== d2y) out.push(b);
    }
    out.push(rev[rev.length - 1]);
    return Int32Array.from(out);
  }

  // --- warships ---------------------------------------------------------------------------------------
  private orderWarship(p: Player, u: Unit, order: UnitOrderKind, tile: number, targetId: number): boolean {
    const g = this.g;
    u.targetUnit = 0;
    u.enemy = 0;
    switch (order) {
      case 'hold':
        u.path = null;
        u.stationX = u.x;
        u.stationY = u.y;
        u.anchorTile = tileOf(u.x, u.y);
        u.mode = Mode.Patrol;
        return true;
      case 'move':
      case 'patrol':
        return this.sailTo(u, tile, order === 'patrol' ? Mode.Patrol : Mode.Sail);
      case 'blockade':
        u.enemy = this.enemyNear(u.owner, tile, WARSHIP_ENGAGE_TILES);
        return this.sailTo(u, tile, Mode.Blockade);
      case 'bombard': {
        const o = g.owner[tile];
        u.enemy = o;
        // Station: the water tile nearest to the target within reach.
        const w = this.waterNearTile(tile, WARSHIP_BOMBARD_TILES, g.nav.comp[this.nearestWater(u)]);
        if (w < 0) return false;
        this.raiseMilitary(p, o);
        const ok = this.sailTo(u, w, Mode.Bombard);
        u.targetTile = tile;
        return ok;
      }
      case 'attack': {
        const t = g.unitMap.get(targetId);
        if (!t) return false;
        u.targetUnit = t.id;
        u.mode = Mode.Chase;
        u.enemy = t.owner;
        u.path = null;
        return true;
      }
      case 'escort': {
        const t = g.unitMap.get(targetId);
        if (!t) return false;
        u.targetUnit = t.id;
        u.mode = Mode.Escort;
        u.path = null;
        return true;
      }
      case 'return': {
        const base = this.nearestOwn(u.owner, StructureType.NavalYard, u.x, u.y) ?? this.nearestOwn(u.owner, StructureType.Port, u.x, u.y);
        if (!base) return false;
        const w = g.nav.waterNear(base.tile, g.nav.comp[this.nearestWater(u)]);
        if (w < 0) return false;
        if (base.type === StructureType.NavalYard) u.home = base.id;
        return this.sailTo(u, w, Mode.Return);
      }
      default:
        return false;
    }
  }

  private sailTo(u: Unit, tile: number, mode: Mode): boolean {
    const g = this.g;
    const here = this.nearestWater(u);
    const c = g.nav.comp[here];
    const dest = g.nav.comp[tile] === c ? tile : g.nav.waterNear(tile, c);
    if (dest < 0) return false;
    u.anchorTile = dest;
    u.stationX = tileCx(dest);
    u.stationY = tileCy(dest);
    u.toX = u.stationX;
    u.toY = u.stationY;
    u.targetTile = dest;
    u.mode = mode;
    u.state = UnitState.Moving;
    u.originX = u.x;
    u.originY = u.y;
    this.planPath(u, here, dest, false);
    return true;
  }

  // --- aircraft -----------------------------------------------------------------------------------------
  private orderAircraft(p: Player, u: Unit, order: UnitOrderKind, tile: number, targetId: number): boolean {
    const g = this.g;
    u.targetUnit = 0;
    switch (order) {
      case 'return':
        u.mode = Mode.Return;
        u.state = UnitState.Returning;
        return true;
      case 'rebase': {
        const s = g.structureMap.get(targetId) ?? g.structureMap.get(g.structAt[tile]);
        if (!s) return false;
        u.home = s.id;
        if (u.mode === Mode.Docked) this.takeOff(u);
        u.mode = Mode.Return;
        u.state = UnitState.Returning;
        return true;
      }
      case 'cap':
        this.takeOff(u);
        u.mode = Mode.Cap;
        u.stationX = tileCx(tile);
        u.stationY = tileCy(tile);
        u.toX = u.stationX;
        u.toY = u.stationY;
        u.targetTile = tile;
        return true;
      case 'intercept': {
        const t = g.unitMap.get(targetId);
        if (!t) return false;
        this.takeOff(u);
        u.mode = Mode.Intercept;
        u.targetUnit = t.id;
        return true;
      }
      case 'escort': {
        const t = g.unitMap.get(targetId);
        if (!t) return false;
        this.takeOff(u);
        u.mode = Mode.Chase;
        u.targetUnit = t.id;
        return true;
      }
      case 'support': {
        this.takeOff(u);
        u.mode = Mode.Patrol;
        u.stationX = tileCx(tile);
        u.stationY = tileCy(tile);
        u.toX = u.stationX;
        u.toY = u.stationY;
        u.targetTile = tile;
        u.enemy = this.enemyNear(u.owner, tile, DRONE_SUPPORT_TILES + 1);
        if (u.enemy) this.raiseMilitary(p, u.enemy);
        return true;
      }
      case 'strike': {
        const tgt = strikeTarget(g.rules, tile, targetId);
        if (!tgt) return false;
        this.takeOff(u);
        u.mode = Mode.Strike;
        u.state = UnitState.Moving;
        u.strikeKind = tgt.kind === 'structure' ? SK_STRUCT : tgt.kind === 'division' ? SK_DIV : tgt.kind === 'ship' ? SK_SHIP : SK_FRONT;
        u.targetUnit = tgt.kind === 'division' || tgt.kind === 'ship' ? tgt.id : 0;
        u.targetStructure = tgt.kind === 'structure' ? tgt.id : 0;
        u.targetPlayer = tgt.owner;
        u.toX = tgt.x;
        u.toY = tgt.y;
        u.targetTile = tileOf(tgt.x, tgt.y);
        u.raidAnnounced = false;
        if (!tgt.strategic) this.raiseMilitary(p, tgt.owner);
        if (tgt.owner > 0) g.attacks.onHostileAct(p.id, tgt.owner);
        this.checkRaid(u, true);
        return true;
      }
      default:
        return false;
    }
  }

  /** The human's first military strike raises its escalation to L1 (announced, no prompt, §5.10). */
  private raiseMilitary(p: Player, enemy: number): void {
    const g = this.g;
    if (enemy <= 0 || !g.war.atWar(p.id, enemy)) return;
    if (g.war.escalation(p.id, enemy) < 1) g.war.raiseEscalation(p.id, enemy, 1, 'escalation.reason.player');
  }

  private takeOff(u: Unit): void {
    const g = this.g;
    if (u.mode === Mode.Docked) {
      const base = g.structureMap.get(u.home);
      if (base) {
        u.x = base.x;
        u.y = base.y;
      }
      u.originX = u.x;
      u.originY = u.y;
      u.alt = 0.1;
    }
    u.state = UnitState.Moving;
    u.targetUnit = 0;
    u.capTries = null;
  }

  // --- legacy commands (the AI's v1 orders, §14.3), mapped onto unitOrder --------------------------------
  /** v1 moveUnit: warships sail (or bombard a hostile coast), fighters patrol. */
  legacyMove(p: Player, unitId: number, tile: number): boolean {
    const u = this.g.unitMap.get(unitId);
    if (!u || u.owner !== p.id || tile < 0 || tile >= TILE_COUNT) return false;
    if (u.type === UnitType.Warship) {
      const o = this.g.owner[tile];
      if (this.g.playable[tile] && o > 0 && hostileTo(this.g.rules, p.id, o)) return this.order(p, [unitId], 'bombard', tile, 0);
      return this.order(p, [unitId], 'patrol', tile, 0);
    }
    if (u.type === UnitType.FighterSquadron) return this.order(p, [unitId], 'cap', tile, 0);
    if (u.type === UnitType.ArmoredDivision) return this.order(p, [unitId], 'move', tile, 0);
    return false;
  }

  /** v1 deployArmor: hostile land = join the front there (the AI's war plan runs its own offensives), else move. */
  legacyDeploy(p: Player, unitId: number, tile: number): boolean {
    const g = this.g;
    const u = g.unitMap.get(unitId);
    if (!u || u.owner !== p.id || u.type !== UnitType.ArmoredDivision || tile < 0 || tile >= TILE_COUNT) return false;
    const o = g.owner[tile];
    if (o > 0 && o !== p.id && hostileTo(g.rules, p.id, o)) {
      if (!g.sharesBorder(p.id, o)) return false;
      u.order = orderCode('attach');
      return this.orderDivision(p, u, 'attach', tile);
    }
    return this.order(p, [unitId], 'move', tile, 0);
  }

  /** v1 airStrike: bombers and drones strike, fighters patrol there. */
  legacyStrike(p: Player, unitId: number, tile: number): boolean {
    const u = this.g.unitMap.get(unitId);
    if (!u || u.owner !== p.id || !AIR_TYPES.has(u.type)) return false;
    if (u.type === UnitType.FighterSquadron) return this.order(p, [unitId], 'cap', tile, 0);
    return this.order(p, [unitId], 'strike', tile, 0);
  }

  /** The right-click order for a unit (shots, playtests and the AI use the same resolution as the UI). */
  contextOrder(p: Player, unitId: number, tile: number, targetUnit: number, targetStructure: number, shift = false): boolean {
    const o = inferOrder(this.g.rules, unitId, tile, targetUnit, targetStructure, shift);
    return this.order(p, [unitId], o.order, tile, o.targetId);
  }

  // =================================================================================================
  // Naval invasions (W1, §4.11)
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
    // v2 (§4.1, §4.2): a nation must be at war with us; while we still mobilize, the landing is queued.
    const D = g.playerById[o];
    if (o !== 0 && D && D.kind !== 'tribe') {
      if (p.kind === 'tribe') return false;
      if (!g.war.atWar(p.id, o)) {
        g.message(p.id, 'msg.notAtWar');
        return false;
      }
      if (g.war.mobilizingUntil(p.id, o) > 0) {
        g.war.queue(p.id, o, targetTile, ratio, true);
        g.message(p.id, 'msg.mobilizing', 'info');
        return true;
      }
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
    // Embarkation (§4.11, §6.2): at an own port within 600 km of the departure coast (6 / 4 / 3 h by port level),
    // else 12 h on the open shore.
    const bx = (best % MAP_W) + 0.5, by = ((best / MAP_W) | 0) + 0.5;
    let embark = EMBARK_SHORE_TICKS;
    for (const s of g.structByOwner.get(p.id) ?? []) {
      if (s.type === StructureType.Port && s.operational && distKm(s.x, s.y, bx, by) <= EMBARK_PORT_RANGE_KM) {
        embark = Math.min(embark, structureLevel(s.type, s.level).embarkTicks ?? embark);
      }
    }
    u.embarkUntil = g.tick + embark;
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
    g.invariants?.onHostileLaunch(p.id, o, 'invasion');
    // Detection at embarkation (§4.11): the departure inside the target's radar coverage (STRUCTURE_LEVELS, §6.2), or
    // a neighbour across ≤ 400 km of water. Otherwise the coast sees the convoy 16 tiles out.
    if (o !== 0) {
      let how: 'radar' | 'neighbour' | null = null;
      if (g.economy.radarCovers(o, bx, by)) how = 'radar';
      else if (distKm(bx, by, lx, ly) <= 400) how = 'neighbour';
      if (how) this.detect(u, how);
    }
    return true;
  }

  /** The target learns of an invasion convoy (once): invasionDetected with the ETA of the landing. */
  private detect(u: Unit, by: 'radar' | 'coast' | 'neighbour'): void {
    const g = this.g;
    if (u.detected) return;
    u.detected = true;
    const target = g.owner[u.targetTile];
    if (target === 0) return;
    const a = g.attackList.find((x) => x.id === u.attackId && !x.ended);
    g.emit({
      type: 'invasionDetected', tick: g.tick, unitId: u.id, owner: u.owner, target, toTile: u.targetTile,
      etaTicks: this.convoyEta(u), troops: Math.floor(a ? a.troops : u.troops), by,
    });
  }

  /** Ticks until a transport convoy lands: the rest of its embarkation plus the remaining water path at 35 km/h. */
  convoyEta(u: Unit): number {
    const g = this.g;
    return Math.max(0, u.embarkUntil - g.tick) + Math.ceil(this.remainingKm(u) / KM_PER_TICK[UnitType.TransportShip]);
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

  // =================================================================================================
  // Production (§6.3, §7.5)
  // =================================================================================================
  /** Queue a unit at a base (-1 = the base that finishes it first); paid now, ready after its production time. */
  buildUnit(p: Player, type: BuildableUnit, structureId: number): boolean {
    const g = this.g;
    if (g.phase !== 'playing' || !p.spawned) return false;
    const def = UNIT_DEFS[type];
    if (!def || def.producedBy === -1 || def.cost <= 0) return false;
    const prodType = def.producedBy as StructureType;
    let base: Structure | undefined;
    const freeAt = (s: Structure) => (s.queue.length ? s.queue[s.queue.length - 1].readyTick : g.tick);
    if (structureId >= 0) {
      const s = g.structureMap.get(structureId);
      if (s && s.owner === p.id && s.type === prodType && s.operational && this.hostedAt(s.id) < baseCapacity(s)) base = s;
    } else {
      for (const s of g.structByOwner.get(p.id) ?? []) {
        if (s.type !== prodType || !s.operational || this.hostedAt(s.id) >= baseCapacity(s)) continue;
        if (!base || freeAt(s) < freeAt(base) || (freeAt(s) === freeAt(base) && s.level > base.level)) base = s;
      }
    }
    if (!base) {
      const any = (g.structByOwner.get(p.id) ?? []).some((s) => s.type === prodType && s.operational);
      g.message(p.id, any ? 'msg.baseFull' : 'msg.noProducer', 'warning', { structure: prodType });
      return false;
    }
    const cost = g.unitCost(p.id, type);
    if (p.gold < cost) {
      g.message(p.id, 'msg.notEnoughGold');
      return false;
    }
    p.gold -= cost;
    p.stats.goldSpent += cost;
    const start = freeAt(base);
    p.serials[type]++;
    base.queue.push({ unit: type, startTick: start, readyTick: start + def.productionTicks, serial: p.serials[type], cost });
    p.queued[type]++;
    g.structuresDirty = true;
    if (p.id === HUMAN_ID) this.productionDirty = true;
    return true;
  }

  /** Cancel the last unit queued at a base: full refund when not started, half for the one being built. */
  cancelProduction(p: Player, structureId: number): boolean {
    const g = this.g;
    const s = g.structureMap.get(structureId);
    if (!s || s.owner !== p.id || s.queue.length === 0) return false;
    const q = s.queue.pop()!;
    const refund = q.startTick > g.tick ? q.cost : Math.round(q.cost * 0.5);
    g.addGold(p.id, refund);
    p.queued[q.unit] = Math.max(0, p.queued[q.unit] - 1);
    g.structuresDirty = true;
    if (p.id === HUMAN_ID) this.productionDirty = true;
    return true;
  }

  /** A base was lost: its queue is gone (no refund). */
  dropQueue(s: Structure): void {
    const p = this.g.playerById[s.owner];
    if (p) for (const q of s.queue) p.queued[q.unit] = Math.max(0, p.queued[q.unit] - 1);
    if (s.queue.length && s.owner === HUMAN_ID) {
      this.productionDirty = true;
      this.g.message(HUMAN_ID, 'msg.productionLost', 'warning', { structure: s.type });
    }
    s.queue.length = 0;
  }

  private stepProduction(): void {
    const g = this.g;
    for (const s of g.structureMap.values()) {
      if (s.queue.length === 0) continue;
      const q = s.queue[0];
      if (g.tick < q.readyTick) continue;
      s.queue.shift();
      const p = g.playerById[s.owner];
      if (!p || !p.alive) continue;
      p.queued[q.unit] = Math.max(0, p.queued[q.unit] - 1);
      this.produce(p, s, q.unit, q.serial);
      g.structuresDirty = true;
      if (p.id === HUMAN_ID) this.productionDirty = true;
    }
  }

  private produce(p: Player, base: Structure, type: BuildableUnit, serial: number): void {
    const g = this.g;
    let x = base.x, y = base.y;
    if (type === UnitType.Warship) {
      const w = g.nav.waterNear(base.tile);
      if (w >= 0) {
        x = tileCx(w);
        y = tileCy(w);
      }
    }
    p.stats.unitsBuilt++;
    const u = this.spawn(type, p.id, x, y);
    u.home = base.id;
    u.serial = serial;
    if (AIR_TYPES.has(type)) {
      u.mode = Mode.Docked;
      u.state = UnitState.Docked;
      u.readyTick = g.tick;
    } else if (type === UnitType.Warship) {
      u.anchorTile = tileOf(x, y);
      u.stationX = x;
      u.stationY = y;
      u.mode = Mode.Patrol;
      u.state = UnitState.Moving;
    } else {
      u.mode = Mode.None;
      u.state = UnitState.Idle;
    }
    g.emit({ type: 'unitReady', tick: g.tick, unitId: u.id, unit: type, owner: p.id, structureId: base.id, x: u.x, y: u.y, serial });
  }

  // =================================================================================================
  // Command mode, staging
  // =================================================================================================
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
    const p = g.playerById[owner];
    if (p && (type === UnitType.Warship || type === UnitType.ArmoredDivision || AIR_TYPES.has(type))) u.serial = ++p.serials[type];
    switch (type) {
      case UnitType.TransportShip:
      case UnitType.TradeShip:
      case UnitType.Warship: {
        const c = g.nav.comp[tile];
        u.anchorTile = tile;
        u.stationX = x;
        u.stationY = y;
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
        u.mode = Mode.None;
        u.state = UnitState.Idle;
        if (hasTarget && p) this.legacyDeploy(p, u.id, targetTile);
        return;
      case UnitType.FighterSquadron:
      case UnitType.Bomber:
      case UnitType.DroneSwarm:
        if (hasTarget) {
          u.alt = 1;
          u.mode = type === UnitType.FighterSquadron ? Mode.Cap : Mode.Strike;
          u.state = UnitState.Moving;
          u.toX = tx;
          u.toY = ty;
          u.stationX = tx;
          u.stationY = ty;
          u.targetTile = targetTile;
          u.targetPlayer = g.owner[targetTile];
          if (type !== UnitType.FighterSquadron) {
            const tgt = strikeTarget(g.rules, targetTile, 0);
            u.strikeKind = tgt?.kind === 'structure' ? SK_STRUCT : SK_FRONT;
            u.targetStructure = tgt?.kind === 'structure' ? tgt.id : 0;
          }
        } else if (u.home) {
          const base = g.structureMap.get(u.home)!;
          u.x = base.x;
          u.y = base.y;
          u.mode = Mode.Docked;
          u.state = UnitState.Docked;
        } else {
          u.alt = 1;
          u.mode = Mode.Cap;
          u.state = UnitState.Moving;
          u.stationX = x;
          u.stationY = y;
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
    const prod = homeTypeOf(type);
    if (prod === -1) return 0;
    return this.nearestOwn(owner, prod, x, y)?.id ?? 0;
  }

  private nearestOwn(owner: number, type: StructureType, x: number, y: number, filter?: (s: Structure) => boolean): Structure | null {
    let best: Structure | null = null, bestD = Infinity;
    for (const s of this.g.structByOwner.get(owner) ?? []) {
      if (s.type !== type || !s.operational || (filter && !filter(s))) continue;
      const d = tileKm(s.x, s.y, x, y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** The first hostile player owning land within `r` tiles of a tile (0 = none). */
  private enemyNear(owner: number, tile: number, r: number): number {
    const g = this.g;
    let found = 0;
    const cx = tileCx(tile), cy = tileCy(tile);
    const rr = Math.ceil(r / Math.max(0.2, latCos(cy)));
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r) && !found; dy++) {
      const y = Math.floor(cy) + dy;
      if (y < 0 || y >= MAP_H) continue;
      for (let dx = -rr; dx <= rr; dx++) {
        const t = y * MAP_W + (((Math.floor(cx) + dx) % MAP_W) + MAP_W) % MAP_W;
        const o = g.owner[t];
        if (o <= 0 || o === owner || !g.playable[t]) continue;
        if (tileKm(cx, cy, tileCx(t), tileCy(t)) > r * TILE_KM) continue;
        if (hostileTo(g.rules, owner, o)) {
          found = o;
          break;
        }
      }
    }
    return found;
  }

  // =================================================================================================
  // Movement helpers
  // =================================================================================================
  private moveToward(u: Unit, tx: number, ty: number, km: number): boolean {
    return advanceKm(u, tx, ty, km);
  }

  /** Follow u.path spending `km` kilometres this tick; returns true when the last waypoint is reached. */
  private followPath(u: Unit, km: number): boolean {
    const path = u.path;
    if (!path) return true;
    let budget = km;
    while (budget > 1e-6 && u.pathI < path.length) {
      const t = path[u.pathI];
      const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
      const before = kmBetween(u.x, u.y, tx, ty);
      if (advanceKm(u, tx, ty, budget)) {
        budget -= before;
        u.pathI++;
      } else budget = 0;
    }
    return u.pathI >= path.length;
  }

  /** Divisions: road legs at 40 km/h, rail legs at 100 km/h (the tick's hour is shared between them). */
  private followDivisionPath(u: Unit): boolean {
    const path = u.path;
    if (!path) return true;
    let hours = 0.1;
    while (hours > 1e-9 && u.pathI < path.length) {
      const rail = !!u.pathRail && u.pathRail[u.pathI] === 1;
      const kmh = rail ? ARMOR_RAIL_KMH : UNIT_DEFS[UnitType.ArmoredDivision].speedKmh;
      const t = path[u.pathI];
      const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
      const before = kmBetween(u.x, u.y, tx, ty);
      const km = hours * kmh;
      if (advanceKm(u, tx, ty, km)) {
        hours -= before / kmh;
        u.pathI++;
      } else hours = 0;
    }
    const onRail = !!u.pathRail && u.pathI < path.length && u.pathRail[u.pathI] === 1;
    if (u.mode === Mode.Deploy && onRail) u.mode = Mode.Rail;
    else if (u.mode === Mode.Rail && !onRail) u.mode = Mode.Deploy;
    return u.pathI >= path.length;
  }

  /** Km left along the unit's path (or straight to its target). */
  private remainingKm(u: Unit): number {
    const path = u.path;
    if (!path) return kmBetween(u.x, u.y, u.toX, u.toY);
    let km = 0, px = u.x, py = u.y;
    for (let i = u.pathI; i < path.length; i++) {
      const t = path[i];
      const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
      km += kmBetween(px, py, tx, ty);
      px = tx;
      py = ty;
    }
    return km;
  }

  /** Ticks to the end of a division's path (rail legs at 100 km/h). */
  private pathEta(u: Unit): number {
    const path = u.path;
    if (!path) return -1;
    let h = 0, px = u.x, py = u.y;
    for (let i = u.pathI; i < path.length; i++) {
      const t = path[i];
      const tx = (t % MAP_W) + 0.5, ty = ((t / MAP_W) | 0) + 0.5;
      const rail = !!u.pathRail && u.pathRail[i] === 1;
      h += kmBetween(px, py, tx, ty) / (rail ? ARMOR_RAIL_KMH : UNIT_DEFS[UnitType.ArmoredDivision].speedKmh);
      px = tx;
      py = ty;
    }
    return Math.ceil(h * 10);
  }

  /** Plan a water path; if the per-tick search budget is exhausted the unit waits (WaitPath) and retries. */
  private planPath(u: Unit, from: number, to: number, cacheable: boolean): boolean {
    const nav = this.g.nav;
    const path = nav.findPath(from, to, cacheable);
    if (path) {
      u.path = path;
      u.pathI = 1;
      if (u.mode === Mode.WaitPath) u.mode = Mode.Sail;
      this.publishRoute(u);
      return true;
    }
    if (!nav.canSearch()) {
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
    const t = tileOf(u.x, u.y);
    if (g.nav.comp[t] >= 0) return t;
    const w = g.nav.waterNear(t);
    return w >= 0 ? w : t;
  }

  /** A navigable water tile of component `comp` within `r` tiles of land tile `tile`, nearest to it. */
  private waterNearTile(tile: number, r: number, comp: number): number {
    const g = this.g;
    const cx = tile % MAP_W, cy = (tile / MAP_W) | 0;
    let best = -1, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= MAP_H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const t = y * MAP_W + (((cx + dx) % MAP_W) + MAP_W) % MAP_W;
        if (g.nav.comp[t] < 0 || (comp >= 0 && g.nav.comp[t] !== comp)) continue;
        const d = dx * dx + dy * dy;
        if (d < bd && d <= r * r) {
          bd = d;
          best = t;
        }
      }
    }
    return best;
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  step(): void {
    const g = this.g;
    g.unitGrid.rebuild(g.unitMap.values());
    this.stepProduction();
    const list = this.scratch;
    list.length = 0;
    for (const u of g.unitMap.values()) list.push(u);
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
        case UnitType.ArmoredDivision: this.stepDivision(u); break;
        case UnitType.FighterSquadron:
        case UnitType.Bomber:
        case UnitType.DroneSwarm: this.stepAircraft(u); break;
        case UnitType.Train: this.stepTrain(u); break;
      }
    }
    if (g.tick % 5 === 0) {
      for (const u of list) {
        if (u.dead) continue;
        if (u.type === UnitType.TransportShip) u.eta = this.convoyEta(u);
        else if (u.type === UnitType.TradeShip || u.type === UnitType.Train) u.eta = Math.ceil(this.remainingKm(u) / KM_PER_TICK[u.type]);
      }
    }
  }

  // --- transport ships --------------------------------------------------------------------------------
  private stepTransport(u: Unit): void {
    const g = this.g;
    // Embarking in port / on the shore (§4.11): the convoy waits, visible, until its troops are aboard.
    if (g.tick < u.embarkUntil && u.mode !== Mode.Return && !u.pathFailed) {
      u.state = UnitState.Launching;
      const a0 = g.attackList.find((x) => x.id === u.attackId && !x.ended);
      if (a0) a0.state = 'embarking';
      return;
    }
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
    const sailing = g.attackList.find((x) => x.id === u.attackId && !x.ended);
    if (sailing && sailing.state === 'embarking') {
      sailing.state = 'sailing';
      g.attacksDirty = true;
    }
    const done = this.followPath(u, KM_PER_TICK[UnitType.TransportShip]);
    if (!u.detected && u.mode !== Mode.Return && u.targetTile >= 0) {
      const tx = (u.targetTile % MAP_W) + 0.5, ty = ((u.targetTile / MAP_W) | 0) + 0.5;
      if (dist2(u.x, u.y, tx, ty) <= INVASION_DETECT_TILES * INVASION_DETECT_TILES) this.detect(u, 'coast');
      else {
        const target = g.owner[u.targetTile];
        if (target > 0 && g.economy.radarCovers(target, u.x, u.y)) this.detect(u, 'radar');
      }
    }
    if (!done) return;
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

  // --- trade ships (§6.2: rates paid per trip) ----------------------------------------------------------
  private stepTrade(u: Unit): void {
    const g = this.g;
    if (u.pathFailed) {
      this.tradeLost(u);
      this.remove(u, false);
      return;
    }
    if (!u.path) {
      if (!u.waitingPath) {
        this.tradeLost(u);
        this.remove(u, false);
      }
      return;
    }
    u.state = UnitState.Moving;
    if (!this.followPath(u, KM_PER_TICK[UnitType.TradeShip])) return;
    const dest = g.structureMap.get(u.targetStructure);
    const owner = g.playerById[u.owner];
    if (dest && owner && owner.alive && dest.type === StructureType.Port) {
      const partner = g.playerById[dest.owner];
      if (partner && partner.alive && !g.hasEmbargo(u.owner, dest.owner) && !g.hasEmbargo(dest.owner, u.owner)) {
        const agreement = g.rules.hasTreaty(u.owner, dest.owner, 'trade') ? 1 + TRADE_AGREEMENT_BONUS : 1;
        const pay = u.cargo * agreement;
        const share = u.cargo * TRADE_DEST_SHARE * agreement;
        g.addGold(u.owner, pay);
        g.addGold(dest.owner, share);
        this.tradeIncome(u.owner, pay);
        this.tradeIncome(dest.owner, share);
        g.emit({ type: 'tradeCompleted', tick: g.tick, owner: u.owner, partner: dest.owner, gold: Math.round(pay), tile: dest.tile });
        g.emit({ type: 'goldBonus', tick: g.tick, playerId: u.owner, gold: Math.round(pay), tile: dest.tile, reason: 'trade' });
        g.emit({ type: 'goldBonus', tick: g.tick, playerId: dest.owner, gold: Math.round(share), tile: dest.tile, reason: 'trade' });
      }
    }
    this.tradeLost(u);
    this.remove(u, false);
  }

  /** The departure port sends the next ship after its turnaround. */
  private tradeLost(u: Unit): void {
    const s = this.g.structureMap.get(u.home);
    if (s) s.nextTradeTick = Math.max(s.nextTradeTick, this.g.tick + 2);
  }

  /** Gold from trade and trains is tracked per player (tooltips, pace-audit economy). */
  private tradeIncome(pid: number, gold: number): void {
    const p = this.g.playerById[pid];
    if (p) p.tradeGold += gold;
  }

  /** A blockading warship takes a trade ship: the captor gets the cargo (§6.2), the ship is taken as a prize. */
  private captureTrade(ship: Unit, pirate: Unit): void {
    const g = this.g;
    const victim = ship.owner;
    const gold = ship.cargo;
    g.addGold(pirate.owner, gold);
    this.tradeIncome(pirate.owner, gold);
    g.markHostile(pirate.owner, victim);
    g.emit({ type: 'shipCaptured', tick: g.tick, unitId: ship.id, from: victim, by: pirate.owner, warshipId: pirate.id, gold: Math.round(gold), x: ship.x, y: ship.y });
    g.emit({ type: 'goldBonus', tick: g.tick, playerId: pirate.owner, gold: Math.round(gold), tile: tileOf(ship.x, ship.y), reason: 'trade' });
    if (victim === HUMAN_ID) g.message(HUMAN_ID, 'msg.tradeCaptured', 'warning');
    this.tradeLost(ship);
    this.remove(ship, false);
  }

  // --- warships ---------------------------------------------------------------------------------------
  private stepWarship(u: Unit): void {
    const g = this.g;
    if (u.cooldown > 0) u.cooldown--;
    const speed = KM_PER_TICK[UnitType.Warship];
    // Repairs at own naval yards (2/4/6 %/h) and ports (5 %/h) within 3 tiles, when not under fire.
    if (g.tick - u.lastHitTick > 20 && u.hp < u.maxHp && (g.tick + u.id) % 10 === 0) {
      let rate = 0;
      g.structGrid.query(u.x, u.y, 4, (s) => {
        if (s.owner !== u.owner || !s.operational) return;
        if (s.type !== StructureType.NavalYard && s.type !== StructureType.Port) return;
        const lv = structureLevel(s.type, s.level);
        if (tileKm(u.x, u.y, s.x, s.y) <= (lv.repairTiles ?? 3) * TILE_KM + 12) rate = Math.max(rate, lv.repairPerHour ?? 0);
      });
      if (rate > 0) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * rate);
    }
    // Escort: stay with the convoy.
    if (u.mode === Mode.Escort) {
      const c = g.unitMap.get(u.targetUnit);
      if (!c || c.dead) {
        u.mode = Mode.Patrol;
        u.order = -1;
        u.stationX = u.x;
        u.stationY = u.y;
        u.anchorTile = tileOf(u.x, u.y);
      } else {
        u.stationX = c.x;
        u.stationY = c.y;
        if (dist2(u.x, u.y, c.x, c.y) > 1.5) this.moveToward(u, c.x, c.y, speed);
        u.state = UnitState.Moving;
      }
    }
    // Target acquisition (staggered): an ordered target, else hostiles within the engagement radius.
    const ordered = u.mode === Mode.Chase ? g.unitMap.get(u.targetUnit) : undefined;
    let target: Unit | undefined;
    if (ordered && !ordered.dead) target = ordered;
    else {
      if (u.mode === Mode.Chase) {
        u.mode = Mode.Patrol;
        u.order = -1;
        u.stationX = u.x;
        u.stationY = u.y;
        u.anchorTile = tileOf(u.x, u.y);
      }
      if ((g.tick + u.id) % 5 === 0 || (u.targetUnit && !g.unitMap.has(u.targetUnit))) this.acquireNavalTarget(u);
      target = u.mode !== Mode.Escort && u.targetUnit ? g.unitMap.get(u.targetUnit) : u.mode === Mode.Escort ? this.escortThreat(u) : undefined;
    }
    if (target && !target.dead) {
      u.state = UnitState.Attacking;
      const dKm = tileKm(u.x, u.y, target.x, target.y);
      if (target.type === UnitType.TradeShip) {
        if (dKm <= 2 * TILE_KM) {
          this.captureTrade(target, u);
          u.targetUnit = 0;
          return;
        }
        this.chase(u, target, speed);
        return;
      }
      if (dKm <= WARSHIP_ENGAGE_TILES * TILE_KM && u.cooldown <= 0) {
        this.fireAt(u, target);
        u.cooldown = WARSHIP_FIRE_COOLDOWN;
      }
      if (u.mode === Mode.Chase || dKm > WARSHIP_ENGAGE_TILES * TILE_KM * 0.8) this.chase(u, target, speed);
      return;
    }
    if (u.mode !== Mode.Escort) u.targetUnit = 0;
    if (u.mode === Mode.Escort) return;
    // Shore bombardment at station.
    if (u.mode === Mode.Bombard) {
      if (!u.path || this.followPath(u, speed)) {
        u.state = UnitState.Attacking;
        if (!hostileTo(g.rules, u.owner, u.enemy)) {
          u.mode = Mode.Patrol;
          u.order = -1;
        } else if ((g.tick + u.id) % 10 === 0) this.bombard(u);
      } else u.state = UnitState.Moving;
      return;
    }
    // Move, patrol, blockade station, return.
    u.state = UnitState.Moving;
    if (u.path && !this.followPath(u, speed)) return;
    if (u.mode === Mode.Sail) {
      u.mode = Mode.Patrol;
      u.stationX = u.x;
      u.stationY = u.y;
    }
    if (u.mode === Mode.Return) {
      u.mode = Mode.Patrol;
      u.order = -1;
      u.stationX = u.x;
      u.stationY = u.y;
      u.anchorTile = tileOf(u.x, u.y);
    }
    if (u.mode === Mode.Blockade) {
      // Hold the station (small drift).
      u.state = UnitState.Idle;
      return;
    }
    if (u.mode === Mode.Patrol && !u.waitingPath && (g.tick + u.id) % 20 === 0) {
      const here = this.nearestWater(u);
      const c = g.nav.comp[here];
      if (c < 0) return;
      const radius = u.order >= 0 ? 3 : WARSHIP_HOME_PATROL_TILES;
      const dest = g.nav.randomWaterNear(u.stationX, u.stationY, radius, c, this.rnd);
      if (dest >= 0 && g.nav.canSearch()) this.planPath(u, here, dest, true);
      u.pathFailed = false;
    }
  }

  private chase(u: Unit, target: Unit, speed: number): void {
    const g = this.g;
    const here = tileOf(u.x, u.y);
    const there = tileOf(target.x, target.y);
    const c = g.nav.comp[here];
    if (c >= 0 && g.nav.comp[there] === c && g.nav.lineOfSight(here, there, c)) {
      this.moveToward(u, target.x, target.y, speed);
      u.path = null;
    } else if (!u.path || (g.tick + u.id) % 15 === 0) {
      if (g.nav.canSearch() && g.nav.comp[there] === c) this.planPath(u, here, there, false);
    } else this.followPath(u, speed);
  }

  /** A naval gun salvo resolved on the tick: warships lose 25 % a hit, convoys 50 % (2 hits; escorts ×1.5 survival). */
  private fireAt(u: Unit, target: Unit): void {
    const g = this.g;
    const hitChance = target.type === UnitType.TransportShip ? 0.8 : 0.7;
    const hit = g.rngCombat.next() < hitChance;
    g.markHostile(u.owner, target.owner);
    g.emit({ type: 'combat', tick: g.tick, kind: 'shell', owner: u.owner, fromX: u.x, fromY: u.y, toX: target.x, toY: target.y, hit });
    if (!hit) return;
    let dmg = target.maxHp * (target.type === UnitType.TransportShip ? CONVOY_HIT : WARSHIP_HIT);
    if (target.type === UnitType.TransportShip && this.escorted(target)) dmg /= ESCORT_SURVIVAL;
    this.damage(target, dmg + 1e-6, u.owner);
  }

  private escorted(convoy: Unit): boolean {
    let yes = false;
    this.g.unitGrid.query(convoy.x, convoy.y, ESCORT_TILES / Math.max(0.2, latCos(convoy.y)), (o) => {
      if (!o.dead && o.owner === convoy.owner && o.type === UnitType.Warship && o.mode === Mode.Escort && o.targetUnit === convoy.id) {
        yes = true;
        return true;
      }
    });
    return yes;
  }

  /** An escort engages hostile warships closing on its convoy. */
  private escortThreat(u: Unit): Unit | undefined {
    const g = this.g;
    let best: Unit | undefined, bd = Infinity;
    g.unitGrid.query(u.x, u.y, WARSHIP_ENGAGE_TILES / Math.max(0.2, latCos(u.y)), (o, d2) => {
      if (o.dead || o.type !== UnitType.Warship || !hostileTo(g.rules, u.owner, o.owner)) return;
      if (d2 < bd) {
        bd = d2;
        best = o;
      }
    });
    return best;
  }

  private acquireNavalTarget(u: Unit): void {
    const g = this.g;
    let best: Unit | null = null, bestScore = Infinity;
    const blockade = u.mode === Mode.Blockade;
    const cx = blockade ? u.stationX : u.x, cy = blockade ? u.stationY : u.y;
    const rKm = WARSHIP_ENGAGE_TILES * TILE_KM;
    g.unitGrid.query(cx, cy, WARSHIP_ENGAGE_TILES / Math.max(0.2, latCos(cy)), (o) => {
      if (o.dead || o.owner === u.owner || g.isAllied(u.owner, o.owner)) return;
      const d = tileKm(cx, cy, o.x, o.y);
      if (d > rKm) return;
      let prio: number;
      if (o.type === UnitType.TransportShip) {
        // Invasion convoys heading to us or our allies are always engaged; others only when at war with their owner.
        const tgt = g.owner[o.targetTile] ?? 0;
        if (!(tgt === u.owner || g.isAllied(u.owner, tgt) || hostileTo(g.rules, u.owner, o.owner))) return;
        prio = 0;
      } else if (o.type === UnitType.Warship) {
        if (!hostileTo(g.rules, u.owner, o.owner)) return;
        prio = 1;
      } else if (o.type === UnitType.TradeShip) {
        // Only a blockade stops trade (§6.3).
        if (!blockade || !hostileTo(g.rules, u.owner, o.owner)) return;
        prio = 2;
      } else return;
      const s = prio * 10_000 + d;
      if (s < bestScore) {
        bestScore = s;
        best = o;
      }
    });
    u.targetUnit = best ? (best as Unit).id : 0;
  }

  /** Shore bombardment (§6.3): structures near the aim, and the local enemy garrison −0.15 %/h. */
  private bombard(u: Unit): void {
    const g = this.g;
    const tx = tileCx(u.targetTile), ty = tileCy(u.targetTile);
    const victim = u.enemy;
    g.markHostile(u.owner, victim);
    const ox = (this.rnd() - 0.5) * 2, oy = (this.rnd() - 0.5) * 2;
    g.emit({ type: 'combat', tick: g.tick, kind: 'artillery', owner: u.owner, fromX: u.x, fromY: u.y, toX: wrapXf(tx + ox), toY: ty + oy, hit: true });
    // Every 10 ticks: one hour of attrition on the garrison of the nearest front of the victim.
    this.bleedGarrison(victim, u.owner, tx, ty, BOMBARD_GARRISON_PER_HOUR);
    g.structGrid.query(tx, ty, 1.6, (st) => {
      if (st.owner === victim) g.weapons.damageStructure(st, 0.05, u.owner);
    });
  }

  /** Kill `perHour` of the garrison of `victim`'s front with `by` nearest to (x, y) (one game hour's worth). */
  private bleedGarrison(victim: number, by: number, x: number, y: number, perHour: number): void {
    const g = this.g;
    const v = g.playerById[victim];
    if (!v || !v.alive) return;
    const f = g.war.atWar(victim, by) ? g.fronts.frontAt(victim, by, x, y) : undefined;
    const garrison = f ? g.fronts.garrison(f, victim) : v.troops * (1 - DEFENSE_REAR_SHARE) * 0.2;
    const killed = Math.min(v.troops, garrison * perHour);
    if (killed <= 0) return;
    v.troops -= killed;
    v.stats.troopsLost += killed;
    const k = g.playerById[by];
    if (k) k.stats.troopsKilled += killed;
  }

  // --- armored divisions --------------------------------------------------------------------------------
  private stepDivision(u: Unit): void {
    const g = this.g;
    const p = g.playerById[u.owner];
    if (!p) return;
    // Base repairs (+1/2/3 %/h within 5 tiles of an own army base), checked every hour.
    if ((g.tick + u.id) % 10 === 0 && u.hp < u.maxHp) {
      let rate = 0;
      g.structGrid.query(u.x, u.y, 6 / Math.max(0.2, latCos(u.y)), (s) => {
        if (s.owner !== u.owner || s.type !== StructureType.ArmyBase || !s.operational) return;
        const lv = structureLevel(s.type, s.level);
        if (tileKm(u.x, u.y, s.x, s.y) <= (lv.repairTiles ?? 5) * TILE_KM) rate = Math.max(rate, lv.repairPerHour ?? 0);
      });
      if (rate > 0) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * rate);
    }
    switch (u.mode) {
      case Mode.Deploy:
      case Mode.Rail:
      case Mode.Return: {
        // Blocked on the way (the land ahead changed hands): stop there.
        const done = this.followDivisionPath(u);
        u.state = u.mode === Mode.Return ? UnitState.Returning : UnitState.Moving;
        if ((g.tick + u.id) % 5 === 0) u.eta = this.pathEta(u);
        const here = tileOf(u.x, u.y);
        if (!canTransit(g.rules, u.owner, g.owner[here]) && g.playable[here]) {
          this.stopDivision(u);
          if (u.owner === HUMAN_ID) g.message(HUMAN_ID, 'msg.divisionBlocked', 'warning');
          return;
        }
        if (!done) return;
        const wasAttach = u.order === orderCode('attach') || u.order === orderCode('attack');
        u.path = null;
        u.pathRail = null;
        u.eta = -1;
        if (wasAttach && u.enemy > 0 && hostileTo(g.rules, u.owner, u.enemy)) this.attach(u, u.enemy);
        else {
          u.mode = Mode.None;
          u.state = UnitState.Idle;
          if (u.order !== orderCode('hold')) this.autoAttach(u);
        }
        return;
      }
      case Mode.Front:
        this.stepAttached(u);
        return;
      default:
        u.state = UnitState.Idle;
        u.eta = -1;
        if ((g.tick + u.id) % 20 === 0) this.autoAttach(u);
    }
  }

  /** Idle behaviour (§6.4): a division with an enemy front within 3 tiles attaches to it for defense. */
  private autoAttach(u: Unit): void {
    const enemy = this.enemyNear(u.owner, tileOf(u.x, u.y), DIVISION_ATTACH_TILES);
    if (enemy > 0) this.attach(u, enemy);
  }

  /** Attached: follow the front line, wear while engaged, repair while quiet (§6.3). */
  private stepAttached(u: Unit): void {
    const g = this.g;
    if (!hostileTo(g.rules, u.owner, u.enemy)) {
      // The war ended (or the enemy is gone): the division stands down where it is.
      u.mode = Mode.None;
      u.state = UnitState.Idle;
      u.enemy = 0;
      u.frontKey = 0;
      u.onOffensive = false;
      u.order = -1;
      return;
    }
    u.state = UnitState.Attacking;
    // Every 5 ticks: the nearest own tile touching the enemy (the line moves at most 8 km/h, 4 tiles a day).
    if ((g.tick + u.id) % 5 === 0) {
      const t = this.lineTileNear(u, 6);
      if (t >= 0) {
        u.toX = tileCx(t);
        u.toY = tileCy(t);
      } else {
        const far = this.rallyTile(u.owner, u.enemy, tileOf(u.x, u.y));
        if (far < 0) {
          u.mode = Mode.None;
          u.state = UnitState.Idle;
          u.enemy = 0;
          return;
        }
        // The front moved away: march to it and attach again.
        u.order = orderCode('attach');
        this.marchTo(u, far, Mode.Deploy);
        return;
      }
      const f = g.fronts.frontAt(u.owner, u.enemy, u.x, u.y);
      if (f) u.frontKey = f.key;
    }
    if (dist2(u.x, u.y, u.toX, u.toY) > 0.25) this.moveToward(u, u.toX, u.toY, KM_PER_TICK[UnitType.ArmoredDivision]);
    // Integrity (§6.3): engaged −0.2 %/h, −0.5 %/h while our offensive advances at the cap, +0.25 %/h on a quiet front.
    let engaged = false, atCap = false, ours = false;
    for (const a of g.attackList) {
      if (a.ended || a.returnAt >= 0 || a.boatId !== 0 || g.tick < a.contactUntil) continue;
      const mine = a.attacker === u.owner && a.defender === u.enemy;
      const theirs = a.attacker === u.enemy && a.defender === u.owner;
      if (!mine && !theirs) continue;
      if (!nearAxis(a, u.x, u.y, a.frontage / 2 + DIVISION_ATTACH_TILES + (theirs ? DIVISION_ATTACH_TILES : 0))) continue;
      engaged = true;
      if (mine) {
        ours = true;
        if (a.advanceKmh >= ADVANCE_MAX_KMH * 0.9 && !a.consolidating) atCap = true;
      }
    }
    u.onOffensive = ours;
    const perTick = u.maxHp / 10;
    if (engaged) {
      this.damage(u, perTick * (atCap ? DIVISION_WEAR_AT_CAP : DIVISION_WEAR_ENGAGED), u.enemy);
      if (u.dead && u.owner === HUMAN_ID) g.message(HUMAN_ID, 'msg.divisionWornOut', 'danger');
    } else if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + perTick * DIVISION_FIELD_REPAIR);
  }

  /** The own tile touching the division's enemy nearest to it, within `r` tiles (-1 = none). */
  private lineTileNear(u: Unit, r: number): number {
    const g = this.g;
    const cx = Math.floor(u.x), cy = Math.floor(u.y);
    let best = -1, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 1 || y >= MAP_H - 1) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = (((cx + dx) % MAP_W) + MAP_W) % MAP_W;
        const t = y * MAP_W + x;
        if (g.owner[t] !== u.owner || !g.playable[t]) continue;
        const e = u.enemy;
        const l = x === 0 ? t + MAP_W - 1 : t - 1, rr = x === MAP_W - 1 ? t - MAP_W + 1 : t + 1;
        if (g.owner[l] !== e && g.owner[rr] !== e && g.owner[t - MAP_W] !== e && g.owner[t + MAP_W] !== e) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
    }
    return best;
  }

  // --- aircraft -------------------------------------------------------------------------------------------
  private stepAircraft(u: Unit): void {
    const g = this.g;
    let base = g.structureMap.get(u.home);
    if (!base || base.owner !== u.owner || !base.operational) {
      // Home lost: divert to another airbase with room, or ditch.
      const nh = this.nearestOwn(u.owner, StructureType.Airbase, u.x, u.y, (s) => this.hostedAt(s.id) < baseCapacity(s));
      if (!nh) {
        if (u.mode === Mode.Docked || u.mode === Mode.Return) {
          if (u.owner === HUMAN_ID) g.message(HUMAN_ID, 'msg.aircraftLost', 'warning');
          this.kill(u, 0);
          return;
        }
      } else {
        u.home = nh.id;
        base = nh;
        if (u.mode === Mode.Docked) {
          this.takeOff(u);
          u.mode = Mode.Return;
        }
      }
    }
    if (u.mode === Mode.Docked) {
      u.state = UnitState.Docked;
      u.alt = 0;
      if (base) {
        u.x = base.x;
        u.y = base.y;
      }
      if (u.hp < u.maxHp && (g.tick + u.id) % 10 === 0) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * (base ? structureLevel(base.type, base.level).repairPerHour ?? 0.1 : 0.1));
      u.eta = u.readyTick > g.tick ? u.readyTick - g.tick : -1;
      if (u.type === UnitType.FighterSquadron && u.readyTick <= g.tick && (g.tick + u.id) % 5 === 0) this.scramble(u);
      return;
    }
    if (u.alt < 1) u.alt = Math.min(1, u.alt + 0.25);
    const speed = KM_PER_TICK[u.type];
    switch (u.mode) {
      case Mode.Strike:
        this.stepStrike(u, speed);
        return;
      case Mode.Intercept: {
        const t = g.unitMap.get(u.targetUnit);
        if (!t || t.dead || t.mode === Mode.Docked || (base && tileKm(base.x, base.y, u.x, u.y) > UNIT_DEFS[u.type].rangeKm * 1.2)) {
          this.goHome(u);
          return;
        }
        u.state = UnitState.Attacking;
        u.eta = Math.ceil(tileKm(u.x, u.y, t.x, t.y) / speed);
        const arrived = this.moveToward(u, t.x, t.y, speed);
        if (arrived || tileKm(u.x, u.y, t.x, t.y) < TILE_KM * 1.2) {
          this.engage(u, t, t.type === UnitType.CruiseMissile ? CAP_HIT_CRUISE : CAP_HIT_AIRCRAFT);
          if (!t.dead && t.type === UnitType.FighterSquadron) return;
          this.goHome(u);
        }
        return;
      }
      case Mode.Chase: {
        // Escort: fly with the bomber or drone sortie, fight its interceptors (see engage).
        const t = g.unitMap.get(u.targetUnit);
        if (!t || t.dead || t.mode === Mode.Docked) {
          this.goHome(u);
          return;
        }
        u.state = UnitState.Moving;
        if (t.mode === Mode.Return && tileKm(u.x, u.y, t.x, t.y) < TILE_KM) {
          this.goHome(u);
          return;
        }
        const d = tileKm(u.x, u.y, t.x, t.y);
        this.moveToward(u, t.x, t.y, Math.min(speed, d));
        u.heading = t.heading;
        return;
      }
      case Mode.Cap:
        this.stepCap(u, speed);
        return;
      case Mode.Patrol:
        this.stepSupport(u, speed);
        return;
      default:
        this.stepReturn(u, speed);
    }
  }

  private goHome(u: Unit): void {
    u.targetUnit = 0;
    u.mode = Mode.Return;
    u.state = UnitState.Returning;
    u.order = u.order === orderCode('cap') ? -1 : u.order;
  }

  private stepReturn(u: Unit, speed: number): void {
    const g = this.g;
    u.mode = Mode.Return;
    u.state = UnitState.Returning;
    const home = g.structureMap.get(u.home);
    if (!home) {
      this.kill(u, 0);
      return;
    }
    u.toX = home.x;
    u.toY = home.y;
    const d = tileKm(u.x, u.y, home.x, home.y);
    u.eta = Math.ceil(d / speed);
    if (d < 100) u.alt = Math.max(0.05, u.alt - 0.25);
    if (this.moveToward(u, home.x, home.y, speed)) {
      u.mode = Mode.Docked;
      u.state = UnitState.Docked;
      u.alt = 0;
      u.order = -1;
      u.readyTick = g.tick + (REARM_TICKS[u.type] ?? 20);
      u.eta = u.readyTick - g.tick;
      u.capTries = null;
    }
  }

  /** Persistent combat air patrol (§6.3): orbit the station, intercept raids crossing the circle, until recalled. */
  private stepCap(u: Unit, speed: number): void {
    const g = this.g;
    u.state = UnitState.Moving;
    const d = tileKm(u.x, u.y, u.stationX, u.stationY);
    const orbitKm = CAP_RADIUS_TILES * TILE_KM * 0.6;
    if (d > orbitKm * 1.3) {
      this.moveToward(u, u.stationX, u.stationY, speed);
      u.eta = Math.ceil((d - orbitKm) / speed);
    } else {
      // Orbit: aim at a point ahead on the circle (the aircraft rotate on station; the patrol never ends by itself).
      const ang = Math.atan2(u.y - u.stationY, wdx(u.stationX, u.x) * latCos(u.y)) + 0.6;
      const r = orbitKm / TILE_KM;
      this.moveToward(u, wrapXf(u.stationX + (Math.cos(ang) * r) / Math.max(0.2, latCos(u.stationY))), u.stationY + Math.sin(ang) * r, speed * 0.7);
      u.eta = -1;
    }
    this.capSweep(u, u.stationX, u.stationY);
  }

  /** Engage hostile aircraft and cruise missiles inside the CAP circle (each pass is engaged once per squadron). */
  private capSweep(u: Unit, cx: number, cy: number): void {
    const g = this.g;
    const rKm = CAP_RADIUS_TILES * TILE_KM;
    g.unitGrid.query(cx, cy, CAP_RADIUS_TILES / Math.max(0.2, latCos(cy)), (o) => {
      if (u.dead) return true;
      if (o.dead || o === u) return;
      if (o.type !== UnitType.Bomber && o.type !== UnitType.DroneSwarm && o.type !== UnitType.CruiseMissile && o.type !== UnitType.FighterSquadron) return;
      if (o.mode === Mode.Docked || !hostileTo(g.rules, u.owner, o.owner)) return;
      if (tileKm(cx, cy, o.x, o.y) > rKm) return;
      const tries = (o.capTries ??= new Map());
      const last = tries.get(u.id);
      if (last !== undefined && g.tick - last < 30) return;
      tries.set(u.id, g.tick);
      this.engage(u, o, o.type === UnitType.CruiseMissile ? CAP_HIT_CRUISE : CAP_HIT_AIRCRAFT);
    });
  }

  /**
   * One interception (resolved on the tick): `chance` to shoot the target down; an escort on the target takes the
   * fight first (the escorts' fighters dogfight the interceptor and halve its chance). Fighters duel.
   */
  private engage(f: Unit, t: Unit, chance: number): void {
    const g = this.g;
    g.emit({ type: 'combat', tick: g.tick, kind: 'strafe', owner: f.owner, fromX: f.x, fromY: f.y, toX: t.x, toY: t.y, hit: true });
    g.markHostile(f.owner, t.owner);
    if (t.type === UnitType.FighterSquadron) {
      // Dogfight: both sides take losses.
      if (this.rnd() < 0.5) this.damage(t, t.maxHp * 0.25, f.owner);
      if (this.rnd() < 0.5) this.damage(f, f.maxHp * 0.25, t.owner);
      return;
    }
    let p = chance;
    const escort = this.escortOf(t);
    if (escort) {
      p *= 0.5;
      if (this.rnd() < 0.4) this.damage(f, f.maxHp * 0.25, escort.owner);
      if (this.rnd() < 0.3) this.damage(escort, escort.maxHp * 0.25, f.owner);
    }
    if (f.dead) return;
    if (this.rnd() < p) {
      if (t.type === UnitType.CruiseMissile) g.weapons.intercept(t, f.owner, false);
      else this.kill(t, f.owner);
    } else if (t.type === UnitType.Bomber && this.rnd() < 0.15) this.damage(f, f.maxHp * 0.1, t.owner);
  }

  private escortOf(t: Unit): Unit | null {
    for (const o of this.g.unitsByOwner.get(t.owner) ?? []) {
      if (!o.dead && o.type === UnitType.FighterSquadron && o.mode === Mode.Chase && o.targetUnit === t.id && tileKm(o.x, o.y, t.x, t.y) < 2 * TILE_KM) return o;
    }
    return null;
  }

  /** Docked fighters scramble against hostile raids within the base's radius (×1.5 inside own radar coverage). */
  private scramble(u: Unit): void {
    const g = this.g;
    const base = g.structureMap.get(u.home);
    if (!base || !base.operational) return;
    const lv = structureLevel(base.type, base.level);
    const radar = g.economy.radarCovers(u.owner, base.x, base.y);
    const r = (lv.scrambleTiles ?? 16) * (radar ? RADAR_SCRAMBLE_MUL : 1);
    let best: Unit | null = null, bd = Infinity;
    g.unitGrid.query(base.x, base.y, r / Math.max(0.2, latCos(base.y)), (o) => {
      if (o.dead || (o.type !== UnitType.Bomber && o.type !== UnitType.DroneSwarm && o.type !== UnitType.CruiseMissile)) return;
      if (o.mode === Mode.Docked || o.mode === Mode.Return || !hostileTo(g.rules, u.owner, o.owner)) return;
      const tgt = o.targetTile >= 0 && o.targetTile < TILE_COUNT ? g.owner[o.targetTile] : 0;
      if (!(tgt === u.owner || g.isAllied(u.owner, tgt))) return;
      if (o.engagedBy > 1) return;
      const d = tileKm(base.x, base.y, o.x, o.y);
      if (d > r * TILE_KM || d >= bd) return;
      bd = d;
      best = o;
    });
    if (!best) return;
    (best as Unit).engagedBy++;
    this.takeOff(u);
    u.mode = Mode.Intercept;
    u.targetUnit = (best as Unit).id;
    u.order = -1;
  }

  /** Bomber / drone sortie: fly at the mission speed, strike on arrival (§2.1 air rule), return and rearm. */
  private stepStrike(u: Unit, speed: number): void {
    const g = this.g;
    u.state = UnitState.Moving;
    // A moving target (division, ship): home on it.
    if (u.targetUnit) {
      const t = g.unitMap.get(u.targetUnit);
      if (t && !t.dead) {
        u.toX = t.x;
        u.toY = t.y;
      }
    }
    const d = tileKm(u.x, u.y, u.toX, u.toY);
    u.eta = Math.ceil(d / speed);
    this.checkRaid(u, false);
    if (!this.moveToward(u, u.toX, u.toY, speed)) {
      u.state = UnitState.Attacking;
      return;
    }
    this.strikeImpact(u);
    if (u.dead) return;
    if (u.type === UnitType.DroneSwarm) {
      // One-way munitions: the swarm is spent.
      this.remove(u, false);
      g.emit({ type: 'unitDestroyed', tick: g.tick, unitId: u.id, unit: u.type, owner: u.owner, by: 0, x: u.x, y: u.y });
      return;
    }
    u.mode = Mode.Return;
    u.state = UnitState.Returning;
  }

  /** airRaid (§8.2): at take-off inside the target's radar coverage, else entering it, else 250 km out. */
  private checkRaid(u: Unit, takeoff: boolean): void {
    const g = this.g;
    if (u.raidAnnounced || u.targetPlayer <= 0) return;
    const target = u.targetPlayer;
    let by: 'takeoff' | 'radar' | 'observers' | null = null;
    if (takeoff) {
      const base = g.structureMap.get(u.home);
      if (base && g.economy.radarCovers(target, base.x, base.y)) by = 'takeoff';
    } else if (g.economy.radarCovers(target, u.x, u.y)) by = 'radar';
    else if (tileKm(u.x, u.y, u.toX, u.toY) <= AIR_RAID_OBSERVER_KM) by = 'observers';
    if (!by) return;
    u.raidAnnounced = true;
    const base = g.structureMap.get(u.home);
    g.emit({
      type: 'airRaid', tick: g.tick, owner: u.owner, target, unitId: u.id, unit: u.type, fromTile: base ? base.tile : tileOf(u.x, u.y),
      toTile: u.targetTile, etaTicks: Math.ceil(tileKm(u.x, u.y, u.toX, u.toY) / KM_PER_TICK[u.type]), by,
    });
  }

  /** The payload lands (§6.3): structure −0.55 (direct −1.1; drones −0.38 / −0.6), division −35 %, ship, front sector −3 %. */
  private strikeImpact(u: Unit): void {
    const g = this.g;
    const bomb = u.type === UnitType.Bomber;
    const victim = u.targetPlayer;
    for (let i = 0; i < (bomb ? 4 : 3); i++) {
      const ox = (g.rngCombat.next() - 0.5) * 1.6, oy = (g.rngCombat.next() - 0.5) * 1.6;
      g.emit({ type: 'combat', tick: g.tick, kind: 'bomb', owner: u.owner, fromX: u.x, fromY: u.y, toX: wrapXf(u.toX + ox), toY: u.toY + oy, hit: true });
    }
    g.markHostile(u.owner, victim);
    let kind: 'structure' | 'division' | 'front' | 'ship' | 'none' = 'none';
    let damage = 0, destroyed = false, targetId = 0, stype = -1;
    if (u.strikeKind === SK_STRUCT) {
      const s = g.structureMap.get(u.targetStructure);
      kind = 'structure';
      targetId = u.targetStructure;
      if (s && s.owner === victim) {
        stype = s.type;
        const direct = bomb ? BOMBER_DIRECT_DMG : DRONE_DIRECT_DMG;
        const splash = bomb ? BOMBER_STRUCT_DMG : DRONE_STRUCT_DMG;
        const before = s.hp;
        g.structGrid.query(s.x, s.y, 1.6, (o) => {
          if (o.owner === victim) g.weapons.damageStructure(o, o === s ? direct : splash, u.owner);
        });
        damage = Math.min(before, direct);
        destroyed = !g.structureMap.has(s.id);
      }
    } else if (u.strikeKind === SK_DIV || u.strikeKind === SK_SHIP) {
      const t = g.unitMap.get(u.targetUnit);
      kind = u.strikeKind === SK_DIV ? 'division' : 'ship';
      targetId = u.targetUnit;
      if (t && !t.dead && tileKm(t.x, t.y, u.x, u.y) < TILE_KM * 1.5) {
        const share = t.type === UnitType.TransportShip ? 1 : t.type === UnitType.Warship ? WARSHIP_HIT : BOMBER_DIVISION_DMG;
        damage = share;
        this.damage(t, t.maxHp * share + (share >= 1 ? 1 : 0), u.owner);
        destroyed = t.dead;
      }
    } else {
      kind = 'front';
      const before = g.playerById[victim]?.troops ?? 0;
      this.bleedGarrison(victim, u.owner, u.toX, u.toY, bomb ? BOMBER_GARRISON_SHARE : BOMBER_GARRISON_SHARE * 0.4);
      damage = before - (g.playerById[victim]?.troops ?? 0);
    }
    g.emit({
      type: 'strikeResult', tick: g.tick, unitId: u.id, unit: u.type, owner: u.owner, victim, kind, targetId, structure: stype,
      damage: +damage.toFixed(3), destroyed, x: u.toX, y: u.toY,
    });
  }

  /** Drone swarm over a front (§6.3): loiters on station; its support is read by frontSupport; bleeds the garrison. */
  private stepSupport(u: Unit, speed: number): void {
    const g = this.g;
    u.state = UnitState.Moving;
    if (!u.enemy || !hostileTo(g.rules, u.owner, u.enemy)) {
      this.goHome(u);
      return;
    }
    const d = tileKm(u.x, u.y, u.stationX, u.stationY);
    if (d > TILE_KM) {
      this.moveToward(u, u.stationX, u.stationY, speed);
      u.eta = Math.ceil(d / speed);
      return;
    }
    u.eta = -1;
    u.state = UnitState.Attacking;
    const ang = (g.tick * 0.35 + u.id) % (Math.PI * 2);
    this.moveToward(u, wrapXf(u.stationX + Math.cos(ang) * 0.8), u.stationY + Math.sin(ang) * 0.8, speed * 0.5);
    if ((g.tick + u.id) % 10 === 0) this.bleedGarrison(u.enemy, u.owner, u.stationX, u.stationY, DRONE_GARRISON_PER_HOUR);
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
    let budget = KM_PER_TICK[UnitType.Train];
    while (budget > 1e-6 && u.pathI < path.length) {
      const sid = path[u.pathI];
      const s = u.aux < 0 ? null : g.structureMap.get(sid);
      const tx = s ? s.x : (sid % MAP_W) + 0.5, ty = s ? s.y : ((sid / MAP_W) | 0) + 0.5;
      if (u.aux >= 0 && (!s || (s.owner !== u.owner && !g.isAllied(u.owner, s.owner)))) {
        this.trainDone(u);
        this.remove(u, false); // the line was cut
        return;
      }
      const before = kmBetween(u.x, u.y, tx, ty);
      if (advanceKm(u, tx, ty, budget)) {
        budget -= before;
        u.pathI++;
      } else budget = 0;
    }
    if (u.pathI < path.length) return;
    const last = u.aux < 0 ? null : g.structureMap.get(path[path.length - 1]);
    const tile = last ? last.tile : tileOf(u.x, u.y);
    if (u.cargo > 0) {
      g.addGold(u.owner, u.cargo);
      this.tradeIncome(u.owner, u.cargo);
      g.emit({ type: 'goldBonus', tick: g.tick, playerId: u.owner, gold: Math.round(u.cargo), tile, reason: 'train' });
    }
    this.trainDone(u);
    this.remove(u, false);
  }

  /** The factory sends its next train now (it keeps its trains running, §6.2). */
  private trainDone(u: Unit): void {
    const f = this.g.structureMap.get(u.home);
    if (f) f.timer = Math.min(f.timer, this.g.tick + 1);
  }

  /** Spawn a trade ship between two ports (the port keeps 2 per level at sea; economy decides when). */
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
    const path = nav.findPath(a, b, true);
    if (!path) return false;
    return this.spawnTrade(from, to, path, a);
  }

  private spawnTrade(from: Structure, to: Structure, path: Int32Array, start: number): boolean {
    let km = 0;
    for (let i = 1; i < path.length; i++) {
      const p0 = path[i - 1], p1 = path[i];
      km += kmBetween((p0 % MAP_W) + 0.5, ((p0 / MAP_W) | 0) + 0.5, (p1 % MAP_W) + 0.5, ((p1 / MAP_W) | 0) + 0.5);
    }
    const u = this.spawn(UnitType.TradeShip, from.owner, (start % MAP_W) + 0.5, ((start / MAP_W) | 0) + 0.5);
    u.path = path;
    u.pathI = 1;
    u.mode = Mode.Sail;
    u.state = UnitState.Moving;
    u.home = from.id;
    u.targetStructure = to.id;
    u.targetPlayer = to.owner;
    // Payout = (port rate / ships) × trip hours (§6.2): with its ships at sea the port earns its rate per hour.
    const lv = Math.max(1, Math.min(3, from.level));
    const ships = structureLevel(from.type, lv).tradeShips ?? 2 * lv;
    const hours = km / UNIT_DEFS[UnitType.TradeShip].speedKmh;
    u.cargo = (PORT_TRADE_GOLD_PER_HOUR[lv] / ships) * (hours + 0.2);
    u.toX = to.x;
    u.toY = to.y;
    u.targetTile = to.tile;
    u.eta = Math.ceil(hours * 10);
    this.publishRoute(u);
    return true;
  }

  /** Spawn a train following a list of station ids; pays (rate / trains) × trip hours on arrival (§6.2). */
  launchTrain(owner: number, stations: number[], factory: Structure): void {
    const g = this.g;
    const first = g.structureMap.get(stations[0]);
    const last = g.structureMap.get(stations[stations.length - 1]);
    if (!first || !last) return;
    let km = 0;
    for (let i = 1; i < stations.length; i++) {
      const a = g.structureMap.get(stations[i - 1])!, b = g.structureMap.get(stations[i])!;
      km += kmBetween(a.x, a.y, b.x, b.y);
    }
    const u = this.spawn(UnitType.Train, owner, first.x, first.y);
    u.path = Int32Array.from(stations);
    u.pathI = 1;
    u.mode = Mode.Rail;
    u.state = UnitState.Moving;
    const lv = Math.max(1, Math.min(3, factory.level));
    const trains = structureLevel(factory.type, lv).trains ?? lv;
    u.cargo = (RAIL_GOLD_PER_HOUR[lv] / trains) * (km / UNIT_DEFS[UnitType.Train].speedKmh);
    u.home = factory.id;
    u.targetStructure = last.id;
    u.toX = last.x;
    u.toY = last.y;
    u.targetTile = last.tile;
    this.publishRoute(u);
  }
}

/** Is (x, y) within `reach` tiles of an offensive's corridor (and not far behind its origin)? */
export function nearAxis(a: Attack, x: number, y: number, reach: number): boolean {
  const rx = wdx(a.originX, x), ry = y - a.originY;
  return Math.abs(rx * a.dirY - ry * a.dirX) <= reach && rx * a.dirX + ry * a.dirY >= -reach;
}

/** Local-metric km between two tile points (same metric as advanceKm). */
function kmBetween(ax: number, ay: number, bx: number, by: number): number {
  const c = latCos(ay);
  const dx = wdx(ax, bx) * TILE_KM * c, dy = (by - ay) * TILE_KM;
  return Math.sqrt(dx * dx + dy * dy);
}

function tileOf(x: number, y: number): number {
  const yy = Math.min(MAP_H - 1, Math.max(0, Math.floor(y)));
  return yy * MAP_W + (((Math.floor(x) % MAP_W) + MAP_W) % MAP_W);
}

/** Wrapped x step between two tile indices (-1, 0, 1 for neighbours). */
function wdxI(a: number, b: number): number {
  let d = (b % MAP_W) - (a % MAP_W);
  if (d > MAP_W / 2) d -= MAP_W;
  else if (d < -MAP_W / 2) d += MAP_W;
  return d;
}

export { AIR_TYPES, PROJECTILES, OFFENSIVE_CONTACT_TICKS };
