// FRONT ULTRA — simulation protocol (main thread <-> sim Web Worker) and the sim event vocabulary.
// Owner: shared. sim-core implements both ends (src/sim/worker.ts, src/sim/client.ts).
// Worker-safe: no three.js, no DOM.
//
// Transport rules:
//   * Main -> worker: ToWorker messages (small objects). Human commands carry playerId = HUMAN_ID.
//   * Worker -> main: one FromWorker 'update' every UPDATE_INTERVAL_MS of wall time, coalescing all ticks run
//     since the previous post (0 ticks when paused: still posted at a lower rate so the UI stays live).
//   * Every typed array in TickUpdate is freshly allocated by the worker and listed in the transfer list.
//   * Heavy/rare lists (structures, attacks, alliances, fronts...) are OPTIONAL: present only when changed.
//     The client keeps the last received value when a field is absent.

import type {
  AllianceRequestView, AllianceView, AttackView, BuildableUnit, ClockMode, ClockView, CommandKind, EmoteId, FrontView,
  GameConfig, GameOverReason, GamePhase, GameSpeed, PeaceTerms, PlayerKind, Personality, PlayerStatsCounters,
  ScarView, SiegeView, StructureType, StructureView, UnitType, WarGoal, WarView, WeaponType, WorldEventKind,
  WorldEventView, WorldInit,
} from './types';

// =================================================================================================
// Player commands (human via UI, AI via SimGame.issue). All are validated by the sim; invalid ones are
// dropped with a 'message' event to the issuing player.
// =================================================================================================

export type PlayerCommand =
  /** Place (or, during the spawn phase, move) the capital. */
  | { type: 'spawn'; tile: number }
  /** Land attack. target = player id, or 0 for unclaimed land. ratio = fraction of current troops (0..1).
   *  tile: the clicked tile (the offensive's axis point). v2: rejected with msg.notAtWar against a nation at peace. */
  | { type: 'attack'; target: number; ratio: number; tile: number }
  // --- v2 (W1): war ---
  /** Declare war (§4.2). The optional offensive is queued and starts by itself when the mobilization ends. */
  | { type: 'declareWar'; target: number; queuedAttack?: { tile: number; ratio: number }; goal?: WarGoal; reasonKey?: string }
  /** Garrison priority of the sender on one of its fronts: 0 baja, 1 normal, 2 alta (§4.4). */
  | { type: 'setFrontPriority'; frontKey: number; priority: 0 | 1 | 2 }
  /** Cancel an outgoing attack; the remaining troops come back (with a penalty). */
  | { type: 'retreat'; attackId: number }
  /** Naval invasion: a transport ship leaves the nearest own shore toward targetTile (a shore land tile). */
  | { type: 'boatAttack'; targetTile: number; ratio: number }
  | { type: 'build'; structure: StructureType; tile: number }
  | { type: 'upgrade'; structureId: number }
  | { type: 'demolish'; structureId: number }
  /** Produce a unit at the given producing structure (-1 = best available structure). */
  | { type: 'buildUnit'; unit: BuildableUnit; structureId: number }
  /** Launch a weapon from a silo (-1 = nearest ready silo) at targetTile. */
  | { type: 'launch'; weapon: WeaponType; targetTile: number; siloId: number }
  | { type: 'moveUnit'; unitId: number; tile: number }
  /** Armored division: drive to targetTile, fighting on the way (boosts the local attack). */
  | { type: 'deployArmor'; unitId: number; targetTile: number }
  /** Aircraft strike (fighters / bombers / drones) on targetTile, then return to base. */
  | { type: 'airStrike'; unitId: number; targetTile: number }
  | { type: 'allianceRequest'; target: number }
  | { type: 'allianceReply'; from: number; accept: boolean }
  | { type: 'breakAlliance'; target: number }
  | { type: 'embargo'; target: number; active: boolean }
  | { type: 'donate'; target: number; gold: number; troops: number }
  /** target 0 = everyone. */
  | { type: 'emote'; target: number; emote: EmoteId }
  /** Mark a player as the preferred target (allies & AI allies react). */
  | { type: 'targetPlayer'; target: number }
  /** Command mode: freeze/unfreeze a unit while the player drives it. */
  | { type: 'unitControl'; unitId: number; controlled: boolean }
  /** Command mode results, applied to the strategic simulation. */
  | {
      type: 'commandResult';
      unitId: number;
      kind: CommandKind;
      enemy: number;
      /** Tile where the fight happened. */
      tile: number;
      troopsKilled: number;
      unitsDestroyed: number[];
      structuresDestroyed: number[];
      unitLost: boolean;
    };

