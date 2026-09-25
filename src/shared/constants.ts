// FRONT ULTRA — shared constants & balance knobs.
// Owner: shared. EXCEPTIONS (see ARCHITECTURE.md §2):
//   * sim-core may tune the NUMBERS inside BALANCE, STRUCTURE_DEFS, UNIT_DEFS and NUKE_DEFS (never rename/remove keys).
//   * globe may tune RELIEF_EXAGGERATION.
// Worker-safe: no three.js, no DOM.

import { StructureType, UnitType, type BuildableUnit, type WeaponType } from './types';

// --- Grid & geometry -------------------------------------------------------------------------
export const MAP_W = 1600;
export const MAP_H = 800;
export const TILE_COUNT = MAP_W * MAP_H;
/** Degrees per tile (both axes). */
export const TILE_DEG = 360 / MAP_W;
export const EARTH_RADIUS_KM = 6371;
/** Globe radius in world units: 1.0 == EARTH_RADIUS_KM. */
export const GLOBE_RADIUS = 1;
/** Kilometers per tile along the equator (~25 km). */
export const TILE_KM = (2 * Math.PI * EARTH_RADIUS_KM) / MAP_W;
/** Visual vertical exaggeration of real relief (globe displacement, local terrain, unit placement). */
export const RELIEF_EXAGGERATION = 4;
/** Topology texture: gray 255 == this many meters (linear). */
export const TOPO_MAX_METERS = 8848;
/** Tiles south of this latitude that are land become TerrainClass.Ice (unplayable). */
export const ICE_LATITUDE = -60;

// --- Time ------------------------------------------------------------------------------------
export const TICK_MS = 100;
export const TICKS_PER_SECOND = 1000 / TICK_MS;
/** The worker posts one coalesced update per this many wall-clock ms (regardless of speed). */
export const UPDATE_INTERVAL_MS = 100;
/**
 * Presentation seconds for a full day/night cycle (sun circles the planet). v2: one visual day lasts 20 real minutes
 * at 1x (DESIGN_V2 §2.6); it is a presentation clock and never affects the simulation.
 */
export const DAY_LENGTH_SEC = 1200;
/** Latitude of the subsolar point (constant "season"). */
export const SUBSOLAR_LAT_DEG = 12;
/** worldTime seconds per real second on the menu (slow sun drift). */
export const MENU_WORLD_TIME_SCALE = 0.5;
/** Default world time for a new game: subsolar longitude 20°E -> daylight over Europe/Africa. */
export const DEFAULT_START_WORLD_TIME = (-20 / 360) * DAY_LENGTH_SEC;

// --- v2 (W1): time (DESIGN_V2 §2) -------------------------------------------------------------
/** One simulation tick is 6 game minutes. At 1x ten ticks run per real second: 1 real s = 1 game hour. */
export const GAME_SECONDS_PER_TICK = 360;
export const TICKS_PER_GAME_HOUR = 10;
export const TICKS_PER_GAME_DAY = 240;
/** Game seconds per real second of the strategic clock at speed 1x. */
export const STRATEGIC_RATE = 3600;
/** Speed in km/h -> tiles per tick along a meridian. */
export const kmhToTilesPerTick = (kmh: number): number => (kmh * GAME_SECONDS_PER_TICK / 3600) / TILE_KM;
/** Kilometres covered in one tick at `kmh`. */
export const kmhToKmPerTick = (kmh: number): number => (kmh * GAME_SECONDS_PER_TICK) / 3600;
export const hoursToTicks = (h: number): number => Math.round(h * TICKS_PER_GAME_HOUR);
/** Crisis time: game seconds per real second while a nuclear weapon flies, whatever the strategic speed (§2.2). */
export const CRISIS_RATE = 60;
/** Observation time: game seconds per real second while the camera is below ~70 km (§2.2). */
export const OBSERVATION_RATE = 60;
export const OBSERVATION_ENTER_KM = 60;
export const OBSERVATION_LEAVE_KM = 85;
/** Command-mode travel time rates (game s per real s). */
export const TRAVEL_RATES = [10, 60, 300, 900] as const;
/** Real seconds the crisis clock holds after the last nuclear weapon in flight, then the ramp back (§2.2). */
export const CRISIS_HOLD_SEC = 2;
export const CRISIS_RAMP_SEC = 1.5;
export const OBSERVATION_RAMP_SEC = 0.5;
/** Minimum on-screen duration of purely visual projectiles (combat events), real seconds (§2.3). */
export const MIN_VISUAL_PROJECTILE_SEC = 0.4;
export const MIN_VISUAL_SAM_SEC = 0.6;

