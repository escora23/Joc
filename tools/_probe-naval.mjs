// Gauntlet round 1 (battle fix 2) probe: on ?shot=readability-europe, how many transports there are, how many are real
// landings that concern the player, and how many invasion arrows the overlay draws.
//   node tools/_probe-naval.mjs [--url http://127.0.0.1:5481/] [--out shots/fix-battle]
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const url = args.url || 'http://127.0.0.1:5481/';
const out = args.out || 'shots/fix-battle';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${url}?shot=readability-europe`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 900000, polling: 2000 });
await new Promise((r) => setTimeout(r, 4000));
const r = await page.evaluate(() => {
  const v = window.__front.ctx.sim.view, st = window.__frontOverlay.stats();
  const r = { drawn: st.naval, transports: 0, real: 0, expected: 0, neutral: 0, peaceful: 0 };
  for (const u of v.units.values()) {
    if (u.type !== 0 || u.state === 6) continue;
    r.transports++;
    const o = v.owner[Math.floor(u.targetY) * 1600 + Math.floor(u.targetX)];
    if (o === 0) { r.neutral++; continue; }
    if (o === u.owner || v.pairState(u.owner, o) !== 'war') { r.peaceful++; continue; }
    r.real++;
    if (u.state !== 3 && (u.owner === 1 || o === 1 || v.hasTreaty(1, o, 'alliance'))) r.expected++;
  }
  return r;
});
console.log(JSON.stringify(r));
await page.screenshot({ path: `${out}/navprobe-europe.png` });
await browser.close();
