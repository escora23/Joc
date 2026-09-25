// FRONT ULTRA — in-worker simulation API: the contract between sim-core (implements SimGame) and
// sim-ai (AI nations in src/sim/ai, world events in src/sim/events).
// Owner: shared. Worker-safe: no three.js, no DOM.
//
// Rules:
//   * Everything here runs inside the sim worker, synchronously, inside Game.tick(). Deterministic:
//     use game.rng (or rng.fork()) only — never Math.random() or Date.
//   * AI nations act ONLY through game.issue(playerId, cmd) — the same validated commands the human uses.
//   * World events may use the privileged mutation methods (transferTiles, destroyStructure, ...).
//   * Queries return live internal state or cached arrays: do not mutate returned objects/sets.
//
// Tick order inside sim-core (per tick):
//   1. apply queued human commands   2. aiDirector.tick()   3. worldEvents.tick()
//   4. attacks / expansion           5. units & projectiles 6. economy (troops, gold, trade)
//   7. alliances / timers            8. win check           9. record deltas & events

import type { PlayerCommand, SimEvent } from './protocol';
import type { Rng } from './rng';
import type {
  AttackState, Difficulty, GameConfig, GamePhase, PairState, PeaceTerms, Personality, PlayerKind, PlayerStatsCounters, StructureType,
  UnitState, UnitType, WarGoal, WorldEventKind, WorldInit,
} from './types';

export interface SimPlayer {
  readonly id: number;
  readonly name: string;
  readonly kind: PlayerKind;
  readonly personality: Personality | null;
  readonly color: number;
  readonly countryIndex: number;
  readonly alive: boolean;
  readonly spawned: boolean;
  readonly capitalTile: number;
  readonly tiles: number;
  readonly troops: number;
  readonly maxTroops: number;
  readonly gold: number;
  /** Gold per tick. */
  readonly income: number;
  readonly allies: ReadonlySet<number>;
  readonly embargoes: ReadonlySet<number>;
  readonly traitorUntilTick: number;
  readonly stats: Readonly<PlayerStatsCounters>;
  /** v2 (W1): tiles still under occupation (§4.13), population and its target (§6.7). */
  readonly occupied: number;
  readonly pop: number;
  readonly popTarget: number;
  /** Free slot for sim-ai to keep per-player memory (sim-core never touches it). */
  aiMemory: unknown;
}

export interface SimStructure {
  readonly id: number;
  readonly type: StructureType;
  readonly owner: number;
  readonly tile: number;
  readonly level: number;
  readonly hp: number;
  /** 0..1 construction progress. */
  readonly built: number;
  /** Ticks until ready again (silos, SAMs), 0 = ready. */
  readonly cooldownTicks: number;
}

export interface SimUnit {
  readonly id: number;
  readonly type: UnitType;
  readonly owner: number;
  /** Continuous tile coords. */
  readonly x: number;
  readonly y: number;
  readonly state: UnitState;
  readonly hp: number;
  readonly troops: number;
  readonly targetTile: number;
}

export interface SimAttack {
  readonly id: number;
  readonly attacker: number;
  readonly defender: number;
  readonly troops: number;
  readonly naval: boolean;
  readonly startTick: number;
  /** v2 (W1): last force ratio R = Pa / Pd (§4.4; 0 during the contact phase and on neutral land). */
  readonly ratio: number;
  /** v2 (W1): contact / advancing / stalled / consolidating / landing / retreating. */
  readonly state: AttackState;
  /** v2 (W1): the front it pushes on (0 = none). */
  readonly frontKey: number;
  /** v2 (W1): troops committed so far (launch + reinforcements). */
  readonly committed: number;
  /** v2 (W1): the axis point (continuous tile coords, -1 = none). */
  readonly clickX: number;
  readonly clickY: number;
}

export interface NewPlayerDef {
  name: string;
  kind: PlayerKind;
  personality: Personality | null;
  color: number;
  countryIndex: number;
}

/** Temporary multipliers applied by world events. 1 = neutral. */
export type ModifierKey = 'troopGrowth' | 'goldIncome' | 'attackPower' | 'defensePower' | 'maxTroops';

/** v2 (W1): one war as the AI sees it (DESIGN_V2 §4.1, §4.15). Side a declared the war. */
export interface SimWar {
  readonly id: number;
  readonly a: number;
  readonly b: number;
  readonly parentWar: number;
  readonly startTick: number;
  readonly goal: WarGoal;
  readonly reasonKey: string;
  readonly mobilizeUntilTick: number;
  readonly joined: boolean;
  /** Net tiles side a took from side b in this war. */
  readonly net: number;
  readonly tilesAtStart: readonly [number, number];
  readonly capitalLost: readonly [boolean, boolean];
  readonly escalation: readonly [number, number];
}

/** v2 (W1): the war system (src/sim/war.ts) seen from sim-ai and the world events. */
export interface SimWarApi {
  pairState(a: number, b: number): PairState;
  atWar(a: number, b: number): boolean;
  between(a: number, b: number): SimWar | undefined;
  warsOf(p: number): SimWar[];
  list(): Iterable<SimWar>;
  enemiesOf(p: number): number[];
  /** Tick until which `attacker` may not start an offensive on `target` (0 = free). */
  mobilizingUntil(attacker: number, target: number): number;
  /** War score of p against q (-100..100) and a player's exhaustion (0..100), §4.15. */
  warScore(p: number, q: number): number;
  exhaustion(p: number): number;
  escalation(p: number, q: number): number;
  /** Why `aggressor` may not declare on `target` now (i18n key) or null. */
  declareError(aggressor: number, target: number): string | null;
  /** An AI states a grievance toward the human (the tension lead of §2.4 starts here). */
  recordTension(from: number, to: number): void;
  lastTension(from: number): number;
  makePeace(a: number, b: number, terms: PeaceTerms, reasonKey?: string, loser?: number): boolean;
  raiseEscalation(p: number, q: number, level: number, reasonKey: string): boolean;
  /** Declare without the command path (world events: rebellions, §5.12). */
  declare(aggressor: number, target: number, goal: WarGoal, reasonKey: string, opts?: { force?: boolean; mobilizeTicks?: number }): unknown;
}

