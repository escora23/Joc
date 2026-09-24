// FRONT ULTRA — shared core types.
// Owner: shared (architect). Changes must stay backward compatible (add, never rename/remove).
// This file must stay free of runtime dependencies (no three.js, no DOM): it is imported by the sim worker.

// ---------------------------------------------------------------------------------------------
// Basic geometry
// ---------------------------------------------------------------------------------------------

/** Degrees. lat in [-90, 90], lon in [-180, 180). */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Structural 3-vector; THREE.Vector3 satisfies it, so geo helpers can write into Vector3s without importing three. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Continuous tile-space position. Tile (x, y) covers [x, x+1) x [y, y+1); its center is (x+0.5, y+0.5). */
export interface TileXY {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------------------------
// Terrain (one byte per tile: low 4 bits = TerrainClass, high bits = TerrainFlag)
// ---------------------------------------------------------------------------------------------

export const TerrainClass = {
  Ocean: 0,
  Lake: 1,
  Plains: 2,
  Hills: 3,
  Mountains: 4,
  /** Antarctica & permanent ice below ICE_LATITUDE: not ownable, not traversable. */
  Ice: 5,
} as const;
export type TerrainClass = (typeof TerrainClass)[keyof typeof TerrainClass];

export const TerrainFlag = {
  /** Land tile touching water, or water tile touching land (4-neighbourhood). */
  Shore: 0x10,
  /** Water tile connected to the world ocean (boats can sail). Lakes do not have it. */
  Navigable: 0x20,
  /** Land tile containing a river in the NASA mask (kept as land for gameplay; render may use it). */
  River: 0x40,
} as const;

export const TERRAIN_CLASS_MASK = 0x0f;

// ---------------------------------------------------------------------------------------------
// World data (produced by src/data, consumed by everyone; transferred to the sim worker)
// ---------------------------------------------------------------------------------------------

export interface CountryDef {
  /** Index into WorldData.countries; 0 is the "no country" placeholder. */
  index: number;
  /** ISO 3166-1 numeric code as a string ("724"), "" when unknown. */
  isoNumeric: string;
  /** ISO 3166-1 alpha-3 ("ESP"), "" when unknown. */
  iso3: string;
  nameEn: string;
  nameEs: string;
  /** Capital (or best spawn point) in degrees. */
  capital: LatLon;
  /** Number of playable land tiles rasterised to this country. */
  tiles: number;
  /** Relative geopolitical weight 0..1 (population/GDP blend) used by AI selection & starting bonuses. */
  weight: number;
}

/** Elevation field at a resolution >= the tile grid, in meters above sea level (negative = below). */
export interface HeightField {
  width: number;
  height: number;
  /** Row-major, y = 0 at lat +90, x = 0 at lon -180 (same convention as the tile grid). */
  data: Int16Array;
}

export interface WorldData {
  width: number; // MAP_W
  height: number; // MAP_H
  /** Per tile: TerrainClass | TerrainFlag bits. */
  terrain: Uint8Array;
  /** Per tile elevation in meters (mean over the tile). */
  elevation: Int16Array;
  /** Per tile CountryDef index (0 = none / water / ice). */
  country: Uint16Array;
  countries: CountryDef[];
  /** Number of ownable land tiles (excludes Ice & water). Used for the 80% win condition. */
  landTiles: number;
  /** High-resolution relief for rendering & local terrain (main thread only; NOT sent to the worker). */
  relief: HeightField;
}

/** The subset of WorldData sent to the sim worker (structured-cloned once at game start). */
export type WorldInit = Omit<WorldData, 'relief'>;

// ---------------------------------------------------------------------------------------------
// Game setup
// ---------------------------------------------------------------------------------------------

export type Difficulty = 'easy' | 'normal' | 'hard' | 'insane';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'insane'];

/** 0 = paused. The sim runs `speed` ticks per 100 ms of wall time. */
export type GameSpeed = 0 | 1 | 2 | 4;
export const GAME_SPEEDS: readonly GameSpeed[] = [0, 1, 2, 4];

export type Personality = 'conqueror' | 'turtle' | 'trader' | 'nuker' | 'opportunist';
export const PERSONALITIES: readonly Personality[] = ['conqueror', 'turtle', 'trader', 'nuker', 'opportunist'];

export type PlayerKind = 'human' | 'nation' | 'tribe' | 'rebel';

export type GamePhase = 'none' | 'spawn' | 'playing' | 'ended';

