// FRONT ULTRA — the AI war pipeline (DESIGN_V2 §5.7, steps 1–2 and 5–8; owner: sim-ai, built by W1). Worker-only.
//
//   1. Candidates every war clock: bordering players scored by scoreTarget, filtered by the nation's real OPINION of
//      them (the §5.1 reasons of the diplomacy system): < −30 required, unless a conqueror faces a neighbour at ≤ 0.5×
//      its strength (and the other exceptions below).
//   2. A goal and a reason key (retaliation, coalition, conquest, tribute, border).
//   3–4. prepareWar (W3): a public `tension` through the diplomacy system, then, after the tension lead of §2.4 (Easy
//      480, Normal 240, Hard/Insane 120), an ULTIMATUM with probability by personality (§5.4) or the declaration. An
//      accepted ultimatum ends the matter; a refusal leads to war with probability by personality; an ultimatum left
//      to expire is not a refusal, and the declaration follows as planned.
//   5. The declaration carries the first offensive, which starts by itself when the mobilization ends.
//   6. War plans every 120 ticks: front priorities (alta where the enemy attacks), offensives topped up to the commit
//      ratio and re-aimed at the enemy capital or its largest region; naval landings when there is no land front.
//   7. Limits: 2 offensive wars for conquerors, opportunists and great powers (§4.18), 1 for the rest; 1 declaration per AI per 720 ticks; no
//      declaration above exhaustion 50; worldwide 1 new AI war per 120 ticks before tick 18,000, per 60 after.
//   8. Peace every 240 ticks: sue for peace at exhaustion ≥ 45 and war score ≤ 0; the other side accepts a white peace at
//      exhaustion ≥ 35 or when its goal is met, but a winner (score ≥ 40, exhaustion < 70) demands a cession (or a
//      tribute at ≥ 25); a `conquest` goal is met only by capitulation (WarSystem).

import {
  AI_MOBILIZE_TICKS, DIFFICULTY_INDEX, FRONTAGE_MAX, FRONTAGE_MIN, HUMAN_GRACE_TICKS, HUMAN_ID, MAP_W, TENSION_LEAD_TICKS, TROOPS_PER_FRONT_TILE,
} from '../../shared/constants';
import type { SimPlayer, SimWar } from '../../shared/simapi';
import { UnitType, type PeaceTerms, type WarGoal } from '../../shared/types';
import { alive, relation, strength, type AiContext } from './context';
import { REFUSAL_WAR_ODDS, ULTIMATUM_ODDS, ultimatumDemand } from './diplomacy';
import type { Brain } from './state';
import { scoreTarget } from './war';
import { reachOf } from './naval';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** War-plan and peace cadences (ticks). */
const PLAN_EVERY = 120;
const PEACE_EVERY = 240;
const DECLARE_GAP = 1200;

/**
 * Offensive discipline (§4.4–§4.9). A staff launches an offensive only with the odds that make it advance and bleed the
 * enemy faster than itself (§4.6: from R ≈ 1.7 the attacker's advantage grows), tops it up while it holds, and pulls
 * it back when it stalls and cannot be fed, instead of throwing troops at a wall and relaunching every few hours.
 */
export const LAUNCH_RATIO = 1.7;
/**
 * A grinding war (§4.6: R 1–1.7, "divisions, drones, terrain and front priority decide it") is accepted only by a
 * coalition against the runaway leader (§4.18: the world gets its chance to stop it). Everyone else waits for the odds
 * of LAUNCH_RATIO.
 */
export const GRIND_RATIO = 1.3;

/** The ratio `p` needs to open an offensive against `q` as the aggressor. */
export function aggressorRatio(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer): number {
  const w = ctx.world;
  if (w.leader === q.id && w.leaderShare > b.diff.coalitionShare) return GRIND_RATIO;
  // Great-power rivalry (§4.18): between two great powers the stronger accepts a grinding war; nothing else decides
  // a world of a few continental empires.
  return rivals(ctx, b, p, q) ? GRIND_RATIO : LAUNCH_RATIO;
}

/** Attack power the staff can count on from its own armored divisions (+25 % each at the front, at most ×2, §4.4). */
function armorPlan(ctx: AiContext, p: SimPlayer): number {
  return 1 + 0.25 * Math.min(4, ctx.g.units(p.id, UnitType.ArmoredDivision).length);
}

/** Could `p` open a winning offensive on `q` with a third of its home troops (with its divisions)? */
function isPrey(ctx: AiContext, p: SimPlayer, q: SimPlayer, contact: number): boolean {
  return neededShare(p, enemyGarrison(ctx, p, q, contact), LAUNCH_RATIO, armorPlan(ctx, p)) <= PREY_SHARE;
}
const PREY_SHARE = 0.33;

/** Troops of `q`'s allies expected to join a war `p` declares on it (§5.5 answer odds × their home troops). */
function expectedAllies(ctx: AiContext, p: SimPlayer, q: SimPlayer): number {
  const g = ctx.g;
  let sum = 0;
  for (const a of q.allies) {
    const A = g.player(a);
    if (!alive(A) || A.id === p.id || p.allies.has(a)) continue;
    const loyalty = ctx.brains.get(a)?.prof.loyalty ?? 0.5;
    const close = g.sharesBorder(p.id, a) || g.units(a, UnitType.Warship).length > 0;
    sum += A.troops * ((close ? 0.5 : 0.3) + 0.5 * loyalty);
  }
  return sum;
}

/** Scale of the betrayal roll per decision cycle (§5.6): conqueror 1 − 0.45 → 0.55 % per war clock, turtle 0.08 %. */
const BETRAYAL_ROLL = 0.01;

/** Betrayal needs a large gain: never an ally that is also allied to one of our other allies (§5.6). */
function betrayalBlocked(ctx: AiContext, p: SimPlayer, q: SimPlayer): boolean {
  for (const a of q.allies) if (a !== p.id && p.allies.has(a)) return true;
  return q.id === HUMAN_ID && ctx.g.tick < 18_000;
}

