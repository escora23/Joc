// FRONT ULTRA — simulation core (owner: sim-core). Runs inside the sim worker, deterministic and fixed-tick.
//
// `Game` implements the SimGame contract (shared/simapi.ts) used by sim-ai, owns the world state (tile owners,
// players, structures, units, attacks, alliances, fallout, world events) and orchestrates the systems:
//   attacks.ts (frontier conquest), units.ts (ships, armor, aircraft, trains), weapons.ts (missiles, nukes, SAMs),
//   economy.ts (troops, gold, trade, rail, construction), fronts.ts, labels.ts, enclaves.ts, diplomacy.ts.
// Tick order (ARCHITECTURE §9): human commands, AI, world events, attacks, units & projectiles, economy,
// alliances & timers, win check; buildUpdate() packs deltas for the client.
//
// Everything random comes from `rng` (seeded from GameConfig.seed) or its forks. No Date / Math.random here.

import {
  BALANCE, HUMAN_ID, MAP_H, MAP_W, MAX_PLAYER_ID, STRUCTURE_DEFS, TILE_COUNT, UNIT_DEFS, WIN_LAND_SHARE, structureCost,
} from '../shared/constants';
import {
  PF, PLAYER_STRIDE, UF, UNIT_STRIDE, packTileOwner, type PlayerCommand, type PlayerMeta, type SimDebugAction,
  type SimEvent, type TickUpdate,
} from '../shared/protocol';
import { Rng } from '../shared/rng';
import type {
  AiDirector, ModifierKey, NewPlayerDef, SimAttack, SimGame, SimPlayer, SimStructure, SimUnit, WorldEventDirector,
} from '../shared/simapi';
import { isPlayableTerrain, isShoreTerrain, isWaterTerrain } from '../shared/terrain';
import {
  StructureType, UnitState, UnitType, type AttackView, type Difficulty, type GameConfig, type GameOverReason,
  type GamePhase, type GameSpeed, type ScarView, type StructureView, type WorldEventKind, type WorldEventView,
  type WorldInit,
} from '../shared/types';
import { createAiDirector } from './ai';
import { createWorldEventDirector } from './events';
import { AttackSystem } from './attacks';
import {
  AI_START_MUL, CAPITAL_LOOT, CIVILIANS_PER_TILE, ELIMINATION_LOOT, HOSTILITY_TICKS, SPAWN_COUNTDOWN_TICKS,
  START_GOLD_TRIBE, START_TROOPS_HUMAN, START_TROOPS_TRIBE, STRUCTURE_MIN_DIST2, unitPrice,
} from './balance';
import { Diplomacy } from './diplomacy';
import { EconomySystem } from './economy';
import { EnclaveSystem } from './enclaves';
import { createFallbackAi } from './fallbackAi';
import { FrontTracker } from './fronts';
import { LabelPlacer } from './labels';
import { DynamicGrid, StaticGrid, dist2 } from './spatial';
import { Attack, Player, Structure, Unit } from './state';
import { UnitSystem } from './units';
import { WaterNav } from './water';
import { WeaponSystem, type Scar } from './weapons';

/** Event types kept in intermediate fast-forward updates (the rest are visual/audio noise when skipping time). */
export const FF_EVENT_TYPES = new Set<SimEvent['type']>([
  'phaseChanged', 'playerSpawned', 'nationEliminated', 'capitalCaptured', 'allianceFormed', 'allianceBroken',
  'allianceExpired', 'embargoChanged', 'gameOver',
]);

export class Game implements SimGame {
  readonly rng: Rng;
  readonly difficulty: Difficulty;
  tick = 0;
  phase: GamePhase = 'spawn';
  speed: GameSpeed = 1;

  // --- map --------------------------------------------------------------------------------------
  readonly owner: Uint16Array;
  readonly terrain: Uint8Array;
  readonly elevation: Int16Array;
  /** 1 for ownable land. */
  readonly playable: Uint8Array;
  readonly nav: WaterNav;
  /** Tick until which a tile is radioactive (0 = clean). */
  readonly falloutUntil: Uint32Array;
  /** Structure id standing on a tile (0 = none). */
  readonly structAt: Int32Array;
  /** Frontier dedupe stamps (attack stamp that last queued the tile). */
  readonly frontStamp: Uint32Array;
  readonly landTiles: number;

  // --- players ----------------------------------------------------------------------------------
  readonly playerArr: Player[] = [];
  readonly playerById: (Player | undefined)[] = [];
  /** contact[a * cap + b] = number of 4-adjacent playable tile pairs between owners a and b (0 = unclaimed). */
  private contact: Int32Array;
  private contactCap = 256;

  // --- entities ---------------------------------------------------------------------------------
  readonly structureMap = new Map<number, Structure>();
  readonly structGrid = new StaticGrid<Structure>();
  readonly structByOwner = new Map<number, Structure[]>();
  readonly unitMap = new Map<number, Unit>();
  readonly unitsByOwner = new Map<number, Unit[]>();
  readonly unitGrid = new DynamicGrid<Unit>();
  /** Units that died since the last update (sent once with state Destroyed). */
  readonly dyingUnits: Unit[] = [];
  readonly attackList: Attack[] = [];
  readonly scars: Scar[] = [];
  readonly eventStates = new Map<number, WorldEventView>();
  /** pairKey(a, b) -> last tick they fought. */
  readonly hostility = new Map<number, number>();

  // --- systems ----------------------------------------------------------------------------------
  readonly attacks: AttackSystem;
  readonly unitSys: UnitSystem;
  readonly weapons: WeaponSystem;
  readonly economy: EconomySystem;
  readonly diplomacy: Diplomacy;
  readonly fronts: FrontTracker;
  readonly labels: LabelPlacer;
  readonly enclaves: EnclaveSystem;
  private ai: AiDirector;
  private worldEvents: WorldEventDirector;
  private aiErrors = 0;
  private eventErrors = 0;
  private usingFallbackAi = false;
  /** Reports non-fatal errors (AI exceptions) to the host (worker posts them to the main thread). */
  onError: ((message: string, stack?: string) => void) | null = null;

