// FRONT ULTRA — procedural Web Audio (owner: audio). No audio files, ever.
// STUB by the architect: lazily created AudioContext, master/music/sfx/ui buses wired to settings,
// UI blips and a noise-burst detonation. The audio owner replaces it with adaptive music, positional
// battle ambience, engines, sirens and the nuke silence-then-roar. Keep createAudio(ctx): AudioApi.

import type { AudioApi, FrameInfo, GameContext, MusicMood, SfxCue } from '../shared/api';
import type { UiSoundKind } from '../shared/events';

export function createAudio(ctx: GameContext): AudioApi {
  let ac: AudioContext | null = null;
  let master: GainNode | null = null;
  let sfx: GainNode | null = null;
  let ui: GainNode | null = null;
  let unlocked = false;

  function applyVolumes(): void {
    if (!ac || !master || !sfx || !ui) return;
    const s = ctx.settings.get();
    master.gain.setTargetAtTime(s.masterVolume, ac.currentTime, 0.05);
    sfx.gain.setTargetAtTime(s.sfxVolume, ac.currentTime, 0.05);
    ui.gain.setTargetAtTime(s.uiVolume, ac.currentTime, 0.05);
  }

  function blip(freq: number, dur: number, gain: number, bus: GainNode | null, type: OscillatorType = 'sine'): void {
    if (!ac || !bus) return;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ac.currentTime);
    o.frequency.exponentialRampToValueAtTime(freq * 0.7, ac.currentTime + dur);
    g.gain.setValueAtTime(gain, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(g).connect(bus);
    o.start();
    o.stop(ac.currentTime + dur + 0.02);
  }

  function noise(dur: number, gain: number, lowpass: number): void {
    if (!ac || !sfx) return;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lowpass;
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(sfx);
    src.start();
  }

  const uiFreq: Partial<Record<UiSoundKind, number>> = { hover: 1800, click: 1200, confirm: 880, cancel: 440, error: 220, toggle: 1000, open: 700, close: 500, build: 600, notify: 990, alert: 330 };

  ctx.bus.on('uiSound', (e) => {
    if (e.kind === 'hover') return blip(uiFreq.hover!, 0.03, 0.03, ui);
    blip(uiFreq[e.kind] ?? 900, 0.08, 0.12, ui, e.kind === 'error' ? 'square' : 'triangle');
  });
  ctx.bus.on('nukeDetonated', () => api.play('nukeDetonation'));
  ctx.bus.on('settingsChanged', applyVolumes);

  const api: AudioApi = {
    get unlocked() {
      return unlocked;
    },
    async init(progress) {
      progress(1);
    },
    async unlock() {
      if (!ac) {
        ac = new AudioContext();
        master = ac.createGain();
        sfx = ac.createGain();
        ui = ac.createGain();
        sfx.connect(master);
        ui.connect(master);
        master.connect(ac.destination);
        applyVolumes();
      }
      if (ac.state !== 'running') await ac.resume().catch(() => undefined);
      unlocked = ac.state === 'running';
    },
    play(cue: SfxCue, gain = 1) {
      if (cue === 'nukeDetonation' || cue === 'explosionLarge') noise(3.5, 0.9 * gain, 220);
      else if (cue === 'explosionSmall' || cue === 'artillery') noise(0.8, 0.5 * gain, 600);
      else blip(520, 0.15, 0.2 * gain, sfx);
    },
    playAt(cue: SfxCue, _lat: number, _lon: number, gain = 1) {
      api.play(cue, gain * 0.5);
    },
    setMood(_mood: MusicMood) {},
    duck() {},
    update(_frame: FrameInfo) {},
  };
  return api;
}
