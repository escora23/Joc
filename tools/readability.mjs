// FRONT ULTRA — map readability measurement (W2, DESIGN_V2 §16.3). Captures one staged, frozen shot in its
// measurement variants and writes a JSON report next to the PNGs.
//
//   node tools/readability.mjs --url http://127.0.0.1:5312/ --shot readability-europe [--params "&alt=3000"]
//        [--out shots/W2-map-readability/readability] [--variants base,territory,mask,hidden,realistic]
//        [--repeat 2] [--wait 5000] [--w 1600 --h 900] [--night 1]
//
// Variants (one page load; toggled at runtime through window.__shotView, so every variant is the same frame):
//   base       the shot as the player sees it (default cloud setting, strategic)
//   territory  &territory=0: no territory overlay on the ground
//   mask       &mask=owner: flat owner-id false colour (decoded with shared/shots.ts OWNER_MASK)
//   hidden     &clouds=hidden
//   realistic  &clouds=realistic
// Report:
//   owners[]   per owner in view: pixels, mean CIELAB ΔE76 and ΔE2000 base vs territory=0 (day / night split)
//   neutral    the same over neutral land
//   borders    per pair of neighbouring regions: WCAG contrast of the border line against both fills
//   clouds     ΔE base vs hidden over the human's land, and the cloud factor (ΔE base/hidden ÷ ΔE realistic/hidden
//              over cloudy pixels) over other land and ocean; the texture samples in the cloud fragment shader
//   repro      with --repeat 2: per-owner ΔE differences between two independent page loads
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5312/';
const shot = args.shot || 'readability-europe';
const extra = args.params || '';
const out = args.out || 'shots/W2-map-readability/readability';
const variants = (args.variants || 'base,territory,mask').split(',');
const repeat = Math.max(1, Number(args.repeat || 1));
const settleMs = Number(args.wait || 5000);
const W = Number(args.w || 1600), H = Number(args.h || 900);
const tag = args.tag || shot + (extra ? extra.replace(/[&=]/g, '_') : '');
fs.mkdirSync(out, { recursive: true });

// -------------------------------------------------------------------------------------------------
// Colour science
// -------------------------------------------------------------------------------------------------
const lin = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  lin[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function lab(r, g, b, outArr, o) {
  const R = lin[r], G = lin[g], B = lin[b];
  let x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  let y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  let z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  x = f(x); y = f(y); z = f(z);
  outArr[o] = 116 * y - 16;
  outArr[o + 1] = 500 * (x - y);
  outArr[o + 2] = 200 * (y - z);
}
function relLum(r, g, b) {
  return 0.2126 * lin[r] + 0.7152 * lin[g] + 0.0722 * lin[b];
}
function de76(a, o1, b, o2) {
  const dl = a[o1] - b[o2], da = a[o1 + 1] - b[o2 + 1], db = a[o1 + 2] - b[o2 + 2];
  return Math.sqrt(dl * dl + da * da + db * db);
}
function de2000(a, o1, b, o2) {
  const L1 = a[o1], a1 = a[o1 + 1], b1 = a[o1 + 2], L2 = b[o2], a2 = b[o2 + 1], b2 = b[o2 + 2];
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cm, 7) / (Math.pow(Cm, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) / rad + 360) % 360, h2p = (Math.atan2(b2, a2p) / rad + 360) % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lpm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hpm = (h1p + h2p) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hpm - 30) * rad) + 0.24 * Math.cos(2 * hpm * rad) + 0.32 * Math.cos((3 * hpm + 6) * rad) - 0.2 * Math.cos((4 * hpm - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hpm - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cpm, 7) / (Math.pow(Cpm, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lpm - 50, 2)) / Math.sqrt(20 + Math.pow(Lpm - 50, 2));
  const Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}

// -------------------------------------------------------------------------------------------------
// Capture
// -------------------------------------------------------------------------------------------------
const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb'],
});

const VIEW = {
  base: { territory: true, mask: null, clouds: null },
  territory: { territory: false, mask: null, clouds: null },
  mask: { territory: true, mask: 'owner', clouds: null },
  hidden: { territory: true, mask: null, clouds: 'hidden' },
  realistic: { territory: true, mask: null, clouds: 'realistic' },
};

async function settle(page, ms) {
  const f0 = await page.evaluate(() => window.__front?.ctx.frame.frame ?? 0);
  await page.waitForTimeout(ms);
  await page.waitForFunction((f) => (window.__front?.ctx.frame.frame ?? 0) > f + 3, f0, { timeout: 120000, polling: 200 });
}

