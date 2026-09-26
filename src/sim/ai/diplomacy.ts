// FRONT ULTRA — AI diplomacy (DESIGN_V2 §5.1–§5.6; owner: sim-ai, rewritten by W3). Worker-only.
//
// What an AI nation does with the diplomacy system (src/sim/diplomacy.ts):
//
//   * answerProposal: every proposal addressed to it is weighed at the end of its deliberation from its OPINION of the
//     sender (the sum of the §5.1 reasons, a gold sweetener counted as a gift), its situation (a common enemy, a
//     threatening neighbour, the war score and exhaustion of a war, its allies, its ports) and its personality. The
//     answer names the one or two reasons that decided it, and a refusal may carry a counter-offer (an alliance
//     between 0 and +35 becomes a pact; a white peace from a winner becomes a cession or a tribute).
//   * thinkDiplomacy (every diplomacy clock): alliances with a purpose (a common enemy or a protector), pacts when
//     threatened, trade agreements (traders with everyone they do not hate), open borders with cordial neighbours,
//     notice to allies that no longer serve, embargoes on enemies and quarantines, gold to allies under attack.
//   * ultimatumDemand: what an AI demands before a war (§5.4), shaped by the war goal.
//   * No emotes (§1.3, H02): nations speak through proposals, answers, tension and news.

import { HUMAN_ID, DIFFICULTY_INDEX } from '../../shared/constants';
import type { ProposalAnswer, SimPlayer, SimProposal, SimWar } from '../../shared/simapi';
import { UnitType, type Demand, type ReasonView, type WarGoal } from '../../shared/types';
import { alive, isMajor, landShare, relation, strength, type AiContext } from './context';
import type { Brain } from './state';
import { answerWhite, pressing } from './warplan';

/** Are `a` and `b` currently fighting (the declared war state, §4.1)? */
export function atWar(ctx: AiContext, a: number, b: number): boolean {
  return ctx.g.war.atWar(a, b);
}

/** How many alliances this brain wants at most. */
export function maxAllies(b: Brain): number {
  return b.prof.diplomacy >= 0.8 ? 2 : 1;
}

/** A proposal from the human asks a little more of the AI on harder difficulties (Easy −5 … Insane +10). */
const HUMAN_BAR = [-5, 0, 5, 10] as const;

/** An enemy `p` and `q` both fight, or 0. */
function commonEnemy(ctx: AiContext, p: number, q: number): number {
  const g = ctx.g;
  for (const e of g.war.enemiesOf(p)) if (e !== q && g.war.atWar(q, e)) return e;
  return 0;
}

/** A neighbour that could swallow `p` (twice its land and bordering it), other than `except`. */
function threatOf(ctx: AiContext, p: SimPlayer, except: number): number {
  const g = ctx.g;
  for (const id of g.neighborsOf(p.id)) {
    if (id === 0 || id === except) continue;
    const q = g.player(id);
    if (alive(q) && isMajor(q) && q.tiles >= p.tiles * 2 && !g.isAllied(p.id, id)) return id;
  }
  return 0;
}

function hasNavy(ctx: AiContext, p: number): boolean {
  return ctx.g.units(p, UnitType.Warship).length > 0;
}

const r = (key: string, params?: Record<string, string | number>, value?: number): ReasonView => {
  const v: ReasonView = { key };
  if (params) v.params = params;
  if (value !== undefined) v.value = value;
  return v;
};

