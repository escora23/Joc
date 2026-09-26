// FRONT ULTRA — peace terms and demands (DESIGN_V2 §4.15, §5.3; owner: ui, built by W3). Reusable from W6's Guerra panel.
//
// Peace: white peace (the war ends on the current lines), a cession (a band of the loser's land within 4 tiles of the
// front, ≤ 15 % of its land, previewed on the map before sending) or a tribute (30 % of the loser's gold now + 20 % of
// its income for 10 days), either side paying. The dialog shows both war scores and exhaustions and states the rule the
// other side answers by («winners hold out»), so the player can predict the answer.
// Demands (at peace): cede a border band (≤ 5 % of their land, previewed), a tribute (20–40 % of their gold), break an
// alliance, lift an embargo. They weigh force, personality and the size of what is asked; a refusal raises tension and
// never starts a war by itself.
// Every proposal may carry a gold sweetener, valued by the AI as a gift.

import { segmented, slider } from '../controls';
import { h, setText } from '../dom';
import { flag } from '../flag';
import { icon } from '../icons';
import { openModal, type ModalHandle } from '../modal';
import { tip } from '../tooltip';
import { tx } from '../tx';
import { propose, strengthOf, whyNotPropose } from './diplomacy';
import { bandCentre, previewBand } from './inboxText';
import type { HudShared } from './shared';
import { CESSION_MAX_SHARE, DEMAND_BAND_SHARE, DEMAND_TRIBUTE_MAX, DEMAND_TRIBUTE_MIN, HUMAN_ID, TRUCE_TICKS } from '../../shared/constants';
import { formatCompact, formatNumber, t } from '../../shared/i18n';
import type { Demand, PeaceTerms } from '../../shared/types';

const PREVIEW_KEY = 'dialog-preview';

/** A gold field for sweeteners: presets (0, 5, 10, 25 % of our gold) and the amount. */
export function goldField(hs: HudShared, onChange: (gold: number) => void): { el: HTMLElement; value(): number } {
  let gold = 0;
  const me = () => hs.human;
  const out = h('b', { class: 'fu-mono' }, '0');
  const seg = segmented<number>(
    [0, 0.05, 0.1, 0.25].map((f) => ({ value: f, label: f === 0 ? t('gold.none') : `${Math.round(f * 100)} %` })),
    0,
    (f) => {
      gold = Math.floor((me()?.gold ?? 0) * f);
      setText(out, formatCompact(gold));
      onChange(gold);
    },
    () => hs.sound('click'),
  );
  const el = h('div', { class: 'fu-goldfield' }, h('span', { class: 'fu-goldfield-k' }, icon('gold'), tx('gold.sweetener')), seg.el, out);
  tip(el, () => ({ title: t('gold.sweetener'), text: t('gold.sweetener.tip'), now: [[t('gold.offered'), formatCompact(gold)], [t('gold.yours'), formatCompact(me()?.gold ?? 0)]] }));
  return { el, value: () => gold };
}

function sideLine(hs: HudShared, id: number, score: number, ex: number): HTMLElement {
  const p = hs.ctx.sim.view.players[id]!;
  return h('div', { class: 'fu-peace-side' }, flag(p.color, id), h('b', null, id === HUMAN_ID ? t('news.you') : hs.name(id)),
    h('span', { class: `fu-mono ${score >= 0 ? 'fu-pos' : 'fu-neg'}` }, t('peace.score', { v: (score > 0 ? '+' : '') + Math.round(score) })),
    h('span', { class: 'fu-mono' }, t('peace.exhaustion', { v: Math.round(ex) })));
}

