// FRONT ULTRA — offline audio lab (owner: audio).
// Renders every cue, UI sound, loop, sequence (nuke, siren, battle ambience) and music state through the
// exact live graph into an OfflineAudioContext, measures it (peak, clipping, RMS, active length, DC,
// spectral balance, loudness over time) and draws spectrograms. Used by the `audio-lab` / `audio-music`
// shots and by src/audio/test/render.mjs, which exports WAVs to /tmp and checks them.

import { disableDisconnectTimers, type MusicFamily } from './music';
import { SoundSystem } from './sound';
import { CUES } from './sfx';
import { UI_SOUNDS } from './uisfx';
import type { UiSoundKind } from '../shared/events';
import type { HeardFront } from './loops';

export type LabGroup = 'sfx' | 'ui' | 'seq' | 'music';

export interface LabScenario {
  name: string;
  group: LabGroup;
  seconds: number;
  /** `at(t, fn)` runs fn when the offline render reaches t (context is suspended meanwhile). */
  run(s: SoundSystem, at: (t: number, fn: () => void) => void): void;
}

export interface LabMetrics {
  seconds: number;
  peak: number;
  peakDb: number;
  rmsDb: number;
  clipped: number;
  /** Seconds with short-term RMS above -50 dBFS. */
  activeSec: number;
  dc: number;
  nan: boolean;
  /** Energy fractions: <60, 60-250, 250-2k, 2k-8k, >8k Hz. */
  bands: number[];
  centroid: number;
  /** Short-term RMS (dBFS) per 250 ms window. */
  windowsDb: number[];
}

const fronts: HeardFront[] = [
  { pan: -0.4, far: 1, near: 0.8, intensity: 0.9, lat: 48, lon: 10 },
  { pan: 0.6, far: 0.6, near: 0.2, intensity: 0.6, lat: 47, lon: 12 },
];

function musicScenario(name: string, family: MusicFamily, seconds: number, intensity: number | ((t: number) => number)): LabScenario {
  return {
    name, group: 'music', seconds,
    run(s, at) {
      const i0 = typeof intensity === 'number' ? intensity : intensity(0);
      s.music.intensity = i0;
      s.music.setFamily(family, 0, 0.1);
      if (typeof intensity === 'function') {
        for (let t = 0.5; t < seconds; t += 0.5) at(t, () => s.music.setIntensity(intensity(t), t, 2.5));
      }
    },
  };
}

