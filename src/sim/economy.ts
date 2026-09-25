// FRONT ULTRA — economy: troop growth, gold income, civilians, construction & upgrades of structures, repairs,
// capture/destruction, the rail network (factories send gold trains to cities & ports) and maritime trade.
// Owner: sim-core. Worker-only.

import {
  BALANCE, HUMAN_ID, MAP_W, POP_DRIFT_PER_HOUR, POP_PER_CITY_LEVEL, POP_PER_TILE, STRUCTURE_DEFS, TICKS_PER_GAME_HOUR,
  TILE_COUNT, TROOP_REGROWTH_SCALE, WAR_GROWTH_MUL, structureCost,
} from '../shared/constants';
import { STRUCTURE_TYPES, StructureType, UnitType } from '../shared/types';
import {
  CIVILIANS_PER_CITY_LEVEL, CIVILIANS_PER_TILE, DEMOLISH_REFUND, GOLD_BASE_PER_TICK, GOLD_PER_CITY_LEVEL_PER_TICK,
  GOLD_PER_TILE_PER_TICK, RADAR_RANGE, RAIL_MAX_LINK, RAIL_MAX_LINKS_PER_STATION, SAM_COOLDOWN_TICKS,
  SILO_COOLDOWN_TICKS, STRUCTURE_REPAIR_DELAY, STRUCTURE_REPAIR_PER_TICK, TRADE_MAX_PER_PORT_LEVEL,
  TRADE_MIN_DISTANCE, TRADE_SPAWN_CHANCE_PER_LEVEL, TRAIN_INTERVAL_TICKS, baseMaxTroops, kindCapMul,
  kindGoldMul, kindGrowthMul, trainGold, troopGrowthPerTick,
} from './balance';
import type { Game } from './game';
import { Mode, Player, Structure } from './state';
import { dist2, wdx } from './spatial';

const STATION_TYPES = new Set<number>([StructureType.City, StructureType.Port, StructureType.Factory]);

export class EconomySystem {
  private railDirty = true;
  private lastRailBuild = -100;
  private readonly ports: Structure[] = [];
  private readonly comps: number[] = [];
  private readonly comps2: number[] = [];

  private readonly atWarSet = new Set<number>();

  /** Population target of a player (§6.7): 25,000 per tile + 800,000 per built city level. */
  popTargetOf(p: Player): number {
    return p.tiles * POP_PER_TILE + p.structLevels[StructureType.City] * POP_PER_CITY_LEVEL;
  }

  constructor(private readonly g: Game) {}

  // =================================================================================================
  // Aggregates
  // =================================================================================================
  recount(pid: number): void {
    const p = this.g.playerById[pid];
    if (!p) return;
    p.structCount.fill(0);
    p.structLevels.fill(0);
    for (const s of this.g.structByOwner.get(pid) ?? []) {
      p.structCount[s.type]++;
      if (s.built >= 1) p.structLevels[s.type] += s.level;
    }
  }

  refreshAll(): void {
    for (const p of this.g.playerArr) this.recount(p.id);
    this.railDirty = true;
  }

  // =================================================================================================
  // Structures: registry
  // =================================================================================================
  private register(s: Structure): void {
    const g = this.g;
    g.structureMap.set(s.id, s);
    g.structGrid.add(s);
    g.structAt[s.tile] = s.id;
    let list = g.structByOwner.get(s.owner);
    if (!list) g.structByOwner.set(s.owner, (list = []));
    list.push(s);
    if (s.type === StructureType.Port) this.ports.push(s);
    g.structuresDirty = true;
    if (STATION_TYPES.has(s.type)) this.railDirty = true;
    this.recount(s.owner);
  }

  private unregister(s: Structure): void {
    const g = this.g;
    g.structureMap.delete(s.id);
    g.structGrid.remove(s);
    if (g.structAt[s.tile] === s.id) g.structAt[s.tile] = 0;
    const list = g.structByOwner.get(s.owner);
    if (list) {
      const i = list.indexOf(s);
      if (i >= 0) list.splice(i, 1);
    }
    if (s.type === StructureType.Port) {
      const i = this.ports.indexOf(s);
      if (i >= 0) this.ports.splice(i, 1);
    }
    g.structuresDirty = true;
    if (STATION_TYPES.has(s.type)) this.railDirty = true;
    this.recount(s.owner);
  }

