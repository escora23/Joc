// FRONT ULTRA — context-independent sound system (owner: audio).
// Bundles the engine, the cue libraries, the music director and the continuous beds behind one small
// API that both the live game glue (index.ts) and the offline lab (lab.ts) drive identically.

import type { UiSoundKind } from '../shared/events';
import { AudioEngine } from './engine';
import { BattleAmbience, Siren, VehicleLoop, type VehicleKind } from './loops';
import { MusicDirector } from './music';
import { CUES, nukeBoom, nukeFlash, nukeRing, nukeRoar, type CueParams } from './sfx';
import { UI_SOUNDS } from './uisfx';

export interface PlayOpts {
  pan?: number;
  lowpass?: number;
  /** 0 near .. 1 far. */
  dist?: number;
  size?: number;
  /** Absolute context time (default now). */
  at?: number;
}

export class SoundSystem {
  readonly eng: AudioEngine;
  readonly music: MusicDirector;
  readonly amb: BattleAmbience;
  readonly siren: Siren;
  vehicle: VehicleLoop | null = null;
  private lastNuke = -100;
  private readonly params: CueParams = { dist: 0, size: 1 };

  constructor(ac: BaseAudioContext, dest: AudioNode, seed = 0xf00d) {
    this.eng = new AudioEngine(ac, dest, seed);
    this.music = new MusicDirector(this.eng);
    this.amb = new BattleAmbience(this.eng);
    this.siren = new Siren(this.eng);
  }

  get now(): number {
    return this.eng.now;
  }

  /** Play a cue from the SFX table. Returns false if rate-limited, over budget or unknown. */
  play(cue: string, gain = 1, o: PlayOpts = {}): boolean {
    const def = CUES[cue];
    if (!def || gain < 0.005) return false;
    const e = this.eng;
    const at = o.at ?? e.now;
    if (!e.rateOk(cue, def.gap, at)) return false;
    const pri = def.pri + gain * 0.5;
    const v = e.voice(cue, pri, def.dur, def.bus, { pan: o.pan, lowpass: o.lowpass, wet: def.wet, echo: def.echo }, at);
    if (!v) return false;
    this.params.dist = o.dist ?? 0;
    this.params.size = o.size ?? 1;
    def.fn(e, v, at, Math.min(1.2, gain), this.params);
    return true;
  }

  ui(kind: UiSoundKind, gain = 1, at = this.eng.now): boolean {
    const def = UI_SOUNDS[kind];
    if (!def) return false;
    const e = this.eng;
    if (!e.rateOk('ui:' + kind, def.gap, at)) return false;
    const v = e.voice('ui:' + kind, 5, def.dur, 'ui', {}, at);
    if (!v) return false;
    def.fn(e, v, at, gain);
    return true;
  }

  /**
   * The nuclear detonation sequence. proximity 0..1 (1 = ground zero in view), size 1 atom / 1.6 hydrogen,
   * hidden = behind the planet (muffled). The world ducks to near silence, a sub-bass shove and a high
   * pressure pop and a high ring start instantly, the air is sucked in, then the boom, the roar and the stinger
   * arrive together and everything slowly returns.
   */
  nuke(proximity: number, size: number, hidden: boolean, at = this.eng.now): void {
    const e = this.eng;
    const p = Math.max(0, Math.min(1, proximity)) * (hidden ? 0.5 : 1);
    const chained = at - this.lastNuke < 2.5;
    this.lastNuke = at;
    const lp = hidden ? 380 : undefined;
    const g = 0.55 + 0.45 * p;
    const hold = 0.35 + 1.25 * p;
    this.params.dist = 1 - p;
    this.params.size = size;
    if (!chained) e.duck(0.62 - 0.58 * p, hold * 1000, 3200 + 2600 * p, at);
    // Flash: a soft pressure pop, then the silence, then the air being sucked in right before the blast.
    if (!chained && hold > 0.5) {
      const fl = e.voice('nuke:flash', 9, hold + 0.3, 'over', { lowpass: lp }, at);
      if (fl) nukeFlash(e, fl, at, g, hold);
    }
    const boom = e.voice('nuke:boom', 10, 7 + hold, 'over', { lowpass: lp, wet: 0.2 }, at);
    if (boom) nukeBoom(e, boom, at + hold, g * (chained ? 0.7 : 1), this.params);
    if (p > 0.45 && !chained) {
      const ring = e.voice('nuke:ring', 9, 8, 'over', {}, at);
      if (ring) nukeRing(e, ring, at + 0.04, p, 3 + 5 * p);
    }
    const roar = e.voice('nuke:roar', 10, 14, 'over', { lowpass: lp, wet: 0.4, echo: 0.3 }, at);
    if (roar) nukeRoar(e, roar, at + hold, g * (chained ? 0.75 : 1), this.params);
    if (!chained) this.music.nukeStinger(at + hold + 0.1, 0.5 + 0.5 * p);
  }

  startVehicle(kind: VehicleKind): void {
    this.stopVehicle();
    this.vehicle = new VehicleLoop(this.eng, kind);
  }

  stopVehicle(): void {
    this.vehicle?.stop();
    this.vehicle = null;
  }
}