  // --- output -----------------------------------------------------------------------------------
  private nextId = 1;
  private changed: number[] = [];
  private changedOverflow = false;
  private events: SimEvent[] = [];
  structuresDirty = true;
  attacksDirty = true;
  scarsDirty = false;
  worldEventsDirty = false;
  alliancesDirty = true;
  private forceFull = true;
  private doomsday = 0;
  private doomsdayDirty = true;
  winner = 0;
  private spawnDeadline: number;
  private humanSpawnTick = -1;
  private pendingHuman: PlayerCommand[] = [];
  private lastFrontsTick = -1;
  /** Rng streams for the systems (forked once, in a fixed order). */
  readonly rngCombat: Rng;
  readonly rngUnits: Rng;
  readonly rngEconomy: Rng;
  private readonly nb = new Int32Array(4);
  private readonly nb2 = new Int32Array(4);

  constructor(readonly config: GameConfig, readonly world: WorldInit) {
    this.rng = new Rng(config.seed);
    this.rngCombat = this.rng.fork('sim-combat');
    this.rngUnits = this.rng.fork('sim-units');
    this.rngEconomy = this.rng.fork('sim-economy');
    this.difficulty = config.difficulty;
    this.speed = config.speed;
    this.owner = new Uint16Array(TILE_COUNT);
    this.terrain = world.terrain;
    this.elevation = world.elevation;
    this.playable = new Uint8Array(TILE_COUNT);
    let land = 0;
    for (let t = 0; t < TILE_COUNT; t++) {
      if (isPlayableTerrain(this.terrain[t])) {
        this.playable[t] = 1;
        land++;
      }
    }
    this.landTiles = world.landTiles > 0 ? world.landTiles : land;
    this.nav = new WaterNav(this.terrain);
    this.falloutUntil = new Uint32Array(TILE_COUNT);
    this.structAt = new Int32Array(TILE_COUNT);
    this.frontStamp = new Uint32Array(TILE_COUNT);
    this.contact = new Int32Array(this.contactCap * this.contactCap);
    this.spawnDeadline = config.spawnTimeoutTicks;

    this.attacks = new AttackSystem(this);
    this.unitSys = new UnitSystem(this);
    this.weapons = new WeaponSystem(this);
    this.economy = new EconomySystem(this);
    this.diplomacy = new Diplomacy(this);
    this.fronts = new FrontTracker(this);
    this.labels = new LabelPlacer(this);
    this.enclaves = new EnclaveSystem(this);

    this.addPlayer({ name: config.playerName, kind: 'human', personality: null, color: config.playerColor, countryIndex: 0 });
    // AI directors: sim-ai's, with the sim-core fallback taking over if it throws.
    this.ai = this.makeAi();
    this.worldEvents = this.makeWorldEvents();
    try {
      this.ai.setup();
    } catch (err) {
      this.reportError('AI setup failed, using the fallback AI', err);
      this.switchToFallbackAi();
      this.ai.setup();
    }
    if (config.autoSpawnTile >= 0) this.issue(HUMAN_ID, { type: 'spawn', tile: this.nearestFreeLand(config.autoSpawnTile) });
  }

  private makeAi(): AiDirector {
    if (Game.withFallbackAi) {
      this.usingFallbackAi = true;
      return createFallbackAi(this, false);
    }
    try {
      return createAiDirector(this);
    } catch (err) {
      this.reportError('createAiDirector failed, using the fallback AI', err);
      this.usingFallbackAi = true;
      return createFallbackAi(this, false);
    }
  }

  private makeWorldEvents(): WorldEventDirector {
    try {
      return createWorldEventDirector(this);
    } catch (err) {
      this.reportError('createWorldEventDirector failed; world events disabled', err);
      return { tick() {}, onEvent() {} };
    }
  }

  private switchToFallbackAi(): void {
    if (this.usingFallbackAi) return;
    this.usingFallbackAi = true;
    this.ai = createFallbackAi(this, true);
  }

  /** Tests / harness: replace the AI director by the sim-core fallback AI before setup. */
  static withFallbackAi = false;

  private reportError(msg: string, err: unknown): void {
    const e = err as Error;
    this.onError?.(`${msg}: ${e?.message ?? String(err)}`, e?.stack);
  }

  // =================================================================================================
  // SimGame: queries
  // =================================================================================================
  ownerOf(tile: number): number { return this.owner[tile]; }
  isLand(tile: number): boolean { return !isWaterTerrain(this.terrain[tile]); }
  isWater(tile: number): boolean { return isWaterTerrain(this.terrain[tile]); }
  isPlayable(tile: number): boolean { return this.playable[tile] === 1; }
  isShore(tile: number): boolean { return isShoreTerrain(this.terrain[tile]) || this.nav.coastal[tile] === 1; }
  borderTiles(playerId: number): ReadonlySet<number> { return this.playerById[playerId]?.border ?? EMPTY_SET; }

  neighborsOf(playerId: number): number[] {
    const out: number[] = [];
    if (playerId < 0 || playerId >= this.contactCap) return out;
    const row = playerId * this.contactCap;
    const n = Math.min(this.contactCap, this.playerArr.length + 1);
    for (let b = 0; b < n; b++) if (b !== playerId && this.contact[row + b] > 0) out.push(b);
    return out;
  }

  sharesBorder(a: number, b: number): boolean {
    if (a < 0 || b < 0 || a >= this.contactCap || b >= this.contactCap) return false;
    return this.contact[a * this.contactCap + b] > 0;
  }

  /** Number of adjacent tile pairs between a and b (front length). */
  contactCount(a: number, b: number): number {
    if (a < 0 || b < 0 || a >= this.contactCap || b >= this.contactCap) return 0;
    return this.contact[a * this.contactCap + b];
  }

  distance(a: number, b: number): number {
    return Math.sqrt(dist2((a % MAP_W) + 0.5, ((a / MAP_W) | 0) + 0.5, (b % MAP_W) + 0.5, ((b / MAP_W) | 0) + 0.5));
  }

  players(): readonly SimPlayer[] { return this.playerArr; }
  player(id: number): SimPlayer | undefined { return this.playerById[id]; }
  playerObj(id: number): Player | undefined { return this.playerById[id]; }

