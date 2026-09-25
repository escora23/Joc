// FRONT ULTRA — AI perception: front analysis and threat assessment (owner: sim-ai). Worker-only.
//
// scanFront walks a nation's border once (strided for huge empires) and records, per neighbour, how long the
// shared front is and one aim tile on each side. The result is cached on the brain for a few seconds and feeds
// target selection, attack click points, armor deployment, defense-post placement and air strikes.

import { MAP_W, TILE_COUNT } from '../../shared/constants';
import type { SimPlayer } from '../../shared/simapi';
import type { AiContext } from './context';
import type { Brain } from './state';

const MAX_SCAN = 5000;

export function scanFront(ctx: AiContext, b: Brain, p: SimPlayer, maxAge: number): void {
  const g = ctx.g;
  const f = b.front;
  if (g.tick - f.tick < maxAge) return;
  f.tick = g.tick;
  f.contact.clear();
  f.aim.clear();
  f.ours.clear();
  f.shoreSample.length = 0;
  const border = g.borderTiles(p.id);
  const n = border.size;
  f.scanned = n;
  if (n === 0) return;
  const stride = n > MAX_SCAN ? n / MAX_SCAN : 1;
  let next = ctx.rng.next() * stride;
  let i = 0;
  // Random acceptance for aim tiles so the aim point is spread along the front (reservoir of size 1).
  const seen = ctx.g.tick & 0xffff;
  for (const t of border) {
    if (i++ < next) continue;
    next += stride;
    const x = t % MAP_W;
    const l = x === 0 ? t + MAP_W - 1 : t - 1;
    const r = x === MAP_W - 1 ? t - MAP_W + 1 : t + 1;
    const u = t - MAP_W;
    const d = t + MAP_W;
    let o0 = -1;
    for (let k = 0; k < 4; k++) {
      const nb = k === 0 ? l : k === 1 ? r : k === 2 ? u : d;
      if (nb < 0 || nb >= TILE_COUNT || !g.isPlayable(nb)) continue;
      const o = g.ownerOf(nb);
      if (o === p.id || o === o0) continue;
      o0 = o;
      const c = (f.contact.get(o) ?? 0) + 1;
      f.contact.set(o, c);
      // Reservoir sampling: each contact tile has a 1/c chance to become the aim tile.
      if (c === 1 || ((hashMix(t, seen) % c) === 0)) {
        f.aim.set(o, nb);
        f.ours.set(o, t);
      }
    }
    if (f.shoreSample.length < 12 && g.isShore(t)) f.shoreSample.push(t);
  }
  if (stride > 1) for (const [o, c] of f.contact) f.contact.set(o, Math.round(c * stride));
}

function hashMix(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35);
  h ^= h >>> 13;
  return (h >>> 0) & 0x7fffffff;
}

/**
 * Troops currently thrown at `pid` by everyone (`total`), and the biggest LAND assault by a single attacker (`top`,
 * `topAttacker`): only land assaults can be met head-on by a counter-attack (landings are fought by the garrison).
 */
export function incomingPressure(ctx: AiContext, pid: number): { total: number; top: number; topAttacker: number } {
  let total = 0, top = 0, topAttacker = 0;
  const per = new Map<number, number>();
  for (const a of ctx.g.incomingAttacks(pid)) {
    if (a.attacker <= 0) continue;
    total += a.troops;
    if (a.naval) continue;
    const v = (per.get(a.attacker) ?? 0) + a.troops;
    per.set(a.attacker, v);
    if (v > top) {
      top = v;
      topAttacker = a.attacker;
    }
  }
  return { total, top, topAttacker };
}

/** Troops `pid` currently has committed to attacks on players (not neutral land). */
export function committedTroops(ctx: AiContext, pid: number): number {
  let s = 0;
  for (const a of ctx.g.outgoingAttacks(pid)) s += a.troops;
  return s;
}