  private moveOwner(s: Structure, owner: number): void {
    const g = this.g;
    const old = g.structByOwner.get(s.owner);
    if (old) {
      const i = old.indexOf(s);
      if (i >= 0) old.splice(i, 1);
    }
    const prev = s.owner;
    s.owner = owner;
    let list = g.structByOwner.get(owner);
    if (!list) g.structByOwner.set(owner, (list = []));
    list.push(s);
    g.structuresDirty = true;
    if (STATION_TYPES.has(s.type)) this.railDirty = true;
    this.recount(prev);
    this.recount(owner);
  }

  // =================================================================================================
  // Commands
  // =================================================================================================
  build(p: Player, type: StructureType, tile: number): boolean {
    const g = this.g;
    const err = g.buildError(p.id, type, tile);
    if (err) {
      g.message(p.id, err);
      return false;
    }
    const cost = g.structureCost(p.id, type);
    p.gold -= cost;
    p.stats.goldSpent += cost;
    const s = new Structure(g.allocId(), type, p.id, tile);
    s.built = 0;
    if (type === StructureType.Factory) s.timer = g.tick + STRUCTURE_DEFS[type].buildTicks + 60;
    this.register(s);
    return true;
  }

  upgrade(p: Player, structureId: number): boolean {
    const g = this.g;
    const s = g.structureMap.get(structureId);
    if (!s || s.owner !== p.id) return false;
    if (s.built < 1) {
      g.message(p.id, 'msg.underConstruction');
      return false;
    }
    if (s.level >= STRUCTURE_DEFS[s.type].maxLevel) {
      g.message(p.id, 'msg.maxLevel');
      return false;
    }
    const cost = g.structureCost(p.id, s.type);
    if (p.gold < cost) {
      g.message(p.id, 'msg.notEnoughGold');
      return false;
    }
    p.gold -= cost;
    p.stats.goldSpent += cost;
    s.level++;
    s.hp = 1;
    this.recount(p.id);
    g.structuresDirty = true;
    g.emit({ type: 'structureUpgraded', tick: g.tick, structureId: s.id, owner: p.id, structure: s.type, level: s.level, tile: s.tile });
    return true;
  }

  demolish(p: Player, structureId: number): boolean {
    const g = this.g;
    const s = g.structureMap.get(structureId);
    if (!s || s.owner !== p.id) return false;
    const refund = Math.round(structureCost(s.type, Math.max(0, p.structCount[s.type] - 1)) * DEMOLISH_REFUND * (s.built >= 1 ? 1 : 2));
    g.addGold(p.id, refund);
    this.destroyStructure(s, p.id);
    return true;
  }

  /** Staging: a finished structure at any tile (replacing whatever stood there). */
  spawnStructure(type: StructureType, owner: number, tile: number, level: number): void {
    const g = this.g;
    if (tile < 0 || tile >= TILE_COUNT || !(type in STRUCTURE_DEFS)) return;
    const old = g.structAt[tile];
    if (old) {
      const s = g.structureMap.get(old);
      if (s) this.unregister(s);
    }
    const s = new Structure(g.allocId(), type, owner, tile);
    s.built = 1;
    s.level = Math.max(1, Math.min(STRUCTURE_DEFS[type].maxLevel, level | 0));
    s.timer = g.tick + 20;
    this.register(s);
    g.emit({ type: 'structureBuilt', tick: g.tick, structureId: s.id, owner, structure: type, tile });
  }

  destroyStructure(s: Structure, by: number): void {
    const g = this.g;
    if (!g.structureMap.has(s.id)) return;
    this.unregister(s);
    const k = g.playerById[by];
    if (k && by !== s.owner) k.stats.structuresDestroyed++;
    // Aircraft parked on a destroyed airbase burn with it.
    if (s.type === StructureType.Airbase) {
      for (const u of (g.unitsByOwner.get(s.owner) ?? []).slice()) {
        if (u.home === s.id && u.mode === Mode.Docked) g.unitSys.kill(u, by);
      }
    }
    g.emit({ type: 'structureDestroyed', tick: g.tick, structureId: s.id, owner: s.owner, structure: s.type, tile: s.tile, by });
    if (s.owner === HUMAN_ID && by !== HUMAN_ID) g.message(HUMAN_ID, 'msg.structureLost', 'warning', { structure: s.type });
  }