export type PlayerCommandType = PlayerCommand['type'];

// =================================================================================================
// Sim events (worker -> main, inside TickUpdate.events). The client re-emits each one on the main
// EventBus using its `type` as the event name, with the event object as payload.
// Positions are continuous tile coords (x, y) and/or tile indices.
// =================================================================================================

export type NukeWeapon = WeaponType | typeof UnitType.MirvWarhead;

export type SimEvent =
  | { type: 'phaseChanged'; tick: number; phase: GamePhase }
  | { type: 'playerSpawned'; tick: number; playerId: number; tile: number }
  | { type: 'attackStarted'; tick: number; attackId: number; attacker: number; defender: number; troops: number; tile: number; naval: boolean; frontKey?: number; x?: number; y?: number }
  | { type: 'attackEnded'; tick: number; attackId: number; attacker: number; defender: number; reason: 'exhausted' | 'retreat' | 'defenderEliminated' | 'cancelled' }
  | { type: 'boatLaunched'; tick: number; unitId: number; owner: number; fromTile: number; toTile: number; troops: number }
  | { type: 'boatLanded'; tick: number; unitId: number; owner: number; tile: number; defender: number; troops: number }
  | { type: 'nationEliminated'; tick: number; playerId: number; by: number }
  | { type: 'capitalCaptured'; tick: number; playerId: number; by: number; tile: number }
  | { type: 'allianceRequested'; tick: number; from: number; to: number }
  | { type: 'allianceFormed'; tick: number; a: number; b: number }
  | { type: 'allianceRejected'; tick: number; from: number; to: number }
  | { type: 'allianceBroken'; tick: number; breaker: number; victim: number }
  | { type: 'allianceExpired'; tick: number; a: number; b: number }
  | { type: 'embargoChanged'; tick: number; from: number; to: number; active: boolean }
  | { type: 'donation'; tick: number; from: number; to: number; gold: number; troops: number }
  | { type: 'structureBuilt'; tick: number; structureId: number; owner: number; structure: StructureType; tile: number }
  | { type: 'structureUpgraded'; tick: number; structureId: number; owner: number; structure: StructureType; level: number; tile: number }
  | { type: 'structureDestroyed'; tick: number; structureId: number; owner: number; structure: StructureType; tile: number; by: number }
  | { type: 'structureCaptured'; tick: number; structureId: number; structure: StructureType; tile: number; from: number; to: number }
  | { type: 'unitSpawned'; tick: number; unitId: number; unit: UnitType; owner: number; x: number; y: number }
  | { type: 'unitDestroyed'; tick: number; unitId: number; unit: UnitType; owner: number; by: number; x: number; y: number }
  /** A projectile/shot for visuals & audio only (warship shells, SAM shots, artillery, air-strike bombs). */
  | { type: 'combat'; tick: number; kind: 'shell' | 'sam' | 'artillery' | 'bomb' | 'strafe'; owner: number; fromX: number; fromY: number; toX: number; toY: number; hit: boolean }
  | { type: 'nukeLaunched'; tick: number; unitId: number; weapon: NukeWeapon; owner: number; fromTile: number; targetTile: number; targetOwner: number; flightTicks: number }
  | { type: 'nukeIntercepted'; tick: number; unitId: number; weapon: NukeWeapon; owner: number; by: number; x: number; y: number }
  | { type: 'nukeDetonated'; tick: number; unitId: number; weapon: NukeWeapon; owner: number; tile: number; x: number; y: number; innerRadius: number; outerRadius: number; targetOwner: number; casualties: number }
  | { type: 'worldEvent'; tick: number; id: number; kind: WorldEventKind; stage: 'warning' | 'start' | 'end'; x: number; y: number; radius: number; magnitude: number; players: number[] }
  | { type: 'doomsday'; tick: number; level: number; minutesToMidnight: number }
  | { type: 'emote'; tick: number; from: number; to: number; emote: EmoteId }
  | { type: 'tradeCompleted'; tick: number; owner: number; partner: number; gold: number; tile: number }
  | { type: 'goldBonus'; tick: number; playerId: number; gold: number; tile: number; reason: 'train' | 'trade' | 'event' | 'conquest' }
  /** Generic message for a player (usually the human): i18n key + params (e.g. 'msg.notEnoughGold'). */
  | { type: 'message'; tick: number; playerId: number; key: string; params: Record<string, string | number>; severity: 'info' | 'warning' | 'danger' }
  | { type: 'commandResultApplied'; tick: number; unitId: number; owner: number; enemy: number; troopsKilled: number; unitLost: boolean }
  | { type: 'gameOver'; tick: number; winner: number; reason: GameOverReason }
  // --- v2 (W1): war, clock, sieges, unrest, endgame ---
  | { type: 'warDeclared'; tick: number; war: number; aggressor: number; target: number; goal: WarGoal; reasonKey: string; mobilizeUntilTick: number; betrayal: boolean; parentWar: number }
  | { type: 'warEnded'; tick: number; war: number; a: number; b: number; winner: number; terms: PeaceTerms; reasonKey: string }
  | { type: 'tension'; tick: number; from: number; to: number; reasonKey: string; params: Record<string, string | number> }
  | { type: 'escalation'; tick: number; war: number; by: number; against: number; level: number; reasonKey: string }
  | { type: 'siege'; tick: number; owner: number; by: number[]; stage: 'start' | 'end'; tiles: number; x: number; y: number }
  | { type: 'offensive'; tick: number; attackId: number; attacker: number; defender: number; stage: 'started' | 'contact' | 'stalled' | 'resumed' | 'consolidating' | 'retreating' | 'ended'; x: number; y: number; ratio: number }
  | { type: 'invasionDetected'; tick: number; unitId: number; owner: number; target: number; toTile: number; etaTicks: number; troops: number; by: 'radar' | 'coast' | 'neighbour' }
  | { type: 'clockChanged'; tick: number; mode: ClockMode; rate: number }
  | { type: 'unrest'; tick: number; owner: number; region: number[]; cause: 'occupation' | 'exhaustion' | 'nuclear'; stage: 'start' | 'cancelled' | 'rebellion'; untilTick: number; x: number; y: number }
  | { type: 'hegemony'; tick: number; leader: number; stage: 'start' | 'broken' | 'won'; untilTick: number }
  | { type: 'capitulation'; tick: number; loser: number; winner: number; tiles: number; war: number };