/** A defender counter-attacks only with a clear edge: its troops also hold the line. */
export const COUNTER_RATIO = 2.1;
/** A running offensive below this ratio is topped up to TOPUP_RATIO, or pulled back when that is not affordable. */
const HOLD_RATIO = 1.15;
const TOPUP_RATIO = 1.6;
/** No new offensive on the same enemy for this long after pulling one back (the staff regroups). */
export const OFFENSIVE_COOLDOWN = 600;
/** Enemies at least this large (tiles) are worth a second corridor on another front (§4.18: two corridors). */
const SECOND_CORRIDOR_TILES = 4000;

/**
 * Troops for a corridor as wide as the enemy is worth (§4.3): about 1.5 × √(its tiles) tiles, 3 to 40, at
 * TROOPS_PER_FRONT_TILE each. A small pocket needs a narrow corridor; a large nation is conquered on a broad front.
 */
function usefulWidthTroops(q: SimPlayer): number {
  return clamp(1.5 * Math.sqrt(q.tiles), FRONTAGE_MIN, FRONTAGE_MAX) * TROOPS_PER_FRONT_TILE;
}

/** A staff opens at most one new offensive (land or landing) per this many ticks, over all its wars (planning capacity: one operation per 2.5 days). */
const OFFENSIVE_TEMPO = 600;
/** An aggressor's war with no offensive for this long after mobilization, and nothing gained, is abandoned. */
const FAILED_WAR_TICKS = 1800;
/** Home troops an offensive may take at most (the rest garrisons the other fronts and the land). */
const MAX_COMMIT = 0.75;

/**
 * The garrison `q` holds (or would hold) against `p` (§4.4 `Gf`): the strongest of their current fronts at war, else
 * the share q would give a new front of `contact` tiles next to the fronts it already fights on.
 */
export function enemyGarrison(ctx: AiContext, p: SimPlayer, q: SimPlayer, contact: number): number {
  return rawGarrison(ctx, p, q, contact) * (ctx.brains.get(p.id)?.intel.get(q.id) ?? 1);
}

function rawGarrison(ctx: AiContext, p: SimPlayer, q: SimPlayer, contact: number): number {
  const g = ctx.g;
  const fronts = g.fronts.frontsOfPair(p.id, q.id);
  if (fronts.length) {
    let best = 0;
    for (const f of fronts) best = Math.max(best, g.fronts.garrison(f, q.id));
    return best;
  }
  let other = 0;
  for (const f of g.fronts.frontsOf(q.id)) {
    const hit = f.offensive[f.a === q.id ? 1 : 0] !== 0;
    other += f.length * (hit ? 2 : 1);
  }
  return q.troops * 0.85 * Math.max(1, contact) / Math.max(1, Math.max(1, contact) + other);
}

/**
 * The force ratio a staff sizes its offensives for: better staffs (difficulty `efficiency`, §5.9) mass more for a faster
 * decision; every one stays above the launch odds. Easy 1.8, Normal 2.3, Hard 2.6, Insane 2.7.
 */
export function targetRatio(ctx: AiContext, b: Brain, q: SimPlayer): number {
  // Protecting the human (§4.16): the AI never brings overwhelming force against the human, whatever the difficulty;
  // it fights at the launch odds, so a war on the human is a contest, not an execution (the warning times of T7b hold:
  // difficulty already shortens the grace, the tension lead and the mobilization).
  if (restrained(ctx, b, q)) return LAUNCH_RATIO;
  return LAUNCH_RATIO + 2 * (b.diff.efficiency - 0.5);
}

/** Restraint against the human (see targetRatio): no extra width or ratio beyond the launch odds. */
function restrained(_ctx: AiContext, b: Brain, q: SimPlayer): boolean {
  return q.id === HUMAN_ID && b.kind !== 'autopilot';
}

/** Share of home troops `p` must commit for an offensive at `ratio` against a garrison `G` (> MAX_COMMIT = cannot). */
function neededShare(p: SimPlayer, G: number, ratio: number, armor = 1): number {
  return (ratio * Math.max(1, G)) / Math.max(1, p.troops * armor);
}

/**
 * Opinion bands of §5.1 as the war pipeline reads them. On the diplomacy system's scale a long shared border alone is
 * −10 (the top of the *Fría* band), a trade agreement +15 and a non-aggression pact +10, so ordinary neighbours sit
 * between −20 and +10. Grievance wars still need a hostile opinion (< −30); ambition reads the bands: an opportunist
 * or a predator strikes a COLD neighbour (≤ −10), and a great power (§4.18) any neighbour below CORDIAL (+20) that no
 * treaty protects: commerce does not stop an empire, a signed pact does (partners are handled as betrayals).
 */
const COLD = -10;
const CORDIAL = 20;

/** `p`'s opinion of `q` (§5.1, the diplomacy system's reasons). */
function opinionOf(ctx: AiContext, p: SimPlayer, q: SimPlayer): number {
  return ctx.g.diplomacy.opinion(p.id, q.id);
}

/** Offensive wars `p` wages (it declared them; wars joined by a call to arms and defensive wars do not count). */
function offensiveWars(ctx: AiContext, p: SimPlayer): number {
  let n = 0;
  for (const w of ctx.g.war.warsOf(p.id)) if (w.a === p.id && !w.joined && w.goal !== 'liberation') n++;
  return n;
}

/**
 * A great power (§4.18 convergence): a nation holding ≥ GREAT_POWER_SHARE of the world's land. Whatever its temperament
 * (turtles excepted) it now thinks like an empire: it may wage two offensive wars, it presses its won wars toward the
 * enemy's capitulation instead of settling for a tribute, and it bandwagons on a rival already bleeding on another front.
 */
export const GREAT_POWER_SHARE = 0.05;
export function greatPower(ctx: AiContext, b: Brain, p: SimPlayer): boolean {
  return b.personality !== 'turtle' && p.kind === 'nation' && p.tiles >= ctx.g.world.landTiles * GREAT_POWER_SHARE;
}

