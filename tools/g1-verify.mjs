// Gauntlet round 1 (ui-hud-diplomacy) check: stages the g1-* shots, prints what each stager read (window.__g1Texts)
// and saves the pictures. Usage: node tools/g1-verify.mjs [--url http://127.0.0.1:5483/] [--shot g1-offensive,g1-war-alerts] [--out shots/fix-ui-hud-diplomacy]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5483/';
const out = args.out || 'shots/fix-ui-hud-diplomacy';
const shots = (args.shot || 'g1-offensive,g1-war-alerts').split(',');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
  await page.goto(`${base}?shot=${shot}${args.params || ''}`, { waitUntil: 'load', timeout: 120000 });
  try { await page.waitForFunction(() => window.__shotReady === true, null, { timeout: Number(args.timeout || 400000) }); } catch { console.log('timeout'); }
  await page.waitForTimeout(Number(args.wait || 3000));
  const data = await page.evaluate(() => window.__g1Texts ?? null);
  console.log(`=== ${shot}\n${JSON.stringify(data, null, 2)}`);
  await page.screenshot({ path: path.join(out, `${shot}.png`), timeout: 240000 });
  await page.close();
}
await browser.close();