// =================================================================================================
// Answers (§5.3)
// =================================================================================================
export function answerProposal(ctx: AiContext, b: Brain, p: SimPlayer, prop: SimProposal): ProposalAnswer {
  const g = ctx.g;
  const dip = g.diplomacy;
  const from = g.player(prop.from);
  if (!alive(from)) return { accept: false, reasons: [r('answer.obsolete')] };
  const o = dip.opinion(p.id, from.id);
  const gift = dip.giftValue(p.id, prop.gold);
  const oe = o + gift;
  const bar = from.id === HUMAN_ID ? HUMAN_BAR[DIFFICULTY_INDEX[g.difficulty]] : 0;
  const reasons = dip.reasons(p.id, from.id);
  const best = reasons.find((x) => (x.value ?? 0) > 0);
  const worst = reasons.find((x) => (x.value ?? 0) < 0);
  const goldR = gift > 0 ? [r('answer.goldHelps', { gold: prop.gold, value: gift })] : [];
  const yes = (first: ReasonView, extra?: ReasonView): ProposalAnswer => ({ accept: true, reasons: [first, ...goldR, ...(extra ? [extra] : [])] });
  const no = (first: ReasonView, extra?: ReasonView, counter?: ProposalAnswer['counter']): ProposalAnswer => ({
    accept: false, reasons: [first, ...(extra ? [extra] : [])], counter,
  });
  const low = (need: number) => r('answer.lowOpinion', { score: Math.round(oe), need });

  switch (prop.kind) {
    case 'alliance': {
      if (from.traitorUntilTick > g.tick) return no(r('answer.traitor'));
      if (relation(b, from.id).betrayedUs) return no(r('answer.betrayedUs'));
      const need = 35 + bar;
      const enemy = commonEnemy(ctx, p.id, from.id);
      const threat = g.sharesBorder(p.id, from.id) && from.tiles >= p.tiles * 2;
      const protector = strength(from) >= strength(p) * 1.5 && !threat;
      const full = p.allies.size >= maxAllies(b);
      const napCounter = oe >= 0 && !dip.hasTreaty(p.id, from.id, 'nap') ? { kind: 'nap' as const } : undefined;
      if (full) return no(r('answer.tooManyAllies'), undefined, napCounter);
      if (oe < need) return no(low(need), worst, napCounter);
      if (!enemy && !protector) return no(r('answer.noPurpose'), undefined, napCounter);
      return yes(enemy ? r('answer.commonEnemy', { player: enemy }) : r('answer.protector'), best);
    }
    case 'nap': {
      const need = 0 + bar;
      const enemies = g.war.enemiesOf(p.id).filter((e) => e !== from.id);
      const threat = enemies[0] ?? threatOf(ctx, p, from.id);
      if (oe >= need) return yes(threat ? r('answer.threatened', { player: threat }) : r('answer.goodRelations', { score: Math.round(oe) }), best);
      if (threat && oe >= -20 + bar) return yes(r('answer.threatened', { player: threat }));
      return no(low(need), worst);
    }
    case 'trade': {
      if (!dip.hasPorts(p.id)) return no(r('answer.noPorts'));
      if (!dip.hasPorts(from.id)) return no(r('answer.noPortsYou'));
      const need = -10 + bar - (b.personality === 'trader' ? 10 : 0);
      if (oe >= need) return yes(r(b.personality === 'trader' ? 'answer.tradeLove' : 'answer.tradeGood'), best);
      return no(low(need), worst);
    }
    case 'openBorders': {
      const need = 20 + bar;
      if (oe >= need) return yes(r('answer.goodRelations', { score: Math.round(oe) }), best);
      return no(low(need), worst);
    }
    case 'peace':
      return answerPeace(ctx, p, from, prop, goldR);
    case 'callToArms':
      return answerCall(ctx, b, p, from, prop, o);
    case 'demand':
      return answerDemand(ctx, b, p, from, prop.demand, oe, worst);
  }
  return no(r('answer.declined'));
}

