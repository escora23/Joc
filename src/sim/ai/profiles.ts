// FRONT ULTRA — AI personalities and difficulty profiles (owner: sim-ai). Worker-safe, pure data.
//
// A nation's behaviour is the product of two tables:
//   * PersonalityProfile (conqueror / turtle / trader / nuker / opportunist): WHAT it wants — how much it fights,
//     builds, trades, allies, betrays and nukes.
//   * DifficultyProfile (easy / normal / hard / insane): HOW WELL it plays — reaction time, how often it thinks,
//     how efficiently it spends troops and gold, how hard it focuses the human, and (insane only) small cheats.

import type { Difficulty, Personality } from '../../shared/types';

export interface PersonalityProfile {
  /** Multiplier on the will to attack players (1 = baseline). */
  aggression: number;
  /** 0..1 fraction of the troop cap kept home as a reserve (before difficulty tuning). */
  reserve: number;
  /** Extra share of available troops thrown into a player attack. */
  attackBoost: number;
  /** Weight of neutral-land expansion versus fighting (1 = baseline). */
  expansion: number;
  /** Build weights (relative desire) per structure family. */
  build: {
    city: number;
    port: number;
    factory: number;
    defense: number;
    sam: number;
    silo: number;
    airbase: number;
    armyBase: number;
    navalYard: number;
    radar: number;
  };
  /** Appetite for naval invasions (1 = baseline). */
  naval: number;
  /** 0..1 willingness to use nukes on its own initiative. */
  nukes: number;
  /** Multiplier on the earliest tick this personality goes nuclear on its own (retaliation ignores it). */
  nukeDelay: number;
  /** 0..1: resistance to betraying allies (1 = never). */
  loyalty: number;
  /** 0..1: desire to form alliances. */
  diplomacy: number;
  /** 0..1: prefers victims that are already bleeding on another front. */
  opportunism: number;
  /** 0..1: how strongly it joins coalitions against a runaway leader. */
  coalition: number;
  /** 0..1: how long grudges last and how hard it retaliates. */
  vengeance: number;
}

export const PERSONALITY: Record<Personality, PersonalityProfile> = {
  conqueror: {
    aggression: 1.35, reserve: 0.4, attackBoost: 0.12, expansion: 1.25,
    build: { city: 1.0, port: 0.6, factory: 0.6, defense: 0.25, sam: 0.5, silo: 0.6, airbase: 0.9, armyBase: 1.6, navalYard: 0.7, radar: 0.4 },
    naval: 1.3, nukes: 0.45, nukeDelay: 1.0, loyalty: 0.45, diplomacy: 0.35, opportunism: 0.35, coalition: 0.5, vengeance: 0.8,
  },
  turtle: {
    aggression: 0.6, reserve: 0.6, attackBoost: 0, expansion: 1.0,
    build: { city: 1.4, port: 0.8, factory: 1.0, defense: 1.8, sam: 1.6, silo: 0.35, airbase: 0.6, armyBase: 0.5, navalYard: 0.5, radar: 1.2 },
    naval: 0.55, nukes: 0.15, nukeDelay: 1.5, loyalty: 0.92, diplomacy: 0.85, opportunism: 0.1, coalition: 0.55, vengeance: 0.6,
  },
  trader: {
    aggression: 0.8, reserve: 0.5, attackBoost: 0.02, expansion: 1.05,
    build: { city: 1.2, port: 1.9, factory: 1.8, defense: 0.6, sam: 0.8, silo: 0.3, airbase: 0.5, armyBase: 0.5, navalYard: 1.2, radar: 0.6 },
    naval: 0.9, nukes: 0.12, nukeDelay: 1.6, loyalty: 0.85, diplomacy: 0.95, opportunism: 0.2, coalition: 0.7, vengeance: 0.4,
  },
  nuker: {
    aggression: 1.0, reserve: 0.48, attackBoost: 0.05, expansion: 1.0,
    build: { city: 1.0, port: 0.6, factory: 0.8, defense: 0.6, sam: 1.3, silo: 2.2, airbase: 0.7, armyBase: 0.6, navalYard: 0.5, radar: 0.9 },
    naval: 0.8, nukes: 1.0, nukeDelay: 0.7, loyalty: 0.6, diplomacy: 0.4, opportunism: 0.3, coalition: 0.45, vengeance: 1.0,
  },
  opportunist: {
    aggression: 1.1, reserve: 0.45, attackBoost: 0.08, expansion: 1.1,
    build: { city: 1.1, port: 1.0, factory: 0.9, defense: 0.5, sam: 0.7, silo: 0.6, airbase: 1.1, armyBase: 1.0, navalYard: 0.8, radar: 0.5 },
    naval: 1.1, nukes: 0.4, nukeDelay: 1.05, loyalty: 0.2, diplomacy: 0.65, opportunism: 1.0, coalition: 0.9, vengeance: 0.55,
  },
};