export function labScenarios(): LabScenario[] {
  const list: LabScenario[] = [];
  for (const [name, def] of Object.entries(CUES)) {
    if (def.bus === 'music') continue;
    list.push({ name: `sfx:${name}`, group: 'sfx', seconds: def.dur + 1.6, run: (s) => void s.play(name, 1, { at: 0.05 }) });
  }
  list.push({ name: 'sfx:explosionLarge@far', group: 'sfx', seconds: 6, run: (s) => void s.play('explosionLarge', 0.45, { at: 0.05, dist: 0.85, lowpass: 900, pan: 0.5 }) });
  list.push({ name: 'sfx:artillery@far', group: 'sfx', seconds: 4, run: (s) => void s.play('artillery', 0.5, { at: 0.05, dist: 0.9, lowpass: 700, pan: -0.6 }) });
  list.push({ name: 'sfx:victory', group: 'sfx', seconds: 6, run: (s) => void s.play('victory', 1, { at: 0.05 }) });
  list.push({ name: 'sfx:defeat', group: 'sfx', seconds: 7, run: (s) => void s.play('defeat', 1, { at: 0.05 }) });
  for (const [kind, def] of Object.entries(UI_SOUNDS)) {
    list.push({ name: `ui:${kind}`, group: 'ui', seconds: def.dur + 0.7, run: (s) => void s.ui(kind as UiSoundKind, 1, 0.05) });
  }
  list.push({
    name: 'seq:nuke-near', group: 'seq', seconds: 24,
    run(s, at) {
      s.music.intensity = 0.7;
      s.music.setFamily('game', 0, 0.1);
      for (let t = 0.1; t < 24; t += 0.1) at(t, () => s.amb.update(0.1, fronts, 2, 30, 1, (c, _la, _lo, g) => void s.play(c, g * 0.6, { dist: 0.5, lowpass: 3000 })));
      at(5, () => {
        s.nuke(1, 1.6, false, 5.02);
        s.music.setFamily('nuclear', 5.02, 1.5);
      });
    },
  });
  list.push({
    name: 'seq:nuke-orbit', group: 'seq', seconds: 18,
    run(s, at) {
      s.music.intensity = 0.3;
      s.music.setFamily('game', 0, 0.1);
      at(3, () => s.nuke(0.38, 1, false, 3.02));
    },
  });
  list.push({
    name: 'seq:nuke-hidden-mirv', group: 'seq', seconds: 16,
    run(s, at) {
      at(1, () => s.nuke(0.4, 0.8, true, 1.02));
      at(1.6, () => s.nuke(0.4, 0.8, true, 1.62));
      at(2.3, () => s.nuke(0.4, 0.8, true, 2.32));
    },
  });
  list.push({
    name: 'seq:siren', group: 'seq', seconds: 16,
    run(s, at) {
      at(0.05, () => s.siren.start(14));
      at(11, () => s.siren.stop());
    },
  });
  list.push({
    name: 'seq:battle-ambience', group: 'seq', seconds: 14,
    run(s, at) {
      for (let t = 0.1; t < 14; t += 0.1) {
        const alt = 400 * Math.pow(0.01, t / 14);
        const f = fronts.map((fr) => ({ ...fr, near: fr.near * (1 - alt / 400) }));
        at(t, () => s.amb.update(0.1, f, 2, alt, 1, (c, _la, _lo, g) => void s.play(c, g * 0.7, { dist: 0.3 + alt / 600, lowpass: 16000 - alt * 30, pan: s.eng.rng.range(-0.7, 0.7) })));
      }
    },
  });
  for (const kind of ['tank', 'jet', 'ship'] as const) {
    list.push({
      name: `seq:vehicle-${kind}`, group: 'seq', seconds: 12,
      run(s, at) {
        at(0.05, () => s.startVehicle(kind));
        for (let t = 0.1; t < 11; t += 0.05) {
          const sp = t < 1.5 ? 0 : t < 6 ? (t - 1.5) / 4.5 : t < 8.5 ? 1 : Math.max(0, 1 - (t - 8.5) / 1.5);
          at(t, () => s.vehicle?.update(sp, kind === 'jet' && t > 5 && t < 8 ? 1 : 0));
        }
        at(11, () => s.stopVehicle());
      },
    });
  }
  list.push(musicScenario('music:menu', 'menu', 40, 0));
  list.push(musicScenario('music:calm', 'game', 30, 0.05));
  list.push(musicScenario('music:tension', 'game', 30, 0.38));
  list.push(musicScenario('music:war', 'game', 30, 0.72));
  list.push(musicScenario('music:total-war', 'game', 30, 0.98));
  list.push(musicScenario('music:adaptive-ramp', 'game', 60, (t) => Math.min(1, t / 45)));
  list.push(musicScenario('music:nuclear', 'nuclear', 30, 0.6));
  list.push(musicScenario('music:command', 'command', 24, 0.6));
  list.push({ name: 'music:victory', group: 'music', seconds: 30, run: (s) => s.music.victory(0.05) });
  list.push({ name: 'music:defeat', group: 'music', seconds: 30, run: (s) => s.music.defeat(0.05) });
  list.push({
    name: 'music:menu-to-game', group: 'music', seconds: 30,
    run(s, at) {
      s.music.setFamily('menu', 0, 0.1);
      at(12, () => s.music.setFamily('game', 12, 3));
    },
  });
  return list;
}

export async function renderScenario(sc: LabScenario, sampleRate = 44100): Promise<AudioBuffer> {
  disableDisconnectTimers();
  const len = Math.ceil(sc.seconds * sampleRate);
  const oac = new OfflineAudioContext({ numberOfChannels: 2, length: len, sampleRate });
  const s = new SoundSystem(oac, oac.destination, 0x1ab + sc.name.length * 7919);
  s.eng.setVolumes(0.8, 0.6, 0.9, 0.7);
  s.eng.maxVoices = 32;
  const hooks = new Map<number, (() => void)[]>();
  const quantum = 128 / sampleRate;
  const at = (t: number, fn: () => void) => {
    const q = Math.max(1, Math.round(t / quantum)) * quantum;
    if (q >= sc.seconds - quantum) return;
    const k = Math.round(q * 1e6);
    let arr = hooks.get(k);
    if (!arr) {
      arr = [];
      hooks.set(k, arr);
    }
    arr.push(fn);
  };
  // The music scheduler runs like the live update loop (every 250 ms with look-ahead).
  for (let t = 0.25; t < sc.seconds; t += 0.25) at(t, () => s.music.schedule(t + 0.6));
  s.music.schedule(0.6);
  sc.run(s, at);
  for (const [k, fns] of hooks) {
    const t = k / 1e6;
    void oac.suspend(t).then(() => {
      for (const fn of fns) fn();
      void oac.resume();
    });
  }
  return oac.startRendering();
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

export function analyse(buf: AudioBuffer): LabMetrics {
  const sr = buf.sampleRate;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = L.length;
  let peak = 0, sum = 0, clipped = 0, dc = 0, nan = false;
  for (let i = 0; i < n; i++) {
    const a = L[i], b = R[i];
    if (a !== a || b !== b) nan = true;
    const m = Math.max(Math.abs(a), Math.abs(b));
    if (m > peak) peak = m;
    if (m >= 0.999) clipped++;
    sum += a * a + b * b;
    dc += a + b;
  }
  const win = Math.floor(sr * 0.25);
  const windowsDb: number[] = [];
  let active = 0;
  for (let w = 0; w + win <= n; w += win) {
    let e = 0;
    for (let i = w; i < w + win; i++) e += L[i] * L[i] + R[i] * R[i];
    const db = 10 * Math.log10(e / (2 * win) + 1e-12);
    windowsDb.push(Math.round(db * 10) / 10);
    if (db > -50) active += 0.25;
  }
  // Spectrum: average of 4096-point FFT frames (hop 4096) on the mono mix.
  const N = 4096;
  const bandsE = [0, 0, 0, 0, 0];
  let cNum = 0, cDen = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  const frames = Math.max(1, Math.floor(n / N));
  const stride = Math.max(1, Math.floor(frames / 60));
  for (let f = 0; f < frames; f += stride) {
    const o = f * N;
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = o + i < n ? ((L[o + i] + R[o + i]) / 2) * w : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      const hz = (k * sr) / N;
      const b = hz < 60 ? 0 : hz < 250 ? 1 : hz < 2000 ? 2 : hz < 8000 ? 3 : 4;
      bandsE[b] += p;
      cNum += p * hz;
      cDen += p;
    }
  }
  const tot = bandsE.reduce((a, b) => a + b, 0) || 1;
  return {
    seconds: n / sr,
    peak,
    peakDb: Math.round(20 * Math.log10(peak + 1e-12) * 10) / 10,
    rmsDb: Math.round(10 * Math.log10(sum / (2 * n) + 1e-12) * 10) / 10,
    clipped,
    activeSec: active,
    dc: dc / (2 * n),
    nan,
    bands: bandsE.map((e) => Math.round((e / tot) * 1000) / 1000),
    centroid: Math.round(cNum / (cDen || 1)),
    windowsDb,
  };
}

