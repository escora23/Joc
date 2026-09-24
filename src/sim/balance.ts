// FRONT ULTRA — simulation balance: every tunable number and pure formula of the strategic layer.
// Owner: sim-core. Worker-safe and main-thread-safe (pure functions, no state).
//
// The mechanics are inspired by OpenFront.io (troop economy, frontier conquest, naval invasions, nukes) but
// re-implemented from scratch and re-tuned for FRONT ULTRA's 1600x800 real-Earth grid (~25 km tiles) and its bigger
// arsenal. Units: troops are "soldiers", gold is abstract currency, time is ticks (100 ms at 1x).

import { BALANCE, UNIT_DEFS } from '../shared/constants';
import { TerrainClass, TerrainFlag, UnitType, type Difficulty, type PlayerKind } from '../shared/types';

// -------------------------------------------------------------------------------------------------
// Troops
// -------------------------------------------------------------------------------------------------

/** Start troops per player kind (nations scale with difficulty and country weight). */
export const START_TROOPS_HUMAN = BALANCE.startTroops;
export const START_TROOPS_TRIBE = 9_000;
export const START_GOLD_TRIBE = 0;

/** AI nation troop-cap multiplier by difficulty (OpenFront-like: humans are the 'hard' baseline). */
export const AI_CAP_MUL: Record<Difficulty, number> = BALANCE.difficultyAiMultiplier;
/** AI nation troop-growth multiplier by difficulty. */
export const AI_GROWTH_MUL: Record<Difficulty, number> = { easy: 0.88, normal: 0.95, hard: 1.0, insane: 1.07 };
/** AI nation gold multiplier by difficulty. */
export const AI_GOLD_MUL: Record<Difficulty, number> = { easy: 0.8, normal: 0.95, hard: 1.1, insane: 1.3 };
/** AI nation start-troop multiplier by difficulty. */
export const AI_START_MUL: Record<Difficulty, number> = { easy: 0.5, normal: 0.75, hard: 1.0, insane: 1.25 };

export function kindCapMul(kind: PlayerKind, diff: Difficulty): number {
  switch (kind) {
    case 'human': return 1;
    case 'nation': return AI_CAP_MUL[diff];
    case 'tribe': return 1 / 3;
    case 'rebel': return 0.6;
  }
}

export function kindGrowthMul(kind: PlayerKind, diff: Difficulty): number {
  switch (kind) {
    case 'human': return 1;
    case 'nation': return AI_GROWTH_MUL[diff];
    case 'tribe': return 0.5;
    case 'rebel': return 0.8;
  }
}

export function kindGoldMul(kind: PlayerKind, diff: Difficulty): number {
  switch (kind) {
    case 'human': return 1;
    case 'nation': return AI_GOLD_MUL[diff];
    case 'tribe': return 0.5;
    case 'rebel': return 0.6;
  }
}

/** Sub-linear territory term of the troop cap, plus cities and army bases (before kind multipliers). */
export function baseMaxTroops(effTiles: number, cityLevels: number, armyBaseLevels: number): number {
  const t = Math.max(0, effTiles);
  return BALANCE.troopCapBase + Math.pow(t, 0.6) * BALANCE.troopCapPerTile
    + cityLevels * BALANCE.troopCapPerCityLevel + armyBaseLevels * ARMY_BASE_CAP_PER_LEVEL;
}

export const ARMY_BASE_CAP_PER_LEVEL = 60_000;

/** Troops gained per tick (logistic toward the cap, faster with a bigger population). */
export function troopGrowthPerTick(troops: number, max: number): number {
  if (max <= 0) return 0;
  if (troops >= max) return -(troops - max) * 0.01; // over-cap troops (returns, donations) bleed off slowly
  const base = 10 + Math.pow(Math.max(0, troops), 0.73) * BALANCE.troopGrowthRate;
  return base * (1 - troops / max);
}

/** Civilian population model (cosmetic stat + nuke casualties). */
export const CIVILIANS_PER_TILE = 25_000;
export const CIVILIANS_PER_CITY_LEVEL = 800_000;

// -------------------------------------------------------------------------------------------------
// Gold
// -------------------------------------------------------------------------------------------------

/** Base "workers" income per tick for humans and nations. */
export const GOLD_BASE_PER_TICK = 100;
export const GOLD_PER_TILE_PER_TICK = BALANCE.goldPerTilePerSec / 10;
export const GOLD_PER_CITY_LEVEL_PER_TICK = BALANCE.goldPerCityPerSec / 10;
/** Share of the victim's gold the conqueror loots when capturing a capital / eliminating a nation. */
export const CAPITAL_LOOT = 0.25;
export const ELIMINATION_LOOT = 1.0;

// -------------------------------------------------------------------------------------------------
// Land combat (frontier conquest)
// -------------------------------------------------------------------------------------------------

export interface TerrainCombat {
  /** Bloodiness: drives attacker troop loss. */
  mag: number;
  /** Difficulty: drives conquest speed (higher = slower). */
  cost: number;
  /** 1 (plains), 1.5 (hills), 2 (mountains): frontier priority weight. */
  prio: number;
}

