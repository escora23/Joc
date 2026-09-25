// FRONT ULTRA — AI diplomacy: alliances, trust, betrayal, embargoes, donations, emotes, coalitions (owner:
// sim-ai). Worker-only.
//
// Alliances are judged on trust (grudges, gifts, betrayals remembered forever), relative strength (the weak seek
// protection, the strong only take useful friends), shared enemies and personality. Nations renew alliances that
// still serve them, betray allies when the knife is worth it (opportunists and conquerors, weak ally next door,
// nowhere else to grow, or the ally is running away with the game), and everyone remembers traitors. Late in the
// game the pack turns on a runaway leader — including the human — with embargoes, target marks and alliances of
// convenience. The human is answered like any nation, with a human-scale reaction delay and an emote.

import { HUMAN_ID } from '../../shared/constants';
import type { SimPlayer } from '../../shared/simapi';
import type { EmoteId } from '../../shared/types';
import { alive, isMajor, landShare, randRange, relation, strength, type AiContext } from './context';
import type { Brain } from './state';

const FRIENDLY: ReadonlySet<EmoteId> = new Set(['wave', 'thumbsUp', 'heart', 'handshake', 'peace', 'crown', 'laugh']);
const HOSTILE: ReadonlySet<EmoteId> = new Set(['thumbsDown', 'angry', 'skull', 'clown', 'nuke', 'target', 'fire']);

/** Are `a` and `b` currently fighting (per the world model)? */
/** v2: the declared war state (DESIGN_V2 §4.1). */
export function atWar(ctx: AiContext, a: number, b: number): boolean {
  return ctx.g.war.atWar(a, b);
}

/** Do `p` and `q` share an enemy right now? */
function sharedEnemy(ctx: AiContext, p: SimPlayer, q: SimPlayer, bp: Brain | undefined): number {
  const g = ctx.g;
  const bq = ctx.brains.get(q.id);
  if (bp && bp.enemy > 0 && bp.enemy !== q.id && (atWar(ctx, q.id, bp.enemy) || bq?.enemy === bp.enemy)) return bp.enemy;
  if (bq && bq.enemy > 0 && bq.enemy !== p.id && atWar(ctx, p.id, bq.enemy)) return bq.enemy;
  // The runaway leader is everyone's enemy.
  const w = ctx.world;
  if (w.leader > 0 && w.leader !== p.id && w.leader !== q.id && w.leaderShare > 0.25 && !g.isAllied(p.id, w.leader) && !g.isAllied(q.id, w.leader)) return w.leader;
  return 0;
}

/** Is renewing the alliance with `q` still worth it (common enemy, a protector, or a distant friend)? */
export function allianceStillUseful(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer): boolean {
  const g = ctx.g;
  if (sharedEnemy(ctx, p, q, b) > 0) return true;
  if (!g.sharesBorder(p.id, q.id)) return relation(b, q.id).trust > 0.2;
  // A neighbour: only the weak keep hiding behind a strong friend.
  return strength(p) < strength(q) * 0.6;
}

/** How many alliances this brain wants at most. */
export function maxAllies(b: Brain): number {
  return b.prof.diplomacy >= 0.8 ? 2 : 1;
}

