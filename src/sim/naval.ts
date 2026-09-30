// FRONT ULTRA — naval warfare on the sea lanes (owner item 30, DESIGN_V2 §20). Owner: sim-core. Worker-only.
//
// Blockades are held by warships (unitOrder 'blockade' with an optional BlockadeSpec: whom it stops, what it does).
// This system keeps the blockade records and every rule around them (the numbers live in shared/naval.ts):
//   * zones: a blockade is in force while one of its warships holds the station; its disc (150 km) is public;
//   * routing: merchants and troop convoys a zone applies to plan around it (WaterNav.findPathAvoid) when there is a
//     way; a merchant is paid for the direct trip, so the detour costs its port income per hour; with no way around a
//     port gets no partner through there (its idle ships are lost income), ships already at sea run the blockade;
//   * interception: blockading warships go for the ships the zone applies to inside it: board (merchants change flag
//     and sail to the captor's nearest port with their cargo; convoys are forced back home) or sink; escorted ships
//     are not boarded (at war the escort is fought first; at peace the convoy passes);
//   * accounting: per blockade (ships stopped per nation, seized gold, the enemy's lost trade, troops denied, with
//     24 h per-hour figures) and per player (trade lost to blockades, seized gold gained);
//   * consequences: stopping a nation at peace is piracy (opinion per ship, its allies, casus belli); the AI decides
//     its answer (sim/ai/navalwar.ts) from the shipStopped events;
//   * command mode: a controlled warship hails, fires a warning shot, boards or sinks a ship (commandIntercept).

import { HUMAN_ID, MAP_W, PORT_TRADE_GOLD_PER_HOUR, TILE_KM, UNIT_DEFS, structureLevel } from '../shared/constants';
import {
  BLOCKADE_JOIN_TILES, BLOCKADE_RADIUS_TILES, BLOCKADE_STATION_TILES, BLOCKADE_WINDOW_HOURS, CHOKEPOINTS, HEAVE_TO_TICKS,
  INTERCEPT_TILES, PIRACY_OPINION, blockadeApplies, blockadeSpec, chokepointNear, chokepointTile, pathCrossesZone, zoneDist2,
  type BlockadeNationStat, type BlockadeRelations, type BlockadeSpec, type BlockadeView, type NavalEconomyView, type ShipKind,
} from '../shared/naval';
import { StructureType, UnitType } from '../shared/types';
import type { Game } from './game';
import { Mode, type Structure, type Unit } from './state';
import type { AvoidZone } from './water';

/**
 * A merchant facing a long detour may try to run the blockade instead: never below 1.5× the direct trip, then a chance
 * growing with the detour (ratio 2.5 → 50 %), at most 60 %.
 */
export function runChance(ratio: number): number {
  return Math.max(0, Math.min(0.6, (ratio - 1.5) / 2));
}
/** Ended blockades stay listed (panel, map) this long. */
const ENDED_KEEP_TICKS = 240;

interface NationRec {
  seized: number;
  sunk: number;
  turnedBack: number;
  rerouted: number;
  passed: number;
  lost: number;
  piracy: boolean;
}

/** One blockade (saved with the game graph as a plain object). */
export interface BlockadeRec {
  id: number;
  owner: number;
  kind: 'strait' | 'port' | 'sea';
  key: string;
  portId: number;
  x: number;
  y: number;
  spec: BlockadeSpec;
  startTick: number;
  endTick: number;
  active: boolean;
  onStation: number;
  warships: number[];
  seized: number;
  sunk: number;
  turnedBack: number;
  rerouted: number;
  passed: number;
  gold: number;
  enemyLost: number;
  troopsDenied: number;
  /** Per-hour rings (BLOCKADE_WINDOW_HOURS slots) of seized gold and of the trade the stopped nations lost. */
  goldRing: number[];
  lostRing: number[];
  nations: Map<number, NationRec>;
}

interface PlayerNaval {
  lostRing: number[];
  lostTotal: number;
  gainRing: number[];
  gainTotal: number;
  /** First hour with a loss or gain (the per-hour figures divide by the hours since, up to the window). */
  since: number;
}

export class NavalSystem {
  readonly blockades = new Map<number, BlockadeRec>();
  private readonly players = new Map<number, PlayerNaval>();
  /** Ports that found no partner because every route was closed: port id -> blockade id. */
  private readonly portCut = new Map<number, number>();
  /** Bumped whenever the set of zones in force changes (ships at sea re-check their route once). */
  version = 1;
  dirty = true;
  private hour = 0;
  /** Scratch (not saved). */
  private readonly rel: BlockadeRelations;

  constructor(private readonly g: Game) {
    this.rel = {
      atWar: (a, b) => g.war.atWar(a, b),
      allied: (a, b) => g.isAllied(a, b),
      embargoes: (a, b) => g.playerById[a]?.embargoes.has(b) ?? false,
    };
  }

