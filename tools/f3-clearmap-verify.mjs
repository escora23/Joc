// Feedback #3 fix pass 3 (#5 «clear map»): the front seen from the strategic zoom down to the ground battle, with the
// war running, framed at fixed altitudes. Checks by pixels where it can:
//   M1 1,200 km over the offensive with the fighting on: no blown-out glare disc (largest near-white blob, px)
//   M2 60 km and M3 25 km: no broad diagonal bands (row-to-row luma swing along the diagonal, a stripe detector)
//   M4 3 km, the ground battle: no orange speckle / glow dots (share of saturated orange pixels)
//   node tools/f3-clearmap-verify.mjs [--url http://127.0.0.1:5467/] [--out shots/feedback3-fix-3/clearmap]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5467/';
const out = args.out || 'shots/feedback3-fix-3/clearmap';
fs.mkdirSync(out, { recursive: true });
const row = (id, what, value, pass) => console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${what} :: ${value}`);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`${base}?shot=f3-missions&run=10&panel=0`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
const at = await page.evaluate(() => {
  const v = __front.ctx.sim.view;
  const off = v.attacks.find((a) => a.attacker === 1 && a.defender > 0 && !a.naval);
  const x = off ? (off.contactX >= 0 ? off.contactX : off.x) : 800, y = off ? (off.contactX >= 0 ? off.contactY : off.y) : 210;
  return { lat: 90 - (y / 800) * 180, lon: (x / 1600) * 360 - 180 };
});
// Hide the HUD so the pixels measured are the map's.
await page.addStyleTag({ content: '#fu-hud, .fu-hud, .fu-alerts, .fu-topbar { visibility: hidden !important; }' });
async function frame(name, alt, tilt, runMs) {
  await page.evaluate(({ at, alt, tilt }) => {
    __front.ctx.cameraRig.setState({ lat: at.lat - (tilt > 0.6 ? alt / 300 : 0), lon: at.lon, altitudeKm: alt, tilt, heading: 0 });
    __front.ctx.sim.setSpeed(2);
  }, { at, alt, tilt });
  await sleep(runMs);
  await page.evaluate(() => __front.ctx.sim.setSpeed(0));
  await sleep(4000);
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, timeout: 300000 });
  return file;
}
/** Pixel stats of a PNG through the page (canvas decode). */
async function stats(file, kind) {
  const b64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(async ({ b64, kind }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const W = c.width, H = c.height;
    const d = g.getImageData(0, 0, W, H).data;
    const L = (x, y) => { const i = (y * W + x) * 4; return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; };
    if (kind === 'glare') {
      // Largest connected blob of near-white pixels (luma > 245), 4-connected, on a 2 px grid.
      const s = 2, w = Math.floor(W / s), h = Math.floor(H / s);
      const m = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = L(x * s, y * s) > 245 ? 1 : 0;
      let best = 0;
      const st = [];
      for (let i = 0; i < w * h; i++) {
        if (m[i] !== 1) continue;
        let n = 0;
        st.push(i);
        m[i] = 2;
        while (st.length) {
          const j = st.pop();
          n++;
          const x = j % w, y = (j - x) / w;
          for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if (k >= 0 && m[k] === 1) { m[k] = 2; st.push(k); }
        }
        best = Math.max(best, n);
      }
      return { blobDiamPx: Math.round(2 * Math.sqrt((best * s * s) / Math.PI)) };
    }
    if (kind === 'bands') {
      // Mean luma along anti-diagonal lines x + y = k (the stripes' direction), then the swing between neighbouring
      // 40 px groups after removing the slow trend: broad bands give large swings.
      const sums = new Float64Array(W + H), ns = new Float64Array(W + H);
      for (let y = 150; y < H - 150; y += 2) for (let x = 0; x < W; x += 2) { sums[x + y] += L(x, y); ns[x + y]++; }
      const prof = [];
      for (let k = 0; k < W + H; k += 40) {
        let a = 0, n = 0;
        for (let j = k; j < k + 40 && j < W + H; j++) { a += sums[j]; n += ns[j]; }
        if (n > 200) prof.push(a / n);
      }
      let swing = 0;
      for (let i = 2; i < prof.length - 2; i++) swing = Math.max(swing, Math.abs(prof[i] - (prof[i - 2] + prof[i + 2]) / 2));
      return { bandSwing: +swing.toFixed(1) };
    }
    // 'orange': share of strongly orange pixels (glow dots) in the middle of the frame.
    let o = 0, n = 0;
    for (let y = 200; y < H - 200; y += 2) for (let x = 200; x < W - 200; x += 2) {
      const i = (y * W + x) * 4;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      n++;
      if (r > 170 && r > gg * 1.45 && gg > b * 1.3) o++;
    }
    return { orangeShare: +(o / n * 100).toFixed(3) };
  }, { b64, kind });
}
const f1 = await frame('m1-1200km', 1200, 0.2, 20000);
const s1 = await stats(f1, 'glare');
row('M1', '1,200 km over the front with the war running: no glare disc over it', `${JSON.stringify(s1)} (fail if > 60 px)`, s1.blobDiamPx <= 60);
const f2 = await frame('m2-60km', 60, 0.9, 8000);
const s2 = await stats(f2, 'bands');
row('M2', '60 km: no broad diagonal bands across the ground', JSON.stringify(s2), s2.bandSwing < 9);
const f3 = await frame('m3-25km', 25, 1.0, 8000);
const s3 = await stats(f3, 'bands');
row('M3', '25 km: no broad diagonal bands across the ground', JSON.stringify(s3), s3.bandSwing < 9);
const f4 = await frame('m4-3km', 3, 1.12, 15000);
const s4 = await stats(f4, 'orange');
row('M4', '3 km, the ground battle: no orange glow speckle over the ground', JSON.stringify(s4), s4.orangeShare < 0.3);
await browser.close();
