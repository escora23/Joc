import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (/\[shot\]|\[command\]/.test(m.text())) console.log(m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5450/?shot=command-front', { timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 600000, polling: 1000 });
const r = await page.evaluate(() => {
  const I = window.__cmd, P = I.controller.ent;
  const out = {};
  for (const e of I.world.ents) {
    if (!e.alive || e.player) continue;
    const d = Math.hypot(e.pos.x - P.pos.x, e.pos.z - P.pos.z);
    const k = `${e.team}:${e.kind}:${e.neutral ? 'n' : ''}`;
    out[k] ??= { n: 0, min: 1e9, crowd: 0 };
    out[k].n++; out[k].min = Math.min(out[k].min, Math.round(d));
  }
  const g = I.ground;
  return { out, p: [P.pos.x, P.pos.y, P.pos.z], h: g.heightAt(P.pos.x, P.pos.z), stats: window.__cmdStats?.info, fr: I.forces?.last?.fronts?.map((f) => ({ key: f.key, a: f.a, b: f.b, n: f.nearest, lineKm: f.lineKm, windowKm: f.windowKm })), lf: I.forces?.last && { lat: I.forces.last.lat, lon: I.forces.last.lon }, where: I.where() };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