// --- v2 (W1): warfare (DESIGN_V2 §4; shared because the UI predicts offensives) --------------------
/** Front depth speed cap (km/h) and the force ratio at which it is reached (§4.5). */
export const ADVANCE_MAX_KMH = 8;
export const ADVANCE_FULL_RATIO = 3;
/** Occupation march into unclaimed land (km/h), independent of troops (§4.5). */
export const NEUTRAL_ADVANCE_KMH = 7.5;
/** Frontage is bought with troops: corridor width = clamp(committed / TROOPS_PER_FRONT_TILE, 3, 40) tiles (§4.3). */
export const TROOPS_PER_FRONT_TILE = 20_000;
export const FRONTAGE_MIN = 3;
export const FRONTAGE_MAX = 40;
/**
 * Unclaimed land has no defenders: a colonising column needs far fewer soldiers per kilometre of front than an
 * assault on a defended line. Corridor width into unclaimed land = clamp(committed / this, 3, 40) tiles.
 */
export const NEUTRAL_TROOPS_PER_FRONT_TILE = 1_200;
/** Per-war logistics backstop: the defender loses at most max(0.9 % of its land at war start, 45) tiles per 60 ticks. */
export const LOGISTICS_SHARE = 0.009;
export const LOGISTICS_FLOOR = 45;
export const LOGISTICS_WINDOW = 60;
/** Tile thresholds θ = 1 + THRESHOLD_JITTER·(u − 0.5): speed-neutral desynchronisation of the front (§4.5). */
export const THRESHOLD_JITTER = 0.3;
/** Engagement: power exchanged per tick = ENGAGEMENT_RATE × min(Pa, Pd) (§4.6). */
export const ENGAGEMENT_RATE = 0.0005;
/** Troop regrowth scale on the v1 logistic curve, and its halving while at war (§4.6). */
export const TROOP_REGROWTH_SCALE = 0.14;
export const WAR_GROWTH_MUL = 0.5;
/** Garrisons (§4.4): rear share, mobilization ramp and redeployment time constant. */
export const DEFENSE_REAR_SHARE = 0.15;
export const DEFENSE_MOBILIZE_TICKS = 60;
/**
 * Redeployment time constant: 1/45 of the gap per tick (63 % in 4.5 h). Tuned from the design's 60 so that a defender
 * who raises a front to «alta» during a Normal AI mobilization (80 ticks) meets the offensive with >= 1.5x the passive
 * garrison (T34); 60 gave 1.44x.
 */