export interface DifficultyProfile {
  /** Ticks between land-war decisions (spread per nation). */
  warInterval: number;
  /** Ticks between build decisions. */
  buildInterval: number;
  /** Ticks between military (units, air, navy) decisions. */
  militaryInterval: number;
  /** Ticks between naval-invasion decisions. */
  navalInterval: number;
  /** Ticks between diplomacy passes. */
  diplomacyInterval: number;
  /** [min, max] ticks before reacting to an event (alliance request, being attacked, being nuked). */
  reaction: [number, number];
  /** 0..1: how well troops and gold are spent (low = idles too long, overshoots, forgets to build). */
  efficiency: number;
  /** Multiplier on every nation's aggression. */
  aggression: number;
  /** Added to the personality reserve (negative = leaner, more troops at the front). */
  reserveDelta: number;
  /** Multiplier on the score of the human as a target. */
  humanFocus: number;
  /** Uses counter-attacks to annihilate incoming assaults. */
  counterAttack: boolean;
  /** Earliest tick for an unprovoked nuclear strike (before personality scaling). */
  nukeTick: number;
  /** Chance per nuke decision to actually launch when everything else says yes. */
  nukeChance: number;
  /** Insane only: bonus gold per tick as a share of income, and troop trickle as a share of the cap. */
  cheatGold: number;
  cheatTroops: number;
  /** Chance of a sloppy decision (random target / skipped build). */
  sloppiness: number;
  /** Late-game gang-up threshold on the leader (land share). */
  coalitionShare: number;
  /** Ticks the human is left alone at the start (no AI offensives against the player before this). */
  humanGrace: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  easy: {
    warInterval: 42, buildInterval: 150, militaryInterval: 260, navalInterval: 900, diplomacyInterval: 420,
    reaction: [60, 140], efficiency: 0.55, aggression: 0.7, reserveDelta: 0.12, humanFocus: 0.55,
    counterAttack: false, nukeTick: 9_000, nukeChance: 0.45, cheatGold: 0, cheatTroops: 0, sloppiness: 0.25,
    coalitionShare: 0.4, humanGrace: 3600,
  },
  normal: {
    warInterval: 28, buildInterval: 100, militaryInterval: 190, navalInterval: 650, diplomacyInterval: 330,
    reaction: [30, 90], efficiency: 0.78, aggression: 0.9, reserveDelta: 0.05, humanFocus: 0.85,
    counterAttack: true, nukeTick: 8_400, nukeChance: 0.6, cheatGold: 0, cheatTroops: 0, sloppiness: 0.12,
    coalitionShare: 0.3, humanGrace: 2400,
  },
  hard: {
    warInterval: 18, buildInterval: 70, militaryInterval: 140, navalInterval: 480, diplomacyInterval: 260,
    reaction: [12, 45], efficiency: 0.93, aggression: 1.0, reserveDelta: 0, humanFocus: 1.1,
    counterAttack: true, nukeTick: 7_800, nukeChance: 0.85, cheatGold: 0, cheatTroops: 0, sloppiness: 0.04,
    coalitionShare: 0.24, humanGrace: 1500,
  },
  insane: {
    warInterval: 11, buildInterval: 45, militaryInterval: 100, navalInterval: 360, diplomacyInterval: 200,
    reaction: [4, 20], efficiency: 1, aggression: 1.15, reserveDelta: -0.04, humanFocus: 1.35,
    counterAttack: true, nukeTick: 7_200, nukeChance: 1, cheatGold: 0.18, cheatTroops: 0.0012, sloppiness: 0,
    coalitionShare: 0.2, humanGrace: 900,
  },
};

/**
 * The autopilot that plays the human in shots and playtests: a balanced, competent player (expands, builds, fights
 * the weak, answers diplomacy) that stays a top power without steamrolling the world in a few minutes.
 */
export const AUTOPILOT_PERSONALITY: PersonalityProfile = {
  ...PERSONALITY.conqueror,
  aggression: 0.95, reserve: 0.5, attackBoost: 0, expansion: 1.0, loyalty: 0.8, diplomacy: 0.6, coalition: 0.6,
};

/** Rebels fight for independence from their former masters, not for the world: stubborn, not expansionist. */
export const REBEL_PERSONALITY: PersonalityProfile = {
  ...PERSONALITY.conqueror,
  aggression: 0.85, reserve: 0.5, attackBoost: 0, expansion: 0.8, naval: 0.3, nukes: 0, coalition: 0.3,
};

/** Difficulty used by the autopilot that plays the human in shots and playtests: plays like the AI of the chosen
 *  difficulty, without cheats. */
export function autopilotDifficulty(d: Difficulty): DifficultyProfile {
  return { ...DIFFICULTY[d], humanFocus: 1, cheatGold: 0, cheatTroops: 0 };
}

/**
 * Personality mix for N nations: a balanced, shuffled deck (conquerors are the most common, nukers the rarest) so
 * every game has a few of each.
 */
export function personalityDeck(n: number, rand: () => number): Personality[] {
  const weights: [Personality, number][] = [['conqueror', 0.25], ['opportunist', 0.21], ['trader', 0.2], ['turtle', 0.18], ['nuker', 0.16]];
  const out: Personality[] = [];
  for (const [p, w] of weights) for (let i = 0; i < Math.round(w * n); i++) out.push(p);
  while (out.length < n) out.push(weights[out.length % weights.length][0]);
  out.length = n;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}
