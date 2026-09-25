// FRONT ULTRA — world event: gold rush (owner: sim-ai). Worker-only, deterministic.
//
// Prospectors strike gold in a historic gold field. For three minutes whoever holds the land there collects a
// steady stream of gold in proportion to how much of the field they control — so borders nearby heat up (the AI
// director sends armies toward the field). The payout scales with the game clock so it matters late too.

import { cx, cy, emitStage, ownersInDisc, type ActiveEvent, type EventEnv } from './common';

const WARNING_TICKS = 100;
const DURATION = 1800;
const PAY_EVERY = 10;
const BONUS_EVERY = 60;

export class GoldRush implements ActiveEvent {
  readonly kind = 'goldRush' as const;
  private t = 0;
  private readonly x: number;
  private readonly y: number;
  private readonly radius: number;
  private readonly owners = new Map<number, number>();
  private readonly pending = new Map<number, number>();
  private readonly beneficiaries = new Set<number>();
  private total = 0;

  constructor(readonly id: number, tile: number, env: EventEnv, private readonly warn: boolean) {
    this.x = cx(tile);
    this.y = cy(tile);
    this.radius = 10 + env.rng.next() * 4;
  }

  step(env: EventEnv): boolean {
    const g = env.g;
    const warnTicks = this.warn ? WARNING_TICKS : 0;
    const t = this.t++;
    if (t === 0 && this.warn) emitStage(env, this.id, this.kind, 'warning', this.x, this.y, this.radius, 0, this.ownerList(env));
    if (t === warnTicks) emitStage(env, this.id, this.kind, 'start', this.x, this.y, this.radius, this.valuePerMinute(g.tick), this.ownerList(env));
    if (t >= warnTicks && t % PAY_EVERY === 0) {
      ownersInDisc(g, this.x, this.y, this.radius, this.owners);
      let n = 0;
      for (const c of this.owners.values()) n += c;
      if (n > 0) {
        const pay = (this.valuePerMinute(g.tick) / 60) * (PAY_EVERY / 10);
        // Unclaimed land pays nobody: the share of the field that is owned pays its owners.
        const samples = 61; // forDiscSamples with 4 rings
        for (const [o, c] of this.owners) {
          const gold = pay * (c / samples);
          g.addGold(o, gold);
          this.pending.set(o, (this.pending.get(o) ?? 0) + gold);
          this.beneficiaries.add(o);
          this.total += gold;
        }
      }
    }
    if (t % BONUS_EVERY === 0 && this.pending.size) {
      const tile = Math.floor(this.y) * 1600 + Math.floor(this.x);
      for (const [o, gold] of this.pending) {
        if (gold >= 1) g.emit({ type: 'goldBonus', tick: g.tick, playerId: o, gold: Math.round(gold), tile, reason: 'event' });
      }
      this.pending.clear();
    }
    const life = warnTicks + DURATION;
    if (t % 10 === 0) {
      g.setWorldEventState(this.id, {
        kind: this.kind, x: this.x, y: this.y, radius: this.radius, progress: Math.min(1, t / life),
        magnitude: t < warnTicks ? 0 : this.valuePerMinute(g.tick), players: [...this.owners.keys()], heading: 0,
      });
    }
    if (t >= life) {
      g.setWorldEventState(this.id, null);
      emitStage(env, this.id, this.kind, 'end', this.x, this.y, this.radius, Math.round(this.total), [...this.beneficiaries]);
      return false;
    }
    return true;
  }

  /** Gold per game minute for the whole field. */
  private valuePerMinute(tick: number): number {
    return Math.round(220_000 * (1 + tick / 3000));
  }

  private ownerList(env: EventEnv): number[] {
    ownersInDisc(env.g, this.x, this.y, this.radius, this.owners);
    return [...this.owners.keys()];
  }
}
