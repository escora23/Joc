// temp capture helper (battle agent) - deleted when done
import { chromium } from 'playwright';
import fs from 'node:fs';
const [,, base, out, conc, ...specs] = process.argv;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
async function one(spec) {
  const [name, q] = spec.split('|');
  const T0 = Date.now();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => { const t = m.text(); if (/battle|error|Error/.test(t) || m.type() === 'error') console.log(name, ((Date.now() - T0) / 1000).toFixed(0), t.slice(0, 250)); });
  page.on('pageerror', (e) => console.log(name, 'PAGEERROR', e.message));
  await page.goto(`${base}?${q}`, { waitUntil: 'load', timeout: 120000 });
  try { await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 400000, polling: 1000 }); } catch { console.log(name, 'TIMEOUT'); }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 180000 });
  console.log(name, 'done', ((Date.now() - T0) / 1000).toFixed(0), 's');
  await page.close();
}
const queue = [...specs];
await Promise.all(Array.from({ length: Number(conc) }, async () => { while (queue.length) await one(queue.shift()); }));
await browser.close();