export const DEFENSE_REDEPLOY_TICKS = 45;
/** Front priority weights (baja, normal, alta) and the weight multiplier of a front under an enemy offensive. */
export const FRONT_PRIORITY_WEIGHT = [0.5, 1, 2] as const;
export const ATTACKED_FRONT_WEIGHT = 2;
/** Offensive contact phase before pressure starts ("las tropas avanzan hacia la línea"). */
export const OFFENSIVE_CONTACT_TICKS = 10;
/** Stall and end of an offensive (§4.9). */
export const OFFENSIVE_STALL_TICKS = 120;
export const OFFENSIVE_BREAK_TICKS = 60;
export const OFFENSIVE_RETURN_TICKS = 20;
export const RETREAT_LOSS = 0.1;
/** Unrest before any rebellion (§5.12). */
export const UNREST_TICKS = 480;
/** Mobilization after a declaration, by difficulty Easy..Insane (§2.4). */
export const HUMAN_MOBILIZE_TICKS = [40, 60, 80, 80] as const;
export const AI_MOBILIZE_TICKS = [120, 80, 60, 40] as const;
/** An ally joining through a call to arms, and a rebel movement, mobilize for 6 h. */
export const JOIN_MOBILIZE_TICKS = 60;
export const REBEL_MOBILIZE_TICKS = 60;
/** Warning (tension) that must precede an AI declaration on the human, by difficulty (§2.4). */
export const TENSION_LEAD_TICKS = [480, 240, 120, 120] as const;
/** No AI declares war on the human before this tick, by difficulty (§2.4, §4.16). */
export const HUMAN_GRACE_TICKS = [9_000, 6_000, 3_600, 2_400] as const;
/** Truce after a peace treaty, occupation window of captured land (§2.4, §4.13). */
export const TRUCE_TICKS = 4_800;
export const OCCUPATION_TICKS = 720;
/** Traitor flag after breaking a treaty (§5.6). */
export const TRAITOR_TICKS = 720;
/** Capitulation thresholds (§4.13): capital lost, share of the pre-war land lost, exhaustion. */
export const CAPITULATION_LAND_LOST = 0.5;
export const CAPITULATION_EXHAUSTION = 60;
/** Naval invasions (§4.11). */
export const EMBARK_PORT_TICKS = 60;
export const EMBARK_SHORE_TICKS = 120;
export const EMBARK_PORT_RANGE_KM = 600;
export const LANDING_STORM_TICKS = 20;
export const LANDING_COAST_MUL = 1.5;
export const INVASION_DETECT_TILES = 16;
/** Sieges: attrition of the pocket's share of home troops per game hour, and its defense multiplier (§4.12). */
export const SIEGE_ATTRITION_PER_HOUR = 0.005;
export const SIEGE_DEFENSE_MUL = 0.6;
/** Difficulty index Easy..Insane for the tables above. */
export const DIFFICULTY_INDEX = { easy: 0, normal: 1, hard: 2, insane: 3 } as const;

// --- Players ---------------------------------------------------------------------------------
export const NEUTRAL_ID = 0;
/** The human is always player 1. AI nations follow, then tribes/rebels. */
export const HUMAN_ID = 1;
/** Owner ids must fit in 11 bits (protocol packing). */
export const MAX_PLAYER_ID = 2047;

// --- Win condition ---------------------------------------------------------------------------
export const WIN_LAND_SHARE = 0.8;

// --- Balance (sim-core tunes values) -----------------------------------------------------------
export const BALANCE = {
  spawnRadiusTiles: 4,
  startTroops: 25_000,
  startGold: 150_000,
  /** Troop cap = base + perTile * tiles^0.6 + perCityLevel * cityLevels (sim/balance.ts has the exact formula). */
  troopCapBase: 100_000,
  troopCapPerTile: 2_000,
  troopCapPerCityLevel: 250_000,
  /** Growth per tick = (10 + troopGrowthRate * troops^0.73) * (1 - troops / cap). */
  troopGrowthRate: 0.25,
  goldPerTilePerSec: 0.5,
  goldPerCityPerSec: 250,
  goldPerFactoryPerSec: 160,
  tradeShipGoldBase: 12_000,
  /** Attack cost multipliers per TerrainClass (Plains, Hills, Mountains). */
  terrainAttackCost: { plains: 1.0, hills: 1.31, mountains: 1.69 } as Record<'plains' | 'hills' | 'mountains', number>,
  defensePostMultiplier: 2.5,
  defensePostRadiusTiles: 30,
  traitorDurationTicks: 1_800,
  traitorDefensePenalty: 0.5,
  allianceDurationTicks: 6_000,
  allianceRequestTimeoutTicks: 200,
  embargoTradePenalty: 1,
  boatSpeedTilesPerTick: 1.2,
  warshipRangeTiles: 22,
  samRangeTiles: 70,
  samInterceptChance: 0.75,
  radarRangeTiles: 60,
  difficultyAiMultiplier: { easy: 0.5, normal: 0.75, hard: 1.0, insane: 1.25 } as Record<'easy' | 'normal' | 'hard' | 'insane', number>,
  worldEventMinIntervalTicks: 1_200,
  doomsdayStartTick: 18_000,
};

