// FRONT ULTRA — continuous sound beds (owner: audio):
//  * BattleAmbience: the war you hear from the strategic camera — a low front-line rumble bed, a
//    distant small-arms crackle bed and scattered individual artillery / gunfire / explosion events,
//    all driven by the fronts in view, their intensity and the camera altitude; plus high-altitude wind.
//  * VehicleLoop: command-mode engines (tank diesel + tracks, jet turbine + afterburner, ship diesel +
//    sea wash) whose rpm/level follow the vehicle speed.
//  * Siren: the incoming-nuke air-raid siren (winds up, wails, winds down when stopped).

import { cancelFrom, type AudioEngine, type Voice } from './engine';
import { clamp01 } from './dsp';
import { sirenGraph } from './sfx';

/** Front as heard from the camera: pan -1..1 and nearness factors 0..1. */
export interface HeardFront {
  pan: number;
  /** Nearness for the rumble (hundreds of km). */
  far: number;
  /** Nearness for small arms (tens of km). */
  near: number;
  intensity: number;
  /** Continuous tile coordinates of the front point (for positional events). */
  lat: number;
  lon: number;
}

export type EventSink = (cue: string, lat: number, lon: number, gain: number) => void;

export class BattleAmbience {
  private readonly rumble: GainNode;
  private readonly rumblePan: StereoPannerNode;
  private readonly rumbleLp: BiquadFilterNode;
  private readonly arms: GainNode;
  private readonly armsPan: StereoPannerNode;
  private readonly wind: GainNode;
  private readonly windBp: BiquadFilterNode;
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private artT = 0;
  private gunT = 0;
  private boomT = 0;

  constructor(private readonly e: AudioEngine) {
    const ac = e.ac;
    const amb = e.buses.amb.in;
    // Rumble: brown noise → low-pass, amplitude-modulated by two slow LFOs (rolling barrages).
    this.rumble = ac.createGain();
    this.rumble.gain.value = 0;
    this.rumblePan = e.panner(0, amb);
    this.rumble.connect(this.rumblePan);
    this.rumbleLp = e.filter('lowpass', 160, 0.8, this.rumble);
    const am = ac.createGain();
    am.gain.value = 0.6;
    am.connect(this.rumbleLp);
    this.loopNoise('brown', e.shaper(1.8, am));
    this.lfo(0.37, 0.25, am.gain);
    this.lfo(1.13, 0.15, am.gain);
    // Small arms: crackle buffer (sparse impulses) band-passed like distant rifles.
    this.arms = ac.createGain();
    this.arms.gain.value = 0;
    this.armsPan = e.panner(0, amb);
    this.arms.connect(this.armsPan);
    const armsBp = e.filter('bandpass', 1300, 0.9, this.arms);
    this.loopNoise('crackle', armsBp, 0.9);
    const armsLow = e.filter('lowpass', 500, 0.7, e.gain(0.6, this.arms));
    this.loopNoise('crackle', armsLow, 0.45);
    // Wind: wide pink noise, band-pass sweeping slowly.
    this.wind = ac.createGain();
    this.wind.gain.value = 0;
    this.wind.connect(amb);
    this.windBp = e.filter('bandpass', 420, 0.6, this.wind);
    this.loopNoise('wide', this.windBp);
    this.lfo(0.061, 180, this.windBp.frequency);
    this.lfo(0.13, 0.35, this.windBp.Q);
  }

  private loopNoise(kind: 'brown' | 'crackle' | 'wide', dest: AudioNode, rate = 1): void {
    const s = this.e.ac.createBufferSource();
    s.buffer = this.e.noise[kind];
    s.loop = true;
    s.playbackRate.value = rate;
    s.connect(dest);
    s.start(this.e.now, this.e.rng.next() * 3);
    this.srcs.push(s);
  }