function answerPeace(ctx: AiContext, p: SimPlayer, from: SimPlayer, prop: SimProposal, goldR: ReasonView[]): ProposalAnswer {
  const g = ctx.g;
  const w = g.war.between(p.id, from.id) as SimWar | undefined;
  if (!w) return { accept: false, reasons: [r('answer.obsolete')] };
  const t = prop.terms ?? { kind: 'white' };
  const ex = Math.round(g.war.exhaustion(p.id));
  const s = Math.round(g.war.warScore(p.id, from.id));
  if (t.kind === 'white') {
    const ans = answerWhite(ctx, w, p.id, from.id);
    if (ans === 'yes') return { accept: true, reasons: [ex >= 35 ? r('answer.exhausted', { ex }) : r('answer.goalMet'), ...goldR] };
    const band = Math.max(1, Math.round(from.tiles * 0.1));
    if (ans === 'cede') {
      return { accept: false, reasons: [r('answer.winning', { score: s, ex }), r('answer.wantCession', { tiles: band })], counter: { kind: 'peace', terms: { kind: 'cede', loser: from.id, tiles: band } } };
    }
    if (ans === 'tribute') return { accept: false, reasons: [r('answer.winning', { score: s, ex }), r('answer.wantTribute')], counter: { kind: 'peace', terms: { kind: 'tribute', loser: from.id } } };
    if (pressing(ctx, w, p.id)) return { accept: false, reasons: [r('answer.onlySurrender')] };
    return { accept: false, reasons: [r('answer.notTired', { ex })] };
  }
  if (t.loser === p.id) {
    // We cede or pay: only when losing, or too tired to go on.
    if (s <= -25 || ex >= 60) return { accept: true, reasons: [s <= -25 ? r('answer.losing', { score: s }) : r('answer.exhausted', { ex }), ...goldR] };
    if (answerWhite(ctx, w, p.id, from.id) === 'yes' && s <= 0) return { accept: true, reasons: [r('answer.exhausted', { ex }), ...goldR] };
    return { accept: false, reasons: [r('answer.canResist', { score: s })] };
  }
  // They cede or pay us.
  if (pressing(ctx, w, p.id) && ex < 70) return { accept: false, reasons: [r('answer.onlySurrender')] };
  return { accept: true, reasons: [r('answer.termsGood'), ...goldR] };
}

/**
 * A call to arms (§5.5). Defensive (the asker was attacked): yes with probability 0.5 + 0.5·loyalty when it borders the
 * aggressor or has a navy, 0.3 + 0.5·loyalty otherwise. A request for help in the asker's own war weighs opinion, the
 * ally's exhaustion and the enemy's strength.
 */
function answerCall(ctx: AiContext, b: Brain, p: SimPlayer, from: SimPlayer, prop: SimProposal, o: number): ProposalAnswer {
  const g = ctx.g;
  const X = g.player(prop.target);
  if (!alive(X)) return { accept: false, reasons: [r('answer.obsolete')] };
  const w = g.war.between(from.id, X.id);
  const defensive = !!w && w.b === from.id;
  const borders = g.sharesBorder(p.id, X.id);
  const navy = hasNavy(ctx, p.id);
  const ex = g.war.exhaustion(p.id);
  let odds: number;
  let why: ReasonView;
  if (defensive) {
    odds = (borders || navy ? 0.5 : 0.3) + 0.5 * b.prof.loyalty + (o - 35) / 400;
    why = !borders && !navy ? r('answer.tooFar', { player: X.id }) : r('answer.lowLoyalty');
    if (ex > 50) {
      odds *= 0.3;
      why = r('answer.exhausted', { ex: Math.round(ex) });
    }
  } else {
    if (!borders && !navy) return { accept: false, reasons: [r('answer.tooFar', { player: X.id })] };
    if (g.war.enemiesOf(p.id).length > 0) return { accept: false, reasons: [r('answer.ownWar')] };
    if (ex > 40) return { accept: false, reasons: [r('answer.exhausted', { ex: Math.round(ex) })] };
    if (strength(X) > strength(p) * 2.5) return { accept: false, reasons: [r('answer.enemyTooStrong', { player: X.id })] };
    odds = (borders ? 0.35 : 0.15) + 0.3 * b.prof.loyalty + (o - 35) / 300;
    why = o < 20 ? r('answer.lowOpinion', { score: Math.round(o), need: 20 }) : r('answer.lowLoyalty');
  }
  if (ctx.rng.next() < Math.max(0, Math.min(0.95, odds))) return { accept: true, reasons: [r('answer.allyDuty', { player: from.id, enemy: X.id })] };
  return { accept: false, reasons: [why] };
}