/**
 * Two great powers where `p` is at least as strong as `q` (§4.18 rivalry): the world's last powers do not share it in
 * peace. Never the human before tick 18,000 (§4.16).
 */
export function rivals(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer): boolean {
  if (q.id === HUMAN_ID && ctx.g.tick < 18_000) return false;
  if (q.kind !== 'nation' && q.kind !== 'human') return false;
  return greatPower(ctx, b, p) && q.tiles >= ctx.g.world.landTiles * GREAT_POWER_SHARE && strength(q) <= strength(p);
}

function maxOffensiveWars(ctx: AiContext, b: Brain, p: SimPlayer): number {
  return b.personality === 'conqueror' || b.personality === 'opportunist' || greatPower(ctx, b, p) ? 2 : 1;
}

/** May `p` declare a new war now (limits of §5.7 step 7)? */
function mayDeclare(ctx: AiContext, b: Brain, p: SimPlayer): boolean {
  const g = ctx.g;
  if (g.tick - b.lastDeclareTick < DECLARE_GAP) return false;
  // The declaration's queued offensive is the staff's next operation: it must fit the tempo.
  if (g.tick + AI_MOBILIZE_TICKS[DIFFICULTY_INDEX[g.difficulty]] - b.lastOffensiveTick < OFFENSIVE_TEMPO) return false;
  if (g.war.exhaustion(p.id) > 50) return false;
  if (offensiveWars(ctx, p) >= maxOffensiveWars(ctx, b, p)) return false;
  const gap = g.tick < 18_000 ? 480 : 360;
  if (g.tick - ctx.world.lastAiWarTick < gap) return false;
  return true;
}

/** Goal and reason key of a war of `p` on `q` (§5.7 step 2). */
function chooseGoal(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer): { goal: WarGoal; reasonKey: string; tensionKey: string } {
  const g = ctx.g;
  const r = b.relations.get(q.id);
  if (r && g.tick - r.nukedTick < 7200) return { goal: 'retaliation', reasonKey: 'war.reason.nukedUs', tensionKey: 'tension.retaliation' };
  if (r && r.betrayedUs) return { goal: 'retaliation', reasonKey: 'war.reason.betrayedUs', tensionKey: 'tension.retaliation' };
  if (r && g.tick - r.attackedTick < 2400) return { goal: 'retaliation', reasonKey: 'war.reason.attackedUs', tensionKey: 'tension.retaliation' };
  if (ctx.world.leader === q.id && ctx.world.leaderShare > b.diff.coalitionShare) {
    return { goal: 'coalition', reasonKey: 'war.reason.runawayLeader', tensionKey: 'tension.coalition' };
  }
  const weak = strength(q) <= strength(p) * 0.5;
  // Conquest (§5.8): conquerors against any much weaker neighbour; opportunists against one already bleeding in
  // another war, nukers against a crushed one (a third of their strength or less).
  const crushed = strength(q) <= strength(p) * 0.35 || isPrey(ctx, p, q, b.front.contact.get(q.id) ?? 1);
  const bleeding = g.war.enemiesOf(q.id).length > 0;
  // A great power means to subdue a weaker neighbour, or one already fighting on another front (§4.18).
  if (greatPower(ctx, b, p) && q.tiles < p.tiles && (weak || crushed || (bleeding && strength(q) <= strength(p) * 0.8))) {
    return { goal: 'conquest', reasonKey: 'war.reason.expansion', tensionKey: 'tension.expansion' };
  }
  if (rivals(ctx, b, p, q)) return { goal: 'conquest', reasonKey: 'war.reason.rivalry', tensionKey: 'tension.rivalry' };
  if ((weak || crushed) && (b.personality === 'conqueror' || (b.personality === 'opportunist' && (bleeding || crushed)) || (b.personality === 'nuker' && crushed))) {
    return { goal: 'conquest', reasonKey: 'war.reason.weakNeighbour', tensionKey: 'tension.weak' };
  }
  if (b.personality === 'trader' && strength(q) < strength(p)) return { goal: 'tribute', reasonKey: 'war.reason.tribute', tensionKey: 'tension.grievance' };
  if (b.personality === 'opportunist' && g.war.enemiesOf(q.id).length > 0) return { goal: 'border', reasonKey: 'war.reason.opportunity', tensionKey: 'tension.weak' };
  if (r && r.grievance > 1.5) return { goal: 'border', reasonKey: 'war.reason.grievance', tensionKey: 'tension.grievance' };
  return { goal: 'border', reasonKey: 'war.reason.border', tensionKey: 'tension.border' };
}

/** Commit ratio of home troops for an offensive (§5.7 step 6: 0.25–0.6 by personality and efficiency). */
export function commitRatio(b: Brain): number {
  return clamp(0.25 + 0.3 * (b.prof.aggression - 0.6) / 0.75 + 0.1 * b.diff.efficiency, 0.25, 0.6);
}

/**
 * Aim point on `q`: its capital when within `reach` tiles of our front (60; 150 in a war pressed toward capitulation,
 * where the capital is the objective, §4.13), else the front's aim tile.
 */
function aimAt(ctx: AiContext, b: Brain, q: SimPlayer, reach = 60): number {
  const g = ctx.g;
  const front = b.front.aim.get(q.id) ?? -1;
  const cap = q.capitalTile >= 0 && g.ownerOf(q.capitalTile) === q.id ? q.capitalTile : -1;
  if (cap >= 0 && (front < 0 || g.distance(front, cap) < reach)) return cap;
  return front >= 0 ? front : cap;
}