  private lfo(freq: number, depth: number, target: AudioParam): void {
    const o = this.e.ac.createOscillator();
    o.frequency.value = freq;
    o.connect(this.e.gainParam(depth, target));
    o.start(this.e.now);
    this.srcs.push(o);
  }

  /**
   * Update at ~10 Hz. `fronts` are the fronts currently heard (count entries of the pool),
   * `altitudeKm` the camera altitude; `level` 0..1 master for the beds (0 in menus/command).
   */
  update(dt: number, fronts: readonly HeardFront[], count: number, altitudeKm: number, level: number, sink: EventSink): void {
    const t = this.e.now;
    let far = 0, near = 0, panF = 0, panN = 0, wF = 0, wN = 0;
    let best: HeardFront | null = null;
    let bestScore = 0;
    for (let i = 0; i < count; i++) {
      const f = fronts[i];
      const a = f.intensity * f.far;
      const b = f.intensity * f.near;
      far += a;
      near += b;
      panF += f.pan * a;
      panN += f.pan * b;
      wF += a;
      wN += b;
      if (a + b * 3 > bestScore) {
        bestScore = a + b * 3;
        best = f;
      }
    }
    const rumbleLv = clamp01(far * 0.8) * level;
    const armsLv = clamp01(near * 0.9) * level;
    this.rumble.gain.setTargetAtTime(rumbleLv * 0.9, t, 0.6);
    this.rumblePan.pan.setTargetAtTime(wF > 0 ? Math.max(-0.8, Math.min(0.8, panF / wF)) : 0, t, 0.8);
    // Closer = brighter rumble.
    this.rumbleLp.frequency.setTargetAtTime(110 + 260 * clamp01(near * 2), t, 0.8);
    this.arms.gain.setTargetAtTime(armsLv * 0.55, t, 0.4);
    this.armsPan.pan.setTargetAtTime(wN > 0 ? Math.max(-0.9, Math.min(0.9, panN / wN)) : 0, t, 0.5);
    // Wind: strongest low over the ground, a whisper from orbit.
    const alt = Math.max(0.3, altitudeKm);
    const windLv = level * (0.05 + 0.3 * clamp01(1 - Math.log10(alt) / 3.3));
    this.wind.gain.setTargetAtTime(windLv * 0.5, t, 1.5);

    // Scattered discrete events near the hottest front.
    if (!best || level <= 0.01) return;
    const heat = best.intensity;
    this.artT -= dt * heat * best.far * 2.2;
    this.gunT -= dt * heat * best.near * 5;
    this.boomT -= dt * heat * best.near * 1.4;
    const r = this.e.rng;
    if (this.artT <= 0) {
      this.artT = r.range(0.4, 1.6);
      sink('artillery', best.lat + r.range(-0.4, 0.4), best.lon + r.range(-0.4, 0.4), r.range(0.5, 1) * level);
    }
    if (this.gunT <= 0) {
      this.gunT = r.range(0.3, 1.2);
      sink('gunfire', best.lat + r.range(-0.15, 0.15), best.lon + r.range(-0.15, 0.15), r.range(0.5, 1) * level);
    }
    if (this.boomT <= 0) {
      this.boomT = r.range(0.8, 2.5);
      sink(r.next() < 0.2 ? 'tankCannon' : 'explosionSmall', best.lat + r.range(-0.2, 0.2), best.lon + r.range(-0.2, 0.2), r.range(0.4, 0.9) * level);
    }
  }

  silence(): void {
    const t = this.e.now;
    this.rumble.gain.setTargetAtTime(0, t, 0.3);
    this.arms.gain.setTargetAtTime(0, t, 0.3);
    this.wind.gain.setTargetAtTime(0, t, 0.5);
  }
}

// ---------------------------------------------------------------------------------------------

export type VehicleKind = 'tank' | 'jet' | 'ship';