/** Probability that `b` accepts an alliance request from `from`. */
export function allianceOdds(ctx: AiContext, b: Brain, p: SimPlayer, from: SimPlayer): number {
  const g = ctx.g;
  const w = ctx.world;
  const r = relation(b, from.id);
  if (r.betrayedUs) return 0.02;
  if (g.tick - r.nukedTick < 9000) return 0;
  let odds = 0.1 + b.prof.diplomacy * 0.3 + r.trust * 0.35;
  // Traitors are poison.
  const betrayals = w.betrayals.get(from.id) ?? 0;
  odds -= betrayals * 0.18;
  if (from.traitorUntilTick > g.tick) odds -= 0.3;
  // Strength: the weak want protectors; the strong only friends that help.
  const rel = strength(from) / Math.max(1, strength(p));
  if (rel > 1.6) odds += 0.2;
  else if (rel < 0.4) odds -= 0.15 * (1 - b.prof.diplomacy);
  const shared = sharedEnemy(ctx, p, from, b) > 0;
  if (shared) odds += 0.3;
  // Two neighbouring powers with no common enemy are rivals, not friends.
  else if (g.sharesBorder(p.id, from.id) && rel > 0.6 && rel < 1.6) odds -= 0.25 * b.prof.aggression;
  // We are at war with them: an alliance means peace, welcome when we are losing.
  if (b.enemy === from.id || atWar(ctx, p.id, from.id)) {
    const losing = from.troops > p.troops * 1.3;
    odds += losing ? 0.1 : -0.45 * b.prof.aggression;
  }
  // Nobody allies with the runaway leader in the late game.
  if (w.leader === from.id && w.leaderShare > b.diff.coalitionShare) odds -= 0.3 + b.prof.coalition * 0.4;
  // Too many friends already.
  odds -= Math.max(0, p.allies.size + 1 - maxAllies(b)) * 0.4;
  if (from.id === HUMAN_ID) odds += (1 - b.diff.humanFocus) * 0.3;
  if (r.grievance > 2) odds -= 0.1 * r.grievance;
  return Math.max(0, Math.min(0.95, odds));
}

export function thinkDiplomacy(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  const rng = ctx.rng;
  const w = ctx.world;

  // Time heals (slowly); friends grow closer.
  for (const [id, r] of b.relations) {
    r.grievance *= 0.9;
    if (p.allies.has(id)) r.trust = Math.min(1, r.trust + 0.03);
    else r.trust *= 0.985;
  }

  // --- betrayal ------------------------------------------------------------------------------------
  if (p.traitorUntilTick <= g.tick) {
    for (const a of p.allies) {
      const q = g.player(a);
      if (!alive(q)) continue;
      const r = relation(b, a);
      if (g.tick - r.alliedTick < 1500) continue;
      if (!g.sharesBorder(p.id, a) && w.leader !== a) continue;
      const adv = p.troops / Math.max(1, q.troops);
      const neutral = b.front.contact.get(0) ?? 0;
      let temptation = (1 - b.prof.loyalty) * (adv > 2.2 ? 1 : adv > 1.5 ? 0.45 : 0.05) * (neutral > 0 ? 0.25 : 1);
      // Boxed in by friends with nowhere left to grow: the alliance becomes a cage.
      if (neutral === 0 && b.idleTicks > 1200 && adv > 1.1) temptation += (1 - b.prof.loyalty) * Math.min(1, b.idleTicks / 3600);
      if (w.leader === a && w.leaderShare > b.diff.coalitionShare) temptation += b.prof.coalition * 0.6;
      temptation -= r.trust * 0.35;
      if (a === HUMAN_ID) temptation *= b.diff.humanFocus;
      if (temptation > 0 && rng.next() < temptation * 0.3) {
        if (g.issue(p.id, { type: 'breakAlliance', target: a })) {
          b.enemy = a;
          b.enemySince = g.tick;
          r.trust = -0.6;
          b.nextWar = g.tick + 1;
          g.issue(p.id, { type: 'emote', target: a, emote: rng.next() < 0.5 ? 'clown' : 'skull' });
          return;
        }
      }
    }
  }

  // --- seek alliances (only with a purpose: a shared enemy, a protector, or a proven friend) ------------
  if (p.allies.size < maxAllies(b) && rng.next() < 0.2 + b.prof.diplomacy * 0.5) {
    let best: SimPlayer | null = null, bestScore = 0;
    for (const q of g.players()) {
      if (q.id === p.id || !alive(q) || !isMajor(q) || g.isAllied(p.id, q.id)) continue;
      if (q.id === b.enemy && !(q.troops > p.troops * 1.6)) continue;
      const r = b.relations.get(q.id);
      if (r && (r.betrayedUs || g.tick - r.attackedTick < 900)) continue;
      if (q.traitorUntilTick > g.tick) continue;
      let s = (r?.trust ?? 0) * 0.8;
      if (sharedEnemy(ctx, p, q, b) > 0) s += 1;
      // A much stronger neighbour is safer as a friend (the cautious ones think so).
      if (g.sharesBorder(p.id, q.id) && q.troops > p.troops * 1.6) s += 0.8 * (1 - b.prof.aggression * 0.5);
      if (w.leader === q.id && w.leaderShare > b.diff.coalitionShare) s -= 2;
      // The human gets fewer unsolicited offers (they are a player, not a bot).
      if (q.id === HUMAN_ID) s *= 0.5;
      s += rng.next() * 0.3;
      if (s > bestScore) {
        bestScore = s;
        best = q;
      }
    }
    if (best && bestScore > 0.75) g.issue(p.id, { type: 'allianceRequest', target: best.id });
  }

  // --- embargoes & coalition ---------------------------------------------------------------------------
  // Trade war with a lasting enemy; embargoes are lifted only once relations have genuinely cooled down.
  const enemy = g.player(b.enemy);
  if (alive(enemy) && isMajor(enemy) && g.tick - b.enemySince > 300 && !g.isAllied(p.id, enemy.id) && !g.hasEmbargo(p.id, enemy.id) && rng.next() < 0.5) {
    g.issue(p.id, { type: 'embargo', target: enemy.id, active: true });
  }
  for (const q of p.embargoes) {
    const inf = w.infected.get(q);
    if (inf !== undefined && inf > g.tick) continue;
    const r = relation(b, q);
    const calm = q !== b.enemy && !atWar(ctx, p.id, q) && g.tick - r.attackedTick > 3000 && r.trust > 0.1;
    if (g.isAllied(p.id, q) || (calm && rng.next() < 0.2)) {
      g.issue(p.id, { type: 'embargo', target: q, active: false });
      break;
    }
  }
  // Pandemic quarantine: embargo infected neighbours (the careful ones do).
  for (const [q, until] of w.infected) {
    if (until <= g.tick || q === p.id || g.hasEmbargo(p.id, q) || g.isAllied(p.id, q)) continue;
    if (g.sharesBorder(p.id, q) && rng.next() < 0.25 + (1 - b.prof.aggression) * 0.4) g.issue(p.id, { type: 'embargo', target: q, active: true });
  }
  const leader = g.player(w.leader);
  if (alive(leader) && leader.id !== p.id && w.leaderShare > b.diff.coalitionShare && !g.isAllied(p.id, leader.id) && rng.next() < b.prof.coalition) {
    if (!g.hasEmbargo(p.id, leader.id)) g.issue(p.id, { type: 'embargo', target: leader.id, active: true });
    if (!b.coalitionAnnounced && g.sharesBorder(p.id, leader.id)) {
      b.coalitionAnnounced = true;
      g.issue(p.id, { type: 'targetPlayer', target: leader.id });
      g.issue(p.id, { type: 'emote', target: leader.id, emote: 'target' });
    }
  }

  // --- help allies -----------------------------------------------------------------------------------
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

  // --- taunts ----------------------------------------------------------------------------------------
  if (alive(enemy) && isMajor(enemy) && rng.next() < 0.08) {
    const pool: EmoteId[] = b.prof.aggression > 1.1 ? ['laugh', 'fire', 'skull', 'clown'] : ['angry', 'thumbsDown', 'target'];
    g.issue(p.id, { type: 'emote', target: enemy.id, emote: rng.pick(pool) });
  }
}

