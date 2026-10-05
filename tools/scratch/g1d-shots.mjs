// Scratch: stage the g1d shots, dump window.__g1dTexts and save screenshots. node tools/scratch/g1d-shots.mjs
import fs from 'node:fs';
import { chromium } from 'playwright';
const out = 'shots/fix-ai-diplomacy';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const shot of (process.argv[2] ?? 'g1d-threat,g1d-peace').split(',')) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:5485/?shot=${shot}`, { timeout: 180000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__shotReady === true || (window.__g1dTexts && (window.__g1dTexts.alerts)), null, { timeout: 480000 }).catch(() => console.log('timeout'));
  await page.waitForTimeout(3000);
  console.log(shot, JSON.stringify(await page.evaluate(() => window.__g1dTexts ?? null), null, 1));
  await page.screenshot({ path: `${out}/${shot}.png` });
  await page.close();
}
await browser.close();
