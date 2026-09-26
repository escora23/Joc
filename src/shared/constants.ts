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
export const CAPITULATION_LAND_LOST = 0.4;
export const CAPITULATION_EXHAUSTION = 50;
/**
 * Hopeless resistance (§4.13, §4.18 convergence): against enemies whose combined land is `r` times its own pre-war land,
 * a nation gives up sooner. The land threshold falls by CAPITULATION_ODDS_SLOPE per unit of r above 1 down to
 * CAPITULATION_LAND_LOST_MIN, the exhaustion threshold by 5 per unit down to CAPITULATION_EXHAUSTION_MIN.
 */
export const CAPITULATION_LAND_LOST_MIN = 0.15;
export const CAPITULATION_EXHAUSTION_MIN = 30;
export const CAPITULATION_ODDS_SLOPE = 0.15;
/** An army broken (home plus committed troops below this share of the cap) counts like a lost capital (§4.13). */
export const CAPITULATION_ARMY_BROKEN = 0.1;
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
/**
 * v2 (§4.18): victory by «Duración». domination = land share that wins at once. Hegemony = a leader holding at least
 * `hegemonyLeader` of the land whose bloc (the leader and its junior allies: allies with less land than it) holds at
 * least `hegemony` of the land and `hegemonyRatio` times the largest nation outside the bloc, for holdTicks (the
 * countdown). timeLimit = the tick the largest nation wins (0 = none).
 */
export const DURATION_RULES = {
  short: { domination: 0.6, hegemonyLeader: 0.15, hegemony: 0.22, hegemonyRatio: 1.75, holdTicks: 1_200, timeLimit: 48_000 },
  normal: { domination: 0.8, hegemonyLeader: 0.2, hegemony: 0.3, hegemonyRatio: 2, holdTicks: 2_400, timeLimit: 96_000 },
  long: { domination: 0.9, hegemonyLeader: 0.3, hegemony: 0.4, hegemonyRatio: 2.5, holdTicks: 4_800, timeLimit: 0 },
} as const;

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
  [StructureType.Port]: { type: StructureType.Port, id: 'port', hotkey: '2', baseCost: 125_000, costStep: 1, maxCost: 1_000_000, buildTicks: 50, coastal: true, maxLevel: 3 },
  [StructureType.Factory]: { type: StructureType.Factory, id: 'factory', hotkey: '3', baseCost: 150_000, costStep: 1, maxCost: 1_200_000, buildTicks: 60, coastal: false, maxLevel: 3 },
  [StructureType.DefensePost]: { type: StructureType.DefensePost, id: 'defensePost', hotkey: '4', baseCost: 50_000, costStep: 0.5, maxCost: 250_000, buildTicks: 50, coastal: false, maxLevel: 3 },
  [StructureType.SamSite]: { type: StructureType.SamSite, id: 'samSite', hotkey: '5', baseCost: 1_000_000, costStep: 0.5, maxCost: 3_000_000, buildTicks: 300, coastal: false, maxLevel: 3 },
  [StructureType.MissileSilo]: { type: StructureType.MissileSilo, id: 'missileSilo', hotkey: '6', baseCost: 1_000_000, costStep: 0, maxCost: 1_000_000, buildTicks: 100, coastal: false, maxLevel: 3 },
  [StructureType.Airbase]: { type: StructureType.Airbase, id: 'airbase', hotkey: '7', baseCost: 400_000, costStep: 0.5, maxCost: 1_600_000, buildTicks: 120, coastal: false, maxLevel: 3 },
  [StructureType.ArmyBase]: { type: StructureType.ArmyBase, id: 'armyBase', hotkey: '8', baseCost: 300_000, costStep: 0.5, maxCost: 1_200_000, buildTicks: 100, coastal: false, maxLevel: 3 },
  [StructureType.NavalYard]: { type: StructureType.NavalYard, id: 'navalYard', hotkey: '9', baseCost: 350_000, costStep: 0.5, maxCost: 1_400_000, buildTicks: 120, coastal: true, maxLevel: 3 },
  [StructureType.Radar]: { type: StructureType.Radar, id: 'radar', hotkey: '0', baseCost: 200_000, costStep: 0.5, maxCost: 800_000, buildTicks: 80, coastal: false, maxLevel: 3 },
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
  // --- v2 (W4): units with a job (DESIGN_V2 §6.3) ---
  /** Reach in km from the home base (aircraft) or the launch site (missiles); 0 = not applicable (surface units). */
  rangeKm: number;
  /** Production time at its producing structure, in ticks (§2.4); 0 = not produced. */
  productionTicks: number;
  /** i18n key of the one-line purpose shown on the card and in tooltips. */
  roleKey: string;
}