const TC = BALANCE.terrainAttackCost;
const PLAINS: TerrainCombat = { mag: 80 * TC.plains, cost: 16 * TC.plains, prio: 1 };
const HILLS: TerrainCombat = { mag: 80 * (1 + (TC.hills - 1) * 0.8), cost: 16 * TC.hills, prio: 1.5 };
const MOUNTAINS: TerrainCombat = { mag: 80 * (1 + (TC.mountains - 1) * 0.8), cost: 16 * TC.mountains, prio: 2 };

/** Fills `out` with the combat values of a land tile (terrain byte + elevation meters). */
export function terrainCombat(terrain: number, elevation: number, out: TerrainCombat): TerrainCombat {
  const c = terrain & 0x0f;
  const src = c === TerrainClass.Mountains ? MOUNTAINS : c === TerrainClass.Hills ? HILLS : PLAINS;
  let mag = src.mag, cost = src.cost;
  if (elevation > 3000) {
    // The roof of the world: Tibet, the Andes altiplano, the Pamirs are brutal to push through.
    const k = 1 + Math.min(0.5, (elevation - 3000) / 6000);
    mag *= k;
    cost *= k;
  }
  if (terrain & TerrainFlag.River) {
    // River lines are natural defensive lines.
    mag *= 1.15;
    cost *= 1.2;
  }
  out.mag = mag;
  out.cost = cost;
  out.prio = src.prio;
  return out;
}

/** Neutral-land expansion: troops lost per tile = mag / NEUTRAL_LOSS_DIV (tribes lose half as much). */
export const NEUTRAL_LOSS_DIV = 5;
export const NEUTRAL_COST_SCALE = 2000;
export const NEUTRAL_MIN_COST = 5;
export const NEUTRAL_MAX_COST = 100;

/** Player-vs-player attrition constants. */
export const ATTACK_LOSS_BASE = 0.46;
export const ATTACK_LOSS_PER_DENSITY = 0.004;
export const ATTACK_SPEED_DIV = 8.4;
/** Defenders that are tribes bleed attackers less. */
export const TRIBE_DEFENDER_LOSS_MUL = 0.7;

/** Big territories are cheaper/faster to attack from and into, so late games stay dynamic. */
export function largeTerritoryBonus(tiles: number, depth: number): number {
  const x = Math.log(Math.max(1, tiles));
  const mid = Math.log(60_000);
  const s = 1 / (1 + Math.exp(-2.5 * (x - mid)));
  return 1 - depth * s;
}

/** Traitors (broke an alliance) defend badly for a while. */
export const TRAITOR_LOSS_MUL = BALANCE.traitorDefensePenalty;
export const TRAITOR_SPEED_MUL = 0.8;

/** Defense posts: attacker losses x mag, conquest cost x speed inside the radius. */
export const DEFENSE_POST_LOSS_MUL = BALANCE.defensePostMultiplier;
export const DEFENSE_POST_SPEED_MUL = 2.2;
export function defensePostRadius(level: number): number {
  return BALANCE.defensePostRadiusTiles * (0.4 + 0.15 * (level - 1));
}

/** Fallout (nuked land) makes tiles miserable to take. */
export const FALLOUT_LOSS_MUL = 3;
export const FALLOUT_COST_MUL = 2.5;

/** Armored divisions: a deployed division within ARMOR_RADIUS of a conquered tile. */
export const ARMOR_RADIUS = 9;
export const ARMOR_ATTACK_LOSS_MUL = 0.45;
export const ARMOR_ATTACK_COST_MUL = 0.55;
/** Defending armor makes the attacker bleed. */
export const ARMOR_DEFENSE_LOSS_MUL = 1.6;
/** Division HP lost per troop the attacker loses on tiles it supports (the division absorbs part of the fight). */
export const ARMOR_WEAR_PER_TROOP = 0.0045;
/** Extra tiles a spearheading division punches through per tick. */
export const ARMOR_SPEARHEAD_TILES = 2;

/** Retreat: share of the attack that dies disengaging from a player (neutral land retreats are free). */
export const RETREAT_MALUS = 0.25;
/** Opposing attacks (A->B and B->A) annihilate each other's troops. */
export const ATTACK_MIN_TROOPS = 1;

// -------------------------------------------------------------------------------------------------
// Structures
// -------------------------------------------------------------------------------------------------

/** Minimum squared tile distance between two structures. */
export const STRUCTURE_MIN_DIST2 = 9;
/** Structure hp regeneration per tick after STRUCTURE_REPAIR_DELAY ticks without damage. */
export const STRUCTURE_REPAIR_PER_TICK = 0.0015;
export const STRUCTURE_REPAIR_DELAY = 150;
export const DEMOLISH_REFUND = 0.2;

/** Units a producing structure can host per level. */
export const ARMY_BASE_CAPACITY = 2;
export const AIRBASE_CAPACITY = 3;
export const NAVAL_YARD_CAPACITY = 2;

