// FRONT ULTRA — the Doomsday Clock (owner: sim-ai; v2 rules by W1). Worker-only, deterministic.
//
// v2 (DESIGN_V2 §5.11): the clock measures escalation instead of driving it. Its level (0..1, shown as minutes to
// midnight, 12 − 11.5 × level) is 0.25 × (nuclear detonations in the last 30 days)^0.7 + 0.10 × (wars at escalation L3
// or above) + 0.004 × (silo levels in the world). It only affects AI decisions at L4 and the music. Each whole minute
// the clock loses is announced (SimEvent 'doomsday' -> breaking news); the level reaches the HUD via game.setDoomsday.

import type { SimEvent } from '../../shared/protocol';
import { StructureType, UnitType } from '../../shared/types';
import type { EventEnv } from './common';

const MINUTES = 12;

export class DoomsdayClock {
  private active = false;
  private level = 0;
  private lastMinute = MINUTES + 1;
  private eventId = 0;
  /** Ticks of the nuclear detonations (warheads of one MIRV count once per tick). */
  private readonly detonations: number[] = [];
  private forced = 0;

  onEvent(e: SimEvent): void {
    if (e.type !== 'nukeDetonated' || e.weapon === UnitType.CruiseMissile) return;
    if (e.weapon === UnitType.MirvWarhead && this.detonations[this.detonations.length - 1] === e.tick) return;
    this.detonations.push(e.tick);
  }

  /**
   * v2 (§5.11): the clock MEASURES escalation instead of driving it:
   * level = min(1, 0.25 × (detonations in the last 30 days)^0.7 + 0.10 × (wars at L3 or above) + 0.004 × (silo levels)).
   */
  step(env: EventEnv): void {
    const g = env.g;
    const tick = g.tick;
    if (tick % 50 !== 0) return;
    while (this.detonations.length && this.detonations[0] <= tick - 7_200) this.detonations.shift();
    let wars = 0;
    for (const w of g.war.list()) if (Math.max(w.escalation[0], w.escalation[1]) >= 3) wars++;
    let siloLevels = 0;
    for (const s of g.structures(undefined, StructureType.MissileSilo)) if (s.built >= 1) siloLevels += s.level;
    const level = Math.min(1, Math.max(this.forced, 0.25 * Math.pow(this.detonations.length, 0.7) + 0.1 * wars + 0.004 * siloLevels));
    if (!this.active) {
      if (level <= 0) return;
      this.activate(env, tick);
    }
    this.set(env, level);
  }

  /** Debug / shots: jump the clock forward. */
  force(env: EventEnv, level: number): void {
    if (!this.active) this.activate(env, env.g.tick);
    this.forced = Math.max(this.forced, level);
    this.set(env, Math.min(1, Math.max(this.level, level)));
  }

  private activate(env: EventEnv, tick: number): void {
    this.active = true;
    this.eventId = env.g.nextEventId();
    env.g.emit({ type: 'worldEvent', tick, id: this.eventId, kind: 'doomsday', stage: 'start', x: 800, y: 400, radius: 0, magnitude: 0, players: [] });
  }

  private set(env: EventEnv, level: number): void {
    const g = env.g;
    this.level = level;
    g.setDoomsday(level);
    g.setWorldEventState(this.eventId, { kind: 'doomsday', x: 800, y: 400, radius: 0, progress: level, magnitude: level, players: [], heading: 0 });
    const minutes = (1 - level) * MINUTES;
    const whole = Math.ceil(minutes - 1e-6);
    if (whole < this.lastMinute || (this.lastMinute <= 1 && whole > this.lastMinute + 1)) {
      this.lastMinute = whole;
      g.emit({ type: 'doomsday', tick: g.tick, level, minutesToMidnight: minutes });
    }
  }
}