const U = UnitType;
const S = StructureType;
export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  // Surface speeds (§2.3): troop convoy 19 kn, container ship 16 kn, destroyer 30 kn, division road march, freight train.
  [U.TransportShip]: { type: U.TransportShip, id: 'transportShip', cost: 0, producedBy: -1, speed: 0, speedKmh: 35, cruiseKmh: 35, maxHp: 1, airborne: false, rangeKm: 0, productionTicks: 0, roleKey: 'unit.transportShip.role', command: null },
  [U.TradeShip]: { type: U.TradeShip, id: 'tradeShip', cost: 0, producedBy: S.Port, speed: 0, speedKmh: 30, cruiseKmh: 30, maxHp: 1, airborne: false, rangeKm: 0, productionTicks: 0, roleKey: 'unit.tradeShip.role', command: null },
  [U.Warship]: { type: U.Warship, id: 'warship', cost: 250_000, producedBy: S.NavalYard, speed: 0, speedKmh: 55, cruiseKmh: 55, maxHp: 1000, airborne: false, rangeKm: 0, productionTicks: 160, roleKey: 'unit.warship.role', command: 'ship' },
  [U.ArmoredDivision]: { type: U.ArmoredDivision, id: 'armoredDivision', cost: 150_000, producedBy: S.ArmyBase, speed: 0, speedKmh: 40, cruiseKmh: 40, maxHp: 800, airborne: false, rangeKm: 0, productionTicks: 80, roleKey: 'unit.armoredDivision.role', command: 'tank' },
  // Air: mission averages (transit, routing, loiter); the card shows the cruise speed.
  [U.FighterSquadron]: { type: U.FighterSquadron, id: 'fighterSquadron', cost: 200_000, producedBy: S.Airbase, speed: 0, speedKmh: 450, cruiseKmh: 900, maxHp: 400, airborne: true, rangeKm: 1000, productionTicks: 60, roleKey: 'unit.fighterSquadron.role', command: 'jet' },
  [U.Bomber]: { type: U.Bomber, id: 'bomber', cost: 350_000, producedBy: S.Airbase, speed: 0, speedKmh: 400, cruiseKmh: 850, maxHp: 600, airborne: true, rangeKm: 2000, productionTicks: 100, roleKey: 'unit.bomber.role', command: null },
  [U.DroneSwarm]: { type: U.DroneSwarm, id: 'droneSwarm', cost: 120_000, producedBy: S.Airbase, speed: 0, speedKmh: 150, cruiseKmh: 200, maxHp: 200, airborne: true, rangeKm: 1000, productionTicks: 40, roleKey: 'unit.droneSwarm.role', command: null },
  [U.CruiseMissile]: { type: U.CruiseMissile, id: 'cruiseMissile', cost: 300_000, producedBy: S.MissileSilo, speed: 0, speedKmh: 600, cruiseKmh: 880, maxHp: 1, airborne: true, rangeKm: 2500, productionTicks: 0, roleKey: 'unit.cruiseMissile.role', command: null },
  // Ballistic: flight time from ballisticFlightTicks(distance), not from a speed.
  [U.AtomBomb]: { type: U.AtomBomb, id: 'atomBomb', cost: 750_000, producedBy: S.MissileSilo, speed: 0, speedKmh: 0, cruiseKmh: 0, maxHp: 1, airborne: true, rangeKm: 5500, productionTicks: 0, roleKey: 'unit.atomBomb.role', command: null },
  [U.HydrogenBomb]: { type: U.HydrogenBomb, id: 'hydrogenBomb', cost: 5_000_000, producedBy: S.MissileSilo, speed: 0, speedKmh: 0, cruiseKmh: 0, maxHp: 1, airborne: true, rangeKm: 20000, productionTicks: 0, roleKey: 'unit.hydrogenBomb.role', command: null },
  [U.Mirv]: { type: U.Mirv, id: 'mirv', cost: 25_000_000, producedBy: S.MissileSilo, speed: 0, speedKmh: 0, cruiseKmh: 0, maxHp: 1, airborne: true, rangeKm: 20000, productionTicks: 0, roleKey: 'unit.mirv.role', command: null },
  [U.MirvWarhead]: { type: U.MirvWarhead, id: 'mirvWarhead', cost: 0, producedBy: -1, speed: 0, speedKmh: 0, cruiseKmh: 0, maxHp: 1, airborne: true, rangeKm: 0, productionTicks: 0, roleKey: 'unit.mirvWarhead.role', command: null },
  // Mach 4 interceptor: the engagement resolves on the tick (the streak is drawn for >= MIN_VISUAL_SAM_SEC).
  [U.SamInterceptor]: { type: U.SamInterceptor, id: 'samInterceptor', cost: 0, producedBy: S.SamSite, speed: 0, speedKmh: 5_000, cruiseKmh: 5_000, maxHp: 1, airborne: true, rangeKm: 0, productionTicks: 0, roleKey: 'unit.samInterceptor.role', command: null },
  [U.Train]: { type: U.Train, id: 'train', cost: 0, producedBy: S.Factory, speed: 0, speedKmh: 100, cruiseKmh: 100, maxHp: 1, airborne: false, rangeKm: 0, productionTicks: 0, roleKey: 'unit.train.role', command: null },
  // Naval shell: purely visual (the hit resolves on the tick; the tracer is drawn for >= MIN_VISUAL_PROJECTILE_SEC).
  [U.Shell]: { type: U.Shell, id: 'shell', cost: 0, producedBy: -1, speed: 0, speedKmh: 3_000, cruiseKmh: 3_000, maxHp: 1, airborne: true, rangeKm: 0, productionTicks: 0, roleKey: 'unit.shell.role', command: null },
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

