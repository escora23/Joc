// FRONT ULTRA — AI state: per-nation brains and the shared world model (owner: sim-ai). Worker-only.
//
// Everything the AI remembers lives here (and in SimPlayer.aiMemory, which points at the brain): relations and
// grudges, the current war target, cached front analysis, pending reactions, plus a global "world model" shared
// by every brain (who betrayed whom, who nuked whom, who is running away with the game).

import type { Personality, WarGoal } from '../../shared/types';
import type { DifficultyProfile, PersonalityProfile } from './profiles';

/** How a brain feels about another player. */
export interface Relation {
  /** -1 (mortal enemy) .. +1 (trusted friend). */
  trust: number;
  /** Last tick they attacked us (land, sea or air). */
  attackedTick: number;
  /** Last tick they nuked us. */
  nukedTick: number;
  /** Accumulated grievance (decays). */
  grievance: number;
  /** They betrayed us personally. */
  betrayedUs: boolean;
  /** Last tick we fought a common enemy. */
  sharedEnemyTick: number;
  /** Last tick we (as their ally) helped them / they helped us. */
  helpedTick: number;
  /** Alliance formed at this tick (for betrayal timing). */
  alliedTick: number;
  /** Nuclear weapons we launched at them. */
  nukesSent: number;
  /** v2 (§5.10): nuclear weapons they launched at us (retaliation is one for one). */
  nukesReceived: number;
}

/** Per-neighbour front analysis (refreshed every few seconds). */
export interface FrontInfo {
  /** Neighbour id -> number of our border tiles touching them. */
  contact: Map<number, number>;
  /** Neighbour id -> one of THEIR tiles on the front (aim point for attacks, armor, strikes). */
  aim: Map<number, number>;
  /** Neighbour id -> one of OUR tiles on the front (defense posts). */
  ours: Map<number, number>;
  /** Our border tiles on the coast (sampled). */
  shoreSample: number[];
  /** Total border tiles scanned. */
  scanned: number;
  tick: number;
}

export interface PendingAction {
  at: number;
  kind: 'reply' | 'emote' | 'renew' | 'helpAlly' | 'sam';
  other: number;
  flag: boolean;
  data: string;
}

export interface Brain {
  id: number;
  kind: 'nation' | 'tribe' | 'rebel' | 'autopilot';
  personality: Personality;
  prof: PersonalityProfile;
  diff: DifficultyProfile;
  /** Next tick for each decision loop. */
  nextWar: number;
  nextBuild: number;
  nextMilitary: number;
  nextNaval: number;
  nextNuke: number;
  nextDiplomacy: number;
  /** Main war target (0 = none) and since when. */
  enemy: number;
  enemySince: number;
  /** Player that nuked/betrayed us and must pay (0 = none), until tick. */
  retaliate: number;
  retaliateUntil: number;
  /** Rebels: the nation they broke away from. */
  parent: number;
  relations: Map<number, Relation>;
  front: FrontInfo;
  pending: PendingAction[];
  /** Tiles at the last war decision and ticks without progress (anti-stagnation). */
  lastTiles: number;
  idleTicks: number;
  /** Gold-rush region we covet (tile, until tick). */
  rushTile: number;
  rushUntil: number;
  /** Nation marked as target by an ally ("help me against X"), until tick. */
  allyTarget: number;
  allyTargetUntil: number;
  /** Structures we already failed to place this pass (avoid hammering). */
  buildFails: number;
  /** Ticks when we last launched: a boat, a nuke. */
  lastBoatTick: number;
  lastNukeTick: number;
  nukesLaunched: number;
  /** Already taunted the runaway leader (coalition). */
  coalitionAnnounced: boolean;
  /** A tile we own (capital, else the last known one): anchor for building and sailing. */
  homeTile: number;
  homeCheckTick: number;
  /** Per-brain scratch to avoid allocations. */
  scratch: number[];
  // --- v2 (W1): the war pipeline (warplan.ts) ---
  /** Tension stated toward a target; the declaration follows after the tension lead (§5.7 step 3). */
  tension: { target: number; goal: WarGoal; reasonKey: string; tick: number } | null;
  lastDeclareTick: number;
  /** War id -> next war-plan tick. */
  plans: Map<number, number>;
  nextPeace: number;
  /** Enemy -> last tick it launched a nuclear weapon at one of our allies (retaliation, §5.10). */
  allyNukedBy: Map<number, number>;
  /** Enemy -> no new offensive on it before this tick (after a retreat or a broken offensive, §4.9). */
  offCooldown: Map<number, number>;
  /** Island index -> no settler convoy to it before this tick (unreachable or just tried, T39). */
  settleFail: Map<number, number>;
  /** Settler convoys under way: attack id -> island index. */
  settling: Map<number, number>;
  /** Enemy -> measured defence / estimated garrison (divisions, posts, modifiers the estimate cannot see), EMA. */
  intel: Map<number, number>;
  /** Last tick this staff opened a new land offensive (tempo, §5.7 step 6). */
  lastOffensiveTick: number;
  /** War id -> last tick we had an offensive running in it (a war with none for long is a failed war). */
  warActive: Map<number, number>;
}

export function emptyFront(): FrontInfo {
  return { contact: new Map(), aim: new Map(), ours: new Map(), shoreSample: [], scanned: 0, tick: -1_000_000 };
}

export function newRelation(): Relation {
  return {
    trust: 0, attackedTick: -1_000_000, nukedTick: -1_000_000, grievance: 0, betrayedUs: false,
    sharedEnemyTick: -1_000_000, helpedTick: -1_000_000, alliedTick: -1_000_000, nukesSent: 0, nukesReceived: 0,
  };
}

/** Global knowledge shared by all brains. */
export interface WorldModel {
  /** Player -> number of alliances they broke. */
  betrayals: Map<number, number>;
  /** Player -> nukes launched. */
  nukesBy: Map<number, number>;
  /** Total detonations so far (drives nuclear escalation). */
  detonations: number;
  /** Runaway leader (0 = nobody) and its land share. */
  leader: number;
  leaderShare: number;
  secondShare: number;
  /** Tick the leader analysis was refreshed. */
  leaderTick: number;
  /** Players currently at war with each other: pairKey -> last tick of hostilities. */
  wars: Map<number, number>;
  /** Doomsday level seen in the last 'doomsday' event (0..1). */
  doomsday: number;
  /** Active gold rush: tile and until. */
  rushTile: number;
  rushUntil: number;
  /** Players infected by a pandemic (quarantine embargoes), until tick. */
  infected: Map<number, number>;
  /** v2 (W1): tick of the last AI declaration worldwide (§5.7 step 7). */
  lastAiWarTick: number;
  /** v2 (§5.10): AI nuclear first uses (not retaliation) so far this game; the nuclear taboo allows only a few. */
  firstUses: number;
  /** v2 (§5.1 `unprovokedWar`): player -> last tick it declared a war on someone who was not hostile to it. */
  unprovoked: Map<number, number>;
}

export function pairKey(a: number, b: number): number {
  return a < b ? a * 4096 + b : b * 4096 + a;
}