// =================================================================================================
// Steps 1–5: candidates, tension, declaration
// =================================================================================================
export function thinkDeclarations(ctx: AiContext, b: Brain, p: SimPlayer, gate: { threshold: number; neutral: number; swamped: boolean; fill: number; reserve: number }): void {
  const g = ctx.g;
  const d = DIFFICULTY_INDEX[g.difficulty];
  const lead = TENSION_LEAD_TICKS[d];
  // A pending tension: declare once the lead has run (re-checking everything), or drop it.
  if (b.tension) {
    const t = b.tension;
    const q = g.player(t.target);
    const waiting = (t.ultimatum ?? 0) > 0;
    const since = t.answeredTick ?? t.tick;
    const stale = !alive(q) || (g.isAllied(p.id, t.target) && t.reasonKey !== 'war.reason.ambition') || g.war.atWar(p.id, t.target)
      || (!waiting && g.tick - since > lead * 4 + 600);
    if (stale) {
      b.tension = null;
    } else if (g.tick - t.tick >= lead && (waiting || (mayDeclare(ctx, b, p) && !gate.swamped))) {
      // An ultimatum out: wait for its answer (or its expiry), then declare or stand down.
      if (waiting && (!ultimatumStage(ctx, b, p, q!) || !b.tension)) return;
      if (!mayDeclare(ctx, b, p) || gate.swamped) return;
      const naval = !g.sharesBorder(p.id, t.target);
      // The odds are re-read when the lead has run: a target that grew or made peace elsewhere is dropped.
      const need = naval ? 0 : neededShare(p, enemyGarrison(ctx, p, q!, b.front.contact.get(t.target) ?? 1), aggressorRatio(ctx, b, p, q!), armorPlan(ctx, p));
      if (need > MAX_COMMIT) {
        if (g.tick - t.tick > lead * 3) b.tension = null;
      } else if (g.war.declareError(p.id, t.target) === null) {
        // The war would go ahead now: first, perhaps, an ultimatum (§5.4).
        if (!waiting && !ultimatumStage(ctx, b, p, q!)) return;
        const G0 = naval ? 0 : enemyGarrison(ctx, p, q!, b.front.contact.get(t.target) ?? 1);
        const want = Math.min(commitRatio(b) * p.troops, Math.max(restrained(ctx, b, q!) ? 0 : usefulWidthTroops(q!), G0 * Math.max(LAUNCH_RATIO, targetRatio(ctx, b, q)) * 1.05));
        const ratio = clamp(Math.max(need * 1.05, want / Math.max(1, p.troops)), 0.05, MAX_COMMIT);
        const aim = aimAt(ctx, b, q!, t.goal === 'conquest' ? 150 : 60);
        const ok = g.issue(p.id, {
          type: 'declareWar', target: t.target, goal: t.goal, reasonKey: t.reasonKey,
          queuedAttack: aim >= 0 && !naval ? { tile: aim, ratio } : undefined,
        });
        if (ok) {
          b.tension = null;
          b.lastDeclareTick = g.tick;
          // The queued offensive is this staff's next operation (it starts when the mobilization ends).
          b.lastOffensiveTick = Math.max(b.lastOffensiveTick, g.tick + AI_MOBILIZE_TICKS[d]);
          ctx.world.lastAiWarTick = g.tick;
          b.enemy = t.target;
          b.enemySince = g.tick;
          b.idleTicks = Math.max(0, b.idleTicks - 600);
        }
      }
    }
    return;
  }
  if (!mayDeclare(ctx, b, p) || gate.swamped) return;
  if (gate.fill < gate.reserve * 0.9) return;
  // In the land rush nations do not start wars unless they are boxed in.
  if (g.tick < 900 && gate.neutral > 6) return;
  let best: SimPlayer | null = null, bestScore = 0, betray = false;
  const graceEnd = HUMAN_GRACE_TICKS[d];
  for (const [id, c] of b.front.contact) {
    if (id === 0) continue;
    const q = g.player(id);
    if (!alive(q) || q.kind === 'tribe') continue;
    if (g.war.pairState(p.id, id) !== 'peace') continue;
    // Protecting the human (§4.16): tension may start one lead before the grace ends, never earlier.
    if (id === HUMAN_ID && b.kind !== 'autopilot' && g.tick < graceEnd - lead) continue;
    if (id === HUMAN_ID && g.war.declareError(p.id, id) === 'msg.warCap') continue;
    // An accepted ultimatum bought peace for a while (§5.4).
    if (g.diplomacy.noWarUntil(p.id, id) > g.tick) continue;
    const weak = strength(q) <= strength(p) * 0.5;
    // A partner (alliance or non-aggression pact) is spared unless the rare betrayal of §5.6.
    if (g.isAllied(p.id, id) || g.diplomacy.hasTreaty(p.id, id, 'nap')) {
      // Betrayal (§5.6): an ally is spared unless the gain is large (it is much weaker, and not allied to our other
      // friends) and the personality's word gives way: 1 − loyalty, rolled once per decision cycle, scaled down.
      if (!weak || betrayalBlocked(ctx, p, q)) continue;
      if (ctx.rng.next() >= (1 - b.prof.loyalty) * BETRAYAL_ROLL) continue;
      if (neededShare(p, enemyGarrison(ctx, p, q, c), LAUNCH_RATIO, armorPlan(ctx, p)) > MAX_COMMIT) continue;
      const sc = scoreTarget(ctx, b, p, q, c, gate.neutral);
      if (sc > bestScore) {
        bestScore = sc;
        best = q;
        betray = true;
      }
      continue;
    }
    const opinion = opinionOf(ctx, p, q);
    // Step 1 filter: hostile opinion (< −30), unless a conqueror faces a much weaker neighbour, an opportunist a cold
    // one (≤ −10) already bleeding in another war, or a conqueror, nuker or opportunist a cold neighbour it could beat
    // with a third of its army (prey: the temptation of overwhelming local superiority, §5.8; turtles and traders go
    // to war only when hostile).
    const bleeding = b.personality === 'opportunist' && opinion <= COLD && g.war.enemiesOf(q.id).length > 0;
    // After tick 18,000 the AI's humanFocus (§4.16, §5.9; Normal and above) also turns its attention to a human it
    // could crush: a weak, passive human is prey unless the AI is friendly to it.
    const humanPrey = q.id === HUMAN_ID && g.tick >= 18_000 && b.diff.humanFocus >= 0.8 && opinion < 0;
    const prey = (b.personality === 'conqueror' || b.personality === 'nuker' || b.personality === 'opportunist' || humanPrey)
      && (opinion <= COLD || humanPrey) && isPrey(ctx, p, q, c);
    // A great power (§4.18) eyes any neighbour below cordial that is much weaker or already bleeding on another front
    // (never the human before tick 18,000: §4.16). Rival great powers need no more than a negative opinion.
    // It expands toward smaller nations: a larger empire is a rival (see rivals), not a prey.
    const great = greatPower(ctx, b, p) && q.tiles < p.tiles && opinion < CORDIAL && (q.id !== HUMAN_ID || g.tick >= 18_000)
      && (weak || (g.war.enemiesOf(q.id).length > 0 && strength(q) <= strength(p) * 0.8));
    const rival = opinion < 0 && rivals(ctx, b, p, q);
    if (opinion >= -30 && !(b.personality === 'conqueror' && weak) && !bleeding && !prey && !great && !rival) continue;
    // Deterrence: the troops the target's allies would bring, weighted by the §5.5 odds that they answer its call to
    // arms (0.5 + 0.5·loyalty when they border us or have a navy, 0.3 + 0.5·loyalty otherwise).
    if (expectedAllies(ctx, p, q) > p.troops * 0.5) continue;
    // No war it cannot fight: the first offensive must reach the launch odds against the garrison it will meet.
    if (neededShare(p, enemyGarrison(ctx, p, q, c), aggressorRatio(ctx, b, p, q), armorPlan(ctx, p)) > MAX_COMMIT) continue;
    let s = scoreTarget(ctx, b, p, q, c, gate.neutral);
    s *= 1 + Math.min(0.5, (-opinion - 30) / 140);
    if (s > bestScore) {
      bestScore = s;
      best = q;
      betray = false;
    }
  }
  // Reachable players across the sea (§5.7 step 1, naval reach): only as prey for a conquest, never for a border quarrel.
  if (!best && g.tick >= 6000 && b.front.shoreSample.length > 0 && (b.personality === 'conqueror' || b.personality === 'opportunist')) {
    const reach = reachOf(ctx, b);
    const base = b.homeTile;
    for (const q of g.players()) {
      if (q.id === p.id || !alive(q) || (q.kind !== 'nation' && q.kind !== 'human') || b.front.contact.has(q.id)) continue;
      if (g.isAllied(p.id, q.id) || g.diplomacy.hasTreaty(p.id, q.id, 'nap') || g.war.pairState(p.id, q.id) !== 'peace' || q.capitalTile < 0 || base < 0) continue;
      if (g.diplomacy.noWarUntil(p.id, q.id) > g.tick) continue;
      if (q.id === HUMAN_ID && b.kind !== 'autopilot' && g.tick < graceEnd - lead) continue;
      if (q.id === HUMAN_ID && g.war.declareError(p.id, q.id) === 'msg.warCap') continue;
      if (g.distance(base, q.capitalTile) > reach) continue;
      const weak = strength(q) <= strength(p) * 0.5;
      const prey = b.personality === 'conqueror' ? weak : weak && g.war.enemiesOf(q.id).length > 0;
      if (!prey || opinionOf(ctx, p, q) >= 10) continue;
      const sc = scoreTarget(ctx, b, p, q, 6, gate.neutral) * 0.6;
      if (sc > bestScore) {
        bestScore = sc;
        best = q;
      }
    }
  }
  if (!best || bestScore < gate.threshold) return;
  // Opening grace: no war between nations in the first hours unless the odds are crushing.
  const need = g.tick < 1800 ? 3.2 : g.tick < 3600 ? 1.8 : 0;
  if (need > 0 && p.troops < best.troops * need) return;
  const goal = betray
    ? { goal: 'conquest' as WarGoal, reasonKey: 'war.reason.ambition', tensionKey: 'tension.ambition' }
    : chooseGoal(ctx, b, p, best);
  prepareWar(ctx, b, p, best, goal, betray);
}