  structures(ownerId?: number, type?: StructureType): readonly SimStructure[] {
    if (ownerId !== undefined) {
      const list = this.structByOwner.get(ownerId) ?? EMPTY_STRUCTS;
      return type === undefined ? list.slice() : list.filter((s) => s.type === type);
    }
    const out: SimStructure[] = [];
    for (const s of this.structureMap.values()) if (type === undefined || s.type === type) out.push(s);
    return out;
  }

  units(ownerId?: number, type?: UnitType): readonly SimUnit[] {
    if (ownerId !== undefined) {
      const list = this.unitsByOwner.get(ownerId) ?? EMPTY_UNITS;
      return type === undefined ? list.slice() : list.filter((u) => u.type === type);
    }
    const out: SimUnit[] = [];
    for (const u of this.unitMap.values()) if (type === undefined || u.type === type) out.push(u);
    return out;
  }

  unitsNear(x: number, y: number, r: number): SimUnit[] {
    const out: SimUnit[] = [];
    this.unitGrid.query(x, y, r, (u) => {
      if (!u.dead) out.push(u);
    });
    return out;
  }

  structuresNear(x: number, y: number, r: number): SimStructure[] {
    const out: SimStructure[] = [];
    this.structGrid.query(x, y, r, (s) => {
      out.push(s);
    });
    return out;
  }

  outgoingAttacks(id: number): readonly SimAttack[] { return this.attackList.filter((a) => a.attacker === id && !a.ended); }
  incomingAttacks(id: number): readonly SimAttack[] { return this.attackList.filter((a) => a.defender === id && !a.ended); }
  isAllied(a: number, b: number): boolean { return a !== b && (this.playerById[a]?.allies.has(b) ?? false); }
  hasEmbargo(from: number, to: number): boolean {
    const p = this.playerById[from];
    if (!p) return false;
    if (p.embargoes.has(to)) return true;
    const t = p.tempEmbargo.get(to);
    return t !== undefined && t > this.tick;
  }

  structureCost(playerId: number, type: StructureType): number {
    const p = this.playerById[playerId];
    return structureCost(type, p ? p.structCount[type] : 0);
  }

  unitCost(playerId: number, type: UnitType): number {
    const p = this.playerById[playerId];
    if (!p) return UNIT_DEFS[type].cost;
    return unitPrice(type, type === UnitType.Mirv ? p.mirvsLaunched : p.unitCount[type]);
  }

  canBuild(playerId: number, type: StructureType, tile: number): boolean {
    return this.buildError(playerId, type, tile) === null;
  }

  /** Null when the structure can be built, else the i18n message key explaining why not. */
  buildError(playerId: number, type: StructureType, tile: number): string | null {
    const p = this.playerById[playerId];
    if (!p || !p.alive || !p.spawned) return 'msg.notSpawned';
    if (this.phase !== 'playing') return 'msg.notYet';
    if (!(type in STRUCTURE_DEFS)) return 'msg.cannotBuild';
    if (tile < 0 || tile >= TILE_COUNT || this.owner[tile] !== playerId || !this.playable[tile]) return 'msg.buildOwnLand';
    if (STRUCTURE_DEFS[type].coastal && !this.nav.coastal[tile]) return 'msg.buildCoastal';
    if (this.falloutUntil[tile] > this.tick) return 'msg.buildFallout';
    if (this.structAt[tile] !== 0) return 'msg.buildOccupied';
    const x = (tile % MAP_W) + 0.5, y = ((tile / MAP_W) | 0) + 0.5;
    let crowded = false;
    this.structGrid.query(x, y, Math.sqrt(STRUCTURE_MIN_DIST2) - 0.01, () => {
      crowded = true;
      return true;
    });
    if (crowded) return 'msg.buildTooClose';
    if (p.gold < this.structureCost(playerId, type)) return 'msg.notEnoughGold';
    return null;
  }

  // =================================================================================================
  // SimGame: actions
  // =================================================================================================
  addPlayer(def: NewPlayerDef): number {
    const id = this.playerArr.length + 1;
    if (id > MAX_PLAYER_ID) {
      this.onError?.('player limit reached');
      return 0;
    }
    const p = new Player(id, def.name, def.kind, def.personality, def.color, def.countryIndex);
    const weight = this.world.countries[def.countryIndex]?.weight ?? 0.4;
    switch (def.kind) {
      case 'human':
        p.troops = START_TROOPS_HUMAN;
        p.gold = BALANCE.startGold;
        break;
      case 'nation':
        p.troops = Math.round(START_TROOPS_HUMAN * AI_START_MUL[this.difficulty] * (0.85 + 0.35 * Math.min(1, weight)));
        p.gold = BALANCE.startGold;
        break;
      case 'tribe':
        p.troops = START_TROOPS_TRIBE;
        p.gold = START_GOLD_TRIBE;
        break;
      case 'rebel':
        p.troops = 0;
        p.gold = 0;
        break;
    }
    p.startTroops = p.troops;
    this.playerArr.push(p);
    this.playerById[id] = p;
    this.ensureContactCap(id + 1);
    return id;
  }

  /** Human commands arrive from the worker message loop; they are applied at the start of the next tick. */
  queueHuman(cmd: PlayerCommand): void {
    this.pendingHuman.push(cmd);
  }

  /** Apply queued human commands now (also used while paused so the player can act on a frozen world). */
  flushHumanCommands(): void {
    if (this.pendingHuman.length === 0) return;
    const list = this.pendingHuman.splice(0);
    for (const cmd of list) this.issue(HUMAN_ID, cmd);
  }

  issue(playerId: number, cmd: PlayerCommand): boolean {
    const p = this.playerById[playerId];
    if (!p || !cmd) return false;
    if (!p.alive && cmd.type !== 'emote') return false;
    try {
      return this.execute(p, cmd);
    } catch (err) {
      this.reportError(`command ${cmd.type} failed`, err);
      return false;
    }
  }

