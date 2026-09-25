// FRONT ULTRA — world event: pandemic (owner: sim-ai). Worker-only, deterministic.
//
// A virus breaks out in a populous nation (warning: "outbreak detected"), then spreads along land borders and
// trade links (alliances). Infected nations grow troops at half speed and lose part of their income for a couple
// of minutes, then recover with immunity. Embargoes act as quarantine: they cut the odds of transmission, so the
// AI (and the player) can wall themselves off. The renderable state follows the outbreak and lists the infected.

import type { SimPlayer } from '../../shared/simapi';
import { sharedEventState } from './bridge';
import { cx, cy, emitStage, type ActiveEvent, type EventEnv } from './common';

const WARNING_TICKS = 150;
const SPREAD_EVERY = 120;
const SICK_TICKS = 1300;
const MAX_SPREAD_TICKS = 2700;

export class Pandemic implements ActiveEvent {
  readonly kind = 'pandemic' as const;
  private t = 0;
  private readonly x: number;
  private readonly y: number;
  /** Player -> tick they recover. */
  private readonly sick = new Map<number, number>();
  private readonly immune = new Set<number>();
  private radius = 12;
  private everInfected = 0;

  constructor(readonly id: number, private readonly origin: number, tile: number, private readonly warn: boolean) {
    this.x = cx(tile);
    this.y = cy(tile);
  }

  step(env: EventEnv): boolean {
    const g = env.g;
    const warnTicks = this.warn ? WARNING_TICKS : 0;
    const t = this.t++;
    if (t === 0 && this.warn) emitStage(env, this.id, this.kind, 'warning', this.x, this.y, this.radius, 0, [this.origin]);
    if (t === warnTicks) {
      const p = g.player(this.origin);
      if (!p || !p.alive) return this.finish(env);
      this.infect(env, p);
      emitStage(env, this.id, this.kind, 'start', this.x, this.y, this.radius, 1, [this.origin]);
    }
    if (t > warnTicks) {
      // Recoveries.
      for (const [id, until] of this.sick) {
        if (until <= g.tick) {
          this.sick.delete(id);
          this.immune.add(id);
          sharedEventState(g).infected.delete(id);
        }
      }
      // Transmission along borders and trade routes.
      if (t % SPREAD_EVERY === 0 && t - warnTicks < MAX_SPREAD_TICKS) {
        const carriers = [...this.sick.keys()];
        for (const id of carriers) {
          const p = g.player(id);
          if (!p || !p.alive) continue;
          const links = new Set<number>(g.neighborsOf(id));
          for (const a of p.allies) links.add(a);
          for (const q of links) {
            if (q <= 0 || this.sick.has(q) || this.immune.has(q)) continue;
            const other = g.player(q);
            if (!other || !other.alive || other.tiles === 0) continue;
            let chance = g.sharesBorder(id, q) ? 0.3 : 0;
            if (p.allies.has(q)) chance += 0.25; // trade partners
            if (g.hasEmbargo(q, id) || g.hasEmbargo(id, q)) chance *= 0.25; // quarantine works
            if (other.kind === 'tribe') chance *= 0.5;
            if (env.rng.next() < chance) this.infect(env, other);
          }
        }
        this.updateRadius(env);
      }
      if (this.sick.size === 0) return this.finish(env);
    }
    if (t % 10 === 0) {
      g.setWorldEventState(this.id, {
        kind: this.kind, x: this.x, y: this.y, radius: this.radius,
        progress: Math.min(1, (t - warnTicks) / (MAX_SPREAD_TICKS + SICK_TICKS)), magnitude: this.sick.size,
        players: [...this.sick.keys()], heading: 0,
      });
    }
    return true;
  }

  private infect(env: EventEnv, p: SimPlayer): void {
    const g = env.g;
    const dur = SICK_TICKS + env.rng.int(500);
    this.sick.set(p.id, g.tick + dur);
    this.everInfected++;
    g.setModifier(p.id, 'troopGrowth', 0.5, dur);
    g.setModifier(p.id, 'goldIncome', 0.8, dur);
    // The AI director reads this to quarantine sick neighbours.
    sharedEventState(g).infected.set(p.id, g.tick + dur);
  }

  private updateRadius(env: EventEnv): void {
    let r = 12;
    for (const id of this.sick.keys()) {
      const p = env.g.player(id);
      if (!p || p.capitalTile < 0) continue;
      let dx = Math.abs(cx(p.capitalTile) - this.x);
      if (dx > 800) dx = 1600 - dx;
      r = Math.max(r, Math.hypot(dx, cy(p.capitalTile) - this.y) + 10);
    }
    this.radius = Math.min(160, r);
  }

  private finish(env: EventEnv): boolean {
    env.g.setWorldEventState(this.id, null);
    emitStage(env, this.id, this.kind, 'end', this.x, this.y, this.radius, this.everInfected, [...this.immune]);
    return false;
  }
}
