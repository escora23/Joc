import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:5401/?shot=model-gallery&hud=0', { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 600000, polling: 500 });
const r = await page.evaluate(async () => {
  const { ctx } = window.__front;
  const out = [];
  for (const s of window.__gallery.subjects.filter((x) => x.kind === 'struct' && /port|naval/.test(x.name))) {
    const t = s.tile;
    const lat0 = 90 - (Math.floor(t / 1600) + 0.5) * (180 / 800), lon0 = ((t % 1600) + 0.5) * (360 / 1600) - 180;
    const a = window.__units.anchorOf(t);
    ctx.cameraRig.setState({ lat: a.lat, lon: a.lon, altitudeKm: 40, tilt: 0.6, heading: 0.5 });
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    const a2 = window.__units.anchorOf(t);
    out.push({ name: s.name, lat0, lon0, a, a2, size: window.__units.sizeOf('struct', t), view: ctx.camera.view ? { ...ctx.camera.view } : null });
  }
  return out;
});
console.log(JSON.stringify(r));
await browser.close();
