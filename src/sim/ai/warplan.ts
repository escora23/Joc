// FRONT ULTRA — the AI war pipeline (DESIGN_V2 §5.7, steps 1–2 and 5–8; owner: sim-ai, built by W1). Worker-only.
//
//   1. Candidates every war clock: bordering players scored by scoreTarget, filtered by an OPINION PROXY (v1 trust and
//      grievance mapped to −100…+100, plus border friction, betrayal and the runaway leader): < −30 required, unless a
//      conqueror faces a neighbour at ≤ 0.5× its strength.
//   2. A goal and a reason key (retaliation, coalition, conquest, tribute, border).
//   3. A `tension` event, then the declaration after the tension lead of §2.4 (Easy 480, Normal 240, Hard/Insane 120).
//      v2-stub(W1→W3): W3 replaces the proxy with real opinions, adds ultimatums and routes tension through its system.
//   5. The declaration carries the first offensive, which starts by itself when the mobilization ends.
//   6. War plans every 120 ticks: front priorities (alta where the enemy attacks), offensives topped up to the commit
//      ratio and re-aimed at the enemy capital or its largest region; naval landings when there is no land front.
//   7. Limits: 2 offensive wars for conquerors and opportunists, 1 for the rest; 1 declaration per AI per 720 ticks; no
//      declaration above exhaustion 50; worldwide 1 new AI war per 120 ticks before tick 18,000, per 60 after.
//   8. Peace every 240 ticks: sue for peace at exhaustion ≥ 45 and war score ≤ 0; the other side accepts a white peace at
//      exhaustion ≥ 35 or when its goal is met, but a winner (score ≥ 40, exhaustion < 70) demands a cession (or a
//      tribute at ≥ 25); a `conquest` goal is met only by capitulation (WarSystem).

import { DIFFICULTY_INDEX, HUMAN_GRACE_TICKS, HUMAN_ID, TENSION_LEAD_TICKS } from '../../shared/constants';
import type { SimPlayer, SimWar } from '../../shared/simapi';
import type { PeaceTerms, WarGoal } from '../../shared/types';
import { alive, relation, strength, type AiContext } from './context';
import type { Brain } from './state';
import { scoreTarget } from './war';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** War-plan and peace cadences (ticks). */
const PLAN_EVERY = 120;
const PEACE_EVERY = 240;
const DECLARE_GAP = 720;

/** The opinion proxy of `b` about `q` (−100…+100). v2-stub(W1→W3): W3's opinion model replaces it. */
export function opinionProxy(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer): number {
  const g = ctx.g;
  const r = b.relations.get(q.id);
  let o = 0;
  if (r) {
    o += 100 * r.trust - 10 * r.grievance;
    if (r.betrayedUs) o -= 60;
    if (g.tick - r.attackedTick < 2400) o -= 25;
    if (g.tick - r.nukedTick < 7200) o -= 60;
  }
  // Border friction: a long shared border is a standing dispute (the `border` casus belli).
  const c = b.front.contact.get(q.id) ?? 0;
  if (c > 0) o -= Math.min(35, c * 0.7);
  if (ctx.world.leader === q.id && ctx.world.leaderShare > b.diff.coalitionShare) o -= 40;
  if (q.traitorUntilTick > g.tick) o -= 15;
  if (p.allies.has(q.id)) o += 60;
  for (const a of q.allies) {
    if (p.allies.has(a)) {
      o += 20;
      break;
    }
  }
  return clamp(o, -100, 100);
}

/** Offensive wars `p` wages (it declared them; wars joined by a call to arms and defensive wars do not count). */
function offensiveWars(ctx: AiContext, p: SimPlayer): number {
  let n = 0;
  for (const w of ctx.g.war.warsOf(p.id)) if (w.a === p.id && !w.joined && w.goal !== 'liberation') n++;
  return n;
}

function maxOffensiveWars(b: Brain): number {
  return b.personality === 'conqueror' || b.personality === 'opportunist' ? 2 : 1;
}

