// FRONT ULTRA — the Doomsday Clock (owner: sim-ai). Worker-only, deterministic.
//
// Late in the game the clock starts ticking: once the first bombs have fallen, once the world bristles with
// missile silos, or simply when the war drags on (BALANCE.doomsdayStartTick). Its level (0..1, shown as minutes
// to midnight) rises with time, with every detonation (hydrogen bombs and MIRVs far more than atom bombs) and with
// the number of silos in the world, and relaxes slowly when the bombs stop. The AI reads it: silos go up earlier,
// the nuclear-minded grow bolder, and at midnight every arsenal is fair game. Each whole minute the clock loses is
// announced to the world (SimEvent 'doomsday' -> breaking news), and the level is pushed to the HUD via
// game.setDoomsday.

import { BALANCE } from '../../shared/constants';
import type { SimEvent } from '../../shared/protocol';
import { StructureType, UnitType } from '../../shared/types';
import type { EventEnv } from './common';

const MINUTES = 12;

export class DoomsdayClock {
  private active = false;
  private since = 0;
  private nukeTerm = 0;
  private level = 0;
  private lastMinute = MINUTES + 1;
  private midnightUntil = 0;
  private detonations = 0;
  private eventId = 0;

  onEvent(e: SimEvent): void {
    if (e.type !== 'nukeDetonated' || e.weapon === UnitType.CruiseMissile) return;
    this.detonations++;
    switch (e.weapon) {
      case UnitType.AtomBomb: this.nukeTerm += 0.045; break;
      case UnitType.HydrogenBomb: this.nukeTerm += 0.1; break;
      case UnitType.MirvWarhead: this.nukeTerm += 0.012; break;
      default: break;
    }
  }

  /** Called every tick by the director. */
  step(env: EventEnv): void {
    const g = env.g;
    const tick = g.tick;
    if (tick % 50 !== 0) return;
    const silos = g.structures(undefined, StructureType.MissileSilo).length;
    if (!this.active) {
      const start = BALANCE.doomsdayStartTick;
      if ((this.detonations > 0 && tick >= 6000) || (silos >= 3 && tick >= 7200) || tick >= start) this.activate(env, tick);
      else return;
    }
    this.nukeTerm = Math.max(0, this.nukeTerm - 0.002);
    const time = Math.min(0.5, ((tick - this.since) / 9000) * 0.45);
    const siloTerm = Math.min(0.15, silos * 0.012);
    let level = Math.min(1, 0.06 + time + siloTerm + this.nukeTerm);
    if (tick < this.midnightUntil) level = 1;
    else if (level >= 0.999 && this.midnightUntil === 0) {
      // Midnight: the arsenals open for a while, then the world steps back from the brink.
      this.midnightUntil = tick + 1200;
    } else if (this.midnightUntil > 0 && tick >= this.midnightUntil) {
      this.midnightUntil = 0;
      this.nukeTerm = Math.max(0, this.nukeTerm - 0.35);
      level = Math.min(level, 0.8);
    }
    this.set(env, level);
  }

  /** Debug / shots: jump the clock forward. */
  force(env: EventEnv, level: number): void {
    if (!this.active) this.activate(env, env.g.tick);
    this.nukeTerm += Math.max(0, level - this.level);
    this.set(env, Math.min(1, Math.max(this.level, level)));
  }

  private activate(env: EventEnv, tick: number): void {
    this.active = true;
    this.since = tick;
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
