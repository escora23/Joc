// FRONT ULTRA — simulation entities (players, structures, units, attacks). Owner: sim-core. Worker-only.
// These classes implement the read-only SimPlayer / SimStructure / SimUnit / SimAttack views of shared/simapi.ts
// and carry the extra internal state the systems need. sim-ai only ever sees the SimX interfaces.

import { MAP_W } from '../shared/constants';
import type { ModifierKey, SimAttack, SimPlayer, SimStructure, SimUnit } from '../shared/simapi';
import {
  STRUCTURE_TYPES, UNIT_TYPES, UnitState, emptyStats, type AttackState, type BuildableUnit, type Personality, type PlayerKind,
  type PlayerStatsCounters, type StructureType, type UnitType,
} from '../shared/types';

export class Player implements SimPlayer {
  alive = true;
  spawned = false;
  capitalTile = -1;
  tiles = 0;
  troops = 0;
  maxTroops = 0;
  gold = 0;
  /** Base gold per tick (workers, territory, cities). */
  income = 0;
  /** Troops per tick (last computed). */
  troopGrowth = 0;
  allies = new Set<number>();
  embargoes = new Set<number>();
  traitorUntilTick = 0;
  stats: PlayerStatsCounters = emptyStats();
  aiMemory: unknown = null;

  /** Own tiles touching a playable tile owned by someone else (or unclaimed). */
  border = new Set<number>();
  /** Own tiles touching navigable water. */
  shore = new Set<number>();
  labelX = 0;
  labelY = 0;
  labelSize = 0;
  /** Label anchor quality (distance-to-border in tiles) used for hysteresis. */
  labelScore = 0;
  metaDirty = true;
  modifiers = new Map<ModifierKey, { value: number; until: number }>();

  // --- aggregates maintained by the systems -----------------------------------------------------
  structCount = new Int32Array(STRUCTURE_TYPES.length);
  /** Operational (built) levels per structure type. */
  structLevels = new Int32Array(STRUCTURE_TYPES.length);
  unitCount = new Int32Array(UNIT_TYPES.length);
  falloutTiles = 0;
  civilians = 0;
  /** Exponential moving average of all gold gained per tick (workers + trade + trains + loot). */
  incomeEma = 0;
  goldGainedThisTick = 0;
  lastTileChangeTick = 0;
  lastTileLossTick = 0;
  lastEnclaveCheckTick = 0;
  /** Player that took our last tile (elimination credit). */
  lastConqueror = 0;
  eliminatedTick = -1;
  lastCapitalEventTick = -1_000_000;
  mirvsLaunched = 0;
  boats = 0;
  attackingTroops = 0;
  donateReadyTick = 0;
  emoteReadyTick = 0;
  allianceRequestReady = new Map<number, number>();
  /** Temporary embargoes (auto-embargo after being attacked): target -> expiry tick. */
  tempEmbargo = new Map<number, number>();
  targetPlayer = 0;
  startTroops = 0;
  // --- v2 (W1) ---
  /** Tiles of this player still under occupation (captured < 72 h ago, §4.13). */
  occupied = 0;
  /** Real population (§6.7) and its target (sum of the per-tile target weights). */
  pop = 0;
  popTarget = 0;
  /** Recruitment factor of the last economy step (f_pop × occupation), for the tooltips. */
  recruitment = 1;
  /** Tribute owed: share of income paid to `tributeTo` until tick. */
  tributeTo = 0;
  tributeShare = 0;
  tributeUntil = 0;
  // --- v2 (W4) ---
  /** Units of each type queued for production (they count for the price, §6.3). */
  queued = new Int32Array(UNIT_TYPES.length);
  /** Last ordinal given per unit type («3.ª División Acorazada»). */
  serials = new Int32Array(UNIT_TYPES.length);
  /** Gold earned from maritime trade, rail freight and captured ships since the start (pace-audit economy, tooltips). */
  tradeGold = 0;

  constructor(
    readonly id: number,
    readonly name: string,
    readonly kind: PlayerKind,
    readonly personality: Personality | null,
    readonly color: number,
    readonly countryIndex: number,
  ) {}

  mod(key: ModifierKey, tick: number): number {
    const m = this.modifiers.get(key);
    return m && m.until > tick ? m.value : 1;
  }

}

/** One unit in a production queue (paid when ordered). */
export interface ProductionItem {
  unit: BuildableUnit;
  startTick: number;
  readyTick: number;
  serial: number;
  cost: number;
}

