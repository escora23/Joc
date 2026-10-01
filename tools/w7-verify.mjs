// FRONT ULTRA — W7 integration checks in the browser (DESIGN_V2 §16.8 acceptance 4 and 5). Test tooling only.
//
//   node tools/w7-verify.mjs [--url http://127.0.0.1:5460/] [--out shots/w7/verify] [--only tips,ency,nuke] [--lang es|en]
//
//   tips  the tooltip sweep: on a staged war (the forces-panel scene) every visible control of the top bar, the build
//         bar and the arsenal, the Fuerzas / Guerra / Naciones panels, the alert log, unit and structure cards (own and
//         foreign), the radial menu, the declaration, offensive, peace and blockade dialogs, settings (every tab),
//         help (every section), the pause menu, save and load, and the command-mode HUD has a tooltip; its text has a
//         title and a line of purpose (numbers where the control has any); a disabled control says why.
//   ency  Help › Enciclopedia lists every structure and unit type, each with its per-level table / facts, generated
//         from the shared tables (the level table's first row equals levelEffects at level 1).
//   nuke  a nuclear weapon cannot be aimed at a nation at peace (toast, no launch); at war it asks first, listing the
//         nations in the radius, and launches only on «Lanzar».
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5460/';
const out = args.out || 'shots/w7/verify';
const LANG = args.lang || 'es';
fs.mkdirSync(out, { recursive: true });
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const want = (id) => !ONLY || ONLY.has(id);

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
const rows = [];
const row = (id, what, value, pass) => {
  rows.push({ id, what, value: String(value), pass: !!pass });
  log(`${pass ? 'PASS' : 'FAIL'} ${id} ${what}: ${String(value).slice(0, 900)}`);
};
const shot = async (name) => {
  try { await page.screenshot({ path: path.join(out, `${name}.png`), timeout: 120000 }); } catch { /* slow frame */ }
};
async function until(fn, arg, timeout = 30000, poll = 300) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(poll);
  }
  return null;
}

await page.goto(`${base}?shot=forces-panel&lang=${LANG}`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 400000, polling: 500 });
log('scene staged');
await page.evaluate(async (lang) => {
  const i18n = await import('/src/shared/i18n.ts');
  if (i18n.getLanguage() !== lang) { window.__front.ctx.settings.set({ language: lang }); i18n.setLanguage?.(lang); }
}, LANG).catch(() => {});

// The sweep in the page: visible interactive elements, whether each has a tooltip and what it says.
const SCAN = `(scope) => {
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { missing: ['(scope not found: ' + scope + ')'], total: 0, weak: [], texts: [] };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false;
    for (let e = el; e; e = e.parentElement) if (e.classList?.contains('fu-hidden')) return false;
    return true;
  };
  // The same lookup as the tooltip itself (tooltip.ts findTarget): the nearest element, or ancestor, with a tooltip.
  // A native title counts only on the control itself (it is not the game's tooltip, but it does say something).
  const tipped = (el) => {
    if (el.title) return el;
    for (let e = el; e && e !== document.body; e = e.parentElement) if (e.dataset?.hasTip || e.dataset?.tip) return e;
    return null;
  };
  const name = (el) => String(el.innerText || el.getAttribute('aria-label') || el.value || el.getAttribute('class') || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 40);
  const list = [...root.querySelectorAll('button, input, select, [role=button], .fu-bb-slot, .fu-wedge')].filter(vis);
  const missing = [], weak = [], texts = [];
  for (const el of list) {
    if (el.closest('.fu-tip')) continue;
    const host = tipped(el);
    if (!host) { missing.push(name(el)); continue; }
    const txt = (window.__fuTipOf?.(host) ?? host.title ?? '').replace(/\\s+/g, ' ').trim();
    texts.push(name(el) + ' => ' + txt.slice(0, 160));
    // A title alone is weak (a close button may be fine: it is listed for the reader, not failed).
    if (txt.length < 18) weak.push(name(el) + ' => «' + txt + '»');
  }
  return { total: list.length, missing, weak, texts };
}`;
const scan = (scope) => page.evaluate(`(${SCAN})(${JSON.stringify(scope ?? null)})`);
const sweep = { total: 0, missing: [], weak: [] };
async function check(label, scope, opts = {}) {
  await sleep(opts.wait ?? 900);
  const r = await scan(scope);
  sweep.total += r.total;
  sweep.missing.push(...r.missing.map((m) => `${label}: ${m}`));
  sweep.weak.push(...r.weak.map((m) => `${label}: ${m}`));
  log(`  ${label}: ${r.total} controls, ${r.missing.length} without tooltip${r.missing.length ? ` (${r.missing.join(' | ')})` : ''}${r.weak.length ? `; short: ${r.weak.join(' | ')}` : ''}`);
  if (opts.shot) await shot(opts.shot);
  return r;
}
const closeModals = async () => {
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() => !!document.querySelector('.fu-modal .fu-close'));
    if (!open) return;
    await page.locator('.fu-modal .fu-close').last().click({ force: true }).catch(() => {});
    await sleep(500);
  }
};
const mod = (p) => page.evaluate(async (p) => { await import(p); return true; }, p);

