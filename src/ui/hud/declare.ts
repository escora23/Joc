// FRONT ULTRA — minimal declaration of war (DESIGN_V2 §4.2, §14.10; owner: ui, built by W1).
// v2-stub(W1→W3): W3 replaces this confirmation with the full §4.2 dialog (goals, reasons, allies' answers).
//
// A left click (or B, or the radial / nations panel) on a nation the human is not at war with opens this modal instead
// of attacking: it says what a declaration means and when the queued offensive starts, and sends `declareWar` with the
// offensive (land toward the click, or a landing when there is no shared border).

import { DIFFICULTY_INDEX, HUMAN_ID, HUMAN_MOBILIZE_TICKS } from '../../shared/constants';
import { formatCompact, t } from '../../shared/i18n';
import { h } from '../dom';
import { icon } from '../icons';
import { openModal } from '../modal';
import { tx } from '../tx';
import type { HudShared } from './shared';

/** True when attacking `target` needs a declaration first (a nation or rebel movement at peace or in truce with us). */
export function needsDeclaration(hs: HudShared, target: number): boolean {
  if (target <= 0 || target === HUMAN_ID) return false;
  const view = hs.ctx.sim.view;
  const p = view.players[target];
  if (!p || p.kind === 'tribe') return false;
  return view.pairState(HUMAN_ID, target) !== 'war';
}

/** Open the confirmation. `tile` is the offensive's axis point (or the landing beach when `naval`). */
export function openDeclareWar(hs: HudShared, target: number, tile: number, naval: boolean): void {
  const ctx = hs.ctx;
  const view = ctx.sim.view;
  const me = view.human;
  if (!me) return;
  const name = hs.name(target);
  const diff = view.config?.difficulty ?? 'normal';
  const mob = HUMAN_MOBILIZE_TICKS[DIFFICULTY_INDEX[diff]];
  const hours = Math.round(mob / 10);
  const ratio = hs.attackRatio;
  const troops = formatCompact(me.troops * ratio);
  const pct = `${Math.round(ratio * 100)} %`;
  const state = view.pairState(HUMAN_ID, target);
  const allied = me.allies.includes(target);
  const allyNames = (view.players[target]?.allies ?? []).filter((a) => a !== HUMAN_ID).map((a) => hs.name(a)).filter(Boolean);
  const lines: HTMLElement[] = [
    tx(naval ? 'war.declare.mobilizeNaval' : 'war.declare.mobilize', { hours, secs: hours, troops, pct, name }, 'p'),
    tx('war.declare.news', { name }, 'p'),
    tx('war.declare.relations', { name }, 'p'),
    allyNames.length ? tx('war.declare.allies', { name, list: allyNames.join(', ') }, 'p') : tx('war.declare.noAllies', { name }, 'p'),
  ];
  if (allied) lines.push(tx('war.declare.betrayal', { name }, 'p'));
  else if (state === 'truce') lines.push(tx('war.declare.truce', { name }, 'p'));
  for (const l of lines) l.classList.add('fu-declare-line');
  const cancel = h('button', { class: 'fu-btn fu-btn--ghost' }, tx('war.declare.cancel'));
  const confirm = h('button', { class: 'fu-btn fu-btn--danger' }, icon('attack'), tx('war.declare.confirm'));
  const m = openModal({
    titleKey: 'war.declare.title', titleParams: { name }, kickerKey: 'war.declare.kicker', narrow: true,
    body: h('div', { class: 'fu-declare' }, ...lines), foot: [cancel, confirm], className: 'fu-declare-modal',
  });
  cancel.addEventListener('click', () => m.close());
  confirm.addEventListener('click', () => {
    ctx.sim.send({ type: 'declareWar', target, queuedAttack: tile >= 0 ? { tile, ratio } : undefined });
    ctx.bus.emit('toast', { text: t('war.declare.sent', { name, hours }), kind: 'warning', durationMs: 5000 });
    hs.sound('alert');
    m.close();
  });
}
