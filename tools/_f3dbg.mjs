import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:5467/?shot=f3-damage', { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 1800000 });
const D = '/tmp/claude-0/-home-user-procedural-terrain-generator/40934a72-ca05-52af-9ca0-c7756eb58848/scratchpad/f3/exp';
const info = await page.evaluate(() => {
  const out = [];
  __front.ctx.scene.traverse((o) => { if (o.visible && (o.isMesh || o.isPoints) && o.geometry) { const bs = o.geometry.boundingSphere; out.push(`${o.name || o.type}:${o.count ?? ''}:${o.material?.type}`); } });
  return out.slice(0, 80);
});
console.log(info.join('\n'));
const D2 = D;
await page.screenshot({ path: `${D2}/dbg0.png` });
for (const [tag, pre] of [['noparticles', 'fx-particles'], ['norubble', 'struct-rubble'], ['nobattle', 'battle-']]) {
  await page.evaluate((pre) => { __front.ctx.scene.traverse((o) => { if (o.name && o.name.startsWith(pre)) o.visible = false; }); }, pre);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${D2}/dbg-${tag}.png` });
}
await browser.close();