  private execute(p: Player, cmd: PlayerCommand): boolean {
    switch (cmd.type) {
      case 'spawn':
        return this.spawn(p, cmd.tile);
      case 'attack':
        return this.attacks.command(p, cmd.target, cmd.ratio, cmd.tile);
      case 'retreat':
        return this.attacks.retreat(p, cmd.attackId);
      case 'boatAttack':
        return this.unitSys.boatAttack(p, cmd.targetTile, cmd.ratio);
      case 'build':
        return this.economy.build(p, cmd.structure, cmd.tile);
      case 'upgrade':
        return this.economy.upgrade(p, cmd.structureId);
      case 'demolish':
        return this.economy.demolish(p, cmd.structureId);
      case 'buildUnit':
        return this.unitSys.buildUnit(p, cmd.unit, cmd.structureId);
      case 'launch':
        return this.weapons.launchCommand(p, cmd.weapon, cmd.targetTile, cmd.siloId);
      case 'moveUnit':
        return this.unitSys.moveUnit(p, cmd.unitId, cmd.tile);
      case 'deployArmor':
        return this.unitSys.deployArmor(p, cmd.unitId, cmd.targetTile);
      case 'airStrike':
        return this.unitSys.airStrike(p, cmd.unitId, cmd.targetTile);
      case 'allianceRequest':
        return this.diplomacy.request(p, cmd.target);
      case 'allianceReply':
        return this.diplomacy.reply(p, cmd.from, cmd.accept);
      case 'breakAlliance':
        return this.diplomacy.breakAlliance(p, cmd.target);
      case 'embargo':
        return this.diplomacy.embargo(p, cmd.target, cmd.active);
      case 'donate':
        return this.diplomacy.donate(p, cmd.target, cmd.gold, cmd.troops);
      case 'emote':
        return this.diplomacy.emote(p, cmd.target, cmd.emote);
      case 'targetPlayer':
        return this.diplomacy.targetPlayer(p, cmd.target);
      case 'unitControl':
        return this.unitSys.control(p, cmd.unitId, cmd.controlled);
      case 'commandResult':
        return this.applyCommandResult(p, cmd);
    }
    return false;
  }

  transferTiles(tiles: Iterable<number>, newOwner: number): void {
    const np = this.playerById[newOwner];
    for (const t of tiles) {
      if (t < 0 || t >= TILE_COUNT || !this.playable[t]) continue;
      this.setOwner(t, newOwner);
    }
    if (np && !np.spawned && np.tiles > 0) {
      np.spawned = true;
      if (np.capitalTile < 0) {
        const first = np.border.values().next().value;
        np.capitalTile = first ?? -1;
      }
      np.metaDirty = true;
      this.labels.placeSmall(np);
    }
  }

  destroyStructure(structureId: number, by: number): void {
    const s = this.structureMap.get(structureId);
    if (s) this.economy.destroyStructure(s, by);
  }

  damageUnit(unitId: number, amount: number, by: number): void {
    const u = this.unitMap.get(unitId);
    if (u) this.unitSys.damage(u, amount, by);
  }

  addGold(id: number, amount: number): void {
    const p = this.playerById[id];
    if (!p || !Number.isFinite(amount)) return;
    p.gold = Math.max(0, p.gold + amount);
    if (amount > 0) {
      p.stats.goldEarned += amount;
      p.goldGainedThisTick += amount;
    }
  }

  addTroops(id: number, amount: number): void {
    const p = this.playerById[id];
    if (!p || !Number.isFinite(amount)) return;
    const before = p.troops;
    p.troops = Math.max(0, p.troops + amount);
    if (amount < 0) p.stats.troopsLost += before - p.troops;
  }

  setModifier(id: number, key: ModifierKey, value: number, durationTicks: number): void {
    this.playerById[id]?.modifiers.set(key, { value, until: this.tick + durationTicks });
  }

  setWorldEventState(id: number, state: Omit<WorldEventView, 'id'> | null): void {
    if (state) this.eventStates.set(id, { id, ...state, players: state.players.slice() });
    else this.eventStates.delete(id);
    this.worldEventsDirty = true;
  }

  setDoomsday(level: number): void {
    const v = Math.max(0, Math.min(1, level));
    if (v !== this.doomsday) {
      this.doomsday = v;
      this.doomsdayDirty = true;
    }
  }

  get doomsdayLevel(): number {
    return this.doomsday;
  }

  emit(e: SimEvent): void {
    this.events.push(e);
    try {
      this.ai.onEvent(e);
    } catch (err) {
      this.aiFault(err);
    }
    try {
      this.worldEvents.onEvent(e);
    } catch (err) {
      this.worldEventFault(err);
    }
  }

  nextEventId(): number { return this.nextId++; }
  allocId(): number { return this.nextId++; }

  // =================================================================================================
  // Messages, hostility
  // =================================================================================================
  message(playerId: number, key: string, severity: 'info' | 'warning' | 'danger' = 'warning', params: Record<string, string | number> = {}): void {
    // Only the human reads messages; AI failures stay silent (they just retry).
    if (playerId !== HUMAN_ID) return;
    this.emit({ type: 'message', tick: this.tick, playerId, key, params, severity });
  }

  pairKey(a: number, b: number): number {
    return a < b ? a * 4096 + b : b * 4096 + a;
  }

  markHostile(a: number, b: number): void {
    if (a <= 0 || b <= 0 || a === b) return;
    this.hostility.set(this.pairKey(a, b), this.tick);
  }

  /** Two players are "at war": they fought recently, embargo each other, or one targets the other. */
  isHostile(a: number, b: number): boolean {
    if (a === b || a <= 0 || b <= 0) return false;
    if (this.isAllied(a, b)) return false;
    const last = this.hostility.get(this.pairKey(a, b));
    if (last !== undefined && this.tick - last < HOSTILITY_TICKS) return true;
    const pa = this.playerById[a], pb = this.playerById[b];
    if (pa?.targetPlayer === b || pb?.targetPlayer === a) return true;
    return pa?.embargoes.has(b) === true || pb?.embargoes.has(a) === true;
  }

  // =================================================================================================
  // Tile ownership (hot path)
  // =================================================================================================
  private ensureContactCap(n: number): void {
    if (n <= this.contactCap) return;
    let cap = this.contactCap;
    while (cap < n) cap *= 2;
    const next = new Int32Array(cap * cap);
    const old = this.contact, oc = this.contactCap;
    for (let a = 0; a < oc; a++) next.set(old.subarray(a * oc, a * oc + oc), a * cap);
    this.contact = next;
    this.contactCap = cap;
  }

