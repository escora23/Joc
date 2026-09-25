// FRONT ULTRA — interface sounds (owner: audio). Crisp, quiet, "military console" UI feedback:
// hover ticks, clicks, confirm/cancel pairs, errors, panel whooshes, slider detents, alerts, teletype.
// Each is a tiny graph on the 'ui' bus; the command HUD reuses some kinds for lock-on and warnings.

import type { UiSoundKind } from '../shared/events';
import type { AudioEngine, Voice } from './engine';
import { bell } from './sfx';

interface UiDef {
  gap: number;
  dur: number;
  fn: (e: AudioEngine, v: Voice, t: number, g: number) => void;
}

function tick(e: AudioEngine, v: Voice, t: number, g: number, f: number, dec: number, type: OscillatorType = 'sine'): void {
  const env = e.envGain(t, 0.0015, g, dec, v.out);
  e.osc(v, type, f, t, dec + 0.03, env);
}

function click(e: AudioEngine, v: Voice, t: number, g: number, hp: number): void {
  const env = e.envGain(t, 0.0004, g, 0.012, v.out);
  e.noiseSrc(v, 'white', t, 0.03, e.filter('highpass', hp, 0.7, env));
}

function sweep(e: AudioEngine, v: Voice, t: number, g: number, f0: number, f1: number, len: number, q = 1.2): void {
  const env = e.ahrGain(t, len * 0.35, g, 0, len * 0.65, v.out);
  const bp = e.filter('bandpass', f0, q, env);
  bp.frequency.setValueAtTime(f0, t);
  bp.frequency.exponentialRampToValueAtTime(f1, t + len);
  e.noiseSrc(v, 'pink', t, len + 0.05, bp);
}

export const UI_SOUNDS: Record<UiSoundKind, UiDef> = {
  hover: {
    gap: 0.035, dur: 0.06,
    fn(e, v, t, g) {
      tick(e, v, t, 0.07 * g, 2640, 0.028);
      click(e, v, t, 0.04 * g, 6000);
    },
  },
  click: {
    gap: 0.03, dur: 0.12,
    fn(e, v, t, g) {
      click(e, v, t, 0.2 * g, 2500);
      const env = e.envGain(t, 0.001, 0.2 * g, 0.07, v.out);
      const o = e.osc(v, 'triangle', 1500, t, 0.09, env);
      o.frequency.exponentialRampToValueAtTime(1050, t + 0.05);
    },
  },
  confirm: {
    gap: 0.06, dur: 0.5,
    fn(e, v, t, g) {
      click(e, v, t, 0.14 * g, 3000);
      tick(e, v, t, 0.16 * g, 880, 0.12, 'triangle');
      tick(e, v, t + 0.07, 0.17 * g, 1318.5, 0.28, 'triangle');
      tick(e, v, t + 0.07, 0.05 * g, 2637, 0.2);
    },
  },
  cancel: {
    gap: 0.06, dur: 0.35,
    fn(e, v, t, g) {
      click(e, v, t, 0.12 * g, 2500);
      tick(e, v, t, 0.15 * g, 988, 0.1, 'triangle');
      tick(e, v, t + 0.07, 0.15 * g, 659, 0.18, 'triangle');
    },
  },
  error: {
    gap: 0.12, dur: 0.35,
    fn(e, v, t, g) {
      for (let i = 0; i < 2; i++) {
        const tt = t + i * 0.11;
        const env = e.ahrGain(tt, 0.003, 0.12 * g, 0.06, 0.02, e.filter('lowpass', 1800, 0.8, v.out));
        e.osc(v, 'square', 185, tt, 0.1, env);
        e.osc(v, 'sawtooth', 196, tt, 0.1, e.gain(0.6, env));
      }
    },
  },
  open: {
    gap: 0.08, dur: 0.4,
    fn(e, v, t, g) {
      sweep(e, v, t, 0.2 * g, 500, 3200, 0.22);
      tick(e, v, t + 0.12, 0.08 * g, 1760, 0.12);
    },
  },
  close: {
    gap: 0.08, dur: 0.35,
    fn(e, v, t, g) {
      sweep(e, v, t, 0.18 * g, 2800, 450, 0.2);
      tick(e, v, t + 0.1, 0.06 * g, 1175, 0.08);
    },
  },
  toggle: {
    gap: 0.04, dur: 0.12,
    fn(e, v, t, g) {
      click(e, v, t, 0.18 * g, 2000);
      tick(e, v, t, 0.14 * g, 1046, 0.05, 'square');
    },
  },
  slider: {
    gap: 0.045, dur: 0.05,
    fn(e, v, t, g) {
      click(e, v, t, 0.08 * g, 3500);
      tick(e, v, t, 0.05 * g, e.rng.range(1900, 2300), 0.02);
    },
  },
  build: {
    gap: 0.08, dur: 0.4,
    fn(e, v, t, g) {
      const env = e.envGain(t, 0.001, 0.4 * g, 0.12, v.out);
      const o = e.osc(v, 'sine', 170, t, 0.15, env);
      o.frequency.exponentialRampToValueAtTime(70, t + 0.1);
      click(e, v, t, 0.2 * g, 1800);
      tick(e, v, t + 0.05, 0.1 * g, 1568, 0.15, 'triangle');
    },
  },
  notify: {
    gap: 0.15, dur: 0.9,
    fn(e, v, t, g) {
      bell(e, v, t, 0.13 * g, 1318.5, 0.6, v.out, 0.35);
      bell(e, v, t + 0.09, 0.11 * g, 1975.5, 0.7, v.out, 0.35);
    },
  },
  alert: {
    gap: 0.3, dur: 0.6,
    fn(e, v, t, g) {
      for (let i = 0; i < 3; i++) {
        const tt = t + i * 0.13;
        const env = e.ahrGain(tt, 0.003, 0.11 * g, 0.07, 0.015, e.filter('lowpass', 3500, 0.7, v.out));
        e.osc(v, 'square', 880, tt, 0.1, env);
        e.osc(v, 'square', 1318.5, tt, 0.1, e.gain(0.4, env));
      }
    },
  },
  typewriter: {
    gap: 0.028, dur: 0.05,
    fn(e, v, t, g) {
      click(e, v, t, 0.06 * g, e.rng.range(2500, 4500));
      tick(e, v, t, 0.025 * g, e.rng.range(1400, 2200), 0.015, 'square');
    },
  },
  whoosh: {
    gap: 0.2, dur: 1.0,
    fn(e, v, t, g) {
      const pan = e.panner(0, v.out);
      pan.pan.setValueAtTime(-0.6, t);
      pan.pan.linearRampToValueAtTime(0.6, t + 0.8);
      const env = e.ahrGain(t, 0.35, 0.3 * g, 0.05, 0.5, pan);
      const bp = e.filter('bandpass', 250, 1.0, env);
      bp.frequency.exponentialRampToValueAtTime(2600, t + 0.4);
      bp.frequency.exponentialRampToValueAtTime(400, t + 0.9);
      e.noiseSrc(v, 'wide', t, 0.95, bp);
      const sub = e.envGain(t + 0.3, 0.1, 0.2 * g, 0.5, v.out);
      const o = e.osc(v, 'sine', 90, t + 0.3, 0.7, sub);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.8);
    },
  },
};
