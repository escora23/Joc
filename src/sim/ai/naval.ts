// FRONT ULTRA — AI naval invasions (owner: sim-ai). Worker-only.
//
// Island nations and landlocked-in empires take the war overseas: look for landing beaches within reach
// (reach grows as the game goes on), prefer empty coast, then tribes, then weak nations, weigh distance, and send
// a transport with a share of the army. Invasions also open a second front against the current enemy.

import type { SimPlayer } from '../../shared/simapi';
import { alive, home, relation, troopFill, type AiContext } from './context';
import { dist2 } from './mapindex';
import type { Brain } from './state';

/** Settlement cadence (ticks) and the land race it waits for (§10.6). */
export const SETTLE_EVERY = 200;
const SETTLE_FROM_TICK = 1200;
/** Settler convoys a nation runs at once. */
const SETTLE_CONVOYS = 2;
/** An island we could not reach (no sea route, no free beach) is left alone this long. */
const SETTLE_RETRY_TICKS = 6000;

/** How far (tiles) a nation's transports reach: grows through the game, longer for seafaring personalities. */
function reachOf(ctx: AiContext, b: Brain): number {
  return Math.min(420, 90 + ctx.g.tick / 18) * (0.75 + 0.25 * b.prof.naval);
}

/**
 * v2 (§10.6, T39): after the land race every nation sends settlers to the nearest unclaimed island within reach, one
 * convoy at a time: a small landing party that claims the beach and then expands over the island like any neutral land
 * (the nation's own expansion continues from the beachhead). Big islands are worth a longer trip. Islands that turn
 * out unreachable are remembered and skipped for a while, so a nation does not keep aiming at the same frozen strait.
 */
export function thinkSettle(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  if (g.tick < SETTLE_FROM_TICK || b.kind === 'rebel') return;
  const base = home(ctx, b, p);
  if (p.tiles < 12 || base < 0) return;
  // Convoys back without a foothold (no sea route, beach taken first): that island waits.
  const out = g.outgoingAttacks(p.id);
  for (const [id, i] of b.settling) {
    if (out.some((a) => a.id === id)) continue;
    b.settling.delete(id);
    const isl = ctx.index.islands[i];
    if (isl && !isl.coast.some((t) => g.ownerOf(t) === p.id)) b.settleFail.set(i, g.tick + SETTLE_RETRY_TICKS);
  }
  if (troopFill(p) < 0.3 || b.settling.size >= SETTLE_CONVOYS) return;
  const reach = reachOf(ctx, b);
  const origins: number[] = [base];
  for (const t of b.front.shoreSample) origins.push(t);
  let target = -1, targetIsl = -1, best = 0;
  const isl = ctx.index.islands;
  for (let i = 0; i < isl.length; i++) {
    if ((b.settleFail.get(i) ?? 0) > g.tick) continue;
    let sailing = false;
    for (const j of b.settling.values()) if (j === i) sailing = true;
    if (sailing) continue;
    let beach = -1;
    for (const t of isl[i].coast) {
      if (g.ownerOf(t) === 0) {
        beach = t;
        break;
      }
    }
    if (beach < 0) continue;
    let d2 = Infinity;
    for (const o of origins) d2 = Math.min(d2, dist2(beach, o));
    const d = Math.sqrt(d2);
    if (d > reach) continue;
    const score = Math.sqrt(isl[i].size) / (1 + d / 60);
    if (score > best) {
      best = score;
      target = beach;
      targetIsl = i;
    }
  }
  if (target < 0) return;
  // Settlers, not an army: enough for the beach and a first stretch of the island.
  const ratio = Math.min(0.08, Math.max(0.02, (5_000 + 100 * isl[targetIsl].size) / Math.max(1, p.troops)));
  if (g.issue(p.id, { type: 'boatAttack', targetTile: target, ratio })) {
    b.lastBoatTick = g.tick;
    b.settleFail.set(targetIsl, g.tick + SETTLE_EVERY * 3);
    let id = -1;
    for (const a of g.outgoingAttacks(p.id)) if (a.naval && a.defender === 0 && a.id > id) id = a.id;
    if (id >= 0) b.settling.set(id, targetIsl);
  } else b.settleFail.set(targetIsl, g.tick + SETTLE_RETRY_TICKS);
}

export function thinkNaval(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  const rng = ctx.rng;
  const base = home(ctx, b, p);
  if (p.tiles < 12 || base < 0) return;
  const fill = troopFill(p);
  const neutral = b.front.contact.get(0) ?? 0;
  // Busy growing on land: only islanders (little or no land frontier) sail early.
  const boxedIn = neutral === 0;
  const islander = neutral + sumEnemyContact(b) < 6;
  const eager = b.prof.naval * (boxedIn ? 1 : 0.35) * (islander ? 2 : 1) * (1 + Math.min(1, b.idleTicks / 1800));
  if (fill < 0.45 || rng.next() > Math.min(0.95, eager * 0.7)) return;
  let boats = 0;
  for (const a of g.outgoingAttacks(p.id)) if (a.naval) boats++;
  if (boats >= 2) return;

  const reach = reachOf(ctx, b);
  const origins: number[] = [base];
  for (const t of b.front.shoreSample) origins.push(t);
  let best = -1, bestScore = 0, bestOwner = -1;
  for (let k = 0; k < 36; k++) {
    const origin = origins[rng.int(origins.length)];
    const t = ctx.index.randomCoastNear(origin, reach, 8, rng);
    if (t < 0) continue;
    const o = g.ownerOf(t);
    if (o === p.id || (o !== 0 && g.isAllied(p.id, o))) continue;
    // v2: nations only across a declared war (independent territories and empty coast need none).
    if (o !== 0 && g.player(o)?.kind !== 'tribe' && !g.war.atWar(p.id, o)) continue;
    const d = Math.sqrt(dist2(t, base));
    let v: number;
    if (o === 0) v = 3;
    else {
      const q = g.player(o);
      if (!alive(q)) continue;
      // A landing fights the local garrison: what matters is their troop density, not their total army.
      const density = q.troops / Math.max(1, q.tiles);
      const odds = (p.troops * 0.3) / (density * 45 + 8_000);
      if (odds < 1) continue;
      v = q.kind === 'tribe' ? 2.4 : 1.1 * Math.min(2, odds);
      if (o === b.enemy) v *= 1.5;
      const r = b.relations.get(o);
      if (r && r.trust > 0.4) v *= 0.4;
    }
    // Landings on our own continent are pointless when we already border them by land.
    if (o !== 0 && g.sharesBorder(p.id, o)) v *= 0.3;
    const score = v / (1 + d / 220);
    if (score > bestScore) {
      bestScore = score;
      best = t;
      bestOwner = o;
    }
  }
  if (best < 0 || bestScore < 0.5) return;
  const ratio = bestOwner === 0 ? 0.18 + 0.1 * b.prof.naval : 0.3 + 0.1 * b.prof.aggression;
  if (g.issue(p.id, { type: 'boatAttack', targetTile: best, ratio: Math.min(0.5, ratio) })) {
    b.lastBoatTick = g.tick;
    if (bestOwner > 0) relation(b, bestOwner).trust -= 0.1;
  }
}

function sumEnemyContact(b: Brain): number {
  let s = 0;
  for (const [id, c] of b.front.contact) if (id !== 0) s += c;
  return s;
}
