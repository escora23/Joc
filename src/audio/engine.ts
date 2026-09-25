// FRONT ULTRA — Web Audio engine core (owner: audio).
// Mixer graph, category buses, generated convolution reverb, outdoor echo, master compressor + limiter +
// safety clipper, the global duck (nuke silence-then-roar), voice budget with priority stealing and
// the synthesis primitives every cue is built from. Works on any BaseAudioContext, so the offline lab
// (OfflineAudioContext) renders exactly the graph the game plays.
//
//   voices ─► bus.in ─► bus.vol ─┬─► duck ─► mix ─► DC block ─► glue comp ─► limiter ─► master vol ─► ½ ─► soft clip ─► out
//                                └─► bus.send ─► reverb ─► duck
//   'over' bus (nuke roar, stingers) skips the duck and has its own reverb, so it can roar through the silence.

import { AudioRng, makeImpulseResponse, makeNoiseBank, saturationCurve, softClipCurve, type NoiseBank } from './dsp';

export type BusName = 'music' | 'sfx' | 'ui' | 'amb' | 'over';

export interface Bus {
  readonly in: GainNode;
  /** Extra reverb-only input (per-voice wet amount). */
  readonly wet: GainNode;
  readonly vol: GainNode;
  readonly volWet: GainNode;
  readonly send: GainNode;
}

export interface Voice {
  cue: string;
  pri: number;
  start: number;
  end: number;
  /** Everything of the voice passes through this gain (used to steal it). */
  out: GainNode;
  srcs: AudioScheduledSourceNode[];
  dead: boolean;
}

export interface VoiceOpts {
  /** -1..1 stereo position. */
  pan?: number;
  /** Air-absorption low-pass (Hz); omitted = none. */
  lowpass?: number;
  /** Reverb-only send amount on top of the bus default. */
  wet?: number;
  /** Outdoor echo send amount (sfx/amb). */
  echo?: number;
  gain?: number;
}

type NoiseKind = keyof NoiseBank;

const BUS_SEND: Record<BusName, number> = { music: 0.32, sfx: 0.16, ui: 0.08, amb: 0.22, over: 0.3 };
/** Base trims so default settings give a balanced mix. */
const BUS_TRIM: Record<BusName, number> = { music: 0.66, sfx: 0.9, ui: 0.6, amb: 0.62, over: 1 };

export class AudioEngine {
  readonly ac: BaseAudioContext;
  readonly rng: AudioRng;
  readonly noise: NoiseBank;
  readonly buses: Record<BusName, Bus>;
  /** Global duck (0..1). */
  readonly duckGain: GainNode;
  /** Music-only side-chain dip under very loud effects. */
  readonly musicDip: GainNode;
  readonly masterVol: GainNode;
  readonly echoIn: GainNode;
  readonly reverb: ConvolverNode;
  readonly overReverb: ConvolverNode;
  maxVoices = 32;
  voices: Voice[] = [];
  private readonly lastCue = new Map<string, number>();
  private readonly curves = new Map<number, Float32Array<ArrayBuffer>>();
  private volumes: Record<BusName, number> = { music: 1, sfx: 1, ui: 1, amb: 1, over: 1 };
  private duckFloorUntil = 0;
  private duckDepth = 1;

