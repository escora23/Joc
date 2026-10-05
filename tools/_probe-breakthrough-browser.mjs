// Probe (sim-pacing-warfare fix): the command-battle shot's chip and notice over time (the breakthrough wording and
// both sides' counts over the same km).  node tools/_probe-breakthrough-browser.mjs [--url http://127.0.0.1:5484/]
import { chromium } from 'playwright';
const url = (process.argv[process.argv.indexOf('--url') + 1] || 'http://127.0.0.1:5484/') + '?shot=command-battle';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 600000 });
let lastNotice = '';
for (let i = 0; i < 10; i++) {
  const s = await page.evaluate(() => {
    const c = window.__cmdStats;
    return { combat: c?.combat ?? '', notice: c?.notice ?? '', battle: c?.battle ? { sides: c.battle.sides?.map((q) => [q.owner, q.role, q.perKm, q.shown]) } : null };
  });
  console.log(`t${i * 6}s chip «${s.combat}» ${JSON.stringify(s.battle)}`);
  if (s.notice && s.notice !== lastNotice) console.log(`   notice «${s.notice}»`), (lastNotice = s.notice);
  if (i === 2) await page.screenshot({ path: 'shots/fix-sim-pacing-warfare/battle-chip.png' });
  await page.waitForTimeout(6000);
}
await browser.close();
