// FRONT ULTRA — AI naval invasions (owner: sim-ai). Worker-only.
//
// Island nations and landlocked-in empires take the war overseas: look for landing beaches within reach
// (reach grows as the game goes on), prefer empty coast, then tribes, then weak nations, weigh distance, and send
// a transport with a share of the army. Invasions also open a second front against the current enemy.

import type { SimPlayer } from '../../shared/simapi';
import { alive, home, relation, troopFill, type AiContext } from './context';
import { dist2 } from './mapindex';
import type { Brain } from './state';

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

  const reach = Math.min(420, 90 + g.tick / 18) * (0.75 + 0.25 * b.prof.naval);
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