  constructor(ac: BaseAudioContext, destination: AudioNode, seed = 0xf00d) {
    this.ac = ac;
    this.rng = new AudioRng(seed);
    this.noise = makeNoiseBank(ac, this.rng);

    // --- master chain -----------------------------------------------------------------------
    const mix = ac.createGain();
    const glue = ac.createDynamicsCompressor();
    glue.threshold.value = -12;
    glue.knee.value = 14;
    glue.ratio.value = 2;
    glue.attack.value = 0.012;
    glue.release.value = 0.28;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.0015;
    limiter.release.value = 0.12;
    const trim = ac.createGain();
    trim.gain.value = 0.72;
    this.masterVol = ac.createGain();
    const half = ac.createGain();
    half.gain.value = 0.5;
    const clip = ac.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = '2x';
    // DC blocker / infrasound trim: nothing below ~18 Hz reaches the dynamics or the speakers.
    const dcBlock = ac.createBiquadFilter();
    dcBlock.type = 'highpass';
    dcBlock.frequency.value = 18;
    dcBlock.Q.value = 0.6;
    mix.connect(dcBlock);
    dcBlock.connect(glue);
    glue.connect(limiter);
    limiter.connect(trim);
    trim.connect(this.masterVol);
    this.masterVol.connect(half);
    half.connect(clip);
    clip.connect(destination);

    this.duckGain = ac.createGain();
    this.duckGain.connect(mix);
    this.musicDip = ac.createGain();
    this.musicDip.connect(this.duckGain);

    // --- reverbs ----------------------------------------------------------------------------
    this.reverb = ac.createConvolver();
    this.reverb.normalize = false;
    this.reverb.buffer = makeImpulseResponse(ac, this.rng, 3.2, 2.6, 0.55);
    const revOut = ac.createGain();
    revOut.gain.value = 0.55;
    this.reverb.connect(revOut);
    revOut.connect(this.duckGain);
    this.overReverb = ac.createConvolver();
    this.overReverb.normalize = false;
    this.overReverb.buffer = makeImpulseResponse(ac, this.rng, 5.5, 4.8, 0.35);
    const overRevOut = ac.createGain();
    overRevOut.gain.value = 0.5;
    this.overReverb.connect(overRevOut);
    overRevOut.connect(mix);

    // --- buses ------------------------------------------------------------------------------
    const mk = (name: BusName): Bus => {
      const bin = ac.createGain();
      const wet = ac.createGain();
      const vol = ac.createGain();
      const volWet = ac.createGain();
      const send = ac.createGain();
      send.gain.value = BUS_SEND[name];
      bin.connect(vol);
      wet.connect(volWet);
      const dryDest: AudioNode = name === 'over' ? mix : name === 'music' ? this.musicDip : this.duckGain;
      const rev = name === 'over' ? this.overReverb : this.reverb;
      vol.connect(dryDest);
      vol.connect(send);
      send.connect(rev);
      volWet.connect(rev);
      return { in: bin, wet, vol, volWet, send };
    };
    this.buses = { music: mk('music'), sfx: mk('sfx'), ui: mk('ui'), amb: mk('amb'), over: mk('over') };

    // --- outdoor echo (valleys, city walls): two taps with damped feedback -------------------
    this.echoIn = ac.createGain();
    const d1 = ac.createDelay(2);
    d1.delayTime.value = 0.31;
    const d2 = ac.createDelay(2);
    d2.delayTime.value = 0.53;
    const fb = ac.createGain();
    fb.gain.value = 0.32;
    const damp = ac.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 1400;
    const echoOut = ac.createGain();
    echoOut.gain.value = 0.5;
    const p1 = ac.createStereoPanner();
    p1.pan.value = -0.6;
    const p2 = ac.createStereoPanner();
    p2.pan.value = 0.55;
    this.echoIn.connect(damp);
    damp.connect(d1);
    damp.connect(d2);
    d1.connect(p1);
    d2.connect(p2);
    p1.connect(echoOut);
    p2.connect(echoOut);
    d2.connect(fb);
    fb.connect(damp);
    echoOut.connect(this.buses.sfx.in);
    this.applyVolumes();
  }

  get now(): number {
    return this.ac.currentTime;
  }

  // ---------------------------------------------------------------------------------------------
  // Volumes & ducking
  // ---------------------------------------------------------------------------------------------

  setVolumes(master: number, music: number, sfx: number, ui: number): void {
    this.volumes = { music, sfx, ui, amb: sfx, over: Math.max(music, sfx) };
    this.masterVol.gain.setTargetAtTime(master, this.now, 0.05);
    this.applyVolumes();
  }

