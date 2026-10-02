// Owner item 31 browser verifier: in command mode, firing on a nation at peace is asked BEFORE any round leaves the
// barrel, «No disparar» really means no shot, merchants at peace follow the piracy model, and the warship can order a
// blockade without leaving command mode. Real game in Chromium (SwiftShader) on real staged sims, driven through the
// real controls (mouse trigger, keys), measured numerically.
//   node tools/f31-verify.mjs [--url http://127.0.0.1:5462/] [--out shots/owner-31/verify] [--only ship,tank]
//
// ship   warship with a merchant and a troop convoy of a nation at peace alongside (?shot=command-merchant&live=1):
//        B1  B opens the item-30 blockade dialog over command mode; confirming it gives our ship a blockade and the
//            player keeps the helm (the sim unit stays under command)
//        M1  trigger on the merchant: the piracy question opens and nothing fired (no shell, flash, sound, splash,
//            ammo spent)
//        M2  Enter = «No disparar»: still nothing fired, no damage, the dialog closed
//        M3  trigger kept down through the answer: no automatic re-fire and no repeated question; released and idle: no dialog
//        M4  a round already in the air through the merchant: no hit, no damage, no question
//        M5  a new click on purpose asks again; Esc = «No disparar» too
//        M6  «Disparo de advertencia» (R): the sim's warned event (piracy) — the same command as the stop panel
//        M7  «Hundir» (X): the merchant goes down in the sim as piracy, opinion −20 (the stop panel's numbers)
//        M8  convoy: «Declarar la guerra» (G): war is declared
//        M9  at war the trigger fires at once on the convoy (no question)
// tank   tank with the neighbour's patrol (incursion ignored, ?shot=command-escort&live=1):
//        T1  trigger on a patrol vehicle at peace: the question opens and nothing fired
//        T2  Enter = «No disparar»: still nothing fired, no damage, no repeat
//        T3  a new click, G = «Declarar la guerra»: war declared, then the trigger fires
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5462/';
const out = args.out || 'shots/owner-31/verify';
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
  page.on('console', (m) => { if (/\[command\] (fire|piracy|war declared|blockade)/.test(m.text())) console.log(`   ${m.text().slice(0, 200)}`); });
  await page.goto(`${base}?shot=${shot}${params}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
  await page.waitForTimeout(1500);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), timeout: 300000 }).catch((e) => console.log(`   (screenshot ${name} failed: ${String(e?.message ?? e).split('\n')[0]})`));
async function until(page, fn, arg, ms = 30000, every = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}

/** Count what a shot leaves behind (muzzle flashes, gun sounds, explosions, rounds), wrapping the effects. */
async function instrument(page) {
  await page.evaluate(() => {
    const I = window.__cmd, fx = I.fx;
    const c = (window.__f31 = { muzzle: 0, flash: 0, sounds: 0, expl: 0, events: [] });
    for (const [k, key] of [['muzzle', 'muzzle'], ['gunFlash', 'flash'], ['explosion', 'expl']]) {
      const f = fx[k].bind(fx);
      fx[k] = (...a) => { c[key]++; return f(...a); };
    }
    const snd = fx.hooks.sound;
    fx.hooks.sound = (cue, g) => { if (/Gun|Cannon|gunfire|navalGun|tankCannon|jetCannon|missileLaunch/i.test(cue)) c.sounds++; return snd(cue, g); };
    const bus = __front.ctx.bus;
    bus.on('shipStopped', (e) => c.events.push({ t: 'stopped', action: e.action, unitId: e.unitId, piracy: e.piracy }));
    bus.on('warDeclared', (e) => c.events.push({ t: 'war', a: e.aggressor ?? e.attacker ?? e.a, b: e.target ?? e.defender ?? e.b }));
  });
}
/** Everything a shot would change: rounds fired, live rounds, effects, the main ammo, the target's hp. */
const snap = (page, entId) => page.evaluate((id) => {
  const I = window.__cmd, w = I.world, c = window.__f31;
  const e = w.ents.find((x) => x.id === id);
  const main = I.controller?.hud?.weapons?.[0];
  return {
    shots: w.stats.shots, hits: w.stats.hits, live: w.projs.filter((p) => p.alive && p.team === 0).length, muzzle: c.muzzle, flash: c.flash, sounds: c.sounds, expl: c.expl,
    ammo: main?.count ?? -1, hp: e ? +e.hp.toFixed(2) : null, alive: !!e?.alive, dialog: I.overlay.dialogOpen, fire: I.fire(),
  };
}, entId);
const same = (a, b) => a.shots === b.shots && a.live === b.live && a.muzzle === b.muzzle && a.flash === b.flash && a.sounds === b.sounds && a.expl === b.expl && a.ammo === b.ammo && a.hp === b.hp;
const brief = (s) => `rounds ${s.shots}, live ${s.live}, flashes ${s.muzzle + s.flash}, gun sounds ${s.sounds}, explosions ${s.expl}, ammo ${s.ammo}, target hp ${s.hp}`;

/** Aim the controlled vehicle's gun at an entity (as the player would with the mouse) and wait for the gun to load. */
async function aim(page, entId, dy = 3) {
  await page.evaluate(([id, dy]) => {
    const I = window.__cmd, c = I.controller;
    const e = I.world.ents.find((x) => x.id === id);
    if (!e) return;
    c.aimAt(e.pos.clone().setY(e.pos.y + dy));
    c.snapTurret?.();
  }, [entId, dy]);
  await until(page, () => (window.__cmd.controller?.hud?.reload ?? 0) >= 0.999, null, 120000, 500);
  await page.evaluate(([id, dy]) => {
    const I = window.__cmd, c = I.controller;
    const e = I.world.ents.find((x) => x.id === id);
    if (e) { c.aimAt(e.pos.clone().setY(e.pos.y + dy)); c.snapTurret?.(); }
  }, [entId, dy]);
  await sleep(1200);
}
/** A real click of the trigger (mouse button 0 on the view). */
async function trigger(page, holdMs = 900) {
  await page.mouse.move(800, 450);
  await page.mouse.down();
  await sleep(holdMs);
  await page.mouse.up();
}
const dialogText = (page) => page.evaluate(() => window.__cmd.fire().dialog);
/** Press a key so that at least one frame sees it (SwiftShader frames are 1-3 s apart). */
async function key(page, code) {
  await page.keyboard.down(code);
  await sleep(1500);
  await page.keyboard.up(code);
}

// ---------------------------------------------------------------------------------------------------------------
async function ship() {
  const page = await open('command-merchant', '&live=1');
  await page.evaluate(() => window.__cmd?.skipIntro?.());
  await until(page, () => window.__cmdStats?.phase === 'play' && window.__cmdStats?.intercept?.target, null, 240000, 1000);
  await instrument(page);
  const unitId = await page.evaluate(() => window.__cmd.params.unitId);

  // B1: «Bloquear esta zona» from the warship.
  await key(page, 'KeyB');
  const dlg = await until(page, () => window.__fuBlockade?.current?.() ? { place: window.__fuBlockade.current().place, text: window.__fuBlockade.current().text().slice(0, 160) } : null, null, 30000, 500);
  const paused = await page.evaluate(() => window.__cmdStats?.fire?.blockadeOpen && window.__cmdStats?.decision);
  await shot(page, 'b1-blockade-dialog');
  await page.evaluate(() => window.__fuBlockade.current()?.confirm());
  const blk = await until(page, (id) => __front.ctx.sim.view.blockades.find((b) => !b.endTick && b.warships.includes(id)) ?? null, unitId, 60000, 1000);
  await sleep(4000);
  const after = await page.evaluate((id) => ({ state: __front.ctx.sim.view.units.get(id)?.state, controlled: __front.ctx.sim.view.command?.controlled?.map((c) => c.unitId ?? c) ?? null, phase: window.__cmdStats?.phase, notice: window.__cmd.overlay.noticeText, decision: window.__cmdStats?.decision }), unitId);
  row('B1', '«Bloquear esta zona» (B) opens the item-30 blockade dialog over command mode; confirmed, our ship holds a blockade and the player keeps the helm',
    `dialog ${dlg ? `«${dlg.place}»` : 'none'} (clock held ${!!paused}); blockade ${blk ? `${blk.kind} ${blk.key || ''} active ${blk.active} onStation ${blk.onStation}` : 'none'}; after: ${JSON.stringify(after)}`,
    !!dlg && !!blk && after.phase === 'play' && !after.decision);
  await shot(page, 'b1-blockade-on');

  // The merchant (Tab until the panel names it).
  for (let k = 0; k < 4; k++) {
    if (await page.evaluate(() => window.__cmdStats?.intercept?.target?.kind === 'merchant')) break;
    await key(page, 'Tab');
    await sleep(2000);
  }
  const m = await page.evaluate(() => {
    const I = window.__cmd, id = window.__cmdStats?.intercept?.target?.unitId;
    const e = I.world.ents.find((x) => x.alive && x.src?.id === id && x.kind === 'merchant') ?? I.world.ents.find((x) => x.alive && x.kind === 'merchant');
    return e ? { id: e.id, unit: e.src?.id ?? 0, nation: e.nation, neutral: e.neutral, dist: Math.round(e.pos.distanceTo(I.controller.ent.pos)) } : null;
  });
  if (!m) {
    row('M1', 'a merchant at peace to fire on', 'none in the scene', false);
    await page.close();
    return;
  }
  const foe = m.nation;
  const op = () => page.evaluate((f) => __front.ctx.sim.view.opinions.get(f)?.score ?? null, foe);

  // M1: the trigger on the merchant, pressed and kept down (as a player holding the trigger would).
  await aim(page, m.id);
  const s0 = await snap(page, m.id);
  await page.mouse.move(800, 450);
  await page.mouse.down();
  const asked = await until(page, () => window.__cmd.overlay.dialogOpen ? window.__cmd.fire().dialog : null, null, 30000, 300);
  const s1 = await snap(page, m.id);
  row('M1', 'trigger on a merchant at peace: the piracy question opens before the shot, nothing fired', `«${(asked ?? 'no dialog').slice(0, 260)}»; before ${brief(s0)}; now ${brief(s1)}`,
    !!asked && /pirater/i.test(asked) && /advertencia/i.test(asked) && /Abordar/i.test(asked) && /Hundir/i.test(asked) && /Declarar la guerra/i.test(asked) && /No disparar/i.test(asked) && same(s0, s1));
  await shot(page, 'm1-piracy-question');

  // M2: Enter = «No disparar» (the trigger still held down).
  await key(page, 'Enter');
  await sleep(3000);
  const s2 = await snap(page, m.id);
  row('M2', 'Enter is «No disparar»: nothing fired, no splash, no ammo spent, no damage, dialog closed', brief(s2), same(s0, s2) && !s2.dialog && s2.fire.answers.at(-1) === 'hold');

  // M3: the trigger kept down after that: no automatic re-fire, no repeated question; released and idle: nothing.
  await sleep(6000);
  const s3a = await snap(page, m.id);
  await page.mouse.up();
  await sleep(6000);
  const s3 = await snap(page, m.id);
  row('M3', 'trigger kept down after «No»: no automatic re-fire, no repeated dialog; released and idle: still nothing', `held 9 s more: ${brief(s3a)}, dialog ${s3a.dialog}; idle 6 s: dialog ${s3.dialog}, asked ${s1.fire.asked} → ${s3.fire.asked}`,
    same(s0, s3a) && same(s0, s3) && !s3a.dialog && !s3.dialog && s3.fire.asked === s1.fire.asked);

  // M4: a round already in the air (fired before) that the merchant is in the way of: no hit, no damage, no question.
  const s4a = await snap(page, m.id);
  await page.evaluate((id) => {
    const I = window.__cmd, P = I.controller.ent, e = I.world.ents.find((x) => x.id === id);
    const from = P.pos.clone().setY(18), to = e.pos.clone().setY(e.pos.y + 4);
    const dir = to.sub(from).normalize();
    I.world.fireShell(P, 0, from, dir, 820, 55, 11, false, true, 1.8);
  }, m.id);
  await sleep(8000);
  const s4 = await snap(page, m.id);
  row('M4', 'a round already in the air through the merchant: no hit, no damage, no question', `hits ${s4a.hits} → ${s4.hits}, hp ${s4a.hp} → ${s4.hp}, alive ${s4.alive}, dialog ${s4.dialog}, asked ${s4a.fire.asked} → ${s4.fire.asked}`,
    s4.hits === s4a.hits && s4.hp === s4a.hp && s4.alive && !s4.dialog && s4.fire.asked === s4a.fire.asked);

  // M5: a new click on purpose asks again; Esc is «No disparar» too.
  await aim(page, m.id);
  const s5a = await snap(page, m.id);
  await trigger(page);
  const asked5 = await until(page, () => window.__cmd.overlay.dialogOpen, null, 30000, 300);
  await page.keyboard.press('Escape');
  await sleep(4000);
  const s5 = await snap(page, m.id);
  row('M5', 'a new click on purpose asks again; Esc is «No disparar» (nothing fired)', `asked ${!!asked5} (${s5a.fire.asked} → ${s5.fire.asked}), answer ${s5.fire.answers.at(-1)}, ${brief(s5)}`,
    !!asked5 && s5.fire.asked === s5a.fire.asked + 1 && same(s5a, s5) && !s5.dialog && s5.fire.answers.at(-1) === 'hold');

  // M6: «Disparo de advertencia» (R).
  await aim(page, m.id);
  await trigger(page);
  await until(page, () => window.__cmd.overlay.dialogOpen, null, 30000, 300);
  const op6a = await op();
  await key(page, 'KeyR');
  const warned = await until(page, (u) => window.__f31.events.find((e) => e.t === 'stopped' && e.unitId === u && e.action === 'warned') ?? null, m.unit, 60000, 1000);
  await sleep(3000);
  const op6 = await op();
  const hp6 = (await snap(page, m.id)).hp;
  row('M6', '«Disparo de advertencia» (R): no damage, the ship heaves to; the sim\'s warned event as piracy (the stop panel\'s command)', `warned ${!!warned} piracy ${warned?.piracy}; opinion ${op6a} → ${op6}; hp ${s0.hp} → ${hp6}`,
    !!warned && warned.piracy === true && hp6 === s0.hp);

  // M7: «Hundir» (X).
  await aim(page, m.id);
  await trigger(page);
  await until(page, () => window.__cmd.overlay.dialogOpen, null, 30000, 300);
  const op7a = await op();
  await shot(page, 'm7-before-sink');
  await key(page, 'KeyX');
  const sunk = await until(page, (u) => window.__f31.events.find((e) => e.t === 'stopped' && e.unitId === u && e.action === 'sunk') ?? null, m.unit, 60000, 1000);
  await sleep(4000);
  const op7 = await op();
  const reasons = await page.evaluate((f) => (__front.ctx.sim.view.opinions.get(f)?.reasons ?? []).map((r) => `${r.key ?? r.reason ?? ''}:${r.value ?? r.delta ?? ''}`).join(', '), foe);
  row('M7', '«Hundir» (X): it goes down in the sim as piracy, with the stop panel\'s opinion cost (−20 per sinking, capped)', `sunk ${!!sunk} piracy ${sunk?.piracy}; opinion ${op7a} → ${op7}; reasons ${reasons.slice(0, 200)}`,
    !!sunk && sunk.piracy === true && (op7 === null || op7a === null || op7 <= op7a));
  await shot(page, 'm7-sunk');

  // M8: the convoy — «Declarar la guerra» (G).
  const cv = await page.evaluate(() => {
    const I = window.__cmd;
    const e = I.world.ents.find((x) => x.alive && x.kind === 'transport');
    return e ? { id: e.id, unit: e.src?.id ?? 0, nation: e.nation, dist: Math.round(e.pos.distanceTo(I.controller.ent.pos)) } : null;
  });
  if (cv) {
    await aim(page, cv.id);
    const s8a = await snap(page, cv.id);
    await trigger(page);
    const asked8 = await until(page, () => window.__cmd.overlay.dialogOpen ? window.__cmd.fire().dialog : null, null, 30000, 300);
    await key(page, 'KeyG');
    const war = await until(page, (f) => __front.ctx.sim.view.pairState(1, f) === 'war', cv.nation, 60000, 1000);
    const s8 = await snap(page, cv.id);
    row('M8', 'convoy: «Declarar la guerra» (G) declares war (and nothing fired on the way)', `asked «${(asked8 ?? '').slice(0, 80)}»; war ${!!war}; ${brief(s8)}`, !!asked8 && !!war && same(s8a, s8));
    // M9: at war the trigger fires at once.
    await sleep(3000);
    await aim(page, cv.id);
    const s9a = await snap(page, cv.id);
    await trigger(page);
    await sleep(6000);
    const s9 = await snap(page, cv.id);
    row('M9', 'at war the trigger fires at once on the convoy (no question)', `rounds ${s9a.shots} → ${s9.shots}, asked ${s9a.fire.asked} → ${s9.fire.asked}, dialog ${s9.dialog}`, s9.shots > s9a.shots && s9.fire.asked === s9a.fire.asked && !s9.dialog);
    await shot(page, 'm9-war-fire');
  } else row('M8', 'a convoy to declare war on', 'none in the scene', false);
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
async function tank() {
  const page = await open('command-escort', '&live=1');
  await page.evaluate(() => window.__cmd?.skipIntro?.());
  await until(page, () => window.__cmdStats?.phase === 'play', null, 240000, 1000);
  await instrument(page);
  const q = await until(page, () => {
    const I = window.__cmd, P = I.controller.ent;
    const qs = I.world.ents.filter((e) => e.alive && e.neutral && e.src?.kind === 'qrf' && e.kind !== 'soldier').sort((a, b) => a.pos.distanceTo(P.pos) - b.pos.distanceTo(P.pos));
    return qs[0] ? { id: qs[0].id, nation: qs[0].nation, kind: qs[0].kind, dist: Math.round(qs[0].pos.distanceTo(P.pos)) } : null;
  }, null, 240000, 1500);
  if (!q) {
    row('T1', 'a patrol vehicle of a nation at peace near the tank', 'none', false);
    await page.close();
    return;
  }
  await aim(page, q.id, 1.5);
  const s0 = await snap(page, q.id);
  await page.mouse.move(800, 450);
  await page.mouse.down();
  const asked = await until(page, () => window.__cmd.overlay.dialogOpen ? window.__cmd.fire().dialog : null, null, 30000, 300);
  const s1 = await snap(page, q.id);
  row('T1', `tank trigger on the neighbour's patrol (${q.kind} at ${q.dist} m, at peace): asked before the shot, nothing fired`, `«${(asked ?? 'no dialog').slice(0, 220)}»; ${brief(s1)}`,
    !!asked && /Declarar la guerra/i.test(asked) && /No disparar/i.test(asked) && same(s0, s1));
  await shot(page, 't1-question');
  await key(page, 'Enter');
  await sleep(5000);
  await page.mouse.up();
  await sleep(5000);
  const s2 = await snap(page, q.id);
  row('T2', 'Enter = «No disparar»: nothing fired, no damage, no repeated question (trigger held 5 s, then idle 5 s)', `${brief(s2)}; dialog ${s2.dialog}; asked ${s1.fire.asked} → ${s2.fire.asked}`, same(s0, s2) && !s2.dialog && s2.fire.asked === s1.fire.asked);
  // T3: on purpose again, G = war; then it fires.
  await aim(page, q.id, 1.5);
  await trigger(page);
  await until(page, () => window.__cmd.overlay.dialogOpen, null, 30000, 300);
  await key(page, 'KeyG');
  const war = await until(page, (f) => __front.ctx.sim.view.pairState(1, f) === 'war', q.nation, 60000, 1000);
  await sleep(2000);
  await aim(page, q.id, 1.5);
  const s3a = await snap(page, q.id);
  await trigger(page);
  await sleep(5000);
  const s3 = await snap(page, q.id);
  row('T3', 'a new click, G = «Declarar la guerra»: war declared; then the trigger fires', `war ${!!war}; rounds ${s3a.shots} → ${s3.shots}; asked ${s3a.fire.asked} → ${s3.fire.asked}`, !!war && s3.shots > s3a.shots && s3.fire.asked === s3a.fire.asked);
  await shot(page, 't3-war-fire');
  await page.close();
}

try {
  if (!only || only.has('ship')) await ship();
  if (!only || only.has('tank')) await tank();
} catch (e) {
  console.log(`[error] ${e?.stack ?? e}`);
  errors++;
}
await browser.close();
const fails = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - fails}/${results.length} pass, ${errors} page errors`);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exit(fails || errors ? 1 : 0);
