// FRONT ULTRA — the offensive dialog (owner item #23; owner: ui, W6). One deliberate action starts an offensive:
//
//   click on enemy land (or «Ofensiva…» in the Guerra panel, or «Atacar» in the radial menu) -> this dialog:
//     * where: the front and the axis point («hacia Zaragoza»), the corridor the troops will push on (never wider than
//       the front) and the time to reach the axis point at the expected speed;
//     * how much: 25 / 50 / 75 / 100 % of the home troops (the attack-force slider share preselected);
//     * how hard: Sostenida (the normal model) or Asalto total (+25 % power, +60 % own casualties); a running offensive
//       also offers Mantener la línea (halt: no push, a quarter of the casualties);
//     * the preview, recomputed as the choice changes: ratio against the enemy garrison of that front, expected
//       km/h on plains, casualties per game day on both sides and a verdict (advances / grinds / will stall and halt).
//   «Lanzar ofensiva» sends one command; the offensive then PERSISTS by itself (it never needs another click) and is
//   managed from its row in the Guerra panel (G) or its front badge: Reforzar, intensity, Detener, Retirar.
// Shift+click on enemy land skips the dialog and launches at once with the slider share (for experienced players).

import { segmented } from '../controls';
import { h, setText, toggleClass } from '../dom';
import { icon } from '../icons';
import { openModal, type ModalHandle } from '../modal';
import { tip } from '../tooltip';
import { tx } from '../tx';
import { describeXY } from '../places';
import { etaText, frontName } from './forcesInfo';
import { offensiveKmh, offensiveStatus, troopsText } from './frontsInfo';
import type { HudShared } from './shared';
import { MAP_W, TILE_KM } from '../../shared/constants';
import { formatNumber, t } from '../../shared/i18n';
import { tileKm } from '../../shared/orders';
import type { AttackView, FrontView, OffensiveIntensity } from '../../shared/types';
import { forecastOffensive, frontNearTile, runningOffensive, type OffensiveForecast } from './offensiveForecast';

const SHARES = [0.25, 0.5, 0.75, 1];

let current: ModalHandle | null = null;

/** The human's front with `enemy` nearest to tile (continuous distance to its contact line), if any. */
export function frontNear(hs: HudShared, enemy: number, tile: number): FrontView | null {
  return frontNearTile(hs.ctx.sim.view, enemy, tile);
}

/** The human's own running offensive on front `f` (not retreating). */
export function ownOffensiveOn(hs: HudShared, f: FrontView | null, enemy: number): AttackView | null {
  return runningOffensive(hs.ctx.sim.view, f, enemy);
}

/**
 * Open the offensive dialog toward `tile` (enemy land) against `enemy`. With an offensive of ours already on that
 * front it becomes the reinforcement dialog (add troops, move the axis here, change intensity).
 */