// --- v2 (W4): structures, levels and economy rates (DESIGN_V2 §6.1–§6.3). Single source of truth for the sim, the
// cards, the tooltips and the encyclopedia: every number a player reads comes from these tables. ---------------------

/** Maritime trade of a Port by level, gold per game hour while its ships sail (§6.2). */
export const PORT_TRADE_GOLD_PER_HOUR = [0, 150, 300, 450] as const;
/** Rail freight of a Factory by level, gold per game hour while its trains run (§6.2). */
export const RAIL_GOLD_PER_HOUR = [0, 60, 120, 180] as const;
/** Ticks a port waits before sending the next trade ship after one arrives or is lost. */
export const TRADE_TURNAROUND_TICKS = 2;
/** The destination port's owner receives this share of a trade payout; both sides +20 % with a trade agreement. */
export const TRADE_DEST_SHARE = 0.5;
export const TRADE_AGREEMENT_BONUS = 0.2;

/**
 * Numeric effects of one structure level (§6.2). Absent fields do not apply to the type. Distances are in tiles
 * (1 tile = 25 km), rates per game hour, chances 0..1.
 */
export interface StructureLevelDef {
  /** City: troop cap, gold per hour and population target added by the city at this level (cumulative). */
  troopCap?: number;
  goldPerHour?: number;
  population?: number;
  /** Port: trade gold per hour, trade ships kept at sea, invasion embarkation time, ship repairs. */
  tradeGoldPerHour?: number;
  tradeShips?: number;
  embarkTicks?: number;
  /** Factory: rail freight gold per hour, trains kept running, divisions that may travel by rail at once. */
  railGoldPerHour?: number;
  trains?: number;
  railSlots?: number;
  /** Defense post: zone radius and the enemy advance-time / attacker-casualty multipliers inside it. */
  radiusTiles?: number;
  timeMul?: number;
  casualtyMul?: number;
  /** SAM: range and hit chance against aircraft and cruise missiles, against ballistic warheads, salvo, reload. */
  rangeTiles?: number;
  hitAir?: number;
  abmTiles?: number;
  hitBallistic?: number;
  salvo?: number;
  reloadTicks?: number;
  /** Silo: weapons it can launch at this level. */
  weapons?: readonly WeaponType[];
  /** Airbase / army base / naval yard: units hosted (produced and repaired here). */
  capacity?: number;
  /** Airbase: scramble radius against raids (×1.5 inside own radar coverage). */
  scrambleTiles?: number;
  /** Repairs of hosted / nearby units, integrity share per game hour, and the radius they reach. */
  repairPerHour?: number;
  repairTiles?: number;
  /** Radar: early-warning and fire-control coverage. */
  coverageTiles?: number;
}