export interface GameConfig {
  seed: number;
  playerName: string;
  /** 0xRRGGBB */
  playerColor: number;
  difficulty: Difficulty;
  /** AI nations (placed at real countries). 4..64 */
  aiCount: number;
  /** Small bot tribes filling empty land. 0..120 */
  tribeCount: number;
  /** Initial speed after the spawn phase. */
  speed: GameSpeed;
  nukes: boolean;
  worldEvents: boolean;
  /** Game-world clock offset in seconds for the sun position (see geo.sunDirection). */
  startWorldTimeSec: number;
  /** Ticks the spawn phase lasts at most; the human is auto-placed when it expires. */
  spawnTimeoutTicks: number;
  /** Scripted games: the human spawns here immediately (tile index), -1 = choose by clicking. */
  autoSpawnTile: number;
  /** Scripted games: end the spawn phase as soon as everyone is placed (no countdown). */
  instantStart: boolean;
  /** Shots/playtests: the AI director also plays the human nation (build, expand, attack). */
  humanAutopilot: boolean;
}

// ---------------------------------------------------------------------------------------------
// Structures & units
// ---------------------------------------------------------------------------------------------

export const StructureType = {
  City: 0,
  Port: 1,
  Factory: 2,
  DefensePost: 3,
  SamSite: 4,
  MissileSilo: 5,
  Airbase: 6,
  ArmyBase: 7,
  NavalYard: 8,
  Radar: 9,
} as const;
export type StructureType = (typeof StructureType)[keyof typeof StructureType];
export const STRUCTURE_TYPES: readonly StructureType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export const UnitType = {
  TransportShip: 0,
  TradeShip: 1,
  Warship: 2,
  ArmoredDivision: 3,
  FighterSquadron: 4,
  Bomber: 5,
  DroneSwarm: 6,
  CruiseMissile: 7,
  AtomBomb: 8,
  HydrogenBomb: 9,
  Mirv: 10,
  MirvWarhead: 11,
  SamInterceptor: 12,
  Train: 13,
  /** Naval / artillery shell: short-lived projectile, rendered as tracer. */
  Shell: 14,
} as const;
export type UnitType = (typeof UnitType)[keyof typeof UnitType];
export const UNIT_TYPES: readonly UnitType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export const UnitState = {
  Idle: 0,
  Moving: 1,
  Attacking: 2,
  Returning: 3,
  /** Missile on the pad / aircraft taking off. */
  Launching: 4,
  /** Missile in ballistic flight. */
  InFlight: 5,
  /** Final frame before removal (renderers may play a death effect). */
  Destroyed: 6,
  /** Driven by the player in command mode; the sim does not move it. */
  Controlled: 7,
  Docked: 8,
} as const;
export type UnitState = (typeof UnitState)[keyof typeof UnitState];

/** Units the player can order to be built (from a structure). */
export type BuildableUnit =
  | typeof UnitType.Warship
  | typeof UnitType.ArmoredDivision
  | typeof UnitType.FighterSquadron
  | typeof UnitType.Bomber
  | typeof UnitType.DroneSwarm;

/** Things launched from a Missile Silo (or MIRV warheads, spawned by the sim). */
export type WeaponType =
  | typeof UnitType.AtomBomb
  | typeof UnitType.HydrogenBomb
  | typeof UnitType.Mirv
  | typeof UnitType.CruiseMissile;

/** Units the player can take control of in command mode. */
export type CommandKind = 'tank' | 'jet' | 'ship';

export type WorldEventKind = 'earthquake' | 'hurricane' | 'rebellion' | 'goldRush' | 'pandemic' | 'doomsday';

export const EMOTES = [
  'wave', 'thumbsUp', 'thumbsDown', 'laugh', 'angry', 'skull', 'heart', 'handshake',
  'fire', 'nuke', 'clown', 'crown', 'peace', 'target', 'shock', 'cry',
] as const;
export type EmoteId = (typeof EMOTES)[number];

export type GameOverReason = 'domination' | 'lastStanding' | 'eliminated';

/** Per-player cumulative counters (end screen, leaderboard). */
export interface PlayerStatsCounters {
  tilesConquered: number;
  tilesLost: number;
  peakTiles: number;
  troopsKilled: number;
  troopsLost: number;
  goldEarned: number;
  goldSpent: number;
  structuresBuilt: number;
  structuresDestroyed: number;
  unitsBuilt: number;
  unitsDestroyed: number;
  nukesLaunched: number;
  nukesIntercepted: number;
  nationsEliminated: number;
  /** Troops killed by the player personally in command mode. */
  commandKills: number;
}