// --- Structures --------------------------------------------------------------------------------
export interface StructureDef {
  type: StructureType;
  /** i18n key: `structure.<id>` (+ `.desc`). */
  id: string;
  /** Keyboard shortcut shown in the build bar. */
  hotkey: string;
  baseCost: number;
  /** cost = min(maxCost, baseCost * (1 + costStep * ownedCount)) */
  costStep: number;
  maxCost: number;
  buildTicks: number;
  /** Must be placed on a shore tile. */
  coastal: boolean;
  maxLevel: number;
}

export const STRUCTURE_DEFS: Record<StructureType, StructureDef> = {
  [StructureType.City]: { type: StructureType.City, id: 'city', hotkey: '1', baseCost: 125_000, costStep: 1, maxCost: 1_000_000, buildTicks: 50, coastal: false, maxLevel: 10 },
  [StructureType.Port]: { type: StructureType.Port, id: 'port', hotkey: '2', baseCost: 125_000, costStep: 1, maxCost: 1_000_000, buildTicks: 50, coastal: true, maxLevel: 5 },
  [StructureType.Factory]: { type: StructureType.Factory, id: 'factory', hotkey: '3', baseCost: 150_000, costStep: 1, maxCost: 1_200_000, buildTicks: 60, coastal: false, maxLevel: 5 },
  [StructureType.DefensePost]: { type: StructureType.DefensePost, id: 'defensePost', hotkey: '4', baseCost: 50_000, costStep: 0.5, maxCost: 250_000, buildTicks: 50, coastal: false, maxLevel: 3 },
  [StructureType.SamSite]: { type: StructureType.SamSite, id: 'samSite', hotkey: '5', baseCost: 1_000_000, costStep: 0.5, maxCost: 3_000_000, buildTicks: 300, coastal: false, maxLevel: 3 },
  [StructureType.MissileSilo]: { type: StructureType.MissileSilo, id: 'missileSilo', hotkey: '6', baseCost: 1_000_000, costStep: 0, maxCost: 1_000_000, buildTicks: 100, coastal: false, maxLevel: 3 },
  [StructureType.Airbase]: { type: StructureType.Airbase, id: 'airbase', hotkey: '7', baseCost: 400_000, costStep: 0.5, maxCost: 1_600_000, buildTicks: 120, coastal: false, maxLevel: 3 },
  [StructureType.ArmyBase]: { type: StructureType.ArmyBase, id: 'armyBase', hotkey: '8', baseCost: 300_000, costStep: 0.5, maxCost: 1_200_000, buildTicks: 100, coastal: false, maxLevel: 3 },
  [StructureType.NavalYard]: { type: StructureType.NavalYard, id: 'navalYard', hotkey: '9', baseCost: 350_000, costStep: 0.5, maxCost: 1_400_000, buildTicks: 120, coastal: true, maxLevel: 3 },
  [StructureType.Radar]: { type: StructureType.Radar, id: 'radar', hotkey: '0', baseCost: 200_000, costStep: 0.5, maxCost: 800_000, buildTicks: 80, coastal: false, maxLevel: 1 },
};

export function structureCost(type: StructureType, ownedCount: number): number {
  const d = STRUCTURE_DEFS[type];
  return Math.min(d.maxCost, Math.round(d.baseCost * (1 + d.costStep * ownedCount)));
}

