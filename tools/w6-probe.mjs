// W6 probe: open a ?shot= page, wait until staged, print console logs, evaluate an expression, screenshot.
// node tools/w6-probe.mjs --shot front-orbit [--params "&x=1"] [--eval "JSON.stringify(...)"] [--out dir] [--wait ms]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5440/';
const out = args.out || 'shots/W6-battle-clarity/probe';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: Number(args.w || 1600), height: Number(args.h || 900) } });
page.on('console', (m) => { const t = m.text(); if (!t.includes('KHR_parallel')) console.log(`[${m.type()}] ${t.slice(0, 400)}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`${base}?shot=${args.shot}${args.params || ''}`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: Number(args.timeout || 600000) });
await page.waitForTimeout(Number(args.wait || 3000));
if (args.eval) console.log('EVAL', await page.evaluate(args.eval));
if (args.shotname !== 'none') await page.screenshot({ path: path.join(out, `${args.tag || args.shot}.png`), timeout: 240000 });
await browser.close();
