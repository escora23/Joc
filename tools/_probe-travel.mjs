import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:5480/?shot=command-travel', { timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 1500000, polling: 2000 });
const r = await page.evaluate(() => {
  const I = window.__cmd, cam = I.camera, P = I.world.player;
  const v = P.pos.clone().project(cam);
  const f = new cam.position.constructor(); cam.getWorldDirection(f);
  return { cam: cam.position.toArray().map(Math.round), P: P.pos.toArray().map(Math.round), yaw: P.yaw, fwd: f.toArray().map((x)=>+x.toFixed(2)), ndc: [v.x, v.y, v.z].map((x)=>+x.toFixed(2)), fov: cam.fov, roads: (() => { const sc = I.civil.group.parent; const m = sc.getObjectByName('cmd-far-roads'); return { map: I.civil.mapRoads.length, pts: I.civil.mapRoads.slice(0,3).map(l=>[l[0]-I.frame.offX,l[1]-I.frame.offZ,l.length]), vis: m?.visible, idx: m?.geometry.index?.count ?? 0, y0: m?.geometry.attributes.position?.array.slice(0,3) && Array.from(m.geometry.attributes.position.array.slice(0,3)).map(Math.round), fog: sc.fog?.density, dy: (() => { const a = m.geometry.attributes.position.array; const out = []; for (let i = 0; i < a.length; i += Math.floor(a.length / 8 / 3) * 3) out.push(Math.round(a[i + 1] - I.ground.heightAt(a[i], a[i + 2]))); return out; })() }; })(), st: { rate: window.__cmdStats.rate, travel: window.__cmdStats.travel, fps: window.__cmdStats.fps, farRoads: window.__cmdStats.farRoads } };
});
console.log(JSON.stringify(r));
await page.screenshot({ path: process.argv[2] });
await browser.close();