// --- Units ---------------------------------------------------------------------------------------
export interface UnitDef {
  type: UnitType;
  /** i18n key: `unit.<id>` */
  id: string;
  /** 0 for units that are not bought directly. */
  cost: number;
  /** Structure that produces it (-1 = none). */
  producedBy: StructureType | -1;
  /**
   * Movement in tiles per tick (derived from speedKmh at module load: kmhToTilesPerTick). v2: nothing else
   * hard-codes tiles per tick (DESIGN_V2 §2.5).
   */
  speed: number;
  /**
   * v2 (W1): the speed the simulation moves the unit at, km per game hour. Aircraft and cruise missiles fly at their
   * real mission average (§2.1, the air rule); ballistic weapons use ballisticFlightTicks() instead (0 here).
   */
  speedKmh: number;
  /** v2 (W1): cruise speed shown on the unit card (km/h); equals speedKmh for surface units. */
  cruiseKmh: number;
  maxHp: number;
  /** True for units that fly (aircraft & missiles): renderers place them at altitude. */
  airborne: boolean;
  /** Command-mode kind when the player can take control of it. */
  command: 'tank' | 'jet' | 'ship' | null;
}

const U = UnitType;
const S = StructureType;
export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  // Surface speeds (§2.3): troop convoy 19 kn, container ship 16 kn, destroyer 30 kn, division road march, freight train.
  [U.TransportShip]: { type: U.TransportShip, id: 'transportShip', cost: 0, producedBy: -1, speed: 0, speedKmh: 35, cruiseKmh: 35, maxHp: 1, airborne: false, command: null },
  [U.TradeShip]: { type: U.TradeShip, id: 'tradeShip', cost: 0, producedBy: S.Port, speed: 0, speedKmh: 30, cruiseKmh: 30, maxHp: 1, airborne: false, command: null },
  [U.Warship]: { type: U.Warship, id: 'warship', cost: 250_000, producedBy: S.NavalYard, speed: 0, speedKmh: 55, cruiseKmh: 55, maxHp: 1000, airborne: false, command: 'ship' },
  [U.ArmoredDivision]: { type: U.ArmoredDivision, id: 'armoredDivision', cost: 150_000, producedBy: S.ArmyBase, speed: 0, speedKmh: 40, cruiseKmh: 40, maxHp: 800, airborne: false, command: 'tank' },
  // Air: mission averages (transit, routing, loiter); the card shows the cruise speed.
  [U.FighterSquadron]: { type: U.FighterSquadron, id: 'fighterSquadron', cost: 200_000, producedBy: S.Airbase, speed: 0, speedKmh: 450, cruiseKmh: 900, maxHp: 400, airborne: true, command: 'jet' },
  [U.Bomber]: { type: U.Bomber, id: 'bomber', cost: 350_000, producedBy: S.Airbase, speed: 0, speedKmh: 400, cruiseKmh: 850, maxHp: 600, airborne: true, command: null },
  [U.DroneSwarm]: { type: U.DroneSwarm, id: 'droneSwarm', cost: 120_000, producedBy: S.Airbase, speed: 0, speedKmh: 150, cruiseKmh: 200, maxHp: 200, airborne: true, command: null },
  [U.CruiseMissile]: { type: U.CruiseMissile, id: 'cruiseMissile', cost: 300_000, producedBy: S.MissileSilo, speed: 0, speedKmh: 600, cruiseKmh: 880, maxHp: 1, airborne: true, command: null },
  // Ballistic: flight time from ballisticFlightTicks(distance), not from a speed.
  [U.AtomBomb]: { type: U.AtomBomb, id: 'atomBomb', cost: 750_000, producedBy: S.MissileSilo, speed: 0, speedKmh: 0, cruiseKmh: 0, maxHp: 1, airborne: true, command: null },
  [U.HydrogenBomb]: { type: U.HydrogenBomb, id: 'hydrogenBomb', cost: 5_000_000, producedBy: S.MissileSilo, speed: 0, speedKmh: 0, cruiseKmh: 0, maxHp: 1, airborne: true, command: null },
  [U.Mirv]: { type: U.Mirv, id: 'mirv', cost: 25_000_000, producedBy: S.MissileSilo, speed: 0, speedKmh: 0, cruiseKmh: 0, maxHp: 1, airborne: true, command: null },
  [U.MirvWarhead]: { type: U.MirvWarhead, id: 'mirvWarhead', cost: 0, producedBy: -1, speed: 0, speedKmh: 0, cruiseKmh: 0, maxHp: 1, airborne: true, command: null },
  // Mach 4 interceptor: the engagement resolves on the tick (the streak is drawn for >= MIN_VISUAL_SAM_SEC).
  [U.SamInterceptor]: { type: U.SamInterceptor, id: 'samInterceptor', cost: 0, producedBy: S.SamSite, speed: 0, speedKmh: 5_000, cruiseKmh: 5_000, maxHp: 1, airborne: true, command: null },
  [U.Train]: { type: U.Train, id: 'train', cost: 0, producedBy: S.Factory, speed: 0, speedKmh: 100, cruiseKmh: 100, maxHp: 1, airborne: false, command: null },
  // Naval shell: purely visual (the hit resolves on the tick; the tracer is drawn for >= MIN_VISUAL_PROJECTILE_SEC).
  [U.Shell]: { type: U.Shell, id: 'shell', cost: 0, producedBy: -1, speed: 0, speedKmh: 3_000, cruiseKmh: 3_000, maxHp: 1, airborne: true, command: null },
};
for (const d of Object.values(UNIT_DEFS)) d.speed = kmhToTilesPerTick(d.speedKmh);

