// FRONT ULTRA — automated playthrough (owner: app).
// Drives the real UI like a player: loading -> press key -> menu -> setup -> start -> spawn click ->
// playing (attack clicks, speed changes) and reports state, stats, console errors and screenshots.
// Usage: node tools/playtest.mjs [--url http://127.0.0.1:5180/] [--out shots/playtest] [--seconds 30]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5180/';
const out = args.out || 'shots/playtest';
const seconds = Number(args.seconds || 30);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const state = () => page.evaluate(() => window.__front?.app.state ?? 'boot');
const waitState = async (s, timeout = 120000) => {
  await page.waitForFunction((want) => window.__front?.app.state === want, s, { timeout });
};
const shot = async (name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log(`  shot ${name}.png`); };
const step = (msg) => console.log(`[playtest] ${msg}`);

try {
  await page.goto(base, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
  step('loading finished; pressing a key');
  await page.keyboard.press('Enter');
  await waitState('menu');
  await page.waitForTimeout(1500);
  await shot('01-menu');

  step('menu -> setup');
  await page.locator('#ui button').first().click();
  await waitState('setup');
  await shot('02-setup');

  step('setup -> start');
  await page.locator('#ui button').nth(0).click();
  await waitState('spawn');
  await page.waitForTimeout(2500);
  await shot('03-spawn');

  step('spawn: clicking land (screen center)');
  for (let i = 0; i < 6 && (await state()) === 'spawn'; i++) {
    await page.mouse.click(800 + i * 25, 450 + i * 10);
    await page.waitForTimeout(2500);
  }
  await waitState('playing', 60000);
  await page.waitForTimeout(3000);
  await shot('04-playing');

  step(`playing for ${seconds}s with periodic attack clicks`);
  const t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < seconds * 1000 && (await state()) === 'playing') {
    const a = (k++ * 0.9) % (Math.PI * 2);
    await page.mouse.click(800 + Math.cos(a) * 120, 450 + Math.sin(a) * 80);
    await page.waitForTimeout(2000);
  }
  await shot('05-later');
  const stats = await page.evaluate(() => {
    const v = window.__front.ctx.sim.view;
    const h = v.human;
    return { tick: v.tick, phase: v.phase, players: v.playerList.length, human: h && { tiles: h.tiles, troops: Math.round(h.troops), gold: Math.round(h.gold), alive: h.alive } };
  });
  step(`final state=${await state()} ${JSON.stringify(stats)}`);
} catch (err) {
  errors.push(`[playtest] ${err.message}`);
  await shot('99-failure').catch(() => {});
}
if (errors.length) {
  console.log(`[playtest] ${errors.length} error(s):`);
  for (const e of errors.slice(0, 40)) console.log('   ', e);
}
await browser.close();
process.exit(errors.some((e) => !e.includes('404')) ? 1 : 0);