export class VehicleLoop {
  private readonly out: GainNode;
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private readonly pitched: OscillatorNode[] = [];
  private readonly baseFreq: number[] = [];
  private readonly lp: BiquadFilterNode;
  private readonly aux: GainNode;
  private readonly auxLp: BiquadFilterNode;
  private readonly burner: GainNode;
  private readonly amLfo: OscillatorNode | null = null;
  private speed = 0;
  private stopped = false;

  constructor(private readonly e: AudioEngine, readonly kind: VehicleKind) {
    const ac = e.ac;
    const t = e.now;
    this.out = ac.createGain();
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(1, t + 1.5);
    this.out.connect(e.buses.sfx.in);
    const mkOsc = (type: OscillatorType, f: number, lvl: number, dest: AudioNode, det = 0) => {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(e.gain(lvl, dest));
      o.start(t);
      this.srcs.push(o);
      this.pitched.push(o);
      this.baseFreq.push(f);
    };
    const mkNoise = (kind: 'brown' | 'pink' | 'crackle' | 'wide' | 'white', dest: AudioNode, rate = 1) => {
      const s = ac.createBufferSource();
      s.buffer = e.noise[kind];
      s.loop = true;
      s.playbackRate.value = rate;
      s.connect(dest);
      s.start(t, e.rng.next() * 3);
      this.srcs.push(s);
      return s;
    };
    this.aux = ac.createGain();
    this.aux.gain.value = 0;
    this.aux.connect(this.out);
    this.auxLp = e.filter('bandpass', 2600, 2, this.aux);
    this.burner = ac.createGain();
    this.burner.gain.value = 0;
    this.burner.connect(this.out);

    if (kind === 'tank') {
      // Diesel: saw/square stack through saturation, amplitude-modulated at the firing rate.
      this.lp = e.filter('lowpass', 420, 1.3, this.out);
      const am = ac.createGain();
      am.gain.value = 0.65;
      am.connect(this.lp);
      const sat = e.shaper(3.2, am);
      mkOsc('sawtooth', 36, 0.28, sat);
      mkOsc('square', 72.3, 0.12, sat);
      mkOsc('sawtooth', 18, 0.22, sat, 6);
      const lfo = ac.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 12;
      lfo.connect(e.gainParam(0.28, am.gain));
      lfo.start(t);
      this.srcs.push(lfo);
      this.amLfo = lfo;
      // Tracks: crackle band-passed = squeal and link clatter.
      mkNoise('crackle', this.auxLp, 1.4);
      mkNoise('crackle', e.filter('lowpass', 500, 0.7, this.aux), 0.7);
    } else if (kind === 'jet') {
      this.lp = e.filter('lowpass', 900, 0.6, this.out);
      mkNoise('brown', e.gain(0.9, this.lp));
      mkNoise('wide', e.gain(0.35, this.lp));
      // Turbine whine (high, thin).
      const whineBp = e.filter('bandpass', 3600, 8, e.gain(0.5, this.out));
      mkNoise('white', whineBp);
      mkOsc('sawtooth', 3400, 0.025, e.filter('lowpass', 6000, 0.7, this.out));
      mkOsc('sine', 1700, 0.02, this.out);
      // Afterburner: saturated low roar + crackle.
      mkNoise('brown', e.filter('lowpass', 380, 0.9, e.shaper(2.5, e.gain(1.2, this.burner))));
      mkNoise('crackle', e.filter('bandpass', 900, 0.7, e.gain(0.5, this.burner)), 0.8);
      this.auxLp.frequency.value = 5000;
      mkNoise('wide', this.auxLp);
    } else {
      // Ship: slow two-stroke diesel thrum + sea wash swelling.
      this.lp = e.filter('lowpass', 200, 1.1, this.out);
      const am = ac.createGain();
      am.gain.value = 0.6;
      am.connect(this.lp);
      const sat = e.shaper(2.4, am);
      mkOsc('sawtooth', 24, 0.3, sat);
      mkOsc('square', 48.2, 0.12, sat);
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 6;
      lfo.connect(e.gainParam(0.3, am.gain));
      lfo.start(t);
      this.srcs.push(lfo);
      this.amLfo = lfo;
      const wash = ac.createGain();
      wash.gain.value = 0.35;
      wash.connect(this.out);
      const washLp = e.filter('lowpass', 900, 0.5, wash);
      mkNoise('wide', washLp);
      const swell = ac.createOscillator();
      swell.frequency.value = 0.11;
      swell.connect(e.gainParam(0.22, wash.gain));
      swell.start(t);
      this.srcs.push(swell);
      this.auxLp.type = 'lowpass';
      this.auxLp.frequency.value = 1600;
      mkNoise('pink', this.auxLp);
    }
  }