  private applyVolumes(): void {
    const t = this.now;
    for (const k of Object.keys(this.buses) as BusName[]) {
      const v = this.volumes[k] * BUS_TRIM[k];
      this.buses[k].vol.gain.setTargetAtTime(v, t, 0.05);
      this.buses[k].volWet.gain.setTargetAtTime(v, t, 0.05);
    }
  }

  /**
   * Global duck: fall to `level` in ~40 ms, hold, then recover to 1 over `releaseMs` with an
   * exponential-feeling curve. Overlapping ducks keep the deepest level and the latest release.
   */
  duck(level: number, holdMs: number, releaseMs: number, at = this.now): void {
    const g = this.duckGain.gain;
    const holdEnd = at + holdMs / 1000;
    if (at < this.duckFloorUntil) level = Math.min(level, this.duckDepth);
    this.duckDepth = level;
    this.duckFloorUntil = Math.max(this.duckFloorUntil, holdEnd);
    cancelFrom(g, at);
    g.setTargetAtTime(Math.max(0.0001, level), at, 0.012);
    g.setValueAtTime(Math.max(0.0001, level), this.duckFloorUntil);
    const rel = Math.max(0.05, releaseMs / 1000);
    // Two-stage recovery: slow start (the world "comes back"), then settles.
    g.linearRampToValueAtTime(level + (1 - level) * 0.25, this.duckFloorUntil + rel * 0.45);
    g.linearRampToValueAtTime(1, this.duckFloorUntil + rel);
  }

  /** Brief music-only dip under big hits (a cheap side-chain). */
  dipMusic(amount: number, seconds: number, at = this.now): void {
    const g = this.musicDip.gain;
    cancelFrom(g, at);
    g.setTargetAtTime(1 - amount, at, 0.02);
    g.setTargetAtTime(1, at + 0.08, seconds / 3);
  }

  // ---------------------------------------------------------------------------------------------
  // Voices
  // ---------------------------------------------------------------------------------------------

  /** True if `cue` may fire now (per-cue minimum spacing, in seconds). */
  rateOk(cue: string, minGap: number, at = this.now): boolean {
    const last = this.lastCue.get(cue);
    if (last !== undefined && at - last < minGap && at >= last) return false;
    this.lastCue.set(cue, at);
    return true;
  }

