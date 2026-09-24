// FRONT ULTRA — simulation core (owner: sim-core). Runs inside the sim worker.
// STUB by the architect: a small but real deterministic game — spawns, land expansion into neutral/enemy land,
// troop/gold growth, structures placement, alliances bookkeeping, phases, win check, packed tick updates.
// sim-core replaces the internals (attack fronts, boats, units, nukes, trade, rail...) keeping:
//   * class Game implements SimGame (shared/simapi.ts) — sim-ai builds against that interface only.
//   * Game.tick(), Game.handleCommand(), Game.buildUpdate() used by worker.ts.

import { BALANCE, HUMAN_ID, MAP_W, NUKE_DEFS, STRUCTURE_DEFS, TILE_COUNT, UNIT_DEFS, WIN_LAND_SHARE, structureCost } from '../shared/constants';
import { neighbors4, tileDistance, tileX, tileY, wrapDX } from '../shared/geo';
import {
  PF, PLAYER_STRIDE, UF, UNIT_STRIDE, packTileOwner, type FrontRecord, type PlayerCommand, type PlayerMeta,
  type SimDebugAction, type SimEvent, type TickUpdate,
} from '../shared/protocol';
import { Rng } from '../shared/rng';
import type {
  AiDirector, ModifierKey, NewPlayerDef, SimAttack, SimGame, SimPlayer, SimStructure, SimUnit, WorldEventDirector,
} from '../shared/simapi';
import { isPlayableTerrain, isShoreTerrain, isWaterTerrain, terrainClass } from '../shared/terrain';
import {
  TerrainClass, UnitState, emptyStats, type AttackView, type Difficulty, type GameConfig, type GamePhase, type GameSpeed,
  type PlayerStatsCounters, type StructureType, type StructureView, type UnitType, type WorldEventKind,
  type WorldEventView, type WorldInit,
} from '../shared/types';
import { createAiDirector } from './ai';
import { createWorldEventDirector } from './events';

class Player implements SimPlayer {
  alive = true;
  spawned = false;
  capitalTile = -1;
  tiles = 0;
  troops = BALANCE.startTroops;
  maxTroops = BALANCE.troopCapBase;
  gold = BALANCE.startGold;
  income = 0;
  troopGrowth = 0;
  allies = new Set<number>();
  embargoes = new Set<number>();
  traitorUntilTick = 0;
  stats: PlayerStatsCounters = emptyStats();
  aiMemory: unknown = null;
  border = new Set<number>();
  labelX = 0;
  labelY = 0;
  labelSize = 0;
  metaDirty = true;
  modifiers = new Map<ModifierKey, { value: number; until: number }>();
  constructor(
    readonly id: number,
    readonly name: string,
    readonly kind: SimPlayer['kind'],
    readonly personality: SimPlayer['personality'],
    readonly color: number,
    readonly countryIndex: number,
  ) {}
  mod(key: ModifierKey, tick: number): number {
    const m = this.modifiers.get(key);
    return m && m.until > tick ? m.value : 1;
  }
}

interface Attack extends SimAttack {
  troops: number;
  /** Last conquered tile (front representative point). */
  lastTile: number;
  recent: number[];
}

interface Unit extends SimUnit {
  x: number;
  y: number;
  owner: number;
  state: UnitState;
  hp: number;
  targetTile: number;
  heading: number;
  alt: number;
  originX: number;
  originY: number;
}

interface Structure extends SimStructure {
  level: number;
  hp: number;
  built: number;
  cooldownTicks: number;
  owner: number;
}

export class Game implements SimGame {
  readonly rng: Rng;
  readonly difficulty: Difficulty;
  tick = 0;
  phase: GamePhase = 'spawn';
  speed: GameSpeed = 1;
  readonly owner: Uint16Array;
  private playerArr: Player[] = [];
  private playerById: (Player | undefined)[] = [];
  private attacks: Attack[] = [];
  private structureMap = new Map<number, Structure>();
  private nextId = 1;
  private changed: number[] = [];
  private events: SimEvent[] = [];
  private structuresDirty = true;
  private attacksDirty = true;
  private forceFull = true;
  private ai: AiDirector;
  private worldEvents: WorldEventDirector;
  private eventStates = new Map<number, WorldEventView>();
  private eventsDirty = false;
  private doomsday = 0;
  private winner = 0;
  private spawnDeadline: number;
  private humanSpawnTick = -1;
  private nb = new Int32Array(4);
  private nb2 = new Int32Array(4);
  private pendingHuman: PlayerCommand[] = [];
  private unitMap = new Map<number, Unit>();

