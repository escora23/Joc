import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await page.goto('http://127.0.0.1:5401/?shot=forces-panel', { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 600000, polling: 500 });
const at = (la, lo) => Math.floor((90 - la) / 180 * 800) * 1600 + Math.floor((lo + 180) / 360 * 1600);
const A = at(37.39, -5.98), B = at(41.65, -0.88);
await page.evaluate(({ A }) => {
  const { ctx } = window.__front;
  const at = (la, lo) => Math.floor((90 - la) / 180 * 800) * 1600 + Math.floor((lo + 180) / 360 * 1600);
  ctx.sim.debug({ type: 'conquer', playerId: 1, centerTile: at(38.2, -4.9), radius: 11 });
  ctx.sim.debug({ type: 'spawnStructure', structure: 0, owner: 1, tile: A, level: 1 });
  ctx.sim.setSpeed(4);
}, { A });
await page.waitForTimeout(40000);
await page.evaluate(({ A }) => { window.__front.ctx.sim.setSpeed(1); window.__front.ctx.sim.debug({ type: 'spawnUnit', unit: 3, owner: 1, tile: A, targetTile: -1 }); }, { A });
await page.waitForTimeout(5000);
const id = await page.evaluate(({ A, B }) => {
  const { ctx } = window.__front;
  const us = [...ctx.sim.view.units.values()].filter((x) => x.owner === 1 && x.type === 3 && Math.abs(x.x - (A % 1600) - 0.5) < 1.5);
  const u = us.sort((a, b) => b.id - a.id)[0];
  ctx.sim.setSpeed(0);
  ctx.sim.send({ type: 'unitOrder', unitIds: [u.id], order: 'move', tile: B, targetId: 0 });
  return u.id;
}, { A, B });
await page.waitForTimeout(3000);
console.log('route', await page.evaluate((id) => { const r = window.__front.ctx.sim.view.routes.get(id); return r ? [...r].map((t) => [t % 1600, Math.floor(t / 1600)]) : null; }, id));
await page.evaluate(() => window.__front.ctx.sim.setSpeed(2));
let last = '';
for (let i = 0; i < 600; i++) {
  const s = await page.evaluate((id) => { const v = window.__front.ctx.sim.view; const u = v.units.get(id); return u ? `${v.tick} m${u.mode} ${u.x.toFixed(1)},${u.y.toFixed(1)} eta${u.etaTicks}` : 'gone'; }, id);
  const k = s.split(' ').slice(1, 2).join();
  if (k !== last || i % 20 === 0) console.log(s);
  last = k;
  if (s.includes('m3') || s === 'gone') break;
  await page.waitForTimeout(200);
}
await browser.close();