/** Peace-terms dialog with `enemy` (the human must be at war with it). */
export function openPeaceDialog(hs: HudShared, enemy: number): ModalHandle | null {
  const ctx = hs.ctx;
  const view = ctx.sim.view;
  const w = view.warBetween(HUMAN_ID, enemy);
  const E = view.players[enemy];
  const me = view.human;
  if (!w || !E || !me) {
    ctx.bus.emit('toast', { text: t('msg.notAtWar'), kind: 'warning' });
    return null;
  }
  const weA = w.aggressor === HUMAN_ID;
  const ourScore = weA ? w.scoreA : -w.scoreA, theirScore = -ourScore;
  const ourEx = weA ? w.exhaustionA : w.exhaustionB, theirEx = weA ? w.exhaustionB : w.exhaustionA;
  type Opt = 'white' | 'theyCede' | 'theyPay' | 'weCede' | 'wePay';
  let opt: Opt = 'white';
  let tiles = 0;
  let gold = 0;
  const hint = h('p', { class: 'fu-peace-hint' });
  const band = h('div', { class: 'fu-peace-band' });
  const send = h('button', { class: 'fu-btn fu-btn--primary' }, icon('peace'), tx('peace.send'));
  const cancel = h('button', { class: 'fu-btn fu-btn--ghost' }, tx('common.cancel'));
  const tilesSlider = slider({ min: 1, max: 100, step: 1, value: 60, format: (v) => `${Math.round(v)} %`, onInput: () => paint(), sound: () => hs.sound('slider') });
  const bandBox = h('div', { class: 'fu-peace-bandbox' }, tx('peace.bandSize', undefined, 'span'), tilesSlider.el, band);

  const loserOf = (o: Opt) => (o === 'theyCede' || o === 'theyPay' ? enemy : o === 'weCede' || o === 'wePay' ? HUMAN_ID : 0);
  const terms = (): PeaceTerms => {
    if (opt === 'white') return { kind: 'white' };
    if (opt === 'theyPay' || opt === 'wePay') return { kind: 'tribute', loser: loserOf(opt) };
    return { kind: 'cede', loser: loserOf(opt), tiles };
  };

  function paint(): void {
    const cede = opt === 'theyCede' || opt === 'weCede';
    bandBox.classList.toggle('fu-hidden', !cede);
    let tl: number[] = [];
    if (cede) {
      const loser = loserOf(opt), winner = loser === HUMAN_ID ? enemy : HUMAN_ID;
      const L = view.players[loser]!;
      const max = Math.max(1, Math.floor(L.tiles * CESSION_MAX_SHARE));
      tiles = Math.max(1, Math.round((max * Number(tilesSlider.input.value)) / 100));
      tl = previewBand(hs, loser, winner, tiles);
      tiles = Math.min(tiles, tl.length);
      setText(band, tiles > 0 ? t('peace.bandInfo', { tiles: formatNumber(tiles), max: formatNumber(max) }) : t('peace.noBand', { name: hs.name(enemy) }));
      ctx.globe.setTileMarks?.(PREVIEW_KEY, tl, loser === HUMAN_ID ? 0xff4a4a : 0x45f0a0, true);
      const c = bandCentre(tl);
      if (c) ctx.bus.emit('focusRequest', { lat: c.lat, lon: c.lon, altitudeKm: 2600, durationMs: 700 });
    } else ctx.globe.setTileMarks?.(PREVIEW_KEY, null);
    // The rule the enemy answers by (§4.15, §5.7 step 8), so the player can foresee the answer.
    let k = 'peace.hint.maybe';
    if (opt === 'white') k = theirScore >= 40 && theirEx < 70 ? 'peace.hint.winnersHold' : theirEx >= 35 ? 'peace.hint.tired' : 'peace.hint.notTired';
    else if (opt === 'theyCede' || opt === 'theyPay') k = theirScore <= -25 || theirEx >= 60 ? 'peace.hint.theyYield' : 'peace.hint.theyResist';
    else k = 'peace.hint.weGive';
    setText(hint, t(k, { name: hs.name(enemy), score: Math.round(theirScore), ex: Math.round(theirEx) }));
    const why = whyNotPropose(hs, enemy, 'peace', gold);
    send.toggleAttribute('disabled', !!why || (opt !== 'white' && opt !== 'theyPay' && opt !== 'wePay' && tiles <= 0));
  }
  const opts = segmented<Opt>(
    (['white', 'theyCede', 'theyPay', 'weCede', 'wePay'] as Opt[]).map((o) => ({ value: o, labelKey: `peace.opt.${o}` })),
    'white', (o) => {
      opt = o;
      paint();
    }, () => hs.sound('click'),
  );
  opts.el.classList.add('fu-peace-opts');
  const gf = goldField(hs, (g) => {
    gold = g;
    paint();
  });
  tip(send, () => ({ title: t('peace.send'), text: t('peace.send.tip', { name: hs.name(enemy), days: Math.round(TRUCE_TICKS / 240) }), whyNot: whyNotPropose(hs, enemy, 'peace', gold) }));
  tip(cancel, () => ({ title: t('common.cancel'), text: t('dialog.cancel.tip') }));
  const m = openModal({
    titleKey: 'peace.title', titleParams: { name: hs.name(enemy) }, kickerKey: 'peace.kicker', className: 'fu-peace-modal', narrow: true,
    body: h('div', { class: 'fu-peace' },
      h('div', { class: 'fu-peace-sides' }, sideLine(hs, HUMAN_ID, ourScore, ourEx), sideLine(hs, enemy, theirScore, theirEx)),
      tx('peace.explain', { days: Math.round(TRUCE_TICKS / 240) }, 'p'),
      opts.el, bandBox, hint, gf.el),
    foot: [cancel, send],
    onClose: () => ctx.globe.setTileMarks?.(PREVIEW_KEY, null),
  });
  cancel.addEventListener('click', () => m.close());
  send.addEventListener('click', () => {
    if (propose(hs, enemy, 'peace', { terms: terms(), gold })) m.close();
  });
  paint();
  return m;
}

