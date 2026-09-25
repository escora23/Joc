// FRONT ULTRA — AI land war: expansion, target selection, attack sizing, counter-attacks (owner: sim-ai).
//
// Priorities every war tick:
//   1. Defend: annihilate big incoming assaults with a counter-attack (hard+), hold troops when swamped.
//   2. Grab neutral land while there is any (the land race decides the early game), then eat adjacent tribes.
//   3. Fight: score every non-allied neighbour (relative strength and troop density, front length, grudges,
//      traitors, coalition against the leader, the human's size, opportunism, ally requests, gold rushes) and
//      push the best one with the troops above the personality/difficulty reserve.
// Anti-stagnation: a nation that has not grown for a while gets bolder until something gives.

import { HUMAN_ID } from '../../shared/constants';
import type { SimPlayer } from '../../shared/simapi';
import { alive, relation, troopFill, type AiContext } from './context';
import { incomingPressure, scanFront } from './perception';
import type { Brain } from './state';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Ticks of pure land-grab at the start before nations start picking fights (unless boxed in). */
const LAND_RUSH_TICKS = 900;

export function thinkWar(ctx: AiContext, b: Brain, p: SimPlayer, interval: number): void {
  const g = ctx.g;
  const rng = ctx.rng;
  scanFront(ctx, b, p, Math.max(20, interval * 2));
  const diff = b.diff, prof = b.prof;
  const fill = troopFill(p);

  // Anti-stagnation.
  if (p.tiles <= b.lastTiles) b.idleTicks += interval;
  else b.idleTicks = Math.max(0, b.idleTicks - interval * 2);
  b.lastTiles = p.tiles;
  const idleBoost = 1 + Math.min(0.8, b.idleTicks / 2400);

  // Sloppy nations sometimes just sit there.
  if (rng.next() < diff.sloppiness * 0.8) return;

  // Early on land is everything (lean reserve); later a solid reserve keeps growth near its peak (~55% of the cap)
  // and makes the nation expensive to invade.
  const phase = g.tick < 600 ? 0.55 : g.tick < 1800 ? 0.8 : 1;
  let reserve = clamp((prof.reserve + diff.reserveDelta) * phase, 0.15, 0.75);
  // Rebels hold their ground first (troops at home defend the province), then strike back in measured blows.
  if (b.kind === 'rebel') reserve = g.tick - b.enemySince < 600 ? 0.9 : 0.5;

  // --- 1. Defense ---------------------------------------------------------------------------------
  const inc = incomingPressure(ctx, p.id);
  let swamped = false;
  if (inc.total > 0) {
    if (inc.topAttacker > 0) {
      const r = relation(b, inc.topAttacker);
      r.attackedTick = g.tick;
      r.grievance = Math.min(10, r.grievance + inc.top / Math.max(1, p.troops) * 0.5);
      r.trust = Math.max(-1, r.trust - 0.02);
    }
    swamped = inc.total > p.troops * 0.7;
    const att = g.player(inc.topAttacker);
    if (diff.counterAttack && att && att.alive && inc.top > p.troops * 0.12 && g.sharesBorder(p.id, att.id) && !g.isAllied(p.id, att.id)) {
      // Send just enough to annihilate their assault (opposing attacks cancel out), if we can spare it.
      const want = Math.min(inc.top * 1.08, p.troops * 0.65);
      if (want > inc.top * 0.5) {
        const ratio = clamp(want / Math.max(1, p.troops), 0.05, 0.65);
        const aim = b.front.aim.get(att.id) ?? att.capitalTile;
        g.issue(p.id, { type: 'attack', target: att.id, ratio, tile: aim });
        if (b.enemy !== att.id) {
          b.enemy = att.id;
          b.enemySince = g.tick;
        }
        return;
      }
    }
  }

  const contact = b.front.contact;
  const neutral = contact.get(0) ?? 0;

  // --- 2. Neutral land ----------------------------------------------------------------------------
  if (neutral > 0 && b.kind !== 'rebel') {
    const minFill = clamp(reserve * (g.tick < 900 ? 0.5 : 0.85), 0.12, 0.5);
    if (fill > minFill) {
      let neutralTroops = 0;
      for (const a of g.outgoingAttacks(p.id)) if (a.defender === 0 && !a.naval) neutralTroops += a.troops;
      // Early on, neutral land is everything: pour troops in. Keep a running attack fed, not flooded.
      const early = g.tick < LAND_RUSH_TICKS * 2 ? 1.25 : 1;
      if (neutralTroops < p.troops * 0.6) {
        const ratio = clamp(((fill - minFill) / Math.max(0.01, fill)) * 0.55 * prof.expansion * early * (0.7 + 0.3 * diff.efficiency), 0.06, 0.5);
        let aim = b.front.aim.get(0) ?? b.homeTile;
        if (b.rushTile >= 0 && g.tick < b.rushUntil && g.ownerOf(b.rushTile) === 0) aim = b.rushTile;
        g.issue(p.id, { type: 'attack', target: 0, ratio, tile: aim });
      }
      // In the land rush phase nations do not start wars unless they are boxed in.
      if (g.tick < LAND_RUSH_TICKS && neutral > 6) return;
    }
  }

  // --- 3. Player war ------------------------------------------------------------------------------
  if (swamped && b.kind !== 'rebel') return;
  if (fill < reserve * 0.9 && b.kind !== 'rebel') return;

  let best: SimPlayer | null = null, bestScore = 0;
  const sloppy = rng.next() < diff.sloppiness;
  for (const [id, c] of contact) {
    if (id === 0) continue;
    const q = g.player(id);
    if (!alive(q) || g.isAllied(p.id, id)) continue;
    // The player gets a grace period to find their feet (shorter on harder difficulties).
    if (q.id === HUMAN_ID && b.kind !== 'autopilot' && g.tick < diff.humanGrace && !g.config.humanAutopilot) continue;
    let s = scoreTarget(ctx, b, p, q, c, neutral);
    if (sloppy) s *= 0.5 + rng.next();
    if (s > bestScore) {
      bestScore = s;
      best = q;
    }
  }
  // A full army sitting at home wastes growth: saturated nations lower their bar.
  const saturation = fill > 0.85 ? 0.6 : fill > 0.7 ? 0.8 : 1;
  // Boxed in by allies only: time to reconsider those friendships.
  if (!best && neutral === 0 && fill > 0.85 && b.idleTicks > 1800 && p.allies.size > 0) b.nextDiplomacy = Math.min(b.nextDiplomacy, g.tick + 5);
  const threshold = b.kind === 'rebel' ? 0.5 : saturation / (idleBoost * (neutral > 0 ? 0.7 : 1));
  if (best && bestScore < threshold && fill > 0.92 && b.idleTicks > 900 && g.tick > 3600) {
    // Capped out and idle: spend the surplus nibbling the thinnest hostile neighbour (every troop above the cap
    // is wasted growth, and thinly held land falls cheaply).
    best = thinnestNeighbour(ctx, b, p);
    if (best) bestScore = threshold;
  }
  if (!best || bestScore < threshold) return;
  // Opening grace: nations do not devour each other in the first minutes unless the odds are crushing.
  if (best.kind === 'nation' || best.kind === 'human') {
    const need = g.tick < 1800 ? 3.2 : g.tick < 3600 ? 1.8 : 0;
    if (need > 0 && p.troops < best.troops * need) return;
  }

  // How many simultaneous player wars we accept.
  let wars = 0, onBest = 0;
  for (const a of g.outgoingAttacks(p.id)) {
    if (a.defender === 0 || a.naval) continue;
    wars++;
    if (a.defender === best.id) onBest += a.troops;
  }
  const maxWars = 1 + (prof.aggression * diff.aggression > 1.15 ? 1 : 0) + (p.tiles > 4000 ? 1 : 0);
  if (onBest === 0 && wars >= maxWars) return;

  const avail = p.troops - reserve * p.maxTroops;
  // Never dig into the reserve for an offensive (tribes are cheap prey and rebels fight for survival).
  if (avail < p.troops * 0.04 && best.kind !== 'tribe' && b.kind !== 'rebel') return;
  let ratio = clamp(avail / Math.max(1, p.troops) + prof.attackBoost, 0.06, g.tick < 3600 ? 0.3 : 0.5);
  if (b.kind === 'rebel') ratio = Math.min(ratio, 0.3);
  if (best.kind === 'tribe') ratio = Math.min(ratio, 0.45);
  const sent = p.troops * ratio;
  // Do not bother with pinpricks against big armies (they only feed the enemy's counter-attacks).
  // (Huge but thinly spread empires are fair game: their troops are everywhere but here.)
  const thin = best.troops / Math.max(1, best.tiles) < (p.troops / Math.max(1, p.tiles)) * 1.3;
  if (best.kind !== 'tribe' && !thin && sent < best.troops * 0.22 && onBest === 0 && b.kind !== 'rebel') return;
  // Feeding an attack that is already much larger than the defender is waste.
  if (onBest > best.troops * 1.6 + 20_000) return;

  const aim = b.front.aim.get(best.id) ?? best.capitalTile;
  if (g.issue(p.id, { type: 'attack', target: best.id, ratio, tile: aim })) {
    if (b.enemy !== best.id) {
      b.enemy = best.id;
      b.enemySince = g.tick;
    }
    b.idleTicks = Math.max(0, b.idleTicks - 600);
  }
}

