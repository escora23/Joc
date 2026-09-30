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
import { etaText, frontName, outlookOf } from './forcesInfo';
import { offensiveKmh, offensiveStatus, troopsText } from './frontsInfo';
import type { HudShared } from './shared';
import {
  AIR_DENIAL_ADVANCE_MUL, AIR_SUPERIORITY_ADVANCE_MUL, DRONE_ADVANCE_MUL, DRONE_ENEMY_ADVANCE_MUL, ENGAGEMENT_RATE, HUMAN_ID, MAP_W,
  TICKS_PER_GAME_DAY, TILE_KM,
} from '../../shared/constants';
import { formatNumber, t } from '../../shared/i18n';
import { advanceKmh as advanceAt, offensiveOutlook, predictOffensive, tileKm } from '../../shared/orders';
import type { AttackView, FrontView, OffensiveIntensity } from '../../shared/types';
import { viewRules } from '../../sim/rulesView';

const SHARES = [0.25, 0.5, 0.75, 1];
/** Intensity rules as the sim applies them (sim/attacks.ts): shown in the preview so the numbers agree. */
const ASSAULT_POWER = 1.25, ASSAULT_OWN_LOSS = 1.6, ASSAULT_ENEMY_LOSS = 1.2, HOLD_ENGAGEMENT = 0.25;

let current: ModalHandle | null = null;

