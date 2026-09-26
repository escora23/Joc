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

/**
 * 0 = paused. v2: the strategic clock runs speed × 1 game hour per real second (10 ticks per real second at 1x);
 * crisis and observation time slow the whole world down whatever the speed (DESIGN_V2 §2.2).
 */
export type GameSpeed = 0 | 0.5 | 1 | 2 | 4;
export const GAME_SPEEDS: readonly GameSpeed[] = [0, 0.5, 1, 2, 4];

// --- v2 (W1): clock -----------------------------------------------------------------------------
/** Which clock drives the world (§2.2). Precedence: tactical/travel > crisis = observation > strategic. */
export type ClockMode = 'strategic' | 'crisis' | 'observation' | 'tactical' | 'travel';
/** Clock state sent with every update. rate = game seconds per real second (0 when paused). */
export interface ClockView {
  mode: ClockMode;
  rate: number;
  /** Wall-clock milliseconds per tick at the current rate (0 when paused). */
  tickPeriodMs: number;
  /** Travel time is being held back by terrain streaming (command mode). */
  throttled?: boolean;
  /** The strategic speed chosen by the player (restored when crisis / observation ends). */
  speed: GameSpeed;
  /** Worker wall time (Date.now()) when the update carrying this clock was posted: measurements independent of how
   *  late the main thread (a slow renderer) gets to the message. */
  wallMs?: number;
}
/** Setup option «Duración»: victory thresholds and the time limit (§4.18). */
export type GameDuration = 'short' | 'normal' | 'long';
export const GAME_DURATIONS: readonly GameDuration[] = ['short', 'normal', 'long'];

// --- v2 (W1): war -------------------------------------------------------------------------------
/** The state between two players (§4.1). Independent territories and unclaimed land are outside it. */
export type PairState = 'peace' | 'war' | 'truce';
export type TreatyKind = 'alliance' | 'nap' | 'trade' | 'openBorders';
export type WarGoal = 'border' | 'tribute' | 'conquest' | 'retaliation' | 'coalition' | 'liberation' | 'defense' | 'incursion';
export interface WarView {
  id: number;
  /** Side A (declared the war) and side B (its target). */
  aggressor: number;
  target: number;
  /** A call-to-arms war joins this one (0 = none). */
  parentWar: number;
  startTick: number;
  goal: WarGoal;
  /** i18n key of the stated reason (war.reason.*). */
  reasonKey: string;
  /** The aggressor may not start offensives before this tick. */
  mobilizeUntilTick: number;
  /** Escalation level 0..4 of each side (§5.10). */
  escalationA: number;
  escalationB: number;
  /** War score of side A, -100..100 (side B's is the opposite). */
  scoreA: number;
  exhaustionA: number;
  exhaustionB: number;
  /** Net tiles side A has taken from side B in this war (negative: lost). */
  tilesA: number;
  casualtiesA: number;
  casualtiesB: number;
  /** Tiles of the defender side still allowed this logistics window (§4.5), per side. */
  logisticsA: number;
  logisticsB: number;
}
export interface PeaceTerms {
  kind: 'white' | 'cede' | 'tribute' | 'capitulation';
  tiles?: number;
  gold?: number;
  incomeShare?: number;
  ticks?: number;
  /** v2 (W3): the side that cedes or pays (cede / tribute); 0 or absent for a white peace. */
  loser?: number;
}
/** A besieged pocket (§4.12). */
export interface SiegeView {
  owner: number;
  by: number[];
  x: number;
  y: number;
  tiles: number;
  sinceTick: number;
}
/** Offensive life cycle (§4.3–§4.11). */
export type AttackState =
  | 'mobilizing' | 'embarking' | 'sailing' | 'landing' | 'contact' | 'advancing' | 'consolidating' | 'stalled' | 'retreating';

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
  /** v2 (W1): «Duración» (victory thresholds and time limit, §4.18). Default 'normal'. */
  duration?: GameDuration;
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

export type GameOverReason = 'domination' | 'lastStanding' | 'eliminated' | 'hegemony' | 'timeLimit';

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
  // --- v2 (W4): orders and purpose (DESIGN_V2 §7, §14.2) ---
  /** What the unit is doing (UnitMode). */
  mode: UnitMode;
  /** The order it is carrying out (index into UNIT_ORDER_KINDS), -1 = none (its default behaviour). */
  order: number;
  /** Ticks until it arrives / is ready (rearm), -1 = n/a. */
  etaTicks: number;
  /** Stable key of the front it is attached to or supports (0 = none). */
  frontKey: number;
  /** Home structure id (airbase, army base, naval yard, port), 0 = none. */
  home: number;
  /** Ordinal of its type for its owner («1.ª División Acorazada»), 0 = unnamed (missiles, trade ships). */
  serial: number;
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
  /** v2 (W4): upgrade progress 0..1 toward level + 1 (0 = not upgrading); the structure keeps working meanwhile. */
  upgrade?: number;
  /** v2 (W4): units queued for production here (hourglass badge). */
  producing?: number;
}