  constructor(readonly config: GameConfig, readonly world: WorldInit) {
    this.rng = new Rng(config.seed);
    this.difficulty = config.difficulty;
    this.owner = new Uint16Array(TILE_COUNT);
    this.spawnDeadline = config.spawnTimeoutTicks;
    this.speed = config.speed;
    this.addPlayer({ name: config.playerName, kind: 'human', personality: null, color: config.playerColor, countryIndex: 0 });
    this.ai = createAiDirector(this);
    this.worldEvents = createWorldEventDirector(this);
    this.ai.setup();
    if (config.autoSpawnTile >= 0) this.issue(HUMAN_ID, { type: 'spawn', tile: config.autoSpawnTile });
  }

  // ------------------------------------------------------------------------------------------------
  // SimGame: queries
  // ------------------------------------------------------------------------------------------------
  ownerOf(tile: number): number { return this.owner[tile]; }
  isLand(tile: number): boolean { return !isWaterTerrain(this.world.terrain[tile]); }
  isWater(tile: number): boolean { return isWaterTerrain(this.world.terrain[tile]); }
  isPlayable(tile: number): boolean { return isPlayableTerrain(this.world.terrain[tile]); }
  isShore(tile: number): boolean { return isShoreTerrain(this.world.terrain[tile]); }
  borderTiles(playerId: number): ReadonlySet<number> { return this.playerById[playerId]?.border ?? new Set(); }
  neighborsOf(playerId: number): number[] {
    const p = this.playerById[playerId];
    if (!p) return [];
    const set = new Set<number>();
    for (const t of p.border) {
      const n = neighbors4(t, this.nb);
      for (let k = 0; k < n; k++) {
        const o = this.owner[this.nb[k]];
        if (o !== playerId && this.isPlayable(this.nb[k])) set.add(o);
      }
    }
    return [...set];
  }
  sharesBorder(a: number, b: number): boolean { return this.neighborsOf(a).includes(b); }
  distance(a: number, b: number): number { return tileDistance(a, b); }
  players(): readonly SimPlayer[] { return this.playerArr; }
  player(id: number): SimPlayer | undefined { return this.playerById[id]; }
  structures(ownerId?: number, type?: StructureType): readonly SimStructure[] {
    const out: SimStructure[] = [];
    for (const s of this.structureMap.values()) {
      if ((ownerId === undefined || s.owner === ownerId) && (type === undefined || s.type === type)) out.push(s);
    }
    return out;
  }
  units(ownerId?: number, type?: UnitType): readonly SimUnit[] {
    const out: SimUnit[] = [];
    for (const u of this.unitMap.values()) {
      if ((ownerId === undefined || u.owner === ownerId) && (type === undefined || u.type === type)) out.push(u);
    }
    return out;
  }
  unitsNear(x: number, y: number, r: number): SimUnit[] {
    const out: SimUnit[] = [];
    for (const u of this.unitMap.values()) {
      const dx = wrapDX(x, u.x), dy = u.y - y;
      if (dx * dx + dy * dy <= r * r) out.push(u);
    }
    return out;
  }
  structuresNear(x: number, y: number, r: number): SimStructure[] {
    const out: SimStructure[] = [];
    for (const s of this.structureMap.values()) {
      const dx = wrapDX(x, tileX(s.tile) + 0.5), dy = tileY(s.tile) + 0.5 - y;
      if (dx * dx + dy * dy <= r * r) out.push(s);
    }
    return out;
  }
  outgoingAttacks(id: number): readonly SimAttack[] { return this.attacks.filter((a) => a.attacker === id); }
  incomingAttacks(id: number): readonly SimAttack[] { return this.attacks.filter((a) => a.defender === id); }
  isAllied(a: number, b: number): boolean { return this.playerById[a]?.allies.has(b) ?? false; }
  hasEmbargo(from: number, to: number): boolean { return this.playerById[from]?.embargoes.has(to) ?? false; }
  structureCost(playerId: number, type: StructureType): number {
    let n = 0;
    for (const s of this.structureMap.values()) if (s.owner === playerId && s.type === type) n++;
    return structureCost(type, n);
  }
  unitCost(_playerId: number, type: UnitType): number { return UNIT_DEFS[type].cost; }
  canBuild(playerId: number, type: StructureType, tile: number): boolean {
    if (this.owner[tile] !== playerId) return false;
    if (STRUCTURE_DEFS[type].coastal && !this.isShore(tile)) return false;
    for (const s of this.structureMap.values()) if (s.tile === tile) return false;
    return (this.playerById[playerId]?.gold ?? 0) >= this.structureCost(playerId, type);
  }

