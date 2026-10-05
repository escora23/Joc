import { chromium } from 'playwright';
const base = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('ERR', m.text()); });
await page.goto(base);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__front.app.state === 'menu');
await page.evaluate(() => window.__front.app.goto('setup'));
await page.waitForTimeout(1500);
await page.click('.fu-setup-start');
await page.waitForFunction(() => window.__front.app.state === 'spawn', null, { timeout: 120000 });
await page.evaluate(() => {
  const { ctx } = window.__front; window.__ev = [];
  ctx.canvas.addEventListener('pointerdown', (e) => window.__ev.push({ type: 'down', ts: e.timeStamp, b: e.button }));
  ctx.canvas.addEventListener('pointerup', (e) => window.__ev.push({ type: 'up', ts: e.timeStamp, b: e.button }));
  const orig = ctx.bus.emit.bind(ctx.bus);
  ctx.bus.emit = (type, p) => { if (['worldClick', 'toast', 'worldHover'].includes(type)) window.__ev.push({ type, tile: p?.tile, unitId: p?.unitId, structureId: p?.structureId, text: p?.text, button: p?.button }); return orig(type, p); };
});
// Germany interior: lookAt 52.5,13.4 and click a few tiles away from label
const r = await page.evaluate(() => {
  const v = window.__front.ctx.sim.view;
  const ger = v.playerList.filter((q) => q.kind === 'nation').sort((a, b) => b.tiles - a.tiles)[0];
  return { id: ger.id, name: ger.name, cap: ger.capitalTile, lx: ger.labelX, ly: ger.labelY };
});
console.log(r);
const lat = 90 - (Math.floor(r.cap / 1600) + 0.5) * 180 / 800, lon = ((r.cap % 1600) + 0.5) * 360 / 1600 - 180;
await page.evaluate(({ lat, lon }) => window.__front.ctx.cameraRig.setState({ lat, lon, altitudeKm: 2500, tilt: 0, heading: 0 }), { lat, lon });
await page.waitForTimeout(4000);
for (const [dx, dy] of [[0, 0], [40, 0], [0, 40]]) {
  const x = 800 + dx, y = 450 + dy;
  await page.mouse.move(x - 4, y - 3); await page.mouse.move(x, y, { steps: 2 });
  await page.waitForTimeout(2500);
  console.log('elem', await page.evaluate(({x,y}) => { const e = document.elementFromPoint(x,y); return e ? e.tagName + '.' + e.className : null; }, {x,y}));
  await page.mouse.click(x, y, { delay: 40 });
  await page.waitForTimeout(5000);
  const ev = await page.evaluate(() => { const e = window.__ev.filter((q) => q.type !== 'worldHover'); const h = window.__ev.filter((q) => q.type === 'worldHover').slice(-1); window.__ev = []; return [...h, ...e]; });
  const owner = await page.evaluate(({ x, y }) => { const t = window.__front.ctx.globe.pickTile(x, y); return { t, owner: window.__front.ctx.sim.view.owner[t] }; }, { x, y });
  console.log(x, y, JSON.stringify(owner), JSON.stringify(ev));
}
await page.screenshot({ path: '/tmp/claude-0/-home-user-procedural-terrain-generator/40934a72-ca05-52af-9ca0-c7756eb58848/scratchpad/spawnprobe.png' });
await browser.close();