export interface AttackView {
  id: number;
  attacker: number;
  /** 0 = unclaimed land. */
  defender: number;
  troops: number;
  naval: boolean;
  /** v2: the tick the offensive starts pushing (end of the aggressor's mobilization for a queued offensive). */
  startTick: number;
  // --- v2 (W1) ---
  /** Axis point (the click) and the corridor origin, continuous tile coords. */
  x: number;
  y: number;
  originX: number;
  originY: number;
  /** Stable key of the front it pushes on (0 = none yet / unclaimed land). */
  frontKey: number;
  /** Corridor width in tiles (§4.3). */
  frontageTiles: number;
  tilesTaken: number;
  tilesLost: number;
  /** Force ratio R = Pa / Pd (0 for unclaimed land). */
  ratio: number;
  /** Measured depth speed, km per game hour (EMA of what actually fell, §4.5). */
  advanceKmh: number;
  /** Troops committed so far (initial + reinforcements). */
  committed: number;
  /** Ticks until the next milestone of the state (mobilization end, landing...), -1 = n/a. */
  etaTicks: number;
  state: AttackState;
  /** The defender's garrison power facing this offensive (Pd), for the odds display. */
  defensePower: number;
  attackPower: number;
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
  // --- v2 (W1): fronts are first-class (§4.3, §4.4, §14.2) ---
  /** Stable key (survives re-clustering). */
  key: number;
  /** -1..1, + = side a gaining ground. */
  momentum: number;
  /** Measured depth speed of the fastest offensive on this front, km per game hour. */
  advanceKmh: number;
  startTick: number;
  /** Power of the offensive(s) of side a and of side b's garrison (+ counter-offensive) on this front. */
  pa: number;
  pd: number;
  /** Garrison Gf of each side on this front (troops), published for quiet fronts too. */
  garrisonA: number;
  garrisonB: number;
  /** Current and target garrison shares of each side (0..1) and the priority each side set (0 baja, 1, 2 alta). */
  shareA: number;
  shareB: number;
  targetShareA: number;
  targetShareB: number;
  priorityA: number;
  priorityB: number;
  casualtiesA: number;
  casualtiesB: number;
  divisionsA: number;
  divisionsB: number;
  /** At war but no offensive on it. */
  quiet: boolean;
  /** Attack id of each side's offensive on this front (0 = none). */
  offensiveA: number;
  offensiveB: number;
  /** Per polyline vertex: pressure progress (p/θ × 255) of the tile being taken; only near the observation focus. */
  progress?: Uint8Array;
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

// --- v2 (W3): diplomacy (DESIGN_V2 §5.1–§5.6, §14.2) -----------------------------------------------
/** One treaty between two players (§5.2). untilTick 0 = open-ended; leavingTick > 0 = notice given (alliance). */
export interface TreatyView {
  a: number;
  b: number;
  kind: TreatyKind;
  sinceTick: number;
  untilTick: number;
  leavingTick: number;
  /** Who gave notice (0 = nobody). */
  leaver: number;
}
/** A reason line: i18n key (diplo.reason.* or answer.*), its opinion value when it has one, and parameters. */
export interface ReasonView {
  key: string;
  value?: number;
  params?: Record<string, string | number>;
}
/** An AI's opinion of another player with its reasons (§5.1). The sim publishes the AIs' opinions of the human. */
export interface OpinionView {
  of: number;
  toward: number;
  score: number;
  reasons: ReasonView[];
  /** Latest tension this AI stated toward `toward` (tick, reason key), when any. */
  tensionTick?: number;
  tensionKey?: string;
  /** Accepted ultimatum: no war from this AI before this tick (§5.4). */
  noWarUntil?: number;
  /** Calls to arms refused by `toward` (three end the alliance, §5.5). */
  refusals?: number;
}
export type ProposalKind = TreatyKind | 'peace' | 'callToArms' | 'demand';
export type DemandKind = 'cede' | 'tribute' | 'breakAlliance' | 'endEmbargo' | 'withdraw';
export interface Demand {
  kind: DemandKind;
  /** Cession: tiles of the band. */
  tiles?: number;
  /** Tribute: gold. */
  gold?: number;
  /** Break an alliance with / lift the embargo on this player. */
  target?: number;
}
export type ProposalStatus = 'considering' | 'pending' | 'accepted' | 'rejected' | 'countered' | 'expired' | 'cancelled';
export interface ProposalView {
  id: number;
  from: number;
  to: number;
  kind: ProposalKind;
  terms?: PeaceTerms;
  demand?: Demand;
  /** War the peace or the call to arms is about (0 = none). */
  war: number;
  /** Call to arms: the enemy to fight. */
  target: number;
  /** Gold offered with the proposal (held until the answer; paid on acceptance). */
  gold: number;
  createdTick: number;
  /** An AI receiver answers at this tick (deliberation). */
  decideTick: number;
  /** A human receiver may answer until this tick (and at least INBOX_MIN_REAL_MS of unpaused real time). */
  expiresTick: number;
  /** Unpaused real milliseconds this item has been pending (human receiver). */
  realMs: number;
  status: ProposalStatus;
  /** Tick of the answer / expiry (0 while open). */
  resolvedTick: number;
  /** The one or two strongest reasons of the answer. */
  reasons?: ReasonView[];
  /** Counter-offer created by this answer (id), or the proposal this one counters. */
  counterId?: number;
  counterOf?: number;
  /** A demand with a deadline and a threat of war (§5.4). */
  ultimatum?: boolean;
}
/**
 * v2 (W3): the human's economy with its terms, for the top-bar breakdowns (§12.2, §6.7). Rates per game hour;
 * `cap` and `income` terms are before the multiplier `mul` (kind, difficulty and world-event modifiers).
 */
export interface HumanEconomyView {
  pop: number;
  popTarget: number;
  fPop: number;
  recruitment: number;
  tiles: number;
  occupied: number;
  fallout: number;
  cityLevels: number;
  armyLevels: number;
  factoryLevels: number;
  cap: { base: number; territory: number; cities: number; armyBases: number; mul: number };
  income: { base: number; territory: number; cities: number; factories: number; mul: number };
  growthPerHour: number;
  atWar: boolean;
}
/** Auto-pause triggers (§8.5). */
export type AutoPauseKind = 'warOnYou' | 'ultimatum' | 'nukeAtYou' | 'capitalThreat' | 'invasion' | 'proposal' | 'peaceOffer' | 'callToArms';
export const AUTO_PAUSE_KINDS: readonly AutoPauseKind[] = ['warOnYou', 'ultimatum', 'nukeAtYou', 'capitalThreat', 'invasion', 'proposal', 'peaceOffer', 'callToArms'];

// --- v2 (W4): unit orders, modes and production (DESIGN_V2 §6.4, §7, §14.2) ------------------------------------------
/** Orders a player gives to units (§6.4). The right-click context picks one (§7.3). */
export type UnitOrderKind = 'move' | 'attach' | 'hold' | 'return' | 'cap' | 'intercept' | 'escort' | 'strike' | 'support'
  | 'patrol' | 'blockade' | 'bombard' | 'rebase' | 'attack';
/** Index = the order code published in UnitView.order. Append only. */
export const UNIT_ORDER_KINDS: readonly UnitOrderKind[] = [
  'move', 'attach', 'hold', 'return', 'cap', 'intercept', 'escort', 'strike', 'support', 'patrol', 'blockade', 'bombard',
  'rebase', 'attack',
];
/** What a unit is doing right now (published in UnitView.mode). */
export const UnitMode = {
  Idle: 0,
  /** Road march (divisions) or transit (ships, aircraft). */
  Moving: 1,
  /** A division travelling by rail. */
  Rail: 2,
  /** A division attached to a front, holding it (defense). */
  Front: 3,
  /** A division attached to a front, supporting our offensive. */
  Offensive: 4,
  Returning: 5,
  /** Aircraft parked at its airbase, ready. */
  Docked: 6,
  /** Aircraft on the ground rearming after a sortie (etaTicks = ready). */
  Rearming: 7,
  /** Fighter combat air patrol, warship patrol zone. */
  Patrol: 8,
  Intercept: 9,
  Escort: 10,
  /** Bomber / drone sortie toward its target. */
  Strike: 11,
  /** Drone swarm supporting a front. */
  Support: 12,
  Blockade: 13,
  Bombard: 14,
  /** Transport convoy embarking in port. */
  Embarking: 15,
  /** Unit in combat (warship engaging, fighter dogfight). */
  Engaged: 16,
} as const;
export type UnitMode = (typeof UnitMode)[keyof typeof UnitMode];
/** One unit being produced for the human (TickUpdate.production). */
export interface ProductionView {
  structureId: number;
  unit: BuildableUnit;
  startTick: number;
  readyTick: number;
  /** The ordinal the unit will carry. */
  serial: number;
}
