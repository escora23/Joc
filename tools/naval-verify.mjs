// Owner item 30 browser verifier: the war at sea played through the real UI in Chromium (SwiftShader), on a staged but
// real sim (the ?shot= stagers only issue sim commands and run real ticks).
//   node tools/naval-verify.mjs [--url http://127.0.0.1:5469/] [--out shots/feedback3-naval/verify] [--only blockade,port,command]
//
// blockade  our two warships selected, a right-click on the Strait of Gibraltar opens the blockade dialog (V1) with what
//           sails through now and whom it stops (V2); «A todos» turns the costs into piracy with each nation's opinion
//           (V3); back to «Solo enemigos», «Establecer bloqueo» sends it (V4); with time running it comes into force:
//           the hatched zone and its chip on the map (V5); the enemy's merchants reroute (Detour on the map) and the
//           ledger fills (V6); the Guerra panel «Mar» tab shows it with its gains and the straits (V7).
// port      the enemy blockades our port: its card shows the trade lost per hour and the alert names who and where (P1,
//           P2); the «Mar» tab lists it against us with «Romper el bloqueo» (P3).
// command   a warship in command mode with a foreign merchant alongside: the stop panel (C1); E hails it and it heaves
//           to in the sim (C2); F boards it: it flies our flag and sails to our port (C3); R fires a warning shot at the
//           convoy: it heaves to and the nation's opinion falls (C4); X at peace asks first, then sinks it (C5).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5469/';
const out = args.out || 'shots/feedback3-naval/verify';
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(out, { recursive: true });
const results = [];
const row = (id, what, value, pass) => {
  results.push({ id, what, value: String(value), pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${what} :: ${value}`);
};
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
let errors = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(shot, params = '') {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => { errors++; console.log(`[pageerror] ${e.message}`); });
  await page.goto(`${base}?shot=${shot}${params}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__nv = { stops: [], rer: [], acks: [], blk: [], prize: [] };
    const bus = __front.ctx.bus;
    bus.on('shipStopped', (e) => window.__nv.stops.push(e));
    bus.on('shipRerouted', (e) => window.__nv.rer.push(e));
    bus.on('orderAck', (e) => window.__nv.acks.push(e));
    bus.on('blockade', (e) => window.__nv.blk.push(e));
    bus.on('prizeDelivered', (e) => window.__nv.prize.push(e));
  });
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), timeout: 300000 }).catch((e) => console.log(`   (screenshot ${name} failed: ${String(e?.message ?? e).split('\n')[0]})`));
async function until(page, fn, arg, ms = 30000, every = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    await sleep(every);
  }
  return null;
}
async function uiClick(page, target, timeout = 20000) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target.first();
  try {
    await loc.click({ timeout: Math.min(timeout, 8000) });
    return;
  } catch (e) {
    if (!/not stable|Timeout|intercepts/.test(String(e?.message ?? e))) throw e;
  }
  await loc.waitFor({ state: 'visible', timeout });
  const box = await loc.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
/** Run the game at `speed` until `ticks` more ticks passed, then pause. */
async function runTicks(page, ticks, speed = 4, ms = 900000) {
  const t0 = await page.evaluate(() => __front.ctx.sim.view.tick);
  await page.evaluate((s) => __front.ctx.app.setSpeed(s), speed);
  await until(page, (t) => __front.ctx.sim.view.tick >= t, t0 + ticks, ms, 500);
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  await sleep(600);
}
/** Screen px of a lat/lon on the globe (the naval shots' helper). */
const screenOf = (page, lat, lon) => page.evaluate(([lat, lon]) => window.__fuNaval.screen(lat, lon), [lat, lon]);