export class Structure implements SimStructure {
  hp = 1;
  built = 0;
  cooldownTicks = 0;
  level = 1;
  /** Tick of the last damage (repairs start after a delay). */
  lastDamageTick = -1_000_000;
  /** Rail links (station ids). */
  rail: number[] = [];
  /** Factory: tick when the next train leaves. SAM: missiles fired in the current salvo. */
  timer = 0;
  /** Operational ticks counter used for staggering. */
  age = 0;
  // --- v2 (W4) ---
  /** Units being produced here, in order (the first one is being built). */
  queue: ProductionItem[] = [];
  /** Upgrade in progress: the tick it started and the tick it completes (0 = none); the level rises then. */
  upgradeStart = 0;
  upgradeUntil = 0;
  /** Port: tick the next trade ship may leave (2-tick turnaround). Factory: trains are timed by `timer`. */
  nextTradeTick = 0;
  readonly x: number;
  readonly y: number;

  constructor(
    readonly id: number,
    readonly type: StructureType,
    public owner: number,
    readonly tile: number,
  ) {
    this.x = (tile % MAP_W) + 0.5;
    this.y = Math.floor(tile / MAP_W) + 0.5;
  }

  get operational(): boolean {
    return this.built >= 1 && this.hp > 0;
  }
}

/** Unit behaviour sub-modes (internal, finer than UnitState). */
export const Mode = {
  None: 0,
  Sail: 1, // following a water path
  Patrol: 2,
  Chase: 3,
  Return: 4,
  Strike: 5,
  Intercept: 6,
  Cap: 7, // fighter combat air patrol
  Deploy: 8, // armor driving to the front
  Front: 9, // armor fighting at the front
  Ballistic: 10,
  Cruise: 11,
  Rail: 12,
  Docked: 13,
  WaitPath: 14,
  Retreat: 15,
  /** v2: a transport convoy embarking troops in port before sailing (§4.11). */
  Embark: 16,
  /** v2 (W4): warship holding a blockade station, bombarding a coast, escorting a convoy. */
  Blockade: 17,
  Bombard: 18,
  Escort: 19,
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export class Unit implements SimUnit {
  x: number;
  y: number;
  state: UnitState = UnitState.Idle;
  hp: number;
  troops = 0;
  targetTile = -1;
  heading = 0;
  alt = 0;
  originX: number;
  originY: number;

  mode: Mode = Mode.None;
  /** Water/rail path waypoints (tile indices) and the index of the next waypoint. */
  path: Int32Array | null = null;
  pathI = 0;
  /** Home structure (airbase / army base / naval yard / port / silo) id, 0 = none. */
  home = 0;
  /** Target unit (chase / intercept). */
  targetUnit = 0;
  /** Target structure (trade/rail destination). */
  targetStructure = 0;
  /** Target player (trade partner, nuke target owner). */
  targetPlayer = 0;
  /** Missiles / interceptors: flight progress. */
  t = 0;
  flightTicks = 0;
  /** Tick the unit was created on (a weapon launched in a tick starts flying on the next one). */
  bornTick = 0;
  fromX = 0;
  fromY = 0;
  toX = 0;
  toY = 0;
  /** Countdown timers (weapon cooldown, fuel, patrol re-plan...). */
  cooldown = 0;
  fuel = 0;
  aux = 0;
  /** Gold carried (trade ships, trains). */
  cargo = 0;
  /** Transport ship: the naval attack it carries. */
  attackId = 0;
  /** Patrol / deploy anchor. */
  anchorTile = -1;
  /** SAM targeting: interceptors already flying at this unit. */
  engagedBy = 0;
  /** Last tick the unit took damage. */
  lastHitTick = -1000;
  /** Previous state before command-mode control. */
  savedState: UnitState = UnitState.Idle;
  dead = false;
  /** Path planning: waiting for a search slot (retries next tick) / the last search failed. */
  waitingPath = false;
  pathFailed = false;
  aux2From = 0;
  aux2To = 0;
  /** Player credited with the kill. */
  killedBy = 0;
  /** v2 (W1): transport convoy embarking until this tick (§4.11); the target already detected it. */
  embarkUntil = 0;
  detected = false;
  // --- v2 (W4): orders and purpose ---
  /** Ordinal of its type for its owner (0 = unnamed). */
  serial = 0;
  /** The order being carried out (index into UNIT_ORDER_KINDS), -1 = default behaviour. */
  order = -1;
  /** Division: the enemy of the front it is attached to (0 = none) and that front's key. */
  enemy = 0;
  frontKey = 0;
  /** Division: an own offensive runs on its sector (display: «apoyando la ofensiva»). */
  onOffensive = false;
  /** Division path legs travelled by rail (parallel to `path`: 1 = the leg ending at that waypoint is rail). */
  pathRail: Uint8Array | null = null;
  /** The planned path changed and the clients have not received it yet. */
  routeDirty = false;
  /** Ticks to arrival / readiness (published), -1 = n/a. */
  eta = -1;
  /** Aircraft: on the ground rearming until this tick. */
  readyTick = 0;
  /** Station of a patrol, CAP, blockade, bombardment or drone support (continuous tile coords). */
  stationX = 0;
  stationY = 0;
  /** Bomber / drone sortie: announced to its target (airRaid) already. */
  raidAnnounced = false;
  /** Sortie target: 1 structure, 2 division, 3 ship, 4 front sector (0 = none). */
  strikeKind = 0;
  /** Fighters that already tried to intercept this aircraft on its current pass: fighter id -> tick. */
  capTries: Map<number, number> | null = null;
  readonly maxHp: number;

  constructor(
    readonly id: number,
    readonly type: UnitType,
    public owner: number,
    x: number,
    y: number,
    maxHp: number,
  ) {
    this.x = x;
    this.y = y;
    this.originX = x;
    this.originY = y;
    this.maxHp = maxHp;
    this.hp = maxHp;
  }
}

/**
 * An offensive (DESIGN_V2 §4.3–§4.9): troops committed by one side to push one front toward an axis point. Every
 * frontier tile inside its corridor accumulates pressure each tick and falls when the pressure passes its threshold.
 */
export class Attack implements SimAttack {
  troops: number;
  /** Troops committed so far (launch + reinforcements). */
  committed: number;
  /** Axis point (the click), continuous tile coords. */
  clickX: number;
  clickY: number;
  /** Corridor origin (centroid of the contact where the axis was set) and unit direction, tile space. */
  originX = 0;
  originY = 0;
  dirX = 0;
  dirY = 1;
  /** Corridor width in tiles (clamp(committed / troops per tile, 3, 40)). */
  frontage = 3;
  /** Frontier tiles of the corridor -> accumulated pressure, and their thresholds θ. */
  readonly pressure = new Map<number, number>();
  readonly theta = new Map<number, number>();
  /** The frontier needs a full rebuild (axis moved, corridor width changed, periodic refresh). */
  frontierDirty = true;
  lastRebuildTick = -1_000_000;
  state: AttackState = 'contact';
  /** Pressure starts after the contact phase. */
  contactUntil: number;
  /** Stable key of the front it pushes on (0 = none / unclaimed land). */
  frontKey = 0;
  /** Naval attack: tile where the troops landed (-1 until landed) and the transport carrying them (0 once ashore). */
  sourceTile = -1;
  boatId = 0;
  /** Landing: storm progress of the beach tile (0..1). */
  storm = 0;
  /** Ring buffer of recently conquered tiles (fronts, sieges). */
  readonly recent = new Int32Array(128);
  recentN = 0;
  conqueredThisTick = 0;
  /** EMAs (per tick) of conquest and casualties (front intensity for the renderers). */
  conquestEma = 0;
  lossEma = 0;
  lossThisTick = 0;
  attackerLosses = 0;
  defenderLosses = 0;
  tilesTaken = 0;
  tilesLost = 0;
  /** Last force ratio and powers. */
  ratio = 0;
  pa = 0;
  pd = 0;
  /** Measured depth speed, km per game hour (EMA α = 0.1 per tick of what actually fell). */
  advanceKmh = 0;
  /** Terrain defense of the tiles taken recently (casualties), EMA. */
  terrainDefense = 1;
  /** Consecutive ticks with R < 1 (stall) and R < 0.5 (break). */
  lowTicks = 0;
  breakTicks = 0;
  stalled = false;
  /** Tiles ready to fall but held by the war's logistics bucket this tick. */
  consolidating = false;
  /** Retreat: troops are back home at this tick (-1 = not retreating). */
  returnAt = -1;
  ended = false;
  lastActiveTick: number;
  /** The id of the opposing offensive on the same front (two-sided battle), 0 = none. */
  counterId = 0;

  constructor(
    readonly id: number,
    readonly attacker: number,
    public defender: number,
    troops: number,
    readonly naval: boolean,
    public startTick: number,
    clickTile: number,
  ) {
    this.troops = troops;
    this.committed = troops;
    this.clickX = clickTile >= 0 ? (clickTile % MAP_W) + 0.5 : -1;
    this.clickY = clickTile >= 0 ? Math.floor(clickTile / MAP_W) + 0.5 : -1;
    this.lastActiveTick = startTick;
    this.contactUntil = startTick;
  }

  pushRecent(tile: number): void {
    this.recent[this.recentN % this.recent.length] = tile;
    this.recentN++;
  }
}

/** The live (non-dead) unit is still in the game maps. */
export function isAlive(u: Unit): boolean {
  return !u.dead;
}