  // =================================================================================================
  // Orders
  // =================================================================================================
  /**
   * A warship takes a blockade station at water tile `tile` (its path is planned by the caller): it joins its owner's
   * blockade within BLOCKADE_JOIN_TILES (which takes the new spec) or starts one. A strait within CHOKEPOINT_SNAP_TILES
   * becomes the zone's centre.
   */
  assign(u: Unit, tile: number, spec0: Partial<BlockadeSpec> | undefined): BlockadeRec {
    const g = this.g;
    const spec = blockadeSpec(spec0);
    this.release(u);
    const x = (tile % MAP_W) + 0.5, y = Math.floor(tile / MAP_W) + 0.5;
    const cp = chokepointNear(x, y);
    let cx = x, cy = y;
    if (cp) {
      const t = chokepointTile(cp);
      cx = (t % MAP_W) + 0.5;
      cy = Math.floor(t / MAP_W) + 0.5;
    }
    let b: BlockadeRec | undefined;
    for (const r of this.blockades.values()) {
      if (r.owner !== u.owner || r.endTick) continue;
      if (zoneDist2(r.x, r.y, cx, cy) <= BLOCKADE_JOIN_TILES * BLOCKADE_JOIN_TILES) {
        b = r;
        break;
      }
    }
    if (!b) {
      let kind: BlockadeRec['kind'] = cp ? 'strait' : 'sea';
      let portId = 0;
      if (!cp) {
        // A port of another nation inside the zone: the blockade is named after it.
        let bd = Infinity;
        for (const s of g.structuresNear(cx, cy, BLOCKADE_RADIUS_TILES) as Structure[]) {
          if (s.type !== StructureType.Port || s.owner === u.owner) continue;
          const d = zoneDist2(cx, cy, s.x, s.y);
          if (d < bd && d <= BLOCKADE_RADIUS_TILES * BLOCKADE_RADIUS_TILES) {
            bd = d;
            portId = s.id;
          }
        }
        if (portId) kind = 'port';
      }
      b = {
        id: g.allocId(), owner: u.owner, kind, key: cp?.key ?? '', portId, x: cx, y: cy, spec, startTick: g.tick, endTick: 0,
        active: false, onStation: 0, warships: [], seized: 0, sunk: 0, turnedBack: 0, rerouted: 0, passed: 0, gold: 0, enemyLost: 0,
        troopsDenied: 0, goldRing: new Array(BLOCKADE_WINDOW_HOURS).fill(0), lostRing: new Array(BLOCKADE_WINDOW_HOURS).fill(0), nations: new Map(),
      };
      this.blockades.set(b.id, b);
    } else b.spec = spec;
    b.warships.push(u.id);
    u.blockadeId = b.id;
    this.dirty = true;
    this.version++;
    return b;
  }

  /** The warship leaves its blockade (another order, death); the blockade ends with its last warship. */
  release(u: Unit): void {
    if (!u.blockadeId) return;
    const b = this.blockades.get(u.blockadeId);
    u.blockadeId = 0;
    if (!b) return;
    const i = b.warships.indexOf(u.id);
    if (i >= 0) b.warships.splice(i, 1);
    if (!b.warships.length && !b.endTick) this.end(b);
    this.dirty = true;
    this.version++;
  }

  private end(b: BlockadeRec): void {
    const g = this.g;
    b.endTick = g.tick;
    if (b.active) {
      b.active = false;
      g.emit({ type: 'blockade', tick: g.tick, blockade: b.id, owner: b.owner, stage: 'end', kind: b.kind, key: b.key, portId: b.portId, x: b.x, y: b.y, spec: b.spec });
      // Feedback 3 fix 2 (29d): the lifted blockade's report — how long it held, what it stopped and what it earned.
      const humanHit = b.nations.get(HUMAN_ID);
      if (b.owner === HUMAN_ID || humanHit) {
        const mine = b.owner === HUMAN_ID ? b : humanHit!;
        let enemy = 0, most = -1;
        for (const [n, r] of b.nations) if (n !== b.owner && r.seized + r.sunk + r.turnedBack + r.rerouted > most) {
          most = r.seized + r.sunk + r.turnedBack + r.rerouted;
          enemy = n;
        }
        g.emit({
          type: 'afterAction', tick: g.tick, kind: 'mission', owner: b.owner, enemy: b.owner === HUMAN_ID ? enemy : HUMAN_ID, result: 'ended',
          x: b.x, y: b.y, startTick: b.startTick, tilesTaken: 0, tilesLost: 0, lossesOwn: 0, lossesEnemy: 0, order: 'blockade', unitType: UnitType.Warship,
          seized: mine.seized, sunk: mine.sunk, turnedBack: mine.turnedBack, gold: Math.round(b.owner === HUMAN_ID ? b.gold : 0),
          enemyLost: Math.round(b.owner === HUMAN_ID ? b.enemyLost : humanHit!.lost), blockadeId: b.id,
        });
      }
    }
    this.version++;
    this.dirty = true;
  }