const SL = (d: StructureLevelDef): StructureLevelDef => d;
const SILO_W = (...w: number[]): readonly WeaponType[] => w as WeaponType[];
/** Per structure type, index = level (index 0 unused). */
export const STRUCTURE_LEVELS: Record<StructureType, readonly StructureLevelDef[]> = {
  [S.City]: [SL({}), ...Array.from({ length: 10 }, (_, i) => SL({ troopCap: 250_000 * (i + 1), goldPerHour: 250 * (i + 1), population: 800_000 * (i + 1) }))],
  [S.Port]: [SL({}),
    SL({ tradeGoldPerHour: 150, tradeShips: 2, embarkTicks: 60, repairPerHour: 0.05, repairTiles: 3 }),
    SL({ tradeGoldPerHour: 300, tradeShips: 4, embarkTicks: 40, repairPerHour: 0.05, repairTiles: 3 }),
    SL({ tradeGoldPerHour: 450, tradeShips: 6, embarkTicks: 30, repairPerHour: 0.05, repairTiles: 3 })],
  [S.Factory]: [SL({}),
    SL({ goldPerHour: 160, railGoldPerHour: 60, trains: 1, railSlots: 1 }),
    SL({ goldPerHour: 320, railGoldPerHour: 120, trains: 2, railSlots: 2 }),
    SL({ goldPerHour: 480, railGoldPerHour: 180, trains: 3, railSlots: 3 })],
  [S.DefensePost]: [SL({}),
    SL({ radiusTiles: 3, timeMul: 1.5, casualtyMul: 1.5 }),
    SL({ radiusTiles: 4.5, timeMul: 1.75, casualtyMul: 1.75 }),
    SL({ radiusTiles: 6, timeMul: 2, casualtyMul: 2 })],
  [S.SamSite]: [SL({}),
    SL({ rangeTiles: 8, hitAir: 0.7, abmTiles: 5, hitBallistic: 0.45, salvo: 1, reloadTicks: 20 }),
    SL({ rangeTiles: 10, hitAir: 0.75, abmTiles: 6, hitBallistic: 0.55, salvo: 2, reloadTicks: 20 }),
    SL({ rangeTiles: 12, hitAir: 0.8, abmTiles: 8, hitBallistic: 0.65, salvo: 3, reloadTicks: 20 })],
  [S.MissileSilo]: [SL({}),
    SL({ weapons: SILO_W(U.CruiseMissile, U.AtomBomb), reloadTicks: 240 }),
    SL({ weapons: SILO_W(U.CruiseMissile, U.AtomBomb, U.HydrogenBomb), reloadTicks: 120 }),
    SL({ weapons: SILO_W(U.CruiseMissile, U.AtomBomb, U.HydrogenBomb, U.Mirv), reloadTicks: 80 })],
  [S.Airbase]: [SL({}),
    SL({ capacity: 3, scrambleTiles: 16, repairPerHour: 0.1 }),
    SL({ capacity: 6, scrambleTiles: 16, repairPerHour: 0.1 }),
    SL({ capacity: 9, scrambleTiles: 16, repairPerHour: 0.1 })],
  [S.ArmyBase]: [SL({}),
    SL({ capacity: 2, troopCap: 60_000, repairPerHour: 0.01, repairTiles: 5 }),
    SL({ capacity: 4, troopCap: 120_000, repairPerHour: 0.02, repairTiles: 5 }),
    SL({ capacity: 6, troopCap: 180_000, repairPerHour: 0.03, repairTiles: 5 })],
  [S.NavalYard]: [SL({}),
    SL({ capacity: 2, repairPerHour: 0.02, repairTiles: 3 }),
    SL({ capacity: 4, repairPerHour: 0.04, repairTiles: 3 }),
    SL({ capacity: 6, repairPerHour: 0.06, repairTiles: 3 })],
  [S.Radar]: [SL({}), SL({ coverageTiles: 20 }), SL({ coverageTiles: 28 }), SL({ coverageTiles: 36 })],
};

/** The effects of `type` at `level` (clamped to the type's levels). */
export function structureLevel(type: StructureType, level: number): StructureLevelDef {
  const t = STRUCTURE_LEVELS[type];
  return t[Math.max(1, Math.min(t.length - 1, Math.floor(level)))];
}