  /** The land under a structure changed hands. */
  onTileCaptured(sid: number, prev: number, next: number): void {
    const g = this.g;
    const s = g.structureMap.get(sid);
    if (!s || s.owner === next) return;
    if (next === 0 || s.type === StructureType.DefensePost) {
      this.destroyStructure(s, next === 0 ? 0 : next);
      return;
    }
    this.moveOwner(s, next);
    // Docked aircraft on a captured airbase are lost.
    if (s.type === StructureType.Airbase) {
      for (const u of (g.unitsByOwner.get(prev) ?? []).slice()) {
        if (u.home === s.id && u.mode === Mode.Docked) g.unitSys.kill(u, next);
      }
    }
    g.emit({ type: 'structureCaptured', tick: g.tick, structureId: s.id, structure: s.type, tile: s.tile, from: prev, to: next });
    if (prev === HUMAN_ID) g.message(HUMAN_ID, 'msg.structureCaptured', 'warning', { structure: s.type });
  }

  cooldownFraction(s: Structure): number {
    if (s.cooldownTicks <= 0) return 0;
    if (s.type === StructureType.MissileSilo) return Math.min(1, s.cooldownTicks / ((SILO_COOLDOWN_TICKS * 2.5) / s.level));
    if (s.type === StructureType.SamSite) return Math.min(1, s.cooldownTicks / SAM_COOLDOWN_TICKS);
    return 0;
  }