  // ------------------------------------------------------------------------------------------------
  // SimGame: actions
  // ------------------------------------------------------------------------------------------------
  addPlayer(def: NewPlayerDef): number {
    const id = this.playerArr.length + 1;
    const p = new Player(id, def.name, def.kind, def.personality, def.color, def.countryIndex);
    this.playerArr.push(p);
    this.playerById[id] = p;
    return id;
  }

  /** Human commands arrive from the worker message loop; they are applied at the start of the next tick. */
  queueHuman(cmd: PlayerCommand): void {
    this.pendingHuman.push(cmd);
  }

  /** Debug/staging actions are applied immediately between ticks (also while paused). */
  applyDebug(a: SimDebugAction): void {
    switch (a.type) {
      case 'endGame':
        if (!this.winner) this.end(a.winner, a.reason);
        break;
      case 'addGold':
        this.addGold(a.playerId, a.amount);
        break;
      case 'addTroops':
        this.addTroops(a.playerId, a.amount);
        break;
      case 'conquer': {
        const cx = tileX(a.centerTile), cy = tileY(a.centerTile);
        for (let dy = -a.radius; dy <= a.radius; dy++) {
          for (let dx = -a.radius; dx <= a.radius; dx++) {
            if (dx * dx + dy * dy > a.radius * a.radius) continue;
            const y = cy + dy;
            if (y < 0 || y >= this.world.height) continue;
            const t = y * MAP_W + ((cx + dx + MAP_W) % MAP_W);
            if (this.isPlayable(t)) this.setOwner(t, a.playerId);
          }
        }
        break;
      }
      case 'spawnStructure': {
        const s: Structure = { id: this.nextId++, type: a.structure, owner: a.owner, tile: a.tile, level: a.level, hp: 1, built: 1, cooldownTicks: 0 };
        this.structureMap.set(s.id, s);
        this.structuresDirty = true;
        this.emit({ type: 'structureBuilt', tick: this.tick, structureId: s.id, owner: s.owner, structure: s.type, tile: s.tile });
        break;
      }
      case 'spawnUnit': {
        const x = tileX(a.tile) + 0.5, y = tileY(a.tile) + 0.5;
        const u: Unit = {
          id: this.nextId++, type: a.unit, owner: a.owner, x, y, state: a.targetTile >= 0 ? UnitState.Moving : UnitState.Idle,
          hp: 1, troops: 0, targetTile: a.targetTile, heading: 0, alt: UNIT_DEFS[a.unit].airborne ? 0.5 : 0, originX: x, originY: y,
        };
        this.unitMap.set(u.id, u);
        this.emit({ type: 'unitSpawned', tick: this.tick, unitId: u.id, unit: u.type, owner: u.owner, x, y });
        break;
      }
      case 'launchNuke': {
        const def = NUKE_DEFS[a.weapon];
        const targetOwner = this.owner[a.targetTile];
        const unitId = this.nextId++;
        const tx = tileX(a.targetTile) + 0.5, ty = tileY(a.targetTile) + 0.5;
        this.emit({ type: 'nukeLaunched', tick: this.tick, unitId, weapon: a.weapon, owner: a.owner, fromTile: a.fromTile, targetTile: a.targetTile, targetOwner, flightTicks: 0 });
        this.emit({ type: 'nukeDetonated', tick: this.tick, unitId, weapon: a.weapon, owner: a.owner, tile: a.targetTile, x: tx, y: ty, innerRadius: def.innerRadius, outerRadius: def.outerRadius, targetOwner, casualties: 0 });
        break;
      }
      case 'worldEvent': {
        const id = this.nextEventId();
        this.emit({ type: 'worldEvent', tick: this.tick, id, kind: a.kind, stage: 'start', x: tileX(a.tile) + 0.5, y: tileY(a.tile) + 0.5, radius: 20, magnitude: 1, players: [] });
        break;
      }
    }
  }

  private stepUnits(): void {
    for (const u of this.unitMap.values()) {
      if (u.state !== UnitState.Moving || u.targetTile < 0) continue;
      const tx = tileX(u.targetTile) + 0.5, ty = tileY(u.targetTile) + 0.5;
      const dx = wrapDX(u.x, tx), dy = ty - u.y;
      const d = Math.hypot(dx, dy);
      const sp = UNIT_DEFS[u.type].speed;
      u.heading = Math.atan2(dx, -dy);
      if (d <= sp) {
        u.x = tx;
        u.y = ty;
        u.state = UnitState.Idle;
      } else {
        u.x = (u.x + (dx / d) * sp + MAP_W) % MAP_W;
        u.y += (dy / d) * sp;
      }
    }
  }

