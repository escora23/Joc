// FRONT ULTRA — simulation entities (players, structures, units, attacks). Owner: sim-core. Worker-only.
// These classes implement the read-only SimPlayer / SimStructure / SimUnit / SimAttack views of shared/simapi.ts
// and carry the extra internal state the systems need. sim-ai only ever sees the SimX interfaces.

import { MAP_W } from '../shared/constants';
import { functionFactor } from '../shared/damage';
import { wdx, wrapXf } from './spatial';
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
  /**
   * Operational levels per structure type, each weighted by its damage function (Feedback 3: a damaged city at level 4
   * works as 4 × 0.6 = 2.4 levels for income, troop cap and population).
   */
  structLevels = new Float64Array(STRUCTURE_TYPES.length);
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
  /** Tick of the last damage (a repair pauses REPAIR_PAUSE_TICKS after it). */
  lastDamageTick = -1_000_000;
  /** Feedback 3: player who hit it last (0 = none) and the damage state the owner's aggregates were counted at. */
  lastHitBy = 0;
  countedState = 0;
  /** Feedback 3: a paid repair is under way (+REPAIR_PER_TICK hp per tick until 1). */
  repairing = false;
  /** Feedback 3: city blocks command mode reported destroyed (bitmask of CITY_BLOCKS). */
  blocks = 0;
  /** Feedback 3: players whose divisions are ordered to raze it when they take its tile (instead of capturing it). */
  razeBy: number[] = [];
  /** Rail links (station ids). */
  rail: number[] = [];
  /** Factory: tick when the next train leaves. */
  timer = 0;
  /** SAM: interceptors fired in the current salvo (the reload starts when it reaches the level's salvo). */
  salvoFired = 0;
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

  /** Share of its effects it delivers now (Feedback 3 damage states: 1 / 0.6 / 0.25 / 0; 0 while being built). */
  get fn(): number {
    return this.built >= 1 ? functionFactor(this.hp) : 0;
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
  /**
   * Feedback 3 (#28): the mission's target: the offensive joined ('join', an attack id) or the structure to take or
   * raze ('assault' / 'raze'); the tick it started and the damage its artillery dealt (after-action report).
   */
  missionTarget = 0;
  missionStart = 0;
  missionDealt = 0;
  /** Division path legs travelled by rail (parallel to `path`: 1 = the leg ending at that waypoint is rail). */
  pathRail: Uint8Array | null = null;
  /** The planned path changed and the clients have not received it yet. */
  routeDirty = false;
  /** Ticks to arrival / readiness (published), -1 = n/a. */
  eta = -1;
  /** Aircraft: on the ground rearming until this tick. */
  readyTick = 0;
  /** Aircraft released from command mode: holding over the spot until this tick (fuel), then home; 0 = not holding. */
  holdUntil = 0;
  /** Patrol / drone support: fuel on station runs out at this tick (0 = not on station yet). */
  stationUntil = 0;
  /** Patrol / drone support gone home to refuel: the order and tile it resumes once rearmed (-1 = none). */
  resumeOrder = -1;
  resumeTile = -1;
  /** Station of a patrol, CAP, blockade, bombardment or drone support (continuous tile coords). */
  stationX = 0;
  stationY = 0;
  /** Bomber / drone sortie: announced to its target (airRaid) already. */
  raidAnnounced = false;
  /** Sortie target: 1 structure, 2 division, 3 ship, 4 front sector (0 = none). */
  strikeKind = 0;
  /** Fighters that already tried to intercept this aircraft on its current pass: fighter id -> tick. */
  capTries: Map<number, number> | null = null;
  // --- Owner item 30: naval warfare (sim/naval.ts) ---
  /** Warship: the blockade it holds (0 = none). */
  blockadeId = 0;
  /** Merchant: seized, sailing to its captor's port with its cargo (the captor owns it now). */
  prize = false;
  /** Merchant / convoy: the blockade it is steering around (0 = on its direct route) and the blockade that stopped it. */
  detourBy = 0;
  stoppedBy = 0;
  /** Merchant: km of the direct trip it is paid for, km of the route it sails, and its port's rate per ship (gold/h). */
  directKm = 0;
  routeKm = 0;
  slotRate = 0;
  /** Zone set (NavalSystem.version) this ship last checked its route against. */
  navalVer = 0;
  /** Hove to (hailed / warning shot) until this tick. */
  hoveUntil = 0;
  /** The blockade that let this escorted ship pass (0 = none). */
  passedBy = 0;
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
  /** Pressure added over the corridor this tick (Σ of the per-tile increments, in tiles): the sub-tile push (W6 momentum). */
  pushThisTick = 0;
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
  /** v2 (W6, #23): 0 hold the line, 1 sustained, 2 all-out assault. */
  intensity: 0 | 1 | 2 = 1;
  /** v2 (#25): who owns the sky over the corridor (1 attacker, -1 defender, 0 contested / nobody) and the drone swarms
   * whose close air support counts for each side this tick. */
  air: -1 | 0 | 1 = 0;
  casAtk = 0;
  casDef = 0;
  /** Feedback 3: attached divisions of each side, warships bombarding, and the model's plains speed v this tick. */
  divAtk = 0;
  divDef = 0;
  /**
   * Feedback 3 fix 2 (#28): the share of the tiles under pressure that an attacking division stands near (its ×1.5
   * push), smoothed over the last hours. Joined divisions follow the spearhead, so they cover the same stretch: the
   * previews read this instead of assuming each new division covers a new stretch.
   */
  armorCover = 0;
  navalAtk = 0;
  planKmh = 0;
  /** Tiles ready to fall but held by the war's logistics bucket this tick. */
  consolidating = false;
  /** Retreat: troops are back home at this tick (-1 = not retreating). */
  returnAt = -1;
  ended = false;
  lastActiveTick: number;
  /** The id of the opposing offensive on the same front (two-sided battle), 0 = none. */
  counterId = 0;
  /**
   * The live contact (W6): where the axis ray meets the frontier this tick, continuous tile coords on the ray (-1 = none
   * yet), and its depth along the axis from the origin (tiles). The front key, the axis point that moves ahead of the
   * advance, the measured line and the arrow all follow it, not the origin the offensive started from.
   */
  liveX = -1;
  liveY = -1;
  liveAlong = 0;

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

  /**
   * Recompute the live contact: the mean depth along the axis of the frontier tiles near the ray (within a fifth of the
   * corridor, at least 4 tiles; all frontier tiles when none is near), half a tile back from their centres (the line),
   * placed on the ray. False when the offensive has no frontier.
   */
  updateContact(): boolean {
    if (this.pressure.size === 0 || !(this.originX >= 0)) return false;
    const core = Math.max(4, this.frontage * 0.2);
    let s = 0, n = 0, sAll = 0, nAll = 0;
    for (const t of this.pressure.keys()) {
      const rx = wdx(this.originX, (t % MAP_W) + 0.5), ry = ((t / MAP_W) | 0) + 0.5 - this.originY;
      const along = rx * this.dirX + ry * this.dirY;
      sAll += along;
      nAll++;
      if (Math.abs(rx * this.dirY - ry * this.dirX) <= core) {
        s += along;
        n++;
      }
    }
    const d = (n ? s / n : sAll / nAll) - 0.5;
    this.liveAlong = d;
    this.liveX = wrapXf(this.originX + this.dirX * d);
    this.liveY = this.originY + this.dirY * d;
    return true;
  }
}

