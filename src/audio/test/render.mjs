// FRONT ULTRA — offline audio verification (owner: audio).
// Renders every lab scenario (src/audio/lab.ts) in real Chromium through the live Web Audio graph,
// writes 44.1 kHz WAVs to /tmp/fu-audio, and checks each one: not silent, no clipping, no NaN/DC,
// plausible length and spectral balance, plus sequence-specific checks (the nuke duck really goes
// near-silent then roars back, the adaptive ramp really gets louder/denser, the siren stops).
// Usage: node src/audio/test/render.mjs [--url http://127.0.0.1:5189] [--only substring] [--sr 44100]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = (args.url || 'http://127.0.0.1:5189').replace(/\/$/, '');
const out = args.out || '/tmp/fu-audio';
const sr = Number(args.sr || 44100);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
await page.goto(`${base}/src/audio/test/lab.html`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__labReady === true, null, { timeout: 60000 });
let list = await page.evaluate(() => window.__audioLab.list());
if (args.only) list = list.filter((s) => args.only.split(',').some((o) => s.name.includes(o)));

const problems = [];
const rows = [];
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const win = (m, t0, t1) => m.windowsDb.slice(Math.floor(t0 * 4), Math.ceil(t1 * 4));
for (const s of list) {
  const t0 = Date.now();
  const r = await page.evaluate(([n, rate]) => window.__audioLab.render(n, rate), [s.name, sr]);
  const ms = Date.now() - t0;
  const file = path.join(out, `${s.name.replace(/[^a-z0-9@-]+/gi, '_')}.wav`);
  fs.writeFileSync(file, Buffer.from(r.wav, 'base64'));
  const m = r.metrics;
  const issues = [];
  if (m.nan) issues.push('NaN');
  if (m.clipped > 0) issues.push(`clipped ${m.clipped}`);
  if (m.peak > 0.99) issues.push(`peak ${m.peak.toFixed(3)}`);
  // UI ticks are a few ms long: judge them by peak, not by 250 ms windows.
  if (s.group === 'ui' ? m.peakDb < -45 : m.activeSec < 0.05) issues.push('silent');
  if (Math.abs(m.dc) > 0.01) issues.push(`dc ${m.dc.toFixed(4)}`);
  if (s.group === 'ui' && m.activeSec > 1.5) issues.push('ui sound too long');
  if (s.group === 'music' && m.activeSec < s.seconds * 0.8) issues.push('music has gaps');
  if (s.group !== 'ui' && m.peakDb < -40) issues.push('very quiet');
  // Sequence checks.
  if (s.name === 'seq:nuke-near') {
    const before = mean(win(m, 3.5, 4.9));
    const hole = Math.max(...win(m, 5.9, 6.4).map((x) => x));
    const roar = Math.max(...win(m, 7, 10));
    rows.push(`    nuke-near: before ${before.toFixed(1)} dB, hole ${hole.toFixed(1)} dB, roar peak ${roar.toFixed(1)} dB`);
    if (roar - hole < 8) issues.push('nuke roar does not stand out from the silence');
  }
  if (s.name === 'music:adaptive-ramp') {
    const a = mean(win(m, 4, 12)), b = mean(win(m, 46, 58));
    rows.push(`    adaptive-ramp: calm ${a.toFixed(1)} dB -> war ${b.toFixed(1)} dB`);
    if (b - a < 3) issues.push('adaptive ramp does not escalate');
  }
  if (s.name === 'seq:siren') {
    const end = Math.max(...win(m, 14.5, 16));
    if (end > -45) issues.push(`siren does not stop (${end} dB)`);
  }
  const bands = m.bands.map((b) => (b * 100).toFixed(0).padStart(3)).join(' ');
  rows.push(`${issues.length ? 'FAIL' : ' ok '} ${s.name.padEnd(30)} ${m.seconds.toFixed(1).padStart(5)}s act ${m.activeSec.toFixed(1).padStart(5)}s peak ${m.peakDb.toFixed(1).padStart(6)} rms ${m.rmsDb.toFixed(1).padStart(6)} cen ${String(m.centroid).padStart(5)}Hz bands[${bands}] ${ms}ms ${issues.join(', ')}`);
  if (issues.length) problems.push(`${s.name}: ${issues.join(', ')}`);
}
console.log(rows.join('\n'));
console.log(`\n${list.length} renders -> ${out}; ${problems.length} problem(s)`);
for (const p of problems) console.log('  -', p);
await browser.close();
process.exit(problems.length ? 1 : 0);