/** The human's front with `enemy` nearest to tile (continuous distance to its contact line), if any. */
export function frontNear(hs: HudShared, enemy: number, tile: number): FrontView | null {
  const v = hs.ctx.sim.view;
  const tx0 = (tile % MAP_W) + 0.5, ty0 = Math.floor(tile / MAP_W) + 0.5;
  let best: FrontView | null = null, bd = Infinity;
  for (const f of v.fronts) {
    if (!((f.a === HUMAN_ID && f.b === enemy) || (f.b === HUMAN_ID && f.a === enemy))) continue;
    const s = f.samples;
    for (let i = 0; i < s.length >> 1; i++) {
      const d = tileKm(tx0, ty0, s[i * 2], s[i * 2 + 1]);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
  }
  return best;
}

/** The human's own running offensive on front `f` (not retreating). */
export function ownOffensiveOn(hs: HudShared, f: FrontView | null, enemy: number): AttackView | null {
  const v = hs.ctx.sim.view;
  return v.attacks.find((a) => a.attacker === HUMAN_ID && a.defender === enemy && a.id > 0 && !a.naval && a.state !== 'retreating'
    && (f ? a.frontKey === f.key : true)) ?? null;
}

export interface OffensivePreview {
  troops: number;
  garrison: number;
  ratio: number;
  kmh: number;
  corridorKm: number;
  ownLossDay: number;
  enemyLossDay: number;
  verdict: 'advance' | 'grind' | 'stall' | 'hold';
  startsInTicks: number;
  /** #25: the sky over that front (1 ours, -1 theirs, 0 contested / none) and the drone swarms supporting each side. */
  air: number;
  casOwn: number;
  casTheir: number;
}

/** What an offensive (or a reinforcement) of `troops` at `intensity` would do on the front nearest `tile`. */
export function previewOffensive(hs: HudShared, enemy: number, tile: number, troops: number, intensity: OffensiveIntensity): OffensivePreview {
  const r = viewRules(hs.ctx.sim.view);
  const pr = predictOffensive(r, HUMAN_ID, enemy, troops, tile);
  const G = Math.max(1, pr.garrison);
  // #25: the aircraft already over that front count as the sim counts them (attacks.ts): the side with more fighters
  // on patrol owns the sky (+10 % / −10 % speed) and cancels the other side's drones (+15 % power and speed each).
  const f = frontNear(hs, enemy, tile);
  const side = f ? (f.a === HUMAN_ID ? 0 : 1) : 0;
  const airOwn = f ? (side === 0 ? f.airA : f.airB) ?? 0 : 0, airTheir = f ? (side === 0 ? f.airB : f.airA) ?? 0 : 0;
  const air = airOwn > airTheir ? 1 : airTheir > airOwn ? -1 : 0;
  const casOwn = f && air >= 0 ? (side === 0 ? f.casA : f.casB) ?? 0 : 0;
  const casTheir = f && air <= 0 ? (side === 0 ? f.casB : f.casA) ?? 0 : 0;
  const ratio = (troops / G) * (intensity === 2 ? ASSAULT_POWER : 1) * (casOwn > 0 ? DRONE_ADVANCE_MUL : 1);
  let kmh = intensity === 0 ? 0 : advanceAt(ratio);
  if (casOwn > 0) kmh *= DRONE_ADVANCE_MUL;
  if (casTheir > 0) kmh *= DRONE_ENEMY_ADVANCE_MUL;
  if (air > 0) kmh *= AIR_SUPERIORITY_ADVANCE_MUL;
  if (air < 0) kmh *= AIR_DENIAL_ADVANCE_MUL;
  // Casualties per tick (§4.6), in troops: E = rate × min(Pa, Pd); the attacker loses E·√(Pd/Pa), the defender E·√(Pa/Pd).
  const Pa = troops * (intensity === 2 ? ASSAULT_POWER : 1), Pd = G;
  const E = ENGAGEMENT_RATE * Math.min(Pa, Pd) * (intensity === 0 ? HOLD_ENGAGEMENT : 1);
  const ownPow = E * Math.sqrt(Pd / Math.max(1, Pa)) * (intensity === 2 ? ASSAULT_OWN_LOSS : 1);
  const enemyPow = E * Math.sqrt(Pa / Pd) * (intensity === 2 ? ASSAULT_ENEMY_LOSS : 1);
  const ownLossDay = Math.min(troops, (ownPow * troops) / Math.max(1, Pa)) * TICKS_PER_GAME_DAY;
  const enemyLossDay = enemyPow * TICKS_PER_GAME_DAY;
  const verdict = intensity === 0 ? 'hold' : ratio >= 1.7 ? 'advance' : ratio >= 1 ? 'grind' : 'stall';
  return { troops, garrison: pr.garrison, ratio, kmh, corridorKm: pr.frontageTiles * TILE_KM, ownLossDay, enemyLossDay, verdict, startsInTicks: pr.startsInTicks, air, casOwn, casTheir };
}

/**
 * Open the offensive dialog toward `tile` (enemy land) against `enemy`. With an offensive of ours already on that
 * front it becomes the reinforcement dialog (add troops, move the axis here, change intensity).
 */
export function openOffensiveDialog(hs: HudShared, enemy: number, tile: number): ModalHandle | null {
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
  const shareSeg = segmented<number>(SHARES.map((s) => ({ value: s, label: `${Math.round(s * 100)} %` })), share, (v) => {
    share = v;
    paint();
  }, () => hs.sound('click'));
  const troopsOut = h('b', { class: 'fu-mono' });
  const intOpts: { value: OffensiveIntensity; labelKey: string }[] = own
    ? [{ value: 0, labelKey: 'off.int.0' }, { value: 1, labelKey: 'off.int.1' }, { value: 2, labelKey: 'off.int.2' }]
    : [{ value: 1, labelKey: 'off.int.1' }, { value: 2, labelKey: 'off.int.2' }];
  const intSeg = segmented<OffensiveIntensity>(intOpts, intensity, (v) => {
    intensity = v;
    paint();
  }, () => hs.sound('click'));
  const intHelp = h('div', { class: 'fu-offdlg-note' });
  const table = h('div', { class: 'fu-offdlg-table' });
  const verdict = h('div', { class: 'fu-offdlg-verdict' });
  const persist = h('p', { class: 'fu-offdlg-note' }, t(own ? 'off.persist.reinforce' : 'off.persist'));
  const addToggle = h('label', { class: 'fu-offdlg-add' });
  // Reinforcing: troops are optional (only the intensity may change).
  let addTroops = !own;
  if (own) {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = false;
    cb.addEventListener('change', () => {
      addTroops = cb.checked;
      paint();
    });
    addToggle.append(cb, h('span', null, t('off.addTroops')));
  }
  const launch = h('button', { class: 'fu-btn fu-btn--danger fu-offdlg-go' }, icon('attack'), h('span')) as HTMLButtonElement;
  const cancel = h('button', { class: 'fu-btn fu-btn--ghost' }, tx('common.cancel')) as HTMLButtonElement;

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
    const p = previewOffensive(hs, enemy, tile, Math.max(1, total), intensity);
    const fn = f ? frontName(hs, f.key) : '';
    setText(where, t('off.where', { front: fn || t('fr.front'), place }));
    const distKm = f ? minDistKm(f, tx0, ty0) : 0;
    table.replaceChildren(
      row(t('off.row.troops'), cur ? `${troopsText(cur.troops)} + ${troopsText(send)}` : troopsText(send)),
      row(t('off.row.garrison', { name: hs.name(enemy) }), troopsText(p.garrison)),
      row(t('off.row.ratio'), `${formatNumber(p.ratio, 1)} : 1`, p.ratio >= 1.7 ? 'is-go' : p.ratio >= 1 ? 'is-risky' : 'is-bad'),
      row(t('off.row.corridor'), `${formatNumber(Math.round(p.corridorKm))} km`),
      ...speedRows(cur, p, send, distKm),
      row(t('off.row.lossOwn'), `≈ ${troopsText(p.ownLossDay)}`),
      row(t('off.row.lossEnemy'), `≈ ${troopsText(p.enemyLossDay)}`),
      row(t('off.row.air'), t(p.air > 0 ? 'off.air.own' : p.air < 0 ? 'off.air.their' : 'off.air.none', { own: p.casOwn, their: p.casTheir }), p.air > 0 ? 'is-go' : p.air < 0 ? 'is-bad' : ''),
    );
    if (p.startsInTicks > 10) table.append(row(t('off.row.starts'), etaText(hs, p.startsInTicks, false)));
    setText(verdict, t(`off.verdict.${p.verdict}`, { name: hs.name(enemy) }));
    verdict.className = `fu-offdlg-verdict is-${p.verdict}`;
    setText(intHelp, t(`off.int.${intensity}.tip`));
    const noop = cur && !addTroops && intensity === cur.intensity;
    setText(launch.querySelector('span')!, t(cur ? 'off.go.reinforce' : 'off.go'));
    launch.disabled = (!cur && send < 1) || !!noop;
  }

  /**
   * Feedback 3 (29a): a running offensive shows the km/h the badge and the Guerra panel show (measured, the same
   * status text) and what the reinforcement / intensity change would make of it (offensiveOutlook, the same scaling the
   * unit cards and «Unirse a la ofensiva» use); a new offensive shows the plains forecast.
   */
  function speedRows(cur: AttackView | null, p: OffensivePreview, send: number, distKm: number): HTMLElement[] {
    if (!cur) {
      return [
        row(t('off.row.speed'), p.kmh > 0 ? t('off.kmh', { v: formatNumber(p.kmh, 1) }) : t('off.kmh0')),
        row(t('off.row.eta'), p.kmh > 0.2 && distKm > 0 ? etaText(hs, Math.round((distKm / p.kmh) * 10), false) : '—'),
      ];
    }
    const v = ctx.sim.view;
    const now = offensiveKmh(v, cur);
    const next = offensiveOutlook(outlookOf(cur, now), { troopsMul: (cur.troops + send) / Math.max(1, cur.troops), intensity });
    const out = [
      row(t('off.row.now'), offensiveStatus(v, cur, now, 1, false)),
      row(t('off.row.support'), t('off.support', { d: cur.divAtk ?? 0, c: cur.casAtk ?? 0, n: cur.navalAtk ?? 0 })),
    ];
    if (send > 0 || intensity !== cur.intensity) out.push(row(t('off.row.next'), next.kmh > 0.05 ? `≈ ${formatNumber(next.kmh, 1)} km/h` : t('off.kmh0'), next.kmh > now ? 'is-go' : ''));
    const k = send > 0 || intensity !== cur.intensity ? next.kmh : now;
    out.push(row(t('off.row.eta'), k > 0.2 && distKm > 0 ? etaText(hs, Math.round((distKm / k) * 10), false) : '—'));
    return out;
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
  const p0 = previewOffensive(hs, enemy, tile, Math.max(1, Math.floor((view.human?.troops ?? 0) * share)), intensity);
  ctx.bus.emit('offensivePreview', { tile, frontageTiles: p0.corridorKm / TILE_KM, ratio: p0.ratio, valid: true });
  return handle;
}

function minDistKm(f: FrontView, x: number, y: number): number {
  let d = Infinity;
  const s = f.samples;
  for (let i = 0; i < s.length >> 1; i++) d = Math.min(d, tileKm(x, y, s[i * 2] + f.dirX * 0.5, s[i * 2 + 1] + f.dirY * 0.5));
  return Number.isFinite(d) ? d : 0;
}

/** Debug / verifiers: the open dialog, if any. */
export function offensiveDialogOpen(): boolean {
  return !!current;
}