/** A demand (§5.3, §5.4): a nation yields to force, not to words; the size of the demand and personality weigh in. */
function answerDemand(ctx: AiContext, b: Brain, p: SimPlayer, from: SimPlayer, d: Demand | undefined, oe: number, worst: ReasonView | undefined): ProposalAnswer {
  const g = ctx.g;
  if (!d) return { accept: false, reasons: [r('answer.declined')] };
  // Its own strength counts its allies (they would answer a call to arms).
  let mine = strength(p);
  for (const a of p.allies) {
    const A = g.player(a);
    if (alive(A) && a !== from.id) mine += strength(A) * 0.5;
  }
  const ratio = strength(from) / Math.max(1, mine);
  const pers = b.personality === 'turtle' || b.personality === 'trader' ? 1.3 : b.personality === 'conqueror' ? 0.4 : b.personality === 'nuker' ? 0.8 : 0.9;
  let size = 1;
  if (d.kind === 'cede') size = 1 - 0.3 * Math.min(1, (d.tiles ?? 0) / Math.max(1, p.tiles * 0.05));
  else if (d.kind === 'tribute') size = 1 - 0.8 * Math.max(0, (d.gold ?? 0) / Math.max(1, p.gold) - 0.2);
  else if (d.kind === 'breakAlliance') size = d.target && g.diplomacy.opinion(p.id, d.target) > 40 ? 0.5 : 0.9;
  else size = 1.2;
  const will = ratio * pers * size * (1 + Math.max(-0.3, Math.min(0.3, oe / 100)));
  const ratioTxt = Math.round(ratio * 10) / 10;
  if (will >= 1.6) return { accept: true, reasons: [r('answer.demandYield', { ratio: ratioTxt })] };
  return { accept: false, reasons: [r(ratio < 1 ? 'answer.weAreStronger' : 'answer.weStand', { ratio: ratioTxt }), ...(worst ? [worst] : [])] };
}

// =================================================================================================
// Ultimatums (§5.4)
// =================================================================================================
/** Ultimatum probability by personality (§5.7 step 4). */
export const ULTIMATUM_ODDS: Record<string, number> = { turtle: 1, trader: 1, nuker: 0.8, conqueror: 0.7, opportunist: 0.6 };
/** Probability a refused ultimatum ends in war, by personality (§5.4). */
export const REFUSAL_WAR_ODDS: Record<string, number> = { conqueror: 0.9, opportunist: 0.8, nuker: 0.7, trader: 0.5, turtle: 0.4 };

/** What `p` demands of `q` before a war with goal `goal`, or null when nothing fits (a surprise attack follows). */
export function ultimatumDemand(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer, goal: WarGoal): Demand | null {
  const g = ctx.g;
  if (q.embargoes.has(p.id) && goal !== 'conquest') return { kind: 'endEmbargo' };
  for (const a of q.allies) if (b.enemy === a || g.war.atWar(p.id, a)) return { kind: 'breakAlliance', target: a };
  if (goal === 'tribute' || !g.sharesBorder(p.id, q.id)) return q.gold > 0 ? { kind: 'tribute', gold: Math.round(q.gold * (goal === 'tribute' ? 0.4 : 0.3)) } : null;
  return { kind: 'cede', tiles: Math.max(3, Math.floor(q.tiles * 0.04)) };
}

// =================================================================================================
// Initiative (§5.2, §5.3)
// =================================================================================================
/** Is keeping the alliance with `q` still worth it (common enemy, a protector, or a friend)? */
export function allianceStillUseful(ctx: AiContext, _b: Brain, p: SimPlayer, q: SimPlayer): boolean {
  if (commonEnemy(ctx, p.id, q.id) > 0) return true;
  if (ctx.g.diplomacy.opinion(p.id, q.id) >= 30) return true;
  return strength(p) < strength(q) * 0.6;
}

/** Don't re-send the same kind of proposal to the same player for this long (the human may be busy). */
const PROPOSE_GAP = 2_400;

function recentlyProposed(ctx: AiContext, b: Brain, kind: string, to: number): boolean {
  const t = b.proposed.get(`${kind}:${to}`);
  return t !== undefined && ctx.g.tick - t < PROPOSE_GAP * (to === HUMAN_ID ? 1.5 : 1);
}

