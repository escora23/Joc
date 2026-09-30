// FRONT ULTRA — structure and city damage (owner feedback #27, DESIGN_V2 "Feedback 3" §F3.1). Worker-safe, no DOM.
//
// One rule set for the simulation, the cards, the 3D models and command mode, so every layer shows the same thing:
//
//   hp (0..1) → damage state        intact ≥ 0.75 · damaged ≥ 0.40 · heavily damaged > 0 · destroyed (rubble)
//   damage state → function         100 % · 60 % · 25 % · 0 %   (income, troop cap, population, ranges, hit chance,
//                                    repair rates, production speed, trade ships and trains all scale with it)
//   hp reaching 0                   a structure above level 1 loses ONE level and stands heavily damaged at 0.30;
//                                    at level 1 it is destroyed and leaves rubble (a ruin) on its tile
//   repair                          paid in gold up front (repairCost), +8 % hp per game hour, paused for 2 h after
//                                    any new hit; no free self-repair
//   city hits                       civilians and garrison troops killed in proportion to the damage and the level
//   civilian targets (cities)       diplomatic cost: opinion, escalation to L2, a casus belli for the victim and its
//                                    allies; the order card warns before the strike is confirmed
//
// City blocks: a city is drawn (strategic model and command mode alike) as CITY_BLOCKS blocks. collapsedBlocks() says
// which ones stand in ruins: the blocks command mode reported destroyed (StructureView.blocks, a bitmask) plus a
// deterministic share that follows the damage state, so both layers collapse the same blocks.

import { upgradeCost } from './constants';
import { StructureType } from './types';

export const DamageState = { Intact: 0, Damaged: 1, Heavy: 2, Destroyed: 3 } as const;
export type DamageState = (typeof DamageState)[keyof typeof DamageState];
export const DAMAGE_IDS = ['intact', 'damaged', 'heavy', 'destroyed'] as const;

/** hp thresholds of the states. */
export const DAMAGED_BELOW = 0.75;
export const HEAVY_BELOW = 0.4;
/** Function (share of every effect) per state. */
export const DAMAGE_FUNCTION = [1, 0.6, 0.25, 0] as const;
/** hp a structure keeps after losing a level instead of being destroyed. */
export const LEVEL_LOSS_HP = 0.3;
/** Repair: hp per game hour, per tick, and the pause after a hit (ticks). */
export const REPAIR_PER_HOUR = 0.08;
export const REPAIR_PER_TICK = REPAIR_PER_HOUR / 10;
export const REPAIR_PAUSE_TICKS = 20;
/** Repair price: this share of the structure's upgrade cost at its level for a full (1.0 hp) repair. */
export const REPAIR_COST_SHARE = 0.5;
/** Rubble stays on the map this long (30 game days) unless something is built there. */
export const RUIN_TICKS = 7_200;
/** Rebuilding the same type on its own rubble costs this share of the normal price. */
export const REBUILD_DISCOUNT = 0.5;
/** A captured structure is taken in the fighting: it changes owner with at most this hp. */
export const CAPTURE_MAX_HP = 0.6;

/** City hits (per 1.0 hp of damage and per city level): civilians killed, and the owner's troops killed (share, cap). */
export const CITY_CIVILIANS_PER_HP_LEVEL = 30_000;
export const CITY_TROOPS_SHARE_PER_HP = 0.01;
export const CITY_TROOPS_CAP_PER_LEVEL = 6_000;

/** Diplomatic cost of striking a city (DiplomacySystem REMEMBERED keys civilianStrike / bombedCities / bombedAlly). */
export const CIVILIAN_OPINION_VICTIM = -20;
export const CIVILIAN_OPINION_ALLY = -12;
export const CIVILIAN_OPINION_WORLD = -5;
/** A casus belli lasts this long (ticks, 30 game days): a war declared on the striker then counts as provoked. */
export const CASUS_BELLI_TICKS = 7_200;

export const CITY_BLOCKS = 16;

export function damageState(hp: number, exists = true): DamageState {
  if (!exists || hp <= 0) return DamageState.Destroyed;
  if (hp >= DAMAGED_BELOW) return DamageState.Intact;
  if (hp >= HEAVY_BELOW) return DamageState.Damaged;
  return DamageState.Heavy;
}

/** Share of its effects a structure delivers at `hp` (1 / 0.6 / 0.25 / 0). */
export function functionFactor(hp: number): number {
  return DAMAGE_FUNCTION[damageState(hp)];
}

/** Gold to repair a structure from `hp` to 1. */
export function repairCost(type: StructureType, level: number, hp: number): number {
  const missing = Math.max(0, Math.min(1, 1 - hp));
  return Math.round(upgradeCost(type, Math.max(1, level)) * REPAIR_COST_SHARE * missing / 100) * 100;
}

/** Game hours a repair from `hp` to 1 takes (without new hits). */
export function repairHours(hp: number): number {
  return Math.max(0, 1 - hp) / REPAIR_PER_HOUR;
}

/** Civilian targets: cities (ports and factories are strategic, not civilian). */
export function isCivilian(type: StructureType): boolean {
  return type === StructureType.City;
}

/** Civilians killed by `dmg` hp on a city of `level`. */
export function cityCivilianLoss(level: number, dmg: number): number {
  return Math.round(Math.max(0, dmg) * Math.max(1, level) * CITY_CIVILIANS_PER_HP_LEVEL);
}

/** Troops of the owner killed by `dmg` hp on a city of `level` (the city's garrison and those sheltering there). */
export function cityTroopLoss(level: number, dmg: number, ownerTroops: number): number {
  return Math.round(Math.min(ownerTroops * CITY_TROOPS_SHARE_PER_HP * Math.max(0, dmg), CITY_TROOPS_CAP_PER_LEVEL * Math.max(1, level) * Math.max(0, dmg)));
}

/** Stable pseudo-random order of the CITY_BLOCKS blocks of structure `id` (which ones fall first). */
function blockOrder(id: number): number[] {
  const out = Array.from({ length: CITY_BLOCKS }, (_, i) => i);
  let s = (id * 2654435761) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Blocks down per state (of CITY_BLOCKS): intact 0, damaged 3, heavily damaged 8, destroyed all. */
const BLOCKS_DOWN = [0, 3, 8, CITY_BLOCKS];

/**
 * Bitmask of the collapsed blocks of a structure: the ones command mode destroyed (`reported`) plus the first ones of
 * its stable order for its damage state. The strategic model and the command-mode city read the same mask.
 */
export function collapsedBlocks(id: number, hp: number, reported = 0): number {
  const n = BLOCKS_DOWN[damageState(hp)];
  let mask = reported >>> 0;
  if (n >= CITY_BLOCKS) return (1 << CITY_BLOCKS) - 1;
  const order = blockOrder(id);
  for (let i = 0; i < n; i++) mask |= 1 << order[i];
  return mask & ((1 << CITY_BLOCKS) - 1);
}

/** Share of the model still standing (partial collapse drawn on the 3D model): 1, 0.85, 0.6, 0 (rubble). */
export function standingShare(hp: number): number {
  return [1, 0.85, 0.6, 0][damageState(hp)];
}

/** Rebuild price on one's own rubble of the same type (normal price × REBUILD_DISCOUNT). */
export function rebuildCost(normalCost: number): number {
  return Math.round(normalCost * REBUILD_DISCOUNT);
}