  /**
   * Change a tile's owner, keeping every derived structure in sync: tile counts, border & shore sets, the contact
   * matrix, structure capture, fallout counts, capital loss and the delta stream.
   */
  setOwner(tile: number, newOwner: number): void {
    const owner = this.owner;
    const prev = owner[tile];
    if (prev === newOwner) return;
    owner[tile] = newOwner;
    if (!this.changedOverflow) {
      this.changed.push(packTileOwner(tile, newOwner));
      if (this.changed.length > TILE_COUNT / 8) {
        this.changedOverflow = true;
        this.changed.length = 0;
      }
    }
    const pp = this.playerById[prev];
    const np = this.playerById[newOwner];
    const fallout = this.falloutUntil[tile] > this.tick;
    const coastal = this.nav.coastal[tile] === 1;
    if (pp) {
      pp.tiles--;
      pp.stats.tilesLost++;
      pp.lastTileChangeTick = this.tick;
      pp.lastTileLossTick = this.tick;
      if (newOwner !== 0) pp.lastConqueror = newOwner;
      pp.border.delete(tile);
      if (coastal) pp.shore.delete(tile);
      if (fallout) pp.falloutTiles--;
      pp.civilians = Math.max(0, pp.civilians - CIVILIANS_PER_TILE * 0.5);
    }
    if (np) {
      np.tiles++;
      np.stats.tilesConquered++;
      np.lastTileChangeTick = this.tick;
      if (np.tiles > np.stats.peakTiles) np.stats.peakTiles = np.tiles;
      if (coastal) np.shore.add(tile);
      if (fallout) np.falloutTiles++;
    }
    // Contact matrix and borders.
    const cap = this.contactCap, contact = this.contact, playable = this.playable;
    const nb = this.nb2;
    const n = neighbors4(tile, nb);
    for (let k = 0; k < n; k++) {
      const t = nb[k];
      if (!playable[t]) continue;
      const c = owner[t];
      if (c !== prev) {
        contact[prev * cap + c]--;
        contact[c * cap + prev]--;
      }
      if (c !== newOwner) {
        contact[newOwner * cap + c]++;
        contact[c * cap + newOwner]++;
      }
    }
    this.refreshBorder(tile);
    for (let k = 0; k < n; k++) this.refreshBorder(nb[k]);
    // Structure standing on the tile changes hands (or is razed).
    const sid = this.structAt[tile];
    if (sid !== 0) this.economy.onTileCaptured(sid, prev, newOwner);
    // Capital lost?
    if (pp && pp.capitalTile === tile) this.onCapitalLost(pp, newOwner, tile);
  }

  private refreshBorder(tile: number): void {
    const o = this.owner[tile];
    if (o === 0) return;
    const p = this.playerById[o];
    if (!p) return;
    const nb = this.nb;
    const n = neighbors4(tile, nb);
    let border = false;
    for (let k = 0; k < n; k++) {
      const t = nb[k];
      if (this.owner[t] !== o && this.playable[t]) {
        border = true;
        break;
      }
    }
    if (border) p.border.add(tile);
    else p.border.delete(tile);
  }

  private onCapitalLost(p: Player, by: number, tile: number): void {
    const captor = this.playerById[by];
    if (captor && p.tiles > 0 && this.phase === 'playing') {
      const loot = p.gold * CAPITAL_LOOT;
      p.gold -= loot;
      this.addGold(by, loot);
      this.emit({ type: 'goldBonus', tick: this.tick, playerId: by, gold: Math.round(loot), tile, reason: 'conquest' });
      const lost = p.troops * 0.1;
      p.troops -= lost;
      p.stats.troopsLost += lost;
    }
    if (by !== 0 && this.phase === 'playing') this.emit({ type: 'capitalCaptured', tick: this.tick, playerId: p.id, by, tile });
    // Move the capital to the biggest remaining city, else the label anchor.
    let best: Structure | null = null;
    for (const s of this.structByOwner.get(p.id) ?? EMPTY_STRUCTS) {
      if (s.type === StructureType.City && s.tile !== tile && (!best || s.level > best.level)) best = s;
    }
    p.capitalTile = best ? best.tile : -1;
    if (p.capitalTile < 0 && p.tiles > 0) {
      const lt = Math.floor(p.labelY) * MAP_W + Math.floor(p.labelX);
      if (lt >= 0 && lt < TILE_COUNT && this.owner[lt] === p.id) p.capitalTile = lt;
      else p.capitalTile = p.border.values().next().value ?? -1;
    }
    p.metaDirty = true;
    if (p.id === HUMAN_ID && by !== 0 && this.phase === 'playing') this.message(p.id, 'msg.capitalLost', 'danger');
  }

  // =================================================================================================
  // Spawning
  // =================================================================================================
  private spawn(p: Player, tile: number): boolean {
    if (this.phase !== 'spawn') return false;
    if (tile < 0 || tile >= TILE_COUNT || !this.playable[tile]) {
      this.message(p.id, 'msg.spawnInvalid');
      return false;
    }
    const o = this.owner[tile];
    if (o !== 0 && o !== p.id) {
      this.message(p.id, 'msg.spawnTaken');
      return false;
    }
    const r = BALANCE.spawnRadiusTiles;
    if (p.spawned && p.capitalTile >= 0) {
      // Moving the capital during the spawn phase: release the previous disc.
      const old = p.capitalTile;
      p.capitalTile = -1;
      this.forDisc(old, r + 1, (t) => {
        if (this.owner[t] === p.id) this.setOwner(t, 0);
      });
    }
    this.forDisc(tile, r, (t) => {
      if (this.playable[t] && this.owner[t] === 0) this.setOwner(t, p.id);
    });
    p.spawned = true;
    p.capitalTile = tile;
    p.labelX = (tile % MAP_W) + 0.5;
    p.labelY = ((tile / MAP_W) | 0) + 0.5;
    p.labelSize = 2;
    p.civilians = p.tiles * CIVILIANS_PER_TILE;
    p.metaDirty = true;
    if (p.id === HUMAN_ID) {
      this.humanSpawnTick = this.tick;
      if (!this.config.instantStart) this.spawnDeadline = Math.min(this.spawnDeadline, this.tick + SPAWN_COUNTDOWN_TICKS);
    }
    this.emit({ type: 'playerSpawned', tick: this.tick, playerId: p.id, tile });
    return true;
  }