/** In-place radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// WAV export & drawing
// ---------------------------------------------------------------------------------------------

export function wavBase64(buf: AudioBuffer): string {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const bytes = new Uint8Array(44 + n * ch * 2);
  const dv = new DataView(bytes.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

const MAGMA: readonly [number, number, number][] = [
  [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191],
];

function magma(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(0.9999, t)) * (MAGMA.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = MAGMA[i], b = MAGMA[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Log-frequency spectrogram (30 Hz – 16 kHz) with the waveform envelope overlaid. */
export function drawSpectrogram(cv: HTMLCanvasElement, buf: AudioBuffer): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const W = cv.width, H = cv.height;
  const img = g.createImageData(W, H);
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const sr = buf.sampleRate, n = L.length;
  const N = 1024;
  const re = new Float64Array(N), im = new Float64Array(N);
  const fLo = Math.log(30), fHi = Math.log(Math.min(16000, sr / 2));
  const col = new Float64Array(H);
  const db = new Float32Array(W * H);
  let top = -200;
  for (let x = 0; x < W; x++) {
    const c = Math.floor((x / W) * (n - N));
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = ((L[c + i] + R[c + i]) / 2) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let y = 0; y < H; y++) {
      const hz = Math.exp(fHi - (y / (H - 1)) * (fHi - fLo));
      const k = Math.min(N / 2 - 1, Math.max(1, Math.round((hz * N) / sr)));
      const p = re[k] * re[k] + im[k] * im[k];
      col[y] = 10 * Math.log10(p + 1e-12);
    }
    for (let y = 0; y < H; y++) {
      db[y * W + x] = col[y];
      if (col[y] > top) top = col[y];
    }
  }
  // Normalise to the loudest bin so dense (music) and sparse (UI) renders both read clearly: 80 dB range.
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const t = (db[y * W + x] - top + 80) / 80;
      const [r, gg, b] = magma(t);
      const o = (y * W + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = gg;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Waveform envelope (peak per column) in cyan.
  g.strokeStyle = 'rgba(120,230,255,0.85)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x < W; x++) {
    const a = Math.floor((x / W) * n), b = Math.floor(((x + 1) / W) * n);
    let m = 0;
    for (let i = a; i < b; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
    const y = H - 2 - m * (H * 0.45);
    if (x === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

declare global {
  interface Window {
    __audioLab?: {
      list(): { name: string; group: LabGroup; seconds: number }[];
      render(name: string, sampleRate?: number): Promise<{ metrics: LabMetrics; wav: string }>;
    };
  }
}

/** Exposes the lab to automation (render.mjs). */
export function installLab(): void {
  const all = labScenarios();
  window.__audioLab = {
    list: () => all.map((s) => ({ name: s.name, group: s.group, seconds: s.seconds })),
    async render(name, sampleRate = 44100) {
      const sc = all.find((s) => s.name === name);
      if (!sc) throw new Error(`unknown scenario ${name}`);
      const buf = await renderScenario(sc, sampleRate);
      return { metrics: analyse(buf), wav: wavBase64(buf) };
    },
  };
}