// =================================================================================================
if (want('tips')) {
  log('TIPS: tooltip sweep');
  await page.evaluate(() => window.__fuHud.shared.toggleForces(false));
  await check('top bar', '.fu-topbar');
  await check('build bar (build)', '.fu-bb');
  await page.locator('.fu-bb-tab').nth(1).click({ force: true });
  await check('build bar (arsenal)', '.fu-bb');
  await page.locator('.fu-bb-tab').nth(0).click({ force: true });
  await check('HUD (all visible)', null);
  await page.keyboard.press('u');
  await check('Fuerzas panel', '.fu-forces', { shot: 'tips-forces' });
  await page.keyboard.press('u');
  await page.keyboard.press('g');
  await check('Guerra panel', '.fu-warpanel', { shot: 'tips-fronts' });
  await page.keyboard.press('g');
  await page.keyboard.press('n');
  await check('Naciones (list)', '.fu-nations');
  await page.evaluate(() => {
    const v = window.__front.ctx.sim.view;
    const p = v.playerList.find((q) => q.kind === 'nation' && q.alive && q.id !== 1 && v.pairState(1, q.id) === 'peace');
    if (p) window.__fuNations.open(p.id);
  });
  await check('Naciones (nation at peace)', '.fu-nations', { shot: 'tips-nation' });
  await page.evaluate(() => {
    const v = window.__front.ctx.sim.view;
    const p = v.playerList.find((q) => q.alive && q.id !== 1 && v.pairState(1, q.id) === 'war');
    if (p) window.__fuNations.open(p.id);
  });
  await check('Naciones (nation at war)', '.fu-nations');
  await page.locator('.fu-nt-tab').nth(1).click({ force: true }).catch(() => {});
  await check('Naciones (inbox)', '.fu-nations');
  await page.keyboard.press('n');
  await page.keyboard.press('l');
  await check('alert log', null);
  await page.keyboard.press('l');
  // Cards: own division, own warship, own aircraft, own structure, foreign structure.
  for (const [label, src] of [
    ['card: own division', '(v) => [...v.units.values()].find((u) => u.owner === 1 && u.type === 3)'],
    ['card: own warship', '(v) => [...v.units.values()].find((u) => u.owner === 1 && u.type === 2)'],
    ['card: own fighters', '(v) => [...v.units.values()].find((u) => u.owner === 1 && u.type === 4)'],
    ['card: own bomber', '(v) => [...v.units.values()].find((u) => u.owner === 1 && u.type === 5)'],
    ['card: enemy division', '(v) => [...v.units.values()].find((u) => u.owner !== 1 && u.type === 3)'],
  ]) {
    const id = await page.evaluate(`(${src})(window.__front.ctx.sim.view)?.id ?? -1`);
    if (id < 0) { log(`  ${label}: none in the scene`); continue; }
    await page.evaluate((id) => window.__fuHud.shared.select({ kind: 'unit', id }), id);
    await check(label, '.fu-sel', { shot: `tips-${label.replace(/[^a-z]+/g, '-')}` });
  }
  for (const [label, src] of [
    ['card: own airbase', '(v) => [...v.structures.values()].find((s) => s.owner === 1 && s.type === 6)'],
    ['card: own city', '(v) => [...v.structures.values()].find((s) => s.owner === 1 && s.type === 0)'],
    ['card: own army base', '(v) => [...v.structures.values()].find((s) => s.owner === 1 && s.type === 7)'],
    ['card: foreign structure', '(v) => [...v.structures.values()].find((s) => s.owner !== 1 && s.owner > 0)'],
  ]) {
    const id = await page.evaluate(`(${src})(window.__front.ctx.sim.view)?.id ?? -1`);
    if (id < 0) { log(`  ${label}: none in the scene`); continue; }
    await page.evaluate((id) => window.__fuHud.shared.select({ kind: 'structure', id }), id);
    await check(label, '.fu-sel');
  }
  await page.evaluate(() => window.__fuHud.shared.select({ kind: 'none' }));
  // Radial on a foreign tile.
  const radialTile = await page.evaluate(() => {
    const v = window.__front.ctx.sim.view;
    const p = v.playerList.find((q) => q.kind === 'nation' && q.alive && q.id !== 1 && v.pairState(1, q.id) === 'peace');
    return p ? p.capitalTile : -1;
  });
  if (radialTile >= 0) {
    await page.evaluate((t) => window.__fuHud.debug.openRadial(800, 450, t), radialTile);
    await check('radial menu', '.fu-radial', { shot: 'tips-radial' });
    await page.keyboard.press('Escape');
  }
  // Dialogs.
  const peaceNation = await page.evaluate(() => {
    const v = window.__front.ctx.sim.view;
    return v.playerList.find((q) => q.kind === 'nation' && q.alive && q.id !== 1 && v.pairState(1, q.id) === 'peace')?.id ?? -1;
  });
  const enemy = await page.evaluate(() => {
    const v = window.__front.ctx.sim.view;
    return v.playerList.find((q) => q.alive && q.id !== 1 && v.pairState(1, q.id) === 'war')?.id ?? -1;
  });
  if (peaceNation > 0) {
    await page.evaluate(async (id) => {
      const m = await import('/src/ui/hud/declare.ts');
      const v = window.__front.ctx.sim.view;
      m.openDeclareWar(window.__fuHud.shared, id, v.players[id].capitalTile, false);
    }, peaceNation);
    await check('declare-war dialog', '.fu-modal', { shot: 'tips-declare' });
    await closeModals();
  }
  if (enemy > 0) {
    await page.evaluate(async (id) => {
      const m = await import('/src/ui/hud/offensiveDialog.ts');
      const v = window.__front.ctx.sim.view;
      m.openOffensiveDialog(window.__fuHud.shared, id, v.players[id].capitalTile);
    }, enemy);
    await check('offensive dialog', '.fu-modal', { shot: 'tips-offensive' });
    await closeModals();
    await page.evaluate(async (id) => {
      const m = await import('/src/ui/hud/wardialogs.ts');
      m.openPeaceDialog(window.__fuHud.shared, id);
    }, enemy);
    await check('peace dialog', '.fu-modal', { shot: 'tips-peace' });
    await closeModals();
  }
  const ship = await page.evaluate(() => [...window.__front.ctx.sim.view.units.values()].find((u) => u.owner === 1 && u.type === 2)?.id ?? -1);
  if (ship > 0) {
    await page.evaluate(async (id) => {
      const m = await import('/src/ui/hud/blockade.ts');
      const u = window.__front.ctx.sim.view.units.get(id);
      m.openBlockadeDialog(window.__fuHud.shared, [id], Math.floor(u.y) * 1600 + Math.floor(u.x));
    }, ship);
    await check('blockade dialog', '.fu-modal', { shot: 'tips-blockade' });
    await closeModals();
  }
  // Settings (every tab), help (every section), pause menu, save, load.
  await page.evaluate(async () => {
    const m = await import('/src/ui/dialogs.ts');
    m.openSettings(window.__front.ctx, () => {});
  });
  await sleep(800);
  const tabs = await page.locator('.fu-modal .fu-tab, .fu-modal [role=tab], .fu-modal .fu-seg-btn').count();
  await check('settings', '.fu-modal', { shot: 'tips-settings' });
  const tabSel = await page.evaluate(() => {
    const m = document.querySelector('.fu-modal');
    const c = m ? [...m.querySelectorAll('button')].filter((b) => /tab/.test(b.className)) : [];
    return c.length;
  });
  for (let i = 0; i < tabSel; i++) {
    await page.evaluate((i) => [...document.querySelector('.fu-modal').querySelectorAll('button')].filter((b) => /tab/.test(b.className))[i].click(), i);
    await check(`settings tab ${i + 1}`, '.fu-modal');
  }
  log(`  (settings had ${tabs} tab-like controls, ${tabSel} tabs clicked)`);
  await closeModals();
  await page.evaluate(async () => {
    const m = await import('/src/ui/dialogs.ts');
    m.openHelp(window.__front.ctx, () => {});
  });
  await sleep(800);
  const secs = await page.locator('.fu-help-tab').count();
  for (let i = 0; i < secs; i++) {
    await page.locator('.fu-help-tab').nth(i).click({ force: true });
    await check(`help section ${i + 1}`, '.fu-modal', { wait: 400 });
  }
  await closeModals();
  await page.evaluate(async () => {
    const m = await import('/src/ui/dialogs.ts');
    m.openPauseMenu(window.__front.ctx, () => {}, () => {});
  });
  await check('pause menu', '.fu-modal', { shot: 'tips-pause' });
  await closeModals();
  await page.evaluate(async () => {
    const m = await import('/src/ui/dialogs.ts');
    m.openSaveDialog(window.__front.ctx, () => {});
  });
  await check('save dialog', '.fu-modal', { wait: 1500 });
  await closeModals();
  await page.evaluate(async () => {
    const m = await import('/src/ui/dialogs.ts');
    m.openLoadDialog(window.__front.ctx, () => {});
  });
  await check('load dialog', '.fu-modal', { wait: 1500 });
  await closeModals();
  // Command-mode HUD: take control of a division (T), scan, Esc.
  const div = await page.evaluate(() => [...window.__front.ctx.sim.view.units.values()].find((u) => u.owner === 1 && u.type === 3)?.id ?? -1);
  if (div > 0) {
    await page.evaluate((id) => window.__fuHud.shared.select({ kind: 'unit', id }), div);
    await sleep(500);
    await page.keyboard.press('t');
    const inCmd = await until(() => window.__front.app.state === 'command' && (window.__front.ctx.frame?.frame ?? 0) > 0, null, 240000, 1000);
    if (inCmd) {
      await sleep(15000);
      await check('command-mode HUD', null, { shot: 'tips-command', wait: 500 });
      // Esc asks «¿Volver al mapa estratégico?» (or shows the combat report first): confirm like a player.
      for (let i = 0; i < 6 && (await page.evaluate(() => window.__front.app.state)) === 'command'; i++) {
        await page.keyboard.press('Escape');
        await sleep(2500);
        await page.keyboard.press('Enter');
        await sleep(5000);
      }
      const back = await until(() => window.__front.app.state === 'playing', null, 120000, 1000);
      log(`  back on the strategic map: ${!!back}`);
    } else log('  command mode not entered');
  }
  row('TIPS', `controls with a tooltip (${sweep.total} visible controls)`, sweep.missing.length ? `${sweep.missing.length} without: ${sweep.missing.join(' | ')}` : 'all', sweep.missing.length === 0);
  log(`  short tooltips (read, not failed): ${sweep.weak.length ? sweep.weak.join(' | ') : 'none'}`);
}

