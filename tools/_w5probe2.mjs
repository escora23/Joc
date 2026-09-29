import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:5450/?shot=command-front', { timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 600000, polling: 1000 });
const r = await page.evaluate(() => {
  const I = window.__cmd, P = I.controller.ent;
  const list = [];
  for (const e of I.world.ents) {
    if (!e.alive || e.player) continue;
    const d = Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z);
    const v = e.pos.clone(); v.y += 1; v.project(I.camera ?? window.__front.ctx.command.camera); if (d < 800) list.push({ sx: Math.round((v.x + 1) * 800), sy: Math.round((1 - v.y) * 450), z: +v.z.toFixed(3), k: e.kind, t: e.team, d: Math.round(d), y: +(e.pos.y - I.ground.heightAt(e.pos.x, e.pos.z)).toFixed(1), vis: e.mesh ? e.mesh.visible : e.obj?.visible, dormant: e.dormant });
  }
  list.sort((a, b) => a.d - b.d);
  return list.slice(0, 20);
});
console.log(JSON.stringify(r));
await browser.close();