/**
 * §5.7 steps 3–4 (W3): the grievance is stated publicly (a `tension` event through the diplomacy system, the warning
 * T9 measures) and the plan is kept on the brain; after the tension lead the staff either issues an ultimatum or
 * declares (thinkDeclarations). A betrayal is a surprise: no ultimatum.
 */
export function prepareWar(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer, goal: { goal: WarGoal; reasonKey: string; tensionKey: string }, betray = false): void {
  const g = ctx.g;
  b.tension = { target: q.id, goal: goal.goal, reasonKey: goal.reasonKey, tick: g.tick, ultimatum: betray ? -1 : 0 };
  g.diplomacy.issueTension(p.id, q.id, goal.tensionKey, { goal: goal.goal });
}

/**
 * The ultimatum stage (§5.4) when the tension lead has run. Returns true when the declaration may go ahead now, false
 * while an ultimatum is issued or pending (or when the matter ended).
 */
function ultimatumStage(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer): boolean {
  const g = ctx.g;
  const t = b.tension!;
  if (t.ultimatum === undefined) t.ultimatum = 0;
  if (t.ultimatum === 0) {
    const odds = ULTIMATUM_ODDS[b.personality] ?? 0.7;
    const demand = b.kind === 'autopilot' ? null : ultimatumDemand(ctx, b, p, q, t.goal);
    // Protecting the human (§4.16): a power that could crush the human (4× its strength) always presents its demand
    // first, so the player gets a choice (yield the band, or fight) and time to find allies before the blow falls.
    const crushing = q.id === HUMAN_ID && strength(q) * 4 < strength(p);
    if (!demand || (ctx.rng.next() >= odds && !crushing)) {
      t.ultimatum = -1;
      return true;
    }
    const u = g.diplomacy.issueUltimatum(p.id, q.id, demand);
    t.ultimatum = u ? u.id : -1;
    return !u;
  }
  if (t.ultimatum < 0) return true;
  const u = g.diplomacy.proposal(t.ultimatum);
  // Settled too long ago to be read (or never recorded): treat it as expired, the plan goes on (an accepted demand
  // still bars the war: declareError answers msg.ultimatumPeace).
  if (!u) {
    t.ultimatum = -1;
    return true;
  }
  if (u.status === 'considering' || u.status === 'pending') return false;
  t.answeredTick ??= g.tick;
  if (u.status === 'accepted') {
    // Satisfied: peace for a while (the diplomacy system enforces it).
    b.tension = null;
    return false;
  }
  if (u.status === 'rejected' || u.status === 'countered') {
    t.ultimatum = -1;
    if (ctx.rng.next() >= (REFUSAL_WAR_ODDS[b.personality] ?? 0.7)) {
      b.tension = null;
      return false;
    }
    return true;
  }
  // Expired or cancelled: not a refusal; the plan goes on as it was.
  t.ultimatum = -1;
  return true;
}