export function samRange(level: number, radar: boolean): number {
  const r = BALANCE.samRangeTiles * (0.6 + 0.2 * (level - 1));
  return radar ? r * 1.35 : r;
}
export const SAM_COOLDOWN_TICKS = 80;
export const SAM_INTERCEPTOR_SPEED = UNIT_DEFS[UnitType.SamInterceptor].speed;
export const RADAR_RANGE = BALANCE.radarRangeTiles;

export const SILO_COOLDOWN_TICKS = 110;
export const CRUISE_RANGE = 320;

/** Aircraft. */
export const AIRBASE_INTERCEPT_RANGE = 45;
export const AIRCRAFT_STRIKE_RANGE: Record<number, number> = {
  [UnitType.FighterSquadron]: 170,
  [UnitType.Bomber]: 220,
  [UnitType.DroneSwarm]: 140,
};
export const AIRCRAFT_FUEL_TICKS = 1200;

/** Warships. */
export const WARSHIP_TARGET_RANGE = BALANCE.warshipRangeTiles;
export const WARSHIP_FIRE_RANGE = 16;
export const WARSHIP_FIRE_COOLDOWN = 12;
export const WARSHIP_SHELL_DAMAGE = 240;
export const WARSHIP_PATROL_RADIUS = 28;
export const WARSHIP_COAST_RANGE = 12;
export const WARSHIP_COAST_COOLDOWN = 25;

/** Trade & rail. */
export const TRADE_MIN_DISTANCE = 35;
export const TRADE_SPAWN_CHANCE_PER_LEVEL = 1 / 380;
export const TRADE_MAX_PER_PORT_LEVEL = 3;
export function tradeGold(distanceTiles: number): number {
  return Math.round(BALANCE.tradeShipGoldBase + 45 * distanceTiles + 18_000 / (1 + Math.exp(-0.02 * (distanceTiles - 250))));
}
export const RAIL_MAX_LINK = 75;
export const RAIL_MAX_LINKS_PER_STATION = 4;
export const TRAIN_INTERVAL_TICKS = 130;
export function trainGold(pathTiles: number, allied: boolean): number {
  const g = 7_000 + 70 * pathTiles;
  return Math.round(allied ? g * 1.5 : g);
}

// -------------------------------------------------------------------------------------------------
// Unit prices (shared by the worker and the client so the HUD shows the exact price)
// -------------------------------------------------------------------------------------------------

/**
 * Price of a buildable or launchable unit for a player owning `owned` of that type (MIRVs: launched so far).
 * Warships and aircraft get pricier as fleets grow; missiles have flat prices except MIRVs.
 */
export function unitPrice(type: UnitType, owned: number): number {
  const base = UNIT_DEFS[type].cost;
  switch (type) {
    case UnitType.Warship: return Math.min(base * 4, base * (1 + owned));
    case UnitType.ArmoredDivision: return Math.min(base * 4, Math.round(base * (1 + 0.35 * owned)));
    case UnitType.FighterSquadron: return Math.min(base * 4, Math.round(base * (1 + 0.3 * owned)));
    case UnitType.Bomber: return Math.min(base * 4, Math.round(base * (1 + 0.35 * owned)));
    case UnitType.DroneSwarm: return Math.min(base * 3, Math.round(base * (1 + 0.15 * owned)));
    case UnitType.Mirv: return base + owned * 10_000_000;
    default: return base;
  }
}

// -------------------------------------------------------------------------------------------------
// Nukes
// -------------------------------------------------------------------------------------------------

export const MIRV_WARHEADS = 18;
export const MIRV_SPLIT_T = 0.62;
export const MIRV_SPREAD = 110;
export const INTERCEPT_WEAPON_MUL: Record<number, number> = {
  [UnitType.AtomBomb]: 1,
  [UnitType.HydrogenBomb]: 0.85,
  [UnitType.Mirv]: 0.6,
  [UnitType.MirvWarhead]: 0.7,
  [UnitType.CruiseMissile]: 0.65,
  [UnitType.Bomber]: 0.6,
  [UnitType.DroneSwarm]: 0.55,
  [UnitType.FighterSquadron]: 0.35,
};
/** Ballistic weapons can only be engaged in the terminal part of their flight. */
export const TERMINAL_PHASE_T = 0.5;
/** Alliance breaks if a nuke hits more than this many (weighted) tiles of an ally. */
export const NUKE_ALLY_BREAK_TILES = 60;

// -------------------------------------------------------------------------------------------------
// Diplomacy & misc
// -------------------------------------------------------------------------------------------------

export const ALLIANCE_REQUEST_COOLDOWN = 300;
export const DONATE_COOLDOWN = 100;
export const EMOTE_COOLDOWN = 40;
/** Being attacked by someone embargoes them automatically for this long (trade stops). */
export const AUTO_EMBARGO_TICKS = 3_000;
/** Pairs that fought within this many ticks count as "at war" (warships shell each other's coasts). */
export const HOSTILITY_TICKS = 900;
export const MAX_BOATS = 3;
export const SPAWN_COUNTDOWN_TICKS = 50;
export const MIN_SPAWN_DIST = 7;
