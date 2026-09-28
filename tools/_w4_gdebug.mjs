import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[c]', m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5401/?shot=model-gallery&hud=0', { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 600000, polling: 500 });
const r = await page.evaluate(() => {
  const v = window.__front.ctx.sim.view;
  const units = [...v.units.values()].map((u) => `${u.type}/${u.owner}/s${u.state}/m${u.mode}`);
  return { tick: v.tick, units, subjects: window.__gallery.subjects.filter((s) => s.kind === 'unit').map((s) => s.name) };
});
console.log(JSON.stringify(r));
await browser.close();
