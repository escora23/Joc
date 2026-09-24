// FRONT ULTRA — headless sim harness: WorldInit loader for Node (owner: sim-core). Test tooling only, never bundled.
//
// The simulation needs the exact WorldData the game builds in the browser (NASA masks decoded through
// OffscreenCanvas, Natural Earth rasterised by src/data). Rather than re-implementing the data pipeline in Node,
// we run the real `loadWorldData` once inside headless Chromium (Vite dev server started programmatically),
// serialise the worker-side fields and cache them under node_modules/.cache. The cache key hashes src/data and
// src/shared, so any pipeline change triggers a rebuild.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CACHE_DIR = path.join(ROOT, 'node_modules/.cache/front-ultra-sim');

function sourceHash() {
  const h = createHash('sha1');
  const dirs = ['src/data', 'src/shared', 'public/textures'];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    const files = fs.readdirSync(abs, { recursive: true }).map(String).filter((f) => !f.endsWith('.md')).sort();
    for (const f of files) {
      const p = path.join(abs, f);
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      h.update(f);
      if (d === 'public/textures') h.update(String(st.size));
      else h.update(fs.readFileSync(p));
    }
  }
  return h.digest('hex').slice(0, 16);
}

async function dumpFromBrowser() {
  const { createServer } = await import('vite');
  const { chromium } = await import('playwright');
  const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const addr = server.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : 5199;
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[world] page error', e.message));
    // Any same-origin non-HTML resource gives us a document without booting the game.
    await page.goto(`http://127.0.0.1:${port}/src/shared/constants.ts`, { timeout: 120_000 });
    const res = await page.evaluate(async () => {
      const m = await import('/src/data/index.ts');
      const w = await m.loadWorldData(() => {});
      const b64 = (a) => {
        const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
        return btoa(s);
      };
      return {
        width: w.width, height: w.height, landTiles: w.landTiles, countries: w.countries,
        terrain: b64(w.terrain), elevation: b64(w.elevation), country: b64(w.country),
      };
    });
    return res;
  } finally {
    await browser.close();
    await server.close();
  }
}

function decode(b64, C) {
  const buf = Buffer.from(b64, 'base64');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new C(ab);
}

/** The worker-side world (cached; built in headless Chromium on the first run or after a data change). */
/** @returns {Promise<import('../../shared/types').WorldInit>} */
export async function loadWorldInit(log = console.log) {
  const key = sourceHash();
  const file = path.join(CACHE_DIR, `world-${key}.json`);
  let d;
  if (fs.existsSync(file)) {
    d = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    log('[world] building WorldData in headless Chromium (first run or src/data changed)...');
    const t0 = Date.now();
    d = await dumpFromBrowser();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    for (const f of fs.readdirSync(CACHE_DIR)) if (f.startsWith('world-')) fs.rmSync(path.join(CACHE_DIR, f));
    fs.writeFileSync(file, JSON.stringify(d));
    log(`[world] cached in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  return {
    width: d.width,
    height: d.height,
    landTiles: d.landTiles,
    countries: d.countries,
    terrain: decode(d.terrain, Uint8Array),
    elevation: decode(d.elevation, Int16Array),
    country: decode(d.country, Uint16Array),
  };
}
