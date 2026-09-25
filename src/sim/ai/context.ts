// FRONT ULTRA — shared AI context passed to every decision module (owner: sim-ai). Worker-only.

import type { Rng } from '../../shared/rng';
import type { SimGame, SimPlayer } from '../../shared/simapi';
import type { MapIndex } from './mapindex';
import { newRelation, type Brain, type Relation, type WorldModel } from './state';
import { ownTileNear } from './mapindex';

export interface AiContext {
  g: SimGame;
  rng: Rng;
  index: MapIndex;
  world: WorldModel;
  brains: Map<number, Brain>;
}

export function relation(b: Brain, other: number): Relation {
  let r = b.relations.get(other);
  if (!r) {
    r = newRelation();
    b.relations.set(other, r);
  }
  return r;
}

export function alive(p: SimPlayer | undefined): p is SimPlayer {
  return !!p && p.alive && p.spawned && p.tiles > 0;
}

/** True for players that count as real powers (human and AI nations). */
export function isMajor(p: SimPlayer | undefined): boolean {
  return !!p && (p.kind === 'nation' || p.kind === 'human');
}

/** Troops as a share of the cap (0..~1.2). */
export function troopFill(p: SimPlayer): number {
  return p.troops / Math.max(1, p.maxTroops);
}

export function landShare(ctx: AiContext, p: SimPlayer): number {
  return p.tiles / Math.max(1, ctx.g.world.landTiles);
}

/** Military power estimate (troops in reserve + committed to attacks is not visible: reserve only). */
export function strength(p: SimPlayer): number {
  return p.troops + p.maxTroops * 0.15;
}

export function randRange(ctx: AiContext, r: [number, number]): number {
  return r[0] + ctx.rng.int(Math.max(1, r[1] - r[0] + 1));
}

/**
 * A tile the nation owns: its capital, else the last known home tile, else one found around it, else (rarely, for
 * scattered remnants whose capital fell) a scan of the map. -1 when nothing is found.
 */
export function home(ctx: AiContext, b: Brain, p: SimPlayer): number {
  const g = ctx.g;
  if (p.tiles === 0) return -1;
  if (p.capitalTile >= 0 && g.ownerOf(p.capitalTile) === p.id) {
    b.homeTile = p.capitalTile;
    return p.capitalTile;
  }
  if (b.homeTile >= 0 && g.ownerOf(b.homeTile) === p.id) return b.homeTile;
  if (b.homeTile >= 0) {
    const t = ownTileNear(g, p.id, b.homeTile, 40, ctx.rng, 60);
    if (t >= 0) return (b.homeTile = t);
  }
  for (const t of g.borderTiles(p.id)) return (b.homeTile = t);
  if (g.tick - b.homeCheckTick < 600) return -1;
  b.homeCheckTick = g.tick;
  const list = ctx.index.playable;
  const off = ctx.rng.int(list.length);
  for (let i = 0; i < list.length; i++) {
    const t = list[(i + off) % list.length];
    if (g.ownerOf(t) === p.id) return (b.homeTile = t);
  }
  b.homeTile = -1;
  return -1;
}
