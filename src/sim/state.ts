// FRONT ULTRA — simulation entities (players, structures, units, attacks). Owner: sim-core. Worker-only.
// These classes implement the read-only SimPlayer / SimStructure / SimUnit / SimAttack views of shared/simapi.ts
// and carry the extra internal state the systems need. sim-ai only ever sees the SimX interfaces.

import { MAP_W } from '../shared/constants';
import type { ModifierKey, SimAttack, SimPlayer, SimStructure, SimUnit } from '../shared/simapi';
import {
  STRUCTURE_TYPES, UNIT_TYPES, UnitState, emptyStats, type Personality, type PlayerKind, type PlayerStatsCounters,
  type StructureType, type UnitType,
} from '../shared/types';
import { TileHeap } from './heap';

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

export class Attack implements SimAttack {
  troops: number;
  readonly heap = new TileHeap(128);
  /** Approximate number of frontier tiles queued (drives the per-tick conquest budget). */
  frontierSize = 0;
  /** Stamp used in Game.frontStamp to dedupe queued tiles. */
  readonly stamp: number;
  clickX: number;
  clickY: number;
  /** Naval attack: tile where the troops landed (frontier seeded from there), -1 until landed. */
  sourceTile = -1;
  /** Naval attack in transit: transport ship unit id (0 once landed). */
  boatId = 0;
  /** Ring buffer of recently conquered tiles (fronts, enclave checks). */
  readonly recent = new Int32Array(128);
  recentN = 0;
  /** Tiles conquered this tick. */
  conqueredThisTick = 0;
  /** EMAs (per tick) of conquest rate and total casualties, for front intensity. */
  conquestEma = 0;
  lossEma = 0;
  lossThisTick = 0;
  /** Attacker troops lost so far (stats / news). */
  attackerLosses = 0;
  defenderLosses = 0;
  refreshedAtTick = -1;
  ended = false;
  lastActiveTick: number;

  constructor(
    readonly id: number,
    readonly attacker: number,
    public defender: number,
    troops: number,
    readonly naval: boolean,
    readonly startTick: number,
    clickTile: number,
  ) {
    this.troops = troops;
    this.stamp = id;
    this.clickX = clickTile >= 0 ? (clickTile % MAP_W) + 0.5 : -1;
    this.clickY = clickTile >= 0 ? Math.floor(clickTile / MAP_W) + 0.5 : -1;
    this.lastActiveTick = startTick;
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