  radarCovers(owner: number, x: number, y: number): boolean {
    let found = false;
    this.g.structGrid.query(x, y, RADAR_RANGE, (s) => {
      if (s.owner === owner && s.type === StructureType.Radar && s.operational) {
        found = true;
        return true;
      }
    });
    return found;
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  step(): void {
    const g = this.g;
    const tick = g.tick;
    const diff = g.difficulty;
    // Players at war with anyone regrow at half rate (§4.6).
    const atWar = this.atWarSet;
    atWar.clear();
    for (const w of g.war.list()) {
      atWar.add(w.a);
      atWar.add(w.b);
    }
    for (const p of g.playerArr) {
      if (!p.alive || !p.spawned) continue;
      // Population (§6.7): the target follows the land and the cities; the people move 0.2 % of it per game hour.
      p.popTarget = this.popTargetOf(p);
      const drift = POP_DRIFT_PER_HOUR / TICKS_PER_GAME_HOUR * p.popTarget;
      if (p.pop < p.popTarget) p.pop = Math.min(p.popTarget, p.pop + drift);
      else if (p.pop > p.popTarget) p.pop = Math.max(p.popTarget, p.pop - drift);
      p.civilians = p.pop;
      const fPop = p.popTarget > 0 ? Math.min(1, Math.max(0.3, p.pop / p.popTarget)) : 1;
      // v2 (§4.13, §6.7): occupied tiles count 50 % for the troop cap and 25 % for taxes; fallout 20 % / 0 %.
      const occ = Math.min(p.occupied, p.tiles);
      const eff = Math.max(0, p.tiles - p.falloutTiles * 0.8 - occ * 0.5);
      const effTax = Math.max(0, p.tiles - p.falloutTiles - occ * 0.75);
      const cityLv = p.structLevels[StructureType.City];
      const armyLv = p.structLevels[StructureType.ArmyBase];
      const facLv = p.structLevels[StructureType.Factory];
      // Troops.
      const max = baseMaxTroops(eff, cityLv, armyLv) * kindCapMul(p.kind, diff) * p.mod('maxTroops', tick);
      p.maxTroops = max;
      let growth = troopGrowthPerTick(p.troops, max);
      // Recruitment (§6.7): f_pop × (1 − 0.5 × occupied / tiles).
      p.recruitment = fPop * (p.tiles > 0 ? 1 - 0.5 * (occ / p.tiles) : 1);
      if (growth > 0) {
        const falloutFrac = p.tiles > 0 ? p.falloutTiles / p.tiles : 0;
        growth *= TROOP_REGROWTH_SCALE * p.recruitment * kindGrowthMul(p.kind, diff) * p.mod('troopGrowth', tick)
          * (1 - 0.75 * falloutFrac) * (atWar.has(p.id) ? WAR_GROWTH_MUL : 1);
      }
      p.troopGrowth = growth;
      p.troops = Math.max(0, p.troops + growth);
      // Gold.
      const base = p.kind === 'tribe' ? GOLD_BASE_PER_TICK * 0.5 : GOLD_BASE_PER_TICK;
      let income = (base + GOLD_PER_TILE_PER_TICK * effTax * fPop + GOLD_PER_CITY_LEVEL_PER_TICK * cityLv
        + (facLv * BALANCE.goldPerFactoryPerSec) / 10) * kindGoldMul(p.kind, diff) * p.mod('goldIncome', tick);
      // Tribute after a lost war (§4.15): a share of the income goes to the winner.
      if (p.tributeTo && tick < p.tributeUntil) {
        const w = g.playerById[p.tributeTo];
        const due = income * p.tributeShare;
        if (w && w.alive) {
          income -= due;
          w.gold += due;
          w.stats.goldEarned += due;
          w.goldGainedThisTick += due;
        }
      } else if (p.tributeTo) p.tributeTo = 0;
      p.income = income;
      p.gold += income;
      p.stats.goldEarned += income;
      p.goldGainedThisTick += income;
      p.incomeEma = p.incomeEma === 0 ? income : p.incomeEma * 0.98 + p.goldGainedThisTick * 0.02;
      p.goldGainedThisTick = 0;
    }
    // Structures: construction, repairs, factories, ports.
    let progressDirty = false;
    for (const s of g.structureMap.values()) {
      if (s.built < 1) {
        s.built = Math.min(1, s.built + 1 / STRUCTURE_DEFS[s.type].buildTicks);
        progressDirty = true;
        if (s.built >= 1) {
          this.recount(s.owner);
          const p = g.playerById[s.owner];
          if (p) p.stats.structuresBuilt++;
          if (STATION_TYPES.has(s.type)) this.railDirty = true;
          g.structuresDirty = true;
          g.emit({ type: 'structureBuilt', tick, structureId: s.id, owner: s.owner, structure: s.type, tile: s.tile });
        }
        continue;
      }
      s.age++;
      if (s.hp < 1 && tick - s.lastDamageTick > STRUCTURE_REPAIR_DELAY) {
        s.hp = Math.min(1, s.hp + STRUCTURE_REPAIR_PER_TICK);
        if (tick % 10 === 0) g.structuresDirty = true;
      }
      if (s.hp <= 0) continue;
      if (s.type === StructureType.Factory && tick >= s.timer) this.dispatchTrain(s);
      else if (s.type === StructureType.Port) this.maybeTrade(s);
    }
    if (progressDirty && tick % 5 === 0) g.structuresDirty = true;
    if (this.railDirty && tick - this.lastRailBuild >= 60) this.rebuildRail();
    if (tick % 50 === 0) g.weapons.maintainFallout();
  }

  // =================================================================================================
  // Rail network
  // =================================================================================================
  private rebuildRail(): void {
    const g = this.g;
    this.railDirty = false;
    this.lastRailBuild = g.tick;
    const stations: Structure[] = [];
    for (const s of g.structureMap.values()) {
      if (STATION_TYPES.has(s.type) && s.built >= 1) stations.push(s);
      s.rail.length = 0;
    }
    const cand: { s: Structure; d: number }[] = [];
    for (const a of stations) {
      cand.length = 0;
      g.structGrid.query(a.x, a.y, RAIL_MAX_LINK, (b, d2) => {
        if (b === a || !STATION_TYPES.has(b.type) || b.built < 1) return;
        if (b.owner !== a.owner && !g.isAllied(a.owner, b.owner)) return;
        cand.push({ s: b, d: d2 });
      });
      cand.sort((x, y) => x.d - y.d || x.s.id - y.s.id);
      let links = a.rail.length;
      if (cand.length > 12) cand.length = 12;
      for (const c of cand) {
        if (links >= RAIL_MAX_LINKS_PER_STATION) break;
        const b = c.s;
        if (a.rail.includes(b.id)) continue;
        if (b.rail.length >= RAIL_MAX_LINKS_PER_STATION + 2) continue;
        if (!this.landLine(a.x, a.y, b.x, b.y)) continue;
        a.rail.push(b.id);
        b.rail.push(a.id);
        links++;
      }
    }
  }

  private landLine(ax: number, ay: number, bx: number, by: number): boolean {
    const g = this.g;
    const dx = wdx(ax, bx), dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.ceil(len / 0.5);
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      const x = ((Math.floor(ax + dx * f) % MAP_W) + MAP_W) % MAP_W;
      const y = Math.floor(ay + dy * f);
      const t = y * MAP_W + x;
      if (t < 0 || t >= TILE_COUNT || !g.playable[t]) return false;
    }
    return true;
  }

