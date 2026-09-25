// FRONT ULTRA — world event: earthquake (owner: sim-ai). Worker-only, deterministic.
//
// Seismic activity is detected along a real fault zone (warning), then the main shock hits: structures inside the
// radius collapse with a probability that falls off with distance and grows with magnitude, garrisons in the
// area take casualties, and two weaker aftershocks follow. The renderable state carries the magnitude (Richter)
// and the elapsed progress so the globe/fx can ripple the ground and the UI can fly the camera there.

import type { SimStructure } from '../../shared/simapi';
import { cx, cy, emitStage, forDiscSamples, type ActiveEvent, type EventEnv } from './common';

const WARNING_TICKS = 120;
const LIFETIME = 420;
const AFTERSHOCKS = [140, 260];

export class Earthquake implements ActiveEvent {
  readonly kind = 'earthquake' as const;
  private t = 0;
  private readonly x: number;
  private readonly y: number;
  private readonly radius: number;
  private affected: number[] = [];

  constructor(readonly id: number, tile: number, private readonly magnitude: number, private readonly warn: boolean) {
    this.x = cx(tile);
    this.y = cy(tile);
    // Magnitude 6.5 shakes ~9 tiles (~220 km); 9.0 flattens ~28 tiles.
    this.radius = 9 + (magnitude - 6.5) * 7.6;
  }

  step(env: EventEnv): boolean {
    const g = env.g;
    const warnTicks = this.warn ? WARNING_TICKS : 0;
    if (this.t === 0) {
      if (this.warn) emitStage(env, this.id, this.kind, 'warning', this.x, this.y, this.radius, this.magnitude, []);
      else this.mainShock(env);
    } else if (this.warn && this.t === warnTicks) this.mainShock(env);
    else if (this.t > warnTicks && AFTERSHOCKS.includes(this.t - warnTicks)) this.shake(env, 0.3, this.radius * 0.7);
    this.t++;
    const life = warnTicks + LIFETIME;
    if (this.t % 5 === 0 || this.t >= life) {
      const progress = Math.min(1, this.t / life);
      g.setWorldEventState(this.id, {
        kind: this.kind, x: this.x, y: this.y, radius: this.radius, progress,
        magnitude: this.t < warnTicks ? 0 : this.magnitude, players: this.affected, heading: 0,
      });
    }
    if (this.t >= life) {
      g.setWorldEventState(this.id, null);
      emitStage(env, this.id, this.kind, 'end', this.x, this.y, this.radius, this.magnitude, this.affected);
      return false;
    }
    return true;
  }

  private mainShock(env: EventEnv): void {
    this.affected = this.shake(env, 1, this.radius);
    emitStage(env, this.id, this.kind, 'start', this.x, this.y, this.radius, this.magnitude, this.affected);
  }

  /** Damage pass: structures collapse, garrisons take casualties. Returns the affected players. */
  private shake(env: EventEnv, strength: number, radius: number): number[] {
    const g = env.g;
    const power = Math.max(0.05, (this.magnitude - 5.8) / 3) * strength;
    const hit: SimStructure[] = g.structuresNear(this.x, this.y, radius);
    for (const s of hit) {
      const dx = cx(s.tile) - this.x, dy = cy(s.tile) - this.y;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) / radius);
      const p = Math.min(0.92, Math.pow(1 - d, 1.3) * power * 1.25);
      if (env.rng.next() < p) g.destroyStructure(s.id, 0);
    }
    // Casualties proportional to how much of each owner's land shook (sampled).
    const share = new Map<number, number>();
    let n = 0;
    forDiscSamples(this.x, this.y, radius, 4, (t, k) => {
      if (!g.isPlayable(t)) return;
      n++;
      const o = g.ownerOf(t);
      if (o > 0) share.set(o, (share.get(o) ?? 0) + (1 - k * 0.6));
    });
    const out: number[] = [];
    for (const [o, w] of share) {
      const p = g.player(o);
      if (!p || !p.alive) continue;
      const areaTiles = (w / Math.max(1, n)) * Math.PI * radius * radius;
      const frac = Math.min(0.3, (areaTiles / Math.max(1, p.tiles)) * 0.35 * power);
      if (frac > 0) g.addTroops(o, -p.troops * frac);
      out.push(o);
    }
    return out;
  }
}
