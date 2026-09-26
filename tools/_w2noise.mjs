import { chromium } from 'playwright'; import { PNG } from 'pngjs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } }); p.setDefaultTimeout(400000);
await p.goto(`http://127.0.0.1:5312/?shot=borders-close&flash=1&freeze=1&hud=0&alt=1500`, { timeout: 400000 });
await p.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await p.evaluate(() => window.__territory.pinFlash(3));
await p.waitForTimeout(4000);
const fr = async (n) => { const f0 = await p.evaluate(() => window.__front.ctx.frame.frame); await p.waitForFunction((f) => window.__front.ctx.frame.frame > f, f0 + n); };
const shots = [];
for (let i = 0; i < 3; i++) { await fr(4); shots.push(PNG.sync.read(await p.screenshot())); }
const diff = (A, B) => { const px = []; for (let i = 0; i < A.width * A.height; i++) { const d = Math.abs(A.data[i*4]-B.data[i*4]) + Math.abs(A.data[i*4+1]-B.data[i*4+1]) + Math.abs(A.data[i*4+2]-B.data[i*4+2]); if (d > 6) px.push([i % A.width, Math.floor(i / A.width), d]); } return px; };
for (const [i, j] of [[0,1],[1,2]]) { const d = diff(shots[i], shots[j]); console.log(i, j, d.length, JSON.stringify(d.slice(0, 15))); }
const info = await p.evaluate(() => ({ speed: window.__front.ctx.sim.view.speed, units: window.__front.ctx.sim.view.units.size }));
console.log(JSON.stringify(info));
await b.close();