/** Armored divisions travel by rail (Factory network) at this speed (§2.3). */
export const ARMOR_RAIL_KMH = 100;

/**
 * v2 (W1): flight time of a ballistic weapon (atom bomb, H-bomb, MIRV) over `distanceKm` great-circle kilometres:
 * T = clamp(7 + 2.5·d/1000, 8, 35) game minutes (minimum-energy trajectory), in whole ticks (§2.3).
 */
export function ballisticFlightTicks(distanceKm: number): number {
  const minutes = Math.min(35, Math.max(8, 7 + (2.5 * Math.max(0, distanceKm)) / 1000));
  return Math.ceil(minutes / (GAME_SECONDS_PER_TICK / 60));
}

export const BUILDABLE_UNITS: readonly BuildableUnit[] = [U.Warship, U.ArmoredDivision, U.FighterSquadron, U.Bomber, U.DroneSwarm];
export const WEAPONS: readonly WeaponType[] = [U.AtomBomb, U.HydrogenBomb, U.Mirv, U.CruiseMissile];

// --- Nukes ---------------------------------------------------------------------------------------
export interface NukeDef {
  /** Tiles fully destroyed / depopulated. */
  innerRadius: number;
  /** Tiles damaged (partial). */
  outerRadius: number;
  /** Fraction of troops killed inside the outer radius. */
  troopLoss: number;
  /** Scar fade time in ticks. */
  falloutTicks: number;
  /** Flight time scale: ticks = distanceTiles / UNIT_DEFS.speed, clamped to [minFlightTicks, ...]. */
  minFlightTicks: number;
}

export const NUKE_DEFS: Record<WeaponType | typeof UnitType.MirvWarhead, NukeDef> = {
  [U.AtomBomb]: { innerRadius: 10, outerRadius: 22, troopLoss: 0.6, falloutTicks: 1_800, minFlightTicks: 60 },
  [U.HydrogenBomb]: { innerRadius: 28, outerRadius: 46, troopLoss: 0.85, falloutTicks: 3_600, minFlightTicks: 80 },
  [U.Mirv]: { innerRadius: 0, outerRadius: 0, troopLoss: 0, falloutTicks: 0, minFlightTicks: 90 },
  [U.MirvWarhead]: { innerRadius: 9, outerRadius: 14, troopLoss: 0.6, falloutTicks: 1_800, minFlightTicks: 20 },
  [U.CruiseMissile]: { innerRadius: 3, outerRadius: 6, troopLoss: 0.2, falloutTicks: 0, minFlightTicks: 20 },
};

// --- Rendering scale helpers ---------------------------------------------------------------------
/** Camera altitude limits in km. */
export const CAMERA_MIN_ALT_KM = 0.35;
export const CAMERA_MAX_ALT_KM = 42_000;
/** Below this altitude the ground battle layer fades in (battle owner). */
export const BATTLE_LAYER_ALT_KM = 600;
