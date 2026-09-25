// FRONT ULTRA — adaptive music director (owner: audio).
// A look-ahead step sequencer (16ths) plays "families" of arrangements that share one harmonic
// language (D minor: i–VI–III–VII / i–VI–iv–V) and one theme, so every transition feels composed:
//   menu     slow, majestic: drone, pads, choir, bells and the horn theme
//   game     ADAPTIVE: layers fade in with war intensity 0..1: drone+pads+bells (peace) → string
//            ostinato (tension) → taiko & snare → driving saw-bass ostinato → brass stabs → choir (total war)
//   nuclear  phrygian dread: sub booms, dark choir cluster, shimmering tremolo, slow pulse
//   command  128 bpm action cue for driving/flying/sailing
//   victory  D-major fanfare then a triumphant loop; defeat: tolling lament then a bleak loop
// Families cross-fade (each has its own gain); stingers (nuke, victory, defeat) are one-shot phrases.

import type { AudioEngine } from './engine';
import { cancelFrom } from './engine';
import { AudioRng, smoothstep } from './dsp';
import * as I from './instruments';

export type MusicFamily = 'menu' | 'game' | 'nuclear' | 'command' | 'victory' | 'defeat' | 'silence';
type LayerId = 'pad' | 'choir' | 'bells' | 'pulse' | 'bass' | 'perc' | 'brass' | 'melody' | 'tremolo' | 'boom';
const LAYERS: readonly LayerId[] = ['pad', 'choir', 'bells', 'pulse', 'bass', 'perc', 'brass', 'melody', 'tremolo', 'boom'];

interface Chord {
  bass: number;
  pad: readonly number[];
}

const CH: Record<string, Chord> = {
  Dm: { bass: 38, pad: [57, 62, 65, 69] },
  Bb: { bass: 34, pad: [58, 62, 65, 70] },
  F: { bass: 41, pad: [57, 60, 65, 69] },
  C: { bass: 36, pad: [55, 60, 64, 67] },
  Gm: { bass: 43, pad: [55, 58, 62, 67] },
  A: { bass: 45, pad: [57, 61, 64, 69] },
  Eb: { bass: 39, pad: [55, 58, 63, 67] },
  D: { bass: 38, pad: [57, 62, 66, 69] },
  G: { bass: 43, pad: [55, 59, 62, 67] },
  Bm: { bass: 47, pad: [54, 59, 62, 66] },
  Am: { bass: 45, pad: [57, 60, 64, 69] },
};

/** [step offset within the bar, midi, length in steps] per bar. */
type Bar = readonly (readonly [number, number, number])[];

const THEME_MINOR: readonly Bar[] = [
  [[0, 62, 8], [8, 65, 4], [12, 64, 4]], [[0, 62, 12]],
  [[0, 65, 8], [8, 70, 8]], [[0, 69, 8], [8, 65, 8]],
  [[0, 69, 8], [8, 72, 4], [12, 70, 4]], [[0, 69, 16]],
  [[0, 67, 8], [8, 64, 8]], [[0, 67, 12], [12, 69, 4]],
  [[0, 69, 8], [8, 74, 8]], [[0, 72, 4], [4, 70, 4], [8, 69, 8]],
  [[0, 70, 12], [12, 69, 4]], [[0, 65, 16]],
  [[0, 67, 8], [8, 70, 8]], [[0, 74, 16]],
  [[0, 73, 12], [12, 76, 4]], [[0, 69, 16]],
];

const THEME_MAJOR: readonly Bar[] = [
  [[0, 66, 8], [8, 69, 4], [12, 71, 4]], [[0, 74, 16]],
  [[0, 74, 8], [8, 71, 8]], [[0, 67, 16]],
  [[0, 66, 8], [8, 71, 8]], [[0, 69, 8], [8, 66, 8]],
  [[0, 64, 8], [8, 69, 8]], [[0, 73, 12], [12, 74, 4]],
];

const LAMENT: readonly Bar[] = [
  [[0, 69, 16]], [[0, 67, 8], [8, 65, 8]],
  [[0, 65, 16]], [[0, 62, 16]],
  [[0, 64, 8], [8, 61, 8]], [[0, 64, 16]],
  [[0, 62, 16]], [],
];