// =================================================================================================
// Step 6: war plans
// =================================================================================================
export function thinkWarPlans(ctx: AiContext, b: Brain, p: SimPlayer, reserve: number): void {
  const g = ctx.g;
  const wars = g.war.warsOf(p.id);
  if (wars.length === 0) return;
  // The main enemy for the military modules: the war we are losing most, else our own offensive war.
  if (b.enemy === 0 || !g.war.atWar(p.id, b.enemy)) {
    const w = wars[0];
    b.enemy = w.a === p.id ? w.b : w.a;
    b.enemySince = g.tick;
  }
  for (const w of wars) {
    const next = b.plans.get(w.id) ?? 0;
    if (g.tick < next) continue;
    b.plans.set(w.id, g.tick + PLAN_EVERY);
    runPlan(ctx, b, p, w, reserve);
  }
  for (const id of [...b.plans.keys()]) if (!wars.some((w) => w.id === id)) b.plans.delete(id);
}

function runPlan(ctx: AiContext, b: Brain, p: SimPlayer, w: SimWar, reserve: number): void {
  const g = ctx.g;
  const enemyId = w.a === p.id ? w.b : w.a;
  const q = g.player(enemyId);
  if (!alive(q)) return;
  const side = w.a === p.id ? 0 : 1;
  // Front priorities: alta where the enemy attacks (or masses while it mobilizes), normal elsewhere.
  const fronts = g.fronts.frontsOfPair(p.id, enemyId);
  const enemyMobilizing = w.a === enemyId && g.tick < w.mobilizeUntilTick;
  for (const f of fronts) {
    const s = f.a === p.id ? 0 : 1;
    const hit = f.offensive[s === 0 ? 1 : 0] !== 0 || (enemyMobilizing && f.length >= 4);
    const want = hit ? 2 : 1;
    if (f.priority[s] !== want) g.issue(p.id, { type: 'setFrontPriority', frontKey: f.key, priority: want as 0 | 1 | 2 });
  }
  const mobUntil = g.war.mobilizingUntil(p.id, enemyId);
  if (mobUntil > 0) {
    // The next plan runs as the mobilization ends, to size the queued offensive against the garrison it meets.
    b.plans.set(w.id, Math.min(b.plans.get(w.id) ?? mobUntil, mobUntil));
    return;
  }
  // Offensives: top up to the commit ratio and re-aim; start one when there is none and the odds are fair.
  const mine = g.outgoingAttacks(p.id).filter((a) => a.defender === enemyId);
  const land = mine.filter((a) => !a.naval);
  if (mine.length) b.warActive.set(w.id, g.tick);
  const commit = commitRatio(b);
  const home = p.troops;
  const spare = home - reserve * p.maxTroops * 0.6;
  const aim = aimAt(ctx, b, q, pressing(ctx, w, p.id) ? 150 : 60);
  if (g.sharesBorder(p.id, enemyId)) {
    const G = enemyGarrison(ctx, p, q, b.front.contact.get(enemyId) ?? 1);
    // Their offensive on the same front joins the defence of a counter-offensive at half weight (§4.8).
    let incoming = 0;
    for (const a of g.incomingAttacks(p.id)) if (a.attacker === enemyId && !a.naval) incoming += a.troops;
    const launchRatio = side === 0 ? aggressorRatio(ctx, b, p, q) : COUNTER_RATIO;
    const armor = armorPlan(ctx, p);
    const width = restrained(ctx, b, q) ? 0 : usefulWidthTroops(q);
    // A new offensive only with the odds (§4.6); a second corridor on another front against a large enemy (§4.18).
    const canOpen = g.tick >= (b.offCooldown.get(enemyId) ?? 0) && g.tick - b.lastOffensiveTick >= OFFENSIVE_TEMPO && spare > home * 0.05;
    if (land.length === 0 || (land.length === 1 && side === 0 && q.tiles >= SECOND_CORRIDOR_TILES && land[0].troops >= width * 0.8)) {
      if (!canOpen) return;
      let tile = aim;
      if (land.length === 1) {
        // The second corridor opens on another front of this war (the longest one without our offensive).
        tile = -1;
        let best = 5;
        for (const f of fronts) {
          if (f.key === land[0].frontKey || f.length <= best) continue;
          best = f.length;
          tile = Math.floor(f.y) * MAP_W + Math.floor(((f.x % MAP_W) + MAP_W) % MAP_W);
        }
      }
      if (tile < 0) return;
      const G1 = G + 0.5 * incoming;
      const need = neededShare(p, G1, launchRatio, armor);
      if (need > MAX_COMMIT) return;
      // Sized for the odds and for a corridor as wide as the enemy is worth, within the personality's commit ratio.
      const want = Math.min(commit * home, Math.max(width, G1 * Math.max(launchRatio, targetRatio(ctx, b, q)) * 1.05));
      const ratio = clamp(Math.max(need * 1.05, want / Math.max(1, home)), 0.05, MAX_COMMIT);
      if (g.issue(p.id, { type: 'attack', target: enemyId, ratio, tile })) b.lastOffensiveTick = g.tick;
      return;
    }
    const goal = targetRatio(ctx, b, q);
    for (const a of land) {
      if (a.state === 'retreating') continue;
      // In the contact phase the ratio is not measured yet: estimate it from the garrison it will meet.
      const R = a.state === 'contact' ? a.troops / Math.max(1, G) : a.ratio;
      if (R <= 0) continue;
      // What the offensive meets teaches the staff the enemy's real strength (divisions, posts, modifiers).
      if (a.state !== 'contact' && G > 0) {
        const seen = clamp(a.troops / R / G, 0.5, 3);
        b.intel.set(enemyId, (b.intel.get(enemyId) ?? 1) * 0.5 + seen * 0.5);
      }
      // Reinforcements go to this offensive's own axis (a far click would open a new offensive, §4.3).
      const axis = a.clickX >= 0 ? Math.floor(a.clickY) * MAP_W + Math.floor(a.clickX) : -1;
      if (R < HOLD_RATIO && a.state !== 'contact') {
        // Stuck: feed it up to a winning ratio if we can, else pull it back before it bleeds out (§4.9).
        const add = a.troops * (TOPUP_RATIO / R - 1);
        if (axis >= 0 && add < spare && add / Math.max(1, home) <= MAX_COMMIT) {
          g.issue(p.id, { type: 'attack', target: enemyId, ratio: clamp(add / Math.max(1, home), 0.03, MAX_COMMIT), tile: axis });
        } else if (a.state === 'stalled') {
          g.issue(p.id, { type: 'retreat', attackId: a.id });
          b.offCooldown.set(enemyId, g.tick + OFFENSIVE_COOLDOWN);
        }
        continue;
      }
      // Top up (casualties and the enemy's redeployment wear it down) to the target ratio and the useful width, on
      // the same axis; once its axis point has fallen, re-aim it at the capital or the enemy's front (§5.7 step 6).
      const wantTroops = Math.max(R < goal * 0.85 ? a.troops * (goal / R) : 0, Math.min(commit * (home + a.troops), width));
      const add = Math.max(0, Math.min(spare, wantTroops - a.troops));
      const axisTaken = axis < 0 || g.ownerOf(axis) !== enemyId;
      const tile = axisTaken && aim >= 0 && g.distance(aim, axis >= 0 ? axis : aim) <= 20 ? aim : axis;
      if (tile >= 0 && home > 1 && (add > Math.max(home * 0.02, a.troops * 0.1) || (axisTaken && tile === aim && aim !== axis))) {
        g.issue(p.id, { type: 'attack', target: enemyId, ratio: clamp(add / home, 0.005, MAX_COMMIT), tile });
      }
    }
  } else if (mine.length === 0 && side === 0 && spare > home * 0.1 && g.tick - b.lastOffensiveTick >= OFFENSIVE_TEMPO) {
    // No land front: a landing on their coast nearest to our shores (their capital's coast when it has one).
    const coast = q.capitalTile >= 0 && g.isShore(q.capitalTile) ? q.capitalTile : enemyCoast(ctx, b, q);
    if (coast >= 0 && g.issue(p.id, { type: 'boatAttack', targetTile: coast, ratio: Math.min(0.45, commit) })) b.lastOffensiveTick = g.tick;
  }
}

