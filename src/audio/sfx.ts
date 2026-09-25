// FRONT ULTRA — procedural sound-effect library (owner: audio).
// Every cue is synthesised from oscillators, generated noise and filters at play time: explosions,
// artillery, small arms, tank cannon & engine, jets, missiles, naval guns, ship horn, sirens, bells,
// structures, diplomacy, world events, and the multi-stage nuclear detonation.
// A cue builds its graph into `v.out` (the voice gain) scheduled at absolute time `t`.

import type { AudioEngine, BusName, Voice } from './engine';
import { midiToHz } from './dsp';

export interface CueParams {
  /** 0 = right here, 1 = far away (drops transients, darkens). */
  dist: number;
  /** Size / weight multiplier (0.5 small .. 2 huge). */
  size: number;
}

export interface CueDef {
  /** Voice-stealing priority (higher survives). */
  pri: number;
  /** Voice length in seconds (for the budget; the graph may end earlier). */
  dur: number;
  bus: BusName;
  /** Minimum seconds between two plays of this cue. */
  gap: number;
  wet?: number;
  echo?: number;
  fn: (e: AudioEngine, v: Voice, t: number, g: number, p: CueParams) => void;
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

/** Broadband transient: the supersonic "crack" of a blast or muzzle. */
function crack(e: AudioEngine, v: Voice, t: number, g: number, hp: number, dec: number): void {
  if (g < 0.01) return;
  const env = e.envGain(t, 0.0008, g, dec, v.out);
  const f = e.filter('highpass', hp, 0.7, env);
  e.noiseSrc(v, 'white', t, dec + 0.05, f);
}

/** Pitch-dropping sine: kick / body thump / sub boom. */
function thump(e: AudioEngine, v: Voice, t: number, g: number, f0: number, f1: number, sweep: number, dec: number): void {
  const env = e.envGain(t, 0.002, g, dec, v.out);
  const o = e.osc(v, 'sine', f0, t, dec + 0.1, env);
  o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
}

/** Filtered noise body with a closing low-pass (the "whoomp" and rumble of an explosion). */
function body(e: AudioEngine, v: Voice, kind: 'pink' | 'brown' | 'white' | 'wide', t: number, g: number, fFrom: number, fTo: number, sweep: number, attack: number, dec: number, drive: number): void {
  const env = e.envGain(t, attack, g, dec, v.out);
  const dest: AudioNode = drive > 0 ? e.shaper(drive, env) : env;
  const lp = e.filter('lowpass', fFrom, 0.6, dest);
  lp.frequency.setValueAtTime(fFrom, t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(30, fTo), t + sweep);
  e.noiseSrc(v, kind, t, attack + dec + 0.1, lp);
}

/** Debris / crackle tail. */
function debris(e: AudioEngine, v: Voice, t: number, g: number, center: number, attack: number, dec: number): void {
  const env = e.envGain(t, attack, g, dec, v.out);
  const bp = e.filter('bandpass', center, 0.6, env);
  e.noiseSrc(v, 'crackle', t, attack + dec + 0.1, bp, e.rng.range(0.8, 1.2));
}

/** Short inharmonic metallic ring (clank, casing, ratchet). */
function metal(e: AudioEngine, v: Voice, t: number, g: number, f: number, dec: number): void {
  const ratios = [1, 2.76, 5.4, 8.93];
  for (let i = 0; i < ratios.length; i++) {
    const env = e.envGain(t, 0.0008, g / (1 + i * 0.8), dec / (1 + i * 0.6), v.out);
    e.osc(v, 'sine', f * ratios[i], t, dec + 0.05, env);
  }
  crack(e, v, t, g * 0.5, 3000, 0.012);
}

/** FM bell partial stack (alliance chime, coins, notifications). */
export function bell(e: AudioEngine, v: Voice | null, t: number, g: number, f: number, dec: number, dest: AudioNode, bright = 1): void {
  const env = e.envGain(t, 0.002, g, dec, dest);
  const car = e.osc(v, 'sine', f, t, dec + 0.1, env);
  const modGain = e.ac.createGain();
  modGain.gain.setValueAtTime(f * 1.8 * bright, t);
  modGain.gain.exponentialRampToValueAtTime(f * 0.05 + 1, t + dec * 0.6);
  modGain.connect(car.frequency);
  e.osc(v, 'sine', f * 3.5, t, dec + 0.1, modGain);
  // Shimmer partial.
  const env2 = e.envGain(t, 0.001, g * 0.25 * bright, dec * 0.35, dest);
  e.osc(v, 'sine', f * 4.07, t, dec * 0.4 + 0.1, env2);
}

/** Low brassy chord stab: detuned saws through an enveloped low-pass. */
export function brassStab(e: AudioEngine, v: Voice | null, t: number, g: number, notes: readonly number[], hold: number, dest: AudioNode, bright = 1): void {
  const env = e.ahrGain(t, 0.04, g, hold, 0.35, dest);
  const sat = e.shaper(1.6, env);
  const lp = e.filter('lowpass', 300, 1.2, sat);
  lp.frequency.setValueAtTime(260, t);
  lp.frequency.linearRampToValueAtTime(1500 + 1400 * bright, t + 0.07);
  lp.frequency.exponentialRampToValueAtTime(700 + 300 * bright, t + 0.07 + Math.max(0.1, hold));
  const per = 0.5 / notes.length;
  for (const n of notes) {
    const f = midiToHz(n);
    for (const d of [-9, 7]) {
      const og = e.gain(per, lp);
      const o = e.osc(v, 'sawtooth', f, t, hold + 0.45, og, d);
      o.detune.setValueAtTime(d - 40, t);
      o.detune.linearRampToValueAtTime(d, t + 0.06);
    }
  }
}

/** Big drum (taiko / timpani-ish) hit. */
export function drum(e: AudioEngine, v: Voice | null, t: number, g: number, f: number, dec: number, dest: AudioNode): void {
  const env = e.envGain(t, 0.001, g, dec, dest);
  const o = e.osc(v, 'sine', f * 2.2, t, dec + 0.1, env);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
  o.frequency.exponentialRampToValueAtTime(f * 0.85, t + dec);
  const nEnv = e.envGain(t, 0.001, g * 0.45, Math.min(0.25, dec * 0.4), dest);
  const lp = e.filter('lowpass', 900, 0.7, nEnv);
  e.noiseSrc(v, 'pink', t, 0.35, lp);
}

// ---------------------------------------------------------------------------------------------
// Cue table
// ---------------------------------------------------------------------------------------------

export const CUES: Record<string, CueDef> = {
  explosionSmall: {
    pri: 4, dur: 2.4, bus: 'sfx', gap: 0.05, echo: 0.25, wet: 0.15,
    fn(e, v, t, g, p) {
      const near = 1 - p.dist;
      crack(e, v, t, 0.8 * g * near * near, 1500, 0.05);
      body(e, v, 'pink', t, 0.85 * g, 2600 * (0.4 + near * 0.6), 220, 0.6, 0.004, 1.1, 3);
      thump(e, v, t, 1.0 * g, 100, 38, 0.25, 0.5);
      debris(e, v, t + 0.04, 0.3 * g * near, 2200, 0.08, 1.3);
    },
  },
  explosionLarge: {
    pri: 7, dur: 5.5, bus: 'sfx', gap: 0.12, echo: 0.35, wet: 0.25,
    fn(e, v, t, g, p) {
      const near = 1 - p.dist;
      crack(e, v, t, 0.9 * g * near * near, 1200, 0.08);
      body(e, v, 'brown', t, 1.0 * g, 1900 * (0.4 + near * 0.6), 130, 2.0, 0.006, 3.6, 4);
      body(e, v, 'pink', t, 0.55 * g, 900, 300, 0.8, 0.003, 1.4, 2);
      thump(e, v, t, 1.0 * g, 62, 24, 1.1, 2.2);
      debris(e, v, t + 0.1, 0.35 * g * (0.3 + near * 0.7), 1800, 0.25, 2.8);
      body(e, v, 'brown', t + 0.2, 0.5 * g, 110, 70, 3, 0.4, 3.8, 0);
      if (near > 0.5) e.dipMusic(0.5 * near, 2.5, t);
    },
  },
  artillery: {
    pri: 3, dur: 3.2, bus: 'sfx', gap: 0.06, echo: 0.6, wet: 0.2,
    fn(e, v, t, g, p) {
      const near = 1 - p.dist;
      crack(e, v, t, 0.6 * g * near * near * near, 1800, 0.03);
      thump(e, v, t, 0.95 * g, 74, 34, 0.3, 0.9);
      body(e, v, 'brown', t, 0.8 * g, 900 * (0.35 + near * 0.65), 150, 0.9, 0.005, 1.5, 2);
    },
  },
  gunfire: {
    pri: 2, dur: 1.4, bus: 'sfx', gap: 0.05, echo: 0.35,
    fn(e, v, t, g, p) {
      const near = 1 - p.dist;
      const mg = e.rng.next() < 0.55;
      const n = mg ? 4 + Math.floor(e.rng.next() * 7) : 2 + Math.floor(e.rng.next() * 4);
      let ts = t;
      for (let i = 0; i < n; i++) {
        const sg = g * e.rng.range(0.6, 1);
        const env = e.envGain(ts, 0.0005, 0.8 * sg * (0.3 + near * 0.7), 0.05 + 0.04 * p.dist, v.out);
        const bp = e.filter('bandpass', e.rng.jitter(1500 - p.dist * 700, 0.2), 0.8, env);
        e.noiseSrc(v, 'white', ts, 0.12, bp);
        thump(e, v, ts, 0.5 * sg, 180, 70, 0.03, 0.07);
        ts += mg ? e.rng.range(0.065, 0.085) : e.rng.range(0.12, 0.3);
      }
    },
  },
  tankCannon: {
    pri: 8, dur: 4.2, bus: 'sfx', gap: 0.1, echo: 0.55, wet: 0.35,
    fn(e, v, t, g, p) {
      const near = 1 - p.dist;
      crack(e, v, t, 1.0 * g * near, 700, 0.09);
      body(e, v, 'pink', t, 0.95 * g, 3400, 260, 0.45, 0.002, 0.95, 5);
      thump(e, v, t, 1.0 * g, 118, 40, 0.18, 0.7);
      body(e, v, 'brown', t + 0.02, 0.6 * g, 600, 120, 1.2, 0.02, 2.2, 0);
      metal(e, v, t + 0.32, 0.12 * g * near, 470, 0.35);
      metal(e, v, t + 0.55, 0.06 * g * near, 610, 0.22);
    },
  },
  tankEngine: {
    pri: 3, dur: 3.2, bus: 'sfx', gap: 0.5,
    fn(e, v, t, g) {
      const env = e.ahrGain(t, 0.25, 0.55 * g, 1.7, 1.0, v.out);
      const lp = e.filter('lowpass', 380, 1.4, env);
      lp.frequency.linearRampToValueAtTime(1100, t + 0.9);
      lp.frequency.linearRampToValueAtTime(600, t + 2.6);
      const am = e.ac.createGain();
      am.gain.value = 0.7;
      am.connect(lp);
      const lfo = e.osc(v, 'square', 14, t, 3, e.gainParam(0.3, am.gain));
      lfo.frequency.linearRampToValueAtTime(24, t + 1);
      lfo.frequency.linearRampToValueAtTime(19, t + 2.6);
      const sat = e.shaper(3.5, am);
      for (const [type, mul, lvl] of [['sawtooth', 1, 0.5], ['square', 2.01, 0.25], ['sawtooth', 0.5, 0.4]] as const) {
        const o = e.osc(v, type, 32 * mul, t, 3, e.gain(lvl, sat));
        o.frequency.linearRampToValueAtTime(54 * mul, t + 1.0);
        o.frequency.linearRampToValueAtTime(44 * mul, t + 2.6);
      }
      // Track squeal & clatter.
      const tr = e.ahrGain(t + 0.3, 0.4, 0.18 * g, 1.2, 0.9, v.out);
      const bp = e.filter('bandpass', 2600, 2.5, tr);
      e.noiseSrc(v, 'crackle', t + 0.3, 2.6, bp, 1.6);
    },
  },
  jetFlyby: {
    pri: 5, dur: 6.5, bus: 'sfx', gap: 0.8, wet: 0.2,
    fn(e, v, t, g, p) {
      const tp = 2.6, len = 6.2;
      const n = 64;
      const bellC = new Float32Array(n), panC = new Float32Array(n), dopC = new Float32Array(n), lpC = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const tt = (i / (n - 1)) * len;
        const x = (tt - tp) / 0.9;
        bellC[i] = (1 / (1 + x * x * (x < 0 ? 0.55 : 0.28))) * g;
        panC[i] = Math.tanh(x * 0.9) * 0.85;
        dopC[i] = 1 - 0.36 / (1 + Math.exp(-x * 2.2));
        lpC[i] = 600 + 3400 / (1 + x * x * 0.8);
      }
      bellC[n - 1] = 0;
      const pan = e.ac.createStereoPanner();
      pan.connect(v.out);
      pan.pan.setValueCurveAtTime(panC, t, len);
      const amp = e.ac.createGain();
      amp.gain.setValueAtTime(0, t);
      amp.gain.setValueCurveAtTime(bellC, t, len);
      amp.connect(pan);
      // Roar.
      const lp = e.filter('lowpass', 800, 0.7, e.gain(0.9, amp));
      lp.frequency.setValueCurveAtTime(lpC, t, len);
      e.noiseSrc(v, 'brown', t, len, lp);
      const lp2 = e.filter('lowpass', 800, 0.5, e.gain(0.55, amp));
      lp2.frequency.setValueCurveAtTime(lpC, t, len);
      e.noiseSrc(v, 'pink', t, len, lp2);
      // Turbine whine with Doppler.
      const bp = e.filter('bandpass', 4200, 7, e.gain(0.5 * (1 - p.dist * 0.7), amp));
      const whine = e.osc(v, 'sawtooth', 3900, t, len, e.gain(0.08, amp));
      const dop = new Float32Array(n);
      for (let i = 0; i < n; i++) dop[i] = 3900 * dopC[i];
      whine.frequency.setValueCurveAtTime(dop, t, len);
      const bpF = new Float32Array(n);
      for (let i = 0; i < n; i++) bpF[i] = 4600 * dopC[i];
      bp.frequency.setValueCurveAtTime(bpF, t, len);
      e.noiseSrc(v, 'white', t, len, bp);
      // Afterburner crackle as it passes.
      const cr = e.envGain(t + tp - 0.3, 0.3, 0.35 * g, 2.2, pan);
      e.noiseSrc(v, 'crackle', t + tp - 0.3, 2.6, e.filter('lowpass', 1400, 0.6, cr), 0.8);
    },
  },
  jetCannon: {
    pri: 6, dur: 1.0, bus: 'sfx', gap: 0.28, echo: 0.3,
    fn(e, v, t, g) {
      const len = 0.42;
      const env = e.ahrGain(t, 0.004, 0.7 * g, len, 0.12, v.out);
      // The saturated saw is asymmetric: block the DC it creates.
      const sat = e.shaper(6, e.filter('highpass', 45, 0.7, env));
      const bp = e.filter('bandpass', 380, 0.6, sat);
      e.osc(v, 'sawtooth', 68, t, len + 0.15, bp);
      // Gated noise at the fire rate (BRRRT).
      const gate = e.ac.createGain();
      gate.gain.value = 0.5;
      e.osc(v, 'square', 68, t, len + 0.15, e.gainParam(0.5, gate.gain));
      gate.connect(e.filter('highpass', 1200, 0.7, env));
      e.noiseSrc(v, 'white', t, len + 0.15, gate);
      thump(e, v, t, 0.5 * g, 90, 50, 0.1, len);
    },
  },
  missileLaunch: {
    pri: 5, dur: 3.8, bus: 'sfx', gap: 0.15, wet: 0.2, echo: 0.3,
    fn(e, v, t, g, p) {
      crack(e, v, t, 0.5 * g * (1 - p.dist), 1500, 0.06);
      const env = e.envGain(t, 0.05, 0.8 * g, 3.2, v.out);
      const bp = e.filter('bandpass', 500, 0.8, env);
      bp.frequency.exponentialRampToValueAtTime(1600, t + 1.2);
      bp.frequency.exponentialRampToValueAtTime(900, t + 3.2);
      e.noiseSrc(v, 'pink', t, 3.4, bp);
      body(e, v, 'brown', t, 0.7 * g, 400, 120, 2.5, 0.03, 2.8, 2);
      debris(e, v, t, 0.3 * g, 3000, 0.05, 2.0);
    },
  },
  samLaunch: {
    pri: 5, dur: 2.4, bus: 'sfx', gap: 0.1, wet: 0.15,
    fn(e, v, t, g, p) {
      crack(e, v, t, 0.5 * g * (1 - p.dist), 2000, 0.04);
      const env = e.envGain(t, 0.01, 0.7 * g, 1.8, v.out);
      const bp = e.filter('bandpass', 1600, 1.4, env);
      bp.frequency.exponentialRampToValueAtTime(4200, t + 0.6);
      bp.frequency.exponentialRampToValueAtTime(2500, t + 1.8);
      e.noiseSrc(v, 'white', t, 2, bp);
      body(e, v, 'pink', t, 0.4 * g, 700, 200, 1.2, 0.01, 1.2, 0);
    },
  },
  nukeLaunch: {
    pri: 9, dur: 8, bus: 'sfx', gap: 0.5, wet: 0.35, echo: 0.3,
    fn(e, v, t, g) {
      const env = e.ahrGain(t, 1.0, 0.9 * g, 3.0, 3.5, v.out);
      const sat = e.shaper(2.5, env);
      const lp = e.filter('lowpass', 180, 0.7, sat);
      lp.frequency.linearRampToValueAtTime(700, t + 3);
      lp.frequency.linearRampToValueAtTime(260, t + 7);
      e.noiseSrc(v, 'brown', t, 7.6, lp);
      const env2 = e.ahrGain(t + 0.3, 1.5, 0.5 * g, 2.5, 3, v.out);
      const bp = e.filter('bandpass', 300, 0.9, env2);
      bp.frequency.exponentialRampToValueAtTime(1100, t + 4);
      bp.frequency.exponentialRampToValueAtTime(500, t + 7.2);
      e.noiseSrc(v, 'wide', t, 7.6, bp);
      const sub = e.ahrGain(t, 1.2, 0.5 * g, 3, 3, v.out);
      e.osc(v, 'sine', 38, t, 7.4, sub);
      debris(e, v, t + 0.5, 0.25 * g, 1600, 1.0, 5);
    },
  },
  nukeDetonation: {
    // Plain one-shot version (the orchestrated sequence in nuke.ts adds the silence, roar and tail).
    pri: 10, dur: 12, bus: 'over', gap: 0.2, wet: 0.3,
    fn(e, v, t, g, p) {
      nukeBoom(e, v, t, g, p);
      nukeRoar(e, v, t + 0.9, g, p);
    },
  },
  siren: {
    pri: 9, dur: 9.5, bus: 'sfx', gap: 1,
    fn(e, v, t, g) {
      sirenGraph(e, v, t, g, 9);
    },
  },
  shipHorn: {
    pri: 5, dur: 5, bus: 'sfx', gap: 1.5, wet: 0.45, echo: 0.6,
    fn(e, v, t, g) {
      const env = e.ahrGain(t, 0.18, 0.7 * g, 2.4, 1.0, v.out);
      const sat = e.shaper(2.2, env);
      const lp = e.filter('lowpass', 500, 1.1, sat);
      lp.frequency.linearRampToValueAtTime(1300, t + 0.3);
      for (const [f, type, lvl] of [[73.4, 'sawtooth', 0.4], [110, 'sawtooth', 0.35], [146.8, 'square', 0.12]] as const) {
        const o = e.osc(v, type, f, t, 3.8, e.gain(lvl, lp));
        o.detune.setValueAtTime(-45, t);
        o.detune.linearRampToValueAtTime(0, t + 0.25);
        o.detune.linearRampToValueAtTime(-8, t + 3.4);
      }
    },
  },
  navalGun: {
    pri: 7, dur: 5, bus: 'sfx', gap: 0.12, echo: 0.7, wet: 0.35,
    fn(e, v, t, g, p) {
      const near = 1 - p.dist;
      crack(e, v, t, 0.9 * g * near, 600, 0.1);
      body(e, v, 'pink', t, 0.9 * g, 2600, 200, 0.6, 0.002, 1.3, 5);
      thump(e, v, t, 1.0 * g, 88, 30, 0.3, 1.2);
      body(e, v, 'brown', t + 0.03, 0.7 * g, 500, 90, 1.8, 0.03, 3.2, 0);
    },
  },
  build: {
    pri: 4, dur: 1.6, bus: 'sfx', gap: 0.15, wet: 0.1,
    fn(e, v, t, g) {
      thump(e, v, t, 0.7 * g, 140, 60, 0.12, 0.25);
      metal(e, v, t + 0.01, 0.22 * g, 380, 0.4);
      for (let i = 0; i < 4; i++) {
        const tt = t + 0.12 + i * 0.055;
        const env = e.envGain(tt, 0.0005, 0.25 * g, 0.03, v.out);
        e.noiseSrc(v, 'white', tt, 0.05, e.filter('bandpass', 3200 + i * 300, 3, env));
      }
      metal(e, v, t + 0.36, 0.16 * g, 520, 0.3);
      bell(e, v, t + 0.42, 0.1 * g, 1174.7, 0.8, v.out, 0.4);
    },
  },
  upgrade: {
    pri: 4, dur: 2, bus: 'sfx', gap: 0.2, wet: 0.3,
    fn(e, v, t, g) {
      metal(e, v, t, 0.2 * g, 420, 0.35);
      const notes = [74, 78, 81, 86];
      notes.forEach((m, i) => bell(e, v, t + 0.08 + i * 0.075, 0.13 * g, midiToHz(m), 0.9, v.out, 0.5));
      const env = e.ahrGain(t, 0.25, 0.1 * g, 0.2, 0.8, v.out);
      const bp = e.filter('bandpass', 1500, 1.5, env);
      bp.frequency.exponentialRampToValueAtTime(6000, t + 0.5);
      e.noiseSrc(v, 'white', t, 1.3, bp);
    },
  },
  capture: {
    pri: 5, dur: 2.2, bus: 'sfx', gap: 0.4, wet: 0.35,
    fn(e, v, t, g) {
      drum(e, v, t, 0.8 * g, 62, 0.8, v.out);
      brassStab(e, v, t + 0.02, 0.45 * g, [50, 57, 62, 65], 0.28, v.out);
    },
  },
  attack: {
    pri: 4, dur: 1.6, bus: 'sfx', gap: 0.35, wet: 0.25,
    fn(e, v, t, g) {
      drum(e, v, t, 0.75 * g, 58, 0.7, v.out);
      drum(e, v, t + 0.13, 0.4 * g, 70, 0.4, v.out);
      const env = e.envGain(t, 0.12, 0.18 * g, 0.5, v.out);
      const bp = e.filter('bandpass', 600, 1.2, env);
      bp.frequency.exponentialRampToValueAtTime(2400, t + 0.3);
      e.noiseSrc(v, 'pink', t, 0.8, bp);
      brassStab(e, v, t + 0.01, 0.22 * g, [45, 52, 57], 0.12, v.out, 0.6);
    },
  },
  alliance: {
    pri: 6, dur: 3.5, bus: 'sfx', gap: 1, wet: 0.5,
    fn(e, v, t, g) {
      const notes = [74, 78, 81, 86];
      notes.forEach((m, i) => bell(e, v, t + i * 0.11, 0.2 * g, midiToHz(m), 2.6, v.out, 0.6));
      const pad = e.ahrGain(t, 0.4, 0.08 * g, 1.2, 1.6, v.out);
      const lp = e.filter('lowpass', 1400, 0.5, pad);
      for (const m of [62, 66, 69]) e.osc(v, 'sawtooth', midiToHz(m), t, 3.3, e.gain(0.3, lp), (m % 3) * 4 - 4);
    },
  },
  betrayal: {
    pri: 6, dur: 3.5, bus: 'sfx', gap: 1, wet: 0.45,
    fn(e, v, t, g) {
      drum(e, v, t, 0.8 * g, 50, 1.2, v.out);
      brassStab(e, v, t, 0.4 * g, [38, 44, 50, 56], 1.0, v.out, 0.5);
      const env = e.ahrGain(t + 0.05, 0.3, 0.06 * g, 0.8, 1.5, v.out);
      const trem = e.ac.createGain();
      trem.gain.value = 0.6;
      trem.connect(env);
      e.osc(v, 'sine', 11, t, 3, e.gainParam(0.4, trem.gain));
      for (const f of [1244.5, 1318.5]) e.osc(v, 'sawtooth', f, t, 3, e.filter('lowpass', 2500, 0.7, e.gain(0.3, trem)));
    },
  },
  eliminated: {
    pri: 6, dur: 7, bus: 'sfx', gap: 1.5, wet: 0.5,
    fn(e, v, t, g) {
      churchBell(e, v, t, 0.5 * g, 98);
      churchBell(e, v, t + 2.6, 0.3 * g, 98);
    },
  },
  coins: {
    pri: 2, dur: 0.9, bus: 'sfx', gap: 0.25, wet: 0.15,
    fn(e, v, t, g) {
      metalDing(e, v, t, 0.18 * g, 2150);
      metalDing(e, v, t + 0.07, 0.14 * g, 2710);
      metalDing(e, v, t + 0.16, 0.08 * g, 3240);
    },
  },
  earthquake: {
    pri: 7, dur: 8, bus: 'sfx', gap: 2, wet: 0.2,
    fn(e, v, t, g) {
      const env = e.ahrGain(t, 1.2, 0.9 * g, 3.2, 3.2, v.out);
      const am = e.ac.createGain();
      am.gain.value = 0.6;
      am.connect(env);
      e.osc(v, 'sine', 5.3, t, 7.6, e.gainParam(0.25, am.gain));
      e.osc(v, 'sine', 7.9, t, 7.6, e.gainParam(0.18, am.gain));
      e.noiseSrc(v, 'brown', t, 7.6, e.filter('lowpass', 75, 0.8, e.shaper(2, am)));
      e.osc(v, 'sine', 27, t, 7.6, e.gain(0.4, am));
      debris(e, v, t + 0.8, 0.3 * g, 900, 1.5, 4.5);
    },
  },
  thunder: {
    pri: 5, dur: 6.5, bus: 'sfx', gap: 1, wet: 0.35, echo: 0.4,
    fn(e, v, t, g, p) {
      crack(e, v, t, 0.6 * g * (1 - p.dist), 1800, 0.18);
      const env = e.envGain(t + 0.05, 0.12, 0.85 * g, 5.2, v.out);
      const am = e.ac.createGain();
      am.gain.value = 0.55;
      am.connect(env);
      e.osc(v, 'sine', 2.3, t, 6, e.gainParam(0.35, am.gain));
      e.osc(v, 'sine', 3.7, t, 6, e.gainParam(0.2, am.gain));
      const lp = e.filter('lowpass', 520, 0.6, e.shaper(2, am));
      lp.frequency.exponentialRampToValueAtTime(120, t + 5);
      e.noiseSrc(v, 'brown', t, 6, lp);
    },
  },
  radar: {
    pri: 3, dur: 2.2, bus: 'sfx', gap: 0.5, wet: 0.4,
    fn(e, v, t, g) {
      for (let i = 0; i < 4; i++) {
        const tt = t + i * 0.34;
        const env = e.envGain(tt, 0.002, (0.3 * g) / (1 + i * 1.6), 0.42, i === 0 ? v.out : e.filter('lowpass', 2400 - i * 400, 0.7, v.out));
        const o = e.osc(v, 'sine', 1320, tt, 0.5, env);
        o.frequency.exponentialRampToValueAtTime(1290, tt + 0.4);
      }
    },
  },
  newsBleep: {
    pri: 3, dur: 0.6, bus: 'ui', gap: 1.2,
    fn(e, v, t, g, p) {
      const urgent = p.size > 1.4;
      const n = urgent ? 6 : 3;
      for (let i = 0; i < n; i++) {
        const tt = t + i * (urgent ? 0.085 : 0.07);
        const f = urgent ? (i % 2 ? 660 : 990) : i === n - 1 ? 2093 : 1568;
        const env = e.envGain(tt, 0.002, 0.14 * g, 0.05, e.filter('bandpass', f, 1.2, v.out));
        e.osc(v, 'square', f, tt, 0.07, env);
      }
    },
  },
  hitMarker: {
    pri: 6, dur: 0.3, bus: 'ui', gap: 0.03,
    fn(e, v, t, g) {
      const env = e.envGain(t, 0.0005, 0.35 * g, 0.06, v.out);
      e.osc(v, 'sine', 3150, t, 0.1, env);
      e.osc(v, 'sine', 4720, t, 0.1, e.gain(0.5, env));
      crack(e, v, t, 0.25 * g, 4000, 0.015);
    },
  },
  radio: {
    // Unit selected: a short field-radio squelch and acknowledgement chirp.
    pri: 3, dur: 0.4, bus: 'ui', gap: 0.25,
    fn(e, v, t, g) {
      const env = e.ahrGain(t, 0.004, 0.13 * g, 0.06, 0.03, v.out);
      const sat = e.shaper(4, env);
      e.noiseSrc(v, 'white', t, 0.12, e.filter('bandpass', 1900, 1.8, sat));
      for (const [dt, f] of [[0.1, 1250], [0.16, 1660]] as const) {
        const te = e.envGain(t + dt, 0.002, 0.09 * g, 0.05, e.filter('bandpass', f, 2, v.out));
        e.osc(v, 'square', f, t + dt, 0.07, te);
      }
    },
  },
  killConfirm: {
    pri: 7, dur: 0.9, bus: 'ui', gap: 0.08, wet: 0.2,
    fn(e, v, t, g) {
      thump(e, v, t, 0.5 * g, 150, 60, 0.08, 0.2);
      metalDing(e, v, t, 0.2 * g, 2400);
      bell(e, v, t + 0.07, 0.12 * g, 1760, 0.5, v.out, 0.3);
    },
  },
  lockTone: {
    pri: 7, dur: 0.12, bus: 'ui', gap: 0.05,
    fn(e, v, t, g) {
      const env = e.ahrGain(t, 0.003, 0.14 * g, 0.05, 0.012, v.out);
      e.osc(v, 'triangle', 1480, t, 0.08, env);
      e.osc(v, 'sine', 2960, t, 0.08, e.gain(0.3, env));
    },
  },
  missileWarning: {
    pri: 8, dur: 0.4, bus: 'ui', gap: 0.2,
    fn(e, v, t, g) {
      for (const [dt, f] of [[0, 1080], [0.14, 760]] as const) {
        const env = e.ahrGain(t + dt, 0.004, 0.12 * g, 0.1, 0.015, e.filter('lowpass', 3000, 0.7, v.out));
        e.osc(v, 'square', f, t + dt, 0.14, env);
      }
    },
  },
  victory: {
    pri: 9, dur: 5, bus: 'music', gap: 3, wet: 0.4,
    fn(e, v, t, g) {
      drum(e, v, t, 0.8 * g, 55, 1.4, v.out);
      brassStab(e, v, t, 0.45 * g, [50, 57, 62, 66, 69], 1.6, v.out, 1);
      bell(e, v, t + 0.1, 0.12 * g, midiToHz(86), 2.5, v.out, 0.6);
    },
  },
  defeat: {
    pri: 9, dur: 6, bus: 'music', gap: 3, wet: 0.5,
    fn(e, v, t, g) {
      churchBell(e, v, t, 0.4 * g, 73.4);
      brassStab(e, v, t + 0.05, 0.3 * g, [38, 45, 50, 53], 2.5, v.out, 0.2);
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Composite pieces reused by the orchestrated sequences
// ---------------------------------------------------------------------------------------------

function metalDing(e: AudioEngine, v: Voice, t: number, g: number, f: number): void {
  for (const [r, a, d] of [[1, 1, 0.45], [2.76, 0.4, 0.2], [5.4, 0.2, 0.1]] as const) {
    const env = e.envGain(t, 0.0006, g * a, d, v.out);
    e.osc(v, 'sine', f * r, t, d + 0.05, env);
  }
}

function churchBell(e: AudioEngine, v: Voice, t: number, g: number, f: number): void {
  // Hum, prime, tierce (minor third), quint, nominal and upper partials with long, uneven decays.
  const partials: readonly (readonly [number, number, number])[] = [
    [0.5, 0.5, 5.5], [1, 0.7, 4.2], [1.183, 0.45, 3.2], [1.506, 0.3, 2.6], [2, 0.5, 2.4], [2.514, 0.18, 1.6], [2.662, 0.2, 1.4], [3.011, 0.14, 1.1], [4.166, 0.08, 0.7],
  ];
  for (const [r, a, d] of partials) {
    const env = e.envGain(t, 0.002, g * a, d, v.out);
    e.osc(v, 'sine', f * r, t, d + 0.1, env, (r * 7) % 5);
  }
  crack(e, v, t, g * 0.15, 2500, 0.03);
}

/** Air-raid siren: a rotating-disc tone that winds up, wails and winds down in cycles. */
export function sirenGraph(e: AudioEngine, v: Voice, t: number, g: number, dur: number): void {
  const env = e.ahrGain(t, 0.6, 0.42 * g, Math.max(0.1, dur - 1.8), 1.2, v.out);
  const sat = e.shaper(2.2, env);
  const bp = e.filter('bandpass', 900, 0.6, sat);
  const hp = e.filter('highpass', 180, 0.7, bp);
  const oscs: OscillatorNode[] = [];
  for (const [type, mul, lvl] of [['sawtooth', 1, 0.5], ['square', 1.5, 0.22], ['triangle', 2, 0.3]] as const) {
    oscs.push(e.osc(v, type, 240 * mul, t, dur + 0.2, e.gain(lvl, hp)));
    void mul;
  }
  const mults = [1, 1.5, 2];
  // Wind-up, then wail cycles.
  let tt = t;
  const lo = 250, hi = 720;
  for (let i = 0; i < oscs.length; i++) oscs[i].frequency.setValueAtTime(120 * mults[i], tt);
  for (let i = 0; i < oscs.length; i++) oscs[i].frequency.exponentialRampToValueAtTime(hi * mults[i], tt + 2.2);
  tt += 2.2;
  while (tt < t + dur - 0.5) {
    for (let i = 0; i < oscs.length; i++) {
      oscs[i].frequency.setValueAtTime(hi * mults[i], tt + 0.9);
      oscs[i].frequency.exponentialRampToValueAtTime(lo * mults[i], tt + 3.1);
      oscs[i].frequency.exponentialRampToValueAtTime(hi * mults[i], tt + 5.2);
    }
    tt += 5.2;
  }
}

/** Instant of detonation: sub-bass shove felt more than heard, plus the pressure "whump". */
export function nukeBoom(e: AudioEngine, v: Voice, t: number, g: number, p: CueParams): void {
  const near = 1 - p.dist;
  const s = p.size;
  const env = e.envGain(t, 0.01, 1.0 * g, 3.5 + s, v.out);
  const o = e.osc(v, 'sine', 52, t, 5 + s, env);
  o.frequency.exponentialRampToValueAtTime(19, t + 3.2);
  const o2 = e.osc(v, 'sine', 34, t, 5 + s, e.gain(0.6, env));
  o2.frequency.exponentialRampToValueAtTime(16, t + 4);
  body(e, v, 'brown', t, 0.8 * g, 260, 60, 1.5, 0.005, 3 + s, 3);
  crack(e, v, t, 0.5 * g * near * near, 900, 0.25);
}

/** The flash: a muffled pressure pop, then (after the silence) the air inhaling toward the blast. */
export function nukeFlash(e: AudioEngine, v: Voice, t: number, g: number, hold: number): void {
  thump(e, v, t, 0.3 * g, 46, 24, 0.4, 0.6);
  const t0 = t + hold * 0.35;
  const env = e.ac.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(0.22 * g, t + hold - 0.02);
  env.gain.linearRampToValueAtTime(0, t + hold + 0.01);
  env.connect(v.out);
  const lp = e.filter('bandpass', 180, 0.7, env);
  lp.frequency.setValueAtTime(180, t0);
  lp.frequency.exponentialRampToValueAtTime(1300, t + hold);
  e.noiseSrc(v, 'pink', t0, t + hold - t0 + 0.05, lp);
}

/** The roar that follows: wide, saturated, slowly darkening rumble with burning crackle. */
export function nukeRoar(e: AudioEngine, v: Voice, t: number, g: number, p: CueParams): void {
  const near = 1 - p.dist;
  const s = p.size;
  const len = 7 + 3 * s;
  const env = e.envGain(t, 0.7, 0.95 * g, len, v.out);
  const sat = e.shaper(3, env);
  const lp = e.filter('lowpass', 900 + 700 * near, 0.6, sat);
  lp.frequency.exponentialRampToValueAtTime(160, t + len * 0.8);
  e.noiseSrc(v, 'wide', t, len + 1, lp);
  body(e, v, 'brown', t, 0.9 * g, 420, 90, len * 0.7, 0.9, len, 2.5);
  debris(e, v, t + 0.4, 0.4 * g * (0.4 + near * 0.6), 1400, 1.4, len * 0.7);
  // Shock-front whoosh sweeping down.
  const wenv = e.envGain(t - 0.15, 0.2, 0.45 * g * (0.3 + near * 0.7), 1.8, v.out);
  const bp = e.filter('bandpass', 2400, 0.8, wenv);
  bp.frequency.exponentialRampToValueAtTime(180, t + 1.9);
  e.noiseSrc(v, 'wide', t - 0.15, 2.2, bp);
}

/** High ringing tail (tinnitus after the flash). */
export function nukeRing(e: AudioEngine, v: Voice, t: number, g: number, dur: number): void {
  const env = e.ahrGain(t, 0.08, 0.022 * g, dur * 0.25, dur * 0.75, v.out);
  e.osc(v, 'sine', 4120, t, dur + 0.2, env);
  e.osc(v, 'sine', 4127, t, dur + 0.2, e.gain(0.7, env));
  e.osc(v, 'sine', 2060, t, dur + 0.2, e.gain(0.15, env));
}