async function captureRun(run) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  const url = `${base}${base.includes('?') ? '&' : '?'}shot=${encodeURIComponent(shot)}&freeze=1&hud=0${extra}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 300000, polling: 500 });
  const images = {};
  for (const v of variants) {
    await page.evaluate((view) => window.__shotView.set(view), VIEW[v]);
    await settle(page, settleMs);
    const file = path.join(out, `${tag}${repeat > 1 ? `-run${run}` : ''}-${v}.png`);
    await page.screenshot({ path: file });
    images[v] = PNG.sync.read(fs.readFileSync(file));
  }
  await page.evaluate(() => window.__shotView.set({ territory: true, mask: null, clouds: null }));
  const meta = await page.evaluate(() => {
    const ctx = window.__front.ctx;
    const players = ctx.sim.view.playerList.map((p) => ({ id: p.id, name: p.name, kind: p.kind, color: p.color, tiles: p.tiles }));
    let cloudSamples = -1, cloudSrc = '';
    ctx.scene.traverse((o) => {
      const m = o.material;
      if (m && m.name === 'clouds' && m.fragmentShader) cloudSrc = m.fragmentShader;
    });
    if (cloudSrc) {
      const main = cloudSrc.slice(cloudSrc.indexOf('void main'));
      cloudSamples = (main.match(/\btexture(2D)?\s*\(/g) || []).length;
    }
    const camera = ctx.cameraRig.getState();
    return { players, cloudSamples, camera, ca: window.__post?.ca() ?? null, tick: ctx.sim.view.tick };
  });
  await page.close();
  return { images, meta, logs, seconds: (Date.now() - t0) / 1000 };
}

// -------------------------------------------------------------------------------------------------
// Analysis
// -------------------------------------------------------------------------------------------------
const CLS = { space: 0, water: 1, ice: 2, neutral: 3, owned: 4 };

function decodeMask(png) {
  const n = png.width * png.height;
  const cls = new Uint8Array(n), id = new Int32Array(n), night = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
    if (b === 0) { cls[i] = CLS.space; id[i] = -1; continue; }
    cls[i] = Math.floor(b / 40);
    night[i] = b % 40 >= 20 ? 1 : 0;
    id[i] = cls[i] === CLS.owned ? r + g * 256 : cls[i] === CLS.neutral ? 0 : -1;
  }
  return { cls, id, night };
}

function toLab(png) {
  const n = png.width * png.height;
  const L = new Float32Array(n * 3), Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
    lab(r, g, b, L, i * 3);
    Y[i] = relLum(r, g, b);
  }
  return { L, Y };
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  return s[Math.floor(s.length / 2)];
}
function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function analyse(run) {
  const { images, meta } = run;
  const w = images.base.width, h = images.base.height, n = w * h;
  const mask = images.mask ? decodeMask(images.mask) : null;
  const baseLab = toLab(images.base);
  const report = { shot, params: extra, camera: meta.camera, tick: meta.tick, strategicCA: meta.ca, width: w, height: h };
  const names = new Map(meta.players.map((p) => [p.id, p]));
  if (!mask) return report;

  // Distance (px, chessboard, up to 12) to the nearest region boundary, with the owner on the other side.
  const regionOf = (i) => (mask.cls[i] === CLS.owned ? mask.id[i] : mask.cls[i] === CLS.neutral ? 0 : -1);
  const dist = new Uint8Array(n).fill(255), other = new Int32Array(n).fill(-2);
  let frontier = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, r = regionOf(i);
      if (r < 0) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx, rj = regionOf(j);
        if (rj >= 0 && rj !== r && (r > 0 || rj > 0)) {
          dist[i] = 0;
          other[i] = rj;
        }
      }
      if (dist[i] === 0) frontier.push(i);
    }
  }
  for (let d = 1; d <= 12 && frontier.length; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (dist[j] !== 255 || regionOf(j) !== regionOf(i)) continue;
        dist[j] = d;
        other[j] = other[i];
        next.push(j);
      }
    }
    frontier = next;
  }

  // ΔE per owner, base vs territory=0.
  if (images.territory) {
    const tLab = toLab(images.territory);
    const acc = new Map();
    const neutral = { px: 0, e76: 0, e00: 0 };
    for (let i = 0; i < n; i++) {
      const c = mask.cls[i];
      if (c !== CLS.owned && c !== CLS.neutral) continue;
      const e76 = de76(baseLab.L, i * 3, tLab.L, i * 3), e00 = de2000(baseLab.L, i * 3, tLab.L, i * 3);
      if (c === CLS.neutral) {
        neutral.px++; neutral.e76 += e76; neutral.e00 += e00;
        continue;
      }
      let a = acc.get(mask.id[i]);
      if (!a) acc.set(mask.id[i], (a = { px: 0, e76: 0, e00: 0, dayPx: 0, dayE: 0, nightPx: 0, nightE: 0, interiorPx: 0, interiorE: 0 }));
      a.px++; a.e76 += e76; a.e00 += e00;
      if (mask.night[i]) { a.nightPx++; a.nightE += e76; } else { a.dayPx++; a.dayE += e76; }
      if (dist[i] >= 4) { a.interiorPx++; a.interiorE += e76; }
    }
    report.owners = [...acc.entries()].map(([id, a]) => ({
      id, name: names.get(id)?.name ?? '?', kind: names.get(id)?.kind ?? '?', human: id === 1, pixels: a.px,
      deltaE: +(a.e76 / a.px).toFixed(2), deltaE2000: +(a.e00 / a.px).toFixed(2),
      dayPixels: a.dayPx, deltaEDay: a.dayPx ? +(a.dayE / a.dayPx).toFixed(2) : null,
      nightPixels: a.nightPx, deltaENight: a.nightPx ? +(a.nightE / a.nightPx).toFixed(2) : null,
      deltaEInterior: a.interiorPx ? +(a.interiorE / a.interiorPx).toFixed(2) : null,
    })).sort((x, y) => y.pixels - x.pixels);
    report.neutral = { pixels: neutral.px, deltaE: neutral.px ? +(neutral.e76 / neutral.px).toFixed(2) : null, deltaE2000: neutral.px ? +(neutral.e00 / neutral.px).toFixed(2) : null };
    const inView = report.owners.filter((o) => o.pixels >= 100);
    report.summary = {
      ownersInView: inView.length,
      minOwnerDeltaE: inView.length ? Math.min(...inView.map((o) => o.deltaE)) : null,
      minOwnerDeltaEDay: inView.filter((o) => o.dayPixels >= 100).length ? Math.min(...inView.filter((o) => o.dayPixels >= 100).map((o) => o.deltaEDay)) : null,
      minOwnerDeltaENight: inView.filter((o) => o.nightPixels >= 100).length ? Math.min(...inView.filter((o) => o.nightPixels >= 100).map((o) => o.deltaENight)) : null,
      humanDeltaE: report.owners.find((o) => o.human)?.deltaE ?? null,
      neutralDeltaE: report.neutral.deltaE,
    };
    // Owned land on the night side, pooled.
    let np = 0, ne = 0;
    for (let i = 0; i < n; i++) if (mask.cls[i] === CLS.owned && mask.night[i]) { np++; ne += de76(baseLab.L, i * 3, tLab.L, i * 3); }
    report.summary.nightOwnedPixels = np;
    report.summary.nightOwnedDeltaE = np ? +(ne / np).toFixed(2) : null;
  }

  // Border contrast: per region pair, the line (95th percentile luminance of the pixels ≤ 1 px from the boundary)
  // against each fill (median luminance 4-8 px inside).
  {
    const pairs = new Map();
    const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (let i = 0; i < n; i++) {
      if (dist[i] > 8 || other[i] < -1) continue;
      const r = regionOf(i);
      if (r < 0) continue;
      const k = key(r, other[i]);
      let p = pairs.get(k);
      if (!p) pairs.set(k, (p = { a: Math.min(r, other[i]), b: Math.max(r, other[i]), line: [], fillA: [], fillB: [], night: 0, count: 0 }));
      if (dist[i] <= 1) { p.line.push(baseLab.Y[i]); p.count++; p.night += mask.night[i]; }
      else if (dist[i] >= 4) (r === p.a ? p.fillA : p.fillB).push(baseLab.Y[i]);
    }
    const rows = [];
    for (const p of pairs.values()) {
      if (p.count < 40 || p.fillA.length < 20 || p.fillB.length < 20) continue;
      const Ll = pct(p.line, 0.95), La = median(p.fillA), Lb = median(p.fillB);
      const cA = (Math.max(Ll, La) + 0.05) / (Math.min(Ll, La) + 0.05), cB = (Math.max(Ll, Lb) + 0.05) / (Math.min(Ll, Lb) + 0.05);
      rows.push({ a: p.a, b: p.b, aName: p.a ? names.get(p.a)?.name : 'neutral', bName: p.b ? names.get(p.b)?.name : 'neutral', px: p.count,
        nightShare: +(p.night / p.count).toFixed(2), line: +Ll.toFixed(4), fillA: +La.toFixed(4), fillB: +Lb.toFixed(4), contrastA: +cA.toFixed(2), contrastB: +cB.toFixed(2) });
    }
    rows.sort((x, y) => Math.min(x.contrastA, x.contrastB) - Math.min(y.contrastA, y.contrastB));
    report.borders = { pairs: rows.length, minContrast: rows.length ? Math.min(...rows.map((r) => Math.min(r.contrastA, r.contrastB))) : null, list: rows };
  }

  // Clouds.
  if (images.hidden) {
    const hLab = toLab(images.hidden);
    const rLab = images.realistic ? toLab(images.realistic) : null;
    const cls = { human: { px: 0, e: 0, cloudy: 0, num: 0, den: 0 }, other: { px: 0, e: 0, cloudy: 0, num: 0, den: 0 }, ocean: { px: 0, e: 0, cloudy: 0, num: 0, den: 0 } };
    for (let i = 0; i < n; i++) {
      const c = mask.cls[i];
      const k = c === CLS.owned && mask.id[i] === 1 ? 'human' : c === CLS.owned || c === CLS.neutral ? 'other' : c === CLS.water ? 'ocean' : null;
      if (!k) continue;
      const e = de76(baseLab.L, i * 3, hLab.L, i * 3);
      const a = cls[k];
      a.px++; a.e += e;
      if (rLab) {
        const er = de76(rLab.L, i * 3, hLab.L, i * 3);
        if (er > 8) { a.cloudy++; a.num += e; a.den += er; }
      }
    }
    report.clouds = { shaderTextureSamples: meta.cloudSamples };
    for (const [k, a] of Object.entries(cls)) {
      report.clouds[k] = { pixels: a.px, deltaEvsHidden: a.px ? +(a.e / a.px).toFixed(2) : null, cloudyPixels: a.cloudy, cloudFactor: a.den > 0 ? +(a.num / a.den).toFixed(3) : null };
    }
  }
  return report;
}

const runs = [];
for (let r = 0; r < repeat; r++) {
  const run = await captureRun(r + 1);
  const rep = analyse(run);
  rep.seconds = run.seconds;
  if (run.logs.length) rep.consoleErrors = run.logs.slice(0, 10);
  runs.push({ run, rep });
  console.log(`run ${r + 1}: ${run.seconds.toFixed(0)} s`);
}
const report = runs[0].rep;
if (runs.length > 1) {
  const a = runs[0].rep.owners ?? [], b = runs[1].rep.owners ?? [];
  const diffs = a.map((o) => {
    const m = b.find((x) => x.id === o.id);
    return m ? { id: o.id, name: o.name, d: +Math.abs(o.deltaE - m.deltaE).toFixed(3) } : null;
  }).filter(Boolean);
  const la = toLab(runs[0].run.images.base), lb = toLab(runs[1].run.images.base);
  let s = 0, mx = 0;
  const N = runs[0].run.images.base.width * runs[0].run.images.base.height;
  for (let i = 0; i < N; i++) {
    const e = de76(la.L, i * 3, lb.L, i * 3);
    s += e;
    if (e > mx) mx = e;
  }
  report.repro = {
    maxOwnerDeltaEDiff: diffs.length ? Math.max(...diffs.map((d) => d.d)) : null,
    neutralDiff: runs[1].rep.neutral && report.neutral ? +Math.abs(runs[1].rep.neutral.deltaE - report.neutral.deltaE).toFixed(3) : null,
    meanPixelDeltaE: +(s / N).toFixed(4), maxPixelDeltaE: +mx.toFixed(2), owners: diffs,
  };
}
const file = path.join(out, `${tag}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
const brief = { summary: report.summary, neutral: report.neutral, borders: report.borders && { pairs: report.borders.pairs, minContrast: report.borders.minContrast }, clouds: report.clouds, repro: report.repro && { maxOwnerDeltaEDiff: report.repro.maxOwnerDeltaEDiff, meanPixelDeltaE: report.repro.meanPixelDeltaE }, strategicCA: report.strategicCA };
console.log(JSON.stringify(brief, null, 2));
console.log(`report: ${file}`);
await browser.close();
