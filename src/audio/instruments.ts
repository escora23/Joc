// FRONT ULTRA — synthesised orchestral-hybrid instruments for the music director (owner: audio).
// Warm analog pads, formant "choir", spiccato string ostinato, driving saw bass, horn lead, brass stabs,
// FM bells, taiko / snare / hats, timpani rolls, reverse-cymbal swells, sub booms, string tremolo and
// the persistent drone. All notes schedule at absolute time `t` into a destination (a layer gain).

import { cancelFrom, type AudioEngine } from './engine';
import { midiToHz } from './dsp';
import { bell, brassStab, drum } from './sfx';

export function pad(e: AudioEngine, t: number, notes: readonly number[], dur: number, vel: number, dest: AudioNode, bright = 0.5): void {
  const rel = 2.4;
  const env = e.ahrGain(t, 1.4, vel, Math.max(0.1, dur - 1.4), rel, dest);
  const lp = e.filter('lowpass', 500 + bright * 1600, 0.9, env);
  // Slow filter breathing across the chord.
  lp.frequency.setValueAtTime(400 + bright * 900, t);
  lp.frequency.linearRampToValueAtTime(700 + bright * 1900, t + dur * 0.55);
  lp.frequency.linearRampToValueAtTime(450 + bright * 1100, t + dur + rel);
  const per = 0.32 / Math.sqrt(notes.length);
  let i = 0;
  for (const n of notes) {
    const f = midiToHz(n);
    const g = e.gain(per, lp);
    e.osc(null, 'sawtooth', f, t, dur + rel, g, -7 + (i % 3) * 2);
    e.osc(null, 'sawtooth', f, t, dur + rel, g, 8 - (i % 2) * 3);
    if (i === 0) e.osc(null, 'triangle', f * 0.5, t, dur + rel, e.gain(per * 1.2, lp));
    i++;
  }
}

/** Formant-filtered saw ensemble singing "ah" (or darker "oh"). */
export function choir(e: AudioEngine, t: number, notes: readonly number[], dur: number, vel: number, dest: AudioNode, dark = false): void {
  const rel = 2.8;
  const env = e.ahrGain(t, 1.8, vel, Math.max(0.1, dur - 1.8), rel, dest);
  const formants: readonly (readonly [number, number, number])[] = dark
    ? [[450, 7, 1], [800, 9, 0.55], [2830, 12, 0.18]]
    : [[730, 7, 1], [1090, 9, 0.6], [2440, 12, 0.22]];
  const bank = e.ac.createGain();
  for (const [f, q, a] of formants) bank.connect(e.filter('bandpass', f, q, e.gain(a * 2.2, env)));
  const vib = e.ac.createGain();
  vib.gain.value = 9;
  e.osc(null, 'sine', 5.1, t, dur + rel, vib);
  const per = 0.5 / Math.sqrt(notes.length);
  for (const n of notes) {
    const f = midiToHz(n);
    for (const d of [-11, 0, 12]) {
      const o = e.osc(null, 'sawtooth', f, t, dur + rel, e.gain(per / 3, bank), d);
      vib.connect(o.detune);
    }
  }
}

export function spiccato(e: AudioEngine, t: number, midi: number, vel: number, dest: AudioNode, len = 0.2): void {
  const env = e.envGain(t, 0.012, vel, len, dest);
  const lp = e.filter('lowpass', 2200, 0.8, env);
  const f = midiToHz(midi);
  e.osc(null, 'sawtooth', f, t, len + 0.05, e.gain(0.3, lp), -6);
  e.osc(null, 'sawtooth', f, t, len + 0.05, e.gain(0.3, lp), 6);
}

export function bass(e: AudioEngine, t: number, midi: number, len: number, vel: number, dest: AudioNode): void {
  const env = e.envGain(t, 0.004, vel, len, dest);
  const lp = e.filter('lowpass', 180, 4, env);
  lp.frequency.setValueAtTime(180, t);
  lp.frequency.linearRampToValueAtTime(1300 * (0.6 + vel * 0.5), t + 0.012);
  lp.frequency.exponentialRampToValueAtTime(220, t + len * 0.7);
  const f = midiToHz(midi);
  e.osc(null, 'sawtooth', f, t, len + 0.05, e.gain(0.45, lp));
  e.osc(null, 'square', f * 0.5, t, len + 0.05, e.gain(0.3, lp));
}

export function horn(e: AudioEngine, t: number, midi: number, dur: number, vel: number, dest: AudioNode, bright = 0.5): void {
  const rel = 0.5;
  const env = e.ahrGain(t, 0.09, vel, Math.max(0.05, dur - 0.09), rel, dest);
  const lp = e.filter('lowpass', 500, 0.8, env);
  lp.frequency.setValueAtTime(420, t);
  lp.frequency.linearRampToValueAtTime(900 + 1300 * bright, t + 0.12);
  lp.frequency.linearRampToValueAtTime(700 + 800 * bright, t + dur);
  const f = midiToHz(midi);
  const vib = e.ac.createGain();
  vib.gain.setValueAtTime(0, t);
  vib.gain.linearRampToValueAtTime(0, t + 0.25);
  vib.gain.linearRampToValueAtTime(10, t + 0.6);
  e.osc(null, 'sine', 5.3, t, dur + rel, vib);
  for (const [type, d, lvl] of [['sawtooth', -5, 0.3], ['sawtooth', 5, 0.3], ['triangle', 0, 0.35]] as const) {
    const o = e.osc(null, type, f, t, dur + rel, e.gain(lvl, lp), d);
    vib.connect(o.detune);
  }
}