export function openOffensiveDialog(hs: HudShared, enemy: number, tile: number, opts: { sendTroops?: boolean } = {}): ModalHandle | null {
  const ctx = hs.ctx;
  const view = ctx.sim.view;
  const me = view.human;
  if (!me || tile < 0) return null;
  current?.close();
  const f = frontNear(hs, enemy, tile);
  const own0 = ownOffensiveOn(hs, f, enemy);
  // The running offensive as the sim has it NOW (troops, intensity): the preview refreshes on sim ticks while open.
  const ownNow = (): AttackView | null => (own0 ? ctx.sim.view.attacks.find((a) => a.id === own0.id && a.state !== 'retreating') ?? null : null);
  const own = own0;
  let share = SHARES.reduce((b, s) => (Math.abs(s - hs.attackRatio) < Math.abs(b - hs.attackRatio) ? s : b), SHARES[1]);
  let intensity: OffensiveIntensity = own ? own.intensity : 1;
  const tx0 = (tile % MAP_W) + 0.5, ty0 = Math.floor(tile / MAP_W) + 0.5;
  const place = describeXY(view, tx0, ty0).text;

  const where = h('div', { class: 'fu-offdlg-where' });
  const shareSeg = segmented<number>(SHARES.map((s) => ({
    value: s, label: `${Math.round(s * 100)} %`,
    tip: () => ({ title: `${Math.round(s * 100)} %`, text: t('w7.ratio.tick', { v: Math.round(s * 100), n: formatNumber(Math.floor((ctx.sim.view.human?.troops ?? 0) * s)) }) }),
  })), share, (v) => {
    share = v;
    paint();
  }, () => hs.sound('click'));
  const troopsOut = h('b', { class: 'fu-mono' });
  const intOpts: { value: OffensiveIntensity; labelKey: string; tip?: () => { title: string; text: string } }[] = own
    ? [0, 1, 2].map((v) => ({ value: v as OffensiveIntensity, labelKey: `off.int.${v}` }))
    : [1, 2].map((v) => ({ value: v as OffensiveIntensity, labelKey: `off.int.${v}` }));
  for (const o of intOpts) (o as { tip?: () => { title: string; text: string } }).tip = () => ({ title: t(o.labelKey), text: t(`off.int.${o.value}.tip`) });
  const intSeg = segmented<OffensiveIntensity>(intOpts, intensity, (v) => {
    intensity = v;
    paint();
  }, () => hs.sound('click'));
  const intHelp = h('div', { class: 'fu-offdlg-note' });
  const table = h('div', { class: 'fu-offdlg-table' });
  const verdict = h('div', { class: 'fu-offdlg-verdict' });
  const persist = h('p', { class: 'fu-offdlg-note' }, t(own ? 'off.persist.reinforce' : 'off.persist'));
  const addToggle = h('label', { class: 'fu-offdlg-add' });
  // Reinforcing: troops are optional (only the intensity may change). A click on the enemy's land with the attack
  // force set is an attack gesture: it opens with «Enviar más tropas» ticked; «Gestionar…» opens without.
  let addTroops = !own || !!opts.sendTroops;
  if (own) {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = addTroops;
    cb.addEventListener('change', () => {
      addTroops = cb.checked;
      paint();
    });
    addToggle.append(cb, h('span', null, t('off.addTroops')));
  }
  const launch = h('button', { class: 'fu-btn fu-btn--danger fu-offdlg-go' }, icon('attack'), h('span')) as HTMLButtonElement;
  const cancel = h('button', { class: 'fu-btn fu-btn--ghost' }, tx('common.cancel')) as HTMLButtonElement;
  tip(cancel, () => ({ title: t('common.cancel'), text: t('dialog.cancel.tip') }));

  const row = (k: string, v: string, cls = '') => h('div', { class: `fu-offdlg-row ${cls}` }, h('span', null, k), h('b', { class: 'fu-mono' }, v));

  function paint(): void {
    const v = ctx.sim.view;
    const home = v.human?.troops ?? 0;
    const cur = ownNow();
    // Our offensive ended while the dialog was open: what is left is a new offensive with fresh troops.
    if (own && !cur) addTroops = true;
    const send = addTroops ? Math.floor(home * share) : 0;
    const total = (cur ? cur.troops : 0) + send;
    setText(troopsOut, troopsText(send));
    toggleClass(shareSeg.el, 'is-disabled', !addTroops);
    // Gauntlet 29a: the hover, this dialog and the Guerra panel read one forecast (offensiveForecast.ts).
    const p = forecastOffensive(v, enemy, tile, send, intensity);
    const fn = f ? frontName(hs, f.key) : '';
    setText(where, t('off.where', { front: fn || t('fr.front'), place }));
    const distKm = f ? minDistKm(f, tx0, ty0) : 0;
    table.replaceChildren(
      row(t('off.row.troops'), cur ? `${troopsText(cur.troops)} + ${troopsText(send)}` : troopsText(send)),
      row(t('off.row.garrison', { name: hs.name(enemy) }), troopsText(p.garrison)),
      row(t('off.row.ratio'), `${formatNumber(p.ratio, 1)} : 1`, p.ratio >= 1.7 ? 'is-go' : p.ratio >= 1 ? 'is-risky' : 'is-bad'),
      row(t('off.row.corridor'), t('g1.off.corridor', { km: formatNumber(Math.round(p.corridorKm)), front: formatNumber(Math.round(p.frontTiles * TILE_KM)) })),
      ...speedRows(cur, p, send, distKm),
      row(t('off.row.lossOwn'), `≈ ${troopsText(p.ownLossDay)}`),
      row(t('off.row.lossEnemy'), `≈ ${troopsText(p.enemyLossDay)}`),
      row(t('off.row.air'), t(p.air > 0 ? 'off.air.own' : p.air < 0 ? 'off.air.their' : 'off.air.none', { own: p.casOwn, their: p.casTheir }), p.air > 0 ? 'is-go' : p.air < 0 ? 'is-bad' : ''),
    );
    if (p.saturated && p.verdict !== 'hold') table.append(h('div', { class: 'fu-offdlg-row fu-offdlg-limit' }, h('span', null, limitText(p))));
    if (p.startsInTicks > 10) table.append(row(t('off.row.starts'), etaText(hs, p.startsInTicks, false)));
    setText(verdict, t(`off.verdict.${p.verdict}`, { name: hs.name(enemy) }));
    verdict.className = `fu-offdlg-verdict is-${p.verdict}`;
    setText(intHelp, t(`off.int.${intensity}.tip`));
    const noop = cur && !addTroops && intensity === cur.intensity;
    setText(launch.querySelector('span')!, t(cur ? 'off.go.reinforce' : 'off.go'));
    launch.disabled = (!cur && send < 1) || !!noop;
  }

  /**
   * Feedback 3 (29a): a running offensive shows the km/h the badge and the Guerra panel show (measured) and what the
   * reinforcement / intensity change would make of it; a new offensive shows the forecast on that ground (terrain
   * included), never a plains figure.
   */
  function speedRows(cur: AttackView | null, p: OffensiveForecast, send: number, distKm: number): HTMLElement[] {
    const kmhTxt = (k: number) => (k > 0.05 ? t('g1.off.kmh', { v: formatNumber(k, 1), ground: t(`g1.ground.${p.ground}`) }) : t('off.kmh0'));
    if (!cur) {
      return [
        row(t('off.row.speed'), kmhTxt(p.kmh)),
        row(t('off.row.eta'), p.kmh > 0.2 && distKm > 0 ? etaText(hs, Math.round((distKm / p.kmh) * 10), false) : '—'),
      ];
    }
    const v = ctx.sim.view;
    const now = p.nowKmh >= 0 ? p.nowKmh : offensiveKmh(v, cur);
    const out = [
      row(t('off.row.now'), offensiveStatus(v, cur, now, 1, false)),
      row(t('off.row.support'), t('off.support', { d: cur.divAtk ?? 0, c: cur.casAtk ?? 0, n: cur.navalAtk ?? 0 })),
    ];
    const changed = send > 0 || intensity !== cur.intensity;
    if (changed) out.push(row(t('off.row.next'), p.kmh > 0.05 ? `≈ ${formatNumber(p.kmh, 1)} km/h` : t('off.kmh0'), p.kmh > now + 0.05 ? 'is-go' : ''));
    const k = changed ? p.kmh : now;
    out.push(row(t('off.row.eta'), k > 0.2 && distKm > 0 ? etaText(hs, Math.round((distKm / k) * 10), false) : '—'));
    return out;
  }

  /** Why more troops add no speed: the ratio is past 3 : 1 and the ground sets the pace. */
  function limitText(p: OffensiveForecast): string {
    const cap = formatNumber(Math.max(0.1, p.capKmh), 1);
    return t(p.ground === 'plains' ? 'g1.off.limit.plains' : 'g1.off.limit.ground', { limit: t(`g1.limitBy.${p.ground}`), cap });
  }

  launch.addEventListener('click', () => {
    const v = ctx.sim.view;
    const home = v.human?.troops ?? 0;
    const cur = ownNow();
    if (cur) {
      if (addTroops) ctx.sim.send({ type: 'attack', target: enemy, ratio: share, tile, intensity });
      else if (intensity !== cur.intensity) ctx.sim.send({ type: 'offensiveIntensity', attackId: cur.id, intensity });
      ctx.bus.emit('toast', { text: t('off.toast.reinforce', { name: hs.name(enemy) }), kind: 'info', durationMs: 3000 });
    } else {
      ctx.sim.send({ type: 'attack', target: enemy, ratio: share, tile, intensity });
      ctx.bus.emit('toast', { text: t('off.toast.launch', { n: troopsText(Math.floor(home * share)), name: hs.name(enemy), place }), kind: 'info', durationMs: 3600 });
    }
    hs.setAttackRatio(share);
    hs.sound('confirm');
    handle.close();
  });
  cancel.addEventListener('click', () => handle.close());
  tip(launch, () => ({ title: t(own ? 'off.go.reinforce' : 'off.go'), text: t('off.go.tip') }));

  const body = [
    where,
    h('div', { class: 'fu-offdlg-field' }, h('span', { class: 'fu-offdlg-k' }, tx('off.commit')), own ? addToggle : null, shareSeg.el, troopsOut),
    h('div', { class: 'fu-offdlg-field' }, h('span', { class: 'fu-offdlg-k' }, tx('off.intensity')), intSeg.el),
    intHelp,
    table,
    verdict,
    persist,
  ];
  const handle = openModal({
    titleKey: own ? 'off.title.reinforce' : 'off.title', titleParams: { name: hs.name(enemy) }, kickerKey: 'off.kicker',
    body, foot: [cancel, launch], narrow: true, className: 'fu-offdlg',
    onClose: () => {
      offTick();
      if (current === handle) current = null;
      ctx.bus.emit('offensivePreview', { tile: -1, frontageTiles: 0, ratio: 0, valid: false });
    },
  });
  current = handle;
  paint();
  // While open, the preview follows the running game (home troops, the offensive's troops and the enemy garrison
  // change every tick): repainted at most twice a real second on sim ticks.
  let lastPaint = 0;
  const offTick = ctx.bus.on('simTick', () => {
    const now = performance.now();
    if (now - lastPaint < 500) return;
    lastPaint = now;
    paint();
  });
  // The corridor preview stays drawn on the map while the dialog is open.
  const p0 = forecastOffensive(view, enemy, tile, addTroops ? Math.floor((view.human?.troops ?? 0) * share) : 0, intensity);
  ctx.bus.emit('offensivePreview', { tile, frontageTiles: p0.corridorKm / TILE_KM, ratio: p0.ratio, valid: true });
  return handle;
}

function minDistKm(f: FrontView, x: number, y: number): number {
  let d = Infinity;
  const s = f.samples;
  for (let i = 0; i < s.length >> 1; i++) d = Math.min(d, tileKm(x, y, s[i * 2] + f.dirX * 0.5, s[i * 2 + 1] + f.dirY * 0.5));
  return Number.isFinite(d) ? d : 0;
}