  /** Calls fn for every tile within radius (tile units) of a center tile (x wraps, y clamps). */
  forDisc(center: number, radius: number, fn: (t: number, d2: number) => void): void {
    const cx = center % MAP_W, cy = (center / MAP_W) | 0;
    const r = Math.ceil(radius), r2 = radius * radius;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= MAP_H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        fn(y * MAP_W + ((cx + dx + MAP_W) % MAP_W), d2);
      }
    }
  }

  nearestFreeLand(tile: number): number {
    if (tile >= 0 && tile < TILE_COUNT && this.playable[tile] && this.owner[tile] === 0) return tile;
    const cx = tile % MAP_W, cy = (tile / MAP_W) | 0;
    for (let r = 1; r < 120; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= MAP_H) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const t = y * MAP_W + ((cx + dx + MAP_W) % MAP_W);
          if (this.playable[t] && this.owner[t] === 0) return t;
        }
      }
    }
    return this.randomFreeLand();
  }

  randomFreeLand(): number {
    for (let i = 0; i < 50_000; i++) {
      const t = this.rngEconomy.int(TILE_COUNT);
      const lat = 90 - ((((t / MAP_W) | 0) + 0.5) / MAP_H) * 180;
      if (this.playable[t] && this.owner[t] === 0 && lat < 62 && lat > -45) return t;
    }
    for (let t = 0; t < TILE_COUNT; t++) if (this.playable[t] && this.owner[t] === 0) return t;
    return 0;
  }

  // =================================================================================================
  // Command mode results
  // =================================================================================================
  private applyCommandResult(p: Player, cmd: Extract<PlayerCommand, { type: 'commandResult' }>): boolean {
    const enemy = this.playerById[cmd.enemy];
    let killed = 0;
    if (enemy && enemy.alive && cmd.troopsKilled > 0) {
      killed = Math.min(enemy.troops, Math.max(0, cmd.troopsKilled));
      enemy.troops -= killed;
      enemy.stats.troopsLost += killed;
      p.stats.troopsKilled += killed;
      p.stats.commandKills += killed;
      this.markHostile(p.id, enemy.id);
    }
    for (const uid of cmd.unitsDestroyed ?? []) {
      const u = this.unitMap.get(uid);
      if (u && u.owner !== p.id && !this.isAllied(p.id, u.owner)) this.unitSys.kill(u, p.id);
    }
    for (const sid of cmd.structuresDestroyed ?? []) {
      const s = this.structureMap.get(sid);
      if (s && s.owner !== p.id && !this.isAllied(p.id, s.owner)) this.economy.destroyStructure(s, p.id);
    }
    const unit = this.unitMap.get(cmd.unitId);
    if (unit && unit.owner === p.id) {
      if (cmd.unitLost) this.unitSys.kill(unit, cmd.enemy);
      else this.unitSys.control(p, unit.id, false);
    }
    this.emit({ type: 'commandResultApplied', tick: this.tick, unitId: cmd.unitId, owner: p.id, enemy: cmd.enemy, troopsKilled: Math.round(killed), unitLost: cmd.unitLost });
    return true;
  }

  // =================================================================================================
  // Debug / staging (shots, playtests)
  // =================================================================================================
  applyDebug(a: SimDebugAction): void {
    switch (a.type) {
      case 'endGame':
        if (!this.winner) this.end(a.winner, a.reason);
        break;
      case 'addGold':
        this.addGold(a.playerId, a.amount);
        break;
      case 'addTroops': {
        const p = this.playerById[a.playerId];
        if (p) p.troops = Math.max(0, p.troops + a.amount);
        break;
      }
      case 'conquer': {
        const p = this.playerById[a.playerId];
        if (!p) break;
        this.forDisc(a.centerTile, a.radius, (t) => {
          if (this.playable[t]) this.setOwner(t, a.playerId);
        });
        if (!p.spawned && p.tiles > 0) {
          p.spawned = true;
          p.capitalTile = this.playable[a.centerTile] ? a.centerTile : (p.border.values().next().value ?? -1);
          p.metaDirty = true;
        }
        p.civilians = Math.max(p.civilians, p.tiles * CIVILIANS_PER_TILE * 0.8);
        this.labels.placeSmall(p);
        break;
      }
      case 'spawnStructure':
        this.economy.spawnStructure(a.structure, a.owner, a.tile, a.level);
        break;
      case 'spawnUnit':
        this.unitSys.debugSpawn(a.unit, a.owner, a.tile, a.targetTile);
        break;
      case 'launchNuke':
        this.weapons.launch(a.owner, a.weapon, a.fromTile, a.targetTile, 0);
        break;
      case 'worldEvent': {
        const forced = (this.worldEvents as WorldEventDirector & { force?: (kind: WorldEventKind, tile: number) => void }).force;
        if (forced) {
          try {
            forced.call(this.worldEvents, a.kind, a.tile);
          } catch (err) {
            this.worldEventFault(err);
          }
        } else {
          const id = this.nextEventId();
          const x = (a.tile % MAP_W) + 0.5, y = ((a.tile / MAP_W) | 0) + 0.5;
          this.emit({ type: 'worldEvent', tick: this.tick, id, kind: a.kind, stage: 'start', x, y, radius: 20, magnitude: 1, players: [] });
          this.setWorldEventState(id, { kind: a.kind, x, y, radius: 20, progress: 0, magnitude: 1, players: [], heading: 0 });
        }
        break;
      }
    }
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  tick1(): void {
    if (this.phase === 'ended') return;
    this.tick++;
    this.nav.beginTick();
    // 1. human commands
    this.flushHumanCommands();
    // 2. AI
    try {
      this.ai.tick();
    } catch (err) {
      this.aiFault(err);
    }
    // 3. world events
    if (this.phase === 'playing' && this.config.worldEvents) {
      try {
        this.worldEvents.tick();
      } catch (err) {
        this.worldEventFault(err);
      }
    }
    if (this.phase === 'spawn') {
      this.stepSpawnPhase();
      return;
    }
    if (this.phase !== 'playing') return;
    // 4. attacks & expansion (+ encirclements)
    this.attacks.step();
    this.enclaves.step();
    // 5. units & projectiles
    this.unitSys.step();
    this.weapons.step();
    // 6. economy
    this.economy.step();
    // 7. alliances & timers
    this.diplomacy.step();
    // periodic derived data
    if (this.tick % 10 === 0) this.labels.update();
    if (this.tick - this.lastFrontsTick >= 5) {
      this.lastFrontsTick = this.tick;
      this.fronts.update();
    }
    // 8. eliminations & win check
    this.checkEliminations();
    this.checkWin();
  }

  private aiFault(err: unknown): void {
    this.aiErrors++;
    if (this.aiErrors <= 5) this.reportError(`AI error #${this.aiErrors}`, err);
    if (this.aiErrors >= 5 && !this.usingFallbackAi) {
      this.reportError('Too many AI errors: switching to the sim-core fallback AI', err);
      this.switchToFallbackAi();
    }
  }

  private worldEventFault(err: unknown): void {
    this.eventErrors++;
    if (this.eventErrors <= 5) this.reportError(`world event error #${this.eventErrors}`, err);
    if (this.eventErrors >= 20) this.worldEvents = { tick() {}, onEvent() {} };
  }

  private stepSpawnPhase(): void {
    const human = this.playerById[HUMAN_ID]!;
    if (!human.spawned && this.tick >= this.spawnDeadline) {
      this.spawn(human, this.randomFreeLand());
    }
    let start = false;
    if (human.spawned) {
      if (this.config.instantStart) start = this.tick > this.humanSpawnTick;
      else start = this.tick >= this.spawnDeadline;
    }
    if (start) {
      // Anyone the AI failed to place gets a random spot so every nation plays.
      for (const p of this.playerArr) {
        if (!p.spawned && p.kind !== 'rebel') this.spawn(p, this.randomFreeLand());
      }
      this.phase = 'playing';
      for (const p of this.playerArr) p.civilians = p.tiles * CIVILIANS_PER_TILE;
      this.economy.refreshAll();
      this.labels.update();
      this.emit({ type: 'phaseChanged', tick: this.tick, phase: 'playing' });
    }
  }

  private checkEliminations(): void {
    for (const p of this.playerArr) {
      if (!p.alive || !p.spawned || p.tiles > 0) continue;
      if (p.boats > 0 && p.kind !== 'rebel') continue; // an invasion fleet at sea keeps a nation alive
      this.eliminate(p);
    }
  }

  eliminate(p: Player): void {
    if (!p.alive) return;
    p.alive = false;
    p.eliminatedTick = this.tick;
    p.metaDirty = true;
    p.labelSize = 0;
    const by = p.lastConqueror;
    const killer = this.playerById[by];
    if (killer && killer.alive) {
      killer.stats.nationsEliminated++;
      const loot = p.gold * ELIMINATION_LOOT;
      if (loot > 0) {
        this.addGold(by, loot);
        this.emit({ type: 'goldBonus', tick: this.tick, playerId: by, gold: Math.round(loot), tile: p.capitalTile >= 0 ? p.capitalTile : 0, reason: 'conquest' });
      }
    }
    p.gold = 0;
    p.troops = 0;
    this.attacks.cancelAllOf(p.id);
    this.unitSys.removeAllOf(p.id, by);
    this.diplomacy.dropPlayer(p.id);
    this.emit({ type: 'nationEliminated', tick: this.tick, playerId: p.id, by });
  }

  private checkWin(): void {
    if (this.winner || this.phase !== 'playing') return;
    const need = this.landTiles * WIN_LAND_SHARE;
    let aliveMajor = 0;
    let lastMajor: Player | null = null;
    let top: Player | null = null;
    for (const p of this.playerArr) {
      if (!p.alive || !p.spawned) continue;
      if (p.tiles >= need) return this.end(p.id, 'domination');
      if (p.kind === 'human' || p.kind === 'nation') {
        aliveMajor++;
        lastMajor = p;
      }
      if (!top || p.tiles > top.tiles) top = p;
    }
    const human = this.playerById[HUMAN_ID]!;
    if (!human.alive) {
      let best: Player | null = null;
      for (const p of this.playerArr) if (p.alive && p.kind === 'nation' && (!best || p.tiles > best.tiles)) best = p;
      return this.end(best?.id ?? top?.id ?? 0, 'eliminated');
    }
    if (aliveMajor === 1 && lastMajor && this.playerArr.some((p) => p.kind === 'nation')) this.end(lastMajor.id, 'lastStanding');
  }

  end(winner: number, reason: GameOverReason): void {
    if (this.phase === 'ended') return;
    this.winner = winner;
    this.phase = 'ended';
    this.emit({ type: 'gameOver', tick: this.tick, winner, reason });
    this.emit({ type: 'phaseChanged', tick: this.tick, phase: 'ended' });
  }

  // =================================================================================================
  // Update packing
  // =================================================================================================
  requestFull(): void {
    this.forceFull = true;
  }

  get spawnDeadlineTick(): number {
    return this.spawnDeadline;
  }

  get pendingEventCount(): number {
    return this.events.length;
  }

  /** Keep only the queued events matching `keep` (fast-forward drops visual noise between chunks). */
  filterEvents(keep: (e: SimEvent) => boolean): void {
    let j = 0;
    for (let i = 0; i < this.events.length; i++) if (keep(this.events[i])) this.events[j++] = this.events[i];
    this.events.length = j;
  }

  buildUpdate(ticks: number, forceFull = false): TickUpdate {
    const full = forceFull || this.forceFull || this.changedOverflow;
    this.forceFull = false;
    this.changedOverflow = false;
    const owners = full ? new Uint32Array(0) : Uint32Array.from(this.changed);
    this.changed.length = 0;

    const players = new Float64Array(this.playerArr.length * PLAYER_STRIDE);
    const playerMeta: PlayerMeta[] = [];
    for (let i = 0; i < this.playerArr.length; i++) {
      const p = this.playerArr[i];
      const o = i * PLAYER_STRIDE;
      players[o + PF.id] = p.id;
      players[o + PF.alive] = p.alive ? 1 : 0;
      players[o + PF.tiles] = p.tiles;
      players[o + PF.troops] = Math.floor(p.troops);
      players[o + PF.maxTroops] = Math.floor(p.maxTroops);
      players[o + PF.troopGrowth] = p.troopGrowth * 10;
      players[o + PF.gold] = Math.floor(p.gold);
      players[o + PF.income] = p.incomeEma * 10;
      players[o + PF.population] = Math.floor(p.civilians + p.troops + p.attackingTroops);
      players[o + PF.attackingTroops] = Math.floor(p.attackingTroops);
      players[o + PF.labelX] = p.labelX;
      players[o + PF.labelY] = p.labelY;
      players[o + PF.labelSize] = p.alive ? p.labelSize : 0;
      players[o + PF.traitorTicks] = Math.max(0, p.traitorUntilTick - this.tick);
      players[o + PF.spawned] = p.spawned ? 1 : 0;
      players[o + PF.capitalTile] = p.capitalTile;
      if (p.metaDirty || full) {
        p.metaDirty = false;
        playerMeta.push({
          id: p.id, name: p.name, kind: p.kind, personality: p.personality, color: p.color, countryIndex: p.countryIndex,
          allies: [...p.allies], embargoes: this.embargoList(p),
        });
      }
    }

    const u: TickUpdate = {
      tick: this.tick,
      ticks,
      phase: this.phase,
      speed: this.speed,
      owners,
      players,
      units: this.packUnits(),
      events: this.events.splice(0),
    };
    if (full) u.fullOwners = this.owner.slice();
    if (playerMeta.length) u.playerMeta = playerMeta;
    if (this.tick % 10 === 0 || full || ticks >= 10) {
      u.playerStats = this.playerArr.map((p) => ({ id: p.id, stats: { ...p.stats } }));
    }
    if (this.structuresDirty || full) {
      this.structuresDirty = false;
      u.structures = this.packStructures();
    }
    if (this.attacksDirty || full || ticks > 0) {
      this.attacksDirty = false;
      const list: AttackView[] = [];
      for (const a of this.attackList) {
        if (!a.ended) list.push({ id: a.id, attacker: a.attacker, defender: a.defender, troops: Math.floor(a.troops), naval: a.naval, startTick: a.startTick });
      }
      u.attacks = list;
    }
    if (this.fronts.dirty || full) u.fronts = this.fronts.take();
    if (this.scarsDirty || full || (this.scars.length > 0 && this.tick % 20 === 0)) {
      this.scarsDirty = false;
      u.scars = this.scars.map((s): ScarView => ({
        id: s.id, x: s.x, y: s.y, radius: s.radius, weapon: s.weapon, tick: s.tick,
        strength: Math.max(0, Math.min(1, (s.until - this.tick) / Math.max(1, s.until - s.tick))),
      }));
    }
    if (this.worldEventsDirty || full) {
      this.worldEventsDirty = false;
      u.worldEvents = [...this.eventStates.values()].map((e) => ({ ...e, players: e.players.slice() }));
    }
    if (this.alliancesDirty || full) {
      this.alliancesDirty = false;
      u.alliances = this.diplomacy.allianceViews();
      u.allianceRequests = this.diplomacy.requestViews();
    }
    if (this.doomsdayDirty || full) {
      this.doomsdayDirty = false;
      u.doomsday = this.doomsday;
    }
    if (this.phase === 'spawn' || full) u.spawnDeadlineTick = this.spawnDeadline;
    if (this.winner) u.winner = this.winner;
    return u;
  }

  private embargoList(p: Player): number[] {
    const out = [...p.embargoes];
    for (const [t, until] of p.tempEmbargo) if (until > this.tick && !p.embargoes.has(t)) out.push(t);
    return out;
  }

  private packStructures(): StructureView[] {
    const out: StructureView[] = [];
    for (const s of this.structureMap.values()) {
      out.push({
        id: s.id, type: s.type, owner: s.owner, tile: s.tile, level: s.level, hp: Math.max(0, Math.min(1, s.hp)),
        built: Math.min(1, s.built), cooldown: this.economy.cooldownFraction(s),
      });
    }
    return out;
  }

  private packUnits(): Float32Array {
    const n = this.unitMap.size + this.dyingUnits.length;
    const a = new Float32Array(n * UNIT_STRIDE);
    let o = 0;
    const put = (u: Unit, state: number) => {
      a[o + UF.id] = u.id;
      a[o + UF.type] = u.type;
      a[o + UF.owner] = u.owner;
      a[o + UF.x] = u.x;
      a[o + UF.y] = u.y;
      a[o + UF.heading] = u.heading;
      a[o + UF.state] = state;
      a[o + UF.hp] = u.maxHp > 0 ? Math.max(0, Math.min(1, u.hp / u.maxHp)) : 1;
      a[o + UF.troops] = u.troops;
      a[o + UF.targetX] = u.toX;
      a[o + UF.targetY] = u.toY;
      a[o + UF.alt] = u.alt;
      a[o + UF.originX] = u.originX;
      a[o + UF.originY] = u.originY;
      o += UNIT_STRIDE;
    };
    for (const u of this.unitMap.values()) put(u, u.state);
    for (const u of this.dyingUnits) put(u, UnitState.Destroyed);
    this.dyingUnits.length = 0;
    return a;
  }
}

const EMPTY_SET: ReadonlySet<number> = new Set<number>();
const EMPTY_STRUCTS: Structure[] = [];
const EMPTY_UNITS: Unit[] = [];

/** 4-neighbourhood with horizontal wrap (local copy for the hot path). */
export function neighbors4(tile: number, out: Int32Array): number {
  const x = tile % MAP_W;
  let n = 0;
  out[n++] = x === 0 ? tile + MAP_W - 1 : tile - 1;
  out[n++] = x === MAP_W - 1 ? tile - MAP_W + 1 : tile + 1;
  if (tile >= MAP_W) out[n++] = tile - MAP_W;
  if (tile < TILE_COUNT - MAP_W) out[n++] = tile + MAP_W;
  return n;
}
