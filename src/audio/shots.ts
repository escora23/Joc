// FRONT ULTRA — audio shots (owner: audio). Sound has no picture, so these shots render the real audio
// graph offline (OfflineAudioContext) and show a spectrogram + measurements for every cue, UI sound,
// sequence and music state — the visual proof that the audio subsystem works in a real browser.
//   ?shot=audio-lab    every SFX, UI sound, loop and sequence (nuke near/orbit/MIRV, siren, ambience, engines)
//   ?shot=audio-music  every music state (menu, calm → total war, adaptive ramp, nuclear, command, victory, defeat)

import { registerShot } from '../shared/shots';
import { analyse, drawSpectrogram, labScenarios, renderScenario, type LabGroup, type LabMetrics } from './lab';

const CSS = `
.fu-alab{position:fixed;inset:0;z-index:1000;background:radial-gradient(ellipse at 30% 0%,#122033 0%,#070b11 60%);color:#cfe3f4;
  font:12px/1.35 'JetBrains Mono',ui-monospace,monospace;padding:18px 22px;overflow:hidden;pointer-events:none}
.fu-alab h1{font:600 20px/1.2 'Rajdhani','Barlow Condensed',sans-serif;letter-spacing:.18em;margin:0 0 2px;color:#e9f4ff}
.fu-alab h1 b{color:#ffb53d;font-weight:700}
.fu-alab .sub{color:#7f97ad;margin-bottom:12px;letter-spacing:.04em}
.fu-alab .grid{display:grid;gap:8px 10px}
.fu-alab .tile{background:rgba(14,22,33,.85);border:1px solid rgba(120,170,220,.16);border-radius:4px;padding:5px 6px 4px}
.fu-alab .tile canvas{display:block;width:100%;border-radius:2px}
.fu-alab .nm{display:flex;justify-content:space-between;color:#e9f4ff;font-weight:600;margin-bottom:3px;white-space:nowrap;overflow:hidden}
.fu-alab .nm i{font-style:normal;color:#6f8aa3;font-weight:400}
.fu-alab .st{color:#8fb0c9;white-space:nowrap;overflow:hidden;margin-top:3px}
.fu-alab .st .bad{color:#ff5a4f}.fu-alab .st .ok{color:#5de3a0}
.fu-alab .bars{display:flex;height:5px;margin-top:3px;border-radius:2px;overflow:hidden}
.fu-alab .legend{position:absolute;right:22px;top:20px;color:#7f97ad;text-align:right}
.fu-alab .legend span{display:inline-block;width:10px;height:8px;margin:0 3px 0 10px;vertical-align:middle}
`;

const BAND_COLORS = ['#6b3fd6', '#2f7fe0', '#2fc4a0', '#e8c23a', '#f06a4a'];

function fmtStats(m: LabMetrics): string {
  const pk = m.clipped > 0 ? `<span class="bad">peak ${m.peakDb} dB · CLIP ${m.clipped}</span>` : `<span class="ok">peak ${m.peakDb} dB</span>`;
  const silent = m.activeSec < 0.05 ? ' <span class="bad">SILENT</span>' : '';
  return `${pk} · rms ${m.rmsDb} · ${m.activeSec.toFixed(1)}s · ${(m.centroid / 1000).toFixed(1)}k${silent}${m.nan ? ' <span class="bad">NaN</span>' : ''}`;
}

async function stageLab(groups: LabGroup[], title: string, cols: number, canvasH: number, sampleRate: number, setUiVisible: (v: boolean) => void): Promise<void> {
  setUiVisible(false);
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.className = 'fu-alab';
  const scen = labScenarios().filter((s) => groups.includes(s.group));
  root.innerHTML = `<h1>FRONT ULTRA <b>//</b> AUDIO LAB — ${title}</h1>
    <div class="sub">${scen.length} renders of the live Web Audio graph (OfflineAudioContext, ${sampleRate / 1000} kHz) · log-frequency spectrogram 30 Hz–16 kHz · cyan = waveform envelope · all procedural, no audio files</div>
    <div class="legend">spectral balance${['&lt;60', '60–250', '250–2k', '2k–8k', '&gt;8k'].map((b, i) => `<span style="background:${BAND_COLORS[i]}"></span>${b}`).join('')}</div>
    <div class="grid" style="grid-template-columns:repeat(${cols},1fr)"></div>`;
  document.body.appendChild(root);
  const grid = root.querySelector('.grid') as HTMLDivElement;
  let clips = 0, silent = 0;
  for (const sc of scen) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const cv = document.createElement('canvas');
    cv.width = 300;
    cv.height = canvasH;
    tile.innerHTML = `<div class="nm">${sc.name.replace(/^[a-z]+:/, '')}<i>${sc.group} · ${sc.seconds.toFixed(1)}s</i></div>`;
    tile.appendChild(cv);
    const st = document.createElement('div');
    st.className = 'st';
    tile.appendChild(st);
    const bars = document.createElement('div');
    bars.className = 'bars';
    tile.appendChild(bars);
    grid.appendChild(tile);
    try {
      const buf = await renderScenario(sc, sampleRate);
      const m = analyse(buf);
      drawSpectrogram(cv, buf);
      st.innerHTML = fmtStats(m);
      bars.innerHTML = m.bands.map((b, i) => `<div style="flex:${Math.max(0.002, b)};background:${BAND_COLORS[i]}"></div>`).join('');
      if (m.clipped > 0) clips++;
      if (m.activeSec < 0.05) silent++;
    } catch (err) {
      st.innerHTML = `<span class="bad">render failed: ${String(err)}</span>`;
    }
  }
  const sub = root.querySelector('.sub') as HTMLDivElement;
  sub.innerHTML += ` · <span style="color:${clips || silent ? '#ff5a4f' : '#5de3a0'}">${clips} clipped · ${silent} silent</span>`;
}

registerShot('audio-lab', 'audio', 'Offline renders + spectrograms of every SFX, UI sound, loop and sequence', async ({ setUiVisible }) => {
  await stageLab(['sfx', 'ui', 'seq'], 'SOUND EFFECTS, INTERFACE & SEQUENCES', 8, 46, 22050, setUiVisible);
}, 5);

registerShot('audio-music', 'audio', 'Offline renders + spectrograms of every adaptive music state', async ({ setUiVisible }) => {
  await stageLab(['music'], 'ADAPTIVE MUSIC', 3, 150, 16000, setUiVisible);
}, 5);