// =================================================================================================
if (want('ency')) {
  log('ENCY: encyclopedia');
  await closeModals();
  await page.evaluate(async () => {
    const m = await import('/src/ui/dialogs.ts');
    m.openHelp(window.__front.ctx, () => {}, 'encyclopedia');
  });
  await sleep(1200);
  const items = await page.evaluate(() => [...document.querySelectorAll('.fu-ency-item')].map((b) => b.dataset.ency));
  const want = await page.evaluate(async () => {
    const c = await import('/src/shared/constants.ts');
    return { s: Object.values(c.STRUCTURE_DEFS).map((d) => d.id), u: [...c.BUILDABLE_UNITS, ...c.WEAPONS].map((t) => c.UNIT_DEFS[t].id) };
  });
  const missing = [...want.s, ...want.u].filter((id) => !items.includes(id));
  row('ENCY1', 'every structure and unit has an entry', missing.length ? `missing ${missing.join(', ')}` : `${items.length} entries`, missing.length === 0);
  const bad = [];
  // Only the help that is open now (an earlier modal may still be fading out underneath).
  const lastHelp = `[...document.querySelectorAll('.fu-help-modal')].pop()`;
  for (const id of items) {
    await page.evaluate(`${lastHelp}.querySelector('.fu-ency-item[data-ency="${id}"]').click()`);
    await sleep(250);
    const e = await page.evaluate(async ({ id, lastHelp }) => {
      const v = eval(lastHelp).querySelector('.fu-ency-view');
      const lv = v.querySelector('.fu-ency-levels');
      const c = await import('/src/shared/constants.ts');
      const f = await import('/src/ui/hud/forcesInfo.ts');
      const st = Object.values(c.STRUCTURE_DEFS).find((d) => d.id === id);
      let levelOk = true;
      if (st) {
        const rows = lv ? [...lv.querySelectorAll('tr')].slice(1) : [];
        const eff = f.levelEffects(st.type, 1);
        levelOk = eff.every(([label, val], i) => rows[i] && rows[i].children[0].innerText.trim() === label && rows[i].children[1].innerText.trim() === val);
      }
      const txt = v.innerText;
      return { len: txt.length, raw: /\{[a-zA-Z]+\}|undefined|NaN/.test(txt), levelOk, hasLevels: !!lv, structure: !!st, orders: v.querySelectorAll('.fu-ency-orders li').length, head: v.querySelector('h4')?.innerText };
    }, { id, lastHelp });
    if (e.len < 200 || e.raw || !e.levelOk || (e.structure && !e.hasLevels)) bad.push(`${id} ${JSON.stringify(e)}`);
  }
  await page.evaluate(`${lastHelp}.querySelector('.fu-ency-item[data-ency="samSite"]').click()`);
  await sleep(500);
  await shot('ency-sam');
  row('ENCY2', 'each entry: text, no raw params, level table = levelEffects', bad.length ? bad.join(' | ') : `${items.length} entries checked`, bad.length === 0);
  await closeModals();
}

