// FRONT ULTRA — audio DSP helpers (owner: audio): seeded RNG, pitch maths, generated noise buffers,
// the procedural convolution-reverb impulse response and waveshaper curves. Pure functions of an
// AudioContext: nothing here touches the game, so the offline lab renders exactly what the game plays.

/** Small fast seeded PRNG (mulberry32). Audio variation only; never used by the simulation. */
export class AudioRng {
  private s: number;
  constructor(seed = 0x5eed) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Symmetric jitter: value * (1 ± amount). */
  jitter(v: number, amount: number): number {
    return v * (1 + (this.next() * 2 - 1) * amount);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export interface NoiseBank {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /** Sparse random impulses of varying size: debris, fire crackle, gravel. */
  crackle: AudioBuffer;
  /** Stereo decorrelated pink noise for wide beds (wind, surf, roar). */
  wide: AudioBuffer;
}

/** Generates every noise source once per context (a few hundred KB, ~20 ms). */
export function makeNoiseBank(ac: BaseAudioContext, rng: AudioRng): NoiseBank {
  const sr = ac.sampleRate;
  const len = Math.floor(sr * 4);
  const white = ac.createBuffer(1, len, sr);
  const pink = ac.createBuffer(1, len, sr);
  const brown = ac.createBuffer(1, len, sr);
  const crackle = ac.createBuffer(1, len, sr);
  const wide = ac.createBuffer(2, len, sr);
  const w = white.getChannelData(0);
  const p = pink.getChannelData(0);
  const b = brown.getChannelData(0);
  const c = crackle.getChannelData(0);
  // Paul Kellet's refined pink filter.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let br = 0;
  let pPeak = 0, bPeak = 0;
  for (let i = 0; i < len; i++) {
    const x = rng.next() * 2 - 1;
    w[i] = x;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    const pv = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
    b6 = x * 0.115926;
    p[i] = pv;
    br = (br + 0.02 * x) / 1.02;
    b[i] = br;
    if (Math.abs(pv) > pPeak) pPeak = Math.abs(pv);
    if (Math.abs(br) > bPeak) bPeak = Math.abs(br);
  }
  for (let i = 0; i < len; i++) {
    p[i] /= pPeak;
    b[i] /= bPeak;
  }
  // Crackle: poisson impulses with short ringing decays (sounds like debris / burning wood).
  let i = 0;
  while (i < len) {
    i += Math.floor(rng.range(0.002, 0.03) * sr);
    const amp = Math.pow(rng.next(), 2.5) * (rng.next() < 0.5 ? -1 : 1);
    const dec = rng.range(0.0004, 0.003) * sr;
    const ring = rng.range(0.2, 0.9);
    for (let k = 0; k < dec * 4 && i + k < len; k++) {
      c[i + k] += amp * Math.exp(-k / dec) * (k % 2 === 0 ? 1 : -ring);
    }
  }
  normalize(c);
  // Wide stereo pink: two independent pink streams.
  for (let ch = 0; ch < 2; ch++) {
    const d = wide.getChannelData(ch);
    let a0 = 0, a1 = 0, a2 = 0;
    for (let k = 0; k < len; k++) {
      const x = rng.next() * 2 - 1;
      a0 = 0.99765 * a0 + x * 0.099046;
      a1 = 0.963 * a1 + x * 0.2965164;
      a2 = 0.57 * a2 + x * 1.0526913;
      d[k] = a0 + a1 + a2 + x * 0.1848;
    }
    normalize(d);
  }
  // Seamless loops: crossfade the last 50 ms into the start.
  for (const buf of [white, pink, brown, crackle, wide]) loopFade(buf, Math.floor(sr * 0.05));
  return { white, pink, brown, crackle, wide };
}

function normalize(d: Float32Array): void {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] /= m;
}

function loopFade(buf: AudioBuffer, n: number): void {
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    const L = d.length;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = d[i] * t + d[L - n + i] * (1 - t);
    }
  }
}

/**
 * Procedural stereo impulse response: early reflections from a few virtual walls, then a dense diffuse tail
 * whose high frequencies die faster than the lows (a one-pole low-pass whose cutoff falls over time).
 */
export function makeImpulseResponse(ac: BaseAudioContext, rng: AudioRng, seconds: number, decay: number, brightness: number): AudioBuffer {
  const sr = ac.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ac.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // Early reflections (first 80 ms).
    for (let r = 0; r < 14; r++) {
      const at = Math.floor(sr * (0.006 + rng.next() * 0.075));
      d[at] += (rng.next() * 2 - 1) * 0.6 * (1 - r / 16);
    }
    let lp = 0;
    const pre = Math.floor(sr * 0.012);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp(-t * (6.9 / decay));
      // Cutoff coefficient: bright at the start, dark at the end.
      const k = brightness * Math.exp(-t * 2.2) + 0.04;
      lp += k * ((rng.next() * 2 - 1) - lp);
      const fadeIn = Math.min(1, (i - pre) / (sr * 0.02));
      d[i] += lp * env * fadeIn * 1.6;
    }
  }
  // Normalise energy so wet level is predictable.
  let e = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) e += d[i] * d[i];
  }
  const s = 1 / Math.sqrt(e / 2);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] *= s * 2.2;
  }
  return buf;
}

/** tanh-style saturation curve; drive 1 = gentle, 10 = heavy. */
export function saturationCurve(drive: number, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / norm;
  }
  return c;
}

/**
 * Output safety clipper: linear up to 0.84, then a smooth knee that never exceeds 0.985
 * (keeps inter-sample peaks under full scale after the limiter).
 */
export function softClipCurve(n = 4096): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const knee = 0.84, ceil = 0.985;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 4 - 2; // input range -2..2
    const a = Math.abs(x);
    let y: number;
    if (a <= knee) y = a;
    else y = knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** Periodic wave with the given harmonic amplitudes (organ / reed / bell-ish timbres). */
export function harmonicWave(ac: BaseAudioContext, amps: readonly number[]): PeriodicWave {
  const real = new Float32Array(amps.length + 1);
  const imag = new Float32Array(amps.length + 1);
  for (let i = 0; i < amps.length; i++) imag[i + 1] = amps[i];
  return ac.createPeriodicWave(real, imag, { disableNormalization: false });
}
