import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
await page.goto('http://127.0.0.1:5480/?shot=command-travel', { timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 1500000, polling: 2000 });
const r = await page.evaluate(() => {
  const I = window.__cmd, cam = I.camera;
  const sc = I.civil.group.parent; const m = sc.getObjectByName('cmd-far-roads');
  const a = m.geometry.attributes.position.array; const V = new cam.position.constructor();
  let inside = 0, total = 0, below = 0; const samples = [];
  for (let i = 0; i < a.length; i += 3) {
    V.set(a[i] + m.position.x, a[i + 1], a[i + 2] + m.position.z); total++;
    const g = I.ground.heightAt(V.x, V.z); if (V.y < g) below++;
    const p = V.clone().project(cam);
    if (Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1) { inside++; if (samples.length < 6 && i % 60 === 0) samples.push([Math.round((p.x+1)*800), Math.round((1-p.y)*450)]); }
  }
  const towns = I.civil.towns.map((t) => [Math.round(t.ax - I.frame.offX), Math.round(t.az - I.frame.offZ), t.level]).slice(0, 12);
  return { total, inside, below, samples, mpos: m.position.toArray(), parentIsScene: m.parent?.type, visible: m.visible, layers: m.layers.mask, matVis: m.material.visible, towns, cam: cam.position.toArray().map(Math.round) };
});
console.log(JSON.stringify(r));
await browser.close();