/** Demand dialog to a nation at peace with the human (§5.3). */
export function openDemandDialog(hs: HudShared, target: number): ModalHandle | null {
  const ctx = hs.ctx;
  const view = ctx.sim.view;
  const T0 = view.players[target];
  const me = view.human;
  if (!T0 || !me) return null;
  const T = T0;
  type K = 'cede' | 'tribute' | 'breakAlliance' | 'endEmbargo';
  let kind: K = hs.borders(target) ? 'cede' : 'tribute';
  let breakWith = T.allies.find((a) => a !== HUMAN_ID) ?? 0;
  const amount = slider({ min: 0, max: 100, step: 1, value: 60, format: (v) => `${Math.round(v)} %`, onInput: () => paint(), sound: () => hs.sound('slider') });
  const info = h('p', { class: 'fu-peace-band' });
  const hint = h('p', { class: 'fu-peace-hint' });
  const allySel = h('div', { class: 'fu-demand-allies' });
  const send = h('button', { class: 'fu-btn fu-btn--amber' }, icon('demand'), tx('demand.send'));
  const cancel = h('button', { class: 'fu-btn fu-btn--ghost' }, tx('common.cancel'));
  let demand: Demand = { kind: 'tribute' };

  const whyKind = (k: K): string | null => {
    if (k === 'cede' && !hs.borders(target)) return t('msg.demandNoBorder');
    if (k === 'tribute' && !(T.gold > 0)) return t('why.demand.noGold');
    if (k === 'breakAlliance' && !T.allies.some((a) => a !== HUMAN_ID)) return t('why.demand.noAllies', { name: hs.name(target) });
    if (k === 'endEmbargo' && !T.embargoes.includes(HUMAN_ID)) return t('msg.noEmbargo');
    return null;
  };

  function paint(): void {
    const f = Number(amount.input.value) / 100;
    allySel.classList.toggle('fu-hidden', kind !== 'breakAlliance');
    amount.el.classList.toggle('fu-hidden', kind !== 'cede' && kind !== 'tribute');
    ctx.globe.setTileMarks?.(PREVIEW_KEY, null);
    if (kind === 'cede') {
      const max = Math.max(1, Math.floor(T.tiles * DEMAND_BAND_SHARE));
      const n = Math.max(1, Math.round(max * Math.max(0.05, f)));
      const tl = previewBand(hs, target, HUMAN_ID, n);
      demand = { kind: 'cede', tiles: tl.length };
      setText(info, tl.length ? t('demand.cedeInfo', { tiles: formatNumber(tl.length), max: formatNumber(max) }) : t('msg.demandNoBorder'));
      ctx.globe.setTileMarks?.(PREVIEW_KEY, tl, 0xffb53d, true);
      const c = bandCentre(tl);
      if (c) ctx.bus.emit('focusRequest', { lat: c.lat, lon: c.lon, altitudeKm: 2600, durationMs: 700 });
    } else if (kind === 'tribute') {
      const share = DEMAND_TRIBUTE_MIN + (DEMAND_TRIBUTE_MAX - DEMAND_TRIBUTE_MIN) * f;
      const gold = Math.round(T.gold * share);
      demand = { kind: 'tribute', gold };
      setText(info, t('demand.tributeInfo', { gold: formatCompact(gold), pct: Math.round(share * 100) }));
    } else if (kind === 'breakAlliance') {
      demand = { kind: 'breakAlliance', target: breakWith };
      setText(info, breakWith ? t('demand.breakInfo', { name: hs.name(breakWith) }) : '');
    } else {
      demand = { kind: 'endEmbargo' };
      setText(info, t('demand.embargoInfo'));
    }
    // Force decides (with their allies at half weight), then personality and the size of the demand.
    let theirs = strengthOf(hs, target);
    for (const a of T.allies) if (a !== HUMAN_ID) theirs += strengthOf(hs, a) * 0.5;
    const ratio = strengthOf(hs, HUMAN_ID) / Math.max(1, theirs);
    setText(hint, t(ratio >= 1.6 ? 'demand.hint.strong' : ratio >= 1 ? 'demand.hint.even' : 'demand.hint.weak', { ratio: (Math.round(ratio * 10) / 10).toString().replace('.', t('num.dec')), name: hs.name(target), pers: T.personality ? t(`personality.${T.personality}`) : '' }));
    const why = whyKind(kind) ?? whyNotPropose(hs, target, 'demand');
    send.toggleAttribute('disabled', !!why);
  }
  const kinds = segmented<K>((['cede', 'tribute', 'breakAlliance', 'endEmbargo'] as K[]).map((k) => ({ value: k, labelKey: `demand.opt.${k}` })), kind, (k) => {
    kind = k;
    paint();
  }, () => hs.sound('click'));
  kinds.el.querySelectorAll<HTMLElement>('button').forEach((b, i) => {
    const k = (['cede', 'tribute', 'breakAlliance', 'endEmbargo'] as K[])[i];
    tip(b, () => ({ title: t(`demand.opt.${k}`), text: t(`demand.opt.${k}.tip`), whyNot: whyKind(k) }));
  });
  for (const a of T.allies) {
    if (a === HUMAN_ID) continue;
    const b = h('button', { class: `fu-btn fu-btn--sm${a === breakWith ? ' is-on' : ''}` }, flag(view.players[a]?.color ?? 0, a), hs.name(a));
    b.addEventListener('click', () => {
      breakWith = a;
      allySel.querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', x === b));
      paint();
    });
    allySel.append(b);
  }
  tip(send, () => ({ title: t('demand.send'), text: t('demand.send.tip', { name: hs.name(target) }), whyNot: whyKind(kind) ?? whyNotPropose(hs, target, 'demand') }));
  tip(cancel, () => ({ title: t('common.cancel'), text: t('dialog.cancel.tip') }));
  const m = openModal({
    titleKey: 'demand.title', titleParams: { name: hs.name(target) }, kickerKey: 'demand.kicker', className: 'fu-peace-modal', narrow: true,
    body: h('div', { class: 'fu-peace' }, tx('demand.explain', undefined, 'p'), kinds.el, allySel, amount.el, info, hint),
    foot: [cancel, send],
    onClose: () => ctx.globe.setTileMarks?.(PREVIEW_KEY, null),
  });
  cancel.addEventListener('click', () => m.close());
  send.addEventListener('click', () => {
    if (propose(hs, target, 'demand', { demand })) m.close();
  });
  paint();
  return m;
}