  /**
   * Opens a voice on `bus` lasting `dur` seconds. Returns null when the budget is full and every active
   * voice outranks this one; otherwise the lowest-priority oldest voice is faded out and replaced.
   */
  voice(cue: string, pri: number, dur: number, bus: BusName, o: VoiceOpts = {}, at = this.now): Voice | null {
    this.sweep(at);
    if (this.voices.length >= this.maxVoices) {
      let worst = -1;
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (worst < 0 || v.pri < this.voices[worst].pri || (v.pri === this.voices[worst].pri && v.start < this.voices[worst].start)) worst = i;
      }
      if (worst < 0 || this.voices[worst].pri > pri) return null;
      this.kill(this.voices[worst], at);
      this.voices.splice(worst, 1);
    }
    const ac = this.ac;
    const out = ac.createGain();
    out.gain.value = o.gain ?? 1;
    let tail: AudioNode = out;
    if (o.lowpass !== undefined && o.lowpass < 18000) {
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.lowpass;
      lp.Q.value = 0.5;
      tail.connect(lp);
      tail = lp;
    }
    if (o.pan !== undefined && o.pan !== 0) {
      const p = ac.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      tail.connect(p);
      tail = p;
    }
    const b = this.buses[bus];
    tail.connect(b.in);
    if (o.wet) {
      const w = ac.createGain();
      w.gain.value = o.wet;
      tail.connect(w);
      w.connect(b.wet);
    }
    if (o.echo) {
      const e = ac.createGain();
      e.gain.value = o.echo;
      tail.connect(e);
      e.connect(this.echoIn);
    }
    const v: Voice = { cue, pri, start: at, end: at + dur, out, srcs: [], dead: false };
    this.voices.push(v);
    return v;
  }

  kill(v: Voice, at = this.now, fade = 0.04): void {
    if (v.dead) return;
    v.dead = true;
    cancelFrom(v.out.gain, at);
    v.out.gain.setTargetAtTime(0, at, fade / 3);
    for (const s of v.srcs) {
      try {
        s.stop(at + fade + 0.02);
      } catch {
        /* already stopped */
      }
    }
  }

  sweep(at = this.now): void {
    let w = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.dead && v.end > at) this.voices[w++] = v;
    }
    this.voices.length = w;
  }

  // ---------------------------------------------------------------------------------------------
  // Primitives (all schedule at absolute context time `t`)
  // ---------------------------------------------------------------------------------------------

  osc(v: Voice | null, type: OscillatorType | PeriodicWave, freq: number, t: number, dur: number, dest: AudioNode | AudioParam, detune = 0): OscillatorNode {
    const o = this.ac.createOscillator();
    if (type instanceof PeriodicWave) o.setPeriodicWave(type);
    else o.type = type as OscillatorType;
    o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.setValueAtTime(detune, t);
    if (dest instanceof AudioParam) o.connect(dest);
    else o.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    if (v) v.srcs.push(o);
    return o;
  }

  noiseSrc(v: Voice | null, kind: NoiseKind, t: number, dur: number, dest: AudioNode, rate = 1): AudioBufferSourceNode {
    const s = this.ac.createBufferSource();
    const buf = this.noise[kind];
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.setValueAtTime(rate, t);
    s.connect(dest);
    s.start(t, this.rng.next() * buf.duration * 0.9);
    s.stop(t + dur + 0.05);
    if (v) v.srcs.push(s);
    return s;
  }

  gain(value: number, dest: AudioNode): GainNode {
    const g = this.ac.createGain();
    g.gain.value = value;
    g.connect(dest);
    return g;
  }

  /** Gain node feeding an AudioParam (LFO depth). */
  gainParam(value: number, param: AudioParam): GainNode {
    const g = this.ac.createGain();
    g.gain.value = value;
    g.connect(param);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode, gainDb = 0): BiquadFilterNode {
    const f = this.ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    f.connect(dest);
    return f;
  }

  shaper(drive: number, dest: AudioNode): WaveShaperNode {
    const key = Math.round(drive * 100);
    let c = this.curves.get(key);
    if (!c) {
      c = saturationCurve(drive);
      this.curves.set(key, c);
    }
    const s = this.ac.createWaveShaper();
    s.curve = c;
    s.connect(dest);
    return s;
  }

  panner(pan: number, dest: AudioNode): StereoPannerNode {
    const p = this.ac.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(dest);
    return p;
  }

  /** Gain node with a percussive envelope: linear attack to `peak`, exponential decay to silence. */
  envGain(t: number, attack: number, peak: number, decay: number, dest: AudioNode): GainNode {
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.max(0.001, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + Math.max(0.005, decay));
    g.connect(dest);
    return g;
  }

  /** Gain node with attack / hold / release (for sustained layers). */
  ahrGain(t: number, attack: number, peak: number, hold: number, release: number, dest: AudioNode): GainNode {
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.max(0.002, attack));
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.linearRampToValueAtTime(0, t + attack + hold + Math.max(0.01, release));
    g.connect(dest);
    return g;
  }
}

/** cancelAndHoldAtTime where available (keeps the current value instead of jumping). */
export function cancelFrom(p: AudioParam, t: number): void {
  const anyP = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof anyP.cancelAndHoldAtTime === 'function') anyP.cancelAndHoldAtTime(t);
  else {
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
}