/** Non-allied neighbour with the lowest troop density (relative to ours), or null. */
function thinnestNeighbour(ctx: AiContext, b: Brain, p: SimPlayer): SimPlayer | null {
  const g = ctx.g;
  const mine = p.troops / Math.max(1, p.tiles);
  let best: SimPlayer | null = null, bestD = mine * 1.6;
  for (const [id, c] of b.front.contact) {
    if (id === 0 || c < 3) continue;
    const q = g.player(id);
    if (!alive(q) || g.isAllied(p.id, id)) continue;
    const r = b.relations.get(id);
    if (r && r.trust > 0.5) continue;
    const d = q.troops / Math.max(1, q.tiles);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** How attractive `q` is as a victim for `p` (> 1 = attack). */
export function scoreTarget(ctx: AiContext, b: Brain, p: SimPlayer, q: SimPlayer, contact: number, neutral: number): number {
  const g = ctx.g;
  const w = ctx.world;
  const prof = b.prof, diff = b.diff;
  const ratio = (p.troops + 1) / (q.troops + 1);
  const myDensity = p.troops / Math.max(1, p.tiles);
  const theirDensity = q.troops / Math.max(1, q.tiles);
  const dens = (myDensity + 1) / (theirDensity + 1);
  let s = Math.pow(Math.min(4, ratio), 0.85) * Math.pow(Math.min(3, dens), 0.35);
  // Longer fronts are easier to push; a tiny contact is a poor place to fight.
  s *= 0.55 + 0.45 * Math.min(1, contact / 30);
  if (q.kind === 'tribe') s *= 2.4;
  if (q.kind === 'rebel') s *= ctx.brains.get(q.id)?.parent === p.id ? 2.6 : 1.5;
  if (b.kind === 'rebel') s *= q.id === b.parent ? 3 : 0.5;
  if (q.traitorUntilTick > g.tick) s *= 1.35;
  const r = b.relations.get(q.id);
  if (r) {
    if (g.tick - r.attackedTick < 1500) s *= 1.25 + prof.vengeance * 0.5;
    if (r.betrayedUs) s *= 1.4 + prof.vengeance * 0.6;
    if (g.tick - r.nukedTick < 3000) s *= 1.8;
    s *= 1 + Math.min(0.6, r.grievance * 0.06);
    if (r.trust > 0.4) s *= 0.65;
  }
  if (b.enemy === q.id) s *= 1.3;
  if (b.retaliate === q.id && g.tick < b.retaliateUntil) s *= 1.5;
  if (b.allyTarget === q.id && g.tick < b.allyTargetUntil) s *= 1.6;
  // Coalition against a runaway leader.
  if (w.leader === q.id && w.leaderShare > diff.coalitionShare) s *= 1 + prof.coalition * (1 + (w.leaderShare - diff.coalitionShare) * 4);
  if (q.id === HUMAN_ID && b.kind !== 'autopilot') s *= diff.humanFocus;
  // Opportunists love a victim already bleeding elsewhere.
  if (prof.opportunism > 0) {
    let bleeding = 0;
    for (const a of g.incomingAttacks(q.id)) if (a.attacker !== p.id) bleeding += a.troops;
    s *= 1 + prof.opportunism * Math.min(1, bleeding / Math.max(1, q.troops));
  }
  // Their allies are our friends' friends: less attractive.
  for (const a of q.allies) if (p.allies.has(a)) { s *= 0.6; break; }
  // Gold rush beyond their border.
  if (w.rushTile >= 0 && g.tick < w.rushUntil && g.ownerOf(w.rushTile) === q.id) s *= 1.25;
  // While neutral land remains, war is a distraction.
  if (neutral > 0 && q.kind !== 'tribe') s *= 0.55;
  return s * prof.aggression * diff.aggression;
}

/** Tribes: grab land early, bully weaker tribes, never start wars with nations. */
export function thinkTribe(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  scanFront(ctx, b, p, 60);
  const fill = troopFill(p);
  if (fill < 0.35) return;
  const neutral = b.front.contact.get(0) ?? 0;
  if (neutral > 0) {
    // Early land grab, slowing down as the clan grows.
    const ratio = p.tiles < 250 ? 0.35 : p.tiles < 600 ? 0.2 : 0.1;
    if (p.tiles < 900 || ctx.rng.next() < 0.3) g.issue(p.id, { type: 'attack', target: 0, ratio, tile: b.front.aim.get(0) ?? b.homeTile });
    return;
  }
  if (fill < 0.8 || ctx.rng.next() < 0.6) return;
  for (const [id] of b.front.contact) {
    const q = g.player(id);
    if (!alive(q) || q.kind !== 'tribe' || q.troops > p.troops * 0.6) continue;
    g.issue(p.id, { type: 'attack', target: id, ratio: 0.4, tile: b.front.aim.get(id) ?? q.capitalTile });
    return;
  }
}
