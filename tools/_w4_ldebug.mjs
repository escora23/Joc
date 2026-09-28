import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:5401/?shot=structures-levels-1', { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 600000, polling: 500 });
const r = await page.evaluate(() => {
  const { ctx } = window.__front;
  const st = [...ctx.sim.view.structures.values()].filter((s) => s.owner === 1).map((s) => ({ t: s.type, l: s.level, tile: s.tile, a: window.__units.anchorOf(s.tile), size: window.__units.sizeOf('struct', s.tile) }));
  const cam = ctx.cameraRig.getState({});
  return { cam, st, pos: ctx.camera.position.toArray() };
});
console.log(JSON.stringify(r, null, 0));
await page.screenshot({ path: 'shots/W4-closeout/ldebug.png' });
await browser.close();
