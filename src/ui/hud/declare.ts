// FRONT ULTRA — the declaration of war (DESIGN_V2 §4.2; owner: ui, W1's minimal modal replaced by W3).
//
// A left click (or B, the radial, the nations panel or W6's Guerra panel) on a nation the human is not at war with
// opens this dialog instead of attacking. It says exactly what the declaration will do:
//   * the world will know (world news);
//   * relations: the target −60, its allies −30, the rest of the world −10 when the war has no motive;
//   * the target's allies that will receive a call to arms, by name (the same rule as the sim, before tick 18,000 too:
//     defensive calls against a human aggressor are never capped, §4.16);
//   * a pact, an alliance or a truce broken: traitor for 72 h (defense −25 %) and −15 reputation with everyone;
//   * the human's own mobilization: «tu ofensiva podrá empezar en 6 h», with the troops of the queued offensive.
// [Declarar la guerra] sends `declareWar` with the offensive queued behind the mobilization.

import { h } from '../dom';
import { flag } from '../flag';
import { icon } from '../icons';
import { openModal } from '../modal';
import { tip } from '../tooltip';
import { tx } from '../tx';
import { defendersOf } from './diplomacy';
import type { HudShared } from './shared';
import { DIFFICULTY_INDEX, HUMAN_ID, HUMAN_MOBILIZE_TICKS, TRAITOR_TICKS } from '../../shared/constants';
import { formatNumber, t } from '../../shared/i18n';

/** True when attacking `target` needs a declaration first (a nation or rebel movement not at war with us). */
export function needsDeclaration(hs: HudShared, target: number): boolean {
  if (target <= 0 || target === HUMAN_ID) return false;
  const view = hs.ctx.sim.view;
  const p = view.players[target];
  if (!p || p.kind === 'tribe') return false;
  return view.pairState(HUMAN_ID, target) !== 'war';
}

/** What a declaration on `target` would break (§5.6), as the sim's betrayalOf reads it. */
export function betrayalOf(hs: HudShared, target: number): 'alliance' | 'nap' | 'truce' | null {
  const view = hs.ctx.sim.view;
  if (view.human?.allies.includes(target)) return 'alliance';
  if (view.hasTreaty(HUMAN_ID, target, 'nap')) return 'nap';
  if (view.pairState(HUMAN_ID, target) === 'truce') return 'truce';
  return null;
}

/** The human's mobilization after a declaration (§2.4), in ticks. */
export function humanMobilizeTicks(hs: HudShared): number {
  const diff = hs.ctx.sim.view.config?.difficulty ?? 'normal';
  return HUMAN_MOBILIZE_TICKS[DIFFICULTY_INDEX[diff]];
}

/**
 * Open the declaration dialog. `tile` is the offensive's axis point (or the landing beach when `naval`); -1 declares
 * without queuing an offensive (from the nations panel), `ratio` overrides the attack slider.
 */
export function openDeclareWar(hs: HudShared, target: number, tile: number, naval: boolean, ratio = hs.attackRatio): void {
  const ctx = hs.ctx;
  const view = ctx.sim.view;
  const me = view.human;
  const T = view.players[target];
  if (!me || !T) return;
  const name = hs.name(target);
  const hours = Math.round(humanMobilizeTicks(hs) / 10);
  const troops = formatNumber(Math.round((me.troops * ratio) / 1000) * 1000);
  const pct = `${Math.round(ratio * 100)} %`;
  const betrayal = betrayalOf(hs, target);
  const defenders = defendersOf(hs, HUMAN_ID, target);
  const opinion = view.opinions.get(target)?.score ?? 0;
  const provoked = opinion <= -50;

  const line = (ico: string, el: HTMLElement, cls = '') => h('div', { class: `fu-declare-line ${cls}` }, h('span', { class: 'fu-declare-ico' }, icon(ico)), el);
  const lines: HTMLElement[] = [
    line('news', tx('war.declare.news', { name }, 'p')),
    line('users', tx(provoked ? 'war.declare.relationsHostile' : 'war.declare.relationsFull', { name, op: opinion }, 'p')),
  ];
  if (defenders.length) {
    const names = h('div', { class: 'fu-declare-allies' }, ...defenders.map((a) => h('span', { class: 'fu-declare-ally' }, flag(view.players[a]!.color, a), h('b', null, hs.name(a)))));
    lines.push(line('alliance', h('div', null, tx('war.declare.alliesJoin', { name, n: defenders.length }, 'p'), names), 'is-warn'));
  } else lines.push(line('alliance', tx('war.declare.noAllies', { name }, 'p')));
  lines.push(line('helpCall', tx(me.allies.length ? 'war.declare.yourAllies' : 'war.declare.noOwnAllies', undefined, 'p')));
  if (betrayal) lines.push(line('warning', tx(`war.declare.betray.${betrayal}`, { name, hours: Math.round(TRAITOR_TICKS / 10) }, 'p'), 'is-danger'));
  lines.push(line('clock', tx(tile < 0 ? 'war.declare.mobilizeNoAxis' : naval ? 'war.declare.mobilizeNaval' : 'war.declare.mobilize', { hours, secs: hours, troops, pct, name }, 'p'), 'is-key'));

  const cancel = h('button', { class: 'fu-btn fu-btn--ghost' }, tx('war.declare.cancel'));
  const confirm = h('button', { class: 'fu-btn fu-btn--danger' }, icon('attack'), tx(betrayal ? 'war.declare.confirmBetray' : 'war.declare.confirm'));
  tip(cancel, () => ({ title: t('war.declare.cancel'), text: t('war.declare.cancel.tip') }));
  tip(confirm, () => ({ title: t('war.declare.confirm'), text: t('war.declare.confirm.tip', { name, hours }), now: [[t('war.declare.tip.defenders'), String(defenders.length)], [t('war.declare.tip.mobilize'), t('common.hours', { n: hours })]] }));
  const m = openModal({
    titleKey: betrayal ? 'war.declare.titleBetray' : 'war.declare.title', titleParams: { name }, kickerKey: 'war.declare.kicker', narrow: true,
    body: h('div', { class: 'fu-declare' }, h('div', { class: 'fu-declare-head' }, flag(T.color, target), h('div', null, h('b', null, name), h('span', null, T.personality ? t(`personality.${T.personality}`) : ''))), ...lines),
    foot: [cancel, confirm], className: 'fu-declare-modal',
  });
  cancel.addEventListener('click', () => m.close());
  confirm.addEventListener('click', () => {
    ctx.sim.send({ type: 'declareWar', target, queuedAttack: tile >= 0 ? { tile, ratio } : undefined });
    hs.sound('alert');
    m.close();
  });
  hs.sound('open');
}
