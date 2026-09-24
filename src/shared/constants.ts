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
export const RELIEF_EXAGGERATION = 12;
/** Topology texture: gray 255 == this many meters (linear). */
export const TOPO_MAX_METERS = 8848;
/** Tiles south of this latitude that are land become TerrainClass.Ice (unplayable). */
export const ICE_LATITUDE = -60;

// --- Time ------------------------------------------------------------------------------------
export const TICK_MS = 100;
export const TICKS_PER_SECOND = 1000 / TICK_MS;
/** The worker posts one coalesced update per this many wall-clock ms (regardless of speed). */
export const UPDATE_INTERVAL_MS = 100;
/** Game seconds for a full day/night cycle (sun circles the planet). */
export const DAY_LENGTH_SEC = 720;
/** Latitude of the subsolar point (constant "season"). */
export const SUBSOLAR_LAT_DEG = 12;
/** worldTime seconds per real second on the menu (slow sun drift). */
export const MENU_WORLD_TIME_SCALE = 0.5;
/** Default world time for a new game: subsolar longitude 20°E -> daylight over Europe/Africa. */
export const DEFAULT_START_WORLD_TIME = (-20 / 360) * DAY_LENGTH_SEC;

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
  startTroops: 2500,
  startGold: 150_000,
  /** Troop cap = base + perTile * tiles + perCity * cityLevels. */
  troopCapBase: 5_000,
  troopCapPerTile: 60,
  troopCapPerCityLevel: 250_000,
  /** Logistic growth rate per second at 1x (relative to cap). */
  troopGrowthRate: 0.035,
  goldPerTilePerSec: 0.9,
  goldPerCityPerSec: 90,
  goldPerFactoryPerSec: 160,
  tradeShipGoldBase: 12_000,
  /** Attack cost multipliers per TerrainClass (Plains, Hills, Mountains). */
  terrainAttackCost: { plains: 1.0, hills: 1.5, mountains: 2.2 } as Record<'plains' | 'hills' | 'mountains', number>,
  defensePostMultiplier: 2.5,
  defensePostRadiusTiles: 30,
  traitorDurationTicks: 3_000,
  traitorDefensePenalty: 0.5,
  allianceDurationTicks: 6_000,
  allianceRequestTimeoutTicks: 200,
  embargoTradePenalty: 1,
  boatSpeedTilesPerTick: 1.2,
  warshipRangeTiles: 60,
  samRangeTiles: 70,
  samInterceptChance: 0.75,
  radarRangeTiles: 180,
  difficultyAiMultiplier: { easy: 0.7, normal: 1.0, hard: 1.3, insane: 1.7 } as Record<'easy' | 'normal' | 'hard' | 'insane', number>,
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
  /** Movement in tiles per tick at 1x (surface or cruise). */
  speed: number;
  maxHp: number;
  /** True for units that fly (aircraft & missiles): renderers place them at altitude. */
  airborne: boolean;
  /** Command-mode kind when the player can take control of it. */
  command: 'tank' | 'jet' | 'ship' | null;
}

const U = UnitType;
const S = StructureType;
export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  [U.TransportShip]: { type: U.TransportShip, id: 'transportShip', cost: 0, producedBy: -1, speed: 1.2, maxHp: 1, airborne: false, command: null },
  [U.TradeShip]: { type: U.TradeShip, id: 'tradeShip', cost: 0, producedBy: S.Port, speed: 1.0, maxHp: 1, airborne: false, command: null },
  [U.Warship]: { type: U.Warship, id: 'warship', cost: 250_000, producedBy: S.NavalYard, speed: 0.9, maxHp: 1000, airborne: false, command: 'ship' },
  [U.ArmoredDivision]: { type: U.ArmoredDivision, id: 'armoredDivision', cost: 150_000, producedBy: S.ArmyBase, speed: 0.35, maxHp: 800, airborne: false, command: 'tank' },
  [U.FighterSquadron]: { type: U.FighterSquadron, id: 'fighterSquadron', cost: 200_000, producedBy: S.Airbase, speed: 3.0, maxHp: 400, airborne: true, command: 'jet' },
  [U.Bomber]: { type: U.Bomber, id: 'bomber', cost: 350_000, producedBy: S.Airbase, speed: 2.2, maxHp: 600, airborne: true, command: null },
  [U.DroneSwarm]: { type: U.DroneSwarm, id: 'droneSwarm', cost: 120_000, producedBy: S.Airbase, speed: 2.0, maxHp: 200, airborne: true, command: null },
  [U.CruiseMissile]: { type: U.CruiseMissile, id: 'cruiseMissile', cost: 300_000, producedBy: S.MissileSilo, speed: 4.0, maxHp: 1, airborne: true, command: null },
  [U.AtomBomb]: { type: U.AtomBomb, id: 'atomBomb', cost: 750_000, producedBy: S.MissileSilo, speed: 3.0, maxHp: 1, airborne: true, command: null },
  [U.HydrogenBomb]: { type: U.HydrogenBomb, id: 'hydrogenBomb', cost: 5_000_000, producedBy: S.MissileSilo, speed: 3.0, maxHp: 1, airborne: true, command: null },
  [U.Mirv]: { type: U.Mirv, id: 'mirv', cost: 25_000_000, producedBy: S.MissileSilo, speed: 3.0, maxHp: 1, airborne: true, command: null },
  [U.MirvWarhead]: { type: U.MirvWarhead, id: 'mirvWarhead', cost: 0, producedBy: -1, speed: 3.5, maxHp: 1, airborne: true, command: null },
  [U.SamInterceptor]: { type: U.SamInterceptor, id: 'samInterceptor', cost: 0, producedBy: S.SamSite, speed: 6.0, maxHp: 1, airborne: true, command: null },
  [U.Train]: { type: U.Train, id: 'train', cost: 0, producedBy: S.Factory, speed: 1.5, maxHp: 1, airborne: false, command: null },
  [U.Shell]: { type: U.Shell, id: 'shell', cost: 0, producedBy: -1, speed: 8.0, maxHp: 1, airborne: true, command: null },
};

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
  [U.AtomBomb]: { innerRadius: 12, outerRadius: 30, troopLoss: 0.6, falloutTicks: 1_800, minFlightTicks: 60 },
  [U.HydrogenBomb]: { innerRadius: 80, outerRadius: 100, troopLoss: 0.85, falloutTicks: 3_600, minFlightTicks: 80 },
  [U.Mirv]: { innerRadius: 0, outerRadius: 0, troopLoss: 0, falloutTicks: 0, minFlightTicks: 90 },
  [U.MirvWarhead]: { innerRadius: 12, outerRadius: 18, troopLoss: 0.6, falloutTicks: 1_800, minFlightTicks: 20 },
  [U.CruiseMissile]: { innerRadius: 3, outerRadius: 6, troopLoss: 0.2, falloutTicks: 0, minFlightTicks: 20 },
};

// --- Rendering scale helpers ---------------------------------------------------------------------
/** Camera altitude limits in km. */
export const CAMERA_MIN_ALT_KM = 0.35;
export const CAMERA_MAX_ALT_KM = 42_000;
/** Below this altitude the ground battle layer fades in (battle owner). */
export const BATTLE_LAYER_ALT_KM = 600;