/** v2 (W1): a front as the AI sees it (src/sim/fronts.ts). */
export interface SimFront {
  readonly key: number;
  readonly a: number;
  readonly b: number;
  readonly x: number;
  readonly y: number;
  readonly length: number;
  readonly priority: readonly [number, number];
  readonly offensive: readonly [number, number];
}

export interface SimFrontApi {
  frontsOf(p: number): SimFront[];
  frontsOfPair(a: number, b: number): readonly SimFront[];
  garrison(f: SimFront, p: number): number;
}

export interface SimGame {
  readonly config: GameConfig;
  /** v2 (W1): wars, truces, peace (§4). */
  readonly war: SimWarApi;
  readonly fronts: SimFrontApi;
  readonly world: WorldInit;
  readonly difficulty: Difficulty;
  readonly tick: number;
  readonly phase: GamePhase;
  readonly rng: Rng;

  // --- map queries ------------------------------------------------------------------------------
  ownerOf(tile: number): number;
  isLand(tile: number): boolean;
  isWater(tile: number): boolean;
  /** Ownable land (land and not Ice). */
  isPlayable(tile: number): boolean;
  isShore(tile: number): boolean;
  /** Tiles of `playerId` that touch a tile not owned by them. Live set — do not mutate. */
  borderTiles(playerId: number): ReadonlySet<number>;
  /** Player ids sharing a land border with `playerId` (0 included when bordering unclaimed land). */
  neighborsOf(playerId: number): number[];
  sharesBorder(a: number, b: number): boolean;
  /** Distance in tiles (wrapped). */
  distance(tileA: number, tileB: number): number;

  // --- entity queries ---------------------------------------------------------------------------
  players(): readonly SimPlayer[];
  player(id: number): SimPlayer | undefined;
  structures(ownerId?: number, type?: StructureType): readonly SimStructure[];
  units(ownerId?: number, type?: UnitType): readonly SimUnit[];
  unitsNear(x: number, y: number, radiusTiles: number): SimUnit[];
  structuresNear(x: number, y: number, radiusTiles: number): SimStructure[];
  outgoingAttacks(playerId: number): readonly SimAttack[];
  incomingAttacks(playerId: number): readonly SimAttack[];
  isAllied(a: number, b: number): boolean;
  hasEmbargo(from: number, to: number): boolean;
  /** Current price for `playerId` (structure or buildable/launchable unit). */
  structureCost(playerId: number, type: StructureType): number;
  unitCost(playerId: number, type: UnitType): number;
  canBuild(playerId: number, type: StructureType, tile: number): boolean;

  // --- actions (validated exactly like human commands) -----------------------------------------------
  issue(playerId: number, cmd: PlayerCommand): boolean;
  /** Create a player (AI nation / tribe / rebel). Returns its id. Spawn it with issue(id, {type:'spawn'}). */
  addPlayer(def: NewPlayerDef): number;

  // --- privileged mutations (world events only) ---------------------------------------------------
  /** v2: `reason` tells the invariant checker why land changes hands without a war (§4.17). */
  transferTiles(tiles: Iterable<number>, newOwner: number, reason?: 'rebellion' | 'treaty' | 'cleanup'): void;
  /** v2 (W1): occupied tile (captured < 72 h ago, §4.13). */
  isOccupied(tile: number): boolean;
  destroyStructure(structureId: number, by: number): void;
  damageUnit(unitId: number, amount: number, by: number): void;
  addGold(playerId: number, amount: number): void;
  addTroops(playerId: number, amount: number): void;
  setModifier(playerId: number, key: ModifierKey, value: number, durationTicks: number): void;
  /** Register/refresh an active world event so the client can render it (id reused across calls). */
  setWorldEventState(id: number, state: {
    kind: WorldEventKind; x: number; y: number; radius: number; progress: number; magnitude: number;
    players: number[]; heading: number;
  } | null): void;
  /** 0..1, drives the late-game doomsday clock UI and AI aggression. */
  setDoomsday(level: number): void;
  emit(event: SimEvent): void;
  /** Allocate an id for a world event. */
  nextEventId(): number;
}

// --- sim-ai entry points (implemented in src/sim/ai/index.ts and src/sim/events/index.ts) -------------

export interface AiNationPlan {
  name: string;
  countryIndex: number;
  color: number;
  personality: Personality;
  /** Spawn tile (playable land inside the country). */
  tile: number;
}

export interface AiDirector {
  /** Called once at init (before the spawn phase starts): create & spawn AI nations and tribes. */
  setup(): void;
  /** Called every tick (throttle internally, spread players across ticks). */
  tick(): void;
  /** Every SimEvent emitted by the sim, synchronously (e.g. answer alliance requests). */
  onEvent(e: SimEvent): void;
  /** v2 (§12.8): the director's hidden state for a save (a graph of plain objects, Maps and registered classes). */
  snapshotState?(): unknown;
  restoreState?(state: unknown): void;
}

export interface WorldEventDirector {
  tick(): void;
  onEvent(e: SimEvent): void;
  snapshotState?(): unknown;
  restoreState?(state: unknown): void;
}

export type AiDirectorFactory = (game: SimGame) => AiDirector;
export type WorldEventDirectorFactory = (game: SimGame) => WorldEventDirector;