/** Gold to go from `level` to `level + 1` (§6.1): round(baseCost × (0.5 + 0.5 × level)). */
export function upgradeCost(type: StructureType, level: number): number {
  return Math.round(STRUCTURE_DEFS[type].baseCost * (0.5 + 0.5 * level));
}
/** Ticks an upgrade takes: 50 % of the construction time; the structure keeps working meanwhile (§6.1). */
export function upgradeTicks(type: StructureType): number {
  return Math.round(STRUCTURE_DEFS[type].buildTicks * 0.5);
}

/** Inside own radar coverage: SAM range ×1.25, fighter scramble radius ×1.5 (§6.2). */
export const RADAR_SAM_RANGE_MUL = 1.25;
export const RADAR_SCRAMBLE_MUL = 1.5;

// Units in the field (§6.3, §6.4). Distances in tiles, rates per game hour, integrity as a share of 1.
/** A division within this many tiles of a front attaches to it; its armor effect reaches this far. */
export const DIVISION_ATTACH_TILES = 3;
/** Division integrity: wear per hour while its front is engaged / while its offensive advances at the cap, field repair. */
export const DIVISION_WEAR_ENGAGED = 0.002;
export const DIVISION_WEAR_AT_CAP = 0.005;
export const DIVISION_FIELD_REPAIR = 0.0025;
/** Fighter combat air patrol circle and interception chances per engagement. */
export const CAP_RADIUS_TILES = 6;
export const CAP_HIT_AIRCRAFT = 0.6;
export const CAP_HIT_CRUISE = 0.45;
/** Aircraft rearm after landing (§2.4), ticks. */
export const REARM_TICKS: Readonly<Record<number, number>> = { [U.FighterSquadron]: 20, [U.Bomber]: 60, [U.DroneSwarm]: 40 };
/** Bomber and drone payloads (§6.3). */
export const BOMBER_STRUCT_DMG = 0.55;
export const BOMBER_DIRECT_DMG = 1.1;
export const BOMBER_DIVISION_DMG = 0.35;
export const BOMBER_GARRISON_SHARE = 0.03;
export const DRONE_STRUCT_DMG = 0.38;
export const DRONE_DIRECT_DMG = 0.6;
/** Drone front support: radius, enemy local garrison loss per hour, our advance ×, the enemy's advance ×. */
export const DRONE_SUPPORT_TILES = 2;
export const DRONE_GARRISON_PER_HOUR = 0.0025;
export const DRONE_ADVANCE_MUL = 1.15;
export const DRONE_ENEMY_ADVANCE_MUL = 0.85;
/** Warships: engagement and blockade radius, bombardment reach and effects, escort radius and survival bonus. */
export const WARSHIP_ENGAGE_TILES = 6;
export const WARSHIP_BOMBARD_TILES = 4;
export const BOMBARD_ATTACK_MUL = 1.15;
export const BOMBARD_GARRISON_PER_HOUR = 0.0015;
export const ESCORT_TILES = 3;
export const ESCORT_SURVIVAL = 1.5;
/** A warship hit costs 25 % integrity; a convoy sinks after 2 hits (or 1 bomber strike). */
export const WARSHIP_HIT = 0.25;
export const CONVOY_HIT = 0.5;
/** Warship idle patrol radius around its yard. */
export const WARSHIP_HOME_PATROL_TILES = 10;
/** Air raids are announced to their target 250 km out when no radar saw them first (§8.2). */
export const AIR_RAID_OBSERVER_KM = 250;

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

/**
 * v2 (§4.14, §6.3): nuclear radii in tiles (atom 75 / 175 km, H-bomb 175 / 350 km, MIRV warheads 3 / 6 tiles ×10);
 * detonations never change ownership; troopLoss is the share of the garrison killed on inner tiles (outer 25 %);
 * fallout 30 / 60 days on inner tiles (outer ×0.5).
 */