export type SimEventType = SimEvent['type'];
/** Map from event name to event payload, for the typed EventBus. */
export type SimEventMap = { [E in SimEvent as E['type']]: E };

// =================================================================================================
// Packed per-tick data
// =================================================================================================

/** Tile index uses 21 bits (TILE_COUNT = 1,280,000 < 2^21), owner id the upper 11 bits. */
export const TILE_BITS = 21;
export const TILE_MASK = (1 << TILE_BITS) - 1;

export function packTileOwner(tile: number, owner: number): number {
  return ((owner << TILE_BITS) | tile) >>> 0;
}
export function unpackTile(packed: number): number {
  return packed & TILE_MASK;
}
export function unpackOwner(packed: number): number {
  return packed >>> TILE_BITS;
}

/** Row layout of TickUpdate.players (Float64Array, stride PLAYER_STRIDE, one row per player incl. dead). */
export const PF = {
  id: 0,
  alive: 1,
  tiles: 2,
  troops: 3,
  maxTroops: 4,
  troopGrowth: 5,
  gold: 6,
  income: 7,
  population: 8,
  attackingTroops: 9,
  labelX: 10,
  labelY: 11,
  labelSize: 12,
  traitorTicks: 13,
  spawned: 14,
  capitalTile: 15,
} as const;
export const PLAYER_STRIDE = 16;