  /** speed01: 0 idle .. 1 top speed; boost: afterburner / full throttle flag 0..1. */
  update(speed01: number, boost: number): void {
    if (this.stopped) return;
    const t = this.e.now;
    this.speed += (speed01 - this.speed) * 0.25;
    const s = clamp01(this.speed);
    const k = this.kind === 'tank' ? 1 + s * 0.9 : this.kind === 'jet' ? 0.8 + s * 0.5 : 1 + s * 0.6;
    for (let i = 0; i < this.pitched.length; i++) this.pitched[i].frequency.setTargetAtTime(this.baseFreq[i] * k, t, 0.15);
    if (this.amLfo) this.amLfo.frequency.setTargetAtTime((this.kind === 'tank' ? 12 : 6) * k, t, 0.15);
    if (this.kind === 'tank') {
      this.lp.frequency.setTargetAtTime(380 + 900 * s, t, 0.2);
      this.aux.gain.setTargetAtTime(0.02 + 0.3 * s, t, 0.2);
      this.out.gain.setTargetAtTime(0.55 + 0.35 * s, t, 0.3);
    } else if (this.kind === 'jet') {
      this.lp.frequency.setTargetAtTime(600 + 2200 * s, t, 0.3);
      this.aux.gain.setTargetAtTime(0.1 * s * s, t, 0.3);
      this.burner.gain.setTargetAtTime(0.7 * clamp01(boost), t, 0.25);
      this.out.gain.setTargetAtTime(0.35 + 0.35 * s, t, 0.3);
    } else {
      this.lp.frequency.setTargetAtTime(170 + 200 * s, t, 0.4);
      this.aux.gain.setTargetAtTime(0.25 * s, t, 0.5);
      this.out.gain.setTargetAtTime(0.5 + 0.3 * s, t, 0.4);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.e.now;
    cancelFrom(this.out.gain, t);
    this.out.gain.linearRampToValueAtTime(0, t + 0.8);
    for (const s of this.srcs) s.stop(t + 0.9);
  }
}

// ---------------------------------------------------------------------------------------------

export class Siren {
  private v: Voice | null = null;

  constructor(private readonly e: AudioEngine) {}

  get active(): boolean {
    return !!this.v && !this.v.dead && this.v.end > this.e.now;
  }

  start(seconds: number, gain = 1): void {
    const dur = Math.max(6, Math.min(24, seconds));
    if (this.active) {
      return;
    }
    const v = this.e.voice('siren', 9, dur + 1, 'sfx', { wet: 0.35, echo: 0.3 });
    if (!v) return;
    sirenGraph(this.e, v, this.e.now, gain, dur);
    this.v = v;
  }

  stop(): void {
    const v = this.v;
    if (!v || v.dead) return;
    const t = this.e.now;
    for (const s of v.srcs) if (s instanceof OscillatorNode) {
      cancelFrom(s.frequency, t);
      s.frequency.exponentialRampToValueAtTime(Math.max(40, s.frequency.value * 0.3), t + 2.6);
    }
    cancelFrom(v.out.gain, t);
    v.out.gain.linearRampToValueAtTime(0, t + 2.8);
    v.end = t + 3;
    this.v = null;
  }
}