  issue(playerId: number, cmd: PlayerCommand): boolean {
    const p = this.playerById[playerId];
    if (!p || (!p.alive && cmd.type !== 'spawn')) return false;
    switch (cmd.type) {
      case 'spawn':
        return this.spawn(p, cmd.tile);
      case 'attack': {
        if (this.phase !== 'playing' || !p.spawned) return false;
        if (cmd.target !== 0 && (cmd.target === playerId || this.isAllied(playerId, cmd.target))) return false;
        const troops = Math.floor(p.troops * Math.min(1, Math.max(0, cmd.ratio)));
        if (troops < 10) return false;
        let a = this.attacks.find((x) => x.attacker === playerId && x.defender === cmd.target);
        if (a) a.troops += troops;
        else {
          a = { id: this.nextId++, attacker: playerId, defender: cmd.target, troops, naval: false, startTick: this.tick, lastTile: p.capitalTile, recent: [] };
          this.attacks.push(a);
          this.emit({ type: 'attackStarted', tick: this.tick, attackId: a.id, attacker: playerId, defender: cmd.target, troops, tile: cmd.tile, naval: false });
        }
        p.troops -= troops;
        this.attacksDirty = true;
        return true;
      }
      case 'retreat': {
        const i = this.attacks.findIndex((x) => x.id === cmd.attackId && x.attacker === playerId);
        if (i < 0) return false;
        const a = this.attacks[i];
        p.troops += a.troops * 0.75;
        this.attacks.splice(i, 1);
        this.attacksDirty = true;
        this.emit({ type: 'attackEnded', tick: this.tick, attackId: a.id, attacker: a.attacker, defender: a.defender, reason: 'retreat' });
        return true;
      }
      case 'build': {
        if (!this.canBuild(playerId, cmd.structure, cmd.tile)) {
          this.message(playerId, 'msg.cannotBuild', 'warning');
          return false;
        }
        const cost = this.structureCost(playerId, cmd.structure);
        p.gold -= cost;
        p.stats.goldSpent += cost;
        const s: Structure = { id: this.nextId++, type: cmd.structure, owner: playerId, tile: cmd.tile, level: 1, hp: 1, built: 0, cooldownTicks: 0 };
        this.structureMap.set(s.id, s);
        this.structuresDirty = true;
        return true;
      }
      case 'upgrade': {
        const s = this.structureMap.get(cmd.structureId);
        if (!s || s.owner !== playerId || s.level >= STRUCTURE_DEFS[s.type].maxLevel) return false;
        const cost = this.structureCost(playerId, s.type);
        if (p.gold < cost) return false;
        p.gold -= cost;
        s.level++;
        this.structuresDirty = true;
        this.emit({ type: 'structureUpgraded', tick: this.tick, structureId: s.id, owner: playerId, structure: s.type, level: s.level, tile: s.tile });
        return true;
      }
      case 'allianceRequest': {
        const t = this.playerById[cmd.target];
        if (!t || !t.alive || cmd.target === playerId) return false;
        this.emit({ type: 'allianceRequested', tick: this.tick, from: playerId, to: cmd.target });
        return true;
      }
      case 'allianceReply': {
        const from = this.playerById[cmd.from];
        if (!from) return false;
        if (cmd.accept) {
          from.allies.add(playerId);
          p.allies.add(cmd.from);
          from.metaDirty = p.metaDirty = true;
          this.emit({ type: 'allianceFormed', tick: this.tick, a: cmd.from, b: playerId });
        } else this.emit({ type: 'allianceRejected', tick: this.tick, from: cmd.from, to: playerId });
        return true;
      }
      case 'breakAlliance': {
        const t = this.playerById[cmd.target];
        if (!t || !p.allies.has(cmd.target)) return false;
        p.allies.delete(cmd.target);
        t.allies.delete(playerId);
        p.traitorUntilTick = this.tick + BALANCE.traitorDurationTicks;
        p.metaDirty = t.metaDirty = true;
        this.emit({ type: 'allianceBroken', tick: this.tick, breaker: playerId, victim: cmd.target });
        return true;
      }
      case 'embargo': {
        if (cmd.active) p.embargoes.add(cmd.target);
        else p.embargoes.delete(cmd.target);
        p.metaDirty = true;
        this.emit({ type: 'embargoChanged', tick: this.tick, from: playerId, to: cmd.target, active: cmd.active });
        return true;
      }
      case 'donate': {
        const t = this.playerById[cmd.target];
        if (!t) return false;
        const gold = Math.min(p.gold, Math.max(0, cmd.gold));
        const troops = Math.min(p.troops, Math.max(0, cmd.troops));
        p.gold -= gold; t.gold += gold; p.troops -= troops; t.troops += troops;
        this.emit({ type: 'donation', tick: this.tick, from: playerId, to: cmd.target, gold, troops });
        return true;
      }
      case 'emote':
        this.emit({ type: 'emote', tick: this.tick, from: playerId, to: cmd.target, emote: cmd.emote });
        return true;
      case 'launch': {
        // Stub: instant detonation so FX/UI can be exercised. sim-core implements silos, flight & SAMs.
        if (!this.config.nukes) return false;
        const def = NUKE_DEFS[cmd.weapon];
        const tx = tileX(cmd.targetTile) + 0.5, ty = tileY(cmd.targetTile) + 0.5;
        const targetOwner = this.owner[cmd.targetTile];
        const unitId = this.nextId++;
        p.stats.nukesLaunched++;
        this.emit({ type: 'nukeLaunched', tick: this.tick, unitId, weapon: cmd.weapon, owner: playerId, fromTile: p.capitalTile, targetTile: cmd.targetTile, targetOwner, flightTicks: 0 });
        this.emit({ type: 'nukeDetonated', tick: this.tick, unitId, weapon: cmd.weapon, owner: playerId, tile: cmd.targetTile, x: tx, y: ty, innerRadius: def.innerRadius, outerRadius: def.outerRadius, targetOwner, casualties: 0 });
        return true;
      }
      case 'moveUnit': {
        const u = this.unitMap.get(cmd.unitId);
        if (!u || u.owner !== playerId) return false;
        u.targetTile = cmd.tile;
        u.state = UnitState.Moving;
        return true;
      }
      case 'unitControl': {
        const u = this.unitMap.get(cmd.unitId);
        if (!u || u.owner !== playerId) return false;
        u.state = cmd.controlled ? UnitState.Controlled : UnitState.Idle;
        return true;
      }
      case 'commandResult': {
        const e = this.playerById[cmd.enemy];
        if (e) e.troops = Math.max(0, e.troops - cmd.troopsKilled);
        p.stats.commandKills += cmd.troopsKilled;
        if (cmd.unitLost) this.unitMap.delete(cmd.unitId);
        this.emit({ type: 'commandResultApplied', tick: this.tick, unitId: cmd.unitId, owner: playerId, enemy: cmd.enemy, troopsKilled: cmd.troopsKilled, unitLost: cmd.unitLost });
        return true;
      }
      default:
        // Not implemented in the stub (boats, production, air strikes...).
        return false;
    }
  }

