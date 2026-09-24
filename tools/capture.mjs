// Screenshot harness: builds nothing, serves nothing — point it at a running dev/preview server.
// Usage: node tools/capture.mjs [--url http://127.0.0.1:5173/] [--shot name] [--out shots] [--wait ms] [--w 1600 --h 900]
// Shots are defined by URL query params the game understands (see ARCHITECTURE.md "Shot hooks").
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5173/';
const out = args.out || 'shots';
const shots = (args.shot || 'default').split(',');
const wait = Number(args.wait || 6000);
const w = Number(args.w || 1600), h = Number(args.h || 900);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
let failed = false;
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => { logs.push(`[pageerror] ${e.message}`); failed = true; });
  const url = shot === 'default' ? base : `${base}${base.includes('?') ? '&' : '?'}shot=${encodeURIComponent(shot)}`;
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  // The game sets window.__shotReady = true when a ?shot= scene is staged; fall back to a fixed wait.
  try { await page.waitForFunction(() => (window).__shotReady === true || (window).__ready === true, null, { timeout: 90000 }); } catch { logs.push('[capture] timeout waiting for __shotReady'); }
  await page.waitForTimeout(wait);
  const file = path.join(out, `${shot}.png`);
  await page.screenshot({ path: file });
  const fps = await page.evaluate(() => (window).__fps ?? null).catch(() => null);
  console.log(`${file}${fps ? `  fps~${fps}` : ''}`);
  for (const l of logs.slice(0, 30)) console.log('   ', l);
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
