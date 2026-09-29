// Independent verifier probe (temporary, W5 final verify): release inside foreign land via the REAL UI.
// Esc -> confirm (Enter) -> debrief -> map; auto-pause; click the alert row; right-click own land; resume; unit leaves.
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.argv[2] ?? 'shots/_vr5';
const BASE = process.argv[3] ?? 'http://127.0.0.1:5470/';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(`${BASE}?shot=command-escort&live=1`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 600000, polling: 500 });
await page.waitForFunction(() => window.__cmdStats?.phase === 'play', null, { timeout: 200000, polling: 500 });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 180000 }).catch(() => undefined);
const unit = () => page.evaluate(() => {
  const v = window.__front.ctx.sim.view; const id = window.__vrId ?? v.command?.controlled?.[0]?.unitId; window.__vrId = id;
  const u = v.units.get(id); const inc = v.command?.incursions?.filter((i) => i.unitId === id).pop();
  return { id, x: u?.x, y: u?.y, hp: u?.hp, heading: u?.heading, mode: u?.mode, order: u?.order, owner: u ? v.ownerAt(Math.floor(u.y) * 1600 + Math.floor(u.x)) : -1, inc: inc ? { response: inc.response, left: inc.left, leaving: inc.leaving, victim: inc.victim, deadline: inc.deadline } : null, speed: v.speed, tick: v.tick, war: inc ? v.pairState(1, inc.victim) : '' };
});
const u0 = await unit();
log('entry', JSON.stringify(u0));
await shot('r0-in-command');
// The player was at x1 on the map before entering (staging holds 0).
await page.evaluate(() => window.__cmd.ctx.sim.setSpeed(1));
// Real key: Escape -> confirmation dialog.
await page.keyboard.press('Escape');
await wait(4000);
const dlg = await page.evaluate(() => document.querySelector('.fu-cmdx-dialog, .fu-cmd-dialog')?.textContent ?? document.body.innerText.match(/Salir[^\n]*\n[^\n]*\n[^\n]*/)?.[0] ?? '');
log('dialog', dlg.slice(0, 300));
await shot('r1-exit-dialog');
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__cmdStats?.phase === 'debrief' || window.__front.app.state === 'playing', null, { timeout: 300000, polling: 300 }).catch(() => undefined);
await wait(1500);
const deb = await page.evaluate(() => ({ t: window.__cmd?.overlay?.debrief?.textContent ?? '', sec: window.__front.ctx.sim.view.command?.sec, start: window.__cmd?.startCmdSec }));
log('debrief', JSON.stringify(deb).slice(0, 500));
await shot('r2-debrief');
const ok = await page.waitForFunction(() => window.__front.app.state === 'playing', null, { timeout: 900000, polling: 300 }).then(() => true).catch(() => false);
log('back on map', ok);
await wait(3000);
await shot('r3-map-after-exit');
const u1 = await unit();
const pz = await page.evaluate(() => { const b = document.querySelector('.fu-autopause'); return { banner: !!b && !b.classList.contains('fu-hidden'), kind: b?.dataset.kind, text: b?.textContent?.slice(0, 200), rows: [...document.querySelectorAll('.fu-alert')].map((e) => e.textContent.slice(0, 220)) }; });
log('after exit', JSON.stringify(u1), JSON.stringify(pz));
const km = (a, b) => Math.hypot((a.x - b.x) * 25 * Math.cos(46.5 * Math.PI / 180), (a.y - b.y) * 25);
log('moved since entry km', km(u0, u1).toFixed(3), 'heading', u0.heading, '->', u1.heading);
// Wait paused 10 s: nothing should move.
await wait(10000);
const u2 = await unit();
log('paused 10 s', JSON.stringify(u2), 'km', km(u1, u2).toFixed(3));
// Click the «sigue dentro» alert row.
const rowBox = await page.evaluate(() => { const r = [...document.querySelectorAll('.fu-alert')].find((e) => /sigue dentro|still inside/i.test(e.textContent)); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 12, t: r.textContent.slice(0, 300) }; });
log('row', JSON.stringify(rowBox));
if (rowBox) { await page.mouse.click(rowBox.x, rowBox.y); }
await wait(6000);
const sel = await page.evaluate(() => window.__fuHud?.shared?.selection ?? null);
log('selection after alert click', JSON.stringify(sel));
await shot('r4-after-alert-click');
// Right-click the nearest own land tile, projected to the screen.
const tgt = await page.evaluate((id) => {
  const { ctx } = window.__front; const v = ctx.sim.view; const u = v.units.get(id);
  const cands = [];
  for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) { const tx = Math.floor(u.x) + dx, ty = Math.floor(u.y) + dy; const t = ty * 1600 + tx; if (v.ownerAt(t) === 1) cands.push({ t, d: dx * dx + dy * dy, tx, ty }); }
  cands.sort((a, b) => a.d - b.d);
  const cam = ctx.camera; const out = [];
  for (const c of cands.slice(0, 40)) {
    const lat = 90 - ((c.ty + 0.5) / 800) * 180, lon = ((c.tx + 0.5) / 1600) * 360 - 180;
    const r = ctx.globe.surfaceRadiusAt(lat, lon); const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const p = cam.position.clone().set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
    const facing = cam.position.clone().sub(p).dot(p) > 0; p.project(cam);
    const x = ((p.x + 1) / 2) * innerWidth, y = ((1 - p.y) / 2) * innerHeight;
    if (facing && x > 300 && x < innerWidth - 300 && y > 150 && y < innerHeight - 150) out.push({ ...c, x, y });
  }
  return out.slice(0, 3);
}, u0.id);
log('own land targets', JSON.stringify(tgt));
let lastRight = null;
await page.evaluate(() => { window.__vrClicks = []; window.__front.ctx.bus.on('worldClick', (e) => window.__vrClicks.push({ tile: e.tile, button: e.button, unitId: e.unitId })); });
if (tgt.length) {
  const p = tgt[Math.min(2, tgt.length - 1)];
  await page.mouse.move(p.x - 5, p.y - 5); await wait(1500); await page.mouse.move(p.x, p.y, { steps: 3 }); await wait(2500);
  await page.mouse.click(p.x, p.y, { button: 'right', delay: 60 });
  lastRight = p;
}
await wait(5000);
const clicks = await page.evaluate(() => window.__vrClicks);
const uo = await unit();
log('after right-click', JSON.stringify(clicks), JSON.stringify(uo));
await shot('r5-after-right-click');
// Resume with the banner button (as a player would), then watch.
await page.evaluate(() => document.querySelector('.fu-autopause:not(.fu-hidden) .fu-btn--primary')?.click());
let st = null; const seen = [];
for (let i = 0; i < 120; i++) {
  await wait(2000);
  st = await unit();
  const sp = st.speed;
  seen.push({ i, x: +st.x?.toFixed(3), y: +st.y?.toFixed(3), hp: st.hp, owner: st.owner, inc: st.inc?.response, leaving: st.inc?.leaving, left: st.inc?.left, speed: sp, war: st.war });
  if (sp === 0) { const b = await page.evaluate(() => document.querySelector('.fu-autopause')?.textContent?.slice(0, 160)); log('paused again:', b); await page.evaluate(() => document.querySelector('.fu-autopause:not(.fu-hidden) .fu-btn--primary')?.click()); }
  if (st.owner === 1 || !st.inc || st.inc.left) { if (i > 3) break; }
}
log('trace', JSON.stringify(seen.filter((_, k) => k % 3 === 0 || k === seen.length - 1)));
const feed = await page.evaluate(() => [...document.querySelectorAll('.fu-alert')].map((e) => e.textContent.slice(0, 160)));
log('final', JSON.stringify(st), JSON.stringify(feed));
await shot('r6-final');
log('errors', JSON.stringify(errs.slice(0, 5)));
await browser.close();