export const NUKE_DEFS: Record<WeaponType | typeof UnitType.MirvWarhead, NukeDef> = {
  [U.AtomBomb]: { innerRadius: 3, outerRadius: 7, troopLoss: 0.6, falloutTicks: 7_200, minFlightTicks: 8 },
  [U.HydrogenBomb]: { innerRadius: 7, outerRadius: 14, troopLoss: 0.6, falloutTicks: 14_400, minFlightTicks: 8 },
  [U.Mirv]: { innerRadius: 0, outerRadius: 0, troopLoss: 0, falloutTicks: 0, minFlightTicks: 8 },
  [U.MirvWarhead]: { innerRadius: 3, outerRadius: 6, troopLoss: 0.6, falloutTicks: 7_200, minFlightTicks: 2 },
  [U.CruiseMissile]: { innerRadius: 3, outerRadius: 6, troopLoss: 0.2, falloutTicks: 0, minFlightTicks: 2 },
};
/** v2 (§5.10): AI nuclear caps. */
export const AI_FIRST_NUKE_TICK = 18_000;
export const AI_NUKE_GAP_TICKS = 480;
export const AI_NUKES_IN_FLIGHT = 2;
export const AI_NUKE_PER_PLAYER_TICKS = 720;
export const AI_CRUISE_PER_PLAYER_TICKS = 120;
export const AI_CRUISE_WORLD_WINDOW = 600;
export const AI_CRUISE_WORLD_MAX = 3;
/** Population (§6.7): target per tile and per city level; the real population moves 0.2 % of the target per hour. */
export const POP_PER_TILE = 25_000;
export const POP_PER_CITY_LEVEL = 800_000;
export const POP_DRIFT_PER_HOUR = 0.002;

// --- Rendering scale helpers ---------------------------------------------------------------------
/** Camera altitude limits in km. */
export const CAMERA_MIN_ALT_KM = 0.35;
export const CAMERA_MAX_ALT_KM = 42_000;
/** Below this altitude the ground battle layer fades in (battle owner). */
export const BATTLE_LAYER_ALT_KM = 600;

// --- v2 (W3): diplomacy (DESIGN_V2 §5.1–§5.6, §2.4) --------------------------------------------------
/** Non-aggression pact length, alliance notice (§5.2). */
export const NAP_TICKS = 7_200;
export const ALLIANCE_NOTICE_TICKS = 480;
/** AI deliberation windows by proposal kind, [min, max] ticks (§5.3). */
export const DELIBERATION_TICKS = {
  trade: [40, 80], openBorders: [40, 80], nap: [60, 120], peace: [60, 180], alliance: [120, 240], callToArms: [20, 60], demand: [60, 120],
} as const;
/** How long a proposal waits in the human's inbox (§5.3); a demand waits its own deadline. */
export const INBOX_TICKS = { default: 720, peace: 1_200, callToArms: 240 } as const;
/** And never expires before it has been pending this many unpaused real milliseconds (§5.3). */
export const INBOX_MIN_REAL_MS = 60_000;
/** Ultimatum deadline by difficulty Easy..Insane (§2.4). */
export const ULTIMATUM_TICKS = [360, 240, 160, 120] as const;
/** Same proposal kind to the same receiver after a rejection (§5.3). */
export const PROPOSAL_COOLDOWN_TICKS = 240;
/** Accepting an ultimatum buys this long without war from that nation (§5.4). */
export const ULTIMATUM_PEACE_TICKS = 7_200;
/** A NAP about to end is announced this long before (§8.2 treatyExpiring). */
export const TREATY_WARNING_TICKS = 240;
/** Opinions are recomputed and published every game day (§5.1). */
export const OPINION_PERIOD_TICKS = 240;
/** Opinion bands (§5.1): hostile ≤ −50 < cold ≤ −10 < neutral < +20 ≤ cordial < +50 ≤ friendly. */
export type OpinionBand = 'hostile' | 'cold' | 'neutral' | 'cordial' | 'friendly';
export function opinionBand(v: number): OpinionBand {
  return v <= -50 ? 'hostile' : v < -10 ? 'cold' : v < 20 ? 'neutral' : v < 50 ? 'cordial' : 'friendly';
}
/** Demand limits (§5.3–§5.4): a band of at most 5 % of the receiver's land, a tribute of 20–40 % of its gold. */
export const DEMAND_BAND_SHARE = 0.05;
export const DEMAND_TRIBUTE_MIN = 0.2;
export const DEMAND_TRIBUTE_MAX = 0.4;
/** Peace terms (§4.15): a cession band ≤ 15 % of the loser's land within 4 tiles of the fronts; tribute 30 % + 20 % for 10 days. */
export const CESSION_MAX_SHARE = 0.15;
export const CESSION_DEPTH = 4;
