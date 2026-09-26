// Scratch probe (W2 fix): ship lines over land and route clutter in the staged shots.
import { chromium } from 'playwright';
import fs from 'node:fs';
const out = process.argv[2] || 'shots/W2-map-readability-fix/routes-land';
fs.mkdirSync(out, { recursive: true });
const shots = [['routes-atlantic', ''], ['readability-europe', '&freeze=1'], ['icons-europe', '&alt=6000'], ['labels-world', '']];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const res = {};
for (const [shot, params] of shots) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(400000);
  await page.goto(`http://127.0.0.1:5312/?shot=${shot}${params}`, { timeout: 400000 });
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => ({ land: window.__trails.overLand(), stats: window.__trails.stats(), alt: window.__front.ctx.cameraRig.getState().altitudeKm }));
  res[shot] = r;
  console.log(shot, JSON.stringify({ alt: r.alt, lines: r.land?.lines, maxLandKm: r.land?.maxLandKm, over: r.land?.overLand?.slice(0, 8), routes: r.stats.routes, human: r.stats.human }));
  await page.screenshot({ path: `${out}/${shot}.png` });
  await page.close();
}
fs.writeFileSync(`${out}/overland.json`, JSON.stringify(res, null, 2));
await browser.close();