  transferTiles(tiles: Iterable<number>, newOwner: number): void {
    for (const t of tiles) this.setOwner(t, newOwner);
  }
  destroyStructure(id: number, by: number): void {
    const s = this.structureMap.get(id);
    if (!s) return;
    this.structureMap.delete(id);
    this.structuresDirty = true;
    this.emit({ type: 'structureDestroyed', tick: this.tick, structureId: id, owner: s.owner, structure: s.type, tile: s.tile, by });
  }
  damageUnit(): void {}
  addGold(id: number, amount: number): void {
    const p = this.playerById[id];
    if (p) p.gold = Math.max(0, p.gold + amount);
  }
  addTroops(id: number, amount: number): void {
    const p = this.playerById[id];
    if (p) p.troops = Math.max(0, p.troops + amount);
  }
  setModifier(id: number, key: ModifierKey, value: number, durationTicks: number): void {
    this.playerById[id]?.modifiers.set(key, { value, until: this.tick + durationTicks });
  }
  setWorldEventState(id: number, state: Omit<WorldEventView, 'id'> | null): void {
    if (state) this.eventStates.set(id, { id, ...state });
    else this.eventStates.delete(id);
    this.eventsDirty = true;
  }
  setDoomsday(level: number): void { this.doomsday = level; }
  emit(e: SimEvent): void {
    this.events.push(e);
    this.ai.onEvent(e);
    this.worldEvents.onEvent(e);
  }
  nextEventId(): number { return this.nextId++; }

  // ------------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------------
  private message(playerId: number, key: string, severity: 'info' | 'warning' | 'danger'): void {
    this.emit({ type: 'message', tick: this.tick, playerId, key, params: {}, severity });
  }

