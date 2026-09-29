import { chromium } from 'playwright';
const base = process.argv[2] || 'http://127.0.0.1:5440/';
const tag = process.argv[3] || 'a';
const extra = process.argv[4] || '';
const out = '/home/user/joc/shots/W6-fix-final';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[w6]') || m.type() === 'error') console.log('  ', t.slice(0, 300)); });
await page.goto(`${base}?shot=front-ground-real&night=1&quality=medium${extra}`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
await page.waitForTimeout(3000);
const st = () => page.evaluate(() => {
  const d = window.__battleDebug.shown();
  const banners = [...document.querySelectorAll('.fu-bbanner')].map((e) => ({ t: e.textContent, disp: e.style.display, r: e.getBoundingClientRect().toJSON() }));
  const u = __front.ctx.battle && window.__battleDebug;
  return { split: d?.split, inf: d?.infantry, soldiers: window.__battleDebug.soldiersOnScreen?.(200), banners, cam: __front.ctx.cameraRig.getState(), strip: document.querySelector('.fu-bstrip')?.textContent };
});
console.log(JSON.stringify(await st()));
await page.screenshot({ path: `${out}/night-ground-${tag}.png`, timeout: 300000 });
// Closer: 450 m over the anchor, looking across the line.
await page.evaluate(() => { const c = __front.ctx.cameraRig.getState(); __front.ctx.cameraRig.setState({ ...c, altitudeKm: 0.45 }); });
await page.waitForTimeout(25000);
console.log(JSON.stringify(await st()));
await page.screenshot({ path: `${out}/night-450-${tag}.png`, timeout: 300000 });
await browser.close();