/** A coastal tile of `q` near our shores (sampled), or -1. */
function enemyCoast(ctx: AiContext, b: Brain, q: SimPlayer): number {
  const g = ctx.g;
  const ours = b.front.shoreSample.length ? b.front.shoreSample : b.homeTile >= 0 ? [b.homeTile] : [];
  if (ours.length === 0) return -1;
  let best = -1, bd = Infinity, n = 0;
  for (const t of g.borderTiles(q.id)) {
    if (!g.isShore(t)) continue;
    for (const o of ours) {
      const d = g.distance(t, o);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    if (++n >= 400) break;
  }
  return best;
}

// =================================================================================================
// Step 8: peace
// =================================================================================================
/** Is the goal of `p`'s side in war `w` met (§5.7 step 8)? */
function goalMet(ctx: AiContext, w: SimWar, p: number): boolean {
  const g = ctx.g;
  const side = w.a === p ? 0 : 1;
  const other = side === 0 ? 1 : 0;
  const days = (g.tick - w.startTick) / 240;
  const taken = side === 0 ? w.net : -w.net;
  const score = g.war.warScore(p, side === 0 ? w.b : w.a);
  // Only the aggressor's goal is read; the defender's goal is to survive.
  if (side === 1) return taken >= 0 && days >= 5;
  switch (w.goal) {
    case 'border': return taken >= Math.max(15, w.tilesAtStart[other] * 0.03);
    case 'tribute': return score >= 25;
    case 'retaliation': return score >= 10 || days >= 12;
    case 'coalition': return taken >= w.tilesAtStart[other] * 0.08 || days >= 20;
    case 'defense': return (w.parentWar > 0 && !g.war.warsOf(w.a).some((x) => (x as SimWar).id === w.parentWar)) || days >= 8;
    case 'liberation': return days >= 10 && taken >= 0;
    case 'incursion': return days >= 3;
    case 'conquest': return false;
  }
  return false;
}

/**
 * Does `p` press on toward the enemy's capitulation (§4.15 "winners hold out", §5.7 step 8)? Its own `conquest` war,
 * or any war it is clearly winning (score ≥ 40 with the enemy capital in hand) when its personality has the appetite:
 * turtles and traders take their terms instead.
 */
export function pressing(ctx: AiContext, w: SimWar, p: number): boolean {
  const side = w.a === p ? 0 : 1;
  if (side === 0 && w.goal === 'conquest') return true;
  const b = ctx.brains.get(p);
  const P = ctx.g.player(p);
  if (!b || !P || b.personality === 'turtle' || (b.personality === 'trader' && !greatPower(ctx, b, P))) return false;
  const enemy = side === 0 ? w.b : w.a;
  return w.capitalLost[side === 0 ? 1 : 0] && ctx.g.war.warScore(p, enemy) >= 40;
}

/** Would `q` accept a white peace from its enemy? (the side that holds out demands terms instead). */
export function answerWhite(ctx: AiContext, w: SimWar, q: number, enemy: number): 'yes' | 'no' | 'cede' | 'tribute' {
  const g = ctx.g;
  const ex = g.war.exhaustion(q);
  const s = g.war.warScore(q, enemy);
  const conquest = pressing(ctx, w, q);
  // A `conquest` goal is met only by capitulation (§5.7 step 8): the conqueror holds out for all of it.
  if (conquest && ex < 70) return 'no';
  if (s >= 40 && ex < 70) return 'cede';
  if (s >= 25 && ex < 70) return 'tribute';
  if (ex >= 35 || goalMet(ctx, w, q)) return 'yes';
  return 'no';
}

export function thinkPeace(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  if (g.tick < b.nextPeace) return;
  b.nextPeace = g.tick + PEACE_EVERY;
  for (const w of g.war.warsOf(p.id)) {
    const enemy = w.a === p.id ? w.b : w.a;
    const q = g.player(enemy);
    if (!alive(q)) continue;
    // The human negotiates from its inbox (W3): the AI proposes, the human answers (its autopilot answers like an AI).
    const human = enemy === HUMAN_ID && !g.config.humanAutopilot;
    if (!human && !ctx.brains.has(enemy)) continue;
    if (human) {
      proposePeaceToHuman(ctx, b, p, w);
      continue;
    }
    const ex = g.war.exhaustion(p.id);
    const s = g.war.warScore(p.id, enemy);
    const mineConquest = pressing(ctx, w, p.id);
    // A war of ours that never got going (no offensive for FAILED_WAR_TICKS after mobilization, nothing gained): the
    // plan failed; offer a white peace rather than keep an empty war open.
    if (w.a === p.id && !w.joined) {
      const active = Math.max(b.warActive.get(w.id) ?? 0, w.mobilizeUntilTick);
      if (g.tick - active >= FAILED_WAR_TICKS && w.net <= 0 && answerWhite(ctx, w, enemy, p.id) === 'yes') {
        makePeace(ctx, p.id, enemy, { kind: 'white' }, 0);
        continue;
      }
    }
    // A losing, exhausted side sues for peace.
    if (ex >= 45 && s <= 0 && !(mineConquest && ex < 70)) {
      const ans = answerWhite(ctx, w, enemy, p.id);
      if (ans === 'yes') makePeace(ctx, p.id, enemy, { kind: 'white' }, 0);
      else if (ans === 'cede') makePeace(ctx, p.id, enemy, { kind: 'cede', tiles: Math.round(p.tiles * 0.1) }, p.id);
      else if (ans === 'tribute') makePeace(ctx, p.id, enemy, { kind: 'tribute' }, p.id);
      continue;
    }
    // A winner whose goal is met presses for terms; the loser gives in when exhausted or beaten.
    if (!mineConquest && goalMet(ctx, w, p.id) && s >= 25) {
      const qex = g.war.exhaustion(enemy);
      const qs = g.war.warScore(enemy, p.id);
      if (qex >= 40 || qs <= -40) {
        if (s >= 40) makePeace(ctx, p.id, enemy, { kind: 'cede', tiles: Math.round(q.tiles * 0.1) }, enemy);
        else makePeace(ctx, p.id, enemy, { kind: 'tribute' }, enemy);
      }
      continue;
    }
    // A stalemate both sides are tired of ends on the current lines (a war pressed toward capitulation is given up
    // only at exhaustion 50: §4.15, winners hold out).
    if (ex >= (mineConquest ? 50 : 35) && Math.abs(s) < 25 && answerWhite(ctx, w, enemy, p.id) === 'yes') makePeace(ctx, p.id, enemy, { kind: 'white' }, 0);
  }
}

/**
 * An AI at war with the human offers terms through the human's inbox (§5.3, §5.7 step 8): a losing, exhausted AI a
 * white peace; a winner whose goal is met a cession or a tribute from the human; a stalemate both are tired of, a white
 * peace. At most one open offer; the cooldown after a refusal applies.
 */
function proposePeaceToHuman(ctx: AiContext, b: Brain, p: SimPlayer, w: SimWar): void {
  const g = ctx.g;
  if (g.diplomacy.openProposals(p.id).some((x) => x.kind === 'peace' && x.to === HUMAN_ID)) return;
  const ex = g.war.exhaustion(p.id);
  const s = g.war.warScore(p.id, HUMAN_ID);
  const conquest = pressing(ctx, w, p.id);
  let terms: PeaceTerms | null = null;
  if (w.a === p.id && !w.joined) {
    const active = Math.max(b.warActive.get(w.id) ?? 0, w.mobilizeUntilTick);
    if (g.tick - active >= FAILED_WAR_TICKS && w.net <= 0) terms = { kind: 'white' };
  }
  if (!terms && ex >= 45 && s <= 0 && !(conquest && ex < 70)) terms = { kind: 'white' };
  const human = g.player(HUMAN_ID);
  if (!terms && !conquest && goalMet(ctx, w, p.id) && s >= 25 && human) {
    terms = s >= 40 ? { kind: 'cede', loser: HUMAN_ID, tiles: Math.max(1, Math.round(human.tiles * 0.1)) } : { kind: 'tribute', loser: HUMAN_ID };
  }
  if (!terms && ex >= (conquest ? 50 : 35) && Math.abs(s) < 25) terms = { kind: 'white' };
  if (terms && !g.diplomacy.proposeError(p.id, HUMAN_ID, 'peace', { terms })) g.diplomacy.propose(p.id, HUMAN_ID, 'peace', { terms });
}

function makePeace(ctx: AiContext, a: number, b: number, terms: PeaceTerms, loser: number): void {
  const g = ctx.g;
  if (!g.war.makePeace(a, b, terms, 'peace.reason.treaty', loser)) return;
  for (const [x, y] of [[a, b], [b, a]]) {
    const br = ctx.brains.get(x);
    if (!br) continue;
    if (br.enemy === y) br.enemy = 0;
    br.tension = br.tension && br.tension.target === y ? null : br.tension;
    const r = relation(br, y);
    r.grievance *= 0.5;
    r.attackedTick = Math.min(r.attackedTick, g.tick - 2400);
  }
}