  /** The blockade a warship holds (null = none). */
  of(u: Unit): BlockadeRec | null {
    if (!u.blockadeId) return null;
    const b = this.blockades.get(u.blockadeId);
    return b && !b.endTick ? b : null;
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  step(): void {
    const g = this.g;
    for (const b of this.blockades.values()) {
      if (b.endTick) {
        if (g.tick - b.endTick > ENDED_KEEP_TICKS) {
          this.blockades.delete(b.id);
          this.dirty = true;
        }
        continue;
      }
      let on = 0;
      for (let i = b.warships.length - 1; i >= 0; i--) {
        const w = g.unitMap.get(b.warships[i]);
        if (!w || w.dead || w.mode !== Mode.Blockade || w.blockadeId !== b.id) {
          if (w && w.blockadeId === b.id) w.blockadeId = 0;
          b.warships.splice(i, 1);
          this.dirty = true;
          continue;
        }
        if (zoneDist2(w.stationX, w.stationY, w.x, w.y) <= BLOCKADE_STATION_TILES * BLOCKADE_STATION_TILES) on++;
      }
      if (!b.warships.length) {
        this.end(b);
        continue;
      }
      if (on !== b.onStation) {
        b.onStation = on;
        this.dirty = true;
      }
      const active = on > 0;
      if (active !== b.active) {
        b.active = active;
        this.version++;
        this.dirty = true;
        g.emit({ type: 'blockade', tick: g.tick, blockade: b.id, owner: b.owner, stage: active ? 'start' : 'end', kind: b.kind, key: b.key, portId: b.portId, x: b.x, y: b.y, spec: b.spec });
      }
    }
    if (this.version !== this.navVersion) {
      this.navVersion = this.version;
      g.nav.clearAvoidCache();
    }
    // Ships at sea re-check their route once after the zones changed (spread over 10 ticks by id).
    if (this.anyActive()) {
      for (const u of g.unitMap.values()) {
        if ((u.type !== UnitType.TradeShip && u.type !== UnitType.TransportShip) || u.dead || u.navalVer === this.version) continue;
        if ((u.id + g.tick) % 10 !== 0) continue;
        u.navalVer = this.version;
        this.recheck(u);
      }
    }
    if (g.tick % 10 === 0) this.hourly();
  }
  private navVersion = 0;

  private anyActive(): boolean {
    for (const b of this.blockades.values()) if (b.active) return true;
    return false;
  }

  /** The zones in force that apply to ships of `owner` of this kind. */
  zonesFor(owner: number, kind: ShipKind): BlockadeRec[] {
    const out: BlockadeRec[] = [];
    for (const b of this.blockades.values()) {
      if (b.active && blockadeApplies(this.rel, b.owner, b.spec, owner, kind)) out.push(b);
    }
    return out;
  }

  /** Does blockade `b` apply to this ship? */
  applies(b: BlockadeRec, ship: Unit): boolean {
    const kind: ShipKind | null = ship.type === UnitType.TradeShip ? 'trade' : ship.type === UnitType.TransportShip ? 'transport' : null;
    if (!kind || ship.prize) return false;
    return blockadeApplies(this.rel, b.owner, b.spec, ship.owner, kind);
  }

  /** Is (x, y) inside blockade b's zone? */
  inZone(b: BlockadeRec, x: number, y: number): boolean {
    return zoneDist2(b.x, b.y, x, y) <= BLOCKADE_RADIUS_TILES * BLOCKADE_RADIUS_TILES;
  }

  /** The blockade in force closing port `s` to its own merchants (0 = none): the port lies inside a zone that applies. */
  portBlockade(s: Structure): BlockadeRec | null {
    for (const b of this.blockades.values()) {
      if (!b.active || !this.inZone(b, s.x, s.y)) continue;
      if (blockadeApplies(this.rel, b.owner, b.spec, s.owner, 'trade')) return b;
    }
    return null;
  }

  // =================================================================================================
  // Routing
  // =================================================================================================
  /**
   * The route of a new merchant or convoy of `owner` from water tile a to water tile b whose direct path is `direct`:
   * the direct path when no zone applying to it lies across it; else the detour around them; else (no way around)
   * null for a merchant (no trade through there) and the direct path for a convoy (it runs the blockade). A merchant
   * facing a detour longer than 2.5× the direct trip runs the blockade half the time.
   */
  route(owner: number, kind: ShipKind, a: number, b: number, direct: Int32Array): { path: Int32Array; by: number; directKm: number; km: number; run: boolean } | { blocked: BlockadeRec } {
    const g = this.g;
    const directKm = pathKm(direct, 0, (a % MAP_W) + 0.5, Math.floor(a / MAP_W) + 0.5);
    const zones = this.zonesFor(owner, kind);
    if (!zones.length) return { path: direct, by: 0, directKm, km: directKm, run: false };
    const sx = (a % MAP_W) + 0.5, sy = Math.floor(a / MAP_W) + 0.5;
    const crossing = zones.filter((z) => pathCrossesZone(direct, 1, sx, sy, z.x, z.y, BLOCKADE_RADIUS_TILES));
    if (!crossing.length) return { path: direct, by: 0, directKm, km: directKm, run: false };
    const detour = g.nav.findPathAvoid(a, b, zones.map(avoidOf), zonesKey(zones));
    if (!detour) {
      if (kind === 'transport') return { path: direct, by: crossing[0].id, directKm, km: directKm, run: true };
      return { blocked: crossing[0] };
    }
    const km = pathKm(detour, 0, sx, sy);
    if (kind === 'trade' && g.rngUnits.next() < runChance(km / Math.max(1, directKm))) {
      return { path: direct, by: crossing[0].id, directKm, km: directKm, run: true };
    }
    return { path: detour, by: crossing[0].id, directKm, km, run: false };
  }

  /** A merchant or convoy at sea after the zones changed: steer around a zone ahead that applies to it, if it can. */
  private recheck(u: Unit): void {
    const g = this.g;
    if (!u.path || u.prize || u.mode === Mode.Return || u.pathI >= u.path.length) return;
    const kind: ShipKind = u.type === UnitType.TradeShip ? 'trade' : 'transport';
    const zones = this.zonesFor(u.owner, kind);
    if (!zones.length) return;
    const ahead = zones.filter((z) => !this.inZone(z, u.x, u.y) && pathCrossesZone(u.path!, u.pathI, u.x, u.y, z.x, z.y, BLOCKADE_RADIUS_TILES));
    if (!ahead.length) return;
    const here = g.unitSys.waterTileOf(u);
    const goal = u.path[u.path.length - 1];
    const oldKm = pathKm(u.path, u.pathI, u.x, u.y);
    const detour = g.nav.findPathAvoid(here, goal, zones.map(avoidOf), zonesKey(zones));
    if (!detour) return; // no way around: it runs the blockade
    const km = pathKm(detour, 0, u.x, u.y);
    // A merchant already at sea may try its luck rather than sail the long way round.
    if (u.type === UnitType.TradeShip && g.rngUnits.next() < runChance(km / Math.max(1, oldKm))) return;
    const b = ahead[0];
    u.detourBy = b.id;
    g.unitSys.setPath(u, detour, oldKm);
    this.noteReroute(u, b, Math.max(0, km - oldKm));
  }

  /** A merchant or convoy took a detour of `extraKm` around blockade b (accounting and the human's alert). */
  noteReroute(u: Unit, b: BlockadeRec, extraKm: number): void {
    const g = this.g;
    b.rerouted++;
    const n = this.nation(b, u.owner);
    n.rerouted++;
    // The ship earns its slot rate per hour of the direct trip only: the extra hours are the port's lost income, booked
    // hour by hour while it sails the detour (hourly); the alert gives the whole trip's estimate.
    const lost = u.type === UnitType.TradeShip && u.slotRate > 0 ? (u.slotRate * extraKm) / UNIT_DEFS[UnitType.TradeShip].speedKmh : 0;
    this.dirty = true;
    if (u.owner === HUMAN_ID || b.owner === HUMAN_ID) {
      g.emit({
        type: 'shipRerouted', tick: g.tick, unitId: u.id, owner: u.owner, unit: u.type, blockade: b.id, by: b.owner,
        extraKm: Math.round(extraKm), lost: Math.round(lost), x: u.x, y: u.y,
      });
    }
  }

  /** A port found no partner: every route runs into blockade b (its idle ships are lost income until it does). */
  noteCut(port: Structure, b: BlockadeRec): void {
    if (this.portCut.get(port.id) !== b.id) this.dirty = true;
    this.portCut.set(port.id, b.id);
  }

  noteLaunched(port: Structure): void {
    if (this.portCut.delete(port.id)) this.dirty = true;
  }

  // =================================================================================================
  // Interception
  // =================================================================================================
  /**
   * Is `ship` one blockading warship `w` should go for? Inside its zone, the blockade applies, not let through
   * already. Returns the unit to engage: the ship itself, or its escort when the escort must be fought first (at war
   * with the escort's owner); null when the ship is escorted by a nation at peace (it passes).
   */
  targetFor(w: Unit, ship: Unit): Unit | null {
    const b = this.of(w);
    if (!b || !b.active || ship.dead || !this.applies(b, ship) || !this.inZone(b, ship.x, ship.y)) return null;
    if (ship.passedBy === b.id || (ship.mode === Mode.Return && ship.stoppedBy !== 0)) return null;
    const escort = this.g.unitSys.escortNear(ship);
    if (escort) {
      if (this.g.war.atWar(w.owner, escort.owner)) return escort;
      if (ship.passedBy !== b.id) {
        ship.passedBy = b.id;
        b.passed++;
        this.nation(b, ship.owner).passed++;
        this.dirty = true;
        if (ship.owner === HUMAN_ID || b.owner === HUMAN_ID) this.stopped(b, ship, 'passed', 0, 0, false);
      }
      return null;
    }
    return ship;
  }

  /**
   * Warship `w` of blockade b (or a warship ordered to attack / in command mode, b = null) is within reach of `ship`:
   * board it or sink it (b.spec.action; `force` overrides). Merchants boarded change flag and sail to our nearest port;
   * convoys boarded are sent back where they came from.
   */
  intercept(ship: Unit, w: Unit, b: BlockadeRec | null, force?: 'seize' | 'sink'): void {
    const g = this.g;
    if (ship.dead || w.dead || ship.prize || ship.owner === w.owner || g.isAllied(w.owner, ship.owner)) return;
    // Already turned back by a warship: it is going home.
    if (ship.mode === Mode.Return && ship.stoppedBy !== 0) return;
    const action = force ?? b?.spec.action ?? 'seize';
    const victim = ship.owner;
    const piracy = !g.war.atWar(w.owner, victim);
    if (ship.type === UnitType.TradeShip) {
      const gold = ship.cargo;
      if (b) this.addLoss(b, victim, gold);
      else this.addPlayerLoss(victim, gold);
      g.unitSys.tradeTaken(ship);
      if (action === 'sink') {
        if (b) {
          b.sunk++;
          this.nation(b, victim).sunk++;
        }
        g.emit({ type: 'combat', tick: g.tick, kind: 'shell', owner: w.owner, fromX: w.x, fromY: w.y, toX: ship.x, toY: ship.y, hit: true });
        this.stopped(b, ship, 'sunk', gold, 0, piracy, w);
        g.unitSys.kill(ship, w.owner);
      } else {
        if (b) {
          b.seized++;
          this.nation(b, victim).seized++;
        }
        g.emit({ type: 'shipCaptured', tick: g.tick, unitId: ship.id, from: victim, by: w.owner, warshipId: w.id, gold: Math.round(gold), x: ship.x, y: ship.y });
        this.stopped(b, ship, 'seized', gold, 0, piracy, w);
        g.unitSys.takePrize(ship, w.owner, b?.id ?? 0);
      }
      if (piracy) this.piracy(w.owner, victim, action === 'sink' ? 'sink' : 'seize');
    } else if (ship.type === UnitType.TransportShip) {
      const troops = g.unitSys.convoyTroops(ship);
      if (action === 'sink') {
        // The warship's guns do it (two hits; escorts slow it): the loss is counted when it goes down (onShipLost).
        w.targetUnit = ship.id;
        return;
      }
      if (b) {
        b.turnedBack++;
        b.troopsDenied += troops;
        this.nation(b, victim).turnedBack++;
      }
      this.stopped(b, ship, 'turnedBack', 0, troops, piracy, w);
      ship.stoppedBy = b?.id ?? -1;
      g.unitSys.turnBack(ship);
      if (piracy) this.piracy(w.owner, victim, 'turnBack');
    }
    this.dirty = true;
  }

  /** A merchant or convoy went down: a blockade's warship (or any warship at peace with it) did it. */
  onShipLost(ship: Unit, by: number): void {
    const g = this.g;
    if (ship.type !== UnitType.TransportShip || by <= 0 || by === ship.owner) return;
    let b: BlockadeRec | null = null;
    for (const r of this.blockades.values()) {
      if (r.owner === by && r.active && this.inZone(r, ship.x, ship.y)) {
        b = r;
        break;
      }
    }
    const troops = g.unitSys.convoyTroops(ship);
    const piracy = !g.war.atWar(by, ship.owner);
    if (b) {
      b.sunk++;
      b.troopsDenied += troops;
      this.nation(b, ship.owner).sunk++;
      this.dirty = true;
    }
    if (b || piracy) this.stopped(b, ship, 'sunk', 0, troops, piracy, undefined, by);
    if (piracy) this.piracy(by, ship.owner, 'sinkTroops');
  }

  /** A prize reached our port: its cargo is ours. */
  onPrizeDelivered(ship: Unit, port: Structure | undefined): void {
    const g = this.g;
    const gold = ship.cargo;
    g.addGold(ship.owner, gold);
    const P = g.playerById[ship.owner];
    if (P) P.tradeGold += gold;
    const b = this.blockades.get(ship.stoppedBy);
    if (b) {
      b.gold += gold;
      b.goldRing[this.hour % BLOCKADE_WINDOW_HOURS] += gold;
    }
    this.playerRec(ship.owner).gainRing[this.hour % BLOCKADE_WINDOW_HOURS] += gold;
    this.playerRec(ship.owner).gainTotal += gold;
    this.dirty = true;
    const tile = port?.tile ?? g.unitSys.waterTileOf(ship);
    g.emit({ type: 'goldBonus', tick: g.tick, playerId: ship.owner, gold: Math.round(gold), tile, reason: 'trade' });
    g.emit({ type: 'prizeDelivered', tick: g.tick, unitId: ship.id, owner: ship.owner, from: ship.targetPlayer, gold: Math.round(gold), tile, blockade: ship.stoppedBy });
  }

  // =================================================================================================
  // Command mode (a controlled warship): hail, warning shot, board, sink
  // =================================================================================================
  /** Error key (i18n) or null: may warship `w` do `act` to `ship` now? */
  commandError(w: Unit | undefined, ship: Unit | undefined, act: 'hail' | 'warn' | 'board' | 'sink'): string | null {
    if (!w || w.dead || w.type !== UnitType.Warship) return 'naval.err.noShip';
    if (!ship || ship.dead || (ship.type !== UnitType.TradeShip && ship.type !== UnitType.TransportShip)) return 'naval.err.noTarget';
    if (ship.owner === w.owner || this.g.isAllied(w.owner, ship.owner)) return 'naval.err.friendly';
    if (ship.prize) return 'naval.err.prize';
    const km = Math.sqrt(zoneDist2(w.x, w.y, ship.x, ship.y)) * TILE_KM;
    const reach = act === 'board' ? INTERCEPT_TILES * TILE_KM : act === 'sink' || act === 'warn' ? 30 : 50;
    if (km > reach) return act === 'board' ? 'naval.err.tooFarBoard' : 'naval.err.tooFar';
    if (act === 'board' && this.g.unitSys.escortNear(ship)) return 'naval.err.escorted';
    return null;
  }

  commandIntercept(w: Unit | undefined, ship: Unit | undefined, act: 'hail' | 'warn' | 'board' | 'sink'): boolean {
    const g = this.g;
    if (this.commandError(w, ship, act) !== null) return false;
    const piracy = !g.war.atWar(w!.owner, ship!.owner);
    switch (act) {
      case 'hail':
      case 'warn':
        // The ship heaves to for inspection (a warning shot makes sure of it).
        ship!.hoveUntil = g.tick + HEAVE_TO_TICKS;
        if (act === 'warn') {
          g.emit({ type: 'combat', tick: g.tick, kind: 'shell', owner: w!.owner, fromX: w!.x, fromY: w!.y, toX: ship!.x + 0.2, toY: ship!.y + 0.2, hit: false });
          if (piracy) this.piracy(w!.owner, ship!.owner, 'warningShot');
        }
        this.stopped(null, ship!, act === 'hail' ? 'hailed' : 'warned', 0, 0, piracy && act === 'warn', w);
        return true;
      case 'board':
        this.intercept(ship!, w!, null, 'seize');
        return true;
      case 'sink':
        if (ship!.type === UnitType.TransportShip) {
          const troops = g.unitSys.convoyTroops(ship!);
          this.stopped(null, ship!, 'sunk', 0, troops, piracy, w);
          g.unitSys.kill(ship!, w!.owner);
          if (piracy) this.piracy(w!.owner, ship!.owner, 'sinkTroops');
          return true;
        }
        this.intercept(ship!, w!, null, 'sink');
        return true;
    }
    return false;
  }

  // =================================================================================================
  // Consequences
  // =================================================================================================
  /** Stopping ships of a nation at peace (§20.5): its opinion, its allies', the world's for sinkings; casus belli. */
  private piracy(offender: number, victim: number, kind: keyof typeof PIRACY_OPINION): void {
    const g = this.g;
    const d = g.diplomacy;
    d.addReason(victim, offender, 'piracy', PIRACY_OPINION[kind]);
    d.grantCasusBelli(victim, offender);
    const V = g.playerById[victim];
    for (const p of g.playerArr) {
      if (!p.alive || p.kind !== 'nation' || p.id === offender || p.id === victim) continue;
      if (V && V.allies.has(p.id)) {
        d.addReason(p.id, offender, 'piracyAlly', undefined, { player: victim });
        d.grantCasusBelli(p.id, offender);
      } else if (kind === 'sink' || kind === 'sinkTroops') d.addReason(p.id, offender, 'piracyWorld');
    }
  }

  private stopped(b: BlockadeRec | null, ship: Unit, action: 'seized' | 'sunk' | 'turnedBack' | 'passed' | 'hailed' | 'warned', gold: number, troops: number, piracy: boolean, w?: Unit, by?: number): void {
    const g = this.g;
    const owner = b?.owner ?? w?.owner ?? by ?? 0;
    if (b && piracy) this.nation(b, ship.owner).piracy = true;
    g.emit({
      type: 'shipStopped', tick: g.tick, blockade: b?.id ?? 0, by: owner, victim: ship.owner, unitId: ship.id, unit: ship.type,
      warshipId: w?.id ?? 0, action, gold: Math.round(gold), troops: Math.round(troops), x: ship.x, y: ship.y, piracy,
    });
  }

  // =================================================================================================
  // Accounting
  // =================================================================================================
  private nation(b: BlockadeRec, id: number): NationRec {
    let n = b.nations.get(id);
    if (!n) b.nations.set(id, (n = { seized: 0, sunk: 0, turnedBack: 0, rerouted: 0, passed: 0, lost: 0, piracy: false }));
    return n;
  }

  private playerRec(id: number): PlayerNaval {
    let p = this.players.get(id);
    if (!p) {
      p = { lostRing: new Array(BLOCKADE_WINDOW_HOURS).fill(0), lostTotal: 0, gainRing: new Array(BLOCKADE_WINDOW_HOURS).fill(0), gainTotal: 0, since: this.hour };
      this.players.set(id, p);
    }
    return p;
  }

  private addLoss(b: BlockadeRec, victim: number, gold: number): void {
    if (!(gold > 0)) return;
    b.enemyLost += gold;
    b.lostRing[this.hour % BLOCKADE_WINDOW_HOURS] += gold;
    this.nation(b, victim).lost += gold;
    this.addPlayerLoss(victim, gold);
  }

  private addPlayerLoss(victim: number, gold: number): void {
    if (!(gold > 0)) return;
    const p = this.playerRec(victim);
    p.lostRing[this.hour % BLOCKADE_WINDOW_HOURS] += gold;
    p.lostTotal += gold;
  }

  /** Every game hour: idle ports (blockaded or cut off) lose their idle ships' income; the rings move on. */
  private hourly(): void {
    const g = this.g;
    this.hour = Math.floor(g.tick / 10);
    const slot = this.hour % BLOCKADE_WINDOW_HOURS;
    for (const b of this.blockades.values()) {
      b.goldRing[slot] = 0;
      b.lostRing[slot] = 0;
    }
    for (const p of this.players.values()) {
      p.lostRing[slot] = 0;
      p.gainRing[slot] = 0;
    }
    if (!this.anyActive() && !this.portCut.size) return;
    // Merchants on a detour: the share of their slot's income the longer route costs, this hour.
    for (const u of g.unitMap.values()) {
      if (u.type !== UnitType.TradeShip || !u.detourBy || u.prize || u.slotRate <= 0 || u.routeKm <= 0) continue;
      const b = this.blockades.get(u.detourBy);
      if (!b) continue;
      this.addLoss(b, u.owner, u.slotRate * Math.max(0, 1 - u.directKm / u.routeKm));
    }
    for (const s of g.economy.portList()) {
      const b = this.portBlockade(s) ?? (this.portCut.has(s.id) ? this.blockades.get(this.portCut.get(s.id)!) ?? null : null);
      if (!b || !b.active) {
        if (this.portCut.has(s.id) && !b?.active) this.portCut.delete(s.id);
        continue;
      }
      const lv = Math.max(1, Math.min(3, s.level));
      const ships = structureLevel(s.type, lv).tradeShips ?? 2 * lv;
      const want = Math.round(ships * s.fn);
      let active = 0;
      for (const u of g.unitsByOwner.get(s.owner) ?? []) if (u.type === UnitType.TradeShip && u.home === s.id) active++;
      const idle = Math.max(0, want - active);
      if (idle > 0) this.addLoss(b, s.owner, (PORT_TRADE_GOLD_PER_HOUR[lv] / ships) * idle);
    }
    this.dirty = true;
  }

  private perHour(ring: number[], since: number): number {
    let s = 0;
    for (const v of ring) s += v;
    const hours = Math.max(1, Math.min(BLOCKADE_WINDOW_HOURS, this.hour - since + 1));
    return s / hours;
  }

  // =================================================================================================
  // Views
  // =================================================================================================
  views(): BlockadeView[] {
    const out: BlockadeView[] = [];
    for (const b of this.blockades.values()) {
      const since = Math.floor(b.startTick / 10);
      const nations: BlockadeNationStat[] = [];
      for (const [id, n] of b.nations) nations.push({ id, seized: n.seized, sunk: n.sunk, turnedBack: n.turnedBack, rerouted: n.rerouted, passed: n.passed, lost: Math.round(n.lost), piracy: n.piracy });
      out.push({
        id: b.id, owner: b.owner, kind: b.kind, key: b.key || undefined, portId: b.portId || undefined, x: b.x, y: b.y, r: BLOCKADE_RADIUS_TILES,
        spec: b.spec, warships: [...b.warships], onStation: b.onStation, active: b.active, startTick: b.startTick, endTick: b.endTick,
        seized: b.seized, sunk: b.sunk, turnedBack: b.turnedBack, rerouted: b.rerouted, passed: b.passed,
        gold: Math.round(b.gold), goldPerHour: Math.round(this.perHour(b.goldRing, since)),
        enemyLost: Math.round(b.enemyLost), enemyLostPerHour: Math.round(this.perHour(b.lostRing, since)),
        troopsDenied: Math.round(b.troopsDenied), nations,
      });
    }
    return out;
  }

  economyView(pid: number): NavalEconomyView {
    const g = this.g;
    const p = this.players.get(pid);
    let rerouted = 0, portsBlocked = 0;
    for (const u of g.unitsByOwner.get(pid) ?? []) if (u.type === UnitType.TradeShip && u.detourBy && !u.prize) rerouted++;
    for (const s of g.structByOwner.get(pid) ?? []) {
      if (s.type !== StructureType.Port) continue;
      if (this.portBlockade(s) || this.portCut.has(s.id)) portsBlocked++;
    }
    return {
      lostPerHour: p ? Math.round(this.perHour(p.lostRing, p.since)) : 0,
      lostTotal: p ? Math.round(p.lostTotal) : 0,
      gainPerHour: p ? Math.round(this.perHour(p.gainRing, p.since)) : 0,
      gainTotal: p ? Math.round(p.gainTotal) : 0,
      rerouted, portsBlocked,
    };
  }

  /** Port card: trade income this port loses per hour now (blockaded or cut off: its idle ships; detours at sea). */
  portLoss(s: Structure): { perHour: number; by: number; cut: boolean; rerouted: number } | null {
    const g = this.g;
    const blocked = this.portBlockade(s);
    const cutId = this.portCut.get(s.id);
    const cutB = cutId ? this.blockades.get(cutId) : undefined;
    let rerouted = 0, detourLoss = 0;
    for (const u of g.unitsByOwner.get(s.owner) ?? []) {
      if (u.type !== UnitType.TradeShip || u.home !== s.id || !u.detourBy) continue;
      rerouted++;
      detourLoss += u.slotRate * (1 - Math.min(1, u.directKm / Math.max(1, u.routeKm)));
    }
    const b = blocked ?? (cutB && cutB.active ? cutB : null);
    if (!b && !rerouted) return null;
    let idleLoss = 0;
    if (b) {
      const lv = Math.max(1, Math.min(3, s.level));
      const ships = structureLevel(s.type, lv).tradeShips ?? 2 * lv;
      const want = Math.round(ships * s.fn);
      let active = 0;
      for (const u of g.unitsByOwner.get(s.owner) ?? []) if (u.type === UnitType.TradeShip && u.home === s.id) active++;
      idleLoss = (PORT_TRADE_GOLD_PER_HOUR[lv] / ships) * Math.max(0, want - active);
    }
    return { perHour: Math.round(idleLoss + detourLoss), by: b?.owner ?? 0, cut: !blocked && !!b, rerouted };
  }

  blockadeOfUnit(unitId: number): number {
    const u = this.g.unitMap.get(unitId);
    return u ? this.of(u)?.id ?? 0 : 0;
  }

  activeAgainst(p: number): { id: number; owner: number; x: number; y: number; warships: readonly number[] }[] {
    const out: { id: number; owner: number; x: number; y: number; warships: readonly number[] }[] = [];
    for (const b of this.blockades.values()) {
      if (!b.active) continue;
      if (blockadeApplies(this.rel, b.owner, b.spec, p, 'trade') || blockadeApplies(this.rel, b.owner, b.spec, p, 'transport')) {
        out.push({ id: b.id, owner: b.owner, x: b.x, y: b.y, warships: b.warships });
      }
    }
    return out;
  }

  /** AI: chokepoints ordered by how many ships of `enemy` sail through them now (the strait worth closing). */
  chokepointsFor(enemy: number): { key: string; tile: number; ships: number }[] {
    const g = this.g;
    const out: { key: string; tile: number; ships: number }[] = [];
    for (const c of CHOKEPOINTS) {
      const t = chokepointTile(c);
      const cx = (t % MAP_W) + 0.5, cy = Math.floor(t / MAP_W) + 0.5;
      let n = 0;
      for (const u of g.unitsByOwner.get(enemy) ?? []) {
        if ((u.type !== UnitType.TradeShip && u.type !== UnitType.TransportShip) || !u.path || u.prize) continue;
        if (pathCrossesZone(u.path, u.pathI, u.x, u.y, cx, cy, BLOCKADE_RADIUS_TILES)) n++;
      }
      if (n > 0) out.push({ key: c.key, tile: t, ships: n });
    }
    out.sort((p, q) => q.ships - p.ships);
    return out;
  }
}

function avoidOf(b: BlockadeRec): AvoidZone {
  return { x: b.x, y: b.y, r: BLOCKADE_RADIUS_TILES };
}

function zonesKey(zones: readonly BlockadeRec[]): string {
  return zones.map((z) => z.id).sort((p, q) => p - q).join(',');
}

/** Km along a path of tile waypoints from index `from`, starting at (sx, sy). */
export function pathKm(path: ArrayLike<number>, from: number, sx: number, sy: number): number {
  let km = 0, px = sx, py = sy;
  for (let i = from; i < path.length; i++) {
    const t = path[i];
    const qx = (t % MAP_W) + 0.5, qy = Math.floor(t / MAP_W) + 0.5;
    km += Math.sqrt(zoneDist2(px, py, qx, qy)) * TILE_KM;
    px = qx;
    py = qy;
  }
  return km;
}