  private dispatchTrain(f: Structure): void {
    const g = this.g;
    const rng = g.rngEconomy;
    f.timer = g.tick + Math.round(TRAIN_INTERVAL_TICKS / f.level) + rng.int(40);
    if (f.rail.length === 0) return;
    // BFS over the rail graph (up to 10 hops) for cities & ports.
    const parent = new Map<number, number>();
    parent.set(f.id, -1);
    let frontier = [f.id];
    const dests: number[] = [];
    for (let hop = 0; hop < 10 && frontier.length; hop++) {
      const next: number[] = [];
      for (const id of frontier) {
        const s = g.structureMap.get(id);
        if (!s) continue;
        for (const nid of s.rail) {
          if (parent.has(nid)) continue;
          const n = g.structureMap.get(nid);
          if (!n || n.built < 1) continue;
          if (n.owner !== f.owner && !g.isAllied(f.owner, n.owner)) continue;
          parent.set(nid, id);
          next.push(nid);
          if (n.type === StructureType.City || n.type === StructureType.Port) dests.push(nid);
        }
      }
      frontier = next;
    }
    if (dests.length === 0) return;
    const dest = dests[rng.int(dests.length)];
    const path: number[] = [];
    for (let k = dest; k !== -1; k = parent.get(k) ?? -1) path.push(k);
    path.reverse();
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      const a = g.structureMap.get(path[i - 1])!, b = g.structureMap.get(path[i])!;
      len += Math.sqrt(dist2(a.x, a.y, b.x, b.y));
    }
    const d = g.structureMap.get(dest)!;
    const cargo = trainGold(len, d.owner !== f.owner) * (0.8 + 0.2 * f.level) * (d.type === StructureType.City ? 0.9 + 0.1 * d.level : 1);
    g.unitSys.launchTrain(f.owner, path, cargo);
  }

  // =================================================================================================
  // Maritime trade
  // =================================================================================================
  private maybeTrade(port: Structure): void {
    const g = this.g;
    const rng = g.rngEconomy;
    if (rng.next() >= TRADE_SPAWN_CHANCE_PER_LEVEL * port.level) return;
    const owner = g.playerById[port.owner];
    if (!owner || !owner.alive || owner.kind === 'tribe') return;
    let active = 0;
    for (const u of g.unitsByOwner.get(port.owner) ?? []) if (u.type === UnitType.TradeShip && u.home === port.id) active++;
    if (active >= TRADE_MAX_PER_PORT_LEVEL * port.level) return;
    if (this.ports.length < 2) return;
    g.nav.coastComponents(port.tile, this.comps);
    for (let k = 0; k < 8; k++) {
      const q = this.ports[rng.int(this.ports.length)];
      if (q === port || q.owner === port.owner || !q.operational) continue;
      const partner = g.playerById[q.owner];
      if (!partner || !partner.alive || partner.kind === 'tribe') continue;
      if (g.hasEmbargo(port.owner, q.owner) || g.hasEmbargo(q.owner, port.owner)) continue;
      if (dist2(port.x, port.y, q.x, q.y) < TRADE_MIN_DISTANCE * TRADE_MIN_DISTANCE) continue;
      g.nav.coastComponents(q.tile, this.comps2);
      if (!this.comps2.some((c) => this.comps.includes(c))) continue;
      if (g.unitSys.launchTrade(port, q)) return;
    }
  }
}

export { STRUCTURE_TYPES };