interface FamilyDef {
  tempo: number;
  /** One chord per bar. */
  prog: readonly Chord[];
  theme: readonly Bar[] | null;
  droneRoot: number;
  dark: boolean;
  levels: (i: number) => Partial<Record<LayerId, number>>;
}

const two = (...names: string[]): Chord[] => names.flatMap((n) => [CH[n], CH[n]]);

const FAMILIES: Record<Exclude<MusicFamily, 'silence'>, FamilyDef> = {
  menu: {
    tempo: 66, prog: two('Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'Gm', 'A'), theme: THEME_MINOR, droneRoot: 38, dark: false,
    levels: () => ({ pad: 0.8, choir: 0.4, bells: 0.4, melody: 0.75, perc: 0.35, pulse: 0.15 }),
  },
  game: {
    tempo: 92, prog: two('Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'Gm', 'A'), theme: THEME_MINOR, droneRoot: 38, dark: false,
    levels: (i) => ({
      pad: 0.78 - 0.28 * i,
      bells: Math.max(0, 0.55 - i * 1.4),
      melody: 0.5 * smoothstep(0.15, 0.3, i) * (1 - smoothstep(0.55, 0.75, i)),
      pulse: 0.7 * smoothstep(0.12, 0.38, i),
      perc: smoothstep(0.3, 0.58, i),
      bass: 0.85 * smoothstep(0.42, 0.68, i),
      brass: 0.85 * smoothstep(0.6, 0.88, i),
      choir: 0.45 * smoothstep(0.78, 1, i),
    }),
  },
  nuclear: {
    tempo: 60, prog: [CH.Dm, CH.Dm, CH.Eb, CH.Eb, CH.Dm, CH.Dm, CH.Bb, CH.A], theme: null, droneRoot: 38, dark: true,
    levels: (i) => ({ pad: 0.45, choir: 0.55, tremolo: 0.3, boom: 0.85, pulse: 0.35 * smoothstep(0.3, 0.8, i), perc: 0.3 * smoothstep(0.5, 1, i) }),
  },
  command: {
    tempo: 128, prog: [CH.Dm, CH.Bb, CH.C, CH.A], theme: null, droneRoot: 38, dark: true,
    levels: (i) => ({ pad: 0.35, pulse: 0.55, bass: 0.8, perc: 0.75 + 0.15 * i, brass: 0.35 + 0.3 * i }),
  },
  victory: {
    tempo: 84, prog: two('D', 'G', 'Bm', 'A'), theme: THEME_MAJOR, droneRoot: 38, dark: false,
    levels: () => ({ pad: 0.7, brass: 0.45, perc: 0.45, bells: 0.5, melody: 0.7, choir: 0.35 }),
  },
  defeat: {
    tempo: 52, prog: two('Dm', 'Bb', 'A', 'Dm'), theme: LAMENT, droneRoot: 38, dark: true,
    levels: () => ({ pad: 0.55, choir: 0.35, melody: 0.5, bells: 0.12 }),
  },
};

class FamilyPlayer {
  readonly out: GainNode;
  readonly layer: Record<LayerId, GainNode>;
  readonly lv: Record<LayerId, number>;
  step = 0;
  next: number;
  private stopDrone: ((at: number) => void) | null = null;
  private readonly rng: AudioRng;
  endAt = Infinity;

  constructor(private readonly e: AudioEngine, readonly name: Exclude<MusicFamily, 'silence'>, readonly def: FamilyDef, start: number, dest: AudioNode, intensity: number, fadeIn: number) {
    this.out = e.ac.createGain();
    this.out.gain.setValueAtTime(0.0001, start);
    this.out.gain.linearRampToValueAtTime(1, start + fadeIn);
    this.out.connect(dest);
    this.rng = new AudioRng(0xa11 + name.length * 977);
    this.layer = {} as Record<LayerId, GainNode>;
    this.lv = {} as Record<LayerId, number>;
    const lv = def.levels(intensity);
    for (const id of LAYERS) {
      const g = e.ac.createGain();
      const v = lv[id] ?? 0;
      g.gain.setValueAtTime(v, start);
      g.connect(this.out);
      this.layer[id] = g;
      this.lv[id] = v;
    }
    this.next = start + 0.05;
    this.stopDrone = I.drone(e, start, def.droneRoot, def.dark ? 0.42 : 0.3, this.out, def.dark);
  }

  setIntensity(i: number, at: number, tau: number): void {
    const lv = this.def.levels(i);
    for (const id of LAYERS) {
      const v = lv[id] ?? 0;
      if (Math.abs(v - this.lv[id]) < 0.004) continue;
      this.lv[id] = v;
      this.layer[id].gain.setTargetAtTime(v, at, tau);
    }
  }

  fadeOut(at: number, len: number): void {
    cancelFrom(this.out.gain, at);
    this.out.gain.linearRampToValueAtTime(0.0001, at + len);
    this.endAt = at + len;
    this.stopDrone?.(at);
    this.stopDrone = null;
    setTimeoutSafe(() => this.out.disconnect(), (at + len - this.e.now + 1) * 1000);
  }

  get stepDur(): number {
    return 60 / this.def.tempo / 4;
  }

  schedule(until: number): void {
    while (this.next < until && this.next < this.endAt) {
      this.playStep(this.step, this.next);
      this.step++;
      this.next += this.stepDur;
    }
  }

  private on(id: LayerId): boolean {
    return this.lv[id] > 0.015;
  }

  private playStep(step: number, t: number): void {
    const e = this.e;
    const d = this.def;
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const chord = d.prog[bar % d.prog.length];
    const prev = d.prog[(bar + d.prog.length - 1) % d.prog.length];
    const chordStart = s === 0 && chord !== prev;
    const barDur = this.stepDur * 16;
    let chordBars = 1;
    while (chordBars < 4 && d.prog[(bar + chordBars) % d.prog.length] === chord) chordBars++;
    const L = this.layer;
    const n = this.name;

    // --- sustained layers on chord changes --------------------------------------------------
    if (chordStart || step === 0) {
      const len = barDur * chordBars;
      if (this.on('pad')) I.pad(e, t, n === 'nuclear' ? chord.pad.map((m) => m - 12) : chord.pad, len, 0.5, L.pad, d.dark ? 0.2 : n === 'victory' ? 0.8 : 0.5);
      if (this.on('choir')) I.choir(e, t, n === 'nuclear' ? [chord.pad[0] + 12, chord.pad[1] + 12, chord.pad[0] + 13] : chord.pad.slice(1).map((m) => m + 12), len, 0.45, L.choir, d.dark);
      if (this.on('tremolo')) I.tremolo(e, t, [chord.pad[2] + 12, chord.pad[3] + 12 + (bar % 4 === 2 ? 1 : 0)], len, 0.35, L.tremolo);
      if (this.on('brass') && (n === 'victory' || this.lv.brass > 0.7)) I.brass(e, t, chord.pad.map((m) => m - 12), len * 0.6, 0.35, L.brass, 0.5);
    }

    // --- melody ----------------------------------------------------------------------------
    if (d.theme && this.on('melody')) {
      const phrase = d.theme[bar % d.theme.length];
      for (const [off, m, len] of phrase) {
        if (off !== s) continue;
        const oct = n === 'game' ? -12 : 0;
        I.horn(e, t, m + oct, len * this.stepDur, 0.42, L.melody, n === 'victory' ? 0.9 : 0.45);
      }
    }

    // --- bells / arpeggio sparkle -----------------------------------------------------------
    if (this.on('bells') && s % 2 === 0) {
      const r = this.rng.next();
      if (r < (n === 'victory' ? 0.45 : 0.3) || (s === 0 && bar % 2 === 0)) {
        const tones = chord.pad;
        const m = tones[Math.floor(this.rng.next() * tones.length)] + (this.rng.next() < 0.35 ? 24 : 12);
        I.bellNote(e, t, m, 0.1 + this.rng.next() * 0.1, L.bells, 3.2);
      }
    }

    // --- string ostinato ------------------------------------------------------------------
    if (this.on('pulse') && s % 2 === 0) {
      const pat = [0, 0, 7, 0, 12, 0, 7, 0];
      const m = chord.bass + 12 + pat[(s / 2) % 8];
      const acc = s % 8 === 0 ? 1 : 0.62;
      I.spiccato(e, t, m, 0.3 * acc, L.pulse, n === 'nuclear' ? 0.5 : 0.2);
      if (n !== 'nuclear') I.spiccato(e, t, m + 12, 0.14 * acc, L.pulse, 0.16);
    }

    // --- driving bass ----------------------------------------------------------------------
    if (this.on('bass')) {
      const gallop = [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1];
      if (gallop[s]) {
        const oct = s === 14 ? 12 : s === 15 ? 7 : 0;
        const acc = s % 4 === 0 ? 1 : 0.62;
        I.bass(e, t, chord.bass + oct, this.stepDur * 1.6, 0.55 * acc, L.bass);
      }
    }

    // --- percussion -----------------------------------------------------------------------
    if (this.on('perc')) {
      const lv = this.lv.perc;
      if (n === 'menu' || n === 'victory') {
        if (s === 0 && bar % 2 === 0) I.taiko(e, t, 0.55, L.perc, 52);
        if (bar % 4 === 3 && s === 8) I.timpaniRoll(e, t, barDur * 0.5, 0.08, 0.45, L.perc);
        if (n === 'victory' && (s === 8 || s === 12)) I.taiko(e, t, 0.35, L.perc, 62);
      } else {
        const fill = bar % 4 === 3 && lv > 0.5;
        if (s === 0 || s === 10) I.taiko(e, t, 0.75, L.perc, 55);
        if (s === 6) I.taiko(e, t, 0.45, L.perc, 55);
        if (lv > 0.55 && (s === 3 || s === 13)) I.taiko(e, t, 0.3, L.perc, 78);
        if (lv > 0.65 && (s === 4 || s === 12)) I.snare(e, t, 0.32, L.perc);
        if (lv > 0.8 && !fill) I.hat(e, t, s % 4 === 2 ? 0.12 : 0.06, L.perc, s === 14);
        if (fill && s >= 12) I.taiko(e, t, 0.35 + (s - 12) * 0.12, L.perc, 70 - (s - 12) * 4);
        if (bar % 8 === 7 && s === 0 && lv > 0.6) I.cymbalSwell(e, t, barDur, 0.12, L.perc);
      }
    }

    // --- brass stabs ----------------------------------------------------------------------
    if (this.on('brass') && n !== 'victory') {
      if (s === 0 || (s === 10 && bar % 2 === 1) || (s === 6 && this.lv.brass > 0.6)) {
        I.brass(e, t, chord.pad.map((m) => m - 12), this.stepDur * (s === 0 ? 2.5 : 1.2), 0.4, L.brass, 0.9);
      }
    } else if (this.on('brass') && n === 'victory' && (s === 0 || s === 8)) {
      I.brass(e, t, chord.pad, this.stepDur * 3, 0.3, L.brass, 1);
    }

    // --- sub booms ------------------------------------------------------------------------
    if (this.on('boom') && s === 0 && bar % 2 === 0) I.subBoom(e, t, 0.7, L.boom);
  }
}

let setTimeoutSafe: (fn: () => void, ms: number) => void = (fn, ms) => {
  if (typeof setTimeout === 'function') setTimeout(fn, Math.max(0, ms));
};
/** Offline renders keep every node (no wall clock). */
export function disableDisconnectTimers(): void {
  setTimeoutSafe = () => undefined;
}

export class MusicDirector {
  private cur: FamilyPlayer | null = null;
  private fading: FamilyPlayer[] = [];
  family: MusicFamily = 'silence';
  intensity = 0;
  readonly lookahead = 0.35;

  constructor(private readonly e: AudioEngine) {}

  private get dest(): AudioNode {
    return this.e.buses.music.in;
  }

  setFamily(f: MusicFamily, at = this.e.now, fade = 3): void {
    if (f === this.family) return;
    this.family = f;
    if (this.cur) {
      this.cur.fadeOut(at, fade);
      this.fading.push(this.cur);
      this.cur = null;
    }
    if (f !== 'silence') {
      this.cur = new FamilyPlayer(this.e, f, FAMILIES[f], at, this.dest, this.intensity, f === 'menu' ? 4 : 2.5);
    }
  }

  setIntensity(i: number, at = this.e.now, tau = 2.5): void {
    this.intensity = i;
    this.cur?.setIntensity(i, at, tau);
  }

  /** Schedule all notes up to `until` (context time). */
  schedule(until: number): void {
    this.cur?.schedule(until);
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      if (f.endAt <= this.e.now) this.fading.splice(i, 1);
      else f.schedule(Math.min(until, f.endAt));
    }
  }

  update(): void {
    this.schedule(this.e.now + this.lookahead);
  }

  // ---------------------------------------------------------------------------------------------
  // Stingers
  // ---------------------------------------------------------------------------------------------

  /** Nuclear stinger: a huge low brass cluster + drum + dissonant choir, on the non-ducked bus. */
  nukeStinger(t: number, g = 1): void {
    const e = this.e;
    const out = e.gain(0.9 * g, e.buses.over.in);
    I.taiko(e, t, 0.9, out, 42);
    I.subBoom(e, t, 0.8, out);
    I.brass(e, t + 0.05, [26, 38, 39, 45], 2.6, 0.55, out, 0.35);
    I.choir(e, t + 0.3, [74, 75, 81], 4.5, 0.35, out, false);
    I.timpaniRoll(e, t + 2.8, 1.2, 0.3, 0.05, out, 44);
  }

  /** Victory fanfare, then the triumphant loop. */
  victory(t: number): void {
    const e = this.e;
    const out = e.gain(1, this.dest);
    this.setFamily('silence', t, 1.2);
    I.timpaniRoll(e, t, 1.6, 0.05, 0.55, out, 49);
    I.cymbalSwell(e, t, 1.6, 0.18, out);
    const hit = t + 1.65;
    I.taiko(e, hit, 0.9, out, 49);
    I.brass(e, hit, [50, 57, 62, 66, 69], 1.1, 0.5, out, 1);
    I.brass(e, hit + 1.35, [43, 55, 59, 62, 67], 0.35, 0.42, out, 1);
    I.brass(e, hit + 1.8, [45, 57, 61, 64, 69], 0.35, 0.44, out, 1);
    I.taiko(e, hit + 2.25, 0.8, out, 49);
    I.brass(e, hit + 2.25, [38, 50, 57, 62, 66, 69, 74], 2.6, 0.55, out, 1);
    I.choir(e, hit + 2.25, [62, 66, 69, 74], 3.5, 0.4, out, false);
    I.bellNote(e, hit + 2.3, 86, 0.2, out, 4);
    I.bellNote(e, hit + 2.45, 90, 0.15, out, 4);
    this.family = 'silence';
    this.startLater('victory', hit + 5.2);
  }

  /** Defeat: tolling bell, collapsing brass, then the lament loop. */
  defeat(t: number): void {
    const e = this.e;
    const out = e.gain(1, this.dest);
    this.setFamily('silence', t, 1.5);
    I.subBoom(e, t, 0.7, out);
    I.brass(e, t, [26, 38, 45, 50, 53], 2.8, 0.45, out, 0.25);
    I.choir(e, t + 0.5, [62, 65, 69], 4.5, 0.35, out, true);
    I.horn(e, t + 1.2, 69, 1.2, 0.4, out, 0.3);
    I.horn(e, t + 2.4, 67, 0.6, 0.38, out, 0.3);
    I.horn(e, t + 3.0, 65, 0.6, 0.36, out, 0.3);
    I.horn(e, t + 3.6, 64, 0.6, 0.34, out, 0.3);
    I.horn(e, t + 4.2, 62, 2.4, 0.34, out, 0.3);
    this.family = 'silence';
    this.startLater('defeat', t + 6.5);
  }

  private startLater(f: MusicFamily, at: number): void {
    // Create the family now with its clock starting at `at` (the scheduler skips ahead naturally).
    this.family = f;
    if (this.cur) {
      this.cur.fadeOut(this.e.now, 1);
      this.fading.push(this.cur);
    }
    this.cur = f === 'silence' ? null : new FamilyPlayer(this.e, f, FAMILIES[f], at, this.dest, this.intensity, 3);
  }
}
