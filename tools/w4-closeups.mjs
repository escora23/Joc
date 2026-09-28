// FRONT ULTRA — close-up review of every unit and structure model (owner clarification to FEEDBACK-1: models must be
// clearly visible, well made and grounded up close). Test tooling only.
//
//   node tools/w4-closeups.mjs [--url http://127.0.0.1:5401/] [--out shots/W4-closeout/closeups]
//        [--only warship,airbase3] [--alts 300,100,40,8] [--heading 0.5] [--params "&clouds=hidden"]
//
// Loads the model-gallery shot once (every structure type at levels 1-3, docked aircraft, every unit type, paused),
// then flies the camera to each subject at each altitude, captures the frame (HUD hidden) and writes one contact
// sheet per subject (the altitudes side by side) plus closeups.json with the measured on-screen size of each model
// (__units.sizeOf: projected box in px) so "clearly visible" is a number, not an impression.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5401/';
const out = args.out || 'shots/W4-closeout/closeups';
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const ALTS = String(args.alts || '300,100,40,8').split(',').map(Number);
const HEADING = Number(args.heading ?? 0.5);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const GLYPH = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111',
  K: '101110100110101', M: '101111111101101', ' ': '000000000000000',
};
const W = Number(args.w || 1600), H = Number(args.h || 900);
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
await page.goto(`${base}?shot=model-gallery&hud=0${args.params || ''}`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 600000, polling: 500 });
log('gallery staged');
const subjects = await page.evaluate(() => window.__gallery?.subjects ?? []);
const autoTilt = (alt) => {
  const t = Math.min(1, Math.max(0, (Math.log10(3000) - Math.log10(alt)) / (Math.log10(3000) - Math.log10(2))));
  return 1.22 * Math.pow(t, 1.15);
};

const report = [];
for (const s of subjects) {
  if (ONLY && !ONLY.has(s.name)) continue;
  const frames = [];
  for (const alt of ALTS) {
    const r = await page.evaluate(async ({ s, alt, tilt, heading }) => {
      const { ctx } = window.__front;
      const v = ctx.sim.view;
      let lat, lon, lift = 0;
      if (s.kind === 'struct') {
        const t = s.tile;
        lat = 90 - (Math.floor(t / 1600) + 0.5) * (180 / 800);
        lon = ((t % 1600) + 0.5) * (360 / 1600) - 180;
      } else {
        const u = v.units.get(s.tile);
        if (!u) return null;
        lat = 90 - (u.y / 800) * 180;
        lon = (u.x / 1600) * 360 - 180;
        const tr = window.__units.tracks.get(u.id);
        if (tr && tr.hasPos) lift = Math.max(0, (tr.pos.length() - ctx.globe.surfaceRadiusAt(lat, lon)) * 6371);
      }
      ctx.cameraRig.setState({ lat, lon, altitudeKm: alt + lift, tilt, heading });
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
      for (let i = 0; i < 3; i++) await frame();
      const size = window.__units.sizeOf?.(s.kind, s.tile) ?? null;
      return { lat, lon, lift, size, stats: { unitMinPx: window.__units.stats().lod.unitMinPx, structMinPxScale: window.__units.stats().lod.structMinPxScale } };
    }, { s, alt, tilt: autoTilt(alt), heading: HEADING });
    if (!r) { log(`${s.name}: gone`); break; }
    const buf = await page.screenshot({ timeout: 180000 });
    frames.push({ alt, buf });
    report.push({ subject: s.name, alt, px: r.size?.px ?? null, box: r.size ?? null, lift: +r.lift.toFixed(1) });
    log(`${s.name} @ ${alt} km: ${r.size ? `${r.size.px.toFixed(0)} px (${r.size.w}x${r.size.h})` : 'size n/a'}`);
  }
  if (frames.length) writeSheet(path.join(out, `${s.name}.png`), frames);
}
fs.writeFileSync(path.join(out, 'closeups.json'), JSON.stringify({ report, errors }, null, 1));
log(`done: ${report.length} frames, ${errors.length} page errors`);
await browser.close();

/** 2 x 2 (or 1 x n) contact sheet of the frames, each downscaled 2x (box filter), with the altitude burnt in. */
function writeSheet(file, frames) {
  const cols = frames.length > 2 ? 2 : frames.length, rows = Math.ceil(frames.length / cols);
  const cw = W / 2, ch = H / 2;
  const sheet = new PNG({ width: cw * cols, height: ch * rows });
  frames.forEach((f, i) => {
    const img = PNG.sync.read(f.buf);
    const ox = (i % cols) * cw, oy = Math.floor(i / cols) * ch;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const k = ((y * 2 + dy) * img.width + (x * 2 + dx)) * 4;
        r += img.data[k]; g += img.data[k + 1]; b += img.data[k + 2];
      }
      const o = ((oy + y) * sheet.width + ox + x) * 4;
      sheet.data[o] = r / 4; sheet.data[o + 1] = g / 4; sheet.data[o + 2] = b / 4; sheet.data[o + 3] = 255;
    }
    // Altitude tag: a dark box with white bars (one bar per digit group is unreadable; draw the digits as 3x5 glyphs).
    drawText(sheet, ox + 8, oy + 8, `${f.alt} KM`);
  });
  fs.writeFileSync(file, PNG.sync.write(sheet));
}

function drawText(png, x0, y0, text) {
  const sc = 4, w = text.length * 4 * sc + sc * 2, h = 7 * sc;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = ((y0 + y) * png.width + x0 + x) * 4;
    png.data[o] = png.data[o] * 0.3; png.data[o + 1] = png.data[o + 1] * 0.3; png.data[o + 2] = png.data[o + 2] * 0.3;
  }
  [...text].forEach((c, i) => {
    const g = GLYPH[c] ?? GLYPH[' '];
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
      if (g[gy * 3 + gx] !== '1') continue;
      for (let py = 0; py < sc; py++) for (let px = 0; px < sc; px++) {
        const o = ((y0 + sc + gy * sc + py) * png.width + x0 + sc + i * 4 * sc + gx * sc + px) * 4;
        png.data[o] = 255; png.data[o + 1] = 255; png.data[o + 2] = 255;
      }
    }
  });
}
