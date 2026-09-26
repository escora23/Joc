import { chromium } from 'playwright'; import { PNG } from 'pngjs'; import fs from 'node:fs';
const alt = process.argv[2] || 1500, row = +(process.argv[3] || 380), x0 = +(process.argv[4] || 770), x1 = +(process.argv[5] || 800);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } }); p.setDefaultTimeout(400000);
await p.goto(`http://127.0.0.1:5312/?shot=borders-close&flash=1&freeze=1&hud=0&alt=${alt}${process.argv[6]||""}`, { timeout: 400000 });
await p.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await p.waitForTimeout(3000);
const png = PNG.sync.read(await p.screenshot({ path: '/tmp/claude-0/dbg.png' }));
for (let x = x0; x <= x1; x++) { const o = (row * png.width + x) * 4; console.log(x, png.data[o], png.data[o+1], png.data[o+2]); }
await b.close();