function send(ctx: AiContext, b: Brain, p: SimPlayer, to: number, kind: 'alliance' | 'nap' | 'trade' | 'openBorders'): boolean {
  const g = ctx.g;
  if (recentlyProposed(ctx, b, kind, to) || g.diplomacy.proposeError(p.id, to, kind)) return false;
  const ok = !!g.diplomacy.propose(p.id, to, kind);
  if (ok) b.proposed.set(`${kind}:${to}`, g.tick);
  return ok;
}

export function thinkDiplomacy(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  const dip = g.diplomacy;
  const rng = ctx.rng;
  const w = ctx.world;

  // Time heals (slowly); friends grow closer (v1 trust still feeds the military modules).
  for (const [id, rel] of b.relations) {
    rel.grievance *= 0.9;
    if (p.allies.has(id)) rel.trust = Math.min(1, rel.trust + 0.03);
    else rel.trust *= 0.985;
  }
  const busy = (q: number) => b.tension?.target === q;

  // --- allies that no longer serve get notice (48 h) ------------------------------------------------
  for (const a of p.allies) {
    const q = g.player(a);
    if (!alive(q)) continue;
    if (g.tick - relation(b, a).alliedTick < 4_800) continue;
    if (!allianceStillUseful(ctx, b, p, q) && dip.opinion(p.id, a) < 10 && rng.next() < 0.25) {
      g.issue(p.id, { type: 'leaveTreaty', target: a, treaty: 'alliance' });
      return;
    }
  }

  // --- alliances with a purpose: a common enemy or a protector (§5.2) -------------------------------
  if (p.allies.size < maxAllies(b) && rng.next() < 0.2 + b.prof.diplomacy * 0.5) {
    let best: SimPlayer | null = null, bestScore = 0;
    for (const q of g.players()) {
      if (q.id === p.id || !alive(q) || !isMajor(q) || g.isAllied(p.id, q.id) || atWar(ctx, p.id, q.id) || busy(q.id)) continue;
      if (q.traitorUntilTick > g.tick) continue;
      const o = dip.opinion(p.id, q.id);
      if (o < 35) continue;
      const enemy = commonEnemy(ctx, p.id, q.id);
      const protector = strength(q) >= strength(p) * 1.5 && !(g.sharesBorder(p.id, q.id) && q.tiles >= p.tiles * 2);
      if (!enemy && !protector) continue;
      let s = o / 50 + (enemy ? 1 : 0) + (protector ? 0.5 : 0) + rng.next() * 0.3;
      if (w.leader === q.id && w.leaderShare > b.diff.coalitionShare) s -= 2;
      // The human gets fewer unsolicited offers (a player, not a bot).
      if (q.id === HUMAN_ID) s *= 0.6;
      if (s > bestScore) {
        bestScore = s;
        best = q;
      }
    }
    if (best && bestScore > 0.9 && send(ctx, b, p, best.id, 'alliance')) return;
  }

  // --- a pact with a neighbour while another threatens us (§5.2 NAP) --------------------------------
  const threat = g.war.enemiesOf(p.id)[0] ?? threatOf(ctx, p, 0);
  if (threat && rng.next() < 0.3 + b.prof.diplomacy * 0.3) {
    for (const id of g.neighborsOf(p.id)) {
      if (id === 0 || id === threat || busy(id)) continue;
      const q = g.player(id);
      if (!alive(q) || !isMajor(q) || g.isAllied(p.id, id) || dip.hasTreaty(p.id, id, 'nap') || atWar(ctx, p.id, id)) continue;
      const o = dip.opinion(p.id, id);
      if (o >= -20 && o < 35 && rng.next() < (id === HUMAN_ID ? 0.4 : 0.8)) {
        if (send(ctx, b, p, id, 'nap')) return;
      }
    }
  }

  // --- trade agreements: traders with everyone they do not hate, others now and then ---------------
  if (dip.hasPorts(p.id) && rng.next() < (b.personality === 'trader' ? 0.6 : 0.15)) {
    for (const q of g.players()) {
      if (q.id === p.id || !alive(q) || !isMajor(q) || busy(q.id) || !dip.hasPorts(q.id)) continue;
      if (dip.hasTreaty(p.id, q.id, 'trade') || atWar(ctx, p.id, q.id) || g.hasEmbargo(p.id, q.id)) continue;
      if (dip.opinion(p.id, q.id) < (b.personality === 'trader' ? -10 : 10)) continue;
      if (q.id === HUMAN_ID && rng.next() < 0.5) continue;
      if (send(ctx, b, p, q.id, 'trade')) return;
    }
  }

  // --- open borders with a cordial neighbour (rare: most nations guard their land) ------------------
  if (rng.next() < 0.05 * b.prof.diplomacy) {
    for (const id of g.neighborsOf(p.id)) {
      if (id === 0 || busy(id) || g.isAllied(p.id, id) || dip.hasTreaty(p.id, id, 'openBorders')) continue;
      const q = g.player(id);
      if (!alive(q) || !isMajor(q) || atWar(ctx, p.id, id)) continue;
      if (dip.opinion(p.id, id) >= 30 && send(ctx, b, p, id, 'openBorders')) return;
    }
  }

  // --- embargoes & quarantines ------------------------------------------------------------------------
  const enemy = g.player(b.enemy);
  if (alive(enemy) && isMajor(enemy) && g.tick - b.enemySince > 300 && !g.isAllied(p.id, enemy.id) && !p.embargoes.has(enemy.id) && rng.next() < 0.5) {
    g.issue(p.id, { type: 'embargo', target: enemy.id, active: true });
  }
  for (const q of p.embargoes) {
    const inf = w.infected.get(q);
    if (inf !== undefined && inf > g.tick) continue;
    const calm = q !== b.enemy && !atWar(ctx, p.id, q) && dip.opinion(p.id, q) > -10;
    if (g.isAllied(p.id, q) || (calm && rng.next() < 0.2)) {
      g.issue(p.id, { type: 'embargo', target: q, active: false });
      break;
    }
  }
  for (const [q, until] of w.infected) {
    if (until <= g.tick || q === p.id || p.embargoes.has(q) || g.isAllied(p.id, q)) continue;
    if (g.sharesBorder(p.id, q) && rng.next() < 0.25 + (1 - b.prof.aggression) * 0.4) g.issue(p.id, { type: 'embargo', target: q, active: true });
  }
  const leader = g.player(w.leader);
  if (alive(leader) && leader.id !== p.id && w.leaderShare > b.diff.coalitionShare && !g.isAllied(p.id, leader.id) && rng.next() < b.prof.coalition) {
    if (!p.embargoes.has(leader.id)) g.issue(p.id, { type: 'embargo', target: leader.id, active: true });
  }

  // --- gold to allies under attack (a gift they remember, §5.1) ---------------------------------------
  if (p.allies.size > 0 && p.gold > 1_500_000 && (b.personality === 'trader' || b.personality === 'turtle') && rng.next() < 0.35) {
    for (const a of p.allies) {
      const q = g.player(a);
      if (!alive(q)) continue;
      let pressure = 0;
      for (const x of g.incomingAttacks(a)) pressure += x.troops;
      if (pressure > q.troops * 0.5) {
        g.issue(p.id, { type: 'donate', target: a, gold: Math.round(p.gold * 0.2), troops: Math.round(p.troops * 0.08) });
        relation(b, a).helpedTick = g.tick;
        break;
      }
    }
  }
}

/** Keep the pack informed of a traitor (v1 trust, read by the military modules). */
export function recordBetrayal(ctx: AiContext, breaker: number, victim: number): void {
  const w = ctx.world;
  w.betrayals.set(breaker, (w.betrayals.get(breaker) ?? 0) + 1);
  for (const b of ctx.brains.values()) {
    if (b.id === breaker) continue;
    const rel = relation(b, breaker);
    if (b.id === victim) {
      rel.betrayedUs = true;
      rel.trust = -1;
      rel.grievance += 6;
      b.enemy = breaker;
      b.enemySince = ctx.g.tick;
      b.retaliate = breaker;
      b.retaliateUntil = ctx.g.tick + 3000 * (0.5 + b.prof.vengeance);
    } else rel.trust = Math.max(-1, rel.trust - 0.25);
  }
}

/** Is `p` the kind of runaway the pack should gang up on? */
export function leaderShareOf(ctx: AiContext, p: SimPlayer): number {
  return landShare(ctx, p);
}