/** May `p` declare a new war now (limits of §5.7 step 7)? */
function mayDeclare(ctx: AiContext, b: Brain, p: SimPlayer): boolean {
  const g = ctx.g;
  if (g.tick - b.lastDeclareTick < DECLARE_GAP) return false;
  if (g.war.exhaustion(p.id) > 50) return false;
  if (offensiveWars(ctx, p) >= maxOffensiveWars(b)) return false;
  const gap = g.tick < 18_000 ? 120 : 60;
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
  if (b.personality === 'conqueror' && weak) return { goal: 'conquest', reasonKey: 'war.reason.weakNeighbour', tensionKey: 'tension.weak' };
  if (b.personality === 'trader' && strength(q) < strength(p)) return { goal: 'tribute', reasonKey: 'war.reason.tribute', tensionKey: 'tension.grievance' };
  if (b.personality === 'opportunist' && g.war.enemiesOf(q.id).length > 0) return { goal: 'border', reasonKey: 'war.reason.opportunity', tensionKey: 'tension.weak' };
  if (r && r.grievance > 1.5) return { goal: 'border', reasonKey: 'war.reason.grievance', tensionKey: 'tension.grievance' };
  return { goal: 'border', reasonKey: 'war.reason.border', tensionKey: 'tension.border' };
}

/** Commit ratio of home troops for an offensive (§5.7 step 6: 0.25–0.6 by personality and efficiency). */
export function commitRatio(b: Brain): number {
  return clamp(0.25 + 0.3 * (b.prof.aggression - 0.6) / 0.75 + 0.1 * b.diff.efficiency, 0.25, 0.6);
}