/** Queue a reply to an alliance request (answered after the difficulty's reaction delay). */
export function onAllianceRequest(ctx: AiContext, b: Brain, from: number): void {
  b.pending.push({ at: ctx.g.tick + randRange(ctx, b.diff.reaction), kind: 'reply', other: from, flag: false, data: '' });
}

export function resolveReply(ctx: AiContext, b: Brain, p: SimPlayer, from: number): void {
  const g = ctx.g;
  const q = g.player(from);
  if (!alive(q)) return;
  const accept = ctx.rng.next() < allianceOdds(ctx, b, p, q);
  if (g.issue(p.id, { type: 'allianceReply', from, accept })) {
    if (from === HUMAN_ID || ctx.rng.next() < 0.3) g.issue(p.id, { type: 'emote', target: from, emote: accept ? 'handshake' : 'thumbsDown' });
  }
}

/** Someone sent us an emote: adjust trust and maybe answer in kind. */
export function onEmote(ctx: AiContext, b: Brain, from: number, emote: EmoteId): void {
  const g = ctx.g;
  const r = relation(b, from);
  let reply: EmoteId | null = null;
  if (FRIENDLY.has(emote)) {
    r.trust = Math.min(1, r.trust + (emote === 'handshake' || emote === 'peace' || emote === 'heart' ? 0.12 : 0.05));
    reply = r.trust > -0.2 ? (emote === 'wave' ? 'wave' : emote === 'crown' ? 'heart' : 'thumbsUp') : 'thumbsDown';
    // A peace offer from someone we are fighting half-heartedly: consider an alliance.
    if ((emote === 'peace' || emote === 'handshake') && b.enemy === from && b.prof.aggression < 1.2 && r.trust > -0.3) {
      b.pending.push({ at: g.tick + randRange(ctx, b.diff.reaction), kind: 'renew', other: from, flag: false, data: 'peace' });
    }
  } else if (HOSTILE.has(emote)) {
    r.trust = Math.max(-1, r.trust - 0.1);
    r.grievance += emote === 'nuke' || emote === 'target' ? 1.5 : 0.6;
    const pool: EmoteId[] = b.prof.aggression > 1.1 ? ['laugh', 'fire', 'target'] : b.personality === 'turtle' ? ['shock', 'peace'] : ['angry', 'thumbsDown'];
    reply = pool[ctx.rng.int(pool.length)];
    // Provoking a conqueror or a nuker has consequences.
    if ((b.prof.aggression > 1.2 || emote === 'nuke') && g.sharesBorder(b.id, from) && ctx.rng.next() < 0.5) {
      b.enemy = from;
      b.enemySince = g.tick;
    }
  } else if (emote === 'cry' && g.isAllied(b.id, from)) {
    b.pending.push({ at: g.tick + randRange(ctx, b.diff.reaction), kind: 'helpAlly', other: from, flag: false, data: '' });
    reply = 'heart';
  } else if (emote === 'shock') {
    reply = ctx.rng.next() < 0.5 ? 'laugh' : 'shock';
  }
  if (reply && (from === HUMAN_ID ? ctx.rng.next() < 0.85 : ctx.rng.next() < 0.3)) {
    b.pending.push({ at: g.tick + randRange(ctx, b.diff.reaction) + 10, kind: 'emote', other: from, flag: false, data: reply });
  }
}