export function brass(e: AudioEngine, t: number, notes: readonly number[], hold: number, vel: number, dest: AudioNode, bright = 0.8): void {
  brassStab(e, null, t, vel, notes, hold, dest, bright);
}

export function bellNote(e: AudioEngine, t: number, midi: number, vel: number, dest: AudioNode, dec = 2.6): void {
  bell(e, null, t, vel, midiToHz(midi), dec, dest, 0.45);
}

export function taiko(e: AudioEngine, t: number, vel: number, dest: AudioNode, f = 58): void {
  drum(e, null, t, vel, f, 0.9, dest);
}

export function snare(e: AudioEngine, t: number, vel: number, dest: AudioNode): void {
  const env = e.envGain(t, 0.001, vel, 0.17, dest);
  e.noiseSrc(null, 'white', t, 0.22, e.filter('bandpass', 2100, 0.7, env));
  const tone = e.envGain(t, 0.001, vel * 0.6, 0.08, dest);
  const o = e.osc(null, 'triangle', 200, t, 0.12, tone);
  o.frequency.exponentialRampToValueAtTime(160, t + 0.06);
}

export function hat(e: AudioEngine, t: number, vel: number, dest: AudioNode, open = false): void {
  const env = e.envGain(t, 0.0008, vel, open ? 0.22 : 0.035, dest);
  e.noiseSrc(null, 'white', t, open ? 0.3 : 0.06, e.filter('highpass', 7200, 0.7, env));
}

export function timpaniRoll(e: AudioEngine, t: number, len: number, v0: number, v1: number, dest: AudioNode, f = 49): void {
  const n = Math.max(4, Math.floor(len / 0.065));
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    drum(e, null, t + i * (len / n) + e.rng.range(-0.006, 0.006), (v0 + (v1 - v0) * k * k) * e.rng.range(0.8, 1), f, 0.5, dest);
  }
}

export function cymbalSwell(e: AudioEngine, t: number, len: number, vel: number, dest: AudioNode): void {
  const g = e.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vel, t + len);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.35);
  g.connect(dest);
  const hp = e.filter('highpass', 3500, 0.5, g);
  e.noiseSrc(null, 'wide', t, len + 0.4, hp);
  e.noiseSrc(null, 'crackle', t, len + 0.4, e.filter('highpass', 6000, 0.5, e.gain(0.3, g)), 1.5);
}

export function subBoom(e: AudioEngine, t: number, vel: number, dest: AudioNode): void {
  const env = e.envGain(t, 0.004, vel, 3.2, dest);
  const o = e.osc(null, 'sine', 55, t, 3.4, env);
  o.frequency.exponentialRampToValueAtTime(26, t + 1.8);
  const nEnv = e.envGain(t, 0.004, vel * 0.5, 1.6, dest);
  e.noiseSrc(null, 'brown', t, 1.8, e.filter('lowpass', 160, 0.7, nEnv));
}

export function tremolo(e: AudioEngine, t: number, notes: readonly number[], dur: number, vel: number, dest: AudioNode): void {
  const env = e.ahrGain(t, 1.5, vel, Math.max(0.1, dur - 1.5), 2.0, dest);
  const am = e.ac.createGain();
  am.gain.value = 0.55;
  am.connect(env);
  e.osc(null, 'sine', 12.5, t, dur + 2.2, e.gainParam(0.45, am.gain));
  const lp = e.filter('lowpass', 3200, 0.7, am);
  for (const n of notes) {
    e.osc(null, 'sawtooth', midiToHz(n), t, dur + 2.2, e.gain(0.16, lp), -4);
    e.osc(null, 'sawtooth', midiToHz(n), t, dur + 2.2, e.gain(0.16, lp), 5);
  }
}

/** Persistent low drone for a family instance; returns a stop(at) function. */
export function drone(e: AudioEngine, t: number, root: number, vel: number, dest: AudioNode, dark = false): (at: number) => void {
  const g = e.ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 4);
  g.connect(dest);
  const lp = e.filter('lowpass', dark ? 140 : 220, 1.2, g);
  const lfo = e.ac.createGain();
  lfo.gain.value = dark ? 50 : 90;
  lfo.connect(lp.frequency);
  const srcs: AudioScheduledSourceNode[] = [];
  const mk = (type: OscillatorType, m: number, lvl: number, det: number) => {
    const o = e.ac.createOscillator();
    o.type = type;
    o.frequency.value = midiToHz(m);
    o.detune.value = det;
    o.connect(e.gain(lvl, lp));
    o.start(t);
    srcs.push(o);
  };
  mk('sawtooth', root - 12, 0.35, -4);
  mk('sawtooth', root - 12, 0.35, 5);
  mk('sine', root, 0.5, 0);
  mk('triangle', root + 7, 0.12, 2);
  const l = e.ac.createOscillator();
  l.frequency.value = 0.07;
  l.connect(lfo);
  l.start(t);
  srcs.push(l);
  // A breath of air on top so the drone is never a pure hum.
  const air = e.ac.createBufferSource();
  air.buffer = e.noise.wide;
  air.loop = true;
  air.connect(e.filter('bandpass', midiToHz(root + 36), 6, e.gain(dark ? 0.05 : 0.035, g)));
  air.start(t);
  srcs.push(air);
  return (at: number) => {
    cancelFrom(g.gain, at);
    g.gain.linearRampToValueAtTime(0, at + 3);
    for (const s of srcs) s.stop(at + 3.1);
  };
}
