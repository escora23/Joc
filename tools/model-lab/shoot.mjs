// Capture the model lab: node tools/model-lab/shoot.mjs <out.png> "<query>" [w h]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [out, query = 'set=units', w = '1600', h = '900'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
await page.goto(`${process.env.LAB_URL ?? 'http://127.0.0.1:5404'}/tools/model-lab/index.html?${query}`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__labReady === true, null, { timeout: 120000 });
await page.screenshot({ path: out });
console.log(out);
await browser.close();