/** Aim point on `q`: its capital when within reach of our front, else the front's aim tile. */
function aimAt(ctx: AiContext, b: Brain, q: SimPlayer): number {
  const g = ctx.g;
  const front = b.front.aim.get(q.id) ?? -1;
  const cap = q.capitalTile >= 0 && g.ownerOf(q.capitalTile) === q.id ? q.capitalTile : -1;
  if (cap >= 0 && (front < 0 || g.distance(front, cap) < 60)) return cap;
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
    const stale = !alive(q) || g.isAllied(p.id, t.target) || g.war.atWar(p.id, t.target) || g.tick - t.tick > lead * 4 + 600;
    if (stale) {
      b.tension = null;
    } else if (g.tick - t.tick >= lead && mayDeclare(ctx, b, p) && !gate.swamped) {
      if (g.war.declareError(p.id, t.target) === null) {
        const ratio = commitRatio(b);
        const aim = aimAt(ctx, b, q!);
        const naval = !g.sharesBorder(p.id, t.target);
        const ok = g.issue(p.id, {
          type: 'declareWar', target: t.target, goal: t.goal, reasonKey: t.reasonKey,
          queuedAttack: aim >= 0 && !naval ? { tile: aim, ratio } : undefined,
        });
        if (ok) {
          b.tension = null;
          b.lastDeclareTick = g.tick;
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
  let best: SimPlayer | null = null, bestScore = 0;
  const graceEnd = HUMAN_GRACE_TICKS[d];
  for (const [id, c] of b.front.contact) {
    if (id === 0) continue;
    const q = g.player(id);
    if (!alive(q) || q.kind === 'tribe') continue;
    if (g.isAllied(p.id, id) || g.war.pairState(p.id, id) !== 'peace') continue;
    // Protecting the human (§4.16): tension may start one lead before the grace ends, never earlier.
    if (id === HUMAN_ID && b.kind !== 'autopilot' && g.tick < graceEnd - lead) continue;
    if (id === HUMAN_ID && g.war.declareError(p.id, id) === 'msg.warCap') continue;
    const opinion = opinionProxy(ctx, b, p, q);
    const weak = strength(q) <= strength(p) * 0.5;
    if (opinion >= -30 && !(b.personality === 'conqueror' && weak)) continue;
    let s = scoreTarget(ctx, b, p, q, c, gate.neutral);
    s *= 1 + Math.min(0.5, (-opinion - 30) / 140);
    if (s > bestScore) {
      bestScore = s;
      best = q;
    }
  }
  if (!best || bestScore < gate.threshold) return;
  // Opening grace: no war between nations in the first hours unless the odds are crushing.
  const need = g.tick < 1800 ? 3.2 : g.tick < 3600 ? 1.8 : 0;
  if (need > 0 && p.troops < best.troops * need) return;
  const goal = chooseGoal(ctx, b, p, best);
  b.tension = { target: best.id, goal: goal.goal, reasonKey: goal.reasonKey, tick: g.tick };
  if (best.id === HUMAN_ID) g.war.recordTension(p.id, best.id);
  g.emit({ type: 'tension', tick: g.tick, from: p.id, to: best.id, reasonKey: goal.tensionKey, params: { goal: goal.goal } });
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
  if (g.war.mobilizingUntil(p.id, enemyId) > 0) return;
  // Offensives: top up to the commit ratio and re-aim; start one when there is none and the odds are fair.
  const mine = g.outgoingAttacks(p.id).filter((a) => a.defender === enemyId);
  const land = mine.filter((a) => !a.naval);
  const commit = commitRatio(b);
  const home = p.troops;
  const spare = home - reserve * p.maxTroops * 0.6;
  const aim = aimAt(ctx, b, q);
  if (g.sharesBorder(p.id, enemyId)) {
    if (land.length === 0) {
      // Defensive side: counter-attack only with a real edge; aggressor: always push its war.
      const theirGarrison = q.troops * 0.85 / Math.max(1, g.fronts.frontsOf(enemyId).length);
      const want = home * commit;
      const fair = want > theirGarrison * (side === 0 ? 1.2 : 1.6);
      if ((side === 0 || fair) && spare > home * 0.05 && aim >= 0) g.issue(p.id, { type: 'attack', target: enemyId, ratio: commit, tile: aim });
    } else {
      for (const a of land) {
        const want = commit * (home + a.troops);
        if (a.troops < want * 0.8 && spare > home * 0.05 && aim >= 0) {
          const add = clamp((want - a.troops) / Math.max(1, home), 0.03, commit);
          g.issue(p.id, { type: 'attack', target: enemyId, ratio: add, tile: aim });
        }
      }
    }
  } else if (mine.length === 0 && side === 0 && spare > home * 0.1) {
    // No land front: a landing on their coast (the naval module picks beaches; here the capital's coast).
    const coast = q.capitalTile >= 0 && g.isShore(q.capitalTile) ? q.capitalTile : aim;
    if (coast >= 0) g.issue(p.id, { type: 'boatAttack', targetTile: coast, ratio: Math.min(0.45, commit) });
  }
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

/** Would `q` accept a white peace from its enemy? (the side that holds out demands terms instead). */
function answerWhite(ctx: AiContext, w: SimWar, q: number, enemy: number): 'yes' | 'no' | 'cede' | 'tribute' {
  const g = ctx.g;
  const ex = g.war.exhaustion(q);
  const s = g.war.warScore(q, enemy);
  const conquest = w.a === q && w.goal === 'conquest';
  if (s >= 40 && ex < 70) return 'cede';
  if (s >= 25 && ex < 70) return 'tribute';
  if (conquest && ex < 70) return 'no';
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
    // v2-stub(W1→W3): the human negotiates from W3's inbox; only its autopilot takes part here.
    if (enemy === HUMAN_ID && !g.config.humanAutopilot) continue;
    if (!ctx.brains.has(enemy)) continue;
    const ex = g.war.exhaustion(p.id);
    const s = g.war.warScore(p.id, enemy);
    const mineConquest = w.a === p.id && w.goal === 'conquest';
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
    // A stalemate both sides are tired of ends on the current lines.
    if (ex >= 35 && Math.abs(s) < 25 && answerWhite(ctx, w, enemy, p.id) === 'yes') makePeace(ctx, p.id, enemy, { kind: 'white' }, 0);
  }
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