export function emptyStats(): PlayerStatsCounters {
  return {
    tilesConquered: 0, tilesLost: 0, peakTiles: 0, troopsKilled: 0, troopsLost: 0, goldEarned: 0, goldSpent: 0,
    structuresBuilt: 0, structuresDestroyed: 0, unitsBuilt: 0, unitsDestroyed: 0, nukesLaunched: 0,
    nukesIntercepted: 0, nationsEliminated: 0, commandKills: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Main-thread views of the simulation (built by src/sim/client.ts from worker updates).
// Renderers & UI read these; they are updated in place once per applied update (never mid-frame).
// ---------------------------------------------------------------------------------------------

export interface PlayerView {
  id: number;
  /** Display name as chosen (human) or the English country name (nations). Use i18n.playerName() to localise. */
  name: string;
  kind: PlayerKind;
  personality: Personality | null;
  /** 0xRRGGBB */
  color: number;
  /** Home country (WorldData.countries index), 0 for human/tribes. */
  countryIndex: number;
  alive: boolean;
  spawned: boolean;
  capitalTile: number;
  tiles: number;
  troops: number;
  maxTroops: number;
  /** Troops per second at 1x. */
  troopGrowth: number;
  gold: number;
  /** Gold per second at 1x. */
  income: number;
  population: number;
  /** Troops currently committed to outgoing attacks. */
  attackingTroops: number;
  allies: number[];
  /** Players this player currently embargoes. */
  embargoes: number[];
  /** > 0 while flagged as traitor (ticks remaining). */
  traitorTicks: number;
  /** Nation label placement in continuous tile coords; labelSize in tiles (0 = hide). */
  labelX: number;
  labelY: number;
  labelSize: number;
  stats: PlayerStatsCounters;
}

export interface UnitView {
  id: number;
  type: UnitType;
  owner: number;
  /** Continuous tile coords at the latest update, and at the previous one (lerp with FrameInfo.simAlpha). */
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** Radians, 0 = north (-y), PI/2 = east (+x). */
  heading: number;
  prevHeading: number;
  /** 0..1 fraction of the unit's max flight altitude (missiles/aircraft), 0 for surface units. */
  alt: number;
  prevAlt: number;
  state: UnitState;
  /** 0..1 */
  hp: number;
  troops: number;
  targetX: number;
  targetY: number;
  /** Launch position (missiles), otherwise spawn position. */
  originX: number;
  originY: number;
  /** Tick the unit was first seen by the client. */
  bornTick: number;
}

export interface StructureView {
  id: number;
  type: StructureType;
  owner: number;
  tile: number;
  level: number;
  /** 0..1 */
  hp: number;
  /** 0..1 construction progress (1 = operational). */
  built: number;
  /** 0..1 cooldown remaining (silos, SAMs, airbases), 0 = ready. */
  cooldown: number;
}

export interface AttackView {
  id: number;
  attacker: number;
  /** 0 = unclaimed land. */
  defender: number;
  troops: number;
  naval: boolean;
  startTick: number;
}

export interface FrontView {
  id: number;
  /** Attacking side. */
  a: number;
  /** Defending side (0 = unclaimed land, usually not reported). */
  b: number;
  /** Representative point on the front (continuous tile coords). */
  x: number;
  y: number;
  /** 0..1, how hot the fighting is right now. */
  intensity: number;
  troopsA: number;
  troopsB: number;
  /** Front length in tiles. */
  length: number;
  /** Advance direction (tile space, unit length). */
  dirX: number;
  dirY: number;
  /** Polyline samples along the contact line: [x0, y0, x1, y1, ...] in continuous tile coords (<= 64 points). */
  samples: Float32Array;
}

export interface ScarView {
  id: number;
  x: number;
  y: number;
  /** Radius in tiles. */
  radius: number;
  /** 0..1, fades over minutes. */
  strength: number;
  weapon: UnitType;
  tick: number;
}

export interface WorldEventView {
  id: number;
  kind: WorldEventKind;
  x: number;
  y: number;
  /** Radius in tiles (0 for global events). */
  radius: number;
  /** 0..1 lifetime progress. */
  progress: number;
  magnitude: number;
  players: number[];
  /** Hurricanes: heading in radians (tile space). */
  heading: number;
}

export interface AllianceView {
  a: number;
  b: number;
  expiresTick: number;
}

export interface AllianceRequestView {
  from: number;
  to: number;
  expiresTick: number;
}

export interface StatsSample {
  tick: number;
  /** Indexed by player id. */
  tiles: Uint32Array;
  troops: Float32Array;
  gold: Float32Array;
}

export interface Timelapse {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  frameTick(i: number): number;
  /** Fills `out` (width*height) with owner ids for frame i. */
  decode(i: number, out: Uint16Array): void;
}