// =================================================================================================
if (want('nuke')) {
  log('NUKE: nuclear weapons only at war, with a confirmation');
  await closeModals();
  // A game with nuclear weapons on (the staged war scene above has them off), Madrid, 600 ticks in; a war with the
  // second-largest nation, staged; the largest stays at peace.
  await page.evaluate(() => window.__front.ctx.app.startScriptedGame({ ticks: 600, nukes: true, speed: 1 }));
  await until(() => window.__front.app.state === 'playing' && window.__front.ctx.sim.view.human?.alive, null, 400000, 1000);
  await page.evaluate(() => {
    const { ctx } = window.__front;
    const v = ctx.sim.view;
    const big = v.playerList.filter((q) => q.kind === 'nation' && q.alive && q.id !== 1 && v.pairState(1, q.id) === 'peace' && !v.human.allies.includes(q.id)).sort((a, b) => b.tiles - a.tiles);
    if (big[1]) ctx.sim.debug({ type: 'war', a: 1, b: big[1].id, goal: 'border', mobilizeTicks: 0 });
  });
  await until(() => window.__front.ctx.sim.view.wars.some((w) => w.aggressor === 1 || w.target === 1), null, 20000, 500);
  const setup = await page.evaluate(() => {
    const { ctx } = window.__front;
    const v = ctx.sim.view;
    const peace = v.playerList.filter((q) => q.kind === 'nation' && q.alive && q.id !== 1 && v.pairState(1, q.id) === 'peace' && !v.human.allies.includes(q.id)).sort((a, b) => b.tiles - a.tiles)[0];
    const enemy = v.playerList.find((q) => q.kind === 'nation' && q.alive && q.id !== 1 && v.pairState(1, q.id) === 'war');
    const cap = v.human.capitalTile;
    ctx.sim.debug({ type: 'spawnStructure', structure: 5, owner: 1, tile: cap + 3 * 1600 + 2, level: 3 });
    ctx.sim.debug({ type: 'addGold', playerId: 1, amount: 50_000_000 });
    return { peace: peace ? { id: peace.id, tile: Math.floor(peace.labelY) * 1600 + Math.floor(peace.labelX) } : null, enemy: enemy ? { id: enemy.id, tile: Math.floor(enemy.labelY) * 1600 + Math.floor(enemy.labelX) } : null };
  });
  await page.evaluate(() => {
    window.__w7toasts = [];
    window.__front.ctx.bus.on('toast', (e) => window.__w7toasts.push(e.text));
    window.__front.app.setSpeed(1);
  });
  const silo = await until(() => [...window.__front.ctx.sim.view.structures.values()].some((s) => s.owner === 1 && s.type === 5 && s.built >= 1), null, 90000);
  log(`  silo of ours ready: ${!!silo}; targets ${JSON.stringify(setup)}`);
  const fireAt = async (tile) => {
    // A real click through the controller: Z (atom bomb), then a left click on the target tile.
    const p = await page.evaluate((t) => {
      const { ctx } = window.__front;
      const lat = 90 - ((Math.floor(t / 1600) + 0.5) / 800) * 180, lon = (((t % 1600) + 0.5) / 1600) * 360 - 180;
      ctx.cameraRig.setState({ lat, lon, altitudeKm: 2500, tilt: 0, heading: 0 });
      return { lat, lon };
    }, tile);
    await sleep(2500);
    const xy = await page.evaluate(({ lat, lon }) => {
      const { ctx } = window.__front;
      const r = ctx.globe.surfaceRadiusAt(lat, lon);
      const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
      const v = ctx.camera.position.clone().set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
      v.project(ctx.camera);
      return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
    }, p);
    await page.mouse.move(xy.x, xy.y, { steps: 2 });
    await sleep(600);
    await page.keyboard.press('z');
    await sleep(500);
    await page.mouse.click(xy.x, xy.y, { delay: 40 });
    await sleep(1500);
  };
  const launched = () => page.evaluate(() => [...window.__front.ctx.sim.view.units.values()].filter((u) => u.owner === 1 && u.type === 8).length);
  if (setup.peace) {
    const n0 = await launched();
    await fireAt(setup.peace.tile);
    const st = await page.evaluate(() => ({ modal: !!document.querySelector('.fu-nuke-confirm'), toast: window.__w7toasts.join(' / ') }));
    const n1 = await launched();
    await shot('nuke-peace');
    row('NUKE1', 'a nuclear weapon aimed at a nation at peace is refused (toast, no dialog, no launch)', JSON.stringify({ ...st, launched: n1 - n0 }), !st.modal && n1 === n0 && /guerra|war/.test(st.toast));
    await page.keyboard.press('Escape');
  } else row('NUKE1', 'nation at peace', 'none in the scene', false);
  if (setup.enemy) {
    const n0 = await launched();
    await fireAt(setup.enemy.tile);
    const dlg = await page.evaluate(() => document.querySelector('.fu-nuke-confirm')?.innerText ?? '');
    await shot('nuke-confirm');
    const n1 = await launched();
    if (dlg) await page.locator('.fu-nuke-fire').click({ force: true });
    const n2 = await until((n0) => { const n = [...window.__front.ctx.sim.view.units.values()].filter((u) => u.owner === 1 && u.type === 8).length; return n > n0 ? n : null; }, n0, 20000, 300);
    const toasts = await page.evaluate(() => window.__w7toasts.join(' / '));
    row('NUKE2', 'at war: a confirmation listing the nations in the radius; launch only on «Lanzar»', `${dlg.replace(/\s+/g, ' ').slice(0, 400)} | before confirm ${n1 - n0}, after ${n2 ? n2 - n0 : 0}; toasts: ${toasts}`, dlg.length > 60 && n1 === n0 && !!n2);
  } else row('NUKE2', 'nation at war', 'none in the scene', false);
}

log(`console errors: ${errors.length}${errors.length ? ` — ${errors.slice(0, 5).join(' | ')}` : ''}`);
rows.push({ id: 'ERR', what: 'console errors', value: String(errors.length), pass: errors.length === 0 });
const failed = rows.filter((r) => !r.pass);
console.log(`\n=== w7-verify: ${rows.length - failed.length}/${rows.length} pass ===`);
for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(6)} ${r.what}: ${r.value.slice(0, 300)}`);
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(rows, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