// ---------------------------------------------------------------------------------------------------------------------
async function blockade() {
  const page = await open('naval-sea');
  // V1: right-click on the Strait of Gibraltar with the two warships selected.
  const p = await screenOf(page, 35.95, -5.6);
  await page.mouse.move(p.x, p.y);
  await sleep(1500);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const dlg = await until(page, () => document.querySelector('.fu-blk-dialog')?.textContent ?? null, null, 40000);
  row('V1', 'right-click on Gibraltar opens the blockade dialog', dlg ? dlg.slice(0, 90) : 'no dialog', !!dlg && /Gibraltar/.test(dlg));
  await shot(page, 'v1-dialog');
  // V2: what sails through now, whom it stops (enemies only by default).
  const rows = await page.evaluate(() => [...document.querySelectorAll('.fu-blk-trow')].map((r) => ({ text: r.textContent, stopped: r.classList.contains('is-stopped') })));
  const warStopped = rows.filter((r) => r.stopped).every((r) => /en guerra/.test(r.text));
  row('V2', 'the preview lists who sails through here; by default only the nations at war are stopped', rows.map((r) => `${r.text.replace(/\s+/g, ' ')}`).join(' | ').slice(0, 300), rows.length > 0 && warStopped && rows.some((r) => !r.stopped));
  // V3: «A todos» = piracy costs per nation.
  await uiClick(page, page.locator('.fu-blk-seg button', { hasText: 'A todos' }));
  await sleep(1200);
  const costs = await page.evaluate(() => [...document.querySelectorAll('.fu-blk-preview li')].map((l) => l.textContent).join(' | '));
  row('V3', '«A todos»: the costs turn into piracy, with each nation\'s opinion and risk of war', costs.slice(0, 400), /Piratería/.test(costs) && /riesgo de guerra/.test(costs));
  await shot(page, 'v3-piracy');
  // V4: back to «Solo enemigos en guerra» and confirm.
  await uiClick(page, page.locator('.fu-blk-seg button', { hasText: 'Solo enemigos' }));
  await sleep(600);
  await uiClick(page, page.locator('.fu-blk-dialog .fu-modal-foot button').last());
  const ack = await until(page, () => window.__nv.acks.find((a) => a.order === 'blockade'), null, 30000);
  const b0 = await page.evaluate(() => __front.ctx.sim.view.blockades.find((b) => b.owner === 1));
  row('V4', '«Establecer bloqueo» sends the order with its spec', ack ? `accepted ${ack.accepted.length}/${ack.unitIds.length}, blockade ${b0 ? `${b0.kind}/${b0.key} ${JSON.stringify(b0.spec)}` : 'none'}` : 'no ack', !!ack && ack.accepted.length === 2 && b0?.key === 'gibraltar' && b0.spec.who === 'war');
  // V5: in force: the hatched zone and the chip.
  await runTicks(page, 60, 4);
  await until(page, () => __front.ctx.sim.view.blockades.some((b) => b.owner === 1 && b.active), null, 120000);
  await page.evaluate(() => __front.ctx.cameraRig.setState({ lat: 36.3, lon: -4.0, altitudeKm: 2400, tilt: 0.15, heading: 0 }));
  const map = (await until(page, () => {
    const chip = [...document.querySelectorAll('.fu-blk-badge')].find((c) => c.style.display !== 'none' && c.offsetParent !== null);
    return chip ? { chip: chip.textContent } : null;
  }, null, 60000, 1000)) ?? { chip: null };
  const active = await page.evaluate(() => __front.ctx.sim.view.blockades.find((b) => b.owner === 1)?.active);
  row('V5', 'the blockade comes into force: its chip names the strait on the map', `active ${active}, chip «${map.chip ?? 'none'}»`, active && !!map.chip && /Gibraltar/.test(map.chip));
  await shot(page, 'v5-zone');
  // V6: the enemy reroutes; the ledger fills.
  await runTicks(page, 400, 8);
  const led = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const b = v.blockades.find((x) => x.owner === 1);
    const detour = [...v.units.values()].filter((u) => u.mode === 18).length;
    return b ? { rerouted: b.rerouted, seized: b.seized, lostH: b.enemyLostPerHour, lost: b.enemyLost, gold: b.gold, detour, nations: b.nations.map((n) => `${v.players[n.id]?.name}:${n.rerouted}r/${n.seized}s/${n.lost}`) } : null;
  });
  row('V6', 'enemy merchants reroute around the strait (the long way) and its trade loss is measured', led ? JSON.stringify(led) : 'none', !!led && (led.rerouted > 0 || led.seized > 0) && led.lost > 0);
  await page.evaluate(() => __front.ctx.cameraRig.setState({ lat: 20, lon: 5, altitudeKm: 9000, tilt: 0, heading: 0 }));
  await sleep(4000);
  await shot(page, 'v6-detours');
  // V7: the Guerra panel «Mar».
  await page.keyboard.press('KeyG');
  await sleep(1500);
  await uiClick(page, page.locator('.fu-warpanel .fu-nt-tab', { hasText: 'Mar' }));
  await sleep(2500);
  const sea = await page.evaluate(() => document.querySelector('.fu-sea')?.textContent?.replace(/\s+/g, ' ') ?? '');
  row('V7', 'Guerra › Mar: our blockade with its gains, stops and consequences; the straits', sea.slice(0, 400), /Estrecho de Gibraltar/.test(sea) && /Botín/.test(sea) && /Cerrar un paso/i.test(sea));
  await shot(page, 'v7-mar');
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------------
async function port() {
  const page = await open('naval-port');
  const card = await until(page, () => document.querySelector('.fu-blk-card:not(.fu-hidden)')?.textContent ?? null, null, 60000);
  row('P1', 'our blockaded port\'s card: who blockades it and the trade lost per hour', card ?? 'no line', !!card && /Bloqueado por/.test(card) && /oro\/h/.test(card));
  await shot(page, 'p1-card');
  const alert = await page.evaluate(() => window.__fuAlerts.list().find((a) => a.kind === 'blockade' && /bloquea/i.test(a.title)) ?? null);
  row('P2', 'the located alert: who closes which port (click flies there)', alert ? `«${alert.title}» at ${alert.lat?.toFixed(1)}, ${alert.lon?.toFixed(1)}` : 'none', !!alert && Number.isFinite(alert.lat));
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyG');
  await sleep(1500);
  await uiClick(page, page.locator('.fu-warpanel .fu-nt-tab', { hasText: 'Mar' }));
  await sleep(2500);
  const sea = await page.evaluate(() => document.querySelector('.fu-sea')?.textContent?.replace(/\s+/g, ' ') ?? '');
  row('P3', 'Guerra › Mar lists the blockade against us, with «Romper el bloqueo» and «Escoltar mercantes»', sea.slice(0, 400), /bloquea/.test(sea) && /Romper el bloqueo/.test(sea) && /Escoltar mercantes/.test(sea));
  await shot(page, 'p3-mar');
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------------
async function command() {
  const page = await open('command-merchant', '&live=1');
  await page.evaluate(() => window.__cmd?.skipIntro?.());
  const stats = () => page.evaluate(() => window.__cmdStats?.intercept ?? null);
  const panel = await until(page, () => window.__cmdStats?.intercept?.target ? window.__cmdStats.intercept : null, null, 120000, 1000);
  row('C1', 'the stop panel for the foreign merchant alongside', panel ? `${panel.text.slice(0, 160)} (target ${panel.target.kind} at ${panel.target.distM} m)` : 'none', !!panel && /Dar el alto/.test(panel.text));
  await shot(page, 'c1-panel');
  const target = panel?.target?.unitId ?? 0;
  // C2: E hails it; the sim's ship heaves to.
  await page.keyboard.press('KeyE');
  const hove = await until(page, (id) => __front.ctx.sim.view.units.get(id)?.mode === 19, target, 90000, 1000);
  row('C2', 'E: «Dar el alto» — the merchant heaves to in the sim', `mode HoveTo ${!!hove}; radio «${(await stats())?.text?.match(/«[^»]+»/)?.[0] ?? ''}»`, !!hove);
  // C3: F boards it (alongside, slow, stopped): stop our engines first (S on the telegraph), then F.
  for (let k = 0; k < 5; k++) {
    await page.keyboard.down('KeyS');
    await sleep(1500);
    await page.keyboard.up('KeyS');
    await sleep(800);
  }
  await until(page, () => (window.__cmdStats?.speedKmh ?? 99) < 20, null, 600000, 2000);
  const near = await until(page, () => {
    const s = window.__cmdStats?.intercept;
    return s?.target && s.target.distM <= 700 ? s.target.distM : null;
  }, null, 60000, 1000);
  const boardTarget = await page.evaluate(() => window.__cmdStats?.intercept?.target?.unitId ?? 0);
  // Still hove to? (a hail holds it 6 game hours) — else hail it again.
  if (!(await page.evaluate((id) => __front.ctx.sim.view.units.get(id)?.mode === 19, boardTarget))) {
    await page.keyboard.down('KeyE');
    await sleep(1500);
    await page.keyboard.up('KeyE');
    await until(page, (id) => __front.ctx.sim.view.units.get(id)?.mode === 19, boardTarget, 60000, 1000);
  }
  console.log(`   (before F: ${await page.evaluate(() => JSON.stringify({ speed: window.__cmdStats?.speedKmh, text: window.__cmdStats?.intercept?.text }))})`);
  // Frames are 1-3 s apart under SwiftShader: press again until the boarding party is under way.
  for (let k = 0; k < 4; k++) {
    await page.keyboard.down('KeyF');
    await sleep(1500);
    await page.keyboard.up('KeyF');
    const going = await until(page, () => /abordaje|aboard/i.test(window.__cmdStats?.intercept?.text ?? '') || window.__nv.stops.some((e) => e.action === 'seized' || e.action === 'turnedBack') || null, null, 25000, 1000);
    if (going) break;
  }
  const prize = await until(page, (id) => {
    if (window.__nv.stops.some((e) => e.unitId === id && e.action === 'turnedBack')) return 'turned back';
    const u = __front.ctx.sim.view.units.get(id);
    if (u && u.owner === 1 && u.mode === 17) return 'sailing to our port under our flag';
    const d = window.__nv.prize.find((e) => e.unitId === id);
    return d ? `cargo delivered at once (+${d.gold})` : null;
  }, boardTarget || target, 300000, 2000);
  // The nearest foreign ship may be the convoy: boarded, a convoy is turned back instead.
  const seized = await until(page, (id) => window.__nv.stops.find((e) => e.unitId === id && (e.action === 'seized' || e.action === 'turnedBack')) ?? null, boardTarget || target, 60000, 1000);
  row('C3', 'F: «Abordar» — after the boarding party a merchant is ours (a prize to our port), a convoy turns back', `alongside ${near ?? '—'} m, ${seized ? `${seized.unit === 0 ? 'convoy' : 'merchant'} ${seized.action}${prize ? `, ${prize}` : ''}` : 'not boarded'}, piracy ${seized?.piracy}`, !!seized && (seized.action === 'turnedBack' || !!prize));
  await shot(page, 'c3-boarded');
  // C4: R warning shot at the convoy (at peace: the nation's opinion falls).
  const convoy = await until(page, () => {
    const s = window.__cmdStats?.intercept;
    return s?.target && s.target.kind === 'transport' && s.target.distM <= 6000 ? s.target : null;
  }, null, 240000, 1500);
  const foe = await page.evaluate((id) => __front.ctx.sim.view.units.get(id)?.owner ?? 0, convoy?.unitId ?? 0);
  const op0 = await page.evaluate((f) => __front.ctx.sim.view.opinions.get(f)?.score ?? null, foe);
  await page.keyboard.press('KeyR');
  const warned = await until(page, (id) => window.__nv.stops.find((e) => e.unitId === id && e.action === 'warned'), convoy?.unitId ?? 0, 60000, 1000);
  await sleep(4000);
  const op1 = await page.evaluate((f) => __front.ctx.sim.view.opinions.get(f)?.score ?? null, foe);
  row('C4', 'R: warning shot across the convoy\'s bow (at peace: piracy)', convoy ? `convoy at ${convoy.distM} m, warned ${!!warned}, piracy ${warned?.piracy}, opinion ${op0} → ${op1}` : 'no convoy in reach', !!warned && warned.piracy);
  // C5: X at peace asks first; Enter confirms; the convoy goes down in the sim.
  await page.keyboard.press('KeyX');
  const asked = await until(page, () => document.querySelector('.fu-cmdx-dialog.show')?.textContent ?? null, null, 20000, 500);
  await page.keyboard.press('Enter');
  const sunk = await until(page, (id) => window.__nv.stops.find((e) => e.unitId === id && e.action === 'sunk'), convoy?.unitId ?? 0, 60000, 1000);
  row('C5', 'X: «Hundir» at peace asks first, then the convoy is sunk in the sim', `asked «${(asked ?? '').slice(0, 80)}», sunk ${!!sunk} (troops ${sunk?.troops ?? 0}, piracy ${sunk?.piracy})`, !!asked && !!sunk);
  await shot(page, 'c5-sunk');
  await page.close();
}

try {
  if (!only || only.has('blockade')) await blockade();
  if (!only || only.has('port')) await port();
  if (!only || only.has('command')) await command();
} catch (e) {
  console.log(`[error] ${e?.stack ?? e}`);
  errors++;
}
await browser.close();
const fails = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - fails}/${results.length} pass, ${errors} page errors`);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exit(fails || errors ? 1 : 0);
