// FRONT ULTRA — world events: shared types and helpers (owner: sim-ai). Worker-only, deterministic.

import { MAP_H, MAP_W } from '../../shared/constants';
import { latLonToTile } from '../../shared/geo';
import type { Rng } from '../../shared/rng';
import type { SimGame } from '../../shared/simapi';
import type { WorldEventKind } from '../../shared/types';

export interface EventEnv {
  g: SimGame;
  rng: Rng;
  /** Tiles per player a few minutes ago (overextension = fast growth). */
  pastTiles: Map<number, number>;
  /** v2 (W1): player -> last tick a nuclear weapon detonated on its land, and where (the `nuclear` cause, §5.12). */
  nuked: Map<number, { tick: number; tile: number }>;
  /** Player -> tick of its last rebellion (at most one per 7,200 ticks, §5.12). */
  lastRebellion: Map<number, number>;
}

/** A running world event. `step` returns false once it is over (it must have emitted its 'end'). */
export interface ActiveEvent {
  readonly id: number;
  readonly kind: WorldEventKind;
  step(env: EventEnv): boolean;
}

export const tileX = (t: number): number => t % MAP_W;
export const tileY = (t: number): number => (t / MAP_W) | 0;
export const cx = (t: number): number => (t % MAP_W) + 0.5;
export const cy = (t: number): number => ((t / MAP_W) | 0) + 0.5;

export function wrapTile(x: number, y: number): number {
  const yi = Math.floor(y);
  if (yi < 0 || yi >= MAP_H) return -1;
  const xi = ((Math.floor(x) % MAP_W) + MAP_W) % MAP_W;
  return yi * MAP_W + xi;
}

export function wrapDx(a: number, b: number): number {
  let d = b - a;
  if (d > MAP_W / 2) d -= MAP_W;
  if (d < -MAP_W / 2) d += MAP_W;
  return d;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = wrapDx(ax, bx), dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Lat/lon (+- jitter degrees) to a tile. */
export function placeTile(lat: number, lon: number, rng: Rng, jitterDeg: number): number {
  return latLonToTile(
    Math.max(-80, Math.min(80, lat + (rng.next() - 0.5) * 2 * jitterDeg)),
    ((lon + (rng.next() - 0.5) * 2 * jitterDeg + 540) % 360) - 180,
  );
}

/** Evenly spread sample points of a disc (rings), calling fn(tile, distance/radius). */
export function forDiscSamples(x: number, y: number, radius: number, rings: number, fn: (t: number, k: number) => void): void {
  fn(wrapTile(x, y), 0);
  for (let ring = 1; ring <= rings; ring++) {
    const r = (radius * ring) / rings;
    const steps = 6 * ring;
    for (let k = 0; k < steps; k++) {
      const a = ((k + (ring & 1) * 0.5) / steps) * Math.PI * 2;
      const t = wrapTile(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (t >= 0) fn(t, ring / rings);
    }
  }
}

/** Owners of land sampled in a disc: owner -> sample count (owner 0 excluded). */
export function ownersInDisc(g: SimGame, x: number, y: number, radius: number, out: Map<number, number>): Map<number, number> {
  out.clear();
  forDiscSamples(x, y, radius, 4, (t) => {
    if (!g.isPlayable(t)) return;
    const o = g.ownerOf(t);
    if (o > 0) out.set(o, (out.get(o) ?? 0) + 1);
  });
  return out;
}

/** Nearest playable land tile to (x, y) within maxR (spiral rings), or -1. */
export function nearestLand(g: SimGame, x: number, y: number, maxR: number): number {
  const t0 = wrapTile(x, y);
  if (t0 >= 0 && g.isPlayable(t0)) return t0;
  for (let r = 1; r <= maxR; r++) {
    const steps = Math.max(8, Math.round(r * 6.3));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const t = wrapTile(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (t >= 0 && g.isPlayable(t)) return t;
    }
  }
  return -1;
}

export function emitStage(env: EventEnv, id: number, kind: WorldEventKind, stage: 'warning' | 'start' | 'end', x: number, y: number, radius: number, magnitude: number, players: number[]): void {
  env.g.emit({ type: 'worldEvent', tick: env.g.tick, id, kind, stage, x, y, radius, magnitude, players: players.slice() });
}