  private spawn(p: Player, tile: number): boolean {
    if (this.phase !== 'spawn' || !this.isPlayable(tile)) return false;
    const o = this.owner[tile];
    if (o !== 0 && o !== p.id) return false;
    if (p.spawned) {
      // Re-spawn during the spawn phase: release previous land.
      for (let t = 0; t < TILE_COUNT; t++) if (this.owner[t] === p.id) this.setOwner(t, 0);
    }
    const r = BALANCE.spawnRadiusTiles;
    const cx = tileX(tile), cy = tileY(tile);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const y = cy + dy;
        if (y < 0 || y >= this.world.height) continue;
        const t = y * MAP_W + ((cx + dx + MAP_W) % MAP_W);
        if (this.isPlayable(t) && this.owner[t] === 0) this.setOwner(t, p.id);
      }
    }
    p.spawned = true;
    p.capitalTile = tile;
    p.labelX = cx + 0.5;
    p.labelY = cy + 0.5;
    if (p.id === HUMAN_ID) this.humanSpawnTick = this.tick;
    this.emit({ type: 'playerSpawned', tick: this.tick, playerId: p.id, tile });
    return true;
  }

  private setOwner(tile: number, newOwner: number): void {
    const prev = this.owner[tile];
    if (prev === newOwner) return;
    this.owner[tile] = newOwner;
    this.changed.push(packTileOwner(tile, newOwner));
    const pp = this.playerById[prev];
    if (pp) {
      pp.tiles--;
      pp.stats.tilesLost++;
      pp.border.delete(tile);
    }
    const np = this.playerById[newOwner];
    if (np) {
      np.tiles++;
      np.stats.tilesConquered++;
      if (np.tiles > np.stats.peakTiles) np.stats.peakTiles = np.tiles;
    }
    this.refreshBorder(tile);
    const n = neighbors4(tile, this.nb2);
    for (let k = 0; k < n; k++) this.refreshBorder(this.nb2[k]);
    // Structures change hands with the land.
    if (prev !== 0) {
      for (const s of this.structureMap.values()) {
        if (s.tile === tile) {
          s.owner = newOwner;
          this.structuresDirty = true;
          this.emit({ type: 'structureCaptured', tick: this.tick, structureId: s.id, structure: s.type, tile, from: prev, to: newOwner });
        }
      }
    }
  }

  private refreshBorder(tile: number): void {
    const o = this.owner[tile];
    const p = this.playerById[o];
    if (!p) return;
    const n = neighbors4(tile, this.nb);
    let border = false;
    for (let k = 0; k < n; k++) {
      const t = this.nb[k];
      if (this.owner[t] !== o && this.isPlayable(t)) {
        border = true;
        break;
      }
    }
    if (border) p.border.add(tile);
    else p.border.delete(tile);
  }

  private tileCost(tile: number, defender: number): number {
    const c = terrainClass(this.world.terrain[tile]);
    const terr = c === TerrainClass.Mountains ? BALANCE.terrainAttackCost.mountains : c === TerrainClass.Hills ? BALANCE.terrainAttackCost.hills : BALANCE.terrainAttackCost.plains;
    const d = this.playerById[defender];
    const density = d && d.tiles > 0 ? d.troops / d.tiles : 0;
    return (defender === 0 ? 6 : 10 + density * 0.8) * terr;
  }

  tick1(): void {
    if (this.phase === 'ended') return;
    this.tick++;
    for (const cmd of this.pendingHuman.splice(0)) this.issue(HUMAN_ID, cmd);
    this.ai.tick();
    if (this.phase === 'playing' && this.config.worldEvents) this.worldEvents.tick();

    if (this.phase === 'spawn') {
      const human = this.playerById[HUMAN_ID]!;
      if (!human.spawned && this.tick >= this.spawnDeadline) this.spawn(human, this.randomFreeLand());
      const startAt = this.config.instantStart ? this.humanSpawnTick : this.humanSpawnTick + 30;
      if (human.spawned && this.tick >= startAt) {
        this.phase = 'playing';
        this.emit({ type: 'phaseChanged', tick: this.tick, phase: 'playing' });
      }
      return;
    }

    this.stepAttacks();
    this.stepUnits();
    this.stepEconomy();
    if (this.tick % 10 === 0) this.updateLabels();
    this.checkWin();
  }

  private stepAttacks(): void {
    for (let i = this.attacks.length - 1; i >= 0; i--) {
      const a = this.attacks[i];
      const p = this.playerById[a.attacker]!;
      const budget = 2 + Math.floor(Math.sqrt(a.troops) / 6);
      let conquered = 0;
      for (const t of p.border) {
        if (conquered >= budget) break;
        const n = neighbors4(t, this.nb);
        for (let k = 0; k < n && conquered < budget; k++) {
          const nt = this.nb[k];
          if (this.owner[nt] !== a.defender || !this.isPlayable(nt)) continue;
          const cost = this.tileCost(nt, a.defender) * p.mod('attackPower', this.tick);
          if (a.troops < cost) break;
          a.troops -= cost;
          const d = this.playerById[a.defender];
          if (d) {
            d.troops = Math.max(0, d.troops - cost * 0.5);
            d.stats.troopsLost += cost * 0.5;
            p.stats.troopsKilled += cost * 0.5;
          }
          this.setOwner(nt, a.attacker);
          a.lastTile = nt;
          a.recent.push(nt);
          if (a.recent.length > 16) a.recent.shift();
          conquered++;
        }
      }
      if (conquered === 0 || a.troops < 5) {
        p.troops += a.troops;
        this.attacks.splice(i, 1);
        this.attacksDirty = true;
        this.emit({ type: 'attackEnded', tick: this.tick, attackId: a.id, attacker: a.attacker, defender: a.defender, reason: 'exhausted' });
      }
    }
  }

  private stepEconomy(): void {
    const dt = 1 / 10;
    for (const p of this.playerArr) {
      if (!p.alive || !p.spawned) continue;
      let cityLevels = 0;
      for (const s of this.structureMap.values()) if (s.owner === p.id && s.type === 0) cityLevels += s.level;
      p.maxTroops = (BALANCE.troopCapBase + BALANCE.troopCapPerTile * p.tiles + BALANCE.troopCapPerCityLevel * cityLevels) * p.mod('maxTroops', this.tick);
      const growth = BALANCE.troopGrowthRate * p.maxTroops * Math.max(0, 1 - p.troops / p.maxTroops) * p.mod('troopGrowth', this.tick);
      p.troopGrowth = growth;
      p.troops = Math.min(p.maxTroops, p.troops + growth * dt);
      p.income = (BALANCE.goldPerTilePerSec * p.tiles + BALANCE.goldPerCityPerSec * cityLevels) * p.mod('goldIncome', this.tick);
      p.gold += p.income * dt;
      p.stats.goldEarned += p.income * dt;
      if (p.tiles === 0 && this.tick > 50) {
        p.alive = false;
        p.metaDirty = true;
        this.emit({ type: 'nationEliminated', tick: this.tick, playerId: p.id, by: 0 });
      }
    }
    for (const s of this.structureMap.values()) {
      if (s.built < 1) {
        s.built = Math.min(1, s.built + 1 / STRUCTURE_DEFS[s.type].buildTicks);
        this.structuresDirty = true;
        if (s.built >= 1) this.emit({ type: 'structureBuilt', tick: this.tick, structureId: s.id, owner: s.owner, structure: s.type, tile: s.tile });
      }
    }
  }

  private updateLabels(): void {
    for (const p of this.playerArr) {
      if (!p.alive || p.tiles === 0) {
        p.labelSize = 0;
        continue;
      }
      // Stub: label at the capital, sized by territory.
      p.labelX = tileX(p.capitalTile) + 0.5;
      p.labelY = tileY(p.capitalTile) + 0.5;
      p.labelSize = Math.sqrt(p.tiles) * 0.9;
    }
  }

  private checkWin(): void {
    if (this.winner) return;
    const alive = this.playerArr.filter((p) => p.alive && p.spawned);
    const human = this.playerById[HUMAN_ID]!;
    for (const p of alive) {
      if (p.tiles >= this.world.landTiles * WIN_LAND_SHARE) return this.end(p.id, 'domination');
    }
    if (!human.alive) return this.end(alive[0]?.id ?? 0, 'eliminated');
    if (alive.length === 1) this.end(alive[0].id, 'lastStanding');
  }

  private end(winner: number, reason: 'domination' | 'lastStanding' | 'eliminated'): void {
    this.winner = winner;
    this.phase = 'ended';
    this.emit({ type: 'gameOver', tick: this.tick, winner, reason });
    this.emit({ type: 'phaseChanged', tick: this.tick, phase: 'ended' });
  }

  randomFreeLand(): number {
    for (let i = 0; i < 20000; i++) {
      const t = this.rng.int(TILE_COUNT);
      if (this.isPlayable(t) && this.owner[t] === 0) return t;
    }
    return 0;
  }

  // ------------------------------------------------------------------------------------------------
  // Update packing
  // ------------------------------------------------------------------------------------------------
  buildUpdate(ticks: number, forceFull = false): TickUpdate {
    const full = forceFull || this.forceFull || this.changed.length > TILE_COUNT / 8;
    this.forceFull = false;
    const owners = full ? new Uint32Array(0) : Uint32Array.from(this.changed);
    this.changed.length = 0;

    const players = new Float64Array(this.playerArr.length * PLAYER_STRIDE);
    const playerMeta: PlayerMeta[] = [];
    this.playerArr.forEach((p, i) => {
      const o = i * PLAYER_STRIDE;
      players[o + PF.id] = p.id;
      players[o + PF.alive] = p.alive ? 1 : 0;
      players[o + PF.tiles] = p.tiles;
      players[o + PF.troops] = p.troops;
      players[o + PF.maxTroops] = p.maxTroops;
      players[o + PF.troopGrowth] = p.troopGrowth;
      players[o + PF.gold] = p.gold;
      players[o + PF.income] = p.income;
      players[o + PF.population] = p.troops;
      let atk = 0;
      for (const a of this.attacks) if (a.attacker === p.id) atk += a.troops;
      players[o + PF.attackingTroops] = atk;
      players[o + PF.labelX] = p.labelX;
      players[o + PF.labelY] = p.labelY;
      players[o + PF.labelSize] = p.labelSize;
      players[o + PF.traitorTicks] = Math.max(0, p.traitorUntilTick - this.tick);
      players[o + PF.spawned] = p.spawned ? 1 : 0;
      players[o + PF.capitalTile] = p.capitalTile;
      if (p.metaDirty) {
        p.metaDirty = false;
        playerMeta.push({ id: p.id, name: p.name, kind: p.kind, personality: p.personality, color: p.color, countryIndex: p.countryIndex, allies: [...p.allies], embargoes: [...p.embargoes] });
      }
    });

    const u: TickUpdate = {
      tick: this.tick,
      ticks,
      phase: this.phase,
      speed: this.speed,
      owners,
      players,
      units: this.packUnits(),
      events: this.events.splice(0),
      doomsday: this.doomsday,
      spawnDeadlineTick: this.spawnDeadline,
    };
    if (full) u.fullOwners = this.owner.slice();
    if (playerMeta.length) u.playerMeta = playerMeta;
    if (this.tick % 10 === 0 || full) u.playerStats = this.playerArr.map((p) => ({ id: p.id, stats: { ...p.stats } }));
    if (this.structuresDirty) {
      this.structuresDirty = false;
      u.structures = [...this.structureMap.values()].map((s): StructureView => ({
        id: s.id, type: s.type, owner: s.owner, tile: s.tile, level: s.level, hp: s.hp, built: s.built, cooldown: 0,
      }));
    }
    if (this.attacksDirty || ticks > 0) {
      this.attacksDirty = false;
      u.attacks = this.attacks.map((a): AttackView => ({ id: a.id, attacker: a.attacker, defender: a.defender, troops: a.troops, naval: a.naval, startTick: a.startTick }));
      u.fronts = this.buildFronts();
    }
    if (this.eventsDirty) {
      this.eventsDirty = false;
      u.worldEvents = [...this.eventStates.values()];
    }
    if (this.winner) u.winner = this.winner;
    return u;
  }

  private packUnits(): Float32Array {
    const a = new Float32Array(this.unitMap.size * UNIT_STRIDE);
    let o = 0;
    for (const u of this.unitMap.values()) {
      a[o + UF.id] = u.id;
      a[o + UF.type] = u.type;
      a[o + UF.owner] = u.owner;
      a[o + UF.x] = u.x;
      a[o + UF.y] = u.y;
      a[o + UF.heading] = u.heading;
      a[o + UF.state] = u.state;
      a[o + UF.hp] = u.hp;
      a[o + UF.troops] = u.troops;
      a[o + UF.targetX] = u.targetTile >= 0 ? tileX(u.targetTile) + 0.5 : u.x;
      a[o + UF.targetY] = u.targetTile >= 0 ? tileY(u.targetTile) + 0.5 : u.y;
      a[o + UF.alt] = u.alt;
      a[o + UF.originX] = u.originX;
      a[o + UF.originY] = u.originY;
      o += UNIT_STRIDE;
    }
    return a;
  }

  private buildFronts(): FrontRecord[] {
    const out: FrontRecord[] = [];
    for (const a of this.attacks) {
      if (a.defender === 0 || a.recent.length === 0) continue;
      const samples = new Float32Array(a.recent.length * 2);
      a.recent.forEach((t, i) => {
        samples[i * 2] = tileX(t) + 0.5;
        samples[i * 2 + 1] = tileY(t) + 0.5;
      });
      const d = this.playerById[a.defender];
      out.push({
        id: a.id, a: a.attacker, b: a.defender, x: tileX(a.lastTile) + 0.5, y: tileY(a.lastTile) + 0.5,
        intensity: Math.min(1, a.troops / 20000), troopsA: a.troops, troopsB: d?.troops ?? 0, length: a.recent.length,
        dirX: 0, dirY: 0, samples,
      });
    }
    return out;
  }

  /** Mark that the next update must be a full resync (after fast-forward). */
  requestFull(): void {
    this.forceFull = true;
  }

  /** For world-event stubs: kinds available. */
  static readonly EVENT_KINDS: readonly WorldEventKind[] = ['earthquake', 'hurricane', 'rebellion', 'goldRush', 'pandemic', 'doomsday'];
}