/** Help an ally that asked for it (gold, troops, and join its war). */
export function helpAlly(ctx: AiContext, b: Brain, p: SimPlayer, ally: number): void {
  const g = ctx.g;
  const q = g.player(ally);
  if (!alive(q) || !g.isAllied(p.id, ally)) return;
  const r = relation(b, ally);
  if (r.trust < -0.2) return;
  const gold = Math.round(Math.min(p.gold * 0.25, 2_000_000) * (0.5 + b.prof.diplomacy));
  const troops = Math.round(p.troops * 0.1 * b.prof.diplomacy);
  if (gold > 20_000 || troops > 1000) g.issue(p.id, { type: 'donate', target: ally, gold, troops });
  r.helpedTick = g.tick;
  // Join the fight against whoever is hurting them.
  let top = 0, attacker = 0;
  for (const a of g.incomingAttacks(ally)) if (a.attacker > 0 && a.troops > top && !g.isAllied(p.id, a.attacker)) { top = a.troops; attacker = a.attacker; }
  if (attacker > 0) {
    b.allyTarget = attacker;
    b.allyTargetUntil = g.tick + 1800;
  }
}

/** Keep the pack informed of a traitor. */
export function recordBetrayal(ctx: AiContext, breaker: number, victim: number): void {
  const w = ctx.world;
  w.betrayals.set(breaker, (w.betrayals.get(breaker) ?? 0) + 1);
  for (const b of ctx.brains.values()) {
    if (b.id === breaker) continue;
    const r = relation(b, breaker);
    if (b.id === victim) {
      r.betrayedUs = true;
      r.trust = -1;
      r.grievance += 6;
      b.enemy = breaker;
      b.enemySince = ctx.g.tick;
      b.retaliate = breaker;
      b.retaliateUntil = ctx.g.tick + 3000 * (0.5 + b.prof.vengeance);
    } else r.trust = Math.max(-1, r.trust - 0.25);
  }
}

/** Is `p` the kind of runaway the pack should gang up on? */
export function leaderShareOf(ctx: AiContext, p: SimPlayer): number {
  return landShare(ctx, p);
}