/** Row layout of TickUpdate.units (Float32Array, stride UNIT_STRIDE, one row per live unit). */
export const UF = {
  id: 0,
  type: 1,
  owner: 2,
  x: 3,
  y: 4,
  heading: 5,
  state: 6,
  hp: 7,
  troops: 8,
  targetX: 9,
  targetY: 10,
  alt: 11,
  originX: 12,
  originY: 13,
} as const;
export const UNIT_STRIDE = 14;

/** Slow-changing player info; sent for a player on its first update and whenever any field changes. */
export interface PlayerMeta {
  id: number;
  name: string;
  kind: PlayerKind;
  personality: Personality | null;
  color: number;
  countryIndex: number;
  allies: number[];
  embargoes: number[];
}

/** v2: the extended front record (== FrontView; samples/progress are transferable). */
export type FrontRecord = FrontView;

export interface TickUpdate {
  /** Last tick included in this update. */
  tick: number;
  /** Ticks advanced since the previous update (0 while paused). */
  ticks: number;
  phase: GamePhase;
  speed: GameSpeed;
  /** Changed tiles, in order, packed with packTileOwner. Transferable. */
  owners: Uint32Array;
  /** Full owner array (resync): first update, after fast-forward, or when a delta would be larger. Transferable. */
  fullOwners?: Uint16Array;
  /** PLAYER_STRIDE rows. Transferable. */
  players: Float64Array;
  playerMeta?: PlayerMeta[];
  /** Cumulative counters, sent every ~10 ticks. */
  playerStats?: { id: number; stats: PlayerStatsCounters }[];
  /** UNIT_STRIDE rows for every live unit. Transferable. */
  units: Float32Array;
  structures?: StructureView[];
  attacks?: AttackView[];
  fronts?: FrontRecord[];
  scars?: ScarView[];
  worldEvents?: WorldEventView[];
  alliances?: AllianceView[];
  allianceRequests?: AllianceRequestView[];
  /** 0..1 */
  doomsday?: number;
  spawnDeadlineTick?: number;
  events: SimEvent[];
  winner?: number;
  /** Worker-side cost of the ticks in this update (ms), for the debug overlay. */
  tickMs?: number;
  // --- v2 (W1) ---
  /** The clock driving the world (always present). */
  clock: ClockView;
  /** Every active war (when changed). */
  wars?: WarView[];
  /** Besieged pockets (when changed). */
  sieges?: SiegeView[];
  /** Occupation delta: tile + 1 when a tile became occupied, -(tile + 1) when it stopped being occupied. */
  occupied?: Int32Array;
  /** Full occupied set (tile indices) on every resync (fullOwners). */
  occupiedFull?: Int32Array;
  /** Truces in force (when changed): pairs at truce until untilTick (§4.15). */
  truces?: { a: number; b: number; untilTick: number }[];
}

// =================================================================================================
// Messages
// =================================================================================================

/**
 * Debug / staging actions (shots, playtests, dev console). Never used by gameplay code or the AI.
 * They bypass costs and validation but keep the simulation consistent (events are emitted as usual).
 */
