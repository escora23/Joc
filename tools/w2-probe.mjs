// FRONT ULTRA — W2 quick probe: open a shot and print debug hooks (dev aid).
// Usage: node tools/w2-probe.mjs --url http://127.0.0.1:5313/ --shot icons-europe [--params "&alt=1500"] [--eval "expr"]
import { chromium } from 'playwright';
import fs from 'node:fs';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5313/';
const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}?shot=${args.shot || 'icons-europe'}&freeze=1&hud=0${args.params || ''}`, { timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 1200000, polling: 500 });
await page.waitForTimeout(Number(args.wait || 3000));
const expr = args.eval || 'JSON.stringify(window.__units.stats())';
console.log(await page.evaluate(expr));
if (args.shotfile) await page.screenshot({ path: args.shotfile });
await browser.close();