export type SimDebugAction =
  | { type: 'endGame'; winner: number; reason: GameOverReason }
  | { type: 'addGold'; playerId: number; amount: number }
  | { type: 'addTroops'; playerId: number; amount: number }
  /** Give `playerId` every playable tile within `radius` tiles of centerTile. */
  | { type: 'conquer'; playerId: number; centerTile: number; radius: number }
  | { type: 'spawnStructure'; structure: StructureType; owner: number; tile: number; level: number }
  /** Create a unit at tile heading to targetTile (-1 = idle). */
  | { type: 'spawnUnit'; unit: UnitType; owner: number; tile: number; targetTile: number }
  /** Launch a nuke/missile regardless of silos & gold (flight + interception rules still apply). */
  | { type: 'launchNuke'; weapon: NukeWeapon; owner: number; fromTile: number; targetTile: number }
  /** Force a world event now. */
  | { type: 'worldEvent'; kind: WorldEventKind; tile: number }
  /**
   * v2: put two players at war now (a declares on b; mobilization 0 unless given) — staging and pace-audit only.
   * peace: true ends their war with a white peace instead.
   */
  | { type: 'war'; a: number; b: number; goal?: WarGoal; mobilizeTicks?: number; peace?: boolean }
  /** v2: remove a unit silently (probes and staging clean up after themselves). */
  | { type: 'removeUnit'; unitId: number };

export type ToWorker =
  | { kind: 'init'; config: GameConfig; world: WorldInit }
  | { kind: 'debug'; action: SimDebugAction }
  | { kind: 'command'; playerId: number; cmd: PlayerCommand }
  | { kind: 'speed'; speed: GameSpeed }
  /** Run `ticks` ticks as fast as possible (shots, playtests), then post a resync update + 'fastForwardDone'. */
  | { kind: 'fastForward'; ticks: number; requestId: number }
  | { kind: 'stop' }
  // --- v2 (W1) ---
  /**
   * Main-thread clock request (§2.2, §14.6): 'observation' from the camera altitude with the camera's ground point as
   * focus; 'tactical' / 'travel' from command mode (rate = game s per real s). Crisis is decided by the worker.
   */
  | { kind: 'clock'; mode: 'strategic' | 'observation' | 'tactical' | 'travel'; rate?: number; focus?: { x: number; y: number }; throttled?: boolean }
  /** Player settings the worker needs to decide crisis and observation time; sent at start and on every change. */
  | { kind: 'settings'; crisisTime: 'always' | 'mine' | 'off'; observationTime: boolean }
  /** Serialise the game (§12.8); the worker answers with 'saved'. */
  | { kind: 'save'; requestId: number }
  /** Restore a saved game into this worker (replaces 'init'); the worker answers 'ready' + a full update, or 'error'. */
  | { kind: 'load'; blob: ArrayBuffer; world: WorldInit };

export type FromWorker =
  | { kind: 'ready' }
  | { kind: 'update'; u: TickUpdate }
  | { kind: 'fastForwardProgress'; requestId: number; done: number; total: number }
  | { kind: 'fastForwardDone'; requestId: number }
  | { kind: 'error'; message: string; stack?: string }
  | { kind: 'saved'; requestId: number; blob: ArrayBuffer; tick: number }
  | { kind: 'loadFailed'; message: string };

/** Collect the transfer list for a TickUpdate (worker side). */
export function tickUpdateTransferables(u: TickUpdate): Transferable[] {
  const list: Transferable[] = [u.owners.buffer as ArrayBuffer, u.players.buffer as ArrayBuffer, u.units.buffer as ArrayBuffer];
  if (u.fullOwners) list.push(u.fullOwners.buffer as ArrayBuffer);
  if (u.fronts) for (const f of u.fronts) {
    list.push(f.samples.buffer as ArrayBuffer);
    if (f.progress) list.push(f.progress.buffer as ArrayBuffer);
  }
  if (u.occupied) list.push(u.occupied.buffer as ArrayBuffer);
  if (u.occupiedFull) list.push(u.occupiedFull.buffer as ArrayBuffer);
  return list;
}
